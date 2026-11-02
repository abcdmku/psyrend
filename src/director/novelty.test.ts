import { describe, expect, it } from 'vitest';
import { analyzeTrack } from '../audio/analysis/analyze';
import { synthesizeDemo } from '../audio/demoTrack';
import type { LookMeta } from '../looks/types';
import type { SceneMeta } from '../scenes/types';
import { planShow } from './director';
import { similarity, trace } from './genome';
import { NoveltyMemory } from './novelty';

const scenes: SceneMeta[] = Array.from({ length: 12 }, (_, i) => ({
  id: `s${i}`,
  name: `s${i}`,
  energy: [i % 3 === 0 ? 0 : 0.3, 1] as [number, number],
  mood: { valence: 0.5, arousal: 0.5 },
  genres: { edm: 0.5 + (i % 4) * 0.1 },
}));
const looks: LookMeta[] = Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, name: `l${i}`, weight: 0.7, energy: [0, 1], amount: [0.5, 0.9] }));

class MapStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe('novelty across a 30-minute session', () => {
  const demo = synthesizeDemo(44100);
  const mono = new Float32Array(demo.left.length >> 1);
  for (let i = 0; i < mono.length; i++) mono[i] = (demo.left[2 * i] + demo.right[2 * i]) * 0.5;
  const analysis = analyzeTrack(mono, 22050);

  it('never shows a near-identical visual twice within 30 minutes, even replaying the same song', () => {
    const memory = new NoveltyMemory(new MapStorage());
    const shown: { g: ReturnType<typeof trace>; at: number }[] = [];
    let epoch = Date.now();
    // ~14 plays of a 137 s song ≈ 32 minutes, recording each cue as it would be displayed.
    for (let play = 0; play < 14; play++) {
      const cues = planShow(analysis, scenes, { looks, memory, epoch, seed: play * 7919 });
      for (const c of cues) {
        const at = epoch + c.start * 1000;
        const t = trace(c.genome);
        shown.push({ g: t, at });
        memory.record(t, at, c.end - c.start);
      }
      epoch += analysis.duration * 1000;
    }
    let nearDuplicates = 0;
    for (let i = 0; i < shown.length; i++)
      for (let j = 0; j < i; j++)
        if (shown[i].at - shown[j].at < 30 * 60 * 1000 && similarity(shown[i].g, shown[j].g) >= 0.8) nearDuplicates++;
    expect(shown.length).toBeGreaterThan(100);
    expect(nearDuplicates).toBe(0);
  });
});
