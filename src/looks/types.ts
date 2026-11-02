import type { MusicState } from '../audio/musicState';
import type { GenreId } from '../audio/types';
import { defineLayout } from '../gpu/layout';

/** Uniforms every look shader sees as `L`. */
export const LOOK_LAYOUT = defineLayout([
  ['res', 'vec2f'],
  ['amount', 'f32'],
  ['time', 'f32'],
  ['beat', 'f32'],
  ['kick', 'f32'],
  ['snare', 'f32'],
  ['hat', 'f32'],
  ['energy', 'f32'],
  ['bass', 'f32'],
  ['high', 'f32'],
  ['anticipation', 'f32'],
  ['dropPulse', 'f32'],
  ['beatPhase', 'f32'],
  ['spin', 'f32'],
  ['travel', 'f32'],
  ['dna', 'vec4f'],
  ['pal0', 'vec4f'],
  ['pal1', 'vec4f'],
  ['pal2', 'vec4f'],
  ['pal3', 'vec4f'],
  ['p', { array: 'vec4f', length: 4 }],
] as const);

export interface LookMeta {
  id: string;
  name: string;
  /** Relative pick likelihood (0..1); subtle looks can be higher, extreme ones lower. */
  weight: number;
  /** Section-energy range where the look fits. */
  energy: readonly [number, number];
  /** Optional genre affinity 0..1 (unlisted = 0.5). */
  genres?: Partial<Record<GenreId, number>>;
  /**
   * Re-composes the frame (tilings, spirals, mosaics, lens remaps). Kept off naturalistic scenes
   * (`kaleido: false`), whose point is a believable world.
   */
  remaps?: boolean;
  /** Strength range the director picks from (0..1, mixed over the clean image). */
  amount: readonly [number, number];
  /**
   * Part of the overlay library the journey layers (sparingly) over single and fused worlds. Only
   * looks that make clean variants (smooth, no beat-pulsing, nothing that reads as a gimmick)
   * set this; the rest stay available for pinning only.
   */
  overlay?: boolean;
}

export interface LookContext {
  music: MusicState;
  /** Four look genes in [0,1), fixed for the cue. */
  dna: readonly number[];
  time: number;
  dt: number;
}

export interface LookFactory {
  meta: LookMeta;
  /**
   * WGSL defining `fn look(uv: vec2f, frag: vec2f) -> vec3f` returning linear HDR colour.
   * Read the image with `src(uv)` (clamped) or `srcMirror(uv)` (mirror-repeat for tiling).
   * The result is mixed over the clean image by `L.amount`.
   */
  wgsl: string;
  /** Fill `p` (16 floats = L.p[0..3]) each frame. */
  params?(ctx: LookContext, p: Float32Array): void;
}

export function defineLook(f: LookFactory): LookFactory {
  return f;
}
