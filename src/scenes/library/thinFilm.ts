import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Thin Film: a giant soap film filling the frame, with real thin-film interference.
 *
 * The film's thickness d (nm) is a sine-squared of a drainage phase: the phase is a domain-warped,
 * vortex-twisted coordinate measured along gravity, so its level sets are swirling drainage bands. The
 * film is black where it is thinnest (the integer phase lines), and every fringe is a contour of d.
 * Colour is the reflected interference of white light: for each wavelength the reflectance is
 * sin^2(2 pi n d / lambda) (n = 1.33), summed over seven spectral samples to RGB. The pixel average is
 * taken analytically (a sinc over the phase span of one pixel), so fringes that crowd below a pixel fade
 * to their mean instead of aliasing. The film is shaded from the thickness slope: a key light and a tight
 * highlight give the glossy look.
 *
 * Fronts travel along the bands, using the same arrival-time rule as marble-flow (the phase is the band
 * coordinate, so fire runs along a band and pays to cross to the next). Behind a front the film is left
 * changed for good, so the interference colours change:
 *  - kick: a white-hot front from a point; behind it the film steps to a new order (thicker or thinner
 *    alternately, so the colour always changes);
 *  - snare: a fast cool front across a line at a new angle; behind it the film steps thinner, and black
 *    patches open where it is thinnest;
 *  - melody: a front of light from a point placed by the note's pitch, while the drainage bands slide a
 *    step and the whole film's thickness glides to the note's scale (critically damped springs), so the
 *    fringes move and take new colours.
 * Nothing snaps: fronts cross the film in about 0.35 s, each point eases into its new
 * state from rest on a critically damped curve (settled in about 0.5 s), and the glows rise from rest
 * and cool within about 0.3 s.
 * The film is an endless zoom (RULES v8): the drainage phase is blended from three octaves of film
 * around a slowly drifting centre, each with its own swirls and fringes, sinking deeper with the travel
 * (a new octave every few seconds in a full mix, rushing on drops), so finer film keeps arriving as
 * the coarse fades out. The high end re-forms the finest octave most. Bright orders are capped in
 * luminance so the film stays deep inks on black instead of a pastel wash.
 * The morph moves the warps, the drainage density, the vortex, the thickness range (how many fringe
 * orders show) and the drainage angle. Drops and bass drive the drainage drift (the bands slide down
 * faster) and the swirl rate.
 *
 * DNA: 0 start (and vortex sense), 1 drainage angle, 2 noise time, 3 black-film width, 4 unused, 5 kick
 * ring angle, 6 snare and note placement, 7 thickness range and scale.
 */

const morph = new Morph(0.9);

/** An event front: origin, onset time, count and the event's strength (0..1, captured as it lands). */
type Ev = { x: number; y: number; t: number; n: number; l: number };
const NONE: Ev = { x: 0, y: 0, t: -99, n: 0, l: 0 };
const st = {
  seed: -1,
  lastT: -1,
  tr: 0,
  ph: 0,
  kicks: [] as Ev[],
  kickBase: 0,
  snare: NONE,
  note: NONE,
  // The previous note (its pitch and onset): its glow is still drawn, so a new note never cuts it off.
  prevPn: 0,
  prevT: -99,
  prevL: 0,
  pn: 0,
  scaleNew: 1,
  scale: 1,
  scaleV: 0,
  // Each note slides the drainage bands a step (a spring toward a target that steps with the notes).
  slide: 0,
  slideV: 0,
  slideT: 0,
  surge: 0,
  surgeV: 0,
};

/** The fine detail phase, glided (value, velocity), and its raw input last frame. */
const detailSm = { x: 0, v: 0, t: 0, raw: 0, a: 0.15, av: 0 };
/**
 * How strongly an event lands: its level (0..1) through a soft curve that rises at twice the
 * level's slope from zero and eases into 1, times the music's presence right now (the morph's drive,
 * loudness and bass, through a smooth S-curve that starts at 0 and reaches 1 at full drive: about 0.9 in a full mix, about 0.1 at a near-silent gap). A hit in near silence barely stirs the world, a hard hit
 * in a full mix lands fully, and there is no threshold anywhere in between.
 */
