import type { LayerDef } from '../layer';

/**
 * Drum hits as rings around the time axis at their exact moments: kicks solid, snares dashed,
 * hats dotted. Ahead of the playhead they wait faintly; once played they expand into ripples.
 */
export default {
  id: 'hit-rings',
  role: 'rhythm',
  source: 'hits',
  verts: 48 * 6,
  blend: 'additive',
  weight: 0.8,
  layouts: '*',
  wgsl: /* wgsl */ `
fn vs_hit_rings(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let h = hits[ii];
  let kind = u32(h.kind + 0.5);
  let age = F.songTime - h.time;
  if (age > 2.5 || age < -S.p[1].y) { return hidden(); }
  let q = vi / 6u;
  let cc = vi % 6u;
  let sizeK = select(select(0.3, 0.7, kind == 1u), 1.0, kind == 0u);
  let R = S.p[6].x * sizeK * (0.6 + 0.5 * h.strength) + max(age, 0.0) * S.p[6].z * sizeK;
  let w = S.p[6].y * sizeK * (0.5 + h.strength);
  let a = (f32(q) + qu(cc)) / 48.0 * TAU;
  let wp = emblemPoint(h.time, a, R + (qv(cc) * 2.0 - 1.0) * w, 0.0);
  o.pos = toClip(wp);
  o.wp = wp;
  o.b = vec4f(h.time, h.kind, h.strength, age);
  o.c = vec4f(f32(q), 0.0, 0.0, 0.0);
  return o;
}
fn fs_hit_rings(in: LOut) -> vec4f {
  let kind = u32(in.b.y + 0.5);
  // Snares dashed, hats dotted: rhythm reads by pattern, not just size.
  if (kind == 1u && fract(in.c.x * 0.25) > 0.5) { discard; }
  if (kind == 2u && fract(in.c.x * 0.5) > 0.25) { discard; }
  let age = in.b.w;
  let k = select(0.25 * exp(age * 0.6), 2.5 * exp(-age * 2.2), age >= 0.0) * (0.4 + in.b.z);
  let col = palL(S.p[3].x + select(select(0.85, 0.7, kind == 1u), 0.5, kind == 0u), 1.0);
  return glowOut(col * k, in.wp);
}
`,
} satisfies LayerDef;
