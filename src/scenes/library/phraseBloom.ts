import { ANIM_WGSL, EventTrack, FollowChain, Spring, phraseArc } from '../anim';
import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * The fine phase (RULES v7) integrated with the air of the mix: it moves as the detail layer and the
 * high notes say, faster with more air (about as given at typical air), and only faintly in a bare
 * passage, so a high note over near silence re-forms the fine detail gently instead of jolting it.
 * A jump (new cue or seek) restarts it where the raw phase is.
 */
class FinePhase {
  x = 0;
  private last = NaN;
  update(raw: number, air: number): number {
    if (!(Math.abs(raw - this.last) < 2)) this.x = raw;
    else this.x += (raw - this.last) * (0.1 + 1.8 * air);
    this.last = raw;
    return this.x;
  }
}
let finePhase = new FinePhase();


/**
 * Follows an event-driven target (a count, or a sum of steps): each change eases in by smoothstep over
 * `dur` seconds, from rest to rest, so it never snaps and leaves no tail however close the hits come.
 */
class Glide {
  x: number;
  private base: number;
  private target: number;
  private q: [number, number][] = [];
  constructor(x = 0, private dur = 0.6) {
    this.x = this.base = this.target = x;
  }
  update(target: number, dt: number): number {
    if (target !== this.target) this.q.push([0, target - this.target]);
    this.target = target;
    for (const e of this.q) e[0] += dt;
    while (this.q.length && this.q[0][0] >= this.dur) this.base += this.q.shift()![1];
    this.x = this.base;
    for (const [age, v] of this.q) {
      const t = age / this.dur;
      this.x += v * t * t * (3 - 2 * t);
    }
    return this.x;
  }
  reset(x = 0): void {
    this.x = this.base = this.target = x;
    this.q = [];
  }
}

/**
 * Reaction strength from the morph's event level, rising from nothing: squared where a kind's level runs
 * high (it then rises as softly as the hit), the level itself where it sits mid-range (squared it would
 * barely read).
 */
const strength = (level: number, p = 2) => level ** p;

/**
 * The strength side of a front: each event adds its strength to a sum that eases in exactly like the
 * count glide, and the latest strength follows on a quick spring. The lasting state behind a front,
 * sum + level * (phase state - count), then steps by that event's strength (a faint hit a faint
 * change), and it is continuous however the levels and fronts overlap.
 */
class Strength {
  readonly sum: Glide;
  // Slow enough that a new hit never re-brightens a front still burning from the last one in a frame.
  readonly level = new Spring(0, 0.15);
  private total = 0;
  private n = 0;
  constructor(dur: number, private readonly p = 2) {
    this.sum = new Glide(0, dur);
  }
  reset(events: number, level: number): void {
    this.n = events;
    this.total = 0;
    this.sum.reset(0);
    this.level.reset(strength(level, this.p));
  }
  update(events: number, level: number, dt: number): void {
    if (events > this.n) this.total += (events - this.n) * strength(level, this.p);
    this.n = events;
    this.sum.update(this.total, dt);
    this.level.update(strength(level, this.p), dt);
  }
}
/** A strength (0..1) as an 8-bit integer, for packing. */
const q8 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);


/**
 * Phrase Bloom: you glide between two sheets of flowing light lines, a floor and a ceiling that
 * meet at a glowing horizon (refs 15 and 16). Each sheet is the streamlines of a 2D potential flow:
 * a uniform stream bent around a few soft dipoles. The flow's potential gives every line a true
 * "along" coordinate, so reactions can travel along the fibres rather than as rings.
 *
 * One idea, built from animation principles:
 *  - constant flow: light streaks stream down every line at a steady, beat-tied pace (morph.travel);
 *  - the field morphs all the time (dipoles drift with the morph), and every kick and snare steps it
 *    to a new lasting shape (morph.at steps), springing in from rest over about two thirds of a beat;
 *  - overlapping action: the ceiling follows the floor's heading through a lagging spring chain;
 *  - every front rides a glide that follows its event count (each hit eases in by smoothstep over 0.6 s for a kick, 1 s for a snare or note), so it swells in from
 *    rest with a soft edge and the change it leaves eases in, however close the hits come: no snaps;
 *    kicks also surge the streaks on and snares spin the dipoles on the same springs;
 *  - kick: a fire front ignites deep ahead and races along the streamlines (fast along, slow across,
 *    each line at its own speed), white-hot edge, cooling embers, and behind it every line has
 *    stepped round the hue wheel for good;
 *  - snare: an electric front jumps line to line from one struck line, and behind it the lines'
 *    colour pattern is reshuffled for good;
 *  - melody: each note lights a ribbon of light threaded through the streamlines at its pitch,
 *    burning both ways along the fibres from a point near the viewer, in the pitch colour;
 *  - phrase: tension builds through each 8-bar phrase (finer hairlines appear, glow tightens) and
 *    each phrase downbeat sends a broad front in from the horizon that turns the whole palette.
 */

