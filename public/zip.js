/* ------------------------------------------------------------------------ *
 * zip.js — reading and writing .zip archives, with nothing behind it
 *
 * The board used to fetch fflate from a CDN at the moment you clicked
 * "download as .zip". That is the worst possible time to need the network:
 * offline, on a blocked CDN, or simply opened from a file:// URL, the click
 * did nothing at all and said nothing either.
 *
 * Deflate itself is the browser's: CompressionStream("deflate-raw") has been
 * in every current engine for years. Where it is missing, entries are stored
 * uncompressed — a bigger file, but always a file. Reading needs
 * DecompressionStream; where that is missing we say so rather than hand back
 * nonsense.
 *
 * Zip64 is deliberately not implemented: these are cards on a board, not
 * backup tapes. Past 4GB, or past 65535 entries, write() refuses.
 * ------------------------------------------------------------------------ */
(function (g) {
  "use strict";

  /* -------------------------------------------------------------- crc32 */
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ------------------------------------------------------- deflate / raw */
  const canDeflate = () => typeof CompressionStream === "function";
  const canInflate = () => typeof DecompressionStream === "function";

  async function through(stream, bytes) {
    const w = stream.writable.getWriter();
    w.write(bytes);
    w.close();
    const r = stream.readable.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /* null means "could not", never "empty": the caller then stores the bytes
     as they are rather than writing an entry it cannot read back. */
  async function deflate(bytes) {
    if (!canDeflate()) return null;
    try { return await through(new CompressionStream("deflate-raw"), bytes); }
    catch (e) { return null; }
  }

  async function inflate(bytes) {
    if (!canInflate()) throw new Error("this browser cannot unzip");
    return through(new DecompressionStream("deflate-raw"), bytes);
  }

  /* ----------------------------------------------------------- dos time */
  function dosTime(d) {
    const date = d || new Date();
    const y = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* A name inside an archive: forward slashes, no leading slash, and no
     walking up out of wherever it is unpacked. */
  function cleanName(name) {
    return String(name || "file")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .split("/")
      .filter((p) => p && p !== "." && p !== "..")
      .join("/") || "file";
  }

  /* --------------------------------------------------------------- write */
  /* entries: [{ name, bytes }] → Uint8Array holding a complete archive. */
  async function write(entries) {
    const list = (entries || []).filter((e) => e && e.bytes);
    if (list.length > 0xffff) throw new Error("too many files for one archive");

    const stamp = dosTime();
    const parts = [];          // local headers + data, in order
    const central = [];        // one record per entry
    let offset = 0;

    for (const e of list) {
      const name = enc.encode(cleanName(e.name));
      const raw = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes);
      if (raw.length > 0xffffffff) throw new Error("file too large for one archive");

      const sum = crc32(raw);
      /* Small files are stored as they are: a deflate stream costs more in
         header than it can save, and incompressible bytes only grow. */
      let body = raw, method = 0;
      if (raw.length > 64) {
        const packed = await deflate(raw);
        if (packed && packed.length < raw.length) { body = packed; method = 8; }
      }

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);          // version needed
      lv.setUint16(6, 0x0800, true);      // names are UTF-8
      lv.setUint16(8, method, true);
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, sum, true);
      lv.setUint32(18, body.length, true);
      lv.setUint32(22, raw.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);          // no extra field
      local.set(name, 30);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);          // version made by
      cv.setUint16(6, 20, true);          // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, sum, true);
      cv.setUint32(20, body.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);          // extra
      cv.setUint16(32, 0, true);          // comment
      cv.setUint16(34, 0, true);          // disk
      cv.setUint16(36, 0, true);          // internal attributes
      cv.setUint32(38, 0, true);          // external attributes
      cv.setUint32(42, offset, true);
      cd.set(name, 46);

      parts.push(local, body);
      central.push(cd);
      offset += local.length + body.length;
    }

    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);             // this disk
    ev.setUint16(6, 0, true);             // disk holding the directory
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);            // no archive comment

    const all = parts.concat(central, [end]);
    const total = all.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of all) { out.set(p, at); at += p.length; }
    return out;
  }

  /* ---------------------------------------------------------------- read */
  const looksZip = (b) => !!b && b.length > 4 && b[0] === 0x50 && b[1] === 0x4b &&
    (b[2] === 3 || b[2] === 5 || b[2] === 7);

  /* The end-of-directory record sits at the tail, behind a comment of up to
     64KB. Scanning backwards for its signature is how every unzipper finds
     it — the local headers at the front cannot be trusted on their own. */
  function findEnd(view, len) {
    const from = Math.max(0, len - 66560);
    for (let i = len - 22; i >= from; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  /* input: Uint8Array | ArrayBuffer → [{ name, bytes, size }] */
  async function read(input) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const end = findEnd(view, buf.length);
    if (end < 0) throw new Error("this is not a zip archive");

    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const out = [];

    for (let i = 0; i < count; i++) {
      if (at + 46 > buf.length || view.getUint32(at, true) !== 0x02014b50) break;
      const method = view.getUint16(at + 10, true);
      const csize = view.getUint32(at + 20, true);
      const usize = view.getUint32(at + 24, true);
      const nameLen = view.getUint16(at + 28, true);
      const extraLen = view.getUint16(at + 30, true);
      const cmtLen = view.getUint16(at + 32, true);
      const head = view.getUint32(at + 42, true);
      const name = dec.decode(buf.subarray(at + 46, at + 46 + nameLen));
      at += 46 + nameLen + extraLen + cmtLen;

      // a folder is shape, not content, and a shelf has no folders in it
      if (!name || name.endsWith("/")) continue;
      if (head + 30 > buf.length || view.getUint32(head, true) !== 0x04034b50) continue;

      const hName = view.getUint16(head + 26, true);
      const hExtra = view.getUint16(head + 28, true);
      const from = head + 30 + hName + hExtra;
      const body = buf.subarray(from, from + csize);

      let bytes;
      if (method === 0) bytes = new Uint8Array(body);
      else if (method === 8) bytes = await inflate(body);
      else continue;                       // nobody writes the other twelve

      out.push({ name: name.split("/").pop(), bytes, size: usize || bytes.length });
    }

    if (!out.length) throw new Error("nothing readable in this archive");
    return out;
  }

  g.Zip = { write, read, crc32, looksZip, canDeflate, canInflate };
})(window);
