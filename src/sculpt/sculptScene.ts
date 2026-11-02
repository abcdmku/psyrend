import { GESTURE_RATE } from '../audio/analysis/gesture';
import { JOURNEY_FLOATS, JOURNEY_RATE } from './journeyConst';
import { compileModule } from '../gpu/context';
import { SCENE_LAYOUT } from '../gpu/frameLayout';
import { HDR_FORMAT, type SharedResources } from '../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL } from '../gpu/shaders/common';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../scenes/types';
import { wgslId, type LayerDef } from './layer';

/**
 * A score sculpture: the song's notes, chords and hits rendered as crisp geometry
 * (4x MSAA + depth) by a set of layers, placed in space by a composed layout.
 *
 * Uniform contract (S.p):
 *   [0] speed, pitchScale, pitchCenter, laneGap
 *   [1] pastSec, futureSec, leadRadius, bassRadius
 *   [2] camera a, b, c, d
 *   [3] hueOffset, glow, fog, surfaceAmp
 *   [4] layout x, y, z, w
 *   [5] kick, snare, beatPulse, dropPulse (live)
 *   [6] ringRadius, ringWidth, rippleSpeed, lineWidth
 *   [7] fov, layer param a, layer param b, layer param c
 */
export interface SculptProgram {
  meta: SceneMeta;
  /** Layout, camera and background blocks plus composer-chosen consts. */
  blocksWgsl: string;
  layers: LayerDef[];
  /** Journey presence track (JOURNEY_FLOATS per row at JOURNEY_RATE); layer i fades by channel i. */
  journey?: Float32Array<ArrayBuffer>;
}

const SAMPLES = 4;

