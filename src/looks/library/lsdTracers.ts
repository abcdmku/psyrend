import { defineLook } from '../types';
import { Groove, LSD_WGSL } from './lsdCommon';

const groove = new Groove();

/**
 * LSD "tracers": bright forms leave a fading trail behind them along a slowly curving flow (or the
 * tunnel's radial flow), like stroboscopic long exposure: the trail is continuous, and its echoes are
 * hue steps along it that stream outward. The trail is composited with a soft lighten, so they only show where they are brighter than what is there and
 * darks stay real. Energy lengthens the trail; the pads widen the hue spread; the highs make the
 * trail finer and denser.
 * dna0 = trail direction (curl flow vs radial), dna1 = trail length, dna2 = hue step, dna3 = persistence.
 */
export default defineLook({
  meta: {
    id: 'lsd-tracers',
    name: 'LSD Tracers',
    weight: 0.7,
    energy: [0.1, 1],
    amount: [0.85, 1],
    overlay: true,
    genres: { edm: 0.9, techno: 0.9, dubstep: 0.8, synthwave: 0.8, ambient: 0.6 },
  },
  params(ctx, p) {
    groove.update(ctx, p);
    const d = ctx.dna;
    p[8] = d[0];
    p[9] = 20 + 12 * d[1];
    p[10] = 0.35 + 0.3 * d[2];
    p[11] = 0.72 + 0.1 * d[3];
  },
  wgsl: /* wgsl */ `
${LSD_WGSL}
/** Mirror-repeat a uv into [0, 1], so trails reaching past the frame read the image back. */
fn tr_mirror(u: vec2f) -> vec2f { return 1.0 - abs(1.0 - fract(u * 0.5) * 2.0); }
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let p = lsd_p(uv);
  let base = src(uv);
  let e = lsd_energy();
  let det = lsd_detail();
  // Trail direction: a slow curl flow, a radial (tunnel) flow, or a blend.
  let v = lsd_curl(p, lsd_flow() * 0.05, 1.2);
  let curl = v / (length(v) + 0.5);
  let radial = p / (length(p) + 0.08);
  let dir = mix(curl, radial, smoothstep(0.35, 0.65, L.p[2].x));
  // Spacing in px at 720p: longer with energy, tighter with busy highs (finer echoes).
  let rs = L.res.y / 720.0;
  let gap = L.p[2].y * rs * (0.55 + 0.6 * e) * (1.0 - 0.3 * det) / L.res.y;
  let hueStep = L.p[2].z * (0.7 + 0.6 * lsd_backing());
  let drift = lsd_flow() * 0.08;
  // The trail is gathered continuously (a tap every pixel or two, each read from the image blurred
  // over about one tap spacing), so a small spark draws a smooth fading comet, never a row of dots.
  // The echoes are steps in hue rather than separate copies: the hue holds, then turns quickly to
  // the next echo's, and the steps stream outward with the flow clock.
  let N = 56;
  let s0 = 0.15;
  let s1 = 4.4;
  let gapPx = gap * 720.0;
  let stepPx = (s1 - s0) * gapPx / f32(N);
  let shift = fract(lsd_flow() * 0.15);
  var trail = vec3f(0.0);
  for (var i = 0; i < N; i++) {
    let s = mix(s0, s1, (f32(i) + 0.5) / f32(N));
    // Echoes bend slightly as they recede, so trails curve rather than run in a line.
    let bend = vec2f(-dir.y, dir.x) * sin(s * 0.6 + drift * 3.0) * 0.18;
    let q = p - (dir + bend) * gap * s;
    let sk = s - shift;
    let echo = floor(sk) + smoothstep(0.3, 0.7, fract(sk)) + shift;
    let w = pow(L.p[2].w, s) * smoothstep(s1, s1 - 1.2, s) * smoothstep(s0 - 0.1, s0 + 0.45, s);
    let c = lsd_vivid(lsd_hue(srcSoft(tr_mirror(lsd_uv(q)), stepPx + s * 0.4), hueStep * echo + sin(drift) * 0.5), 1.35) * w;
    trail = max(trail, c);
  }
  // Soft lighten: the trail shows only where it outshines the current pixel, so darks stay real.
  return base + max(trail - base * 1.15, vec3f(0.0)) * 0.9;
}
`,
});
