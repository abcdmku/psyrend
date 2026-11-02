import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';

const fract = (x: number) => x - Math.floor(x);
const hash = (x: number) => fract(Math.sin(x * 127.1 + 311.7) * 43758.5453);

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
  /** Strength (the event's morph level) of the latest and previous fronts. */
  private lCur = 0;
  private lPrev = 0;
  fronts = 0;
  /** Summed strengths of every front before the previous one (the colour state they left). */
  settled = 0;
  constructor(
    private readonly gap: number,
    private readonly w: number,
  ) {}
  /** `next` gives the new target; the term moves toward it in proportion to the event's `level`. */
  update(count: number, now: number, age: number, level: number, reset: boolean, next: (cur: number) => number): void {
    const dt = Math.min(Math.max(now - this.last, 0), 0.1);
    this.last = now;
    if (reset || count < this.n || this.n < 0) {
      this.target = this.x = this.n < 0 ? next(Number.NaN) : this.target;
      this.vel = 0;
      this.tCur = this.tPrev = -99;
      this.lCur = this.lPrev = 0;
      if (this.n < 0 || count < this.n) this.settled = 0;
    } else if (count > this.n) {
      this.target += (next(this.target) - this.target) * level;
      if (now - age - this.tCur >= this.gap) {
        this.tPrev = this.tCur;
        this.settled += this.lPrev;
        this.lPrev = this.lCur;
        this.tCur = now - age;
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
  /** The two fronts' strengths packed in one float (latest in the integer part, x100). */
  levels(): number {
    return Math.floor(Math.min(this.lCur, 1) * 100) + Math.min(this.lPrev, 1) * 0.99;
  }
}

/**
 * Critically damped springs that follow the morph's travel and flow coordinates, so every change of
 * pace (the bass drive rises within ~80 ms) eases in from rest over about a quarter second.
 */
class Glide {
  readonly x: Float64Array;
  private readonly v: Float64Array;
  constructor(n: number) {
    this.x = new Float64Array(n);
    this.v = new Float64Array(n);
  }
  follow(target: ArrayLike<number>, w: number, dt: number, reset: boolean): void {
    const e = Math.exp(-w * dt);
    for (let i = 0; i < this.x.length; i++) {
      if (reset) {
        this.x[i] = target[i];
        this.v[i] = 0;
        continue;
      }
      const d = this.x[i] - target[i];
      const c = this.v[i] + w * d;
      this.v[i] = (this.v[i] - w * c * dt) * e;
      this.x[i] = target[i] + (d + c * dt) * e;
    }
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

const morph = new Morph(1.0);
const noteSwell = new Swell();
const glide = new Glide(9);
const glideIn = new Float64Array(9);
const kickT = new Term(0.4, 11);
const snareT = new Term(0.35, 7);
const noteT = new Term(0.3, 7);
const st = { t: -1, seed: -1, rush: 0 };

/**
 * Apollonian foam: inversion-fold fractals (the classic lattice fold + sphere inversion packing, a
 * bubble-shell variant, and a pseudo-Kleinian box-fold limit set) carved open so the camera can
 * fly through them: a wide winding tunnel bored through the foam, or a sphere cut out and drifted
 * through like a geode. The picture is the fractal alone, shaded as pearl, chrome, candy paint or
 * smoked glass; the music acts only on its equation.
 *
 * The equation flows all the time: the fold box on each axis drifts at a steady pace (the melody
 * bends its heading), easing down only in long quiet, so the packing keeps rebuilding itself. Each
 * event permanently changes one term, eased in everywhere at once, while a colour front burns through the
 * foam, reaching each fold iteration a little later than the one before and later still where the
 * orbit trap is open, so the big spheres re-form first and the small ones follow:
 * - Kick: the fold box (the packing changes proportions), from a spot on the cavity wall ahead; the
 *   foam re-anodises in the next colour behind it and glows hot as it re-forms.
 * - Snare: the inversion strength (the spheres swell or shrink against each other), sweeping away
 *   from you, flashing white-blue as it re-forms.
 * - Melody: the fractional iteration count, set by the note's pitch (high notes grow a finer
 *   generation of spheres, low notes melt it back), its sheen catching the note's colour.
 */
export default raymarchScene({
  meta: {
    id: 'apollonian-spheres',
    name: 'Apollonian Foam',
    // Out of the show until fixed (gate: one hue, melody does not register, snaps).
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.5, arousal: 0.6 },
    genres: { edm: 0.85, techno: 0.85, ambient: 0.7, dnb: 0.8, dubstep: 0.5, synthwave: 0.5, classical: 0.4, pop: 0.4 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    morph.update(m, ctx.dt, g);
    const now = m.time;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const reset = g[0] !== st.seed || Math.abs(now - st.t - dt) > 0.5;
    st.seed = g[0];
    st.t = now;
    glideIn.set(morph.flowAt);
    glideIn[8] = morph.travel;
    glide.follow(glideIn, 8, dt, reset);
    const tr = glide.x[8];
    // The continuous flow (the melody bends its heading, chords lean it), without the beat steps:
    // those are swept through the foam below.
    const flowAt = (i: number) => glide.x[i % 8];

    const fam = Math.floor(g[0] * 3);
    const rig = Math.floor(g[1] * 2);
    const mat = Math.floor(g[2] * 4);
    const WS = [0.85, 1.25, 1.75][Math.floor(g[4] * 3)];
    // The Kleinian limit set gets fewer iterations: deeper ones only add sub-pixel lace.
    const it = fam === 2 ? 5 : [6, 6, 7][Math.floor(fract(g[3] * 5.7) * 3)];
    const lm = Math.floor(g[5] * 3);
    const period = fam === 2 ? 4 * 0.92436 * WS : 2 * WS;
    const pathP = period * 2;
    // A drop throws the camera forward: extra travel while the surge lasts.
    st.rush = reset ? 0 : st.rush + dt * morph.surge * morph.surge * 1.6;
    const z = ((tr * 0.35 + st.rush * 0.5) * WS) % (pathP * 64);

    // Continuous fold box.
    // Family and material packed together; S.p[0].z: the abs-fold blend toward the Kali family,
    // wide per phrase.
    p[0] = fam + 4 * mat; p[1] = rig; p[3] = WS;
    p[2] = Math.max(0, wave(flowAt(5) * 1.2 + 0.5, -0.6, 1.0));
    p[5] = it + 0.1 * lm;
    p[7] = wave(flowAt(0), 0.78, 1.3);
    p[17] = wave(flowAt(1), 0.8, 1.26);
    p[19] = wave(flowAt(2), 0.76, 1.38);

    // Camera per rig: a tunnel through the foam, or a drift inside a carved geode.
    const sp = tr * 4;
    let eye: number[];
    let tgt: number[];
    let carve: number;
    const path = (zz: number) => [
      0.35 * WS * Math.sin((zz / pathP) * 2 * Math.PI) + 0.5 * WS,
      0.25 * WS * Math.cos((zz / pathP) * 4 * Math.PI) + 0.5 * WS,
    ];
    if (rig === 0) {
      const c0 = path(z);
      const c1 = path(z + 0.8 * WS);
      eye = [c0[0], c0[1], z];
      tgt = [c1[0], c1[1], z + 0.8 * WS];
      carve = (0.68 + 0.1 * fract(g[4] * 4.3)) * WS;
    } else {
      const R = (1.45 + 0.3 * fract(g[4] * 4.3)) * WS;
      const az = tr * 0.2 + st.rush * 0.35 + g[1] * 7;
      const o = 0.28 * R;
      eye = [WS + Math.cos(az) * o, WS + 0.3 * R * Math.sin(sp * 0.03), WS + Math.sin(az) * o];
      const la = az + 2.2 + 0.5 * Math.sin(sp * 0.02);
      tgt = [eye[0] + Math.cos(la), eye[1] + 0.4 * Math.sin(sp * 0.035 + 2), eye[2] + Math.sin(la)];
      carve = R;
    }
    p[8] = eye[0]; p[9] = eye[1]; p[10] = eye[2]; p[11] = carve;
    p[12] = tgt[0]; p[13] = tgt[1]; p[14] = tgt[2];
    p[16] = Math.sin(sp * 0.02) * (rig === 0 ? 0.4 : 0.1);
    p[18] = fract(g[6] + 0.1 * ev[1]);
    // Melody glow: swells with each note (notes come too densely for one front per note), as
    // strongly as the note is played.
    p[15] = noteSwell.update(morph.notes, dt, reset, 0.5, morph.noteLevel);

    // Kick: fold-box phase.
    kickT.update(morph.kicks, now, morph.kickAge, morph.kickLevel, reset, (u) => (Number.isNaN(u) ? 0 : u) + 1.2 + 1.8 * hash(morph.kicks + g[0] * 7));
    kickT.write(p, 20, flowAt(3) * 0.2);
    // The kick and snare fronts' strengths (S.p[1].x, S.p[1].z): their glows scale with them.
    p[4] = kickT.levels();
    // Snare: inversion strength, stepping alternately up and down.
    const sLo = fam === 2 ? 0.96 : 1.08;
    const sHi = fam === 2 ? 1.06 : 1.36;
    snareT.update(morph.snares, now, morph.snareAge, morph.snareLevel, reset, (s) => {
      if (Number.isNaN(s)) return (sLo + sHi) / 2;
      const dir = morph.snares % 2 ? 1 : -1;
      return Math.max(sLo, Math.min(sHi, s + dir * (sHi - sLo) * (0.22 + 0.12 * hash(morph.snares + 3.1))));
    });
    snareT.write(p, 24, 0.3 * (sHi - sLo) * Math.sin(flowAt(4)));
    p[6] = snareT.levels();
    // Melody: fractional iteration count from the note's pitch.
    noteT.update(morph.notes, now, morph.leadAge, morph.noteLevel, reset, () => Math.max(0, Math.min(1, 0.5 + 0.7 * morph.notePitch + 0.25 * Math.sin(morph.notes * 2.7))));
    noteT.write(p, 28, 0);
    // The colour state the earlier kicks left (S.p[7].y; the note term's ages are unused).
    p[29] = kickT.settled;
  },
  wgsl: /* wgsl */ `
var<private> ap_orb: vec4f;
var<private> ap_gen: f32;
// Colour-front progress at the point (latest and previous kick), and how long ago each front of
// the latest (x) and previous (y) kick, snare and note reached it.
var<private> ap_kf: vec2f;
var<private> ap_kx: vec2f;
var<private> ap_sx: vec2f;
var<private> ap_mx: vec2f;

fn ap_fam() -> f32 { return fmod(S.p[0].x, 4.0); }
fn ap_box() -> vec3f { return vec3f(S.p[1].w, S.p[4].y, S.p[4].w); }

fn ap_path(z: f32) -> vec2f {
  let WS = S.p[0].w;
  let P = select(2.0 * WS, 4.0 * 0.92436 * WS, ap_fam() > 1.5) * 2.0;
  return vec2f(0.35 * WS * sin(z / P * TAU) + 0.5 * WS, 0.25 * WS * cos(z / P * 2.0 * TAU) + 0.5 * WS);
}

// A front: 0 before the new value arrives, 1 after; T is the arrival time. The shape terms glide
// in everywhere at once (springs on the CPU); at each point a colour front takes over across a
// third of a second. The previous event's front keeps burning out while a new one starts, so a new
// beat never cuts a front off.
fn ap_fr(age: f32, T: f32) -> f32 { return smoothstep(0.0, 1.0, (age - T) / 0.35); }
// A glow that swells in from nothing over r seconds, then cools at rate k: never a flash.
fn ap_pulse2(x: vec2f, r: f32, k: f32) -> vec2f { return smoothstep(vec2f(0.0), vec2f(r), x) * exp(-max(x - r, vec2f(0.0)) * k); }
// The latest and previous fronts' strengths, unpacked from Term.levels().
fn ap_lv(v: f32) -> vec2f { return vec2f(floor(v) / 100.0, fract(v) / 0.99); }

// Where a kick's front starts: a spot on the carved wall ahead, a new one for every kick.
fn ap_kickO(k: f32) -> vec3f {
  let WS = S.p[0].w;
  let h = hashU3(u32(max(k, 0.0)) * 2654435761u);
  let ro = S.p[2].xyz;
  if (S.p[0].y < 0.5) {
    let z = ro.z + (0.8 + 0.8 * h.x) * WS;
    return vec3f(ap_path(z) + vec2f(cos(h.y * TAU), sin(h.y * TAU)) * S.p[2].w, z);
  }
  let fwd = normalize(S.p[3].xyz - ro);
  return vec3f(WS) + normalize(fwd + (h - 0.5) * 1.2) * S.p[2].w;
}

// The foam. The event terms (box phase, inversion strength, fractional iteration count) are
// eased in globally; the fronts here only time the colour. ap_orb: orbit trap; ap_gen: the fold
// iteration whose sphere the point sits nearest.
fn ap_frac(p0: vec3f) -> f32 {
  let fam = ap_fam();
  let WS = S.p[0].w;
  let it = i32(S.p[1].y);
  let ro = S.p[2].xyz;
  let K = S.p[5].w;
  let kA2 = S.p[5].y;
  let sA2 = S.p[6].y;
  // Arrival times: each front ignites at its origin and burns outward through the foam.
  let tk2 = max(length(p0 - ap_kickO(K)) - 0.6 * WS, 0.0) / (16.0 * WS);
  let tk1 = max(length(p0 - ap_kickO(K - 1.0)) - 0.6 * WS, 0.0) / (16.0 * WS);
  let ts = max(dot(p0 - ro, normalize(S.p[3].xyz - ro)) - 0.6 * WS, 0.0) / (12.0 * WS);
  let mo = ro + normalize(S.p[3].xyz - ro) * WS;
  let tm = max(length(p0 - mo) - 0.5 * WS, 0.0) / (7.0 * WS);
  ap_kx = vec2f(kA2 - tk2, S.p[5].z - tk1);
  ap_kf = vec2f(ap_fr(kA2, tk2), ap_fr(S.p[5].z, tk1));
  ap_sx = S.p[6].yz - ts;
  // The melody's glow gathers round a point just ahead and thins out away from it.
  ap_mx = vec2f(0.35 + 0.65 * exp(-tm * 2.5), 0.0);
  // The event terms, each glided in on the CPU.
  let u = S.p[5].x;
  let s = S.p[6].x;
  let frac = S.p[7].x;
  var p = p0 / WS;
  var scale = 1.0;
  var orb = vec4f(1e3);
  var gen = 0.0;
  var dPrev = 0.0;
  var d = 0.0;
  if (fam < 1.5) {
    for (var i = 0; i < 10; i++) {
      if (i > it) { break; }
      let bx = (ap_box() + 0.17 * vec3f(sin(u * 1.3), sin(u * 1.7 + 2.0), sin(u * 0.9 + 4.0))) * select(vec3f(1.0), vec3f(1.0, 1.13, 0.91), fam > 0.5);
      p = -bx + 2.0 * bx * fract(0.5 * p / bx + 0.5);
      // Family blend: an abs fold with an offset (Kali / KIFS) mixed into the lattice fold.
      p = mix(p, abs(p) - bx * 0.4, S.p[0].z);
      let r2 = dot(p, p);
      if (r2 < orb.w) { gen = f32(i); }
      orb = min(orb, vec4f(abs(p), r2));
      let k = s / r2;
      p *= k;
      scale *= k;
      dPrev = d;
      d = 0.25 * abs(p.y) / scale * WS;
    }
    ap_orb = orb;
    ap_gen = gen;
    // The last iteration counts only as far as the melody's fractional count says.
    return mix(dPrev, d, frac);
  }
  // Pseudo-Kleinian limit set (box fold + clamped inversion), wrapped by its mirror period.
  let C = vec3f(0.92436, 0.90756, 0.92436) * mix(vec3f(1.0), ap_box(), 0.3);
  p = fmod3(p + 2.0 * C, 4.0 * C) - 2.0 * C;
  for (var i = 0; i < 10; i++) {
    if (i > it) { break; }
    let Ci = C * (1.0 + 0.05 * vec3f(sin(u * 1.3), sin(u * 1.7 + 2.0), sin(u * 0.9 + 4.0)));
    p = 2.0 * clamp(p, -Ci, Ci) - p;
    p = mix(p, abs(p) - Ci * 0.3, S.p[0].z * 0.3);
    let r2 = dot(p, p);
    if (r2 < orb.w) { gen = f32(i); }
    orb = min(orb, vec4f(abs(p), r2));
    let k = max(s / r2, 1.0);
    p *= k;
    scale *= k;
    let rxy = length(p.xy);
    dPrev = d;
    d = max(rxy - 0.92784, abs(rxy * p.z) / max(length(p), 1e-4)) / scale * WS * 0.9;
  }
  ap_orb = orb;
  ap_gen = gen;
  return mix(dPrev, d, frac);
}

fn ap_map(p: vec3f) -> f32 {
  let d = ap_frac(p);
  let rig = S.p[0].y;
  let c = S.p[2].w;
  // Carves are rounded into the foam so no flat slice shows.
  let k = 0.2 * S.p[0].w;
  if (rig < 0.5) { return smax(d, c - length(p.xy - ap_path(p.z)), k); }
  return smax(d, c - length(p - vec3f(S.p[0].w)), k);
}

fn ap_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * ap_map(p + k.xyy * e) + k.yyx * ap_map(p + k.yyx * e) +
                   k.yxy * ap_map(p + k.yxy * e) + k.xxx * ap_map(p + k.xxx * e));
}

fn ap_film(c: f32, th: f32) -> vec3f {
  let ph = th * (2.2 - 1.3 * c);
  return 0.5 + 0.5 * cos(TAU * (ph * vec3f(1.0, 1.17, 1.36) + vec3f(0.0, 0.22, 0.47)));
}

// A palette hue at a luminance, pushed toward vivid, with limited gain so dark entries never blow up.
fn ap_col(t: f32, lum: f32) -> vec3f {
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
fn ap_hrot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735);
  return max(c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a)), vec3f(0.0));
}
// A second hue clearly apart from the first: the first turned 150 degrees round the wheel, so
// every frame carries two distinct hues whatever the palette scheme.
fn ap_second(t: f32, lum: f32) -> vec3f {
  let c = ap_hrot(ap_col(t, 1.0), 2.6);
  return c * (lum / max(luma(c), 0.05));
}
// Fire: white-hot at 1, through yellow and orange, to a deep red near 0.
fn ap_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.32, 0.06) * h + vec3f(0.0, 0.45, 0.2) * h * h + vec3f(0.0, 0.12, 0.3) * h * h * h * h;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[2].xyz;
  let focal = select(1.3, 1.0, S.p[0].y > 0.5);
  let cam = lookAt(ro, S.p[3].xyz, S.p[4].x);
  let rd = normalize(cam * vec3f(q, focal));
  let fwd = normalize(S.p[3].xyz - ro);
  let WS = S.p[0].w;
  let mat = floor(S.p[0].x / 4.0);
  let hue = S.p[4].z;
  let K = S.p[5].w;
  let kAge = S.p[5].y;
  let SN = S.p[6].w;
  let lAge = S.p[3].w;
  // Two hues on black, one per softbox.
  let cA = ap_col(hue + 0.1, 1.0);
  let cB = ap_second(hue + 0.1, 1.0);
  let fogCol = cB * 0.004 + cA * 0.002;

  let tMax = 7.0 * WS;
  // Stop at the pixel footprint: finer foam would only alias into dust.
  let pix = 1.4 / (F.res.y * focal);
  var t = ign(frag) * 0.01 * WS;
  var hit = false;
  var hl = 1.0;
  for (var i = 0; i < 110; i++) {
    let p = ro + rd * t;
    let h = ap_map(p);
    hl = h;
    if (h < pix * t * select(1.0, 1.6, ap_fam() > 1.5)) { hit = true; break; }
    t += h * select(0.7, 0.55, ap_fam() > 1.5);
    if (t > tMax) { break; }
  }
  // Rays that ran out of steps grazing a sphere count as hits, so silhouettes stay clean.
  if (!hit && t < tMax && hl < pix * t * 4.0) { hit = true; }

  var col = fogCol;
  if (hit) {
    let p = ro + rd * t;
    let n = ap_normal(p, max(pix * t * 2.5, 0.0002 * WS));
    ap_map(p);
    let orb = ap_orb;
    let gen = ap_gen;
    // Colour state: two kicks back, plus the previous and latest kick fronts as they pass.
    // Each kick steps the colour as far as it was played.
    let kLv = ap_lv(S.p[1].x);
    let kState = S.p[7].y + kLv.y * ap_kf.y + kLv.x * ap_kf.x;
    let c = sat(dot(n, -rd));
    let r = reflect(rd, n);
    // Occlusion from the foam itself (cheap two-tap).
    let a1 = ap_map(p + n * 0.04 * WS);
    let a2 = ap_map(p + n * 0.12 * WS);
    let ao = sat(0.3 + 0.7 * (a1 / (0.04 * WS)) * 0.5 + 0.35 * (a2 / (0.12 * WS)));
    let fre = 0.04 + 0.96 * pow(1.0 - c, 5.0);

    // Key light: headlight, overhead or under-glow.
    let lm = round(fract(S.p[1].y) * 10.0);
    var L = normalize(ro + vec3f(0.0, 0.15 * WS, 0.0) - p);
    var att = 1.0 / (1.0 + dot(ro - p, ro - p) / (WS * WS) * 1.2);
    if (lm > 0.5 && lm < 1.5) { L = normalize(vec3f(0.4, 1.0, 0.2)); att = 1.0; }
    if (lm > 1.5) { L = normalize(vec3f(-0.3, -1.0, 0.4)); att = 0.9; }
    let dif = sat(dot(n, L)) * att;
    let spe = pow(sat(dot(r, L)), 40.0) * att;
    // Two softboxes either side, one per hue, over a broad two-hue gradient.
    let side = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)) + vec3f(0.0, 1e-4, 0.0));
    let lA = normalize(side * 0.75 + vec3f(0.0, 0.55, 0.0) - fwd * 0.35);
    let lB = normalize(-side * 0.75 - vec3f(0.0, 0.25, 0.0) - fwd * 0.2);
    var env = cA * 0.12 * pow(0.5 + 0.5 * dot(r, lA), 2.0) + cB * 0.14 * pow(0.5 + 0.5 * dot(r, lB), 2.0);
    env += cA * 0.5 * pow(sat(dot(r, lA)), 8.0) + cB * 0.55 * pow(sat(dot(r, lB)), 8.0);
    let soft = (cA * sat(dot(n, lA)) + cB * sat(dot(n, lB))) * ao;

    // Colour rides on the kick's front: behind it the foam re-anodises in the next colour, each
    // sphere generation its own shade, so neighbouring spheres differ.
    let tv = sqrt(orb.w);
    let anod0 = ap_col(hue + 0.12 * kState + 0.3 * tv + 0.21 * gen, 1.0);
    // Two-tone: surfaces facing sideways take the second hue.
    let anod = mix(anod0, ap_hrot(cB, 0.4 * sin(kState * 1.7)), 0.7 * smoothstep(0.4, 0.75, abs(dot(n, side))));
    let seam = exp(-orb.w * 18.0);

    if (mat < 0.5) {
      // Pearl: a coloured body with a thin-film sheen under a clear coat.
      let film = ap_film(c, 1.0 + orb.w * 2.0) * anod;
      col = mix(vec3f(0.35), anod, 0.6) * (soft * 0.2 + dif * ao * 0.06) + film * pow(1.0 - c, 2.0) * 0.06 * ao;
      col += env * (fre + 0.06) * 2.2 * ao + mix(vec3f(1.0), cA, 0.4) * spe * 0.25 * ao;
    } else if (mat < 1.5) {
      // Anodised chrome.
      let f0 = mix(vec3f(0.6), anod * 0.6, 0.8);
      let fr = f0 + (vec3f(1.0) - f0) * pow(1.0 - c, 5.0);
      col = fr * (env * 3.0 + mix(vec3f(1.0), cA, 0.4) * spe * 0.5) * ao + f0 * soft * 0.06;
    } else if (mat < 2.5) {
      // Candy paint: deep coloured body lit two-tone, glossy clear coat.
      col = mix(vec3f(0.4), anod, 0.6) * (soft * 0.15 + dif * ao * ao * 0.07);
      col += env * (fre + 0.05) * 2.0 * ao + mix(vec3f(1.0), cA, 0.4) * spe * 0.2 * ao;
    } else {
      // Smoked glass: dark, glossy, light gathering at the silhouettes and the tangency seams.
      col = anod * (0.03 + 0.2 * pow(1.0 - c, 1.5) * exp(-t / WS * 0.4) + 0.06 * seam) * (0.4 + 0.6 * ao) + soft * 0.13;
      col += env * (fre + 0.12) * 3.0 * ao + mix(vec3f(1.0), cA, 0.4) * spe * 0.3 * ao;
    }
    // What the kick's front has just re-formed glows hot in the crevices, then cools; the snare's
    // flashes white-blue in its sheen; the melody's catches the note's colour.
    let crev = sat((0.75 - ao) * 3.0);
    // Burning: a hot leading edge where the front has just arrived, embers cooling behind it.
    // Each glow sums the latest event's front and the previous one's, still burning out.
    // Each front fades out by 0.8 s, before a newer one can push it out of its slot.
    let kDecay = (1.0 - smoothstep(vec2f(0.4), vec2f(0.8), S.p[5].yz)) * ap_lv(S.p[1].x);
    let kHeat2 = ap_pulse2(ap_kx, 0.3, 3.0) * kDecay;
    let kHeat = kHeat2.x + kHeat2.y;
    // The leading edge is a soft bright band sweeping over the spheres; the embers smoulder in the
    // crevices where they meet.
    let lead = dot(ap_pulse2(ap_kx, 0.2, 7.0), kDecay);
    col += ap_fire(0.7) * lead * 0.5 * ao + ap_fire(min(kHeat, 1.0) * 0.8) * kHeat * crev * 3.0;
    let sHeat = ap_pulse2(ap_sx, 0.35, 4.0) * (1.0 - smoothstep(vec2f(0.35), vec2f(0.7), S.p[6].yz)) * ap_lv(S.p[1].z);
    let sTint = mix(vec3f(0.8, 0.9, 1.0), ap_col(hue + 0.6 + 0.19 * SN, 1.0), 0.7) * sHeat.x + mix(vec3f(0.8, 0.9, 1.0), ap_col(hue + 0.6 + 0.19 * (SN - 1.0), 1.0), 0.7) * sHeat.y;
    col += sTint * (0.2 + 1.0 * fre + 0.5 * crev) * ao;
    let mHeat = S.p[3].w * ap_mx.x * 2.4;
    col += ap_col(hue + 0.33 + 0.5 * S.p[7].x, 1.0) * mHeat * (0.6 + 1.3 * fre + 0.8 * crev) * ao;
    col = mix(fogCol, col, exp(-t / WS * 0.35));
    // Clearance: anything within reach of the lens dissolves into the dark.
    col *= smoothstep(0.25 * WS, 0.6 * WS, t);
  }
  // Richer colour (pearl and chrome highlights otherwise wash toward white), exposure, then a
  // highlight roll-off that keeps the hue.
  col = max(mix(vec3f(luma(col)), col, 1.45), vec3f(0.0)) * 1.7;
  let m = max(col.r, max(col.g, col.b));
  col *= 1.0 / (1.0 + m * 0.5);
  return vec4f(col, 1.0);
}
`,
});
