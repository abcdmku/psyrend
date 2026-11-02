import { compileModule } from './context';
import { POST_LAYOUT, type PostParams } from './postLayout';
import { HDR_FORMAT } from './resources';
import { FULLSCREEN_VS } from './shaders/common';
import { LOOK_LAYOUT, type LookFactory } from '../looks/types';

const BLOOM_LEVELS = 6;
/** Mip levels of the soft (pre-blurred) look input: half resolution down to 1/64. */
const SOFT_LEVELS = 6;

const POST_COMMON = /* wgsl */ `
${POST_LAYOUT.wgsl('Post')}
struct Pass { texel: vec2f, flags: vec2f };
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;
@group(0) @binding(4) var<uniform> PS: Pass;
@group(0) @binding(5) var<storage, read> EXPO: array<f32, 4>;
${FULLSCREEN_VS}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn hash12(p: vec2f) -> f32 { var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x), mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn rot2(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn hueRotate(c: vec3f, a: f32) -> vec3f {
  // Rodrigues rotation around the grey axis.
  let k = vec3f(0.57735);
  let ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
`;

const TRANSITION_WGSL = /* wgsl */ `
${POST_COMMON}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let t = P.transProgress;
  // Every motion in a transition runs on an eased clock: it starts and settles at zero speed, and
  // whatever is left when the transition hands over (its window closes a frame short of t = 1) is
  // too small to see. A linear zoom stopped dead at the hand-over, which read as a snap.
  let s = smoothstep(0.0, 1.0, t);
  let aspect = P.res.x / P.res.y;
  let c = in.uv - 0.5;
  var uvA = in.uv;
  var uvB = in.uv;
  var w = t;
  let kind = i32(P.transKind + 0.5);
  if (kind == 0) {
    // Luminance-led dissolve: the bright structure of B (its music) burns through first, then the rest.
    let lb = luma(textureSampleLevel(texB, smp, in.uv, 0.0).rgb);
    let th = 0.15 + (1.0 - clamp(lb, 0.0, 1.0)) * 0.7;
    w = smoothstep(th - 0.12, th + 0.12, t * 1.24 - 0.12);
    let edge = 1.0 - abs(w * 2.0 - 1.0);
    uvA += c * edge * 0.04;
  } else if (kind == 1) {
    // Radial warp zoom: A rushes outward while B unfolds from the centre.
    let r = length(c * vec2f(aspect, 1.0));
    w = smoothstep(r * 0.8 - 0.1, r * 0.8 + 0.25, t * 1.4 - 0.1);
    uvA = 0.5 + c / (1.0 + s * s * 3.0);
    uvB = 0.5 + c * (1.0 + (1.0 - s) * 0.6);
  } else if (kind == 2) {
    w = step(0.5, t);
  } else {
    w = smoothstep(0.0, 1.0, t);
  }
  let a = textureSampleLevel(texA, smp, uvA, 0.0).rgb;
  let b = textureSampleLevel(texB, smp, uvB, 0.0).rgb;
  return vec4f(mix(a, b, w), 1.0);
}
`;


/**
 * Fusion: two worlds of the same kind (2D with 2D, 3D with 3D) re-formed into ONE new world for a
 * whole cue. Not a blend of two pictures: each mode builds new structure from both worlds' shapes,
 * read from their luminance fields, so neither source is recognisable. texA is the primary, texB
 * its partner; PS.flags = (mode, amount).
 *  0 fold: the primary's geometry folded hard through the partner's shape (strong displacement
 *    along the partner's gradient, repeated), so its forms take the partner's flow.
 *  1 relief: both forms summed into one height field and relit as a new glossy sculpture.
 *  2 interference: new contour bands where the two fields cross (moire of their shapes). 2D only.
 *  3 merge: both forms read as distance fields and melted together (smooth union), so their
 *    structures grow into one another. 2D only (3D worlds are too dark and sparse for 2 and 3).
 */
