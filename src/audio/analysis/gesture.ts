import type { NoteEvent, TrackAnalysis } from '../types';

/** Rows per second of the gesture track. */
export const GESTURE_RATE = 30;
/** Floats per row: pos.xyz + activity, fwd.xyz + height, up.xyz + onset. */
export const GESTURE_FLOATS = 12;

type V3 = [number, number, number];
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Rotates v around unit axis k by angle a (Rodrigues). */
const rot = (v: V3, k: V3, a: number): V3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const d = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
};

/**
 * The melody as a gesture in space: a path flown at a steady pace whose turns are the melody.
 * Every melodic interval pitches the heading (rising intervals climb, falling ones dive, larger
 * leaps turn harder), the harmony sets the plane those turns happen in (the frame rolls toward the
 * chord root's place on the circle of fifths), and in silence the path relaxes back toward its home
 * direction. The same motif over the same chord therefore draws the same curve, a new chord draws
 * it in a new plane, and a still passage flies straight.
 *
 * Per row (GESTURE_RATE rows/s): pos.xyz + melodic activity (0..1, smoothed onset density);
 * fwd.xyz + melody height (-1..1, smoothed pitch relative to the song's melodic centre);
 * up.xyz + onset envelope (0..1, the latest attack decaying).
 */
export function melodicGesture(a: Pick<TrackAnalysis, 'duration' | 'notes' | 'chords'>): Float32Array<ArrayBuffer> {
  const rows = Math.max(2, Math.ceil(a.duration * GESTURE_RATE) + 2);
  const out = new Float32Array(rows * GESTURE_FLOATS);
  // The melody: the lead line, or the bass when the lead is too sparse to carry a gesture.
  const lead = a.notes.filter((n) => n.role === 'lead');
  const melody: NoteEvent[] = lead.length >= a.duration / 4 ? lead : a.notes.filter((n) => n.role === 'lead' || n.role === 'bass');
  melody.sort((x, y) => x.start - y.start);
  const pitches = melody.map((n) => n.pitch).sort((x, y) => x - y);
  const centre = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 60;

  const dt = 1 / GESTURE_RATE;
  const home: V3 = [0, 0, 1];
  let pos: V3 = [0, 0, 0];
  let fwd: V3 = [0, 0, 1];
  let up: V3 = [0, 1, 0];
  let ni = 0;
  let prevPitch = NaN;
  let turnLeft = 0; // radians of pitch-turn still to apply
  let ci = 0;
  let bankTarget = 0;
  let bank = 0;
  const worldUp: V3 = [0, 1, 0];
  let activity = 0;
  let onset = 0;
  let height = 0;
  let lastPitch = centre;

  for (let r = 0; r < rows; r++) {
    const t = r * dt;
    // New attacks this step: each interval becomes a turn, spread over the next ~0.2 s.
    while (ni < melody.length && melody[ni].start <= t) {
      const n = melody[ni++];
      if (!Number.isNaN(prevPitch) && n.start - melody[ni - 2].end < 1.5) {
        const iv = Math.max(-12, Math.min(12, n.pitch - prevPitch));
        turnLeft += iv * 0.04 * (0.6 + 0.6 * n.strength);
      }
      prevPitch = n.pitch;
      lastPitch = n.pitch;
      onset = Math.max(onset, 0.4 + 0.6 * n.strength);
      activity = Math.min(1, activity + 0.18 * (0.5 + n.strength));
    }
    while (ci < a.chords.length - 1 && a.chords[ci + 1].start <= t) ci++;
    const ch = a.chords[ci];
    // The chord banks the path (its root's place on the circle of fifths, within about +-35 degrees),
    // so each harmony tilts the plane the melody turns in without ever flipping the world over.
    if (ch && ch.root >= 0 && ch.start <= t) bankTarget = 0.6 * Math.sin((((ch.root * 7) % 12) / 12) * Math.PI * 2);
    bank += (bankTarget - bank) * (1 - Math.exp(-dt * 1.2));
    const level = norm(add(worldUp, fwd, -dot(worldUp, fwd)));
    up = rot(level, fwd, bank);

    // Apply part of the pending melodic turn around the frame's right axis.
    const right = norm(cross(fwd, up));
    const step = turnLeft * (1 - Math.exp(-dt / 0.3));
    turnLeft -= step;
    fwd = norm(rot(fwd, right, -step));
    up = norm(rot(up, right, -step));

    // Relax toward home when the melody rests, and always keep moving forward overall.
    const along = dot(fwd, home);
    // Gentle curves: the path never strays past ~60 degrees from home, so it reads as climbs and
    // dives on a journey rather than knotting into loops.
    const pull = (0.5 * (1 - activity) + 0.2 + (along < 0.5 ? 3 * (0.5 - along) : 0)) * dt;
    const axis = cross(fwd, home);
    const al = Math.hypot(axis[0], axis[1], axis[2]);
    if (al > 1e-5) {
      const k = norm(axis);
      const ang = Math.min(Math.asin(Math.min(1, al)), pull);
      fwd = norm(rot(fwd, k, ang));
      up = norm(rot(up, k, ang));
    }
    // Re-orthonormalise.
    up = norm(add(up, fwd, -dot(up, fwd)));

    let silent = true;
    for (let k = Math.max(0, ni - 3); k < ni; k++) if (melody[k].end + 0.3 > t) silent = false;
    height += ((silent ? 0 : Math.max(-1, Math.min(1, (lastPitch - centre) / 12))) - height) * (1 - Math.exp(-dt / 0.3));
    activity *= Math.exp(-dt / 1.2);
    onset *= Math.exp(-dt * 6);

    const o = r * GESTURE_FLOATS;
    out.set([pos[0], pos[1], pos[2], activity, fwd[0], fwd[1], fwd[2], height, up[0], up[1], up[2], onset], o);
    pos = add(pos, fwd, dt);
  }
  return out;
}
