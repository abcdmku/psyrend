import { similarity, type GenomeTrace } from './genome';

interface Entry {
  g: GenomeTrace;
  /** Epoch ms when it was on screen. */
  at: number;
  /** Seconds it was visible (longer exposure = more memorable). */
  dur: number;
}

const KEY = 'psyrend.novelty.v1';
const WINDOW_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1500;

/**
 * Remembers what was on screen over the last 30 minutes (across songs and reloads,
 * via localStorage) and scores how familiar a candidate genome would look.
 */
export class NoveltyMemory {
  private entries: Entry[] = [];

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    try {
      const raw = this.storage?.getItem(KEY);
      if (raw) this.entries = (JSON.parse(raw) as Entry[]).filter((e) => e && e.g && typeof e.at === 'number');
    } catch {
      this.entries = [];
    }
    this.prune(Date.now());
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((e) => now - e.at < WINDOW_MS);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
  }

  /**
   * Familiarity of `g` if shown at `at` (epoch ms), plus any `extra` traces (e.g. cues
   * already planned for the current song). Full weight inside 15 minutes, fading to 0 at 30.
   */
  familiarity(g: GenomeTrace, at: number, extra: { g: GenomeTrace; at: number; dur: number }[] = []): number {
    let f = 0;
    const visit = (e: { g: GenomeTrace; at: number; dur: number }) => {
      const age = Math.abs(at - e.at);
      if (age >= WINDOW_MS) return;
      const recency = age < WINDOW_MS / 2 ? 1 : 1 - (age - WINDOW_MS / 2) / (WINDOW_MS / 2);
      const exposure = Math.min(1.5, 0.5 + e.dur / 30);
      const sim = similarity(g, e.g);
      // Only genuinely similar visuals count; different worlds with the same look barely register.
      f += Math.max(0, sim - 0.2) * recency * exposure;
    };
    for (const e of this.entries) visit(e);
    for (const e of extra) visit(e);
    return f;
  }

  /** Whether a world (scene id) was on screen within the window before `at` (epoch ms). */
  seen(sceneId: string, at: number): boolean {
    return this.entries.some((e) => e.g.sceneId === sceneId && Math.abs(at - e.at) < WINDOW_MS);
  }

  record(g: GenomeTrace, at: number, dur: number): void {
    this.entries.push({ g, at, dur });
    this.prune(Math.max(Date.now(), at));
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.entries));
    } catch {
      /* storage full or unavailable: memory stays in-session */
    }
  }

  /** Entries in the window (for debugging / tests). */
  get size(): number {
    return this.entries.length;
  }
}
