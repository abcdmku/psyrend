import type { Block, LayoutBlock } from '../blocks';

/**
 * Staircase: the metre made architectural. Time climbs a spiral staircase where every bar is one
 * flat step (downbeat-aligned, with the riser in the bar's last sixteenth), and one revolution is a
 * phrase of 6 or 8 bars. Pitch runs across the tread, low notes at the inner rail and high notes at
 * the outer edge; roles sit at slightly different heights on it. Because a phrase is exactly one
 * turn, the same bar of the next phrase lands directly above this one: repetition stacks into
 * columns and variation shows as a break in the stack.
 *
 * S.p[4]: y = rotation of the stair (radians), z = bars per turn / 2 - 1 (2 -> 6 bars, 3 -> 8).
 */
const layout: LayoutBlock = {
  id: 'staircase',
  kind: 'travel',
  weight: 0.2,
  cameras: ['staircase-chase', 'staircase-front'],
  wgsl: /* wgsl */ `
fn st_barLen() -> f32 { return 240.0 / clamp(F.bpm, 50.0, 220.0); }
/** Bars on an absolute downbeat-aligned grid, so geometry stays fixed in song time. */
fn st_bars(t: f32) -> f32 {
  let bl = st_barLen();
  let a = F.songTime - F.barPhase * bl;
  return (t - (a - bl * round(a / bl))) / bl;
}
fn st_n() -> f32 { return clamp(round(S.p[4].z) * 2.0 + 2.0, 4.0, 12.0); }
/** Radius of the stair's walking line: a bar spans about speed x bar length of arc. */
fn st_R() -> f32 { return clamp(S.p[0].x * st_barLen() * st_n() / TAU * 0.8, 3.0, 6.5); }
fn st_rise() -> f32 { return st_R() * 0.28; }
fn st_ang(u: f32) -> f32 { return TAU * u / st_n() + S.p[4].y; }
fn st_y(u: f32) -> f32 { return st_rise() * (floor(u) + smoothstep(0.94, 1.0, fract(u))); }
/** The stair's height without steps, for cameras that should climb smoothly. */
fn st_ySmooth(u: f32) -> f32 { return st_rise() * (u - 0.5); }
fn st_at(a: f32, r: f32, y: f32) -> vec3f { return vec3f(cos(a) * r, y, sin(a) * r); }
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  let u = st_bars(t);
  let R = st_R();
  let r = R + clamp((pitch - S.p[0].z) * S.p[0].y * 0.45, -0.4 * R, 0.6 * R);
  return st_at(st_ang(u), r, st_y(u) + lane * S.p[0].w * 0.3);
}
fn LCenter(t: f32) -> vec3f { let u = st_bars(t); return st_at(st_ang(u), st_R(), st_y(u)); }
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
};

const cameras: Record<string, Block> = {
  // Outside and above the stair, level with the playhead's step: the whole turn and the one above in view.
  'staircase-chase': {
    id: 'staircase-chase',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f {
  let u = st_bars(F.songTime);
  let R = st_R();
  return st_at(st_ang(u) - 0.25 - S.p[2].w * 0.2, R * (2.7 + S.p[2].y * 0.25), st_ySmooth(u) + R * (1.25 + S.p[2].x * 0.06));
}
fn camTarget() -> vec3f { let u = st_bars(F.songTime); let R = st_R(); return st_at(st_ang(u) + 0.45, R * 0.35, st_ySmooth(u) + R * 0.25); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  // Outside, a quarter turn ahead, looking back down the steps: the coming bars climb toward you.
  'staircase-front': {
    id: 'staircase-front',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f { let u = st_bars(F.songTime); let R = st_R(); return st_at(st_ang(u) + 1.1 + S.p[2].w * 0.15, R * (2.5 + S.p[2].y * 0.2), st_ySmooth(u) + R * (0.95 + S.p[2].x * 0.05)); }
fn camTarget() -> vec3f { let u = st_bars(F.songTime); let R = st_R(); return st_at(st_ang(u) + 0.05, R * 0.6, st_ySmooth(u) + R * 0.2); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
};

export default { layout, cameras };
