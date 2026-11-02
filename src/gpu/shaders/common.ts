import { FRAME_LAYOUT, SCENE_LAYOUT } from '../frameLayout';

/**
 * Shared WGSL prelude for every scene: bindings, noise, SDF helpers, palette and
 * audio accessors. Scenes reference `F` (frame/audio uniforms) and `S.p[i]`
 * (their own eight vec4 parameter slots).
 */
export const BINDINGS_WGSL = /* wgsl */ `
${FRAME_LAYOUT.wgsl('Frame')}
${SCENE_LAYOUT.wgsl('SceneParams')}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> S: SceneParams;
@group(0) @binding(2) var histTex: texture_2d<f32>;
@group(0) @binding(3) var noiseTex: texture_3d<f32>;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var scoreTex: texture_2d<f32>;
@group(0) @binding(6) var eventsTex: texture_2d<f32>;
@group(0) @binding(7) var sampClamp: sampler;
`;

export const COMMON_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn fmod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn fmod3(x: vec3f, y: vec3f) -> vec3f { return x - y * floor(x / y); }
fn rot2(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn rotX(a: f32) -> mat3x3f { let c = cos(a); let s = sin(a); return mat3x3f(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
fn rotY(a: f32) -> mat3x3f { let c = cos(a); let s = sin(a); return mat3x3f(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
fn rotZ(a: f32) -> mat3x3f { let c = cos(a); let s = sin(a); return mat3x3f(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
fn rotAxis(axis: vec3f, a: f32) -> mat3x3f {
  let s = sin(a); let c = cos(a); let oc = 1.0 - c; let x = axis.x; let y = axis.y; let z = axis.z;
  return mat3x3f(
    oc * x * x + c, oc * x * y + z * s, oc * z * x - y * s,
    oc * x * y - z * s, oc * y * y + c, oc * y * z + x * s,
    oc * z * x + y * s, oc * y * z - x * s, oc * z * z + c);
}

// ---------- hashing ----------
fn hash11(p: f32) -> f32 { var x = fract(p * 0.1031); x *= x + 33.33; x *= x + x; return fract(x); }
fn hash12(p: vec2f) -> f32 { var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
fn hash13(p: vec3f) -> f32 { var p3 = fract(p * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
fn hash33(p: vec3f) -> vec3f {
  var p3 = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
/** Interleaved gradient noise, animated per frame: cheap blue-ish dither for ray offsets. */
fn ign(p: vec2f) -> f32 {
  let q = p + 5.588238 * fmod(F.frame, 64.0);
  return fract(52.9829189 * fract(dot(q, vec2f(0.06711056, 0.00583715))));
}

/** PCG integer hash: use for per-particle randomness (float hashes of large indices band). */
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hashU(v: u32) -> f32 { return f32(pcg(v)) / 4294967295.0; }
fn hashU3(v: u32) -> vec3f { let a = pcg(v); let b = pcg(a); return vec3f(f32(a), f32(b), f32(pcg(b))) / 4294967295.0; }

// ---------- texture noise (64^3 tileable value noise, 4 independent channels) ----------
fn noiseTexel(i: vec3i) -> vec4f { return textureLoad(noiseTex, i & vec3i(63), 0); }
/**
 * Smooth value noise with exact float interpolation (8 texel loads). Hardware filtering only
 * has ~8-bit sub-texel weights, which shows up as terracing in normals and smooth heightfields.
 */
fn noise4(p: vec3f) -> vec4f {
  let fl = floor(p);
  let i = vec3i(fl);
  var f = p - fl;
  f = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(noiseTexel(i), noiseTexel(i + vec3i(1, 0, 0)), f.x), mix(noiseTexel(i + vec3i(0, 1, 0)), noiseTexel(i + vec3i(1, 1, 0)), f.x), f.y);
  let b = mix(mix(noiseTexel(i + vec3i(0, 0, 1)), noiseTexel(i + vec3i(1, 0, 1)), f.x), mix(noiseTexel(i + vec3i(0, 1, 1)), noiseTexel(i + vec3i(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z) * 2.0 - 1.0;
}
/** One hardware-filtered sample: ~8x cheaper than noise4, fine where precision doesn't show (curl, volumes). */
fn noise4fast(p: vec3f) -> vec4f {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureSampleLevel(noiseTex, samp, (i + f + 0.5) / 64.0, 0.0) * 2.0 - 1.0;
}
fn noise3(p: vec3f) -> f32 { return noise4(p).x; }
/** Fast linear-filtered sample (no cubic smoothing) for volumetrics. */
fn noise3fast(p: vec3f) -> f32 { return textureSampleLevel(noiseTex, samp, p / 64.0, 0.0).x * 2.0 - 1.0; }
fn fbm3(p: vec3f, octaves: i32) -> f32 {
  var a = 0.5; var s = 0.0; var q = p;
  for (var i = 0; i < octaves; i++) {
    s += a * noise3(q);
    q = q * 2.03 + vec3f(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
fn fbmFast(p: vec3f, octaves: i32) -> f32 {
  var a = 0.5; var s = 0.0; var q = p;
  for (var i = 0; i < octaves; i++) {
    s += a * noise3fast(q);
    q = q * 2.03 + vec3f(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
/** Divergence-free curl of a noise vector potential. */
fn curl3(p: vec3f) -> vec3f {
  let e = 0.1;
  let dx = vec3f(e, 0.0, 0.0); let dy = vec3f(0.0, e, 0.0); let dz = vec3f(0.0, 0.0, e);
  let px0 = noise4fast(p - dx); let px1 = noise4fast(p + dx);
  let py0 = noise4fast(p - dy); let py1 = noise4fast(p + dy);
  let pz0 = noise4fast(p - dz); let pz1 = noise4fast(p + dz);
  let x = (py1.z - py0.z) - (pz1.y - pz0.y);
  let y = (pz1.x - pz0.x) - (px1.z - px0.z);
  let z = (px1.y - px0.y) - (py1.x - py0.x);
  return vec3f(x, y, z) / (2.0 * e);
}

// ---------- SDF helpers ----------
fn smin(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
fn smax(a: f32, b: f32, k: f32) -> f32 { return -smin(-a, -b, k); }
fn sdBox(p: vec3f, b: vec3f) -> f32 { let q = abs(p) - b; return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0); }
fn sdTorus(p: vec3f, t: vec2f) -> f32 { let q = vec2f(length(p.xz) - t.x, p.y); return length(q) - t.y; }
fn sdOcta(p: vec3f, s: f32) -> f32 { let q = abs(p); return (q.x + q.y + q.z - s) * 0.57735027; }
fn sdCapsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a; let ba = b - a; let h = sat(dot(pa, ba) / dot(ba, ba)); return length(pa - ba * h) - r;
}

// ---------- camera ----------
fn lookAt(ro: vec3f, ta: vec3f, roll: f32) -> mat3x3f {
  let ww = normalize(ta - ro);
  let up = vec3f(sin(roll), cos(roll), 0.0);
  let uu = normalize(cross(ww, up));
  let vv = cross(uu, ww);
  return mat3x3f(uu, vv, ww);
}

// ---------- color ----------
fn hsv2rgb(c: vec3f) -> vec3f {
  let k = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
  return c.z * mix(k.xxx, clamp(p - k.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}
fn cosPal(t: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f { return a + b * cos(TAU * (c * t + d)); }
/** Cyclic gradient through the director's four palette colors (linear RGB). */
fn pal(t: f32) -> vec3f {
  let x = fract(t) * 4.0;
  let i = floor(x);
  let f = smoothstep(0.0, 1.0, x - i);
  // Branch-free segment pick (dynamic array indexing is slow in hot loops).
  let a = select(select(select(F.pal3.rgb, F.pal2.rgb, i < 2.5), F.pal1.rgb, i < 1.5), F.pal0.rgb, i < 0.5);
  let b = select(select(select(F.pal0.rgb, F.pal3.rgb, i < 2.5), F.pal2.rgb, i < 1.5), F.pal1.rgb, i < 0.5);
  return mix(a, b, f);
}
/** Gradient from shadow (pal0) through pal1, pal2 to highlight (pal3) without wrapping. */
fn palRamp(t: f32) -> vec3f {
  let x = sat(t) * 2.999;
  let i = floor(x);
  let f = smoothstep(0.0, 1.0, x - i);
  let a = select(select(F.pal2.rgb, F.pal1.rgb, i < 1.5), F.pal0.rgb, i < 0.5);
  let b = select(select(F.pal3.rgb, F.pal2.rgb, i < 1.5), F.pal1.rgb, i < 0.5);
  return mix(a, b, f);
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// ---------- infinite zoom ----------
/**
 * Infinite zoom into a field: evaluate the field at 3 octave scales around a continuously growing
 * zoom level z (in octaves) and blend them with these weights. Octave i (0..2) is sampled at
 * p_i = centre + (p - centre) * zoomScale(z, i); finer octaves fade in as coarser ones fade out, so
 * zooming forever keeps revealing new detail with no seam (the weights sum to 1 for any z).
 */
fn zoomScale(z: f32, i: i32) -> f32 { return exp2(f32(i) - fract(z)); }
fn zoomWeight(z: f32, i: i32) -> f32 {
  let t = (f32(i) + 1.0 - fract(z)) / 3.0;
  let s = sin(PI * t);
  return s * s / 1.5;
}
/** Which octave a sample belongs to, stable across the zoom loop (for per-octave hues or seeds). */
fn zoomOctaveId(z: f32, i: i32) -> f32 { return floor(z) + f32(i); }
/**
 * Palette hue at a chosen luminance. Palette schemes range from noir to pastel to acid, so use
 * these for albedo/emission when the scene should control its own brightness.
 */
fn palL(t: f32, lum: f32) -> vec3f { let c = pal(t); return c * (lum / max(luma(c), 0.02)); }
fn palRampL(t: f32, lum: f32) -> vec3f { let c = palRamp(t); return c * (lum / max(luma(c), 0.02)); }

// ---------- audio accessors ----------
/** Smoothed spectrum level at x in [0,1] (low to high frequency). */
fn spec(x: f32) -> f32 {
  let fx = clamp(x, 0.0, 1.0) * 63.0;
  let i = u32(floor(fx));
  let j = min(i + 1u, 63u);
  let a = F.spectrum[i >> 2u][i & 3u];
  let b = F.spectrum[j >> 2u][j & 3u];
  return mix(a, b, fract(fx));
}
/** Spectrum history: x in [0,1] frequency, age in [0,1] (0 = now, 1 = ~4 s ago). */
fn hist(x: f32, age: f32) -> f32 {
  let row = F.histHead - clamp(age, 0.0, 1.0) * 255.0;
  return textureSampleLevel(histTex, samp, vec2f(clamp(x, 0.002, 0.998), (row + 0.5) / 256.0), 0.0).r;
}
fn chromaAt(i: i32) -> f32 { let k = ((i % 12) + 12) % 12; return F.chroma[k / 4][k % 4]; }
// ---------- the score: what is sounding at any moment, past or future ----------
// dt is seconds relative to now (negative = past, positive = upcoming).
fn scoreV(dt: f32) -> f32 { return (F.scoreRow + dt * F.scoreRate + 0.5) / max(F.scoreTexRows, 1.0); }
fn scoreValid(dt: f32) -> f32 {
  let r = F.scoreRow + dt * F.scoreRate;
  return select(0.0, 1.0, F.scoreRows > 0.0 && r >= 0.0 && r < F.scoreRows);
}
/**
 * Pitch content at (dt, midi): r = everything sounding (harmonic salience), g = lead line,
 * b = bass line, a = note attacks. midi is continuous (28..99).
 */
fn score(dt: f32, midi: f32) -> vec4f {
  let u = (clamp(midi, 28.0, 99.0) - 28.0 + 0.5) / 72.0;
  return textureSampleLevel(scoreTex, sampClamp, vec2f(u, scoreV(dt)), 0.0) * scoreValid(dt);
}
fn scoreEvents(dt: f32, col: f32) -> vec4f {
  return textureSampleLevel(eventsTex, sampClamp, vec2f((col + 0.5) / 4.0, scoreV(dt)), 0.0) * scoreValid(dt);
}
/** kick, snare, hat, any onset envelopes at dt. */
fn drumsAt(dt: f32) -> vec4f { return scoreEvents(dt, 0.0); }
/** beat pulse, bar pulse, section kind (0..1), section progress at dt. */
fn gridAt(dt: f32) -> vec4f { return scoreEvents(dt, 1.0); }
/** chord root ((root+1)/13, 0 = none), quality (maj 1, min .5, dim .25), tension, change pulse at dt. */
fn chordAtT(dt: f32) -> vec4f { return scoreEvents(dt, 2.0); }
/** Lead melody at dt: (midi pitch, strength). Pitch is held through silence edges by the sampler. */
fn leadAt(dt: f32) -> vec2f { let c = scoreEvents(dt, 3.0); return vec2f(28.0 + c.x * 72.0, c.y); }
fn bassAt(dt: f32) -> vec2f { let c = scoreEvents(dt, 3.0); return vec2f(28.0 + c.z * 72.0, c.w); }

/** Beat envelope that peaks on the beat; sharpness k. */
fn beatEnv(k: f32) -> f32 { return exp(-F.beatPhase * k); }
`;

export const FULLSCREEN_VS = /* wgsl */ `
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VsOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;
