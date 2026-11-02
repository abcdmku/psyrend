import { defineLook } from '../types';
import { Groove, LSD_OUT_WGSL, LSD_WGSL } from './lsdCommon';

const groove = new Groove();

/**
 * Klüver's form constants as a gentle remap of the image itself (nothing drawn on top). Following
 * Bressloff and Cowan, each form is a plane wave in log-polar ("cortical") coordinates
 * (u, v) = (log r, angle), applied as a small displacement:
 *   tunnel/funnel = waves along u (rings that stream inward), spiral = oblique waves in (u, v),
 *   lattice = a honeycomb of lens cells in screen space, cobweb = a spoke-and-ring lattice in (u, v).
 * The family changes once per 8-bar phrase, cross-faded over ~2 s; energy sets the depth and the
 * inward streaming speed; the highs tighten the wave count.
 * dna0 = starting family, dna1 = strength, dna2 = wave count, dna3 = twist.
 */
export default defineLook({
  meta: {
    id: 'lsd-form-constant',
    name: 'LSD Form Constants',
    weight: 0.6,
    energy: [0.15, 1],
    amount: [0.85, 1],
    remaps: true,
    overlay: true,
    genres: { techno: 0.9, edm: 0.8, ambient: 0.8, dubstep: 0.6, synthwave: 0.7 },
  },
  params(ctx, p) {
    groove.update(ctx, p);
    const d = ctx.dna;
    p[8] = Math.floor(d[0] * 4);
    p[9] = 0.9 + 0.3 * d[1];
    p[10] = 3 + Math.floor(d[2] * 3);
    p[11] = (d[3] - 0.5) * 0.5;
  },
  wgsl: /* wgsl */ `
${LSD_WGSL}
${LSD_OUT_WGSL}
/** Gradient of a honeycomb (three cosines 120 degrees apart): each cell acts as a soft lens. */
fn fc_hexGrad(q: vec2f) -> vec2f {
  var g = vec2f(0.0);
  for (var i = 0; i < 3; i++) {
    let a = f32(i) * 2.0943951;
    let k = vec2f(cos(a), sin(a));
    g -= k * sin(dot(k, q));
  }
  return g / 3.0;
}
/** Honeycomb value: 1 at cell centres, about -0.5 at the borders. */
fn fc_hex(q: vec2f) -> f32 {
  var h = 0.0;
  for (var i = 0; i < 3; i++) {
    let a = f32(i) * 2.0943951;
    h += cos(dot(vec2f(cos(a), sin(a)), q));
  }
  return h / 3.0;
}
fn fc_weight(fam: f32, i: f32) -> f32 {
  let d = abs(fract((fam - i) / 4.0 + 0.5) - 0.5) * 4.0;
  return smoothstep(1.0, 0.0, d);
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let p = lsd_p(uv);
  let base = src(uv);
  let e = lsd_energy();
  let r = length(p) + 1e-4;
  let a = atan2(p.y, p.x);
  let u = log(r);
  let n = L.p[2].z;
  let t = lsd_flow() * 0.25;
  let fam = L.p[2].x + lsd_phrase();
  let amp = L.p[2].y * (0.7 + 0.3 * e) * L.amount;
  // Radial and angular displacements in log-polar space (du, dv), a screen-space one (dp), and
  // the form's own wave value g, which also modulates the image's light and hue so the geometry
  // reads on smooth or dark content (multiplicative, so blacks stay black).
  var du = 0.0;
  var dv = L.p[2].w * u * 0.25;
  var dp = vec2f(0.0);
  var g = 0.0;
  // Tunnel / funnel: rings in log r streaming inward.
  let w0 = fc_weight(fam, 0.0);
  let tw = TAU * (u * n * 0.22 + t);
  du += w0 * 0.09 * sin(tw);
  g += w0 * sin(tw + 1.2);
  // Spiral: oblique plane waves in (u, v) are logarithmic spiral arms.
  let w1 = fc_weight(fam, 1.0);
  let sp = TAU * (u * n * 0.16 + a * floor(n) / TAU + t);
  dv += w1 * 0.12 * sin(sp);
  du += w1 * 0.05 * cos(sp);
  g += w1 * sin(sp + 1.2);
  // Lattice: a honeycomb of lens cells over the image, slowly turning.
  let w2 = fc_weight(fam, 2.0);
  let hs = 18.0 + 3.0 * n;
  let hq = rot2(t * 0.15) * p * hs + vec2f(t * 0.6, 0.0);
  dp += w2 * fc_hexGrad(hq) * 0.024;
  // Light only the connected honeycomb walls (low h). Never darken the cell centres: dark or bright
  // centres both read as polka dots.
  // No light modulation for the lattice: any brightness pattern on it reads as stamped polka dots
  // or perforations. It reads through the lens warp and a small hue lean (applied below).
  let latHue = w2 * 0.15 * fc_hex(hq);
  // Cobweb: radial spokes crossed by rings, a lattice in log-polar space.
  let w3 = fc_weight(fam, 3.0);
  let spokes = 2.0 * floor(n);
  let ring = TAU * (u * n * 0.3 + t);
  du += w3 * 0.07 * sin(ring) * (0.55 + 0.45 * cos(spokes * a));
  dv += w3 * 0.45 * sin(spokes * a) / spokes * (0.6 + 0.4 * cos(ring));
  g += w3 * (0.5 * sin(ring) + 0.5 * cos(spokes * a));
  // Each warp's slope (amplitude x angular frequency) stays under ~0.8, so the map never folds.
  // Fade the log-polar warps out at the singular centre.
  let cfade = smoothstep(0.0, 0.2, r);
  let r2 = exp(u + du * amp * cfade);
  let a2 = a + dv * amp * cfade;
  let q = vec2f(cos(a2), sin(a2)) * r2 + dp * amp;
  let d = (q - p) * lsd_edge(uv);
  // A faint chromatic split along the warp, gathered as a continuous spectrum (taps about a pixel
  // apart, each weighted by its colour), so small sparks smear into a short rainbow instead of
  // splitting into three coloured dots.
  let ns = i32(clamp(ceil(length(d) * L.res.y * 0.12) + 1.0, 3.0, 16.0));
  var acc = vec3f(0.0);
  var ws = vec3f(0.0);
  for (var i = 0; i < 16; i++) {
    if (i >= ns) { break; }
    let t = (f32(i) + 0.5) / f32(ns);
    let w = clamp(vec3f(1.0 - abs(t * 2.0), 1.0 - abs(t * 2.0 - 1.0), 1.0 - abs(t * 2.0 - 2.0)), vec3f(0.02), vec3f(1.0));
    acc += srcMirror(lsd_uv(p + d * (1.06 - 0.12 * t))) * w;
    ws += w;
  }
  var col = acc / ws;
  let gl = g * amp * select(cfade, 1.0, w2 > 0.5);
  col = lsd_vivid(lsd_hue(col, 1.7 * gl + latHue * amp), 1.15 + 0.35 * amp) * max(1.0 + 0.75 * gl, 0.35);
  return lsd_out(base, col);
}
`,
});
