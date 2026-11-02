import type { Section, SectionKind, TrackAnalysis } from '../audio/types';
import { BACKGROUNDS, LAYERS, LAYOUTS, layoutParams, recipeKey, type Composition, type Recipe } from './compose';
import type { LayerDef } from './layer';

import { JOURNEY_FLOATS, JOURNEY_RATE, JOURNEY_SLOTS } from './journeyConst';
const CAM_RIDE = 12;
const CAM_WING = 13;
const INTENSITY = 14;

/** What one place on the route holds. */
export interface Stop {
  start: number;
  end: number;
  kind: SectionKind;
  cluster: number;
  layers: string[];
  ride: number;
  wing: number;
}

export interface Journey {
  composition: Composition;
  stops: Stop[];
}

const pickW = <T extends { weight: number }>(rand: () => number, xs: T[]): T | undefined => {
  if (!xs.length) return undefined;
  let r = rand() * xs.reduce((s, x) => s + x.weight, 0);
  for (const x of xs) if ((r -= x.weight) <= 0) return x;
  return xs[xs.length - 1];
};
/** Up to n distinct weighted picks. */
const cast = (rand: () => number, xs: LayerDef[], n: number): LayerDef[] => {
  const pool = [...xs];
  const out: LayerDef[] = [];
  while (out.length < n && pool.length) {
    const l = pickW(rand, pool)!;
    pool.splice(pool.indexOf(l), 1);
    out.push(l);
  }
  return out;
};

/**
 * The whole song as one flight along the melodic gesture. Every section is a place on the route,
 * built from a cast chosen once per song:
 *  - each section has a protagonist form; the setting comes from its role in the song: a build flies
 *    into an enclosure, a peak bursts out under the sky, a breakdown settles over open water, and
 *    intro / outro are sparse;
 *  - a section that returns (same repetition cluster, e.g. every chorus) returns to the same place;
 *  - places begin exactly where their section begins: their presence is a track over song time,
 *    and the engine fades or cuts each layer at the time of each point in space, so the next place
 *    is seen approaching and entered on the downbeat.
 * The camera's character (chase / ride / wing) also follows the section, eased over bars.
 */
