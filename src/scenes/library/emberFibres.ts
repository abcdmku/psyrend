import { compileModule } from '../../gpu/context';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { Morph } from '../morph';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Ember Fibres: steel wool set alight by the music. Three sheets of very fine fibres hang in depth
 * (near, mid, far), drifting past at different speeds; fibres keep growing in and receding at the
 * edges of slowly moving clumps, so the tangle is always re-forming and fresh wool keeps arriving.
 *
 * The music makes the wool and burns it. Every event grows a tuft of fresh fibre where it lands (a
 * growth field per sheet that thins away over many seconds), then sets it alight. The burn is an
 * excitable medium on a grid per sheet (heat, fuel, oxide, tag), stepped in a compute pass at a fixed
 * rate. Heat passes only between neighbouring fibre cells along the fibre's own direction, and each
 * fibre burns at its own pace, so fire runs along the fibres, fingers out, splits where they cross
 * and creeps across short gaps by radiant heat. Each cell
 * ignites from its hottest neighbour and takes on that fire's tag, burns white-hot while it has fuel,
 * cools through orange and red to embers, and leaves a lasting oxide: temper colours (straw, bronze,
 * violet, blue, teal) that advance each time a fibre burns again, tinted by the fire that burned it.
 *  - kick: a tuft laid along the fibres at a point that walks round the frame with each kick, on all
 *    three sheets, bursting into flame with a spray of sparks off its strands; the light also swings
 *    round, so the glints slide along every fibre;
 *  - snare: a scatter of small tufts and ignitions across all three sheets, and the temper colours
 *    and the steel's tint turn a step round the wheel;
 *  - melody: an ignition at a height set by the pitch, its flame and its oxide in the note's colour,
 *    racing along the fibres in the melody's direction (up for rising lines, down for falling), and a
 *    broad band of the wool at the pitch's height takes the note's colour;
 *  - chords: the colour the next fires leave behind;
 *  - spectrum: sparks fly off the burning front at a rate set by the flux and energy, sized by the
 *    bass and coloured by the spectral centroid as they cool; energy speeds the burn.
 *
 * Deterministic for offline rendering: everything integrates by dt (fixed sub-steps), and a jump of
 * more than 0.5 s or a new cue resets to the opening state (part-tempered wool with a few fires lit).
 */

const NL = 3;
const SW = 1152;
const SH = 648;
/** Sim cells per view height. */
const K = 500;
const NP = 65536;
const UVEC = 40;
const TAU = Math.PI * 2;
/** Sim sub-steps per second (rounded up to an odd count per frame). */
const STEP_RATE = 240;
const KICK_WIN = 0.35;
const NOTE_WIN = 0.35;
/** Seconds over which an event grows its tuft of new wool. */
const GROW_WIN = 0.3;
const SNARE_WIN = 0.4;
/** Seconds over which an ignition's patch spreads out and its heat climbs (no snaps). */
const IGN_RISE = 0.25;
const SNARE_PTS = 30;

const META: SceneMeta = {
  id: 'ember-fibres',
  name: 'Ember Fibres',
  energy: [0, 1],
  mood: { valence: 0.5, arousal: 0.6 },
  genres: { edm: 1, techno: 0.9, dubstep: 0.8, dnb: 0.8, ambient: 0.7, synthwave: 0.8, rock: 0.7, hiphop: 0.7, pop: 0.6, lofi: 0.5, jazz: 0.5, classical: 0.5, acoustic: 0.5 },
  trails: 0,
  kaleido: false,
};

/*
 * Uniform layout (vec4 slots of U):
 *  0 h (sub-step), reset, frame, seed          1 burn rate, threshold, hot cooling, ember cooling
 *  2 fuel burn, oxide rate, regrowth, radiant  3 melody dir x, y, bias, ignition rate
 *  4-6 per sheet: floor(offset) x, y, fract(offset) x, y
 *  7-9 per sheet: shift x, y (this frame), rotation, cells per view unit
 *  10 warp z, density z, warp D1, warp D2       11 base angle, angle spread, density bias, oxide fade
 *  12-14 per sheet: spacing, half width px, brightness, noise slice
 *  15-26 ignitions (atlas x, y, age, strength) + (radius, tag, window, peak heat)
 *  27-28 snares (seed, age, strength, tag)
 *  29 sparks: emission, speed, size, centroid  30 -, -, -, frame dt
 *  31 drift sheet 0 (vx, vy), sheet 1 (vx, vy) 32 drift sheet 2 (vx, vy), gravity, -
 *  33 fire gain, steel lum, temper lum, glint   34 hue, light x, y, energy
 *  35 eased reactions: snare temper turn, note hue, note pull, note band height (view units)
 *  37 fibre crimp: long, short amplitude; short phase, long phase (the fine detail layer)
 */
