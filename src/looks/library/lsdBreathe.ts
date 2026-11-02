import { defineLook } from '../types';
import { Groove, LSD_OUT_WGSL, LSD_WGSL } from './lsdCommon';

const groove = new Groove();

/**
 * LSD "breathing": the whole image slowly inhales and exhales on a 2- or 4-bar cycle, and regions
 * swell and shrink out of phase with each other, so the swelling travels across surfaces like a
 * living thing. A tiny chromatic split rides on the displacement. Energy sets the depth of the
 * breath; the highs add a fine, faster shimmer to the texture.
 * dna0 = bars per breath, dna1 = depth, dna2 = region scale, dna3 = global vs regional balance.
 */
export default defineLook({
  meta: {
    id: 'lsd-breathe',
    name: 'LSD Breathing',
    weight: 0.7,
    energy: [0, 0.9],
    amount: [0.85, 1],
    overlay: true,
    genres: { ambient: 0.9, lofi: 0.8, techno: 0.7, edm: 0.7, dubstep: 0.6 },
  },
  params(ctx, p) {
    groove.update(ctx, p);
    const d = ctx.dna;
    p[8] = d[0] < 0.75 ? 2 : 4;
    p[9] = 0.8 + 0.5 * d[1];
    p[10] = 1.1 + 1.2 * d[2];
    p[11] = 0.35 + 0.5 * d[3];
  },
  wgsl: /* wgsl */ `
${LSD_WGSL}
${LSD_OUT_WGSL}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let p = lsd_p(uv);
  let e = lsd_energy();
  let ph = TAU * lsd_bars() / L.p[2].x;
  let amp = L.p[2].y * (0.4 + 0.6 * e) * L.amount;
  let reg = L.p[2].w;
  // Global breath: a gentle scale about the centre (inhale = swell toward the viewer).
  var d = -p * sin(ph) * 0.04 * (1.0 - reg);
  // Regional breath: displacement along the gradient of a slow potential swells its peaks and
  // shrinks its troughs; the phase varies with the potential so the swelling travels.
  let s = lsd_psi(p, lsd_flow() * 0.12, L.p[2].z);
  d += -s.yz / L.p[2].z * sin(ph - s.x * 1.3) * 0.06 * reg;
  d *= amp;
  // Fine shimmer from the highs: a small, faster breath in the texture itself.
  let f = lsd_psi(p + 3.1, lsd_flow() * 0.5 + lsd_beat() * 0.05, 11.0);
  d += -f.yz / 11.0 * 0.006 * (0.3 + lsd_detail()) * L.amount;
  d *= lsd_edge(uv);
  let base = src(uv);
  // Chromatic split along the displacement as a continuous spectrum (taps about a pixel apart, each
  // weighted by its colour), so a small spark smears into a short rainbow rather than splitting
  // into three coloured dots.
  let dPx = length(d) * 720.0 * 0.2;
  let n = i32(clamp(ceil(dPx * L.res.y / 720.0) + 1.0, 3.0, 24.0));
  var acc = vec3f(0.0);
  var ws = vec3f(0.0);
  for (var i = 0; i < 24; i++) {
    if (i >= n) { break; }
    let t = (f32(i) + 0.5) / f32(n);
    let w = clamp(vec3f(1.0 - abs(t * 2.0), 1.0 - abs(t * 2.0 - 1.0), 1.0 - abs(t * 2.0 - 2.0)), vec3f(0.02), vec3f(1.0));
    acc += srcMirror(lsd_uv(p + d * (1.1 - 0.2 * t))) * w;
    ws += w;
  }
  return lsd_out(base, acc / ws);
}
`,
});
