import type { LayerDef } from '../layer';

const RAYS = 8;
const PARTS = 5; // three main segments + two branches per ray

/**
 * The backbeat as breaking glass, the hats as the grid it breaks on. Each snare cracks the plane
 * across the time axis at its exact moment: straight crack segments run out from an impact point,
 * kink and branch deterministically (seeded by the hit), more and longer the harder it was hit.
 * The impact sits at the snare's position in the bar (beats 2 and 4 land on opposite sides, fills
 * walk around), so the groove's backbeat reads as a pattern. Ahead, only the impact mark waits; on
 * the hit the cracks propagate outward in ~0.1 s and slowly cool. Hats are fine points on an outer
 * ring at their position within the beat: straight sixteenths make four rails, swing bends them,
 * triplets make three.
 */
export default {
  id: 'snare-fracture',
  role: 'rhythm',
  source: 'hits',
  verts: RAYS * PARTS * 6,
  blend: 'additive',
  weight: 0.35,
  layouts: '*',
  wgsl: /* wgsl */ `
fn snare_fracture_frame(t: f32) -> mat3x3f {
  var ax = LCenter(t + 0.05) - LCenter(t);
  if (length(ax) < 1e-5) { ax = camEye() - LCenter(t); }
  ax = normalize(ax);
  var up = LUp(t) - ax * dot(LUp(t), ax);
  if (length(up) < 1e-3) { up = frameX(t, ax); }
  up = normalize(up);
  return mat3x3f(cross(up, ax), up, ax);
}
fn snare_fracture_radius() -> f32 {
  let fr = snare_fracture_frame(F.songTime);
  let c = LCenter(F.songTime);
  var r = 0.6;
  for (var k = 0u; k < 5u; k++) {
    let d = L(F.songTime, S.p[0].z - 24.0 + f32(k) * 9.0, 0.0) - c;
    r = max(r, length(vec2f(dot(d, fr[0]), dot(d, fr[1]))));
  }
  return r;
}
fn snare_fracture_h(seed: u32, k: u32) -> f32 { return hashU(seed * 977u + k * 131u + 7u); }
fn snare_fracture_dir(a: f32) -> vec2f { return vec2f(cos(a), sin(a)); }

fn vs_snare_fracture(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let h = hits[ii];
  let kind = u32(h.kind + 0.5);
  let age = F.songTime - h.time;
  if (kind == 0u || age > min(S.p[1].x, 2.0) || age < -S.p[1].y) { return hidden(); }
  let q = vi / 6u;
  let cc = vi % 6u;
  let R0 = snare_fracture_radius();
  let fr = snare_fracture_frame(h.time);
  let C = LCenter(h.time);
  let BB = 60.0 / max(F.bpm, 40.0);
  // Position of the hit in its beat / bar, from the live grid (stable over the visible window).
  let beats = (h.time - (F.songTime - F.beatPhase * BB)) / BB;
  let bars = (h.time - (F.songTime - F.barPhase * BB * 4.0)) / (BB * 4.0);
  var a2: vec2f;
  var b2: vec2f;
  var w = 1.0;
  var reveal = 1.0;
  var u = qu(cc);

  if (kind == 2u) {
    // Hat: one fine point on the outer ring at its place in the beat.
    if (q > 0u) { return hidden(); }
    let ang = fract(beats + 0.02) * TAU + PI * 0.5;
    let p2 = snare_fracture_dir(ang) * R0 * 1.25;
    let pc = C + fr[0] * p2.x + fr[1] * p2.y;
    let fwd = normalize(pc - camEye());
    let rt = normalize(cross(fwd, camUp()));
    let upv = cross(rt, fwd);
    let s = lineW(pc) * (2.6 + 2.0 * h.strength);
    let qq = vec2f(qu(cc) * 2.0 - 1.0, qv(cc) * 2.0 - 1.0);
    let wp = pc + (rt * qq.x + upv * qq.y) * s;
    o.pos = toClip(wp);
    o.wp = wp;
    o.a = vec4f(qq, 1.0, 0.0);
    o.b = vec4f(h.time, h.strength, 2.0, 1.0);
    return o;
  }

  // Snare: crack network from the impact point.
  let seed = ii;
  let nRays = 4u + u32(h.strength * 4.0 + snare_fracture_h(seed, 0u) * 1.5);
  let j = q / ${PARTS}u;
  let part = q % ${PARTS}u;
  if (j >= min(nRays, ${RAYS}u)) { return hidden(); }
  let impA = fract(bars + 0.01) * TAU + PI * 0.5;
  let imp = snare_fracture_dir(impA) * R0 * 0.3;
  let L0 = R0 * (0.55 + 0.75 * h.strength) * (0.75 + 0.5 * snare_fracture_h(seed, 10u + j));
  var dirA = (f32(j) + 0.6 * snare_fracture_h(seed, 20u + j)) / f32(nRays) * TAU + impA;
  var p = imp;
  var dist = 0.0;
  var kinkP = array<vec2f, 3>(imp, imp, imp);
  var kinkA = array<f32, 3>(0.0, 0.0, 0.0);
  var kinkD = array<f32, 3>(0.0, 0.0, 0.0);
  var segL = array<f32, 3>(0.0, 0.0, 0.0);
  for (var k = 0u; k < 3u; k++) {
    kinkP[k] = p;
    kinkA[k] = dirA;
    kinkD[k] = dist;
    let l = L0 * (0.26 + 0.07 * f32(k)) * (0.75 + 0.5 * snare_fracture_h(seed, 30u + j * 3u + k));
    segL[k] = l;
    p += snare_fracture_dir(dirA) * l;
    dist += l;
    dirA += (snare_fracture_h(seed, 40u + j * 3u + k) - 0.5) * 0.9;
  }
  var d0 = 0.0;
  var len = 0.0;
  if (part < 3u) {
    a2 = kinkP[part];
    len = segL[part];
    b2 = a2 + snare_fracture_dir(kinkA[part]) * len;
    d0 = kinkD[part];
    w = 1.25 - 0.3 * f32(part);
  } else {
    // Branches split off the second and third segment starts.
    let k = part - 2u;
    let hb = snare_fracture_h(seed, 50u + j * 2u + k);
    if (hb < 0.3 - 0.3 * h.strength) { return hidden(); }
    let side = select(-1.0, 1.0, snare_fracture_h(seed, 60u + j * 2u + k) > 0.5);
    a2 = kinkP[k];
    len = segL[k] * (0.45 + 0.5 * hb);
    b2 = a2 + snare_fracture_dir(kinkA[k] + side * (0.45 + 0.4 * hb)) * len;
    d0 = kinkD[k];
    w = 0.6;
  }
  // Ahead: only the impact mark (the first stub of each ray). Played: the crack front runs outward.
  let front = select(L0 * 0.06, L0 * 1.3 * sqrt(sat(age / 0.12)), age >= 0.0);
  reveal = sat((front - d0) / max(len, 1e-4));
  if (reveal <= 0.0) { return hidden(); }
  let a3 = C + fr[0] * a2.x + fr[1] * a2.y;
  let b3 = C + fr[0] * b2.x + fr[1] * b2.y;
  let bEnd = mix(a3, b3, reveal);
  let pm = mix(a3, bEnd, u);
  let wp = stripPoint(a3, bEnd, u, qv(cc), lineW(pm) * w * (0.8 + 0.6 * h.strength));
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(qv(cc), 0.0, 0.0, (d0 + u * len * reveal) / L0);
  o.b = vec4f(h.time, h.strength, 1.0, 0.0);
  return o;
}

fn fs_snare_fracture(in: LOut) -> vec4f {
  let age = F.songTime - in.b.x;
  let isHat = in.b.z > 1.5;
  var k: f32;
  var cov: f32;
  if (isHat) {
    let r = length(in.a.xy);
    cov = 1.0 - smoothstep(0.55, 1.0, r);
    k = select(0.18 * exp(age * 0.25), 0.25 + 3.0 * exp(-age * 7.0), age >= 0.0) * (0.4 + in.b.y);
  } else {
    cov = 1.0 - smoothstep(0.5, 1.0, abs(in.a.x * 2.0 - 1.0));
    // Hot near the impact at the hit, cooling outward and over time.
    let heat = exp(-age * 2.4) * (1.0 + 1.5 * exp(-in.a.w * 2.0));
    k = select(0.25 * exp(age * 0.2), 0.12 * exp(-age * 2.0) + 0.9 * heat, age >= 0.0) * (0.5 + in.b.y);
  }
  let col = palL(S.p[3].x + select(0.72, 0.2, isHat), 1.0);
  return glowOut(col * k * cov * S.p[3].y, in.wp);
}
`,
} satisfies LayerDef;
