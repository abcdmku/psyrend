/**
 * Resolution governor. Renders at full resolution and lets the frame rate land wherever it
 * lands; only when GPU time approaches the 30 fps floor (~28 ms) does it lower the internal
 * resolution, and it restores full resolution as soon as there is headroom again.
 */
export class PerfGovernor {
  scale = 1;
  minScale = 0.5;
  maxScale = 1;
  /** GPU frame time that triggers a resolution drop (close to 30 fps). */
  dropAtMs = 28;
  /** GPU frame time under which resolution climbs back toward native. */
  restoreBelowMs = 20;
  /** Detected display refresh rate (Hz). */
  refreshHz = 60;
  /** Desired frame rate; defaults to the display refresh. */
  targetHz = 0;
  gpuMs = 0;
  fps = 0;
  private frameTimes: number[] = [];
  private gpuSamples: number[] = [];
  private lastChange = 0;
  private intervals: number[] = [];

  private readonly querySet: GPUQuerySet | null = null;
  private readonly resolveBuffer: GPUBuffer | null = null;
  private readonly readBuffers: GPUBuffer[] = [];
  private readonly readBusy: boolean[] = [];

  constructor(
    private readonly device: GPUDevice,
    timestamps: boolean,
  ) {
    if (timestamps) {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
      this.resolveBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      for (let i = 0; i < 3; i++) {
        this.readBuffers.push(device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
        this.readBusy.push(false);
      }
    }
  }

  /** Timestamp writes for the first and last GPU pass of a frame. */
  timestampWrites(which: 'begin' | 'end'): GPUComputePassTimestampWrites | undefined {
    if (!this.querySet) return undefined;
    return which === 'begin' ? { querySet: this.querySet, beginningOfPassWriteIndex: 0 } : { querySet: this.querySet, endOfPassWriteIndex: 1 };
  }

  /** Call after encoding all passes, before finish(). Returns a callback to run after submit. */
  resolve(encoder: GPUCommandEncoder): () => void {
    if (this.querySet && this.resolveBuffer) {
      const idx = this.readBusy.indexOf(false);
      if (idx >= 0) {
        encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
        encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffers[idx], 0, 16);
        this.readBusy[idx] = true;
        return () => {
          const buf = this.readBuffers[idx];
          buf
            .mapAsync(GPUMapMode.READ)
            .then(() => {
              const t = new BigUint64Array(buf.getMappedRange());
              const ms = Number(t[1] - t[0]) / 1e6;
              buf.unmap();
              if (ms > 0 && ms < 1000) this.pushGpu(ms);
            })
            .catch(() => {})
            .finally(() => (this.readBusy[idx] = false));
        };
      }
      return () => {};
    }
    const t0 = performance.now();
    return () => {
      this.device.queue.onSubmittedWorkDone().then(() => this.pushGpu(performance.now() - t0));
    };
  }

  private pushGpu(ms: number): void {
    this.gpuSamples.push(ms);
    if (this.gpuSamples.length > 20) this.gpuSamples.shift();
  }

  /** Feed the rAF timestamp each frame. Returns true when the scale changed. */
  tick(now: number): boolean {
    this.frameTimes.push(now);
    while (this.frameTimes.length > 0 && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    this.fps = this.frameTimes.length;
    if (this.frameTimes.length >= 2) {
      const d = now - this.frameTimes[this.frameTimes.length - 2];
      this.intervals.push(d);
      if (this.intervals.length > 120) this.intervals.shift();
    }
    if (this.gpuSamples.length < 6) return false;
    const sorted = [...this.gpuSamples].sort((a, b) => a - b);
    this.gpuMs = sorted[Math.floor(sorted.length * 0.75)];
    if (now - this.lastChange < 350) return false;
    let next = this.scale;
    if (this.gpuMs > this.dropAtMs) next = this.scale * Math.max(0.85, Math.sqrt(this.dropAtMs / this.gpuMs) * 0.97);
    else if (this.gpuMs < this.restoreBelowMs) next = this.scale * 1.08;
    next = Math.min(this.maxScale, Math.max(this.minScale, next));
    if (Math.abs(next - this.scale) / this.scale > 0.035) {
      this.scale = next;
      this.lastChange = now;
      this.gpuSamples.length = 0;
      return true;
    }
    return false;
  }

  /** Measures the display refresh from rAF intervals. */
  static async detectRefresh(): Promise<number> {
    const stamps: number[] = [];
    await new Promise<void>((resolve) => {
      const step = (t: number) => {
        stamps.push(t);
        if (stamps.length < 50) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const d = stamps.slice(10).map((t, i, arr) => (i ? t - arr[i - 1] : 0)).slice(1).sort((a, b) => a - b);
    const median = d[d.length >> 1] || 16.67;
    const hz = 1000 / median;
    const common = [30, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240, 280, 300, 360, 480, 500];
    return common.reduce((best, c) => (Math.abs(c - hz) < Math.abs(best - hz) ? c : best), 60);
  }
}
