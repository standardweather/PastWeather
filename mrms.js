/* PastWeather — NOAA MRMS grids decoded in the browser.
 *
 * Files come from NOAA's open-data bucket on AWS (noaa-mrms-pds, CORS-enabled, from 2020-10-14). Each is gzipped
 * GRIB2 whose data section is a 16-bit grayscale PNG (template 5.41) on a 7000x3500, 0.01° CONUS grid. The PNG is
 * inflated one row at a time and only the rows and columns around the event are kept, then colored and reprojected
 * to Web Mercator for Leaflet. Same approach as the iOS app's MRMSDecoder.swift.
 *
 * Products used:
 *   SeamlessHSR_00.00             reflectivity, every 2 minutes (radar loop)
 *   MESH_Max_1440min_00.50        largest estimated hail size in the previous 24 hours (mm)
 *   RotationTrack1440min_00.50    strongest low-level rotation (azimuthal shear, 10⁻³ s⁻¹) in the previous 24 hours
 */
(function () {
  "use strict";

  const ROOT = "https://noaa-mrms-pds.s3.amazonaws.com";
  const ARCHIVE_START = Date.UTC(2020, 9, 14);
  const CADENCE_MIN = 2;
  // Most products use a 0.01° grid; rotation tracks use 0.005°. Each file's header says which.
  const DOMAIN = { west: -130, north: 55, east: -60, south: 20 };

  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const isoMin = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

  // —— Color scales ——————————————————————————————————————————————————
  function ramp(stops) {
    // stops: [[value, [r,g,b]], ...] ascending; returns value -> [r,g,b] or null below the first stop.
    return (v) => {
      if (!(v >= stops[0][0])) return null;
      for (let i = stops.length - 1; i >= 0; i--) {
        if (v >= stops[i][0]) {
          const [v0, a] = stops[i];
          const next = stops[i + 1];
          if (!next) return a;
          const t = (v - v0) / (next[0] - v0);
          return [0, 1, 2].map((k) => Math.round(a[k] + (next[1][k] - a[k]) * t));
        }
      }
      return null;
    };
  }

  // Reflectivity colors at 5 dBZ steps from 15 to 75.
  const REFLECTIVITY = ramp([
    [15, [135, 135, 227]], [20, [103, 103, 195]], [25, [50, 99, 198]], [30, [34, 67, 134]],
    [35, [0, 198, 0]], [40, [0, 134, 0]], [45, [255, 198, 0]], [50, [255, 134, 0]],
    [55, [212, 0, 0]], [60, [165, 0, 0]], [65, [198, 0, 198]], [70, [134, 0, 134]], [75, [255, 255, 255]],
  ]);
  // Hail: MESH is in millimetres; stops at 0.5, 0.75, 1, 1.5, 2, 2.5, 3 inches. Banded, not blended, so sizes read clearly.
  const HAIL_STOPS = [[12.7, [155, 225, 93]], [19.05, [255, 224, 102]], [25.4, [255, 179, 71]], [38.1, [255, 107, 53]],
    [50.8, [232, 35, 58]], [63.5, [181, 23, 158]], [76.2, [114, 9, 183]]];
  const HAIL = (mm) => { let c = null; for (const [v, rgb] of HAIL_STOPS) if (mm >= v) c = rgb; return c; };
  // Rotation: azimuthal shear, stored in units of 10⁻³ s⁻¹. Values below about 8 are mostly noise and ordinary storm
  // motion, so the scale starts there; 10+ is strong and 15+ often accompanies tornadoes.
  const ROT_STOPS = [[8, [255, 209, 102]], [10, [247, 140, 107]], [12, [239, 71, 111]], [15, [201, 24, 74]], [20, [140, 0, 120]]];
  const ROTATION = (s) => { let c = null; for (const [v, rgb] of ROT_STOPS) if (s >= v) c = rgb; return c; };

  const PRODUCTS = {
    reflectivity: { path: "CONUS/SeamlessHSR_00.00", file: "MRMS_SeamlessHSR_00.00", color: REFLECTIVITY, opacity: 0.8 },
    hail: { path: "CONUS/MESH_Max_1440min_00.50", file: "MRMS_MESH_Max_1440min_00.50", color: HAIL, opacity: 0.85 },
    rotation: { path: "CONUS/RotationTrack1440min_00.50", file: "MRMS_RotationTrack1440min_00.50", color: ROTATION, opacity: 0.9 },
  };

  // —— Finding files ————————————————————————————————————————————————————
  // File names carry the exact valid time (seconds vary by product), so list the day and pick the closest.
  const listings = new Map();
  async function listDay(product, day) {
    const key = `${product.path}/${day}`;
    if (!listings.has(key)) {
      listings.set(key, (async () => {
        const times = [];
        let token = "";
        for (let page = 0; page < 5; page++) {
          const u = `${ROOT}/?list-type=2&prefix=${encodeURIComponent(`${product.path}/${day}/`)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
          const res = await fetch(u);
          if (!res.ok) break;
          const xml = await res.text();
          for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
            const t = m[1].match(/_(\d{8})-(\d{2})(\d{2})(\d{2})\.grib2\.gz$/);
            if (t) times.push({ key: m[1], t: Date.UTC(+t[1].slice(0, 4), +t[1].slice(4, 6) - 1, +t[1].slice(6, 8), +t[2], +t[3], +t[4]) });
          }
          const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
          if (!next) break;
          token = next[1];
        }
        return times.sort((a, b) => a.t - b.t);
      })().catch(() => []));
    }
    return listings.get(key);
  }

  /** The file closest to t (within maxMinutes), or with mode "atOrBefore" the latest one not after t. */
  async function findFile(product, t, { maxMinutes = 6, mode = "nearest" } = {}) {
    const d = new Date(t);
    const days = [dayKey(new Date(t - 86400e3)), dayKey(d), dayKey(new Date(t + 86400e3))];
    const all = (await Promise.all(days.map((k) => listDay(product, k)))).flat();
    let best = null;
    for (const f of all) {
      if (mode === "atOrBefore") { if (f.t <= t && (!best || f.t > best.t)) best = f; }
      else if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
    }
    if (!best || Math.abs(best.t - t) > maxMinutes * 60e3) return null;
    return best;
  }

  // —— GRIB2 and PNG decoding ———————————————————————————————————————————
  function windowAround(GRID, lat, lon, halfLat) {
    const halfLon = halfLat / Math.max(0.3, Math.cos((lat * Math.PI) / 180));
    const col = (x) => Math.round((x - GRID.west) / GRID.res);
    const row = (y) => Math.round((GRID.north - y) / GRID.res);
    const c0 = Math.max(0, col(lon - halfLon));
    const c1 = Math.min(GRID.width - 1, col(lon + halfLon));
    const r0 = Math.max(0, row(lat + halfLat));
    const r1 = Math.min(GRID.height - 1, row(lat - halfLat));
    if (c1 <= c0 || r1 <= r0) return null;
    return {
      c0, c1, r0, r1,
      minLat: GRID.north - (r1 + 0.5) * GRID.res,
      maxLat: GRID.north - (r0 - 0.5) * GRID.res,
      minLon: GRID.west + (c0 - 0.5) * GRID.res,
      maxLon: GRID.west + (c1 + 0.5) * GRID.res,
    };
  }

  async function inflate(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** The parts of a single-field GRIB2 message the decoder needs. */
  function parseGrib(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== "GRIB" || b[7] !== 2) throw new Error("Radar file was not GRIB2");
    // GRIB2 stores signed integers as sign and magnitude.
    const s32 = (o) => { const v = dv.getUint32(o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };
    const s16 = (o) => { const v = dv.getUint16(o); return v & 0x8000 ? -(v & 0x7fff) : v; };
    const out = {};
    let p = 16;
    while (p + 5 <= b.length && !(b[p] === 0x37 && b[p + 1] === 0x37 && b[p + 2] === 0x37 && b[p + 3] === 0x37)) {
      const len = dv.getUint32(p);
      const n = b[p + 4];
      if (!len || p + len > b.length) throw new Error("Truncated GRIB2 file");
      if (n === 3) {
        if (dv.getUint16(p + 12) !== 0) throw new Error("Unsupported GRIB2 grid");
        let lon1 = dv.getUint32(p + 50) / 1e6;
        if (lon1 > 180) lon1 -= 360;
        Object.assign(out, {
          nx: dv.getUint32(p + 30), ny: dv.getUint32(p + 34),
          lat1: s32(p + 46) / 1e6, lon1, dx: dv.getUint32(p + 63) / 1e6, scan: b[p + 71],
        });
      } else if (n === 5) {
        if (dv.getUint16(p + 9) !== 41) throw new Error("Unsupported GRIB2 packing");
        Object.assign(out, { r: dv.getFloat32(p + 11), e: s16(p + 15), d: s16(p + 17) });
      } else if (n === 7) {
        out.png = b.subarray(p + 5, p + len);
      }
      p += len;
    }
    const ok = out.png && out.scan === 0 && out.nx > 1000 && out.ny > 500 && Math.abs(out.lat1 - DOMAIN.north) < 0.05 && Math.abs(out.lon1 - DOMAIN.west) < 0.05;
    if (!ok) throw new Error("Unexpected MRMS grid");
    out.grid = { width: out.nx, height: out.ny, west: out.lon1, north: out.lat1, res: out.dx };
    return out;
  }

  /** Undo one PNG row filter in place. row[0] is the filter type; prev is the previous unfiltered row. */
  function unfilter(row, prev, bpp) {
    const n = row.length;
    switch (row[0]) {
      case 1:
        for (let x = 1 + bpp; x < n; x++) row[x] = (row[x] + row[x - bpp]) & 255;
        break;
      case 2:
        for (let x = 1; x < n; x++) row[x] = (row[x] + prev[x]) & 255;
        break;
      case 3:
        for (let x = 1; x < n; x++) {
          const a = x > bpp ? row[x - bpp] : 0;
          row[x] = (row[x] + ((a + prev[x]) >> 1)) & 255;
        }
        break;
      case 4:
        for (let x = 1; x < n; x++) {
          const a = x > bpp ? row[x - bpp] : 0;
          const b = prev[x];
          const c = x > bpp ? prev[x - bpp] : 0;
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        }
        break;
    }
  }

  /** Stream-inflate the 16-bit grayscale PNG and keep only the window's raw values. */
  async function decodePngWindow(png, win, GRID) {
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const idat = [];
    let width = 0, height = 0, depth = 16;
    for (let p = 8; p + 8 <= png.length;) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
      if (type === "IHDR") {
        width = dv.getUint32(p + 8);
        height = dv.getUint32(p + 12);
        depth = png[p + 16];   // 16-bit for reflectivity and hail, 8-bit for rotation tracks
        if ((depth !== 16 && depth !== 8) || png[p + 17] !== 0 || png[p + 20] !== 0) throw new Error("Unsupported radar PNG");
      } else if (type === "IDAT") {
        idat.push(png.subarray(p + 8, p + 8 + len));
      } else if (type === "IEND") {
        break;
      }
      p += 12 + len;
    }
    if (width !== GRID.width || height !== GRID.height) throw new Error("Unexpected radar PNG size");

    const bpp = depth / 8;
    const stride = width * bpp + 1;
    const outW = win.c1 - win.c0 + 1;
    const out = new Uint16Array(outW * (win.r1 - win.r0 + 1));
    let cur = new Uint8Array(stride);
    let prev = new Uint8Array(stride); // PNG treats the row above the first as zeros.
    let fill = 0, y = 0;

    // "deflate" in DecompressionStream is zlib-wrapped, which is what PNG uses.
    const reader = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    try {
      while (y <= win.r1) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Radar data ended early");
        let i = 0;
        while (i < value.length && y <= win.r1) {
          const take = Math.min(stride - fill, value.length - i);
          cur.set(value.subarray(i, i + take), fill);
          fill += take;
          i += take;
          if (fill < stride) break;
          unfilter(cur, prev, bpp);
          if (y >= win.r0) {
            const o = (y - win.r0) * outW;
            if (bpp === 2) for (let x = 0, s = 1 + win.c0 * 2; x < outW; x++, s += 2) out[o + x] = (cur[s] << 8) | cur[s + 1];
            else for (let x = 0, s = 1 + win.c0; x < outW; x++, s++) out[o + x] = cur[s];
          }
          [cur, prev] = [prev, cur];
          fill = 0;
          y++;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return out;
  }

  /** Color the window and reproject rows from equirectangular to Web Mercator into a canvas. Also returns the peak value. */
  function render(values, win, field, colorFn) {
    const GRID = field.grid;
    const lut = new Uint32Array(65536);
    const physical = new Float32Array(65536);
    const scale = 2 ** field.e;
    const divisor = 10 ** field.d;
    for (let x = 0; x < 65536; x++) {
      const v = (field.r + x * scale) / divisor;
      physical[x] = v;
      const rgb = v > -90 ? colorFn(v) : null;    // -999 missing, -99 no coverage
      if (!rgb) continue;
      const [r, g, b] = rgb;
      lut[x] = (255 << 24) | (b << 16) | (g << 8) | r; // RGBA bytes on little-endian
    }
    const outW = win.c1 - win.c0 + 1;
    const outH = win.r1 - win.r0 + 1;
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(outW, outH);
    const px = new Uint32Array(img.data.buffer);
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const yTop = merc(win.maxLat);
    const yBot = merc(win.minLat);
    for (let oy = 0; oy < outH; oy++) {
      const my = yTop + ((oy + 0.5) / outH) * (yBot - yTop);
      const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
      const sy = Math.min(win.r1, Math.max(win.r0, Math.round((GRID.north - lat) / GRID.res))) - win.r0;
      const src = sy * outW;
      const dst = oy * outW;
      for (let x = 0; x < outW; x++) px[dst + x] = lut[values[src + x]];
    }
    ctx.putImageData(img, 0, 0);
    return { canvas, physical };
  }

  /** Physical value at (lat, lon) inside a decoded window, or null. */
  function sampleAt(values, physical, win, lat, lon, GRID) {
    const c = Math.round((lon - GRID.west) / GRID.res) - win.c0;
    const r = Math.round((GRID.north - lat) / GRID.res) - win.r0;
    const w = win.c1 - win.c0 + 1;
    if (c < 0 || r < 0 || c >= w || r > win.r1 - win.r0) return null;
    const v = physical[values[r * w + c]];
    return v > -90 ? v : null;
  }

  /** Largest value within radiusKm of (lat, lon). */
  function maxNear(values, physical, win, lat, lon, radiusKm, GRID) {
    const dr = Math.ceil(radiusKm / 111 / GRID.res);
    const dc = Math.ceil(dr / Math.max(0.3, Math.cos((lat * Math.PI) / 180)));
    const c0 = Math.round((lon - GRID.west) / GRID.res) - win.c0;
    const r0 = Math.round((GRID.north - lat) / GRID.res) - win.r0;
    const w = win.c1 - win.c0 + 1;
    const h = win.r1 - win.r0 + 1;
    let best = null;
    for (let r = Math.max(0, r0 - dr); r <= Math.min(h - 1, r0 + dr); r++) {
      for (let c = Math.max(0, c0 - dc); c <= Math.min(w - 1, c0 + dc); c++) {
        const v = physical[values[r * w + c]];
        if (v > -90 && (best == null || v > best)) best = v;
      }
    }
    return best;
  }

  /**
   * Load one MRMS product around (lat, lon). Resolves to null when no file is near the time, or
   * { url, bounds, timeIso, at, peak } where url is a PNG data URL, bounds are Leaflet [[s, w], [n, e]],
   * `at` is the value at the point and `peak` the largest value within 10 km.
   */
  async function fetchProduct(name, isoUtc, lat, lon, { halfLat = 4, mode = "nearest", maxMinutes } = {}) {
    const product = PRODUCTS[name];
    if (lat < DOMAIN.south || lat > DOMAIN.north || lon < DOMAIN.west || lon > DOMAIN.east) throw new Error("Location is outside the MRMS (CONUS) radar domain.");
    const t = new Date(isoUtc).getTime();
    if (t < ARCHIVE_START) return null;
    const file = await findFile(product, t, { mode, maxMinutes: maxMinutes ?? (name === "reflectivity" ? 6 : 90) });
    if (!file) return null;
    const res = await fetch(`${ROOT}/${file.key}`);
    if (!res.ok) return null;
    const field = parseGrib(await inflate(await res.arrayBuffer(), "gzip"));
    const win = windowAround(field.grid, lat, lon, halfLat);
    if (!win) throw new Error("Location is outside the MRMS (CONUS) radar domain.");
    const values = await decodePngWindow(field.png, win, field.grid);
    const { canvas, physical } = render(values, win, field, product.color);
    return {
      url: canvas.toDataURL("image/png"),
      bounds: [[win.minLat, win.minLon], [win.maxLat, win.maxLon]],
      timeIso: isoMin(file.t),
      opacity: product.opacity,
      at: sampleAt(values, physical, win, lat, lon, field.grid),
      peak: maxNear(values, physical, win, lat, lon, 10, field.grid),
    };
  }

  /** Reflectivity frame nearest isoUtc (kept for the radar loop). */
  const fetchFrame = (isoUtc, lat, lon, halfLat = 4) => fetchProduct("reflectivity", isoUtc, lat, lon, { halfLat });

  window.MRMS = {
    fetchFrame,
    fetchProduct,
    archiveStart: new Date(ARCHIVE_START),
    isBeforeArchive: (isoUtc) => new Date(isoUtc).getTime() < ARCHIVE_START - CADENCE_MIN * 60_000 * 2,
    legends: {
      hail: HAIL_STOPS.map(([mm, rgb]) => [mm / 25.4, rgb]),
      rotation: ROT_STOPS,
    },
  };
})();
