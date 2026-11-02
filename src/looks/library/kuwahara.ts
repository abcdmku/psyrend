import { defineLook } from '../types';

/**
 * Painterly oil: a 4-sector anisotropic Kuwahara-lite whose sectors are stretched along the
 * local brush direction (perpendicular to the luminance gradient), plus bristle streaks.
 * dna0 = brush radius, dna1 = sharpness, dna2 = saturation boost, dna3 = impasto / canvas and flow swirl.
 */
export default defineLook({
  meta: { id: 'kuwahara', name: 'Oil Paint', weight: 0.75, energy: [0, 0.85], amount: [0.6, 0.95], genres: { ambient: 0.9, classical: 0.9, pop: 0.6 } },
  params(ctx, p) {
    const m = ctx.music;
    const d = ctx.dna;
    p[0] = (4 + 9 * d[0]) * (1 + 0.35 * m.kick + 0.6 * m.anticipation) * (1 + 0.5 * m.dropPulse);
    p[1] = 1.5 + 6 * d[1];
    p[2] = 1 + 0.5 * d[2] + 0.25 * m.energy + 0.4 * m.dropPulse;
    p[3] = d[3];
    p[4] = d[3] * 6.283;
    p[5] = ctx.time;
  },
  wgsl: /* wgsl */ `
fn kw_sector(uv: vec2f, c0: vec3f, e1: vec2f, e2: vec2f, sx: f32, sy: f32, q: f32) -> vec4f {
  let a = src(uv + (e1 * 0.55 * sx + e2 * 0.55 * sy));
  let b = src(uv + (e1 * 1.0 * sx + e2 * 0.2 * sy));
  let c = src(uv + (e1 * 0.2 * sx + e2 * 1.0 * sy));
  let la = luma(a); let lb = luma(b); let lc = luma(c); let l0 = luma(c0);
  let m = (a + b + c + c0) * 0.25;
  let ml = (la + lb + lc + l0) * 0.25;
  let v = (la * la + lb * lb + lc * lc + l0 * l0) * 0.25 - ml * ml;
  // Relative variance so HDR highlights don't dominate.
  let w = pow(1.0 / (1e-3 + 40.0 * max(v, 0.0) / (ml * ml + 0.02)), q);
  return vec4f(m * w, w);
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let rs = L.res.y / 720.0;
  let px = 1.0 / L.res;
  let r = L.p[0].x * rs;
  let c0 = src(uv);
  let gx = luma(src(uv + vec2f(r * 0.6 * px.x, 0.0))) - luma(c0);
  let gy = luma(src(uv + vec2f(0.0, r * 0.6 * px.y))) - luma(c0);
  let g = vec2f(gx, gy) / (luma(c0) + 0.15);
  // Flat areas follow a slow swirling flow field; edges brush along the contour.
  let fa = L.p[1].x + 3.0 * vnoise(frag * 0.004 / rs + vec2f(L.p[1].y * 0.05, 0.0)) * (0.5 + L.p[0].w);
  let flow = vec2f(cos(fa), sin(fa));
  let gl = length(g);
  let tang = select(flow, vec2f(-g.y, g.x) / max(gl, 1e-5), gl > 1e-4);
  let dir = normalize(mix(flow, tang, smoothstep(0.02, 0.15, gl)) + 1e-4);
  let stretch = 1.5 + 0.8 * L.p[0].w;
  let e1 = dir * r * stretch * px;
  let e2 = vec2f(-dir.y, dir.x) * r / stretch * px;
  let q = L.p[0].y;
  let s0 = kw_sector(uv, c0, e1, e2, 1.0, 1.0, q);
  let s1 = kw_sector(uv, c0, e1, e2, -1.0, 1.0, q);
  let s2 = kw_sector(uv, c0, e1, e2, 1.0, -1.0, q);
  let s3 = kw_sector(uv, c0, e1, e2, -1.0, -1.0, q);
  let acc = s0 + s1 + s2 + s3;
  var col = acc.rgb / max(acc.a, 1e-8);
  let l = luma(col);
  col = max(mix(vec3f(l), col, L.p[0].z), vec3f(0.0));
  // Bristle streaks along the stroke and a faint canvas weave.
  let u = vec2f(dot(frag, dir), dot(frag, vec2f(-dir.y, dir.x))) / rs;
  let bristle = vnoise(vec2f(u.x * 0.05, u.y * 0.7));
  let weave = 0.5 + 0.25 * (sin(frag.x * 1.7 / rs) + sin(frag.y * 1.7 / rs));
  let imp = 0.14 + 0.3 * L.p[0].w;
  col *= 1.0 + imp * (bristle - 0.5) + 0.05 * L.p[0].w * (weave - 0.5);
  return col;
}
`,
});
