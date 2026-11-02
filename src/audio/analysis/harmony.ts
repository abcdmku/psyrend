import { PITCH_NAMES, type Chord, type ChordQuality, type Mode } from '../types';

// Krumhansl-Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: ArrayLike<number>, b: ArrayLike<number>, rot: number): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db + 1e-12);
}

export function detectKey(chroma: ArrayLike<number>): { root: number; mode: Mode; confidence: number; name: string } {
  const scores: { root: number; mode: Mode; r: number }[] = [];
  for (let root = 0; root < 12; root++) {
    scores.push({ root, mode: 'major', r: pearson(chroma, MAJOR_PROFILE, root) });
    scores.push({ root, mode: 'minor', r: pearson(chroma, MINOR_PROFILE, root) });
  }
  scores.sort((p, q) => q.r - p.r);
  const best = scores[0];
  const confidence = Math.max(0, Math.min(1, (best.r - scores[1].r) * 4 + Math.max(0, best.r) * 0.5));
  return {
    root: best.root,
    mode: best.mode,
    confidence,
    name: `${PITCH_NAMES[best.root]} ${best.mode}`,
  };
}

interface Template {
  root: number;
  quality: ChordQuality;
  v: Float32Array;
}

const TEMPLATES: Template[] = (() => {
  const t: Template[] = [];
  const shapes: [ChordQuality, number[]][] = [
    ['maj', [0, 4, 7]],
    ['min', [0, 3, 7]],
    ['dim', [0, 3, 6]],
  ];
  for (const [quality, iv] of shapes) {
    for (let root = 0; root < 12; root++) {
      const v = new Float32Array(12);
      iv.forEach((s, i) => (v[(root + s) % 12] = i === 0 ? 1.15 : 1));
      t.push({ root, quality, v });
    }
  }
  return t;
})();

function cosine12(a: Float32Array, ao: number, b: Float32Array): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 12; i++) {
    d += a[ao + i] * b[i];
    na += a[ao + i] * a[ao + i];
    nb += b[i] * b[i];
  }
  return d / Math.sqrt(na * nb + 1e-12);
}

const MAJOR_DEGREES: Record<number, [ChordQuality, number][]> = {
  0: [['maj', 0]],
  2: [['min', 0.35]],
  4: [['min', 0.4]],
  5: [['maj', 0.3]],
  7: [['maj', 0.62]],
  9: [['min', 0.28]],
  11: [['dim', 0.85]],
};
const MINOR_DEGREES: Record<number, [ChordQuality, number][]> = {
  0: [['min', 0]],
  2: [['dim', 0.7]],
  3: [['maj', 0.3]],
  5: [['min', 0.38]],
  7: [['min', 0.5], ['maj', 0.68]],
  8: [['maj', 0.32]],
  10: [['maj', 0.45]],
};

export function chordTension(root: number, quality: ChordQuality, keyRoot: number, mode: Mode): number {
  if (quality === 'none') return 0.2;
  const deg = (root - keyRoot + 12) % 12;
  const table = mode === 'major' ? MAJOR_DEGREES : MINOR_DEGREES;
  const hit = table[deg]?.find(([q]) => q === quality);
  if (hit) return hit[1];
  // Borrowed / chromatic chord.
  return quality === 'dim' ? 0.95 : 0.78;
}

/**
 * Beat-synchronous chord recognition: template matching with a Viterbi pass that
 * favours staying on a chord and favours diatonic chords of the detected key.
 */
