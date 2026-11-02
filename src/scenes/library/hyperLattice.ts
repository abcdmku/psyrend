import type { MusicState } from '../../audio/musicState';
import { raymarchScene } from '../raymarchScene';

/** Music clock: travel and 4D rotation surge on each beat and rest between beats and in silence. */
const mc = { travel: 0, turn: 0, rate: 0 };
function tick(m: MusicState, dtIn: number): void {
  const dt = Math.min(Math.max(dtIn, 0), 0.1);
  const beat = 60 / Math.max(40, m.bpm);
  const tempo = Math.sqrt(Math.max(60, m.bpm) / 120);
  const surge = 0.35 + (0.65 * m.beatPulse) / Math.min(1, 0.12 / beat);
  mc.rate = tempo * (0.05 + 1.1 * m.energy + 0.6 * m.dropPulse) * surge;
  mc.travel += dt * mc.rate;
  const barMean = Math.min(1, 0.25 / (beat * m.beatsPerBar));
  mc.turn += dt * tempo * (0.05 + 0.9 * m.energySlow) * (0.2 + (0.8 * m.barPulse) / barMean);
}

/**
 * Lattices of 4D polytopes rotating in several 4D planes and projected to 3D. Edges
 * are beams, one spectrum band per edge group; vertices are joints. The 4D rotation and the
 * flight advance only with the music (a surge on each beat). The melody is a level of light:
 * every beam and joint crossing the height set by the pitch flares on each note and glows
 * while it is held. Kicks swell the beams and send pulses along them; each snare turns every
 * polytope a step through the fourth dimension. Chords glide the 4D orientation, builds
 * compress the lattice while the colour drains, and drops snap to a new orientation.
 *
 * Not used by auto-direction (see meta): thin emissive wireframes on black leave most of the
 * frame empty, and the per-pixel analytic polytope DDA costs several times the GPU budget.
 *
 * DNA picks the polytope (tesseract, 16-cell, 5-cell, 24-cell, 3-p duoprism; edges
 * are found generically as the shortest vertex pairs), the lattice layout (full cubic,
 * tunnel, sparse constellation, two-layer sandwich, one giant polytope seen from
 * outside; only cubic, tunnel and sandwich are used), the camera rig (forward flight,
 * corkscrew, sideways strafe, rising crane), the material (neon beams, chrome tubes, dashed
 * data-flow, ghost glass), the beat grammar (pulses along edges, beat-stepped pulses, larger
 * snare flips), density, and the colour model (edge groups, mono, depth, 4D w).
 */

type Mat4 = number[]; // column-major 4x4

const ident = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
/** Rotation in the plane spanned by axes i and j. */
function planeRot(i: number, j: number, a: number): Mat4 {
  const m = ident();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[i * 4 + i] = c;
  m[j * 4 + j] = c;
  m[i * 4 + j] = s;
  m[j * 4 + i] = -s;
  return m;
}
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// Planes: XW, YW, ZW, XY, XZ, YZ.
const PLANES: [number, number][] = [[0, 3], [1, 3], [2, 3], [0, 1], [0, 2], [1, 2]];
const RATES = [0.31, 0.23, 0.17, 0.09, 0.07, 0.05];

const state = {
  phase: 0,
  snap: [0, 0, 0, 0, 0, 0],
  snapTarget: [0, 0, 0, 0, 0, 0],
  chord: [0, 0, 0, 0, 0, 0],
  chordTarget: [0, 0, 0, 0, 0, 0],
  lastChord: -1,
  lastDrop: 0,
  drops: 0,
  prevSnare: 0,
  prevKick: 0,
  kicks: 0,
};

const PAIRS: [number, number][] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const TETRA = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];

