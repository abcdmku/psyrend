import { compileModule } from '../../gpu/context';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { Morph, wave } from '../morph';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Glossy Liquid: you glide low over a sea of black lacquered liquid marbled with bundles of fine neon
 * bands (some bundles solid ribbons of dye with bright rims), under a clear coat that mirrors long
 * strips of coloured light. The bands are the contour lines of a field carried by the liquid: its
 * eddies swirl them and the liquid streams through the eddies all the time, so the marbling always
 * flows; long swells roll under the surface. The morph drives the large shapes: eddy size, strength
 * and phases, and the swells' height, size, crest and heading.
 *
 * Beats burn through the bands. A compute pass keeps the beat state in the liquid's own material
 * coordinates (so whatever a front leaves behind flows on with the liquid) as an arrival-time field:
 * each cell learns when the newest front reaches it, conduction runs fast along the band lines and
 * slowly across them, and every front has a few seconds of fuel. So fronts race down the fibres in
 * ragged fingers, branch where the bands fork, burn out, and leave the bands transformed. State is
 * read where the structure carries it (each line on its centre, each ribbon on its middle), so a
 * change runs along the channel:
 *  - kick: a white-hot front ignites on a stretch of fibres ahead and burns outward along them,
 *    cooling through yellow and orange; every band it passes steps to the next colour for good;
 *  - snare: a fast electric front in a second colour races almost only along the lines and leaves
 *    their flanks in a new tint (a new one each snare);
 *  - melody: each note lays a ribbon of three ink threads of its pitch colour along one band channel,
 *    from a point set by the pitch (low notes left, high notes right), brightest at its head; it drifts
 *    with the liquid, thins where its ink ran out and fades over a few seconds;
 *  - chords lean the morph (the eddies and swells) and ease the base hue;
 *  - the spectrum (averaged over half a second) shapes the band palette (centroid sets the hue spread,
 *    each bundle glows with its own slice of the spectrum) and the gloss (highs sharpen and brighten
 *    the clear coat, each light strip follows a band of the spectrum);
 *  - energy sets the pace of the flow and the glide (only long quiet slows them);
 *  - every reaction scales with its own hit's strength (morph's event levels, captured as it lands):
 *    a faint kick ignites a small patch that burns briefly and dimly, a hard one a long bright run;
 *  - the high end works at the fine scale: high melodies, arps, backing chords and hats wobble the
 *    band lines along their length (morph.detailAt sets the wobble's phases, each high note steps
 *    them by its strength, detailDrive sets its depth), so the fibres themselves re-form finely.
 */

const SIM = 768;
const WIN = 80;
const NU = 24;

const META: SceneMeta = {
  id: 'glossy-liquid',
  name: 'Glossy Liquid',
  energy: [0, 1],
  mood: { valence: 0.5, arousal: 0.55 },
  genres: { edm: 1, techno: 0.9, synthwave: 1, dnb: 0.8, dubstep: 0.8, pop: 0.7, hiphop: 0.7, ambient: 0.7, lofi: 0.6, rock: 0.5, jazz: 0.5, classical: 0.4, acoustic: 0.4 },
  trails: 0,
  kaleido: false,
};

/*
 * Uniform layout (vec4 slots of U):
 *  0 dt, reset, -, tau (flow clock)          1 view focus (world xz), -  (window centre: CB buffer)
 *  2 kick ignition (world x, z, gen or -1, radius)   3 snare ignition (x, z, gen or -1, radius)
 *  4 note ignition (x, z, note id or -1, hue + level)  5 note fuel, kick levels (gen G, G-1, G-2)
 *  6 eddy scale, eddy strength, drift amount, lines per unit
 *  7 drift offset xy, drift z, eddy rotation   8 stream xy, region count, lines per bundle
 *  9-10 eddy phases 0-3 (xy each)   11 eddy phase 4 xy, band seed, bundle fill
 *  12 camera pos, focal   13 right   14 up   15 forward
 *  16 swell amp, swell scale, swell sharpness, swell heading   17 swell phase, kick gen G, swell morph, fine wobble depth
 *  18 hue base, hue spread, snare levels (gen G, G-1)       19 coat, roughness, env gain, exposure
 *  20 env turn, kick age, snare age, lead age   21 kick speed, snare speed, thread speed, snare level (G-2)
 *  22 line width, line bump, ridge bump, snare gen G      23 kick burn time, snare burn time, fine wobble phases
 */
const HEAD = /* wgsl */ `
const SIM: i32 = ${SIM};
const WIN: f32 = ${WIN};
@group(1) @binding(0) var<uniform> U: array<vec4f, ${NU}>;

// World xz -> material coordinates (world units). Eddies (their layout and phase carried by the
// morph and the flow clock) swirl the liquid, a very large drift keeps it from repeating, and the
// material streams through it all.
fn gl_warp(x: vec2f) -> vec2f {
  let s = U[6].x;
  let A = U[6].y;
  let tau = U[0].w;
  var p = x * s;
  let n = noise4(vec3f(x * 0.019 + U[7].xy, tau * 0.011 + U[7].z));
  p += n.xy * U[6].z;
  for (var i = 0; i < 5; i++) {
    let fi = f32(i);
    let k = 1.0 + fi * 0.618;
    let ph = select(select(select(select(U[11].xy, U[10].zw, i < 4), U[10].xy, i < 3), U[9].zw, i < 2), U[9].xy, i < 1);
    let r = rot2(fi * 1.31 + U[7].w);
    let fl = vec2f(tau * (0.23 + 0.06 * fi), -tau * (0.19 + 0.05 * fi));
    p += A / k * sin((r * p).yx * k + ph + fl);
  }
  return p / s + U[8].xy * tau;
}

// The band field in material space: smooth and fixed, so the fronts (stored in the same space)
// keep following the same bands. In line units: one line per unit, centred on half-integers.
fn gl_phiBase(q: vec2f) -> f32 {
  let a = q * 0.21;
  let sd = U[11].z;
  return 0.5 * sin(a.x + 1.4 * sin(a.y * 0.83 + sd)) + 0.5 * sin(a.y * 1.13 - 1.25 * sin(a.x * 0.71 + 2.0 + sd));
}
// Fine wobble (the high end): two short ripples running along the bands, in line units, so each
// line bends finely without crossing its neighbours. Depth and phases come from the detail layer.
fn gl_fine(q: vec2f) -> f32 {
  let A = U[17].w;
  return A * (sin(dot(q, vec2f(1.37, 0.91)) + U[23].z) * 0.6 + sin(dot(q, vec2f(-0.83, 1.71)) + U[23].w) * 0.4);
}
fn gl_phi(q: vec2f) -> f32 { return (gl_phiBase(q) + 0.45 * noise4(vec3f(q * 0.043, U[11].z * 3.7)).x) * U[6].w + gl_fine(q); }
// The same field with a filtered noise sample (cheap; for the simulation's conduction).
fn gl_phiFast(q: vec2f) -> f32 { return (gl_phiBase(q) + 0.45 * noise4fast(vec3f(q * 0.043, U[11].z * 3.7)).x) * U[6].w + gl_fine(q); }
`;

// The material-space window follows the material under the view: (centre, previous centre).
const CENTRE = /* wgsl */ `
@group(1) @binding(1) var<storage, read_write> CB: vec4f;
@compute @workgroup_size(1) fn main() {
  let c = gl_warp(U[1].xy);
  CB = vec4f(c, select(CB.xy, c, U[0].y > 0.5));
}
`;

