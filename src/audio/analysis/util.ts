export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function mean(a: ArrayLike<number>, from = 0, to = a.length): number {
  if (to <= from) return 0;
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return s / (to - from);
}

export function std(a: ArrayLike<number>): number {
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return Math.sqrt(s / Math.max(1, a.length));
}

export function percentile(a: ArrayLike<number>, p: number): number {
  if (a.length === 0) return 0;
  const sorted = Float32Array.from(a).sort();
  const idx = clamp01(p) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Robustly maps [p(lo), p(hi)] to [0, 1] with clamping. */
export function normalizeRobust(a: Float32Array, lo = 0.05, hi = 0.98): Float32Array {
  const a0 = percentile(a, lo);
  const a1 = percentile(a, hi);
  const span = Math.max(1e-9, a1 - a0);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = clamp01((a[i] - a0) / span);
  return out;
}

/**
 * Like normalizeRobust, but with soft knees instead of hard clamps: [p(lo), p(hi)] maps to about
 * [0, 1] and the ends ease smoothly into 0 and 1 (softplus, width `knee`), so quiet material
 * still registers and nothing kinks as a level crosses the floor or the ceiling.
 */
export function normalizeSoft(a: Float32Array, lo = 0.02, hi = 0.995, knee = 0.08): Float32Array {
  const a0 = percentile(a, lo);
  const a1 = percentile(a, hi);
  const span = Math.max(1e-9, a1 - a0);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = softClamp01((a[i] - a0) / span, knee);
  return out;
}

/** clamp01 with soft knees of width `knee` at both ends (softplus): smooth, never kinked. */
export function softClamp01(x: number, knee = 0.08): number {
  const sp = (v: number) => (v > 20 ? v : Math.log1p(Math.exp(v)));
  const floor = knee * sp(x / knee);
  return clamp01(1 - knee * sp((1 - floor) / knee));
}

/** Zero-phase Gaussian blur with standard deviation `sigma` in samples. */
export function gaussianSmooth(a: Float32Array, sigma: number): Float32Array {
  if (sigma < 0.5) return Float32Array.from(a);
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  let ks = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    ks += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ks;
  const n = a.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let w = 0;
    const j0 = Math.max(0, i - radius);
    const j1 = Math.min(n - 1, i + radius);
    for (let j = j0; j <= j1; j++) {
      const k = kernel[j - i + radius];
      s += a[j] * k;
      w += k;
    }
    out[i] = s / w;
  }
  return out;
}

/** Sliding median (window = 2r+1), clamped at edges. Uses a small sorted window. */
export function medianFilter(a: Float32Array, r: number): Float32Array {
  const n = a.length;
  const out = new Float32Array(n);
  const win = new Float32Array(2 * r + 1);
  for (let i = 0; i < n; i++) {
    const j0 = Math.max(0, i - r);
    const j1 = Math.min(n - 1, i + r);
    const len = j1 - j0 + 1;
    for (let j = 0; j < len; j++) {
      const v = a[j0 + j];
      let k = j - 1;
      while (k >= 0 && win[k] > v) {
        win[k + 1] = win[k];
        k--;
      }
      win[k + 1] = v;
    }
    out[i] = win[len >> 1];
  }
  return out;
}

export interface PeakOptions {
  /** Half-width of the local-maximum neighbourhood in frames. */
  radius: number;
  /** Half-width of the adaptive median threshold window in frames. */
  medianRadius: number;
  /** Multiplier on the local median. */
  k: number;
  /** Absolute offset added to the threshold. */
  delta: number;
  /** Minimum frames between peaks. */
  minGap: number;
}

/** Adaptive-threshold peak picking for onset envelopes. Returns frame indices and salience. */
export function pickPeaks(env: Float32Array, o: PeakOptions): { frames: number[]; strengths: number[] } {
  const med = medianFilter(env, o.medianRadius);
  const frames: number[] = [];
  const strengths: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i];
    const thr = med[i] * o.k + o.delta;
    if (v <= thr) continue;
    let isMax = true;
    for (let j = Math.max(0, i - o.radius); j <= Math.min(env.length - 1, i + o.radius); j++) {
      if (env[j] > v || (env[j] === v && j < i)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    if (i - last < o.minGap) {
      if (strengths.length && v - thr > strengths[strengths.length - 1]) {
        frames[frames.length - 1] = i;
        strengths[strengths.length - 1] = v - thr;
        last = i;
      }
      continue;
    }
    frames.push(i);
    strengths.push(v - thr);
    last = i;
  }
  const maxS = strengths.reduce((m, s) => Math.max(m, s), 1e-9);
  return { frames, strengths: strengths.map((s) => Math.sqrt(s / maxS)) };
}

export function cosineSim(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, n: number): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[ao + i];
    const y = b[bo + i];
    d += x * y;
    na += x * x;
    nb += y * y;
  }
  return d / Math.sqrt(na * nb + 1e-12);
}

/** Index of the last element <= t in a sorted array, or -1. */
export function lowerIndex(sorted: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
