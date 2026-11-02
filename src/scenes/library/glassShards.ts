import { compileModule } from '../../gpu/context';
import { SCENE_LAYOUT } from '../../gpu/frameLayout';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { lookAtPerspective, type Vec3 } from '../math';
import { Morph, wave } from '../morph';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Glass Shards: the viewer drifts inside a field of refractive, dispersive glass shards in teal,
 * magenta, orange and violet on black. Every shard is a real piece of glass with its own place,
 * orientation, colour and history, rendered as an instanced prism: a depth-peeled pass captures
 * everything behind the nearest glass, and the nearest glass refracts it with a five-wavelength
 * dispersion through bevelled edges, under a studio of soft lights, with crisp rims and glints.
 *
 * The shards are arranged in panes (glass plates cracked into three pieces) and the panes in a
 * formation: a burst, a vortex, a porous lattice tube, layered sheets, or two clusters reaching for
 * each other. The morph flows continuously through those families and their shape parameters (each
 * kick, snare and melody note also steps the shape for good, gliding in on a spring), the field slowly turns, a slow wave rocks the panes
 * so glints sweep across it, and the camera orbits through the field's outer shell at a steady pace,
 * looking across its heart. Shards near the lens dissolve rather than crowd it.
 * Nothing snaps: every step glides in from rest on a critically damped spring, and every light
 * swells in over a fraction of a second instead of flaring on.
 *
 * Beats are processes that travel through the formation along its own topology (a nearest-neighbour
 * graph of the panes, with per-link conductivity, so fronts are ragged, follow the structure and
 * branch where it branches). Their light runs mostly along edges and bevels, so it never bleaches the
 * glass:
 * - kick: a fracture front from a point in the frame. Each pane it reaches glows and cracks white-hot
 *   along its cracks (cooling through yellow and orange to nothing), throws off glass dust, and its
 *   three pieces part and glide into different panes a hop onward: the region reassembles into
 *   a new arrangement, every pane now a composite of pieces from elsewhere. For good. Every shard's
 *   glass colour also turns a step round the wheel.
 * - snare: a faster shimmer front from elsewhere: each shard it reaches lights with sliding rainbow
 *   refraction (stronger dispersion) and glides one or two glass colours on, for good; the whole
 *   formation also turns a notch and the key light swings round it, so the glints move.
 * - melody: each note lands at a place set by its pitch (high notes high in the frame) and spreads a
 *   short way: the shards there take the note's colour (its pitch class round the quartet) and align
 *   to a common plane at an angle set by the pitch (turning there from the frame they held), until a
 *   kick shatters them again. The studio's soft boxes turn to a colour set by the pitch.
 * - chords: turn the glass hues a little round the wheel.
 * - energy: how far fronts reach, how much dust they throw (the spectrum shapes it: colour from the
 *   centroid, size from the low bands, amount from the band energy and flux), and the pace of the
 *   flow (only a long quiet slows it).
 */

const NA = 12;
const NR = 36;
const M = NA * NR;
const K = 3;
const N = M * K;
const PF = 32;
const DUST_MAX = 6144;
const DF = 12;
const UVEC = 20;
const SAMPLES = 4;
const Z_NEAR = 0.08;
const Z_FAR = 60;
const KN = 6;
const TAU = Math.PI * 2;
const FOV = 0.95;

const META: SceneMeta = {
  id: 'glass-shards',
  name: 'Glass Shards',
  energy: [0.15, 1],
  mood: { valence: 0.6, arousal: 0.65 },
  genres: { edm: 1, techno: 0.9, dnb: 0.8, dubstep: 0.8, synthwave: 0.8, pop: 0.7, hiphop: 0.6, rock: 0.6, ambient: 0.5, classical: 0.5, jazz: 0.4, lofi: 0.4, acoustic: 0.4 },
  trails: 0,
  kaleido: false,
};

/*
 * Uniform U (vec4 slots):
 *  0-3 view-projection   4 eye, tan(fov/2)   5 right, aspect   6 up, clock   7 forward, dispersion
 *  8-11 glass quartet (teal, magenta, orange, violet after the chord turn)
 *  12 fog colour, fog density   13 key light dir, body glow   14 back light dir, exposure
 *  15 half w, half h, full w, full h   16 formation centre, energy   17-19 soft box colours
 */
