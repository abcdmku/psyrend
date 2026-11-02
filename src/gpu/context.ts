export interface GpuContext {
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  hdr: boolean;
  timestamps: boolean;
  adapterInfo: string;
}

export class WebGpuUnavailableError extends Error {}

export async function initGpu(canvas: HTMLCanvasElement, onLost: (reason: string) => void): Promise<GpuContext> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new WebGpuUnavailableError('WebGPU is not available in this browser.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new WebGpuUnavailableError('No WebGPU adapter was found.');
  const timestamps = adapter.features.has('timestamp-query');
  const requiredFeatures: GPUFeatureName[] = [];
  if (timestamps) requiredFeatures.push('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 512 * 1024 * 1024),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 * 1024 * 1024),
      maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
      // Whole-song score textures use one row per time step.
      maxTextureDimension2D: Math.min(adapter.limits.maxTextureDimension2D, 16384),
      maxStorageBuffersPerShaderStage: Math.min(adapter.limits.maxStorageBuffersPerShaderStage, 16),
    },
  });
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') onLost(info.message || 'GPU device lost');
  });
  device.addEventListener('uncapturederror', (e) => {
    console.error('[webgpu]', (e as GPUUncapturedErrorEvent).error.message);
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new WebGpuUnavailableError('Could not create a WebGPU canvas context.');

  // Prefer an extended-range float swapchain on HDR displays so highlights can exceed SDR white.
  const wantsHdr = matchMedia('(dynamic-range: high)').matches;
  let format: GPUTextureFormat = navigator.gpu.getPreferredCanvasFormat();
  let hdr = false;
  if (wantsHdr) {
    try {
      context.configure({ device, format: 'rgba16float', alphaMode: 'opaque', toneMapping: { mode: 'extended' } });
      format = 'rgba16float';
      hdr = true;
    } catch {
      hdr = false;
    }
  }
  if (!hdr) context.configure({ device, format, alphaMode: 'opaque' });

  const info = adapter.info;
  const adapterInfo = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ');
  return { device, canvas, context, format, hdr, timestamps, adapterInfo };
}

/** Compiles a module and throws with readable diagnostics on error. */
export async function compileModule(device: GPUDevice, code: string, label: string): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    const lines = code.split('\n');
    const msg = errors
      .map((m) => `${label}:${m.lineNum}:${m.linePos} ${m.message}\n    ${lines[m.lineNum - 1]?.trim() ?? ''}`)
      .join('\n');
    throw new Error(`WGSL compile failed\n${msg}`);
  }
  return module;
}