export function recognizeChords(
  beatChroma: Float32Array,
  beatTimes: Float32Array,
  duration: number,
  key: { root: number; mode: Mode },
): Chord[] {
  const nb = beatTimes.length;
  if (nb === 0) return [];
  const S = TEMPLATES.length + 1; // + no-chord
  const emit = new Float32Array(nb * S);
  for (let b = 0; b < nb; b++) {
    let energy = 0;
    for (let i = 0; i < 12; i++) energy += beatChroma[b * 12 + i];
    for (let s = 0; s < TEMPLATES.length; s++) {
      const t = TEMPLATES[s];
      const diatonic = chordTension(t.root, t.quality, key.root, key.mode) < 0.75 ? 0.06 : 0;
      emit[b * S + s] = cosine12(beatChroma, b * 12, t.v) + diatonic - (t.quality === 'dim' ? 0.05 : 0);
    }
    emit[b * S + TEMPLATES.length] = energy < 1e-3 ? 1 : 0.45;
  }
  const switchCost = 0.18;
  const score = new Float32Array(S);
  const next = new Float32Array(S);
  const back = new Int16Array(nb * S);
  for (let s = 0; s < S; s++) score[s] = emit[s];
  for (let b = 1; b < nb; b++) {
    let bestPrev = 0;
    for (let s = 1; s < S; s++) if (score[s] > score[bestPrev]) bestPrev = s;
    for (let s = 0; s < S; s++) {
      const stay = score[s];
      const sw = score[bestPrev] - switchCost;
      if (stay >= sw) {
        next[s] = stay + emit[b * S + s];
        back[b * S + s] = s;
      } else {
        next[s] = sw + emit[b * S + s];
        back[b * S + s] = bestPrev;
      }
    }
    score.set(next);
  }
  let s = 0;
  for (let i = 1; i < S; i++) if (score[i] > score[s]) s = i;
  const path = new Int16Array(nb);
  for (let b = nb - 1; b >= 0; b--) {
    path[b] = s;
    s = back[b * S + s];
  }
  const chords: Chord[] = [];
  for (let b = 0; b < nb; b++) {
    const st = path[b];
    const t = st < TEMPLATES.length ? TEMPLATES[st] : null;
    const root = t ? t.root : -1;
    const quality: ChordQuality = t ? t.quality : 'none';
    const start = beatTimes[b];
    const end = b + 1 < nb ? beatTimes[b + 1] : duration;
    const last = chords[chords.length - 1];
    if (last && last.root === root && last.quality === quality) {
      last.end = end;
    } else {
      chords.push({ start, end, root, quality, tension: chordTension(root, quality, key.root, key.mode) });
    }
  }
  return chords;
}

export function chordName(c: Pick<Chord, 'root' | 'quality'>): string {
  if (c.quality === 'none' || c.root < 0) return '–';
  return PITCH_NAMES[c.root] + (c.quality === 'min' ? 'm' : c.quality === 'dim' ? '°' : '');
}

/**
 * Profiles can't tell a key from its relative major/minor (Am vs C share notes).
 * Decide by which tonic triad dominates, weighting the opening and closing chords.
 */
export function resolveRelativeKey(
  key: ReturnType<typeof detectKey>,
  beatChroma: Float32Array,
  beatTimes: Float32Array,
  duration: number,
): ReturnType<typeof detectKey> {
  const rel = key.mode === 'major' ? { root: (key.root + 9) % 12, mode: 'minor' as Mode } : { root: (key.root + 3) % 12, mode: 'major' as Mode };
  const chords = recognizeChords(beatChroma, beatTimes, duration, key);
  if (!chords.length) return key;
  const tonicWeight = (root: number, mode: Mode) => {
    const q: ChordQuality = mode === 'major' ? 'maj' : 'min';
    let w = 0;
    chords.forEach((c, i) => {
      if (c.root !== root || c.quality !== q) return;
      w += c.end - c.start;
      if (i === 0) w += duration * 0.04;
      if (i === chords.length - 1) w += duration * 0.04;
    });
    return w;
  };
  const a = tonicWeight(key.root, key.mode);
  const b = tonicWeight(rel.root, rel.mode);
  if (b > a * 1.05) return { ...rel, confidence: key.confidence, name: `${PITCH_NAMES[rel.root]} ${rel.mode}` };
  return key;
}
