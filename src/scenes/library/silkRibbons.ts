import { compileModule } from '../../gpu/context';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { lookAtPerspective } from '../math';
import { Morph, wave } from '../morph';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Silk Ribbons: translucent, iridescent silk ribbons and veils unfurling and folding through deep
 * space around the viewer.
 *
 * Each ribbon is laid down by an invisible emitter that flies the way a ribbon really bends: it
 * pitches about its own width and banks (twists) to turn, so the silk forms developable folds and
 * S-curves. The ribbons circulate round the viewer, who sits in the eye of the swirl (silk is kept
 * beyond a clear sphere) turning slowly to look round it; some ribbons also spiral round the line of
 * sight, and the aim eases toward where the silk is so the frame stays composed. Everything is drawn
 * through a smooth space warp whose phases travel with the morph, so the laid silk keeps billowing.
 *
 * The music:
 *  - morph: the warp, loop tightness, twist, circulation radii and heights, the cross-section fold
 *    and the pleats all travel with `Morph`, so the shapes always flow and re-fold; kicks and snares
 *    step them for good, chords lean them.
 *  - melody: one or two ribbons' heads are steered in front of the viewer, rising and falling with
 *    the smoothed pitch, so the contour is drawn as new silk; each note dyes the newest silk in view
 *    in its pitch colour, the dye spreading back along the ribbon from where it unfurls.
 *  - kick: ignites burn fronts at visible points on up to four ribbons; each runs both ways along the
 *    silk at a speed set by the silk itself (slower through tight folds), jumps to other ribbons
 *    where they pass close, throws embers, and leaves the silk a new shade and film colour for good.
 *  - snare: a fast glint front that carries a new cross-section fold and new fine pleats down the
 *    silk, re-tuning its film, throwing glints.
 *  - drop: every ribbon is set alight at once.
 *  - spectrum: new silk records the timbre it was born in (centroid sets its film thickness, highs
 *    its shimmer); the smoothed spectrum shapes the film across the ribbons' width, highs and mids
 *    the iridescence and sheen; head dust is emitted at the flux rate, coloured by the centroid (or
 *    the pitch on melody heads).
 *
 * Rendering: ribbons are triangle grids built in the vertex shader from Catmull-Rom sample chains,
 * shaded as anisotropic thin-film silk and composited with weighted blended order-independent
 * transparency at 4x MSAA; sparks are additive streaks from a GPU particle pool.
 */

const META: SceneMeta = {
  id: 'silk-ribbons',
  name: 'Silk Ribbons',
  energy: [0, 1],
  mood: { valence: 0.6, arousal: 0.45 },
  genres: { ambient: 1, classical: 0.9, pop: 0.8, synthwave: 0.8, edm: 0.8, lofi: 0.8, jazz: 0.7, acoustic: 0.7, techno: 0.6, hiphop: 0.6, dnb: 0.5, dubstep: 0.5, rock: 0.5 },
  trails: 0,
  kaleido: false,
};

const TAU = Math.PI * 2;
const MAX_RIB = 9;
/** Logical samples per ribbon: the emitter (head) plus RING stored samples. */
const L = 512;
const RING = L - 1;
const SUB = 3;
const NC = 13;
const GPU_STRIDE = 24;
const CPU_STRIDE = 28;
/** Silk laid per stored sample (world units). */
const DS = 0.055;
const NP = 32768;
const MAX_REC = 96;
const REC_F = 20;
/** Offsets of the three propagating processes (prev, next, arrival time) in a sample. */
const POFF = [8, 12, 16];
const EVOFF = 20;
/** Strength (0..1) of the note whose dye front last reached a sample, so its glow keeps that note's strength. */
const LVOFF = 24;
/** How long each process eases its state in once its front arrives, and the shader's delay before it starts (s). */
const EASE = [0.4, 0.45, 0.4];
const EASE_DELAY = [0.05, 0.03, 0.025];
/** The viewer sits in the eye of the swirl: silk is kept beyond KEEP and within OUTER of it. */
const KEEP = 2.5;
const OUTER = 5.6;
const V_EMIT = 0.55;
const FADE_LEN = 1.2;

const fract = (x: number) => x - Math.floor(x);
const hash = (n: number) => fract(Math.sin(n * 12.9898 + 4.1414) * 43758.5453);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** One step of a critically damped spring toward `target`: starts from rest, settles in about 5/w s, never overshoots. */
/** A swell that rises from rest, peaks at age tau and settles back: 0 at age 0, 1 at its peak. */
const swell = (age: number, tau: number) => {
  const x = Math.max(0, age) / tau;
  return x * x * Math.exp(2 * (1 - x));
};
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}

type V3 = [number, number, number];
const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

interface Rec {
  p0: V3;
  p1: V3;
  count: number;
  /** 0 hot ember, 1 palette, 2 glint (palette toward white). */
  mode: number;
  t: number;
  lum: number;
  life: number;
  vel: V3;
  size: number;
  spread: number;
  both: number;
  rot: number;
}

class Ribbon {
  readonly ring = new Float32Array(RING * CPU_STRIDE);
  stored = 0;
  /** Serial of the newest stored sample. */
  serial = 0;
  P = v3();
  D = v3(1, 0, 0);
  W = v3(0, 1, 0);
  dist = 0;
  hue = 0;
  halfWidth = 0.2;
  alpha = 0.6;
  seed = 0;
  curl = 1;
  twist = 0;
  melody = false;
  dust = 0;
  axis = v3(0, 1, 0);
  spin = 1;
  sweep = 1;
  /** Hue turn of this ribbon's colours (radians), so ribbons differ in hue whatever the palette. */
  rot = 0;
  readonly lastEv = [0, 0, 0];

  constructor(readonly index: number) {}

  valid(s: number): boolean {
    return s <= this.serial && s > this.serial - this.stored && s > 0;
  }
  base(s: number): number {
    return (s % RING) * CPU_STRIDE;
  }
}

/**
 * A smooth space warp (two sine modes per axis) that every ribbon is drawn through, so the laid silk
 * keeps billowing and re-folding as the morph moves its phases. Low amplitude times wavenumber keeps
 * it a gentle diffeomorphism: it bends the silk, never crumples it.
 */
interface Warp {
  k: number;
  amp: number;
  a: number;
  b: number;
  c: number;
  /** The fine, high-octave mode the high end drives: wavenumber, amplitude and three phases. */
  fk: number;
  famp: number;
  fa: number;
  fb: number;
  fc: number;
}

