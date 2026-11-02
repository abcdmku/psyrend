import { defineLook } from '../types';
import { Groove, LSD_OUT_WGSL, LSD_WGSL } from './lsdCommon';

const groove = new Groove();

/**
 * LSD "symmetrical texture repetition": patches of the image snap into a small mirror wallpaper,
 * the way a tripping visual system tiles a surface into the nearest symmetric pattern. Inside each
 * soft patch the small piece of texture at its centre is kept as it is and repeated outward as
 * mirrored copies (rectangular mirrors, or square mirrors with diagonals), so a patch reads as a
 * woven, repeating texture, never as one big mirrored shape. The fold is applied to the sampling
 * coordinate, eased per patch (never a cross-fade, so nothing double-exposes), and fades to nothing
 * at the patch border. The fold blooms outward from the patch centre and recedes again; patches catch and release the symmetry slowly; more of them fold as the
 * energy rises, and each phrase reshuffles which ones.
 * dna0 = patch size, dna1 = wallpaper kinds, dna2 = coverage, dna3 = drift speed.
 */
export default defineLook({
  meta: {
    id: 'lsd-symmetry',
    name: 'LSD Symmetry',
    weight: 0.6,
    energy: [0.1, 1],
    amount: [0.85, 1],
    remaps: true,
    overlay: true,
    genres: { techno: 0.8, edm: 0.8, ambient: 0.8, synthwave: 0.7, dubstep: 0.6 },
  },
  params(ctx, p) {
    groove.update(ctx, p);
    const d = ctx.dna;
    p[8] = 0.6 + 0.3 * d[0];
    p[9] = d[1];
    p[10] = 0.8 + 0.15 * d[2];
    p[11] = 0.5 + d[3];
  },
  wgsl: /* wgsl */ `
${LSD_WGSL}
${LSD_OUT_WGSL}
/** Nearest hex-cell centre (pointy-top lattice of unit spacing) and the offset to it. */
fn sy_hex(p: vec2f) -> vec4f {
  let s = vec2f(1.0, 1.7320508);
  let h = s * 0.5;
  let a = p - s * floor(p / s) - h;
  let b = (p - h) - s * floor((p - h) / s) - h;
  let pick = dot(a, a) < dot(b, b);
  let off = select(b, a, pick);
  return vec4f(off, p - off);
}
/** Mirror repeat (0..1..0, period 2) with the creases rounded, so folded lines bend instead of kinking. */
fn sy_tri(x: f32) -> f32 { return 0.5 - asin(0.985 * cos(PI * x)) / PI; }
/** Mirror wallpaper of tile size ts around the origin; the central tile is (nearly) the identity. */
fn sy_wall(q: vec2f, ts: f32, diag: bool) -> vec2f {
  var u = vec2f(sy_tri(q.x / ts + 0.5), sy_tri(q.y / ts + 0.5)) - 0.5;
  if (diag) {
    // Square mirrors with diagonals (p4m): fold across the diagonal too, softly.
    let dd = u.y - u.x;
    let sd = sqrt(dd * dd + 0.0004);
    let m = 0.5 * (u.x + u.y);
    u = vec2f(m - 0.5 * sd, m + 0.5 * sd);
  }
  return u * ts;
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let p = lsd_p(uv);
  let base = src(uv);
  let e = lsd_energy();
  let size = L.p[2].x;
  let t = lsd_flow() * 0.04 * L.p[2].w;
  // The patch lattice drifts and turns very slowly.
  let pp = rot2(0.3 + t * 0.4) * p / size + vec2f(t, t * 0.6);
  let h = sy_hex(pp);
  let q = h.xy;
  let id = h.zw;
  let rnd = hash22(id * 1.37 + 3.1);
  // Wallpaper per patch: rectangular mirrors or square mirrors with diagonals, tile size varies.
  let kind = fract(rnd.x * 3.7 + L.p[2].y);
  let diag = kind > 0.55;
  let ts = mix(0.17, 0.27, fract(rnd.y * 5.3 + L.p[2].y * 0.7)) * (1.0 + 0.06 * sin(t * 3.0 + rnd.x * TAU));
  // Activation: a slow wave per patch; energy and coverage widen it; each phrase reshuffles.
  let wave = 0.5 + 0.5 * sin(rnd.y * TAU + lsd_flow() * 0.11 + lsd_phrase() * 2.3 + dot(id, vec2f(0.7, 1.1)));
  let cover = L.p[2].z * (0.7 + 0.5 * e);
  let act = smoothstep(1.0 - cover, 1.0 - cover + 0.25, wave);
  // Hex distance (0 centre, 1 edge) for the soft border, made wavy so patches read as organic shapes.
  let aq = abs(q);
  let ang = atan2(q.y, q.x);
  let wob = 0.12 * sin(ang * 3.0 + rnd.y * TAU + t * 3.0) + 0.08 * sin(ang * 5.0 - rnd.x * TAU);
  let hraw = max(aq.x, dot(aq, vec2f(0.5, 0.8660254))) / 0.5;
  let hd = hraw + wob;
  // The raw-distance factor keeps the mask exactly 0 at the true cell border, so patches join seamlessly.
  // The symmetry blooms outward from the patch centre as it activates: fully folded inside its
  // front, with only a narrow eased band at the front, so the pattern stays legible instead of smeared.
  let front = act * 0.86;
  // A linear ramp (lower peak slope than a smoothstep) keeps the stretch across the front small.
  let w = sat((front - hd) / 0.36) * (1.0 - smoothstep(0.88, 1.0, hraw)) * L.amount;
  // Fold in the patch's own slowly turning frame so the mirror axes differ patch to patch.
  let fr = rot2(rnd.x * TAU + t * 1.5);
  let qf = transpose(fr) * sy_wall(fr * q, ts, diag);
  let qs = mix(q, qf, w);
  let ps = transpose(rot2(0.3 + t * 0.4)) * ((id + qs - vec2f(t, t * 0.6)) * size);
  let col = srcMirror(lsd_uv(ps));
  return lsd_out(base, col);
}
`,
});
