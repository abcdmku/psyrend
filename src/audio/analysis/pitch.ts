import type { Chord, NoteEvent, NoteRole } from '../types';
import { RealFFT, hannWindow } from './fft';
import { lowerIndex } from './util';

/**
 * Transcription-lite: harmonic-summation pitch salience on a 1/3-semitone grid, then a
 * Viterbi-tracked lead line and bass line, peak-tracked polyphonic notes, arpeggio labels
 * and motif detection over the lead's interval/rhythm patterns.
 */
export const PITCH_MIN = 28; // E1
export const PITCH_MAX = 96; // C7
export const PITCH_SEMIS = PITCH_MAX - PITCH_MIN + 1;
const BPS = 3; // bins per semitone
const FFT_N = 4096;
const HOP = 512;
const HARMONICS = 8;
const TOP_MIDI = 127;

export interface Salience {
  frameRate: number;
  frames: number;
  /** Semitone bins PITCH_MIN..PITCH_MAX. */
  semis: number;
  /** frames x semis, max over the 3 sub-bins; normalised so the 99th percentile is 1. */
  data: Float32Array;
  /** frames x semis fine offset in semitones (-0.33..0.33) of the strongest sub-bin. */
  offset: Float32Array;
  /** Per-frame salience reference (loudness-independent voicing). */
  frameMax: Float32Array;
}

const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

export function pitchSalience(samples: Float32Array, sr: number): Salience {
  const frames = Math.max(1, Math.ceil(samples.length / HOP));
  const fft = new RealFFT(FFT_N);
  const win = hannWindow(FFT_N);
  const bins = FFT_N / 2 + 1;
  const binHz = sr / FFT_N;
  const buf = new Float32Array(FFT_N);
  const mag = new Float32Array(bins);
  const fineLo = PITCH_MIN * BPS;
  const fineHi = TOP_MIDI * BPS;
  const fineN = fineHi - fineLo + 1;
  // Precompute the FFT bin position of each fine pitch bin.
  const fineBin = new Float32Array(fineN);
  for (let j = 0; j < fineN; j++) fineBin[j] = midiToHz((fineLo + j) / BPS) / binHz;
  const lf = new Float32Array(fineN);
  const white = new Float32Array(fineN);
  const harmOffsets = Array.from({ length: HARMONICS }, (_, h) => Math.round(12 * Math.log2(h + 1) * BPS));
  const harmW = Array.from({ length: HARMONICS }, (_, h) => 0.84 ** h);
  const semis = PITCH_MAX - PITCH_MIN + 1;
  const data = new Float32Array(frames * semis);
  const offset = new Float32Array(frames * semis);
  const frameMax = new Float32Array(frames);
  const nyqBin = bins - 2;

  for (let f = 0; f < frames; f++) {
    const start = f * HOP - FFT_N / 2;
    for (let i = 0; i < FFT_N; i++) {
      const idx = start + i;
      buf[i] = (idx >= 0 && idx < samples.length ? samples[idx] : 0) * win[i];
    }
    fft.magnitudes(buf, mag);
    // Log-frequency spectrum with amplitude compression.
    for (let j = 0; j < fineN; j++) {
      const x = fineBin[j];
      if (x >= nyqBin) {
        lf[j] = 0;
        continue;
      }
      const k = Math.floor(x);
      const t = x - k;
      lf[j] = Math.sqrt(mag[k] * (1 - t) + mag[k + 1] * t);
    }
    // Spectral whitening: divide by a one-octave moving average so timbre doesn't dominate.
    const R = 6 * BPS;
    let acc = 0;
    let cnt = 0;
    for (let j = 0; j < Math.min(fineN, R); j++) {
      acc += lf[j];
      cnt++;
    }
    for (let j = 0; j < fineN; j++) {
      const add = j + R;
      if (add < fineN) {
        acc += lf[add];
        cnt++;
      }
      const rem = j - R - 1;
      if (rem >= 0) {
        acc -= lf[rem];
        cnt--;
      }
      white[j] = Math.max(0, lf[j] - (acc / cnt) * 0.9);
    }
    // Harmonic summation, gated by the fundamental's own presence to reduce sub-octave errors.
    const so = f * semis;
    let fmax = 0;
    for (let s = 0; s < semis; s++) {
      let best = 0;
      let bestOff = 0;
      for (let sub = -1; sub <= 1; sub++) {
        const j = (PITCH_MIN + s) * BPS - fineLo + sub;
        if (j < 0) continue;
        let v = 0;
        for (let h = 0; h < HARMONICS; h++) {
          const jj = j + harmOffsets[h];
          if (jj >= fineN) break;
          v += harmW[h] * white[jj];
        }
        v *= 0.35 + 0.65 * Math.min(1, white[j] * 4 / (lf[j] + 1e-6));
        if (v > best) {
          best = v;
          bestOff = sub / BPS;
        }
      }
      data[so + s] = best;
      offset[so + s] = bestOff;
      if (best > fmax) fmax = best;
    }
    frameMax[f] = fmax;
  }
  // Global normalisation.
  const sorted = Float32Array.from(frameMax).sort();
  const ref = sorted[Math.floor(sorted.length * 0.99)] || 1;
  for (let i = 0; i < data.length; i++) data[i] /= ref;
  for (let f = 0; f < frames; f++) frameMax[f] /= ref;
  return { frameRate: sr / HOP, frames, semis, data, offset, frameMax };
}

