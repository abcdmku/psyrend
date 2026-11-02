import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';
import type { MusicState } from '../../audio/musicState';

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


const TAU = Math.PI * 2;
const wrap = (x: number) => x - TAU * Math.floor(x / TAU);
const chordHue = (m: MusicState, cur: number) => (m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : cur);
const easeHue = (cur: number, to: number, k: number) => {
  let d = to - cur;
  d -= Math.round(d);
  return cur + d * k;
};

/** One step of a critically damped spring toward `target`: starts from rest, settles in about 5/w s, never overshoots. */
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}

/** Per-instance state: the morph, the melody's steering (aim point and fan roll) and the chord colour. */
/**
 * The phrase framing (morph.cam: fov, pitch, yaw, roll, height) re-timed to the music: it moves
 * toward its target in eased steps on kicks, snares and melody notes (each by its strength), with
 * a slow drift so it still arrives in quiet passages. The eye also follows the melody: each note
 * tilts the look a little by its pitch and turns it a notch, a lasting change that glides in.
 * Every step settles on a critically damped spring (~0.4 s at w = 7), so nothing snaps.
 */
class Framing {
  readonly cam = { fov: 1, pitch: 0, yaw: 0, roll: 0, height: 0 };
  private readonly goal = [0, 0, 0, 0, 0];
  private readonly val = [0, 0, 0, 0, 0];
  private readonly vel = [0, 0, 0, 0, 0];
  private gazeP = 0;
  private gazeY = 0;
  private k = 0;
  private s = 0;
  private n = 0;

  /**
   * `gaze`: the melody's look offset (radians at full strength); `w`: the step spring's rate (1/s);
   * `drift`: time constant (s) of the unprompted glide toward the target.
   */
  constructor(
    private readonly gaze = 0.05,
    private readonly w = 7,
    private readonly drift = 6,
  ) {}

  update(mo: Morph, dt: number, reset: boolean): void {
    const c = mo.cam;
    let take = 1 - Math.exp(-dt / this.drift);
    if (reset) {
      take = 1;
      this.gazeP = this.gazeY = 0;
    } else {
      // Steps scale with each event's level squared (which carries how loud the passage is): a quiet
      // intro barely moves the lens. The gaze moves toward each note's look as far as the note is strong.
      if (mo.kicks > this.k) take = 1 - (1 - take) * (1 - 0.22 * mo.kickLevel ** 2);
      if (mo.snares > this.s) take = 1 - (1 - take) * (1 - 0.1 * mo.snareLevel ** 2);
      if (mo.notes > this.n) {
        const lv = mo.noteLevel ** 2;
        take = 1 - (1 - take) * (1 - 0.2 * lv);
        this.gazeP += ((mo.notePitch - 0.5) * 2 * this.gaze - this.gazeP) * lv;
        this.gazeY += ((mo.notes % 2 ? 1 : -1) * this.gaze * 0.8 - this.gazeY) * 0.7 * lv;
      }
    }
    this.k = mo.kicks;
    this.s = mo.snares;
    this.n = mo.notes;
    const tgt = [Math.log(c.fov), c.pitch, c.yaw, c.roll, c.height];
    const w = this.w;
    const e = Math.exp(-w * dt);
    for (let j = 0; j < 5; j++) {
      this.goal[j] += (tgt[j] - this.goal[j]) * take;
      const gj = this.goal[j] + (j === 1 ? this.gazeP : j === 2 ? this.gazeY : 0);
      if (reset) {
        this.val[j] = gj;
        this.vel[j] = 0;
        continue;
      }
      const d = this.val[j] - gj;
      const cc = this.vel[j] + w * d;
      this.vel[j] = (this.vel[j] - w * cc * dt) * e;
      this.val[j] = gj + (d + cc * dt) * e;
    }
    this.cam.fov = Math.exp(this.val[0]);
    this.cam.pitch = this.val[1];
    this.cam.yaw = this.val[2];
    this.cam.roll = this.val[3];
    this.cam.height = this.val[4];
  }
}

interface State {
  morph: Morph;
  seed: number;
  notes: number;
  aimX: number;
  aimY: number;
  tx: number;
  ty: number;
  roll: number;
  rollTo: number;
  pitch: number;
  hue: number;
  sweep: number;
  /** Spring velocities (aim x/y, roll) and the note colour's glided pitch. */
  vx: number;
  vy: number;
  vr: number;
  pitchE: number;
  vp: number;
  /** Kick and snare counts on quick springs (from rest, settled in about a third of a second). */
  kE: number;
  vk: number;
  sE: number;
  vs: number;
  /**
   * Ages of the previous kick, snare and note packets: a new event starts a new packet, and the one
   * before keeps flying and fading instead of vanishing (no snap when events come close together).
   */
  kPrev: number;
  sPrev: number;
  lPrev: number;
  kSeen: number;
  sSeen: number;
  lSeen: number;
  /** Strengths of the latest and previous packets, and the kick and snare strength sums the steps follow. */
  kL: number;
  kLp: number;
  sL: number;
  sLp: number;
  lL: number;
  lLp: number;
  kSum: number;
  sSum: number;
  kN: number;
  sN: number;
  /** The pitch the note colour glides to: each note moves it toward its own by its strength. */
  pitchT: number;
  fine: FinePhase;
  framing: Framing;
}
/** Two values in 0..1 in one float: the first in thousandths-ish (4000 steps), the second in the fraction. */
const pack2 = (a: number, b: number) => Math.round(Math.min(1, Math.max(0, a)) * 4000) + 0.05 + 0.9 * Math.min(1, Math.max(0, b));
/** -1..1 to 0..1. */
const unit = (x: number) => 0.5 + 0.5 * x;
const states = new WeakMap<Float32Array, State>();

