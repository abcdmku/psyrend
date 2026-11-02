import '@fontsource-variable/syne';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/special-gothic-expanded-one';
import './ui/styles.css';
import { analyzeInWorker, toAnalysisSignal } from './audio/analyzeClient';
import { synthesizeDemo } from './audio/demoTrack';
import { IdleSource } from './audio/idleSource';
import { LiveAnalyzer } from './audio/liveAnalyzer';
import { AnalysisTimeline, type MusicState } from './audio/musicState';
import { Player } from './audio/player';
import type { TrackAnalysis } from './audio/types';
import { Director } from './director/director';
import { NoveltyMemory } from './director/novelty';
import { LOOKS } from './looks/registry';
import { compositionFactory, forced, LAYERS } from './sculpt/compose';
import { initGpu, WebGpuUnavailableError } from './gpu/context';
import { PerfGovernor } from './gpu/perf';
import { Renderer } from './gpu/renderer';
import { SCENES } from './scenes/registry';
import { toggleFullscreen, Ui } from './ui/ui';

type Source =
  | { kind: 'idle'; idle: IdleSource }
  | { kind: 'track'; timeline: AnalysisTimeline }
  | { kind: 'live'; live: LiveAnalyzer; stream: MediaStream };

const params = new URLSearchParams(location.search);

