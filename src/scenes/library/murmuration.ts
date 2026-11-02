import { compileModule } from '../../gpu/context';
import { SCENE_LAYOUT } from '../../gpu/frameLayout';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { lookAtPerspective, type Vec3 } from '../math';
import { Morph, wave } from '../morph';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Murmuration: a quarter million motes of light that flock into flowing surfaces. Each mote owns
 * a latent coordinate on a formation and chases its slot with a soft spring through curl
 * turbulence, so the swarm lags, streams and folds like a starling murmuration, but what it draws
 * is abstract: folding sheets, lobed shells, vortex funnels, rings, a torus knot and a helicoid,
 * blended continuously. Some motes ride contour lines of the surface, so it reads as fine
 * filaments of light over a softer haze of motes.
 *
 * Every shape parameter is a morph coordinate: 0-1 the formation blend (which surfaces and how
 * pure), 2-3 fold frequency and depth, 4 the vortex / helicoid twist, 5 ring radius and tube,
 * 6-7 anisotropy and orientation. Motion is a steady flow (morph.travel); beats only send light
 * through the swarm:
 * - kick: a broad shell of warm light expanding from the camera out through the swarm;
 * - snare: a sharp plane of a second colour sweeping across it, sparkling on scattered motes;
 * - melody: a band at the note's pitch height lights in the note's colour, running outward from
 *   the axis of the formation;
 * - chords lean the shape toward their region and turn the hue; energy sets the flow pace.
 * Every front's light, paint, glints and lasting steps scale with its event's level squared (which
 * carries how loud the passage is), and each front's light swells in over a few frames, so a faint
 * intro motif sends a faint ripple through the swarm and a full-mix hit sweeps it.
 *
 * DNA: 0-1 start point and heading, 2 swarm size, 3 camera (outside close, within, below),
 * 4 line density, 5 palette offset, 6 turbulence (tight vs loose), 7 hue and orbit phase.
 */

const COUNT = 1 << 18;
const UVEC4 = 16;
const SHAPES = 6;
const TAU = Math.PI * 2;

const META: SceneMeta = {
  id: 'murmuration',
  name: 'Murmuration',
  // Out of the show: A ribbon of dots floating in a void: an object, not a world.
  auto: false,
  energy: [0, 0.6],
  mood: { valence: 0.6, arousal: 0.35 },
  genres: { ambient: 1, classical: 0.95, acoustic: 0.85, lofi: 0.75, pop: 0.6, jazz: 0.45, synthwave: 0.4 },
  trails: 0,
  sparse: true,
  kaleido: false,
};

const COMMON_PART = /* wgsl */ `
struct Particle { pos: vec4f, vel: vec4f };
fn viewProj() -> mat4x4f { return mat4x4f(S.p[0], S.p[1], S.p[2], S.p[3]); }
`;