/** Reaction strength from the morph's event level: squared, so it rises from nothing as softly as the hit. */
const strength = (level: number) => level * level;
/** A packet's age (seconds, to 9) and strength (8 bits) in one float: 16 * strength + age. */
const packet = (age: number, lv: number) => 16 * Math.round(Math.min(1, Math.max(0, lv)) * 255) + Math.min(9, Math.max(0, age));

/**
 * Light architecture in an empty, hazed void: no floor, no rig, nothing but light lines. Fans of laser
 * light spray from points that orbit through the dark, mirrored through a turning plane so the whole
 * structure has a symmetry that keeps reshaping; a tunnel of beams converges from far ahead around
 * the viewer; and a sheet of flowing neon wave lines rolls past above or below, running away into the
 * distance. Every beam is an analytic single-scattering line integral (a crisp core no wider than a
 * couple of pixels, with a soft halo of constant angular size) through smooth haze, so a beam close
 * to the lens is a bright thin line, never a rod. Distance fades and cools every line toward the haze
 * colour, so near, mid and far separate, and each set has its own hue (the fans in the chord's
 * colour, the tunnel well round the colour circle from them, the wave lines between).
 *
 * The motion is steady: the sources orbit, the fans roll and the tunnel twists at the morph's pace,
 * and the shape coordinates (orbit, spread, mirror plane, tunnel angle and axis, sheet tilt) flow
 * through the morph and never stop. Beats never pulse anything: each one leaves the architecture in
 * a new lasting state, and a packet of light carries the change along the beams:
 * - Kick: the morph steps on, every fan turns to a new arrangement and the mirror plane swings round
 *   (on springs, settled in about a third of a second); a broad burst shoots out along the fan
 *   beams and a front runs away down every wave line (each line its own way, so the front is
 *   ragged), while the fans' and lines' colours glide on to new ones.
 * - Snare: the tunnel turns half a beam step and the mirror plane tilts, for good, and a sharp front
 *   races down the tunnel beams from beside the viewer into the distance while their colour glides
 *   on. A fast front runs down the wave lines too, and the lines glide onto a new course.
 * - Melody: a packet in the note's pitch colour runs out along the fan beams, and the fans' bodies
 *   glide to that colour; each note also steers the fans toward a point that follows the pitch and
 *   rolls them, on a spring.
 * Nothing snaps: steps glide from rest, packets swell in, and a packet still flying when the next
 *   event comes carries on and fades instead of vanishing.
 * - Chords: the colours (fans in the chord's hue, tunnel in its complement).
 *
 * DNA: 0 start point, 1 source count, 2 beams per fan, 3 hue offset, 4 haze density, 5 camera,
 * 6 source depth and sheet side, 7 tunnel density.
 */
