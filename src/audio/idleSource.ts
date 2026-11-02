import { emptyMusicState, type MusicState } from './musicState';
import { BAND_COUNT } from './types';

/** Slow synthetic "music" that keeps the visuals breathing behind menus. */
export class IdleSource {
  private readonly s = emptyMusicState();

  sample(t: number): MusicState {
    const s = this.s;
    const bpm = 96;
    const beat = (t * bpm) / 60;
    s.time = t;
    s.bpm = bpm;
    s.beatIndex = Math.floor(beat);
    s.beatPhase = beat % 1;
    s.barIndex = Math.floor(beat / 4);
    s.barPhase = (beat / 4) % 1;
    s.beatPulse = Math.exp(-s.beatPhase * 4) * 0.4;
    s.barPulse = Math.exp(-s.barPhase * 6) * 0.3;
    const breath = 0.5 + 0.5 * Math.sin(t * 0.21);
    s.energy = 0.18 + 0.12 * breath;
    s.energySlow = s.energy;
    s.bass = 0.25 + 0.2 * s.beatPulse;
    s.mid = 0.25;
    s.high = 0.15;
    s.centroid = 0.4;
    s.flux = 0.15;
    s.valence = 0.55 + 0.1 * Math.sin(t * 0.05);
    s.arousal = 0.3;
    s.tension = 0.25 + 0.15 * Math.sin(t * 0.13);
    s.kick = s.beatPulse * 0.4;
    for (let b = 0; b < BAND_COUNT; b++) {
      const x = b / BAND_COUNT;
      s.bands[b] = Math.max(0, 0.35 * (1 - x) + 0.15 * Math.sin(t * 1.3 + x * 9) * breath + 0.1 * Math.sin(t * 0.7 - x * 17));
    }
    for (let c = 0; c < 12; c++) s.chroma[c] = 0.5 + 0.5 * Math.sin(t * 0.3 + c * 0.52);
    return s;
  }
}