/** Viterbi pitch track over a register; returns per-frame semitone index (-1 = unvoiced). */
function trackLine(sal: Salience, lo: number, hi: number, jumpCost: number, voiceThresh: number): Int16Array {
  const { frames, semis, data } = sal;
  const s0 = lo - PITCH_MIN;
  const s1 = hi - PITCH_MIN;
  const S = s1 - s0 + 1;
  const U = S; // unvoiced state index
  const score = new Float32Array(S + 1);
  const next = new Float32Array(S + 1);
  const back = new Int16Array(frames * (S + 1));
  const emit = (f: number, k: number) => {
    if (k === U) return voiceThresh;
    return data[f * semis + s0 + k];
  };
  for (let k = 0; k <= S; k++) score[k] = emit(0, k);
  for (let f = 1; f < frames; f++) {
    // Best voiced predecessor for each target via a two-pass distance transform (|Δ| cost).
    const fwd = new Float32Array(S);
    const fwdArg = new Int16Array(S);
    for (let k = 0; k < S; k++) {
      const stay = score[k];
      const prev = k > 0 ? fwd[k - 1] - jumpCost : -Infinity;
      if (stay >= prev) {
        fwd[k] = stay;
        fwdArg[k] = k;
      } else {
        fwd[k] = prev;
        fwdArg[k] = fwdArg[k - 1];
      }
    }
    for (let k = S - 2; k >= 0; k--) {
      const cand = fwd[k + 1] - jumpCost;
      if (cand > fwd[k]) {
        fwd[k] = cand;
        fwdArg[k] = fwdArg[k + 1];
      }
    }
    const unv = score[U];
    for (let k = 0; k < S; k++) {
      const fromU = unv - 0.25;
      const e = emit(f, k);
      if (fwd[k] >= fromU) {
        next[k] = fwd[k] + e;
        back[f * (S + 1) + k] = fwdArg[k];
      } else {
        next[k] = fromU + e;
        back[f * (S + 1) + k] = U;
      }
    }
    let bestV = 0;
    for (let k = 1; k < S; k++) if (score[k] > score[bestV]) bestV = k;
    const toU = score[bestV] - 0.25;
    if (score[U] >= toU) {
      next[U] = score[U] + voiceThresh;
      back[f * (S + 1) + U] = U;
    } else {
      next[U] = toU + voiceThresh;
      back[f * (S + 1) + U] = bestV;
    }
    // Renormalise to avoid float growth.
    let m = -Infinity;
    for (let k = 0; k <= S; k++) m = Math.max(m, next[k]);
    for (let k = 0; k <= S; k++) score[k] = next[k] - m;
  }
  let k = 0;
  for (let i = 1; i <= S; i++) if (score[i] > score[k]) k = i;
  const path = new Int16Array(frames);
  for (let f = frames - 1; f >= 0; f--) {
    path[f] = k === U ? -1 : s0 + k;
    k = back[f * (S + 1) + k];
  }
  return path;
}