/** 4D vertices; must match hl_vert4 in WGSL. */
function vertices(type: number, P: number): number[][] {
  const v: number[][] = [];
  if (type === 0) {
    for (let i = 0; i < 16; i++) v.push([0, 1, 2, 3].map((k) => ((i >> k) & 1 ? 1 : -1)));
  } else if (type === 1) {
    for (let i = 0; i < 8; i++) {
      const p = [0, 0, 0, 0];
      p[i >> 1] = i & 1 ? 2 : -2;
      v.push(p);
    }
  } else if (type === 2) {
    const w = -1 / Math.sqrt(5);
    for (const t of TETRA) v.push([t[0] * 1.2, t[1] * 1.2, t[2] * 1.2, w * 1.2]);
    v.push([0, 0, 0, (4 / Math.sqrt(5)) * 1.2]);
  } else if (type === 3) {
    for (let i = 0; i < 24; i++) {
      const [a, b] = PAIRS[i >> 2];
      const p = [0, 0, 0, 0];
      p[a] = i & 1 ? 1.4 : -1.4;
      p[b] = i & 2 ? 1.4 : -1.4;
      v.push(p);
    }
  } else {
    const r = Math.sqrt(3) / (2 * Math.sin(Math.PI / P));
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < P; b++) {
        const t = (2 * Math.PI * a) / 3;
        const u = (2 * Math.PI * b) / P;
        v.push([Math.cos(t), Math.sin(t), r * Math.cos(u), r * Math.sin(u)]);
      }
  }
  return v;
}

