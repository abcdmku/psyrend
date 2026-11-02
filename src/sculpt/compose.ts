import type { Section, TrackAnalysis } from '../audio/types';
import type { SceneFactory, SceneMeta } from '../scenes/types';
import { BACKGROUNDS as BUILTIN_BACKGROUNDS, CAMERAS as BUILTIN_CAMERAS, LAYOUTS as BUILTIN_LAYOUTS, type Block, type LayoutBlock } from './blocks';

/**
 * Layouts (with their cameras) and backgrounds are also discovered from folders so they can be
 * added without editing shared files: ./layouts/*.ts default-export { layout, cameras },
 * ./backgrounds/*.ts default-export a Block.
 */
const LAYOUT_MODULES = import.meta.glob<{ default: { layout: LayoutBlock; cameras: Record<string, Block> } }>('./layouts/*.ts', { eager: true });
const BG_MODULES = import.meta.glob<{ default: Block }>('./backgrounds/*.ts', { eager: true });
export const LAYOUTS: LayoutBlock[] = [...BUILTIN_LAYOUTS, ...Object.values(LAYOUT_MODULES).map((m) => m.default.layout)];
export const CAMERAS: Record<string, Block> = Object.assign({}, BUILTIN_CAMERAS, ...Object.values(LAYOUT_MODULES).map((m) => m.default.cameras));
export const BACKGROUNDS: Block[] = [...BUILTIN_BACKGROUNDS, ...Object.values(BG_MODULES).map((m) => m.default)];

/** Debug/testing: force parts of every composition (set from URL params). */
export const forced: { layout?: string; layers?: string[]; camera?: string; background?: string; material?: Recipe['material'] } = {};
import type { LayerDef } from './layer';
import { sculptScene } from './sculptScene';

/** Every module in ./layers default-exports one layer (discovered at build time). */
const LAYER_MODULES = import.meta.glob<{ default: LayerDef }>('./layers/*.ts', { eager: true });
export const LAYERS: LayerDef[] = Object.values(LAYER_MODULES)
  .map((m) => m.default)
  .filter((l): l is LayerDef => !!l?.id)
  .sort((a, b) => a.id.localeCompare(b.id));

/** Structural choices of a composed visual: what the novelty memory compares. */
export interface Recipe {
  layout: string;
  camera: string;
  background: string;
  material: 'glass' | 'satin' | 'chrome' | 'ink';
  /** Layer ids, each with its style key (e.g. "notes:tube-ribbon-line"). Sorted. */
  layers: string[];
}

export interface Composition {
  id: string;
  recipe: Recipe;
  /** 32 per-cue uniforms (S.p[0..7]). */
  params: number[];
  /** Per-layer WGSL consts chosen for this composition. */
  consts: string;
  /** Layer ids in slot order (journeys: slot i reads presence channel i). */
  layerOrder?: string[];
  /** Journey presence track (see journey.ts); absent for single-cue compositions. */
  journey?: Float32Array<ArrayBuffer>;
}

export const recipeKey = (r: Recipe) => [r.layout, r.camera, r.background, r.material, ...r.layers].join('/');

