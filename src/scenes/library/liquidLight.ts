import { compileModule } from '../../gpu/context';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { Morph, wave } from '../morph';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Liquid Light: glossy neon marbling on black. A GPU stable-fluids simulation (semi-Lagrangian
 * advection, vorticity confinement, Jacobi pressure projection) carries luminous inks that never mix
 * with the water, rendered as a glossy liquid in relief over a deep black floor: ink stands up in
 * domes and folds lit by a key light and a soft studio reflection, its edges catch rainbow glints,
 * its light pools into the water around it, and every pool casts a soft shadow onto the floor.
 *
 * A cue opens on a marbled bath already laid down (stones of nested ink and water rings, combed and
 * swirled, laid out by the DNA), and the liquid always flows: a slow turn of the pool and cellular
 * currents at several scales, their layout carried by the morph and their strength by `morph.flow`,
 * so the flow only eases down after a long quiet and never stops. The music's weight churns it: loud
 * passages and heavy bass (morph.drive) stir the currents harder, and a drop (morph.surge) churns
 * the whole bath for several bars. Every phrase carries the currents' layout and scale, the inks'
 * colours and the emitter's arc somewhere new (the morph's phrase jumps), so each phrase marbles a
 * different bath.
 *
 * The sound makes the ink: an emitter streams fresh ink into the bath at a rate set by the spectral
 * flux, its colour from the spectral centroid and the melody pitch, its size from the bass and its
 * brightness from the highs; the emitter sits on an arc at a point set by the pitch and is aimed by
 * the contour, and each melody note opens it fully.
 *
 * Beats never push the liquid back and forth; they set the ink alight. A burn field (an excitable
 * medium on a coarse grid, conducted only by ink) carries each ignition along the ink's own
 * filaments at a finite speed, branching where they branch and stopping at clear water: a hot edge
 * runs ahead, embers glow behind it, and the ink it has passed keeps a new colour for good.
 *  - kick: ignites the ink at a few points of a new place each time; a white-to-orange fire front
 *    burns out through the veins and leaves them in the kick's next colour;
 *  - snare: a stylus combs a line across the bath, folding every vein it crosses, and lights a fast
 *    electric front in a second colour along its path that races out through the filaments;
 *  - melody: each note lights a slower front in its pitch colour where its ink enters;
 *  - chords: shift the ink colours; energy: thins the liquid and speeds the fading of old ink.
 *
 * Grids, all on a 16:9 domain cover-fitted to the screen: the ink (and its surface) at one texel per
 * screen pixel, sized from the render target and carried across when it changes; velocity/pressure
 * 512x288 and burn 256x144, which only say how the ink moves and where fronts are and are always read
 * through B-splines (no edge or threshold is ever taken on a coarse grid); and two blurred light
 * levels for the pooling and shadows. Every beat's change eases in over a quarter second or more.
 * Deterministic for offline rendering: everything integrates by dt (the burn runs a whole number of
 * fixed steps per frame and is drawn interpolated between its last two), and a jump of more than
 * 0.5 s (or a new cue) resets to the opening bath.
 */

const VW = 512;
const VH = 288;
/**
 * The ink grid is sized from the render target in encode (one texel per screen pixel, capped).
 * Lengths that were tuned in texels of the original 1024x576 ink grid are kept in physical units.
 */
const REF_DH = 576;
const MAX_DW = 2560;
const MIN_DW = 320;
const BW = 256;
const BH = 144;
const G1W = 256;
const G1H = 144;
const G2W = 64;
const G2H = 36;
const ASPECT = VW / VH;
/** Uniform slot with the ink grid's size, the burn interpolation and the ink texels per original texel. */
const DIMS = 22;
/** Ignitions grow from a point to their full size over this long: no beat lights anything at once. */
const IGN_GROW = 0.3;
/** A snare stroke's duration: its stylus eases in and out over it. */
const STROKE_T = 0.4;
const JACOBI = 40;
const UVEC = 24;
const TAU = Math.PI * 2;
const SNARE_WAVES = 2;
/** Burn steps per second: a front moves one burn texel (two for the snare's) per step. */
const BURN_RATE = 240;
/** Stylus speed across the bath (pool heights per second) and how far short of its centre point it starts. */
const STYLUS_V = 4.5;
const STROKE = 0.3;
/** The render shows the middle of the bath, magnified by 1 / ZOOM. */
const ZOOM = 0.92;
const fract = (x: number) => x - Math.floor(x);

const META: SceneMeta = {
  id: 'liquid-light',
  name: 'Liquid Light',
  // Out of the show until fixed (gate: no darks and kicks/notes do not register).
  auto: false,
  energy: [0, 1],
  mood: { valence: 0.6, arousal: 0.5 },
  genres: { ambient: 1, edm: 0.9, techno: 0.8, synthwave: 0.9, pop: 0.8, lofi: 0.8, jazz: 0.7, classical: 0.7, dubstep: 0.6, dnb: 0.6, hiphop: 0.6, rock: 0.5, acoustic: 0.6 },
  trails: 0,
  kaleido: false,
};

/*
 * Uniform layout (vec4 slots of U):
 *  0 dt, reset, emitter hue, seed       1 damping, ink fade, vorticity, exposure
 *  2 pool turn, sim stirring, carried gyre, gyre wavenumber
 *  3 gyre phase x, phase y, cos, sin    4 emitter x, y, vx, vy
 *  5 emitter blend, radius, ink amount, heat
 *  6-11 ignitions (x, y, radius, hue + 2 * kind; radius 0 = none; kind 0 kick, 1 snare, 2 note);
 *    slot 4 is the latest note, lighting its stream from 12.zw to its own place; slot 5 the snare's
 *    stylus, lighting the stroke from 12.xy to its own place
 *  12 stroke ignition start (x, y), note stream start (x, y)   13 growth of ignitions 0-3 (0..1)
 *  14-15 snare strokes (x, y, age, hue) 16-17 snare stroke direction and shear (ux, uy, shear, rake)
 *  18 light xyz, specular               19 pool hue, pool luminance, zoom, pressure relief
 *  20 bump, refraction, -, base ink hue 21 burn step (s), heat time constant, ember time constant, -
 *  22 ink grid width, height, burn interpolation (0..1 between the last two steps), ink texels per
 *    original ink texel
 */
const HEAD = /* wgsl */ `
const VW: i32 = ${VW};
const VH: i32 = ${VH};
const BW: i32 = ${BW};
const BH: i32 = ${BH};
const ASPECT: f32 = ${ASPECT};
const STYLUS_V: f32 = ${STYLUS_V};
const STROKE_T: f32 = ${STROKE_T};
@group(1) @binding(0) var<uniform> U: array<vec4f, ${UVEC}>;
fn dyeDims() -> vec2f { return U[${DIMS}].xy; }
// Cubic B-spline filtering from four bilinear taps: smooth (C2) at any magnification, so a coarse
// field never shows its grid.
fn bspline(t: texture_2d<f32>, uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(t));
  let st = uv * size - 0.5;
  let i = floor(st);
  let f = st - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  let w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  let w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let h0 = (i - 0.5 + w1 / g0) / size;
  let h1 = (i + 1.5 + w3 / g1) / size;
  let a = textureSampleLevel(t, sampClamp, vec2f(h0.x, h0.y), 0.0);
  let b = textureSampleLevel(t, sampClamp, vec2f(h1.x, h0.y), 0.0);
  let c = textureSampleLevel(t, sampClamp, vec2f(h0.x, h1.y), 0.0);
  let d = textureSampleLevel(t, sampClamp, vec2f(h1.x, h1.y), 0.0);
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}

fn ll_chroma(c: vec3f) -> f32 {
  let hi = max(c.r, max(c.g, c.b));
  return (hi - min(c.r, min(c.g, c.b))) / max(hi, 1e-4);
}
// Turns a colour round the grey axis.
fn ll_rot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}
// Saturated ink, normalised to its brightest channel. The inks cycle through the palette's coloured
// entries (pal0, pal1, pal2; pal3 is its near-white highlight). A grey entry is replaced by the most
// colourful one turned round the hue circle, so every scheme gives at least two distinct inks.
fn ink(h: f32) -> vec3f {
  let c0 = F.pal0.rgb;
  let c1 = F.pal1.rgb;
  let c2 = F.pal2.rgb;
  let s0 = ll_chroma(c0);
  let s1 = ll_chroma(c1);
  let s2 = ll_chroma(c2);
  var best = c1;
  var sb = s1;
  if (s2 > sb) { best = c2; sb = s2; }
  if (s0 > sb) { best = c0; }
  let k0 = mix(ll_rot(best, 2.3), c0, smoothstep(0.1, 0.3, s0));
  let k1 = mix(ll_rot(best, -1.9), c1, smoothstep(0.1, 0.3, s1));
  let k2 = mix(ll_rot(best, 1.2), c2, smoothstep(0.1, 0.3, s2));
  let x = fract(h) * 3.0;
  let f = smoothstep(0.0, 1.0, fract(x));
  let c = select(select(mix(k2, k0, f), mix(k1, k2, f), x < 2.0), mix(k0, k1, f), x < 1.0);
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let sv = (hi - lo) / max(hi, 1e-4);
  let n = (c - lo) / max(hi - lo, 1e-4);
  return mix(vec3f(1.0), n, mix(0.55, 0.86, sat(sv * 2.0))) * 0.72;
}
// A divergence-free cellular current, rotated and phased by the morph.
fn ll_gyre(p: vec2f, k: f32, ph: vec2f) -> vec2f {
  let c = U[3].z;
  let s = U[3].w;
  let q = vec2f(c * p.x + s * p.y, -s * p.x + c * p.y);
  let ax = k * q.x + ph.x;
  let ay = k * q.y + ph.y;
  let vq = vec2f(sin(ax) * cos(ay), -cos(ax) * sin(ay));
  return vec2f(c * vq.x - s * vq.y, s * vq.x + c * vq.y);
}
// The pool's walls: flow fades to rest near the borders, so ink is never carried out of the frame.
fn ll_wall(p: vec2f) -> f32 {
  let b = min(min(p.x, ASPECT - p.x), min(p.y, 1.0 - p.y));
  return smoothstep(0.0, 0.1, b);
}
// The steady large-scale current carried kinematically: a slow turn of the whole pool plus the
// cellular current.
fn ll_flow(p: vec2f) -> vec2f {
  let dc = p - vec2f(ASPECT * 0.5, 0.5);
  return (U[2].x * vec2f(-dc.y, dc.x) * exp(-dot(dc, dc) * 1.5) + U[2].z * ll_gyre(p, U[2].w, U[3].xy)) * ll_wall(p);
}
fn ll_jetGauss(p: vec2f, r: f32) -> f32 {
  let d = p - U[4].xy;
  return exp(-dot(d, d) / (r * r));
}
// A snare's stylus: where it is along its stroke at an age, and its window along the stroke.
const STYLUS_W: f32 = 0.12;
const TINE_W: f32 = 0.05;
fn ll_stylus(age: f32) -> f32 { return -0.25 + STYLUS_V * age; }
`;

