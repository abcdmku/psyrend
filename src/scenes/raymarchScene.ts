import { compileModule } from '../gpu/context';
import { SCENE_LAYOUT } from '../gpu/frameLayout';
import { HDR_FORMAT, type SharedResources } from '../gpu/resources';
import { BINDINGS_WGSL, COMMON_WGSL, FULLSCREEN_VS } from '../gpu/shaders/common';
import type { SceneFactory, SceneInstance, SceneMeta, SceneUpdateContext } from './types';

export interface RaymarchSpec {
  meta: SceneMeta;
  /**
   * WGSL defining `fn scene(uv: vec2f, frag: vec2f) -> vec4f` returning linear HDR color.
   * `uv` is [0,1] with y down; `frag` is the pixel coordinate. May define helpers.
   */
  wgsl: string;
  /** Fills `p` (8 x vec4 = 32 floats, read in WGSL as S.p[0..7]) each frame. */
  params(ctx: SceneUpdateContext, p: Float32Array): void;
}

export function raymarchScene(spec: RaymarchSpec): SceneFactory {
  return {
    meta: spec.meta,
    async create(device, shared) {
      const code = `${BINDINGS_WGSL}\n${COMMON_WGSL}\n${FULLSCREEN_VS}\n${spec.wgsl}\n
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let c = scene(in.uv, in.pos.xy);
  return vec4f(max(c.rgb, vec3f(0.0)), 1.0);
}`;
      const module = await compileModule(device, code, spec.meta.id);
      const pipeline = await device.createRenderPipelineAsync({
        label: spec.meta.id,
        layout: device.createPipelineLayout({ bindGroupLayouts: [shared.sceneLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
      });
      return new RaymarchInstance(device, shared, spec, pipeline);
    },
  };
}

class RaymarchInstance implements SceneInstance {
  readonly meta: SceneMeta;
  private readonly params = new Float32Array(SCENE_LAYOUT.size / 4);
  private readonly paramBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;

  constructor(
    private readonly device: GPUDevice,
    shared: SharedResources,
    private readonly spec: RaymarchSpec,
    private readonly pipeline: GPURenderPipeline,
  ) {
    this.meta = spec.meta;
    this.paramBuffer = shared.createSceneParamBuffer(`${spec.meta.id}-params`);
    this.bindGroup = shared.createSceneBindGroup(this.paramBuffer, spec.meta.id);
  }

  update(ctx: SceneUpdateContext): void {
    this.spec.params(ctx, this.params);
    this.device.queue.writeBuffer(this.paramBuffer, 0, this.params);
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView): void {
    const pass = encoder.beginRenderPass({
      label: this.meta.id,
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.paramBuffer.destroy();
  }
}
