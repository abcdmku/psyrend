import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';
import { Spring } from '../anim';

/**
 * The fine phase (RULES v7) integrated with the air of the mix: it moves as the detail layer and the
 * high notes say, faster with more air (about as given at typical air), and only faintly in a bare
 * passage, so a high note over near silence re-forms the fine detail gently instead of jolting it.
 * A jump (new cue or seek) restarts it where the raw phase is.
 */
class FinePhase {
  x = 0;
  private last = NaN;
  update(raw: number, air: number): number {
    if (!(Math.abs(raw - this.last) < 2)) this.x = raw;
    else this.x += (raw - this.last) * (0.1 + 1.8 * air);
    this.last = raw;
    return this.x;
  }
}
const finePhase = new FinePhase();


/**
 * Follows an event-driven target (a count, or a sum of steps): each change eases in by smoothstep over
 * `dur` seconds, from rest to rest, so it never snaps and leaves no tail however close the hits come.
 */
class Glide {
  x: number;
  private base: number;
  private target: number;
  private q: [number, number][] = [];
  constructor(x = 0, private dur = 0.6) {
    this.x = this.base = this.target = x;
  }
  update(target: number, dt: number): number {
    if (target !== this.target) this.q.push([0, target - this.target]);
    this.target = target;
    for (const e of this.q) e[0] += dt;
    while (this.q.length && this.q[0][0] >= this.dur) this.base += this.q.shift()![1];
    this.x = this.base;
    for (const [age, v] of this.q) {
      const t = age / this.dur;
      this.x += v * t * t * (3 - 2 * t);
    }
    return this.x;
  }
  reset(x = 0): void {
    this.x = this.base = this.target = x;
    this.q = [];
  }
}

/**
 * Reaction strength from the morph's event level, rising from nothing: the level itself (p = 1) for the
 * kick, the melody and every light, squared (p = 2) for the snare's re-cut of the band widths, a
 * whole-field change that must stay a faint ripple on a faint snare in a quiet passage.
 */
const strength = (level: number, p = 2) => level ** p;

/**
 * The strength side of a front: each event adds its strength to a sum that eases in exactly like the
 * count glide, and the latest strength follows on a quick spring. The lasting state behind a front,
 * sum + level * (phase state - count), then steps by that event's strength (a faint hit a faint
 * change), and it is continuous however the levels and fronts overlap.
 */
class Strength {
  readonly sum: Glide;
  readonly level = new Spring(0, 0.06);
  private total = 0;
  private n = 0;
  constructor(dur: number, private readonly p = 2) {
    this.sum = new Glide(0, dur);
  }
  reset(events: number, level: number): void {
    this.n = events;
    this.total = 0;
    this.sum.reset(0);
    this.level.reset(strength(level, this.p));
  }
  update(events: number, level: number, dt: number): void {
    if (events > this.n) this.total += (events - this.n) * strength(level, this.p);
    this.n = events;
    this.sum.update(this.total, dt);
    this.level.update(strength(level, this.p), dt);
  }
}
/** A strength (0..1) as a 5-bit integer, for packing. */
const q5 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 31);