class SilkInstance implements SceneInstance {
  readonly meta = META;
  private readonly morph = new Morph(1);
  private readonly u = new Float32Array(148);
  private readonly samples = new Float32Array(MAX_RIB * L * GPU_STRIDE);
  private readonly spawn = new Float32Array(8 + MAX_REC * REC_F);
  private ribbons: Ribbon[] = [];
  private nR = 0;
  private clock = 0;
  private lastT = -1;
  private seed = -1;
  private ev = [0, 0, 0];
  private seen = [0, 0, 0];
  private cursor = 0;
  private resetParticles = true;
  private recs: Rec[] = [];
  private aspect = 16 / 9;
  private eye = v3();
  private fwd = v3(0, 0, -1);
  private right = v3(1, 0, 0);
  private up = v3(0, 1, 0);
  private vp: Float32Array = new Float32Array(16);
  private nc = v3(0, 1, 0);
  private e1 = v3(1, 0, 0);
  private e2 = v3(0, 0, 1);
  private camPhase = 0;
  /** Framing: the aim eases toward where the silk is on screen, so the view is never half empty. */
  private aimYaw = 0;
  private aimPitch = 0;
  private camDir = 1;
  private lightSide = 1;
  private melW = 0;
  private pitchS = 0;
  private phrase = 0;
  private dropLast = 0;
  /** Slow live timbre (high, mid, energy) and four smoothed bands: they shape the film and sheen without flicker. */
  private tone = [0, 0, 0];
  private flux = 0;
  private bands4 = [0, 0, 0, 0];
  /** Each kick, snare and note billows the whole warp a notch (targets, eased values, velocities). */
  private push = [0, 0, 0];
  private pushE = [0, 0, 0];
  private pushV = [0, 0, 0];
  /** The billows of recent kicks, snares and notes: when each landed, its strength, and its peak time. */
  private billows: { t: number; gain: number; tau: number; fine: boolean }[] = [];
  private upSeen = 0;
  private warp: Warp = { k: 0.7, amp: 0.2, a: 0, b: 0, c: 0, fk: 4, famp: 0, fa: 0, fb: 0, fc: 0 };
  /** Fine structure (pleat frequency, pleat wobble phase, pleat depth, thread scale, edge ripple amplitude, frequency, phase), set by the high end. */
  private fine = [1, 0, 1, 1, 0.14, 0.45, 0];
  private grid = new Map<number, number[]>();
  private gridFrame = -1;
  private frameNo = 0;
  private dt = 0;
  private w = 0;
  private h = 0;
  private targets: GPUTexture[] = [];
  private compGroup: GPUBindGroup | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly group0: GPUBindGroup,
    private readonly owned: GPUBuffer[],
    private readonly bufs: { u: GPUBuffer; samples: GPUBuffer; spawn: GPUBuffer; index: GPUBuffer; indexCount: number },
    private readonly pipes: { ribbon: GPURenderPipeline; comp: GPURenderPipeline; sim: GPUComputePipeline; spark: GPURenderPipeline },
    private readonly groups: { ribbon: GPUBindGroup; sim: GPUBindGroup; spark: GPUBindGroup },
    private readonly compLayout: GPUBindGroupLayout,
  ) {}

  // ---------------------------------------------------------------- per frame

  update(ctx: SceneUpdateContext): void {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = clamp(ctx.dt, 0, 0.1);
    const seek = this.lastT < 0 || Math.abs(m.time - this.lastT - dt) > 0.5 || g[0] !== this.seed;
    this.lastT = m.time;
    const mo = this.morph;
    mo.update(m, ctx.dt, g);
    this.frameNo++;
    this.recs = [];
    if (seek) this.reset(ctx);
    this.clock += dt;
    // Each hit's billow runs its own course at its own strength; a new hit adds to the ones still
    // running instead of restarting them, so the warp never jumps.
    if (mo.kicks > this.seen[0]) this.billows.push({ t: this.clock, gain: 1.0 * mo.kickLevel, tau: 0.14, fine: false });
    if (mo.snares > this.seen[1]) this.billows.push({ t: this.clock, gain: 0.4 * mo.snareLevel, tau: 0.12, fine: false });
    // A melody note runs as ripples through the silk (the fine warp: pleats and edge ripple) with
    // only a slight swell of the whole: it should never re-lay the scene the way a kick does.
    if (mo.notes > this.seen[2]) {
      this.billows.push({ t: this.clock, gain: 1.1 * mo.noteLevel, tau: 0.2, fine: true });
      this.billows.push({ t: this.clock, gain: 0.25 * mo.noteLevel, tau: 0.15, fine: false });
    }
    // Each high note re-forms the fine structure: a swell of the fine warp, pleats and edge ripple.
    if (mo.uppers > this.upSeen) this.billows.push({ t: this.clock, gain: mo.upperLevel, tau: 0.28, fine: true });
    this.upSeen = mo.uppers;
    this.billows = this.billows.filter((b) => this.clock - b.t < 3);
    this.dt = dt;
    this.setWarp();
    this.camera();

    // Melody steering: the head follows the smoothed pitch; the phrase moves where it draws.
    // How strongly the melody is sounding: the held note's strength, or the last note's level for a
    // moment after it, both rising continuously from silence.
    const singing = Math.max(clamp(m.leadHeld * 3, 0, 1), mo.noteLevel * (1 - smooth(0.6, 1.8, mo.leadAge)));
    this.melW += (singing - this.melW) * (1 - Math.exp(-dt / 1.2));
    this.pitchS += (clamp(m.leadPitch, -1.2, 1.2) - this.pitchS) * (1 - Math.exp(-dt / 1.0));
    if (mo.notes > this.seen[2]) this.phrase += 0.55 * mo.noteLevel;

    const kt = 1 - Math.exp(-dt / 0.8);
    const kb = 1 - Math.exp(-dt / 1.2);
    this.tone[0] += (m.high - this.tone[0]) * kt;
    this.tone[1] += (m.mid - this.tone[1]) * kt;
    this.tone[2] += (m.energySlow - this.tone[2]) * kt;
    this.flux += (m.flux - this.flux) * (1 - Math.exp(-dt / 0.6));
    for (let q = 0; q < 4; q++) {
      let a = 0;
      for (let i = q * 16; i < q * 16 + 16; i++) a += m.bands[i];
      this.bands4[q] += (a / 16 - this.bands4[q]) * kb;
    }
    if (dt > 0) for (const rb of this.ribbons) this.fly(rb, dt, 0, m.centroid, m.energy, m.high);
    this.frame(dt);
    this.events(ctx);
    this.emitParticles(ctx);
    this.upload(ctx);
  }

  private reset(ctx: SceneUpdateContext): void {
    const g = ctx.dna;
    const m = ctx.music;
    this.seed = g[0];
    this.clock = 0;
    this.billows = [];
    this.upSeen = this.morph.uppers;
    this.ev = [0, 0, 0];
    this.seen = [this.morph.kicks, this.morph.snares, this.morph.notes];
    this.resetParticles = true;
    this.melW = clamp(m.leadHeld * 3, 0, 1);
    this.pitchS = m.leadPitch;
    this.phrase = g[4] * TAU;
    this.dropLast = m.dropPulse;
    this.aimYaw = this.aimPitch = 0;

    // The swirl's axis: tilted by DNA; the view turns either way round it.
    const tilt = (g[2] - 0.5) * 0.7;
    const yaw = g[5] * TAU;
    this.nc = norm([Math.sin(tilt) * Math.cos(yaw), Math.cos(tilt), Math.sin(tilt) * Math.sin(yaw)]);
    this.e1 = norm(cross(this.nc, [0.3, 0.1, 0.95]));
    this.e2 = cross(this.nc, this.e1);
    this.camPhase = g[1] * TAU;
    this.camDir = g[2] * 7.3 - Math.floor(g[2] * 7.3) > 0.5 ? 1 : -1;
    this.lightSide = g[6] > 0.5 ? 1 : -1;

    // Ribbons: five to eight, spread across the palette, a mix of dense silk and sheer veils.
    this.nR = 5 + Math.floor(g[0] * 4);
    this.ribbons = [];
    const veilShare = 0.2 + 0.5 * g[1];
    for (let r = 0; r < this.nR; r++) {
      const rb = new Ribbon(r);
      const h1 = hash(g[0] * 91 + r * 7.1);
      const h2 = hash(g[3] * 37 + r * 3.3);
      const h3 = hash(g[7] * 53 + r * 5.9);
      rb.seed = h1;
      rb.hue = g[3] + (r / this.nR) * 0.78 + 0.05 * h2;
      const veil = h2 < veilShare && r > 0;
      rb.halfWidth = Math.min(0.4, (0.2 + 0.14 * h3) * (0.8 + 0.4 * g[1]) * (veil ? 1.35 : 1));
      rb.alpha = veil ? 0.2 + 0.12 * h1 : 0.62 + 0.26 * h1;
      rb.curl = (h1 > 0.5 ? 1 : -1) * (0.2 + 0.35 * h2) * (0.6 + 0.8 * g[4]);
      rb.twist = (h3 - 0.5) * 0.35 + (g[5] - 0.5) * 0.3;
      rb.melody = r === 0 || (r === 1 && this.nR >= 6);
      // Each ribbon circulates round its own axis: the swirl's axis tipped by up to ~70 degrees.
      const tA = (h2 - 0.5) * 2.6;
      const tB = h3 * TAU;
      rb.axis = norm(add(this.nc, add(scale(this.e1, Math.cos(tB)), this.e2, Math.sin(tB)), Math.tan(tA)));
      rb.spin = hash(g[6] * 13 + r * 2.9) > 0.35 ? this.camDir : -this.camDir;
      rb.sweep = r % 2 === 0 ? 1 : -1;
      rb.rot = (fract(r * 0.618 + g[7]) - 0.5) * 3.6;
      // Start somewhere in the volume, clear of the viewer.
      const a = h1 * TAU + r;
      const b = (h2 - 0.5) * 2.2;
      const rad = 1.0 + 2.6 * h3;
      rb.P = this.pushOut([Math.cos(a) * Math.cos(b) * rad, Math.sin(b) * rad * 0.8, Math.sin(a) * Math.cos(b) * rad]);
      rb.D = norm([Math.sin(a * 1.7 + 1), Math.cos(a * 2.3) * 0.5, Math.cos(a * 1.3)]);
      rb.W = norm(cross(rb.D, norm([h2 - 0.5, 1, h3 - 0.5])));
      this.ribbons.push(rb);
    }
    this.setWarp();

    // Pre-roll: lay the whole length of silk at once, so every appearance starts complete.
    const step = DS / V_EMIT;
    for (let i = 0; i < RING; i++) {
      const tau = -(RING - i) * step;
      for (const rb of this.ribbons) this.fly(rb, step, tau, m.centroid, m.energy, m.high);
    }
    // Open well framed.
    for (let i = 0; i < 8; i++) {
      this.camera();
      this.frame(3);
    }
    this.camera();
  }

  /** Warp from the morph: its phases travel steadily, its wavenumber and depth wander. */
  private setWarp(): void {
    const mo = this.morph;
    const at = mo.at;
    const w = this.warp;
    w.k = wave(at[2] * 0.5, 0.5, 0.85);
    // Kicks, snares and notes billow the silk outward: a swell that rises from rest and settles back.
    let bil = 0;
    let up = 0;
    for (const b of this.billows) {
      const s = b.gain * swell(this.clock - b.t, b.tau);
      if (b.fine) up += s;
      else bil += s;
    }
    w.amp = wave(at[5], 0.22, 0.4) * (1 + bil);
    for (let i = 0; i < 3; i++) [this.pushE[i], this.pushV[i]] = spring(this.pushE[i], this.pushV[i], this.push[i], 9, this.dt);
    w.a = at[0] * 1.8 + mo.travel * 0.05 + this.pushE[0];
    w.b = at[1] * 1.8 + mo.travel * 0.04 + this.pushE[1];
    w.c = at[2] * 1.8 + mo.travel * 0.045 + this.pushE[2];
    // Fine scale (the high end): a high-octave warp mode whose wavenumber and phases flow with the
    // detail coordinates and the upper/hat phases, deepened by the air of the mix and by each high
    // note; the pleats, threads and edge ripple re-form with it.
    const da = mo.detailAt;
    const dd = mo.detailDrive;
    w.fk = 3.6 + 1.6 * Math.sin(da[0] * 0.7);
    w.famp = (0.008 + 0.022 * dd + 0.03 * Math.min(up, 1.5)) * (4.4 / w.fk);
    w.fa = da[1] * 1.6 + mo.upperPhase * 1.3;
    w.fb = da[2] * 1.6 + mo.hatPhase * 0.5;
    w.fc = da[3] * 1.6 + mo.backingPhase * 0.9;
    const fn = this.fine;
    fn[0] = 1 + 0.35 * Math.sin(da[0] * 1.3 + mo.upperPhase * 0.9) + 0.15 * Math.min(up, 1.5);
    fn[1] = da[1] * 2.2 + mo.upperPhase * 1.7 + mo.hatPhase * 0.6;
    fn[2] = 0.6 + 0.6 * dd + 0.9 * Math.min(up, 1.5);
    fn[3] = 1 + 0.4 * Math.sin(da[3] * 1.1 + mo.hatPhase * 0.8);
    fn[4] = 0.08 + 0.1 * dd + 0.12 * Math.min(up, 1.5);
    fn[5] = 0.45 * (1 + 0.5 * Math.sin(da[2] * 0.9 + mo.backingPhase * 0.7));
    fn[6] = da[2] * 2.0 + mo.backingPhase * 1.1 + mo.upperPhase * 0.8;
  }

  /** The warped position of p (same field as sr_warp in the shader). */
  private warped(p: V3): V3 {
    const { k, amp, a, b, c, fk, famp, fa, fb, fc } = this.warp;
    const k2 = k * 1.7;
    return [
      p[0] + amp * (Math.sin(k * p[1] + a) + 0.45 * Math.sin(k2 * p[2] - c)) + famp * Math.sin(fk * p[1] + fa),
      p[1] + amp * (Math.sin(k * p[2] + b) + 0.45 * Math.sin(k2 * p[0] + a)) + famp * Math.sin(fk * p[2] + fb),
      p[2] + amp * (Math.sin(k * p[0] + c) + 0.45 * Math.sin(k2 * p[1] - b)) + famp * Math.sin(fk * p[0] + fc),
    ];
  }

  /** Distance from p to the eye of the swirl, and the direction away from it. */
  private clear(p: V3): { d: number; away: V3 } {
    const d = Math.hypot(p[0], p[1], p[2]) || 1e-6;
    return { d, away: scale(p, 1 / d) };
  }

  private pushOut(p: V3): V3 {
    const t = this.clear(p);
    return t.d < KEEP ? scale(t.away, KEEP) : p;
  }

  private camera(): void {
    const mo = this.morph;
    const at = mo.at;
    // In the eye of the swirl: drifting a little, turning steadily to look round the silk. The
    // phrase framing (mo.cam) turns and tilts the look, rolls, lifts the eye within the clear eye
    // of the swirl and swings the lens between telephoto and wide.
    const cf = mo.cam;
    const th = this.camPhase + mo.travel * 0.08 * this.camDir + this.aimYaw + 0.9 * cf.yaw;
    const ph = clamp(0.2 * Math.sin(at[5] * 0.5) + 0.08 + this.aimPitch + 1.2 * cf.pitch, -0.85, 0.85);
    const dr = 0.3;
    this.eye = add(add(scale(this.e1, dr * Math.sin(at[6] * 0.7)), this.e2, dr * Math.cos(at[7] * 0.6)), this.nc, 0.25 * Math.sin(at[4] * 0.5) + 0.55 * cf.height);
    const look = add(scale(add(scale(this.e1, Math.cos(th)), this.e2, Math.sin(th)), Math.cos(ph)), this.nc, Math.sin(ph));
    const target = add(this.eye, look, 4);
    const roll = 0.1 * Math.sin(at[4] * 0.4) + cf.roll;
    const fov = clamp(1.08 * cf.fov, 0.62, 2.0);
    this.vp = lookAtPerspective(this.eye, target, fov, this.aspect, 0.05, 100, roll);
    this.fwd = norm([target[0] - this.eye[0], target[1] - this.eye[1], target[2] - this.eye[2]]);
    this.right = norm(cross(this.fwd, [Math.sin(roll), Math.cos(roll), 0]));
    this.up = cross(this.right, this.fwd);
  }

  /** Flies one ribbon's emitter for h seconds and lays silk behind it. */
  private fly(rb: Ribbon, h: number, tau: number, centroid: number, energy: number, high: number): void {
    const mo = this.morph;
    const at = mo.at;
    const r = rb.index;
    const ph = rb.seed * 10;
    const P = rb.P;
    // Circulation: each ribbon streams round its own tilted axis, its radius and height undulating
    // with the morph, so the silk sweeps round the viewer instead of balling up at a target.
    const ax = rb.axis;
    const hgt = dot(P, ax);
    const radial = add(P, ax, -hgt);
    const rr = Math.hypot(radial[0], radial[1], radial[2]) || 1e-6;
    const rhat = scale(radial, 1 / rr);
    const that = scale(cross(ax, rhat), rb.spin);
    const rT = 2.9 + 2.0 * (0.5 + 0.5 * Math.sin(at[(r + 1) % 8] * 0.6 + ph + tau * 0.045));
    const hT = 1.5 * Math.sin(at[(r + 3) % 8] * 0.5 + ph * 1.7 + tau * 0.055);
    let G = norm(add(add(that, rhat, clamp((rT - rr) * 0.7, -1.2, 1.2)), ax, clamp((hT - hgt) * 0.7, -1.2, 1.2)));
    if (!rb.melody && r % 2 === 0) {
      // Every other ribbon also spirals round the line of sight, so silk always flows ahead.
      const lc = add(this.eye, this.fwd, 4.3 + 0.6 * Math.sin(ph));
      const rel: V3 = [P[0] - lc[0], P[1] - lc[1], P[2] - lc[2]];
      const along = dot(rel, this.fwd);
      const lat = add(rel, this.fwd, -along);
      const lr = Math.hypot(lat[0], lat[1], lat[2]) || 1e-6;
      const lh = scale(lat, 1 / lr);
      const swirl = scale(cross(this.fwd, lh), rb.spin);
      const lrT = 2.4 + 0.8 * Math.sin(at[(r + 4) % 8] * 0.5 + ph);
      const Gv = norm(add(add(swirl, lh, clamp((lrT - lr) * 0.8, -1, 1)), this.fwd, clamp(-along * 0.5, -0.8, 0.8)));
      G = norm(add(scale(G, 0.65), Gv, 0.35));
    }
    let mel = 0;
    if (rb.melody && tau === 0 && this.melW > 0.01) {
      // The melody draws in front of the viewer: the head circles a point ahead (so it keeps
      // crossing the view, near then far), rising and falling with the pitch.
      mel = this.melW;
      const cm = add(add(this.eye, this.fwd, 4.2 + (r === 0 ? 0 : 0.6)), this.right, (r === 0 ? 1 : -1) * (0.3 + 1.2 * Math.sin(this.phrase * 0.23 + r * 2)));
      const rel: V3 = [P[0] - cm[0], P[1] - cm[1], P[2] - cm[2]];
      const y = dot(rel, this.up);
      const flat = add(rel, this.up, -y);
      const fr = Math.hypot(flat[0], flat[1], flat[2]) || 1e-6;
      const fh = scale(flat, 1 / fr);
      const around = scale(cross(this.up, fh), rb.sweep);
      const yT = this.pitchS * 0.95 + (r === 0 ? 0.15 : -0.35);
      const Gm = norm(add(add(around, fh, clamp((2.0 - fr) * 0.8, -1.2, 1.2)), this.up, clamp((yT - y) * 0.75, -0.9, 0.9)));
      const wm = 0.75 * mel;
      G = norm([G[0] + (Gm[0] - G[0]) * wm, G[1] + (Gm[1] - G[1]) * wm, G[2] + (Gm[2] - G[2]) * wm]);
    }
    const tb = this.clear(P);
    if (tb.d < KEEP + 0.8) G = norm(add(G, tb.away, 3.5 * (1 - (tb.d - KEEP) / 0.8)));
    const pr = Math.hypot(P[0], P[1], P[2]);
    if (pr > OUTER - 0.6) G = norm(add(G, scale(P, -1 / pr), 2.5 * (pr - OUTER + 0.6)));

    // Bank to turn: a ribbon bends about its width and twists about its length, never sideways.
    const D = rb.D;
    let W = rb.W;
    let N = cross(D, W);
    const gD = dot(G, D);
    const gW = dot(G, W);
    const gN = dot(G, N);
    // Roll toward the bank that puts the target in the bending plane (continuous through gN = 0,
    // so the controller never chatters), and bend toward it.
    const beta = (-gW * gN) / (gN * gN + 0.06);
    const kScale = wave(at[3], 0.4, 1.4);
    // The curl swings from one side to the other every few seconds: S-folds, never a coil.
    const curl = rb.curl * kScale * (1 - 0.8 * mel) * Math.sin((mo.travel + tau * 0.32) * 2.6 + at[(r + 6) % 8] * 0.8 + ph);
    const twist = rb.twist + 0.2 * Math.sin(at[4] + r * 1.7);
    const rollRate = clamp((1.1 + 1.2 * mel) * beta, -0.8 - mel, 0.8 + mel) + twist;
    const pitchRate = clamp((1.6 + 1.6 * mel) * gN * (gD < 0 ? 2 : 1), -1.6 - mel, 1.6 + mel) + curl;
    const pace = 0.6 + 0.4 * this.morph.flow;
    const v = V_EMIT * pace;
    // Roll about D.
    const bR = rollRate * h * pace;
    const cb = Math.cos(bR);
    const sb = Math.sin(bR);
    W = [W[0] * cb + N[0] * sb, W[1] * cb + N[1] * sb, W[2] * cb + N[2] * sb];
    N = cross(D, W);
    // Pitch about W (toward N).
    const aP = pitchRate * h * pace;
    const ca = Math.cos(aP);
    const sa = Math.sin(aP);
    let nD: V3 = [D[0] * ca + N[0] * sa, D[1] * ca + N[1] * sa, D[2] * ca + N[2] * sa];
    nD = norm(nD);
    W = norm(add(W, nD, -dot(W, nD)));
    rb.D = nD;
    rb.W = W;
    rb.P = add(P, nD, v * h);

    rb.dist += v * h;
    while (rb.dist >= DS) {
      rb.dist -= DS;
      this.emit(rb, add(rb.P, rb.D, -rb.dist), tau, centroid, energy, high);
    }
  }

  private emit(rb: Ribbon, p: V3, tau: number, centroid: number, energy: number, high: number): void {
    const prevB = rb.stored > 0 ? rb.base(rb.serial) : -1;
    rb.serial++;
    const s = rb.serial;
    const b = rb.base(s);
    const R = rb.ring;
    R[b] = p[0];
    R[b + 1] = p[1];
    R[b + 2] = p[2];
    R[b + 3] = this.clock + tau;
    R[b + 4] = rb.W[0];
    R[b + 5] = rb.W[1];
    R[b + 6] = rb.W[2];
    R[b + 7] = s;
    if (prevB >= 0) {
      // New silk carries on in the state of the silk before it (a front still running continues).
      for (let k = 0; k < 3; k++) {
        const o = POFF[k];
        R[b + o] = R[prevB + o];
        R[b + o + 1] = R[prevB + o + 1];
        const T = R[prevB + o + 2];
        R[b + o + 2] = T > this.clock ? T + 0.03 : T;
        R[b + EVOFF + k] = R[prevB + EVOFF + k];
      }
      R[b + LVOFF] = R[prevB + LVOFF];
    } else {
      const r = rb.index;
      R[b + 8] = R[b + 9] = 0.15 * Math.sin(s * 0.013 + r * 1.7);
      R[b + 10] = -1000;
      R[b + 12] = R[b + 13] = this.seed * 10 + r * 1.3;
      R[b + 14] = -1000;
      R[b + 16] = R[b + 17] = rb.hue;
      R[b + 18] = -1000;
      R[b + 20] = R[b + 21] = R[b + 22] = 0;
      R[b + LVOFF] = 0;
    }
    if (tau < 0) {
      // Pre-rolled silk: a slow variation along the length so it does not start uniform.
      const r = rb.index;
      R[b + 8] = R[b + 9] = 0.35 * Math.sin(s * 0.011 + r * 1.7) + 0.2 * Math.sin(s * 0.031 + r);
      R[b + 12] = R[b + 13] = this.seed * 10 + r * 1.3 + 0.5 * Math.sin(s * 0.009 + r);
      R[b + 16] = R[b + 17] = rb.hue + 0.07 * Math.sin(s * 0.017 + r * 2.1);
    }
    R[b + 11] = centroid;
    R[b + 15] = energy;
    R[b + 19] = high;
    R[b + 23] = 0.75 + 0.5 * hash(s * 0.731 + rb.index * 17.3);
    rb.stored = Math.min(rb.stored + 1, RING);
  }

  // ---------------------------------------------------------------- fronts

  private events(ctx: SceneUpdateContext): void {
    const mo = this.morph;
    const m = ctx.music;
    const e = m.energySlow;
    if (this.dt <= 0) {
      this.seen = [mo.kicks, mo.snares, mo.notes];
      return;
    }
    // Every reaction a beat sets off carries that beat's strength (0..1, captured as it lands): a faint
    // hit takes a small step toward the new state, a hard one the whole step. The next hit continues
    // from wherever the silk is, so the lasting state never jumps.
    if (mo.kicks > this.seen[0]) {
      const ev = ++this.ev[0];
      const lv = mo.kickLevel;
      // Ignition points on up to four ribbons; each burns both ways along its silk.
      // Every front of one kick adds the same step to the film state, so where they meet there is no seam.
      const inc = (0.55 + 0.35 * hash(ev * 1.91)) * lv;
      this.push[0] += 1.2 * lv;
      const used = new Set<number>();
      for (let i = 0; i < 4; i++) {
        const pick = this.pick(ev * 3 + i * 3, ev * 1.37 + i * 7, 0, used);
        if (!pick) break;
        used.add(pick[0]);
        this.ignite(0, pick[0], pick[1], this.clock, ev, 5.0 + 2.0 * e, (3.5 + 3.5 * e) * (0.5 + 0.5 * lv), (cur, f) => cur + inc * f, 2, 0.4);
      }
    }
    if (mo.snares > this.seen[1]) {
      const ev = ++this.ev[1];
      const lv = mo.snareLevel;
      this.push[1] += 1.2 * lv;
      const used = new Set<number>();
      for (let i = 0; i < 2; i++) {
        const pick = this.pick(ev * 5 + 2 + i * 3, ev * 2.71 + 9 + i * 5, 1, used);
        if (!pick) break;
        used.add(pick[0]);
        this.ignite(1, pick[0], pick[1], this.clock, ev, 6.5 + 2.0 * e, (3 + 2.5 * e) * (0.5 + 0.5 * lv), (cur, f) => cur + lv * f, 1, 0.25);
      }
    }
    if (mo.notes > this.seen[2]) {
      const ev = ++this.ev[2];
      const lv = mo.noteLevel;
      // A small lasting turn of the warp (a kick's is 1.2); the note's real mark is the dye front.
      this.push[2] += (clamp(mo.notePitch, -1, 1) >= 0 ? 0.6 : -0.6) * lv;
      // Where the silk is unfurling: the newest stretch in view of each melody ribbon (else of the
      // ribbons nearest to them), so the note dyes the silk the melody is laying down.
      const order = [...this.ribbons.filter((r) => r.melody), ...this.ribbons.filter((r) => !r.melody)];
      let lit = 0;
      for (const rb of order) {
        if (lit >= 2) break;
        let s0 = -1;
        for (let j = 0; j < Math.min(rb.stored, 200); j += 2)
          if (this.inView(rb, rb.serial - j)) {
            s0 = rb.serial - j;
            break;
          }
        if (s0 < 0) continue;
        lit++;
        const dye = rb.hue + 0.22 + 0.42 * clamp(mo.notePitch, -1.2, 1.2) + 0.05 * Math.sin(ev * 2.3);
        // Every note changes the dye visibly, even a repeated pitch.
        this.ignite(2, rb.index, s0, this.clock, ev, 3.0, 3.2, (cur, f) => cur + (Math.abs(dye - cur) < 0.1 ? (cur < dye ? 0.1 : -0.1) : dye - cur) * f * lv, 0, 1.2, lv);
        const b = rb.base(s0);
        const p = this.warped([rb.ring[b], rb.ring[b + 1], rb.ring[b + 2]]);
        this.recs.push({ p0: p, p1: p, count: Math.round((10 + 14 * m.leadHeld) * lv), mode: 1, t: dye, lum: 2.2, life: 1.5, vel: [0, 0, 0], size: 0.008, spread: 0.32, both: 0, rot: rb.rot });
      }
    }
    // A drop sets every ribbon alight, as strongly as the drop is big and the music is driving.
    if (m.dropPulse > this.dropLast + 0.3) {
      const ev = ++this.ev[0];
      const lv = clamp(m.dropPulse - this.dropLast, 0, 1) * (0.35 + 0.65 * mo.drive);
      const inc = 0.8 * lv;
      for (const rb of this.ribbons) {
        if (rb.stored < 10) continue;
        const s = rb.serial - Math.floor(rb.stored * (0.2 + 0.6 * hash(ev + rb.index)));
        this.ignite(0, rb.index, s, this.clock, ev, 3.2, 4 + 10 * lv, (cur, f) => cur + inc * f, 0);
      }
    }
    this.dropLast = m.dropPulse;
    this.seen = [mo.kicks, mo.snares, mo.notes];
  }

  /** Eases the aim toward the centroid of the silk on screen (nearer silk counts more). */
  private frame(dt: number): void {
    const M = this.vp;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (const rb of this.ribbons) {
      const R = rb.ring;
      for (let i = 0; i < rb.stored; i += 4) {
        const b = i * CPU_STRIDE;
        const x = R[b];
        const y = R[b + 1];
        const z = R[b + 2];
        const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
        if (cw < 0.5) continue;
        const nx = (M[0] * x + M[4] * y + M[8] * z + M[12]) / cw;
        const ny = (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw;
        if (Math.abs(nx) > 1.6 || Math.abs(ny) > 1.6) continue;
        const w = 1 / cw;
        sx += clamp(nx, -1.2, 1.2) * w;
        sy += clamp(ny, -1.2, 1.2) * w;
        sw += w;
      }
    }
    if (sw <= 0 || dt <= 0) return;
    const k = 1 - Math.exp(-dt / 3);
    // th turns the view about nc (to the left), so silk to the right (+x) lowers it.
    this.aimYaw = clamp(this.aimYaw - (sx / sw) * 0.5 * k, -1.2, 1.2);
    this.aimPitch = clamp(this.aimPitch + (sy / sw) * 0.3 * k, -0.4, 0.4);
  }

  private inView(rb: Ribbon, s: number): boolean {
    const M = this.vp;
    const b = rb.base(s);
    const x = rb.ring[b];
    const y = rb.ring[b + 1];
    const z = rb.ring[b + 2];
    const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (cw < 2.2 || cw > 7.5) return false;
    return Math.abs((M[0] * x + M[4] * y + M[8] * z + M[12]) / cw) < 0.8 && Math.abs((M[1] * x + M[5] * y + M[9] * z + M[13]) / cw) < 0.8;
  }

  /** A visible point on some ribbon to ignite: kicks prefer the middle of the view, snares its edges. */
  private pick(start: number, salt: number, kind: number, skip?: Set<number>): [number, number] | null {
    const M = this.vp;
    for (let k = 0; k < this.nR; k++) {
      const rb = this.ribbons[(start + k) % this.nR];
      if (skip?.has(rb.index)) continue;
      let best = -1e9;
      let bestS = -1;
      for (let j = 4; j < rb.stored - 4; j += 2) {
        const s = rb.serial - j;
        const b = rb.base(s);
        const x = rb.ring[b];
        const y = rb.ring[b + 1];
        const z = rb.ring[b + 2];
        const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
        if (cw < 2.2 || cw > 7) continue;
        const nx = (M[0] * x + M[4] * y + M[8] * z + M[12]) / cw;
        const ny = (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw;
        if (Math.abs(nx) > 0.8 || Math.abs(ny) > 0.8) continue;
        const rr = Math.hypot(nx, ny);
        const score = (kind === 0 ? 1 - 0.7 * rr * rr : 1 - Math.abs(rr - 0.5)) + 0.6 * hash(salt + s * 0.37) - 0.06 * Math.abs(cw - 3.2);
        if (score > best) {
          best = score;
          bestS = s;
        }
      }
      if (bestS > 0) return [rb.index, bestS];
    }
    return null;
  }

  /** Local conduction speed factor: fronts run fast along straight silk and slow through tight folds. */
  private cond(rb: Ribbon, s: number): number {
    const R = rb.ring;
    const b = rb.base(s);
    if (!rb.valid(s - 1) || !rb.valid(s + 1)) return R[b + 23];
    const a = rb.base(s - 1);
    const c = rb.base(s + 1);
    const d1 = norm([R[b] - R[a], R[b + 1] - R[a + 1], R[b + 2] - R[a + 2]]);
    const d2 = norm([R[c] - R[b], R[c + 1] - R[b + 1], R[c + 2] - R[b + 2]]);
    const st = Math.max(0, dot(d1, d2));
    return (0.5 + 0.5 * st * st * st * st) * R[b + 23];
  }

  /**
   * Burns a process along a ribbon from sample s0, both ways, writing each sample's arrival time
   * (the arrival-time field along the silk), its old and new state, and the event that reached it.
   * A front stops where the silk already carries this or a newer event, or when its reach runs out
   * (fading its change out softly), and jumps to other ribbons where they pass close.
   */
  private ignite(kind: number, r: number, s0: number, T0: number, ev: number, speed: number, budget: number, apply: (cur: number, fade: number) => number, jumps: number, flare = 0.12, lvl = 1): void {
    const rb = this.ribbons[r];
    if (!rb || rb.lastEv[kind] === ev || !rb.valid(s0)) return;
    rb.lastEv[kind] = ev;
    const R = rb.ring;
    const o = POFF[kind];
    const b0 = rb.base(s0);
    for (const dir of [-1, 1]) {
      let s = dir < 0 ? s0 : s0 + 1;
      let T = T0;
      let B = budget;
      let px = R[b0];
      let py = R[b0 + 1];
      let pz = R[b0 + 2];
      while (rb.valid(s)) {
        const b = rb.base(s);
        if (s !== s0) {
          const d = Math.hypot(R[b] - px, R[b + 1] - py, R[b + 2] - pz);
          B -= d;
          if (B <= 0) break;
          // The ignition point flares over a short stretch at once, then the front runs.
          if (budget - B > flare) T += d / (speed * this.cond(rb, s));
        }
        if (R[b + EVOFF + kind] >= ev) break;
        const fade = Math.min(1, B / FADE_LEN);
        // Start from what the silk shows now (an earlier change may still be easing in), so a new
        // front never makes the state jump.
        const x = clamp((this.clock - R[b + o + 2] - EASE_DELAY[kind]) / EASE[kind], 0, 1);
        const cur = R[b + o] + (R[b + o + 1] - R[b + o]) * x * x * (3 - 2 * x);
        R[b + o] = cur;
        R[b + o + 1] = apply(cur, fade);
        R[b + o + 2] = T;
        R[b + EVOFF + kind] = ev;
        if (kind === 2) R[b + LVOFF] = lvl;
        if (jumps > 0 && (s & 1) === 0 && B > 1.5) this.jump(kind, r, R[b], R[b + 1], R[b + 2], T, ev, speed, B * 0.7, apply, jumps - 1, lvl);
        px = R[b];
        py = R[b + 1];
        pz = R[b + 2];
        s += dir;
      }
    }
  }

  private jump(kind: number, r: number, x: number, y: number, z: number, T: number, ev: number, speed: number, budget: number, apply: (cur: number, fade: number) => number, jumps: number, lvl: number): void {
    const cell = 0.35;
    if (this.gridFrame !== this.frameNo) {
      this.gridFrame = this.frameNo;
      this.grid.clear();
      for (const rb of this.ribbons) {
        for (let i = 0; i < rb.stored; i++) {
          const b = i * CPU_STRIDE;
          const key = this.cellKey(Math.floor(rb.ring[b] / cell), Math.floor(rb.ring[b + 1] / cell), Math.floor(rb.ring[b + 2] / cell));
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          list.push(rb.index * 100000 + i);
        }
      }
    }
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let best = 0.32 * 0.32;
    let bestR = -1;
    let bestS = -1;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.grid.get(this.cellKey(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const id of list) {
            const r2 = Math.floor(id / 100000);
            if (r2 === r) continue;
            const rb = this.ribbons[r2];
            if (rb.lastEv[kind] === ev) continue;
            const b = (id % 100000) * CPU_STRIDE;
            const d2 = (rb.ring[b] - x) ** 2 + (rb.ring[b + 1] - y) ** 2 + (rb.ring[b + 2] - z) ** 2;
            if (d2 < best && rb.ring[b + EVOFF + kind] < ev) {
              best = d2;
              bestR = r2;
              bestS = rb.ring[b + 7];
            }
          }
        }
    if (bestR >= 0) this.ignite(kind, bestR, bestS, T + 0.04, ev, speed, budget, apply, jumps, 0.12, lvl);
  }

  private cellKey(x: number, y: number, z: number): number {
    return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  }

  // ---------------------------------------------------------------- particles

  /** Sparks where fronts are crossing the silk this frame, and dust from the heads as sound makes matter. */
  private emitParticles(ctx: SceneUpdateContext): void {
    const m = ctx.music;
    const dt = this.dt;
    if (dt <= 0) return;
    const now = this.clock;
    const recs = this.recs;
    for (const rb of this.ribbons) {
      const R = rb.ring;
      for (let kind = 0; kind < 3; kind++) {
        const o = POFF[kind];
        let runStart = -1;
        let runLen = 0;
        let runStr = 0;
        const flush = (sEnd: number) => {
          if (runLen === 0) return;
          const bA = rb.base(runStart);
          const bB = rb.base(sEnd);
          const p0 = this.warped([R[bA], R[bA + 1], R[bA + 2]]);
          const p1 = this.warped([R[bB], R[bB + 1], R[bB + 2]]);
          const mid = rb.base(Math.round((runStart + sEnd) / 2));
          const tg = norm([p1[0] - p0[0] + 1e-5, p1[1] - p0[1], p1[2] - p0[2]]);
          const nrm = norm(cross(tg, [R[mid + 4], R[mid + 5], R[mid + 6]]));
          const str = runStr / runLen;
          if (kind === 0)
            recs.push({ p0, p1, count: Math.round(runLen * str * (0.12 + 0.3 * m.bass + 0.15 * m.energy)), mode: 0, t: 0, lum: 3.2, life: 2.2, vel: scale(nrm, 0.25 + 0.2 * m.bass), size: 0.008 + 0.006 * m.lowMid, spread: 0.18, both: 1, rot: 0 });
          else if (kind === 1)
            recs.push({ p0, p1, count: Math.round(runLen * str * (0.1 + 0.3 * m.high)), mode: 2, t: rb.hue + 0.5, lum: 3.0, life: 0.9, vel: scale(nrm, 0.55), size: 0.006 + 0.004 * m.high, spread: 0.3, both: 1, rot: rb.rot });
          else recs.push({ p0, p1, count: Math.round(runLen * str * 0.25), mode: 1, t: R[mid + 17], lum: 1.6, life: 1.6, vel: scale(nrm, 0.12), size: 0.008, spread: 0.08, both: 1, rot: rb.rot });
          runLen = 0;
        };
        let prevS = -1;
        for (let j = 0; j < rb.stored; j++) {
          const s = rb.serial - j;
          const b = rb.base(s);
          const T = R[b + o + 2];
          if (T > now - dt && T <= now) {
            if (runLen > 0 && prevS !== s + 1) flush(prevS);
            if (runLen === 0) runStart = s;
            runLen++;
            runStr += Math.min(1, Math.abs(R[b + o + 1] - R[b + o]) * (kind === 2 ? 6 : 1.6)) * (kind === 2 ? R[b + LVOFF] : 1);
            prevS = s;
          } else if (runLen > 0) {
            flush(prevS);
            runStr = 0;
          }
        }
        flush(prevS);
      }
      // Head dust: rate from the flux, size from the band energies, colour from the centroid (or the
      // pitch on melody heads).
      const rate = (0.3 + 4 * this.flux + 2 * this.tone[0]) * (0.4 + 0.6 * this.morph.flow);
      rb.dust += rate * dt;
      const n = Math.floor(rb.dust);
      rb.dust -= n;
      if (n > 0) {
        const tc = rb.hue + 0.15 + 0.6 * m.centroid;
        const t = tc + (rb.hue + 0.22 + 0.3 * this.pitchS - tc) * (rb.melody ? smooth(0.05, 0.6, this.melW) : 0);
        recs.push({ p0: this.warped(rb.P), p1: this.warped(add(rb.P, rb.D, -V_EMIT * dt * 3)), count: n, mode: 1, t, lum: 0.9, life: 5, vel: scale(rb.D, -0.04), size: 0.004 + 0.006 * m.energy, spread: 0.07, both: 0, rot: rb.rot });
      }
    }
  }

  // ---------------------------------------------------------------- upload

  private upload(ctx: SceneUpdateContext): void {
    const m = ctx.music;
    const mo = this.morph;
    const at = mo.at;
    const g = ctx.dna;
    const S = this.samples;
    for (const rb of this.ribbons) {
      const R = rb.ring;
      const base0 = rb.index * L * GPU_STRIDE;
      const newest = rb.stored > 0 ? rb.base(rb.serial) : 0;
      // Head (logical 0): the emitter itself, in the newest silk's state.
      S[base0] = rb.P[0];
      S[base0 + 1] = rb.P[1];
      S[base0 + 2] = rb.P[2];
      S[base0 + 3] = this.clock;
      S[base0 + 4] = rb.W[0];
      S[base0 + 5] = rb.W[1];
      S[base0 + 6] = rb.W[2];
      S[base0 + 7] = rb.serial + rb.dist / DS;
      for (let k = 8; k < 20; k++) S[base0 + k] = R[newest + k];
      S[base0 + 20] = R[newest + LVOFF];
      for (let j = 1; j <= rb.stored; j++) {
        const b = rb.base(rb.serial - (j - 1));
        const d = base0 + j * GPU_STRIDE;
        for (let k = 0; k < 20; k++) S[d + k] = R[b + k];
        S[d + 20] = R[b + LVOFF];
      }
    }
    this.device.queue.writeBuffer(this.bufs.samples, 0, S, 0, this.nR * L * GPU_STRIDE);

    const u = this.u;
    u.fill(0);
    u.set(this.vp, 0);
    u.set(this.eye, 16);
    u[19] = this.clock;
    u.set(this.fwd, 20);
    u[23] = Math.tan(1.08 / 2);
    u.set(this.right, 24);
    u[27] = this.aspect;
    u.set(this.up, 28);
    u[31] = this.nR;
    // Key light behind the silk (light passing through), fill from beside the camera.
    const key = norm(add(add(scale(this.fwd, 0.55), this.up, 0.65), this.right, 0.55 * this.lightSide));
    u.set(key, 32);
    u[35] = 0.95;
    const fill = norm(add(add(scale(this.fwd, -0.55), this.up, 0.6), this.right, -0.6 * this.lightSide));
    u.set(fill, 36);
    u[39] = 0.55 + 0.15 * m.energySlow;
    // Film: base thickness, nm per kick state, physical-vs-palette iridescence, shimmer strength.
    u[40] = 300 + 120 * g[7];
    u[41] = 150;
    u[42] = 0.2 + 0.25 * g[6];
    u[43] = 0.45 + 0.35 * this.tone[0] + 0.15 * this.tone[2];
    // Fold: cross-section amplitude, continuous drift, pleat depth, sheen.
    u[44] = wave(at[5] * 0.8 + 1, 0.22, 0.5);
    u[45] = at[6] * 0.35;
    u[46] = wave(at[7], 0.05, 0.16);
    u[47] = 0.5 + 0.5 * this.tone[1] + 0.2 * this.tone[0];
    // Background: glow hue, base luminance, glow strength.
    u[48] = g[3] + 0.1;
    u[49] = 0.006;
    u[50] = 0.02 + 0.01 * m.energySlow;
    // Fog density, near fade distance.
    u[52] = 0.22;
    u[53] = 2.0;
    const wp = this.warp;
    u[56] = wp.k;
    u[57] = wp.amp;
    u[58] = wp.a;
    u[59] = wp.b;
    u[62] = wp.c;
    u[54] = this.bands4[0];
    u[55] = this.bands4[1];
    u[60] = this.bands4[2];
    u[61] = this.bands4[3];
    u[63] = DS;
    const wf = this.warp;
    u.set([wf.fk, wf.famp, wf.fa, wf.fb, wf.fc, ...this.fine], 136);
    for (const rb of this.ribbons) {
      const o = 64 + rb.index * 8;
      u[o] = rb.hue;
      u[o + 1] = rb.halfWidth;
      u[o + 2] = rb.alpha;
      u[o + 3] = rb.stored + 1;
      u[o + 4] = rb.dist / DS;
      u[o + 5] = rb.stored >= RING ? 1 : 0;
      u[o + 6] = rb.seed;
      u[o + 7] = rb.rot;
    }
    this.device.queue.writeBuffer(this.bufs.u, 0, u);

    // Particle spawns: consecutive ranges of the pool ring.
    const sp = this.spawn;
    sp.fill(0);
    let total = 0;
    const recs = this.recs.filter((r) => r.count > 0).slice(0, MAX_REC);
    for (let k = 0; k < recs.length; k++) {
      const r = recs[k];
      const n = Math.min(r.count, 2048);
      const o = 8 + k * REC_F;
      sp.set(r.p0, o);
      sp[o + 3] = total;
      sp.set(r.p1, o + 4);
      sp[o + 7] = n;
      sp[o + 8] = r.mode;
      sp[o + 9] = r.t;
      sp[o + 10] = r.lum;
      sp[o + 11] = r.life;
      sp.set(r.vel, o + 12);
      sp[o + 15] = r.size;
      sp[o + 16] = r.spread;
      sp[o + 17] = r.both;
      sp[o + 18] = r.rot;
      total += n;
    }
    total = Math.min(total, NP / 2);
    sp[0] = this.cursor;
    sp[1] = total;
    sp[2] = this.dt;
    sp[3] = NP;
    sp[4] = this.clock;
    sp[5] = this.resetParticles ? 1 : 0;
    sp[7] = recs.length;
    this.cursor = (this.cursor + total) % NP;
    this.resetParticles = false;
    this.device.queue.writeBuffer(this.bufs.spawn, 0, sp);
  }

  // ---------------------------------------------------------------- render

  private ensureTargets(w: number, h: number): void {
    if (w === this.w && h === this.h && this.compGroup) return;
    for (const t of this.targets) t.destroy();
    this.w = w;
    this.h = h;
    const d = this.device;
    const make = (format: GPUTextureFormat, samples: number, label: string) =>
      d.createTexture({
        label: `silk-${label}`,
        size: [w, h],
        format,
        sampleCount: samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | (samples === 1 ? GPUTextureUsage.TEXTURE_BINDING : 0),
      });
    const accMS = make('rgba16float', 4, 'acc-ms');
    const revMS = make('r16float', 4, 'rev-ms');
    const acc = make('rgba16float', 1, 'acc');
    const rev = make('r16float', 1, 'rev');
    this.targets = [accMS, revMS, acc, rev];
    this.compGroup = d.createBindGroup({
      layout: this.compLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bufs.u } },
        { binding: 1, resource: acc.createView() },
        { binding: 2, resource: rev.createView() },
      ],
    });
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    this.aspect = width / height;
    this.ensureTargets(width, height);
    const [accMS, revMS, acc, rev] = this.targets;
    const cp = encoder.beginComputePass({ label: 'silk-sparks-sim' });
    cp.setPipeline(this.pipes.sim);
    cp.setBindGroup(0, this.group0);
    cp.setBindGroup(1, this.groups.sim);
    cp.dispatchWorkgroups(NP / 256);
    cp.end();

    const oit = encoder.beginRenderPass({
      label: 'silk-ribbons-oit',
      colorAttachments: [
        { view: accMS.createView(), resolveTarget: acc.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'discard' },
        { view: revMS.createView(), resolveTarget: rev.createView(), loadOp: 'clear', clearValue: [1, 0, 0, 0], storeOp: 'discard' },
      ],
    });
    oit.setPipeline(this.pipes.ribbon);
    oit.setBindGroup(0, this.group0);
    oit.setBindGroup(1, this.groups.ribbon);
    oit.setIndexBuffer(this.bufs.index, 'uint32');
    oit.drawIndexed(this.bufs.indexCount, this.nR);
    oit.end();

    const pass = encoder.beginRenderPass({
      label: 'silk-ribbons',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setBindGroup(0, this.group0);
    pass.setPipeline(this.pipes.comp);
    pass.setBindGroup(1, this.compGroup!);
    pass.draw(3);
    pass.setPipeline(this.pipes.spark);
    pass.setBindGroup(1, this.groups.spark);
    pass.draw(6, NP);
    pass.end();
  }

  destroy(): void {
    for (const t of this.targets) t.destroy();
    for (const b of this.owned) b.destroy();
  }
}