const WGSL = /* wgsl */ `
struct Piece { a: vec4f, q: vec4f, c01: vec4f, c23: vec4f, m0: vec4f, m1: vec4f, m2: vec4f, m3: vec4f };
struct Dust { p: vec4f, v: vec4f, c: vec4f };
@group(1) @binding(0) var<uniform> U: array<vec4f, ${UVEC}>;
@group(1) @binding(1) var<storage, read> pieces: array<Piece>;
@group(1) @binding(2) var<storage, read> dust: array<Dust>;
@group(2) @binding(0) var nearDepth: texture_depth_2d;
@group(2) @binding(1) var bgTex: texture_2d<f32>;

fn gs_vp() -> mat4x4f { return mat4x4f(U[0], U[1], U[2], U[3]); }
fn gs_qrot(q: vec4f, v: vec3f) -> vec3f { let t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
fn gs_corner(P: Piece, k: u32) -> vec2f {
  switch k {
    case 0u: { return P.c01.xy; }
    case 1u: { return P.c01.zw; }
    case 2u: { return P.c23.xy; }
    default: { return P.c23.zw; }
  }
}
fn gs_toUV(p: vec3f) -> vec2f {
  let c = gs_vp() * vec4f(p, 1.0);
  let n = c.xy / max(c.w, 1e-3);
  return vec2f(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5);
}

// The glass quartet, cyclic and smooth between neighbours (hue steps are eased on the CPU).
fn gs_quartet(h: f32) -> vec3f {
  let x = fract(h * 0.25) * 4.0;
  let i = floor(x);
  let f = smoothstep(0.0, 1.0, x - i);
  let a = select(select(select(U[11].rgb, U[10].rgb, i < 2.5), U[9].rgb, i < 1.5), U[8].rgb, i < 0.5);
  let b = select(select(select(U[8].rgb, U[11].rgb, i < 2.5), U[10].rgb, i < 1.5), U[9].rgb, i < 0.5);
  return mix(a, b, f);
}
// A note's colour: its pitch class round the quartet, held close to the pure glass colours.
fn gs_pitchCol(h: f32) -> vec3f {
  let x = h * 4.0;
  let i = floor(x);
  let f = smoothstep(0.3, 0.7, x - i);
  return gs_quartet(i + f) * 1.1;
}
fn gs_glass(P: Piece) -> vec3f { return mix(gs_quartet(P.m0.x), gs_pitchCol(P.m1.x), P.m1.y); }
fn gs_norm(c: vec3f) -> vec3f { return c / max(max(c.r, max(c.g, c.b)), 1e-4); }
// Hot glass: white through yellow and orange to a dull red as x falls from 1 to 0.
fn gs_hot(x: f32) -> vec3f {
  let y = sat(x);
  return vec3f(1.0, 0.18 + 0.82 * pow(y, 1.4), pow(y, 3.5)) * (0.15 + 2.6 * y * y);
}
fn gs_spectral(x: f32) -> vec3f {
  let c = 0.5 + 0.5 * cos(TAU * (x + vec3f(0.0, 0.33, 0.67)));
  return c * c;
}

// The studio the glass reflects and refracts: crisp rectangular soft boxes in the glass colours
// round and behind the viewer (what camera-facing glass reflects), two ahead (seen only through
// the glass), a narrow white key strip, and a dim coloured gradient everywhere else, so glass at
// any angle carries some sheen. Fixed to the camera's frame, turning slowly with the clock. The
// backdrop itself stays black: the boxes are off-screen lights.
fn gs_panel(d: vec3f, c: vec3f, up: vec3f, size: vec2f, soft: f32) -> f32 {
  let z = dot(d, c);
  if (z <= 0.05) { return 0.0; }
  let a = normalize(cross(c, up));
  let b = cross(a, c);
  let q = vec2f(dot(d, a), dot(d, b)) / z;
  let e = size - abs(q);
  return smoothstep(0.0, soft, min(e.x, e.y));
}
fn gs_env(d: vec3f) -> vec3f {
  let R = U[5].xyz; let Up = U[6].xyz; let Fw = U[7].xyz;
  let t = U[6].w * 0.04;
  let tu = normalize(Up + R * 0.25 * sin(t));
  let hz = dot(d, Up);
  var c = mix(U[19].rgb * 0.03, U[17].rgb * 0.07, smoothstep(-0.6, 0.8, hz)) + U[18].rgb * 0.06 * smoothstep(-0.2, 1.0, dot(d, R));
  c += vec3f(0.9, 0.95, 1.0) * 0.05 * smoothstep(0.1, 0.9, -dot(d, Fw)) * smoothstep(-0.3, 0.6, hz);
  c += U[17].rgb * 1.1 * gs_panel(d, normalize(-R * 0.55 + Up * 0.6 - Fw * 0.6), tu, vec2f(0.5, 0.95), 0.12);
  c += U[18].rgb * 0.9 * gs_panel(d, normalize(R * 0.8 - Fw * 0.55 + Up * 0.1), tu, vec2f(0.38, 1.1), 0.1);
  c += U[19].rgb * 0.75 * gs_panel(d, normalize(-Up * 0.75 - Fw * 0.35 + R * 0.25), tu, vec2f(1.2, 0.28), 0.1);
  c += U[11].rgb * 0.6 * gs_panel(d, normalize(Fw * 0.85 + R * 0.45 + Up * 0.25), tu, vec2f(0.45, 0.8), 0.2);
  c += U[8].rgb * 0.45 * gs_panel(d, normalize(Fw * 0.8 - R * 0.55 - Up * 0.3), tu, vec2f(0.7, 0.35), 0.2);
  c += vec3f(1.0, 0.96, 0.92) * 1.8 * gs_panel(d, U[13].xyz, tu, vec2f(0.05, 0.75), 0.03);
  return c;
}

// The backdrop: rich near-black with a dim two-hue haze round the formation's heart.
fn gs_bg(rd: vec3f) -> vec3f {
  let dc = normalize(U[16].xyz - U[4].xyz);
  let a = sat(dot(rd, dc));
  var c = mix(vec3f(0.0016, 0.0011, 0.0030), vec3f(0.0010, 0.0022, 0.0028), sat(rd.y * 0.5 + 0.5));
  c += U[19].rgb * 0.010 * pow(a, 5.0) + U[17].rgb * 0.008 * pow(a, 24.0);
  return c * U[14].w;
}

struct VOut {
  @builtin(position) @invariant pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) lp: vec3f,
  @location(2) @interpolate(flat) nrm: vec3f,
  @location(3) @interpolate(flat) ids: vec2u,
};

@vertex fn vsPiece(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let P = pieces[ii];
  if (P.m1.z < 0.004) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let f = vi / 6u;
  let j = vi % 6u;
  let h = P.a.w * 0.5;
  var capT = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
  var capB = array<u32, 6>(0u, 2u, 1u, 0u, 3u, 2u);
  var l: vec3f;
  var n: vec3f;
  if (f == 0u) {
    l = vec3f(gs_corner(P, capT[j]), h);
    n = vec3f(0.0, 0.0, 1.0);
  } else if (f == 1u) {
    l = vec3f(gs_corner(P, capB[j]), -h);
    n = vec3f(0.0, 0.0, -1.0);
  } else {
    let k = f - 2u;
    let a = gs_corner(P, k);
    let b = gs_corner(P, (k + 1u) % 4u);
    let useB = j == 2u || j == 4u || j == 5u;
    let top = j == 0u || j == 3u || j == 5u;
    l = vec3f(select(a, b, useB), select(-h, h, top));
    let e = b - a;
    let el = length(e);
    n = select(vec3f(1.0, 0.0, 0.0), vec3f(e.y, -e.x, 0.0) / max(el, 1e-6), el > 1e-6);
  }
  o.wp = P.a.xyz + gs_qrot(P.q, l);
  o.pos = gs_vp() * vec4f(o.wp, 1.0);
  o.lp = l;
  o.nrm = gs_qrot(P.q, n);
  o.ids = vec2u(ii, f);
  return o;
}

// Signed distances (inside > 0) from a point on a cap to the piece's four edges.
fn gs_edgeD(P: Piece, p: vec2f) -> vec4f {
  var d = vec4f(1e3);
  for (var k = 0u; k < 4u; k++) {
    let a = gs_corner(P, k);
    let e = gs_corner(P, (k + 1u) % 4u) - a;
    let el = length(e);
    if (el > 1e-5) { d[k] = (e.x * (p.y - a.y) - e.y * (p.x - a.x)) / el; }
  }
  return d;
}
fn gs_edgeN(P: Piece, k: u32) -> vec2f {
  let e = gs_corner(P, (k + 1u) % 4u) - gs_corner(P, k);
  return vec2f(e.y, -e.x) / max(length(e), 1e-5);
}

struct Surf {
  N: vec3f,      // shading normal (bevelled near edges)
  Nf: vec3f,     // flat face normal
  V: vec3f,
  dist: f32,
  pxw: f32,      // world size of a pixel here
  dE: f32,       // distance to the nearest edge (caps), 0 on sides
  bev: f32,
  dC: f32,       // distance to the nearest crack edge
  side: f32,
  scale: f32,
};

fn gs_surf(in: VOut, P: Piece) -> Surf {
  var s: Surf;
  let eye = U[4].xyz;
  s.V = normalize(eye - in.wp);
  s.dist = length(eye - in.wp);
  s.pxw = s.dist * 2.0 * U[4].w / U[15].w;
  s.Nf = in.nrm;
  s.scale = P.m2.w;
  s.side = select(0.0, 1.0, in.ids.y >= 2u);
  s.N = s.Nf;
  s.dE = 0.0;
  s.bev = 1.0;
  s.dC = 1e3;
  let mask = u32(P.m1.w + 0.5);
  if (in.ids.y < 2u) {
    let d = gs_edgeD(P, in.lp.xy);
    var k = 0u;
    var m = d.x;
    if (d.y < m) { m = d.y; k = 1u; }
    if (d.z < m) { m = d.z; k = 2u; }
    if (d.w < m) { m = d.w; k = 3u; }
    s.dE = max(m, 0.0);
    let bw = max(0.022 * s.scale, 1.6 * s.pxw);
    s.bev = 1.0 - sat(s.dE / bw);
    let en = gs_edgeN(P, k);
    let enw = gs_qrot(P.q, vec3f(en, 0.0));
    // Micro facet: the face is cut at a slight angle that the high end re-cuts (P.m3.w, the pane's
    // fine phase, eased on the CPU; zero at rest), so what the glass refracts and reflects re-forms.
    let ft = P.m3.w;
    let fs0 = P.m2.x * TAU;
    let tl = vec2f(sin(ft * 1.7 + fs0) - sin(fs0), cos(ft * 1.3 + fs0 * 0.7) - cos(fs0 * 0.7)) * 0.09;
    s.N = normalize(s.Nf + enw * s.bev * s.bev * 1.6 + gs_qrot(P.q, vec3f(tl, 0.0)));
    if ((mask & 1u) != 0u) { s.dC = min(s.dC, max(d.y, 0.0)); }
    if ((mask & 2u) != 0u) { s.dC = min(s.dC, max(d.w, 0.0)); }
  } else {
    let k = in.ids.y - 2u;
    let crack = (k == 1u && (mask & 1u) != 0u) || (k == 3u && (mask & 2u) != 0u);
    s.dC = select(1e3, 0.0, crack);
  }
  return s;
}

fn gs_ages(P: Piece) -> vec3f {
  // heat, shimmer, landing glow: each swells in as its front arrives, then fades (CPU pulses)
  return P.m3.xyz;
}

// Emission common to both layers: rims, glints, fracture heat, snare shimmer, the note's landing.
fn gs_emit(s: Surf, P: Piece, in: VOut, g: vec3f, R: vec3f, F: f32) -> vec3f {
  let ages = gs_ages(P);
  var c = vec3f(0.0);
  // Crisp rims: a one-pixel line along every edge, brightest where the bevel catches the key.
  let el = 1.0 - smoothstep(0.35 * s.pxw, 1.5 * s.pxw, s.dE);
  let kd = sat(dot(R, U[13].xyz));
  c += (mix(g, vec3f(1.0), 0.3) * 0.14 + vec3f(1.0, 0.97, 0.92) * pow(kd, 30.0) * 2.5) * el * (1.0 - s.side);
  // Glints: a hard specular on the bevel and a softer one on the face.
  c += vec3f(1.0, 0.97, 0.94) * (pow(kd, 900.0) * 9.0 * (0.25 + 0.75 * s.bev) + pow(kd, 120.0) * 0.35);
  // Fracture: the cracks burn white-hot as the front passes, cooling to orange embers.
  let heat = ages.x;
  let w = 1.1 * s.pxw + 0.03 * s.scale * heat * heat;
  c += gs_hot(heat) * exp(-s.dC / w) * 2.4 * heat;
  // The front itself: the whole shard flares hot for a moment as the fracture reaches it.
  let flare = min(heat * heat * heat, 1.0);
  c += gs_hot(0.45 + 0.25 * flare) * flare * (0.22 + 1.3 * s.bev + 1.2 * el);
  // Snare: rainbow refraction slides along the shard as the shimmer front crosses it.
  let sh = ages.y;
  let x = dot(in.lp.xy, vec2f(0.9, 0.45)) / max(s.scale, 0.2) - P.m0.z * 2.2 + 0.6;
  let streak = exp(-x * x * 18.0);
  let sflash = min(sh * sh, 1.0);
  let gk = mix(vec3f(1.0), gs_norm(g), 0.5);
  c += gs_spectral(x * 1.3 + P.m2.x) * (sh * (streak * (0.4 + 1.0 * F) * gk + el * 0.9) * 0.8 + sflash * (0.2 * gk + 1.1 * s.bev + 1.0 * el));
  // Melody: the note's colour lights the shard as it lands.
  c += gs_pitchCol(P.m1.x) * ages.z * (0.7 + 2.6 * el + 1.8 * s.bev);
  return c;
}

fn gs_fog(c: vec3f, dist: f32, rd: vec3f) -> vec3f {
  let k = exp(-max(dist - 2.5, 0.0) * U[12].w);
  return mix(gs_bg(rd), c, k);
}

// Behind layer (half resolution, depth-peeled, sorted back to front): glass that is only ever seen
// through the nearest glass, so it is simpler: body, reflection, rims and the events.
@fragment fn fsBehind(in: VOut) -> @location(0) vec4f {
  let nd = textureLoad(nearDepth, vec2i(in.pos.xy), 0);
  if (in.pos.z <= nd + 2e-7) { discard; }
  let P = pieces[in.ids.x];
  let s = gs_surf(in, P);
  let g = gs_glass(P);
  let gN = gs_norm(g);
  let ndv = abs(dot(s.N, s.V));
  let F = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  let R = reflect(-s.V, s.N);
  let r = refract(-s.V, s.N * sign(dot(s.N, s.V)), 1.0 / 1.48);
  let back = pow(sat(dot(-s.V, U[14].xyz)), 2.0);
  var c = gN * U[13].w * (0.22 + 0.6 * back + 0.5 * (1.0 - ndv)) * (0.6 + 1.1 * exp(-s.dE / (0.07 * s.scale)) + 0.5 * s.side);
  c += gs_env(r) * gN * 0.5 + gs_env(R) * F * mix(vec3f(1.0), gN, 0.55);
  c += gs_emit(s, P, in, g, R, F);
  c = gs_fog(c, s.dist, -s.V) * U[14].w * P.m1.z;
  // Each layer rolls off on its own so stacked glass deepens in colour instead of adding to white.
  c *= 1.0 / (1.0 + 1.6 * max(max(c.r, max(c.g, c.b)) - 0.25, 0.0));
  let a = (0.8 + 0.18 * F) * P.m1.z;
  return vec4f(c, a);
}

@fragment fn fsNull(in: VOut) -> @location(0) vec4f { return vec4f(0.0); }

// Nearest glass (full resolution, 4x MSAA): refracts what lies behind it through five wavelengths.
@fragment fn fsNear(in: VOut) -> @location(0) vec4f {
  let P = pieces[in.ids.x];
  let s = gs_surf(in, P);
  let g = gs_glass(P);
  let gN = gs_norm(g);
  let uv = in.pos.xy / U[15].zw;
  let ndv = abs(dot(s.N, s.V));
  let F = 0.06 + 0.94 * pow(1.0 - ndv, 5.0);
  let R = reflect(-s.V, s.N);
  let ages = gs_ages(P);
  let disp = U[7].w * (1.0 + 3.5 * ages.y);
  let D = 0.7 + 0.5 * ages.y;
  let Nn = s.N * sign(dot(s.N, s.V));
  let straight = gs_toUV(in.wp - s.V * D);
  var wr = array<vec3f, 5>(vec3f(0.55, 0.0, 0.0), vec3f(0.45, 0.35, 0.0), vec3f(0.0, 0.3, 0.0), vec3f(0.0, 0.35, 0.4), vec3f(0.0, 0.0, 0.6));
  var trans = vec3f(0.0);
  var envT = vec3f(0.0);
  var r0 = -s.V;
  // Each wavelength tap is nudged a texel round a rotating circle: a faint frost that hides the
  // half-resolution stair-steps of what lies behind.
  let rot0 = ign(in.pos.xy) * TAU;
  let texel = 1.0 / U[15].xy;
  for (var i = 0; i < 5; i++) {
    let ja = rot0 + f32(i) * 2.39996;
    let jit = vec2f(cos(ja), sin(ja)) * texel * 1.1;
    let ior = 1.47 + (f32(i) - 2.0) * disp;
    var r = refract(-s.V, Nn, 1.0 / ior);
    if (dot(r, r) < 0.5) { r = R; }
    if (i == 2) { r0 = r; }
    let off = gs_toUV(in.wp + r * D) - straight;
    trans += textureSampleLevel(bgTex, sampClamp, uv + off + jit, 0.0).rgb * wr[i];
    envT += gs_env(r) * wr[i];
  }
  // A deep stack of glass behind saturates in colour rather than adding up to white.
  trans = trans / (1.0 + 1.1 * max(trans.r, max(trans.g, trans.b)));
  // Coloured glass: the longer the path through it, the deeper the tint.
  let path = 1.0 / max(abs(dot(r0, s.Nf)), 0.3);
  let tr = exp(-(1.0 - gN) * 1.5 * path);
  let back = pow(sat(dot(r0, U[14].xyz)), 2.0);
  var c = trans * tr + envT * gN * 0.55 * tr;
  let pipe = 0.6 + 1.1 * exp(-s.dE / (0.07 * s.scale)) + 0.5 * s.side;
  c += gN * U[13].w * (0.2 + 0.6 * back + 0.45 * (1.0 - ndv)) * pipe * (1.0 + 0.6 * P.m1.y);
  c += gs_env(R) * F * 1.2 * mix(vec3f(1.0), gN, 0.55);
  // Light caught inside the glass: the refracted ray bounced off the back face, tinted twice.
  c += gs_env(reflect(r0, -s.Nf)) * gN * gN * 0.22;
  c += gs_emit(s, P, in, g, R, F) * U[14].w;
  c = gs_fog(c, s.dist, -s.V);
  // Anything near the lens dissolves into what lies behind it rather than filling the frame.
  let behind = textureSampleLevel(bgTex, sampClamp, uv, 0.0).rgb;
  c = mix(behind, c, P.m1.z);
  // Soft shoulder on the brightest channel so bright glass rolls off without bleaching to white.
  c *= 1.0 / (1.0 + 0.7 * max(max(c.r, max(c.g, c.b)) - 0.7, 0.0));
  return vec4f(c, 1.0);
}

${FULLSCREEN_VS}

@fragment fn fsBg(in: VsOut) -> @location(0) vec4f {
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let rd = normalize(U[7].xyz + U[5].xyz * ndc.x * U[5].w * U[4].w + U[6].xyz * ndc.y * U[4].w);
  return vec4f(gs_bg(rd), 1.0);
}
@fragment fn fsCopy(in: VsOut) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(bgTex, sampClamp, in.uv, 0.0).rgb, 1.0);
}

// Glass dust: fine glints streaked along their motion, twinkling as they turn.
struct DOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) color: vec3f, @location(2) stretch: f32 };
@vertex fn vsDust(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, ) -> DOut {
  var o: DOut;
  let d = dust[ii];
  let vp = gs_vp();
  let clip = vp * vec4f(d.p.xyz, 1.0);
  let prev = vp * vec4f(d.p.xyz - d.v.xyz * 0.05, 1.0);
  if (clip.w < 0.3 || prev.w < 0.3 || d.v.w <= 0.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let res = U[15].zw;
  let a = clip.xy / clip.w * res * 0.5;
  let b = prev.xy / prev.w * res * 0.5;
  let sizePx = clamp(d.p.w * res.y * 0.5 / clip.w, 0.7, 6.0);
  var dir = a - b;
  let len = min(length(dir), 40.0);
  dir = select(vec2f(1.0, 0.0), dir / max(length(dir), 1e-5), len > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let halfLen = len * 0.5 + sizePx;
  let px = (a + b) * 0.5 + dir * c.x * halfLen + nrm * c.y * sizePx;
  o.pos = vec4f(px / (res * 0.5) * clip.w, clip.z, clip.w);
  o.q = vec2f(c.x * halfLen / sizePx, c.y);
  o.stretch = halfLen / sizePx - 1.0;
  let cover = min(1.0, d.p.w * res.y * 0.5 / clip.w / 0.7);
  let tw = 0.7 + 0.3 * sin(U[6].w * (1.2 + 1.8 * d.c.w) + d.c.w * 40.0);
  let fog = exp(-max(clip.w - 2.5, 0.0) * U[12].w);
  o.color = d.c.rgb * d.v.w * tw * cover * cover * fog / (1.0 + len / (sizePx * 2.0)) * U[14].w;
  return o;
}
fn gs_dustFall(in: DOut) -> vec4f {
  let d = vec2f(max(abs(in.q.x) - in.stretch, 0.0), in.q.y);
  return vec4f(in.color * exp(-dot(d, d) * 3.0), 0.0);
}
@fragment fn fsDustBehind(in: DOut) -> @location(0) vec4f {
  let nd = textureLoad(nearDepth, vec2i(in.pos.xy), 0);
  if (in.pos.z <= nd) { discard; }
  return gs_dustFall(in);
}
@fragment fn fsDustFront(in: DOut) -> @location(0) vec4f { return gs_dustFall(in); }
`;

