/* net.js — the room.

   One WebSocket per board. It carries two very different kinds of
   traffic and treats them differently on purpose:

     cursors  fire-and-forget, rate limited to one frame, never stored.
              If a packet is lost the next one fixes it 40ms later.

     ops      per-field last-write-wins on a logical clock. Sending
              { id, f:{x:120}, c:{x:8} } means "object id's x is 120 as
              of tick 8"; the receiver keeps its value if it already
              has a newer clock for that field. Two people dragging
              different cards never conflict, and two people dragging
              the same card converge instead of fighting.

   No nicknames, no avatars, no presence list UI: a coloured pointer and
   a soft outline, which is all a three person team needs. */
(function (g) {
  "use strict";

  const CURSOR_MS = 40;
  const OP_MS = 55;

  let ws = null;
  let room = "main";
  let me = null;
  let myColor = "#c2703f";
  let clock = 1;
  let retry = 0;
  let alive = false;
  let closed = false;

  const peers = new Map();       // id -> { color, el, x, y, drag, seen }
  const clocks = new Map();      // objId -> { field: clock }
  let outbox = new Map();        // objId -> op, coalesced between flushes
  let cursorPending = null;
  let cursorAt = 0;
  let flushAt = 0;

  let layer = null;
  const hooks = { ops: null, hello: null, status: null };

  function url() {
    const p = location.protocol === "https:" ? "wss:" : "ws:";
    return p + "//" + location.host + "/ws?room=" + encodeURIComponent(room);
  }

  function connect(opts) {
    opts = opts || {};
    room = opts.room || roomFromUrl();
    layer = opts.layer || document.getElementById("cursors");
    hooks.ops = opts.onOps || null;
    hooks.hello = opts.onHello || null;
    hooks.status = opts.onStatus || null;
    closed = false;
    openSocket();
  }

  function roomFromUrl() {
    const q = new URLSearchParams(location.search).get("room");
    if (q) return q;
    const h = location.hash.replace(/^#/, "");
    return h || "main";
  }

  function openSocket() {
    if (closed) return;
    try { ws = new WebSocket(url()); } catch { schedule(); return; }

    ws.onopen = () => {
      retry = 0;
      alive = true;
      status("online");
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      if (m.type === "welcome") {
        me = m.you;
        myColor = m.color || myColor;
        (m.peers || []).forEach((p) => ensurePeer(p.id, p.color));
        if (hooks.hello) hooks.hello(m.objs || {}, { id: me, color: myColor });
        return;
      }
      if (m.type === "join") { ensurePeer(m.id, m.color); return; }
      if (m.type === "leave") { dropPeer(m.id); return; }
      if (m.type === "cursor") { movePeer(m); return; }
      if (m.type === "ops") { if (hooks.ops) hooks.ops(m.ops || [], m.from); return; }
      if (m.type === "ping") { send({ type: "pong" }); return; }
    };

    ws.onclose = () => { alive = false; status("offline"); schedule(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function schedule() {
    if (closed) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(openSocket, [400, 800, 1500, 3000, 5000, 8000, 12000][retry]);
  }

  const status = (s) => { if (hooks.status) hooks.status(s); };

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  /* ---- peer pointers ---- */

  function ensurePeer(id, color) {
    if (!id || id === me || peers.has(id)) return;
    const el = document.createElement("div");
    el.className = "peer";
    el.style.setProperty("--peer", color || "#888");
    el.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">' +
      '<path d="M3 2l12 6.2-5.1 1.3-1.6 5z"/></svg>';
    if (layer) layer.appendChild(el);
    peers.set(id, { color, el, x: 0, y: 0, drag: false, seen: performance.now() });
  }

  function dropPeer(id) {
    const p = peers.get(id);
    if (!p) return;
    if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
    peers.delete(id);
  }

  function movePeer(m) {
    ensurePeer(m.id, m.color);
    const p = peers.get(m.id);
    if (!p) return;
    p.x = m.x; p.y = m.y; p.drag = !!m.drag;
    p.seen = performance.now();
  }

  /* peers are stored in world coords, so they stay glued to the board
     while you pan and zoom. Called from the board's own frame loop. */
  function paint(toScreen) {
    if (!peers.size || !toScreen) return;
    for (const [, p] of peers) {
      const s = toScreen(p.x, p.y);
      p.el.style.transform = "translate3d(" + s.x + "px," + s.y + "px,0)";
      p.el.classList.toggle("drag", p.drag);
    }
  }

  /* ---- outgoing ---- */

  function cursor(x, y, drag) {
    cursorPending = { type: "cursor", x, y, drag: !!drag };
    const now = performance.now();
    if (now - cursorAt >= CURSOR_MS) {
      cursorAt = now;
      send(cursorPending);
      cursorPending = null;
    }
  }

  /* Logical clock, seeded from the wall clock.

     It used to start at 1 in every tab, while the server keeps whatever
     clock it last saw. So after a reload your own edits arrived "older"
     than the values already on the server and were silently dropped — the
     board looked like it had stopped syncing. Starting from Date.now()
     keeps it monotonic across sessions and still strictly increasing
     within one. */
  const tick = () => { clock = Math.max(Date.now(), clock + 1); return clock; };

  /* queue a change to one object. fields is a plain { key: value } */
  function push(id, fields, del) {
    if (!id || !fields) return;
    const t = tick();
    const prev = outbox.get(id) || { id, f: {}, c: {}, t };
    for (const k of Object.keys(fields)) {
      prev.f[k] = fields[k];
      prev.c[k] = t;
    }
    if (del) prev.del = true;
    prev.t = t;
    outbox.set(id, prev);
  }

  const remove = (id) => push(id, { _: 1 }, true);

  function flush(force) {
    const now = performance.now();
    if (!force && now - flushAt < OP_MS) return;
    flushAt = now;

    if (cursorPending) { send(cursorPending); cursorPending = null; cursorAt = now; }
    if (!outbox.size) return;

    const ops = [...outbox.values()];
    if (send({ type: "ops", ops })) outbox = new Map();
  }

  /* apply an incoming op to a local object, honouring the clock */
  function merge(target, op) {
    if (!target || !op || !op.f) return false;
    let rec = clocks.get(op.id);
    if (!rec) { rec = {}; clocks.set(op.id, rec); }

    let touched = false;
    for (const k of Object.keys(op.f)) {
      if (k === "_") continue;
      const t = (op.c && op.c[k]) || op.t || 0;
      if ((rec[k] || 0) > t) continue;      // we already have something newer
      rec[k] = t;
      if (target[k] !== op.f[k]) { target[k] = op.f[k]; touched = true; }
    }
    // keep our own clock ahead of anything we have seen
    if (op.t && op.t >= clock) clock = op.t + 1;
    return touched;
  }

  function disconnect() {
    closed = true;
    if (ws) { try { ws.close(); } catch {} }
    for (const id of [...peers.keys()]) dropPeer(id);
  }

  const online = () => !!ws && ws.readyState === 1;

  g.Net = { connect, disconnect, cursor, push, remove, flush, merge, paint, online,
            get id() { return me; }, get color() { return myColor; }, get room() { return room; },
            peers };
})(window);
