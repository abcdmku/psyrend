import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';

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
        this.sRoll = (mo.snares % 2 ? 1 : -1) * this.tilt * (0.4 + 0.6 * mo.snareLevel);
      }
      if (mo.notes > this.n) {
        take = 1 - (1 - take) * (1 - 0.2 * mo.noteLevel);
        const lv = 0.45 + 0.55 * Math.sqrt(mo.noteLevel);
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


/** Tile-steps per second at which each light process runs through the tiling (shared with the WGSL). */
const VK = 36;
const VS = 40;
const VM = 28;

const PQ: readonly [number, number][] = [[3, 7], [4, 5], [5, 4], [7, 3], [6, 4], [4, 6], [8, 3], [5, 5], [3, 8], [6, 5]];
// The tunnel uses the translation symmetry along the real axis, which needs an even p.
const PQ_EVEN: readonly [number, number][] = [[4, 5], [6, 4], [4, 6], [8, 3], [6, 6], [4, 8]];

const fract = (x: number) => x - Math.floor(x);
/** One step of a critically damped spring toward `target`: starts from rest, settles in about 5/w s, never overshoots. */
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}
/**
 * Follows an event-driven target: each change eases in by smoothstep over `dur` seconds, from rest to
 * rest, so a beat's step never snaps and its motion peaks a moment after the hit, then is over.
 */
class Glide {
  x = 0;
  private base = 0;
  private target = 0;
  private q: [number, number][] = [];
  constructor(private readonly dur = 0.32) {}
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
  reset(x: number): void {
    this.x = this.base = this.target = x;
    this.q = [];
  }
}
/** The beat steps' glides: Wythoff kick term, snare reflection and roll, melody steps, the push. */
const eg = { kE: new Glide(), flip: new Glide(), sRoll: new Glide(), rho: new Glide(), nHue: new Glide(), gStep: new Glide(), mPush: new Glide() };
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Scene state that is not in the morph engine: the outgoing and incoming tilings and relief styles
 * of a phrase change and how far it has eased in, the ages of the last two kicks (for the light
 * that runs through the tiling), and the melody's eased steps.
 */
const cross3 = (a: number[], b: number[]): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: number[]): [number, number, number] => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

const st = {
  t: -1,
  seed: -1,
  phrases: 0,
  pqA: 0,
  pqB: 0,
  styleA: 0,
  styleB: 0,
  w: 0,
  wu: 0,
  pending: false,
  kicks: 0,
  kT: 0,
  kE: 0,
  k1: 9,
  k2: 9,
  sAge: 9,
  /** The snare and melody burns before the latest keep running (no burn or colour cut off by the next). */
  sAge2: 9,
  mAge2: 9,
  mShell2: 3,
  snares: 0,
  sGap: 9,
  flipT: 0,
  flip: 0,
  rhoSum: 0,
  rho: 0,
  mAge: 9,
  mShell: 3,
  pitch: 0,
  pitchE: 0,
  pitchV: 0,
  notes: 0,
  nGap: 9,
  nHue: 0,
  nHueE: 0,
  spin: 0,
  trans: 0,
  cam: 0,
  gAng: 0,
  gStep: 0,
  gStepE: 0,
  mPush: 0,
  sRoll: 0,
  sRollE: 0,
  mPushE: 0,
  /**
   * Each event's strength (morph's level, squared so a faint hit stays a faint touch), captured as it
   * lands: the latest two kicks' and snares' and the latest two notes' (their burns run on), plus
   * the summed strength of the kicks and snares before those two (their hue steps, settled).
   */
  lk1: 0,
  lk2: 0,
  cumK: 0,
  ls1: 0,
  ls2: 0,
  cumS: 0,
  lm1: 0,
  lm2: 0,
};
/** A 0..1 level quantised to 5 bits for packing (levels are constant per event, so this never steps in time). */
const q5 = (l: number) => Math.round(Math.min(1, Math.max(0, l)) * 31);

/**
 * {p,q} hyperbolic tilings in cloisonné relief on curved architecture. The Poincaré disk is folded
 * by reflection (two mirror lines through the origin and one geodesic circle) and then mapped into
 * 3D: the hemisphere model (mirrored, so a full sphere) seen from low under the vault or from deep
 * inside, or the band model wrapped into a tunnel seen across its bore. Each face is a field of
 * glossy enamel held in raised metal wire, stepped metal terraces, an engraved metal frame or
 * cushioned enamel, with an emissive seam in the groove between faces. Colours are set by
 * brightness floored at their peak channel (a deep blue is never pushed to a glare) and depth haze
 * falls into a deep dark, so on any palette the colour sits on real darks.
 *
 * The music acts on the tiling's equation, globally and eased, so the whole vault re-forms as one
 * coherent tiling. Light and colour travel through it along its own graph (tile to neighbouring
 * tile, seams first and then into each face): a hot edge leaves embers that cool into a new colour.
 * - Phrase (every 8 bars or new section): a completely new tiling, another {p,q} with another
 *   relief, dissolving in over about a bar.
 * - Kick: steps the Wythoff point (how the faces are truncated), so every face re-forms into new
 *   proportions, and the view glides a step along. Fire spreads outward from the centre tile,
 *   white-yellow-orange, and the enamel steps to the next hue behind it.
 * - Snare: reflects the Wythoff point a step (the face types trade sizes: small faces swell, large
 *   ones shrink) and the view rolls a notch. A cold electric burn races inward from the far tiles;
 *   behind it the seams and the edge faces change colour.
 * - Melody: each note steps the Wythoff point's other coordinate (up or down with the interval)
 *   and pitch steers the curvature (the lens). The note's colour burns out both ways from the ring
 *   of tiles at the pitch's distance from the centre, the hue steps on and the view glides on.
 * Every step eases in by smoothstep over a third of a second; the burn before the latest keeps
 * running, so nothing is cut off. Every step, hue step and burn scales with its own hit's strength
 * (captured as it lands), so a faint hit makes a faint change and a hard one the full change.
 * - High end (RULES v7): the fine relief itself is re-cut by morph's detail layer. The spacing of
 *   the terraces, engraved lines and guilloche ripples, the wobble of the wires along each edge and
 *   their phase follow detailAt; each high note, backing chord and hat steps them on (eased, by its
 *   strength), and the ripples deepen with the air of the mix (detailDrive).
 * - Chords: lean the morph toward a region and ease the hue.
 * - Energy: drive and drop surges rush the glide, the spin and the tunnel's travel.
 */
