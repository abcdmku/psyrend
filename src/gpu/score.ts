import { lowerIndex } from '../audio/analysis/util';
import type { OnsetTrack, SectionKind, TrackAnalysis } from '../audio/types';

/**
 * The whole song as two GPU textures, indexed by time row, so any shader can ask what is
 * sounding at any moment (past or future):
 *
 * scoreTex  (SCORE_COLS x rows, rgba16float), column = MIDI pitch - SCORE_MIDI_MIN:
 *   r: harmonic pitch salience (everything sounding: chords, pads, voices)
 *   g: lead line (1 on the transcribed lead pitch, soft over neighbours)
 *   b: bass line
 *   a: note attack (bright at each transcribed note's start, decaying ~150 ms)
 *
 * eventsTex (4 x rows, rgba16float):
 *   col 0: kick, snare, hat, any-onset envelopes
 *   col 1: beat pulse, bar pulse, section kind (0..1), section progress
 *   col 2: chord root ((root+1)/13, 0 = none), quality (maj 1, min .5, dim .25), tension, chord-change pulse
 *   col 3: lead pitch ((midi-28)/72, 0 = silent), lead strength, bass pitch, bass strength
 */
export const SCORE_MIDI_MIN = 28;
export const SCORE_COLS = 72;
const MAX_RATE = 43;

const SECTION_INDEX: Record<SectionKind, number> = { intro: 0, verse: 1, build: 2, peak: 3, breakdown: 4, bridge: 5, outro: 6 };

function toHalf(v: number): number {
  const f32 = new Float32Array([v]);
  const u32 = new Uint32Array(f32.buffer)[0];
  const sign = (u32 >> 16) & 0x8000;
  const exp = ((u32 >> 23) & 0xff) - 127 + 15;
  const mant = u32 & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >> 13);
}

export class ScoreTextures {
  readonly rows: number;
  readonly scoreTex: GPUTexture;
  readonly eventsTex: GPUTexture;
  /** Rows per second of the current track (0 = no track: shaders read silence). */
  rate = 0;
  validRows = 0;

  constructor(private readonly device: GPUDevice) {
    this.rows = Math.min(16384, device.limits.maxTextureDimension2D);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    this.scoreTex = device.createTexture({ label: 'score', size: [SCORE_COLS, this.rows], format: 'rgba16float', usage });
    this.eventsTex = device.createTexture({ label: 'score-events', size: [4, this.rows], format: 'rgba16float', usage });
  }

  clear(): void {
    this.rate = 0;
    this.validRows = 0;
  }

