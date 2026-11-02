import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';

const morph = new Morph(1.25);

/**
 * One term of the equation that events change. Each event sets a new target, and the term glides to
 * it on a critically damped spring (from rest, settling in 0.4-0.7 s, no overshoot), so events
 * in quick succession blend into one smooth motion instead of restarting an ease.
 */
class Term {
  private x = 0;
  private vel = 0;
  private target = 0;
  private last = -1;
  private n = -1;
  /**
   * Colour fronts: when the latest and the one-before fronts were lit, and how many have been lit.
   * Two fronts burn at once, so a new one never cuts the last one off; a new front is lit only once
   * the latest is `gap` seconds old, so the one dropped has always burned out (a roll or fill merges).
   */
  private tCur = -99;
  private tPrev = -99;
  fronts = 0;
  /** Strength (0..1) of the latest and the one-before fronts, so each glow keeps its own hit's level. */
  lCur = 0;
  lPrev = 0;
  constructor(
    private readonly gap: number,
    private readonly w: number,
  ) {}
  update(count: number, now: number, age: number, level: number, reset: boolean, next: (cur: number) => number): void {
    const dt = Math.min(Math.max(now - this.last, 0), 0.1);
    this.last = now;
    if (reset || count < this.n || this.n < 0) {
      this.target = this.x = this.n < 0 ? next(0) : this.target;
      this.vel = 0;
      this.tCur = this.tPrev = -99;
      this.lCur = this.lPrev = 0;
    } else if (count > this.n) {
      this.target = next(this.target);
      if (now - age - this.tCur >= this.gap) {
        this.tPrev = this.tCur;
        this.tCur = now - age;
        this.lPrev = this.lCur;
        this.lCur = level;
        this.fronts++;
      } else this.lCur = Math.max(this.lCur, level);
    }
    this.n = count;
    const w = this.w;
    const e = Math.exp(-w * dt);
    const d = this.x - this.target;
    const c = this.vel + w * d;
    this.vel = (this.vel - w * c * dt) * e;
    this.x = this.target + (d + c * dt) * e;
  }
  /** Writes the glided value (plus a continuous drift), the two fronts' ages and the front count. */
  write(p: Float32Array, o: number, drift: number): void {
    const now = this.last;
    p[o] = this.x + drift;
    p[o + 1] = Math.min(now - this.tCur, 99);
    p[o + 2] = Math.min(now - this.tPrev, 99);
    p[o + 3] = this.fronts;
  }
}

/**
 * A glow that swells with each event of one kind: every event lifts its target, which then decays,
 * and the glow follows on a critically damped spring, so it rises from rest over about a quarter
 * second and dense events merge into one smooth swell (no per-event restart, nothing cut off).
 */
class Swell {
  private tgt = 0;
  private v = 0;
  private n = -1;
  x = 0;
  update(count: number, dt: number, reset: boolean, release: number, level: number): number {
    if (reset || this.n < 0 || count < this.n) this.tgt = this.x = this.v = 0;
    else if (count > this.n) this.tgt = Math.max(this.tgt, level);
    this.n = count;
    this.tgt *= Math.exp(-dt / release);
    const w = 12;
    const e = Math.exp(-w * dt);
    const d = this.x - this.tgt;
    const c = this.v + w * d;
    this.v = (this.v - w * c * dt) * e;
    this.x = this.tgt + (d + c * dt) * e;
    return this.x;
  }
}

const kickT = new Term(0.4, 11);
const snareT = new Term(0.35, 11);
const noteT = new Term(0.3, 7);
const noteSwell = new Swell();
const st = { t: -1, seed: -1, drive: 0, rush: 0 };
const hash = (x: number) => {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Inside an endless Menger architecture: solid space carved by square tunnels along all three
 * axes, side tunnels inside every wall, and two finer levels engraved into the walls as panel
 * seams. You travel down one of the great halls. The picture is the fractal alone: the music acts
 * only on its equation.
 *
 * The equation flows all the time: the scale between levels, the hall width, the square-to-round
 * cut and the turn axis drift at a steady pace (the melody bends their heading), easing down only in
 * long quiet. Each event permanently changes one term of the equation by its strength (the morph
 * level; the melody by its square, so a faint motif colours the wall rather than re-cutting the
 * vault), eased in everywhere at once
 * over about a third of a beat; colour and light fronts burn outward from where the event struck:
 * - Kick: each level's offset inside its parent cell (the side tunnels and panels slide to a new
 *   arrangement); a burn spreads from a spot on the walls down the hall and re-anodises the stone.
 * - Snare: each level's turn inside its parent cell (the sub-structure twists), and a white-blue
 *   flash sweeps the arrises down the hall, leaving them a new trim colour.
 * - Melody: the side tunnels' width, set by the note's pitch (high notes open them, low notes close
 *   them); the note's colour spreads from the wall just ahead.
 *
 * DNA: 0-1 starting point and path, 2 rotation axis, 3 material, 4 light rig, 5 hue, 6 fog,
 * 7 hall wander.
 */
