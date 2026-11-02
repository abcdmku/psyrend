import { defineLook } from '../types';
import { Groove, LSD_WGSL } from './lsdCommon';

const groove = new Groove();

/**
 * LSD halos and auras: bright forms radiate soft, layered chromatic glows. Four rings of taps
 * gather the bright part of the image around each pixel; each ring is hue-rotated a step further,
 * so auras shade from the object's own colour into neighbouring hues outward, and they sit mostly
 * outside the source (the source itself is masked out), so darks stay dark. The aura radius breathes
 * on a 4-bar cycle; energy sets the glow, the pads widen the hue spread, busy highs brighten it a
 * little.
 * dna0 = radius, dna1 = threshold, dna2 = hue step, dna3 = palette tint vs own colour.
 */
export default defineLook({
  meta: {
    id: 'lsd-aura',
    name: 'LSD Auras',
    weight: 0.7,
    energy: [0, 1],
    amount: [0.85, 1],
    overlay: true,
    genres: { ambient: 0.9, synthwave: 0.9, edm: 0.8, lofi: 0.7, techno: 0.7, dubstep: 0.6 },
  },
  params(ctx, p) {
    groove.update(ctx, p);
    const d = ctx.dna;
    p[8] = 1.3 + 0.6 * d[0];
    p[9] = 0.22 + 0.2 * d[1];
    p[10] = 0.9 + 0.5 * d[2];
    p[11] = 0.4 + 0.4 * d[3];
  },
  wgsl: /* wgsl */ `
${LSD_WGSL}
fn au_bright(c: vec3f, thr: f32) -> vec3f {
  return c * smoothstep(thr, thr * 2.5, luma(c));
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let base = src(uv);
  let e = lsd_energy();
  let thr = L.p[2].y * (1.15 - 0.35 * e);
  let rs = L.res.y / 720.0;
  let breath = 1.0 + 0.18 * sin(TAU * lsd_bars() / 4.0);
  let r0 = L.p[2].x * breath;
  let hueStep = L.p[2].z * (0.75 + 0.5 * lsd_backing());
  let spin = lsd_flow() * 0.05;
  let asp = vec2f(L.res.y / L.res.x, 1.0) / L.res.y;
  var aura = vec3f(0.0);
  for (var ring = 0; ring < 4; ring++) {
    let fr = f32(ring);
    // Radii about 4, 8, 14 and 22 px at 720p. Each tap reads the pre-blurred image at a blur as wide as
    // the ring, so the ring is one continuous soft glow: small sparks never turn into rings of dots.
    let rad = r0 * (2.5 + 2.0 * fr + 0.6 * fr * fr);
    var sum = vec3f(0.0);
    for (var j = 0; j < 6; j++) {
      let ang = f32(j) * TAU / 6.0 + fr * 0.61 + spin;
      sum += au_bright(srcSoft(uv + vec2f(cos(ang), sin(ang)) * rad * rs * asp, rad * 0.9), thr);
    }
    sum /= 6.0;
    // Each ring outward turns the hue a step further and leans toward the palette.
    let own = lsd_hue(sum, hueStep * (fr + 1.0) + sin(spin * 2.0) * 0.4);
    let pc = palAt(fr * 0.2 + spin * 0.4);
    let tinted = pc / max(luma(pc), 0.05) * luma(sum);
    let c = mix(own, tinted, L.p[2].w);
    aura += lsd_vivid(c, 2.0) * (1.0 - 0.12 * fr);
  }
  // Halos fall into the darker surroundings: keep them off the source itself and off anything
  // already bright, so dense bright worlds don't wash out. Soft-clip the sum so it never blows out.
  let self_ = smoothstep(0.02, thr * 1.6, luma(base));
  // Busy highs brighten the aura a little.
  let gain = (0.55 + 0.55 * e) * (1.0 + 0.25 * lsd_detail());
  let add = aura * gain * 1.6;
  return base + add / (1.0 + 0.7 * luma(add)) * (1.0 - 0.85 * self_);
}
`,
});
