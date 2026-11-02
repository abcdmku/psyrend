import type { LookContext } from '../types';

/**
 * Critically damped follower (exact solution, so it never overshoots or goes unstable): reaches a
 * new target in about 4 / w seconds with no step.
 */
export class Follow {
  x = 0;
  private v = 0;
  private live = false;
  constructor(private readonly w: number) {}
  step(target: number, dt: number, jump = Infinity): number {
    if (!this.live || Math.abs(target - this.x) > jump) {
      // First frame or a seek: start at rest on the target instead of sweeping across.
      this.x = target;
      this.v = 0;
      this.live = true;
      return this.x;
    }
    const w = this.w;
    const e = Math.exp(-w * dt);
    const x0 = this.x - target;
    const k = (this.v + w * x0) * dt;
    this.v = (this.v - w * k) * e;
    this.x = target + (x0 + k) * e;
    return this.x;
  }
}

/**
 * The music as overlay looks may feel it: eased levels and lasting eased steps, never a pulse.
 * - `flow`: a continuous phase (about 1 per second) that runs faster with the eased energy.
 * - `energy`, `bass`, `high`, `melody` (held lead), `pitch` (lead pitch): eased levels.
 * - `kicks`, `bars`: event counters eased over about half a beat and a beat, for lasting steps.
 */
export class OverlayDrive {
  flow = 0;
  energy = 0;
  bass = 0;
  high = 0;
  melody = 0;
  pitch = 0;
  kicks = 0;
  bars = 0;
  private kickCount = 0;
  private prevKick = 0;
  private fE = new Follow(2.6);
  private fB = new Follow(4);
  private fH = new Follow(4);
  private fM = new Follow(3.5);
  private fP = new Follow(3);
  private fK = new Follow(9);
  private fBar = new Follow(5);

  update(ctx: LookContext): this {
    const m = ctx.music;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    if (m.kick > 0.5 && this.prevKick < 0.35) this.kickCount++;
    this.prevKick = m.kick;
    this.energy = this.fE.step(Math.min(1, m.energy), dt);
    this.bass = this.fB.step(Math.min(1, m.bass), dt);
    this.high = this.fH.step(Math.min(1, m.high), dt);
    this.melody = this.fM.step(Math.min(1, m.leadHeld), dt);
    this.pitch = this.fP.step(m.leadPitch, dt);
    this.kicks = this.fK.step(this.kickCount, dt, 3);
    this.bars = this.fBar.step(m.barIndex, dt, 2);
    this.flow += dt * (0.55 + 0.9 * this.energy);
    return this;
  }

  /** flow, energy, bass, melody into p[at..at+3] (one vec4 of L.p). */
  write(p: Float32Array, at = 12): void {
    p[at] = this.flow;
    p[at + 1] = this.energy;
    p[at + 2] = this.bass;
    p[at + 3] = this.melody;
  }
}

/**
 * WGSL: `ov_commit(base, o)` returns what to hand back so that, once the post chain mixes it over
 * the clean image by L.amount, the picture lands (nearly) on `o` instead of a double exposure.
 * Capped at 1.3x, so it still eases in and out with the amount at transitions.
 */
export const COMMIT_WGSL = /* wgsl */ `
fn ov_commit(base: vec3f, o: vec3f) -> vec3f {
  let k = min(1.0 / max(L.amount, 1e-3), 1.3);
  return max(base + (o - base) * k, vec3f(0.0));
}
`;
