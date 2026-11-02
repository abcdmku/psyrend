import type { Block, LayoutBlock } from '../blocks';

/**
 * Tonnetz: harmony as a neighbourhood. Pitch classes sit on Euler's tone lattice (a fifth to one
 * side, a major third at 60 degrees to it, so a minor third closes each triangle): every major or
 * minor triad is a small triangle of neighbouring nodes, and harmonically close notes are close in
 * space. The lattice is infinite and centred on the chord sounding now: every other chord in view sits
 * where its root lies from the present one (dominant one step right, subdominant one step left,
 * relative minor up-left), so a progression steps across the plane and the lattice re-centres with
 * each change. Register nudges a note off its node toward "north"
 * (higher octaves further), so octave doublings stand side by side.
 *
 * Time is height: the future hangs above the lattice and rains down onto it. Every note is a vertical
 * column that lands on the floor (the playhead) as it sounds; the past sinks below and fades.
 *
 * S.p[4]: x = node spacing, y = camera azimuth (radians).
 */
const layout: LayoutBlock = {
  id: 'tonnetz',
  kind: 'flow',
  weight: 0.2,
  cameras: ['tonnetz-oblique', 'tonnetz-high'],
  wgsl: /* wgsl */ `
fn tz_space() -> f32 { return 0.9 + clamp(S.p[4].x, 0.4, 2.6) * 0.45; }
/** Lattice coords -> plane (fifths along x, major thirds at 60 degrees). */
fn tz_pos(ij: vec2f) -> vec2f { return vec2f(ij.x + 0.5 * ij.y, 0.8660254 * ij.y); }
/** Shortest Tonnetz step (i fifths, j major thirds) for an interval. Of the tied choices these keep
 * every common tone on its node when a diatonic chord moves to another. */
fn tz_step(iv: f32) -> vec2f {
  var tb = array<vec2f, 12>(
    vec2f(0.0, 0.0), vec2f(-1.0, 2.0), vec2f(-2.0, 1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0), vec2f(-1.0, 0.0),
    vec2f(2.0, -2.0), vec2f(1.0, 0.0), vec2f(0.0, -1.0), vec2f(-1.0, 1.0), vec2f(2.0, -1.0), vec2f(1.0, -2.0));
  return tb[u32(fmod(floor(iv + 0.5), 12.0)) % 12u];
}
/**
 * The harmony's root node at t, in lattice coords relative to the root sounding now (so nothing
 * drifts: every chord in view sits within a step or two of the present one), and its pitch class
 * (z = -1 when the song has no harmony yet). When the chord changes, the whole lattice morphs over
 * 0.35 s from being centred on the previous root to the new one.
 */
fn tz_frame(t: f32) -> vec3f {
  let first = i32(W.n.z);
  let last = min(first + i32(W.n.w), first + 64);
  var atT = -1.0;
  var firstV = -1.0;
  var now = -1.0;
  var before = -1.0;
  var nowStart = -1e9;
  for (var i = max(first - 1, 0); i < last; i++) {
    let c = chords[i];
    if (c.root < 0.0) { continue; }
    if (firstV < 0.0) { firstV = c.root; }
    if (c.start <= t) { atT = c.root; }
    if (c.start <= F.songTime) { before = select(c.root, now, now >= 0.0); now = c.root; nowStart = c.start; }
  }
  if (atT < 0.0) { atT = firstV; }
  if (atT < 0.0) { return vec3f(0.0, 0.0, -1.0); }
  if (now < 0.0) { now = firstV; before = firstV; }
  let k = smoothstep(0.0, 0.35, F.songTime - nowStart);
  return vec3f(mix(tz_step(atT - before), tz_step(atT - now), k), atT);
}
/** Height of a moment: linear near now, the far future compressed under a ceiling of 4 node spacings. */
fn tz_h(t: f32) -> f32 {
  let y = (t - F.songTime) * S.p[0].x * 0.24 * tz_space();
  let top = tz_space() * 4.0;
  return select(y, top * tanh(y / top), y > 0.0);
}
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  let fr = tz_frame(t);
  // With no harmony, pitch classes sit around the song's central lead pitch class.
  let root = select(floor(S.p[0].z + 4.5), fr.z, fr.z >= 0.0);
  let node = fr.xy + tz_step(pitch - root);
  let reg = clamp((pitch - S.p[0].z) * 0.018, -0.36, 0.36) + lane * 0.05;
  let xy = (tz_pos(node) + vec2f(0.0, reg)) * tz_space();
  return vec3f(xy.x, tz_h(t), xy.y);
}
/** The time axis is the column of the chord sounding now (it glides with each change). */
fn LCenter(t: f32) -> vec3f { let xy = tz_pos(tz_frame(F.songTime).xy) * tz_space(); return vec3f(xy.x, tz_h(t), xy.y); }
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
};

const cameras: Record<string, Block> = {
  // Low three-quarter view: the floor (now) in the lower third, the future raining from above.
  'tonnetz-oblique': {
    id: 'tonnetz-oblique',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f {
  let s = tz_space();
  let a = F.spin * 0.04 + S.p[2].w + S.p[4].y;
  let d = s * (4.6 + S.p[2].y * 0.6);
  return vec3f(sin(a) * d, s * (1.6 + S.p[2].x * 0.3), cos(a) * d);
}
fn camTarget() -> vec3f { return vec3f(0.0, tz_space() * 1.25, 0.0); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  // Steep view from above the future's ceiling: the lattice reads as a map, the columns still have length.
  'tonnetz-high': {
    id: 'tonnetz-high',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f {
  let s = tz_space();
  let a = F.spin * 0.03 + S.p[2].w + S.p[4].y;
  let d = s * (2.8 + S.p[2].y * 0.3);
  return vec3f(sin(a) * d, s * (4.4 + S.p[2].x * 0.15), cos(a) * d);
}
fn camTarget() -> vec3f { return vec3f(0.0, tz_space() * 0.5, 0.0); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
};

export default { layout, cameras };
