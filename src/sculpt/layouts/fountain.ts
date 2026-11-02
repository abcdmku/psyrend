import type { Block, LayoutBlock } from '../blocks';

/**
 * Fountain: sounding is release. The future wells up a central pipe, each note in the pipe at its
 * pitch class's angle on the circle of fifths (register sets how far from the centre). At the
 * playhead, the nozzle, every note is thrown out of the pipe in its pitch class's direction and its
 * past falls away along a ballistic arc: higher notes fly further, the bass is thrown flat and heavy,
 * the lead highest. A chord sprays out as a fan of three jets (the same angles its chord emblem
 * uses), a melody makes the spray swing around the circle, and a held note is a continuous jet from
 * pipe to arc. Nothing moves at random: every jet is a note, every direction a pitch class.
 *
 * S.p[4]: x = scale of the pipe and arcs, y = camera azimuth (radians).
 */
const layout: LayoutBlock = {
  id: 'fountain',
  kind: 'flow',
  weight: 0.2,
  cameras: ['fountain-side', 'fountain-above'],
  wgsl: /* wgsl */ `
fn fo_A() -> f32 { return 0.6 + clamp(S.p[4].x, 0.4, 2.6) * 0.4; }
/** Depth of a future moment in the pipe: linear near now, compressed beyond 4 A. */
fn fo_depth(dt: f32) -> f32 { let top = fo_A() * 4.0; return top * tanh(dt * S.p[0].x * 0.4 / top); }
/** Ballistic height after tau seconds out of the nozzle, for a launch-height factor k. */
fn fo_arcY(tau: f32, k: f32) -> f32 { let A = fo_A(); return A * (3.2 * k * tau - 1.6 * tau * tau); }
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  let A = fo_A();
  let a = fifthsAng(fmod(floor(pitch + 0.5), 12.0));
  let dir = vec3f(cos(a), 0.0, sin(a));
  let reg = clamp((pitch - S.p[0].z) * S.p[0].y * 0.25, -0.6, 0.8);
  let r0 = A * (0.45 + 0.12 * reg + 0.05 * lane);
  let dt = t - F.songTime;
  if (dt >= 0.0) { return dir * r0 - vec3f(0.0, fo_depth(dt), 0.0); }
  let tau = -dt;
  // Bass is thrown flat, harmony higher, the lead highest; register sets the reach.
  let k = 1.0 + 0.3 * lane;
  return dir * (r0 + A * 1.6 * (1.0 + 0.45 * reg) * tau) + vec3f(0.0, fo_arcY(tau, k), 0.0);
}
/** The axis: up the pipe to the nozzle, then on upward slowly, so past ripples rise like spray. */
fn LCenter(t: f32) -> vec3f {
  let dt = t - F.songTime;
  return vec3f(0.0, select(-dt * fo_A() * 0.5, -fo_depth(dt), dt >= 0.0), 0.0);
}
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
};

const cameras: Record<string, Block> = {
  // Beside the fountain, a little above the nozzle: the pipe of the future below, the spray above.
  'fountain-side': {
    id: 'fountain-side',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f {
  let A = fo_A();
  let a = F.spin * 0.05 + S.p[2].w + S.p[4].y;
  let d = A * (6.2 + S.p[2].y * 0.6);
  return vec3f(cos(a) * d, A * (1.0 + S.p[2].x * 0.15), sin(a) * d);
}
fn camTarget() -> vec3f { return vec3f(0.0, -fo_A() * 0.2, 0.0); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  // High above: the spray reads as a star of pitch-class directions around the pipe's mouth.
  'fountain-above': {
    id: 'fountain-above',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f {
  let A = fo_A();
  let a = F.spin * 0.04 + S.p[2].w + S.p[4].y;
  let d = A * (2.4 + S.p[2].y * 0.3);
  return vec3f(cos(a) * d, A * (6.2 + S.p[2].x * 0.2), sin(a) * d);
}
fn camTarget() -> vec3f { return vec3f(0.0, -fo_A() * 0.8, 0.0); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
};

export default { layout, cameras };