const FUSE_WGSL = /* wgsl */ `
${POST_COMMON}
/** The partner world as a half-resolution mip chain, so its field can be read smoothly at any scale. */
@group(0) @binding(6) var softB: texture_2d<f32>;
@group(0) @binding(7) var smpMip: sampler;
fn L(t: texture_2d<f32>, uv: vec2f) -> f32 { return luma(textureSampleLevel(t, smp, uv, 0.0).rgb); }
/** Partner luma blurred over about 2^(lod+1) pixels. */
fn LS(uv: vec2f, lod: f32) -> f32 { return luma(textureSampleLevel(softB, smpMip, uv, lod).rgb); }
fn gradS(uv: vec2f, lod: f32, e: vec2f) -> vec2f {
  return vec2f(LS(uv + vec2f(e.x, 0.0), lod) - LS(uv - vec2f(e.x, 0.0), lod), LS(uv + vec2f(0.0, e.y), lod) - LS(uv - vec2f(0.0, e.y), lod));
}
fn grad(t: texture_2d<f32>, uv: vec2f, e: vec2f) -> vec2f {
  return vec2f(L(t, uv + vec2f(e.x, 0.0)) - L(t, uv - vec2f(e.x, 0.0)), L(t, uv + vec2f(0.0, e.y)) - L(t, uv - vec2f(0.0, e.y)));
}
fn chroma(c: vec3f) -> vec3f { return c / max(luma(c), 0.03); }
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let mode = i32(PS.flags.x + 0.5);
  let k = PS.flags.y;
  let uv = in.uv;
  let e = PS.texel * 3.0;
  let p = textureSampleLevel(texA, smp, uv, 0.0).rgb;
  let s = textureSampleLevel(texB, smp, uv, 0.0).rgb;
  var o = p;
  if (mode == 0) {
    // Fold: walk the primary's lookup along the partner's field three times; the primary's shapes
    // re-form along the partner's contours. The field is the partner blurred over ~16 px, so the walk
    // follows its broad forms: fine fibres or particles in the partner would otherwise scatter the
    // walk pixel by pixel into hair and grain. Colour: the primary's, tinted by the partner's.
    var q = uv;
    let eS = PS.texel * 12.0;
    for (var i = 0; i < 3; i++) {
      let g = gradS(q, 3.0, eS) + 0.5 * gradS(q, 4.5, eS * 2.0);
      q += g / (0.25 + length(g)) * 0.07 * k;
    }
    let f = textureSampleLevel(texA, smp, q, 0.0).rgb;
    o = mix(p, luma(f) * mix(chroma(f), chroma(s + f), 0.45), k);
  } else if (mode == 1) {
    // Relief: one new height field from both forms, lit as a glossy surface.
    // The partner's part of the height is read slightly blurred, so its fine detail rounds into
    // smooth relief instead of a field of hairline ridges.
    let h = L(texA, uv) + LS(uv, 1.0);
    let gB = gradS(uv, 1.0, e * 1.5) / 1.5;
    let gx = (L(texA, uv + vec2f(e.x, 0.0)) - L(texA, uv - vec2f(e.x, 0.0))) + gB.x;
    let gy = (L(texA, uv + vec2f(0.0, e.y)) - L(texA, uv - vec2f(0.0, e.y))) + gB.y;
    let n = normalize(vec3f(-gx * 6.0, -gy * 6.0, 1.0));
    let ld = normalize(vec3f(0.5, 0.6, 0.65));
    let dif = max(dot(n, ld), 0.0);
    let spe = pow(max(dot(reflect(-ld, n), vec3f(0.0, 0.0, 1.0)), 0.0), 40.0);
    let col = chroma(mix(p, s, smoothstep(0.0, 1.0, L(texB, uv) / max(h, 1e-3))) + 1e-3);
    // Brightness follows the summed form (dark gaps stay dark), with a lift for sparse 3D worlds.
    let lift = clamp(h * 1.25, 0.0, 1.5);
    let body = col * (0.05 + 1.0 * dif) * lift * 0.6;
    o = mix(p, body + col * spe * 0.75 * lift, k);
  } else if (mode == 2) {
    // Interference: contour bands of the two fields' sum and difference cross into a new weave.
    let a = L(texA, uv);
    let b = L(texB, uv);
    let w1 = 0.5 + 0.5 * cos((a + b) * 18.0);
    let w2 = 0.5 + 0.5 * cos((a - b) * 18.0);
    let band = pow(w1 * w2, 2.0);
    let col = chroma(p + s + 1e-3);
    o = mix(p, col * band * clamp(a + b, 0.0, 1.5) * 0.9, k);
  } else {
    // Merge: lit structure as solid (distance ~ darkness), melted together by a smooth union, then
    // shaded by the merged field's edge so the two forms grow into one structure.
    let da = 1.0 - clamp(L(texA, uv) * 2.0, 0.0, 1.0);
    let db = 1.0 - clamp(L(texB, uv) * 2.0, 0.0, 1.0);
    let r = 0.35;
    let hh = clamp(0.5 + 0.5 * (db - da) / r, 0.0, 1.0);
    let d = mix(db, da, hh) - r * hh * (1.0 - hh);
    let inside = 1.0 - smoothstep(0.0, 0.25, d);
    let rim = exp(-pow((d - 0.12) * 9.0, 2.0));
    let col = chroma(mix(s, p, hh) + 1e-3);
    o = mix(p, col * (inside * 0.55 + rim * 0.9), k);
  }
  return vec4f(max(o, vec3f(0.0)), 1.0);
}
`;