// ==================================================================== WGSL

const RU_WGSL = /* wgsl */ `
struct RU {
  vp: mat4x4f,
  eye: vec4f,
  fwd: vec4f,
  right: vec4f,
  up: vec4f,
  key: vec4f,
  fill: vec4f,
  film: vec4f,
  fold: vec4f,
  bg: vec4f,
  fog: vec4f,
  warp: vec4f,
  misc: vec4f,
  rib: array<vec4f, 18>,
  // Fine structure: high-octave warp (k, amp, phases a, b) / (phase c, pleat freq, pleat wobble, pleat depth) / (thread scale, edge ripple amp, freq, phase).
  fw: vec4f,
  fp: vec4f,
  fe: vec4f,
};

// Palette colour at a set luminance, its hue spread round the wheel (by up to ~120 degrees)
// across the dye range and per ribbon, so the silk reads as several hues even under a one-hue palette.
fn sr_col(t: f32, lum: f32) -> vec3f { return sr_colR(t, lum, 0.0); }
fn sr_colR(t: f32, lum: f32, rot: f32) -> vec3f {
  // A near-white palette slot borrows colour from a neighbouring one, so no ribbon is chalk.
  let c0 = pal(t);
  let c1 = pal(t + 0.37);
  let s0 = (max(c0.r, max(c0.g, c0.b)) - min(c0.r, min(c0.g, c0.b))) / max(max(c0.r, max(c0.g, c0.b)), 1e-3);
  let c = mix(c0, c1 * (luma(c0) / max(luma(c1), 0.02)), smoothstep(0.4, 0.1, s0) * 0.85);
  let k = vec3f(0.57735);
  let a = 0.6 * sin(TAU * t * 0.9 + 0.7) + rot;
  let r = max(c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a)), vec3f(0.0));
  let l = luma(r);
  let q = max(mix(vec3f(l), r, 1.55), vec3f(0.0));
  return q * (lum / max(luma(q), 0.02));
}

// Deep space behind the silk: a dark palette gradient and the soft glow of the light behind it.
fn sr_bg(rd: vec3f) -> vec3f {
  let L = normalize(U.key.xyz);
  let c = sat(dot(rd, L));
  let base = palRampL(0.06 + 0.12 * (dot(rd, U.up.xyz) * 0.5 + 0.5), U.bg.y);
  let glow = sr_col(U.bg.x, 1.0) * (pow(c, 4.0) * U.bg.z + pow(c, 24.0) * U.bg.z * 1.5);
  return base + glow;
}
`;

