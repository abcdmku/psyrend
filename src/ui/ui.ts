import { chordName } from '../audio/analysis/harmony';
import type { MusicState } from '../audio/musicState';
import { PITCH_NAMES, type SectionKind, type TrackAnalysis } from '../audio/types';
import type { VisualFrame } from '../director/director';
import type { SceneMeta } from '../scenes/types';

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v as string;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'style') el.setAttribute('style', v as string);
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const SECTION_COLORS: Record<SectionKind, string> = {
  intro: '#6b7cff',
  verse: '#58d1ff',
  build: '#ffc65a',
  peak: '#ff4fa3',
  breakdown: '#8f6bff',
  bridge: '#5affc2',
  outro: '#5a6aa8',
};

const SECTION_LABEL: Record<SectionKind, string> = {
  intro: 'Intro',
  verse: 'Verse',
  build: 'Build-up',
  peak: 'Peak',
  breakdown: 'Breakdown',
  bridge: 'Bridge',
  outro: 'Outro',
};

export interface UiHandlers {
  onFile(file: File): void;
  onDemo(): void;
  onLive(): void;
  onTogglePlay(): void;
  onSeek(t: number): void;
  onPin(sceneId: string | null): void;
  onVolume(v: number): void;
}

export interface UiFrame {
  time: number;
  duration: number;
  playing: boolean;
  music: MusicState;
  vis: VisualFrame;
  fps: number;
  gpuMs: number;
  scale: number;
  refreshHz: number;
  renderSize: { w: number; h: number };
  outSize: { w: number; h: number };
  live: boolean;
}

