import type { LayerDef } from '../layer';

/**
 * Each chord as a prism: its tones placed at their circle-of-fifths angles form a polygon at the
 * moment the chord changes (major and minor make different triangles), and each tone continues as
 * a guide line through the chord's duration.
 */
export default {
  id: 'chord-prism',
  role: 'harmony',
  source: 'chords',
  verts: (3 + 3 * 8) * 6,
  blend: 'additive',
  weight: 0.8,
  excludes: ['chord-fractal'],
  layouts: '*',
  wgsl: /* wgsl */ `
fn vs_chord_prism(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let c = chords[ii];
  if (c.root < 0.0 || c.quality < 0.5) { return hidden(); }
  let q = vi / 6u;
  let cc = vi % 6u;
  let R = S.p[6].x * 0.9;
  let lift = S.p[0].w * 1.3;
  var a: vec3f;
  var b: vec3f;
  var edge = 0.0;
  if (q < 3u) {
    if (c.start < F.songTime - S.p[1].x - 1.0 || c.start > F.songTime + S.p[1].y) { return hidden(); }
    a = emblemPoint(c.start, fifthsAng(chordPc(c, q)), R, lift);
    b = emblemPoint(c.start, fifthsAng(chordPc(c, q + 1u)), R, lift);
    edge = 1.0;
  } else {
    let k = (q - 3u) / 8u;
    let sg = (q - 3u) % 8u;
    let t0 = max(c.start, F.songTime - S.p[1].x);
    let t1 = min(c.end, F.songTime + S.p[1].y);
    if (t1 <= t0) { return hidden(); }
    let ang = fifthsAng(chordPc(c, k));
    a = emblemPoint(mix(t0, t1, f32(sg) / 8.0), ang, R, lift);
    b = emblemPoint(mix(t0, t1, f32(sg + 1u) / 8.0), ang, R, lift);
  }
  let p = mix(a, b, qu(cc));
  let wp = stripPoint(a, b, qu(cc), qv(cc), lineW(p) * select(0.6, 1.1, edge > 0.5));
  o.pos = toClip(wp);
  o.wp = wp;
  o.b = vec4f(c.start, c.end, c.root, c.tension);
  o.c = vec4f(edge, 0.0, 0.0, 0.0);
  return o;
}
fn fs_chord_prism(in: LOut) -> vec4f {
  let dt = in.b.x - F.songTime;
  let isOn = step(in.b.x, F.songTime) * step(F.songTime, in.b.y);
  let change = step(in.b.x, F.songTime) * exp(-(F.songTime - in.b.x) * 3.0);
  let col = palL(S.p[3].x + pitchHue(in.b.z) * 0.55 + 0.15, 1.0);
  let k = select(0.12 + 0.35 * isOn, 0.6 + 3.0 * change, in.c.x > 0.5) * (0.6 + in.b.w) * select(0.4, 1.0, dt < 4.0);
  return glowOut(col * k, in.wp);
}
`,
} satisfies LayerDef;
