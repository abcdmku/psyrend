import { compileModule } from '../gpu/context';
import { SCENE_LAYOUT } from '../gpu/frameLayout';
import { HDR_FORMAT, type SharedResources } from '../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../gpu/shaders/common';
import { lookAtPerspective, type Vec3 } from './math';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from './types';

export interface ParticleCamera {
  eye: Vec3;
  target: Vec3;
  fovY: number;
  roll?: number;
}

export interface ParticleSpec {
  meta: SceneMeta;
  /** Particle count (rounded up to a multiple of 256). */
  count: number;
  /**
   * WGSL. Must define:
   *  - `fn simulate(idx: u32, p: ptr<function, Particle>)` — advance one particle. `(*p).pos.w` is
   *    life (respawn when <= 0; buffers start zeroed), `(*p).vel.w` is free per-particle data.
   *  - `fn shade(p: Particle, idx: u32) -> Shade` — HDR color and world-space radius.
   *  - `fn background(uv: vec2f, rd: vec3f) -> vec3f` — backdrop behind the particles.
   * Slots S.p[0..3] hold view-projection, S.p[4] = (eye.xyz, tan(fovY/2)), S.p[5] = (forward.xyz, streak).
   * S.p[6], S.p[7] are free for `params`.
   */
  wgsl: string;
  camera(ctx: SceneUpdateContext): ParticleCamera;
  /** Motion streak length in seconds of velocity. */
  streak(ctx: SceneUpdateContext): number;
  /** Fill S.p[6] and S.p[7] (floats 24..31). */
  params(ctx: SceneUpdateContext, p: Float32Array): void;
}

const PARTICLE_WGSL = /* wgsl */ `
struct Particle { pos: vec4f, vel: vec4f };
struct Shade { color: vec3f, size: f32 };
`;

