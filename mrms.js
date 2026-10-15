/* PastWeather — NOAA MRMS radar decoded in the browser.
 *
 * Frames are MRMS Seamless Hybrid Scan Reflectivity GRIB2 files from NOAA's open-data bucket on AWS
 * (noaa-mrms-pds, CORS-enabled, 2-minute cadence, from 2020-10-14). Each file is gzipped GRIB2 whose data section is a
 * 16-bit grayscale PNG (template 5.41) on a 7000x3500, 0.01° CONUS grid. The PNG is inflated one row at a time and
 * only the rows and columns around the event are kept, then colored and reprojected to Web Mercator for Leaflet.
 * Same approach as the iOS app's MRMSDecoder.swift.
 */
(function () {
  "use strict";

  const BUCKET = "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/SeamlessHSR_00.00";
  const ARCHIVE_START = Date.UTC(2020, 9, 14);
  const CADENCE_MIN = 2;
  const GRID = { width: 7000, height: 3500, west: -129.995, north: 54.995, res: 0.01 };
  const MIN_DBZ = 10;

  // Reflectivity colors at 5 dBZ steps from 15 to 75; values in between are interpolated.
  const FIRST_DBZ = 15;
  const STOPS = [
    [135, 135, 227], [103, 103, 195], [50, 99, 198], [34, 67, 134],
    [0, 198, 0], [0, 134, 0], [255, 198, 0], [255, 134, 0],
    [212, 0, 0], [165, 0, 0], [198, 0, 198], [134, 0, 134], [255, 255, 255],
  ];

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function snap(ms) {
    const step = CADENCE_MIN * 60_000;
    return Math.round(ms / step) * step;
  }

  function fileUrl(ms) {
    const d = new Date(ms);
    const day = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    return `${BUCKET}/${day}/MRMS_SeamlessHSR_00.00_${day}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00.grib2.gz`;
  }

  function color(dBZ) {
    const f = Math.min(STOPS.length - 1, Math.max(0, (dBZ - FIRST_DBZ) / 5));
    const i = Math.min(STOPS.length - 2, Math.floor(f));
    const t = f - i;
    const a = STOPS[i];
    const b = STOPS[i + 1];
    return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t));
  }

  /** Pixel window covering a box of halfLat degrees around (lat, lon), and the geographic edges of those pixels. */
  function windowAround(lat, lon, halfLat) {
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
    const ok = out.png && out.nx === GRID.width && out.ny === GRID.height && out.scan === 0 &&
      Math.abs(out.lat1 - GRID.north) < 5e-4 && Math.abs(out.lon1 - GRID.west) < 5e-4 && Math.abs(out.dx - GRID.res) < 5e-5;
    if (!ok) throw new Error("Unexpected MRMS grid");
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
  async function decodePngWindow(png, win) {
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const idat = [];
    let width = 0, height = 0;
    for (let p = 8; p + 8 <= png.length;) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
      if (type === "IHDR") {
        width = dv.getUint32(p + 8);
        height = dv.getUint32(p + 12);
        if (png[p + 16] !== 16 || png[p + 17] !== 0 || png[p + 20] !== 0) throw new Error("Unsupported radar PNG");
      } else if (type === "IDAT") {
        idat.push(png.subarray(p + 8, p + 8 + len));
      } else if (type === "IEND") {
        break;
      }
      p += 12 + len;
    }
    if (width !== GRID.width || height !== GRID.height) throw new Error("Unexpected radar PNG size");

    const bpp = 2;
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
            for (let x = 0, s = 1 + win.c0 * bpp; x < outW; x++, s += 2) out[o + x] = (cur[s] << 8) | cur[s + 1];
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

  /** Color the window and reproject rows from equirectangular to Web Mercator into a canvas. */
  function render(values, win, field) {
    const lut = new Uint32Array(65536);
    const scale = 2 ** field.e;
    const divisor = 10 ** field.d;
    for (let x = 0; x < 65536; x++) {
      const dBZ = (field.r + x * scale) / divisor;
      if (dBZ < MIN_DBZ) continue;
      const [r, g, b] = color(dBZ);
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
    return canvas;
  }

  /**
   * Load the frame nearest isoUtc around (lat, lon). Resolves to null when no file exists nearby, or
   * { url, bounds, timeIso } where url is a PNG data URL and bounds are Leaflet [[s, w], [n, e]].
   */
  async function fetchFrame(isoUtc, lat, lon, halfLat = 4) {
    const win = windowAround(lat, lon, halfLat);
    if (!win) throw new Error("Location is outside the MRMS (CONUS) radar domain.");
    const t0 = snap(new Date(isoUtc).getTime());
    for (const offset of [0, 2, -2, 4, -4]) {
      const t = t0 + offset * 60_000;
      if (t < ARCHIVE_START) continue;
      const res = await fetch(fileUrl(t));
      if (!res.ok) continue;
      const field = parseGrib(await inflate(await res.arrayBuffer(), "gzip"));
      const values = await decodePngWindow(field.png, win);
      return {
        url: render(values, win, field).toDataURL("image/png"),
        bounds: [[win.minLat, win.minLon], [win.maxLat, win.maxLon]],
        timeIso: new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
    }
    return null;
  }

  window.MRMS = {
    fetchFrame,
    archiveStart: new Date(ARCHIVE_START),
    isBeforeArchive: (isoUtc) => new Date(isoUtc).getTime() < ARCHIVE_START - CADENCE_MIN * 60_000 * 2,
  };
})();
