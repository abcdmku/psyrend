import type { LayerDef } from '../layer';

const SIDES = 6;
const PAST_BEATS = 8;
const SLOTS = 48 * 4; // sixteenth slots over 48 beats
const RING_V = SIDES * 6;
const RIB_SEG = 32;
const SHELLS = 8;
const EQ_SEG = 48;
const MER_SEG = 6;
const SHELL_V = (EQ_SEG + 12 * MER_SEG) * 6;
const CORE_V = 3 * 6;

const A_END = SLOTS * RING_V;
const B_END = A_END + SIDES * RIB_SEG * 6;
const C_END = B_END + CORE_V;
const TOTAL = C_END + SHELLS * SHELL_V;

/**
 * The drop as an event in space. While the song anticipates a drop, the build becomes a twisting
 * funnel: a polygon ring on every beat, plus a ring on every sixteenth where a kick or snare lands,
 * converging toward the drop moment, so snare rolls visibly compress the structure. The funnel tightens
 * and brightens with the live anticipation; at its apex waits the drop chord's triad (circle-of-
 * fifths triangle). At the drop the funnel blows open and each of the drop's first eight beats
 * launches a spherical wavefront from the drop point: its equator is the beat (bright with the kick
 * that lands on it), its twelve meridians are the pitch classes, lit by how strongly each sounds.
 */
