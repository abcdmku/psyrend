import type { LayerDef } from '../layer';

const SEG = 12;
const HARM = 4;

/**
 * The overtone series made visible: each note also draws faint strands at its 2nd-5th harmonics
 * (octave, twelfth, double octave, major third above), brighter when the sound is bright
 * (spectral centroid). Timbre becomes density.
 */
export default {
  id: 'harmonics',
  role: 'detail',
  source: 'notes',
  verts: HARM * SEG * 6,
  blend: 'additive',
  weight: 0.15,
  layouts: '*',
  wgsl: /* wgsl */ `
fn vs_harmonics(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let n = notes[ii];
  let role = u32(n.role + 0.5);
  if (role == 1u) { return hidden(); }
  let t0 = max(n.start, F.songTime - S.p[1].x);
  let t1 = min(n.end, F.songTime + S.p[1].y);
  if (t1 <= t0) { return hidden(); }
  let q = vi / 6u;
  let cc = vi % 6u;
  let h = q / ${SEG}u;
  let sg = q % ${SEG}u;
  let ratio = f32(h + 2u);
  let pitch = n.pitch + 12.0 * log2(ratio);
  let lane = roleLane(role);
  let a = L(mix(t0, t1, f32(sg) / ${SEG}.0), pitch, lane);
  let b = L(mix(t0, t1, f32(sg + 1u) / ${SEG}.0), pitch, lane);
  let p = mix(a, b, qu(cc));
  let wp = stripPoint(a, b, qu(cc), qv(cc), lineW(p) * 0.45);
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(mix(t0, t1, (f32(sg) + qu(cc)) / ${SEG}.0), 0.0, 0.0, 0.0);
  o.b = vec4f(n.start, n.end, n.pitch, ratio);
  o.c = vec4f(n.strength, 0.0, 0.0, 0.0);
  return o;
}
fn fs_harmonics(in: LOut) -> vec4f {
  let dt = in.a.x - F.songTime;
  let sounding = step(in.b.x, F.songTime) * step(F.songTime, in.b.y);
  let bright = 0.35 + 1.3 * F.centroid;
  let col = palL(S.p[3].x + pitchHue(in.b.z) * 0.55 + 0.05 * in.b.w, 1.0);
  let k = playLight(dt) * (0.5 + 1.5 * sounding) * bright / in.b.w * in.c.x * S.p[3].y * 0.6;
  return glowOut(col * k, in.wp);
}
`,
} satisfies LayerDef;