  load(a: TrackAnalysis): void {
    const rate = Math.min(MAX_RATE, (this.rows - 2) / Math.max(1, a.duration));
    const n = Math.min(this.rows, Math.ceil(a.duration * rate) + 1);
    const score = new Float32Array(n * SCORE_COLS * 4);
    const events = new Float32Array(n * 4 * 4);
    const srcRate = a.contourRate;
    const srcFrames = a.leadContour.length;

    // Pitchgram + contours, box-resampled to the texture rate.
    for (let r = 0; r < n; r++) {
      const f0 = Math.floor((r / rate) * srcRate);
      const f1 = Math.max(f0 + 1, Math.min(srcFrames, Math.floor(((r + 1) / rate) * srcRate)));
      for (let f = f0; f < f1 && f < srcFrames; f++) {
        for (let s = 0; s < a.pitchSemis; s++) {
          const col = a.pitchMin + s - SCORE_MIDI_MIN;
          if (col < 0 || col >= SCORE_COLS) continue;
          const v = a.pitchgram[f * a.pitchSemis + s];
          const o = (r * SCORE_COLS + col) * 4;
          score[o] = Math.max(score[o], v);
        }
      }
      for (let c = 0; c < SCORE_COLS; c++) {
        const o = (r * SCORE_COLS + c) * 4;
        const v = score[o];
        // Soft floor + gentle compression so faint partials don't read as structure.
        score[o] = Math.max(0, Math.min(1.5, (v - 0.12) / 0.88)) ** 0.8;
      }
      const f = Math.min(srcFrames - 1, f0);
      const lead = a.leadContour[f];
      const bass = a.bassContour[f];
      const eo = (r * 4 + 3) * 4;
      events[eo] = lead > 0 ? (lead - SCORE_MIDI_MIN) / SCORE_COLS : 0;
      events[eo + 1] = lead > 0 ? 1 : 0;
      events[eo + 2] = bass > 0 ? (bass - SCORE_MIDI_MIN) / SCORE_COLS : 0;
      events[eo + 3] = bass > 0 ? 1 : 0;
      // Lead / bass masks across neighbouring pitch columns (fractional pitch preserved).
      for (const [p, ch] of [
        [lead, 1],
        [bass, 2],
      ] as const) {
        if (p <= 0) continue;
        const x = p - SCORE_MIDI_MIN;
        for (let c = Math.floor(x) - 1; c <= Math.ceil(x) + 1; c++) {
          if (c < 0 || c >= SCORE_COLS) continue;
          const w = Math.max(0, 1 - Math.abs(c - x) / 1.2);
          const o = (r * SCORE_COLS + c) * 4 + ch;
          score[o] = Math.max(score[o], w);
        }
      }
    }

    // Note attacks.
    for (const note of a.notes) {
      const c = Math.round(note.pitch) - SCORE_MIDI_MIN;
      if (c < 0 || c >= SCORE_COLS) continue;
      const r0 = Math.floor(note.start * rate);
      const len = Math.max(2, Math.ceil(0.15 * rate));
      for (let k = 0; k < len && r0 + k < n; k++) {
        const o = ((r0 + k) * SCORE_COLS + c) * 4 + 3;
        score[o] = Math.max(score[o], note.strength * Math.exp(-k / (len * 0.4)) * (note.role === 'lead' ? 1 : 0.7));
      }
    }

    // Events.
    const env = (track: OnsetTrack, t: number, decay: number) => {
      const i = lowerIndex(track.times, t);
      return i < 0 ? 0 : track.strengths[i] * Math.exp(-(t - track.times[i]) / decay);
    };
    for (let r = 0; r < n; r++) {
      const t = r / rate;
      const o0 = (r * 4) * 4;
      events[o0] = env(a.kicks, t, 0.15);
      events[o0 + 1] = env(a.snares, t, 0.14);
      events[o0 + 2] = env(a.hats, t, 0.06);
      events[o0 + 3] = env(a.onsets, t, 0.1);
      const bi = lowerIndex(a.beats, t);
      const di = lowerIndex(a.downbeats, t);
      const o1 = o0 + 4;
      events[o1] = bi >= 0 ? Math.exp(-(t - a.beats[bi]) / 0.1) : 0;
      events[o1 + 1] = di >= 0 ? Math.exp(-(t - a.downbeats[di]) / 0.2) : 0;
      const sec = a.sections.find((s) => t >= s.start && t < s.end);
      events[o1 + 2] = sec ? SECTION_INDEX[sec.kind] / 6 : 0;
      events[o1 + 3] = sec ? (t - sec.start) / Math.max(1e-3, sec.end - sec.start) : 0;
      const ch = a.chords.find((c) => t >= c.start && t < c.end);
      const o2 = o0 + 8;
      if (ch) {
        events[o2] = ch.root >= 0 ? (ch.root + 1) / 13 : 0;
        events[o2 + 1] = ch.quality === 'maj' ? 1 : ch.quality === 'min' ? 0.5 : ch.quality === 'dim' ? 0.25 : 0;
        events[o2 + 2] = ch.tension;
        events[o2 + 3] = Math.exp(-(t - ch.start) / 0.3);
      }
    }

    const half = (src: Float32Array) => {
      const out = new Uint16Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = toHalf(src[i]);
      return out;
    };
    this.device.queue.writeTexture({ texture: this.scoreTex }, half(score), { bytesPerRow: SCORE_COLS * 8 }, [SCORE_COLS, n]);
    this.device.queue.writeTexture({ texture: this.eventsTex }, half(events), { bytesPerRow: 4 * 8 }, [4, n]);
    this.rate = rate;
    this.validRows = n;
  }
}
