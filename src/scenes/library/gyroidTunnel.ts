import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';

const TAU = Math.PI * 2;
const morph = new Morph(0.7);

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
      if (mo.kicks > this.k) take = 1 - (1 - take) * (1 - 0.22 * mo.kickLevel);
      if (mo.snares > this.s) {
        take = 1 - (1 - take) * (1 - 0.1 * mo.snareLevel);
        this.sRoll = (mo.snares % 2 ? 1 : -1) * this.tilt * mo.snareLevel;
      }
      if (mo.notes > this.n) {
        take = 1 - (1 - take) * (1 - 0.2 * mo.noteLevel);
        // The look turns by the note's strength: a faint note in a quiet passage barely moves it.
        const lv = mo.noteLevel;
        this.gazeP = mo.notePitch * this.gaze * lv;
        this.gazeY += ((mo.notes % 2 ? 1 : -1) * this.gaze * 0.8 * lv - this.gazeY) * 0.7;
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
 * Event glides: each event adds a step that eases in on a smoothstep over `T` seconds (from rest,
 * fastest half-way, settled at the end), so a beat is a smooth change of state, never a snap.
 */
class Glide {
  private base = 0;
  private steps: { t0: number; a: number }[] = [];
  constructor(private readonly T: number) {}
  reset(): void {
    this.base = 0;
    this.steps = [];
  }
  add(t: number, a: number): void {
    this.steps.push({ t0: t, a });
  }
  at(t: number): number {
    let v = this.base;
    this.steps = this.steps.filter((s) => {
      const x = (t - s.t0) / this.T;
      if (x >= 1) {
        this.base += s.a;
        v += s.a;
        return false;
      }
      if (x > 0) v += s.a * x * x * (3 - 2 * x);
      return true;
    });
    return v;
  }
  /** A bump per event instead of a step: rises from rest, peaks half-way through T, gone at T. */
  bump(t: number): number {
    let v = 0;
    this.steps = this.steps.filter((s) => {
      const x = (t - s.t0) / this.T;
      if (x >= 1) return false;
      if (x > 0) v += s.a * Math.sin(Math.PI * x) ** 2;
      return true;
    });
    return v;
  }
}
// Kick: relief step, flight lurch. Snare: pattern turn, view roll. Melody: slide, hue, light.
const gK = new Glide(0.5);
const gKPush = new Glide(0.32);
const gS = new Glide(0.32);
const gSRoll = new Glide(0.32);
const gLPush = new Glide(0.5);
const gLHue = new Glide(0.32);
const gLLight = new Glide(0.5);

/** Cells round the tube (a multiple of 4, so every pattern family and the two-cell colour lanes close round it). */
const COUNTS = [16, 20, 24, 28];
/** Seconds a kick / snare front takes to run its course (arrival spread plus its burst and embers). */
const K_LIFE = 0.85;
const S_LIFE = 0.95;
/** One step of a critically damped spring toward `target`: starts from rest, settles in about 5/w s, never overshoots. */
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}

/**
 * Flight state: camera z, the pattern phases it has crossed (so morphing a frequency never slides
 * the pattern past the camera), the eased pitch and chord hue, and where and when the last kick,
 * snare and note lit their colour fronts.
 */
const st = {
  t: -1, z: 0, cz: 0, dr: 0, fs: 0, tr: -1, uPh: 0, vPh: 0, wPh: 0, hx: 1, hy: 0, pitch: 0, seed: -1,
  pitchV: 0,
  kicks: 0, kT: -99, kZ: 0, snares: 0, sT: -99, sZ: 0, notes: 0, lT: -99, lZ: 0,
  // The previous kick and snare fronts keep burning out while the new ones start (no cut-off).
  kT2: -99, kZ2: 0, sT2: -99, sZ2: 0, kF: 0, sF: 0,
  // The melody's light: each note adds to a target that decays; the light follows it on a spring.
  lE: 0,
  // Each note also glides the pattern a little way down the tube.
  lEnv: 0, lNote: 0, kBase: 0, sBase: 0,
  // Kicks lurch the flight forward and snares roll the view a notch, both gliding on springs.
  kPushE: 0,
  // Strength of the current and previous kick and snare fronts, captured as each is lit.
  kL1: 0, kL2: 0, sL1: 0, sL2: 0,
  // Fine scale (the high end): eased wobble depth.
  dA: 0,
  // Eased passage loudness (morph.presence): how far the pitch may re-cut the stripes.
  pAmt: 0.5,
};

