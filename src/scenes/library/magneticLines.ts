import { particleScene } from '../particleScene';
import { Morph } from '../morph';
import type { Vec3 } from '../math';

/**
 * Field Lines: a million tracers streaming along magnetic / electric field lines. Each tracer
 * belongs to one line (a seed point plus a hair of jitter), so the tracers of a line follow one
 * trajectory and draw it as a glowing filament.
 *
 * The field itself is a morph: every source position, moment, charge, twist, q-profile, island,
 * winding ratio and external field is a periodic function of the morph coordinates, so the topology
 * keeps opening, closing and rewinding, and no appearance repeats. Motion is steady: the tracers
 * stream and the camera travels at the morph's pace, easing down only in long quiet.
 *
 * DNA
 *  0  field family: dipole magnetosphere, multipole ring, tokamak (flown inside), point charges,
 *     Hopf fibration
 *  1  colouring model and camera rig
 *  2  line count vs flux-tube thickness
 *  6  tracer speed and size
 *  7  hue offset, orbit phase
 *
 * Music (each beat changes the field for good, and the change travels):
 *  - kick: steps the field along the morph heading, and a broad front runs out from the centre;
 *    behind it a new set of lines carries the light and the colour has turned a step;
 *  - snare: steps the field across the heading, and a sharp front in the accent colour sweeps
 *    across; behind it a new set of lines wears the accent colour and the dashes have moved;
 *  - melody: each note turns the morph heading and spreads a ring outward that moves the layer of
 *    the note's colour to the height of its pitch;
 *  - chords: lean the field toward their own region of the morph and ease the hue;
 *  - energy: how fast the field transforms, the tracers stream and the camera travels.
 */

/** Dipole, multipole ring, tokamak, point charges, Hopf fibration. */
const FAMS = [0, 1, 2, 3, 5];
const TAU = Math.PI * 2;
const morph = new Morph(1.6, 4);
/** Eased chord hue, the last kick gap, the previous melody pitch (camera() runs the update). */
const st = { t: Number.NaN, hx: 1, hy: 0, kicks: 0, kickAge: 9, gap: 3.9, notes: 0, pitch: 0, prevPitch: 0 };

function fam(dna: readonly number[]) {
  return FAMS[Math.floor(dna[0] * FAMS.length) % FAMS.length];
}

const wrap = (x: number) => x - Math.floor(x / TAU) * TAU;
const ms = (age: number) => Math.round(Math.min(Math.max(age, 0), 3.9) * 1000);
const pq = (pitch: number) => Math.round((Math.max(-1, Math.min(1, pitch)) + 1) * 24);

