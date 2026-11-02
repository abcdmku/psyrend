import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';
import { Spring } from '../anim';

/**
 * The fine phase (RULES v7) integrated with the air of the mix: it moves as the detail layer and the
 * high notes say, faster with more air (about as given at typical air), and only faintly in a bare
 * passage, so a high note over near silence re-forms the fine detail gently instead of jolting it.
 * A jump (new cue or seek) restarts it where the raw phase is.
 */
class FinePhase {
  x = 0;
  private last = NaN;
  update(raw: number, air: number, jump = false): number {
    if (jump || !(Math.abs(raw - this.last) < 2)) this.x = raw;
    else this.x += (raw - this.last) * (0.1 + 1.8 * air);
    this.last = raw;
    return this.x;
  }
}
const finePhase = new FinePhase();


/**
 * Follows an event-driven target (a count, or a sum of steps): each change eases in by smoothstep over
 * `dur` seconds, from rest to rest, so it never snaps and leaves no tail however close the hits come.
 */
class Glide {
  x: number;
  private base: number;
  private target: number;
  /** In-flight changes: [age, size, duration]. */
  private q: [number, number, number][] = [];
  constructor(x = 0, private dur = 0.6) {
    this.x = this.base = this.target = x;
  }
  /** dur sets how long a change that starts now takes to ease in (default: the glide's own). */
  update(target: number, dt: number, dur = this.dur): number {
    if (target !== this.target) this.q.push([0, target - this.target, dur]);
    this.target = target;
    for (const e of this.q) e[0] += dt;
    for (const e of this.q) if (e[0] >= e[2]) this.base += e[1];
    this.q = this.q.filter((e) => e[0] < e[2]);
    this.x = this.base;
    for (const [age, v, d] of this.q) {
      const t = age / d;
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
  readonly level = new Spring(0, 0.06);
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
  update(events: number, level: number, dt: number, dur?: number): void {
    if (events > this.n) this.total += (events - this.n) * strength(level, this.p);
    this.n = events;
    this.sum.update(this.total, dt, dur);
    this.level.update(strength(level, this.p), dt);
  }
}
/** A 0..1 value as a 6-bit integer, for packing. */
const q6 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 63);


const morph = new Morph(1.3);

/**
 * The phrase framing (morph.cam) re-timed to the music: the camera moves toward the phrase's target
 * in eased steps on kicks, snares and melody notes (each by its strength), with a slow drift so it
 * still arrives in quiet passages. Each melody note tilts the look by its pitch and turns it a
 * notch; each snare rolls it a notch the other way. Lasting changes, each settling on a critically
 * damped spring (~0.4 s), so nothing snaps.
 */
class Framing {
  readonly cam = { fov: 1, pitch: 0, yaw: 0, roll: 0, height: 0 };
  private readonly goal = [0, 0, 0, 0, 0];
  private readonly val = [0, 0, 0, 0, 0];
  private readonly vel = [0, 0, 0, 0, 0];
  private gazeP = 0;
  private gazeY = 0;
  private sRoll = 0;
  private k = 0;
  private s = 0;
  private n = 0;
  private t = -1e9;

  /** `gaze`: the melody's look offset (radians at full strength); `tilt`: the snare's roll notch. */
  constructor(private readonly gaze = 0.06, private readonly tilt = 0.035) {}