const HEAD = /* wgsl */ `
const SW: i32 = ${SW};
const SH: i32 = ${SH};
const NL: i32 = ${NL};
const CENTRE: vec2f = vec2f(${SW / 2}.0, ${SH / 2}.0);
const SNARE_PTS: i32 = ${SNARE_PTS};
@group(1) @binding(0) var<uniform> U: array<vec4f, ${UVEC}>;

// The fibre field of one sheet at material position m (cells): four families of lines, each the
// level sets of a direction field bent by two octaves of warp, so they curl, bunch and cross.
struct EfPhi { phi: vec4f, along: vec4f, dens: vec4f };
fn ef_phi(m: vec2f, l: i32, boost: f32) -> EfPhi {
  let L = U[12 + l];
  let Fw = U[10];
  let q = m * (1.0 / 500.0);
  let w1 = noise4(vec3f(rot2(1.1) * q * 1.3, L.w + Fw.x));
  let w2 = noise4(vec3f(q * 4.7 + vec2f(17.3, 5.1), L.w * 1.7 + Fw.x * 1.4 + 9.0));
  // Clumps: two octaves on rotated lattices, so the value noise's grid never shows as straight edges.
  let dn = 0.72 * noise4(vec3f(rot2(0.73 + f32(l) * 0.5) * q * 1.25 + vec2f(41.0, 13.0), L.w + Fw.y + 21.0))
    + 0.28 * noise4(vec3f(rot2(-0.41 + f32(l) * 0.9) * q * 2.9 + vec2f(5.0, 29.0), L.w * 1.3 + Fw.y * 1.5 + 3.0));
  var o: EfPhi;
  for (var k = 0; k < 4; k++) {
    let a = U[11].x + f32(k) * U[11].y + f32(l) * 0.37 + 0.7 * sin(f32(k) * 2.31 + U[11].x * 5.0);
    let n = vec2f(cos(a), sin(a));
    o.phi[k] = (dot(m, n) + Fw.z * w1[k] + Fw.w * w2[(k + 1) & 3]) / L.x;
    o.along[k] = dot(m, vec2f(-n.y, n.x));
    o.dens[k] = (0.65 * dn.x + 0.35 * dn[(k + 1) & 3]) * 1.7 + boost;
  }
  return o;
}

// Coverage of the fibres at a point, given each family's gradient per pixel (or per cell): crisp
// lines of half-width hw that break into fibres of random length with tapered tips, present where
// the clump density beats each fibre's own threshold (so fibres grow and recede as it moves).
struct EfFib { cov: f32, tan: vec2f, br: f32 };
fn ef_mask(P: EfPhi, gx: vec4f, gy: vec4f, ax: vec4f, ay: vec4f, hw: f32, l: i32, dense0: f32, dense1: f32) -> EfFib {
  var o: EfFib;
  var keep = 1.0;
  var best = -1.0;
  o.tan = vec2f(1.0, 0.0);
  o.br = 0.5;
  let db = U[11].z;
  for (var k = 0; k < 4; k++) {
    let x = P.phi[k];
    let fk = f32(k + l * 4);
    // Each fibre sits off its slot by its own amount and crimps along its length with its own two
    // wavelengths, so neighbours wander independently and cross. Nearest of the four in reach.
    let xb = floor(x);
    let al = P.along[k];
    var d = 9.0;
    var li = xb;
    var slope = 0.0;
    for (var j = -1; j <= 2; j++) {
      let lj = xb + f32(j);
      let h3 = hash33(vec3f(lj, fk, 7.7));
      let f1 = 0.028 + 0.05 * h3.x;
      let f2 = 0.09 + 0.12 * h3.y;
      let a1 = U[37].x * (0.4 + 0.6 * h3.z);
      let a2 = U[37].y * (0.3 + 0.7 * h3.x);
      // The fine scale answers the high end: the short crimp slides along each fibre with the upper
      // voice (each high note re-forms it), the long crimp with the backing and hats.
      let p1 = al * f1 + h3.y * 40.0 + U[37].w * (0.5 + h3.z);
      let p2 = al * f2 + h3.z * 40.0 + U[37].z * (0.6 + 0.8 * h3.x);
      let off = 0.64 * (h3.z - 0.5) + a1 * sin(p1) + a2 * sin(p2);
      let dj = abs(x - lj - off);
      let near = dj < d;
      d = min(d, dj);
      li = select(li, lj, near);
      slope = select(slope, a1 * f1 * cos(p1) + a2 * f2 * cos(p2), near);
    }
    let gv = vec2f(gx[k] - slope * ax[k], gy[k] - slope * ay[k]);
    let g = max(length(gv), 1e-5);
    let segL = 110.0 + 170.0 * hash12(vec2f(li, fk + 3.1));
    let a = P.along[k] / segL + hash12(vec2f(li * 1.31, fk + 0.7));
    let seg = floor(a);
    let fa = a - seg;
    let h = hash13(vec3f(li, seg, fk));
    let th = mix(-0.5, 0.42, h);
    let pres = smoothstep(th - 0.06, th + 0.06, P.dens[k] + db);
    let taper = smoothstep(0.0, 0.16, min(fa, 1.0 - fa));
    let w = hw * pres * taper;
    var c = clamp(min(w + 0.5 - d / g, 2.0 * w), 0.0, 1.0);
    c = mix(c, min(2.0 * w * g, 1.0), smoothstep(dense0, dense1, g));
    let br = 0.3 + 0.7 * hash13(vec3f(li, seg, fk + 9.5));
    keep *= 1.0 - c;
    let sc = c * br;
    let tn = vec2f(-gv.y, gv.x) / g;
    o.tan = select(o.tan, tn, sc > best);
    o.br = select(o.br, br, sc > best);
    best = max(best, sc);
  }
  o.cov = 1.0 - keep;
  return o;
}

// Fibre coverage on the sim grid (one cell = one pixel), with a tangent from the cell gradient.
fn ef_cellFib(m: vec2f, l: i32, boost: f32) -> EfFib {
  let P0 = ef_phi(m, l, boost);
  let Px = ef_phi(m + vec2f(1.0, 0.0), l, boost);
  let Py = ef_phi(m + vec2f(0.0, 1.0), l, boost);
  return ef_mask(P0, Px.phi - P0.phi, Py.phi - P0.phi, Px.along - P0.along, Py.along - P0.along, 0.75, l, 0.3, 0.5);
}

// A kick's tuft lies along the fibres: an ellipse stretched along one family's direction (picked
// by the kick's place), so its fire bursts out as a bundle of strands rather than a ball.
fn ef_tuft(q: vec2f, c: vec2f, l: i32) -> vec2f {
  let k = floor(hash12(floor(c * 0.25)) * 4.0);
  let a = U[11].x + k * U[11].y + f32(l) * 0.37 + 0.7 * sin(k * 2.31 + U[11].x * 5.0);
  let n = vec2f(cos(a), sin(a));
  return vec2f(dot(q, vec2f(-n.y, n.x)) / 2.0, dot(q, n) * 1.4);
}

// Sheet transform: view coords (height 1, y down) to sim texel coords of sheet l.
fn ef_toSim(v: vec2f, l: i32) -> vec2f {
  let X = U[7 + l];
  return rot2(X.z) * v * X.w + CENTRE + U[4 + l].zw;
}
fn ef_toView(s: vec2f, l: i32) -> vec2f {
  let X = U[7 + l];
  return rot2(-X.z) * (s - CENTRE - U[4 + l].zw) / X.w;
}
// Temper colours of oxidised steel by oxide thickness: straw, bronze, violet, blue, teal, then the
// second order (gold-green, magenta) and round again.
fn ef_temper(ox: f32) -> vec3f {
  let x = fract(ox * 0.62) * 6.0;
  let i = floor(x);
  let f = smoothstep(0.0, 1.0, x - i);
  let c0 = vec3f(1.0, 0.68, 0.18);
  let c1 = vec3f(1.0, 0.3, 0.06);
  let c2 = vec3f(0.85, 0.08, 0.6);
  let c3 = vec3f(0.35, 0.12, 1.0);
  let c4 = vec3f(0.05, 0.45, 1.0);
  let c5 = vec3f(0.05, 0.9, 0.85);
  let a = select(select(select(select(select(c5, c4, i < 4.5), c3, i < 3.5), c2, i < 2.5), c1, i < 1.5), c0, i < 0.5);
  let b = select(select(select(select(select(c0, c5, i < 4.5), c4, i < 3.5), c3, i < 2.5), c2, i < 1.5), c1, i < 0.5);
  return mix(a, b, f);
}
// A saturated palette hue at unit max channel.
fn ef_hue(t: f32) -> vec3f {
  let c = pal(t);
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let n = (c - lo) / max(hi - lo, 1e-3);
  let sv = (hi - lo) / max(hi, 1e-3);
  // A grey palette entry is replaced by a hue of its own.
  return mix(hsv2rgb(vec3f(fract(t * 1.7 + 0.1), 0.85, 1.0)), mix(vec3f(1.0), n, 0.85), smoothstep(0.08, 0.25, sv));
}
// Fire: white-hot through yellow and orange to deep red embers.
fn ef_fire(T: f32) -> vec3f {
  let t = max(T, 0.0);
  // The hottest fire stays golden rather than bleaching to white, so flames keep their colour.
  let c = vec3f(smoothstep(0.04, 0.4, t), smoothstep(0.42, 1.12, t) * 0.76, smoothstep(0.85, 1.35, t) * 0.3);
  return c * (t * t * t * 2.4 + t * 0.12);
}
// Rate profile of an event that eases in over w seconds: the derivative of smoothstep(0, w, age),
// so whatever it adds per second integrates to exactly its amount, starting and ending at rest.
fn ef_ease(age: f32, w: f32) -> f32 { let x = sat(age / w); return 6.0 * x * (1.0 - x) / w; }
// Cubic B-spline filtering from four bilinear taps (smooth, never stair-steps when magnified).
fn ef_bspline(t: texture_2d<f32>, uv: vec2f) -> vec4f {
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
// Unburnt steel: cool silver.
// Steel carries a clear tint of the shadow hue (turned by the snares), so the wool reads coloured, not grey.
fn ef_steel() -> vec3f { return mix(vec3f(0.62, 0.68, 0.8), ef_hue(U[34].x + 0.55 + U[35].x * 0.16), 0.5) * U[33].y; }
`;