// U layout:
//  0 centre xyz, scale        1 centre velocity xyz, active count
//  2 weights 0-3              3 weights 4-5, line fraction, line count
//  4 fold freq, fold depth, twist, ring radius
//  5 tube radius, lobe depth, lobe freq, thickness
//  6 anisotropy xyz, tau      7 yaw, pitch, roll, turbulence
//  8 spring, damp, turbulence phase, flow
//  9 eye xyz, kick age        10 snare age, lead age, note pitch, snare count
// 11 hue, kick start radius, brightness, near clearance
// 12 glow dir xyz, kick count
const WGSL = /* wgsl */ `
fn mu_dir(u: vec2f) -> vec3f {
  let z = u.y * 2.0 - 1.0;
  let r = sqrt(max(1.0 - z * z, 0.0));
  let a = u.x * TAU;
  return vec3f(cos(a) * r, z, sin(a) * r);
}

fn mu_shapePt(s: i32, u: vec3f, tau: f32) -> vec3f {
  let th = (u.z - 0.5) * U[5].w;
  switch s {
    case 0: {
      // Folding sheet.
      let a = u.x * 2.0 - 1.0;
      let b = u.y * 2.0 - 1.0;
      let f = U[4].x;
      let A = U[4].y;
      let y = A * sin(a * f * 1.3 + tau * 1.1) * cos(b * f - tau * 0.7) + 0.3 * A * sin((a + b) * f * 0.7 - tau * 0.5);
      return vec3f(a * 1.7, y + th * 0.6, b * 1.2);
    }
    case 1: {
      // Lobed shell.
      let d = mu_dir(u.xy);
      let lf = U[5].z;
      let r = 1.0 + U[5].y * sin(lf * d.x * 2.0 + tau) * sin(lf * d.y * 2.0 - tau * 0.6) * cos(lf * d.z * 1.5 + tau * 0.4);
      return d * r * 1.2 * (1.0 + th * 0.5);
    }
    case 2: {
      // Vortex funnel.
      let y = u.y * 2.0 - 1.0;
      let r = 0.25 + 0.65 * (y * 0.5 + 0.5) + 0.12 * sin(y * 3.0 + tau);
      let a = u.x * TAU + U[4].z * y * 1.5 + tau * 0.6 / (r + 0.3);
      return vec3f(cos(a), 0.0, sin(a)) * r * 1.35 * (1.0 + th) + vec3f(0.0, y * 1.25, 0.0);
    }
    case 3: {
      // Ring with a wave running round it.
      let a = u.x * TAU + tau * 0.6;
      let ph = u.y * TAU + tau * 0.4;
      let rr = U[5].x * (1.0 + th * 2.0);
      let R = U[4].w;
      return vec3f((R + rr * cos(ph)) * cos(a), rr * sin(ph) + 0.28 * sin(2.0 * a + tau), (R + rr * cos(ph)) * sin(a));
    }
    case 4: {
      // (2,3) torus knot ribbon.
      let t = u.x * TAU + tau * 0.25;
      let R0 = U[4].w * 0.8;
      let rc = R0 + 0.42 * cos(3.0 * t);
      let c = vec3f(rc * cos(2.0 * t), 0.42 * sin(3.0 * t), rc * sin(2.0 * t));
      let rad = normalize(vec3f(c.x, 0.0, c.z) + vec3f(1e-4, 0.0, 0.0));
      let ph = u.y * TAU;
      let rr = U[5].x * 0.55 * (1.0 + th * 2.0);
      return c + (rad * cos(ph) + vec3f(0.0, sin(ph), 0.0)) * rr;
    }
    default: {
      // Helicoid.
      let r = (u.x * 2.0 - 1.0) * 1.5;
      let y = (u.y * 2.0 - 1.0) * 1.2;
      let a = U[4].z * 1.3 * y + tau * 0.5;
      return vec3f(r * cos(a), y + th * 0.5, r * sin(a));
    }
  }
}

fn mu_weight(i: i32) -> f32 {
  if (i < 4) { return U[2][i]; }
  return U[3][i - 4];
}

/** Latent coordinate of mote idx (lines quantise the second coordinate). */
fn mu_latent(idx: u32) -> vec4f {
  var u = hashU3(idx * 2654435761u + 101u);
  let hl = hashU(idx * 911u + 7u);
  let onLine = hl < U[3].z;
  if (onLine) {
    let n = U[3].w;
    u.y = (floor(u.y * n) + 0.5) / n;
    u.z = 0.5 + (u.z - 0.5) * 0.04;
  }
  return vec4f(u, select(0.0, 1.0, onLine));
}

fn mu_orient() -> mat3x3f { return rotY(U[7].x) * rotX(U[7].y) * rotZ(U[7].z); }

fn mu_slot(idx: u32) -> vec3f {
  let u = mu_latent(idx).xyz;
  let tau = U[6].w;
  var pt = vec3f(0.0);
  for (var i = 0; i < ${SHAPES}; i++) {
    let w = mu_weight(i);
    if (w > 0.0) { pt += w * mu_shapePt(i, u, tau); }
  }
  // Soft organic boundary, flowing with the travel.
  pt += noise4fast(pt * 0.8 + vec3f(tau * 0.3, 1.7, tau * 0.2)).xyz * 0.05;
  pt *= U[6].xyz;
  return U[0].xyz + mu_orient() * pt * U[0].w;
}

/** Melody band geometry shared by the paint (simulate) and the light on its front (shade). */
fn mu_band(pos: vec3f) -> vec2f {
  let sc = U[0].w;
  let rel = pos - U[0].xyz;
  let dy = (pos.y - (U[0].y + U[10].z * 0.95 * sc)) / (0.24 * sc);
  let hr = length(rel.xz) / sc;
  // x: inside the band behind its front, y: on the front itself.
  let fr = U[10].y * 14.0;
  let inBand = exp(-dy * dy);
  return vec2f(inBand * smoothstep(fr + 0.05, fr - 0.1, hr), inBand * exp(-(hr - fr) * (hr - fr) * 30.0));
}

fn simulate(idx: u32, p: ptr<function, Particle>) {
  if (f32(idx) >= U[1].w) {
    (*p).pos.w = 0.0;
    return;
  }
  let dt = min(F.dt, 1.0 / 30.0);
  let lat = mu_latent(idx);
  let desired = mu_slot(idx);
  var pos = (*p).pos.xyz;
  var vel = (*p).vel.xyz;
  // pos.w = 1 + paint strength, vel.w = painted hue offset: the melody's strokes stay on the motes.
  var paint = (*p).pos.w - 1.0;
  var phue = (*p).vel.w;
  if ((*p).pos.w <= 0.0) {
    pos = desired + (hashU3(idx * 3u + 77u) - 0.5) * 0.3;
    vel = U[1].xyz;
    paint = 0.0;
    phue = 0.0;
  }
  let hb = hashU(idx * 5u + 1u);
  let sc = U[0].w;
  let spring = U[8].x * (0.85 + 0.3 * hb);
  var acc = (desired - pos) * spring + (U[1].xyz - vel) * U[8].y;
  // Lines hold their shape; the haze streams more loosely around them.
  acc += curl3(pos / sc * 0.9 + vec3f(U[8].z, 0.0, 0.0)) * U[7].w * sc * U[8].w * select(1.0, 0.3, lat.w > 0.5);
  vel += acc * dt;
  let sp = length(vel);
  vel = vel / max(sp, 1e-5) * min(sp, 3.0 * sc);
  pos += vel * dt;
  // Each melody note paints the motes its band sweeps through in the note's colour, for good
  // (fading only over half a minute, so later phrases have room).
  // The paint is as strong as the note (U[13].z: its level squared); a weaker stroke over an older
  // one only tints it.
  let band = mu_band(pos).x * step(U[10].y, 1.5);
  let bl = band * U[13].z;
  if (band > 0.3 && bl > 0.005) {
    phue = mix(phue, 0.3 + 0.35 * U[10].z, bl / (paint + bl));
    paint = max(paint, bl);
  }
  paint *= exp(-dt / 30.0);
  (*p).pos = vec4f(pos, 1.0 + paint);
  (*p).vel = vec4f(vel, phue);
}

// ---------- shading ----------
struct MuShade { color: vec3f, size: f32 };

fn mu_shade(b: Particle, idx: u32) -> MuShade {
  let lat = mu_latent(idx);
  let h = hashU(idx * 7u + 3u);
  let sc = U[0].w;
  let c = U[0].xyz;
  let eye = U[9].xyz;
  let hue = U[11].x;
  let pos = b.pos.xyz;
  let rel = pos - c;
  let dEye = distance(pos, eye);
  var s: MuShade;
  let onLine = lat.w > 0.5;
  s.size = sc * select(0.011, 0.0085, onLine) * (0.75 + 0.5 * h);

  // Kick: a broad shell expands from the camera out through the swarm, and behind it the
  // colour gradient has stepped to its next state for good.
  let ka = U[9].w;
  let kr = U[11].y + ka * sc * 28.0;
  let kAhead = select(0.0, 1.0, dEye > kr);
  // U[12].w sums the kicks' levels squared; ahead of the front the latest kick (U[13].x) has not landed.
  let kStep = U[12].w - kAhead * U[13].x;
  let h0 = hue + 0.23 * kStep;
  let kx = (dEye - kr) / (sc * 0.45);
  let kFront = exp(-kx * kx) * exp(-ka * 1.5) * smoothstep(0.0, 0.1, ka) * U[13].x;

  // Base colour: a gradient across the surface, lines brighter than the haze.
  let along = lat.x;
  var col = palL(h0 + 0.55 * along + 0.2 * lat.y, select(0.07, 0.75, onLine));
  col = mix(col, palL(h0 + 0.5 + 0.25 * along, select(0.15, 0.6, onLine)), 0.35 * smoothstep(0.3, 1.0, lat.y));

  // Melody: the strokes each note painted onto the motes it swept through.
  // Every third contour line burns bright; behind each kick's front the lit set steps over by one.
  // A faint kick steps the lit set only part of the way (a blend toward the next set).
  let li = floor(lat.y * U[3].w);
  let ks = li + kStep;
  let kf = floor(ks);
  let litK = mix(select(0.3, 1.7, fmod(kf, 3.0) < 0.5), select(0.3, 1.7, fmod(kf + 1.0, 3.0) < 0.5), ks - kf);
  let lit = select(1.0, litK, onLine);
  col *= lit;
  let paint = sat(b.pos.w - 1.0);
  col = mix(col, palL(hue + b.vel.w, select(0.6, 1.8, onLine)), paint * 0.9);

  // Snare: a sharp plane sweeps across, and behind it a new scattering of motes glints in the
  // second colour (the set before it goes dark again).
  let sa = U[10].x;
  let sn = U[10].w;
  let sAng = sn * 2.39996 + 0.7;
  let sDir = normalize(vec3f(cos(sAng), 0.45 * sin(sn * 1.7), sin(sAng)));
  let sPos = -1.3 * sc + sa * sc * 26.0;
  let sd = dot(rel, sDir) - sPos;
  let ahead = sd > 0.0;
  let sSet = sn - select(0.0, 1.0, ahead);
  // Each set glints as strongly as its snare was (U[13].y this one, U[13].w the one before).
  let glint = step(0.85, hashU(idx * 31u + u32(sSet + 64.0) * 7919u)) * select(U[13].y, U[13].w, ahead);
  let sx = sd / (sc * 0.12);
  let sFront = exp(-sx * sx) * exp(-sa * 2.0) * smoothstep(0.0, 0.08, sa) * U[13].y;
  col = mix(col, palL(hue + 0.6, 2.2), glint * 0.9);
  s.size *= 1.0 + 0.6 * glint;

  // Light on the fronts themselves (accents only; the lasting change is above).
  col += palL(h0 + 0.08, 3.0) * kFront;
  col += mix(palL(hue + 0.6, 2.0), vec3f(3.0), 0.3) * sFront * (0.5 + 2.5 * glint);
  let bandL = mu_band(pos).y * exp(-U[10].y * 1.2) * smoothstep(0.0, 0.1, U[10].y) * U[13].z;
  col += palL(hue + 0.3 + 0.35 * U[10].z, 12.0) * bandL;

  // Depth: far motes sink into the background tone; clearance in front of the lens.
  let dc = distance(eye, c);
  let far = exp(-max(dEye - dc, 0.0) / (1.4 * sc));
  let near = smoothstep(U[11].w, U[11].w * 2.2, dEye);
  s.color = col * U[11].z * (0.35 + 0.65 * far) * near;
  return s;
}

// ---------- background: an abstract light field ----------
fn background(uv: vec2f, rd: vec3f) -> vec3f {
  let hue = U[11].x;
  let up = rd.y * 0.5 + 0.5;
  var c = palRampL(0.05 + 0.3 * up, 0.0025 + 0.006 * up);
  let g = max(dot(rd, U[12].xyz), 0.0);
  c += palL(hue + 0.45, 0.02) * pow(g, 3.0) + palL(hue + 0.5, 0.05) * pow(g, 18.0);
  c += palL(hue + 0.15, 0.006) * pow(max(-dot(rd, U[12].xyz), 0.0), 4.0);
  return c;
}
`;

