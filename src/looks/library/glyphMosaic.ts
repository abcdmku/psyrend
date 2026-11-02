import { defineLook } from '../types';

/**
 * The frame re-typeset as procedural glyphs: each cell draws an SDF-stroked character whose
 * ink density follows the cell's luminance. Genes: cell size, glyph set (ASCII ramp, code rain,
 * halftone geometry, braille, edge strokes), colour mode, stroke weight.
 */
export default defineLook({
  meta: { id: 'glyph-mosaic',
    remaps: true, name: 'Glyph Mosaic', weight: 0.4, energy: [0.2, 1], amount: [0.7, 0.95], genres: { techno: 0.8, hiphop: 0.8, dnb: 0.7, synthwave: 0.7 } },
  params(ctx, p) {
    const d = ctx.dna;
    const m = ctx.music;
    const gset = Math.floor(d[1] * 5);
    const size = 8 + d[0] * 14;
    p[0] = size;
    p[1] = gset === 0 || gset === 1 ? size * 1.5 : gset === 3 ? size * 1.6 : size;
    p[2] = gset;
    p[3] = Math.floor(d[2] * 4);
    p[4] = 0.07 + 0.09 * d[3];
    p[5] = m.beatIndex % 4096;
    p[6] = m.dropPulse > 0.55 ? 0.6 : 1;
  },
  wgsl: /* wgsl */ `
fn gm_seg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = sat(dot(pa, ba) / dot(ba, ba));
  return length(pa - ba * h);
}

fn gm_ascii(p: vec2f, lv: i32) -> f32 {
  var d = 9.0;
  switch lv {
    case 0: { }
    case 1: { d = length(p - vec2f(0.0, 0.55)) - 0.08; }
    case 2: { d = min(length(p - vec2f(0.0, -0.3)), length(p - vec2f(0.0, 0.45))) - 0.08; }
    case 3: { d = gm_seg(p, vec2f(-0.4, 0.0), vec2f(0.4, 0.0)); }
    case 4: { d = min(gm_seg(p, vec2f(-0.45, -0.25), vec2f(0.45, -0.25)), gm_seg(p, vec2f(-0.45, 0.25), vec2f(0.45, 0.25))); }
    case 5: { d = min(gm_seg(p, vec2f(-0.6, 0.0), vec2f(0.6, 0.0)), gm_seg(p, vec2f(0.0, -0.55), vec2f(0.0, 0.55))); }
    case 6: {
      d = gm_seg(p, vec2f(-0.6, 0.0), vec2f(0.6, 0.0));
      d = min(d, gm_seg(p, vec2f(-0.35, -0.55), vec2f(0.35, 0.55)));
      d = min(d, gm_seg(p, vec2f(0.35, -0.55), vec2f(-0.35, 0.55)));
    }
    case 7: {
      d = min(gm_seg(p, vec2f(-0.3, -0.75), vec2f(-0.3, 0.75)), gm_seg(p, vec2f(0.3, -0.75), vec2f(0.3, 0.75)));
      d = min(d, min(gm_seg(p, vec2f(-0.65, -0.3), vec2f(0.65, -0.3)), gm_seg(p, vec2f(-0.65, 0.3), vec2f(0.65, 0.3))));
    }
    case 8: {
      d = gm_seg(p, vec2f(0.55, -0.75), vec2f(-0.55, 0.75));
      d = min(d, abs(length(p - vec2f(-0.4, -0.45)) - 0.2));
      d = min(d, abs(length(p - vec2f(0.4, 0.45)) - 0.2));
    }
    default: {
      d = min(abs(length(p * vec2f(1.0, 0.8)) - 0.6), abs(length(p) - 0.22));
      d = min(d, gm_seg(p, vec2f(0.22, 0.0), vec2f(0.22, 0.45)));
    }
  }
  return d;
}

fn gm_rain(p: vec2f, cell: vec2f, level: f32, seed: f32) -> f32 {
  // Strokes on a 3x3 node grid; more strokes for brighter cells.
  var d = 9.0;
  for (var i = 0; i < 12; i++) {
    let fi = f32(i);
    let hz = i < 6;
    let j = select(fi - 6.0, fi, hz);
    let a = select(vec2f((j % 3.0) * 0.6 - 0.6, floor(j / 3.0) * 0.6 - 0.6), vec2f((j % 2.0) * 0.6 - 0.6, floor(j / 2.0) * 0.6 - 0.6), hz);
    let b = a + select(vec2f(0.0, 0.6), vec2f(0.6, 0.0), hz);
    if (hash12(cell * 1.31 + vec2f(fi * 7.7, seed)) < level) { d = min(d, gm_seg(p * vec2f(1.0, 0.6), a, b)); }
  }
  return d;
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let k = L.res.y / 720.0 * L.p[1].z;
  let cs = vec2f(L.p[0].x, L.p[0].y) * k;
  let gset = L.p[0].z;
  let cmode = L.p[0].w;
  let w = L.p[1].x;
  let cell = floor(frag / cs);
  let p = (fract(frag / cs) - 0.5) * 2.0 * vec2f(1.0, cs.y / cs.x);
  let cuv = (cell + 0.5) * cs / L.res;
  let hp = cs / L.res * 0.3;
  let c0 = src(cuv);
  let a = src(cuv + vec2f(-hp.x, -hp.y));
  let b = src(cuv + vec2f(hp.x, -hp.y));
  let c = src(cuv + vec2f(-hp.x, hp.y));
  let e = src(cuv + vec2f(hp.x, hp.y));
  let col = (c0 * 2.0 + a + b + c + e) / 6.0;
  let Y = luma(col);
  let lv = pow(sat(Y / (Y + 0.3)), 1.35);
  let seed = L.p[1].y + select(0.0, floor(L.time * 8.0), L.snare > 0.3);
  let aa = 2.0 / cs.x * 1.2;

  var d = 9.0;
  var ink = 1.0;
  if (gset < 0.5) {
    let jit = select(0.0, floor((hash12(cell + seed) - 0.5) * 3.0), L.snare > 0.3);
    d = gm_ascii(p, clamp(i32(lv * 9.99 + jit), 0, 9)) - w;
  } else if (gset < 1.5) {
    // Code rain: a bright head runs down each column per beat.
    let col_h = hash12(vec2f(cell.x, 3.0));
    let run = fract(col_h - cell.y * 0.035 + (L.p[1].y + L.beatPhase) * (0.12 + 0.1 * col_h));
    ink = 0.55 + 1.4 * pow(run, 6.0);
    d = gm_rain(p, cell, lv * 0.9, seed + floor(run * 3.0 + col_h * 9.0)) - w * 0.8;
  } else if (gset < 2.5) {
    let r = sqrt(lv) * 0.95;
    let shape = hash12(cell * 0.37 + 1.0);
    if (lv < 0.4 || shape < 0.4) { d = length(p) - r; }
    else if (shape < 0.75) { d = abs(length(p) - r * 0.75) - w * (1.0 + 2.0 * lv); }
    else { d = min(abs(p.x), abs(p.y)) - w * (0.5 + 3.0 * lv); d = max(d, length(p) - 0.95); }
  } else if (gset < 3.5) {
    // Braille: 2x4 dots, each lit with probability = luminance.
    let g = vec2f(clamp(floor((p.x + 1.0) * 1.0), 0.0, 1.0), clamp(floor((p.y / (cs.y / cs.x) + 1.0) * 2.0), 0.0, 3.0));
    let ctr = vec2f(g.x - 0.5, (g.y - 1.5) * 0.5 * (cs.y / cs.x)) * vec2f(0.9, 0.95);
    let on = hash12(cell * 2.17 + g * 13.1 + seed * 0.01) < lv * 1.1;
    d = select(9.0, length(p - ctr) - 0.24 - w, on);
  } else {
    // Edge strokes drawn along the local contour; flat areas get a dot.
    let gx = luma(b + e) - luma(a + c);
    let gy = luma(c + e) - luma(a + b);
    let gm = length(vec2f(gx, gy)) / (Y + 0.1);
    let t = normalize(vec2f(-gy, gx) + 1e-5);
    let len = clamp(gm * 2.0, 0.0, 0.9);
    d = select(length(p) - sqrt(lv) * 0.45, gm_seg(p, -t * len, t * len) - w * (0.6 + lv), gm > 0.08);
  }
  let m = 1.0 - smoothstep(-aa, aa, d);

  var tint = col;
  if (cmode > 0.5 && cmode < 1.5) { tint = palRamp(0.25 + 0.75 * lv) * (Y + 0.05) / max(luma(palRamp(0.25 + 0.75 * lv)), 0.05); }
  if (cmode > 1.5 && cmode < 2.5) { tint = L.pal2.rgb / max(luma(L.pal2.rgb), 0.05) * Y; }
  let gain = 2.4 * ink * (1.0 + 0.5 * L.kick);
  let bg = select(0.05, 0.22, cmode > 2.5);
  var bgc = col * bg;
  if (cmode > 2.5) { bgc = mix(col, L.pal0.rgb, 0.5) * bg; }
  return bgc + tint * m * gain;
}
`,
});