/** Shift, fibre medium, growth renewal and the opening state. Reads A, writes B. */
const STEP0 = /* wgsl */ `
@group(1) @binding(1) var stIn: texture_2d<f32>;
@group(1) @binding(2) var medIn: texture_2d<f32>;
@group(1) @binding(3) var stOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var medOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(5) var gIn: texture_2d<f32>;
@group(1) @binding(6) var gOut: texture_storage_2d<rgba16float, write>;
// Wool as it arrives (in the opening state, and drifting in from outside the grid later): part
// tempered in broad drifts by earlier fires, a function of material position, so there is no seam.
fn ef_seed(m: vec2f, l: i32) -> vec4f {
  let q = m * (1.0 / 500.0);
  let n = 0.7 * noise4(vec3f(rot2(0.9 + f32(l)) * q * 1.6 + vec2f(7.0, 3.0), U[0].w * 13.0 + f32(l) * 5.0))
    + 0.3 * noise4(vec3f(rot2(-0.5 + f32(l) * 0.7) * q * 3.7 + vec2f(1.0, 9.0), U[0].w * 7.0 + f32(l) * 3.0));
  let burnt = smoothstep(0.08, 0.4, n.x);
  let ox = burnt * (0.25 + 1.1 * (n.y * 0.5 + 0.5));
  let tag = fract(U[34].x + 0.33 * floor((n.z * 0.5 + 0.5) * 3.0) + 0.1 * n.w) + select(0.0, 2.0, n.w > 0.6);
  return vec4f(0.0, mix(1.0, 0.2, burnt), ox, tag);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= SW || i.y >= SH * NL) { return; }
  let l = i.y / SH;
  let loc = vec2i(i.x, i.y - l * SH);
  let m = vec2f(loc) + 0.5 + U[4 + l].xy;
  let src = loc + vec2i(U[7 + l].xy);
  let inside = src.x >= 0 && src.y >= 0 && src.x < SW && src.y < SH;
  let j = src + vec2i(0, l * SH);
  // Growth: the music makes the wool. Each kick, note and snare grows a tuft of new fibre where it
  // lands (a note grows a streak along the melody), which then thins away over many seconds.
  var gv = 0.0;
  if (inside && U[0].y < 0.5) { gv = textureLoad(gIn, j, 0).x; }
  let fdt = U[30].w;
  gv *= exp(-fdt / 10.0);
  let p = vec2f(i) + 0.5;
  for (var s = 0; s < 6; s++) {
    let I = U[15 + s * 2];
    let X = U[16 + s * 2];
    if (I.z < ${GROW_WIN}) {
      var q = p - I.xy;
      // A note grows a small tuft at its point; its fire then runs on along the existing fibres.
      if (s < 4) { q = ef_tuft(q, I.xy, l); }
      let r = X.x * select(1.1, 1.6, s >= 4);
      gv += fdt * ef_ease(I.z, ${GROW_WIN}) * I.w * select(0.25, 0.4, s >= 4) * exp(-dot(q, q) / (r * r));
    }
  }
  for (var s = 0; s < 2; s++) {
    let N = U[27 + s];
    if (N.y < ${GROW_WIN}) {
      for (var k = 0; k < SNARE_PTS; k++) {
        if (k % NL != l) { continue; }
        let hp = vec2f(hash11(N.x * 17.31 + f32(k) * 3.7), hash11(N.x * 9.13 + f32(k) * 5.3));
        let cpt = CENTRE + (hp - 0.5) * vec2f(900.0, 500.0) + vec2f(0.0, f32(l * SH));
        let q = p - cpt;
        gv += fdt * ef_ease(N.y, ${GROW_WIN}) * N.z * 0.37 * exp(-dot(q, q) / 220.0);
      }
    }
  }
  gv = min(gv, 1.3);
  textureStore(gOut, i, vec4f(gv, 0.0, 0.0, 1.0));
  let fib = ef_cellFib(m, l, gv);
  textureStore(medOut, i, vec4f(fib.cov, fib.tan, fib.br));
  if (U[0].y > 0.5) {
    // The opening state: the arriving wool, with a few fires alight.
    let sd = ef_seed(m, l);
    var T = 0.0;
    for (var s = 0; s < 4; s++) {
      let hs = vec2f(hash11(U[0].w * 91.0 + f32(s * 3 + l) * 7.3), hash11(U[0].w * 37.0 + f32(s * 5 + l) * 3.1));
      let c = CENTRE + (hs - 0.5) * vec2f(820.0, 460.0);
      T = max(T, smoothstep(12.0, 6.0, length(vec2f(loc) + 0.5 - c)));
    }
    textureStore(stOut, i, vec4f(T * step(0.3, fib.cov) * step(0.5, sd.y) * 1.1, sd.yzw));
    return;
  }
  var st = ef_seed(m, l);
  var covPrev = 1.0;
  if (inside) {
    st = textureLoad(stIn, j, 0);
    covPrev = textureLoad(medIn, j, 0).x;
  }
  // Renewal: where a fibre has grown into an empty cell, it is fresh wool.
  let grow = sat(fib.cov - covPrev) * (1.0 - smoothstep(0.08, 0.3, covPrev));
  st.y = mix(st.y, 1.0, grow);
  st.z = mix(st.z, 0.0, grow);
  textureStore(stOut, i, st);
}`;

