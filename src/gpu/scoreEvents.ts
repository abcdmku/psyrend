import { GESTURE_FLOATS, GESTURE_RATE, melodicGesture } from '../audio/analysis/gesture';
import type { TrackAnalysis } from '../audio/types';

/**
 * The song's discrete events as GPU storage buffers (fixed size, so bind groups stay valid across
 * tracks) plus CPU copies for finding which instances are visible in a time window.
 *
 * notes  : 12 floats = start, end, pitch, strength, role (0 lead, 1 bass, 2 poly), motif (-1 none), arp (0/1), motifPos,
 *          glide (when the line reaches the next note of the same voice; = end if it doesn't), nextPitch, 0, 0
 * chords : 8 floats = start, end, root (-1 none), quality (0 none, 1 maj, 2 min, 3 dim), tension, 0, 0, 0
 * hits   : 4 floats = time, kind (0 kick, 1 snare, 2 hat), strength, 0
 * gesture: the melodic gesture track (see melodicGesture), GESTURE_RATE rows/s
 */
export const MAX_NOTES = 16384;
export const MAX_CHORDS = 4096;
export const MAX_HITS = 16384;
/** 20 minutes of gesture. */
export const MAX_GESTURE_ROWS = 20 * 60 * GESTURE_RATE;
/** Notes longer than this are clipped so window queries stay bounded. */
const MAX_NOTE_LEN = 8;
const NOTE_FLOATS = 12;
/** A lead or bass line glides into its next note when the gap is shorter than this (legato phrasing). */
const GLIDE_GAP = 0.35;

export interface Range {
  first: number;
  count: number;
}

export class ScoreEvents {
  readonly notes: GPUBuffer;
  readonly chords: GPUBuffer;
  readonly hits: GPUBuffer;
  readonly gesture: GPUBuffer;
  gestureRows = 0;
  private noteStart = new Float32Array(0);
  private chordStart = new Float32Array(0);
  private chordEnd = new Float32Array(0);
  private hitTime = new Float32Array(0);
  noteCount = 0;
  chordCount = 0;
  hitCount = 0;

  constructor(private readonly device: GPUDevice) {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.notes = device.createBuffer({ label: 'score-notes', size: MAX_NOTES * NOTE_FLOATS * 4, usage });
    this.chords = device.createBuffer({ label: 'score-chords', size: MAX_CHORDS * 32, usage });
    this.hits = device.createBuffer({ label: 'score-hits', size: MAX_HITS * 16, usage });
    this.gesture = device.createBuffer({ label: 'score-gesture', size: MAX_GESTURE_ROWS * GESTURE_FLOATS * 4, usage });
  }

  clear(): void {
    this.noteCount = this.chordCount = this.hitCount = this.gestureRows = 0;
  }

  load(a: TrackAnalysis): void {
    const notes = a.notes.slice(0, MAX_NOTES);
    const nd = new Float32Array(notes.length * NOTE_FLOATS);
    // Each lead / bass note knows its successor in the same voice, so lines can be drawn connected.
    const next = new Map<number, number>();
    for (const role of ['lead', 'bass'] as const) {
      let prev = -1;
      notes.forEach((n, i) => {
        if (n.role !== role) return;
        if (prev >= 0) next.set(prev, i);
        prev = i;
      });
    }
    notes.forEach((n, i) => {
      const end = Math.min(n.end, n.start + MAX_NOTE_LEN);
      const nx = next.has(i) ? notes[next.get(i)!] : undefined;
      const joins = !!nx && nx.start > end - 0.02 && nx.start - end < GLIDE_GAP && Math.abs(nx.pitch - n.pitch) <= 12;
      const glide = joins ? Math.min(nx!.start, n.start + MAX_NOTE_LEN) : end;
      nd.set([n.start, end, n.pitch, n.strength, n.role === 'lead' ? 0 : n.role === 'bass' ? 1 : 2, n.motif, n.arp ? 1 : 0, n.motifPos, glide, joins ? nx!.pitch : n.pitch, 0, 0], i * NOTE_FLOATS);
    });
    this.noteStart = Float32Array.from(notes, (n) => n.start);
    const chords = a.chords.slice(0, MAX_CHORDS);
    const cd = new Float32Array(chords.length * 8);
    chords.forEach((c, i) => {
      cd.set([c.start, c.end, c.root, c.quality === 'maj' ? 1 : c.quality === 'min' ? 2 : c.quality === 'dim' ? 3 : 0, c.tension, 0, 0, 0], i * 8);
    });
    this.chordStart = Float32Array.from(chords, (c) => c.start);
    this.chordEnd = Float32Array.from(chords, (c) => c.end);
    const hits: [number, number, number][] = [];
    const add = (times: Float32Array, strengths: Float32Array, kind: number) => times.forEach((t, i) => hits.push([t, kind, strengths[i]]));
    add(a.kicks.times, a.kicks.strengths, 0);
    add(a.snares.times, a.snares.strengths, 1);
    add(a.hats.times, a.hats.strengths, 2);
    hits.sort((x, y) => x[0] - y[0]);
    const hs = hits.slice(0, MAX_HITS);
    const hd = new Float32Array(hs.length * 4);
    hs.forEach((h, i) => hd.set([h[0], h[1], h[2], 0], i * 4));
    this.hitTime = Float32Array.from(hs, (h) => h[0]);
    if (nd.length) this.device.queue.writeBuffer(this.notes, 0, nd);
    if (cd.length) this.device.queue.writeBuffer(this.chords, 0, cd);
    if (hd.length) this.device.queue.writeBuffer(this.hits, 0, hd);
    const g = melodicGesture(a);
    this.gestureRows = Math.min(MAX_GESTURE_ROWS, g.length / GESTURE_FLOATS);
    this.device.queue.writeBuffer(this.gesture, 0, g, 0, this.gestureRows * GESTURE_FLOATS);
    this.noteCount = notes.length;
    this.chordCount = chords.length;
    this.hitCount = hs.length;
  }

  private static lower(arr: Float32Array, t: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m] < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** Notes overlapping [t0, t1]. */
  notesIn(t0: number, t1: number): Range {
    const first = ScoreEvents.lower(this.noteStart, t0 - MAX_NOTE_LEN);
    const last = ScoreEvents.lower(this.noteStart, t1);
    return { first, count: Math.max(0, last - first) };
  }

  chordsIn(t0: number, t1: number): Range {
    const first = Math.max(0, ScoreEvents.lower(this.chordEnd, t0));
    const last = ScoreEvents.lower(this.chordStart, t1);
    return { first, count: Math.max(0, last - first) };
  }

  hitsIn(t0: number, t1: number): Range {
    const first = ScoreEvents.lower(this.hitTime, t0);
    const last = ScoreEvents.lower(this.hitTime, t1);
    return { first, count: Math.max(0, last - first) };
  }
}
