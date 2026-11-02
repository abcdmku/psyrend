import { BAND_COUNT, type Chord, type Section, type TrackAnalysis } from '../types';
import { detectKey, recognizeChords, resolveRelativeKey } from './harmony';
import { detectOnsets, estimateTempo, findDownbeats, onsetEnvelope, salienceAt, trackBeats } from './rhythm';
import { classifyGenre, labelSections, moodLabel, type SegmentStats } from './semantics';
import { extractSpectral, MFCC_COUNT } from './spectral';
import { PITCH_MIN, PITCH_SEMIS, transcribe } from './pitch';
import { segment } from './structure';
import { clamp01, gaussianSmooth, lowerIndex, mean, medianFilter, normalizeRobust, normalizeSoft, percentile, smoothstep, softClamp01 } from './util';

export type ProgressFn = (stage: string, progress: number) => void;

const LOG_100 = Math.log2(100);
const LOG_RANGE = Math.log2(8000) - LOG_100;

export function analyzeTrack(samples: Float32Array, sampleRate: number, progress: ProgressFn = () => {}): TrackAnalysis {
  const duration = samples.length / sampleRate;
  progress('Spectral decomposition', 0);
  const sp = extractSpectral(samples, sampleRate, (p) => progress('Spectral decomposition', p));
  const fr = sp.frameRate;
  const n = sp.frameCount;

  // ---------- Loudness & tonal balance ----------
  progress('Energy & timbre', 0);
  // Loudness-like curves use soft knees, so quiet passages register and rise smoothly from 0.
  const energy = normalizeSoft(sp.rmsDb, 0.02, 0.995);
  const energySlow = gaussianSmooth(energy, fr * 1.2);
  const sub = normalizeSoft(sp.subDb, 0.03, 0.995);
  const bass = normalizeSoft(sp.bassDb, 0.03, 0.995);
  const lowMid = normalizeSoft(sp.lowMidDb, 0.03, 0.995);
  const mid = normalizeSoft(sp.midDb, 0.03, 0.995);
  const high = normalizeSoft(sp.highDb, 0.03, 0.995);
  const centroidRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) centroidRaw[i] = clamp01((Math.log2(Math.max(100, sp.centroidHz[i])) - LOG_100) / LOG_RANGE);
  const centroid = gaussianSmooth(centroidRaw, fr * 0.05);
  const flatness = gaussianSmooth(normalizeRobust(sp.flatness, 0.05, 0.98), fr * 0.05);

  // Per-band display levels: blend of per-band and global normalisation in dB.
  const bands = new Float32Array(n * BAND_COUNT);
  const bandDb = new Float32Array(n * BAND_COUNT);
  for (let i = 0; i < bandDb.length; i++) bandDb[i] = 20 * Math.log10(sp.bandsLin[i] + 1e-7);
  const gTop = percentile(bandDb.filter((_, i) => i % 7 === 0), 0.995);
  const col = new Float32Array(n);
  for (let b = 0; b < BAND_COUNT; b++) {
    for (let i = 0; i < n; i++) col[i] = bandDb[i * BAND_COUNT + b];
    const lo = percentile(col, 0.05);
    const hi = percentile(col, 0.995);
    for (let i = 0; i < n; i++) {
      const v = col[i];
      const per = (v - lo) / Math.max(6, hi - lo);
      const glob = (v - (gTop - 55)) / 55;
      bands[i * BAND_COUNT + b] = softClamp01(0.6 * per + 0.4 * glob) ** 1.25;
    }
  }

  // Harmonic/percussive balance by median filtering band magnitudes.
  const percRaw = new Float32Array(n);
  {
    const H = new Float32Array(n * BAND_COUNT);
    for (let b = 0; b < BAND_COUNT; b++) {
      for (let i = 0; i < n; i++) col[i] = sp.bandsLin[i * BAND_COUNT + b];
      const h = medianFilter(col, Math.round(fr * 0.1));
      for (let i = 0; i < n; i++) H[i * BAND_COUNT + b] = h[i];
    }
    const row = new Float32Array(BAND_COUNT);
    for (let i = 0; i < n; i++) {
      for (let b = 0; b < BAND_COUNT; b++) row[b] = sp.bandsLin[i * BAND_COUNT + b];
      const p = medianFilter(row, 4);
      let ph = 0;
      let pp = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        const hv = H[i * BAND_COUNT + b];
        const pv = p[b];
        // Soft masks (Wiener-like) on the band magnitudes.
        const total = hv * hv + pv * pv + 1e-12;
        const m = row[b] * row[b];
        ph += (m * hv * hv) / total;
        pp += (m * pv * pv) / total;
      }
      percRaw[i] = pp / (ph + pp + 1e-12);
    }
  }
  const percussive = gaussianSmooth(percRaw, fr * 0.15);
  progress('Energy & timbre', 1);

  // ---------- Rhythm ----------
  progress('Rhythm & tempo', 0);
  const envAll = onsetEnvelope(sp.fluxAll, fr);
  const envLow = onsetEnvelope(sp.fluxLow, fr);
  const envMid = onsetEnvelope(sp.fluxMid, fr);
  const envHigh = onsetEnvelope(sp.fluxHigh, fr);
  const onsets = detectOnsets(envAll, fr, 0.05, 1.0, 0.45);
  const kicks = detectOnsets(envLow, fr, 0.12, 1.0, 0.8);
  // Snares: mid-band transients that are noisy (high flatness).
  const snareEnv = new Float32Array(n);
  for (let i = 0; i < n; i++) snareEnv[i] = envMid[i] * (0.4 + flatness[i]);
  const snares = detectOnsets(snareEnv, fr, 0.12, 1.0, 0.7);
  const hats = detectOnsets(envHigh, fr, 0.05, 1.0, 0.5);

  const beatEnv = new Float32Array(n);
  for (let i = 0; i < n; i++) beatEnv[i] = envAll[i] + 0.6 * envLow[i];
  const tempo = estimateTempo(beatEnv, fr);
  progress('Rhythm & tempo', 0.5);
  const beatFrames = trackBeats(beatEnv, tempo.periodFrames);
  const beats = Float32Array.from(beatFrames, (f) => f / fr);
  const nb = beats.length;
  const bpm = nb > 4 ? (60 * (nb - 1)) / (beats[nb - 1] - beats[0]) : tempo.bpm;
  progress('Rhythm & tempo', 1);

  // ---------- Harmony ----------
  progress('Harmony & key', 0);
  const beatFrameIdx = (b: number) => Math.min(n, Math.max(0, Math.round(beats[b] * fr)));
  const beatChroma = new Float32Array(nb * 12);
  const beatMfcc = new Float32Array(nb * MFCC_COUNT);
  const beatEnergy = new Float32Array(nb);
  const keyChroma = new Float64Array(12);
  for (let b = 0; b < nb; b++) {
    const f0 = beatFrameIdx(b);
    const f1 = b + 1 < nb ? Math.max(f0 + 1, beatFrameIdx(b + 1)) : Math.min(n, f0 + Math.round(tempo.periodFrames));
    let maxC = 1e-9;
    for (let f = f0; f < f1; f++) {
      for (let c = 0; c < 12; c++) beatChroma[b * 12 + c] += sp.chroma[f * 12 + c];
      for (let c = 0; c < MFCC_COUNT; c++) beatMfcc[b * MFCC_COUNT + c] += sp.mfcc[f * MFCC_COUNT + c] / (f1 - f0);
      beatEnergy[b] += energy[f] / (f1 - f0);
    }
    for (let c = 0; c < 12; c++) maxC = Math.max(maxC, beatChroma[b * 12 + c]);
    for (let c = 0; c < 12; c++) {
      beatChroma[b * 12 + c] /= maxC;
      keyChroma[c] += beatChroma[b * 12 + c] * (0.2 + beatEnergy[b]);
    }
  }
  const key = resolveRelativeKey(detectKey(keyChroma), beatChroma, beats, duration);
  const chords = recognizeChords(beatChroma, beats, duration, key);
  progress('Harmony & key', 1);

  // ---------- Meter ----------
  const kickSal = salienceAt(beats, envLow, fr);
  const chordChange = new Float32Array(nb);
  for (const c of chords) {
    const b = lowerIndex(beats, c.start + 1e-3);
    if (b >= 0) chordChange[b] = 1;
  }
  const accent = new Float32Array(nb);
  for (let b = 0; b < nb; b++) accent[b] = Math.min(3, kickSal[b]) * 0.5 + chordChange[b] * 0.8 + (b > 0 ? Math.max(0, beatEnergy[b] - beatEnergy[b - 1]) * 2 : 0);
  const meter = findDownbeats(beats, accent);
  const downbeats = beats.filter((_, i) => i >= meter.phase && (i - meter.phase) % meter.beatsPerBar === 0);

  // ---------- Structure ----------
  progress('Song structure', 0);
  const dim = 12 + 12 + 1;
  const feats = new Float32Array(nb * dim);
  const mfccMean = new Float32Array(MFCC_COUNT);
  const mfccStd = new Float32Array(MFCC_COUNT);
  for (let c = 1; c < MFCC_COUNT; c++) {
    let s = 0;
    for (let b = 0; b < nb; b++) s += beatMfcc[b * MFCC_COUNT + c];
    mfccMean[c] = s / Math.max(1, nb);
    let v = 0;
    for (let b = 0; b < nb; b++) v += (beatMfcc[b * MFCC_COUNT + c] - mfccMean[c]) ** 2;
    mfccStd[c] = Math.sqrt(v / Math.max(1, nb)) || 1;
  }
  for (let b = 0; b < nb; b++) {
    // Two-beat smoothing stabilises the self-similarity matrix.
    const b2 = Math.min(nb - 1, b + 1);
    for (let c = 0; c < 12; c++) feats[b * dim + c] = (beatChroma[b * 12 + c] + beatChroma[b2 * 12 + c]) * 0.5;
    for (let c = 1; c < MFCC_COUNT; c++)
      feats[b * dim + 11 + c] = (((beatMfcc[b * MFCC_COUNT + c] + beatMfcc[b2 * MFCC_COUNT + c]) * 0.5 - mfccMean[c]) / mfccStd[c]) * 0.45;
    feats[b * dim + 24] = beatEnergy[b] * 2.5;
  }
  const seg = segment(feats, dim, nb, meter.beatsPerBar, meter.phase, 60 / bpm);
  const segStats: SegmentStats[] = seg.starts.map((sb, k) => {
    const start = k === 0 ? 0 : beats[sb];
    const end = k + 1 < seg.starts.length ? beats[seg.starts[k + 1]] : duration;
    const f0 = Math.floor(start * fr);
    const f1 = Math.max(f0 + 1, Math.min(n, Math.floor(end * fr)));
    const e = mean(energy, f0, f1);
    // Least-squares slope of the slow energy (per second).
    let sx = 0, sy = 0, sxx = 0, sxy = 0, sc = 0, sxc = 0, cnt = 0;
    for (let f = f0; f < f1; f += 4) {
      const x = f / fr;
      const y = energySlow[f];
      sx += x; sy += y; sxx += x * x; sxy += x * y; cnt++;
      sc += centroid[f]; sxc += x * centroid[f];
    }
    const den = Math.max(1e-9, cnt * sxx - sx * sx);
    const slope = cnt > 2 ? (cnt * sxy - sx * sy) / den : 0;
    const brightSlope = cnt > 2 ? (cnt * sxc - sx * sc) / den : 0;
    return { start, end, energy: e, slope, brightSlope, cluster: seg.clusters[k] };
  });
  const kinds = labelSections(segStats);
  progress('Song structure', 1);

  // ---------- Look-ahead: anticipation of energy arrivals ----------
  progress('Emotion & anticipation', 0);
  const anticipation = new Float32Array(n);
  const drops: number[] = [];
  const barDur = (60 / bpm) * meter.beatsPerBar;
  for (let k = 1; k < segStats.length; k++) {
    const jump = segStats[k].energy - segStats[k - 1].energy;
    const isArrival = kinds[k] !== 'build' && ((kinds[k] === 'peak' && jump > 0.1) || jump > 0.22);
    if (!isArrival) continue;
    const td = segStats[k].start;
    drops.push(td);
    const prevLen = segStats[k - 1].end - segStats[k - 1].start;
    const buildLen = kinds[k - 1] === 'build' ? prevLen : Math.min(prevLen, Math.max(2 * barDur, Math.min(8 * barDur, 12)));
    const amp = clamp01(0.45 + jump * 1.5);
    const f0 = Math.max(0, Math.floor((td - buildLen) * fr));
    const f1 = Math.min(n, Math.ceil(td * fr));
    for (let f = f0; f < f1; f++) {
      const x = (f / fr - (td - buildLen)) / buildLen;
      anticipation[f] = Math.max(anticipation[f], amp * x * x);
    }
  }

  // ---------- Emotion ----------
  const majorness = new Float32Array(n);
  const tensionF = new Float32Array(n);
  for (const c of chords) {
    const v = c.quality === 'maj' ? 1 : c.quality === 'min' ? 0.15 : c.quality === 'dim' ? 0 : 0.5;
    for (let f = Math.floor(c.start * fr); f < Math.min(n, Math.ceil(c.end * fr)); f++) {
      majorness[f] = v;
      tensionF[f] = c.tension;
    }
  }
  const modeBias = key.mode === 'major' ? 0.62 : 0.38;
  const majSmooth = gaussianSmooth(majorness, fr * 4);
  const tensionSmooth = gaussianSmooth(tensionF, fr * 2);
  const density = new Float32Array(n);
  for (const t of onsets.times) {
    const f = Math.round(t * fr);
    if (f < n) density[f] += 1;
  }
  const densitySmooth = gaussianSmooth(density, fr * 1.5);
  const densityNorm = normalizeRobust(densitySmooth, 0.05, 0.98);
  const tempoFactor = clamp01((bpm - 60) / 120);
  const percN = normalizeRobust(percussive, 0.05, 0.98);
  const valenceRaw = new Float32Array(n);
  const arousalRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    arousalRaw[i] = 0.42 * energySlow[i] + 0.2 * densityNorm[i] + 0.13 * centroid[i] + 0.12 * percN[i] + 0.13 * tempoFactor;
    valenceRaw[i] =
      0.3 * (0.5 * majSmooth[i] + 0.5 * modeBias) + 0.2 * centroid[i] + 0.15 * tempoFactor + 0.2 * (1 - tensionSmooth[i]) + 0.15 * energySlow[i];
  }
  const arousal = gaussianSmooth(arousalRaw, fr * 2.5);
  const valence = gaussianSmooth(valenceRaw, fr * 3);
  // Spread to a usable 0..1 range around a fixed centre so whole-track character survives.
  for (let i = 0; i < n; i++) {
    arousal[i] = clamp01(0.5 + (arousal[i] - 0.45) * 1.8);
    valence[i] = clamp01(0.5 + (valence[i] - 0.48) * 2.0);
  }

  const sections: Section[] = segStats.map((s, k) => {
    const f0 = Math.floor(s.start * fr);
    const f1 = Math.max(f0 + 1, Math.min(n, Math.floor(s.end * fr)));
    return {
      start: s.start,
      end: s.end,
      kind: kinds[k],
      cluster: s.cluster,
      energy: s.energy,
      valence: mean(valence, f0, f1),
      arousal: mean(arousal, f0, f1),
    };
  });
  // ---------- Song intensity ----------
  // How hard the whole song hits, in absolute terms (every curve above is normalized per song, so a
  // quiet piano piece and a riddim both reach 1). Motion uses it so a gentle song moves gently.
  const songIntensity = (() => {
    const active: number[] = [];
    for (let i = 0; i < n; i++) if (energy[i] > 0.2) active.push(i);
    const activeSec = Math.max(1, active.length / fr);
    const loudDb = percentile(sp.rmsDb, 0.75);
    const onsetRate = onsets.times.length / activeSec;
    let perc = 0;
    for (const i of active) perc += percRaw[i];
    perc /= Math.max(1, active.length);
    const lin = (x: number, lo: number, hi: number) => clamp01((x - lo) / (hi - lo));
    const value = clamp01(0.35 * lin(loudDb, -30, -10) + 0.25 * lin(onsetRate, 1.5, 6) + 0.25 * lin(perc, 0.15, 0.5) + 0.15 * lin(bpm, 75, 165));
    return { value, loudDb, onsetRate, perc };
  })();
  const gv = mean(valence);
  const ga = mean(arousal);

  // ---------- Genre ----------
  const kickNearBeat = salienceAt(beats, envLow, fr, 0.04);
  let four = 0;
  for (let b = 0; b < nb; b++) if (kickNearBeat[b] > 1.2) four++;
  four /= Math.max(1, nb);
  let s2 = 0, s3 = 0;
  if (meter.beatsPerBar === 4) {
    const snSal = salienceAt(beats, snareEnv, fr, 0.04);
    for (let b = 0; b < nb; b++) {
      const pos = (((b - meter.phase) % 4) + 4) % 4;
      if (pos === 1 || pos === 3) s2 += snSal[b];
      else if (pos === 2) s3 += snSal[b];
    }
  }
  const active = sp.rmsDb.filter((v) => v > -60);
  const bars = Math.max(1, downbeats.length);
  const genres = classifyGenre({
    tempo: bpm,
    four,
    perc: mean(percussive),
    bass: mean(sp.lowShare),
    bright: weightedCentroidKHz(sp.centroidHz, energy),
    density: onsets.times.length / Math.max(1, duration),
    dyn: active.length ? percentile(active, 0.95) - percentile(active, 0.1) : 0,
    harm: chords.length / bars,
    halftime: s3 / (s2 * 0.5 + s3 + 1e-6),
    hatRate: hats.times.length / Math.max(1, nb),
  });
  progress('Emotion & anticipation', 1);

  progress('Transcribing melody, bass & chords', 0);
  const tx = transcribe(samples, sampleRate, chords, bpm);
  progress('Transcribing melody, bass & chords', 1);

  return {
    duration,
    frameRate: fr,
    frameCount: n,
    bands,
    chroma: normalizeChromaFrames(sp.chroma, n),
    energy,
    energySlow,
    sub,
    bass,
    lowMid,
    mid,
    high,
    centroid,
    flatness,
    percussive,
    flux: normalizeRobust(envAll, 0.5, 0.995),
    valence,
    arousal,
    anticipation,
    kicks,
    snares,
    hats,
    onsets,
    bpm,
    beatsPerBar: meter.beatsPerBar,
    beats,
    downbeats,
    pulseClarity: tempo.clarity,
    key,
    chords: chords satisfies Chord[],
    sections,
    drops: Float32Array.from(drops),
    notes: tx.notes,
    motifCount: tx.motifCount,
    contourRate: tx.contourRate,
    pitchgram: tx.pitchgram,
    pitchMin: PITCH_MIN,
    pitchSemis: PITCH_SEMIS,
    leadContour: tx.leadContour,
    bassContour: tx.bassContour,
    mood: { valence: gv, arousal: ga, label: moodLabel(gv, ga) },
    genres,
    intensity: songIntensity.value,
    character: { loudDb: songIntensity.loudDb, onsetRate: songIntensity.onsetRate, percussive: songIntensity.perc },
  };
}

