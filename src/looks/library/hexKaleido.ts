import { defineLook } from '../types';
import { OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * A lattice kaleidoscope: every hex cell folds a small wedge of the image through p6m, p3m1
 * (three-mirror toy) or p6 (pinwheel) symmetry, the wedge turns on a step each bar (eased over
 * about a beat) and the tiling origin drifts. Genes: lattice and orientation, cell scale, rotation speed, wedge source.
 */
export default defineLook({
  meta: { id: 'hex-kaleido',
    remaps: true, name: 'Hex Kaleidoscope', weight: 0.4, energy: [0.3, 1], amount: [0.6, 0.9], genres: { techno: 0.8, edm: 0.7, ambient: 0.5 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    const t = v.flow;
    const li = Math.floor(d[0] * 6);
    p[0] = li % 3;
    p[1] = li >= 3 ? Math.PI / 6 : 0;
    p[2] = 1.3 + 3.4 * d[1];
    const dir = d[2] * 7 - Math.floor(d[2] * 7) > 0.5 ? 1 : -1;
    p[3] = dir * (0.04 + 0.22 * d[2]);
    // Turn the wedge a fixed step each bar, eased (a lasting change, never a ratchet).
    const stepA = d[2] > 0.5 ? (Math.PI / 6) * dir : 0;
    p[4] = (v.bars % 48) * stepA;
    p[5] = Math.floor(d[3] * 3);
    p[6] = 0.5 + 0.22 * Math.sin(t * 0.083) + 0.08 * Math.sin(t * 0.21);
    p[7] = 0.5 + 0.18 * Math.sin(t * 0.067 + 2.0);
    p[8] = t * 0.25;
    p[9] = t * 0.02;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `
fn hk_hex(p: vec2f) -> vec4f {
  let s = vec2f(1.0, 1.7320508);
  let h = s * 0.5;
  let a = p - s * floor(p / s) - h;
  let b = (p - h) - s * floor((p - h) / s) - h;
  return select(vec4f(b, p - b), vec4f(a, p - a), dot(a, a) < dot(b, b));
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let lat = L.p[0].x;
  let n = L.p[0].z;
  let rate = L.p[0].w;
  let srcMode = L.p[1].y;
  var q = (uv - 0.5) * vec2f(asp, 1.0);
  q = rot2(L.p[0].y + L.p[2].x * rate * 0.5) * q * n;
  q += vec2f(0.31, 0.17) * L.p[2].y;
  let h = hk_hex(q);
  let c = h.xy;
  let cell = h.zw;
  let r = length(c);
  var a = atan2(c.y, c.x);
  var x: f32;
  if (lat < 0.5) {
    let P = PI / 3.0;
    x = abs(a - P * floor(a / P) - P * 0.5);
  } else if (lat < 1.5) {
    let P = 2.0 * PI / 3.0;
    let a3 = a - PI / 6.0;
    x = abs(a3 - P * floor(a3 / P) - P * 0.5);
  } else {
    let P = PI / 3.0;
    x = a - P * floor(a / P);
  }
  let wa = L.p[1].x + L.p[2].x * rate * 1.6;
  var wc = L.p[1].zw;
  var ws = 0.68;
  if (srcMode > 0.5 && srcMode < 1.5) {
    wc = vec2f(0.5);
    ws = 0.42 + 0.15 * sin(L.p[3].x * 0.3);
  }
  if (srcMode > 1.5) {
    wc += (hash22(cell + 3.7) - 0.5) * 0.35;
  }
  let lp = rot2(wa) * vec2f(cos(x), sin(x)) * r * ws;
  var col = srcMirror(wc + lp / vec2f(asp, 1.0));
  // Prism seams: the mirror joins catch light, a little warmer with the eased energy.
  let edge = 0.5 - max(abs(c.x), dot(abs(c), vec2f(0.5, 0.8660254)));
  let seam = exp(-edge * 60.0 * n / 3.0);
  let spoke = select(exp(-abs(sin(x)) * r * 90.0), 0.0, lat > 1.5);
  let glow = (seam * 0.6 + spoke * 0.25) * (0.14 + 0.12 * L.p[3].y);
  col = col * (1.0 - 0.25 * seam) + palAt(r * 0.8 + L.p[3].x * 0.03 + hash12(cell) * 0.2) * glow * (0.4 + luma(col));
  return col;
}
`,
});