/** One burn sub-step. */
const STEP = /* wgsl */ `
@group(1) @binding(1) var stIn: texture_2d<f32>;
@group(1) @binding(2) var medTex: texture_2d<f32>;
@group(1) @binding(3) var stOut: texture_storage_2d<rgba16float, write>;
fn inL(j: vec2i, l: i32) -> bool { return j.x >= 0 && j.x < SW && j.y >= l * SH && j.y < l * SH + SH; }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= SW || i.y >= SH * NL) { return; }
  let l = i.y / SH;
  let h = U[0].x;
  let c = textureLoad(stIn, i, 0);
  let mi = textureLoad(medTex, i, 0);
  let cov = mi.x;
  let md = U[3].xy;
  let mb = U[3].z;
  // Heat arriving through the fibres: only between neighbours that are both fibre.
  var S = 0.0;
  var best = 0.0;
  var btag = c.w;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let j = i + vec2i(dx, dy);
      if (!inL(j, l)) { continue; }
      let sj = textureLoad(stIn, j, 0);
      let mj = textureLoad(medTex, j, 0);
      let o = vec2f(f32(dx), f32(dy));
      let e = normalize(o);
      // Heat runs along a fibre, not across to the next one alongside it.
      let al = max(abs(dot(mi.yz, e)), abs(dot(mj.yz, e)));
      let w = select(1.0, 0.7071, dx != 0 && dy != 0) * al * al;
      let cj = mj.x;
      // A melody fire runs only the way the melody moves: ahead it races, sideways it dies out.
      let bias = mix(1.0, 0.15 + mb * max(0.0, dot(-e, md)), step(1.5, sj.w));
      let ct = w * min(cov, cj) * sj.x * bias;
      S += ct;
      if (ct > best) { best = ct; btag = sj.w; }
    }
  }
  S *= 1.0 / 6.83;
  // Radiant heat across short gaps: slow, so fire jumps between fibres only after a while.
  var rad = 0.0;
  var ro = array<vec2i, 8>(vec2i(3, 0), vec2i(-3, 0), vec2i(0, 3), vec2i(0, -3), vec2i(2, 2), vec2i(-2, 2), vec2i(2, -2), vec2i(-2, -2));
  for (var k = 0; k < 8; k++) {
    let j = i + ro[k];
    if (inL(j, l)) { rad += textureLoad(stIn, j, 0).x; }
  }
  rad *= U[2].w * 0.125 * cov;

  var T = c.x;
  var f = c.y;
  var ox = c.z;
  var tag = c.w;
  let mc = vec2f(f32(i.x), f32(i.y - l * SH)) + U[4 + l].xy;
  let thr = U[1].y * (0.65 + 0.7 * hash12(mc)) * select(select(1.7, 1.3, l == 1), 1.0, l == 0);
  let fuelOk = smoothstep(0.03, 0.25, f);
  let fib = smoothstep(0.05, 0.3, cov);
  let ign = smoothstep(thr, thr * 1.8, S + rad + T) * fuelOk * fib;
  // Each fibre burns at its own pace, so the front fingers out along the fast ones.
  let pace = 0.15 + 2.2 * mi.w * mi.w * mi.w;

  // Ignitions from the music.
  var src = 0.0;
  var srcTag = tag;
  var srcHot = 1.2;
  let p = vec2f(i) + 0.5;
  for (var s = 0; s < 6; s++) {
    let I = U[15 + s * 2];
    let X = U[16 + s * 2];
    if (I.z < X.z) {
      // Ragged: each fibre catches out to its own reach, so the lit patch is a burst of strands.
      let ramp = smoothstep(0.0, ${IGN_RISE}, I.z);
      let R = X.x * (0.35 + 0.65 * mi.w * mi.w) * (0.3 + 0.7 * ramp);
      var q = p - I.xy;
      if (s >= 4) {
        // A note is a streak drawn quickly along the melody's direction from its point.
        let t = clamp(dot(q, md), 0.0, 90.0 * smoothstep(0.0, 0.35, I.z));
        q -= md * t;
      } else {
        q = ef_tuft(q, I.xy, l);
      }
      let e = smoothstep(R, R * 0.6, length(q)) * I.w * fib;
      if (e > src) { src = e; srcTag = X.y; srcHot = X.w * ramp; }
    }
  }
  for (var s = 0; s < 2; s++) {
    let N = U[27 + s];
    if (N.y < ${SNARE_WIN}) {
      for (var k = 0; k < SNARE_PTS; k++) {
        if (k % NL != l) { continue; }
        let hp = vec2f(hash11(N.x * 17.31 + f32(k) * 3.7), hash11(N.x * 9.13 + f32(k) * 5.3));
        let cpt = CENTRE + (hp - 0.5) * vec2f(900.0, 500.0) + vec2f(0.0, f32(l * SH));
        let ramp = smoothstep(0.0, ${IGN_RISE}, N.y);
        let sr = (0.4 + 0.6 * ramp) * (0.7 + 0.45 * N.z);
        let e = smoothstep(11.0 * sr, 4.0 * sr, length(p - cpt)) * N.z * fib;
        if (e > src) { src = e; srcTag = N.w; srcHot = 1.25 * ramp * N.z; }
      }
    }
  }
  // A cold cell takes on the tag of whatever lights it.
  if (T < 0.12) {
    if (src > 0.02) { tag = srcTag; } else if (ign > 0.02) { tag = btag; }
  }
  // Burning heats toward a level set by the fuel left (white at the front, orange to red behind).
  let tgt = 0.55 + 0.6 * f;
  var dT = U[1].x * pace * ign * (tgt - T) + U[3].w * src * max(srcHot - T, 0.0);
  let cool = mix(U[1].w, U[1].z, smoothstep(0.35, 0.9, T));
  dT -= cool * T * (1.0 - ign);
  T = clamp(T + h * dT, 0.0, 1.6);
  f = max(0.0, f - h * U[2].x * f * smoothstep(0.35, 0.8, T));
  ox += h * U[2].y * T * T * fib;
  ox = select(ox, ox - 1.6, ox > 2.6);
  ox *= exp(-U[11].w * h);
  f += h * U[2].z * (1.0 - f) * step(T, 0.05);
  textureStore(stOut, i, vec4f(T, f, ox, tag));
}`;

/**
 * Surface: each cell's colours (steel or temper, and fire), premultiplied by its fibre coverage.
 * The render filters these with a B-spline and divides by the filtered coverage: smooth along the
 * full-resolution fibres, no stair-steps from the coarser burn grid, no nearest-texel tag lookups.
 */
const SURF = /* wgsl */ `
@group(1) @binding(1) var stTex: texture_2d<f32>;
@group(1) @binding(2) var medTex: texture_2d<f32>;
@group(1) @binding(3) var outA: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var outB: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= SW || i.y >= SH * NL) { return; }
  let st = textureLoad(stTex, i, 0);
  let md = textureLoad(medTex, i, 0);
  let cov = md.x;
  let look = U[33];
  let T = st.x;
  let ox = st.z;
  let tg = st.w;
  let mel = step(1.5, tg);
  let hue = fract(tg);
  // Tempered steel: the oxide's interference colour, tinted by the fire that made it.
  let tc = mix(ef_temper(ox + hue * 0.35 + md.w * 0.3), ef_hue(hue), mix(0.15, 0.6, mel)) * look.z;
  let tAmt = smoothstep(0.03, 0.3, ox);
  let S = mix(ef_steel(), tc, tAmt);
  // Flame: a melody fire burns in the note's colour, white at its hottest.
  var fire = ef_fire(T);
  let tint = smoothstep(0.12, 0.45, T) * (1.0 - smoothstep(1.0, 1.35, T)) * mel;
  fire = mix(fire, ef_hue(hue) * (luma(fire) * 1.6 + 0.05 * T), tint * 0.8) * look.x;
  textureStore(outA, i, vec4f(S, tAmt) * cov);
  textureStore(outB, i, vec4f(fire * cov, cov));
}`;

/** Sparks: thrown off the burning front, flying and fading. */
const SPARKS = /* wgsl */ `
struct Spark { p: vec4f, q: vec4f };
@group(1) @binding(1) var stTex: texture_2d<f32>;
@group(1) @binding(2) var medTex: texture_2d<f32>;
@group(1) @binding(3) var<storage, read_write> sparks: array<Spark>;
fn drift(l: i32) -> vec2f { return select(select(U[32].xy, U[31].zw, l == 1), U[31].xy, l == 0); }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= ${NP}u) { return; }
  var s = sparks[idx];
  if (U[0].y > 0.5) { sparks[idx] = Spark(vec4f(0.0), vec4f(0.0)); return; }
  let dt = U[30].w;
  if (dt <= 0.0) { return; }
  let fr = u32(U[0].z);
  if (s.q.x > 0.0) {
    let l = i32(s.q.w) / 2;
    let ember = (i32(s.q.w) & 1) == 1;
    var v = s.p.zw;
    v.y += select(U[32].z, -0.03, ember) * dt;
    v *= exp(-select(1.4, 0.5, ember) * dt);
    if (ember) {
      let n = noise4fast(vec3f(s.p.xy * 6.0, f32(idx & 63u) + U[30].w * f32(fr) * 0.3));
      v += n.xy * 0.12 * dt;
    }
    let pos = s.p.xy + (v + drift(l)) * dt;
    s = Spark(vec4f(pos, v), vec4f(s.q.x - dt, s.q.yzw));
    if (abs(pos.y) > 0.7 || abs(pos.x) > 1.4) { s.q.x = 0.0; }
    sparks[idx] = s;
    return;
  }
  let r = hashU3(pcg(idx * 7919u + fr * 104729u));
  let r2 = hashU3(pcg(idx * 15485863u + fr * 32452843u + 17u));
  // Probe a cell; a burning front throws sparks. Right after a kick or a note, a share of the probes
  // look round its ignition, so the fibres it lit spray sparks along their length.
  var spd = U[29].y;
  var rate = U[29].x;
  var pl = select(select(2, 1, r.y < 0.92), 0, r.y < 0.7);
  var cell = vec2i(i32(CENTRE.x + (r.z - 0.5) * 980.0), i32(CENTRE.y + (r2.x - 0.5) * 600.0));
  var burst = false;
  // Rates are sparks per burning cell per second; the probe density converts them to a chance.
  let D = f32(${NP}) * 0.9;
  var pmul = 980.0 * 600.0 / (D * 0.75 * select(select(0.08, 0.22, pl == 1), 0.7, pl == 0)) * select(select(0.25, 0.5, pl == 1), 1.0, pl == 0);
  let K0 = U[15];
  let N0 = U[23];
  // The search area grows with the fire, so the sparks keep coming off its front as it spreads.
  if (K0.z < 0.7 && r.x < 0.25) {
    pl = 0;
    let side = 2.0 * (U[16].x + 4.0 + K0.z * 70.0);
    cell = vec2i(K0.xy + (vec2f(r.z, r2.x) - 0.5) * side);
    rate = (0.15 + 0.2 * smoothstep(0.0, 0.2, K0.z) * (1.0 - smoothstep(0.25, 0.5, K0.z))) * K0.w;
    pmul = side * side / (D * 0.25);
    spd *= 1.25;
    burst = true;
  } else if (N0.z < 0.6 && r.x < 0.4) {
    pl = 0;
    let side = 2.0 * (U[24].x + 6.0 + N0.z * 70.0);
    cell = vec2i(N0.xy + (vec2f(r.z, r2.x) - 0.5) * side);
    rate = (0.6 + 1.4 * smoothstep(0.0, 0.2, N0.z) * (1.0 - smoothstep(0.25, 0.5, N0.z))) * N0.w;
    pmul = side * side / (D * 0.4);
    burst = true;
  }
  cell = clamp(cell, vec2i(0), vec2i(SW - 1, SH - 1));
  let j = cell + vec2i(0, pl * SH);
  let st = textureLoad(stTex, j, 0);
  let md = textureLoad(medTex, j, 0);
  let w = smoothstep(0.5, 0.95, st.x) * select(smoothstep(0.05, 0.5, st.y), 1.0, burst) * md.x;
  let spawn = r2.y < w * rate * dt * pmul;
  let l = pl;
  let pos = ef_toView(vec2f(cell) + 0.5 + (r2.zx - 0.5), pl);
  let nrm = rot2(-U[7 + pl].z) * vec2f(-md.z, md.y);
  let ra = r2.z * 37.0 * TAU;
  let dir = nrm * select(-0.6, 0.6, fract(r.y * 7.0) > 0.5) + vec2f(cos(ra), sin(ra)) * 1.1 + vec2f(0.0, -0.3);
  let tag = st.w;
  if (!spawn) { return; }
  let ember = r2.z < 0.12;
  let life = select(0.3 + 0.9 * r2.x * r2.x, 1.6 + 2.2 * r2.x, ember);
  let sp2 = spd * select(0.35 + 0.9 * r.z, 0.12 + 0.12 * r.z, ember);
  let v = normalize(dir + vec2f(1e-4, 0.0)) * sp2;
  sparks[idx] = Spark(vec4f(pos, v), vec4f(life, life, tag, f32(l * 2 + select(0, 1, ember))));
}`;

