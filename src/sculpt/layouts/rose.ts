import type { Block, LayoutBlock } from '../blocks';

/**
 * Rose: every bar is a petal and every phrase a flower. Time runs around a rhodonea curve, one
 * petal per bar: each downbeat sits at the flower's heart, the bar swings out to the petal tip on
 * beat 3 and returns for the next downbeat, so a beat is a fixed place on every petal and rhythms
 * line up from petal to petal. A 4- or 8-bar phrase closes the flower, so the next phrase blooms
 * over the same petals. Pitch is height above the flower, roles stack slightly apart.
 *
 * S.p[4]: x = petal length, y = rotation (radians), w = petals per flower (<= 3 -> 4, >= 4 -> 8).
 */
const layout: LayoutBlock = {
  id: 'rose',
  kind: 'flow',
  weight: 0.3,
  cameras: ['rose-tilted', 'rose-low'],
  wgsl: /* wgsl */ `
fn ro_barLen() -> f32 { return 240.0 / clamp(F.bpm, 50.0, 220.0); }
/** Bars on an absolute downbeat-aligned grid, so geometry stays fixed in song time. */
fn ro_bars(t: f32) -> f32 {
  let bl = ro_barLen();
  let a = F.songTime - F.barPhase * bl;
  return (t - (a - bl * round(a / bl))) / bl;
}
fn ro_n() -> f32 { return select(4.0, 8.0, S.p[4].w > 3.5); }
fn ro_petal() -> f32 { return 1.8 + clamp(S.p[4].x, 0.4, 2.6) * 0.8; }
fn ro_heart() -> f32 { return ro_petal() * 0.22; }
fn ro_plane(u: f32) -> vec2f {
  let a = TAU * u / ro_n() + S.p[4].y;
  let r = ro_heart() + ro_petal() * sin(3.14159265 * fract(u));
  return vec2f(cos(a), sin(a)) * r;
}
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  let xz = ro_plane(ro_bars(t));
  return vec3f(xz.x, (pitch - S.p[0].z) * S.p[0].y * 0.5 + lane * S.p[0].w * 0.6, xz.y);
}
fn LCenter(t: f32) -> vec3f { let xz = ro_plane(ro_bars(t)); return vec3f(xz.x, 0.0, xz.y); }
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
};

const cameras: Record<string, Block> = {
  // The whole flower from above at an angle, turning slowly.
  'rose-tilted': {
    id: 'rose-tilted',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f {
  let a = F.spin * 0.05 + S.p[2].w + S.p[4].y;
  let d = (ro_heart() + ro_petal()) * (2.0 + S.p[2].y * 0.25);
  return vec3f(cos(a) * d * 0.62, d * 0.78, sin(a) * d * 0.62);
}
fn camTarget() -> vec3f { return vec3f(0.0, 0.0, 0.0); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  // Low beside the flower: the petals stand as arches, melody as their rise and fall.
  'rose-low': {
    id: 'rose-low',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f {
  let a = F.spin * 0.04 + S.p[2].w + S.p[4].y + 1.2;
  let d = (ro_heart() + ro_petal()) * (1.75 + S.p[2].y * 0.2);
  return vec3f(cos(a) * d, d * (0.36 + S.p[2].x * 0.03), sin(a) * d);
}
fn camTarget() -> vec3f { return vec3f(0.0, ro_petal() * 0.1, 0.0); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
};

export default { layout, cameras };