const RIBBON_WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> U: RU;
@group(1) @binding(1) var<storage, read> smp: array<vec4f>;

const SR_L: u32 = ${L}u;
const SR_SUB: f32 = ${SUB}.0;
const SR_NC: u32 = ${NC}u;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec4f,
  @location(1) nrm: vec4f,
  @location(2) tan: vec4f,
  @location(3) bin: vec4f,
  @location(4) kst: vec4f,
  @location(5) sst: vec4f,
  @location(6) dst: vec4f,
  @location(7) bk: vec4f,
};

fn sr_at(r: u32, j: u32, k: u32) -> vec4f { return smp[(r * SR_L + j) * 6u + k]; }

fn sr_warp(p: vec3f) -> vec3f {
  let k = U.warp.x; let A = U.warp.y; let a = U.warp.z; let b = U.warp.w; let c = U.misc.z;
  let k2 = k * 1.7;
  let fk = U.fw.x; let fA = U.fw.y;
  return p + A * vec3f(sin(k * p.y + a) + 0.45 * sin(k2 * p.z - c), sin(k * p.z + b) + 0.45 * sin(k2 * p.x + a), sin(k * p.x + c) + 0.45 * sin(k2 * p.y - b))
    + fA * vec3f(sin(fk * p.y + U.fw.z), sin(fk * p.z + U.fw.w), sin(fk * p.x + U.fp.x));
}
// Derivative of the warp displacement (columns d/dx, d/dy, d/dz).
fn sr_warpJ(p: vec3f) -> mat3x3f {
  let k = U.warp.x; let A = U.warp.y; let a = U.warp.z; let b = U.warp.w; let c = U.misc.z;
  let k2 = k * 1.7;
  let fk = U.fw.x; let fA = U.fw.y;
  return mat3x3f(
    vec3f(0.0, A * 0.45 * k2 * cos(k2 * p.x + a), A * k * cos(k * p.x + c) + fA * fk * cos(fk * p.x + U.fp.x)),
    vec3f(A * k * cos(k * p.y + a) + fA * fk * cos(fk * p.y + U.fw.z), 0.0, A * 0.45 * k2 * cos(k2 * p.y - b)),
    vec3f(A * 0.45 * k2 * cos(k2 * p.z - c), A * k * cos(k * p.z + b) + fA * fk * cos(fk * p.z + U.fw.w), 0.0));
}

