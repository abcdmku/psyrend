import type { MusicState } from '../audio/musicState';
import { BAND_COUNT } from '../audio/types';
import type { VisualFrame } from '../director/director';
import { LOOK_LAYOUT, type LookFactory } from '../looks/types';
import type { SceneFactory, SceneInstance } from '../scenes/types';
import { worldPace } from '../scenes/motionGain';
import { Morph } from '../scenes/morph';
import type { GpuContext } from './context';
import { FRAME_LAYOUT } from './frameLayout';
import { PerfGovernor } from './perf';
import { PostChain } from './post';
import { SharedResources } from './resources';

export interface SceneLoadError {
  id: string;
  message: string;
}

export class Renderer {
  readonly shared: SharedResources;
  readonly post: PostChain;
  readonly perf: PerfGovernor;
  readonly scenes = new Map<string, SceneInstance>();
  readonly errors: SceneLoadError[] = [];
  private readonly factories = new Map<string, SceneFactory>();
  private readonly pending = new Map<string, Promise<SceneInstance | null>>();
  private readonly lookFactories = new Map<string, LookFactory>();
  private readonly lookData = new Float32Array(LOOK_LAYOUT.size / 4);
  private lastInstance: SceneInstance | null = null;
  private frameIndex = 0;
  private outW = 0;
  private outH = 0;
  /** Id of the scene that dominates the current frame. */
  lastScene = '';
  /** Debug: bypass feedback, kaleidoscope and bloom to inspect raw scene output. */
  rawScene = false;
  /** Debug: fixed post parameter overrides (from ?post.name=value). */
  postOverrides: Record<string, number> = {};
  /** Last post parameters submitted (debug readout). */
  lastPost: Record<string, unknown> = {};
  /** Device-pixel-ratio cap for the swapchain. */
  maxDpr = 2;

  constructor(private readonly gpu: GpuContext) {
    this.shared = new SharedResources(gpu.device);
    this.post = new PostChain(gpu.device, gpu.format);
    this.perf = new PerfGovernor(gpu.device, gpu.timestamps);
  }

  /** Registers scenes and looks; nothing is compiled until `ensure*` asks for it. */
  async init(factories: SceneFactory[], looks: LookFactory[]): Promise<void> {
    await this.post.init();
    for (const f of factories) this.factories.set(f.meta.id, f);
    for (const l of looks) this.lookFactories.set(l.meta.id, l);
  }

  /** Registers a scene factory created at runtime (composed visuals). */
  registerScene(f: SceneFactory): void {
    if (!this.factories.has(f.meta.id)) this.factories.set(f.meta.id, f);
  }

  isReady(id: string): boolean {
    return this.scenes.has(id);
  }

