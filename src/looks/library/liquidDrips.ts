import { defineLook } from '../types';
import { COMMIT_WGSL, OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * The picture itself melts: from the top of the frame the world sags into viscous paint that runs
 * down in long tongues of varying width. Inside a run the image is stretched downward into soft
 * streaks; the picture just below and beside a run sags with it, so the paint and the world stay
 * one image. The rounded rim of each run is glossy, refracting the world like a lens of wet paint
 * and catching a soft highlight. Each run grows and recedes slowly on its own cycle; a receded run
 * comes back somewhere else.
 * Music, always eased: energy sets how fast the paint runs, bass lets the runs reach further, the
 * melody warms the gloss toward its pitch colour, each kick nudges the cycles on for good.
 * Genes: run width and count, viscosity (stretch and softness), refraction, gloss tint.
 */
export default defineLook({
  meta: { id: 'liquid-drips', name: 'Liquid Drips', weight: 0.8, energy: [0, 1], amount: [0.85, 1], overlay: true,
    genres: { ambient: 0.8, lofi: 0.9, dubstep: 0.8, edm: 0.7, techno: 0.6 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    // Run width scale, how many runs are out at once, reach.
    p[0] = 0.8 + 0.5 * d[0];
    p[1] = 0.55 + 0.35 * ((d[0] * 3.7) % 1);
    p[2] = 0.6 + 0.2 * v.bass;
    // Viscosity: how much of a run is stretched picture, and how soft the paint goes.
    p[3] = 0.55 + 0.3 * d[1];
    p[4] = 0.7 + 0.6 * d[2];
    p[5] = d[3];
    p[6] = v.kicks * 0.005;
    p[7] = v.pitch;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `${COMMIT_WGSL}
// The runs at q (screen-height units, y down from the top edge). Each run is a vertical capsule
// hanging from above the frame: near-parallel sides and a rounded, slightly fuller front; runs that
// meet merge with a soft web.
//   .x  signed distance to the paint (negative inside)
//   .y  how far the picture at q has sagged (screen-height units)
fn ld_paint(q: vec2f, t: f32) -> vec2f {
  var acc = 0.0;
  var sag = 0.0;
  let k = 0.03;
  let m = L.p[0].w;
  let span = L.res.x / L.res.y + 0.2;
  for (var i = 0; i < 12; i++) {
    let fi = f32(i);
    let rate = 0.02 + 0.016 * hash12(vec2f(fi, 3.1));
    let ph = t * rate + hash12(vec2f(fi, 9.7)) * 5.0 + L.p[1].z;
    let gen = floor(ph);
    let u = ph - gen;
    let h = hash22(vec2f(fi * 1.31 + 0.7, gen));
    let h2 = hash22(vec2f(gen + 4.2, fi * 0.77));
    if (h2.x > L.p[0].y) { continue; }
    // Slow swell out, a long hold, then a slow draw back (smooth at both ends of the cycle).
    let env = smoothstep(0.0, 0.5, u) * (1.0 - smoothstep(0.72, 1.0, u));
    let r = L.p[0].x * (0.035 + 0.09 * h.y * h.y);
    let len = L.p[0].z * (0.3 + 0.7 * h2.y) * env;
    let c = h.x * span - 0.1;
    // Sway the run a little as it falls, so its sides curve.
    let yy = clamp(q.y, -0.2, len - r);
    let cx = c + 0.025 * sin(yy * 2.6 + fi * 2.1) * sat(yy * 3.0);
    // A slightly fuller front, as viscous paint gathers where it runs.
    let rr = r * (1.0 + 0.15 * smoothstep(len - 4.0 * r, len - r, yy));
    let sd = length(q - vec2f(cx, yy)) - rr;
    acc += exp(-min(sd, 1.0) / k);
    // The picture sags with the run: stretched inside it (by m of its depth), pushed down just
    // below its front, dragged a little beside it.
    let ax = abs(q.x - cx) - rr;
    let side = 0.5 * (ax + sqrt(ax * ax + 1e-4)) / (0.6 * rr + 0.02);
    let below = max(q.y - len, 0.0);
    let sg = m * min(max(q.y, 0.0), len) * exp(-side * side) * exp(-below / (0.1 + 0.9 * m * len));
    sag += sg * sg * sg * sg;
  }
  if (acc <= 1e-20) { return vec2f(1.0, 0.0); }
  return vec2f(-k * log(acc), sqrt(sqrt(sag)));
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let t = L.p[3].x;
  let px = 1.0 / L.res.y;
  let q = vec2f(uv.x * asp, uv.y);
  let P = ld_paint(q, t);
  let sd = P.x;
  let wu = vec2f(uv.x, uv.y - P.y);
  let world = src(wu);
  if (sd > 3.0 * px) { return ov_commit(src(uv), world); }
  let e = 1.0 * px;
  let gd = vec2f(ld_paint(q + vec2f(e, 0.0), t).x - sd, ld_paint(q + vec2f(0.0, e), t).x - sd) / e;
  let d = -sd;
  // How far down the run: the paint softens as it goes.
  let a = sat(q.y / 0.6);
  // Thickness: a rounded meniscus at the rim.
  let w = 0.02;
  let T = 0.012 * L.p[1].x;
  let s = sat(d / w);
  let G = -gd * (T * 2.0 * (1.0 - s) / w);
  let n = normalize(vec3f(-G, 1.0));
  // The paint is the stretched picture, softened, with a lens offset at the rim and a little
  // dispersion.
  let lens = -G * 0.035 * L.p[1].x / vec2f(asp, 1.0);
  let su = wu + lens;
  let blur = 2.0 + 6.0 * a + 4.0 * L.p[0].w;
  let disp = -G * 0.006 / vec2f(asp, 1.0);
  var col = vec3f(srcSoft(su + disp, blur).r, srcSoft(su, blur).g, srcSoft(su - disp, blur).b);
  // Wet paint: a touch richer than the world it came from.
  col = max(mix(vec3f(luma(col)), col, 1.15), vec3f(0.0)) * 1.04;
  // Gloss: a soft, brightened reflection of the world on the shoulders and a highlight from the
  // upper left; never a dark rim.
  let fres = pow(1.0 - n.z, 1.3);
  let refl = srcSoft(uv + n.xy * 0.15 / vec2f(asp, 1.0), 16.0);
  col += refl * sat(fres * 2.0) * 0.3;
  let l = normalize(vec3f(-0.45, -0.6, 0.66));
  let rz = max(reflect(-l, n).z, 0.0);
  let spec = pow(rz, 50.0) * 0.75 + pow(rz, 6.0) * 0.05;
  var tint = vec3f(1.0);
  if (L.p[1].y > 0.4) {
    let pc = palAt(0.5 + 0.2 * L.p[1].w + L.p[1].y);
    tint = mix(vec3f(1.0), pc / max(luma(pc), 0.05), 0.35);
  }
  col += tint * spec * (0.8 + 0.3 * L.p[3].w);
  let mask = smoothstep(-1.0 * px, 1.0 * px, d);
  return ov_commit(src(uv), mix(world, col, mask));
}
`,
});