export default raymarchScene({
  meta: {
    id: 'menger-vault',
    name: 'Sponge Vault',
    // Out of the show until fixed (gate: one hue, no darks, snare/melody do not register).
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.45, arousal: 0.7 },
    genres: { techno: 1, edm: 0.9, dubstep: 0.85, dnb: 0.7, ambient: 0.6, synthwave: 0.5, rock: 0.4 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const now = m.time;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const reset = g[0] !== st.seed || Math.abs(now - st.t - dt) > 0.5;
    st.seed = g[0];
    st.t = now;
    const tr = morph.travel;
    // The continuous flow (the melody bends its heading, chords lean it), without the beat steps:
    // those are swept through the halls below.
    const flowAt = (i: number) => morph.flowAt[i % 8];

    // Continuous terms: scale between levels, hall width, square -> round, turn axis.
    const sc = wave(flowAt(0), 2.4, 3.8);
    p[0] = sc;
    p[1] = wave(flowAt(1), 0.36, 0.54);
    p[2] = Math.max(0, wave(flowAt(2), -0.4, 0.9));
    p[3] = g[5] + 0.06 * Math.sin(flowAt(3) * 0.5);
    const ax = [0.5 * Math.sin(g[2] * 6.28 + flowAt(4)), 0.5 * Math.cos(g[2] * 6.28 + flowAt(5)), 1];
    const al = Math.hypot(ax[0], ax[1], ax[2]);
    p[4] = ax[0] / al;
    p[5] = ax[1] / al;
    p[6] = ax[2] / al;
    // Camera z, roll, focal length, hall wander.
    // A drop throws the camera forward: extra travel while the surge lasts.
    st.rush = reset ? 0 : st.rush + dt * morph.surge * morph.surge * 1.6;
    p[7] = tr * 0.45 + st.rush + g[7] * 40;
    p[21] = 0.4 * Math.sin(tr * 0.25 + g[7] * 6);
    // Cut family: square or round tunnels (above) blended toward diamond (octahedral) ones.
    p[22] = Math.max(0, wave(flowAt(3) * 1.3 + 1.0, -0.5, 1.0));
    // The hall wanders wider when the bass drives.
    st.drive += (morph.drive - st.drive) * (reset ? 1 : 1 - Math.exp(-dt / 0.6));
    p[23] = (0.25 + 0.35 * g[7]) * (1 + 0.9 * st.drive);

    // Event terms. Kick: offset phase (each kick jumps it to a new arrangement).
    // Every step is scaled by its hit's strength (morph levels, which carry the passage's presence).
    kickT.update(morph.kicks, now, morph.kickAge, morph.kickLevel, reset, (u) => u + (1.3 + 1.6 * hash(morph.kicks + g[0] * 7)) * morph.kickLevel);
    kickT.write(p, 8, flowAt(6) * 0.25);
    // Snare: the turn of each level, alternating direction.
    snareT.update(morph.snares, now, morph.snareAge, morph.snareLevel, reset, (a) => {
      const s = morph.snares % 2 ? 1 : -1;
      return Math.max(-0.3, Math.min(0.3, a + s * (0.16 + 0.1 * hash(morph.snares + 3.1)) * morph.snareLevel));
    });
    snareT.write(p, 12, wave(flowAt(7), -0.25, 0.25));
    // Melody: the side tunnels' width and how round they are cut, from the note's pitch.
    // The tunnels' width re-cuts every wall in view, so a note moves it by its strength squared: a
    // faint note's change is its colour on the wall ahead, a strong one in a full mix re-cuts the vault.
    noteT.update(morph.notes, now, morph.leadAge, morph.noteLevel, reset, (cur) => {
      const to = Math.max(-1, Math.min(1, morph.notePitch * 1.4 + 0.45 * Math.sin(morph.notes * 2.7)));
      return cur + (to - cur) * morph.noteLevel * morph.noteLevel;
    });
    noteT.write(p, 16, 0);
    // Room each level has to slide inside its parent cell.
    p[20] = 0.6 * Math.max(0, sc - 2 - 0.4 - 0.08) / sc;
    // Front strengths, 6 bits each: kick latest, kick previous, snare latest, snare previous.
    const q6 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 63);
    p[24] = q6(kickT.lCur) * 262144 + q6(kickT.lPrev) * 4096 + q6(snareT.lCur) * 64 + q6(snareT.lPrev);
    p[25] = morph.snares;
    p[26] = Math.min(2, Math.floor(g[3] * 3));
    p[27] = Math.min(morph.kickAge, 99);
    p[28] = Math.floor(g[4] * 3);
    // Melody glow: swells with each note (notes come too densely for one front per note).
    p[29] = noteSwell.update(morph.notes, dt, reset, 0.5, morph.noteLevel);
    p[30] = 0.06 + 0.08 * g[6];
    p[31] = Math.min(morph.snareAge, 99);
  },
  wgsl: /* wgsl */ `
fn mv_path(z: f32) -> vec2f {
  let w = S.p[5].w * (S.p[0].y - 0.2);
  return vec2f(sin(z * 0.37) * 0.7 + sin(z * 0.13 + 1.0) * 0.3, cos(z * 0.29) * 0.6) * w;
}

// Cut of one level: the three axis tunnels through a cell (local coords in [-1, 1]), square or round.
// Cross-section norm of a tunnel: square, round (k) or diamond (S.p[5].z).
fn mv_n2(a: vec2f, k: f32) -> f32 { return mix(mix(max(a.x, a.y), length(a), k), (a.x + a.y) * 0.7071, S.p[5].z); }
fn mv_cut(a: vec3f, h: f32, k: f32) -> f32 {
  let q = abs(a);
  let yz = mv_n2(q.yz, k);
  let xz = mv_n2(q.xz, k);
  let xy = mv_n2(q.xy, k);
  return min(yz, min(xz, xy)) - h;
}

// A front: 0 before the new value arrives, 1 after; T is the arrival time. The shape terms glide in
// everywhere at once (springs on the CPU); at each point a colour front takes over across a third of
// a second. The previous front keeps burning out while a new one starts, so a new beat never cuts a
// front off, and every front has reached everything within 0.45 s, before a newer one can replace it.
fn mv_fr(age: f32, T: f32) -> f32 { return smoothstep(0.0, 1.0, (age - T) / 0.35); }
// A glow that swells in from nothing over r seconds, then cools at rate k: never a flash.
fn mv_pulse2(x: vec2f, r: f32, k: f32) -> vec2f { return smoothstep(vec2f(0.0), vec2f(r), x) * exp(-max(x - r, vec2f(0.0)) * k); }

// Where a kick's front starts: a spot on the hall's wall down the hall, a new one for every kick.
fn mv_kickO(k: f32) -> vec3f {
  let h = hashU3(u32(max(k, 0.0)) * 2654435761u);
  let z = S.p[1].w + 1.5 + 1.5 * h.x;
  return vec3f(mv_path(z) + vec2f(cos(h.y * TAU), sin(h.y * TAU)) * S.p[0].y, z);
}
// Arrival times at p of the latest (x) and previous (y) kick and snare fronts, and the melody
// glow's weight at p.
struct MvFronts { k: vec2f, s: f32, m: f32 };
fn mv_fronts(p: vec3f) -> MvFronts {
  let z = S.p[1].w;
  var f: MvFronts;
  let K = S.p[2].w;
  // Each front ignites at its origin and burns outward through the halls.
  // Kick: from its spot on the wall.
  f.k = min(vec2f(max(length(p - mv_kickO(K)) - 0.6, 0.0), max(length(p - mv_kickO(K - 1.0)) - 0.6, 0.0)) / 12.0, vec2f(0.45));
  // Snare: from the walls beside you, burning away down the hall, faster.
  f.s = min(max(p.z - z - 0.6, 0.0) / 11.0 + length(p.xy - mv_path(p.z)) * 0.06, 0.45);
  // Melody: a glow gathered round the wall ahead at the height the pitch set.
  let mo = vec3f(mv_path(z + 1.0) + vec2f(0.0, S.p[4].x * 0.8 * S.p[0].y), z + 1.0);
  f.m = 0.35 + 0.65 * exp(-max(length(p - mo) - 0.3, 0.0) / 6.0 * 2.5);
  return f;
}

var<private> mv_lvl: f32;
var<private> mv_edge: f32;
var<private> mv_cell: vec3f;
// Colour-front progress (latest and previous kick, latest and previous snare) at the point, how long
// ago the kick (xy) and snare (zw) fronts reached it, and the melody glow's weight there.
var<private> mv_kf: vec4f;
var<private> mv_kx: vec4f;
var<private> mv_mx: f32;

// Endless carved space. nLv: carve levels (fractional: the last one fades in). The hall and the side
// tunnels bore through; the two finer levels engrave panel seams where their cells meet. The event
// terms (offset, turn, side-tunnel width) glide in globally; the fronts here only time the colour.
fn mv_de(p: vec3f, nLv: f32) -> f32 {
  let s = S.p[0].x;
  let k = S.p[0].z;
  let axis = S.p[1].xyz;
  let room = S.p[5].x;
  let fr = mv_fronts(p);
  mv_kx = vec4f(S.p[2].yz - fr.k, S.p[3].yz - fr.s);
  mv_kf = vec4f(mv_fr(S.p[2].y, fr.k.x), mv_fr(S.p[2].z, fr.k.y), mv_fr(S.p[3].y, fr.s), mv_fr(S.p[3].z, fr.s));
  mv_mx = fr.m;
  // The event terms, each glided in on the CPU.
  let u = S.p[2].x;
  let ang = S.p[3].x;
  let mel = S.p[4].x;
  var q = p;
  var sc = 1.0;
  var d = -1e9;
  var lvl = 0.0;
  var edge = 1e9;
  var cell = vec3f(0.0);
  var nm = vec3f(0.0, 0.0, 1.0);
  for (var i = 0; i < 4; i++) {
    let fi = f32(i);
    if (fi >= nLv) { break; }
    let a = fmod3(q + 1.0, vec3f(2.0)) - 1.0;
    let h = 0.31 + 0.09 * mel;
    let kr = sat(k + 0.38 * mel);
    let bq = 1.0 - abs(a) + nm * 9.0;
    if (i == 2) { cell = floor((q + 1.0) * 0.5); }
    let fade = sat(nLv - fi);
    var dc: f32;
    if (i < 2) {
      let hw = select(h * fade, S.p[0].y, i == 0);
      let kk = select(kr, k, i == 0);
      dc = -mv_cut(a, hw, kk) / sc;
      if (dc > d) {
        let aq = abs(a);
        let m3 = vec3f(mv_n2(aq.yz, kk), mv_n2(aq.xz, kk), mv_n2(aq.xy, kk)) - hw;
        let lo = min(m3.x, min(m3.y, m3.z));
        let mid = m3.x + m3.y + m3.z - lo - max(m3.x, max(m3.y, m3.z));
        edge = min(mid, 1.0 - max(aq.x, max(aq.y, aq.z)) + 0.02) / sc;
        // The wall's normal axis: seams are engraved only across it.
        var n3 = vec3f(1.0, 0.0, 0.0);
        if (m3.x <= m3.y && m3.x <= m3.z) {
          n3 = select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), aq.y > aq.z);
        } else if (m3.y <= m3.z) {
          n3 = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), aq.x > aq.z);
        } else {
          n3 = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), aq.x > aq.y);
        }
        nm = n3;
      }
    } else {
      let seam = min(bq.x, min(bq.y, bq.z)) - (0.03 - 0.008 * (fi - 2.0)) * fade;
      dc = min(-seam / sc, d + (0.07 - 0.02 * (fi - 2.0)) / sc * fade);
    }
    if (dc > d) { lvl = fi; }
    // The side tunnels meet the hall with a small rounded fillet, so no razor-thin sliver survives.
    d = select(max(d, dc), smax(d, dc, 0.05 / sc), i == 1);
    let off = room * vec3f(sin(u * 2.1), sin(u * 1.7 + 2.0), sin(u * 1.3 + 4.0));
    q = rotAxis(axis, ang) * (a + off) * s;
    sc *= s;
  }
  mv_lvl = lvl;
  mv_edge = edge;
  mv_cell = cell;
  return d;
}

// Carve levels down to the pixel footprint at distance t: finer seams would only turn to dust.
fn mv_levels(t: f32, pix: f32) -> f32 {
  let feat = 2.0 * 0.31 / (6.0 * pix * max(t, 0.05));
  return clamp(1.0 + log(max(feat, 1.0)) / log(S.p[0].x), 1.0, 2.0);
}

fn mv_normal(p: vec3f, e: f32, n: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * mv_de(p + k.xyy * e, n) + k.yyx * mv_de(p + k.yyx * e, n) +
                   k.yxy * mv_de(p + k.yxy * e, n) + k.xxx * mv_de(p + k.xxx * e, n));
}

fn mv_ao(p: vec3f, n: vec3f, lv: f32) -> f32 {
  var o = 0.0;
  var w = 1.0;
  for (var i = 1; i <= 4; i++) {
    let hh = 0.01 + 0.06 * f32(i);
    o += (hh - mv_de(p + n * hh, lv)) * w;
    w *= 0.7;
  }
  return sat(1.0 - 3.0 * o);
}

// A palette hue at a luminance, pushed toward vivid, with limited gain so dark entries never blow up.
fn mv_col(t: f32, lum: f32) -> vec3f {
  let c = max(pal(t), vec3f(0.0));
  var n = c / max(max(c.r, max(c.g, c.b)), 1e-3);
  let g = luma(n);
  let ch = length(n - vec3f(g));
  n = max(vec3f(g) + (n - vec3f(g)) * clamp(0.6 / max(ch, 1e-3), 1.0, 3.0), vec3f(0.0));
  n /= max(max(n.r, max(n.g, n.b)), 1e-3);
  // A near-grey palette entry has no hue to boost: give it one from its place on the wheel.
  n = mix(hsv2rgb(vec3f(fract(t * 0.97 + 0.6), 0.75, 1.0)), n, smoothstep(0.03, 0.15, ch));
  return n * (lum / max(luma(n), 0.3));
}
fn mv_hrot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735);
  return max(c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a)), vec3f(0.0));
}
// A second hue clearly apart from the first: the first turned 150 degrees round the wheel, so
// every frame carries two distinct hues whatever the palette scheme.
fn mv_second(t: f32, lum: f32) -> vec3f {
  let c = mv_hrot(mv_col(t, 1.0), 2.6);
  return c * (lum / max(luma(c), 0.05));
}
// Fire: white-hot at 1, through yellow and orange, to a deep red near 0.
fn mv_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.32, 0.06) * h + vec3f(0.0, 0.45, 0.2) * h * h + vec3f(0.0, 0.12, 0.3) * h * h * h * h;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let z = S.p[1].w;
  let ro = vec3f(mv_path(z), z);
  let ta = vec3f(mv_path(z + 1.0), z + 1.0);
  let focal = 1.15;
  let cam = lookAt(ro, ta, S.p[5].y);
  let rd = normalize(cam * vec3f(q, focal));
  let fwd = normalize(ta - ro);
  let hue = S.p[0].w;
  let mat = i32(S.p[6].z + 0.5);
  let rig = i32(S.p[7].x + 0.5);
  let pix = 1.4 / (F.res.y * focal);
  let K = S.p[2].w;
  let SN = S.p[3].w;

  var t = 0.02 + ign(frag) * 0.02;
  var hit = false;
  let far = 18.0;
  var lv = 2.0;
  var dLast = 1.0;
  for (var i = 0; i < 150; i++) {
    lv = mv_levels(t, pix);
    let d = mv_de(ro + rd * t, lv);
    dLast = d;
    if (d < pix * t) { hit = true; break; }
    t += d * 0.75;
    if (t > far) { break; }
  }
  // Rays that ran out of steps grazing a surface count as hits, so silhouettes stay solid.
  if (!hit && t < far && dLast < pix * t * 3.0) { hit = true; }

  // Two hues on black: A down the hall (the focal light), B from the sides.
  let cA = mv_col(hue + 0.45, 1.0);
  let cB = mv_second(hue + 0.45, 1.0);
  let fogCol = cB * 0.006 + cA * 0.002;

  var col = fogCol;
  if (hit) {
    let pos = ro + rd * t;
    let eps = max(0.0003, pix * t);
    let n = mv_normal(pos, eps, lv);
    mv_de(pos, lv);
    let lvl = mv_lvl;
    let edgeW = mv_edge;
    let cell = mv_cell;
    // Colour state: two fronts back, plus the previous and latest fronts as they pass.
    let groove = step(1.5, lvl);
    let ao = mv_ao(pos, n, min(lv, 3.0));
    let ndv = sat(dot(n, -rd));
    let rf = reflect(rd, n);
    let fre = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);

    let sw = max(0.003, 1.2 * pix * t);
    let edge = smoothstep(sw * 2.5, 0.0, edgeW) * (1.0 - groove) * sat(1.3 - pix * t * 30.0) * select(0.6, 1.0, lvl < 0.5);
    let seamLine = groove * sat(1.5 - pix * t * 40.0);
    let ph = hash13(cell + 0.37);

    // Colour rides on the same fronts as the shape: behind the kick's the stone is re-anodised in
    // the next colour, behind the snare's the arrises are trimmed anew.
    let kPh = K - 2.0 + mv_kf.x + mv_kf.y;
    let sPh = SN - 2.0 + mv_kf.z + mv_kf.w;
    let anod0 = mv_col(hue + 0.13 + 0.21 * kPh + 0.2 * lvl + 0.06 * ph, 1.0);
    let trimC = mv_col(hue + 0.7 + 0.19 * sPh, 1.0);

    // Lights: the focal light far down the hall, a lamp ahead, or the sky through the holes.
    var L: vec3f;
    var att = 1.0;
    if (rig == 0) {
      let bp = vec3f(mv_path(z + 7.0), z + 7.0);
      let dl = bp - pos;
      L = normalize(dl);
      att = 5.0 / (1.0 + 0.5 * dot(dl, dl));
    } else if (rig == 1) {
      let hz = z + 2.2;
      let hp = vec3f(mv_path(hz) + vec2f(0.22, 0.18) * S.p[0].y, hz);
      let dl = hp - pos;
      L = normalize(dl);
      att = 1.6 / (0.1 + dot(dl, dl));
    } else {
      L = normalize(vec3f(0.35, 1.0, 0.45));
      att = 1.4;
    }
    let dif = sat(dot(n, L)) * att;
    let spe = pow(sat(dot(rf, L)), 60.0) * att;
    // Two softboxes either side of the hall, one per hue, so the walls split into two tones.
    let side = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)) + vec3f(0.0, 1e-4, 0.0));
    let lA = normalize(side * 0.8 + vec3f(0.0, 0.5, 0.0) + fwd * 0.5);
    let lB = normalize(-side * 0.8 - vec3f(0.0, 0.3, 0.0) + fwd * 0.5);
    let ax = dot(rf, fwd);
    var env = cA * (0.01 + 0.15 * pow(sat(ax), 16.0));
    env += cA * 0.22 * pow(sat(dot(rf, lA)), 8.0) + cB * 0.32 * pow(sat(dot(rf, lB)), 3.5);
    env += cB * 0.02 * sat(-ax);
    let soft = (cA * sat(dot(n, lA)) + cB * sat(dot(n, lB))) * ao;
    // Two-tone anodising: the side walls take the second hue, floors and ceilings their own.
    // The kick's front turns both tones a step round the wheel.
    let anod = mix(mix(anod0, cA, 0.7), mv_hrot(cB, 0.5 * sin(kPh * 1.7)), smoothstep(0.45, 0.75, abs(dot(n, side))));

    var c: vec3f;
    let face = 0.93 + 0.14 * ph;
    if (mat == 0) {
      // Black lacquer with an anodised sheen: deep body, coloured reflections.
      let f0 = anod * 0.08 * face;
      c = vec3f(0.012) * (dif + 0.2) * ao + (env * mix(vec3f(1.0), anod, 0.75) * (fre + 0.15) * 1.5 + f0 * env * 2.0) * ao;
      c += mix(vec3f(1.0), cA, 0.4) * spe * 0.35 * ao + soft * 0.015;
    } else if (mat == 1) {
      // Anodised chrome: the reflections take the panel's colour.
      let f0 = mix(vec3f(0.4), anod * 0.6, 0.6) * face * mix(1.0, 0.4, groove);
      let fr = f0 + (vec3f(1.0) - f0) * pow(1.0 - ndv, 5.0);
      c = fr * (env * 1.6 + mix(vec3f(1.0), cA, 0.4) * spe * 0.6) * ao + f0 * (dif * 0.03 * ao + soft * 0.02);
    } else {
      // Smoked glass: dark, glossy, its colour held in the body.
      let body = anod * 0.05 * (0.5 + dif) + soft * 0.02;
      c = body * ao + env * mix(vec3f(1.0), anod, 0.8) * (fre + 0.1) * 1.8 * ao + mix(vec3f(1.0), cA, 0.4) * spe * 0.4 * ao;
    }
    // What the kick's front has just re-formed burns hot along its seams and arrises, then cools;
    // the snare's re-formed edges flash white-blue.
    // Each glow sums the latest front and the previous one, still burning out; each fades out
    // before a newer front can push it out of its slot.
    // Front strengths (6 bits each), so each glow follows its own hit.
    let lv = S.p[6].x;
    let kL = vec2f(floor(lv / 262144.0), floor(lv / 4096.0) % 64.0) / 63.0;
    let sL = vec2f(floor(lv / 64.0) % 64.0, lv % 64.0) / 63.0;
    let kDecay = (1.0 - smoothstep(vec2f(0.4), vec2f(0.8), S.p[2].yz)) * kL;
    let kHeat2 = mv_pulse2(mv_kx.xy, 0.3, 2.5 + 2.0 * ph) * kDecay;
    let kHeat = kHeat2.x + kHeat2.y;
    c += mv_fire(min(kHeat, 1.0)) * kHeat * (0.03 + max(seamLine, edge)) * 6.0 * (0.4 + 0.6 * ao);
    // The leading edge: a soft bright band sweeping over the stone.
    let lead = dot(mv_pulse2(mv_kx.xy, 0.2, 7.0), kDecay);
    c += mv_fire(0.7) * lead * 0.8 * ao;
    let sHeat2 = mv_pulse2(mv_kx.zw, 0.35, 4.0) * (1.0 - smoothstep(vec2f(0.35), vec2f(0.7), S.p[3].yz)) * sL;
    let sHeat = sHeat2.x + sHeat2.y;
    c += mix(vec3f(0.8, 0.9, 1.0), trimC, 0.7) * sHeat * (edge * 4.5 + seamLine * 0.8 + 0.4 * fre + 0.15);
    // The side tunnels catch the note's colour (by pitch), swelling with each note.
    let mHeat = S.p[7].y * mv_mx * 1.7;
    c += mv_col(hue + 0.33 + 0.3 * S.p[4].x, 1.0) * mHeat * (0.09 + 0.5 * fre + 0.85 * edge + 0.45 * seamLine) * ao;
    col = c;
  }
  // Depth fog, with light scattered along the hall toward the focal light.
  let fog = 1.0 - exp(-t * S.p[7].z - max(t - 6.0, 0.0) * 0.12);
  // The focal glow down the hall is in the second hue, so the far end always answers the walls.
  let fc = fogCol + cB * 0.08 * pow(sat(dot(rd, fwd)), 8.0) * select(0.6, 1.0, rig == 0);
  col = mix(col, fc, fog);
  // Highlight roll-off below keeps the hue: nothing clips to a flat field.
  // Contrast and richer colour (the pale stone otherwise washes out), then exposure.
  col = pow(max(mix(vec3f(luma(col)), col, 1.3), vec3f(0.0)), vec3f(1.3)) * 0.9;
  let m = max(col.r, max(col.g, col.b));
  col *= 1.0 / (1.0 + m * 0.5);
  return vec4f(col, 1.0);
}
`,
});