function segmentLine(sal: Salience, path: Int16Array, role: NoteRole, minFrames: number): NoteEvent[] {
  const notes: NoteEvent[] = [];
  const fr = sal.frameRate;
  let f = 0;
  while (f < path.length) {
    const s = path[f];
    if (s < 0) {
      f++;
      continue;
    }
    let g = f;
    let sum = 0;
    let off = 0;
    while (g < path.length && (path[g] === s || (path[g] === -1 && g + 1 < path.length && path[g + 1] === s && g - f > 0))) {
      if (path[g] === s) {
        sum += sal.data[g * sal.semis + s];
        off += sal.offset[g * sal.semis + s];
      }
      g++;
    }
    const len = g - f;
    if (len >= minFrames) {
      notes.push({
        start: f / fr,
        end: g / fr,
        pitch: PITCH_MIN + s + off / len,
        strength: Math.min(1, sum / len),
        role,
        arp: false,
        motif: -1,
        motifPos: 0,
      });
    }
    f = g;
  }
  return notes;
}

/** Peak-picked polyphonic notes (chord voicings, pads, counter-melodies). */
function polyNotes(sal: Salience, lo: number, hi: number, maxVoices: number): NoteEvent[] {
  const { frames, semis, data, frameRate } = sal;
  const s0 = lo - PITCH_MIN;
  const s1 = hi - PITCH_MIN;
  const active = new Map<number, { start: number; sum: number; n: number; last: number }>();
  const notes: NoteEvent[] = [];
  const close = (s: number, f: number) => {
    const a = active.get(s)!;
    active.delete(s);
    if (a.n >= 4) notes.push({ start: a.start / frameRate, end: f / frameRate, pitch: PITCH_MIN + s, strength: Math.min(1, a.sum / a.n), role: 'poly', arp: false, motif: -1, motifPos: 0 });
  };
  for (let f = 0; f < frames; f++) {
    const o = f * semis;
    const fmax = sal.frameMax[f];
    const peaks: number[] = [];
    for (let s = Math.max(1, s0); s <= Math.min(semis - 2, s1); s++) {
      const v = data[o + s];
      if (v < 0.22 || v < fmax * 0.35 || v < data[o + s - 1] || v < data[o + s + 1]) continue;
      // Drop likely harmonics (octave, octave+fifth, two octaves) of a stronger peak.
      const harm = [12, 19, 24].some((d) => s - d >= 0 && data[o + s - d] > v * 1.15);
      if (!harm) peaks.push(s);
    }
    peaks.sort((a, b) => data[o + b] - data[o + a]);
    const keep = new Set(peaks.slice(0, maxVoices));
    for (const s of keep) {
      const a = active.get(s);
      if (a) {
        a.sum += data[o + s];
        a.n++;
        a.last = f;
      } else active.set(s, { start: f, sum: data[o + s], n: 1, last: f });
    }
    for (const [s, a] of [...active]) if (!keep.has(s) && f - a.last > 1) close(s, a.last + 1);
  }
  for (const [s, a] of [...active]) close(s, a.last + 1);
  return notes.sort((a, b) => a.start - b.start);
}

/** Flags fast runs of chord tones (arpeggios) and records their direction in motifPos sign. */
function labelArpeggios(notes: NoteEvent[], chords: Chord[], beat: number): void {
  const short = notes.filter((n) => n.end - n.start < beat * 0.6).sort((a, b) => a.start - b.start);
  const chordAt = (t: number) => {
    const i = lowerIndex(
      chords.map((c) => c.start),
      t,
    );
    return i >= 0 ? chords[i] : null;
  };
  const tones = (c: Chord | null) => {
    if (!c || c.root < 0) return null;
    const third = c.quality === 'maj' ? 4 : 3;
    const fifth = c.quality === 'dim' ? 6 : 7;
    return new Set([c.root, (c.root + third) % 12, (c.root + fifth) % 12]);
  };
  for (let i = 0; i < short.length; i++) {
    const run = [short[i]];
    for (let j = i + 1; j < short.length && short[j].start - run[run.length - 1].start < beat * 0.75; j++) {
      if (short[j].start - run[run.length - 1].end < beat * 0.3) run.push(short[j]);
    }
    if (run.length < 3) continue;
    const ts = tones(chordAt(run[0].start));
    const pcs = new Set(run.map((n) => ((Math.round(n.pitch) % 12) + 12) % 12));
    const inChord = ts ? run.filter((n) => ts.has(((Math.round(n.pitch) % 12) + 12) % 12)).length / run.length : 0.5;
    if (pcs.size >= 2 && inChord >= 0.6) for (const n of run) n.arp = true;
  }
}

