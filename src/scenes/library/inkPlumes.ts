import { compileModule } from '../../gpu/context';
import { SCENE_LAYOUT } from '../../gpu/frameLayout';
import { HDR_FORMAT, type SharedResources } from '../../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../../gpu/shaders/common';
import { lookAtPerspective, type Vec3 } from '../math';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from '../types';

/**
 * Ink in Water: a million tiny, faint particles advected through a buoyant plume field.
 * Young ink rises laminar from its nozzle, then curl turbulence (frozen eddies carried up
 * with the plume) tears it into curls and tendrils. Kicks launch vortex rings: a puff of
 * fresh ink is wrapped onto a torus that rolls away under its own induced flow.
 *
 * Particles are drawn with premultiplied "over" blending so ink can absorb (dark dye in
 * pale water) as well as glow (luminous smoke on black).
 *
 * DNA
 *  0  emitter layout: single plume, row of plumes, ring of plumes, falling drops, colliding side jets
 *  1  plume style: laminar-to-turbulent, billowing, filamentary, swirling column
 *  2  ink density and grain (active count, particle size)
 *  3  camera: aquarium front, low angle up the plume, slow orbit, overhead macro
 *  4  medium / colour layering: multi-ink in clear water, sumi ink, luminous smoke, light-beam scatter
 *  5  how ink hue drifts with age and per emitter
 *  6  turbulence scale and flow speed
 *  7  hue offset, emitter jitter
 */

const COUNT = 1 << 20;
const UVEC4 = 25;
const RINGS = 4;

// Dropped from auto-direction: smoke plumes seen from outside a tank, mostly empty water or
// black around them, and the particle ink turns into blobs when the camera moves in. An
// unreachable energy range and mood with no genre affinity keep scoreScene() at the bottom of
// every ranking. Still available when pinned by hand.
const META: SceneMeta = {
  id: 'ink-plumes',
  name: 'Ink in Water',
  energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
  mood: { valence: -1, arousal: -1 },
  genres: {},
  trails: 0.2,
  sparse: false,
  kaleido: false,
};

const COMMON_PART = /* wgsl */ `
struct Particle { pos: vec4f, vel: vec4f };
fn viewProj() -> mat4x4f { return mat4x4f(S.p[0], S.p[1], S.p[2], S.p[3]); }
`;