class App {
  private renderer!: Renderer;
  private readonly player = new Player();
  private director: Director;
  private source: Source = { kind: 'idle', idle: new IdleSource() };
  private readonly ui: Ui;
  private lastFrame = performance.now();
  /** Offline rendering (audit tooling): the display loop stops and frames are rendered on demand. */
  private offline = false;
  /** Offline wall clock: advances by each rendered frame's step, so wall-timed effects (pin fades) progress. */
  private offlineWall = 0;
  private analysis: TrackAnalysis | null = null;
  private loadToken = 0;
  private sceneIds: string[] = [];
  private readonly memory = new NoveltyMemory();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ui = new Ui(document.getElementById('ui')!, {
      onFile: (f) => void this.loadFile(f),
      onDemo: () => void this.loadDemo(),
      onLive: () => void this.startLive(),
      onTogglePlay: () => this.togglePlay(),
      onSeek: (t) => this.player.seek(t),
      onPin: (id) => this.pin(id),
      onVolume: (v) => (this.player.volume = v),
    });
    this.director = new Director(SCENES.map((s) => s.meta), null);
    this.player.volume = 0.9;
    this.player.onEnded = () => this.ui.poke();
  }

  async boot(): Promise<void> {
    this.ui.showLoading('Starting', 'Initialising WebGPU', 0);
    let gpu;
    try {
      gpu = await initGpu(this.canvas, (reason) => this.fatal(`The GPU device was lost (${reason}). Reload the page to continue.`));
    } catch (err) {
      const msg =
        err instanceof WebGpuUnavailableError
          ? `${err.message}\nUse a recent Chrome, Edge or other Chromium browser (or Safari 26+ / Firefox with WebGPU enabled) on a machine with a supported GPU.`
          : `WebGPU failed to start: ${err instanceof Error ? err.message : String(err)}`;
      this.ui.showStart(msg);
      return;
    }
    this.renderer = new Renderer(gpu);
    await this.renderer.init(SCENES, LOOKS);
    // Shaders compile lazily; warm a couple of worlds so the idle screen has something to show.
    const starters = SCENES.map((s) => s.meta.id).filter((id) => ['curl-nebula', 'fractal-cathedral', 'aurora-volume'].includes(id));
    await this.renderer.prepare(starters.length ? starters : [SCENES[0].meta.id], [], (done, total) =>
      this.ui.showLoading('Starting', `Compiling visuals ${done}/${total}`, done / total),
    );
    this.sceneIds = SCENES.map((s) => s.meta.id);
    if (!this.availableScenes.length || this.renderer.scenes.size === 0) {
      this.ui.showStart(`No visuals could be compiled on this GPU.\n${this.renderer.errors.map((e) => `${e.id}: ${e.message}`).join('\n')}`);
      return;
    }
    this.director = new Director(this.renderer.scenes.size ? [...this.renderer.scenes.values()].map((s) => s.meta) : this.availableScenes, null, {
      looks: [],
      memory: this.memory,
    });
    this.renderer.perf.refreshHz = await PerfGovernor.detectRefresh();
    this.renderer.rawScene = params.has('nopost');
    // Testing: force composition parts, e.g. ?layout=helix&layers=harmonics,note-sparks
    if (params.get('layout')) forced.layout = params.get('layout')!;
    if (params.get('layers')) forced.layers = params.get('layers')!.split(',');
    if (params.get('camera')) forced.camera = params.get('camera')!;
    if (params.get('background')) forced.background = params.get('background')!;
    if (params.get('material')) forced.material = params.get('material') as typeof forced.material;
    for (const [k, val] of params) if (k.startsWith('post.')) this.renderer.postOverrides[k.slice(5)] = Number(val);
    if (params.has('scale')) {
      const s = Number(params.get('scale'));
      this.renderer.perf.scale = this.renderer.perf.minScale = this.renderer.perf.maxScale = s;
    }
    this.exposeDebug();
    this.bindKeys();
    requestAnimationFrame(this.frame);
    this.ui.showStart();

    const pinned = params.get('scene');
    // Everything else compiles in the background so pins and future shows are instant.
    if (!params.has('nowarm')) setTimeout(() => void this.renderer.warmAll(), 4000);
    if (params.has('demo')) await this.loadDemo();
    if (pinned) this.pin(pinned);
  }

  private fatal(msg: string): void {
    this.ui.showStart(msg);
  }

  /** Every registered scene that hasn't failed to compile. */
  private get availableScenes() {
    const failed = this.renderer?.failedScenes ?? new Set<string>();
    return SCENES.map((s) => s.meta).filter((m) => !failed.has(m.id));
  }

  private get availableLooks() {
    const failed = new Set(this.renderer?.post.lookErrors.map((e) => e.id) ?? []);
    return LOOKS.map((l) => l.meta).filter((m) => !failed.has(m.id));
  }

  private makeDirector(analysis: TrackAnalysis | null): Director {
    // Default: a journey through the world library. ?journey flies the composed sculpture journey;
    // ?cues (or forcing composition parts) composes per cue; ?curated is the old per-cue scene shuffle.
    const compose = !!analysis && (params.has('journey') || params.has('cues') || !!forced.layout || !!forced.layers);
    const d = new Director(this.availableScenes, analysis, {
      looks: this.availableLooks,
      memory: this.memory,
      // ?seed=N fixes the show's random choices (palettes, fusions, DNA) for reproducible testing.
      epoch: params.has('seed') ? Number(params.get('seed')) : Date.now(),
      compose,
      journey: params.has('journey'),
      worlds: !!analysis && !compose && !params.has('curated'),
    });
    for (const c of d.plannedCompositions) this.renderer.registerScene(compositionFactory(c));
    return d;
  }

  // ---------- sources ----------
  private stopLive(): void {
    if (this.source.kind === 'live') {
      this.source.live.dispose();
      this.source.stream.getTracks().forEach((t) => t.stop());
    }
  }

  async loadFile(file: File): Promise<void> {
    const token = ++this.loadToken;
    const title = file.name.replace(/\.[^.]+$/, '');
    try {
      this.ui.showLoading(title, 'Decoding audio', 0.02);
      const data = await file.arrayBuffer();
      const buffer = await this.player.decode(data);
      if (token !== this.loadToken) return;
      await this.startTrack(title, buffer, token);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.ui.showStart(`Couldn't play “${file.name}”: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async loadDemo(): Promise<void> {
    const token = ++this.loadToken;
    const title = 'Demo · Prismatic (synthesised)';
    this.ui.showLoading(title, 'Synthesising demo track', 0.02);
    await new Promise((r) => setTimeout(r, 30));
    const demo = synthesizeDemo(this.player.ctx.sampleRate);
    const buffer = this.player.ctx.createBuffer(2, demo.left.length, demo.sampleRate);
    buffer.copyToChannel(demo.left, 0);
    buffer.copyToChannel(demo.right, 1);
    if (token !== this.loadToken) return;
    await this.startTrack(title, buffer, token);
  }

  private async startTrack(title: string, buffer: AudioBuffer, token: number): Promise<void> {
    this.player.pause();
    this.ui.showLoading(title, 'Preparing analysis', 0.05);
    const signal = await toAnalysisSignal(buffer);
    const analysis = await analyzeInWorker(signal, (stage, p) => {
      if (token === this.loadToken) this.ui.showLoading(title, stage, 0.05 + p * 0.95);
    });
    if (token !== this.loadToken) return;
    // Compile exactly the worlds and looks this show uses; re-plan if any fail on this GPU.
    let director = this.makeDirector(analysis);
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.renderer.prepare(director.plannedScenes, director.plannedLooks, (done, total) => {
        if (token === this.loadToken) this.ui.showLoading(title, `Compiling visuals ${done}/${total}`, done / total);
      });
      const failed = this.renderer.failedScenes;
      const lookFailed = new Set(this.renderer.post.lookErrors.map((e) => e.id));
      if (!director.plannedScenes.some((id) => failed.has(id)) && !director.plannedLooks.some((id) => lookFailed.has(id))) break;
      director = this.makeDirector(analysis);
    }
    if (token !== this.loadToken) return;
    this.stopLive();
    this.player.load(buffer);
    this.source = { kind: 'track', timeline: new AnalysisTimeline(analysis) };
    this.analysis = analysis;
    this.director = director;
    this.renderer.shared.score.load(analysis);
    this.renderer.shared.events.load(analysis);
    this.ui.showPlayer(title, analysis, this.availableScenes);
    if (params.has('t')) this.player.seek(Number(params.get('t')));
    await this.player.play();
    (window as unknown as { __psy: Record<string, unknown> }).__psy.analysis = summarize(analysis);
  }

  async startLive(): Promise<void> {
    const token = ++this.loadToken;
    try {
      this.ui.showLoading('Live input', 'Waiting for microphone permission', 0.1);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (token !== this.loadToken) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.player.pause();
      this.stopLive();
      if (this.player.ctx.state !== 'running') await this.player.ctx.resume();
      const node = this.player.ctx.createMediaStreamSource(stream);
      this.source = { kind: 'live', live: new LiveAnalyzer(this.player.ctx, node), stream };
      this.director = this.makeDirector(null);
      this.renderer.shared.score.clear();
      this.renderer.shared.events.clear();
      this.ui.showPlayer('Live input', null, this.availableScenes);
    } catch (err) {
      this.ui.showStart(`Live input unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private togglePlay(): void {
    if (this.source.kind === 'track') this.player.toggle();
    this.ui.poke();
  }

  private async pin(id: string | null): Promise<void> {
    if (id && !this.sceneIds.includes(id)) return;
    const name = id ? SCENES.find((s) => s.meta.id === id)?.meta.name : null;
    if (id && !this.renderer.isReady(id)) {
      this.ui.toast(`Loading · ${name}`);
      if (!(await this.renderer.ensureScene(id))) {
        this.ui.toast(`${name} failed to compile on this GPU`);
        return;
      }
    }
    this.director.pin(id, this.offline ? this.offlineWall : performance.now() / 1000);
    this.ui.toast(name ? `Pinned · ${name}` : 'Auto-directed');
  }

  private stepScene(dir: number): void {
    const cur = this.director.pinnedScene ?? this.renderer.lastScene;
    const i = this.sceneIds.indexOf(cur);
    this.pin(this.sceneIds[(i + dir + this.sceneIds.length) % this.sceneIds.length]);
  }

  // ---------- loop ----------
  private readonly frame = (now: number) => {
    requestAnimationFrame(this.frame);
    if (this.offline) return;
    const dt = Math.min(0.1, Math.max(1e-4, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const wall = now / 1000;
    let m: MusicState;
    switch (this.source.kind) {
      case 'idle':
        m = this.source.idle.sample(wall);
        break;
      case 'track': {
        // Lead by one display frame: this image is shown roughly a refresh after it's rendered.
        const t = this.player.audibleTime(1 / this.renderer.perf.refreshHz);
        m = this.source.timeline.sample(t, this.player.playing ? dt : 0);
        break;
      }
      case 'live':
        m = this.source.live.sample(dt);
        break;
    }
    const vis = this.director.update(m, dt, wall);
    this.renderer.render(m, vis, wall, dt);
    const perf = this.renderer.perf;
    this.ui.update(
      {
        time: m.time,
        duration: this.player.duration,
        playing: this.player.playing,
        music: m,
        vis,
        fps: perf.fps,
        gpuMs: perf.gpuMs,
        scale: perf.scale,
        refreshHz: perf.refreshHz,
        renderSize: this.renderer.post.size,
        outSize: this.renderer.outputSize,
        live: this.source.kind === 'live',
      },
      this.director.pinnedScene,
    );
  };

  // ---------- input ----------
  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      let handled = true;
      if (k === ' ') this.togglePlay();
      else if (k === 'arrowright') this.player.seek(this.player.audibleTime() + 5);
      else if (k === 'arrowleft') this.player.seek(this.player.audibleTime() - 5);
      else if (k === 'arrowup') this.player.volume = this.player.volume + 0.05;
      else if (k === 'arrowdown') this.player.volume = this.player.volume - 0.05;
      else if (k === 'f') toggleFullscreen();
      else if (k === 'n') this.stepScene(1);
      else if (k === 'p') this.stepScene(-1);
      else if (k === 'a') this.pin(null);
      else if (k === 'i') this.ui.toggleInfo();
      else if (k === 's') this.ui.toggleScenes();
      else if (k === 'h') this.ui.hideChrome();
      else if (k === 'escape') {
        if (this.source.kind === 'idle') handled = false;
        this.ui.infoOpen = false;
        this.ui.scenesOpen = false;
        this.ui.poke();
      } else if (/^[0-9]$/.test(k)) {
        const idx = k === '0' ? 9 : Number(k) - 1;
        if (this.sceneIds[idx]) this.pin(this.sceneIds[idx]);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        if (k !== 'h') this.ui.poke();
      }
    });
  }

  private exposeDebug(): void {
    const app = this;
    let lastMusic: MusicState | null = null;
    (window as unknown as { __psy: Record<string, unknown> }).__psy = {
      get stats() {
        const p = app.renderer.perf;
        return {
          fps: p.fps,
          gpuMs: p.gpuMs,
          scale: p.scale,
          refreshHz: p.refreshHz,
          render: app.renderer.post.size,
          out: app.renderer.outputSize,
          scene: app.renderer.lastScene,
          errors: app.renderer.errors,
          time: app.player.audibleTime(),
          playing: app.player.playing,
          source: app.source.kind,
        };
      },
      scenes: () => [...app.sceneIds],
      post: () => ({ ...app.renderer.lastPost }),
      pin: (id: string | null) => app.pin(id),
      variant: (v: number | null) => (app.director.forcedVariant = v),
      /** Fuse a partner world with whatever is shown (mode 0-5; null id = follow the plan). */
      fuse: (sceneId: string | null, mode = 0, amount = 0.8, seed = 0.37) => {
        app.director.forcedFuse = sceneId ? { sceneId, mode, amount, dna: Array.from({ length: 8 }, (_, i) => (seed * (i + 2) * 1.618 + i * 0.29) % 1) } : null;
        if (sceneId) void app.renderer.ensureScene(sceneId);
      },
      /** The music state of the last offline frame (renderAt). */
      music: () => lastMusic,
      pace: (x: number | null) => (app.renderer.paceOverride = x),
      look: (id: string | null | undefined) => {
        app.director.forcedLook = id;
        return id ? app.renderer.ensureLook(id) : Promise.resolve(null);
      },
      looks: () => LOOKS.map((l) => l.meta.id),
      lookDna: (dna: number[] | null) => (app.director.forcedLookDna = dna),
      lookErrors: () => app.renderer.post.lookErrors,
      ensure: async (id: string) => !!(await app.renderer.ensureScene(id)),
      novelty: () => app.memory.size,
      seek: (t: number) => app.player.seek(t),
      play: () => app.player.play(),
      pause: () => app.player.pause(),
      /**
       * Audit tooling: render one frame at song time t with step dt, without audio or the display
       * loop, then return a w x h RGB thumbnail of the output (and optionally a JPEG).
       */
      /** `crop` (canvas pixels: x, y, w, h) saves that region of the frame instead of the whole frame. */
      renderAt: async (t: number, dt: number, w = 160, h = 90, jpeg = false, imgW = 640, imgH = 360, crop?: [number, number, number, number]) => {
        if (app.source.kind !== 'track') throw new Error('no track loaded');
        if (!app.offline) {
          // A fixed clock, so offline renders are reproducible run to run.
          app.offlineWall = 1000;
          // Offline frames aren't real-time: render at full resolution however busy the GPU is.
          const p = app.renderer.perf;
          p.scale = p.minScale = p.maxScale = 1;
        }
        app.offline = true;
        app.player.pause();
        app.offlineWall += dt;
        const m = app.source.timeline.sample(t, dt);
        lastMusic = m;
        const vis = app.director.update(m, dt, app.offlineWall);
        app.renderer.render(m, vis, app.offlineWall, dt);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d')!;
        g.drawImage(app.canvas, 0, 0, w, h);
        const px = g.getImageData(0, 0, w, h).data;
        const rgb = new Array(w * h * 3);
        for (let i = 0, j = 0; i < px.length; i += 4) {
          rgb[j++] = px[i];
          rgb[j++] = px[i + 1];
          rgb[j++] = px[i + 2];
        }
        let image: string | null = null;
        if (jpeg) {
          const big = document.createElement('canvas');
          big.width = imgW;
          big.height = imgH;
          if (crop) big.getContext('2d')!.drawImage(app.canvas, crop[0], crop[1], crop[2], crop[3], 0, 0, imgW, imgH);
          else big.getContext('2d')!.drawImage(app.canvas, 0, 0, imgW, imgH);
          image = big.toDataURL('image/jpeg', 0.85);
        }
        return { rgb, image, scene: vis.sceneA, palette: vis.palette.map((c) => c.map((x) => +x.toFixed(3))), trans: +vis.transProgress.toFixed(3), sceneB: vis.sceneB };
      },
      /**
       * Audit tooling: force composition parts (or clear them with {}) and re-plan the show for the
       * loaded track, without reloading or re-analysing. Pinning still works on top.
       */
      recompose: async (f: { layout?: string; layers?: string[]; camera?: string; background?: string; material?: string }) => {
        if (!app.analysis) throw new Error('no track loaded');
        for (const k of ['layout', 'layers', 'camera', 'background', 'material'] as const) delete forced[k];
        Object.assign(forced, f);
        app.director = app.makeDirector(app.analysis);
        await app.renderer.prepare(app.director.plannedCompositions.map((c) => c.id), []);
        return app.director.cues.length;
      },
      /** Audit tooling: every composed layer, with a travel layout it supports (flight when it can). */
      layers: () =>
        LAYERS.map((l) => ({ id: l.id, layout: l.layouts === '*' || l.layouts.includes('flight') ? 'flight' : l.layouts[0] })),
      /** Audit tooling: the musical events the visuals should answer to. */
      events: () => {
        const a = app.analysis;
        if (!a) return null;
        const lead = a.notes.filter((n) => n.role === 'lead');
        return {
          duration: a.duration,
          bpm: a.bpm,
          kicks: Array.from(a.kicks.times),
          kickStrengths: Array.from(a.kicks.strengths),
          snareStrengths: Array.from(a.snares.strengths),
          snares: Array.from(a.snares.times),
          hats: Array.from(a.hats.times),
          leadOnsets: lead.map((n) => n.start),
          upperOnsets: app.source.kind === 'track' ? app.source.timeline.upperOnsets : [],
          bassOnsets: a.notes.filter((n) => n.role === 'bass').map((n) => n.start),
          chordChanges: a.chords.map((c) => c.start),
          sections: a.sections.map((s) => ({ start: s.start, end: s.end, kind: s.kind, cluster: s.cluster, energy: s.energy })),
          drops: Array.from(a.drops),
          downbeats: Array.from(a.downbeats),
        };
      },
      cues: () =>
        app.director.cues.map((c) => ({
          start: +c.start.toFixed(2),
          end: +c.end.toFixed(2),
          scene: c.genome.sceneId,
          fuse: c.genome.fuse ? `${c.genome.fuse.sceneId}:${c.genome.fuse.mode}` : null,
          dev: c.genome.develop ? +c.genome.develop.at.toFixed(2) : null,
          look: c.genome.lookId,
          palette: c.genome.paletteScheme,
          kaleido: c.genome.style.kaleido,
          transition: c.transition,
        })),
    };
  }
}

function summarize(a: TrackAnalysis) {
  return {
    duration: a.duration,
    bpm: a.bpm,
    intensity: +a.intensity.toFixed(3),
    character: a.character,
    key: a.key.name,
    genres: a.genres.slice(0, 3).map((g) => `${g.id}:${g.confidence.toFixed(2)}`),
    mood: a.mood.label,
    sections: a.sections.map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)} ${s.kind}`),
    drops: Array.from(a.drops, (d) => +d.toFixed(2)),
  };
}

const canvas = document.getElementById('stage') as HTMLCanvasElement;
void new App(canvas).boot();
