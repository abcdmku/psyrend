import { compileModule } from '../../gpu/context';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { Morph, wave } from '../morph';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Spectral Nebula: the sound breathes out matter. A GPU particle system emits gas and sparks from
 * the music's own signature, the particles ride a curl-noise current and are splatted into a
 * persistent gas field that diffuses, drifts outward past the viewer and slowly fades, so every
 * phrase leaves a cloud that keeps evolving for seconds.
 *
 * - Melody: the emitter sits where the pitch puts it (high notes high), streams in the note's
 *   colour, and each note opens it with a puff.
 * - Spectrum: each particle is born from a band chosen by the band energies; the low bands make
 *   large soft puffs of gas, the mids smaller wisps, the highs fine sparks. The spectral centroid
 *   turns the colour, the flux sets the emission rate.
 * - Kick: ignites the gas at three points (a golden-angle walk); a fire front runs through the
 *   cloud only where there is gas, ragged, at finite speed, throws off sparks, and leaves the gas
 *   it passed in a new colour. The key light also swings a step round the cloud, relighting it.
 * - Snare: a fast electric front in a second colour from the emitter's neighbourhood, and the
 *   whole cloud's colour turns to a new angle (up to a third of a turn either way of its home).
 * - Chords turn the palette; the morph lays out the current, and each kick and snare steps it into
 *   a new lasting arrangement.
 *
 * The gas is lit as a volume: its density gradient gives billows a key light, a soft self-shadow
 * and an iridescent rim, and a two-level haze lets its light pool into the dark around it.
 */

const COUNT = 1 << 18;
/** The gas grid at its smallest; it grows with the render target (cover-fitted 16:9) up to 2560x1440. */
const GW = 800;
const GH = 450;
const GH_MAX = 1440;
/** The burn grid at its smallest; it grows with the gas up to twice this, stepping faster as it does. */
const BW = 320;
const BH = 180;
/** The current, sampled by the gas and burn passes (it is smooth, so a coarse grid holds it exactly). */
const VW = 384;
const VH = 216;
const G1W = 160;
const G1H = 90;
const G2W = 64;
const G2H = 36;
const ASPECT = GW / GH;
const UVEC = 40;
const BURSTS = 4;
const IGN = 6;
const BURN_RATE = 80;
const TAU = Math.PI * 2;
const fract = (x: number) => x - Math.floor(x);
/** A hit's level (0..1) to its reaction's strength: rises from 0 at slope 2 and eases into 1, so mid hits read well and nothing kinks. */
const strength = (lv: number) => lv * (2 - lv);

/** One step of a critically damped spring (value at r[i], velocity at r[i + 1]) toward a target. */
function react(r: Float64Array, i: number, target: number, w: number, dt: number): void {
  const e = Math.exp(-w * dt);
  const d = r[i] - target;
  const c = r[i + 1] + w * d;
  r[i] = target + (d + c * dt) * e;
  r[i + 1] = (r[i + 1] - w * c * dt) * e;
}

const META: SceneMeta = {
  id: 'spectral-nebula',
  name: 'Spectral Nebula',
  energy: [0, 1],
  mood: { valence: 0.55, arousal: 0.5 },
  genres: { ambient: 1, edm: 0.9, synthwave: 0.9, techno: 0.7, pop: 0.7, dnb: 0.6, dubstep: 0.6, lofi: 0.7, jazz: 0.6, classical: 0.8, hiphop: 0.5, rock: 0.5, acoustic: 0.6 },
  trails: 0,
  kaleido: false,
};

/*
 * Uniform layout (vec4 slots of U):
 *  0 dt, reset, frame seed, burn step      1 focal x, y, expansion, swirl
 *  2 curl amp, curl scale, curl depth, gas decay tau   3 diffusion, ageing, heat tau, ember tau
 *  4 emitter x, y, dir x, dir y            5 emitter spread, speed, hue, -
 *  6 band cumulative weights (sub, bass, lowMid, mid)  7 band energies (sub, bass, lowMid, mid)
 *  8 high, head, main count, bow           9-12 bursts (x, y, hue, count)
 *  13-16 bursts (kind, speed, -, -)        17-22 ignitions (x, y, r, hue)  23-28 ignition (kind, level, -, -)
 *  29 light xyz, rim                       30 gain, shadow, deposit, spark gain
 *  31 opening (hue, scale, seed, note boost)
 *  32 burn blend (fraction of a burn step since the last), burn life scale, -, -
 *  33 eased reactions: key light turn (kicks), colour turn (snares), -, -
 *  34 detail coordinates (morph.detailAt)  35 fine octave amps (mid, high), fine turn, note warp amp
 *  36 high note centre x, y, warp radius, -   37 fine warp of the gas (global amp, high note amp, note depth step, -)
 */