export function planJourney(rand: () => number, a: TrackAnalysis): Journey {
  const fits = (l: LayerDef) => l.weight > 0 && (l.layouts === '*' || l.layouts.includes('flight'));
  const of = (role: LayerDef['role'] | LayerDef['role'][]) => LAYERS.filter((l) => fits(l) && ([] as string[]).concat(role).includes(l.role));
  const forms = cast(rand, of('form'), 3);
  const grounds = cast(rand, of('world'), 1);
  const enclosures = cast(rand, of('enclosure'), 2);
  const skies = cast(rand, of('sky'), 1);
  const accents = cast(rand, of(['harmony', 'rhythm', 'particles', 'fractal', 'detail']), 3);
  // Every particle layer is a storage buffer; the score already uses five and the WebGPU baseline
  // allows eight per stage, so a journey casts at most three particle layers.
  let particleBudget = 3;
  const members = [...forms, ...grounds, ...enclosures, ...skies, ...accents]
    .filter((l) => l.source !== 'particles' || particleBudget-- > 0)
    .slice(0, JOURNEY_SLOTS);

  type Place = Omit<Stop, 'start' | 'end' | 'kind' | 'cluster'>;
  /** A place, and how it develops in the second half of a long section. */
  const places = new Map<number, { place: Place; dev: Place }>();
  let formTurn = Math.floor(rand() * Math.max(1, forms.length));
  const bar = (60 / a.bpm) * a.beatsPerBar;
  const stops: Stop[] = a.sections.flatMap((s: Section) => {
    let entry = places.get(s.cluster);
    if (!entry) {
      const k = s.kind;
      const layers: string[] = [];
      if (forms.length) layers.push(forms[formTurn++ % forms.length].id);
      const quiet = k === 'intro' || k === 'outro';
      if (grounds.length && rand() < (quiet ? 0.5 : 0.85)) layers.push(grounds[0].id);
      const enclosure = enclosures.length ? enclosures[Math.floor(rand() * enclosures.length)] : undefined;
      const sky = skies[0];
      const around =
        k === 'build' ? enclosure ?? sky
        : k === 'peak' ? sky ?? enclosure
        : k === 'breakdown' ? (rand() < 0.6 ? sky : undefined)
        : quiet ? (rand() < 0.4 ? sky : undefined)
        : rand() < 0.5 ? enclosure : sky;
      if (around) layers.push(around.id);
      const accentChance = k === 'peak' ? 0.6 : k === 'build' ? 0.4 : k === 'verse' ? 0.3 : 0.1;
      if (accents.length && rand() < accentChance) layers.push(accents[Math.floor(rand() * accents.length)].id);
      const place: Place = {
        layers,
        ride: k === 'peak' ? 0.7 : k === 'build' ? 0.3 : 0,
        wing: k === 'breakdown' || k === 'bridge' ? 0.6 : quiet ? 0.3 : 0,
      };
      // Development: the place opens up as the section goes on. An enclosure gives way to the sky
      // (or the sky arrives over the open ground), a new accent appears, and the camera leans in.
      const dev: Place = { ...place, layers: [...layers], ride: Math.min(0.8, place.ride + 0.3), wing: place.wing * 0.5 };
      if (around && around === enclosure && sky) dev.layers[dev.layers.indexOf(around.id)] = sky.id;
      else if (!around && sky && !quiet) dev.layers.push(sky.id);
      else if (around === sky && enclosure) dev.layers[dev.layers.indexOf(sky.id)] = enclosure.id;
      const fresh = accents.filter((x) => !layers.includes(x.id));
      if (fresh.length && !quiet && dev.layers.length < 4) dev.layers.push(fresh[Math.floor(rand() * fresh.length)].id);
      entry = { place, dev };
      places.set(s.cluster, entry);
    }
    const base = { kind: s.kind, cluster: s.cluster };
    // Long sections develop at the downbeat nearest their middle.
    if (s.end - s.start < bar * 12) return [{ start: s.start, end: s.end, ...base, ...entry.place }];
    const mid = a.downbeats.reduce((b, d) => (Math.abs(d - (s.start + s.end) / 2) < Math.abs(b - (s.start + s.end) / 2) ? d : b), (s.start + s.end) / 2);
    return [
      { start: s.start, end: mid, ...base, ...entry.place },
      { start: mid, end: s.end, ...base, ...entry.dev },
    ];
  });

  // Presence and camera tracks: steps at section starts, softened over about a bar.
  const rows = Math.max(2, Math.ceil(a.duration * JOURNEY_RATE) + 2);
  const raw = new Float32Array(rows * JOURNEY_FLOATS);
  for (let r = 0; r < rows; r++) {
    const t = r / JOURNEY_RATE;
    const st = stops.find((x) => t >= x.start && t < x.end) ?? stops[stops.length - 1];
    if (!st) continue;
    const o = r * JOURNEY_FLOATS;
    members.forEach((l, i) => (raw[o + i] = st.layers.includes(l.id) ? 1 : 0));
    raw[o + CAM_RIDE] = st.ride;
    raw[o + CAM_WING] = st.wing;
    raw[o + INTENSITY] = a.sections.find((x) => t >= x.start && t < x.end)?.energy ?? 0;
  }
  const track = new Float32Array(rows * JOURNEY_FLOATS);
  const blur = (ch: number, width: number) => {
    const h = Math.max(1, Math.round((width * JOURNEY_RATE) / 2));
    for (let r = 0; r < rows; r++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, r - h); k <= Math.min(rows - 1, r + h); k++, n++) s += raw[k * JOURNEY_FLOATS + ch];
      track[r * JOURNEY_FLOATS + ch] = s / n;
    }
  };
  for (let i = 0; i < JOURNEY_SLOTS; i++) blur(i, bar);
  blur(CAM_RIDE, bar * 2);
  blur(CAM_WING, bar * 2);
  blur(INTENSITY, bar * 2);

  const flight = LAYOUTS.find((l) => l.id === 'flight')!;
  const dark = BACKGROUNDS.map((b) => b.id).filter((id) => id !== 'paper' && id !== 'vellum');
  const background = dark[Math.floor(rand() * dark.length)];
  const material: Recipe['material'] = rand() < 0.6 ? 'satin' : 'glass';
  const constParts = members.map((l) => ({ l, c: l.consts?.(rand) }));
  const recipe: Recipe = {
    layout: 'flight',
    camera: 'flight-journey',
    background,
    material,
    layers: constParts.map(({ l, c }) => (c ? `${l.id}:${c.key}` : l.id)).sort(),
  };
  const seed = Math.floor(rand() * 1e9).toString(36);
  const composition: Composition = {
    id: `sculpt:journey-${seed}/${recipeKey(recipe)}`,
    recipe,
    params: layoutParams(rand, flight, a, true),
    consts: constParts.map(({ c }) => c?.wgsl ?? '').join('\n'),
    layerOrder: members.map((l) => l.id),
    journey: track,
  };
  return { composition, stops };
}
