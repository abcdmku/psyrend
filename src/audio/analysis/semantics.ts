import { GENRES, GENRE_LABELS, type GenreId, type GenreScore, type SectionKind } from '../types';

export interface SegmentStats {
  start: number;
  end: number;
  energy: number;
  slope: number;
  /** Slope of spectral brightness per second (risers, opening filters). */
  brightSlope: number;
  cluster: number;
}

/** Assigns musical roles to segments from relative energy, trajectory and repetition. */
export function labelSections(segs: SegmentStats[]): SectionKind[] {
  const n = segs.length;
  if (n === 1) return ['verse'];
  const es = segs.map((s) => s.energy);
  const lo = Math.min(...es);
  const hi = Math.max(...es);
  const rel = es.map((e) => (hi - lo > 0.05 ? (e - lo) / (hi - lo) : 0.5));
  const clusterCount = new Map<number, number>();
  segs.forEach((s) => clusterCount.set(s.cluster, (clusterCount.get(s.cluster) ?? 0) + 1));
  const duration = segs[n - 1].end;

  const kinds: SectionKind[] = segs.map((s, i) => {
    const r = rel[i];
    if (r >= 0.78) return 'peak';
    if (i === 0 && r < 0.5) return 'intro';
    if (i === n - 1 && r < 0.55) return 'outro';
    if (r < 0.32) return 'breakdown';
    const mid = (s.start + s.end) / 2 / duration;
    if ((clusterCount.get(s.cluster) ?? 0) === 1 && mid > 0.4 && mid < 0.85 && n > 4) return 'bridge';
    return 'verse';
  });
  // A rising section that hands off to a peak is a build.
  for (let i = 0; i < n - 1; i++) {
    if (kinds[i] !== 'peak' && kinds[i + 1] === 'peak' && (segs[i].slope > 0.012 || segs[i].brightSlope > 0.01) && kinds[i] !== 'intro') kinds[i] = 'build';
  }
  return kinds;
}

export function moodLabel(valence: number, arousal: number): string {
  if (arousal > 0.62) return valence > 0.55 ? 'Euphoric' : valence < 0.42 ? 'Aggressive' : 'Energetic';
  if (arousal < 0.38) return valence > 0.55 ? 'Serene' : valence < 0.42 ? 'Melancholic' : 'Dreamy';
  return valence > 0.58 ? 'Uplifting' : valence < 0.4 ? 'Dark' : 'Hypnotic';
}

export interface GenreFeatures {
  tempo: number;
  four: number;
  perc: number;
  bass: number;
  bright: number;
  density: number;
  dyn: number;
  harm: number;
  halftime: number;
  hatRate: number;
}

type Proto = Partial<Record<keyof GenreFeatures, [number, number]>>;

// Hand-tuned diagonal Gaussian prototypes over global descriptors.
const PROTOTYPES: Record<GenreId, Proto> = {
  techno: { tempo: [126, 6], four: [0.85, 0.15], perc: [0.5, 0.15], bass: [0.55, 0.15], density: [6, 3], dyn: [7, 4], harm: [0.35, 0.35], halftime: [0.15, 0.15], bright: [2, 1] },
  edm: { tempo: [128, 9], four: [0.75, 0.2], perc: [0.4, 0.15], bass: [0.45, 0.15], density: [5, 3], dyn: [9, 4], harm: [0.7, 0.5], bright: [2.5, 1] },
  dnb: { tempo: [172, 7], four: [0.3, 0.2], perc: [0.55, 0.15], bass: [0.5, 0.15], density: [8, 3], hatRate: [2, 1] },
  dubstep: { tempo: [140, 6], halftime: [0.6, 0.25], bass: [0.6, 0.15], perc: [0.45, 0.15], four: [0.35, 0.2], dyn: [8, 4] },
  hiphop: { tempo: [90, 12], four: [0.35, 0.2], bass: [0.6, 0.15], perc: [0.45, 0.15], harm: [0.4, 0.4], halftime: [0.35, 0.3], density: [4, 2] },
  pop: { tempo: [112, 18], four: [0.55, 0.25], perc: [0.35, 0.12], bass: [0.4, 0.15], harm: [1, 0.5], dyn: [8, 4], bright: [2.2, 0.8] },
  rock: { tempo: [125, 25], perc: [0.4, 0.12], bass: [0.25, 0.12], bright: [2.8, 1], four: [0.45, 0.25], density: [6, 3], dyn: [7, 3] },
  ambient: { perc: [0.12, 0.1], density: [1.5, 1.5], four: [0.1, 0.15], dyn: [12, 6], harm: [0.3, 0.3], tempo: [100, 40], bright: [1.5, 1] },
  classical: { perc: [0.15, 0.1], dyn: [18, 7], four: [0.1, 0.15], bass: [0.2, 0.12], harm: [1.2, 0.6], density: [3, 2] },
  jazz: { perc: [0.3, 0.12], harm: [1.8, 0.6], four: [0.25, 0.2], dyn: [11, 5], bass: [0.3, 0.15], tempo: [120, 35] },
  acoustic: { perc: [0.3, 0.12], bass: [0.2, 0.12], bright: [1.8, 0.7], dyn: [10, 5], harm: [0.8, 0.4], four: [0.3, 0.25], density: [3.5, 2] },
  lofi: { tempo: [82, 10], perc: [0.4, 0.15], bright: [1.2, 0.5], dyn: [6, 3], bass: [0.45, 0.15], harm: [0.9, 0.5], four: [0.4, 0.25] },
  synthwave: { tempo: [105, 15], four: [0.6, 0.25], perc: [0.35, 0.12], bright: [2, 0.8], harm: [0.7, 0.4], bass: [0.4, 0.15] },
};

export function classifyGenre(f: GenreFeatures): GenreScore[] {
  const logits = GENRES.map((g) => {
    const proto = PROTOTYPES[g];
    let ll = 0;
    for (const key of Object.keys(proto) as (keyof GenreFeatures)[]) {
      const [mu, sd] = proto[key]!;
      if (key === 'tempo') {
        // Tempo estimates often land on half/double time; accept those at a discount.
        const zs = [f.tempo, f.tempo * 2, f.tempo / 2].map((t, i) => -0.5 * ((t - mu) / sd) ** 2 - (i ? 0.6 : 0));
        ll += Math.max(-8, Math.max(...zs));
      } else {
        ll += Math.max(-8, -0.5 * ((f[key] - mu) / sd) ** 2);
      }
    }
    // Normalise by feature count so prototypes with fewer constraints aren't favoured.
    return ll / Math.sqrt(Object.keys(proto).length);
  });
  const T = 0.8;
  const m = Math.max(...logits);
  const exps = logits.map((l) => Math.exp((l - m) / T));
  const z = exps.reduce((a, b) => a + b, 0);
  return GENRES.map((id, i) => ({ id, label: GENRE_LABELS[id], confidence: exps[i] / z })).sort((a, b) => b.confidence - a.confidence);
}
