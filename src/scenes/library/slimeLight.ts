import { compileModule } from '../../gpu/context';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { Morph, wave } from '../morph';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Slime Light: a physarum transport network (Jones 2010) of a million or more agents, drawn as
 * glossy neon filaments on black with a nebula of their own light around them.
 *
 * Each agent senses the trail ahead, ahead-left and ahead-right, turns toward the strongest, steps,
 * and deposits its colour; the trail diffuses and decays. Agents drift with a slow current, so the
 * network flows while it reorganises. Its sensor angle, sensor reach, turn angle, step and decay
 * come from the morph, so the network's character keeps travelling (kicks and snares step it for
 * good).
 *
 * Music:
 *  - sound makes matter: a ring buffer respawns agents at an emitter placed by the melody's pitch,
 *    at a rate set by the spectral flux and energy (each note swells it open), coloured by the
 *    pitch and spectral centroid, spread by the bass; the new strands grow out into the network.
 *  - melody steers: every agent leans gently toward a heading set by the melody's contour, so a
 *    phrase combs the network in its direction.
 *  - beats ignite: a burn field (an excitable medium, Greenberg-Hastings style) conducts only along
 *    the filaments. A kick lights the network at a new point (the lit patch spreads out over a
 *    third of a second): a white to orange fire runs along the strands, branching where they branch,
 *    and every agent it passes eases to the kick's next colour, which it then carries through the
 *    network. A snare lights a line of sparks in a second colour whose front switches the agents it
 *    crosses to a new behaviour (a finer, wider or curlier network grows behind it). A note lights
 *    its own colour at the emitter. Each kick also turns the whole network's colour a step round the
 *    wheel, gliding in from rest.
 *
 * Resolution: the trail matches the render target's pixels (cover-fitted 16:9, 1280x720 up to
 * 2560x1440), and the agent count, sensor reach and step grow with it, so the network keeps its
 * shape on screen while its strands stay a few pixels wide. A resize carries the network across
 * (trail resampled, agents scaled and duplicated in place). The burn grid stays 640x360: it is
 * shaded at its own resolution and the shaded fire is filtered (B-spline), then masked by the
 * full-resolution filaments.
 *
 * Flow: the simulation and burn step at fixed rates (deterministic offline), and the render blends
 * between each one's last two steps by the time since, so motion is continuous at any frame rate.
 * Any jump of more than 0.5 s (or a new cue) resets.
 */

/** The trail at its smallest (and the reference the morph's texel-sized parameters are tuned at). */
const TW0 = 1280;
const TH0 = 720;
const TH_MAX = 1440;
const BW = 640;
const BH = 360;
const GW = 320;
const GH = 180;
const ASPECT = TW0 / TH0;
/** Agents at the reference size; the count grows with the trail's area. */
const N0 = 1 << 20;
const N_MAX = 1 << 22;
/** Fixed-point scale of the integer deposits. */
const FIX = 256;
const SIM_HZ = 90;
const BURN_HZ = 200;
const UVEC = 20;
const IGN = 6;
/** Seconds over which an ignition's patch spreads to full size, and how long it stays lit. */
const IGN_RISE = 0.25;
const IGN_HOLD = 0.36;
const TAU = Math.PI * 2;
const fract = (x: number) => x - Math.floor(x);

/** One step of a critically damped spring (value, velocity) toward a target. */
function react(r: Float64Array, target: number, w: number, dt: number): void {
  const e = Math.exp(-w * dt);
  const d = r[0] - target;
  const c = r[1] + w * d;
  r[0] = target + (d + c * dt) * e;
  r[1] = (r[1] - w * c * dt) * e;
}

const META: SceneMeta = {
  id: 'slime-light',
  name: 'Slime Light',
  energy: [0, 1],
  mood: { valence: 0.5, arousal: 0.55 },
  genres: { ambient: 0.8, edm: 0.9, techno: 1, synthwave: 0.8, dnb: 0.8, dubstep: 0.7, pop: 0.6, lofi: 0.7, jazz: 0.6, classical: 0.6, hiphop: 0.7, rock: 0.5 },
  trails: 0,
  kaleido: false,
  sparse: true,
  // Kept out of the automatic rotation: its snares and notes don't register on the beat gate (the network's own motion swamps them).
  auto: false,
};

/*
 * Uniform layout (vec4 slots of U):
 *  0 step dt, reset, spawn start, spawn count     1 sensor angle, sensor reach (texels), turn, step (texels)
 *  2 decay, deposit, pool turn, gyre strength      3 gyre wavenumber, phase x, phase y, steer strength
 *  4 steer cos, steer sin, emitter x, emitter y    5 emitter radius, emitter hue, seed, init layout
 *  6-11 ignitions (x, y, radius, stamp; radius 0 = none)   12-13 ignition kinds (6)
 *  14 burn step dt, heat tau, refractory tau, fuel 15 base hue, exposure, gloss, snare hue
 *  16 behaviour of new agents, colour ease per step, kick colour turn, -
 *  17 trail width, height, agent count, -          18 trail blend, burn blend, -, -
 *  19 resize: previous agent count, position scale, -, -
 */