/**
 * Möbius Flow: glossy neon liquid bands streaming out of one eye and spiralling into another,
 * drawn from the complex logarithm of a rational function. With f(z) = (z-z1)/(z-z2) the bands
 * are the loxodromes of a Möbius flow; a second zero/pole pair is born out of a point, drifts apart
 * and annihilates again, so the field morphs from a dipole into a quadrupole and back.
 *
 * Bands are the level sets of sigma = a*log|f| + (n/2pi)*arg f. n (arms) is an integer, so the
 * bands are continuous across every branch cut; a (the loxodromic pitch) morphs freely, winding
 * the bands from spokes into tight spirals. Everything is exact: the screen gradient of sigma comes
 * from f'/f, so every band edge is box-filtered at one pixel and bands that crowd below a pixel near
 * an eye fade out into its black core instead of aliasing.
 *
 * log|f| runs monotonically along every band (it is the band's own length coordinate), so fronts
 * travel along the bands themselves, at per-band speeds, jumping across to neighbouring bands with
 * ragged delays, and splitting at the saddles where the bands branch:
 *  - kick: a fire lit on one band; behind it every band it burned takes the next hue for good;
 *  - snare: a fast cool crackle from the other side; behind it the bands take new widths (the
 *    marbling is re-cut) and the view turns a little further for good;
 *  - melody: a glow in the note's colour lit where the pitch says; behind it bands lean to the note.
 * Every lasting change rides a glide that follows its event count (each hit eases in by smoothstep
 * over 0.4-0.6 s), and kicks surge the bands half a stripe on along their length: nothing snaps.
 * The light of each kind is one burn (see Burn): it swells in from rest, a roll of hits keeps it
 * glowing instead of restarting it, and it fades with distance, so it never floods the field. A
 * steady glow round every band keeps the field lit between the beats.
 * The morph moves the eyes, the pair's birth and separation and the pitch of the spiral; kicks and
 * snares step it to new lasting shapes; chords lean it; the bands stream steadily from source to
 * sink and slow only in long quiet.
 *
 * DNA: 0 start, 1 layout angle, 2 arms, 3 palette, 4 stripes per arm, 5 spiral sense, 6 light, 7 scale.
 */

const morph = new Morph(0.9);

/**
 * The light of one kind of front. Each hit raises a target that fades over about a third of a second;
 * the light follows it on a spring, so it swells in from rest (about 0.4 s) and a roll of hits keeps
 * one burn glowing instead of restarting it per hit. The burn's radius (seconds of burning) grows
 * from its ignition point while it glows; the point moves on only once the light has died out.
 */
class Burn {
  constructor(private readonly p = 2) {}
  light = 0;
  radius = 0;
  rolls = 0;
  private target = 0;
  private n = 0;
  private readonly spring = new Spring(0, 0.1);
  update(events: number, level: number, dt: number): void {
    if (events > this.n) {
      if (this.light < 0.01 && this.target < 0.01) {
        this.rolls++;
        this.radius = 0;
      }
      // The light rises as far as the hit's strength: a faint hit a faint glow.
      this.target = Math.max(this.target, strength(level, this.p));
    }
    this.n = events;
    this.target *= Math.exp(-dt / 0.35);
    this.light = Math.min(1, Math.max(0, this.spring.update(this.target, dt)));
    if (this.light < 0.01 && this.target < 0.01) this.radius = 0;
    else this.radius = Math.min(this.radius + dt, 4);
  }
  reset(events: number): void {
    this.n = events;
    this.target = this.light = this.radius = 0;
    this.spring.reset(0);
  }
  /** Light (12 bits) and radius (seconds, to 4) in one float: 8 * light + 1.999 * radius. */
  packed(): number {
    return 8 * Math.round(this.light * 4095) + 1.999 * Math.min(this.radius, 4);
  }
}
const st = {
  seed: -1,
  tr: 0,
  ph: 0,
  rot: 0,
  tw: 0,
  /** Glides following the kick, snare and note counts since the seed (the fronts' phases), and the pitch. */
  xk: new Glide(),
  xs: new Glide(),
  xl: new Glide(0, 0.4),
  pe: new Spring(0, 0.2),
  bk: new Burn(1),
  /** The snare's turn of the view: steps shrink in a roll, so a burst of snares turns it about as far as one. */
  turn: new Glide(0, 0.4),
  turnT: 0,
  sN: 0,
  sT: -9,
  bs: new Burn(1),
  bl: new Burn(1),
  k0: 0,
  s0: 0,
  l0: 0,
  /** The melody's pitch target: each note moves it toward its pitch by its strength. */
  peT: 0,
  ln: 0,
  /** Strengths of the kick, snare and note fronts. */
  sk: new Strength(0.6, 1),
  ss: new Strength(0.6),
  sl: new Strength(0.4, 1),
};