const VEL_SAMPLE = /* wgsl */ `
fn ll_vel(p: vec2f) -> vec2f { return textureSampleLevel(velIn, sampClamp, p / vec2f(ASPECT, 1.0), 0.0).xy; }
// Backtrace in four midpoint steps: the music's flows are fast and tightly curved, and one big
// step through them leaves ripples along the ink edges.
fn ll_trace(p: vec2f, dt: f32) -> vec2f {
  var q = p;
  let h = dt * 0.25;
  for (var s = 0; s < 4; s++) {
    let mid = q - 0.5 * h * (ll_vel(q) + ll_flow(q));
    q -= h * (ll_vel(mid) + ll_flow(mid));
  }
  return q;
}
`;

const CURL = /* wgsl */ `
@group(1) @binding(1) var velIn: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<r32float, write>;
fn vAt(i: vec2i) -> vec2f { return textureLoad(velIn, clamp(i, vec2i(0), vec2i(VW - 1, VH - 1)), 0).xy; }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= VW || i.y >= VH) { return; }
  let h = 1.0 / f32(VH);
  let w = (vAt(i + vec2i(1, 0)).y - vAt(i - vec2i(1, 0)).y - vAt(i + vec2i(0, 1)).x + vAt(i - vec2i(0, 1)).x) / (2.0 * h);
  textureStore(outTex, i, vec4f(w, 0.0, 0.0, 0.0));
}`;

const VEL_ADVECT = /* wgsl */ `
@group(1) @binding(1) var velIn: texture_2d<f32>;
@group(1) @binding(2) var curlTex: texture_2d<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;
${VEL_SAMPLE}
fn cAt(i: vec2i) -> f32 { return textureLoad(curlTex, clamp(i, vec2i(0), vec2i(VW - 1, VH - 1)), 0).x; }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= VW || i.y >= VH) { return; }
  if (U[0].y > 0.5) { textureStore(outTex, i, vec4f(0.0)); return; }
  let dt = U[0].x;
  let h = 1.0 / f32(VH);
  let p = (vec2f(i) + 0.5) * h;
  // Backtrace through the simulated plus carried flow, reading a slightly widened footprint: a touch
  // of viscosity that also damps the grid-scale checkerboard a collocated grid lets through.
  let q = ll_trace(p, dt);
  let e = 0.5 * h;
  var v = 0.25 * (ll_vel(q + vec2f(e, e)) + ll_vel(q + vec2f(-e, e)) + ll_vel(q + vec2f(e, -e)) + ll_vel(q - vec2f(e, e)));
  // Vorticity confinement: puts back the small swirls numerical diffusion eats.
  let g = vec2f(abs(cAt(i + vec2i(1, 0))) - abs(cAt(i - vec2i(1, 0))), abs(cAt(i + vec2i(0, 1))) - abs(cAt(i - vec2i(0, 1))));
  let n = g / (length(g) + 1e-5);
  let w = cAt(i);
  v += dt * U[1].z * h * w * vec2f(n.y, -n.x);
  // Steady stirring at three scales finer than the carried current, so eddies keep forming, folding
  // and merging at many sizes. The cell lattices sit at odd angles and ratios to each other, so the
  // eddies never line up into a grid (the projection below makes the sum incompressible).
  let pc = vec2f(ASPECT * 0.5, 0.5);
  let pr = pc + rot2(1.07) * (p - pc);
  let pr2 = pc + rot2(-0.61) * (p - pc);
  v += dt * U[2].y * 0.7 * (ll_gyre(p, U[2].w * 1.8, U[3].yx * 1.3 + vec2f(1.7, 0.4)) + ll_gyre(pr, U[2].w * 1.31, U[3].xy * 0.9 + vec2f(0.3, 2.9))
    + 0.6 * ll_gyre(pr2, U[2].w * 3.7, U[3].xy * 1.7 + vec2f(2.2, 1.1)));
  // Viscosity.
  v *= exp(-U[1].x * dt);
  // The melody's jet, ramped in and out with the note: the nozzle's velocity eases toward it.
  v = mix(v, U[4].zw, ll_jetGauss(p, U[5].y) * U[5].x);
  v *= ll_wall(p);
  let sp = length(v);
  v *= min(1.0, 1.5 / max(sp, 1e-6));
  textureStore(outTex, i, vec4f(v, 0.0, 1.0));
}`;

const DIVERGENCE = /* wgsl */ `
@group(1) @binding(1) var velIn: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<r32float, write>;
fn vAt(i: vec2i) -> vec2f { return textureLoad(velIn, clamp(i, vec2i(0), vec2i(VW - 1, VH - 1)), 0).xy; }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= VW || i.y >= VH) { return; }
  let h = 1.0 / f32(VH);
  let d = (vAt(i + vec2i(1, 0)).x - vAt(i - vec2i(1, 0)).x + vAt(i + vec2i(0, 1)).y - vAt(i - vec2i(0, 1)).y) / (2.0 * h);
  textureStore(outTex, i, vec4f(d, 0.0, 0.0, 0.0));
}`;

const JACOBI_WGSL = /* wgsl */ `
@group(1) @binding(1) var pIn: texture_2d<f32>;
@group(1) @binding(2) var divTex: texture_2d<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d<r32float, write>;
// Open boundary: pressure is zero outside the domain.
fn pAt(i: vec2i) -> f32 {
  if (i.x < 0 || i.y < 0 || i.x >= VW || i.y >= VH) { return 0.0; }
  return textureLoad(pIn, i, 0).x;
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= VW || i.y >= VH) { return; }
  let h = 1.0 / f32(VH);
  let keep = 1.0 - step(0.5, U[0].y);
  let s = (pAt(i + vec2i(1, 0)) + pAt(i - vec2i(1, 0)) + pAt(i + vec2i(0, 1)) + pAt(i - vec2i(0, 1))) * keep;
  let p = (s - h * h * textureLoad(divTex, i, 0).x) * 0.25;
  textureStore(outTex, i, vec4f(p, 0.0, 0.0, 0.0));
}`;

const GRADIENT = /* wgsl */ `
@group(1) @binding(1) var velIn: texture_2d<f32>;
@group(1) @binding(2) var pIn: texture_2d<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var carryOut: texture_storage_2d<rgba16float, write>;
fn pAt(i: vec2i) -> f32 {
  if (i.x < 0 || i.y < 0 || i.x >= VW || i.y >= VH) { return 0.0; }
  return textureLoad(pIn, i, 0).x;
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= VW || i.y >= VH) { return; }
  let h = 1.0 / f32(VH);
  let g = vec2f(pAt(i + vec2i(1, 0)) - pAt(i - vec2i(1, 0)), pAt(i + vec2i(0, 1)) - pAt(i - vec2i(0, 1))) / (2.0 * h);
  let v = textureLoad(velIn, i, 0).xy - g;
  // The pressure gradient rides along in zw, so the surface relief can read it through a B-spline.
  textureStore(outTex, i, vec4f(v, g));
  // Everything that carries the ink (the simulated flow plus the steady current, which is smooth on
  // this grid's scale), baked once here so the ink's backtrace is plain bilinear reads.
  textureStore(carryOut, i, vec4f(v + ll_flow((vec2f(i) + 0.5) * h), 0.0, 1.0));
}`;