const WGSL = /* wgsl */ `
fn ip_ring(j: i32, p: vec3f) -> vec3f {
  let g = U[12 + j].w;
  if (g <= 0.0) { return vec3f(0.0); }
  let ax = U[16 + j].xyz;
  let R = U[16 + j].w;
  let d = p - U[12 + j].xyz;
  let z = dot(d, ax);
  let rv = d - ax * z;
  let rho = length(rv);
  let er = rv / max(rho, 1e-4);
  let dr = rho - R;
  let core = 0.06 + 0.25 * R;
  let d2 = dr * dr + z * z;
  // Swirl around the core circle (forward through the middle), fading far from the ring.
  let fall = exp(-d2 / (R * R * 2.5));
  return (z * er - dr * ax) * g / (d2 + core * core) * fall * R;
}

fn ip_flow(p: vec3f, age: f32, src: i32) -> vec3f {
  let style = i32(U[20].z);
  let buoy = U[21].x;
  let turb = U[21].y;
  let sc = U[21].z;
  let jet = U[6 + src];
  var v = vec3f(0.0, buoy * (0.35 + 0.65 * exp(-age * 0.18)), 0.0);
  v += jet.xyz * exp(-age * 1.1);
  // Entrainment: the plume widens into a cone as it rises.
  let rel = p - U[src].xyz;
  let along = normalize(jet.xyz + vec3f(0.0, buoy, 0.0) + vec3f(1e-4));
  let lat = rel - along * dot(rel, along);
  v += lat * U[24].z * min(age, 3.0);
  // Frozen eddies carried up with the plume; turbulence grows as the ink ages.
  let grow = min(0.15 + age * 0.45, 1.6);
  let q = p * sc - vec3f(0.0, F.time * 0.22 * sign(buoy) * sc, 0.0) + vec3f(F.warp * 0.03, 0.0, 0.0);
  var amp = turb * grow;
  // Large slow billows that fold the whole plume.
  v += curl3(q * 0.45 + vec3f(31.0, 0.0, 0.0)) * turb * grow * 1.1;
  if (style == 1) { amp *= 1.4; }
  v += curl3(q) * amp;
  if (style == 2) {
    v += curl3(q * 2.9 + vec3f(13.0)) * amp * (0.55 + 0.6 * F.hat);
  } else {
    v += curl3(q * 2.3 + vec3f(5.0)) * amp * 0.25 * (1.0 + F.hat);
  }
  if (style == 3) {
    let rel = p - vec3f(U[0].x, 0.0, U[0].z);
    v += vec3f(-rel.z, 0.0, rel.x) * U[21].w * exp(-dot(rel.xz, rel.xz) * 0.8);
  }
  // Snare: a sideways gust.
  v.x += F.snare * 0.25 * sin(p.y * 2.0 + F.time);
  for (var j = 0; j < ${RINGS}; j++) { v += ip_ring(j, p); }
  return v;
}

fn ip_life(idx: u32) -> f32 { return 5.0 + 7.0 * hashU(idx * 2246822519u + 3u); }

fn simulate(idx: u32, p: ptr<function, Particle>) {
  let nact = u32(U[20].w);
  if (idx >= nact) { (*p).pos.w = 0.0; return; }
  let dt = min(F.dt, 1.0 / 30.0);
  var pos = (*p).pos.xyz;
  var life = (*p).pos.w;
  var info = (*p).vel;
  let nsrc = max(i32(U[20].x), 1);
  let fr = pcg(u32(F.frame) * 9781u + 7u);
  // Puff capture: right after a kick, some ink is re-emitted onto the new vortex ring.
  let rj = i32(U[23].z);
  let puff = U[22].w < 0.14 && U[12 + rj].w > 0.0 && hashU(idx ^ fr) < 0.12 * dt * U[23].w;
  let first = all((*p).vel == vec4f(0.0));
  if (life <= 0.0 || puff) {
    let h = hashU3(pcg(idx) ^ fr);
    let L = ip_life(idx);
    if (puff) {
      let ax = U[16 + rj].xyz;
      let R = U[16 + rj].w;
      let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(ax.y) > 0.9);
      let e1 = normalize(cross(ax, up));
      let e2 = cross(ax, e1);
      let th = h.x * TAU;
      let ph = h.y * TAU;
      let er = cos(th) * e1 + sin(th) * e2;
      let cr = (0.05 + 0.2 * R) * sqrt(h.z);
      pos = U[12 + rj].xyz + er * (R + cr * cos(ph)) + ax * cr * sin(ph);
      let src = i32(U[24].x) % nsrc;
      info = vec4f(0.0, 0.7 + 0.3 * h.z, U[6 + src].w + 0.08, f32(src));
    } else {
      let src = i32(idx % u32(nsrc));
      let r = sqrt(h.x) * U[0 + src].w;
      let a = h.y * TAU;
      let d = normalize(U[6 + src].xyz + vec3f(0.0, U[21].x, 0.0) + vec3f(1e-4));
      let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(d.y) > 0.9);
      let e1 = normalize(cross(d, up));
      let e2 = cross(d, e1);
      pos = U[src].xyz + (cos(a) * e1 + sin(a) * e2) * r + d * h.z * 0.05;
      // Ink strength follows this emitter's spectrum band; hue follows the chord.
      let band = 0.04 + 0.12 * f32(src) + 0.5 * U[23].x;
      let lvl = spec(fract(band));
      let strength = sat((0.35 + 1.3 * lvl) * (1.0 - 0.6 * F.anticipation) + 0.6 * F.kick * F.kick + 0.8 * F.dropPulse);
      info = vec4f(0.0, strength, U[6 + src].w + 0.12 * F.morph2.x, f32(src));
    }
    life = L;
    if (first && !puff) {
      // Warm start: age brand-new ink along its path so the plumes are full immediately.
      let a = hashU(idx * 7u + 11u) * L * 0.85;
      let src0 = i32(info.w);
      for (var s = 0; s < 6; s++) {
        let ag = a * (f32(s) + 0.5) / 6.0;
        pos += ip_flow(pos, ag, src0) * (a / 6.0);
      }
      pos += (hashU3(idx * 5u + 3u) * 2.0 - 1.0) * sqrt(a) * U[24].y * 0.2;
      info.x = a;
      life = L - a;
    }
  }
  let src = i32(info.w);
  let age = info.x;
  let v1 = ip_flow(pos, age, src);
  let v2 = ip_flow(pos + v1 * dt * 0.5, age, src);
  pos += v2 * dt;
  // Molecular + small-eddy diffusion: a random walk that widens as the ink ages.
  let rn = hashU3(pcg(idx * 31u + 17u) ^ fr) * 2.0 - 1.0;
  pos += rn * sqrt(dt) * U[24].y * (0.05 + 0.3 * min(age, 4.0) / 4.0);
  // Gentle walls so ink lingers in frame instead of leaving forever.
  pos.x -= sign(pos.x) * max(abs(pos.x) - 3.2, 0.0) * dt * 2.0;
  pos.z -= sign(pos.z) * max(abs(pos.z) - 2.5, 0.0) * dt * 2.0;
  info.x = age + dt;
  life -= dt * (1.0 + 2.0 * step(3.6, abs(pos.y - 0.5)));
  (*p).pos = vec4f(pos, life);
  (*p).vel = info;
}

struct IpShade { color: vec3f, alpha: f32, size: f32 };

fn ip_shade(b: Particle, idx: u32) -> IpShade {
  let mode = i32(U[20].y);
  let age = b.vel.x;
  let strength = b.vel.y;
  let hue = b.vel.z + U[23].x;
  let life = b.pos.w;
  let L = ip_life(idx);
  let fade = smoothstep(0.0, 0.25, age) * smoothstep(0.0, 0.3 * L, life);
  let grow = 1.0 + age * U[22].z;
  let dil = 1.0 / (1.0 + age * 0.22 * U[22].z);
  let hueA = hue + age * U[23].y;
  var s: IpShade;
  s.size = U[22].x * grow * (0.7 + 0.6 * hashU(idx * 3u + 1u));
  let a = U[22].y * strength * dil * fade;
  switch mode {
    case 0: {
      // Multi-ink in clear water: absorbing dyes.
      s.color = palL(hueA, 0.03) * a * 1.6;
      s.alpha = a * 1.6;
    }
    case 1: {
      // Sumi: near-black ink with a faint warm cast.
      s.color = mix(palRampL(0.05, 0.006), palL(hueA, 0.02), 0.3) * a * 2.0;
      s.alpha = a * 2.0;
    }
    case 2: {
      // Luminous smoke on black: mostly emission, a little occlusion for depth.
      s.color = palL(hueA, 0.4 + 0.6 * F.kick * exp(-age)) * a * 0.6;
      s.alpha = a * 0.32;
    }
    default: {
      // Dye crossing a beam of light from above: scattering lights it up inside the beam.
      let bx = b.pos.xyz - vec3f(U[0].x * 0.5, 0.0, 0.0);
      let beam = exp(-dot(bx.xz, bx.xz) * 0.9) * smoothstep(-2.5, 2.5, b.pos.y);
      s.color = palL(hueA, 0.015 + 0.6 * beam * (0.8 + 0.4 * F.beatPulse)) * a;
      s.alpha = a * 0.8;
    }
  }
  let eye = S.p[4].xyz;
  let near = smoothstep(0.15, 0.7, distance(b.pos.xyz, eye));
  s.color *= near * (0.8 + 0.3 * F.intensity);
  s.alpha *= near;
  return s;
}

fn background(uv: vec2f, rd: vec3f) -> vec3f {
  let mode = i32(U[20].y);
  let hue = U[23].x;
  let v = rd.y;
  let vig = 1.0 - 0.35 * dot(uv - 0.5, uv - 0.5) * 2.0;
  switch mode {
    case 0, 1: {
      // Pale water, lit from the surface, with drifting caustics up high.
      let lum = mix(0.12, 0.3, smoothstep(-0.6, 0.7, v)) * (1.0 - 0.25 * F.anticipation);
      let tint = mix(vec3f(1.0), palL(hue + 0.5, 1.0), select(0.3, 0.12, mode == 1));
      let q = rd.xz / max(v + 1.2, 0.2) * 7.0;
      let ca = noise3(vec3f(q, F.time * 0.3)) + 0.5 * noise3(vec3f(q * 2.1, F.time * 0.45 + 4.0));
      let caust = pow(sat(1.0 - abs(ca) * 1.8), 10.0) * smoothstep(0.1, 0.8, v);
      return tint * lum * vig * (1.0 + 0.18 * caust);
    }
    case 2: {
      let g = mix(0.002, 0.012, smoothstep(-0.8, 0.8, v));
      return palRampL(0.2, g) * vig;
    }
    default: {
      // Dim water with a shaft of light falling from the surface.
      let eye = S.p[4].xyz;
      let t = max(-dot(eye.xz, rd.xz) / max(dot(rd.xz, rd.xz), 1e-4), 0.0);
      let cp = eye + rd * t;
      let shaft = exp(-dot(cp.xz - vec2f(U[0].x * 0.5, 0.0), cp.xz - vec2f(U[0].x * 0.5, 0.0)) * 1.2) * smoothstep(-0.6, 0.9, v);
      let g = mix(0.01, 0.035, smoothstep(-0.8, 0.8, v));
      return (palRampL(0.3, g) + palL(hue + 0.1, 0.06) * shaft) * vig;
    }
  }
}
`;

