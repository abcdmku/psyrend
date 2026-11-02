import type { MusicState } from '../audio/musicState';

/**
 * Moves a form through its parameter space with the music, so the shape itself keeps transforming
 * instead of a fixed shape pulsing. A family maps the coordinates with periodic functions, so the
 * journey never runs out and never comes back to the same place.
 *
 * Motion is fluid and never stops, and it carries the music's weight: loudness and bass drive the
 * flow rate (a wobble or sub swell rushes it forward, a drop launches a surge that eases off over
 * several bars), and it only eases right down after a long stretch of little sound. Every phrase
 * carries the form to a completely different region of its shape space. Beats never push the shape out and back: each kick and snare moves it to a new state for
 * good, eased in over a fraction of a beat (the kick along the heading, the snare across it), so the
 * structure keeps becoming something new. Scenes carry each change through the structure as light,
 * colour and detail, using the event ages and the eased phases below.
 * - Each melody note turns the heading, and the motion bends smoothly onto it (about a second), so
 *   a phrase draws a curve through shape space.
 * - Each chord sets a region the shape drifts toward (over a couple of seconds).
 * - A new cue (new DNA) starts at a fresh point, so every appearance is a new shape.
 */
export class Morph {
  static readonly DIMS = 8;
  /** Current coordinates (unbounded; read with periodic functions). */
  readonly at = new Float64Array(Morph.DIMS);
  /**
   * The same coordinates without the beat steps (flow and chord lean only). Scenes that sweep each
   * beat's change through space as a front use this as the base and apply their own swept steps.
   */
  readonly flowAt = new Float64Array(Morph.DIMS);
  private readonly pos = new Float64Array(Morph.DIMS);
  private readonly dir = new Float64Array(Morph.DIMS);
  private readonly heading = new Float64Array(Morph.DIMS);
  private readonly harm = new Float64Array(Morph.DIMS);
  private readonly harmTarget = new Float64Array(Morph.DIMS);
  private readonly step = new Float64Array(Morph.DIMS);
  private readonly stepTarget = new Float64Array(Morph.DIMS);
  private readonly side = new Float64Array(Morph.DIMS);
  private readonly jump = new Float64Array(Morph.DIMS);
  private readonly jumpVel = new Float64Array(Morph.DIMS);
  private readonly stepVel = new Float64Array(Morph.DIMS);
  private readonly phaseVel = new Float64Array(3);
  private readonly jumpTarget = new Float64Array(Morph.DIMS);
  private phraseKey = -1;
  private drop = 0;
  /** The drop envelope (jumps to 1 at a drop); `surge` swells toward it so the rush builds smoothly. */
  private surgeEnv = 0;
  private phaseTarget = [0, 0, 0];
  private seed = -1;
  private t = -1;
  private k = 0;
  private s = 0;
  private l = 0;
  private pitch = 0;
  private chordIndex = -2;
  private activity = 0;
  /** Seconds since the last kick / snare / melody note: drive ripples, glows and colour with these. */
  kickAge = 9;
  snareAge = 9;
  leadAge = 9;
  /** Counts of kicks / snares / melody notes this cue (to vary where each ripple starts). */
  kicks = 0;
  snares = 0;
  notes = 0;
  /**
   * Eased counts of kicks / snares / melody notes: each event adds 1, eased in over a fraction of a
   * beat. Use them for lasting changes (hue steps, detail levels, pattern phases), never for pulses.
   */
  kickPhase = 0;
  snarePhase = 0;
  notePhase = 0;
  /** Exact pitch of the latest melody note, -1..1 (no glide, so it is right at the attack). */
  notePitch = 0;
  /**
   * 0..1 strength of the latest kick / snare / melody note. Event steps and phases are already
   * scaled by it; scenes should scale their own event reactions by it too, so a faint hit gives a
   * faint change and a hard one a full change (no on/off threshold).
   */
  kickLevel = 0;
  snareLevel = 0;
  noteLevel = 0;
  /**
   * 0.15..1 how loud the current passage is (energy over the last few seconds). Every event level is
   * already scaled by it: the envelopes are normalised per song, so without it a faint motif in a
   * quiet intro would reshape the world as much as the lead in a drop. Quiet passages ripple; loud
   * ones restructure.
   */
  presence = 1;
  private loud = 0.5;