class MurmurationInstance implements SceneInstance {
  readonly meta = META;
  private readonly params = new Float32Array(SCENE_LAYOUT.size / 4);
  private readonly u = new Float32Array(UVEC4 * 4);
  private readonly paramBuffer: GPUBuffer;
  private readonly uBuffer: GPUBuffer;
  private readonly group0: GPUBindGroup;
  private aspect = 16 / 9;
  private readonly morph = new Morph(1.6);
  private prev: Vec3 = [0, 0, 0];
  private prevTime = -1;
  private hx = 1;
  /** Kick levels squared, summed (the lasting colour step), and the last two snares' levels squared. */
  private kSum = 0;
  private kicks = -1;
  private snares = -1;
  private sPrev = 0;
  private sCur = 0;
  private hy = 0;

  constructor(
    private readonly device: GPUDevice,
    shared: SharedResources,
    private readonly pipes: { sim: GPUComputePipeline; draw: GPURenderPipeline; bg: GPURenderPipeline },
    private readonly buffers: GPUBuffer[],
    private readonly simGroup: GPUBindGroup,
    private readonly drawGroup: GPUBindGroup,
    uBuffer: GPUBuffer,
  ) {
    this.paramBuffer = shared.createSceneParamBuffer('murmuration-params');
    this.group0 = shared.createSceneBindGroup(this.paramBuffer, 'murmuration');
    this.uBuffer = uBuffer;
  }

