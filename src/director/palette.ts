import { oklch, type RGB } from './color';

/**
 * Palette schemes. Every scheme is anchored to the music's hue (key + chord + mood),
 * but arranges the four colours differently, so the same song can look warm, icy,
 * neon or pastel in different cues.
 */
export interface PaletteInput {
  /** Base hue in degrees from key/chord/valence. */
  hue: number;
  arousal: number;
  valence: number;
  tension: number;
  /** Integrated rotation phase (for drifting schemes). */
  spin: number;
}

type Scheme = { name: string; build(i: PaletteInput): [RGB, RGB, RGB, RGB] };

const L = (va: number) => 0.85 + 0.3 * va;

export const PALETTE_SCHEMES: Scheme[] = [
  {
    name: 'analogous',
    build: ({ hue: h, arousal: ar, valence: va, tension: ten }) => {
      // At least 70 degrees of spread: a single-hue frame reads as murky.
      const spread = 70 + ar * 80 + ten * 35;
      const ls = L(va);
      // Vivid by default: the references are saturated colour on black.
      const c = 0.16 + 0.08 * ar;
      return [
        oklch(0.16 * ls, 0.06 + 0.04 * ar, h - spread * 0.6),
        oklch(0.56 * ls, c + 0.03, h),
        oklch(0.66 * ls, c + 0.05, h + spread),
        oklch(Math.min(0.97, 0.88 * ls + 0.05), 0.07 + 0.05 * va, h + spread * 0.45 + 25),
      ];
    },
  },
  {
    name: 'complementary',
    build: ({ hue: h, arousal: ar, valence: va }) => [
      oklch(0.14, 0.05, h + 180),
      oklch(0.55 * L(va), 0.15 + 0.08 * ar, h),
      oklch(0.68 * L(va), 0.16 + 0.06 * ar, h + 180),
      oklch(0.93, 0.06, h + 20),
    ],
  },
  {
    name: 'triadic',
    build: ({ hue: h, arousal: ar, valence: va }) => [
      oklch(0.15, 0.06, h + 240),
      oklch(0.6 * L(va), 0.15 + 0.07 * ar, h),
      oklch(0.66 * L(va), 0.15 + 0.07 * ar, h + 120),
      oklch(0.9, 0.09, h + 240),
    ],
  },
  {
    name: 'neon-mono',
    build: ({ hue: h, arousal: ar }) => [
      oklch(0.08, 0.04, h),
      oklch(0.55, 0.24 + 0.05 * ar, h - 12),
      oklch(0.66, 0.22, h + 14),
      oklch(0.94, 0.05, h),
    ],
  },
  {
    name: 'pastel',
    build: ({ hue: h, valence: va }) => [
      oklch(0.3, 0.04, h + 200),
      oklch(0.66, 0.08, h),
      oklch(0.72, 0.08, h + 70 + 40 * va),
      oklch(0.94, 0.03, h + 140),
    ],
  },
  {
    name: 'duotone',
    build: ({ hue: h, arousal: ar }) => [
      oklch(0.12, 0.07, h + 180),
      oklch(0.4, 0.13, h + 180),
      oklch(0.72, 0.17 + 0.05 * ar, h),
      oklch(0.95, 0.06, h + 10),
    ],
  },
  {
    name: 'ember',
    build: ({ hue: h, arousal: ar }) => {
      const base = 25 + ((h % 360) / 360) * 30;
      return [oklch(0.12, 0.05, base - 10), oklch(0.5, 0.18 + 0.05 * ar, base), oklch(0.72, 0.17, base + 35), oklch(0.96, 0.07, base + 70)];
    },
  },
  {
    name: 'glacier',
    build: ({ hue: h, valence: va }) => {
      const base = 205 + ((h % 360) / 360) * 60;
      return [oklch(0.13, 0.05, base + 30), oklch(0.55 * L(va), 0.11, base), oklch(0.75, 0.1, base - 25), oklch(0.97, 0.03, base)];
    },
  },
  {
    name: 'iridescent',
    build: ({ hue: h, spin, arousal: ar }) => {
      const d = spin * 25;
      return [oklch(0.14, 0.06, h + d), oklch(0.62, 0.16 + 0.05 * ar, h + d + 90), oklch(0.7, 0.16, h + d + 200), oklch(0.93, 0.08, h + d + 300)];
    },
  },
  {
    name: 'split-complementary',
    build: ({ hue: h, arousal: ar, valence: va }) => [
      oklch(0.15, 0.05, h),
      oklch(0.58 * L(va), 0.15 + 0.06 * ar, h + 150),
      oklch(0.66 * L(va), 0.15 + 0.06 * ar, h + 210),
      oklch(0.92, 0.08, h),
    ],
  },
  {
    name: 'acid',
    build: ({ hue: h }) => [oklch(0.1, 0.06, h + 300), oklch(0.64, 0.24, h + 130), oklch(0.58, 0.26, h + 330), oklch(0.92, 0.12, h + 100)],
  },
  {
    name: 'noir',
    build: ({ hue: h, tension: ten }) => [oklch(0.07, 0.01, h), oklch(0.42, 0.02, h), oklch(0.62, 0.17 + 0.06 * ten, h), oklch(0.96, 0.01, h)],
  },
];

/**
 * Mood-weighted probabilities for choosing a scheme. Only schemes with two or more distinct hues
 * are used: single-hue schemes (neon-mono, ember, glacier, noir) make every world one colour,
 * which reads as flat and murky, so they are never chosen (kept for pinning by hand).
 */
export function schemeWeights(valence: number, arousal: number): number[] {
  const hi = arousal;
  const warm = valence;
  return [
    1.0, // analogous
    1.0 + 0.5 * hi, // complementary
    0.9 + 0.5 * hi, // triadic
    0, // neon-mono
    0.1 + 0.25 * warm * (1 - hi), // pastel
    0.7, // duotone
    0, // ember
    0, // glacier
    1.1, // iridescent
    1.0, // split-complementary
    0.3 + 0.5 * hi * warm, // acid
    0, // noir
  ];
}
