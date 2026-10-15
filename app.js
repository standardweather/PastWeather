/* PastWeather — client-side GitHub Pages app (parity with Expo mobile) */
(function () {
  "use strict";

  const SPC_BASE = "https://www.spc.noaa.gov/climo/reports";
  // Per-day NCEI Storm Events files, split from NCEI's yearly CSVs by tools/storm_events.py.
  const STORM_EVENTS_BASE = "data/storm-events";
  const STEP_MINUTES = [5, 15, 30, 60];
  const RADIUS_KM = 250;

  const el = {
    home: document.getElementById("screen-home"),
    results: document.getElementById("screen-results"),
    location: document.getElementById("location"),
    date: document.getElementById("date"),
    time: document.getElementById("time"),
    homeError: document.getElementById("home-error"),
    btnShow: document.getElementById("btn-show"),
    btnBack: document.getElementById("btn-back"),
    chipMain: document.getElementById("chip-main"),
    chipSub: document.getElementById("chip-sub"),
    reports: document.getElementById("reports"),
    stepBack: document.getElementById("step-back"),
    stepFwd: document.getElementById("step-fwd"),
    btnReset: document.getElementById("btn-reset"),
    map: document.getElementById("map"),
    showReportsMap: document.getElementById("show-reports-map"),
  };

  /** @type {{ label: string, lat: number, lon: number, isoUtc: string } | null} */
  let query = null;
  let radarIso = null;
  /** @type {L.Map | null} */
  let map = null;
  /** @type {L.ImageOverlay | null} */
  let radarLayer = null;
  let loadToken = 0;
  /** @type {L.CircleMarker | null} */
  let poiMarker = null;
  /** @type {L.LayerGroup | null} */
  let reportLayer = null;
  /** @type {any[]} */
  let lastReports = [];

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function spcStormDayKey(isoUtc) {
    const d = new Date(isoUtc);
    const adj = new Date(d);
    if (d.getUTCHours() < 12) adj.setUTCDate(adj.getUTCDate() - 1);
    return (
      String(adj.getUTCFullYear()).slice(-2) +
      pad(adj.getUTCMonth() + 1) +
      pad(adj.getUTCDate())
    );
  }

  function formatDisplayUtc(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return (
      d.toLocaleString("en-GB", {
        timeZone: "UTC",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }) + " UTC"
    );
  }

  function parseLatLon(text) {
    const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  function toIsoUtc(date, time) {
    const rawDate = date.trim();
    const rawTime = time.trim();
    // YYYY-MM-DD or YYYYMMDD
    const dm =
      rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/) ||
      rawDate.match(/^(\d{4})(\d{2})(\d{2})$/);
    // HH:mm, H:mm, or HHmm (0000–2359)
    const tm =
      rawTime.match(/^(\d{1,2}):(\d{2})$/) ||
      rawTime.match(/^(\d{2})(\d{2})$/);
    if (!dm || !tm) return null;
    const y = Number(dm[1]);
    const mo = Number(dm[2]);
    const d = Number(dm[3]);
    const h = Number(tm[1]);
    const mi = Number(tm[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00Z`;
  }

  function shiftIso(isoUtc, minutes) {
    const t = new Date(isoUtc).getTime() + minutes * 60_000;
    return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  // [postal code, FIPS code, name] for TIGERweb (which keys states by FIPS) and for parsing "City, State".
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

  /** "Moore, OK", "Moore, Oklahoma" or "Moore OK" → { name, state }; state is null when none is given. */
  function splitPlace(text) {
    const comma = text.lastIndexOf(",");
    if (comma > 0) {
      const state = findState(text.slice(comma + 1));
      if (state) return { name: text.slice(0, comma).trim(), state };
    }
    for (const words of [2, 1]) {
      const parts = text.trim().split(/\s+/);
      if (parts.length <= words) continue;
      const state = findState(parts.slice(-words).join(" "));
      if (state) return { name: parts.slice(0, -words).join(" "), state };
    }
    return { name: text.trim(), state: null };
  }

  function sqlString(s) {
    return "'" + s.toUpperCase().replace(/'/g, "''") + "'";
  }

  async function arcgisQuery(url, params) {
    const u = new URL(url);
    for (const [k, v] of Object.entries({ f: "json", ...params })) u.searchParams.set(k, v);
    const res = await fetch(u.toString());
    if (!res.ok) throw new Error(`Place search failed (${res.status})`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "Place search failed");
    return json.features || [];
  }

  /** Census TIGERweb incorporated places (layer 4) and census-designated places (layer 5). */
  async function searchTigerPlaces(name, state) {
    const base = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer";
    const where = `UPPER(BASENAME)=${sqlString(name)}` + (state ? ` AND STATE='${state[1]}'` : "");
    const params = { where, outFields: "BASENAME,STATE,INTPTLAT,INTPTLON,AREALAND", returnGeometry: "false" };
    const results = await Promise.all([4, 5].map((layer) => arcgisQuery(`${base}/${layer}/query`, params).catch(() => [])));
    const hits = results.flat().map((f) => f.attributes);
    if (!hits.length) return null;
    // Without a state, the largest place by land area is the likeliest match.
    hits.sort((a, b) => (b.AREALAND || 0) - (a.AREALAND || 0));
    const h = hits[0];
    const st = STATES.find(([, fips]) => fips === h.STATE);
    return { label: `${h.BASENAME}${st ? ", " + st[0] : ""}`, lat: Number(h.INTPTLAT), lon: Number(h.INTPTLON) };
  }

  /** USGS GNIS populated places, for unincorporated communities TIGERweb doesn't list. */
  async function searchGnis(name, state) {
    const where = `UPPER(gaz_name)=${sqlString(name)}` + (state ? ` AND state_alpha='${state[0]}'` : "");
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
      function done(err, value) {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
        err ? reject(err) : resolve(value);
      }
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
    if (direct) {
      return {
        label: `${direct.lat.toFixed(4)}, ${direct.lon.toFixed(4)}`,
        lat: direct.lat,
        lon: direct.lon,
      };
    }
    let hit = null;
    if (/^\d/.test(text)) {
      hit = await searchCensusAddress(text).catch(() => null);
    } else {
      const { name, state } = splitPlace(text);
      hit = (await searchTigerPlaces(name, state).catch(() => null)) ||
        (await searchGnis(name, state).catch(() => null)) ||
        (await searchCensusAddress(text).catch(() => null));
    }
    if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) {
      throw new Error("Place not found. Try “City, ST”, a street address, or lat, lon.");
    }
    return hit;
  }

  function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQ = !inQ;
        continue;
      }
      if (c === "," && !inQ) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  function hhmmToIso(dayKey, hhmm) {
    const yy = Number(dayKey.slice(0, 2));
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    const month = Number(dayKey.slice(2, 4));
    const day = Number(dayKey.slice(4, 6));
    const hh = Number(hhmm.slice(0, 2));
    const mm = Number(hhmm.slice(2, 4));
    const d = new Date(Date.UTC(year, month - 1, day, hh, mm, 0));
    if (hh < 12) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }

  async function fetchSpcReportsNear(isoUtc, lat, lon, radiusKm) {
    const dayKey = spcStormDayKey(isoUtc);
    const url = `${SPC_BASE}/${dayKey}_rpts_filtered.csv`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SPC CSV fetch failed: ${res.status}`);
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    let section = null;
    const reports = [];
    let idx = 0;
    for (const line of lines) {
      const upper = line.toUpperCase();
      if (upper.startsWith("TIME,") && upper.includes("F_SCALE")) {
        section = "tornado";
        continue;
      }
      if (upper.startsWith("TIME,") && upper.includes("SIZE")) {
        section = "hail";
        continue;
      }
      if (upper.startsWith("TIME,") && upper.includes("SPEED")) {
        section = "wind";
        continue;
      }
      if (!section || upper.startsWith("TIME,")) continue;
      const cols = parseCsvLine(line);
      if (cols.length < 7) continue;
      const [time, mag, location, county, state, rlat, rlon, ...rest] = cols;
      const plat = Number(rlat);
      const plon = Number(rlon);
      if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
      const d = distanceKm(lat, lon, plat, plon);
      if (d > radiusKm) continue;
      reports.push({
        id: `spc-${section}-${dayKey}-${idx++}`,
        type: section,
        label: section === "wind" ? "Thunderstorm wind" : section === "hail" ? "Hail" : "Tornado",
        source: "SPC preliminary",
        timeUtc: /^\d{4}$/.test(time || "") ? hhmmToIso(dayKey, time) : time || "",
        lat: plat,
        lon: plon,
        location: location || "",
        county: county || "",
        state: state || "",
        magnitude: spcMagnitude(section, mag),
        comments: rest.join(",").trim(),
        distanceKm: Math.round(d * 10) / 10,
        distanceMi: Math.round(d * 0.621371 * 10) / 10,
      });
    }
    return reports.sort((a, b) => (a.distanceKm || 0) - (b.distanceKm || 0));
  }

  function spcMagnitude(section, mag) {
    if (!mag || mag === "UNK") return null;
    if (section === "tornado") return /^\d$/.test(mag) ? `EF${mag}` : mag;
    if (section === "hail") return Number.isFinite(Number(mag)) ? `${Number(mag) / 100}"` : mag;
    return Number.isFinite(Number(mag)) ? `${mag} mph` : mag;
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

  /** Official NCEI Storm Events overlapping the same SPC convective day (12 UTC to 12 UTC). */
  async function fetchNceiReportsNear(isoUtc, lat, lon, radiusKm) {
    const dayKey = spcStormDayKey(isoUtc);
    const y = 2000 + Number(dayKey.slice(0, 2));
    const start = Date.UTC(y, Number(dayKey.slice(2, 4)) - 1, Number(dayKey.slice(4, 6)), 12);
    const end = start + 86_400_000;
    const index = await getJson(`${STORM_EVENTS_BASE}/index.json`).catch(() => null);
    // Files are keyed by each event's UTC start day; look a day back for events already under way.
    const days = [-1, 0, 1].map((k) => new Date(start + k * 86_400_000));
    const files = await Promise.all(
      days.map((d) => {
        const key = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
        return getJson(`${STORM_EVENTS_BASE}/${key.slice(0, 4)}/${key}.json`).catch(() => null);
      })
    );
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
          id: `ncei-${e.id}`,
          type,
          label: e.type,
          source: "NCEI official" + (e.source ? ` · ${e.source}` : ""),
          timeUtc: new Date(begin).toISOString(),
          lat: e.lat,
          lon: e.lon,
          location: e.location || e.county || "",
          county: e.county || "",
          state: e.state || "",
          magnitude: nceiMagnitude(e, type),
          comments: nceiDetails(e),
          distanceKm: Math.round(d * 10) / 10,
          distanceMi: Math.round(d * 0.621371 * 10) / 10,
        });
      }
    }
    const lastDay = index?.lastDay ? Date.parse(index.lastDay + "T00:00:00Z") + 86_400_000 : null;
    return { reports, pending: lastDay == null || end > lastDay, lastDay: index?.lastDay || null };
  }

  function ensureMap(lat, lon) {
    if (!map) {
      map = L.map(el.map, { zoomControl: true, attributionControl: true }).setView([lat, lon], 8);
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 16, attribution: "Esri" }
      ).addTo(map);
    } else {
      map.setView([lat, lon], map.getZoom());
    }
    if (poiMarker) poiMarker.remove();
    poiMarker = L.circleMarker([lat, lon], {
      radius: 8,
      color: "#FFFFFF",
      weight: 2.5,
      fillColor: "#4AD1FF",
      fillOpacity: 1,
    }).addTo(map);
    setTimeout(() => map && map.invalidateSize(), 100);
  }

  function setRadarOverlay(frame) {
    if (radarLayer) {
      radarLayer.remove();
      radarLayer = null;
    }
    if (!map || !frame) return;
    radarLayer = L.imageOverlay(frame.url, frame.bounds, {
      opacity: 0.8,
      attribution: "NOAA MRMS",
    }).addTo(map);
  }

  function reportFill(type) {
    if (type === "tornado") return "#FF453A";
    if (type === "hail") return "#30D158";
    if (type === "wind") return "#0A84FF";
    if (type === "flood") return "#40C8E0";
    return "#8E8E93";
  }

  function syncReportMarkers() {
    if (!map) return;
    if (!reportLayer) reportLayer = L.layerGroup().addTo(map);
    reportLayer.clearLayers();
    const show = el.showReportsMap && el.showReportsMap.checked;
    if (!show || !lastReports.length) return;
    for (const r of lastReports) {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      const mag = r.magnitude ? " · " + r.magnitude : "";
      const miles =
        r.distanceMi != null
          ? r.distanceMi
          : r.distanceKm != null
            ? Math.round(r.distanceKm * 0.621371 * 10) / 10
            : null;
      const dist = miles != null ? miles + " miles" : "";
      const html =
        "<strong>" +
        escapeHtml(r.label || r.type) +
        escapeHtml(mag) +
        "</strong><br>" +
        escapeHtml(r.location) +
        (r.state ? ", " + escapeHtml(r.state) : "") +
        "<br><span style=\"opacity:0.8\">" +
        escapeHtml(formatDisplayUtc(r.timeUtc)) +
        (dist ? " · " + escapeHtml(dist) : "") +
        "<br>" +
        escapeHtml(r.source || "") +
        "</span>";
      L.circleMarker([r.lat, r.lon], {
        radius: 6,
        color: "#FFFFFF",
        weight: 1.5,
        fillColor: reportFill(r.type),
        fillOpacity: 0.92,
      })
        .bindPopup(html)
        .addTo(reportLayer);
    }
  }

  function renderReports(reports, error, note) {
    lastReports = Array.isArray(reports) ? reports.slice() : [];
    if (error) {
      el.reports.innerHTML = `<p class="muted">${escapeHtml(error)}</p>`;
      syncReportMarkers();
      return;
    }
    const noteHtml = note ? `<p class="muted">${escapeHtml(note)}</p>` : "";
    if (!reports.length) {
      el.reports.innerHTML = `<p class="muted">No storm reports found nearby.</p>` + noteHtml;
      syncReportMarkers();
      return;
    }
    el.reports.innerHTML =
      `<ul class="reports">` +
      reports
        .map((r) => {
          const mag = r.magnitude ? ` · ${escapeHtml(r.magnitude)}` : "";
          const milesVal =
            r.distanceMi != null
              ? r.distanceMi
              : r.distanceKm != null
                ? Math.round(r.distanceKm * 0.621371 * 10) / 10
                : null;
          const dist = milesVal != null ? `${milesVal} miles` : "";
          return `<li class="${escapeHtml(r.type)}">
            <div class="type">${escapeHtml(r.label || r.type)}${mag}</div>
            <div>${escapeHtml(r.location)}${r.state ? ", " + escapeHtml(r.state) : ""}</div>
            <div class="meta">${escapeHtml(formatDisplayUtc(r.timeUtc))} · ${escapeHtml(dist)}</div>
            <div class="meta source">${escapeHtml(r.source || "")}</div>
            ${r.comments ? `<div class="comments">${escapeHtml(r.comments)}</div>` : ""}
          </li>`;
        })
        .join("") +
      `</ul>` +
      noteHtml;
    syncReportMarkers();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateChip(scanTs) {
    const displayIso = scanTs
      ? scanTs.endsWith("Z") || scanTs.includes("+")
        ? scanTs
        : `${scanTs.replace(/Z?$/, "")}Z`
      : radarIso;
    el.chipMain.textContent = `${query.label} · ${formatDisplayUtc(displayIso)}`;
  }

  function updateResetVisibility() {
    const offset =
      Math.round(
        (new Date(radarIso).getTime() - new Date(query.isoUtc).getTime()) / 60_000
      ) !== 0;
    el.btnReset.classList.toggle("hidden", !offset);
  }

  async function loadForTime(isoUtc) {
    const token = ++loadToken;
    el.chipSub.classList.remove("hidden");
    el.chipSub.textContent = "Updating radar…";
    el.reports.innerHTML = `<p class="muted">Loading radar and reports…</p>`;
    ensureMap(query.lat, query.lon);

    let radarError = null;
    let reportsError = null;
    const [frame, spc, ncei] = await Promise.all([
      MRMS.isBeforeArchive(isoUtc)
        ? null
        : MRMS.fetchFrame(isoUtc, query.lat, query.lon).catch((e) => {
            radarError = e instanceof Error ? e.message : "Could not load radar";
            return null;
          }),
      fetchSpcReportsNear(isoUtc, query.lat, query.lon, RADIUS_KM).catch((e) => {
        reportsError = e instanceof Error ? e.message : "Could not load storm reports";
        return [];
      }),
      fetchNceiReportsNear(isoUtc, query.lat, query.lon, RADIUS_KM).catch(() => null),
    ]);
    if (token !== loadToken) return; // a newer step started while this one loaded

    setRadarOverlay(frame);
    updateChip(frame?.timeIso || null);
    updateResetVisibility();

    const reports = [...spc, ...(ncei?.reports || [])].sort((a, b) => (a.distanceKm || 0) - (b.distanceKm || 0));
    let note = null;
    if (!ncei) note = "The official NCEI Storm Events record couldn't be loaded.";
    else if (ncei.pending) {
      note = ncei.lastDay
        ? `NCEI has published its official Storm Events record through ${formatDay(ncei.lastDay)}; newer days show SPC preliminary reports only.`
        : "The official NCEI Storm Events record isn't available for this day yet.";
    }
    renderReports(reports, reports.length ? null : reportsError, note);

    if (frame) {
      el.chipSub.classList.add("hidden");
    } else {
      el.chipSub.classList.remove("hidden");
      el.chipSub.textContent = MRMS.isBeforeArchive(isoUtc)
        ? "No radar before October 14, 2020 (start of NOAA's MRMS archive)."
        : radarError || "No radar available for this time and area.";
    }
  }

  function formatDay(isoDay) {
    return new Date(isoDay + "T00:00:00Z").toLocaleDateString("en-US", {
      timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
    });
  }

  function showResults() {
    el.home.classList.add("hidden");
    el.results.classList.remove("hidden");
    setTimeout(() => map && map.invalidateSize(), 50);
  }

  function showHome() {
    el.results.classList.add("hidden");
    el.home.classList.remove("hidden");
  }

  function buildStepButtons() {
    el.stepBack.innerHTML = "";
    el.stepFwd.innerHTML = "";
    [...STEP_MINUTES].reverse().forEach((m) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "step-btn";
      b.textContent = `−${m}`;
      b.addEventListener("click", () => stepBy(-m));
      el.stepBack.appendChild(b);
    });
    STEP_MINUTES.forEach((m) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "step-btn";
      b.textContent = `+${m}`;
      b.addEventListener("click", () => stepBy(m));
      el.stepFwd.appendChild(b);
    });
  }

  async function stepBy(minutes) {
    radarIso = shiftIso(radarIso, minutes);
    await loadForTime(radarIso);
  }

  if (el.showReportsMap) {
    const saved = localStorage.getItem("pwShowReportsMap");
    if (saved === "0") el.showReportsMap.checked = false;
    if (saved === "1") el.showReportsMap.checked = true;
    el.showReportsMap.addEventListener("change", function () {
      localStorage.setItem("pwShowReportsMap", el.showReportsMap.checked ? "1" : "0");
      syncReportMarkers();
    });
  }

  el.btnShow.addEventListener("click", async () => {
    el.homeError.classList.add("hidden");
    const iso = toIsoUtc(el.date.value, el.time.value);
    if (!iso) {
      el.homeError.textContent = "Use date YYYY-MM-DD or YYYYMMDD, and time HH:mm or HHmm (UTC).";
      el.homeError.classList.remove("hidden");
      return;
    }
    if (MRMS.isBeforeArchive(iso)) {
      el.homeError.textContent = "Radar is available from October 14, 2020 onward. Choose a later date.";
      el.homeError.classList.remove("hidden");
      return;
    }
    el.btnShow.disabled = true;
    try {
      const geo = await geocodePlace(el.location.value);
      query = { label: geo.label, lat: geo.lat, lon: geo.lon, isoUtc: iso };
      radarIso = iso;
      showResults();
      await loadForTime(radarIso);
    } catch (e) {
      el.homeError.textContent = e instanceof Error ? e.message : "Could not resolve location";
      el.homeError.classList.remove("hidden");
    } finally {
      el.btnShow.disabled = false;
    }
  });

  el.btnBack.addEventListener("click", showHome);
  el.btnReset.addEventListener("click", async () => {
    radarIso = query.isoUtc;
    await loadForTime(radarIso);
  });

  buildStepButtons();

  window.addEventListener("resize", () => {
    if (map) map.invalidateSize();
  });
})();
