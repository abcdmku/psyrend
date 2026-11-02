import { defineLook } from '../types';
import { Groove, LSD_OUT_WGSL, LSD_WGSL } from './lsdCommon';

const groove = new Groove();

/**
 * LSD "drifting / flowing": the fine texture of every surface streams along a slow curl flow like
 * a river in a looped animation, while the large forms stay put. The image is split into a soft
 * base and its detail; only the detail is advected (two-phase flow map, contrast-normalised), so
 * the forms stay legible and nothing ghosts. The base itself melts along a slower, larger flow. Energy sets the flow speed; the highs, the upper
 * melody and hats set how far and how vividly the detail flows.
 * dna0 = flow scale, dna1 = flow reach, dna2 = detail radius, dna3 = detail gain.
 */
export default defineLook({
  meta: {
    id: 'lsd-drift',
    name: 'LSD Drifting',
    weight: 0.75,
    energy: [0, 1],
    amount: [0.85, 1],
    overlay: true,
    genres: { ambient: 0.9, lofi: 0.8, techno: 0.8, edm: 0.7, dubstep: 0.7, jazz: 0.6 },
  },
  params(ctx, p) {
    groove.update(ctx, p);
    const d = ctx.dna;
    p[8] = 1.4 + 1.6 * d[0];
    p[9] = 26 + 14 * d[1];
    p[10] = 4.5 + 3.0 * d[2];
    p[11] = 1.25 + 0.3 * d[3];
  },
  wgsl: /* wgsl */ `
${LSD_WGSL}
${LSD_OUT_WGSL}
/** A smooth low-pass (720p pixels); a true blur, so small bright points never split into copies. */
fn dr_low(uv: vec2f, r: f32) -> vec3f { return srcSoft(uv, r); }
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let p = lsd_p(uv);
  let rs = L.res.y / 720.0;
  let rad = L.p[2].z;
  let base = src(uv);
  // Melting: the soft base also slides along a slower, larger curl flow, so smooth forms drift too.
  let mv = lsd_curl(p * 0.6 + 2.0, lsd_flow() * 0.05, 1.1);
  let melt = mv / (length(mv) + 0.8) * 0.022 * (0.5 + 0.5 * lsd_energy()) * L.amount * lsd_edge(uv);
  let low = dr_low(lsd_uv(p + melt), rad);
  // Flow direction from a slow curl field; normalised so the reach is even across the frame.
  let v = lsd_curl(p, lsd_flow() * 0.08, L.p[2].x);
  let dir = v / (length(v) + 0.6 * L.p[2].x);
  let reach = L.p[2].y * rs * (0.45 + 0.55 * lsd_detail() + 0.25 * lsd_energy()) * L.amount;
  let off = dir * reach / L.res.y / vec2f(L.res.x / L.res.y, 1.0);
  // Two-phase flow map: each layer slides along the flow and fades out before it resets.
  let t = lsd_flow() * 0.35;
  let ph0 = fract(t);
  let ph1 = fract(t + 0.5);
  let w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  let w1 = 1.0 - w0;
  let um = lsd_uv(p + melt);
  let u0 = um - off * (ph0 - 0.5);
  let u1 = um - off * (ph1 - 0.5);
  let d0 = src(u0) - dr_low(u0, rad);
  let d1 = src(u1) - dr_low(u1, rad);
  // Contrast-normalised blend so the detail doesn't fade at the crossover.
  let det = (d0 * w0 + d1 * w1) / sqrt(w0 * w0 + w1 * w1);
  let gain = L.p[2].w * (1.0 + 0.3 * lsd_detail());
  let col = max(low + det * gain, vec3f(0.0));
  return lsd_out(base, col);
}
`,
});