const HEAD = /* wgsl */ `
const BW: i32 = ${BW};
const BH: i32 = ${BH};
const ASPECT: f32 = ${ASPECT};
const FIX: f32 = ${FIX}.0;
@group(1) @binding(0) var<uniform> U: array<vec4f, ${UVEC}>;
// hn: the colour the agent shows, easing toward its hue (so a front recolours it smoothly).
struct Agent { pos: vec2f, ang: f32, info: u32, hn: f32 }

fn sl_size() -> vec2f { return U[17].xy; }
fn sl_tw() -> i32 { return i32(U[17].x); }
fn sl_th() -> i32 { return i32(U[17].y); }
fn sl_n() -> u32 { return u32(U[17].z); }
fn sl_chroma(c: vec3f) -> f32 {
  let hi = max(c.r, max(c.g, c.b));
  return (hi - min(c.r, min(c.g, c.b))) / max(hi, 1e-4);
}
fn sl_hrot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}
// Saturated ink normalised to its brightest channel, cycling the palette's coloured entries.
fn sl_ink(h: f32) -> vec3f {
  let c0 = F.pal1.rgb;
  let c1 = F.pal2.rgb;
  let c2 = F.pal3.rgb;
  let s0 = sl_chroma(c0);
  let s1 = sl_chroma(c1);
  let s2 = sl_chroma(c2);
  var best = c0;
  var sb = s0;
  if (s1 > sb) { best = c1; sb = s1; }
  if (s2 > sb) { best = c2; }
  let k0 = mix(sl_hrot(best, 2.1), c0, smoothstep(0.15, 0.35, s0));
  let k1 = mix(sl_hrot(best, -2.1), c1, smoothstep(0.15, 0.35, s1));
  let k2a = mix(sl_hrot(best, 1.0), c2, smoothstep(0.15, 0.35, s2));
  // The third ink is the accent: if the palette's hues all sit close together (a warm or a cold
  // scheme), it turns well away round the circle, so every frame has a contrasting hue.
  let ch0 = k0 - dot(k0, vec3f(0.3333));
  let ch1 = k1 - dot(k1, vec3f(0.3333));
  let ch2 = k2a - dot(k2a, vec3f(0.3333));
  let near = max(dot(ch0, ch2) / max(length(ch0) * length(ch2), 1e-4), dot(ch1, ch2) / max(length(ch1) * length(ch2), 1e-4));
  let k2 = mix(k2a, max(sl_hrot(k0, 2.4), vec3f(0.0)), smoothstep(0.3, 0.8, near));
  let x = fract(h) * 3.0;
  let f = smoothstep(0.0, 1.0, fract(x));
  let c = max(select(select(mix(k2, k0, f), mix(k1, k2, f), x < 2.0), mix(k0, k1, f), x < 1.0), vec3f(0.0));
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  return (c - lo) / max(hi - lo, 1e-4);
}
// Agent info: hue (16 bits), id of the last kick front it took (12 bits), behaviour (2 bits).
fn sl_pack(hue: f32, beh: u32, kid: u32) -> u32 { return (u32(fract(hue) * 65535.0) << 16u) | ((kid & 4095u) << 4u) | (beh & 3u); }
fn sl_kid(info: u32) -> u32 { return (info >> 4u) & 4095u; }
fn sl_hue(info: u32) -> f32 { return f32(info >> 16u) / 65535.0; }
fn sl_wrap(p: vec2f) -> vec2f {
  let s = sl_size();
  return p - s * floor(p / s);
}
// A slow current in texels per second: a turn of the whole pool and a cellular gyre.
fn sl_current(p: vec2f) -> vec2f {
  let th = U[17].y;
  let q = p / th;
  let dc = q - vec2f(ASPECT * 0.5, 0.5);
  let ax = U[3].x * q.x + U[3].y;
  let ay = U[3].x * q.y + U[3].z;
  let gyre = vec2f(sin(ax) * cos(ay), -cos(ax) * sin(ay));
  return (U[2].z * vec2f(-dc.y, dc.x) + U[2].w * gyre) * th;
}
// Cubic B-spline filtering from four bilinear taps (smooth when magnified, never stair-steps).
fn sl_bspline(t: texture_2d<f32>, uv: vec2f) -> vec4f {
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
`;

const INIT = /* wgsl */ `
@group(1) @binding(1) var<storage, read_write> agents: array<Agent>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= sl_n()) { return; }
  let r = hashU3(i * 3u + u32(U[5].z * 65536.0));
  let size = sl_size();
  let lay = U[5].w;
  var pos = r.xy * size;
  var ang = r.z * TAU;
  if (lay > 0.5) {
    // Combed streams: everyone heading roughly one way, so the network opens as flowing strands.
    ang = U[5].z * TAU + (r.z - 0.5) * 0.5 + sin(pos.y / size.y * 9.0) * 0.4;
  }
  // Three inks laid out in broad regions.
  let hue = U[15].x + floor(fract(pos.x / size.x * 1.7 + pos.y / size.y * 0.8 + U[5].z) * 3.0) / 3.0;
  agents[i] = Agent(sl_wrap(pos), ang, sl_pack(hue, 0u, 4095u), fract(hue));
}`;

const SPAWN = /* wgsl */ `
@group(1) @binding(1) var<storage, read_write> agents: array<Agent>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= u32(U[0].w)) { return; }
  let i = (u32(U[0].z) + k) % sl_n();
  let r = hashU3(i * 7u + u32(U[0].z) * 13u + 101u);
  let a = r.x * TAU;
  let rad = sqrt(r.y) * U[5].x * U[17].y;
  let e = U[4].zw * U[17].y;
  let hue = U[5].y + (r.z - 0.5) * 0.08;
  agents[i] = Agent(sl_wrap(e + vec2f(cos(a), sin(a)) * rad), a, sl_pack(hue, u32(U[16].x), 4095u), fract(hue));
}`;

/** Carries the agents to a new trail size: positions scaled, extra agents duplicated in place. */
const GROW = /* wgsl */ `
@group(1) @binding(1) var<storage, read> src: array<Agent>;
@group(1) @binding(2) var<storage, read_write> agents: array<Agent>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= sl_n()) { return; }
  let n0 = u32(U[19].x);
  var a = src[i % n0];
  a.pos *= U[19].y;
  if (i >= n0) {
    let r = hashU3(i * 11u + 7u);
    a.pos += (r.xy - 0.5) * 2.0;
    a.ang += (r.z - 0.5) * 0.6;
  }
  a.pos = sl_wrap(a.pos);
  agents[i] = a;
}`;

