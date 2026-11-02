import type { LayerDef } from '../layer';

const NB = 48;
const NP = 40;

/**
 * The piano roll as architecture: one column per semitone per beat, standing where that pitch
 * sounds during that beat, as tall as its harmonic salience. Chords become rows of towers in their
 * tones' colours, sustained harmony becomes avenues, and a column whose pitch is struck during its
 * beat carries a lit roof. Lead and bass cells are capped in their voice's light.
 */
export default {
  id: 'pitch-columns',
  role: 'world',
  source: 'once',
  verts: NB * NP * 5 * 6,
  blend: 'opaque',
  weight: 0,
  excludes: ['landscape', 'bass-terrain'],
  layouts: ['road', 'river'],
  wgsl: /* wgsl */ `
fn pitch_columns_base(t: f32, pitch: f32, h: f32) -> vec3f { return L(t, pitch, -1.7) + LUp(t) * h; }
fn vs_pitch_columns(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let cell = vi / 30u;
  let face = (vi % 30u) / 6u;
  let cc = vi % 6u;
  let ib = cell % ${NB}u;
  let ip = cell / ${NB}u;
  let bl = 60.0 / clamp(F.bpm, 50.0, 200.0);
  // Cells sit on the beat grid in absolute song time, so they scroll with the music.
  let tRef = F.songTime - F.beatPhase * bl;
  let tb = tRef + (floor(-S.p[1].x / bl) - 1.0 + f32(ib)) * bl;
  if (tb > F.songTime + S.p[1].y || tb + bl < F.songTime - S.p[1].x) { return hidden(); }
  let pitch = floor(S.p[0].z + 0.5) - ${NP / 2}.0 + f32(ip);
  var sal = 0.0;
  var att = 0.0;
  var lead = 0.0;
  var bass = 0.0;
  for (var j = 0; j < 4; j++) {
    let s = score(tb + (f32(j) + 0.5) * 0.25 * bl - F.songTime, pitch);
    sal += s.r * 0.25;
    att = max(att, s.a);
    lead = max(lead, s.g);
    bass = max(bass, s.b);
  }
  sal = max(sal, max(lead, bass) * 0.6);
  if (sal < 0.14) { return hidden(); }
  let t0 = tb + 0.06 * bl;
  let t1 = tb + 0.62 * bl;
  let p0 = pitch - 0.4;
  let p1 = pitch + 0.4;
  let h = S.p[3].w * 2.8 * min(sal, 1.2);
  let u = qu(cc);
  let v = qv(cc);
  var wp: vec3f;
  var n: vec3f;
  let T = normalize(pitch_columns_base(t1, pitch, 0.0) - pitch_columns_base(t0, pitch, 0.0));
  let P = normalize(pitch_columns_base(tb, p1, 0.0) - pitch_columns_base(tb, p0, 0.0));
  if (face == 0u) {
    wp = pitch_columns_base(mix(t0, t1, u), mix(p0, p1, v), h);
    n = LUp(tb);
  } else if (face < 3u) {
    let tt = select(t1, t0, face == 1u);
    wp = pitch_columns_base(tt, mix(p0, p1, u), v * h);
    n = select(T, -T, face == 1u);
  } else {
    let pp = select(p1, p0, face == 3u);
    wp = pitch_columns_base(mix(t0, t1, u), pp, v * h);
    n = select(P, -P, face == 3u);
  }
  o.pos = toClip(wp);
  o.wp = wp;
  o.nrm = n;
  o.a = vec4f(u, v, select(v, 1.0, face == 0u), 0.0);
  o.b = vec4f(tb, pitch, sal, att);
  o.c = vec4f(lead, bass, f32(face), bl);
  return o;
}
fn fs_pitch_columns(in: LOut) -> vec4f {
  let dt = in.b.x - F.songTime;
  let pitch = in.b.y;
  let sal = in.b.z;
  let att = in.b.w;
  let top = in.c.z < 0.5;
  let col = palL(S.p[3].x + pitchHue(pitch) * 0.55, 0.32);
  let glow = palL(S.p[3].x + pitchHue(pitch) * 0.55, 1.0);
  let sounding = step(in.b.x, F.songTime) * step(F.songTime, in.b.x + in.c.w);
  let lit = playLight(dt);
  // Roof: outlined cell; a struck pitch lights it, lead and bass cap it in their voice's light.
  let uv = in.a.xy;
  let fw = max(fwidth(uv), vec2f(1e-4));
  let e = min(min(uv.x, 1.0 - uv.x) / fw.x, min(uv.y, 1.0 - uv.y) / fw.y);
  let rim = 1.0 - smoothstep(0.8, 1.8, e);
  var emis = vec3f(0.0);
  if (top) {
    let voice = palL(S.p[3].x + select(0.6, 0.0, in.c.x >= in.c.y) + pitchHue(pitch) * 0.55, 1.2) * max(in.c.x, in.c.y);
    emis = glow * (rim * 0.5 + att * 1.6 + sal * 0.2) * (lit + 0.15) + voice * lit * 0.8 + glow * sounding * 1.2;
  } else {
    // Sides brighten toward the roof with the column's salience.
    emis = glow * in.a.z * in.a.z * sal * (0.25 * lit + 0.9 * sounding);
  }
  return vec4f(shade(col, emis * S.p[3].y, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
