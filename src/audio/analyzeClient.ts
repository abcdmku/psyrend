import AnalysisWorker from './analysis.worker?worker';
import type { AnalysisWorkerMessage, TrackAnalysis } from './types';

export const ANALYSIS_SAMPLE_RATE = 22050;

/** Downmixes and resamples to the analysis rate with the browser's own resampler. */
export async function toAnalysisSignal(buffer: AudioBuffer): Promise<Float32Array> {
  const length = Math.ceil(buffer.duration * ANALYSIS_SAMPLE_RATE);
  const ctx = new OfflineAudioContext(1, length, ANALYSIS_SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

export function analyzeInWorker(samples: Float32Array, onProgress: (stage: string, p: number) => void): Promise<TrackAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new AnalysisWorker();
    worker.onmessage = (e: MessageEvent<AnalysisWorkerMessage>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.stage, m.progress);
      else {
        worker.terminate();
        if (m.type === 'done') resolve(m.analysis);
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Analysis worker failed'));
    };
    worker.postMessage({ samples, sampleRate: ANALYSIS_SAMPLE_RATE }, [samples.buffer]);
  });
}
