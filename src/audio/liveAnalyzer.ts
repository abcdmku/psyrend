import { emptyMusicState, type MusicState } from './musicState';
import { BAND_COUNT } from './types';

/** Tracks a signal's recent range so live features land in 0..1 regardless of input level. */
class AutoRange {
  private lo = Infinity;
  private hi = -Infinity;
  constructor(
    private readonly decay: number,
    private readonly minSpan: number,
  ) {}
  map(v: number, dt: number): number {
    const k = 1 - Math.exp(-dt / this.decay);
    if (!isFinite(this.lo)) {
      this.lo = v - this.minSpan;
      this.hi = v;
    }
    this.hi = v > this.hi ? v : this.hi + (v - this.hi) * k * 0.5;
    this.lo = v < this.lo ? v : this.lo + (v - this.lo) * k * 0.15;
    const span = Math.max(this.minSpan, this.hi - this.lo);
    return Math.max(0, Math.min(1, (v - this.lo) / span));
  }
}

/** Adaptive-threshold onset detector over a flux stream. */
class OnsetDetector {
  private readonly hist: number[] = [];
  private last = -Infinity;
  env = 0;
  constructor(
    private readonly refractory: number,
    private readonly k: number,
    private readonly decay: number,
  ) {}
  push(v: number, t: number, dt: number): boolean {
    this.hist.push(v);
    if (this.hist.length > 90) this.hist.shift();
    const mean = this.hist.reduce((a, b) => a + b, 0) / this.hist.length;
    const sd = Math.sqrt(this.hist.reduce((a, b) => a + (b - mean) ** 2, 0) / this.hist.length);
    this.env *= Math.exp(-dt / this.decay);
    if (v > mean + this.k * sd + 1e-4 && t - this.last > this.refractory) {
      this.last = t;
      this.env = Math.min(1, 0.5 + (v - mean) / (sd * 6 + 1e-6));
      return true;
    }
    return false;
  }
}

/**
 * Real-time analysis of a live stream (microphone / tab capture). No look-ahead is
 * possible, so it estimates tempo by autocorrelation over the last 8 s and keeps
 * a phase-locked beat clock.
 */
export class LiveAnalyzer {
  private readonly analyser: AnalyserNode;
  private readonly freq: Float32Array<ArrayBuffer>;
  private readonly wave: Float32Array<ArrayBuffer>;
  private readonly prevLog: Float32Array;
  private readonly bandEdges: [number, number][];
  private readonly s = emptyMusicState();
  private readonly ranges = Array.from({ length: 8 }, () => new AutoRange(6, 18));
  private readonly bandRange = new AutoRange(8, 40);
  private readonly fluxRange = new AutoRange(4, 1);
  private readonly kick = new OnsetDetector(0.11, 1.6, 0.16);
  private readonly snare = new OnsetDetector(0.11, 1.8, 0.14);
  private readonly hat = new OnsetDetector(0.05, 1.5, 0.06);
  private readonly all = new OnsetDetector(0.06, 1.4, 0.1);
  private readonly envelope: number[] = [];
  private envAcc = 0;
  private envTime = 0;
  private bpm = 120;
  private beatClock = 0;
  private lastTempo = 0;
  private slowEnergy = 0;
  private surgeRef = 0;
  private lastSurge = -Infinity;
  private t = 0;

