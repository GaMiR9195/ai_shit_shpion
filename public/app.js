/* app.js — infinite board. Everything is local-first and stored in one
   serialisable document, so a network layer can be dropped in later:
   Sync.push(doc) is called after every committed change. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const app = $("#app"), world = $("#world"), layer = $("#layer"),
    ink = $("#ink"), inkBody = $("#inkbody"), inkHandles = $("#inkhandles"),
    gridEl = $("#grid"), scratch = $("#scratch"), menuEl = $("#menu"),
    modeEl = $("#mode"), toastEl = $("#toast"),
    anchorA = $("#anchor"), anchorB = $("#anchor2");
  const sctx = scratch.getContext("2d");
  const SVGNS = "http://www.w3.org/2000/svg";

  const CELL = 24;          // background minor grid
  const SNAP = 12;          // drag snap: organised, still precise
  const MAJOR = 5;          // major line every 5 cells
  /* ten muted inks — enough range without turning the board into a paint box */
  const PALETTE = [
    "#e9e7e4", "#9c9c9c", "#6a6a6a", "#c2703f", "#b58b4c",
    "#8a9a5b", "#6f9a8d", "#6d8299", "#8d7fa8", "#a8626b",
  ];

  /* ------------------------------------------------------------------ *
   * document + storage
   * ------------------------------------------------------------------ */
  const KEY = "space.doc.v1";
  /* The room bridge. Local storage is still the source of truth for this
     tab; this mirrors changes to everyone else, per field, so two people
     editing different cards never collide and two people editing the same
     card converge instead of fighting. */
  const Sync = {
    on: false,

    // called after every local commit; the doc is already saved by now
    push(d) { void d; if (Sync.on) Net.flush(); },

    // one card changed: send its fields, never the whole document
    obj(o) {
      if (!Sync.on || !o || !o.id) return;
      const f = {};
      for (const k of Object.keys(o)) if (k[0] !== "_") f[k] = o[k];
      Net.push(o.id, f);
    },
    del(id) { if (Sync.on) Net.remove(id); },

    start() {
      if (Sync.on || typeof Net === "undefined") return;
      Sync.on = true;
      Net.connect({
        onHello(objs) {
          const list = Object.values(objs || {});
          // empty room: we are the first one in, so publish what we have
          if (!list.length) {
            for (const o of doc.objs) Sync.obj(o);
            Net.flush(true);
            return;
          }
          let dirty = false;
          for (const rec of list) if (applyOp(rec)) dirty = true;
          if (dirty) { render(); kick(); }
        },
        onOps(ops) {
          let dirty = false;
          for (const op of ops) if (applyOp(op)) dirty = true;
          if (dirty) { render(); kick(); save(); }
        },
      });
    },
  };

  /* merge one incoming record into the local document */
  function applyOp(op) {
    if (!op || !op.id) return false;

    if (op.del) {
      const i = doc.objs.findIndex((o) => o.id === op.id);
      if (i < 0) return false;
      doc.objs.splice(i, 1);
      const el = nodes.get(op.id);
      if (el) { el.remove(); nodes.delete(op.id); }
      selected.delete(op.id);
      return true;
    }

    let o = doc.objs.find((x) => x.id === op.id);
    if (!o) {
      o = { id: op.id };
      Net.merge(o, op);
      if (!o.type) return false;          // half a record, wait for the rest
      doc.objs.push(o);
      sync(o);
      return true;
    }
    const changed = Net.merge(o, op);
    if (changed) { o._x = o.x; o._y = o.y; o._w = o.w; o._h = o.h; }
    return changed;
  }

  const blank = () => ({ v: 1, cam: { x: 0, y: 0, z: 1 }, seq: 1, objs: [] });
  let doc = blank();
  let undoStack = [], redoStack = [];
  /* `_`-prefixed keys are display state and never persist. A blob: URL is
     throwaway too — it dies with the tab — so it is dropped whenever the
     card has a durable reference to rebuild it from. */
  const clean = (d) => JSON.stringify(d, function (k, v) {
    if (k[0] === "_") return undefined;
    if (k === "src" && typeof v === "string" && v.slice(0, 5) === "blob:" && this && this.ref) return undefined;
    return v;
  });

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.objs)) doc = Object.assign(blank(), d);
      }
    } catch (e) { console.warn("load failed", e); }
    doc.objs.forEach(sync);
  }
  /* display state mirrors the logical state; springs interpolate between them */
  function sync(o) {
    if (o.type === "link" && o.bow && !o.mid) { o.mid = [{ t: 0.5, o: o.bow }]; delete o.bow; }
    o._x = o.x; o._y = o.y; o._w = o.w; o._h = o.h;
    o._vx = 0; o._vy = 0; o._vw = 0; o._vh = 0;
    o._lift = 0; o._liftT = 0; o._vl = 0;
  }
  let saveT = 0;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { localStorage.setItem(KEY, clean(doc)); }
      catch (e) { toast("storage full — change not saved"); }
      Sync.push(doc);
    }, 180);
  }
  function snapshot() {
    undoStack.push(clean(doc));
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
  }

  /* undo keeps the DOM alive: nodes are reused, so anything the user had
     scrolled stays exactly where it was scrolled to */
  function restore(json) {
    const keep = [...selected];
    const scrolls = new Map();
    nodes.forEach((el, id) => {
      const s = [];
      el.querySelectorAll(".body,.view,textarea").forEach((n) => s.push(n.scrollTop));
      scrolls.set(id, s);
    });
    /* Objects that survive an undo keep their identity: the same instance is
       refilled with the old values. The document object is kept too. Nothing
       downstream (event handlers, the DOM, scroll offsets) is invalidated,
       and the display springs simply glide to the restored geometry. */
    const past = JSON.parse(json);
    const old = new Map(doc.objs.map((o) => [o.id, o]));
    doc.v = past.v; doc.seq = past.seq;
    doc.cam.x = past.cam.x; doc.cam.y = past.cam.y; doc.cam.z = past.cam.z;
    syncCam();
    doc.objs = past.objs.map((n) => {
      const ex = old.get(n.id);
      if (!ex) { sync(n); return n; }
      for (const k of Object.keys(ex)) if (k[0] !== "_" && !(k in n)) delete ex[k];
      Object.assign(ex, n);
      if (ex._x == null) sync(ex);
      return ex;
    });
    for (const [id, el] of [...nodes]) {
      const o = doc.objs.find((x) => x.id === id);
      if (!o || !isBox(o) || el.dataset.type !== o.type) { el.remove(); nodes.delete(id); }
    }
    setSelection(keep.filter((id) => doc.objs.some((o) => o.id === id)), true);
    render();
    kick();
    nodes.forEach((el, id) => {
      const s = scrolls.get(id); if (!s) return;
      el.querySelectorAll(".body,.view,textarea").forEach((n, i) => { if (s[i] != null) n.scrollTop = s[i]; });
    });
    save();
  }
  const undo = () => { if (!undoStack.length) return; redoStack.push(clean(doc)); restore(undoStack.pop()); };
  const redo = () => { if (!redoStack.length) return; undoStack.push(clean(doc)); restore(redoStack.pop()); };

  const uid = () => "o" + (doc.seq++).toString(36) + Math.random().toString(36).slice(2, 5);
  const byId = (id) => doc.objs.find((o) => o.id === id);
  const isBox = (o) => ["note", "sketch", "code", "image", "video", "file", "shelf", "web"].includes(o.type);
  const rectOf = (o) => (isBox(o)
    ? { x: o._x == null ? o.x : o._x, y: o._y == null ? o.y : o._y, w: o._w == null ? o.w : o._w, h: o._h == null ? o.h : o._h }
    : o.type === "rect" || o.type === "ellipse" ? { x: o.x, y: o.y, w: o.w, h: o.h } : null);

  /* ------------------------------------------------------------------ *
   * camera — the view has a target and eases towards it, so zoom glides
   * ------------------------------------------------------------------ */
  const cam = () => doc.cam;
  const camT = { x: 0, y: 0, z: 1 };
  const syncCam = () => { const c = cam(); camT.x = c.x; camT.y = c.y; camT.z = c.z; };
  function toWorld(sx, sy) { const c = cam(); return { x: (sx - c.x) / c.z, y: (sy - c.y) / c.z }; }
  function toScreen(wx, wy) { const c = cam(); return { x: wx * c.z + c.x, y: wy * c.z + c.y }; }

  function applyCam() {
    const c = cam();
    /* The whole board is quantised to whole device pixels here, in one
       place, instead of card by card. Rounding each card separately meant
       neighbouring cards landed on different lattices as the camera moved,
       which is what made text creep and shiver while panning. */
    const dp = devicePixelRatio || 1;
    const tx = Math.round(c.x * dp) / dp, ty = Math.round(c.y * dp) / dp;
    world.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${c.z})`;
    const m = CELL * c.z, M = m * MAJOR;
    const ox = ((c.x % M) + M) % M, oy = ((c.y % M) + M) % M;
    const mx = ((c.x % m) + m) % m, my = ((c.y % m) + m) % m;
    gridEl.style.backgroundSize = `${M}px ${M}px,${M}px ${M}px,${m}px ${m}px,${m}px ${m}px`;
    gridEl.style.backgroundPosition = `${ox}px ${oy}px,${ox}px ${oy}px,${mx}px ${my}px,${mx}px ${my}px`;
    gridEl.style.opacity = c.z < 0.45 ? 0.35 : 1;
    drawHandles();
  }

  function camStep(dt) {
    const c = cam();
    const k = 1 - Math.exp(-dt * 21);
    let moved = false;
    for (const a of ["x", "y", "z"]) {
      const d = camT[a] - c[a];
      const eps = a === "z" ? 0.0004 : 0.04;
      if (Math.abs(d) > eps) { c[a] += d * k; moved = true; }
      else if (c[a] !== camT[a]) { c[a] = camT[a]; moved = true; }
    }
    if (moved) { applyCam(); doc.objs.forEach((o) => { if (isBox(o)) place(o); }); }
    return moved;
  }

  function fitScratch() {
    scratch.width = innerWidth * devicePixelRatio;
    scratch.height = innerHeight * devicePixelRatio;
    scratch.style.width = innerWidth + "px";
    scratch.style.height = innerHeight + "px";
    sctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  /* ------------------------------------------------------------------ *
   * eased motion — logical position is snapped, display position chases it
   * ------------------------------------------------------------------ */
  /* critically damped spring, tuned tight: a snap glides rather than steps,
     but it lands quickly enough to feel like a physical object. */
  const STIFF = 720, DAMP = 2 * Math.sqrt(720) * 1.0;
  let animOn = false, lastT = 0;
  function kick() { if (!animOn) { animOn = true; lastT = performance.now(); requestAnimationFrame(tick); } }

  function axis(o, k, dt) {
    const c = "_" + k, v = "_v" + k;
    if (o[c] == null) o[c] = o[k];
    if (o[v] == null) o[v] = 0;
    const d = o[k] - o[c];
    if (Math.abs(d) < 0.02 && Math.abs(o[v]) < 0.05) {
      if (o[c] !== o[k]) { o[c] = o[k]; o[v] = 0; return true; }
      o[v] = 0; return false;
    }
    o[v] += (STIFF * d - DAMP * o[v]) * dt;
    o[c] += o[v] * dt;
    return true;
  }

  /* the "carried" spring: a picked-up card floats a hair above the board */
  function liftStep(o, dt) {
    const t = o._liftT || 0;
    if (o._lift == null) o._lift = 0;
    if (o._vl == null) o._vl = 0;
    const d = t - o._lift;
    if (Math.abs(d) < 0.0006 && Math.abs(o._vl) < 0.004) {
      if (o._lift !== t) { o._lift = t; o._vl = 0; return true; }
      o._vl = 0; return false;
    }
    o._vl += (STIFF * d - DAMP * o._vl) * dt;
    o._lift += o._vl * dt;
    return true;
  }

  function tick(now) {
    const t = now || performance.now();
    const dt = Math.min(0.034, Math.max(0.001, (t - lastT) / 1000));
    lastT = t;
    let busy = camStep(dt);
    for (const o of doc.objs) {
      if (!isBox(o)) continue;
      let m = false;
      if (axis(o, "x", dt)) m = true;
      if (axis(o, "y", dt)) m = true;
      if (axis(o, "w", dt)) m = true;
      if (axis(o, "h", dt)) m = true;
      if (liftStep(o, dt)) m = true;
      if (m) { place(o); if (o.type === "sketch") redrawSketch(o); busy = true; }
    }
    if (busy) { drawVectors(); drawBlobs(); }
    animOn = busy;
    if (busy) requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------ *
   * DOM objects
   * ------------------------------------------------------------------ */
  const nodes = new Map();
  const selected = new Set();
  let selection = null;               // primary, the one that shows handles

  /* positions are quantised to whole device pixels so glyphs stay on the
     pixel grid — no resampled, blurry text while an object glides */
  function place(o) {
    const el = nodes.get(o.id);
    if (!el) return;
    // Cards keep their exact world coordinates. Pixel snapping happens once,
    // on the world transform in applyCam, so nothing shifts relative to
    // anything else and text stays put while the board moves.
    const px = (v) => (v == null ? 0 : v);
    const x = px(o._x == null ? o.x : o._x), y = px(o._y == null ? o.y : o._y);
    const lift = o._lift || 0;
    el.style.transform = lift > 0.002
      ? `translate(${x}px,${y}px) scale(${1 + lift * 0.02})`
      : `translate(${x}px,${y}px)`;
    el.style.width = px(o._w == null ? o.w : o._w) + "px";
    el.style.height = px(o._h == null ? o.h : o._h) + "px";
    el.style.boxShadow = lift > 0.002
      ? `0 ${(1 + lift * 3).toFixed(2)}px ${(2 + lift * 6).toFixed(2)}px rgba(0,0,0,.42),` +
        `0 ${(8 + lift * 18).toFixed(2)}px ${(24 + lift * 26).toFixed(2)}px rgba(0,0,0,${(0.28 + lift * 0.16).toFixed(3)})`
      : "";
  }

  function applySel() {
    nodes.forEach((el, k) => el.classList.toggle("sel", selected.has(k)));
    drawVectors();
  }
  function setSelection(ids, quiet) {
    selected.clear();
    ids.forEach((i) => selected.add(i));
    selection = ids.length ? ids[ids.length - 1] : null;
    if (!quiet) applySel();
  }
  function select(id, additive) {
    if (additive && id) {
      if (selected.has(id)) { selected.delete(id); if (selection === id) selection = [...selected].pop() || null; }
      else { selected.add(id); selection = id; }
    } else {
      if (selected.size === 1 && selection === id) return;
      selected.clear();
      if (id) selected.add(id);
      selection = id || null;
    }
    applySel();
  }

  function front(o) {
    const i = doc.objs.indexOf(o);
    if (i >= 0 && i !== doc.objs.length - 1) {
      doc.objs.splice(i, 1); doc.objs.push(o);
      const el = nodes.get(o.id); if (el) layer.appendChild(el);
    }
  }

  const btn = (label, on) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (on) b.classList.add("on");
    return b;
  };

  function makeRail(o) {
    const rail = document.createElement("div");
    rail.className = "rail";
    const div = () => { const d = document.createElement("span"); d.className = "div"; rail.appendChild(d); };

    if (o.type === "note") {
      [["S", 12], ["M", 13.5], ["L", 16]].forEach(([lab, size]) => {
        const b = btn(lab, (o.size || 13.5) === size);
        b.onclick = () => { snapshot(); o.size = size; paint(o); save(); rebuildRail(o); };
        rail.appendChild(b);
      });
      div();
      const m = btn("Mono", !!o.mono);
      m.onclick = () => { snapshot(); o.mono = !o.mono; paint(o); save(); rebuildRail(o); };
      rail.appendChild(m);
    }

    if (o.type === "sketch") {
      // colours + weight live inside the pad itself; the rail only clears
      const c = btn("Clear");
      c.onclick = () => { snapshot(); o.strokes = []; paint(o); save(); };
      rail.append(c);
    }

    if (o.type === "code") {
      /* The language tag. This is not a dropdown and deliberately so:
         there are only ever four or five characters to type, which is
         less work than opening a menu and hunting for a row.

         It looks like a button and behaves like a caret. Clicking it
         selects the current value so your first keystroke replaces it,
         exactly like typing `py` after a fence. Nothing animates, no
         panel opens, the background never changes, and there is no
         focus ring — the only thing that happens is a caret appears. */
      const lang = document.createElement("span");
      lang.className = "lang";
      lang.contentEditable = "true";
      lang.spellcheck = false;
      lang.textContent = o.lang || "txt";

      const clip = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9+#]/g, "").slice(0, 5);
      const mark = () => {
        const v = clip(lang.textContent);
        // unknown tags are still accepted, just tinted so you can see it
        lang.classList.toggle("bad", !!v && !HL.has(v));
      };

      const commit = () => {
        const v = clip(lang.textContent) || "txt";
        lang.textContent = v;
        mark();
        if ((o.lang || "txt") === v) return;
        snapshot();
        o.lang = v;
        // a math card has nothing to highlight, so it opens typeset
        if (MD.isMathLang(v) && !o.md) o.md = true;
        paint(o);
        save();
        Sync.obj(o);
      };

      lang.addEventListener("pointerdown", (e) => e.stopPropagation());
      lang.addEventListener("click", (e) => {
        e.stopPropagation();
        const r = document.createRange(); r.selectNodeContents(lang);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      });
      // never let it become multi-line; it is a tag, not a field
      lang.addEventListener("beforeinput", (e) => {
        if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") e.preventDefault();
      });
      lang.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); lang.blur(); return; }
        if (e.key === "Escape") { lang.textContent = o.lang || "txt"; lang.blur(); return; }
        // hard five-character cap
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey &&
            String(lang.textContent).length >= 5 && getSelection().isCollapsed) e.preventDefault();
      });
      lang.addEventListener("input", () => {
        const v = String(lang.textContent || "");
        if (v.length > 5) lang.textContent = v.slice(0, 5);
        mark();
      });
      lang.addEventListener("blur", commit);
      mark();
      rail.appendChild(lang);
      div();
      const md = btn("Markdown", !!o.md);
      md.onclick = () => { snapshot(); o.md = !o.md; paint(o); save(); rebuildRail(o); };
      const wrap = btn("Wrap", !!o.wrap);
      wrap.onclick = () => { o.wrap = !o.wrap; paint(o); save(); rebuildRail(o); };
      const cp = btn("Copy");
      cp.onclick = () => copyObject(o);
      rail.append(md, wrap, cp);
    }

    if (o.type === "image") {
      const n = btn("Reset");
      n.onclick = () => naturalSize(o);
      rail.append(n);
    }

    if (o.type === "video") {
      const el = nodes.get(o.id);
      const v = el && el.querySelector("video");
      if (v) {
        const p = btn(v.paused ? "Play" : "Pause");
        p.onclick = () => { v.paused ? v.play() : v.pause(); rebuildRail(o); };
        rail.appendChild(p);
      }
      const ff = btn(o.fit === "contain" ? "Fit" : "Fill");
      ff.onclick = () => { o.fit = o.fit === "contain" ? "cover" : "contain"; paint(o); save(); rebuildRail(o); };
      rail.appendChild(ff);
      const lp = btn("Loop", !!o.loop);
      lp.onclick = () => { snapshot(); o.loop = !o.loop; paint(o); save(); rebuildRail(o); };
      const mu = btn("Mute", o.muted !== false);
      mu.onclick = () => { snapshot(); o.muted = o.muted === false; paint(o); save(); rebuildRail(o); };
      const ct = btn("Bar", o.controls !== false);
      ct.onclick = () => { snapshot(); o.controls = o.controls === false; paint(o); save(); rebuildRail(o); };
      rail.append(lp, mu, ct);
    }

    if (o.type === "file") {
      const c = btn("Copy");
      c.onclick = () => copyObject(o);
      rail.append(c);
      if (o.src) {
        const d = btn("Save");
        d.onclick = () => saveFile(o);
        rail.append(d);
      }
    }

    rail.addEventListener("pointerdown", (e) => e.stopPropagation());
    rail.addEventListener("contextmenu", (e) => e.stopPropagation());
    return rail;
  }

  function rebuildRail(o) {
    const el = nodes.get(o.id); if (!el) return;
    const old = el.querySelector(":scope > .rail");
    const rail = makeRail(o);
    if (old) el.replaceChild(rail, old); else el.appendChild(rail);
  }

  /* Pointer near an edge = resize, anywhere else = carry. No gizmos.

     The band used to be 8px, which is a coin flip to hit. 14 is
     comfortable, and corners get a noticeably bigger square so diagonal
     resize is easy to grab on purpose rather than by accident. Both are
     clamped against the card's own size, so a small note does not become
     all edge and nothing to drag. */
  const EDGE = 14;
  const CORNER = 22;
  const CURSOR = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
  function edgeAt(el, e) {
    const r = el.getBoundingClientRect();
    // the grab band never eats more than a third of the card
    const bx = Math.min(EDGE, r.width / 3), by = Math.min(EDGE, r.height / 3);
    const kx = Math.min(CORNER, r.width / 2.5), ky = Math.min(CORNER, r.height / 2.5);

    const dl = e.clientX - r.left, dr = r.right - e.clientX;
    const dt = e.clientY - r.top, db = r.bottom - e.clientY;

    // corners are tested first, against the larger square, so they win
    const cv = dt < ky ? "n" : db < ky ? "s" : "";
    const ch = dl < kx ? "w" : dr < kx ? "e" : "";
    if (cv && ch) return cv + ch;

    const v = dt < by ? "n" : db < by ? "s" : "";
    const h = dl < bx ? "w" : dr < bx ? "e" : "";
    return v + h;
  }

  /* Double-click to rename, in place. The text simply becomes editable
     where it already sits: Enter commits, Escape reverts, and the file
     extension is left out of the initial selection because the stem is
     the part you actually retype. No dialog, no field chrome. */
  function renameOn(node, get, set, clear) {
    node.addEventListener("pointerdown", (e) => { if (node.isContentEditable) e.stopPropagation(); });
    node.addEventListener("dblclick", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (node.isContentEditable) return;

      const was = get();
      node.contentEditable = "true";
      node.spellcheck = false;
      node.textContent = was;
      node.focus();

      const t = node.firstChild;
      const dot = was.lastIndexOf(".");
      const r = document.createRange();
      if (dot > 0 && t && t.nodeType === 3) { r.setStart(t, 0); r.setEnd(t, dot); }
      else r.selectNodeContents(node);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);

      const stop = () => {
        node.contentEditable = "false";
        node.removeEventListener("keydown", key);
        node.removeEventListener("blur", done);
      };
      const done = () => {
        const v = String(node.textContent || "").replace(/[\r\n]/g, "").trim();
        stop();
        if (v && v !== was) set(v); else node.textContent = was;
      };
      const key = (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") { ev.preventDefault(); node.blur(); }
        if (ev.key === "Escape") { ev.preventDefault(); node.textContent = was; stop(); node.blur(); }
        /* One backspace past the last character takes the name row away
           entirely, the same way it would delete any other empty thing.
           Rename from the menu brings it back. */
        if (ev.key === "Backspace" && clear && !String(node.textContent || "").length) {
          ev.preventDefault();
          stop();
          node.blur();
          clear();
        }
      };
      node.addEventListener("keydown", key);
      node.addEventListener("blur", done);
    });
  }

  /* repaint the colour layer sitting under a code card's textarea */
  function paintHL(o) {
    const node = nodes.get(o.id); if (!node) return;
    const hl = node.querySelector(".hlbg"), ta = node.querySelector("textarea");
    if (!hl || !ta) return;
    hl.innerHTML = HL.highlight(ta.value, o.lang || "txt");
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  }

  function build(o) {
    const el = document.createElement("div");
    el.className = "obj " + (o.type === "image" || o.type === "video" ? "media " : "") + o.type;
    el.dataset.id = o.id;
    el.dataset.type = o.type;

    const body = document.createElement("div");
    body.className = "inner";
    el.appendChild(body);
    el.appendChild(makeRail(o));

    layer.appendChild(el);
    nodes.set(o.id, el);

    /* content */
    if (o.type === "note") {
      /* A sticky note is text, and nothing else. No name row above it and
         no placeholder glyphs inside it — it is the plainest card on the
         board, so it gets the plainest treatment: an empty note is simply
         empty. Names belong to code cards and files, which are things you
         download by name. */
      const b = document.createElement("div");
      b.className = "body"; b.contentEditable = "true"; b.spellcheck = false; b.textContent = o.body || "";
      const commit = () => { o.body = b.innerText.replace(/\n$/, ""); save(); };
      b.addEventListener("input", commit);
      [b].forEach((n) => {
        n.addEventListener("focus", () => el.classList.add("focus"));
        n.addEventListener("blur", () => el.classList.remove("focus"));
        n.addEventListener("keydown", (e) => e.stopPropagation());
        n.addEventListener("paste", (e) => {
          e.preventDefault();
          const txt = (e.clipboardData || window.clipboardData).getData("text/plain");
          document.execCommand("insertText", false, txt);
        });
      });
      body.append(b);
    }

    if (o.type === "sketch") {
      /* The canvas now lives inside a plain block and is absolutely
         positioned to fill it (.sketch .pad / .sketch canvas).

         A canvas in normal flow reports its bitmap as its intrinsic size,
         so resizing the bitmap re-ran layout, which resized the bitmap
         again. That feedback loop is exactly why the ink and the colour
         strip crawled further down every second you held a resize handle.
         Absolutely positioned, it cannot influence layout at all. */
      const pad = document.createElement("div");
      pad.className = "pad";
      const cv = document.createElement("canvas");
      pad.appendChild(cv);

      const pal = document.createElement("div");
      pal.className = "pal";
      pal.addEventListener("pointerdown", (e) => e.stopPropagation());
      body.append(pad, pal);
      buildPal(o, pal);
      bindSketch(o, cv);

      // the pad's real size is only known after layout: redraw when it lands,
      // which is what makes a reloaded sketch look right without a click
      if (window.ResizeObserver) new ResizeObserver(() => redrawSketch(o)).observe(pad);
    }

    if (o.type === "code") {
      const name = document.createElement("div");
      name.className = "fname"; name.hidden = true;
      const pad = document.createElement("div");
      pad.className = "pad";

      /* Highlighting is an overlay, not a rich-text rewrite of the field.
         A <pre> sits underneath a fully transparent textarea and renders
         the same characters at the same metrics, so the caret, the native
         selection and the browser's own undo all keep working, and the
         colours simply land underneath. Focusing it changes nothing
         visible: no border, no background plate, no ring. */
      const hl = document.createElement("pre");
      hl.className = "hlbg";
      hl.setAttribute("aria-hidden", "true");

      const ta = document.createElement("textarea");
      ta.spellcheck = false; ta.value = o.src || ""; ta.placeholder = "…";
      const view = document.createElement("div");
      view.className = "view"; view.hidden = true;
      pad.append(hl, ta, view);
      body.append(name, pad);

      // keep the two layers locked together while scrolling
      ta.addEventListener("scroll", () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; }, { passive: true });

      // double-click the filename to rename it, in place
      renameOn(name, () => o.name || "", (v) => { snapshot(); o.name = v; paint(o); save(); Sync.obj(o); },
        () => { snapshot(); o.name = ""; paint(o); save(); Sync.obj(o); });

      ta.addEventListener("input", () => { o.src = ta.value; paintHL(o); save(); });
      ta.addEventListener("focus", () => el.classList.add("focus"));
      ta.addEventListener("blur", () => { el.classList.remove("focus"); if (o.md) paint(o); });
      ta.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Tab") {
          e.preventDefault();
          const s = ta.selectionStart, en = ta.selectionEnd;
          ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(en);
          ta.selectionStart = ta.selectionEnd = s + 2;
          o.src = ta.value; save();
        }
        if (e.key === "Escape") ta.blur();
      });
      // markdown preview: click to go back to the untouched source
      view.addEventListener("click", (e) => {
        if (e.target.tagName === "A") return;
        view.hidden = true; ta.hidden = false; ta.focus();
      });
    }

    if (o.type === "image") {
      const img = document.createElement("img");
      img.draggable = false;
      body.appendChild(img);
      body.style.position = "relative";
    }

    if (o.type === "video") body.style.position = "relative";

    if (o.type === "file") {
      const ic = document.createElementNS(SVGNS, "svg");
      ic.setAttribute("viewBox", "0 0 24 24");
      const fn = document.createElement("div"); fn.className = "fn";
      const mt = document.createElement("div"); mt.className = "meta";
      body.append(ic, fn, mt);
      renameOn(fn, () => o.name || "file", (v) => { snapshot(); o.name = v; paint(o); save(); Sync.obj(o); });
      // double-clicking the card still saves it, but not when you meant the name
      el.addEventListener("dblclick", (e) => { if (!e.target.closest(".fn")) saveFile(o); });
    }

    if (o.type === "shelf") {
      /* Rows are built by paint, which is also what keeps their order and
         their names honest. The only thing bound here is carrying one. */
      body.addEventListener("pointerdown", (e) => {
        const row = e.target.closest(".row");
        if (!row || e.button !== 0 || edgeAt(el, e)) return;
        if (e.target.isContentEditable) return;
        if (drawMode && !app.classList.contains("bypass")) return;
        e.stopPropagation();
        dragRow(o, row, e);
      });
    }

    if (o.type === "web") body.style.position = "relative";

    /* interactions */
    el.addEventListener("pointermove", (e) => {
      /* In smart draw the card is paper, not a widget: no resize cursor.
         Holding a modifier suspends drawing, and the handles come back. */
      if (dragging || (drawMode && !app.classList.contains("bypass"))) { el.style.cursor = ""; return; }
      const d = edgeAt(el, e);
      el.style.cursor = d ? CURSOR[d] : "";
    });
    el.addEventListener("pointerleave", () => { el.style.cursor = ""; });

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      /* Smart draw owns every press while it is on, including presses that
         land on a card. You can draw straight across notes, images and
         drawings, and nothing resizes, selects or drags underneath. */
      const plain = e.ctrlKey || e.metaKey;
      if (drawMode && !plain) { e.preventDefault(); e.stopPropagation(); beginStroke(e); return; }
      /* Holding a modifier with smart draw on means "forget the ink and
         just handle the card": grab it, resize it, drop a caret in it.
         With drawing off the same press adds the card to the selection. */
      if (plain && !drawMode) { e.preventDefault(); e.stopPropagation(); select(o.id, true); return; }
      if (!selected.has(o.id)) select(o.id);
      front(o);
      const d = edgeAt(el, e);
      if (d) return startResize(e, o, d);
      const hard = e.target.closest("canvas,video,iframe,.rail,.pal,button,select,input,a");
      if (hard) return;
      /* text is draggable too: press and move to carry the card, press and
         release to drop the caret exactly where you clicked */
      const text = e.target.closest("textarea,[contenteditable=true]");
      if (text && document.activeElement === text) return;
      startDrag(e, o, text || null);
    });

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!selected.has(o.id)) select(o.id);
      front(o);
      objectMenu(o, e.clientX, e.clientY);
    });

    paint(o);
    place(o);
    return el;
  }

  /* content refresh (never rebuilds the node while it is being edited) */
  function paint(o) {
    const el = nodes.get(o.id); if (!el) return;
    if (o.type === "note") {
      const b = el.querySelector(".body");
      if (document.activeElement !== b && b.innerText !== (o.body || "")) b.textContent = o.body || "";
      b.style.fontSize = (o.size || 13.5) + "px";
      b.style.fontFamily = o.mono ? "var(--mono)" : "var(--sans)";
    }
    if (o.type === "sketch") redrawSketch(o);
    if (o.type === "code") {
      const ta = el.querySelector("textarea"), view = el.querySelector(".view"), nm = el.querySelector(".fname");
      const hl = el.querySelector(".hlbg");
      if (document.activeElement !== ta && ta.value !== (o.src || "")) ta.value = o.src || "";
      ta.style.whiteSpace = o.wrap ? "pre-wrap" : "pre";
      if (hl) hl.style.whiteSpace = o.wrap ? "pre-wrap" : "pre";
      // never rewrite the name while it is being typed into
      if (nm !== document.activeElement) {
        nm.hidden = !o.name;
        if (o.name) nm.textContent = o.name;
      }
      if (o.md && document.activeElement !== ta) {
        /* A math card is typeset rather than highlighted: `math`, `tex` and
           `latex` go through KaTeX, exactly like $…$ inside markdown. */
        view.innerHTML = MD.isMathLang(o.lang)
          ? MD.mathBlock(o.src || "")
          : MD.render(o.src || "", o.lang);
        view.hidden = false; ta.hidden = true;
        if (hl) hl.hidden = true;
      } else {
        view.hidden = true; ta.hidden = false;
        if (hl) { hl.hidden = false; paintHL(o); }
      }
    }
    if (o.type === "image") {
      // a picture always fills its card; the fit/fill switch is gone
      const img = el.querySelector("img");
      if (img.getAttribute("src") !== (o.src || "")) img.src = o.src || "";
      el.classList.add("cover");
    }
    if (o.type === "video") {
      const body = el.querySelector(".inner");
      const want = o.kind === "embed" ? "IFRAME" : "VIDEO";
      let m = body.querySelector("video,iframe");
      if (!m || m.tagName !== want) {
        if (m) m.remove();
        m = document.createElement(want === "IFRAME" ? "iframe" : "video");
        if (want === "IFRAME") m.allow = "autoplay; fullscreen; picture-in-picture";
        body.appendChild(m);
      }
      // fit/fill is worth having here: a clip is rarely the card's shape
      // fill is the default; fit is the thing you opt into
      el.classList.toggle("cover", o.fit !== "contain");
      if (m.tagName === "VIDEO") {
        /* "metadata" fetches the header and one frame, so the card shows a
           still and knows its duration. Full preload used to pull entire
           clips down for every video on the board at once, which is what
           made a board with a few videos on it crawl. Nothing more is
           fetched until you actually press play. */
        m.preload = "metadata";
        if (m.getAttribute("src") !== (o.src || "")) m.src = o.src || "";
        m.loop = !!o.loop; m.muted = o.muted !== false; m.controls = o.controls !== false;
        m.playsInline = true;
        /* The rail's Play/Pause label has to follow the clip, not the last
           press: the native bar, the end of a clip and autoplay all change
           the state without going through the rail. Bound once per element,
           since paint reuses the same one. */
        if (!m._follow) {
          m._follow = true;
          const follow = () => rebuildRail(o);
          m.addEventListener("play", follow);
          m.addEventListener("pause", follow);
          m.addEventListener("ended", follow);
        }
      } else {
        // an off-screen embed should not be booting a player either
        m.loading = "lazy";
        if (m.getAttribute("src") !== (o.src || "")) m.src = o.src || "";
      }
    }
    if (o.type === "file") {
      const ic = el.querySelector("svg"), fn = el.querySelector(".fn"), mt = el.querySelector(".meta");
      ic.innerHTML = FileIcons.svgFor(o.name, o.mime);
      if (fn !== document.activeElement) fn.textContent = o.name || "file";
      mt.textContent = [ext(o.name), o.size ? bytes(o.size) : ""].filter(Boolean).join("  ·  ");
    }

    if (o.type === "shelf") {
      const inner = el.querySelector(".inner");
      const list = o.items || [];
      // rows are added and removed one at a time; the rest are re-labelled
      while (inner.childElementCount > list.length) inner.lastElementChild.remove();
      while (inner.childElementCount < list.length) inner.appendChild(shelfRow(o));
      list.forEach((it, i) => {
        const row = inner.children[i];
        row.dataset.i = i;
        row.querySelector("svg").innerHTML = FileIcons.svgFor(it.name, it.mime);
        const fn = row.querySelector(".fn");
        if (fn !== document.activeElement) fn.textContent = it.name || "file";
        row.querySelector(".meta").textContent = it.size ? bytes(it.size) : "";
      });
    }

    if (o.type === "web") {
      const inner = el.querySelector(".inner");
      const href = o.src || o.url || "";
      if (o.render) {
        let f = inner.querySelector("iframe");
        if (!f) {
          inner.textContent = "";
          f = document.createElement("iframe");
          /* Sandboxed: scripts and forms work, so the page is genuinely
             usable, but it cannot reach this document or its storage. */
          f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
          f.setAttribute("referrerpolicy", "no-referrer");
          f.loading = "lazy";
          inner.appendChild(f);
        }
        if (f.getAttribute("src") !== href) f.setAttribute("src", href);
      } else {
        let card = inner.querySelector(".card");
        if (!card) {
          inner.textContent = "";
          card = document.createElement("div");
          card.className = "card";
          const ic = document.createElementNS(SVGNS, "svg");
          ic.setAttribute("viewBox", "0 0 24 24");
          const fn = document.createElement("div"); fn.className = "fn";
          const ad = document.createElement("div"); ad.className = "addr";
          card.append(ic, fn, ad);
          inner.appendChild(card);
        }
        const host = hostOf(href);
        card.querySelector("svg").innerHTML = FileIcons.svgFor(o.name || "page.html", o.mime || "text/html");
        card.querySelector(".fn").textContent = o.name || host || "page";
        card.querySelector(".addr").textContent = host || (href ? "local file" : "");
      }
    }
  }

  function render() {
    const alive = new Set();
    for (const o of doc.objs) {
      if (!isBox(o)) continue;
      alive.add(o.id);
      const ex = nodes.get(o.id);
      if (ex && ex.dataset.type !== o.type) { ex.remove(); nodes.delete(o.id); }
      if (!nodes.has(o.id)) build(o); else { paint(o); place(o); }
      nodes.get(o.id).classList.toggle("sel", selected.has(o.id));
    }
    for (const [id, el] of nodes) if (!alive.has(id)) { el.remove(); nodes.delete(id); }
    drawVectors();
    applyCam();
  }

  /* ------------------------------------------------------------------ *
   * creating objects
   * ------------------------------------------------------------------ */
  const snap = (v) => Math.round(v / SNAP) * SNAP;

  function overlaps(a, b) {
    return a.x < b.x + b.w + 12 && a.x + a.w + 12 > b.x && a.y < b.y + b.h + 12 && a.y + a.h + 12 > b.y;
  }
  /* place near a point but never on top of something else */
  function freeSpot(x, y, w, h) {
    const boxes = doc.objs.filter(isBox).map(rectOf);
    let best = { x: snap(x), y: snap(y), w, h };
    const hits = (r) => boxes.some((b) => overlaps(r, b));
    if (!hits(best)) return best;
    for (let ring = 1; ring < 40; ring++) {
      const step = ring * SNAP * 2;
      for (const [dx, dy] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) {
        const cand = { x: snap(x + dx * step), y: snap(y + dy * step), w, h };
        if (!hits(cand)) return cand;
      }
    }
    return best;
  }

  function add(o, at) {
    snapshot();
    const spot = freeSpot(at.x - (o.w || 0) / 2, at.y - 24, o.w || 0, o.h || 0);
    if (isBox(o)) { o.x = spot.x; o.y = spot.y; sync(o); }
    o.id = uid();
    doc.objs.push(o);
    render(); save();
    select(o.id);
    return o;
  }

  const mkNote = (at) => add({ type: "note", w: 240, h: 156, body: "", size: 13.5 }, at);
  const mkSketch = (at) => add({ type: "sketch", w: 264, h: 208, strokes: [], color: PALETTE[0], size: 3 }, at);
  const mkCode = (at, extra) => add(Object.assign({ type: "code", w: 380, h: 240, src: "", lang: "txt", md: false, wrap: false }, extra || {}), at);

  function mkImage(src, at) {
    const o = add({ type: "image", w: 280, h: 200, src, fit: "contain" }, at);
    naturalSize(o, true);
    return o;
  }
  function mkVideo(src, at, kind) {
    return add({ type: "video", w: 360, h: 216, src, kind: kind || "file", fit: "cover", loop: false, muted: true, controls: true }, at);
  }
  const mkFile = (at, extra) => add(Object.assign({ type: "file", w: 192, h: 156 }, extra), at);
  const mkWeb = (src, at, extra) => add(Object.assign({ type: "web", w: 420, h: 300, src, render: false }, extra), at);
  const hostOf = (u) => { try { return new URL(u, location.href).host; } catch (e) { return ""; } };

  /* ------------------------------------------------------------------ *
   * shelves — the one card that holds other files
   *
   * A shelf is a flat field of rows: wide and short, one row per file,
   * growing downwards by exactly one row at a time. Nothing nests inside
   * it, there are no folders and no parents, and there is no way to make
   * an empty one: a shelf only ever appears already holding something,
   * either from Extract on an archive or from dropping file onto file.
   * ------------------------------------------------------------------ */
  const ROW_H = 30, ROW_GAP = 6, SHELF_PAD = 8;

  function shelfHeight(o) {
    const n = Math.max(1, (o.items || []).length);
    return SHELF_PAD * 2 + n * ROW_H + (n - 1) * ROW_GAP;
  }

  /* what a card looks like once it is a row: a name and a reference */
  const rowOf = (o) => ({
    name: o.name || "file", mime: o.mime || "", size: o.size || 0,
    ref: o.ref || null, url: o.url || "", src: o.src || "",
  });
  const rowsOf = (o) => (o.type === "shelf" ? (o.items || []).slice() : [rowOf(o)]);

  /* one row: icon, name, size — the same three things a file card shows,
     laid along a line instead of stacked */
  function shelfRow(o) {
    const row = document.createElement("div");
    row.className = "row";
    const ic = document.createElementNS(SVGNS, "svg");
    ic.setAttribute("viewBox", "0 0 24 24");
    const fn = document.createElement("div"); fn.className = "fn";
    const mt = document.createElement("div"); mt.className = "meta";
    row.append(ic, fn, mt);
    // the row's index moves as rows are reordered, so it is read, not captured
    const at = () => (o.items || [])[+row.dataset.i] || null;
    renameOn(fn, () => (at() || {}).name || "file",
      (v) => { const it = at(); if (!it) return; snapshot(); it.name = v; paint(o); save(); Sync.obj(o); });
    row.addEventListener("dblclick", (e) => { const it = at(); if (it && !e.target.closest(".fn")) saveFile(it); });
    return row;
  }

  /* Dropping a file on a file, or on a shelf, gathers them. This is the
     only way a shelf is born and the only way one grows. Returns true when
     the drop was consumed, so the caller leaves the cards alone. */
  function gatherOnDrop(o, set, ev) {
    if (!ev || set.length !== 1) return false;
    const src = set[0];
    if (!src || (src.type !== "file" && src.type !== "shelf")) return false;

    const p = toWorld(ev.clientX, ev.clientY);
    const hit = doc.objs
      .filter((t) => t !== src && (t.type === "file" || t.type === "shelf"))
      .filter((t) => { const r = rectOf(t); return r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; })
      .pop();
    if (!hit) return false;

    const items = rowsOf(hit).concat(rowsOf(src));
    if (hit.type === "shelf") {
      hit.items = items;
      hit.h = shelfHeight(hit);
      doc.objs = doc.objs.filter((t) => t !== src);
      Sync.del(src.id);
      render(); save(); Sync.obj(hit); select(hit.id);
      return true;
    }

    /* two loose files become a shelf, standing where the target stood */
    const r = rectOf(hit);
    doc.objs = doc.objs.filter((t) => t !== src && t !== hit);
    Sync.del(src.id); Sync.del(hit.id);
    const shelf = { type: "shelf", id: uid(), x: r.x, y: r.y, w: Math.max(320, r.w), items };
    shelf.h = shelfHeight(shelf);
    sync(shelf);
    doc.objs.push(shelf);
    render(); save(); Sync.obj(shelf); select(shelf.id);
    return true;
  }

  /* Carry a row up or down inside its shelf. Nothing leaves the card and
     nothing else moves: the order of the rows is the only thing that
     changes, and it is committed when you let go. */
  function dragRow(o, row, e) {
    const inner = row.parentNode;
    const rows = [...inner.children];
    const from = rows.indexOf(row);
    const step = (ROW_H + ROW_GAP) * (cam().z || 1);
    const y0 = e.clientY;
    let to = from, lifted = false;

    const move = (ev) => {
      const dy = ev.clientY - y0;
      if (!lifted) {
        if (Math.abs(dy) < 4) return;
        lifted = true;
        row.classList.add("lift");
        snapshot();
      }
      const want = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
      if (want === to) return;
      to = want;
      const order = rows.filter((r) => r !== row);
      order.splice(to, 0, row);
      order.forEach((r) => inner.appendChild(r));
    };
    const up = () => {
      row.classList.remove("lift");
      if (!lifted) return;
      if (to !== from) {
        const list = o.items || [];
        const [it] = list.splice(from, 1);
        list.splice(to, 0, it);
        save(); Sync.obj(o);
      }
      paint(o);
    };
    pointerSession({ move, up, grab: true });
  }

  function naturalSize(o, quiet) {
    const probe = new Image();
    probe.onload = () => {
      const r = probe.naturalWidth / probe.naturalHeight || 1.4;
      const w = Math.min(460, Math.max(160, probe.naturalWidth));
      if (!quiet) snapshot();
      o.w = snap(w); o.h = snap(w / r);
      kick(); save(); drawVectors();
    };
    probe.src = o.src;
  }

  /* ------------------------------------------------------------------ *
   * files
   * ------------------------------------------------------------------ */
  const ext = (n) => ((String(n || "").match(/\.([A-Za-z0-9]+)$/) || [])[1] || "").toLowerCase();
  const bytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B");

  const TEXT_EXT = ("txt md markdown js mjs cjs jsx ts tsx json jsonc css scss less html htm xml svg yml yaml toml ini cfg conf " +
    "py rb go rs java kt kts swift c h cpp hpp cc cs php sh bash zsh fish sql csv tsv log vue svelte lua r pl dart gradle " +
    "properties env gitignore dockerfile makefile tex bib").split(" ");
  const LANG_BY_EXT = { js: "js", mjs: "js", cjs: "js", jsx: "jsx", ts: "ts", tsx: "tsx", py: "py", go: "go", rs: "rust",
    java: "java", kt: "java", kts: "java", cs: "java", swift: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
    php: "js", rb: "py", sh: "sh", bash: "sh", zsh: "sh", fish: "sh", sql: "sql", css: "css", scss: "css", less: "css",
    html: "html", htm: "html", xml: "html", svg: "html", vue: "html", json: "json", jsonc: "json", md: "md", markdown: "md" };

  /* One icon family: 24px line art, no plate, no fill. The set itself
     lives in icons.js so it can keep growing — it now covers roughly two
     hundred extensions across documents, media, code, archives, disk
     images, fonts and keys — without this file knowing about any of it.
     Cards ask for one with FileIcons.svgFor(name, mime). */

  const READABLE = (f) => TEXT_EXT.includes(ext(f.name)) || /^text\//.test(f.type) ||
    f.type === "application/json" || f.type === "application/xml";

  const MONO_FONT = '12.5px "Menlo","Consolas","SF Mono",ui-monospace,monospace';

  /* Height for a new code card. Pretext segments and measures the text
     once, then the line count is pure arithmetic �� no DOM, no reflow. */
  function codeHeight(src, width) {
    const w = Math.max(80, (width || 420) - 28);
    const h = Pretext.layout(Pretext.prepare(String(src), MONO_FONT), w, 20).height + 60;
    return Math.max(180, Math.min(420, snap(h)));
  }

  /* A dropped file is kept as real bytes in IndexedDB, not as a base64
     data: URL inside localStorage. That old approach silently discarded
     anything over 700KB and could not survive a reload anyway, because a
     blob: URL dies with the tab.

     The document only ever holds a small reference. If the room is live
     the bytes are also pushed to the server, so everyone else can open
     the same card. */
  const HTML_EXT = ["html", "htm", "xhtml"];
  const isHTML = (f) => HTML_EXT.includes(ext(f.name)) || f.type === "text/html" ||
    f.type === "application/xhtml+xml";

  async function handleFile(f, at) {
    /* A page dropped on the board is the page, not its source. It arrives
       with rendering off — a bookmark card — so nothing inside it runs
       until you turn it on, and then only inside a sandbox. */
    if (isHTML(f)) {
      let rec = null;
      try { rec = await Store.put(f); }
      catch (e) { console.warn("[space] local file store failed", e); }
      const o = mkWeb(rec ? rec.url : await blobURL(f).catch(() => ""), at,
        { name: f.name, mime: f.type || "text/html", size: f.size });
      if (rec) o.ref = rec.ref;
      paint(o); save();
      if (rec && typeof Net !== "undefined" && Net.online()) {
        const up = await Store.share(rec.ref);
        if (up && up.url) { o.url = up.url; save(); Sync.obj(o); }
      }
      return;
    }

    if (READABLE(f) && f.size < 512 * 1024) {
      const src = await f.text();
      const lang = LANG_BY_EXT[ext(f.name)] || guessLang(src);
      mkCode(at, { src, lang, name: f.name, h: codeHeight(src, 420) });
      return;
    }

    let rec = null;
    try { rec = await Store.put(f); }
    catch (e) { console.warn("[space] local file store failed", e); }

    /* No IndexedDB and a big file: a data: URL would be inlined into the
       document and blow the localStorage quota on the next save. The card
       is still made — named and sized — rather than losing the drop. */
    let src = "";
    if (rec) src = rec.url;
    else if (f.size <= 700 * 1024) src = await blobURL(f).catch(() => "");
    else toast("no local storage here: card kept, bytes not");

    let o;
    if (/^image\//.test(f.type)) o = mkImage(src, at);
    else if (/^video\//.test(f.type)) o = mkVideo(src, at, "file");
    else o = mkFile(at, { src, name: f.name, mime: f.type, size: f.size });

    if (!o) return;
    o.name = f.name; o.mime = f.type; o.size = f.size;
    if (rec) o.ref = rec.ref;
    save();

    // share the bytes with the room, then remember where they landed
    if (rec && typeof Net !== "undefined" && Net.online()) {
      const up = await Store.share(rec.ref);
      if (up && up.url) { o.url = up.url; save(); Sync.obj(o); }
    }
  }

  /* Rebuild live blob: URLs after a reload. Local copy first, then the
     room's copy, which is also cached locally on the way through. */
  async function rehydrate() {
    if (typeof Store === "undefined") return;
    for (const o of doc.objs) {
      if (!o.ref || (o.src && o.src.slice(0, 5) === "blob:")) continue;
      try {
        const u = await Store.url(o.ref, o.url);
        if (u && u !== o.src) { o.src = u; paint(o); }
      } catch (e) { /* the bytes are gone; the card stays, just empty */ }
    }
  }

  function saveFile(o) {
    if (o.ref && typeof Store !== "undefined") {
      Store.download(o.ref, o.url, o.name || "file").then((ok) => {
        if (!ok) toast("no stored copy of this file");
      });
      return;
    }
    const href = o.src || o.url;
    if (!href) return toast("no stored copy of this file");
    const a = document.createElement("a");
    a.href = href;
    a.download = o.name || "file";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ------------------------------------------------------------------ *
   * sketch pad
   * ------------------------------------------------------------------ */
  const WEIGHTS = [2, 4, 7];             // small, medium, large
  const NIBS = ["4px", "7px", "10px"];   // the dot each nib button shows
  const wIndex = (s) => { let bi = 0; WEIGHTS.forEach((w, i) => { if (Math.abs(w - s) < Math.abs(WEIGHTS[bi] - s)) bi = i; }); return bi + 1; };

  /* number field: click it and type. Out-of-range values fold to 1 or 5. */
  function numField(value, min, max, run) {
    const n = document.createElement("span");
    n.className = "num";
    n.contentEditable = "true";
    n.spellcheck = false;
    n.textContent = String(value);
    const commit = () => {
      let v = parseFloat(String(n.textContent).replace(/[^0-9.\-]/g, ""));
      if (isNaN(v)) v = value;
      v = Math.max(min, Math.min(max, Math.round(v)));
      n.textContent = String(v);
      run(v);
    };
    n.addEventListener("pointerdown", (e) => e.stopPropagation());
    n.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = document.createRange(); r.selectNodeContents(n);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    n.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); n.blur(); }
      if (e.key === "Escape") { n.textContent = String(value); n.blur(); }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const cur = parseFloat(n.textContent) || value;
        n.textContent = String(Math.max(min, Math.min(max, cur + (e.key === "ArrowUp" ? 1 : -1))));
        commit();
      }
    });
    n.addEventListener("blur", commit);
    return n;
  }

  /* Ink strip inside the pad: ten colours, three nibs, eraser last.
     It appears only while the pointer is over the card. */
  /* The palette's own height, in card pixels. The band it occupies is not
     drawable: strokes used to start underneath the swatches, so the bottom
     of every sketch card was a place where ink appeared but could not be
     seen. Kept in step with `.sketch .pal { height }` in style.css. */
  const PAL_H = 30;

  function buildPal(o, pal) {
    pal.textContent = "";
    const sep = () => { const s = document.createElement("span"); s.className = "gap"; pal.appendChild(s); };

    PALETTE.forEach((c) => {
      const d = document.createElement("button");
      d.className = "sd" + (o.color === c && !o.erase ? " on" : "");
      d.style.background = c;
      d.onclick = () => { o.color = c; o.erase = false; save(); buildPal(o, pal); };
      pal.appendChild(d);
    });

    sep();

    /* Three nibs — small, medium, large — each drawn at the width it
       paints. Picking a size never switches the pen back on: you are just
       as likely to be resizing the eraser. */
    const cur = wIndex(o.size || WEIGHTS[1]);
    WEIGHTS.forEach((wgt, i) => {
      const d = document.createElement("button");
      d.className = "nib" + (cur === i + 1 ? " on" : "");
      d.style.setProperty("--nib", NIBS[i]);
      d.onclick = () => { o.size = wgt; save(); buildPal(o, pal); };
      pal.appendChild(d);
    });

    sep();

    /* The eraser closes the row, after the sizes. A two-by-two checker is
       the standing mark for transparent, so it needs no caption. */
    const e = document.createElement("button");
    e.className = "er" + (o.erase ? " on" : "");
    e.title = "erase";
    e.onclick = () => { o.erase = !o.erase; save(); buildPal(o, pal); };
    pal.appendChild(e);
  }

  function bindSketch(o, cv) {
    let cur = null;
    /* Pad pixels, offset by the sheet's origin. getBoundingClientRect is in
       screen pixels and the world carries a scale transform, so it has to
       be divided by the zoom to land back in layout space. */
    const rel = (e) => {
      const r = cv.getBoundingClientRect();
      const z = cam().z || 1;
      return [(e.clientX - r.left) / z - (o.ox || 0), (e.clientY - r.top) / z - (o.oy || 0)];
    };
    cv.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
      // smart draw draws over drawing cards too; let the press bubble to it
      if (drawMode) return;
      /* Leave the resize band to the card. The canvas used to swallow every
         press anywhere on it, so the only way to resize a drawing was to
         hit the one pixel of border outside the canvas — which is exactly
         why resizing one was so miserable. */
      const card = cv.closest(".obj");
      if (card && edgeAt(card, e)) return;
      /* The ink strip at the foot of the card is controls and the air around
         them, PAL_H tall. Pressing anywhere in that band never draws — you
         cannot leave a stray dot behind a colour you were reaching for. */
      const box = cv.getBoundingClientRect();
      if (e.clientY > box.bottom - PAL_H * (cam().z || 1)) return;
      e.stopPropagation();
      cv.setPointerCapture(e.pointerId);
      snapshot();
      cur = { c: o.erase ? null : (o.color || PALETTE[0]), s: o.size || 3, p: [rel(e)] };
      o.strokes.push(cur);
    });
    cv.addEventListener("pointermove", (e) => {
      if (!cur) return;
      // a release we never saw would otherwise leave the pen down
      if (!e.buttons) { end(e); return; }
      cur.p.push(rel(e));
      redrawSketch(o);
    });
    const end = (e) => {
      if (!cur) return;
      cur = null;
      if (e && e.pointerId != null && cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      save(); Sync.obj(o);
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("lostpointercapture", end);
  }

  /* Ink used to be stored as fractions of the pad, so resizing a card
     stretched the drawing along with it. It is pad pixels now: the card is
     a window onto a sheet with no edges, and resizing reveals or hides
     paper rather than distorting what is on it. Boards saved under the old
     scheme are converted once, at the size they were last drawn at. */
  function inkPx(o, w, h) {
    if (o.px) return;
    for (const st of o.strokes || []) {
      for (const q of st.p || []) { q[0] *= w; q[1] *= h; }
    }
    o.px = true;
  }

  function strokeInto(c, strokes, ox, oy) {
    c.save();
    c.translate(ox || 0, oy || 0);
    for (const st of strokes || []) {
      if (!st.p.length) continue;
      c.lineCap = "round"; c.lineJoin = "round";
      c.globalCompositeOperation = st.c ? "source-over" : "destination-out";
      c.strokeStyle = st.c || "#000";
      c.lineWidth = st.s * (st.c ? 1 : 4);
      c.beginPath();
      c.moveTo(st.p[0][0], st.p[0][1]);
      for (let i = 1; i < st.p.length; i++) {
        const a = st.p[i - 1], b = st.p[i];
        c.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      c.stroke();
    }
    c.globalCompositeOperation = "source-over";
    c.restore();
  }

  /* Size the bitmap from the pad, not from a measured screen rect.

     getBoundingClientRect is in screen pixels, so it had to be divided by
     the zoom, and it returns 0 before the first layout — which is exactly
     why a sketch looked wrong after a reload until you clicked it.
     clientWidth/clientHeight are layout pixels and ignore the world's
     transform, so no zoom division is needed, and the pad is a block the
     canvas cannot push around. When even that is not measurable yet, fall
     back to the card's own logical size so the very first paint is right. */
  function redrawSketch(o) {
    const node = nodes.get(o.id); if (!node) return;
    const cv = node.querySelector("canvas"); if (!cv) return;
    const pad = cv.parentNode;

    let w = pad ? pad.clientWidth : 0;
    let h = pad ? pad.clientHeight : 0;
    if (!(w > 1) || !(h > 1)) {
      // the pad is the whole card now: the ink strip floats over it, so the
      // band it used to occupy is drawable paper like everywhere else
      w = (o._w == null ? o.w : o._w) - 2;
      h = (o._h == null ? o.h : o._h) - 2;
    }
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    inkPx(o, w, h);

    // supersample when zoomed in, but quantise the factor so a smooth zoom
    // does not reallocate the bitmap on every single frame
    const zq = Math.min(2, Math.max(1, Math.round((cam().z || 1) * 2) / 2));
    const dpr = Math.min(2, devicePixelRatio || 1) * zq;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }

    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    strokeInto(c, o.strokes, o.ox || 0, o.oy || 0);
  }

  /* ------------------------------------------------------------------ *
   * drag + resize
   * ------------------------------------------------------------------ */
  let dragging = false;

  function movingSet(o) {
    const ids = selected.has(o.id) && selected.size > 1 ? [...selected] : [o.id];
    return ids.map(byId).filter(Boolean);
  }

  /* ------------------------------------------------------------------ *
   * pointer sessions
   *
   * Every drag on the board is the same shape: listen while the button is
   * down, then clean up exactly once. Each one used to spell that out for
   * itself and each one forgot something different — resizing never
   * listened for pointercancel, panning never noticed the button coming
   * up outside the window — and a lost release left the board stuck
   * mid-drag. This owns all of it in one place.
   * ------------------------------------------------------------------ */

  /* Raise the shield while something is being carried. Videos and embedded
     pages handle pointer events in their own world and were eating the
     release, which is what glued a card to the cursor; with the sheet up,
     nothing inside a card can take an event until the drag is over. */
  function shield(on) {
    dragging = !!on;
    app.classList.toggle("dragging", !!on);
  }

  function pointerSession(opts) {
    const { move, up, grab } = opts;
    let done = false;
    const end = (ev) => {
      if (done) return;
      done = true;
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", onHide);
      if (grab) shield(false);
      if (up) up(ev);
    };
    const onHide = () => { if (document.hidden) end(); };
    const onMove = (ev) => {
      // no button held means the release happened somewhere we never saw
      if (!ev.buttons) return end(ev);
      if (move) move(ev);
    };
    if (grab) shield(true);
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    addEventListener("blur", end);
    document.addEventListener("visibilitychange", onHide);
    return end;
  }

  /* How long after letting go a second grab still counts as continuing the
     same carry rather than a fresh click on the text. */
  const REGRAB_MS = 350;
  let lastDragEnd = 0, lastDragId = null;

  function startDrag(e, o, textEl) {
    // Grabbing the same card again right after dropping it means you are
    // still moving it. Skip the caret entirely and carry straight away.
    if (textEl && o.id === lastDragId && performance.now() - lastDragEnd < REGRAB_MS) {
      textEl.blur();
      const s0 = getSelection(); if (s0) s0.removeAllRanges();
      textEl = null;
    }

    if (!textEl) e.preventDefault();
    dragging = true;
    const set = movingSet(o);
    const start = toWorld(e.clientX, e.clientY);
    const base = set.map((t) => ({
      o: t,
      x: t.x, y: t.y,
      pts: t.pts ? t.pts.map((p) => ({ x: p.x, y: p.y })) : null,
      a: t.a ? { x: t.a.x, y: t.a.y } : null,
      b: t.b ? { x: t.b.x, y: t.b.y } : null,
    }));
    /* The card lifts only once you have actually moved. It used to arm on
       pointerdown whenever you were not in text, so every plain click
       scaled the card up and straight back down — the board appeared to
       twitch under the cursor on a single click. */
    let armed = false;
    const lift = () => {
      if (armed) return;
      armed = true;
      if (textEl) {
        textEl.blur();
        const sel = getSelection(); if (sel) sel.removeAllRanges();
      }
      /* The shield goes up here rather than on the press: a plain click has
         to keep reaching the text underneath so the caret still lands and
         a selection can still be dragged out. */
      shield(true);
      set.forEach((t) => { if (isBox(t)) t._liftT = 1; });
      kick();
    };
    let moved = false;
    closeMenu();
    const move = (ev) => {
      const p = toWorld(ev.clientX, ev.clientY);
      const dx = p.x - start.x, dy = p.y - start.y;
      if (!armed) {
        if (Math.hypot(dx, dy) * cam().z < 4) return;   // still a click, not a carry
        lift();
      }
      if (!moved && Math.hypot(dx, dy) > 2) { snapshot(); moved = true; }
      const free = ev.altKey;
      for (const b of base) {
        const t = b.o;
        if (isBox(t) || t.type === "rect" || t.type === "ellipse") {
          t.x = free ? b.x + dx : snap(b.x + dx);
          t.y = free ? b.y + dy : snap(b.y + dy);
        } else if (b.pts) {
          t.pts.forEach((q, i) => { q.x = b.pts[i].x + dx; q.y = b.pts[i].y + dy; });
        } else if (b.a) {
          t.a = { x: b.a.x + dx, y: b.a.y + dy }; t.b = { x: b.b.x + dx, y: b.b.y + dy };
        }
      }
      kick(); drawVectors();
      Net.cursor(p.x, p.y, true);
    };
    const up = (ev) => {
      shield(false);
      set.forEach((t) => { if (isBox(t)) t._liftT = 0; });
      if (moved) {
        // dropped onto another file, or onto a shelf: they gather up
        if (!gatherOnDrop(o, set, ev)) { save(); set.forEach(Sync.obj); }
      }
      // remember the drop so an immediate re-grab keeps carrying
      lastDragEnd = performance.now();
      lastDragId = o.id;
      kick();
    };
    pointerSession({ move, up });
  }

  function startResize(e, o, dir) {
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    const start = toWorld(e.clientX, e.clientY);
    const x0 = o.x, y0 = o.y, w0 = o.w, h0 = o.h;
    const fixR = x0 + w0, fixB = y0 + h0;
    const ox0 = o.ox || 0, oy0 = o.oy || 0;
    /* A drawing card needs more floor than a note: squeezed down to a
       hundred pixels the ink strip has nowhere to sit and the pad stops
       being usable at all. */
    const MINW = o.type === "sketch" ? 168 : 96;
    const MINH = o.type === "sketch" ? 140 : 72;
    let moved = false;
    const move = (ev) => {
      const p = toWorld(ev.clientX, ev.clientY);
      if (!moved) { snapshot(); moved = true; }
      const dx = p.x - start.x, dy = p.y - start.y;
      const free = ev.altKey;
      let x = x0, y = y0, w = w0, h = h0;
      if (dir.includes("e")) { w = Math.max(MINW, w0 + dx); if (!free) w = Math.max(MINW, snap(w)); }
      if (dir.includes("w")) { x = Math.min(fixR - MINW, x0 + dx); if (!free) x = Math.min(fixR - MINW, snap(x)); w = fixR - x; }
      if (dir.includes("s")) { h = Math.max(MINH, h0 + dy); if (!free) h = Math.max(MINH, snap(h)); }
      if (dir.includes("n")) { y = Math.min(fixB - MINH, y0 + dy); if (!free) y = Math.min(fixB - MINH, snap(y)); h = fixB - y; }
      if (ev.shiftKey && w0 && h0) {
        h = w * (h0 / w0);
        if (dir.includes("n")) y = fixB - h;
      }
      o.x = x; o.y = y; o.w = w; o.h = h;
      /* Pulling a drawing card's left or top edge slides the window across
         the sheet, so the ink stays put on screen instead of creeping away
         from the pointer. The shift is recomputed from the original edge
         every frame rather than accumulated, so holding a resize and
         waving it around cannot drift. */
      if (o.type === "sketch") { o.ox = ox0 + (x0 - x); o.oy = oy0 + (y0 - y); }
      // a shelf is exactly as tall as the rows it holds; only width is free
      if (o.type === "shelf") { o.h = shelfHeight(o); place(o); }
      kick();
    };
    const up = () => {
      // the new size has to reach the other windows too, which it never did
      if (moved) { save(); Sync.obj(o); }
    };
    pointerSession({ move, up, grab: true });
  }

  /* ------------------------------------------------------------------ *
   * vector layer: curves, lines, arrows, shapes, polygons, links
   * ------------------------------------------------------------------ */
  const el = (name, attrs) => {
    const n = document.createElementNS(SVGNS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  /* The cluster glow used to be an SVG metaball trick: white rectangles
     and fat white lines pushed through blur → alpha threshold → blur.
     An alpha threshold has exactly one level, which is precisely why the
     result read as a stack of single steps instead of a gradient, and why
     every pool stayed visibly tied to the rounded rectangle it grew from.

     It is a real scalar field now (field.js): every card emits a smooth
     falloff measured from its rounded box, all contributions are summed,
     and the sum passes through one smoothstep. Overlapping cards merge
     into a single continuous shape with no seam and no step, the outline
     follows whatever the cluster actually looks like rather than any
     circle, and a card on its own falls under the floor and shows
     nothing at all. */
  function drawBlobs() {
    const z = cam().z || 1;
    const rects = [];
    for (const o of doc.objs) {
      if (!isBox(o)) continue;
      const r = rectOf(o); if (!r) continue;
      const s = toScreen(r.x, r.y);
      const w = r.w * z, h = r.h * z;
      // a card far outside the viewport cannot contribute anything visible
      if (s.x + w < -420 || s.y + h < -420 || s.x > innerWidth + 420 || s.y > innerHeight + 420) continue;
      rects.push({ x: s.x, y: s.y, w, h });
    }
    rects.zoom = z;
    Field.draw(rects);
  }

  function anchorPoint(a) {
    const o = byId(a.id); if (!o) return null;
    const r = rectOf(o); if (!r) return null;
    return { x: r.x + a.ax * r.w, y: r.y + a.ay * r.h };
  }

  /* a link is a spline: its waypoints are stored along/across the A→B chord,
     so they keep their shape when either card moves */
  function linkFrame(o) {
    const p1 = anchorPoint(o.from), p2 = anchorPoint(o.to);
    if (!p1 || !p2) return null;
    const d = G.dist(p1, p2) || 1;
    const ux = (p2.x - p1.x) / d, uy = (p2.y - p1.y) / d;
    const at = (m) => ({
      x: p1.x + (p2.x - p1.x) * m.t - uy * m.o,
      y: p1.y + (p2.y - p1.y) * m.t + ux * m.o,
    });
    return { p1, p2, d, ux, uy, at, mids: (o.mid || []).map(at) };
  }
  function linkLocal(F, p) {
    const dx = p.x - F.p1.x, dy = p.y - F.p1.y;
    return { t: (dx * F.ux + dy * F.uy) / F.d, o: -dx * F.uy + dy * F.ux };
  }
  function linkPath(o) {
    const F = linkFrame(o); if (!F) return null;
    if (!F.mids.length) {
      const n1 = G.anchorNormal(o.from.ax, o.from.ay), n2 = G.anchorNormal(o.to.ax, o.to.ay);
      const k = Math.max(34, Math.min(190, F.d * 0.45));
      const c1 = { x: F.p1.x + n1.x * k * 0.62, y: F.p1.y + n1.y * k * 0.62 };
      const c2 = { x: F.p2.x + n2.x * k * 0.62, y: F.p2.y + n2.y * k * 0.62 };
      return { d: `M${F.p1.x} ${F.p1.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${F.p2.x} ${F.p2.y}`,
        pts: [F.p1, c2, F.p2], p1: F.p1, p2: F.p2 };
    }
    const pts = [F.p1, ...F.mids, F.p2];
    return { d: G.toPath(pts, false), pts, p1: F.p1, p2: F.p2 };
  }

  function shapeD(o) {
    if (o.type === "curve") return G.toPath(o.pts, o.closed, o.tension);
    if (o.type === "poly") return o.pts.map((p, i) => (i ? "L" : "M") + p.x + " " + p.y).join(" ") + " Z";
    if (o.type === "line" || o.type === "arrow") return `M${o.a.x} ${o.a.y} L${o.b.x} ${o.b.y}`;
    if (o.type === "rect") {
      const r = Math.min(10, o.w / 4, o.h / 4);
      return `M${o.x + r} ${o.y} H${o.x + o.w - r} A${r} ${r} 0 0 1 ${o.x + o.w} ${o.y + r} V${o.y + o.h - r}` +
        ` A${r} ${r} 0 0 1 ${o.x + o.w - r} ${o.y + o.h} H${o.x + r} A${r} ${r} 0 0 1 ${o.x} ${o.y + o.h - r}` +
        ` V${o.y + r} A${r} ${r} 0 0 1 ${o.x + r} ${o.y} Z`;
    }
    if (o.type === "ellipse") {
      const rx = o.w / 2, ry = o.h / 2, cx = o.x + rx, cy = o.y + ry;
      return `M${cx - rx} ${cy} a${rx} ${ry} 0 1 0 ${rx * 2} 0 a${rx} ${ry} 0 1 0 ${-rx * 2} 0`;
    }
    if (o.type === "link") { const l = linkPath(o); return l ? l.d : ""; }
    return "";
  }

  /* The head is two open strokes leaving the tip — the same kind of line
     as the shaft, same colour, same weight. Never a marker, never a
     closed or filled triangle.

     When the arrow was recognised from a real stroke, the barbs that were
     actually drawn are replayed at their measured length and angle, so a
     long sweeping head stays long instead of snapping to a fixed stub. */
  function headD(tip, from, w, head) {
    const heading = Math.atan2(tip.y - from.y, tip.x - from.x);
    const scale = 1 + (w || 2) * 0.22;
    return G.headStrokes(tip, heading, head, scale)
      .map((s) => `M${s.from.x} ${s.from.y} L${s.to.x} ${s.to.y}`)
      .join(" ");
  }
  function endsOf(o) {
    if (o.type === "line" || o.type === "arrow") return { tip: o.b, prev: o.a, tail: o.a, next: o.b };
    if (o.type === "curve" && o.pts.length > 1) {
      const n = o.pts.length;
      return { tip: o.pts[n - 1], prev: o.pts[n - 2], tail: o.pts[0], next: o.pts[1] };
    }
    if (o.type === "link") {
      const l = linkPath(o); if (!l) return null;
      const n = l.pts.length;
      return { tip: l.pts[n - 1], prev: l.pts[n - 2], tail: l.pts[0], next: l.pts[1] };
    }
    return null;
  }

  const VEC = ["curve", "line", "arrow", "rect", "ellipse", "poly", "link"];
  function drawVectors() {
    inkBody.textContent = "";
    for (const o of doc.objs) {
      if (!VEC.includes(o.type)) continue;
      const d = shapeD(o);
      if (!d) continue;
      const g = el("g", { "data-id": o.id });
      if (selected.has(o.id)) g.setAttribute("class", "sel");
      g.appendChild(el("path", { class: "hit", d }));
      const closedish = o.type === "rect" || o.type === "ellipse" || o.type === "poly" || (o.type === "curve" && o.closed);
      const p = el("path", { class: "shape" + (closedish ? " fillable" : ""), d });
      const w = o.wdt || 2;
      p.setAttribute("stroke-width", w);
      if (o.dash) p.setAttribute("stroke-dasharray", 7 * w / 2 + " " + 6 * w / 2);
      if (o.color) p.style.stroke = o.color;
      g.appendChild(p);

      const e = endsOf(o);
      if (e && (o.type === "arrow" || o.arrow)) {
        const h = el("path", { class: "shape", d: headD(e.tip, e.prev, w, o.head), "stroke-width": w });
        if (o.color) h.style.stroke = o.color;
        g.appendChild(h);
      }
      if (e && o.arrowStart) {
        const h = el("path", { class: "shape", d: headD(e.tail, e.next, w, o.headStart), "stroke-width": w });
        if (o.color) h.style.stroke = o.color;
        g.appendChild(h);
      }
      if (o.type === "link") {
        const l = linkPath(o);
        if (l) [l.p1, l.p2].forEach((pt) => {
          const c = el("circle", { cx: pt.x, cy: pt.y, r: 3.2, stroke: "#111", "stroke-width": 1 });
          c.style.fill = o.color || "#fff";
          g.appendChild(c);
        });
      }
      inkBody.appendChild(g);
    }
    drawBlobs();
    drawHandles();
  }

  function drawHandles() {
    inkHandles.textContent = "";
    const o = selection && byId(selection);
    if (!o || !VEC.includes(o.type)) return;
    const z = cam().z, R = 4.2 / z, RB = 3.6 / z;
    const node = (x, y, cls, data) => {
      const c = el("circle", { cx: x, cy: y, r: R, class: "node" + (cls ? " " + cls : "") });
      for (const k in data) c.setAttribute("data-" + k, data[k]);
      c.setAttribute("stroke-width", 1.4 / z);
      return c;
    };
    /* The two barbs of an arrowhead get handles of their own, sitting on
       their own tips. A head is made at one universal size, and from there
       either side can be carried wherever you want it. */
    const barbHandles = () => {
      if (!(o.type === "arrow" || o.arrow)) return;
      const e = endsOf(o);
      if (!e || !e.prev) return;
      const heading = Math.atan2(e.tip.y - e.prev.y, e.tip.x - e.prev.x);
      const scale = 1 + (o.wdt || 2) * 0.22;
      G.headStrokes(e.tip, heading, o.head, scale).forEach((s, i) => {
        inkHandles.appendChild(node(s.to.x, s.to.y, "barb", { barb: i }));
      });
    };

    if (o.type === "curve" || o.type === "poly") {
      o.pts.forEach((p, i) => inkHandles.appendChild(node(p.x, p.y, "", { i })));
      barbHandles();
    } else if (o.type === "line" || o.type === "arrow") {
      inkHandles.appendChild(node(o.a.x, o.a.y, "", { end: "a" }));
      inkHandles.appendChild(node(o.b.x, o.b.y, "", { end: "b" }));
      barbHandles();
    } else if (o.type === "link") {
      const F = linkFrame(o);
      if (F) F.mids.forEach((p, i) => inkHandles.appendChild(node(p.x, p.y, "", { m: i })));
    } else if (o.type === "rect" || o.type === "ellipse") {
      [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([cx, cy]) => {
        inkHandles.appendChild(el("rect", {
          x: o.x + cx * o.w - RB, y: o.y + cy * o.h - RB, width: RB * 2, height: RB * 2,
          rx: RB * 0.4, class: "box", "data-cx": cx, "data-cy": cy,
        }));
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * toast
   * ------------------------------------------------------------------ */
  let toastT = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { toastEl.hidden = true; }, 2200);
  }

  /* ------------------------------------------------------------------ *
   * context menu
   * ------------------------------------------------------------------ */
  let menuOpen = false;
  function closeMenu() { if (!menuOpen) return; menuEl.hidden = true; menuEl.textContent = ""; menuOpen = false; }

  function openMenu(x, y, items) {
    menuEl.textContent = "";
    build(items);
    menuEl.hidden = false;
    menuOpen = true;
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
    menuEl.style.top = Math.min(y, innerHeight - r.height - 8) + "px";

    function build(list) {
      menuEl.textContent = "";
      for (const it of list) {
        if (it.sep) { const s = document.createElement("div"); s.className = "sep"; menuEl.appendChild(s); continue; }
        if (it.lab) { const s = document.createElement("div"); s.className = "lab"; s.textContent = it.lab; menuEl.appendChild(s); continue; }
        if (it.swatch) {
          const row = document.createElement("div");
          row.className = "sw";
          PALETTE.forEach((c) => {
            const d = document.createElement("div");
            d.className = "dot" + (it.current === c ? " on" : ""); d.style.background = c;
            d.onclick = () => { it.swatch(c); build(list); };
            row.appendChild(d);
          });
          menuEl.appendChild(row);
          continue;
        }
        /* "Outline: 1" reads as one phrase, so it is laid out as one:
           label, colon, value, all flush left. It used to be a label on
           the left and a number pinned to the right edge, which looked
           like a settings table rather than a menu row. */
        if (it.num) {
          const d = document.createElement("div");
          d.className = "it";
          const l = document.createElement("span");
          l.textContent = it.num.label + ":";
          const f = numField(it.num.value, it.num.min, it.num.max, it.num.run);
          d.append(l, f);
          d.onclick = () => f.click();
          menuEl.appendChild(d);
          continue;
        }

        /* "Link: https://…" — same shape as the row above. Click it and a
           caret appears in the value; there is no field plate, no Set
           button and no popup. The value scrolls from its start, so what
           you see is the beginning of the URL, not its tail. */
        if (it.text) {
          const d = document.createElement("div");
          d.className = "it";
          const l = document.createElement("span");
          l.textContent = it.text.label + ":";
          const v = document.createElement("span");
          v.className = "val";
          /* Plain text only, where the browser has it. A rich paste into an
             ordinary contenteditable brings its own markup with it: pasting
             or dropping a picture's address here used to drop the picture
             itself into the row, and the URL was never seen again. */
          try { v.contentEditable = "plaintext-only"; } catch (e) { /* older engines */ }
          if (v.contentEditable !== "plaintext-only") v.contentEditable = "true";
          v.spellcheck = false;
          v.textContent = it.text.value || "";
          const CAP = 512;
          const insert = (raw) => {
            const s = String(raw || "").replace(/[\r\n]+/g, " ").trim();
            if (s) document.execCommand("insertText", false, s.slice(0, CAP));
          };
          v.addEventListener("paste", (e) => {
            e.preventDefault();
            insert((e.clipboardData || window.clipboardData).getData("text/plain"));
          });
          v.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
          v.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            const dt = e.dataTransfer;
            insert(dt.getData("text/uri-list") || dt.getData("text/plain"));
          });
          const go = () => {
            const s = String(v.textContent || "").replace(/[\r\n]/g, "").trim().slice(0, CAP);
            if (s && s !== (it.text.value || "")) { it.text.run(s); closeMenu(); }
          };
          // hard cap, and the row itself never grows past the menu's width
          v.addEventListener("input", () => {
            const s = String(v.textContent || "");
            if (s.length > CAP) v.textContent = s.slice(0, CAP);
          });
          v.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); go(); }
            if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          });
          v.addEventListener("blur", go);
          d.append(l, v);
          d.onclick = (e) => { if (e.target !== v) { v.focus(); const r = document.createRange(); r.selectNodeContents(v); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } };
          menuEl.appendChild(d);
          continue;
        }
        if (it.input) {
          const row = document.createElement("div");
          row.className = "inp";
          const i = document.createElement("input");
          i.placeholder = it.input.placeholder || "";
          i.value = it.input.value || "";
          const b = document.createElement("button");
          b.textContent = it.input.button || "Set";
          const go = () => { const v = i.value.trim(); if (v) { it.input.run(v); closeMenu(); } };
          b.onclick = go;
          i.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") go(); if (e.key === "Escape") closeMenu(); };
          row.append(i, b);
          menuEl.appendChild(row);
          setTimeout(() => i.focus(), 10);
          continue;
        }
        const d = document.createElement("div");
        d.className = "it" + (it.hot ? " hot" : "");
        const l = document.createElement("span");
        l.textContent = it.label;
        d.appendChild(l);
        d.onclick = () => {
          if (it.expand) {
            build(it.expand());
            const r2 = menuEl.getBoundingClientRect();
            menuEl.style.top = Math.min(y, innerHeight - r2.height - 8) + "px";
            return;
          }
          closeMenu(); it.run && it.run();
        };
        menuEl.appendChild(d);
      }
    }
  }

  function remove(o) {
    snapshot();
    const kill = new Set(selected.has(o.id) ? [...selected] : [o.id]);
    doc.objs = doc.objs.filter((x) => !kill.has(x.id) &&
      !(x.type === "link" && (kill.has(x.from.id) || kill.has(x.to.id))));
    setSelection([], true);
    render(); save();
  }

  async function clipboardInto(o) {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const t = it.types.find((t) => t.startsWith("image/"));
        if (t) {
          const blob = await it.getType(t);
          const src = await blobURL(blob);
          snapshot(); o.src = src; o.kind = "file"; paint(o); save(); return;
        }
      }
      const txt = (await navigator.clipboard.readText()).trim();
      if (txt) { snapshot(); o.src = txt; o.kind = ytId(txt) ? "embed" : "file"; if (o.kind === "embed") o.src = ytEmbed(txt); paint(o); save(); }
      else toast("clipboard has no image");
    } catch (e) { toast("clipboard blocked by the browser"); }
  }

  /* ------------------------------------------------------------------ *
   * universal copy — leaves a normal format on the system clipboard and
   * remembers the original, so pasting back here restores the real object
   * ------------------------------------------------------------------ */
  let lastCopy = null;

  function canvasBlob(cv) {
    return new Promise((res) => cv.toBlob((b) => res(b), "image/png"));
  }

  async function sketchBlob(o) {
    const s = 2;
    const cv = document.createElement("canvas");
    cv.width = Math.round(o.w * s); cv.height = Math.round(o.h * s);
    const c = cv.getContext("2d");
    c.setTransform(s, 0, 0, s, 0, 0);
    strokeInto(c, o.strokes, o.ox || 0, o.oy || 0);
    return canvasBlob(cv);
  }

  function shapeSVG(o) {
    const b = objBBox(o); if (!b) return null;
    const pad = 16 + (o.wdt || 2) * 2;
    const d = shapeD(o);
    const e = endsOf(o);
    let extra = "";
    if (e && (o.type === "arrow" || o.arrow)) extra += `<path d="${headD(e.tip, e.prev, o.wdt || 2)}"/>`;
    if (e && o.arrowStart) extra += `<path d="${headD(e.tail, e.next, o.wdt || 2)}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}" ` +
      `width="${Math.round(b.w + pad * 2)}" height="${Math.round(b.h + pad * 2)}">` +
      `<g fill="none" stroke="${o.color || "#d8d5d0"}" stroke-width="${o.wdt || 2}" ` +
      `stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/>${extra}</g></svg>`;
  }

  function svgToBlob(svg) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = img.width * 2; cv.height = img.height * 2;
        const c = cv.getContext("2d");
        c.scale(2, 2);
        c.drawImage(img, 0, 0);
        canvasBlob(cv).then(res, () => res(null));
      };
      img.onerror = () => res(null);
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }

  function imageBlob(src) {
    return new Promise((res) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext("2d").drawImage(img, 0, 0);
        try { canvasBlob(cv).then(res, () => res(null)); } catch (e) { res(null); }
      };
      img.onerror = () => res(null);
      img.src = src;
    });
  }

  async function copyObject(o) {
    const json = clean(o);
    let text = "", blob = null;
    if (o.type === "note") text = [o.title, o.body].filter(Boolean).join("\n");
    else if (o.type === "code") text = o.src || "";
    else if (o.type === "file") text = o.name || "file";
    else if (o.type === "image" || o.type === "video") {
      text = /^https?:/.test(o.src || "") ? o.src : (o.type === "image" ? "image" : "video");
      if (o.type === "image") blob = await imageBlob(o.src);
    } else if (o.type === "sketch") { blob = await sketchBlob(o); text = "drawing"; }
    else if (VEC.includes(o.type)) {
      const svg = shapeSVG(o);
      text = svg || o.type;
      if (svg) blob = await svgToBlob(svg);
    }

    lastCopy = { json, text, size: blob ? blob.size : 0, at: Date.now() };
    try {
      if (blob && window.ClipboardItem) {
        const parts = { "image/png": blob };
        if (text) parts["text/plain"] = new Blob([text], { type: "text/plain" });
        await navigator.clipboard.write([new ClipboardItem(parts)]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      toast("copied");
    } catch (e) { toast("copy blocked by the browser"); }
  }

  /* paste of something this board produced comes back as the original */
  function pasteOwn(at) {
    if (!lastCopy) return false;
    snapshot();
    const c = JSON.parse(lastCopy.json);
    c.id = uid();
    if (isBox(c)) {
      const spot = freeSpot(at.x - (c.w || 0) / 2, at.y - 24, c.w || 0, c.h || 0);
      c.x = spot.x; c.y = spot.y; sync(c);
    } else if (c.pts) c.pts = c.pts.map((p) => ({ x: p.x + 24, y: p.y + 24 }));
    else if (c.a) { c.a = { x: c.a.x + 24, y: c.a.y + 24 }; c.b = { x: c.b.x + 24, y: c.b.y + 24 }; }
    else if (c.type === "rect" || c.type === "ellipse") { c.x += 24; c.y += 24; }
    else if (c.type === "link") return false;
    doc.objs.push(c);
    render(); save();
    select(c.id);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * language sniffing for pasted code
   * ------------------------------------------------------------------ */
  function guessLang(s) {
    const t = String(s || "").trim();
    if (!t) return "txt";
    if (/^[[{]/.test(t) && /[\]}]$/.test(t)) { try { JSON.parse(t); return "json"; } catch (e) { /* not json */ } }
    if (/^<(!doctype|html|head|body|div|section|svg|\?xml)/i.test(t)) return "html";
    if (/^\s*#\s*(include|pragma|define)\b/m.test(t)) return /\b(std::|cout|template\s*<|nullptr|class\s+\w+\s*\{)/.test(t) ? "cpp" : "c";
    if (/\b(public|private|protected)\s+(static\s+)?(final\s+)?[\w<>\[\]]+\s+\w+\s*\(/.test(t) || /System\.out\.print/.test(t)) return "java";
    if (/^\s*(def|class)\s+\w+.*:\s*$/m.test(t) || /^\s*(from\s+[\w.]+\s+)?import\s+[\w.,\s]+$/m.test(t) && /:\s*$/m.test(t) || /\b(elif|self\.)\b/.test(t)) return "py";
    if (/\bfn\s+\w+\s*[(<]/.test(t) && /(let\s+mut|->\s*\w+|::)/.test(t)) return "rust";
    if (/\bfunc\s+\w+\s*\(/.test(t) && /(package\s+\w+|:=|\bimport\s+\()/.test(t)) return "go";
    if (/^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(TABLE|INDEX))\b/im.test(t)) return "sql";
    if (/^\s*#!.*\b(bash|sh|zsh)\b/.test(t)) return "sh";
    if (/(^|\n)\s*(interface|type)\s+\w+\s*[={]/.test(t) || /:\s*(string|number|boolean|void|any)\b/.test(t)) return "ts";
    if (/(^|\n)\s*(const|let|var|function|class|export|import)\b/.test(t) || /=>/.test(t) || /\bconsole\.log\b/.test(t)) return "js";
    if (/^\s*(echo|cd|sudo|apt|brew|chmod|mkdir|rm|cp|mv|git|npm|curl)\s+\S/m.test(t) || /\bexport\s+\w+=/.test(t)) return "sh";
    if (/^[.#]?[\w-]+(\s*[,>][^{]*)?\s*\{[^}]*:[^}]*;?[^}]*\}/m.test(t)) return "css";
    if (/^#{1,6}\s|\n[-*]\s|\[[^\]]+\]\([^)]+\)/.test(t)) return "md";
    return "txt";
  }

  /* is this pasted text a chunk of source, or just prose? */
  function looksLikeCode(s) {
    const t = String(s || "");
    if (t.length < 12) return false;
    const lines = t.split("\n");
    let score = 0;
    if (/[;{}]\s*$/m.test(t)) score += 2;
    if (/\n[ \t]{2,}\S/.test(t)) score += 2;
    if (/(=>|::|->|\bfunction\b|\bdef\b|\bclass\b|\bimport\b|\b#include\b|\bpublic\s+\w)/.test(t)) score += 2;
    if (/^\s*(\/\/|#|\/\*)/m.test(t)) score += 1;
    if (/[<>]=|!==|\+\+|&&|\|\|/.test(t)) score += 1;
    if (lines.length > 2 && lines.filter((l) => /[;{}()=]/.test(l)).length / lines.length > 0.6) score += 1;
    return score >= 3;
  }

  /* ------------------------------------------------------------------ *
   * drop / paste of outside content
   * ------------------------------------------------------------------ */
  const IMG_RX = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i;
  const VID_RX = /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i;
  const ytId = (u) => (String(u).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/) || [])[1];
  const vimeoId = (u) => (String(u).match(/vimeo\.com\/(?:video\/)?(\d+)/) || [])[1];
  function ytEmbed(u) {
    const y = ytId(u); if (y) return "https://www.youtube.com/embed/" + y;
    const v = vimeoId(u); if (v) return "https://player.vimeo.com/video/" + v;
    return u;
  }
  const blobURL = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

  /* a pasted value lands where the pointer is, never on top of a card */
  function dropValue(text, at) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (/^(https?:)?\/\//i.test(t) && !/\s/.test(t)) {
      if (IMG_RX.test(t) || /^data:image\//.test(t)) { mkImage(t, at); return true; }
      if (VID_RX.test(t)) { mkVideo(t, at, "file"); return true; }
      if (ytId(t) || vimeoId(t)) { mkVideo(ytEmbed(t), at, "embed"); return true; }
      /* Any other address is a page: it lands as a bookmark card and only
         renders once rendering is turned on. */
      mkWeb(t, at, {});
      return true;
    }
    if (/^data:image\//.test(t)) { mkImage(t, at); return true; }
    if (/^data:video\//.test(t)) { mkVideo(t, at, "file"); return true; }
    if (looksLikeCode(t)) {
      const lines = t.split("\n").length;
      mkCode(at, { src: t, lang: guessLang(t), h: Math.max(180, Math.min(420, snap(lines * 21 + 60))) });
      return true;
    }
    const n = mkNote(at);
    /* A note is body text and nothing else — there is no title row to
       render, so writing the first line into one simply lost it. */
    n.body = t;
    paint(n); save();
    return true;
  }

  let lastPointer = { x: innerWidth / 2, y: innerHeight / 2 };
  addEventListener("pointermove", (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);

  addEventListener("paste", async (e) => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT" || ae.isContentEditable)) return;
    e.preventDefault();
    const at = toWorld(lastPointer.x, lastPointer.y);
    const dt = e.clipboardData;
    const files = [...(dt.files || [])];
    const txt = (dt.getData("text/plain") || "").trim();

    /* something copied from this board comes back as itself */
    if (lastCopy) {
      if (txt && txt === lastCopy.text) { pasteOwn(at); return; }
      if (!txt && files.length === 1 && lastCopy.size && Math.abs(files[0].size - lastCopy.size) < 64) { pasteOwn(at); return; }
    }
    if (files.length) { for (const f of files) await handleFile(f, at); return; }
    if (txt) { dropValue(txt, at); return; }
    toast("nothing to paste");
  });

  app.addEventListener("dragover", (e) => e.preventDefault());
  app.addEventListener("drop", async (e) => {
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) { for (const f of files) await handleFile(f, at); return; }
    const t = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (t) dropValue(t, at);
  });

  async function pasteFromClipboard(at) {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const img = it.types.find((t) => t.startsWith("image/"));
        if (img) {
          const blob = await it.getType(img);
          if (lastCopy && lastCopy.size && Math.abs(blob.size - lastCopy.size) < 64) { pasteOwn(at); return; }
          mkImage(await blobURL(blob), at);
          return;
        }
      }
    } catch (e) { /* fall through to text */ }
    try {
      const t = await navigator.clipboard.readText();
      if (lastCopy && t.trim() === lastCopy.text) { pasteOwn(at); return; }
      if (t && t.trim()) dropValue(t, at);
      else toast("clipboard is empty");
    } catch (e) { toast("clipboard blocked — press ⌘V / Ctrl+V instead"); }
  }

  /* ------------------------------------------------------------------ *
   * menus
   * ------------------------------------------------------------------ */
  /* open the in-place rename on a card from the menu */
  function renameNow(o, sel) {
    const n = nodes.get(o.id);
    const t = n && n.querySelector(sel);
    if (t) { t.hidden = false; t.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); }
  }

  /* Right click → Download, for any card with bytes behind it. A code card
     is written out as text under its own name. */
  /* one place that puts a blob on disk */
  function saveBlob(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u; a.download = name || "file";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }

  function downloadObject(o) {
    if (o.type === "shelf") return downloadZip([o]);
    if (o.type !== "code") return saveFile(o);
    const name = o.name || ("untitled." + (o.lang && o.lang !== "txt" ? o.lang : "txt"));
    saveBlob(new Blob([o.src || ""], { type: "text/plain;charset=utf-8" }), name);
  }

  /* Every selected card that actually has bytes behind it. A code card
     always qualifies, since its text is the file. */
  function hasBytes(o) {
    if (o.type === "shelf") return (o.items || []).length > 0;
    return o.type === "code" || !!(o.src || o.url || o.ref);
  }
  function downloadSet(o) {
    /* Whatever is selected comes down together, with the card you asked
       from thrown in even if the press happened to land outside the
       selection. Previously an unselected right-click collapsed the whole
       selection first, so a multi-select download quietly became one file. */
    const ids = selected.size > 1 ? [...new Set([...selected, o.id])] : [o.id];
    return ids.map(byId).filter(Boolean).filter(hasBytes);
  }

  /* Name a card's file, keeping names unique inside one archive. */
  function fileNameFor(o, used) {
    let name = o.name || "";
    if (!name) {
      if (o.type === "code") name = "untitled." + (o.lang && o.lang !== "txt" ? o.lang : "txt");
      else if (o.type === "image") name = "image.png";
      else if (o.type === "video") name = "video.mp4";
      else name = "file";
    }
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const tail = dot > 0 ? name.slice(dot) : "";
    let n = 2;
    while (used.has(`${stem} (${n})${tail}`)) n++;
    const out = `${stem} (${n})${tail}`;
    used.add(out);
    return out;
  }

  async function bytesOf(o) {
    if (o.type === "code") return new TextEncoder().encode(o.src || "");
    /* The local copy first: a blob: URL from a previous session is dead
       after a reload, and fetching it throws instead of returning bytes. */
    if (o.ref && typeof Store !== "undefined") {
      const b = await Store.bytes(o.ref, o.url).catch(() => null);
      if (b) return b;
    }
    const href = o.src || o.url;
    if (!href) return null;
    try {
      const r = await fetch(href);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) { return null; }
  }

  /* The files behind a card: one for a plain card, one per row for a
     shelf. Names stay unique inside the archive. */
  async function entriesFor(o, used) {
    if (o.type === "shelf") {
      const out = [];
      for (const it of o.items || []) {
        const b = await bytesOf(it);
        if (b) out.push({ name: fileNameFor(it, used), bytes: b });
      }
      return out;
    }
    const b = await bytesOf(o);
    return b ? [{ name: fileNameFor(o, used), bytes: b }] : [];
  }

  /* Several cards at once come down as one archive. The packer is local
     (zip.js). The old build imported fflate from a CDN at the moment you
     clicked — the worst possible time to need the network: offline, on a
     blocked CDN, or opened from a file:// URL, the download never happened
     and nothing said so. */
  async function downloadZip(list) {
    toast(`packing ${list.length} files…`);
    const used = new Set();
    let entries = [];
    for (const o of list) entries = entries.concat(await entriesFor(o, used));
    if (!entries.length) return toast("nothing to download");

    let packed;
    try { packed = await Zip.write(entries); }
    catch (e) { console.warn("[space] zip failed", e); return toast("could not pack these files"); }

    const stamp = new Date().toISOString().slice(0, 10);
    saveBlob(new Blob([packed], { type: "application/zip" }), `space ${stamp}.zip`);
    toast(`${entries.length} files, zipped`);
  }

  /* just clear of a card, on its right */
  const nearOf = (o) => {
    const r = rectOf(o) || { x: o.x || 0, y: o.y || 0, w: 0, h: 0 };
    return { x: r.x + r.w + 120, y: r.y + 24 };
  };

  /* Right click → Zip. The archive becomes a file card of its own, the
     same size as any other file card, standing next to what it came from.
     The originals stay exactly where they are. */
  async function zipCard(list, at) {
    const used = new Set();
    let entries = [];
    for (const o of list) entries = entries.concat(await entriesFor(o, used));
    if (!entries.length) return toast("nothing to zip");

    let packed;
    try { packed = await Zip.write(entries); }
    catch (e) { console.warn("[space] zip failed", e); return toast("could not pack these files"); }

    const stem = list.length === 1 && list[0].name
      ? String(list[0].name).replace(/\.[^.]+$/, "") : "archive";
    const name = (stem || "archive") + ".zip";

    let rec = null;
    try { rec = await Store.putBytes(packed, name, "application/zip"); }
    catch (e) { console.warn("[space] local file store failed", e); }

    const o = mkFile(at, {
      name, mime: "application/zip", size: packed.length,
      src: rec ? rec.url : "", ref: rec ? rec.ref : null,
    });
    save(); Sync.obj(o);
    toast(`zipped ${entries.length} files`);
  }

  /* Right click a .zip → Extract. The entries are unpacked into a shelf
     beside the archive, which itself stays put. Folders are flattened: a
     shelf is one flat field, with nothing nested in it. */
  async function extractZip(o) {
    if (typeof Zip === "undefined") return toast("unzipping is not available here");
    const raw = await bytesOf(o);
    if (!raw) return toast("no stored copy of this archive");

    let list;
    try { list = await Zip.read(raw); }
    catch (e) { return toast(String((e && e.message) || "this archive cannot be read")); }

    const items = [];
    for (const f of list) {
      let rec = null;
      try { rec = await Store.putBytes(f.bytes, f.name, ""); }
      catch (e) { console.warn("[space] local file store failed", e); }
      items.push({
        name: f.name, mime: (rec && rec.mime) || "", size: f.size,
        ref: rec ? rec.ref : null, url: "", src: rec ? rec.url : "",
      });
    }
    if (!items.length) return toast("the archive is empty");

    const r = rectOf(o) || { x: o.x || 0, y: o.y || 0, w: 192, h: 156 };
    snapshot();
    const shelf = { type: "shelf", id: uid(), w: 320, items };
    shelf.h = shelfHeight(shelf);
    const spot = freeSpot(r.x + r.w + 24, r.y, shelf.w, shelf.h);
    shelf.x = spot.x; shelf.y = spot.y;
    sync(shelf);
    doc.objs.push(shelf);
    render(); save(); Sync.obj(shelf); select(shelf.id);
    toast(`${items.length} files extracted`);
  }

  function objectMenu(o, x, y) {
    const items = [];

    if (o.type === "note") {
      items.push({ label: "Codeblock: off", run: () => toCode(o) });
      items.push({ sep: 1 });
    }

    if (o.type === "code") {
      items.push({ label: "Codeblock: on", run: () => toNote(o) });
      // the language is the small tag on the rail: click it and type
      items.push({ label: o.md ? "Markdown: on" : "Markdown: off", run: () => { snapshot(); o.md = !o.md; paint(o); save(); rebuildRail(o); } });
      items.push({ label: o.wrap ? "Wrap: on" : "Wrap: off", run: () => { o.wrap = !o.wrap; paint(o); save(); rebuildRail(o); } });
      items.push({ label: "Rename", run: () => renameNow(o, ".fname") });
      items.push({ sep: 1 });
    }

    if (o.type === "sketch") {
      items.push({ swatch: (c) => { o.color = c; o.erase = false; save(); const p = nodes.get(o.id).querySelector(".pal"); if (p) buildPal(o, p); }, current: o.color });
      items.push({ num: { label: "Size", value: wIndex(o.size || WEIGHTS[1]), min: 1, max: WEIGHTS.length, run: (v) => { o.size = WEIGHTS[v - 1]; save(); const p = nodes.get(o.id).querySelector(".pal"); if (p) buildPal(o, p); } } });
      items.push({ label: "Clear", run: () => { snapshot(); o.strokes = []; paint(o); save(); } });
      items.push({ sep: 1 });
    }

    if (o.type === "image") {
      // A picture is always shown filled now, so there is no frame row here.
      items.push({ text: { label: "Link", value: /^https?:/.test(o.src || "") ? o.src : "", run: (v) => { snapshot(); o.src = v; paint(o); naturalSize(o, true); save(); } } });
      items.push({ label: "Paste", run: () => clipboardInto(o) });
      items.push({ label: "Reset", run: () => naturalSize(o) });
      items.push({ sep: 1 });
    }

    if (o.type === "video") {
      items.push({ text: { label: "Link", value: /^https?:/.test(o.src || "") ? o.src : "", run: (v) => { snapshot(); o.kind = (ytId(v) || vimeoId(v)) ? "embed" : "file"; o.src = o.kind === "embed" ? ytEmbed(v) : v; paint(o); save(); rebuildRail(o); } } });
      items.push({ label: "Paste", run: () => clipboardInto(o) });
      // fit/fill genuinely matters for video: a clip is rarely the card's shape
      items.push({ label: o.fit === "contain" ? "Frame: fit" : "Frame: fill", run: () => { o.fit = o.fit === "contain" ? "cover" : "contain"; paint(o); save(); rebuildRail(o); } });
      items.push({ label: o.loop ? "Loop: on" : "Loop: off", run: () => { o.loop = !o.loop; paint(o); save(); rebuildRail(o); } });
      items.push({ label: o.muted === false ? "Sound: on" : "Sound: off", run: () => { o.muted = o.muted === false; paint(o); save(); rebuildRail(o); } });
      items.push({ sep: 1 });
    }

    if (o.type === "file") {
      items.push({ label: "Rename", run: () => renameNow(o, ".fn") });
      /* An archive can be opened where it lies: Extract unpacks it into a
         shelf beside the card, and the card itself stays. */
      if (ext(o.name) === "zip" || o.mime === "application/zip") {
        items.push({ label: "Extract", run: () => extractZip(o) });
      }
      items.push({ sep: 1 });
    }

    if (o.type === "shelf") {
      items.push({ label: "Zip", run: () => zipCard([o], nearOf(o)) });
      items.push({ sep: 1 });
    }

    if (o.type === "web") {
      /* Off until you say otherwise: a page arrives as a bookmark, and only
         runs — sandboxed — once rendering is turned on. */
      items.push({ label: o.render ? "Render: on" : "Render: off", run: () => { snapshot(); o.render = !o.render; paint(o); save(); Sync.obj(o); } });
      items.push({ text: { label: "Link", value: /^https?:/.test(o.src || "") ? o.src : "", run: (v) => { snapshot(); o.src = v; o.ref = null; o.url = ""; o.name = ""; paint(o); save(); Sync.obj(o); } } });
      items.push({ sep: 1 });
    }

    if (VEC.includes(o.type)) {
      items.push({ swatch: (c) => { snapshot(); o.color = c; drawVectors(); save(); }, current: o.color });
      items.push({ num: { label: "Outline", value: Math.max(1, Math.min(5, Math.round(o.wdt || 2))), min: 1, max: 5, run: (v) => { snapshot(); o.wdt = v; drawVectors(); save(); } } });
      items.push({ label: o.dash ? "Dashed: on" : "Dashed: off", run: () => { snapshot(); o.dash = !o.dash; drawVectors(); save(); } });
      if (o.type === "curve" || o.type === "poly") {
        items.push({ label: o.closed ? "Closed: on" : "Closed: off", run: () => { snapshot(); o.closed = !o.closed; drawVectors(); save(); Sync.obj(o); } });
        /* Relax settles the line you drew: the same nodes, the same ends,
           kinks pulled out, spacing evened, and each press settles it a
           little further. It used to re-run recognition over the node list,
           which is a different job — that could change the node count under
           your hands, refit a different shape entirely, or on an already
           tidy curve do nothing visible at all. */
        items.push({ label: "Relax", run: () => { snapshot(); o.pts = G.relax(o.pts, !!o.closed, 1); drawVectors(); save(); Sync.obj(o); } });
      }
      if (o.type === "link" && (o.mid || []).length) {
        items.push({ label: "Straighten", run: () => { snapshot(); o.mid = []; drawVectors(); save(); } });
      }
      items.push({ sep: 1 });
    }

    /* Download, Copy, Delete — always the last three, always in that order.
       With several cards selected the download is one archive rather than a
       burst of separate saves. "Bring to front" is gone: dragging a card
       already raises it, so the row was only ever a duplicate. */
    const haul = downloadSet(o);
    if (haul.length === 1) items.push({ label: "Download", run: () => downloadObject(haul[0]) });
    else if (haul.length > 1) items.push({ label: `Download ${haul.length} as .zip`, run: () => downloadZip(haul) });
    // Zip keeps the archive on the board instead of sending it to disk
    if (haul.length && o.type !== "shelf") items.push({ label: "Zip", run: () => zipCard(haul, nearOf(o)) });
    items.push({ label: "Copy", run: () => copyObject(o) });
    items.push({ label: "Delete", hot: 1, run: () => remove(o) });
    openMenu(x, y, items);
  }

  /* note ↔ code, in place: same card, same size, same spot */
  function toCode(o) {
    snapshot();
    const src = [o.title, o.body].filter(Boolean).join("\n");
    delete o.title; delete o.body; delete o.mono; delete o.size;
    o.type = "code"; o.src = src; o.lang = guessLang(src); o.md = false; o.wrap = false;
    render(); save(); select(o.id);
  }
  function toNote(o) {
    snapshot();
    const body = o.src || "";
    delete o.src; delete o.lang; delete o.md; delete o.wrap; delete o.name; delete o.title;
    o.type = "note"; o.body = body; o.size = 13.5;
    render(); save(); select(o.id);
  }

  function canvasMenu(x, y) {
    const at = toWorld(x, y);
    openMenu(x, y, [
      { label: "Text note", run: () => mkNote(at) },
      { label: "Drawing", run: () => mkSketch(at) },
      { label: "Code block", run: () => mkCode(at) },
      { sep: 1 },
      { label: "Smart draw: " + (drawMode ? "on" : "off"), run: () => setDraw(!drawMode) },
      { label: "Couple", run: () => setTidy(true) },
      { sep: 1 },
      { label: "Paste here", run: () => pasteFromClipboard(at) },
      { label: "Reset view", run: () => { camT.x = 0; camT.y = 0; camT.z = 1; kick(); } },
    ]);
  }

  /* ------------------------------------------------------------------ *
   * smart draw + couple (lasso tidy)
   * ------------------------------------------------------------------ */
  let drawMode = false, tidyMode = false;
  function setDraw(on) {
    drawMode = on;
    if (on) tidyMode = false;
    app.classList.toggle("draw", drawMode);
    app.classList.toggle("tidy", tidyMode);
    /* No chip and no banner. The cursor already tells you the mode, and a
       second thing repeating it is just clutter.

       Leaving the mode also has to take the hover dot with it. It used to
       be left behind, frozen wherever it last sat, and since nothing ever
       moved it again it looked exactly like a dead pixel. */
    modeEl.hidden = true;
    if (!on) { anchorA.classList.remove("on"); anchorB.classList.remove("on"); }
  }
  /* couple has no chip and no label of its own: the cursor is the whole
     affordance, and it leaves as soon as it has been used once */
  function setTidy(on) {
    tidyMode = on;
    if (on) { drawMode = false; modeEl.hidden = true; }
    app.classList.toggle("tidy", tidyMode);
    app.classList.toggle("draw", drawMode);
  }

  function objBBox(o) {
    if (isBox(o)) return rectOf(o);
    if (o.type === "rect" || o.type === "ellipse") return { x: o.x, y: o.y, w: o.w, h: o.h };
    if (o.pts && o.pts.length) { const b = G.bbox(o.pts); return { x: b.x, y: b.y, w: b.w, h: b.h }; }
    if (o.a && o.b) return { x: Math.min(o.a.x, o.b.x), y: Math.min(o.a.y, o.b.y), w: Math.abs(o.b.x - o.a.x), h: Math.abs(o.b.y - o.a.y) };
    if (o.type === "link") {
      const F = linkFrame(o); if (!F) return null;
      const ps = [F.p1, F.p2, ...F.mids];
      const b = G.bbox(ps);
      return { x: b.x, y: b.y, w: b.w, h: b.h };
    }
    return null;
  }
  const centreOf = (o) => { const b = objBBox(o); return b && { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
  function shiftVector(o, dx, dy) {
    if (o.pts) o.pts.forEach((p) => { p.x += dx; p.y += dy; });
    else if (o.a) { o.a.x += dx; o.a.y += dy; o.b.x += dx; o.b.y += dy; }
    else if (o.type === "rect" || o.type === "ellipse") { o.x += dx; o.y += dy; }
  }
  function inPoly(pt, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  }

  /* pack the lassoed cards into tidy rows around their own centre, and carry
     any loose ink with the card it was sitting next to */
  function coupleInside(poly) {
    const inside = doc.objs.filter((o) => { const c = centreOf(o); return c && inPoly(c, poly); });
    const boxes = inside.filter(isBox);
    if (boxes.length < 2) { toast("draw around at least two things"); return; }
    snapshot();
    const before = new Map(boxes.map((o) => [o.id, { x: o.x + o.w / 2, y: o.y + o.h / 2 }]));

    /* This used to reflow everything into centred rows, which is why cards
       lost their places: a card on the right could end up on the left
       simply because it was tall. Tidy keeps the arrangement instead.

       It groups by explicit links first, then by proximity, then by kind
       (text near text), sorts each group in reading order, contracts each
       group toward its own centre and the groups toward the board centre,
       pushes apart only along the shallower axis of each overlap, and
       finally springs everything a little way back toward where it
       started. The board gets tighter; nothing teleports. */
    const ids = new Set(boxes.map((o) => o.id));
    const links = doc.objs
      .filter((o) => o.type === "link" && o.from && o.to && ids.has(o.from.id) && ids.has(o.to.id))
      .map((o) => ({ id: o.id, a: o.from.id, b: o.to.id }));

    const plan = Tidy.plan(
      boxes.map((o) => ({ id: o.id, kind: o.type, x: o.x, y: o.y, w: o.w, h: o.h })),
      links,
      { gap: SNAP * 2, snap: SNAP }
    );

    for (const m of plan.moves) {
      const t = byId(m.id);
      if (t) { t.x = m.x; t.y = m.y; }
    }

    /* a link that would now pass underneath a card gets its waypoint
       nudged aside, so the curve routes around instead of tunnelling */
    for (const id of Object.keys(plan.mids)) {
      const lo = byId(id);
      if (!lo || lo.type !== "link") continue;
      const F = linkFrame(lo);
      if (!F) continue;
      lo.mid = plan.mids[id].map((p) => linkLocal(F, p));
    }
    /* loose ink follows the nearest card so diagrams stay readable */
    for (const o of inside) {
      if (isBox(o) || o.type === "link") continue;
      const c = centreOf(o); if (!c) continue;
      let best = null, bd = Infinity;
      for (const b of boxes) {
        const p = before.get(b.id);
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d < bd) { bd = d; best = b; }
      }
      if (!best) continue;
      const p = before.get(best.id);
      shiftVector(o, best.x + best.w / 2 - p.x, best.y + best.h / 2 - p.y);
    }
    setTidy(false);
    kick(); drawVectors(); save();
    boxes.forEach(Sync.obj);
  }

  /* anchor dots: they ride just outside a border and slide to the closest
     point as the pointer approaches */
  const ANCHOR_R = 34;
  function anchorNear(p) {
    let best = null;
    for (const o of doc.objs) {
      if (!isBox(o)) continue;
      const r = rectOf(o);
      const n = G.nearestOnRect(r, p);
      if (n.d < ANCHOR_R && (!best || n.d < best.d)) {
        best = { id: o.id, ax: n.ax, ay: n.ay, x: n.p.x, y: n.p.y, d: n.d };
      }
    }
    return best;
  }
  /* The dot sits exactly on the border stripe, centred across it, and
     slides along it. It used to float 11px outside the card, which read as
     a detached bead hovering near the edge rather than a grip on it. */
  function showAnchor(node, a) {
    if (!a) { node.classList.remove("on"); return; }
    const s = toScreen(a.x, a.y);
    node.style.transform = `translate(${s.x}px,${s.y}px)`;
    node.classList.add("on");
  }

  let stroke = null, strokeFrom = null;
  function beginStroke(e) {
    const p = toWorld(e.clientX, e.clientY);
    stroke = [p];
    strokeFrom = anchorNear(p);
    if (strokeFrom) { stroke[0] = { x: strokeFrom.x, y: strokeFrom.y }; }
  }
  function paintStroke(e) {
    const p = toWorld(e.clientX, e.clientY);
    stroke.push(p);
    sctx.clearRect(0, 0, innerWidth, innerHeight);
    sctx.strokeStyle = "rgba(233,231,228,.85)";
    sctx.lineWidth = 1.6; sctx.lineCap = "round"; sctx.lineJoin = "round";
    sctx.beginPath();
    const s0 = toScreen(stroke[0].x, stroke[0].y);
    sctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < stroke.length; i++) { const s = toScreen(stroke[i].x, stroke[i].y); sctx.lineTo(s.x, s.y); }
    sctx.stroke();
    showAnchor(anchorA, strokeFrom);
    const to = anchorNear(p);
    showAnchor(anchorB, to && (!strokeFrom || to.id !== strokeFrom.id) ? to : null);
  }

  function midsFromStroke(pts, p1, p2) {
    const d = G.dist(p1, p2) || 1;
    const ux = (p2.x - p1.x) / d, uy = (p2.y - p1.y) / d;
    const simp = G.rdp(G.smooth(G.resample(pts, Math.max(6, G.pathLength(pts) / 30)), 2), Math.max(3, d * 0.025));
    const out = [];
    for (const p of simp.slice(1, -1)) {
      const dx = p.x - p1.x, dy = p.y - p1.y;
      const t = (dx * ux + dy * uy) / d;
      const off = -dx * uy + dy * ux;
      if (t > 0.06 && t < 0.94) out.push({ t, o: off });
    }
    out.sort((a, b) => a.t - b.t);
    while (out.length > 5) {
      let mi = 0;
      for (let i = 1; i < out.length; i++) if (Math.abs(out[i].o) < Math.abs(out[mi].o)) mi = i;
      out.splice(mi, 1);
    }
    return out;
  }

  function commitStroke() {
    sctx.clearRect(0, 0, innerWidth, innerHeight);
    anchorA.classList.remove("on");
    anchorB.classList.remove("on");
    const raw = stroke; stroke = null;
    if (!raw || raw.length < 3) return;
    const last = raw[raw.length - 1];
    const to = anchorNear(last);

    if (strokeFrom && to && to.id !== strokeFrom.id) {
      snapshot();
      const o = {
        id: uid(), type: "link",
        from: { id: strokeFrom.id, ax: strokeFrom.ax, ay: strokeFrom.ay },
        to: { id: to.id, ax: to.ax, ay: to.ay },
        mid: midsFromStroke(raw, { x: strokeFrom.x, y: strokeFrom.y }, { x: to.x, y: to.y }),
        arrow: true, wdt: 2,
      };
      doc.objs.push(o);
      drawVectors(); save(); select(o.id); Sync.obj(o);
      strokeFrom = null;
      return;
    }
    strokeFrom = null;

    const g = G.recognize(raw);
    if (!g) return;
    snapshot();
    const o = Object.assign({ id: uid(), wdt: 2 }, g);
    o.type = g.kind; delete o.kind;
    doc.objs.push(o);
    drawVectors(); save(); select(o.id); Sync.obj(o);
  }

  /* ------------------------------------------------------------------ *
   * board pointer handling
   * ------------------------------------------------------------------ */
  function startMarquee(e) {
    const div = document.createElement("div");
    div.className = "marq";
    app.appendChild(div);
    const sx = e.clientX, sy = e.clientY;
    const base = [...selected];
    const move = (ev) => {
      const x = Math.min(sx, ev.clientX), y = Math.min(sy, ev.clientY);
      const w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy);
      div.style.left = x + "px"; div.style.top = y + "px";
      div.style.width = w + "px"; div.style.height = h + "px";
      const a = toWorld(x, y), b = toWorld(x + w, y + h);
      const ids = new Set(base);
      for (const o of doc.objs) {
        const r = objBBox(o);
        if (r && r.x < b.x && r.x + r.w > a.x && r.y < b.y && r.y + r.h > a.y) ids.add(o.id);
      }
      setSelection([...ids]);
    };
    pointerSession({ move, up: () => div.remove() });
  }

  function startLasso(e) {
    const poly = [toWorld(e.clientX, e.clientY)];
    const move = (ev) => {
      poly.push(toWorld(ev.clientX, ev.clientY));
      sctx.clearRect(0, 0, innerWidth, innerHeight);
      sctx.strokeStyle = "rgba(233,231,228,.7)";
      sctx.setLineDash([5, 5]);
      sctx.lineWidth = 1.4;
      sctx.beginPath();
      const s0 = toScreen(poly[0].x, poly[0].y);
      sctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < poly.length; i++) { const s = toScreen(poly[i].x, poly[i].y); sctx.lineTo(s.x, s.y); }
      sctx.closePath();
      sctx.stroke();
      sctx.setLineDash([]);
    };
    const up = () => {
      sctx.clearRect(0, 0, innerWidth, innerHeight);
      if (poly.length > 4) coupleInside(poly);
      else setTidy(false);
    };
    pointerSession({ move, up });
  }

  function startPan(e) {
    const sx = e.clientX, sy = e.clientY;
    const c = cam(), x0 = c.x, y0 = c.y;
    app.classList.add("panning");
    const move = (ev) => {
      c.x = x0 + (ev.clientX - sx); c.y = y0 + (ev.clientY - sy);
      syncCam(); applyCam();
      doc.objs.forEach((o) => { if (isBox(o)) place(o); });
    };
    const up = () => {
      app.classList.remove("panning");
      save();
    };
    pointerSession({ move, up });
  }

  const JOIN = 14;        // screen px: how close two nodes must land to fuse
  const HOLD_MS = 520;    // press this long, without wandering, to break a seam

  /* The quietest confirmation there is: the dot swells by a pixel and
     settles. No flash, no ring, no colour change. */
  function blinkNode(i) {
    const n = inkHandles.querySelector(`.node[data-i="${i}"]`);
    if (!n) return;
    n.classList.remove("tick");
    void n.getBoundingClientRect();
    n.classList.add("tick");
    setTimeout(() => n.classList.remove("tick"), 300);
  }

  /* A seam is the node where a closed outline meets itself. */
  const isSeam = (o, kind, key) =>
    kind === "pts" && o.closed && o.pts && o.pts.length > 2 &&
    (key === 0 || key === o.pts.length - 1);

  /* Dropping a node on top of another joins them. On the two loose ends of
     an open outline that closes the outline; anywhere else the two points
     simply become one. */
  function fuseNode(o, kind, key) {
    if (kind !== "pts" || !o.pts || o.pts.length < 3) return;
    const p = o.pts[key];
    let hit = -1, best = JOIN / (cam().z || 1);
    o.pts.forEach((q, i) => {
      if (i === key) return;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < best) { best = d; hit = i; }
    });
    if (hit < 0) return;

    const last = o.pts.length - 1;
    const ends = (key === 0 && hit === last) || (hit === 0 && key === last);
    const mid = { x: (p.x + o.pts[hit].x) / 2, y: (p.y + o.pts[hit].y) / 2 };

    if (ends) {
      if (o.closed) return;
      o.pts[key] = mid;
      o.pts.splice(hit, 1);
      o.closed = true;
    } else {
      o.pts[Math.min(key, hit)] = mid;
      o.pts.splice(Math.max(key, hit), 1);
    }
    drawVectors();
    blinkNode(Math.min(key, hit));
  }

  /* dragging a spline node moves that node only — nothing else shifts */
  function startNodeDrag(o, kind, key) {
    let moved = false;
    const home = kind === "pts" ? o.pts[key] : kind === "end" ? o[key] : null;
    const origin = home ? { x: home.x, y: home.y } : null;
    let far = !origin;

    /* Press and hold on a seam and the outline opens back up. Carrying the
       node somewhere and then resting does not count: the timer is armed
       only while the node has never left where it started. */
    let hold = 0;
    if (isSeam(o, kind, key)) {
      hold = setTimeout(() => {
        hold = 0;
        if (far) return;
        snapshot();
        o.closed = false;
        drawVectors(); save();
        blinkNode(key);
      }, HOLD_MS);
    }
    const disarm = () => { if (hold) { clearTimeout(hold); hold = 0; } };

    const move = (ev) => {
      const p = toWorld(ev.clientX, ev.clientY);
      if (!far && Math.hypot(p.x - origin.x, p.y - origin.y) * (cam().z || 1) > 3) {
        far = true; disarm();
      }
      if (!far) return;                     // a hand tremor is not a drag
      if (!moved) { snapshot(); moved = true; }
      if (kind === "pts") o.pts[key] = { x: p.x, y: p.y };
      else if (kind === "end") o[key] = { x: p.x, y: p.y };
      else if (kind === "mid") {
        const F = linkFrame(o);
        if (F) { const l = linkLocal(F, p); o.mid[key] = l; }
      } else if (kind === "barb") {
        /* A barb is kept as a length and an angle relative to where the
           line is heading, not as a point: move or bend the arrow later and
           the head still points the right way. */
        const e = endsOf(o);
        if (e && e.prev) {
          const heading = Math.atan2(e.tip.y - e.prev.y, e.tip.x - e.prev.x);
          const scale = 1 + (o.wdt || 2) * 0.22;
          const len = Math.hypot(p.x - e.tip.x, p.y - e.tip.y) / scale;
          let ang = Math.atan2(p.y - e.tip.y, p.x - e.tip.x) - heading;
          ang = Math.atan2(Math.sin(ang), Math.cos(ang));   // never wrap the long way
          o.head = o.head || {};
          if (!o.head.barbs || o.head.barbs.length < 2) {
            const d = 13, a = Math.PI * 0.82;
            o.head.barbs = [{ len: d, ang: a }, { len: d, ang: -a }];
          }
          o.head.barbs[key] = { len: Math.max(4, Math.min(60, len)), ang };
        }
      }
      drawVectors();
    };
    const up = () => {
      disarm();
      if (moved) { fuseNode(o, kind, key); save(); Sync.obj(o); }
    };
    pointerSession({ move, up, grab: true });
  }

  /* grabbing the ribbon itself: pull the nearest node, or drop a new one
     right where you grabbed if there is nothing close */
  function startBend(e, o) {
    const p = toWorld(e.clientX, e.clientY);
    const near = 18 / cam().z;
    if (o.type === "link") {
      const F = linkFrame(o);
      if (!F) return;
      let bi = -1, bd = Infinity;
      F.mids.forEach((m, i) => { const d = G.dist(m, p); if (d < bd) { bd = d; bi = i; } });
      if (bi >= 0 && bd < near) return startNodeDrag(o, "mid", bi);
      snapshot();
      const l = linkLocal(F, p);
      o.mid = o.mid || [];
      let at = o.mid.findIndex((m) => m.t > l.t);
      if (at < 0) at = o.mid.length;
      o.mid.splice(at, 0, l);
      drawVectors();
      return startNodeDrag(o, "mid", at);
    }
    if (o.type === "curve" || o.type === "poly") {
      const n = G.nearestNode(o.pts, p);
      if (n && n.d < near) return startNodeDrag(o, "pts", n.i);
      const s = G.nearestSegment(o.pts, p, o.closed);
      if (!s) return;
      snapshot();
      o.pts.splice(s.i + 1, 0, { x: p.x, y: p.y });
      drawVectors();
      return startNodeDrag(o, "pts", s.i + 1);
    }
    if (o.type === "line" || o.type === "arrow") {
      const da = G.dist(o.a, p), db = G.dist(o.b, p);
      if (Math.min(da, db) < near) return startNodeDrag(o, "end", da < db ? "a" : "b");
      return startDrag(e, o);
    }
    return startDrag(e, o);
  }

  function dragCorner(e, o, cx, cy) {
    const fx = cx ? o.x : o.x + o.w;
    const fy = cy ? o.y : o.y + o.h;
    let moved = false;
    const move = (ev) => {
      const p = toWorld(ev.clientX, ev.clientY);
      if (!moved) { snapshot(); moved = true; }
      let x = p.x, y = p.y;
      if (ev.shiftKey) { const s = Math.max(Math.abs(x - fx), Math.abs(y - fy)); x = fx + Math.sign(x - fx) * s; y = fy + Math.sign(y - fy) * s; }
      o.x = Math.min(fx, x); o.y = Math.min(fy, y);
      o.w = Math.max(12, Math.abs(x - fx)); o.h = Math.max(12, Math.abs(y - fy));
      drawVectors();
    };
    const up = () => { if (moved) { save(); Sync.obj(o); } };
    pointerSession({ move, up, grab: true });
  }

  ink.addEventListener("pointerdown", (e) => {
    /* A modifier suspends smart draw, so a press on a shape or one of its
       points does what it would with drawing off: it moves the thing. */
    const plain = e.ctrlKey || e.metaKey;
    if (e.button !== 0 || tidyMode) return;
    if (drawMode && !plain) return;
    const t = e.target;
    if (t.classList.contains("node")) {
      /* preventDefault stops the browser starting its own drag of the SVG
         circle. Without it, grabbing a handle sometimes dragged a ghost
         image of the dot instead of moving the node, and the real node
         never followed the pointer. */
      e.preventDefault();
      e.stopPropagation();
      const g = t.closest("g") || {};
      const o = byId(selection);
      if (!o) return;
      if (e.altKey && o.pts && o.pts.length > 2) {
        snapshot();
        o.pts.splice(+t.dataset.i, 1);
        drawVectors(); save();
        return;
      }
      if (t.dataset.barb != null) return startNodeDrag(o, "barb", +t.dataset.barb);
      if (t.dataset.i != null) return startNodeDrag(o, "pts", +t.dataset.i);
      if (t.dataset.end) return startNodeDrag(o, "end", t.dataset.end);
      if (t.dataset.m != null) return startNodeDrag(o, "mid", +t.dataset.m);
      void g;
      return;
    }
    if (t.classList.contains("box")) {
      e.preventDefault();
      e.stopPropagation();
      const o = byId(selection);
      if (o) dragCorner(e, o, +t.dataset.cx, +t.dataset.cy);
      return;
    }
    if (t.classList.contains("hit")) {
      e.preventDefault();
      e.stopPropagation();
      const id = t.parentNode.dataset.id;
      const o = byId(id);
      if (!o) return;
      if (plain && !drawMode) { select(id, true); return; }
      /* The first press on a shape only selects it, which is what puts its
         nodes on screen. Nothing gets grabbed. Before, the press went
         straight to the nearest node, so a plain click yanked whichever
         point happened to be closest — frequently not the one you were
         pointing at, and on a shape with no nodes drawn yet you could not
         even see what you were about to hit. Once the dots are visible and
         you can aim, the next press edits them. */
      const armed = selection === id && selected.has(id);
      if (!armed) { select(id); return startDrag(e, o); }
      if (e.shiftKey) return startDrag(e, o);
      startBend(e, o);
    }
  });

  ink.addEventListener("contextmenu", (e) => {
    const t = e.target;
    if (!t.classList.contains("hit")) return;
    e.preventDefault(); e.stopPropagation();
    const o = byId(t.parentNode.dataset.id);
    if (!o) return;
    if (!selected.has(o.id)) select(o.id);
    objectMenu(o, e.clientX, e.clientY);
  });

  app.addEventListener("pointerdown", (e) => {
    if (menuOpen && !menuEl.contains(e.target)) closeMenu();
    if (e.target.closest(".obj") || e.target.closest(".menu")) return;
    if (e.button === 1) return startPan(e);
    if (e.button !== 0) return;
    const plain = e.ctrlKey || e.metaKey;       // suspends smart draw
    if (tidyMode) { e.preventDefault(); return startLasso(e); }
    if (drawMode && !plain) { e.preventDefault(); beginStroke(e); return; }
    // drawing suspended: the background does what it always does, it moves
    if (drawMode && plain) { select(null); return startPan(e); }
    if (plain) { e.preventDefault(); return startMarquee(e); }
    if (e.shiftKey || e.altKey) return startPan(e);
    select(null);
    startPan(e);
  });

  addEventListener("pointermove", (e) => {
    if (stroke) { paintStroke(e); return; }
    if (!drawMode) return;
    if (e.ctrlKey || e.metaKey) {
      // drawing is suspended: no anchor hints, nothing is about to be drawn
      anchorA.classList.remove("on");
      anchorB.classList.remove("on");
      return;
    }
    const p = toWorld(e.clientX, e.clientY);
    showAnchor(anchorA, anchorNear(p));
    anchorB.classList.remove("on");
  });
  addEventListener("pointerup", () => { if (stroke) commitStroke(); });

  app.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".obj") || e.target.closest(".menu")) return;
    e.preventDefault();
    canvasMenu(e.clientX, e.clientY);
  });

  /* ------------------------------------------------------------------ *
   * wheel: pan, and a zoom that glides to its target
   * ------------------------------------------------------------------ */
  app.addEventListener("wheel", (e) => {
    // let a scrollable card keep its own wheel
    const sc = e.target.closest(".body,.view,textarea");
    if (sc && !e.ctrlKey && !e.metaKey) {
      const room = sc.scrollHeight - sc.clientHeight;
      if (room > 2 && ((e.deltaY < 0 && sc.scrollTop > 0) || (e.deltaY > 0 && sc.scrollTop < room - 1))) return;
    }
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const c = cam();
      const w = toWorld(e.clientX, e.clientY);          // point under the cursor, now
      const z = Math.max(0.2, Math.min(3.2, camT.z * Math.pow(0.9988, e.deltaY * 2.2)));
      camT.z = z;
      camT.x = e.clientX - w.x * z;                     // keep that point pinned
      camT.y = e.clientY - w.y * z;
      void c;
    } else {
      camT.x -= e.deltaX;
      camT.y -= e.deltaY;
    }
    kick();
    save();
  }, { passive: false });

  /* ------------------------------------------------------------------ *
   * keyboard
   * ------------------------------------------------------------------ */
  /* A text field owns undo only once you have actually typed in it. Clicking
     into a note and pressing Ctrl+Z used to do nothing whatsoever: focus sat
     in the body, so the board stood aside, and the field's own history was
     empty. Focus arms the field; the first keystroke is what claims it. */
  addEventListener("focusin", (e) => {
    const t = e.target;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) t._edited = false;
  }, true);
  addEventListener("input", (e) => { if (e.target) e.target._edited = true; }, true);

  addEventListener("keydown", (e) => {
    const ae = document.activeElement;
    const editing = !!(ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT" || ae.isContentEditable));
    const typing = editing && ae._edited !== false;
    const mod = e.metaKey || e.ctrlKey;
    /* e.code is the key under your finger; e.key is the character the
       current layout makes of it. On a Cyrillic layout Ctrl+Z arrives as
       "я" and every shortcut here quietly stopped working — which is
       exactly why undo looked dead. Shortcuts read the key itself. */
    const code = e.code || "";

    if (mod && code === "KeyZ") {
      if (typing) return;
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (mod && code === "KeyY") { if (typing) return; e.preventDefault(); redo(); return; }
    if (mod && code === "KeyC" && !editing) {
      const o = selection && byId(selection);
      if (o) { e.preventDefault(); copyObject(o); }
      return;
    }
    if (mod && code === "KeyA" && !editing) {
      e.preventDefault();
      setSelection(doc.objs.map((o) => o.id));
      return;
    }
    if (mod && (e.key === "0" || code === "Digit0")) { e.preventDefault(); camT.x = 0; camT.y = 0; camT.z = 1; kick(); return; }
    if (mod && (e.key === "=" || e.key === "+" || e.key === "-" || code === "Equal" || code === "Minus")) {
      e.preventDefault();
      const k = (e.key === "-" || code === "Minus") ? 1 / 1.18 : 1.18;
      const w = toWorld(innerWidth / 2, innerHeight / 2);
      camT.z = Math.max(0.2, Math.min(3.2, camT.z * k));
      camT.x = innerWidth / 2 - w.x * camT.z;
      camT.y = innerHeight / 2 - w.y * camT.z;
      kick();
      return;
    }
    if (editing) return;

    if (e.key === "Escape") { closeMenu(); setDraw(false); setTidy(false); select(null); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      const o = selection && byId(selection);
      if (o) { e.preventDefault(); remove(o); }
      return;
    }
    if (mod) return;
    const at = toWorld(lastPointer.x, lastPointer.y);
    if (code === "KeyN") { e.preventDefault(); mkNote(at); }
    if (code === "KeyS") { e.preventDefault(); mkSketch(at); }
    if (code === "KeyC") { e.preventDefault(); mkCode(at); }
    if (code === "KeyD") { e.preventDefault(); setDraw(!drawMode); }
    if (code === "KeyG") { e.preventDefault(); setTidy(!tidyMode); }
    if (code === "KeyA") { e.preventDefault(); setSelection(doc.objs.map((o) => o.id)); }
  });

  /* Smart draw steps aside while a modifier is held. Show it the moment the
     key goes down instead of on the next press: the crosshair drops, so it
     reads as "this drag will move things" before anything moves. */
  const syncBypass = (e) => app.classList.toggle("bypass", !!(e.ctrlKey || e.metaKey));
  addEventListener("keydown", syncBypass);
  addEventListener("keyup", syncBypass);
  addEventListener("blur", () => app.classList.remove("bypass"));

  addEventListener("resize", () => {
    fitScratch();
    Field.resize();
    applyCam();
    doc.objs.forEach((o) => { if (isBox(o)) { place(o); if (o.type === "sketch") redrawSketch(o); } });
    drawBlobs();
  });

  /* ------------------------------------------------------------------ *
   * first run
   * ------------------------------------------------------------------ */
  function seed() {
    const mk = (o) => { o.id = uid(); sync(o); doc.objs.push(o); return o; };
    const a = mk({ type: "note", x: -432, y: -204, w: 264, h: 204, size: 13.5,
      body: "Space\n\nRight click anywhere.\n\nDrag a card from any edge, resize from any edge.\nCtrl+drag on empty space to box-select.\nCtrl+wheel to zoom." });
    mk({ type: "note", x: -48, y: -180, w: 252, h: 168, size: 13.5,
      body: "Smart draw\n\nTurn it on, then sketch:\nlines, arrows, circles,\nsquares, triangles, polygons —\nor drag border to border to link.\n\nHold Ctrl to move things instead." });
    mk({ type: "code", x: -48, y: 36, w: 372, h: 192, lang: "js", md: false,
      src: "// paste code from anywhere —\n// the language is detected for you\nconst board = { local: true }\n\nexport const save = (doc) =>\n  localStorage.setItem('space.doc.v1', JSON.stringify(doc))" });
    mk({ type: "curve", wdt: 2, arrow: true, color: PALETTE[3],
      pts: [{ x: 264, y: -144 }, { x: 348, y: -204 }, { x: 432, y: -150 }, { x: 468, y: -60 }] });
    mk({ type: "ellipse", x: 396, y: 60, w: 132, h: 132, wdt: 2, color: PALETTE[6] });
    /* frame the seeded board in the viewport, so a first load opens on the
       content rather than on empty space (Reset view returns here) */
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    doc.objs.forEach((o) => {
      const r = objBBox(o); if (!r) return;
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    });
    if (isFinite(x0)) {
      const dx = Math.round((innerWidth / 2 - (x0 + x1) / 2) / CELL) * CELL;
      const dy = Math.round((innerHeight / 2 - (y0 + y1) / 2) / CELL) * CELL;
      doc.objs.forEach((o) => {
        if (isBox(o)) { o.x += dx; o.y += dy; } else shiftVector(o, dx, dy);
        sync(o);
      });
    }
    void a;
  }

  load();
  if (!doc.objs.length) { seed(); save(); }
  syncCam();
  fitScratch();

  // the group field paints on its own canvas, underneath everything else
  Field.mount(document.getElementById("field"));

  render();
  applyCam();
  drawBlobs();
  modeEl.hidden = true;

  // bring dropped files back out of local storage, then join the room
  rehydrate();
  Sync.start();

  /* Share the pointer with the room in world coordinates, so it lands on
     the same spot on everyone's screen however they happen to be panned
     or zoomed. Nothing is sent when nobody is connected. */
  addEventListener("pointermove", (e) => {
    if (!Net.online()) return;
    const p = toWorld(e.clientX, e.clientY);
    Net.cursor(p.x, p.y, dragging);
  }, { passive: true });

  /* Peers move on their own clock, and their cursors are stored in world
     coordinates, so they have to be re-projected every frame while anyone
     else is on the board. The loop stops dead when you are alone. */
  let peerRAF = 0;
  function peerTick() {
    peerRAF = 0;
    if (!Net.peers.size) return;
    Net.paint(toScreen);
    peerRAF = requestAnimationFrame(peerTick);
  }
  setInterval(() => {
    if (Net.peers.size && !peerRAF) peerRAF = requestAnimationFrame(peerTick);
  }, 200);

  window.SPACE = {
    doc, save, render, Sync, cam, camT, kick, guessLang, copyObject, coupleInside,
    setDraw, setTidy, rehydrate, drawBlobs,
    net: () => ({ room: Net.room, online: Net.online(), peers: Net.peers.size }),
  };
})();
