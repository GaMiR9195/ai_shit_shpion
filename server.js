/* server.js — the whole backend for the board.

   Three jobs, nothing else:
     1. serve /public as a static site
     2. resolve the real @chenglou/pretext package out of node_modules and
        expose it to the browser through an import map
     3. a WebSocket room: shared document ops + live pointers,
        plus a small file store so dragged files can be shared

   Runs on Railway with no configuration: it listens on process.env.PORT.
   Attach a volume at /data (or set STORAGE_DIR) to keep files across deploys. */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const PORT = Number(process.env.PORT) || 3000;
const STORAGE = process.env.STORAGE_DIR || path.join(HERE, "storage");
const FILES = path.join(STORAGE, "files");
const ROOMS = path.join(STORAGE, "rooms");
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024;

await fsp.mkdir(FILES, { recursive: true });
await fsp.mkdir(ROOMS, { recursive: true });

/* ------------------------------------------------------------------ *
 * locate the real pretext package (never emulated — either it is
 * installed and we serve it, or the browser is told it is absent)
 * ------------------------------------------------------------------ */
const PKG = "@chenglou/pretext";
let vendorRoot = null;   // absolute dir of the installed package
let vendorEntry = null;  // browser path to its ESM entry

try {
  const resolved = fileURLToPath(import.meta.resolve(PKG));
  const marker = path.join("node_modules", ...PKG.split("/"));
  const at = resolved.lastIndexOf(marker);
  if (at >= 0) {
    vendorRoot = resolved.slice(0, at + marker.length);
    const rel = resolved.slice(vendorRoot.length).split(path.sep).join("/");
    vendorEntry = "/vendor/pretext" + rel;
    console.log(`[space] ${PKG} -> ${vendorEntry}`);
  }
} catch {
  console.warn(`[space] ${PKG} is not installed. run: npm install ${PKG}`);
}

const importMap =
  '<script type="importmap">' +
  JSON.stringify({ imports: vendorEntry ? { [PKG]: vendorEntry } : {} }) +
  "</script>";

/* ------------------------------------------------------------------ *
 * static files
 * ------------------------------------------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const mime = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";

/* keep every read inside the folder it is meant to come from */
function safeJoin(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/\0/g, "");
  const full = path.normalize(path.join(root, clean));
  return full.startsWith(root) ? full : null;
}

async function sendFile(res, file, { cache = "no-cache" } = {}) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return false;
  res.writeHead(200, {
    "content-type": mime(file),
    "content-length": stat.size,
    "cache-control": cache,
  });
  await new Promise((done) => fs.createReadStream(file).pipe(res).on("finish", done).on("error", done));
  return true;
}

const send = (res, code, body, type = "application/json; charset=utf-8") => {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
};

/* ------------------------------------------------------------------ *
 * shared file store
 * ------------------------------------------------------------------ */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function putFile(req, res) {
  let body;
  try {
    body = await readBody(req, MAX_UPLOAD);
  } catch {
    return send(res, 413, { error: `file over ${MAX_UPLOAD / 1048576 | 0}MB` });
  }
  if (!body.length) return send(res, 400, { error: "empty body" });

  const name = String(req.headers["x-file-name"] || "file").slice(0, 200);
  const type = String(req.headers["x-file-type"] || "application/octet-stream").slice(0, 120);
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 32);

  // content addressed: the same file dropped twice is stored once
  await fsp.writeFile(path.join(FILES, hash), body);
  await fsp.writeFile(
    path.join(FILES, hash + ".json"),
    JSON.stringify({ name, type, size: body.length, at: Date.now() })
  );

  send(res, 200, { id: hash, url: "/api/files/" + hash, name, type, size: body.length });
}

async function getFile(res, id) {
  if (!/^[a-f0-9]{8,64}$/.test(id)) return send(res, 400, { error: "bad id" });
  const blob = path.join(FILES, id);
  const metaRaw = await fsp.readFile(path.join(FILES, id + ".json"), "utf8").catch(() => null);
  const stat = await fsp.stat(blob).catch(() => null);
  if (!stat) return send(res, 404, { error: "not found" });

  const meta = metaRaw ? JSON.parse(metaRaw) : {};
  res.writeHead(200, {
    "content-type": meta.type || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "public, max-age=31536000, immutable",
    "content-disposition": `inline; filename="${encodeURIComponent(meta.name || id)}"`,
  });
  fs.createReadStream(blob).pipe(res);
}

