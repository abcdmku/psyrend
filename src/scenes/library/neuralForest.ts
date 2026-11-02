import { raymarchScene } from '../raymarchScene';
import type { MusicState } from '../../audio/musicState';
import { Morph } from '../morph';

/**
 * A 3D lattice of neurons wired to each other by beaded axons. Every cell holds
 * one neuron; action potentials run outward along its dendrites (path length is
 * tracked through the branching) and along the axons to the next neuron.
 *
 * DNA: cell type (pyramidal neurons with apical tufts, Purkinje fans in parallel
 * sheets, star-shaped glia web), density/fill, branching angles and depth,
 * camera (fly-through between rows, macro orbit, rising crane), material (glassy,
 * fleshy, electric wire), firing grammar (beat sync, per-band, travelling
 * cascade), hue and arrangement.
 *
 * Music: the melody fires a layer of neurons: each note lights the cells at a height set by
 * the pitch (high notes above you, low notes below) in their own colour, eased in by the note's
 * strength. Kicks fire every
 * soma at once and the potentials run out along the dendrites; snares send a pulse down
 * every axon. Flight and turns advance with the beats and bars and rest in silence.
 */

/** Critically damped follower (about 0.15 s rise from rest): event reactions ease in, never snap. */
type Glide = { x: number; v: number };
function glide(s: Glide, target: number, dt: number, w = 22): number {
  const e = Math.exp(-w * dt);
  const d = s.x - target;
  const c = s.v + w * d;
  s.v = (s.v - w * c * dt) * e;
  s.x = target + (d + c * dt) * e;
  return s.x;
}

// Event levels and ages only (strength and presence scaled): every reaction follows its event's level.
const mo = new Morph(0.5);
const evs = { kick: { x: 0, v: 0 }, snare: { x: 0, v: 0 }, note: { x: 0, v: 0 }, held: { x: 0, v: 0 }, pitch: { x: 0, v: 0 }, beat: { x: 0, v: 0 } };

/** Music clock: `beat` surges on every beat, `bar` steps on every bar, both scaled by loudness. */
const clk = { t: -1, b: 0, r: 0, beat: 0, bar: 0 };
function tickClock(m: MusicState) {
  const b = m.beatIndex + m.beatPhase + 0.095 * Math.sin(m.beatPhase * 2 * Math.PI);
  const e = Math.min(1, m.barPhase * 2);
  const r = m.barIndex + 0.5 * m.barPhase + 0.5 * e * e * (3 - 2 * e);
  const dt = m.time - clk.t;
  if (dt === 0) return;
  if (dt > 0 && dt < 0.25) {
    const drive = Math.min(1, m.energySlow * 5) * (0.25 + 0.6 * m.energySlow) + 0.5 * m.dropPulse;
    clk.beat += Math.min(Math.max(b - clk.b, 0), 1) * drive;
    clk.bar += Math.min(Math.max(r - clk.r, 0), 1) * drive;
  }
  clk.t = m.time;
  clk.b = b;
  clk.r = r;
}

