import type { OnsetTrack } from '../types';
import { gaussianSmooth, mean, pickPeaks, std, type PeakOptions } from './util';

/** Normalized onset-strength envelope: mean-removed, unit variance, half-wave rectified. */
export function onsetEnvelope(flux: Float32Array, frameRate: number): Float32Array {
  const sm = gaussianSmooth(flux, frameRate * 0.006);
  // Remove slow trend so loud sections don't dominate.
  const trend = gaussianSmooth(sm, frameRate * 1.5);
  const out = new Float32Array(sm.length);
  for (let i = 0; i < sm.length; i++) out[i] = Math.max(0, sm[i] - trend[i]);
  const s = std(out) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= s;
  return out;
}

export function detectOnsets(env: Float32Array, frameRate: number, minGapSec: number, k = 1.0, delta = 0.35): OnsetTrack {
  const opts: PeakOptions = {
    radius: Math.max(1, Math.round(frameRate * 0.03)),
    medianRadius: Math.round(frameRate * 0.4),
    k,
    delta,
    minGap: Math.max(1, Math.round(frameRate * minGapSec)),
  };
  const { frames, strengths } = pickPeaks(env, opts);
  return {
    times: Float32Array.from(frames, (f) => f / frameRate),
    strengths: Float32Array.from(strengths),
  };
}

export interface TempoEstimate {
  bpm: number;
  periodFrames: number;
  /** 0..1 strength of the periodicity peak. */
  clarity: number;
}

/** Global tempo from the autocorrelation of the onset envelope with a log-normal tempo prior. */
export function estimateTempo(env: Float32Array, frameRate: number): TempoEstimate {
  const n = env.length;
  const m = mean(env);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i] - m;
  const minLag = Math.floor((60 * frameRate) / 220);
  const maxLag = Math.ceil((60 * frameRate) / 50) * 2 + 2;
  const ac = new Float32Array(maxLag + 1);
  let zero = 0;
  for (let i = 0; i < n; i++) zero += x[i] * x[i];
  for (let lag = 1; lag <= maxLag && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    ac[lag] = s / (zero || 1);
  }
  const acAt = (lag: number) => {
    if (lag < 1 || lag >= maxLag) return 0;
    const l0 = Math.floor(lag);
    const t = lag - l0;
    return ac[l0] * (1 - t) + ac[l0 + 1] * t;
  };
  let best = -Infinity;
  let bestLag = (60 * frameRate) / 120;
  const scores: number[] = [];
  for (let lag = minLag; lag <= Math.ceil((60 * frameRate) / 50); lag++) {
    const bpm = (60 * frameRate) / lag;
    // Harmonic-enhanced periodicity: reward lags whose multiples also correlate.
    const s = acAt(lag) + 0.5 * acAt(lag * 2) + 0.25 * acAt(lag * 4) + 0.25 * acAt(lag / 2);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.85) ** 2);
    const score = s * (0.35 + 0.65 * prior);
    scores.push(score);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  // Parabolic refinement.
  const i = bestLag - minLag;
  if (i > 0 && i < scores.length - 1) {
    const a = scores[i - 1];
    const b = scores[i];
    const c = scores[i + 1];
    const d = a - 2 * b + c;
    if (d < 0) bestLag += (0.5 * (a - c)) / d;
  }
  const sorted = [...scores].sort((p, q) => q - p);
  const median = sorted[sorted.length >> 1] || 0;
  const clarity = Math.max(0, Math.min(1, (best - median) / (Math.abs(best) + 0.05) * 1.2));
  return { bpm: (60 * frameRate) / bestLag, periodFrames: bestLag, clarity };
}

/** Ellis-style dynamic-programming beat tracker. Returns beat frame positions. */
export function trackBeats(env: Float32Array, period: number, tightness = 120): number[] {
  const n = env.length;
  if (n < period * 2) return [];
  // Emphasise onsets that are locally strong.
  const local = gaussianSmooth(env, period / 32);
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let bestV = -Infinity;
    let bestJ = -1;
    for (let d = lo; d <= hi; d++) {
      const j = t - d;
      if (j < 0) break;
      const pen = Math.log(d / period);
      const v = score[j] - tightness * pen * pen;
      if (v > bestV) {
        bestV = v;
        bestJ = j;
      }
    }
    if (bestJ >= 0 && bestV > 0) {
      score[t] = local[t] + bestV;
      back[t] = bestJ;
    } else {
      score[t] = local[t];
    }
  }
  // Start from the best-scoring frame in the final period.
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) {
    if (score[t] > bestEnd) {
      bestEnd = score[t];
      end = t;
    }
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  beats.reverse();
  // Extrapolate the grid backwards to the start if the DP chain began late.
  while (beats.length && beats[0] - period > 0) beats.unshift(Math.round(beats[0] - period));
  return beats;
}

/** Strength of the onset envelope near each time in `times`, within +-win seconds. */
export function salienceAt(times: ArrayLike<number>, env: Float32Array, frameRate: number, winSec = 0.05): Float32Array {
  const out = new Float32Array(times.length);
  const w = Math.max(1, Math.round(winSec * frameRate));
  for (let i = 0; i < times.length; i++) {
    const c = Math.round(times[i] * frameRate);
    let m = 0;
    for (let j = Math.max(0, c - w); j <= Math.min(env.length - 1, c + w); j++) m = Math.max(m, env[j]);
    out[i] = m;
  }
  return out;
}

/**
 * Picks meter (3 or 4) and bar phase. `accent[i]` is a per-beat downbeat
 * likelihood (low-end onset + harmonic change).
 */
export function findDownbeats(beatTimes: Float32Array, accent: Float32Array): { beatsPerBar: number; phase: number } {
  let best = { beatsPerBar: 4, phase: 0, score: -Infinity };
  for (const bpb of [4, 3]) {
    for (let phase = 0; phase < bpb; phase++) {
      let on = 0;
      let off = 0;
      let nOn = 0;
      let nOff = 0;
      for (let i = 0; i < accent.length; i++) {
        if ((i - phase) % bpb === 0) {
          on += accent[i];
          nOn++;
        } else {
          off += accent[i];
          nOff++;
        }
      }
      // Contrast between downbeats and other beats; 3/4 must clearly win to be chosen.
      const score = on / Math.max(1, nOn) - off / Math.max(1, nOff) - (bpb === 3 ? 0.15 : 0);
      if (score > best.score) best = { beatsPerBar: bpb, phase, score };
    }
  }
  if (beatTimes.length < 8) return { beatsPerBar: 4, phase: 0 };
  return { beatsPerBar: best.beatsPerBar, phase: best.phase };
}