fn sr_cr(a: vec3f, b: vec3f, c: vec3f, d: vec3f, t: f32) -> vec3f {
  let t2 = t * t;
  return 0.5 * (2.0 * b + (c - a) * t + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2 + (3.0 * b - a - 3.0 * c + d) * t2 * t);
}
fn sr_crd(a: vec3f, b: vec3f, c: vec3f, d: vec3f, t: f32) -> vec3f {
  return 0.5 * ((c - a) + 2.0 * (2.0 * a - 5.0 * b + 4.0 * c - d) * t + 3.0 * (3.0 * b - a - 3.0 * c + d) * t * t);
}

// One process (prev, next, arrival) between two samples: interpolated where both belong to the same
// front (arrival times close), else taken from the nearer sample (a front boundary).
fn sr_proc(a: vec4f, b: vec4f, t: f32) -> vec3f {
  return select(select(b.xyz, a.xyz, t < 0.5), mix(a.xyz, b.xyz, t), abs(a.z - b.z) < 0.3);
}

// Cross-section of the silk (offset along the normal, and its slope): a cupped curl, an S-fold and a
// shallow wave, mixed by the fold state.
fn sr_shape(v: f32, sg: f32, seed: f32) -> vec2f {
  let a = sin(sg * 1.9 + seed * 3.0);
  let b = sin(sg * 1.3 + 1.7 + seed * 5.0);
  let c = sin(sg * 2.7 + 4.1 + seed * 7.0);
  let off = 0.55 * a * (v * v - 0.333) + 0.3 * b * sin(PI * v) + 0.1 * c * cos(2.5 * PI * v);
  let d = 1.1 * a * v + 0.3 * PI * b * cos(PI * v) - 0.25 * PI * c * sin(2.5 * PI * v);
  return vec2f(off, d);
}

