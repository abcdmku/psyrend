/// <reference lib="webworker" />
import { analyzeTrack } from './analysis/analyze';
import type { AnalysisRequest, AnalysisWorkerMessage, TrackAnalysis } from './types';

const post = (msg: AnalysisWorkerMessage, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  try {
    let last = 0;
    const analysis = analyzeTrack(e.data.samples, e.data.sampleRate, (stage, progress) => {
      const now = performance.now();
      if (now - last > 40 || progress >= 1) {
        last = now;
        post({ type: 'progress', stage, progress });
      }
    });
    post({ type: 'done', analysis }, transferables(analysis));
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function transferables(a: TrackAnalysis): Transferable[] {
  const out = new Set<ArrayBuffer>();
  for (const v of Object.values(a)) {
    if (v instanceof Float32Array) out.add(v.buffer as ArrayBuffer);
    else if (v && typeof v === 'object' && 'times' in v) {
      out.add((v.times as Float32Array).buffer as ArrayBuffer);
      out.add((v.strengths as Float32Array).buffer as ArrayBuffer);
    }
  }
  return [...out];
}