const DYE_ADVECT = /* wgsl */ `
@group(1) @binding(1) var dyeIn: texture_2d<f32>;
@group(1) @binding(2) var velIn: texture_2d<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var g2Tex: texture_2d<f32>;
@group(1) @binding(5) var burnTex: texture_2d<f32>;
@group(1) @binding(6) var paintTex: texture_2d<f32>;
// The carry field (velocity plus the steady current) at a point.
fn ll_carry(p: vec2f) -> vec2f { return textureSampleLevel(velIn, sampClamp, p / vec2f(ASPECT, 1.0), 0.0).xy; }
// Backtrace in four midpoint steps: the music's flows are fast and tightly curved, and one big
// step through them leaves ripples along the ink edges.
fn ll_trace(p: vec2f, dt: f32) -> vec2f {
  var q = p;
  let h = dt * 0.25;
  for (var s = 0; s < 4; s++) {
    q -= h * ll_carry(q - 0.5 * h * ll_carry(q));
  }
  return q;
}
// Reads past the edge repeat the edge, so nothing ever drags empty water in from outside the bath.
fn dAt(i: vec2i) -> vec4f { return textureLoad(dyeIn, clamp(i, vec2i(0), vec2i(dyeDims()) - 1), 0); }
fn crW(f: f32) -> vec4f {
  return vec4f(
    f * (-0.5 + f * (1.0 - 0.5 * f)),
    1.0 + f * f * (-2.5 + 1.5 * f),
    f * (0.5 + f * (2.0 - 1.5 * f)),
    f * f * (-0.5 + 0.5 * f));
}
// Catmull-Rom resampling clamped to the four nearest texels: sharp filaments without ringing.
fn dyeCR(st: vec2f) -> vec4f {
  let b = floor(st);
  let f = st - b;
  let bi = vec2i(b);
  let wx = crW(f.x);
  let wy = crW(f.y);
  var acc = vec4f(0.0);
  var lo = vec4f(1e9);
  var hi = vec4f(-1e9);
  for (var y = 0; y < 4; y++) {
    var row = vec4f(0.0);
    for (var x = 0; x < 4; x++) {
      let t = dAt(bi + vec2i(x - 1, y - 1));
      row += t * wx[x];
      if (x >= 1 && x <= 2 && y >= 1 && y <= 2) { lo = min(lo, t); hi = max(hi, t); }
    }
    acc += row * wy[y];
  }
  return clamp(acc, lo, hi);
}
// The bath a cue opens on, laid down the way marbling is: drops of ink and clear water, several at
// each of a few sites (each drop pushes the earlier ones out into rings), then two passes of a comb
// and a broad swirl. Evaluated backwards from the finished pattern: undo the swirl, then the combs,
// then each drop from the last to the first, until the point lands inside a drop (or the base ink).
// Every step is area-preserving, so the rings stay as fine as they would be in a real bath.
fn seedMarble(p: vec2f) -> vec4f {
  let sd = U[0].w;
  let hb = U[20].w;
  let c = vec2f(ASPECT * 0.5, 0.5);
  var q = p;
  // Swirl: a turn that depends only on the distance from its centre.
  let sc = c + vec2f(hash11(sd * 71.3) - 0.5, hash11(sd * 37.9) - 0.5) * vec2f(0.8, 0.3);
  let sv = q - sc;
  q = sc + rot2(-(hash11(sd * 91.7) - 0.5) * 9.0 * exp(-dot(sv, sv) * 2.5)) * sv;
  // Combs: a shear along the tines that depends only on the distance across them.
  for (var k = 1; k >= 0; k--) {
    let fk = f32(k);
    let ang = hash11(sd * 13.1 + fk * 7.7) * TAU;
    let u = vec2f(cos(ang), sin(ang));
    let n = vec2f(-u.y, u.x);
    let spc = select(0.11 + 0.08 * hash11(sd * 5.3), 0.3 + 0.15 * hash11(sd * 8.1), k == 0);
    let x = dot(q - c, n) / spc;
    let dd = (fract(x) - 0.5) * spc;
    // The second comb pulls neighbouring tines opposite ways (a nonpareil), the first all one way.
    let dir = select(1.0, select(1.0, -1.0, fract(floor(x) * 0.5) > 0.25), k == 1);
    q -= u * dir * (0.1 + 0.08 * hash11(sd * 3.7 + fk)) * exp(-abs(dd) / (spc * 0.2));
  }
  // Drops: six sites of three nested drops; the middle one of each site is clear water.
  let e = 1.2 / dyeDims().y;
  var outc = vec4f(0.0);
  var wrem = 1.0;
  for (var i = 17; i >= 0; i--) {
    let fi = f32(i);
    let site = floor(fi / 3.0);
    let ring = fi - site * 3.0;
    let ctr = vec2f(0.1 + hash11(sd * 17.3 + site * 3.1) * (ASPECT - 0.2), 0.1 + 0.8 * hash11(sd * 29.7 + site * 5.9));
    let R = (0.07 + 0.13 * hash11(sd * 41.1 + site * 2.3)) * (1.0 - 0.28 * ring);
    let dv = q - ctr;
    let r2 = dot(dv, dv);
    let r = sqrt(r2);
    let m = smoothstep(R + e, R - e, r);
    let hue = hb + floor(hash11(sd * 53.1 + fi * 1.7) * 3.0) / 3.0 + 0.08 * ring;
    let col = select(vec4f(ink(hue), 1.0) * 1.25, vec4f(0.0), ring == 1.0);
    outc += col * (m * wrem);
    wrem *= 1.0 - m;
    if (wrem < 1e-3) { return outc; }
    q = ctr + dv * sqrt(max(0.0, 1.0 - R * R / max(r2, 1e-10)));
  }
  // The base: the bath's first ink, combed with veins of clear water by the same strokes.
  let vx = dot(q - c, vec2f(0.6, 0.8)) / 0.09 + hash11(sd * 2.9);
  let vein = abs(fract(vx) - 0.5);
  let base = vec4f(ink(hb + 0.5 + 0.33 * step(0.5, fract(floor(vx) * 0.5))), 1.0) * 1.1 * smoothstep(0.2, 0.13, vein);
  return outc + base * wrem;
}
// A snare stroke's velocity at p: a stylus moving along u drags the liquid near its line with it
// (a stream function, so it is divergence-free). Over its full pass it leaves a pure shear along
// the line: a fold through every vein it crosses. X.w > 0 makes it a rake of three tines that far
// apart.
fn strokeVel(p: vec2f, S: vec4f, X: vec4f) -> vec2f {
  let u = X.xy;
  let n = vec2f(-u.y, u.x);
  let a = dot(p - S.xy, u) - ll_stylus(S.z);
  let g = exp(-a * a / (STYLUS_W * STYLUS_W));
  let gp = -2.0 * a / (STYLUS_W * STYLUS_W) * g;
  // The stylus eases in from rest and out again over the stroke (2 sin^2 averages to one, so the
  // whole stroke still leaves the same fold).
  let ease = sin(3.14159265 * sat(S.z / STROKE_T));
  let amp = X.z * STYLUS_V / (STYLUS_W * 1.7725) * 2.0 * ease * ease;
  var v = vec2f(0.0);
  for (var k = -1; k <= 1; k++) {
    if (k != 0 && X.w <= 0.0) { continue; }
    let d = dot(p - S.xy, n) - f32(k) * X.w;
    let ed = exp(-abs(d) / TINE_W);
    v += ed * g * u - sign(d) * TINE_W * (1.0 - ed) * gp * n;
  }
  return amp * v * ll_wall(p);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  let dims = dyeDims();
  if (f32(i.x) >= dims.x || f32(i.y) >= dims.y) { return; }
  let p = (vec2f(i) + 0.5) / dims.y;
  if (U[0].y > 0.5) { textureStore(outTex, i, seedMarble(p)); return; }
  let dt = U[0].x;
  let uv = p / vec2f(ASPECT, 1.0);
  // Snare strokes: undo this frame's drag of each stylus (a short stroke, about 0.4 s).
  var q = p;
  for (var j = 0; j < 2; j++) {
    let S = U[14 + j];
    if (S.z < STROKE_T) {
      let X = U[16 + j];
      let mid = q - 0.5 * dt * strokeVel(q, S, X);
      q -= dt * strokeVel(mid, S, X);
    }
  }
  var d = dyeCR(ll_trace(q, dt) * dims.y - 0.5);
  // Ink fade: old ink dims toward a low glow; fresh ink stays bright on top.
  let lit = max(d.r, max(d.g, d.b)) / max(d.a, 1e-4);
  d = vec4f(d.rgb * max(exp(-U[1].y * dt), min(1.0, 0.42 / max(lit, 1e-4))), d.a);
  // Fresh ink is hot (brighter than its base colour) and cools within a second or two.
  let mx = max(d.r, max(d.g, d.b)) / max(d.a, 1e-4);
  d = vec4f(d.rgb * mix(1.0, 0.72 / max(mx, 0.72), 1.0 - exp(-1.2 * dt)), d.a);
  // Where the bath is crowded with ink (the broad blur of the last frame), the ink slowly thins and
  // its edges recede, so the sound's fresh ink always has black water to run into.
  let dens = textureSampleLevel(g2Tex, sampClamp, uv, 0.0).a;
  let crowd = smoothstep(0.45, 0.8, dens);
  d *= exp(-0.3 * crowd * dt);
  // Ink and water do not mix: films smeared thinner than a threshold pull back to clear water and
  // thicker ones fill in, so the pools keep crisp edges and dark channels between them. Resampling
  // smears every edge a little each frame; a threshold near half keeps that from growing the ink,
  // and a higher one where the bath is crowded makes it recede there.
  let a0 = min(d.a, 1.0);
  let thr = 0.36 + 0.24 * smoothstep(0.15, 0.6, dens);
  let grow = 1.4 * a0 * (a0 - thr) * (1.0 - a0) * dt;
  d *= max(0.0, d.a + grow) / max(d.a, 1e-5);
  // Burning: wherever the burn field's front is passing, the ink takes the front's colour for good
  // (lit afresh). The coarse front and its colour are both read through the B-spline, so the
  // recoloured ink has smooth edges, never the burn grid's blocks.
  let b = bspline(burnTex, uv);
  let P = bspline(paintTex, uv);
  let lit2 = max(d.r, max(d.g, d.b)) / max(d.a, 1e-4) / 0.72;
  let amt = (1.0 - exp(-30.0 * sat(b.x) * dt)) * smoothstep(0.0, 0.05, P.a);
  d = vec4f(mix(d.rgb, P.rgb / max(P.a, 1e-4) * max(lit2, 1.35) * d.a, amt), d.a);
  // The sound's ink, coloured by centroid and pitch, sized by the bass, hot on attacks.
  let jet = U[5].z * ll_jetGauss(p, U[5].y * 0.75) * (1.0 - 0.6 * crowd);
  if (jet > 1e-6) { d += vec4f(ink(U[0].z) * U[5].w, 1.0) * jet; }
  d = max(d, vec4f(0.0));
  // Ink never piles up deeper than a thick pool: the stream spreads instead of heaping into a bead.
  d *= min(1.0, 1.8 / max(d.a, 1e-6));
  // Stochastic rounding into half floats: slow fades keep fading at any frame rate instead of
  // stalling when one frame's change is below half a unit in the last place.
  d *= 1.0 + (hash13(vec3f(vec2f(i), fract(F.frame * 0.618034) * 977.0)) - 0.5) * 0.001;
  textureStore(outTex, i, d);
}`;