export default raymarchScene({
  meta: {
    id: 'laser-show',
    name: 'Laser Show',
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.8 },
    genres: { edm: 1, techno: 1, dnb: 0.85, dubstep: 0.8, pop: 0.6, synthwave: 0.7, ambient: 0.4 },
    trails: 0,
    sparse: true,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    let st = states.get(p);
    if (!st) {
      st = { morph: new Morph(0.8), seed: -1, notes: 0, aimX: 0, aimY: 0, tx: 0, ty: 0, roll: 0, rollTo: 0, pitch: 0, hue: g[3], sweep: 0, vx: 0, vy: 0, vr: 0, pitchE: 0, vp: 0, kE: 0, vk: 0, sE: 0, vs: 0, kPrev: 9, sPrev: 9, lPrev: 9, kSeen: 9, sSeen: 9, lSeen: 9, kL: 0, kLp: 0, sL: 0, sLp: 0, lL: 0, lLp: 0, kSum: 0, sSum: 0, kN: 0, sN: 0, pitchT: 0, fine: new FinePhase(), framing: new Framing() };
      states.set(p, st);
    }
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const mo = st.morph;
    mo.update(m, ctx.dt, g);
    const a = mo.at;
    const fresh = g[0] !== st.seed || mo.notes < st.notes;
    st.framing.update(mo, dt, fresh);
    const fr = st.framing.cam;
    if (fresh) {
      // New cue or seek: start steering from the current note, with no glide in.
      st.seed = g[0];
      st.notes = mo.notes;
      st.hue = chordHue(m, st.hue);
      st.pitch = mo.notePitch;
      st.ty = st.aimY = mo.notePitch * 4.2;
      st.tx = st.aimX = 0;
      st.roll = st.rollTo = 0;
      st.pitchE = mo.notePitch;
      st.vx = st.vy = st.vr = st.vp = st.vk = st.vs = 0;
      st.kE = st.sE = st.kSum = st.sSum = 0;
      st.kN = mo.kicks;
      st.sN = mo.snares;
      st.pitchT = mo.notePitch;
      st.kL = st.kLp = st.sL = st.sLp = st.lL = st.lLp = 0;
      st.kPrev = st.sPrev = st.lPrev = 9;
    }
    // Melody steers the fans: each note sets a new aim (height from pitch, side from pitch class)
    // and turns the fan planes up or down the scale; the beams bend onto it over about a second.
    // Each moves by the note's level squared (the level carries how loud the passage is): a faint intro
    // note nudges the fans, a full-mix one swings them.
    if (mo.notes > st.notes) {
      st.notes = mo.notes;
      const lv = mo.noteLevel ** 2;
      const pc = Math.round((mo.notePitch * 12 + 1200) % 12);
      st.tx += (Math.sin(pc * 2.3 + g[0] * 7) * 4.5 - st.tx) * lv;
      st.ty += (mo.notePitch * 4.2 - st.ty) * lv;
      st.rollTo += Math.sign(mo.notePitch - st.pitch || 1) * (2.0 + 0.4 * Math.abs(Math.sin(pc * 1.7))) * lv;
      st.pitchT += (mo.notePitch - st.pitchT) * lv;
      st.pitch = mo.notePitch;
    }
    // Kicks and snares step the architecture by their strength (the springs below follow the sums).
    if (mo.kicks > st.kN) st.kSum += (mo.kicks - st.kN) * strength(mo.kickLevel);
    if (mo.snares > st.sN) st.sSum += (mo.snares - st.sN) * strength(mo.snareLevel);
    st.kN = mo.kicks;
    st.sN = mo.snares;
    // Steering glides on critically damped springs: from rest, settled in about two thirds of a second.
    [st.aimX, st.vx] = spring(st.aimX, st.vx, st.tx, 16, dt);
    [st.aimY, st.vy] = spring(st.aimY, st.vy, st.ty, 16, dt);
    [st.roll, st.vr] = spring(st.roll, st.vr, st.rollTo, 16, dt);
    // The melody's colour glides to each new note's pitch (about half a second).
    [st.pitchE, st.vp] = spring(st.pitchE, st.vp, st.pitchT, 16, dt);
    [st.kE, st.vk] = spring(st.kE, st.vk, st.kSum, 16, dt);
    [st.sE, st.vs] = spring(st.sE, st.vs, st.sSum, 16, dt);
    st.hue = easeHue(st.hue, chordHue(m, st.hue), 1 - Math.exp(-dt / 0.6));
    const tr = mo.travel;

    // Sources: orbit phase (steady orbit plus the morph), tilt, radius; fan spread.
    p[0] = wrap(a[0] + tr * 0.08);
    p[1] = wrap(a[1]);
    p[2] = wave(a[2], 5.5, 9.5);
    // Fans widen with the music's weight and after a drop.
    p[3] = Math.min(1.15, wave(a[3], 0.32, 0.85) * (0.85 + 0.35 * mo.drive + 0.8 * mo.surge));
    // Fan roll (steady turn, the morph and the melody's steering) and the mirror plane's normal.
    // Each kick also turns every fan to a new arrangement for good (eased over a third of a beat).
    // Fans sweep faster after a drop (an extra turn that builds with the surge, never undone).
    st.sweep += dt * 10.0 * mo.surge * (0.5 + mo.drive);
    p[4] = wrap(a[4] + st.roll + tr * 0.07 + st.kE * 1.2 + st.sweep);
    // Kicks and snares also turn the mirror plane a notch for good (gliding), so the mirrored half of
    // the structure swings to a new place: the kick round its main angle, the snare tilting it.
    const mt = a[5] + st.kE * 0.4 + st.sE * 0.2;
    const mp = 0.35 * Math.sin(a[6] + st.sE * 0.9);
    p[5] = Math.cos(mt) * Math.cos(mp);
    p[6] = Math.sin(mt) * Math.cos(mp);
    p[7] = Math.sin(mp);
    // Melody aim point; beam reach past it; the pitch of the latest note (its packet's colour).
    p[8] = st.aimX;
    p[9] = st.aimY;
    p[10] = wave(a[3] * 0.6 + a[2] * 0.5, 1.35, 2.3);
    // The packet before: when an event's age resets, the old packet carries on at its own age.
    // A new packet carries its event's strength; the one before keeps its own.
    if (mo.kickAge < st.kSeen) [st.kLp, st.kL] = [st.kL, strength(mo.kickLevel)];
    if (mo.snareAge < st.sSeen) [st.sLp, st.sL] = [st.sL, strength(mo.snareLevel)];
    if (mo.leadAge < st.lSeen) [st.lLp, st.lL] = [st.lL, strength(mo.noteLevel)];
    st.kPrev = mo.kickAge < st.kSeen ? st.kSeen + dt : Math.min(9, st.kPrev + dt);
    st.sPrev = mo.snareAge < st.sSeen ? st.sSeen + dt : Math.min(9, st.sPrev + dt);
    st.lPrev = mo.leadAge < st.lSeen ? st.lSeen + dt : Math.min(9, st.lPrev + dt);
    st.kSeen = mo.kickAge;
    st.sSeen = mo.snareAge;
    st.lSeen = mo.leadAge;
    // Tunnel: half-angle (kept wide enough to clear the lens), twist, axis tilt.
    p[12] = wave(a[6] * 0.7 + a[7] * 0.5, 0.1, 0.22) * (0.9 + 0.25 * mo.drive + 0.35 * mo.surge);
    // Each snare turns the tunnel half a beam step for good.
    p[13] = wrap(a[7] + tr * 0.12 + st.sweep * 0.5 + (st.sE * Math.PI) / (12 + Math.floor(g[7] * 3) * 4));
    // Axis tilt (x, y in -0.35..0.35 and -0.25..0.25), packed in one float.
    p[14] = pack2(unit(Math.sin(a[1] * 0.8 + a[4] * 0.3)), unit(Math.sin(a[2] * 0.9 - a[5] * 0.4)));
    // Camera framing from the phrase (morph.cam, re-timed to the beats): look pitch and yaw (packed),
    // the lens (fov multiplier) with the eye height (packed) and the roll.
    p[15] = pack2(unit(fr.pitch / 0.5), unit(fr.yaw / 0.6));
    p[26] = pack2((fr.fov - 0.4) / 2, unit(fr.height));
    // Colour, haze, level (slow: brightness never pumps with the beat).
    p[16] = st.hue + g[3] * 0.25;
    // Kick count, eased (a spring): the colour assignments glide on with each kick.
    p[17] = st.kE;
    p[18] = packet(st.sPrev, st.sLp);
    // Fine scale from the high end (RULES v7): a phase the detail layer flows and each high note,
    // backing chord and hat steps (by level, eased by the morph). It re-forms the wave lines' fine
    // course and splays the beams within each fan.
    p[19] = st.fine.update(0.4 * mo.detailAt[0] + 6.5 * mo.upperPhase + 0.5 * mo.backingPhase + 0.25 * mo.hatPhase, mo.detailDrive);
    // Event ages with their strengths: each drives a packet of light along the beams.
    p[20] = packet(mo.kickAge, st.kL);
    p[21] = packet(mo.snareAge, st.sL);
    p[22] = packet(mo.leadAge, st.lL);
    p[23] = packet(st.lPrev, st.lLp);
    // Camera: a steady slow orbit inside the structure.
    p[24] = tr * 0.06 + g[5] * TAU;
    // Wave-line sheet: roll about the tunnel axis, and its offset from the viewer (one side per cue,
    // never less than 1.8 so it can't sweep through the lens).
    // Roll in -0.7..0.7 and offset in -3.2..3.2, packed in one float.
    p[25] = pack2(unit(Math.sin(a[4] * 0.7 + a[6] * 0.6)), unit(((g[6] > 0.5 ? 1 : -1) * wave(a[5] * 0.8 + a[0] * 0.5, 1.8, 3.2)) / 3.2));
    p[11] = Math.min(3.9, Math.max(0, st.pitchE)) + 4 * Math.round(unit(fr.roll / 0.5) * 1000);
    p[27] = tr * 0.15; // haze drift
    // Style.
    // Sources 3..4, beams per fan 7..11 (x16), haze density in hundredths (x256): exact integers;
    // the level (slow: brightness never pumps with the beat) in the fraction.
    p[28] = 3 + Math.floor(g[1] * 2) + 16 * (7 + Math.floor(g[2] * 3) * 2) + 256 * Math.round(100 * (0.6 + 0.8 * g[4])) + 0.99 * Math.min(1, 0.25 + 0.75 * m.energySlow);
    // Snare count, eased (a spring): the tunnel colour and the wave lines' course glide on with each.
    p[29] = st.sE;
    p[30] = packet(st.kPrev, st.kLp);
    p[31] = 2 + 4 * g[6] + 8 * (12 + Math.floor(g[7] * 3) * 4); // source depth spread 2..6, tunnel beams 12..20 (x8)
  },
  wgsl: /* wgsl */ `
fn ls_up(v: f32) -> vec2f { let i = floor(v); return vec2f(i / 4000.0, (v - i - 0.05) / 0.9); }
fn ls_hazeK() -> f32 { return floor(S.p[7].x / 256.0) / 100.0; }
fn ls_K() -> f32 { return fmod(fmod(floor(S.p[7].x), 256.0), 16.0); }
fn ls_M() -> f32 { return floor(fmod(floor(S.p[7].x), 256.0) / 16.0); }
// A packet's (age, strength).
fn ls_pk(v: f32) -> vec2f { let l = floor(v / 16.0); return vec2f(v - 16.0 * l, l / 255.0); }
fn ls_N() -> f32 { return floor(S.p[7].w / 8.0); }
fn ls_depth() -> f32 { return S.p[7].w - 8.0 * floor(S.p[7].w / 8.0); }

fn ls_src(i: i32) -> vec3f {
  let K = ls_K();
  let th = TAU * (f32(i) + 0.5) / K + S.p[0].x;
  let R = S.p[0].z * (1.0 + 0.22 * sin(2.0 * th + S.p[0].y));
  return vec3f(cos(th) * R, sin(th) * R * 0.75 + sin(3.0 * th - S.p[0].y) * 1.2, -3.0 + sin(2.0 * th + S.p[0].y * 2.0) * ls_depth());
}

fn ls_haze(p: vec3f) -> f32 {
  // Smooth rolling banks of haze: low-frequency waves only, no grain.
  let c = S.p[6].w;
  let w1 = sin(p.x * 0.23 + sin(p.z * 0.19 + c * 0.3) * 1.6 + c * 0.2);
  let w2 = sin(p.y * 0.29 - p.z * 0.11 + sin(p.x * 0.17 - c * 0.25) * 1.4 - c * 0.15);
  return ls_hazeK() * (0.55 + 0.3 * w1 * w2 + 0.15 * w1);
}

/**
 * Single scattering from one beam (origin o, unit direction d, length L) seen along the view ray:
 * a crisp core sized to the pixel footprint and a soft volumetric halo, both in the local haze.
 * Returns (core, halo, distance along the beam of the point seen) so callers can run packets of
 * light along it. Beams fade out near the lens so none passes as a blurred rod.
 */
fn ls_beam(ro: vec3f, rd: vec3f, o: vec3f, d: vec3f, L: f32, pxA: f32, bw: f32) -> vec3f {
  let w0 = ro - o;
  let b = dot(rd, d);
  let den = max(1.0 - b * b, 1e-5);
  let u = clamp((dot(d, w0) - b * dot(rd, w0)) / den, 0.0, L);
  let q = o + d * u;
  let s = dot(q - ro, rd);
  if (s < 2.0) { return vec3f(0.0, 0.0, u); }
  let dist = length(ro + rd * s - q);
  if (dist > 1.6) { return vec3f(0.0, 0.0, u); }
  // The core is the beam's width, but never wider than about a pixel and a half on screen (a beam
  // passing close to the lens stays a thin bright line, with the same light), never thinner than one.
  let w = clamp(bw, s * pxA * 0.75, s * pxA * 1.6);
  let sinT = max(sqrt(den), 0.12);
  let core = exp(-dist * dist / (2.0 * w * w)) * (bw / w) / sinT;
  // The halo is measured in angle, so it is the same soft width near or far.
  let ang = dist / s;
  let halo = 0.0012 / (ang * ang * 150.0 + 0.006) * smoothstep(1.6, 0.3, dist) / (1.0 + s * 0.06);
  let phase = 0.55 + 1.6 * pow(sat(-b), 10.0);
  let fade = smoothstep(L, L * 0.55, u) * smoothstep(2.5, 6.5, s) / (1.0 + u * 0.035);
  let hz = ls_haze(q) * phase * fade * exp(-s * 0.045);
  return vec3f(core * hz, halo * hz, u);
}

/** The faint body of a fan: light scattered in the wedge between its beams (a scanned sheet). */
fn ls_sheet(ro: vec3f, rd: vec3f, o: vec3f, axis: vec3f, side: vec3f, spread: f32) -> vec2f {
  let n = cross(axis, side);
  let dn = dot(rd, n);
  let t = dot(o - ro, n) / select(dn, 1e-5, abs(dn) < 1e-5);
  if (t <= 0.0) { return vec2f(0.0); }
  let v = ro + rd * t - o;
  let r = length(v);
  let ang = atan2(dot(v, side), dot(v, axis));
  let inside = smoothstep(spread + 0.06, spread - 0.1, abs(ang));
  return vec2f(ls_haze(o + v) * inside * smoothstep(2.5, 6.5, t) * exp(-r * 0.06) / max(abs(dn), 0.1) * (0.4 + 0.6 * exp(-r * 0.25)), r);
}

/**
 * Laser light is pure: take the palette colour at t (or, where the palette is near grey there, its
 * most colourful entry), strip most of its white component and set its luminance to 1.
 */
fn ls_col(t: f32) -> vec3f {
  let c0 = pal(t);
  var best = c0;
  var bc = max(c0.r, max(c0.g, c0.b)) - min(c0.r, min(c0.g, c0.b));
  let ch0 = bc;
  for (var k = 1; k < 4; k++) {
    let ck = pal(t + f32(k) * 0.25);
    let ch = max(ck.r, max(ck.g, ck.b)) - min(ck.r, min(ck.g, ck.b));
    if (ch > bc * 1.3) { best = ck; bc = ch; }
  }
  var c = mix(best, c0, smoothstep(0.08, 0.25, ch0));
  c = max(c - vec3f(0.95 * min(c.r, min(c.g, c.b))), vec3f(0.0));
  return c / max(luma(c), 0.02);
}

// Turns a colour round the grey axis (keeps the line sets apart even on a palette of near hues).
fn ls_rot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let cs = cos(a);
  return max(c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs), vec3f(0.0));
}
// Distance fog: far light dims and cools toward the haze colour.
fn ls_fog(c: vec3f, s: f32, hazeC: vec3f) -> vec3f {
  let f = sat((s - 6.0) / 40.0);
  return mix(c, hazeC * luma(c), f * 0.6) * (1.0 - 0.45 * f);
}

/**
 * Wave lines: a sheet of parallel neon lines running away along the tunnel's axis, passing above or
 * below the viewer, rolling in long waves (the sheet's height and the lines' course both flow). The
 * lines are filtered to the pixel footprint, so where they crowd together into the distance they merge
 * into an even glow instead of moire. Kicks and snares travel down them as fronts (each line its own
 * delay, so the front is ragged): behind a kick's the line has a new colour, behind a snare's it
 * flows along a new course. Both last until the next. Each line's hue drifts across the sheet.
 */
fn ls_lines(ro: vec3f, rd: vec3f, tAxis: vec3f, tu: vec3f, ts: vec3f, en: f32, hue: f32, kc: f32, snc: f32, kA: vec2f, sA: vec2f, lA: vec2f, kL: vec2f, sL: vec2f, lL: vec2f, noteCol: vec3f, noteOld: vec3f) -> vec3f {
  let sh = ls_up(S.p[6].y);
  let rl = 0.7 * (sh.x * 2.0 - 1.0);
  let n0 = normalize(tu * cos(rl) + ts * sin(rl));
  let side = normalize(cross(n0, tAxis));
  let fwd = -tAxis;
  let off = 3.2 * (sh.y * 2.0 - 1.0);
  let ph = S.p[6].w * 0.25;
  let dn = dot(rd, n0);
  let sdn = select(dn, 1e-4, abs(dn) < 1e-4);
  let amp = 0.5 + 0.5 * en;
  // The sheet's height flows in long waves; find where the ray meets it in three refinements.
  var t = off / sdn;
  for (var k = 0; k < 3; k++) {
    let P = rd * t;
    let lat = dot(P, side);
    let al = dot(P, fwd);
    let h = amp * (sin(al * 0.19 + lat * 0.31 + ph) + 0.5 * sin(al * 0.083 - lat * 0.23 + 1.3 * ph));
    t = (off + h * sign(off)) / sdn;
  }
  let P = rd * t;
  let lat = dot(P, side);
  let al = dot(P, fwd);
  let sp = 0.3;
  // Fronts down the lines. Each line has its own delay (from its place across the sheet).
  let li0 = floor(lat / sp + 0.5);
  let jit = hash11(li0 * 7.13 + 1.7) * 4.0;
  // The counts are eased (springs), so the lines' colour and course glide globally; the fronts are light.
  let kN = kc;
  let sN = snc;
  // The lines' course: a slow lateral flow, re-routed by each snare behind its front.
  // The fine course comes from the high end: a short wobble whose phase the detail layer sets.
  let fph = S.p[4].w;
  let x = lat / sp + 0.9 * sin(al * 0.16 + ph * 0.8 + sN * 2.1 + lat * 0.04) + 0.35 * sin(al * 0.41 - ph + sN * 1.3)
    + 0.26 * sin(al * 1.3 + lat * 0.5 + fph) + 0.11 * sin(al * 2.9 - lat * 0.3 - 1.6 * fph + 1.0);
  let fw = fwidth(x);
  let li = floor(x + 0.5);
  let d = abs(x - li);
  let lw = 0.05;
  let line = smoothstep(lw + 0.5 * fw + 0.02, lw, d) * min(1.0, (2.0 * lw + 0.04) / max(fw, 1e-4));
  let ray = mix(line, 2.0 * lw + 0.02, smoothstep(0.4, 1.0, fw));
  let inside = step(0.0, t) * smoothstep(14.0, 9.0, abs(lat)) * smoothstep(3.0, 7.0, t) * smoothstep(70.0, 30.0, al);
  // The melody's colour runs down the lines with each note (slower, its own delays) and tints them
  // until the next note.
  let tint = noteCol;
  let c = mix(ls_rot(ls_col(hue + 0.12 * sin(li * 0.37) + 0.13 * kN), -2.1), tint, 0.35);
  // Hot heads on the fronts, each in its own pure colour (the line's, the line's turned, the note's). Each
  // swells in over about a seventh of a second, and the one before flies on and fades out.
  var head = vec3f(0.0);
  for (var e = 0; e < 2; e++) {
    let ka = kA[e];
    let sa = sA[e];
    let la = lA[e];
    let xk = ka * 34.0 - al - jit;
    let xs = sa * 60.0 - al - jit * 0.6;
    let xl = la * 22.0 - al - jit * 1.3;
    // Each head as bright as its hit.
    head += c * exp(-xk * xk * 0.15) * exp(-ka * 2.0) * smoothstep(0.0, 0.14, ka) * 5.0 * kL[e]
      + ls_rot(c, 1.9) * exp(-xs * xs * 0.4) * exp(-sa * 2.5) * smoothstep(0.0, 0.14, sa) * 4.0 * sL[e]
      + noteCol * exp(-xl * xl * 0.25) * exp(-la * 2.0) * smoothstep(0.0, 0.14, la) * 10.0 * lL[e];
  }
  return (c + head) * ls_haze(ro + P) * ray * inside * (0.06 + 0.08 * en) / (1.0 + t * 0.05);
}

fn ls_glow(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> f32 {
  let oc = c - ro;
  let sp = dot(oc, rd);
  if (sp < 0.0) { return 0.0; }
  let dd = length(oc - rd * sp);
  return r * r / (dd * dd + r * r);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ca = S.p[6].x;
  // The phrase framing: eye height, lens, look pitch and yaw, roll.
  let fa = ls_up(S.p[3].w);
  let fb = ls_up(S.p[6].z);
  let lift = (fb.y * 2.0 - 1.0) * 1.3;
  let fov = 1.25 / pow(0.4 + 2.0 * fb.x, 0.9);
  let fRoll = 0.5 * (floor(S.p[2].w / 4.0) / 1000.0 * 2.0 - 1.0);
  let ro = vec3f(sin(ca) * 3.0, 0.8 * sin(ca * 0.6) + lift, 8.5 + 1.5 * sin(ca * 0.49) + cos(ca) * 1.5);
  let ta = vec3f(sin(ca * 0.7) * 0.8, S.p[2].y * 0.15 + 0.35 * lift, -3.0);
  let cam = lookAt(ro, ta, 0.08 * sin(ca * 0.5) + 0.55 * fRoll);
  let fp = 0.5 * (fa.x * 2.0 - 1.0);
  let fy = 0.6 * (fa.y * 2.0 - 1.0);
  var dl = vec3f(q, fov);
  dl = vec3f(dl.x, cos(fp) * dl.y + sin(fp) * dl.z, -sin(fp) * dl.y + cos(fp) * dl.z);
  dl = vec3f(cos(fy) * dl.x + sin(fy) * dl.z, dl.y, -sin(fy) * dl.x + cos(fy) * dl.z);
  let rd = normalize(cam * dl);
  let pxA = 2.0 / (F.res.y * fov);

  let hue = S.p[4].x;
  let en = fract(S.p[7].x) / 0.99;
  // Packet ages and strengths (latest and the one before, per kind).
  let pK1 = ls_pk(S.p[5].x);
  let pS1 = ls_pk(S.p[5].y);
  let pL1 = ls_pk(S.p[5].z);
  let pK2 = ls_pk(S.p[7].z);
  let pS2 = ls_pk(S.p[4].z);
  let pL2 = ls_pk(S.p[5].w);
  let kAge = pK1.x;
  let sAge = pS1.x;
  let lAge = pL1.x;
  let K = i32(ls_K() + 0.5);
  let M = i32(ls_M() + 0.5);
  let mn = normalize(S.p[1].yzw);
  let aim = vec3f(S.p[2].xy, -1.5);
  let spread = S.p[0].w;

  // The tunnel is centred on the viewer, so its beams always pass at a clear distance.
  let N = i32(ls_N() + 0.5);
  let tt = ls_up(S.p[3].z);
  let tAxis = normalize(vec3f(0.35 * (tt.x * 2.0 - 1.0), 0.25 * (tt.y * 2.0 - 1.0), 1.0));
  let apex = ro - tAxis * 36.0;
  let cone = S.p[3].x;
  let ts = normalize(cross(vec3f(0.0, 1.0, 0.0), tAxis));
  let tu = cross(tAxis, ts);

  // The melody's colour is always its own hue family, turned 110 to 170 degrees from the fans' (by
  // pitch), so a note reads on any palette.
  let pE = S.p[2].w - 4.0 * floor(S.p[2].w / 4.0);
  let noteCol = ls_rot(ls_col(hue + 0.15 * pE), 2.4 + 0.5 * pE);
  let noteOld = noteCol;
  let kAge2 = pK2.x;
  let sAge2 = pS2.x;
  let lAge2 = pL2.x;
  let kc = S.p[4].y;
  let snc = S.p[7].y;
  // Wave lines first, while control flow is uniform (their pattern is filtered with fwidth).
  var col = ls_lines(ro, rd, tAxis, tu, ts, en, hue, kc, snc, vec2f(kAge, kAge2), vec2f(sAge, sAge2), vec2f(lAge, lAge2), vec2f(pK1.y, pK2.y), vec2f(pS1.y, pS2.y), vec2f(pL1.y, pL2.y), noteCol, noteOld);
  var glowSum = vec3f(0.0);
  let hazeC = ls_rot(ls_col(hue + 0.5), 2.6);

  // Packets along the fan beams: the kick a broad fast burst, the melody note a tighter, slower
  // packet in its pitch colour. Both leave the sources and fade as they fly out.
  // Each swells in over about a seventh of a second; the packet before flies on and fades out.
  let kFade = exp(-kAge * 5.0) * smoothstep(0.0, 0.14, kAge) * pK1.y;
  let kPos = kAge * 42.0;
  let kFade2 = exp(-kAge2 * 5.0) * smoothstep(0.0, 0.14, kAge2) * pK2.y;
  let kPos2 = kAge2 * 42.0;
  let lFade = exp(-lAge * 5.0) * smoothstep(0.0, 0.14, lAge) * pL1.y;
  let lPos = 1.0 + lAge * 22.0;
  let lFade2 = exp(-lAge2 * 5.0) * smoothstep(0.0, 0.14, lAge2) * pL2.y;
  let lPos2 = 1.0 + lAge2 * 22.0;

  // Fans, mirrored through the morphing plane.
  for (var i = 0; i < 6; i++) {
    if (i >= K) { break; }
    let o0 = ls_src(i);
    // Each kick steps the fans' colours on; the new colour travels out along the beams with the
    // kick's burst, so behind the burst every beam has changed for good.
    let fc = ls_col(hue + f32(i) * 0.09 - 0.1 + kc * 0.15);

    let P = 0.3 + 0.35 * en;
    for (var mi = 0; mi < 2; mi++) {
      var o = o0;
      var tgt = aim;
      if (mi == 1) {
        o = o0 - 2.0 * dot(o0, mn) * mn;
        tgt = aim - 2.0 * dot(aim, mn) * mn;
      }
      // Fan axis: toward the viewer's region, steered at the melody point.
      let toward = normalize(vec3f(0.0, 0.0, 9.0) - o);
      let axis = normalize(mix(toward, normalize(tgt - o), 0.85));
      var rf = vec3f(0.0, 1.0, 0.0);
      if (abs(axis.y) > 0.95) { rf = vec3f(1.0, 0.0, 0.0); }
      let s0 = normalize(cross(rf, axis));
      let u0 = cross(axis, s0);
      let roll = S.p[1].x + f32(i) * 2.399 + f32(mi) * 1.3;
      let side = s0 * cos(roll) + u0 * sin(roll);
      let reach = length(tgt - o) * S.p[2].z;
      var acc = vec2f(0.0);
        var kk = 0.0;
      var ll = 0.0;
      for (var j = 0; j < 16; j++) {
        if (j >= M) { break; }
        let fj = (f32(j) + 0.5) / f32(M) * 2.0 - 1.0;
        // The beams within a fan splay finely with the high end (each high note re-spaces them).
        let ang = fj * spread + 0.18 * spread * sin(fj * 5.0 + f32(i) * 1.7 + S.p[4].w);
        let d = normalize(axis * cos(ang) + side * sin(ang));
        let r = ls_beam(ro, rd, o, d, reach, pxA, 0.01);
        acc += r.xy;
        // Packets ride the beam's core: a bright bead on a thin line, not a fat glow.
        let lum = r.x * 0.9 + r.y * 0.7;
        let dk = r.z - kPos;
        let dl = r.z - lPos;
        let dk2 = r.z - kPos2;
        let dl2 = r.z - lPos2;
        kk += lum * (exp(-dk * dk * 0.07) * kFade + exp(-dk2 * dk2 * 0.07) * kFade2);
        ll += lum * (exp(-dl * dl * 0.3) * lFade + exp(-dl2 * dl2 * 0.3) * lFade2);
      }
      let sh = ls_sheet(ro, rd, o, axis, side, spread);
      // The fan's body takes on the colour of the latest melody note, spreading out from the source
      // with the note's packet and staying until the next note.
      col += mix(fc, noteCol, 0.6) * min(sh.x, 6.0) * P * 0.02;
      let gl = ls_glow(ro, rd, o, 0.05) + ls_glow(ro, rd, o, 3.0) * 0.02 * ls_hazeK();
      let fan = (fc * acc.y + fc * acc.x * 0.6) * P
        + fc * gl * P * 0.6
        + (fc * kk * 12.0 + noteCol * ll * 70.0) * P;
      col += ls_fog(fan, length(o - ro), hazeC);
      glowSum += fc * P;
    }
  }

  // Tunnel: beams from a far point converging around the viewer. A snare sends a sharp front in a
  // second colour racing down them, from beside the viewer away into the distance.
  // Each snare steps the tunnel colour on; its front carries the new colour down the beams.
  let tc = ls_rot(ls_col(hue + 0.5 + snc * 0.11), 2.1);
  let sc = ls_rot(ls_col(hue + 0.75 + snc * 0.11), 2.1);
  let PT = 0.4 + 0.4 * en;
  let sPos = 29.0 - sAge * 50.0;
  let sPos2 = 29.0 - sAge2 * 50.0;
  // Swells in, and fades out softly as the front reaches the far point (never cut off).
  let sFade = exp(-sAge * 4.0) * smoothstep(0.0, 0.14, sAge) * smoothstep(-12.0, 4.0, sPos) * pS1.y;
  let sFade2 = exp(-sAge2 * 4.0) * smoothstep(0.0, 0.14, sAge2) * smoothstep(-12.0, 4.0, sPos2) * pS2.y;
  var tacc = vec2f(0.0);
  var ss = 0.0;
  for (var j = 0; j < 20; j++) {
    if (j >= N) { break; }
    let ph = f32(j) / f32(N) * TAU + S.p[3].y;
    let ring = ts * cos(ph) + tu * sin(ph);
    let d = normalize(tAxis + ring * tan(cone * (1.0 + 0.25 * sin(ph * 2.0 + S.p[3].y))));
    let r = ls_beam(ro, rd, apex, d, 60.0, pxA, 0.022);
    let x = r.z - sPos;
    let x2 = r.z - sPos2;
    tacc += r.xy;
    // Sharp leading edge (toward the far point), a short glowing wake behind it.
    ss += (r.x * 0.6 + r.y * 2.0) * (select(exp(-x * x * 1.0), exp(-x * 0.2), x > 0.0) * sFade
      + select(exp(-x2 * x2 * 1.0), exp(-x2 * 0.2), x2 > 0.0) * sFade2);
  }
  col += (tc * tacc.y + tc * tacc.x * 0.6) * PT;
  col += sc * ss * PT * 14.0;
  col += tc * ls_glow(ro, rd, apex, 0.08) * PT * 0.5;
  glowSum += tc * PT * 2.0;

  // The haze itself, faintly lit by everything in it: depth without a floor or walls.
  // Brightest toward the tunnel's far point, falling to deep shadow at the edges.
  let hz = ls_haze(ro + rd * 12.0);
  col += glowSum * hz * (0.0008 + 0.005 * ls_glow(ro, rd, apex, 9.0)) * (0.6 + 0.4 * en);
  // Highlights roll off instead of clipping: where many beams cross, the light stays coloured.
  col = col / (1.0 + 0.5 * max(col.r, max(col.g, col.b)));
  return vec4f(min(col, vec3f(24.0)), 1.0);
}
`,
});
