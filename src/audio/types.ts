export const BAND_COUNT = 64;
export const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export type Mode = 'major' | 'minor';
export type ChordQuality = 'maj' | 'min' | 'dim' | 'none';

export type SectionKind = 'intro' | 'verse' | 'build' | 'peak' | 'breakdown' | 'bridge' | 'outro';

export const GENRES = [
  'techno',
  'edm',
  'dnb',
  'dubstep',
  'hiphop',
  'pop',
  'rock',
  'ambient',
  'classical',
  'jazz',
  'acoustic',
  'lofi',
  'synthwave',
] as const;
export type GenreId = (typeof GENRES)[number];

export const GENRE_LABELS: Record<GenreId, string> = {
  techno: 'Techno / House',
  edm: 'EDM / Trance',
  dnb: 'Drum & Bass',
  dubstep: 'Dubstep / Bass',
  hiphop: 'Hip-Hop / Trap',
  pop: 'Pop',
  rock: 'Rock / Metal',
  ambient: 'Ambient / Drone',
  classical: 'Classical / Orchestral',
  jazz: 'Jazz / Soul',
  acoustic: 'Acoustic / Folk',
  lofi: 'Lo-fi / Chill',
  synthwave: 'Synthwave / Retro',
};

export interface OnsetTrack {
  times: Float32Array;
  strengths: Float32Array;
}

export type NoteRole = 'lead' | 'bass' | 'poly';

/** A transcribed note. Times in seconds, pitch in (fractional) MIDI. */
export interface NoteEvent {
  start: number;
  end: number;
  pitch: number;
  /** 0..1 salience. */
  strength: number;
  role: NoteRole;
  /** Part of a fast chord-tone run. */
  arp: boolean;
  /** Motif id (-1 if none); every return of the same melodic pattern shares it. */
  motif: number;
  /** Position of this note within its motif instance. */
  motifPos: number;
}

export interface Chord {
  start: number;
  end: number;
  root: number;
  quality: ChordQuality;
  /** 0 = resolved/tonic, 1 = maximal harmonic tension relative to the key. */
  tension: number;
}

export interface Section {
  start: number;
  end: number;
  kind: SectionKind;
  /** Repetition cluster: sections sharing a cluster sound alike (e.g. every chorus). */
  cluster: number;
  /** Mean normalized energy 0..1. */
  energy: number;
  valence: number;
  arousal: number;
}

export interface GenreScore {
  id: GenreId;
  label: string;
  confidence: number;
}

export interface TrackAnalysis {
  duration: number;
  frameRate: number;
  frameCount: number;
  /** frameCount x BAND_COUNT log-spaced band levels, normalized 0..1. */
  bands: Float32Array;
  /** frameCount x 12 chroma, each frame max-normalized. */
  chroma: Float32Array;
  energy: Float32Array;
  energySlow: Float32Array;
  sub: Float32Array;
  bass: Float32Array;
  lowMid: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  centroid: Float32Array;
  flatness: Float32Array;
  percussive: Float32Array;
  flux: Float32Array;
  valence: Float32Array;
  arousal: Float32Array;
  /** 0..1 ramp that rises ahead of big energy arrivals (drops, choruses). */
  anticipation: Float32Array;

  kicks: OnsetTrack;
  snares: OnsetTrack;
  hats: OnsetTrack;
  onsets: OnsetTrack;

  bpm: number;
  beatsPerBar: number;
  beats: Float32Array;
  downbeats: Float32Array;
  /** 0..1 how clearly rhythmic the track is. */
  pulseClarity: number;

  key: { root: number; mode: Mode; confidence: number; name: string };
  chords: Chord[];
  sections: Section[];
  /** Times where a large energy arrival lands (drops / big choruses). */
  drops: Float32Array;

  /** Transcribed lead, bass and polyphonic notes, sorted by start. */
  notes: NoteEvent[];
  motifCount: number;
  /** Lead/bass pitch contours (MIDI, 0 = silent) sampled at contourRate. */
  contourRate: number;
  /** contourFrames x pitchSemis harmonic pitch salience from MIDI pitchMin upward (a "what is sounding" image). */
  pitchgram: Float32Array;
  pitchMin: number;
  pitchSemis: number;
  leadContour: Float32Array;
  bassContour: Float32Array;

  mood: { valence: number; arousal: number; label: string };
  genres: GenreScore[];
  /** 0..1 how hard the whole song hits in absolute terms (loudness, onset rate, drums, tempo). */
  intensity: number;
  /** The raw song-level measures behind intensity. */
  character: { loudDb: number; onsetRate: number; percussive: number };
}

export type AnalysisProgress = { stage: string; progress: number };

export interface AnalysisRequest {
  samples: Float32Array;
  sampleRate: number;
}

export type AnalysisWorkerMessage =
  | { type: 'progress'; stage: string; progress: number }
  | { type: 'done'; analysis: TrackAnalysis }
  | { type: 'error'; message: string };