function weightedCentroidKHz(c: Float32Array, w: Float32Array): number {
  let s = 0;
  let ws = 0;
  for (let i = 0; i < c.length; i++) {
    s += c[i] * w[i];
    ws += w[i];
  }
  return ws > 0 ? s / ws / 1000 : 0;
}

function normalizeChromaFrames(raw: Float32Array, n: number): Float32Array {
  // Short temporal smoothing then per-frame max normalisation, gated by a soft floor.
  const out = new Float32Array(raw.length);
  const tmp = new Float32Array(n);
  for (let c = 0; c < 12; c++) {
    for (let i = 0; i < n; i++) tmp[i] = raw[i * 12 + c];
    const sm = gaussianSmooth(tmp, 4);
    for (let i = 0; i < n; i++) out[i * 12 + c] = sm[i];
  }
  let globalMax = 1e-9;
  for (let i = 0; i < out.length; i++) globalMax = Math.max(globalMax, out[i]);
  for (let i = 0; i < n; i++) {
    let m = 1e-9;
    for (let c = 0; c < 12; c++) m = Math.max(m, out[i * 12 + c]);
    const gate = smoothstep(0.002, 0.05, m / globalMax);
    for (let c = 0; c < 12; c++) out[i * 12 + c] = (out[i * 12 + c] / m) * gate;
  }
  return out;
}