// ---------- small vector / quaternion helpers ----------
type Q = [number, number, number, number];
const v3len = (x: number, y: number, z: number) => Math.hypot(x, y, z) || 1;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
function qFromBasis(tx: number, ty: number, tz: number, bx: number, by: number, bz: number, nx: number, ny: number, nz: number, o: Float64Array | Float32Array, k: number): void {
  // columns X = T, Y = B, Z = N
  const m00 = tx, m10 = ty, m20 = tz, m01 = bx, m11 = by, m21 = bz, m02 = nx, m12 = ny, m22 = nz;
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  o[k] = x / l;
  o[k + 1] = y / l;
  o[k + 2] = z / l;
  o[k + 3] = w / l;
}
function qMul(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, o: Float64Array | Float32Array, k: number): void {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  o[k] = aw * bx + ax * bw + ay * bz - az * by;
  o[k + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[k + 2] = aw * bz + ax * by - ay * bx + az * bw;
  o[k + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
const QT = new Float64Array(4);
/** Axis-angle quaternion into a shared scratch (use before the next call). */
function qAxisT(x: number, y: number, z: number, ang: number): Float64Array {
  const s = Math.sin(ang / 2);
  QT[0] = x * s;
  QT[1] = y * s;
  QT[2] = z * s;
  QT[3] = Math.cos(ang / 2);
  return QT;
}
function qAxis(x: number, y: number, z: number, ang: number): Q {
  const s = Math.sin(ang / 2);
  return [x * s, y * s, z * s, Math.cos(ang / 2)];
}
/** Normalised lerp along the short arc, into o[k..]. */
function qNlerp(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, t: number, o: Float64Array | Float32Array, k: number): void {
  const d = a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2] + a[ai + 3] * b[bi + 3];
  const sg = d < 0 ? -1 : 1;
  const x = a[ai] * (1 - t) + b[bi] * t * sg;
  const y = a[ai + 1] * (1 - t) + b[bi + 1] * t * sg;
  const z = a[ai + 2] * (1 - t) + b[bi + 2] * t * sg;
  const w = a[ai + 3] * (1 - t) + b[bi + 3] * t * sg;
  const l = Math.hypot(x, y, z, w) || 1;
  o[k] = x / l;
  o[k + 1] = y / l;
  o[k + 2] = z / l;
  o[k + 3] = w / l;
}
/** Rotates (x, y, z) by quaternion q[qi..], writing to o[k..]. */
function qRot(q: ArrayLike<number>, qi: number, x: number, y: number, z: number, o: Float64Array | Float32Array | number[], k: number): void {
  const qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  o[k] = x + qw * tx + (qy * tz - qz * ty);
  o[k + 1] = y + qw * ty + (qz * tx - qx * tz);
  o[k + 2] = z + qw * tz + (qx * ty - qy * tx);
}
/** One step of a critically damped spring on arrays (x[i] toward target, v[i] its velocity): from rest, settles in about 5/w s. */
function springAt(x: Float32Array, v: Float32Array, i: number, target: number, w: number, e: number, dt: number): void {
  const d = x[i] - target;
  const c = v[i] + w * d;
  x[i] = target + (d + c * dt) * e;
  v[i] = (v[i] - w * c * dt) * e;
}
/**
 * A light pulse that swells instead of flaring on: energy poured into `g` drains into the glow `h`
 * at rate w while the glow fades at rate k (exact two-stage step). Peaks about ln(w/k)/(w-k) s in.
 */
function pulseAt(g: Float32Array, h: Float32Array, i: number, w: number, k: number, ew: number, ek: number): void {
  h[i] = h[i] * ek + (g[i] * w * (ek - ew)) / (w - k);
  g[i] *= ew;
}
/**
 * Event strength (morph's 0..1 level) to reaction strength: an S-curve from 0, so a faint hit after
 * quiet is a faint touch while an ordinary one already gives most of the change (no threshold).
 */
const react = (lv: number) => {
  const x = Math.min(1, Math.max(0, lv));
  return x * x * (3 - 2 * x);
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function hash(n: number): number {
  let x = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}
function rng(seed: number): () => number {
  let s = (seed * 4294967296) >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Turns an RGB colour round the grey axis. */
function hueTurn(c: Vec3, a: number): Vec3 {
  const k = 0.57735027;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  const d = k * (c[0] + c[1] + c[2]);
  const cx = k * (c[2] - c[1]);
  const cy = k * (c[0] - c[2]);
  const cz = k * (c[1] - c[0]);
  return [0, 1, 2].map((i) => Math.max(0, c[i] * cs + [cx, cy, cz][i] * sn + k * d * (1 - cs))) as Vec3;
}

/** The glass quartet of the reference: teal, magenta, orange, violet (linear RGB). */
const QUARTET: Vec3[] = [
  [0.0, 0.52, 0.62],
  [0.86, 0.02, 0.46],
  [1.0, 0.32, 0.02],
  [0.36, 0.07, 0.95],
];

/** Formation shape parameters for a frame (from the morph). */
interface Form {
  w: number[];
  squash: number;
  swirl: number;
  twist: number;
  funnel: number;
  vthick: number;
  knot: number;
  tubeR: number;
  lattice: number;
  gap: number;
  amp: number;
  freq: number;
  tilt: number;
  tgap: number;
  cone: number;
  spread: number;
  size: number;
  ph: number;
  psi0: number;
}

class GlassShards implements SceneInstance {
  readonly meta = META;
  private readonly morph = new Morph(0.4);
  private readonly params = new Float32Array(SCENE_LAYOUT.size / 4);
  private readonly paramBuffer: GPUBuffer;
  private readonly group0: GPUBindGroup;
  private readonly group1: GPUBindGroup;
  private readonly uBuf: GPUBuffer;
  private readonly pBuf: GPUBuffer;
  private readonly dBuf: GPUBuffer;
  private readonly U = new Float32Array(UVEC * 4);
  private readonly pData = new Float32Array(N * PF);
  private readonly dData = new Float32Array(DUST_MAX * DF);
  private dustCount = 0;
  private near: GPUTexture | null = null;
  private bg: GPUTexture | null = null;
  private msaa: GPUTexture | null = null;
  private msDepth: GPUTexture | null = null;
  private g2a: GPUBindGroup | null = null;
  private g2b: GPUBindGroup | null = null;
  private aspect = 16 / 9;

  // ----- panes (static) -----
  private readonly gu = new Float32Array(M);
  private readonly gv = new Float32Array(M);
  private readonly ju = new Float32Array(M);
  private readonly jv = new Float32Array(M);
  private readonly pw = new Float32Array(M);
  private readonly psz = new Float32Array(M);
  private readonly psi = new Float32Array(M);
  private readonly pph = new Float32Array(M * 3);
  private readonly pom = new Float32Array(M);
  private readonly plat = new Float32Array(M);
  private readonly slotC = new Float32Array(M * K * 8);
  private readonly slotO = new Float32Array(M * K * 2);
  private readonly crack = new Float32Array(M * 8);
  /** Each pane's cut: L-free plate and crack parameters (tA, bA, tB, bB, e0, e3, x1, x2, s1, s2). */
  private readonly cut = new Float32Array(M * 10);
  /** Fine re-cut phase of each pane's cracks: high notes step it where they land (value, velocity, target). */
  private readonly fineX = new Float32Array(M);
  private readonly fineV = new Float32Array(M);
  private readonly fineT = new Float32Array(M);
  private readonly fineAt = new Float64Array(M);
  private readonly fineLv = new Float32Array(M);
  // ----- panes (dynamic) -----
  private readonly pPos = new Float64Array(M * 3);
  private readonly pQ = new Float64Array(M * 4);
  private readonly pScale = new Float64Array(M);
  private readonly alignAmt = new Float32Array(M);
  private readonly alignTgt = new Float32Array(M);
  private readonly alignQ = new Float64Array(M * 4);
  private readonly alignAt = new Float64Array(M);
  private readonly alignPend = new Float64Array(M * 4);
  // A note's new frame waits for its front; then each pane turns from the frame it had to the new
  // one on a spring (never re-orienting at once).
  private readonly alignQPend = new Float64Array(M * 4);
  private readonly alignFrom = new Float64Array(M * 4);
  private readonly alignCur = new Float64Array(M * 4);
  private readonly alignB = new Float32Array(M);
  private readonly alignBV = new Float32Array(M);
  private readonly busy = new Float64Array(M);
  // ----- pieces -----
  private readonly occ = new Int32Array(M * K);
  private readonly dockP = new Int32Array(N);
  private readonly dockS = new Int32Array(N);
  private readonly departAt = new Float64Array(N);
  private readonly nextP = new Int32Array(N);
  private readonly nextS = new Int32Array(N);
  private readonly frontDir = new Float32Array(N * 3);
  private readonly flying = new Uint8Array(N);
  private readonly fStart = new Float64Array(N);
  private readonly fDur = new Float32Array(N);
  private readonly fromPos = new Float64Array(N * 3);
  private readonly fromQ = new Float64Array(N * 4);
  private readonly fromC = new Float32Array(N * 8);
  private readonly bulge = new Float32Array(N * 3);
  private readonly tumAx = new Float32Array(N * 3);
  private readonly tumAmt = new Float32Array(N);
  private readonly hue = new Float32Array(N);
  private readonly hueTgt = new Float32Array(N);
  private readonly hueAt = new Float64Array(N);
  private readonly shimAt = new Float64Array(N);
  private readonly heatAt = new Float64Array(N);
  private readonly tint = new Float32Array(N);
  private readonly tintTgt = new Float32Array(N);
  private readonly tintHue = new Float32Array(N);
  private readonly tintAt = new Float64Array(N);
  private readonly tintPendAt = new Float64Array(N);
  private readonly tintPendHue = new Float32Array(N);
  // Springs and swelling light pulses: colour steps glide from rest, fronts light shards without a flash.
  private readonly hueV = new Float32Array(N);
  private readonly tintV = new Float32Array(N);
  private readonly tintHueTgt = new Float32Array(N);
  private readonly tintHueV = new Float32Array(N);
  private readonly heatNext = new Float64Array(N);
  /** The strength of the event whose front is on its way to each piece (captured as the event lands). */
  private readonly heatLv = new Float32Array(N);
  private readonly shimLv = new Float32Array(N);
  private readonly hueLv = new Float32Array(N);
  private readonly landLv = new Float32Array(N);
  private readonly shimNext = new Float64Array(N);
  private readonly heatG = new Float32Array(N);
  private readonly heatH = new Float32Array(N);
  private readonly shimG = new Float32Array(N);
  private readonly shimH = new Float32Array(N);
  private readonly landG = new Float32Array(N);
  private readonly landH = new Float32Array(N);
  private readonly alignV = new Float32Array(M);
  /** Melody notes counted on a spring (value, velocity). */
  private readonly noteE = new Float32Array(2);
  /** Kick and snare counts on springs: [kick, kick velocity, snare, snare velocity]. */
  private readonly beatE = new Float32Array(4);
  private readonly formAt = new Float64Array(8);
  private readonly seed = new Float32Array(N);
  private readonly oPos = new Float64Array(N * 3);
  private readonly oQ = new Float64Array(N * 4);
  private readonly oC = new Float32Array(N * 8);
  private readonly oScale = new Float32Array(N);
  private readonly order = new Int32Array(N);
  private readonly key = new Float32Array(N);
  // ----- graph -----
  private readonly nbr = new Int32Array(M * KN);
  private readonly nbrD = new Float32Array(M * KN);
  private graphAt = -1e9;
  private readonly cost = new Float32Array(M);
  private readonly parent = new Int32Array(M);
  private readonly done = new Uint8Array(M);
  // ----- dust -----
  private readonly dust = new Float32Array(DUST_MAX * DF);
  private dustHead = 0;
  private readonly emits: { t: number; pane: number; dx: number; dy: number; dz: number; n: number; col: Vec3; size: number }[] = [];
  // ----- time and camera -----
  private clock = 0;
  private lastT = -1e9;
  private seedDna = -1;
  private kicks = 0;
  private snares = 0;
  private notes = 0;
  private uppers = 0;
  /** Summed (shaped) strengths of the kicks, snares and notes since the seed: lasting steps scale by them. */
  private kSum = 0;
  private sSum = 0;
  private nSum = 0;
  private hueTurnAmt = 0;
  /** Eased reactions: kick glass turn, snare key-light swing, note studio turn (values, velocities). */
  private readonly rx = new Float32Array(3);
  private readonly rxV = new Float32Array(3);
  private noteTurn = 0;
  private eye: Vec3 = [0, 0, 5];
  private right: Vec3 = [1, 0, 0];
  private up: Vec3 = [0, 1, 0];
  private fwd: Vec3 = [0, 0, -1];
  private tanHalf = Math.tan(FOV / 2);
  private rand: () => number = Math.random;
  private readonly pv = new Float64Array(3);
  private readonly acc9 = new Float64Array(9);
  private readonly knot6 = new Float64Array(6);
  private readonly tmp9 = new Float64Array(9);
  private readonly qa = new Float64Array(4);
  private readonly qb = new Float64Array(4);
  private readonly q2 = new Float64Array(4);
  private readonly v3a = new Float64Array(3);
  private readonly v3b = new Float64Array(3);
  private readonly v3c = new Float64Array(3);

  constructor(
    private readonly device: GPUDevice,
    shared: SharedResources,
    private readonly pipes: Record<string, GPURenderPipeline>,
    private readonly layouts: { g1: GPUBindGroupLayout; g2a: GPUBindGroupLayout; g2b: GPUBindGroupLayout },
  ) {
    this.paramBuffer = shared.createSceneParamBuffer(`${META.id}-params`);
    this.group0 = shared.createSceneBindGroup(this.paramBuffer, META.id);
    this.uBuf = device.createBuffer({ label: `${META.id}-u`, size: UVEC * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pBuf = device.createBuffer({ label: `${META.id}-pieces`, size: N * PF * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.dBuf = device.createBuffer({ label: `${META.id}-dust`, size: DUST_MAX * DF * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.group1 = device.createBindGroup({
      layout: layouts.g1,
      entries: [
        { binding: 0, resource: { buffer: this.uBuf } },
        { binding: 1, resource: { buffer: this.pBuf } },
        { binding: 2, resource: { buffer: this.dBuf } },
      ],
    });
    for (let i = 0; i < N; i++) this.order[i] = i;
  }

  // ---------- setup ----------
  /** A fresh field: panes, their cracks, and every piece docked in its own pane. */
  private reset(dna: readonly number[], time: number): void {
    const r = rng(dna[0] * 0.913 + dna[1] * 0.071 + (time % 1000) * 1e-4 + 0.0137);
    this.rand = r;
    for (let j = 0; j < M; j++) {
      const row = Math.floor(j / NA);
      const col = j % NA;
      this.gu[j] = (col + 0.5 * (row & 1)) / NA;
      this.gv[j] = (row + 0.5) / NR;
      this.ju[j] = r() - 0.5;
      this.jv[j] = r() - 0.5;
      this.pw[j] = r();
      this.psz[j] = 0.6 + 0.75 * Math.pow(r(), 1.6);
      this.psi[j] = (r() - 0.5) * 0.5;
      for (let k = 0; k < 3; k++) this.pph[j * 3 + k] = r() * TAU;
      this.pom[j] = (0.12 + 0.3 * r()) * (r() < 0.5 ? -1 : 1);
      this.plat[j] = (row + col) & 1 ? 1 : -1;
      // The pane: a long tapered plate (wide end left, a point or narrow end right), angled ends,
      // cut across by two slanted cracks into three convex pieces.
      const L = 0.72;
      const tA = 0.08 + 0.12 * r();
      const bA = 0.06 + 0.1 * r();
      const tB = 0.005 + 0.06 * r() * r();
      const bB = 0.005 + 0.05 * r() * r();
      const e0 = (r() - 0.5) * 0.18;
      const e3 = (r() - 0.5) * 0.12;
      const x1 = -L + 2 * L * (0.3 + 0.08 * r());
      const x2 = -L + 2 * L * (0.62 + 0.08 * r());
      const sg = r() < 0.5 ? -1 : 1;
      const s1 = sg * (0.05 + 0.09 * r());
      const s2 = sg * (0.05 + 0.09 * r());
      this.cut.set([tA, bA, tB, bB, e0, e3, x1, x2, s1, s2], j * 10);
      this.fineX[j] = this.fineV[j] = this.fineT[j] = 0;
      this.fineAt[j] = Infinity;
      this.cutPane(j, 0, 0, 0);
      this.alignAmt[j] = 0;
      this.alignV[j] = 0;
      this.alignTgt[j] = 0;
      this.alignAt[j] = Infinity;
      this.busy[j] = -1;
    }
    for (let i = 0; i < N; i++) {
      const j = Math.floor(i / K);
      this.occ[i] = i;
      this.dockP[i] = j;
      this.dockS[i] = i % K;
      this.departAt[i] = Infinity;
      this.flying[i] = 0;
      // Panes start in one glass colour each; a few pieces already carry an earlier note's colour.
      const h = Math.floor(hash(j * 31 + Math.floor(dna[2] * 977)) * 4);
      this.hue[i] = this.hueTgt[i] = h;
      this.hueAt[i] = Infinity;
      this.shimAt[i] = -1e9;
      this.heatAt[i] = -1e9;
      const pre = hash(j * 7 + 3 + Math.floor(dna[3] * 911)) < 0.12;
      this.tint[i] = this.tintTgt[i] = pre ? 0.8 : 0;
      this.tintHue[i] = this.tintHueTgt[i] = hash(j * 13 + 5);
      this.hueV[i] = this.tintV[i] = this.tintHueV[i] = 0;
      this.heatNext[i] = this.shimNext[i] = Infinity;
      this.heatG[i] = this.heatH[i] = this.shimG[i] = this.shimH[i] = this.landG[i] = this.landH[i] = 0;
      this.heatLv[i] = this.shimLv[i] = this.hueLv[i] = this.landLv[i] = 0;
      this.tintAt[i] = -1e9;
      this.tintPendAt[i] = Infinity;
      this.seed[i] = r();
    }
    this.kSum = this.sSum = this.nSum = 0;
    this.dust.fill(0);
    this.dustHead = 0;
    this.emits.length = 0;
    this.graphAt = -1e9;
    this.clock = 0;
  }

  /**
   * Cuts pane j into its three pieces: the plate outline, and two slanted cracks slid along it by d1
   * and d2 and leaned by ds (the fine structure the high end re-forms). Writes slotC, slotO, crack.
   */
  private cutPane(j: number, d1: number, d2: number, ds: number): void {
    const c0 = j * 10;
    const [tA, bA, tB, bB, e0, e3] = this.cut.subarray(c0, c0 + 6);
    const L = 0.72;
    const top = (x: number) => tA + (tB - tA) * ((x + L) / (2 * L));
    const bot = (x: number) => bA + (bB - bA) * ((x + L) / (2 * L));
    const x1 = this.cut[c0 + 6] + d1;
    const x2 = this.cut[c0 + 7] + d2;
    const s1 = this.cut[c0 + 8] + ds;
    const s2 = this.cut[c0 + 9] - ds;
    const xt = [-L + e0, x1 + s1, x2 + s2, L];
    const xb = [-L - e0, x1 - s1, x2 - s2, L - Math.abs(e3)];
    {
      for (let s = 0; s < K; s++) {
        const c = [xb[s], -bot(xb[s]), xb[s + 1], -bot(xb[s + 1]), xt[s + 1], top(xt[s + 1]), xt[s], top(xt[s])];
        const cx = (c[0] + c[2] + c[4] + c[6]) / 4;
        const cy = (c[1] + c[3] + c[5] + c[7]) / 4;
        const o = (j * K + s) * 8;
        for (let q = 0; q < 4; q++) {
          this.slotC[o + q * 2] = c[q * 2] - cx;
          this.slotC[o + q * 2 + 1] = c[q * 2 + 1] - cy;
        }
        this.slotO[(j * K + s) * 2] = cx;
        this.slotO[(j * K + s) * 2 + 1] = cy;
      }
      for (let k = 0; k < 2; k++) {
        const o = j * 8 + k * 4;
        this.crack[o] = xb[k + 1];
        this.crack[o + 1] = -bot(xb[k + 1]);
        this.crack[o + 2] = xt[k + 1];
        this.crack[o + 3] = top(xt[k + 1]);
      }
    }
  }

  // ---------- formation ----------
  private formParams(): Form {
    // The step-free flow, plus the beats' steps on quick springs (from rest, settled in about a
    // third of a second): kicks and snares re-form the field along different coordinates, and each
    // melody note turns its swirl and twist a step.
    const fa = this.morph.flowAt;
    const a = this.formAt;
    for (let i = 0; i < a.length; i++) a[i] = fa[i];
    const kp = this.beatE[0];
    const sp = this.beatE[2];
    a[3] += 0.45 * kp;
    a[6] += 0.36 * kp;
    a[2] += 0.15 * sp;
    a[5] += 0.12 * sp;
    const np = this.noteE[0];
    const sharp = wave(a[1], 2.2, 7);
    const raw = [0, 1, 2, 3, 4].map((i) => Math.exp(sharp * (Math.cos(a[0] - (i * TAU) / 5) - 1)));
    const cut = raw.map((x) => (x / raw.reduce((s, y) => s + y, 0) < 0.03 ? 0 : x));
    const sum = cut.reduce((s, x) => s + x, 0);
    return {
      w: cut.map((x) => x / sum),
      squash: wave(a[2], 0.3, 1.0),
      swirl: wave(a[2] * 0.7 + 1.3 + 0.75 * np, -0.8, 0.8),
      twist: wave(a[3] + 0.5 * np, 0.6, 2.8),
      funnel: wave(a[3] * 0.6 + 2, -1.1, 1.1),
      vthick: wave(a[3] * 0.8 + 0.5, 0.4, 1.4),
      knot: wave(a[4], 0, 1),
      tubeR: wave(a[4] * 0.8 + 1, 0.85, 1.25),
      lattice: wave(a[4] * 0.6 + 2.2, 0.45, 0.95),
      gap: wave(a[5], 1.5, 2.5),
      amp: wave(a[5] * 0.7 + 0.4, 0.3, 1.3),
      freq: wave(a[5] * 0.5 + 2.1, 0.3, 0.6),
      tilt: wave(a[5] * 0.6 + 1, -0.5, 0.5),
      tgap: wave(a[2] * 0.5 + a[3] * 0.4, 0.25, 1.3),
      cone: wave(a[3] * 0.5 + a[4] * 0.4 + 1, 0.22, 0.55),
      spread: wave(a[6], 0.92, 1.15),
      size: wave(a[7], 0.85, 1.2),
      ph: a[5] * 0.5 + a[2] * 0.3,
      psi0: a[7] * 0.6 + a[1] * 0.3,
    };
  }

  /** Formation place and frame of pane j: pos, long axis T, normal N (formation space). */
  /** A unit normal perpendicular to unit T at angle ang round it, into this.pv. */
  private perp(a: number, b: number, c: number, ang: number): Float64Array {
    let ux = -c, uy = 0, uz = a;
    let l = Math.hypot(ux, uy, uz);
    if (l < 0.2) {
      ux = 0; uy = c; uz = -b;
      l = Math.hypot(ux, uy, uz) || 1;
    }
    ux /= l; uy /= l; uz /= l;
    const vx = b * uz - c * uy, vy = c * ux - a * uz, vz = a * uy - b * ux;
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const o = this.pv;
    o[0] = ux * cs + vx * sn;
    o[1] = uy * cs + vy * sn;
    o[2] = uz * cs + vz * sn;
    return o;
  }

  /** Adds k times a family's (position, long axis, normal) into the blend accumulator. */
  private acc(k: number, x: number, y: number, z: number, a: number, b: number, c: number, d: number, e: number, g: number): void {
    const o = this.acc9;
    o[0] += k * x; o[1] += k * y; o[2] += k * z;
    o[3] += k * a; o[4] += k * b; o[5] += k * c;
    o[6] += k * d; o[7] += k * e; o[8] += k * g;
  }

  /** The tube's centre line: a wide loop that rises and dips through the field, leaning toward a trefoil knot. */
  private knotAt(s: number, f: Form, o: Float64Array, k0: number): void {
    const k = f.knot * 0.65;
    o[k0] = (1 - k) * 3.6 * Math.cos(s) + k * 1.25 * (Math.sin(s) + 2 * Math.sin(2 * s));
    o[k0 + 1] = (1 - k) * 1.1 * Math.sin(2 * s + f.ph) + k * 1.25 * -Math.sin(3 * s);
    o[k0 + 2] = (1 - k) * 3.6 * Math.sin(s) + k * 1.25 * (Math.cos(s) - 2 * Math.cos(2 * s));
  }

  /** Formation place and frame of pane j: pos, long axis T, normal N (formation space). */
  private evalPane(j: number, f: Form, out: Float64Array): void {
    this.acc9.fill(0);
    const w = f.w;
    const wTube = w[2];
    const u = this.gu[j] + (this.ju[j] / NA) * (1 - wTube);
    const v = this.gv[j] + (this.jv[j] / NR) * (1 - wTube);
    const ww = this.pw[j];
    // Roll round the long axis: a smooth pattern over the formation (neighbours agree, so the field
    // reads as one sculpted flow), turning with the morph, plus a little individual scatter.
    const psi = this.psi[j] + 1.1 * Math.sin(TAU * this.gu[j] * 2 + this.gv[j] * 6 + f.ph) + f.psi0;
    if (w[0] > 0) {
      // Burst: shards radiating from the heart, squashed toward a disc, swirled.
      const z = 1 - 2 * Math.min(1, Math.max(0, v));
      const rr = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = TAU * u + v * 2.4;
      let dx = rr * Math.cos(phi), dy = z * f.squash, dz = rr * Math.sin(phi);
      const dl = v3len(dx, dy, dz);
      dx /= dl; dy /= dl; dz /= dl;
      const r = 1.0 + 9.0 * Math.pow(ww, 1.15);
      let ax = dx - f.swirl * dz * 0.6, ay = dy, az = dz + f.swirl * dx * 0.6;
      const al = v3len(ax, ay, az);
      ax /= al; ay /= al; az /= al;
      const n = this.perp(ax, ay, az, psi);
      this.acc(w[0], dx * r, dy * r, dz * r, ax, ay, az, n[0], n[1], n[2]);
    }
    if (w[1] > 0) {
      // Vortex: a swirling disc with a funnel at its heart.
      const r = 0.7 + 8.6 * Math.pow(ww, 0.6);
      const th = TAU * u + f.twist * Math.log(r) + f.ph;
      const y = (v - 0.5) * (0.5 + 0.22 * r) * f.vthick + f.funnel * (2.2 / (r + 0.6) - 0.45);
      const c = Math.cos(th), s = Math.sin(th);
      let ax = -s - 0.3 * c, ay = 0.12 * Math.sin(psi), az = c - 0.3 * s;
      const al = v3len(ax, ay, az);
      ax /= al; ay /= al; az /= al;
      // Lying in the disc, rocked round the flow by up to half a radian.
      const n = this.perp(ax, ay, az, Math.PI * 0.5 + Math.sin(psi) * 0.5);
      this.acc(w[1], r * c, y, r * s, ax, ay, az, n[0], n[1], n[2]);
    }
    if (wTube > 0) {
      // Lattice tube: a porous tube round the loop, its panes crossing at the lattice angle.
      const s = TAU * this.gv[j] + 0.2;
      const C = this.knot6;
      this.knotAt(s, f, C, 0);
      this.knotAt(s + 1e-3, f, C, 3);
      let gx = C[3] - C[0], gy = C[4] - C[1], gz = C[5] - C[2];
      const gl = v3len(gx, gy, gz);
      gx /= gl; gy /= gl; gz /= gl;
      let ux = gz, uy = 0, uz = -gx;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 0.15) { ux = 0; uy = -gz; uz = gy; ul = Math.hypot(ux, uy, uz) || 1; }
      ux /= ul; uy /= ul; uz /= ul;
      const vx = gy * uz - gz * uy, vy = gz * ux - gx * uz, vz = gx * uy - gy * ux;
      const phi = TAU * this.gu[j];
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const rx = ux * cp + vx * sp, ry = uy * cp + vy * sp, rz = uz * cp + vz * sp;
      const cx = -ux * sp + vx * cp, cy = -uy * sp + vy * cp, cz = -uz * sp + vz * cp;
      const b = f.lattice * this.plat[j];
      const cb = Math.cos(b), sb = Math.sin(b);
      const rad = f.tubeR * (1 + 0.06 * (ww - 0.5));
      this.acc(wTube, C[0] + rx * rad, C[1] + ry * rad, C[2] + rz * rad, gx * cb + cx * sb, gy * cb + cy * sb, gz * cb + cz * sb, rx, ry, rz);
    }
    if (w[3] > 0) {
      // Sheets: three folded layers of glass, stacked and tilted.
      const layer = Math.floor(ww * 3);
      const x = (u - Math.floor(u) - 0.5) * 15;
      const z = (v - 0.5) * 15;
      const k = f.freq;
      const ph = f.ph + layer * 1.7;
      const h = f.amp * Math.sin(k * x + ph) * Math.cos(k * 0.8 * z + ph * 0.6);
      const hx = f.amp * k * Math.cos(k * x + ph) * Math.cos(k * 0.8 * z + ph * 0.6);
      const hz = -f.amp * k * 0.8 * Math.sin(k * x + ph) * Math.sin(k * 0.8 * z + ph * 0.6);
      const y = (layer - 1) * f.gap + h + (ww * 3 - layer - 0.5) * 0.25;
      const ct = Math.cos(f.tilt), st = Math.sin(f.tilt);
      let nx0 = -hx, ny0 = 1, nz0 = -hz;
      const nl = v3len(nx0, ny0, nz0);
      nx0 /= nl; ny0 /= nl; nz0 /= nl;
      // Flow direction within the sheet: mostly along x, fanned by psi.
      const fa = Math.sin(psi) * 0.45;
      let ax = Math.cos(fa), ay = hx * Math.cos(fa) + hz * Math.sin(fa), az = Math.sin(fa);
      const dd = ax * nx0 + ay * ny0 + az * nz0;
      ax -= dd * nx0; ay -= dd * ny0; az -= dd * nz0;
      const al = v3len(ax, ay, az);
      ax /= al; ay /= al; az /= al;
      this.acc(w[3], x * ct - y * st, x * st + y * ct, z, ax * ct - ay * st, ax * st + ay * ct, az, nx0 * ct - ny0 * st, nx0 * st + ny0 * ct, nz0);
    }
    if (w[4] > 0) {
      // Tension: two clusters of spikes reaching for each other across a narrow gap.
      const side = ww < 0.5 ? -1 : 1;
      const w2 = ww < 0.5 ? ww * 2 : ww * 2 - 1;
      const h = 0.35 + 6.2 * Math.pow(w2, 1.15);
      const phi = TAU * u;
      const rad = h * f.cone * Math.sqrt(Math.min(1, Math.max(0, v)));
      const x = side * (f.tgap * 0.5 + h * 0.85);
      const y = rad * Math.cos(phi);
      const z = rad * Math.sin(phi);
      // Spikes point at the gap, leaning inward toward the axis.
      let ax = -side, ay = -y * 0.18, az = -z * 0.18;
      const al = v3len(ax, ay, az);
      ax /= al; ay /= al; az /= al;
      const n = this.perp(ax, ay, az, psi);
      this.acc(w[4], x, y, z, ax, ay, az, n[0], n[1], n[2]);
    }
    // Orthonormalise the blended frame.
    const A = this.acc9;
    let tx = A[3], ty = A[4], tz = A[5], nx = A[6], ny = A[7], nz = A[8];
    const tl = v3len(tx, ty, tz);
    tx /= tl; ty /= tl; tz /= tl;
    const d = nx * tx + ny * ty + nz * tz;
    nx -= d * tx; ny -= d * ty; nz -= d * tz;
    let nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-3) {
      const p = this.perp(tx, ty, tz, psi);
      nx = p[0]; ny = p[1]; nz = p[2];
      nl = 1;
    }
    nx /= nl; ny /= nl; nz /= nl;
    out[0] = A[0] * f.spread; out[1] = A[1] * f.spread; out[2] = A[2] * f.spread;
    out[3] = tx; out[4] = ty; out[5] = tz;
    out[6] = nx; out[7] = ny; out[8] = nz;
  }

  // ---------- events ----------
  /** Nearest-neighbour graph of the panes where they are now: the structure fronts travel along. */
  private buildGraph(spread: number): void {
    const maxD2 = (2.3 * spread) ** 2;
    const P = this.pPos;
    for (let i = 0; i < M; i++) {
      const o = i * KN;
      for (let k = 0; k < KN; k++) {
        this.nbr[o + k] = -1;
        this.nbrD[o + k] = 1e9;
      }
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      for (let j = 0; j < M; j++) {
        if (j === i) continue;
        const dx = P[j * 3] - x, dy = P[j * 3 + 1] - y, dz = P[j * 3 + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > maxD2 || d2 >= this.nbrD[o + KN - 1]) continue;
        let k = KN - 1;
        while (k > 0 && this.nbrD[o + k - 1] > d2) {
          this.nbrD[o + k] = this.nbrD[o + k - 1];
          this.nbr[o + k] = this.nbr[o + k - 1];
          k--;
        }
        this.nbrD[o + k] = d2;
        this.nbr[o + k] = j;
      }
      for (let k = 0; k < KN; k++) if (this.nbr[o + k] >= 0) this.nbrD[o + k] = Math.sqrt(this.nbrD[o + k]);
    }
    this.graphAt = this.clock;
  }

  /**
   * Arrival distance from an origin pane through the graph, links weighted by a per-event
   * conductivity, so the front is ragged and follows the structure. Returns the reached panes in
   * arrival order.
   */
  private spread(origin: number, reach: number, evSeed: number): number[] {
    this.cost.fill(Infinity);
    this.done.fill(0);
    this.parent.fill(-1);
    this.cost[origin] = 0;
    const open = [origin];
    const out: number[] = [];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (this.cost[open[i]] < this.cost[open[bi]]) bi = i;
      const u = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (this.done[u]) continue;
      this.done[u] = 1;
      out.push(u);
      for (let k = 0; k < KN; k++) {
        const v = this.nbr[u * KN + k];
        if (v < 0 || this.done[v]) continue;
        const a = Math.min(u, v), b = Math.max(u, v);
        const cond = 0.5 + 1.1 * hash(a * 7919 + b * 104729 + evSeed);
        const c = this.cost[u] + this.nbrD[u * KN + k] * cond;
        if (c < this.cost[v] && c <= reach) {
          if (this.cost[v] === Infinity) open.push(v);
          this.cost[v] = c;
          this.parent[v] = u;
        }
      }
    }
    return out;
  }

  /** The visible pane nearest a point in the frame (normalised device coordinates). */
  private pickPane(nx: number, ny: number): number {
    let best = 0;
    let bs = Infinity;
    const [ex, ey, ez] = this.eye;
    for (let j = 0; j < M; j++) {
      const x = this.pPos[j * 3] - ex, y = this.pPos[j * 3 + 1] - ey, z = this.pPos[j * 3 + 2] - ez;
      const dz = x * this.fwd[0] + y * this.fwd[1] + z * this.fwd[2];
      if (dz < 2.6) continue;
      const sx = (x * this.right[0] + y * this.right[1] + z * this.right[2]) / (dz * this.tanHalf * this.aspect);
      const sy = (x * this.up[0] + y * this.up[1] + z * this.up[2]) / (dz * this.tanHalf);
      const sc = (sx - nx) ** 2 + (sy - ny) ** 2 + 0.004 * (dz - 5) ** 2;
      if (sc < bs) {
        bs = sc;
        best = j;
      }
    }
    return best;
  }

  private ensureGraph(spread: number): void {
    if (this.clock - this.graphAt > 0.12) this.buildGraph(spread);
  }

  /** Kick: a fracture front. Reached panes crack, throw dust, and their pieces scatter into new panes. */
  private onKick(energy: number, spread: number, dustCol: Vec3, dustSize: number, dustAmt: number, lv: number): void {
    this.ensureGraph(spread);
    const n = this.kicks;
    const origin = this.pickPane(0.62 * Math.sin(n * 2.399 + 0.4), 0.5 * Math.sin(n * 1.731 + 1.9));
    // A faint kick fractures a small patch, a hard one a wide region.
    const reach = (2.0 + 1.6 * energy) * spread * (0.3 + 0.9 * lv);
    const speed = (14 + 6 * energy) * spread;
    const reached = this.spread(origin, reach, n * 977 + 13);
    const hit = reached.filter((j) => this.busy[j] < this.clock);
    const T = new Map<number, number>();
    for (const j of reached) T.set(j, Math.max(0, this.cost[j] - 1.8 * spread) / speed);
    // Front direction at each pane (from the pane that lit it).
    const dir = (j: number): Vec3 => {
      const p = this.parent[j];
      let dx, dy, dz;
      if (p < 0) {
        dx = this.rand() - 0.5; dy = this.rand() - 0.5; dz = this.rand() - 0.5;
      } else {
        dx = this.pPos[j * 3] - this.pPos[p * 3];
        dy = this.pPos[j * 3 + 1] - this.pPos[p * 3 + 1];
        dz = this.pPos[j * 3 + 2] - this.pPos[p * 3 + 2];
      }
      const l = v3len(dx, dy, dz);
      return [dx / l, dy / l, dz / l];
    };
    // Every pane reached and not still settling from an earlier fracture breaks; each of its pieces
    // is sent to a different pane of the region, a hop onward along the front.
    if (hit.length >= 2) {
      const dirs = hit.map(dir);
      const newOcc = new Map<number, number>();
      const tmp = [0, 0, 0];
      for (let s = 0; s < K; s++) {
        const free = new Set(hit);
        for (let h = 0; h < hit.length; h++) {
          const j = hit[h];
          const d = dirs[h];
          qRot(this.pQ, j * 4, this.slotO[(j * K + s) * 2], this.slotO[(j * K + s) * 2 + 1], 0, tmp, 0);
          const hop = 0.7 * spread;
          const tx = this.pPos[j * 3] + d[0] * hop + tmp[0] * 0.9;
          const ty = this.pPos[j * 3 + 1] + d[1] * hop + tmp[1] * 0.9;
          const tz = this.pPos[j * 3 + 2] + d[2] * hop + tmp[2] * 0.9;
          let best = -1;
          let bd = Infinity;
          // Nearest free pane to the hop target, preferring one lying at a similar angle, so the
          // pieces glide into place rather than flipping over.
          const qj = j * 4;
          for (const k of free) {
            if (k === j && free.size > 1) continue;
            const qk = k * 4;
            const qd = Math.abs(this.pQ[qj] * this.pQ[qk] + this.pQ[qj + 1] * this.pQ[qk + 1] + this.pQ[qj + 2] * this.pQ[qk + 2] + this.pQ[qj + 3] * this.pQ[qk + 3]);
            const dd = (this.pPos[k * 3] - tx) ** 2 + (this.pPos[k * 3 + 1] - ty) ** 2 + (this.pPos[k * 3 + 2] - tz) ** 2 + 3 * (1 - qd);
            if (dd < bd) {
              bd = dd;
              best = k;
            }
          }
          free.delete(best);
          const piece = this.occ[j * K + s];
          newOcc.set(best * K + s, piece);
          const t = this.clock + (T.get(j) ?? 0);
          this.departAt[piece] = t;
          this.nextP[piece] = best;
          this.nextS[piece] = s;
          this.frontDir[piece * 3] = d[0];
          this.frontDir[piece * 3 + 1] = d[1];
          this.frontDir[piece * 3 + 2] = d[2];
          this.heatAt[piece] = t;
          this.heatNext[piece] = t;
          this.heatLv[piece] = lv;
        }
      }
      for (const [slot, piece] of newOcc) this.occ[slot] = piece;
      for (let h = 0; h < hit.length; h++) {
        const j = hit[h];
        const t = this.clock + (T.get(j) ?? 0);
        this.busy[j] = t + 1.9;
        const d = dirs[h];
        this.emits.push({ t, pane: j, dx: d[0], dy: d[1], dz: d[2], n: Math.round(dustAmt * lv * (3 + 5 * this.rand())), col: mixCol(dustCol, QUARTET[Math.round(this.hue[this.occ[j * K]]) & 3], 0.45), size: dustSize });
        // The fracture undoes any order a melody gave the pane.
        this.alignPend[j * 4] = t;
        this.alignPend[j * 4 + 1] = -1;
      }
    }
    // Panes still settling are not broken again, but the front still runs through them and their cracks glow.
    for (const j of reached) {
      if (this.busy[j] >= this.clock && !hit.includes(j)) {
        const t = this.clock + (T.get(j) ?? 0);
        for (let s = 0; s < K; s++) {
          const piece = this.occ[j * K + s];
          if (!this.flying[piece] && this.departAt[piece] === Infinity) {
            this.heatAt[piece] = t;
            this.heatNext[piece] = t;
            this.heatLv[piece] = lv;
          }
        }
      }
    }
  }

  /** Snare: a fast shimmer front; every shard it reaches flashes with dispersion and steps colour. */
  private onSnare(energy: number, spread: number, lv: number): void {
    this.ensureGraph(spread);
    const n = this.snares;
    const origin = this.pickPane(0.6 * Math.sin(n * 1.913 + 2.7), 0.45 * Math.sin(n * 2.851 + 0.3));
    const reach = (3.4 + 2.6 * energy) * spread * (0.2 + 0.8 * lv);
    const speed = 14 * spread;
    const reached = this.spread(origin, reach, n * 6151 + 71);
    for (const j of reached) {
      const t = this.clock + Math.max(0, this.cost[j] - 2.2 * spread) / speed;
      for (let s = 0; s < K; s++) {
        const piece = this.occ[j * K + s];
        this.shimAt[piece] = t;
        this.shimNext[piece] = t;
        this.hueAt[piece] = t;
        this.shimLv[piece] = lv;
        // Alternate steps of one and two glass colours, as far as the snare was strong.
        this.hueLv[piece] = lv * (1 + (n & 1));
      }
    }
  }

  /** Melody: the note lands at a place set by its pitch; shards there take its colour and align. */
  private onNote(pitch: number, lv: number, spread: number): void {
    this.ensureGraph(spread);
    const n = this.notes;
    const origin = this.pickPane(0.55 * Math.sin(n * 2.399 + 1.1), Math.max(-0.75, Math.min(0.75, pitch * 0.85)));
    const reach = (4.4 + 1.6 * lv) * spread * (0.5 + 0.5 * lv);
    const speed = 9 * spread;
    const reached = this.spread(origin, reach, n * 3571 + 29);
    const pc = (((Math.round(pitch * 12) * 7) % 12) + 12) % 12;
    const hueP = pc / 12;
    // The aligned frame: long axis at an angle set by the pitch in the picture plane, facing the
    // viewer with a tilt that varies by note.
    const ang = pitch * 1.1 + 0.7 * Math.sin(n * 1.3);
    const [rx, ry, rz] = this.right;
    const [ux, uy, uz] = this.up;
    const [fx, fy, fz] = this.fwd;
    let tx = rx * Math.cos(ang) + ux * Math.sin(ang);
    let ty = ry * Math.cos(ang) + uy * Math.sin(ang);
    let tz = rz * Math.cos(ang) + uz * Math.sin(ang);
    const tl = v3len(tx, ty, tz);
    tx /= tl; ty /= tl; tz /= tl;
    const tilt = 0.6 * Math.sin(n * 0.77 + 0.5);
    let nx = -fx + (rx * -Math.sin(ang) + ux * Math.cos(ang)) * tilt;
    let ny = -fy + (ry * -Math.sin(ang) + uy * Math.cos(ang)) * tilt;
    let nz = -fz + (rz * -Math.sin(ang) + uz * Math.cos(ang)) * tilt;
    const d = nx * tx + ny * ty + nz * tz;
    nx -= d * tx; ny -= d * ty; nz -= d * tz;
    const nl = v3len(nx, ny, nz);
    nx /= nl; ny /= nl; nz /= nl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const q = new Float64Array(4);
    qFromBasis(tx, ty, tz, bx, by, bz, nx, ny, nz, q, 0);
    for (const j of reached) {
      const t = this.clock + Math.max(0, this.cost[j] - 1.8 * spread) / speed;
      this.alignPend[j * 4] = t;
      // The alignment holds as firmly as the note was strong (> 0 marks a note, not a fracture).
      this.alignPend[j * 4 + 1] = Math.max(lv, 1e-3);
      this.alignQPend.set(q, j * 4);
      for (let s = 0; s < K; s++) {
        const piece = this.occ[j * K + s];
        this.tintPendAt[piece] = t;
        this.tintPendHue[piece] = hueP;
        this.landLv[piece] = lv;
      }
    }
    const col = QUARTET[Math.round(hueP * 4) % 4];
    this.emits.push({ t: this.clock, pane: origin, dx: 0, dy: 0, dz: 0, n: Math.round(10 * lv), col, size: 0.012 });
  }

  /**
   * High melody (upper voice, arps): the note lands at a height set by its pitch and runs a short way
   * through the graph; every pane it reaches re-cuts its cracks a step (the pieces' own outlines slide
   * and lean), as far as the note was strong. Fine structure only: the formation is untouched.
   */
  private onUpper(pitch: number, lv: number, spread: number): void {
    this.ensureGraph(spread);
    const n = this.uppers;
    const origin = this.pickPane(0.6 * Math.sin(n * 2.111 + 0.7), Math.max(-0.75, Math.min(0.75, (pitch - 0.5) * 1.6)));
    // It runs through the whole field, strongest where it lands and fading with the distance run.
    const reach = 30 * spread;
    const speed = 80 * spread;
    for (const j of this.spread(origin, reach, n * 4241 + 7)) {
      this.fineAt[j] = this.clock + Math.max(0, this.cost[j] - 1.5 * spread) / speed;
      this.fineLv[j] += lv * Math.exp(-this.cost[j] / (7 * spread));
    }
  }

  // ---------- dust ----------
  private emitDust(e: { pane: number; dx: number; dy: number; dz: number; n: number; col: Vec3; size: number }): void {
    const j = e.pane;
    const sc = this.pScale[j];
    const r = this.rand;
    const tmp = [0, 0, 0];
    const nrm = [0, 0, 0];
    qRot(this.pQ, j * 4, 0, 0, 1, nrm, 0);
    for (let i = 0; i < e.n; i++) {
      // Along one of the pane's cracks.
      const k = r() < 0.5 ? 0 : 1;
      const t = r();
      const o = j * 8 + k * 4;
      const lx = this.crack[o] + (this.crack[o + 2] - this.crack[o]) * t;
      const ly = this.crack[o + 1] + (this.crack[o + 3] - this.crack[o + 1]) * t;
      qRot(this.pQ, j * 4, lx * sc, ly * sc, 0, tmp, 0);
      const d = this.dustHead * DF;
      this.dustHead = (this.dustHead + 1) % DUST_MAX;
      const sp = 0.25 + 0.9 * r();
      const side = r() < 0.5 ? -1 : 1;
      this.dust[d] = this.pPos[j * 3] + tmp[0];
      this.dust[d + 1] = this.pPos[j * 3 + 1] + tmp[1];
      this.dust[d + 2] = this.pPos[j * 3 + 2] + tmp[2];
      this.dust[d + 3] = e.size * (0.5 + r());
      this.dust[d + 4] = e.dx * sp + nrm[0] * side * 0.35 * r() + (r() - 0.5) * 0.35;
      this.dust[d + 5] = e.dy * sp + nrm[1] * side * 0.35 * r() + (r() - 0.5) * 0.35;
      this.dust[d + 6] = e.dz * sp + nrm[2] * side * 0.35 * r() + (r() - 0.5) * 0.35;
      this.dust[d + 7] = 0; // age: each glint fades in instead of popping on
      const bright = 0.6 + 1.2 * r();
      this.dust[d + 8] = e.col[0] * bright;
      this.dust[d + 9] = e.col[1] * bright;
      this.dust[d + 10] = e.col[2] * bright;
      this.dust[d + 11] = r();
      // Life is kept in the twinkle seed's integer part (seconds remaining * 1000 + seed).
      this.dust[d + 11] = Math.floor((1.4 + 2.2 * r()) * 1000) + r() * 0.999;
    }
  }

  private stepDust(dt: number): void {
    let n = 0;
    const t = this.clock;
    for (let i = 0; i < DUST_MAX; i++) {
      const d = i * DF;
      let life = Math.floor(this.dust[d + 11]) / 1000;
      if (life <= 0) continue;
      const sd = this.dust[d + 11] - Math.floor(this.dust[d + 11]);
      life -= dt;
      if (life <= 0) {
        this.dust[d + 11] = 0;
        continue;
      }
      this.dust[d + 11] = Math.floor(life * 1000) + sd;
      const x = this.dust[d], y = this.dust[d + 1], z = this.dust[d + 2];
      // A slow swirl carries the dust; drag settles the burst.
      const drag = Math.exp(-dt * 1.1);
      this.dust[d + 4] = this.dust[d + 4] * drag + dt * 0.22 * Math.sin(y * 1.3 + t * 0.21 + 1.1);
      this.dust[d + 5] = this.dust[d + 5] * drag + dt * 0.22 * Math.sin(z * 1.1 + t * 0.17 + 2.3);
      this.dust[d + 6] = this.dust[d + 6] * drag + dt * 0.22 * Math.sin(x * 1.2 + t * 0.19 + 0.4);
      this.dust[d] = x + this.dust[d + 4] * dt;
      this.dust[d + 1] = y + this.dust[d + 5] * dt;
      this.dust[d + 2] = z + this.dust[d + 6] * dt;
      this.dust[d + 7] += dt;
      const fade = Math.min(1, life / 1.0) * smooth(0, 0.25, this.dust[d + 7]);
      const o = n * DF;
      this.dData[o] = this.dust[d];
      this.dData[o + 1] = this.dust[d + 1];
      this.dData[o + 2] = this.dust[d + 2];
      this.dData[o + 3] = this.dust[d + 3];
      this.dData[o + 4] = this.dust[d + 4];
      this.dData[o + 5] = this.dust[d + 5];
      this.dData[o + 6] = this.dust[d + 6];
      this.dData[o + 7] = Math.max(0, fade);
      this.dData[o + 8] = this.dust[d + 8];
      this.dData[o + 9] = this.dust[d + 9];
      this.dData[o + 10] = this.dust[d + 10];
      this.dData[o + 11] = sd;
      n++;
    }
    this.dustCount = n;
  }

  // ---------- frame ----------
  update(ctx: SceneUpdateContext): void {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const morph = this.morph;
    morph.update(m, ctx.dt, g);
    const a = this.formAt;
    const seek = Math.abs(m.time - this.lastT - dt) > 0.5;
    this.lastT = m.time;
    if (seek || g[0] !== this.seedDna) {
      this.seedDna = g[0];
      this.reset(g, m.time);
      this.kicks = morph.kicks;
      this.snares = morph.snares;
      this.notes = morph.notes;
      this.uppers = morph.uppers;
      this.noteE[0] = 0;
      this.noteE[1] = 0;
      this.beatE[0] = 0;
      this.beatE[2] = 0;
      this.beatE[1] = this.beatE[3] = 0;
      this.rx.fill(0);
      this.rxV.fill(0);
      this.noteTurn = 0;
    }
    this.clock += dt;
    const clock = this.clock;
    // Summed strengths: the lasting steps below grow by each event's own (shaped) level.
    if (morph.kicks !== this.kicks) this.kSum += react(morph.kickLevel);
    if (morph.snares !== this.snares) this.sSum += react(morph.snareLevel) ** 1.5;
    if (morph.notes !== this.notes) this.nSum += react(morph.noteLevel);
    {
      const nv = new Float32Array(1);
      nv[0] = this.noteE[1];
      // The steps glide in a little slower than a beat's flash (half in by about 0.15 s), so each
      // re-forming reads as its own motion.
      const wN = 10;
      const wB = 11;
      springAt(this.noteE, nv, 0, this.nSum, wN, Math.exp(-wN * dt), dt);
      this.noteE[1] = nv[0];
      const e16 = Math.exp(-wB * dt);
      for (const [k, target] of [[0, this.kSum], [2, this.sSum]] as const) {
        nv[0] = this.beatE[k + 1];
        const x = this.beatE.subarray(k, k + 1);
        springAt(x, nv, 0, target, wB, e16, dt);
        this.beatE[k + 1] = nv[0];
      }
    }
    const f = this.formParams();

    // Camera: a steady orbit inside the field, looking across its heart, the framing drifting. It
    // follows the step-free flow, so beats re-form the glass, never jolt the view.
    const tr = morph.travel;
    const af = morph.flowAt;
    // The phrase framing (morph.cam) swings the lens between telephoto and wide as a dolly zoom: a
    // wide lens moves in among the glass, a long one stands back and flattens the formation. It
    // also lifts or lowers the orbit, turns and tilts the look (less when the lens is long, so the
    // heart stays in frame) and adds its roll.
    const cf = morph.cam;
    const fov = clamp(FOV * cf.fov, 0.55, 1.95);
    this.tanHalf = Math.tan(fov / 2);
    const zoomK = Math.min(1, fov / FOV);
    const th = g[1] * TAU + tr * 0.05;
    const Rc = 5.4 * wave(af[6], 0.92, 1.15) * wave(af[6] * 0.7 + 0.9, 0.92, 1.08) * Math.pow(fov / FOV, -0.38);
    const eye: Vec3 = [Rc * Math.cos(th), 1.3 * Math.sin(tr * 0.05 + g[4] * 6) + 0.4 * Math.sin(af[7] * 0.5) + 1.4 * cf.height, Rc * Math.sin(th)];
    const off = 0.9 * Math.sin(tr * 0.03 + g[6] * 6);
    const tgt: Vec3 = [-Math.sin(th) * off, 0.3 * Math.sin(tr * 0.07 + 1), Math.cos(th) * off];
    {
      // Turn the look about the eye: yaw round the vertical, pitch up or down.
      const yaw = 0.6 * cf.yaw * zoomK;
      const pit = 0.55 * cf.pitch * zoomK;
      let dx = tgt[0] - eye[0], dy = tgt[1] - eye[1], dz = tgt[2] - eye[2];
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      [dx, dz] = [dx * cy - dz * sy, dx * sy + dz * cy];
      const hl = Math.hypot(dx, dz);
      const el = Math.atan2(dy, hl) + pit;
      const dl = v3len(dx, dy, dz);
      tgt[0] = eye[0] + (dx / hl) * Math.cos(el) * dl;
      tgt[1] = eye[1] + Math.sin(el) * dl;
      tgt[2] = eye[2] + (dz / hl) * Math.cos(el) * dl;
    }
    const roll = (g[7] - 0.5) * 0.35 + 0.12 * Math.sin(tr * 0.06) + cf.roll;
    {
      let fx = tgt[0] - eye[0], fy = tgt[1] - eye[1], fz = tgt[2] - eye[2];
      const fl = v3len(fx, fy, fz);
      fx /= fl; fy /= fl; fz /= fl;
      const upx = Math.sin(roll), upy = Math.cos(roll);
      let rx = fy * 0 - fz * upy, ry = fz * upx - fx * 0, rz = fx * upy - fy * upx;
      const rl = v3len(rx, ry, rz);
      rx /= rl; ry /= rl; rz /= rl;
      this.right = [rx, ry, rz];
      this.up = [ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx];
      this.fwd = [fx, fy, fz];
      this.eye = eye;
    }

    // Formation: every pane's place and frame, then its slow drift and rocking, any alignment a
    // note gave it, and a smooth push away from the lens.
    const gx = Math.sin(g[5] * TAU) * 0.6, gz = Math.cos(g[5] * TAU) * 0.6;
    const gq = qAxis(gx / v3len(gx, 1, gz), 1 / v3len(gx, 1, gz), gz / v3len(gx, 1, gz), tr * 0.015 + a[6] * 0.25 + 0.22 * this.beatE[2] + g[0] * TAU);
    const tmp = this.tmp9;
    const qa = this.qa;
    const qb = this.qb;
    const td = tr * 0.5;
    const eAl = Math.exp(-13 * dt);
    const clear = 0.9;
    for (let j = 0; j < M; j++) {
      this.evalPane(j, f, tmp);
      const ph = j * 3;
      // Drift.
      // Drift and rocking are gentle, so the beats' changes stand out against them.
      const dr = 0.1;
      const x0 = tmp[0] + dr * Math.sin(td * 0.21 + this.pph[ph]);
      const y0 = tmp[1] + dr * Math.sin(td * 0.17 + this.pph[ph + 1]);
      const z0 = tmp[2] + dr * Math.sin(td * 0.19 + this.pph[ph + 2]);
      const P = this.v3a;
      qRot(gq, 0, x0, y0, z0, P, 0);
      const T = this.v3b;
      const Nn = this.v3c;
      qRot(gq, 0, tmp[3], tmp[4], tmp[5], T, 0);
      qRot(gq, 0, tmp[6], tmp[7], tmp[8], Nn, 0);
      const bx = Nn[1] * T[2] - Nn[2] * T[1], by = Nn[2] * T[0] - Nn[0] * T[2], bz = Nn[0] * T[1] - Nn[1] * T[0];
      qFromBasis(T[0], T[1], T[2], bx, by, bz, Nn[0], Nn[1], Nn[2], qa, 0);
      // Rock round the long axis and turn a little in the plane.
      // Rocking: a slow wave rolling through the whole field (glints sweep across it), plus a
      // little individual sway.
      const wph = 0.32 * tmp[0] + 0.21 * tmp[1] + 0.27 * tmp[2];
      const roll = 0.16 * Math.sin(td * 0.12 + wph) + 0.036 * Math.sin(td * this.pom[j] * 0.5 + this.pph[ph]) + 0.22 * (Math.sin(this.fineX[j] * 1.3 + this.pph[ph + 2]) - Math.sin(this.pph[ph + 2]));
      // Micro facet: a high note's re-cut also tips each pane it reached round its long axis and turns
      // it a little in its plane, so the glints re-form there (lasting, eased with the re-cut).
      const fu = this.fineX[j] * 1.7;
      const yaw = 0.048 * Math.sin(td * 0.09 + wph * 0.7 + 1.3) + 0.08 * (Math.sin(fu + this.pph[ph + 1]) - Math.sin(this.pph[ph + 1]));
      qMul(qa, 0, qAxisT(1, 0, 0, roll), 0, qb, 0);
      qMul(qb, 0, qAxisT(0, 0, 1, yaw), 0, qa, 0);
      // Alignment changes scheduled by a note (1) or a fracture (-1) take effect as fronts arrive.
      if (this.alignPend[j * 4] > 0 && clock >= this.alignPend[j * 4]) {
        const note = this.alignPend[j * 4 + 1] > 0;
        this.alignTgt[j] = note ? this.alignPend[j * 4 + 1] : 0;
        this.alignPend[j * 4] = 0;
        if (note) {
          // Turn from the frame it holds now (or straight into the new one if it held none).
          this.alignFrom.set(this.alignAmt[j] > 1e-3 ? this.alignCur.subarray(j * 4, j * 4 + 4) : this.alignQPend.subarray(j * 4, j * 4 + 4), j * 4);
          this.alignQ.set(this.alignQPend.subarray(j * 4, j * 4 + 4), j * 4);
          this.alignB[j] = 0;
          this.alignBV[j] = 0;
        }
      }
      springAt(this.alignB, this.alignBV, j, 1, 13, eAl, dt);
      qNlerp(this.alignFrom, j * 4, this.alignQ, j * 4, this.alignB[j], this.alignCur, j * 4);
      springAt(this.alignAmt, this.alignV, j, this.alignTgt[j], 13, eAl, dt);
      if (this.alignAmt[j] > 1e-3) {
        // Aligned shards still rock a little, so nothing ever freezes.
        qMul(this.alignCur, j * 4, qAxisT(1, 0, 0, roll * 0.25), 0, qb, 0);
        qNlerp(qa, 0, qb, 0, this.alignAmt[j], qa, 0);
      }
      this.pQ.set(qa, j * 4);
      // Clearance: a smooth monotonic push away from the lens (nothing comes closer than ~clear).
      let dx = P[0] - eye[0], dy = P[1] - eye[1], dz = P[2] - eye[2];
      const d = v3len(dx, dy, dz);
      const d2 = d + clear * Math.exp(-((d / clear) ** 2));
      dx /= d; dy /= d; dz /= d;
      this.pPos[j * 3] = eye[0] + dx * d2;
      this.pPos[j * 3 + 1] = eye[1] + dy * d2;
      this.pPos[j * 3 + 2] = eye[2] + dz * d2;
      const fam = f.w[0] * 1.0 + f.w[1] * 0.95 + f.w[2] * 0.62 + f.w[3] * 1.1 + f.w[4] * 1.0;
      this.pScale[j] = this.psz[j] * f.size * fam * 1.35;
    }

    // Fine structure: every pane's cracks slide and lean with the high end. detailAt flows them all
    // (each pane at its own phase), backing chords and hats lean them, and each high note re-cuts
    // the panes it reached a step further (eased on a spring). The pieces' outlines follow at once.
    {
      const da = morph.detailAt;
      const lean = 0.5 * morph.backingPhase + 0.35 * morph.hatPhase;
      const ef = Math.exp(-11 * dt);
      for (let j = 0; j < M; j++) {
        if (clock >= this.fineAt[j]) {
          this.fineT[j] += 8 * this.fineLv[j];
          this.fineLv[j] = 0;
          this.fineAt[j] = Infinity;
        }
        springAt(this.fineX, this.fineV, j, this.fineT[j], 11, ef, dt);
        const ph = this.pph[j * 3];
        const u = this.fineX[j] * 1.9;
        // A gentle flow with the high end, plus each high note's own lasting re-cut.
        const d1 = 0.025 * Math.sin(da[0] * 0.8 + ph) + 0.11 * (Math.sin(ph * 1.3 + u) - Math.sin(ph * 1.3));
        const d2 = 0.025 * Math.sin(da[1] * 0.8 + this.pph[j * 3 + 1]) + 0.11 * (Math.sin(ph * 0.7 - u * 1.3) - Math.sin(ph * 0.7));
        const ds = 0.02 * Math.sin(da[2] * 0.7 + this.pph[j * 3 + 2] + lean) + 0.012 * Math.sin(da[3] * 0.6 + ph * 1.7) + 0.05 * (Math.sin(ph * 2.1 + u * 0.9) - Math.sin(ph * 2.1));
        this.cutPane(j, d1, d2, ds);
      }
    }

    // Music: new events start their fronts.
    const energy = Math.min(1, Math.max(m.energy, m.energySlow * 0.8));
    const bands = m.bands;
    let low = 0, all = 0;
    for (let i = 0; i < bands.length; i++) {
      all += bands[i];
      if (i < bands.length / 4) low += bands[i];
    }
    all /= Math.max(1, bands.length);
    low /= Math.max(1, bands.length / 4);
    const cen = smooth(0.08, 0.5, m.centroid);
    const dustCol = hueTurn([1.0, 0.55 + 0.35 * cen, 0.15 + 0.85 * cen * cen] as Vec3, 0) as Vec3;
    const dustSize = 0.007 + 0.012 * Math.min(1, low * 1.5);
    const dustAmt = (0.5 + 1.6 * Math.min(1, all * 2.5)) * (0.7 + 0.6 * Math.min(1, m.flux * 2));
    // Each event's strength is captured as it
    // lands and carried by its own front.
    if (morph.kicks !== this.kicks) {
      this.kicks = morph.kicks;
      this.onKick(energy, f.spread, dustCol, dustSize, dustAmt, react(morph.kickLevel));
    }
    if (morph.snares !== this.snares) {
      this.snares = morph.snares;
      this.onSnare(energy, f.spread, react(morph.snareLevel));
    }
    if (morph.notes !== this.notes) {
      this.notes = morph.notes;
      this.onNote(morph.notePitch, react(morph.noteLevel), f.spread);
    }
    if (morph.uppers !== this.uppers) {
      this.uppers = morph.uppers;
      this.onUpper(morph.upperNote, react(morph.upperLevel), f.spread);
    }
    for (let i = this.emits.length - 1; i >= 0; i--) {
      if (clock >= this.emits[i].t) {
        this.emitDust(this.emits[i]);
        this.emits.splice(i, 1);
      }
    }

    // Pieces: scheduled changes, then where each one is (docked in its pane, or drifting to it).
    // Colour steps glide on springs (from rest, settled in about 0.4 s); light pulses swell in.
    const eh = Math.exp(-16 * dt);
    const et = Math.exp(-10 * dt);
    const eHw = Math.exp(-12 * dt), eHk = Math.exp(-4 * dt);
    const eSw = Math.exp(-14 * dt), eSk = Math.exp(-5 * dt);
    const eLw = Math.exp(-12 * dt), eLk = Math.exp(-5 * dt);
    const pos = this.v3a;
    const q2 = this.q2;
    for (let i = 0; i < N; i++) {
      if (clock >= this.hueAt[i]) {
        // Steps of one and two glass colours (scaled by the snare's strength): every shard still
        // visits all four over time.
        this.hueTgt[i] += this.hueLv[i];
        this.hueAt[i] = Infinity;
        this.tintTgt[i] *= 1 - 0.65 * this.shimLv[i];
      }
      if (clock >= this.tintPendAt[i]) {
        // The note's colour glides in (the shorter way round the quartet) instead of switching.
        let to = this.tintPendHue[i];
        to += Math.round(this.tintHueTgt[i] - to);
        this.tintHueTgt[i] = to;
        this.tintTgt[i] = 0.85 * this.landLv[i];
        this.tintAt[i] = this.tintPendAt[i];
        this.tintPendAt[i] = Infinity;
        this.landG[i] = Math.min(this.landG[i] + 1.5 * this.landLv[i], 2.8);
      }
      if (clock >= this.heatNext[i]) {
        this.heatG[i] = Math.min(this.heatG[i] + 0.9 * this.heatLv[i], 2.6);
        this.heatNext[i] = Infinity;
      }
      if (clock >= this.shimNext[i]) {
        this.shimG[i] = Math.min(this.shimG[i] + 0.95 * this.shimLv[i], 2.6);
        this.shimNext[i] = Infinity;
      }
      pulseAt(this.heatG, this.heatH, i, 12, 4, eHw, eHk);
      pulseAt(this.shimG, this.shimH, i, 14, 5, eSw, eSk);
      pulseAt(this.landG, this.landH, i, 12, 5, eLw, eLk);
      springAt(this.hue, this.hueV, i, this.hueTgt[i], 16, eh, dt);
      springAt(this.tint, this.tintV, i, this.tintTgt[i], 10, et, dt);
      springAt(this.tintHue, this.tintHueV, i, this.tintHueTgt[i], 16, eh, dt);
      if (clock >= this.departAt[i]) {
        // Split: remember where it was, then drift to its new pane (twisting as it snaps free).
        this.fromPos.set(this.oPos.subarray(i * 3, i * 3 + 3), i * 3);
        this.fromQ.set(this.oQ.subarray(i * 4, i * 4 + 4), i * 4);
        this.fromC.set(this.oC.subarray(i * 8, i * 8 + 8), i * 8);
        const j = this.dockP[i];
        const s = this.dockS[i];
        qRot(this.pQ, j * 4, this.slotO[(j * K + s) * 2], this.slotO[(j * K + s) * 2 + 1], 0, pos, 0);
        const pl = v3len(pos[0], pos[1], pos[2]);
        const r = this.rand;
        const sp = 0.2 + 0.18 * r();
        for (let k = 0; k < 3; k++) this.bulge[i * 3 + k] = (pos[k] / pl) * sp + this.frontDir[i * 3 + k] * 0.25 + (r() - 0.5) * 0.15;
        let ax = r() - 0.5, ay = r() - 0.5, az = r() - 0.5;
        const al = v3len(ax, ay, az);
        this.tumAx[i * 3] = ax / al;
        this.tumAx[i * 3 + 1] = ay / al;
        this.tumAx[i * 3 + 2] = az / al;
        this.tumAmt[i] = (0.35 + 0.45 * r()) * (r() < 0.5 ? -1 : 1);
        this.fStart[i] = this.departAt[i];
        this.fDur[i] = 8 + 3 * r(); // flight rate (1/s) of a critically damped glide
        this.flying[i] = 1;
        this.dockP[i] = this.nextP[i];
        this.dockS[i] = this.nextS[i];
        this.departAt[i] = Infinity;
      }
      const j = this.dockP[i];
      const s = this.dockS[i];
      const sc = this.pScale[j];
      const so = (j * K + s) * 2;
      qRot(this.pQ, j * 4, this.slotO[so] * sc, this.slotO[so + 1] * sc, 0, pos, 0);
      const px = this.pPos[j * 3] + pos[0], py = this.pPos[j * 3 + 1] + pos[1], pz = this.pPos[j * 3 + 2] + pos[2];
      const co = (j * K + s) * 8;
      if (this.flying[i]) {
        // The flight: a critically damped glide from rest into the new pane, most of it in the first
        // half second, then settling softly; the bulge swells out and back on the way.
        const fa = Math.max(0, clock - this.fStart[i]) * this.fDur[i];
        const e = 1 - (1 + fa) * Math.exp(-fa);
        const u = fa >= 9 ? 1 : 0;
        const b = 4 * e * (1 - e);
        // The split: pieces part along their cracks over the first half second (a critically damped
        // rise from rest, never a jump), then drift.
        const age = clock - this.fStart[i];
        const snap = (1 - (1 + 10 * age) * Math.exp(-10 * age)) * (1 - e) * 0.6;
        const bb = b + snap;
        this.oPos[i * 3] = this.fromPos[i * 3] + (px - this.fromPos[i * 3]) * e + this.bulge[i * 3] * bb;
        this.oPos[i * 3 + 1] = this.fromPos[i * 3 + 1] + (py - this.fromPos[i * 3 + 1]) * e + this.bulge[i * 3 + 1] * bb;
        this.oPos[i * 3 + 2] = this.fromPos[i * 3 + 2] + (pz - this.fromPos[i * 3 + 2]) * e + this.bulge[i * 3 + 2] * bb;
        qNlerp(this.fromQ, i * 4, this.pQ, j * 4, e, q2, 0);
        const tq = qAxisT(this.tumAx[i * 3], this.tumAx[i * 3 + 1], this.tumAx[i * 3 + 2], this.tumAmt[i] * snap * 0.9);
        qMul(q2, 0, tq, 0, this.oQ, i * 4);
        for (let k = 0; k < 8; k++) this.oC[i * 8 + k] = this.fromC[i * 8 + k] + (this.slotC[co + k] * sc - this.fromC[i * 8 + k]) * e;
        if (u >= 1) this.flying[i] = 0;
      } else {
        this.oPos[i * 3] = px;
        this.oPos[i * 3 + 1] = py;
        this.oPos[i * 3 + 2] = pz;
        for (let k = 0; k < 4; k++) this.oQ[i * 4 + k] = this.pQ[j * 4 + k];
        for (let k = 0; k < 8; k++) this.oC[i * 8 + k] = this.slotC[co + k] * sc;
      }
      this.oScale[i] = sc;
    }

    this.stepDust(dt);

    // Back-to-front order (insertion sort on last frame's order: nearly sorted already).
    const [fx, fy, fz] = this.fwd;
    for (let i = 0; i < N; i++) this.key[i] = (this.oPos[i * 3] - eye[0]) * fx + (this.oPos[i * 3 + 1] - eye[1]) * fy + (this.oPos[i * 3 + 2] - eye[2]) * fz;
    const ord = this.order;
    for (let i = 1; i < N; i++) {
      const v = ord[i];
      const kv = this.key[v];
      let k = i - 1;
      while (k >= 0 && this.key[ord[k]] < kv) {
        ord[k + 1] = ord[k];
        k--;
      }
      ord[k + 1] = v;
    }
    const D = this.pData;
    for (let o = 0; o < N; o++) {
      const i = ord[o];
      const b = o * PF;
      const dx = this.oPos[i * 3] - eye[0], dy = this.oPos[i * 3 + 1] - eye[1], dz = this.oPos[i * 3 + 2] - eye[2];
      const dist = Math.hypot(dx, dy, dz);
      D[b] = this.oPos[i * 3];
      D[b + 1] = this.oPos[i * 3 + 1];
      D[b + 2] = this.oPos[i * 3 + 2];
      D[b + 3] = 0.022 * this.oScale[i];
      for (let k = 0; k < 4; k++) D[b + 4 + k] = this.oQ[i * 4 + k];
      for (let k = 0; k < 8; k++) D[b + 8 + k] = this.oC[i * 8 + k];
      // Each shard's glass shade shifts by its own small amount as the high end re-cuts its pane.
      const fq = this.seed[i] * TAU;
      D[b + 16] = this.hue[i] + 0.22 * (Math.sin(this.fineX[this.dockP[i]] * 1.5 + fq) - Math.sin(fq));
      D[b + 17] = Math.min(30, clock - this.heatAt[i]);
      D[b + 18] = Math.min(30, clock - this.shimAt[i]);
      D[b + 19] = Math.min(30, clock - this.tintAt[i]);
      D[b + 20] = this.tintHue[i];
      D[b + 21] = this.tint[i];
      D[b + 22] = smooth(2.1, 3.4, dist) * (1 - smooth(19, 24, dist));
      const s = this.dockS[i];
      D[b + 23] = (s < K - 1 ? 1 : 0) + (s > 0 ? 2 : 0);
      D[b + 24] = this.seed[i];
      D[b + 25] = this.alignAmt[this.dockP[i]];
      D[b + 26] = this.flying[i];
      D[b + 27] = this.oScale[i];
      D[b + 28] = Math.min(this.heatH[i], 1.4);
      D[b + 29] = Math.min(this.shimH[i], 1.4);
      D[b + 30] = Math.min(this.landH[i], 1.4);
      D[b + 31] = this.fineX[this.dockP[i]];
    }

    // Uniforms.
    const vp = lookAtPerspective(eye, tgt, fov, this.aspect, Z_NEAR, Z_FAR, roll);
    const U = this.U;
    U.set(vp, 0);
    U.set([eye[0], eye[1], eye[2], this.tanHalf], 16);
    U.set([...this.right, this.aspect], 20);
    U.set([...this.up, clock], 24);
    U.set([...this.fwd, 0.018 + 0.012 * g[2]], 28);
    // Chords turn the glass hues a little; the cue's DNA sets where they start.
    const ch = m.chord && m.chord.root >= 0 ? (((m.chord.root * 7) % 12) / 12) * TAU : 0;
    const tgtTurn = (g[3] - 0.5) * 0.3 + 0.12 * Math.sin(ch);
    this.hueTurnAmt += (tgtTurn - this.hueTurnAmt) * (1 - Math.exp(-dt / 1.5));
    // Lasting reactions, each gliding in from rest on a critically damped spring (half in by about
    // 0.3 s): kicks turn every shard's glass colour a step round the wheel, snares swing the key
    // light round the formation, notes turn the studio's soft boxes to a colour set by the pitch.
    {
      // A note turns the soft boxes toward its colour as far as it was strong.
      if (morph.leadAge === 0 && dt > 0) this.noteTurn += (Math.max(-1, Math.min(1, morph.notePitch)) * 2 + (morph.notes & 1 ? 0.5 : -0.5) - this.noteTurn) * react(morph.noteLevel);
      const W = 5.5;
      const e = Math.exp(-W * dt);
      const tg = [this.kSum * 1.7, this.sSum * 1.2, this.noteTurn];
      // The key light swings more slowly (half in by about half a second), so even a snare out of
      // quiet turns the glints round as a glide.
      for (let k = 0; k < 3; k++) springAt(this.rx, this.rxV, k, tg[k], k === 1 ? 3.2 : W, k === 1 ? Math.exp(-3.2 * dt) : e, dt);
    }
    const kickTurn = this.rx[0];
    for (let i = 0; i < 4; i++) U.set([...hueTurn(QUARTET[i], this.hueTurnAmt + kickTurn), 1], 32 + i * 4);
    U.set([0.0016, 0.0013, 0.003, 0.12], 48);
    // Key light from upper left behind the viewer; back light from behind the formation.
    const ka = this.rx[1];
    const kx = -0.55 * Math.cos(ka) - 0.45 * Math.sin(ka);
    const kz = -0.45 * Math.cos(ka) + 0.55 * Math.sin(ka);
    const key = norm3(add3(scale3(this.right, kx), add3(scale3(this.up, 0.7), scale3(this.fwd, kz))));
    U.set([...key, 0.13], 52);
    const back = norm3(add3(scale3(this.fwd, 1), add3(scale3(this.up, 0.25), scale3(this.right, 0.2))));
    U.set([...back, 0.62], 56);
    U.set([Math.ceil(this.lastW / 2), Math.ceil(this.lastH / 2), this.lastW, this.lastH], 60);
    U.set([0, 0, 0, energy], 64);
    for (let i = 0; i < 3; i++) U.set([...hueTurn(QUARTET[[0, 1, 2][i]], this.hueTurnAmt + 0.15 + kickTurn + this.rx[2]), 1], 68 + i * 4);
    this.device.queue.writeBuffer(this.uBuf, 0, U);
    this.device.queue.writeBuffer(this.pBuf, 0, this.pData);
    if (this.dustCount) this.device.queue.writeBuffer(this.dBuf, 0, this.dData, 0, this.dustCount * DF);
    this.device.queue.writeBuffer(this.paramBuffer, 0, this.params);
  }

  private lastW = 1280;
  private lastH = 720;

  private ensureTargets(w: number, h: number): void {
    if (this.near && this.lastW === w && this.lastH === h && this.msaa) return;
    this.lastW = w;
    this.lastH = h;
    this.near?.destroy();
    this.bg?.destroy();
    this.msaa?.destroy();
    this.msDepth?.destroy();
    const hw = Math.ceil(w / 2);
    const hh = Math.ceil(h / 2);
    const d = this.device;
    this.near = d.createTexture({ label: 'gs-near', size: [hw, hh], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.bg = d.createTexture({ label: 'gs-bg', size: [hw, hh], format: HDR_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.msaa = d.createTexture({ label: 'gs-msaa', size: [w, h], format: HDR_FORMAT, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.msDepth = d.createTexture({ label: 'gs-msdepth', size: [w, h], format: 'depth24plus', sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.g2a = d.createBindGroup({ layout: this.layouts.g2a, entries: [{ binding: 0, resource: this.near.createView() }] });
    this.g2b = d.createBindGroup({ layout: this.layouts.g2b, entries: [{ binding: 1, resource: this.bg.createView() }] });
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    const resized = this.lastW !== width || this.lastH !== height;
    this.aspect = width / height;
    this.ensureTargets(width, height);
    if (resized) {
      // Half/full resolution changed after this frame's uniforms were written.
      this.U.set([Math.ceil(width / 2), Math.ceil(height / 2), width, height], 60);
      this.device.queue.writeBuffer(this.uBuf, 0, this.U);
    }
    const P = this.pipes;
    // 1. Nearest glass depth (half resolution).
    const p0 = encoder.beginRenderPass({
      label: 'gs-near',
      colorAttachments: [],
      depthStencilAttachment: { view: this.near!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    p0.setBindGroup(0, this.group0);
    p0.setBindGroup(1, this.group1);
    p0.setPipeline(P.nearDepth);
    p0.draw(36, N);
    p0.end();
    // 2. What lies behind the nearest glass: backdrop, the other glass back to front, dust.
    const p1 = encoder.beginRenderPass({
      label: 'gs-behind',
      colorAttachments: [{ view: this.bg!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    p1.setBindGroup(0, this.group0);
    p1.setBindGroup(1, this.group1);
    p1.setBindGroup(2, this.g2a!);
    p1.setPipeline(P.bg);
    p1.draw(3);
    p1.setPipeline(P.behind);
    p1.draw(36, N);
    if (this.dustCount) {
      p1.setPipeline(P.dustBehind);
      p1.draw(6, this.dustCount);
    }
    p1.end();
    // 3. The nearest glass refracting it (full resolution, 4x MSAA), and the dust in front.
    const p2 = encoder.beginRenderPass({
      label: 'gs-front',
      colorAttachments: [{ view: this.msaa!.createView(), resolveTarget: target, loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: this.msDepth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    p2.setBindGroup(0, this.group0);
    p2.setBindGroup(1, this.group1);
    p2.setBindGroup(2, this.g2b!);
    p2.setPipeline(P.copy);
    p2.draw(3);
    p2.setPipeline(P.frontPre);
    p2.draw(36, N);
    p2.setPipeline(P.front);
    p2.draw(36, N);
    if (this.dustCount) {
      p2.setPipeline(P.dustFront);
      p2.draw(6, this.dustCount);
    }
    p2.end();
  }

  destroy(): void {
    this.paramBuffer.destroy();
    this.uBuf.destroy();
    this.pBuf.destroy();
    this.dBuf.destroy();
    this.near?.destroy();
    this.bg?.destroy();
    this.msaa?.destroy();
    this.msDepth?.destroy();
  }
}

const mixCol = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm3 = (a: Vec3): Vec3 => scale3(a, 1 / v3len(a[0], a[1], a[2]));
const factory: SceneFactory = {
  meta: META,
  async create(device: GPUDevice, shared: SharedResources) {
    const code = `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${WGSL}`;
    const module = await compileModule(device, code, META.id);
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const g1 = device.createBindGroupLayout({
      label: 'gs-g1',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VF, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VF, buffer: { type: 'read-only-storage' } },
      ],
    });
    const g2a = device.createBindGroupLayout({ label: 'gs-g2a', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } }] });
    const g2b = device.createBindGroupLayout({ label: 'gs-g2b', entries: [{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    const L01 = device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, g1] });
    const L1 = device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, g1, g2a] });
    const L2 = device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, g1, g2b] });
    const prim: GPUPrimitiveState = { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' };
    const premult: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    const add: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
    const ms = { count: SAMPLES };
    const dsNone: GPUDepthStencilState = { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };
    const [nearDepth, bg, behind, dustBehind, copy, frontPre, front, dustFront] = await Promise.all([
      device.createRenderPipelineAsync({
        label: 'gs-nearDepth',
        layout: L01,
        vertex: { module, entryPoint: 'vsPiece' },
        primitive: prim,
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      }),
      device.createRenderPipelineAsync({
        label: 'gs-bg',
        layout: L1,
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fsBg', targets: [{ format: HDR_FORMAT }] },
      }),
      device.createRenderPipelineAsync({
        label: 'gs-behind',
        layout: L1,
        vertex: { module, entryPoint: 'vsPiece' },
        fragment: { module, entryPoint: 'fsBehind', targets: [{ format: HDR_FORMAT, blend: premult }] },
        primitive: prim,
      }),
      device.createRenderPipelineAsync({
        label: 'gs-dustBehind',
        layout: L1,
        vertex: { module, entryPoint: 'vsDust' },
        fragment: { module, entryPoint: 'fsDustBehind', targets: [{ format: HDR_FORMAT, blend: add }] },
      }),
      device.createRenderPipelineAsync({
        label: 'gs-copy',
        layout: L2,
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fsCopy', targets: [{ format: HDR_FORMAT }] },
        depthStencil: dsNone,
        multisample: ms,
      }),
      device.createRenderPipelineAsync({
        label: 'gs-frontPre',
        layout: L2,
        vertex: { module, entryPoint: 'vsPiece' },
        fragment: { module, entryPoint: 'fsNull', targets: [{ format: HDR_FORMAT, writeMask: 0 }] },
        primitive: prim,
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        multisample: ms,
      }),
      device.createRenderPipelineAsync({
        label: 'gs-front',
        layout: L2,
        vertex: { module, entryPoint: 'vsPiece' },
        fragment: { module, entryPoint: 'fsNear', targets: [{ format: HDR_FORMAT }] },
        primitive: prim,
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'equal' },
        multisample: ms,
      }),
      device.createRenderPipelineAsync({
        label: 'gs-dustFront',
        layout: L2,
        vertex: { module, entryPoint: 'vsDust' },
        fragment: { module, entryPoint: 'fsDustFront', targets: [{ format: HDR_FORMAT, blend: add }] },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
        multisample: ms,
      }),
    ]);
    return new GlassShards(device, shared, { nearDepth, bg, behind, dustBehind, copy, frontPre, front, dustFront }, { g1, g2a, g2b });
  },
};

export default factory;