export function particleScene(spec: ParticleSpec): SceneFactory {
  return {
    meta: spec.meta,
    async create(device, shared) {
      const count = Math.ceil(spec.count / 256) * 256;
      const head = `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${PARTICLE_WGSL}`;
      const inverseVP = /* wgsl */ `
fn viewProj() -> mat4x4f { return mat4x4f(S.p[0], S.p[1], S.p[2], S.p[3]); }
`;
      const computeCode = `${head}
@group(1) @binding(0) var<storage, read_write> particles: array<Particle>;
${inverseVP}
${spec.wgsl}
@compute @workgroup_size(256) fn cs(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&particles)) { return; }
  var p = particles[i];
  simulate(i, &p);
  particles[i] = p;
}`;
      const renderCode = `${head}
@group(1) @binding(0) var<storage, read> particles: array<Particle>;
${inverseVP}
${spec.wgsl}
struct POut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) color: vec3f, @location(2) stretch: f32 };
@vertex fn vsP(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  var o: POut;
  let part = particles[ii];
  let sh = shade(part, ii);
  let vp = viewProj();
  let clip = vp * vec4f(part.pos.xyz, 1.0);
  let prevClip = vp * vec4f(part.pos.xyz - part.vel.xyz * S.p[5].w, 1.0);
  if (clip.w < 0.05 || prevClip.w < 0.05 || part.pos.w <= 0.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let res = F.res;
  let a = clip.xy / clip.w * res * 0.5;
  let b = prevClip.xy / prevClip.w * res * 0.5;
  let sizePx = clamp(sh.size * res.y * 0.5 / clip.w, 0.6, 40.0);
  var dir = a - b;
  let len = min(length(dir), 160.0);
  dir = select(vec2f(1.0, 0.0), dir / max(length(dir), 1e-5), len > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let halfLen = len * 0.5 + sizePx;
  let center = (a + b) * 0.5;
  let px = center + dir * c.x * halfLen + nrm * c.y * sizePx;
  o.pos = vec4f(px / (res * 0.5) * clip.w, clip.z, clip.w);
  o.q = vec2f(c.x * halfLen / sizePx, c.y);
  o.stretch = halfLen / sizePx - 1.0;
  // Energy-conserving streaks: longer smears are dimmer per pixel. Sub-pixel sizes fade instead of popping.
  let cover = min(1.0, sh.size * res.y * 0.5 / clip.w / 0.6);
  o.color = sh.color * cover * cover / (1.0 + len / (sizePx * 2.0));
  return o;
}
@fragment fn fsP(in: POut) -> @location(0) vec4f {
  let d = vec2f(max(abs(in.q.x) - in.stretch, 0.0), in.q.y);
  let fall = exp(-dot(d, d) * 3.5);
  return vec4f(in.color * fall, 1.0);
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
        compileModule(device, computeCode, `${spec.meta.id}-sim`),
        compileModule(device, renderCode, `${spec.meta.id}-draw`),
      ]);
      const storageLayout = (type: GPUBufferBindingType, vis: number) =>
        device.createBindGroupLayout({ entries: [{ binding: 0, visibility: vis, buffer: { type } }] });
      const simLayout = storageLayout('storage', GPUShaderStage.COMPUTE);
      const drawLayout = storageLayout('read-only-storage', GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
      const [sim, draw, bg] = await Promise.all([
        device.createComputePipelineAsync({
          label: `${spec.meta.id}-sim`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, simLayout] }),
          compute: { module: cModule, entryPoint: 'cs' },
        }),
        device.createRenderPipelineAsync({
          label: `${spec.meta.id}-draw`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, drawLayout] }),
          vertex: { module: rModule, entryPoint: 'vsP' },
          fragment: {
            module: rModule,
            entryPoint: 'fsP',
            targets: [{ format: HDR_FORMAT, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }],
          },
          primitive: { topology: 'triangle-list' },
        }),
        device.createRenderPipelineAsync({
          label: `${spec.meta.id}-bg`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout, drawLayout] }),
          vertex: { module: rModule, entryPoint: 'vs' },
          fragment: { module: rModule, entryPoint: 'fsBg', targets: [{ format: HDR_FORMAT }] },
        }),
      ]);
      const buffer = device.createBuffer({ label: `${spec.meta.id}-particles`, size: count * 32, usage: GPUBufferUsage.STORAGE });
      const simGroup = device.createBindGroup({ layout: simLayout, entries: [{ binding: 0, resource: { buffer } }] });
      const drawGroup = device.createBindGroup({ layout: drawLayout, entries: [{ binding: 0, resource: { buffer } }] });
      return new ParticleInstance(device, shared, spec, count, { sim, draw, bg }, buffer, simGroup, drawGroup);
    },
  };
}

class ParticleInstance implements SceneInstance {
  readonly meta: SceneMeta;
  private readonly params = new Float32Array(SCENE_LAYOUT.size / 4);
  private readonly paramBuffer: GPUBuffer;
  private readonly group0: GPUBindGroup;

  constructor(
    private readonly device: GPUDevice,
    shared: SharedResources,
    private readonly spec: ParticleSpec,
    private readonly count: number,
    private readonly pipes: { sim: GPUComputePipeline; draw: GPURenderPipeline; bg: GPURenderPipeline },
    private readonly buffer: GPUBuffer,
    private readonly simGroup: GPUBindGroup,
    private readonly drawGroup: GPUBindGroup,
  ) {
    this.meta = spec.meta;
    this.paramBuffer = shared.createSceneParamBuffer(`${spec.meta.id}-params`);
    this.group0 = shared.createSceneBindGroup(this.paramBuffer, spec.meta.id);
  }

  private aspect = 16 / 9;

  update(ctx: SceneUpdateContext): void {
    const cam = this.spec.camera(ctx);
    const p = this.params;
    const vp = lookAtPerspective(cam.eye, cam.target, cam.fovY, this.aspect, 0.05, 200, cam.roll ?? 0);
    p.set(vp, 0);
    p[16] = cam.eye[0];
    p[17] = cam.eye[1];
    p[18] = cam.eye[2];
    p[19] = Math.tan(cam.fovY / 2);
    p[20] = cam.target[0] - cam.eye[0];
    p[21] = cam.target[1] - cam.eye[1];
    p[22] = cam.target[2] - cam.eye[2];
    p[23] = this.spec.streak(ctx);
    this.spec.params(ctx, p);
    this.device.queue.writeBuffer(this.paramBuffer, 0, p);
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number): void {
    this.aspect = width / height;
    const cp = encoder.beginComputePass({ label: `${this.meta.id}-sim` });
    cp.setPipeline(this.pipes.sim);
    cp.setBindGroup(0, this.group0);
    cp.setBindGroup(1, this.simGroup);
    cp.dispatchWorkgroups(this.count / 256);
    cp.end();
    const pass = encoder.beginRenderPass({
      label: this.meta.id,
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setBindGroup(0, this.group0);
    pass.setBindGroup(1, this.drawGroup);
    pass.setPipeline(this.pipes.bg);
    pass.draw(3);
    pass.setPipeline(this.pipes.draw);
    pass.draw(6, this.count);
    pass.end();
  }

  destroy(): void {
    this.paramBuffer.destroy();
    this.buffer.destroy();
  }
}