const RENDER = /* wgsl */ `
// A colour turned round the grey axis (a hue turn at the same brightness).
fn ef_hrot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let cs = cos(a);
  return max(c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs), vec3f(0.0));
}
struct Spark { p: vec4f, q: vec4f };
@group(1) @binding(1) var surfA: texture_2d<f32>;
@group(1) @binding(2) var<storage, read> sparks: array<Spark>;
@group(1) @binding(3) var gTex: texture_2d<f32>;
@group(1) @binding(4) var surfB: texture_2d<f32>;
${FULLSCREEN_VS}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let v = (in.uv - 0.5) * vec2f(F.aspect, 1.0);
  let Ld = U[34].yz;
  let look = U[33];
  let hue0 = U[34].x;
  let steel = ef_steel();
  var col = vec3f(0.0);
  for (var l = 2; l >= 0; l--) {
    let s = ef_toSim(v, l);
    let m = s + U[4 + l].xy;
    let sc = vec2f(clamp(s.x, 0.5, f32(SW) - 0.5), clamp(s.y, 0.5, f32(SH) - 0.5));
    let auv = vec2f(sc.x / f32(SW), (sc.y + f32(l * SH)) / f32(SH * NL));
    let P = ef_phi(m, l, ef_bspline(gTex, auv).x);
    let gx = dpdx(P.phi);
    let gy = dpdy(P.phi);
    let ax = dpdx(P.along);
    let ay = dpdy(P.along);
    let L = U[12 + l];
    let fib = ef_mask(P, gx, gy, ax, ay, L.y, l, 0.22, 0.45);
    let edge = smoothstep(0.0, 24.0, min(min(s.x, f32(SW) - s.x), min(s.y, f32(SH) - s.y)));
    // The cells' shaded colours, B-spline filtered and normalised by their filtered fibre coverage
    // (falling back to plain steel where the grid has no fibre nearby).
    let A = ef_bspline(surfA, auv);
    let B = ef_bspline(surfB, auv);
    let eps = 0.04;
    let wsum = max(B.a, 0.0) + eps;
    // Each snare turns the temper colours a step round the wheel; a melody note pulls a broad band,
    // at its pitch's height, toward its own colour. Both last and glide in from rest.
    let S0 = ef_hrot((A.rgb + steel * eps) / wsum, U[35].x);
    let nb = exp(-pow((v.y - U[35].w) / 0.17, 2.0)) * U[35].z;
    let S = mix(S0, ef_hue(U[35].y) * max(S0.r, max(S0.g, S0.b)), nb);
    let tAmt = sat(A.a / wsum);
    // Fire is not spread to full strength: weak nearby coverage (a fibre beside a burning one) dims it,
    // so the flame stays on the fibres that burn instead of glowing across the tangle.
    let fire = max(B.rgb, vec3f(0.0)) / max(B.a, 0.6);
    // Glinting where a fibre turns across the light, in the temper colour where it is tempered.
    let glint = pow(abs(dot(vec2f(-fib.tan.y, fib.tan.x), Ld)), 28.0) * fib.br;
    // Glints on bare steel take the steel's tint, so the sparkle stays coloured rather than white.
    let gc = mix(vec3f(1.0, 0.97, 0.92), ef_hue(hue0 + 0.55 + U[35].x * 0.16), 0.7) * (1.0 - 0.6 * tAmt) + 1.2 * max(S - steel * (1.0 - tAmt), vec3f(0.0));
    var base = S * (0.45 + 0.55 * fib.br);
    base += gc * glint * look.w;
    let lc = (base + fire) * L.z * edge;
    // Depth: the far sheets sit in a faint haze of the shadow hue.
    let fog = select(select(0.0, 0.35, l == 1), 0.65, l == 2);
    let lcf = mix(lc, lc * vec3f(0.4, 0.5, 0.75) + palL(hue0 + 0.6, 0.003), fog);
    col = col * (1.0 - fib.cov * 0.85) + lcf * fib.cov;
  }
  return vec4f(col, 1.0);
}

struct SOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) color: vec3f, @location(2) stretch: f32 };
@vertex fn vsS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SOut {
  var o: SOut;
  let s = sparks[ii];
  if (s.q.x <= 0.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let l = i32(s.q.w) / 2;
  let ember = (i32(s.q.w) & 1) == 1;
  let res = F.res;
  let a = s.p.xy * res.y;
  let b = (s.p.xy - s.p.zw * 0.05) * res.y;
  let depth = select(select(0.55, 0.75, l == 1), 1.0, l == 0);
  let sizePx = (0.7 + 0.5 * U[29].z) * depth * select(1.0, 0.8, ember) * res.y / 1080.0 + 0.35;
  var dir = a - b;
  let len = min(length(dir), 120.0);
  dir = select(vec2f(1.0, 0.0), dir / max(length(dir), 1e-5), len > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let halfLen = len * 0.5 + sizePx;
  let px = (a + b) * 0.5 + dir * c.x * halfLen + nrm * c.y * sizePx;
  o.pos = vec4f(px.x / (res.x * 0.5), -px.y / (res.y * 0.5), 0.0, 1.0);
  o.q = vec2f(c.x * halfLen / sizePx, c.y);
  o.stretch = halfLen / sizePx - 1.0;
  // Hot sparks are white-yellow; as they cool they turn orange, then the spectrum's colour.
  let life = s.q.x / max(s.q.y, 1e-3);
  let heat = select(pow(life, 0.8), 0.35 + 0.25 * life, ember);
  var cc = ef_fire(0.3 + 0.95 * heat);
  let spec = ef_hue(U[34].x + 0.15 + 0.6 * U[29].w);
  cc = mix(cc, spec * luma(cc) * 2.2, smoothstep(0.55, 1.0, 1.0 - heat) * 0.45);
  let tg = s.q.z;
  cc = mix(cc, ef_hue(fract(tg)) * (luma(cc) * 1.8 + 0.1), step(1.5, tg) * 0.6);
  let fade = smoothstep(0.0, 0.15, life) * select(1.0, 0.5 + 0.5 * sin(f32(ii) * 1.7 + s.q.x * 23.0), ember);
  o.color = cc * fade * depth * 2.4 / (1.0 + len / (sizePx * 3.0));
  return o;
}
@fragment fn fsS(in: SOut) -> @location(0) vec4f {
  let d = vec2f(max(abs(in.q.x) - in.stretch, 0.0), in.q.y);
  let fall = exp(-dot(d, d) * 3.0);
  return vec4f(in.color * fall, 1.0);
}`;

