import { describe, expect, it } from 'vitest';
import { synthesizeDemo } from '../demoTrack';
import { analyzeTrack } from './analyze';
import { RealFFT } from './fft';

function toMono22k(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(Math.floor(left.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = (left[2 * i] + left[2 * i + 1] + right[2 * i] + right[2 * i + 1]) * 0.25;
  return out;
}

describe('RealFFT', () => {
  it('puts a pure tone in the right bin', () => {
    const fft = new RealFFT(1024);
    const x = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) x[i] = Math.cos((2 * Math.PI * 37 * i) / 1024);
    const mag = new Float32Array(513);
    fft.magnitudes(x, mag);
    let best = 0;
    for (let k = 1; k < 513; k++) if (mag[k] > mag[best]) best = k;
    expect(best).toBe(37);
    expect(mag[37]).toBeCloseTo(512, 0);
  });
});

describe('analyzeTrack on the synthesized demo', () => {
  const demo = synthesizeDemo(44100);
  const a = analyzeTrack(toMono22k(demo.left, demo.right), 22050);

  it('finds the tempo', () => {
    expect(a.bpm).toBeGreaterThan(126);
    expect(a.bpm).toBeLessThan(130);
  });

  it('finds the key (A minor or its relative C major)', () => {
    expect(['A minor', 'C major']).toContain(a.key.name);
  });

  it('places downbeats on bar lines', () => {
    const bar = (60 / 128) * 4;
    const offsets = Array.from(a.downbeats.slice(4, 40), (t) => {
      const r = (t / bar) % 1;
      return Math.min(r, 1 - r) * bar;
    });
    const median = offsets.sort((x, y) => x - y)[offsets.length >> 1];
    expect(median).toBeLessThan(0.06);
  });

  it('detects drops ahead of time and ramps anticipation into them', () => {
    const bar = (60 / 128) * 4;
    const dropStarts = [24 * bar, 52 * bar];
    for (const d of dropStarts) {
      const hit = Array.from(a.drops).some((t) => Math.abs(t - d) < bar * 1.01);
      expect(hit, `drop near ${d.toFixed(1)}s in ${Array.from(a.drops).map((t) => t.toFixed(1))}`).toBe(true);
      const f = Math.floor((d - 0.3) * a.frameRate);
      expect(a.anticipation[f]).toBeGreaterThan(0.4);
    }
  });

  it('labels the loud sections as peaks', () => {
    const bar = (60 / 128) * 4;
    const at = (t: number) => a.sections.find((s) => t >= s.start && t < s.end)!;
    expect(at(30 * bar).kind).toBe('peak');
    expect(at(60 * bar).kind).toBe('peak');
    expect(at(2 * bar).kind).not.toBe('peak');
  });

  it('calls it electronic', () => {
    expect(['techno', 'edm']).toContain(a.genres[0].id);
  });
});
