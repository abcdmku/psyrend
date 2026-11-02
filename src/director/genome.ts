import { recipeSimilarity, type Composition, type Recipe } from '../sculpt/compose';

/**
 * A genome is everything that makes one cue look the way it does: the world (scene),
 * eight continuous DNA genes the scene maps onto its own parameter space, a post "look",
 * a palette scheme, and feedback/kaleidoscope styling. Scenes x DNA x looks x palettes
 * gives thousands of distinct visuals; the novelty memory keeps them from repeating.
 */
export const DNA_GENES = 8;

export interface CueStyle {
  /** Trail half-life in seconds for a scene with trails = 1; scaled per displayed scene. */
  trailHalfLife: number;
  kaleido: number;
  kaleidoMix: number;
  hueDrift: number;
  zoomRate: number;
  rotateRate: number;
  grain: number;
  saturation: number;
  hueOffset: number;
}

export interface Genome {
  sceneId: string;
  dna: number[];
  /** Look id, or null for a clean image. */
  lookId: string | null;
  lookAmount: number;
  lookDna: number[];
  paletteScheme: number;
  style: CueStyle;
  /** Set for composed (generated) visuals. */
  composition?: Composition;
  /** A partner world fused with this one for the whole cue (see FUSE_WGSL in gpu/post.ts). */
  fuse?: Fuse;
  /**
   * A development at the cue's 4-bar point: the fusion changes (new partner or mode, added or
   * removed) and the palette scheme moves on, both blended over about a bar.
   */
  develop?: { at: number; fuse: Fuse | null; paletteScheme: number };
}

/** A second world held together with the cue's world as one picture. */
export interface Fuse {
  sceneId: string;
  dna: number[];
  /** 0 fold, 1 relief, 2 interference, 3 merge (see FUSE_WGSL in gpu/post.ts). */
  mode: number;
  /** 0..1 strength of the partner. */
  amount: number;
}

export const FUSE_MODES = 4;

/** What's remembered about a shown genome. */
export interface GenomeTrace {
  sceneId: string;
  dna: number[];
  lookId: string | null;
  paletteScheme: number;
  kaleido: number;
  recipe?: Recipe;
}

export function trace(g: Genome): GenomeTrace {
  return { sceneId: g.sceneId, dna: g.dna.slice(0, DNA_GENES), lookId: g.lookId, paletteScheme: g.paletteScheme, kaleido: g.style.kaleido, recipe: g.composition?.recipe };
}

/**
 * How recognisably alike two genomes are, 0..1. Same world with nearby DNA dominates;
 * a matching look, palette or kaleidoscope pushes it further toward "seen it". Composed visuals
 * compare by structure: the same carrier and mapping is the same core, whatever the colours.
 */
export function similarity(a: GenomeTrace, b: GenomeTrace): number {
  if (a.recipe && b.recipe) return recipeSimilarity(a.recipe, b.recipe);
  if (a.recipe || b.recipe) return 0;
  let s = 0;
  if (a.sceneId === b.sceneId) {
    let d = 0;
    for (let i = 0; i < DNA_GENES; i++) {
      const x = Math.abs((a.dna[i] ?? 0) - (b.dna[i] ?? 0));
      d += Math.min(x, 1 - x) * 2; // genes are treated as circular
    }
    d /= DNA_GENES; // ~0.5 for unrelated DNA
    s += 0.55 + 0.25 * Math.max(0, 1 - d * 2.2);
  }
  if (a.lookId === b.lookId) s += a.lookId ? 0.12 : 0.04;
  if (a.paletteScheme === b.paletteScheme) s += 0.05;
  if (a.kaleido === b.kaleido && a.kaleido > 0) s += 0.04;
  return Math.min(1, s);
}
