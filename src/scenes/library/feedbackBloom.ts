import { compileModule } from '../../gpu/context';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { Morph, wave } from '../morph';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Feedback Bloom: a video-feedback loop done the modern way. Light ribbons drawn by the sound stream
 * out of a black core along a slow logarithmic spiral, so you look down a vortex of glossy neon
 * filaments that keeps blooming toward you.
 *
 * The loop (one compute pass on a float buffer) is the classic one, a zoom, a turn and a warp of the
 * previous frame, but with the parts that make old Winamp feedback look dated replaced:
 *  - the warp is a smooth divergence-free field (two stream functions laid out by the morph), traced
 *    back in two midpoint steps, so the trails fold and marble instead of repeating as nested copies;
 *  - history is fetched with a Catmull-Rom filter and a neighbourhood clamp plus a light unsharp
 *    term, so filaments stay crisp for seconds instead of smearing into mush;
 *  - colour ages by absorption (the weaker channels decay first), so hot strokes saturate as they
 *    cool, instead of a rainbow hue cycle;
 *  - the image is lit as a height field (gloss, a fresnel sheen and dispersion across each
 *    filament's edge), so it reads as glossy liquid light rather than a flat smear.
 *
 * The sound makes the matter: five pens, one per spectral band, draw ribbons whose width and light
 * follow their band's energy and whose colour follows the spectral centroid; a sixth pen draws the
 * melody, its distance from the core set by the pitch, so each phrase leaves a stepped contour
 * flowing out through the vortex. Chords turn the palette; the morph lays out the flow.
 *
 * Beats burn through the ribbons: an excitable medium on a coarse grid, carried by the same flow and
 * conducted only where there is light, so a front runs along each filament at a finite speed with a
 * ragged edge and leaves it recoloured for good. The kick ignites the bass pens deep in the core
 * (fire: white, yellow, orange embers), the snare ignites the upper pens (a fast electric front in a
 * second colour), each melody note ignites its own pen in the note's colour. Each kick and snare also
 * steps the pens' colour, so new matter is born in the colour the front leaves behind.
 */

/**
 * The colour field covers a 16:9 domain, cover-fitted to the screen, at one texel per screen pixel
 * (sized from the render target in encode, capped). The burn grid is coarse and fixed: it only
 * says where fronts are, and is always read through smooth filters.
 */
const ASPECT = 16 / 9;
const MAX_SW = 2560;
const MIN_SW = 320;
/** The original colour grid height: lengths tuned in texels of it are kept in physical units. */
const REF_SH = 720;
const BW = 320;
const BH = 180;
const UVEC = 58;
const PEN0 = 6;
const IGN0 = 30;
const KIND0 = 42;
const LIGHT = 54;
const FIN = 55;
const OPEN = 56;
const DIMS = 57;
const PENS = 6;
const IGN = 12;
/** Burn steps per second: a front advances about one coarse cell per step (two for snares). */
const BURN_RATE = 80;
/** Ignitions grow from a point to full size over this long (no beat lights anything at once). */
const IGN_GROW = 0.25;
const TAU = Math.PI * 2;
const fract = (x: number) => x - Math.floor(x);

/** The shader's steady flow (fb_flow) on the CPU, so pens draw in the moving medium's frame. */
function flowAt(u: Float32Array, x: number, y: number): [number, number] {
  const dx = x - u[4];
  const dy = y - u[5];
  let vx = dx * u[6] - dy * u[7];
  let vy = dy * u[6] + dx * u[7];
  const c = u[17];
  const s = u[18];
  const px = c * x + s * y;
  const py = -s * x + c * y;
  const a1 = u[9] * px + u[12];
  const b1 = u[9] * py + u[13];
  const a2 = u[16] * px + u[14];
  const b2 = u[16] * py + u[15];
  const gx = Math.cos(a1) * Math.sin(b1) + 0.55 * Math.cos(a2) * Math.sin(b2);
  const gy = Math.sin(a1) * Math.cos(b1) + 0.55 * Math.sin(a2) * Math.cos(b2);
  const wx = gy * u[8];
  const wy = -gx * u[8];
  const d = Math.hypot(dx, dy) / 0.2;
  const fade = d >= 1 ? 1 : d * d * (3 - 2 * d);
  vx += (c * wx - s * wy) * fade;
  vy += (s * wx + c * wy) * fade;
  return [vx, vy];
}

const META: SceneMeta = {
  id: 'feedback-bloom',
  name: 'Feedback Bloom',
  // Out of the show until fixed (gate: reactions do not register and motion does not follow the music).
  auto: false,
  energy: [0, 1],
  mood: { valence: 0.6, arousal: 0.6 },
  genres: { edm: 1, techno: 0.9, synthwave: 1, dnb: 0.8, dubstep: 0.7, pop: 0.7, ambient: 0.7, hiphop: 0.6, rock: 0.5, lofi: 0.6, jazz: 0.5, classical: 0.5, acoustic: 0.4 },
  trails: 0,
  kaleido: false,
};

/*
 * Uniform layout (vec4 slots of U):
 *  0 dt, reset, seed, burn step (s)        1 focal x, y, expansion, swirl
 *  2 curl amp, k1, self pull, decay tau    3 curl phases (a1, b1, a2, b2)
 *  4 k2, curl cos, curl sin, sharpen       5 aging, heat tau, ember tau, base hue
 *  6-29 pens, four slots each: (x0, y0, x1, y1), (hue, width, light, core), (spec lo, spec hi,
 *    dir x, dir y), (tines, spacing, hue spread, -)
 *  30-41 ignitions (x, y, radius, hue)     42-53 ignition (kind, growth 0..1, -, -)
 *  54 light xyz, specular                  55 bump, dispersion, -, core radius
 *  56 opening layout (arms, twist, hue spread, -)
 *  57 colour grid (width, height), burn interpolation (0..1 between the last two steps), -
 */
const HEAD = /* wgsl */ `
const BW: i32 = ${BW};
const BH: i32 = ${BH};
const ASPECT: f32 = ${ASPECT};
@group(1) @binding(0) var<uniform> U: array<vec4f, ${UVEC}>;

fn fb_chroma(c: vec3f) -> f32 {
  let hi = max(c.r, max(c.g, c.b));
  return (hi - min(c.r, min(c.g, c.b))) / max(hi, 1e-4);
}
fn fb_rot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}
// How far apart two colours' hues are: 0 the same, 1 a quarter turn, 2 opposite.
fn fb_apart(a: vec3f, b: vec3f) -> f32 {
  let da = a - dot(a, vec3f(0.33333));
  let db = b - dot(b, vec3f(0.33333));
  return 1.0 - dot(da, db) / max(length(da) * length(db), 1e-6);
}
// A saturated colour from the palette's coloured entries (a grey entry is replaced by the most
// colourful one turned round the hue circle), normalised to its brightest channel.
fn ink(h: f32) -> vec3f {
  let c0 = F.pal0.rgb;
  let c1 = F.pal1.rgb;
  let c2 = F.pal2.rgb;
  let s0 = fb_chroma(c0);
  let s1 = fb_chroma(c1);
  let s2 = fb_chroma(c2);
  var best = c1;
  var sb = s1;
  if (s2 > sb) { best = c2; sb = s2; }
  if (s0 > sb) { best = c0; }
  // Three distinct inks whatever the scheme: a grey entry, or one whose hue repeats an earlier
  // ink's, is replaced by that ink turned a third of the way round the wheel (blended smoothly, so a
  // changing palette never pops).
  let k0 = mix(fb_rot(best, 2.3), c0, smoothstep(0.1, 0.3, s0));
  let k1 = mix(fb_rot(k0, 2.1), c1, smoothstep(0.1, 0.3, s1) * smoothstep(0.35, 0.7, fb_apart(c1, k0)));
  let k2 = mix(fb_rot(k0, -2.1), c2, smoothstep(0.1, 0.3, s2) * smoothstep(0.35, 0.7, min(fb_apart(c2, k0), fb_apart(c2, k1))));
  let x = fract(h) * 3.0;
  let f = smoothstep(0.0, 1.0, fract(x));
  let c = select(select(mix(k2, k0, f), mix(k1, k2, f), x < 2.0), mix(k0, k1, f), x < 1.0);
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let sv = (hi - lo) / max(hi, 1e-4);
  let n = (c - lo) / max(hi - lo, 1e-4);
  return mix(vec3f(1.0), n, mix(0.6, 0.9, sat(sv * 2.0)));
}
fn fb_dims() -> vec2f { return U[${DIMS}].xy; }
// Sim coordinates: height units, centred, y down.
// Cubic B-spline filtering from four bilinear taps: the coarse burn grid reads smooth.
fn fb_bspline(t: texture_2d<f32>, uv: vec2f) -> vec4f {
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
// The front's colour where it passes, from the burn paint (rgb its ink, halved for a kick's fire;
// a its presence) read through the B-spline: neighbouring fronts blend smoothly, never in blocks.
// Returns the ink normalised to its brightest channel, and in w how much of it is a kick's fire.
fn fb_frontInk(P: vec4f) -> vec4f {
  if (P.a < 1e-3) { return vec4f(1.0, 1.0, 1.0, 0.0); }
  let c = max(P.rgb / P.a, vec3f(0.0));
  let amp = max(max(c.r, max(c.g, c.b)), 1e-3);
  return vec4f(c / amp, sat((1.0 - amp) * 2.0));
}
fn fb_q(uv: vec2f) -> vec2f { return (uv - 0.5) * vec2f(ASPECT, 1.0); }
fn fb_uv(q: vec2f) -> vec2f { return q / vec2f(ASPECT, 1.0) + 0.5; }
// The steady flow: a logarithmic spiral out of the focal point (expansion plus swirl) and a
// divergence-free warp from two stream functions psi = sin(a)sin(b), in a frame turned by the morph.
fn fb_flow(q: vec2f) -> vec2f {
  let d = q - U[1].xy;
  var v = d * U[1].z + vec2f(-d.y, d.x) * U[1].w;
  let c = U[4].y;
  let s = U[4].z;
  let p = vec2f(c * q.x + s * q.y, -s * q.x + c * q.y);
  let a1 = U[2].y * p.x + U[3].x;
  let b1 = U[2].y * p.y + U[3].y;
  let a2 = U[4].x * p.x + U[3].z;
  let b2 = U[4].x * p.y + U[3].w;
  let dx = cos(a1) * sin(b1) + 0.55 * cos(a2) * sin(b2);
  let dy = sin(a1) * cos(b1) + 0.55 * sin(a2) * cos(b2);
  let vp = vec2f(dy, -dx) * U[2].x;
  // The warp fades in the core so the vortex keeps a clean centre.
  return v + vec2f(c * vp.x - s * vp.y, s * vp.x + c * vp.y) * smoothstep(0.0, 0.2, length(d));
}
`;

/**
 * Burn: an excitable medium on a coarse grid, advected by the flow. A ready cell catches with a
 * chance that grows with the heat round it and with its fuel (the light of the ribbons under it),
 * so fronts run only along the filaments, ragged and at a finite speed. Snare fronts reach two cells.
 * Besides its state it writes the paint the other passes read smoothly: the front's ink times its
 * presence (halved for a kick, whose front burns as fire), and the presence.
 */
const BURN = /* wgsl */ `
@group(1) @binding(1) var bIn: texture_2d<f32>;
@group(1) @binding(2) var colIn: texture_2d<f32>;
@group(1) @binding(3) var bOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var pOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(5) var hOut: texture_storage_2d<rgba16float, write>;
fn bAt(i: vec2i) -> vec4f { return textureLoad(bIn, clamp(i, vec2i(0), vec2i(BW - 1, BH - 1)), 0); }
fn fuelAt(uv: vec2f) -> f32 {
  // Bilinear taps two colour texels apart cover every colour texel under this cell, so thin
  // filaments count at any colour resolution.
  let t = 1.0 / fb_dims();
  let n = clamp(i32(ceil(fb_dims().y / f32(BH) * 0.5)), 2, 6);
  var m = 0.0;
  for (var y = 0; y < n; y++) {
    for (var x = 0; x < n; x++) {
      let o = (vec2f(f32(x), f32(y)) - 0.5 * f32(n - 1)) * 2.0 * t;
      m = max(m, luma(textureSampleLevel(colIn, sampClamp, uv + o, 0.0).rgb));
    }
  }
  return smoothstep(0.015, 0.1, m);
}
fn store(i: vec2i, o: vec4f) {
  textureStore(bOut, i, o);
  let pres = sat(max(o.x, o.y) * 4.0);
  let amp = select(1.0, 0.5, o.w < 0.99 && pres > 0.0);
  textureStore(pOut, i, vec4f(ink(o.z) * amp * pres, pres));
  // The heat as drawn: 4x(1 - x) is 0 the moment a cell catches (x = 1), swells to its peak as it
  // cools to half and fades after, so a front glows in instead of flashing.
  textureStore(hOut, i, vec4f(4.0 * o.x * (1.0 - o.x), 0.0, 0.0, 0.0));
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= BW || i.y >= BH) { return; }
  if (U[0].y > 0.5) { store(i, vec4f(0.0)); return; }
  let uv = (vec2f(i) + 0.5) / vec2f(f32(BW), f32(BH));
  let q = fb_q(uv);
  let h = U[0].w;
  let suv = fb_uv(q - fb_flow(q) * h);
  let s = textureSampleLevel(bIn, sampClamp, suv, 0.0);
  let fuel = fuelAt(uv);
  // Neighbours are read unfiltered at the advected cell, so each keeps its own kind and life.
  let bi = vec2i(floor(suv * vec2f(f32(BW), f32(BH))));
  var best = vec4f(0.0);
  var heat = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) { continue; }
      let n = bAt(bi + vec2i(x, y));
      let w = select(1.0, 0.7, x != 0 && y != 0);
      if (n.x > 0.4) { heat += w; if (n.x > best.x) { best = n; } }
    }
  }
  // Fronts also reach two cells, snare fronts three: fire runs, electricity races.
  for (var k = 0; k < 8; k++) {
    let dk = vec2f(cos(f32(k) * 0.785398 + 0.39), sin(f32(k) * 0.785398 + 0.39));
    let n2 = bAt(bi + vec2i(round(dk * 2.0)));
    if (n2.x > 0.4) { heat += 0.8; if (n2.x > best.x) { best = n2; } }
    let n3 = bAt(bi + vec2i(round(dk * 3.2)));
    if (n3.w >= 1.0 && n3.w < 1.9 && n3.x > 0.4) { heat += 0.7; if (n3.x > best.x) { best = n3; } }
  }
  // Each front carries a life that it spends as it spreads (w = kind + life / 2), so a kick's fire
  // runs a good way along the filaments and dies out instead of burning everything that touches it.
  let kind = floor(best.w);
  let life = (best.w - kind) * 2.0 - select(select(0.045, 0.035, kind < 1.5), 0.03, kind < 0.5);
  let chance = sat(heat * 0.3) * smoothstep(0.2, 0.6, fuel) * step(0.0, life);
  let roll = hash13(vec3f(vec2f(i), floor(best.x * 4096.0) + floor(s.y * 977.0) + U[0].z * 131.0));
  var o = vec4f(s.x * exp(-h / U[5].y), s.y * exp(-h / U[5].z), s.zw);
  let ready = s.x < 0.12 && s.y < 0.25;
  if (ready && roll < chance) { o = vec4f(1.0, 1.0, best.z, kind + 0.5 * max(life, 0.0)); }
  // Ignitions catch wherever there is fuel, even in old embers: a new beat relights old fibres. The
  // fibres in reach catch one by one as the ignition grows (K.y, 0 to 1 over IGN_GROW), each at its
  // own moment, mostly near the middle first: a ragged spread of sparks, not a disc or a ring
  // flashing at once. A cell it lit is not lit again, so it burns once and runs on.
  for (var j = 0; j < ${IGN}; j++) {
    let I = U[${IGN0} + j];
    let K = U[${KIND0} + j];
    let dI = length(q - I.xy) / max(I.z, 1e-4);
    let catchAt = 0.7 * hash13(vec3f(vec2f(i), fract(I.w * 7.7 + I.x * 3.1) * 911.0)) + 0.3 * dI;
    if (I.z > 0.0 && s.x < 0.12 && s.y < 0.75 && fuel > 0.1 && dI < 1.0 && catchAt < K.y) { o = vec4f(1.0, 1.0, I.w, K.x + 0.5); }
  }
  store(i, o);
}`;

/** The feedback step: advect, sharpen, age, inject the pens, recolour where the fronts pass. */
const STEP = /* wgsl */ `
@group(1) @binding(1) var colIn: texture_2d<f32>;
@group(1) @binding(2) var bIn: texture_2d<f32>;
@group(1) @binding(3) var pIn: texture_2d<f32>;
@group(1) @binding(4) var colOut: texture_storage_2d<rgba16float, write>;
// 5-tap Catmull-Rom history fetch: crisp under repeated resampling.
fn history(uv: vec2f) -> vec3f {
  let size = fb_dims();
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
  var r = textureSampleLevel(colIn, sampClamp, vec2f(t12.x, t0.y), 0.0).rgb * (w12.x * w0.y);
  r += textureSampleLevel(colIn, sampClamp, vec2f(t0.x, t12.y), 0.0).rgb * (w0.x * w12.y);
  r += textureSampleLevel(colIn, sampClamp, vec2f(t12.x, t12.y), 0.0).rgb * (w12.x * w12.y);
  r += textureSampleLevel(colIn, sampClamp, vec2f(t3.x, t12.y), 0.0).rgb * (w3.x * w12.y);
  r += textureSampleLevel(colIn, sampClamp, vec2f(t12.x, t3.y), 0.0).rgb * (w12.x * w3.y);
  let norm = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / norm, vec3f(0.0));
}
fn segDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = sat(dot(pa, ba) / max(dot(ba, ba), 1e-9));
  return length(pa - ba * h);
}
// The opening state: a few spiral filaments already laid down round the core.
fn opening(q: vec2f) -> vec3f {
  let d = q - U[1].xy;
  let r = length(d);
  let a = atan2(d.y, d.x);
  let L = U[${OPEN}];
  let ph = L.x * a + L.y * log(max(r, 1e-3)) + U[0].z * 37.0;
  // Bundles of fine parallel lines along each arm, like the pens leave.
  let arm = smoothstep(0.55, 0.95, 0.5 + 0.5 * cos(ph));
  let fine = pow(0.5 + 0.5 * cos(ph * 11.0), 24.0);
  let fade = smoothstep(0.06, 0.22, r) * (1.0 - 0.6 * smoothstep(0.4, 1.0, r));
  return ink(U[5].w + a / TAU * L.z + 0.08 * cos(ph * 11.0)) * arm * fine * fade * 1.3;
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  let dims = fb_dims();
  if (f32(i.x) >= dims.x || f32(i.y) >= dims.y) { return; }
  let uv = (vec2f(i) + 0.5) / dims;
  let q = fb_q(uv);
  if (U[0].y > 0.5) { textureStore(colOut, i, vec4f(opening(q), 1.0)); return; }
  let dt = U[0].x;
  // Backtrace in two midpoint steps through the steady flow: smooth, curved trails at any rate.
  let mid = q - 0.5 * dt * fb_flow(q);
  let suv = fb_uv(q - fb_flow(mid) * dt);
  var c = history(suv);
  // Neighbourhood clamp and a light unsharp term: no ringing, no slow blur.
  let t = 1.0 / dims;
  let n0 = textureSampleLevel(colIn, sampClamp, suv + vec2f(t.x, 0.0), 0.0).rgb;
  let n1 = textureSampleLevel(colIn, sampClamp, suv - vec2f(t.x, 0.0), 0.0).rgb;
  let n2 = textureSampleLevel(colIn, sampClamp, suv + vec2f(0.0, t.y), 0.0).rgb;
  let n3 = textureSampleLevel(colIn, sampClamp, suv - vec2f(0.0, t.y), 0.0).rgb;
  let mn = min(min(n0, n1), min(min(n2, n3), c));
  let mx = max(max(n0, n1), max(max(n2, n3), c));
  c = clamp(c + (c - (n0 + n1 + n2 + n3) * 0.25) * U[4].w, mn, mx);
  // Ageing by absorption: the weaker channels fade first, so light saturates as it cools.
  let m = max(c.r, max(c.g, c.b));
  c *= exp(-dt / U[2].w * (1.0 + U[5].x * (1.0 - c / max(m, 1e-4))));
  // The black core.
  let r = length(q - U[1].xy);
  c *= exp(-dt * 5.0 * (1.0 - smoothstep(0.0, U[${FIN}].w, r)));
  // Fronts: where a front is burning, the filament takes the front's colour for good. Both the
  // front and its colour are read through the B-spline, so the new colour has smooth edges.
  let B = fb_bspline(bIn, uv);
  if (B.y > 0.05) {
    let fi = fb_frontInk(fb_bspline(pIn, uv));
    let mc = max(c.r, max(c.g, c.b));
    // The new colour soaks in over about a quarter second behind the front, never all at once.
    c = mix(c, fi.rgb * mc * 1.06, sat(B.y * 1.3 - 0.1) * (1.0 - exp(-dt * 4.0)));
  }
  // The pens: each a rake of fine parallel lines swept from its last position to its new one. A
  // band pen's lines are the fine structure of its band (each line's light is the spectrum level
  // at its own frequency), so the sound's signature is woven into the ribbon's cross-section.
  // A line (or its white core) never draws narrower than about a texel: thinner ones draw that wide
  // and proportionally fainter, so they stay anti-aliased at any resolution.
  let px = 1.0 / dims.y;
  for (var j = 0; j < ${PENS}; j++) {
    let A = U[${PEN0} + j * 4];
    let P = U[${PEN0 + 1} + j * 4];
    let C = U[${PEN0 + 2} + j * 4];
    let D = U[${PEN0 + 3} + j * 4];
    if (P.z < 0.005) { continue; }
    let dir = C.zw;
    let nrm = vec2f(-dir.y, dir.x);
    let pa = q - A.xy;
    let len = max(dot(A.zw - A.xy, dir), 0.0);
    let ta = dot(pa, dir);
    let wl = max(P.y, px);
    let gain = P.y / wl;
    let wc = max(P.y * 0.408, px * 0.75);
    let cgain = P.y * 0.408 / wc;
    // The stroke also redraws the last one (max blending makes that idempotent), so consecutive
    // strokes always overlap: no seams where they join, whatever the frame rate.
    let back = max(len, wl * 2.0);
    let dn = dot(pa, nrm);
    let half = (D.x - 1.0) * 0.5 * D.y;
    if (abs(dn) > half + wl * 4.0 || ta < -back - wl * 2.0 || ta > len + wl * 2.0) { continue; }
    let along = smoothstep(-back - wl, -back, ta) * (1.0 - smoothstep(len, len + wl, ta));
    let T = i32(D.x);
    for (var k = 0; k < T; k++) {
      let fk = (f32(k) + 0.5) / D.x;
      let off = (f32(k) - (D.x - 1.0) * 0.5) * D.y;
      let x = (dn - off) / wl;
      let e = exp(-x * x) * along * gain;
      if (e < 0.003) { continue; }
      let lvl = select(1.0, 0.25 + 1.6 * pow(spec(mix(C.x, C.y, fk)), 1.3), C.y > C.x);
      let xc = (dn - off) / wc;
      let core = exp(-xc * xc) * P.w * cgain;
      let pc = mix(ink(P.x + (fk - 0.5) * D.z), vec3f(1.0), core) * P.z * lvl;
      c = mix(c, max(c, pc), e);
    }
  }
  // Stochastic rounding into half floats: slow fades keep fading at any frame rate instead of
  // stalling when one frame's change is below half a unit in the last place.
  c *= 1.0 + (hash13(vec3f(vec2f(i), U[0].z * 977.0)) - 0.5) * 0.001;
  textureStore(colOut, i, vec4f(min(c, vec3f(32.0)), 1.0));
}`;

/**
 * Light pooling: the ribbons' light averaged down to a grid an eighth of the colour grid (an 8x8 box
 * from 16 bilinear taps), then a Gaussian of that at 0.4 of its size, so the haze around the
 * bundles is smooth.
 */
const glowWgsl = (box: boolean) => /* wgsl */ `
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  let size = vec2i(textureDimensions(outTex));
  if (i.x >= size.x || i.y >= size.y) { return; }
  let uv = (vec2f(i) + 0.5) / vec2f(size);
  let px = 1.0 / vec2f(textureDimensions(srcTex));
  var acc = vec3f(0.0);
  var ws = 0.0;
  for (var y = -2; y <= 1; y++) {
    for (var x = -2; x <= 1; x++) {
      let o = vec2f(f32(x) + 0.5, f32(y) + 0.5);
      ${box ? 'let w = 1.0; let tap = o * 2.0;' : 'let w = exp(-dot(o, o) * 0.3); let tap = o * 1.5;'}
      acc += textureSampleLevel(srcTex, sampClamp, uv + tap * px, 0.0).rgb * w;
      ws += w;
    }
  }
  textureStore(outTex, i, vec4f(acc / ws, 1.0));
}`;

/** Carries the colour field across a change of resolution. */
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
@group(1) @binding(1) var colTex: texture_2d<f32>;
@group(1) @binding(2) var bTex: texture_2d<f32>;
@group(1) @binding(3) var bPrev: texture_2d<f32>;
@group(1) @binding(4) var pTex: texture_2d<f32>;
@group(1) @binding(5) var pPrev: texture_2d<f32>;
@group(1) @binding(6) var g1Tex: texture_2d<f32>;
@group(1) @binding(7) var g2Tex: texture_2d<f32>;
@group(1) @binding(8) var hTex: texture_2d<f32>;
@group(1) @binding(9) var hPrev: texture_2d<f32>;
${FULLSCREEN_VS}
fn hAt(uv: vec2f) -> f32 { return log2(1.0 + 3.0 * luma(textureSampleLevel(colTex, sampClamp, uv, 0.0).rgb)); }
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  var s = vec2f(1.0);
  if (F.aspect > ASPECT) { s.y = ASPECT / F.aspect; } else { s.x = F.aspect / ASPECT; }
  let uv = 0.5 + (in.uv - 0.5) * s;
  // Surface slope from one-texel central differences, scaled to the slope per unit length the
  // look was tuned at, so the relief is the same at any resolution, only finer.
  let t = 1.0 / fb_dims();
  let gx = hAt(uv + vec2f(t.x, 0.0)) - hAt(uv - vec2f(t.x, 0.0));
  let gy = hAt(uv + vec2f(0.0, t.y)) - hAt(uv - vec2f(0.0, t.y));
  let g = vec2f(gx, gy) * (1.25 * fb_dims().y / ${REF_SH}.0);
  let N = normalize(vec3f(-g * U[${FIN}].x, 1.0));
  // Dispersion across each filament's edge: red and blue are fetched a little apart along the slope.
  let gd = g / (0.15 + length(g)) * U[${FIN}].y * 1.25 / vec2f(${REF_SH}.0 * ASPECT, ${REF_SH}.0);
  let c0 = textureSampleLevel(colTex, sampClamp, uv, 0.0).rgb;
  let cr = textureSampleLevel(colTex, sampClamp, uv + gd, 0.0).r;
  let cb = textureSampleLevel(colTex, sampClamp, uv - gd, 0.0).b;
  var col = vec3f(cr, c0.g, cb);
  let lum = luma(c0);
  let Ld = normalize(U[${LIGHT}].xyz);
  let V = vec3f(0.0, 0.0, 1.0);
  let H = normalize(Ld + V);
  let ndl = max(dot(N, Ld), 0.0);
  let ndh = max(dot(N, H), 0.0);
  let fres = pow(1.0 - N.z, 3.0);
  let wet = smoothstep(0.02, 0.3, lum);
  let keyC = mix(vec3f(1.0), ink(U[5].w + 0.5), 0.3);
  let spec = keyC * (pow(ndh, 120.0) * 1.6 + pow(ndh, 24.0) * 0.18) * U[${LIGHT}].w * wet;
  let sheen = ink(U[5].w + 0.33 + 0.4 * N.x) * fres * 0.9 * wet;
  col = col * (0.55 + 0.6 * ndl) + spec + sheen;
  // The haze the bundles light around them: a close glow and a broad one, in their colours.
  let haze = fb_bspline(g1Tex, uv).rgb * 0.35 + fb_bspline(g2Tex, uv).rgb * 0.6;
  col += haze;

  // Fronts: a hot edge and embers, only on the filaments (masked at full resolution by the
  // filament's own light). The coarse burn field and its paint are read through the B-spline and
  // interpolated between the last two burn steps, so fronts glide smoothly at any frame rate.
  let fr = U[${DIMS}].z;
  let B = mix(fb_bspline(bPrev, uv), fb_bspline(bTex, uv), fr);
  let fi = fb_frontInk(mix(fb_bspline(pPrev, uv), fb_bspline(pTex, uv), fr));
  let fuel = smoothstep(0.01, 0.12, lum);
  // The CA burns as a speckle of single hot cells, which the B-spline averages down: the gain gives
  // a speckled front the heat of a solid one.
  let hx = sat(mix(fb_bspline(hPrev, uv).x, fb_bspline(hTex, uv).x, fr) * 1.3);
  let wk = fi.w;
  let wo = 1.0 - wk;
  let fire = vec3f(1.0, 0.3 + 0.45 * hx, 0.06 + 0.3 * hx * hx) * (2.4 * hx * hx + 0.4 * hx);
  let fc = fi.rgb;
  let spark = mix(fc, vec3f(1.0), 0.5 * hx * hx) * (3.0 * hx * hx + 0.3 * hx);
  let ember = sat(B.y - hx);
  let emberC = mix(vec3f(1.0, 0.3, 0.06), fc, wo) * ember * ember * 0.9;
  col += (fire * wk + spark * wo + emberC) * fuel;
  return vec4f(col, 1.0);
}`;

type Ignition = { x: number; y: number; r: number; hue: number; kind: number; born: number };
type Pipes = {
  burn: GPUComputePipeline;
  step: GPUComputePipeline;
  glow1: GPUComputePipeline;
  glow2: GPUComputePipeline;
  resample: GPUComputePipeline;
  render: GPURenderPipeline;
};
type Layouts = { burn: GPUBindGroupLayout; step: GPUBindGroupLayout; glow: GPUBindGroupLayout; render: GPUBindGroupLayout };
/** Bind groups indexed [colour parity][burn parity]. */
type Groups = { burn: GPUBindGroup[][]; step: GPUBindGroup[][]; glow1: GPUBindGroup[]; glow2: GPUBindGroup; render: GPUBindGroup[][] };
/** The resolution-dependent part: the colour field (ping-pong) and the two haze levels. */
type Grid = { sw: number; sh: number; col: GPUTexture[]; g1: GPUTexture; g2: GPUTexture; groups: Groups };

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

/** A note's light: eases in over a quarter second, then fades. */
const noteEnvelope = (age: number) => smoothstep(0, 0.25, age) * Math.exp(-Math.max(0, age - 0.25) / 0.6);

class FeedbackBloomInstance implements SceneInstance {
  readonly meta = META;
  private readonly u = new Float32Array(UVEC * 4);
  private readonly morph = new Morph(1);
  private readonly prevPen = new Float32Array(PENS * 2);
  /** Band levels eased per pen, so the ribbons swell with their band instead of flickering or snapping. */
  private readonly level = Array.from({ length: 5 }, () => new Ease());
  private readonly held = new Ease();
  private readonly pitchEase = new Ease();
  private lastT = -1;
  private seed = -1;
  private reset = true;
  private dt = 0;
  private hue = 0;
  private pitch = 0;
  private clock = 0;
  private burnAcc = 0;
  private burnSteps = 0;
  private cp = 0;
  private bp = 0;
  private ignitions: Ignition[] = [];
  private grid: Grid | null = null;
  /** Textures replaced by a resize, destroyed once the frame that last used them is submitted. */
  private retired: GPUTexture[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly group0: GPUBindGroup,
    private readonly uBuffer: GPUBuffer,
    private readonly pipes: Pipes,
    private readonly layouts: Layouts,
    private readonly bn: GPUTexture[],
    private readonly pt: GPUTexture[],
    private readonly ht: GPUTexture[],
    private readonly owned: (GPUTexture | GPUBuffer)[],
  ) {}

  /** Builds the colour grid for a render target, carrying the old picture across when there is one. */
  private resize(encoder: GPUCommandEncoder, width: number, height: number): Grid {
    const cover = Math.max(width, height * ASPECT);
    const sw = Math.round(Math.min(MAX_SW, Math.max(MIN_SW, cover)) / 8) * 8;
    const sh = Math.round(sw / ASPECT);
    const old = this.grid;
    if (old && old.sw === sw && old.sh === sh) return old;
    const d = this.device;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const tex = (label: string, w: number, h: number) => d.createTexture({ label: `feedback-bloom-${label}`, size: [w, h], format: 'rgba16float', usage });
    const col = [tex('col0', sw, sh), tex('col1', sw, sh)];
    const g1w = Math.ceil(sw / 8);
    const g1h = Math.ceil(sh / 8);
    const g1 = tex('glow1', g1w, g1h);
    const g2 = tex('glow2', Math.ceil(g1w * 0.4), Math.ceil(g1h * 0.4));
    const L = this.layouts;
    const bind = (l: GPUBindGroupLayout, ...ts: GPUTexture[]) =>
      d.createBindGroup({
        layout: l,
        entries: [{ binding: 0, resource: { buffer: this.uBuffer } }, ...ts.map((t, i) => ({ binding: i + 1, resource: t.createView() }))],
      });
    const bn = this.bn;
    const pt = this.pt;
    const ht = this.ht;
    const grid2 = (f: (c: number, b: number) => GPUBindGroup) => [0, 1].map((c) => [0, 1].map((b) => f(c, b)));
    const groups: Groups = {
      burn: grid2((c, b) => bind(L.burn, bn[b], col[c], bn[1 - b], pt[1 - b], ht[1 - b])),
      step: grid2((c, b) => bind(L.step, col[c], bn[b], pt[b], col[1 - c])),
      glow1: [0, 1].map((c) => bind(L.glow, col[c], g1)),
      glow2: bind(L.glow, g1, g2),
      render: grid2((c, b) => bind(L.render, col[c], bn[b], bn[1 - b], pt[b], pt[1 - b], g1, g2, ht[b], ht[1 - b])),
    };
    if (old) {
      // Carry the picture across: nothing resets when the resolution changes.
      const cp = encoder.beginComputePass({ label: 'feedback-bloom-resample' });
      cp.setBindGroup(0, this.group0);
      cp.setPipeline(this.pipes.resample);
      cp.setBindGroup(1, bind(L.glow, old.col[this.cp], col[this.cp]));
      cp.dispatchWorkgroups(Math.ceil(sw / 8), Math.ceil(sh / 8));
      cp.end();
      this.retired.push(...old.col, old.g1, old.g2);
    }
    this.grid = { sw, sh, col, g1, g2, groups };
    return this.grid;
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
    const flow = mo.flow;
    const e = m.energySlow;

    const root = m.chord && m.chord.root >= 0 ? m.chord.root : 0;
    const hueTarget = g[3] + ((root * 7) % 12) / 12 + (m.chord?.quality.startsWith('m') ? 0.08 : 0);
    if (seek) {
      this.reset = true;
      this.ignitions = [];
      this.hue = hueTarget;
      this.pitchEase.set(Math.max(-1.2, Math.min(1.2, m.leadPitch)));
      this.held.set(m.leadHeld);
      this.clock = 0;
      this.burnAcc = 0;
    }
    this.clock += dt;
    const dh = ((((hueTarget - this.hue + 0.5) % 1) + 1) % 1) - 0.5;
    this.hue += dh * (1 - Math.exp(-dt / 0.8));
    // The melody pen glides to each new pitch (no radial jump) and its light swells with the note.
    this.pitch = this.pitchEase.step(Math.max(-1.2, Math.min(1.2, m.leadPitch)), 0.06, 0.06, dt);
    const held = this.held.step(m.leadHeld, 0.08, 0.12, dt);

    const u = this.u;
    u.fill(0);
    u[0] = dt;
    u[1] = this.reset ? 1 : 0;
    u[2] = fract(g[0] * 7.13 + g[7] + this.clock * 0.618);

    // Vortex: a focal point that wanders slowly, a steady outward bloom and a turn either way.
    const fx = 0.26 * Math.sin(at[0] * 0.5 + g[4] * TAU);
    const fy = 0.1 * Math.sin(at[1] * 0.5 + g[4] * 9.1);
    const swirlDir = g[1] > 0.5 ? 1 : -1;
    u[4] = fx;
    u[5] = fy;
    u[6] = (0.07 + 0.035 * g[7] + 0.025 * e) * flow;
    u[7] = swirlDir * wave(at[1], 0.035, 0.12) * flow;
    // Warp: two stream functions, laid out by the morph (kicks and snares step it to new layouts).
    u[8] = wave(at[2], 0.006, 0.02) * (0.6 + 0.8 * g[5]) * flow;
    u[9] = TAU / wave(at[3], 0.55, 1.2);
    u[11] = 2.6 + 1.2 * g[2] + 0.8 * (1 - e); // decay time constant
    u[12] = at[5] * 0.7 + g[1] * TAU;
    u[13] = at[6] * 0.7 + g[2] * TAU;
    u[14] = at[7] * 0.9;
    u[15] = at[0] * 0.8 + g[6] * TAU;
    u[16] = u[9] * wave(at[4], 1.7, 2.8);
    const ca = g[2] * TAU + at[1] * 0.2;
    u[17] = Math.cos(ca);
    u[18] = Math.sin(ca);
    u[19] = 0; // sharpen (any gain compounds into zigzags over hundreds of frames)
    u[20] = 1.4; // ageing
    u[21] = 0.1; // heat: a hot edge that lasts long enough to read as a glowing front
    u[22] = 0.9; // embers
    u[23] = this.hue;

    // Pens: five band rakes round the core, the melody pen at a distance set by the pitch.
    const bands = [m.sub, m.bass, m.lowMid, m.mid, m.high];
    const specLo = [0.0, 0.1, 0.25, 0.45, 0.7];
    const specHi = [0.12, 0.27, 0.47, 0.72, 1.0];
    const theta0 = g[4] * TAU - mo.travel * swirlDir * (0.8 + 0.35 * g[5]);
    const centroidHue = (m.centroid - 0.5) * 0.45;
    const stepHue = mo.kickPhase * 0.11 + mo.snarePhase * 0.07;
    const live = !seek && dt > 0;
    const heads: number[] = [];
    const tines = 4 + Math.floor(g[7] * 4);
    const spacing = wave(at[5] * 0.5 + g[6] * 5, 0.0042, 0.0075);
    for (let j = 0; j < PENS; j++) {
      let x: number;
      let y: number;
      let hue: number;
      let width: number;
      let light: number;
      let core: number;
      let lo = 0;
      let hi = 0;
      let count = 1;
      let tx: number;
      let ty: number;
      if (j < 5) {
        const raw = Math.min(1, Math.max(0, bands[j]));
        if (seek) this.level[j].set(raw);
        const b = this.level[j].step(raw, 0.08, 0.12, dt);
        const th = theta0 + (j * TAU) / 5 + 0.5 * Math.sin(at[j] * 0.7 + j);
        const r = wave(at[(j + 3) % 8] * 0.6 + j * 1.3, 0.1, 0.24);
        x = fx + Math.cos(th) * r * 1.25;
        y = fy + Math.sin(th) * r;
        tx = Math.sin(th) * 1.25 * swirlDir;
        ty = -Math.cos(th) * swirlDir;
        hue = this.hue + j * 0.2 + centroidHue + stepHue;
        width = 0.0009 + 0.0005 * b;
        light = (0.08 + 1.4 * b) * (0.5 + 0.5 * flow);
        core = 0.08 + 0.2 * b;
        lo = specLo[j];
        hi = specHi[j];
        count = tines;
      } else {
        const p01 = (this.pitch + 1.2) / 2.4;
        const th = theta0 * 0.75 + g[6] * TAU;
        const r = 0.07 + 0.22 * p01;
        x = fx + Math.cos(th) * r * 1.25;
        y = fy + Math.sin(th) * r;
        tx = Math.sin(th) * 1.25 * swirlDir;
        ty = -Math.cos(th) * swirlDir;
        hue = this.hue + 0.5 + this.pitch * 0.3 + mo.notePhase * 0.05;
        const attack = noteEnvelope(mo.leadAge);
        const swell = Math.max(held, attack);
        // Each note swells at the pen and leaves a bright bead in its thread that streams outward.
        width = 0.0013 + 0.0009 * swell + 0.0016 * attack;
        light = 0.12 + 1.2 * held + 4.5 * attack;
        core = 0.25 + 0.45 * attack;
      }
      if (this.reset || seek) {
        this.prevPen[j * 2] = x;
        this.prevPen[j * 2 + 1] = y;
      }
      // The last head, carried by the flow to where its stroke is now: the new stroke joins it, and
      // the rake lies across the pen's motion through the medium, so its lines run parallel.
      const [vx, vy] = flowAt(u, this.prevPen[j * 2], this.prevPen[j * 2 + 1]);
      const px = this.prevPen[j * 2] + vx * dt;
      const py = this.prevPen[j * 2 + 1] + vy * dt;
      let dx = x - px;
      let dy = y - py;
      let dl = Math.hypot(dx, dy);
      if (dl < 1e-4) {
        dx = tx;
        dy = ty;
        dl = Math.hypot(dx, dy);
      }
      const o = PEN0 * 4 + j * 16;
      u[o] = px;
      u[o + 1] = py;
      u[o + 2] = x;
      u[o + 3] = y;
      u[o + 4] = hue;
      u[o + 5] = width;
      u[o + 6] = light;
      u[o + 7] = core;
      u[o + 8] = lo;
      u[o + 9] = hi;
      u[o + 10] = dx / dl;
      u[o + 11] = dy / dl;
      u[o + 12] = count;
      u[o + 13] = spacing;
      u[o + 14] = 0.12; // hue spread across the rake
      this.prevPen[j * 2] = x;
      this.prevPen[j * 2 + 1] = y;
      heads.push(x, y);
    }

    // Ignitions. The kick lights the bundles deep in the vortex at four points (a golden-angle
    // walk, so each kick starts somewhere new) and its fire runs out along them; the snare lights
    // the outer bundles and races; each note lights the melody's own thread at the pen. Each
    // ignition grows from a point to its full size over IGN_GROW, so nothing lights up at once.
    const newHue = this.hue + centroidHue;
    const born = this.clock;
    if (live && mo.kickAge === 0) {
      for (let k = 0; k < 4; k++) {
        // Each point burns in its own ink, so the fronts leave several colours, not one.
        const hue = fract(newHue + 0.11 * mo.kicks + 0.13 + k * 0.34);
        const ang = theta0 + 2.39996 * mo.kicks + (k * TAU) / 4;
        const r = 0.16 + 0.14 * fract(mo.kicks * 0.618 + k * 0.37);
        this.ignitions.push({ x: fx + Math.cos(ang) * r * 1.3, y: fy + Math.sin(ang) * r, r: 0.16, hue, kind: 0, born });
      }
    }
    if (live && mo.snareAge === 0) {
      // The snare lights the upper pens' bundles where they are freshest, plus one point further
      // out, and races along them.
      for (let k = 0; k < 3; k++) {
        const hue = fract(newHue + 0.5 + 0.07 * mo.snares + k * 0.3);
        const j = 2 + ((mo.snares + k) % 3);
        const out = k === 2 ? 1.6 : 1.0;
        const x = fx + (heads[j * 2] - fx) * out;
        const y = fy + (heads[j * 2 + 1] - fy) * out;
        this.ignitions.push({ x, y, r: 0.09, hue, kind: 1, born });
      }
    }
    if (live && mo.leadAge === 0) {
      // The note lights its own thread at the pen, and the vortex at an angle set by its pitch.
      const hue = fract(this.hue + 0.58 + this.pitch * 0.3);
      this.ignitions.push({ x: heads[10], y: heads[11], r: 0.14, hue, kind: 2, born });
      const pa = theta0 + this.pitch * 2.2 + Math.PI;
      const pr = 0.22 + 0.06 * this.pitch;
      this.ignitions.push({ x: fx + Math.cos(pa) * pr * 1.3, y: fy + Math.sin(pa) * pr, r: 0.16, hue, kind: 2, born });
    }
    this.ignitions = this.ignitions.filter((s) => this.clock - s.born < IGN_GROW + 0.05).slice(-IGN);
    for (let j = 0; j < IGN; j++) {
      const s = this.ignitions[j];
      if (!s) continue;
      u[IGN0 * 4 + j * 4] = s.x;
      u[IGN0 * 4 + 1 + j * 4] = s.y;
      u[IGN0 * 4 + 2 + j * 4] = s.r;
      u[IGN0 * 4 + 3 + j * 4] = s.hue;
      u[KIND0 * 4 + j * 4] = s.kind;
      u[KIND0 * 4 + 1 + j * 4] = smoothstep(0, IGN_GROW, this.clock - s.born + dt);
    }

    // Light and finish.
    u[LIGHT * 4] = -0.5;
    u[LIGHT * 4 + 1] = -0.6;
    u[LIGHT * 4 + 2] = 0.65;
    u[LIGHT * 4 + 3] = 1.0; // specular
    u[FIN * 4] = 2.2; // bump
    u[FIN * 4 + 1] = 1.6; // dispersion (texels of the original 720-row grid)
    u[FIN * 4 + 3] = 0.035 + 0.02 * g[5]; // core radius
    u[OPEN * 4] = Math.round(3 + g[5] * 4) * (g[1] > 0.5 ? 1 : -1); // opening arms
    u[OPEN * 4 + 1] = wave(g[7] * 9, 3, 8);
    u[OPEN * 4 + 2] = 0.25 + 0.5 * g[2];

    // Burn: a whole number of fixed steps per frame, so fronts move at the same speed at any rate.
    // The picture interpolates between the last two steps by the leftover fraction, so fronts glide
    // instead of stepping when the frame rate and the burn rate do not divide. A reset runs two
    // steps so both burn buffers are clear.
    this.burnAcc += dt * BURN_RATE;
    this.burnSteps = Math.min(12, Math.floor(this.burnAcc));
    this.burnAcc -= Math.floor(this.burnAcc);
    if (this.reset) this.burnSteps = Math.max(2, this.burnSteps);
    u[3] = 1 / BURN_RATE;
    u[DIMS * 4 + 2] = this.burnAcc;
    this.dt = dt;
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    for (const t of this.retired) t.destroy();
    this.retired = [];
    const grid = this.resize(encoder, width, height);
    this.u[DIMS * 4] = grid.sw;
    this.u[DIMS * 4 + 1] = grid.sh;
    this.device.queue.writeBuffer(this.uBuffer, 0, this.u);
    const P = this.pipes;
    const G = grid.groups;
    if (this.dt > 0 || this.reset) {
      const cp = encoder.beginComputePass({ label: 'feedback-bloom-sim' });
      cp.setBindGroup(0, this.group0);
      cp.setPipeline(P.burn);
      for (let k = 0; k < this.burnSteps; k++) {
        cp.setBindGroup(1, G.burn[this.cp][this.bp]);
        cp.dispatchWorkgroups(Math.ceil(BW / 8), Math.ceil(BH / 8));
        this.bp ^= 1;
      }
      cp.setPipeline(P.step);
      cp.setBindGroup(1, G.step[this.cp][this.bp]);
      cp.dispatchWorkgroups(Math.ceil(grid.sw / 8), Math.ceil(grid.sh / 8));
      this.cp ^= 1;
      cp.setPipeline(P.glow1);
      cp.setBindGroup(1, G.glow1[this.cp]);
      cp.dispatchWorkgroups(Math.ceil(grid.g1.width / 8), Math.ceil(grid.g1.height / 8));
      cp.setPipeline(P.glow2);
      cp.setBindGroup(1, G.glow2);
      cp.dispatchWorkgroups(Math.ceil(grid.g2.width / 8), Math.ceil(grid.g2.height / 8));
      cp.end();
      this.reset = false;
      this.dt = 0;
    }
    const pass = encoder.beginRenderPass({
      label: 'feedback-bloom',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(P.render);
    pass.setBindGroup(0, this.group0);
    pass.setBindGroup(1, G.render[this.cp][this.bp]);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    for (const r of this.owned) r.destroy();
    for (const t of this.retired) t.destroy();
    if (this.grid) for (const t of [...this.grid.col, this.grid.g1, this.grid.g2]) t.destroy();
  }
}

type Slot = 'tex' | 'out';

const factory: SceneFactory = {
  meta: META,
  async create(device: GPUDevice, shared: SharedResources) {
    const prelude = `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${HEAD}`;
    const layout = (slots: Slot[], vis: number) =>
      device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: vis, buffer: { type: 'uniform' } },
          ...slots.map((s, i): GPUBindGroupLayoutEntry =>
            s === 'tex'
              ? { binding: i + 1, visibility: vis, texture: { sampleType: 'float' } }
              : { binding: i + 1, visibility: vis, storageTexture: { access: 'write-only', format: 'rgba16float' } },
          ),
        ],
      });
    const C = GPUShaderStage.COMPUTE;
    const layouts: Layouts = {
      burn: layout(['tex', 'tex', 'out', 'out', 'out'], C),
      step: layout(['tex', 'tex', 'tex', 'out'], C),
      glow: layout(['tex', 'out'], C),
      render: layout(Array<Slot>(9).fill('tex'), GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX),
    };
    const compute = async (code: string, name: string, l: GPUBindGroupLayout) =>
      device.createComputePipelineAsync({
        label: `feedback-bloom-${name}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, l] }),
        compute: { module: await compileModule(device, `${prelude}\n${code}`, `feedback-bloom-${name}`), entryPoint: 'main' },
      });
    const rModule = await compileModule(device, `${prelude}\n${RENDER}`, 'feedback-bloom-draw');
    const [burn, step, glow1, glow2, resample, render] = await Promise.all([
      compute(BURN, 'burn', layouts.burn),
      compute(STEP, 'step', layouts.step),
      compute(glowWgsl(true), 'glow1', layouts.glow),
      compute(glowWgsl(false), 'glow2', layouts.glow),
      compute(RESAMPLE, 'resample', layouts.glow),
      device.createRenderPipelineAsync({
        label: 'feedback-bloom-draw',
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, layouts.render] }),
        vertex: { module: rModule, entryPoint: 'vs' },
        fragment: { module: rModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      }),
    ]);

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const tex = (label: string) => device.createTexture({ label: `feedback-bloom-${label}`, size: [BW, BH], format: 'rgba16float', usage });
    const bn = [tex('burn0'), tex('burn1')];
    const pt = [tex('paint0'), tex('paint1')];
    const ht = [tex('heat0'), tex('heat1')];
    const uBuffer = device.createBuffer({ label: 'feedback-bloom-u', size: UVEC * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const paramBuffer = shared.createSceneParamBuffer('feedback-bloom-params');
    const group0 = shared.createSceneBindGroup(paramBuffer, 'feedback-bloom');
    const pipes: Pipes = { burn, step, glow1, glow2, resample, render };
    return new FeedbackBloomInstance(device, group0, uBuffer, pipes, layouts, bn, pt, ht, [...bn, ...pt, ...ht, uBuffer, paramBuffer]);
  },
};

export default factory;