@vertex fn vsR(@builtin(vertex_index) vi: u32, @builtin(instance_index) ri: u32) -> VOut {
  var o: VOut;
  let ra = U.rib[ri * 2u];
  let rb = U.rib[ri * 2u + 1u];
  let cnt = u32(ra.w);
  if (cnt < 4u) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let row = vi / SR_NC;
  let col = vi % SR_NC;
  let fmax = f32(cnt - 1u);
  let f = min(f32(row) / SR_SUB, fmax);
  let j = min(u32(f), cnt - 2u);
  let t = f - f32(j);
  let j0 = max(j, 1u) - 1u;
  let j2 = j + 1u;
  let j3 = min(j + 2u, cnt - 1u);
  let a0 = sr_at(ri, j0, 0u).xyz;
  let a1 = sr_at(ri, j, 0u).xyz;
  let a2 = sr_at(ri, j2, 0u).xyz;
  let a3 = sr_at(ri, j3, 0u).xyz;
  let c = sr_cr(a0, a1, a2, a3, t);
  var tg = sr_crd(a0, a1, a2, a3, t);
  if (dot(tg, tg) < 1e-10) { tg = a2 - a1 + vec3f(0.0, 1e-5, 0.0); }
  let T = normalize(tg);
  let w1 = sr_at(ri, j, 1u);
  let w2 = sr_at(ri, j2, 1u);
  var W = mix(w1.xyz, w2.xyz, t);
  W = W - T * dot(W, T);
  W = normalize(W + vec3f(1e-7, 0.0, 0.0));
  let N = cross(T, W);
  let sArc = mix(w1.w, w2.w, t) * U.misc.w;
  let v = f32(col) / f32(SR_NC - 1u) * 2.0 - 1.0;
  let clock = U.eye.w;
  let frac = rb.x;
  // The tip unfurls from the emitter; the oldest silk thins away.
  let headArc = select(f * frac, f - 1.0 + frac, f > 1.0);
  let tailDist = fmax - f - frac * rb.y;
  var alphaMul = smoothstep(0.0, 3.0, headArc) * smoothstep(0.0, 45.0, tailDist);
  let hw = ra.y * (0.3 + 0.7 * smoothstep(0.0, 10.0, headArc)) * (0.8 + 0.2 * smoothstep(0.0, 70.0, tailDist))
    * (1.0 + U.fe.y * sin(sArc * U.fe.z + U.fe.w + rb.z * 20.0));

  let s1 = sr_at(ri, j, 2u); let s2 = sr_at(ri, j2, 2u);
  let s3 = sr_at(ri, j, 3u); let s4 = sr_at(ri, j2, 3u);
  let s5 = sr_at(ri, j, 4u); let s6 = sr_at(ri, j2, 4u);
  let kp = sr_proc(s1, s2, t);
  let sp = sr_proc(s3, s4, t);
  let dp = sr_proc(s5, s6, t);
  // The strength of the note whose dye front reached here (taken like the dye process itself).
  let l1 = sr_at(ri, j, 5u).x; let l2 = sr_at(ri, j2, 5u).x;
  let dl = select(select(l2, l1, t < 0.5), mix(l1, l2, t), abs(s5.z - s6.z) < 0.3);
  let baked = mix(vec3f(s1.w, s3.w, s5.w), vec3f(s2.w, s4.w, s6.w), t);

  // The fold: snare fronts carry a new cross-section down the silk (edges first).
  let sAge = clock - sp.z;
  let sg = mix(sp.x, sp.y, smoothstep(0.0, 0.45, sAge - 0.04 * (1.0 - v * v))) + U.fold.y + 0.25 * sin(sArc * 0.17 + rb.z * 9.0);
  let sh = sr_shape(v, sg, rb.z);
  let amp = U.fold.x;
  let p0 = c + W * (v * hw) + N * (hw * amp * sh.x);
  // Through the warp: positions, and the frame by its Jacobian.
  let J = sr_warpJ(p0);
  let p = sr_warp(p0);
  let n0 = N - W * (amp * sh.y);
  let nrm = normalize(n0 - transpose(J) * n0);
  let b0 = W + N * (amp * sh.y);
  let bin = normalize(b0 + J * b0);
  let Tw = normalize(T + J * T);
  let dist = length(p - U.eye.xyz);
  alphaMul *= smoothstep(U.fog.y, U.fog.y + 0.9, dist);

  o.pos = U.vp * vec4f(p, 1.0);
  o.wp = vec4f(p, v);
  o.nrm = vec4f(nrm, f);
  o.tan = vec4f(Tw, sArc);
  o.bin = vec4f(bin, alphaMul);
  o.kst = vec4f(kp.x, kp.y, clock - kp.z, dl);
  o.sst = vec4f(sp.x, sp.y, sAge, sg);
  o.dst = vec4f(dp.x, dp.y, clock - dp.z, baked.x);
  o.bk = vec4f(baked.y, baked.z, f32(ri), hw);
  return o;
}