const FEEDBACK_WGSL = /* wgsl */ `
${POST_COMMON}
/**
 * 5-tap Catmull-Rom history fetch. Bilinear resampling every frame would diffuse
 * the trails more at higher refresh rates; bicubic keeps them crisp at any rate.
 */
fn sampleHistory(uv: vec2f) -> vec3f {
  let size = P.res;
  let pos = uv * size;
  let c = floor(pos - 0.5) + 0.5;
  let f = pos - c;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (c - 1.0) / size;
  let t3 = (c + 2.0) / size;
  let t12 = (c + w2 / w12) / size;
  var r = textureSampleLevel(texB, smp, vec2f(t12.x, t0.y), 0.0).rgb * (w12.x * w0.y);
  r += textureSampleLevel(texB, smp, vec2f(t0.x, t12.y), 0.0).rgb * (w0.x * w12.y);
  r += textureSampleLevel(texB, smp, vec2f(t12.x, t12.y), 0.0).rgb * (w12.x * w12.y);
  r += textureSampleLevel(texB, smp, vec2f(t3.x, t12.y), 0.0).rgb * (w3.x * w12.y);
  r += textureSampleLevel(texB, smp, vec2f(t12.x, t3.y), 0.0).rgb * (w12.x * w3.y);
  let norm = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / norm, vec3f(0.0));
}
/** Keeps NaN/inf from a scene out of the history buffer, where it would persist. */
fn sanitize(c: vec3f) -> vec3f {
  let bad = (c != c) | (abs(c) > vec3f(1e4));
  return clamp(select(c, vec3f(0.0), bad), vec3f(0.0), vec3f(64.0));
}
fn kaleido(uv: vec2f) -> vec2f {
  let aspect = P.res.x / P.res.y;
  var p = (uv - 0.5) * vec2f(aspect, 1.0);
  p = rot2(P.kaleidoSpin) * p;
  let n = max(P.kaleido, 1.0);
  let seg = 6.28318530718 / n;
  var a = atan2(p.y, p.x);
  let r = length(p);
  a = abs(a - seg * floor(a / seg + 0.5));
  // Gentle radial ripple keeps the mirror seams alive.
  let q = vec2f(cos(a), sin(a)) * r;
  return q / vec2f(aspect, 1.0) + 0.5;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  var cur = textureSampleLevel(texA, smp, in.uv, 0.0).rgb;
  if (P.kaleidoMix > 0.001) {
    let k = textureSampleLevel(texA, smp, kaleido(in.uv), 0.0).rgb;
    cur = mix(cur, k, P.kaleidoMix);
  }
  if (P.fbAmount < 0.001) { return vec4f(sanitize(cur), 1.0); }
  let aspect = P.res.x / P.res.y;
  var c = (in.uv - 0.5) * vec2f(aspect, 1.0);
  c = rot2(P.fbRotate) * c / (1.0 + P.fbZoom);
  let flow = vec2f(vnoise(in.uv * 3.0 + P.time * 0.15), vnoise(in.uv * 3.0 + 7.3 - P.time * 0.13)) - 0.5;
  let puv = c / vec2f(aspect, 1.0) + 0.5 + flow * P.fbWarp;
  var prev = sampleHistory(puv);
  prev = max(hueRotate(prev, P.fbHueShift), vec3f(0.0));
  let edge = smoothstep(0.0, 0.02, min(min(puv.x, 1.0 - puv.x), min(puv.y, 1.0 - puv.y)));
  let keep = P.fbAmount * edge;
  // Sparse scenes (light on black) use a lighten composite so trails glow; surface scenes use an
  // energy-conserving echo so a moving frame never brightens. Neither can run away at any frame rate.
  let lighten = max(cur, prev * keep);
  let echo = mix(cur, prev, keep);
  // Stochastic rounding: at high refresh rates the per-frame EMA step is below one fp16 ulp and
  // would round back to the old value, freezing trails. Unbiased noise of ~1 ulp keeps the decay exact.
  let n = hash12(in.pos.xy + fract(P.frame * 0.6180339) * 517.0) - 0.5;
  return vec4f(sanitize(mix(echo, lighten, P.fbLighten)) * (1.0 + n * 0.00098), 1.0);
}
`;

const BLOOM_DOWN_WGSL = /* wgsl */ `
${POST_COMMON}
fn karis(c: vec3f) -> f32 { return 1.0 / (1.0 + luma(c)); }
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let t = PS.texel;
  let uv = in.uv;
  let a = textureSampleLevel(texA, smp, uv + t * vec2f(-2.0, -2.0), 0.0).rgb;
  let b = textureSampleLevel(texA, smp, uv + t * vec2f(0.0, -2.0), 0.0).rgb;
  let c = textureSampleLevel(texA, smp, uv + t * vec2f(2.0, -2.0), 0.0).rgb;
  let d = textureSampleLevel(texA, smp, uv + t * vec2f(-2.0, 0.0), 0.0).rgb;
  let e = textureSampleLevel(texA, smp, uv, 0.0).rgb;
  let f = textureSampleLevel(texA, smp, uv + t * vec2f(2.0, 0.0), 0.0).rgb;
  let g = textureSampleLevel(texA, smp, uv + t * vec2f(-2.0, 2.0), 0.0).rgb;
  let h = textureSampleLevel(texA, smp, uv + t * vec2f(0.0, 2.0), 0.0).rgb;
  let i = textureSampleLevel(texA, smp, uv + t * vec2f(2.0, 2.0), 0.0).rgb;
  let j = textureSampleLevel(texA, smp, uv + t * vec2f(-1.0, -1.0), 0.0).rgb;
  let k = textureSampleLevel(texA, smp, uv + t * vec2f(1.0, -1.0), 0.0).rgb;
  let l = textureSampleLevel(texA, smp, uv + t * vec2f(-1.0, 1.0), 0.0).rgb;
  let m = textureSampleLevel(texA, smp, uv + t * vec2f(1.0, 1.0), 0.0).rgb;
  var col: vec3f;
  if (PS.flags.x > 0.5) {
    // First level: Karis-weighted groups suppress fireflies, then a soft-knee threshold.
    let g0 = (a + b + d + e) * 0.25; let g1 = (b + c + e + f) * 0.25;
    let g2 = (d + e + g + h) * 0.25; let g3 = (e + f + h + i) * 0.25;
    let g4 = (j + k + l + m) * 0.25;
    let w0 = karis(g0) * 0.125; let w1 = karis(g1) * 0.125; let w2 = karis(g2) * 0.125; let w3 = karis(g3) * 0.125; let w4 = karis(g4) * 0.5;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    let br = max(col.r, max(col.g, col.b));
    let knee = P.bloomThreshold * 0.6;
    var soft = clamp(br - P.bloomThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    let contrib = max(soft, br - P.bloomThreshold) / max(br, 1e-4);
    col *= contrib;
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  return vec4f(col, 1.0);
}
`;

const BLOOM_UP_WGSL = /* wgsl */ `
${POST_COMMON}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let t = PS.texel * PS.flags.y;
  let uv = in.uv;
  var s = textureSampleLevel(texA, smp, uv, 0.0).rgb * 4.0;
  s += (textureSampleLevel(texA, smp, uv + vec2f(-t.x, 0.0), 0.0).rgb + textureSampleLevel(texA, smp, uv + vec2f(t.x, 0.0), 0.0).rgb
      + textureSampleLevel(texA, smp, uv + vec2f(0.0, -t.y), 0.0).rgb + textureSampleLevel(texA, smp, uv + vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  s += textureSampleLevel(texA, smp, uv - t, 0.0).rgb + textureSampleLevel(texA, smp, uv + t, 0.0).rgb
     + textureSampleLevel(texA, smp, uv + vec2f(-t.x, t.y), 0.0).rgb + textureSampleLevel(texA, smp, uv + vec2f(t.x, -t.y), 0.0).rgb;
  return vec4f(s / 16.0, 1.0);
}
`;