  // ----- Detail: the fine scale, driven by the high frequencies -----
  // Low sound (bass, low melody) moves the large structure through `at`. The high end moves the
  // FINE structure through `detailAt`: high melodies and arpeggios, the backing harmony, hats and
  // the air of the mix. Map these coordinates onto the world's finest structure (deep fractal
  // levels and offsets, high-octave warps, fine line spacing, micro-shape and facet parameters), so
  // the high end reworks the detail itself rather than adding a layer on top.
  /** Four unbounded fine-scale coordinates (read with periodic functions, like `at`). */
  readonly detailAt = new Float64Array(4);
  /** 0..1 how much high-frequency material is sounding (air, upper voice, backing, hats). */
  detailDrive = 0;
  /** Upper voice (high melody / arps): seconds since its last note, count, strength, pitch 0..1. */
  upperAge = 9;
  uppers = 0;
  upperLevel = 0;
  upperNote = 0.5;
  /** Backing harmony (pads, chord voices): seconds since its last note and that note's strength. */
  backingAge = 9;
  backingLevel = 0;
  /** Eased counts of upper notes / backing notes / hats (scaled by strength): lasting fine changes. */
  upperPhase = 0;
  backingPhase = 0;
  hatPhase = 0;
  private readonly dPos = new Float64Array(4);
  private readonly dDir = new Float64Array(4);
  private readonly dStep = new Float64Array(4);
  private readonly dStepTarget = new Float64Array(4);
  private readonly dStepVel = new Float64Array(4);
  private readonly dPhaseTarget = [0, 0, 0];
  private readonly dPhaseVel = new Float64Array(3);
  private u = 0;

  // ----- Camera: framing as another degree of freedom (for worlds with a camera) -----
  /**
   * Smoothly gliding camera framing. On each phrase (4 bars) the framing moves to a new target,
   * gliding over about two bars on springs; a drop widens the lens with the rush.
   *  fov: multiplier on the world's own field of view (0.6 telephoto .. 1.7 wide);
   *  pitch, yaw, roll: extra rotations in radians (small: about +-0.35, +-0.5, +-0.4);
   *  height: an offset in the world's own units (scale it to the world, about -1..1).
   * Apply them to the camera so 3D worlds explore perspective, not one fixed lens and angle.
   */
  readonly cam = { fov: 1, pitch: 0, yaw: 0, roll: 0, height: 0 };
  private readonly camTarget = [1, 0, 0, 0, 0];
  private readonly camVel = new Float64Array(5);
  private camState = [1, 0, 0, 0, 0];
  private bk = 0;
  private hh = 0;
  /** 0..1: how fully the world is flowing (1 while there is music, easing down in long quiet). */
  flow = 0;
  /**
   * 0..1 drive of the music's weight right now: loudness and bass, following the bass contour
   * (attack ~200 ms, release ~450 ms: a rush that builds, never a jolt), so a riddim wobble or a sub swell rushes the flow forward.
   */
  drive = 0;
  /** 0..1 after a drop: jumps to 1 when it lands and eases off over several bars. */
  surge = 0;
  /** Phrases (8 bars, or a new section) this cue; each one carries the form somewhere new. */
  phrases = 0;
  /** Seconds since the current phrase began. */
  phraseAge = 0;
  /** Current speed through shape space. */
  speed = 0;
  /** Integrated forward travel at the same steady pace (for cameras). Monotonic within a cue. */
  travel = 0;

  /**
   * The world's pace (song intensity times its calibration, see motionGain.ts), set by the renderer
   * before each world's update. The world's dt is already scaled by it; beat steps also shrink with
   * it, since a step moves a fixed distance however fast the clock runs, so calm songs react gently.
   */
  static pace = 1;

  /** Camera framing value j (fov, pitch, yaw, roll, height) for a phrase of this cue. */
  private camPick(j: number, key: number): number {
    const h = fract(Math.sin((key * 0.731 + j * 11.3 + this.seed * 5.9) * 2.3) * 24634.6345);
    const lo = [Math.log(0.6), -0.35, -0.5, -0.4, -1][j];
    const hi = [Math.log(1.7), 0.35, 0.5, 0.4, 1][j];
    const v = lo + (hi - lo) * h;
    return j === 0 ? Math.exp(v) : v;
  }