const CORE_WGSL = /* wgsl */ `
struct Note { start: f32, end: f32, pitch: f32, strength: f32, role: f32, motif: f32, arp: f32, motifPos: f32, glide: f32, nextPitch: f32, pad0: f32, pad1: f32 };
struct ChordE { start: f32, end: f32, root: f32, quality: f32, tension: f32, a: f32, b: f32, c: f32 };
struct Hit { time: f32, kind: f32, strength: f32, pad: f32 };
struct Particle { pos: vec4f, vel: vec4f };
/** Event ranges visible this frame: n = (noteFirst, noteCount, chordFirst, chordCount), h = (hitFirst, hitCount, now, dt), g = (gesture rate, gesture rows, 0, 0). */
/** ...j = (journey rate, journey rows, 0, 0); ce/ct/cu = camera eye/target/up and cc/cd = path centre and velocity at now, evaluated once per frame. */
struct Win { n: vec4f, h: vec4f, g: vec4f, j: vec4f, ce: vec4f, ct: vec4f, cu: vec4f, cc: vec4f, cd: vec4f };
/** One row of the melodic gesture: pos.xyz + activity, fwd.xyz + melody height, up.xyz + onset. */
struct Gest { pos: vec4f, fwd: vec4f, up: vec4f };
@group(1) @binding(0) var<storage, read> notes: array<Note>;
@group(1) @binding(1) var<storage, read> chords: array<ChordE>;
@group(1) @binding(2) var<storage, read> hits: array<Hit>;
@group(1) @binding(3) var<uniform> W: Win;
@group(1) @binding(4) var<storage, read> gest: array<Gest>;
@group(1) @binding(5) var<storage, read> jtrack: array<vec4f>;

/** Journey channel k at song time t (layer presence 0..11, camera ride 12, wing 13, intensity 14). */
fn journeyAt(k: u32, t: f32) -> f32 {
  let n = W.j.y;
  if (n < 2.0) { return select(0.0, 1.0, k < 12u); }
  let x = clamp(t * W.j.x, 0.0, n - 1.001);
  let i = u32(x);
  let a = jtrack[i * 4u + k / 4u][k % 4u];
  let b = jtrack[(i + 1u) * 4u + k / 4u][k % 4u];
  return mix(a, b, x - f32(i));
}

/**
 * The melodic gesture at song time t: the path the melody steers through space (unit speed per
 * second; intervals pitch it, harmony rolls it, rests straighten it), plus smoothed control
 * signals. Before / after the song it continues straight.
 */
fn gestAt(t: f32) -> Gest {
  var g: Gest;
  let n = W.g.y;
  if (n < 2.0) {
    g.pos = vec4f(0.0, 0.0, t, 0.0);
    g.fwd = vec4f(0.0, 0.0, 1.0, 0.0);
    g.up = vec4f(0.0, 1.0, 0.0, 0.0);
    return g;
  }
  let xr = t * W.g.x;
  let x = clamp(xr, 0.0, n - 1.001);
  let i = u32(x);
  let f = x - f32(i);
  let a = gest[i];
  let b = gest[i + 1u];
  let fwd = normalize(mix(a.fwd.xyz, b.fwd.xyz, f));
  g.pos = vec4f(mix(a.pos.xyz, b.pos.xyz, f) + fwd * (xr - x) / W.g.x, mix(a.pos.w, b.pos.w, f));
  g.fwd = vec4f(fwd, mix(a.fwd.w, b.fwd.w, f));
  g.up = vec4f(normalize(mix(a.up.xyz, b.up.xyz, f)), mix(a.up.w, b.up.w, f));
  return g;
}
/** Smoothed melody pitch relative to the song's melodic centre, -1 (an octave below) .. 1 (above); 0 in rests. */
fn melodyHeight(t: f32) -> f32 { return gestAt(t).fwd.w; }
/** How busy the melody is (smoothed attack density), 0..1. */
fn melodyActivity(t: f32) -> f32 { return gestAt(t).pos.w; }
/** The latest melodic attack, decaying over ~0.2 s, 0..1. */
fn melodyOnset(t: f32) -> f32 { return gestAt(t).up.w; }

struct LOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) nrm: vec3f,
  @location(2) a: vec4f,
  @location(3) @interpolate(flat) b: vec4f,
  @location(4) @interpolate(flat) c: vec4f,
};

const NEAR: f32 = 0.05;
const FAR: f32 = 400.0;

fn viewMat() -> mat4x4f {
  let eye = camEye();
  let f = normalize(camTarget() - eye);
  let s = normalize(cross(f, camUp()));
  let u = cross(s, f);
  return mat4x4f(vec4f(s.x, u.x, -f.x, 0.0), vec4f(s.y, u.y, -f.y, 0.0), vec4f(s.z, u.z, -f.z, 0.0), vec4f(-dot(s, eye), -dot(u, eye), dot(f, eye), 1.0));
}
fn projMat() -> mat4x4f {
  let fy = 1.0 / tan(0.5 * S.p[7].x);
  return mat4x4f(vec4f(fy / F.aspect, 0.0, 0.0, 0.0), vec4f(0.0, fy, 0.0, 0.0), vec4f(0.0, 0.0, FAR / (NEAR - FAR), -1.0), vec4f(0.0, 0.0, NEAR * FAR / (NEAR - FAR), 0.0));
}
fn toClip(p: vec3f) -> vec4f { return projMat() * viewMat() * vec4f(p, 1.0); }
fn hidden() -> LOut { var o: LOut; o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
/** Quad corner helpers for 6-vertex quads. */
fn qu(c: u32) -> f32 { var a = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0); return a[c]; }
fn qv(c: u32) -> f32 { var a = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0); return a[c]; }
/** A camera-facing strip between a and b, half-width w (world units). v in [0,1] across. */
fn stripPoint(a: vec3f, b: vec3f, u: f32, v: f32, w: f32) -> vec3f {
  let p = mix(a, b, u);
  let side = normalize(cross(b - a + vec3f(0.0, 1e-5, 1e-5), camEye() - p));
  return p + side * (v * 2.0 - 1.0) * w;
}
/** Screen-constant line half-width at p (S.p[6].w is the fraction of screen height). */
fn lineW(p: vec3f) -> f32 { return length(camEye() - p) * S.p[6].w; }
/** Orthonormal frame around a tangent, using the layout's up. */
fn frameX(t: f32, tng: vec3f) -> vec3f { var r = LUp(t); if (abs(dot(r, tng)) > 0.95) { r = vec3f(1.0, 0.0, 0.0); } return normalize(cross(tng, r)); }

/** Hue of a pitch on the circle of fifths, so chord tones and keys have stable, related colours. */
fn pitchHue(pitch: f32) -> f32 { return fract(floor(pitch + 0.5) * 7.0 / 12.0); }
/** How far into the past world surfaces reach: behind the camera, so you are inside them, never looking at their edge. */
fn worldPast() -> f32 { return max(S.p[1].x, S.p[2].x * 1.7 + 1.0); }
/** The song time a world point belongs to: its projection onto the path near it (two refinements). */
fn journeyTime(wp: vec3f) -> f32 {
  let d0 = W.cd.xyz;
  var t = F.songTime + dot(wp - W.cc.xyz, d0) / max(dot(d0, d0), 1e-6);
  let c = LCenter(t);
  let d = LCenter(t + 0.05) - c;
  t += dot(wp - c, d) / max(dot(d, d), 1e-6) * 0.05;
  return t;
}
fn roleLane(role: u32) -> f32 { return select(select(0.55, -1.0, role == 1u), 0.0, role == 0u); }
/** How "lit" a moment is relative to the playhead: full at/behind it (fading), dim ahead. */
fn playLight(dt: f32) -> f32 { return select(exp(-dt * 0.45) * 0.18, exp(dt / max(S.p[1].x * 0.6, 0.2)), dt <= 0.0); }


/** Pitch class of chord tone k (0 root, 1 third, 2 fifth). */
fn chordPc(c: ChordE, k: u32) -> f32 {
  let third = select(3.0, 4.0, c.quality < 1.5);
  let fifth = select(7.0, 6.0, c.quality > 2.5);
  var iv = array<f32, 3>(0.0, third, fifth);
  return fmod(c.root + iv[k % 3u], 12.0);
}
/** Angle of a pitch class on the circle of fifths: major and minor triads make different shapes. */
fn fifthsAng(pc: f32) -> f32 { return fmod(pc * 7.0, 12.0) / 12.0 * TAU; }
/** A point in the plane across the time axis at t (facing the camera for flow layouts). */
fn emblemPoint(t: f32, ang: f32, r: f32, lift: f32) -> vec3f {
  let ctr = LCenter(t) + LUp(t) * lift;
  var ax = LCenter(t + 0.05) - LCenter(t);
  if (length(ax) < 1e-4) { ax = camEye() - ctr; }
  ax = normalize(ax);
  let ex = frameX(t, ax);
  let ey = cross(ax, ex);
  return ctr + (ex * cos(ang) + ey * sin(ang)) * r;
}

/** Fog toward the background; the near field stays crisp, distance dissolves into the space. */
fn fogged(c: vec3f, wp: vec3f) -> vec3f {
  let v = wp - camEye();
  let d = length(v);
  // A page fogs more gently than a dark space, so ink stays crisp further away.
  let k = d * S.p[3].z * select(1.0, 0.6, MATERIAL == 3u);
  return mix(c, bgColor(v / d), 1.0 - exp(-k * (0.55 + 0.45 * k)));
}

/**
 * Studio light rig, fixed to the camera so every layout reads with the same modelling:
 * a key from upper left, a soft fill from the right and a rim from behind.
 */
struct CoreRig { key: vec3f, kx: vec3f, ky: vec3f, fill: vec3f, rim: vec3f, up: vec3f };
fn core_rig() -> CoreRig {
  let f = normalize(camTarget() - camEye());
  let s = normalize(cross(f, camUp()));
  let u = cross(s, f);
  var r: CoreRig;
  r.key = normalize(u * 0.8 - s * 0.55 - f * 0.45);
  r.kx = normalize(cross(r.key, u));
  r.ky = cross(r.kx, r.key);
  r.fill = normalize(s * 0.75 - u * 0.15 - f * 0.65);
  r.rim = normalize(f * 0.8 + u * 0.45 + s * 0.4);
  r.up = u;
  return r;
}
/** Key light: near-white, warmed by the palette's highlight. */
fn core_keyCol() -> vec3f { return mix(vec3f(1.0, 0.95, 0.88), F.pal3.rgb / max(luma(F.pal3.rgb), 0.05), 0.25); }
/** Rim light carries the harmony: the colour of the chord sounding now. */
fn core_rimCol() -> vec3f {
  let ch = chordAtT(0.0);
  let h = select(S.p[3].x + 0.5, S.p[3].x + pitchHue(ch.x * 13.0 - 1.0) * 0.55 + 0.5, ch.x > 0.02);
  return palL(h, 0.9);
}
/** Soft environment light from the background around a normal, with its chroma tempered. */
fn core_amb(n: vec3f) -> vec3f {
  let e = bgColor(n);
  let l = luma(e);
  return mix(vec3f(1.0), e / max(l, 1e-4), 0.55) * (0.035 + min(l * 1.4, 0.55));
}
/** Reflected environment: the background plus the rig's lights seen as soft boxes. */
fn core_refl(r: vec3f, rough: f32, rg: CoreRig, keyC: vec3f) -> vec3f {
  let w = 0.015 + rough * 0.5;
  let kz = dot(r, rg.key);
  let qx = abs(dot(r, rg.kx));
  let qy = abs(dot(r, rg.ky));
  // A tall strip box for the key and an overhead box; edges soften with roughness.
  let kb = smoothstep(0.13 + w, 0.13, qx) * smoothstep(0.42 + w, 0.42, qy) * step(0.0, kz);
  let sky = sat(dot(r, rg.up) * 0.5 + 0.5);
  let e = bgColor(r);
  let skyBox = smoothstep(0.8 - rough * 0.3, 0.97, sky) * 0.2 + sky * sky * 0.012;
  return e * (1.0 + 1.5 / (1.0 + luma(e) * 30.0)) + keyC * (kb * 2.2 * (1.0 - rough * 0.6) + skyBox * (1.0 - rough * 0.5));
}
/** GGX key specular (cosine included). */
fn core_ggx(n: vec3f, v: vec3f, l: vec3f, rough: f32, f0: vec3f) -> vec3f {
  let h = normalize(v + l);
  let nl = sat(dot(n, l));
  let nv = max(dot(n, v), 1e-3);
  let nh = sat(dot(n, h));
  let a = rough * rough;
  let a2 = a * a;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  let G = nv / (nv * (1.0 - k) + k) * nl / (nl * (1.0 - k) + k);
  let Fh = f0 + (1.0 - f0) * pow(1.0 - sat(dot(v, h)), 5.0);
  return min(D * G * Fh / (4.0 * nv), vec3f(6.0));
}
/** Emitted light with a soft shoulder, so ignitions bloom without blowing out the frame. */
fn core_emis(e: vec3f) -> vec3f { return e / (1.0 + luma(e) * 0.14); }
/**
 * Printing-ink transmittance for a colour: saturated colours print as a confident mid-tone pigment,
 * neutral ones as graphite. luma is capped so yellows read as ochre on the page.
 */
fn core_ink(c: vec3f, neutral: f32) -> vec3f {
  let mx = max(max(c.r, c.g), max(c.b, 1e-4));
  let mn = min(min(c.r, c.g), c.b);
  let chroma = c / mx;
  var t = pow(chroma, vec3f(2.6));
  t = t * min(1.0, 0.38 / max(luma(t), 1e-3));
  return mix(vec3f(neutral), t, smoothstep(0.05, 0.6, (mx - mn) / mx));
}

/** Material response shared by all solid layers. emis = emitted light. */
fn shade(base: vec3f, emis: vec3f, n0: vec3f, wp: vec3f) -> vec3f {
  let eye = camEye();
  let v = normalize(eye - wp);
  var n = n0;
  if (dot(n, v) < 0.0) { n = -n; }
  let nv = max(dot(n, v), 1e-3);
  let rg = core_rig();
  let keyC = core_keyCol();
  let difK = sat(dot(n, rg.key));
  let fre = pow(1.0 - nv, 5.0);
  if (MATERIAL == 3u) {
    // Ink on a page: unlit notes print as dark ink, sounding ones as vivid pigment; a matte key
    // models the form and grazing edges darken into a drawn contour.
    let page = bgColor(-v);
    let lit = smoothstep(0.2, 1.2, luma(emis));
    let hue = emis + base * 0.05;
    let t = mix(core_ink(hue, 0.06) * 0.14 + 0.015, core_ink(hue, 0.16), lit);
    let c = page * t * (0.6 + 0.4 * difK) * (1.0 - 0.6 * pow(1.0 - nv, 2.5));
    return fogged(c, wp);
  }
  let alb = base / max(1.0, luma(base) / 0.7);
  let r = reflect(-v, n);
  // Depth cueing: reflected light thins out with distance before the fog takes over.
  let cue = 1.0 - 0.35 * sat(length(eye - wp) * S.p[3].z * 1.2);
  let rimC = core_rimCol();
  // Rim only where a surface turns toward the back light, so broad floors at grazing angles stay calm.
  let rim = pow(1.0 - nv, 3.0) * sat(dot(n, rg.rim));
  var em = core_emis(emis);
  var c: vec3f;
  if (MATERIAL == 0u) {
    // Glass: a dark tinted body; light lives in the Fresnel reflection, the soft boxes and the emission.
    let Fv = 0.04 + 0.66 * fre;
    let body = alb * (0.05 + 0.12 * difK) * (1.0 - Fv);
    let spec = core_ggx(n, v, rg.key, 0.16, vec3f(0.04)) * keyC * 0.5;
    c = body + spec + core_refl(r, 0.04, rg, keyC) * Fv * 1.6 + rimC * rim * 0.45;
    // Light glowing inside a volume: a longer path through the core than at the edge.
    em = em * (0.5 + 0.5 * nv);
  } else if (MATERIAL == 1u) {
    // Satin: wrapped diffuse, a broad GGX sheen and a cloth-like grazing glow in the base colour.
    let f0 = vec3f(0.04);
    let Fv = f0 + (1.0 - f0) * fre;
    let wrap = sat((dot(n, rg.key) + 0.35) / 1.35);
    let dif = alb * (keyC * wrap * 0.7 + core_amb(n) + keyC * sat(dot(n, rg.fill)) * 0.12) * (1.0 - Fv);
    let spec = core_ggx(n, v, rg.key, 0.42, f0) * keyC * 0.8;
    em = em * (0.8 + 0.2 * nv);
    c = dif + spec + core_refl(r, 0.55, rg, keyC) * Fv * 0.5 + alb * rim * 0.35 + rimC * rim * 0.15;
  } else {
    // Chrome: no diffuse; a metal tinted by the note, mirroring the space and the rig.
    let f0 = mix(vec3f(0.9), alb / max(max(alb.r, max(alb.g, alb.b)), 1e-3), 0.4);
    let Fv = f0 + (1.0 - f0) * fre;
    c = core_refl(r, 0.1, rg, keyC) * Fv + core_ggx(n, v, rg.key, 0.2, f0) * keyC * 0.25 + rimC * rim * 0.2;
    em = em * (0.4 + 0.6 * nv);
  }
  return fogged(c * cue + em, wp);
}
/**
 * Emitted light for additive layers. Distance absorbs light (additive output must not add fog colour).
 * On a light page light prints instead: it subtracts the complement of its hue from the page beneath.
 * Negative values are safe: the post feedback pass clamps the scene before bloom and exposure.
 */
fn glowOut(c: vec3f, wp: vec3f) -> vec4f {
  let v = wp - camEye();
  let d = length(v);
  let k = d * S.p[3].z * select(1.0, 0.6, MATERIAL == 3u);
  let tr = exp(-k * (0.55 + 0.45 * k));
  let g = core_emis(c) * tr;
  let page = bgColor(v / d);
  let pr = select(smoothstep(0.12, 0.3, luma(page)), 1.0, MATERIAL == 3u);
  if (pr <= 0.0) { return vec4f(g, 1.0); }
  let a = (1.0 - exp(-luma(c) * 1.8)) * tr;
  return vec4f(mix(g, page * (core_ink(c, 0.3) - 1.0) * a * 0.9, pr), 1.0);
}

struct BgOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsBg(@builtin(vertex_index) i: u32) -> BgOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: BgOut;
  o.pos = vec4f(p * 2.0 - 1.0, 1.0, 1.0);
  o.uv = p * 2.0 - 1.0;
  return o;
}
@fragment fn fsBg(in: BgOut) -> @location(0) vec4f {
  let eye = camEye();
  let f = normalize(camTarget() - eye);
  let s = normalize(cross(f, camUp()));
  let u = cross(s, f);
  let th = tan(0.5 * S.p[7].x);
  let rd = normalize(f + s * in.uv.x * th * F.aspect + u * in.uv.y * th);
  return vec4f(bgColor(rd), 1.0);
}
`;