fn sr_n1(x: f32) -> f32 {
  let i = floor(x);
  let f = x - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), u) * 2.0 - 1.0;
}

// The smoothed spectrum, low to high across 0..1 (the ribbon's centre line to its edges).
fn sr_band(x: f32) -> f32 {
  let b = vec4f(U.fog.z, U.fog.w, U.misc.x, U.misc.y);
  let f = sat(x) * 3.0;
  let lo = select(select(b.z, b.y, f < 2.0), b.x, f < 1.0);
  let hi = select(select(b.w, b.z, f < 2.0), b.y, f < 1.0);
  return mix(lo, hi, smoothstep(0.0, 1.0, fract(min(f, 2.999))));
}

// Thin-film interference (film index 1.38 in air) for two wavelengths per channel.
fn sr_film(d: f32, cosI: f32) -> vec3f {
  let nf = 1.38;
  let cosT = sqrt(max(1.0 - (1.0 - cosI * cosI) / (nf * nf), 0.0));
  let opd = 2.0 * nf * d * cosT;
  let a = cos(TAU * opd * vec3f(1.0 / 650.0, 1.0 / 540.0, 1.0 / 455.0));
  let b = cos(TAU * opd * vec3f(1.0 / 605.0, 1.0 / 510.0, 1.0 / 430.0));
  return 0.5 + 0.25 * (a + b);
}

// Kajiya-Kay highlight along the fibres (silk's stretched sheen), kept to the lit side.
fn sr_kk(T: vec3f, H: vec3f, n: vec3f) -> f32 {
  let th = dot(T, H);
  let s = sqrt(max(1.0 - th * th, 0.0));
  return (pow(s, 120.0) * 0.9 + pow(s, 16.0) * 0.12) * sat(dot(n, H) * 1.6 + 0.25);
}

// A light pulse that swells in from nothing and dies away: 0 at age 0, peaks at 1 when age = tau.
fn sr_pulse(age: f32, tau: f32) -> f32 {
  let x = max(age, 0.0) / tau;
  return x * exp(1.0 - x);
}

// Blackbody-like colour of the burning silk, by temperature 0..1.
fn sr_heat(x: f32) -> vec3f {
  let a = mix(vec3f(0.7, 0.12, 0.02), vec3f(1.0, 0.45, 0.08), smoothstep(0.0, 0.35, x));
  let b = mix(a, vec3f(1.0, 0.78, 0.36), smoothstep(0.3, 0.7, x));
  return mix(b, vec3f(1.0, 0.95, 0.85), smoothstep(0.75, 1.0, x));
}

struct FOut { @location(0) acc: vec4f, @location(1) rev: vec4f };

@fragment fn fsR(in: VOut) -> FOut {
  let ri = u32(in.bk.z + 0.5);
  let ra = U.rib[ri * 2u];
  let rb = U.rib[ri * 2u + 1u];
  let p = in.wp.xyz;
  let v = in.wp.w;
  let toE = U.eye.xyz - p;
  let dist = max(length(toE), 1e-3);
  let V = toE / dist;
  var n = normalize(in.nrm.xyz);
  if (dot(n, V) < 0.0) { n = -n; }
  let Tt = normalize(in.tan.xyz);
  let Bv = normalize(in.bin.xyz);
  let sArc = in.tan.w;
  let seed = rb.z;
  let fwv = max(fwidth(v), 1e-5);
  // Threads run along the silk, never finer than a few pixels.
  let fib = min(60.0 * U.fe.x, 0.3 / fwv);
  let rag = 0.025 * sr_n1(v * 1.6 + seed * 31.0) + 0.025 * sr_n1(sArc * 1.1 + v * 1.2);

  // Kick: the burn front. White at the edge, through yellow and orange, embers along the threads,
  // then the film settles into its new colour.
  // The ragged edge only ever delays the front, so nothing lights before the event itself.
  let ka = in.kst.z - rag - 0.05;
  let kOn = select(0.0, 1.0, ka > 0.0);
  let kx = max(ka, 0.0);
  let kStr = sat(abs(in.kst.y - in.kst.x) * 1.8);
  let kS = mix(in.kst.x, in.kst.y, smoothstep(0.0, 0.4, ka));
  // Temperature swells behind the front to white-hot, then cools through gold, orange, ember red.
  let temp = sr_pulse(kx, 0.07) * kOn;
  let e2 = sr_pulse(kx, 0.06) * kOn;
  let thread = pow(0.5 + 0.5 * sr_n1(v * fib * 0.5 + seed * 7.0 + sr_n1(sArc * 1.7) * 1.5), 4.0);
  let ember = exp(-kx / 0.5) * smoothstep(0.0, 0.2, kx) * kOn * thread;
  let burn = sr_heat(temp) * (0.85 * pow(temp, 1.1)) + vec3f(1.0, 0.28, 0.05) * ember * 0.35;

  // Snare: a sharp cool glint carrying the new fold and its new fine pleats.
  let sa = in.sst.z - rag * 0.6 - 0.03;
  let sStr = sat(abs(in.sst.y - in.sst.x) * 1.5);
  let sOn = select(0.0, 1.0, sa > 0.0);
  let glint = sr_pulse(sa, 0.06) * 0.4 * sOn * sStr;
  let sgF = mix(in.sst.x, in.sst.y, smoothstep(0.0, 0.45, sa)) + U.fold.y;

  // Melody: the note's dye spreads back from where the silk unfurled.
  let da = in.dst.z - rag * 0.5 - 0.025;
  let dye = mix(in.dst.x, in.dst.y, smoothstep(0.0, 0.4, da));
  let dStr = sat(abs(in.dst.y - in.dst.x) * 12.0) * in.kst.w;
  let noteGlow = (0.4 * sr_pulse(da, 0.07) + 0.04 * sr_pulse(da, 0.3)) * select(0.0, 1.0, da > 0.0) * dStr;

  // Fine pleats, fading out before they reach pixel size.
  let pk = mix(12.0, 30.0, 0.5 + 0.5 * sin(sgF * 2.3 + seed * 11.0)) * U.fp.y;
  let pf = sat(1.6 - pk * fwv * 2.5);
  let pph = v * pk + 1.4 * sin(sArc * 0.6 + sgF * 1.7 + U.fp.z);
  n = normalize(n + Bv * cos(pph) * U.fold.z * U.fp.w * pf);
  let cosV = sat(abs(dot(n, V)));

  // Thin film: thickness from the kick state, across the width, along the length, the timbre the
  // silk was born with, and the live spectrum across the width.
  let thick = U.film.x + U.film.y * kS + 60.0 * v + 40.0 * sin(sArc * 0.11 + seed * 6.0)
    + (in.dst.w - 0.5) * 170.0 + 110.0 * (sr_band(abs(v)) - 0.3) + 70.0 * sin(sgF * 1.3 + seed * 4.0);
  let film = sr_film(thick, cosV);
  let filmS = max(mix(vec3f(luma(film)), film, 2.0), vec3f(0.0));
  let hr = rb.w;
  let irPal = sr_colR(dye + thick / 900.0 + (1.0 - cosV) * 0.3, 0.62, hr);
  let irid = mix(irPal, filmS * 1.1, U.film.z);
  // Each kick the front passes leaves the silk itself a new shade, not just its sheen.
  let tone = dye + 0.32 * kS;
  let dyeCol = sr_colR(tone, 0.32, hr);
  let deepCol = sr_colR(tone + 0.05, 0.045, hr);
  // Light through dyed silk comes out deeper in colour.
  let passCol = dyeCol * dyeCol / max(luma(dyeCol), 0.01);

  let aBase = ra.z;
  let Lk = normalize(U.key.xyz);
  let Lf = normalize(U.fill.xyz);
  let nk = dot(n, Lk);
  let nf = dot(n, Lf);
  let through = pow(sat(dot(-V, Lk)), 3.0);
  let keyC = vec3f(1.0, 0.92, 0.84) * U.key.w;
  let fillC = mix(palL(U.bg.x + 0.5, 1.0), vec3f(1.0), 0.4) * U.fill.w;
  // The body: deep in the shadowed folds, the dye where lit, glowing where light comes through.
  let lit = keyC * max(nk, 0.0) * 0.55 + fillC * max(nf, 0.0) * 0.9;
  let diffuse = deepCol + dyeCol * lit;
  let transl = passCol * keyC * (max(-nk, 0.0) * 0.55 + through * 0.6) * (1.2 - aBase);
  let Hk = normalize(Lk + V);
  let Hf = normalize(Lf + V);
  let shine = sr_kk(Tt, Hk, n) * keyC + sr_kk(Tt, Hf, n) * fillC * 0.8;
  let sheen = pow(1.0 - cosV, 5.0) * U.fold.w * 0.6;
  let hem = smoothstep(1.0 - 3.0 * fwv - 0.03, 1.0 - fwv, abs(v));
  let iriStr = U.film.w * (0.75 + 0.5 * in.bk.y);
  var col = diffuse + transl + irid * (shine * 1.3 + sheen * 0.7 + hem * 0.15) * iriStr;
  let glintCol = mix(sr_colR(dye + 0.5, 1.0, hr), vec3f(1.0), 0.2) * 2.2;
  col += burn * kStr + glintCol * glint + mix(sr_colR(dye, 1.0, hr), vec3f(1.0), 0.1) * noteGlow * 2.2;
  // Dyed silk, not pastel: push the colour away from grey.
  col = max(mix(vec3f(luma(col)), col, 1.75), vec3f(0.0));

  var a = mix(aBase, 0.9, pow(1.0 - cosV, 2.5) * 0.8);
  a = max(a, sat(e2 * kStr * 0.35 + glint * 0.3 + noteGlow * 0.35));
  let edgeA = 1.0 - smoothstep(1.0 - 1.5 * fwv, 1.0 + 0.5 * fwv, abs(v));
  a *= edgeA * in.bin.w;

  // Depth: far silk sinks into the dark and thins.
  let fogA = 1.0 - exp(-max(dist - 3.0, 0.0) * U.fog.x);
  col = mix(col, sr_bg(-V) * 0.8, fogA * 0.85);
  a *= 1.0 - fogA * 0.6;

  let w = clamp(pow(6.0 / dist, 5.0) * 0.006, 0.001, 200.0);
  var o: FOut;
  o.acc = vec4f(col * a, a) * w;
  o.rev = vec4f(a);
  return o;
}
`;

const COMPOSITE_WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> U: RU;
@group(1) @binding(1) var accT: texture_2d<f32>;
@group(1) @binding(2) var revT: texture_2d<f32>;

@fragment fn fsC(in: VsOut) -> @location(0) vec4f {
  let px = vec2i(in.pos.xy);
  let acc = textureLoad(accT, px, 0);
  let rv = textureLoad(revT, px, 0).r;
  let col = acc.rgb / max(acc.a, 1e-5);
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let rd = normalize(U.fwd.xyz + U.right.xyz * ndc.x * U.right.w * U.fwd.w + U.up.xyz * ndc.y * U.fwd.w);
  return vec4f(col * (1.0 - rv) + sr_bg(rd) * rv, 1.0);
}
`;