const LUMINANCE_WGSL = /* wgsl */ `
${POST_LAYOUT.wgsl('Post')}
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> expo: array<f32, 4>;
var<workgroup> acc: array<f32, 256>;
@compute @workgroup_size(16, 16) fn cs(@builtin(local_invocation_index) li: u32, @builtin(local_invocation_id) lid: vec3u) {
  let uv = (vec2f(lid.xy) + 0.5) / 16.0;
  let c = textureSampleLevel(src, smp, uv, 0.0).rgb;
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  // Centre-weighted log-average luminance.
  let w = 1.5 - length(uv - 0.5);
  acc[li] = log(clamp(l, 1e-4, 64.0)) * w;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { acc[li] += acc[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    // Normaliser: sum of weights over the 16x16 grid.
    var wsum = 0.0;
    for (var y = 0; y < 16; y++) { for (var x = 0; x < 16; x++) { wsum += 1.5 - length((vec2f(f32(x), f32(y)) + 0.5) / 16.0 - 0.5); } }
    let avg = exp(acc[0] / wsum);
    var prev = expo[0];
    if (!(prev > 0.0) || prev > 1e3) { prev = avg; }
    let rate = select(1.2, 2.5, avg > prev);
    expo[0] = prev + (avg - prev) * (1.0 - exp(-P.dt * rate));
  }
}
`;

const FINAL_WGSL = /* wgsl */ `
${POST_COMMON}
fn aces(x: vec3f) -> vec3f {
  // Hill's RRT+ODT fit in ACEScg-ish space.
  let m1 = mat3x3f(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  let m2 = mat3x3f(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  let v = m1 * x;
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(m2 * (a / b), vec3f(0.0), vec3f(1.0));
}
fn srcSample(uv: vec2f) -> vec3f { return textureSampleLevel(texA, smp, uv, 0.0).rgb; }
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  var uv = in.uv;
  // Screen shake (anticipation tremor / drop impact).
  uv += (vec2f(vnoise(vec2f(P.time * 37.0, 1.3)), vnoise(vec2f(4.1, P.time * 41.0))) - 0.5) * P.shake * 0.02;
  let cen = uv - 0.5;
  let r2 = dot(cen, cen);
  // Radial chromatic aberration.
  let ca = cen * P.chromaAb * (0.4 + r2 * 2.0);
  var col = vec3f(srcSample(uv - ca).r, srcSample(uv).g, srcSample(uv + ca).b);
  // Contrast-adaptive sharpening of the upscaled source.
  let tx = 1.0 / P.res;
  let n = srcSample(uv + vec2f(0.0, -tx.y)); let s = srcSample(uv + vec2f(0.0, tx.y));
  let e = srcSample(uv + vec2f(tx.x, 0.0)); let w = srcSample(uv + vec2f(-tx.x, 0.0));
  let mn = min(min(min(n, s), min(e, w)), col);
  let mx = max(max(max(n, s), max(e, w)), col);
  let amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, vec3f(1e-4)), vec3f(0.0), vec3f(1.0)));
  let wgt = -amp * mix(0.0, 0.2, P.sharpen);
  col = max((col + (n + s + e + w) * wgt) / (1.0 + 4.0 * wgt), vec3f(0.0));

  let bloom = textureSampleLevel(texB, smp, uv, 0.0).rgb;
  col += bloom * P.bloomStrength;
  // Eye adaptation toward a mid-grey key, limited so dark scenes stay moody and bright ones don't clip.
  let adapted = max(EXPO[0], 1e-4);
  let autoGain = clamp(0.2 / adapted, 0.15, 1.6);
  col *= P.exposure * mix(1.0, autoGain, P.autoExposure) * (1.0 + P.flash * 2.5);
  col += P.flash * 0.6 * vec3f(1.0, 0.97, 0.94);

  // Split-toning toward the palette before tone mapping keeps colours rich.
  let l = luma(col);
  col *= mix(P.shadowTint.rgb, P.highTint.rgb, smoothstep(0.02, 1.5, l));

  var mapped: vec3f;
  if (P.hdr > 0.5) {
    // Extended-range output: soft shoulder up to ~4x SDR white.
    mapped = col / (1.0 + col / 4.0) * 1.25;
  } else {
    mapped = aces(col * 0.85);
    mapped = pow(mapped, vec3f(1.0 / 2.2));
  }
  // Grade in display space.
  let ml = luma(mapped);
  mapped = mix(vec3f(ml), mapped, P.saturation);
  mapped = (mapped - 0.5) * P.contrast + 0.5;
  // Vignette.
  let vig = 1.0 - P.vignette * smoothstep(0.15, 0.85, r2 * 2.2);
  mapped *= vig;
  // Film grain, stronger in the mids.
  let gseed = in.pos.xy + fract(P.frame * 0.618) * 113.0;
  let grain = (hash12(gseed) - 0.5) * P.grain * (1.0 - abs(ml * 2.0 - 1.0) * 0.6);
  mapped += grain;
  // Triangular dither before 8-bit quantisation.
  let d = hash12(in.pos.xy + 0.37 * P.frame) + hash12(in.pos.xy * 1.37 + 11.0) - 1.0;
  mapped += d / 255.0;
  if (P.hdr > 0.5) {
    // Undo the display gamma for the linear extended-range swapchain.
    mapped = max(mapped, vec3f(0.0));
    return vec4f(mapped * mapped, 1.0);
  }
  return vec4f(clamp(mapped, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

const LOOK_PRELUDE = /* wgsl */ `
${LOOK_LAYOUT.wgsl('Look')}
@group(0) @binding(0) var<uniform> L: Look;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;
@group(0) @binding(3) var smpMirror: sampler;
@group(0) @binding(4) var softTex: texture_2d<f32>;
@group(0) @binding(5) var smpSoft: sampler;
${FULLSCREEN_VS}
const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;
fn src(uv: vec2f) -> vec3f { return textureSampleLevel(srcTex, smp, uv, 0.0).rgb; }
fn srcMirror(uv: vec2f) -> vec3f { return textureSampleLevel(srcTex, smpMirror, uv, 0.0).rgb; }
/** The look input smoothly blurred over about px pixels (at 720p scale; trilinear across a mip chain). Use this for
 * glows, low-passes and fog instead of a handful of scattered src() taps, which copy small bright points into dots. */
