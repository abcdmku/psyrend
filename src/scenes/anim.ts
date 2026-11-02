/**
 * Animation primitives for music-driven motion. See docs/techniques/animation.md for the rules
 * behind them. Everything here is a pure function or a tiny class that integrates by `dt`, so
 * offline renders and live playback agree.
 *
 * The four user rules map onto these helpers:
 *  - constant, fluid motion: `Spring`, `settle`, `FollowChain` (no overshoot, no jolts);
 *  - beats change things for good: `EventTrack` + `frontState` (an eased, never-undone counter);
 *  - reactions propagate through structure: `fibreArrival`, `frontState`, `frontHeat`;
 *  - every motion has a musical cause: all durations are in beats (`spb`, `beatsToHalflife`).
 */

const LN2 = Math.LN2;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------- tempo ----------

/** Seconds per beat, with the tempo clamped to a sane range. */
export const spb = (bpm: number) => 60 / Math.min(220, Math.max(50, bpm || 120));

/** A halflife (seconds) that lasts `beats` beats at this tempo. */
export const beatsToHalflife = (bpm: number, beats: number) => beats * spb(bpm);

// ---------- easing (all map [0,1] to [0,1], clamped) ----------

export const ease = {
  linear: (t: number) => clamp01(t),
  /** Hermite smoothstep: zero slope at both ends (slow-in, slow-out). */
  smooth: (t: number) => {
    const x = clamp01(t);
    return x * x * (3 - 2 * x);
  },
  /** Quintic smootherstep: zero slope and zero acceleration at both ends. */
  smoother: (t: number) => {
    const x = clamp01(t);
    return x * x * x * (x * (6 * x - 15) + 10);
  },
  /** Fast start, soft landing: the default for a state change after a hit. */
  outCubic: (t: number) => 1 - (1 - clamp01(t)) ** 3,
  /** Slow start, hard arrival: anticipation into a downbeat. */
  inCubic: (t: number) => clamp01(t) ** 3,
  /** Exponential landing, reaches ~0.999 at t = 1. */
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * clamp01(t))),
} as const;

export type Ease = (t: number) => number;

/** Progress 0..1 of a transition that started `age` seconds ago and lasts `beats` beats. */
export const easeBeats = (age: number, bpm: number, beats: number, fn: Ease = ease.outCubic) =>
  fn(age / Math.max(1e-3, beats * spb(bpm)));

// ---------- springs and settles ----------

/** Pade approximation of exp(-x) for x >= 0 (Holden), accurate to about 0.1 %. */
export const fastNegExp = (x: number) => 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

/**
 * First-order settle toward `goal`: the distance halves every `halflife` seconds. Frame-rate
 * independent, never overshoots, and has a velocity jump at the start (use `Spring` when the
 * start must be smooth too).
 */
export const settle = (x: number, goal: number, halflife: number, dt: number) =>
  goal + (x - goal) * 2 ** (-dt / Math.max(1e-4, halflife));

/**
 * Critically damped spring, solved exactly per step (after Daniel Holden's "Spring-It-On").
 * The fastest approach to the goal with no overshoot, and position and velocity both stay
 * continuous when the goal jumps: a step in the goal becomes a smooth S-curve.
 * `halflife` is the time for the remaining distance to roughly halve.
 */
export class Spring {
  v = 0;
  constructor(
    public x = 0,
    public halflife = 0.25,
  ) {}

  update(goal: number, dt: number, goalVelocity = 0): number {
    const y = (2 * LN2) / Math.max(1e-4, this.halflife);
    // Aim at the point the moving goal is heading for, so a moving goal is followed without lag.
    const c = goal + goalVelocity / y;
    const j0 = this.x - c;
    const j1 = this.v + j0 * y;
    const e = fastNegExp(y * dt);
    this.x = e * (j0 + j1 * dt) + c;
    this.v = e * (this.v - j1 * y * dt);
    return this.x;
  }

  /** Jumps to `x` at rest (new cue or seek). */
  reset(x: number): void {
    this.x = x;
    this.v = 0;
  }
}

/**
 * Overlapping action / follow-through: a chain of springs, each following the one before with a
 * longer halflife. Link 0 leads, the last link drags. Use the links for parts of one structure
 * (near and far layers, inner and outer bands) so a change arrives at each part in turn.
 */
export class FollowChain {
  readonly links: Spring[];
  constructor(n: number, x0: number, halflife: number, growth = 1.6) {
    this.links = Array.from({ length: n }, (_, i) => new Spring(x0, halflife * growth ** i));
  }

  update(goal: number, dt: number): void {
    let g = goal;
    for (const s of this.links) g = s.update(g, dt);
  }

  at(i: number): number {
    return this.links[i].x;
  }

  reset(x: number): void {
    for (const s of this.links) s.reset(x);
  }
}

/** Per-element start delay (fraction of the move) for overlapping action across `n` parts. */
export const overlapDelay = (i: number, n: number, spread = 0.5) => (n > 1 ? (i / (n - 1)) * spread : 0);

// ---------- events and lasting change ----------

/**
 * Tracks one kind of musical event: its count and the ages of the latest two hits. Feed it the
 * event count from `Morph` (`morph.kicks`, `snares`, `notes`) or a rising-edge boolean. The two
 * ages let a shader carry a front that is still travelling when the next hit lands (`frontState`).
 */