const morph = new Morph(0.6);
/**
 * The morph coordinates through one more critically damped follower (settling in about a third of a
 * second): a kick's step reshapes the whole field of dipoles, and on the morph's own spring alone it
 * reaches full speed within a frame or two; this lets it gather speed from rest instead.
 */
const atGlide = { x: new Float64Array(8), v: new Float64Array(8) };
function glideAt(dt: number, reset: boolean): Float64Array {
  const w = 14;
  const e = Math.exp(-w * dt);
  for (let i = 0; i < 8; i++) {
    const tgt = morph.at[i];
    if (reset) {
      atGlide.x[i] = tgt;
      atGlide.v[i] = 0;
      continue;
    }
    const d = atGlide.x[i] - tgt;
    const c = atGlide.v[i] + w * d;
    atGlide.v[i] = (atGlide.v[i] - w * c * dt) * e;
    atGlide.x[i] = tgt + (d + c * dt) * e;
  }
  return atGlide.x;
}
const phrase = new EventTrack();
const heading = new FollowChain(2, 0, 0.35, 3.5);
const tension = new Spring(0, 0.6);
let seed = -1;
/** Song time of the last frame: a jump (a seek) restarts every glide, so renders never depend on what came before. */
let lastT = -1;
/**
 * Glides following the kick, snare and note counts since the seed: the fronts' phases (kicks also
 * surge the streaks on, snares spin the dipoles), and the melody's pitch.
 */
const pump = { k: new Glide(0, 0.6), s: new Glide(0, 1.0), l: new Glide(0, 1.0), pitch: new Spring(0, 0.2), pitchT: 0, ln: 0, k0: 0, s0: 0, l0: 0 };
const str = { k: new Strength(0.6), s: new Strength(1.0), l: new Strength(1.0) };