const AGENTS = /* wgsl */ `
@group(1) @binding(1) var<storage, read_write> agents: array<Agent>;
@group(1) @binding(2) var trailTex: texture_2d<f32>;
@group(1) @binding(3) var burnTex: texture_2d<f32>;
@group(1) @binding(4) var<storage, read_write> dep: array<atomic<u32>>;
fn sense(p: vec2f) -> f32 {
  let t = vec2i(sl_wrap(p));
  return textureLoad(trailTex, t, 0).a;
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= sl_n()) { return; }
  var a = agents[i];
  var beh = a.info & 3u;
  var hue = sl_hue(a.info);
  var kid = sl_kid(a.info);
  // Behaviours a snare front switches agents between: the morph's own, long straight reach, and
  // tight curls.
  let bm = select(select(vec3f(1.0, 1.0, 1.0), vec3f(0.5, 1.8, 0.6), beh == 1u), vec3f(1.7, 0.55, 1.4), beh == 2u);
  let sa = U[1].x * bm.x;
  let so = U[1].y * bm.y;
  let ra = U[1].z * bm.z;
  let fwd = sense(a.pos + vec2f(cos(a.ang), sin(a.ang)) * so);
  let lft = sense(a.pos + vec2f(cos(a.ang + sa), sin(a.ang + sa)) * so);
  let rgt = sense(a.pos + vec2f(cos(a.ang - sa), sin(a.ang - sa)) * so);
  let rnd = hashU((i * 2654435761u) ^ bitcast<u32>(a.pos.x) ^ (bitcast<u32>(a.pos.y) * 1597334677u));
  var ang = a.ang;
  if (fwd > lft && fwd > rgt) {
  } else if (fwd < lft && fwd < rgt) {
    ang += select(-ra, ra, rnd > 0.5);
  } else if (lft > rgt) {
    ang += ra * (0.7 + 0.3 * rnd);
  } else if (rgt > lft) {
    ang -= ra * (0.7 + 0.3 * rnd);
  } else {
    ang += (rnd - 0.5) * ra;
  }
  // The melody's heading combs the network gently.
  ang += U[3].w * (U[4].x * sin(-ang) + U[4].y * cos(ang)) ;
  let h = U[0].x;
  var pos = a.pos + vec2f(cos(ang), sin(ang)) * U[1].w + sl_current(a.pos) * h;
  pos = sl_wrap(pos);
  // A front passing through changes the agent for good: a kick turns its colour one ink further
  // round (once per kick), a snare switches its behaviour, a note gives it the note's colour.
  let bp = pos / sl_size() * vec2f(f32(BW), f32(BH));
  let B = textureLoad(burnTex, clamp(vec2i(bp), vec2i(0), vec2i(BW - 1, BH - 1)), 0);
  if (B.x > 0.55) {
    let kind = floor(B.w);
    if (kind == 0.0) {
      let k = u32(B.z) & 4095u;
      if (k != kid) { hue = fract(hue + 0.3333); kid = k; }
    } else if (kind == 1.0) { beh = u32(B.z) % 3u; } else { hue = B.z; }
  }
  // The colour it shows eases to its hue the short way round (about a quarter second).
  let dh = fract(hue - a.hn + 0.5) - 0.5;
  let hn = fract(a.hn + dh * U[16].y);
  agents[i] = Agent(pos, ang, sl_pack(hue, beh, kid), hn);
  let col = sl_ink(hn);
  let d = U[2].y;
  let tw = sl_tw();
  let ti = min(vec2i(pos), vec2i(tw - 1, sl_th() - 1));
  let idx = u32(ti.y * tw + ti.x) * 4u;
  atomicAdd(&dep[idx], u32(col.r * d));
  atomicAdd(&dep[idx + 1u], u32(col.g * d));
  atomicAdd(&dep[idx + 2u], u32(col.b * d));
  atomicAdd(&dep[idx + 3u], u32(d));
}`;

const DIFFUSE = /* wgsl */ `
@group(1) @binding(1) var trailIn: texture_2d<f32>;
@group(1) @binding(2) var<storage, read_write> dep: array<atomic<u32>>;
@group(1) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;
var<private> TS: vec2i;
fn tAt(i: vec2i) -> vec4f {
  let w = vec2i((i.x + TS.x) % TS.x, (i.y + TS.y) % TS.y);
  return textureLoad(trailIn, w, 0);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  TS = vec2i(sl_tw(), sl_th());
  let i = vec2i(id.xy);
  if (i.x >= TS.x || i.y >= TS.y) { return; }
  let idx = u32(i.y * TS.x + i.x) * 4u;
  let d = vec4f(f32(atomicExchange(&dep[idx], 0u)), f32(atomicExchange(&dep[idx + 1u], 0u)),
    f32(atomicExchange(&dep[idx + 2u], 0u)), f32(atomicExchange(&dep[idx + 3u], 0u))) / FIX;
  if (U[0].y > 0.5) { textureStore(outTex, i, vec4f(0.0)); return; }
  var s = vec4f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      s += tAt(i + vec2i(x, y));
    }
  }
  s = mix(tAt(i), s / 9.0, 0.4);
  textureStore(outTex, i, min(s * (1.0 - U[2].x) + d, vec4f(6e4)));
}`;

/** Resamples a trail into a new size (bilinear: densities per texel are kept). */
const RESAMPLE = /* wgsl */ `
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let od = vec2i(textureDimensions(outTex));
  let i = vec2i(id.xy);
  if (i.x >= od.x || i.y >= od.y) { return; }
  textureStore(outTex, i, textureSampleLevel(srcTex, sampClamp, (vec2f(i) + 0.5) / vec2f(od), 0.0));
}`;

/**
 * The burn: an excitable medium (Greenberg-Hastings with continuous heat and refractory states)
 * conducted only by the network. x heat, y refractory, z stamp (hue, or behaviour for the snare),
 * w kind + strength (kind 0 kick, 1 snare, 2 note; strength fades per hop so each front has a
 * reach). Fronts jump up to two cells per step.
 */
