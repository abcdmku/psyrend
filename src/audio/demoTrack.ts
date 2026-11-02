import { rng } from './analysis/util';

/**
 * Procedurally synthesised demo song (A minor, 128 BPM) with a clear arrangement:
 * intro, verse, build, drop, breakdown, build, drop, outro. Pure JS so it also
 * drives the analysis tests.
 */
export interface DemoSong {
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
  sampleRate: number;
  bpm: number;
  /** Section start bars, for tests. */
  layout: { name: string; bars: number }[];
}

const BPM = 128;
// i - VI - III - VII in A minor: Am F C G (MIDI roots).
const PROGRESSION = [
  { root: 57, third: 60, fifth: 64 },
  { root: 53, third: 57, fifth: 60 },
  { root: 48, third: 52, fifth: 55 },
  { root: 55, third: 59, fifth: 62 },
];

type Part = 'intro' | 'verse' | 'build' | 'drop' | 'breakdown' | 'outro';
const LAYOUT: { name: Part; bars: number }[] = [
  { name: 'intro', bars: 8 },
  { name: 'verse', bars: 8 },
  { name: 'build', bars: 8 },
  { name: 'drop', bars: 16 },
  { name: 'breakdown', bars: 8 },
  { name: 'build', bars: 4 },
  { name: 'drop', bars: 16 },
  { name: 'outro', bars: 4 },
];

const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);

