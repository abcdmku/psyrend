import type { Block } from '../blocks';

/**
 * A cool, pale sheet for ink: lit evenly from above, with a faint wash along its lower edge in the
 * colour of the chord ahead, so the page itself announces the next harmony.
 */
export default {
  id: 'vellum',
  wgsl: /* wgsl */ `
fn bgColor(rd: vec3f) -> vec3f {
  let ch = chordAtT(3.0);
  let h = sat(rd.y * 0.5 + 0.5);
  let page = vec3f(0.86, 0.9, 0.94) * mix(0.66, 0.78, smoothstep(0.0, 1.0, h));
  let hue = select(S.p[3].x + 0.1, S.p[3].x + pitchHue(ch.x * 13.0 - 1.0) * 0.55 + 0.5, ch.x > 0.02);
  let wash = smoothstep(0.55, 0.15, h) * (0.12 + 0.12 * ch.z);
  // Undo most of the post split-tone (shadow tint from pal0), so the page keeps its own colour.
  let tS = max(1.0 + (F.pal0.rgb / (luma(F.pal0.rgb) + 1e-4) - 1.0) * 0.18, vec3f(0.5));
  return mix(page, palL(hue, luma(page)), wash) / mix(vec3f(1.0), tS, 0.85);
}`,
} satisfies Block;
