import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';

/**
 * The fine phase (RULES v7) integrated with the air of the mix: it moves as the detail layer and the
 * high notes say, faster with more air (about as given at typical air), and only faintly in a bare
 * passage, so a high note over near silence re-forms the fine detail gently instead of jolting it.
 * A jump, or a new cue or seek (reset), restarts it where the raw phase is, so renders are reproducible.
 */
class FinePhase {
  x = 0;
  private last = NaN;
  update(raw: number, air: number, reset = false): number {
    if (reset || !(Math.abs(raw - this.last) < 2)) this.x = raw;
    else this.x += (raw - this.last) * (0.1 + 1.8 * air);
    this.last = raw;
    return this.x;
  }
}
const finePhases = [0, 1, 2, 3].map(() => new FinePhase());
/** The fine phases eased once more (value, velocity each), so a high note re-forms the detail over about half a second. */
const fineEase = [0, 1, 2, 3].map(() => [NaN, 0]);

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
      // Steps scale with the music's weight: a quiet intro barely moves the lens.
      const wt = 0.25 + 0.75 * mo.drive;
      if (mo.kicks > this.k) take = 1 - (1 - take) * (1 - 0.22 * wt * mo.kickLevel);
      if (mo.snares > this.s) take = 1 - (1 - take) * (1 - 0.1 * wt * mo.snareLevel);
      if (mo.notes > this.n) {
        take = 1 - (1 - take) * (1 - 0.2 * wt * mo.noteLevel);
        const lv = (0.45 + 0.55 * Math.sqrt(mo.noteLevel)) * wt;
        this.gazeP = (mo.notePitch - 0.5) * 2 * this.gaze * lv;
        this.gazeY += ((mo.notes % 2 ? 1 : -1) * this.gaze * 0.8 * lv - this.gazeY) * 0.7;
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

const morph = new Morph(1);
const framing = new Framing(0, 7, 40);
/** Structure levels (Kali steps); the WGSL unrolls them so the traps stay in registers. */
const LEVELS = [0, 1, 2];
let pitchNow = 0;
let lastTravel = -1;
let lastMorphTravel = -1;
let camZ = 0;
let vz = 0.1;
/** One step of a critically damped spring: returns [x, v] moved toward `target` (exact for any dt). */
const spring = (x: number, v: number, target: number, w: number, dt: number): [number, number] => {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
};

/**
 * Light fronts of one kind of event. A new front is lit only once the current one has burned out
 * (its light is gone by `gap` seconds, see kv_env), so a beat never cuts a front off mid-flight;
 * events in between still change the colour, which glides on the morph's eased counts.
 */
class Fronts {
  private n = -1;
  private t = -99;
  count = 0;
  age = 99;
  /** Strength (0..1) and, for the melody, pitch the front was lit with: it keeps them while it travels. */
  amp = 0;
  pitch = 0;
  constructor(private readonly gap: number) {}
  update(events: number, now: number, eventAge: number, reset: boolean, lit: () => void): void {
    // A new cue or seek starts afresh (count too, so the fronts' origins are reproducible).
    if (reset || this.n < 0 || events < this.n) {
      this.t = -99;
      this.count = 0;
    }
    else if (events > this.n && now - eventAge - this.t >= this.gap) {
      this.t = now - eventAge;
      this.count++;
      lit();
    }
    this.n = events;
    this.age = Math.min(now - this.t, 99);
  }
}

/** Reaction strength from the morph's event level: squared, so it rises from nothing as softly as the hit. */
const strength = (level: number) => level * level;

const kickF = new Fronts(0.5);
const snareF = new Fronts(0.32);
const noteF = new Fronts(0.5);
/** Glided state: per-step turns, the note colour (unwrapped hue), drive and surge. */
const gl = { t: -1, turn1: 0, v1: 0, turn2: 0, v2: 0, hue: 0, vh: 0, drive: 0, vd: 0, surge: 0, vs: 0 };
/** The note colour's and the per-step turns' targets: each note moves them toward its own by its strength. */
const nt = { n: 0, hue: 0, t1: 0, t2: 0 };
/**
 * The snares' own phase: each snare adds its strength (squared, so a faint snare over a quiet passage
 * barely moves it) and the phase follows on a critically damped spring (settled in about a beat).
 */
const sn = { n: 0, sum: 0, x: 0, v: 0 };

const smooth = (lo: number, hi: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Per-step turns the melody gives the equation: each pitch class its own pair of angles. */
const noteTurns = (pitch: number): [number, number] => {
  const pc = Math.round((pitch * 12 + 1200) % 12);
  return [0.7 * Math.sin(pc * 2.1 + 0.4), 0.55 * Math.sin(pc * 1.3 + 2.2)];
};

/**
 * A luminous nebula you fly through: no surfaces, only light, and nothing but the fractal. Space is
 * mirror-tiled, warped and twisted into a vortex round the flight path, and run through a few fold
 * steps. Each step blends three fractal families: the Kali abs-invert (z = abs(z) * k /
 * clamp(dot(z, z), r, 4) - c), a Mandelbox (box fold, sphere fold, scale) and an octahedral KIFS
 * (abs, sort, scale about a corner), then turns. Plane and axis orbit traps, divided by the running derivative, become distances in world units, so the light
 * gathers into veils (sheets) and filaments (threads) of a controlled width: thin and sharp near the
 * camera, soft and wide far away. Their hue sweeps across the palette with depth and with the level,
 * so near, mid and far each have their own colour.
 *
 * The traps are integrated exactly over each ray segment (a gaussian along a linearly moving distance),
 * so a thin veil crossed between two samples still gives all its light: no grain, no step dither.
 *
 * Music acts on the equation, always globally and smoothly, so the nebula morphs as one coherent
 * fractal. The morph moves c, k, r, the family blend, the box scale, the per-step turns, the field
 * scale and the vortex at a steady pace (notes bend its heading, chords lean it, long quiet slows it
 * but never stops it), and every phrase (and new section) carries it to a different region, with a
 * different family blend: a genuinely new nebula each phrase. The music's weight (morph.drive, and
 * the surge after a drop) speeds the flight and the morph, and strengthens the vortex twist and the
 * warp of space, so drops and heavy bass rush. Each beat also changes one term of the equation for
 * good, eased in over a third of a beat:
 * - kick: the constant c;
 * - snare: the fold strength k and the inversion radius r;
 * - melody note: the per-step turns, set by the note's pitch class.
 * Light and colour travel: each beat sends a front from a point through the volume, shaped by the
 * structure (it runs along the veils, slowly across empty space), and the structure behind it keeps
 * a new colour (the veils step round the palette behind a kick's, the threads behind a snare's or a
 * note's), with a band of light on the structure as the front passes.
 *
 * DNA: 0-1 starting point, 1 roll phase, 2 path curvature, 3 palette offset, 4 twist direction,
 * 5 structure width.
 */
export default raymarchScene({
  meta: {
    id: 'kali-volume',
    name: 'Kali Volume',
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.55 },
    genres: { techno: 1, edm: 1, ambient: 1, dnb: 0.8, dubstep: 0.7, synthwave: 0.8, classical: 0.7, pop: 0.6, rock: 0.5, hiphop: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    const now = m.time;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const reset = gl.t < 0 || Math.abs(now - gl.t - dt) > 0.5;
    if (reset) {
      vz = 0.1;
      lastTravel = -1;
    }
    gl.t = now;
    framing.update(morph, dt, reset);
    const fr = framing.cam;
    // Each front's light keeps the strength (and the note's place) it was lit with while it travels.
    // The fronts age on the world's paced clock (like the morph's event ages), so they travel faster
    // in a driving song; song time above only detects seeks.
    kickF.update(morph.kicks, ctx.clock, morph.kickAge, reset, () => {
      kickF.amp = strength(morph.kickLevel);
    });
    snareF.update(morph.snares, ctx.clock, morph.snareAge, reset, () => {
      snareF.amp = strength(morph.snareLevel);
    });
    noteF.update(morph.notes, ctx.clock, morph.leadAge, reset, () => {
      noteF.amp = strength(morph.noteLevel);
      noteF.pitch = morph.notePitch;
    });
    pitchNow = morph.notePitch;
    // Everything the music sets glides in on critically damped springs, from rest: the note's
    // colour (round the hue circle the short way), the per-step turns, and the drive and surge
    // that wind the vortex and warp space (the morph's drive rises within ~80 ms; a drop's surge
    // jumps to 1).
    const hueT = pitchNow * 7;
    const tn0 = noteTurns(pitchNow);
    if (reset) {
      nt.n = morph.notes;
      nt.hue = hueT;
      [nt.t1, nt.t2] = tn0;
    } else if (morph.notes > nt.n) {
      // A note moves the colour (round the circle the short way) and the turns by its strength.
      nt.n = morph.notes;
      const lv = strength(morph.noteLevel);
      nt.hue += ((((hueT - nt.hue + 0.5) % 1) + 1) % 1 - 0.5) * lv;
      nt.t1 += (tn0[0] - nt.t1) * lv;
      nt.t2 += (tn0[1] - nt.t2) * lv;
    }
    const hueTarget = nt.hue;
    if (reset) {
      gl.hue = hueTarget;
      [gl.turn1, gl.turn2] = [nt.t1, nt.t2];
      gl.drive = morph.drive;
      gl.surge = morph.surge;
      gl.v1 = gl.v2 = gl.vh = gl.vd = gl.vs = 0;
    }
    [gl.hue, gl.vh] = spring(gl.hue, gl.vh, hueTarget, 8, dt);
    [gl.turn1, gl.v1] = spring(gl.turn1, gl.v1, nt.t1, 8, dt);
    [gl.turn2, gl.v2] = spring(gl.turn2, gl.v2, nt.t2, 8, dt);
    [gl.drive, gl.vd] = spring(gl.drive, gl.vd, morph.drive, 9, dt);
    [gl.surge, gl.vs] = spring(gl.surge, gl.vs, morph.surge, 6, dt);
    const drive = Math.max(0, gl.drive);
    const surge = Math.max(0, gl.surge);

    // Kali constant (S.p[0].xyz) and fold strength (w), wide ranges, each beat's term eased in on top:
    // kicks move c, snares move k and r (the eased counts follow a smooth curve, never a jump).
    const kp = morph.kickPhase;
    if (reset) {
      sn.n = morph.snares;
      sn.sum = sn.x = sn.v = 0;
    } else if (morph.snares > sn.n) {
      sn.sum += (morph.snares - sn.n) * strength(morph.snareLevel);
    }
    sn.n = morph.snares;
    [sn.x, sn.v] = spring(sn.x, sn.v, sn.sum, 5.8 / Math.max(0.3, (60 / Math.max(40, m.bpm)) * 1.3), dt);
    const sp = sn.x;
    // Fine scale from the high end (RULES v7): small offsets of c and k, phased by the detail layer
    // (each high note, backing chord and hat steps it by level, eased by the morph). The folds amplify
    // a small change level by level, so it re-forms the finest veils and threads, not the large form.
    const d = morph.detailAt;
    const fineRaw = (i: number) => finePhases[i].update(0.6 * d[i] + (2.2 + 0.4 * i) * morph.upperPhase + 0.45 * morph.backingPhase + 0.2 * morph.hatPhase, morph.detailDrive, reset);
    const fineNow = [0, 1, 2, 3].map((i) => {
      const target = fineRaw(i);
      const e = fineEase[i];
      if (reset || !Number.isFinite(e[0])) [e[0], e[1]] = [target, 0];
      else {
        // The phase is only seen through sin(), so a lag of more than half a turn is taken up by
        // whole turns (invisible) rather than a jump, and the spring eases the rest.
        e[0] += 2 * Math.PI * Math.round((target - e[0]) / (2 * Math.PI));
        [e[0], e[1]] = spring(e[0], e[1], target, 10, dt);
      }
      return e[0];
    });
    const fine = (i: number) => fineNow[i];
    const fa = 0.09 + 0.1 * morph.detailDrive;
    p[0] = wave(a[0], 0.38, 0.92) + 0.09 * Math.sin(kp * 2.39 + 0.3) + fa * Math.sin(fine(0));
    p[1] = wave(a[1], 0.38, 0.92) + 0.09 * Math.sin(kp * 1.71 + 2.1) + fa * Math.sin(fine(1) + 1.3);
    p[2] = wave(a[2], 0.34, 0.86) + 0.09 * Math.sin(kp * 3.07 + 4.0) + fa * Math.sin(fine(2) + 2.6);
    p[3] = wave(a[3], 0.88, 1.08) + 0.15 * Math.sin(sp * 2.13 + 1.1) + 0.6 * fa * Math.sin(fine(3) + 0.7);
    // Field scale, tile size, min radius, camera z (steady travel).
    p[4] = wave(a[4], 0.55, 0.9);
    p[5] = wave(a[5] * 0.6 + a[0] * 0.3, 0.7, 1.0);
    p[6] = Math.min(0.62, Math.max(0.16, wave(a[6] * 0.5 + a[4] * 0.5, 0.2, 0.55) + 0.13 * Math.sin(sp * 1.37 + 0.5)));
    // The flight: steady with the flow, quicker with the music's weight (drive), and rushing after a
    // drop (surge), both glided. Monotonic; a seek or new cue starts from morph.travel.
    if (lastMorphTravel < 0 || Math.abs(morph.travel - lastMorphTravel) > 0.5) camZ = morph.travel * 0.5;
    else camZ += dt * 0.5 * (0.1 * morph.flow + 0.45 * drive ** 1.4) * (1 + 3.2 * surge);
    lastMorphTravel = morph.travel;
    p[7] = camZ;
    // Light-front counts (each places its front's origin), veil/thread balance phase (the snares
    // turn it), palette shift (the kicks step it round; it moves with the phrase too). The colour
    // steps ride on the morph's eased counts, so they glide in rather than switch.
    // Counts (integer part) and the strengths the fronts were lit with (fraction).
    p[8] = kickF.count + 0.999 * kickF.amp;
    p[9] = snareF.count + 0.999 * snareF.amp;
    p[10] = a[2] * 0.5 + a[5] * 0.5 + 1.3 * sp;
    p[11] = g[3] + 0.08 * Math.sin(a[1] * 0.5) + 0.14 * Math.sin(morph.flowAt[6] * 0.5) + 0.11 * morph.kickPhase;
    // Front ages.
    p[12] = kickF.age;
    p[13] = snareF.age;
    p[14] = noteF.age;
    p[17] = noteF.amp;
    p[18] = noteF.pitch;
    // Thread hue: the snares step it, the note's colour glides in, each note nudges it on.
    p[23] = 0.28 * sp + gl.hue + 0.07 * morph.notePhase;
    p[28] = noteF.count;
    // Roll (drifts with the shape), path curvature, width scale.
    // The phrase framing (morph.cam) adds its roll to this drift.
    p[20] = 0.3 * Math.sin(a[3] * 0.4 + g[1] * 6) + 0.4 * fr.roll;
    // Path curvature (thousandths, integer part) and width scale (half, fraction): both fixed per cue.
    p[21] = Math.round((0.4 + 0.8 * g[2]) * 1000) + 0.5 * (0.8 + 0.5 * g[5]);
    // Lens (fov multiplier, compressed a little: thousandths, integer part) and the eye's offset off
    // the flight path (fraction). The look turns by the framing's pitch and yaw (S.p[6].zw).
    p[22] = Math.round(fr.fov ** 0.8 * 1000) + 0.5 + 0.45 * Math.max(-1, Math.min(1, fr.height));
    // Per-step turns (xy, xz plane) as cos / sin, so the shader does no trigonometry per step. Each
    // note sets new turns from its pitch class, glided in on a spring over about half a second.
    const r1 = wave(a[6], -0.45, 0.45) + gl.turn1 + 0.38 * Math.sin(sp * 1.7 + 0.4);
    const r2 = wave(a[7], -0.35, 0.35) + gl.turn2 + 0.3 * Math.sin(sp * 2.2 + 1.9);
    p[24] = r1;
    p[25] = r2;
    p[26] = 0.5 * fr.pitch;
    p[27] = 0.5 * fr.yaw;
    // Family blend: Mandelbox (S.p[3].w) and octahedral KIFS (S.p[4].x) weights, pushed toward their
    // ends so each phrase settles on a clear family or hybrid, and the box scale (S.p[4].w).
    p[15] = 0.75 * smooth(0.2, 0.8, 0.5 + 0.5 * Math.sin(a[5] * 0.8 + a[2] * 0.5));
    p[16] = 0.5 * smooth(0.25, 0.85, 0.5 + 0.5 * Math.sin(a[7] * 0.8 + a[3] * 0.6));
    p[19] = wave(a[1] * 0.7 + a[4] * 0.4, 1.55, 2.1);
    // Warp of space: grows with the music's weight and after a drop.
    p[31] = 0.03 + 0.07 * drive + 0.3 * surge;
    // Camera speed in world units per second (from travel), so the shader knows where fronts started.
    const tr = camZ;
    if (lastTravel >= 0 && dt > 0 && Math.abs(tr - lastTravel) < 1) vz += ((tr - lastTravel) / dt - vz) * (1 - Math.exp(-dt / 0.3));
    lastTravel = tr;
    p[29] = Math.max(0.02, vz);
    // Vortex twist (radians per unit of depth), wound tighter by the music's weight and a drop.
    p[30] = (g[4] > 0.5 ? 1 : -1) * wave(a[1] * 0.7 + a[6] * 0.3, 0.15, 0.5) * (0.6 + 0.6 * drive + 2.2 * surge);
  },
  wgsl: /* wgsl */ `
const KV_FOV: f32 = 1.4;
// Set once per pixel in scene(): the per-step turns as cos / sin (so the steps do no trigonometry)
// and the focal length of this framing.
var<private> kv_turn: vec4f;
var<private> kv_fl: f32 = KV_FOV;
fn kv_path(z: f32) -> vec2f { return vec2f(sin(z * 0.27) * 0.5 + sin(z * 0.11) * 0.3, cos(z * 0.19) * 0.35) * (floor(S.p[5].y) / 1000.0); }

// Mirror-tiled space (offset so the flight path never runs along a mirror plane), twisted round the
// flight path into a vortex and gently warped. Returns (z, dr).
fn kv_tile(p0: vec3f) -> vec4f {
  let c = kv_path(p0.z);
  let a = S.p[7].z * p0.z;
  var p = vec3f(c + rot2(a) * (p0.xy - c), p0.z);
  // A slow warp of space, stronger with the music's weight.
  p += S.p[7].w * sin(p.zxy * vec3f(1.7, 1.3, 1.9) + vec3f(S.p[1].w * 0.9, 1.3, 2.1));
  let sc = S.p[1].x;
  let tile = S.p[1].y;
  return vec4f(abs(vec3f(tile) - fmod3(p * sc + vec3f(0.43, 0.29, 0.0) * tile, vec3f(tile * 2.0))), sc);
}

// One fold step: three fractal families blended (their points and running derivatives), then the
// per-step turns. Each step is one level of structure.
// Kali: z = abs(z) * k / clamp(dot(z, z), r, 4) - c.
// Mandelbox: box fold, sphere fold (r to 1), scale, minus c.
// Octahedral KIFS: abs, sort the axes, scale 2 about the corner c + 0.4.
fn kv_step(zd: vec4f) -> vec4f {
  let r = S.p[1].z;
  let r2 = dot(zd.xyz, zd.xyz);
  let kk = S.p[0].w / clamp(r2, r, 4.0);
  let zK = abs(zd.xyz) * kk - S.p[0].xyz;
  let bf = clamp(zd.xyz, vec3f(-1.0), vec3f(1.0)) * 2.0 - zd.xyz;
  let kb = S.p[4].w / clamp(dot(bf, bf), r, 1.0);
  let zB = bf * kb - S.p[0].xyz;
  var o = abs(zd.xyz);
  o = vec3f(max(o.x, o.y), min(o.x, o.y), o.z);
  o = vec3f(max(o.x, o.z), o.y, min(o.x, o.z));
  o = vec3f(o.x, max(o.y, o.z), min(o.y, o.z));
  let zO = o * 2.0 - (S.p[0].xyz + vec3f(0.4));
  let wB = S.p[3].w;
  let wO = S.p[4].x;
  var z = mix(mix(zK, zB, wB), zO, wO);
  let dr = zd.w * mix(mix(kk, kb, wB), 2.0, wO);
  let xy = mat2x2f(kv_turn.x, kv_turn.y, -kv_turn.y, kv_turn.x) * z.xy;
  z = vec3f(xy, z.z);
  let xz = mat2x2f(kv_turn.z, kv_turn.w, -kv_turn.w, kv_turn.z) * z.xz;
  return vec4f(xz.x, z.y, xz.y, dr);
}

// A level's traps: the fold-space point over the running derivative, i.e. world-space signed distances
// to the level's veil plane (x) and thread axis (y, z), and 1 / derivative (w) for its scale.
fn kv_trap(zd: vec4f) -> vec4f { return vec4f(zd.yxz, 1.0) / zd.w; }

fn kv_chroma(c: vec3f) -> f32 {
  let hi = max(c.r, max(c.g, c.b));
  return (hi - min(c.r, min(c.g, c.b))) / max(hi, 1e-4);
}
fn kv_rot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}
// Palette colour at a luminance. The hue cycles through the palette's coloured entries (pal0, pal1,
// pal2; pal3 is its near-white highlight), any grey one replaced by the most colourful entry turned
// round the hue circle, and pushed richer, so every scheme gives at least two distinct hues of light.
fn kv_col(h: f32, lum: f32) -> vec3f {
  let c0 = F.pal0.rgb;
  let c1 = F.pal1.rgb;
  let c2 = F.pal2.rgb;
  let s0 = kv_chroma(c0);
  let s1 = kv_chroma(c1);
  let s2 = kv_chroma(c2);
  var best = c1;
  var sb = s1;
  if (s2 > sb) { best = c2; sb = s2; }
  if (s0 > sb) { best = c0; }
  let k0 = mix(kv_rot(best, 2.3), c0, smoothstep(0.1, 0.3, s0));
  let k1 = mix(kv_rot(best, -1.9), c1, smoothstep(0.1, 0.3, s1));
  let k2 = mix(kv_rot(best, 1.2), c2, smoothstep(0.1, 0.3, s2));
  let x = fract(h) * 3.0;
  let f = smoothstep(0.0, 1.0, fract(x));
  var c = select(select(mix(k2, k0, f), mix(k1, k2, f), x < 2.0), mix(k0, k1, f), x < 1.0);
  c = max(mix(vec3f(luma(c)), c, 1.6), vec3f(0.0));
  return c * (lum / max(luma(c), 0.02));
}

fn kv_erf(x: f32) -> f32 { return sign(x) * sqrt(1.0 - exp(-1.2732 * x * x)); }

fn kv_dt(t: f32) -> f32 { return max(0.02, t * 0.06); }

// A front's light over its age: swells in from nothing over 0.2 s and is gone by 0.5 s.
fn kv_env(a: f32) -> f32 { return smoothstep(0.0, 0.2, a) * (1.0 - smoothstep(0.25, 0.5, a)); }

// Structure width at distance t: grows with distance (near structure fine and bright, far soft) and
// never drops below the pixel or what the march step resolves. It is a smooth function of t, and so
// are the level of detail and gain below: anything that jumped from one step to the next would print
// the steps onto the veils as fine stripes.
fn kv_width(t: f32) -> f32 {
  let pix = 1.4 / (F.res.y * kv_fl);
  return max(fract(S.p[5].y) * 2.0 * t * (0.002 + 0.0025 * t), max(pix * t * 1.5, kv_dt(t) * 0.12));
}

// Level of detail for structure of scale sc (1 / derivative) at distance t, for threads (x) and veils
// (y). A level whose structures sit closer together than a few widths would only fill the volume with
// fog, so it fades out (fine levels survive only near the camera). It must also be coarser than the
// step, or its curved shells slip between samples; veils, which a ray can graze for a long way, need
// more margin.
fn kv_lod(sc: f32, w: f32, dt: f32) -> vec2f {
  return sat(sc / w * 0.05 - 0.4) * vec2f(sat(sc / dt * 0.5 - 0.5), sat(sc / dt * 0.22 - 0.5));
}

// Light per unit of integrated structure at distance t: the same total light per structure whatever
// its width, brightest through the mid range and fading into the distance. Structure within a
// clearance of the lens fades away, so no veil ever sits on the camera or sweeps through it as a
// blurry wall.
fn kv_gain(t: f32, w: f32) -> f32 { return 0.0075 / w * smoothstep(0.18, 0.75, t) * exp(-t * 0.32) * (2.8 / (0.6 + t)); }

// Width (x), gain (y) and step length (z) at both ends of a march step, interpolated in between.
struct KvSpan { s0: vec3f, s1: vec3f }

// Exact integral of a gaussian line along a ray segment of length L (the fraction f0..f1 of a march
// step) whose distance vector moves linearly from a to b (structure scale sa to sb), plus a sharper core
// (0.4 width). A structure crossed between two samples still gives all its light, so thin structure
// needs no tiny steps and never turns to grain. Width, detail and gain are taken where the light
// actually is (the closest approach).
fn kv_seg(a: vec2f, b: vec2f, sa: f32, sb: f32, L: f32, f0: f32, f1: f32, sp: KvSpan, veil: bool) -> vec2f {
  let d = b - a;
  let dd = max(dot(d, d), 1e-12);
  let u = -dot(a, d) / dd;
  let uc = sat(u);
  let s = mix(sp.s0, sp.s1, mix(f0, f1, uc));
  let w = s.x;
  let iw2 = 1.0 / (w * w);
  let m = a + d * uc;
  let near2 = dot(m, m) * iw2;
  if (near2 > 9.0) { return vec2f(0.0); }
  let lods = kv_lod(mix(sa, sb, uc), w, s.z);
  let lod = select(lods.x, lods.y, veil);
  if (lod <= 0.0) { return vec2f(0.0); }
  let g = L * lod * s.y;
  let k = sqrt(dd) / w;
  if (k < 0.1) { return g * vec2f(exp(-near2), exp(-6.25 * near2)); }
  let perp2 = max(dot(a, a) * iw2 - u * u * k * k, 0.0);
  let body = exp(-perp2) * 0.886227 / k * (kv_erf(k * (1.0 - u)) + kv_erf(k * u));
  let kc = k * 2.5;
  let core = exp(-6.25 * perp2) * 0.886227 / kc * (kv_erf(kc * (1.0 - u)) + kv_erf(kc * u));
  return g * vec2f(body, core);
}

struct KvAcc { e: vec3f, dens: f32, thr: f32 }

// A veil's distance curves along the ray where the ray grazes it, and a straight line between two
// samples would cut through the bend. Fit a parabola through the previous sample too (s0 at -dp, s1 at
// 0, s2 at dt) and split the segment at its turning point.
fn kv_veil(s0: f32, s1: f32, s2: f32, sa: f32, sb: f32, dp: f32, dt: f32, sp: KvSpan) -> vec2f {
  let cq = (s0 - s1 + dp * (s2 - s1) / dt) / (dp * (dt + dp));
  let bq = (s2 - s1) / dt - cq * dt;
  let xv = -bq / (2.0 * cq);
  if (abs(cq) < 1e-6 || xv <= 0.0 || xv >= dt) { return kv_seg(vec2f(s1, 0.0), vec2f(s2, 0.0), sa, sb, dt, 0.0, 1.0, sp, true); }
  let sv = s1 + bq * xv * 0.5;
  let fv = xv / dt;
  let sm = mix(sa, sb, fv);
  return kv_seg(vec2f(s1, 0.0), vec2f(sv, 0.0), sa, sm, xv, 0.0, fv, sp, true) + kv_seg(vec2f(sv, 0.0), vec2f(s2, 0.0), sm, sb, dt - xv, fv, 1.0, sp, true);
}

// Light from one level over the ray segment [t, t + dt] (a: traps at its start, b: at its end, a0: the
// veil distance one segment earlier, dp: that segment's length).
// look: veil hue, thread hue offset, veil/thread balance (set per sample by the fronts). hr turns
// the hue round the colour circle with depth, and the threads sit well round from the veils, so even
// a palette of neighbouring hues gives near, mid and far, and veils and threads, their own colours.
fn kv_level(acc: ptr<function, KvAcc>, a0: f32, a: vec4f, b: vec4f, dp: f32, fl: f32, dt: f32, sp: KvSpan, look: vec3f, hr: f32) {
  // Nothing to do if even the finest width and step in the segment can't resolve this level.
  if (kv_lod(max(a.w, b.w), sp.s0.x, sp.s0.z).x <= 0.0) { return; }
  let mixVT = look.z;
  let amp = exp2(-fl * 0.8);
  // Veils glow brightest where seen edge-on, like silk; seen face-on they are a faint film.
  let face = sat(abs(b.x - a.x) / dt);
  let veil = kv_veil(a0, a.x, b.x, a.w, b.w, dp, dt, sp) * ((1.0 - 0.6 * mixVT) * amp * (1.0 - 0.9 * face * face));
  var thr = vec2f(0.0);
  if (fl > 0.5) { thr = kv_seg(a.yz, b.yz, a.w, b.w, dt, 0.0, 1.0, sp, false) * ((0.4 + 1.2 * mixVT) * amp); }
  if (veil.x + thr.x <= 0.0) { return; }
  let h = look.x + fl * 0.34 + 0.07 * (length(a.xyz) / a.w + length(b.xyz) / b.w);
  // Coloured body with a hot core, so the light looks dense rather than painted.
  (*acc).e += kv_rot(kv_col(h, 1.0), hr) * (veil.x + 2.5 * veil.y) + kv_rot(kv_col(h + look.y, 1.3), hr + 2.3) * (thr.x + 2.5 * thr.y);
  (*acc).dens += veil.x + thr.x;
  (*acc).thr += thr.x + thr.y;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let z = S.p[1].w;
  kv_turn = vec4f(cos(S.p[6].x), sin(S.p[6].x), cos(S.p[6].y), sin(S.p[6].y));
  // The phrase framing: the lens, the eye lifted off the flight path, the look turned.
  kv_fl = KV_FOV / (floor(S.p[5].z) / 1000.0);
  let lift = (fract(S.p[5].z) - 0.5) / 0.45 * 0.02;
  let ro = vec3f(kv_path(z) + vec2f(0.0, lift), z);
  let ta = vec3f(kv_path(z + 0.7) + vec2f(0.0, lift), z + 0.7);
  let cam = lookAt(ro, ta, S.p[5].x);
  let cp = cos(S.p[6].z);
  let spi = sin(S.p[6].z);
  let cy = cos(S.p[6].w);
  let sy = sin(S.p[6].w);
  var dl = vec3f(q, kv_fl);
  dl = vec3f(dl.x, cp * dl.y + spi * dl.z, -spi * dl.y + cp * dl.z);
  dl = vec3f(cy * dl.x + sy * dl.z, dl.y, -sy * dl.x + cy * dl.z);
  let rd = normalize(cam * dl);
  let shift = S.p[2].w;
  let kAge = S.p[3].x;
  let sAge = S.p[3].y;
  let lAge = S.p[3].z;
  let noteAmp = S.p[4].y;
  let pitch = clamp(S.p[4].z, -1.0, 1.0);
  let kicks = floor(S.p[2].x);
  let snares = floor(S.p[2].y);
  let kAmp = fract(S.p[2].x) / 0.999;
  let sAmp = fract(S.p[2].y) / 0.999;
  let vz = S.p[7].y;
  // Where each front started: a point fixed in space, a little ahead of where the camera was at the
  // beat, moved round the path by the count (kick near, snare deep ahead, note high or low by pitch).
  let zk = z - vz * kAge + 1.0;
  let ka = kicks * 2.4;
  let oK = vec3f(kv_path(zk) + vec2f(cos(ka), sin(ka)) * 0.3, zk);
  let zs = z - vz * sAge + 2.2;
  let sa = snares * 1.9 + 1.0;
  let oS = vec3f(kv_path(zs) + vec2f(cos(sa), sin(sa)) * 0.35, zs);
  let zl = z - vz * lAge + 0.7;
  let oL = vec3f(kv_path(zl) + vec2f(0.15 * sin(S.p[7].x * 1.3), 0.4 * pitch), zl);
  // How far each front has run (world units): the kick's broad and steady, the snare's fast, the
  // note's slower.
  let kRun = kAge * 2.2;
  let sRun = sAge * 5.0;
  let lRun = lAge * 2.6;
  // Light on the structure as each front passes: it swells in and is gone by half a second, before
  // the next front of its kind can be lit.
  let kHot = 1.5 * kAmp * kv_env(kAge);
  let sHot = 3.0 * sAmp * kv_env(sAge * 1.6);
  let lHot = 4.0 * noteAmp * kv_env(lAge);

  // No per-pixel jitter: the segment integrals carry the light of a crossing exactly, so what error is
  // left is smooth across the picture, and a jitter would only print its dither pattern onto the veils.
  var t = 0.02;
  var zd = kv_tile(ro + rd * t);
${LEVELS.map((l) => `  zd = kv_step(zd);\n  var p${l} = kv_trap(zd);\n  var q${l} = p${l}.x;`).join('\n')}
  var dp = kv_dt(t);
  let w0 = kv_width(t);
  var s0 = vec3f(w0, kv_gain(t, w0), dp);
  var T = 1.0;
  var col = vec3f(0.0);
  for (var i = 0; i < 56; i++) {
    let dt = kv_dt(t);
    let tm = t + dt * 0.5;
    let pe = ro + rd * (t + dt);
    let w1 = kv_width(t + dt);
    let s1 = vec3f(w1, kv_gain(t + dt, w1), kv_dt(t + dt));
    let sp = KvSpan(s0, s1);
    let ew = max(dt * 2.5, 0.08);
    let dK = length(pe - oK);
    let dS = length(pe - oS);
    let dL = length(pe - oL);
    zd = kv_tile(pe);
    zd = kv_step(zd);
    let c0 = kv_trap(zd);
    zd = kv_step(zd);
    let c1 = kv_trap(zd);
    zd = kv_step(zd);
    let c2 = kv_trap(zd);
    // The fronts (light only): each one's arrival here is its distance from its origin, stretched
    // where the coarse veil is far, so it runs along the veils and slowly across empty space. The
    // band is soft-edged (at least 0.3 units, never under a march step, or it would print the steps).
    let fib = exp(-abs(c0.x) / (w1 * 12.0));
    let slow = 1.5 - 0.8 * fib;
    let bw = max(ew, 0.3);
    let fK = smoothstep(0.0, 1.0, (kRun - dK * slow) / bw + 0.5);
    let fS = smoothstep(0.0, 1.0, (sRun - dS * slow) / bw + 0.5);
    let fL = smoothstep(0.0, 1.0, (lRun - dL * slow) / bw + 0.5);
    let fK2 = smoothstep(0.0, 1.0, (kRun - dK * slow - 0.35) / bw + 0.5);
    let fS2 = smoothstep(0.0, 1.0, (sRun - dS * slow - 0.35) / bw + 0.5);
    let fL2 = smoothstep(0.0, 1.0, (lRun - dL * slow - 0.35) / bw + 0.5);
    // Colour glides globally on the eased counts (set on the CPU). Kick: the veils step round the
    // palette. Snare: the threads have a new colour and the veil/thread balance has moved on. Note:
    // the threads carry the note's own colour (pitch class round the circle of fifths).
    let look = vec3f(shift + 0.5 * sat(tm / 2.2), 0.33 + S.p[5].w, 0.5 + 0.5 * sin(S.p[2].z));
    let hr = 2.8 * sat(tm / 2.6) - 0.8;
    var acc = KvAcc(vec3f(0.0), 0.0, 0.0);
${LEVELS.map((l) => `    kv_level(&acc, q${l}, p${l}, c${l}, dp, ${l}.0, dt, sp, look, hr); q${l} = p${l}.x; p${l} = c${l};`).join('\n')}
    var e = acc.e;
    // A band of light on the structure just behind each front.
    let passing = kHot * (fK - fK2) + sHot * (fS - fS2) + lHot * (fL - fL2);
    e *= 1.0 + 1.6 * passing;
    // The light is absorbed by the same structure that emits it, within the segment as well as after
    // it; attenuating a whole segment by the transmittance at its start would print the steps.
    let tau = acc.dens * 0.3;
    let ext = exp(-tau);
    col += T * e * select(1.0 - 0.5 * tau, (1.0 - ext) / tau, tau > 1e-3);
    T *= ext;
    t += dt;
    dp = dt;
    s0 = s1;
    if (T < 0.02 || t > 3.6) { break; }
  }
  col += T * kv_col(shift + 0.62, 0.012);
  // Highlights roll off instead of clipping.
  col = col / (1.0 + 0.06 * max(col.r, max(col.g, col.b)));
  return vec4f(min(col, vec3f(16.0)), 1.0);
}
`,
});