/**
 * Neon Tunnel: a fast flight down a tube whose wall is one morphing pattern equation, after the
 * user's voxel tunnel, neon checker tunnel and op-art references. Six pattern families blend
 * smoothly into one another (extruded cells, checker, op-art stripes, extruded hexes, Truchet tubes,
 * op-art waves), and the cross-section morphs between round, square, star and twisted. Every
 * phrase the morph carries both somewhere new, so the look is never the same for more than a phrase;
 * within a phrase the cell aspect, twist, warp, stripe frequency and relief keep flowing. Data
 * streaks run along the rows as part of the pattern. The camera rides off the axis and looks across
 * the tube, so the vanishing point sits off centre.
 *
 * Nothing snaps: every beat's change glides in on a smoothstep over about a third of a second, and
 * geometry only ever changes globally. The beats' fronts run through the tube in light only, row by
 * row and cell by cell, swelling in and burning out (a new front starts only once the one before
 * last has run its course, so none is ever cut off):
 * - kick: the relief steps to a new lasting state, the colours turn a step and the flight lurches
 *   forward; a faint burn races down the tube;
 * - snare: the pattern turns a cell and a half round the tube, the view rolls a notch and the darks change
 *   colour; a cool front spreads round the tube from a new angle;
 * - melody: the pattern slides down the tube and the hue steps with every note, the rows at the
 *   pitch's angle glow in the note's colour, and the eased pitch steers the stripe frequency;
 * - chords lean the morph toward their region and ease the hue round the wheel;
 * - every reaction scales with its own hit's strength (morph's event levels, captured as it lands),
 *   so a faint hit gives a faint step and burn, a hard one the full change; nothing has a threshold;
 * - the high end reworks the fine scale: high melodies, arps, backing chords and hats slide the data
 *   streaks along their rows, re-cut their lengths and shift the stripe phase (morph.detailAt and the
 *   eased upper / backing / hat counts, depth from detailDrive), so the fine pattern itself re-forms;
 * - energy: the flight rides morph.travel (loudness, bass and drops rush it) and drive scales the
 *   twist and warp, so drops and heavy bass visibly rush and wring the tube.
 *
 * DNA: 0-1 start point, 2 cell count, 3 palette offset, 5 fog, 6 composition, 7 stripe slant.
 */