  update(ctx: SceneUpdateContext): void {
    const m = ctx.music;
    const g = ctx.dna;
    const u = this.u;
    const morph = this.morph;
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    const travel = morph.travel;
    const tau = travel * 0.9 + g[7] * 20;

    const dt = ctx.time - this.prevTime;
    const jump = this.prevTime < 0 || dt <= 0 || dt > 0.25;
    this.prevTime = ctx.time;

    // Formation centre drifts on a slow steady path; the camera rides with it.
    const scale = 3.6 + 1.4 * g[2];
    const c: Vec3 = [Math.sin(tau * 0.21) * 0.6 * scale, Math.sin(tau * 0.17 + 1) * 0.25 * scale, Math.cos(tau * 0.13) * 0.6 * scale];
    const v: Vec3 = jump ? [0, 0, 0] : [(c[0] - this.prev[0]) / dt, (c[1] - this.prev[1]) / dt, (c[2] - this.prev[2]) / dt];
    this.prev = c;
    u.set([c[0], c[1], c[2], scale, v[0], v[1], v[2], Math.round(COUNT * (0.55 + 0.45 * g[2]))], 0);

    // Formation blend: six surfaces on a circle, a[0] travels round it, a[1] sets how pure.
    const sharp = wave(a[1], 1.5, 6);
    const raw = Array.from({ length: SHAPES }, (_, i) => Math.exp(sharp * (Math.cos(a[0] - (i * TAU) / SHAPES) - 1)));
    const cut = raw.map((x) => Math.max(0, x / raw.reduce((s, y) => s + y, 0) - 0.02));
    const sum = cut.reduce((s, x) => s + x, 0);
    for (let i = 0; i < SHAPES; i++) u[8 + i] = cut[i] / sum;
    u[14] = 0.65 + 0.25 * g[4];
    u[15] = Math.round(18 + 30 * g[4]);
    // Shape parameters.
    u[16] = wave(a[2], 1.3, 3.4);
    u[17] = wave(a[3], 0.25, 0.7);
    u[18] = wave(a[4], -2.6, 2.6);
    u[19] = wave(a[5], 0.95, 1.35);
    u[20] = wave(a[5] * 0.7 + a[6], 0.18, 0.5);
    u[21] = wave(a[3] + 0.6 * a[6], 0.08, 0.35);
    u[22] = wave(a[2] * 0.7 + 1.0, 1.2, 2.6);
    u[23] = wave(a[7], 0.05, 0.3);
    u[24] = wave(a[6], 0.8, 1.25);
    u[25] = wave(a[7] + 0.4 * a[5], 0.75, 1.2);
    u[26] = wave(a[6] * 0.7 + a[7] * 0.5, 0.8, 1.2);
    u[27] = tau;
    u[28] = a[4] * 0.6 + travel * 0.05;
    u[29] = 0.4 * Math.sin(a[5] * 0.8);
    u[30] = 0.35 * Math.sin(a[7] * 0.6);
    const loose = g[6];
    u[31] = 0.06 + 0.18 * loose;
    u[32] = 3.4 - 1.6 * loose;
    u[33] = 1.3 + 0.6 * (1 - loose);
    u[34] = travel * 0.12;
    u[35] = morph.flow;

    // Chord hue, eased round the wheel.
    const hueT = (m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : 0) * TAU;
    const kh = jump ? 1 : 1 - Math.exp(-dt / 1.2);
    this.hx += (Math.cos(hueT) - this.hx) * kh;
    this.hy += (Math.sin(hueT) - this.hy) * kh;
    const hue = g[5] + g[7] * 0.3 + 0.15 * (Math.atan2(this.hy, this.hx) / TAU);

    // ----- camera: a steady orbit, close enough that the swarm fills the frame -----
    const rig = Math.floor(g[3] * 3) % 3;
    const orb = travel * 0.22 + g[7] * TAU;
    let eye: Vec3;
    let target: Vec3 = [c[0], c[1], c[2]];
    let fovY = 1.0;
    let roll = 0.08 * Math.sin(travel * 0.07);
    if (rig === 0) {
      const r = 2.25 * scale;
      const el = 0.25 + 0.25 * Math.sin(travel * 0.09 + g[7] * 5);
      eye = [c[0] + Math.cos(orb) * Math.cos(el) * r, c[1] + Math.sin(el) * r, c[2] + Math.sin(orb) * Math.cos(el) * r];
    } else if (rig === 1) {
      // Within: in the outskirts of the swarm, looking across its heart.
      const r = 1.45 * scale;
      const el = 0.15 * Math.sin(travel * 0.11);
      eye = [c[0] + Math.cos(orb) * r, c[1] + Math.sin(el) * r, c[2] + Math.sin(orb) * r];
      target = [c[0] - Math.sin(orb) * 0.35 * scale, c[1], c[2] + Math.cos(orb) * 0.35 * scale];
      fovY = 1.2;
      roll = 0.15 * Math.sin(travel * 0.08);
    } else {
      // Below, looking up through it.
      const r = 2.1 * scale;
      eye = [c[0] + Math.cos(orb) * r, c[1] - 0.9 * scale, c[2] + Math.sin(orb) * r];
      target = [c[0], c[1] + 0.2 * scale, c[2]];
      fovY = 1.1;
    }
    const dc = Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]);
    u[36] = eye[0];
    u[37] = eye[1];
    u[38] = eye[2];
    u[39] = morph.kickAge;
    u[40] = morph.snareAge;
    u[41] = morph.leadAge;
    u[42] = morph.notePitch;
    u[43] = morph.snares % 64;
    u[44] = hue;
    u[45] = Math.max(0.25 * scale, dc - 1.5 * scale);
    u[46] = 0.022 * Math.sqrt(COUNT / u[7]) * (0.75 + 0.35 * ctx.intensity);
    u[47] = 0.32 * scale;
    const ga = g[7] * TAU + 2.0;
    const gd = [Math.cos(ga) * 0.8, 0.35, Math.sin(ga) * 0.8];
    const gl = Math.hypot(gd[0], gd[1], gd[2]);
    u[48] = gd[0] / gl;
    u[49] = gd[1] / gl;
    u[50] = gd[2] / gl;
    // Lasting kick steps, as strong as each kick was (mod 300: whole turns of hue and of the lit sets).
    if (this.kicks < 0 || morph.kicks < this.kicks) {
      this.kicks = morph.kicks;
      this.kSum = 0;
    } else if (morph.kicks !== this.kicks) {
      this.kicks = morph.kicks;
      this.kSum = (this.kSum + morph.kickLevel ** 2) % 300;
    }
    if (morph.snares !== this.snares) {
      this.sPrev = this.snares < 0 ? 0 : this.sCur;
      this.sCur = morph.snareLevel ** 2;
      this.snares = morph.snares;
    }
    u[51] = this.kSum;
    u[52] = morph.kickLevel ** 2;
    u[53] = this.sCur;
    u[54] = morph.noteLevel ** 2;
    u[55] = this.sPrev;

    const p = this.params;
    p.set(lookAtPerspective(eye, target, fovY, this.aspect, 0.05, 400, roll), 0);
    p[16] = eye[0];
    p[17] = eye[1];
    p[18] = eye[2];
    p[19] = Math.tan(fovY / 2);
    p[20] = target[0] - eye[0];
    p[21] = target[1] - eye[1];
    p[22] = target[2] - eye[2];
    p[23] = 0.025;
    this.device.queue.writeBuffer(this.paramBuffer, 0, p);
    this.device.queue.writeBuffer(this.uBuffer, 0, u);
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    this.aspect = width / height;
    const cp = encoder.beginComputePass({ label: 'murmuration-sim' });
    cp.setPipeline(this.pipes.sim);
    cp.setBindGroup(0, this.group0);
    cp.setBindGroup(1, this.simGroup);
    cp.dispatchWorkgroups(COUNT / 256);
    cp.end();
    const pass = encoder.beginRenderPass({
      label: 'murmuration',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setBindGroup(0, this.group0);
    pass.setBindGroup(1, this.drawGroup);
    pass.setPipeline(this.pipes.bg);
    pass.draw(3);
    pass.setPipeline(this.pipes.draw);
    pass.draw(6, COUNT);
    pass.end();
  }

  destroy(): void {
    this.paramBuffer.destroy();
    for (const b of this.buffers) b.destroy();
  }
}