/**
 * Fragment entry for a layer. In a journey, each pixel takes its layer's presence at the song time
 * of its own place on the path: light fades in and out across a bar, solid geometry begins and ends
 * at a clean edge (the shore of a sea, the first arch of a nave).
 */
function fragmentEntry(program: SculptProgram, l: LayerDef): string {
  const id = wgslId(l.id);
  const head = `@fragment fn fsL_${id}(in: LOut) -> @location(0) vec4f {`;
  if (!program.journey) return `${head} return fs_${id}(in); }`;
  const slot = program.layers.indexOf(l);
  const apply = l.blend === 'opaque' ? 'if (pr < 0.5) { discard; }\n  return c;' : 'return vec4f(c.rgb * pr, c.a);';
  return `${head}
  let c = fs_${id}(in);
  let pr = journeyAt(${slot}u, journeyTime(in.wp));
  ${apply}
}`;
}

/**
 * Cameras are evaluated once per frame by a one-thread compute pass (cameras can be expensive: the
 * journey camera samples the melodic gesture dozens of times) and copied into the window uniform;
 * every other stage reads the cached values.
 */
const CAM_CACHED = /* wgsl */ `
fn camEye() -> vec3f { return W.ce.xyz; }
fn camTarget() -> vec3f { return W.ct.xyz; }
fn camUp() -> vec3f { return W.cu.xyz; }`;
const CAM_PASS = /* wgsl */ `
fn camEye() -> vec3f { return camEyeRaw(); }
fn camTarget() -> vec3f { return camTargetRaw(); }
fn camUp() -> vec3f { return camUpRaw(); }
@group(2) @binding(0) var<storage, read_write> camOut: array<vec4f, 5>;
@compute @workgroup_size(1) fn csCam() {
  camOut[0] = vec4f(camEyeRaw(), 0.0);
  camOut[1] = vec4f(camTargetRaw(), 0.0);
  camOut[2] = vec4f(normalize(camUpRaw()), 0.0);
  let c = LCenter(F.songTime);
  camOut[3] = vec4f(c, 0.0);
  camOut[4] = vec4f((LCenter(F.songTime + 0.05) - c) / 0.05, 0.0);
}`;
/** Byte offset of the cached camera in the window uniform. */
const WIN_CAM_OFFSET = 64;