const BURN = /* wgsl */ `
@group(1) @binding(1) var bIn: texture_2d<f32>;
@group(1) @binding(2) var trailTex: texture_2d<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;
fn bAt(i: vec2i) -> vec4f { return textureLoad(bIn, clamp(i, vec2i(0), vec2i(BW - 1, BH - 1)), 0); }
// The network's density over the cell's footprint, whatever the trail's resolution.
fn fuelAt(i: vec2i) -> f32 {
  let uv = (vec2f(i) + 0.5) / vec2f(f32(BW), f32(BH));
  let o = 0.25 / vec2f(f32(BW), f32(BH));
  return 0.25 * (textureSampleLevel(trailTex, sampClamp, uv + o, 0.0).a + textureSampleLevel(trailTex, sampClamp, uv - o, 0.0).a
    + textureSampleLevel(trailTex, sampClamp, uv + vec2f(o.x, -o.y), 0.0).a + textureSampleLevel(trailTex, sampClamp, uv + vec2f(-o.x, o.y), 0.0).a);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= BW || i.y >= BH) { return; }
  if (U[0].y > 0.5) { textureStore(outTex, i, vec4f(0.0)); return; }
  let fuel = smoothstep(U[14].w * 0.5, U[14].w * 1.5, fuelAt(i));
  let s = bAt(i);
  var best = vec4f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let n = bAt(i + vec2i(x, y));
      let h = n.x * select(1.0, 0.85, x != 0 && y != 0);
      if (h > best.x) { best = vec4f(h, n.yzw); }
    }
  }
  for (var k = 0; k < 8; k++) {
    let o = vec2i(round(vec2f(cos(f32(k) * 0.785398), sin(f32(k) * 0.785398)) * 2.0));
    let n = bAt(i + o);
    if (n.x > best.x) { best = n; }
  }
  let h = U[14].x;
  var o = vec4f(s.x * exp(-h / U[14].y), s.y * exp(-h / U[14].z), s.zw);
  let ready = s.x < 0.1 && s.y < 0.25;
  let kind = floor(best.w);
  let strength = fract(best.w) * select(0.985, 0.982, kind > 1.5);
  if (ready && best.x > 0.4 && fuel > 0.3 && strength > 0.25) { o = vec4f(1.0, 1.0, best.z, kind + strength); }
  let p = (vec2f(i) + 0.5) / f32(BH);
  for (var j = 0; j < ${IGN}; j++) {
    let I = U[6 + j];
    let kd = U[12 + j / 4][j % 4];
    // Only fresh cells catch, so the growing patch lights as a spreading ring, not a held blob.
    if (I.z > 0.0 && ready && fuel > 0.35 && length(p - I.xy) < I.z) { o = vec4f(1.0, 1.0, I.w, kd + 0.99); }
  }
  textureStore(outTex, i, o);
}`;

/**
 * The fire's colour at the burn grid's resolution, blended between the burn's last two steps. The
 * render filters this (B-spline), so neither the kind of a front nor its heat ever shows the grid.
 */
const SHADE = /* wgsl */ `
@group(1) @binding(1) var bCur: texture_2d<f32>;
@group(1) @binding(2) var bPrev: texture_2d<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;
fn fireOf(B: vec4f) -> vec3f {
  let hx = sat(B.x);
  let kd = floor(B.w);
  let ember = sat(B.y - hx);
  if (kd < 0.5) {
    return vec3f(1.0, 0.35 + 0.6 * hx, 0.08 + 0.8 * hx * hx) * (2.2 * hx * hx + 0.4 * hx) + vec3f(1.0, 0.3, 0.05) * ember * ember * 0.55;
  } else if (kd < 1.5) {
    return mix(sl_ink(U[15].w), vec3f(1.0), hx * hx) * (2.6 * hx * hx + 0.3 * hx) + sl_ink(U[15].w) * ember * ember * 0.3;
  }
  return mix(sl_ink(B.z), vec3f(1.0), 0.35 * hx) * (2.6 * hx * hx + 0.4 * hx) + sl_ink(B.z) * ember * ember * 0.3;
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= BW || i.y >= BH) { return; }
  let c = mix(fireOf(textureLoad(bPrev, i, 0)), fireOf(textureLoad(bCur, i, 0)), U[18].y);
  textureStore(outTex, i, vec4f(c, 1.0));
}`;

/** The nebula: the network's light blurred down to a quarter of the reference resolution. */
const GLOW = /* wgsl */ `
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= ${GW} || i.y >= ${GH}) { return; }
  let uv = (vec2f(i) + 0.5) / vec2f(${GW}.0, ${GH}.0);
  let px = 3.0 / vec2f(${TW0}.0, ${TH0}.0);
  var acc = vec4f(0.0);
  var ws = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let o = vec2f(f32(x), f32(y));
      let w = exp(-dot(o, o) * 0.3);
      acc += textureSampleLevel(srcTex, sampClamp, uv + o * px, 0.0) * w;
      ws += w;
    }
  }
  textureStore(outTex, i, acc / ws);
}`;