export function synthesizeDemo(sampleRate = 44100): DemoSong {
  const beat = 60 / BPM;
  const bar = beat * 4;
  const totalBars = LAYOUT.reduce((s, p) => s + p.bars, 0);
  const length = Math.ceil((totalBars * bar + 2) * sampleRate);
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  const rand = rng(1337);
  const noise = new Float32Array(sampleRate * 2);
  for (let i = 0; i < noise.length; i++) noise[i] = rand() * 2 - 1;
  const sidechain = new Float32Array(length).fill(1);

  const add = (buf: Float32Array, i: number, v: number) => {
    if (i >= 0 && i < buf.length) buf[i] += v;
  };

  const kick = (t: number, gain: number) => {
    const s0 = Math.round(t * sampleRate);
    const len = Math.round(0.45 * sampleRate);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const tt = i / sampleRate;
      const f = 45 + 110 * Math.exp(-tt * 28);
      phase += (2 * Math.PI * f) / sampleRate;
      const env = Math.exp(-tt * 7) * (tt < 0.002 ? tt / 0.002 : 1);
      const click = Math.exp(-tt * 300) * noise[i % noise.length] * 0.15;
      const v = (Math.sin(phase) * env + click) * gain;
      add(L, s0 + i, v);
      add(R, s0 + i, v);
      const sc = 1 - 0.75 * Math.exp(-tt * 9);
      if (s0 + i < length) sidechain[s0 + i] = Math.min(sidechain[s0 + i], sc);
    }
  };

  const clap = (t: number, gain: number) => {
    const s0 = Math.round(t * sampleRate);
    const len = Math.round(0.25 * sampleRate);
    let lp = 0;
    let hp = 0;
    for (let i = 0; i < len; i++) {
      const tt = i / sampleRate;
      const n = noise[(i * 7 + 101) % noise.length];
      lp += 0.35 * (n - lp);
      hp += 0.05 * (lp - hp);
      const band = lp - hp;
      const env = Math.exp(-tt * 18) * (1 + 0.6 * Math.exp(-((tt - 0.012) ** 2) / 1e-5));
      const tone = Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt * 30) * 0.4;
      const v = (band * 1.6 + tone) * env * gain;
      add(L, s0 + i, v * 0.9);
      add(R, s0 + i, v);
    }
  };

  const hat = (t: number, gain: number, open: boolean) => {
    const s0 = Math.round(t * sampleRate);
    const len = Math.round((open ? 0.22 : 0.05) * sampleRate);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const tt = i / sampleRate;
      const n = noise[(i * 13 + 977) % noise.length];
      lp += 0.6 * (n - lp);
      const hpv = n - lp;
      const env = Math.exp(-tt * (open ? 14 : 70));
      const v = hpv * env * gain;
      add(L, s0 + i, v);
      add(R, s0 + i, v * 0.8);
    }
  };

  // Continuous voices rendered per bar.
  const renderBar = (barIndex: number, part: Part, barInPart: number, partBars: number) => {
    const t0 = barIndex * bar;
    const s0 = Math.round(t0 * sampleRate);
    const s1 = Math.round((t0 + bar) * sampleRate);
    const chord = PROGRESSION[barIndex % 4];
    const progress = (barInPart + 0.0) / partBars;

    // Pad: detuned saws, slow filter.
    const padGain = part === 'drop' ? 0.05 : part === 'breakdown' || part === 'intro' ? 0.09 : 0.07;
    const padNotes = [chord.root, chord.third, chord.fifth, chord.root + 12];
    const padCut = part === 'intro' ? 400 + 1600 * progress : part === 'build' ? 800 + 4000 * progress : 2200;
    const a = 1 - Math.exp((-2 * Math.PI * padCut) / sampleRate);
    let lpL = 0;
    let lpR = 0;
    for (let s = s0; s < s1 && s < length; s++) {
      const tt = s / sampleRate;
      let vl = 0;
      let vr = 0;
      for (const note of padNotes) {
        const f = mtof(note);
        vl += ((tt * f * 1.003) % 1) * 2 - 1;
        vr += ((tt * f * 0.997) % 1) * 2 - 1;
      }
      lpL += a * (vl - lpL);
      lpR += a * (vr - lpR);
      const sc = part === 'drop' || part === 'verse' ? sidechain[s] : 1;
      L[s] += lpL * padGain * sc;
      R[s] += lpR * padGain * sc;
    }

    // Bass.
    if (part === 'verse' || part === 'drop' || (part === 'build' && progress < 0.75)) {
      const f = mtof(chord.root - 24);
      let lp = 0;
      for (let s = s0; s < s1 && s < length; s++) {
        const tt = s / sampleRate;
        const local = tt - t0;
        const wob = part === 'drop' ? 0.5 + 0.5 * Math.sin(2 * Math.PI * (local / (beat / 2))) : 0.3;
        const cut = part === 'drop' ? 180 + 1400 * wob : 300;
        const ac = 1 - Math.exp((-2 * Math.PI * cut) / sampleRate);
        const saw = ((tt * f) % 1) * 2 - 1 + 0.5 * (((tt * f * 2.005) % 1) * 2 - 1);
        lp += ac * (saw - lp);
        const v = lp * (part === 'drop' ? 0.32 : 0.22) * sidechain[s];
        L[s] += v;
        R[s] += v;
      }
    }

    // Lead arpeggio in drops and breakdown.
    if (part === 'drop' || part === 'breakdown') {
      const notes = [chord.root + 12, chord.third + 12, chord.fifth + 12, chord.third + 24];
      for (let step = 0; step < 16; step++) {
        const nt = t0 + step * (beat / 4);
        const note = notes[(step * 3 + (step >> 2)) % notes.length];
        const f = mtof(note);
        const ns = Math.round(nt * sampleRate);
        const nl = Math.round(beat * 0.22 * sampleRate);
        const g = part === 'drop' ? 0.06 : 0.08;
        for (let i = 0; i < nl; i++) {
          const tt = i / sampleRate;
          const sq = Math.sin(2 * Math.PI * f * tt) + 0.33 * Math.sin(6 * Math.PI * f * tt);
          const env = Math.exp(-tt * (part === 'drop' ? 14 : 7));
          const v = sq * env * g;
          add(L, ns + i, v);
          add(R, ns + i + Math.round(0.011 * sampleRate), v * 0.85);
          // Echo.
          add(L, ns + i + Math.round(beat * 0.75 * sampleRate), v * 0.35);
          add(R, ns + i + Math.round(beat * 0.5 * sampleRate), v * 0.4);
        }
      }
    }

    // Riser in builds.
    if (part === 'build') {
      let lp = 0;
      for (let s = s0; s < s1 && s < length; s++) {
        const p = (barInPart + (s - s0) / (s1 - s0)) / partBars;
        const cutoff = 300 + 7000 * p * p;
        const ac = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
        const n = noise[s % noise.length];
        lp += ac * (n - lp);
        const v = (n - lp * 0.7) * 0.12 * p * p;
        L[s] += v;
        R[s] += v * 0.9;
      }
    }
  };

  let barIndex = 0;
  for (const part of LAYOUT) {
    for (let b = 0; b < part.bars; b++) {
      const t0 = barIndex * bar;
      const progress = b / part.bars;
      const drums = part.name === 'verse' || part.name === 'drop' || part.name === 'outro';
      if (drums || (part.name === 'build' && progress < 0.75) || (part.name === 'intro' && b >= 4)) {
        for (let k = 0; k < 4; k++) kick(t0 + k * beat, part.name === 'drop' ? 0.95 : 0.8);
      }
      if (part.name === 'drop' || part.name === 'verse') {
        clap(t0 + beat, 0.5);
        clap(t0 + 3 * beat, 0.5);
      }
      if (part.name === 'build') {
        // Accelerating snare roll.
        const div = progress < 0.5 ? 4 : progress < 0.75 ? 8 : 16;
        for (let k = 0; k < div; k++) clap(t0 + (k * bar) / div, 0.15 + 0.4 * (b + k / div) / part.bars);
      }
      if (part.name !== 'breakdown') {
        for (let k = 0; k < 8; k++) {
          const off = k % 2 === 1;
          if (part.name === 'intro' && !off) continue;
          hat(t0 + (k * beat) / 2, off ? 0.18 : 0.08, off && part.name === 'drop');
        }
      }
      if (part.name === 'drop') for (let k = 0; k < 16; k++) if (k % 2 === 1) hat(t0 + (k * beat) / 4, 0.05, false);
      barIndex++;
    }
  }
  barIndex = 0;
  for (const part of LAYOUT) {
    for (let b = 0; b < part.bars; b++) renderBar(barIndex++, part.name, b, part.bars);
  }

  // Soft clip + normalise.
  let peak = 1e-9;
  for (let i = 0; i < length; i++) {
    L[i] = Math.tanh(L[i] * 1.2);
    R[i] = Math.tanh(R[i] * 1.2);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const g = 0.89 / peak;
  for (let i = 0; i < length; i++) {
    L[i] *= g;
    R[i] *= g;
  }
  return { left: L, right: R, sampleRate, bpm: BPM, layout: LAYOUT };
}
