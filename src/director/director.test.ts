import { describe, expect, it } from 'vitest';
import { analyzeTrack } from '../audio/analysis/analyze';
import { synthesizeDemo } from '../audio/demoTrack';
import { TransitionKind } from '../gpu/postLayout';
import type { SceneMeta } from '../scenes/types';
import { planShow } from './director';

const scene = (id: string, energy: [number, number]): SceneMeta => ({
  id,
  name: id,
  energy,
  mood: { valence: 0.5, arousal: 0.5 },
  genres: { edm: 0.8 },
});
const SCENES = [scene('a', [0, 0.5]), scene('b', [0.3, 1]), scene('c', [0.5, 1]), scene('d', [0, 0.6]), scene('e', [0.4, 1])];

describe('planShow on the demo song', () => {
  const demo = synthesizeDemo(44100);
  const mono = new Float32Array(demo.left.length >> 1);
  for (let i = 0; i < mono.length; i++) mono[i] = (demo.left[2 * i] + demo.right[2 * i]) * 0.5;
  const analysis = analyzeTrack(mono, 22050);
  const cues = planShow(analysis, SCENES, { epoch: 1_000_000, seed: 7 });

  it('covers the whole track with contiguous cues', () => {
    expect(cues[0].start).toBe(0);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeCloseTo(cues[i - 1].end, 5);
    expect(cues[cues.length - 1].end).toBeCloseTo(analysis.duration, 5);
  });

  it('never repeats a scene back to back', () => {
    for (let i = 1; i < cues.length; i++) expect(cues[i].genome.sceneId).not.toBe(cues[i - 1].genome.sceneId);
  });

  it('hard-cuts exactly on each drop', () => {
    for (const d of analysis.drops) {
      const cue = cues.find((c) => Math.abs(c.start - d) < 0.01);
      expect(cue, `cue at drop ${d}`).toBeDefined();
      expect(cue!.transition).toBe(TransitionKind.Cut);
    }
  });

  it('is deterministic for the same track', () => {
    expect(planShow(analysis, SCENES, { epoch: 1_000_000, seed: 7 }).map((c) => c.genome.sceneId)).toEqual(cues.map((c) => c.genome.sceneId));
  });
});

describe('planShow as a journey through worlds', () => {
  const demo = synthesizeDemo(44100);
  const mono = new Float32Array(demo.left.length >> 1);
  for (let i = 0; i < mono.length; i++) mono[i] = (demo.left[2 * i] + demo.right[2 * i]) * 0.5;
  const analysis = analyzeTrack(mono, 22050);
  // Fewer worlds than sections, so the pool runs out partway through the song.
  const worlds = SCENES.slice(0, 3);
  const cues = planShow(analysis, worlds, { epoch: 1_000_000, seed: 7, worlds: true });

  it('never shows a world twice in one song', () => {
    const ids = cues.map((c) => c.genome.sceneId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('still covers the whole track when the worlds run out', () => {
    expect(cues[0].start).toBe(0);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeCloseTo(cues[i - 1].end, 5);
    expect(cues[cues.length - 1].end).toBeCloseTo(analysis.duration, 5);
  });
});

describe('planShow on the phrase grid', () => {
  const demo = synthesizeDemo(44100);
  const mono = new Float32Array(demo.left.length >> 1);
  for (let i = 0; i < mono.length; i++) mono[i] = (demo.left[2 * i] + demo.right[2 * i]) * 0.5;
  const analysis = analyzeTrack(mono, 22050);
  const many = Array.from({ length: 40 }, (_, i) => scene(`w${i}`, [0, 1]));
  const cues = planShow(analysis, many, { epoch: 1_000_000, seed: 7, worlds: true });
  const bar = (60 / analysis.bpm) * analysis.beatsPerBar;

  it('changes world at least every 8 bars (a short tail may join the last one)', () => {
    for (const c of cues) expect(c.end - c.start).toBeLessThan(bar * 12 + 0.01);
  });

  it('develops each world at its 4-bar point', () => {
    for (const c of cues) if (c.end - c.start >= bar * 6.5) expect(c.genome.develop?.at ?? 0).toBeGreaterThan(c.start + bar * 3);
  });
});
