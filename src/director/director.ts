import { rng } from '../audio/analysis/util';
import { lowerIndex } from '../audio/analysis/util';
import type { MusicState } from '../audio/musicState';
import type { GenreId, GenreScore, Section, TrackAnalysis } from '../audio/types';
import { TransitionKind, type PostParams } from '../gpu/postLayout';
import { composeOne, LAYERS, LAYOUTS } from '../sculpt/compose';
import { planJourney } from '../sculpt/journey';
import type { LookMeta } from '../looks/types';
import type { SceneMeta } from '../scenes/types';
import { lerpAngle, pitchHue, type RGB } from './color';
import { DNA_GENES, trace, type CueStyle, type Genome, type GenomeTrace, type Fuse, FUSE_MODES } from './genome';
import { NoveltyMemory } from './novelty';
import { PALETTE_SCHEMES, schemeWeights } from './palette';

/** One scheduled visual: which genome, from when, and how it arrives. */
export interface Cue {
  start: number;
  end: number;
  genome: Genome;
  transition: TransitionKind;
  /** Transition length in seconds (0 for cuts). */
  transitionDuration: number;
  sectionIndex: number;
}

export interface VisualFrame {
  sceneA: string;
  dnaA: number[];
  sceneB: string | null;
  dnaB: number[];
  /** Partner worlds fused with A and B (amount already faded across a transition). */
  fuseA: Fuse | null;
  fuseB: Fuse | null;
  transProgress: number;
  transKind: TransitionKind;
  transSeed: number;
  /** Look to apply this frame (null = clean) and its strength. */
  lookId: string | null;
  lookAmount: number;
  lookDna: number[];
  palette: [RGB, RGB, RGB, RGB];
  morph: [number, number, number, number];
  morph2: [number, number, number, number];
  /** Slowly wandering 0..1 values (periods ~45-115 s) so long cues keep evolving. */
  evolve: [number, number, number, number];
  travel: number;
  spin: number;
  warp: number;
  intensity: number;
  seed: number;
  post: PostParams;
  cue: Cue | null;
}

const PSYCHEDELIC: Partial<Record<GenreId, number>> = { edm: 1, techno: 0.8, dnb: 0.6, dubstep: 0.7, ambient: 0.7, synthwave: 0.5, lofi: 0.3 };

function genreWeight(genres: GenreScore[], table: Partial<Record<GenreId, number>>, fallback = 0.2): number {
  let s = 0;
  let z = 0;
  for (const g of genres.slice(0, 4)) {
    s += g.confidence * (table[g.id] ?? fallback);
    z += g.confidence;
  }
  return z > 0 ? s / z : fallback;
}

const EVOLVE_PERIODS = [47, 71, 89, 113];

export interface DirectorOptions {
  compose?: boolean;
  /** With compose: one continuous journey per song. */
  journey?: boolean;
  /** A journey through the world library: a world per section. */
  worlds?: boolean;
  looks?: LookMeta[];
  memory?: NoveltyMemory;
  /** Wall-clock epoch ms corresponding to song time 0 (for novelty timestamps). */
  epoch?: number;
}