export default raymarchScene({
  meta: {
    id: 'phrase-bloom',
    name: 'Phrase Bloom',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.5 },
    genres: { edm: 1, synthwave: 1, techno: 0.9, pop: 0.8, ambient: 0.7, dnb: 0.7, lofi: 0.6 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, dt, g);
    const seek = Math.abs(m.time - lastT - dt) > 0.5;
    const a = glideAt(dt, seek || g[0] !== seed);
    lastT = m.time;
    if (seek || g[0] !== seed || morph.kicks < pump.k0 || morph.snares < pump.s0 || morph.notes < pump.l0) {
      seed = g[0];
      phrase.reset();
      finePhase = new FinePhase();
      heading.reset(0);
      tension.reset(0);
      pump.k.reset(0);
      pump.s.reset(0);
      pump.l.reset(0);
      pump.pitch.reset(morph.notePitch);
      pump.pitchT = morph.notePitch;
      pump.ln = morph.notes;
      str.k.reset(morph.kicks, morph.kickLevel);
      str.s.reset(morph.snares, morph.snareLevel);
      str.l.reset(morph.notes, morph.noteLevel);
      pump.k0 = morph.kicks;
      pump.s0 = morph.snares;
      pump.l0 = morph.notes;
    }
    str.k.update(morph.kicks, morph.kickLevel, dt);
    str.s.update(morph.snares, morph.snareLevel, dt);
    str.l.update(morph.notes, morph.noteLevel, dt);
    // Each note moves the ribbon's pitch toward its own by its strength.
    if (morph.notes > pump.ln) pump.pitchT += (morph.notePitch - pump.pitchT) * morph.noteLevel;
    pump.ln = morph.notes;
    const arc = phraseArc(m.barIndex, m.barPhase, 8, m.anticipation);
    phrase.update(arc.index, dt);
    tension.halflife = (60 / Math.max(60, m.bpm)) * 2;
    tension.update(arc.tension, dt);
    // The floor's stream heading drifts with the morph; the ceiling follows it late (overlap).
    heading.update(0.45 * Math.sin(a[6]) + 0.2 * Math.sin(a[7] * 1.7) + (g[1] - 0.5) * 0.6, dt);

    // The phrase framing (morph.cam) on top of the morph's own lean: pitch, roll, yaw, the lens and
    // the eye's height between the sheets (kept well clear of both).
    const cam = morph.cam;
    const focal = Math.min(2.0, Math.max(0.68, 1.25 / cam.fov));
    const yaw = Math.max(-0.45, Math.min(0.45, 0.8 * cam.yaw));
    p[0] = 0.04 * Math.sin(a[5] * 0.7) + (g[2] - 0.5) * 0.06 + 0.45 * cam.pitch;
    p[1] = 0.07 * Math.sin(a[4] * 0.6) + (g[3] - 0.5) * 0.1 + 0.8 * cam.roll;
    p[2] = heading.at(0);
    p[3] = -heading.at(1) + (g[4] - 0.5) * 0.5;
    p[4] = wave(g[5] * 9 + a[3] * 0.3, 2.2, 3.6);
    const xk = pump.k.update(morph.kicks - pump.k0, dt);
    const xs = pump.s.update(morph.snares - pump.s0, dt);
    // The streaks stream steadily, and each kick surges them on by its strength, gliding from rest.
    p[5] = morph.travel * 2.0 + 1.0 * str.k.sum.x;
    // Line density (fraction of 4, 1.1..1.6) and the eye height (integer part, 1/1000) share a slot.
    p[6] = 4 * Math.round(1000 * (1 + Math.max(-1, Math.min(1, cam.height)))) + 1.1 + g[6] * 0.5;
    p[7] = g[7] + 0.05 * Math.sin(a[2] * 0.5);
    // Three soft dipoles (x across, z depth, orientation), carried by the morph.
    for (let i = 0; i < 3; i++) {
      p[8 + i * 3] = wave(a[i] + g[i + 1] * 6, -2.4, 2.4);
      p[9 + i * 3] = wave(a[i + 3] * 0.8 + g[i + 2] * 6, 3.2 + i * 2, 7 + i * 3);
      p[10 + i * 3] = a[(i + 5) % 8] * 0.9 + g[i] * 6 + (i === 0 ? 0.3 : -0.2) * str.s.sum.x;
    }
    p[17] = morph.flow;
    p[18] = tension.x;
    p[19] = phrase.count;
    p[20] = xk;
    // The fronts' strength sums (kick, snare) and recent strengths (packed: kick, snare, note).
    p[21] = str.k.sum.x;
    p[22] = str.s.sum.x;
    p[23] = Math.min(phrase.age, 99);
    p[24] = xs;
    // The focal length (integer part, 1/1024) and yaw (fraction) share a slot.
    p[25] = Math.round(focal * 1024) + 0.999 * (yaw / 0.9 + 0.5);
    p[26] = q8(str.k.level.x) + 256 * q8(str.s.level.x) + 65536 * q8(str.l.level.x);
    p[27] = pump.l.update(morph.notes - pump.l0, dt);
    // Fine scale from the high end (RULES v7): a phase the detail layer flows and each high note,
    // backing chord and hat steps (by level, eased by the morph), and the air of the mix.
    p[28] = finePhase.update(1.2 * morph.detailAt[0] + 2.0 * morph.upperPhase + 0.5 * morph.backingPhase + 0.25 * morph.hatPhase, morph.detailDrive);
    p[29] = pump.pitch.update(pump.pitchT, dt);
    p[30] = morph.detailDrive;
    p[31] = g[0] * 31;
  },
  wgsl: /* wgsl */ `
${ANIM_WGSL}

fn pb_cinv(d: vec2f, soft: f32) -> vec2f { return vec2f(d.x, -d.y) / (dot(d, d) + soft); }
fn pb_cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

fn pb_dip(i: i32) -> vec3f {
  let k = i * 3;
  return vec3f(S.p[(8 + k) / 4][(8 + k) % 4], S.p[(9 + k) / 4][(9 + k) % 4], S.p[(10 + k) / 4][(10 + k) % 4]);
}

/** Complex potential of the sheet at plane point q = (x, depth): returns (phi along, psi across). */
fn pb_flow(q: vec2f, side: f32) -> vec2f {
  let ang = select(S.p[0].w, S.p[0].z, side > 0.0);
  let z = vec2f(q.y, q.x * side);
  var w = pb_cmul(z, vec2f(cos(ang), -sin(ang)));
  for (var i = 0; i < 3; i++) {
    let d = pb_dip(i);
    let c = vec2f(d.y + select(2.5, 0.0, side > 0.0), d.x);
    let s = 1.1 + 0.6 * sin(d.z * 1.3 + f32(i) * 2.0);
    w += s * pb_cmul(vec2f(cos(d.z), sin(d.z)), pb_cinv(z - c, 0.45));
  }
  return w;
}

// Rotates a colour about the grey axis, so lasting hue changes read on any palette, even a one-hue one.
fn pb_rot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735);
  let ca = cos(a);
  return max(c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca), vec3f(0.0));
}

fn pb_hash(k: f32, salt: f32) -> f32 { return hash11(k * 1.618 + salt * 13.7 + S.p[7].w); }

// Phase fronts. x follows an event count, each event easing in by smoothstep over 0.6 s (about a beat) (from rest, one unit per
// event, however close the events come); tau in [0, 0.5] the point's arrival fraction. Returns
// (state, u): the lasting state steps by 1 per event, eased in as the front passes; u is how far the
// front has gone past (0..1, at least 0.5 at rest). Continuous in x, so nothing can snap.
fn pb_phase(x: f32, tau: f32) -> vec2f {
  let y = x - tau;
  let u = fract(y);
  return vec2f(floor(y) + smoothstep(0.0, 0.5, u), u);
}
// A soft bump on 0 < u < h: the glow at the front.
fn pb_bump(u: f32, h: f32) -> f32 { let s = sin(PI * min(u / h, 1.0)); return s * s; }
// Arrival time (beats) to arrival fraction: fast near the origin, slowing as it spreads.
fn pb_tau(t: f32, k: f32) -> f32 { return 0.5 * (1.0 - exp(-t / k)); }

/**
 * Melody: a ribbon at the (gliding) pitch burns both ways along the fibres from a point near the viewer
 * (lines further from its centre start a little late: overlapping action): a comet head swells and
 * runs out along the lines, leaving a lit trail in the pitch colour that fades as the phase settles.
 */
fn pb_ribbon(u: f32, w: vec2f, k: f32, lineMask: f32, side: f32, pitch: f32, xl: f32) -> vec3f {
  let N = S.p[1].x;
  let we = pb_flow(vec2f(pitch * 2.2, 4.5), side);
  let j = abs(u - we.y * N);
  // A ribbon of light filling the space between the bundle's lines, threaded by the lines themselves.
  let rib = (u - we.y * N) / 2.0;
  let bundle = exp(-rib * rib) * (0.2 + lineMask);
  let off = abs(w.x - we.x);
  let pn = pb_phase(xl, pb_tau(off / 9.0 + min(j, 3.0) * 0.08, 1.2));
  let comet = pb_bump(pn.y, 0.45);
  let trail = pb_bump(pn.y, 0.5) * exp(-off * 0.04);
  let ncol = pb_rot(palL(0.5 + pitch * 0.45 + S.p[1].w, 1.0), 3.14 + pitch * 1.6);
  return ncol * bundle * (trail * 0.7 + comet * 0.6) * min(xl, 1.0) * floor(S.p[6].z / 65536.0) / 255.0;
}

/** One sheet of streamlines seen at plane point q; returns linear colour. */
fn pb_sheet(q: vec2f, depth: f32, side: f32) -> vec3f {
  let spb = 60.0 / clamp(F.bpm, 50.0, 220.0);
  let N = S.p[1].x;
  let w = pb_flow(q, side);
  // Fine scale: the high end winds every line along its length (two octaves of meander whose phase
  // the detail layer sets, deeper with the air of the mix). The lines stay the flow's own lines.
  let fph = S.p[7].x;
  let u = w.y * N + (0.07 + 0.14 * S.p[7].z) * (sin(w.x * 1.6 + fph) + 0.45 * sin(w.x * 3.7 - 1.4 * fph + 2.0));
  let k = floor(u + 0.5);
  let dl = abs(u - k);
  let fu = max(fwidth(u), 1e-4);
  let jit = pb_hash(k, side);

  // --- kick: fire along the fibres from a point deep ahead (gliding with the kick phase); behind it
  // the hue steps on for good.
  let xk = S.p[5].x;
  let ko = vec2f(1.5 * sin(xk * 2.1 + S.p[7].w), 9.0 + 2.0 * sin(xk * 1.3));
  let w0 = pb_flow(ko, side);
  let pK = pb_phase(xk, pb_tau(anim_fibreArrival(w.x - w0.x, u - w0.y * N, jit, 12.0, 0.07), 0.6));
  // The fronts' recent strengths (kick, snare, note).
  let lq = S.p[6].z;
  let lvK = fmod(lq, 256.0) / 255.0;
  let lvS = fmod(floor(lq / 256.0), 256.0) / 255.0;
  // Each lasting state steps by its event's strength: sum + strength * (phase state - count).
  let kState = S.p[5].y + lvK * (pK.x - xk);
  // The fire swells and fades as the front passes each line, as bright as the hit: never cut off.
  let kBump = pb_bump(pK.y, 0.45) * min(xk, 1.0);
  let kHeat = kBump * lvK;

  // --- snare: an electric front hopping line to line from one struck line; reshuffles colours.
  let xs = S.p[6].x;
  let so = vec2f(1.2 * sin(xs * 2.7 + 2.0), 4.5);
  let ws0 = pb_flow(so, side);
  let pS = pb_phase(xs, pb_tau(anim_fibreArrival((w.x - ws0.x) * 0.2, u - ws0.y * N, jit, 9.0, 0.035), 0.6));
  let sState = S.p[5].z + lvS * (pS.x - xs);
  let sHeat = pb_bump(pS.y, 0.45) * min(xs, 1.0) * lvS;
  let si = floor(sState);
  var pat = mix(hash11(k * 0.917 + si * 7.13 + side * 3.0), hash11(k * 0.917 + (si + 1.0) * 7.13 + side * 3.0), fract(sState));

  // --- phrase: a broad front in from the horizon turns the palette; tension refines the lines.
  let pa = S.p[5].w / spb;
  let Tp = clamp((24.0 - depth) / 12.0, 0.0, 2.0) * (0.8 + 0.4 * jit);
  let pState = anim_frontState(S.p[4].w, pa, Tp, 99.0, 0.0, 1.5);
  let ten = S.p[4].z;
  // Where lines are finer than a pixel, per-line values (hashes, front heat) would flicker pixel to
  // pixel: fade them to their averages.
  let merge = smoothstep(0.08, 0.3, fu);
  let crisp = 1.0 - merge;
  pat = mix(pat, 0.5, merge);

  // Line colour: lasting hue from kicks, snare pattern and phrase, plus a gradient with depth.
  let hue = S.p[1].w + kState * 0.09 + pat * 0.2 + pState * 0.23 + depth * 0.012 + (side - 1.0) * 0.12;
  let turn = kState * 0.7 + pat * 1.4 + pState * 1.4 + (side - 1.0) * 0.6;
  let flow = S.p[4].y;
  let tone = 0.75 + 0.4 * mix(spec(fract(jit * 0.8 + 0.1)), 0.35, merge);

  // Line profile: a crisp core about 1.5 px wide plus a soft halo, merged to an average when the
  // lines get finer than a pixel (no moire at the horizon).
  let core = 1.0 - smoothstep(0.6, 1.6, dl / fu);
  let gw = mix(0.12, 0.06, ten);
  let halo = exp(-dl * dl / (gw * gw));
  let lineAmt = mix(core + 0.22 * halo, 0.07, merge);
  // Hairlines between the lines, revealed by the phrase's tension.
  let u2 = u * 3.0;
  let d2 = abs(u2 - floor(u2 + 0.5));
  let hair = (1.0 - smoothstep(0.5, 1.4, d2 / max(fwidth(u2), 1e-4))) * (1.0 - smoothstep(0.1, 0.35, fu * 3.0)) * smoothstep(0.15, 0.9, ten) * step(0.12, dl);

  // Streaks of light flowing down each line toward the viewer, at a steady pace.
  let D = S.p[1].z - 4.0 * floor(S.p[1].z * 0.25);
  let ph = fract(w.x * D * 0.18 + S.p[1].y * (0.6 + 0.5 * jit) * 0.18 + jit * 7.0);
  let streak = exp(-ph * 3.0) * (0.35 + 0.65 * flow);
  let fp = fwidth(w.x * D * 0.18);
  let streakAA = mix(streak, 0.2, max(smoothstep(0.2, 0.8, fp), merge));

  var col = pb_rot(palL(hue, 0.24 * tone), turn) * lineAmt * (0.55 + 0.75 * streakAA);
  col += pb_rot(palL(hue + 0.35, 0.22), turn + 1.2) * hair * (0.5 + streakAA);

  // Kick fire on the lines: white-hot edge to orange embers, plus sparks thrown at the edge.
  let fire = mix(vec3f(1.0, 0.42, 0.12), vec3f(1.0, 0.85, 0.6), smoothstep(0.3, 0.9, kHeat));
  let lineMask = mix(core + 0.6 * halo, 0.2, merge);
  col += fire * kHeat * lineMask * 1.5 * crisp;
  let cell = floor(w.x * 5.0);
  let spark = step(0.86, hash11(cell * 3.7 + k * 11.3 + floor(kState))) * smoothstep(0.6, 1.0, kBump) * lvK;
  col += vec3f(1.0, 0.7, 0.4) * spark * (core + 0.3 * halo) * 1.4 * crisp;
  // Snare: a sharp front in the palette's far colour.
  col += pb_rot(palL(hue + 0.5, 1.0), turn + 2.6) * sHeat * (lineMask + 0.25 * halo) * 0.9 * crisp;

  // Melody: a ribbon at the note's pitch burns both ways along the fibres (lines further from its
  // centre start a little late: overlapping action), leaving a lit trail in the pitch colour.
  col += pb_ribbon(u, w, k, lineMask, side, S.p[7].y, S.p[6].w);

  // A dark, coloured sheen on the sheet so the floor reads as a surface.
  col += pb_rot(palL(hue - 0.1, 0.02), turn) * (0.6 + 0.4 * flow);
  // Depth: light falls off with distance, lines dissolve into a coloured haze.
  let fog = exp(-depth * 0.09);
  return col * fog + palL(S.p[1].w + 0.6, 0.02) * (1.0 - fog);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let sp = (uv - 0.5) * vec2f(F.aspect, -1.0);
  let r = rot2(S.p[0].y) * sp;
  // The phrase framing: focal length, pitch, then yaw; the eye rides between the sheets.
  let focal = floor(S.p[6].y) / 1024.0;
  let yaw = (fract(S.p[6].y) / 0.999 - 0.5) * 0.9;
  var rd = normalize(vec3f(r.x, r.y, focal));
  let cp = cos(S.p[0].x); let sp0 = sin(S.p[0].x);
  rd = vec3f(rd.x, rd.y * cp + rd.z * sp0, rd.z * cp - rd.y * sp0);
  rd = vec3f(rd.x * cos(yaw) + rd.z * sin(yaw), rd.y, rd.z * cos(yaw) - rd.x * sin(yaw));
  let eh = (floor(S.p[1].z * 0.25) / 1000.0 - 1.0) * 0.3;
  let hf = 1.0 + eh;
  let hc = 1.35 - eh;
  let ay = max(abs(rd.y), 1e-3);
  // Both sheets are shaded every pixel (branch-free, so screen derivatives stay valid).
  let tf = hf / ay;
  let tc = hc / ay;
  let qf = vec2f(rd.x * tf, rd.z * tf);
  let qc = vec2f(rd.x * tc, rd.z * tc);
  let floorC = pb_sheet(qf, qf.y, 1.0);
  let ceilC = pb_sheet(qc + vec2f(0.0, 1.5), qc.y, -1.0) * 0.6;
  var col = select(ceilC, floorC, rd.y < 0.0);
  // The horizon where the sheets meet glows faintly in the palette.
  let hz = exp(-ay * 26.0);
  col += pb_rot(palL(S.p[1].w + 0.25, 0.08), 2.0 + rd.x * 1.5) * hz;
  col *= 0.95 + 0.25 * S.p[4].z;
  col = max(mix(vec3f(luma(col)), col, 1.35), vec3f(0.0));
  col += (ign(frag) - 0.5) / 255.0;
  return vec4f(col, 1.0);
}
`,
});
