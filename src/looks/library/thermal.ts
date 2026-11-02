import { defineLook } from '../types';

/**
 * Thermal camera false colour: a soft low-res "heat" field mapped through a ramp, with sensor noise.
 * dna0 = ramp (ironbow, rainbow, white-hot, arctic, palette), dna1 = contrast,
 * dna2 = noise / fixed pattern / scanline, dna3 = sensor (smooth, pixelated, isotherm bands).
 */
export default defineLook({
  meta: { id: 'thermal', name: 'Thermal Camera', weight: 0.5, energy: [0.2, 1], amount: [0.65, 0.95], genres: { techno: 0.8, dnb: 0.7, dubstep: 0.8 } },
  params(ctx, p) {
    const m = ctx.music;
    const d = ctx.dna;
    p[0] = Math.floor(d[0] * 5);
    p[1] = 0.35 + 0.9 * d[1];
    p[2] = 0.65 + 0.9 * (1 - d[1]);
    p[3] = Math.floor(d[3] * 3);
    p[4] = 0.03 + 0.11 * d[2];
    p[5] = 0.12 * m.kick + 0.06 * m.bass - 0.08 * m.anticipation;
    p[6] = m.snare;
    p[7] = Math.floor(ctx.time * 30);
    p[8] = m.dropPulse;
    p[9] = d[2];
  },
  wgsl: /* wgsl */ `
fn th_ironbow(h: f32) -> vec3f {
  var c = array<vec3f, 7>(vec3f(0.0, 0.0, 0.02), vec3f(0.06, 0.0, 0.28), vec3f(0.42, 0.0, 0.48), vec3f(0.85, 0.08, 0.12),
    vec3f(1.0, 0.42, 0.0), vec3f(1.0, 0.82, 0.12), vec3f(1.0, 1.0, 0.88));
  let x = sat(h) * 5.999;
  let i = i32(floor(x));
  return mix(c[i], c[i + 1], smoothstep(0.0, 1.0, fract(x)));
}
fn th_ramp(mode: f32, h: f32) -> vec3f {
  if (mode < 0.5) { return th_ironbow(h); }
  if (mode < 1.5) { return hsv2rgb(vec3f(0.7 - 0.72 * sat(h), 1.0 - 0.6 * smoothstep(0.85, 1.0, h), 0.04 + 0.96 * smoothstep(0.02, 0.5, h))); }
  if (mode < 2.5) {
    // White-hot with the hottest spots tagged in the palette accent.
    let g = vec3f(h * h);
    return mix(g, L.pal3.rgb / max(luma(L.pal3.rgb), 1e-3) * 0.9, smoothstep(0.82, 0.97, h) * 0.85);
  }
  if (mode < 3.5) {
    // Arctic: black, deep blue, cyan, white.
    return mix(mix(vec3f(0.0, 0.01, 0.05), vec3f(0.0, 0.2, 0.75), smoothstep(0.0, 0.45, h)), vec3f(0.85, 1.0, 1.0), smoothstep(0.4, 1.0, h)) * smoothstep(-0.05, 0.3, h);
  }
  return palRamp(h) / max(luma(palRamp(h)), 0.02) * (0.02 + 0.9 * h * h);
}
fn th_heat(uv: vec2f, d: vec2f) -> f32 {
  let l = 0.4 * luma(src(uv)) + 0.15 * (luma(src(uv + d)) + luma(src(uv - d)) + luma(src(uv + vec2f(d.y, -d.x))) + luma(src(uv - vec2f(d.y, -d.x))));
  return l;
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let rs = L.res.y / 720.0;
  let sensor = L.p[0].w;
  var suv = uv;
  if (sensor > 0.5 && sensor < 1.5) {
    // Low-resolution microbolometer pixels.
    let px = 4.0 * rs;
    suv = (floor(frag / px) + 0.5) * px / L.res;
  }
  let l = th_heat(suv, vec2f(2.5 * rs) / L.res);
  var h = l / (l + L.p[0].y);
  h = pow(sat(h + L.p[1].y), L.p[0].z);
  h = sat(h * (1.0 + 0.6 * L.p[2].x));
  if (sensor > 1.5) {
    // Isotherm bands: quantised heat with thin contour lines.
    let b = h * 9.0;
    let e = abs(fract(b) - 0.5);
    h = mix(h, (floor(b) + 0.5) / 9.0, 0.75) * (0.82 + 0.18 * smoothstep(0.0, 0.06, 0.5 - e));
  }
  // Sensor noise: temporal grain, column fixed pattern, rolling scan band per beat.
  let nz = L.p[1].x * (1.0 + 2.5 * L.p[1].z);
  let grain = (hash12(floor(frag / max(1.0, rs)) + vec2f(L.p[1].w * 0.731, L.p[1].w * 0.113)) - 0.5) * nz;
  let fpn = (hash12(vec2f(floor(frag.x / max(1.0, rs)), 7.0)) - 0.5) * nz * 0.5 * step(0.5, L.p[2].y);
  let roll = exp(-pow((uv.y - fract(L.beatPhase)) * 18.0, 2.0)) * 0.05 * step(0.3, L.p[2].y);
  let scan = 1.0 - 0.08 * step(0.66, L.p[2].y) * step(0.5, fract(frag.y / (2.0 * max(1.0, rs))));
  h = sat(h + grain + fpn + roll);
  let ramp = th_ramp(L.p[0].x, h);
  // Keep the output near the input's brightness while letting the ramp set the colour.
  let tgt = mix(l, 0.01 + 1.2 * h * h, 0.5);
  // Natural ramp luminance for the camera ramps (cold reads dark), input-matched for the others.
  let lock = select(0.25, 0.7, L.p[0].x > 1.5);
  let gain = clamp(mix(1.0, tgt / max(luma(ramp), 0.03), lock), 0.3, 2.5);
  let col = ramp * gain * scan;
  return col + vec3f(L.p[2].x * 0.6);
}
`,
});
