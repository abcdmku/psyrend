import type { Block } from '../blocks';

/**
 * A dark studio cyclorama lit by a single key: one soft pool of light on the backdrop, up and left
 * of the subject like the shading rig's key. The upcoming chord sets the light's temperature
 * (major warm, minor cool) and its tension tightens the pool.
 */
export default {
  id: 'studio',
  wgsl: /* wgsl */ `
fn bgColor(rd: vec3f) -> vec3f {
  let f = normalize(camTarget() - camEye());
  let s = normalize(cross(f, camUp()));
  let u = cross(s, f);
  let ch = chordAtT(2.0);
  let a = dot(rd, normalize(f + u * 0.32 - s * 0.28));
  var pool = smoothstep(mix(0.35, 0.62, ch.z), 1.0, a);
  pool = pool * pool;
  let temp = select(vec3f(0.95, 0.95, 0.95), mix(vec3f(0.7, 0.84, 1.0), vec3f(1.0, 0.84, 0.66), sat((ch.y - 0.25) / 0.75)), ch.x > 0.02);
  let low = smoothstep(0.05, -0.35, dot(rd, u));
  return vec3f(0.0028) + temp * 0.085 * pool * (1.0 - 0.7 * low);
}`,
} satisfies Block;