export default {
  id: 'drop-shockwave',
  role: 'rhythm',
  source: 'once',
  verts: TOTAL,
  blend: 'additive',
  weight: 0.5,
  layouts: ['road', 'river', 'helix', 'spiral', 'flight'],
  wgsl: /* wgsl */ `
fn drop_shockwave_secAt(tq: f32) -> vec2f {
  let g = gridAt(tq - F.songTime);
  let qb = gridAt(tq + 3.0 - F.songTime).w;
  var len = 3.0 / max(qb - g.w, 1e-4);
  if (qb <= g.w + 1e-4) { len = 3.0 / max(g.w - gridAt(tq - 3.0 - F.songTime).w, 1e-4); }
  return vec2f(tq - g.w * len, len);
}
/** (drop time, build start, seconds since the drop (<0 before it), visibility). */
fn drop_shockwave_drop() -> vec4f {
  let BL = 240.0 / max(F.bpm, 40.0);
  if (F.anticipation > 0.004) {
    let cur = drop_shockwave_secAt(F.songTime);
    let td = drop_shockwave_secAt(cur.x + cur.y + 0.4).x;
    let bs = max(cur.x, td - 8.0 * BL);
    return vec4f(td, bs, F.songTime - td, sat(sqrt(F.anticipation) * 4.0));
  }
  if (F.dropPulse > 0.03) {
    let td = F.songTime + 1.2 * log(F.dropPulse);
    let prev = drop_shockwave_secAt(td - 0.4);
    let bs = max(prev.x, td - 8.0 * BL);
    return vec4f(td, bs, F.songTime - td, sat(F.dropPulse * 1.6));
  }
  return vec4f(0.0, 0.0, 0.0, 0.0);
}
fn drop_shockwave_frame(t: f32) -> mat3x3f {
  var ax = LCenter(t + 0.05) - LCenter(t);
  if (length(ax) < 1e-5) { ax = camEye() - LCenter(t); }
  ax = normalize(ax);
  var up = LUp(t) - ax * dot(LUp(t), ax);
  if (length(up) < 1e-3) { up = frameX(t, ax); }
  up = normalize(up);
  return mat3x3f(cross(up, ax), up, ax);
}
fn drop_shockwave_radius() -> f32 {
  let fr = drop_shockwave_frame(F.songTime);
  let c = LCenter(F.songTime);
  var r = 0.6;
  for (var k = 0u; k < 5u; k++) {
    let d = L(F.songTime, S.p[0].z - 24.0 + f32(k) * 9.0, 0.0) - c;
    r = max(r, length(vec2f(dot(d, fr[0]), dot(d, fr[1]))));
  }
  return r * 1.15 + 0.4;
}
/** Funnel point for song time t (in the build), angle index j. */
fn drop_shockwave_funnel(t: f32, j: f32, d: vec4f, R0: f32) -> vec3f {
  let x = sat((t - d.y) / max(d.x - d.y, 0.1));
  let blast = max(d.z, 0.0);
  let squeeze = 1.0 - 0.25 * F.anticipation;
  let r = R0 * squeeze * (1.0 - 0.9 * x * x) * (1.0 + blast * blast * 6.0 * (0.3 + x));
  let a = j / ${SIDES}.0 * TAU + x * x * PI * 1.5 + PI * 0.5;
  let fr = drop_shockwave_frame(t);
  return LCenter(t) + (fr[0] * cos(a) + fr[1] * sin(a)) * r;
}

fn vs_drop_shockwave(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  if (F.anticipation < 0.004 && F.dropPulse < 0.03) { return hidden(); }
  let d = drop_shockwave_drop();
  if (d.w <= 0.0) { return hidden(); }
  let R0 = drop_shockwave_radius();
  let cc = vi % 6u;
  let u = qu(cc);
  let v = qv(cc);
  var a: vec3f;
  var b: vec3f;
  var w = 1.0;
  var k = 0.0;     // brightness
  var hue = 0.0;
  var tt = d.x;

  if (vi < ${A_END}u) {
    // Funnel rings: every beat, plus sixteenths where the drums land.
    let slot = vi / ${RING_V}u;
    let side = f32((vi % ${RING_V}u) / 6u);
    let BB = 60.0 / max(F.bpm, 40.0);
    let tb0 = F.songTime - F.beatPhase * BB;
    let s16 = f32(slot) - ${PAST_BEATS * 4}.0;
    let t = tb0 + s16 * BB * 0.25;
    if (t < d.y - 0.02 || t > d.x - 0.03) { return hidden(); }
    if (t < F.songTime - S.p[1].x - 1.0 || t > F.songTime + S.p[1].y) { return hidden(); }
    let dr = drumsAt(t - F.songTime + 0.03);
    let onBeat = (slot % 4u) == 0u;
    let drum = sat(dr.x + dr.y);
    if (!onBeat && drum < 0.25) { return hidden(); }
    a = drop_shockwave_funnel(t, side, d, R0);
    b = drop_shockwave_funnel(t, side + 1.0, d, R0);
    let x = sat((t - d.y) / max(d.x - d.y, 0.1));
    w = select(0.7, 1.0, onBeat) * (0.7 + 1.3 * drum);
    k = (0.1 + 0.45 * drum + 0.3 * x) * select(0.45, 1.0, onBeat);
    hue = x * 0.25;
    tt = t;
  } else if (vi < ${B_END}u) {
    // Funnel ribs: the twisted lines joining the rings, from the build start to the drop.
    let r = vi - ${A_END}u;
    let j = f32(r / (${RIB_SEG}u * 6u));
    let sg = f32((r / 6u) % ${RIB_SEG}u);
    let t0 = max(d.y, F.songTime - S.p[1].x - 1.0);
    let t1 = min(d.x, F.songTime + S.p[1].y);
    if (t1 <= t0) { return hidden(); }
    let ta = mix(t0, t1, sg / ${RIB_SEG}.0);
    let tb = mix(t0, t1, (sg + 1.0) / ${RIB_SEG}.0);
    a = drop_shockwave_funnel(ta, j, d, R0);
    b = drop_shockwave_funnel(tb, j, d, R0);
    w = 0.45;
    k = 0.18 + 0.5 * F.anticipation;
    hue = 0.1;
    tt = mix(ta, tb, u);
  } else if (vi < ${C_END}u) {
    // The drop chord waiting at the apex: its triad on the circle of fifths.
    let e = (vi - ${B_END}u) / 6u;
    let ch = chordAtT(d.x - F.songTime + 0.15);
    if (ch.x <= 0.0 || d.z > 1.5) { return hidden(); }
    let root = round(ch.x * 13.0 - 1.0);
    let third = select(3.0, 4.0, ch.y > 0.75);
    let fifth = select(7.0, 6.0, ch.y < 0.3);
    var iv = array<f32, 4>(0.0, third, fifth, 0.0);
    let rc = R0 * (0.35 + 0.25 * F.anticipation) * (1.0 + max(d.z, 0.0) * 8.0);
    let fr = drop_shockwave_frame(d.x);
    let a0 = fifthsAng(fmod(root + iv[e], 12.0));
    let a1 = fifthsAng(fmod(root + iv[e + 1u], 12.0));
    a = LCenter(d.x) + (fr[0] * cos(a0) + fr[1] * sin(a0)) * rc;
    b = LCenter(d.x) + (fr[0] * cos(a1) + fr[1] * sin(a1)) * rc;
    w = 1.6;
    k = (0.8 + 2.5 * F.anticipation) * select(1.0, exp(-d.z * 2.0), d.z > 0.0);
    hue = 0.33;
  } else {
    // Wavefronts: one spherical shell per beat after the drop.
    if (d.z < 0.0) { return hidden(); }
    let r = vi - ${C_END}u;
    let sh = r / ${SHELL_V}u;
    let q = (r % ${SHELL_V}u) / 6u;
    let BB = 60.0 / max(F.bpm, 40.0);
    let ts = d.x + f32(sh) * BB;
    let age = F.songTime - ts;
    if (age < 0.0 || age > 3.5) { return hidden(); }
    let kick = sat(drumsAt(ts - F.songTime + 0.03).x + 0.25);
    let rad = R0 * (0.3 + 2.6 * pow(age, 0.75));
    let fr = drop_shockwave_frame(d.x);
    let P = LCenter(d.x);
    let fade = exp(-age * 0.9) * pow(0.85, f32(sh));
    tt = ts;
    if (q < ${EQ_SEG}u) {
      let a0 = f32(q) / ${EQ_SEG}.0 * TAU;
      let a1 = f32(q + 1u) / ${EQ_SEG}.0 * TAU;
      a = P + (fr[0] * cos(a0) + fr[1] * sin(a0)) * rad;
      b = P + (fr[0] * cos(a1) + fr[1] * sin(a1)) * rad;
      w = 2.2 * (0.6 + kick);
      k = 2.2 * kick * fade;
      hue = 0.5;
    } else {
      let m = (q - ${EQ_SEG}u) / ${MER_SEG}u;
      let sg = f32((q - ${EQ_SEG}u) % ${MER_SEG}u);
      // Pitch-class salience at the drop, summed over octaves.
      var sal = 0.0;
      for (var o2 = 0u; o2 < 5u; o2++) { sal += score(d.x - F.songTime + 0.25, 36.0 + f32(m) + 12.0 * f32(o2)).r; }
      sal = sat(sal * 0.8);
      if (sal < 0.08) { return hidden(); }
      // A short meridian arc across the ring: longer the more that pitch class sounds.
      let th = fifthsAng(f32(m));
      let span = 0.12 + 0.4 * sal;
      let ph0 = PI * 0.5 + (sg / ${MER_SEG}.0 * 2.0 - 1.0) * span;
      let ph1 = PI * 0.5 + ((sg + 1.0) / ${MER_SEG}.0 * 2.0 - 1.0) * span;
      let rd = fr[0] * cos(th) + fr[1] * sin(th);
      a = P + (fr[2] * cos(ph0) + rd * sin(ph0)) * rad;
      b = P + (fr[2] * cos(ph1) + rd * sin(ph1)) * rad;
      w = 0.6 + sal;
      k = (0.4 + 1.6 * sal) * fade * (0.5 + 0.5 * kick);
      hue = 0.5 + pitchHue(f32(m)) * 0.4;
    }
  }
  let p = mix(a, b, u);
  let wp = stripPoint(a, b, u, v, lineW(p) * w);
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(v, 0.0, 0.0, 0.0);
  o.b = vec4f(tt, k * d.w, hue, 0.0);
  return o;
}

fn fs_drop_shockwave(in: LOut) -> vec4f {
  let dt = in.b.x - F.songTime;
  let lit = select(0.5 + 0.5 * exp(-dt * 0.15), 0.25 + 2.2 * exp(dt * 3.0), dt <= 0.0);
  // Soft-edged strip profile keeps lines crisp but anti-aliased.
  let edge = 1.0 - smoothstep(0.55, 1.0, abs(in.a.x * 2.0 - 1.0));
  let col = palL(S.p[3].x + 0.6 + in.b.z, 1.0);
  return glowOut(col * in.b.y * lit * edge * S.p[3].y, in.wp);
}
`,
} satisfies LayerDef;