export default raymarchScene({
  meta: {
    id: 'gyroid-tunnel',
    name: 'Neon Tunnel',
    energy: [0.25, 1],
    mood: { valence: 0.6, arousal: 0.8 },
    genres: { techno: 1, edm: 1, synthwave: 0.9, dnb: 0.9, dubstep: 0.8, pop: 0.6, rock: 0.4, hiphop: 0.6 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    framing.update(morph, Math.min(Math.max(ctx.dt, 0), 0.1), m.time);
    const a = morph.at;
    // The radius and the camera follow the step-free flow: beats re-form the pattern, never swing the view.
    const fa = morph.flowAt;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    // Energy level for the tube's wringing: the drive, smoothed over a bar or so (a level, not a wobble).
    st.dr += (morph.drive - st.dr) * (1 - Math.exp(-dt / 1.5));
    const drive = st.dr;

    const N = COUNTS[Math.min(COUNTS.length - 1, Math.floor(g[2] * COUNTS.length))];
    const R = wave(fa[6], 1.35, 1.6);
    const cellW = (R * TAU) / N;
    const cellLen = cellW * wave(a[2], 0.7, 2.2);
    // Energy wrings the tube: twist and warp grow with the drive.
    const twist = wave(a[5], -0.3, 0.3) * (0.3 + 1.2 * drive + 1.6 * morph.surge);
    const wF = 0.5;
    // Camera on morph.travel, rushing harder still while a drop surges.
    if (st.tr < 0 || Math.abs(morph.travel - st.tr) > 2) st.cz = morph.travel * 1.0;
    else st.cz += (morph.travel - st.tr) * 1.0 * (1 + 4.5 * morph.surge);
    st.tr = morph.travel;
    // A drop also hurries the pattern families along.
    st.fs += dt * 0.5 * morph.surge;
    {
      if (morph.kicks !== st.kicks && Math.abs(m.time - st.t - dt) <= 0.5) gKPush.add(m.time - morph.kickAge, 3.0 * (1 + morph.surge) * morph.kickLevel ** 2);
      const k1 = gKPush.at(m.time);
      st.cz += k1 - st.kPushE;
      st.kPushE = k1;
    }
    const z = st.cz;

    const hue = m.chord && m.chord.root >= 0 ? (((m.chord.root * 7) % 12) / 12) * TAU : 0;
    const seek = Math.abs(m.time - st.t - dt) > 0.5 || Math.abs(z - st.z) > 4 || g[0] !== st.seed;
    st.t = m.time;
    if (seek) {
      st.seed = g[0];
      st.uPh = g[1] * N;
      st.vPh = g[0] * 40;
      st.wPh = g[1] * TAU;
      st.hx = Math.cos(hue);
      st.hy = Math.sin(hue);
      st.pitch = morph.notePitch;
      st.pitchV = 0;
      for (const gl of [gK, gS, gSRoll, gLPush, gLHue, gLLight]) gl.reset();
      gKPush.reset();
      st.kPushE = 0;
      st.kBase = morph.kicks;
      st.sBase = morph.snares;
      st.kicks = morph.kicks;
      st.snares = morph.snares;
      st.notes = morph.notes;
      st.kT = st.sT = st.lT = st.kT2 = st.sT2 = -99;
      st.kL1 = st.kL2 = st.sL1 = st.sL2 = 0;
      st.dA = 0.25 + 0.75 * morph.detailDrive;
      st.pAmt = morph.presence;
      st.kZ = st.sZ = st.lZ = z;
    } else {
      const dz = z - st.z;
      st.uPh = (st.uPh + twist * dz) % N;
      st.vPh += dz / cellLen;
      st.wPh = (st.wPh + wF * dz) % (TAU * 64);
      const kh = 1 - Math.exp(-dt / 1.5);
      st.hx += (Math.cos(hue) - st.hx) * kh;
      st.hy += (Math.sin(hue) - st.hy) * kh;
      [st.pitch, st.pitchV] = spring(st.pitch, st.pitchV, morph.notePitch, 9, dt);
    }
    const age = (t0: number) => Math.min(m.time - t0, 30);
    st.z = z;
    // Reaction strengths (the kick squared, the snare to the power 1.5: their burns, lurch and turn are the biggest moves): a faint hit after
    // quiet stays a faint touch, a hard one is a full change.
    const kL = morph.kickLevel ** 2;
    const sL = morph.snareLevel ** 1.5;
    if (morph.kicks !== st.kicks) {
      st.kicks = morph.kicks;
      gK.add(m.time - morph.kickAge, kL);
      // A new front only once the one before last has burnt out, so no front is ever cut off
      // mid-burn (a fast run of kicks still moves the relief and the flight).
      if (age(st.kT2) >= K_LIFE) {
        st.kT2 = st.kT;
        st.kZ2 = st.kZ;
        st.kT = m.time - morph.kickAge;
        st.kZ = z;
        st.kF++;
        st.kL2 = st.kL1;
        st.kL1 = kL;
      }
    }
    if (morph.snares !== st.snares) {
      st.snares = morph.snares;
      gS.add(m.time - morph.snareAge, sL);
      gSRoll.add(m.time - morph.snareAge, 0.3 * sL);
      if (age(st.sT2) >= S_LIFE) {
        st.sT2 = st.sT;
        st.sZ2 = st.sZ;
        st.sT = m.time - morph.snareAge;
        st.sZ = z;
        st.sF++;
        st.sL2 = st.sL1;
        st.sL1 = sL;
      }
    }
    // Every melody attack counts, including quick repeats whose envelope barely rises.
    const newNote = morph.notes !== st.notes;
    const attack = newNote || m.lead > st.lEnv + 0.02 || (m.lead > 0.05 && m.leadNote !== st.lNote);
    // Its strength: the morph's note level, or for a quick repeat the envelope itself (both rise from 0).
    const nL = newNote ? morph.noteLevel : morph.presence * (1 - Math.exp(-3 * m.lead));
    st.notes = morph.notes;
    st.lEnv = m.lead;
    st.lNote = m.leadNote;
    if (attack) {
      // A small slide: the light and hue carry the note, the slide moves the whole wall.
      gLPush.add(m.time, 0.35 * nL);
      gLHue.add(m.time, 0.12 * nL);
      gLLight.add(m.time, 0.9 * nL);
    }
    st.lE = Math.min(1.3, gLLight.bump(m.time));
    const kPhase = st.kBase + gK.at(m.time);
    const sPhase = st.sBase + gS.at(m.time);

    // Composition: off the axis, looking across the tube (vanishing point off centre).
    const th = g[6] * TAU + morph.travel * 0.06 + 0.8 * Math.sin(fa[6] * 0.5 + fa[3] * 0.3);
    const off = R * wave(fa[2] * 0.7 + 1, 0.14, 0.24);
    const yaw = wave(fa[5] * 0.6 + 2, 0.55, 0.85);
    const D = 2.5;
    const lk = Math.max(0, D * Math.tan(yaw) - off);
    const ux = Math.cos(th);
    const uy = Math.sin(th) * 0.6;
    // Framing (morph.cam, RULES v8): the eye rises or sinks off the axis (kept well inside the clear
    // bore), the look turns by the phrase's yaw and pitch, the lens widens or narrows, the view rolls.
    const cam = framing.cam;
    let ex = ux * off;
    let ey = uy * off + cam.height * 0.16 * R;
    const er = Math.hypot(ex, ey);
    const eMax = 0.34 * R;
    if (er > eMax) { ex *= eMax / er; ey *= eMax / er; }
    const lx = -ux * lk + D * Math.tan(0.8 * cam.yaw);
    const ly = -uy * lk + D * Math.tan(0.7 * cam.pitch);
    const q12 = (v: number) => Math.round(Math.max(-7.99, Math.min(7.99, v)) * 256) + 2048;
    const focal = 1.15 / Math.pow(cam.fov, 0.9);

    // S.p[0]: camera z, cells round, cell length, twist.
    p[0] = z;
    p[1] = N;
    p[2] = cellLen;
    p[3] = twist;
    // S.p[1]: warp amount (drive), u phase, stripe frequency (pitch steers it), warp phase.
    // The pitch re-cuts the stripes of the whole wall, so it steers them by how loud the passage is:
    // a faint motif in a quiet intro barely touches them, the lead in a drop re-cuts them fully.
    st.pAmt += (morph.presence - st.pAmt) * (1 - Math.exp(-dt / 1.5));
    p[4] = wave(a[4], 0.05, 0.3) * (0.3 + 1.3 * drive);
    p[5] = st.uPh;
    p[6] = wave(a[7], 0.6, 2.0) * (1 + 0.3 * st.pitch * st.pAmt * st.pAmt);
    p[7] = st.wPh;
    // S.p[2]: relief depth, radius, camera offset.
    p[8] = wave(a[1] * 0.8 + a[4] * 0.4, 0.1, 0.24);
    p[9] = R;
    p[10] = ex;
    p[11] = ey;
    // S.p[3]: look-at offset (x, y at 1/256, packed), roll, cross-section exponent (2 round .. 8
    // square) + 10 * focal length (1/1000).
    p[12] = q12(lx) + 4096 * q12(ly);
    // Fine phase (the high end): the detail flow, stepped by each high note's strength, plus the
    // eased upper, backing and hat counts; the streaks also stream steadily with the flight.
    p[13] = morph.travel * 0.6 + morph.detailAt[0] * 1.5 + morph.upperPhase * 0.55 + morph.backingPhase * 0.3 + morph.hatPhase * 0.1;
    st.dA += (0.25 + 0.75 * morph.detailDrive - st.dA) * (1 - Math.exp(-dt / 0.4));
    p[14] = (g[6] - 0.5) * 0.3 + gSRoll.at(m.time) + 0.12 * Math.sin(fa[6] * 0.5 + fa[0] * 0.3) + cam.roll;
    p[15] = 2 + 6 * Math.pow(wave(a[3], 0, 1), 1.5) + 10 * Math.round(focal * 1000);
    // S.p[4]: hue, v phase, star depth, star lobes + 10 * (stripe slant + 2).
    p[16] = g[3] + 0.25 * (Math.atan2(st.hy, st.hx) / TAU) + 0.1 * st.pitch + gLHue.at(m.time);
    p[17] = st.vPh - gLPush.at(m.time);
    p[18] = Math.max(0, wave(a[3] * 0.8 + a[6] * 0.6 + 1, -0.08, 0.13));
    // Lobes + 10 * slant (< 64), then the previous kick and snare fronts' strengths and the fine
    // wobble depth, 64 steps each (all integers, exact in f32).
    const q6 = (x: number) => Math.max(0, Math.min(63, Math.round(x * 63)));
    p[19] = (3 + Math.floor(((g[7] * 7.3) % 1) * 4)) + 10 * (Math.floor(g[7] * 5)) + 64 * q6(st.kL2) + 4096 * q6(st.sL2) + 262144 * q6(st.dA);
    // S.p[5]: cross-section twist rate, family selector angle and sharpness, kick phase.
    p[20] = wave(a[5] * 0.7 + a[1] * 0.5, -0.25, 0.25) * (0.4 + 1.2 * drive);
    p[21] = a[0] + 0.05 * morph.travel + st.fs;
    p[22] = wave(a[1], 6, 12);
    p[23] = kPhase % 4096;
    // S.p[6]: snare phase, kick front age and origin, snare front age.
    p[24] = sPhase % 4096;
    // Front age (up to 8 s) + 8 * front count + 512 * its strength (64 steps).
    p[25] = Math.min(age(st.kT), 7.99) + 8 * (st.kF % 64) + 512 * q6(st.kL1);
    p[26] = st.kZ;
    p[27] = Math.min(age(st.sT), 7.99) + 8 * (st.sF % 64) + 512 * q6(st.sL1);
    // S.p[7]: snare origin, note front age and origin, note count * 4 + pitch + 1.
    p[28] = st.sZ;
    // S.p[7].y: melody light level + 4 * pitch step (0..1000).
    p[29] = Math.min(st.lE, 3.99) + 4 * Math.round((Math.max(-1, Math.min(1, st.pitch)) + 1) * 500);
    // S.p[7].zw: the previous kick and snare fronts, age (1/1024 s, up to 8 s) + 8192 * how far
    // behind the current origin theirs was (1/64 units).
    const slot2 = (t0: number, z0: number, zNow: number) =>
      Math.round(Math.min(age(t0), 7.99) * 1024) + 8192 * Math.max(0, Math.min(1023, Math.round((zNow - z0) * 64)));
    p[30] = slot2(st.kT2, st.kZ2, st.kZ);
    p[31] = slot2(st.sT2, st.sZ2, st.sZ);
  },
  wgsl: /* wgsl */ `
const NT_KSPD: f32 = 50.0;
const NT_SSPD: f32 = 50.0;
const NT_LSPD: f32 = 18.0;
const NT_SQ3: f32 = 1.7320508;

// Family weights, computed once per pixel: extruded cells, checker, stripes, hexes, Truchet, waves.
var<private> wC: f32;
var<private> wK: f32;
var<private> wS: f32;
var<private> wH: f32;
var<private> wT: f32;
var<private> wW: f32;

fn nt_weights() {
  let a = S.p[5].y;
  let k = S.p[5].z;
  var w: array<f32, 6>;
  var sum = 0.0;
  for (var i = 0; i < 6; i++) {
    w[i] = exp(k * (cos(a - f32(i) * TAU / 6.0) - 1.0));
    sum += w[i];
  }
  // Faint families fade out softly (a hard cut would pop them in and out).
  for (var i = 0; i < 6; i++) { let x = w[i] / sum; w[i] = x * smoothstep(0.03, 0.08, x); }
  sum = w[0] + w[1] + w[2] + w[3] + w[4] + w[5];
  wC = w[0] / sum; wK = w[1] / sum; wS = w[2] / sum; wH = w[3] / sum; wT = w[4] / sum; wW = w[5] / sum;
}

// Lobes + 10 * slant, under the packed front strengths and fine depth.
fn nt_base() -> f32 { return S.p[4].w - floor(S.p[4].w / 64.0) * 64.0; }
// Fine depth (the high end), 0..1.
fn nt_fineA() -> f32 { return floor(S.p[4].w / 262144.0) / 63.0; }
// A front slot: (age, count, strength).
fn nt_slot(v: f32) -> vec3f {
  let lq = floor(v / 512.0);
  let r = v - lq * 512.0;
  let kc = floor(r / 8.0);
  return vec3f(r - kc * 8.0, kc, lq / 63.0);
}

fn nt_path(z: f32) -> vec2f {
  let w = 0.6;
  return vec2f(sin(z * 0.09) * w + sin(z * 0.041 + 1.3) * w * 0.6, cos(z * 0.071) * w * 0.6 + sin(z * 0.033) * 0.3);
}

struct NtCell {
  u: f32, v: f32, row: f32, ring: f32, zc: f32, r: f32, a: f32, l: vec2f, s: f32,
};

// Cross-section metric: an Lp ring (round to square), star lobes, twisted along the tube.
fn nt_shape(l: vec2f, s: f32) -> f32 {
  let lr = rot2(s * S.p[5].x) * l;
  let pn = S.p[3].w - 10.0 * floor(S.p[3].w / 10.0);
  let q = abs(lr) + vec2f(1e-5);
  let m = max(q.x, q.y);
  let lp = m * pow(pow(q.x / m, pn) + pow(q.y / m, pn), 1.0 / pn);
  let lobes = nt_base() - floor(nt_base() / 10.0) * 10.0;
  let th = atan2(lr.y, lr.x);
  return lp * (1.0 + S.p[4].z * cos(lobes * th));
}

fn nt_cell(p: vec3f) -> NtCell {
  var c: NtCell;
  let N = S.p[0].y;
  let l = p.xy - nt_path(p.z);
  let a = atan2(l.y, l.x);
  let s = p.z - S.p[0].x;
  let w = S.p[1].x * sin(s * 0.5 + S.p[1].w);
  // Each snare turns the whole pattern about a cell and a half round the tube by its strength (eased, for good).
  c.u = a / TAU * N + S.p[0].w * s + S.p[1].y + w + S.p[6].x * 1.4;
  c.v = s / S.p[0].z + S.p[4].y + 0.35 * S.p[1].x * sin(a * 3.0 + s * 0.25);
  c.row = fmod(fmod(floor(c.u), N) + N, N);
  c.ring = floor(c.v);
  c.zc = S.p[0].x + (c.ring + 0.5 - S.p[4].y) * S.p[0].z;
  c.r = nt_shape(l, s);
  c.a = a;
  c.l = l;
  c.s = s;
  return c;
}

fn nt_hash3(a: f32, b: f32, c: f32) -> f32 { return hash13(vec3f(a, b, c)); }

// Depth of one cell (or hex) in one kick state: about half of them move per kick.
fn nt_depth(i: f32, j: f32, k: f32) -> f32 {
  let o = floor(nt_hash3(i, j, 3.1) * 2.0);
  let x = nt_hash3(i, j, floor((k + o) / 2.0));
  return x * x;
}
fn nt_depthK(i: f32, j: f32) -> f32 {
  let kp = S.p[5].w;
  let k0 = floor(kp);
  return mix(nt_depth(i, j, k0), nt_depth(i, j, k0 + 1.0), smoothstep(0.0, 1.0, kp - k0));
}

// Nearest hex centre in (x, y) with unit spacing along x (so it closes round the tube): returns
// (axial i wrapped, axial j, distance to the hex edge as a fraction of the inradius 0..1).
fn nt_hex(x: f32, y: f32, N: f32) -> vec3f {
  let j0 = floor(y / (NT_SQ3 * 0.5));
  var best = vec3f(0.0, 0.0, 1e9);
  for (var dj = 0; dj < 2; dj++) {
    let j = j0 + f32(dj);
    let i = floor(x - 0.5 * j + 0.5);
    let d = length(vec2f(x - (i + 0.5 * j), y - j * NT_SQ3 * 0.5));
    if (d < best.z) { best = vec3f(i, j, d); }
  }
  let q = abs(vec2f(x - (best.x + 0.5 * best.y), y - best.y * NT_SQ3 * 0.5));
  // Hex edge distance (pointy-top hexes of inradius 0.5), as a fraction of the inradius.
  let e = max(q.x, dot(q, vec2f(0.5, NT_SQ3 * 0.5)));
  return vec3f(fmod(fmod(best.x, N) + N, N), best.y, e / 0.5);
}

// The pattern equation at a cell point: x height 0..1, y lit 0..1, z seam lines 0..1.
fn nt_pat(c: NtCell, aa: f32) -> vec3f {
  let N = S.p[0].y;
  let fu = fract(c.u);
  let fv = fract(c.v);
  let sp = S.p[6].x;
  var h = 0.0;
  var lit = 0.0;
  var line = 0.0;
  let edge = min(min(fu, 1.0 - fu), min(fv, 1.0 - fv));
  let eLine = smoothstep(aa * 1.5 + 0.02, 0.0, edge);
  if (wC > 0.0) {
    let d = nt_depthK(c.row, c.ring);
    h += wC * (0.15 + 0.85 * d);
    lit += wC * step(0.4, nt_hash3(c.row, c.ring, 9.0));
    line += wC * eLine;
  }
  if (wK > 0.0) {
    let par = fract((c.row + c.ring) * 0.5) * 2.0;
    h += wK * (0.1 + 0.2 * par);
    lit += wK * par;
    line += wK * eLine * 0.5;
  }
  if (wS > 0.0) {
    let slant = floor(nt_base() / 10.0) - 2.0;
    let sv = c.v * S.p[1].z + c.u * slant / N + sp * 0.37 + S.p[3].y * 0.11;
    let b = abs(fract(sv) - 0.5) * 2.0;
    let bw = aa * S.p[1].z * 2.0 + 0.04;
    let m = smoothstep(0.5 - bw, 0.5 + bw, b);
    h += wS * (0.15 + 0.5 * smoothstep(0.2, 0.8, b));
    lit += wS * m;
    line += wS * smoothstep(bw + 0.03, 0.0, abs(b - 0.5)) * 0.6;
  }
  if (wH > 0.0) {
    let hx = nt_hex(c.u, c.v * S.p[0].z / (S.p[2].y * TAU / N), N);
    let d = nt_depthK(hx.x + 100.0, hx.y);
    h += wH * (0.15 + 0.85 * d);
    lit += wH * step(0.45, nt_hash3(hx.x, hx.y, 5.0));
    line += wH * smoothstep(1.0 - aa * 3.0 - 0.06, 1.0, hx.z);
  }
  if (wT > 0.0) {
    let fl = step(0.5, nt_hash3(c.row, c.ring, 4.0));
    let f = select(vec2f(fu, fv), vec2f(1.0 - fu, fv), fl > 0.5);
    let d = min(abs(length(f) - 0.5), abs(length(f - vec2f(1.0)) - 0.5));
    let tw = 0.16;
    let tb = sqrt(sat(1.0 - (d / tw) * (d / tw)));
    h += wT * (0.1 + 0.8 * tb);
    lit += wT * smoothstep(0.05, 0.3 + aa, tb);
  }
  if (wW > 0.0) {
    let ws = c.v * S.p[1].z * 0.6 + 0.35 * sin(c.u * TAU * 3.0 / N + c.v * 0.7) + sp * 0.37;
    let b = 0.5 + 0.5 * sin(ws * TAU);
    let bw = aa * S.p[1].z * 3.0 + 0.05;
    h += wW * (0.1 + 0.6 * b);
    lit += wW * smoothstep(0.5 - bw, 0.5 + bw, b);
  }
  return vec3f(h, lit, line);
}

fn nt_height(c: NtCell) -> f32 {
  // Relief far down the tube flattens into the pattern (no sub-pixel geometry).
  let fade = 1.0 - smoothstep(8.0, 13.0, c.zc - S.p[0].x);
  // Each kick sets the whole relief to a new lasting depth (eased in, never sprung back).
  let kp = S.p[5].w;
  let k0 = floor(kp);
  let lv = mix(hash11(k0 * 7.13 + 1.0), hash11(k0 * 7.13 + 8.13), smoothstep(0.0, 1.0, kp - k0));
  return S.p[2].x * (0.35 + 1.0 * lv) * nt_pat(c, 0.02).x * fade;
}

// > 0 inside the wall.
fn nt_solid(p: vec3f) -> f32 {
  let c = nt_cell(p);
  return c.r - (S.p[2].y - nt_height(c));
}

fn nt_step(p: vec3f) -> f32 {
  let c = nt_cell(p);
  let R = S.p[2].y;
  let inner = R - S.p[2].x * 1.4 - 0.05;
  // Clear of the relief: no need to evaluate the pattern.
  if (c.r < inner) { return (inner + 0.04 - c.r) * 0.7; }
  let d = ((R - nt_height(c)) - c.r) * 0.7;
  let cw = R * TAU / S.p[0].y;
  // Stepped families (cells, hexes) need short steps across the relief; smooth ones less so.
  return min(d, mix(0.55, 0.24, wC + wH) * min(cw, S.p[0].z) + 0.004);
}

// Hue of a colour from its chroma vector, steadied by a pull toward t's own hue, so a near-grey
// palette colour never makes the hue jump.
fn nt_hue(c: vec3f, t: f32) -> f32 {
  let v = vec2f(c.r - 0.5 * (c.g + c.b), 0.8660254 * (c.g - c.b)) + 0.2 * vec2f(cos(t * TAU), sin(t * TAU));
  return fract(atan2(v.y, v.x) / TAU);
}
// Neon colour: hue anchored on the director's palette at the scene hue and spread round the wheel
// by t, so several vivid hues show even under a narrow palette.
fn nt_col(t: f32, lum: f32) -> vec3f {
  let base = S.p[4].x;
  // The anchor hue turns round the wheel between the palette's own colours (the short way), never
  // through the grey between two opposite ones, where the hue of the blend would flip in a frame.
  let x = fract(base) * 4.0;
  let i = floor(x);
  let ta = i / 4.0;
  let tb = (i + 1.0) / 4.0;
  let ha = nt_hue(pal(ta + 1e-4), ta);
  let hb = nt_hue(pal(tb - 1e-4), tb);
  let h0 = ha + (fract(hb - ha + 0.5) - 0.5) * smoothstep(0.0, 1.0, x - i);
  let v = hsv2rgb(vec3f(h0 + (t - base) * 0.9, 1.0, 1.0));
  let c = mix(v, max(mix(vec3f(luma(pal(t))), pal(t), 1.6), vec3f(0.0)), 0.08);
  return c * lum * 2.6 / (0.75 + 0.5 * luma(c));
}

// A burst that starts from rest, peaks at tau and fades (never switches on in one frame).
fn nt_env(h: f32, tau: f32) -> f32 {
  return smoothstep(0.0, tau, h) * exp(-max(h - tau, 0.0) / tau);
}

// Second front slot: (age, origin z offset behind the current one).
fn nt_slot2(v: f32) -> vec2f {
  let dq = floor(v / 8192.0);
  return vec2f((v - dq * 8192.0) / 1024.0, dq / 64.0);
}

// Hot edge of a burn: white, yellow, orange, then embers cooling to nothing.
fn nt_fire(h: f32) -> vec3f {
  if (h < 0.0) { return vec3f(0.0); }
  let c = mix(mix(vec3f(1.0, 0.9, 0.65), vec3f(1.0, 0.7, 0.15), smoothstep(0.0, 0.08, h)),
              vec3f(1.0, 0.3, 0.05), smoothstep(0.08, 0.35, h));
  // Swells in over a fifth of a second instead of flaring on.
  return c * (1.8 * nt_env(h, 0.2) + 0.3 * exp(-h / 0.3) * smoothstep(0.0, 0.3, h));
}

// Arrival times of the kick front (down the tube, ragged by row and cell) and the snare front
// (round the tube from an angle, then down it).
fn nt_kT(c: NtCell, z0: f32, kc: f32) -> f32 {
  return min(max(c.zc - z0, 0.0), 9.0) / NT_KSPD + 0.12 * nt_hash3(c.row, kc, 1.0) + 0.04 * nt_hash3(c.row, c.ring, kc);
}
fn nt_sT(c: NtCell, z0: f32, sc: f32, R: f32) -> f32 {
  let sAng = fract(sc * 0.618) * TAU;
  let da = abs(fract((c.a - sAng) / TAU + 0.5) - 0.5) * TAU;
  return da * R / NT_SSPD + min(max(c.zc - z0, 0.0), 9.0) / (NT_SSPD * 1.6) + 0.1 * nt_hash3(c.row, c.ring, sc);
}
fn nt_sFire(h: f32, hue: f32) -> vec3f {
  if (h < 0.0) { return vec3f(0.0); }
  return mix(vec3f(0.9, 1.0, 1.0), nt_col(hue + 0.55, 1.0), smoothstep(0.0, 0.15, h)) * (2.0 * nt_env(h, 0.12) + 0.3 * exp(-h / 0.2) * smoothstep(0.0, 0.2, h));
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  nt_weights();
  let q2 = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let z = S.p[0].x;
  let ro = vec3f(nt_path(z) + S.p[2].zw, z);
  let lq = floor(S.p[3].x / 4096.0);
  let look = (vec2f(S.p[3].x - 4096.0 * lq, lq) - 2048.0) / 256.0;
  let ta = vec3f(nt_path(z + 2.5) + look, z + 2.5);
  let focal = floor(S.p[3].w / 10.0) / 1000.0;
  let cam = lookAt(ro, ta, S.p[3].z);
  let rd = normalize(cam * vec3f(q2, focal));
  let pix = 1.4 / (F.res.y * focal);
  let N = S.p[0].y;
  let R = S.p[2].y;

  var t = 0.05 + 0.02 * ign(frag);
  var tp = t;
  var hit = false;
  let tMax = 26.0;
  for (var i = 0; i < 120; i++) {
    let pos = ro + rd * t;
    let d = nt_step(pos);
    if (d < 0.0) { hit = true; break; }
    tp = t;
    t += max(d, pix * t * 0.5);
    if (t > tMax) { break; }
  }
  if (hit) {
    var a = tp;
    var b = t;
    for (var j = 0; j < 6; j++) {
      let m = 0.5 * (a + b);
      if (nt_solid(ro + rd * m) > 0.0) { b = m; } else { a = m; }
    }
    t = b;
  }

  let hue = S.p[4].x;
  let fogC = nt_col(hue + 0.6, 0.004) + nt_col(hue + 0.1, 0.012) * pow(sat(dot(rd, normalize(vec3f(nt_path(z + 20.0), z + 20.0) - ro))), 20.0);
  var col = fogC;
  if (hit) {
    let pos = ro + rd * t;
    let c = nt_cell(pos);
    let fp = pix * t;
    let cw = c.r * TAU / N;
    let pat = nt_pat(c, fp / max(min(cw, S.p[0].z), 1e-3));
    let hgt = nt_height(c);
    // Normal from the solid field; caps face the axis, side walls catch the key light.
    let e = max(fp * 1.5, 0.002);
    let k = vec2f(1.0, -1.0);
    let n = normalize(k.xyy * nt_solid(pos + k.xyy * e) + k.yyx * nt_solid(pos + k.yyx * e) +
                      k.yxy * nt_solid(pos + k.yxy * e) + k.xxx * nt_solid(pos + k.xxx * e)) * -1.0;
    let inward = -vec3f(c.l / max(length(c.l), 1e-4), 0.0);
    let capness = sat(dot(n, inward));

    // Colour fronts (light only; the geometry never changes along a front).
    // Two fronts each for kick and snare: the newest, and the one before still burning out.
    // Each front burns with its own hit's strength.
    let k1 = nt_slot(S.p[6].y);
    let kc = k1.y;
    let k2 = nt_slot2(S.p[7].z);
    let kHeat = k1.x - nt_kT(c, S.p[6].z, kc);
    let kHeat2 = k2.x - nt_kT(c, S.p[6].z - k2.y, kc - 1.0);
    let s1 = nt_slot(S.p[6].w);
    let sc = s1.y;
    let s2 = nt_slot2(S.p[7].w);
    let sHeat = s1.x - nt_sT(c, S.p[7].x, sc, R);
    let sHeat2 = s2.x - nt_sT(c, S.p[7].x - s2.y, sc - 1.0, R);
    let pk = floor(S.p[4].w / 64.0);
    let kLv2 = (pk - floor(pk / 64.0) * 64.0) / 63.0;
    let ps = floor(S.p[4].w / 4096.0);
    let sLv2 = (ps - floor(ps / 64.0) * 64.0) / 63.0;
    let lpack = S.p[7].y;
    let lq = floor(lpack / 4.0);
    let lp = lq / 500.0 - 1.0;
    let viewAng = atan2(-S.p[2].w, -S.p[2].z + 1e-5);
    // The melody lights the rows at the (eased) pitch's angle; its light swells and fades with the notes.
    let lAng = viewAng + lp * 1.3;
    let la = abs(fract((c.a - lAng) / TAU + 0.5) - 0.5) * TAU;
    let rowD = la * N / TAU;
    let lBand = exp(-rowD * rowD * 0.12);
    let lEnv = lpack - lq * 4.0;

    // Hue: two colour families in lanes two cells wide running down the tube (the second turned
    // about 135 degrees from the first, so any palette and any view shows two distinct hues), each
    // cell's kick colour, and the snare's second-colour state on the dark parts.
    let fam = 0.42 * smoothstep(-0.25, 0.25, sin(c.u * PI * 0.5));
    let hB = hue + fam + 0.04 * (mix(nt_hash3(c.row, c.ring, floor(S.p[5].w)), nt_hash3(c.row, c.ring, floor(S.p[5].w) + 1.0), fract(S.p[5].w)) - 0.5) + S.p[5].w * 0.3 + S.p[6].x * 0.08;
    var neon = nt_col(hB, 0.15);
    // The melody's colour keeps each lane's family offset, so its light never paints the view one hue.
    let lHue = hue + 0.5 + 0.35 * lp + fam;
    neon = mix(neon, nt_col(lHue, 0.15), lBand * 0.85 * sat(lEnv));
    let dark = nt_col(hB + 0.5 + S.p[6].x * 0.3, 0.008);

    // Data streaks along the rows in the dark parts, part of the pattern.
    let fu = fract(c.u);
    let fv = fract(c.v);
    let sub = floor(fu * 5.0);
    let sx = abs(fract(fu * 5.0) - 0.5);
    let sseed = nt_hash3(c.row, sub, c.ring);
    // The fine scale answers the high end: each streak slides along its row at its own rate as the
    // fine phase steps with every high note, and its length breathes with it (deeper when highs are rich).
    let fP = S.p[3].y;
    let along = fract(fv + sseed * 7.0 + fP * (0.15 + 0.25 * sseed));
    let slen = 0.25 + 0.6 * nt_hash3(c.row, sub, c.ring + 17.0) + 0.2 * nt_fineA() * sin(fP * (0.7 + sseed) + sseed * 40.0);
    let lineW = max(0.12, fp / max(cw / 5.0, 1e-3));
    let streak = smoothstep(lineW, lineW * 0.4, sx) * step(along, slen) * step(0.45, sseed) * (1.0 - pat.y);
    let detail = sat(1.5 - fp / max(cw * 0.05, 1e-4));

    let L = normalize(vec3f(0.3, 0.5, 1.0));
    let dif = sat(dot(n, L));
    let fre = pow(1.0 - sat(dot(n, -rd)), 4.0);
    let cap = mix(dark, neon, pat.y) * (0.8 + 0.25 * dif) + neon * (streak * detail * 1.2 + pat.z * 0.5);
    let sideC = neon * (0.04 + 0.25 * dif) + dark * 2.0 + neon * fre * 0.3;
    col = mix(sideC, cap, smoothstep(0.55, 0.9, capness));
    col *= 0.45 + 0.65 * sat(hgt / max(S.p[2].x, 1e-3));

    // Fires stay off the cells right at the lens (they would fill the frame).
    let nearF = smoothstep(0.7, 2.4, t);
    let glowM = nearF * (0.05 + 0.5 * pat.y + 2.5 * streak * detail + 1.5 * pat.z);
    // As the front arrives each cell flares in its new colour; the embers stay on the lit parts and streaks.
    col += (nt_fire(kHeat) * k1.z + nt_fire(kHeat2) * kLv2) * glowM * 0.1 + (nt_env(kHeat, 0.2) * k1.z + nt_env(kHeat2, 0.2) * kLv2) * nt_col(hB, 0.9) * 0.055 * (0.6 + 0.4 * capness) * nearF;
    // The cool burn is the snare's brightest touch: it rises with the square of the strength.
    let sFire = nt_sFire(sHeat, hue) * s1.z * s1.z + nt_sFire(sHeat2, hue) * sLv2 * sLv2;
    col += sFire * (0.06 + 0.25 * (1.0 - pat.y) + 2.0 * streak * detail + pat.z) * 0.18 * nearF;
    let lFire = nt_col(lHue, 1.0) * lEnv * lBand;
    col += lFire * (0.12 + 0.4 * pat.y + 3.0 * streak * detail + 1.5 * pat.z) * 0.25 * nearF;
    col += lEnv * lBand * nt_col(lHue, 0.9) * 0.15 * nearF;

    // Deep darks between the lit cells: the dim parts fall away, the neon keeps its level.
    col *= mix(0.38, 1.0, smoothstep(0.03, 0.35, luma(col)));
    col *= mix(0.7, 1.0, smoothstep(0.6, 2.5, t));
    col = mix(fogC, col, smoothstep(0.25, 0.6, t));
    let fog = 1.0 - exp(-t * 0.08 - max(t - 12.0, 0.0) * 0.15);
    col = mix(col, fogC, fog);
  }
  col *= 1.0 / (1.0 + 0.7 * max(luma(col) - 0.45, 0.0));
  return vec4f(min(col, vec3f(8.0)), 1.0);
}
`,
});
