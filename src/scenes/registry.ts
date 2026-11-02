import type { SceneFactory } from './types';

/**
 * Every module in ./library default-exports one scene; they're discovered at build time
 * so scenes can be added without touching shared files.
 */
const modules = import.meta.glob<{ default: SceneFactory }>('./library/*.ts', { eager: true });

/** Picker / number-key order. Unlisted scenes follow alphabetically. */
const ORDER = [
  'fractal-cathedral',
  'attractor-swarm',
  'gyroid-tunnel',
  'mandelbulb-bloom',
  'chrome-blob',
  'spectral-terrain',
  'aurora-volume',
  'curl-nebula',
  'plasma-inferno',
  'hyper-lattice',
  'coral-growth',
  'kaleido-temple',
];

export const SCENES: SceneFactory[] = Object.values(modules)
  .map((m) => m.default)
  .filter((f): f is SceneFactory => !!f?.meta)
  .sort((a, b) => {
    const ia = ORDER.indexOf(a.meta.id);
    const ib = ORDER.indexOf(b.meta.id);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.meta.name.localeCompare(b.meta.name);
  });