const RENDER = /* wgsl */ `
@group(1) @binding(1) var trailTex: texture_2d<f32>;
@group(1) @binding(2) var trailPrev: texture_2d<f32>;
@group(1) @binding(3) var fireTex: texture_2d<f32>;
@group(1) @binding(4) var glowTex: texture_2d<f32>;
${FULLSCREEN_VS}
fn vivid(c: vec3f) -> vec3f {
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let n = (c - lo) / max(hi - lo, 1e-4);
  return mix(c, n * hi, smoothstep(0.03, 0.15, (hi - lo) / max(hi, 1e-4)));
}
fn density(a: f32) -> f32 { return 1.0 - exp(-a * U[15].y); }
// The trail between its last two steps.
fn trailAt(uv: vec2f) -> vec4f { return mix(sl_bspline(trailPrev, uv), sl_bspline(trailTex, uv), U[18].x); }
fn densAt(uv: vec2f) -> f32 {
  let a = mix(textureSampleLevel(trailPrev, sampClamp, uv, 0.0).a, textureSampleLevel(trailTex, sampClamp, uv, 0.0).a, U[18].x);
  return density(a);
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  var s = vec2f(1.0);
  if (F.aspect > ASPECT) { s.y = ASPECT / F.aspect; } else { s.x = F.aspect / ASPECT; }
  let suv = 0.5 + (in.uv - 0.5) * s;
  let T = trailAt(suv);
  // Each kick turns the whole network's colour a step round the wheel, for good, gliding in from rest.
  let col = max(sl_hrot(vivid(max(T.rgb, vec3f(0.0)) / max(T.a, 1e-3)), U[16].z), vec3f(0.0));
  let I = density(max(T.a, 0.0));
  // Glossy relief: the density as a height, lit from above-left; filaments read as glass tubes.
  let e = 1.0 / sl_size();
  let hx = densAt(suv + vec2f(e.x, 0.0)) - densAt(suv - vec2f(e.x, 0.0));
  let hy = densAt(suv + vec2f(0.0, e.y)) - densAt(suv - vec2f(0.0, e.y));
  let N = normalize(vec3f(-hx * U[15].z, -hy * U[15].z, 1.0));
  let L = normalize(vec3f(-0.5, -0.6, 0.65));
  let Hv = normalize(L + vec3f(0.0, 0.0, 1.0));
  let ndh = max(dot(N, Hv), 0.0);
  let slope = 1.0 - N.z;
  let film = 0.5 + 0.5 * cos(TAU * (slope * 3.0 + vec3f(0.0, 0.33, 0.67)));
  var c = col * pow(I, 1.6) * 0.75;
  c += mix(col, vec3f(1.0), 0.3) * pow(I, 8.0) * 0.45;
  c += film * smoothstep(0.05, 0.4, slope) * I * 0.35;
  c += vec3f(1.0) * pow(ndh, 60.0) * I * 0.9;
  // The nebula of the network's own light, and a deep floor.
  let G = sl_bspline(glowTex, suv);
  let gc = max(sl_hrot(vivid(max(G.rgb, vec3f(0.0)) / max(G.a, 1e-3)), U[16].z), vec3f(0.0));
  c += gc * pow(density(G.a), 2.0) * 0.08;
  let vig = 1.0 - 0.45 * dot(in.uv - 0.5, in.uv - 0.5) * 2.0;
  c += palL(U[15].x + 0.6, 0.004);
  c *= vig;
  // The burn: hot edges and embers, only on the filaments (masked at full resolution).
  let fire = max(sl_bspline(fireTex, suv).rgb, vec3f(0.0));
  c += fire * smoothstep(0.02, 0.3, I);
  // The fire's light spilling round the strands it runs along (a soft ring of taps on the fire).
  let bt = 3.0 / vec2f(f32(BW), f32(BH));
  var halo = vec3f(0.0);
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.785398 + 0.39;
    halo += textureSampleLevel(fireTex, sampClamp, suv + vec2f(cos(a), sin(a)) * bt, 0.0).rgb;
  }
  c += max(halo, vec3f(0.0)) * (0.3 / 8.0);
  return vec4f(c, 1.0);
}`;

type Ignition = { x: number; y: number; r: number; stamp: number; kind: number; born: number };

type Name = 'init' | 'spawn' | 'grow' | 'agents' | 'diffuse' | 'resample' | 'burn' | 'shade' | 'glow';
type Pipes = Record<Name, GPUComputePipeline> & { render: GPURenderPipeline };
type Layouts = Record<Name | 'render', GPUBindGroupLayout>;
type Res = GPUTexture | GPUBuffer;
type Bind = (l: GPUBindGroupLayout, ...rs: Res[]) => GPUBindGroup;

/** Trail size for a render target: its pixels, cover-fitted 16:9, quantised to steps of 72 rows. */
function trailSize(width: number, height: number): [number, number] {
  const cover = Math.max(height, (width * TH0) / TW0);
  const th = Math.min(TH_MAX, Math.max(TH0, Math.round(cover / 72) * 72));
  return [Math.round((th * TW0) / TH0), th];
}

/** Everything sized by the render target: trail (ping-pong), agents, deposits and their groups. */
class Grids {
  readonly trail: GPUTexture[];
  readonly agents: GPUBuffer;
  readonly dep: GPUBuffer;
  readonly n: number;
  /** Trail texels per reference texel. */
  readonly r: number;
  readonly groups: {
    init: GPUBindGroup;
    /** [trail parity * 2 + burn parity] */
    agents: GPUBindGroup[];
    diffuse: GPUBindGroup[];
    /** [burn parity * 2 + trail parity] */
    burn: GPUBindGroup[];
    glow: GPUBindGroup[];
    render: GPUBindGroup[];
  };

  constructor(
    device: GPUDevice,
    L: Layouts,
    bind: Bind,
    burn: GPUTexture[],
    fire: GPUTexture,
    glow: GPUTexture,
    readonly tw: number,
    readonly th: number,
  ) {
    this.r = th / TH0;
    // More agents for more texels (area), capped; each deposits less so the strands keep their
    // density (see the deposit in update()).
    this.n = Math.min(N_MAX, Math.round((N0 * this.r * this.r) / 256) * 256);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    this.trail = [0, 1].map((k) => device.createTexture({ label: `slime-light-trail${k}`, size: [tw, th], format: 'rgba16float', usage }));
    this.agents = device.createBuffer({ label: 'slime-light-agents', size: this.n * 24, usage: GPUBufferUsage.STORAGE });
    this.dep = device.createBuffer({ label: 'slime-light-deposit', size: tw * th * 16, usage: GPUBufferUsage.STORAGE });
    const T = this.trail;
    this.groups = {
      init: bind(L.init, this.agents),
      agents: [0, 1, 2, 3].map((k) => bind(L.agents, this.agents, T[k >> 1], burn[k & 1], this.dep)),
      diffuse: [0, 1].map((t) => bind(L.diffuse, T[t], this.dep, T[t ^ 1])),
      burn: [0, 1, 2, 3].map((k) => bind(L.burn, burn[k >> 1], T[k & 1], burn[(k >> 1) ^ 1])),
      glow: [0, 1].map((t) => bind(L.glow, T[t], glow)),
      render: [0, 1].map((t) => bind(L.render, T[t], T[t ^ 1], fire, glow)),
    };
  }

