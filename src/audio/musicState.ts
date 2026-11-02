import { lowerIndex } from './analysis/util';
import { BAND_COUNT, type Chord, type NoteEvent, type OnsetTrack, type Section, type TrackAnalysis } from './types';

/** Everything the visuals know about the music at one instant. */
export interface MusicState {
  time: number;
  duration: number;
  bands: Float32Array;
  chroma: Float32Array;
  energy: number;
  energySlow: number;
  sub: number;
  bass: number;
  lowMid: number;
  mid: number;
  high: number;
  centroid: number;
  flatness: number;
  percussive: number;
  flux: number;
  kick: number;
  snare: number;
  hat: number;
  onset: number;
  /** Rises toward 1 as the next kick approaches (look-ahead). */
  kickNext: number;
  /** Melody attack envelope: jumps to the lead note's strength at each attack, decays over ~0.2 s. */
  lead: number;
  /** The melody's pitch, -1 (an octave below its centre) .. 1 (an octave above), gliding 80 ms between notes. */
  leadPitch: number;
  /** The current melody note's exact pitch on the same -1..1 scale, without the glide (right at the attack). */
  leadNote: number;
  /** Strength of the lead note sounding now (0 in rests). */
  leadHeld: number;
  /**
   * The upper voice: high melodies, arpeggios and countermelodies above the lead's centre. Attack
   * envelope (like `lead`), exact pitch 0..1 (MIDI 60..108), and the strength sounding now.
   */
  upper: number;
  upperPitch: number;
  upperHeld: number;
  /** Backing harmony (pads and chord voices): attack envelope of its notes and how much sounds now (0..1). */
  backing: number;
  backingHeld: number;
  bpm: number;
  /** 0..1 how hard the whole song hits in absolute terms (constant per track); sets the overall pace. */
  intensity: number;
  beatsPerBar: number;
  beatIndex: number;
  beatPhase: number;
  barIndex: number;
  barPhase: number;
  beatPulse: number;
  barPulse: number;
  chord: Chord | null;
  chordIndex: number;
  /** Decays from 1 at each chord change. */
  chordPulse: number;
  tension: number;
  majorness: number;
  valence: number;
  arousal: number;
  section: Section | null;
  sectionIndex: number;
  sectionProgress: number;
  /** Seconds until the next section starts (Infinity on the last). */
  toNextSection: number;
  anticipation: number;
  /** Decays from 1 at each detected drop. */
  dropPulse: number;
  /** Seconds until the next drop (Infinity if none). */
  toNextDrop: number;
}

export function emptyMusicState(): MusicState {
  return {
    time: 0, duration: 0, bands: new Float32Array(BAND_COUNT), chroma: new Float32Array(12),
    energy: 0, energySlow: 0, sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, centroid: 0.3, flatness: 0, percussive: 0, flux: 0,
    kick: 0, snare: 0, hat: 0, onset: 0, kickNext: 0, lead: 0, leadPitch: 0, leadNote: 0, leadHeld: 0, upper: 0, upperPitch: 0.5, upperHeld: 0, backing: 0, backingHeld: 0, bpm: 120, intensity: 0.6, beatsPerBar: 4, beatIndex: 0, beatPhase: 0, barIndex: 0,
    barPhase: 0, beatPulse: 0, barPulse: 0, chord: null, chordIndex: -1, chordPulse: 0, tension: 0.2, majorness: 0.5,
    valence: 0.5, arousal: 0.4, section: null, sectionIndex: -1, sectionProgress: 0, toNextSection: Infinity,
    anticipation: 0, dropPulse: 0, toNextDrop: Infinity,
  };
}

function envelopeAt(track: OnsetTrack, t: number, decay: number): number {
  const i = lowerIndex(track.times, t);
  if (i < 0) return 0;
  const age = t - track.times[i];
  return track.strengths[i] * Math.exp(-age / decay);
}

/** Samples a precomputed TrackAnalysis at the playback time, with display smoothing. */
export class AnalysisTimeline {
  private readonly state = emptyMusicState();
  private readonly smoothBands = new Float32Array(BAND_COUNT);
  private lastTime = -1;
  private readonly lead: NoteEvent[];
  private readonly leadStarts: Float32Array;
  private readonly leadCentre: number;
  private readonly upperNotes: NoteEvent[];
  private readonly upperStarts: Float32Array;
  private readonly backingNotes: NoteEvent[];
  private readonly backingStarts: Float32Array;

  /** Onset times of the upper voice (high melodies, arps), for tests. */
  get upperOnsets(): number[] {
    return Array.from(this.upperStarts);
  }

