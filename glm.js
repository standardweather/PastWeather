/* GOES lightning (GLM) flashes near a place and time, read in the browser from NOAA's open-data buckets on AWS.
 *
 * GLM files (GLM-L2-LCFA, one per 20 seconds) are netCDF4 (HDF5) and about half a megabyte each, nearly all of it
 * the per-event detail. A flash's position and time sit in three small arrays, so this reads only those, with HTTP
 * range requests: a minimal HDF5 reader that follows the root group's links to the flash_lat, flash_lon and
 * flash_time_offset_of_first_event datasets and their chunks. Typically 20–40 KB per file instead of 500 KB.
 *
 * It understands what NOAA's GLM writer produces (superblock v2/v3, version 2 object headers, links in a fractal
 * heap or in link messages, contiguous or v1-B-tree chunked storage, no filters). Anything else throws, and that
 * file is counted as unread.
 */
(function (root) {
  "use strict";

  const BLOCK = 4096;
  const UNDEF = 0xffffffffffffffffn;
  const TIME_SCALE = 0.00038148, TIME_OFFSET = -5;   // flash_time_offset_of_first_event packing (uint16)

  /** Byte ranges of one remote file, fetched in BLOCK-sized pieces and cached. */
  class RangeFile {
    constructor(url, size) { this.url = url; this.size = size; this.blocks = new Map(); this.bytes = 0; }
    async read(off, len) {
      const first = Math.floor(off / BLOCK), last = Math.floor((off + len - 1) / BLOCK);
      let runStart = null;
      const runs = [];
      for (let b = first; b <= last + 1; b++) {
        const missing = b <= last && !this.blocks.has(b);
        if (missing && runStart == null) runStart = b;
        if (!missing && runStart != null) { runs.push([runStart, b - 1]); runStart = null; }
      }
      await Promise.all(runs.map(async ([a, b]) => {
        const end = Math.min(this.size, (b + 1) * BLOCK) - 1;
        const res = await fetch(this.url, { headers: { Range: `bytes=${a * BLOCK}-${end}` } });
        if (res.status !== 206 && res.status !== 200) throw new Error(`GLM file read failed (${res.status})`);
        let buf = new Uint8Array(await res.arrayBuffer());
        if (res.status === 200) buf = buf.subarray(a * BLOCK, end + 1);   // server ignored the range
        this.bytes += buf.length;
        for (let k = a; k <= b; k++) this.blocks.set(k, buf.subarray((k - a) * BLOCK, (k - a + 1) * BLOCK));
      }));
      const out = new Uint8Array(len);
      for (let b = first; b <= last; b++) {
        const blk = this.blocks.get(b), base = b * BLOCK;
        const s = Math.max(off, base), e = Math.min(off + len, base + blk.length);
        if (e > s) out.set(blk.subarray(s - base, e - base), s - off);
      }
      return new DataView(out.buffer);
    }
  }

  const sig = (dv, at) => String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));
  const u64 = (dv, at) => dv.getBigUint64(at, true);
  const addr = (dv, at) => { const v = u64(dv, at); return v === UNDEF ? null : Number(v); };
  const uN = (dv, at, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + dv.getUint8(at + i); return v; };

  /** Messages of a version 2 object header, following continuation blocks: [{ type, dv, at, size }]. */
  async function objectHeader(f, at) {
    let dv = await f.read(at, 512);
    if (sig(dv, 0) !== "OHDR") throw new Error("Not an object header");
    const flags = dv.getUint8(5);
    let p = 6 + (flags & 0x20 ? 16 : 0) + (flags & 0x10 ? 4 : 0);
    const sizeLen = 1 << (flags & 3);
    const chunk0 = uN(dv, p, sizeLen);
    p += sizeLen;
    if (p + chunk0 + 4 > 512) dv = await f.read(at, p + chunk0 + 4);
    const msgs = [];
    const blocks = [[dv, p, p + chunk0]];
    while (blocks.length) {
      const [bdv, start, end] = blocks.shift();
      let q = start;
      const hdr = 4 + (flags & 0x04 ? 2 : 0);
      while (q + hdr <= end) {
        const type = bdv.getUint8(q), size = bdv.getUint16(q + 1, true);
        q += hdr;
        if (type === 0x10) {
          const caddr = Number(u64(bdv, q)), clen = Number(u64(bdv, q + 8));
          const cdv = await f.read(caddr, clen);
          if (sig(cdv, 0) !== "OCHK") throw new Error("Bad continuation block");
          blocks.push([cdv, 4, clen - 4]);
        } else if (type !== 0) msgs.push({ type, dv: bdv, at: q, size });
        q += size;
      }
    }
    return msgs;
  }

  /** Link name → object header address, for the names wanted, from a group's object header messages. */
  async function findLinks(f, msgs, names) {
    const out = {};
    const scan = (dv, from, to) => {
      for (const name of names) {
        if (out[name] != null) continue;
        for (let i = from; i + name.length + 9 <= to; i++) {
          if (dv.getUint8(i) !== name.length) continue;
          let ok = true;
          for (let k = 0; k < name.length && ok; k++) ok = dv.getUint8(i + 1 + k) === name.charCodeAt(k);
          if (ok) { out[name] = addr(dv, i + 1 + name.length); break; }
        }
      }
    };
    // Compact storage: link messages in the header.
    for (const m of msgs) if (m.type === 0x06) scan(m.dv, m.at, m.at + m.size);
    // Dense storage: link messages are objects in a fractal heap.
    const info = msgs.find((m) => m.type === 0x02);
    if (info && names.some((n) => out[n] == null)) {
      const heapAt = addr(info.dv, info.at + 2 + (info.dv.getUint8(info.at + 1) & 1 ? 8 : 0));
      if (heapAt != null) {
        const h = await f.read(heapAt, 160);
        if (sig(h, 0) !== "FRHP") throw new Error("Bad fractal heap");
        if (h.getUint16(7, true)) throw new Error("Filtered fractal heap");
        const width = h.getUint16(110, true), startSize = Number(u64(h, 112)), maxDirect = Number(u64(h, 120));
        const maxHeapBits = h.getUint16(128, true), rootAt = addr(h, 132), rows = h.getUint16(140, true);
        const directs = [];
        if (rootAt != null && rows === 0) directs.push([rootAt, startSize]);
        else if (rootAt != null) {
          const maxDirectRows = Math.log2(maxDirect) - Math.log2(startSize) + 2;
          const n = Math.min(rows, maxDirectRows) * width;
          const ib = await f.read(rootAt, 5 + 8 + Math.ceil(maxHeapBits / 8) + n * 8);
          if (sig(ib, 0) !== "FHIB") throw new Error("Bad heap block");
          const base = 5 + 8 + Math.ceil(maxHeapBits / 8);
          for (let i = 0; i < n; i++) {
            const a = addr(ib, base + i * 8), row = Math.floor(i / width);
            if (a != null) directs.push([a, row < 2 ? startSize : startSize * 2 ** (row - 1)]);
          }
        }
        for (const [a, size] of directs) {
          if (names.every((n) => out[n] != null)) break;
          scan(await f.read(a, size), 0, size);
        }
      }
    }
    return out;
  }

  /** A one-dimensional numeric dataset, as a plain array. */
  async function readDataset(f, at) {
    const msgs = await objectHeader(f, at);
    const space = msgs.find((m) => m.type === 0x01), type = msgs.find((m) => m.type === 0x03), layout = msgs.find((m) => m.type === 0x08);
    if (!space || !type || !layout) throw new Error("Incomplete dataset header");
    const sv = space.dv.getUint8(space.at), rank = space.dv.getUint8(space.at + 1);
    const n = rank ? Number(u64(space.dv, space.at + (sv === 1 ? 8 : 4))) : 0;
    const cls = type.dv.getUint8(type.at) & 0x0f, size = type.dv.getUint32(type.at + 4, true);
    const signed = cls === 0 && (type.dv.getUint8(type.at + 1) & 0x08) !== 0;
    const get = cls === 1 && size === 4 ? (dv, i) => dv.getFloat32(i * 4, true)
      : cls === 1 && size === 8 ? (dv, i) => dv.getFloat64(i * 8, true)
      : cls === 0 && size === 2 ? (signed ? (dv, i) => dv.getInt16(i * 2, true) : (dv, i) => dv.getUint16(i * 2, true))
      : cls === 0 && size === 4 ? (signed ? (dv, i) => dv.getInt32(i * 4, true) : (dv, i) => dv.getUint32(i * 4, true))
      : null;
    if (!get) throw new Error("Unsupported data type");
    const out = new Array(n);
    if (!n) return out;
    const L = layout.dv, la = layout.at;
    if (L.getUint8(la) !== 3) throw new Error("Unsupported layout version");
    const lclass = L.getUint8(la + 1);
    if (lclass === 1) {
      const dv = await f.read(Number(u64(L, la + 2)), n * size);
      for (let i = 0; i < n; i++) out[i] = get(dv, i);
      return out;
    }
    if (lclass !== 2) throw new Error("Unsupported storage");
    const dims = L.getUint8(la + 2), btree = addr(L, la + 3), chunkLen = L.getUint32(la + 11, true);
    if (btree == null) return out.fill(null);
    const keySize = 8 + 8 * dims;
    const chunks = [];
    const walk = async (nodeAt) => {
      const head = await f.read(nodeAt, 24);
      if (sig(head, 0) !== "TREE" || head.getUint8(4) !== 1) throw new Error("Bad chunk index");
      const level = head.getUint8(5), used = head.getUint16(6, true);
      const dv = await f.read(nodeAt + 24, used * (keySize + 8) + keySize);
      const kids = [];
      for (let e = 0; e < used; e++) {
        const k = e * (keySize + 8);
        const bytes = dv.getUint32(k, true), mask = dv.getUint32(k + 4, true), start = Number(u64(dv, k + 8)), child = Number(u64(dv, k + keySize));
        if (level === 0) { if (mask) throw new Error("Filtered chunk"); chunks.push([start, child, bytes]); }
        else kids.push(child);
      }
      await Promise.all(kids.map(walk));
    };
    await walk(btree);
    await Promise.all(chunks.map(async ([start, at2, bytes]) => {
      const dv = await f.read(at2, bytes);
      for (let i = 0; i < chunkLen && start + i < n; i++) out[start + i] = get(dv, i);
    }));
    return out;
  }

  /** Flashes in one GLM file: [{ t (ms), lat, lon }]. */
  async function readFlashes(url, size, startMs) {
    const f = new RangeFile(url, size);
    const sb = await f.read(0, 48);
    if (sig(sb, 0) !== "\x89HDF") throw new Error("Not an HDF5 file");
    const v = sb.getUint8(8);
    if (v !== 2 && v !== 3) throw new Error("Unsupported HDF5 version");
    const names = ["flash_lat", "flash_lon", "flash_time_offset_of_first_event"];
    const links = await findLinks(f, await objectHeader(f, Number(u64(sb, 36))), names);
    if (names.some((n) => links[n] == null)) throw new Error("Flash data not found");
    const [lat, lon, off] = await Promise.all(names.map((n) => readDataset(f, links[n])));
    const out = [];
    for (let i = 0; i < lat.length; i++) {
      if (lat[i] == null || lon[i] == null || off[i] == null) continue;
      out.push({ t: startMs + (off[i] * TIME_SCALE + TIME_OFFSET) * 1000, lat: lat[i], lon: lon[i] });
    }
    return { flashes: out, bytes: f.bytes };
  }

  // —— Which satellite, and which files ————————————————————————————————————————
  const START = Date.UTC(2018, 0, 1);
  /** NOAA's GOES-East and GOES-West buckets in service at a time, best first for a longitude. */
  function satellites(ms, lon) {
    const east = ms < Date.UTC(2025, 3, 7, 15) ? ["noaa-goes16", "GOES-16"] : ["noaa-goes19", "GOES-19"];
    const west = ms < Date.UTC(2019, 1, 12) ? null : ms < Date.UTC(2023, 0, 4, 18) ? ["noaa-goes17", "GOES-17"] : ["noaa-goes18", "GOES-18"];
    return lon < -105 && west ? [west, east] : [east];
  }
  const fileStart = (key) => {
    const m = key.match(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)/);
    if (!m) return null;
    const [, y, doy, h, mi, s, tenth] = m.map(Number);
    return Date.UTC(y, 0, doy, h, mi, s) + tenth * 100;
  };
  async function listFiles(bucket, fromMs, toMs) {
    const out = [];
    for (let h = Math.floor(fromMs / 3600e3) * 3600e3; h < toMs; h += 3600e3) {
      const d = new Date(h);
      const doy = Math.floor((h - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
      const prefix = `GLM-L2-LCFA/${d.getUTCFullYear()}/${String(doy).padStart(3, "0")}/${String(d.getUTCHours()).padStart(2, "0")}/`;
      let token = null;
      do {
        const u = `https://${bucket}.s3.amazonaws.com/?list-type=2&prefix=${prefix}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
        const res = await fetch(u);
        if (!res.ok) throw new Error(`GLM listing failed (${res.status})`);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>.*?<Size>(\d+)<\/Size>/gs)) {
          const t = fileStart(m[1]);
          if (t != null && t >= fromMs - 20e3 && t < toMs) out.push({ url: `https://${bucket}.s3.amazonaws.com/${m[1]}`, size: Number(m[2]), t });
        }
        token = (xml.match(/<NextContinuationToken>([^<]+)</) || [])[1] || null;
      } while (token);
    }
    return out;
  }

  /**
   * Flashes within radiusKm of a place between fromMs and toMs.
   * Returns { satellite, flashes: [{ t, lat, lon, km }], files, failed, bytes }.
   */
  async function flashesNear(fromMs, toMs, lat, lon, radiusKm, onProgress) {
    if (toMs < START) return null;
    const dist = (a, b) => {
      const R = 6371, r = Math.PI / 180;
      const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(x));
    };
    let lastError = null;
    for (const [bucket, name] of satellites(fromMs, lon)) {
      let files;
      try { files = await listFiles(bucket, fromMs, toMs); } catch (e) { lastError = e; continue; }
      if (!files.length) continue;
      const flashes = [];
      let next = 0, done = 0, failed = 0, bytes = 0;
      const worker = async () => {
        while (next < files.length) {
          const file = files[next++];
          try {
            const r = await readFlashes(file.url, file.size, file.t);
            bytes += r.bytes;
            for (const fl of r.flashes) {
              if (fl.t < fromMs || fl.t >= toMs) continue;
              const km = dist({ lat, lon }, fl);
              if (km <= radiusKm) flashes.push({ ...fl, km });
            }
          } catch { failed++; }
          onProgress?.(++done, files.length);
        }
      };
      await Promise.all(Array.from({ length: 12 }, worker));
      if (failed === files.length) { lastError = new Error("GLM files couldn't be read"); continue; }
      flashes.sort((a, b) => a.t - b.t);
      return { satellite: name, flashes, files: files.length, failed, bytes };
    }
    if (lastError) throw lastError;
    return { satellite: null, flashes: [], files: 0, failed: 0, bytes: 0 };
  }

  root.GLM = { flashesNear, readFlashes, start: START };
})(typeof window !== "undefined" ? window : globalThis);
