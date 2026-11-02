import { defineLook } from '../types';

/** Luminance re-mapped through the palette (a cinematic tritone / false-colour grade). */
export default defineLook({
  meta: { id: 'gradient-map', name: 'Tritone Map', weight: 0.9, energy: [0, 1], amount: [0.45, 0.85] },
  params(ctx, p) {
    p[0] = ctx.dna[0];
    p[1] = 0.6 + ctx.dna[1] * 1.4;
  },
  wgsl: /* wgsl */ `
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let c = src(uv);
  let l = luma(c);
  let x = pow(l / (1.0 + l), 0.8) * L.p[0].y;
  let ramp = palRamp(clamp(x + L.p[0].x * 0.1, 0.0, 1.0));
  // Real darks stay dark: the ramp only lifts what the image already lights.
  return ramp * (0.4 + 1.6 * l) * smoothstep(0.0, 0.1, l) + c * 0.1;
}
`,
});