  destroy(): void {
    for (const r of [...this.trail, this.agents, this.dep]) r.destroy();
  }
}

class SlimeInstance implements SceneInstance {
  readonly meta = META;
  private readonly u = new Float32Array(UVEC * 4);
  private readonly morph = new Morph(1);
  private lastT = -1;
  private seed = -1;
  private reset = true;
  private simAcc = 0;
  private simSteps = 0;
  private burnAcc = 0;
  private burnSteps = 0;
  /** Which trail and burn textures hold the current state (ping-pong, kept across frames). */
  private tCur = 0;
  private bCur = 0;
  private cursor = 0;
  private spawnAcc = 0;
  private spawnCount = 0;
  private emit = 0;
  private hue = 0;
  private steer = 0;
  private steerTarget = 0;
  private behaviour = 0;
  private clock = 0;
  /** The kicks' colour turn (value, velocity), eased. */
  private readonly kickTurn = new Float64Array(2);
  private ignitions: Ignition[] = [];
  private grids: Grids;
  private retired: Grids[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly group0: GPUBindGroup,
    private readonly paramBuffer: GPUBuffer,
    private readonly uBuffer: GPUBuffer,
    private readonly pipes: Pipes,
    private readonly layouts: Layouts,
    private readonly bind: Bind,
    private readonly burn: GPUTexture[],
    private readonly fire: GPUTexture,
    private readonly glow: GPUTexture,
    private readonly shadeGroups: GPUBindGroup[],
    private readonly owned: Res[],
  ) {
    this.grids = this.makeGrids(TW0, TH0);
  }

