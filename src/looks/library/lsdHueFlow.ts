import { defineLook } from '../types';
import { Groove, LSD_WGSL } from './lsdCommon';

const groove = new Groove();

/**
 * LSD colour enhancement: saturation swells, and slow waves of hue flow across the image's
 * luminance contours (iso-brightness bands shift colour in sequence, so colour seems to pour across
 * surfaces). Greys pick up a hint of the palette, local contrast lifts so edges glow slightly, and
 * the darkest areas are left alone. Energy sets the flow speed and the vividness; the pads widen the
 * hue swing; the highs tighten the contour bands.
 * dna0 = band density, dna1 = hue swing, dna2 = vividness, dna3 = spatial lean of the waves.
 */
export default defineLook({
  meta: {
    id: 'lsd-hue-flow',
    name: 'LSD Hue Flow',
    weight: 0.8,
    energy: [0, 1],
    amount: [0.65, 1],
    overlay: true,
    genres: { ambient: 0.9, synthwave: 0.9, lofi: 0.8, edm: 0.8, techno: 0.7, jazz: 0.6, classical: 0.6 },
  },
  params(ctx, p) {
    groove.update(ctx, p);
    const d = ctx.dna;
    p[8] = 0.35 + 0.45 * d[0];
    p[9] = 0.7 + 0.9 * d[1];
    p[10] = 0.25 + 0.35 * d[2];
    p[11] = 0.4 + 1.2 * d[3];
  },
  wgsl: /* wgsl */ `
${LSD_WGSL}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let p = lsd_p(uv);
  let base = src(uv);
  let e = lsd_energy();
  let y = luma(base);
  // Contour coordinate: log luminance, so the bands spread evenly through the HDR range.
  let lc = log2(y + 0.03);
  let dens = L.p[2].x * (1.0 + 0.6 * lsd_detail());
  let lean = L.p[2].w;
  let spatial = 0.35 * sin(p.x * lean + lsd_flow() * 0.05) + 0.25 * sin(p.y * lean * 0.8 - lsd_flow() * 0.04);
  let ph = lc * dens - lsd_flow() * 0.12 + spatial;
  let swing = L.p[2].y * (0.6 + 0.6 * lsd_backing());
  var c = lsd_hue(base, swing * sin(TAU * ph));
  // Greys and pastels lean toward the palette colour of their band, keeping their brightness.
  let chroma = (max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b))) / (max(c.r, max(c.g, c.b)) + 1e-3);
  let pc = palAt(ph * 0.5);
  c = mix(c, pc / max(luma(pc), 0.05) * y, 0.3 * (1.0 - sat(chroma * 1.6)));
  c = lsd_vivid(c, 1.0 + L.p[2].z * (0.7 + 0.6 * e));
  // Gentle clarity: lift local contrast so edges glow a little.
  // A true smooth low-pass, not a few scattered taps, so small points never gain a dark ring
  // or a dotted halo.
  let blur = srcSoft(uv, 4.0);
  c += max(c * (y - luma(blur)) / (y + 0.05), vec3f(-0.5 * y)) * 0.6;
  // Keep the real blacks.
  let keep = smoothstep(0.004, 0.05, y);
  return max(mix(base, c, keep), vec3f(0.0));
}
`,
});
