import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Plasma Discharge: branching electric filaments crawling across a dark void.
 *
 * A filament is the zero set of a domain-warped fractal noise field, i.e. the crest of the ridge
 * 1 - |f|. Thresholding it thin and anti-aliasing by fwidth gives crisp lines that branch wherever
 * the octaves cross. Each event grows its own tree: the field is anchored at the event's origin and
 * seeded by its own z offset, so every tree is a new branching pattern. A tree is masked by a patchy
 * noise so it grows in bushes, not over the whole frame, and each tree sits at one of three depths
 * (scale, brightness, corona softness).
 *
 * Growth: the front races out from the origin in about 0.1 s. Arrival time is the tree's own radial
 * distance, with a small coherent jag so the front is ragged along each branch. Behind it the tree
 * stays lit and cools over several seconds, a corona of its colour spilling off the filaments.
 *
 * Music:
 *  - morph: the field's scale, warp, branch threshold and layout rotation drift and jump every phrase.
 *    The melody winds the layout rotation on top, by the note's strength, glided over about 0.6 s.
 * Every tree's brightness goes with its event's strength (morph levels) and rises over 0.1 s; a
 * faint note's tree stays a local spray near its edge.
 *  - kick: fires a tree from the lower half of the frame, in the palette's hue family.
 *  - snare: fires a tree from the upper half, turned 150 degrees round the hue circle.
 *  - melody: fires a thin tree from the left or right edge at a height set by pitch, in the note's colour.
 *  - drops: a burst of trees staggered over 0.1 s, and the corona swells with morph.drive and surge.
 * The last four kick and snare trees and the last two melody trees are kept in the params.
 *
 * DNA: 0 seed (each cue is a new set of trees), 3 palette hue offset.
 */