  constructor(readonly analysis: TrackAnalysis) {
    // The melody: the lead line, or the bass when the lead is too sparse to carry one.
    const lead = analysis.notes.filter((n) => n.role === 'lead');
    this.lead = (lead.length >= analysis.duration / 4 ? lead : analysis.notes.filter((n) => n.role !== 'poly')).sort((x, y) => x.start - y.start);
    this.leadStarts = Float32Array.from(this.lead, (n) => n.start);
    const ps = this.lead.map((n) => n.pitch).sort((x, y) => x - y);
    this.leadCentre = ps.length ? ps[Math.floor(ps.length / 2)] : 60;
    // The upper voice: any non-bass note well above the lead's centre (high lines, arps, counter-
    // melodies). Backing: the harmony voices (poly notes) that aren't in the upper voice.
    const top = Math.max(this.leadCentre + 5, 70);
    this.upperNotes = analysis.notes.filter((n) => n.role !== 'bass' && n.pitch >= top).sort((x, y) => x.start - y.start);
    this.upperStarts = Float32Array.from(this.upperNotes, (n) => n.start);
    this.backingNotes = analysis.notes.filter((n) => n.role === 'poly' && n.pitch < top).sort((x, y) => x.start - y.start);
    this.backingStarts = Float32Array.from(this.backingNotes, (n) => n.start);
    this.state.duration = analysis.duration;
    this.state.bpm = analysis.bpm;
    this.state.intensity = analysis.intensity ?? 0.6;
    this.state.beatsPerBar = analysis.beatsPerBar;
  }