const STEP = /* wgsl */ `
@group(1) @binding(1) var<uniform> SUB: vec4f;
@group(1) @binding(6) var<storage, read> CB: vec4f;
@group(1) @binding(2) var kIn: texture_2d<f32>;
@group(1) @binding(3) var tIn: texture_2d<f32>;
@group(1) @binding(4) var kOut: texture_storage_2d<rgba32float, write>;
@group(1) @binding(5) var tOut: texture_storage_2d<rgba32float, write>;

// Neighbours: the 8 around and the 8 knight moves (so fronts in open liquid come out round).
const NB = array<vec2i, 16>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1), vec2i(1, 1), vec2i(-1, 1), vec2i(1, -1), vec2i(-1, -1),
  vec2i(2, 1), vec2i(-2, 1), vec2i(2, -1), vec2i(-2, -1), vec2i(1, 2), vec2i(-1, 2), vec2i(1, -2), vec2i(-1, -2));
fn wrapI(i: vec2i) -> vec2i { return (i + vec2i(SIM)) % vec2i(SIM); }
const HORIZON: f32 = 1.0;
// Ignitions start this many seconds before arrival, so even the origin swells in instead of flaring on.
const IGNITE: f32 = 0.16;
// A melody thread is a ribbon of three lines (its own line and one each side), in line units.
const THREAD_BAND: f32 = 1.34;
fn fuelOf(w: f32) -> f32 { return floor(w) / 100.0; }

// One beat channel, packed (gen + fuel / 4, age): a neighbour offers its front (same or newer gen)
// arriving after travel seconds, while the front's fuel (seconds of burning left) lasts.
fn relax(best: vec2f, own: f32, n: vec2f, dtA: f32, travel: f32) -> vec2f {
  let gn = floor(n.x);
  if (gn < floor(own) - 0.5) { return best; }
  let fuel = fract(n.x) * 4.0 - travel;
  if (fuel <= 0.0) { return best; }
  let a = n.y + dtA - travel;
  let gb = floor(best.x);
  if ((gn > gb + 0.5 && a > -HORIZON) || (abs(gn - gb) < 0.5 && a > best.y)) { return vec2f(gn + fuel * 0.25, a); }
  return best;
}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let ij = vec2i(id.xy);
  if (ij.x >= SIM || ij.y >= SIM) { return; }
  let h = WIN / f32(SIM);
  let first = SUB.x > 0.5;
  let dt = U[0].x;
  let dtA = select(0.0, dt, first);
  let base = (vec2f(ij) + 0.5) * h;
  let C = CB.xy;
  let Cp = select(C, CB.zw, first);
  let q = C + (fract((base - C) / WIN + 0.5) - 0.5) * WIN;
  let qp = Cp + (fract((base - Cp) / WIN + 0.5) - 0.5) * WIN;
  var k = textureLoad(kIn, ij, 0);
  var t = textureLoad(tIn, ij, 0);
  if (U[0].y > 0.5 || (first && distance(q, qp) > 1.0)) {
    // A fresh cue, or liquid newly in the window: untouched by any front (gen 0, so any front
    // can burn into it, and fresh liquid never shows an edge of its own).
    k = vec4f(0.0, 30.0, 0.0, 30.0);
    t = vec4f(0.0, 99.0, 0.0, 0.0);
  }
  k.y = min(k.y + dtA, 60.0);
  k.w = min(k.w + dtA, 60.0);
  t.y = min(t.y + dtA, 99.0);

  // The structure: the band lines and their direction here.
  let P = gl_phiFast(q);
  let g = vec2f(gl_phiFast(q + vec2f(h, 0.0)) - P, gl_phiFast(q + vec2f(0.0, h)) - P) / h;
  let tang = normalize(vec2f(-g.y, g.x) + vec2f(1e-5, 0.0));
  let dl = abs(fract(P) - 0.5);
  let onLine = exp(-dl * dl / 0.03);
  // Irregular fibre: conduction varies smoothly along the medium, and randomly per cell (which
  // rounds and roughens the fronts in open liquid).
  let rnd = 0.7 + 0.6 * hash12(vec2f(ij) * 0.7317 + 13.1);
  let grain = 0.6 + 0.8 * (0.5 + 0.5 * noise4fast(vec3f(q * 0.9, 5.0)).x);

  // Arrival-time relaxation. A cell learns a newer front's arrival up to HORIZON seconds before it
  // gets there (a negative age), so the edge of every front interpolates smoothly between cells.
  var bk = k.xy;
  var bs = k.zw;
  var bt = t;
  for (var j = 0; j < 16; j++) {
    let o = NB[j];
    let nij = wrapI(ij + o);
    let n = textureLoad(kIn, nij, 0);
    let e = vec2f(o) * h;
    let dist = length(e);
    let along = abs(dot(e / dist, tang));
    // Kick: along the bands, slower across, faster on the lines.
    let ck = U[21].x * (0.2 + 0.8 * along * along) * (0.35 + 0.65 * onLine) * grain * rnd;
    bk = relax(bk, k.x, n.xy, dtA, dist / ck);
    // Snare: almost only along the lines.
    let cs = U[21].y * (0.1 + 0.9 * pow(along, 4.0)) * (0.2 + 0.8 * onLine) * grain;
    bs = relax(bs, k.z, n.zw, dtA, dist / cs);
    // Melody thread: only along its own line, while its ink lasts.
    let nt = textureLoad(tIn, nij, 0);
    if (nt.x > t.x - 0.5 && nt.x > 0.5 && abs(P - nt.z) < THREAD_BAND) {
      let fuel = fuelOf(nt.w) - dist;
      let a = nt.y + dtA - dist / (U[21].z * grain * rnd);
      if (fuel > 0.0 && ((nt.x > bt.x + 0.5 && a > -HORIZON) || (abs(nt.x - bt.x) < 0.5 && a > bt.y))) {
        bt = vec4f(nt.x, a, nt.z, floor(fuel * 100.0) + fract(nt.w));
      }
    }
  }

  // Ignitions (one frame each): a stretch of the band lines round the point, along the bands.
  let side = vec2f(-tang.y, tang.x);
  if (U[2].z > floor(bk.x) + 0.5 || (abs(U[2].z - floor(bk.x)) < 0.5 && bk.y < 0.0)) {
    let dv = q - gl_warp(U[2].xy);
    let d = length(vec2f(dot(dv, tang) / U[2].w, dot(dv, side) / 1.2));
    if (d < 1.0 && onLine > 0.3) { bk = vec2f(U[2].z + U[23].x * 0.25, -IGNITE); }
  }
  if (U[3].z > floor(bs.x) + 0.5 || (abs(U[3].z - floor(bs.x)) < 0.5 && bs.y < 0.0)) {
    let dv = q - gl_warp(U[3].xy);
    let d = length(vec2f(dot(dv, tang) / U[3].w, dot(dv, side) / 1.5));
    if (d < 1.0 && onLine > 0.4) { bs = vec2f(U[3].z + U[23].y * 0.25, -IGNITE); }
  }
  if (U[4].z > bt.x + 0.5) {
    let o = gl_warp(U[4].xy);
    let tgt = floor(gl_phiFast(o)) + 0.5;
    if (distance(q, o) < 3.0 && abs(P - tgt) < THREAD_BAND) {
      bt = vec4f(U[4].z, -IGNITE, tgt, floor(U[5].x * 100.0) + fract(U[4].w) * 0.99);
    }
  }
  textureStore(kOut, ij, vec4f(bk, bs));
  textureStore(tOut, ij, bt);
}
`;

