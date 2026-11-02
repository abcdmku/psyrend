import type { MusicState } from '../audio/musicState';
import type { GenreId } from '../audio/types';
import type { SharedResources } from '../gpu/resources';

export interface SceneMeta {
  id: string;
  name: string;
  /** Normalized section-energy range this scene suits best. */
  energy: readonly [number, number];
  /** Preferred valence/arousal centre (0..1). */
  mood: { valence: number; arousal: number };
  /** Genre affinity 0..1; unlisted genres count as 0.2. */
  genres: Partial<Record<GenreId, number>>;
  /** Default amount of feedback trails the director should use with this scene (0..1). */
  trails?: number;
  /** Mostly light on black (particles, lines): feedback trails use a lighten blend instead of an echo. */
  sparse?: boolean;
  /** Set false for naturalistic scenes that the director's kaleidoscope post effect would ruin. */
  kaleido?: boolean;
  /** false: never chosen by auto-direction (fails the quality bar); still available when pinned. */
  auto?: boolean;
  /**
   * How the world reads: '2d' (a flat full-frame field or pattern) or '3d' (depth: space, tunnels,
   * volumes, perspective). Fusion only pairs worlds of the same kind; mixing them looks disjointed.
   */
  dim?: '2d' | '3d';
}

/** Director-owned values a scene can use while computing its parameters. */
export interface SceneUpdateContext {
  music: MusicState;
  time: number;
  /**
   * Seconds since the last frame on this world's own clock: real time scaled by the world's pace
   * (the song's absolute intensity times the world's motion calibration, see motionGain.ts). Integrate
   * all motion with it.
   */
  dt: number;
  /**
   * This world's own paced clock in seconds (the integral of dt). Use it, not music.time, for any
   * free-running drift, rotation or flow; keep music.time only for timing against musical events.
   */
  clock: number;
  /** Cue variation seed in [0,1); equal to dna[0]. */
  variant: number;
  /**
   * Eight genes in [0,1), fixed for the cue (chosen to be unlike anything shown in the last
   * 30 minutes). Map them onto as much of the scene's parameter space as possible.
   */
  dna: readonly number[];
  /** Four slowly wandering values in [0,1] (periods ~45-115 s) for continuous evolution. */
  evolve: readonly number[];
  /** Smoothed overall intensity 0..1 from the director. */
  intensity: number;
  /** Integrated, audio-driven forward motion (monotonic). */
  travel: number;
  /** Integrated rotation phase (monotonic). */
  spin: number;
}

export interface SceneInstance {
  readonly meta: SceneMeta;
  update(ctx: SceneUpdateContext): void;
  /** Renders into an HDR target (rgba16float), clearing it. */
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void;
  destroy(): void;
}

export interface SceneFactory {
  meta: SceneMeta;
  create(device: GPUDevice, shared: SharedResources): Promise<SceneInstance>;
}
