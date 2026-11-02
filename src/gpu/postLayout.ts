import { defineLayout } from './layout';

/** Uniforms for transition, feedback, bloom and final grading passes. */
export const POST_LAYOUT = defineLayout([
  ['res', 'vec2f'],
  ['outRes', 'vec2f'],
  ['time', 'f32'],
  ['frame', 'f32'],
  ['transProgress', 'f32'],
  ['transKind', 'f32'],
  ['transSeed', 'f32'],
  ['flash', 'f32'],
  ['fbAmount', 'f32'],
  ['fbZoom', 'f32'],
  ['fbRotate', 'f32'],
  ['fbHueShift', 'f32'],
  ['fbWarp', 'f32'],
  ['kaleido', 'f32'],
  ['kaleidoMix', 'f32'],
  ['kaleidoSpin', 'f32'],
  ['bloomStrength', 'f32'],
  ['bloomThreshold', 'f32'],
  ['exposure', 'f32'],
  ['saturation', 'f32'],
  ['contrast', 'f32'],
  ['chromaAb', 'f32'],
  ['vignette', 'f32'],
  ['grain', 'f32'],
  ['sharpen', 'f32'],
  ['beat', 'f32'],
  ['anticipation', 'f32'],
  ['hdr', 'f32'],
  ['shake', 'f32'],
  ['dt', 'f32'],
  ['autoExposure', 'f32'],
  ['fbLighten', 'f32'],
  ['shadowTint', 'vec4f'],
  ['highTint', 'vec4f'],
] as const);

export type PostField = keyof typeof POST_LAYOUT.offset;
export type PostParams = Record<Exclude<PostField, 'res' | 'outRes' | 'shadowTint' | 'highTint'>, number> & {
  shadowTint: [number, number, number];
  highTint: [number, number, number];
};

export enum TransitionKind {
  Dissolve = 0,
  Zoom = 1,
  Cut = 2,
  Fade = 3,
}