const PARTICLE_WGSL = /* wgsl */ `
struct Particle { pos: vec4f, vel: vec4f, col: vec4f };
`;

const SIM_WGSL = /* wgsl */ `
struct SpawnU { head: vec4f, head2: vec4f, rec: array<vec4f, ${MAX_REC * 5}> };
@group(1) @binding(0) var<uniform> U: RU;
@group(1) @binding(1) var<storage, read_write> parts: array<Particle>;
@group(1) @binding(2) var<uniform> SP: SpawnU;

@compute @workgroup_size(256) fn csP(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let np = u32(SP.head.w);
  if (i >= np) { return; }
  var p = parts[i];
  if (SP.head2.y > 0.5) { p.pos.w = 0.0; }
  let start = u32(SP.head.x);
  let total = u32(SP.head.y);
  let rel = (i + np - start) % np;
  let dt = SP.head.z;
  if (rel < total) {
    let nrec = u32(SP.head2.w);
    var k = 0u;
    for (var q = 0u; q < nrec; q++) {
      if (f32(rel) >= SP.rec[q * 5u].w) { k = q; }
    }
    let r0 = SP.rec[k * 5u];
    let r1 = SP.rec[k * 5u + 1u];
    let r2 = SP.rec[k * 5u + 2u];
    let r3 = SP.rec[k * 5u + 3u];
    let r4 = SP.rec[k * 5u + 4u];
    let h = hashU3(i * 1664525u + u32(F.frame) * 1013904223u);
    let h2 = hashU3(i * 22695477u + u32(F.frame) * 747796405u + 7u);
    let u = sat((f32(rel) - r0.w + h.x) / max(r1.w, 1.0));
    let pos = mix(r0.xyz, r1.xyz, u) + (h2 - 0.5) * 0.04;
    var sgn = 1.0;
    if (r4.y > 0.5 && h.y < 0.5) { sgn = -1.0; }
    let rnd = normalize(h2 * 2.0 - 1.0 + vec3f(1e-4)) * r4.x * (0.3 + 0.7 * h.z);
    let mode = r2.x;
    var c = vec3f(1.0, 0.62, 0.25) * r2.z;
    if (mode > 0.5) { c = sr_colR(r2.y + (h.z - 0.5) * 0.08, r2.z, r4.z); }
    if (mode > 1.5) { c = mix(c, vec3f(r2.z), 0.45); }
    let life = r2.w * (0.55 + 0.9 * h.z);
    p.pos = vec4f(pos, life);
    p.vel = vec4f(r3.xyz * sgn * (0.5 + 0.9 * h.y) + rnd, life);
    p.col = vec4f(c, mode * 10.0 + r3.w * (0.6 + 0.8 * h2.x));
  } else if (p.pos.w > 0.0) {
    let drift = curl3(p.pos.xyz * 0.45 + vec3f(0.0, 0.0, SP.head2.x * 0.03)) * 0.04;
    let vel = p.vel.xyz * exp(-dt * 2.6) + drift * dt;
    p.vel = vec4f(vel, p.vel.w);
    p.pos = vec4f(p.pos.xyz + vel * dt, p.pos.w - dt);
  }
  parts[i] = p;
}
`;

const SPARK_WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> U: RU;
@group(1) @binding(1) var<storage, read> parts: array<Particle>;
struct SOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) color: vec3f, @location(2) stretch: f32 };

@vertex fn vsS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SOut {
  var o: SOut;
  let pt = parts[ii];
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  if (pt.pos.w <= 0.0) { return o; }
  let clip = U.vp * vec4f(pt.pos.xyz, 1.0);
  let prevC = U.vp * vec4f(pt.pos.xyz - pt.vel.xyz * 0.025, 1.0);
  if (clip.w < 0.5 || prevC.w < 0.5) { return o; }
  let res = F.res;
  let a = clip.xy / clip.w * res * 0.5;
  let b = prevC.xy / prevC.w * res * 0.5;
  let mode = floor(pt.col.w / 10.0);
  let size = pt.col.w - mode * 10.0;
  let focal = res.y * 0.5 / U.fwd.w;
  let sz = size * focal / clip.w;
  let sizePx = clamp(sz, 0.8, 9.0);
  var dir = a - b;
  let len = min(length(dir), 60.0);
  dir = select(vec2f(1.0, 0.0), dir / max(length(dir), 1e-5), len > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let halfLen = len * 0.5 + sizePx;
  let center = (a + b) * 0.5;
  let px = center + dir * c.x * halfLen + nrm * c.y * sizePx;
  o.pos = vec4f(px / (res * 0.5) * clip.w, clip.z, clip.w);
  o.q = vec2f(c.x * halfLen / sizePx, c.y);
  o.stretch = halfLen / sizePx - 1.0;
  let lf = sat(pt.pos.w / max(pt.vel.w, 1e-3));
  var col = pt.col.rgb;
  if (mode < 0.5) { col = col * vec3f(1.0, 0.3 + 0.7 * lf, 0.1 + 0.9 * lf * lf); }
  let fade = sat(lf * 3.0) * smoothstep(0.0, 1.0, (1.0 - lf) * 6.0);
  let cover = min(1.0, sz / 0.8);
  let fogA = exp(-max(clip.w - 2.5, 0.0) * 0.15);
  o.color = col * fade * cover * cover * fogA * smoothstep(0.5, 1.2, clip.w) / (1.0 + len / (sizePx * 2.0));
  return o;
}

@fragment fn fsS(in: SOut) -> @location(0) vec4f {
  let d = vec2f(max(abs(in.q.x) - in.stretch, 0.0), in.q.y);
  return vec4f(in.color * exp(-dot(d, d) * 3.5), 1.0);
}
`;

// ==================================================================== factory

function buildIndices(): Uint32Array<ArrayBuffer> {
  const rows = (L - 1) * SUB + 1;
  const out = new Uint32Array((rows - 1) * (NC - 1) * 6);
  let k = 0;
  for (let i = 0; i < rows - 1; i++)
    for (let c = 0; c < NC - 1; c++) {
      const a = i * NC + c;
      const b = a + 1;
      const d = a + NC;
      const e = d + 1;
      out[k++] = a;
      out[k++] = d;
      out[k++] = b;
      out[k++] = b;
      out[k++] = d;
      out[k++] = e;
    }
  return out;
}

const factory: SceneFactory = {
  meta: META,
  async create(device: GPUDevice, shared: SharedResources) {
    const head = `${BINDINGS_WGSL}\n${COMMON_WGSL}\n`;
    const V = GPUShaderStage.VERTEX;
    const Fs = GPUShaderStage.FRAGMENT;
    const C = GPUShaderStage.COMPUTE;
    const [ribbonM, compM, simM, sparkM] = await Promise.all([
      compileModule(device, `${head}${RU_WGSL}\n${RIBBON_WGSL}`,'silk-ribbons'),
      compileModule(device, `${head}${RU_WGSL}\n${FULLSCREEN_VS}\n${COMPOSITE_WGSL}`, 'silk-composite'),
      compileModule(device, `${head}${RU_WGSL}\n${PARTICLE_WGSL}\n${SIM_WGSL}`, 'silk-sparks-sim'),
      compileModule(device, `${head}${RU_WGSL}\n${PARTICLE_WGSL}\n${SPARK_WGSL}`, 'silk-sparks'),
    ]);
    const ribbonLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: V | Fs, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
      ],
    });
    const compLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: Fs, buffer: { type: 'uniform' } },
        { binding: 1, visibility: Fs, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: Fs, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const simLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, buffer: { type: 'uniform' } },
      ],
    });
    const sparkLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: V | Fs, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pl = (l: GPUBindGroupLayout) => device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, l] });
    const add1: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
    const reveal: GPUBlendComponent = { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' };
    const [ribbon, comp, sim, spark] = await Promise.all([
      device.createRenderPipelineAsync({
        label: 'silk-ribbons',
        layout: pl(ribbonLayout),
        vertex: { module: ribbonM, entryPoint: 'vsR' },
        fragment: {
          module: ribbonM,
          entryPoint: 'fsR',
          targets: [
            { format: 'rgba16float', blend: { color: add1, alpha: add1 } },
            { format: 'r16float', blend: { color: reveal, alpha: reveal } },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count: 4 },
      }),
      device.createRenderPipelineAsync({
        label: 'silk-composite',
        layout: pl(compLayout),
        vertex: { module: compM, entryPoint: 'vs' },
        fragment: { module: compM, entryPoint: 'fsC', targets: [{ format: HDR_FORMAT }] },
      }),
      device.createComputePipelineAsync({ label: 'silk-sparks-sim', layout: pl(simLayout), compute: { module: simM, entryPoint: 'csP' } }),
      device.createRenderPipelineAsync({
        label: 'silk-sparks',
        layout: pl(sparkLayout),
        vertex: { module: sparkM, entryPoint: 'vsS' },
        fragment: { module: sparkM, entryPoint: 'fsS', targets: [{ format: HDR_FORMAT, blend: { color: add1, alpha: add1 } }] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);
    const U = GPUBufferUsage;
    const uBuf = device.createBuffer({ label: 'silk-u', size: 148 * 4, usage: U.UNIFORM | U.COPY_DST });
    const sampleBuf = device.createBuffer({ label: 'silk-samples', size: MAX_RIB * L * GPU_STRIDE * 4, usage: U.STORAGE | U.COPY_DST });
    const spawnBuf = device.createBuffer({ label: 'silk-spawn', size: (8 + MAX_REC * REC_F) * 4, usage: U.UNIFORM | U.COPY_DST });
    const partBuf = device.createBuffer({ label: 'silk-sparks', size: NP * 48, usage: U.STORAGE });
    const indices = buildIndices();
    const indexBuf = device.createBuffer({ label: 'silk-index', size: indices.byteLength, usage: U.INDEX | U.COPY_DST });
    device.queue.writeBuffer(indexBuf, 0, indices);
    const paramBuffer = shared.createSceneParamBuffer('silk-ribbons-params');
    const group0 = shared.createSceneBindGroup(paramBuffer, 'silk-ribbons');
    const groups = {
      ribbon: device.createBindGroup({
        layout: ribbonLayout,
        entries: [
          { binding: 0, resource: { buffer: uBuf } },
          { binding: 1, resource: { buffer: sampleBuf } },
        ],
      }),
      sim: device.createBindGroup({
        layout: simLayout,
        entries: [
          { binding: 0, resource: { buffer: uBuf } },
          { binding: 1, resource: { buffer: partBuf } },
          { binding: 2, resource: { buffer: spawnBuf } },
        ],
      }),
      spark: device.createBindGroup({
        layout: sparkLayout,
        entries: [
          { binding: 0, resource: { buffer: uBuf } },
          { binding: 1, resource: { buffer: partBuf } },
        ],
      }),
    };
    return new SilkInstance(
      device,
      group0,
      [uBuf, sampleBuf, spawnBuf, partBuf, indexBuf, paramBuffer],
      { u: uBuf, samples: sampleBuf, spawn: spawnBuf, index: indexBuf, indexCount: indices.length },
      { ribbon, comp, sim, spark },
      groups,
      compLayout,
    );
  },
};

export default factory;