export default raymarchScene({
  meta: {
    id: 'hyper-lattice',
    name: 'Hyper Lattice',
    // Kept out of auto-direction (see above): an energy range no section reaches, no genres.
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: 0.5, arousal: 0.6 },
    genres: {},
    trails: 0.3,
  },
  params(ctx, p) {
    const m = ctx.music;
    tick(m, ctx.dt);
    const g = ctx.dna;
    const ev = ctx.evolve;
    const v = g[0];
    const dt = Math.min(ctx.dt, 1 / 20);
    const type = Math.floor(g[0] * 5);
    const P = 5 + Math.floor(g[7] * 3);
    const lattice = [0, 1, 3][Math.min(2, Math.floor(g[1] * 3))]; // 0 cubic, 1 tunnel, 3 sandwich
    let rig = Math.floor(g[2] * 4); // 0 forward, 1 corkscrew, 2 strafe, 3 crane
    // Tunnels and sandwiches are flown through; only open lattices suit the strafe and crane.
    if ((lattice === 1 || lattice === 3) && rig >= 2) rig -= 2;
    const mat = Math.floor(g[3] * 4); // 0 neon, 1 chrome, 2 dashed, 3 ghost
    const grammar = Math.floor(g[5] * 3); // 0 edge pulses, 1 beat-stepped pulses, 2 larger snare flips
    const cmode = Math.floor(g[6] * 4); // 0 groups, 1 mono, 2 depth, 3 4D w

    // 4D rotation advances with the music clock; builds accelerate it.
    state.phase += dt * mc.rate * (0.45 + 2.0 * m.anticipation * m.anticipation) * (0.7 + 0.6 * ev[0]);
    // Chord changes glide the orientation to a per-chord offset.
    if (m.chordIndex !== state.lastChord) {
      state.lastChord = m.chordIndex;
      for (let i = 0; i < 6; i++) state.chordTarget[i] = (hash(m.chordIndex * 7.3 + i * 1.9 + v * 13) - 0.5) * 0.9;
    }
    // Drops snap to a fresh orientation.
    if (m.dropPulse > 0.9 && state.lastDrop <= 0.9) {
      state.drops++;
      for (let i = 0; i < 6; i++) state.snapTarget[i] += (hash(state.drops * 3.1 + i * 5.7 + v) - 0.5) * 2.4 + (i < 3 ? Math.PI / 4 : 0);
    }
    state.lastDrop = m.dropPulse;
    // Each snare turns the polytopes a step through the fourth dimension.
    if (m.snare > state.prevSnare + 0.2) state.snapTarget[state.kicks % 3] += grammar === 2 ? Math.PI / 4 : Math.PI / 8;
    state.prevSnare = m.snare;
    if (m.kick > state.prevKick + 0.2) state.kicks++;
    state.prevKick = m.kick;
    const kc = 1 - Math.exp(-dt * 5);
    const ks = 1 - Math.exp(-dt * 14);
    let rot = ident();
    for (let i = 0; i < 6; i++) {
      state.chord[i] += (state.chordTarget[i] - state.chord[i]) * kc;
      state.snap[i] += (state.snapTarget[i] - state.snap[i]) * ks;
      const a = state.phase * RATES[i] * (1 + 0.6 * Math.sin(v * 17 + g[4] * 5 + i)) + state.chord[i] + state.snap[i] + v * 10 * (i + 1);
      rot = mul(planeRot(PLANES[i][0], PLANES[i][1], a), rot);
    }

    // Lattice geometry.
    const C = (2.6 + 1.6 * g[4]) * (1 - 0.32 * m.anticipation + 0.22 * m.dropPulse);
    const projD = type === 0 ? 4.2 + 1.2 * ((v * 5.3) % 1) : type === 4 ? 6.0 + 2.0 * (P - 5) * 0.5 : 5.0;
    let maxR = 0;
    for (const vert of vertices(type, P)) {
      const q = [0, 1, 2, 3].map((r) => rot[r] * vert[0] + rot[4 + r] * vert[1] + rot[8 + r] * vert[2] + rot[12 + r] * vert[3]);
      const f = projD / (projD - q[3]);
      maxR = Math.max(maxR, Math.hypot(q[0], q[1], q[2]) * f);
    }
    const fill = lattice === 2 || lattice === 4 ? 0.4 : 0.3;
    const s = (fill * C) / maxR;
    const thin = type === 3 ? 0.7 : 1;
    const beamR = 0.0065 * C * (1 + 0.3 * m.bass + 0.8 * m.kick) * thin * (mat === 1 ? 1.8 : 1);
    const jointR = beamR * (mat === 3 ? 3.4 : 2.3) + 0.008 * C * m.kick;

    p[0] = C;
    p[1] = s;
    p[2] = beamR;
    p[3] = type + 8 * (P - 5) + 32 * lattice + 256 * rig + 2048 * mat + 16384 * grammar + 65536 * cmode;
    p[4] = projD;
    p[5] = type;
    p[6] = jointR;
    p[7] = (v * 2.618 + g[7] * 0.5) % 1;
    p[8] = [0, 0.27, -0.22, 0.12][Math.floor(g[6] * 8) % 4];
    p[9] = Math.sin(mc.turn * 0.4 + v * 5) * 0.35;
    p[10] = 1.25 + 0.3 * m.anticipation - 0.2 * m.dropPulse + 0.15 * (ev[2] - 0.5);
    p[11] = 0.75 * m.anticipation * m.anticipation;
    p[12] = mc.travel * 1.1;
    p[13] = (0.8 + 1.0 * ctx.intensity + 1.4 * m.dropPulse) * (mat === 3 ? 1.6 : 1);
    p[14] = mc.turn;
    p[15] = maxR * s + jointR;
    p.set(rot, 16);
  },
  wgsl: /* wgsl */ `
var<private> hl_v: array<vec3f, 24>;
var<private> hl_w: array<f32, 24>;
var<private> hl_e: array<vec2u, 96>;
var<private> hl_eg: array<u32, 96>;
var<private> hl_ne: u32;
var<private> hl_nv: u32;
var<private> hl_gc: array<vec3f, 4>;

fn hl_bits(sh: u32, n: u32) -> u32 { return (u32(S.p[0].w + 0.5) >> sh) & ((1u << n) - 1u); }
fn hl_type() -> u32 { return hl_bits(0u, 3u); }
fn hl_P() -> u32 { return 5u + hl_bits(3u, 2u); }
fn hl_lattice() -> u32 { return hl_bits(5u, 3u); }
fn hl_rig() -> u32 { return hl_bits(8u, 3u); }
fn hl_mat() -> u32 { return hl_bits(11u, 3u); }
fn hl_grammar() -> u32 { return hl_bits(14u, 2u); }
fn hl_cmode() -> u32 { return hl_bits(16u, 2u); }

const HL_PAIRS: array<vec2u, 6> = array<vec2u, 6>(vec2u(0u, 1u), vec2u(0u, 2u), vec2u(0u, 3u), vec2u(1u, 2u), vec2u(1u, 3u), vec2u(2u, 3u));

fn hl_vert4(t: u32, i: u32) -> vec4f {
  if (t == 0u) {
    return vec4f(select(-1.0, 1.0, (i & 1u) != 0u), select(-1.0, 1.0, (i & 2u) != 0u),
                 select(-1.0, 1.0, (i & 4u) != 0u), select(-1.0, 1.0, (i & 8u) != 0u));
  }
  if (t == 1u) {
    var v = vec4f(0.0);
    v[i >> 1u] = select(-2.0, 2.0, (i & 1u) != 0u);
    return v;
  }
  if (t == 2u) {
    let w = -1.2 / sqrt(5.0);
    if (i == 4u) { return vec4f(0.0, 0.0, 0.0, 4.8 / sqrt(5.0)); }
    let sy = select(-1.0, 1.0, i == 0u || i == 2u);
    let sz = select(-1.0, 1.0, i == 0u || i == 3u);
    let sx = select(-1.0, 1.0, i < 2u);
    return vec4f(sx * 1.2, sy * 1.2, sz * 1.2, w);
  }
  if (t == 3u) {
    let ab = HL_PAIRS[i >> 2u];
    var v = vec4f(0.0);
    v[ab.x] = select(-1.4, 1.4, (i & 1u) != 0u);
    v[ab.y] = select(-1.4, 1.4, (i & 2u) != 0u);
    return v;
  }
  let P = hl_P();
  let a = i / P;
  let b = i % P;
  let r = sqrt(3.0) / (2.0 * sin(PI / f32(P)));
  let ta = TAU * f32(a) / 3.0;
  let tb = TAU * f32(b) / f32(P);
  return vec4f(cos(ta), sin(ta), r * cos(tb), r * sin(tb));
}

// Project the rotated polytope's vertices, find its edges (shortest vertex pairs) and
// resolve the group colours once per pixel.
fn hl_setup() {
  let rot = mat4x4f(S.p[4], S.p[5], S.p[6], S.p[7]);
  let D = S.p[1].x;
  let s = S.p[0].y;
  let t = hl_type();
  var nv = 16u;
  var e2 = 4.0;
  if (t == 1u) { nv = 8u; e2 = 8.0; }
  else if (t == 2u) { nv = 5u; e2 = 8.0 * 1.44; }
  else if (t == 3u) { nv = 24u; e2 = 2.0 * 1.96; }
  else if (t == 4u) { nv = 3u * hl_P(); e2 = 3.0; }
  hl_nv = nv;
  var v4: array<vec4f, 24>;
  for (var i = 0u; i < nv; i++) {
    v4[i] = hl_vert4(t, i);
    let q = rot * v4[i];
    hl_v[i] = q.xyz * (D / (D - q.w)) * s;
    hl_w[i] = q.w;
  }
  var ne = 0u;
  for (var i = 0u; i < nv; i++) {
    for (var j = i + 1u; j < nv; j++) {
      let d = v4[i] - v4[j];
      if (dot(d, d) < e2 * 1.05 && ne < 96u) {
        let ad = abs(d);
        var ax = 0u;
        if (ad.y > ad[ax] + 1e-3) { ax = 1u; }
        if (ad.z > ad[ax] + 1e-3) { ax = 2u; }
        if (ad.w > ad[ax] + 1e-3) { ax = 3u; }
        hl_e[ne] = vec2u(i, j);
        hl_eg[ne] = (ax + select(0u, i + j, t != 0u)) % 4u;
        ne++;
      }
    }
  }
  hl_ne = ne;
  for (var g = 0u; g < 4u; g++) {
    hl_gc[g] = palL(f32(g) * 0.25 + S.p[1].w + F.morph2.y * 0.15, 0.32);
  }
}

fn hl_band(g: f32) -> f32 { return fract(g * 0.23 + S.p[1].w * 0.68) * 0.85 + 0.03; }

// Closest approach between the ray (o + t d, t >= 0) and segment [a, b]: (distance, t, s).
fn hl_raySeg(o: vec3f, d: vec3f, a: vec3f, b: vec3f) -> vec3f {
  let ba = b - a;
  let oa = o - a;
  let baba = dot(ba, ba);
  let bard = dot(ba, d);
  let s = sat((dot(ba, oa) - dot(d, oa) * bard) / max(baba - bard * bard, 1e-6));
  let t = max(s * bard - dot(d, oa), 0.0);
  let sp = sat(dot(oa + d * t, ba) / max(baba, 1e-6));
  return vec3f(length(oa + d * t - ba * sp), t, sp);
}

fn hl_env(d: vec3f) -> vec3f {
  return mix(F.pal0.rgb * 0.4, mix(F.pal1.rgb, F.pal2.rgb, 0.5 + 0.5 * d.x), sat(d.y * 0.5 + 0.5)) * 0.5
       + F.pal3.rgb * pow(sat(dot(d, normalize(vec3f(0.3, 0.8, 0.4)))), 16.0) * 1.5;
}

// One beam: material-dependent profile, line glow, and a beat pulse running along the edge.
fn hl_beam(e: vec3f, gc: vec3f, lv: f32, pf: f32, pulseAmp: f32, pa: f32, fogD: f32, mat: u32) -> vec3f {
  let br = S.p[0].z;
  let glowW = S.p[0].x * select(0.03, 0.06, mat == 3u);
  let halo = glowW * glowW / (e.x * e.x + glowW * glowW);
  let pw = pa * max(e.y, 1e-3);
  let rEff = max(br, pw * 0.5);
  if (e.x > rEff + pw && halo * S.p[3].y < 0.03) { return vec3f(0.0); }
  let cov = sat((rEff - e.x) / pw + 0.5) * (br / rEff);
  let xr = e.x / rEff;
  let prof = sat(1.0 - xr * xr);
  let dz = e.z - pf;
  let near = 0.3 + 0.7 * smoothstep(0.0, S.p[0].x * 0.6, e.y);
  let fog = exp(-e.y / fogD) * near;
  let pulse = exp(-dz * dz * 140.0) * pulseAmp;
  if (mat == 1u) {
    // Chrome tube: dark body, sharp env-tinted highlight stripes, pulses glow through.
    let stripe = exp(-pow((xr - 0.35) * 6.0, 2.0)) + 0.4 * exp(-pow((xr + 0.6) * 5.0, 2.0));
    let body = gc * 0.06 + hl_env(vec3f(xr, sqrt(prof), 0.3)) * 0.5 * stripe + vec3f(stripe * 0.6);
    return (body * (0.5 + 0.6 * lv) * cov + gc * pulse * cov * prof + gc * S.p[3].y * halo * 0.02 * lv) * fog;
  }
  var em = gc * (lv + pulse) * fog;
  if (mat == 2u) {
    // Data flow: dashes streaming along every edge at the beat.
    let dash = smoothstep(0.35, 0.5, fract(e.z * 6.0 - F.beatPhase - S.p[3].x * 0.3)) * smoothstep(1.0, 0.85, fract(e.z * 6.0 - F.beatPhase - S.p[3].x * 0.3));
    em *= 0.25 + 2.2 * dash;
  }
  let ghost = select(1.0, 0.7, mat == 3u);
  return em * (cov * (0.45 + 1.0 * prof) * ghost + S.p[3].y * halo * select(0.07, 0.12, mat == 3u)) + vec3f(luma(em)) * cov * prof * prof * prof * 0.25 * ghost;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  hl_setup();
  let C = S.p[0].x;
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let lattice = hl_lattice();
  let rig = hl_rig();
  let mat = hl_mat();
  let grammar = hl_grammar();
  let cmode = hl_cmode();
  let z = S.p[3].x;
  let turn = S.p[3].z;
  var ro: vec3f;
  var ta: vec3f;
  var roll = S.p[2].y;
  if (lattice == 4u) {
    // One giant polytope, orbited from outside.
    let a = turn * 0.25 + S.p[1].w * 6.0;
    let el = 0.35 * sin(turn * 0.11) + S.p[2].x;
    let r = C * (0.85 - 0.1 * F.anticipation + 0.15 * F.dropPulse);
    ro = vec3f(cos(a) * cos(el), sin(el), sin(a) * cos(el)) * r;
    ta = vec3f(0.0);
  } else if (rig == 2u) {
    // Strafe: travel sideways while looking down the lattice at an angle.
    let path = vec3f(z, (S.p[2].x + 0.05 * cos(z * 0.17)) * C, 0.5 * C + 0.3 * C * sin(z * 0.05));
    ro = path;
    ta = path + vec3f(0.6 * C, sin(turn * 0.05) * 0.3 * C, C * 1.3);
  } else if (rig == 3u) {
    // Crane: rise vertically through the lattice, looking out and slightly down.
    let path = vec3f(0.5 * C + 0.4 * C * sin(z * 0.04), z * 0.8, 0.5 * C);
    let a = turn * 0.12;
    ro = path;
    ta = path + vec3f(cos(a) * C, -0.35 * C, sin(a) * C);
  } else {
    var py = S.p[2].x;
    if (lattice == 3u) { py = 0.0; }
    let path = vec2f(0.5 + 0.05 * sin(z * 0.21), py + 0.05 * cos(z * 0.17)) * C;
    ro = vec3f(path, z);
    ta = vec3f(path + vec2f(sin(turn * 0.07) * 0.6, cos(turn * 0.05) * 0.35) * C * 0.4, z + C * 1.5);
    if (rig == 1u) { roll += z * 0.23; }
  }
  let cam = lookAt(ro, ta, roll);
  let fov = S.p[2].z;
  let rd = normalize(cam * vec3f(q, fov));
  let pa = 2.0 / (F.res.y * fov); // pixel footprint per unit distance

  let jr = S.p[1].z;
  let fogD = C * (1.5 + 0.8 * F.energySlow) * select(1.0, 2.0, lattice == 4u || lattice == 2u);
  let far = C * select(7.0, 9.0, lattice == 2u);
  let rg = S.p[3].w + C * 0.045;
  let pulseAmp = select(0.2 + 1.2 * F.beatPulse + 2.2 * F.kick, 0.3 + 1.6 * F.beatPulse, grammar == 1u);
  // The melody's level: the height the pitch sets, flaring on each note, glowing while held.
  let leadY = ro.y + F.leadPitch * C * 0.55;
  let leadI = 0.3 * F.leadHeld + 6.0 * F.lead;
  let leadCol = palL(S.p[1].w + 0.5 + 0.15 * F.leadPitch, 1.0);
  let swell = 0.1 + 0.5 * F.kickNext * F.anticipation;
  let bands = vec4f(hl_band(0.0), hl_band(1.0), hl_band(2.0), hl_band(3.0));
  let mono = palL(S.p[1].w + F.morph2.y * 0.15, 0.32);
  let occSeed = vec3f(fract(S.p[1].w * 1.37) * 17.0);
  let occThr = select(0.22, 0.84, lattice == 2u);
  let nv = hl_nv;
  let ne = hl_ne;

  var col = vec3f(0.0);
  var T = 1.0;

  // 3D DDA through the cells, front to back; each polytope is solved analytically once.
  let rdS = select(rd, vec3f(1e-5), abs(rd) < vec3f(1e-5));
  let inv = 1.0 / rdS;
  let stp = sign(rdS);
  var cell = floor(ro / C + 0.5);
  var tMax = ((cell + 0.5 * stp) * C - ro) * inv;
  let tDelta = abs(C * inv);
  var tCell = 0.0;
  for (var it = 0; it < 18; it++) {
    if (tCell > far || T < 0.02) { break; }
    let center = cell * C;
    var lo = ro - center;
    let bb = dot(lo, rd);
    let hh = bb * bb - (dot(lo, lo) - rg * rg);
    var occupied = hash13(cell * vec3f(1.0, 1.31, 0.77) + occSeed) > occThr;
    if (lattice == 1u) {
      // Tunnel: a ring of cells around the flight axis.
      let axis = select(vec2f(0.5 * C, S.p[2].x * C), vec2f(z, (S.p[2].x) * C), rig == 2u);
      let dxy = select(center.xy - axis, vec2f(center.y - axis.y, center.z - 0.5 * C), rig == 2u);
      let ring = max(abs(dxy.x), abs(dxy.y)) / C;
      occupied = ring > 0.7 && ring < 1.6;
    } else if (lattice == 3u) {
      occupied = (cell.y == -1.0 || cell.y == 1.0) && hash13(cell + occSeed) > 0.1;
    } else if (lattice == 4u) {
      occupied = all(cell == vec3f(0.0));
    }
    if (occupied && hh > 0.0 && -bb + sqrt(hh) > 0.0) {
      let mir = lattice != 4u && fmod(cell.x + cell.y + cell.z, 2.0) > 0.5;
      var ld = rd;
      if (mir) { lo.x = -lo.x; ld.x = -ld.x; }
      let cellPh = dot(cell, vec3f(0.17, 0.11, 0.23));
      let pf = fract(F.beatPhase + cellPh);
      // Spectrum per edge group; deeper cells show older history, so sound flows toward you.
      let age = sat(tCell / far) * 0.45;
      let lv = vec4f(hist(bands.x, age), hist(bands.y, age), hist(bands.z, age), hist(bands.w, age));
      var lvE = swell + 1.7 * lv * lv;
      let depthC = palL(S.p[1].w + sat(tCell / far) * 0.6 + F.morph2.y * 0.15, 0.32);

      // Joints first: the nearest sphere hit bounds which beams are visible.
      var tJ = 1e9;
      var jAlpha = 0.0;
      var jn = vec3f(0.0);
      var jg = 0.0;
      for (var i = 0u; i < nv; i++) {
        let oc = lo - hl_v[i];
        let b = dot(oc, ld);
        let perp = sqrt(max(dot(oc, oc) - b * b, 0.0));
        let a = sat((jr - perp) / (pa * max(-b, 0.01)) + 0.5);
        if (a > 0.0 && -b > 0.0 && -b < tJ) {
          let h = sqrt(max(jr * jr - perp * perp, 0.0));
          tJ = -b - h;
          jAlpha = a;
          jn = normalize(oc + ld * tJ);
          jg = f32(i);
        }
      }
      var beam = vec3f(0.0);
      for (var k = 0u; k < ne; k++) {
        let ij = hl_e[k];
        let e = hl_raySeg(lo, ld, hl_v[ij.x], hl_v[ij.y]);
        if (e.y < tJ) {
          let g = hl_eg[k];
          var gc = hl_gc[g];
          if (cmode == 1u) { gc = mono; }
          else if (cmode == 2u) { gc = depthC; }
          else if (cmode == 3u) { gc = palL(S.p[1].w + (mix(hl_w[ij.x], hl_w[ij.y], e.z)) * 0.18, 0.32); }
          beam += hl_beam(e, gc, lvE[g], pf, pulseAmp, pa, fogD, mat);
          // Beams crossing the melody's level light up where they cross it.
          let hy = (ro + rd * e.y).y;
          let leadLv = exp(-pow((hy - leadY) / (C * 0.1), 2.0)) * leadI;
          if (leadLv > 0.01) { beam += hl_beam(e, leadCol, leadLv, 2.0, 0.0, pa, fogD, 0u); }
        }
      }
      col += T * beam;
      if (jAlpha > 0.0) {
        var n = jn;
        if (mir) { n.x = -n.x; }
        let head = sat(dot(n, -rd));
        let tint = palL(fract(jg * 0.137) * 0.5 + S.p[1].w + 0.12, 0.32);
        var jc: vec3f;
        if (mat == 2u) {
          // Emissive nodes.
          jc = tint * (0.6 + 2.0 * F.kick + 1.2 * lvE[u32(jg) % 4u]) * (0.4 + 0.6 * head);
        } else {
          // Glassy metal joint: reflection, refraction tint, specular and a kick-lit inner glow.
          let fre = pow(1.0 - head, 4.0);
          let r = reflect(rd, n);
          let key = normalize(vec3f(0.4, 0.7, -0.3));
          jc = tint * 0.05 * sat(dot(n, key));
          jc += hl_env(r) * mix(tint, vec3f(1.0), 0.5) * (0.1 + 0.7 * fre);
          jc += hl_env(refract(rd, n, 0.7)) * tint * 0.25 * head;
          jc += F.pal3.rgb * pow(sat(dot(r, key)), 40.0) * 2.5;
          jc += tint * pow(head, 3.0) * (0.1 + 1.4 * F.kick + 0.8 * F.chordPulse);
        }
        let jy = (ro + rd * tJ).y;
        jc += leadCol * exp(-pow((jy - leadY) / (C * 0.08), 2.0)) * leadI * 0.6;
        let fogJ = exp(-tJ / fogD);
        let ja = jAlpha * select(1.0, 0.55, mat == 3u);
        col += T * ja * jc * fogJ;
        T *= 1.0 - ja * fogJ;
      }
    }

    // Advance to the next cell.
    tCell = min(tMax.x, min(tMax.y, tMax.z));
    let msk = select(vec3f(0.0), vec3f(1.0), tMax <= vec3f(tCell));
    cell += msk * stp;
    tMax += msk * tDelta;
  }

  var fogCol = F.pal0.rgb * (0.12 + 0.15 * F.energySlow) + F.pal1.rgb * 0.01;
  if (lattice == 4u || lattice == 2u) {
    // Open void: a soft gradient nebula behind the polytopes.
    let n = fbm3(rd * 1.1 + vec3f(S.p[1].w * 9.0), 3);
    fogCol = F.pal0.rgb * 0.08 + palL(S.p[1].w + 0.5 + 0.2 * n, 0.02) * sat(n * 0.7 + 0.5) * (0.6 + 0.6 * F.energySlow);
  }
  col += T * fogCol;
  // Anticipation drains colour.
  col = mix(col, vec3f(luma(col)), S.p[2].w) * (1.0 - 0.35 * F.anticipation);
  return vec4f(col, 1.0);
}
`,
});