/**
 * One step of the burn field (BW x BH; x heat, y spent fuel / embers, z the front's ink hue, w its
 * kind plus its strength: kind + 0.999 * strength). A cell with ink and fuel left catches from its
 * hottest burning neighbour, reaching two cells per step, so fronts run at a fixed speed and only
 * through ink. A note's front loses its strength fastest, so it stays round where the note lit it. Each cell a front crosses takes a little of its
 * strength, so every burn dies out a finite way from where it was lit. Heat dies fast behind the front (a thin hot edge); the spent fuel recovers over a few
 * seconds, so the same ink can burn again on a later beat. Ignitions catch only where there is ink.
 * Besides its state it writes the paint the other passes read through a B-spline: the front's ink
 * and its kind and strength, each times the front's presence, and the presence.
 */
const BURN = /* wgsl */ `
@group(1) @binding(1) var bIn: texture_2d<f32>;
@group(1) @binding(2) var dyeTex: texture_2d<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var paint0: texture_storage_2d<rgba16float, write>;
@group(1) @binding(5) var paint1: texture_storage_2d<rgba16float, write>;
fn bAt(i: vec2i) -> vec4f { return textureLoad(bIn, clamp(i, vec2i(0), vec2i(BW - 1, BH - 1)), 0); }
fn store(i: vec2i, o: vec4f) {
  textureStore(outTex, i, o);
  let pres = sat(max(o.x, o.y) * 4.0);
  let kind = floor(o.w);
  let w = vec3f(select(0.0, 1.0, kind == 0.0), select(0.0, 1.0, kind == 1.0), select(0.0, 1.0, kind == 2.0));
  textureStore(paint0, i, vec4f(ink(o.z), 1.0) * pres);
  textureStore(paint1, i, vec4f(w, fract(o.w)) * pres);
}
// The ink under a cell: the mean coverage over its whole footprint (bilinear taps two ink texels
// apart), so thin filaments count at any ink resolution.
fn inkUnder(p: vec2f) -> f32 {
  let t = 1.0 / dyeDims();
  let n = clamp(i32(round(dyeDims().y / f32(BH) * 0.5)), 1, 6);
  var a = 0.0;
  for (var y = 0; y < n; y++) {
    for (var x = 0; x < n; x++) {
      let o = (vec2f(f32(x), f32(y)) - 0.5 * f32(n - 1)) * 2.0 * t;
      a += textureSampleLevel(dyeTex, sampClamp, p / vec2f(ASPECT, 1.0) + o, 0.0).a;
    }
  }
  return a / f32(n * n);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= BW || i.y >= BH) { return; }
  if (U[0].y > 0.5) { store(i, vec4f(0.0)); return; }
  let p = (vec2f(i) + 0.5) / f32(BH);
  let fuel = 1.0 - exp(-inkUnder(p) * 1.6);
  let s = bAt(i);
  // Burning neighbours (diagonals count a little less, being further away), and those two cells
  // away. A cell catches with a chance that grows with how much burns round it, so
  // fronts spread as ragged, roughly round edges instead of the grid's squares.
  var best = vec4f(0.0);
  var heat = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let n = bAt(i + vec2i(x, y));
      let w = select(1.0, 0.7, x != 0 && y != 0);
      if (n.x > 0.4) { heat += w; }
      if (n.x > best.x) { best = n; }
    }
  }
  for (var k = 0; k < 8; k++) {
    let o = vec2i(round(vec2f(cos(f32(k) * 0.785398), sin(f32(k) * 0.785398)) * 2.0));
    let n = bAt(i + o);
    if (n.x > 0.4) { heat += 0.8; if (n.x > best.x) { best = n; } }
  }
  let chance = sat(heat * 0.3) * smoothstep(0.25, 0.6, fuel);
  let roll = hash13(vec3f(vec2f(i), floor(best.x * 4096.0) + floor(s.y * 977.0) + 0.5));
  let h = U[21].x;
  var o = vec4f(s.x * exp(-h / U[21].y), s.y * exp(-h / U[21].z), s.zw);
  // Ready to burn: not burning now and most of its fuel recovered.
  let ready = s.x < 0.12 && s.y < 0.3;
  let kind = floor(best.w);
  let str = fract(best.w) * select(select(0.962, 0.975, kind == 1.0), 0.955, kind == 2.0);
  if (ready && roll < chance && str > 0.08) { o = vec4f(1.0, 1.0, best.z, kind + str); }
  for (var j = 0; j < 6; j++) {
    let I = U[6 + j];
    let kind = floor(I.w * 0.5);
    // The stylus lights everything along its stroke so far (a capsule), the others a disc.
    var dd = length(p - I.xy);
    if (j >= 4) {
      let a0 = select(U[12].zw, U[12].xy, j == 5);
      let ab = I.xy - a0;
      let h = sat(dot(p - a0, ab) / max(dot(ab, ab), 1e-6));
      dd = length(p - a0 - ab * h);
    }
    let strength = select(select(1.0, 0.85, kind == 1.0), 0.9, kind == 2.0);
    // An ignition catches on any ink that isn't burning this moment, spent or not, but not again
    // while it grows: each cell it lights burns once and runs on.
    // A kick's ignitions catch fibre by fibre as they grow (U[13], 0 to 1 over IGN_GROW), each cell
    // at its own moment, mostly near the middle first: a ragged spread, never a disc or ring at once.
    let grow = select(1.0, U[13][min(j, 3)], j < 4);
    let catchAt = select(0.0, 0.7 * hash13(vec3f(vec2f(i), fract(I.w * 7.7 + I.x * 3.1) * 911.0)) + 0.3 * dd / max(I.z, 1e-4), j < 4);
    if (I.z > 0.0 && s.x < 0.12 && s.y < 0.5 && fuel > 0.2 && dd < I.z && catchAt < grow) { o = vec4f(1.0, 1.0, I.w - 2.0 * kind, kind + 0.999 * strength); }
  }
  store(i, o);
}`;

// Surface height: more ink stands higher, and paler inks are a little thicker than deep ones, so
// a pool marbled from several inks keeps a relief along its colour boundaries.
const HEIGHT = /* wgsl */ `
fn height(d: vec4f) -> f32 {
  let c = d.rgb / max(d.a, 1e-4);
  return (1.0 - exp(-d.a * 0.8)) * (0.35 + 0.65 * sat(luma(c) * 1.6));
}`;

const PREP = /* wgsl */ `
@group(1) @binding(1) var dyeIn: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var velTex: texture_2d<f32>;
@group(1) @binding(4) var slopeTex: texture_2d<f32>;
${HEIGHT}
fn hAt(i: vec2i) -> f32 { return height(textureLoad(dyeIn, clamp(i, vec2i(0), vec2i(dyeDims()) - 1), 0)); }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  let dims = dyeDims();
  if (f32(i.x) >= dims.x || f32(i.y) >= dims.y) { return; }
  let hd = 1.0 / dims.y;
  let tl = hAt(i + vec2i(-1, -1)); let t = hAt(i + vec2i(0, -1)); let tr = hAt(i + vec2i(1, -1));
  let l = hAt(i + vec2i(-1, 0)); let c = hAt(i); let r = hAt(i + vec2i(1, 0));
  let bl = hAt(i + vec2i(-1, 1)); let b = hAt(i + vec2i(0, 1)); let br = hAt(i + vec2i(1, 1));
  // Fine slope at the ink's own resolution. An ink edge is about as many texels wide at any
  // resolution, so its slope is divided by the ink texels per original texel: the same relief as
  // tuned, only finer.
  let k = 1.0 / U[${DIMS}].w;
  let gx = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / (8.0 * hd) * k;
  let gy = ((bl + 2.0 * b + br) - (tl + 2.0 * t + tr)) / (8.0 * hd) * k;
  let hs = (c * 4.0 + (l + r + t + b) * 2.0 + tl + tr + bl + br) / 16.0;
  // The broad slope (pools dome up) and the fluid's own pressure (swirl cores dimple, pushes
  // swell; still water is flat), both from coarse grids read through the B-spline: smooth at any
  // resolution, never faceted by their grids.
  let uv = (vec2f(i) + 0.5) / dims;
  let gb = bspline(slopeTex, uv).xy;
  let gp = bspline(velTex, uv).zw * U[19].w;
  textureStore(outTex, i, vec4f(hs, gx * 0.6 + gb.x * 1.1 + gp.x, gy * 0.6 + gb.y * 1.1 + gp.y, 0.0));
}`;

/**
 * The broad slope of the bath at the first light level's resolution: the derivative of a wide blur,
 * from two rings of samples of that level, so every body of liquid catches the light across its
 * surface. Radii are in texels of the original ink grid.
 */
const SLOPE = /* wgsl */ `
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
${HEIGHT}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  let size = vec2i(textureDimensions(outTex));
  if (i.x >= size.x || i.y >= size.y) { return; }
  let uv = (vec2f(i) + 0.5) / vec2f(size);
  let refSize = vec2f(${REF_DH}.0 * ASPECT, ${REF_DH}.0);
  var gb = vec2f(0.0);
  for (var k = 0; k < 16; k++) {
    let rad = select(6.0, 16.0, k >= 8);
    let a = (f32(k) + select(0.0, 0.5, k >= 8)) * TAU / 8.0;
    let o = vec2f(cos(a), sin(a)) * rad;
    let hv = height(textureSampleLevel(srcTex, sampClamp, uv + o / refSize, 0.0));
    gb += hv * o / (rad * rad);
  }
  textureStore(outTex, i, vec4f(gb * 0.125 * ${REF_DH}.0, 0.0, 0.0));
}`;

