import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';

const TAU = Math.PI * 2;
const morph = new Morph(1.0);
/** Lattice period in world units (the shader's MS_CELL). */
const MS_CELL = 2.4;

/** Flight state: lattice phase of the camera, eased heading, flight speed, event history. Reset on seeks. */
const st = { t: -1, seed: -1, q: [0, 0, 0], yaw: 0, pitch: 0, travel: 0, v: 0, pitch0: 0, pitch1: 0 };

/**
 * Burns of one kind of event, the latest and the one before. A new burn is lit only once the latest
 * is `gap` seconds old, so the one it pushes out has always finished; events in between merge.
 */
class Fronts {
  private n = -1;
  private t = -99;
  private tp = -99;
  count = 0;
  age = 99;
  prevAge = 99;
  constructor(private readonly gap: number) {}
  update(events: number, now: number, eventAge: number, reset: boolean, lit: () => void): void {
    if (reset || this.n < 0 || events < this.n) this.t = this.tp = -99;
    else if (events > this.n && now - eventAge - this.t >= this.gap) {
      this.tp = this.t;
      this.t = now - eventAge;
      this.count++;
      lit();
    }
    this.n = events;
    this.age = Math.min(now - this.t, 99);
    this.prevAge = Math.min(now - this.tp, 99);
  }
}
const kickF = new Fronts(0.45);
const snareF = new Fronts(0.6);
const noteF = new Fronts(0.6);

type Quat = [number, number, number, number];
const axisQuat = (x: number, y: number, z: number, a: number): Quat => {
  const s = Math.sin(a / 2);
  return [x * s, y * s, z * s, Math.cos(a / 2)];
};
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/**
 * Flight down a porous channel through an endless triply-periodic minimal surface, rendered as a
 * glossy solid: coloured chrome, deep lacquer or anodised metal reflecting a studio of two key
 * colours. The field is a weighted blend of five
 * families (gyroid, Schwarz P, Schwarz D, Neovius, Lidinoid) with analytic gradients.
 *
 * Every shape parameter is a morph coordinate: 0-1 the family blend (which surfaces and how pure),
 * 2 wall thickness, 3 level offset (one labyrinth swells as the other narrows), 4-6 the cell scale
 * per lattice axis, 7 the twist about the line of flight. A channel is carved along the flight with
 * a smooth max (so the lattice wraps round you as a porous tube, never crossing the lens); it bends
 * off to one side in the distance, so its far end sits off-centre and drifts with the morph.
 *
 * Music: energy sets the flow and the flight speed (steady; it eases only in long quiet). Beats
 * ignite burns that travel over the surface along a network of veins (a finer gyroid laid through
 * the lattice), so each front is ragged and branching and follows the structure:
 *  - kick: a fire lit on a wall ahead runs out along the veins (white, yellow, orange), leaves
 *    embers that cool, and behind it the lattice has a new lasting finish (colour and material);
 *  - snare: a fast crackle in the second colour runs along a new vein pattern, and behind it the
 *    metal's oxide film has grown a step, so its interference colours have moved on;
 *  - melody: a slow frost of the note's colour creeps out from a point at the pitch's height, and
 *    behind it the metal's iridescent sheen takes that colour; each note also turns the morph;
 *  - chords: lean the shape toward a region of its space.
 *
 * DNA: 0-1 start point and heading, 2 lens width, 3 palette offset, 5 light placement, fog and channel bend, 7 heading tilt.
 */