interface Ring {
  c: Vec3;
  ax: Vec3;
  r: number;
  g: number;
  age: number;
}

class InkInstance implements SceneInstance {
  readonly meta = META;
  private readonly params = new Float32Array(SCENE_LAYOUT.size / 4);
  private readonly u = new Float32Array(UVEC4 * 4);
  private readonly paramBuffer: GPUBuffer;
  private readonly group0: GPUBindGroup;
  private aspect = 16 / 9;
  private rings: Ring[] = [];
  private ringNext = 0;
  private lastTime = -1;
  private lastKick = 0;
  private sinceRing = 9;
  private lastDrop = 0;
  private srcPos: Vec3[] = [];
  private srcDir: Vec3[] = [];

  constructor(
    private readonly device: GPUDevice,
    shared: SharedResources,
    private readonly pipes: { sim: GPUComputePipeline; draw: GPURenderPipeline; bg: GPURenderPipeline },
    private readonly buffers: GPUBuffer[],
    private readonly simGroup: GPUBindGroup,
    private readonly drawGroup: GPUBindGroup,
    private readonly uBuffer: GPUBuffer,
  ) {
    this.paramBuffer = shared.createSceneParamBuffer('ink-plumes-params');
    this.group0 = shared.createSceneBindGroup(this.paramBuffer, 'ink-plumes');
  }

