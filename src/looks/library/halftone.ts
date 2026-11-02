import { defineLook } from '../types';

/**
 * Print halftone: rotated dot screens sampled at each cell centre.
 * dna0 = ink model (mono ink on paper, CMYK, palette duotone, RGB light dots on black),
 * dna1 = screen angle, dna2 = cell size, dna3 = dot shape (round, diamond, line screen).
 */
export default defineLook({
  meta: { id: 'halftone', name: 'Halftone Print', weight: 0.7, energy: [0.15, 1], amount: [0.6, 0.95], genres: { techno: 0.6, lofi: 0.8, hiphop: 0.8, pop: 0.7 } },
  params(ctx, p) {
    const m = ctx.music;
    p[0] = Math.floor(ctx.dna[0] * 4);
    p[1] = Math.floor(ctx.dna[3] * 3);
    // Coarser before a drop, snaps finer on the drop.
    p[2] = (5 + 8 * ctx.dna[2]) * (1 + 0.45 * m.anticipation) * (1 - 0.25 * m.dropPulse);
    p[3] = ctx.dna[1] * Math.PI * 0.5;
    p[4] = 1 + 0.4 * m.kick + 0.15 * m.beatPulse;
    p[5] = 0.06 * m.snare;
  },
  wgsl: /* wgsl */ `
fn ht_screen(frag: vec2f, ang: f32, size: f32) -> vec4f {
  let R = rot2(ang);
  let p = (R * frag) / size;
  let id = floor(p);
  let c = transpose(R) * ((id + 0.5) * size);
  return vec4f(p - id - 0.5, c / L.res);
}
fn ht_dot(q: vec2f, cov: f32, shape: f32, aa: f32) -> f32 {
  let k = sat(cov);
  var d = length(q);
  var r = sqrt(k / PI) * 1.25;
  if (shape > 1.5) { d = abs(q.y); r = k * 0.5; }
  else if (shape > 0.5) { d = abs(q.x) + abs(q.y); r = sqrt(k); }
  return smoothstep(r + aa, r - aa, d);
}
fn ht_hue(c: vec3f, l: f32) -> vec3f { return min(c / max(luma(c), 1e-3) * l, vec3f(1.0)); }
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let base = src(uv);
  let s0 = base / (1.0 + base);
  let lift = 1.0 / (1.0 - min(luma(s0), 0.8));
  let mode = L.p[0].x;
  let shape = L.p[0].y;
  let size = max(L.p[0].z * L.res.y / 720.0, 4.0);
  let a0 = L.p[0].w + L.p[1].y;
  let gain = L.p[1].x;
  let aa = 0.8 / size;
  let paper = vec3f(1.0, 0.96, 0.89);
  var col = vec3f(0.0);
  if (mode < 0.5) {
    // Single ink on warm paper.
    let sc = ht_screen(frag, a0 + 0.785, size);
    let c = src(sc.zw);
    let cov = ht_dot(sc.xy, (1.0 - luma(c / (1.0 + c))) * gain, shape, aa);
    col = mix(paper, vec3f(0.035, 0.035, 0.05), cov);
  } else if (mode < 1.5) {
    // CMYK with under-colour removal, classic 15/75/0/45 degree screens.
    var angs = array<f32, 4>(0.2618, 1.309, 0.0, 0.785);
    var cov = vec4f(0.0);
    for (var i = 0; i < 4; i++) {
      let sc = ht_screen(frag, a0 + angs[i], size);
      let c = src(sc.zw);
      let s = c / (1.0 + c);
      let cmy = 1.0 - s;
      let k = min(cmy.x, min(cmy.y, cmy.z)) * 0.85;
      let sep = vec4f((cmy - k) / (1.0 - k + 1e-3), k);
      cov[i] = ht_dot(sc.xy, sep[i] * gain, shape, aa);
    }
    col = paper * mix(vec3f(1.0), vec3f(0.0, 0.62, 0.92), cov.x) * mix(vec3f(1.0), vec3f(0.93, 0.06, 0.52), cov.y)
        * mix(vec3f(1.0), vec3f(1.0, 0.93, 0.0), cov.z) * mix(vec3f(1.0), vec3f(0.04), cov.w);
  } else if (mode < 2.5) {
    // Palette duotone: a hue ink for midtones and a deep ink for shadows on tinted paper.
    let inkA = ht_hue(L.pal1.rgb + 0.02, 0.32);
    let inkB = ht_hue(L.pal0.rgb + 0.01, 0.025);
    let pap = mix(vec3f(0.97), ht_hue(L.pal3.rgb + 0.02, 0.85), 0.22);
    let sa = ht_screen(frag, a0, size);
    let ca = src(sa.zw);
    let la = luma(ca / (1.0 + ca));
    let sb = ht_screen(frag, a0 + 0.785, size);
    let cb = src(sb.zw);
    let lb = luma(cb / (1.0 + cb));
    let covA = ht_dot(sa.xy, (1.0 - la) * 0.9 * gain, shape, aa);
    let covB = ht_dot(sb.xy, sat((0.55 - lb) * 1.8) * gain, shape, aa);
    col = mix(pap * mix(vec3f(1.0), inkA, covA), inkB, covB);
  } else {
    // Additive RGB light dots on black, each primary on its own screen.
    var acc = vec3f(0.0);
    for (var i = 0; i < 3; i++) {
      let sc = ht_screen(frag, a0 + f32(i) * 0.5236, size);
      let c = src(sc.zw);
      let s = c / (1.0 + c);
      let cov = ht_dot(sc.xy, s[i] * 1.15 * gain, shape, aa);
      var e = vec3f(0.0);
      e[i] = 1.0;
      acc += e * cov;
    }
    col = acc;
  }
  return col * lift;
}
`,
});
