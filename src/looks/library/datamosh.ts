import { defineLook } from '../types';

/**
 * Codec glitch bursts: macroblock displacement, slice tears, smears and pixel-sort drags,
 * with RGB splits and colour corruption. Fires on snares and drops and is clean between hits.
 * Genes: block size, glitch grammar, colour corruption, corruption frame rate.
 */
export default defineLook({
  meta: { id: 'datamosh', name: 'Datamosh', weight: 0.35, energy: [0.45, 1], amount: [0.75, 1], genres: { dubstep: 1, dnb: 0.9, edm: 0.8, techno: 0.6, ambient: 0.1 } },
  params(ctx, p) {
    const d = ctx.dna;
    p[0] = 14 + Math.floor(d[0] * 5) * 14;
    p[1] = Math.floor(d[1] * 4);
    p[2] = Math.floor(d[2] * 4);
    p[3] = 0.4 + 0.35 * d[3];
    p[4] = 8 + Math.floor(d[3] * 3) * 6;
    p[5] = ctx.music.beatIndex % 977;
  },
  wgsl: /* wgsl */ `
fn dm_rgb(uv: vec2f, sh: vec2f) -> vec3f {
  return vec3f(src(uv + sh).r, src(uv).g, src(uv - sh).b);
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let g = sat(max(max(L.snare * 1.15, L.dropPulse * 1.4), max(L.kick * L.kick * 0.35 * L.energy, L.anticipation * L.anticipation * 0.25)));
  if (g < 0.04) { return src(uv); }
  let bs = L.p[0].x * L.res.y / 720.0;
  let grammar = L.p[0].y;
  let corrupt = L.p[0].z;
  let density = L.p[0].w;
  let seed = floor(L.time * L.p[1].x) + L.p[1].y * 13.0;
  let px = 1.0 / L.res;

  let bid = floor(frag / bs);
  let hb = hash22(bid + seed * 1.37);
  let clump = hash12(floor(frag / (bs * 4.0)) + seed * 0.71);
  let hit = clump < g * density * 1.6 && hb.x < 0.35 + 0.6 * g;

  var duv = uv;
  var sh = vec2f(g * 0.004, 0.0);
  var col: vec3f;
  if (grammar < 0.5) {
    // Macroblocks jump by whole block steps.
    if (hit) { duv += floor((hash22(bid + seed) - 0.5) * 7.0) * bs * px; sh *= 3.0; }
    col = dm_rgb(duv, sh);
  } else if (grammar < 1.5) {
    // Slice tears of uneven height slide sideways.
    let band = floor(frag.y / (bs * 0.3));
    let hs = hash12(vec2f(band, seed));
    let tear = hs < g * density;
    if (tear) { duv.x += (hash12(vec2f(seed, band)) - 0.5) * 0.25 * g; sh = vec2f(0.012 * g, 0.0); }
    col = dm_rgb(duv, sh);
  } else if (grammar < 2.5) {
    // Melt: blocks collapse onto their leading edge and drag along a motion vector.
    if (hit) {
      let mv = normalize(hash22(vec2f(seed, 3.0)) - 0.5);
      let edgeY = (bid.y + select(0.0, 1.0, mv.y < 0.0)) * bs * px.y;
      duv.y = mix(uv.y, edgeY, 0.85);
      duv += mv * hb.y * 0.05 * g;
      sh *= 2.0;
    }
    col = dm_rgb(duv, sh);
  } else {
    // Pixel-sort drag: brightest of six taps along the row wins.
    col = dm_rgb(duv, sh);
    let band = floor(frag.y / (bs * 0.5));
    if (hash12(vec2f(band, seed)) < g * density * 1.3) {
      let span = (0.02 + 0.08 * hash12(vec2f(seed, band))) * g;
      var best = col;
      for (var i = 1; i < 7; i++) {
        let c = src(uv - vec2f(span * f32(i) / 6.0, 0.0));
        if (luma(c) > luma(best)) { best = c; }
      }
      col = mix(col, best, 0.85);
    }
  }

  if (hit || (grammar > 0.5 && hb.x < 0.25 * g)) {
    if (corrupt > 0.5 && corrupt < 1.5) {
      // Channel order scrambles per block.
      let k = hash12(bid + seed * 3.1);
      col = select(select(col.gbr, col.brg, k < 0.66), col.bgr, k < 0.33);
    } else if (corrupt > 1.5 && corrupt < 2.5) {
      // Coarse chroma quantisation, as when a codec starves.
      let y = luma(col);
      let c = col - y;
      col = y + floor(c * 4.0 + 0.5) / 4.0 * 1.4;
      col = max(col, vec3f(0.0));
    } else if (corrupt > 2.5) {
      col = palAt(luma(col) * 0.8 + hb.y) * (0.2 + luma(col) * 1.2);
    }
  }
  // Faint scanline grit only while glitching.
  col *= 1.0 - 0.12 * g * step(0.5, fract(frag.y * 0.5));
  return col;
}
`,
});
