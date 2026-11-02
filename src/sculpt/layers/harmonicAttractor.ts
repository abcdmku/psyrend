import type { LayerDef } from '../layer';

/** Orbiting particles. Slots after them hold the frame, harmony and eased state (see SLOT_*). */
const NP = 16384;
const N = NP + 64;
/** Each particle draws its recent orbit as a filament of SEG segments spanning TRAIL attractor time units. */
const SEG = 8;
const TRAIL = 1.2;
/** Chaos samples per frame, each computed by its own slot thread. */
const NCH = 8;

/**
 * Harmonic attractor: Thomas' cyclically symmetric strange attractor, a three-lobed knot of
 * orbits, at the playhead. Its three lobes are the triad: each takes the colour of one chord tone
 * (root, third, fifth), and the knot turns to face the root's place on the circle of fifths, so a
 * chord change recolours and turns it.
 *
 * Harmony sets the dynamics. Consonance (major, low tension) damps the flow into a few clean,
 * near-periodic loops; minor, diminished and tense chords loosen it into a woven chaotic tangle.
 * Moving round the circle of fifths twists the orbits one way or the other. The harmony is
 * integrated exactly over a ~1.5 s window of the chord events, so every parameter moves
 * continuously, and the particles stay on the attractor as it changes: the form morphs, never jumps.
 *
 * The melody tilts the knot (a rising line lifts its face) and quickens the flow. Each attack
 * lights the lobe of the chord tone it sings, at the melody's height, and that light then travels
 * along the orbits as a bright pulse, stretching into filaments as the chaos carries it round.
 *
 * Slots after the particles (i - NP):
 *   0..3   basis: o + the attractor-to-world columns, tone colours, flow parameters (rewritten every frame)
 *   4, 5   eased state, double-buffered by frame parity: (psi, chaos, song time, initialised)
 *   8..23  chaos samples, double-buffered by parity
 * Every reader takes the other parity's slot, written last frame, so no thread reads a slot that
 * another thread is writing in the same dispatch.
 */