export class EventTrack {
  count = 0;
  age = 99;
  prevAge = 99;
  private last = -1;

  /** `countOrFired`: a monotonic event count, or `true` on the frame an event fires. */
  update(countOrFired: number | boolean, dt: number): this {
    this.age += dt;
    this.prevAge += dt;
    const fired = typeof countOrFired === 'boolean' ? countOrFired : countOrFired > this.last && this.last >= 0;
    if (typeof countOrFired === 'number') {
      if (countOrFired < this.last) this.reset();
      this.last = countOrFired;
    }
    if (fired) {
      this.prevAge = this.age;
      this.age = 0;
      this.count++;
    }
    return this;
  }

  reset(): void {
    this.count = 0;
    this.age = this.prevAge = 99;
  }
}

/**
 * Arrival time at a point of a front that travels along fibres (streamlines, veins, ribbon
 * length) fast and hops across them slowly. `along` is the distance along the fibre from the
 * ignition point, `across` the number of fibres crossed, `jitter` a per-fibre hash in [0,1) so
 * each fibre burns at its own speed: the front comes out ragged and fibrous, never a clean shell.
 * Units are whatever the caller uses (seconds or beats).
 */
export const fibreArrival = (along: number, across: number, jitter: number, vAlong: number, hop: number) =>
  (Math.abs(along) / vAlong) * (0.65 + 0.7 * jitter) + Math.abs(across) * hop * (0.6 + 0.8 * jitter);

/**
 * The lasting state at a point after `count` events. The latest front arrives here at time `T` and
 * started `age` ago; the one before arrives at `prevT` (from its own origin) and started `prevAge`
 * ago. Each passing front adds 1, eased in over `easeIn`, and is never taken back. Equal to `count`
 * once both have passed. Each front must finish within two event intervals (compress T if needed).
 */
export const frontState = (count: number, age: number, T: number, prevAge: number, prevT: number, easeIn: number) =>
  Math.max(count - 2, 0) +
  (count >= 2 ? ease.smooth((prevAge - prevT) / easeIn) : 0) +
  (count >= 1 ? ease.smooth((age - T) / easeIn) : 0);

/**
 * Heat of a front at a point: 0 before it arrives, a hot leading edge `edge` wide, then embers
 * cooling with time constant `ember`. Light only: pair it with `frontState` for the lasting change.
 */
export const frontHeat = (age: number, T: number, edge: number, ember: number) => {
  const e = age - T;
  if (e < -edge) return 0;
  const rise = ease.smooth((e + edge) / edge);
  return rise * Math.exp(-Math.max(e, 0) / ember);
};

// ---------- phrase structure ----------

export interface PhraseArc {
  /** Index of the phrase (bars / phraseBars), monotonic within a song. */
  index: number;
  /** Position 0..1 through the phrase. */
  pos: number;
  /** Tension 0..1: rises slowly (ease-in) through the phrase, highest just before its downbeat. */
  tension: number;
  /** Release 0..1: 1 on the phrase downbeat, decaying over about one bar. */
  release: number;
}

/**
 * Where we are in the phrase. Musical phrases in pop and dance music are 4 or 8 bars; tension
 * builds through one and lands on the next downbeat. `anticipation` (0..1, from MusicState)
 * raises tension further ahead of a drop.
 */
export function phraseArc(barIndex: number, barPhase: number, phraseBars = 8, anticipation = 0): PhraseArc {
  const bars = Math.max(0, barIndex) + clamp01(barPhase);
  const index = Math.floor(bars / phraseBars);
  const pos = bars / phraseBars - index;
  const tension = clamp01(ease.inCubic(pos) * 0.8 + 0.2 * pos + anticipation * 0.6);
  const release = Math.exp(-(pos * phraseBars) / 0.6);
  return { index, pos, tension, release };
}

// ---------- WGSL counterparts ----------

/**
 * The shader halves of the helpers above. Paste into a scene's WGSL with `${ANIM_WGSL}`.
 *  - anim_ease(t): smoothstep on a clamped t.
 *  - anim_frontState(count, age, T, prevAge, prevT, easeIn): the lasting state behind two fronts.
 *  - anim_frontHeat(age, T, edge, ember): hot edge plus cooling embers.
 *  - anim_fibreArrival(along, across, jitter, vAlong, hop): ragged arrival time along fibres.
 */
export const ANIM_WGSL = /* wgsl */ `
fn anim_ease(t: f32) -> f32 { let x = clamp(t, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
fn anim_frontState(count: f32, age: f32, T: f32, prevAge: f32, prevT: f32, easeIn: f32) -> f32 {
  let a = anim_ease((prevAge - prevT) / easeIn) * step(1.5, count);
  let b = anim_ease((age - T) / easeIn) * step(0.5, count);
  return max(count - 2.0, 0.0) + a + b;
}
fn anim_frontHeat(age: f32, T: f32, edge: f32, ember: f32) -> f32 {
  let e = age - T;
  return anim_ease((e + edge) / edge) * exp(-max(e, 0.0) / ember);
}
fn anim_fibreArrival(along: f32, across: f32, jitter: f32, vAlong: f32, hop: f32) -> f32 {
  return abs(along) / vAlong * (0.65 + 0.7 * jitter) + abs(across) * hop * (0.6 + 0.8 * jitter);
}
`;
