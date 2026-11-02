import { raymarchScene } from '../raymarchScene';
import type { SceneUpdateContext } from '../types';
import { Morph } from '../morph';

/** Event ages and strengths only (the temple's form keeps its own clock): levels include presence. */
const morph = new Morph(1);
/** Age (< 10 s) packed with the hit's strength (64 steps): age + 16 * level step. */
const packAge = (age: number, lv: number) => Math.min(age, 9.99) + 16 * Math.max(0, Math.min(63, Math.round(lv * 63)));

/**
 * Per-instance music clock: a phase that advances with tempo and loudness, surges on each beat
 * and rests in silence, plus the seconds since the last kick, snare and melody attack.
 */
interface Pulse { t: number; clock: number; lead: number; kick: number; snare: number; leadAge: number; kickAge: number; snareAge: number }
const pulses = new WeakMap<Float32Array, Pulse>();
function musicPulse(ctx: SceneUpdateContext, key: Float32Array): Pulse {
  const m = ctx.music;
  let s = pulses.get(key);
  if (!s) {
    s = { t: m.time, clock: 0, lead: 0, kick: 0, snare: 0, leadAge: 9, kickAge: 9, snareAge: 9 };
    pulses.set(key, s);
  }
  const dt = m.time - s.t;
  s.t = m.time;
  if (dt > 0 && dt < 0.5) {
    const gate = Math.min(1, m.energy * 5);
    s.clock += dt * (m.bpm / 60) * gate * (0.3 + 0.7 * m.energySlow) * (0.4 + 1.8 * Math.exp(-m.beatPhase * 5));
    s.leadAge += dt;
    s.kickAge += dt;
    s.snareAge += dt;
  } else if (dt !== 0) {
    s.leadAge = s.kickAge = s.snareAge = 9;
  }
  if (m.lead > s.lead + 0.08) s.leadAge = 0;
  if (m.kick > s.kick + 0.15) s.kickAge = 0;
  if (m.snare > s.snare + 0.15) s.snareAge = 0;
  s.lead = m.lead;
  s.kick = m.kick;
  s.snare = m.snare;
  return s;
}

/**
 * Infinite mirrored temple. Space is polar-folded around the travel axis into N naves.
 * Spectrum bands light glyphs and halos, kicks flash the halos, anticipation spins the
 * folds faster and closes the gates in; the drop blows the gates open onto a blazing
 * central light and snaps to the next fold count.
 *
 * DNA picks the architecture (classical arcade of fluted columns, arches, ziggurats and
 * domed halos; a stepped ziggurat canyon; a hall of stupas with ringed spires; a gothic
 * nave of clustered shafts, pointed arches and crossing ribs; an Egyptian hypostyle of
 * fat papyrus columns under lintels), the material (stone and gold, marble and jade,
 * obsidian and neon, sandstone, mirror chrome), the fold set and twist, the camera rig
 * (axial flight, off-axis glide, corkscrew, sideways gaze), the lighting (central sun,
 * axis lanterns, darkness lit only by glyphs, a raking side sun), the beat grammar
 * (kick refolds, door apertures breathing per beat, rotation stepping per beat), scale
 * and hue.
 */
const FOLD_SETS = [
  [5, 6, 8, 12],
  [3, 4, 6, 8],
  [6, 8, 12, 16],
  [4, 5, 7, 10],
];
const state = { rot: 0, drops: 0, lastDrop: 0, seed: -1, beatStep: 0, stepE: 0, stepV: 0, lastBeat: 0, clock: 0, kE: 0 };