export default {
  id: 'harmonic-attractor',
  role: 'form',
  source: 'particles',
  particles: N,
  verts: SEG * 6,
  blend: 'additive',
  weight: 1,
  layouts: ['flight', 'road', 'river', 'helix'],
  wgsl: /* wgsl */ `
const HARMONIC_ATTRACTOR_A: vec3f = vec3f(0.57735027, 0.57735027, 0.57735027);
const HARMONIC_ATTRACTOR_U: vec3f = vec3f(0.70710678, -0.70710678, 0.0);
const HARMONIC_ATTRACTOR_V: vec3f = vec3f(0.40824829, 0.40824829, -0.81649658);

/** Thomas' flow, plus a twist about its symmetry axis. */
fn harmonic_attractor_f(x: vec3f, b: f32, tw: f32) -> vec3f {
  return vec3f(sin(x.y), sin(x.z), sin(x.x)) - b * x + tw * cross(HARMONIC_ATTRACTOR_A, x);
}

/** Integral of the unit triangular kernel up to u (0 at u = -1, 1 at u = 1). */
fn harmonic_attractor_tri(u: f32) -> f32 {
  let v = clamp(u, -1.0, 1.0);
  return select(1.0 - (1.0 - v) * (1.0 - v) * 0.5, (1.0 + v) * (1.0 + v) * 0.5, v < 0.0);
}
/**
 * Weight of a chord in the harmony window: its exact overlap with a triangular kernel spanning
 * now - 1.25 s .. now + 0.29 s. Integrating the events (rather than sampling the filtered score
 * texture) keeps every harmony-driven parameter continuous from frame to frame.
 */
fn harmonic_attractor_w(c: ChordE) -> f32 {
  let ctr = W.h.z - 0.48;
  return harmonic_attractor_tri((c.end - ctr) / 0.77) - harmonic_attractor_tri((c.start - ctr) / 0.77);
}
/**
 * The harmony, eased: x = damping b (consonant chords damp into clean loops, tension loosens the
 * flow into chaos), y = twist (the side of the circle of fifths), zw = the root's direction on
 * the circle of fifths (unnormalised).
 */
fn harmonic_attractor_harmony() -> vec4f {
  var order = 0.0;
  var tw = 0.0;
  var dir = vec2f(0.0);
  var wsum = 0.0;
  let c0 = u32(W.n.z);
  for (var j = c0; j < c0 + u32(W.n.w); j++) {
    let c = chords[j];
    let w = harmonic_attractor_w(c);
    if (w <= 0.0) { continue; }
    let has = c.root >= 0.0 && c.quality > 0.5;
    // maj 1, min 2, dim 3.
    let cons = select(0.7, select(select(0.1, 0.55, c.quality < 2.5), 1.0, c.quality < 1.5), has);
    order += w * sat(cons - 0.55 * c.tension);
    let a = fifthsAng(max(c.root, 0.0));
    tw += w * select(0.0, sin(a), has);
    dir += w * select(vec2f(0.0), vec2f(cos(a), sin(a)), has);
    wsum += w;
  }
  // Time without a chord counts as a neutral harmony.
  order += (1.0 - wsum) * 0.7;
  return vec4f(mix(0.15, 0.256, order), 0.32 * tw, dir);
}
/** Melody height (gesture), smoothed over ~0.8 s. */
fn harmonic_attractor_height() -> f32 {
  var h = 0.0;
  for (var k = 0; k < 4; k++) { h += melodyHeight(W.h.z - 0.6 + f32(k) * 0.25); }
  return h * 0.25;
}
/** Attractor time units per second: the tempo, quickened by a busy melody. */
fn harmonic_attractor_rate() -> f32 {
  return 2.2 * sqrt(max(F.bpm, 60.0) / 120.0) * (0.75 + 0.6 * melodyActivity(W.h.z));
}

/** Screen position of p in half-height units (x right, y up) and its depth. */
fn harmonic_attractor_screen(p: vec3f, eye: vec3f, fw: vec3f, sx: vec3f, sy: vec3f, th: f32) -> vec3f {
  let v = p - eye;
  let z = max(dot(v, fw), 0.2);
  return vec3f(dot(v, sx) / (z * th), dot(v, sy) / (z * th), z);
}
/** Playhead frame: o centre, e1/e2 screen-aligned, e3 away from the camera, r radius. */
struct HarmonicAttractorFrame { o: vec3f, e1: vec3f, e2: vec3f, e3: vec3f, r: f32 };
fn harmonic_attractor_frame() -> HarmonicAttractorFrame {
  var f: HarmonicAttractorFrame;
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
  // When the camera looks past the playhead (alongside the road), the form moves ahead along the
  // path toward what the camera looks at, just far enough to sit comfortably in view. Continuous.
  let sc = harmonic_attractor_screen(c, eye, fw, sx, sy, th);
  let over = max(abs(sc.x) / (F.aspect * 0.42), abs(sc.y) / 0.42);
  var o = mix(c, camTarget(), sat(1.0 - 1.0 / max(over, 1.0)));
  var r = length(eye - o) * 0.32;
  // Stay clear of the score surface: within a tunnel wall, or risen above a ground.
  let sd = length(L(t, S.p[0].z, SURFACE_LANE) - c);
  if (SURFACE_LANE > 0.0) { r = min(r, 0.75 * sd); } else { o = o + up * max(r - 0.8 * sd, 0.0); }
  // Final guard: keep the whole form in frame.
  let so = harmonic_attractor_screen(o, eye, fw, sx, sy, th);
  let rr = min(r / (so.z * th), 0.65);
  let mx = max(F.aspect * 0.95 - rr * 1.3, 0.0);
  let my = max(0.95 - rr * 1.15, 0.0);
  o = eye + (fw + (sx * clamp(so.x, -mx, mx) + sy * clamp(so.y, -my, my)) * th) * so.z;
  f.r = clamp(rr * so.z * th, 0.3, 6.0);
  f.o = o;
  f.e3 = normalize(o - eye + vec3f(0.0, 0.0, 1e-4));
  var u2 = up - f.e3 * dot(up, f.e3);
  if (length(u2) < 1e-4) { u2 = vec3f(0.0, 1.0, 0.0) - f.e3 * f.e3.y; }
  f.e2 = normalize(u2);
  f.e1 = cross(f.e3, f.e2);
  return f;
}

/** Colour of chord tone k (0 root, 1 third, 2 fifth). */
fn harmonic_attractor_tone(c: ChordE, k: u32) -> vec3f {
  if (c.root < 0.0 || c.quality < 0.5) { return palL(S.p[3].x + 0.5 + f32(k) * 0.08, 1.0); }
  return palL(S.p[3].x + pitchHue(chordPc(c, k)) * 0.55, 1.0);
}
/** Lobe weights for azimuth phi about the symmetry axis: lobe k is centred at k * 120 degrees. */
fn harmonic_attractor_lobes(phi: f32) -> vec3f {
  let w = vec3f(cos(phi), cos(phi - TAU / 3.0), cos(phi + TAU / 3.0)) * 0.5 + 0.5;
  let p = w * w * w;
  return p / (p.x + p.y + p.z);
}
fn harmonic_attractor_phi(x: vec3f) -> f32 { return atan2(dot(x, HARMONIC_ATTRACTOR_V), dot(x, HARMONIC_ATTRACTOR_U)); }

/** First note index in the window whose start >= t (notes are sorted by start). */
fn harmonic_attractor_first(t: f32) -> u32 {
  var lo = u32(W.n.x);
  var hi = lo + u32(W.n.y);
  loop {
    if (lo >= hi) { break; }
    let m = (lo + hi) / 2u;
    if (notes[m].start < t) { lo = m + 1u; } else { hi = m; }
  }
  return lo;
}

/**
 * How chaotic the flow is from one live particle (0 = settled onto a few loops, 1 = chaotic): two
 * orbits a hair apart are followed for ~19 time units (a finite-time Lyapunov estimate). When the
 * harmony settles the flow onto a few loops every particle shares them, so each filament must be
 * dimmer for the loops to stay crisp.
 */
fn harmonic_attractor_chaos(start: vec3f, b: f32, tw: f32) -> f32 {
  var a = start;
  if (!(dot(a, a) < 400.0 / (b * b)) || dot(a, a) < 1e-4) { a = vec3f(1.0, 0.5, -0.3); }
  var c = a + vec3f(1e-3, 0.0, 0.0);
  let h = 0.12;
  for (var k = 0; k < 160; k++) {
    let ka = harmonic_attractor_f(a, b, tw);
    a += harmonic_attractor_f(a + ka * h * 0.5, b, tw) * h;
    let kc = harmonic_attractor_f(c, b, tw);
    c += harmonic_attractor_f(c + kc * h * 0.5, b, tw) * h;
  }
  let lam = log(max(length(c - a), 1e-9) / 1e-3) / 19.2;
  return smoothstep(0.0, 0.05, lam);
}

fn sim_harmonic_attractor(i: u32, p: ptr<function, Particle>) {
  let now = W.h.z;
  let dt = W.h.w;
  let par = u32(F.frame) & 1u;
  let prevState = pstate_harmonic_attractor[${NP + 4}u + (1u - par)];
  if (i >= ${NP}u) {
    let slot = i - ${NP}u;
    let hm = harmonic_attractor_harmony();
    if (slot >= 8u && slot < ${8 + 2 * NCH}u) {
      // A chaos sample, written to this frame's parity half.
      let k = slot - 8u;
      if (k / ${NCH}u != par) { return; }
      let src = pstate_harmonic_attractor[(pcg(u32(F.frame) * ${NCH}u + k) % ${NP}u)].pos.xyz;
      (*p).pos = vec4f(harmonic_attractor_chaos(src, hm.x, hm.y), 0.0, 0.0, 0.0);
      return;
    }
    if (slot == 4u + par) {
      // Eased state, from last frame's copy: the knot turns to face the root on the circle of
      // fifths (shortest way round), and the measured chaos is smoothed.
      let init = prevState.pos.w > 0.5;
      var psi = prevState.pos.x;
      let goal = select(psi, atan2(hm.w, hm.z), length(hm.zw) > 0.05);
      let d = goal - psi;
      psi = select(goal, psi + (d - TAU * floor((d + PI) / TAU)) * (1.0 - exp(-dt * 1.8)), init);
      var ch = 0.0;
      for (var k = 0u; k < ${NCH}u; k++) { ch += pstate_harmonic_attractor[${8 + NCH}u + ${NP}u - par * ${NCH}u + k].pos.x; }
      ch /= ${NCH}.0;
      let chaos = select(1.0, mix(prevState.pos.y, ch, 1.0 - exp(-dt * 1.2)), init);
      (*p).pos = vec4f(psi, chaos, now, 1.0);
      return;
    }
    if (slot > 3u) { return; }
    // Basis slots: o, the attractor-to-world columns and the tone colours, all from last frame's state.
    let f = harmonic_attractor_frame();
    let psi = prevState.pos.x;
    let mh = harmonic_attractor_height();
    // Seen almost down its axis, so the three lobes of the triad read; a rising melody lifts its face.
    let tl = 0.12 + clamp(mh, -1.0, 1.0) * 0.45;
    let ax = normalize(f.e3 * cos(tl) - f.e2 * sin(tl));
    let p1r = f.e1 * cos(psi) + f.e2 * sin(psi);
    let p1 = normalize(p1r - ax * dot(p1r, ax));
    let p2 = cross(ax, p1);
    // The attractor spans about 4/b^0.35 units: normalise it to the radius; a high melody opens it.
    let sc = f.r * 0.24 * pow(hm.x / 0.2, 0.35);
    let op = 1.0 + 0.3 * clamp(mh, -1.0, 1.0);
    let cx = (p1 * HARMONIC_ATTRACTOR_U.x + p2 * HARMONIC_ATTRACTOR_V.x + ax * HARMONIC_ATTRACTOR_A.x * op) * sc;
    let cy = (p1 * HARMONIC_ATTRACTOR_U.y + p2 * HARMONIC_ATTRACTOR_V.y + ax * HARMONIC_ATTRACTOR_A.y * op) * sc;
    let cz = (p1 * HARMONIC_ATTRACTOR_U.z + p2 * HARMONIC_ATTRACTOR_V.z + ax * HARMONIC_ATTRACTOR_A.z * op) * sc;
    // Tone colour of this slot's lobe, weighted exactly like the harmony.
    var col = vec3f(0.0);
    var wsum = 0.0;
    let c0 = u32(W.n.z);
    for (var j = c0; j < c0 + u32(W.n.w); j++) {
      let c = chords[j];
      let w = harmonic_attractor_w(c);
      if (w <= 0.0) { continue; }
      col += harmonic_attractor_tone(c, min(slot, 2u)) * w;
      wsum += w;
    }
    col += palL(S.p[3].x + 0.5 + f32(min(slot, 2u)) * 0.08, 1.0) * (1.0 - wsum);
    if (slot == 0u) { (*p).pos = vec4f(f.o, hm.x); (*p).vel = vec4f(col, hm.y); }
    else if (slot == 1u) { (*p).pos = vec4f(cx, harmonic_attractor_rate()); (*p).vel = vec4f(col, 0.0); }
    else if (slot == 2u) { (*p).pos = vec4f(cy, 0.0); (*p).vel = vec4f(col, 0.0); }
    else { (*p).pos = vec4f(cz, 0.0); (*p).vel = vec4f(prevState.pos.y, 0.0, 0.0, 0.0); }
    return;
  }

  let hm = harmonic_attractor_harmony();
  let b = hm.x;
  let tw = hm.y;
  var x = (*p).pos.xyz;
  var heat = (*p).pos.w;
  var age = (*p).vel.y;
  var charge = (*p).vel.w;
  // Each particle is reborn now and then (about every 40 s), so the cloud never collapses onto one
  // orbit through a long consonant passage; the newborn fade in while they settle onto the attractor.
  let epoch = floor(now / 40.0 + hashU(i * 13u + 1u));
  let bad = !(dot(x, x) < 400.0 / (b * b));
  if ((*p).vel.x < 0.5 || abs((*p).vel.z - epoch) > 0.5 || bad) {
    let s = pcg(i * 9781u + u32(epoch) * 7919u + 3u);
    x = (hashU3(s) * 2.0 - 1.0) * 3.0;
    heat = 0.0;
    charge = 0.0;
    age = 0.0;
  }
  // Integrate (midpoint), sub-stepped to stay accurate at any frame rate.
  let h = dt * harmonic_attractor_rate();
  let steps = clamp(u32(ceil(h / 0.06)), 1u, 8u);
  let hs = h / f32(steps);
  for (var s = 0u; s < steps; s++) {
    let k1 = harmonic_attractor_f(x, b, tw);
    x += harmonic_attractor_f(x + k1 * hs * 0.5, b, tw) * hs;
  }

  // Attacks light the lobe of the chord tone the melody sings, at the melody's height; the light
  // then rides the orbits. Attacks are found by song time since last frame (any frame rate, no
  // double counting); after a seek, just this frame's span.
  let t0 = select(now - dt, prevState.pos.z, prevState.pos.w > 0.5 && prevState.pos.z <= now && now - prevState.pos.z < 0.25);
  // The melody is the lead, or the bass while the lead has been silent for a few seconds.
  let hi = u32(W.n.x + W.n.y);
  var haveLead = false;
  for (var j = harmonic_attractor_first(now - 3.0); j < hi; j++) {
    let n = notes[j];
    if (n.start > now) { break; }
    if (n.role < 0.5) { haveLead = true; break; }
  }
  let role = select(1.0, 0.0, haveLead);
  // The chord sounding now, for which tone each note is.
  var cur = ChordE(0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  let c0 = u32(W.n.z);
  for (var j = c0; j < c0 + u32(W.n.w); j++) {
    if (chords[j].start <= now && now < chords[j].end) { cur = chords[j]; }
  }
  let phi = harmonic_attractor_phi(x);
  let ax = dot(x, HARMONIC_ATTRACTOR_A) * b;
  for (var j = harmonic_attractor_first(t0); j < hi; j++) {
    let n = notes[j];
    if (n.start > now) { break; }
    if (n.start <= t0 || abs(n.role - role) > 0.5) { continue; }
    // Which chord tone the note is: nearest on the circle of fifths.
    var best = 0u;
    var bd = 99.0;
    for (var k = 0u; k < 3u; k++) {
      let d = fmod((n.pitch - chordPc(cur, k)) * 7.0 + 6.0, 12.0) - 6.0;
      if (abs(d) < bd) { bd = abs(d); best = k; }
    }
    let dp = phi - f32(best) * TAU / 3.0;
    let dphi = dp - TAU * floor((dp + PI) / TAU);
    let hN = clamp((n.pitch - S.p[0].z - 4.0) / 12.0, -1.0, 1.0) * 0.6;
    // A small packet: a narrow slice of that lobe at the melody's height.
    let band = exp(-pow((ax - hN) / 0.09, 2.0) - pow(dphi / 0.32, 2.0));
    charge = max(charge, (0.5 + 0.5 * n.strength) * band * select(1.0, 0.5, cur.root < 0.0));
  }
  // The light swells in over ~40 ms rather than snapping on, then fades with the charge.
  charge *= exp(-dt * 1.6);
  heat = heat + (charge - heat) * (1.0 - exp(-dt * 25.0));
  (*p).pos = vec4f(x, heat);
  (*p).vel = vec4f(1.0, age + dt, epoch, charge);
}

fn vs_harmonic_attractor(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  if (ii >= ${NP}u) { return hidden(); }
  let q = pstate_harmonic_attractor[ii];
  if (q.vel.x < 0.5) { return hidden(); }
  let s0 = pstate_harmonic_attractor[${NP}u];
  let s1 = pstate_harmonic_attractor[${NP + 1}u];
  let s2 = pstate_harmonic_attractor[${NP + 2}u];
  let s3 = pstate_harmonic_attractor[${NP + 3}u];
  let seg = vi / 6u;
  let cc = vi % 6u;
  let fade = smoothstep(1.0, 3.0, q.vel.y);
  let heat = q.pos.w;
  let tailK = 1.0 - (f32(seg) + qu(cc)) / ${SEG}.0;
  // Ordered harmony gathers every particle onto a few loops: thin each one out so the loops stay crisp.
  let dens = mix(0.13, 1.0, s3.vel.x);
  let br = fade * tailK * dens * (0.1 + 1.2 * heat * tailK * sqrt(dens));
  if (fade * dens * (0.08 + 1.2 * heat) < 0.002) { return hidden(); }
  // Walk the orbit backwards from the particle to this segment's two ends.
  let hb = -${TRAIL / SEG};
  var x = q.pos.xyz;
  var xa = x;
  for (var k = 0u; k <= seg; k++) {
    xa = x;
    let k1 = harmonic_attractor_f(x, s0.pos.w, s0.vel.w);
    x += harmonic_attractor_f(x + k1 * hb * 0.5, s0.pos.w, s0.vel.w) * hb;
  }
  let xb = x;
  let pa = s0.pos.xyz + s1.pos.xyz * xa.x + s2.pos.xyz * xa.y + s3.pos.xyz * xa.z;
  let pb = s0.pos.xyz + s1.pos.xyz * xb.x + s2.pos.xyz * xb.y + s3.pos.xyz * xb.z;
  let w = length(camEye() - pa) * 0.0011;
  let wp = stripPoint(pa, pb, qu(cc), qv(cc), w);
  o.pos = toClip(wp);
  o.wp = wp;
  let xm = mix(xa, xb, qu(cc));
  // Seen down its axis every orbit crosses the centre: thin the light there so the core does not burn out.
  let rp = length(xm - HARMONIC_ATTRACTOR_A * dot(xm, HARMONIC_ATTRACTOR_A));
  let core = 0.3 + 0.7 * smoothstep(0.3, 2.2, rp);
  let lw = harmonic_attractor_lobes(harmonic_attractor_phi(xm));
  let col = s0.vel.xyz * lw.x + s1.vel.xyz * lw.y + s2.vel.xyz * lw.z;
  o.a = vec4f(qv(cc) * 2.0 - 1.0, br * core, 0.0, 0.0);
  o.b = vec4f(heat, 0.0, 0.0, 0.0);
  o.c = vec4f(col, 0.0);
  return o;
}
fn fs_harmonic_attractor(in: LOut) -> vec4f {
  let v = in.a.x;
  let k = (1.0 - v * v) * in.a.y;
  let col = mix(in.c.rgb, vec3f(1.0), sat(in.b.x - 0.35) * 0.55);
  return glowOut(col * k * S.p[3].y, in.wp);
}
`,
} satisfies LayerDef;