type Ign = { mx: number; my: number; layer: number; age: number; strength: number; radius: number; tag: number; win: number; hot: number };

type Pipes = { step0: GPUComputePipeline; step: GPUComputePipeline; surf: GPUComputePipeline; sparks: GPUComputePipeline; draw: GPURenderPipeline; drawS: GPURenderPipeline };
type Groups = { step0: GPUBindGroup; stepBA: GPUBindGroup; stepAB: GPUBindGroup; surf: GPUBindGroup; sparks: GPUBindGroup; render: GPUBindGroup };

/** One step of a critically damped spring (value at r[i], velocity at r[i + 1]) toward a target. */
function react(r: Float64Array, i: number, target: number, w: number, dt: number): void {
  const e = Math.exp(-w * dt);
  const d = r[i] - target;
  const c = r[i + 1] + w * d;
  r[i] = target + (d + c * dt) * e;
  r[i + 1] = (r[i + 1] - w * c * dt) * e;
}

const rotate = (x: number, y: number, a: number): [number, number] => [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y];

class EmberInstance implements SceneInstance {
  readonly meta = META;
  private readonly u = new Float32Array(UVEC * 4);
  private readonly morph = new Morph(1);
  private lastT = -1;
  private seed = -1;
  private dt = 0;
  private steps = 1;
  private reset = true;
  private frame = 0;
  private hue = 0;
  /** Eased reactions (value, velocity): kick light swing, snare temper turn, note hue, note pull, note height. */
  private readonly rx = new Float64Array(10);
  private noteHue = 0;
  private noteY = 0;
  private tint = 0;
  private kSum = 0;
  private sSum = 0;
  private aspect = 16 / 9;
  private prevPitch = 0;
  private melDir: [number, number] = [1, 0];
  private readonly off = new Float64Array(NL * 2);
  private readonly floorOff = new Float64Array(NL * 2);
  private kicks: Ign[] = [];
  private notes: Ign[] = [];
  private snares: { seed: number; age: number; strength: number; tag: number }[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly group0: GPUBindGroup,
    private readonly paramBuffer: GPUBuffer,
    private readonly uBuffer: GPUBuffer,
    private readonly pipes: Pipes,
    private readonly groups: Groups,
    private readonly medA: GPUTexture,
    private readonly medB: GPUTexture,
    private readonly gA: GPUTexture,
    private readonly gB: GPUTexture,
    private readonly owned: (GPUTexture | GPUBuffer)[],
  ) {}

