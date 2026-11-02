import type { LayerDef } from '../layer';

/** Ring slots (rings alive at once; NR bars must outlast a ring's ~12 s life) and points per line. */
const NR = 12;
const K = 4096;
/** Each ring is a ribbon of BL parallel lines, like the hairs of a brush. */
const BL = 3;
const RINGS = NR * BL * K;
/** Two particles after the rings hold the playhead frame for the vertex shader. */
const N = RINGS + 64;
/** Seconds a melodic vortex lives. */
const LIFE = 2.4;
const MAXV = 24;

/**
 * Melody ink: suminagashi around the playhead, stirred by the melody.
 *
 * A bowl of dark water faces the camera at the playhead, open in the middle so you look through it
 * at the music ahead. Every bar drops a ring of ink at the inner edge in the colour of the chord
 * sounding (the first ring of a new harmony is drawn bolder), and the rings drift outward and fade at
 * the rim, so the bowl holds the harmony of the last ten seconds as nested lines. Each ring is a
 * ribbon of three hairlines, a few thousand points each, advected as material lines. At rest the
 * water turns slowly and laminar, the inner rings a little faster.
 *
 * Each melodic attack injects a vortex where the melody is. The melodic gesture's height sets how
 * high on the bowl it stirs, the interval's direction sets the side and spin (rising intervals
 * stir the right side counter-clockwise, falling ones the left side clockwise), and the note's
 * strength sets how hard. Vortices spread and fade over about two seconds while drifting with the
 * water, so a phrase folds the rings into swirls that are then sheared out into fine filaments.
 * The attack lights the ink it lands on, and that light is carried into the swirl. Minor and tense
 * harmony shears the rings harder, winding the folds tighter. A returning motif stirs the same way.
 */