  sample(t: number, dt: number): MusicState {
    const a = this.analysis;
    const s = this.state;
    const jumped = Math.abs(t - this.lastTime) > 0.5;
    this.lastTime = t;
    s.time = t;
    const fx = Math.max(0, Math.min(a.frameCount - 1.001, t * a.frameRate));
    const f0 = Math.floor(fx);
    const ft = fx - f0;
    const f1 = f0 + 1;
    const lerp = (arr: Float32Array) => arr[f0] + (arr[f1] - arr[f0]) * ft;

    s.energy = lerp(a.energy);
    s.energySlow = lerp(a.energySlow);
    s.sub = lerp(a.sub);
    s.bass = lerp(a.bass);
    s.lowMid = lerp(a.lowMid);
    s.mid = lerp(a.mid);
    s.high = lerp(a.high);
    s.centroid = lerp(a.centroid);
    s.flatness = lerp(a.flatness);
    s.percussive = lerp(a.percussive);
    s.flux = lerp(a.flux);
    s.valence = lerp(a.valence);
    s.arousal = lerp(a.arousal);
    s.anticipation = lerp(a.anticipation);

    // Bands: fast attack, slower release so bars feel physical.
    const atk = 1 - Math.exp(-dt / 0.012);
    const rel = 1 - Math.exp(-dt / 0.14);
    for (let b = 0; b < BAND_COUNT; b++) {
      const v = a.bands[f0 * BAND_COUNT + b] * (1 - ft) + a.bands[f1 * BAND_COUNT + b] * ft;
      const cur = this.smoothBands[b];
      this.smoothBands[b] = jumped ? v : cur + (v - cur) * (v > cur ? atk : rel);
    }
    s.bands.set(this.smoothBands);
    const cr = 1 - Math.exp(-dt / 0.08);
    for (let c = 0; c < 12; c++) {
      const v = a.chroma[f0 * 12 + c] * (1 - ft) + a.chroma[f1 * 12 + c] * ft;
      s.chroma[c] = jumped ? v : s.chroma[c] + (v - s.chroma[c]) * cr;
    }

    s.kick = envelopeAt(a.kicks, t, 0.16);
    s.snare = envelopeAt(a.snares, t, 0.14);
    s.hat = envelopeAt(a.hats, t, 0.06);
    s.onset = envelopeAt(a.onsets, t, 0.1);
    const nk = lowerIndex(a.kicks.times, t) + 1;
    s.kickNext = nk < a.kicks.times.length ? Math.exp(-(a.kicks.times[nk] - t) / 0.06) * a.kicks.strengths[nk] : 0;

    // Melody.
    const li = lowerIndex(this.leadStarts, t);
    if (li >= 0) {
      const n = this.lead[li];
      const p = this.lead[li - 1];
      const norm = (x: number) => Math.max(-1, Math.min(1, (x - this.leadCentre) / 12));
      const g = Math.min(1, (t - n.start) / 0.08);
      s.lead = Math.exp(-(t - n.start) / 0.2) * (0.4 + 0.6 * n.strength);
      s.leadNote = norm(n.pitch);
      s.leadPitch = p ? norm(p.pitch) + (norm(n.pitch) - norm(p.pitch)) * g * g * (3 - 2 * g) : norm(n.pitch);
      s.leadHeld = t < n.end ? n.strength : 0;
    } else {
      s.lead = 0;
      s.leadHeld = 0;
    }

    // Upper voice and backing harmony.
    const ui = lowerIndex(this.upperStarts, t);
    if (ui >= 0) {
      const n = this.upperNotes[ui];
      s.upper = Math.exp(-(t - n.start) / 0.15) * (0.4 + 0.6 * n.strength);
      s.upperPitch = Math.max(0, Math.min(1, (n.pitch - 60) / 48));
      let held = 0;
      for (let k = ui; k >= 0 && k > ui - 8; k--) if (t < this.upperNotes[k].end) held = Math.max(held, this.upperNotes[k].strength);
      s.upperHeld = held;
    } else s.upper = s.upperHeld = 0;
    const bi0 = lowerIndex(this.backingStarts, t);
    if (bi0 >= 0) {
      s.backing = Math.exp(-(t - this.backingNotes[bi0].start) / 0.3) * (0.4 + 0.6 * this.backingNotes[bi0].strength);
      let sum = 0;
      for (let k = bi0; k >= 0 && k > bi0 - 16; k--) if (t < this.backingNotes[k].end) sum += this.backingNotes[k].strength;
      s.backingHeld = 1 - Math.exp(-sum);
    } else s.backing = s.backingHeld = 0;

    // Beat grid.
    const bi = lowerIndex(a.beats, t);
    if (bi >= 0 && bi + 1 < a.beats.length) {
      s.beatIndex = bi;
      s.beatPhase = (t - a.beats[bi]) / (a.beats[bi + 1] - a.beats[bi]);
    } else {
      const period = 60 / a.bpm;
      const ref = bi >= 0 ? a.beats[bi] : 0;
      s.beatIndex = Math.max(0, bi) + Math.floor((t - ref) / period);
      s.beatPhase = (((t - ref) / period) % 1 + 1) % 1;
    }
    const di = lowerIndex(a.downbeats, t);
    if (di >= 0 && di + 1 < a.downbeats.length) {
      s.barIndex = di;
      s.barPhase = (t - a.downbeats[di]) / (a.downbeats[di + 1] - a.downbeats[di]);
    } else {
      const bar = (60 / a.bpm) * a.beatsPerBar;
      const ref = di >= 0 ? a.downbeats[di] : 0;
      s.barIndex = Math.max(0, di) + Math.floor((t - ref) / bar);
      s.barPhase = (((t - ref) / bar) % 1 + 1) % 1;
    }
    const beatSec = 60 / a.bpm;
    s.beatPulse = Math.exp(-s.beatPhase * beatSec / 0.12);
    s.barPulse = Math.exp(-s.barPhase * beatSec * a.beatsPerBar / 0.25);

    // Harmony.
    let ci = s.chordIndex;
    if (ci < 0 || ci >= a.chords.length || t < a.chords[ci].start || t >= a.chords[ci].end) {
      ci = binarySearchSpan(a.chords, t);
    }
    s.chordIndex = ci;
    s.chord = ci >= 0 ? a.chords[ci] : null;
    s.chordPulse = s.chord ? Math.exp(-(t - s.chord.start) / 0.35) : 0;
    const targetTension = s.chord ? s.chord.tension : 0.2;
    const targetMajor = s.chord ? (s.chord.quality === 'maj' ? 1 : s.chord.quality === 'none' ? 0.5 : 0) : 0.5;
    const hr = jumped ? 1 : 1 - Math.exp(-dt / 0.3);
    s.tension += (targetTension - s.tension) * hr;
    s.majorness += (targetMajor - s.majorness) * hr;

    // Structure.
    let si = s.sectionIndex;
    if (si < 0 || si >= a.sections.length || t < a.sections[si].start || t >= a.sections[si].end) {
      si = binarySearchSpan(a.sections, t);
    }
    s.sectionIndex = si;
    s.section = si >= 0 ? a.sections[si] : null;
    if (s.section) {
      s.sectionProgress = (t - s.section.start) / Math.max(1e-3, s.section.end - s.section.start);
      s.toNextSection = si + 1 < a.sections.length ? a.sections[si + 1].start - t : Infinity;
    }
    const dIdx = lowerIndex(a.drops, t);
    s.dropPulse = dIdx >= 0 ? Math.exp(-(t - a.drops[dIdx]) / 1.2) : 0;
    s.toNextDrop = dIdx + 1 < a.drops.length ? a.drops[dIdx + 1] - t : Infinity;
    return s;
  }
}

function binarySearchSpan<T extends { start: number; end: number }>(items: T[], t: number): number {
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < items[mid].start) hi = mid - 1;
    else if (t >= items[mid].end) lo = mid + 1;
    else return mid;
  }
  return items.length && t >= items[items.length - 1].end ? items.length - 1 : -1;
}
