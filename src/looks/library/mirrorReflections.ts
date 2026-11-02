import { defineLook } from '../types';
import { COMMIT_WGSL, OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * A glossy mirror surface reflecting the world: a still floor of dark water, a mirror wall at the
 * side or a tilted plane, with soft perspective ripples that fade out before they could shimmer,
 * fresnel falloff, a reflection that softens toward the viewer and dark palette-tinted water.
 * Music, always eased: bass raises the ripples, energy sets how fast they run, the melody pitch
 * leans the horizon a little, and each kick moves the swell on for good.
 * Genes: plane (floor, wall, tilted, floor and ceiling), level, ripple scale, gloss.
 */
export default defineLook({
  meta: { id: 'mirror-reflections', name: 'Mirror Reflections', weight: 0.7, energy: [0, 1], amount: [0.85, 1], overlay: true, remaps: true,
    genres: { ambient: 1, techno: 0.8, edm: 0.8, synthwave: 1, classical: 0.7 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    const mode = Math.floor(d[0] * 4);
    p[0] = mode;
    // Where the surface meets the image (0..1 from the top, or from the left for the wall).
    const lvl = mode === 1 ? 0.62 + 0.12 * d[1] : 0.56 + 0.14 * d[1];
    p[1] = lvl + 0.015 * Math.sin(v.flow * 0.05);
    // Lean: a slow drift, plus the eased melody pitch; the tilted plane leans further.
    const lean = mode === 2 ? (d[1] < 0.5 ? -1 : 1) * (0.09 + 0.03 * Math.sin(v.flow * 0.04)) : 0;
    p[2] = lean + 0.03 * v.pitch * v.melody + 0.01 * Math.sin(v.flow * 0.07);
    p[3] = 0.7 + 0.4 * d[2];
    p[4] = 0.5 + 0.4 * d[3];
    p[5] = v.kicks * 0.6;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `${COMMIT_WGSL}
/** One travelling wave on the plane: adds its slope (dX, dZ) to g, faded out where it would alias. */
fn mr_wave(g: ptr<function, vec2f>, X: f32, Z: f32, fx: f32, fz: f32, c: f32, ph: f32, x: f32, dZ: f32, px: f32, ampZ: f32) {
  // Phase change per output pixel (dX/dx = Z, dX/ds = x dZ/ds, dZ/ds); past ~1 rad it would shimmer.
  let rate = px * length(vec2f(fx * Z, (fx * x + fz) * dZ));
  // And how fast this wave alone would move the reflection per pixel: kept well under one pixel per
  // pixel, so the reflected image bends but never tears into steps.
  let fold = c * length(vec2f(fx, fz)) * ampZ * rate / px;
  let att = (1.0 - smoothstep(0.35, 1.1, rate)) * min(1.0, 0.3 / max(fold, 1e-5));
  let cs = cos(fx * X + fz * Z + ph) * c * att;
  *g += vec2f(fx, fz) * cs;
}

// One mirror line: point, inward normal and tangent. Returns (reflected uv, fresnel weight, depth s).
fn mr_plane(uv: vec2f, asp: f32, P: vec2f, N: vec2f, flow: f32, px: f32) -> vec4f {
  let q = uv * vec2f(asp, 1.0);
  let s = dot(q - P, N);
  if (s <= 0.0) { return vec4f(uv, 0.0, s); }
  let T = vec2f(-N.y, N.x);
  let x = dot(q - P, T);
  // Plane coordinates in perspective: rows near the line are far away.
  let Z = 0.3 / (s + 0.035);
  let dZ = -Z * Z / 0.3;
  let X = x * Z;
  let t = flow * 1.2;
  let sc = L.p[0].w;
  let k = L.p[1].y;
  let amp = (0.6 + 0.8 * L.p[3].z) * 0.0034;
  let ampZ = amp / Z;
  var g = vec2f(0.0);
  mr_wave(&g, X, Z, 0.0, 7.0 * sc, 0.5, -t * 1.1 + k, x, dZ, px, ampZ);
  mr_wave(&g, X, Z, 2.6 * sc, 11.0 * sc, 0.28, -t * 1.6 + k * 0.7, x, dZ, px, ampZ);
  mr_wave(&g, X, Z, -3.4 * sc, 15.0 * sc, 0.16, -t * 2.0 + 1.3, x, dZ, px, ampZ);
  mr_wave(&g, X, Z, 1.5, 3.0, 0.3, -t * 0.5 + 0.4, x, dZ, px, ampZ);
  // Ripples shift the reflection mostly along the normal (long vertical glints), more up close.
  let d = (T * g.x * 0.35 + N * g.y) * ampZ;
  let r = q - 2.0 * s * N + d;
  let fres = mix(0.9, 0.55, smoothstep(0.0, 0.45, s));
  return vec4f(r / vec2f(asp, 1.0), fres, s);
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let mode = L.p[0].x;
  let flow = L.p[3].x;
  let lvl = L.p[0].y;
  let lean = L.p[0].z;
  let base = src(uv);
  let px = 1.0 / L.res.y;
  var P = vec2f(0.5 * asp, lvl);
  var N = vec2f(-sin(lean), cos(lean));
  if (mode > 0.5 && mode < 1.5) {
    P = vec2f(lvl * asp, 0.5);
    N = vec2f(cos(lean), sin(lean));
  }
  var m = mr_plane(uv, asp, P, N, flow, px);
  if (mode > 2.5 && m.z <= 0.0) {
    // Floor and ceiling: a second, shallower mirror along the top.
    N = vec2f(sin(lean), -cos(lean));
    m = mr_plane(uv, asp, vec2f(0.5 * asp, (1.0 - lvl) * 0.72), N, flow * 0.9, px);
  }
  let s = m.w;
  if (s <= -2.0 * px) { return base; }
  let ss = max(s, 0.0);
  // The reflection: sharp at the far line, softening smoothly toward the viewer like real water.
  let sharp = srcMirror(m.xy);
  let soft = srcSoft(clamp(m.xy, vec2f(0.0), vec2f(1.0)), 2.0 + 12.0 * smoothstep(0.02, 0.5, ss));
  let refl = mix(sharp, soft, 0.6 * smoothstep(0.0, 0.3, ss));
  let gloss = L.p[1].x;
  // Dark water under the reflection, tinted by the palette's deepest colour.
  let deep = palRamp(0.05) * 0.06;
  var o = refl * m.z * (0.8 + 0.25 * gloss) + deep * (1.0 - m.z);
  o = max(mix(vec3f(luma(o)), o, 1.06), vec3f(0.0));
  // A soft contact shade just below the line, so the surface reads as a plane, never as a drawn line.
  o *= 1.0 - 0.18 * exp(-ss / 0.02) * smoothstep(0.0, 3.0 * px, ss);
  let mask = smoothstep(-px, px, s);
  return ov_commit(base, mix(base, o, mask));
}
`,
});