const ASPECT = 16 / 9;
const morph = new Morph(0.9);
type Tree = { x: number; y: number; t: number; w: number };
const st = {
  seed: -1,
  last: -1,
  drop: 0,
  pe: 0,
  peV: 0,
  peT: 0,
  n: 0,
  nn: 0,
  fire: [] as Tree[],
  notes: [] as Tree[],
};
const hash = (x: number) => {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/**
 * A tree's family slot: the family (0 kick, 1 snare, 2 note) in the integer part; its seed and its
 * event's strength (morph level, 6 bits each) in the fraction.
 */
const famCode = (fam: number, seed: number, level: number) =>
  fam + (Math.round(Math.min(1, Math.max(0, level)) * 63) * 64 + Math.min(63, Math.floor(seed * 64)) + 0.5) / 4096;

export default raymarchScene({
  meta: {
    id: 'plasma-discharge',
    name: 'Plasma Discharge',
    // Out of the show: reads as tangled noise squiggles, not branching discharges.
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.5, arousal: 0.75 },
    genres: { edm: 0.9, techno: 0.8, dnb: 0.8, dubstep: 0.8, synthwave: 0.9, ambient: 0.5, hiphop: 0.6, pop: 0.6, rock: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    const now = m.time;
    if (st.seed !== g[0] || st.last < 0 || Math.abs(now - st.last - dt) > 0.5) {
      st.fire = [];
      st.notes = [];
      st.n = 0;
      st.nn = 0;
      st.pe = st.peT = morph.notePitch;
      st.peV = 0;
      st.drop = m.dropPulse;
    }
    st.seed = g[0];
    st.last = now;
    const live = dt > 0;
    const spread = wave(a[4], 0.5, 1.1);

    // Each kick or snare fires a new tree from its side. Trees keep their origin, time and seed.
    const addFire = (fam: number, t: number, level: number) => {
      const k = st.n++;
      const x = (hash(k * 2.3 + g[0] * 91.7) * 2 - 1) * 0.6 * spread * ASPECT;
      const y = fam === 0 ? -(0.5 + 0.25 * hash(k * 4.1 + g[0] * 5.7)) : 0.5 + 0.25 * hash(k * 4.1 + g[0] * 5.7 + 1);
      const w = famCode(fam, hash(k * 7.7 + g[0] * 3.3), level);
      st.fire.unshift({ x, y, t, w });
      st.fire.length = Math.min(st.fire.length, 4);
    };
    if (live && morph.kickAge === 0) addFire(0, now, morph.kickLevel);
    if (live && morph.snareAge === 0) addFire(1, now, morph.snareLevel);
    // A drop fires a burst: three more trees, staggered over 0.1 s (future times stay hidden until due).
    if (live && m.dropPulse > st.drop + 0.3) {
      for (let i = 1; i <= 3; i++) addFire(i % 2, now + 0.04 * i, 1);
    }
    st.drop = m.dropPulse;
    // A melody note fires a thin tree from the edge, at the height of its pitch.
    if (live && morph.leadAge === 0) {
      const nn = st.nn++;
      const side = nn % 2 ? 1 : -1;
      const w = famCode(2, hash(nn * 5.3 + g[0] * 2.1), morph.noteLevel);
      // The layout winds toward the note's pitch by the note's strength (a faint note barely turns it).
      st.peT += (morph.notePitch - st.peT) * morph.noteLevel;
      st.notes.unshift({ x: side * 1.1 * ASPECT, y: 0.75 * morph.notePitch, t: now, w });
      st.notes.length = Math.min(st.notes.length, 2);
    }
    // The layout's wind glides to it on a critically damped spring (from rest, settled in about 0.6 s).
    {
      const w = 8;
      const e = Math.exp(-w * dt);
      const d = st.pe - st.peT;
      const c = st.peV + w * d;
      st.peV = (st.peV - w * c * dt) * e;
      st.pe = st.peT + (d + c * dt) * e;
    }

    // Tree slots: ages are measured from the event (negative = not yet due, hidden in the shader).
    for (let i = 0; i < 4; i++) {
      const tr = st.fire[i];
      p.set(tr ? [tr.x, tr.y, now - tr.t, tr.w] : [0, 0, 99, 0], 4 * i);
    }
    for (let i = 0; i < 2; i++) {
      const tr = st.notes[i];
      p.set(tr ? [tr.x, tr.y, now - tr.t, tr.w] : [0, 0, 99, 0], 16 + 4 * i);
    }
    // Structure: layout rotation (winds with the melody), field scale, branch threshold, warp.
    p.set(
      [wave(a[0], -0.5, 0.5) + 0.4 * st.pe, wave(a[1], 1.2, 2.2), wave(a[2], -0.2, 0.14), wave(a[3], 0.2, 0.9)],
      24,
    );
    // Hue family, drive, surge and the travel that boils the filaments.
    p.set([g[3] + 0.05 * Math.sin(a[5] * 0.5), morph.drive, morph.surge, morph.travel * 0.12], 28);
  },
  wgsl: /* wgsl */ `
// Hue of the palette at t (its colourful hue, so grey entries still give a stable colour).
fn pd_hue(t: f32) -> f32 {
  let p = pal(t);
  let mx = max(p.r, max(p.g, p.b));
  let mn = min(p.r, min(p.g, p.b));
  let d = max(mx - mn, 1e-4);
  let hh = select(select((p.r - p.g) / d + 4.0, (p.b - p.r) / d + 2.0, mx == p.g), (p.g - p.b) / d, mx == p.r);
  return fract(hh / 6.0);
}

// Full-chroma ink at a hue, luminance evened out across the hue circle.
fn pd_ink(hh: f32) -> vec3f {
  let c = hsv2rgb(vec3f(fract(hh), 0.92, 1.0));
  return c * pow(0.4 / max(luma(c), 0.08), 0.55) * 0.55;
}

// Domain-warped fractal noise. Its zero set is the filament network (the crest of 1 - |f|).
fn pd_f(c: vec2f, z: f32) -> f32 {
  let wv = vec2f(noise3fast(vec3f(c, z)), noise3fast(vec3f(c + vec2f(5.2, 1.3), z + 7.7)));
  let q = c + S.p[6].w * wv;
  return 0.65 * noise3fast(vec3f(q, z + 3.1)) + 0.35 * noise3fast(vec3f(q * 2.03, z + 6.2));
}

// One tree (slot sl = origin xy, age, family + seed). Returns its HDR colour at this pixel.
fn pd_tree(pl: vec2f, sl: vec4f, hueA: f32, cg: f32, zt: f32) -> vec3f {
  let age = sl.z;
  if (age < 0.0 || age > 9.0) { return vec3f(0.0); }
  let fam = floor(sl.w);
  let code = floor(fract(sl.w) * 4096.0);
  let u = (code % 64.0 + 0.5) / 64.0;
  // The event's strength: the tree's brightness and (for notes) its reach go with it.
  let lv = floor(code / 64.0) / 63.0;
  let note = fam > 1.5;
  let snare = fam > 0.5 && !note;
  // Three depths: near (large, bright), mid, far (fine, dim).
  let layer = floor(fract(u * 7.31) * 3.0);
  let lk = select(select(1.0, 1.6, layer > 0.5), 2.6, layer > 1.5);
  let lb = select(select(1.0, 0.6, layer > 0.5), 0.35, layer > 1.5);
  // Growth: notes race across the frame, kicks and snares reach about 1.5 plane units.
  // A faint note's tree stays a local spray near its edge; a strong one races across the frame.
  let rmax = select(1.5, 2.8 * (0.3 + 0.7 * lv), note);
  let tauF = select(0.035, 0.07, note) / (1.0 + 1.5 * S.p[7].z);
  let tauC = select(3.0, 1.6, note);
  let thr = S.p[6].z + select(0.0, 0.12, note);
  let fq = S.p[6].y * lk * select(1.0, 1.7, note);
  let d = rot2(S.p[6].x) * (pl - sl.xy);
  let r = length(d);
  let c = d * fq;
  let z = u * 37.0 + zt;
  // Zero the field at the origin, so the tree is rooted there.
  let f = pd_f(c, z) - pd_f(vec2f(0.0), z);
  let fw = max(fwidth(f), 1e-5);
  let dpx = abs(f) / fw;
  // Patchy mask: trees grow in bushes with gaps.
  let mk = noise3fast(vec3f(c * 0.35 + vec2f(13.0, 4.0), z * 0.5 + 2.0));
  let pch = smoothstep(thr - 0.06, thr + 0.06, mk);
  // Arrival along the branch: its own radial distance, with a coherent per-branch jag.
  let tt = r + 0.05 * noise3fast(vec3f(c * 1.7, z + 17.0));
  let rf = rmax * (1.0 - exp(-age / tauF));
  let h = rf - tt;
  let edge = smoothstep(rmax, 0.8 * rmax, r);
  let lit = smoothstep(-0.004, 0.004, h) * edge * pch;
  // Each tree's light rises over about 0.1 s (never a one-frame flash) and goes with its strength.
  let cool = exp(-age / tauC) * lb * lv * smoothstep(0.0, 0.1, age);
  // Hot head at the front, then the trail cools to its colour.
  let hd = exp(-max(h, 0.0) / 0.03) * smoothstep(-0.004, 0.0, h) * exp(-age / 0.22);
  // Filament: crisp 1 px box-filtered line, thinning with distance; corona falls off in pixels.
  let hw = select(1.15, 0.8, note) * (1.0 - 0.35 * clamp(r / rmax, 0.0, 1.0));
  let cr = clamp(hw - dpx + 0.5, 0.0, 1.0);
  // Corona in field units (no derivative): a derivative here speckles on the value-noise lattice.
  let glow = exp(-abs(f) / (0.02 * lk));
  // Kick colour family, snare turned 150 degrees, melody colour set by pitch (y = 0.75 * pitch).
  let hf = select(hueA, hueA + 0.42, snare);
  let hue = select(hf, hueA + 0.5 + 0.22 * clamp(sl.y / 0.75, -1.0, 1.0), note);
  let ink = pd_ink(hue);
  let hot = vec3f(1.0, 0.93, 0.8);
  return (ink * (cr * 2.4 + glow * cg * 0.6) + hot * hd * cr * 2.2) * lit * cool;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let pl = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let hueA = pd_hue(S.p[7].x);
  // Corona gain swells with the drive, and with the drop surge.
  let cg = 0.7 + 1.2 * S.p[7].y + 0.9 * S.p[7].z;
  let zt = S.p[7].w;
  // Dark void with a faint deep tint of the accent hue.
  var c = pd_ink(hueA + 0.5) * 0.02;
  c += pd_tree(pl, S.p[0], hueA, cg, zt);
  c += pd_tree(pl, S.p[1], hueA, cg, zt);
  c += pd_tree(pl, S.p[2], hueA, cg, zt);
  c += pd_tree(pl, S.p[3], hueA, cg, zt);
  c += pd_tree(pl, S.p[4], hueA, cg, zt);
  c += pd_tree(pl, S.p[5], hueA, cg, zt);
  let pk = max(c.r, max(c.g, c.b));
  return vec4f(c / (1.0 + 0.3 * max(pk - 0.9, 0.0)), 1.0);
}
`,
});