  /** `scale` sets how fast and far the shape moves (1 = default); `dims` limits the used dimensions. */
  constructor(
    private readonly scale = 1,
    private readonly dims = Morph.DIMS,
  ) {}

  update(m: MusicState, dtIn: number, dna: readonly number[]): void {
    const dt = Math.min(Math.max(dtIn, 0), 0.1);
    const seek = Math.abs(m.time - this.t - dt) > 0.5;
    this.t = m.time;
    const n = this.dims;
    // A new cue (new DNA) starts everything afresh. A seek re-places the form but keeps the event
    // counts, phases and travel running, so worlds that track them never see them jump backward.
    const fresh = dna[0] !== this.seed;
    if (fresh || seek) {
      // A fresh point in shape space, from the cue's DNA and the song position (deterministic, so
      // offline renders and seeks agree), heading in a DNA direction.
      this.seed = dna[0];
      for (let i = 0; i < n; i++) {
        const g = dna[(i + 1) % dna.length];
        this.pos[i] = (g * 7.31 + dna[0] * (i + 1) * 3.17) * Math.PI * 2 + m.time * 0.04 * Math.sin(i * 2.1 + dna[0] * 9);
        this.dir[i] = this.heading[i] = Math.sin(i * 1.7 + dna[0] * 23.1 + g * 5);
        this.harm[i] = this.harmTarget[i] = 0;
        this.step[i] = this.stepTarget[i] = 0;
        this.side[i] = Math.cos(i * 2.3 + dna[0] * 11);
      }
      normalize(this.side, n);
      if (fresh) this.kickPhase = this.snarePhase = this.notePhase = 0;
      for (let i = 0; i < 4; i++) {
        this.dPos[i] = (dna[(i + 5) % dna.length] * 5.3 + dna[0] * (i + 2) * 2.7) * Math.PI * 2;
        this.dDir[i] = Math.cos(i * 2.9 + dna[0] * 17.3);
        this.dStep[i] = this.dStepTarget[i] = this.dStepVel[i] = 0;
      }
      normalize(this.dDir, 4);
      if (fresh) {
        this.upperPhase = this.backingPhase = this.hatPhase = 0;
        this.dPhaseTarget.fill(0);
        this.uppers = 0;
      } else {
        this.dPhaseTarget[0] = this.upperPhase;
        this.dPhaseTarget[1] = this.backingPhase;
        this.dPhaseTarget[2] = this.hatPhase;
      }
      this.dPhaseVel.fill(0);
      this.upperAge = this.backingAge = 9;
      this.u = m.upper;
      this.bk = m.backing;
      this.hh = m.hat;
      this.detailDrive = 1 - Math.exp(-1.6 * (0.5 * m.high + 0.4 * m.upperHeld + 0.3 * m.backingHeld));
      this.phaseVel.fill(0);
      this.stepVel.fill(0);
      this.jumpVel.fill(0);
      this.phaseTarget = fresh ? [0, 0, 0] : [this.kickPhase, this.snarePhase, this.notePhase];
      normalize(this.dir, n);
      normalize(this.heading, n);
      this.kickAge = this.snareAge = this.leadAge = 9;
      if (fresh) this.kicks = this.snares = this.notes = 0;
      this.k = m.kick;
      this.s = m.snare;
      this.l = m.lead;
      this.pitch = this.notePitch = m.leadNote;
      this.chordIndex = m.chordIndex;
      this.activity = Math.max(m.energySlow, m.energy);
      this.loud = m.energySlow;
      if (fresh) this.travel = m.time * 0.1;
      this.jump.fill(0);
      this.jumpTarget.fill(0);
      this.phraseKey = phraseKey(m);
      if (fresh) this.phrases = 0;
      // The framing starts where this phrase of the song puts it (not a shared neutral view), so
      // every cue opens on its own perspective and offline stills and seeks agree with playback.
      for (let j = 0; j < 5; j++) this.camTarget[j] = this.camPick(j, this.phraseKey);
      this.camState = this.camTarget.slice(0, 5);
      this.camVel.fill(0);
      this.phraseAge = 0;
      this.drive = Math.min(1, 0.55 * m.energy + 0.7 * m.bass);
      this.drop = m.dropPulse;
      this.surge = this.surgeEnv = m.dropPulse;
      this.retarget(m);
      for (let i = 0; i < n; i++) this.harm[i] = this.harmTarget[i];
    }

    const stepK = Math.min(1.4, Math.max(0.5, Morph.pace)) ** 0.8;
    this.loud += (m.energySlow - this.loud) * (1 - Math.exp(-dt / 3));
    this.presence = 0.15 + 0.85 * smoothstep(0.25, 0.62, this.loud);
    const pr = this.presence;
    // Melody: each note turns the heading; the pitch class picks the plane, the interval the angle.
    if (m.lead > this.l + 0.02) {
      this.noteLevel = pr * level((m.lead - 0.4) / 0.6);
      const iv = (m.leadNote - this.pitch) * 12;
      const pc = Math.round((m.leadNote * 12 + 1200) % 12);
      const a = pc % n;
      const b = (a + 1 + ((pc * 5) % (n - 1))) % n;
      // A faint note only nudges the heading; a strong one turns it fully.
      const ang = Math.sign(iv || 1) * Math.min(1.0, 0.2 + Math.abs(iv) * 0.08) * (0.3 + 0.7 * this.noteLevel);
      rotate(this.heading, a, b, ang);
      // The snare steps across the plane the melody last turned in.
      this.side.fill(0);
      this.side[a] = -Math.sin(ang);
      this.side[b] = Math.cos(ang);
      this.phaseTarget[2] += this.noteLevel;
      this.pitch = this.notePitch = m.leadNote;
      this.leadAge = 0;
      this.notes++;
    } else this.leadAge += dt;
    if (m.kick > this.k + 0.015) {
      this.kickLevel = pr * level(m.kick);
      this.kickAge = 0;
      this.kicks++;
      this.phaseTarget[0] += this.kickLevel;
      for (let i = 0; i < n; i++) this.stepTarget[i] += this.dir[i] * this.scale * stepK * (0.1 + 0.12 * m.energy) * this.kickLevel;
    } else this.kickAge += dt;
    if (m.snare > this.s + 0.015) {
      this.snareLevel = pr * level(m.snare);
      this.snareAge = 0;
      this.snares++;
      this.phaseTarget[1] += this.snareLevel;
      for (let i = 0; i < n; i++) this.stepTarget[i] += this.side[i] * this.scale * stepK * (0.08 + 0.1 * m.energy) * this.snareLevel;
    } else this.snareAge += dt;
    this.k = m.kick;
    this.s = m.snare;
    this.l = m.lead;
    // Fine scale: high notes steer and step the detail; backing chords and hats step it gently.
    if (m.upper > this.u + 0.02) {
      this.upperLevel = pr * level((m.upper - 0.4) / 0.6);
      this.upperNote = m.upperPitch;
      const pc = Math.round(m.upperPitch * 48) % 12;
      rotate(this.dDir, pc % 4, (pc + 1 + (pc % 3)) % 4, (0.25 + 0.5 * m.upperPitch) * (pc % 2 ? 1 : -1) * (0.3 + 0.7 * this.upperLevel));
      for (let i = 0; i < 4; i++) this.dStepTarget[i] += this.dDir[i] * 0.5 * this.scale * stepK * this.upperLevel;
      this.dPhaseTarget[0] += this.upperLevel;
      this.upperAge = 0;
      this.uppers++;
    } else this.upperAge += dt;
    if (m.backing > this.bk + 0.02) {
      this.backingLevel = pr * level((m.backing - 0.4) / 0.6);
      this.dStepTarget[2] += 0.35 * this.scale * stepK * this.backingLevel * (this.backingPhase % 2 < 1 ? 1 : -1);
      this.dPhaseTarget[1] += this.backingLevel;
      this.backingAge = 0;
    } else this.backingAge += dt;
    if (m.hat > this.hh + 0.02) {
      const hl = pr * level(m.hat);
      this.dStepTarget[3] += 0.12 * this.scale * stepK * hl;
      this.dPhaseTarget[2] += hl;
    }
    this.u = m.upper;
    this.bk = m.backing;
    this.hh = m.hat;
    const air = 1 - Math.exp(-1.6 * (0.5 * m.high + 0.4 * m.upperHeld + 0.3 * m.backingHeld + 0.15 * m.hat));
    this.detailDrive += (air - this.detailDrive) * (1 - Math.exp(-dt / (air > this.detailDrive ? 0.15 : 0.5)));

    if (m.chordIndex !== this.chordIndex) {
      this.chordIndex = m.chordIndex;
      this.retarget(m);
    }

    // On the phrase grid the form moves to new shapes, eased in over about a bar: every 8 bars (and
    // every new section) to a completely different region of its shape space, and at each 4-bar
    // mark in between a smaller reshape, so something new arrives every few bars.
    const key = phraseKey(m);
    if (key !== this.phraseKey) {
      const big = Math.floor(key / 2) !== Math.floor(this.phraseKey / 2) || Math.floor(key / 1000) !== Math.floor(this.phraseKey / 1000);
      this.phraseKey = key;
      this.phrases++;
      this.phraseAge = 0;
      const size = big ? 1 : 0.4;
      // A new framing target for the camera: big phrases can change it a lot, small ones a little.
      for (let j = 0; j < 5; j++) this.camTarget[j] += (this.camPick(j, key) - this.camTarget[j]) * (big ? 1 : 0.45);
      for (let i = 0; i < n; i++) {
        const h = fract(Math.sin((this.phrases * 12.9898 + i * 78.233 + this.seed * 37.719) * 1.7) * 43758.5453);
        this.jumpTarget[i] += size * (h < 0.5 ? -1 : 1) * Math.PI * (0.55 + 0.8 * fract(h * 7.31));
      }
    } else this.phraseAge += dt;

    // Weight: loudness and bass drive the flow rate (rates, never positions, so nothing jolts back).
    // A soft ceiling (no hard clip), so the drive keeps responding all the way up.
    const weight = 1 - Math.exp(-1.4 * (0.55 * m.energy + 0.7 * m.bass + 0.25 * m.sub));
    this.drive += (weight - this.drive) * (1 - Math.exp(-dt / (weight > this.drive ? 0.2 : 0.45)));
    if (m.dropPulse > this.drop + 0.3) this.surgeEnv = 1;
    this.drop = m.dropPulse;
    this.surgeEnv *= Math.exp(-dt / 6);
    this.surge += (this.surgeEnv - this.surge) * (1 - Math.exp(-dt / (this.surgeEnv > this.surge ? 0.3 : 0.5)));

    // Activity rises in about a second and falls over about ten, so only long quiet slows the flow.
    const loud = Math.max(m.energy, m.energySlow);
    this.activity += (loud - this.activity) * (1 - Math.exp(-dt / (loud > this.activity ? 1 : 10)));
    // A gentle curve over the whole range: responsive from the first quiet sound, still rising when loud.
    this.flow = 0.3 + (0.7 * (1 - Math.exp(-this.activity / 0.3))) / (1 - Math.exp(-1 / 0.3));
    // A drop roughly triples the pace at first, even out of an already loud section.
    const rush = 1 + 2.2 * this.surge;
    this.speed = this.scale * (0.05 * this.flow + 0.32 * this.drive) * rush;
    this.travel += dt * (0.12 * this.flow + 0.55 * this.drive) * rush;

    // Steps glide in on a critically damped spring: they start from rest, settle over about two
    // thirds of a beat and never overshoot, so a beat is a smooth change of state, never a snap.
    const beat = 60 / Math.max(40, m.bpm);
    const wStep = 6 / Math.max(0.3, beat * 1.3);
    this.kickPhase = spring(this.kickPhase, this.phaseTarget[0], this.phaseVel, 0, wStep, dt);
    this.snarePhase = spring(this.snarePhase, this.phaseTarget[1], this.phaseVel, 1, wStep, dt);
    this.notePhase = spring(this.notePhase, this.phaseTarget[2], this.phaseVel, 2, wStep, dt);
    // Phrase jumps glide over about a bar.
    const wJump = 5 / Math.max(0.8, beat * Math.max(1, m.beatsPerBar));
    const bend = 1 - Math.exp(-dt / 1.1);
    const ease = 1 - Math.exp(-dt / 2.2);
    for (let i = 0; i < n; i++) this.dir[i] += (this.heading[i] - this.dir[i]) * bend;
    normalize(this.dir, n);
    for (let i = 0; i < n; i++) {
      this.pos[i] += this.dir[i] * this.speed * dt;
      this.harm[i] += (this.harmTarget[i] - this.harm[i]) * ease;
      this.step[i] = spring(this.step[i], this.stepTarget[i], this.stepVel, i, wStep, dt);
      this.jump[i] = spring(this.jump[i], this.jumpTarget[i], this.jumpVel, i, wJump, dt);
      this.flowAt[i] = this.pos[i] + this.harm[i] + this.jump[i];
      this.at[i] = this.flowAt[i] + this.step[i];
    }
    // The detail flows with the high end (and the drop's rush), steps glide on springs, and phrase
    // jumps carry it somewhere new along with the large structure.
    const dSpeed = this.scale * (0.03 * this.flow + 0.45 * this.detailDrive) * rush;
    const wFine = wStep * 1.2;
    this.upperPhase = spring(this.upperPhase, this.dPhaseTarget[0], this.dPhaseVel, 0, wFine, dt);
    this.backingPhase = spring(this.backingPhase, this.dPhaseTarget[1], this.dPhaseVel, 1, wStep, dt);
    this.hatPhase = spring(this.hatPhase, this.dPhaseTarget[2], this.dPhaseVel, 2, wFine, dt);
    for (let i = 0; i < 4; i++) {
      this.dPos[i] += this.dDir[i] * dSpeed * dt;
      this.dStep[i] = spring(this.dStep[i], this.dStepTarget[i], this.dStepVel, i, wFine, dt);
      this.detailAt[i] = this.dPos[i] + this.dStep[i] + 0.7 * this.jump[(i + 4) % n];
    }
    // The camera glides to its phrase target over about two bars; a drop widens the lens.
    const wCam = 4 / Math.max(1, beat * Math.max(1, m.beatsPerBar) * 2);
    for (let j = 0; j < 5; j++) this.camState[j] = spring(this.camState[j], this.camTarget[j], this.camVel, j, wCam, dt);
    this.cam.fov = this.camState[0] * (1 + 0.25 * this.surge);
    this.cam.pitch = this.camState[1];
    this.cam.yaw = this.camState[2];
    this.cam.roll = this.camState[3];
    this.cam.height = this.camState[4];
  }