function moduleCode(program: SculptProgram, kind: 'render' | 'sim' | 'cam'): string {
  const blocks = program.blocksWgsl.replace(/fn cam(Eye|Target|Up)\(/g, 'fn cam$1Raw(');
  if (kind === 'cam') return `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${blocks}\n${CORE_WGSL}\n${CAM_PASS}`;
  const compute = kind === 'sim';
  const particles = program.layers.filter((l) => l.source === 'particles');
  const access = compute ? 'read_write' : 'read';
  const pdecl = particles.map((l, i) => `@group(2) @binding(${i}) var<storage, ${access}> pstate_${wgslId(l.id)}: array<Particle>;`).join('\n');
  const entries = compute
    ? particles
        .map(
          (l) => `@compute @workgroup_size(64) fn csL_${wgslId(l.id)}(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&pstate_${wgslId(l.id)})) { return; }
  var p = pstate_${wgslId(l.id)}[i];
  sim_${wgslId(l.id)}(i, &p);
  pstate_${wgslId(l.id)}[i] = p;
}`,
        )
        .join('\n')
    : program.layers
        .map(
          (l) => `@vertex fn vsL_${wgslId(l.id)}(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LOut { return vs_${wgslId(l.id)}(vi, ii); }
${fragmentEntry(program, l)}`,
        )
        .join('\n');
  return `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${blocks}\n${CORE_WGSL}\n${CAM_CACHED}\n${pdecl}\n${program.layers.map((l) => l.wgsl).join('\n')}\n${entries}`;
}

export function sculptScene(program: SculptProgram): SceneFactory {
  return {
    meta: program.meta,
    async create(device, shared) {
      const particleLayers = program.layers.filter((l) => l.source === 'particles');
      const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
      const eventsLayout = device.createBindGroupLayout({
        entries: [
          ...[0, 1, 2, 4, 5].map((binding) => ({ binding, visibility: vis, buffer: { type: 'read-only-storage' as const } })),
          { binding: 3, visibility: vis, buffer: { type: 'uniform' as const } },
        ],
      });
      const pLayoutRead = device.createBindGroupLayout({
        entries: particleLayers.map((_, binding) => ({ binding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' as const } })),
      });
      const pLayoutWrite = device.createBindGroupLayout({
        entries: particleLayers.map((_, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } })),
      });
      const renderModule = await compileModule(device, moduleCode(program, 'render'), program.meta.id);
      const computeModule = particleLayers.length ? await compileModule(device, moduleCode(program, 'sim'), `${program.meta.id}:sim`) : null;
      const camModule = await compileModule(device, moduleCode(program, 'cam'), `${program.meta.id}:cam`);
      const camLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
      const camPipe = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, eventsLayout, camLayout] }),
        compute: { module: camModule, entryPoint: 'csCam' },
      });
      const renderLayout = device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, eventsLayout, pLayoutRead] });
      const computeLayout = device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, eventsLayout, pLayoutWrite] });
      const additive: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
      const make = (vs: string, fs: string, blend: GPUBlendState | undefined, depthWrite: boolean, depthCompare: GPUCompareFunction) =>
        device.createRenderPipelineAsync({
          label: `${program.meta.id}:${vs}`,
          layout: renderLayout,
          vertex: { module: renderModule, entryPoint: vs },
          fragment: { module: renderModule, entryPoint: fs, targets: [{ format: HDR_FORMAT, blend }] },
          primitive: { topology: 'triangle-list' },
          depthStencil: { format: 'depth24plus', depthWriteEnabled: depthWrite, depthCompare },
          multisample: { count: SAMPLES },
        });
      const bg = await make('vsBg', 'fsBg', undefined, false, 'always');
      const layerPipes = await Promise.all(
        program.layers.map((l) =>
          l.blend === 'opaque'
            ? make(`vsL_${wgslId(l.id)}`, `fsL_${wgslId(l.id)}`, undefined, true, 'less')
            : make(`vsL_${wgslId(l.id)}`, `fsL_${wgslId(l.id)}`, additive, false, 'less'),
        ),
      );
      const simPipes = computeModule
        ? await Promise.all(
            particleLayers.map((l) =>
              device.createComputePipelineAsync({ layout: computeLayout, compute: { module: computeModule, entryPoint: `csL_${wgslId(l.id)}` } }),
            ),
          )
        : [];
      return new SculptInstance(device, shared, program, { bg, layerPipes, simPipes, camPipe }, { eventsLayout, pLayoutRead, pLayoutWrite, camLayout });
    },
  };
}

