import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';
import { Spring } from '../anim';

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
 * The strength of every event since a seed, by index (1-based), and their running sum. A front phase
 * glides over the event count; the shader needs, at the glide's integer part N, the summed level of
 * the events before N and the levels of events N and N + 1 (the two that can be in flight at once),
 * so every front and the lasting step it leaves keep the strength of their own hit.
 */
class Levels {
  private lv = [0];
  private cum = [0];
  get total(): number {
    return this.cum[this.cum.length - 1];
  }
  reset(): void {
    this.lv = [0];
    this.cum = [0];
  }
  /** Records new events up to `count`, each with the latest event strength. */
  sync(count: number, level: number): void {
    while (this.lv.length <= count) {
      this.lv.push(level);
      this.cum.push(this.total + level);
    }
  }
  /** [sum of levels before event N, levels of N and N + 1 packed as floor(1000 a) + 0.999 b]. */
  at(x: number): [number, number] {
    const N = Math.max(0, Math.floor(x));
    const a = N >= 1 ? (this.lv[N] ?? 0) : 0;
    const b = this.lv[N + 1] ?? 0;
    return [N >= 1 ? this.cum[N - 1] : 0, Math.floor(a * 1000) + 0.999 * b];
  }
}

/**
 * Domain Colour: an enhanced phase portrait (Wegert) of a complex rational function with 3 to 5
 * zeros and poles, drawn as glossy neon contour tubes.
 *
 * The field is w = log f, a sum of log(z - a_i) with zeros at +1 and poles at -1, plus one composite
 * per family: exp(kappa z) for the exp family, or exp(A sin(B z + c)) for the sin family. Two families
 * of level sets are drawn at once:
 *  - the L family: lines of log|f| (Re w), spaced 1/K apart, so rings close round every zero and pole;
 *  - the T family: lines of arg f (Im w), N per turn, so rays come out of every zero and pole.
 * Together they form a woven grid that bends round the roots. Both share the footprint |w'| (the
 * Wegert rule), so one pixel width anti-aliases both, and bands finer than a pixel fade to a dark core
 * at each root instead of aliasing.
 *
 * Each tube is glossy: a cylinder profile across the gradient, a coloured rim and a restrained
 * specular. The L lines take the phase colour, so the hue turns round each root; the T lines take the
 * colour of their own phase index, and that is complementary, so every frame carries two hues.
 *
 * Changes of count and layout. Roots always come in five slots with alternating signs (zeros at 0, 2,
 * 4; poles at 1, 3). A phrase sets how many are live (3, 4 or 5). A dormant slot is parked 40 units
 * out and eased in, so a root grows in from the edge of the frame and never pops, and the integer
 * multiplicities (and so the branch cuts) stay exact. The family (rational, exp, sin composite)
 * cycles with the phrase and cross-fades on the same clock.
 *
 * Music:
 *  - morph: the root positions, the family's kappa and B, the line density and the view turn all come
 *    from morph.at through periodic wave(); each phrase jumps the coordinates to a new region.
 * Every front's glow and the lasting step it leaves scale with its own hit's strength (morph's event
 * levels, captured as each event lands), so a faint hit makes a faint change and a hard one a full one.
 *  - kick: a front lit at a live zero, racing along the lines; behind it the lines step hue for good.
 *  - snare: a cool crackle from a live pole; behind it the line widths are re-cut for good.
 *  - melody: a glow in the note's colour lit at a height set by pitch; behind it the lines take the
 *    note's colour until the next note.
 * The sin phase and view turn advance with morph.travel, so the lines stream and drops rush them.
 *  - high end (upper melody, backing, hats, air): a fine warp of the plane re-forms every line's fine
 *    shape; its phase steps with each high note by its strength, and the air sets its depth.
 * Every front rides a glide that follows its event count (each hit eases in by smoothstep over 0.6 s for
 * the kick, 1 s for the snare and note), so each one swells in from
 * rest and passes on with a soft edge, and the steps it leaves behind ease in: nothing snaps.
 *
 * DNA: 0 start, 1 view and kappa angle, 2 count pattern, 3 palette, 4 line count N, 5 family order,
 * 6 unused, 7 zoom offset.
 *
 * Infinite zoom: the grid is drawn at 3 octave scales round a slowly drifting centre (zoomScale and
 * zoomWeight), the zoom level growing with morph.travel, so drops rush deeper. Each octave is turned and
 * hue-shifted by its stable id, so every new octave is a new constellation; octaves combine by max,
 * so crossings keep their hue.
 */