fn srcSoft(uv: vec2f, px: f32) -> vec3f {
  let lod = clamp(log2(max(px * L.res.y / 720.0, 2.0)) - 1.0, 0.0, f32(textureNumLevels(softTex) - 1u));
  return textureSampleLevel(softTex, smpSoft, uv, lod).rgb;
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn hash12(p: vec2f) -> f32 { var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
fn hash22(p: vec2f) -> vec2f { var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.103, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
fn rot2(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x), mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm2(p: vec2f) -> f32 { var a = 0.5; var s = 0.0; var q = p; for (var i = 0; i < 4; i++) { s += a * vnoise(q); q = q * 2.03 + 7.1; a *= 0.5; } return s; }
fn hsv2rgb(c: vec3f) -> vec3f { let k = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0); let p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www); return c.z * mix(k.xxx, clamp(p - k.xxx, vec3f(0.0), vec3f(1.0)), c.y); }
/** Cyclic palette gradient (pal0 to pal3 and back). */
fn palAt(t: f32) -> vec3f {
  let x = fract(t) * 4.0; let i = floor(x); let f = smoothstep(0.0, 1.0, x - i);
  let a = select(select(select(L.pal3.rgb, L.pal2.rgb, i < 2.5), L.pal1.rgb, i < 1.5), L.pal0.rgb, i < 0.5);
  let b = select(select(select(L.pal0.rgb, L.pal3.rgb, i < 2.5), L.pal2.rgb, i < 1.5), L.pal1.rgb, i < 0.5);
  return mix(a, b, f);
}
/** Shadow-to-highlight palette ramp. */
fn palRamp(t: f32) -> vec3f {
  let x = sat(t) * 2.999; let i = floor(x); let f = smoothstep(0.0, 1.0, x - i);
  let a = select(select(L.pal2.rgb, L.pal1.rgb, i < 1.5), L.pal0.rgb, i < 0.5);
  let b = select(select(L.pal3.rgb, L.pal2.rgb, i < 1.5), L.pal1.rgb, i < 0.5);
  return mix(a, b, f);
}
`;

const LOOK_MAIN = /* wgsl */ `
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let base = src(in.uv);
  var l = look(in.uv, in.pos.xy);
  let bad = (l != l) | (abs(l) > vec3f(1e4));
  l = clamp(select(l, base, bad), vec3f(0.0), vec3f(64.0));
  return vec4f(mix(base, l, L.amount), 1.0);
}
`;

interface Targets {
  w: number;
  h: number;
  sceneA: GPUTexture;
  sceneB: GPUTexture;
  /** Fusion: the primary world renders here and its partner into fuseC; the fused image goes to sceneA/B. */
  fuseSrc: GPUTexture;
  fuseC: GPUTexture;
  mix: GPUTexture;
  hist: [GPUTexture, GPUTexture];
  styled: GPUTexture;
  bloom: GPUTexture[];
  /** Half-resolution mip chain of the look input, for srcSoft(). */
  soft: GPUTexture;
  /** The same for the fusion partner (fuseC). */
  fuseSoft: GPUTexture;
}

/** Owns the HDR render targets and every post pass. */
export class PostChain {
  private readonly uniforms = new Float32Array(POST_LAYOUT.size / 4);
  private readonly uniformBuffer: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly dummy: GPUTexture;
  private fusePipe!: GPURenderPipeline;
  private fuseGroup: GPUBindGroup | null = null;
  private fuseLayout!: GPUBindGroupLayout;
  /** Builds the partner's soft chain: level 0 from fuseC, then each level from the one above. */
  private fuseSoftGroups: GPUBindGroup[] = [];
  private fuseSoftViews: GPUTextureView[] = [];
  private readonly fuseParams: GPUBuffer;
  private pipes!: { transition: GPURenderPipeline; feedback: GPURenderPipeline; down: GPURenderPipeline; up: GPURenderPipeline; final: GPURenderPipeline };
  private targets: Targets | null = null;
  private histIndex = 0;
  private passBuffers: GPUBuffer[] = [];
  private groups: {
    transition: GPUBindGroup;
    feedbackFromA: GPUBindGroup[];
    feedbackFromMix: GPUBindGroup[];
    down: GPUBindGroup[][];
    up: GPUBindGroup[];
    final: GPUBindGroup[];
  } | null = null;
  private blitPipe!: GPURenderPipeline;
  private lumPipe!: GPUComputePipeline;
  private lumLayout: GPUBindGroupLayout;
  private lumGroups: GPUBindGroup[] = [];
  private readonly exposure: GPUBuffer;
  private readonly lookLayout: GPUBindGroupLayout;
  private readonly lookBuffer: GPUBuffer;
  private readonly mirrorSampler: GPUSampler;
  private readonly mipSampler: GPUSampler;
  /** Soft chain: level 0 from each history buffer, then each level from the one above. */
  private softGroups: { first: GPUBindGroup[]; next: GPUBindGroup[]; views: GPUTextureView[] } | null = null;
  private lookGroups: GPUBindGroup[] = [];
  private readonly lookPipes = new Map<string, Promise<GPURenderPipeline | null>>();
  private readonly lookReady = new Map<string, GPURenderPipeline>();
  readonly lookErrors: { id: string; message: string }[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly outFormat: GPUTextureFormat,
  ) {
    this.uniformBuffer = device.createBuffer({ label: 'post-uniforms', size: POST_LAYOUT.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.dummy = device.createTexture({ size: [1, 1], format: HDR_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING });
    const all = GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'post',
      entries: [
        { binding: 0, visibility: all, buffer: { type: 'uniform' } },
        { binding: 1, visibility: all, sampler: { type: 'filtering' } },
        { binding: 2, visibility: all, texture: { sampleType: 'float' } },
        { binding: 3, visibility: all, texture: { sampleType: 'float' } },
        { binding: 4, visibility: all, buffer: { type: 'uniform' } },
        { binding: 5, visibility: all, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.exposure = device.createBuffer({ label: 'exposure', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.fuseParams = device.createBuffer({ label: 'fuse-params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const c = GPUShaderStage.COMPUTE;
    this.lumLayout = device.createBindGroupLayout({
      label: 'luminance',
      entries: [
        { binding: 0, visibility: c, buffer: { type: 'uniform' } },
        { binding: 1, visibility: c, sampler: { type: 'filtering' } },
        { binding: 2, visibility: c, texture: { sampleType: 'float' } },
        { binding: 3, visibility: c, buffer: { type: 'storage' } },
      ],
    });
    this.lookLayout = device.createBindGroupLayout({
      label: 'look',
      entries: [
        { binding: 0, visibility: all, buffer: { type: 'uniform' } },
        { binding: 1, visibility: all, sampler: { type: 'filtering' } },
        { binding: 2, visibility: all, texture: { sampleType: 'float' } },
        { binding: 3, visibility: all, sampler: { type: 'filtering' } },
        { binding: 4, visibility: all, texture: { sampleType: 'float' } },
        { binding: 5, visibility: all, sampler: { type: 'filtering' } },
      ],
    });
    this.lookBuffer = device.createBuffer({ label: 'look-uniforms', size: LOOK_LAYOUT.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.mirrorSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'mirror-repeat', addressModeV: 'mirror-repeat' });
    this.mipSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  /** Compiles a look pipeline once; resolves null (and records the error) if it fails. */
  ensureLook(f: LookFactory): Promise<GPURenderPipeline | null> {
    let p = this.lookPipes.get(f.meta.id);
    if (!p) {
      p = (async () => {
        try {
          const module = await compileModule(this.device, `${LOOK_PRELUDE}\n${f.wgsl}\n${LOOK_MAIN}`, `look:${f.meta.id}`);
          const pipe = await this.device.createRenderPipelineAsync({
            label: `look:${f.meta.id}`,
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.lookLayout] }),
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
          });
          this.lookReady.set(f.meta.id, pipe);
          return pipe;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[look ${f.meta.id}]`, message);
          this.lookErrors.push({ id: f.meta.id, message });
          return null;
        }
      })();
      this.lookPipes.set(f.meta.id, p);
    }
    return p;
  }

  isLookReady(id: string): boolean {
    return this.lookReady.has(id);
  }

  setLookParams(data: Float32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.lookBuffer, 0, data);
  }

  async init(): Promise<void> {
    const make = async (code: string, label: string, format: GPUTextureFormat, additive = false) => {
      const module = await compileModule(this.device, code, label);
      return this.device.createRenderPipelineAsync({
        label,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            additive
              ? { format, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }
              : { format },
          ],
        },
      });
    };
    const all = GPUShaderStage.FRAGMENT;
    this.fuseLayout = this.device.createBindGroupLayout({
      label: 'fuse',
      entries: [
        { binding: 0, visibility: all, buffer: { type: 'uniform' } },
        { binding: 1, visibility: all, sampler: { type: 'filtering' } },
        { binding: 2, visibility: all, texture: { sampleType: 'float' } },
        { binding: 3, visibility: all, texture: { sampleType: 'float' } },
        { binding: 4, visibility: all, buffer: { type: 'uniform' } },
        { binding: 5, visibility: all, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: all, texture: { sampleType: 'float' } },
        { binding: 7, visibility: all, sampler: { type: 'filtering' } },
      ],
    });
    const fuseModule = await compileModule(this.device, FUSE_WGSL, 'fuse');
    const fuse = await this.device.createRenderPipelineAsync({
      label: 'fuse',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.fuseLayout] }),
      vertex: { module: fuseModule, entryPoint: 'vs' },
      fragment: { module: fuseModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
    });
    const [transition, feedback, down, up, final, blit] = await Promise.all([
      make(TRANSITION_WGSL, 'transition', HDR_FORMAT),
      make(FEEDBACK_WGSL, 'feedback', HDR_FORMAT),
      make(BLOOM_DOWN_WGSL, 'bloom-down', HDR_FORMAT),
      make(BLOOM_UP_WGSL, 'bloom-up', HDR_FORMAT, true),
      make(FINAL_WGSL, 'final', this.outFormat),
      make(`${POST_COMMON}\n@fragment fn fs(in: VsOut) -> @location(0) vec4f { return textureSampleLevel(texA, smp, in.uv, 0.0); }`, 'blit', HDR_FORMAT),
    ]);
    this.fusePipe = fuse;
    this.pipes = { transition, feedback, down, up, final };
    this.blitPipe = blit;
    this.lumPipe = await this.device.createComputePipelineAsync({
      label: 'luminance',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.lumLayout] }),
      compute: { module: await compileModule(this.device, LUMINANCE_WGSL, 'luminance'), entryPoint: 'cs' },
    });
  }

  get size(): { w: number; h: number } {
    return this.targets ? { w: this.targets.w, h: this.targets.h } : { w: 0, h: 0 };
  }

  get sceneViews(): { a: GPUTextureView; b: GPUTextureView; fuseSrc: GPUTextureView; fuseC: GPUTextureView } {
    const t = this.targets!;
    return { a: t.sceneA.createView(), b: t.sceneB.createView(), fuseSrc: t.fuseSrc.createView(), fuseC: t.fuseC.createView() };
  }

  /** Fuses fuseSrc (primary) with fuseC (partner) into `into` (sceneA or sceneB). */
  encodeFuse(enc: GPUCommandEncoder, into: GPUTextureView, mode: number, amount: number): void {
    const t = this.targets!;
    this.device.queue.writeBuffer(this.fuseParams, 0, new Float32Array([1 / t.w, 1 / t.h, mode, amount]));
    for (let i = 0; i < SOFT_LEVELS; i++) this.fullscreen(enc, this.fuseSoftViews[i], this.pipes.down, this.fuseSoftGroups[i], false, `fuse-soft-${i}`);
    this.fuseGroup ??= this.device.createBindGroup({
      layout: this.fuseLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: t.fuseSrc.createView() },
        { binding: 3, resource: t.fuseC.createView() },
        { binding: 4, resource: { buffer: this.fuseParams } },
        { binding: 5, resource: { buffer: this.exposure } },
        { binding: 6, resource: t.fuseSoft.createView() },
        { binding: 7, resource: this.mipSampler },
      ],
    });
    this.fullscreen(enc, into, this.fusePipe, this.fuseGroup, false, 'fuse');
  }

  /** (Re)allocates render-resolution targets, carrying feedback history across. */
  resize(w: number, h: number): void {
    w = Math.max(16, Math.round(w));
    h = Math.max(16, Math.round(h));
    if (this.targets && this.targets.w === w && this.targets.h === h) return;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const tex = (label: string, tw: number, th: number) =>
      this.device.createTexture({ label, size: [Math.max(1, tw), Math.max(1, th)], format: HDR_FORMAT, usage });
    const next: Targets = {
      w,
      h,
      sceneA: tex('sceneA', w, h),
      sceneB: tex('sceneB', w, h),
      fuseSrc: tex('fuseSrc', w, h),
      fuseC: tex('fuseC', w, h),
      mix: tex('mix', w, h),
      hist: [tex('hist0', w, h), tex('hist1', w, h)],
      styled: tex('styled', w, h),
      bloom: Array.from({ length: BLOOM_LEVELS }, (_, i) => tex(`bloom${i}`, w >> (i + 1), h >> (i + 1))),
      soft: this.device.createTexture({ label: 'soft', size: [Math.max(1, w >> 1), Math.max(1, h >> 1)], mipLevelCount: SOFT_LEVELS, format: HDR_FORMAT, usage }),
      fuseSoft: this.device.createTexture({ label: 'fuse-soft', size: [Math.max(1, w >> 1), Math.max(1, h >> 1)], mipLevelCount: SOFT_LEVELS, format: HDR_FORMAT, usage }),
    };
    const old = this.targets;
    if (old) {
      // Resample the previous history so trails survive resolution changes.
      const enc = this.device.createCommandEncoder();
      const src = old.hist[this.histIndex];
      const bg = this.group(src.createView(), this.dummy.createView(), this.passBuffer(0, 0, 0, 0));
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: next.hist[this.histIndex].createView(), loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(this.blitPipe);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
      this.device.queue.submit([enc.finish()]);
      const doomed = [old.sceneA, old.sceneB, old.fuseSrc, old.fuseC, old.mix, ...old.hist, old.styled, ...old.bloom, old.soft, old.fuseSoft];
      this.device.queue.onSubmittedWorkDone().then(() => doomed.forEach((t) => t.destroy()));
    }
    this.targets = next;
    this.fuseGroup = null;
    this.buildGroups();
  }

  private passBuffer(tx: number, ty: number, f0: number, f1: number): GPUBuffer {
    const b = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(b, 0, new Float32Array([tx, ty, f0, f1]));
    this.passBuffers.push(b);
    return b;
  }

  private group(a: GPUTextureView, b: GPUTextureView, pass: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: a },
        { binding: 3, resource: b },
        { binding: 4, resource: { buffer: pass } },
        { binding: 5, resource: { buffer: this.exposure } },
      ],
    });
  }

  private buildGroups(): void {
    const t = this.targets!;
    const old = this.passBuffers;
    this.passBuffers = [];
    this.device.queue.onSubmittedWorkDone().then(() => old.forEach((b) => b.destroy()));
    const none = this.passBuffer(0, 0, 0, 0);
    const dummy = this.dummy.createView();
    const bloomViews = t.bloom.map((x) => x.createView());
    // Sources after feedback: [hist0, hist1, styled]; a look pass writes `styled` from the fresh history.
    const histViews = t.hist.map((x) => x.createView());
    const srcViews = [...histViews, t.styled.createView()];
    const softAll = t.soft.createView();
    const softViews = Array.from({ length: SOFT_LEVELS }, (_, i) => t.soft.createView({ baseMipLevel: i, mipLevelCount: 1 }));
    this.lookGroups = histViews.map((hv) =>
      this.device.createBindGroup({
        layout: this.lookLayout,
        entries: [
          { binding: 0, resource: { buffer: this.lookBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: hv },
          { binding: 3, resource: this.mirrorSampler },
          { binding: 4, resource: softAll },
          { binding: 5, resource: this.mipSampler },
        ],
      }),
    );
    this.fuseSoftViews = Array.from({ length: SOFT_LEVELS }, (_, i) => t.fuseSoft.createView({ baseMipLevel: i, mipLevelCount: 1 }));
    this.fuseSoftGroups = this.fuseSoftViews.map((_, i) =>
      i === 0
        ? this.group(t.fuseC.createView(), dummy, this.passBuffer(1 / t.w, 1 / t.h, 0, 0))
        : this.group(this.fuseSoftViews[i - 1], dummy, this.passBuffer(1 / Math.max(1, t.w >> i), 1 / Math.max(1, t.h >> i), 0, 0)),
    );
    // The plain (unthresholded) 13-tap downsample builds each soft level from the one above it.
    const firstPb = this.passBuffer(1 / t.w, 1 / t.h, 0, 0);
    this.softGroups = {
      first: histViews.map((hv) => this.group(hv, dummy, firstPb)),
      next: softViews.slice(0, -1).map((v, i) => this.group(v, dummy, this.passBuffer(1 / Math.max(1, t.w >> (i + 1)), 1 / Math.max(1, t.h >> (i + 1)), 0, 0))),
      views: softViews,
    };
    const down: GPUBindGroup[][] = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const srcW = i === 0 ? t.w : Math.max(1, t.w >> i);
      const srcH = i === 0 ? t.h : Math.max(1, t.h >> i);
      const pb = this.passBuffer(1 / srcW, 1 / srcH, i === 0 ? 1 : 0, 0);
      // Level 0 reads whichever history buffer was just written.
      down.push(i === 0 ? srcViews.map((hv) => this.group(hv, dummy, pb)) : [this.group(bloomViews[i - 1], dummy, pb)]);
    }
    const up: GPUBindGroup[] = [];
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const sw = Math.max(1, t.w >> (i + 1));
      const sh = Math.max(1, t.h >> (i + 1));
      up.push(this.group(bloomViews[i], dummy, this.passBuffer(1 / sw, 1 / sh, 0, 1.0)));
    }
    this.lumGroups = srcViews.map((hv) =>
      this.device.createBindGroup({
        layout: this.lumLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: hv },
          { binding: 3, resource: { buffer: this.exposure } },
        ],
      }),
    );
    this.groups = {
      transition: this.group(t.sceneA.createView(), t.sceneB.createView(), none),
      feedbackFromA: [0, 1].map((i) => this.group(t.sceneA.createView(), histViews[1 - i], none)),
      feedbackFromMix: [0, 1].map((i) => this.group(t.mix.createView(), histViews[1 - i], none)),
      down,
      up,
      final: srcViews.map((v) => this.group(v, bloomViews[0], none)),
    };
  }

  setParams(p: PostParams, outW: number, outH: number): void {
    const u = this.uniforms;
    const o = POST_LAYOUT.offset;
    const t = this.targets!;
    u[o.res] = t.w;
    u[o.res + 1] = t.h;
    u[o.outRes] = outW;
    u[o.outRes + 1] = outH;
    for (const k of Object.keys(p) as (keyof PostParams)[]) {
      const v = p[k];
      if (Array.isArray(v)) u.set(v, o[k]);
      else u[o[k]] = v as number;
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
  }

  private fullscreen(enc: GPUCommandEncoder, view: GPUTextureView, pipe: GPURenderPipeline, bg: GPUBindGroup, load = false, label?: string): void {
    const pass = enc.beginRenderPass({ label, colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  /** Runs transition → feedback → look → luminance → bloom → final into `out`. */
  encode(enc: GPUCommandEncoder, out: GPUTextureView, transition: boolean, lookId: string | null): void {
    const t = this.targets!;
    const g = this.groups!;
    if (transition) this.fullscreen(enc, t.mix.createView(), this.pipes.transition, g.transition, false, 'transition');
    const write = 1 - this.histIndex;
    const fb = transition ? g.feedbackFromMix[write] : g.feedbackFromA[write];
    this.fullscreen(enc, t.hist[write].createView(), this.pipes.feedback, fb, false, 'feedback');
    this.histIndex = write;
    const lookPipe = lookId ? this.lookReady.get(lookId) : undefined;
    if (lookPipe) {
      const sg = this.softGroups!;
      this.fullscreen(enc, sg.views[0], this.pipes.down, sg.first[write], false, 'soft-0');
      for (let i = 1; i < SOFT_LEVELS; i++) this.fullscreen(enc, sg.views[i], this.pipes.down, sg.next[i - 1], false, `soft-${i}`);
      this.fullscreen(enc, t.styled.createView(), lookPipe, this.lookGroups[write], false, `look:${lookId}`);
    }
    const srcIndex = lookPipe ? 2 : write;
    const lum = enc.beginComputePass({ label: 'luminance' });
    lum.setPipeline(this.lumPipe);
    lum.setBindGroup(0, this.lumGroups[srcIndex]);
    lum.dispatchWorkgroups(1);
    lum.end();
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const bg = i === 0 ? g.down[0][srcIndex] : g.down[i][0];
      this.fullscreen(enc, t.bloom[i].createView(), this.pipes.down, bg, false, `bloom-down-${i}`);
    }
    for (let k = 0; k < BLOOM_LEVELS - 1; k++) {
      const target = BLOOM_LEVELS - 2 - k;
      this.fullscreen(enc, t.bloom[target].createView(), this.pipes.up, g.up[k], true, `bloom-up-${target}`);
    }
    this.fullscreen(enc, out, this.pipes.final, g.final[srcIndex], false, 'final');
  }
}