/** Builds the whole-track show from the analysis, then animates it frame by frame. */
export class Director {
  readonly cues: Cue[];
  private readonly frame: VisualFrame;
  private pinned: string | null = null;
  /** Debug: force every scene's DNA from one seed (null = follow the show plan). */
  forcedVariant: number | null = null;
  /** Debug: fuse a partner world with whatever is shown (null = follow the plan). */
  forcedFuse: Fuse | null = null;
  /** Debug: force a look (undefined = follow plan, null = clean). */
  forcedLook: string | null | undefined = undefined;
  /** Debug: force the look genes. */
  forcedLookDna: number[] | null = null;
  private pinnedSince = -Infinity;
  private pinnedFrom: string | null = null;
  private lastTime = 0;
  private hue = 0;
  private hueMid = 0;
  private morphTarget: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5];
  private morph2Target: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5];
  private lastChordIndex = -2;
  private lastCueIndex = -1;
  private readonly evolvePhase = [0.3, 1.9, 3.7, 5.1];
  private kickDrive = 0;
  private readonly smooth: Record<string, number> = {};
  private readonly looks: LookMeta[];
  private readonly memory: NoveltyMemory;
  private readonly live: {
    current: Genome | null;
    next: Genome | null;
    transStart: number;
    lastSwitch: number;
    rand: () => number;
    history: { g: GenomeTrace; at: number; dur: number }[];
  };

  constructor(
    private readonly scenes: SceneMeta[],
    private readonly analysis: TrackAnalysis | null,
    opts: DirectorOptions = {},
  ) {
    this.looks = opts.looks ?? [];
    this.memory = opts.memory ?? new NoveltyMemory(null);
    const epoch = opts.epoch ?? Date.now();
    this.cues = analysis ? planShow(analysis, scenes, { looks: this.looks, memory: this.memory, epoch, compose: opts.compose, journey: opts.journey, worlds: opts.worlds }) : [];
    this.live = { current: null, next: null, transStart: 0, lastSwitch: 0, rand: rng((epoch & 0x7fffffff) ^ 0x51ed), history: [] };
    const first = this.cues[0]?.genome;
    this.hue = analysis ? pitchHue(analysis.key.root) : 280;
    this.hueMid = this.hue;
    this.frame = {
      sceneA: first?.sceneId ?? scenes[0].id,
      dnaA: first?.dna ?? new Array(DNA_GENES).fill(0.37),
      sceneB: null,
      dnaB: new Array(DNA_GENES).fill(0.5),
      fuseA: null,
      fuseB: null,
      transProgress: 0,
      transKind: TransitionKind.Dissolve,
      transSeed: 0,
      lookId: null,
      lookAmount: 0,
      lookDna: [0.5, 0.5, 0.5, 0.5],
      palette: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      morph: [0.5, 0.5, 0.5, 0.5],
      morph2: [0.5, 0.5, 0.5, 0.5],
      evolve: [0.5, 0.5, 0.5, 0.5],
      travel: 0,
      spin: 0,
      warp: 0,
      intensity: 0,
      seed: 0,
      post: defaultPost(),
      cue: this.cues[0] ?? null,
    };
  }

  get pinnedScene(): string | null {
    return this.pinned;
  }

  /** Scene ids the director wants ready soon (current plan), for shader prefetch. */
  get plannedScenes(): string[] {
    return [...new Set(this.cues.flatMap((c) => (c.genome.fuse ? [c.genome.sceneId, c.genome.fuse.sceneId] : [c.genome.sceneId])))];
  }

  /** Generated compositions this show needs (to register and compile ahead of time). */
  get plannedCompositions() {
    const seen = new Map<string, NonNullable<Genome['composition']>>();
    for (const c of this.cues) if (c.genome.composition) seen.set(c.genome.composition.id, c.genome.composition);
    return [...seen.values()];
  }

  get plannedLooks(): string[] {
    return [...new Set(this.cues.map((c) => c.genome.lookId).filter((x): x is string => !!x))];
  }

  /** Pins a scene (null returns control to the show plan). */
  pin(sceneId: string | null, now: number): void {
    if (sceneId === this.pinned) return;
    this.pinnedFrom = this.frame.sceneB ?? this.frame.sceneA;
    this.pinned = sceneId;
    this.pinnedSince = now;
  }

  cueIndexAt(t: number): number {
    const c = this.cues;
    if (!c.length) return -1;
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  update(m: MusicState, dt: number, wallTime: number): VisualFrame {
    const f = this.frame;
    const t = m.time;
    const seeked = Math.abs(t - this.lastTime) > 1;
    this.lastTime = t;

    // ----- scene schedule -----
    const ci = this.cueIndexAt(t);
    const cue = ci >= 0 ? this.cues[ci] : null;
    const next = ci + 1 < this.cues.length ? this.cues[ci + 1] : null;
    f.cue = cue;
    let gA: Genome | null = cue?.genome ?? null;
    let gB: Genome | null = null;
    f.sceneB = null;
    if (!this.cues.length) {
      [gA, gB] = this.liveSchedule(m, wallTime);
    } else if (cue) {
      // Look-ahead: transitions start before the boundary so they land on it.
      const pre = next ? next.transitionDuration * 0.5 : 0;
      const post = cue.transitionDuration * 0.5;
      const prev = ci > 0 ? this.cues[ci - 1] : null;
      if (next && next.transitionDuration > 0 && t >= next.start - pre) {
        gB = next.genome;
        f.transProgress = (t - (next.start - pre)) / next.transitionDuration;
        f.transKind = next.transition;
      } else if (prev && cue.transitionDuration > 0 && t < cue.start + post) {
        gA = prev.genome;
        gB = cue.genome;
        f.transProgress = (t - (cue.start - post)) / cue.transitionDuration;
        f.transKind = cue.transition;
      }
      if (ci !== this.lastCueIndex) {
        this.lastCueIndex = ci;
        const r = rng(Math.floor(cue.genome.dna[1] * 1e6) + 7);
        this.morphTarget = [r(), r(), r(), r()];
        this.memory.record(trace(cue.genome), Date.now(), cue.end - cue.start);
      }
    }
    if (gA) {
      f.sceneA = gA.sceneId;
      f.dnaA = gA.dna;
    }
    if (gB) {
      f.sceneB = gB.sceneId;
      f.dnaB = gB.dna;
      f.transSeed = gB.dna[2];
    }
    f.transProgress = Math.min(1, Math.max(0, f.transProgress));

    // Pinning overrides the scene but keeps the planned DNA/look so it still varies.
    if (this.pinned) {
      const elapsed = wallTime - this.pinnedSince;
      const dur = 1.2;
      const dna = (gB && f.transProgress > 0.5 ? gB : gA)?.dna ?? f.dnaA;
      if (elapsed < dur && this.pinnedFrom && this.pinnedFrom !== this.pinned) {
        f.sceneA = this.pinnedFrom;
        f.sceneB = this.pinned;
        f.transProgress = elapsed / dur;
        f.transKind = TransitionKind.Dissolve;
      } else {
        f.sceneA = this.pinned;
        f.sceneB = null;
      }
      f.dnaA = f.dnaB = dna;
    }
    if (this.forcedVariant !== null) {
      const v = this.forcedVariant;
      const dna = Array.from({ length: DNA_GENES }, (_, i) => (i === 0 ? v : (v * (i + 1) * 1.618 + i * 0.37) % 1));
      f.dnaA = f.dnaB = dna;
    }
    if (f.sceneB === f.sceneA) f.sceneB = null;

    // ----- fusion: the outgoing partner fades over the first half of a transition, the incoming over the second -----
    const fade = (fu: Fuse | undefined, k: number): Fuse | null => (fu && k > 0.01 ? { ...fu, amount: fu.amount * k } : null);
    const tp = f.sceneB ? f.transProgress : 0;
    f.fuseA = this.liveFuse(gA, t, fade, f.sceneB ? 1 - Math.min(1, tp * 2) : 1);
    f.fuseB = f.sceneB ? this.liveFuse(gB, t, fade, Math.max(0, tp * 2 - 1)) : null;
    if (this.pinned) f.fuseA = f.fuseB = null;
    if (this.forcedFuse) {
      f.fuseA = this.forcedFuse;
      f.fuseB = null;
    }

    // ----- look: outgoing fades over the first half of a transition, incoming over the second -----
    const lookOf = (g: Genome | null): [string | null, number, number[]] => (g && g.lookId ? [g.lookId, g.lookAmount, g.lookDna] : [null, 0, [0.5, 0.5, 0.5, 0.5]]);
    let [lid, lamt, ldna] = lookOf(gA);
    if (gB && f.sceneB) {
      const p = f.transProgress;
      if (p < 0.5) lamt *= 1 - p * 2;
      else [lid, lamt, ldna] = ((l) => [l[0], l[1] * (p * 2 - 1), l[2]] as [string | null, number, number[]])(lookOf(gB));
    }
    if (this.forcedLook !== undefined) {
      lid = this.forcedLook;
      lamt = this.forcedLook ? 0.85 : 0;
    }
    f.lookId = lid;
    f.lookAmount = lid ? lamt * (1 - 0.3 * m.anticipation) : 0;
    f.lookDna = this.forcedLookDna ?? ldna;

    // ----- morph vectors -----
    if (m.chordIndex !== this.lastChordIndex) {
      this.lastChordIndex = m.chordIndex;
      const c = m.chord;
      const r = rng((c ? c.root * 7 + (c.quality === 'min' ? 3 : c.quality === 'dim' ? 5 : 0) : 99) + 17);
      this.morph2Target = [r(), r(), r(), c ? c.tension : 0.2];
    }
    const beat = 60 / Math.max(40, m.bpm);
    const km = seeked ? 1 : 1 - Math.exp(-dt / (beat * 4));
    const km2 = seeked ? 1 : 1 - Math.exp(-dt / (beat * 0.75));
    for (let i = 0; i < 4; i++) {
      f.morph[i] += (this.morphTarget[i] - f.morph[i]) * km;
      f.morph2[i] += (this.morph2Target[i] - f.morph2[i]) * km2;
      this.evolvePhase[i] += (dt * Math.PI * 2 * (0.6 + 0.8 * m.energySlow)) / EVOLVE_PERIODS[i];
      f.evolve[i] = 0.5 + 0.5 * Math.sin(this.evolvePhase[i]);
    }
    // The frame seed is shared by every world drawn this frame, so it must not change at a cue: during
    // a transition the incoming world would read the outgoing world's seed, then jump to its own the
    // moment the transition handed over. It is fixed for the song; each world varies through its DNA.
    f.seed = this.cues[0]?.genome.dna[0] ?? f.dnaA[0];

    // ----- motion accumulators -----
    const tempo = Math.sqrt(Math.max(60, m.bpm) / 120);
    // Kicks push travel through an eased drive weighted by how loud the passage is, so a faint hit
    // in a quiet intro doesn't jolt every world that reads ctx.travel.
    const kickT = m.kick * Math.min(1, Math.max(0, (m.energySlow - 0.2) / 0.4));
    this.kickDrive += (kickT - this.kickDrive) * (1 - Math.exp(-dt / 0.12));
    f.travel += dt * (0.25 + 1.4 * m.energySlow + 0.5 * this.kickDrive + 1.4 * m.dropPulse + 0.8 * m.anticipation) * tempo;
    f.spin += dt * (0.05 + 0.3 * m.arousal + 0.2 * m.tension + 0.4 * m.dropPulse);
    f.warp += dt * (0.1 + 0.8 * m.flux + 0.3 * m.tension);
    const intensityTarget = Math.min(1, 0.55 * m.energySlow + 0.35 * m.energy + 0.3 * m.anticipation + 0.4 * m.dropPulse);
    f.intensity += (intensityTarget - f.intensity) * (1 - Math.exp(-dt / 0.15));

    this.updatePalette(m, dt, seeked, gA, gB);
    this.updatePost(m, dt, gA, gB, seeked);
    return f;
  }

  /** Without a show plan (live input), switch genomes every ~16 bars or on energy surges. */
  private liveSchedule(m: MusicState, now: number): [Genome, Genome | null] {
    const f = this.frame;
    const L = this.live;
    const pseudo: Section = { start: 0, end: 1, kind: m.energySlow > 0.65 ? 'peak' : 'verse', cluster: 0, energy: m.energySlow, valence: m.valence, arousal: m.arousal };
    const pick = (avoid: string | null) =>
      chooseGenome({
        rand: L.rand,
        scenes: this.scenes.filter((s) => s.id !== avoid),
        looks: this.looks,
        section: pseudo,
        genres: [],
        psychedelic: 0.5,
        memory: this.memory,
        at: Date.now(),
        extra: L.history,
      });
    if (!L.current) {
      L.current = pick(null);
      L.lastSwitch = now;
    }
    const bar = (60 / Math.max(60, m.bpm)) * 4;
    const due = now - L.lastSwitch > Math.max(18, bar * 12) || (m.dropPulse > 0.97 && now - L.lastSwitch > 6);
    if (!L.next && due) {
      L.next = pick(L.current.sceneId);
      L.transStart = now;
    }
    if (L.next) {
      const p = (now - L.transStart) / 2.5;
      if (p >= 1) {
        this.memory.record(trace(L.current), Date.now(), now - L.lastSwitch);
        L.history.push({ g: trace(L.current), at: Date.now(), dur: now - L.lastSwitch });
        L.current = L.next;
        L.next = null;
        L.lastSwitch = now;
        const r = rng(Math.floor(L.current.dna[1] * 1e6));
        this.morphTarget = [r(), r(), r(), r()];
      } else {
        f.transProgress = p;
        f.transKind = m.dropPulse > 0.5 ? TransitionKind.Zoom : TransitionKind.Dissolve;
        return [L.current, L.next];
      }
    }
    return [L.current, null];
  }

  private get barSeconds(): number {
    const a = this.analysis;
    return a ? (60 / a.bpm) * a.beatsPerBar : 2;
  }

  /**
   * The fusion live at time t for a cue's genome: it fades in over the cue's first bar and, at a
   * development, the old partner fades out over the bar before it and the new one in over the bar
   * after it, so a partner change is never a snap.
   */
  private liveFuse(g: Genome | null, t: number, fade: (fu: Fuse | undefined, k: number) => Fuse | null, k: number): Fuse | null {
    if (!g) return null;
    const bar = this.barSeconds;
    const cue = this.cues.find((c) => c.genome === g);
    const sm = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
    const inK = cue && cue.start > 0 ? sm((t - cue.start) / bar) : 1;
    const dev = g.develop;
    if (!dev) return fade(g.fuse, k * inK);
    if (t < dev.at) return fade(g.fuse, k * inK * (1 - sm((t - (dev.at - bar)) / bar)));
    return fade(dev.fuse ?? undefined, k * sm((t - dev.at) / bar));
  }

  /** The palette scheme of a genome at time t, and the weight of its development's scheme. */
  private schemeAt(g: Genome, t: number): [number, number, number] {
    const dev = g.develop;
    if (!dev) return [g.paletteScheme, g.paletteScheme, 0];
    const x = Math.min(1, Math.max(0, (t - (dev.at - this.barSeconds * 0.5)) / this.barSeconds));
    return [g.paletteScheme, dev.paletteScheme, x * x * (3 - 2 * x)];
  }

  private updatePalette(m: MusicState, dt: number, seeked: boolean, gA: Genome | null, gB: Genome | null): void {
    const a = this.analysis;
    const keyRoot = a?.key.root ?? 0;
    let target = pitchHue(keyRoot);
    if (m.chord && m.chord.root >= 0) {
      // Chords pull the hue toward their own place on the circle of fifths.
      target = lerpAngle(target, pitchHue(m.chord.root), 0.35);
    }
    target += gA?.style.hueOffset ?? 0;
    // Every 4 bars the colour cycles on: the hue target steps round the wheel (a DNA-chosen stride,
    // so each world cycles its own way) and the two-stage ease below glides it there.
    if (a && a.downbeats.length) {
      const phrase4 = Math.floor(Math.max(0, lowerIndex(a.downbeats, m.time)) / 4);
      const stride = 40 + 70 * (gA?.dna[3] ?? 0.5);
      target += phrase4 * stride * ((gA?.dna[4] ?? 0) < 0.5 ? 1 : -1);
    }
    // Valence warms, low valence cools.
    target = m.valence > 0.5 ? lerpAngle(target, 55, (m.valence - 0.5) * 0.5) : lerpAngle(target, 255, (0.5 - m.valence) * 0.6);
    // Two cascaded eases: the hue starts moving from rest and glides over about a second, so a
    // chord change recolours the world smoothly, never as a snap.
    const k = seeked ? 1 : 1 - Math.exp(-dt / 0.45);
    this.hueMid = seeked ? target : lerpAngle(this.hueMid, target, k);
    this.hue = lerpAngle(this.hue, this.hueMid, k);
    const input = {
      hue: this.hue,
      arousal: this.ease('ar', m.arousal, dt, 1, seeked),
      valence: this.ease('va', m.valence, dt, 1, seeked),
      tension: this.ease('ten', m.tension, dt, 0.4, seeked),
      spin: this.frame.spin,
    };
    const blendSchemes = (g: Genome): [RGB, RGB, RGB, RGB] => {
      const [s0, s1, w] = this.schemeAt(g, m.time);
      const p0 = PALETTE_SCHEMES[s0 % PALETTE_SCHEMES.length].build(input);
      if (w <= 0) return p0;
      const p1 = PALETTE_SCHEMES[s1 % PALETTE_SCHEMES.length].build(input);
      return p0.map((c, i) => [c[0] + (p1[i][0] - c[0]) * w, c[1] + (p1[i][1] - c[1]) * w, c[2] + (p1[i][2] - c[2]) * w] as RGB) as [RGB, RGB, RGB, RGB];
    };
    const pa = gA ? blendSchemes(gA) : PALETTE_SCHEMES[0].build(input);
    let target4 = pa;
    if (gB && this.frame.sceneB) {
      const pb = blendSchemes(gB);
      const w = this.frame.transProgress;
      target4 = pa.map((c, i) => [c[0] + (pb[i][0] - c[0]) * w, c[1] + (pb[i][1] - c[1]) * w, c[2] + (pb[i][2] - c[2]) * w] as RGB) as typeof pa;
    }
    // Short smoothing hides scheme switches on hard cuts without lagging the music.
    const ks = seeked || this.frame.palette[1][0] + this.frame.palette[1][1] === 0 ? 1 : 1 - Math.exp(-dt / 0.4);
    const p = this.frame.palette;
    for (let i = 0; i < 4; i++) for (let c = 0; c < 3; c++) p[i][c] += (target4[i][c] - p[i][c]) * ks;
  }

  /** 0..1 size of the drop that just landed (energy jump into this section). */
  private dropImpact(m: MusicState): number {
    const a = this.analysis;
    if (!a || m.dropPulse < 0.01 || m.sectionIndex <= 0) return m.dropPulse > 0.01 && !a ? 0.5 : 0;
    const jump = a.sections[m.sectionIndex].energy - a.sections[m.sectionIndex - 1].energy;
    return Math.max(0, Math.min(1, jump * 2.2));
  }

  private ease(key: string, target: number, dt: number, tau: number, snap: boolean): number {
    const cur = this.smooth[key] ?? target;
    const v = snap ? target : cur + (target - cur) * (1 - Math.exp(-dt / tau));
    this.smooth[key] = v;
    return v;
  }

  private updatePost(m: MusicState, dt: number, gA: Genome | null, gB: Genome | null, seeked: boolean): void {
    const p = this.frame.post;
    const fr = this.frame;
    const st = (gB && fr.sceneB && fr.transProgress > 0.5 ? gB : gA)?.style ?? defaultStyle();
    const e = (k: string, v: number, tau = 0.5) => this.ease(k, v, dt, tau, seeked);
    const metaOf = (id: string | null) => (id ? this.scenes.find((s) => s.id === id) : undefined);
    const blend = (fn: (meta: SceneMeta | undefined) => number) =>
      fr.sceneB ? fn(metaOf(fr.sceneA)) + (fn(metaOf(fr.sceneB)) - fn(metaOf(fr.sceneA))) * fr.transProgress : fn(metaOf(fr.sceneA));
    // Trail appetite follows whatever is on screen, so pinned scenes and transitions behave.
    const trailScale = blend((meta) => (meta?.trails ?? 0.4) * (meta?.sparse ? 1 : 0.35));
    // Effects are devices with a musical reason, never decoration:
    //  - trails express sustain (legato, pads, reverb tails); percussive passages stay crisp;
    //  - the kaleidoscope marks repetition (a returning section at high energy);
    //  - shake / flash / aberration mark the impact of a real drop, scaled by its energy jump,
    //    with aberration also straining in the final bar of a build.
    const sustain = smoothstep01(0.35, 0.75, 1 - m.percussive) * (1 - 0.6 * m.flux);
    // The drop's impact on the post chain swells in (two cascaded eases), never as a jump.
    const drop = e('drop2', e('drop1', m.dropPulse, 0.15), 0.15);
    const half = e('trail', 0.35 * sustain * trailScale * (1 - drop), 0.8);
    p.fbAmount = half > 0.01 ? Math.pow(0.5, dt / half) : 0;
    // Every feedback motion is a per-second rate times dt, so trails look identical at 60 Hz and 480 Hz.
    p.fbZoom = 0.04 * sustain * dt;
    p.fbRotate = 0;
    p.fbHueShift = 0;
    p.fbWarp = 0;
    p.kaleido = st.kaleido;
    // A forced look (tooling, or the user choosing one) owns the overlay layer, kaleidoscope included.
    const kAllowed = this.forcedLook !== undefined ? 0 : blend((meta) => (meta?.kaleido === false ? 0 : 1));
    // The cue's own kaleidoscope slicing (chosen sparingly by the planner), eased in and out.
    p.kaleidoMix = e('kmix', st.kaleidoMix * kAllowed, 1.5);
    const impact = this.dropImpact(m);
    // A slow turn: every wedge repeats the motion, so the wheel itself only creeps.
    p.kaleidoSpin = this.frame.spin * 0.2;
    p.bloomStrength = e('bloom', 0.55 + 0.3 * m.energySlow, 0.4) + 0.25 * drop;
    // Light pages (paper, vellum) must stay bright: auto-exposure would pull them to mid-grey.
    const bgId = (gB && fr.sceneB && fr.transProgress > 0.5 ? gB : gA)?.composition?.recipe.background;
    p.autoExposure = e('autoexp', bgId === 'paper' || bgId === 'vellum' ? 0.25 : 0.85, 0.5);
    p.bloomThreshold = 0.75;
    p.exposure = 1.0;
    p.saturation = e('sat', 1.0 + 0.1 * m.arousal, 0.8);
    p.contrast = 1.04 + 0.08 * m.arousal;
    p.chromaAb = 0.012 * m.anticipation ** 3 + 0.02 * impact * drop ** 4;
    p.vignette = 0.25;
    p.grain = 0.012;
    p.sharpen = 0.5;
    p.beat = m.beatPulse;
    p.anticipation = m.anticipation;
    // No flash: a whole-screen flash is a snap. Drops land through the worlds' own rush instead.
    p.flash = 0;
    // No screen shake: it blurs the detail the visuals are there to show.
    p.shake = 0;
    p.fbLighten = blend((meta) => (meta?.sparse ? 1 : 0));
    p.transProgress = fr.transProgress;
    p.transKind = fr.transKind;
    p.transSeed = fr.transSeed;
    const pal = fr.palette;
    const tint = (c: RGB, amt: number): [number, number, number] => {
      const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] + 1e-4;
      return [1 + (c[0] / l - 1) * amt, 1 + (c[1] / l - 1) * amt, 1 + (c[2] / l - 1) * amt];
    };
    p.shadowTint = tint(pal[0], 0.18);
    p.highTint = tint(pal[3], 0.08);
  }
}

