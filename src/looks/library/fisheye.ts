import { defineLook } from '../types';
import { OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Lens projections: barrel fisheye, pincushion, tiny planet, inside-out planet, cylindrical
 * panorama and a roaming magnifier bubble, bulging slowly with the eased energy. Genes: projection, strength,
 * centre path, lens character (clean, chromatic, vintage).
 */
export default defineLook({
  meta: { id: 'fisheye',
    remaps: true, name: 'Lens Warp', weight: 0.6, energy: [0.15, 1], amount: [0.7, 1] },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    const t = v.flow;
    p[0] = Math.floor(d[0] * 6);
    p[1] = 0.35 + 0.65 * d[1];
    const path = Math.floor(d[2] * 4);
    let cx = 0;
    let cy = 0;
    if (path === 1) {
      cx = 0.18 * Math.sin(t * 0.21) + 0.05 * Math.sin(t * 0.53);
      cy = 0.12 * Math.sin(t * 0.17 + 1.1);
    } else if (path === 2) {
      cx = 0.2 * Math.cos(t * 0.31);
      cy = 0.13 * Math.sin(t * 0.31);
    } else if (path === 3) {
      // Glide to a new focus each bar (the eased bar count, so about a beat per move).
      const b = Math.floor(v.bars) + 1;
      const k = v.bars - Math.floor(v.bars);
      const hx = (i: number) => (hash(i) - 0.5) * 0.4;
      const hy = (i: number) => (hash(i + 71.3) - 0.5) * 0.26;
      cx = hx(b - 1) + (hx(b) - hx(b - 1)) * k;
      cy = hy(b - 1) + (hy(b) - hy(b - 1)) * k;
    }
    p[2] = cx;
    p[3] = cy;
    p[4] = Math.floor(d[3] * 3);
    p[5] = d[2] > 0.5 ? 1 : -1;
    // Whole mirror periods around the planet keep the wrap seamless.
    p[6] = d[1] > 0.6 ? 2 : 1;
    p[7] = t * 0.1;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `
fn fe_map(q0: vec2f, mode: f32, s: f32, asp: f32, ctr: vec2f) -> vec2f {
  let r = length(q0);
  let dir = q0 / max(r, 1e-5);
  if (mode < 0.5) {
    // Barrel fisheye: magnified centre, compressed rim.
    let R = 0.5 * sqrt(asp * asp + 1.0);
    let a = 0.15 + 1.15 * s;
    let rs = R * tan(r / R * a) / tan(a);
    return ctr + dir * rs / vec2f(asp, 1.0);
  }
  if (mode < 1.5) {
    // Pincushion: the centre recedes, the rim stretches toward you.
    let R = 0.5 * sqrt(asp * asp + 1.0);
    let a = 0.2 + 1.2 * s;
    let rs = R * sin(min(r / R, 1.3) * a) / sin(a);
    return ctr + dir * rs / vec2f(asp, 1.0);
  }
  if (mode < 3.5) {
    // Tiny planet (ground at the core) or its inside-out twin (sky at the core).
    let th = atan2(q0.x, q0.y);
    let u = th / PI * L.p[1].z + L.p[1].w * 0.08 * L.p[1].y;
    let rho = pow(r / (0.55 + 0.35 * (1.0 - s)), 0.85);
    let v = select(1.0 - rho, rho, mode > 2.5);
    return vec2f(0.5 + u, v);
  }
  if (mode < 4.5) {
    // Cylindrical panorama: bend horizontally, bow the horizon.
    let hx = 0.5 * asp;
    let a = 0.2 + 1.1 * s;
    let xs = hx * tan(q0.x / hx * a) / tan(a);
    let ys = q0.y * (1.0 + 0.35 * s * (q0.x / hx) * (q0.x / hx));
    return ctr + vec2f(xs, ys) / vec2f(asp, 1.0);
  }
  // Roaming magnifier bubble.
  let R = 0.22 + 0.16 * s;
  let x = r / R;
  if (x >= 1.0) { return ctr + q0 / vec2f(asp, 1.0); }
  let mag = mix(1.0, 0.45, s) * (0.6 + 0.4 * x);
  return ctr + dir * r * mag / vec2f(asp, 1.0);
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let mode = L.p[0].x;
  let ctr = vec2f(0.5) + L.p[0].zw;
  let q = (uv - ctr) * vec2f(asp, 1.0);
  let s = clamp(L.p[0].y * (0.9 + 0.2 * L.p[3].y), 0.05, 1.0);
  let lens = L.p[1].x;
  let ca = select(0.0, 0.012 + 0.006 * L.p[3].y, lens > 0.5);
  let r = length(q);
  let wr = fe_map(q, mode, s, asp, ctr);
  var col: vec3f;
  if (ca > 0.0) {
    let wg = fe_map(q * (1.0 - ca), mode, s, asp, ctr);
    let wb = fe_map(q * (1.0 - 2.0 * ca), mode, s, asp, ctr);
    col = vec3f(srcMirror(wr).r, srcMirror(wg).g, srcMirror(wb).b);
  } else {
    col = srcMirror(wr);
  }
  if (mode > 4.5) {
    // Glass rim on the bubble.
    let R = 0.22 + 0.16 * s;
    let x = r / R;
    let rim = exp(-pow((x - 0.97) / 0.035, 2.0));
    col = col * (1.0 - 0.35 * smoothstep(0.85, 1.0, x) * step(x, 1.0)) + palAt(0.75 + L.p[3].x * 0.02) * rim * (0.15 + 0.1 * L.p[3].y);
  }
  if (lens > 1.5) {
    // Vintage glass: vignette and a warm palette bloom at the rim.
    let v = smoothstep(1.1, 0.35, length((uv - 0.5) * vec2f(asp, 1.0)) / (0.5 * asp));
    col = col * mix(0.55, 1.05, v) + L.pal3.rgb * (1.0 - v) * 0.04;
  }
  return col;
}
`,
});
