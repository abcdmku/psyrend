import type { LayerDef } from '../layer';

const N = 40960;

/**
 * The sounding chord as a living swarm at the playhead. Three clusters orbit the chord's tones at
 * their circle-of-fifths angles in the harmony plane, and a stream of runners laps the chord's
 * polygon once a bar, drawing its shape (major and minor make different triangles). When the
 * chord changes, the voice-leading is visible: dust on a common tone stays put, dust on a tone
 * that leaves flies to the tones that arrive. Harmonic tension widens and quickens the orbits;
 * the beat makes the clusters breathe. Without a chord the swarm collapses and fades.
 */
export default {
  id: 'chord-swarm',
  role: 'particles',
  source: 'particles',
  particles: N,
  verts: 6,
  blend: 'additive',
  weight: 0.6,
  layouts: '*',
  wgsl: /* wgsl */ `
struct ChordSwarmFrame { ctr: vec3f, ex: vec3f, ey: vec3f, ax: vec3f };
/** The harmony plane at the playhead (same plane the chord emblems use). */
fn chord_swarm_frame(t: f32) -> ChordSwarmFrame {
  var f: ChordSwarmFrame;
  f.ctr = LCenter(t) + LUp(t) * S.p[0].w * 1.3;
  var ax = LCenter(t + 0.05) - LCenter(t);
  if (length(ax) < 1e-4) { ax = camEye() - f.ctr; }
  f.ax = normalize(ax);
  f.ex = frameX(t, f.ax);
  f.ey = cross(f.ax, f.ex);
  return f;
}
fn chord_swarm_has(c: ChordE, pc: f32) -> bool {
  return abs(chordPc(c, 0u) - pc) < 0.5 || abs(chordPc(c, 1u) - pc) < 0.5 || abs(chordPc(c, 2u) - pc) < 0.5;
}
fn chord_swarm_tone(c: ChordE, k: u32, R: f32) -> vec3f {
  let a = fifthsAng(chordPc(c, k));
  return vec3f(cos(a), sin(a), 0.0) * R;
}
fn sim_chord_swarm(i: u32, p: ptr<function, Particle>) {
  let now = W.h.z;
  let dt = W.h.w;
  // The chord sounding now (and the one before it, for voice-leading).
  var ci = -1;
  let c0 = i32(W.n.z);
  for (var k = c0; k < c0 + i32(W.n.w); k++) {
    let c = chords[k];
    if (c.start <= now && now < c.end && c.root >= 0.0 && c.quality > 0.5) { ci = k; }
  }
  var x = (*p).pos.xyz;
  var v = (*p).vel.xyz;
  var pc = (*p).vel.w;
  var pres = (*p).pos.w;
  let R = S.p[6].x * 1.4;
  let h0 = hashU(i * 3u + 11u);
  let h1 = hashU(i * 3u + 12u);
  let h2 = hashU(i * 3u + 13u);
  let runner = (i % 4u) == 0u;
  var goal = vec3f(0.0);
  if (ci >= 0) {
    let c = chords[ci];
    let tension = sat(c.tension);
    if (!chord_swarm_has(c, pc)) {
      // Leave a tone that is no longer sounding for a tone that just arrived.
      var fresh = array<f32, 3>(chordPc(c, 0u), chordPc(c, 1u), chordPc(c, 2u));
      var nf = 0u;
      var pick = array<f32, 3>(0.0, 0.0, 0.0);
      let hasPrev = ci > 0 && chords[ci - 1].root >= 0.0 && chords[ci - 1].end > c.start - 0.1;
      for (var k = 0u; k < 3u; k++) {
        if (!hasPrev || !chord_swarm_has(chords[ci - 1], fresh[k])) { pick[nf] = fresh[k]; nf += 1u; }
      }
      if (nf == 0u) { pick = fresh; nf = 3u; }
      pc = pick[pcg(i * 7u + u32(ci) * 131u) % nf];
    }
    var kk = 0u;
    for (var k = 0u; k < 3u; k++) { if (abs(chordPc(c, k) - pc) < 0.5) { kk = k; } }
    let beat = gridAt(0.0).x;
    let bps = max(F.bpm, 40.0) / 60.0;
    if (runner) {
      // Runners lap the chord polygon once a bar, evenly spaced, drawing its shape.
      let s = fract(h0 + now * bps * 0.25) * 3.0;
      let e = u32(floor(s));
      let a = chord_swarm_tone(c, e, R);
      let b = chord_swarm_tone(c, e + 1u, R);
      goal = mix(a, b, fract(s)) + (vec3f(h1, h2, hashU(i + 5u)) - 0.5) * R * (0.01 + 0.03 * tension);
    } else {
      // Orbiters ride three tilted rings around their tone, like shells of an atom. Tension widens
      // the rings, quickens them and bends them into a three-lobed wobble; the beat makes them breathe.
      let shell = (i / 4u) % 3u;
      let fs = f32(shell);
      let rho0 = R * (0.07 + 0.065 * fs) * (1.0 + 1.2 * tension) * (1.0 + 0.3 * beat);
      let tilt = fs * 2.1 + pc * 0.7 + now * bps * 0.05 * (1.0 + 2.0 * tension);
      let nrm = normalize(vec3f(cos(tilt) * 0.8, sin(tilt) * 0.8, 1.0 - 0.3 * fs));
      let e1 = normalize(cross(nrm, vec3f(0.3, 1.0, 0.0)));
      let e2 = cross(nrm, e1);
      let om = TAU * bps * (0.25 + 0.6 * tension) / (1.0 + 0.5 * fs) * select(1.0, -1.0, shell == 1u);
      let th = h0 * TAU + now * om;
      let rho = rho0 * (1.0 + 0.35 * tension * sin(3.0 * th + fs)) + R * 0.012 * (h1 - 0.5);
      goal = chord_swarm_tone(c, kk, R) + (e1 * cos(th) + e2 * sin(th)) * rho;
    }
    pres = min(pres + dt * 3.0, 1.0);
    if (runner) { pc = c.root; }
  } else {
    goal = x * 0.6;
    pres = max(pres - dt * 1.5, 0.0);
  }
  // Each particle steers toward its goal with its own stiffness, so changes stream in ribbons.
  let K = 5.0 + 9.0 * h1;
  v += (goal - x) * K * K * dt;
  v *= exp(-1.3 * K * dt);
  x += v * dt;
  (*p).pos = vec4f(x, pres);
  (*p).vel = vec4f(v, pc);
}
fn vs_chord_swarm(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = pstate_chord_swarm[ii];
  if (q.pos.w <= 0.01) { return hidden(); }
  let f = chord_swarm_frame(W.h.z);
  let c = f.ctr + f.ex * q.pos.x + f.ey * q.pos.y + f.ax * q.pos.z;
  let vw = (f.ex * q.vel.x + f.ey * q.vel.y + f.ax * q.vel.z) * 0.035;
  let fwd = normalize(c - camEye());
  let w = max(S.p[7].y, 0.004) * 0.6;
  let d = vw - fwd * dot(vw, fwd);
  let hl = length(d) * 0.5;
  let ax = select(normalize(cross(fwd, camUp())), d / max(2.0 * hl, 1e-6), hl > 1e-5);
  let side = normalize(cross(fwd, ax));
  let u = qu(vi) * 2.0 - 1.0;
  let v = qv(vi) * 2.0 - 1.0;
  let wp = c + ax * u * (hl + w) + side * v * w;
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(u * (hl + w) / w, v, 0.0, 0.0);
  let speed = length(q.vel.xyz) / max(S.p[6].x, 0.3);
  o.b = vec4f(hl / w, q.vel.w, q.pos.w, sat(speed * 0.4));
  o.c = vec4f(select(0.0, 1.0, ii % 4u == 0u), 0.0, 0.0, 0.0);
  return o;
}
fn fs_chord_swarm(in: LOut) -> vec4f {
  let dx = max(abs(in.a.x) - in.b.x, 0.0);
  let d = dx * dx + in.a.y * in.a.y;
  if (d > 1.0) { discard; }
  let k = exp(-d * 4.0) * in.b.z / (1.0 + in.b.x * 0.3) * (0.6 + 0.8 * in.b.w);
  // Tones keep their circle-of-fifths colour; the polygon runners carry the root's.
  let col = palL(S.p[3].x + pitchHue(in.b.y) * 0.55, select(1.0, 0.7, in.c.x > 0.5));
  return glowOut(col * k * S.p[3].y * 0.12, in.wp);
}
`,
} satisfies LayerDef;