/* ------------------------------------------------------------------ *
 * request router
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  try {
    if (url === "/api/health") {
      return send(res, 200, { ok: true, pretext: !!vendorEntry, rooms: rooms.size });
    }
    if (url === "/api/files" && req.method === "POST") return void (await putFile(req, res));
    if (url.startsWith("/api/files/") && req.method === "GET") {
      return void (await getFile(res, url.slice("/api/files/".length).split("?")[0]));
    }

    // the real pretext package, straight out of node_modules
    if (url.startsWith("/vendor/pretext/")) {
      if (!vendorRoot) return send(res, 404, { error: PKG + " not installed" });
      const file = safeJoin(vendorRoot, url.slice("/vendor/pretext".length));
      if (file && (await sendFile(res, file, { cache: "public, max-age=31536000, immutable" }))) return;
      return send(res, 404, { error: "not found" });
    }

    // index gets the import map injected
    if (req.method === "GET" && (url === "/" || url.split("?")[0] === "/index.html")) {
      let html = await fsp.readFile(path.join(PUBLIC, "index.html"), "utf8");
      html = html.replace("<!--IMPORTMAP-->", importMap);
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const file = safeJoin(PUBLIC, url);
      if (file && (await sendFile(res, file))) return;
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[space] request failed", e);
    if (!res.headersSent) send(res, 500, { error: "server error" });
  }
});

/* ------------------------------------------------------------------ *
 * rooms: shared objects + live pointers
 *
 * Merge rule is per field, last write wins on a logical clock. That is
 * enough for two or three people on one board: two people editing two
 * different fields of the same card never clobber each other, and the
 * board converges without anyone holding a lock.
 * ------------------------------------------------------------------ */
const rooms = new Map();

const roomFile = (name) => path.join(ROOMS, name.replace(/[^\w-]/g, "") + ".json");

function loadRoom(name) {
  let room = rooms.get(name);
  if (room) return room;

  room = { name, objs: new Map(), clients: new Set(), dirty: false, saveT: null };
  try {
    const raw = fs.readFileSync(roomFile(name), "utf8");
    const saved = JSON.parse(raw);
    for (const rec of saved.objs || []) room.objs.set(rec.id, rec);
  } catch { /* new room */ }

  rooms.set(name, room);
  return room;
}

function persist(room) {
  room.dirty = true;
  if (room.saveT) return;
  room.saveT = setTimeout(async () => {
    room.saveT = null;
    room.dirty = false;
    const body = JSON.stringify({ objs: [...room.objs.values()] });
    await fsp.writeFile(roomFile(room.name), body).catch((e) => console.error("[space] save", e));
  }, 800);
}

/* one object record: { id, f:{field:value}, c:{field:clock}, del, t } */
function applyOp(room, op) {
  if (!op || typeof op.id !== "string") return null;
  let rec = room.objs.get(op.id);
  if (!rec) { rec = { id: op.id, f: {}, c: {}, del: false, t: 0 }; room.objs.set(op.id, rec); }

  const t = Number(op.t) || Date.now();

  if (op.del) {
    if (t >= rec.t) { rec.del = true; rec.t = t; }
    return rec;
  }

  rec.del = false;
  for (const [k, v] of Object.entries(op.f || {})) {
    if ((rec.c[k] || 0) <= t) { rec.f[k] = v; rec.c[k] = t; }
  }
  rec.t = Math.max(rec.t, t);
  return rec;
}

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const name = (url.searchParams.get("room") || "main").replace(/[^\w-]/g, "").slice(0, 40) || "main";
  const room = loadRoom(name);

  const peer = {
    ws,
    id: crypto.randomUUID().slice(0, 8),
    // a stable colour per peer, spread around the wheel
    color: `hsl(${Math.floor(Math.random() * 360)} 70% 62%)`,
    alive: true,
  };
  room.clients.add(peer);

  const tell = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const others = (obj) => {
    const msg = JSON.stringify(obj);
    for (const c of room.clients) if (c !== peer && c.ws.readyState === 1) c.ws.send(msg);
  };

  tell({
    type: "welcome",
    you: peer.id,
    color: peer.color,
    objs: [...room.objs.values()],
    peers: [...room.clients].filter((c) => c !== peer).map((c) => ({ id: c.id, color: c.color })),
  });
  others({ type: "join", id: peer.id, color: peer.color });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === "cursor") {
      // pointers are pure presence: never stored, never persisted
      others({ type: "cursor", id: peer.id, color: peer.color, x: msg.x, y: msg.y, drag: !!msg.drag });
      return;
    }

    if (msg.type === "ops" && Array.isArray(msg.ops)) {
      const applied = msg.ops.map((op) => applyOp(room, op)).filter(Boolean);
      if (!applied.length) return;
      persist(room);
      others({ type: "ops", from: peer.id, ops: applied });
      return;
    }

    if (msg.type === "pong") peer.alive = true;
  });

  ws.on("close", () => {
    room.clients.delete(peer);
    others({ type: "leave", id: peer.id });
    if (!room.clients.size && !room.dirty) {
      // keep the doc on disk, drop it from memory after a while
      setTimeout(() => { if (!room.clients.size) rooms.delete(name); }, 60_000);
    }
  });

  ws.on("error", () => { /* the close handler does the cleanup */ });
});

/* drop sockets that stopped answering, so peer lists stay honest */
setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: "ping" }));
    }
  }
}, 30_000).unref();

server.listen(PORT, () => {
  console.log(`[space] listening on :${PORT}`);
  console.log(`[space] storage ${STORAGE}`);
});