export default raymarchScene({
  meta: {
    id: 'minimal-surface',
    name: 'Minimal Surface',
    // Out of the show until fixed (gate: reactions do not register, motion does not follow the music).
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.55 },
    genres: { techno: 0.9, edm: 0.9, ambient: 1, synthwave: 0.8, dnb: 0.7, classical: 0.8, pop: 0.7, rock: 0.5, dubstep: 0.6, hiphop: 0.6 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);

    // Lattice: per-axis scale and twist from the morph.
    const k = TAU / MS_CELL;
    const sx = k * wave(a[4], 0.88, 1.12);
    const sy = k * wave(a[5], 0.88, 1.12);
    const sz = k * wave(a[6], 0.88, 1.12);
    const tw = wave(a[7], -0.05, 0.05);

    // Heading through the lattice: oblique to every axis, easing toward where the morph leans.
    const yawT = 0.35 + 0.8 * g[0] + 0.35 * Math.sin(a[3] * 0.5 + a[1] * 0.3);
    const pitchT = 0.3 + 0.35 * g[7] + 0.25 * Math.sin(a[2] * 0.4 - a[5] * 0.3);
    const seek = Math.abs(m.time - st.t - dt) > 0.5 || g[0] !== st.seed;
    st.t = m.time;
    if (seek) {
      st.seed = g[0];
      st.q = [g[1] * TAU, g[5] * TAU, g[6] * TAU];
      st.yaw = yawT;
      st.pitch = pitchT;
      st.travel = morph.travel;
      st.v = 0.6;
      st.pitch0 = st.pitch1 = morph.notePitch;
    }
    // Burns: the last two kick burns can both be in flight at once; each melody burn turns the
    // previous burn's pitch into its own.
    kickF.update(morph.kicks, m.time, morph.kickAge, seek, () => {});
    snareF.update(morph.snares, m.time, morph.snareAge, seek, () => {});
    noteF.update(morph.notes, m.time, morph.leadAge, seek, () => {
      st.pitch0 = st.pitch1;
      st.pitch1 = morph.notePitch;
    });
    const ease = 1 - Math.exp(-dt / 1.6);
    st.yaw += (yawT - st.yaw) * ease;
    st.pitch += (pitchT - st.pitch) * ease;
    const quat = qmul(qmul(axisQuat(0, 1, 0, st.yaw), axisQuat(1, 0, 0, st.pitch)), axisQuat(0, 0, 1, g[7] * TAU));
    const [x, y, z, w] = quat;
    const fwd = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];

    // Flight: the morph's steady travel (it only eases down after long quiet), never a beat.
    const step = Math.max(0, morph.travel - st.travel) * 2.0;
    st.travel = morph.travel;
    if (dt > 0) st.v += (step / dt - st.v) * (1 - Math.exp(-dt / 0.5));
    const sc = [sx, sy, sz];
    for (let i = 0; i < 3; i++) {
      st.q[i] += sc[i] * fwd[i] * step;
      st.q[i] -= Math.floor(st.q[i] / TAU) * TAU;
    }

    // Family blend: five families on a circle, a[0] travels round it, a[1] sets how pure.
    const sharp = wave(a[1], 2.5, 9);
    const raw = [0, 1, 2, 3, 4].map((i) => Math.exp(sharp * (Math.cos(a[0] - (i * TAU) / 5) - 1)));
    const sum = raw.reduce((s, x) => s + x, 0);
    const cut = raw.map((x) => (x / sum < 0.01 ? 0 : x));
    const sum2 = cut.reduce((s, x) => s + x, 0);
    const wn = cut.map((x) => x / sum2);

    const half = MS_CELL / 2;
    const thick = wave(a[2], 0.05, 0.12) * half;

    p[0] = st.q[0];
    p[1] = st.q[1];
    p[2] = st.q[2];
    p[3] = 0.95 + 0.3 * g[2];
    p[4] = sx;
    p[5] = sy;
    p[6] = sz;
    p[7] = tw;
    p.set(quat, 8);
    p[12] = wave(a[3], -0.08, 0.08);
    p[13] = thick;
    p[14] = kickF.prevAge;
    p[15] = snareF.count;
    p.set(wn.slice(0, 4), 16);
    p[20] = wn[4];
    p[21] = 0.99 * g[5];
    p[22] = g[3];
    // Which way the channel bends in the distance (so its end sits off-centre), drifting with the morph.
    p[23] = g[5] * TAU + 0.9 * Math.sin(a[1] * 0.5 + a[4] * 0.4);
    p[24] = kickF.age;
    p[25] = snareF.age;
    p[26] = noteF.age;
    p[27] = kickF.count;
    p[28] = st.pitch0;
    p[29] = noteF.count;
    p[30] = st.v;
    p[31] = st.pitch1;
  },
  wgsl: /* wgsl */ `
const MS_CELL: f32 = 2.4;
// The channel kept clear along the line of flight: radius in cells, carve softness in world units,
// how far it bends to the side in the distance, and where it narrows (in cells ahead).
const MS_CHAN: f32 = 0.66;
const MS_CK: f32 = 0.45;
const MS_BEND: f32 = 0.2;
const MS_BZ0: f32 = 6.0;
const MS_Z1: f32 = 1.6;
const MS_Z2: f32 = 5.5;
var<private> msR: mat3x3f;
// Lipschitz bound of the blended field in world units (each family's largest gradient, measured).
var<private> msLip: f32;
var<private> msBend: vec2f;

fn ms_qmat(q: vec4f) -> mat3x3f {
  let x = q.x; let y = q.y; let z = q.z; let w = q.w;
  return mat3x3f(
    1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
    2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
    2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
}

// Blended TPMS field in lattice space: xyz gradient, w value. Each family is scaled so its gradient
// on the surface is about 1, so blends keep a steady slope.
fn ms_field(q: vec3f) -> vec4f {
  let s = sin(q);
  let c = cos(q);
  var r = vec4f(0.0);
  let wG = S.p[4].x;
  if (wG > 0.0) {
    r += wG * vec4f(c.x * c.y - s.z * s.x, c.y * c.z - s.x * s.y, c.z * c.x - s.y * s.z, dot(s, c.yzx)) * 0.667;
  }
  let wP = S.p[4].y;
  if (wP > 0.0) {
    r += wP * vec4f(-s, c.x + c.y + c.z) * 0.77;
  }
  let wD = S.p[4].z;
  if (wD > 0.0) {
    let v = s.x * s.y * s.z + s.x * c.y * c.z + c.x * s.y * c.z + c.x * c.y * s.z;
    let gx = c.x * s.y * s.z + c.x * c.y * c.z - s.x * s.y * c.z - s.x * c.y * s.z;
    let gy = s.x * c.y * s.z - s.x * s.y * c.z + c.x * c.y * c.z - c.x * s.y * s.z;
    let gz = s.x * s.y * c.z - s.x * c.y * s.z - c.x * s.y * s.z + c.x * c.y * c.z;
    r += wD * vec4f(gx, gy, gz, v) * 0.67;
  }
  let wN = S.p[4].w;
  if (wN > 0.0) {
    let cc = vec3f(c.y * c.z, c.x * c.z, c.x * c.y);
    r += wN * vec4f(-3.0 * s - 4.0 * s * cc, 3.0 * (c.x + c.y + c.z) + 4.0 * c.x * c.y * c.z) * 0.39;
  }
  let wL = S.p[5].x;
  if (wL > 0.0) {
    let s2 = 2.0 * s * c;
    let c2 = c * c - s * s;
    let v = 0.5 * (s2.x * c.y * s.z + s2.y * c.z * s.x + s2.z * c.x * s.y)
          - 0.5 * (c2.x * c2.y + c2.y * c2.z + c2.z * c2.x) + 0.15;
    let gx = 0.5 * (2.0 * c2.x * c.y * s.z + c.x * s2.y * c.z - s.x * s.y * s2.z) + s2.x * (c2.y + c2.z);
    let gy = 0.5 * (2.0 * c2.y * c.z * s.x + c.y * s2.z * c.x - s.y * s.z * s2.x) + s2.y * (c2.z + c2.x);
    let gz = 0.5 * (2.0 * c2.z * c.x * s.y + c.z * s2.x * c.y - s.z * s.x * s2.y) + s2.z * (c2.x + c2.y);
    r += wL * vec4f(gx, gy, gz, v) * 0.78;
  }
  return r;
}

// The channel: x = signed clearance (positive inside it), yzw = its gradient. It runs along the
// line of flight and bends off to one side in the distance.
fn ms_chan(p: vec3f) -> vec4f {
  let bz = max(p.z, 0.0);
  let bf = bz * bz / (bz + MS_BZ0);
  let dbf = bz * (bz + 2.0 * MS_BZ0) / ((bz + MS_BZ0) * (bz + MS_BZ0));
  let qx = p.xy - msBend * bf;
  let rl = max(length(qx), 1e-4);
  let u = qx / rl;
  // Wide around the viewer, narrowing further ahead, so the lattice closes over the far end (no
  // fogged hole at the vanishing point) and opens like an iris as you approach.
  let x = sat((p.z - MS_Z1 * MS_CELL) / ((MS_Z2 - MS_Z1) * MS_CELL));
  let R0 = MS_CHAN * MS_CELL * (1.0 - 0.8 * x * x * (3.0 - 2.0 * x));
  let dR0 = -MS_CHAN * 0.8 * 6.0 * x * (1.0 - x) / (MS_Z2 - MS_Z1);
  // The cross-section is lobed and the lobes turn along the channel, so its far end is an
  // irregular, slowly turning opening rather than a round hole.
  let ang = 3.0 * atan2(u.y, u.x) + 0.5 * p.z / MS_CELL + S.p[5].w;
  let lob = 1.0 + 0.16 * sin(ang);
  let R = R0 * lob;
  let tn = vec2f(-u.y, u.x) * (R0 * 0.48 * cos(ang) / rl);
  let dz = dR0 * lob + R0 * 0.08 * cos(ang) / MS_CELL;
  return vec4f(R - rl, -u + tn, dot(u, msBend) * dbf + select(0.0, dz, p.z > 0.0));
}

// v: signed field less the level (its sign says which labyrinth), d: Newton distance to the sheet's
// face, s: a step toward it (capped), n: normal.
struct MsHit { v: f32, d: f32, s: f32, n: vec3f };

// Camera-frame point (camera at the origin, flying along +z): twisted about the line of flight,
// turned into the lattice, scaled per axis and offset by the camera's lattice phase. The gradient
// goes back through the same chain, so the distance is |f - level| / |grad f| in world units.
fn ms_map(p: vec3f) -> MsHit {
  let tw = S.p[1].w;
  let a = tw * p.z;
  let ca = cos(a);
  let sa = sin(a);
  let pt = vec3f(ca * p.x - sa * p.y, sa * p.x + ca * p.y, p.z);
  let sc = S.p[1].xyz;
  let fg = ms_field(S.p[0].xyz + sc * (msR * pt));
  let gt = transpose(msR) * (sc * fg.xyz);
  let gp = vec3f(ca * gt.x + sa * gt.y, -sa * gt.x + ca * gt.y, gt.z + tw * (pt.x * gt.y - pt.y * gt.x));
  let kmin = min(sc.x, min(sc.y, sc.z));
  let gl = length(gp);
  let v = fg.w - S.p[3].x;
  let dc = abs(v) / max(gl, 0.2 * kmin);
  var h: MsHit;
  h.v = v;
  h.d = dc - S.p[3].y;
  // Newton overshoots where the gradient is weak (it would step over a fold of the sheet), so the
  // step treats the gradient as at least 40% of its bound.
  h.s = min(0.9 * (abs(v) / max(gl, 0.4 * msLip) - S.p[3].y), 1.2 / kmin);
  h.n = gp * (sign(v) / max(gl, 1e-5));
  // The channel, carved with a smooth max: each membrane that reaches it curls back into a rounded
  // lip, so nothing ever crosses the lens and the way ahead stays open.
  let ch = ms_chan(p);
  let c = ch.x;
  let k = MS_CK;
  let m = sat(0.5 + 0.5 * (h.d - c) / k);
  h.d = mix(c, h.d, m) + k * m * (1.0 - m);
  h.n = normalize(mix(normalize(ch.yzw), h.n, m));
  h.s = max(h.s, 0.85 * c);
  h.v = v * sat((-c - k) / k);
  return h;
}

// The palette's two key colours, kept apart: if the palette is nearly one hue, the second is turned
// round the colour wheel so there are always two clearly distinct hues on screen.
fn ms_hueRot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735);
  let ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
var<private> msA: vec3f;
var<private> msB: vec3f;
var<private> msKey: vec3f;
var<private> msRim: vec3f;

// The studio the lattice reflects (camera frame): a deep two-tone ground, broad washes of the two
// key colours from opposite sides, two soft-edged panels and a long streak, so glossy tubes pick
// up clean bands of colour like lacquered glass.
fn ms_env(r: vec3f) -> vec3f {
  let a = sat(dot(r, msKey) * 0.5 + 0.5);
  let b = sat(dot(r, msRim) * 0.5 + 0.5);
  var c = msA * 0.04 + msB * 0.04;
  c += msA * 0.45 * a * a * a + msB * 0.4 * b * b * b;
  c += msA * 0.7 * smoothstep(0.8, 0.96, dot(r, msKey));
  c += msB * 0.55 * smoothstep(0.78, 0.95, dot(r, msRim));
  let sN = normalize(cross(msKey, msRim));
  c += mix(msA, msB, 0.5 + 0.5 * dot(r, msKey - msRim)) * 0.35 * exp(-abs(dot(r, sN)) * 14.0) * sat(r.z + 0.6);
  return c;
}

fn ms_fog(rd: vec3f) -> vec3f {
  let a = sat(dot(rd, normalize(vec3f(msBend, 1.0))));
  return mix(msB, msA, 0.5 + 0.5 * rd.x) * 0.008 + mix(msA, msB, 0.4) * 0.03 * pow(a, 4.0);
}

fn ms_ao(p: vec3f, n: vec3f) -> f32 {
  var o = 0.0;
  var w = 1.0;
  for (var i = 1; i <= 4; i++) {
    let h = MS_CELL * (0.02 + 0.06 * f32(i));
    o += (h - ms_map(p + n * h).d) * w;
    w *= 0.7;
  }
  return sat(1.0 - o / (MS_CELL * 0.18));
}

// How open the reflected view is: a short cone test along r, so reflections die in the pores.
fn ms_refOcc(p: vec3f, r: vec3f) -> f32 {
  var o = 1.0;
  for (var i = 1; i <= 3; i++) {
    let h = MS_CELL * 0.07 * f32(i * i);
    o = min(o, sat(ms_map(p + r * h).d / (0.45 * h)));
  }
  return o * o * (3.0 - 2.0 * o);
}

// Lattice coordinates of a camera-frame point.
fn ms_lat(p: vec3f) -> vec3f { return S.p[0].xyz + S.p[1].xyz * (msR * p); }

// Veins on the membrane: a finer gyroid laid through the lattice. Its zero set is a branching
// network of channels over every sheet; fronts conduct fast along it and slowly across it.
fn ms_vein(q: vec3f, f: f32, ph: f32) -> f32 {
  let u = q * f + vec3f(ph, 0.7 * ph, 1.3);
  return dot(sin(u), cos(u.yzx));
}

// Front speeds (world units per second).
const MS_KV: f32 = 13.0;
const MS_SV: f32 = 24.0;
const MS_LV: f32 = 8.0;

// Fronts burst out fast and slow as they spread (a blast, not a steady wave): their reach goes
// with the square root of the event's age.
// The first 0.4 s ease in from rest, so even the sheet at the spark catches gradually.
fn ms_warp(a: f32) -> f32 { return sqrt(a * 0.6) * smoothstep(0.0, 0.4, a); }
// A glow that swells in from nothing over r, then cools at rate k: never a flash.
fn ms_pulse(x: f32, r: f32, k: f32) -> f32 { return smoothstep(0.0, r, x) * exp(-max(x - r, 0.0) * k); }

// A lattice-fixed ignition point, carried back past the camera by the flight since the event.
fn ms_origin(o: vec3f, age: f32) -> vec3f { return o - vec3f(0.0, 0.0, age * S.p[7].z); }

// Arrival delay (seconds) of a burn front lit at o: the distance along the sheet, lengthened
// wherever the point lies off the vein network, so the front runs out along the veins in ragged,
// branching fingers and fills the gaps between them after.
fn ms_arrive(p: vec3f, o: vec3f, v1: f32, v2: f32, speed: f32, fing: f32) -> f32 {
  let q = ms_lat(p);
  let lobe = ms_vein(q, 0.45, 3.0);
  // The spark catches a patch at once (about a cell across), and the fire runs on from its edge.
  return (max(length(p - o) - 0.5 * MS_CELL, 0.0) + fing * MS_CELL * (0.8 * abs(v1) + 0.25 * abs(v2) + 0.9 * abs(lobe))) / speed;
}

// Fire by heat (1 = just lit): white core, yellow, orange, a deep red ember.
fn ms_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.22, 0.04) * h * 1.6 + vec3f(1.0, 0.6, 0.18) * h * h * 2.4 + vec3f(1.0, 0.95, 0.85) * pow(h, 6.0) * 3.0;
}

// The lasting finish of the lattice after k kick burns: a colour from the palette's whole range
// and one of three finishes (coloured chrome, deep lacquer, anodised iridescent metal).
struct MsMat { tint: vec3f, metal: f32, irid: f32 };
fn ms_mat(k: f32) -> MsMat {
  let sh = S.p[5].z;
  let h = hash11(k * 7.13 + floor(sh * 97.0));
  var m: MsMat;
  let kind = floor(h * 3.0);
  m.tint = mix(msA, msB, fract(k * 0.618 + sh)) * 0.6 + palL(sh + 0.75 * fract(k * 0.382), 0.4);
  m.metal = select(0.7, 1.0, kind != 1.0);
  m.irid = select(0.0, 1.0, kind == 2.0);
  return m;
}

fn ms_hit(rd: vec3f, ta: f32, tb: f32, pix: f32, steps: i32) -> f32 {
  var t = ta;
  for (var i = 0; i < steps; i++) {
    let h = ms_map(rd * t);
    if (h.d < pix * t) { return t; }
    t += max(h.s, pix * t * 0.5);
    if (t > tb) { return -1.0; }
  }
  return select(-1.0, t, t < tb);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  msR = ms_qmat(S.p[2]);
  let sc = S.p[1].xyz;
  msLip = (dot(S.p[4], vec4f(1.155, 1.334, 1.16, 2.73)) + S.p[5].x * 2.03) * max(sc.x, max(sc.y, sc.z)) * (1.0 + abs(S.p[1].w) * 4.0);
  let bang = S.p[5].w;
  msBend = MS_BEND * vec2f(cos(bang), 0.7 * sin(bang));
  let sh = S.p[5].z;
  let rig = fract(S.p[5].y);
  let focal = S.p[0].w;
  let cs = MS_CELL;
  let q2 = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let rd = normalize(vec3f(q2, focal));

  // Key colours: a warm and a cool end of the palette, forced apart if the palette is narrow.
  msA = palL(sh + 0.05, 1.0);
  var b = palL(sh + 0.5, 1.0);
  let ca = msA - vec3f(dot(msA, vec3f(0.3333)));
  let cb = b - vec3f(dot(b, vec3f(0.3333)));
  let sim = dot(ca, cb) / max(length(ca) * length(cb), 1e-4);
  b = mix(b, ms_hueRot(msA, 2.5), smoothstep(-0.2, 0.5, sim));
  msB = b;
  let ph = rig * 6.28;
  msKey = normalize(vec3f(0.85 * cos(ph), 0.6, 0.45 + 0.3 * sin(ph)));
  msRim = normalize(vec3f(-0.8 * cos(ph), -0.45, 0.6));

  let pix = 1.4 / (F.res.y * focal);
  let fogK = (0.3 + 0.12 * fract(rig * 5.3)) / cs;
  let fogC = ms_fog(rd);

  var col = fogC;
  let far = 7.0 * cs;
  let t = ms_hit(rd, 0.05 + 0.05 * ign(frag), far, pix, 150);
  if (t > 0.0) {
    let p = rd * t;
    let h = ms_map(p);
    let n = normalize(h.n * select(1.0, -1.0, dot(h.n, rd) > 0.0));
    let ct = sat(-dot(n, rd));
    let fre = pow(1.0 - ct, 5.0);
    let r = reflect(rd, n);
    let ao = ms_ao(p, n);
    let occ = ms_refOcc(p + n * pix * t * 2.0, r);
    let q = ms_lat(p);

    // ---- burn fronts ----
    // Kick: lit on a sheet ahead, it runs out along the veins and leaves the next finish behind.
    // The lasting state takes over within 0.35 s of reach everywhere (the c variants), so it is
    // complete before a newer burn can push this one out; the fire itself runs on as far as it goes.
    let v1 = ms_vein(q, 2.1, 0.0);
    let v2 = ms_vein(q, 5.3, 2.0);
    let kicks = S.p[6].w;
    let kA = S.p[6].x;
    let kA0 = S.p[3].z;
    let oK = vec3f(0.5 * sin(kicks * 2.4), 0.35 * cos(kicks * 1.7), 2.3) * cs;
    let oK0 = vec3f(0.5 * sin((kicks - 1.0) * 2.4), 0.35 * cos((kicks - 1.0) * 1.7), 2.3) * cs;
    let aK = ms_arrive(p, ms_origin(oK, kA), v1, v2, MS_KV, 1.0);
    let aK0 = ms_arrive(p, ms_origin(oK0, kA0), v1, v2, MS_KV, 1.0);
    let sK = ms_warp(kA) - aK;
    let sK0 = ms_warp(kA0) - aK0;
    let state = kicks - 2.0 + smoothstep(0.0, 0.2, ms_warp(kA0) - min(aK0, 0.35)) + smoothstep(0.0, 0.2, ms_warp(kA) - min(aK, 0.35));
    let m0 = ms_mat(floor(state));
    let m1 = ms_mat(floor(state) + 1.0);
    let mf = fract(state);
    let tint = mix(m0.tint, m1.tint, mf);
    let metal = mix(m0.metal, m1.metal, mf);
    let irid = mix(m0.irid, m1.irid, mf);

    // Snare: a fast crackle that runs only along the veins of a new pattern; behind it the metal's
    // oxide film has grown a step thicker, so its interference colours have moved on.
    let sA = S.p[6].y;
    let sN = S.p[3].w;
    let oS = vec3f(0.8 * sin(sN * 2.39 + 1.0), 0.5 * cos(sN * 1.3), 2.2) * cs;
    let vs = ms_vein(q, 1.7, sN * 1.7);
    let aS = ms_arrive(p, ms_origin(oS, sA), vs, v2, MS_SV, 1.6);
    let sS = ms_warp(sA) - aS;
    let etchW = 0.05 + pix * t * 3.0;
    let etchNew = smoothstep(etchW, 0.0, abs(vs));
    let oxide = sN - 1.0 + smoothstep(0.0, 0.2, ms_warp(sA) - min(aS, 0.35));

    // Melody: a slow frost of the note's colour creeping out from a point at the pitch's height;
    // behind it the iridescent sheen takes the new note's colour.
    let lA = S.p[6].z;
    let pNew = S.p[7].w;
    let pOld = S.p[7].x;
    let oL = vec3f(0.6 * sin(S.p[7].y * 2.1), 0.45 * pNew, 2.4) * cs;
    let aL = ms_arrive(p, ms_origin(oL, lA), v2, v1, MS_LV, 0.8);
    let sL = ms_warp(lA) - aL;
    let pitchHere = mix(pOld, pNew, smoothstep(0.0, 0.25, ms_warp(lA) - min(aL, 0.3)));
    let noteCol = palL(sh + 0.3 + 0.35 * pitchHere, 1.0);

    // ---- surface ----
    let ctT = sqrt(1.0 - (1.0 - ct * ct) / 1.9);
    let film = 0.5 - 0.5 * cos(TAU * (2.0 * 1.4 * (260.0 + 60.0 * ms_vein(q, 0.45, 3.0) + 90.0 * pitchHere + 70.0 * fract(oxide * 0.37) * 4.0) * ctT) / vec3f(650.0, 532.0, 450.0));
    let sheen = mix(vec3f(1.0), mix(film * 1.6, noteCol * 1.2, 0.35), 0.15 + 0.6 * irid);
    let tn = tint / max(max(tint.r, max(tint.g, tint.b)), 0.01);
    let f0 = mix(vec3f(0.04), mix(vec3f(0.8), tn, 0.5) * sheen, metal);
    let Fr = f0 + (vec3f(1.0) - f0) * fre;
    let env = ms_env(r) * (0.3 + 0.7 * occ);
    var c = env * Fr * (0.5 + 0.5 * ao);
    // A little body colour for the lacquer, lit by the key light.
    let dif = sat(dot(n, msKey)) * 0.7 + 0.3 * sat(dot(n, msRim));
    c += tint * (1.0 - metal) * 0.25 * dif * ao;

    // Fire on top: a hot ragged edge, embers along the veins cooling over a second or so. Every glow
    // swells in from nothing and is gone before its burn can be pushed out of its slot.
    let fadeK = 1.0 - smoothstep(vec2f(0.6), vec2f(0.9), vec2f(kA, kA0));
    let heatK = ms_pulse(sK, 0.08, 10.0) * exp(-kA * 3.5) * fadeK.x;
    let heatK0 = ms_pulse(sK0, 0.08, 10.0) * exp(-kA0 * 3.5) * fadeK.y;
    let vline = smoothstep(0.35, 0.0, abs(v1));
    let ember = vline * vline * (0.5 + 0.5 * sin(v2 * 9.0 + v1 * 4.0)) * ms_pulse(sK, 0.15, 2.5) * exp(-kA * 1.2) * fadeK.x;
    c += ms_fire(max(heatK, heatK0) * (0.1 + 0.9 * vline)) * 1.2;
    c += ms_fire(0.4) * ember * 0.35;
    // The spark that lights each fire: a hot bloom that swells on the walls round the ignition point.
    let fadeS = 1.0 - smoothstep(0.35, 0.6, sA);
    let fadeL = 1.0 - smoothstep(0.35, 0.6, lA);
    let dK = length(p - ms_origin(oK, kA)) / cs;
    c += ms_fire(0.7) * exp(-dK * dK * 3.0) * ms_pulse(kA, 0.15, 6.0) * (1.0 + 2.2 * vline);
    let dS = length(p - ms_origin(oS, sA)) / cs;
    c += mix(msB, vec3f(1.0), 0.3) * exp(-dS * dS * 3.5) * ms_pulse(sA, 0.15, 8.0) * fadeS * (0.6 + 2.2 * etchNew);
    let dL = length(p - ms_origin(oL, lA)) / cs;
    c += noteCol * exp(-dL * dL * 3.5) * ms_pulse(lA, 0.15, 6.0) * fadeL * (1.4 + 3.0 * smoothstep(0.3, 0.0, abs(v2)));
    // The snare's crackle: bright and thin, in the second colour, along its veins only.
    let sHeat = ms_pulse(sS, 0.06, 12.0) * exp(-sA * 4.0) * fadeS;
    c += mix(msB, vec3f(1.0), 0.45) * sHeat * (etchNew * 3.0 + 0.25);
    // The note's frost: a soft shimmer of its colour at the leading edge.
    let lHeat = ms_pulse(sL, 0.1, 6.0) * exp(-lA * 3.0) * fadeL;
    c += noteCol * lHeat * (0.3 + 0.9 * smoothstep(0.3, 0.0, abs(v2)));

    let fogT = exp(-t * fogK);
    col = mix(fogC, c, fogT);

  }
  // Soft shoulder: highlights roll off instead of clipping.
  let pk = max(col.r, max(col.g, col.b));
  col *= 1.0 / (1.0 + 0.4 * max(pk - 0.7, 0.0));
  return vec4f(col, 1.0);
}
`,
});
