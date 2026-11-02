import type { LayerDef } from '../layer';

const HOLD = 10;
const MOVE = 14;
const SEG = HOLD + MOVE;
const SIDES = 8;

/**
 * Voice-leading as braided tubes. Each chord tone is a voice on a chromatic circle around the time
 * axis (one semitone = one twelfth of a turn). At every chord change the three voices take the
 * minimal-motion path to the next chord's tones: common tones run straight on, moving voices curve
 * around the axis by the exact number of semitones they step, so smooth progressions read as gentle
 * twists and leaps as wide swings. The root voice is the thickest; tension thickens the whole braid.
 */
export default {
  id: 'voice-leading',
  role: 'harmony',
  source: 'chords',
  verts: 3 * SEG * SIDES * 6,
  blend: 'opaque',
  weight: 0.7,
  excludes: ['chord-prism'],
  // Needs a time axis to braid around (converge, tonnetz, fountain and rose collapse it).
  layouts: ['road', 'river', 'knot', 'helix', 'staircase', 'spiral'],
  wgsl: /* wgsl */ `
fn voice_leading_ok(c: ChordE) -> bool { return c.root >= 0.0 && c.quality > 0.5; }
/** Signed shortest semitone step from pitch class a to b, in [-6, 6). */
fn voice_leading_step(a: f32, b: f32) -> f32 { return fmod(b - a + 6.0, 12.0) - 6.0; }
/** Steps of voices 0..2 (root, third, fifth of c) under the minimal-motion assignment onto n's tones. */
fn voice_leading_moves(c: ChordE, n: ChordE) -> vec3f {
  var a = array<f32, 3>(chordPc(c, 0u), chordPc(c, 1u), chordPc(c, 2u));
  var b = array<f32, 3>(chordPc(n, 0u), chordPc(n, 1u), chordPc(n, 2u));
  var perms = array<vec3u, 6>(vec3u(0u, 1u, 2u), vec3u(0u, 2u, 1u), vec3u(1u, 0u, 2u), vec3u(1u, 2u, 0u), vec3u(2u, 0u, 1u), vec3u(2u, 1u, 0u));
  var best = vec3f(0.0);
  var bestCost = 1e9;
  for (var i = 0u; i < 6u; i++) {
    let pm = perms[i];
    let m = vec3f(voice_leading_step(a[0], b[pm.x]), voice_leading_step(a[1], b[pm.y]), voice_leading_step(a[2], b[pm.z]));
    let cost = abs(m.x) + abs(m.y) + abs(m.z);
    if (cost < bestCost - 1e-3) { bestCost = cost; best = m; }
  }
  return best;
}
/** Voice centre at song time t: holds pitch class pc, then steps by m semitones across [t1, t1 + 2h]. */
fn voice_leading_at(t: f32, pc: f32, m: f32, t1: f32, h: f32) -> vec3f {
  let s = select(0.0, smoothstep(0.0, 1.0, (t - t1) / max(2.0 * h, 1e-4)), h > 0.0);
  let ang = (pc + m * s) / 12.0 * TAU;
  return emblemPoint(t, ang, S.p[6].x * 0.7, S.p[0].w * 1.3);
}
fn vs_voice_leading(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let c = chords[ii];
  if (!voice_leading_ok(c)) { return hidden(); }
  // The past braid stops short of the chase cameras, which fly at the chord lane's height.
  let tw0 = F.songTime - min(S.p[1].x, 1.2);
  let tw1 = F.songTime + S.p[1].y;
  let dur = c.end - c.start;
  // Neighbouring chords that follow on directly share a transition centred on the change.
  var tIn = c.start;
  var hIn = 0.0;
  if (ii > 0u) {
    let pv = chords[ii - 1u];
    if (voice_leading_ok(pv) && abs(c.start - pv.end) < 0.1) {
      hIn = min(0.3, 0.3 * min(dur, pv.end - pv.start));
      tIn = 0.5 * (c.start + pv.end);
    }
  }
  var tOut = c.end;
  var hOut = 0.0;
  var moves = vec3f(0.0);
  if (ii + 1u < arrayLength(&chords)) {
    let nx = chords[ii + 1u];
    if (voice_leading_ok(nx) && abs(nx.start - c.end) < 0.1) {
      hOut = min(0.3, 0.3 * min(dur, nx.end - nx.start));
      tOut = 0.5 * (c.end + nx.start);
      moves = voice_leading_moves(c, nx);
    }
  }
  let tA = tIn + hIn;
  let tB = tOut - hOut;
  let tC = tOut + hOut;
  if (tC < tw0 || tA > tw1) { return hidden(); }
  let q = vi / 6u;
  let cc = vi % 6u;
  let k = q / ${SEG * SIDES}u;
  let sg = (q / ${SIDES}u) % ${SEG}u;
  let side = q % ${SIDES}u;
  let pc = chordPc(c, k);
  var mv = array<f32, 3>(moves.x, moves.y, moves.z);
  let m = mv[k];
  let fs = f32(sg) + qu(cc);
  var t = select(mix(tB, tC, (fs - ${HOLD}.0) / ${MOVE}.0), mix(tA, tB, fs / ${HOLD}.0), fs <= ${HOLD}.0);
  t = clamp(t, tw0, tw1);
  let p = voice_leading_at(t, pc, m, tB, hOut);
  let tng = normalize(voice_leading_at(t + 0.01, pc, m, tB, hOut) - p + vec3f(0.0, 0.0, 1e-6));
  // Voices with no chord on one side begin or end as rounded caps.
  let cap = sqrt(sat((t - tA + select(1.0, 0.0, hIn == 0.0)) / 0.08)) * sqrt(sat((tC - t + select(1.0, 0.0, hOut == 0.0)) / 0.08));
  let edge = sqrt(sat((t - tw0) / 0.25)) * sqrt(sat((tw1 - t) / 0.5));
  let r = S.p[6].x * 0.05 * select(1.0, 1.4, k == 0u) * (0.8 + 0.6 * c.tension) * max(cap * edge, 0.03);
  let nx = frameX(t, tng);
  let ny = cross(nx, tng);
  let a = (f32(side) + qv(cc)) / ${SIDES}.0 * TAU;
  let dir = nx * cos(a) + ny * sin(a);
  let wp = p + dir * r;
  o.pos = toClip(wp);
  o.wp = wp;
  o.nrm = dir;
  let s = select(0.0, sat((t - tB) / max(2.0 * hOut, 1e-4)), hOut > 0.0);
  o.a = vec4f(t, s, 0.0, 0.0);
  o.b = vec4f(c.start, c.end, c.tension, tOut);
  o.c = vec4f(pc, m, f32(k), 0.0);
  return o;
}
fn fs_voice_leading(in: LOut) -> vec4f {
  let t = in.a.x;
  let s = in.a.y;
  let dt = t - F.songTime;
  let pc = in.c.x;
  let m = in.c.y;
  let ca = palL(S.p[3].x + pitchHue(pc) * 0.55, 1.0);
  let cb = palL(S.p[3].x + pitchHue(pc + m) * 0.55, 1.0);
  let col = mix(ca, cb, smoothstep(0.0, 1.0, s));
  let sounding = step(in.b.x, F.songTime) * step(F.songTime, in.b.y);
  // A moving voice glows along its step; the change flashes as it crosses the playhead.
  let moving = select(0.0, 4.0 * s * (1.0 - s), abs(m) > 0.5) * (0.4 + abs(m) / 6.0);
  let flash = exp(-abs(in.b.w - F.songTime) * 6.0) * select(0.3, 1.0, abs(m) > 0.5);
  let emis = col * (playLight(dt) * (0.35 + 0.6 * sounding + 1.2 * moving) + flash * 1.5) * S.p[3].y * select(0.8, 1.15, in.c.z < 0.5);
  return vec4f(shade(col * 0.7, emis, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
