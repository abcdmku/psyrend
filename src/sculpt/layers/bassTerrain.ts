import type { LayerDef } from '../layer';

const GT = 200;
const GP = 80;

/**
 * The bass line as ground swell. A broad dune follows the bass across pitch, and the bass's own
 * overtone series rises beside it as narrower ridges (octave, twelfth, two octaves, major third
 * above), so every bass note lays down the same harmonic ridge pattern at its own place. The swell
 * grows with how strongly the bass sounds and crests at each bass attack; the bass notes ride on
 * their dune. Ridges take the colour of the partial they stand for, the ground between them the
 * colour of the bass note, and bar lines are cut across as fine grooves.
 */
export default {
  id: 'bass-terrain',
  role: 'world',
  source: 'once',
  verts: GT * GP * 6,
  blend: 'opaque',
  weight: 0,
  excludes: ['landscape', 'pitch-columns'],
  layouts: ['road', 'river'],
  wgsl: /* wgsl */ `
const BASS_TERRAIN_SPAN: f32 = 64.0;
/** Bass at dt: (midi, slow envelope, attack crest). Pitch is exact through silence edges; both envelopes are smoothed. */
fn bass_terrain_bass(dt: f32) -> vec3f {
  var sp = 0.0;
  var ss = 0.0;
  for (var k = -3; k <= 3; k++) {
    let w = 4.0 - f32(abs(k));
    let c = scoreEvents(dt + f32(k) * 0.08, 3.0);
    sp += c.z * w;
    ss += c.w * w;
  }
  let pitch = select(S.p[0].z - 12.0, 28.0 + 72.0 * sp / max(ss, 1e-4), ss > 1e-3);
  let crest = score(dt - 0.03, pitch).a * 0.5 + score(dt - 0.08, pitch).a * 0.3 + score(dt + 0.02, pitch).a * 0.2;
  return vec3f(pitch, ss / 16.0, crest);
}
/** Relief across pitch around bass pitch bp: x = fundamental dune, y = overtone ridges, z = the ridge's partial (semitones above the bass). */
fn bass_terrain_relief(bp: f32, pitch: f32) -> vec3f {
  let d = pitch - bp;
  let x = d / 7.0;
  var ridges = 0.0;
  var best = 0.0;
  var which = 0.0;
  var iv = array<f32, 4>(12.0, 19.02, 24.0, 27.86);
  for (var n = 0; n < 4; n++) {
    let y = (d - iv[n]) / 1.6;
    let r = exp(-y * y) / (f32(n) + 2.0) * 1.6;
    ridges += r;
    if (r > best) { best = r; which = iv[n]; }
  }
  return vec3f(exp(-x * x), ridges, which);
}
fn bass_terrain_h(b: vec3f, pitch: f32, fp: f32) -> f32 {
  let r = bass_terrain_relief(b.x, pitch);
  let e = 0.75 * b.y + 0.55 * b.z;
  // The terrain's edges roll down so it reads as one sculpted mound, not a cut slab.
  let edge = pow(abs(fp * 2.0 - 1.0), 6.0);
  return S.p[0].w * (e * (r.x + r.y) * 0.75 - edge * 0.9);
}
fn bass_terrain_pos(t: f32, pitch: f32, b: vec3f) -> vec3f {
  let fp = (pitch - S.p[0].z + 34.0) / BASS_TERRAIN_SPAN;
  return L(t, pitch, -2.3) + LUp(t) * bass_terrain_h(b, pitch, fp);
}
fn vs_bass_terrain(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = vi / 6u;
  let cc = vi % 6u;
  let it = q % ${GT}u;
  let ip = q / ${GT}u;
  let ft = (f32(it) + qu(cc)) / ${GT}.0;
  let fp = (f32(ip) + qv(cc)) / ${GP}.0;
  let t = F.songTime - worldPast() + ft * (worldPast() + S.p[1].y);
  let pitch = S.p[0].z - 34.0 + fp * BASS_TERRAIN_SPAN;
  let b = bass_terrain_bass(t - F.songTime);
  let b2 = bass_terrain_bass(t + 0.04 - F.songTime);
  let p = bass_terrain_pos(t, pitch, b);
  var n = normalize(cross(bass_terrain_pos(t, pitch + 0.3, b) - p, bass_terrain_pos(t + 0.04, pitch, b2) - p));
  if (dot(n, LUp(t)) < 0.0) { n = -n; }
  o.pos = toClip(p);
  o.wp = p;
  o.nrm = n;
  o.a = vec4f(t - F.songTime, pitch, b.x, b.z);
  return o;
}
fn fs_bass_terrain(in: LOut) -> vec4f {
  let dt = in.a.x;
  let bp = in.a.z;
  let crest = in.a.w;
  let r = bass_terrain_relief(bp, in.a.y);
  let gr = gridAt(dt);
  // Bar lines as fine grooves: the bar pulse is a sharp step at each downbeat.
  let fw = max(fwidth(gr.y), 1e-3);
  let bar = smoothstep(0.82 - fw, 0.82 + fw, gr.y);
  let hue = S.p[3].x + pitchHue(bp) * 0.55 + 0.5;
  let partial = S.p[3].x + pitchHue(bp + floor(r.z + 0.5)) * 0.55 + 0.5;
  let rw = sat(r.y * 1.6);
  let base = mix(palL(hue, 0.2 + 0.1 * r.x), palL(partial, 0.3), rw);
  let lit = playLight(dt);
  let glow = mix(palL(hue, 1.0), palL(partial, 1.0), rw);
  let shape = r.x + r.y;
  let emis = (glow * (crest * shape * (1.0 + 2.5 * exp(-abs(dt) * 4.0)) + bar * 0.3 * (0.3 + shape)) * (0.25 + lit) + base * 0.15 * lit) * S.p[3].y;
  return vec4f(shade(base, emis, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