  constructor(
    private readonly ctx: AudioContext,
    readonly source: AudioNode,
  ) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.wave = new Float32Array(this.analyser.fftSize);
    this.prevLog = new Float32Array(this.analyser.frequencyBinCount);
    const binHz = ctx.sampleRate / this.analyser.fftSize;
    this.bandEdges = Array.from({ length: BAND_COUNT }, (_, b) => {
      const f0 = 30 * (11000 / 30) ** (b / BAND_COUNT);
      const f1 = 30 * (11000 / 30) ** ((b + 1) / BAND_COUNT);
      const lo = Math.max(1, Math.floor(f0 / binHz));
      return [lo, Math.max(lo, Math.floor(f1 / binHz))];
    });
  }

  dispose(): void {
    this.source.disconnect(this.analyser);
  }

  sample(dt: number): MusicState {
    const s = this.s;
    dt = Math.min(0.1, Math.max(1e-3, dt));
    this.t += dt;
    const t = this.t;
    s.time = t;
    this.analyser.getFloatFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.wave);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    let rms = 0;
    for (let i = 0; i < this.wave.length; i++) rms += this.wave[i] * this.wave[i];
    rms = 10 * Math.log10(rms / this.wave.length + 1e-10);

    // Groups, centroid, flatness, flux.
    const groups = [0, 0, 0, 0, 0];
    const edges = [60, 200, 800, 3000, 20000];
    let cn = 0, cd = 0, fl = 0, fm = 0, fh = 0, ls = 0, la = 0, ln = 0;
    for (let k = 1; k < this.freq.length; k++) {
      const db = Math.max(-140, this.freq[k]);
      const mag = 10 ** (db / 20);
      const p = mag * mag;
      const f = k * binHz;
      let g = 0;
      while (g < 4 && f >= edges[g]) g++;
      groups[g] += p;
      cn += f * mag;
      cd += mag;
      const lg = Math.log1p(mag * 300);
      const d = Math.max(0, lg - this.prevLog[k]);
      this.prevLog[k] = lg;
      if (f < 150) fl += d;
      else if (f < 4000) fm += d;
      else if (f > 5000 && f < 16000) fh += d;
      if (f > 100 && f < 8000) {
        ls += Math.log(p + 1e-14);
        la += p;
        ln++;
      }
    }
    const toDb = (p: number) => 10 * Math.log10(p + 1e-12);
    s.sub = this.ranges[0].map(toDb(groups[0]), dt);
    s.bass = this.ranges[1].map(toDb(groups[1]), dt);
    s.lowMid = this.ranges[2].map(toDb(groups[2]), dt);
    s.mid = this.ranges[3].map(toDb(groups[3]), dt);
    s.high = this.ranges[4].map(toDb(groups[4]), dt);
    s.energy = this.ranges[5].map(rms, dt);
    this.slowEnergy += (s.energy - this.slowEnergy) * (1 - Math.exp(-dt / 1.2));
    s.energySlow = this.slowEnergy;
    const centroid = cd > 0 ? cn / cd : 0;
    s.centroid += (Math.max(0, Math.min(1, (Math.log2(Math.max(100, centroid)) - Math.log2(100)) / Math.log2(80))) - s.centroid) * 0.2;
    const flat = la > 0 ? Math.exp(ls / ln) / (la / ln) : 0;
    s.flatness += (Math.min(1, flat * 4) - s.flatness) * 0.2;
    const flux = fl + fm + fh;
    s.flux = this.fluxRange.map(flux, dt);

    // Bands.
    const atk = 1 - Math.exp(-dt / 0.012);
    const rel = 1 - Math.exp(-dt / 0.14);
    for (let b = 0; b < BAND_COUNT; b++) {
      const [lo, hi] = this.bandEdges[b];
      let m = -140;
      for (let k = lo; k <= hi && k < this.freq.length; k++) m = Math.max(m, this.freq[k]);
      const v = this.bandRange.map(m, dt / BAND_COUNT) ** 1.4;
      s.bands[b] += (v - s.bands[b]) * (v > s.bands[b] ? atk : rel);
    }

    // Chroma from spectral peaks.
    const chroma = new Float32Array(12);
    for (let k = 2; k < this.freq.length - 1; k++) {
      const f = k * binHz;
      if (f < 70 || f > 4500) continue;
      const v = this.freq[k];
      if (v < this.freq[k - 1] || v < this.freq[k + 1] || v < -80) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += 10 ** (v / 20);
    }
    const cmax = Math.max(1e-9, ...chroma);
    for (let c = 0; c < 12; c++) s.chroma[c] += (chroma[c] / cmax - s.chroma[c]) * (1 - Math.exp(-dt / 0.15));

    // Onsets.
    this.kick.push(fl, t, dt);
    this.snare.push(fm * (0.4 + s.flatness), t, dt);
    this.hat.push(fh, t, dt);
    const onset = this.all.push(flux, t, dt);
    s.kick = this.kick.env;
    s.snare = this.snare.env;
    s.hat = this.hat.env;
    s.onset = this.all.env;
    s.percussive += ((onset ? 1 : 0) * 0.5 + s.flux * 0.5 - s.percussive) * 0.05;

    // Onset envelope at 100 Hz for tempo estimation.
    this.envAcc += flux;
    this.envTime += dt;
    while (this.envTime >= 0.01) {
      this.envelope.push(this.envAcc);
      this.envAcc = 0;
      this.envTime -= 0.01;
      if (this.envelope.length > 800) this.envelope.shift();
    }
    if (t - this.lastTempo > 1 && this.envelope.length > 300) {
      this.lastTempo = t;
      this.bpm = estimateLiveTempo(this.envelope, this.bpm);
    }
    s.bpm = this.bpm;
    const period = 60 / this.bpm;
    this.beatClock += dt / period;
    // Phase-lock: nudge the clock toward detected kicks/onsets near a predicted beat.
    if (onset || s.kick > 0.95) {
      const ph = this.beatClock % 1;
      const err = ph > 0.5 ? ph - 1 : ph;
      if (Math.abs(err) < 0.2) this.beatClock -= err * 0.25;
    }
    s.beatsPerBar = 4;
    s.beatIndex = Math.floor(this.beatClock);
    s.beatPhase = this.beatClock % 1;
    s.barIndex = Math.floor(this.beatClock / 4);
    s.barPhase = (this.beatClock / 4) % 1;
    s.beatPulse = Math.exp((-s.beatPhase * period) / 0.12);
    s.barPulse = Math.exp((-s.barPhase * period * 4) / 0.25);
    s.kickNext = Math.exp((-(1 - s.beatPhase) * period) / 0.06) * 0.6;

    // Mood heuristics.
    let maj = 0;
    let min = 0;
    let best = 0;
    for (let r = 0; r < 12; r++) {
      const M = s.chroma[r] + s.chroma[(r + 4) % 12] + s.chroma[(r + 7) % 12];
      const m = s.chroma[r] + s.chroma[(r + 3) % 12] + s.chroma[(r + 7) % 12];
      if (M > best) { best = M; maj = 1; min = 0; }
      if (m > best) { best = m; maj = 0; min = 1; }
    }
    const k = 1 - Math.exp(-dt / 3);
    s.majorness += (maj - min * 0.5 + 0.5 - s.majorness) * k * 0.5;
    const tempoF = Math.max(0, Math.min(1, (this.bpm - 60) / 120));
    s.arousal += (0.45 * s.energySlow + 0.2 * s.flux + 0.15 * s.centroid + 0.2 * tempoF - s.arousal) * k;
    s.valence += (0.35 * s.majorness + 0.25 * s.centroid + 0.2 * tempoF + 0.2 * s.energySlow - s.valence) * k;
    s.tension += (s.flatness * 0.5 + (1 - s.majorness) * 0.3 - s.tension) * k;

    // Surges stand in for drops: a sharp rise of slow energy after a lull.
    this.surgeRef = Math.min(this.surgeRef + dt * 0.05, s.energySlow);
    if (s.energySlow - this.surgeRef > 0.28 && t - this.lastSurge > 8) {
      this.lastSurge = t;
      this.surgeRef = s.energySlow;
    }
    s.dropPulse = Math.exp(-(t - this.lastSurge) / 1.2);
    s.anticipation = 0;
    return s;
  }
}

function estimateLiveTempo(env: number[], prev: number): number {
  const n = env.length;
  const mean = env.reduce((a, b) => a + b, 0) / n;
  const x = env.map((v) => v - mean);
  let best = prev;
  let bestScore = -Infinity;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = 6000 / bpm;
    let s = 0;
    for (const mul of [1, 2]) {
      const L = Math.round(lag * mul);
      for (let i = L; i < n; i++) s += (x[i] * x[i - L]) / mul;
    }
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.6) ** 2);
    const stick = Math.exp(-0.5 * ((bpm - prev) / 6) ** 2) * 0.15 + 1;
    const score = s * prior * stick;
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return prev + (best - prev) * 0.5;
}