const fmt = (t: number) => {
  if (!isFinite(t)) return '0:00';
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const PLAY_ICON = '<svg viewBox="0 0 12 12"><path d="M2 1l9 5-9 5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 12 12"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>';

export class Ui {
  private readonly start: HTMLElement;
  private readonly startError: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly loadingTitle: HTMLElement;
  private readonly loadingStage: HTMLElement;
  private readonly loadingBar: HTMLElement;
  private readonly hudTop: HTMLElement;
  private readonly hudBottom: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly chipsEl: HTMLElement;
  private readonly sceneBtn: HTMLButtonElement;
  private readonly sceneMode: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly timeEl: HTMLElement;
  private readonly scrub: HTMLElement;
  private readonly scrubSections: HTMLElement;
  private readonly scrubProgress: HTMLElement;
  private readonly scrubHead: HTMLElement;
  private readonly scrubTip: HTMLElement;
  private readonly info: HTMLElement;
  private readonly scenesPanel: HTMLElement;
  private readonly toastEl: HTMLElement;
  private infoFields: Record<string, HTMLElement> = {};
  private analysis: TrackAnalysis | null = null;
  private scenes: SceneMeta[] = [];
  private duration = 0;
  private lastDom = 0;
  private idleTimer = 0;
  private toastTimer = 0;
  private mode: 'start' | 'loading' | 'player' = 'start';
  private chromeHidden = false;
  private hudVisible = true;
  infoOpen = false;
  scenesOpen = false;
  private lastPlaying: boolean | null = null;
  private dropDepth = 0;

  constructor(
    root: HTMLElement,
    private readonly handlers: UiHandlers,
  ) {
    const fileInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.opus,.webm', 'aria-label': 'Choose an audio file' });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) handlers.onFile(f);
      fileInput.value = '';
    });
    const drop = h('label', { class: 'drop' }, h('div', { class: 'drop-title' }, 'Drop a track'), h('div', { class: 'drop-sub' }, 'or click to browse · mp3 wav flac ogg m4a'), fileInput);
    this.startError = h('div', { class: 'error' });
    this.start = h(
      'div',
      { class: 'start fade' },
      h(
        'div',
        { class: 'start-inner' },
        h('h1', { class: 'wordmark' }, 'psyrend'),
        h('div', { class: 'tagline' }, 'visuals made from your music'),
        drop,
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'pill', onclick: () => handlers.onDemo() }, 'Play demo track'),
          h('button', { class: 'pill', onclick: () => handlers.onLive() }, 'Live input'),
        ),
        this.startError,
      ),
    );

    this.loadingTitle = h('div', { class: 'loading-title' });
    this.loadingStage = h('div', { class: 'loading-stage' });
    this.loadingBar = h('i');
    this.loading = h('div', { class: 'loading fade hidden' }, h('div', { class: 'loading-card' }, this.loadingTitle, h('div', { class: 'bar' }, this.loadingBar), this.loadingStage));

    this.titleEl = h('div', { class: 'track-title' });
    this.chipsEl = h('div', { class: 'chips' });
    this.sceneBtn = h('button', { onclick: () => this.toggleScenes(), title: 'Choose visual (S)' });
    this.sceneMode = h('div', { class: 'scene-mode' });
    this.hudTop = h('div', { class: 'hud-top fade hidden' }, h('div', {}, this.titleEl, this.chipsEl), h('div', { class: 'scene-name' }, this.sceneBtn, this.sceneMode));

    this.playBtn = h('button', { class: 'play', onclick: () => handlers.onTogglePlay(), 'aria-label': 'Play/pause' });
    this.playBtn.innerHTML = PLAY_ICON;
    this.timeEl = h('div', { class: 'time' });
    this.scrubSections = h('div', { class: 'scrub-sections' });
    this.scrubProgress = h('div', { class: 'scrub-progress' });
    this.scrubHead = h('div', { class: 'scrub-head' });
    this.scrubTip = h('div', { class: 'scrub-tip' });
    this.scrub = h('div', { class: 'scrub', role: 'slider', 'aria-label': 'Seek' }, this.scrubSections, this.scrubProgress, this.scrubHead, this.scrubTip);
    this.bindScrub();
    const vol = h('input', { class: 'vol', type: 'range', min: '0', max: '1', step: '0.01', value: '0.9', 'aria-label': 'Volume' }) as HTMLInputElement;
    vol.addEventListener('input', () => handlers.onVolume(Number(vol.value)));
    this.hudBottom = h(
      'div',
      { class: 'hud-bottom fade hidden' },
      h(
        'div',
        { class: 'transport' },
        this.playBtn,
        this.timeEl,
        this.scrub,
        vol,
        h('button', { class: 'icon-btn', onclick: () => this.toggleInfo(), title: 'Analysis (I)' }, 'Info'),
        h('button', { class: 'icon-btn', onclick: () => toggleFullscreen(), title: 'Fullscreen (F)' }, 'Full'),
      ),
      h('div', { class: 'keys' }, h('kbd', {}, 'Space'), ' play  ', h('kbd', {}, '←→'), ' seek  ', h('kbd', {}, 'N P'), ' visual  ', h('kbd', {}, 'A'), ' auto  ', h('kbd', {}, 'I'), ' info  ', h('kbd', {}, 'H'), ' hide  ', h('kbd', {}, 'F'), ' full'),
    );

    this.info = h('dl', { class: 'panel info fade hidden' });
    this.scenesPanel = h('div', { class: 'panel scenes fade hidden' });
    this.toastEl = h('div', { class: 'toast fade hidden' });
    root.append(this.start, this.loading, this.hudTop, this.hudBottom, this.info, this.scenesPanel, this.toastEl);
    this.buildInfo();
    this.bindGlobal();
  }

  // ---------- modes ----------
  showStart(error?: string): void {
    this.mode = 'start';
    this.startError.textContent = error ?? '';
    this.start.classList.remove('hidden');
    this.loading.classList.add('hidden');
    this.setHud(false);
  }

  showLoading(title: string, stage: string, progress: number): void {
    this.mode = 'loading';
    this.start.classList.add('hidden');
    this.loading.classList.remove('hidden');
    this.setHud(false);
    this.loadingTitle.textContent = title;
    this.loadingStage.textContent = stage;
    this.loadingBar.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }

  showPlayer(title: string, analysis: TrackAnalysis | null, scenes: SceneMeta[]): void {
    this.mode = 'player';
    this.analysis = analysis;
    this.scenes = scenes;
    this.duration = analysis?.duration ?? 0;
    this.start.classList.add('hidden');
    this.loading.classList.add('hidden');
    this.titleEl.textContent = title;
    this.chipsEl.replaceChildren();
    if (analysis) {
      const g = analysis.genres[0];
      const chip = (label: string, value: string) => h('span', { class: 'chip' }, `${label} `, h('b', {}, value));
      this.chipsEl.append(
        chip('', g.label),
        chip('', analysis.key.name),
        chip('', `${Math.round(analysis.bpm)} BPM`),
        chip('', analysis.mood.label),
        chip('', `${analysis.sections.length} sections`),
      );
      this.scrubSections.replaceChildren(
        ...analysis.sections.map((s) =>
          h('i', { style: `flex:${s.end - s.start} 0 0;background:${SECTION_COLORS[s.kind]}`, title: SECTION_LABEL[s.kind] }),
        ),
      );
      this.scrub.querySelectorAll('.scrub-drop').forEach((e) => e.remove());
      for (const d of analysis.drops) this.scrub.append(h('div', { class: 'scrub-drop', style: `left:${(d / analysis.duration) * 100}%` }));
    } else {
      this.chipsEl.append(h('span', { class: 'chip' }, h('b', {}, 'Live input'), ' · real-time analysis'));
      this.scrubSections.replaceChildren();
    }
    this.scrub.style.visibility = analysis ? 'visible' : 'hidden';
    this.buildScenes();
    this.setHud(true);
    this.poke();
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('hidden'), 1800);
  }

  // ---------- HUD visibility ----------
  private setHud(on: boolean): void {
    this.hudVisible = on;
    const show = on && !this.chromeHidden;
    this.hudTop.classList.toggle('hidden', !show);
    this.hudBottom.classList.toggle('hidden', !show);
    this.info.classList.toggle('hidden', !(show && this.infoOpen));
    this.scenesPanel.classList.toggle('hidden', !(show && this.scenesOpen));
    document.body.classList.toggle('idle-cursor', this.mode === 'player' && !show);
  }

  /** Shows chrome on activity; it fades after a few idle seconds. */
  poke(): void {
    if (this.mode !== 'player') return;
    this.chromeHidden = false;
    this.setHud(true);
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (this.infoOpen || this.scenesOpen || this.scrubDragging) return;
      this.chromeHidden = true;
      this.setHud(this.hudVisible);
    }, 2600);
  }

  hideChrome(): void {
    this.chromeHidden = true;
    this.infoOpen = false;
    this.scenesOpen = false;
    this.setHud(this.hudVisible);
  }

  toggleInfo(): void {
    this.infoOpen = !this.infoOpen;
    this.poke();
  }

  toggleScenes(): void {
    this.scenesOpen = !this.scenesOpen;
    this.poke();
  }

  // ---------- scrub ----------
  private scrubDragging = false;
  private bindScrub(): void {
    const at = (e: PointerEvent) => {
      const r = this.scrub.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    this.scrub.addEventListener('pointerdown', (e) => {
      this.scrubDragging = true;
      this.scrub.setPointerCapture(e.pointerId);
      this.handlers.onSeek(at(e) * this.duration);
    });
    this.scrub.addEventListener('pointermove', (e) => {
      const x = at(e);
      const t = x * this.duration;
      const s = this.analysis?.sections.find((sec) => t >= sec.start && t < sec.end);
      this.scrubTip.textContent = `${fmt(t)}${s ? ` · ${SECTION_LABEL[s.kind]}` : ''}`;
      this.scrubTip.style.left = `${x * 100}%`;
      if (this.scrubDragging) this.handlers.onSeek(t);
    });
    const end = () => {
      this.scrubDragging = false;
    };
    this.scrub.addEventListener('pointerup', end);
    this.scrub.addEventListener('pointercancel', end);
  }

  // ---------- panels ----------
  private buildInfo(): void {
    const rows: [string, string][] = [
      ['section', 'Section'],
      ['chord', 'Chord'],
      ['tension', 'Tension'],
      ['energy', 'Energy'],
      ['valence', 'Valence'],
      ['arousal', 'Arousal'],
      ['antic', 'Lookahead'],
      ['chroma', 'Chroma'],
      ['genre', 'Genre'],
      ['beat', 'Beat'],
      ['perf', 'Frame'],
      ['res', 'Render'],
    ];
    const meterRows = new Set(['tension', 'energy', 'valence', 'arousal', 'antic']);
    for (const [key, label] of rows) {
      const dd = meterRows.has(key) ? h('dd', { class: 'meter' }, h('i')) : key === 'chroma' ? h('dd', { class: 'chroma' }, ...Array.from({ length: 12 }, () => h('i'))) : h('dd');
      this.infoFields[key] = dd;
      this.info.append(h('dt', {}, label), dd);
    }
  }

  private buildScenes(): void {
    this.scenesPanel.replaceChildren(
      h('div', { class: 'scenes-head' }, h('span', {}, 'Visuals'), h('button', { onclick: () => this.handlers.onPin(null) }, 'Auto ⟲')),
      ...this.scenes.map((s, i) =>
        h(
          'button',
          { class: 'scene-item', 'data-id': s.id, onclick: () => this.handlers.onPin(s.id) },
          h('span', {}, s.name),
          h('kbd', {}, i < 9 ? String(i + 1) : i === 9 ? '0' : ''),
        ),
      ),
    );
  }

  update(f: UiFrame, pinned: string | null): void {
    if (this.mode !== 'player') return;
    const now = performance.now();
    if (this.analysis && this.duration > 0) {
      const x = Math.min(1, f.time / this.duration);
      this.scrubProgress.style.width = `${x * 100}%`;
      this.scrubHead.style.left = `${x * 100}%`;
    }
    if (this.lastPlaying !== f.playing) {
      this.lastPlaying = f.playing;
      this.playBtn.innerHTML = f.playing ? PAUSE_ICON : PLAY_ICON;
    }
    if (now - this.lastDom < 80) return;
    this.lastDom = now;
    this.timeEl.textContent = f.live ? 'LIVE' : `${fmt(f.time)} / ${fmt(f.duration)}`;
    const current = f.vis.sceneB && f.vis.transProgress > 0.5 ? f.vis.sceneB : f.vis.sceneA;
    const meta = this.scenes.find((s) => s.id === current);
    this.sceneBtn.textContent = meta?.name ?? current;
    this.sceneMode.textContent = pinned ? 'pinned · A for auto' : 'auto-directed';
    this.scenesPanel.querySelectorAll<HTMLElement>('.scene-item').forEach((el) => el.classList.toggle('active', el.dataset.id === current));

    if (!this.infoOpen) return;
    const m = f.music;
    const set = (k: string, v: string) => (this.infoFields[k].textContent = v);
    const meter = (k: string, v: number) => ((this.infoFields[k].firstElementChild as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`);
    set('section', m.section ? `${SECTION_LABEL[m.section.kind]} · ${Math.round(m.sectionProgress * 100)}%` : f.live ? 'live' : '–');
    set('chord', m.chord ? `${chordName(m.chord)}${this.analysis ? `  in ${this.analysis.key.name}` : ''}` : '–');
    meter('tension', m.tension);
    meter('energy', m.energy);
    meter('valence', m.valence);
    meter('arousal', m.arousal);
    meter('antic', Math.max(m.anticipation, m.dropPulse));
    const bars = this.infoFields.chroma.children;
    for (let i = 0; i < 12; i++) (bars[i] as HTMLElement).style.height = `${Math.round(m.chroma[i] * 100)}%`;
    this.infoFields.chroma.title = PITCH_NAMES.join(' ');
    set('genre', this.analysis ? this.analysis.genres.slice(0, 2).map((g) => `${g.label} ${Math.round(g.confidence * 100)}%`).join(' · ') : 'live');
    set('beat', `${Math.round(m.bpm)} bpm · ${(m.beatIndex % m.beatsPerBar) + 1}/${m.beatsPerBar}`);
    set('perf', `${f.fps} fps (${f.refreshHz} Hz display) · gpu ${f.gpuMs.toFixed(1)} ms`);
    set('res', `${f.renderSize.w}×${f.renderSize.h} (${Math.round(f.scale * 100)}%) → ${f.outSize.w}×${f.outSize.h}`);
  }

  // ---------- global input ----------
  private bindGlobal(): void {
    window.addEventListener('pointermove', () => this.poke());
    window.addEventListener('pointerdown', () => this.poke());
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      this.dropDepth++;
      this.start.querySelector('.drop')?.classList.add('over');
    });
    window.addEventListener('dragleave', () => {
      if (--this.dropDepth <= 0) this.start.querySelector('.drop')?.classList.remove('over');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropDepth = 0;
      this.start.querySelector('.drop')?.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) this.handlers.onFile(f);
    });
  }
}

export function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
}