const RENDER = /* wgsl */ `
@group(1) @binding(1) var kTex: texture_2d<f32>;
@group(1) @binding(2) var tTex: texture_2d<f32>;
@group(1) @binding(3) var<storage, read> CB: vec4f;

fn gl_chroma(c: vec3f) -> f32 {
  let hi = max(c.r, max(c.g, c.b));
  return (hi - min(c.r, min(c.g, c.b))) / max(hi, 1e-4);
}
fn gl_hueA(c: vec3f) -> f32 { return atan2(1.7320508 * (c.g - c.b), 2.0 * c.r - c.g - c.b); }
fn gl_angD(a: f32, b: f32) -> f32 { let d = abs(a - b); return min(d, TAU - d); }
fn gl_rot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}
// Saturated ink cycling through the palette's coloured entries (a grey entry is replaced by the most
// colourful one turned round the hue circle), normalised to a fixed luminance.
fn gl_ink(hIn: f32) -> vec3f {
  let c0 = F.pal0.rgb;
  let c1 = F.pal1.rgb;
  let c2 = F.pal2.rgb;
  let s0 = gl_chroma(c0);
  let s1 = gl_chroma(c1);
  let s2 = gl_chroma(c2);
  var best = c1;
  var sb = s1;
  if (s2 > sb) { best = c2; sb = s2; }
  if (s0 > sb) { best = c0; }
  let k0 = mix(gl_rot(best, 2.3), c0, smoothstep(0.1, 0.3, s0));
  var k1 = mix(gl_rot(best, -1.9), c1, smoothstep(0.1, 0.3, s1));
  var k2 = mix(gl_rot(best, 1.2), c2, smoothstep(0.1, 0.3, s2));
  // An analogous scheme (all one family of hues) gets a contrasting third ink.
  let h0 = gl_hueA(k0);
  // The second ink is always its own hue family: one closer than about 120 degrees to the first is
  // replaced by the first turned 137 degrees.
  k1 = mix(gl_rot(k0, -2.4), k1, smoothstep(1.95, 2.15, gl_angD(h0, gl_hueA(k1))));
  let h1 = gl_hueA(k1);
  let h2 = gl_hueA(k2);
  let spreadP = max(gl_angD(h0, h1), max(gl_angD(h1, h2), gl_angD(h0, h2)));
  k2 = mix(gl_rot(k0, 2.6), k2, smoothstep(2.6, 3.0, spreadP));
  let x = fract(hIn) * 3.0;
  // Each ink holds over most of its third and turns into the next over a short span, so the bands
  // show distinct hue families rather than a smear of in-between mixes.
  let f = smoothstep(0.35, 0.65, fract(x));
  let c = select(select(mix(k2, k0, f), mix(k1, k2, f), x < 2.0), mix(k0, k1, f), x < 1.0);
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let n = (c - lo) / max(hi - lo, 1e-4);
  let v = mix(vec3f(1.0), n, 0.97);
  // Brightness floored by the peak channel, so a deep blue ink is not pushed to a glare (and a blue
  // liquid to a lit blue sheet) to match the luminance of a green one.
  return v / max(max(luma(v), 0.3 * max(v.r, max(v.g, v.b))), 0.05) * 0.3;
}
// The spectrum at x averaged over the last half second (shapes colour and gloss without flicker).
fn gl_spec(x: f32) -> f32 { return (hist(x, 0.0) + hist(x, 0.04) + hist(x, 0.08) + hist(x, 0.12)) * 0.25; }
fn gl_rainbow(x: f32) -> vec3f { return 0.5 + 0.5 * cos(TAU * (x + vec3f(0.0, 0.33, 0.67))); }
fn gl_fire(hh: f32) -> vec3f {
  let h = sat(hh);
  return vec3f(1.0, 0.08 + 0.72 * pow(h, 1.2), 0.02 + 0.4 * pow(h, 3.0)) * h * 2.4;
}

// Long swells under the liquid: height and its gradient (analytic, so reflections stay clean).
fn gl_swell(x: vec2f) -> vec3f {
  var hgt = 0.0;
  var gr = vec2f(0.0);
  for (var i = 0; i < 4; i++) {
    let fi = f32(i);
    let ang = U[16].w + fi * 2.39996;
    let d = vec2f(cos(ang), sin(ang));
    let k = U[16].y * (1.0 + fi * 0.61);
    let a = U[16].x / (1.0 + fi * 0.85);
    let arg = dot(d, x) * k + U[17].x * (1.0 + fi * 0.3) + fi * 1.7 + U[17].z * (0.6 + 0.45 * fi);
    // Sharpness peaks the crests and flattens the troughs (smoothly: no creases).
    let sv = sin(arg);
    let cv = cos(arg);
    let sh = U[16].z * 0.4;
    hgt += a * (sv - sh * cv * cv);
    gr += a * k * d * (cv + 2.0 * sh * sv * cv);
  }
  return vec3f(hgt, gr);
}

// A line pattern (lines at half-integers) filtered by the pixel footprint fw (in the same units).
fn gl_line(x: f32, w: f32, fw: f32) -> f32 {
  let d = abs(fract(x) - 0.5);
  let we = sqrt(w * w + 0.18 * fw * fw);
  let v = exp(-d * d / (we * we)) * (w / we);
  return mix(v, w * 1.7725, smoothstep(0.3, 0.75, fw));
}
// Signed slope of the same profile (for the bump), faded out where the lines are sub-pixel.
fn gl_lineSlope(x: f32, w: f32, fw: f32) -> f32 {
  let d = fract(x) - 0.5;
  let we = sqrt(w * w + 0.18 * fw * fw);
  return -2.0 * d / (we * we) * exp(-d * d / (we * we)) * (w / we) * (1.0 - smoothstep(0.15, 0.5, fw));
}

// A studio of long coloured light strips, each following a slice of the spectrum.
fn gl_env(r: vec3f, rough: f32) -> vec3f {
  let el = asin(clamp(r.y, -1.0, 1.0));
  let az = atan2(r.x, r.z) + U[20].x;
  var c = vec3f(0.0);
  for (var i = 0; i < 5; i++) {
    let fi = f32(i);
    let e0 = 0.05 + fi * 0.16 + 0.04 * sin(fi * 2.1 + U[20].x * 0.7);
    let w = 0.018 + 0.012 * fi;
    let s = sqrt(w * w + rough * rough);
    let band = exp(-pow((el - e0) / s, 2.0)) * (w / s);
    let azm = pow(0.5 + 0.5 * sin(az * (1.0 + fi * 0.5) + fi * 1.9), 4.0);
    let lvl = 0.6 + 1.4 * gl_spec(0.06 + fi * 0.18);
    c += gl_ink(U[18].x + 0.17 + fi * 0.29) * band * azm * lvl * (2.6 - fi * 0.3);
  }
  // A broad soft key overhead and a faint deep dome.
  c += gl_ink(U[18].x + 0.6) * 0.3 * smoothstep(0.6, 1.4, el);
  c += gl_ink(U[18].x + 0.85) * 0.12 * sat(r.y * 2.0);
  return c * U[19].z;
}

// Arrival-time state of a front channel round q: (new state weight, age since the front passed,
// gen in the new state). Unreached corners extrapolate a negative age so the front edge is smooth.
struct Front { w: f32, wc: f32, age: f32, gen: f32 };
struct Fronts { k: Front, s: Front };
fn gl_bs(t: f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4f(1.0 - 3.0 * t + 3.0 * t2 - t3, 4.0 - 6.0 * t2 + 3.0 * t3, 1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3, t3) / 6.0;
}
fn gl_mkFront(age: f32, fuel: f32, gm: f32) -> Front {
  var o: Front;
  // A short soft head: heat rises over the last few hundredths of a second before arrival.
  o.w = pow(smoothstep(-0.16, 0.0, age), 2.0) * smoothstep(-0.03, 0.01, fuel);
  // The lasting change settles in behind the hot edge (and fades in at a burnt-out edge).
  o.wc = smoothstep(0.0, 0.3, age) * smoothstep(-0.02, 0.12, fuel);
  o.age = max(age, 0.0);
  o.gen = gm;
  return o;
}
// Both beat channels round q, reconstructed with a cubic B-spline over 4x4 cells (smooth, organic
// edges at any distance). Corners not yet in the newest state count as not reached.
fn gl_fronts(qIn: vec2f) -> Fronts {
  // Beyond the simulated window (only far off in the dark), the state at its edge.
  let q = CB.xy + clamp(qIn - CB.xy, vec2f(-WIN * 0.5 + 2.5), vec2f(WIN * 0.5 - 2.5));
  let u = q / WIN * f32(SIM) - 0.5;
  let i0 = floor(u);
  let wx = gl_bs(u.x - i0.x);
  let wy = gl_bs(u.y - i0.y);
  let b = vec2i(i0) - vec2i(1) + vec2i(SIM * 64);
  var v: array<vec4f, 16>;
  var gk = -1.0;
  var gs = -1.0;
  for (var j = 0; j < 16; j++) {
    v[j] = textureLoad(kTex, (b + vec2i(j & 3, j >> 2)) % vec2i(SIM), 0);
    gk = max(gk, floor(v[j].x));
    gs = max(gs, floor(v[j].z));
  }
  var ak = 0.0;
  var fk = 0.0;
  var as_ = 0.0;
  var fs_ = 0.0;
  for (var j = 0; j < 16; j++) {
    let w = wx[j & 3] * wy[j >> 2];
    let inK = floor(v[j].x) > gk - 0.5;
    let inS = floor(v[j].z) > gs - 0.5;
    ak += w * select(-1.0, v[j].y, inK);
    fk += w * select(-0.06, fract(v[j].x) * 4.0 + 0.02, inK);
    as_ += w * select(-1.0, v[j].w, inS);
    fs_ += w * select(-0.06, fract(v[j].z) * 4.0 + 0.02, inS);
  }
  var o: Fronts;
  o.k = gl_mkFront(ak, fk, gk);
  o.s = gl_mkFront(as_, fs_, gs);
  return o;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let res = F.res;
  let fl = U[12].w;
  let sc = (frag - 0.5 * res) / res.y * 2.0 * vec2f(1.0, -1.0);
  let ro = U[12].xyz;
  let rd = normalize(U[13].xyz * sc.x + U[14].xyz * sc.y + U[15].xyz * fl);
  let pa = 2.0 / (res.y * fl);
  let fogC = gl_ink(U[18].x + 0.7) * 0.025;
  let tMax = 70.0;

  // March the swells (a smooth heightfield: step by the gap over the closing speed).
  let amp = U[16].x * 2.2;
  var t = max((ro.y - amp) / max(-rd.y, 1e-3), 0.0);
  var hit = false;
  if (rd.y < -0.004) {
    let slope = U[16].x * U[16].y * 3.0 * (1.0 + U[16].z);
    for (var i = 0; i < 110; i++) {
      let p = ro + rd * t;
      let d = p.y - gl_swell(p.xz).x;
      if (d < pa * t * 0.4) { hit = true; break; }
      t += d / (-rd.y + slope * length(rd.xz)) * 0.9;
      if (t > tMax) { break; }
    }
  }
  // Background: the far dark, with a faint glow of the strips above the liquid's edge.
  if (!hit) {
    return vec4f(fogC + gl_env(rd, 0.05) * 0.03, 1.0);
  }

  let p = ro + rd * t;
  let sw = gl_swell(p.xz);
  let nS = normalize(vec3f(-sw.y, 1.0, -sw.z));
  let x = p.xz;
  let fp = t * pa;
  let e = max(fp * 0.6, 0.003);
  let q = gl_warp(x);
  let qx = gl_warp(x + vec2f(e, 0.0));
  let qz = gl_warp(x + vec2f(0.0, e));
  let P = gl_phi(q);
  let gP = vec2f(gl_phi(qx) - P, gl_phi(qz) - P) / e;
  let cosI = max(dot(nS, -rd), 0.06);
  let vf = normalize(rd.xz + vec2f(1e-5, 0.0));
  let gAl = dot(gP, vf);
  let gSd = gP.x * vf.y - gP.y * vf.x;
  let fw = fp * sqrt(gSd * gSd + (gAl / cosI) * (gAl / cosI));

  // Bundles: groups of lines, some lit, some black; each bundle a soft raised ribbon.
  let nb = U[8].w;
  let B = P / nb;
  let bi = floor(B);
  let fb = fract(B);
  let kindH = hash11(bi * 1.37 + U[11].z * 17.0);
  let lit = step(kindH, U[11].w);
  // A share of the lit bundles are solid ribbons of dye with bright rims.
  // Bundle width in world units: where the bands spread out near a crest of the field, the body
  // effects fade and only the (width-capped) lines remain.
  let bw = U[8].w / max(length(gP), 1e-3);
  let small = smoothstep(5.0, 3.0, bw);
  let solid = step(kindH, U[11].w * 0.33) * smoothstep(4.0, 2.2, bw);
  let benv = pow(sin(PI * fb), 1.3);
  let fwB = fw / nb;

  // Beat state, read where the structure carries it: each line on its own centre line (so a change
  // runs along the fibre), each ribbon on its middle (so dye fills the ribbon along its length).
  let eq = 0.05;
  let gq = vec2f(gl_phi(q + vec2f(eq, 0.0)) - P, gl_phi(q + vec2f(0.0, eq)) - P) / eq;
  let gqn = gq / max(dot(gq, gq), 1e-4);
  var sL = (fract(P) - 0.5) * gqn;
  sL *= min(1.0, 3.0 / max(length(sL), 1e-4));
  var sB = (fb - 0.5) * nb * gqn;
  sB *= min(1.0, 6.0 / max(length(sB), 1e-4));
  let frL = gl_fronts(q - sL);
  let frB = gl_fronts(q - sB);
  let kGenL = frL.k.gen - (1.0 - frL.k.wc);
  let kGenB = frB.k.gen - (1.0 - frB.k.wc);
  let sGenL = frL.s.gen - (1.0 - frL.s.wc);

  // Regions of colour cut across the bands; each kick front steps them one colour on.
  let R = P / U[6].w * U[8].z + 0.85 * sin(q.x * 0.061 + q.y * 0.047 + U[11].z) + 0.5 * sin(q.y * 0.083 - q.x * 0.029);
  let gR = gP / U[6].w * U[8].z;
  let ri = floor(R);
  let rf = fract(R);
  let spread = U[18].y;
  let hue0 = U[18].x;
  // Neighbouring bundles take different inks (one of three steps), regions shift them along.
  let bOff = floor(hash11(bi * 3.17 + 1.3) * 3.0) * 0.3333;
  let fwR = fp * length(gR) / cosI;
  let rmix = smoothstep(1.0 - 0.12 - fwR, 1.0, rf);
  // A share of the lines in each bundle carry the next ink along, so a bundle is never one flat hue.
  let lOff = floor(hash11(floor(P) * 2.71 + 0.9) * 2.7) * 0.3333;
  let cL = mix(gl_ink(hue0 + bOff + lOff + (ri + kGenL) * spread), gl_ink(hue0 + bOff + lOff + (ri + 1.0 + kGenL) * spread), rmix);
  let cR = mix(gl_ink(hue0 + bOff + (ri + kGenB) * spread), gl_ink(hue0 + bOff + (ri + 1.0 + kGenB) * spread), rmix);
  // Thin rainbow where the colour regions meet.
  let rbw = exp(-pow((1.0 - rf - 0.06) / (0.04 + fwR), 2.0)) * (0.04 / (0.04 + fwR));
  let rbc = gl_rainbow(rf * 0.5 + select(0.0, 0.5, rf > 0.5) + dot(nS, rd) * 0.5);
  // Each bundle glows with its own slice of the spectrum.
  let sl = gl_spec(fract(bi * 0.618 + 0.13));
  let glow = 0.6 + 1.1 * sl;

  // Lines; the snare front leaves their flanks in a new tint.
  let lid = floor(P);
  // Line width in line units, capped in world units (lines stay fine where the bands spread out).
  let gLen = length(gP);
  let lw = min(U[22].x * (0.55 + 0.9 * hash11(lid * 0.773 + 3.1)), 0.04 * gLen);
  let lb = 0.45 + 0.75 * hash11(lid * 1.913 + 7.7);
  // Lines packed far below a pixel fall away into the dark instead of averaging to a grey slab.
  let dense = 1.0 - 0.85 * smoothstep(0.6, 2.5, fw);
  let lines = gl_line(P, lw, fw) * dense;
  let sub = gl_ink(hue0 + 0.5 + sGenL * 0.17);
  let core = gl_line(P, lw * 0.45, fw);
  let lineCol = mix(sub, cL, sat(0.2 + core * 1.6));
  let litC = mix(cL, rbc * 0.6, sat(rbw * 1.4));
  let litL = mix(0.1, 1.0, lit) * mix(1.0, 0.4, solid);
  var emit = (lineCol * (1.0 - sat(rbw)) + litC * sat(rbw)) * lines * lb * benv * litL * glow * 1.1;
  // Hot core of the brightest lines, in their own ink (never white, so the colour stays vivid).
  emit += cL / 0.3 * pow(core, 3.0) * benv * lit * glow * 0.02;
  // Soft body light inside lit bundles (the dye under the coat).
  emit += cR * benv * lit * 0.04 * glow * small * (1.0 - 0.85 * smoothstep(0.25, 1.0, fwB));
  // Solid ribbons: deep dye in the middle, lighter toward bright rims, a rainbow seam where the
  // colour regions meet.
  let plateau = smoothstep(0.0, 0.12 + fwB, fb) * smoothstep(1.0, 0.88 - fwB, fb);
  let edgeL = pow(1.0 - sin(PI * fb), 2.0);
  let rwid = sqrt(0.035 * 0.035 + 0.18 * fwB * fwB);
  let rim = (exp(-pow((fb - 0.05) / rwid, 2.0)) + exp(-pow((0.95 - fb) / rwid, 2.0))) * (0.035 / rwid);
  let ribC = mix(cR, rbc * 0.45, sat(rbw * 1.6));
  let denseB = 1.0 - 0.85 * smoothstep(0.25, 1.0, fwB);
  emit += solid * glow * denseB * (ribC * plateau * (0.2 + 0.9 * edgeL) + ribC * rim * 1.3);

  // Normals: the coat follows the swells and the bundle ribbons; the base follows each line too.
  let ridgeSlope = lit * PI * cos(PI * fb) * 0.6 * pow(max(sin(PI * fb), 1e-3), -0.4) * (1.0 - smoothstep(0.2, 0.6, fwB));
  let gRidge = gP / nb * ridgeSlope * U[22].z;
  let gLine = gP * gl_lineSlope(P, lw, fw) * U[22].y * lit;
  let nCoat = normalize(nS - vec3f(gRidge.x, 0.0, gRidge.y));
  let nBase = normalize(nCoat - vec3f(gLine.x, 0.0, gLine.y));

  // Clear coat: sharp mirror of the strips; base gloss: rougher, tinted by the dye.
  let rough = U[19].y;
  let rC = reflect(rd, nCoat);
  let rB = reflect(rd, nBase);
  let fres = 0.04 + 0.96 * pow(1.0 - max(dot(nCoat, -rd), 0.0), 5.0);
  let coat = gl_env(rC, rough) * fres * U[19].x;
  // Clear-coat key: a low light ahead of the view, so glints run along the ribbon flanks.
  let Lk = normalize(U[15].xyz * vec3f(1.0, 0.0, 1.0) + vec3f(0.0, 0.32, 0.0) + U[13].xyz * 0.35);
  let Hk = normalize(Lk - rd);
  let ndhC = max(dot(nCoat, Hk), 0.0);
  let ndhB = max(dot(nBase, Hk), 0.0);
  let keyC = gl_ink(hue0 + 0.4) / 0.3;
  let sharp = 500.0 * (1.0 - rough * 6.0);
  // Sharp glints ride the line tubes; the open liquid gets only a soft sheen.
  let keySpec = keyC * (pow(ndhB, sharp) * 1.4 * sat(lines * 2.0) * (0.3 + 0.7 * lit) + pow(ndhC, 40.0) * 0.05) * U[19].x;
  let baseGloss = gl_env(rB, rough * 4.0 + 0.04) * (cL * 2.0 + 0.05) * lines * lit * benv * 0.5;
  // Rainbow glints on the coat where the colours meet.
  let glint = rbc * rbw * lit * luma(gl_env(rC, rough * 2.0)) * 1.5 * (0.3 + fres);

  // Kick front: a white-hot edge on the bands cooling through yellow and orange.
  // Each front glows with its own kick's strength (the last three gens; older ones have cooled).
  let kG = U[17].y;
  let kLv = select(select(U[5].w, U[5].z, frL.k.gen > kG - 1.5), U[5].y, frL.k.gen > kG - 0.5);
  // The newest front eases in at its ignition (no pop where it starts).
  let kIn = select(1.0, smoothstep(0.0, 0.22, U[20].y), frL.k.gen > kG - 0.5);
  let khL = frL.k.w * (exp(-frL.k.age / 0.3) + 0.16 * exp(-frL.k.age / 1.4)) * kLv * kIn;
  // The fibres burn; the dye of a burning band glows with them.
  // Burning fibres flare wider than the fibre.
  let flare = sat(gl_line(P, min(lw * 2.6, 0.11 * gLen), fw) * 1.8);
  emit += gl_fire(khL) * flare * (0.8 + 0.2 * lit) * 2.0;
  // Snare front: an electric edge in the highlight colour, racing along the lines.
  let sG = U[22].w;
  let sLv = select(select(U[21].w, U[18].w, frL.s.gen > sG - 1.5), U[18].z, frL.s.gen > sG - 0.5);
  let sIn = select(1.0, smoothstep(0.0, 0.2, U[20].z), frL.s.gen > sG - 0.5);
  let sh = frL.s.w * (exp(-frL.s.age / 0.15) + 0.15 * exp(-frL.s.age / 0.6)) * sLv * sIn;
  let scol = sub / 0.3;
  emit += scol * sh * (sat(lines * 2.5) + 0.16 * benv * lit * small * denseB) * 4.5;

  // Melody threads: ink of the note's colour along one line, brightest at the head, fading slowly.
  // Read on the line centre, so a thread's reach is the same across its width.
  let tu = (q - sL) / WIN * f32(SIM) - 0.5;
  let tb = vec2i(floor(tu));
  let tf = tu - floor(tu);
  var t4: array<vec4f, 4>;
  var nid = 0.0;
  var th = vec4f(0.0);
  for (var j = 0; j < 4; j++) {
    t4[j] = textureLoad(tTex, (tb + vec2i(j & 1, j >> 1) + vec2i(SIM * 64)) % vec2i(SIM), 0);
    if (t4[j].x > nid) { nid = t4[j].x; th = t4[j]; }
  }
  var ta = vec4f(0.0);
  for (var j = 0; j < 4; j++) { ta[j] = select(-1.0, t4[j].y, abs(t4[j].x - nid) < 0.5); }
  let tAge = mix(mix(ta.x, ta.y, tf.x), mix(ta.z, ta.w, tf.x), tf.y);
  let dqT = abs(q - CB.xy);
  if (nid > 0.5 && tAge > -0.2 && tAge < 20.0 && max(dqT.x, dqT.y) < WIN * 0.5 - 1.5) {
    th.y = max(tAge, 0.0);
    let reach = smoothstep(-0.16, 0.0, tAge);
    // Three lines of ink: the note's own line, and fainter ones either side.
    let d = P - th.z;
    let jn = clamp(round(d), -1.0, 1.0);
    let dd = d - jn;
    let tw = min(0.12, 0.045 * gLen);
    let twe = sqrt(tw * tw + 0.18 * fw * fw);
    let m = exp(-dd * dd / (twe * twe)) * (tw / twe) * select(1.0, 0.45, abs(jn) > 0.5);
    // A soft halo of the same ink bleeding through the channel round the threads.
    let hw = min(1.1, 0.3 * gLen);
    let hwe = sqrt(hw * hw + 0.18 * fw * fw);
    let halo = exp(-d * d / (hwe * hwe)) * (hw / hwe) * smoothstep(1.45, 0.9, abs(d));
    // The thread thins out where its ink ran out.
    let taper = smoothstep(0.0, 2.5, floor(th.w) / 100.0);
    // fract(w) packs the note's hue (64 steps) and its strength: a faint note lays faint ink.
    let hl = fract(th.w) / 0.99 * 64.0;
    let ink = gl_ink(floor(hl) / 64.0) / 0.3 * (fract(hl) / 0.98);
    let head = exp(-th.y / 0.4);
    let fade = exp(-th.y / 3.5) * (1.0 - smoothstep(10.0, 14.0, th.y));
    emit += (ink * (1.0 + 0.8 * head) * m * (fade + head * 3.0) * 1.15 + ink * halo * (0.04 * fade + 0.6 * head)) * reach * taper;
  }

  var c = emit + coat * 1.8 + baseGloss + glint + keySpec;
  c *= U[19].w;
  // Neon ink, not pastel: push the colour away from grey before the highlights roll off.
  c = max(mix(vec3f(luma(c)), c, 1.35), vec3f(0.0));
  // Highlights roll off instead of clipping.
  let lc = luma(c);
  c *= (1.0 + 0.35 * max(lc - 0.9, 0.0)) / (1.0 + 0.9 * max(lc - 0.9, 0.0));
  // Depth: fade into the dark with distance.
  let fogA = exp(-t * 0.075) * (1.0 - smoothstep(22.0, 34.0, t));
  c = mix(fogC, c, fogA);
  return vec4f(c, 1.0);
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let c = scene(in.uv, in.pos.xy);
  return vec4f(max(c.rgb, vec3f(0.0)), 1.0);
}
`;

