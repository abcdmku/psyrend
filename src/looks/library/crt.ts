import { defineLook } from '../types';

/**
 * Cathode-ray and tape: tube curvature, beam scanlines, phosphor masks, chroma bleed and
 * tracking wobble on the bass. Genes: tube (TV, PVM, VHS, arcade), mask (grille, shadow,
 * slot, none), noise (clean, grain, tape), bleed and colour temperature.
 */
export default defineLook({
  meta: { id: 'crt', name: 'Cathode Tube', weight: 0.55, energy: [0, 1], amount: [0.7, 1], genres: { synthwave: 1, lofi: 0.9, hiphop: 0.8, rock: 0.6, classical: 0.2 } },
  params(ctx, p) {
    const d = ctx.dna;
    const tube = Math.floor(d[0] * 4);
    p[0] = tube;
    p[1] = [0.1, 0.035, 0.0, 0.16][tube];
    p[2] = [3.0, 2.4, 2.0, 3.0][tube];
    p[3] = [0.55, 0.35, 0.18, 0.8][tube];
    p[4] = Math.floor(d[1] * 4);
    p[5] = Math.floor(d[2] * 3);
    p[6] = (tube === 2 ? 2.5 : 1) * (0.6 + 1.2 * d[3]);
    p[7] = Math.floor(d[3] * 3);
  },
  wgsl: /* wgsl */ `
fn crt_chroma(c: vec3f) -> vec3f { return c - luma(c); }

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let tube = L.p[0].x;
  let curv = L.p[0].y;
  let maskType = L.p[1].x;
  let noise = L.p[1].y;
  let bleed = L.p[1].z;
  let k = L.res.y / 720.0;

  // Tube curvature.
  var c = uv * 2.0 - 1.0;
  c *= 1.0 + curv * (c.yx * c.yx) * vec2f(1.0, 1.25);
  var tuv = c * 0.5 + 0.5;
  let inside = smoothstep(0.0, 0.012, tuv.x) * smoothstep(0.0, 0.012, tuv.y) * smoothstep(1.0, 0.988, tuv.x) * smoothstep(1.0, 0.988, tuv.y);

  // Tracking: bass sways the lines, a rolling band tears, kicks jolt vertical hold.
  let roll = fract(L.time * 0.07 + 0.3);
  let inBand = exp(-pow((tuv.y - roll) / 0.035, 2.0)) * select(0.35, 1.0, tube > 1.5 && tube < 2.5);
  tuv.x += sin(tuv.y * 38.0 + L.time * 6.0) * 0.0018 * L.bass * (1.0 + bleed);
  tuv.x += (vnoise(vec2f(tuv.y * 90.0, L.time * 20.0)) - 0.5) * 0.03 * inBand * (0.3 + L.bass);
  tuv.y += (hash12(vec2f(floor(L.time * 24.0), 1.0)) - 0.5) * 0.006 * L.kick + 0.08 * pow(L.dropPulse, 4.0);

  // Chroma smears to the right of luma, as composite video does.
  let px = vec2f(bleed * 1.6 / L.res.x * k * 2.0, 0.0);
  let c0 = srcMirror(tuv);
  let ch = (crt_chroma(c0) + crt_chroma(srcMirror(tuv - px)) * 0.8 + crt_chroma(srcMirror(tuv - px * 2.0)) * 0.6 + crt_chroma(srcMirror(tuv - px * 3.5)) * 0.4) / 2.8;
  var col = max(vec3f(luma(c0)) + ch * 1.05, vec3f(0.0));

  // Beam scanlines: bright lines swell wider.
  let lines = L.res.y / (L.p[0].z * k);
  let sy = fract(tuv.y * lines) - 0.5;
  let w = mix(0.22, 0.42, sat(luma(col) * 0.8));
  let beam = exp(-sy * sy / (w * w));
  let sl = L.p[0].w;
  col *= mix(1.0, beam, sl) / mix(1.0, w * 1.7725, sl);

  // Phosphor mask.
  let fx = floor(frag.x / max(1.0, floor(k + 0.5)));
  let fy = floor(frag.y / max(1.0, floor(k + 0.5)));
  var m = vec3f(1.0);
  if (maskType < 0.5) {
    let i = u32(fx) % 3u;
    m = select(select(vec3f(0.45, 0.45, 1.0), vec3f(0.45, 1.0, 0.45), i == 1u), vec3f(1.0, 0.45, 0.45), i == 0u);
  } else if (maskType < 1.5) {
    let i = u32(fx + select(0.0, 1.5, (u32(fy) % 2u) == 1u)) % 3u;
    m = select(select(vec3f(0.5, 0.5, 1.0), vec3f(0.5, 1.0, 0.5), i == 1u), vec3f(1.0, 0.5, 0.5), i == 0u);
  } else if (maskType < 2.5) {
    let tri = floor(fx / 3.0);
    let i = u32(fx) % 3u;
    let gap = (u32(fy + select(0.0, 2.0, (u32(tri) % 2u) == 1u)) % 4u) == 0u;
    m = select(select(vec3f(0.5, 0.5, 1.0), vec3f(0.5, 1.0, 0.5), i == 1u), vec3f(1.0, 0.5, 0.5), i == 0u) * select(1.0, 0.6, gap);
  }
  col *= m / max(dot(m, vec3f(1.0 / 3.0)), 0.3);

  // Colour temperature of the phosphors.
  let temp = L.p[1].w;
  if (temp > 0.5 && temp < 1.5) { col *= vec3f(1.06, 1.0, 0.9); }
  if (temp > 1.5) { col *= vec3f(0.9, 1.0, 1.08); }

  // Noise.
  if (noise > 0.5) {
    let gr = hash12(frag + fract(L.time * 13.7) * 431.0) - 0.5;
    col *= 1.0 + gr * 0.18 + 0.03 * sin(L.time * 60.0) * L.hat;
  }
  if (noise > 1.5) {
    let row = floor(frag.y / (2.0 * k));
    let streak = step(0.996 - 0.006 * L.snare, hash12(vec2f(row, floor(L.time * 30.0))));
    let seg = step(0.5, vnoise(vec2f(frag.x * 0.02, row + L.time * 40.0)));
    col += vec3f(0.8) * streak * seg * (0.4 + luma(col));
    col = mix(col, vec3f(luma(col)) + hash12(frag + L.time) * 0.3, inBand * 0.35);
  }

  // Tube vignette and the glass edge.
  let vig = 1.0 - 0.3 * dot(c * 0.7, c * 0.7) * select(1.0, 0.3, tube > 1.5 && tube < 2.5);
  return col * vig * inside * (1.0 + 0.04 * L.kick);
}
`,
});
