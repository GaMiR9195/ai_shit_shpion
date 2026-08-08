/* store.js — where dropped files actually live.

   Two tiers, and the first one is not a fallback for the second:

     local  IndexedDB holds the real Blob. Survives reload, costs no
            network, has no practical size ceiling (unlike the base64
            data: URLs the board used to stuff into localStorage, which
            blew the 5MB quota after two screenshots).

     shared The same bytes POSTed to the server so the other people in
            the room can fetch them. Content addressed, so dropping the
            same file twice stores it once.

   A card stores a small reference, never the bytes:
     { ref: "idb:<hash>", url: "/api/files/<hash>", name, mime, size }
   The document therefore stays small enough to keep syncing cheaply. */
(function (g) {
  "use strict";

  const DB = "space.files";
  const STORE = "blobs";
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    }).catch((e) => { console.warn("[space] IndexedDB unavailable", e); return null; });
    return dbp;
  }

  async function tx(mode, run) {
    const db = await open();
    if (!db) return null;
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const out = run(t.objectStore(STORE));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  async function hash(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (crypto.subtle) {
      const d = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    // no subtle crypto on plain http origins: fall back to a content key
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i += 977) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
    return (h.toString(16) + "-" + bytes.length.toString(16)).padStart(8, "0");
  }

  const urls = new Map();   // id -> object URL, so one blob makes one URL

  /* keep a file locally and hand back a reference the document can hold */
  async function put(file) {
    const id = await hash(file);
    const rec = {
      id,
      blob: file instanceof Blob ? file : new Blob([file]),
      name: file.name || "file",
      mime: file.type || "application/octet-stream",
      size: file.size || 0,
      at: Date.now(),
    };
    await tx("readwrite", (s) => s.put(rec)).catch(() => null);
    urls.set(id, URL.createObjectURL(rec.blob));
    return { ref: "idb:" + id, id, name: rec.name, mime: rec.mime, size: rec.size, url: urls.get(id) };
  }

  async function get(id) {
    return tx("readonly", (s) => s.get(id)).catch(() => null);
  }

  /* resolve a card's reference into something an <img>/<video> can use */
  async function url(ref, remote) {
    if (!ref) return remote || "";
    const id = String(ref).replace(/^idb:/, "");
    if (urls.has(id)) return urls.get(id);

    const rec = await get(id);
    if (rec && rec.blob) {
      const u = URL.createObjectURL(rec.blob);
      urls.set(id, u);
      return u;
    }

    // someone else's file: pull it from the room and keep a local copy
    if (remote) {
      try {
        const r = await fetch(remote);
        if (r.ok) {
          const blob = await r.blob();
          await tx("readwrite", (s) => s.put({ id, blob, name: id, mime: blob.type, size: blob.size, at: Date.now() }));
          const u = URL.createObjectURL(blob);
          urls.set(id, u);
          return u;
        }
      } catch { /* offline, or the server has no copy */ }
      return remote;
    }
    return "";
  }

  /* push the bytes to the room so the other people can see the card */
  async function share(ref) {
    const id = String(ref || "").replace(/^idb:/, "");
    const rec = await get(id);
    if (!rec) return null;
    try {
      const r = await fetch("/api/files", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(rec.name).replace(/%20/g, " "),
          "x-file-type": rec.mime || "application/octet-stream",
        },
        body: rec.blob,
      });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  /* the raw bytes behind a reference, for zipping and extracting.
     The local Blob is preferred: no network, no CORS, no re-fetch. */
  async function bytes(ref, remote) {
    const id = String(ref || "").replace(/^idb:/, "");
    const rec = id ? await get(id) : null;
    if (rec && rec.blob) return new Uint8Array(await rec.blob.arrayBuffer());
    const href = await url(ref, remote);
    if (!href) return null;
    try {
      const r = await fetch(href);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    } catch { return null; }
  }

  /* keep bytes we produced ourselves (a zip, an extracted entry) under the
     same content-addressed scheme a dropped file gets */
  async function putBytes(data, name, mime) {
    const blob = new Blob([data], { type: mime || "application/octet-stream" });
    blob.name = name;
    const rec = await put(new File([blob], name || "file", { type: blob.type }));
    return rec;
  }

  async function download(ref, remote, name) {
    const href = await url(ref, remote);
    if (!href) return false;
    const a = document.createElement("a");
    a.href = href;
    a.download = name || "file";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  /* rough tally, for the storage line in the board menu */
  async function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try { return await navigator.storage.estimate(); } catch { return null; }
  }

  g.Store = { put, putBytes, get, url, bytes, share, download, usage };
})(window);