const presence = () => {
  const x4 = Math.max(0, morph.drive) ** 4;
  return (x4 * (1 + 0.55 ** 4)) / (x4 + 0.55 ** 4);
};
const strength = (lv: number) => lv * (2 - lv) * presence();
/**
 * The morph coordinates with its beat steps weighted by the music's presence: each frame's step
 * increment (already eased and scaled by the hit's level) counts by how present the music is right
 * now, so a hit in a near-silent gap barely moves the form. A cue reset (the steps jump back) resets them.
 */
const stepSm = { prev: new Float64Array(8), own: new Float64Array(8), out: new Float64Array(8) };
function presentAt(): Float64Array {
  const pr = presence();
  for (let i = 0; i < 8; i++) {
    const s = morph.at[i] - morph.flowAt[i];
    const d = s - stepSm.prev[i];
    stepSm.prev[i] = s;
    if (Math.abs(d) > 0.5) stepSm.own[i] = 0;
    else stepSm.own[i] += d * pr;
    // The flow runs at half rate: the zoom now carries the steady motion, so the beats stand out.
    stepSm.out[i] = 0.5 * morph.flowAt[i] + stepSm.own[i];
  }
  return stepSm.out;
}

/** One step of a critically damped spring toward `target`: starts from rest, never overshoots. */
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}

