/* PastWeather — archived weather for a place and time, for standardweather.github.io.
 *
 * Everything loads in the browser from government sources:
 *   NOAA MRMS (noaa-mrms-pds)        radar, 24-hour hail-size and rotation swaths (decoded by mrms.js)
 *   NOAA SPC                         preliminary storm reports
 *   NCEI Storm Events                official record (split into per-day files in data/storm-events by tools/storm_events.py)
 *   NCEI Access Data Service         hourly surface observations (ISD / "global-hourly")
 *   NWS API                          observations for the last few days, before NCEI has them
 *   Census TIGERweb / Geocoder, USGS GNIS   place search
 * A search is kept in the URL (?loc=…&date=…&time=…) so a view can be shared.
 */
(function () {
  "use strict";

  const SPC_BASE = "https://www.spc.noaa.gov/climo/reports";
  const STORM_EVENTS_BASE = "data/storm-events";
  const NCEI = "https://www.ncei.noaa.gov/access/services";
  const RADIUS_KM = 250;
  const OBS_STATIONS = 3;

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isoMin = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const hhmmZ = (iso) => { const d = new Date(iso); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };

  const state = {
    query: null,          // { label, lat, lon, isoUtc }
    radarIso: null,
    view: "summary",
    reports: [], reportNote: null, selectedReport: null,
    hail: null, rotation: null,
    stations: [], obsNote: null,
    radarInfo: null, loadToken: 0,
    on: { radar: true, reports: true, hail: false, rotation: false, stations: true },
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
    const startIso = isoMin(start).replace("Z", "");
    const endIso = isoMin(start + 86_400_000).replace("Z", "");
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
      stations = (await nwsObservations(q.lat, q.lon, isoMin(start), isoMin(Math.min(start + 86_400_000, Date.now()))).catch(() => [])).filter((s) => s.obs.length);
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

  const layers = { radar: L.layerGroup(), hail: L.layerGroup(), rotation: L.layerGroup(), reports: L.layerGroup(), stations: L.layerGroup(), poi: L.layerGroup().addTo(map) };
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
    let html = `<div class="pad"><h5 class="sub">${esc(q.label)} · ${esc(formatDisplayUtc(q.isoUtc))}</h5>`;
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
    html += stat("Storm reports", `${r.length}`, `within ${Math.round(RADIUS_KM * 0.621371)} mi · ${count("tornado")} tornado · ${count("hail")} hail · ${count("wind")} wind`);
    const nh = nearest("hail"), nw = nearest("wind"), nt = nearest("tornado");
    if (nh) html += stat("Nearest hail report", `${miles(nh.distanceKm)} mi`, `${esc(nh.magnitude || "")} · ${esc(nh.location)} · ${hhmmZ(nh.timeUtc)}`);
    if (nw) html += stat("Nearest wind report", `${miles(nw.distanceKm)} mi`, `${esc(nw.magnitude || "")} · ${esc(nw.location)} · ${hhmmZ(nw.timeUtc)}`);
    if (nt) html += stat("Nearest tornado report", `${miles(nt.distanceKm)} mi`, `${esc(nt.magnitude || "")} · ${esc(nt.location)} · ${hhmmZ(nt.timeUtc)}`);
    if (s0) html += stat(`Peak wind, ${esc(s0.name)}`, s0.peak ? `${Math.round(s0.peak.g)} mph` : "—", `${miles(s0.km)} mi away${s0.peak ? ` · ${hhmmZ(isoMin(s0.peak.t))}` : ""}${s0.precip != null ? ` · ${s0.precip.toFixed(2)}" rain over the day` : ""}`);
    html += `<p class="note">Day shown: ${esc(formatDisplayUtc(isoMin(spcDayStart(q.isoUtc))))} to 1200 UTC the next day (the SPC convective day).</p>`;
    if (state.reportNote) html += `<p class="note">${esc(state.reportNote)}</p>`;
    return html + `</div>`;
  }

  function reportsView() {
    if (!state.query) return summaryView();
    const list = state.reports.slice().sort((a, b) => a.distanceKm - b.distanceKm);
    if (!list.length) return `<p class="empty">No storm reports within ${Math.round(RADIUS_KM * 0.621371)} miles.</p>${state.reportNote ? `<p class="empty">${esc(state.reportNote)}</p>` : ""}`;
    return list.map((r) => `<div class="report${state.selectedReport === r.id ? " sel" : ""}" data-report="${esc(r.id)}">
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
    for (let t = Math.ceil(t0 / 21600e3) * 21600e3; t <= t1; t += 21600e3) svg += `<text x="${x(t)}" y="${H - 4}" text-anchor="middle" ${mono}>${pad(new Date(t).getUTCHours())}Z</text>`;
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
    return state.stations.map((s) => {
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

  function render() {
    $("panel").innerHTML = state.view === "reports" ? reportsView() : state.view === "obs" ? obsView() : summaryView();
  }
  function setView(v) {
    state.view = v;
    document.querySelectorAll("#views button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === v));
    render();
  }
  $("views").addEventListener("click", (e) => { const v = e.target.closest("[data-view]")?.dataset.view; if (v) setView(v); });
  $("panel").addEventListener("click", (e) => {
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
    const [hail, rotation] = await Promise.all(["hail", "rotation"].map((name) =>
      MRMS.fetchProduct(name, isoMin(end), q.lat, q.lon, { mode: "atOrBefore", maxMinutes: 240 }).catch(() => null)));
    if (state.query !== q) return;
    state.hail = hail;
    state.rotation = rotation;
    overlay(layers.hail, hail, "swath");
    overlay(layers.rotation, rotation, "swath");
  }

  async function run(q) {
    state.query = q;
    state.radarIso = q.isoUtc;
    state.reports = []; state.stations = []; state.hail = state.rotation = null; state.selectedReport = null; state.obsNote = null;
    ["hail", "rotation", "reports", "stations"].forEach((k) => layers[k].clearLayers());
    const params = new URLSearchParams({ loc: $("location").value.trim(), date: q.isoUtc.slice(0, 10), time: q.isoUtc.slice(11, 16).replace(":", "") });
    history.replaceState(null, "", `?${params}`);
    $("when").textContent = formatDisplayUtc(q.isoUtc).replace(" UTC", "Z");
    $("scrub").hidden = false;
    drawPoi();
    // No animation: radar decoding can block the main thread long enough to strand a zoom animation half-finished.
    map.setView([q.lat, q.lon], 8, { animate: false });
    render();
    setStatus("Loading radar, swaths, reports and observations…");

    let reportsError = null;
    const tasks = [
      loadRadar(q.isoUtc),
      loadSwaths(q),
      Promise.all([
        fetchSpcReportsNear(q.isoUtc, q.lat, q.lon, RADIUS_KM).catch((e) => { reportsError = e.message; return []; }),
        fetchNceiReportsNear(q.isoUtc, q.lat, q.lon, RADIUS_KM).catch(() => null),
      ]).then(([spc, ncei]) => {
        if (state.query !== q) return;
        state.reports = [...spc, ...(ncei?.reports || [])];
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
    await Promise.allSettled(tasks);
    if (state.query === q) { setStatus(""); render(); }
  }

  $("query").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("err");
    err.hidden = true;
    const iso = toIsoUtc($("date").value, $("time").value);
    if (!iso) { err.textContent = "Use date YYYY-MM-DD and time HH:MM (UTC)."; err.hidden = false; return; }
    if (MRMS.isBeforeArchive(iso)) { err.textContent = "Radar and swaths start October 14, 2020. Storm reports and observations still load for earlier dates."; err.hidden = false; }
    $("show").disabled = true;
    try {
      const geo = await geocodePlace($("location").value);
      await run({ ...geo, isoUtc: iso });
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
    $("query").requestSubmit();
  }
})();