export default raymarchScene({
  meta: {
    id: 'hyperbolic-dome',
    name: 'Hyperbolic Dome',
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.5 },
    genres: { classical: 0.9, jazz: 0.8, techno: 0.7, edm: 0.6, ambient: 0.7, synthwave: 0.5, pop: 0.4 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    framing.update(morph, Math.min(Math.max(ctx.dt, 0), 0.1), m.time);
    const at = morph.at;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const mode = [0, 1, 3][Math.floor(g[1] * 3)]; // 0 dome, 1 sphere, 3 tunnel
    const list = mode === 3 ? PQ_EVEN : PQ;
    const seek = Math.abs(m.time - st.t - dt) > 0.5 || g[0] !== st.seed;
    st.t = m.time;
    if (seek) {
      st.seed = g[0];
      st.phrases = morph.phrases;
      st.pqA = st.pqB = Math.floor(g[0] * list.length + m.time * 0.013) % list.length;
      st.styleA = st.styleB = Math.floor(g[3] * 4) % 4;
      st.w = st.wu = 0;
      st.pending = false;
      st.kicks = morph.kicks;
      st.k1 = st.k2 = 9;
      st.kT = st.kE = 0;
      st.snares = morph.snares;
      st.sAge = st.sAge2 = 9;
      st.sGap = 9;
      st.flipT = st.flip = g[2] < 0.5 ? 0 : 1;
      st.rhoSum = st.rho = 0;
      st.mAge = st.mAge2 = 9;
      st.pitch = st.pitchE = morph.notePitch;
      st.pitchV = 0;
      st.notes = morph.notes;
      st.nHue = st.nHueE = 0;
      st.spin = g[6] * 6;
      st.trans = m.time * 0.1;
      st.cam = m.time * 0.1;
      st.gAng = g[5] * 6.28;
      st.gStep = st.gStepE = 0;
      st.mPush = st.mPushE = 0;
      st.sRoll = st.sRollE = 0;
      eg.kE.reset(0);
      eg.flip.reset(st.flipT);
      eg.sRoll.reset(0);
      eg.rho.reset(0);
      eg.nHue.reset(0);
      eg.gStep.reset(0);
      eg.mPush.reset(0);
      st.lk1 = st.lk2 = st.cumK = 0;
      st.ls1 = st.ls2 = st.cumS = 0;
      st.lm1 = st.lm2 = 0;
    }
    // A drop rushes the turn, the glide and the camera well beyond the steady drive.
    const rush = 1 + 4 * morph.surge;

    // Phrase: a completely new tiling and relief, dissolving in over about a bar from rest
    // (smoothstep). A phrase that arrives mid-dissolve waits for it to finish, so the incoming
    // tiling is never swapped out half-shown.
    if (morph.phrases !== st.phrases) st.pending = true;
    if (st.pending && st.w === 0) {
      st.pending = false;
      st.phrases = morph.phrases;
      const h = fract(Math.sin(morph.phrases * 12.9898 + g[0] * 78.233) * 43758.5453);
      let next = Math.floor(h * list.length);
      if (next === st.pqA) next = (next + 1 + Math.floor(h * 7)) % list.length;
      if (next === st.pqA) next = (next + 1) % list.length;
      st.pqB = next;
      st.styleB = (st.styleA + 1 + Math.floor(fract(h * 13.7) * 3)) % 4;
      st.wu = 0;
      st.w = 0.0001;
    }
    if (st.w > 0) {
      const bar = (60 / Math.max(40, m.bpm)) * Math.max(1, m.beatsPerBar);
      st.wu += dt / Math.max(1, bar * 1.1);
      st.w = Math.max(0.0001, smooth(st.wu));
      if (st.wu >= 1) {
        st.pqA = st.pqB;
        st.styleA = st.styleB;
        st.w = st.wu = 0;
      }
    }

    // Kicks: the light of the last two still runs through the tiling; older ones are in the base hue.
    st.k1 += dt;
    st.k2 += dt;
    if (morph.kicks !== st.kicks) {
      st.kicks = morph.kicks;
      st.k2 = st.k1;
      st.k1 = morph.kickAge;
      const l = morph.kickLevel ** 2;
      st.cumK += st.lk2;
      st.lk2 = st.lk1;
      st.lk1 = l;
      // Each kick steps the Wythoff point by its strength; after a drop the steps are bigger for a few bars.
      st.kT += (2.6 + 1.0 * morph.surge) * l;
      // ...and the view lurches a little forward through the vault, gliding.
      st.mPush += 0.3 * l;
      st.gStep += 0.12 * l;
    }
    // Every step eases in by smoothstep over a third of a second, from rest to rest.
    st.kE = eg.kE.update(st.kT, dt);
    // Snares: each one reflects the Wythoff point part of the way further; a roll of fast snares
    // adds up to less than a step per beat, so it never churns faster than the backbeat.
    st.sAge += dt;
    st.sAge2 += dt;
    st.sGap += dt;
    if (morph.snares !== st.snares) {
      st.snares = morph.snares;
      st.sAge2 = st.sAge;
      st.sAge = morph.snareAge;
      const l = morph.snareLevel ** 2;
      st.cumS += st.ls2;
      st.ls2 = st.ls1;
      st.ls1 = l;
      const sw = Math.min(1.0, st.sGap / (1.25 * (60 / Math.max(40, m.bpm)))) * l;
      st.flipT += sw;
      // ...and turns the view a notch round its axis, gliding.
      st.sRoll += 0.25 * sw;
      // ...and glides the wall a little along the bore.
      st.mPush += 0.15 * sw;
      st.sGap = 0;
    }
    st.flip = eg.flip.update(st.flipT, dt);
    st.sRollE = eg.sRoll.update(st.sRoll, dt);
    // Melody: each note steps the Wythoff point's second coordinate with the interval (eased), and
    // its light burns out from the ring of tiles at the pitch's distance from the centre.
    // A fast run of notes takes half steps, so it never churns the tiling.
    st.nGap += dt;
    if (morph.notes !== st.notes) {
      st.notes = morph.notes;
      const iv = morph.notePitch - st.pitch;
      const l = morph.noteLevel ** 2;
      st.lm2 = st.lm1;
      st.lm1 = l;
      const w = Math.max(0.5, Math.min(1, st.nGap / (0.75 * (60 / Math.max(40, m.bpm))))) * l;
      st.nGap = 0;
      st.nHue += 0.3 * w;
      st.rhoSum += (iv < 0 ? -1 : 1) * (0.85 + Math.min(Math.abs(iv) * 5, 0.6)) * w;
      st.gStep += iv * 2.5 * w;
      // In the tunnel each note glides the wall a little further along the bore.
      st.mPush += 0.35 * w;
      st.mAge2 = st.mAge;
      st.mShell2 = st.mShell;
      st.mAge = morph.leadAge;
      st.mShell = 1 + 4.5 * (0.5 + 0.5 * morph.notePitch);
      st.pitch = morph.notePitch;
    }
    st.mAge += dt;
    st.mAge2 += dt;
    st.rho = eg.rho.update(st.rhoSum, dt);
    st.nHueE = eg.nHue.update(st.nHue, dt);
    st.gStepE = eg.gStep.update(st.gStep, dt);
    st.mPushE = eg.mPush.update(st.mPush, dt);
    [st.pitchE, st.pitchV] = spring(st.pitchE, st.pitchV, morph.notePitch, 12, dt);
    // Energy: the turn and the glide run on the music's drive, rushing after a drop.
    st.spin += dt * (0.02 + 0.06 * morph.drive) * rush;
    st.gAng += dt * (0.025 + 0.07 * morph.drive) * rush;

    const [PA, QA] = list[st.pqA % list.length];
    const [PB, QB] = list[st.pqB % list.length];
    p[0] = PA; p[1] = QA; p[2] = PB; p[3] = QB;

    // Glide through the plane (dome modes) and turn; the tunnel streams along its band.
    let ax = 0;
    let ay = 0;
    let th = 0;
    if (mode !== 3) {
      const rr = wave(at[0], 0.05, 0.42);
      ax = rr * Math.cos(st.gAng + st.gStepE + at[1]);
      ay = rr * Math.sin(st.gAng + st.gStepE + at[1]);
      th = st.spin + 0.5 * at[2];
    }
    st.trans += dt * (0.03 + 0.09 * morph.drive) * rush;
    const trans = st.trans + st.mPushE + g[0] * 20;
    p[4] = ax; p[5] = ay; p[6] = th;
    const lens = wave(at[7], 1.02, 1.22) + 0.22 * (0.5 + 0.5 * st.pitchE);
    // The tunnel's translation (the shader reduces it by each tiling's own band period).
    p[7] = mode === 3 ? trans : lens;
    const material = Math.floor(g[3] * 4.7) % 4;
    const lmode = Math.floor(fract(g[4] * 2.7 + g[7]) * 3);
    const rig = Math.floor(g[4] * 3);
    // Exact integers: mode, material, light, camera rig, and the latest two notes' strengths.
    p[8] = mode + 4 * material + 16 * lmode + 48 * rig + 144 * (q5(st.lm1) + 32 * q5(st.lm2));
    // Fine scale (RULES v7): the relief's fine spacing (0..1, /1000) and the ripple depth, from the
    // detail layer: high notes step detailAt, and the air of the mix deepens the ripples.
    const da = morph.detailAt;
    const fineF = 0.5 + 0.5 * Math.sin(da[0] * 0.8 + 0.6 * Math.sin(da[2] * 0.7));
    const fineA = Math.min(1, 0.3 + 0.7 * morph.detailDrive);
    p[9] = Math.floor(fineF * 999) + 0.999 * fineA;
    p[10] = st.w;
    p[11] = 0.5 - 0.5 * Math.cos(Math.PI * st.flip);

    // Camera: travels with the music's drive, never jolts on a beat.
    st.cam += dt * (0.04 + 0.11 * morph.drive) * rush;
    const sp = st.cam;
    let eye: [number, number, number];
    let tgt: [number, number, number];
    let roll = 0;
    if (mode === 0) {
      const az = sp * 0.11 + g[4] * 9;
      const elev = [0.55, 1.0, 0.35][rig] + 0.12 * Math.sin(sp * 0.07);
      const off = [0.3, 0.12, 0.5][rig];
      eye = [off * Math.cos(az * 0.7 + 2), [0.3, 0.18, 0.22][rig], off * Math.sin(az * 0.7 + 2)];
      tgt = [eye[0] + Math.cos(az) * Math.cos(elev), eye[1] + Math.sin(elev), eye[2] + Math.sin(az) * Math.cos(elev)];
      roll = 0.15 * Math.sin(sp * 0.04);
    } else if (mode === 1) {
      const az = sp * 0.09 + g[4] * 7;
      const rr = [0.45, 0.62, 0.25][rig];
      eye = [rr * Math.cos(az), rr * 0.5 * Math.sin(sp * 0.05 + 1), rr * Math.sin(az)];
      const la = az + [2.4, 2.9, 1.2][rig] + 0.3 * Math.sin(sp * 0.04);
      const le = 0.5 * Math.sin(sp * 0.06 + g[4] * 4);
      tgt = [eye[0] + Math.cos(la) * Math.cos(le), eye[1] + Math.sin(le), eye[2] + Math.sin(la) * Math.cos(le)];
      roll = 0.4 * Math.sin(sp * 0.05);
    } else {
      // Tunnel: off the axis, looking across the bore at the far wall, so the vanishing point sits
      // to one side and the wall streams past at an angle.
      const side = g[5] < 0.5 ? 1 : -1;
      const ang = sp * 0.06 + g[4] * 9;
      const off = [0.32, 0.4, 0.22][rig];
      const yaw = [0.8, 1.05, 0.6][rig] + 0.15 * Math.sin(sp * 0.05);
      eye = [off * Math.cos(ang), off * Math.sin(ang), 0];
      const ox = -Math.cos(ang + side * 0.5);
      const oy = -Math.sin(ang + side * 0.5);
      tgt = [eye[0] + Math.sin(yaw) * ox, eye[1] + Math.sin(yaw) * oy, Math.cos(yaw)];
      roll = ang + side * 0.6;
    }
    // Framing (morph.cam, RULES v8), merged into the rig: the eye rises or sinks (the dome and sphere
    // lift it, the tunnel moves it off the axis), the look turns by the phrase's yaw and pitch on
    // the rig's own frame, the view rolls, and the lens widens or narrows. The focal multiplier
    // rides as the length of the look vector (the shader's lookAt normalises it).
    const cam = framing.cam;
    roll += cam.roll;
    if (mode === 3) {
      const ex = eye[0], ey = eye[1];
      const r0 = Math.hypot(ex, ey) || 1;
      const r1 = Math.max(0.08, Math.min(0.52, r0 + 0.13 * cam.height));
      eye[0] = (ex / r0) * r1;
      eye[1] = (ey / r0) * r1;
    } else {
      eye[1] += 0.13 * cam.height;
      const r = Math.hypot(eye[0], eye[1], eye[2]);
      if (r > 0.66) { eye[0] *= 0.66 / r; eye[1] *= 0.66 / r; eye[2] *= 0.66 / r; }
    }
    {
      const fw = norm3([tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]]);
      const up: [number, number, number] = [Math.sin(roll), Math.cos(roll), 0];
      const uu = norm3(cross3(fw, up));
      const vv = cross3(uu, fw);
      const ky = mode === 3 ? 0.6 : 1;
      const ty = Math.tan(ky * cam.yaw);
      const tp = Math.tan(0.8 * ky * cam.pitch);
      let d = norm3([fw[0] + ty * uu[0] + tp * vv[0], fw[1] + ty * uu[1] + tp * vv[1], fw[2] + ty * uu[2] + tp * vv[2]]);
      // Never straight up or down the dome's pole, never back up the tunnel.
      if (mode === 3) {
        if (d[2] < 0.15) d = norm3([d[0], d[1], 0.15]);
      } else if (Math.abs(d[1]) > 0.92) {
        const h = Math.hypot(d[0], d[2]) || 1;
        const sy = Math.sign(d[1]);
        d = [(d[0] / h) * 0.39, sy * 0.92, (d[2] / h) * 0.39];
      }
      const len = Math.pow(1 / cam.fov, 0.9);
      tgt = [eye[0] + d[0] * len, eye[1] + d[1] * len, eye[2] + d[2] * len];
    }
    p[12] = eye[0]; p[13] = eye[1]; p[14] = eye[2]; p[15] = roll + st.sRollE;
    p[16] = tgt[0]; p[17] = tgt[1]; p[18] = tgt[2];
    // p[19]: the shader looks the focal length up from the mode and rig (p[8]), freeing this slot.
    // Fine phase: the detail flow, plus a lasting step per high note, backing chord and hat (each
    // eased and scaled by its strength in morph), so each one visibly re-cuts the fine relief.
    p[19] = 1.3 * da[1] + 2.4 * morph.upperPhase + 1.1 * morph.backingPhase + 0.25 * morph.hatPhase;

    // Relief depth, groove width, Wythoff point (kick term and melody term).
    const kStep = 1.0 * (g[7] < 0.5 ? 1 : -1);
    p[20] = wave(at[5], 0.16, 0.26);
    p[21] = wave(at[6], 0.035, 0.06);
    p[22] = at[3] + g[2] * 6 + kStep * st.kE;
    p[23] = at[4] + g[1] * 5 + st.rho;
    // Kick ages (s) + 10 x (kick strength + 32 x snare strength), 5 bits each: the latest and the one before.
    p[24] = Math.min(st.k1, 9) + 10 * (q5(st.lk1) + 32 * q5(st.ls1));
    p[25] = Math.min(st.k2, 9) + 10 * (q5(st.lk2) + 32 * q5(st.ls2));
    // Relief styles (A + 4 B) + 16 x the settled snare strength (1/100, mod 64 so the hue wraps
    // whole turns): each snare re-tints one face type by its strength.
    p[26] = st.styleA + 4 * st.styleB + 16 * (Math.round(st.cumS * 100) % 6400);
    const chordHue = m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : 0;
    // Each phrase also turns the colours round, eased in with the new tiling.
    const phraseHue = st.w > 0 ? morph.phrases - 1 + st.w : morph.phrases;
    const hueBase = fract(g[6] * 1.7 + 0.15 * chordHue) + 0.31 * phraseHue;
    p[27] = hueBase + 0.14 * st.cumK + st.nHueE;
    // Latest snare age (s) + 10 x the one before (1/100 s).
    p[28] = Math.min(st.sAge, 9.9) + 10 * Math.round(Math.min(st.sAge2, 8) * 100);
    p[29] = Math.min(st.mAge, 9) + 10 * Math.round(st.mShell * 10);
    // How hot the light burns (/100): a drop makes every burn hotter for a few bars.
    // Burn heat (/100) + 200 x (the previous note's shell (/10) + 64 x its age (1/100 s)): exact integers.
    p[30] = Math.round(100 * Math.min(1.4, 0.6 + 0.8 * morph.surge)) + 200 * (Math.round(st.mShell2 * 10) + 64 * Math.round(Math.min(st.mAge2, 8) * 100));
    p[31] = hueBase + 0.42 + 0.21 * st.cumS;
  },
  wgsl: /* wgsl */ `
const HD_VK: f32 = ${VK.toFixed(2)};
const HD_VS: f32 = ${VS.toFixed(2)};
const HD_VM: f32 = ${VM.toFixed(2)};

struct HdG { P: f32, d: f32, r: f32, s: f32, M: f32, L: f32 };
struct HdF { z: vec2f, sc: f32, gen: f32, hid: f32, ok: f32 };
struct HdT { h: f32, e: f32, metal: f32, aa: f32, ok: f32, reg: f32, fk: f32, tk: f32, ts: f32, fs: f32, tm: f32, tm2: f32, par: f32, lk: f32, ls: f32 };

var<private> gA: HdG;
var<private> gB: HdG;

fn hd_geo(P: f32, Q: f32) -> HdG {
  let a = PI / P;
  let b = PI / Q;
  let den = sqrt(max(cos(b) * cos(b) - sin(a) * sin(a), 1e-6));
  var g: HdG;
  g.P = P;
  g.r = sin(a) / den;
  g.d = cos(b) / den;
  g.s = g.d * cos(a) - sqrt(max(g.d * g.d * cos(a) * cos(a) - 1.0, 0.0));
  g.M = g.d - g.r;
  let m = min(g.M, 0.999);
  g.L = 2.0 * log((1.0 + m) / (1.0 - m));
  return g;
}

fn hd_base() -> f32 { return S.p[2].x - 144.0 * floor(S.p[2].x / 144.0); }
fn hd_mode() -> f32 { let v = hd_base(); return v - 4.0 * floor(v / 4.0); }
fn hd_mat() -> f32 { let v = floor(hd_base() / 4.0); return v - 4.0 * floor(v / 4.0); }
fn hd_lmode() -> f32 { let v = floor(hd_base() / 16.0); return v - 3.0 * floor(v / 3.0); }
fn hd_rig() -> f32 { return floor(hd_base() / 48.0); }
// The latest two notes' strengths (5 bits each).
fn hd_noteLv() -> vec2f { let v = floor(S.p[2].x / 144.0); let a = v - 32.0 * floor(v / 32.0); return vec2f(a, floor(v / 32.0)) / 31.0; }
// A packed age: (seconds, kick strength, snare strength).
fn hd_age(v: f32) -> vec3f {
  let r = floor(v / 10.0);
  let k = r - 32.0 * floor(r / 32.0);
  return vec3f(v - 10.0 * r, k / 31.0, floor(r / 32.0) / 31.0);
}
fn hd_focal() -> f32 {
  let r = hd_rig();
  let m = hd_mode();
  var f = vec3f(1.0, 0.8, 1.15);
  if (m > 0.5 && m < 1.5) { f = vec3f(0.9, 1.15, 0.75); }
  if (m > 2.5) { f = vec3f(0.95, 1.15, 0.85); }
  return select(select(f.z, f.y, r < 1.5), f.x, r < 0.5);
}
// Fine scale from the detail layer: (spacing multiplier, ripple depth, phase).
fn hd_fine() -> vec3f {
  let v = S.p[2].y;
  return vec3f(0.75 + 0.6 * floor(v) / 999.0, fract(v) / 0.999, S.p[4].w);
}

fn hd_cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn hd_cdiv(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / max(dot(b, b), 1e-12); }

// Disk automorphism z -> e^{i th} (z - a) / (1 - conj(a) z). Returns (w, |dw/dz|).
fn hd_mob(z: vec2f) -> vec3f {
  let a = S.p[1].xy;
  let den = vec2f(1.0, 0.0) - hd_cmul(vec2f(a.x, -a.y), z);
  let w = rot2(S.p[1].z) * hd_cdiv(z - a, den);
  return vec3f(w, (1.0 - dot(a, a)) / max(dot(den, den), 1e-9));
}

// World point on the base surface -> (disk z, world units per disk unit), for a tiling whose band
// period is g.L and translation tr (the tunnel); the dome modes ignore both.
fn hd_toDisk(p: vec3f, g: HdG, tr: f32) -> vec3f {
  var z: vec2f;
  var wpd: f32;
  if (hd_mode() < 2.5) {
    // Hemisphere model through a lens: k = 1 shows the whole plane, larger k a magnified patch.
    let u = normalize(p);
    let h = abs(u.y);
    let k = S.p[1].w;
    z = vec2f(u.x, u.z) / (k + h);
    wpd = k + h;
  } else {
    // Band model wrapped round a cylinder (two mirrored copies), reduced by the translation period.
    let L = g.L;
    let phi = atan2(p.y, p.x);
    let y = clamp(abs(phi) - PI * 0.5, -1.5703, 1.5703);
    let x = fmod(p.z + tr + 0.5 * L, L) - 0.5 * L;
    let den = cosh(x) + cos(y);
    z = vec2f(sinh(x), sin(y)) / den;
    let z2 = hd_cmul(z, z);
    wpd = 1.0 / max(0.5 * length(vec2f(1.0 - z2.x, -z2.y)), 1e-5);
  }
  let m = hd_mob(z);
  return vec3f(m.xy, wpd / max(m.z, 1e-6));
}

// Fold a disk point into the fundamental triangle: O (p-gon centre), A (edge midpoint), B (vertex).
// gen counts the circle reflections, so it is the tile's distance from the central tile in steps.
fn hd_fold(zIn: vec2f, g: HdG) -> HdF {
  let ca = PI / g.P;
  let n = vec2f(-sin(ca), cos(ca));
  let c = vec2f(g.d, 0.0);
  let r2 = g.r * g.r;
  var f: HdF;
  var z = zIn;
  f.sc = 1.0;
  f.gen = 0.0;
  f.hid = 0.0;
  f.ok = 0.0;
  for (var i = 0; i < 18; i++) {
    let k = floor(atan2(z.y, z.x) / (2.0 * ca));
    z = rot2(-k * 2.0 * ca) * z;
    let dn = dot(z, n);
    if (dn > 0.0) { z -= 2.0 * dn * n; }
    let zc = z - c;
    let l2 = dot(zc, zc);
    if (l2 >= r2) { f.ok = 1.0; break; }
    let s = r2 / l2;
    z = c + zc * s;
    f.sc *= s;
    f.gen += 1.0;
    f.hid = fract(f.hid * 1.618 + fract((k + 7.0) * 0.1173) + 0.137);
  }
  f.z = z;
  return f;
}

// The Wythoff point from two unbounded coordinates, kept a little inside the triangle so no face
// shrinks to a dot. flip (0..1) reflects it: the weights toward the edge midpoint and the vertex
// trade, so small faces swell as large ones shrink.
fn hd_wyth(g: HdG, ph: f32, rho: f32, flip: f32) -> vec2f {
  let ca = PI / g.P;
  var a = 0.5 + 0.5 * sin(ph);
  var b = 0.5 + 0.5 * sin(rho);
  if (a + b > 1.0) { let t = a; a = 1.0 - b; b = 1.0 - t; }
  let wu = 0.14 + 0.62 * mix(a, b, flip);
  let wv = 0.14 + 0.62 * mix(b, a, flip);
  var w = vec2f(wu * g.M + wv * g.s * cos(ca), wv * g.s * sin(ca));
  let cw = w - vec2f(g.d, 0.0);
  let cl = length(cw);
  if (cl < g.r * 1.01) { w = vec2f(g.d, 0.0) + cw / cl * g.r * 1.01; }
  return w;
}

fn hd_seg(z: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let k = sat(dot(z - a, ab) / max(dot(ab, ab), 1e-12));
  return length(z - a - ab * k);
}

fn hd_cross(a: vec2f, b: vec2f) -> f32 { return a.x * b.y - a.y * b.x; }

// Wythoff edges from W at right angles to each mirror. Returns (edge distance, face 0/1/2, distance
// to the face centre), in units of the edge midpoint distance M.
fn hd_edges(z: vec2f, g: HdG, W: vec2f) -> vec3f {
  let ca = PI / g.P;
  let u = vec2f(cos(ca), sin(ca));
  let c = vec2f(g.d, 0.0);
  let cw = W - c;
  let f3 = c + cw * (g.r / max(length(cw), 1e-6));
  let e = min(hd_seg(z, W, vec2f(W.x, 0.0)), min(hd_seg(z, W, u * dot(W, u)), hd_seg(z, W, f3)));
  let A = vec2f(g.M, 0.0);
  let B = g.s * u;
  let s3 = hd_cross(f3 - W, z - W) * hd_cross(f3 - W, A - W);
  var reg = select(2.0, 1.0, s3 > 0.0);
  if (z.x < W.x && dot(z, u) < dot(W, u)) { reg = 0.0; }
  let ctr = select(select(B, A, reg > 0.5 && reg < 1.5), vec2f(0.0), reg < 0.5);
  return vec3f(e / g.M, reg, length(z - ctr) / g.M);
}

// Relief profile of one face: (height 0..1, metal 0..1). Everything follows the face's own outline
// (u: distance to its edges), so no round bosses or buttons. mir: distance to the mirrors through
// the p-gon centre, gw: groove half width, aa: pixel footprint over tile size.
//
// Fine scale (the high end): fq scales the spacing of the terraces, engraved lines and guilloche
// ripples, fa sets the ripples' depth and fp their phase; the wires wobble along the edge (by o)
// with the same phase. Every fine term fades before it would alias.
fn hd_relief(u: f32, o: f32, mir: f32, style: f32, gw: f32, aa: f32) -> vec2f {
  let fn3 = hd_fine();
  let fq = fn3.x;
  let fa = fn3.y;
  let fp = fn3.z;
  let groove = smoothstep(gw * 0.45, gw, u);
  // Engraved lines parallel to the edges, faded before they would alias.
  let eng = (0.5 + 0.5 * cos(u * 170.0 * fq + fp)) * sat(1.0 - aa * 110.0 * fq);
  // Guilloche ripples following the outline, finer and deeper with the high end.
  let rq = 95.0 * fq;
  let rip = cos(u * rq - fp * 1.7) * sat(1.0 - aa * rq * 0.65) * fa;
  // Wire wobble along each edge.
  let wob = 0.009 * fa * sin(o * 60.0 * fq + fp) * sat(1.0 - aa * 60.0 * fq);
  var h = 0.0;
  var metal = 0.0;
  if (style < 0.5) {
    // Cloisonné: enamel held in a raised metal wire.
    let w1 = sat(1.0 - pow((u - gw - 0.028 - wob) / 0.026, 2.0));
    let field = 0.66 + 0.1 * sat(u * 3.0) + 0.045 * rip * sat((u - gw - 0.06) * 12.0);
    let wire = w1;
    h = max(field, wire);
    metal = smoothstep(-0.03, 0.03, wire - field);
  } else if (style < 1.5) {
    // Stepped metal terraces following the outline down to a sunken enamel field.
    let x = min(u - gw, 0.26) * fq / 0.065;
    let fx = fract(x);
    let stepH = floor(x) + smoothstep(0.5 - 0.5 * sat(aa * 30.0 * fq) - 0.08, 0.5 + 0.08, fx);
    h = 1.0 - 0.11 * stepH / fq + 0.03 * rip * smoothstep(0.25, 0.27, u - gw);
    metal = 1.0 - smoothstep(0.25, 0.27, u - gw);
  } else if (style < 2.5) {
    // A wide bevelled metal frame engraved with lines along the edges, a flat enamel field inside.
    let fw = 0.2;
    let frame = 1.0 - 0.3 * smoothstep(gw, fw, u) - 0.025 * eng;
    let field = 0.55 + 0.05 * sat((u - fw) * 4.0) + 0.04 * rip * sat((u - fw) * 12.0);
    h = select(field, frame, u < fw);
    metal = 1.0 - smoothstep(fw - 0.01, fw + 0.01, u);
  } else {
    // Cushioned enamel in a thin metal wire, rounded along the face's own outline.
    let wire = sat(1.0 - pow((u - gw - 0.015 - wob) / 0.016, 2.0));
    let field = 0.45 + 0.45 * sqrt(sat((u - gw) * 3.5)) + 0.04 * rip * sat((u - gw - 0.04) * 12.0);
    h = max(field, wire * 0.9);
    metal = smoothstep(-0.03, 0.03, wire * 0.9 - field);
  }
  return vec2f(h * groove, metal);
}

// One tiling's tile at a disk point. The equation (Wythoff point, reflection blend, relief style)
// is global; only light and colour travel, along the tiling's own graph: arrival times count tile
// steps from the centre tile, and each face lights from its seams inward.
fn hd_core(dz: vec3f, g: HdG, style: f32, pixW: f32) -> HdT {
  let fo = hd_fold(dz.xy, g);
  var t: HdT;
  let ca = PI / g.P;
  let n = vec2f(-sin(ca), cos(ca));
  let gw = S.p[5].y;
  let W = hd_wyth(g, S.p[5].z, S.p[5].w, S.p[2].w);
  let ed = hd_edges(fo.z, g, W);
  let inward = sat(ed.x * 2.5);
  // Kick: fire spreads outward from the centre tile; behind it the enamel has stepped hue.
  let Tk = fo.gen + 1.1 * inward;
  let a1 = hd_age(S.p[6].x);
  let a2 = hd_age(S.p[6].y);
  let k1 = a1.x * HD_VK - Tk;
  let k2 = a2.x * HD_VK - Tk;
  // Each tile's hue step eases in over about a third of a second as the fire reaches it, by its kick's strength.
  t.fk = a1.y * smoothstep(0.0, HD_VK * 0.35, k1) + a2.y * smoothstep(0.0, HD_VK * 0.35, k2);
  t.tk = select(k2, k1, k1 > 0.0) / HD_VK;
  t.lk = select(a2.y, a1.y, k1 > 0.0);
  // Snare: a cold burn inward from the far tiles; behind it the seams have a new colour.
  // (from six steps out, so it reaches the tiles in view within a fifth of a second)
  let Ts = max(6.0 - fo.gen, 0.0) + 1.2 * inward;
  let sv = S.p[7].x;
  let s2 = floor(sv / 10.0);
  let ts1 = sv - s2 * 10.0 - Ts / HD_VS;
  let ts2 = s2 / 100.0 - Ts / HD_VS;
  // Each of the last two snares' seam colours eases in as its burn passes (so neither is cut off).
  t.fs = a1.z * smoothstep(0.0, 0.35, ts1) + a2.z * smoothstep(0.0, 0.35, ts2);
  t.ts = select(ts2, ts1, ts1 > 0.0);
  t.ls = select(a2.z, a1.z, ts1 > 0.0);
  // Melody: burns both ways from the ring of tiles at the pitch's distance from the centre.
  let mAge = fmod(S.p[7].y, 10.0);
  let shell = floor(S.p[7].y / 10.0) / 10.0;
  t.tm = (mAge * HD_VM - (abs(fo.gen - shell) + 1.0 * inward)) / HD_VM;
  let r2 = floor(S.p[7].z / 200.0);
  let shell2 = (r2 - 64.0 * floor(r2 / 64.0)) / 10.0;
  t.tm2 = (floor(r2 / 64.0) / 100.0 * HD_VM - (abs(fo.gen - shell2) + 1.0 * inward)) / HD_VM;
  let mir = min(fo.z.y, -dot(fo.z, n)) / g.M;
  let aa = select(9.0, pixW / dz.z * fo.sc / g.M, fo.ok > 0.5);
  let rel = hd_relief(ed.x, ed.z, mir, style, gw, aa);
  // Each face type sits at its own depth, so the tiling's structure reads in the relief.
  let h = rel.x * select(select(0.82, 0.92, ed.y > 1.5), 1.0, ed.y < 0.5);
  // Tiles smaller than a few pixels flatten into an average.
  let fade = sat(1.3 - aa * 3.0);
  t.h = mix(0.55, h, fade);
  t.metal = mix(0.4, rel.y, fade);
  t.e = ed.x;
  t.aa = aa;
  t.ok = fo.ok;
  t.reg = ed.y;
  // The p-gon faces alternate by their distance from the centre (constant over each face).
  t.par = select(0.0, fmod(fo.gen, 2.0), ed.y < 0.5);
  return t;
}

// The outgoing (A) and incoming (B) tilings of a phrase change.
fn hd_tileA(p: vec3f, pixW: f32) -> HdT { return hd_core(hd_toDisk(p, gA, S.p[1].w), gA, fmod(S.p[6].z, 4.0), pixW); }
fn hd_tileB(p: vec3f, pixW: f32) -> HdT { return hd_core(hd_toDisk(p, gB, S.p[1].w), gB, floor(fmod(S.p[6].z, 16.0) / 4.0), pixW); }

fn hd_hw(t: HdT, pixW: f32) -> f32 {
  let tileW = select(0.0, pixW / max(t.aa, 1e-6), t.ok > 0.5);
  return S.p[5].x * t.h * min(tileW, 0.45);
}

// Relief height in world units: one tiling, or both blended while a phrase change eases in.
fn hd_height(p: vec3f, pixW: f32) -> f32 {
  let w = S.p[2].z;
  var h = 0.0;
  if (w < 0.999) { h += hd_hw(hd_tileA(p, pixW), pixW) * (1.0 - w); }
  if (w > 0.001) { h += hd_hw(hd_tileB(p, pixW), pixW) * w; }
  return h;
}

fn hd_radius(p: vec3f) -> f32 {
  if (hd_mode() > 2.5) { return length(p.xy); }
  return length(p);
}

fn hd_exit(ro: vec3f, rd: vec3f, rr: f32) -> f32 {
  if (hd_mode() > 2.5) {
    let a = dot(rd.xy, rd.xy);
    let b = dot(ro.xy, rd.xy);
    let c = dot(ro.xy, ro.xy) - rr * rr;
    return (-b + sqrt(max(b * b - a * c, 0.0))) / max(a, 1e-6);
  }
  let b = dot(ro, rd);
  let c = dot(ro, ro) - rr * rr;
  return -b + sqrt(max(b * b - c, 0.0));
}

// Palette colour at a set luminance, pushed a little more saturated (vivid enamel, never grey).
// Rotate a colour round the grey axis by a fraction of a turn (keeps its luminance roughly).
fn hd_rot(c: vec3f, turn: f32) -> vec3f {
  let k = vec3f(0.57735);
  let a = turn * TAU;
  return max(c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a)), vec3f(0.0));
}

fn hd_col(t: f32, lum: f32) -> vec3f {
  let c = pal(t);
  let v = max(mix(vec3f(luma(c)), c, 1.5), vec3f(0.0));
  // Brightness floored by the peak channel: a deep blue or red is not pushed to a glare to match the
  // luminance of a green, so every palette keeps the same deep darks.
  return v * (lum / max(max(luma(v), 0.3 * max(v.r, max(v.g, v.b))), 0.02));
}

// Coloured light the metal and enamel reflect: a dark gradient with three soft coloured panels.
fn hd_env(d: vec3f) -> vec3f {
  let h0 = S.p[6].w;
  let up = d.y * 0.5 + 0.5;
  var c = mix(hd_col(h0 + 0.6, 0.004), hd_col(h0 + 0.2, 0.02), up * up);
  c += hd_col(h0 + 0.05, 1.1) * pow(sat(dot(d, normalize(vec3f(0.5, 0.8, 0.3)))), 8.0);
  c += hd_col(h0 + 0.38, 0.8) * pow(sat(dot(d, normalize(vec3f(-0.7, 0.3, 0.5)))), 6.0);
  c += hd_col(h0 + 0.7, 0.7) * pow(sat(dot(d, normalize(vec3f(0.1, 0.2, -0.95)))), 6.0);
  return c;
}

// Burn colour by seconds since the fire passed: white-hot edge, yellow, orange embers, cooling out.
fn hd_fire(tb: f32) -> vec3f {
  if (tb < 0.0) { return vec3f(0.0); }
  let h = exp(-tb * 7.0);
  let c = mix(vec3f(0.8, 0.09, 0.02), mix(vec3f(1.0, 0.42, 0.05), vec3f(1.0, 0.88, 0.6), sat(h * 2.2 - 1.2)), sat(h * 1.7));
  // The burn swells in over a fifth of a second instead of flaring on.
  return c * (1.1 * h * h * h + 0.2 * h) * smoothstep(0.0, 0.15, tb);
}

// Surface colour for a tile sample.
fn hd_shade(t: HdT, n: vec3f, rd: vec3f, pW: vec3f) -> vec3f {
  let mat = hd_mat();
  let lmode = hd_lmode();
  let h0 = S.p[6].w + 0.14 * t.fk;
  let hv = floor(S.p[7].z);
  let heat = (hv - 200.0 * floor(hv / 200.0)) / 100.0;
  let detail = sat(1.25 - t.aa * 3.0);
  // One colour per face: by face type, and round the p-gons by their distance from the centre.
  // The edge faces (type 1) step an eighth of a turn with each snare as its burn passes, for good.
  let sn = floor(S.p[6].z / 16.0) / 100.0 + t.fs;
  let hue = h0 + 0.3 * t.reg * detail + select(0.0, 0.125 * sn, abs(t.reg - 1.0) < 0.5);
  let hs = S.p[7].w + 0.21 * t.fs;

  var L: vec3f;
  if (lmode < 0.5) {
    L = normalize(vec3f(0.4, 1.0, 0.25));
  } else if (lmode < 1.5) {
    L = normalize(vec3f(-0.6, 0.55, 0.5));
  } else {
    L = normalize(vec3f(0.2, 0.35, -0.9));
  }
  if (hd_mode() > 2.5) { L = normalize(vec3f(-pW.xy, 0.0) * 0.7 + vec3f(0.0, 0.0, 0.7)); }
  let lc = mix(vec3f(1.0, 0.95, 0.88), hd_col(h0 + 0.05, 1.0), 0.3);
  let dif = sat(dot(n, L));
  let rv = reflect(rd, n);
  let ndv = sat(dot(n, -rd));
  let fre = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  let ao = mix(0.35, 1.0, sat(t.h * 1.4));
  let env = hd_env(rv);
  let spe = pow(sat(dot(rv, L)), 60.0);

  // Enamel: deep glossy colour under a clear coat.
  // Glass enamel, a little deeper at the wire. Each face type also turns round the colour wheel, so
  // a narrow palette still gives several hues.
  let body = hd_rot(hd_col(hue, 0.2), (0.28 * t.reg + 0.4 * t.par) * detail) * (0.4 + 0.6 * sat(t.e * 4.0));
  var enamel = body * (0.12 + 1.3 * dif * lc) * ao;
  enamel += (env * 0.8 + lc * spe * 1.2) * fre * ao;
  // Metal by material: gold, tinted silver, copper, black chrome.
  var tint = vec3f(1.0, 0.74, 0.4);
  if (mat > 0.5 && mat < 1.5) { tint = hd_col(hue + 0.5, 0.6); }
  if (mat > 1.5 && mat < 2.5) { tint = vec3f(0.95, 0.48, 0.32); }
  if (mat > 2.5) { tint = mix(vec3f(0.16), hd_col(hue + 0.3, 0.2), 0.4); }
  let mf = mix(tint, vec3f(1.0), pow(1.0 - ndv, 5.0));
  let metal = mf * (env * 0.9 + lc * spe * 1.5 + dif * 0.06) * ao;
  var col = mix(enamel, metal, t.metal);

  // The groove: a dark channel with a fine emissive seam at its floor that carries the processes.
  let gw = S.p[5].y;
  let sw = gw * 0.3;
  let seam = smoothstep(sw + t.aa, max(sw - t.aa, 0.0), t.e) * detail;
  let near = exp(-max(t.e - gw, 0.0) * 25.0) * detail;
  let glow = 0.75;
  col *= 1.0 - 0.8 * smoothstep(gw + t.aa, gw * 0.5, t.e) * detail;
  col += hd_col(hs, 0.18) * seam * glow;
  // Kick: fire runs along the seams and heats the faces it re-forms.
  let fire = hd_fire(t.tk);
  col += heat * t.lk * fire * (seam * 1.5 + near * 0.1 + 0.14 * (1.0 - t.metal) + 0.08 * t.metal * near);
  // Snare: a cold electric burn on the seams; behind it the seams have taken the new colour.
  let ts = t.ts;
  let sh = select(0.0, exp(-ts * 6.0), ts > 0.0) * smoothstep(0.0, 0.15, ts);
  let sc = mix(hd_col(hs + 0.5, 1.0), vec3f(0.85, 0.95, 1.0), sat(sh * 1.5 - 0.6));
  col += heat * t.ls * sc * (seam * 1.6 + near * 0.12) * sh * sh;
  // Melody: the burn is in the note's colour (pitch sets both where it starts and its hue).
  // The note before burns on in its own colour where it was.
  let mh = select(0.0, exp(-t.tm * 4.5), t.tm > 0.0) * smoothstep(0.0, 0.15, t.tm);
  let mh2 = select(0.0, exp(-t.tm2 * 4.5), t.tm2 > 0.0) * smoothstep(0.0, 0.15, t.tm2);
  let shell = floor(S.p[7].y / 10.0) / 10.0;
  let r2 = floor(S.p[7].z / 200.0);
  let shell2 = (r2 - 64.0 * floor(r2 / 64.0)) / 10.0;
  let mc = mix(hd_col(h0 + 0.55 + 0.07 * shell, 1.0), vec3f(1.0, 0.95, 0.9), sat(mh * 1.5 - 0.7));
  let mc2 = mix(hd_col(h0 + 0.55 + 0.07 * shell2, 1.0), vec3f(1.0, 0.95, 0.9), sat(mh2 * 1.5 - 0.7));
  let nl = hd_noteLv();
  col += heat * (mc * mh * mh * nl.x + mc2 * mh2 * mh2 * nl.y) * (seam * 1.6 + near * 0.15 + 0.1);
  // Sub-pixel tiles: a soft average of enamel and seam light.
  col += hd_col(hs, 0.05) * glow * (1.0 - detail);
  return col;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  gA = hd_geo(S.p[0].x, S.p[0].y);
  gB = hd_geo(S.p[0].z, S.p[0].w);
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  var ro = S.p[3].xyz;
  let ta = S.p[4].xyz;
  let focal = max(0.4, hd_focal() * length(ta - ro));
  let cam = lookAt(ro, ta, S.p[3].w);
  let rd = normalize(cam * vec3f(q, focal));
  let pixA = 2.0 / (F.res.y * focal);
  let mode = hd_mode();
  let hmax = 0.12 * S.p[5].x / 0.28 + 0.02;

  var col = vec3f(0.0);
  let t0 = 0.0;
  var fogT = 0.0;
  let start = ro;
  {
    // Relief shell: linear search between the inner and outer surfaces, then bisection.
    var tA = hd_exit(start, rd, 1.0 - hmax);
    var tB = hd_exit(start, rd, 1.0);
    tA = max(tA, 0.0);
    let tMax = 7.0;
    if (tA > tMax) {
      fogT = tMax;
    } else {
      tB = min(tB, tMax + 1.0);
      var a = tA;
      var b = tB;
      var found = false;
      let N = 11;
      var prev = tA;
      for (var i = 1; i <= N; i++) {
        let tt = mix(tA, tB, f32(i) / f32(N));
        let pp = start + rd * tt;
        if (hd_radius(pp) >= 1.0 - hd_height(pp, (tt + t0) * pixA)) {
          a = prev;
          b = tt;
          found = true;
          break;
        }
        prev = tt;
      }
      if (!found) { a = prev; b = tB; }
      for (var j = 0; j < 4; j++) {
        let mt = 0.5 * (a + b);
        let pp = start + rd * mt;
        if (hd_radius(pp) >= 1.0 - hd_height(pp, (mt + t0) * pixA)) { b = mt; } else { a = mt; }
      }
      let th = 0.5 * (a + b);
      let ph = start + rd * th;
      let tw = th + t0;
      let pixW = tw * pixA;
      // Normal from three relief points.
      let base = select(normalize(ph), vec3f(normalize(ph.xy), 0.0), mode > 2.5);
      var t1: vec3f;
      var t2: vec3f;
      if (mode > 2.5) {
        t1 = vec3f(-base.y, base.x, 0.0);
        t2 = vec3f(0.0, 0.0, 1.0);
      } else {
        t1 = normalize(cross(base, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(base.y) > 0.9)));
        t2 = cross(base, t1);
      }
      let e = max(pixW * 1.5, 1e-4);
      var p0: vec3f;
      var p1: vec3f;
      var p2: vec3f;
      if (mode > 2.5) {
        let q0 = vec3f(base.xy, ph.z);
        let q1 = vec3f(normalize(base.xy + t1.xy * e), ph.z);
        let q2 = q0 + t2 * e;
        p0 = q0 - vec3f(q0.xy, 0.0) * hd_height(q0, pixW);
        p1 = q1 - vec3f(q1.xy, 0.0) * hd_height(q1, pixW);
        p2 = q2 - vec3f(q2.xy, 0.0) * hd_height(q2, pixW);
      } else {
        let q1 = normalize(base + t1 * e);
        let q2 = normalize(base + t2 * e);
        p0 = base * (1.0 - hd_height(base, pixW));
        p1 = q1 * (1.0 - hd_height(q1, pixW));
        p2 = q2 * (1.0 - hd_height(q2, pixW));
      }
      var n = normalize(cross(p1 - p0, p2 - p0));
      if (dot(n, rd) > 0.0) { n = -n; }
      let pw = pixW / max(abs(dot(n, rd)), 0.2);
      let w = S.p[2].z;
      if (w < 0.999) { col += hd_shade(hd_tileA(ph, pw), n, rd, ph) * (1.0 - w); }
      if (w > 0.001) { col += hd_shade(hd_tileB(ph, pw), n, rd, ph) * w; }
      fogT = tw;
    }
  }

  // Depth haze into a deep coloured dark.
  let fogK = select(0.22, 0.42, mode > 2.5);
  let fogC = hd_col(S.p[6].w + 0.62, 0.01);
  col = mix(fogC, col, exp(-fogT * fogK));
  // Soft shoulder so highlights roll off.
  col *= 1.0 / (1.0 + 0.6 * max(luma(col) - 0.6, 0.0));
  return vec4f(min(col, vec3f(12.0)), 1.0);
}
`,
});