  /** View point -> material position on sheet l (cells), using this frame's transform. */
  private toMaterial(vx: number, vy: number, l: number, rot: number): [number, number] {
    const [rx, ry] = rotate(vx, vy, rot);
    return [rx * K + SW / 2 + this.off[l * 2], ry * K + SH / 2 + this.off[l * 2 + 1]];
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
    const a = this.aspect;
    const e = m.energySlow;

    // Chord colour: the root around the circle of fifths, eased the short way round.
    const root = m.chord && m.chord.root >= 0 ? m.chord.root : 0;
    const hueTarget = g[3] + ((root * 7) % 12) / 12 + (m.chord?.quality.startsWith('m') ? 0.08 : 0);
    if (seek) {
      this.reset = true;
      this.frame = 0;
      this.kicks = [];
      this.notes = [];
      this.snares = [];
      this.prevPitch = m.leadPitch;
      this.melDir = [1, 0];
      this.hue = hueTarget;
      this.rx.fill(0);
      this.rx[4] = this.noteHue = hueTarget + 0.3;
      this.noteY = 0;
      this.tint = 0;
      this.kSum = this.sSum = 0;
      for (let l = 0; l < NL; l++) {
        this.off[l * 2] = Math.floor(g[2] * 6000 + l * 1700 + m.time * 7);
        this.off[l * 2 + 1] = Math.floor(g[5] * 6000 + l * 900);
      }
    }
    const dh = ((((hueTarget - this.hue + 0.5) % 1) + 1) % 1) - 0.5;
    this.hue += dh * (1 - Math.exp(-dt / 0.8));

    // Flow: each sheet drifts gently at its own pace along a slowly turning heading (parallax), and the
    // whole view turns slowly.
    // Steady inputs only (travel never steps on a beat), so the view never lurches with the drums.
    const rotG = 0.06 * Math.sin(mo.travel * 0.12 + g[7] * TAU);
    const rots = [0, 1, 2].map((l) => rotG * (1 + 0.25 * l) + (l - 1) * 0.02);
    const head = g[1] * TAU + 0.6 * Math.sin(mo.travel * 0.07 + g[6] * 5);
    const dTravel = seek ? 0 : dt * 0.13 * mo.flow * (0.85 + 0.3 * e);
    const spd = [30, 19, 11];
    const shift: number[] = [];
    const drift: number[] = [];
    for (let l = 0; l < NL; l++) {
      const vx = Math.cos(head) * spd[l];
      const vy = Math.sin(head) * spd[l] * 0.6;
      const f0x = Math.floor(this.off[l * 2]);
      const f0y = Math.floor(this.off[l * 2 + 1]);
      this.off[l * 2] += vx * dTravel;
      this.off[l * 2 + 1] += vy * dTravel;
      const f1x = Math.floor(this.off[l * 2]);
      const f1y = Math.floor(this.off[l * 2 + 1]);
      shift.push(seek ? 0 : f1x - f0x, seek ? 0 : f1y - f0y);
      this.floorOff[l * 2] = f1x;
      this.floorOff[l * 2 + 1] = f1y;
      // On screen the content moves against the offset.
      const rate = dt > 0 ? dTravel / dt : 0;
      const [sx, sy] = rotate(-vx * rate, -vy * rate, -rots[l]);
      drift.push(sx / K, sy / K);
    }

    // Events. Every ignition is born having aged one frame.
    const live = !seek && dt > 0;
    for (const w of this.kicks) w.age += dt;
    for (const w of this.notes) w.age += dt;
    for (const w of this.snares) w.age += dt;
    const kickTag = this.hue + 0.09 * (mo.kicks % 4);
    if (live && mo.kickAge === 0) {
      // Each kick lights a new place: a golden-angle walk over the frame.
      const k = mo.kicks;
      const ka = g[4] * TAU + 2.39996 * k;
      const kr = 0.25 + 0.75 * Math.sqrt((k * 0.618034 + g[6]) % 1);
      const vx = Math.cos(ka) * kr * a * 0.36 + 0.06 * Math.sin(at[0]);
      const vy = Math.sin(ka) * kr * 0.34;
      // Strength from the kick's own level (a faint kick lights a small, cool patch and a hard one a
      // full burst): it sets the ignition rate, its peak heat and its reach.
      const lv = mo.kickLevel;
      const s = lv;
      const r = (55 + 25 * e) * (0.45 + 0.55 * lv);
      // The same point on all three sheets, so it always finds wool at some depth.
      for (const l of [2, 1, 0]) {
        const [mx, my] = this.toMaterial(vx, vy, l, rots[l]);
        this.kicks.unshift({ mx, my, layer: l, age: dt, strength: s, radius: r * [1, 0.8, 0.65][l], tag: kickTag, win: KICK_WIN, hot: 1.3 * lv });
      }
    }
    if (live && mo.snareAge === 0) {
      this.snares.unshift({ seed: mo.snares * 1.618 + g[7] * 97, age: dt, strength: mo.snareLevel, tag: this.hue + 0.5 });
    }
    const pitch = Math.max(-1.1, Math.min(1.1, m.leadPitch));
    const noteTag = 2 + ((((this.hue + 0.3 + 0.32 * pitch) % 1) + 1) % 1);
    if (live && mo.leadAge === 0) {
      const iv = (m.leadPitch - this.prevPitch) * 12;
      this.prevPitch = m.leadPitch;
      // The melody runs forward, climbing or falling with the line.
      const dy = -Math.max(-1.3, Math.min(1.3, iv / 4));
      const dl = Math.hypot(1, dy);
      this.melDir = [1 / dl, dy / dl];
      const vx = a * 0.34 * Math.sin(at[1] * 0.7 + mo.notes * 0.53) - 0.08 * this.melDir[0];
      const vy = -0.36 * pitch;
      const [mx, my] = this.toMaterial(vx, vy, 0, rots[0]);
      const nl = mo.noteLevel;
      this.notes.unshift({ mx, my, layer: 0, age: dt, strength: nl, radius: (28 + 8 * e) * (0.5 + 0.5 * nl), tag: noteTag, win: NOTE_WIN, hot: 1.25 * nl });
    }
    this.kicks.length = Math.min(this.kicks.length, 4);
    this.notes.length = Math.min(this.notes.length, 2);
    this.snares.length = Math.min(this.snares.length, 2);

    const u = this.u;
    u.fill(0);
    // Sub-steps: a fixed rate, rounded up to an odd count so the state always ends in texture A.
    let n = Math.max(1, Math.ceil(dt * STEP_RATE - 1e-6));
    if (n % 2 === 0) n++;
    this.steps = n;
    u[0] = dt / n;
    u[1] = this.reset ? 1 : 0;
    u[2] = this.frame;
    u[3] = (g[0] * 7.13 + g[7]) % 1;
    u[4] = 55 + 30 * e; // burn rate
    u[5] = 0.1; // ignition threshold
    u[6] = 4.5; // cooling while hot
    u[7] = 0.55; // cooling as embers
    u[8] = 6; // fuel burn
    u[9] = 1.4; // oxide growth
    u[10] = 0.035; // fuel regrowth
    u[11] = 0.06; // radiant heat
    const [mdx, mdy] = rotate(this.melDir[0], this.melDir[1], rots[0]);
    u[12] = mdx;
    u[13] = mdy;
    u[14] = 1.9;
    u[15] = 80; // ignition rate
    for (let l = 0; l < NL; l++) {
      u[16 + l * 4] = this.floorOff[l * 2];
      u[17 + l * 4] = this.floorOff[l * 2 + 1];
      u[18 + l * 4] = this.off[l * 2] - this.floorOff[l * 2];
      u[19 + l * 4] = this.off[l * 2 + 1] - this.floorOff[l * 2 + 1];
      u[28 + l * 4] = shift[l * 2];
      u[29 + l * 4] = shift[l * 2 + 1];
      u[30 + l * 4] = rots[l];
      u[31 + l * 4] = K;
    }
    // Fibre field: geometry fixed per cue (DNA), drifting very slowly; the clumps move with the morph,
    // so fibres grow in and recede all the time.
    u[40] = mo.travel * 0.01;
    u[41] = at[2] * 0.22 + at[3] * 0.14 + mo.travel * 0.03;
    u[42] = 130 + 110 * g[4];
    u[43] = 8 + 12 * g[6];
    u[148] = 0.35 + 0.35 * g[3]; // crimp
    // Fine detail (RULES v7): high melodies, arps and backing rework the fibres' crimp itself.
    // Each upper note slides the short crimp along every fibre (upperPhase: eased, by its level), the
    // backing nudges the long crimp, and loud highs deepen the short crimp while quiet highs smooth it.
    const da = mo.detailAt;
    u[149] = (0.05 + 0.1 * g[7]) * (0.75 + 0.5 * mo.detailDrive);
    u[150] = da[0] * 0.1 + mo.upperPhase * 2.6;
    u[151] = mo.backingPhase * 0.15;
    u[44] = g[1] * TAU;
    u[45] = 0.42 + 0.42 * g[2];
    u[46] = -0.1 + 0.06 * Math.sin(at[4]);
    u[47] = 0.008;
    const spacing = [11, 8, 6.5];
    const hw = [1.2, 0.65, 0.42];
    const bright = [1.0, 0.5, 0.26];
    for (let l = 0; l < NL; l++) {
      u[48 + l * 4] = spacing[l] * (0.9 + 0.25 * g[5]);
      u[49 + l * 4] = hw[l];
      u[50 + l * 4] = bright[l];
      u[51 + l * 4] = g[0] * 11 + l * 7.3;
    }
    // Ignitions: atlas positions this frame.
    const put = (slot: number, w: Ign | undefined) => {
      const b = 60 + slot * 8;
      if (!w) {
        u[b + 2] = 99;
        return;
      }
      u[b] = w.mx - this.floorOff[w.layer * 2];
      u[b + 1] = w.my - this.floorOff[w.layer * 2 + 1] + w.layer * SH;
      u[b + 2] = w.age;
      u[b + 3] = w.strength;
      u[b + 4] = w.radius;
      u[b + 5] = w.tag;
      u[b + 6] = w.win;
      u[b + 7] = w.hot;
    };
    for (let s = 0; s < 4; s++) put(s, this.kicks[s]);
    for (let s = 0; s < 2; s++) put(4 + s, this.notes[s]);
    for (let s = 0; s < 2; s++) {
      const w = this.snares[s];
      u[108 + s * 4] = w ? w.seed : 0;
      u[109 + s * 4] = w ? w.age : 99;
      u[110 + s * 4] = w ? w.strength : 0;
      u[111 + s * 4] = w ? w.tag : 0;
    }
    // Sparks from the spectrum: flux and energy set the rate, the bass their size, the highs their
    // speed and the centroid their colour as they cool.
    u[116] = 0.12 * (0.35 + 0.8 * m.energy + 2.0 * m.flux);
    u[117] = 0.32 + 0.3 * m.high + 0.2 * m.energy;
    u[118] = 0.6 + 1.4 * (1 - Math.exp((-1.6 / 1.4) * Math.max(0, m.bass)));
    u[119] = Math.min(1, Math.max(0, m.centroid));
    u[123] = dt;
    u[124] = drift[0];
    u[125] = drift[1];
    u[126] = drift[2];
    u[127] = drift[3];
    u[128] = drift[4];
    u[129] = drift[5];
    u[130] = 0.42; // gravity
    // Look: the glow of the fire follows the energy.
    u[132] = 0.6 + 0.35 * e + 0.25 * m.mid;
    u[133] = 0.075; // steel
    u[134] = 0.3; // temper
    u[135] = 0.8; // glint
    u[136] = this.hue;
    // Lasting reactions, each gliding in from rest on a critically damped spring (half in by about
    // 0.3 s, settled by about 0.7 s):
    //  - kicks swing the light a step round, so the glints slide along every fibre;
    //  - snares turn the temper colours and the steel's tint a step round the wheel;
    //  - notes pull a broad band of the wool, at the pitch's height, toward their own colour.
    if (live && mo.leadAge === 0) {
      const np = Math.max(-1, Math.min(1, mo.notePitch));
      const to = this.hue + 0.3 + np * 0.5 + (mo.notes & 1 ? 0.14 : -0.14);
      const nl = mo.noteLevel;
      this.noteHue = this.rx[4] + (((((to - this.rx[4] + 0.5) % 1) + 1) % 1) - 0.5) * nl;
      this.noteY += (-np * 0.35 - this.noteY) * nl;
      this.tint += (0.75 - this.tint) * nl;
    }
    // Lasting steps: each kick and snare by its own level.
    if (live && mo.kickAge === 0) this.kSum += 1.2 * mo.kickLevel;
    if (live && mo.snareAge === 0) this.sSum += 0.8 * mo.snareLevel;
    const W = 5.5;
    react(this.rx, 0, this.kSum, W, dt);
    react(this.rx, 2, this.sSum, W, dt);
    react(this.rx, 4, this.noteHue, W, dt);
    react(this.rx, 6, this.tint, W, dt);
    react(this.rx, 8, this.noteY, W, dt);
    u[140] = this.rx[2];
    u[141] = this.rx[4];
    u[142] = this.rx[6];
    u[143] = this.rx[8];
    const la = at[6] * 0.35 + g[6] * TAU + this.rx[0];
    u[137] = Math.cos(la);
    u[138] = Math.sin(la);
    u[139] = e;
    if (dt > 0) this.frame++;
    this.dt = dt;
    this.device.queue.writeBuffer(this.uBuffer, 0, u);
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
    const P = this.pipes;
    const G = this.groups;
    if (this.dt > 0 || this.reset) {
      const gx = Math.ceil(SW / 8);
      const gy = Math.ceil((SH * NL) / 8);
      const cp = encoder.beginComputePass({ label: 'ember-fibres-sim' });
      cp.setBindGroup(0, this.group0);
      cp.setPipeline(P.step0);
      cp.setBindGroup(1, G.step0);
      cp.dispatchWorkgroups(gx, gy);
      cp.setPipeline(P.step);
      for (let k = 0; k < this.steps; k++) {
        cp.setBindGroup(1, k % 2 === 0 ? G.stepBA : G.stepAB);
        cp.dispatchWorkgroups(gx, gy);
      }
      cp.setPipeline(P.surf);
      cp.setBindGroup(1, G.surf);
      cp.dispatchWorkgroups(gx, gy);
      cp.setPipeline(P.sparks);
      cp.setBindGroup(1, G.sparks);
      cp.dispatchWorkgroups(NP / 256);
      cp.end();
      encoder.copyTextureToTexture({ texture: this.medB }, { texture: this.medA }, [SW, SH * NL]);
      encoder.copyTextureToTexture({ texture: this.gB }, { texture: this.gA }, [SW, SH * NL]);
      this.reset = false;
    }
    const pass = encoder.beginRenderPass({
      label: 'ember-fibres',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setBindGroup(0, this.group0);
    pass.setBindGroup(1, G.render);
    pass.setPipeline(P.draw);
    pass.draw(3);
    pass.setPipeline(P.drawS);
    pass.draw(6, NP);
    pass.end();
  }

  destroy(): void {
    this.paramBuffer.destroy();
    for (const r of this.owned) r.destroy();
  }
}

type Slot = 'tex' | 'out16' | 'rw' | 'ro';

const factory: SceneFactory = {
  meta: META,
  async create(device: GPUDevice, shared: SharedResources) {
    const prelude = `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${HEAD}`;
    const layout = (slots: Slot[], vis: number) =>
      device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: vis, buffer: { type: 'uniform' } },
          ...slots.map((s, i): GPUBindGroupLayoutEntry => {
            const binding = i + 1;
            if (s === 'tex') return { binding, visibility: vis, texture: { sampleType: 'float' } };
            if (s === 'rw') return { binding, visibility: vis, buffer: { type: 'storage' } };
            if (s === 'ro') return { binding, visibility: vis, buffer: { type: 'read-only-storage' } };
            return { binding, visibility: vis, storageTexture: { access: 'write-only', format: 'rgba16float' } };
          }),
        ],
      });
    const C = GPUShaderStage.COMPUTE;
    const l0 = layout(['tex', 'tex', 'out16', 'out16', 'tex', 'out16'], C);
    const l1 = layout(['tex', 'tex', 'out16'], C);
    const l2 = layout(['tex', 'tex', 'rw'], C);
    const lr = layout(['tex', 'ro', 'tex', 'tex'], GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX);
    const ls = layout(['tex', 'tex', 'out16', 'out16'], C);
    const comp = async (code: string, name: string, l: GPUBindGroupLayout) => {
      const module = await compileModule(device, `${prelude}\n${code}`, `ember-fibres-${name}`);
      return device.createComputePipelineAsync({
        label: `ember-fibres-${name}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, l] }),
        compute: { module, entryPoint: 'main' },
      });
    };
    const rModule = await compileModule(device, `${prelude}\n${RENDER}`, 'ember-fibres-draw');
    const rLayout = device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, lr] });
    const [step0, step, surf, sparks, draw, drawS] = await Promise.all([
      comp(STEP0, 'step0', l0),
      comp(STEP, 'step', l1),
      comp(SURF, 'surf', ls),
      comp(SPARKS, 'sparks', l2),
      device.createRenderPipelineAsync({
        label: 'ember-fibres-draw',
        layout: rLayout,
        vertex: { module: rModule, entryPoint: 'vs' },
        fragment: { module: rModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      }),
      device.createRenderPipelineAsync({
        label: 'ember-fibres-sparks',
        layout: rLayout,
        vertex: { module: rModule, entryPoint: 'vsS' },
        fragment: {
          module: rModule,
          entryPoint: 'fsS',
          targets: [{ format: HDR_FORMAT, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }],
        },
        primitive: { topology: 'triangle-list' },
      }),
    ]);

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const tex = (label: string) => device.createTexture({ label: `ember-fibres-${label}`, size: [SW, SH * NL], format: 'rgba16float', usage });
    const stA = tex('stateA');
    const stB = tex('stateB');
    const medA = tex('mediumA');
    const medB = tex('mediumB');
    const gA = tex('growA');
    const gB = tex('growB');
    const surfA = tex('surfA');
    const surfB = tex('surfB');
    const sparkBuf = device.createBuffer({ label: 'ember-fibres-sparks', size: NP * 32, usage: GPUBufferUsage.STORAGE });
    const uBuffer = device.createBuffer({ label: 'ember-fibres-u', size: UVEC * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bind = (l: GPUBindGroupLayout, ...rs: (GPUTexture | GPUBuffer)[]) =>
      device.createBindGroup({
        layout: l,
        entries: [
          { binding: 0, resource: { buffer: uBuffer } },
          ...rs.map((r, i) => ({ binding: i + 1, resource: r instanceof GPUTexture ? r.createView() : { buffer: r } })),
        ],
      });
    const groups: Groups = {
      step0: bind(l0, stA, medA, stB, medB, gA, gB),
      stepBA: bind(l1, stB, medB, stA),
      stepAB: bind(l1, stA, medB, stB),
      surf: bind(ls, stA, medB, surfA, surfB),
      sparks: bind(l2, stA, medB, sparkBuf),
      render: bind(lr, surfA, sparkBuf, gA, surfB),
    };
    const paramBuffer = shared.createSceneParamBuffer('ember-fibres-params');
    const group0 = shared.createSceneBindGroup(paramBuffer, 'ember-fibres');
    return new EmberInstance(device, group0, paramBuffer, uBuffer, { step0, step, surf, sparks, draw, drawS }, groups, medA, medB, gA, gB, [stA, stB, medA, medB, gA, gB, surfA, surfB, sparkBuf, uBuffer]);
  },
};

export default factory;
