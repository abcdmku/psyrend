import { BAND_COUNT } from '../audio/types';
import { rng } from '../audio/analysis/util';
import { FRAME_LAYOUT, SCENE_LAYOUT } from './frameLayout';
import { ScoreTextures } from './score';
import { ScoreEvents } from './scoreEvents';

export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
export const HIST_ROWS = 256;
const NOISE_SIZE = 64;

/** Resources every scene binds in group 0. */
export class SharedResources {
  readonly frameBuffer: GPUBuffer;
  readonly frameData: Float32Array<ArrayBuffer>;
  readonly histTexture: GPUTexture;
  readonly noiseTexture: GPUTexture;
  readonly sampler: GPUSampler;
  readonly clampSampler: GPUSampler;
  readonly sceneLayout: GPUBindGroupLayout;
  readonly score: ScoreTextures;
  readonly events: ScoreEvents;
  private histHead = 0;
  private readonly histRow = new Uint8Array(BAND_COUNT);

  constructor(readonly device: GPUDevice) {
    this.frameData = new Float32Array(FRAME_LAYOUT.size / 4);
    this.frameBuffer = device.createBuffer({
      label: 'frame-uniforms',
      size: FRAME_LAYOUT.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.histTexture = device.createTexture({
      label: 'spectrum-history',
      size: [BAND_COUNT, HIST_ROWS],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.noiseTexture = createNoiseTexture(device);
    this.sampler = device.createSampler({
      label: 'repeat-linear',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });
    this.clampSampler = device.createSampler({ label: 'clamp-linear', magFilter: 'linear', minFilter: 'linear' });
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    this.sceneLayout = device.createBindGroupLayout({
      label: 'scene-group0',
      entries: [
        { binding: 0, visibility: vis, buffer: { type: 'uniform' } },
        { binding: 1, visibility: vis, buffer: { type: 'uniform' } },
        { binding: 2, visibility: vis, texture: { sampleType: 'float' } },
        { binding: 3, visibility: vis, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 4, visibility: vis, sampler: { type: 'filtering' } },
        { binding: 5, visibility: vis, texture: { sampleType: 'float' } },
        { binding: 6, visibility: vis, texture: { sampleType: 'float' } },
        { binding: 7, visibility: vis, sampler: { type: 'filtering' } },
      ],
    });
    this.score = new ScoreTextures(device);
    this.events = new ScoreEvents(device);
  }

  createSceneParamBuffer(label: string): GPUBuffer {
    return this.device.createBuffer({ label, size: SCENE_LAYOUT.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  createSceneBindGroup(paramBuffer: GPUBuffer, label: string): GPUBindGroup {
    return this.device.createBindGroup({
      label,
      layout: this.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: paramBuffer } },
        { binding: 2, resource: this.histTexture.createView() },
        { binding: 3, resource: this.noiseTexture.createView({ dimension: '3d' }) },
        { binding: 4, resource: this.sampler },
        { binding: 5, resource: this.score.scoreTex.createView() },
        { binding: 6, resource: this.score.eventsTex.createView() },
        { binding: 7, resource: this.clampSampler },
      ],
    });
  }

  /** Appends one spectrum row to the history ring and returns the head row index. */
  pushSpectrum(bands: Float32Array): number {
    for (let i = 0; i < BAND_COUNT; i++) this.histRow[i] = Math.max(0, Math.min(255, Math.round(bands[i] * 255)));
    this.histHead = (this.histHead + 1) % HIST_ROWS;
    this.device.queue.writeTexture({ texture: this.histTexture, origin: [0, this.histHead] }, this.histRow, { bytesPerRow: BAND_COUNT }, [BAND_COUNT, 1]);
    return this.histHead;
  }

  uploadFrame(): void {
    this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
  }
}

function toHalf(v: number): number {
  const f32 = new Float32Array([v]);
  const u32 = new Uint32Array(f32.buffer)[0];
  const sign = (u32 >> 16) & 0x8000;
  let exp = ((u32 >> 23) & 0xff) - 127 + 15;
  const mant = u32 & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >> 13);
}

/** Tileable 4-channel value noise; channels are decorrelated so curl noise works. */
function createNoiseTexture(device: GPUDevice): GPUTexture {
  const n = NOISE_SIZE;
  const data = new Uint16Array(n * n * n * 4);
  const r = rng(0x5eed);
  for (let i = 0; i < data.length; i++) data[i] = toHalf(r());
  const tex = device.createTexture({
    label: 'noise-3d',
    size: [n, n, n],
    dimension: '3d',
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: n * 8, rowsPerImage: n }, [n, n, n]);
  return tex;
}
