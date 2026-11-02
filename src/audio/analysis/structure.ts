import { cosineSim, gaussianSmooth, mean, percentile, std } from './util';

export interface Segmentation {
  /** Beat indices where segments start; always begins with 0. */
  starts: number[];
  clusters: number[];
}

/**
 * Foote-style novelty segmentation over a beat-synchronous self-similarity matrix,
 * snapped to bar lines, followed by greedy clustering of segments into repeats.
 * The last feature dimension must be beat energy.
 */
export function segment(
  feats: Float32Array,
  dim: number,
  nb: number,
  beatsPerBar: number,
  barPhase: number,
  beatDuration: number,
): Segmentation {
  if (nb < beatsPerBar * 8) return { starts: [0], clusters: [0] };

  // Self-similarity, mapped from cosine [-1,1] to [0,1].
  const S = new Float32Array(nb * nb);
  for (let i = 0; i < nb; i++) {
    S[i * nb + i] = 1;
    for (let j = i + 1; j < nb; j++) {
      const v = (cosineSim(feats, i * dim, feats, j * dim, dim) + 1) * 0.5;
      S[i * nb + j] = v;
      S[j * nb + i] = v;
    }
  }

  // Multi-scale novelty (2-bar and 4-bar checkerboards) plus an energy-step term,
  // so both long verse/chorus changes and short build-ups register.
  const nov = new Float32Array(nb);
  for (const bars of [2, 4]) {
    const k = footeNovelty(S, nb, beatsPerBar * bars);
    const m = Math.max(1e-9, ...k);
    for (let i = 0; i < nb; i++) nov[i] += k[i] / m;
  }
  const w = beatsPerBar * 2;
  const step = new Float32Array(nb);
  for (let i = w; i < nb - w; i++) {
    let before = 0;
    let after = 0;
    for (let j = 1; j <= w; j++) {
      before += feats[(i - j) * dim + dim - 1];
      after += feats[(i + j - 1) * dim + dim - 1];
    }
    step[i] = Math.abs(after - before) / w;
  }
  const stepMax = Math.max(1e-9, ...step);
  for (let i = 0; i < nb; i++) nov[i] += (step[i] / stepMax) * 1.2;

  // Peak picking with a minimum section length of ~4 bars (or 8 s for slow music).
  const minLen = Math.max(beatsPerBar * 4, Math.round(6 / beatDuration));
  const thr = mean(nov) + 0.35 * std(nov);
  const candidates: { i: number; v: number }[] = [];
  for (let i = 2; i < nb - 2; i++) {
    if (nov[i] < thr) continue;
    let isMax = true;
    for (let j = Math.max(0, i - beatsPerBar * 2); j <= Math.min(nb - 1, i + beatsPerBar * 2); j++)
      if (nov[j] > nov[i]) {
        isMax = false;
        break;
      }
    if (isMax) candidates.push({ i, v: nov[i] });
  }
  candidates.sort((p, q) => q.v - p.v);
  const chosen: number[] = [0];
  for (const c of candidates) {
    // Snap to the nearest bar line.
    const rel = c.i - barPhase;
    const snapped = Math.max(0, Math.round(rel / beatsPerBar) * beatsPerBar + barPhase);
    if (snapped >= nb - minLen / 2) continue;
    if (chosen.every((x) => Math.abs(x - snapped) >= minLen)) chosen.push(snapped);
  }
  chosen.sort((a, b) => a - b);

  // Cluster segments by mean block similarity.
  const segs = chosen.map((s, k) => [s, k + 1 < chosen.length ? chosen[k + 1] : nb] as const);
  const n = segs.length;
  const blockSim = (p: number, q: number) => {
    // Compare the segments' diagonals (time-aligned) and their overall average; take the max.
    const [a0, a1] = segs[p];
    const [b0, b1] = segs[q];
    const len = Math.min(a1 - a0, b1 - b0);
    let diag = 0;
    for (let k = 0; k < len; k++) diag += S[(a0 + k) * nb + (b0 + k)];
    diag /= Math.max(1, len);
    let avg = 0;
    let cnt = 0;
    for (let i = a0; i < a1; i += 2)
      for (let j = b0; j < b1; j += 2) {
        avg += S[i * nb + j];
        cnt++;
      }
    return Math.max(diag, avg / Math.max(1, cnt));
  };
  const pair: number[] = [];
  const M = new Float32Array(n * n);
  for (let p = 0; p < n; p++)
    for (let q = p + 1; q < n; q++) {
      const v = blockSim(p, q);
      M[p * n + q] = v;
      M[q * n + p] = v;
      pair.push(v);
    }
  const tau = pair.length ? Math.max(percentile(pair, 0.7), 0.82) : 1;
  const clusters: number[] = new Array(n).fill(-1);
  let next = 0;
  for (let p = 0; p < n; p++) {
    if (clusters[p] >= 0) continue;
    clusters[p] = next;
    for (let q = p + 1; q < n; q++) if (clusters[q] < 0 && M[p * n + q] >= tau) clusters[q] = next;
    next++;
  }
  return { starts: chosen, clusters };
}

function footeNovelty(S: Float32Array, nb: number, half: number): Float32Array {
  const kernel = new Float32Array((2 * half) ** 2);
  const sigma = half * 0.6;
  for (let a = -half; a < half; a++)
    for (let b = -half; b < half; b++) {
      const sign = (a < 0) === (b < 0) ? 1 : -1;
      kernel[(a + half) * 2 * half + (b + half)] = sign * Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * sigma * sigma));
    }
  const out = new Float32Array(nb);
  for (let i = 0; i < nb; i++) {
    let s = 0;
    for (let a = -half; a < half; a++) {
      const ia = Math.min(nb - 1, Math.max(0, i + a));
      for (let b = -half; b < half; b++) {
        const ib = Math.min(nb - 1, Math.max(0, i + b));
        s += kernel[(a + half) * 2 * half + (b + half)] * S[ia * nb + ib];
      }
    }
    out[i] = Math.max(0, s);
  }
  return gaussianSmooth(out, 1);
}