  /** Compiles a scene once (shaders + pipelines); resolves null and records the error on failure. */
  ensureScene(id: string): Promise<SceneInstance | null> {
    const ready = this.scenes.get(id);
    if (ready) return Promise.resolve(ready);
    let p = this.pending.get(id);
    if (!p) {
      const f = this.factories.get(id);
      p = !f
        ? Promise.resolve(null)
        : f.create(this.gpu.device, this.shared).then(
            (inst) => {
              this.scenes.set(id, inst);
              return inst;
            },
            (err) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error(`[scene ${id}]`, message);
              this.errors.push({ id, message });
              return null;
            },
          );
      this.pending.set(id, p);
    }
    return p;
  }

  ensureLook(id: string): Promise<unknown> {
    const f = this.lookFactories.get(id);
    return f ? this.post.ensureLook(f) : Promise.resolve(null);
  }

  /** Compiles several scenes/looks, reporting progress. */
  async prepare(sceneIds: string[], lookIds: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const jobs = [...sceneIds.map((id) => () => this.ensureScene(id)), ...lookIds.map((id) => () => this.ensureLook(id))];
    let done = 0;
    await Promise.all(jobs.map((j) => j().finally(() => onProgress?.(++done, jobs.length))));
  }

  /** Compiles everything else one at a time in the background so pins are instant later. */
  async warmAll(): Promise<void> {
    for (const id of [...this.factories.keys()].filter((k) => !k.startsWith('gen:'))) await this.ensureScene(id);
    for (const id of this.lookFactories.keys()) await this.ensureLook(id);
  }

  get failedScenes(): Set<string> {
    return new Set(this.errors.map((e) => e.id));
  }

  private resizeIfNeeded(): void {
    const c = this.gpu.canvas;
    const dpr = Math.min(this.maxDpr, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (w !== this.outW || h !== this.outH) {
      this.outW = w;
      this.outH = h;
      c.width = w;
      c.height = h;
    }
    const s = this.perf.scale;
    this.post.resize(w * s, h * s);
  }

  /** Each world's own paced clock (see SceneUpdateContext.clock). */
  private clocks = new Map<string, number>();

  /** Clock-rate factor from the active look (LookMeta.pace scaled by its amount), eased. */
  private lookPace = 1;

  /** Debug override for every world's clock rate (null = calibrated pace). */
  paceOverride: number | null = null;

  /** How fast a world's own clock runs: the song's weight times the world's calibration. */
  private pace(id: string, m: MusicState): number {
    return this.paceOverride ?? worldPace(id, m.intensity) * this.lookPace;
  }

  /** Advance a world's paced clock; starts at the song position the first time the world is drawn. */
  private tick(id: string, m: MusicState, dt: number): { dt: number; clock: number } {
    const pace = this.pace(id, m);
    Morph.pace = pace;
    const pdt = dt * pace;
    const clock = (this.clocks.get(id) ?? m.time) + pdt;
    this.clocks.set(id, clock);
    return { dt: pdt, clock };
  }

  render(m: MusicState, v: VisualFrame, wallTime: number, dt: number): void {
    const device = this.gpu.device;
    this.perf.tick(wallTime * 1000);
    this.resizeIfNeeded();
    const { w, h } = this.post.size;

    // ----- frame uniforms -----
    const d = this.shared.frameData;
    const o = FRAME_LAYOUT.offset;
    d[o.res] = w;
    d[o.res + 1] = h;
    d[o.time] = wallTime;
    d[o.dt] = dt;
    d[o.songTime] = m.time;
    d[o.beatPhase] = m.beatPhase;
    d[o.barPhase] = m.barPhase;
    d[o.bpm] = m.bpm;
    d[o.beatPulse] = m.beatPulse;
    d[o.barPulse] = m.barPulse;
    d[o.kick] = m.kick;
    d[o.snare] = m.snare;
    d[o.hat] = m.hat;
    d[o.onset] = m.onset;
    d[o.kickNext] = m.kickNext;
    d[o.lead] = m.lead;
    d[o.leadPitch] = m.leadPitch;
    d[o.leadHeld] = m.leadHeld;
    d[o.energy] = m.energy;
    d[o.energySlow] = m.energySlow;
    d[o.sub] = m.sub;
    d[o.bass] = m.bass;
    d[o.lowMid] = m.lowMid;
    d[o.mid] = m.mid;
    d[o.high] = m.high;
    d[o.centroid] = m.centroid;
    d[o.flatness] = m.flatness;
    d[o.percussive] = m.percussive;
    d[o.flux] = m.flux;
    d[o.valence] = m.valence;
    d[o.arousal] = m.arousal;
    d[o.tension] = m.tension;
    d[o.majorness] = m.majorness;
    d[o.chordHue] = m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : 0;
    d[o.keyHue] = 0;
    d[o.anticipation] = m.anticipation;
    d[o.dropPulse] = m.dropPulse;
    d[o.sectionProgress] = m.sectionProgress;
    d[o.chordPulse] = m.chordPulse;
    d[o.travel] = v.travel;
    d[o.spin] = v.spin;
    d[o.warp] = v.warp;
    d[o.intensity] = v.intensity;
    d[o.frame] = this.frameIndex;
    d[o.aspect] = w / h;
    d[o.histHead] = this.shared.pushSpectrum(m.bands);
    d[o.seed] = v.seed;
    const sc = this.shared.score;
    d[o.scoreRate] = sc.rate;
    d[o.scoreRows] = sc.validRows;
    d[o.scoreRow] = m.time * sc.rate;
    d[o.scoreTexRows] = sc.rows;
    d.set(v.morph, o.morph);
    d.set(v.morph2, o.morph2);
    d.set(v.evolve, o.evolve);
    for (let i = 0; i < 4; i++) {
      d.set(v.palette[i], o.pal0 + i * 4);
      d[o.pal0 + i * 4 + 3] = 1;
    }
    d.set(m.bands.subarray(0, BAND_COUNT), o.spectrum);
    d.set(m.chroma, o.chroma);
    this.shared.uploadFrame();

    // ----- scenes -----
    // Scenes compile lazily: anything not ready yet is requested and the last visible scene holds.
    let a = this.scenes.get(v.sceneA);
    if (!a) {
      void this.ensureScene(v.sceneA);
      a = this.lastInstance ?? this.scenes.values().next().value;
    }
    let b = v.sceneB ? this.scenes.get(v.sceneB) : undefined;
    if (v.sceneB && !b) void this.ensureScene(v.sceneB);
    if (b === a) b = undefined;
    const transition = !!b && v.transProgress > 0 && v.transProgress < 1;
    // A look that multiplies the image (kaleidoscopes) slows the worlds under it, eased in and out.
    const lp = v.lookId && !this.rawScene ? (this.lookFactories.get(v.lookId)?.meta.pace ?? 1) : 1;
    // The cue's own post kaleidoscope repeats the world the same way: half pace at full mix.
    const lpT = (1 + (lp - 1) * Math.min(1, Math.max(0, v.lookAmount))) * (1 - 0.5 * Math.min(1, Math.max(0, v.post.kaleidoMix)));
    this.lookPace += (lpT - this.lookPace) * (1 - Math.exp(-Math.max(0, dt) / 1.2));
    Morph.calm = Math.min(1, this.lookPace) ** 0.8;
    const ctxBase = { music: m, time: wallTime, dt, intensity: v.intensity, travel: v.travel, spin: v.spin, evolve: v.evolve };
    const enc = device.createCommandEncoder({ label: 'frame' });
    const tsBegin = this.perf.timestampWrites('begin');
    if (tsBegin) enc.beginComputePass({ timestampWrites: tsBegin }).end();
    const views = this.post.sceneViews;
    // When B has fully arrived but the director still reports it, render B alone.
    const solo = !transition && b && v.transProgress >= 1 ? b : a;
    const shown = transition && v.transProgress > 0.5 ? b : solo;
    this.lastScene = shown?.meta.id ?? '';
    if (shown) this.lastInstance = shown;
    // A world, fused with its partner when the cue has one: both render, then the fusion pass
    // writes the combined picture where the world alone would have gone.
    const draw = (inst: SceneInstance, dna: number[], fuse: VisualFrame['fuseA'], into: GPUTextureView) => {
      inst.update({ ...ctxBase, ...this.tick(inst.meta.id, m, dt), variant: dna[0], dna });
      const partner = fuse ? this.scenes.get(fuse.sceneId) : undefined;
      if (fuse && !partner) void this.ensureScene(fuse.sceneId);
      if (!fuse || !partner || partner === a || partner === b) {
        inst.encode(enc, into, w, h);
        return;
      }
      inst.encode(enc, views.fuseSrc, w, h);
      partner.update({ ...ctxBase, ...this.tick(partner.meta.id, m, dt), variant: fuse.dna[0], dna: fuse.dna });
      partner.encode(enc, views.fuseC, w, h);
      this.post.encodeFuse(enc, into, fuse.mode, fuse.amount);
    };
    if (solo) draw(solo, solo === b ? v.dnaB : v.dnaA, solo === b ? v.fuseB : v.fuseA, views.a);
    if (transition && b) draw(b, v.dnaB, v.fuseB, views.b);

    // ----- look -----
    let lookId = v.lookId && v.lookAmount > 0.002 && !this.rawScene ? v.lookId : null;
    if (lookId && !this.post.isLookReady(lookId)) {
      void this.ensureLook(lookId);
      lookId = null;
    }
    if (lookId) this.writeLook(lookId, m, v, wallTime, dt, w, h);

    // ----- post -----
    v.post.time = wallTime;
    v.post.frame = this.frameIndex;
    v.post.dt = dt;
    v.post.hdr = this.gpu.hdr ? 1 : 0;
    Object.assign(v.post, this.postOverrides);
    this.lastPost = v.post;
    if (this.rawScene) Object.assign(v.post, { fbAmount: 0, kaleidoMix: 0, bloomStrength: 0, flash: 0, chromaAb: 0, vignette: 0, grain: 0 });
    this.post.setParams(v.post, this.outW, this.outH);
    this.post.encode(enc, this.gpu.context.getCurrentTexture().createView(), transition, lookId);
    const tsEnd = this.perf.timestampWrites('end');
    if (tsEnd) enc.beginComputePass({ timestampWrites: tsEnd }).end();
    const after = this.perf.resolve(enc);
    device.queue.submit([enc.finish()]);
    after();
    this.frameIndex++;
  }

  private writeLook(id: string, m: MusicState, v: VisualFrame, time: number, dt: number, w: number, h: number): void {
    const L = this.lookData;
    const o = LOOK_LAYOUT.offset;
    L[o.res] = w;
    L[o.res + 1] = h;
    L[o.amount] = v.lookAmount;
    L[o.time] = time;
    L[o.beat] = m.beatPulse;
    L[o.kick] = m.kick;
    L[o.snare] = m.snare;
    L[o.hat] = m.hat;
    L[o.energy] = m.energy;
    L[o.bass] = m.bass;
    L[o.high] = m.high;
    L[o.anticipation] = m.anticipation;
    L[o.dropPulse] = m.dropPulse;
    L[o.beatPhase] = m.beatPhase;
    L[o.spin] = v.spin;
    L[o.travel] = v.travel;
    L.set(v.lookDna.slice(0, 4), o.dna);
    for (let i = 0; i < 4; i++) {
      L.set(v.palette[i], o.pal0 + i * 4);
      L[o.pal0 + i * 4 + 3] = 1;
    }
    const p = L.subarray(o.p, o.p + 16);
    p.fill(0);
    this.lookFactories.get(id)?.params?.({ music: m, dna: v.lookDna, time, dt }, p);
    this.post.setLookParams(L);
  }

  get outputSize(): { w: number; h: number } {
    return { w: this.outW, h: this.outH };
  }
}