export default raymarchScene({
  meta: {
    id: 'neural-forest',
    name: 'Neural Forest',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.3, 1],
    mood: { valence: 0.45, arousal: 0.7 },
    genres: { techno: 1, dnb: 0.9, edm: 0.85, jazz: 0.6, dubstep: 0.6, synthwave: 0.5 },
    trails: 0.3,
    kaleido: true,
  },
  params(ctx, p) {
    const m = ctx.music;
    tickClock(m);
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    mo.update(m, ctx.dt, g);
    // Eased envelopes, each scaled by its event's level (which carries the passage's presence). The
    // beats' are x1.6: the eased curve peaks near 0.6 of its target, so a full hit still lands fully.
    const kE = 1.6 * glide(evs.kick, mo.kickLevel * Math.exp(-mo.kickAge / 0.22), dt);
    const sE = 1.6 * glide(evs.snare, mo.snareLevel * Math.exp(-mo.snareAge / 0.25), dt);
    const nE = glide(evs.note, mo.noteLevel * Math.exp(-mo.leadAge / 0.3), dt);
    const held = glide(evs.held, m.leadHeld * mo.presence, dt, 12);
    const pitch = glide(evs.pitch, m.leadPitch, dt, 9);
    const beat = glide(evs.beat, m.beatPulse * mo.presence, dt);
    const type = Math.floor(g[1] * 3) % 3; // 0 pyramidal, 1 Purkinje, 2 glia
    const camMode = Math.floor(g[4] * 3) % 3; // 0 fly, 1 macro, 2 crane
    const mat = Math.floor(g[5] * 3) % 3; // 0 glassy, 1 fleshy, 2 electric
    const grammar = Math.floor(g[6] * 3) % 3; // 0 beat sync, 1 per band, 2 cascade
    const antic = m.anticipation;
    const drop = m.dropPulse;
    const sp = clk.bar * 0.5;
    const fly = clk.beat * 0.5;
    const cs = 1.6 + 1.0 * g[2]; // world cell size
    const cy = cs * 1.3;

    let ro: number[];
    let ta: number[];
    let fov = 1.4;
    if (camMode === 0) {
      const z = fly * 0.9;
      const sx = Math.sin(z * 0.11) * 0.18 * cs;
      const sy = Math.sin(z * 0.08 + 1) * 0.15 * cy;
      ro = [sx, sy, z];
      const yaw = 0.45 * Math.sin(sp * 0.03 + g[7] * 6) + (g[7] - 0.5) * 0.5;
      const pitch = 0.25 * Math.sin(sp * 0.023 + g[3] * 5);
      ta = [sx + Math.sin(yaw) * 3, sy + pitch * 3, z + Math.cos(yaw) * 3];
      fov = 1.25;
    } else if (camMode === 1) {
      const a = sp * 0.16 + g[7] * 6.28;
      const r = (0.62 - 0.08 * m.energySlow + 0.1 * drop) * cs;
      const cx = 0.5 * cs;
      const cz = 0.5 * cs;
      const cyy = 0.5 * cy;
      ro = [cx + Math.cos(a) * r, cyy + 0.15 * cy + Math.sin(sp * 0.07) * 0.25 * cy, cz + Math.sin(a) * r];
      ta = [cx, cyy + 0.05 * cy, cz];
      fov = 1.7;
    } else {
      const y = fly * 0.6;
      const a = sp * 0.07 + g[7] * 6.28;
      ro = [Math.sin(y * 0.05) * 0.15 * cs, y, Math.cos(y * 0.04) * 0.15 * cs];
      ta = [ro[0] + Math.cos(a) * 3, y + 1.2 + Math.sin(sp * 0.05), ro[2] + Math.sin(a) * 3];
      fov = 1.3;
    }
    p[0] = ro[0]; p[1] = ro[1]; p[2] = ro[2]; p[3] = fov * (1 + 0.15 * antic - 0.1 * drop);
    p[4] = ta[0]; p[5] = ta[1]; p[6] = ta[2]; p[7] = Math.sin(sp * 0.06 + g[3] * 4) * (camMode === 0 ? 0.25 : 0.1);
    p[8] = type; p[9] = mat; p[10] = grammar; p[11] = camMode;
    // cell size, fill, branch spread, branch twist
    p[12] = cs;
    p[13] = (0.62 + 0.18 * g[3]) * (1 + 0.04 * m.bass + 0.03 * kE);
    p[14] = 0.35 + 0.35 * g[7] + 0.08 * Math.sin(sp * 0.1) + 0.1 * m.tension - 0.15 * antic + 0.15 * drop;
    p[15] = (g[3] - 0.5) * 1.6 + 0.3 * (ev[0] - 0.5);
    // hue, pulse gain, fog, seed
    p[16] = g[0] * 0.8 + 0.15 * ev[3];
    p[17] = (0.55 + 0.5 * ctx.intensity + 0.4 * beat + 0.6 * drop) * (1 - 0.4 * antic);
    p[18] = (0.32 - 0.12 * g[2]) / cs * (1 + 0.6 * antic) * (mat === 2 ? 1.2 : 1);
    p[19] = g[0];
    // anticipation, drop, kick and snare glows (eased, by level)
    p[20] = antic; p[21] = drop; p[22] = kE; p[23] = sE;
    // melody layer height (world y), band firing phase, link density, melody flare
    p[24] = ro[1] + pitch * cy * 1.4;
    p[25] = clk.beat * 0.2;
    p[26] = type === 2 ? 1 : g[6] > 0.5 ? 0.66 : 0.33;
    p[27] = 0.5 * held + 2.5 * nE;
    // kick dendrite front, snare axon front, pitch, chord swell (eased)
    // The fronts run out after each hit (by its age), their glow eased in by its level.
    p[28] = 1.3 * (1 - Math.exp(-mo.kickAge / 0.25)) - 0.05; p[29] = 1.15 * (1 - Math.exp(-mo.snareAge / 0.25)) - 0.05; p[30] = pitch; p[31] = 4 * m.chordPulse * (1 - m.chordPulse);
  },
  wgsl: /* wgsl */ `
struct NfH { d: f32, path: f32, part: f32, band: f32 };

var<private> nf_rd: vec3f;
var<private> nf_cell: vec3f;
var<private> nf_draw: f32;

fn nf_cs() -> vec3f { let c = S.p[3].x; return vec3f(c, c * 1.3, c); }

fn nf_somaOff(id: vec3f) -> vec3f {
  let h = hash33(id * 1.17 + vec3f(S.p[4].w * 31.0, 2.3, 7.9));
  return (h - 0.5) * vec3f(0.24, 0.2, 0.24);
}

// Somatic position in world space.
fn nf_soma(id: vec3f) -> vec3f { return (id + 0.5 + nf_somaOff(id)) * nf_cs(); }

fn nf_hseg(p: vec3f, a: vec3f, b: vec3f) -> vec2f {
  let pa = p - a; let ba = b - a;
  let h = sat(dot(pa, ba) / dot(ba, ba));
  return vec2f(length(pa - ba * h), h);
}

fn nf_upd(r: ptr<function, NfH>, d: f32, path: f32, part: f32) {
  if (d < (*r).d) { (*r).d = d; (*r).path = path; (*r).part = part; }
}

// Pyramidal neuron: cone soma, apical trunk with a branching tuft, basal skirt.
fn nf_pyramidal(q: vec3f, hh: vec3f) -> NfH {
  var r: NfH; r.d = 1e9; r.path = 0.0; r.part = 0.0; r.band = hh.x;
  let soma = max(length(q * vec3f(1.0, 0.8, 1.0)) - 0.075, -q.y - 0.06);
  let cone = max(length(vec2f(length(q.xz), max(q.y, 0.0) * 0.25)) - 0.07 * sat(1.0 - q.y * 4.0), -q.y);
  nf_upd(&r, smin(soma, cone, 0.04), 0.0, 0.0);
  // Apical trunk.
  let Ha = 0.32;
  let ax = 0.03 * sin(q.y * 7.0 + hh.y * 6.0);
  let ty = clamp(q.y, 0.0, Ha);
  let trunk = length(vec3f(q.x - ax, q.y - ty, q.z)) - (0.022 - 0.01 * ty / Ha);
  nf_upd(&r, trunk, ty, 1.0);
  // Apical tuft: folded branching.
  var p = q - vec3f(0.03 * sin(Ha * 7.0 + hh.y * 6.0), Ha, 0.0);
  var sc = 1.0;
  var path = Ha;
  let spread = S.p[3].z;
  let rt = rot2(spread + 0.2);
  let rw = rot2(S.p[3].w + hh.z);
  var len = 0.12;
  for (var i = 0; i < 4; i++) {
    p.x = abs(p.x);
    p.z = abs(p.z);
    let a = rw * p.xz; p = vec3f(a.x, p.y, a.y);
    let b = rt * p.xy; p = vec3f(b.x, b.y, p.z);
    let hy = clamp(p.y, 0.0, len);
    let d = (length(vec3f(p.x, p.y - hy, p.z)) - 0.012 * sc) ;
    nf_upd(&r, d, path + hy, 1.0);
    p.y -= len;
    path += len;
    len *= 0.78;
    sc *= 0.82;
  }
  // Basal dendrites: polar skirt, each forking once.
  let nb = 6.0;
  let ang = atan2(q.z, q.x) + hh.x * 3.0;
  let sec = TAU / nb;
  let id = floor(ang / sec + 0.5);
  let al = ang - id * sec;
  let rq = length(q.xz);
  var bq = vec3f(rq * cos(al), q.y, rq * sin(al));
  let dirB = normalize(vec3f(1.0, -0.35 - 0.3 * hash11(id + hh.y * 9.0), 0.0));
  let s1 = nf_hseg(bq, vec3f(0.04, -0.02, 0.0), vec3f(0.04, -0.02, 0.0) + dirB * 0.16);
  nf_upd(&r, s1.x - 0.012, s1.y * 0.16, 1.0);
  var fq = bq - (vec3f(0.04, -0.02, 0.0) + dirB * 0.16);
  fq.z = abs(fq.z);
  let s2 = nf_hseg(fq, vec3f(0.0), vec3f(0.14, -0.08, 0.07 + 0.04 * spread));
  nf_upd(&r, s2.x - 0.008, 0.16 + s2.y * 0.17, 1.0);
  // Axon hillock heading down.
  let s3 = nf_hseg(q, vec3f(0.0, -0.05, 0.0), vec3f(0.0, -0.42, 0.0));
  nf_upd(&r, s3.x - 0.009, s3.y * 0.37, 2.0);
  return r;
}

// Purkinje cell: round soma low in the cell, a dense planar dendritic fan above.
fn nf_purkinje(q0: vec3f, hh: vec3f) -> NfH {
  var r: NfH; r.d = 1e9; r.path = 0.0; r.part = 0.0; r.band = hh.x;
  let q = q0 - vec3f(0.0, -0.36, 0.0);
  nf_upd(&r, length(q) - 0.07, 0.0, 0.0);
  let tr = nf_hseg(q, vec3f(0.0), vec3f(0.0, 0.12, 0.0));
  nf_upd(&r, tr.x - 0.02, tr.y * 0.12, 1.0);
  var p = q - vec3f(0.0, 0.12, 0.0);
  var path = 0.12;
  var len = 0.13;
  var th = 0.016;
  let spread = S.p[3].z;
  let rt = rot2(spread * 0.85 + 0.1);
  for (var i = 0; i < 6; i++) {
    p.x = abs(p.x);
    let b = rt * p.xy; p = vec3f(b.x, b.y, p.z);
    let hy = clamp(p.y, 0.0, len);
    let wig = 0.006 * sin(p.y * 60.0 + f32(i) * 2.0);
    let d = length(vec3f(p.x + wig, p.y - hy, p.z)) - th;
    nf_upd(&r, d * 0.9, path + hy, 1.0);
    p.y -= len;
    path += len;
    len *= 0.8;
    th *= 0.8;
  }
  let ax = nf_hseg(q, vec3f(0.0), vec3f(0.0, -0.22, 0.0));
  nf_upd(&r, ax.x - 0.009, ax.y * 0.22, 2.0);
  return r;
}

// Astrocyte: star of tapered processes along axes and diagonals, end-feet.
fn nf_glia(q: vec3f, hh: vec3f) -> NfH {
  var r: NfH; r.d = 1e9; r.path = 0.0; r.part = 0.0; r.band = hh.x;
  let bump = 0.012 * sin(q.x * 40.0 + hh.y * 9.0) * sin(q.y * 37.0) * sin(q.z * 43.0);
  nf_upd(&r, length(q) - 0.085 + bump, 0.0, 0.0);
  let a = abs(q);
  let L = 0.24 + 0.1 * S.p[3].z;
  // Axis processes along the dominant axis.
  var ax = a;
  if (a.y > a.x && a.y >= a.z) { ax = a.yzx; } else if (a.z > a.x && a.z > a.y) { ax = a.zxy; }
  let w1 = 0.02 * sin(ax.x * 18.0 + hh.z * 6.0);
  let t1 = clamp(ax.x, 0.0, L);
  let d1 = length(vec3f(ax.x - t1, ax.y - w1, ax.z + w1 * 0.5)) - mix(0.022, 0.006, t1 / L);
  nf_upd(&r, d1, t1, 1.0);
  let foot1 = length(vec3f(ax.x - L, ax.y - w1, ax.z)) - 0.025;
  nf_upd(&r, foot1, L, 1.0);
  // Diagonal processes.
  let dg = normalize(vec3f(1.0, 0.8 + 0.3 * hh.y, 1.0));
  let t2 = clamp(dot(a, dg), 0.0, L * 0.85);
  let w2 = 0.018 * sin(t2 * 22.0 + hh.x * 6.0);
  let d2 = length(a - dg * t2 + vec3f(w2, -w2, 0.0)) - mix(0.018, 0.005, t2 / L);
  nf_upd(&r, d2, t2, 1.0);
  return r;
}

fn nf_neuron(lp: vec3f, id: vec3f) -> NfH {
  let hh = hash33(id * 0.91 + vec3f(5.1, S.p[4].w * 17.0, 1.7));
  let kind = S.p[2].x;
  let fill = S.p[3].y * (0.7 + 0.3 * hh.z);
  var q = lp - nf_somaOff(id);
  // Each neuron turns; Purkinje fans stay parallel (as in the cerebellum).
  let yaw = select(hh.y * TAU, (hh.y - 0.5) * 0.3, kind > 0.5 && kind < 1.5);
  let rq = rot2(yaw) * q.xz;
  q = vec3f(rq.x, q.y, rq.y);
  let rt = rot2((hh.x - 0.5) * 0.7) * q.yz;
  q = vec3f(q.x, rt.x, rt.y) / fill;
  var r: NfH;
  if (kind < 0.5) { r = nf_pyramidal(q, hh); }
  else if (kind < 1.5) { r = nf_purkinje(q, hh); }
  else { r = nf_glia(q, hh); }
  r.d *= fill;

  return r;
}

// Axon from cell a to its chosen neighbour: which direction (if any) it takes.
fn nf_linkDir(id: vec3f) -> vec3f {
  let h = hash13(id * 1.71 + vec3f(S.p[4].w * 7.0, 0.3, 9.1));
  if (h > S.p[6].z) { return vec3f(0.0); }
  let k = floor(fract(h * 7.31) * 3.0);
  return select(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), k > 0.5 && k < 1.5), vec3f(1.0, 0.0, 0.0), k < 0.5);
}

fn nf_axon(p: vec3f, src: vec3f, dir: vec3f, r: ptr<function, NfH>) {
  if (dot(dir, dir) < 0.5) { return; }
  let cs = nf_cs();
  let a = nf_soma(src);
  let b = nf_soma(src + dir);
  let s = nf_hseg(p, a, b);
  // Myelin beads with nodes of Ranvier.
  let segL = length(b - a);
  let bead = 0.5 + 0.5 * cos(s.y * segL / cs.x * 28.0);
  let rad = (0.008 + 0.009 * bead * bead) * cs.x;
  let d = (s.x - rad) / cs.x;
  if (d < (*r).d) { (*r).d = d; (*r).path = s.y; (*r).part = 3.0; }
}

fn nf_map(p: vec3f) -> NfH {
  let cs = nf_cs();
  let id = floor(p / cs);
  nf_cell = id;
  let lp = p / cs.x - (id + 0.5) * vec3f(1.0, 1.3, 1.0);
  var r = nf_neuron(lp, id);
  // Axons: own outgoing plus incoming from the three lower neighbours.
  nf_axon(p, id, nf_linkDir(id), &r);
  let dx = nf_linkDir(id - vec3f(1.0, 0.0, 0.0));
  if (dx.x > 0.5) { nf_axon(p, id - vec3f(1.0, 0.0, 0.0), dx, &r); }
  let dy = nf_linkDir(id - vec3f(0.0, 1.0, 0.0));
  if (dy.y > 0.5) { nf_axon(p, id - vec3f(0.0, 1.0, 0.0), dy, &r); }
  let dz = nf_linkDir(id - vec3f(0.0, 0.0, 1.0));
  if (dz.z > 0.5) { nf_axon(p, id - vec3f(0.0, 0.0, 1.0), dz, &r); }
  r.d *= cs.x;
  nf_draw = r.d;
  // While marching, never step past the next cell boundary.
  if (nf_rd.x != 0.0 || nf_rd.y != 0.0 || nf_rd.z != 0.0) {
    let lc = p - (id + 0.5) * cs;
    let hc = cs * 0.5;
    let tx = select(1e5, (sign(nf_rd.x) * hc.x - lc.x) / nf_rd.x, abs(nf_rd.x) > 1e-5);
    let ty = select(1e5, (sign(nf_rd.y) * hc.y - lc.y) / nf_rd.y, abs(nf_rd.y) > 1e-5);
    let tz = select(1e5, (sign(nf_rd.z) * hc.z - lc.z) / nf_rd.z, abs(nf_rd.z) > 1e-5);
    r.d = min(r.d, max(min(tx, min(ty, tz)), 0.0) + 0.01 * cs.x);
  }
  return r;
}

fn nf_dist(p: vec3f) -> f32 { return nf_map(p).d; }

fn nf_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * nf_dist(p + k.xyy * e) + k.yyx * nf_dist(p + k.yyx * e) +
                   k.yxy * nf_dist(p + k.yxy * e) + k.xxx * nf_dist(p + k.xxx * e));
}

fn nf_hue() -> f32 { return S.p[4].x + F.morph2.x * 0.25 + F.chordHue * 0.06; }

// Action potential intensity at a path position for a neuron cell.
fn nf_fire(path: f32, part: f32, id: vec3f, band: f32) -> f32 {
  let g = S.p[2].z;
  let h = hash13(id * 0.53 + vec3f(1.1, 2.2, S.p[4].w));
  var front = 0.0;
  var amp = 1.0;
  var pp = path;
  if (part > 2.5) { pp = path; } else { pp = path / 0.8; }
  if (g < 0.5) {
    front = F.beatPhase * 1.25;
    amp = 0.25 + 0.4 * F.energySlow;
  } else if (g < 1.5) {
    front = fract(S.p[6].y * (0.6 + 0.8 * h) + h) * 1.4 - 0.1;
    let lv = spec(0.04 + 0.9 * band);
    amp = 0.1 + 3.0 * lv * lv;
  } else {
    front = fract(F.barPhase - id.z * 0.22 - id.x * 0.13 - id.y * 0.17) * 1.3 - 0.1;
    amp = 0.5 + 0.8 * F.energy;
  }
  let w = pp - front;
  let tail = select(exp(-w * w * 260.0), exp(w * 9.0), w < 0.0);
  var fire = tail * amp;
  if (part < 2.5) {
    // Kick: every soma fires and the potential runs out along the dendrites.
    let wk = pp - S.p[7].x;
    fire += S.p[5].z * select(2.0, 2.8, g < 0.5) * select(exp(-wk * wk * 160.0), exp(wk * 6.0), wk < 0.0);
  } else {
    // Snare: a pulse runs down every axon.
    let ws = path - S.p[7].y;
    fire += S.p[5].w * 3.0 * exp(-ws * ws * 50.0);
  }
  // Melody: the layer of neurons at the pitch's height lights up.
  return fire + nf_sing(id) * (0.6 + 0.6 * exp(-pp * 2.0));
}

fn nf_sing(id: vec3f) -> f32 {
  let cy = nf_cs().y;
  let dy = ((id.y + 0.5) * cy - S.p[6].x) / cy;
  return S.p[6].w * exp(-dy * dy * 2.2);
}
fn nf_singCol() -> vec3f { return palL(nf_hue() + 0.5 + 0.12 * S.p[7].z, 1.0); }

fn nf_env(rd: vec3f) -> vec3f {
  let hue = nf_hue();
  let up = rd.y * 0.5 + 0.5;
  var c = palRampL(0.1 + 0.3 * up, 0.012);
  c += palL(hue + 0.5, 0.025) * pow(sat(rd.y), 2.0);
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[0].xyz;
  let cam = lookAt(ro, S.p[1].xyz, S.p[1].w);
  let rd = normalize(cam * vec3f(q, S.p[0].w));
  let cs = nf_cs();
  let mat = S.p[2].y;
  let hue = nf_hue();
  let gain = S.p[4].y;
  let fogD = S.p[4].z;
  let antic = S.p[5].x;
  let drop = S.p[5].y;
  let far = cs.x * 9.0;

  nf_rd = rd;
  let singCol = nf_singCol();
  var t = 0.02 + ign(frag) * 0.03 * cs.x;
  var hit = false;
  var h: NfH;
  var glow = vec3f(0.0);
  for (var i = 0; i < 110; i++) {
    let p = ro + rd * t;
    h = nf_map(p);
    let band = hash13(nf_cell * 0.91 + vec3f(5.1, S.p[4].w * 17.0, 1.7));
    // Halo of action potentials and somata.
    let fi = nf_fire(h.path, h.part, nf_cell, band);
    let near = exp(-nf_draw / (0.02 * cs.x));
    let gc = mix(palL(hue + band * 0.35 + select(0.0, 0.3, h.part > 2.5), 1.0), singCol, sat(nf_sing(nf_cell) * 0.5));
    glow += gc * near * (fi + select(0.0, 0.25 + 0.6 * antic, h.part < 0.5)) * min(h.d, 0.05 * cs.x) * exp(-t * fogD);
    if (h.d < 0.0006 * t + 0.0008) { hit = true; break; }
    t += h.d * 0.9;
    if (t > far) { break; }
  }
  nf_rd = vec3f(0.0);

  let env = nf_env(rd);
  var col = env;
  if (hit) {
    let p = ro + rd * t;
    let id = nf_cell;
    let n = nf_normal(p, 0.0015 * cs.x + 0.0004 * t);
    let band = hash13(id * 0.91 + vec3f(5.1, S.p[4].w * 17.0, 1.7));
    let fi = nf_fire(h.path, h.part, id, band);
    let L = normalize(vec3f(0.4, 0.9, -0.3));
    let dif = sat(dot(n, L));
    let fres = pow(1.0 - sat(dot(n, -rd)), 3.0);
    let ao = sat(nf_dist(p + n * 0.04 * cs.x) / (0.04 * cs.x));
    let pc = mix(palL(hue + band * 0.35 + select(0.0, 0.3, h.part > 2.5), 1.0), singCol, sat(nf_sing(id) * 0.5));
    var c = vec3f(0.0);
    if (mat < 0.5) {
      // Glassy: dark body, bright rim, inner glow.
      let r = reflect(rd, n);
      c = nf_env(r) * (0.2 + 2.0 * fres) * 3.0 + palL(hue + 0.15, 0.05) * (1.0 - fres) + palL(hue + 0.5, 0.6) * fres * 0.6;
      c += pc * fi * 1.4;
    } else if (mat < 1.5) {
      // Fleshy: wrapped diffuse, subsurface tint, wet speculars.
      let alb = palL(hue + 0.02 + band * 0.1, 0.22);
      let wrap = sat((dot(n, L) + 0.5) / 1.5);
      c = alb * (0.15 + 0.85 * wrap) * ao + palL(hue + 0.08, 0.06) * fres;
      c += vec3f(1.0) * pow(sat(dot(reflect(rd, n), L)), 30.0) * 0.25;
      c += pc * fi * 0.9;
    } else {
      // Electric wire: dark metal and hot current.
      let r = reflect(rd, n);
      c = nf_env(r) * 2.0 * (0.3 + fres) + palRampL(0.1, 0.01);
      c += pc * fi * 2.2 + pc * 0.04;
    }
    if (h.part < 0.5) {
      c += pc * (0.08 + 0.5 * antic + 0.8 * drop + 1.6 * S.p[5].z + 0.4 * S.p[7].w + 1.2 * nf_sing(id)) * (0.5 + 0.5 * fres);
    }
    c *= gain * 1.8;
    let fa = exp(-t * fogD);
    col = mix(env, c, fa);
  }
  col += glow * gain * 0.9 / (0.02 * cs.x) * 0.05;
  col *= 1.0 - 0.3 * antic;
  return vec4f(col, 1.0);
}
`,
});