  private makeGrids(tw: number, th: number): Grids {
    return new Grids(this.device, this.layouts, this.bind, this.burn, this.fire, this.glow, tw, th);
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
    const root = m.chord && m.chord.root >= 0 ? m.chord.root : 0;
    const hueTarget = g[3] + ((root * 7) % 12) / 12 / 3;
    if (seek) {
      this.reset = true;
      this.simAcc = this.burnAcc = this.spawnAcc = 0;
      this.cursor = 0;
      this.emit = 0;
      this.hue = hueTarget;
      this.steer = this.steerTarget = g[5] * TAU;
      this.behaviour = 0;
      this.clock = 0;
      this.ignitions = [];
      this.kickTurn.fill(0);
    }
    this.clock += dt;
    this.hue += (hueTarget - this.hue) * (1 - Math.exp(-dt / 2));
    const live = !seek && dt > 0;
    const e = m.energySlow;

    // The emitter: placed along an arc by the melody's pitch.
    const pitch = Math.max(-1.2, Math.min(1.2, m.leadPitch));
    const cx = ASPECT * 0.5 + 0.25 * Math.sin(at[0] * 0.7 + g[4] * 6);
    const cy = 0.5 + 0.12 * Math.sin(at[1] * 0.6);
    const th0 = g[4] * TAU + at[2] * 0.3;
    const th = th0 + pitch * 1.3;
    const ex = cx + Math.cos(th) * 0.55;
    const ey = cy + Math.sin(th) * 0.3;
    const emitHue = fract(this.hue + 0.33 + pitch * 0.25 + (m.centroid - 0.5) * 0.4 + mo.notes * 0.11);

    // Ignitions are born a frame old; their patches spread out over IGN_RISE.
    const born = this.clock - dt;
    if (live && mo.leadAge === 0) {
      // Each note turns the network's heading by its interval and lights its colour at the emitter.
      this.steerTarget = th0 + pitch * 1.6 + (g[6] > 0.5 ? Math.PI : 0);
      this.ignitions.push({ x: ex, y: ey, r: 0.14, stamp: emitHue, kind: 2, born });
    }
    if (live && mo.kickAge === 0) {
      const k = mo.kicks;
      const ka = th0 + 2.39996 * k;
      const kr = Math.sqrt(((k * 0.618034) % 1) * 0.75 + 0.15);
      const x = ASPECT * 0.5 + Math.cos(ka) * kr * (ASPECT * 0.5 - 0.12);
      const y = 0.5 + Math.sin(ka) * kr * 0.4;
      this.ignitions.push({ x, y, r: 0.1 + 0.03 * e, stamp: k % 4095, kind: 0, born });
    }
    if (live && mo.snareAge === 0) {
      // A line of sparks across the network at a new angle; agents it reaches change behaviour.
      const n = mo.snares;
      this.behaviour = (this.behaviour + 1 + (n % 2)) % 3;
      const sa = th0 + 1.94 * n;
      const px = ASPECT * 0.5 + 0.3 * Math.sin(n * 2.7);
      const py = 0.5 + 0.15 * Math.cos(n * 1.9);
      for (let j = -1; j <= 1; j++) {
        this.ignitions.push({ x: px + Math.cos(sa) * 0.35 * j, y: py + Math.sin(sa) * 0.22 * j, r: 0.07, stamp: this.behaviour, kind: 1, born });
      }
    }
    this.ignitions = this.ignitions.filter((s) => this.clock - s.born < IGN_HOLD).slice(-IGN);
    this.steer += (this.steerTarget - this.steer) * (1 - Math.exp(-dt / 0.8));

    // Sound makes matter: the flux and energy set the spawn rate; each note swells the emitter open
    // (peaking ~0.15 s after the onset), never a jump.
    const la = mo.leadAge / 0.15;
    const attack = la * Math.exp(1 - la);
    const emitTarget = Math.min(1, 1.3 * m.flux + 0.35 * m.energy + 0.8 * attack) * mo.flow;
    this.emit += (emitTarget - this.emit) * (1 - Math.exp(-dt / (emitTarget > this.emit ? 0.15 : 0.4)));
    this.spawnAcc += dt * (1500 + 45000 * this.emit) * (this.grids.n / N0);
    this.spawnCount = live ? Math.min(80000, Math.floor(this.spawnAcc)) : 0;
    this.spawnAcc -= Math.floor(this.spawnAcc);

    const u = this.u;
    u.fill(0);
    const flow = mo.flow;
    const h = 1 / SIM_HZ;
    u[0] = h;
    u[1] = this.reset ? 1 : 0;
    // Network character from the morph.
    u[4] = wave(at[0], 0.3, 0.85); // sensor angle
    u[6] = wave(at[2], 0.25, 0.65); // turn
    u[8] = wave(at[3], 0.05, 0.14); // decay
    u[10] = (0.04 + 0.05 * Math.sin(at[5] * 0.5 + g[2] * TAU)) * flow; // pool turn
    u[11] = 0.025 * flow; // gyre
    u[12] = TAU / wave(at[6], 0.7, 1.4);
    u[13] = at[6] * 0.5 + g[1] * TAU;
    u[14] = at[7] * 0.5 + g[2] * TAU;
    u[15] = 0.012 + 0.02 * Math.min(1, m.leadHeld + attack); // steer strength
    u[16] = Math.cos(this.steer);
    u[17] = Math.sin(this.steer);
    u[18] = ex;
    u[19] = ey;
    u[20] = 0.01 + 0.025 * Math.min(1, m.bass);
    u[21] = emitHue;
    u[22] = g[0];
    u[23] = g[7];
    for (let j = 0; j < IGN; j++) {
      const s = this.ignitions[j];
      if (!s) continue;
      const x = Math.min(1, (this.clock - s.born) / IGN_RISE);
      u[24 + j * 4] = s.x;
      u[25 + j * 4] = s.y;
      u[26 + j * 4] = s.r * (0.3 + 0.7 * x * x * (3 - 2 * x));
      u[27 + j * 4] = s.stamp;
      u[48 + j] = s.kind;
    }
    u[56] = 1 / BURN_HZ;
    u[57] = 0.03; // heat
    u[58] = 0.9; // refractory
    u[59] = 10; // fuel threshold (trail density)
    u[60] = this.hue;
    u[61] = 0.035; // exposure (density gain)
    u[62] = 9; // gloss
    u[63] = fract(this.hue + 0.5);
    u[64] = this.behaviour;
    u[65] = 1 - Math.exp(-h / 0.08); // colour ease per step

    // Each kick turns the whole network's colour a step round the wheel for good, gliding in from
    // rest (half in by about 0.3 s). Kept moderate so the palette survives; larger turns flip it.
    react(this.kickTurn, mo.kicks * 1.2, 5.5, dt);
    u[66] = this.kickTurn[0];
    this.reach = g[1];
    this.energy = e;
    this.morphSize();

    this.simAcc += dt * SIM_HZ;
    this.simSteps = Math.min(6, Math.floor(this.simAcc));
    this.simAcc -= Math.floor(this.simAcc);
    this.burnAcc += dt * BURN_HZ;
    this.burnSteps = Math.min(10, Math.floor(this.burnAcc));
    this.burnAcc -= Math.floor(this.burnAcc);
    if (this.reset) {
      // Both halves of each ping-pong are cleared, so the blend never shows the previous cue.
      this.simSteps = Math.max(2, this.simSteps);
      this.burnSteps = Math.max(2, this.burnSteps);
    }
    u[72] = this.simAcc;
    u[73] = this.burnAcc;
    u[2] = this.cursor;
    u[3] = this.spawnCount;
    this.cursor = (this.cursor + this.spawnCount) % this.grids.n;
    this.device.queue.writeBuffer(this.uBuffer, 0, u);
  }

  /** The parameters that depend on the trail's size: texel lengths scale with it. */
  private morphSize(): void {
    const u = this.u;
    const G = this.grids;
    const at = this.morph.at;
    u[5] = wave(at[1], 7, 20) * (0.8 + 0.4 * this.reach) * G.r; // sensor reach
    u[7] = ((0.9 + 0.5 * this.energy) * this.morph.flow + 0.3) * G.r; // step
    // Deposit: the total grows with the strands' length in texels (r), shared by r^2 as many agents.
    u[9] = FIX * wave(at[4], 0.7, 1.3) * ((N0 * G.r * G.r) / G.n);
    u[68] = G.tw;
    u[69] = G.th;
    u[70] = G.n;
  }
  /** The cue's reach gene and the slow energy, kept for a resize mid-frame. */
  private reach = 0;
  private energy = 0;