/** 0..1 structural similarity. Layout dominates; layer sets compare by overlap. */
export function recipeSimilarity(a: Recipe, b: Recipe): number {
  let s = 0;
  if (a.layout === b.layout) s += 0.3;
  if (a.camera === b.camera) s += 0.08;
  if (a.background === b.background) s += 0.06;
  if (a.material === b.material) s += 0.1;
  const la = new Set(a.layers);
  const lb = new Set(b.layers);
  const inter = [...la].filter((x) => lb.has(x)).length;
  const union = new Set([...la, ...lb]).size || 1;
  return s + 0.46 * (inter / union);
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length) % xs.length];
const pickWeighted = <T>(rand: () => number, xs: readonly T[], w: (x: T) => number): T => {
  let r = rand() * xs.reduce((s, x) => s + w(x), 0);
  for (const x of xs) if ((r -= w(x)) <= 0) return x;
  return xs[xs.length - 1];
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Chooses which layers express this section: one idea, kept readable. A form (a generative system the
 * music steers) is the protagonist; most cues give it a world to live in, and some add one accent
 * from another role. The literal note strokes are only an occasional accent: the music should shape
 * the image, not be read off it. Without any form for the layout, the notes carry the cue.
 */
function chooseLayers(rand: () => number, layout: string, background: string, calm: boolean): LayerDef[] {
  const light = background === 'paper' || background === 'vellum';
  const fits = (l: LayerDef) => (l.layouts === '*' || l.layouts.includes(layout)) && !(light && l.darkOnly);
  const chosen: LayerDef[] = [];
  const clash = (l: LayerDef) => chosen.some((c) => c === l || c.role === l.role || c.excludes?.includes(l.id) || l.excludes?.includes(c.id));
  const forms = LAYERS.filter((l) => l.role === 'form' && l.weight > 0 && fits(l));
  chosen.push(forms.length ? pickWeighted(rand, forms, (l) => l.weight) : LAYERS.find((l) => l.id === 'notes')!);
  const worlds = LAYERS.filter((l) => l.role === 'world' && l.weight > 0 && fits(l));
  // Layouts with a score surface almost always show it: it surrounds the camera with the music.
  const hasSurface = LAYOUTS.find((l) => l.id === layout)?.surface !== undefined;
  if (worlds.length && rand() < (hasSurface ? 0.85 : 0.5)) chosen.push(pickWeighted(rand, worlds, (l) => l.weight));
  // A space around the form, never a void: an enclosure the camera flies through, or a sky above.
  const around = LAYERS.filter((l) => (l.role === 'enclosure' || l.role === 'sky') && l.weight > 0 && fits(l));
  if (around.length && rand() < 0.75) chosen.push(pickWeighted(rand, around, (l) => l.weight));
  const accents = rand() < (calm ? 0.15 : 0.3) ? 1 : 0;
  for (let i = 0; i < accents; i++) {
    const pool = LAYERS.filter((l) => !['world', 'enclosure', 'sky', 'form'].includes(l.role) && l.weight > 0 && fits(l) && !clash(l));
    if (!pool.length) break;
    chosen.push(pickWeighted(rand, pool, (l) => l.weight));
  }
  return chosen;
}

/** Composes one sculpture for a section, steering by its energy and character. */
export function composeOne(rand: () => number, s: Section, a: TrackAnalysis | null): Composition {
  const energetic = s.energy > 0.55 || s.kind === 'peak' || s.kind === 'build';
  const calm = s.energy < 0.35 || s.kind === 'breakdown' || s.kind === 'intro' || s.kind === 'outro';
  // Energetic music travels; otherwise the layout weights favour immersive travel layouts anyway.
  const pool = LAYOUTS.filter((l) => !energetic || l.kind === 'travel' || rand() < 0.3);
  const layout = (forced.layout && LAYOUTS.find((l) => l.id === forced.layout)) || pickWeighted(rand, pool.length ? pool : LAYOUTS, (l) => l.weight ?? 1);
  // A score surface surrounds the camera; on a light page it would print as a dark wall, so
  // immersive layouts keep to dark spaces.
  const light = ['paper', 'vellum'];
  const bgs = BACKGROUNDS.map((b) => b.id).filter((id) => layout.surface === undefined || !light.includes(id));
  const background = forced.background ?? pick(rand, [...bgs, 'deep', 'horizon']);
  const layers = forced.layers ? LAYERS.filter((l) => forced.layers!.includes(l.id)) : chooseLayers(rand, layout.id, background, calm);
  // Chrome suits strokes, but a whole world in chrome mirrors itself into grey mud.
  const hasWorld = layers.some((l) => l.role === 'world');
  const material: Recipe['material'] =
    forced.material ??
    (light.includes(background) ? pick(rand, ['ink', 'ink', 'satin'] as const) : pick(rand, hasWorld ? (['glass', 'glass', 'satin'] as const) : (['glass', 'glass', 'satin', 'chrome'] as const)));
  const constParts = layers.map((l) => ({ l, c: l.consts?.(rand) }));
  const recipe: Recipe = {
    layout: layout.id,
    camera: forced.camera && layout.cameras.includes(forced.camera) ? forced.camera : pick(rand, layout.cameras),
    background,
    material,
    layers: constParts.map(({ l, c }) => (c ? `${l.id}:${c.key}` : l.id)).sort(),
  };

  const p = layoutParams(rand, layout, a, energetic);
  return {
    id: `sculpt:${recipeKey(recipe)}`,
    recipe,
    params: p,
    consts: constParts.map(({ c }) => c?.wgsl ?? '').join('\n'),
  };
}

/** Per-composition uniforms (S.p[0..7]) for a layout, tuned to the song. */
export function layoutParams(rand: () => number, layout: LayoutBlock, a: TrackAnalysis | null, energetic: boolean): number[] {
  const leads = a?.notes.filter((n) => n.role === 'lead').map((n) => n.pitch).sort((x, y) => x - y) ?? [];
  const pitchCenter = leads.length ? leads[Math.floor(leads.length / 2)] - 4 : 58;
  const tempo = Math.sqrt((a?.bpm ?? 120) / 120);
  const flow = layout.kind === 'flow';
  const p = new Array(32).fill(0);
  // [0] speed, pitchScale, pitchCenter, laneGap
  p[0] =
    layout.id === 'tonnetz' || layout.id === 'fountain'
      ? lerp(2.4, 4, rand())
      : layout.id === 'spiral' ? lerp(1.6, 3, rand()) : layout.id === 'converge' ? lerp(2, 3.6, rand()) : layout.id === 'helix' ? lerp(2, 3.4, rand()) * tempo : lerp(2.6, 4.4, rand()) * tempo;
  p[1] = layout.id === 'spiral' ? lerp(0.12, 0.2, rand()) : layout.id === 'knot' ? lerp(0.15, 0.3, rand()) : lerp(0.12, 0.22, rand());
  p[2] = pitchCenter;
  p[3] = flow ? lerp(0.25, 0.5, rand()) : lerp(0.6, 1.2, rand());
  // [1] pastSec, futureSec, leadRadius, bassRadius
  p[4] = layout.id === 'fountain' ? lerp(2, 3, rand()) : lerp(1.6, 3, rand());
  p[5] = flow ? lerp(5, 8, rand()) : lerp(9, 14, rand());
  p[6] = flow ? lerp(0.02, 0.04, rand()) : lerp(0.035, 0.06, rand());
  p[7] = flow ? lerp(0.03, 0.06, rand()) : lerp(0.06, 0.12, rand());
  // [2] camera a, b, c, d
  p[8] = lerp(2.4, 4, rand());
  p[9] = lerp(0.5, 1.6, rand());
  p[10] = lerp(5, 9, rand());
  p[11] = (rand() - 0.5) * 1.2;
  // [3] hueOffset, glow, fog, surfaceAmp
  p[12] = rand();
  p[13] = lerp(1.0, 1.8, rand()) * (energetic ? 1.15 : 0.9);
  p[14] = flow ? lerp(0.006, 0.02, rand()) : lerp(0.012, 0.035, rand());
  p[15] = lerp(0.4, 0.9, rand());
  // [4] layout parameters
  const kn = pick(rand, [
    [2, 3],
    [3, 2],
    [2, 5],
    [3, 5],
    [3, 4],
  ] as const);
  p[16] = layout.id === 'helix' ? lerp(1.1, 1.9, rand()) : layout.id === 'spiral' ? lerp(3, 4.6, rand()) : layout.id === 'converge' ? lerp(1.4, 2.4, rand()) : layout.id === 'knot' ? lerp(1.5, 2.4, rand()) : lerp(0.6, 2.2, rand());
  // Helix: the melody runs along the tunnel's floor or its ceiling and climbs the wall as it rises.
  p[17] =
    layout.id === 'spiral'
      ? lerp(0.3, 0.8, rand()) * (rand() < 0.5 ? -1 : 1)
      : layout.id === 'helix'
        ? (rand() < 0.5 ? -0.5 : 0.5) * Math.PI - 0.4 + (rand() - 0.5) * 0.6
        : rand() * Math.PI * 2;
  p[18] = kn[0];
  p[19] = kn[1];
  // [6] ringRadius, ringWidth, rippleSpeed, lineWidth
  // Flow layouts sit closer to the camera, so drum rings stay smaller there.
  p[24] = flow ? lerp(0.35, 0.7, rand()) : lerp(1.0, 1.8, rand());
  p[25] = flow ? lerp(0.008, 0.02, rand()) : lerp(0.015, 0.04, rand());
  p[26] = lerp(0.8, 2.4, rand());
  p[27] = lerp(0.0012, 0.0026, rand());
  // [7] fov, particle size, particle speed, free
  p[28] = lerp(0.85, 1.15, rand());
  p[29] = flow ? lerp(0.006, 0.014, rand()) : lerp(0.012, 0.03, rand());
  p[30] = lerp(0.6, 1.6, rand());
  return p;
}

const factoryCache = new Map<string, SceneFactory>();

export function compositionFactory(c: Composition): SceneFactory {
  const hit = factoryCache.get(c.id);
  if (hit) return hit;
  const r = c.recipe;
  const meta: SceneMeta = { id: c.id, name: `${r.layout} · ${r.layers.length} layers · ${r.material}`, energy: [0, 1], mood: { valence: 0.5, arousal: 0.5 }, genres: {}, trails: 0.2 };
  const layout = LAYOUTS.find((l) => l.id === r.layout)!;
  const layerIds = new Set(r.layers.map((x) => x.split(':')[0]));
  const material = `const MATERIAL: u32 = ${{ glass: 0, satin: 1, chrome: 2, ink: 3 }[r.material]}u;\nconst SURFACE_LANE: f32 = ${(layout.surface ?? -1.7).toFixed(2)};`;
  const f = sculptScene({
    meta,
    blocksWgsl: `${material}\n${c.consts}\n${layout.wgsl}\n${CAMERAS[r.camera].wgsl}\n${BACKGROUNDS.find((b) => b.id === r.background)!.wgsl}`,
    layers: c.layerOrder ? c.layerOrder.map((id) => LAYERS.find((l) => l.id === id)!) : LAYERS.filter((l) => layerIds.has(l.id)),
    journey: c.journey,
  });
  factoryCache.set(c.id, f);
  return f;
}