export default raymarchScene({
  meta: {
    id: 'kaleido-temple',
    name: 'Kaleido Temple',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.4, 1],
    mood: { valence: 0.6, arousal: 0.75 },
    genres: { techno: 0.9, edm: 0.9, pop: 0.5, synthwave: 0.5, dnb: 0.5 },
    trails: 0.25,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(ctx.dt, 0.1);
    const pu = musicPulse(ctx, p);
    morph.update(m, ctx.dt, g);
    const pres = morph.presence;
    // The kick's swell, by how loud the passage is, eased in (~70 ms) and out (~160 ms): a faint
    // kick in a quiet intro barely breathes the naves and never snaps them.
    const kT = m.kick * pres;
    state.kE += (kT - state.kE) * (1 - Math.exp(-Math.max(dt, 0) / (kT > state.kE ? 0.07 : 0.16)));
    const kick = state.kE;
    const dClock = Math.max(0, Math.min(pu.clock - state.clock, 0.5));
    state.clock = pu.clock;
    const seed = g[0] + g[2] * 7;
    if (seed !== state.seed) {
      state.seed = seed;
      state.drops = 0;
    }
    const arch = Math.floor(g[0] * 5); // 0 classical, 1 ziggurat canyon, 2 stupa hall, 3 gothic, 4 hypostyle
    const mat = Math.floor(g[1] * 5); // 0 stone+gold, 1 marble+jade, 2 obsidian+neon, 3 sandstone, 4 chrome
    const folds = FOLD_SETS[Math.floor(g[2] * 4)];
    const rig = Math.floor(g[3] * 4); // 0 axial, 1 off-axis glide, 2 corkscrew, 3 side gaze
    const light = Math.floor(g[4] * 4); // 0 central sun, 1 lanterns, 2 dark glyphs, 3 raking sun
    const grammar = Math.floor(g[5] * 3); // 0 kick refold, 1 breathing doors, 2 beat-stepped rotation
    const dir = g[2] * 10 - Math.floor(g[2] * 10) < 0.5 ? 1 : -1;
    // A fresh drop (pulse jumps back up) snaps the fold count to the next set.
    if (m.dropPulse > 0.9 && state.lastDrop < 0.6) state.drops++;
    state.lastDrop = m.dropPulse;
    const antic = m.anticipation;
    // The folds turn with the music (surging on beats, resting in silence), faster through a build.
    state.rot += (dClock * 0.06 + dt * (0.9 * antic * antic + 0.5 * m.dropPulse)) * dir;
    // Beat-stepped rotation: each beat turns the folds up to half a sector round (by how loud the
    // passage is), gliding in over about a fifth of a second.
    if (m.beatPulse > 0.8 && state.lastBeat <= 0.8) state.beatStep += pres;
    state.lastBeat = m.beatPulse;
    {
      const w = 22;
      const e = Math.exp(-w * Math.max(dt, 0));
      const d = state.stepE - state.beatStep;
      const c = state.stepV + w * d;
      state.stepV = (state.stepV - w * c * Math.max(dt, 0)) * e;
      state.stepE = state.beatStep + (d + c * Math.max(dt, 0)) * e;
      if (Math.abs(d) > 4) state.stepE = state.beatStep;
    }
    const n = folds[(Math.floor(g[2] * 16) + state.drops) % 4];
    const stepRot = grammar === 2 ? (state.stepE * Math.PI) / n : 0;
    const close = antic * (1 - m.dropPulse);
    const scale = 0.8 + 0.45 * g[6];
    p[0] = n;
    p[1] = state.rot + stepRot * dir + (grammar === 0 ? 0.03 * kick : 0);
    p[2] = (0.012 + 0.02 * Math.sin(g[2] * 13) + 0.015 * (ev[0] - 0.5)) * (1 + 2 * antic) + (grammar === 0 ? 0.025 * kick : 0.006 * kick);
    // Kicks breathe the naves outward.
    p[3] = 3.6 * scale * (1 - 0.18 * close) * (1 + 0.035 * kick + 0.015 * m.bass);
    p[4] = (1.45 + 0.2 * Math.sin(g[6] * 7)) * scale;
    p[5] = (3.2 + 0.6 * g[7] + (arch === 4 ? -0.6 : 0)) * scale;
    // Door aperture: normally a frame, shrinks with anticipation, gone on the drop.
    const breathe = grammar === 1 ? 0.5 * m.beatPulse * m.beatPulse * pres : 0;
    p[6] = m.dropPulse > 0.05 ? 1.25 + 6 * Math.sqrt(m.dropPulse) : (1.25 - 0.65 * close) * scale + breathe;
    p[7] = (0.5 + 0.18 * Math.sin(g[6] * 17) + 0.12 * (ev[1] - 0.5)) * scale;
    p[8] = kick;
    // Melody: a hoop of light whose radius (out from the axis toward the nave walls) is the pitch.
    p[9] = 3.6 * scale * (0.14 + 0.5 * (0.5 + 0.5 * m.leadPitch));
    const chordSwell = 4 * m.chordPulse * (1 - m.chordPulse);
    p[10] = ((0.6 + 0.8 * m.energySlow) * (1 - 0.5 * close) + 6 * m.dropPulse * m.dropPulse + 0.5 * m.kickNext + 0.35 * chordSwell) * [1, 0.35, 0.15, 0.45][light];
    p[11] = (0.5 + 0.8 * m.energy + 0.6 * antic) * (light === 2 ? 2.2 : 1);
    p[12] = g[7];
    p[13] = (0.6 + 0.8 * ctx.intensity) * (1 + 1.2 * antic);
    p[14] = (rig === 2 ? ctx.travel * 0.18 : pu.clock * 0.05) * dir;
    p[15] = antic;
    p[16] = m.dropPulse;
    p[17] = m.beatPulse * pres;
    // Off-axis glide stays inside the door aperture (which also shrinks with anticipation).
    p[18] = (rig === 1 ? 0.62 + 0.2 * ev[2] : 0.25) * (1 - close) * scale;
    p[19] = packAge(morph.leadAge, morph.noteLevel);
    p[20] = chordSwell;
    p[21] = packAge(morph.snareAge, morph.snareLevel);
    p[22] = m.snare;
    p[23] = arch;
    p[24] = mat;
    p[25] = rig;
    p[26] = light;
    p[27] = ev[3];
    p[28] = rig === 3 ? 0.55 + 0.25 * Math.sin(ctx.spin * 0.09) : 0;
    p[29] = g[4] * 40 + ctx.spin * 0.03;
    p[30] = pu.clock;
    p[31] = pu.kickAge;
  },
  wgsl: /* wgsl */ `
struct KtHit { d: f32, mat: f32 };

// Folded frame: x radial toward the nave wall, y distance from the nave centre plane,
// (ex, ey) the same point measured from the edge plane between naves.
struct KtFrame { r: f32, x: f32, y: f32, ex: f32, ey: f32, sid: f32, ang: f32 };

fn kt_arch() -> i32 { return i32(S.p[5].w + 0.5); }

fn kt_frame(p: vec3f) -> KtFrame {
  var f: KtFrame;
  let n = S.p[0].x;
  let sector = TAU / n;
  f.r = length(p.xy);
  f.ang = atan2(p.y, p.x) + S.p[0].y + p.z * S.p[0].z;
  let w = f.ang + sector * 0.5;
  f.sid = fmod(floor(w / sector), n);
  let a = abs(fmod(w, sector) - sector * 0.5);
  f.x = f.r * cos(a);
  f.y = f.r * sin(a);
  let he = sector * 0.5;
  f.ex = f.r * cos(he - a);
  f.ey = f.r * sin(he - a);
  return f;
}

fn kt_add(h: ptr<function, KtHit>, d: f32, m: f32) {
  if (d < (*h).d) { (*h).d = d; (*h).mat = m; }
}

fn kt_map(p: vec3f) -> KtHit {
  let f = kt_frame(p);
  let R = S.p[0].w;
  let he = PI / S.p[0].x;
  let Rw = R / cos(he);
  let Hc = S.p[1].x;
  let P = S.p[1].y;
  let zl = fmod(p.z, P) - P * 0.5;
  let zc = fmod(p.z, P * 0.5) - P * 0.25;
  let arch = kt_arch();
  let sc = R / 3.6;
  var h: KtHit;

  // Nave floor (the outer wall of each sector) with recessed panels.
  let panel = smoothstep(0.02, 0.0, abs(abs(fract(p.z / P * 2.0) - 0.5) - 0.42)) * 0.03;
  h.d = R - f.x - panel;
  h.mat = 0.0;
  let xt = R - Hc;
  let ct = xt / cos(he);
  let archH = S.p[1].w;
  let xc = xt - archH - 0.3;

  if (arch == 0 || arch == 1) {
    // Stepped ziggurat: three tiers (classical) or a five-tier canyon wall.
    let tiers = select(3, 5, arch == 1);
    let th = select(0.24, 0.3, arch == 1) * sc;
    var zig = 1e9;
    for (var k = 0; k < tiers; k++) {
      let fk = f32(k);
      var hw: vec3f;
      if (arch == 1) {
        hw = vec3f(th * 0.5, (0.95 - 0.13 * fk) * R * 0.32, P * 0.47 - 0.12 * fk * sc);
      } else {
        hw = vec3f(th * 0.5, (0.62 - 0.17 * fk) * R / 3.6, P * 0.3 - 0.2 * fk * sc);
      }
      zig = min(zig, sdBox(vec3f(f.x - (R - (fk + 0.5) * th), f.y, zl), hw));
    }
    if (arch == 1) {
      // A central stair climbing each canyon wall, cut into the tiers.
      let st = max(abs(f.y) - 0.28 * sc, max(abs(zl) - P * 0.5, f.x - R + f32(tiers) * th));
      let steps = (fract((R - f.x) / (th * 0.5)) - 0.5) * th * 0.5;
      zig = max(zig, -max(st, steps - abs(zl) * 0.3));
      // Shrine on the top tier.
      let xs = R - f32(tiers) * th;
      kt_add(&h, sdBox(vec3f(f.x - xs + 0.12 * sc, f.y, zl), vec3f(0.12, 0.16, 0.16) * sc), 1.0);
      kt_add(&h, zig, 0.0);
    } else {
      kt_add(&h, zig, 0.0);
      // Dome crowning the ziggurat, with a halo standing behind it.
      let xd = R - 3.0 * th;
      kt_add(&h, max(length(vec3f(f.x - xd, f.y, zl)) - 0.3 * sc, f.x - xd - 0.02), 1.0);
      let hq = vec3f(f.x - xd + 0.12 * sc, f.y, zl);
      kt_add(&h, length(vec2f(length(hq.yz) - 0.5 * sc, hq.x)) - 0.022 * sc, 2.0);
    }
  } else if (arch == 2) {
    // Stupa: square terrace, bell dome, harmika and a spire of stacked parasol rings.
    let b = vec3f(f.x - R, f.y, zl);
    let terr = sdBox(b + vec3f(0.12, 0.0, 0.0) * sc, vec3f(0.12, 0.62, 0.62) * sc);
    let dome = max(length((b + vec3f(0.24, 0.0, 0.0) * sc) * vec3f(0.85, 1.0, 1.0)) - 0.52 * sc, b.x + 0.24 * sc);
    kt_add(&h, min(terr, dome), 0.0);
    let hm = sdBox(b + vec3f(0.78, 0.0, 0.0) * sc, vec3f(0.08, 0.13, 0.13) * sc);
    kt_add(&h, hm, 1.0);
    // Spire: rings shrinking toward the axis.
    let sx = -b.x / sc - 0.86;
    let ri = clamp(floor(sx / 0.11), 0.0, 6.0);
    let rx = sx - (ri + 0.5) * 0.11;
    let rr = 0.17 - 0.018 * ri;
    let ring = length(vec2f(length(vec2f(f.y, zl)) / sc - rr, rx)) - 0.02;
    let mast = max(length(vec2f(f.y, zl)) / sc - 0.025, abs(sx - 0.45) - 0.48);
    kt_add(&h, max(min(ring, mast) * sc, -sx * sc), 1.0);
    // Finial halo.
    let fq = vec3f(-b.x - (0.86 + 0.85 + 0.12) * sc, f.y, zl);
    kt_add(&h, length(vec2f(length(fq.yz) - 0.16 * sc, fq.x)) - 0.018 * sc, 2.0);
  } else if (arch == 4) {
    // Hypostyle: two rows of fat papyrus columns per nave under heavy lintels.
    let yo = min(xt * tan(he) * 0.55, 0.9 * sc);
    let cq = vec2f(abs(f.y) - yo, zc);
    let u = sat((R - f.x) / max(R - xt, 0.1));
    let flare = 0.26 * sc + 0.16 * sc * smoothstep(0.7, 1.0, u) + 0.01 * cos(atan2(cq.y, cq.x) * 8.0);
    let colm = max(length(cq) - flare, max(f.x - R, xt - f.x)) * 0.9;
    kt_add(&h, colm, 0.0);
    let lint = sdBox(vec3f(f.x - xt + 0.1 * sc, abs(f.y) - yo, zc), vec3f(0.1 * sc, 0.32 * sc, P * 0.25));
    kt_add(&h, lint, 3.0);
    let beam = sdBox(vec3f(f.x - xt + 0.12 * sc, f.y, zc), vec3f(0.08 * sc, yo + 0.3 * sc, 0.2 * sc));
    kt_add(&h, beam, 1.0);
  }

  if (arch != 1 && arch != 4) {
    // Columns on the edge planes between naves (gothic: clustered shafts), capitals and plinths.
    var cr = length(vec2f(f.ey, zc));
    var crad = 0.13 * sc;
    if (arch == 3) {
      let c1 = length(vec2f(f.ey, zc - 0.09 * sc));
      let c2 = length(vec2f(f.ey, zc + 0.09 * sc));
      let c3 = length(vec2f(f.ey - 0.08 * sc, zc));
      cr = min(min(c1, c2), c3);
      crad = 0.06 * sc;
    }
    let flute = select(0.008 * cos(atan2(zc, f.ey) * 16.0), 0.0, arch == 3);
    let col = max(cr - crad - flute, abs(f.ex - (Rw + ct) * 0.5) - (Rw - ct) * 0.5);
    kt_add(&h, col, 0.0);
    let cap = sdBox(vec3f(f.ex - (ct + 0.05), f.ey, zc), vec3f(0.06, 0.19, 0.19) * sc) - 0.01;
    let plinth = sdBox(vec3f(f.ex - (Rw - 0.08), f.ey, zc), vec3f(0.08, 0.2, 0.2) * sc);
    kt_add(&h, min(cap, plinth), 1.0);

    // Arcade: at every column slice an arch spans the nave, springing from the
    // capitals and peaking toward the axis (gothic: pointed); a spandrel band rings it.
    let u = clamp(f.y / (xt * tan(he)), 0.0, 1.0);
    var prof = pow(cos(u * PI * 0.5), 0.75);
    if (arch == 3) { prof = pow(1.0 - u, 0.8) * 1.25; }
    let xa = xt - archH * prof;
    let xcc = xt - archH * select(1.0, 1.25, arch == 3) - 0.3;
    if (arch != 2) {
      kt_add(&h, max(abs(zc) - 0.1 * sc, max(f.x - xa, xcc - f.x)) * 0.7, 3.0);
      kt_add(&h, max(abs(zc) - 0.13 * sc, abs(f.x - xa) - 0.04) * 0.7, 1.0);
    }
    if (arch == 3) {
      // Crossing ribs vaulting between the arches.
      let rib = max(abs(abs(zc) - f.y * 0.55 * P / (xt * tan(he) * 2.0)) - 0.025, abs(f.x - xcc + 0.06) - 0.05) * 0.6;
      kt_add(&h, rib, 1.0);
    }
  }

  // Gate halo rings around the axis at every period.
  let zg = fmod(p.z + P * 0.5, P) - P * 0.5;
  kt_add(&h, length(vec2f(f.r - (xc - 0.14), zg)) - 0.022, 4.0);

  // Doors every second period: a disc with an aperture that breathes with the music.
  let zd = fmod(p.z + P, P * 2.0) - P;
  kt_add(&h, max(abs(zd) - 0.05, S.p[1].z - f.r), 5.0);
  return h;
}

fn kt_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * kt_map(p + k.xyy * e).d + k.yyx * kt_map(p + k.yyx * e).d +
                   k.yxy * kt_map(p + k.yxy * e).d + k.xxx * kt_map(p + k.xxx * e).d);
}

fn kt_ao(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  var w = 1.0;
  for (var i = 1; i <= 4; i++) {
    let h = 0.03 + 0.09 * f32(i);
    occ += (h - kt_map(p + n * h).d) * w;
    w *= 0.65;
  }
  return sat(1.0 - occ * 2.5);
}

// Carved glyphs: each cell is a 3x4 grid of hashed strokes with a border.
fn kt_glyph(uv: vec2f, seed: f32) -> f32 {
  let c = floor(uv);
  let f = fract(uv);
  let inner = step(0.12, f.x) * step(f.x, 0.88) * step(0.1, f.y) * step(f.y, 0.9);
  let g = (f - vec2f(0.12, 0.1)) / vec2f(0.76, 0.8);
  let s = floor(g * vec2f(3.0, 4.0));
  let sf = fract(g * vec2f(3.0, 4.0));
  let on = step(0.58, hash13(vec3f(c, s.x + s.y * 3.0 + seed)));
  let stroke = step(0.18, sf.x) * step(sf.x, 0.82) + step(0.3, sf.y) * step(sf.y, 0.7);
  return inner * on * sat(stroke);
}

fn kt_lightCol() -> vec3f { return mix(F.pal3.rgb / max(luma(F.pal3.rgb), 0.05) * 0.6, vec3f(1.0, 0.9, 0.7), 0.4); }

fn kt_env(dir: vec3f) -> vec3f {
  let fwd = sat(dir.z);
  let core = pow(fwd, 60.0) * 2.5 + pow(fwd, 6.0) * 0.15;
  let around = palL(atan2(dir.y, dir.x) / TAU * 2.0 + S.p[3].x, 0.08) * (0.5 + 0.75 * fwd);
  return kt_lightCol() * core * S.p[2].z + around * select(1.0, 0.4, i32(S.p[6].z) == 2);
}

fn kt_sunDir() -> vec3f {
  let a = S.p[7].y;
  return normalize(vec3f(cos(a), sin(a), 0.35));
}

/** Melody hoop: N-gon of light at the pitch's radius, racing away down the corridor from each note. */
fn kt_age(v: f32) -> f32 { return v - floor(v / 16.0) * 16.0; }
fn kt_lvl(v: f32) -> f32 { return floor(v / 16.0) / 63.0; }
fn kt_leadFront(roz: f32) -> f32 { return roz + 3.2 + kt_age(S.p[4].w) * 24.0; }
// As bright as the note was strong, swelling in over ~0.12 s (never a one-frame flash).
fn kt_leadAmp() -> f32 {
  let a = kt_age(S.p[4].w);
  return kt_lvl(S.p[4].w) * smoothstep(0.0, 0.12, a) * exp(-a * 1.6) * step(a, 2.5) * (0.55 + 0.45 * F.leadHeld + 0.8 * F.lead);
}
fn kt_leadCol() -> vec3f { return palL(S.p[3].x + F.morph2.x * 0.3 + 0.5 + 0.15 * F.leadPitch, 1.0); }
/** Snare: a wave of light along the friezes and risers, running away from the camera. */
fn kt_snareWave(z: f32, roz: f32) -> f32 {
  let a = kt_age(S.p[5].y);
  let dz = z - (roz + 1.0 + a * 22.0);
  return kt_lvl(S.p[5].y) * smoothstep(0.0, 0.1, a) * exp(-dz * dz * 0.25) * exp(-a * 2.2) * step(a, 1.5);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let z = F.travel * 0.7;
  let rig = i32(S.p[6].y + 0.5);
  let lightM = i32(S.p[6].z + 0.5);
  let matM = i32(S.p[6].x + 0.5);
  let off = S.p[4].z * vec2f(cos(F.spin * 0.31), sin(F.spin * 0.23));
  let ro = vec3f(off, z);
  var ta = vec3f(off * 0.3, z + 4.0);
  if (rig == 3) {
    // Side gaze: look out toward the naves at an angle while travelling.
    let a = F.spin * 0.07;
    ta = ro + normalize(vec3f(cos(a) * S.p[7].x, sin(a) * S.p[7].x, 1.0)) * 4.0;
  }
  let cam = lookAt(ro, ta, S.p[3].z);
  let fov = 1.0 + 0.35 * S.p[3].w - 0.25 * S.p[4].x;
  let rd = normalize(cam * vec3f(q, fov));
  let hue = S.p[3].x + F.morph2.x * 0.3;
  let sun = kt_sunDir();

  let far = 40.0;
  var t = 0.02 + ign(frag) * 0.04;
  var hit = false;
  var h: KtHit;
  var dust = vec3f(0.0);
  for (var i = 0; i < 120; i++) {
    let pos = ro + rd * t;
    h = kt_map(pos);
    if (h.d < 0.0005 * t + 0.0003) { hit = true; break; }
    let st = h.d * 0.85;
    // Light shafts: radial sheets above each dome, broken up by drifting dust.
    let f = kt_frame(pos);
    let sheet = exp(-f.y * f.y * 10.0) * smoothstep(S.p[0].w, 0.8, f.r);
    let dn = sat(noise3fast(pos * 1.3 + vec3f(0.0, 0.0, -S.p[7].z * 0.3)) * 0.8 + 0.3);
    let core = exp(-f.r * f.r * 1.5);
    let lantern = select(0.0, 0.5, lightM == 1);
    dust += (palL(hue + 0.4, 0.12) * sheet * dn * dn * 0.6 + kt_lightCol() * core * (S.p[2].z * 0.12 + lantern * 0.15)) * min(st, 0.6) * exp(-t * 0.05);
    t += st;
    if (t > far) { break; }
  }

  let fogCol = F.pal0.rgb * 0.5 + kt_lightCol() * pow(sat(rd.z), 10.0) * 0.15 * S.p[2].z;
  var col = kt_env(rd);
  if (hit) {
    let pos = ro + rd * t;
    let n = kt_normal(pos, max(0.0006, 0.0008 * t));
    let ao = kt_ao(pos, n);
    let f = kt_frame(pos);
    let refl = reflect(rd, n);
    let fre = pow(1.0 - sat(dot(n, -rd)), 5.0);
    // Central light far down the axis plus a soft lantern glow from the axis itself.
    let lc = normalize(vec3f(-pos.xy, 6.0));
    let la = normalize(vec3f(-pos.xy, 0.001));
    let lightCol = kt_lightCol();
    let lanternK = select(select(0.35 + 0.4 * F.energySlow, 1.4 + 0.6 * F.energySlow, lightM == 1), 0.12, lightM == 2);
    let difC = sat(dot(n, lc)) * S.p[2].z;
    var difA = sat(dot(n, la)) * lanternK / (1.0 + f.r * f.r * 0.08);
    if (lightM == 3) {
      // Raking sun from one side: naves facing it glow, the rest fall into shade.
      difA += sat(dot(n, sun)) * 1.1 * (0.7 + 0.5 * S.p[6].w);
    }
    let spC = pow(sat(dot(refl, lc)), 60.0) * S.p[2].z + select(0.0, pow(sat(dot(refl, sun)), 40.0) * 1.5, lightM == 3);
    let env = kt_env(refl);
    let P = S.p[1].y;
    let cz = floor(pos.z / P);
    let band = fract(f.sid / S.p[0].x * 0.7 + cz * 0.137 + 0.05);
    let lvl = spec(0.08 + 0.85 * band);
    let glow = palL(hue + band * 0.5, 0.45);
    let warm = select(pal(hue + 0.2), lightCol, lightM == 3);
    if (h.mat < 0.5 || (h.mat > 2.5 && h.mat < 3.5)) {
      // Stone of the chosen material.
      let vein = fbm3(pos * vec3f(2.0, 2.0, 0.7), 3);
      var alb = mix(palRampL(0.12 + 0.18 * vein, 0.05), palRampL(0.4, 0.04), smoothstep(0.1, 0.4, abs(vein))) + vec3f(0.03);
      var rk = mix(0.04, 0.7, fre);
      if (matM == 1) { alb = mix(vec3f(0.55, 0.54, 0.5), palRampL(0.8, 0.45), 0.25) * (0.85 + 0.3 * smoothstep(0.0, 0.05, abs(vein - 0.1))); rk = mix(0.03, 0.5, fre); }
      else if (matM == 2) { alb = vec3f(0.012); rk = mix(0.12, 1.0, fre); }
      else if (matM == 3) { alb = mix(vec3f(0.42, 0.3, 0.18), palRampL(0.6, 0.3), 0.3) * (0.85 + 0.3 * vein); rk = 0.02; }
      else if (matM == 4) { alb = vec3f(0.02); rk = mix(0.5, 1.0, fre); }
      if (h.mat > 2.5) { alb *= 0.6; }
      col = alb * (lightCol * difC * 0.5 + warm * difA * 0.6 + F.pal0.rgb * 0.3 + vec3f(0.01)) * ao;
      col += env * rk * ao * select(vec3f(1.0), mix(vec3f(1.0), palL(hue, 0.5), 0.4), matM == 4);
      col += lightCol * spC * select(0.8, 0.1, matM == 3);
      let ek = S.p[3].y * select(1.0, 1.8, matM == 2);
      if (h.mat < 0.5) {
        // Glyph bands carved into risers glow with the nave's band.
        let riser = smoothstep(0.03, 0.0, abs(abs(fmod(pos.z, P) - P * 0.5) - (P * 0.3 - 0.2 * floor(clamp((S.p[0].w - f.x) / 0.24, 0.0, 2.0)))));
        let gz = kt_glyph(vec2f(f.y * 12.0, f.x * 12.0), cz);
        let colBand = select(0.0, smoothstep(0.04, 0.0, abs(fract(f.x * 1.5) - 0.5) - 0.12), kt_arch() == 4);
        col += glow * max(riser, colBand) * gz * (0.03 + 6.0 * lvl * lvl * lvl + 2.5 * kt_snareWave(pos.z, ro.z)) * ek;
      } else {
        // Spandrel / lintel: glyph frieze whose cells each listen to one spectrum band.
        let face = max(smoothstep(-0.6, -0.9, n.z), select(0.0, 1.0, kt_arch() == 4));
        let guv = vec2f(f.y * 9.0, f.x * 9.0 + select(0.0, pos.z * 9.0, kt_arch() == 4));
        let gb = fract(floor(guv.x) * 0.131 + floor(guv.y) * 0.217 + f.sid * 0.071);
        let gl = spec(0.06 + 0.9 * gb);
        // Each bar a wave of light runs away down the corridor.
        let sweep = exp(-abs(pos.z - ro.z - 1.5 - F.barPhase * 18.0) * 1.2) * 1.5 * F.energy;
        let g = kt_glyph(guv, cz * 1.7);
        col += palL(hue + gb * 0.6, 0.45) * face * g * (0.02 + 9.0 * pow(max(gl - 0.2, 0.0), 2.0) + 0.5 * S.p[4].y + sweep + 3.5 * kt_snareWave(pos.z, ro.z)) * ek;
      }
    } else if (h.mat < 1.5 || h.mat > 4.5) {
      // Accent metal of the chosen material.
      var gold = mix(vec3f(1.0, 0.72, 0.32), F.pal3.rgb / max(luma(F.pal3.rgb), 0.05) * 0.6, 0.35);
      if (matM == 1) { gold = palL(hue + 0.35, 0.45); }
      else if (matM == 3) { gold = vec3f(0.55, 0.32, 0.14); }
      else if (matM == 4) { gold = vec3f(0.9); }
      let f0 = gold * select(0.8, 0.15, matM == 3);
      let fr = f0 + (vec3f(1.0) - f0) * fre * select(1.0, 0.2, matM == 3);
      col = fr * (env * 1.3 + warm * 0.4 * sat(dot(refl, la))) * (0.4 + 0.6 * ao);
      col += gold * (lightCol * difC * 0.25 + warm * difA * select(0.5, 1.0, matM == 3)) * ao;
      col += lightCol * gold * spC * 2.5;
      col += gold * kt_snareWave(pos.z, ro.z) * 0.5 * (0.3 + fre);
      if (matM == 2) {
        // Neon: accents become emissive tubes of light.
        col = col * 0.3 + glow * (0.5 + 3.0 * lvl * lvl + 1.5 * S.p[2].x) * S.p[3].y * 0.6;
      }
      if (matM == 1) { col += gold * 0.15 * (0.4 + lvl) * ao; }
      if (h.mat > 4.5) {
        // Door leaves: concentric glyph rings (gothic: rose-window tracery), seams glowing as they close.
        var gr = kt_glyph(vec2f(atan2(pos.y, pos.x) / TAU * S.p[0].x * 4.0, f.r * 3.0), cz * 3.1);
        if (kt_arch() == 3) {
          let petal = abs(fract(atan2(pos.y, pos.x) / TAU * S.p[0].x * 2.0) - 0.5);
          gr = smoothstep(0.06, 0.0, abs(petal * f.r - 0.15 * sin(f.r * 4.0) - 0.1)) + smoothstep(0.04, 0.0, abs(fract(f.r * 1.2) - 0.5) - 0.42);
        }
        col = col * 0.7 + glow * gr * (0.02 + 2.5 * lvl * lvl * lvl) * S.p[3].y;
        col += lightCol * smoothstep(0.03, 0.0, f.r - S.p[1].z) * (0.15 + 1.5 * S.p[3].w);
      }
    } else if (h.mat < 2.5) {
      // Halos: emissive by the nave's band, flashed by kicks.
      col = glow * (0.4 + 8.0 * lvl * lvl + 4.0 * S.p[2].x) * S.p[3].y + env * 0.2;
    } else {
      // Gate rings: glyph dashes around the axis, kick flash.
      let dash = step(0.35, fract(atan2(pos.y, pos.x) / TAU * S.p[0].x * 6.0));
      let gb = fract(cz * 0.173);
      let gl = spec(0.05 + 0.9 * gb);
      col = palL(hue + 0.5 + gb * 0.4, 0.45) * (0.05 + dash * (0.25 + 5.0 * gl * gl * gl) + 2.5 * S.p[2].x) * S.p[3].y;
    }
  }
  let leadA = kt_leadAmp();
  let leadZ = kt_leadFront(ro.z);
  let leadR = S.p[2].y;
  if (hit && leadA > 0.01) {
    // Stone and metal near the hoop catch its light.
    let pos = ro + rd * t;
    let f = kt_frame(pos);
    col += kt_leadCol() * leadA * exp(-abs(pos.z - leadZ) * 1.15) * exp(-abs(f.x - leadR) * 1.8) * 0.9;
  }
  let fogAmt = 1.0 - exp(-t * 0.045);
  col = mix(col, fogCol, fogAmt * select(0.6, 1.0, hit));
  col += dust * S.p[2].w * 0.45;
  // The hoop itself, crossing the view ray at its plane.
  if (leadA > 0.01 && rd.z > 0.02) {
    let tp = (leadZ - ro.z) / rd.z;
    if (tp > 0.05 && (!hit || tp < t)) {
      let fp = kt_frame(ro + rd * tp);
      let w = max(0.035, tp * 2.0 / (F.res.y * fov));
      let dl = fp.x - leadR;
      let line = exp(-dl * dl / (w * w)) * (0.035 / w) + exp(-abs(dl) * 8.0) * 0.04;
      col += kt_leadCol() * leadA * line * 3.2 * exp(-tp * 0.03);
    }
  }
  // Drop: the central light floods the corridor.
  col += kt_lightCol() * pow(sat(rd.z), 3.0) * S.p[4].x * S.p[4].x * 0.6;
  return vec4f(col, 1.0);
}
`,
});