type Pipes = { centre: GPUComputePipeline; step: GPUComputePipeline; render: GPURenderPipeline };
type Groups = { centre: GPUBindGroup; first: GPUBindGroup; ab: GPUBindGroup; ba: GPUBindGroup; render: GPUBindGroup };

/** One step of a critically damped spring toward `target`: starts from rest, settles in about 5/w s, never overshoots. */
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}

/** A swell that rises from rest, peaks at age tau and settles back: 0 at age 0, 1 at its peak. */
const swell = (age: number, tau: number) => {
  const x = Math.max(0, age) / tau;
  return x * x * Math.exp(2 * (1 - x));
};

const hash = (x: number) => {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * The phrase framing (morph.cam: fov, pitch, yaw, roll, height) re-timed to the music: it moves
 * toward its target in eased steps on kicks, snares and melody notes (each by its strength), with
 * a slow drift so it still arrives in quiet passages. The eye also follows the melody: each note
 * tilts the look a little by its pitch and turns it a notch, a lasting change that glides in.
 * Every step settles on a critically damped spring (~0.4 s at w = 7), so nothing snaps.
 */
class Framing {
  readonly cam = { fov: 1, pitch: 0, yaw: 0, roll: 0, height: 0 };
  private readonly goal = [0, 0, 0, 0, 0];
  private readonly val = [0, 0, 0, 0, 0];
  private readonly vel = [0, 0, 0, 0, 0];
  private gazeP = 0;
  private gazeY = 0;
  private k = 0;
  private s = 0;
  private n = 0;

  /**
   * `gaze`: the melody's look offset (radians at full strength); `w`: the step spring's rate (1/s);
   * `drift`: time constant (s) of the unprompted glide toward the target.
   */
  constructor(
    private readonly gaze = 0.05,
    private readonly w = 7,
    private readonly drift = 6,
  ) {}

  update(mo: Morph, dt: number, reset: boolean): void {
    const c = mo.cam;
    let take = 1 - Math.exp(-dt / this.drift);
    if (reset) {
      take = 1;
      this.gazeP = this.gazeY = 0;
    } else {
      // Steps scale with the music's weight: a quiet intro barely moves the lens.
      const wt = 0.25 + 0.75 * mo.drive;
      if (mo.kicks > this.k) take = 1 - (1 - take) * (1 - 0.22 * wt * mo.kickLevel);
      if (mo.snares > this.s) take = 1 - (1 - take) * (1 - 0.1 * wt * mo.snareLevel);
      if (mo.notes > this.n) {
        take = 1 - (1 - take) * (1 - 0.2 * wt * mo.noteLevel);
        // The look turns by the note's strength: a faint note in a quiet passage barely moves it.
        const lv = mo.noteLevel * wt;
        this.gazeP = (mo.notePitch - 0.5) * 2 * this.gaze * lv;
        this.gazeY += ((mo.notes % 2 ? 1 : -1) * this.gaze * 0.8 * lv - this.gazeY) * 0.7;
      }
    }
    this.k = mo.kicks;
    this.s = mo.snares;
    this.n = mo.notes;
    const tgt = [Math.log(c.fov), c.pitch, c.yaw, c.roll, c.height];
    const w = this.w;
    const e = Math.exp(-w * dt);
    for (let j = 0; j < 5; j++) {
      this.goal[j] += (tgt[j] - this.goal[j]) * take;
      const gj = this.goal[j] + (j === 1 ? this.gazeP : j === 2 ? this.gazeY : 0);
      if (reset) {
        this.val[j] = gj;
        this.vel[j] = 0;
        continue;
      }
      const d = this.val[j] - gj;
      const cc = this.vel[j] + w * d;
      this.vel[j] = (this.vel[j] - w * cc * dt) * e;
      this.val[j] = gj + (d + cc * dt) * e;
    }
    this.cam.fov = Math.exp(this.val[0]);
    this.cam.pitch = this.val[1];
    this.cam.yaw = this.val[2];
    this.cam.roll = this.val[3];
    this.cam.height = this.val[4];
  }
}

class GlossyInstance implements SceneInstance {
  readonly meta = META;
  private readonly u = new Float32Array(NU * 4);
  private readonly morph = new Morph(1);
  private readonly framing = new Framing(0.075);
  private lastT = -1;
  private seed = -1;
  private reset = true;
  private tau = 0;
  private hue = 0;
  private high = 0;
  private centroid = 0.5;
  private kicks = 0;
  private snares = 0;
  private notes = 0;
  private subs = 2;
  /** Melody swirl: each note turns the eddies a notch (target, eased value, its velocity). */
  private swirl = 0;
  private swirlE = 0;
  private swirlV = 0;
  /** Strength of the last three kick and snare fronts (newest first), captured as each lands. */
  private kLv = [0, 0, 0];
  private sLv = [0, 0, 0];
  /** Heaves and stirs: one eased bump per hit, each with its own strength (start time, level). */
  private heaves: [number, number][] = [];
  private stirs: [number, number][] = [];
  /** Snare turn: each snare turns the eddy layout a notch for good (target, eased value, velocity). */
  private sTurn = 0;
  private sTurnE = 0;
  private sTurnV = 0;
  /** Fine wobble: eased depth. */
  private fineA = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly group0: GPUBindGroup,
    private readonly uBuffer: GPUBuffer,
    private readonly pipes: Pipes,
    private readonly groups: Groups,
    private readonly owned: (GPUTexture | GPUBuffer)[],
  ) {}

  update(ctx: SceneUpdateContext): void {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const seek = this.lastT < 0 || Math.abs(m.time - this.lastT - dt) > 0.5 || g[0] !== this.seed;
    this.lastT = m.time;
    this.seed = g[0];
    const mo = this.morph;
    mo.update(m, ctx.dt, g);
    const a = mo.at;
    const root = m.chord && m.chord.root >= 0 ? m.chord.root : 0;
    const hueTarget = g[3] + (((root * 7) % 12) / 12) * 0.35 + (m.chord?.quality.startsWith('m') ? 0.05 : 0);
    if (seek) {
      this.reset = true;
      this.tau = g[1] * 40 + m.time * 0.3;
      this.hue = hueTarget;
      this.kicks = mo.kicks;
      this.snares = mo.snares;
      this.notes = mo.notes;
      this.swirl = this.swirlE = this.swirlV = 0;
      this.kLv = [0, 0, 0];
      this.sLv = [0, 0, 0];
      this.heaves = [];
      this.sTurn = this.sTurnE = this.sTurnV = 0;
      this.stirs = [];
      this.fineA = 0.05 + 0.3 * mo.detailDrive;
    }
    this.hue += (hueTarget - this.hue) * (1 - Math.exp(-dt / 3));
    // Spectral shape, smoothed so it shapes the look without flickering it.
    this.high += (m.high - this.high) * (1 - Math.exp(-dt / 0.6));
    this.centroid += (m.centroid - this.centroid) * (1 - Math.exp(-dt / 1.0));
    // The flow clock: always running, easing down only in long quiet.
    this.tau += dt * 0.42 * (0.3 + 0.7 * mo.flow) * (0.85 + 0.3 * m.energySlow);
    const tau = this.tau;
    const u = this.u;
    u.fill(0);

    // Camera: a steady glide forward along a gently winding path, low over the liquid, banking into
    // its turns; looking down enough that the far liquid fades into the dark before any horizon.
    const tr = mo.travel * 1.9 + g[2] * 100;
    const pathX = (s: number) => 3.2 * Math.sin(s * 0.061 + g[4] * 6.28) + 1.8 * Math.sin(s * 0.023 + g[5] * 6.28);
    const cx = pathX(tr);
    const dx = (pathX(tr + 0.5) - pathX(tr - 0.5)) / 1.0;
    // The phrase framing (morph.cam) tilts between grazing and steep views, raises and lowers the
    // eye, turns off the path, rolls a little and changes the lens.
    this.framing.update(mo, dt, seek);
    const fr = this.framing.cam;
    const yaw = Math.atan(dx) * 0.8 + 0.18 * Math.sin(tr * 0.017 + g[6] * 6.28) + 0.8 * fr.yaw;
    const swellAmp = wave(a[5], 0.25, 0.75);
    const lift = fr.height > 0 ? 1.9 * fr.height : 0.85 * fr.height;
    const camY = 2.25 + lift + swellAmp * 1.1 + 0.25 * Math.sin(tr * 0.029 + g[7] * 6.28);
    const pitch = Math.min(1.2, Math.max(0.3, 0.6 + 0.08 * g[3] + 0.04 * Math.sin(tr * 0.021) + 1.25 * fr.pitch));
    const roll = -Math.atan(dx) * 0.12 + 0.55 * fr.roll;
    const focal = 2.0 / fr.fov;
    const fwd = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const upW = [Math.sin(roll), Math.cos(roll), 0];
    const cr = (x: number[], y: number[]) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const nrm = (x: number[]) => {
      const l = Math.hypot(x[0], x[1], x[2]) || 1;
      return x.map((v) => v / l);
    };
    const right = nrm(cr(upW, fwd));
    const up = cr(fwd, right);
    const pos = [cx, camY, tr];
    const fwdXZ = [Math.sin(yaw), Math.cos(yaw)];
    const rightXZ = [Math.cos(yaw), -Math.sin(yaw)];
    // Event spots are laid out for the base framing (looking at the liquid ~3 units ahead with a
    // focal of 2); map them around where this framing actually looks, scaled to what it sees.
    const look = camY / Math.tan(pitch);
    const look0 = 2.6 / Math.tan(0.64);
    const span = Math.min(1.6, Math.max(0.45, (look / look0) * (2.0 / focal)));
    const worldAhead = (dist0: number, side0: number): [number, number] => {
      const dist = Math.max(1.5, look + (dist0 - look0) * span);
      const side = side0 * span;
      return [pos[0] + fwdXZ[0] * dist + rightXZ[0] * side, pos[2] + fwdXZ[1] * dist + rightXZ[1] * side];
    };

    // The material window follows the view (the liquid streams through it).
    const stream = [Math.cos(g[6] * 6.28) * 0.35, Math.sin(g[6] * 6.28) * 0.35];
    const focus = worldAhead(14, 0);

    // Events: each ignites its own process somewhere ahead in view, never at the lens.
    let kGen = -1;
    let sGen = -1;
    let nId = -1;
    let kPos: [number, number] = [0, 0];
    let sPos: [number, number] = [0, 0];
    let nPos: [number, number] = [0, 0];
    // Reaction strength: the kick squared (its burn is the brightest thing here), so a faint hit after
    // quiet is a faint touch and a hard one a full burn; snares by their level and notes by its root (melody
    // levels sit lower, and every note should still turn the liquid).
    const kL = mo.kickLevel ** 2;
    const sL = mo.snareLevel;
    const nL = Math.sqrt(mo.noteLevel);
    if (mo.kicks > this.kicks) {
      kGen = mo.kicks;
      this.kLv = [kL, this.kLv[0], this.kLv[1]];
      this.heaves.push([m.time - mo.kickAge, kL]);
      const h1 = hash(mo.kicks * 1.31 + g[0] * 17);
      const h2 = hash(mo.kicks * 2.17 + g[1] * 13);
      kPos = worldAhead(6.5 + 6 * h1, (h2 * 2 - 1) * (2 + 3.5 * h1));
    }
    if (mo.snares > this.snares) {
      sGen = mo.snares;
      this.sLv = [sL, this.sLv[0], this.sLv[1]];
      this.stirs.push([m.time - mo.snareAge, sL]);
      this.sTurn += (mo.snares % 2 ? 1 : -1) * 0.15 * sL;
      const h1 = hash(mo.snares * 3.7 + g[2] * 11);
      const side = mo.snares % 2 ? 1 : -1;
      sPos = worldAhead(5.5 + 5 * h1, side * (1.5 + 3 * hash(mo.snares * 5.3)));
    }
    if (mo.notes > this.notes) {
      nId = mo.notes;
      const pc = Math.max(-1, Math.min(1, mo.notePitch));
      nPos = worldAhead(5.5 + 1.8 * Math.sin(mo.notes * 1.7), pc * 4.5);
      // ...and the liquid swirls a notch with it, up or down with the pitch, gliding in. The swirl
      // turns every eddy, so it goes by the note's level (not its root): a faint motif in a quiet
      // intro stirs it a touch and the thread carries the note; the lead in a drop swirls it fully.
      this.swirl += (pc >= 0 ? 1 : -1) * (0.5 + 0.2 * Math.abs(pc)) * mo.noteLevel ** 1.5;
    }
    [this.swirlE, this.swirlV] = spring(this.swirlE, this.swirlV, this.swirl, 9, dt);
    [this.sTurnE, this.sTurnV] = spring(this.sTurnE, this.sTurnV, this.sTurn, 6, dt);
    this.kicks = mo.kicks;
    this.snares = mo.snares;
    this.notes = mo.notes;

    u[0] = dt;
    u[1] = this.reset ? 1 : 0;
    u[3] = tau;
    u[4] = focus[0];
    u[5] = focus[1];
    u[8] = kPos[0];
    u[9] = kPos[1];
    u[10] = kGen;
    // A faint kick ignites a shorter stretch (and below, burns for less time).
    u[11] = (3.2 + 1.0 * m.energySlow) * (0.35 + 0.65 * Math.sqrt(this.kLv[0]));
    u[12] = sPos[0];
    u[13] = sPos[1];
    u[14] = sGen;
    u[15] = 4.0 * (0.35 + 0.65 * Math.sqrt(this.sLv[0]));
    u[16] = nPos[0];
    u[17] = nPos[1];
    u[18] = nId;
    // The note's hue (64 steps) and its strength, packed for the thread it lays.
    const nh = this.hue + 0.5 + 0.32 * mo.notePitch;
    u[19] = (Math.floor((nh - Math.floor(nh)) * 64) + 0.98 * Math.min(1, nL)) / 64;
    // Ink for a note: a faint note's thread runs short, a strong one long (no threshold).
    u[20] = 2.5 + 7.5 * mo.noteLevel;
    u[21] = this.kLv[0];
    u[22] = this.kLv[1];
    u[23] = this.kLv[2];
    // Eddies: scale, strength and layout from the morph.
    u[24] = wave(a[0], 0.14, 0.22);
    // Snares stir the eddies harder for a moment (a swell from rest that settles back), each by its
    // own strength; every hit keeps its own swell, so a new one never cuts the last one off.
    const bumps = (list: [number, number][], tau: number) => {
      let v = 0;
      for (const [t0, l] of list) v += l * swell(m.time - t0, tau);
      return v;
    };
    const keep = (list: [number, number][], tau: number) => list.filter(([t0]) => m.time - t0 < tau * 12);
    this.heaves = keep(this.heaves, 0.15);
    this.stirs = keep(this.stirs, 0.12);
    u[25] = wave(a[1], 0.38, 0.68) * (1 + 0.13 * bumps(this.stirs, 0.12));
    u[26] = 0.45;
    u[27] = Math.round(10 + 5 * g[4]);
    u[28] = g[5] * 40;
    u[29] = g[6] * 40;
    u[30] = a[2] * 0.08;
    u[31] = g[7] * 6.28 + a[3] * 0.05 + this.sTurnE;
    u[32] = stream[0];
    u[33] = stream[1];
    u[34] = 4.5 + 2 * g[2];
    u[35] = 5;
    for (let i = 0; i < 5; i++) {
      const sw = this.swirlE * (i % 2 ? -1 : 1) * (1 - 0.15 * i);
      u[36 + i * 2] = a[i % 8] * 0.35 + g[i] * 6.28 + sw;
      u[37 + i * 2] = a[(i + 3) % 8] * 0.35 + g[(i + 2) % 8] * 6.28 + 0.7 * sw;
    }
    u[46] = g[0] * 6.28;
    u[47] = 0.62;
    u[48] = pos[0];
    u[49] = pos[1];
    u[50] = pos[2];
    u[51] = focal;
    u.set(right, 52);
    u.set(up, 56);
    u.set(fwd, 60);
    // Swells: amplitude, scale, crest sharpness and heading from the morph.
    // Kicks heave the liquid: the swells rise and settle back.
    u[64] = swellAmp * (1 + 2.0 * bumps(this.heaves, 0.15));
    u[65] = wave(a[6], 0.09, 0.16);
    u[66] = wave(a[7], 0, 1);
    u[67] = g[3] * 6.28 + a[4] * 0.1;
    u[68] = tau * 0.18;
    u[69] = mo.kicks;
    u[70] = a[5] * 0.25;
    // Fine wobble of the band lines: depth from the high end (eased), phases from the detail layer
    // (which each high note steps by its strength) plus the eased upper / backing / hat counts.
    this.fineA += (0.05 + 0.3 * mo.detailDrive - this.fineA) * (1 - Math.exp(-dt / 0.4));
    u[71] = this.fineA;
    u[94] = mo.detailAt[0] * 2.2 + mo.upperPhase * 1.3 + mo.hatPhase * 0.15;
    u[95] = mo.detailAt[1] * 2.2 - mo.backingPhase * 0.9 + mo.detailAt[2] * 0.8;
    // Look: hue base, palette spread from the spectral centroid.
    u[72] = this.hue;
    u[73] = 0.31 + 0.14 * (1 - Math.exp(-2 * this.centroid));
    u[74] = this.sLv[0];
    u[75] = this.sLv[1];
    // Gloss: highs sharpen and brighten the clear coat.
    u[76] = 0.9 + 0.6 * this.high;
    u[77] = 0.03 + 0.05 * Math.exp(-2 * this.high);
    u[78] = 1.0;
    u[79] = 0.78;
    u[80] = g[1] * 6.28 + tr * 0.004;
    u[81] = mo.kickAge;
    u[82] = mo.snareAge;
    u[83] = mo.leadAge;
    u[84] = 2.2 + 1.0 * m.energySlow;
    u[85] = 8;
    u[86] = 7;
    u[87] = this.sLv[2];
    u[88] = 0.085;
    u[89] = 0.012;
    u[90] = 0.22;
    u[91] = mo.snares;
    // Burn time of each front (seconds of fuel).
    // Burn time of each front (seconds of fuel), by its own hit's strength: a faint one soon burns out.
    u[92] = (0.9 + 0.4 * m.energySlow) * (0.3 + 0.7 * Math.sqrt(this.kLv[0]));
    u[93] = 0.7 * (0.3 + 0.7 * Math.sqrt(this.sLv[0]));
    this.subs = Math.min(8, Math.max(2, 2 * Math.ceil((u[85] * dt) / (WIN / SIM) / 2)));
    this.device.queue.writeBuffer(this.uBuffer, 0, u);
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView): void {
    const P = this.pipes;
    const G = this.groups;
    const n = Math.ceil(SIM / 8);
    const cp = encoder.beginComputePass({ label: 'glossy-liquid-fronts' });
    cp.setBindGroup(0, this.group0);
    cp.setPipeline(P.centre);
    cp.setBindGroup(1, G.centre);
    cp.dispatchWorkgroups(1);
    cp.setPipeline(P.step);
    for (let s = 0; s < this.subs; s++) {
      cp.setBindGroup(1, s === 0 ? G.first : s % 2 ? G.ba : G.ab);
      cp.dispatchWorkgroups(n, n);
    }
    cp.end();
    this.reset = false;
    const pass = encoder.beginRenderPass({
      label: 'glossy-liquid',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(P.render);
    pass.setBindGroup(0, this.group0);
    pass.setBindGroup(1, G.render);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    for (const r of this.owned) r.destroy();
  }
}

const factory: SceneFactory = {
  meta: META,
  async create(device: GPUDevice, shared: SharedResources) {
    const prelude = `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${HEAD}`;
    const C = GPUShaderStage.COMPUTE;
    const FR = GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX;
    const stepLayout = device.createBindGroupLayout({
      label: 'glossy-liquid-step',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'uniform' } },
        { binding: 2, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: C, storageTexture: { access: 'write-only', format: 'rgba32float' } },
        { binding: 5, visibility: C, storageTexture: { access: 'write-only', format: 'rgba32float' } },
        { binding: 6, visibility: C, buffer: { type: 'read-only-storage' } },
      ],
    });
    const renderLayout = device.createBindGroupLayout({
      label: 'glossy-liquid-render',
      entries: [
        { binding: 0, visibility: FR, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const centreLayout = device.createBindGroupLayout({
      label: 'glossy-liquid-centre',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const cModule = await compileModule(device, `${prelude}
${CENTRE}`, 'glossy-liquid-centre');
    const centre = await device.createComputePipelineAsync({
      label: 'glossy-liquid-centre',
      layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, centreLayout] }),
      compute: { module: cModule, entryPoint: 'main' },
    });
    const sModule = await compileModule(device, `${prelude}\n${STEP}`, 'glossy-liquid-step');
    const step = await device.createComputePipelineAsync({
      label: 'glossy-liquid-step',
      layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, stepLayout] }),
      compute: { module: sModule, entryPoint: 'main' },
    });
    const rModule = await compileModule(device, `${prelude}\n${FULLSCREEN_VS}\n${RENDER}`, 'glossy-liquid-draw');
    const render = await device.createRenderPipelineAsync({
      label: 'glossy-liquid-draw',
      layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, renderLayout] }),
      vertex: { module: rModule, entryPoint: 'vs' },
      fragment: { module: rModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const tex = (label: string, format: GPUTextureFormat) =>
      device.createTexture({ label: `glossy-liquid-${label}`, size: [SIM, SIM], format, usage });
    const kA = tex('kA', 'rgba32float');
    const kB = tex('kB', 'rgba32float');
    const tA = tex('tA', 'rgba32float');
    const tB = tex('tB', 'rgba32float');
    const uBuffer = device.createBuffer({ label: 'glossy-liquid-u', size: NU * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sub = (v: number) => {
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
      new Float32Array(b.getMappedRange()).set([v, 0, 0, 0]);
      b.unmap();
      return b;
    };
    const cBuffer = device.createBuffer({ label: 'glossy-liquid-centre', size: 16, usage: GPUBufferUsage.STORAGE });
    const subFirst = sub(1);
    const subRest = sub(0);
    const stepGroup = (s: GPUBuffer, kIn: GPUTexture, tIn: GPUTexture, kOut: GPUTexture, tOut: GPUTexture) =>
      device.createBindGroup({
        layout: stepLayout,
        entries: [
          { binding: 0, resource: { buffer: uBuffer } },
          { binding: 1, resource: { buffer: s } },
          { binding: 2, resource: kIn.createView() },
          { binding: 3, resource: tIn.createView() },
          { binding: 4, resource: kOut.createView() },
          { binding: 5, resource: tOut.createView() },
          { binding: 6, resource: { buffer: cBuffer } },
        ],
      });
    const groups: Groups = {
      centre: device.createBindGroup({
        layout: centreLayout,
        entries: [
          { binding: 0, resource: { buffer: uBuffer } },
          { binding: 1, resource: { buffer: cBuffer } },
        ],
      }),
      first: stepGroup(subFirst, kA, tA, kB, tB),
      ba: stepGroup(subRest, kB, tB, kA, tA),
      ab: stepGroup(subRest, kA, tA, kB, tB),
      render: device.createBindGroup({
        layout: renderLayout,
        entries: [
          { binding: 0, resource: { buffer: uBuffer } },
          { binding: 1, resource: kA.createView() },
          { binding: 2, resource: tA.createView() },
          { binding: 3, resource: { buffer: cBuffer } },
        ],
      }),
    };
    const paramBuffer = shared.createSceneParamBuffer('glossy-liquid-params');
    const group0 = shared.createSceneBindGroup(paramBuffer, 'glossy-liquid');
    return new GlossyInstance(device, group0, uBuffer, { centre, step, render }, groups, [kA, kB, tA, tB, uBuffer, cBuffer, subFirst, subRest, paramBuffer]);
  },
};

export default factory;
