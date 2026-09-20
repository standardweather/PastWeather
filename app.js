/* PastWeather — client-side GitHub Pages app (parity with Expo mobile) */
(function () {
  "use strict";

  const IEM_BASE = "https://mesonet.agron.iastate.edu";
  const SPC_BASE = "https://www.spc.noaa.gov/climo/reports";
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
  };

  /** @type {{ label: string, lat: number, lon: number, isoUtc: string } | null} */
  let query = null;
  let radarIso = null;
  /** @type {L.Map | null} */
  let map = null;
  /** @type {L.TileLayer | null} */
  let radarLayer = null;
  /** @type {L.CircleMarker | null} */
  let poiMarker = null;

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

  function scanTsToLayerId(ts) {
    const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return String(ts).replace(/\D/g, "").slice(0, 12);
      return (
        `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
      );
    }
    return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}`;
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
    const dm = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const tm = time.trim().match(/^(\d{1,2}):(\d{2})$/);
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

  function windowAround(isoUtc, minutes) {
    const t = new Date(isoUtc).getTime();
    return {
      start: new Date(t - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      end: new Date(t + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
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
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", text);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Geocode failed (${res.status}). Try lat, lon instead.`);
    const data = await res.json();
    if (!data?.length) throw new Error("Place not found. Try a clearer name or lat, lon.");
    const hit = data[0];
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("Invalid geocode result. Try lat, lon.");
    }
    const short = hit.display_name?.split(",").slice(0, 3).join(",").trim() || text;
    return { label: short, lat, lon };
  }

  async function listScans(radar, product, start, end) {
    const u = new URL(`${IEM_BASE}/json/radar.py`);
    u.searchParams.set("operation", "list");
    u.searchParams.set("radar", radar);
    u.searchParams.set("product", product);
    u.searchParams.set("start", start);
    u.searchParams.set("end", end);
    const res = await fetch(u.toString());
    if (!res.ok) return [];
    const json = await res.json();
    const raw = json.scans ?? json.data ?? [];
    return raw.map((s) => ({ ts: s.ts, layerId: scanTsToLayerId(s.ts), product }));
  }

  function nearestScan(scans, targetIso) {
    if (!scans.length) return null;
    const target = new Date(targetIso).getTime();
    let best = scans[0];
    let bestDiff = Math.abs(new Date(best.ts).getTime() - target);
    for (const s of scans.slice(1)) {
      const diff = Math.abs(new Date(s.ts).getTime() - target);
      if (diff < bestDiff) {
        best = s;
        bestDiff = diff;
      }
    }
    return best;
  }

  async function fetchNearestUscompScan(isoUtc) {
    const { start, end } = windowAround(isoUtc, 90);
    let scans = await listScans("USCOMP", "N0Q", start, end);
    if (!scans.length) scans = await listScans("USCOMP", "N0B", start, end);
    return nearestScan(scans, isoUtc);
  }

  function iemRadarTileTemplate(radar, product, layerTime) {
    return `${IEM_BASE}/c/tile.py/1.0.0/ridge::${radar}-${product}-${layerTime}/{z}/{x}/{y}.png`;
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
        timeUtc: /^\d{4}$/.test(time || "") ? hhmmToIso(dayKey, time) : time || "",
        lat: plat,
        lon: plon,
        location: location || "",
        county: county || "",
        state: state || "",
        magnitude: mag && mag !== "UNK" ? mag : null,
        comments: rest.join(",").trim(),
        distanceKm: Math.round(d * 10) / 10,
      });
    }
    return reports.sort((a, b) => (a.distanceKm || 0) - (b.distanceKm || 0));
  }

  function ensureMap(lat, lon) {
    if (!map) {
      map = L.map(el.map, { zoomControl: true, attributionControl: true }).setView([lat, lon], 8);
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 16, attribution: "Esri" }
      ).addTo(map);
    } else {
      map.setView([lat, lon], map.getZoom());
    }
    if (poiMarker) poiMarker.remove();
    poiMarker = L.circleMarker([lat, lon], {
      radius: 7,
      color: "#2A1C14",
      weight: 2,
      fillColor: "#F2F0E6",
      fillOpacity: 1,
    }).addTo(map);
    setTimeout(() => map && map.invalidateSize(), 100);
  }

  function setRadarOverlay(scan) {
    if (radarLayer) {
      radarLayer.remove();
      radarLayer = null;
    }
    if (!map || !scan) return;
    const product = scan.product || "N0Q";
    const url = iemRadarTileTemplate("USCOMP", product, scan.layerId);
    radarLayer = L.tileLayer(url, {
      maxZoom: 10,
      opacity: 0.8,
      attribution: `IEM USCOMP-${product}`,
    }).addTo(map);
  }

  function renderReports(reports, error) {
    if (error) {
      el.reports.innerHTML = `<p class="muted">${escapeHtml(error)}</p>`;
      return;
    }
    if (!reports.length) {
      el.reports.innerHTML = `<p class="muted">No storm reports found nearby.</p>`;
      return;
    }
    el.reports.innerHTML =
      `<ul class="reports">` +
      reports
        .map((r) => {
          const mag = r.magnitude ? ` · ${escapeHtml(r.magnitude)}` : "";
          const dist =
            r.distanceKm != null ? `${r.distanceKm} km` : "";
          return `<li>
            <div class="type">${escapeHtml(r.type)}${mag}</div>
            <div>${escapeHtml(r.location)}${r.state ? ", " + escapeHtml(r.state) : ""}</div>
            <div class="meta">${escapeHtml(formatDisplayUtc(r.timeUtc))} · ${escapeHtml(dist)}</div>
          </li>`;
        })
        .join("") +
      `</ul>`;
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
    el.chipSub.classList.remove("hidden");
    el.chipSub.textContent = "Updating radar…";
    el.reports.innerHTML = `<p class="muted">Loading radar and reports…</p>`;

    let scan = null;
    let reports = [];
    let reportsError = null;
    try {
      const [s, r] = await Promise.all([
        fetchNearestUscompScan(isoUtc).catch(() => null),
        fetchSpcReportsNear(isoUtc, query.lat, query.lon, RADIUS_KM).catch((e) => {
          reportsError = e instanceof Error ? e.message : "Could not load storm reports";
          return [];
        }),
      ]);
      scan = s;
      reports = r;
    } finally {
      el.chipSub.classList.add("hidden");
    }

    ensureMap(query.lat, query.lon);
    setRadarOverlay(scan);
    updateChip(scan?.ts || null);
    updateResetVisibility();
    renderReports(reports, reportsError);

    if (!scan) {
      el.chipSub.classList.remove("hidden");
      el.chipSub.textContent = "No radar available for this time and area.";
    }
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

  el.btnShow.addEventListener("click", async () => {
    el.homeError.classList.add("hidden");
    const iso = toIsoUtc(el.date.value, el.time.value);
    if (!iso) {
      el.homeError.textContent = "Use date YYYY-MM-DD and time HH:mm (UTC).";
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
})();