class SculptInstance implements SceneInstance {
  readonly meta: SceneMeta;
  private readonly params = new Float32Array(SCENE_LAYOUT.size / 4);
  private readonly paramBuffer: GPUBuffer;
  private readonly winBuffer: GPUBuffer;
  private readonly win = new Float32Array(16);
  private readonly journeyBuffer: GPUBuffer;
  private readonly camBuffer: GPUBuffer;
  private readonly camGroup: GPUBindGroup;
  /** Per layer: whether it is present anywhere in this frame's window (journeys skip absent layers). */
  private readonly live: boolean[];
  private readonly group0: GPUBindGroup;
  private readonly eventsGroup: GPUBindGroup;
  private readonly pRead: GPUBindGroup;
  private readonly pWrite: GPUBindGroup;
  private readonly pBuffers: GPUBuffer[];
  private msaa: GPUTexture | null = null;
  private depth: GPUTexture | null = null;
  private past = 2;
  private future = 10;
  private now = 0;
  private dt = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly shared: SharedResources,
    private readonly program: SculptProgram,
    private readonly pipes: { bg: GPURenderPipeline; layerPipes: GPURenderPipeline[]; simPipes: GPUComputePipeline[]; camPipe: GPUComputePipeline },
    layouts: { eventsLayout: GPUBindGroupLayout; pLayoutRead: GPUBindGroupLayout; pLayoutWrite: GPUBindGroupLayout; camLayout: GPUBindGroupLayout },
  ) {
    this.meta = program.meta;
    this.paramBuffer = shared.createSceneParamBuffer(`${program.meta.id}-params`);
    this.group0 = shared.createSceneBindGroup(this.paramBuffer, program.meta.id);
    this.winBuffer = device.createBuffer({ size: WIN_CAM_OFFSET + 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.camBuffer = device.createBuffer({ label: `${program.meta.id}-cam`, size: 80, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.camGroup = device.createBindGroup({ layout: layouts.camLayout, entries: [{ binding: 0, resource: { buffer: this.camBuffer } }] });
    const jt = program.journey ?? new Float32Array(JOURNEY_FLOATS);
    this.journeyBuffer = device.createBuffer({ label: `${program.meta.id}-journey`, size: Math.max(64, jt.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.journeyBuffer, 0, jt);
    this.live = program.layers.map(() => true);
    const ev = shared.events;
    this.eventsGroup = device.createBindGroup({
      layout: layouts.eventsLayout,
      entries: [
        { binding: 0, resource: { buffer: ev.notes } },
        { binding: 1, resource: { buffer: ev.chords } },
        { binding: 2, resource: { buffer: ev.hits } },
        { binding: 3, resource: { buffer: this.winBuffer } },
        { binding: 4, resource: { buffer: ev.gesture } },
        { binding: 5, resource: { buffer: this.journeyBuffer } },
      ],
    });
    const particleLayers = program.layers.filter((l) => l.source === 'particles');
    this.pBuffers = particleLayers.map((l) => device.createBuffer({ label: `${l.id}-particles`, size: Math.max(32, (l.particles ?? 0) * 32), usage: GPUBufferUsage.STORAGE }));
    this.pRead = device.createBindGroup({ layout: layouts.pLayoutRead, entries: this.pBuffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    this.pWrite = device.createBindGroup({ layout: layouts.pLayoutWrite, entries: this.pBuffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
  }

  update(ctx: SceneUpdateContext): void {
    const p = this.params;
    for (let i = 0; i < 32; i++) p[i] = ctx.dna[i] ?? 0;
    p[20] = ctx.music.kick;
    p[21] = ctx.music.snare;
    p[22] = ctx.music.beatPulse;
    p[23] = ctx.music.dropPulse;
    this.past = p[4] || 2;
    this.future = p[5] || 10;
    this.now = ctx.music.time;
    this.dt = ctx.dt;
    this.device.queue.writeBuffer(this.paramBuffer, 0, p);
  }

  /** Journeys: a layer is drawn and simulated only if it is present somewhere from just behind the camera to the visible future. */
  private updateLive(): void {
    const jt = this.program.journey;
    if (!jt) return;
    const rows = jt.length / JOURNEY_FLOATS;
    const r0 = Math.max(0, Math.floor((this.now - 10) * JOURNEY_RATE));
    const r1 = Math.min(rows - 1, Math.ceil((this.now + this.future + 2) * JOURNEY_RATE));
    this.live.forEach((_, i) => {
      let on = false;
      for (let r = r0; r <= r1 && !on; r++) on = jt[r * JOURNEY_FLOATS + i] > 0.001;
      this.live[i] = on;
    });
  }

  private ensureTargets(w: number, h: number): void {
    if (this.msaa && this.msaa.width === w && this.msaa.height === h) return;
    this.msaa?.destroy();
    this.depth?.destroy();
    this.msaa = this.device.createTexture({ size: [w, h], format: HDR_FORMAT, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    this.ensureTargets(width, height);
    const ev = this.shared.events;
    const t0 = this.now - this.past - 0.5;
    const t1 = this.now + this.future + 0.5;
    const nr = ev.notesIn(t0, t1);
    const cr = ev.chordsIn(t0, t1);
    const hr = ev.hitsIn(this.now - 3, t1);
    this.win.set([nr.first, nr.count, cr.first, cr.count, hr.first, hr.count, this.now, Math.min(this.dt, 1 / 20), GESTURE_RATE, ev.gestureRows, 0, 0, JOURNEY_RATE, this.program.journey ? this.program.journey.length / JOURNEY_FLOATS : 0, 0, 0]);
    this.updateLive();
    this.device.queue.writeBuffer(this.winBuffer, 0, this.win);

    const cam = encoder.beginComputePass({ label: `${this.meta.id}:cam` });
    cam.setBindGroup(0, this.group0);
    cam.setBindGroup(1, this.eventsGroup);
    cam.setBindGroup(2, this.camGroup);
    cam.setPipeline(this.pipes.camPipe);
    cam.dispatchWorkgroups(1);
    cam.end();
    encoder.copyBufferToBuffer(this.camBuffer, 0, this.winBuffer, WIN_CAM_OFFSET, 80);

    const particleLayers = this.program.layers.filter((l) => l.source === 'particles');
    if (particleLayers.length) {
      const cp = encoder.beginComputePass({ label: `${this.meta.id}:sim` });
      cp.setBindGroup(0, this.group0);
      cp.setBindGroup(1, this.eventsGroup);
      cp.setBindGroup(2, this.pWrite);
      particleLayers.forEach((l, i) => {
        if (!this.live[this.program.layers.indexOf(l)]) return;
        cp.setPipeline(this.pipes.simPipes[i]);
        cp.dispatchWorkgroups(Math.ceil((l.particles ?? 0) / 64));
      });
      cp.end();
    }

    const pass = encoder.beginRenderPass({
      label: this.meta.id,
      colorAttachments: [{ view: this.msaa!.createView(), resolveTarget: target, loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: this.depth!.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 },
    });
    pass.setBindGroup(0, this.group0);
    pass.setBindGroup(1, this.eventsGroup);
    pass.setBindGroup(2, this.pRead);
    pass.setPipeline(this.pipes.bg);
    pass.draw(3);
    // Opaque layers first (depth), then additive light.
    const order = this.program.layers.map((l, i) => ({ l, i })).sort((a, b) => (a.l.blend === b.l.blend ? 0 : a.l.blend === 'opaque' ? -1 : 1));
    for (const { l, i } of order) {
      const range =
        l.source === 'notes' ? nr : l.source === 'chords' ? cr : l.source === 'hits' ? hr : l.source === 'particles' ? { first: 0, count: l.particles ?? 0 } : { first: 0, count: 1 };
      if (!range.count || !this.live[i]) continue;
      pass.setPipeline(this.pipes.layerPipes[i]);
      pass.draw(l.verts, range.count, 0, range.first);
    }
    pass.end();
  }

  destroy(): void {
    this.paramBuffer.destroy();
    this.winBuffer.destroy();
    this.journeyBuffer.destroy();
    this.camBuffer.destroy();
    this.pBuffers.forEach((b) => b.destroy());
    this.msaa?.destroy();
    this.depth?.destroy();
  }
}