/** Repeated interval+rhythm 4-grams in the lead become motifs (transposition invariant). */
function findMotifs(lead: NoteEvent[], beat: number): number {
  const ns = lead.filter((n) => n.end - n.start > 0.06);
  if (ns.length < 8) return 0;
  const tok = (i: number) => {
    const iv = Math.max(-12, Math.min(12, Math.round(ns[i + 1].pitch - ns[i].pitch)));
    const d = Math.round(Math.log2(Math.max(0.05, (ns[i + 1].start - ns[i].start) / beat)) * 2);
    return `${iv}:${d}`;
  };
  const N = 4;
  const groups = new Map<string, number[]>();
  for (let i = 0; i + N < ns.length; i++) {
    let key = '';
    for (let k = 0; k < N; k++) key += tok(i + k) + '|';
    const g = groups.get(key) ?? [];
    if (!g.length || i - g[g.length - 1] >= N) g.push(i);
    groups.set(key, g);
  }
  const ranked = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length);
  let id = 0;
  for (const g of ranked) {
    if (id >= 16) break;
    const free = g.filter((i) => ns.slice(i, i + N + 1).every((n) => n.motif < 0));
    if (free.length < 2) continue;
    for (const i of free) for (let k = 0; k <= N; k++) {
      ns[i + k].motif = id;
      ns[i + k].motifPos = k;
    }
    id++;
  }
  return id;
}

/** Joins same-pitch notes separated by tiny gaps (tracking dropouts), so held notes stay whole. */
function mergeNotes(notes: NoteEvent[], maxGap: number): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const n of notes) {
    const p = out[out.length - 1];
    if (p && Math.abs(p.pitch - n.pitch) < 0.6 && n.start - p.end <= maxGap) {
      const lp = p.end - p.start;
      const ln = n.end - n.start;
      p.pitch = (p.pitch * lp + n.pitch * ln) / (lp + ln);
      p.strength = (p.strength * lp + n.strength * ln) / (lp + ln);
      p.end = n.end;
    } else out.push({ ...n });
  }
  return out;
}

export interface Transcription {
  notes: NoteEvent[];
  motifCount: number;
  /** Per salience-frame lead and bass pitch (0 = none) for contour curves. */
  contourRate: number;
  /** frames x PITCH_SEMIS salience (0..~1), same rate as the contours. */
  pitchgram: Float32Array;
  leadContour: Float32Array;
  bassContour: Float32Array;
}

export function transcribe(samples: Float32Array, sr: number, chords: Chord[], bpm: number): Transcription {
  const sal = pitchSalience(samples, sr);
  // Voicing threshold relative to the track: the 45th percentile of frame maxima.
  const sorted = Float32Array.from(sal.frameMax).sort();
  const vt = Math.max(0.12, sorted[Math.floor(sorted.length * 0.45)] * 0.55);
  const leadPath = trackLine(sal, 52, PITCH_MAX, 0.035, vt);
  const bassPath = trackLine(sal, PITCH_MIN, 55, 0.05, vt * 0.9);
  const lead = mergeNotes(segmentLine(sal, leadPath, 'lead', 3), 0.07);
  const bass = mergeNotes(segmentLine(sal, bassPath, 'bass', 4), 0.1);
  const poly = polyNotes(sal, 40, 88, 6).filter((p) => !lead.some((l) => Math.abs(l.pitch - p.pitch) < 0.6 && l.start < p.end && l.end > p.start));
  const beat = 60 / bpm;
  labelArpeggios([...lead, ...poly], chords, beat);
  const motifCount = findMotifs(lead, beat);
  const contour = (path: Int16Array) => {
    const c = new Float32Array(path.length);
    for (let f = 0; f < path.length; f++) c[f] = path[f] >= 0 ? PITCH_MIN + path[f] + sal.offset[f * sal.semis + path[f]] : 0;
    return c;
  };
  const notes = [...lead, ...bass, ...poly].sort((a, b) => a.start - b.start);
  return { notes, motifCount, contourRate: sal.frameRate, leadContour: contour(leadPath), bassContour: contour(bassPath), pitchgram: sal.data };
}