/**
 * Blurred light of the bath: a Gaussian of the ink's (premultiplied) colour and its coverage, from a
 * finer level (or the ink itself) on a 5x5 grid of taps. Two levels: one a few original ink texels
 * wide for the shadows and rims, one broad for the light pooling in the water. Reading the ink, each
 * tap averages its whole cell (sub-taps about two ink texels apart), so fine filaments never alias
 * into flicker, whatever the ink resolution.
 */
const blurWgsl = (W: number, H: number, step: number, fromInk: boolean) => /* wgsl */ `
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= ${W} || i.y >= ${H}) { return; }
  let uv = (vec2f(i) + 0.5) / vec2f(${W}.0, ${H}.0);
  let r = ${fromInk ? `U[${DIMS}].w` : '1.0'};
  let px = ${step} * r / vec2f(textureDimensions(srcTex));
  let n = clamp(i32(ceil(r - 0.01)), 1, 4);
  var acc = vec4f(0.0);
  var ws = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let o = vec2f(f32(x), f32(y));
      let w = exp(-dot(o, o) * 0.35);
      var s = vec4f(0.0);
      for (var sy = 0; sy < n; sy++) {
        for (var sx = 0; sx < n; sx++) {
          let so = (vec2f(f32(sx), f32(sy)) + 0.5) / f32(n) - 0.5;
          s += textureSampleLevel(srcTex, sampClamp, uv + (o + so) * px, 0.0);
        }
      }
      s /= f32(n * n);
      ${step > 2.5 ? 's = vec4f(s.rgb, 1.0 - exp(-s.a * 1.5));' : ''}
      acc += s * w;
      ws += w;
    }
  }
  textureStore(outTex, i, acc / ws);
}`;

/** Carries the ink across a change of resolution. */
const RESAMPLE = /* wgsl */ `
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  let size = vec2i(textureDimensions(outTex));
  if (i.x >= size.x || i.y >= size.y) { return; }
  textureStore(outTex, i, textureSampleLevel(srcTex, sampClamp, (vec2f(i) + 0.5) / vec2f(size), 0.0));
}`;

const RENDER = /* wgsl */ `
@group(1) @binding(1) var dyeTex: texture_2d<f32>;
@group(1) @binding(2) var gTex: texture_2d<f32>;
@group(1) @binding(3) var g1Tex: texture_2d<f32>;
@group(1) @binding(4) var g2Tex: texture_2d<f32>;
@group(1) @binding(5) var burnTex: texture_2d<f32>;
@group(1) @binding(6) var burnPrev: texture_2d<f32>;
@group(1) @binding(7) var paint0: texture_2d<f32>;
@group(1) @binding(8) var paint1: texture_2d<f32>;
${FULLSCREEN_VS}
// 5-tap Catmull-Rom: the ink is about one texel per pixel, so a sharp filter keeps its edges crisp
// (a B-spline here would soften every edge by a pixel); clamped so the lobes never go negative.
fn sharp(t: texture_2d<f32>, uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(t));
  let pos = uv * size;
  let c = floor(pos - 0.5) + 0.5;
  let f = pos - c;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (c - 1.0) / size;
  let t3 = (c + 2.0) / size;
  let t12 = (c + w2 / w12) / size;
  var r = textureSampleLevel(t, sampClamp, vec2f(t12.x, t0.y), 0.0) * (w12.x * w0.y);
  r += textureSampleLevel(t, sampClamp, vec2f(t0.x, t12.y), 0.0) * (w0.x * w12.y);
  r += textureSampleLevel(t, sampClamp, vec2f(t12.x, t12.y), 0.0) * (w12.x * w12.y);
  r += textureSampleLevel(t, sampClamp, vec2f(t3.x, t12.y), 0.0) * (w3.x * w12.y);
  r += textureSampleLevel(t, sampClamp, vec2f(t12.x, t3.y), 0.0) * (w12.x * w3.y);
  let norm = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / norm, vec4f(0.0));
}
// Re-voices a (possibly mixed) ink colour to a clean hue at its own brightness, so blends of inks
// read as a new saturated colour instead of pastel or brown.
fn vivid(c: vec3f) -> vec3f {
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let sv = (hi - lo) / max(hi, 1e-4);
  let n = (c - lo) / max(hi - lo, 1e-4);
  let v = mix(vec3f(1.0), n, mix(0.72, 0.95, sv)) * hi;
  return mix(c, v, smoothstep(0.04, 0.18, sv));
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  var s = vec2f(1.0);
  if (F.aspect > ASPECT) { s.y = ASPECT / F.aspect; } else { s.x = F.aspect / ASPECT; }
  let suv = 0.5 + (in.uv - 0.5) * s * U[19].z;
  let p = suv * vec2f(ASPECT, 1.0);
  let G = bspline(gTex, suv);
  let N = normalize(vec3f(-G.yz * U[20].x, 1.0));
  // Refraction: the ink seen through its own curved surface, with a touch of dispersion.
  let o = N.xy * U[20].y * G.x * vec2f(1.0 / ASPECT, 1.0);
  let d = sharp(dyeTex, suv - o);
  let dr = textureSampleLevel(dyeTex, sampClamp, suv - o * 1.35, 0.0);
  let db = textureSampleLevel(dyeTex, sampClamp, suv - o * 0.65, 0.0);
  var col = d.rgb / max(d.a, 1e-4);
  col.r = mix(col.r, dr.r / max(dr.a, 1e-4), sat(dr.a * 4.0));
  col.b = mix(col.b, db.b / max(db.a, 1e-4), sat(db.a * 4.0));
  col = vivid(col);
  let cover = 1.0 - exp(-d.a * 1.6);
  // Rainbow glints: where the ink's surface curves away at its edges, a thin film turns its colour
  // round the hue circle with the slope.
  let slope = length(G.yz) * U[20].x;
  let film = smoothstep(0.08, 0.5, slope);
  col = mix(col, max(ll_rot(col, 1.2 + 5.0 * slope), vec3f(0.0)), 0.75 * film);

  let L = normalize(U[18].xyz);
  let V = vec3f(0.0, 0.0, 1.0);
  let H = normalize(L + V);
  let ndl = max(dot(N, L), 0.0);
  let ndh = max(dot(N, H), 0.0);

  // Light of the bath around this point: g1 a few texels wide (rims and shadows), g2 broad (pooling).
  let g1 = bspline(g1Tex, suv);
  let g2 = bspline(g2Tex, suv);
  // Each pool casts a soft shadow onto the floor, offset away from the light.
  let sh = bspline(g1Tex, suv + L.xy * vec2f(-1.0, 1.0) * 0.012).a;
  let shB = bspline(g2Tex, suv + L.xy * vec2f(-1.0, 1.0) * 0.03).a;
  let shadow = 1.0 - 0.45 * sat(1.0 - exp(-sh * 1.5)) - 0.2 * shB;

  // The floor: deep black water, lit by the light the inks pool into it (a broad glow in their
  // colours, brightest close to them), shadowed under the pools.
  let vig = 1.0 - 0.55 * dot(in.uv - 0.5, in.uv - 0.5) * 2.0;
  let pool = vivid(g2.rgb) * 0.3 + vivid(g1.rgb) * 0.25;
  let floorC = (palL(U[19].x, U[19].y) + pool) * vig * shadow;

  // Ink body: thick ink is deep and saturated, thin ink lighter; lit by the key with a soft wrap, and
  // darkened in the creases where it sits lower than its surroundings.
  let thick = sat(d.a * 0.8);
  let hiC = max(col.r, max(col.g, col.b));
  let tint = pow(col / max(hiC, 1e-4), vec3f(0.75 + 0.7 * thick)) * hiC;
  let crease = sat(1.0 - 2.5 * max(g1.a * 0.75 - G.x, 0.0));
  var body = tint * (0.3 + 0.85 * ndl) * U[1].w * (0.6 + 0.4 * crease);
  // Light glowing through thin ink from the bath under it.
  body += vivid(g1.rgb) * 0.25 * (1.0 - thick);

  // Burning: the hot edge of each front and the embers behind it, only in the ink. Kicks burn as
  // fire (white to yellow to orange, embers deep orange), snares as an electric white edge in their
  // second colour, notes in their own pitch colour. The coarse burn field and its paint (colour,
  // kind and strength) are read through the B-spline and interpolated between the last two burn
  // steps, so fronts have smooth edges and glide at any frame rate; the fine detail comes from the
  // ink's own coverage and slope at full resolution.
  let fr = U[${DIMS}].z;
  let B = mix(bspline(burnPrev, suv), bspline(burnTex, suv), fr);
  // (Colour and kind change slowly behind a front: the latest step is enough for them.)
  let P0 = bspline(paint0, suv);
  let P1 = bspline(paint1, suv);
  let hx = sat(B.x);
  let kw = P1 / max(P0.a, 1e-4);
  let str = kw.w;
  let wk = kw.x;
  let ws = kw.y;
  let wn = kw.z;
  let fire = vec3f(1.0, 0.26 + 0.42 * hx, 0.04 + 0.2 * hx * hx) * (5.5 * hx * hx + 1.4 * hx) * (0.3 + 0.7 * str);
  let fc = P0.rgb / max(P0.a, 1e-4);
  let spark = mix(fc, vec3f(1.0), 0.5 * hx * hx) * (3.0 * hx * hx + 0.7 * hx) * (0.3 + 0.7 * str);
  let ember = sat(B.y - hx) ;
  let emberC = (vec3f(1.0, 0.28, 0.05) * wk + fc * (ws + wn)) * ember * ember * ember * 0.35;
  // The fire burns along the ink: brightest on its rims and folds, where the surface curves.
  let fibre = 0.25 + 1.6 * smoothstep(0.04, 0.4, slope);
  let burn = (fire * wk + spark * (ws + wn * 2.6) + emberC) * cover * cover * fibre;

  // Glossy surface: tight highlight, broad sheen, fresnel reflection of a soft studio key.
  let wet = mix(0.35, 1.0, smoothstep(0.02, 0.25, G.x));
  let R = reflect(-V, N);
  let fres = 0.04 + 0.96 * pow(1.0 - N.z, 5.0);
  let keyC = mix(vec3f(1.0), palL(U[19].x + 0.5, 1.0), 0.25);
  let spec = keyC * (pow(ndh, 260.0) * 2.6 + pow(ndh, 50.0) * 0.25) * U[18].w;
  let env = palRampL(0.75, 0.3) * smoothstep(0.55, 0.98, dot(R, L)) + palL(U[19].x + 0.33, 0.06) * sat(0.5 - R.y) + palL(U[19].x + 0.66, 0.05) * sat(0.5 + R.x);
  let gloss = (spec + env * fres * 2.0) * wet;

  let c = floorC * (1.0 - cover) + body * cover + gloss + burn;
  return vec4f(c, 1.0);
}`;

