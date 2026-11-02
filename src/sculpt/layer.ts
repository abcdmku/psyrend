/**
 * A layer is one way of turning musical events into geometry. A composition is a layout
 * (where time/pitch live in space) + camera + background + a set of layers.
 *
 * WGSL contract (see docs/SCULPT.md):
 *  - define `fn vs_<ID>(vi: u32, ii: u32) -> LOut` and `fn fs_<ID>(in: LOut) -> vec4f`
 *    where <ID> is the layer id with '-' replaced by '_'. ii is the absolute index of the
 *    note / chord / hit (or particle) being drawn.
 *  - optional particles: define `fn sim_<ID>(i: u32, p: ptr<function, Particle>)`, which advances
 *    particle i by F.dt (spawning from events via the window `W` uniforms).
 *  - read events with notes[ii] / chords[ii] / hits[ii]; particles with pstate_<ID>[ii].
 */
export type LayerSource = 'notes' | 'chords' | 'hits' | 'once' | 'particles';

/**
 * What a layer does in a composition. A cue is one idea: a form (a generative system the music
 * steers), usually a world it lives in (ground, plus an enclosure or a sky), and sometimes one accent
 * from another role.
 * 'hero' is the literal note strokes: the fallback protagonist and an occasional accent.
 */
export type LayerRole = 'form' | 'hero' | 'world' | 'enclosure' | 'sky' | 'harmony' | 'rhythm' | 'particles' | 'fractal' | 'detail';
// Weight 0 keeps a layer out of auto-direction; it can still be forced with ?layers=.

export interface LayerDef {
  id: string;
  role: LayerRole;
  /** Large dark masses that read as holes on a light page: only on dark backgrounds. */
  darkOnly?: boolean;
  source: LayerSource;
  /** Vertices per instance. */
  verts: number;
  /** Opaque layers write depth; additive layers glow on top. */
  blend: 'opaque' | 'additive';
  /** Particle count when source = 'particles'. */
  particles?: number;
  /** Relative pick likelihood and how much it shapes recognisability. */
  weight: number;
  /** Roles of the composition it can't coexist with (e.g. two different landscapes). */
  excludes?: string[];
  /** Layouts it suits ('*' = all). */
  layouts: string[] | '*';
  /** Per-composition style switches: returns WGSL const declarations and a key for the recipe. */
  consts?: (rand: () => number) => { wgsl: string; key: string };
  wgsl: string;
}

export const wgslId = (id: string) => id.replace(/-/g, '_');
