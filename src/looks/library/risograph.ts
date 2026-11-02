import { defineLook } from '../types';

/**
 * Risograph print: the image separated into 2-3 spot inks (least-squares in optical density),
 * posterised with grain dither, each drum misregistered.
 * dna0 = ink count, dna1 = misregistration, dna2 = paper (cream, cool, tinted, black), dna3 = ink set.
 */
export default defineLook({
  meta: { id: 'risograph', name: 'Risograph', weight: 0.6, energy: [0.1, 0.9], amount: [0.6, 0.95], genres: { hiphop: 0.8, lofi: 0.9, acoustic: 0.6 } },
  params(ctx, p) {
    const m = ctx.music;
    p[0] = ctx.dna[0] < 0.4 ? 2 : 3;
    p[1] = (3 + 8 * ctx.dna[1]) * (1 + 0.9 * m.kick + 1.5 * m.dropPulse);
    p[2] = Math.floor(ctx.dna[2] * 4);
    p[3] = Math.floor(ctx.dna[3] * 4);
    // Grain is a static print texture that re-seeds on snares and every few bars.
    p[4] = Math.floor(m.snare * 3) * 13 + Math.floor(m.barIndex / 2) * 7;
    p[5] = 1 + 1.5 * m.anticipation;
    p[6] = ctx.dna[1] * 6.283 + 0.4 * m.snare;
  },
  wgsl: /* wgsl */ `
fn rg_solve(t: vec3f, a0: vec3f, a1: vec3f, a2: vec3f) -> vec3f {
  // Regularised least squares: (M^T M + lambda I) d = M^T t, columns a0..a2.
  let lam = 0.05;
  let c0 = vec3f(dot(a0, a0) + lam, dot(a1, a0), dot(a2, a0));
  let c1 = vec3f(dot(a0, a1), dot(a1, a1) + lam, dot(a2, a1));
  let c2 = vec3f(dot(a0, a2), dot(a1, a2), dot(a2, a2) + lam);
  let b = vec3f(dot(a0, t), dot(a1, t), dot(a2, t));
  let r0 = cross(c1, c2);
  let r1 = cross(c2, c0);
  let r2 = cross(c0, c1);
  let det = dot(c0, r0);
  return vec3f(dot(r0, b), dot(r1, b), dot(r2, b)) / det;
}
fn rg_ink(inkSet: f32, i: i32) -> vec3f {
  var a = array<vec3f, 3>(vec3f(0.04, 0.09, 0.32), vec3f(1.0, 0.22, 0.48), vec3f(1.0, 0.86, 0.06));
  if (inkSet > 2.5) { a = array<vec3f, 3>(vec3f(0.12, 0.05, 0.3), vec3f(0.0, 0.62, 0.55), vec3f(1.0, 0.45, 0.15)); }
  else if (inkSet > 1.5) { a = array<vec3f, 3>(vec3f(0.03, 0.17, 0.1), vec3f(0.95, 0.18, 0.12), vec3f(0.98, 0.72, 0.62)); }
  else if (inkSet > 0.5) {
    var lv = array<f32, 3>(0.07, 0.4, 0.72);
    var pc = array<vec3f, 3>(L.pal1.rgb, L.pal2.rgb, L.pal3.rgb);
    for (var k = 0; k < 3; k++) {
      let c = pc[k] + 0.02;
      // Push palette hues toward saturated spot-ink colours at a fixed lightness.
      let h = mix(vec3f(luma(c)), c, 1.6);
      a[k] = clamp(max(h, vec3f(0.0)) / max(luma(max(h, vec3f(0.0))), 1e-3) * lv[k], vec3f(0.02), vec3f(1.0));
    }
  }
  return clamp(a[i], vec3f(0.03), vec3f(1.0));
}
fn rg_bright(c: vec3f) -> vec3f { return c / max(max(c.x, max(c.y, c.z)), 0.05) * 0.75; }
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let rs = L.res.y / 720.0;
  let n = i32(L.p[0].x);
  let paperMode = L.p[0].z;
  let inkSet = L.p[0].w;
  let dark = paperMode > 2.5;
  let base = src(uv);
  let lift = 1.0 / (1.0 - min(luma(base / (1.0 + base)), 0.8));
  let i0 = rg_ink(inkSet, 0);
  let i1 = rg_ink(inkSet, 1);
  let i2 = select(vec3f(1.0), rg_ink(inkSet, 2), n > 2);
  var paper = vec3f(0.97, 0.94, 0.86);
  if (paperMode > 0.5) { paper = vec3f(0.93, 0.95, 0.97); }
  if (paperMode > 1.5) { paper = mix(vec3f(0.95), L.pal3.rgb / max(luma(L.pal3.rgb), 1e-3) * 0.9, 0.18); }
  if (dark) { paper = vec3f(0.018, 0.016, 0.02); }
  let grain = max(1.0, 1.6 * rs * L.p[1].y);
  let gcell = floor(frag / grain);
  var col = select(paper, vec3f(0.0), dark);
  var trans = vec3f(1.0);
  for (var i = 0; i < 3; i++) {
    if (i >= n) { break; }
    let ang = L.p[1].z + f32(i) * 2.2;
    let off = vec2f(cos(ang), sin(ang)) * L.p[0].y * rs * f32(i) * 0.7;
    let c = src(uv + off / L.res);
    let s = c / (1.0 + c);
    var d: vec3f;
    if (dark) {
      d = rg_solve(s * 1.2, rg_bright(i0), rg_bright(i1), rg_bright(i2) * f32(n > 2));
    } else {
      let od = -log(max(s, vec3f(0.035)));
      d = rg_solve(od, -log(i0), -log(i1), select(vec3f(0.0), -log(i2), n > 2));
    }
    var di = sat(d[i]);
    // Uneven drum coverage, posterised to flat levels; grain only frays the level boundaries
    // and speckles the solid ink.
    di *= 0.85 + 0.25 * vnoise(frag * 0.01 / rs + f32(i) * 9.1);
    let dith = hash12(gcell + vec2f(f32(i) * 31.0, L.p[1].x * 0.37));
    var q = floor(di * 3.0 + 0.5 + (dith - 0.5) * 0.7) / 3.0;
    q *= 0.88 + 0.12 * step(0.25, hash12(gcell * 1.37 + vec2f(f32(i) * 7.0, 3.0)));
    let ink = rg_ink(inkSet, i);
    if (dark) { col += rg_bright(ink) * q; }
    else { trans *= pow(ink, vec3f(q)); }
  }
  if (!dark) { col = paper * trans; }
  // Paper fibre.
  col *= 0.95 + 0.07 * vnoise(frag * vec2f(0.35, 0.06) / rs);
  return col * lift;
}
`,
});