const factory: SceneFactory = {
  meta: META,
  async create(device, shared) {
    const head = `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${COMMON_PART}`;
    const computeCode = `${head}
@group(1) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(1) @binding(1) var<uniform> U: array<vec4f, ${UVEC4}>;
${WGSL}
@compute @workgroup_size(256) fn cs(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&particles)) { return; }
  var p = particles[i];
  simulate(i, &p);
  particles[i] = p;
}`;
    const renderCode = `${head}
@group(1) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(1) var<uniform> U: array<vec4f, ${UVEC4}>;
${WGSL}
struct BOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) color: vec3f, @location(2) stretch: f32 };
@vertex fn vsB(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BOut {
  var o: BOut;
  let b = particles[ii];
  let vp = viewProj();
  let clip = vp * vec4f(b.pos.xyz, 1.0);
  let prevClip = vp * vec4f(b.pos.xyz - b.vel.xyz * S.p[5].w, 1.0);
  if (b.pos.w <= 0.0 || clip.w < 0.05 || prevClip.w < 0.05) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let sh = mu_shade(b, ii);
  let res = F.res;
  let a = clip.xy / clip.w * res * 0.5;
  let bb = prevClip.xy / prevClip.w * res * 0.5;
  let raw = sh.size * res.y * 0.5 / clip.w;
  let sizePx = clamp(raw, 1.1, 14.0);
  var dir = a - bb;
  let len = min(length(dir), 40.0);
  dir = select(vec2f(1.0, 0.0), dir / max(length(dir), 1e-5), len > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let halfLen = len * 0.5 + sizePx;
  let px = (a + bb) * 0.5 + dir * c.x * halfLen + nrm * c.y * sizePx;
  o.pos = vec4f(px / (res * 0.5) * clip.w, clip.z, clip.w);
  o.q = vec2f(c.x * halfLen / sizePx, c.y);
  o.stretch = halfLen / sizePx - 1.0;
  // Energy-conserving: sub-pixel motes fade instead of popping, long smears are dimmer per pixel.
  let cover = min(1.0, raw / 1.1);
  o.color = sh.color * cover * cover / (1.0 + len / (sizePx * 2.0));
  return o;
}
@fragment fn fsB(in: BOut) -> @location(0) vec4f {
  let d = vec2f(max(abs(in.q.x) - in.stretch, 0.0), in.q.y);
  return vec4f(in.color * exp(-dot(d, d) * 3.5), 1.0);
}
${FULLSCREEN_VS}
@fragment fn fsBg(in: VsOut) -> @location(0) vec4f {
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let fwd = normalize(S.p[5].xyz);
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, fwd);
  let rd = normalize(fwd + right * ndc.x * F.aspect * S.p[4].w + up * ndc.y * S.p[4].w);
  return vec4f(background(in.uv, rd), 1.0);
}`;
    const [cModule, rModule] = await Promise.all([
      compileModule(device, computeCode, 'murmuration-sim'),
      compileModule(device, renderCode, 'murmuration-draw'),
    ]);
    const layout = (storage: GPUBufferBindingType, vis: number) =>
      device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: vis, buffer: { type: storage } },
          { binding: 1, visibility: vis, buffer: { type: 'uniform' } },
        ],
      });
    const simLayout = layout('storage', GPUShaderStage.COMPUTE);
    const drawLayout = layout('read-only-storage', GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one' };
    const [sim, draw, bg] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'murmuration-sim',
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, simLayout] }),
        compute: { module: cModule, entryPoint: 'cs' },
      }),
      device.createRenderPipelineAsync({
        label: 'murmuration-draw',
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, drawLayout] }),
        vertex: { module: rModule, entryPoint: 'vsB' },
        fragment: { module: rModule, entryPoint: 'fsB', targets: [{ format: HDR_FORMAT, blend: { color: add, alpha: add } }] },
        primitive: { topology: 'triangle-list' },
      }),
      device.createRenderPipelineAsync({
        label: 'murmuration-bg',
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, drawLayout] }),
        vertex: { module: rModule, entryPoint: 'vs' },
        fragment: { module: rModule, entryPoint: 'fsBg', targets: [{ format: HDR_FORMAT }] },
      }),
    ]);
    const buffer = device.createBuffer({ label: 'murmuration-motes', size: COUNT * 32, usage: GPUBufferUsage.STORAGE });
    const uBuffer = device.createBuffer({ label: 'murmuration-u', size: UVEC4 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const group = (l: GPUBindGroupLayout) =>
      device.createBindGroup({ layout: l, entries: [{ binding: 0, resource: { buffer } }, { binding: 1, resource: { buffer: uBuffer } }] });
    return new MurmurationInstance(device, shared, { sim, draw, bg }, [buffer, uBuffer], group(simLayout), group(drawLayout), uBuffer);
  },
};

export default factory;
