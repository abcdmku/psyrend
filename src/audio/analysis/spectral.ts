import { BAND_COUNT } from '../types';
import { RealFFT, hannWindow } from './fft';

export const FFT_SIZE = 2048;
export const HOP = 256;
export const MEL_COUNT = 40;
export const MFCC_COUNT = 13;

const BAND_MIN_HZ = 30;
const BAND_MAX_HZ = 11000;

export interface SpectralFrames {
  frameCount: number;
  frameRate: number;
  /** frames x BAND_COUNT linear magnitudes. */
  bandsLin: Float32Array;
  /** frames x MFCC_COUNT */
  mfcc: Float32Array;
  /** frames x 12 raw chroma energy */
  chroma: Float32Array;
  rmsDb: Float32Array;
  subDb: Float32Array;
  bassDb: Float32Array;
  lowMidDb: Float32Array;
  midDb: Float32Array;
  highDb: Float32Array;
  centroidHz: Float32Array;
  flatness: Float32Array;
  fluxAll: Float32Array;
  fluxLow: Float32Array;
  fluxMid: Float32Array;
  fluxHigh: Float32Array;
  /** Share of linear power below 200 Hz. */
  lowShare: Float32Array;
}

interface BandSpec {
  lo: number;
  hi: number;
  centerBin: number;
}

function hzToMel(f: number): number {
  return 2595 * Math.log10(1 + f / 700);
}
function melToHz(m: number): number {
  return 700 * (10 ** (m / 2595) - 1);
}

function makeLogBands(sr: number, n: number): BandSpec[] {
  const binHz = sr / FFT_SIZE;
  const maxHz = Math.min(BAND_MAX_HZ, sr * 0.48);
  const bands: BandSpec[] = [];
  for (let b = 0; b < n; b++) {
    const f0 = BAND_MIN_HZ * (maxHz / BAND_MIN_HZ) ** (b / n);
    const f1 = BAND_MIN_HZ * (maxHz / BAND_MIN_HZ) ** ((b + 1) / n);
    const lo = Math.ceil(f0 / binHz);
    const hi = Math.floor(f1 / binHz);
    bands.push({ lo, hi, centerBin: Math.sqrt(f0 * f1) / binHz });
  }
  return bands;
}

/** Triangular mel filterbank stored sparsely as [startBin, weights[]]. */
function makeMel(sr: number): { start: number; w: Float32Array; centerHz: number }[] {
  const binHz = sr / FFT_SIZE;
  const m0 = hzToMel(BAND_MIN_HZ);
  const m1 = hzToMel(Math.min(BAND_MAX_HZ, sr * 0.48));
  const pts: number[] = [];
  for (let i = 0; i < MEL_COUNT + 2; i++) pts.push(melToHz(m0 + ((m1 - m0) * i) / (MEL_COUNT + 1)));
  const filters = [];
  for (let m = 0; m < MEL_COUNT; m++) {
    const fl = pts[m];
    const fc = pts[m + 1];
    const fh = pts[m + 2];
    const start = Math.max(1, Math.floor(fl / binHz));
    const end = Math.max(start + 1, Math.ceil(fh / binHz));
    const w = new Float32Array(end - start + 1);
    let sum = 0;
    for (let k = start; k <= end; k++) {
      const f = k * binHz;
      const v = f < fc ? (f - fl) / (fc - fl) : (fh - f) / (fh - fc);
      w[k - start] = Math.max(0, v);
      sum += w[k - start];
    }
    if (sum === 0) {
      w[Math.min(w.length - 1, Math.round(fc / binHz) - start)] = 1;
      sum = 1;
    }
    for (let i = 0; i < w.length; i++) w[i] /= sum;
    filters.push({ start, w, centerHz: fc });
  }
  return filters;
}

