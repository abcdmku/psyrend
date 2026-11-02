import type { LayerDef } from '../layer';

const TRIS = 27; // 3^3, the deepest recursion

/**
 * Each chord as a Sierpinski emblem built on its tone triangle (circle-of-fifths angles), recursed
 * deeper the more harmonic tension it carries. The sounding chord hovers at the playhead; the next
 * chords wait ahead at the moment they will change.
 */
export default {
  id: 'chord-fractal',
  role: 'fractal',
  source: 'chords',
  verts: TRIS * 3 * 6,
  blend: 'additive',
  weight: 0.7,
  excludes: ['chord-prism'],
  // A flat emblem: in travel layouts it would hang face-on in the camera's path.
  layouts: ['spiral', 'converge', 'knot', 'rose', 'tonnetz', 'fountain'],
  wgsl: /* wgsl */ `
fn vs_chord_fractal(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let c = chords[ii];
  if (c.root < 0.0 || c.quality < 0.5) { return hidden(); }
  if (c.end < F.songTime - 0.3 || c.start > F.songTime + S.p[1].y * 0.6) { return hidden(); }
  let e = vi / 6u;
  let cc = vi % 6u;
  let tri = e / 3u;
  let side = e % 3u;
  // Depth follows tension: resolved chords stay simple, tense ones fracture.
  let depth = 1u + u32(min(2.0, floor(c.tension * 3.0)));
  var count = 1u;
  for (var d = 0u; d < depth; d++) { count *= 3u; }
  if (tri >= count) { return hidden(); }
  let t = clamp(F.songTime, c.start, c.end);
  let progress = (t - c.start) / max(c.end - c.start, 1e-3);
  let spin = progress * 0.6 + f32(ii) * 0.5;
  let R = S.p[6].x * 1.3;
  let lift = S.p[0].w * 1.5;
  var A = emblemPoint(t, fifthsAng(chordPc(c, 0u)) + spin, R, lift);
  var B = emblemPoint(t, fifthsAng(chordPc(c, 1u)) + spin, R, lift);
  var C = emblemPoint(t, fifthsAng(chordPc(c, 2u)) + spin, R, lift);
  var k = tri;
  for (var d = 0u; d < depth; d++) {
    let m = k % 3u;
    k = k / 3u;
    let ab = (A + B) * 0.5;
    let bc = (B + C) * 0.5;
    let ac = (A + C) * 0.5;
    if (m == 0u) { B = ab; C = ac; } else if (m == 1u) { A = ab; C = bc; } else { A = ac; B = bc; }
  }
  var P = array<vec3f, 3>(A, B, C);
  let a = P[side];
  let b = P[(side + 1u) % 3u];
  let p = mix(a, b, qu(cc));
  let wp = stripPoint(a, b, qu(cc), qv(cc), lineW(p) * 0.8);
  o.pos = toClip(wp);
  o.wp = wp;
  o.b = vec4f(c.start, c.end, c.root, c.tension);
  return o;
}
fn fs_chord_fractal(in: LOut) -> vec4f {
  let isOn = step(in.b.x, F.songTime) * step(F.songTime, in.b.y);
  let change = step(in.b.x, F.songTime) * exp(-(F.songTime - in.b.x) * 2.5);
  let col = palL(S.p[3].x + pitchHue(in.b.z) * 0.55 + 0.1, 1.0);
  let k = (0.15 + 0.9 * isOn + 2.5 * change) * (0.6 + in.b.w);
  return glowOut(col * k, in.wp);
}
`,
} satisfies LayerDef;