export default raymarchScene({
  meta: {
    id: 'mobius-flow',
    name: 'Möbius Flow',
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.55 },
    genres: { edm: 0.9, techno: 0.8, ambient: 0.9, synthwave: 1, pop: 0.7, dnb: 0.7, classical: 0.6, hiphop: 0.6, dubstep: 0.6, rock: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    if (g[0] !== st.seed || morph.notes < st.l0 || morph.kicks < st.k0 || morph.snares < st.s0) {
      st.seed = g[0];
      st.k0 = morph.kicks;
      st.s0 = morph.snares;
      st.l0 = morph.notes;
      st.xk.reset(0);
      st.xs.reset(0);
      st.xl.reset(0);
      st.bk.reset(morph.kicks);
      st.turn.reset(0);
      st.turnT = 0;
      st.sN = morph.snares;
      st.sT = -9;
      st.bs.reset(morph.snares);
      st.bl.reset(morph.notes);
      st.pe.reset(morph.notePitch);
      st.peT = morph.notePitch;
      st.ln = morph.notes;
      st.sk.reset(morph.kicks, morph.kickLevel);
      st.ss.reset(morph.snares, morph.snareLevel);
      st.sl.reset(morph.notes, morph.noteLevel);
      st.tr = morph.travel;
      st.ph = st.rot = st.tw = 0;
    }
    // Front phases: glides that follow the event counts, so every front and step glides in from rest.
    const xk = st.xk.update(morph.kicks - st.k0, dt);
    const xs = st.xs.update(morph.snares - st.s0, dt);
    const xl = st.xl.update(morph.notes - st.l0, dt);
    st.sk.update(morph.kicks, morph.kickLevel, dt);
    st.ss.update(morph.snares, morph.snareLevel, dt);
    st.sl.update(morph.notes, morph.noteLevel, dt);
    st.bk.update(morph.kicks, morph.kickLevel, dt);
    if (morph.snares > st.sN) {
      st.turnT += Math.min(1, Math.max(0.2, (m.time - st.sT) / 0.4)) * morph.snareLevel;
      st.sT = m.time;
    }
    st.sN = morph.snares;
    const turn = st.turn.update(st.turnT, dt);
    st.bs.update(morph.snares, morph.snareLevel, dt);
    st.bl.update(morph.notes, morph.noteLevel, dt);
    // Energy: the flow, the turn and the bass twist all advance with the travel (which rushes with the
    // bass drive), and a drop multiplies them further while its surge eases off.
    const dTr = Math.min(Math.max(morph.travel - st.tr, 0), 1);
    st.tr = morph.travel;
    const rush = 1 + 6 * morph.surge;
    st.ph += dTr * 0.03 * rush;
    st.rot += dTr * 0.015 * rush;
    st.tw += dTr * (0.4 + 0.8 * morph.drive) * rush;
    // The melody winds the spiral: the pitch glides in on a spring (about half a second) and holds.
    if (morph.notes > st.ln) st.peT += (morph.notePitch - st.peT) * morph.noteLevel;
    st.ln = morph.notes;
    const pe = st.pe.update(st.peT, dt);
    // The two eyes (source z1, sink z2).
    p[0] = wave(a[0], -1.15, -0.35);
    p[1] = wave(a[1], -0.55, 0.55);
    p[2] = wave(a[2], 0.35, 1.15);
    p[3] = wave(a[3], -0.55, 0.55);
    // The second pair: centre, then a separation that rests at zero (annihilated) part of the time.
    const cx = wave(a[4], -0.9, 0.9);
    const cy = wave(a[5], -0.6, 0.6);
    const sep = Math.max(0, wave(a[6], -0.25, 0.9));
    const psi = a[7] * 0.6 + g[1] * 6.283;
    p[4] = cx + 0.5 * sep * Math.cos(psi);
    p[5] = cy + 0.5 * sep * Math.sin(psi);
    p[6] = cx - 0.5 * sep * Math.cos(psi);
    p[7] = cy - 0.5 * sep * Math.sin(psi);
    // Spiral pitch a, arms n, stripes per arm, flow phase.
    const sense = g[5] < 0.5 ? -1 : 1;
    p[8] = sense * (wave(a[1] * 0.7 + a[6] * 0.5, 0.35, 1.25) + 0.5 * pe + (0.1 * morph.drive + 0.6 * morph.surge) * Math.sin(st.tw));
    // Arms + 16 * stripes per arm + 256 * the fronts' recent strengths (5 bits each: kick, snare, note).
    const arms = 3 + Math.floor(g[2] * 4);
    const perArm = 6 + Math.floor(g[4] * 4);
    p[9] = arms + 16 * perArm + 256 * (q5(st.sk.level.x) + 32 * q5(st.ss.level.x) + 1024 * q5(st.sl.level.x));
    // Flow phase: steady streaming; kicks and notes surge the bands on along their length, each by its strength.
    p[11] = st.ph + (1.0 * st.sk.sum.x + 0.5 * st.sl.sum.x) / perArm;
    // Front phases.
    p[12] = xk;
    p[13] = xs;
    p[14] = xl;
    // Fine scale (the high end): a phase that flows with the detail layer and steps with each high
    // note (by its level), each backing chord and each hat, eased by the morph. It meanders every band
    // along its length: the same bands, re-formed at their finest scale.
    p[15] = finePhase.update(0.8 * morph.detailAt[0] + 0.7 * morph.upperPhase + 0.4 * morph.backingPhase + 0.25 * morph.hatPhase, morph.detailDrive);
    // Burn lights and radii (packed), and the fronts' strength sums.
    p[16] = st.bk.packed();
    p[17] = st.bs.packed();
    p[19] = st.bl.packed();
    p[10] = st.sk.sum.x;
    p[23] = st.ss.sum.x;
    p[31] = st.sl.sum.x;
    p[18] = pe;
    // View: steady slow turn, scale; palette offset eased with the morph.
    // Each snare turns the view a little further for good, easing in over 0.4 s.
    p[20] = g[1] * 6.283 + st.rot * sense + 0.14 * turn;
    // Scale, with the light's side in its sign.
    p[21] = (1.05 + 0.25 * g[7]) * (g[6] < 0.5 ? -1 : 1);
    p[22] = g[3] + 0.06 * Math.sin(a[2] * 0.5);
    // Ignition points (plane coordinates), one per burn (they move on only once its light has died): kicks burst out of the source
    // eye, snares crackle out of the sink, a melody note lights a band at a height set by its pitch.
    const ka = st.bk.rolls * 2.4;
    const sa = st.bs.rolls * 1.9 + 1;
    const qx = 1.1 * Math.sin(st.bl.rolls * 2.1);
    const qy = 0.75 * pe;
    const c = Math.cos(p[20]);
    const s = Math.sin(p[20]);
    p[24] = p[0] + 0.22 * Math.cos(ka);
    p[25] = p[1] + 0.22 * Math.sin(ka);
    p[26] = p[2] + 0.28 * Math.cos(sa);
    p[27] = p[3] + 0.28 * Math.sin(sa);
    p[28] = (c * qx - s * qy) * Math.abs(p[21]);
    p[29] = (s * qx + c * qy) * Math.abs(p[21]);
    // Bass weight: how much the bands swell and ripple along their length.
    // Brightness (to 0.001, integer part) and the bass weight (fraction) in one float.
    p[30] = Math.round((0.8 + 0.4 * m.energySlow * morph.flow) * 1000) + 0.999 * (0.2 + 0.15 * morph.drive + 0.3 * morph.surge);
  },
  wgsl: /* wgsl */ `
// A burn's packed light (x) and radius (y, seconds).
fn mf_lr(v: f32) -> vec2f { let l = floor(v / 8.0); return vec2f(l / 4095.0, (v - 8.0 * l) / 1.999); }

fn mf_inv(v: vec2f) -> vec2f { return vec2f(v.x, -v.y) / max(dot(v, v), 1e-12); }

// Fire by heat (1 = just lit): white core, yellow, orange.
fn mf_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.25, 0.05) * h * 1.4 + vec3f(1.0, 0.62, 0.2) * h * h * 2.2 + vec3f(1.0, 0.95, 0.9) * pow(h, 5.0) * 2.5;
}

// Circular distance between stripe indices in a ring of nb.
fn mf_cdist(a: f32, b: f32, nb: f32) -> f32 { let d = abs(a - b) - nb * floor(abs(a - b) / nb); return min(d, nb - d); }

// Arrival fraction (0..0.5) of a front lit on stripe i0 at z0 reaching stripe i: it runs along the
// stripe at a per-stripe speed and jumps to neighbouring stripes after ragged delays.
fn mf_arrive(z: vec2f, L: f32, i: f32, h: f32, z0: vec2f, i0: f32, nb: f32, v: f32, jump: f32) -> f32 {
  let t = length(z - z0) / (v * (0.7 + 0.6 * h)) + mf_cdist(i, i0, nb) * jump * (0.4 + 1.2 * h) + 0.04 * (1.0 + sin(L * 9.0 + h * 40.0));
  return 0.5 * (1.0 - exp(-t / 0.35));
}

// Phase fronts. x follows an event count, each event easing in by smoothstep over 0.6 s (about a beat) (from rest, one unit per
// event, however close the events come); tau the arrival fraction. Returns (state, u): the lasting
// state steps by 1 per event, eased in as the front passes; u is how far the front has gone past
// (0..1, at least 0.5 at rest). Continuous in x, so nothing can snap.
fn mf_phase(x: f32, tau: f32) -> vec2f {
  let y = x - tau;
  let u = fract(y);
  return vec2f(floor(y) + smoothstep(0.0, 0.5, u), u);
}
// A burn's light at z: lit from z0 at speed v (ragged per band), its head where the burn radius R
// (seconds) has reached, an ember behind, scaled by the eased light and fading beyond reach.
fn mf_burn(z: vec2f, h: f32, z0: vec2f, v: f32, R: f32, light: f32, reach: f32) -> f32 {
  let d = length(z - z0);
  let ta = d / (v * (0.7 + 0.6 * h)) + 0.08 * h;
  let head = exp(-pow((R - ta) / 0.22, 2.0));
  let behind = smoothstep(ta - 0.2, ta, R);
  return light * (0.3 * behind + 0.7 * head) * exp(-d / reach);
}

// Box-filtered coverage of the band |x| < hw by a pixel of width fw centred at x.
fn mf_cover(x: f32, hw: f32, fw: f32) -> f32 {
  return max(0.0, min(x + 0.5 * fw, hw) - max(x - 0.5 * fw, -hw)) / fw;
}

// The director palette at a luminance, pushed toward full saturation (neon on black).
fn mf_viv(t: f32, lvl: f32) -> vec3f { return mf_col(t, lvl, 0.0); }
fn mf_col(t: f32, lvl: f32, rot: f32) -> vec3f {
  let p = pal(t);
  let mx = max(p.r, max(p.g, p.b));
  let mn = min(p.r, min(p.g, p.b));
  // Hue from the colour's chroma vector, steadied by a pull toward t's own hue, so a near-grey
  // palette colour never makes the hue flip.
  let cv = vec2f(p.r - 0.5 * (p.g + p.b), 0.8660254 * (p.g - p.b)) + 0.2 * vec2f(cos(t * TAU), sin(t * TAU));
  let h = fract(atan2(cv.y, cv.x) / TAU);
  let s = mix(0.85, 0.97, sat((mx - mn) / max(mx, 1e-4)));
  let c = hsv2rgb(vec3f(fract(h + rot), s, 1.0));
  // Even out perceived brightness across hues (a pure blue is far darker than a pure green).
  return c * lvl * pow(0.4 / max(luma(c), 0.08), 0.55);
}

// Rotates a colour about the grey axis by angle a.
fn mf_hrot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735);
  let ca = cos(a);
  return max(c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca), vec3f(0.0));
}

// Band half-width (stripe units) for a stripe in a given snare state: thick glossy bands, hairlines, gaps.
fn mf_width(fid: f32, st: f32) -> f32 {
  let r = hash12(vec2f(fid, 31.0 + 13.0 * st));
  return select(select(0.0, 0.07, r > 0.3), 0.13 + 0.2 * hash12(vec2f(fid, 3.0 + st)), r > 0.5);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let scale = abs(S.p[5].y);
  let z = rot2(S.p[5].x) * q * scale;
  let z1 = S.p[0].xy; let z2 = S.p[0].zw; let z3 = S.p[1].xy; let z4 = S.p[1].zw;
  let d1 = z - z1; let d2 = z - z2; let d3 = z - z3; let d4 = z - z4;
  // log f = L + i th; f'/f = dw.
  let L = 0.5 * (log(dot(d1, d1)) - log(dot(d2, d2)) + log(dot(d3, d3)) - log(dot(d4, d4)));
  let th = atan2(d1.y, d1.x) - atan2(d2.y, d2.x) + atan2(d3.y, d3.x) - atan2(d4.y, d4.x);
  let dw = mf_inv(d1) - mf_inv(d2) + mf_inv(d3) - mf_inv(d4);

  let A = S.p[2].x;
  let ap = fmod(S.p[2].y, 256.0);
  let M = floor(ap / 16.0);
  let n = ap - 16.0 * M;
  // The fronts' recent strengths (kick, snare, note).
  let lq = floor(S.p[2].y / 256.0);
  let lvK = fmod(lq, 32.0) / 31.0;
  let lvS = fmod(floor(lq / 32.0), 32.0) / 31.0;
  let lvL = floor(lq / 1024.0) / 31.0;
  let B = n / TAU;
  let NB = n * M;
  let sig = A * L + B * th - S.p[2].w;
  // Screen gradient of sigma (z units), exact from f'/f.
  let grad = vec2f(A * dw.x + B * dw.y, B * dw.x - A * dw.y);
  let gl = length(grad);
  let gdir = rot2(-S.p[5].x) * (grad / max(gl, 1e-9));
  // One pixel in stripe units.
  // (widened by the meander's slope along L, so its edges stay box-filtered).
  let fw = gl * scale * 2.0 / F.res.y * M * (1.0 + 1.1 / (M * max(length(vec2f(A, B)), 0.2)));
  // Fine meander from the high end: the bands wind along their length (L), the wobble's phase set
  // by the detail layer and its amplitude by the air of the mix (two octaves, so it is not a sine).
  let fph = S.p[3].w;
  let bassW = fract(S.p[7].z) / 0.999;
  let s = sig * M + (0.12 * sin(L * 5.0 + fph) + 0.055 * sin(L * 11.0 - 1.7 * fph + 2.0)) * (0.6 + 0.4 * sin(L * 1.3 + 0.3 * fph));
  let id = s - NB * floor(s / NB);
  let fid = floor(id);
  let x = fract(s) - 0.5;
  let h = hash12(vec2f(fid, 7.0));
  let detail = 1.0 - smoothstep(0.22, 0.55, fw);

  let xK = S.p[3].x; let xS = S.p[3].y; let xL = S.p[3].z;
  let pNew = S.p[4].z;
  let hue0 = S.p[5].z;

  // Lasting-state fronts: each event's struck stripe stays put while its front passes and moves on
  // only at whole glide values (where the state is settled), so arrival times never shift mid-change.
  let pK = mf_phase(xK, mf_arrive(z, L, fid, h, S.p[6].xy, (floor(xK) + 1.0) * 0.618 * NB, NB, 2.2, 0.03));
  let pS = mf_phase(xS, mf_arrive(z, L, fid, h, S.p[6].zw, (floor(xS) + 1.0) * 0.382 * NB + 0.2 * NB, NB, 4.5, 0.012));
  let pL = mf_phase(xL, mf_arrive(z, L, fid, h, S.p[7].xy, (0.5 + 0.5 * pNew) * NB, NB, 7.0, 0.005));

  // Lasting states: hue steps behind the kicks, band widths re-cut behind the snares.
  // Each steps by its event's strength: sum + strength * (phase state - count).
  let hState = S.p[2].z + lvK * (pK.x - xK);
  let sState = S.p[5].w + lvS * (pS.x - xS);
  let lState = S.p[7].w + lvL * (pL.x - xL);
  let sN = floor(sState);
  var hw = mix(mf_width(fid, sN), mf_width(fid, sN + 1.0), sState - sN);
  hw *= 1.0 - bassW + bassW * sin(L * (1.5 + 2.0 * h) + h * 20.0 - S.p[2].w * 2.5);
  // Far from the eyes a band would grow wide and flat: cap its half-width at a few percent of the screen.
  hw = min(hw, 0.035 * F.res.y * max(fw, 1e-4));
  let cov = mf_cover(x, hw, max(fw, 1e-4));
  let t = clamp(x / max(hw, 1e-4), -1.0, 1.0);
  let hgt = sqrt(max(1.0 - t * t, 0.0));

  // The note colour glides with the pitch; each note's front also turns it a step round the wheel.
  let noteCol = mf_col(hue0 + 0.25 + 2.0 * pNew + 0.35 * lState, 0.38, -0.08);
  // A smooth wheel of offsets (never a wrap), so the kicks turn every band's hue continuously.
  let hue = hue0 + 0.375 + 0.375 * sin(TAU * (h * 3.7 + 0.13 * hState));
  // Each arm is a bundle: its first stripes take the palette, the rest a complementary accent family.
  let inArm = fid - M * floor(fid / M);
  let acc = step(M * 0.5, inArm);
  let rot = acc * (0.36 + 0.1 * sin(hState * 0.7));
  var base = mf_col(hue, 0.3, rot);
  base = mix(base, noteCol, 0.7 * min(xL, 1.0) * (1.0 - acc) * step(0.45, fract(h * 2.9)));

  // Glossy tube: normal from the band profile across the gradient direction.
  let slope = t / max(hgt, 0.2);
  let nrm = normalize(vec3f(gdir * slope * 0.9, 1.0));
  let ld = normalize(vec3f(-0.45 * sign(S.p[5].y), 0.6, 0.75));
  let hv = normalize(ld + vec3f(0.0, 0.0, 1.0));
  let dif = 0.25 + 0.75 * max(dot(nrm, ld), 0.0);
  let spc = pow(max(dot(nrm, hv), 0.0), 70.0);
  let fres = pow(1.0 - nrm.z, 2.0);
  var band = base * (0.25 + 0.9 * hgt) * dif;
  band += mf_col(hue + 0.22, 0.4, rot) * fres * 0.6;
  band += mix(vec3f(0.6), base * 2.5, 0.7) * spc * 0.5;

  // Hot heads and embers: each burn's head runs out from its ignition point as its radius grows,
  // with an ember behind it, all scaled by the burn's eased light and fading with distance, so a
  // head never floods the whole field and a roll of hits keeps one burn glowing.
  let bK = mf_lr(S.p[4].x);
  let bS = mf_lr(S.p[4].y);
  let bL = mf_lr(S.p[4].w);
  let heat = mf_burn(z, h, S.p[6].xy, 2.0, bK.y, bK.x, 1.9);
  let emb = heat * step(0.78, hash12(vec2f(floor(L * 7.0), fid)));
  let sh = mf_burn(z, h, S.p[6].zw, 3.5, bS.y, bS.x, 1.9);
  let lh = mf_burn(z, h, S.p[7].xy, 3.0, bL.y, bL.x, 1.7) * (1.0 - acc * 0.6);
  let sCol = mix(mf_hrot(mf_viv(hue0 + 0.55, 0.8), 2.2), vec3f(0.3, 0.55, 0.9), 0.3);
  band += mf_fire(heat * 0.7) * 1.2 + mf_fire(0.3) * emb * 0.3 + sCol * sh * 2.2 + noteCol * lh * 6.0;

  // Bands too dense to resolve fade into a dark core with a faint glow of their mean colour.
  let far = base * 0.05 * (1.0 - detail) * smoothstep(1.6, 0.5, fw);
  // Glow in the gaps next to burning bands.
  let gap = abs(x) - hw;
  let halo = exp(-max(gap, 0.0) / max(0.05, fw * 2.0)) * (heat * 0.5 + sh * 0.6 + lh * 0.3) * detail;
  // A steady glow round every band in its own colour, so the field glows between the beats too.
  let glow = exp(-max(gap, 0.0) / max(0.06, fw * 2.5)) * detail * 0.5;
  var col = band * cov * detail + far + (mf_fire(heat * 0.7) * 0.3 + sCol * sh * 0.8 + noteCol * lh * 1.0) * halo + base * glow;
  col *= floor(S.p[7].z) / 1000.0;
  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.3 * max(pk - 0.9, 0.0));
  return vec4f(col, 1.0);
}
`,
});
