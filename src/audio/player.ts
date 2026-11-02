/**
 * Plays a decoded AudioBuffer and reports the song position that is reaching
 * the listener's ears right now (output latency compensated).
 */
export class Player {
  readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startCtxTime = 0;
  private offset = 0;
  private _playing = false;
  onEnded: (() => void) | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  get playing(): boolean {
    return this._playing;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get volume(): number {
    return this.gain.gain.value;
  }

  set volume(v: number) {
    this.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.02);
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  load(buffer: AudioBuffer): void {
    this.stopSource();
    this.buffer = buffer;
    this.offset = 0;
    this._playing = false;
  }

  async play(): Promise<void> {
    if (!this.buffer || this._playing) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.offset >= this.buffer.duration - 0.01) this.offset = 0;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      if (this.source !== src) return;
      this._playing = false;
      this.offset = this.buffer?.duration ?? 0;
      this.source = null;
      this.onEnded?.();
    };
    this.startCtxTime = this.ctx.currentTime + 0.01;
    src.start(this.startCtxTime, this.offset);
    this.source = src;
    this._playing = true;
  }

  pause(): void {
    if (!this._playing) return;
    this.offset = this.rawTime();
    this.stopSource();
    this._playing = false;
  }

  toggle(): void {
    if (this._playing) this.pause();
    else void this.play();
  }

  seek(t: number): void {
    if (!this.buffer) return;
    const wasPlaying = this._playing;
    this.stopSource();
    this._playing = false;
    this.offset = Math.max(0, Math.min(this.buffer.duration - 0.05, t));
    if (wasPlaying) void this.play();
  }

  private stopSource(): void {
    if (this.source) {
      const s = this.source;
      this.source = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
  }

  /** Song time of the samples currently being scheduled (no latency compensation). */
  private rawTime(): number {
    if (!this._playing) return this.offset;
    return this.offset + Math.max(0, this.ctx.currentTime - this.startCtxTime);
  }

  /**
   * Song time currently audible. `displayLead` (seconds) shifts forward to account for
   * the frame being shown slightly after it is rendered.
   */
  audibleTime(displayLead = 0): number {
    if (!this._playing) return this.offset;
    let heardCtx: number;
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      heardCtx = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    } else {
      heardCtx = this.ctx.currentTime - (this.ctx.outputLatency || 0) - (this.ctx.baseLatency || 0);
    }
    const t = this.offset + (heardCtx - this.startCtxTime) + displayLead;
    return Math.max(0, Math.min(this.duration, t));
  }
}
