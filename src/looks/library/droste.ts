import { defineLook } from '../types';
import { COMMIT_WGSL, OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * Escher print-gallery recursion: a conformal log-polar Droste spiral that folds the
 * image into itself and zooms forever, a little faster with the eased energy. Genes: arms, scale ratio, twist
 * (strands and handedness), seam style.
 */
export default defineLook({
  meta: { id: 'droste',
    remaps: true, overlay: true, name: 'Droste Spiral', weight: 0.4, energy: [0.25, 1], amount: [0.85, 1], genres: { ambient: 0.7, techno: 0.7, edm: 0.6, classical: 0.3 } },
  params(ctx, p) {
    const d = ctx.dna;
    const arms = [0, 1, 1, 2, -1, -2][Math.min(5, Math.floor(d[0] * 6))];
    // Scale ratio per level: kept modest, since the outer level is magnified by up to sqrt(S).
    const S = 2.0 + d[1] * 1.4;
    const lS = Math.log(S);
    const ti = Math.min(5, Math.floor(d[2] * 6));
    const strands = [1, 1, 2, 1, 2, 3][ti];
    const twist = ti % 2 ? -1 : 1;
    const v = drive.update(ctx);
    const t = v.flow;
    p[0] = lS;
    p[1] = (arms * lS) / (2 * Math.PI);
    p[2] = strands;
    p[3] = arms === 0 ? 0.22 : 0.14;
    p[4] = 0.05 * Math.sin(t * 0.11) + 0.02 * Math.sin(t * 0.29 + 1.3);
    p[5] = 0.035 * Math.sin(t * 0.13 + 2.1);
    p[6] = twist;
    // Source disc radius: sized so a screen corner (radius ~1) sees the world between 1/sqrt(S) and
    // sqrt(S) of its own size through the zoom cycle, instead of blown up several times (capped so
    // the disc never reaches far past the frame, where it would only show mirrored copies).
    p[7] = Math.min(1.15, Math.sqrt(S) / Math.hypot(strands, p[1]));
    p[8] = Math.floor(d[3] * 3);
    p[9] = t * (arms === 0 ? 0.07 : 0.05);
    p[10] = t * 0.02;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `${COMMIT_WGSL}
/** One level of the spiral: log radius t, angle ang. fp is the source footprint of one output pixel;
 * deep levels (many source pixels per output pixel) read the smooth mip chain so they never sparkle. */
fn dr_at(t: f32, ang: f32, ctr: vec2f, asp: f32, fp: f32) -> vec3f {
  let z = exp(t) * vec2f(cos(ang), sin(ang));
  // Mirror-wrapped by hand, so the soft path folds at the frame edge too instead of smearing it.
  let w = z / vec2f(asp, 1.0) + ctr;
  let suv = abs(w - 2.0 * floor(w * 0.5 + 0.5));
  let sharp = src(suv);
  let k = smoothstep(1.3, 3.0, fp);
  if (k <= 0.0) { return sharp; }
  return mix(sharp, srcSoft(suv, fp), k);
}

fn dr_look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let ctr = vec2f(0.5) + L.p[1].xy;
  let q = (uv - ctr) * vec2f(asp, 1.0);
  let r = max(length(q), 1e-5);
  let lr = log(r);
  let th = atan2(q.y, q.x);
  let lS = L.p[0].x;
  let k = L.p[0].y;
  let m = L.p[0].z;
  // Conformal spiral W = w * (m - i k): one turn advances arms whole levels.
  var W = vec2f(m * lr + k * th, m * th - k * lr);
  W.x -= L.p[2].y * lS;
  W.y += L.p[1].z * L.p[2].z;
  let s = fract(W.x / lS);
  let t0 = log(L.p[1].w) + (s - 1.0) * lS;
  // Source pixels per output pixel at this level (the map's local scale).
  let gain = sqrt(m * m + k * k) / r;
  let fp = exp(t0) * gain;
  let a = dr_at(t0, W.y, ctr, asp, fp);
  // Every seam style crosses into the next level softly, so no level ever shows a hard rim.
  let b = dr_at(t0 - lS, W.y, ctr, asp, fp * exp(-lS));
  let blend = smoothstep(0.82, 1.0, s);
  let c = mix(a, b, blend);
  let mode = L.p[2].x;
  if (mode < 0.5) { return c; }
  // Distance (in level units) to the rim where one level hands over to the next.
  let e = min(s, 1.0 - s);
  if (mode < 1.5) {
    // Depth: each level is gently shaded toward its rim, like the mouth of a tunnel ring.
    let shade = 0.72 + 0.28 * smoothstep(0.0, 0.3, e);
    return c * shade;
  }
  // A soft palette glow along the rim, a little warmer with the eased energy (added, never a line).
  let glow = exp(-e * e / 0.006) * (0.12 + 0.1 * L.p[3].y);
  return c + palAt(s * 0.25 + W.y / TAU + L.p[3].x * 0.02) * glow * (0.4 + luma(c));
}

fn look(uv: vec2f, frag: vec2f) -> vec3f { return ov_commit(src(uv), dr_look(uv, frag)); }
`,
});