const HEAD = /* wgsl */ `
const NCOUNT: u32 = ${COUNT}u;
const ASPECT: f32 = ${ASPECT};
@group(1) @binding(0) var<uniform> U: array<vec4f, ${UVEC}>;
struct Particle { a: vec4f, b: vec4f, c: vec4f };
// a: pos.xy, depth, life left   b: vel.xy, hue, size   c: lifetime, kind (0 gas, 1 spark), mass, -

fn nb_chroma(c: vec3f) -> f32 {
  let hi = max(c.r, max(c.g, c.b));
  return (hi - min(c.r, min(c.g, c.b))) / max(hi, 1e-4);
}
fn nb_rot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}
// How far apart two colours' hues are: 0 the same, 1 a quarter turn, 2 opposite.
fn nb_apart(a: vec3f, b: vec3f) -> f32 {
  let da = a - dot(a, vec3f(0.33333));
  let db = b - dot(b, vec3f(0.33333));
  return 1.0 - dot(da, db) / max(length(da) * length(db), 1e-6);
}
// A saturated colour from the palette's coloured entries, normalised to its brightest channel.
fn ink(h: f32) -> vec3f {
  let c0 = F.pal0.rgb;
  let c1 = F.pal1.rgb;
  let c2 = F.pal2.rgb;
  let s0 = nb_chroma(c0);
  let s1 = nb_chroma(c1);
  let s2 = nb_chroma(c2);
  var best = c1;
  var sb = s1;
  if (s2 > sb) { best = c2; sb = s2; }
  if (s0 > sb) { best = c0; }
  // Three distinct inks whatever the scheme: a grey entry, or one whose hue repeats an earlier
  // ink's, is replaced by that ink turned a third of the way round the wheel (blended smoothly, so a
  // changing palette never pops).
  let k0 = mix(nb_rot(best, 2.3), c0, smoothstep(0.1, 0.3, s0));
  let k1 = mix(nb_rot(k0, 2.1), c1, smoothstep(0.1, 0.3, s1) * smoothstep(0.35, 0.7, nb_apart(c1, k0)));
  let k2 = mix(nb_rot(k0, -2.1), c2, smoothstep(0.1, 0.3, s2) * smoothstep(0.35, 0.7, min(nb_apart(c2, k0), nb_apart(c2, k1))));
  let x = fract(h) * 3.0;
  let f = smoothstep(0.0, 1.0, fract(x));
  let c = select(select(mix(k2, k0, f), mix(k1, k2, f), x < 2.0), mix(k0, k1, f), x < 1.0);
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let sv = (hi - lo) / max(hi, 1e-4);
  let n = (c - lo) / max(hi - lo, 1e-4);
  return mix(vec3f(1.0), n, mix(0.62, 0.92, sat(sv * 2.0)));
}
// The same colour at full depth (for gas, which pales as inks mix).
fn inkDeep(h: f32) -> vec3f { let c = ink(h); let lo = min(c.r, min(c.g, c.b)); return (c - lo * 0.85) / max(1.0 - lo * 0.85, 1e-3); }
// 5-tap Catmull-Rom: the gas stays crisp when magnified to the frame.
fn nb_crisp(t: texture_2d<f32>, uv: vec2f) -> vec4f {
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
fn nb_q(uv: vec2f) -> vec2f { return (uv - 0.5) * vec2f(ASPECT, 1.0); }
fn nb_uv(q: vec2f) -> vec2f { return q / vec2f(ASPECT, 1.0) + 0.5; }
// The current: the curl of a noise stream function (depth through the noise carried by the morph),
// plus a slow outward drift and turn about the focal point, scaled by parallax. The two low octaves
// lay out the large structure; two fine octaves comb the gas into its finest filaments, and the high
// end reworks them: their layout flows with the detail coordinates, high notes, backing chords and
// hats turn and step them, their strength follows the mids and highs, and each high note warps the
// filaments where it lands on the veil.
fn nb_psi(q: vec2f) -> f32 {
  let k = U[2].y;
  let z = U[2].z;
  let D = U[34];
  let A = U[35];
  var s = noise4fast(vec3f(q * k, z)).x + 0.45 * noise4fast(vec3f(q * k * 2.13 + 5.3, z * 1.37 + 2.1)).y;
  let lq = (q - U[36].xy) / U[36].z;
  let local = A.w * exp(-dot(lq, lq));
  let q3 = rot2(A.z) * q * (k * 3.3) + D.xy;
  s += (A.x + local) * noise4fast(vec3f(q3, z * 1.7 + D.z)).z;
  let q4 = rot2(0.8 - A.z * 1.3) * q * (k * 5.2) + D.yx * 1.7 + 9.1;
  s += (A.y + local * 0.5) * noise4fast(vec3f(q4, z * 2.3 + D.w)).w;
  return s;
}
fn nb_flow(q: vec2f, par: f32) -> vec2f {
  let e = 0.02;
  let dy = nb_psi(q + vec2f(0.0, e)) - nb_psi(q - vec2f(0.0, e));
  let dx = nb_psi(q + vec2f(e, 0.0)) - nb_psi(q - vec2f(e, 0.0));
  let curl = vec2f(dy, -dx) / (2.0 * e) * U[2].x / U[2].y;
  let d = q - U[1].xy;
  return curl + (d * U[1].z + vec2f(-d.y, d.x) * U[1].w) * par;
}
// Cubic B-spline filtering from four bilinear taps.
fn nb_bspline(t: texture_2d<f32>, uv: vec2f) -> vec4f {
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

/**
 * Particles. New ones are born in a ring-buffer window (the CPU advances the head by the emission
 * count each frame), so the emission rate is exact at any frame rate. Gas relaxes into the current;
 * sparks fly ballistic with a little drag.
 */
const SIM = /* wgsl */ `
@group(1) @binding(1) var<storage, read_write> P: array<Particle>;
fn gauss2(h: vec2f) -> vec2f {
  let r = sqrt(-2.0 * log(max(h.x, 1e-6)));
  return r * vec2f(cos(TAU * h.y), sin(TAU * h.y));
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= NCOUNT) { return; }
  var p = P[i];
  let dt = U[0].x;
  if (U[0].y > 0.5) { p.a.w = 0.0; }
  let head = u32(U[8].y);
  let rel = (i + NCOUNT - head) % NCOUNT;
  let mainN = u32(U[8].z);
  var born = false;
  let seed = pcg(i * 7919u + u32(U[0].z * 65536.0));
  let h = hashU3(seed);
  let h2 = hashU3(seed ^ 0x9e3779b9u);
  let h3 = hashU3(seed ^ 0x85ebca6bu);
  if (rel < mainN) {
    // The sound's emitter is a line laid out by the spectrum: a particle's band (picked by the band
    // energies) puts it on its own stretch of the line, low bands at one end, highs at the other,
    // so the line breathes out a veil whose density along it is the spectrum, coloured across it.
    born = true;
    let cw = U[6];
    let band = select(select(select(select(4.0, 3.0, h.x < cw.w), 2.0, h.x < cw.z), 1.0, h.x < cw.y), 0.0, h.x < cw.x);
    let e = select(select(select(select(U[8].x, U[7].w, band < 3.5), U[7].z, band < 2.5), U[7].y, band < 1.5), U[7].x, band < 0.5);
    let s01 = (band + h.y) / 5.0;
    let td = U[4].zw;
    let nd = vec2f(-td.y, td.x);
    // (The line bows into an arc by the morph.)
    let sl = s01 - 0.5;
    let pos = U[4].xy + td * sl * U[5].w + nd * U[8].w * (sl * sl * 4.0 - 0.33) + gauss2(h2.xy) * U[5].x;
    p.a = vec4f(pos, mix(0.35, 1.0, h2.z), 0.0);
    let sp = U[5].y * (0.5 + 0.9 * h3.x) * (0.7 + 0.6 * e);
    let v = nd * sp + td * (h3.y - 0.5) * sp * 0.6;
    let life = mix(3.5, 7.0, h3.z) * (1.0 - 0.08 * band);
    let size = (0.005 + 0.009 * e) * (1.35 - 0.15 * band);
    let hue = U[5].z + s01 * 0.2 + (h.z - 0.5) * 0.02;
    p.b = vec4f(v, hue, size);
    // A note's attack makes its matter denser: each note leaves a brighter layer in the veil.
    p.c = vec4f(life, 0.0, (0.3 + 0.9 * e) * (1.0 + U[31].w), 0.0);
    p.a.w = life;
  } else {
    // Embers thrown off by a front: born over the burning patch, drifting off slowly in the current.
    var r = rel - mainN;
    for (var k = 0; k < ${BURSTS}; k++) {
      let B = U[9 + k];
      let n = u32(B.w);
      if (!born && r < n) {
        born = true;
        let K = U[13 + k];
        let dirn = gauss2(h.xy);
        p.a = vec4f(B.xy + gauss2(h2.xy) * 0.035, mix(0.35, 1.0, h2.z), 0.0);
        let life = mix(0.8, 2.2, h3.z);
        p.b = vec4f(dirn * K.y * (0.3 + 0.7 * h3.x), B.z + (h3.y - 0.5) * 0.06, 0.007 + 0.004 * h.z);
        p.c = vec4f(life, 1.0, 1.0, 0.0);
        p.a.w = life;
      }
      if (!born) { r -= min(r, n); }
    }
  }
  if (!born && p.a.w > 0.0) {
    let par = mix(0.6, 1.4, p.a.z);
    let f = nb_flow(p.a.xy, par);
    let drag = select(2.2, 0.9, p.c.y > 0.5);
    p.b = vec4f(mix(p.b.xy, f, 1.0 - exp(-dt * drag)), p.b.zw);
    p.a = vec4f(p.a.xy + p.b.xy * dt, p.a.z, p.a.w - dt);
  }
  P[i] = p;
}`;

/** Splats every live gas particle into the gas field (additive, scaled by dt). */
const SPLAT = /* wgsl */ `
@group(1) @binding(1) var<storage, read> P: array<Particle>;
struct SOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) color: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SOut {
  var o: SOut;
  let p = P[ii];
  if (p.a.w <= 0.0 || p.c.y > 0.5) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let age = 1.0 - p.a.w / p.c.x;
  // Puffs swell as they age.
  let size = p.b.w * (1.3 + 1.0 * sqrt(age));
  let uv = nb_uv(p.a.xy + c * size * 1.6);
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  o.q = c * 1.6;
  let fade = smoothstep(0.0, 0.12, p.c.x - p.a.w) * smoothstep(1.0, 0.6, age);
  // Each splat deposits the same amount of gas whatever its size: bigger is thinner.
  let amount = p.c.z * fade * U[0].x * U[30].z / (size * size * 1600.0);
  o.color = vec4f(inkDeep(p.b.z) * amount, amount);
  return o;
}
@fragment fn fs(in: SOut) -> @location(0) vec4f {
  // The Gaussian windowed to zero at the quad's inscribed circle (the quad is kept tight: splat fill is
  // the costliest pass).
  return in.color * max(exp(-dot(in.q, in.q) * 2.0) - 0.006, 0.0) * 1.006;
}`;

/** Sparks drawn straight to the frame as short streaks along their motion. */
const SPARKS = /* wgsl */ `
@group(1) @binding(1) var<storage, read> P: array<Particle>;
struct KOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) color: vec3f, @location(2) stretch: f32 };
fn toClip(q: vec2f) -> vec2f {
  var s = vec2f(1.0);
  if (F.aspect > ASPECT) { s.y = ASPECT / F.aspect; } else { s.x = F.aspect / ASPECT; }
  let uv = 0.5 + (nb_uv(q) - 0.5) / s;
  return vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> KOut {
  var o: KOut;
  let p = P[ii];
  if (p.a.w <= 0.0 || p.c.y < 0.5) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let res = F.res;
  let a = toClip(p.a.xy) * res * 0.5;
  let b = toClip(p.a.xy - p.b.xy * 0.05) * res * 0.5;
  let sizePx = max(p.b.w * res.y * 0.6, 0.9);
  var dir = a - b;
  let len = min(length(dir), 60.0);
  dir = select(vec2f(1.0, 0.0), dir / max(length(dir), 1e-5), len > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let halfLen = len * 0.5 + sizePx;
  let px = (a + b) * 0.5 + dir * c.x * halfLen + nrm * c.y * sizePx;
  o.pos = vec4f(px / (res * 0.5), 0.0, 1.0);
  o.q = vec2f(c.x * halfLen / sizePx, c.y);
  o.stretch = halfLen / sizePx - 1.0;
  let age = 1.0 - p.a.w / p.c.x;
  let hot = 1.0 - age;
  let col = mix(ink(p.b.z), vec3f(1.0, 0.9, 0.7), hot * hot * 0.7);
  o.color = col * hot * p.c.z * U[30].w / (1.0 + len / (sizePx * 2.0));
  return o;
}
@fragment fn fs(in: KOut) -> @location(0) vec4f {
  let d = vec2f(max(abs(in.q.x) - in.stretch, 0.0), in.q.y);
  return vec4f(in.color * exp(-dot(d, d) * 3.0), 1.0);
}`;

/** The current on a coarse grid (the gas and burn passes sample it instead of re-evaluating noise). */
const FLOW = /* wgsl */ `
@group(1) @binding(1) var vOut: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = vec2i(textureDimensions(vOut));
  let i = vec2i(id.xy);
  if (i.x >= dims.x || i.y >= dims.y) { return; }
  let q = nb_q((vec2f(i) + 0.5) / vec2f(dims));
  textureStore(vOut, i, vec4f(nb_flow(q, 1.0), 0.0, 0.0));
}`;

/** Gas: advect with the current, diffuse, fade, age its colour, recolour where fronts pass. */
const GAS = /* wgsl */ `
@group(1) @binding(1) var gIn: texture_2d<f32>;
@group(1) @binding(2) var bIn: texture_2d<f32>;
@group(1) @binding(3) var gOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var vTex: texture_2d<f32>;
@group(1) @binding(5) var dTex: texture_2d<f32>;
// The opening: veils of fine marbled threads (bands of a domain-warped coordinate), so the cloud
// starts as smoke already combed by the current rather than as noise.
fn opening(q: vec2f) -> vec4f {
  let O = U[31];
  let p = vec3f(q * O.y, O.z * 17.0);
  let w = vec2f(fbmFast(p, 3), fbmFast(p + vec3f(5.2, 1.3, 2.8), 3));
  let u = dot(q + w * 0.55, vec2f(0.8, 0.6)) * 26.0;
  let threads = pow(0.5 + 0.5 * sin(u), 6.0) * (0.6 + 0.4 * sin(u * 3.1 + w.x * 4.0));
  let veil = smoothstep(-0.15, 0.25, fbmFast(p * 0.6 + vec3f(1.7, 4.4, 0.0), 3));
  let r = length(q - U[1].xy);
  let dens = max(threads, 0.0) * veil * smoothstep(0.05, 0.3, r) * 0.8;
  return vec4f(ink(O.x + w.y * 0.8 + u * 0.004) * dens, dens);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = vec2i(textureDimensions(gOut));
  let i = vec2i(id.xy);
  if (i.x >= dims.x || i.y >= dims.y) { return; }
  let uv = (vec2f(i) + 0.5) / vec2f(dims);
  let q = nb_q(uv);
  if (U[0].y > 0.5) { textureStore(gOut, i, opening(q)); return; }
  let dt = U[0].x;
  let suv = nb_uv(q - textureSampleLevel(vTex, sampClamp, uv, 0.0).xy * dt);
  var g = textureSampleLevel(gIn, sampClamp, suv, 0.0);
  let t = 1.0 / vec2f(dims);
  let n = textureSampleLevel(gIn, sampClamp, suv + vec2f(t.x, 0.0), 0.0) + textureSampleLevel(gIn, sampClamp, suv - vec2f(t.x, 0.0), 0.0)
    + textureSampleLevel(gIn, sampClamp, suv + vec2f(0.0, t.y), 0.0) + textureSampleLevel(gIn, sampClamp, suv - vec2f(0.0, t.y), 0.0);
  g = mix(g, n * 0.25, sat(U[3].x * dt * 60.0));
  // Fade, and age the colour: the weaker channels thin out first, so the gas deepens as it cools.
  let m = max(g.r, max(g.g, g.b));
  let k = exp(-dt / U[2].w);
  g = vec4f(g.rgb * k * exp(-dt / U[2].w * U[3].y * (1.0 - g.rgb / max(m, 1e-5))), g.a * k);
  // Burnt gas keeps the front's colour.
  let B = nb_bspline(bIn, uv);
  if (B.y > 0.05) {
    let mc = max(g.r, max(g.g, g.b));
    g = vec4f(mix(g.rgb, inkDeep(B.z) * mc * 1.05, sat(B.y * 1.3 - 0.1) * (1.0 - exp(-dt * 10.0))), g.a);
  }
  // This frame's matter, splatted on its own (coarser) grid and interpolated in.
  g += nb_crisp(dTex, uv);
  textureStore(gOut, i, min(g, vec4f(16.0)));
}`;

/** Burn: an excitable medium on a coarse grid, carried by the current, conducted only by gas. */
const BURN = /* wgsl */ `
@group(1) @binding(1) var bIn: texture_2d<f32>;
@group(1) @binding(2) var gTex: texture_2d<f32>;
@group(1) @binding(3) var bOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var vTex: texture_2d<f32>;
var<private> BD: vec2i;
fn bAt(i: vec2i) -> vec4f { return textureLoad(bIn, clamp(i, vec2i(0), BD - 1), 0); }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  BD = vec2i(textureDimensions(bOut));
  let BW = BD.x;
  let BH = BD.y;
  let i = vec2i(id.xy);
  if (i.x >= BW || i.y >= BH) { return; }
  if (U[0].y > 0.5) { textureStore(bOut, i, vec4f(0.0)); return; }
  let uv = (vec2f(i) + 0.5) / vec2f(f32(BW), f32(BH));
  let q = nb_q(uv);
  let h = U[0].w;
  let suv = nb_uv(q - textureSampleLevel(vTex, sampClamp, uv, 0.0).xy * h);
  let s = textureSampleLevel(bIn, sampClamp, suv, 0.0);
  // Fuel is the gas's ridges: density above its local mean. Fronts run along the filaments and
  // the edges of the cloud, never through it as a disc. (The cell's own density is averaged over
  // its footprint, however fine the gas grid.)
  let cf = 0.25 / vec2f(f32(BW), f32(BH));
  let d0 = 0.25 * (textureSampleLevel(gTex, sampClamp, uv + cf, 0.0).a + textureSampleLevel(gTex, sampClamp, uv - cf, 0.0).a
    + textureSampleLevel(gTex, sampClamp, uv + vec2f(cf.x, -cf.y), 0.0).a + textureSampleLevel(gTex, sampClamp, uv + vec2f(-cf.x, cf.y), 0.0).a);
  var dm = 0.0;
  for (var k = 0; k < 6; k++) {
    let a = f32(k) * 1.0472;
    dm += textureSampleLevel(gTex, sampClamp, uv + vec2f(cos(a), sin(a)) * vec2f(3.0 / ${BW}.0, 3.0 / ${BH}.0), 0.0).a;
  }
  let fuel = smoothstep(0.06, 0.3, d0) * smoothstep(0.0, 0.12, d0 - dm / 6.0 + 0.03);
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
  for (var k = 0; k < 8; k++) {
    let dk = vec2f(cos(f32(k) * 0.785398 + 0.39), sin(f32(k) * 0.785398 + 0.39));
    let n2 = bAt(bi + vec2i(round(dk * 2.0)));
    if (n2.x > 0.4) { heat += 0.8; if (n2.x > best.x) { best = n2; } }
    let n3 = bAt(bi + vec2i(round(dk * 3.2)));
    if (n3.w >= 1.0 && n3.w < 1.9 && n3.x > 0.4) { heat += 0.7; if (n3.x > best.x) { best = n3; } }
  }
  // Each front carries a life it spends as it spreads (w = kind + life / 2).
  let kind = floor(best.w);
  let life = (best.w - kind) * 2.0 - select(select(0.04, 0.03, kind < 1.5), 0.022, kind < 0.5) * U[32].y;
  // Denser gas catches more readily, so fronts finger along the filaments of the cloud.
  let chance = sat(heat * 0.28) * fuel * fuel * step(0.0, life);
  let roll = hash13(vec3f(vec2f(i), floor(best.x * 4096.0) + floor(s.y * 977.0) + U[0].z * 131.0));
  var o = vec4f(s.x * exp(-h / U[3].z), s.y * exp(-h / U[3].w), s.zw);
  let ready = s.x < 0.12 && s.y < 0.25;
  if (ready && roll < chance) { o = vec4f(1.0, 1.0, best.z, kind + 0.5 * max(life, 0.0)); }
  for (var j = 0; j < ${IGN}; j++) {
    let I = U[17 + j];
    // Only fresh gas catches, so a growing patch lights as a spreading ring, not a held disc. The
    // front carries its hit's level as its life, so a faint hit runs a short way and a hard one far.
    let K = U[23 + j];
    if (I.z > 0.0 && ready && fuel > 0.1 && length(q - I.xy) < I.z) { o = vec4f(1.0, 1.0, I.w, K.x + 0.5 * K.y); }
  }
  textureStore(bOut, i, o);
}`;

/** Glow 1: a true box over each output texel's footprint, whatever the gas resolution. */
const DOWN = /* wgsl */ `
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let od = vec2i(textureDimensions(outTex));
  let i = vec2i(id.xy);
  if (i.x >= od.x || i.y >= od.y) { return; }
  let sd = vec2f(textureDimensions(srcTex));
  let uv = (vec2f(i) + 0.5) / vec2f(od);
  // Footprint in source texels (a little wider than one output texel, so it overlaps smoothly),
  // covered by bilinear taps no more than two texels apart.
  let fp = sd / vec2f(od) * 1.6;
  let n = vec2i(clamp(ceil(fp / 2.0), vec2f(2.0), vec2f(14.0)));
  var acc = vec4f(0.0);
  for (var y = 0; y < n.y; y++) {
    for (var x = 0; x < n.x; x++) {
      let o = ((vec2f(f32(x), f32(y)) + 0.5) / vec2f(n) - 0.5) * fp;
      acc += textureSampleLevel(srcTex, sampClamp, uv + o / sd, 0.0);
    }
  }
  textureStore(outTex, i, acc / f32(n.x * n.y));
}`;

/** Carries a field across a change of grid size (linear, or nearest for the burn's packed states). */
const resampleWgsl = (nearest: boolean) => /* wgsl */ `
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let od = vec2i(textureDimensions(outTex));
  let i = vec2i(id.xy);
  if (i.x >= od.x || i.y >= od.y) { return; }
  let uv = (vec2f(i) + 0.5) / vec2f(od);
  let sd = vec2i(textureDimensions(srcTex));
  ${nearest ? 'let v = textureLoad(srcTex, clamp(vec2i(uv * vec2f(sd)), vec2i(0), sd - 1), 0);' : 'let v = textureSampleLevel(srcTex, sampClamp, uv, 0.0);'}
  textureStore(outTex, i, v);
}`;

const glowWgsl = (W: number, H: number, box: boolean) => /* wgsl */ `
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  if (i.x >= ${W} || i.y >= ${H}) { return; }
  let uv = (vec2f(i) + 0.5) / vec2f(${W}.0, ${H}.0);
  let px = 1.0 / vec2f(textureDimensions(srcTex));
  var acc = vec4f(0.0);
  var ws = 0.0;
  for (var y = -2; y <= 1; y++) {
    for (var x = -2; x <= 1; x++) {
      let o = vec2f(f32(x) + 0.5, f32(y) + 0.5);
      ${box ? 'let w = 1.0; let tap = o * 2.0;' : 'let w = exp(-dot(o, o) * 0.3); let tap = o * 1.5;'}
      acc += textureSampleLevel(srcTex, sampClamp, uv + tap * px, 0.0) * w;
      ws += w;
    }
  }
  textureStore(outTex, i, acc / ws);
}`;

const RENDER = /* wgsl */ `
@group(1) @binding(1) var gTex: texture_2d<f32>;
@group(1) @binding(2) var bTex: texture_2d<f32>;
@group(1) @binding(3) var g1Tex: texture_2d<f32>;
@group(1) @binding(4) var g2Tex: texture_2d<f32>;
@group(1) @binding(5) var bPrev: texture_2d<f32>;
${FULLSCREEN_VS}
// Re-voices a mixed gas colour to a clean hue at its own brightness, so where the current mixes
// several inks the cloud reads as a new saturated colour, never pastel or grey.
fn vivid(c: vec3f) -> vec3f {
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let sv = (hi - lo) / max(hi, 1e-4);
  let n = (c - lo) / max(hi - lo, 1e-4);
  let v = mix(vec3f(1.0), n, mix(0.9, 0.98, sv)) * hi;
  return mix(c, v, smoothstep(0.01, 0.06, sv));
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  var s = vec2f(1.0);
  if (F.aspect > ASPECT) { s.y = ASPECT / F.aspect; } else { s.x = F.aspect / ASPECT; }
  let uv0 = 0.5 + (in.uv - 0.5) * s;
  // The fine scale, reworked by the high end: a high-octave warp of the gas's finest filaments whose
  // phase flows with the detail coordinates and turns with high notes and backing chords (all eased);
  // its depth follows the air of the mix, and each high note deepens it where it lands on the veil.
  let wq = nb_q(uv0);
  let wl = (wq - U[36].xy) / (U[36].z * 1.3);
  let wa = U[37].x + U[37].y * exp(-dot(wl, wl));
  let wn = noise4fast(vec3f(rot2(U[35].z) * wq * 26.0 + U[34].xy * 1.7, U[34].z * 1.3 + U[34].w * 0.6 + U[37].z));
  let uv = uv0 + wn.xy * wa / vec2f(ASPECT, 1.0);
  let G = nb_crisp(gTex, uv);
  let d = G.a;
  // Each snare turns the whole cloud's colour to a new angle, for good, gliding in from rest.
  let C = max(nb_rot(vivid(G.rgb / max(d, 1e-3)), U[33].y), vec3f(0.0));
  // The gas as a lit volume: density gradient for billows, a soft self-shadow toward the light.
  // Billows lit from the coarse density (fine splats would only light up as grain).
  let t = 1.0 / vec2f(${G1W}.0, ${G1H}.0);
  let gx = nb_bspline(g1Tex, uv + vec2f(t.x, 0.0)).a - nb_bspline(g1Tex, uv - vec2f(t.x, 0.0)).a;
  let gy = nb_bspline(g1Tex, uv + vec2f(0.0, t.y)).a - nb_bspline(g1Tex, uv - vec2f(0.0, t.y)).a;
  let N = normalize(vec3f(-vec2f(gx, gy) * 3.0, 1.0));
  // Each kick swings the key light a step round the cloud, for good, so its billows are relit.
  let L = normalize(vec3f(rot2(U[33].x) * U[29].xy, U[29].z));
  let ndl = max(dot(N, L), 0.0);
  let dl = nb_bspline(g1Tex, uv - L.xy * vec2f(1.0, -1.0) * 0.02).a;
  let shadow = exp(-max(dl - d * 0.6, 0.0) * U[30].y);
  let body = 1.0 - exp(-d * 1.3);
  var col = C * body * (0.45 + 0.75 * ndl) * shadow * U[30].x;
  // Iridescent rim where the cloud thins: the colour turned round the wheel.
  let rim = pow(1.0 - N.z, 1.5) * body;
  col += max(nb_rot(C, 2.1), vec3f(0.0)) * rim * U[29].w;
  // Light pooling around the cloud.
  let h1 = nb_bspline(g1Tex, uv);
  let h2 = nb_bspline(g2Tex, uv);
  col += (h1.rgb / max(h1.a, 1e-3)) * (1.0 - exp(-h1.a * 1.2)) * 0.12 + (h2.rgb / max(h2.a, 1e-3)) * (1.0 - exp(-h2.a * 1.5)) * 0.16;
  // Fronts: a hot edge and embers, only in the gas.
  // The burn blended between its last two steps, so fronts glide instead of stepping.
  let B = mix(nb_bspline(bPrev, uv), nb_bspline(bTex, uv), U[32].x);
  let Bn = B;
  let fuel = smoothstep(0.05, 0.4, d);
  let hx = sat(B.x);
  let wk = 1.0 - smoothstep(0.6, 1.0, Bn.w);
  let fire = vec3f(1.0, 0.38 + 0.6 * hx, 0.1 + 0.8 * hx * hx) * (2.2 * hx * hx + 0.3 * hx);
  let fc = ink(Bn.z);
  let spark = mix(fc, vec3f(1.0), hx * hx) * (2.8 * hx * hx + 0.3 * hx);
  let ember = sat(B.y - hx);
  let emberC = mix(vec3f(1.0, 0.32, 0.07), fc, 1.0 - wk) * ember * ember * 0.5;
  col += (fire * wk + spark * (1.0 - wk) + emberC) * fuel;
  return vec4f(col, 1.0);
}`;

type Burst = { x: number; y: number; hue: number; count: number; kind: number; speed: number };
type Ignition = { x: number; y: number; r: number; hue: number; kind: number; level: number; born: number };
type Pipes = {
  sim: GPUComputePipeline;
  flow: GPUComputePipeline;
  gas: GPUComputePipeline;
  burn: GPUComputePipeline;
  glow1: GPUComputePipeline;
  glow2: GPUComputePipeline;
  resample: GPUComputePipeline;
  resampleNearest: GPUComputePipeline;
  splat: GPURenderPipeline;
  render: GPURenderPipeline;
  sparks: GPURenderPipeline;
};
type Layouts = Record<'sim' | 'draw' | 'gas' | 'burn' | 'glow' | 'flow' | 'render', GPUBindGroupLayout>;

/** Seconds over which an ignition's patch spreads to its full size (no snaps). */
const IGN_RISE = 0.25;
/** How long an ignition keeps lighting the gas it reaches. */
const IGN_HOLD = 0.4;

/**
 * Everything sized by the render target: the gas (ping-pong), the splat grid, the burn (ping-pong)
 * and the bind groups over them. Gas-dependent groups are indexed [gas parity][burn parity].
 */
class Grids {
  readonly gas: GPUTexture[];
  readonly dep: GPUTexture;
  readonly depView: GPUTextureView;
  readonly burn: GPUTexture[];
  readonly g1: GPUTexture;
  readonly g2: GPUTexture;
  readonly vel: GPUTexture;
  readonly groups: {
    flow: GPUBindGroup;
    gas: GPUBindGroup[][];
    burn: GPUBindGroup[][];
    glow1: GPUBindGroup[];
    glow2: GPUBindGroup;
    render: GPUBindGroup[][];
  };

  constructor(
    device: GPUDevice,
    L: Layouts,
    uBuffer: GPUBuffer,
    readonly gw: number,
    readonly gh: number,
    readonly bw: number,
    readonly bh: number,
  ) {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const tex = (label: string, w: number, h: number, extra = 0) =>
      device.createTexture({ label: `spectral-nebula-${label}`, size: [w, h], format: 'rgba16float', usage: usage | extra });
    // Splats land on a fixed 800x450 grid: they are soft Gaussians (several texels wide), so the
    // gas step's Catmull-Rom interpolation loses nothing, and their fill cost stays bounded whatever
    // the gas resolution. Fine detail comes from the current shearing the gas on its own grid.
    const dw = GW;
    const dh = GH;
    this.gas = [tex('gas0', gw, gh), tex('gas1', gw, gh)];
    this.dep = tex('splats', dw, dh, GPUTextureUsage.RENDER_ATTACHMENT);
    this.depView = this.dep.createView();
    this.burn = [tex('burn0', bw, bh), tex('burn1', bw, bh)];
    this.g1 = tex('glow1', G1W, G1H);
    this.g2 = tex('glow2', G2W, G2H);
    this.vel = tex('current', VW, VH);
    const bind = (l: GPUBindGroupLayout, ...rs: GPUTexture[]) =>
      device.createBindGroup({
        layout: l,
        entries: [{ binding: 0, resource: { buffer: uBuffer } }, ...rs.map((r, i) => ({ binding: i + 1, resource: r.createView() }))],
      });
    const grid = (f: (a: number, b: number) => GPUBindGroup) => [0, 1].map((a) => [0, 1].map((b) => f(a, b)));
    const G = this.gas;
    const B = this.burn;
    this.groups = {
      flow: bind(L.flow, this.vel),
      gas: grid((c, b) => bind(L.gas, G[c], B[b], G[1 - c], this.vel, this.dep)),
      burn: grid((c, b) => bind(L.burn, B[b], G[c], B[1 - b], this.vel)),
      glow1: [0, 1].map((c) => bind(L.glow, G[c], this.g1)),
      glow2: bind(L.glow, this.g1, this.g2),
      render: grid((c, b) => bind(L.render, G[c], B[b], this.g1, this.g2, B[1 - b])),
    };
  }

  destroy(): void {
    for (const t of [...this.gas, this.dep, ...this.burn, this.g1, this.g2, this.vel]) t.destroy();
  }
}

/** Grid sizes for a render target: the gas matches the target's pixels (cover-fitted 16:9). */
function gridSize(width: number, height: number): [number, number, number, number] {
  const cover = Math.max(height, (width * GH) / GW);
  // Quantised (steps of 36 rows) so small changes of render scale don't reallocate every time.
  const gh = cover <= GH ? GH : Math.min(GH_MAX, Math.round(cover / 36) * 36);
  const gw = Math.round((gh * GW) / GH);
  const sb = Math.min(2, gh / GH);
  return [gw, gh, Math.round(BW * sb), Math.round(BH * sb)];
}

class NebulaInstance implements SceneInstance {
  readonly meta = META;
  private readonly u = new Float32Array(UVEC * 4);
  private readonly morph = new Morph(1);
  private lastT = -1;
  private seed = -1;
  private reset = true;
  private dt = 0;
  private hue = 0;
  private pitch = 0;
  private clock = 0;
  private head = 0;
  private emitAcc = 0;
  private burnAcc = 0;
  private burnSteps = 0;
  private frame = 0;
  /** Eased reactions (value, velocity): key light turn, colour turn. */
  private readonly rx = new Float64Array(4);
  /** Where those reactions are heading: each hit moves its target by its own level when it lands. */
  private lightTarget = 0;
  private turnTarget = 0;
  /** Kick colour walk (each kick steps it by its level), and the latest note's level. */
  private kickHue = 0;
  private noteLvl = 0;
  /** The latest high note: its strength and where it landed on the veil (captured as it lands). */
  private upperLvl = 0;
  private upperX = 0;
  private upperY = 0;
  private upperAlong = 0;
  private gp = 0;
  private bp = 0;
  private bursts: Burst[] = [];
  private ignitions: Ignition[] = [];
  private grids: Grids;
  /** Grids replaced this frame; destroyed once the frame that carried their state has been encoded. */
  private retired: Grids[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly group0: GPUBindGroup,
    private readonly uBuffer: GPUBuffer,
    private readonly pipes: Pipes,
    private readonly layouts: Layouts,
    private readonly sim: GPUBindGroup,
    private readonly draw: GPUBindGroup,
    private readonly owned: (GPUTexture | GPUBuffer)[],
  ) {
    this.grids = new Grids(device, layouts, uBuffer, GW, GH, BW, BH);
  }

  /** Burn steps per second and per-step reach follow the burn grid, so fronts keep their pace. */
  private get burnScale(): number {
    return this.grids.bh / BH;
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
      // The particles' random stream restarts too, so a seek always replays the same cloud.
      this.frame = 0;
      this.ignitions = [];
      this.bursts = [];
      this.hue = hueTarget;
      this.pitch = m.leadPitch;
      this.clock = 0;
      this.burnAcc = 0;
      this.emitAcc = 0;
      this.rx.fill(0);
      this.lightTarget = this.turnTarget = this.kickHue = this.noteLvl = this.upperLvl = 0;
    }
    this.clock += dt;
    this.frame++;
    const dh = ((((hueTarget - this.hue + 0.5) % 1) + 1) % 1) - 0.5;
    this.hue += dh * (1 - Math.exp(-dt / 0.8));
    this.pitch += (Math.max(-1.2, Math.min(1.2, m.leadPitch)) - this.pitch) * (1 - Math.exp(-dt / 0.12));

    const u = this.u;
    u.fill(0);
    u[0] = dt;
    u[1] = this.reset ? 1 : 0;
    u[2] = fract(g[0] * 7.13 + this.frame * 0.618034);

    // The current: a focal point drifting slowly, a gentle outward drift (flying through the cloud)
    // and a turn; the noise current's layout travels with the morph. The steady current is gentle, so
    // the beats' changes read clearly against it.
    const fx = 0.22 * Math.sin(at[0] * 0.5 + g[4] * TAU);
    const fy = 0.1 * Math.sin(at[1] * 0.5 + g[4] * 7.3);
    const swirlDir = g[1] > 0.5 ? 1 : -1;
    u[4] = fx;
    u[5] = fy;
    u[6] = (0.032 + 0.026 * g[7] + 0.02 * e) * flow;
    u[7] = swirlDir * wave(at[1], 0.015, 0.085) * flow;
    u[8] = wave(at[2], 0.04, 0.085) * flow * (0.7 + 0.6 * g[5]);
    u[9] = wave(at[3] * 0.5 + g[6] * 4, 3.0, 5.8);
    u[10] = at[4] * 0.35 + at[5] * 0.2 + g[2] * 20;
    u[11] = 2.6 + 1.4 * g[2] + 1.2 * (1 - e); // gas decay
    u[12] = 0.002; // diffusion (fraction of a 4-neighbour blur per 1/60 s)
    u[13] = 0.9; // ageing
    u[14] = 0.05; // heat
    u[15] = 1.0; // embers

    // The emitter line: the pitch sets its height, the morph turns it and walks it across; it
    // breathes toward the focal side.
    const ex = 0.35 * Math.sin(at[6] * 0.5 + g[5] * TAU) * (ASPECT / 2);
    const ey = -this.pitch * 0.28;
    const ang = 0.55 * Math.sin(at[7] * 0.4 + g[6] * TAU);
    let tdx = Math.cos(ang);
    let tdy = Math.sin(ang);
    if (-tdy * (fx - ex) + tdx * (fy - ey) < 0) {
      tdx = -tdx;
      tdy = -tdy;
    }
    u[16] = ex;
    u[17] = ey;
    u[18] = tdx;
    u[19] = tdy;
    u[20] = 0.004 + 0.004 * m.bass; // jitter
    u[21] = (0.025 + 0.035 * e) * (0.6 + 0.4 * flow); // speed off the line
    u[23] = wave(at[5] * 0.6 + g[7] * 5, 0.55, 0.95); // line length
    const centroidHue = (m.centroid - 0.5) * 0.5;
    const stepHue = mo.kickPhase * 0.07 + mo.snarePhase * 0.05;
    u[22] = this.hue + centroidHue + this.pitch * 0.15 + stepHue; // emitter hue

    // Bands pick each particle: cumulative weights of the band energies.
    const bands = [m.sub, m.bass, m.lowMid, m.mid, m.high].map((x) => 0.05 + Math.max(0, Math.min(1, x)));
    const tot = bands.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let k = 0; k < 4; k++) {
      acc += bands[k] / tot;
      u[24 + k] = acc;
      u[28 + k] = bands[k] - 0.05;
    }
    u[32] = bands[4] - 0.05;

    // Emission: a steady breath with the flux on top, each note a puff that swells in (peaking
    // ~0.15 s after the onset) and settles, never a jump.
    // The puff is as strong as its note (level captured when the note lands); the flux soft-clips.
    if (!seek && mo.leadAge === 0) this.noteLvl = strength(mo.noteLevel);
    const la = mo.leadAge / 0.15;
    const attack = la * Math.exp(1 - la) * this.noteLvl;
    const rate = (6000 + 16000 * (1 - Math.exp(-1.8 * Math.max(0, m.flux))) + 10000 * m.energy + 40000 * attack) * (0.4 + 0.6 * flow);
    this.emitAcc += rate * dt;
    let main = Math.floor(this.emitAcc);
    this.emitAcc -= main;
    if (seek) main = 0;

    // Beats.
    const live = !seek && dt > 0;
    const newHue = this.hue + centroidHue;
    const born = this.clock - dt;
    // Each hit's reactions are scaled by its own level, captured as it lands: a faint hit lights a
    // small patch whose front runs a short way and throws few, slow sparks; a hard one the full set.
    const sparks = (n: number, lv: number, k: number) => Math.floor(n * lv + fract(Math.sin((this.frame + k * 7.1) * 12.9898) * 43758.5453));
    if (live && mo.kickAge === 0) {
      const lv = strength(mo.kickLevel);
      this.kickHue += 0.1 * lv;
      this.lightTarget += 1.3 * lv;
      for (let k = 0; k < 3; k++) {
        const hue = fract(newHue + 0.13 + this.kickHue + k * 0.33);
        const a = g[4] * TAU + 2.39996 * mo.kicks + (k * TAU) / 3;
        const r = 0.2 + 0.18 * fract(mo.kicks * 0.618 + k * 0.37);
        const x = fx + Math.cos(a) * r * 1.4;
        const y = fy + Math.sin(a) * r;
        this.ignitions.push({ x, y, r: 0.09 * Math.sqrt(lv), hue, kind: 0, level: lv, born });
        this.bursts.push({ x, y, hue, count: sparks(3, lv, k), kind: 1, speed: 0.05 * (0.4 + 0.6 * lv) });
      }
    }
    if (live && mo.snareAge === 0) {
      const lv = strength(mo.snareLevel);
      // The colour turns toward this snare's angle (up to a third of a turn either way of home) by its level.
      const sh = fract(Math.sin(mo.snares * 12.9898 + g[0] * 78.233) * 43758.5453);
      const angle = (sh * 2 - 1) * 1.1 + (sh < 0.5 ? -0.8 : 0.8);
      this.turnTarget += (angle - this.turnTarget) * lv;
      for (let k = 0; k < 2; k++) {
        const hue = fract(newHue + 0.5 + 0.07 * mo.snares + k * 0.3);
        // Along the veil just off the line, where the gas is freshest.
        const along = (fract(mo.snares * 0.618 + k * 0.5) - 0.5) * u[23];
        const x = ex + tdx * along - tdy * 0.07;
        const y = ey + tdy * along + tdx * 0.07;
        this.ignitions.push({ x, y, r: 0.085 * Math.sqrt(lv), hue, kind: 1, level: lv, born });
        this.bursts.push({ x, y, hue, count: sparks(3, lv, k + 3), kind: 1, speed: 0.08 * (0.4 + 0.6 * lv) });
      }
    }
    if (live && mo.leadAge === 0) {
      const lv = this.noteLvl;
      const hue = fract(u[22] + 0.04);
      // The note lights the veil just behind the line, where its matter is densest.
      for (let k = 0; k < 2; k++) {
        const along = (k === 0 ? -0.25 : 0.25) * u[23];
        this.ignitions.push({ x: ex + tdx * along - tdy * 0.08, y: ey + tdy * along + tdx * 0.08, r: 0.15 * Math.sqrt(lv), hue, kind: 2, level: lv, born });
      }
    }
    // Each ignition's patch spreads out from its point over IGN_RISE, so a front eases in.
    this.ignitions = this.ignitions.filter((s) => this.clock - s.born < IGN_HOLD).slice(-IGN);
    for (let j = 0; j < IGN; j++) {
      const s = this.ignitions[j];
      if (!s) continue;
      const x = Math.min(1, (this.clock - s.born) / IGN_RISE);
      u[68 + j * 4] = s.x;
      u[69 + j * 4] = s.y;
      u[70 + j * 4] = s.r * (0.3 + 0.7 * x * x * (3 - 2 * x));
      u[71 + j * 4] = s.hue;
      u[92 + j * 4] = s.kind;
      u[93 + j * 4] = s.level;
    }
    // The fine scale (frequency maps to scale): the detail coordinates lay out the fine octaves; high
    // notes and backing chords turn them (eased counts), hats step their depth; the mids and the air
    // set their strength. Each high note, as it lands, warps the filaments around its place on the
    // veil (high notes toward the high end) in both the current and the rendered fine warp, and steps
    // the fine warp's depth for good (eased), swelling over ~0.2 s and settling over ~1 s.
    const D = mo.detailAt;
    u[136] = D[0];
    u[137] = D[1];
    u[138] = D[2] + mo.hatPhase * 0.35;
    u[139] = D[3];
    if (!seek && mo.upperAge === 0) {
      this.upperLvl = strength(mo.upperLevel);
      this.upperAlong = Math.max(-0.5, Math.min(0.5, mo.upperNote - 0.5));
      const along = this.upperAlong * u[23];
      this.upperX = ex + tdx * along - tdy * 0.06;
      this.upperY = ey + tdy * along + tdx * 0.06;
    }
    const ua = mo.upperAge / 0.22;
    const uEnv = ua * Math.exp(1 - ua) * this.upperLvl;
    u[140] = 0.015 + 0.04 * mo.detailDrive + 0.02 * m.mid;
    u[141] = 0.005 + 0.02 * mo.detailDrive + 0.015 * m.high;
    u[142] = 0.6 * mo.upperPhase + 0.35 * mo.backingPhase;
    u[143] = 0.35 * uEnv;
    u[144] = this.upperX;
    u[145] = this.upperY;
    u[146] = 0.2;
    u[148] = 0.002 + 0.004 * mo.detailDrive;
    u[149] = 0.03 * uEnv;
    u[150] = mo.upperPhase * 1.1 + mo.backingPhase * 0.3;
    let total = main;
    const bursts = live ? this.bursts.splice(0, BURSTS) : [];
    this.bursts = [];
    for (let k = 0; k < BURSTS; k++) {
      const b = bursts[k];
      if (!b) continue;
      u[36 + k * 4] = b.x;
      u[37 + k * 4] = b.y;
      u[38 + k * 4] = b.hue;
      u[39 + k * 4] = b.count;
      u[52 + k * 4] = b.kind;
      u[53 + k * 4] = b.speed;
      total += b.count;
    }
    u[33] = this.head;
    u[34] = main;
    u[35] = wave(at[3] * 0.7 + g[2] * 6, -0.12, 0.12); // emitter bow
    this.head = (this.head + total) % COUNT;

    // Light and finish.
    u[116] = -0.45;
    u[117] = 0.55;
    u[118] = 0.7;
    u[119] = 0.28; // rim
    u[120] = 0.95; // gain
    u[121] = 1.6; // shadow
    u[122] = 0.016; // deposit
    u[123] = 1.3; // spark gain
    u[124] = this.hue + 0.1;
    u[125] = wave(g[7] * 9, 1.6, 2.6);
    u[126] = g[0] * 13.7;
    u[127] = 6.0 * attack; // note boost

    // Lasting reactions, each gliding in from rest on a critically damped spring (half in by about
    // 0.3 s, settled by about 0.7 s): kicks swing the key light a step round the cloud, so its
    // billows are relit from a new side; snares turn the cloud's colour to a new angle, up to a third
    // of a turn either way of its home. (Melody notes already move and puff the emitter.)
    react(this.rx, 0, this.lightTarget, 5.5, dt);
    react(this.rx, 2, this.turnTarget, 5.5, dt);
    u[132] = this.rx[0];
    u[133] = this.rx[2];

    this.dt = dt;
    this.stepBurn(dt);
  }

  /** Burn steps for this frame at the grid's rate, and the blend toward the newest step. */
  private stepBurn(dt: number): void {
    const rate = BURN_RATE * this.burnScale;
    this.burnAcc += dt * rate;
    this.burnSteps = Math.min(24, Math.floor(this.burnAcc));
    this.burnAcc -= Math.floor(this.burnAcc);
    if (this.reset) this.burnSteps = Math.max(1, this.burnSteps);
    const u = this.u;
    u[3] = 1 / rate;
    u[128] = this.burnAcc;
    u[129] = 1 / this.burnScale;
    this.device.queue.writeBuffer(this.uBuffer, 0, u);
  }

  /** Reallocates the grids for a new render size, carrying the gas and burn across. */
  private resize(encoder: GPUCommandEncoder, width: number, height: number): void {
    const [gw, gh, bw, bh] = gridSize(width, height);
    const old = this.grids;
    if (gw === old.gw && gh === old.gh) return;
    const next = new Grids(this.device, this.layouts, this.uBuffer, gw, gh, bw, bh);
    if (!this.reset) {
      const cp = encoder.beginComputePass({ label: 'spectral-nebula-resize' });
      cp.setBindGroup(0, this.group0);
      const carry = (pipe: GPUComputePipeline, src: GPUTexture, dst: GPUTexture) => {
        cp.setPipeline(pipe);
        cp.setBindGroup(
          1,
          this.device.createBindGroup({
            layout: this.layouts.glow,
            entries: [
              { binding: 0, resource: { buffer: this.uBuffer } },
              { binding: 1, resource: src.createView() },
              { binding: 2, resource: dst.createView() },
            ],
          }),
        );
        cp.dispatchWorkgroups(Math.ceil(dst.width / 8), Math.ceil(dst.height / 8));
      };
      carry(this.pipes.resample, old.gas[this.gp], next.gas[this.gp]);
      for (const b of [0, 1]) carry(bw === old.bw ? this.pipes.resample : this.pipes.resampleNearest, old.burn[b], next.burn[b]);
      cp.end();
    }
    this.retired.push(old);
    this.grids = next;
    // The burn's step rate changed with its grid: redo this frame's steps at the new rate.
    this.burnAcc = 0;
    this.stepBurn(this.dt);
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    for (const r of this.retired) r.destroy();
    this.retired = [];
    this.resize(encoder, width, height);
    const P = this.pipes;
    const Gr = this.grids;
    const G = Gr.groups;
    if (this.dt > 0 || this.reset) {
      const cp = encoder.beginComputePass({ label: 'spectral-nebula-sim' });
      cp.setBindGroup(0, this.group0);
      cp.setPipeline(P.sim);
      cp.setBindGroup(1, this.sim);
      cp.dispatchWorkgroups(COUNT / 256);
      cp.setPipeline(P.flow);
      cp.setBindGroup(1, G.flow);
      cp.dispatchWorkgroups(Math.ceil(VW / 8), Math.ceil(VH / 8));
      cp.end();
      // This frame's matter, splatted onto its own grid (the gas step adds it in).
      const sp = encoder.beginRenderPass({
        label: 'spectral-nebula-splat',
        colorAttachments: [{ view: Gr.depView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      });
      sp.setPipeline(P.splat);
      sp.setBindGroup(0, this.group0);
      sp.setBindGroup(1, this.draw);
      sp.draw(6, COUNT);
      sp.end();
      const cp2 = encoder.beginComputePass({ label: 'spectral-nebula-gas' });
      cp2.setBindGroup(0, this.group0);
      cp2.setPipeline(P.burn);
      for (let k = 0; k < this.burnSteps; k++) {
        cp2.setBindGroup(1, G.burn[this.gp][this.bp]);
        cp2.dispatchWorkgroups(Math.ceil(Gr.bw / 8), Math.ceil(Gr.bh / 8));
        this.bp ^= 1;
      }
      cp2.setPipeline(P.gas);
      cp2.setBindGroup(1, G.gas[this.gp][this.bp]);
      cp2.dispatchWorkgroups(Math.ceil(Gr.gw / 8), Math.ceil(Gr.gh / 8));
      this.gp ^= 1;
      cp2.setPipeline(P.glow1);
      cp2.setBindGroup(1, G.glow1[this.gp]);
      cp2.dispatchWorkgroups(Math.ceil(G1W / 8), Math.ceil(G1H / 8));
      cp2.setPipeline(P.glow2);
      cp2.setBindGroup(1, G.glow2);
      cp2.dispatchWorkgroups(Math.ceil(G2W / 8), Math.ceil(G2H / 8));
      cp2.end();
      this.reset = false;
      this.dt = 0;
    }
    const pass = encoder.beginRenderPass({
      label: 'spectral-nebula',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setBindGroup(0, this.group0);
    pass.setPipeline(P.render);
    pass.setBindGroup(1, G.render[this.gp][this.bp]);
    pass.draw(3);
    pass.setPipeline(P.sparks);
    pass.setBindGroup(1, this.draw);
    pass.draw(6, COUNT);
    pass.end();
  }

  destroy(): void {
    for (const r of this.retired) r.destroy();
    this.grids.destroy();
    for (const r of this.owned) r.destroy();
  }
}

type Slot = 'tex' | 'out' | 'rw' | 'ro';

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
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const L: Layouts = {
      sim: layout(['rw'], C),
      draw: layout(['ro'], VF),
      flow: layout(['out'], C),
      gas: layout(['tex', 'tex', 'out', 'tex', 'tex'], C),
      burn: layout(['tex', 'tex', 'out', 'tex'], C),
      glow: layout(['tex', 'out'], C),
      render: layout(['tex', 'tex', 'tex', 'tex', 'tex'], VF),
    };
    const pl = (l: GPUBindGroupLayout) => device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, l] });
    const compute = async (code: string, name: string, l: GPUBindGroupLayout) =>
      device.createComputePipelineAsync({
        label: `spectral-nebula-${name}`,
        layout: pl(l),
        compute: { module: await compileModule(device, `${prelude}\n${code}`, `spectral-nebula-${name}`), entryPoint: 'main' },
      });
    const additive: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
    const draw = async (code: string, name: string, l: GPUBindGroupLayout, blend?: GPUBlendState) => {
      const module = await compileModule(device, `${prelude}\n${code}`, `spectral-nebula-${name}`);
      return device.createRenderPipelineAsync({
        label: `spectral-nebula-${name}`,
        layout: pl(l),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    const [sim, flow, gas, burn, glow1, glow2, resample, resampleNearest, splat, render, sparks] = await Promise.all([
      compute(SIM, 'sim', L.sim),
      compute(FLOW, 'flow', L.flow),
      compute(GAS, 'gas', L.gas),
      compute(BURN, 'burn', L.burn),
      compute(DOWN, 'glow1', L.glow),
      compute(glowWgsl(G2W, G2H, false), 'glow2', L.glow),
      compute(resampleWgsl(false), 'resample', L.glow),
      compute(resampleWgsl(true), 'resample-nearest', L.glow),
      draw(SPLAT, 'splat', L.draw, additive),
      draw(RENDER, 'render', L.render),
      draw(SPARKS, 'sparks', L.draw, additive),
    ]);

    const particles = device.createBuffer({ label: 'spectral-nebula-particles', size: COUNT * 48, usage: GPUBufferUsage.STORAGE });
    const uBuffer = device.createBuffer({ label: 'spectral-nebula-u', size: UVEC * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindBuf = (l: GPUBindGroupLayout) =>
      device.createBindGroup({
        layout: l,
        entries: [
          { binding: 0, resource: { buffer: uBuffer } },
          { binding: 1, resource: { buffer: particles } },
        ],
      });
    const paramBuffer = shared.createSceneParamBuffer('spectral-nebula-params');
    const group0 = shared.createSceneBindGroup(paramBuffer, 'spectral-nebula');
    return new NebulaInstance(
      device,
      group0,
      uBuffer,
      { sim, flow, gas, burn, glow1, glow2, resample, resampleNearest, splat, render, sparks },
      L,
      bindBuf(L.sim),
      bindBuf(L.draw),
      [particles, uBuffer, paramBuffer],
    );
  },
};

export default factory;
