/* tidy.js — compaction that respects where things already were.

   The old pass measured the widest card, computed a square-ish target
   width, then repacked everything into rows. That is a layout
   algorithm, not a tidy: it destroyed the arrangement you built, and
   the answer to "where did my note go" became "somewhere in row four".

   This does something much more conservative:

     1  group   cards that are linked, that are already close, or that
                are the same kind and near each other end up in one
                group (union-find over those three relations)
     2  order   inside a group, cards are sorted by their current
                position, biggest first only as a tiebreak, so reading
                order survives
     3  pull    every card moves toward the centre along the vector it
                already had, scaled down. Nothing teleports. A card that
                was upper-left stays upper-left
     4  settle  overlaps are resolved by pushing pairs apart along their
                shallowest axis, weighted by area, repeated until clear
     5  reroute link control points are nudged off any card they would
                pass under

   Net effect: the board gets denser, the shape of what you built is
   still recognisable, and nothing ends up hidden under anything. */
(function (g) {
  "use strict";

  const GAP = 16;            // breathing room kept between cards
  const NEAR = 150;          // edge gap under which two cards feel related
  const KIN = 240;           // same-kind cards group from further apart
  const PULL = 0.44;         // how much of the original offset is kept
  const PASSES = 220;
  const SETTLE = 110;        // inward passes after the overlaps are cleared
  const STEP = 7;            // world px a card creeps per settle pass

  const cx = (r) => r.x + r.w / 2;
  const cy = (r) => r.y + r.h / 2;

  /* shortest gap between two rectangles, negative when they overlap */
  function gapOf(a, b) {
    const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
    const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
    if (dx < 0 && dy < 0) return Math.max(dx, dy);
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }

  function groups(rects, links) {
    const parent = rects.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

    const idx = new Map();
    rects.forEach((r, i) => idx.set(r.id, i));

    // an explicit link is the strongest signal there is
    for (const l of links || []) {
      const a = idx.get(l.a), b = idx.get(l.b);
      if (a != null && b != null) join(a, b);
    }

    // then proximity, and a longer leash for cards of the same kind
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const d = gapOf(rects[i], rects[j]);
        const kin = rects[i].kind && rects[i].kind === rects[j].kind;
        if (d < (kin ? KIN : NEAR)) join(i, j);
      }
    }

    const out = new Map();
    rects.forEach((r, i) => {
      const k = find(i);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    });
    return [...out.values()];
  }

  function plan(input, links, opts) {
    const o = Object.assign({ gap: GAP, pull: PULL, snap: 12 }, opts || {});
    const rects = input.map((r) => ({
      id: r.id, kind: r.kind || "",
      x: r.x, y: r.y, w: Math.max(1, r.w), h: Math.max(1, r.h),
      ox: r.x, oy: r.y,
    }));
    if (rects.length < 2) return { moves: [], mids: {} };

    const gs = groups(rects, links);

    /* whole-board centre, so the cloud contracts rather than drifting */
    let bx = 0, by = 0, wsum = 0;
    for (const r of rects) { const a = Math.sqrt(r.w * r.h); bx += cx(r) * a; by += cy(r) * a; wsum += a; }
    bx /= wsum; by /= wsum;

    for (const grp of gs) {
      // sort by reading order; area only breaks ties, so a big card does
      // not jump to the front and shove the sequence around
      grp.sort((a, b) => (a.oy - b.oy) || (a.ox - b.ox) || (b.w * b.h - a.w * a.h));

      let gx = 0, gy = 0, gw = 0;
      for (const r of grp) { const a = Math.sqrt(r.w * r.h); gx += cx(r) * a; gy += cy(r) * a; gw += a; }
      gx /= gw; gy /= gw;

      // members contract toward their own group, groups contract toward
      // the board. Two scales, both gentle.
      const inner = o.pull;
      const outer = 0.62;
      const ngx = bx + (gx - bx) * outer;
      const ngy = by + (gy - by) * outer;

      for (const r of grp) {
        r.x = ngx + (cx(r) - gx) * inner - r.w / 2;
        r.y = ngy + (cy(r) - gy) * inner - r.h / 2;
      }
    }

    /* push overlapping pairs apart along whichever axis is shallower.
       Heavier cards move less, so the layout's anchors stay put. */
    const pad = o.gap;
    for (let pass = 0; pass < PASSES; pass++) {
      let worst = 0;
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          const ox = Math.min(a.x + a.w + pad, b.x + b.w + pad) - Math.max(a.x - pad, b.x - pad);
          const oy = Math.min(a.y + a.h + pad, b.y + b.h + pad) - Math.max(a.y - pad, b.y - pad);
          if (ox <= 0 || oy <= 0) continue;

          const wa = a.w * a.h, wb = b.w * b.h;
          const sa = wb / (wa + wb), sb = wa / (wa + wb);

          if (ox < oy) {
            const dir = cx(a) <= cx(b) ? -1 : 1;
            a.x += dir * ox * sa; b.x -= dir * ox * sb;
            worst = Math.max(worst, ox);
          } else {
            const dir = cy(a) <= cy(b) ? -1 : 1;
            a.y += dir * oy * sa; b.y -= dir * oy * sb;
            worst = Math.max(worst, oy);
          }
        }
      }
      if (worst < 0.4) break;
    }

    /* Then close the air back up. The pass above only ever pushes things
       apart, so it reliably leaves holes behind it — which is why the
       result used to be merely non-overlapping rather than actually
       compact. This walks each card back toward the centre in small
       steps and keeps any step that does not collide, largest first so
       the big cards claim the middle and the small ones tuck in around
       them. Because every step is a short slide along the card's own
       inward vector, the arrangement you built still reads the same; it
       is just tighter. */
    settle(rects, pad, bx, by);

    const q = o.snap || 1;
    const moves = rects.map((r) => ({
      id: r.id,
      x: Math.round(r.x / q) * q,
      y: Math.round(r.y / q) * q,
    }));

    return { moves, mids: reroute(rects, links) };
  }

  function settle(rects, pad, bx, by) {
    const order = rects.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));

    const clear = (r, x, y) => {
      for (const o of rects) {
        if (o === r) continue;
        if (x < o.x + o.w + pad && x + r.w + pad > o.x &&
            y < o.y + o.h + pad && y + r.h + pad > o.y) return false;
      }
      return true;
    };

    for (let pass = 0; pass < SETTLE; pass++) {
      let moved = 0;
      for (const r of order) {
        let dx = bx - cx(r), dy = by - cy(r);
        const d = Math.hypot(dx, dy);
        if (d < 1) continue;
        const step = Math.min(STEP, d);
        dx = (dx / d) * step;
        dy = (dy / d) * step;

        // straight in first; failing that, whichever single axis still helps,
        // which is what lets a card slide along its neighbour into a gap
        if (clear(r, r.x + dx, r.y + dy)) { r.x += dx; r.y += dy; moved++; }
        else if (clear(r, r.x + dx, r.y)) { r.x += dx; moved++; }
        else if (clear(r, r.x, r.y + dy)) { r.y += dy; moved++; }
      }
      if (!moved) break;
    }
  }

  /* nudge each link's control point off any card it would tunnel under */
  function reroute(rects, links) {
    const mids = {};
    if (!links || !links.length) return mids;

    const byId = new Map(rects.map((r) => [r.id, r]));

    for (const l of links) {
      const a = byId.get(l.a), b = byId.get(l.b);
      if (!a || !b) continue;

      const ax = cx(a), ay = cy(a), bx2 = cx(b), by2 = cy(b);
      let mx = (ax + bx2) / 2, my = (ay + by2) / 2;

      let dx = bx2 - ax, dy = by2 - ay;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;   // perpendicular

      // try increasing offsets on both sides, take the first clear one
      let best = { off: 0, hit: Infinity };
      for (const step of [0, 34, -34, 62, -62, 96, -96, 140, -140]) {
        const px = mx + nx * step, py = my + ny * step;
        let hit = 0;
        for (const r of rects) {
          if (r.id === l.a || r.id === l.b) continue;
          const ex = Math.max(r.x - 10 - px, px - (r.x + r.w + 10), 0);
          const ey = Math.max(r.y - 10 - py, py - (r.y + r.h + 10), 0);
          if (ex === 0 && ey === 0) hit += 1;
        }
        if (hit === 0) { best = { off: step, hit: 0 }; break; }
        if (hit < best.hit) best = { off: step, hit };
      }

      if (best.off !== 0) {
        mids[l.id] = [{ x: mx + nx * best.off, y: my + ny * best.off }];
      }
    }
    return mids;
  }

  g.Tidy = { plan, groups, gapOf };
})(window);
