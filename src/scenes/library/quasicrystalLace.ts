import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Quasicrystal Lace: an N-fold quasicrystal (a sum of N plane waves, N = 5..11) on a single plane.
 * The order is the subject: the rosettes and star motifs are large and readable, a few to a dozen
 * across the frame. The plane glides and slowly turns.
 *
 * Endless zoom (RULES v8): the lace is drawn at three octave scales round a slowly drifting centre,
 * with the zoom level growing with the morph travel (drops dive faster). Each octave turns its wave
 * star and shifts its phases by its own id, so every new octave is new lace. Finer lace surfaces as
 * faint zero lines inside the tiles, gains its side levels as it grows, takes the lead and fades
 * out as it grows coarse.
 *
 * Rendering: per octave, iso-lines at three levels (-s, 0, +s) are thin neon tubes, anti-aliased by
 * that octave's own screen derivative, laid over each other coarse to fine by weight (so crossings
 * stay saturated, never white). Between the lines, a dark glossy fill shaded by the blended wave-sum
 * gradient, in one saturated hue, so each rosette reads as a glowing lace tile on real darks.
 *
 * Morph: each phrase brings a new fold count (cross-faded over about a bar). The continuous
 * coordinates set the wave phases, the glide and turn of the plane, the level spacing, the line
 * weight and the palette hue.
 * Kick: adds a fixed phase step to every wave, for good, so the lace re-forms. The step lands behind
 * a front that runs out from a point on the plane over about half a second; each point eases into
 * its new phase, and the previous kick's front is kept so its change always finishes.
 * Snare: turns one wave's direction (the wave the snare count selects), behind a front that runs
 * across that wave's lines. The turn is small: snares come often, and a large turn on each one would
 * keep the whole lace moving and hide the other events.
 * Melody: each note steps the phase of the wave its pitch selects (and every wave a little). The step glides in on a critically damped
 * spring (from rest, fastest at about 0.15 s, settled in about 0.8 s) while a glow runs out from the point at the pitch's angle. The step stays.
 * Drops: rush the flow (the morph travel multiplies the glide and turn speed).
 * Nothing snaps: every change eases in from rest over a few tenths of a second or more.
 *
 * Every event's change is scaled by its strength (morph's kick, snare and note levels, captured as
 * each event lands): a faint hit nudges the lace, a hard one re-forms it fully, and its glow follows.
 *
 * The lasting state lives in the TS side (melody steps, snare turns, the kick total and the phrase
 * fold count). Each wave's slot packs its lasting snare turn (integer part, in 4096ths of a turn) with
 * its phase (fraction, in turns); the shader adds the latest snare's turn and kicks' steps behind
 * their fronts.
 *
 * DNA: 0 start, 1 base angle, 2 snare turn size, 3 palette hue, 5 snare turn sense.
 */

const morph = new Morph(0.7);
const TAU = Math.PI * 2;
const MAX_N = 11;
const fract = (x: number) => x - Math.floor(x);
const hash = (x: number) => fract(Math.sin(x * 127.1 + 311.7) * 43758.5453);

/** Fold count for a phrase: 5..11, never the same as the one it replaces. */
function foldFor(seed: number, phrase: number, prev: number): number {
  const n = 5 + Math.floor(hash(phrase * 7.13 + seed * 97.3) * 7);
  return n === prev ? 5 + ((n - 5 + 1) % 7) : n;
}
/** Wave index a melody note steps in an n-fold lace. */
const melodyBin = (pitch: number, n: number) => Math.floor(Math.min(0.999, Math.max(0, pitch * 0.5 + 0.5)) * n);
/** Phase a note adds to its wave: about 1-2.6 radians, larger for higher notes. */
const melodyStep = (pitch: number) => 1.8 + 0.8 * pitch;

const st = {
  seed: -1,
  notes: 0,
  phrases: 0,
  n: 5,
  nOld: 5,
  xf: 1,
  dlt: 0.3,
  beta0: 0,
  base: new Float64Array(MAX_N),
  theta: new Float64Array(MAX_N),
  thetaT: new Float64Array(MAX_N),
  thetaV: new Float64Array(MAX_N),
  pitch: 0,
  prevPitch: 0,
  lAge: 9,
  lPrev: 9,
  kicks: 0,
  kAge: 9,
  kPrev: 9,
  // Event strengths (0..1), captured as each lands: the latest and previous kick and note, the latest
  // snare. kBase sums the strengths of the kicks before those two.
  kL: 0,
  kLp: 0,
  kBase: 0,
  lL: 0,
  lLp: 0,
  // Snares: the count seen, each wave's lasting turn, the latest snare's wave (-1 none) and strength.
  snares: 0,
  turn: new Float64Array(MAX_N),
  sW: -1,
  sL: 0,
  surge: 0,
  surgeV: 0,
  drive: 0,
  driveV: 0,
};