export default {
  id: 'melody-ink',
  role: 'form',
  source: 'particles',
  particles: N,
  verts: 6,
  blend: 'additive',
  weight: 1,
  layouts: ['flight', 'road', 'river', 'helix'],
  wgsl: /* wgsl */ `
const MELODY_INK_IN: f32 = 0.42;
/** Source strength: ink takes ~10 s to drift across the bowl. */
const MELODY_INK_Q: f32 = 0.041;

/** Playhead frame: o = centre, e1 = right as seen by the camera, e2 = up, e3 = away from the camera, r = bowl radius. */
struct MelodyInkFrame { o: vec3f, e1: vec3f, e2: vec3f, e3: vec3f, r: f32 };
/** Screen position of p in half-height units (x right, y up) and its depth. */
fn melody_ink_screen(p: vec3f, eye: vec3f, fw: vec3f, sx: vec3f, sy: vec3f, th: f32) -> vec3f {
  let v = p - eye;
  let z = max(dot(v, fw), 0.2);
  return vec3f(dot(v, sx) / (z * th), dot(v, sy) / (z * th), z);
}
fn melody_ink_frame() -> MelodyInkFrame {
  var f: MelodyInkFrame;
  let t = W.h.z;
  let eye = camEye();
  let fw = normalize(camTarget() - eye);
  let sx = normalize(cross(fw, camUp()));
  let sy = cross(sx, fw);
  let th = tan(0.5 * S.p[7].x);
  let c = LCenter(t);
  var up = vec3f(0.0);
  for (var k = -2; k <= 2; k++) { up += LUp(t + f32(k) * 0.5); }
  up = normalize(up + vec3f(0.0, 1e-4, 0.0));
  // When the camera looks past the playhead (alongside the road), the bowl moves ahead along the
  // path toward what the camera looks at, just far enough to sit comfortably in view. Continuous.
  let sc = melody_ink_screen(c, eye, fw, sx, sy, th);
  let over = max(abs(sc.x) / (F.aspect * 0.42), abs(sc.y) / 0.42);
  var o = mix(c, camTarget(), sat(1.0 - 1.0 / max(over, 1.0)));
  var r = length(eye - o) * 0.31;
  // Stay clear of the layout's score surface: inside a tunnel wall (positive lane) the bowl stays
  // within it; over a ground it rises just enough to clear it.
  let sd = length(L(t, S.p[0].z, SURFACE_LANE) - c);
  if (SURFACE_LANE > 0.0) { r = min(r, 0.8 * sd); } else { o = o + up * max(r - 0.8 * sd, 0.0); }
  // Final guard: keep the whole bowl in frame.
  let so = melody_ink_screen(o, eye, fw, sx, sy, th);
  let rr = min(r / (so.z * th), 0.7);
  let mx = max(F.aspect * 0.95 - rr * 1.3, 0.0);
  let my = max(0.95 - rr * 1.15, 0.0);
  o = eye + (fw + (sx * clamp(so.x, -mx, mx) + sy * clamp(so.y, -my, my)) * th) * so.z;
  f.r = clamp(rr * so.z * th, 0.3, 6.0);
  f.o = o;
  // The bowl faces the camera, so swirls read from every travel camera, and stays upright on the path.
  f.e3 = normalize(o - eye + vec3f(0.0, 0.0, 1e-4));
  var u2 = up - f.e3 * dot(up, f.e3);
  if (length(u2) < 1e-4) { u2 = vec3f(0.0, 1.0, 0.0) - f.e3 * f.e3.y; }
  f.e2 = normalize(u2);
  f.e1 = cross(f.e3, f.e2);
  return f;
}

/** Base angular velocity at radius r: inner rings turn faster; minor/tense harmony shears harder. */
fn melody_ink_omega(r: f32, shear: f32) -> f32 {
  return 0.16 * pow(0.7 / max(r, 0.2), 0.6 + 1.8 * shear);
}
fn melody_ink_base(q: vec3f, shear: f32) -> vec2f {
  let r = max(length(q.xy), 1e-3);
  return vec2f(-q.y, q.x) * melody_ink_omega(r, shear) + q.xy / (r * r) * MELODY_INK_Q;
}
/** Lamb-Oseen velocity of all vortices at q, weaker away from the bowl's mid-plane. */
fn melody_ink_swirl(q: vec3f, vc: ptr<function, array<vec4f, ${MAXV}>>, nv: u32) -> vec2f {
  var u = vec2f(0.0);
  for (var k = 0u; k < nv; k++) {
    let v = (*vc)[k];
    let d = q.xy - v.xy;
    let r2 = dot(d, d) + 1e-5;
    u += vec2f(-d.y, d.x) * (v.z * 0.159155 / r2 * (1.0 - exp(-r2 / v.w)));
  }
  return u * exp(-q.z * q.z / 0.05);
}

/** First note index in the window whose start >= t (notes are sorted by start). */
fn melody_ink_first(t: f32) -> u32 {
  var lo = u32(W.n.x);
  var hi = lo + u32(W.n.y);
  loop {
    if (lo >= hi) { break; }
    let m = (lo + hi) / 2u;
    if (notes[m].start < t) { lo = m + 1u; } else { hi = m; }
  }
  return lo;
}

/** Seconds between rings: one per bar, kept within 1.2..2.6 s so NR rings span more than a ring's ~12.5 s life. */
fn melody_ink_period() -> f32 { return clamp(240.0 / max(F.bpm, 40.0), 1.2, 2.6); }
/**
 * The chord sounding at song time t from the chord events (root -1 when none). The filtered score
 * texture blends neighbouring chords across a row at every change, which would mix roots.
 */
fn melody_ink_chord(t: f32) -> ChordE {
  var cur = ChordE(0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  let c0 = u32(W.n.z);
  for (var j = c0; j < c0 + u32(W.n.w); j++) {
    if (chords[j].start <= t && t < chords[j].end) { cur = chords[j]; }
  }
  // Rings re-created after a seek can predate the window: read the score, rounding to a whole root.
  if (cur.root < 0.0 && t < W.h.z - 1.5) {
    let ch = chordAtT(t - W.h.z);
    cur.root = select(-1.0, round(ch.x * 13.0 - 1.0), ch.x > 0.02);
  }
  return cur;
}
/** Palette hue of a chord (0.5 = neutral when there is none). */
fn melody_ink_hue(c: ChordE) -> f32 {
  return select(0.5, pitchHue(c.root) * 0.55, c.root >= 0.0);
}
/** Integral of the unit triangular kernel up to u. */
fn melody_ink_tri(u: f32) -> f32 {
  let v = clamp(u, -1.0, 1.0);
  return select(1.0 - (1.0 - v) * (1.0 - v) * 0.5, (1.0 + v) * (1.0 + v) * 0.5, v < 0.0);
}
/** Harmony character, integrated exactly over ~1.5 s of chords: minor, diminished and tension shear harder. */
fn melody_ink_shear() -> f32 {
  var sh = 0.0;
  let ctr = W.h.z - 0.6;
  let c0 = u32(W.n.z);
  for (var j = c0; j < c0 + u32(W.n.w); j++) {
    let c = chords[j];
    let w = melody_ink_tri((c.end - ctr) / 0.75) - melody_ink_tri((c.start - ctr) / 0.75);
    if (w <= 0.0) { continue; }
    let minor = select(0.0, select(0.6, 1.0, c.quality > 2.5), c.quality > 1.5);
    sh += w * sat(minor * 0.6 + c.tension * 0.6);
  }
  return sh;
}

fn sim_melody_ink(i: u32, p: ptr<function, Particle>) {
  let now = W.h.z;
  let dt = W.h.w;
  if (i >= ${RINGS}u) {
    if (i > ${RINGS + 1}u) { return; }
    let f = melody_ink_frame();
    if (i == ${RINGS}u) { (*p).pos = vec4f(f.o, f.r); (*p).vel = vec4f(f.e1, 0.0); }
    else { (*p).pos = vec4f(f.e2, 0.0); (*p).vel = vec4f(f.e3, 0.0); }
    return;
  }
  // Which ring this point belongs to now: one ring per bar; slot s holds the newest ring id congruent to s.
  let P = melody_ink_period();
  let idNow = i32(floor(max(now, 0.0) / P));
  let slot = i32(i / ${BL * K}u);
  let line = f32((i / ${K}u) % ${BL}u);
  let id = idNow - ((idNow - slot) % ${NR} + ${NR}) % ${NR};
  if (idNow < 0 || id < 0) { (*p).vel = vec4f(0.0); return; }
  let T = f32(id) * P;
  var q = (*p).pos.xyz;
  var heat = (*p).pos.w;
  var alive = (*p).vel.y;
  var tint = (*p).vel.w;
  if (abs((*p).vel.x - f32(id + 1)) > 0.5) {
    // A new ring: born at the inner edge (or, after a seek, where an unstirred ring would be now).
    let r0 = MELODY_INK_IN + line * 0.014;
    let r = sqrt(r0 * r0 + 2.0 * MELODY_INK_Q * max(now - T, 0.0));
    let a = f32(i % ${K}u) / ${K}.0 * TAU + hashU(u32(id) * 977u + 5u) * TAU;
    q = vec3f(cos(a) * r, sin(a) * r, (hashU(u32(id) * 131u + 7u) - 0.5) * 0.3);
    heat = 0.0;
    alive = select(0.0, 1.0, r < 1.0);
    // The ring takes the colour of the chord it was born in; the first ring of a new harmony is bolder.
    let cb = melody_ink_chord(T + 0.05);
    let hb = melody_ink_hue(cb);
    let fresh = abs(cb.root - melody_ink_chord(T - P + 0.05).root) > 0.5;
    tint = hb + select(0.0, 2.0, fresh);
  }
  if (alive < 0.5) { (*p).pos = vec4f(q, 0.0); (*p).vel = vec4f(f32(id + 1), 0.0, T, tint); return; }

  let shear = melody_ink_shear();

  // The melody's vortices: lead attacks of the last LIFE seconds (the bass when the lead rests).
  var vc: array<vec4f, ${MAXV}>;
  var nv = 0u;
  let lo = melody_ink_first(now - ${LIFE});
  let hi = u32(W.n.x + W.n.y);
  var haveLead = false;
  for (var j = lo; j < hi; j++) {
    let n = notes[j];
    if (n.start > now) { break; }
    if (n.role < 0.5) { haveLead = true; break; }
  }
  let role = select(1.0, 0.0, haveLead);
  // The previous melody note, for the first interval.
  var prevP = -1.0;
  var prevEnd = -100.0;
  let w0 = u32(W.n.x);
  for (var k = 1u; k <= 16u; k++) {
    if (lo < w0 + k) { break; }
    let n = notes[lo - k];
    if (abs(n.role - role) < 0.5) { prevP = n.pitch; prevEnd = n.end; break; }
  }
  var dye = 0.0;
  for (var j = lo; j < hi; j++) {
    let n = notes[j];
    if (n.start > now) { break; }
    if (abs(n.role - role) > 0.5) { continue; }
    let iv = select(0.0, n.pitch - prevP, prevP > 0.0 && n.start - prevEnd < 1.5);
    prevP = n.pitch;
    prevEnd = n.end;
    let age = now - n.start;
    // Where the melody is: the gesture's height sets how high on the bowl, the interval's direction
    // the side (rising right, falling left); repeated notes stir at the top or bottom.
    let g = gestAt(n.start + 0.25);
    let h = clamp(g.fwd.w * 1.4, -1.0, 1.0);
    let s = clamp(iv / 3.0, -1.0, 1.0);
    let dir = normalize(vec2f(s * sqrt(max(1.0 - h * h, 0.05)), h) + vec2f(0.0, 0.02));
    let rv = 0.7;
    let ang = atan2(dir.y, dir.x) + melody_ink_omega(rv, shear) * age;
    let c = vec2f(cos(ang), sin(ang)) * rv;
    let spin = select(sign(iv), 0.6, abs(iv) < 0.5);
    let env = sat(age / 0.07) * exp(-age / 0.7);
    let gam = spin * 1.3 * (0.35 + 0.65 * n.strength) * (0.65 + 0.35 * min(abs(iv) / 5.0, 1.0)) * env * (1.0 - 0.4 * role);
    // A ring buffer: in a dense run the newest vortices replace the oldest (nearly spent) ones.
    vc[nv % ${MAXV}u] = vec4f(c, gam, 0.004 + 0.02 * age);
    nv += 1u;
    // The attack lights the ink it lands on.
    if (age < 0.15) {
      let d = q.xy - c;
      dye = max(dye, exp(-dot(d, d) / 0.03) * (0.4 + 0.6 * n.strength));
    }
  }

  nv = min(nv, ${MAXV}u);
  // Midpoint integration, sub-stepped so a long frame can't fling ink.
  let steps = clamp(u32(ceil(dt / 0.02)), 1u, 3u);
  let hs = dt / f32(steps);
  for (var s = 0u; s < steps; s++) {
    let u0 = melody_ink_base(q, shear) + melody_ink_swirl(q, &vc, nv);
    let qm = q + vec3f(u0 * hs * 0.5, 0.0);
    q += vec3f((melody_ink_base(qm, shear) + melody_ink_swirl(qm, &vc, nv)) * hs, 0.0);
  }
  heat = min(heat * exp(-dt * 0.8) + dye * dt * 9.0, 1.5);
  let r = length(q.xy);
  alive = select(1.0, 0.0, r > 1.05);
  (*p).pos = vec4f(q, heat);
  (*p).vel = vec4f(f32(id + 1), alive, T, tint);
}

fn vs_melody_ink(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  if (ii >= ${RINGS}u) { return hidden(); }
  let a = pstate_melody_ink[ii];
  let nx = select(ii + 1u, ii + 1u - ${K}u, (ii % ${K}u) == ${K - 1}u);
  let bq = pstate_melody_ink[nx];
  if (a.vel.y < 0.5 || bq.vel.y < 0.5 || abs(a.vel.x - bq.vel.x) > 0.5) { return hidden(); }
  let seg = length(a.pos.xy - bq.pos.xy);
  let age = W.h.z - a.vel.z;
  let rm = length((a.pos.xy + bq.pos.xy) * 0.5);
  // Fade in at birth, thin out toward the rim and where the line has been stretched apart.
  let edge = sat(age / 0.4) * (1.0 - smoothstep(9.0, 12.5, age)) * smoothstep(MELODY_INK_IN - 0.08, MELODY_INK_IN + 0.02, rm) * (1.0 - smoothstep(0.82, 1.03, rm));
  // Ink thins as it is stretched (a fold carries the same ink over a longer line); a torn segment vanishes.
  let stretch = clamp(0.008 / seg, 0.3, 1.0) * (1.0 - smoothstep(0.04, 0.1, seg));
  let lit = 0.5 * (a.pos.w + bq.pos.w);
  let tier = select(0.55, 1.0, a.vel.w > 1.5) * select(0.55, 1.0, (ii / ${K}u) % ${BL}u == 1u);
  let b = edge * stretch * (0.38 * tier + 1.1 * lit);
  if (b < 0.002) { return hidden(); }
  let s0 = pstate_melody_ink[${RINGS}u];
  let s1 = pstate_melody_ink[${RINGS + 1}u];
  let O = s0.pos.xyz;
  let R = s0.pos.w;
  let e1 = s0.vel.xyz;
  let e2 = s1.pos.xyz;
  let e3 = s1.vel.xyz;
  let pa = O + (e1 * a.pos.x + e2 * a.pos.y + e3 * a.pos.z) * R;
  let pb = O + (e1 * bq.pos.x + e2 * bq.pos.y + e3 * bq.pos.z) * R;
  let w = length(camEye() - pa) * 0.0012;
  let wp = stripPoint(pa, pb, qu(vi), qv(vi), w);
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(qv(vi) * 2.0 - 1.0, 0.0, 0.0, 0.0);
  let hue = fract(a.vel.w);
  o.b = vec4f(hue, b, lit, 0.0);
  return o;
}
fn fs_melody_ink(in: LOut) -> vec4f {
  let v = in.a.x;
  let k = (1.0 - v * v) * in.b.y;
  let col = mix(palL(S.p[3].x + in.b.x, 1.0), vec3f(1.0), sat(in.b.z - 0.4) * 0.5);
  return glowOut(col * k * S.p[3].y, in.wp);
}
`,
} satisfies LayerDef;
