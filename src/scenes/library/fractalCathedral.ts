import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';

const pick = (g: number, n: number) => Math.min(n - 1, Math.floor(g * n));

const morph = new Morph(1.4);

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

const kickT = new Term(0.4, 8);
const snareT = new Term(0.35, 8);
const noteT = new Term(0.3, 7);
const noteSwell = new Swell();
const st = { t: -1, seed: -1, drive: 0, rush: 0 };
const hash = (x: number) => {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * An Apollonian cathedral you fly through: sphere-inversion foam with a carved, winding nave. The
 * picture is the fractal alone; the music acts only on its equation.
 *
 * The equation flows all the time: the fold box on each axis (round chapels, long vaults, flattened
 * galleries), the inversion floor and the foam scale drift at a steady pace (the melody bends their
 * heading), easing down only in long quiet. Each event permanently changes one term (by its strength:
 * the morph level; the melody by its square, so a faint motif glows rather than re-scales), and the new
 * value eases in everywhere at once over about a third of a beat, while a colour and light front burns
 * later than the one before and is held back where the orbit trap is open, so the big vaults
 * re-form first and the fine foam follows, raggedly:
 * - Kick: the inversion strength (the spheres swell or shrink against each other), from a point in
 *   the nave just ahead; the foam re-anodises in the next colour behind it and burns hot where
 *   it is re-forming.
 * - Snare: the fold box (the chapels change proportions), sweeping away from you down the nave,
 *   flashing white-blue where it re-forms.
 * - Melody: the foam's scale, set by the note's pitch (high notes fine foam, low notes broad vaults),
 *   spreading from the nave ahead.
 *
 * DNA: 0-1 starting point and path, 1 camera rig, 2 material (candy / chrome / glass),
 * 3 lighting (key / headlamp / backlight), 6 colour, 7 atmosphere.
 */
export default raymarchScene({
  meta: {
    id: 'fractal-cathedral',
    name: 'Fractal Cathedral',
    // Out of the show until fixed (gate: one hue, no darks, kicks do not register).
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.5, arousal: 0.7 },
    genres: { techno: 1, edm: 0.9, dnb: 0.8, ambient: 0.6, dubstep: 0.6, rock: 0.5, synthwave: 0.5, classical: 0.4 },
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
    // those are swept through the foam below.
    const flowAt = (i: number) => morph.flowAt[i % 8];
    const rig = pick(g[1], 3);

    // S.p[0]: rig, material, light, kick count.
    p[0] = rig;
    // Material and light rig packed together.
    p[1] = pick(g[2], 3) + 10 * pick(g[3], 3);
    // Front strengths, 6 bits each: kick latest, kick previous, snare latest, snare previous.
    const q6 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 63);
    p[2] = q6(kickT.lCur) * 262144 + q6(kickT.lPrev) * 4096 + q6(snareT.lCur) * 64 + q6(snareT.lPrev);
    p[3] = morph.kicks;
    // S.p[1]: fold box per axis (continuous part), inversion floor.
    p[4] = wave(flowAt(0), 0.78, 1.3);
    p[5] = wave(flowAt(1), 0.8, 1.26);
    p[6] = wave(flowAt(2), 0.76, 1.4);
    p[7] = Math.max(1e-4, wave(flowAt(3), -0.06, 0.07));
    // S.p[2]: kick term (inversion strength), stepping alternately up and down: v0, v1, v2, older front's age.
    // Every step is scaled by its hit's strength (morph levels, which carry the passage's presence).
    kickT.update(morph.kicks, now, morph.kickAge, morph.kickLevel, reset, (s) => {
      if (s === 0) return 1.16;
      const dir = morph.kicks % 2 ? 1 : -1;
      return Math.max(1.05, Math.min(1.28, s + dir * (0.05 + 0.04 * hash(morph.kicks + g[0] * 7)) * morph.kickLevel));
    });
    kickT.write(p, 8, 0.03 * Math.sin(flowAt(4)));
    // S.p[3]: camera z, roll, focal length, snare count.
    // A drop throws the camera forward: extra travel while the surge lasts.
    st.rush = reset ? 0 : st.rush + dt * morph.surge * morph.surge * 1.6;
    p[12] = tr * (rig === 1 ? 0.5 : 0.65) + st.rush;
    p[13] = Math.sin(tr * 0.4) * (rig === 0 ? 0.25 : 0.1);
    // The inversion floor lifts when the bass drives, swelling the small spheres.
    st.drive += (morph.drive - st.drive) * (reset ? 1 : 1 - Math.exp(-dt / 0.6));
    p[14] = 0.05 * st.drive;
    p[15] = morph.snares;
    // S.p[4]: colour shift, melody age, snare age, fog density.
    p[16] = g[6] + ctx.evolve[3] * 0.25;
    // Melody glow: swells with each note (notes come too densely for one front per note).
    p[17] = noteSwell.update(morph.notes, dt, reset, 0.5, morph.noteLevel);
    p[18] = Math.min(morph.snareAge, 99);
    // Distance blend: the foam's plane trap -> rounded sphere shells.
    p[19] = Math.max(0, wave(flowAt(6) * 1.1 + 4.0, -0.4, 0.4));
    // S.p[5]: snare term (fold-box phase).
    snareT.update(morph.snares, now, morph.snareAge, morph.snareLevel, reset, (u) => u + (1.2 + 1.8 * hash(morph.snares + 3.1)) * morph.snareLevel);
    snareT.write(p, 20, flowAt(5) * 0.2);
    // S.p[6]: melody term (relative foam scale, from the note's pitch).
    // The foam scale re-lays the whole cathedral, so a note moves it by its strength squared: a faint
    // note's change is the glow round the nave ahead, a strong one in a full mix re-scales the foam.
    noteT.update(morph.notes, now, morph.leadAge, morph.noteLevel, reset, (cur) => {
      const to = 1 - 0.12 * Math.max(-1, Math.min(1, morph.notePitch * 1.4 + 0.4 * Math.sin(morph.notes * 2.7)));
      return cur === 0 ? to : cur + (to - cur) * morph.noteLevel * morph.noteLevel;
    });
    noteT.write(p, 24, 0);
    // S.p[7]: nave radius, path amplitude (its sign is the side the camera looks to), foam scale, kick age.
    p[28] = 0.55 + 0.08 * g[7];
    p[29] = (0.6 + 0.8 * ((g[1] * 5.7) % 1)) * ((g[1] * 13) % 1 > 0.5 ? 1 : -1);
    p[30] = wave(flowAt(3) * 0.7 + 1.0, 0.85, 1.35);
    p[31] = Math.min(morph.kickAge, 99);
  },
  wgsl: /* wgsl */ `
fn fc_path(z: f32) -> vec2f { return vec2f(sin(z * 0.23) * 0.35, cos(z * 0.17) * 0.22) * abs(S.p[7].y); }

// A front: 0 before the new value arrives, 1 after; T is the arrival time, the take-over is eased.
// The shape terms glide in everywhere at once (springs on the CPU); at each point a colour front
// takes over across a third of a second. The previous front keeps burning out while a new one
// starts, so a new beat never cuts a front off.
fn fc_fr(age: f32, T: f32) -> f32 { return smoothstep(0.0, 1.0, (age - T) / 0.35); }
// A glow that swells in from nothing over r seconds, then cools at rate k: never a flash.
fn fc_pulse2(x: vec2f, r: f32, k: f32) -> vec2f { return smoothstep(vec2f(0.0), vec2f(r), x) * exp(-max(x - r, vec2f(0.0)) * k); }

// Where a kick's front starts: a point in the nave just ahead, a new one for every kick.
fn fc_kickO(k: f32) -> vec3f {
  let h = hashU3(u32(max(k, 0.0)) * 2654435761u);
  let z = S.p[3].x + 0.9 + 0.8 * h.x;
  return vec3f(fc_path(z) + vec2f(cos(h.y * TAU), sin(h.y * TAU)) * S.p[7].x * 0.5, z);
}

var<private> fc_gen: f32;
// Colour-front progress at the point (latest and previous kick front), how long ago the latest (x)
// and previous (y) kick and snare fronts reached it, and the melody glow's weight here.
var<private> fc_kf: vec2f;
var<private> fc_kx: vec2f;
var<private> fc_sx: vec2f;
var<private> fc_mx: f32;

// Apollonian sphere-inversion foam, folded into a box. The event terms (inversion strength, box
// phase, foam scale) ease in globally; the fronts here only time the colour, burning later at
// deeper iterations and where the orbit trap is open, so the light follows the foam's structure. fc_gen: the generation whose sphere the point sits nearest.
fn fc_apollo(p0: vec3f) -> vec2f {
  let z = S.p[3].x;
  // Base arrival times of the fronts at this point.
  // Each front ignites at its origin and burns outward through the foam.
  let K = S.p[2].w;
  let tk2 = max(length(p0 - fc_kickO(K)) - 0.6, 0.0) / 14.0;
  let tk1 = max(length(p0 - fc_kickO(K - 1.0)) - 0.6, 0.0) / 14.0;
  let ts = max(p0.z - z - 0.6, 0.0) / 13.0;
  let mo = vec3f(fc_path(z + 1.5) + vec2f(0.0, S.p[6].x * S.p[7].x), z + 1.5);
  let tm = max(length(p0 - mo) - 0.6, 0.0) / 8.0;
  fc_kx = S.p[2].yz - vec2f(tk2, tk1);
  fc_kf = vec2f(fc_fr(S.p[2].y, tk2), fc_fr(S.p[2].z, tk1));
  fc_sx = S.p[5].yz - ts;
  // The melody's glow gathers round a point in the nave ahead and thins out away from it.
  fc_mx = 0.35 + 0.65 * exp(-tm * 2.5);
  // The event terms, each glided in on the CPU: the melody's foam scale scales the whole iteration.
  let A = S.p[7].z * S.p[6].x;
  let s = S.p[2].x;
  let u = S.p[5].x;
  var p = p0 / A + vec3f(1.0, 1.0, 0.0);
  let mr = max(S.p[1].w + S.p[3].z, 1e-4);
  var scale = 1.0;
  var trap = 1e9;
  var gen = 0.0;
  for (var i = 0; i < 6; i++) {
    let box = S.p[1].xyz + 0.16 * vec3f(sin(u * 1.3), sin(u * 1.7 + 2.0), sin(u * 0.9 + 4.0));
    p = box * (-1.0 + 2.0 * fract(0.5 * p / box + 0.5));
    let r2 = dot(p, p);
    if (r2 < trap) { trap = r2; gen = f32(i); }
    let k = s / clamp(r2, mr, 1e4);
    p *= k;
    scale *= k;
  }
  fc_gen = gen;
  // Distance blend: the Apollonian plane trap or rounded shells.
  let dA = 0.25 * abs(p.y) / scale * A;
  let dB = 0.3 * (length(p) - 0.55) / scale * A;
  return vec2f(mix(dA, dB, S.p[4].w), trap * 3.0);
}

fn fc_map(p: vec3f) -> vec2f {
  let c = p.xy - fc_path(p.z);
  let res = fc_apollo(p);
  // Carve a winding nave for the camera.
  let corridor = length(c * vec2f(1.0, 0.85)) - (S.p[7].x + 0.06 * sin(p.z * 1.7));
  return vec2f(smax(res.x, -corridor, 0.08), res.y);
}

fn fc_normal(p: vec3f, eps: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(vec3f(1e-9) + k.xyy * fc_map(p + k.xyy * eps).x + k.yyx * fc_map(p + k.yyx * eps).x +
                   k.yxy * fc_map(p + k.yxy * eps).x + k.xxx * fc_map(p + k.xxx * eps).x);
}

fn fc_ao(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  var w = 1.0;
  for (var i = 1; i <= 4; i++) {
    let h = 0.01 + 0.06 * f32(i);
    occ += (h - fc_map(p + n * h).x) * w;
    w *= 0.65;
  }
  return sat(1.0 - occ * 4.5);
}

// A palette hue at a luminance, pushed toward vivid, with limited gain so dark entries never blow up.
fn fc_col(t: f32, lum: f32) -> vec3f {
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
fn fc_hrot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735);
  return max(c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a)), vec3f(0.0));
}
// A second hue clearly apart from the first: the first turned 150 degrees round the wheel, so
// every frame carries two distinct hues whatever the palette scheme.
fn fc_second(t: f32, lum: f32) -> vec3f {
  let c = fc_hrot(fc_col(t, 1.0), 2.6);
  return c * (lum / max(luma(c), 0.05));
}
// Fire: white-hot at 1, through yellow and orange, to a deep red near 0.
fn fc_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.32, 0.06) * h + vec3f(0.0, 0.45, 0.2) * h * h + vec3f(0.0, 0.12, 0.3) * h * h * h * h;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let rig = i32(S.p[0].x + 0.5);
  let mat = i32(fmod(S.p[0].y, 10.0) + 0.5);
  let lightK = i32(floor(S.p[0].y / 10.0) + 0.5);
  let focal = select(1.45, 1.15, rig == 2);
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);

  let z = S.p[3].x;
  let ro = vec3f(fc_path(z), z);
  let ahead = vec3f(fc_path(z + 1.2), z + 1.2);
  var ta = ahead;
  if (rig == 1) {
    ta = ahead + vec3f(0.0, 0.5, 0.0);
  } else if (rig == 2) {
    let f = normalize(ahead - ro);
    ta = ro + rotY(0.25 * sign(S.p[7].y)) * f + vec3f(0.0, 0.1, 0.0);
  }
  let cam = lookAt(ro, ta, S.p[3].y);
  let rd = normalize(cam * vec3f(q, focal));
  let fwd = normalize(ahead - ro);
  // Stop at the pixel footprint: finer foam would only alias into dust.
  let pix = 1.4 / (F.res.y * focal);

  let shift = S.p[4].x;
  // Two hues on black, one per softbox.
  let cA = fc_col(shift + 0.08, 1.0);
  let cB = fc_second(shift + 0.08, 1.0);
  let K = S.p[2].w;
  let SN = S.p[5].w;

  var t = 0.02 + ign(frag) * 0.01;
  let far = 14.0;
  var hit = false;
  var trap = 0.0;
  var hl = 1.0;
  for (var i = 0; i < 150; i++) {
    let pos = ro + rd * t;
    let h = fc_map(pos);
    hl = h.x;
    trap = h.y;
    if (h.x < pix * t * 1.3) { hit = true; break; }
    t += h.x * 0.65;
    if (t > far) { break; }
  }
  // Rays that ran out of steps while grazing a sphere count as hits, so silhouettes stay clean.
  if (!hit && t < far && hl < pix * t * 4.0) { hit = true; }

  let fogNear = cB * 0.004;
  let fogFar = cA * 0.02;
  var col = vec3f(0.0);
  if (hit) {
    let pos = ro + rd * t;
    let n = fc_normal(pos, max(0.0004, pix * t * 2.5));
    fc_map(pos);
    let gen = fc_gen;
    // Colour state: two kick fronts back, plus the previous and latest fronts as they pass.
    let kState = K - 2.0 + fc_kf.x + fc_kf.y;
    let ao = fc_ao(pos, n);
    let tv = sqrt(trap);
    let ndv = sat(dot(n, -rd));
    let fre = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
    let r = reflect(rd, n);

    // Key light per rig.
    var L: vec3f;
    var att = 1.0;
    if (lightK == 1) {
      let hp = ro + cam * vec3f(0.35, 0.3, 0.25);
      let dl = hp - pos;
      L = normalize(dl);
      att = 1.6 / (1.0 + dot(dl, dl) * 2.0);
    } else if (lightK == 2) {
      let bp = vec3f(fc_path(z + 5.0), z + 5.0);
      let dl = bp - pos;
      L = normalize(dl);
      att = 3.0 / (1.0 + dot(dl, dl) * 0.15);
    } else {
      L = normalize(vec3f(0.4, 0.7, -0.3));
      att = 1.3;
    }
    let dif = sat(dot(n, L)) * att;
    // Highlights on foam finer than a few pixels would only sparkle as noise: they fade out.
    let spe = pow(sat(dot(r, L)), 48.0) * att * sat(1.4 - pix * t * 18.0);
    // Two softboxes either side, one per hue, over a broad two-hue gradient.
    let side = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)) + vec3f(0.0, 1e-4, 0.0));
    let lA = normalize(side * 0.75 + vec3f(0.0, 0.55, 0.0) - fwd * 0.35);
    let lB = normalize(-side * 0.75 - vec3f(0.0, 0.25, 0.0) - fwd * 0.2);
    var env = cA * 0.12 * pow(0.5 + 0.5 * dot(r, lA), 2.0) + cB * 0.14 * pow(0.5 + 0.5 * dot(r, lB), 2.0);
    env += cA * 0.5 * pow(sat(dot(r, lA)), 8.0) + cB * 0.55 * pow(sat(dot(r, lB)), 8.0);
    env += cA * 0.15 * pow(sat(dot(r, fwd)), 12.0) + cB * 0.015;
    let soft = (cA * sat(dot(n, lA)) + cB * sat(dot(n, lB))) * ao;

    // Colour rides on the kick's front: behind it the foam is re-anodised in the next colour, each
    // generation its own shade.
    let anod0 = fc_col(shift + 0.12 * kState + 0.18 * tv + 0.12 * gen, 1.0);
    // Two-tone: surfaces facing across the nave take the second hue.
    let anod = mix(anod0, fc_hrot(cB, 0.4 * sin(kState * 1.7)), 0.7 * smoothstep(0.4, 0.75, abs(dot(n, side))));
    let ao2 = ao * ao;
    if (mat == 1) {
      // Anodised chrome: reflections take the foam's colour.
      let f0 = mix(vec3f(0.6), anod * 0.6, 0.8);
      let fr = f0 + (vec3f(1.0) - f0) * pow(1.0 - ndv, 5.0);
      col = fr * (env * 3.0 + mix(vec3f(1.0), cA, 0.3) * spe * 0.8) * ao + f0 * (dif * 0.08 * ao2 + soft * 0.08);
    } else if (mat == 2) {
      // Coloured glass: light gathers toward the silhouettes, glossy reflections on top.
      let rimGlow = pow(1.0 - ndv, 1.5);
      col = anod * (0.02 + 0.1 * rimGlow * exp(-t * 0.4)) * (0.4 + 0.6 * ao) + soft * 0.08 + env * (fre + 0.15) * 3.0 * ao + mix(vec3f(1.0), cA, 0.3) * spe * 0.4 * ao;
    } else {
      // Candy paint: a deep coloured body lit two-tone by the softboxes, under a clear coat.
      col = mix(vec3f(0.35), anod, 0.65) * (soft * 0.22 + dif * ao2 * 0.08);
      col += env * (fre + 0.06) * 2.5 * ao + mix(vec3f(1.0), cA, 0.3) * spe * 0.35 * ao;
    }
    // Where the foam is re-forming it glows: hot along the kick's front, white-blue on the snare's.
    // Each glow sums the latest front and the previous one, still burning out; each fades by 0.8 s,
    // before a newer front can push it out of its slot.
    // Front strengths (6 bits each), so each glow follows its own hit.
    let lv = S.p[0].z;
    let kL = vec2f(floor(lv / 262144.0), floor(lv / 4096.0) % 64.0) / 63.0;
    let sL = vec2f(floor(lv / 64.0) % 64.0, lv % 64.0) / 63.0;
    let kDecay = (1.0 - smoothstep(vec2f(0.4), vec2f(0.8), S.p[2].yz)) * kL;
    let kHeat2 = fc_pulse2(fc_kx, 0.3, 3.0) * kDecay;
    let kHeat = kHeat2.x + kHeat2.y;
    // The leading edge is a soft bright band sweeping over the surfaces; the embers smoulder in
    // the crevices where the spheres meet.
    let lead = dot(fc_pulse2(fc_kx, 0.2, 7.0), kDecay);
    col += fc_fire(0.7) * lead * 0.8 * ao + fc_fire(min(kHeat, 1.0) * 0.8) * kHeat * sat((0.7 - ao) * 3.0) * 4.0;
    let sHeat = fc_pulse2(fc_sx, 0.35, 4.0) * (1.0 - smoothstep(vec2f(0.35), vec2f(0.7), S.p[5].yz)) * sL;
    let sTint = mix(vec3f(0.8, 0.9, 1.0), fc_col(shift + 0.62 + 0.19 * SN, 1.0), 0.7) * sHeat.x + mix(vec3f(0.8, 0.9, 1.0), fc_col(shift + 0.62 + 0.19 * (SN - 1.0), 1.0), 0.7) * sHeat.y;
    col += sTint * (0.15 + 1.0 * fre + 0.5 * sat((0.6 - ao) * 3.0)) * ao;
    // The melody's foam catches the note's colour (by pitch) in its sheen, swelling with each note.
    let mHeat = S.p[4].y * fc_mx * 2.4;
    col += fc_col(shift + 0.33 + 0.3 * (1.0 - S.p[6].x) / 0.12, 1.0) * mHeat * (1.4 + 2.0 * fre + 1.1 * sat((0.6 - ao) * 3.0)) * ao;
  }
  let fogAmt = 1.0 - exp(-t * ((0.08 + 1.5 * (S.p[7].x - 0.55)) * 0.6 + 0.04 * (1.0 - F.energySlow)));
  var fc = mix(fogNear, fogFar, sat(t / far));
  fc += cA * 0.05 * pow(sat(dot(rd, fwd)), 12.0) * select(0.5, 1.0, lightK == 2);
  if (!hit) { col = fc; }
  col = mix(col, fc, fogAmt);
  // Contrast and richer colour (the cream foam otherwise washes out), then exposure.
  col = pow(max(mix(vec3f(luma(col)), col, 1.3), vec3f(0.0)), vec3f(1.25)) * 1.4;
  let m = max(col.r, max(col.g, col.b));
  col *= 1.0 / (1.0 + m * 0.5);
  return vec4f(col, 1.0);
}
`,
});
