/* geom.js — stroke math: simplification, adaptive smoothing, shape recognition.
   The "amount of dots" for a curve is chosen from the stroke itself:
   Ramer–Douglas–Peucker with an epsilon derived from stroke length and
   noise, then re-densified only where curvature is high. */
(function (g) {
  const P = (x, y) => ({ x, y });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const add = (a, b) => P(a.x + b.x, a.y + b.y);
  const sub = (a, b) => P(a.x - b.x, a.y - b.y);
  const mul = (a, k) => P(a.x * k, a.y * k);
  const lerp = (a, b, t) => P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

  function pathLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
    return L;
  }

  function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (!L2) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /* Ramer–Douglas–Peucker */
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    let idx = 0, far = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
      if (d > far) { far = d; idx = i; }
    }
    if (far > eps) {
      const a = rdp(pts.slice(0, idx + 1), eps);
      const b = rdp(pts.slice(idx), eps);
      return a.slice(0, -1).concat(b);
    }
    return [pts[0], pts[pts.length - 1]];
  }

  /* moving-average pass to kill hand jitter before fitting */
  function smooth(pts, k) {
    if (pts.length < 3) return pts.slice();
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      let sx = 0, sy = 0, n = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(pts.length - 1, i + k); j++) { sx += pts[j].x; sy += pts[j].y; n++; }
      out.push(P(sx / n, sy / n));
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /* resample to even spacing so curvature estimates are fair */
  function resample(pts, step) {
    if (pts.length < 2) return pts.slice();
    const out = [pts[0]];
    let prev = pts[0], acc = 0;
    for (let i = 1; i < pts.length; i++) {
      let a = prev, b = pts[i], d = dist(a, b);
      while (acc + d >= step) {
        const t = (step - acc) / d;
        const np = lerp(a, b, t);
        out.push(np);
        a = np; d = dist(a, b); acc = 0;
      }
      acc += d; prev = pts[i];
    }
    const last = pts[pts.length - 1];
    if (dist(out[out.length - 1], last) > step * 0.4) out.push(last);
    return out;
  }

  /* auto node count: fewer nodes on lazy strokes, more on wiggly ones */
  function autoNodes(raw, closed) {
    const L = pathLength(raw);
    if (L < 4) return raw.slice(0, 2);
    const s = smooth(resample(raw, Math.max(2, L / 160)), 2);
    const eps = Math.min(16, Math.max(1.6, L * 0.014));
    let pts = rdp(s, eps);
    // hard cap keeps the curve editable by hand
    const cap = Math.max(3, Math.min(24, Math.round(3 + L / 90)));
    let e = eps;
    while (pts.length > cap && e < 90) { e *= 1.35; pts = rdp(s, e); }
    if (closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1) pts.pop();
    return pts;
  }

  /* ---------------------------------------------------------------- *
   * centripetal Catmull–Rom -> cubic bezier
   * Knot spacing uses sqrt(chord), which is what stops long segments
   * from bulging: the curve reads rounder, closer to arcs, and never
   * loops back on itself the way uniform Catmull–Rom does.
   * ---------------------------------------------------------------- */
  function toPath(pts, closed, tension) {
    const t = tension == null ? 1.06 : tension;
    if (!pts || pts.length < 2) return "";
    if (pts.length === 2) return `M${r(pts[0].x)} ${r(pts[0].y)} L${r(pts[1].x)} ${r(pts[1].y)}`;
    const n = pts.length;
    const at = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    let d = `M${r(pts[0].x)} ${r(pts[0].y)}`;
    const end = closed ? n : n - 1;
    for (let i = 0; i < end; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const d1 = Math.max(1e-3, Math.sqrt(dist(p0, p1)));
      const d2 = Math.max(1e-3, Math.sqrt(dist(p1, p2)));
      const d3 = Math.max(1e-3, Math.sqrt(dist(p2, p3)));
      const c1 = P(
        (d1 * d1 * p2.x - d2 * d2 * p0.x + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.x) / (3 * d1 * (d1 + d2)),
        (d1 * d1 * p2.y - d2 * d2 * p0.y + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.y) / (3 * d1 * (d1 + d2))
      );
      const c2 = P(
        (d3 * d3 * p1.x - d2 * d2 * p3.x + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.x) / (3 * d3 * (d3 + d2)),
        (d3 * d3 * p1.y - d2 * d2 * p3.y + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.y) / (3 * d3 * (d3 + d2))
      );
      const b1 = lerp(p1, c1, t), b2 = lerp(p2, c2, t);
      d += ` C${r(b1.x)} ${r(b1.y)} ${r(b2.x)} ${r(b2.y)} ${r(p2.x)} ${r(p2.y)}`;
    }
    if (closed) d += " Z";
    return d;
  }
  const r = (v) => Math.round(v * 100) / 100;

  /* --------- recognition --------- */
  function angleAt(pts, i, span) {
    const a = pts[Math.max(0, i - span)], b = pts[i], c = pts[Math.min(pts.length - 1, i + span)];
    const v1 = sub(b, a), v2 = sub(c, b);
    const a1 = Math.atan2(v1.y, v1.x), a2 = Math.atan2(v2.y, v2.x);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  const norm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  /* how much the pen turned in total, and how much of that was back and
     forth. A circle turns 2π one way; a scribble turns far more and keeps
     changing its mind. This is the main scribble detector. */
  function turning(pts) {
    let total = 0, signed = 0, flips = 0, last = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = norm(Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x) -
                     Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x));
      total += Math.abs(d);
      signed += d;
      if (Math.abs(d) > 0.25) {
        const s = Math.sign(d);
        if (last && s !== last) flips++;
        last = s;
      }
    }
    return { total, signed: Math.abs(signed), flips };
  }

  /* indices of sharp turns, one per turn (local maxima, not every sample) */
  function cornerIdx(pts, thresh) {
    const n = pts.length;
    const span = Math.max(2, Math.round(n / 26));
    const th = thresh == null ? 0.78 : thresh;
    const out = [];
    let run = null;
    for (let i = span; i < n - span; i++) {
      const a = Math.abs(angleAt(pts, i, span));
      if (a > th) {
        if (run && i - run.last <= span) { run.last = i; if (a > run.a) { run.a = a; run.i = i; } }
        else { if (run) out.push(run.i); run = { i, a, last: i }; }
      }
    }
    if (run) out.push(run.i);
    return out;
  }

  /* a hand-drawn polygon becomes a clean one: equal sides when the user was
     close to equal, and a square/equilateral bbox when close to 1:1 */
  function regularize(v) {
    const n = v.length;
    const c = P(v.reduce((s, p) => s + p.x, 0) / n, v.reduce((s, p) => s + p.y, 0) / n);
    const rs = v.map((p) => dist(p, c));
    const mean = rs.reduce((s, x) => s + x, 0) / n;
    if (!mean) return v;
    const spread = (Math.max(...rs) - Math.min(...rs)) / mean;

    const ang = v.map((p) => Math.atan2(p.y - c.y, p.x - c.x));
    // are the vertices roughly evenly spaced around the centre?
    const step = (2 * Math.PI) / n;
    let even = true;
    for (let i = 0; i < n; i++) {
      let d = ang[(i + 1) % n] - ang[i];
      while (d < 0) d += 2 * Math.PI;
      if (Math.abs(d - step) > step * 0.5) even = false;
    }
    // close enough to regular becomes regular: a near-equilateral triangle
    // is drawn as an equilateral one, a near-square as a square
    if (spread > 0.26 || !even) return v;
    // snap the whole figure to a regular n-gon, keeping its rotation
    let base = 0;
    for (let i = 0; i < n; i++) {
      let a = ang[i] - i * step;
      while (a - base > Math.PI) a -= 2 * Math.PI;
      while (base - a > Math.PI) a += 2 * Math.PI;
      base += (a - base) / (i + 1);
    }
    return v.map((_, i) => P(c.x + Math.cos(base + i * step) * mean, c.y + Math.sin(base + i * step) * mean));
  }

  /* ------------------------------------------------------------------ *
   * recognize
   *
   * Deliberately hard to convince. The previous version snapped almost
   * anything to a shape, so drawing a squiggle next to a note turned it
   * into an ellipse. The rule now is: a stroke stays a curve unless it
   * clearly is not one.
   *
   * Every branch has to pass a shape-specific sanity check as well as a
   * general scribble test, and `opts.noArrow` stops an arrow's own shaft
   * from being re-examined, which is what produced arrows growing heads
   * on top of heads.
   * ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ *
   * Silhouette
   *
   * Everything above reads the path: where the pen went, in what order,
   * where it turned. That is right for a shape drawn in one clean motion
   * and useless for a shape that was filled in or gone over twice, since
   * then the path is mostly scribble.
   *
   * These read the shape instead — the outline the ink occupies, and how
   * wide that outline is along its own long axis. Colouring an arrow in
   * solid does not change its silhouette, so it still reads as an arrow.
   * ------------------------------------------------------------------ */

  function convexHull(points) {
    const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    const up = [];
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  function polyArea(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) { const a = v[i], b = v[(i + 1) % v.length]; s += a.x * b.y - b.x * a.y; }
    return Math.abs(s) / 2;
  }
  function polyPerim(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += dist(v[i], v[(i + 1) % v.length]);
    return s;
  }
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

  /* candidate long axes: the two hull points furthest apart, and the
     principal axis of the ink. Each is tried in both directions, because
     which end is the tip is exactly what we are trying to find out. */
  function axes(pts, hullPts) {
    const out = [];
    let best = -1, A = null, B = null;
    for (let i = 0; i < hullPts.length; i++) {
      for (let j = i + 1; j < hullPts.length; j++) {
        const d = dist(hullPts[i], hullPts[j]);
        if (d > best) { best = d; A = hullPts[i]; B = hullPts[j]; }
      }
    }
    if (A) out.push([A, B], [B, A]);

    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    cx /= pts.length; cy /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(th), uy = Math.sin(th);
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { const t = (p.x - cx) * ux + (p.y - cy) * uy; if (t < lo) lo = t; if (t > hi) hi = t; }
    const pa = P(cx + ux * lo, cy + uy * lo), pb = P(cx + ux * hi, cy + uy * hi);
    if (dist(pa, pb) > 8) out.push([pa, pb], [pb, pa]);
    return out;
  }

  /* how wide the ink is, in slices taken along A->B */
  function widthProfile(pts, A, B, bins) {
    const ax = B.x - A.x, ay = B.y - A.y;
    const D = Math.hypot(ax, ay);
    if (D < 1) return null;
    const ux = ax / D, uy = ay / D;
    const lo = new Array(bins).fill(Infinity), hi = new Array(bins).fill(-Infinity);
    for (const p of pts) {
      const dx = p.x - A.x, dy = p.y - A.y;
      let i = Math.floor(((dx * ux + dy * uy) / D) * bins);
      if (i < 0) i = 0; else if (i >= bins) i = bins - 1;
      const u = dx * -uy + dy * ux;
      if (u < lo[i]) lo[i] = u;
      if (u > hi[i]) hi[i] = u;
    }
    const w = new Array(bins);
    for (let i = 0; i < bins; i++) w[i] = lo[i] === Infinity ? null : hi[i] - lo[i];
    // a slice the stroke happened to skip borrows its neighbour
    for (let i = 0; i < bins; i++) if (w[i] == null) {
      let a = i - 1; while (a >= 0 && w[a] == null) a--;
      let b = i + 1; while (b < bins && w[b] == null) b++;
      w[i] = a >= 0 ? w[a] : (b < bins ? w[b] : 0);
    }
    return { w, D, ux, uy };
  }

  /* An arrow, read as a silhouette: an even narrow shaft, then an abrupt
     widening, then a taper to a point. Drawn as an outline or filled in
     solid, that profile is the same. */
  function silhouetteArrow(pts, hullPts, diag) {
    const BINS = 20;
    let best = null, bestScore = 0;
    for (const [A, B] of axes(pts, hullPts)) {
      const pr = widthProfile(pts, A, B, BINS);
      if (!pr) continue;
      const w = pr.w;

      let m = 0;
      for (let i = 0; i < BINS; i++) if (w[i] > w[m]) m = i;
      if (m < BINS * 0.45 || m > BINS - 3) continue;   // head in the far half, with room to taper

      const headW = w[m];
      if (headW < 10) continue;
      // only the very last slice has to be thin. The one before it is
      // still partway down the barb, so testing it rejects real arrows.
      if (w[BINS - 1] > headW * 0.42) continue;         // must come to a point

      // A drawn arrow has a hairline shaft and a coloured-in one has a
      // thick shaft. Both are arrows. What matters is that the shaft stays
      // even along its length and that the head dwarfs it.
      const shaft = w.slice(0, Math.max(1, m - 1));
      if (shaft.length < 3) continue;
      const sw = median(shaft);
      if (sw > headW * 0.5) continue;                   // a blob is not an arrow
      if (headW < Math.max(10, sw * 2.1)) continue;
      if (Math.max.apply(null, shaft) > Math.max(6, sw * 2.6)) continue;

      let rises = 0;
      for (let i = m + 1; i < BINS; i++) if (w[i] > w[i - 1] * 1.18) rises++;
      if (rises > 1) continue;                          // the taper must be clean

      const headLen = (1 - m / BINS) * pr.D;
      if (headLen < diag * 0.08 || headLen > pr.D * 0.6) continue;

      // more than one axis can match; keep whichever reads most like an arrow
      const score = headW / Math.max(1, sw);
      if (score <= bestScore) continue;
      bestScore = score;

      // Same as the path-based reading: the silhouette says "arrow", and
      // the head it gets is the standard one rather than a trace of the
      // blob that was coloured in.
      best = { kind: "arrow", a: A, b: snapAngle(A, B), head: null };
    }
    return best;
  }

  /* A filled blob, classified by its outline. Only the shapes that fit a
     template cleanly are claimed; anything else returns null and stays
     the freehand scribble it was drawn as. */
  function silhouette(pts, hullPts, hullArea, L, diag, o) {
    if (!o.noArrow) {
      const arrow = silhouetteArrow(pts, hullPts, diag);
      if (arrow) return arrow;
    }

    const bb = bbox(hullPts);
    const boxArea = Math.max(1, bb.w * bb.h);
    const fill = hullArea / boxArea;
    const square = Math.abs(bb.w - bb.h) < Math.max(bb.w, bb.h) * 0.15;
    const verts = rdp(hullPts.concat([hullPts[0]]), Math.max(6, diag * 0.07));
    const n = Math.max(0, verts.length - 1);

    if (n >= 7 && fill > 0.70 && fill < 0.90) {
      const w = square ? (bb.w + bb.h) / 2 : bb.w, h = square ? w : bb.h;
      return { kind: "ellipse", x: bb.cx - w / 2, y: bb.cy - h / 2, w: Math.max(24, w), h: Math.max(24, h) };
    }
    if (n === 4 && fill > 0.86) {
      const w = square ? (bb.w + bb.h) / 2 : bb.w, h = square ? w : bb.h;
      return { kind: "rect", x: bb.cx - w / 2, y: bb.cy - h / 2, w: Math.max(28, w), h: Math.max(28, h) };
    }
    if (n === 3 && fill > 0.40 && fill < 0.64) {
      return { kind: "poly", pts: regularize(verts.slice(0, 3)) };
    }
    return null;
  }

  function recognize(raw, opts) {
    const o = opts || {};
    const pts = smooth(resample(raw, Math.max(2, pathLength(raw) / 150)), 1);
    const L = pathLength(pts);
    const a = pts[0], b = pts[pts.length - 1];
    const chord = dist(a, b);
    const bb = bbox(pts);
    const diag = Math.hypot(bb.w, bb.h);
    if (L < 12 || pts.length < 3) return { kind: "dot", pts };

    const turn = turning(pts);
    // a stroke that keeps reversing is a doodle, and a doodle is a curve
    const scribble = turn.flips > 5 || turn.total > Math.PI * 5;

    /* Silhouette pass. It runs when the pen travelled far further than the
       outline it encloses, which is what filling a shape in, or going over
       it twice, actually looks like. If nothing matches cleanly the stroke
       carries on to the ordinary path-based tests below. */
    // Read the silhouette from the raw ink, never from the smoothed path:
    // smoothing a colouring-in zigzag averages its rows together and
    // collapses the shape back onto its own centreline.
    const ink = resample(raw, 3);
    const hullPts = convexHull(ink);
    const hullPerim = polyPerim(hullPts);
    const hullArea = polyArea(hullPts);
    if (hullPts.length > 2 && hullPerim > 1 && hullArea > 200 && L > hullPerim * 1.5) {
      const solid = silhouette(ink, hullPts, hullArea, L, diag, o);
      if (solid) return solid;
    }

    /* The micro threshold for closing a figure.

       A hand almost never lands back on the point it started from, so an
       outline that stops a little short of itself is welded shut: the gap
       between the two ends is under a small absolute distance or a fifth of
       the figure's own size, and the pen went round far enough — by length
       and by total turning — to have drawn an outline at all. The old rule
       wanted the ends nearly touching and the stroke almost twice the
       diagonal, which is why circles and boxes so often came out as open
       squiggles. The second, tighter rule below catches a freehand loop
       that is not any named shape.

       Turning is what keeps this honest: a long straight zigzag can end up
       near its own start, but it never accumulates a full turn. */
    const CLOSE_ABS = 26;
    const gapClose = chord < Math.max(CLOSE_ABS, diag * 0.3);
    const gapMicro = chord < Math.max(14, Math.min(diag * 0.16, L * 0.07));
    const closed = gapClose && L > diag * 1.35 && turn.signed > Math.PI * 1.1;

    if (!closed) {
      if (!o.noArrow) {
        const arrow = findArrow(pts, L, diag);
        if (arrow) return arrow;
      }

      // straight line: strict, because a gentle arc is not a line
      let maxDev = 0;
      for (const p of pts) maxDev = Math.max(maxDev, segDist(p, a, b));
      if (chord > 30 && !scribble && maxDev < Math.max(4, chord * 0.032) && L < chord * 1.06) {
        return { kind: "line", a, b: snapAngle(a, b) };
      }
      /* An arrow drawn messily still has an arrow's silhouette. This only
         runs when the pen really did go over its own ground — filling in or
         tracing — otherwise an ordinary open curve could be read as one. */
      if (!o.noArrow && hullPts.length > 2 && L > hullPerim * 1.35) {
        const solid = silhouetteArrow(ink, hullPts, diag);
        if (solid) return solid;
      }
      /* Not a shape with a name, but the pen came back to where it began:
         a closed freehand outline rather than an open ribbon. */
      if (gapMicro && L > diag * 1.1) return { kind: "curve", pts: autoNodes(raw, true), closed: true };
      return { kind: "curve", pts: autoNodes(raw, false), closed: false };
    }

    // An arrow traced as an outline closes back on itself, so it arrives
    // here rather than in the open branch. Its silhouette is still an
    // arrow, and without this it would be filed as a rectangle.
    if (!o.noArrow && hullPts.length > 2) {
      const solid = silhouetteArrow(ink, hullPts, diag);
      if (solid) return solid;
    }

    if (scribble) return { kind: "curve", pts: autoNodes(raw, true), closed: true };

    /* ---- closed: circle / square / triangle / polygon ---- */
    const c = P(bb.cx, bb.cy);
    const rs = pts.map((p) => dist(p, c));
    const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
    const dev = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / rs.length) / (mean || 1);
    const corners = cornerIdx(pts, 0.9);
    const square = Math.abs(bb.w - bb.h) < Math.max(bb.w, bb.h) * 0.15;

    // a real circle has perimeter ≈ π·diameter; that ratio rules out
    // blobs and lens shapes which the radius test alone would accept
    const ringy = L / (Math.max(1, mean) * 2 * Math.PI);
    /* Freehand circles are wobbly by nature. The old gate wanted a radius
       spread under 0.13 *and* not one single sharp sample, which a real
       hand-drawn ring almost never survives — the closing overlap alone
       registers as a corner. One corner is now allowed and the spread and
       roundness bands are as wide as they can be without letting a lens or
       a bean through. */
    if (dev < 0.155 && corners.length <= 1 && ringy > 0.82 && ringy < 1.3 && turn.signed > Math.PI * 1.5) {
      /* Anything a hand meant as a circle comes out a circle. Once the
         stroke is this round, an aspect within a quarter is hand tremor,
         not an oval, so the two axes are averaged — that is what makes a
         drawn circle land at 1:1. Draw a visibly flat ring and it stays
         an oval. */
      const round = Math.abs(bb.w - bb.h) < Math.max(bb.w, bb.h) * 0.25;
      const w = square || round ? (bb.w + bb.h) / 2 : bb.w;
      const h = square || round ? w : bb.h;
      return { kind: "ellipse", x: bb.cx - w / 2, y: bb.cy - h / 2, w: Math.max(24, w), h: Math.max(24, h) };
    }

    // vertices = the stroke's start plus every sharp turn
    let v = [pts[0]].concat(corners.map((i) => pts[i]));
    // fold vertices that landed on top of each other
    const minGap = Math.max(10, diag * 0.14);
    v = v.filter((p, i) => v.every((q, j) => j >= i || dist(p, q) > minGap));

    if (v.length === 4) {
      // only a rectangle if the stroke actually hugged the bounding box
      const fit = L / Math.max(1, 2 * (bb.w + bb.h));
      if (fit > 0.88 && fit < 1.18) {
        const w = square ? (bb.w + bb.h) / 2 : bb.w;
        const h = square ? w : bb.h;
        return { kind: "rect", x: bb.cx - w / 2, y: bb.cy - h / 2, w: Math.max(28, w), h: Math.max(28, h) };
      }
    }
    if (v.length >= 3 && v.length <= 7) {
      // the polygon through those vertices has to resemble the stroke
      let err = 0;
      for (const p of pts) {
        let best = Infinity;
        for (let i = 0; i < v.length; i++) best = Math.min(best, segDist(p, v[i], v[(i + 1) % v.length]));
        err = Math.max(err, best);
      }
      if (err < Math.max(9, diag * 0.09)) return { kind: "poly", pts: regularize(v) };
    }
    return { kind: "curve", pts: autoNodes(raw, true), closed: true };
  }

  /* ------------------------------------------------------------------ *
   * findArrow
   *
   * People draw an arrow in one motion: out along the shaft, back for one
   * barb, and often out again for the second. So the head is found by
   * walking backwards from the pen-up point and looking for direction
   * reversals, not by assuming the head is short.
   *
   * Barbs may be any length — a 200px barb on a 220px shaft is still an
   * arrow if it folds back. What makes a barb a barb is the angle: it has
   * to point back toward where the shaft came from, roughly 20°–75° off
   * the reversed shaft direction.
   *
   * The measured barbs are returned, so the renderer can reproduce the
   * two open strokes that were actually drawn. There is no triangle and
   * nothing is filled: the head is the same two lines as the shaft.
   * ------------------------------------------------------------------ */
  function findArrow(pts, L, diag) {
    const idx = cornerIdx(pts, 1.05);
    if (!idx.length) return null;

    /* The tip is not necessarily the last sharp turn. Drawn in one motion a
       head often folds back over itself — out along one barb, back down the
       same line to the tip, out along the other — which puts two more
       corners after the real tip. So every one of the last few corners is
       tried as a tip, earliest first, and the first one that reads as an
       arrow wins. */
    for (const first of idx.slice(-4)) {
      const got = arrowAt(pts, L, first);
      if (got) return got;
    }
    return null;
  }

  function arrowAt(pts, L, first) {
    const shaft = pts.slice(0, first + 1);
    if (shaft.length < 3) return null;
    const tip = pts[first];
    const sl = pathLength(shaft);
    if (sl < 22 || sl < L * 0.34) return null;      // the shaft must dominate

    /* The shaft has to actually be a shaft. Without this almost any hooked
       squiggle qualified, which is why nearly everything drawn was turning
       into an arrow. */
    const chord = dist(shaft[0], tip);
    if (chord < 20) return null;
    // A shaft is a straight run. At 0.16 of the chord a lazy hook counted
    // as one, which is why so much ink came back as an arrow.
    let dev = 0;
    for (const p of shaft) dev = Math.max(dev, segDist(p, shaft[0], tip));
    if (dev > Math.max(4, chord * 0.1)) return null;
    // and it must not double back on itself on the way there
    if (sl > chord * 1.25) return null;

    const dir = sub(tip, shaft[Math.max(0, shaft.length - 12)]);
    if (Math.hypot(dir.x, dir.y) < 4) return null;
    const heading = Math.atan2(dir.y, dir.x);
    const back = norm(heading + Math.PI);          // where the shaft came from

    /* Read the tail as distance from the tip over time. One barb is one
       excursion away from the tip and back, however it was drawn, so
       retracing the same line counts once instead of twice. */
    const tail = pts.slice(first);
    const d = tail.map((p) => dist(p, tip));
    const peaks = [];
    let low = 0;
    for (let i = 1; i < d.length - 1; i++) {
      if (d[i] >= d[i - 1] && d[i] > d[i + 1] && d[i] - low > d[i] * 0.55) {
        peaks.push({ len: d[i], p: tail[i] });
        low = d[i];
      }
      if (d[i] < low) low = d[i];
    }
    const endD = d[d.length - 1];
    if (endD - low > endD * 0.55) peaks.push({ len: endD, p: tail[tail.length - 1] });
    if (!peaks.length || peaks.length > 2) return null;

    const barbs = [];
    for (const pk of peaks) {
      // a nick at the end of a line is not a head
      if (pk.len < Math.max(10, sl * 0.08)) return null;
      if (pk.len > sl * 0.85) return null;         // nor does a barb outrun the shaft
      if (pk.len > sl * 0.5) return null;          // nor is half the shaft a barb
      const ang = Math.atan2(pk.p.y - tip.y, pk.p.x - tip.x);
      const off = Math.abs(norm(ang - back));
      if (off < 0.44 || off > 1.22) return null;   // 25°..70° off the reversed shaft
      barbs.push({ len: pk.len, ang: norm(ang - heading) });
    }

    // two barbs sit on opposite sides of the shaft and roughly match
    if (barbs.length === 2) {
      if (Math.sign(barbs[0].ang) === Math.sign(barbs[1].ang)) return null;
      const ratio = Math.min(barbs[0].len, barbs[1].len) / Math.max(barbs[0].len, barbs[1].len);
      if (ratio < 0.55) return null;
    }

    /* The barbs are measured to decide whether this is an arrow, and then
       thrown away. Replaying them reproduced every wobble of the hand, so
       two arrows drawn one after another came out different sizes. Head
       omitted means the standard head, and the two barb handles on the
       selected arrow are there to change it deliberately. */
    return { kind: "arrow", a: shaft[0], b: snapAngle(shaft[0], tip), head: null };
  }

  /* Build the head as two open strokes leaving the tip, mirroring what was
     drawn. Falls back to a symmetric pair when nothing was measured, e.g.
     for a connector the user never drew by hand. Never closed, never filled. */
  function headStrokes(tip, heading, head, scale) {
    const s = scale || 1;
    let barbs = head && head.barbs && head.barbs.length ? head.barbs : null;

    if (!barbs) {
      barbs = [{ len: 13, ang: Math.PI * 0.82 }, { len: 13, ang: -Math.PI * 0.82 }];
    } else if (barbs.length === 1) {
      // one barb drawn: mirror it so the head still reads as an arrow
      barbs = [barbs[0], { len: barbs[0].len, ang: -barbs[0].ang }];
    }

    /* A stored barb is kept scale-free and scaled here, exactly like the
       default one. Before, a stored barb skipped the scaling the default
       got: a head kept from a stroke came out short, and a barb dragged
       somewhere landed shorter than where it was dropped. */
    return barbs.map((b) => {
      const a = heading + b.ang;
      const len = b.len * s;
      return { from: tip, to: P(tip.x + Math.cos(a) * len, tip.y + Math.sin(a) * len) };
    });
  }

  /* ------------------------------------------------------------------ *
   * relax
   *
   * What "Relax" is meant to do: take the nodes as they are and let the
   * line settle — pull out the kinks, even out the spacing, keep the ends
   * where they were put.
   *
   * It used to re-run recognition on the node list, which is a different
   * job: sometimes it re-fitted a whole new shape, sometimes it changed
   * the node count under your hands, and on an already-tidy curve it did
   * nothing at all. This is plain Laplacian smoothing with the endpoints
   * pinned, followed by an even re-spacing along the smoothed line, so
   * the same number of nodes come back and each press settles the line a
   * little further.
   * ------------------------------------------------------------------ */
  function pointAlong(poly, s) {
    let acc = 0;
    for (let i = 1; i < poly.length; i++) {
      const d = dist(poly[i - 1], poly[i]);
      if (acc + d >= s) return lerp(poly[i - 1], poly[i], d ? (s - acc) / d : 0);
      acc += d;
    }
    return poly[poly.length - 1];
  }

  function relax(pts, closed, strength) {
    const n = pts ? pts.length : 0;
    if (n < 3) return (pts || []).map((p) => P(p.x, p.y));
    const k = strength == null ? 0.55 : strength;
    let v = pts.map((p) => P(p.x, p.y));

    for (let round = 0; round < 6; round++) {
      const next = v.map((p) => P(p.x, p.y));
      const from = closed ? 0 : 1;
      const to = closed ? n : n - 1;
      for (let i = from; i < to; i++) {
        const a = v[(i - 1 + n) % n], b = v[i], c = v[(i + 1) % n];
        next[i] = P(b.x + ((a.x + c.x) / 2 - b.x) * k, b.y + ((a.y + c.y) / 2 - b.y) * k);
      }
      v = next;
    }

    // even spacing: the nodes end up a uniform distance apart, which is
    // what stops a relaxed line from having a crowd of dots in one bend
    const poly = closed ? v.concat([v[0]]) : v;
    const L = pathLength(poly);
    if (L < 1) return v;
    const gaps = closed ? n : n - 1;
    const out = [];
    for (let i = 0; i < n; i++) out.push(pointAlong(poly, (L / gaps) * i));
    if (!closed) { out[0] = v[0]; out[n - 1] = v[n - 1]; }
    return out;
  }

  /* snap near-horizontal / vertical / 45° lines */
  function snapAngle(a, b) {
    const d = sub(b, a);
    const len = Math.hypot(d.x, d.y);
    if (!len) return b;
    let ang = Math.atan2(d.y, d.x);
    const step = Math.PI / 12; // 15°
    const snapped = Math.round(ang / step) * step;
    if (Math.abs(snapped - ang) < 0.075) ang = snapped;
    return P(a.x + Math.cos(ang) * len, a.y + Math.sin(ang) * len);
  }

  /* nearest point on a rect border (for connector anchors) */
  function nearestOnRect(rect, p) {
    const { x, y, w, h } = rect;
    const cx = Math.max(x, Math.min(x + w, p.x));
    const cy = Math.max(y, Math.min(y + h, p.y));
    const dl = cx - x, dr = x + w - cx, dt = cy - y, db = y + h - cy;
    const m = Math.min(dl, dr, dt, db);
    let q;
    if (m === dl) q = P(x, cy);
    else if (m === dr) q = P(x + w, cy);
    else if (m === dt) q = P(cx, y);
    else q = P(cx, y + h);
    return { p: q, ax: w ? (q.x - x) / w : 0.5, ay: h ? (q.y - y) / h : 0.5, d: dist(q, p) };
  }

  /* outward normal for an anchor expressed in 0..1 rect coords */
  function anchorNormal(ax, ay) {
    const e = 0.001;
    if (ax <= e) return P(-1, 0);
    if (ax >= 1 - e) return P(1, 0);
    if (ay <= e) return P(0, -1);
    return P(0, 1);
  }

  /* sample a cubic-ish path made of nodes, used for hit tests on curves */
  function nearestNode(pts, p) {
    let bi = -1, bd = Infinity;
    pts.forEach((q, i) => { const d = dist(q, p); if (d < bd) { bd = d; bi = i; } });
    return { i: bi, d: bd };
  }

  function nearestSegment(pts, p, closed) {
    let bi = -1, bd = Infinity;
    const n = pts.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const d = segDist(p, pts[i], pts[(i + 1) % n]);
      if (d < bd) { bd = d; bi = i; }
    }
    return { i: bi, d: bd };
  }

  g.G = { P, dist, add, sub, mul, lerp, pathLength, bbox, segDist, rdp, smooth, resample,
    autoNodes, toPath, recognize, snapAngle, nearestOnRect, anchorNormal, nearestNode, nearestSegment,
    cornerIdx, regularize, turning, headStrokes, findArrow, relax,
    convexHull, polyArea, polyPerim, axes, widthProfile, silhouetteArrow, silhouette };
})(window);
