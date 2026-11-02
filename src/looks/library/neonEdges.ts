import { defineLook } from '../types';

/** Sobel contours re-lit as glowing neon tubes in the palette, over a darkened image. */
export default defineLook({
  meta: { id: 'neon-edges', name: 'Neon Contours', weight: 0.7, energy: [0.3, 1], amount: [0.55, 0.9], genres: { synthwave: 1, techno: 0.8, edm: 0.8 } },
  params(ctx, p) {
    p[0] = 0.6 + 1.6 * ctx.dna[0];
    p[1] = ctx.dna[1];
  },
  wgsl: /* wgsl */ `
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let t = 1.0 / L.res * L.p[0].x;
  let l00 = luma(src(uv + vec2f(-t.x, -t.y))); let l10 = luma(src(uv + vec2f(0.0, -t.y))); let l20 = luma(src(uv + vec2f(t.x, -t.y)));
  let l01 = luma(src(uv + vec2f(-t.x, 0.0))); let l21 = luma(src(uv + vec2f(t.x, 0.0)));
  let l02 = luma(src(uv + vec2f(-t.x, t.y))); let l12 = luma(src(uv + vec2f(0.0, t.y))); let l22 = luma(src(uv + vec2f(t.x, t.y)));
  let gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
  let gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
  let g = sqrt(gx * gx + gy * gy);
  let edge = smoothstep(0.02, 0.25, g / (0.15 + luma(src(uv))));
  let hue = fract(atan2(gy, gx) / 6.2831 + L.p[0].y + L.time * 0.03);
  let neon = palAt(hue) * edge * (0.9 + 1.6 * L.kick + 0.8 * L.high);
  return src(uv) * 0.08 + neon;
}
`,
});