  private layout(ctx: SceneUpdateContext): { n: number; falling: boolean } {
    const g = ctx.dna;
    const lay = Math.floor(g[0] * 5) % 5;
    const m = ctx.music;
    const sway = (i: number) => 0.25 * Math.sin(ctx.time * 0.11 + i * 2.1 + g[7] * 9) + 0.3 * (m.sectionIndex >= 0 ? Math.sin(m.sectionIndex * 1.7 + i) : 0);
    const pos: Vec3[] = [];
    const dir: Vec3[] = [];
    let falling = false;
    switch (lay) {
      case 0:
        pos.push([sway(0) * 0.5, -1.7, 0]);
        dir.push([0, 0.15, 0]);
        break;
      case 1: {
        const n = 3 + Math.floor(g[7] * 3);
        for (let i = 0; i < n; i++) {
          pos.push([((i / (n - 1)) * 2 - 1) * 2.0 + sway(i) * 0.4, -1.7, 0.3 * Math.sin(i * 2.3)]);
          dir.push([0, 0.1, 0]);
        }
        break;
      }
      case 2: {
        const n = 4 + Math.floor(g[7] * 3);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + ctx.time * 0.05;
          pos.push([Math.cos(a) * 1.1, -1.75, Math.sin(a) * 1.1]);
          dir.push([-Math.cos(a) * 0.25, 0.05, -Math.sin(a) * 0.25]);
        }
        break;
      }
      case 3: {
        // Drops falling from the surface.
        falling = true;
        const n = 2 + Math.floor(g[7] * 3);
        for (let i = 0; i < n; i++) {
          pos.push([((i + 0.5) / n * 2 - 1) * 1.6 + sway(i) * 0.3, 2.6, 0.4 * Math.sin(i * 1.9)]);
          dir.push([0, -0.5, 0]);
        }
        break;
      }
      default:
        pos.push([-2.4, -0.9 + sway(0) * 0.5, 0.1]);
        dir.push([2.5, 0.15, 0]);
        pos.push([2.4, -0.6 + sway(1) * 0.5, -0.1]);
        dir.push([-2.5, 0.2, 0]);
    }
    this.srcPos = pos;
    this.srcDir = dir;
    return { n: pos.length, falling };
  }

  update(ctx: SceneUpdateContext): void {
    const m = ctx.music;
    const g = ctx.dna;
    const u = this.u;
    const { n, falling } = this.layout(ctx);
    const style = Math.floor(g[1] * 4) % 4;
    const mode = Math.floor(g[4] * 4) % 4;
    const rig = Math.floor(g[3] * 4) % 4;
    const dt0 = ctx.time - this.lastTime;
    if (this.lastTime < 0 || dt0 < 0 || dt0 > 0.5) {
      this.rings = [];
      this.sinceRing = 9;
    }
    const dt = Math.min(Math.max(dt0, 0), 0.05);
    this.lastTime = ctx.time;

    // ----- vortex rings: launched on kicks, rolling away under their own flow -----
    const down = falling ? -1 : 1;
    this.sinceRing += dt;
    const kickEdge = m.kick > 0.55 && this.lastKick <= 0.55 && this.sinceRing > 0.22;
    const dropEdge = m.dropPulse > 0.9 && this.lastDrop <= 0.9;
    this.lastKick = m.kick;
    this.lastDrop = m.dropPulse;
    if (kickEdge || dropEdge) {
      const si = this.ringNext % n;
      const sp = this.srcPos[si];
      const sd = this.srcDir[si];
      const l = Math.hypot(sd[0], sd[1] + 0.3 * down, sd[2]) || 1;
      const ax: Vec3 = [sd[0] / l, (sd[1] + 0.3 * down) / l, sd[2] / l];
      const big = dropEdge ? 1.8 : 1;
      this.rings[this.ringNext % RINGS] = {
        c: [sp[0] + ax[0] * 0.15, sp[1] + ax[1] * 0.15, sp[2] + ax[2] * 0.15],
        ax,
        r: (0.2 + 0.12 * m.energySlow) * big,
        g: (0.55 + 0.6 * m.kick) * big * (0.8 + 0.4 * g[6]),
        age: 0,
      };
      u[96] = si;
      u[97] = 0;
      u[94] = this.ringNext % RINGS;
      this.ringNext++;
      this.sinceRing = 0;
    }
    let newestAge = 9;
    for (let j = 0; j < RINGS; j++) {
      const r = this.rings[j];
      if (r) {
        r.age += dt;
        const speed = r.g * 0.45;
        r.c = [r.c[0] + r.ax[0] * speed * dt, r.c[1] + r.ax[1] * speed * dt, r.c[2] + r.ax[2] * speed * dt];
        r.r += 0.06 * dt;
        r.g *= Math.exp(-0.28 * dt);
        if (j === (this.ringNext - 1 + RINGS) % RINGS) newestAge = r.age;
      }
      u[48 + j * 4] = r ? r.c[0] : 0;
      u[49 + j * 4] = r ? r.c[1] : 0;
      u[50 + j * 4] = r ? r.c[2] : 0;
      u[51 + j * 4] = r && r.g > 0.03 ? r.g : 0;
      u[64 + j * 4] = r ? r.ax[0] : 0;
      u[65 + j * 4] = r ? r.ax[1] : 1;
      u[66 + j * 4] = r ? r.ax[2] : 0;
      u[67 + j * 4] = r ? r.r : 0.2;
    }

    // ----- sources -----
    const hueSpread = [0.0, 0.18, 0.33, 0.5][Math.floor(g[5] * 4) % 4];
    for (let i = 0; i < 6; i++) {
      const k = Math.min(i, n - 1);
      const p = this.srcPos[k];
      const d = this.srcDir[k];
      const surge = 1 + 0.6 * m.kickNext * 0.5 + 1.2 * m.dropPulse - 0.5 * m.anticipation;
      u[i * 4] = p[0];
      u[i * 4 + 1] = p[1];
      u[i * 4 + 2] = p[2];
      u[i * 4 + 3] = (0.05 + 0.1 * g[2]) * (n > 2 ? 0.8 : 1.2);
      u[24 + i * 4] = d[0] * surge;
      u[24 + i * 4 + 1] = d[1] * surge;
      u[24 + i * 4 + 2] = d[2] * surge;
      u[24 + i * 4 + 3] = k * hueSpread;
    }
    u[80] = n;
    u[81] = mode;
    u[82] = style;
    u[83] = Math.round(COUNT * (0.5 + 0.5 * g[2]));
    const flow = (0.75 + 0.5 * g[6]) * (1 + 0.3 * m.energySlow + 0.6 * m.dropPulse) * (1 - 0.35 * m.anticipation);
    u[84] = down * (0.55 + 0.25 * (style === 1 ? 1 : 0)) * flow;
    u[85] = (0.12 + 0.12 * g[6] + 0.1 * m.flux + 0.25 * m.dropPulse + 0.1 * m.anticipation) * (style === 0 ? 0.8 : 1);
    u[86] = [0.55, 0.32, 0.9, 0.5][style] * (0.8 + 0.5 * g[6]);
    u[87] = style === 3 ? 0.6 + 0.6 * m.energySlow : 0.15 * ctx.evolve[2];
    u[88] = (0.008 + 0.011 * (1 - g[2])) * (mode === 2 ? 1.2 : 1);
    u[89] = (mode === 2 ? 0.05 : 0.035) * (0.6 + 0.8 * (1 - g[2])) * (0.8 + 0.4 * ctx.intensity);
    u[90] = 0.5 + 0.9 * ctx.evolve[1];
    u[91] = newestAge;
    u[92] = g[7] * 0.7 + 0.15 * ctx.evolve[0];
    u[93] = (g[5] * 0.14 - 0.05);
    u[95] = 1 + 0.6 * m.dropPulse;
    u[98] = [0.09, 0.16, 0.06, 0.1][style] * (1 + 0.4 * m.dropPulse);
    u[97] = (0.22 + 0.35 * g[6]) * (style === 2 ? 0.5 : 1) * (1 + 0.5 * m.dropPulse);

    // ----- camera -----
    const s = ctx.spin;
    const v = g[7] * 6.283;
    const push = 0.5 * m.anticipation - 0.6 * m.dropPulse;
    let eye: Vec3;
    let target: Vec3 = [0, falling ? 0.3 : 0.4, 0];
    let fovY = 0.85;
    let roll = 0;
    switch (rig) {
      case 0: {
        const a = Math.PI / 2 + 0.3 * Math.sin(s * 0.07 + v);
        const r = 5.6 + push;
        eye = [Math.cos(a) * r, 0.5 + 0.4 * Math.sin(s * 0.05), Math.sin(a) * r];
        break;
      }
      case 1: {
        const a = s * 0.05 + v;
        const r = 3.6 + push;
        eye = [Math.cos(a) * r, falling ? 2.8 : -1.9, Math.sin(a) * r];
        target = [0, falling ? -0.4 : 1.2, 0];
        fovY = 1.05;
        roll = 0.08 * Math.sin(s * 0.09);
        break;
      }
      case 2: {
        const a = s * 0.12 + v;
        const r = 5.0 + push;
        eye = [Math.cos(a) * r, 0.9 + 0.8 * Math.sin(s * 0.06), Math.sin(a) * r];
        fovY = 0.9;
        break;
      }
      default: {
        const a = s * 0.08 + v;
        const r = 2.2 + push * 0.5;
        eye = [Math.cos(a) * r, falling ? -1.4 : 3.4, Math.sin(a) * r];
        target = [0, falling ? 0.8 : 0.0, 0];
        fovY = 1.1;
        roll = s * 0.05;
      }
    }
    const p = this.params;
    p.set(lookAtPerspective(eye, target, fovY, this.aspect, 0.05, 100, roll), 0);
    p[16] = eye[0];
    p[17] = eye[1];
    p[18] = eye[2];
    p[19] = Math.tan(fovY / 2);
    p[20] = target[0] - eye[0];
    p[21] = target[1] - eye[1];
    p[22] = target[2] - eye[2];
    p[23] = 0;
    this.device.queue.writeBuffer(this.paramBuffer, 0, p);
    this.device.queue.writeBuffer(this.uBuffer, 0, u);
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    this.aspect = width / height;
    const cp = encoder.beginComputePass({ label: 'ink-plumes-sim' });
    cp.setPipeline(this.pipes.sim);
    cp.setBindGroup(0, this.group0);
    cp.setBindGroup(1, this.simGroup);
    cp.dispatchWorkgroups(COUNT / 256);
    cp.end();
    const pass = encoder.beginRenderPass({
      label: 'ink-plumes',
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
struct IOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) color: vec3f, @location(2) alpha: f32 };
@vertex fn vsI(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> IOut {
  var o: IOut;
  let b = particles[ii];
  let clip = viewProj() * vec4f(b.pos.xyz, 1.0);
  if (b.pos.w <= 0.0 || clip.w < 0.05) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let sh = ip_shade(b, ii);
  if (sh.alpha <= 0.0004 && dot(sh.color, sh.color) < 1e-9) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let res = F.res;
  let a = clip.xy / clip.w * res * 0.5;
  let raw = sh.size * res.y * 0.5 / clip.w;
  let sizePx = clamp(raw, 0.9, 24.0);
  // Energy-conserving footprint: big blobs are fainter per pixel, sub-pixel ones fade.
  // Sub-pixel ink fades by coverage instead of popping; optical depth is otherwise distance-independent.
  let k = min(1.0, raw * raw / 0.81);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  o.pos = vec4f((a + c * sizePx) / (res * 0.5) * clip.w, clip.z, clip.w);
  o.q = c;
  o.color = sh.color * k;
  o.alpha = min(sh.alpha * k, 0.95);
  return o;
}
@fragment fn fsI(in: IOut) -> @location(0) vec4f {
  let f = exp(-dot(in.q, in.q) * 3.2);
  return vec4f(in.color * f, in.alpha * f);
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
      compileModule(device, computeCode, 'ink-plumes-sim'),
      compileModule(device, renderCode, 'ink-plumes-draw'),
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
    const over: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' };
    const [sim, draw, bg] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'ink-plumes-sim',
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, simLayout] }),
        compute: { module: cModule, entryPoint: 'cs' },
      }),
      device.createRenderPipelineAsync({
        label: 'ink-plumes-draw',
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, drawLayout] }),
        vertex: { module: rModule, entryPoint: 'vsI' },
        fragment: { module: rModule, entryPoint: 'fsI', targets: [{ format: HDR_FORMAT, blend: { color: over, alpha: over } }] },
        primitive: { topology: 'triangle-list' },
      }),
      device.createRenderPipelineAsync({
        label: 'ink-plumes-bg',
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, drawLayout] }),
        vertex: { module: rModule, entryPoint: 'vs' },
        fragment: { module: rModule, entryPoint: 'fsBg', targets: [{ format: HDR_FORMAT }] },
      }),
    ]);
    const buffer = device.createBuffer({ label: 'ink-plumes-particles', size: COUNT * 32, usage: GPUBufferUsage.STORAGE });
    const uBuffer = device.createBuffer({ label: 'ink-plumes-u', size: UVEC4 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const group = (l: GPUBindGroupLayout) =>
      device.createBindGroup({ layout: l, entries: [{ binding: 0, resource: { buffer } }, { binding: 1, resource: { buffer: uBuffer } }] });
    return new InkInstance(device, shared, { sim, draw, bg }, [buffer, uBuffer], group(simLayout), group(drawLayout), uBuffer);
  },
};

export default factory;