function makeDct(): Float32Array {
  const d = new Float32Array(MFCC_COUNT * MEL_COUNT);
  for (let c = 0; c < MFCC_COUNT; c++)
    for (let m = 0; m < MEL_COUNT; m++) d[c * MEL_COUNT + m] = Math.cos((Math.PI * c * (m + 0.5)) / MEL_COUNT);
  return d;
}

const toDb = (power: number) => 10 * Math.log10(power + 1e-10);

export function extractSpectral(samples: Float32Array, sr: number, onProgress?: (p: number) => void): SpectralFrames {
  const frameCount = Math.max(1, Math.ceil(samples.length / HOP));
  const frameRate = sr / HOP;
  const fft = new RealFFT(FFT_SIZE);
  const win = hannWindow(FFT_SIZE);
  const bins = FFT_SIZE / 2 + 1;
  const binHz = sr / FFT_SIZE;
  const mag = new Float32Array(bins);
  const frame = new Float32Array(FFT_SIZE);
  const bands = makeLogBands(sr, BAND_COUNT);
  const mel = makeMel(sr);
  const dct = makeDct();
  // Full-scale sine through a Hann window peaks at N/4.
  const magNorm = 4 / FFT_SIZE;

  const out: SpectralFrames = {
    frameCount,
    frameRate,
    bandsLin: new Float32Array(frameCount * BAND_COUNT),
    mfcc: new Float32Array(frameCount * MFCC_COUNT),
    chroma: new Float32Array(frameCount * 12),
    rmsDb: new Float32Array(frameCount),
    subDb: new Float32Array(frameCount),
    bassDb: new Float32Array(frameCount),
    lowMidDb: new Float32Array(frameCount),
    midDb: new Float32Array(frameCount),
    highDb: new Float32Array(frameCount),
    centroidHz: new Float32Array(frameCount),
    flatness: new Float32Array(frameCount),
    fluxAll: new Float32Array(frameCount),
    fluxLow: new Float32Array(frameCount),
    fluxMid: new Float32Array(frameCount),
    fluxHigh: new Float32Array(frameCount),
    lowShare: new Float32Array(frameCount),
  };

  const melPrev = new Float32Array(MEL_COUNT);
  const melCur = new Float32Array(MEL_COUNT);
  const melLog = new Float32Array(MEL_COUNT);
  const melClass = mel.map((f) => (f.centerHz < 150 ? 0 : f.centerHz < 4000 ? 1 : f.centerHz > 5000 ? 2 : -1));
  const binLimits = {
    sub: Math.round(60 / binHz),
    bass: Math.round(200 / binHz),
    lowMid: Math.round(800 / binHz),
    mid: Math.round(3000 / binHz),
    flatLo: Math.round(100 / binHz),
    flatHi: Math.min(bins - 1, Math.round(8000 / binHz)),
    chromaLo: Math.round(70 / binHz),
    chromaHi: Math.min(bins - 2, Math.round(4500 / binHz)),
  };

  for (let f = 0; f < frameCount; f++) {
    const center = f * HOP;
    const start = center - FFT_SIZE / 2;
    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      const s = idx >= 0 && idx < samples.length ? samples[idx] : 0;
      sumSq += s * s;
      frame[i] = s * win[i];
    }
    out.rmsDb[f] = toDb(sumSq / FFT_SIZE);
    fft.magnitudes(frame, mag);
    for (let k = 0; k < bins; k++) mag[k] *= magNorm;

    // Group energies, centroid, flatness.
    let pSub = 0, pBass = 0, pLowMid = 0, pMid = 0, pHigh = 0, pTotal = 0;
    let cNum = 0, cDen = 0;
    let logSum = 0, linSum = 0;
    for (let k = 1; k < bins; k++) {
      const m = mag[k];
      const p = m * m;
      pTotal += p;
      if (k < binLimits.sub) pSub += p;
      else if (k < binLimits.bass) pBass += p;
      else if (k < binLimits.lowMid) pLowMid += p;
      else if (k < binLimits.mid) pMid += p;
      else pHigh += p;
      cNum += k * binHz * m;
      cDen += m;
      if (k >= binLimits.flatLo && k <= binLimits.flatHi) {
        logSum += Math.log(p + 1e-12);
        linSum += p;
      }
    }
    const flatN = binLimits.flatHi - binLimits.flatLo + 1;
    out.subDb[f] = toDb(pSub);
    out.bassDb[f] = toDb(pBass);
    out.lowMidDb[f] = toDb(pLowMid);
    out.midDb[f] = toDb(pMid);
    out.highDb[f] = toDb(pHigh);
    out.lowShare[f] = (pSub + pBass) / (pTotal + 1e-12);
    out.centroidHz[f] = cDen > 1e-9 ? cNum / cDen : 0;
    out.flatness[f] = linSum > 1e-12 ? Math.exp(logSum / flatN) / (linSum / flatN) : 0;

    // Log bands for display.
    const bo = f * BAND_COUNT;
    for (let b = 0; b < BAND_COUNT; b++) {
      const band = bands[b];
      let v: number;
      if (band.hi >= band.lo) {
        let s = 0;
        for (let k = band.lo; k <= band.hi; k++) s += mag[k] * mag[k];
        v = Math.sqrt(s / (band.hi - band.lo + 1));
      } else {
        const x = band.centerBin;
        const k0 = Math.floor(x);
        const t = x - k0;
        v = mag[k0] * (1 - t) + mag[Math.min(bins - 1, k0 + 1)] * t;
      }
      out.bandsLin[bo + b] = v;
    }

    // Mel, MFCC and spectral flux.
    let fa = 0, fl = 0, fm = 0, fh = 0;
    for (let m = 0; m < MEL_COUNT; m++) {
      const filt = mel[m];
      let s = 0;
      for (let i = 0; i < filt.w.length; i++) {
        const k = filt.start + i;
        if (k < bins) s += mag[k] * filt.w[i];
      }
      const lm = Math.log1p(100 * s);
      melCur[m] = lm;
      melLog[m] = Math.log(s + 1e-6);
      const d = f > 0 ? Math.max(0, lm - melPrev[m]) : 0;
      fa += d;
      const cls = melClass[m];
      if (cls === 0) fl += d;
      else if (cls === 1) fm += d;
      else if (cls === 2) fh += d;
    }
    out.fluxAll[f] = fa;
    out.fluxLow[f] = fl;
    out.fluxMid[f] = fm;
    out.fluxHigh[f] = fh;
    const mo = f * MFCC_COUNT;
    for (let c = 0; c < MFCC_COUNT; c++) {
      let s = 0;
      for (let m = 0; m < MEL_COUNT; m++) s += dct[c * MEL_COUNT + m] * melLog[m];
      out.mfcc[mo + c] = s;
    }
    melPrev.set(melCur);

    // Peak-based chroma: only spectral peaks contribute, at interpolated frequency.
    const co = f * 12;
    let maxMag = 0;
    for (let k = binLimits.chromaLo; k <= binLimits.chromaHi; k++) if (mag[k] > maxMag) maxMag = mag[k];
    const floor = maxMag * 0.02;
    for (let k = binLimits.chromaLo; k <= binLimits.chromaHi; k++) {
      const m = mag[k];
      if (m <= floor || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-9);
      const b = Math.log(m + 1e-9);
      const c = Math.log(mag[k + 1] + 1e-9);
      const denom = a - 2 * b + c;
      const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      const freq = (k + Math.max(-0.5, Math.min(0.5, delta))) * binHz;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const nearest = Math.round(midi);
      const cents = Math.abs(midi - nearest);
      const w = m * Math.exp(-(cents * cents) / (2 * 0.25 * 0.25));
      // Bass register gets less say: low bins are coarse and boomy.
      const regW = freq < 120 ? 0.5 : 1;
      out.chroma[co + (((nearest % 12) + 12) % 12)] += w * regW;
    }

    if (onProgress && (f & 511) === 0) onProgress(f / frameCount);
  }
  return out;
}