const FAR = 40;
const morph = new Morph(0.9);
const st = {
  seed: -1,
  pres: [1, 1, 1, 1, 1],
  wE: 0,
  wS: 0,
  tr: 0,
  rot: 0,
  ph: 0,
  /** Glides following the kick, snare and note counts since the seed (the fronts' phases), and the pitch. */
  xk: new Glide(0, 0.6),
  xs: new Glide(0, 1.0),
  xl: new Glide(0, 1.0),
  /** Each event's strength by index, and glides of the summed strengths (the view turn). */
  lk: new Levels(),
  ls: new Levels(),
  ll: new Levels(),
  vk: new Glide(),
  vs: new Glide(),
  vl: new Glide(),
  pitch: new Spring(0, 0.2),
  k0: 0,
  s0: 0,
  l0: 0,
};

export default raymarchScene({
  meta: {
    id: 'domain-colour',
    name: 'Domain Colour',
    energy: [0, 1],
    mood: { valence: 0.5, arousal: 0.6 },
    genres: { edm: 0.8, techno: 0.8, synthwave: 1, ambient: 0.7, dubstep: 0.7, dnb: 0.7, pop: 0.6, rock: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    const a = morph.at;

    // Phrase: how many roots are live (3 to 5) and which family is showing.
    const ph = morph.phrases;
    const n = 3 + ((ph + Math.floor(g[2] * 3)) % 3);
    const fam = (ph + Math.floor(g[5] * 3)) % 3;

    // A new cue, or a seek (the morph restarts its counts): start the fronts and steps afresh.
    if (g[0] !== st.seed || morph.kicks < st.k0 + st.xk.x - 1e-6 || morph.snares < st.s0 + st.xs.x - 1e-6 || morph.notes < st.l0 + st.xl.x - 1e-6) {
      st.seed = g[0];
      st.k0 = morph.kicks;
      st.s0 = morph.snares;
      st.l0 = morph.notes;
      st.xk.reset(0);
      st.xs.reset(0);
      st.xl.reset(0);
      st.lk.reset();
      st.ls.reset();
      st.ll.reset();
      st.vk.reset(0);
      st.vs.reset(0);
      st.vl.reset(0);
      st.pitch.reset(morph.notePitch);
      st.tr = morph.travel;
      st.rot = 0;
      st.ph = 0;
      for (let i = 0; i < 5; i++) st.pres[i] = i < n ? 1 : 0;
      st.wE = fam === 1 ? 1 : 0;
      st.wS = fam === 2 ? 1 : 0;
    }

    // Eased presence of each root slot, and the family blend.
    const ease = 1 - Math.exp(-dt / 0.9);
    const fe = 1 - Math.exp(-dt / 0.7);
    st.wE += ((fam === 1 ? 1 : 0) - st.wE) * fe;
    st.wS += ((fam === 2 ? 1 : 0) - st.wS) * fe;

    // Root targets, each on its own pair of morph coordinates (wide ranges, so a phrase lands elsewhere).
    // The roots drift at 60% of the morph's rate: a steady, readable motion under heavy drive.
    // The zoom carries the steady motion now, so the morph's flow part runs at half rate while the beat
    // steps stay full: the roots still answer every hit, over a calmer base drift.
    const fa0 = morph.flowAt;
    const b = (i: number) => (fa0[i] * 0.5 + (a[i] - fa0[i])) * 0.6;
    const tgt: [number, number][] = [
      [wave(b(0), -1.15, 1.15), wave(b(1), -0.7, 0.7)],
      [wave(b(2), -1.15, 1.15), wave(b(3), -0.7, 0.7)],
      [wave(b(4), -1.15, 1.15), wave(b(5), -0.7, 0.7)],
      [wave(b(6), -1.15, 1.15), wave(b(7), -0.7, 0.7)],
      [wave(b(1) - b(6) * 0.67, -1.0, 1.0), wave(b(5) + b(2) * 0.67, -0.6, 0.6)],
    ];
    const R: number[] = [];
    for (let i = 0; i < 5; i++) {
      st.pres[i] += ((i < n ? 1 : 0) - st.pres[i]) * ease;
      const s = st.pres[i] * st.pres[i] * (3 - 2 * st.pres[i]);
      const fa = g[0] * 6.283 + i * 1.257 + 0.6;
      R.push(FAR * Math.cos(fa) * (1 - s) + tgt[i][0] * s, FAR * Math.sin(fa) * (1 - s) + tgt[i][1] * s);
    }

    // Flow: the sin phase streams the lines and the view turns, both with the travel (rushed by drops).
    const dTr = Math.min(Math.max(morph.travel - st.tr, 0), 1);
    st.tr = morph.travel;
    const rush = 1 + 6 * morph.surge;
    st.ph += dTr * 0.12 * rush;
    st.rot += dTr * 0.006 * rush + dt * 0.012 * morph.flow;

    const K = wave(a[6] * 0.5, 1.6, 2.6);
    const N = 6 + Math.floor(g[4] * 4);
    const phi = a[5] * 0.3 + g[1] * 6.283;

    // Roots: (zero, pole, zero, pole, zero) as S.p[0..2].
    p[0] = R[0];
    p[1] = R[1];
    p[2] = R[2];
    p[3] = R[3];
    p[4] = R[4];
    p[5] = R[5];
    p[6] = R[6];
    p[7] = R[7];
    p[8] = R[8];
    p[9] = R[9];
    p[10] = st.wE;
    p[11] = st.wS;
    p[12] = K;
    // Fine scale (the high end): a fine warp of the plane that bends every contour line. The phase flows
    // with the detail coordinates and steps with each high note (and gently with backing chords and
    // hats), each eased and scaled by its strength; the air of the mix sets its depth, so loud highs
    // crimp the lines finely and quiet ones leave them smooth. Its frequency follows the detail too.
    const d4 = morph.detailAt;
    const wf = wave(d4[1] * 0.5, 7, 12);
    const wa = (0.006 + 0.02 * morph.detailDrive) * (9 / wf);
    p[13] = Math.round(wf * 100) + wa;
    p[14] = st.ph;
    // The hue offset (fractional, the shader only uses it on the wheel) carries the line count N.
    p[15] = g[3] + N;
    p[16] = phi;
    p[18] = wave(a[3] * 0.6, 0.9, 2.2);
    p[19] = wave(a[4] * 0.5, -0.9, 0.9);
    // Front phases: glides that follow the event counts, so every front and step glides in from rest.
    // Each event's level is captured as it lands, so the fronts in flight keep their own strength.
    // Squared: a faint hit after quiet stays a faint touch, a hard one gives the full change.
    st.lk.sync(morph.kicks - st.k0, morph.kickLevel ** 2);
    st.ls.sync(morph.snares - st.s0, morph.snareLevel ** 2);
    st.ll.sync(morph.notes - st.l0, morph.noteLevel ** 2);
    p[20] = st.xk.update(morph.kicks - st.k0, dt);
    p[22] = st.xs.update(morph.snares - st.s0, dt);
    p[24] = st.xl.update(morph.notes - st.l0, dt);
    [p[21], p[27]] = st.lk.at(p[20]);
    [p[23], p[28]] = st.ls.at(p[22]);
    [p[25], p[17]] = st.ll.at(p[24]);
    p[26] = st.pitch.update(morph.notePitch, dt);
    p[29] = d4[0] * 0.8 + 3.5 * morph.upperPhase + 0.6 * morph.backingPhase + 0.15 * morph.hatPhase;
    // Kicks turn the view a little further (and notes back), by each hit's strength, gliding in with their fronts.
    const vk = st.vk.update(st.lk.total, dt);
    const vs = st.vs.update(st.ls.total, dt);
    const vl = st.vl.update(st.ll.total, dt);
    p[30] = g[1] * 6.283 + st.rot + 0.09 * vk + 0.07 * vs - 0.12 * vl;
    // Zoom level in octaves: grows with the travel (music paced, rushed by drops); DNA offsets it.
    p[31] = morph.travel * 0.32 + 0.3 * g[7] + 2.0 * g[0];
  },
  wgsl: /* wgsl */ `
struct DC { w: vec2f, d: vec2f };

fn dc_mul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn dc_inv(a: vec2f) -> vec2f { return vec2f(a.x, -a.y) / max(dot(a, a), 1e-12); }
fn dc_log(a: vec2f) -> vec2f { return vec2f(0.5 * log(max(dot(a, a), 1e-12)), atan2(a.y, a.x)); }
// log(z - a) and its derivative 1 / (z - a), packed as (w, w').
fn dc_root(z: vec2f, a: vec2f) -> vec4f { let q = z - a; return vec4f(dc_log(q), dc_inv(q)); }
// Complex sin and cos: sin(x + iy) = sin x cosh y + i cos x sinh y.
fn dc_sin(z: vec2f) -> vec2f {
  let e = exp(z.y);
  return vec2f(sin(z.x) * 0.5 * (e + 1.0 / e), cos(z.x) * 0.5 * (e - 1.0 / e));
}
fn dc_cos(z: vec2f) -> vec2f {
  let e = exp(z.y);
  return vec2f(cos(z.x) * 0.5 * (e + 1.0 / e), -sin(z.x) * 0.5 * (e - 1.0 / e));
}

// Root slot i (0..4) from the packed parameters; slots 0, 2, 4 are zeros and 1, 3 poles.
fn dc_pick(i: f32) -> vec2f {
  var r = S.p[2].xy;
  if (i < 3.5) { r = S.p[1].zw; }
  if (i < 2.5) { r = S.p[1].xy; }
  if (i < 1.5) { r = S.p[0].zw; }
  if (i < 0.5) { r = S.p[0].xy; }
  return r;
}

// w = log f = sum over the roots of s_i log(z - a_i), plus the family's composite; w' = f'/f.
// The fine warp: a small high-octave bend of the plane (frequency and depth packed in S.p[3].y, phase
// in S.p[7].y). Every contour line takes it, so the high end re-forms the lines' fine shape.
fn dc_warp(z: vec2f) -> vec2f {
  let fq = floor(S.p[3].y) / 100.0;
  let am = fract(S.p[3].y);
  let ph = S.p[7].y;
  return z + am * vec2f(sin(fq * z.y + ph + 1.3 * sin(0.5 * fq * z.x - 0.7 * ph)), sin(fq * z.x - 1.21 * ph + 1.3 * sin(0.5 * fq * z.y + 0.6 * ph)));
}

fn dc_field(z: vec2f) -> DC {
  let r0 = dc_root(z, S.p[0].xy);
  let r1 = dc_root(z, S.p[0].zw);
  let r2 = dc_root(z, S.p[1].xy);
  let r3 = dc_root(z, S.p[1].zw);
  let r4 = dc_root(z, S.p[2].xy);
  var w = r0.xy - r1.xy + r2.xy - r3.xy + r4.xy;
  var d = r0.zw - r1.zw + r2.zw - r3.zw + r4.zw;
  let ke = 1.1 * vec2f(cos(S.p[4].x), sin(S.p[4].x));
  let bb = S.p[4].zw;
  let wE = S.p[2].z;
  let wS = S.p[2].w;
  let A = 0.45;
  let bz = dc_mul(bb, z) + vec2f(S.p[3].z, 0.0);
  w += wE * dc_mul(ke, z) + wS * A * dc_sin(bz);
  d += wE * ke + wS * A * dc_mul(bb, dc_cos(bz));
  return DC(w, d);
}

// Band half-width for a line in a given snare state: thick glossy tubes, hairlines, gaps.
fn dc_width(id: f32, sn: f32, fam: f32) -> f32 {
  let r = hash12(vec2f(id + 0.37 * fam + 0.613 * dc_oid, 31.0 + 13.0 * sn));
  return select(select(0.0, 0.07, r > 0.3), 0.12 + 0.12 * hash12(vec2f(id + 0.37 * fam + 0.613 * dc_oid, 3.0 + sn)), r > 0.5);
}

// Box-filtered coverage of the band |x| < hw by a pixel of width fw centred at x.
fn dc_cover(x: f32, hw: f32, fw: f32) -> f32 {
  return max(0.0, min(x + 0.5 * fw, hw) - max(x - 0.5 * fw, -hw)) / fw;
}

// A saturated point on the colour wheel (hue in turns), evened out for perceived brightness so blues
// are not murky. Saturation is kept whatever the level: scaling a colour does not change its hue.
fn dc_wheel(h: f32, lvl: f32) -> vec3f {
  let c = hsv2rgb(vec3f(fract(h), 1.0, 1.0));
  return c * lvl * pow(0.4 / max(luma(c), 0.08), 0.55);
}

// Phase fronts. x follows an event count, each event easing in by smoothstep over 0.6 s (about a beat) (from rest, one unit per
// event, however close the events come). tau in [0, 0.5] is the point's arrival fraction. Returns
// (state, u): the lasting state steps by 1 per event, eased in as the front passes, and u is how far
// the front has gone past (0..1, at least 0.5 at rest). Continuous in x, so nothing can snap.
//
// Levels: c is the summed strength of the events before N = floor(x), ab packs the strengths of
// events N and N + 1. Returns (state, u, level): the state steps by each event's own strength (so it
// is continuous, and a faint hit leaves a faint change), and level is the strength of the front at u.
fn dc_phase(x: f32, tau: f32, c: f32, ab: f32) -> vec3f {
  let y = x - tau;
  let u = fract(y);
  let e = smoothstep(0.0, 0.5, u);
  let la = floor(ab) / 1000.0;
  let lb = fract(ab) / 0.999;
  if (floor(y) >= floor(x)) { return vec3f(c + la + lb * e, u, lb); }
  return vec3f(c + la * e, u, la);
}
// A soft bump on 0 < u < h: the glow at the front.
fn dc_bump(u: f32, h: f32) -> f32 { let s = sin(PI * min(u / h, 1.0)); return s * s; }
fn dc_tau(d: f32, k: f32, h: f32) -> f32 { return 0.5 * (1.0 - exp(-d * (0.7 + 0.6 * h) / k)); }

// Kick head by heat (1 = just lit): orange and yellow in the body, white only in the very front edge.
fn dc_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.35, 0.05) * h * 1.8 + vec3f(1.0, 0.6, 0.12) * h * h * 1.6 + vec3f(1.0, 0.9, 0.6) * pow(h, 12.0) * 1.2;
}

// One family of contour tubes: x is the position across the band (band units, centred on 0), fw the
// pixel footprint in band units, gdir the screen direction of increasing x, hueA the phase hue (turns).
// Returns (colour, coverage).
fn dc_lit(x: f32, fw: f32, id: f32, hueA: f32, gdir: vec2f, fam: f32, z: vec2f) -> vec4f {
  let h = hash12(vec2f(id + 0.613 * dc_oid, 17.0 + 5.0 * fam + 9.0 * F.seed));
  let xK = S.p[5].x; let xS = S.p[5].z; let xL = S.p[6].x; let lP = S.p[6].z;
  let cK = S.p[5].y; let cS = S.p[5].w; let cL = S.p[6].y;
  let abK = S.p[6].w; let abS = S.p[7].x; let abL = S.p[4].y;
  // Origins glide: kicks swing between two live zeros, snares come from a live pole, notes from a
  // point the pitch raises.
  let ko = mix(S.p[0].xy, S.p[1].xy, 0.5 + 0.5 * sin(xK * 1.5708));
  let so = S.p[0].zw;
  let mo = vec2f(0.8 * sin(xL * 2.1 + 0.9 * F.seed), 0.55 * lP);
  // Arrival fractions: each line catches the front with its own ragged delay.
  let pK = dc_phase(xK, dc_tau(length(z - ko), 1.6, h), cK, abK);
  // Off every tube (the widest a tube can be is hmx): only the kick head's soft halo reaches here, so
  // skip the rest of the work.
  let hmx = min(0.24, 0.011 * F.res.y * fw);
  let halo = exp(-max(abs(x) - hmx, 0.0) / max(0.08, fw * 3.0));
  if (abs(x) - 0.5 * fw >= hmx) { return vec4f(dc_fire(dc_bump(pK.y, 0.45)) * (0.15 * pK.z) * halo, 0.0); }
  let pS = dc_phase(xS, dc_tau(length(z - so), 2.0, fract(h * 5.1)), cS, abS);
  let pL = dc_phase(xL, dc_tau(length(z - mo), 2.2, fract(h * 3.9)), cL, abL);

  // Widths: the snare re-cuts them behind its front, each line easing toward its new width by the
  // snare's strength (the summed strength is continuous, so a faint snare moves them part of the way).
  let sN = floor(pS.x);
  let hw = mix(dc_width(id, sN, fam), dc_width(id, sN + 1.0, fam), smoothstep(0.0, 1.0, pS.x - sN));
  let hwc = min(hw, 0.011 * F.res.y * fw);
  let cov = select(0.0, dc_cover(x, hwc, fw), hwc > 0.0);

  // Glossy tube profile across the band.
  let t = clamp(x / max(hwc, 1e-4), -1.0, 1.0);
  let hgt = sqrt(max(1.0 - t * t, 0.0));
  let slope = t / max(hgt, 0.2);
  let nrm = normalize(vec3f(gdir * slope * 0.9, 1.0));
  let ld = normalize(vec3f(-0.45, 0.6, 0.75));
  let hv = normalize(ld + vec3f(0.0, 0.0, 1.0));

  // Colour: the phase, stepped by each kick behind its front; the melody note colour behind its front.
  let hS = pK.x;
  let base0 = dc_wheel(hueA + 0.23 * hS, 0.42);
  // Each note steps the note colour round the wheel; the lines take it as its front passes.
  let noteCol = dc_wheel(S.p[3].w + 0.5 + pL.x * 0.29, 0.45);
  let base = mix(base0, noteCol, 0.3 * min(pL.x, 1.0));

  let ndl = max(dot(nrm, ld), 0.0);
  let ndh = max(dot(nrm, hv), 0.0);
  let fres = pow(1.0 - nrm.z, 2.0);
  // The tube core is brighter in its own hue; no mixing toward white.
  var body = base * (0.3 + 1.0 * hgt) * (0.35 + 0.7 * ndl);
  body += dc_wheel(hueA + 0.22 + 0.23 * hS, 0.32) * fres * 0.7;
  // White only as a hairline specular glint.
  body += vec3f(1.0) * pow(ndh, 160.0) * 0.3;

  // Hot heads and embers, confined to the tubes they run along.
  // Each head swells and fades as its front passes (a soft edge).
  // Each glow carries its own hit's strength. The fire keeps its own colour ramp along the front; the
  // strength scales its brightness only.
  let gK = pK.z;
  let heat = dc_bump(pK.y, 0.45);
  let emb = dc_bump(pK.y, 0.5) * gK * step(0.6, hash12(vec2f(floor(x * 7.0), id)));
  let sh = dc_bump(pS.y, 0.45) * pS.z;
  let lh = dc_bump(pL.y, 0.45) * pL.z;
  let sCol = dc_wheel(S.p[3].w + 0.58, 0.8);
  body += dc_fire(heat) * (2.2 * gK) + dc_fire(0.3) * emb * 0.8 + sCol * sh * 4.0 + mix(base0 * 2.0, noteCol, 0.5) * lh * 7.0;
  // A soft glow spilling off the tube edges at the kick head, so the front reads as light, not only ink.
  // (the halo is set above, from the widest a tube can be)
  return vec4f(body * cov + dc_fire(heat) * (0.15 * gK) * halo, cov);
}

// The octave being drawn (its stable zoom id), so each octave cuts its own line widths and accents.
var<private> dc_oid: f32;

// One zoom octave: the whole woven grid of the field, sampled at zf (field units) with pf the pixel
// footprint in field units and rv the turn from field directions to the screen.
fn dc_octave(zf: vec2f, pf: f32, rv: mat2x2f) -> vec3f {
  let fl = dc_field(dc_warp(zf));
  let w = fl.w;
  let d = fl.d;
  let gm = max(length(d), 1e-9);
  let K = S.p[3].x; let N = floor(S.p[3].w);
  // Each octave (by its stable id) turns the wheel a little further, so a new octave arrives in new hues.
  let hue0 = S.p[3].w + 0.37 * dc_oid;

  // Screen gradients: grad Re w = conj(w'), grad Im w = i conj(w') (in field units, turned to screen).
  let gdL = rv * (vec2f(d.x, -d.y) / gm);
  let gdT = rv * (vec2f(d.y, d.x) / gm);
  let fwL = max(gm * pf * K, 1e-4);
  let fwT = max(gm * pf * N / TAU, 1e-4);

  // L family: contours of log|f|, one band per 1/K. The hue is arg f on the wheel plus the palette offset.
  let xu = w.x * K;
  let detL = 1.0 - smoothstep(0.1, 0.4, fwL);
  let detT = 1.0 - smoothstep(0.1, 0.4, fwT);
  // A family finer than the fade (detail below a few pixels) is not drawn at all.
  var cL = vec4f(0.0);
  if (detL > 0.0) { cL = dc_lit(fract(xu) - 0.5, fwL, floor(xu), hue0 + w.y / TAU, gdL, 0.0, zf); }
  // T family: contours of arg f, N per turn; the index is reduced mod N so the branch cut is seamless.
  let xv = w.y * N / TAU;
  let idT = fmod(floor(xv), N);
  var cT = vec4f(0.0);
  if (detT > 0.0) { cT = dc_lit(fract(xv) - 0.5, fwT, idT, hue0 + idT / N, gdT, 1.0, zf); }

  // Where the families cross, the stronger tube leads and half of the weaker one adds in.
  let aL = cL.rgb * detL;
  let aT = cT.rgb * detT;
  var col = max(aL, aT) + 0.5 * min(aL, aT);
  // Where both families are finer than a pixel the lines merge into a faint mean glow.
  col += dc_wheel(hue0 + w.y / TAU, 0.02) * (1.0 - detL) * (1.0 - detT);
  return col;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let zz = S.p[7].w;
  let va = S.p[7].z;
  let z = rot2(va) * q;
  let pz = 2.0 / F.res.y;   // one pixel in screen units
  // The zoom centre drifts slowly round the middle of the roots, driven by the zoom itself.
  let C = vec2f(0.4 * sin(0.31 * zz + 1.0), 0.28 * sin(0.23 * zz + 0.4));

  // Infinite zoom: the field at 3 octave scales round C, each octave turned by its own stable id so a
  // new octave is a new constellation, not a copy; finer octaves fade in as coarser ones leave.
  var ws = array<f32, 3>(0.0, 0.0, 0.0);
  var wsum = 0.0;
  for (var i = 0; i < 3; i++) { ws[i] = pow(zoomWeight(zz, i), 1.6); wsum += ws[i]; }
  var col = vec3f(0.0);
  for (var i = 0; i < 3; i++) {
    let wt = ws[i] / wsum;
    if (wt < 0.003) { continue; }
    let oid = zoomOctaveId(zz, i);
    dc_oid = oid;
    let s = zoomScale(zz, i) * 1.05;
    let th = TAU * hash12(vec2f(oid * 0.731, 4.1));
    let zf = C + rot2(th) * (z - C) * s;
    // Max, not sum: each octave keeps its own hue where it crosses another (no washed double exposure).
    col = max(col, min(1.0, 1.7 * wt) * dc_octave(zf, pz * s, rot2(-va - th)));
  }

  let vig = 1.0 - 0.35 * dot(uv - 0.5, uv - 0.5) * 2.0;
  col *= vig * 0.5;
  // Hue-preserving limit: a bright tube scales down rather than clipping toward white.
  let pk = max(col.r, max(col.g, col.b));
  col = col / max(pk, 1.0);
  return vec4f(col, 1.0);
}
`,
});