  update(mo: Morph, dt: number, time: number): void {
    const c = mo.cam;
    const reset = Math.abs(time - this.t - dt) > 0.5 || mo.kicks < this.k || mo.notes < this.n || mo.snares < this.s;
    this.t = time;
    let take = 1 - Math.exp(-dt / 6);
    if (reset) {
      take = 1;
      this.gazeP = this.gazeY = this.sRoll = 0;
    } else {
      // Each step by the event's level squared (the level carries how loud the passage is), so a faint
      // intro note barely turns the view and a full-mix one turns it fully.
      if (mo.kicks > this.k) take = 1 - (1 - take) * (1 - 0.22 * mo.kickLevel ** 2);
      if (mo.snares > this.s) {
        take = 1 - (1 - take) * (1 - 0.1 * mo.snareLevel ** 2);
        this.sRoll += ((mo.snares % 2 ? 1 : -1) * this.tilt - this.sRoll) * mo.snareLevel ** 2;
      }
      if (mo.notes > this.n) {
        take = 1 - (1 - take) * (1 - 0.2 * mo.noteLevel ** 2);
        const lv = mo.noteLevel ** 2;
        this.gazeP += (mo.notePitch * this.gaze - this.gazeP) * lv;
        this.gazeY += ((mo.notes % 2 ? 1 : -1) * this.gaze * 0.8 - this.gazeY) * 0.7 * lv;
      }
    }
    this.k = mo.kicks;
    this.s = mo.snares;
    this.n = mo.notes;
    const tgt = [Math.log(c.fov), c.pitch, c.yaw, c.roll, c.height];
    const off = [0, this.gazeP, this.gazeY, this.sRoll, 0];
    const w = 7;
    const e = Math.exp(-w * dt);
    for (let j = 0; j < 5; j++) {
      this.goal[j] += (tgt[j] - this.goal[j]) * take;
      const gj = this.goal[j] + off[j];
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
const framing = new Framing();

/**
 * The music's presence right now (the morph's drive, loudness and bass, through a smooth S-curve: about
 * 0.9 in a full mix, about 0.1 in a near-silent gap). Beats land by it, so a hit in a bare passage
 * barely stirs the bore and a hard hit in a full mix lands fully, with no threshold in between.
 */
const presence = () => {
  const x4 = Math.max(0, morph.drive) ** 4;
  return (x4 * (1 + 0.55 ** 4)) / (x4 + 0.55 ** 4);
};

/**
 * Lasting state that the music writes into the pattern. Kicks and snares ride phase glides that
 * follow their counts (the shader sweeps each step across the tunnel as a front); the melody's
 * retuning of the waves glides the same way and its pitch on springs. Everything starts from rest: nothing snaps.
 */
const sp = (h = 0.2) => new Spring(0, h);
const st = {
  seed: -1,
  /** Song time last frame, to spot a seek. */
  time: -1e9,
  notes: 0,
  k0: 0,
  s0: 0,
  l0: 0,
  xk: new Glide(),
  xs: new Glide(0, 0.6),
  /** The snares' strengths, summed: the spiral's re-winding has come this far (whole re-winds and a part). */
  sTot: 0,
  roll: new Glide(0, 0.4),
  rollT: 0,
  sCount: 0,
  sTime: -9,
  xl: new Glide(),
  ph: Array.from({ length: 7 }, () => new Glide(0, 0.45)),
  phT: new Float64Array(7),
  mlv: new Glide(0, 0.45),
  mlvT: 0,
  pc: sp(),
  pcT: 0,
  th: sp(),
  /** Loudness on a spring (about 0.15 s), so the glow follows the level without flicker. */
  en: sp(0.15),
  /** Strengths of the kick, snare and note fronts. */
  sk: new Strength(0.6, 1),
  ss: new Strength(0.6, 1),
  sl: new Strength(0.6, 1),
};

const fract = (x: number) => x - Math.floor(x);
const TAU = Math.PI * 2;
/** The spiral's arm count after n snares: even, so the stripes (and their alternate colours) close round the bore. */
const armsOf = (n: number, c: number) => 2 * Math.round(4.5 * Math.sin(n * 0.9 + c));
/** The angle round the bore where snare n's dislocation starts. */
const originOf = (n: number, c: number) => fract((n * 2.4 + c) / TAU) * TAU;

/**
 * Quasicrystal op-art tunnel. Stripes spiral down the inside of a cylinder (Riley's warped
 * stripes, ref11) and a quasicrystal bends them: a sum of n plane waves (5-, 7-, 8- or 12-fold
 * star) wrapped on the bore, each wave's angular number rounded to an integer so the field closes
 * seamlessly round the bore and stays quasiperiodic along it. The stripes are the field's
 * iso-contours, drawn as glossy tubes in bands of colour on black.
 *
 * Morph: the n wave phases travel (phason flow: rosettes open, merge and re-form), with the
 * warp strength, stripe pitch, line weight and view axis. Camera travel is steady.
 * Kick: a burn front leaves the lens and runs down the bore, ragged by contour band; behind it the
 * stripes have stepped round the palette and slid to new contour levels for good. Snare: a fold where
 * the extra windings gather sweeps round the bore from a fresh angle and leaves the spiral with a new
 * arm count behind it (one spiral throughout, never two cross-faded); alternate stripes take a new
 * colour and the bore turns a little further for good. Melody: a front wipes round the bore from the pitch's angle;
 * behind it the note's wave has a new phase, the stripes have slid to a new level, and their hue
 * and weight follow the note's pitch class (read from the score, round the circle of fifths).
 * Chords lean the shape (Morph). Energy: pace and glow.
 *
 * Every change eases in from rest over 0.4-0.6 s with a soft hot edge and a faint ember: the
 * lasting change is the reaction, the light only marks the front.
 */
export default raymarchScene({
  meta: {
    id: 'quasi-tunnel',
    name: 'Quasi Tunnel',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.6 },
    genres: { edm: 0.8, techno: 0.8, synthwave: 0.8, pop: 0.6, ambient: 0.5, jazz: 0.4, classical: 0.4 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    framing.update(morph, Math.min(Math.max(ctx.dt, 0), 0.1), m.time);
    const at = morph.at;
    const camZ = morph.travel * 0.5;
    const n = [5, 7, 4, 6][Math.floor(g[1] * 4)];

    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    // A seek (a time jump, spotted as the morph does) drops every front, glide and baseline in flight:
    // the morph's counts keep running through it, so they never fall back to signal one.
    const seek = Math.abs(m.time - st.time - dt) > 0.5;
    st.time = m.time;
    // Pitch class round the circle of fifths (neighbouring keys get neighbouring colours).
    const fifths = (x: number) => fract((Math.round(x * 12 + 1200) % 12) * 7 / 12);
    if (g[0] !== st.seed || seek || morph.kicks < st.k0 || morph.snares < st.s0 || morph.notes < st.notes) {
      st.seed = g[0];
      st.k0 = morph.kicks;
      st.s0 = morph.snares;
      st.notes = st.l0 = morph.notes;
      for (const q of [st.xk, st.xs, st.xl, st.mlv, st.roll, ...st.ph]) q.reset(0);
      st.sTot = 0;
      st.rollT = 0;
      st.sCount = morph.snares;
      st.sTime = -9;
      st.phT.fill(0);
      st.mlvT = 0;
      st.pcT = fifths(morph.notePitch);
      st.pc.reset(st.pcT);
      st.th.reset(morph.notePitch * Math.PI);
      st.sk.reset(morph.kicks, morph.kickLevel);
      st.ss.reset(morph.snares, morph.snareLevel);
      st.sl.reset(morph.notes, morph.noteLevel * morph.presence);
    }
    const pr = Math.min(1, 10 * presence());
    const kLv = morph.kickLevel * pr;
    const sLv = morph.snareLevel * pr;
    st.sk.update(morph.kicks, kLv, dt);
    // A snare carries the re-winding sweep on by its strength (below); its strength also sets the pace:
    // a hard snare sweeps round in 0.4 s, a faint one eases its small step in over up to 2.8 s.
    const sweep = 0.4 + 2.4 * (1 - sLv) ** 5;
    st.ss.update(morph.snares, sLv, dt, sweep);
    // The melody's fire is a bright sweep from near the lens, so it also takes the passage's loudness
    // once more: in a quiet intro a note is a glimmer, in a full mix (presence ~1) it burns as before.
    st.sl.update(morph.notes, morph.noteLevel * morph.presence, dt);
    if (morph.notes > st.notes) {
      st.notes = morph.notes;
      // The note retunes one wave (by its pitch class) and slides the stripes to a new level, and the
      // hue and weight move toward its pitch class: all by the note's level squared (which carries how
      // loud the passage is), so a faint intro motif only nudges the pattern.
      const lv = morph.noteLevel ** 2;
      const pc = Math.round((((morph.notePitch * 12) % 12) + 12) % 12);
      st.phT[pc % n] += (morph.notes % 2 ? 1 : -1) * (2.6 + 1.1 * Math.abs(morph.notePitch)) * lv;
      st.mlvT += 0.65 * lv;
      const f = fifths(morph.notePitch);
      st.pcT += (f + Math.round(st.pcT - f) - st.pcT) * lv;
    }

    // Each snare carries the re-winding sweep on round the bore as far as it is strong: a full-mix
    // snare completes a whole new arm count, a faint intro one moves the dislocation a little way and
    // leaves it there (the spiral is whole either side of it) for the next snare to carry on.
    // Each snare also turns the bore a little further for good; in a roll the steps shrink, so a burst
    // of snares turns it about as far as one.
    if (morph.snares > st.sCount) {
      st.sTot += (morph.snares - st.sCount) * sLv ** 1.5;
      st.sCount = morph.snares;
      st.rollT += 0.2 * Math.min(1, Math.max(0.2, (m.time - st.sTime) / 0.4)) * strength(sLv);
      st.sTime = m.time;
    }
    const xs = st.xs.update(st.sTot, dt, sweep);
    p[0] = camZ;
    p[1] = at[7] * 0.6 + g[2] * 6;
    p[2] = st.mlv.update(st.mlvT, dt);
    p[3] = 0.35 * Math.sin(at[5] * 0.3 + g[4] * 6) + (g[4] < 0.5 ? 1 : -1) * st.roll.update(st.rollT, dt) + framing.cam.roll;
    // Wave count (integer part) and the fine phase from the high end (fraction, one turn): the detail
    // layer flows it and each high note, backing chord and hat steps it, by level, eased by the morph.
    const fph = finePhase.update(1.2 * morph.detailAt[0] + 2.6 * morph.upperPhase + 0.5 * morph.backingPhase + 0.25 * morph.hatPhase, morph.detailDrive, seek);
    p[4] = n + 0.999 * fract(fph / TAU);
    // Framing (morph.cam, RULES v8): the lens widens or narrows, the bore's axis tilts by the
    // phrase's yaw and pitch, the view rolls, and the eye leaves the axis (height) so the far end
    // and the wall's perspective shift: at most 0.3 of the radius, well clear of the wall. Each rides
    // in the high 12 bits of a slot whose low 12 bits hold a per-variant constant (or a slow wave).
    const cam = framing.cam;
    const q12 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 4095);
    const focal = 1.1 / Math.pow(cam.fov, 0.75);
    // S.p[1].y: K (10..18) and the axis pitch (+-0.5 rad).
    p[5] = q12(g[2]) + 4096 * q12(0.5 + 0.45 * cam.pitch);
    // The kick and snare fronts' strength sums, and the recent strengths and the air (6 bits each).
    p[6] = st.sk.sum.x;
    p[16] = st.ss.sum.x;
    p[22] = q6(st.sk.level.x) + 64 * q6(st.ss.level.x) + 4096 * q6(st.sl.level.x) + 262144 * q6(morph.detailDrive);
    p[7] = wave(at[7], 0.2, 0.7);
    for (let i = 0; i < 7; i++) p[8 + i] = st.ph[i].update(st.phT[i], dt) + at[i] * 1.6 + g[(i + 1) % 8] * 6.3;
    // S.p[3].w: band offset (0..3) and the focal length (0.5..2).
    p[15] = q12(g[6]) + 4096 * q12((focal - 0.5) / 1.5);
    p[17] = st.xk.update(morph.kicks - st.k0, dt);
    // S.p[4].z: base hue and the axis yaw (+-0.5 rad).
    p[18] = q12(g[5]) + 4096 * q12(0.5 + 0.45 * cam.yaw);
    // Snares: a dislocation sweeps round the bore from the snare's angle and leaves the spiral with a
    // new arm count behind it (one spiral throughout, never two cross-faded). Its progress is the
    // fractional part of the snare glide; the stripes' phase offset from finished sweeps carries on.
    const sn = Math.floor(xs);
    const cA = g[5] * TAU;
    const cO = g[7] * TAU;
    let off = 0;
    // Kept modulo 2, not 1: alternate stripes carry their colour (parity), so a wrap by one stripe
    // would swap every stripe's colour in a frame when the sweep completes.
    for (let j = 0; j < sn; j++) {
      off -= ((armsOf(j + 1, cA) - armsOf(j, cA)) * originOf(j, cO)) / TAU;
      off -= 2 * Math.floor(off / 2);
    }
    p[19] = armsOf(sn, cA);
    p[20] = armsOf(sn + 1, cA);
    p[21] = xs;
    p[24] = originOf(sn, cO);
    p[30] = off;
    p[31] = xs - sn;
    p[23] = wave(at[4] * 0.6, 3.5, 6.0);
    p[25] = st.xl.update(morph.notes - st.l0, dt);
    p[26] = st.th.update(morph.notePitch * Math.PI, dt);
    p[27] = st.pc.update(st.pcT, dt);
    // S.p[7].x: line weight (0.21..0.29) and the eye's offset from the axis (+-0.3).
    p[28] = q12((wave(at[3] * 0.7, 0.21, 0.29) - 0.21) / 0.08) + 4096 * q12(0.5 + 0.5 * Math.max(-1, Math.min(1, cam.height)));
    p[29] = (0.8 + 0.25 * ctx.intensity) * (0.85 + 0.25 * st.en.update(m.energy, dt));
  },
  wgsl: /* wgsl */ `
// A slot packing two 12-bit values: (low, high), each 0..1.
fn qt_u12(v: f32) -> vec2f { let hi = floor(v / 4096.0); return vec2f(v - 4096.0 * hi, hi) / 4095.0; }

fn qt_hash(x: f32) -> f32 { return fract(sin(x * 91.17 + 3.1) * 43758.5453); }
fn qt_wrap(a: f32) -> f32 { return abs(fmod(a + PI, TAU) - PI); }

// Quasicrystal field on the cylinder, in [-1, 1].
fn qt_field(th: f32, z: f32) -> f32 {
  let n = i32(S.p[1].x);
  let K = 10.0 + 8.0 * qt_u12(S.p[1].y).x;
  let b0 = fract(K * 0.377) * PI;
  var f = 0.0;
  for (var i = 0; i < 7; i++) {
    if (i >= n) { break; }
    let b = b0 + PI * f32(i) / f32(n);
    let m = round(K * cos(b));
    let kz = K * sin(b) * 0.35;
    let ph = S.p[2 + i / 4][i % 4];
    f += cos(m * th + kz * z + ph);
  }
  return f / f32(n);
}

// The director's palette, pulled 40% toward a spectral wheel at the same hue so the bands stay
// multi-hue even when the palette is pale.
fn qt_col(h: f32, lum: f32) -> vec3f {
  let wheel = cosPal(h, vec3f(0.5), vec3f(0.5), vec3f(1.0), vec3f(0.0, 0.33, 0.67));
  let c = mix(pal(h), wheel, 0.5);
  return c * (lum / max(luma(c), 0.02));
}

fn qt_fire(u: f32, hot: vec3f, cool: vec3f) -> vec3f {
  // u: how far the front has gone past. The head swells and fades as it passes, then a faint ember.
  let h = qt_bump(u, 0.45);
  return mix(cool, hot, h) * h * 0.6 + cool * qt_bump(u, 0.5) * 0.08;
}

// Phase fronts. x follows an event count, each event easing in by smoothstep over 0.6 s (about a beat) (from rest, one unit per
// event, however close the events come); tau in [0, 0.5] the point's arrival fraction. Returns
// (state, u): the lasting state steps by 1 per event, eased in as the front passes; u is how far the
// front has gone past (0..1, at least 0.5 at rest). Continuous in x, so nothing can snap.
fn qt_phase(x: f32, tau: f32) -> vec2f {
  let y = x - tau;
  let u = fract(y);
  return vec2f(floor(y) + smoothstep(0.0, 0.5, u), u);
}
// A soft bump on 0 < u < h: the glow at the front.
fn qt_bump(u: f32, h: f32) -> f32 { let s = sin(PI * min(u / h, 1.0)); return s * s; }
fn qt_tau(t: f32) -> f32 { return 0.5 * (1.0 - exp(-t / 0.6)); }
// Contour stripes as glossy tubes: v is the stripe coordinate, fw its width in pixels.
// Returns (colour, line coverage for the fronts).
fn qt_stripes(v: f32, fwIn: f32, w: f32, hue0: f32, par: f32) -> vec4f {
  let fw = max(fwIn, 1e-4);
  let fade = sat(fw * 2.5 - 0.3);
  let x = fract(v) - 0.5;
  let ax = abs(x);
  let cov = mix(sat((w - ax) / fw + 0.5), 2.0 * w, fade);
  let nx = clamp(x / w, -1.0, 1.0);
  let ny = sqrt(max(1.0 - nx * nx, 0.0));
  let shade = mix(0.25 + 0.75 * ny, 0.7, fade);
  let spe = mix(exp(-pow((nx + 0.45) / 0.13, 2.0)), 0.1, fade);
  // Snares recolour alternate stripes.
  let parity = fract(floor(v) * 0.5) * 2.0 * (1.0 - fade);
  let hue = hue0 + par * parity;
  // Same light whatever the line weight, so wide stripes never wash the frame out.
  let glow = S.p[7].y * 0.25 / max(w, 0.25);
  var col = qt_col(hue, 0.17) * shade * cov * glow;
  col += qt_col(hue + 0.12, 1.0) * spe * cov * 0.24 * glow;
  // Faint colour in the gaps so the black has depth.
  col += palL(hue + 0.5, 0.006) * (1.0 - cov);
  return vec4f(col, cov * (0.35 + 0.65 * ny));
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let camZ = S.p[0].x;
  let focal = 0.5 + 1.5 * qt_u12(S.p[3].w).y;
  let tilt = vec2f(qt_u12(S.p[4].z).y, qt_u12(S.p[1].y).y) - 0.5;
  var rd = normalize(vec3f(rot2(S.p[0].w) * q, focal));
  rd = rotY(0.2 * cos(S.p[0].y) + tilt.x) * rotX(0.15 * sin(S.p[0].y * 0.83) + tilt.y) * rd;
  // Ray against the unit cylinder round the z axis, from an eye off the axis (rolled with the view
  // so it reads as height on screen).
  let eo = rot2(S.p[0].w) * vec2f(0.0, 0.6 * qt_u12(S.p[7].x).y - 0.3);
  let a2 = max(dot(rd.xy, rd.xy), 1e-8);
  let b2 = dot(eo, rd.xy);
  let tc = (-b2 + sqrt(max(b2 * b2 + a2 * (1.0 - dot(eo, eo)), 0.0))) / a2;
  let hp = vec3f(eo + rd.xy * tc, rd.z * tc);
  let th = atan2(hp.y, hp.x);
  // The same angle cut on the opposite side, for a seamless screen-space derivative.
  let thB = atan2(-hp.y, -hp.x);
  let zr = hp.z;
  let z = camZ + zr;

  let amp = S.p[1].w * S.p[5].w;
  let pitchZ = S.p[5].w;
  let xk = S.p[4].y;
  let xs = S.p[5].y;
  let xl = S.p[6].y;

  // The field (its wave phases glide on springs as the melody retunes them).
  let f = qt_field(th, z);
  let band = floor(f * amp + z * pitchZ + qt_u12(S.p[3].w).x * 3.0);
  let rag = qt_hash(band * 1.37);
  let dense = 0.5 + 0.5 * f;

  // Fronts. Kick: out of the lens and down the bore, faster through bright bands. Snare: round the
  // bore from an angle that turns with each snare. Melody: from the pitch's angle, round and down.
  let pK = qt_phase(xk, qt_tau(zr / (3.0 + 2.0 * dense) + 0.1 * rag));
  let uM = fract(xl - qt_tau(qt_wrap(th - S.p[6].z) * 0.3 + 0.04 * zr + 0.08 * qt_hash(band * 0.73 + 9.0)));

  // Line weight follows the note's pitch class (round the circle of fifths), gliding to each note.
  let pc = S.p[6].w;
  let w = clamp(0.21 + 0.08 * qt_u12(S.p[7].x).x + 0.1 * sin(pc * TAU), 0.12, 0.32);
  // Kicks step the palette and slide the stripes to new contour levels; notes slide them too.
  // The fronts' recent strengths and the air of the mix.
  let lq = S.p[5].z;
  let lvK = fmod(lq, 64.0) / 63.0;
  let lvS = fmod(floor(lq / 64.0), 64.0) / 63.0;
  let lvN = fmod(floor(lq / 4096.0), 64.0) / 63.0;
  let air = floor(lq / 262144.0) / 63.0;
  // Each lasting state steps by its event's strength: sum + strength * (phase state - count).
  let kS = S.p[1].z + lvK * (pK.x - xk);
  // Fine scale from the high end: a fine ripple of the stripes themselves (whole windings round the
  // bore, so it closes), its phase set by the detail layer and its depth by the air of the mix.
  let fph = fract(S.p[1].x) / 0.999 * TAU;
  let rip = (0.08 + 0.1 * air) * (sin(13.0 * th + 2.1 * z + fph) + 0.6 * sin(21.0 * th - 3.3 * z - 1.6 * fph + 1.0));
  let vc = f * amp + z * pitchZ + qt_u12(S.p[3].w).x * 3.0 + 0.14 * kS + 0.05 * sin(kS * 1.7) + S.p[0].z + rip;
  let gth = min(fwidth(th), fwidth(thB));
  let fvc = fwidth(vc);
  let hue0 = qt_u12(S.p[4].z).x + 0.24 * kS + 0.03 * sin(kS * 1.7) + 0.45 * pc + 0.3 * f + 0.32 * sin(th + 0.2 * z) + 0.04 * zr;
  // Snares rewind the spiral to a new arm count: a dislocation (a band where the extra windings
  // gather) sweeps round the bore from the snare's angle; behind it the spiral has its new arm count
  // and alternate stripes a new colour. H is the extra winding: 0 ahead, the full turn behind, and
  // it falls back to 0 across the band; at the end the band shrinks to nothing at the origin.
  let a0 = S.p[4].w;
  let dA = S.p[5].x - a0;
  let sP = S.p[7].w;
  let ph = th - S.p[6].x;
  let phi = ph - TAU * floor(ph / TAU);
  let hA = sP * TAU;
  let hB = min(hA + 1.3, TAU);
  let zw = max(hB - hA, 1e-4);
  let inZ = phi > hA && phi < hB;
  let H = select(select(0.0, sP * (1.0 - (phi - hA) / zw), inZ), phi / TAU, phi <= hA);
  let dH = select(select(0.0, -sP / zw, inZ), 1.0 / TAU, phi <= hA);
  let v = vc + th * a0 / TAU + dA * H + S.p[7].z;
  let fw = fvc + gth * abs(a0 / TAU + dA * dH);
  // Behind the head the alternate stripes have turned to the next colour.
  let behind = smoothstep(0.0, 1.0, sat((hA - phi) / 1.3 + sP));
  let par = 0.45 * (floor(xs) + behind);
  let st = qt_stripes(v, fw, w, hue0, par);
  var col = st.rgb;
  // The snare's light rides just behind the head and fades in and out with the sweep.
  let uS = sat((hA - phi) / 1.6);
  let sGlow = select(0.0, qt_bump(uS, 0.45), phi <= hA) * sin(PI * sP);

  // The fronts burn along the stripes they cross.
  let onLine = st.a;
  col += qt_fire(pK.y, vec3f(1.0, 0.85, 0.6), vec3f(1.0, 0.32, 0.06)) * onLine * smoothstep(0.1, 0.9, zr) * min(xk, 1.0) * 1.4 * lvK;
  col += mix(palL(hue0 + 0.5, 0.7), vec3f(0.7, 0.9, 1.0), sGlow) * sGlow * 0.6 * onLine * min(xs, 1.0) * 2.6 * lvS;
  let lc = qt_col(0.5 + pc, 0.9);
  // The melody's edge glows most where it starts (the pitch's angle).
  let mOrigin = exp(-pow(qt_wrap(th - S.p[6].z) / 1.3, 2.0));
  col += qt_fire(uM, mix(lc, vec3f(1.0), 0.4), lc) * onLine * mOrigin * min(xl, 1.0) * 5.5 * lvN;

  // Depth: the bore darkens into the distance.
  let fogd = exp(-zr * 0.3) * (0.55 + 0.45 * smoothstep(0.2, 1.4, zr));
  col *= fogd;
  // Keep the bands vivid whatever the palette's saturation.
  col = max(mix(vec3f(luma(col)), col, 1.45), vec3f(0.0));
  // Hue-preserving roll-off: bright stripes stay coloured instead of bleaching in the tonemap.
  col = col / (1.0 + 1.2 * max(col.r, max(col.g, col.b)));
  return vec4f(col, 1.0);
}
`,
});
