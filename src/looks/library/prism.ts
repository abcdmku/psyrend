import { defineLook } from '../types';
import { OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * Prismatic dispersion: every pixel gathers a continuous spectrum of the image along a direction
 * (a tap about every pixel, each weighted by its wavelength's colour), so edges and points fan into
 * smooth rainbows instead of a few stamped copies. The eased energy and bass widen the spectrum
 * slowly.
 * dna0 = axis (linear angle, radial, swirl), dna1 = strength, dna2 = spectral purity (soft pastel
 * fringes to pure, separated colours), dna3 = uniform split vs edge-led dispersion.
 */
export default defineLook({
  meta: { id: 'prism', name: 'Prism Split', weight: 0.8, energy: [0.25, 1], amount: [0.5, 0.8], overlay: true, genres: { edm: 0.9, synthwave: 0.9, dubstep: 0.8, techno: 0.7 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    const mode = Math.floor(d[0] * 3);
    p[0] = mode;
    // Linear: angle from the gene, slowly turning with the spin phase.
    p[1] = ((d[0] * 3) % 1) * Math.PI + 0.015 * v.flow;
    p[2] = (6 + 10 * d[1]) * (1 + 0.5 * v.energy + 0.3 * v.bass);
    p[3] = 1 + 1.5 * d[2];
    // Mostly edge-led dispersion: fringes on the forms, not a blur over everything.
    p[4] = 0.5 + 0.5 * d[3];
  },
  wgsl: /* wgsl */ `
/** Smooth spectral weights for t in [0, 1]: red, through green, to blue-violet. */
fn pr_band(t: f32, purity: f32) -> vec3f {
  let r = exp(-pow((t - 0.08) / 0.24, 2.0)) + 0.35 * exp(-pow((t - 1.0) / 0.12, 2.0));
  let g = exp(-pow((t - 0.5) / 0.22, 2.0));
  let b = exp(-pow((t - 0.86) / 0.22, 2.0));
  return pow(vec3f(r, g, b), vec3f(purity));
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let rs = L.res.y / 720.0;
  let asp = vec2f(L.res.x / L.res.y, 1.0);
  let mode = L.p[0].x;
  let rel = (uv - 0.5) * asp;
  var dir = vec2f(cos(L.p[0].y), sin(L.p[0].y));
  if (mode > 1.5) { dir = vec2f(-rel.y, rel.x) * 2.2; }
  else if (mode > 0.5) { dir = rel * 2.2; }
  let amp0 = L.p[0].z;
  var amp = amp0;
  let edgeMode = L.p[1].x;
  if (edgeMode > 0.4) {
    // Disperse mostly where the image has contrast. The contrast is measured on the image blurred
    // over a good part of the spread, so the spread changes smoothly across a streak instead of
    // cutting it off a few pixels from the edge that casts it.
    let R = max(0.35 * amp0, 3.0);
    let o = vec2f(R * rs) / L.res;
    let gx = luma(srcSoft(uv + vec2f(o.x, 0.0), R)) - luma(srcSoft(uv - vec2f(o.x, 0.0), R));
    let gy = luma(srcSoft(uv + vec2f(0.0, o.y), R)) - luma(srcSoft(uv - vec2f(0.0, o.y), R));
    let e = smoothstep(0.03, 0.4, 0.5 * length(vec2f(gx, gy)) / (luma(srcSoft(uv, R)) + 0.08));
    amp *= mix(1.0, 0.3 + 1.9 * e, smoothstep(0.4, 0.8, edgeMode));
  }
  // One tap per ~1.2 output pixels along the spread, so a point disperses into a continuous line.
  let lenPx = amp * rs * length(dir);
  let n = i32(clamp(ceil(lenPx / 1.2) + 1.0, 6.0, 64.0));
  let off = dir * amp * rs / L.res.y / asp;
  let purity = L.p[0].w;
  var acc = vec3f(0.0);
  var ws = vec3f(0.0);
  for (var i = 0; i < 64; i++) {
    if (i >= n) { break; }
    let t = (f32(i) + 0.5) / f32(n);
    let w = pr_band(t, purity);
    acc += src(uv + off * (t - 0.5)) * w;
    ws += w;
  }
  let o = acc / max(ws, vec3f(1e-4));
  // A touch more saturation so the fringes read as spectral rather than as blur.
  return max(mix(vec3f(luma(o)), o, 1.2), vec3f(0.0));
}
`,
});
