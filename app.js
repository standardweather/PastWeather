/* PastWeather — archived weather for a place and time, for standardweather.github.io.
 *
 * Everything loads in the browser from government sources:
 *   NOAA MRMS (noaa-mrms-pds)        radar, 24-hour hail-size, rotation and rainfall (decoded by mrms.js)
 *   NOAA SPC                         preliminary storm reports
 *   NCEI Storm Events                official record (split into per-day files in data/storm-events by tools/storm_events.py)
 *   NCEI Access Data Service         hourly surface observations (ISD / "global-hourly")
 *   NWS API                          observations for the last few days, before NCEI has them
 *   Census TIGERweb / Geocoder, USGS GNIS   place search
 *   data/history (tools/hail_history.py)    hail, wind and tornado reports since 1950 for the History view
 * A search is kept in the URL (?loc=…&date=…&time=…&through=…) so a view can be shared. The last place searched is
 * remembered (localStorage "sw-place") so the other Standard Weather pages can offer it.
 */
(function () {
  "use strict";

  const SPC_BASE = "https://www.spc.noaa.gov/climo/reports";
  const STORM_EVENTS_BASE = "data/storm-events";
  const HISTORY_BASE = "data/history";
  const MAX_RANGE_DAYS = 31;
  const PRINT_RADIUS_KM = 16;   // reports listed on the printed summary (10 miles)
  const NCEI = "https://www.ncei.noaa.gov/access/services";
  const RADIUS_KM = 250;
  const OBS_STATIONS = 3;

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isoMin = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const hhmmZ = (iso) => { const d = new Date(iso); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };

  const state = {
    query: null,          // { label, lat, lon, isoUtc, endMs (range only) }
    place: null,          // { label, lat, lon }: the last place found, for the History view
    history: null,        // { key, status, rows, index, radiusMi, radar: { dayKey: {at, peak} | "loading" | null } }
    rain: null,           // MRMS 24-hour rain ending at the close of the event day
    radarIso: null,
    view: "summary",
    reports: [], reportNote: null, selectedReport: null,
    hail: null, rotation: null,
    stations: [], obsNote: null,
    radarInfo: null, loadToken: 0,
    on: { radar: true, reports: true, hail: false, rotation: false, rain: false, stations: true },
  };

  // —— Small helpers ————————————————————————————————————————————————
  function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const miles = (km) => Math.round(km * 0.621371 * 10) / 10;

  function spcStormDayKey(isoUtc) {
    const d = new Date(isoUtc);
    const adj = new Date(d);
    if (d.getUTCHours() < 12) adj.setUTCDate(adj.getUTCDate() - 1);
    return String(adj.getUTCFullYear()).slice(-2) + pad(adj.getUTCMonth() + 1) + pad(adj.getUTCDate());
  }
  /** Start (12 UTC) of the SPC convective day containing isoUtc. */
  function spcDayStart(isoUtc) {
    const k = spcStormDayKey(isoUtc);
    return Date.UTC(2000 + Number(k.slice(0, 2)), Number(k.slice(2, 4)) - 1, Number(k.slice(4, 6)), 12);
  }

  function formatDisplayUtc(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";
  }
  function formatDay(isoDay) {
    return new Date(isoDay + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  }

  function parseLatLon(text) {
    const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = Number(m[1]), lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  function toIsoUtc(date, time) {
    const dm = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) || date.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
    const tm = time.trim().match(/^(\d{1,2}):(\d{2})$/) || time.trim().match(/^(\d{2})(\d{2})$/);
    if (!dm || !tm) return null;
    const [y, mo, d, h, mi] = [dm[1], dm[2], dm[3], tm[1], tm[2]].map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00Z`;
  }
  const shiftIso = (isoUtc, minutes) => isoMin(new Date(isoUtc).getTime() + minutes * 60_000);
  /** End of the period shown: 12 UTC after the last SPC day (one day unless a through date is set). */
  const rangeEnd = (q) => q.endMs || spcDayStart(q.isoUtc) + 86_400_000;
  const rangeDays = (q) => { const out = []; for (let t = spcDayStart(q.isoUtc); t < rangeEnd(q); t += 86_400_000) out.push(t); return out; };
  const isRange = (q) => rangeDays(q).length > 1;

  // —— Place search (Census TIGERweb, USGS GNIS, Census Geocoder) ———————————————
  const STATES = [
    ["AL", "01", "Alabama"], ["AK", "02", "Alaska"], ["AZ", "04", "Arizona"], ["AR", "05", "Arkansas"],
    ["CA", "06", "California"], ["CO", "08", "Colorado"], ["CT", "09", "Connecticut"], ["DE", "10", "Delaware"],
    ["DC", "11", "District of Columbia"], ["FL", "12", "Florida"], ["GA", "13", "Georgia"], ["HI", "15", "Hawaii"],
    ["ID", "16", "Idaho"], ["IL", "17", "Illinois"], ["IN", "18", "Indiana"], ["IA", "19", "Iowa"],
    ["KS", "20", "Kansas"], ["KY", "21", "Kentucky"], ["LA", "22", "Louisiana"], ["ME", "23", "Maine"],
    ["MD", "24", "Maryland"], ["MA", "25", "Massachusetts"], ["MI", "26", "Michigan"], ["MN", "27", "Minnesota"],
    ["MS", "28", "Mississippi"], ["MO", "29", "Missouri"], ["MT", "30", "Montana"], ["NE", "31", "Nebraska"],
    ["NV", "32", "Nevada"], ["NH", "33", "New Hampshire"], ["NJ", "34", "New Jersey"], ["NM", "35", "New Mexico"],
    ["NY", "36", "New York"], ["NC", "37", "North Carolina"], ["ND", "38", "North Dakota"], ["OH", "39", "Ohio"],
    ["OK", "40", "Oklahoma"], ["OR", "41", "Oregon"], ["PA", "42", "Pennsylvania"], ["RI", "44", "Rhode Island"],
    ["SC", "45", "South Carolina"], ["SD", "46", "South Dakota"], ["TN", "47", "Tennessee"], ["TX", "48", "Texas"],
    ["UT", "49", "Utah"], ["VT", "50", "Vermont"], ["VA", "51", "Virginia"], ["WA", "53", "Washington"],
    ["WV", "54", "West Virginia"], ["WI", "55", "Wisconsin"], ["WY", "56", "Wyoming"], ["PR", "72", "Puerto Rico"],
  ];
  function findState(s) {
    const t = s.trim().replace(/\./g, "").toLowerCase();
    return STATES.find(([code, , name]) => code.toLowerCase() === t || name.toLowerCase() === t) || null;
  }
  function splitPlace(text) {
    const comma = text.lastIndexOf(",");
    if (comma > 0) {
      const st = findState(text.slice(comma + 1));
      if (st) return { name: text.slice(0, comma).trim(), state: st };
    }
    for (const words of [2, 1]) {
      const parts = text.trim().split(/\s+/);
      if (parts.length <= words) continue;
      const st = findState(parts.slice(-words).join(" "));
      if (st) return { name: parts.slice(0, -words).join(" "), state: st };
    }
    return { name: text.trim(), state: null };
  }
  const sqlString = (s) => "'" + s.toUpperCase().replace(/'/g, "''") + "'";

  async function arcgisQuery(url, params) {
    const u = new URL(url);
    for (const [k, v] of Object.entries({ f: "json", ...params })) u.searchParams.set(k, v);
    const res = await fetch(u.toString());
    if (!res.ok) throw new Error(`Place search failed (${res.status})`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "Place search failed");
    return json.features || [];
  }
  async function searchTigerPlaces(name, st) {
    const base = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer";
    const where = `UPPER(BASENAME)=${sqlString(name)}` + (st ? ` AND STATE='${st[1]}'` : "");
    const params = { where, outFields: "BASENAME,STATE,INTPTLAT,INTPTLON,AREALAND", returnGeometry: "false" };
    const results = await Promise.all([4, 5].map((layer) => arcgisQuery(`${base}/${layer}/query`, params).catch(() => [])));
    const hits = results.flat().map((f) => f.attributes);
    if (!hits.length) return null;
    hits.sort((a, b) => (b.AREALAND || 0) - (a.AREALAND || 0));   // without a state, the largest place is the likeliest
    const h = hits[0];
    const s = STATES.find(([, fips]) => fips === h.STATE);
    return { label: `${h.BASENAME}${s ? ", " + s[0] : ""}`, lat: Number(h.INTPTLAT), lon: Number(h.INTPTLON) };
  }
  async function searchGnis(name, st) {
    const where = `UPPER(gaz_name)=${sqlString(name)}` + (st ? ` AND state_alpha='${st[0]}'` : "");
    const features = await arcgisQuery("https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/3/query", {
      where, outFields: "gaz_name,state_alpha", returnGeometry: "true", outSR: "4326",
    });
    const f = features.find((x) => x.geometry && x.geometry.points && x.geometry.points.length);
    if (!f) return null;
    const [lon, lat] = f.geometry.points[0];
    return { label: `${f.attributes.gaz_name}, ${f.attributes.state_alpha}`, lat, lon };
  }
  /** The Census Geocoder sends no CORS headers, so it is called with JSONP. Street addresses only. */
  function searchCensusAddress(text) {
    return new Promise((resolve, reject) => {
      const cb = "pwCensus" + Math.random().toString(36).slice(2);
      const u = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
      u.searchParams.set("address", text);
      u.searchParams.set("benchmark", "Public_AR_Current");
      u.searchParams.set("format", "jsonp");
      u.searchParams.set("callback", cb);
      const script = document.createElement("script");
      const timer = setTimeout(() => done(new Error("Address search timed out")), 12000);
      function done(err, value) { clearTimeout(timer); delete window[cb]; script.remove(); err ? reject(err) : resolve(value); }
      window[cb] = (data) => {
        const m = data?.result?.addressMatches?.[0];
        done(null, m ? { label: m.matchedAddress, lat: m.coordinates.y, lon: m.coordinates.x } : null);
      };
      script.onerror = () => done(new Error("Address search failed"));
      script.src = u.toString();
      document.head.appendChild(script);
    });
  }
  async function geocodePlace(q) {
    const text = q.trim();
    if (!text) throw new Error("Enter a location or lat, lon");
    const direct = parseLatLon(text);
    if (direct) return { label: `${direct.lat.toFixed(4)}, ${direct.lon.toFixed(4)}`, ...direct };
    let hit = null;
    if (/^\d/.test(text)) hit = await searchCensusAddress(text).catch(() => null);
    else {
      const { name, state: st } = splitPlace(text);
      hit = (await searchTigerPlaces(name, st).catch(() => null)) || (await searchGnis(name, st).catch(() => null)) ||
        (await searchCensusAddress(text).catch(() => null));
    }
    if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) throw new Error("Place not found. Try “City, ST”, a street address, or lat, lon.");
    return hit;
  }

  // —— Storm reports (SPC preliminary + NCEI Storm Events) ————————————————————
  function parseCsvLine(line) {
    const out = [];
    let cur = "", inQ = false;
    for (const c of line) {
      if (c === '"') { inQ = !inQ; continue; }
      if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }
  function hhmmToIso(dayKey, hhmm) {
    const yy = Number(dayKey.slice(0, 2));
    const d = new Date(Date.UTC(yy >= 70 ? 1900 + yy : 2000 + yy, Number(dayKey.slice(2, 4)) - 1, Number(dayKey.slice(4, 6)), Number(hhmm.slice(0, 2)), Number(hhmm.slice(2, 4))));
    if (Number(hhmm.slice(0, 2)) < 12) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
  function spcMagnitude(section, mag) {
    if (!mag || mag === "UNK") return null;
    if (section === "tornado") return /^\d$/.test(mag) ? `EF${mag}` : mag;
    if (section === "hail") return Number.isFinite(Number(mag)) ? `${Number(mag) / 100}"` : mag;
    return Number.isFinite(Number(mag)) ? `${mag} mph` : mag;
  }
  async function fetchSpcReportsNear(isoUtc, lat, lon, radiusKm) {
    const dayKey = spcStormDayKey(isoUtc);
    const res = await fetch(`${SPC_BASE}/${dayKey}_rpts_filtered.csv`);
    if (!res.ok) throw new Error(`SPC reports unavailable (${res.status})`);
    let section = null, idx = 0;
    const reports = [];
    for (const line of (await res.text()).split(/\r?\n/).filter(Boolean)) {
      const upper = line.toUpperCase();
      if (upper.startsWith("TIME,")) { section = upper.includes("F_SCALE") ? "tornado" : upper.includes("SIZE") ? "hail" : upper.includes("SPEED") ? "wind" : null; continue; }
      if (!section) continue;
      const cols = parseCsvLine(line);
      if (cols.length < 7) continue;
      const [time, mag, location, county, st, rlat, rlon, ...rest] = cols;
      const plat = Number(rlat), plon = Number(rlon);
      if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
      const d = distanceKm(lat, lon, plat, plon);
      if (d > radiusKm) continue;
      reports.push({
        id: `spc-${section}-${dayKey}-${idx++}`, type: section,
        label: section === "wind" ? "Thunderstorm wind" : section === "hail" ? "Hail" : "Tornado", source: "SPC preliminary",
        timeUtc: /^\d{4}$/.test(time || "") ? hhmmToIso(dayKey, time) : time || "",
        lat: plat, lon: plon, location: location || "", county: county || "", state: st || "",
        magnitude: spcMagnitude(section, mag), comments: rest.join(",").trim(), distanceKm: d,
      });
    }
    return reports;
  }
  function nceiCategory(type) {
    const t = type.toUpperCase();
    if (t.includes("TORNADO") || t.includes("FUNNEL") || t.includes("WATERSPOUT")) return "tornado";
    if (t.includes("HAIL")) return "hail";
    if (t.includes("WIND")) return "wind";
    if (t.includes("FLOOD") || t.includes("RAIN")) return "flood";
    return "other";
  }
  function nceiMagnitude(e, type) {
    if (type === "tornado") return e.torScale && e.torScale !== "EFU" ? e.torScale : null;
    if (e.magnitude == null) return null;
    if (type === "hail") return `${e.magnitude}"`;
    if (type === "wind") return `${Math.round(e.magnitude)} kt${e.magnitudeType?.startsWith("M") ? " measured" : ""}`;
    return null;
  }
  function nceiDetails(e) {
    const facts = [];
    if (e.torLengthMi) facts.push(`path ${e.torLengthMi} mi`);
    if (e.torWidthYd) facts.push(`${e.torWidthYd} yd wide`);
    if (e.deaths) facts.push(`${e.deaths} death${e.deaths === 1 ? "" : "s"}`);
    if (e.injuries) facts.push(`${e.injuries} injur${e.injuries === 1 ? "y" : "ies"}`);
    if (e.damageProperty && e.damageProperty !== "0.00K") facts.push(`property damage $${e.damageProperty}`);
    return [facts.join(" · "), e.narrative || ""].filter(Boolean).join(" — ");
  }
  async function getJson(url) {
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return res.json();
  }
  async function fetchNceiReportsNear(isoUtc, lat, lon, radiusKm) {
    const start = spcDayStart(isoUtc);
    const end = start + 86_400_000;
    const index = await getJson(`${STORM_EVENTS_BASE}/index.json`).catch(() => null);
    const files = await Promise.all([-1, 0, 1].map((k) => {
      const d = new Date(start + k * 86_400_000);
      const key = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
      return getJson(`${STORM_EVENTS_BASE}/${key.slice(0, 4)}/${key}.json`).catch(() => null);
    }));
    const reports = [];
    for (const file of files) {
      for (const e of file?.events || []) {
        const begin = Date.parse(e.begin.replace("Z", ":00Z"));
        const finish = e.end ? Date.parse(e.end.replace("Z", ":00Z")) : begin;
        if (finish < start || begin >= end) continue;
        let d = distanceKm(lat, lon, e.lat, e.lon);
        if (e.endLat != null && e.endLon != null) d = Math.min(d, distanceKm(lat, lon, e.endLat, e.endLon));
        if (d > radiusKm) continue;
        const type = nceiCategory(e.type);
        reports.push({
          id: `ncei-${e.id}`, type, label: e.type, source: "NCEI official" + (e.source ? ` · ${e.source}` : ""),
          timeUtc: new Date(begin).toISOString(), lat: e.lat, lon: e.lon, endLat: e.endLat, endLon: e.endLon,
          location: e.location || e.county || "", county: e.county || "", state: e.state || "",
          magnitude: nceiMagnitude(e, type), comments: nceiDetails(e), distanceKm: d,
        });
      }
    }
    const lastDay = index?.lastDay ? Date.parse(index.lastDay + "T00:00:00Z") + 86_400_000 : null;
    return { reports, pending: lastDay == null || end > lastDay, lastDay: index?.lastDay || null };
  }

  // —— Station observations (NCEI global-hourly, NWS API for recent days) ——————————
  const ms2mph = (v) => v * 2.23694;
  const c2f = (c) => c * 9 / 5 + 32;

  /** One ISD record ("global-hourly" JSON) to plain units. Missing values come through as null. */
  function parseIsd(r) {
    const num = (s, missing) => { const n = Number(s); return s == null || s === "" || Math.abs(n) >= missing ? null : n; };
    const wnd = (r.WND || "").split(",");
    const gust = (r.OC1 || "").split(",");
    const tmp = (r.TMP || "").split(","), dew = (r.DEW || "").split(","), slp = (r.SLP || "").split(","), vis = (r.VIS || "").split(",");
    const aa1 = (r.AA1 || "").split(",");
    const dir = num(wnd[0], 999), spd = num(wnd[3], 9999), g = num(gust[0], 9999);
    const t = num(tmp[0], 9999), dp = num(dew[0], 9999);
    const precipMm = aa1[0] === "01" ? num(aa1[1], 9999) : null;
    return {
      t: Date.parse(r.DATE + "Z"),
      type: r.REPORT_TYPE,
      wdir: dir, wspd: spd == null ? null : ms2mph(spd / 10), gust: g == null ? null : ms2mph(g / 10),
      temp: t == null ? null : c2f(t / 10), dew: dp == null ? null : c2f(dp / 10),
      slp: num(slp[0], 99999) == null ? null : Number(slp[0]) / 10,
      vis: num(vis[0], 999999) == null ? null : Number(vis[0]) / 1609.34,
      precip1h: precipMm == null ? null : precipMm / 10 / 25.4,
      wx: r.MW1 ? r.MW1.split(",")[0] : "",
    };
  }

  async function nceiStations(lat, lon, startIso, endIso) {
    const d = 0.6;
    const u = `${NCEI}/search/v1/data?dataset=global-hourly&startDate=${startIso}&endDate=${endIso}&bbox=${(lat + d).toFixed(3)},${(lon - d).toFixed(3)},${(lat - d).toFixed(3)},${(lon + d).toFixed(3)}&limit=50`;
    const res = await fetch(u);
    if (!res.ok) return [];
    const json = await res.json();
    const out = [];
    for (const r of json.results || []) {
      const s = (r.stations || [])[0];
      const coords = r.location?.coordinates || r.boundingPoints?.[0]?.point || null;
      if (!s?.id || out.some((o) => o.id === s.id)) continue;   // a station appears once per archive file
      let slat = null, slon = null;
      if (Array.isArray(coords)) [slon, slat] = coords;
      out.push({ id: s.id, name: s.name, lat: slat, lon: slon });
    }
    return out;
  }

  async function nceiObservations(ids, startIso, endIso) {
    const u = `${NCEI}/data/v1?dataset=global-hourly&stations=${ids.join(",")}&startDate=${startIso}&endDate=${endIso}&format=json&includeStationName=true&includeStationLocation=1`;
    const res = await fetch(u);
    if (!res.ok) return [];
    return res.json();
  }

  async function nwsObservations(lat, lon, startIso, endIso) {
    const pt = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    const list = pt?.properties?.observationStations ? await getJson(pt.properties.observationStations) : null;
    const stations = (list?.features || []).slice(0, OBS_STATIONS);
    return Promise.all(stations.map(async (f) => {
      const [slon, slat] = f.geometry.coordinates;
      const id = f.properties.stationIdentifier;
      const obs = await getJson(`https://api.weather.gov/stations/${id}/observations?start=${startIso}&end=${endIso}`).catch(() => null);
      const v = (q) => (q && q.value != null ? q.value : null);
      return {
        id, name: f.properties.name, lat: slat, lon: slon, source: "NWS",
        obs: (obs?.features || []).map((o) => {
          const p = o.properties;
          return {
            t: Date.parse(p.timestamp), type: "NWS",
            wdir: v(p.windDirection), wspd: v(p.windSpeed) == null ? null : v(p.windSpeed) / 1.60934, gust: v(p.windGust) == null ? null : v(p.windGust) / 1.60934,
            temp: v(p.temperature) == null ? null : c2f(v(p.temperature)), dew: v(p.dewpoint) == null ? null : c2f(v(p.dewpoint)),
            slp: v(p.seaLevelPressure) == null ? null : v(p.seaLevelPressure) / 100, vis: v(p.visibility) == null ? null : v(p.visibility) / 1609.34,
            precip1h: v(p.precipitationLastHour) == null ? null : v(p.precipitationLastHour) / 25.4, wx: p.textDescription || "",
          };
        }).sort((a, b) => a.t - b.t),
      };
    }));
  }

  /** The nearest few stations with hourly data across the convective day around the event. */
  async function loadObservations(q) {
    const start = spcDayStart(q.isoUtc);
    const end = rangeEnd(q);
    const startIso = isoMin(start).replace("Z", "");
    const endIso = isoMin(end).replace("Z", "");
    let stations = [];
    let note = null;
    try {
      const found = await nceiStations(q.lat, q.lon, startIso, endIso);
      found.forEach((s) => { s.km = s.lat != null ? distanceKm(q.lat, q.lon, s.lat, s.lon) : 999; });
      found.sort((a, b) => a.km - b.km);
      const pick = found.slice(0, OBS_STATIONS * 2);
      if (pick.length) {
        const rows = await nceiObservations(pick.map((s) => s.id), startIso, endIso);
        const by = {};
        for (const r of rows) (by[r.STATION] ||= []).push(r);
        stations = pick.filter((s) => by[s.id]?.length).slice(0, OBS_STATIONS).map((s) => {
          const recs = by[s.id];
          const lat = s.lat ?? Number(recs[0].LATITUDE), lon = s.lon ?? Number(recs[0].LONGITUDE);
          return { id: s.id, name: (s.name || recs[0].NAME || s.id).replace(/,\s*[A-Z]{2}\s+US$/, ""), lat, lon, source: "NCEI", obs: recs.map(parseIsd).sort((a, b) => a.t - b.t) };
        });
      }
    } catch { /* fall through to the NWS */ }
    if (!stations.length && Date.now() - start < 7 * 86_400_000) {
      stations = (await nwsObservations(q.lat, q.lon, isoMin(start), isoMin(Math.min(end, Date.now()))).catch(() => [])).filter((s) => s.obs.length);
      note = stations.length ? "NCEI hasn't published these days yet; showing preliminary NWS observations." : null;
    }
    stations.forEach((s) => {
      s.km = distanceKm(q.lat, q.lon, s.lat, s.lon);
      const gusts = s.obs.filter((o) => o.gust != null || o.wspd != null);
      s.peak = gusts.reduce((m, o) => { const g = Math.max(o.gust ?? 0, o.wspd ?? 0); return !m || g > m.g ? { g, t: o.t } : m; }, null);
      const hourly = s.obs.filter((o) => o.precip1h != null && (o.type === "FM-15" || o.type === "NWS"));
      s.precip = hourly.length ? hourly.reduce((sum, o) => sum + o.precip1h, 0) : null;
    });
    return { stations, note: note || (stations.length ? null : "No hourly station observations found within about 40 miles.") };
  }

  // —— Map —————————————————————————————————————————————————————————
  const map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 13 }).setView([38.5, -96], 4);
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix("");
  [["radar", 300], ["swath", 340], ["points", 620], ["labels", 640]].forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
  map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Esri" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels", opacity: 0.85 }).addTo(map);
  map.attributionControl.addAttribution("NOAA MRMS · SPC · NCEI · NWS");
  // Legend for whichever color layers are on, in the map's lower right.
  const Legend = L.Control.extend({ options: { position: "bottomright" }, onAdd() { const d = L.DomUtil.create("div", "maplegend"); d.id = "legend"; return d; } });
  new Legend().addTo(map);

  const layers = { radar: L.layerGroup(), hail: L.layerGroup(), rotation: L.layerGroup(), rain: L.layerGroup(), reports: L.layerGroup(), stations: L.layerGroup(), poi: L.layerGroup().addTo(map) };
  Object.entries(state.on).forEach(([k, v]) => { if (v) layers[k].addTo(map); });
  const reportMarkers = {};

  const REPORT_COLOR = { tornado: "#ff453a", hail: "#30d158", wind: "#0a84ff", flood: "#40c8e0", other: "#8e8e93" };

  function setStatus(msg) { $("status").textContent = msg || ""; $("status").hidden = !msg; }

  function overlay(group, frame, pane) {
    group.clearLayers();
    if (frame) L.imageOverlay(frame.url, frame.bounds, { pane, opacity: frame.opacity, interactive: false }).addTo(group);
  }

  function drawReports() {
    layers.reports.clearLayers();
    for (const r of state.reports) {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      if (r.endLat != null && r.type === "tornado") {
        L.polyline([[r.lat, r.lon], [r.endLat, r.endLon]], { pane: "points", color: REPORT_COLOR.tornado, weight: 3, opacity: 0.8 }).addTo(layers.reports);
      }
      const m = L.circleMarker([r.lat, r.lon], { pane: "points", radius: r.source.startsWith("NCEI") ? 6 : 5, color: r.source.startsWith("NCEI") ? "#fff" : "#060818", weight: 1.5, fillColor: REPORT_COLOR[r.type], fillOpacity: 0.92 })
        .bindPopup(reportPopup(r)).addTo(layers.reports);
      m.on("click", () => { state.selectedReport = r.id; if (state.view === "reports") render(); });
      reportMarkers[r.id] = m;
    }
  }
  function reportPopup(r) {
    return `<h4><span class="dot" style="background:${REPORT_COLOR[r.type]}"></span>${esc(r.label)}${r.magnitude ? ` · ${esc(r.magnitude)}` : ""}</h4>
      <p>${esc(r.location)}${r.state ? `, ${esc(r.state)}` : ""} · ${miles(r.distanceKm)} mi away</p>
      <p>${esc(formatDisplayUtc(r.timeUtc))} · ${esc(r.source)}</p>${r.comments ? `<p>${esc(r.comments.slice(0, 600))}${r.comments.length > 600 ? "…" : ""}</p>` : ""}`;
  }

  function drawStations() {
    layers.stations.clearLayers();
    for (const s of state.stations) {
      L.marker([s.lat, s.lon], {
        pane: "points",
        icon: L.divIcon({ className: "", iconSize: [14, 14], iconAnchor: [7, 7], html: `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="#ffd84a" stroke="#060818" stroke-width="1.5"/></svg>` }),
      }).bindTooltip(`${esc(s.name)}${s.peak ? ` · peak ${Math.round(s.peak.g)} mph` : ""}`, { className: "tw-tip", direction: "top", offset: [0, -6] })
        .on("click", () => setView("obs")).addTo(layers.stations);
    }
  }

  function drawPoi() {
    layers.poi.clearLayers();
    if (!state.query) return;
    L.circleMarker([state.query.lat, state.query.lon], { pane: "points", radius: 7, color: "#fff", weight: 2.5, fillColor: "#4ad1ff", fillOpacity: 1 })
      .bindTooltip(esc(state.query.label), { className: "tw-tip", direction: "top", offset: [0, -8] }).addTo(layers.poi);
  }

  function drawLegend() {
    const parts = [];
    if (state.on.radar) parts.push(`<h5 class="sub">Reflectivity (dBZ)</h5><div class="ramp" style="background:linear-gradient(90deg,#8787e3,#3263c6,#00c600,#008600,#ffc600,#ff8600,#d40000,#c600c6)"></div><div class="ticks"><span>15</span><span>30</span><span>45</span><span>60</span><span>70</span></div>`);
    if (state.on.hail) parts.push(`<h5 class="sub">Maximum hail size, 24 h (inches)</h5><div class="key">${MRMS.legends.hail.map(([inch, c]) => `<span><i style="background:rgb(${c})"></i>${inch.toFixed(2).replace(/0$/, "")}+</span>`).join("")}</div>`);
    if (state.on.rain) parts.push(`<h5 class="sub">Rain, 24 h (inches, radar + gauges)</h5><div class="key">${MRMS.legends.rain.map(([inch, c]) => `<span><i style="background:rgb(${c})"></i>${+inch.toFixed(2)}+</span>`).join("")}</div>`);
    if (state.on.rotation) parts.push(`<h5 class="sub">Rotation, 24 h (×10⁻³ s⁻¹)</h5><div class="key">${MRMS.legends.rotation.map(([s, c]) => `<span><i style="background:rgb(${c})"></i>${s}+</span>`).join("")}</div>`);
    $("legend").innerHTML = parts.join("");
  }

  // —— Sidebar views ————————————————————————————————————————————————————
  const HINT = $("panel").innerHTML;   // the intro text in index.html, shown until a search runs
  const hailIn =(mm) => (mm == null || mm <= 0 ? null : mm / 25.4);

  function summaryView() {
    const q = state.query;
    if (!q) return HINT;
    const r = state.reports;
    const count = (t) => r.filter((x) => x.type === t).length;
    const nearest = (t) => r.filter((x) => x.type === t).sort((a, b) => a.distanceKm - b.distanceKm)[0];
    const h = state.hail, rot = state.rotation;
    const s0 = state.stations[0];
    const stat = (label, value, small) => `<div class="stat"><span>${label}${small ? `<small>${small}</small>` : ""}</span><b>${value}</b></div>`;
    const range = isRange(q);
    let html = `<div class="pad"><h5 class="sub">${esc(q.label)} · ${esc(formatDisplayUtc(q.isoUtc))}</h5>`;
    if (range) html += stat("Period", `${rangeDays(q).length} days`, `${esc(formatDisplayUtc(isoMin(spcDayStart(q.isoUtc))))} to ${esc(formatDisplayUtc(isoMin(rangeEnd(q))))}`);
    html += stat("Radar", state.radarInfo ? hhmmZ(state.radarInfo.timeIso) : "—", state.radarInfo ? `${state.radarInfo.at != null && state.radarInfo.at > 0 ? `${Math.round(state.radarInfo.at)} dBZ at the location` : "No echo at the location"}` : "No frame for this time");
    if (h) {
      const at = hailIn(h.at), pk = hailIn(h.peak);
      html += stat("Hail, 24 h", at ? `${at.toFixed(2)}"` : "None", `${at ? "Estimated maximum at the location" : "No hail estimated at the location"}${pk ? ` · ${pk.toFixed(2)}" within 6 mi` : ""} · 24 h to ${esc(formatDisplayUtc(h.timeIso))}`);
    }
    if (rot) {
      const pk = rot.peak && rot.peak >= 8 ? rot.peak : null;
      const at = rot.at && rot.at >= 8 ? rot.at : null;
      html += stat("Rotation, 24 h", pk ? `${Math.round(pk)}` : "None", pk ? `Peak within 6 mi${at ? ` · ${Math.round(at)} at the location` : ""} (×10⁻³ s⁻¹; 10+ is strong, 15+ often tornadic)` : "No notable rotation within 6 mi");
    }
    if (state.rain) {
      const rr = state.rain;
      html += stat(range ? "Rain, period" : "Rain, 24 h", rr.total != null ? `${(rr.total / 25.4).toFixed(2)}"` : "—",
        rr.total != null ? `Radar and gauges at the location (MRMS)${rr.missing ? ` · ${rr.missing} day${rr.missing === 1 ? "" : "s"} unavailable` : ""}` : rr.loading ? "Loading…" : "No rainfall analysis for this period");
    }
    html += stat("Storm reports", `${r.length}`, `within ${Math.round(RADIUS_KM * 0.621371)} mi · ${count("tornado")} tornado · ${count("hail")} hail · ${count("wind")} wind`);
    const nh = nearest("hail"), nw = nearest("wind"), nt = nearest("tornado");
    if (nh) html += stat("Nearest hail report", `${miles(nh.distanceKm)} mi`, `${esc(nh.magnitude || "")} · ${esc(nh.location)} · ${hhmmZ(nh.timeUtc)}`);
    if (nw) html += stat("Nearest wind report", `${miles(nw.distanceKm)} mi`, `${esc(nw.magnitude || "")} · ${esc(nw.location)} · ${hhmmZ(nw.timeUtc)}`);
    if (nt) html += stat("Nearest tornado report", `${miles(nt.distanceKm)} mi`, `${esc(nt.magnitude || "")} · ${esc(nt.location)} · ${hhmmZ(nt.timeUtc)}`);
    if (s0) html += stat(`Peak wind, ${esc(s0.name)}`, s0.peak ? `${Math.round(s0.peak.g)} mph` : "—", `${miles(s0.km)} mi away${s0.peak ? ` · ${range ? esc(formatDisplayUtc(isoMin(s0.peak.t))) : hhmmZ(isoMin(s0.peak.t))}` : ""}${s0.precip != null ? ` · ${s0.precip.toFixed(2)}" rain over the ${range ? "period" : "day"}` : ""}`);
    html += range ? `<p class="note">Reports, observations and rain cover every SPC convective day (1200 to 1200 UTC) in the period. Radar, hail and rotation show the event day.</p>`
      : `<p class="note">Day shown: ${esc(formatDisplayUtc(isoMin(spcDayStart(q.isoUtc))))} to 1200 UTC the next day (the SPC convective day).</p>`;
    if (state.reportNote) html += `<p class="note">${esc(state.reportNote)}</p>`;
    html += `<div class="actions">
      <a class="cta" href="${esc(requestUrl())}">Request a certified report</a>
      <button type="button" data-action="print">Print summary</button>
      <a href="/NowWeather/?loc=${q.lat.toFixed(4)},${q.lon.toFixed(4)}">Weather here now</a>
      <a href="/FutureWeather/?loc=${q.lat.toFixed(3)},${q.lon.toFixed(3)}">Forecast here</a>
    </div>`;
    return html + `</div>`;
  }

  /** The home page contact form, filled in with this event. */
  function requestUrl() {
    const q = state.query;
    const p = new URLSearchParams({ request: "report", place: q.label, lat: q.lat.toFixed(4), lon: q.lon.toFixed(4), when: formatDisplayUtc(q.isoUtc), link: location.href });
    if (isRange(q)) p.set("through", formatDisplayUtc(isoMin(rangeEnd(q))));
    return `/?${p}#contact`;
  }

  function reportsView() {
    if (!state.query) return summaryView();
    const list = state.reports.slice().sort((a, b) => a.distanceKm - b.distanceKm);
    if (!list.length) return `<p class="empty">No storm reports within ${Math.round(RADIUS_KM * 0.621371)} miles.</p>${state.reportNote ? `<p class="empty">${esc(state.reportNote)}</p>` : ""}`;
    return `<div class="pad actions" style="margin:0;padding-bottom:.6rem"><button type="button" data-action="csv-reports">Download CSV</button></div>` + list.map((r) => `<div class="report${state.selectedReport === r.id ? " sel" : ""}" data-report="${esc(r.id)}">
        <div class="t"><span style="color:#fff;font:600 .88rem var(--brand)"><i class="dot" style="background:${REPORT_COLOR[r.type]}"></i>${esc(r.label)}${r.magnitude ? ` · ${esc(r.magnitude)}` : ""}</span><span>${miles(r.distanceKm)} mi</span></div>
        <div class="m">${esc(r.location)}${r.state ? `, ${esc(r.state)}` : ""} · ${esc(formatDisplayUtc(r.timeUtc))} · ${esc(r.source)}</div>
        ${r.comments && state.selectedReport === r.id ? `<div class="c">${esc(r.comments)}</div>` : ""}</div>`).join("") +
      (state.reportNote ? `<p class="empty">${esc(state.reportNote)}</p>` : "");
  }

  function windChart(s, eventT) {
    const pts = s.obs.filter((o) => o.wspd != null || o.gust != null);
    if (pts.length < 2) return "";
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const max = Math.max(20, ...pts.map((o) => Math.max(o.gust ?? 0, o.wspd ?? 0)));
    const hi = Math.ceil(max / 10) * 10;
    const W = 336, H = 120, L0 = 26, B0 = 18, T0 = 6, R0 = 4;
    const x = (t) => L0 + ((t - t0) / Math.max(1, t1 - t0)) * (W - L0 - R0);
    const y = (v) => T0 + (1 - v / hi) * (H - T0 - B0);
    const mono = 'font-family="IBM Plex Mono, monospace" font-size="9.5" fill="rgba(255,255,255,.42)"';
    let svg = "";
    for (let v = 0; v <= hi; v += hi > 60 ? 20 : 10) svg += `<line x1="${L0}" x2="${W - R0}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,.07)"/><text x="${L0 - 5}" y="${y(v) + 3}" text-anchor="end" ${mono}>${v}</text>`;
    const days = (t1 - t0) / 86_400_000;
    const tick = days > 2 ? Math.ceil(days / 7) * 86_400_000 : 21600e3;
    for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
      const d = new Date(t);
      svg += `<text x="${x(t)}" y="${H - 4}" text-anchor="middle" ${mono}>${days > 2 ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : `${pad(d.getUTCHours())}Z`}</text>`;
    }
    if (eventT >= t0 && eventT <= t1) svg += `<line x1="${x(eventT)}" x2="${x(eventT)}" y1="${T0}" y2="${H - B0}" stroke="#4ad1ff" stroke-dasharray="3 3"/>`;
    const line = (key, color, w) => { const p = pts.filter((o) => o[key] != null); return p.length > 1 ? `<polyline fill="none" stroke="${color}" stroke-width="${w}" points="${p.map((o) => `${x(o.t).toFixed(1)},${y(o[key]).toFixed(1)}`).join(" ")}"/>` : ""; };
    svg += line("wspd", "rgba(255,255,255,.55)", 1.3);
    pts.filter((o) => o.gust != null).forEach((o) => { svg += `<circle cx="${x(o.t).toFixed(1)}" cy="${y(o.gust).toFixed(1)}" r="2.2" fill="#ff9548"/>`; });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wind at ${esc(s.name)}">${svg}</svg>
      <p class="chart-key"><span style="color:rgba(255,255,255,.6)">━</span> sustained wind &nbsp;<span style="color:#ff9548">●</span> gusts (mph) &nbsp;<span style="color:#4ad1ff">┆</span> event time</p>`;
  }

  function obsView() {
    if (!state.query) return summaryView();
    if (!state.stations.length) return `<p class="empty">${esc(state.obsNote || "Loading observations…")}</p>`;
    const ev = new Date(state.query.isoUtc).getTime();
    const fmt = (v, d = 0) => (v == null ? "—" : v.toFixed(d));
    return `<div class="pad actions" style="margin:0;padding-bottom:0"><button type="button" data-action="csv-obs">Download CSV (all readings)</button></div>` + state.stations.map((s) => {
      const near = s.obs.filter((o) => Math.abs(o.t - ev) <= 3 * 3600e3);
      return `<div class="pad" style="border-bottom:1px solid var(--rule)">
        <h5 class="sub">${esc(s.name)} · ${miles(s.km)} mi · ${esc(s.source)} ${esc(s.id)}</h5>
        <div class="counts"><div>${s.peak ? Math.round(s.peak.g) : "—"}<small>Peak wind, mph${s.peak ? ` · ${hhmmZ(isoMin(s.peak.t))}` : ""}</small></div><div>${s.precip != null ? s.precip.toFixed(2) : "—"}<small>Rain, in (day)</small></div></div>
        ${windChart(s, ev)}
        <table class="t" style="margin-top:.5rem"><thead><tr><th>UTC</th><th>Wind</th><th>Gust</th><th>Temp / dew</th><th>Rain</th></tr></thead><tbody>
          ${near.map((o) => `<tr${Math.abs(o.t - ev) < 1800e3 ? ' style="background:rgba(74,209,255,.07)"' : ""}><td>${hhmmZ(isoMin(o.t))}</td><td>${o.wdir != null ? `${String(Math.round(o.wdir)).padStart(3, "0")}° ` : ""}${fmt(o.wspd)}</td><td>${fmt(o.gust)}</td><td>${fmt(o.temp)}° / ${fmt(o.dew)}°</td><td>${o.precip1h != null ? o.precip1h.toFixed(2) : "—"}</td></tr>`).join("") || `<tr><td colspan="5">No reports within 3 hours of the event.</td></tr>`}
        </tbody></table></div>`;
    }).join("") + (state.obsNote ? `<p class="empty">${esc(state.obsNote)}</p>` : "") +
      `<p class="empty">Wind in mph, temperature in °F, rain in inches. The highlighted row is closest to the event time.</p>`;
  }

  // —— History: hail, wind and tornado reports near the place since 1950 ————————————————
  const HISTORY_RADII = [1, 3, 10, 25];
  const tileName = (lat, lon) => { const a = Math.floor(lat), o = Math.floor(lon); return `${a >= 0 ? "N" : "S"}${pad(Math.abs(a))}${o >= 0 ? "E" : "W"}${String(Math.abs(o)).padStart(3, "0")}`; };
  // SPC convective day (12 UTC start) of a time; spcDayStart's two-digit years don't reach back before 2000.
  const convDay = (ms) => { const d = new Date(ms - 12 * 3600e3); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12); };
  const rowMs = (t) => Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12));

  async function loadHistory(place) {
    const key = `${place.lat.toFixed(4)},${place.lon.toFixed(4)}`;
    if (state.history?.key === key) return;
    const h = state.history = { key, status: "loading", rows: [], index: null, radiusMi: state.history?.radiusMi || 3, radar: {} };
    render();
    try {
      const maxKm = HISTORY_RADII[HISTORY_RADII.length - 1] / 0.621371;
      const dLat = maxKm / 111, dLon = dLat / Math.max(0.2, Math.cos((place.lat * Math.PI) / 180));
      const names = new Set();
      for (const la of [place.lat - dLat, place.lat, place.lat + dLat]) for (const lo of [place.lon - dLon, place.lon, place.lon + dLon]) names.add(tileName(la, lo));
      const [index, ...tiles] = await Promise.all([getJson(`${HISTORY_BASE}/index.json`), ...[...names].map((n) => getJson(`${HISTORY_BASE}/${n}.json`).catch(() => null))]);
      if (state.history !== h) return;
      h.index = index;
      for (const t of tiles) for (const [time, type, mag, lat, lon, src] of t?.rows || []) {
        const km = distanceKm(place.lat, place.lon, lat, lon);
        if (km <= maxKm) h.rows.push({ time, ms: rowMs(time), type, mag, lat, lon, src, km });
      }
      h.status = "ready";
    } catch (e) {
      h.status = "error";
      h.error = e.message;
    }
    if (state.view === "history") render();
  }

  /** Reports within the chosen radius, grouped by SPC convective day, newest first. */
  function historyDays(h) {
    const km = h.radiusMi / 0.621371;
    const days = new Map();
    for (const r of h.rows) {
      if (r.km > km) continue;
      const start = convDay(r.ms), k = String(start);
      const d = days.get(k) || days.set(k, { key: k, start, hail: null, wind: null, tor: [], n: 0, prelim: false }).get(k);
      d.n++;
      if (r.src === "S") d.prelim = true;
      if (r.type === "H" && (!d.hail || r.mag > d.hail.mag)) d.hail = r;
      if (r.type === "W" && (!d.wind || r.mag > d.wind.mag)) d.wind = r;
      if (r.type === "T") d.tor.push(r);
    }
    return [...days.values()].sort((a, b) => b.start - a.start);
  }

  function historyView() {
    const place = state.place || state.query;
    if (!place) return `<p class="empty">Enter a location and press “Show past weather” with the date left blank to see its hail, wind and tornado history.</p>`;
    const h = state.history;
    if (!h || h.status === "loading") return `<p class="empty">Loading the history near ${esc(place.label)}…</p>`;
    if (h.status === "error") return `<p class="empty">The history couldn't be loaded (${esc(h.error)}).</p>`;
    const days = historyDays(h);
    const hailDays = days.filter((d) => d.hail), windDays = days.filter((d) => d.wind), torDays = days.filter((d) => d.tor.length);
    const biggest = hailDays.reduce((m, d) => (!m || d.hail.mag > m.hail.mag ? d : m), null);
    const strongest = windDays.reduce((m, d) => (!m || d.wind.mag > m.wind.mag ? d : m), null);
    const ix = h.index || {};
    const stat = (label, value, small) => `<div class="stat"><span>${label}${small ? `<small>${small}</small>` : ""}</span><b>${value}</b></div>`;
    const dayLabel = (d) => formatDay(isoMin(d.start).slice(0, 10));
    let html = `<div class="pad"><h5 class="sub">${esc(place.label)} · reports since ${ix.firstYear || 1950}</h5>
      <div class="satpick" style="margin:.1rem 0 .5rem" role="group" aria-label="Distance"><span>Within</span>${HISTORY_RADII.map((r) => `<button type="button" data-radius="${r}" aria-pressed="${r === h.radiusMi}">${r} mi</button>`).join("")}</div>`;
    html += stat(`Days with hail ≥ ${ix.thresholds?.hailInches ?? 1}"`, hailDays.length, biggest ? `Largest ${biggest.hail.mag}" on ${dayLabel(biggest)}, ${miles(biggest.hail.km)} mi away` : "None reported");
    html += stat(`Days with wind ≥ ${ix.thresholds?.windMph ?? 58} mph`, windDays.length, strongest ? `Strongest ${strongest.wind.mag} mph on ${dayLabel(strongest)}` : "None reported");
    html += stat("Days with a tornado", torDays.length, torDays[0] ? `Most recent ${dayLabel(torDays[0])}` : "None reported");
    html += `<p class="note">Point reports from NCEI Storm Events (official, through ${ix.lastDay ? formatDay(ix.lastDay) : "—"}) and SPC preliminary reports after that.
      Reports show where hail or damage was seen, so a quiet record doesn't rule out a storm.</p>`;
    const radarDays = days.filter((d) => d.start + 86_400_000 >= MRMS.archiveStart.getTime() && (d.hail || d.wind || d.tor.length));
    if (radarDays.length) {
      const busy = Object.values(h.radar).some((v) => v === "loading");
      html += `<div class="actions"><button type="button" data-action="radar-hail"${busy ? " disabled" : ""}>${busy ? "Checking radar…" : `Check radar-estimated hail at this spot (${Math.min(radarDays.length, 60)} day${radarDays.length === 1 ? "" : "s"} since Oct 2020)`}</button>
        <button type="button" data-action="csv-history">Download CSV</button></div>`;
    }
    html += `</div>`;
    if (!days.length) return html + `<p class="empty">No qualifying reports within ${h.radiusMi} mi.</p>`;
    const fmtRadar = (v) => (v === "loading" ? "…" : v == null ? "" : v.at > 0 ? `${(v.at / 25.4).toFixed(2)}"` : v.peak > 0 ? `0 (${(v.peak / 25.4).toFixed(2)}" near)` : "0");
    const anyRadar = Object.keys(h.radar).length > 0;
    html += `<div class="pad" style="padding-top:0"><table class="t"><thead><tr><th>Day</th><th>Hail</th><th>Wind</th><th>Tornado</th>${anyRadar ? "<th>Radar hail</th>" : ""}</tr></thead><tbody>`;
    html += days.slice(0, 400).map((d) => {
      const top = d.hail || d.wind || d.tor[0];
      return `<tr class="go" data-history="${esc(top.time)}" title="Show this day"><td style="white-space:nowrap">${isoMin(d.start).slice(0, 10)}${d.prelim ? "<small>preliminary</small>" : ""}</td>
        <td>${d.hail ? `${d.hail.mag}" · ${miles(d.hail.km)} mi` : ""}</td><td>${d.wind ? `${d.wind.mag} mph` : ""}</td>
        <td>${d.tor.length ? esc(d.tor.map((t) => t.mag || "EFU").join(", ")) : ""}</td>${anyRadar ? `<td>${fmtRadar(h.radar[d.key])}</td>` : ""}</tr>`;
    }).join("") + `</tbody></table></div>`;
    if (days.length > 400) html += `<p class="empty">Showing the newest 400 of ${days.length} days.</p>`;
    if (anyRadar) html += `<p class="empty">Radar hail: NOAA MRMS estimated maximum hail size at this spot over the SPC day; “near” is the largest within about 6 miles.</p>`;
    return html;
  }

  async function checkRadarHail() {
    const h = state.history, place = state.place || state.query;
    if (!h || !place) return;
    const days = historyDays(h).filter((d) => d.start + 86_400_000 >= MRMS.archiveStart.getTime() && (d.hail || d.wind || d.tor.length)).slice(0, 60);
    days.forEach((d) => { if (!(d.key in h.radar)) h.radar[d.key] = "loading"; });
    render();
    const queue = days.filter((d) => h.radar[d.key] === "loading");
    const worker = async () => {
      for (let d; (d = queue.shift());) {
        const f = await MRMS.fetchProduct("hail", isoMin(d.start + 86_400_000), place.lat, place.lon, { halfLat: 0.15, mode: "atOrBefore", maxMinutes: 240 }).catch(() => null);
        if (state.history !== h) return;
        h.radar[d.key] = f ? { at: f.at, peak: f.peak } : null;
        if (state.view === "history") render();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // —— CSV downloads and the printed summary ———————————————————————————————————
  function downloadCsv(name, header, rows) {
    const cell = (v) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const blob = new Blob([[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const fileStem = () => {
    const q = state.query || state.place;
    return `pastweather-${(q.label || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}${state.query ? `-${state.query.isoUtc.slice(0, 10)}` : ""}`;
  };
  function csvReports() {
    downloadCsv(`${fileStem()}-reports.csv`, ["time_utc", "type", "magnitude", "location", "county", "state", "lat", "lon", "distance_mi", "source", "details"],
      state.reports.slice().sort((a, b) => a.distanceKm - b.distanceKm).map((r) => [r.timeUtc, r.label, r.magnitude, r.location, r.county, r.state, r.lat, r.lon, miles(r.distanceKm), r.source, r.comments]));
  }
  function csvObs() {
    const n = (v, d = 1) => (v == null ? "" : v.toFixed(d));
    downloadCsv(`${fileStem()}-observations.csv`, ["station_id", "station", "distance_mi", "source", "time_utc", "wind_dir_deg", "wind_mph", "gust_mph", "temp_f", "dewpoint_f", "sea_level_pressure_mb", "visibility_mi", "precip_1h_in", "weather"],
      state.stations.flatMap((s) => s.obs.map((o) => [s.id, s.name, miles(s.km), s.source, isoMin(o.t), o.wdir == null ? "" : Math.round(o.wdir), n(o.wspd), n(o.gust), n(o.temp), n(o.dew), n(o.slp), n(o.vis, 2), n(o.precip1h, 2), o.wx])));
  }
  function csvHistory() {
    const h = state.history;
    const km = h.radiusMi / 0.621371;
    const kind = { H: "Hail (in)", W: "Thunderstorm wind (mph)", T: "Tornado" };
    downloadCsv(`${fileStem()}-history-${h.radiusMi}mi.csv`, ["time_utc", "type", "magnitude", "lat", "lon", "distance_mi", "source"],
      h.rows.filter((r) => r.km <= km).sort((a, b) => b.ms - a.ms).map((r) => [isoMin(r.ms), kind[r.type], r.mag, r.lat, r.lon, miles(r.km), r.src === "S" ? "SPC preliminary" : "NCEI Storm Events"]));
  }

  async function printSummary() {
    const q = state.query;
    if (!q) return;
    const t = (s) => esc(s ?? "");
    const near = state.reports.filter((r) => r.distanceKm <= PRINT_RADIUS_KM).sort((a, b) => a.distanceKm - b.distanceKm);
    const panel = document.createElement("div");
    panel.innerHTML = summaryView();
    const stats = [...panel.querySelectorAll(".stat")].map((el) => `<tr><td>${t(el.querySelector("span").firstChild?.textContent)}</td><td><b>${t(el.querySelector("b").textContent)}</b></td><td>${t(el.querySelector("small")?.textContent)}</td></tr>`).join("");
    const ev = new Date(q.isoUtc).getTime();
    const fmt = (v, d = 0) => (v == null ? "—" : v.toFixed(d));
    $("printout").innerHTML = `
      <h1>Weather event summary</h1>
      <p><b>${t(q.label)}</b>${parseLatLon(q.label) ? "" : ` (${q.lat.toFixed(4)}, ${q.lon.toFixed(4)})`} · ${t(formatDisplayUtc(q.isoUtc))}${isRange(q) ? ` · period through ${t(formatDisplayUtc(isoMin(rangeEnd(q))))}` : ""}</p>
      <p class="meta">Prepared ${t(formatDisplayUtc(isoMin(Date.now())))} with Standard Weather PastWeather · ${t(location.href)}</p>
      <h2>Summary</h2><table><tbody>${stats}</tbody></table>
      <h2>Storm reports within 10 miles (${near.length})</h2>
      ${near.length ? `<table><thead><tr><th>Time (UTC)</th><th>Type</th><th>Size / speed</th><th>Location</th><th>Distance</th><th>Source</th></tr></thead><tbody>
        ${near.map((r) => `<tr><td>${t(formatDisplayUtc(r.timeUtc))}</td><td>${t(r.label)}</td><td>${t(r.magnitude)}</td><td>${t(r.location)}${r.state ? `, ${t(r.state)}` : ""}</td><td>${miles(r.distanceKm)} mi</td><td>${t(r.source)}</td></tr>`).join("")}</tbody></table>`
        : "<p>No storm reports within 10 miles.</p>"}
      <h2>Nearest station observations</h2>
      ${state.stations.map((s) => {
        const rows = s.obs.filter((o) => Math.abs(o.t - ev) <= 3 * 3600e3);
        return `<p><b>${t(s.name)}</b> (${t(s.source)} ${t(s.id)}), ${miles(s.km)} mi away · peak wind ${s.peak ? `${Math.round(s.peak.g)} mph at ${t(formatDisplayUtc(isoMin(s.peak.t)))}` : "—"}${s.precip != null ? ` · rain ${s.precip.toFixed(2)}"` : ""}</p>
          <table><thead><tr><th>UTC</th><th>Wind (mph)</th><th>Gust</th><th>Temp / dew (°F)</th><th>Rain (in)</th></tr></thead><tbody>
          ${rows.map((o) => `<tr><td>${hhmmZ(isoMin(o.t))}</td><td>${o.wdir != null ? `${String(Math.round(o.wdir)).padStart(3, "0")}° ` : ""}${fmt(o.wspd)}</td><td>${fmt(o.gust)}</td><td>${fmt(o.temp)} / ${fmt(o.dew)}</td><td>${o.precip1h != null ? o.precip1h.toFixed(2) : "—"}</td></tr>`).join("") || `<tr><td colspan="5">No reports within 3 hours of the event.</td></tr>`}
          </tbody></table>`;
      }).join("") || "<p>No hourly station observations found nearby.</p>"}
      <h2>Sources and limits</h2>
      <p class="meta">Radar, hail size, rotation and rain: NOAA MRMS (noaa-mrms-pds on AWS). Storm reports: NOAA SPC (preliminary) and NCEI Storm Events Database (official).
        Observations: NOAA NCEI Integrated Surface Database and the National Weather Service. Hail sizes from MRMS are radar estimates (MESH), not measurements.
        This summary is not a certified weather analysis. For a certified report, contact Standard Weather Forensics &amp; Consulting at standardweather.github.io.</p>`;
    // Size the map to the page, frame the place and nearby reports, give the tiles a moment, then print.
    document.body.classList.add("printing");
    map.invalidateSize();
    if (near.length) {
      const b = L.latLngBounds([[q.lat, q.lon]]);
      near.forEach((r) => b.extend([r.lat, r.lon]));
      map.fitBounds(b.pad(0.4), { maxZoom: 10, animate: false });
    } else map.setView([q.lat, q.lon], 8, { animate: false });
    await new Promise((r) => setTimeout(r, 1500));
    window.print();
    document.body.classList.remove("printing");
    map.invalidateSize();
  }

  function render() {
    $("panel").innerHTML = state.view === "reports" ? reportsView() : state.view === "obs" ? obsView() : state.view === "history" ? historyView() : summaryView();
  }
  function setView(v) {
    state.view = v;
    document.querySelectorAll("#views button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === v));
    if (v === "history" && (state.place || state.query)) loadHistory(state.place || state.query);
    render();
  }
  $("views").addEventListener("click", (e) => { const v = e.target.closest("[data-view]")?.dataset.view; if (v) setView(v); });
  $("panel").addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "print") return printSummary();
    if (action === "csv-reports") return csvReports();
    if (action === "csv-obs") return csvObs();
    if (action === "csv-history") return csvHistory();
    if (action === "radar-hail") return checkRadarHail();
    const radius = e.target.closest("[data-radius]")?.dataset.radius;
    if (radius && state.history) { state.history.radiusMi = +radius; render(); return; }
    const day = e.target.closest("[data-history]")?.dataset.history;
    if (day) {
      $("date").value = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
      $("time").value = `${day.slice(8, 10)}:${day.slice(10, 12)}`;
      $("through").value = "";
      state.view = "summary";
      document.querySelectorAll("#views button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === "summary"));
      $("query").requestSubmit();
      return;
    }
    const el = e.target.closest("[data-report]");
    if (!el) return;
    state.selectedReport = el.dataset.report;
    const r = state.reports.find((x) => x.id === state.selectedReport);
    render();
    if (r && reportMarkers[r.id]) { map.setView([r.lat, r.lon], Math.max(map.getZoom(), 9)); reportMarkers[r.id].openPopup(); }
  });

  // —— Loading —————————————————————————————————————————————————————
  async function loadRadar(isoUtc) {
    const q = state.query;
    const token = ++state.loadToken;
    $("frameTime").textContent = "Loading radar…";
    let frame = null, error = null;
    if (!MRMS.isBeforeArchive(isoUtc)) frame = await MRMS.fetchFrame(isoUtc, q.lat, q.lon).catch((e) => { error = e.message; return null; });
    if (token !== state.loadToken) return;
    state.radarInfo = frame;
    overlay(layers.radar, frame, "radar");
    $("frameTime").innerHTML = frame ? `<b>Radar ${esc(formatDisplayUtc(frame.timeIso))}</b>` : esc(error || "No radar for this time");
    $("reset").hidden = Math.abs(new Date(isoUtc) - new Date(q.isoUtc)) < 60e3;
    if (state.view === "summary") render();
  }

  async function loadSwaths(q) {
    // The 24-hour maximum ending at the close of the SPC day (12 UTC the next morning), or the newest file if that's still ahead.
    const end = Math.min(spcDayStart(q.isoUtc) + 86_400_000, Date.now() - 15 * 60e3);
    const [hail, rotation, rain] = await Promise.all(["hail", "rotation", "rain24"].map((name) =>
      MRMS.fetchProduct(name, isoMin(end), q.lat, q.lon, { mode: "atOrBefore", maxMinutes: 240 }).catch(() => null)));
    if (state.query !== q) return;
    state.hail = hail;
    state.rotation = rotation;
    overlay(layers.hail, hail, "swath");
    overlay(layers.rotation, rotation, "swath");
    overlay(layers.rain, rain, "swath");
  }

  /** Radar-and-gauge rain at the place, summed over each SPC day of the period (one 24-hour MRMS file per day). */
  async function loadRain(q) {
    const days = rangeDays(q).filter((t) => t + 86_400_000 >= MRMS.archiveStart.getTime() && t + 86_400_000 <= Date.now());
    if (!days.length) return;
    state.rain = { loading: true, total: null, missing: 0 };
    const vals = await Promise.all(days.map((t) => MRMS.fetchProduct("rain24", isoMin(t + 86_400_000), q.lat, q.lon, { halfLat: 0.1, mode: "atOrBefore", maxMinutes: 90 })
      .then((f) => (f ? Math.max(0, f.at ?? 0) : null)).catch(() => null)));
    if (state.query !== q) return;
    const got = vals.filter((v) => v != null);
    state.rain = { loading: false, total: got.length ? got.reduce((a, b) => a + b, 0) : null, missing: vals.length - got.length };
    if (state.view === "summary") render();
  }

  /** SPC and NCEI reports for every SPC day of the period. */
  async function loadReports(q) {
    let error = null, ncei = null;
    const lists = await Promise.all(rangeDays(q).map(async (t) => {
      const iso = isoMin(t + 3600e3);
      const [spc, nc] = await Promise.all([
        fetchSpcReportsNear(iso, q.lat, q.lon, RADIUS_KM).catch((e) => { error = e.message; return []; }),
        fetchNceiReportsNear(iso, q.lat, q.lon, RADIUS_KM).catch(() => null),
      ]);
      if (nc) ncei = !ncei || nc.pending ? nc : ncei;
      return [...spc, ...(nc?.reports || [])];
    }));
    const seen = new Set();
    return { reports: lists.flat().filter((r) => !seen.has(r.id) && seen.add(r.id)), ncei, error };
  }

  function rememberPlace(p) {
    state.place = { label: p.label, lat: p.lat, lon: p.lon };
    try { localStorage.setItem("sw-place", JSON.stringify(state.place)); } catch { /* private mode */ }
  }

  async function run(q) {
    state.query = q;
    state.radarIso = q.isoUtc;
    state.reports = []; state.stations = []; state.hail = state.rotation = state.rain = null; state.selectedReport = null; state.obsNote = null;
    ["hail", "rotation", "rain", "reports", "stations"].forEach((k) => layers[k].clearLayers());
    rememberPlace(q);
    const params = new URLSearchParams({ loc: $("location").value.trim(), date: q.isoUtc.slice(0, 10), time: q.isoUtc.slice(11, 16).replace(":", "") });
    if (q.endMs) params.set("through", isoMin(q.endMs - 86_400_000).slice(0, 10));
    history.replaceState(null, "", `?${params}`);
    $("when").textContent = formatDisplayUtc(q.isoUtc).replace(" UTC", "Z");
    $("scrub").hidden = false;
    drawPoi();
    // No animation: radar decoding can block the main thread long enough to strand a zoom animation half-finished.
    map.setView([q.lat, q.lon], 8, { animate: false });
    render();
    setStatus("Loading radar, swaths, reports and observations…");

    const tasks = [
      loadRadar(q.isoUtc),
      loadSwaths(q),
      loadRain(q),
      loadReports(q).then(({ reports, ncei, error: reportsError }) => {
        if (state.query !== q) return;
        state.reports = reports;
        state.reportNote = !ncei ? "The official NCEI Storm Events record couldn't be loaded."
          : ncei.pending ? (ncei.lastDay ? `NCEI's official Storm Events record runs through ${formatDay(ncei.lastDay)}; later days show SPC preliminary reports only.` : "The official NCEI record isn't available for this day yet.")
          : null;
        if (!state.reports.length && reportsError) state.reportNote = reportsError;
        drawReports();
        render();
      }),
      loadObservations(q).then(({ stations, note }) => {
        if (state.query !== q) return;
        state.stations = stations;
        state.obsNote = note;
        drawStations();
        render();
      }),
    ];
    if (state.view === "history") loadHistory(q);
    await Promise.allSettled(tasks);
    if (state.query === q) { setStatus(""); render(); }
  }

  /** Location only: geocode and show the History view. */
  async function runHistory(place) {
    rememberPlace(place);
    history.replaceState(null, "", `?${new URLSearchParams({ loc: $("location").value.trim(), view: "history" })}`);
    layers.poi.clearLayers();
    L.circleMarker([place.lat, place.lon], { pane: "points", radius: 7, color: "#fff", weight: 2.5, fillColor: "#4ad1ff", fillOpacity: 1 })
      .bindTooltip(esc(place.label), { className: "tw-tip", direction: "top", offset: [0, -8] }).addTo(layers.poi);
    map.setView([place.lat, place.lon], 10, { animate: false });
    setView("history");
  }

  $("query").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("err");
    err.hidden = true;
    if (!$("date").value.trim() && !$("time").value.trim()) {
      $("show").disabled = true;
      try { await runHistory(await geocodePlace($("location").value)); }
      catch (ex) { err.textContent = ex.message || "Could not find that place."; err.hidden = false; }
      finally { $("show").disabled = false; }
      return;
    }
    const iso = toIsoUtc($("date").value, $("time").value || "12:00");
    if (!iso) { err.textContent = "Use date YYYY-MM-DD and time HH:MM (UTC), or leave both blank for the place's history."; err.hidden = false; return; }
    let endMs = null;
    if ($("through").value.trim()) {
      const thru = toIsoUtc($("through").value, "12:00");
      const days = thru ? Math.round((spcDayStart(thru) - spcDayStart(iso)) / 86_400_000) + 1 : 0;
      if (!thru || days < 1) { err.textContent = "The through date should be YYYY-MM-DD, on or after the date."; err.hidden = false; return; }
      if (days > MAX_RANGE_DAYS) { err.textContent = `Periods can be up to ${MAX_RANGE_DAYS} days.`; err.hidden = false; return; }
      if (days > 1) endMs = spcDayStart(thru) + 86_400_000;
    }
    if (MRMS.isBeforeArchive(iso)) { err.textContent = "Radar and swaths start October 14, 2020. Storm reports and observations still load for earlier dates."; err.hidden = false; }
    $("show").disabled = true;
    try {
      const geo = await geocodePlace($("location").value);
      await run({ ...geo, isoUtc: iso, endMs });
    } catch (ex) {
      err.textContent = ex.message || "Could not find that place.";
      err.hidden = false;
    } finally {
      $("show").disabled = false;
    }
  });

  $("scrub").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !state.query) return;
    if (b.id === "reset") state.radarIso = state.query.isoUtc;
    else if (b.dataset.step) state.radarIso = shiftIso(state.radarIso, Number(b.dataset.step));
    else return;
    loadRadar(state.radarIso);
  });

  $("layers").addEventListener("change", (e) => {
    const k = e.target.dataset?.layer;
    if (!k) return;
    state.on[k] = e.target.checked;
    e.target.checked ? layers[k].addTo(map) : layers[k].remove();
    drawLegend();
  });

  // Open a shared link: ?loc=Moore, OK&date=2024-05-01&time=2215
  const p = new URLSearchParams(location.search);
  drawLegend();
  if (p.get("loc") && p.get("date") && p.get("time")) {
    $("location").value = p.get("loc");
    $("date").value = p.get("date");
    $("time").value = p.get("time").replace(/^(\d{2})(\d{2})$/, "$1:$2");
    $("through").value = p.get("through") || "";
    $("query").requestSubmit();
  } else if (p.get("loc")) {
    $("location").value = p.get("loc");
    if (p.get("view") === "history") $("query").requestSubmit();
  } else {
    // Offer the place last used on any Standard Weather page.
    try { const saved = JSON.parse(localStorage.getItem("sw-place") || "null"); if (saved?.label) $("location").value = saved.label; } catch { /* none saved */ }
  }
})();
