import type { Block } from '../blocks';

/**
 * A dome whose light follows the song's form: calm sections keep a low glow on the horizon, builds
 * raise it and peaks open the whole sky. Late in a section the dome already leans toward the
 * energy of the section ahead, so the form is felt before it arrives.
 */
export default {
  id: 'section-dome',
  wgsl: /* wgsl */ `
fn sectionDome_energy(k: f32) -> f32 {
  // intro, verse, build, peak, breakdown, bridge, outro
  var e = array<f32, 7>(0.2, 0.45, 0.7, 1.0, 0.25, 0.4, 0.15);
  return e[u32(clamp(round(k * 6.0), 0.0, 6.0))];
}
fn bgColor(rd: vec3f) -> vec3f {
  let g = gridAt(0.0);
  let e = mix(sectionDome_energy(g.z), sectionDome_energy(gridAt(8.0).z), smoothstep(0.55, 1.0, g.w));
  // The dome is the viewer's: its horizon stays level with the camera in every layout.
  let up = normalize(camUp());
  let h = dot(rd, up);
  let alt = max(h, 0.0);
  let lit = exp(-alt / mix(0.1, 0.9, e));
  let zen = palL(S.p[3].x + 0.62, 0.004);
  let hor = palL(S.p[3].x + 0.15, 0.012 + 0.04 * e);
  let sky = mix(zen, hor, lit);
  let ground = vec3f(0.0035) + hor * 0.05;
  let c = mix(ground, sky, smoothstep(-0.08, 0.04, h));
  return mix(vec3f(luma(c)), c, 0.7);
}`,
} satisfies Block;
