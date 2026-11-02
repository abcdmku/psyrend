import { defineLook } from '../types';
import { COMMIT_WGSL, OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * Rain on a fogged window. The world is seen softly through misted glass; water drops of very
 * different sizes sit on it as clear lenses that show a sharp, magnified, flipped piece of the world.
 * A few big drops slide down in a stick-slip glide and wipe clear trails through the fog, shedding
 * beads behind them; others gather in place, grow and evaporate.
 * Music, always eased: energy sets how many drops run and how fast, the high end gathers more
 * resting drops, the melody tints the glints toward its pitch colour. Nothing pulses on the beat.
 * Genes: drop size, rain density, fog, glint tint.
 */
export default defineLook({
  meta: { id: 'rain-glass', name: 'Rain on Glass', weight: 0.8, energy: [0, 1], amount: [0.85, 1], overlay: true,
    genres: { ambient: 1, lofi: 1, jazz: 0.8, classical: 0.7, acoustic: 0.8, pop: 0.6 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    p[0] = 0.85 + 0.5 * d[0];
    p[1] = Math.min(0.9, 0.4 + 0.25 * d[1] + 0.3 * v.energy);
    p[2] = 0.35 + 0.4 * d[2];
    p[3] = d[3];
    p[4] = 0.3 + 0.25 * d[1] + 0.3 * v.high;
    p[5] = v.pitch;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `${COMMIT_WGSL}
// The drop this point is deepest inside: (s = position in radii, r = radius, depth).
fn rg_take(best: vec4f, s: vec2f, r: f32) -> vec4f {
  let l = length(s);
  if (r > 1e-4 && l < 1.0 && (1.0 - l) * r > best.w) { return vec4f(s, r, (1.0 - l) * r); }
  return best;
}

struct Rain { drop: vec4f, trail: f32 }

// Sliding drops (after the classic stick-slip rain-on-glass recipe). q is in screen heights with y
// running down the glass. Few, big, with wiped trails and beads left behind.
fn rg_slide(q: vec2f, t: f32, sz: f32, seed: f32, rin: Rain) -> Rain {
  var o = rin;
  let cell = vec2f(0.34, 0.8) * sz;
  var g = q / cell;
  let colShift = hash12(vec2f(floor(g.x), seed));
  g.y -= t * (0.18 + 0.14 * colShift) + colShift * 7.0;
  let id = floor(g);
  let n = vec3f(hash22(id + seed), hash12(id * 1.7 + seed + 3.1));
  let st = fract(g);
  // Live only while it rains hard enough; drops grow in and shrink away, never pop.
  let live = sat((L.p[0].y - n.y * 0.95) * 4.0);
  let ti = fract(t * (0.22 + 0.2 * n.z) + n.z);
  // Stick-slip: rests, then slides most of the cell, then rests again.
  let y = 0.16 + 0.6 * smoothstep(0.15, 0.9, ti);
  let wig = sin(q.y / cell.y * 9.0 + n.x * 6.0) * 0.05 * (n.z - 0.5);
  let x = 0.3 + 0.4 * n.x + wig;
  // Size spread wide: a few big drops, most medium.
  let r = cell.y * 0.07 * (0.6 + 1.0 * n.y * n.y + 0.3 * n.x) * live;
  var s = (st - vec2f(x, y)) * cell / max(r, 1e-4);
  // Teardrop: fuller at the leading (lower) edge, tapered behind.
  s.y *= select(1.0, 0.72, s.y < 0.0);
  o.drop = rg_take(o.drop, s, r);
  // The wiped trail above the drop, narrowing and fading with distance, holding a few beads.
  let dx = abs(st.x - x) * cell.x;
  let back = (y - st.y) * cell.y;
  let along = smoothstep(-0.2 * r, 0.3 * r, back) * smoothstep(y * cell.y, 0.0, back);
  o.trail = max(o.trail, smoothstep(r * 0.85, r * 0.35, dx) * along * live);
  let bi = floor(back / (r * 1.4 + 1e-4));
  let bh = hash12(vec2f(bi, id.x * 13.0 + id.y));
  let br = r * 0.28 * bh * step(0.5, bh) * along * step(1.0, bi);
  let bc = vec2f(x * cell.x + (bh - 0.5) * r * 0.4, (y * cell.y - (bi + 0.5) * (r * 1.4)));
  o.drop = rg_take(o.drop, (st * cell - bc) / max(br, 1e-4), br);
  return o;
}

// Drops resting in place that gather, grow and evaporate (a jittered grid; neighbours checked so
// big drops are never cut at a cell edge).
fn rg_rest(q: vec2f, t: f32, scale: f32, rmax: f32, dens: f32, seed: f32, best0: vec4f) -> vec4f {
  var best = best0;
  let p = q / scale;
  let i0 = floor(p);
  for (var j = -1; j <= 1; j++) {
    for (var k = -1; k <= 1; k++) {
      let i = i0 + vec2f(f32(k), f32(j));
      let h = vec3f(hash22(i + seed), hash12(i * 1.31 + seed));
      if (h.z > dens) { continue; }
      let life = fract(t * (0.03 + 0.04 * h.x) + h.y);
      let grow = smoothstep(0.0, 0.5, life) * smoothstep(1.0, 0.75, life);
      // Log-spread radii: many small, a few large.
      let r = scale * rmax * exp2(-2.5 * fract(h.x * 5.7)) * grow;
      let c = (i + 0.25 + 0.5 * vec2f(h.x, fract(h.y * 7.3))) * scale;
      best = rg_take(best, (q - c) * vec2f(1.0, 0.92) / max(r, 1e-4), r);
    }
  }
  return best;
}

// The world through fogged glass: a smooth blur (rad in screen heights).
fn rg_fog(uv: vec2f, rad: f32) -> vec3f { return srcSoft(uv, rad * 720.0); }

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let t = L.p[3].x;
  let sz = L.p[0].x;
  let q = vec2f(uv.x * asp, uv.y);
  var rn = Rain(vec4f(0.0), 0.0);
  rn.drop = rg_rest(q, t, 0.16 * sz, 0.32, L.p[1].x, 3.0, rn.drop);
  rn.drop = rg_rest(q, t * 1.3, 0.075 * sz, 0.3, L.p[1].x * 0.6, 5.0, rn.drop);
  rn = rg_slide(q, t, sz, 1.0, rn);
  rn = rg_slide(q + vec2f(0.17 * sz, 0.0), t * 0.85, sz * 0.75, 9.0, rn);
  let sharp = src(uv);
  let fogK = L.p[0].z;
  let fogged = mix(sharp, rg_fog(uv, 0.004 + 0.005 * fogK), 0.4 + 0.35 * fogK);
  let mist = mix(fogged, vec3f(luma(fogged)), 0.12) * (0.84 + 0.08 * fogK);
  var col = mix(mist, sharp, rn.trail * 0.85);
  let r = rn.drop.z;
  if (r > 0.0) {
    let s = rn.drop.xy;
    let l = length(s);
    // A drop is a strong lens: a magnified, flipped, slightly dispersed piece of the world from a
    // few radii around it, darkened at the steep rim where light bends away.
    let off = -s * r * 2.6 / vec2f(asp, 1.0);
    var dc = vec3f(src(uv + off * 0.93).r, src(uv + off).g, src(uv + off * 1.08).b);
    let rim = smoothstep(0.6, 1.0, l);
    dc *= 1.06 - 0.5 * rim * rim;
    // Wet glint up-left and a faint caustic in the lower belly, both scaled to the drop.
    let tm = L.p[0].w;
    var tint = vec3f(1.0);
    if (tm > 0.45) {
      let pc = palAt(0.6 + 0.2 * L.p[1].y + tm);
      tint = mix(vec3f(1.0), pc / max(luma(pc), 0.05), 0.45);
    }
    let gp = s - vec2f(-0.35, -0.4);
    let glint = exp(-dot(gp, gp) * 60.0) * smoothstep(0.003, 0.015, r);
    let bp = s - vec2f(0.1, 0.55);
    let belly = exp(-dot(bp, bp) * 8.0);
    dc += tint * glint * (0.32 + 0.15 * L.p[3].w) + dc * belly * 0.2;
    let px = 1.0 / L.res.y;
    let mask = smoothstep(1.0, 1.0 - 1.5 * px / max(r, 1e-4), l);
    col = mix(col, dc, mask);
  }
  return ov_commit(sharp, col);
}
`,
});