type Stroke = { x: number; y: number; age: number; hue: number; ux: number; uy: number; shear: number; rake: number };
type Ignition = { x: number; y: number; r: number; hue: number; kind: number; born: number };

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Two cascaded exponential followers: a critically damped ease. A step in the target comes in as an
 * S-curve (about 4 time constants to 90%), never as a jump or a kink.
 */
class Ease {
  private a = 0;
  value = 0;
  set(v: number): void {
    this.a = this.value = v;
  }
  step(target: number, tauUp: number, tauDown: number, dt: number): number {
    const k = 1 - Math.exp(-dt / (target > this.value ? tauUp : tauDown));
    this.a += (target - this.a) * k;
    this.value += (this.a - this.value) * k;
    return this.value;
  }
}

/** A note's attack: eases in over a quarter second, then fades. */
const noteEnvelope = (age: number) => smoothstep(0, 0.25, age) * Math.exp(-Math.max(0, age - 0.25) / 0.5);

type Pipes = {
  curl: GPUComputePipeline;
  velAdvect: GPUComputePipeline;
  divergence: GPUComputePipeline;
  jacobi: GPUComputePipeline;
  gradient: GPUComputePipeline;
  burn: GPUComputePipeline;
  dyeAdvect: GPUComputePipeline;
  prep: GPUComputePipeline;
  slope: GPUComputePipeline;
  blur1: GPUComputePipeline;
  blur2: GPUComputePipeline;
  resample: GPUComputePipeline;
  render: GPURenderPipeline;
};
type LayoutName = 'curl' | 'velAdvect' | 'divergence' | 'jacobi' | 'gradient' | 'burn' | 'dyeAdvect' | 'prep' | 'slope' | 'blur1' | 'blur2' | 'resample' | 'render';
/** Bind groups that never change: the velocity solver and the coarse light levels. */
type FixedGroups = {
  curl: GPUBindGroup;
  velAdvect: GPUBindGroup;
  divergence: GPUBindGroup;
  jacobi: [GPUBindGroup, GPUBindGroup];
  gradient: GPUBindGroup;
  slope: GPUBindGroup;
  blur2: GPUBindGroup;
};
/** Fixed textures: velocity (A holds the latest, with the pressure gradient in zw), burn state and paints (ping-pong). */
type Fixed = { velA: GPUTexture; carry: GPUTexture; g1: GPUTexture; g2: GPUTexture; slope: GPUTexture; bn: GPUTexture[]; p0: GPUTexture[]; p1: GPUTexture[] };
/** The resolution-dependent part: the ink (A the latest, B the advection target) and its surface. Groups indexed by burn parity. */
type Grid = {
  dw: number;
  dh: number;
  dyeA: GPUTexture;
  dyeB: GPUTexture;
  shade: GPUTexture;
  burn: GPUBindGroup[];
  dyeAdvect: GPUBindGroup[];
  prep: GPUBindGroup;
  blur1: GPUBindGroup;
  render: GPUBindGroup[];
};

class LiquidInstance implements SceneInstance {
  readonly meta = META;
  private readonly u = new Float32Array(UVEC * 4);
  private readonly morph = new Morph(1);
  private lastT = -1;
  private seed = -1;
  private dt = 0;
  private reset = true;
  private prevPitch = 0;
  private turn = 0;
  private turnTarget = 0;
  private readonly jet = new Ease();
  private readonly emit = new Ease();
  private readonly pitch = new Ease();
  private hue = 0;
  private burnAcc = 0;
  private burnSteps = 0;
  /** Burn parity: bn[bp] is the latest burn state, bn[1 - bp] the one before. */
  private bp = 0;
  private strokes: Stroke[] = [];
  /** Live ignitions: each keeps lighting the ink under it until its time is up. */
  private ignitions: Ignition[] = [];
  private note: Ignition | null = null;
  private noteFrom: [number, number] = [0, 0];
  private clock = 0;
  private grid: Grid | null = null;
  /** Textures replaced by a resize, destroyed once the frame that last used them is submitted. */
  private retired: GPUTexture[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly group0: GPUBindGroup,
    private readonly paramBuffer: GPUBuffer,
    private readonly uBuffer: GPUBuffer,
    private readonly pipes: Pipes,
    private readonly layouts: Record<LayoutName, GPUBindGroupLayout>,
    private readonly groups: FixedGroups,
    private readonly fixed: Fixed,
    private readonly owned: (GPUTexture | GPUBuffer)[],
  ) {}

  private bind(l: GPUBindGroupLayout, ...ts: GPUTexture[]): GPUBindGroup {
    return this.device.createBindGroup({
      layout: l,
      entries: [{ binding: 0, resource: { buffer: this.uBuffer } }, ...ts.map((t, i) => ({ binding: i + 1, resource: t.createView() }))],
    });
  }

  /** Builds the ink grid for a render target, carrying the old ink across when there is one. */
  private resize(encoder: GPUCommandEncoder, width: number, height: number): Grid {
    // One ink texel per screen pixel over the visible part of the bath (cover fit, then the zoom).
    const cover = Math.max(width, height * ASPECT) / ZOOM;
    const dw = Math.round(Math.min(MAX_DW, Math.max(MIN_DW, cover)) / 8) * 8;
    const dh = Math.round(dw / ASPECT);
    const old = this.grid;
    if (old && old.dw === dw && old.dh === dh) return old;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const tex = (label: string) => this.device.createTexture({ label: `liquid-light-${label}`, size: [dw, dh], format: 'rgba16float', usage });
    const dyeA = tex('dyeA');
    const dyeB = tex('dyeB');
    const shade = tex('shade');
    const L = this.layouts;
    const X = this.fixed;
    const b = (l: GPUBindGroupLayout, ...ts: GPUTexture[]) => this.bind(l, ...ts);
    const grid: Grid = {
      dw,
      dh,
      dyeA,
      dyeB,
      shade,
      burn: [0, 1].map((k) => b(L.burn, X.bn[k], dyeA, X.bn[1 - k], X.p0[1 - k], X.p1[1 - k])),
      dyeAdvect: [0, 1].map((k) => b(L.dyeAdvect, dyeA, X.carry, dyeB, X.g2, X.bn[k], X.p0[k])),
      prep: b(L.prep, dyeA, shade, X.velA, X.slope),
      blur1: b(L.blur1, dyeA, X.g1),
      render: [0, 1].map((k) => b(L.render, dyeA, shade, X.g1, X.g2, X.bn[k], X.bn[1 - k], X.p0[k], X.p1[k])),
    };
    if (old) {
      // Carry the ink across: nothing resets when the resolution changes.
      const cp = encoder.beginComputePass({ label: 'liquid-light-resample' });
      cp.setBindGroup(0, this.group0);
      cp.setPipeline(this.pipes.resample);
      cp.setBindGroup(1, b(L.resample, old.dyeA, dyeA));
      cp.dispatchWorkgroups(Math.ceil(dw / 8), Math.ceil(dh / 8));
      cp.end();
      this.retired.push(old.dyeA, old.dyeB, old.shade);
    }
    this.grid = grid;
    return grid;
  }

