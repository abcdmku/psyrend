import { defineLook } from '../types';
import { OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * Psychedelic solarisation: tone folded through cyclic curves whose phase moves on a step each
 * bar, eased over about a beat, so the colours rotate through the palette with the song structure.
 * dna0 = curve family (per-channel Sabattier fold, palette contour, channel-inversion cycle, hue fold),
 * dna1 = cycle rate per bar, dna2 = fold count and how much of the original survives,
 * dna3 = luminance lock (keep the scene's shading vs free colour).
 */
export default defineLook({
  meta: { id: 'solarize', name: 'Solarize', weight: 0.35, energy: [0.4, 1], amount: [0.45, 0.85], genres: { edm: 0.8, dubstep: 0.7, rock: 0.6 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    const rates = [0.06, 0.1, 0.15, 0.25];
    const rate = rates[Math.floor(d[1] * 4)];
    p[0] = Math.floor(d[0] * 4);
    p[1] = v.bars * rate + 0.01 * v.flow;
    p[2] = 1.5 + 1.2 * Math.floor(((d[2] * 3) % 1) * 3);
    p[3] = Math.min(1, 0.45 + 0.55 * d[2]);
    p[4] = 0.3 + 0.7 * d[3];
  },
  wgsl: /* wgsl */ `
fn so_tri(x: f32) -> f32 { return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0); }
fn so_tri3(x: vec3f) -> vec3f { return vec3f(so_tri(x.x), so_tri(x.y), so_tri(x.z)); }
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let c = src(uv);
  let s = c / (1.0 + c);
  let l = luma(s);
  let fam = L.p[0].x;
  let ph = L.p[0].y;
  let k = L.p[0].z;
  var y: vec3f;
  if (fam < 0.5) {
    y = so_tri3(s * k * 1.5 + ph + vec3f(0.0, 0.33, 0.67) * 0.6);
    y = max(mix(vec3f(luma(y)), y, 1.5), vec3f(0.0));
  } else if (fam < 1.5) {
    let pc = palAt(l * k + ph);
    y = pc / max(luma(pc), 0.02) * (0.15 + 0.85 * so_tri(l * k * 2.0 + ph * 2.0)) * 0.6;
  } else if (fam < 2.5) {
    // Invert a different channel set each step, crossfading between steps.
    let st = floor(ph * 6.0);
    let f = smoothstep(0.0, 1.0, fract(ph * 6.0));
    var masks = array<vec3f, 6>(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 1.0), vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 1.0), vec3f(0.0, 0.0, 1.0), vec3f(1.0, 1.0, 0.0));
    let i0 = i32(st - 6.0 * floor(st / 6.0));
    let m = mix(masks[(i0 + 5) % 6], masks[i0], f);
    let sol = so_tri3(s * k);
    y = mix(s, sol, m);
  } else {
    let hue = l * k * 0.7 + ph;
    y = hsv2rgb(vec3f(fract(hue), 0.8, 0.15 + 0.85 * so_tri(l * (k + 1.0))));
  }
  y = mix(s, y, L.p[0].w);
  // Back to linear-ish HDR and hold the brightness near the input.
  var o = y * y * 1.3;
  let tgt = luma(c) * 1.4 + 0.1;
  let lo = luma(o);
  o *= mix(min(1.0, tgt / max(lo, 1e-3)), clamp(luma(c) / max(lo, 1e-3), 0.0, 4.0), L.p[1].x);
  // Real darks: the folds never lift black.
  return o * smoothstep(0.0, 0.05, luma(s));
}
`,
});