function smoothstep01(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function defaultStyle(): CueStyle {
  return { trailHalfLife: 0.08, kaleido: 0, kaleidoMix: 0, hueDrift: 0.2, zoomRate: 0.15, rotateRate: 0.05, grain: 0.035, saturation: 1.1, hueOffset: 0 };
}

function defaultPost(): PostParams {
  return {
    time: 0, frame: 0, transProgress: 0, transKind: 0, transSeed: 0, flash: 0, fbAmount: 0, fbZoom: 0, fbRotate: 0, fbHueShift: 0,
    fbWarp: 0, kaleido: 0, kaleidoMix: 0, kaleidoSpin: 0, bloomStrength: 0.8, bloomThreshold: 0.75, exposure: 1, saturation: 1.1,
    contrast: 1.05, chromaAb: 0.003, vignette: 0.4, grain: 0.035, sharpen: 0.5, beat: 0, anticipation: 0, hdr: 0, shake: 0, dt: 0, autoExposure: 0.85, fbLighten: 0,
    shadowTint: [1, 1, 1], highTint: [1, 1, 1],
  };
}

// ------------------------------------------------------------------------------------------------
// Genome choice
// ------------------------------------------------------------------------------------------------

export function scoreScene(meta: SceneMeta, s: Section, genres: GenreScore[]): number {
  const g = genres.length ? genreWeight(genres, meta.genres) : 0.5;
  const [lo, hi] = meta.energy;
  const ed = s.energy < lo ? lo - s.energy : s.energy > hi ? s.energy - hi : 0;
  const energyFit = 1 - Math.min(1, ed * 2.5);
  const moodFit = 1 - Math.min(1, Math.abs(s.valence - meta.mood.valence) * 0.8 + Math.abs(s.arousal - meta.mood.arousal) * 1.2);
  return g * 1.6 + energyFit * 1.1 + moodFit * 0.8;
}

function scoreLook(meta: LookMeta, s: Section, genres: GenreScore[]): number {
  const [lo, hi] = meta.energy;
  const ed = s.energy < lo ? lo - s.energy : s.energy > hi ? s.energy - hi : 0;
  const g = meta.genres && genres.length ? genreWeight(genres, meta.genres, 0.5) : 0.5;
  return meta.weight * (1 - Math.min(1, ed * 3)) * (0.5 + g);
}

function weightedPick(rand: () => number, weights: number[]): number {
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

interface ChooseInput {
  rand: () => number;
  scenes: SceneMeta[];
  looks: LookMeta[];
  section: Section;
  genres: GenreScore[];
  psychedelic: number;
  memory: NoveltyMemory;
  /** Epoch ms the genome would appear at. */
  at: number;
  /** Already-planned traces for this song. */
  extra: { g: GenomeTrace; at: number; dur: number }[];
  /** Prefer this scene (motif for a repeated section). */
  motif?: string;
  grainBase?: number;
}

function sampleGenome(sceneId: string, i: ChooseInput, naturalistic: boolean): Genome {
  const { rand, section: s, psychedelic } = i;
  const calm = 1 - s.arousal;
  // Looks: roughly 55% of cues get one; naturalistic worlds mostly stay clean.
  let lookId: string | null = null;
  let lookAmount = 0;
  // A look is a rare, deliberate act for a contrasting section, never random decoration.
  const lookChance = s.kind === 'bridge' || s.kind === 'breakdown' ? 0.3 : 0;
  const pool = naturalistic ? i.looks.filter((l) => !l.remaps) : i.looks;
  if (pool.length && rand() < lookChance) {
    const li = weightedPick(rand, pool.map((l) => scoreLook(l, s, i.genres)));
    const lm = pool[li];
    lookId = lm.id;
    lookAmount = lm.amount[0] + (lm.amount[1] - lm.amount[0]) * rand();
  }
  const useKaleido = !naturalistic && rand() < 0.06 + 0.22 * psychedelic * (s.kind === 'peak' || s.kind === 'build' ? 1 : 0.4);
  const style: CueStyle = {
    trailHalfLife: Math.max(0, (0.6 + 0.6 * psychedelic) * (0.05 + 0.4 * calm * rand()) + (s.kind === 'breakdown' ? 0.12 : 0)),
    kaleido: useKaleido ? [3, 4, 5, 6, 7, 8, 10, 12][Math.floor(rand() * 8)] : 0,
    // Nearly full: at half mix the unfolded world shows through, moving against its mirror image.
    kaleidoMix: useKaleido ? 0.85 + rand() * 0.15 : 0,
    hueDrift: (rand() < 0.5 ? -1 : 1) * (0.05 + 0.6 * psychedelic * rand()),
    zoomRate: (rand() < 0.2 ? -0.5 : 1) * (0.02 + 0.14 * psychedelic * rand()) + (s.kind === 'build' ? 0.12 : 0),
    rotateRate: (rand() < 0.5 ? -1 : 1) * (0.01 + 0.1 * psychedelic * rand()),
    grain: (i.grainBase ?? 0.03) * (0.6 + 0.8 * rand()),
    saturation: 0.95 + 0.25 * psychedelic + 0.15 * (rand() - 0.5),
    hueOffset: (rand() - 0.5) * 100,
  };
  return {
    sceneId,
    dna: Array.from({ length: DNA_GENES }, () => rand()),
    lookId,
    lookAmount,
    lookDna: [rand(), rand(), rand(), rand()],
    paletteScheme: weightedPick(rand, schemeWeights(s.valence, s.arousal)),
    style,
  };
}

/**
 * Picks the best-fitting genome that also looks unfamiliar: candidate worlds are ranked by
 * musical fit, several random genomes are sampled per world, and each is penalised by how
 * similar it is to anything shown in the last 30 minutes (memory + this song's plan).
 */
export function chooseGenome(i: ChooseInput): Genome {
  const ranked = i.scenes
    .map((m) => ({ m, fit: scoreScene(m, i.section, i.genres) + i.rand() * 0.5 + (m.id === i.motif ? 0.6 : 0) }))
    .sort((a, b) => b.fit - a.fit)
    .slice(0, 12);
  let best: { g: Genome; score: number } | null = null;
  for (const { m, fit } of ranked) {
    for (let k = 0; k < 4; k++) {
      const g = sampleGenome(m.id, i, m.kaleido === false);
      const fam = i.memory.familiarity(trace(g), i.at, i.extra);
      const score = fit - fam * 2.2;
      if (!best || score > best.score) best = { g, score };
    }
  }
  return best!.g;
}

// ------------------------------------------------------------------------------------------------
// Show planning
// ------------------------------------------------------------------------------------------------

function hashTrack(a: TrackAnalysis): number {
  let h = 2166136261;
  const mix = (v: number) => {
    h ^= Math.floor(v * 1000) & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(a.duration);
  mix(a.bpm);
  for (let i = 0; i < a.frameCount; i += 997) mix(a.energy[i]);
  return h;
}

export interface PlanOptions {
  /** Generate every cue with the composer instead of picking hand-authored scenes. */
  compose?: boolean;
  looks?: LookMeta[];
  memory?: NoveltyMemory;
  epoch?: number;
  /** Extra seed so replays of the same track get a fresh show (defaults to the epoch). */
  seed?: number;
  /** With compose: plan the song as one continuous journey (see sculpt/journey.ts) instead of separate cues. */
  journey?: boolean;
  /** Plan the song as a journey through worlds: a new world for each section, none twice in a song. */
  worlds?: boolean;
}

/**
 * Composes many candidate visuals for a section and keeps the one least like anything shown in
 * the last 30 minutes (structural similarity), never repeating the previous cue's layout.
 */
/**
 * Prior that keeps novelty from drifting into the weaker corners of the grammar: layouts you
 * travel through (and that have a world around you) beat objects you orbit, and light pages, which
 * suit few compositions, are an occasional contrast rather than a regular choice.
 */
function compositionQuality(r: { layout: string; background: string; layers: string[] }): number {
  const w = LAYOUTS.find((l) => l.id === r.layout)?.weight ?? 1;
  const hasWorld = r.layers.some((id) => LAYERS.find((l) => l.id === id.split(':')[0])?.role === 'world');
  return 0.3 * Math.log2(w) + (hasWorld ? 0.1 : 0) - (r.background === 'paper' || r.background === 'vellum' ? 0.15 : 0);
}

function chooseComposed(
  rand: () => number,
  s: Section,
  a: TrackAnalysis,
  memory: NoveltyMemory,
  at: number,
  extra: { g: GenomeTrace; at: number; dur: number }[],
  prevCarrier: string | undefined,
): Genome {
  let best: { g: Genome; score: number } | null = null;
  for (let k = 0; k < 40; k++) {
    const comp = composeOne(rand, s, a);
    const g: Genome = {
      sceneId: comp.id,
      dna: comp.params,
      lookId: null,
      lookAmount: 0,
      lookDna: [0.5, 0.5, 0.5, 0.5],
      paletteScheme: weightedPick(rand, schemeWeights(s.valence, s.arousal)),
      style: { ...defaultStyle(), kaleido: 0, kaleidoMix: 0, grain: 0.012 },
      composition: comp,
    };
    // Never repeat the previous cue's layout back to back (unless that is the only option).
    const score = -memory.familiarity(trace(g), at, extra) + compositionQuality(comp.recipe) + rand() * 0.05 - (comp.recipe.layout === prevCarrier ? 10 : 0);
    if (!best || score > best.score) best = { g, score };
  }
  return best!.g;
}

/**
 * One continuous journey for the whole song: a single composition flown from start to end, with one
 * cue per section so the light (palette) and the director's devices follow the song's form. A
 * returning section returns to its place and its light. Of a handful of candidate journeys, the one
 * least like anything seen recently is flown.
 */
function planJourneyShow(a: TrackAnalysis, rand: () => number, memory: NoveltyMemory, epoch: number, isDrop: (t: number) => boolean): Cue[] {
  const bar = (60 / a.bpm) * a.beatsPerBar;
  let best: { j: ReturnType<typeof planJourney>; score: number } | null = null;
  for (let k = 0; k < 8; k++) {
    const j = planJourney(rand, a);
    const probe: Genome = { sceneId: j.composition.id, dna: j.composition.params, lookId: null, lookAmount: 0, lookDna: [0.5, 0.5, 0.5, 0.5], paletteScheme: 0, style: defaultStyle(), composition: j.composition };
    const score = -memory.familiarity(trace(probe), epoch) + rand() * 0.05;
    if (!best || score > best.score) best = { j, score };
  }
  const { composition } = best!.j;
  const lightOf = new Map<number, number>();
  return a.sections.map((s, i) => {
    if (!lightOf.has(s.cluster)) lightOf.set(s.cluster, weightedPick(rand, schemeWeights(s.valence, s.arousal)));
    const genome: Genome = {
      sceneId: composition.id,
      dna: composition.params,
      lookId: null,
      lookAmount: 0,
      lookDna: [0.5, 0.5, 0.5, 0.5],
      paletteScheme: lightOf.get(s.cluster)!,
      style: { ...defaultStyle(), kaleido: 0, kaleidoMix: 0, grain: 0.012 },
      composition,
    };
    // The scene never changes; a transition only carries the light from one place to the next.
    const drop = i > 0 && isDrop(s.start);
    return {
      start: i === 0 ? 0 : s.start,
      end: s.end,
      genome,
      transition: drop ? TransitionKind.Cut : TransitionKind.Fade,
      transitionDuration: i === 0 || drop ? 0 : Math.min(bar * 2, 5),
      sectionIndex: i,
    };
  });
}

/**
 * A song as a journey through worlds, on the music's phrase grid: a new world every 8 bars and at
 * every section boundary, never one shown earlier in this song and, while the pool allows, none seen
 * in the last 30 minutes (across songs). At its 4-bar point each world develops (its fusion and
 * palette move on), every 4 bars the colour cycles (updatePalette) and the form reshapes
 * (morph.ts). Transitions land on downbeats and follow the change in energy.
 */
/** Worlds that read as flat fields; everything else reads as 3D. Meta `dim` overrides. */
const FLAT_WORLDS = new Set([
  'domain-colour', 'marble-flow', 'mobius-flow', 'quasicrystal-lace', 'smoke-veils', 'thin-film',
  'voronoi-glass', 'ink-marble', 'hyperbolic-weave', 'spectral-nebula', 'ember-fibres', 'wallpaper-flow',
  'liquid-light', 'feedback-bloom', 'slime-light', 'neon-harmonics',
]);
const dimOf = (m: SceneMeta | undefined): '2d' | '3d' => m?.dim ?? (m && FLAT_WORLDS.has(m.id) ? '2d' : '3d');

/** Share of places that get an overlay look, and (without one) a kaleidoscope slice. */
const OVERLAY_CHANCE = 0.32;
const KALEIDO_CHANCE = 0.1;

/** Share of places (after the first) that fuse two worlds. */
const FUSE_CHANCE = 0.45;

function planWorldsShow(
  a: TrackAnalysis,
  scenes: SceneMeta[],
  rand: () => number,
  memory: NoveltyMemory,
  epoch: number,
  looks: LookMeta[],
  isDrop: (t: number) => boolean,
  psychedelic: number,
  grainBase: number,
): Cue[] {
  const bar = (60 / a.bpm) * a.beatsPerBar;
  const used = new Set<string>();
  const fused = new Set<string>();
  const planned: { g: GenomeTrace; at: number; dur: number }[] = [];
  const cues: Cue[] = [];
  const db = Array.from(a.downbeats);
  const lookUses = new Map<string, number>();
  let lastLook: string | null = null;
  const pickFuse = (sceneId: string): Fuse | undefined => {
    // Only worlds of the same kind fuse (2D with 2D, 3D with 3D): mixed, they look disjointed.
    const kind = dimOf(scenes.find((m) => m.id === sceneId));
    const partners = scenes.filter((m) => m.id !== sceneId && dimOf(m) === kind);
    for (let tries = 0; tries < 6 && partners.length; tries++) {
      const partner = partners[Math.floor(rand() * partners.length)];
      // Fold (mode 0) is never planned: walking one world along the other's field smears and tears it
      // into blobs, streaks and stair-steps on every pair tried. 3D worlds have dark, sparse luminance
      // fields that only relief re-forms well; flat worlds also take interference and merge.
      const mode = kind === '3d' ? 1 : 1 + Math.floor(rand() * (FUSE_MODES - 1));
      const key = `${sceneId}|${partner.id}|${mode}`;
      if (fused.has(key)) continue;
      fused.add(key);
      return { sceneId: partner.id, dna: Array.from({ length: DNA_GENES }, () => rand()), mode, amount: 0.6 + 0.35 * rand() };
    }
    return undefined;
  };
  a.sections.forEach((s, si) => {
    // The music's phrase grid: a new world every 8 bars (on the downbeat), a section boundary
    // always starts one, and a tail shorter than 4 bars stays with the world before it.
    const starts = [s.start];
    const i0 = db.findIndex((d) => d >= s.start - bar * 0.25);
    if (i0 >= 0) for (let k = i0 + 8; k < db.length && db[k] < s.end - bar * 4 + bar * 0.25; k += 8) starts.push(db[k]);
    starts.forEach((p0, pi) => {
      const p1 = pi + 1 < starts.length ? starts[pi + 1] : s.end;
      const at = epoch + p0 * 1000;
      const prev = cues[cues.length - 1];
      // Every place in a song is a new world: a world never appears twice in one song. A very short
      // piece, or one with no unused world left, carries on the current world instead.
      const fresh = scenes.filter((m) => !used.has(m.id) && !memory.seen(m.id, at));
      const pool = fresh.length ? fresh : scenes.filter((m) => !used.has(m.id));
      if (prev && (p1 - p0 < bar * 4 || !pool.length)) {
        prev.end = p1;
        return;
      }
      const g = chooseGenome({ rand, scenes: pool.length ? pool : scenes, looks, section: s, genres: a.genres, psychedelic, memory, at, extra: planned, grainBase });
      used.add(g.sceneId);
      // Overlays, sparingly: about a third of places get one from the overlay library (liquid, glass,
      // reflections, perceptual effects...), never the same one twice in a row, each at most twice a
      // song, at a moderate strength. Kaleidoscope slicing is rarer still.
      g.lookId = null;
      g.lookAmount = 0;
      const overlays = looks.filter((l) => l.overlay && l.id !== lastLook && (lookUses.get(l.id) ?? 0) < 2);
      if (cues.length > 0 && overlays.length && rand() < OVERLAY_CHANCE) {
        const lm = overlays[weightedPick(rand, overlays.map((l) => l.weight))];
        g.lookId = lm.id;
        g.lookAmount = (lm.amount[0] + (lm.amount[1] - lm.amount[0]) * rand()) * 0.85;
        g.lookDna = [rand(), rand(), rand(), rand()];
        lookUses.set(lm.id, (lookUses.get(lm.id) ?? 0) + 1);
      }
      lastLook = g.lookId;
      const kaleidoOk = scenes.find((m) => m.id === g.sceneId)?.kaleido !== false;
      g.style = { ...g.style, kaleido: 0, kaleidoMix: 0 };
      if (kaleidoOk && cues.length > 0 && !g.lookId && rand() < KALEIDO_CHANCE) {
        g.style.kaleido = [3, 4, 5, 6, 8][Math.floor(rand() * 5)];
        g.style.kaleidoMix = 0.35 + 0.3 * rand();
      }
      // Fusion: about half the places are two worlds held together as one picture, in one of several
      // relationships. Pairs times modes give hundreds of distinct visuals from the same worlds.
      if (cues.length > 0 && rand() < FUSE_CHANCE) g.fuse = pickFuse(g.sceneId);
      // Development at the 4-bar point: the fusion changes and the palette scheme moves on.
      const devIdx = db.findIndex((d) => d >= p0 + bar * 3.75);
      if (devIdx >= 0 && db[devIdx] < p1 - bar * 1.75) {
        const nextFuse = g.fuse ? (rand() < 0.4 ? null : (pickFuse(g.sceneId) ?? null)) : rand() < 0.75 ? (pickFuse(g.sceneId) ?? null) : null;
        g.develop = { at: db[devIdx], fuse: nextFuse, paletteScheme: weightedPick(rand, schemeWeights(s.valence, s.arousal)) };
      }
      const sectionStart = pi === 0;
      const drop = si > 0 && sectionStart && isDrop(s.start);
      const rising = si > 0 && sectionStart && s.energy > a.sections[si - 1].energy + 0.1;
      // No hard cuts (everything flows): a drop rushes into the new world with a fast zoom; within a
      // section, a phrase dissolves into the next world over about a bar and a half.
      const transition = !prev ? TransitionKind.Fade : drop || rising ? TransitionKind.Zoom : TransitionKind.Dissolve;
      const transitionDuration = !prev ? 0 : drop ? Math.min(bar * 0.5, 1.2) : rising ? Math.min(bar, 3) : sectionStart ? Math.min(bar * 2, 5) : Math.min(bar * 1.5, 4);
      cues.push({ start: cues.length === 0 ? 0 : p0, end: p1, genome: g, transition, transitionDuration, sectionIndex: si });
      planned.push({ g: trace(g), at, dur: p1 - p0 });
    });
  });
  return cues;
}

export function planShow(a: TrackAnalysis, scenes: SceneMeta[], opts: PlanOptions = {}): Cue[] {
  const epoch = opts.epoch ?? Date.now();
  const rand = rng((hashTrack(a) ^ (opts.seed ?? epoch)) >>> 0);
  const memory = opts.memory ?? new NoveltyMemory(null);
  const looks = opts.looks ?? [];
  const bar = (60 / a.bpm) * a.beatsPerBar;
  const cues: Cue[] = [];
  const clusterScene = new Map<number, string>();
  const planned: { g: GenomeTrace; at: number; dur: number }[] = [];
  const psychedelic = genreWeight(a.genres, PSYCHEDELIC, 0.25);
  const dropSet = Array.from(a.drops);
  const isDrop = (t: number) => dropSet.some((d) => Math.abs(d - t) < 0.15);
  const grainBase = a.genres[0]?.id === 'lofi' ? 0.08 : a.genres[0]?.id === 'rock' ? 0.05 : 0.03;
  if (opts.compose && opts.journey) return planJourneyShow(a, rand, memory, epoch, isDrop);
  if (opts.worlds) return planWorldsShow(a, scenes.filter((m) => m.auto !== false), rand, memory, epoch, looks, isDrop, psychedelic, grainBase);

  a.sections.forEach((s, si) => {
    const pieces: [number, number][] = [];
    const len = s.end - s.start;
    // Peaks change visuals every ~8 bars to match their intensity; calmer sections every ~12-16.
    const maxCueLen = s.kind === 'peak' ? Math.max(10, bar * 8) : s.kind === 'build' ? Math.max(10, bar * 8) : Math.max(18, Math.min(40, bar * 12));
    const n = Math.max(1, Math.round(len / maxCueLen));
    for (let k = 0; k < n; k++) {
      let p0 = s.start + (len * k) / n;
      if (k > 0) {
        let best = p0;
        let bd = Infinity;
        for (const d of a.downbeats) {
          const dd = Math.abs(d - p0);
          if (dd < bd) {
            bd = dd;
            best = d;
          }
        }
        p0 = best;
      }
      pieces.push([p0, 0]);
    }
    for (let k = 0; k < pieces.length; k++) pieces[k][1] = k + 1 < pieces.length ? pieces[k + 1][0] : s.end;

    pieces.forEach(([start, end], k) => {
      const prev = cues[cues.length - 1];
      // Repeated sections sometimes return to their world (a motif) but always with new DNA.
      const motif = k === 0 && rand() < 0.35 ? clusterScene.get(s.cluster) : undefined;
      const genome = opts.compose
        ? chooseComposed(rand, s, a, memory, epoch + start * 1000, planned, prev?.genome.composition?.recipe.layout)
        : chooseGenome({
        rand,
        scenes: scenes.filter((m) => m.id !== prev?.genome.sceneId),
        looks,
        section: s,
        genres: a.genres,
        psychedelic,
        memory,
        at: epoch + start * 1000,
        extra: planned,
        motif,
        grainBase,
      });
      if (k === 0 && !clusterScene.has(s.cluster)) clusterScene.set(s.cluster, genome.sceneId);
      planned.push({ g: trace(genome), at: epoch + start * 1000, dur: end - start });

      const drop = k === 0 && isDrop(start);
      const rising = prev ? s.energy > (a.sections[si - 1]?.energy ?? 0) + 0.1 : false;
      let transition: TransitionKind;
      let transitionDuration: number;
      if (!prev) {
        transition = TransitionKind.Fade;
        transitionDuration = 0;
      } else if (drop) {
        transition = TransitionKind.Cut;
        transitionDuration = 0;
      } else if (s.energy < 0.3 || a.mood.arousal < 0.35) {
        transition = TransitionKind.Fade;
        transitionDuration = Math.min(bar * 2, 6);
      } else if (rising) {
        transition = TransitionKind.Zoom;
        transitionDuration = Math.min(bar, 3);
      } else {
        transition = rand() < 0.3 ? TransitionKind.Zoom : TransitionKind.Dissolve;
        transitionDuration = Math.min(bar * 1.5, 4);
      }
      cues.push({ start, end, genome, transition, transitionDuration, sectionIndex: si });
    });
  });
  if (cues.length) cues[0].start = 0;
  return cues;
}