  update(ctx: SceneUpdateContext): void {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const seek = this.lastT < 0 || Math.abs(m.time - this.lastT - dt) > 0.5 || g[0] !== this.seed;
    this.lastT = m.time;
    this.seed = g[0];
    const mo = this.morph;
    mo.update(m, ctx.dt, g);
    const at = mo.at;

    // Chord colour: the root around the circle of fifths, eased the short way round.
    const root = m.chord && m.chord.root >= 0 ? m.chord.root : 0;
    // Each phrase turns the inks somewhere new on the wheel (the morph's phrase jumps, eased in).
    const hueTarget = g[3] + ((root * 7) % 12) / 12 + (m.chord?.quality.startsWith('m') ? 0.08 : 0) + 0.3 * Math.sin(mo.flowAt[5] * 0.5);
    if (seek) {
      this.reset = true;
      this.strokes = [];
      this.ignitions = [];
      this.note = null;
      this.prevPitch = m.leadPitch;
      this.turn = this.turnTarget = 0;
      this.jet.set(0);
      this.emit.set(0);
      this.pitch.set(Math.max(-1.2, Math.min(1.2, m.leadPitch)));
      this.hue = hueTarget;
      this.burnAcc = 0;
      this.clock = 0;
    }
    this.clock += dt;
    const dh = ((((hueTarget - this.hue + 0.5) % 1) + 1) % 1) - 0.5;
    this.hue += dh * (1 - Math.exp(-dt / 0.6));

    // Emitter layout from the morph: an arc around a centre, pitch picks the point on it.
    const cx = ASPECT * 0.5 + 0.2 * Math.sin(at[0]);
    const cy = 0.5 + 0.1 * Math.sin(at[1]);
    const theta0 = at[2] * 0.5 + g[4] * TAU;
    const span = wave(at[3], 1.2, 2.8);
    const rad = wave(at[4], 0.26, 0.4);
    // The stream swirls round the centre (either way) rather than pours into it.
    const jetAng = (g[5] > 0.5 ? 1 : -1) * wave(at[5], 0.55, 1.35);
    // The emitter glides to each new pitch along its arc instead of jumping there.
    const pitch = this.pitch.step(Math.max(-1.2, Math.min(1.2, m.leadPitch)), 0.06, 0.06, dt);
    const th = theta0 + pitch * span * 0.5;
    const jx = cx + Math.cos(th) * rad * 1.35;
    const jy = cy + Math.sin(th) * rad;
    // The sound's ink: a third of the wheel from the chord ink, spread by pitch, turned by the
    // spectral centroid (bright sounds one way round, dark ones the other).
    const jetHue = fract(this.hue + 0.33 + pitch * 0.3 + (m.centroid - 0.5) * 0.5);

    const live = !seek && dt > 0;
    const e = m.energySlow;
    for (const s of this.strokes) s.age += dt;
    if (live && mo.leadAge === 0) {
      const iv = (m.leadPitch - this.prevPitch) * 12;
      this.turnTarget = Math.max(-0.6, Math.min(0.6, iv * 0.07));
      this.prevPitch = m.leadPitch;
      // The note lights its own stream: from where its ink enters to a good way down the flow.
      const sa = th + Math.PI + jetAng + this.turn;
      this.note = { x: jx + Math.cos(sa) * 0.5, y: jy + Math.sin(sa) * 0.5, r: 0.2, hue: fract(jetHue + 0.08), kind: 2, born: this.clock };
      this.noteFrom = [jx, jy];
    }
    if (live && mo.kickAge === 0) {
      // Each kick lights the ink at four points of a new place (a golden-angle walk over the bath),
      // in the next colour.
      const k = mo.kicks;
      const ka = theta0 + 2.39996 * k;
      const kr = Math.sqrt(((k * 0.618034) % 1) * 0.8 + 0.2);
      const x = ASPECT * 0.5 + Math.cos(ka) * kr * (ASPECT * 0.5 - 0.15);
      const y = 0.5 + Math.sin(ka) * kr * 0.36;
      const hue = fract(this.hue + 0.43 * k + 0.15);
      const r = 0.14 + 0.05 * e;
      this.ignitions.push({ x, y, r, hue, kind: 0, born: this.clock });
      this.ignitions.push({ x: x + 0.22 * Math.cos(ka + 1.7), y: y + 0.16 * Math.sin(ka + 1.7), r: r * 0.8, hue, kind: 0, born: this.clock });
      this.ignitions.push({ x: x + 0.22 * Math.cos(ka - 1.9), y: y + 0.16 * Math.sin(ka - 1.9), r: r * 0.8, hue, kind: 0, born: this.clock });
      this.ignitions.push({ x: x + 0.3 * Math.cos(ka + 3.5), y: y + 0.2 * Math.sin(ka + 3.5), r: r * 0.7, hue, kind: 0, born: this.clock });
    }
    if (live && mo.snareAge === 0) {
      // Each snare combs a line across the bath through a point near the centre, at a new angle.
      const n = mo.snares;
      const sa = theta0 * 0.7 + 2.0 + 1.94 * n + 0.6 * Math.sin(at[6]);
      const ux0 = Math.cos(sa);
      const uy0 = Math.sin(sa) * 0.6;
      const ul = Math.hypot(ux0, uy0);
      const px = cx + 0.25 * Math.sin(n * 2.7);
      const py = cy + 0.15 * Math.cos(n * 1.9);
      // The stylus starts just short of the centre point, inside the bath, so the stroke answers the
      // snare at once.
      const back = STROKE;
      this.strokes.unshift({
        x: px - (ux0 / ul) * back,
        y: py - (uy0 / ul) * back,
        age: dt,
        hue: fract(this.hue + 0.5 + 0.13 * n),
        ux: ux0 / ul,
        uy: uy0 / ul,
        shear: (Math.sin(n * 1.3) > 0 ? 1 : -1) * (0.05 + 0.03 * e),
        rake: n % 4 === 0 ? 0.13 + 0.05 * Math.sin(n * 0.9) : 0,
      });
    }
    this.strokes.length = Math.min(this.strokes.length, SNARE_WAVES);
    // Ignitions grow from a point to full size over IGN_GROW (nothing lights up at once), then end.
    const alive = (s: Ignition) => this.clock - s.born < IGN_GROW + 0.05;
    const grown = (s: Ignition) => smoothstep(0, IGN_GROW, this.clock - s.born + dt);
    this.ignitions = this.ignitions.filter(alive).slice(-4);
    if (this.note && !alive(this.note)) this.note = null;
    this.turn += (this.turnTarget - this.turn) * (1 - Math.exp(-dt / 0.3));

    // The emitter: the melody opens it fully (eased in over about a quarter second, out over about
    // a second, never a shove), and the sound keeps it streaming at a rate set by the spectral flux.
    const attackLight = noteEnvelope(mo.leadAge);
    const jetTarget = Math.min(1, Math.max(m.leadHeld, 0.8 * attackLight));
    const jet = this.jet.step(jetTarget, 0.06, 0.2, dt);
    const emitTarget = Math.min(1, 1.4 * m.flux + 0.3 * m.energy) * mo.flow;
    const emit = this.emit.step(emitTarget, 0.06, 0.25, dt);
    const open = Math.max(jet, 0.55 * emit);

    const u = this.u;
    u.fill(0);
    const flow = mo.flow;
    u[0] = dt;
    u[1] = this.reset ? 1 : 0;
    u[2] = jetHue;
    u[3] = (g[0] * 7.13 + g[7]) % 1; // opening bath layout
    u[4] = 1.9 - 0.7 * e; // velocity damping (viscosity): energy thins the liquid
    u[5] = 0.05 + 0.15 * e; // ink fade
    u[6] = 0.3 + 0.4 * flow; // vorticity confinement
    u[7] = 1.0; // exposure

    // Steady current: strength from morph.flow, layout carried by the morph coordinates (kicks and
    // snares step them, so each hit leaves the current in a new lasting arrangement).
    const wa = at[6] * 0.5 + g[5] * TAU;
    // The music's weight churns the bath: drive stirs harder, a drop churns it for several bars.
    const churn = (0.5 + 1.0 * mo.drive) * (1 + 5.0 * mo.surge);
    u[8] = (0.035 + 0.05 * Math.sin(wa)) * flow * (0.6 + 0.8 * g[6]) * churn; // pool turn
    u[9] = 0.055 * flow * churn; // simulation stirring
    u[10] = 0.02 * flow * churn; // carried gyre
    u[11] = TAU / wave(at[7], 0.6, 1.8);
    u[12] = at[6] * 0.6 + g[1] * TAU;
    u[13] = at[7] * 0.6 + g[2] * TAU;
    const gr = g[7] * TAU + at[0] * 0.15;
    u[14] = Math.cos(gr);
    u[15] = Math.sin(gr);

    // Emitter, aimed inward, turned by the stream angle and the contour; its size from the bass,
    // its brightness from the highs.
    const ang = th + Math.PI + jetAng + this.turn;
    const speed = (0.18 + 0.12 * e) * open;
    u[16] = jx;
    u[17] = jy;
    u[18] = Math.cos(ang) * speed;
    u[19] = Math.sin(ang) * speed;
    u[20] = 1 - Math.exp(-dt * 10 * open);
    u[21] = 0.026 + 0.022 * Math.min(1, m.bass);
    u[22] = dt * (open * (1.1 + 1.0 * e) + 6 * attackLight * attackLight);
    u[23] = 1 + 1.3 * attackLight + 0.25 * Math.min(1, m.high);

    // Ignitions. The note's runs from where its ink enters down its stream as it grows (a fuse).
    if (this.note) {
      const s = this.note;
      const k = grown(s);
      u[40] = this.noteFrom[0] + (s.x - this.noteFrom[0]) * k;
      u[41] = this.noteFrom[1] + (s.y - this.noteFrom[1]) * k;
      u[42] = s.r * k;
      u[43] = s.hue + 2 * s.kind;
      u[50] = this.noteFrom[0];
      u[51] = this.noteFrom[1];
    }
    for (let j = 0; j < 4; j++) {
      const s = this.ignitions[j];
      if (!s) continue;
      u[24 + j * 4] = s.x;
      u[25 + j * 4] = s.y;
      u[26 + j * 4] = s.r;
      u[52 + j] = grown(s);
      u[27 + j * 4] = s.hue + 2 * s.kind;
    }
    // The newest snare's stylus lights the ink along its stroke as it passes (a fuse).
    const st = this.strokes[0];
    if (st && st.age < STROKE_T + 0.2) {
      const a = -0.25 + STYLUS_V * st.age;
      u[44] = st.x + st.ux * a;
      u[45] = st.y + st.uy * a;
      u[46] = 0.035;
      u[47] = st.hue + 2;
      u[48] = st.x - st.ux * 0.25;
      u[49] = st.y - st.uy * 0.25;
    }
    for (let j = 0; j < SNARE_WAVES; j++) {
      const s = this.strokes[j];
      const b = 56 + j * 4;
      const x = 64 + j * 4;
      if (!s) {
        u[b + 2] = 99;
        continue;
      }
      u[b] = s.x;
      u[b + 1] = s.y;
      u[b + 2] = s.age;
      u[b + 3] = s.hue;
      u[x] = s.ux;
      u[x + 1] = s.uy;
      u[x + 2] = s.shear;
      u[x + 3] = s.rake;
    }

    // Render.
    u[72] = -0.45;
    u[73] = -0.55;
    u[74] = 0.7;
    u[75] = 1.0; // specular
    u[76] = this.hue + 0.5; // pool hue
    u[77] = 0.01; // pool luminance
    u[78] = ZOOM;
    u[79] = 600; // pressure relief
    u[80] = 0.009; // bump
    u[81] = 0.025; // refraction
    u[83] = this.hue; // the opening bath's base ink
    // Burn: a whole number of fixed steps per frame, so its speed is the same at any frame rate. The
    // picture interpolates between the last two steps by the leftover fraction, so fronts glide
    // instead of stepping when the frame rate and the burn rate do not divide. A reset runs two
    // steps so both burn buffers are clear.
    this.burnAcc += dt * BURN_RATE;
    this.burnSteps = Math.min(24, Math.floor(this.burnAcc));
    this.burnAcc -= Math.floor(this.burnAcc);
    if (this.reset) this.burnSteps = Math.max(2, this.burnSteps);
    u[84] = 1 / BURN_RATE;
    u[85] = 0.08; // heat time constant: a narrow hot edge
    u[86] = 0.5; // embers and spent fuel
    u[DIMS * 4 + 2] = this.burnAcc;
    this.dt = dt;
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    for (const t of this.retired) t.destroy();
    this.retired = [];
    const grid = this.resize(encoder, width, height);
    const u = this.u;
    u[DIMS * 4] = grid.dw;
    u[DIMS * 4 + 1] = grid.dh;
    u[DIMS * 4 + 3] = grid.dh / REF_DH;
    this.device.queue.writeBuffer(this.uBuffer, 0, u);
    const P = this.pipes;
    const G = this.groups;
    const vx = Math.ceil(VW / 8);
    const vy = Math.ceil(VH / 8);
    const dx = Math.ceil(grid.dw / 8);
    const dy = Math.ceil(grid.dh / 8);
    if (this.dt > 0 || this.reset) {
      const cp = encoder.beginComputePass({ label: 'liquid-light-sim' });
      cp.setBindGroup(0, this.group0);
      const run = (pipe: GPUComputePipeline, group: GPUBindGroup, x: number, y: number) => {
        cp.setPipeline(pipe);
        cp.setBindGroup(1, group);
        cp.dispatchWorkgroups(x, y);
      };
      run(P.curl, G.curl, vx, vy);
      run(P.velAdvect, G.velAdvect, vx, vy);
      run(P.divergence, G.divergence, vx, vy);
      for (let k = 0; k < JACOBI; k++) run(P.jacobi, G.jacobi[k & 1], vx, vy);
      run(P.gradient, G.gradient, vx, vy);
      for (let k = 0; k < this.burnSteps; k++) {
        run(P.burn, grid.burn[this.bp], Math.ceil(BW / 8), Math.ceil(BH / 8));
        this.bp ^= 1;
      }
      run(P.dyeAdvect, grid.dyeAdvect[this.bp], dx, dy);
      cp.end();
      encoder.copyTextureToTexture({ texture: grid.dyeB }, { texture: grid.dyeA }, [grid.dw, grid.dh]);
      const pp = encoder.beginComputePass({ label: 'liquid-light-prep' });
      pp.setBindGroup(0, this.group0);
      pp.setPipeline(P.blur1);
      pp.setBindGroup(1, grid.blur1);
      pp.dispatchWorkgroups(Math.ceil(G1W / 8), Math.ceil(G1H / 8));
      pp.setPipeline(P.slope);
      pp.setBindGroup(1, G.slope);
      pp.dispatchWorkgroups(Math.ceil(G1W / 8), Math.ceil(G1H / 8));
      pp.setPipeline(P.blur2);
      pp.setBindGroup(1, G.blur2);
      pp.dispatchWorkgroups(Math.ceil(G2W / 8), Math.ceil(G2H / 8));
      pp.setPipeline(P.prep);
      pp.setBindGroup(1, grid.prep);
      pp.dispatchWorkgroups(dx, dy);
      pp.end();
      this.reset = false;
    }
    const pass = encoder.beginRenderPass({
      label: 'liquid-light',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(P.render);
    pass.setBindGroup(0, this.group0);
    pass.setBindGroup(1, grid.render[this.bp]);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.paramBuffer.destroy();
    for (const r of this.owned) r.destroy();
    for (const t of this.retired) t.destroy();
    if (this.grid) for (const t of [this.grid.dyeA, this.grid.dyeB, this.grid.shade]) t.destroy();
  }
}

type Slot = 'tex' | 'utex' | 'out16' | 'out32';

const factory: SceneFactory = {
  meta: META,
  async create(device: GPUDevice, shared: SharedResources) {
    const prelude = `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${HEAD}`;
    const C = GPUShaderStage.COMPUTE;
    const layout = (slots: Slot[], vis: number) =>
      device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: vis, buffer: { type: 'uniform' } },
          ...slots.map((s, i): GPUBindGroupLayoutEntry => {
            const binding = i + 1;
            if (s === 'tex') return { binding, visibility: vis, texture: { sampleType: 'float' } };
            if (s === 'utex') return { binding, visibility: vis, texture: { sampleType: 'unfilterable-float' } };
            return { binding, visibility: vis, storageTexture: { access: 'write-only', format: s === 'out16' ? 'rgba16float' : 'r32float' } };
          }),
        ],
      });
    const specs = {
      curl: { code: CURL, slots: ['tex', 'out32'] as Slot[] },
      velAdvect: { code: VEL_ADVECT, slots: ['tex', 'utex', 'out16'] as Slot[] },
      divergence: { code: DIVERGENCE, slots: ['tex', 'out32'] as Slot[] },
      jacobi: { code: JACOBI_WGSL, slots: ['utex', 'utex', 'out32'] as Slot[] },
      gradient: { code: GRADIENT, slots: ['tex', 'utex', 'out16', 'out16'] as Slot[] },
      burn: { code: BURN, slots: ['tex', 'tex', 'out16', 'out16', 'out16'] as Slot[] },
      dyeAdvect: { code: DYE_ADVECT, slots: ['tex', 'tex', 'out16', 'tex', 'tex', 'tex'] as Slot[] },
      prep: { code: PREP, slots: ['tex', 'out16', 'tex', 'tex'] as Slot[] },
      slope: { code: SLOPE, slots: ['tex', 'out16'] as Slot[] },
      blur1: { code: blurWgsl(G1W, G1H, 2, true), slots: ['tex', 'out16'] as Slot[] },
      blur2: { code: blurWgsl(G2W, G2H, 3, false), slots: ['tex', 'out16'] as Slot[] },
      resample: { code: RESAMPLE, slots: ['tex', 'out16'] as Slot[] },
    };
    type Name = keyof typeof specs;
    const names = Object.keys(specs) as Name[];
    const layouts = {
      ...(Object.fromEntries(names.map((n) => [n, layout(specs[n].slots, C)])) as Record<Name, GPUBindGroupLayout>),
      render: layout(Array<Slot>(8).fill('tex'), GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX),
    };
    const computes = await Promise.all(
      names.map(async (n) => {
        const module = await compileModule(device, `${prelude}\n${specs[n].code}`, `liquid-light-${n}`);
        return device.createComputePipelineAsync({
          label: `liquid-light-${n}`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, layouts[n]] }),
          compute: { module, entryPoint: 'main' },
        });
      }),
    );
    const rModule = await compileModule(device, `${prelude}\n${RENDER}`, 'liquid-light-draw');
    const render = await device.createRenderPipelineAsync({
      label: 'liquid-light-draw',
      layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, layouts.render] }),
      vertex: { module: rModule, entryPoint: 'vs' },
      fragment: { module: rModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
    });
    const pipes = { ...(Object.fromEntries(names.map((n, i) => [n, computes[i]])) as Record<Name, GPUComputePipeline>), render };

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const tex = (label: string, w: number, h: number, format: GPUTextureFormat) =>
      device.createTexture({ label: `liquid-light-${label}`, size: [w, h], format, usage });
    const velA = tex('velA', VW, VH, 'rgba16float');
    const velB = tex('velB', VW, VH, 'rgba16float');
    const carry = tex('carry', VW, VH, 'rgba16float');
    const curl = tex('curl', VW, VH, 'r32float');
    const div = tex('div', VW, VH, 'r32float');
    const pA = tex('pA', VW, VH, 'r32float');
    const pB = tex('pB', VW, VH, 'r32float');
    const g1 = tex('glow1', G1W, G1H, 'rgba16float');
    const g2 = tex('glow2', G2W, G2H, 'rgba16float');
    const slope = tex('slope', G1W, G1H, 'rgba16float');
    const bn = [tex('burnA', BW, BH, 'rgba16float'), tex('burnB', BW, BH, 'rgba16float')];
    const p0 = [tex('paint0A', BW, BH, 'rgba16float'), tex('paint0B', BW, BH, 'rgba16float')];
    const p1 = [tex('paint1A', BW, BH, 'rgba16float'), tex('paint1B', BW, BH, 'rgba16float')];
    const uBuffer = device.createBuffer({ label: 'liquid-light-u', size: UVEC * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bind = (l: GPUBindGroupLayout, ...ts: GPUTexture[]) =>
      device.createBindGroup({
        layout: l,
        entries: [{ binding: 0, resource: { buffer: uBuffer } }, ...ts.map((t, i) => ({ binding: i + 1, resource: t.createView() }))],
      });
    const groups: FixedGroups = {
      curl: bind(layouts.curl, velA, curl),
      velAdvect: bind(layouts.velAdvect, velA, curl, velB),
      divergence: bind(layouts.divergence, velB, div),
      jacobi: [bind(layouts.jacobi, pA, div, pB), bind(layouts.jacobi, pB, div, pA)],
      gradient: bind(layouts.gradient, velB, pA, velA, carry),
      slope: bind(layouts.slope, g1, slope),
      blur2: bind(layouts.blur2, g1, g2),
    };
    const paramBuffer = shared.createSceneParamBuffer('liquid-light-params');
    const group0 = shared.createSceneBindGroup(paramBuffer, 'liquid-light');
    const fixed: Fixed = { velA, carry, g1, g2, slope, bn, p0, p1 };
    const owned = [velA, velB, carry, curl, div, pA, pB, g1, g2, slope, ...bn, ...p0, ...p1, uBuffer];
    return new LiquidInstance(device, group0, paramBuffer, uBuffer, pipes, layouts, groups, fixed, owned);
  },
};

export default factory;
