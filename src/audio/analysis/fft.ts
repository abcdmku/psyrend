/**
 * Real-input FFT built on a half-size complex radix-2 FFT plus the standard
 * "untangle" step, so an N-point real transform costs one N/2 complex FFT.
 */
export class RealFFT {
  readonly size: number;
  private readonly half: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly ucos: Float32Array;
  private readonly usin: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  constructor(size: number) {
    if (size < 4 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`);
    this.size = size;
    const m = size >> 1;
    this.half = m;
    this.re = new Float32Array(m);
    this.im = new Float32Array(m);
    this.rev = new Uint32Array(m);
    const bits = Math.log2(m);
    for (let i = 0; i < m; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(m / 2);
    this.sin = new Float32Array(m / 2);
    for (let k = 0; k < m / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / m);
      this.sin[k] = Math.sin((2 * Math.PI * k) / m);
    }
    this.ucos = new Float32Array(m + 1);
    this.usin = new Float32Array(m + 1);
    for (let k = 0; k <= m; k++) {
      this.ucos[k] = Math.cos((2 * Math.PI * k) / size);
      this.usin[k] = Math.sin((2 * Math.PI * k) / size);
    }
  }

  /** Writes |X[k]| for k = 0..N/2 into `mag` (length N/2 + 1). */
  magnitudes(input: Float32Array, mag: Float32Array): void {
    const m = this.half;
    const re = this.re;
    const im = this.im;
    const rev = this.rev;
    for (let i = 0; i < m; i++) {
      const j = rev[i];
      re[j] = input[2 * i];
      im[j] = input[2 * i + 1];
    }
    for (let size = 2; size <= m; size <<= 1) {
      const halfSize = size >> 1;
      const step = m / size;
      for (let start = 0; start < m; start += size) {
        for (let j = 0, k = 0; j < halfSize; j++, k += step) {
          const a = start + j;
          const b = a + halfSize;
          const c = this.cos[k];
          const s = this.sin[k];
          const tr = re[b] * c + im[b] * s;
          const ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= m; k++) {
      const ka = k === m ? 0 : k;
      const kb = k === 0 ? 0 : m - k;
      const a = re[ka];
      const b = im[ka];
      const c = re[kb];
      const d = im[kb];
      const er = (a + c) * 0.5;
      const ei = (b - d) * 0.5;
      const or = (b + d) * 0.5;
      const oi = -(a - c) * 0.5;
      const wr = this.ucos[k];
      const wi = -this.usin[k];
      const xr = er + wr * or - wi * oi;
      const xi = ei + wr * oi + wi * or;
      mag[k] = Math.sqrt(xr * xr + xi * xi);
    }
  }
}

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
