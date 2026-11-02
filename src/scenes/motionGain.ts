/**
 * Per-world motion calibration. Each world turns the shared morph speed into a different amount of
 * visible motion, so the same song looked frantic in one world and nearly frozen in another.
 * `scripts/motion.mjs` measures each world's optical speed (screen heights per second) on reference
 * songs; the gain brings it toward TARGET. Regenerate with `node scripts/calibrate.mjs`.
 */
export const MOTION_TARGET = 0.32;

const GAIN: Record<string, number> = {
  'domain-colour': 1.03,
  'droste-zoom': 1.75,
  'ember-fibres': 3,
  'glass-shards': 1.07,
  'glossy-liquid': 0.65,
  'gyroid-tunnel': 0.74,
  'hyperbolic-dome': 0.86,
  'hyperbolic-weave': 0.75,
  'ink-marble': 2.52,
  'kali-volume': 0.59,
  'laser-show': 1.02,
  'marble-flow': 1.11,
  'mobius-flow': 1.46,
  'neon-contours': 1.18,
  'phrase-bloom': 1.38,
  'quasi-tunnel': 0.93,
  'quasicrystal-lace': 1.01,
  'silk-ribbons': 0.77,
  'smoke-veils': 0.86,
  'spectral-nebula': 3,
  'thin-film': 0.84,
  'voronoi-glass': 1.07,
  'wormhole': 0.92,
};

export function motionGain(id: string): number {
  return GAIN[id] ?? 1;
}

/**
 * How fast a world's own clock runs (scales the dt it integrates with). Every music level is
 * normalized per song, so without this a lofi track moves like a riddim: the song's absolute
 * intensity sets the pace, and the world's measured gain evens worlds out. Kept within 0.45..1.5 so
 * beat eases never get sharp or sluggish.
 */
export function worldPace(id: string, intensity = 0.6): number {
  const song = 0.3 + 1.0 * intensity;
  return Math.min(1.5, Math.max(0.45, motionGain(id) * song));
}