/** The fine detail phase, glided (value, velocity), and its raw input last frame. */
const detailSm = { x: 0, v: 0, t: 0, raw: 0, a: 0.15, av: 0 };
/**
 * How strongly an event lands: its level (0..1) through a soft curve that rises at twice the
 * level's slope from zero and eases into 1, times the music's presence right now (the morph's drive,
 * loudness and bass, through a smooth S-curve that starts at 0 and reaches 1 at full drive: about 0.9 in a full mix, about 0.1 at a near-silent gap). A hit in near silence barely stirs the world, a hard hit
 * in a full mix lands fully, and there is no threshold anywhere in between.
 */
const presence = () => {
  const x4 = Math.max(0, morph.drive) ** 4;
  return (x4 * (1 + 0.55 ** 4)) / (x4 + 0.55 ** 4);
};
const strength = (lv: number) => lv * (2 - lv) * presence();

/** One step of a critically damped spring toward `target`: starts from rest, never overshoots. */
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}

export default raymarchScene({
  meta: {
    id: 'quasicrystal-lace',
    name: 'Quasicrystal Lace',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.6 },
    genres: { edm: 0.8, techno: 0.7, synthwave: 0.9, pop: 0.6, ambient: 0.7, dnb: 0.5, classical: 0.4 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.flowAt;

    if (g[0] !== st.seed || morph.notes < st.notes) {
      st.seed = g[0];
      st.notes = morph.notes;
      st.phrases = morph.phrases;
      st.n = st.nOld = foldFor(g[0], morph.phrases, 0);
      st.xf = 1;
      st.theta.fill(0);
      st.thetaT.fill(0);
      st.thetaV.fill(0);
      st.pitch = st.prevPitch = morph.notePitch;
      st.lAge = st.lPrev = 9;
      st.kicks = morph.kicks;
      st.kAge = st.kPrev = 9;
      st.kL = st.kLp = st.kBase = st.lL = st.lLp = st.sL = 0;
      st.snares = morph.snares;
      st.turn.fill(0);
      st.sW = -1;
      st.surge = morph.surge;
      st.drive = morph.drive;
      st.surgeV = st.driveV = 0;
      st.dlt = (0.2 + 0.15 * g[2]) * (g[5] < 0.5 ? -1 : 1);
      st.beta0 = g[1] * TAU;
      for (let i = 0; i < MAX_N; i++) st.base[i] = g[(i % 7) + 1] * TAU;
    }

    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const beat = 60 / Math.max(40, m.bpm);
    const bar = beat * Math.max(1, m.beatsPerBar);
    // Each phrase brings a new fold count; the lace cross-fades to it over about a bar.
    if (morph.phrases !== st.phrases) {
      st.phrases = morph.phrases;
      st.nOld = st.n;
      st.n = foldFor(g[0], morph.phrases, st.n);
      st.xf = 0;
    }
    st.xf = Math.min(1, st.xf + dt / Math.max(0.8, bar));

    // Melody: each note steps the phase of its wave. The step glides in on a critically damped spring
    // (from rest, fastest at about 0.15 s, settled in about 0.8 s) while the note's glow runs out across the plane.
    if (morph.notes > st.notes) {
      st.notes = morph.notes;
      st.prevPitch = st.pitch;
      st.pitch = morph.notePitch;
      st.lPrev = st.lAge + dt;
      st.lLp = st.lL;
      st.lL = strength(morph.noteLevel);
      // A wave's phase re-forms the whole lace, so the steps go by the strength squared: a faint note is
      // a glow and a slight shift, a strong one in a full mix re-forms the lace.
      const l2 = st.lL * st.lL;
      st.thetaT[melodyBin(st.pitch, st.n)] += l2 * melodyStep(st.pitch);
      // Every wave also takes a small step (its sign set by the pitch), so the whole lace re-forms.
      for (let i = 0; i < MAX_N; i++) st.thetaT[i] += l2 * (st.pitch >= 0 ? 1 : -1) * (0.15 + 0.12 * Math.sin(i * 2.3));
    } else st.lPrev = Math.min(9, st.lPrev + dt);
    st.lAge = morph.leadAge;
    const w = 6 / Math.max(0.3, beat * 1.3);
    for (let i = 0; i < MAX_N; i++) [st.theta[i], st.thetaV[i]] = spring(st.theta[i], st.thetaV[i], st.thetaT[i], 6.7, dt);
    // The previous kick's age: its front is still drawn, so its change always finishes.
    if (morph.kicks !== st.kicks) {
      st.kicks = morph.kicks;
      st.kPrev = st.kAge + dt;
      // The kick before the previous one has finished: its step joins the lasting total.
      st.kBase += st.kLp;
      st.kLp = st.kL;
      st.kL = strength(morph.kickLevel);
    } else st.kPrev = Math.min(9, st.kPrev + dt);
    // Snare: the previous snare's turn joins its wave's lasting turn; the new one turns the wave its
    // count selects, by its strength, behind its front.
    if (morph.snares !== st.snares) {
      st.snares = morph.snares;
      if (st.sW >= 0) st.turn[st.sW] = (st.turn[st.sW] + st.dlt * st.sL) % TAU;
      st.sW = (morph.snares - 1) % st.n;
      st.sL = strength(morph.snareLevel);
    }
    st.kAge = morph.kickAge;
    // A drop's whip and the drive's light glide in rather than jump.
    [st.surge, st.surgeV] = spring(st.surge, st.surgeV, morph.surge, w * 0.5, dt);
    [st.drive, st.driveV] = spring(st.drive, st.driveV, morph.drive, w, dt);

    // Wave phases: the lasting base and melody steps, plus the continuous flow. Kick steps are added
    // in the shader, behind the kick front.
    // Each slot: the wave's lasting snare turn (4096ths of a turn) and its phase (fraction of a turn).
    for (let i = 0; i < MAX_N; i++) {
      // The flow's share is about a third of what it was: the zoom's steady dive carries the base motion.
      const ph = st.base[i] + 0.25 * a[i % 8] + 0.15 * a[(i + 3) % 8] + st.theta[i];
      p[i] = (Math.round(fract(st.turn[i] / TAU) * 4096) % 4096) + Math.min(fract(ph / TAU), 0.999);
    }
    p[11] = 0.45 * Math.sin(a[0] * 0.18 + 1.3); // plane glide x (slow: the zoom carries the motion)
    // Fold counts (new * 16 + old) with the cross-fade in the fraction.
    p[12] = st.n * 16 + st.nOld + 0.98 * st.xf;
    // Fine detail (RULES v7): the high end re-forms the lace's fine wobble. Its amplitude follows the
    // detail drive (highs, high melody, backing), its phase flows with the detail coordinates and steps
    // with each high note, backing chord and hat (eased, strength-weighted). Amplitude in thousandths,
    // phase (turns) in the fraction.
    // High notes carry the change (a turn of up to 7 radians each, by strength); the detail
    // coordinates, backing and hats barely drift it (a steady drift would blur what each note does). Glided on a critically damped spring (its
    // quickest about 0.12 s after a note, settled in about 0.5 s), so a note re-forms the detail smoothly.
    const dT = 0.03 * morph.detailAt[0] + 0.02 * morph.detailAt[1] + 7 * morph.upperPhase + 0.25 * morph.backingPhase + 0.03 * morph.hatPhase;
    // Its changes count by the music's presence too (a jump means a new cue: start there).
    const dInc = dT - detailSm.raw;
    detailSm.raw = dT;
    if (Math.abs(dInc) > 20) [detailSm.x, detailSm.v, detailSm.t] = [dT, 0, dT];
    else detailSm.t += dInc * presence();
    [detailSm.x, detailSm.v] = spring(detailSm.x, detailSm.v, detailSm.t, 12, dt);
    // The detail depth follows the detail drive, weighted by the presence, gliding in over a couple of seconds.
    [detailSm.a, detailSm.av] = spring(detailSm.a, detailSm.av, 0.15 + 0.85 * morph.detailDrive * presence(), 1.5, dt);
    const dPh = detailSm.x;
    p[13] = Math.round(Math.min(1, Math.max(0, detailSm.a)) * 1000) + 0.98 * fract(dPh / TAU);
    // The zoom (RULES v8), in octaves: dives with the travel (so drops rush deeper), a new octave of
    // lace arriving every few seconds in a full mix. The DNA sets where in the dive a cue starts.
    p[14] = morph.travel * 0.28 + g[0] * 16;
    // Plane turn (radians): slow, and a drop whips it round while the surge eases off.
    p[15] = 0.5 * Math.sin(a[2] * 0.2) + 0.3 * Math.sin(a[0] * 0.13) + 0.9 * st.surge * Math.sin(morph.travel * 0.9);
    // Event strengths ride in the fractions: the kick count's (latest kick), the previous kick's age,
    // the snare wave's (latest snare). The two notes' strengths are 8-bit integers.
    p[16] = morph.kicks + 0.98 * st.kL;
    p[17] = Math.min(morph.kickAge, 9);
    p[18] = st.sW + 1 + 0.98 * st.sL;
    p[19] = Math.min(morph.snareAge, 9);
    p[20] = Math.round(st.beta0 * 1000) + (0.98 * (st.dlt + 1)) / 2;
    p[21] = Math.round(st.lL * 255) * 256 + Math.round(st.lLp * 255);
    // Pitches of the note and the one before it (integer and fraction), then their ages (likewise).
    p[22] = Math.round((Math.max(-2, Math.min(2, st.pitch)) + 2) * 100) + (Math.max(-2, Math.min(2, st.prevPitch)) + 2) / 10;
    p[23] = Math.floor(Math.min(st.kPrev, 9) * 1000) + 0.98 * st.kLp;
    p[24] = Math.round(Math.min(morph.leadAge, 9) * 1000) + st.lPrev / 10;
    p[25] = st.drive + st.surge;
    p[26] = st.kBase;
    p[27] = 0.45 * Math.sin(a[1] * 0.15 + 2.1); // plane glide y
    // Morph: level spacing, line half-width (px), palette hue. p[31] is spare.
    p[28] = wave(a[6], 0.16, 0.34);
    p[29] = wave(a[5], 0.9, 1.4);
    p[30] = g[3] + 0.05 * Math.sin(a[7] * 0.5);
    p[31] = 0;
  },
  wgsl: /* wgsl */ `
const LQ_K: f32 = 9.0;

// Phase each kick adds to wave fi. Fixed per wave, so every kick re-forms the lace.
fn lq_kstep(fi: f32) -> f32 { return 0.35 + 0.5 * fract(fi * 0.6180339 + 0.25); }

// Wave i's slot: its lasting snare turn (x, radians) and its phase (y, radians).
fn lq_slot(i: i32) -> vec2f {
  let v = S.p[i / 4][i % 4];
  return vec2f(floor(v) / 4096.0, fract(v)) * TAU;
}
// Packed constants: the base angle (integer part, in thousandths) and the snare turn size (fraction).
fn lq_beta0() -> f32 { return floor(S.p[5].x) / 1000.0; }
fn lq_dlt() -> f32 { return fract(S.p[5].x) / 0.98 * 2.0 - 1.0; }

// A critically damped ease from rest, e seconds after a front passes: no jump in value or speed, 90%
// there by 0.2 s and settled by about 0.3 s.
fn lq_ease(e: f32) -> f32 { let u = max(e, 0.0) / 0.08; return 1.0 - (1.0 + u) * exp(-u); }
// The snare's turn re-forms the whole lace, so its ease follows its strength: a firm hit settles in
// about 0.5 s, a faint one glides in over about 1.3 s (a gentle hit, a gentle change).
fn lq_easeS(e: f32, l: f32) -> f32 { let u = max(e, 0.0) / (0.07 + 0.25 * (1.0 - l) * (1.0 - l)); return 1.0 - (1.0 + u) * exp(-u); }
// A front's glow: rises from rest, peaks 50 ms after the front passes and has cooled by about 0.25 s.
fn lq_edge(e: f32) -> f32 { let u = max(e, 0.0) / 0.05; return u * u * exp(2.0 - 2.0 * u); }

// Fully saturated neon at value v (no mixing toward white or grey).
fn lq_hsv(h: f32, v: f32) -> vec3f { return hsv2rgb(vec3f(fract(h), 1.0, v)); }

// The zoom level (octaves) and the centre the zoom dives into, drifting slowly with z.
fn lq_z() -> f32 { return S.p[3].z; }
fn lq_c(z: f32) -> vec2f { return vec2f(0.3 * sin(z * 0.37 + F.seed * 6.0), 0.2 * cos(z * 0.29 + F.seed * 4.0)); }

// The n-fold field on the plane P.
//  Directions: pi i / n plus each wave's lasting snare turn; the latest snare's wave (wS) turns by
//  sTurn more (its strength times dlt, eased in behind its front).
//  Phases: the lasting base and melody phases and the kick steps (kc, which already holds the eased,
//  strength-scaled progress of the kick fronts at this point).
//  Each zoom octave turns the wave star by its own angle (rot) and shifts each wave by its own phase
//  (seeded by the octave id oid), so every octave that arrives is new lace, not a copy. hd is the
//  high end's phase: each wave sways by hw times a turn of it (hw grows with the octave's scale, so
//  the finest lace re-forms most).
fn lq_field(n: i32, P: vec2f, sTurn: f32, wS: i32, kc: f32, rot: f32, oid: f32, hd: f32, hw: f32) -> vec3f {
  let nf = f32(n);
  let beta0 = lq_beta0() + rot;
  var f = 0.0;
  var gr = vec2f(0.0);
  for (var i = 0; i < 11; i++) {
    if (i >= n) { break; }
    let fi = f32(i);
    let sl = lq_slot(i);
    let a = beta0 + PI * fi / nf + sl.x + select(0.0, sTurn, i == wS);
    let k = LQ_K * vec2f(cos(a), sin(a));
    let ph = sl.y + lq_kstep(fi) * kc + TAU * hash11(oid * 1.618 + fi * 0.137) + hw * sin(hd + fi * 2.39996);
    let arg = dot(k, P) + ph;
    f += cos(arg);
    gr -= k * sin(arg);
  }
  return vec3f(f / nf, gr / nf);
}

// One zoom octave's field: the lace at scale s round the drifting centre c, the old fold count
// cross-faded into the new one after a phrase change. The star turns by the octave id's angle and the
// high end sways its waves by s times the detail depth, so the finest lace re-forms most.
fn lq_oct(nN: i32, nO: i32, xs: f32, P: vec2f, c: vec2f, s: f32, id: f32, sTurn: f32, wS: i32, kc: f32, hd: f32, hAmp: f32) -> vec3f {
  let Q = c + (P - c) * s;
  let hw = hAmp * s * 0.3;
  var fv = lq_field(nN, Q, sTurn, wS, kc, id * 0.7, id, hd, hw);
  if (xs < 1.0) { fv = mix(lq_field(nO, Q, sTurn, wS, kc, id * 0.7, id, hd, hw), fv, xs); }
  return fv;
}

// A crisp iso-line at level L of the field: x = line core coverage (1 px, anti-aliased), y = halo.
fn lq_line(f: f32, L: f32, fw: f32, lw: f32) -> vec2f {
  let d = abs(f - L) / fw;
  return vec2f(sat(lw + 0.5 - d), exp(-d * 0.7));
}

// Glossy fill between the lines: a tube-like shading from the wave-sum gradient (its brightness; the
// octaves' fills are blended and then take one saturated hue, so crossing octaves never go pastel).
fn lq_fill(gr: vec2f) -> f32 {
  let n = normalize(vec3f(-gr * 0.12, 1.0));
  let ld = normalize(vec3f(-0.5, 0.6, 0.7));
  let hv = normalize(ld + vec3f(0.0, 0.0, 1.0));
  let dif = max(dot(n, ld), 0.0);
  let spc = pow(max(dot(n, hv), 0.0), 40.0);
  // Tile centres are flat (dark); the rims, where the field is steep, glow.
  let rim = smoothstep(1.2, 4.5, length(gr));
  return 0.005 + rim * (0.25 * (0.4 + 0.6 * dif) + 0.15 * spc);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  // The plane: gliding and slowly turning.
  let P0 = rot2(S.p[3].w) * q + vec2f(S.p[2].w, S.p[6].w);
  // Fine wobble (the high end): a high-octave warp of the plane, about 0.2 units across, whose phase
  // turns with the high notes and whose depth follows the detail drive. The lace lines themselves
  // re-form at that fine scale.
  let dAmp = floor(S.p[3].y) / 1000.0;
  let dPh = fract(S.p[3].y) / 0.98 * TAU;
  let P = P0 + 0.055 * dAmp * vec2f(sin(31.0 * P0.y + 7.0 * P0.x + dPh) + 0.5 * sin(47.0 * P0.x - 2.0 * dPh),
                                    sin(29.0 * P0.x - 9.0 * P0.y - dPh) + 0.5 * cos(43.0 * P0.y + 2.0 * dPh));

  let nCode = floor(S.p[3].x);
  let nN = i32(floor(nCode / 16.0));
  let nO = i32(nCode - 16.0 * floor(nCode / 16.0));
  let xf = sat(fract(S.p[3].x) / 0.98);
  let kicks = floor(S.p[4].x);
  let lK = sat(fract(S.p[4].x) / 0.98);
  let kAge = S.p[4].y;
  let wS = i32(floor(S.p[4].z)) - 1;
  let lS = sat(fract(S.p[4].z) / 0.98);
  let sAge = S.p[4].w;
  let dlt = lq_dlt();
  let beta0 = lq_beta0();
  let lN = floor(S.p[5].y / 256.0) / 255.0;
  let lNp = (S.p[5].y - 256.0 * floor(S.p[5].y / 256.0)) / 255.0;
  let mP = floor(S.p[5].z) / 100.0 - 2.0;
  let mPp = fract(S.p[5].z) * 10.0 - 2.0;
  let kPrev = floor(S.p[5].w) / 1000.0;
  let lKp = sat(fract(S.p[5].w) / 0.98);
  let lAge = floor(S.p[6].x) / 1000.0;
  let lPrev = fract(S.p[6].x) * 10.0;
  let drive = S.p[6].y;
  let kBase = S.p[6].z;
  let sp = S.p[7].x;
  let lw = S.p[7].y;
  let hue0 = S.p[7].z;

  // Kick: a front from a point on the plane, crossing it in about 0.15 s. Behind it every
  // wave takes its kick step, each point easing in from rest (settled in about 0.3 s). The previous kick's front is kept, so
  // its step always finishes before it is folded into the count.
  let gK = lK;
  let gKp = lKp;
  let kA = beta0 + kicks * 2.39996;
  let kO = 0.6 * vec2f(cos(kA), sin(kA));
  let dk = length(P - kO);
  let tK = dk / 20.0 + 0.03 * hash12(vec2f(floor(dk * 9.0), 3.0));
  let eK = kAge - tK;
  let kAp = beta0 + (kicks - 1.0) * 2.39996;
  let dkp = length(P - 0.6 * vec2f(cos(kAp), sin(kAp)));
  let eKp = kPrev - (dkp / 20.0 + 0.03 * hash12(vec2f(floor(dkp * 9.0), 3.0)));
  let pkK = lq_ease(eK) * gK;
  let kc = kBase + lq_ease(eKp) * gKp + pkK;
  // Kick and snare glows are brief (they have faded before a following note); the note's lasts longer.
  let fireK = lq_edge(1.4 * eK) * gK + lq_edge(1.4 * eKp) * gKp;
  let uK = max(eK, 0.0) / 0.15;
  let embK = uK * uK * exp(2.0 - 2.0 * uK) * gK;

  // Snare: a front across the lines of the wave it turned. The turn itself is in lq_field.
  let nNf = f32(nN);
  let wSi = max(wS, 0);
  let aW = beta0 + PI * f32(wSi) / nNf + lq_slot(wSi).x;
  let uW = vec2f(cos(aW), sin(aW));
  let tS = max(dot(P, uW) + 1.8, 0.0) / 22.0 + 0.03 * hash12(vec2f(floor(dot(P, vec2f(-uW.y, uW.x)) * 7.0), 9.0));
  let eS = sAge - tS;
  let pkS = lq_easeS(eS, lS) * lS;
  // Its glow goes with the square of its strength, like the note's.
  let fireS = 2.4 * lq_edge(1.4 * eS) * lS * lS;

  // Melody: a glow from the point at the pitch's angle (the note's phase step glides in the TS side).
  let mO = 1.25 * vec2f(cos(PI * mP), sin(PI * mP));
  let dm = length(P - mO);
  let tM = dm / 20.0 + 0.03 * hash12(vec2f(floor(dm * 9.0), 5.0));
  let eM = lAge - tM;
  // The previous note's glow is still drawn, so a new note never cuts it off.
  let dmp = length(P - 1.25 * vec2f(cos(PI * mPp), sin(PI * mPp)));
  let eMp = lPrev - (dmp / 20.0 + 0.03 * hash12(vec2f(floor(dmp * 9.0), 5.0)));
  // The note's glow rises over about 0.1 s and cools over about 0.5 s. Its brightness goes with the
  // square of the note's strength: a faint note barely glows, a firm one lights the lines fully.
  // The glow is a local ripple round the note's point (fading with distance), not a flash of the plane.
  let fireM = 2.3 * (lq_edge(0.5 * eM) * lN * lN * exp(-dm * dm * 0.7) + lq_edge(0.5 * eMp) * lNp * lNp * exp(-dmp * dmp * 0.7));

  // The lace through the zoom (RULES v8): three octaves of lace round the drifting centre, each
  // drawn crisply in its own right (lines anti-aliased by its own field's screen width) and blended
  // by the zoom weights, sharpened so one octave leads at a time: the next finer lace surfaces inside
  // the tiles, brightens and takes over while the coarse one fades, and a new one starts below it.
  let z = lq_z();
  let zc = lq_c(z);
  let xs = select(1.0, xf * xf * (3.0 - 2.0 * xf), xf < 1.0);
  var wq = vec3f(zoomWeight(z, 0), zoomWeight(z, 1), zoomWeight(z, 2));
  wq = wq * wq;
  wq = wq / (wq.x + wq.y + wq.z);
  var fil = 0.0;
  var fb = 0.0;
  var lin = vec3f(0.0);
  var ab = 0.0;
  var lc = vec3f(0.0);
  var onLine = 0.0;
  for (var o = 0; o < 3; o++) {
    let id = zoomOctaveId(z, o);
    let sc = zoomScale(z, o) * 0.5;
    let fv = lq_oct(nN, nO, xs, P, zc, sc, id, dlt * pkS, wS, kc, dPh, dAmp);
    let f = fv.x;
    let fw = max(fwidth(f), 1e-4);
    // Three crisp iso-levels, a hue family that shifts with the level, the octave and each kick.
    let hl = hue0 + 0.25 * f + 0.12 * kc + 0.13 * id;
    let l0 = lq_line(f, 0.0, fw, lw);
    let lp = lq_line(f, sp, fw, lw);
    let lm = lq_line(f, -sp, fw, lw);
    // A fine octave arrives as its zero line alone; its side levels draw in as it grows coarser.
    let side = 1.0 - smoothstep(0.6, 1.5, sc);
    let core = max(l0.x, side * max(lp.x, lm.x));
    let on = core + (l0.y + side * (lp.y + lm.y)) * 0.08;
    let lineCol = lq_hsv(hl, 1.0);
    // The glossy fill between the lines (a complementary hue family), blended by weight. The lines are
    // laid over it, coarse to fine, each by its coverage times its weight: the neon stays pure
    // saturated colour where octaves cross instead of adding up to white.
    fil += wq[o] * lq_fill(fv.yz);
    fb += wq[o] * f;
    let al = sat(core) * min(1.0, 1.5 * wq[o]);
    lin = lin * (1.0 - al) + lineCol * al;
    ab = ab * (1.0 - al) + al;
    lin += lineCol * (on - core) * wq[o];
    lc += wq[o] * lineCol * on;
    onLine += wq[o] * on;
  }

  var col = lq_hsv(hue0 + 0.5 + 0.8 * fb + 0.12 * kc + 0.05 * z, 1.0) * fil * (1.0 - ab) + lin;

  // Fronts burn along the lines they cross: white-hot edge, orange embers, then the colour is kept.
  let hot = vec3f(1.0, 0.82, 0.55);
  let ember = vec3f(1.0, 0.35, 0.08);
  col += (lc * 1.0 + hot * 0.3 * onLine) * fireK + ember * embK * 0.5 * onLine;
  col += (lc * 3.2 + lq_hsv(hue0 + 0.55, 1.0) * 2.4 * onLine) * fireS;
  col += (lc * 3.8 + lq_hsv(hue0 + 0.5 + 0.4 * mP, 1.0) * 3.3 * onLine) * fireM;

  // A little more light on drops, and a soft roll-off.
  col *= 0.85 + 0.3 * drive;
  col = col / (1.0 + 0.25 * max(col.r, max(col.g, col.b)));
  return vec4f(col, 1.0);
}
`,
});
