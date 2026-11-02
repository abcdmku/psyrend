import { defineLook } from '../types';
import { COMMIT_WGSL, OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * A true mirror kaleidoscope: the frame is cut into an even number of wedges and every other wedge
 * is the mirror image of its neighbour, so all wedges meet edge to edge with no seam, no line and
 * no gap. A gentle logarithmic twist curls the wedges into a slow spiral, and optional secondary
 * mirrors fold the wedge again for a richer lattice. Every fold is an isometry, so the world is
 * never magnified.
 * Music, always eased: the wheel turns slowly with the flow and each bar carries it on by a
 * fraction of a wedge (eased over about a beat), the source view drifts so the wedges keep finding
 * new parts of the world, and bass slowly opens the zoom.
 * Genes: wedge count, twist, secondary folds, turning direction.
 */
export default defineLook({
  meta: { id: 'kaleido-slices', name: 'Kaleido Slices', weight: 0.65, energy: [0.15, 1], amount: [0.85, 1], overlay: true, remaps: true,
    genres: { techno: 0.9, edm: 0.9, dubstep: 0.7, ambient: 0.6, synthwave: 0.8 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    // Mirror pairs: the wedge count is always even, so the last wedge meets the first seamlessly.
    const n = 2 * [4, 6, 7, 8, 9][Math.min(4, Math.floor(d[0] * 5))];
    const dir = d[3] < 0.5 ? 1 : -1;
    const W = (Math.PI * 2) / n;
    p[0] = n;
    // Twist: none at the low end of the gene, a slow spiral either way above it.
    p[1] = d[1] < 0.3 ? 0 : (d[1] < 0.65 ? 1 : -1) * (0.25 + 0.3 * Math.abs(d[1] - 0.65) / 0.35);
    // Secondary mirror folds inside the wedge (0, 1 or 2): richer lattices, still seamless.
    p[2] = d[2] < 0.35 ? 0 : d[2] < 0.7 ? 1 : 2;
    // Turn: a slow drift with the flow plus a fifth of a wedge per bar, eased.
    p[3] = dir * (v.flow * 0.03 + v.bars * W * 0.2);
    // Output centre wanders slowly near the middle.
    p[4] = 0.5 + 0.04 * Math.sin(v.flow * 0.043) + 0.015 * Math.sin(v.flow * 0.11 + 1.0);
    p[5] = 0.5 + 0.03 * Math.sin(v.flow * 0.037 + 2.0);
    // The source view turns and drifts, so the wedges keep finding new parts of the world.
    p[6] = -dir * v.flow * 0.025;
    p[7] = 0.8 + 0.12 * Math.sin(v.flow * 0.03) + 0.12 * v.bass;
    p[8] = 0.5 + 0.12 * Math.sin(v.flow * 0.021 + 0.7);
    p[9] = 0.5 + 0.1 * Math.sin(v.flow * 0.017 + 2.4);
    // Secondary fold: offset and angle drift slowly.
    p[10] = 0.16 + 0.05 * Math.sin(v.flow * 0.05 + 0.3);
    p[11] = 0.5 + v.flow * 0.012 * dir;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `${COMMIT_WGSL}
/** Mirror repeat: 0..1..0 with period 2, continuous everywhere. */
fn ks_tri(x: f32) -> f32 { return abs(x - 2.0 * floor(x * 0.5 + 0.5)); }
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let n = L.p[0].x;
  let W = TAU / n;
  let tw = L.p[0].y;
  let P = L.p[0].z;
  let ctr = L.p[1].xy;
  let q = (uv - ctr) * vec2f(asp, 1.0);
  let r = length(q);
  // Angle with the turn and a logarithmic twist (bounded at the centre so it never spins to moire).
  let a = atan2(q.y, q.x) - L.p[0].w + tw * log(r + 0.06);
  let f = ks_tri(a / W);
  let sa = f * W + L.p[1].z;
  var sp = vec2f(cos(sa), sin(sa)) * r * L.p[1].w;
  // Secondary mirrors: each is a fold of the plane (an isometry piece by piece), so it adds axes
  // without magnifying the source or opening a seam.
  for (var i = 0; i < 2; i++) {
    if (f32(i) < P) {
      sp = rot2(L.p[2].w + f32(i) * 1.1) * sp;
      sp.x = abs(sp.x) - L.p[2].z * (1.0 - 0.35 * f32(i));
    }
  }
  // The source centre leans toward where the world is lit (a luma-weighted centroid of a coarse,
  // heavily blurred grid), so the wedges gather the light instead of empty space. The same for
  // every pixel, and as smooth in time as the world itself.
  var acc = vec3f(0.0);
  for (var j = 0; j < 3; j++) {
    for (var i = 0; i < 5; i++) {
      let g = vec2f((f32(i) + 0.5) / 5.0, (f32(j) + 0.5) / 3.0);
      let y = luma(srcSoft(g, 90.0));
      let wgt = y * y + 1e-4;
      acc += vec3f(g * wgt, wgt);
    }
  }
  let lit = clamp(acc.xy / acc.z, vec2f(0.3), vec2f(0.7));
  // Held a little off the light itself, so a hotspot becomes a ring of copies, never one lone orb
  // at the centre.
  let sc = mix(L.p[2].xy, lit, 0.65) + 0.09 * vec2f(cos(L.p[2].w * 1.7), sin(L.p[2].w * 1.7)) / vec2f(asp, 1.0);
  let col = srcMirror(sc + sp / vec2f(asp, 1.0));
  return ov_commit(src(uv), col);
}
`,
});