  /** Chords set where in shape space the form leans: root around a circle, quality and tension apart. */
  private retarget(m: MusicState): void {
    const n = this.dims;
    const c = m.chord;
    if (!c || c.root < 0) {
      this.harmTarget.fill(0);
      return;
    }
    const a = (((c.root * 7) % 12) / 12) * Math.PI * 2;
    const q = c.quality.length * 0.37 + (c.quality.charCodeAt(0) % 7) * 0.21;
    for (let i = 0; i < n; i++) this.harmTarget[i] = 0.4 * this.scale * Math.sin(a + i * 1.9 + q * (i % 3)) * (0.6 + 0.8 * c.tension);
  }
}

const fract = (x: number) => x - Math.floor(x);
/** Event strength (0..1 onset strength) to a reaction level: rises smoothly from 0, never a threshold. */
const level = (strength: number) => 1 - Math.exp(-3 * Math.max(0, strength));

/** One step of a critically damped spring toward `target` (exact for any dt; vel[i] is its velocity). */
function spring(x: number, target: number, vel: Float64Array, i: number, w: number, dt: number): number {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const v = vel[i];
  const c = v + w * d;
  vel[i] = (v - w * c * dt) * e;
  return target + (d + c * dt) * e;
}
/** Phrase identity: the section, and the 4-bar phrase within the song (pairs make 8-bar phrases). */
const phraseKey = (m: MusicState) => m.sectionIndex * 1000 + Math.floor(Math.max(0, m.barIndex) / 4);

function normalize(v: Float64Array, n: number): void {
  let s = 0;
  for (let i = 0; i < n; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < n; i++) v[i] /= s;
}

function rotate(v: Float64Array, a: number, b: number, ang: number): void {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const x = v[a];
  const y = v[b];
  v[a] = c * x - s * y;
  v[b] = s * x + c * y;
}

/** Maps an unbounded coordinate to [lo, hi] smoothly and periodically. */
export const wave = (x: number, lo: number, hi: number) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(x));

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