  /** Reallocates for a new render size, carrying the network across. */
  private resize(encoder: GPUCommandEncoder, width: number, height: number): void {
    const [tw, th] = trailSize(width, height);
    const old = this.grids;
    if (tw === old.tw && th === old.th) return;
    const next = this.makeGrids(tw, th);
    this.grids = next;
    this.cursor %= next.n;
    this.morphSize();
    const u = this.u;
    u[76] = old.n;
    u[77] = tw / old.tw;
    this.device.queue.writeBuffer(this.uBuffer, 0, u);
    if (!this.reset) {
      const cp = encoder.beginComputePass({ label: 'slime-light-resize' });
      cp.setBindGroup(0, this.group0);
      cp.setPipeline(this.pipes.grow);
      cp.setBindGroup(1, this.bind(this.layouts.grow, old.agents, next.agents));
      cp.dispatchWorkgroups(Math.ceil(next.n / 256));
      cp.setPipeline(this.pipes.resample);
      for (const k of [0, 1]) {
        cp.setBindGroup(1, this.bind(this.layouts.resample, old.trail[k], next.trail[k]));
        cp.dispatchWorkgroups(Math.ceil(tw / 8), Math.ceil(th / 8));
      }
      cp.end();
    }
    this.retired.push(old);
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    for (const r of this.retired) r.destroy();
    this.retired = [];
    this.resize(encoder, width, height);
    const P = this.pipes;
    const Gr = this.grids;
    const G = Gr.groups;
    const cp = encoder.beginComputePass({ label: 'slime-light-sim' });
    cp.setBindGroup(0, this.group0);
    const run = (pipe: GPUComputePipeline, group: GPUBindGroup, x: number, y = 1) => {
      cp.setPipeline(pipe);
      cp.setBindGroup(1, group);
      cp.dispatchWorkgroups(x, y);
    };
    if (this.reset) run(P.init, G.init, Math.ceil(Gr.n / 256));
    else if (this.spawnCount > 0) run(P.spawn, G.init, Math.ceil(this.spawnCount / 256));
    for (let k = 0; k < this.simSteps; k++) {
      run(P.agents, G.agents[this.tCur * 2 + this.bCur], Math.ceil(Gr.n / 256));
      run(P.diffuse, G.diffuse[this.tCur], Math.ceil(Gr.tw / 8), Math.ceil(Gr.th / 8));
      this.tCur ^= 1;
    }
    // The burn reads the network and the agents read the burn on the next frame.
    for (let k = 0; k < this.burnSteps; k++) {
      run(P.burn, G.burn[this.bCur * 2 + this.tCur], Math.ceil(BW / 8), Math.ceil(BH / 8));
      this.bCur ^= 1;
    }
    run(P.shade, this.shadeGroups[this.bCur], Math.ceil(BW / 8), Math.ceil(BH / 8));
    run(P.glow, G.glow[this.tCur], Math.ceil(GW / 8), Math.ceil(GH / 8));
    cp.end();
    this.reset = false;
    this.simSteps = this.burnSteps = 0;
    const pass = encoder.beginRenderPass({
      label: 'slime-light',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(P.render);
    pass.setBindGroup(0, this.group0);
    pass.setBindGroup(1, G.render[this.tCur]);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    for (const r of this.retired) r.destroy();
    this.grids.destroy();
    this.paramBuffer.destroy();
    for (const r of this.owned) r.destroy();
  }
}

type Slot = 'buf' | 'ro' | 'tex' | 'out16';

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
            if (s === 'buf') return { binding, visibility: vis, buffer: { type: 'storage' } };
            if (s === 'ro') return { binding, visibility: vis, buffer: { type: 'read-only-storage' } };
            if (s === 'tex') return { binding, visibility: vis, texture: { sampleType: 'float' } };
            return { binding, visibility: vis, storageTexture: { access: 'write-only', format: 'rgba16float' } };
          }),
        ],
      });
    const specs: Record<Name, { code: string; slots: Slot[] }> = {
      init: { code: INIT, slots: ['buf'] },
      spawn: { code: SPAWN, slots: ['buf'] },
      grow: { code: GROW, slots: ['ro', 'buf'] },
      agents: { code: AGENTS, slots: ['buf', 'tex', 'tex', 'buf'] },
      diffuse: { code: DIFFUSE, slots: ['tex', 'buf', 'out16'] },
      resample: { code: RESAMPLE, slots: ['tex', 'out16'] },
      burn: { code: BURN, slots: ['tex', 'tex', 'out16'] },
      shade: { code: SHADE, slots: ['tex', 'tex', 'out16'] },
      glow: { code: GLOW, slots: ['tex', 'out16'] },
    };
    const names = Object.keys(specs) as Name[];
    const layouts = {
      ...(Object.fromEntries(names.map((n) => [n, layout(specs[n].slots, C)])) as Record<Name, GPUBindGroupLayout>),
      render: layout(['tex', 'tex', 'tex', 'tex'], GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX),
    };
    const computes = await Promise.all(
      names.map(async (n) => {
        const module = await compileModule(device, `${prelude}\n${specs[n].code}`, `slime-light-${n}`);
        return device.createComputePipelineAsync({
          label: `slime-light-${n}`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, layouts[n]] }),
          compute: { module, entryPoint: 'main' },
        });
      }),
    );
    const rModule = await compileModule(device, `${prelude}\n${RENDER}`, 'slime-light-draw');
    const render = await device.createRenderPipelineAsync({
      label: 'slime-light-draw',
      layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, layouts.render] }),
      vertex: { module: rModule, entryPoint: 'vs' },
      fragment: { module: rModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
    });
    const pipes = { ...(Object.fromEntries(names.map((n, i) => [n, computes[i]])) as Record<Name, GPUComputePipeline>), render };

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const tex = (label: string, w: number, h: number) =>
      device.createTexture({ label: `slime-light-${label}`, size: [w, h], format: 'rgba16float', usage });
    const burn = [tex('burnA', BW, BH), tex('burnB', BW, BH)];
    const fire = tex('fire', BW, BH);
    const glow = tex('glow', GW, GH);
    const uBuffer = device.createBuffer({ label: 'slime-light-u', size: UVEC * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bind: Bind = (l, ...rs) =>
      device.createBindGroup({
        layout: l,
        entries: [
          { binding: 0, resource: { buffer: uBuffer } },
          ...rs.map((r, i) => ({ binding: i + 1, resource: r instanceof GPUTexture ? r.createView() : { buffer: r } })),
        ],
      });
    const shadeGroups = [0, 1].map((b) => bind(layouts.shade, burn[b], burn[b ^ 1], fire));
    const paramBuffer = shared.createSceneParamBuffer('slime-light-params');
    const group0 = shared.createSceneBindGroup(paramBuffer, 'slime-light');
    return new SlimeInstance(device, group0, paramBuffer, uBuffer, pipes, layouts, bind, burn, fire, glow, shadeGroups, [...burn, fire, glow, uBuffer]);
  },
};

export default factory;