export default raymarchScene({
  meta: {
    id: 'thin-film',
    name: 'Thin Film',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.5 },
    genres: { ambient: 0.9, edm: 0.8, techno: 0.7, synthwave: 0.9, pop: 0.8, lofi: 0.8, jazz: 0.6, classical: 0.6, dubstep: 0.6, dnb: 0.6, hiphop: 0.6, rock: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    const a = presentAt();
    const aspect = 16 / 9;
    // Song time only detects seeks. The fronts' ages run on the world's paced clock (as the morph's
    // own event ages do), so they sweep faster in a driving song and slower in a calm one.
    const now = m.time;
    const clk = ctx.clock;
    const live = dt > 0;
    if (st.lastT < 0 || Math.abs(now - st.lastT - dt) > 0.5 || g[0] !== st.seed) {
      st.kicks = [];
      st.kickBase = 0;
      st.snare = NONE;
      st.note = NONE;
      st.pn = st.prevPn = 0;
      st.prevT = -99;
      st.prevL = 0;
      st.scaleNew = st.scale = 1;
      st.scaleV = st.surgeV = 0;
      st.slide = st.slideV = st.slideT = 0;
      st.surge = morph.surge;
      st.tr = morph.travel;
      st.ph = 0;
    }
    st.lastT = now;
    st.seed = g[0];

    // Drift: the drainage bands slide down with the travel, and a drop rushes them.
    const dTr = Math.min(Math.max(morph.travel - st.tr, 0), 1);
    st.tr = morph.travel;
    [st.surge, st.surgeV] = spring(st.surge, st.surgeV, morph.surge, 4, dt);
    const rush = 1 + 6 * st.surge;
    st.ph += dTr * 0.025 * rush;

    // Events. A front counts from its origin; the state is the sum of the strengths of the fronts that
    // have passed (a faint hit moves the film part of an order, a hard one a full order), so the older
    // fronts are folded into the base the moment a new one is lit (continuous, no pop).
    if (live && morph.kickAge === 0) {
      const k = morph.kicks;
      const ka = g[5] * 6.283 + 2.39996 * k;
      const kr = Math.sqrt(((k * 0.618034) % 1) * 0.7 + 0.15);
      if (st.kicks.length >= 2) st.kickBase = (st.kickBase + st.kicks[1].l) % 2;
      st.kicks.unshift({ x: Math.cos(ka) * kr * aspect * 0.42, y: Math.sin(ka) * kr * 0.42, t: clk, n: k, l: strength(morph.kickLevel) });
      st.kicks.length = Math.min(st.kicks.length, 2);
    }
    if (live && morph.snareAge === 0) {
      const n = morph.snares;
      st.snare = { x: 0.35 * Math.sin(n * 2.7 + g[6] * 6), y: 0.2 * Math.cos(n * 1.9), t: clk, n, l: strength(morph.snareLevel) };
    }
    if (live && morph.leadAge === 0) {
      const pn = Math.max(-1.2, Math.min(1.2, m.leadPitch)) / 1.2;
      const l = strength(morph.noteLevel);
      // Each note tunes the film to a new order: the count swings it alternately thinner and thicker, and pitch
      // adds to the swing. The note's strength sets how far toward that order it goes, and how far the bands slide.
      // Both re-tune the whole film, so they go by the strength squared: a faint note leaves the film
      // nearly as it was (its front stays a local ripple), a strong one in a full mix re-tunes it.
      const scaleFull = Math.min(1.15, Math.max(0.5, 1 + (morph.notes % 2 ? 0.1 : -0.25) + 0.2 * pn));
      st.scaleNew += l * l * (scaleFull - st.scaleNew);
      st.slideT += l * l * (pn >= 0 ? 1 : -1) * (0.2 + 0.1 * Math.abs(pn));
      st.prevPn = st.pn;
      st.prevT = st.note.t;
      st.prevL = st.note.l;
      st.pn = pn;
      st.note = { x: pn * aspect * 0.3, y: 0.22 * Math.sin(pn * 4.1 + 1.0), t: clk, n: morph.notes, l };
    }
    // The film's thickness scale glides to the note's from rest (critically damped, settled in about
    // 0.6 s), and the bands slide their step (settled in about 0.55 s).
    [st.scale, st.scaleV] = spring(st.scale, st.scaleV, st.scaleNew, 9, dt);
    [st.slide, st.slideV] = spring(st.slide, st.slideV, st.slideT, 10, dt);

    // A front's age (ms, integer part) with its strength packed in the fraction.
    const age = (e: Ev) => Math.floor(Math.min(99, Math.max(0, clk - e.t)) * 1000) + 0.98 * e.l;
    const k0 = st.kicks[0] ?? NONE;
    const k1 = st.kicks[1] ?? NONE;
    const sign = g[0] < 0.5 ? -1 : 1;
    const set = (i: number, x: number, y: number, z: number, w: number) => {
      p[4 * i] = x;
      p[4 * i + 1] = y;
      p[4 * i + 2] = z;
      p[4 * i + 3] = w;
    };
    // Form: warps, noise scale, drift phase.
    set(0, wave(a[0], 1.0, 2.6), wave(a[1], 0.25, 0.9), wave(a[2], 0.7, 1.4), st.ph + st.slide);
    // Vortex: centre, twist strength, size.
    set(1, wave(a[5], -0.45, 0.45), wave(a[4] * 0.6 + 0.8, -0.4, 0.4), sign * wave(a[4], 1.5, 4.0), wave(a[5] * 0.8 + 0.4, 0.06, 0.5));
    // Drainage bands per unit, thickness range (nm), black-film offset, drainage angle.
    // The thickness range is in tenths of a nm, with the black-film offset (over 0.3) in its fraction.
    // Fine detail (RULES v7): depth from the detail drive (thousandths), phase (turns, in the fraction)
    // flowing with the detail coordinates and stepping with each high note, backing chord and hat.
    // High notes carry the change (a turn of up to 3.5 radians each, by strength); the detail
    // coordinates, backing and hats barely drift it (drift raises the base motion and hides the notes).
    // Glided on a critically damped spring over the morph's own (quickest about 0.15 s after a note).
    const dT = 0.03 * morph.detailAt[0] + 0.02 * morph.detailAt[1] + 3.5 * morph.upperPhase + 0.25 * morph.backingPhase + 0.03 * morph.hatPhase;
    // Its changes count by the music's presence too (a jump means a new cue: start there).
    const dInc = dT - detailSm.raw;
    detailSm.raw = dT;
    if (Math.abs(dInc) > 20) [detailSm.x, detailSm.v, detailSm.t] = [dT, 0, dT];
    else detailSm.t += dInc * presence();
    [detailSm.x, detailSm.v] = spring(detailSm.x, detailSm.v, detailSm.t, 12, dt);
    // The detail depth follows the detail drive, weighted by the presence, gliding over a couple of seconds.
    [detailSm.a, detailSm.av] = spring(detailSm.a, detailSm.av, 0.05 + 0.95 * morph.detailDrive * presence(), 1.5, dt);
    const dPh = detailSm.x;
    const detail = Math.round(Math.min(1, Math.max(0, detailSm.a)) * 1000) + 0.98 * (dPh / 6.283185 - Math.floor(dPh / 6.283185));
    const range = Math.round(wave(a[6], 200, 300) * (0.9 + 0.2 * g[7]) * 10) + (0.98 * (0.08 + 0.12 * g[3])) / 0.3;
    set(2, wave(a[3], 1.1, 2.8), range, detail, g[1] * 6.283 + a[7]);
    // Lasting states: kick fronts passed (strength-weighted, wrapped on the triangle's period), zoom depth, note scale, noise time.
    // The zoom (RULES v8): octaves deep, growing with the travel, so a new octave of film arrives every
    // few seconds in a full mix, faster on a drop, slowly in long quiet.
    set(3, st.kickBase, morph.travel * 0.5 + g[4] * 17, st.scale, morph.travel * 0.012 + g[2] * 40);
    // Fronts: origin x, y, age and strength (strength 0 = none yet), count; the note's last slot holds the previous note.
    set(4, k0.x, k0.y, age(k0), k0.n);
    set(5, k1.x, k1.y, age(k1), k1.n);
    set(6, st.snare.x, st.snare.y, age(st.snare), st.snare.n);
    // The previous note packed in one float: pitch and strength in the integer part, its age (s) / 10 in the fraction.
    const prevCode = Math.round((st.prevPn + 1.5) * 100) * 16 + Math.round(st.prevL * 15) + Math.min(Math.max(0, clk - st.prevT), 9) / 10;
    set(7, st.note.x, st.note.y, age(st.note), prevCode);
  },
  wgsl: /* wgsl */ `
// The zoom (RULES v8): z in octaves, and the centre the zoom dives into, drifting slowly with z.
fn tf_z() -> f32 { return S.p[3].y; }
fn tf_c() -> vec2f { let z = tf_z(); return vec2f(0.32 * sin(z * 0.37 + F.seed * 6.0), 0.2 * cos(z * 0.29 + F.seed * 4.0)); }

// One zoom octave's drainage phase, sampled at the octave's scale s round the zoom centre: the warped,
// vortex-twisted coordinate along gravity (brought back to the screen over sqrt(s), so a finer octave
// bends the bands less but packs more of them), plus the octave's own swirl of film, a domain-warped
// height worth the same number of fringes at every scale. So each octave that arrives brings its own
// fine fringes and swirls, the film looks alike at every depth, and each octave has its own noise
// (seeded by its id) so the new detail is never a copy.
fn tf_oct(p: vec2f, i: i32, c: vec2f, dir: vec2f, fo: vec2f) -> f32 {
  let z = tf_z();
  let s = zoomScale(z, i) * 1.6;
  let id = zoomOctaveId(z, i);
  let fq = S.p[0].z;
  let nz = S.p[3].w + hash11(id * 1.618 + 0.37) * 48.0;
  let q = c + (p - c) * s;
  // The high end's offset moves through the octave's noise by s times as much, so it re-forms the
  // finest octave most and barely stirs the coarsest (continuous as an octave moves between slots).
  let qn = (q + fo * s) * fq;
  let a = noise4(vec3f(qn, nz)).xy;
  let rr = noise4(vec3f(qn + S.p[0].x * a + vec2f(5.2, 1.3), nz * 0.7 + 11.0));
  let w = q + S.p[0].y * rr.xy;
  let d = w - S.p[1].xy;
  let tw = rot2(S.p[1].z * exp(-dot(d, d) / S.p[1].w)) * d + S.p[1].xy;
  // Each octave drains at a slightly different angle, so the bands' direction wanders as you dive.
  let dr = rot2(0.35 * sin(id * 2.39996)) * dir;
  return dot(tw - c, dr) * inverseSqrt(s) + 0.4 * rr.z;
}

// The drainage phase: the zoom octaves blended (the weights sum to 1), times the bands per unit, plus
// the drift. The finest structure belongs to the high end (RULES v7): an offset into each octave's noise
// whose depth follows the detail drive and whose angle turns with the high notes, scaled by the
// octave's scale so each high note re-forms the finest swirls of film where the coarse ones hold.
fn tf_phase(p: vec2f) -> f32 {
  let c = tf_c();
  let dir = vec2f(cos(S.p[2].w), sin(S.p[2].w));
  let dAmp = floor(S.p[2].z) / 1000.0;
  let dPh = fract(S.p[2].z) / 0.98 * TAU;
  let fo = (0.04 + 0.2 * dAmp) * vec2f(cos(dPh), sin(dPh));
  let z = tf_z();
  var ph = 0.0;
  for (var i = 0; i < 3; i++) { ph += zoomWeight(z, i) * tf_oct(p, i, c, dir, fo); }
  return ph * S.p[2].x + S.p[0].w;
}
// The band coordinate of a front's origin: the drainage ramp alone (the arrival cost only needs it roughly).
fn tf_ramp(p: vec2f) -> f32 { return dot(p - tf_c(), vec2f(cos(S.p[2].w), sin(S.p[2].w))) * S.p[2].x + S.p[0].w; }

// Film thickness (nm). The drainage phase gives v = sin^2 (zero on the black lines). Where v is below the
// black threshold b the film is black. Above it the thickness starts at the second order (140 nm, past the
// white and silver first order) and rises by a span that the morph sets and the beats scale. So the film
// only ever sits in the saturated orders, gold, red, magenta, blue, green, never in the white or pastel ones.
fn tf_d(ph: f32, mul: f32) -> f32 {
  let s = sin(PI * ph);
  let v = s * s;
  let b = 0.05 + fract(S.p[2].y) / 0.98 * 0.3;
  let t = clamp((v - b) / (1.0 - b), 0.0, 1.0);
  let edge = smoothstep(b, b + 0.03, v);
  return edge * (140.0 + floor(S.p[2].y) / 10.0 * t * mul);
}

// Reflected intensity of one wavelength (nm) from a film of thickness d (nm), box-filtered over a pixel
// across which the thickness changes by gd (nm). The reflectance is sin^2(2 pi n d / lambda); its pixel
// average is 0.5 - 0.5 cos(2 phi) sinc(W), with W the phase span of the pixel.
fn tf_one(d: f32, gd: f32, lam: f32) -> f32 {
  let f = TAU * 1.33 * d / lam;
  let w = TAU * 1.33 * gd / lam;
  let s = select(sin(w) / max(w, 1e-5), 1.0, w < 1e-3);
  return 0.5 - 0.5 * cos(2.0 * f) * s;
}

// Film colour as three narrow sensor bands (red, green, blue, two wavelengths each): a flat spectrum gives
// white, and the narrow bands keep each order saturated. Thin films go black, grey, yellow, red, violet,
// blue, green as they thicken.
fn tf_film(d: f32, gd: f32) -> vec3f {
  let r = 0.5 * (tf_one(d, gd, 630.0) + tf_one(d, gd, 650.0));
  let g = 0.5 * (tf_one(d, gd, 535.0) + tf_one(d, gd, 555.0));
  let b = 0.5 * (tf_one(d, gd, 445.0) + tf_one(d, gd, 465.0));
  let v = vec3f(r, g, b);
  // More chroma still, so the orders read as saturated inks rather than pastel.
  let c = max(mix(vec3f(luma(v)), v, 1.8), vec3f(0.0)) * 0.45;
  // The bright orders (white-gold, yellow, green) are capped in luminance, never the dim ones: broad
  // bright film blooms over the black film and the output's exposure and tone curve wash it to a
  // pastel, so every order stays a deep ink and the black film stays black.
  return c * min(1.0, 0.2 / max(luma(c), 1e-4));
}

// Arrival cost of a front at band coordinate x from an origin at band coordinate xo and screen distance d:
// it runs along its band and pays to cross to the next band (slower through the black lines).
fn tf_arrive(x: f32, xo: f32, d: f32, lag: f32, jag: f32) -> f32 {
  return (0.12 * abs(x - xo) + 0.42 * d) * lag + jag;
}

// A critically damped ease from rest, b seconds after a front arrives: no jump in value or speed, 90%
// there by 0.35 s and settled by about 0.5 s (the whole film recolours, so it glides a little longer).
fn tf_ease(b: f32) -> f32 { let u = max(b, 0.0) / 0.09; return 1.0 - (1.0 + u) * exp(-u); }
// A slower ease for the snare's step, which recolours the whole film: settled in about 0.8 s.
fn tf_easeS(b: f32) -> f32 { let u = max(b, 0.0) / 0.15; return 1.0 - (1.0 + u) * exp(-u); }
// A front's glow: rises from rest, peaks tau after the front arrives and fades over a few tau.
fn tf_pulse(b: f32, tau: f32) -> f32 { let u = max(b, 0.0) / tau; return u * u * exp(2.0 - 2.0 * u); }
// A front slot's age (s), and its strength (0..1) packed in the age's fraction.
fn tf_age(v: vec4f) -> f32 { return floor(v.z) / 1000.0; }
fn tf_lv(v: vec4f) -> f32 { return sat(fract(v.z) / 0.98); }

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let sp = (uv - 0.5) * vec2f(F.aspect, 1.0);
  let px = 1.0 / F.res.y;
  let e = px * 1.5;
  let K = 6.0;
  let ph0 = tf_phase(sp);

  // Band coordinate and the fire's lag: fire is quicker mid-band than at the black lines.
  let x = ph0 * K;
  let fr = x - floor(x);
  let cond = 1.0 - abs(fr - 0.5) * 2.0;
  let lag = 1.25 - 0.4 * smoothstep(0.2, 0.9, cond);
  let jag = 0.05 * hash12(vec2f(floor(x), F.seed * 31.0));

  // Kick fronts: from a point, two live. h is the seconds since the front reached this point (the
  // fronts cover 8 cost units a second, so the recolouring travels instead of switching at once).
  let K0 = S.p[4];
  let K1 = S.p[5];
  let l0 = tf_lv(K0);
  let l1 = tf_lv(K1);
  let h0 = tf_age(K0) - tf_arrive(x, tf_ramp(K0.xy) * K, length(sp - K0.xy), lag, jag) / 8.0;
  let h1 = tf_age(K1) - tf_arrive(x, tf_ramp(K1.xy) * K, length(sp - K1.xy), lag, jag) / 8.0;
  let cK = S.p[3].x + tf_ease(h0) * l0 + tf_ease(h1) * l1;

  // Snare front: a line across the film at a new angle each time.
  let SN = S.p[6];
  let sa = SN.w * 1.94 + F.seed * 6.0;
  let sn = vec2f(cos(sa), sin(sa));
  let lS = tf_lv(SN);
  let hs = tf_age(SN) - tf_arrive(x, tf_ramp(SN.xy) * K, abs(dot(sp - SN.xy, sn)), lag, jag * 0.6) / 16.0;

  // Melody front: light from the pitch-placed emitter. The thickness scale glides on the TS side.
  let NT = S.p[7];
  let de = length(sp - NT.xy);
  let lN = tf_lv(NT);
  let hn = tf_age(NT) - tf_arrive(x, tf_ramp(NT.xy) * K, de, lag, jag * 1.4) / 12.0;
  let scale = S.p[3].z;

  // The kicks step the thickness span (never the floor): a triangle wave of their strength-weighted
  // total, so each kick moves the film toward a new saturated order, bounded. The snare's front swells
  // the span through the next orders as it passes (by its strength) and lets it settle back at rest, so
  // the film's resting colours stay in the saturated orders.
  let mK = 0.75 + 0.5 * abs(fract(cK * 0.5) * 2.0 - 1.0);
  let mS = 0.775 + 0.225 * lS * sin(PI * tf_easeS(hs));
  let mul = mK * mS * scale;
  let d0 = tf_d(ph0, mul);
  let grad = vec2f(tf_d(tf_phase(sp + vec2f(e, 0.0)), mul) - d0, tf_d(tf_phase(sp + vec2f(0.0, e)), mul) - d0) / e;
  let gd = length(grad) * px;
  let film = tf_film(d0, gd);

  // Glossy shading from the thickness slope.
  let N = normalize(vec3f(-grad * 0.00008, 1.0));
  let ld = normalize(vec3f(-0.4, 0.55, 0.75));
  let hv = normalize(ld + vec3f(0.0, 0.0, 1.0));
  let dif = 0.6 + 0.4 * max(dot(N, ld), 0.0);
  let spc = pow(max(dot(N, hv), 0.0), 60.0);
  var col = film * (dif + spc * 0.6);

  // Fronts brighten the film in its own interference colours (nothing added on top, so the black film
  // stays black). Kick and snare glows are brief; the note's lasts a little longer.
  // Glows rise from rest over 0.05-0.07 s and cool over a few times that (short, so the film keeps its inks).
  let fire = tf_pulse(h0, 0.08) * l0 + tf_pulse(h1, 0.08) * l1;
  let sparkS = tf_pulse(hs, 0.06) * lS;
  // The previous note's front, from its own origin, so its glow fades instead of being cut off.
  let pKey = floor(NT.w);
  let pnP = floor(pKey / 16.0) / 100.0 - 1.5;
  let lNp = (pKey - 16.0 * floor(pKey / 16.0)) / 15.0;
  let oP = vec2f(pnP * 1.7777778 * 0.3, 0.22 * sin(pnP * 4.1 + 1.0));
  let hnP = fract(NT.w) * 10.0 - tf_arrive(x, tf_ramp(oP) * K, length(sp - oP), lag, jag * 1.4) / 12.0;
  // Each note's light is a local ripple round its emitter (fading with distance), not a wash over the film.
  let sparkN = tf_pulse(hn, 0.07) * lN * exp(-de * de * 5.0) + tf_pulse(hnP, 0.07) * lNp * exp(-dot(sp - oP, sp - oP) * 5.0);
  col *= 1.0 + 2.0 * fire + 0.7 * sparkS + 2.2 * sparkN;
  // The snare also leaves a brief cool sheen on the lit film (none on the black film).
  col += vec3f(0.25, 0.6, 1.0) * sparkS * 0.22 * sat(luma(film) * 3.0);

  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.3 * max(pk - 0.9, 0.0));
  return vec4f(col, 1.0);
}
`,
});
