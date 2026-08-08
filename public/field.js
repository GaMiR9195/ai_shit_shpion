/* field.js — the soft pool under a cluster.

   The old version stacked rounded rectangles behind an SVG threshold
   filter. Thresholding is exactly what made it look like discrete steps
   with a circular rim: everything above the cut got full alpha, so you
   saw the level set, not a gradient.

   This is a real scalar field instead. Every card contributes
   exp(-distance / reach) measured from its rounded box, the
   contributions are summed, and the sum is mapped through one smooth
   ramp. Consequences:

     - one card on its own sums to ~1, which sits under the ramp's foot,
       so it stays invisible
     - two cards near each other push the sum over the foot and a faint
       pool appears between them
     - three or four merge into a single blob whose outline follows the
       cards, not a circle, because the distance is to a rounded box
     - the result is continuous, so density fades to nothing at the edge
       instead of stepping

   It is computed on a low resolution buffer (one sample per 6 screen
   pixels) and scaled up with bilinear smoothing, which is both cheaper
   and softer than blurring at full size. */
(function (g) {
  "use strict";

  const STEP = 6;         // screen px per sample
  const REACH = 108;      // how far a card's influence carries, screen px at z=1
  const FOOT = 0.98;      // sum below this shows nothing (a lone card sits at ~1)
  const FULL = 2.55;      // sum at which the pool reaches its cap
  const CAP = 0.070;      // maximum alpha. Deliberately almost invisible.
  const TINT = [255, 252, 246];

  let cv = null, ctx = null, buf = null, bctx = null;
  let field = null, img = null;
  let bw = 0, bh = 0;
  let lastKey = "";

  function mount(canvas) {
    cv = canvas;
    ctx = cv.getContext("2d");
    buf = document.createElement("canvas");
    bctx = buf.getContext("2d", { willReadFrequently: true });
    resize();
  }

  function resize() {
    if (!cv) return;
    const w = innerWidth, h = innerHeight;
    cv.width = w; cv.height = h;
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    bw = Math.max(2, Math.ceil(w / STEP) + 1);
    bh = Math.max(2, Math.ceil(h / STEP) + 1);
    buf.width = bw; buf.height = bh;
    field = new Float32Array(bw * bh);
    img = bctx.createImageData(bw, bh);
    lastKey = "";
  }

  const smoothstep = (t) => t * t * (3 - 2 * t);

  /* rects come in screen space already, so zoom is baked in */
  function draw(rects) {
    if (!cv) return;

    // nothing to pool under
    if (!rects || rects.length < 2) {
      if (lastKey !== "empty") { ctx.clearRect(0, 0, cv.width, cv.height); lastKey = "empty"; }
      return;
    }

    // skip the whole pass when neither the cards nor the camera moved
    let key = rects.length + "|";
    for (const r of rects) key += (r.x | 0) + "," + (r.y | 0) + "," + (r.w | 0) + "," + (r.h | 0) + ";";
    if (key === lastKey) return;
    lastKey = key;

    field.fill(0);

    const reach = REACH * (rects.zoom || 1);
    const inv = 1 / Math.max(8, reach);

    for (const r of rects) {
      // a card only reaches so far: touch just the samples inside that halo
      const x0 = Math.max(0, Math.floor((r.x - reach * 2.2) / STEP));
      const x1 = Math.min(bw - 1, Math.ceil((r.x + r.w + reach * 2.2) / STEP));
      const y0 = Math.max(0, Math.floor((r.y - reach * 2.2) / STEP));
      const y1 = Math.min(bh - 1, Math.ceil((r.y + r.h + reach * 2.2) / STEP));
      if (x1 < x0 || y1 < y0) continue;

      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const hw = r.w / 2, hh = r.h / 2;

      for (let gy = y0; gy <= y1; gy++) {
        const py = gy * STEP;
        const dy = Math.max(Math.abs(py - cy) - hh, 0);
        const row = gy * bw;
        for (let gx = x0; gx <= x1; gx++) {
          const px = gx * STEP;
          const dx = Math.max(Math.abs(px - cx) - hw, 0);
          // distance to the rounded box, then an exponential falloff
          const d = dx === 0 ? dy : dy === 0 ? dx : Math.sqrt(dx * dx + dy * dy);
          field[row + gx] += Math.exp(-d * inv);
        }
      }
    }

    const data = img.data;
    const span = FULL - FOOT;
    const [tr, tg, tb] = TINT;

    for (let i = 0, p = 0; i < field.length; i++, p += 4) {
      const v = field[i];
      let a = 0;
      if (v > FOOT) {
        const t = v >= FULL ? 1 : (v - FOOT) / span;
        a = smoothstep(t) * CAP;
      }
      data[p] = tr; data[p + 1] = tg; data[p + 2] = tb;
      data[p + 3] = (a * 255) | 0;
    }

    bctx.putImageData(img, 0, 0);

    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(buf, 0, 0, bw, bh, 0, 0, bw * STEP, bh * STEP);
  }

  const invalidate = () => { lastKey = ""; };

  g.Field = { mount, resize, draw, invalidate };
})(window);