export default particleScene({
  meta: {
    id: 'magnetic-lines',
    name: 'Field Lines',
    // Out of the show: Mostly empty black with sparse lines: not immersive.
    auto: false,
    energy: [0.2, 1],
    mood: { valence: 0.5, arousal: 0.6 },
    genres: { techno: 1, edm: 0.9, dnb: 0.85, jazz: 0.6, synthwave: 0.7, dubstep: 0.5, ambient: 0.6, classical: 0.5 },
    trails: 0.3,
    sparse: true,
    kaleido: false,
  },
  count: 1 << 20,
  camera(ctx) {
    const m = ctx.music;
    if (m.time !== st.t) {
      const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
      const hue = m.chord && m.chord.root >= 0 ? (((m.chord.root * 7) % 12) / 12) * TAU : 0;
      const k = Number.isNaN(st.t) || Math.abs(m.time - st.t) > 0.5 ? 1 : 1 - Math.exp(-dt / 1.5);
      st.hx += (Math.cos(hue) - st.hx) * k;
      st.hy += (Math.sin(hue) - st.hy) * k;
      st.t = m.time;
      morph.update(m, ctx.dt, ctx.dna);
      if (morph.kicks !== st.kicks) {
        // The gap since the previous kick tells the shader where the previous front has got to.
        st.gap = morph.kicks > st.kicks ? Math.min(st.kickAge + dt, 1.5) : 1.5;
        st.kicks = morph.kicks;
      }
      st.kickAge = morph.kickAge;
      if (morph.notes !== st.notes) {
        st.prevPitch = morph.notes > st.notes ? st.pitch : morph.notePitch;
        st.pitch = morph.notePitch;
        st.notes = morph.notes;
      }
    }
    const g = ctx.dna;
    const f = fam(g);
    const dolly = (g[1] * 7) % 1 > 0.5;
    const tr = morph.travel;
    const v = g[7] * TAU;
    let eye: Vec3;
    let target: Vec3 = [0, 0, 0];
    let fovY = 1.0;
    let roll = 0;
    const orbit = (r: number, el: number, a: number): Vec3 => [Math.cos(a) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(a) * Math.cos(el) * r];
    // Ride a circle of radius R (in the xz plane) looking ahead along it.
    const ride = (R: number, y: number, a: number, lead: number, Rt: number) => {
      eye = [Math.cos(a) * R, y, Math.sin(a) * R];
      target = [Math.cos(a + lead) * Rt, y * 0.4, Math.sin(a + lead) * Rt];
    };
    switch (f) {
      case 0: {
        // Among the outer shells of the magnetosphere.
        eye = orbit(2.7 + 0.3 * Math.sin(tr * 0.21 + v), 0.3 * Math.sin(tr * 0.13 + v), tr * 0.3 + v);
        target = [0.25 * Math.sin(tr * 0.17), 0.1 * Math.cos(tr * 0.11), 0.25 * Math.cos(tr * 0.17)];
        fovY = 1.15;
        roll = 0.12 * Math.sin(tr * 0.09);
        break;
      }
      case 2: {
        // Tokamak: drift round the hole in the middle, the plasma ring wrapped all round you.
        const a = tr * 0.3 + v;
        const y = 0.35 * Math.sin(tr * 0.17 + v);
        eye = [Math.cos(a) * 0.2, y, Math.sin(a) * 0.2];
        const ah = a + 0.9 + 0.25 * Math.sin(tr * 0.13);
        target = [Math.cos(ah) * 1.95, -0.4 * y, Math.sin(ah) * 1.95];
        fovY = 1.2;
        roll = 0.15 * Math.sin(tr * 0.11 + v);
        break;
      }
      case 5: {
        // Close orbit round the nested tori (riding inside them reads as mush).
        eye = orbit(2.25 + 0.25 * Math.sin(tr * 0.2), 0.45 * Math.sin(tr * 0.12 + v), tr * 0.26 + v);
        target = [0.3 * Math.sin(tr * 0.15 + v), 0, 0.3 * Math.cos(tr * 0.15 + v)];
        fovY = 1.1;
        roll = 0.15 * Math.sin(tr * 0.08 + v);
        break;
      }
      default: {
        if (dolly) {
          // Ride a circle just outside the sources, through the arches between them.
          ride(1.75, 0.25 * Math.sin(tr * 0.15 + v), tr * 0.28 + v, 0.85, 0.9);
          fovY = 1.2;
          roll = 0.2 * Math.sin(tr * 0.09 + v);
        } else {
          eye = orbit(2.1 + 0.3 * Math.sin(tr * 0.19 + v), 0.25 + 0.35 * Math.sin(tr * 0.11 + v), tr * 0.28 + v);
          target = [0.45 * Math.sin(tr * 0.13 + v), 0, 0.45 * Math.cos(tr * 0.13 + v)];
          fovY = 1.1;
          roll = 0.1 * Math.sin(tr * 0.07);
        }
      }
    }
    return { eye: eye!, target, fovY, roll };
  },
  // Long streaks draw each line as a continuous filament instead of a stream of shimmering dots.
  streak: () => 0.08,
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const f = fam(g);
    const lines = Math.round(180 * Math.pow(8, g[2]));
    const model = Math.floor(g[1] * 4) % 4;
    p[24] = f + 8 * model + 64 * lines;
    // Tracer speed (steady, easing down only in long quiet) and hue (DNA plus the eased chord).
    const speed = (1.3 + 1.3 * g[6]) * morph.flow * Math.sqrt(Math.min(Math.max(m.bpm, 70), 170) / 120);
    const hue = (g[7] + 0.12 * (Math.atan2(st.hy, st.hx) / TAU) + 1) % 1;
    p[25] = Math.round(speed * 200) * 4 + hue;
    // Morph angles, each carrying a small integer: kick, snare and note counts and the last pitch.
    const a = morph.at;
    p[26] = (morph.kicks % 256) * 8 + wrap(a[0]);
    p[27] = (morph.snares % 256) * 8 + wrap(a[1]);
    p[28] = (morph.notes % 256) * 8 + wrap(a[2]);
    p[29] = pq(st.prevPitch) * 8 + wrap(a[3]);
    // Event ages in ms, packed in pairs; the pitch (63 = no melody yet) and the kick gap ride along.
    p[30] = ms(morph.kickAge) * 4096 + ms(morph.snareAge);
    const pitch = morph.notes > 0 ? pq(st.pitch) : 63;
    p[31] = ms(morph.leadAge) * 4096 + pitch + 64 * Math.min(63, Math.round(st.gap * 40));
  },
  wgsl: /* wgsl */ `
var<private> ml_c: array<vec4f, 6>;
var<private> ml_m: array<vec4f, 6>;
var<private> ml_k: i32;
var<private> ml_fam: i32;
var<private> ml_ext: vec3f;
var<private> ml_tw: f32;
var<private> ml_rs: f32;
var<private> ml_q: vec4f;
var<private> ml_q2: vec4f;
var<private> ml_tor: vec2f;

fn ml_famOf() -> i32 { return i32(S.p[6].x) & 7; }
fn ml_model() -> i32 { return (i32(S.p[6].x) >> 3) & 7; }
fn ml_lines() -> u32 { return max(u32(S.p[6].x) >> 6u, 1u); }
fn ml_speed() -> f32 { return floor(S.p[6].y / 4.0) / 200.0; }
fn ml_hue() -> f32 { return fract(S.p[6].y); }
fn ml_ang(x: f32) -> f32 { return x - 8.0 * floor(x / 8.0); }
fn ml_cnt(x: f32) -> f32 { return floor(x / 8.0); }
fn ml_A() -> vec4f { return vec4f(ml_ang(S.p[6].z), ml_ang(S.p[6].w), ml_ang(S.p[7].x), ml_ang(S.p[7].y)); }
fn ml_hi(x: f32) -> f32 { return floor(x / 4096.0); }
fn ml_lo(x: f32) -> f32 { return x - floor(x / 4096.0) * 4096.0; }
fn ml_kickAge() -> f32 { return ml_hi(S.p[7].z) / 1000.0; }
fn ml_snareAge() -> f32 { return ml_lo(S.p[7].z) / 1000.0; }
fn ml_leadAge() -> f32 { return ml_hi(S.p[7].w) / 1000.0; }
fn ml_pitchQ() -> f32 { return ml_lo(S.p[7].w) % 64.0; }
fn ml_gap() -> f32 { return floor(ml_lo(S.p[7].w) / 64.0) / 40.0; }
fn ml_w(x: f32) -> f32 { return 0.5 + 0.5 * sin(x); }

fn ml_basis(n: vec3f) -> mat3x3f {
  let a = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let u = normalize(cross(n, a));
  return mat3x3f(u, cross(n, u), n);
}

// Sources for this frame, all from the morph angles. Cheap enough to run per invocation.
fn ml_setup() {
  ml_fam = ml_famOf();
  let A = ml_A();
  ml_k = 0;
  ml_rs = 0.25;
  ml_ext = vec3f(0.0);
  ml_tw = 0.45 * sin(A.z + A.w) * ml_w(A.x - A.y);
  switch ml_fam {
    case 0: {
      // A tilting dipole in a wind, with a second offset dipole fading in and out: the lobes
      // open, close and split as the morph moves.
      ml_k = 2;
      ml_rs = 0.32;
      let th = 0.55 * sin(A.x);
      let m0 = vec3f(sin(th) * cos(A.y), cos(th), sin(th) * sin(A.y));
      ml_c[0] = vec4f(0.0, 0.0, 0.0, 1.0);
      ml_m[0] = vec4f(m0, 1.0);
      let w2 = 0.45 * ml_w(A.x + A.z) * ml_w(A.w * 2.0);
      let off = vec3f(cos(A.z), 0.5 * sin(A.w), sin(A.z)) * 0.7;
      let m1 = normalize(vec3f(sin(A.w), cos(A.y + A.z), cos(A.w)));
      ml_c[1] = vec4f(off, 1.0);
      ml_m[1] = vec4f(m1 * w2, w2);
      let wa = A.z * 2.0 + A.y;
      ml_ext = vec3f(cos(wa), 0.3 * sin(A.w + A.x), sin(wa)) * (0.015 + 0.13 * ml_w(A.w - A.x));
    }
    case 1: {
      // Ring of dipoles: count, radius, heights, strengths and the orientation mode all flow.
      ml_k = 6;
      ml_rs = 0.19;
      let cnt = 2.3 + 3.7 * ml_w(A.x);
      let R = 0.8 + 0.35 * sin(A.y);
      let al = A.z;
      let be = A.w * 2.0;
      for (var i = 0; i < 6; i++) {
        let fi = f32(i);
        let wt = sat(cnt - fi);
        let a = TAU * fi / cnt + A.y * 0.5 + A.w;
        let pos = vec3f(cos(a) * R, 0.3 * sin(A.w + fi * 2.1) * sin(A.x + fi), sin(a) * R);
        let sg = select(1.0, -1.0, (i & 1) == 1);
        let tg = vec3f(-sin(a), 0.0, cos(a));
        let rd = vec3f(cos(a), 0.0, sin(a));
        let m = normalize(vec3f(0.0, sg * cos(al), 0.0) + sin(al) * (cos(be) * tg + sin(be) * rd * sg) + vec3f(1e-4));
        let str = (0.3 + 0.15 * sin(A.x * 2.0 + fi * 1.7)) * wt;
        ml_c[i] = vec4f(pos, 1.0);
        ml_m[i] = vec4f(m * str, wt);
      }
    }
    case 2: {
      // Tokamak: q profile (axis and edge), two island chains, elongation, minor radius.
      let q0 = 1.0 + 0.9 * ml_w(A.x);
      let q1 = q0 + 0.7 + 1.8 * ml_w(A.y);
      ml_q = vec4f(q0, q1, 0.07 * ml_w(A.z), 0.06 * ml_w(A.z + A.w + 2.0));
      ml_q2 = vec4f(1.0 + 0.4 * sin(A.w), A.x + A.y * 2.0, 0.0, 0.0);
      ml_tor = vec2f(1.95, 0.95 + 0.15 * sin(A.y - A.z));
      ml_tw = 0.0;
    }
    case 3: {
      // Point charges on a deforming shell; magnitudes and the active count flow.
      ml_k = 6;
      ml_rs = 0.16;
      let cnt = 2.4 + 3.6 * ml_w(A.w);
      let rot = rotY(A.x) * rotX(A.y);
      for (var i = 0; i < 6; i++) {
        let fi = f32(i);
        let wt = sat(cnt - fi);
        let y = 1.0 - 2.0 * (fi + 0.5) / 6.0;
        let r = sqrt(max(1.0 - y * y, 0.0));
        let th = fi * 2.39996 + 0.4 + 0.5 * sin(A.z + fi);
        let pos = vec3f(cos(th) * r, y, sin(th) * r) * (0.85 + 0.3 * sin(A.z * 2.0 + fi * 1.7));
        let sg = select(1.0, -1.0, (i & 1) == 1);
        ml_c[i] = vec4f(rot * pos, sg * (0.55 + 0.45 * sin(A.w + fi * 2.3)) * wt);
        ml_m[i] = vec4f(0.0, 0.0, 0.0, wt);
      }
    }
    default: {
      // Hopf / torus-knot fibration with a continuously varying winding ratio.
      ml_q = vec4f(1.0, 0.45 + 2.1 * ml_w(A.x), 1.1 + 0.2 * sin(A.y), 0.0);
      ml_ext = vec3f(sin(A.z), 0.0, cos(A.z)) * 0.25 * ml_w(A.w);
      ml_tw *= 0.4;
    }
  }
}

fn ml_tok(p: vec3f) -> vec3f {
  let R0 = ml_tor.x;
  let a = ml_tor.y;
  let kap = ml_q2.x;
  let R = max(length(p.xz), 0.05);
  let eh = vec3f(p.x, 0.0, p.z) / R;
  let ph = vec3f(-p.z, 0.0, p.x) / R;
  // Elongated cross-section: the circular field mapped through y -> kap * y.
  let x = R - R0;
  let yy = p.y / kap;
  let r = max(length(vec2f(x, yy)), 1e-3);
  let th = atan2(yy, x);
  let rn = r / a;
  let q = ml_q.x + (ml_q.y - ml_q.x) * rn * rn;
  let bt = R0 / R;
  let bp = r * bt / (q * R);
  let phi = atan2(p.z, p.x);
  let isl = bt * rn * (ml_q.z * sin(2.0 * th - phi + ml_q2.y) + ml_q.w * sin(3.0 * th - phi - ml_q2.y * 0.7));
  // Poloidal (tangent) and radial unit vectors in the (R, y) plane, mapped by the elongation.
  let tx = -sin(th) * bp + cos(th) * isl;
  let ty = (cos(th) * bp + sin(th) * isl) * kap;
  return bt * ph + tx * eh + vec3f(0.0, ty, 0.0);
}

fn ml_hopf(p: vec3f) -> vec3f {
  let q = vec3f(p.x, p.z, p.y) / ml_q.z;
  let P = vec3f(2.0 * q.x * q.z, 2.0 * q.y * q.z, 1.0 - q.x * q.x - q.y * q.y + q.z * q.z);
  let T = vec3f(-2.0 * q.y, 2.0 * q.x, 0.0);
  let v = P * ml_q.x + T * ml_q.y;
  return vec3f(v.x, v.z, v.y);
}

fn ml_field(p: vec3f) -> vec3f {
  if (ml_fam == 2) { return ml_tok(p); }
  if (ml_fam == 5) { return ml_hopf(p) + ml_ext * 2.0; }
  var b = ml_ext;
  for (var i = 0; i < ml_k; i++) {
    let d = p - ml_c[i].xyz;
    let r2 = dot(d, d) + 1e-4;
    let ir = inverseSqrt(r2);
    if (ml_fam == 3) {
      b += ml_c[i].w * d * (ir * ir * ir);
    } else {
      let m = ml_m[i].xyz;
      let n = d * ir;
      b += (3.0 * dot(m, n) * n - m) * (ir * ir * ir);
    }
  }
  return b;
}

fn ml_dir(p: vec3f) -> vec3f {
  let b = ml_field(p);
  let t = b / max(length(b), 1e-9);
  // Twist: the lines wind into helices around the vertical axis.
  let sw = vec3f(-p.z, 0.0, p.x) * ml_tw * exp(-dot(p, p) * 0.2);
  return normalize(t + sw + vec3f(1e-7));
}

fn ml_near(p: vec3f) -> f32 {
  var d = 1.0;
  for (var i = 0; i < ml_k; i++) {
    if (ml_m[i].w > 0.05) { d = min(d, length(p - ml_c[i].xyz) / max(ml_m[i].w, 0.3)); }
  }
  return d;
}

fn ml_dead(p: vec3f, arc: f32) -> bool {
  switch ml_fam {
    case 2: {
      let x = length(p.xz) - ml_tor.x;
      return length(vec2f(x, p.y / ml_q2.x)) > ml_tor.y * 1.25;
    }
    case 3: {
      if (dot(p, p) > 13.0) { return true; }
      for (var i = 0; i < ml_k; i++) {
        if (ml_c[i].w < 0.0 && length(p - ml_c[i].xyz) < ml_rs * 0.7) { return true; }
      }
      return false;
    }
    case 5: { return dot(p, p) > 12.0; }
    default: {
      if (dot(p, p) > 13.0) { return true; }
      if (arc < ml_rs * 1.5) { return false; }
      return ml_near(p) < ml_rs * 0.8;
    }
  }
}

fn ml_maxLen() -> f32 {
  return select(select(8.5, 10.0, ml_fam == 5), 10.0, ml_fam == 2);
}

fn ml_seed(lid: u32, j: vec3f) -> vec3f {
  let h = hashU3(lid * 2654435761u + 977u);
  switch ml_fam {
    case 2: {
      let shells = 6.0;
      let r = ml_tor.y * (0.14 + 0.84 * (floor(h.x * shells) + 0.5) / shells);
      let phi = h.y * TAU;
      let al = h.z * TAU;
      let eh = vec3f(cos(phi), 0.0, sin(phi));
      return eh * (ml_tor.x + r * cos(al)) + vec3f(0.0, r * sin(al) * ml_q2.x, 0.0) + j;
    }
    case 3: {
      // Seed on the positive charges (even slots), spread over each charge's sphere.
      let kk = i32(lid % 3u) * 2;
      let i = f32(lid / 3u);
      let n = max(f32(ml_lines() / 3u), 1.0);
      let y = 1.0 - 2.0 * (i + 0.5) / n;
      let r = sqrt(max(1.0 - y * y, 0.0));
      let th = i * 2.39996;
      return ml_c[kk].xyz + vec3f(cos(th) * r, y, sin(th) * r) * ml_rs + j;
    }
    case 5: {
      let rho = ml_q.z * mix(0.35, 0.93, (floor(h.x * 6.0) + 0.5) / 6.0);
      let az = h.y * TAU;
      return vec3f(cos(az) * rho, 0.0, sin(az) * rho) + j;
    }
    default: {
      let kk = select(i32(lid % 6u), 0, ml_fam == 0);
      let c = ml_c[kk].xyz;
      let B = ml_basis(normalize(ml_m[kk].xyz + vec3f(1e-5, 1e-4, 0.0)));
      var th0 = mix(0.12, 1.25, h.x);
      if (ml_fam == 0) {
        // Discrete L-shells of a dipole: sin^2(theta0) = rs / L.
        let L = mix(0.7, 3.4, pow((floor(h.x * 7.0) + 0.5) / 7.0, 0.8));
        th0 = asin(sqrt(min(ml_rs / L, 1.0)));
      }
      let az = h.y * TAU;
      return c + B * vec3f(sin(th0) * cos(az), sin(th0) * sin(az), cos(th0)) * ml_rs + j;
    }
  }
}

// How much a line's source is present (lines from fading sources fade with it).
fn ml_lineWeight(lid: u32) -> f32 {
  if (ml_fam == 1) { return ml_m[lid % 6u].w; }
  if (ml_fam == 3) { return ml_m[(lid % 3u) * 2u].w; }
  return 1.0;
}

// Each tracer's lifetime is fixed, so shade() knows its age and can fade it in as well as out.
fn ml_life(idx: u32) -> f32 { return 1.6 + 3.0 * hashU(idx * 31u + 7u); }

fn simulate(idx: u32, p: ptr<function, Particle>) {
  ml_setup();
  let dt = min(F.dt, 1.0 / 30.0);
  let nl = ml_lines();
  let lid = idx % nl;
  var life = (*p).pos.w;
  var pos = (*p).pos.xyz;
  var arc = floor((*p).vel.w) / 64.0;
  let speed = ml_speed();
  if (life <= 0.0 || ml_dead(pos, arc)) {
    let seed = pcg(idx * 1664525u + pcg(u32(F.frame) + 31u));
    let g2 = log(f32(nl) / 180.0) / log(8.0);
    let tubeScale = select(select(1.0, ml_rs * 1.5, ml_fam == 3), ml_rs * 0.4, ml_fam <= 1);
    let tube = (0.002 + 0.022 * (1.0 - g2) * (1.0 - g2)) * tubeScale;
    let jr = hashU3(seed) * 2.0 - 1.0;
    pos = ml_seed(lid, jr * tube);
    // Start somewhere along the line so lines fill instantly; reject if the line is shorter.
    let goal = hashU(seed + 3u) * ml_maxLen();
    arc = 0.0;
    var dead = false;
    for (var s = 0; s < 64; s++) {
      if (arc >= goal) { break; }
      var h = min((goal - arc) / f32(64 - s), 0.16);
      if (ml_fam == 0 || ml_fam == 1 || ml_fam == 3) { h = min(h, max(0.012, 0.22 * ml_near(pos))); }
      let d1 = ml_dir(pos);
      let d2 = ml_dir(pos + d1 * h * 0.5);
      pos += d2 * h;
      arc += h;
      if (ml_dead(pos, arc)) { dead = true; break; }
    }
    life = select(ml_life(idx), -1.0, dead);
    (*p).vel = vec4f(0.0, 0.0, 0.0, floor(arc * 64.0));
    (*p).pos = vec4f(pos, life);
    return;
  }
  let h = speed * dt;
  let d1 = ml_dir(pos);
  let d2 = ml_dir(pos + d1 * h * 0.5);
  let np = pos + d2 * h;
  let bm = length(ml_field(np));
  let st = bm / (bm + select(1.2, 0.8, ml_fam == 2 || ml_fam == 5));
  arc = min(arc + h, 4000.0);
  life -= dt;
  (*p).vel = vec4f(d2 * speed, floor(arc * 64.0) + min(st, 0.999));
  (*p).pos = vec4f(np, life);
}

// A coin per line for one beat state (states differ beat to beat, so each beat re-deals the lines).
fn ml_deal(lid: u32, state: f32, salt: u32) -> f32 {
  return hashU(lid * 92821u + u32(state + 1024.0) * 7919u + salt);
}

// 1 behind a front at f (on the near side of it), 0 ahead.
fn ml_behind(x: f32, f: f32, w: f32) -> f32 { return smoothstep(f + w, f - w, x); }

fn shade(p: Particle, idx: u32) -> Shade {
  ml_setup();
  let nl = ml_lines();
  let lid = idx % nl;
  let arc = floor(p.vel.w) / 64.0;
  let st = fract(p.vel.w);
  let lh = hashU3(lid * 747796405u + 17u);
  let model = ml_model();
  let fam = ml_fam;
  let eye = S.p[4].xyz;
  let pos = p.pos.xyz;
  let dist = distance(pos, eye);
  let hue0 = ml_hue();

  // Kick: a broad front runs out from the centre (from the eye inside the tokamak). Behind it a
  // new set of lines carries the light and the colour has turned a step, for good. The previous
  // front is tracked too, so a kick never lands on a half-finished change.
  let ka = ml_kickAge();
  let kc = select(length(pos), dist, fam == 2);
  let kv = 20.0;
  let f1 = 0.1 + ka * kv;
  let f0 = 0.1 + (ka + ml_gap()) * kv;
  let ks = ml_cnt(S.p[6].z) - 2.0 + ml_behind(kc, f0, 0.3) + ml_behind(kc, f1, 0.3);
  let kA = floor(ks);
  let kF = smoothstep(0.0, 1.0, ks - kA);
  let lit = mix(step(ml_deal(lid, kA, 1u), 0.55), step(ml_deal(lid, kA + 1.0, 1u), 0.55), kF);
  let kGlow = exp(-(kc - f1) * (kc - f1) * 2.0) * exp(-ka * 3.0);

  // Snare: a sharp plane front in the accent colour sweeps across. Behind it a new set of lines
  // wears the accent colour and the dashes along every line have moved on.
  let sa = ml_snareAge();
  let sN = ml_cnt(S.p[6].w);
  let dn = normalize(hashU3(u32(sN) * 977u + 3u) - 0.5);
  let sc = dot(pos, dn) + 3.4;
  let sf = sa * 24.0;
  let ss = sN - 1.0 + ml_behind(sc, sf, 0.06);
  let sA = floor(ss);
  let sF = ss - sA;
  let accent = mix(step(ml_deal(lid, sA, 5u), 0.22), step(ml_deal(lid, sA + 1.0, 5u), 0.22), sF);
  let dph = lh.z * TAU + ss * TAU * 0.3125;
  let dash = smoothstep(-0.35, 0.75, sin(arc * 6.0 - dph));
  let sGlow = exp(-(sc - sf) * (sc - sf) * 30.0) * exp(-sa * 3.0);

  var hue = hue0 + ks * 0.0625;
  var bright = 1.0;
  switch model {
    case 0: { hue += lh.y * 0.3; }
    case 1: { hue += 0.1 + st * 0.4; bright = 0.6 + 1.0 * st * st; }
    case 2: { hue += floor(lh.z * 3.0) / 3.0 * 0.45; }
    default: { hue += arc * 0.05 + lh.y * 0.1; }
  }
  hue += 0.5 * accent;
  var col = palL(hue, 1.0);
  col = mix(col, palL(hue + 0.25, 1.1), 0.2 * st);
  bright *= mix(0.3, 1.0, lit) * (0.5 + 0.7 * dash);


  // Melody: a ring spreads outward from the centre; behind it the layer of the note's colour sits
  // at the new pitch's height, ahead of it the previous note's layer remains.
  let pQ = ml_pitchQ();
  var mel = 0.0;
  var melHue = hue0;
  var mGlow = 0.0;
  if (pQ < 62.5) {
    let la = ml_leadAge();
    let pitch = pQ / 24.0 - 1.0;
    let prev = ml_cnt(S.p[7].y) / 24.0 - 1.0;
    var rr = length(pos.xz);
    var span = 1.0;
    if (fam == 2) {
      let d = atan2(pos.z, pos.x) - atan2(eye.z, eye.x);
      rr = abs(d - TAU * round(d / TAU)) * ml_tor.x;
      span = ml_tor.y * ml_q2.x * 0.85;
    }
    let fr = 0.15 + la * 10.0;
    let bn = ml_behind(rr, fr, 0.25);
    let pp = mix(prev, pitch, bn);
    let dy = pos.y - pp * span * 1.05;
    mel = exp(-dy * dy * 20.0);
    melHue = hue0 + 0.33 + 0.35 * pp;
    mGlow = exp(-(rr - fr) * (rr - fr) * 4.0) * exp(-la * 2.5) * exp(-dy * dy * 3.0);
  }
  col = mix(col, palL(melHue, 1.3), mel * 0.75);
  bright *= 1.0 + 0.6 * mel;

  // Light on the fronts themselves (the lasting change is what they leave behind).
  // Soft-capped, and kept off the lines right by the lens, so a front never blooms into a blob.
  let gl = (4.5 * kGlow + 8.0 * sGlow + 9.0 * mGlow) * smoothstep(1.0, 2.2, dist);
  bright *= 1.0 + gl / (1.0 + 0.12 * gl);
  col = mix(col, palL(hue0 + 0.5, 1.4), sat(sGlow * 0.8));

  // Lines crowd together at the poles: compensate so the sources glow instead of clipping.
  bright *= mix(1.0, 0.16, st * st) * ml_lineWeight(lid);
  bright *= 0.8 + 0.3 * F.intensity;
  // Keep per-line brightness steady across line counts, and total brightness steady too.
  let norm = pow(f32(nl), 0.55) * 0.0075;
  // Clearance in front of the lens, and depth falloff.
  let near = select(smoothstep(0.6, 1.4, dist), smoothstep(0.75, 1.7, dist), fam == 2);
  let depth = exp(-dist * 0.08);
  let fade = smoothstep(0.0, 0.4, p.pos.w) * smoothstep(0.0, 0.4, ml_life(idx) - p.pos.w);
  var s: Shade;
  s.color = col * bright * norm * fade * near * depth;
  s.size = 0.0026 + 0.003 * lh.z;
  return s;
}

fn background(uv: vec2f, rd: vec3f) -> vec3f {
  ml_setup();
  let eye = S.p[4].xyz;
  let hue = ml_hue();
  var c = palRampL(0.06 + 0.1 * sat(rd.y * 0.5 + 0.5), 0.003 + 0.005 * sat(rd.y * 0.5 + 0.5));
  if (ml_fam == 0 || ml_fam == 1 || ml_fam == 3) {
    // Soft steady halos around the poles / charges.
    for (var i = 0; i < ml_k; i++) {
      let to = ml_c[i].xyz - eye;
      let dist = length(to);
      let ca = max(1.0 - dot(rd, to / dist), 0.0);
      let w = 0.05 / (dist * dist);
      let h = hue + select(0.0, 0.5, ml_c[i].w < 0.0) + f32(i) * 0.13;
      c += palL(h, 1.0) * exp(-ca / w * 1.5) * 0.012 * ml_m[i].w;
    }
  } else {
    let fwd = normalize(S.p[5].xyz);
    c += palL(hue + 0.3, 0.012) * pow(max(dot(rd, fwd), 0.0), 3.0);
  }
  return c;
}
`,
});
