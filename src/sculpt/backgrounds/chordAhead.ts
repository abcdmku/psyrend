import type { Block } from '../blocks';

/**
 * The harmony ahead, seen along the view: the centre of view glows in the colour of the chord a
 * few seconds ahead (brighter with its tension), the periphery holds the chord sounding now, and
 * behind the camera is dark. An approaching chord change shows as the centre turning colour first.
 */
export default {
  id: 'chord-ahead',
  wgsl: /* wgsl */ `
fn chordAhead_hue(c: vec4f) -> f32 { return select(S.p[3].x + 0.1, S.p[3].x + pitchHue(c.x * 13.0 - 1.0) * 0.55 + 0.5, c.x > 0.02); }
fn bgColor(rd: vec3f) -> vec3f {
  let a = dot(rd, normalize(camTarget() - camEye()));
  let now = chordAtT(0.0);
  let next = chordAtT(4.0);
  let core = smoothstep(0.7, 1.0, a);
  let halo = smoothstep(-0.3, 0.95, a);
  let c = palL(chordAhead_hue(now), 1.0) * 0.007 * halo + palL(chordAhead_hue(next), 1.0) * (0.016 + 0.022 * next.z) * core * core;
  return vec3f(0.003) + c;
}`,
} satisfies Block;
