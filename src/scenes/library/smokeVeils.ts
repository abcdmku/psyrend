import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Smoke Veils: layered, translucent silk-smoke veils (ref10) drawn as fine glowing contour lines of
 * a domain-warped field (a fold field bent toward arcs by the ring mix, plus whorls of its own),
 * drawn as an endless zoom: three octaves of it round a slowly drifting centre, the finer fading in
 * as the view sinks, so new fine veils keep emerging. One hue gradient spans the frame: teal at the
 * bottom left, amber at the top right. Lines are pixel-width and anti-aliased from each octave's own
 * screen gradient, and fade to their mean glow where they pack tighter than four pixels.
 *
 * Music:
 *  - morph: the two warps, line density, fold angle and ring mix step to new values each phrase; the
 *    zoom sinks on `morph.travel` (which rushes with the bass and a drop).
 *  - kick: a fire from a point on a golden-angle walk, white to amber. It runs along the lines first
 *    and crosses to other lines at a cost; each line it passes takes a small hue step and slides
 *    across, and both stay.
 *  - high notes: each turns the phase of the finest warp, re-forming the fine ripples of every line.
 *  - snare: an electric front from a plane through its point; behind it the lines are re-dealt in
 *    width, and its sparks are cool cyan.
 *  - melody: a glow in the note's colour from a pitch-placed emitter; the melody lines glide to the
 *    note's colour on a spring and brighten while it sounds, and the smoke rolls over (its noise time
 *    glides a step forward).
 * Nothing snaps: fronts sweep the frame in about 0.15 s, each point eases into its new
 * state from rest on a critically damped curve (settled in about 0.3 s), and every glow rises from
 * rest and cools within about 0.3 s.
 *
 * DNA: 0 start, 1 fold angle, 2 note hue, 3 hue base, 4 kick ring angle, 5 snare angle, 6 zoom
 * start, 7 scale and density.
 */

/** An event front: origin, onset time, count, lasting value and the event's strength (0..1, captured as it lands). */
type Front = { x: number; y: number; t: number; n: number; d: number; l: number };
const NONE: Front = { x: 0, y: 0, t: -99, n: 0, d: 0, l: 0 };

const morph = new Morph(0.9);
let seed = -1;
let lastT = -1;
let kicks: Front[] = [];
let kickCum = 0;
let snare: Front = NONE;
// Lasting line-width phase of the snares already folded in (each adds its strength).
let snareBase = 0;
let note: Front & { hue: number } = { ...NONE, hue: 0 };
// The previous note (pitch and onset): its glow is still drawn, so a new note never cuts it off.
let notePitch = 0;
let prevPitch = 0;
let prevNoteT = -99;
let prevNoteL = 0;
// Springs (value, velocity): the melody lines' hue and their brightness while a note sounds.
const mel = { hue: 0, hueV: 0, glow: 0, glowV: 0, z: 0, zV: 0, zT: 0 };

/** The fine detail phase, glided (value, velocity), and its raw input last frame. */
const detailSm = { x: 0, v: 0, t: 0, raw: 0, a: 0.15, av: 0 };
/**
 * How strongly an event lands: its level (0..1) squared (it already carries the passage's loudness), times the music's presence right now (the morph's drive,
 * loudness and bass, through a smooth S-curve that starts at 0 and reaches 1 at full drive: about 0.9 in a full mix, about 0.1 at a near-silent gap). A hit in near silence barely stirs the world, a hard hit
 * in a full mix lands fully, and there is no threshold anywhere in between.
 */
const presence = () => {
  const x4 = Math.max(0, morph.drive) ** 4;
  return (x4 * (1 + 0.55 ** 4)) / (x4 + 0.55 ** 4);
};
// (The morph's levels already carry how loud the passage is, so the level is squared here: a
// faint intro hit or note stays a ripple while a hard hit in a full mix lands almost fully.)
const strength = (lv: number) => lv * lv * presence();
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
    // The flow runs at half pace (the zoom now carries the steady motion); the beat steps stay full.
    stepSm.out[i] = 0.3 * morph.flowAt[i] + stepSm.own[i];
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

const SHADER = /* wgsl */ `
// Hue of the veil at a turn (teal at the base hue, amber 0.42 turns below it).
fn sv_hue(h: f32, s: f32, v: f32) -> vec3f { return hsv2rgb(vec3f(fract(h), s, v)); }

// A critically damped ease from rest, b seconds after a front arrives: no jump in value or speed, 90%
// there by 0.2 s and settled by about 0.3 s.
fn sv_ease(b: f32) -> f32 { let u = max(b, 0.0) / 0.05; return 1.0 - (1.0 + u) * exp(-u); }
// A front's hot edge: rises from rest, peaks 50 ms after it arrives and has cooled by about 0.25 s.
fn sv_edge(b: f32) -> f32 { let u = max(b, 0.0) / 0.05; return u * u * exp(2.0 - 2.0 * u); }
// An event slot with its age unpacked (z, seconds), and its strength (0..1, packed in the age's fraction).
fn sv_ev(v: vec4f) -> vec4f { return vec4f(v.xy, floor(v.z) / 1000.0, v.w); }
fn sv_lv(v: vec4f) -> f32 { return sat(fract(v.z) / 0.98); }

// Infinite zoom (RULES v8): the veils are drawn at three octave scales round a slowly drifting
// centre, and the zoom level z (S.p[2].y, octaves) grows with the morph's travel, so the view keeps
// sinking into finer veils. Everything an octave owns comes from its scale and its stable id, never
// from its slot, so nothing pops as one octave hands over to the next.
fn sv_centre(z: f32) -> vec2f {
  return vec2f(0.3 * sin(z * 0.37 + F.seed * 6.0), 0.2 * cos(z * 0.29 + F.seed * 4.0));
}
// One octave's mapping: the view turns and scales, then zooms by s round the centre; each octave sits
// in its own region of the noise (off), so a new octave is never a copy of the last.
fn sv_coord(sp: vec2f, c: vec2f, s: f32, off: vec2f) -> vec2f {
  let v = S.p[2];
  let cs = cos(v.x); let sn = sin(v.x);
  let r = vec2f(cs * sp.x - sn * sp.y, sn * sp.x + cs * sp.y) * floor(v.w) / 1000.0;
  return (r - c) * s + off;
}

// One octave's field: a twice domain-warped point, measured as folds (dot) or arcs (rings round the
// zoom centre), plus a height of its own (whorls at this octave's scale), so every octave brings its
// own veils rather than magnifying the last.
fn sv_field(q: vec2f, off: vec2f, ho: f32) -> f32 {
  let P = S.p[0];
  let Q = S.p[1];
  let z = Q.w + ho * 48.0;
  let fq = P.z;
  let n1 = noise4(vec3f(q * fq, z)).xy;
  let n2 = noise4(vec3f(q * fq + P.x * n1 + vec2f(5.2, 1.3), z * 0.7 + 11.0));
  let w0 = q + P.y * n2.xy;
  // The finest warp belongs to the high end (RULES v7): its depth follows the detail drive, and its
  // noise is sampled round a circle whose angle turns with the high notes, so each one re-forms the
  // fine ripples of every line.
  let dAmp = floor(S.p[3].z) / 1000.0;
  let dPh = fract(S.p[3].z) / 0.98 * TAU;
  let w = w0 - off + (0.035 + 0.14 * dAmp) * noise4(vec3f(w0 * 3.7 + 0.9 * vec2f(cos(dPh), sin(dPh)), z * 1.9 + 3.0)).xy;
  let a = Q.x + (ho - 0.5) * 0.8;
  let rc = Q.z * vec2f(cos(Q.x * 0.6 + 1.3), sin(Q.x * 0.6 + 1.3));
  return mix(dot(w, vec2f(cos(a), sin(a))), length(w - rc), Q.y) + S.p[2].z * n2.z;
}
// The same field without its warps: a cheap stand-in for where a front's origin sits on the lines.
fn sv_fieldCheap(q: vec2f, off: vec2f, ho: f32) -> f32 {
  let Q = S.p[1];
  let w = q - off;
  let a = Q.x + (ho - 0.5) * 0.8;
  let rc = Q.z * vec2f(cos(Q.x * 0.6 + 1.3), sin(Q.x * 0.6 + 1.3));
  return mix(dot(w, vec2f(cos(a), sin(a))), length(w - rc), Q.y);
}

// Seconds since the front reached line xl of an octave (negative before). The fire runs along the line
// cheaply (0.06 per line at the coarse scale) and crosses the screen at 0.42 per unit, with a ragged
// per-line lag, at v cost units per second. Lines count at the coarse scale, so every octave burns alike.
fn sv_pass(Fr: vec4f, d: f32, v: f32, c: vec2f, s: f32, off: vec2f, ho: f32, xl: f32, K: f32, lag: f32, jag: f32) -> f32 {
  let xo = sv_fieldCheap(sv_coord(Fr.xy, c, s, off), off, ho) * K;
  return Fr.z - ((0.06 * abs(xl - xo) / s + 0.42 * d) * lag + jag) / v;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let sp = (uv - 0.5) * vec2f(F.aspect, 1.0);
  let K0 = sv_ev(S.p[4]); let K1 = sv_ev(S.p[5]); let SN = sv_ev(S.p[6]); let NT = sv_ev(S.p[7]);
  let lK0 = sv_lv(S.p[4]); let lK1 = sv_lv(S.p[5]); let lS = sv_lv(S.p[6]); let lN = sv_lv(S.p[7]);
  let snN = floor(SN.w);
  // Lasting line-width phase of the folded snares (the latest one adds its strength behind its front).
  let snBase = fract(SN.w) / 0.98 * 3.0;
  let kickHue = S.p[3].x;
  let hueMel = S.p[3].y;
  let melGlow = S.p[3].w;
  let hueB = 0.47 + 0.1 * fract(S.p[2].w) / 0.98;
  // Hue gradient across the frame: teal bottom left, amber top right.
  let g = sat(0.5 + 0.8 * (uv.x - uv.y));
  let sa = snN * 1.94 + F.seed * 6.0;
  let sn = vec2f(cos(sa), sin(sa));
  let dK0 = length(sp - K0.xy);
  let dK1 = length(sp - K1.xy);
  let dS = abs(dot(sp - SN.xy, sn));
  let dN = length(sp - NT.xy);
  // The previous note: pitch and strength in the integer part of NT.w, its age / 10 in the fraction.
  let pKey = floor(NT.w);
  let pP = floor(pKey / 16.0) / 100.0 - 2.0;
  let lNp = (pKey - 16.0 * floor(pKey / 16.0)) / 15.0;
  let oP = vec2f(pP * F.aspect * 0.32, 0.22 * sin(pP * 4.1 + 1.0));
  let NTp = vec4f(oP, fract(NT.w) * 10.0, 0.0);
  let dNp = length(sp - oP);

  // Haze: a slow smooth veil of colour behind the lines, deep enough to leave real darks.
  let smoke = noise4(vec3f(sp * 0.9, S.p[1].w * 0.5 + 3.0)).x;
  var col = mix(sv_hue(hueB, 0.85, 0.008), sv_hue(hueB - 0.42, 0.9, 0.011), g) * (0.6 + 0.4 * smoke);

  let zz = S.p[2].y;
  let c = sv_centre(zz);
  let K = S.p[0].w;
  // Sharpened octave weights (squared, renormalised): one octave leads at a time while the next
  // fades in, so the frame reads as one depth of veils rather than a mesh of three.
  let w0z = zoomWeight(zz, 0); let w1z = zoomWeight(zz, 1); let w2z = zoomWeight(zz, 2);
  let wn = 1.0 / (w0z * w0z + w1z * w1z + w2z * w2z);
  for (var i = 0; i < 3; i++) {
    let s = 1.6 * zoomScale(zz, i);
    let wz0 = zoomWeight(zz, i);
    let wz = wz0 * wz0 * wn;
    let oid = zoomOctaveId(zz, i);
    let ho = hash11(oid * 7.31 + F.seed * 13.0);
    let ho2 = hash11(oid * 3.17 + 5.0 + F.seed * 7.0);
    let off = 40.0 * vec2f(ho, ho2);
    let q = sv_coord(sp, c, s, off);
    let x0 = sv_field(q, off, ho) * K;
    // Anti-aliasing from this octave's own screen gradient (band units per pixel).
    let fwpx = max(length(vec2f(dpdx(x0), dpdy(x0))), 1e-5);
    let detail = 1.0 - smoothstep(0.18, 0.3, fwpx);
    // The fronts follow the unshifted lines (their ragged lag and jag dealt per line).
    let xl0 = floor(x0 + 0.5);
    let lag = 0.8 + 0.4 * hash12(vec2f(xl0, 17.0 + 5.0 * ho + 31.0 * F.seed));
    let jag = 0.05 * hash12(vec2f(xl0 * 1.3, 2.0 + 3.0 * ho + 7.0 * F.seed));

    // Fronts on this line: seconds since each arrived (a front that has not fired is far in the past
    // and has long finished). Each point eases into its new state from rest, settling in about 0.3 s.
    let h0 = sv_pass(K0, dK0, 14.0, c, s, off, ho, xl0, K, lag, jag);
    let h1 = sv_pass(K1, dK1, 14.0, c, s, off, ho, xl0, K, lag, jag);
    let hs = sv_pass(SN, dS, 16.0, c, s, off, ho, xl0, K, lag, jag * 0.6);
    let hn = sv_pass(NT, dN, 12.0, c, s, off, ho, xl0, K, lag, jag * 1.4);
    let hnP = sv_pass(NTp, dNp, 12.0, c, s, off, ho, xl0, K, lag, jag * 1.4);
    let p0 = step(K0.z, 50.0) * sv_ease(h0);
    let p1 = step(K1.z, 50.0) * sv_ease(h1);
    let ps = step(SN.z, 50.0) * sv_ease(hs);

    // Lasting states: line widths re-dealt behind the snares (each line's width phase turns at its own
    // whole-number rate, by the snare's strength), hue stepped behind the kicks.
    // Each kick's fire also slides the veils: behind it every line shifts across by the kick's step
    // (a lasting move, eased in from rest as the front passes), so the smoke visibly re-folds.
    let kh = kickHue + S.p[4].w * p0 + S.p[5].w * p1;
    let x = x0 + 2.5 * kh;
    let xl = floor(x + 0.5);                       // the line this pixel is nearest to
    let dPx = abs(x - xl) / fwpx;                  // pixels to that line
    let hq = hash12(vec2f(xl, 17.0 + 5.0 * ho + 31.0 * F.seed));
    let hq2 = hash12(vec2f(xl * 1.3, 2.0 + 3.0 * ho + 7.0 * F.seed));
    let wr = 1.0 + floor(3.0 * hash12(vec2f(xl, ho * 3.1 + 13.0 * F.seed)));
    let wph = TAU * hash12(vec2f(xl * 0.7, ho * 5.3 + 9.0 + 13.0 * F.seed));
    let lw = mix(0.6, 2.4, 0.5 + 0.5 * sin(wph + wr * (TAU / 3.0) * (snBase + lS * ps))) * clamp(pow(2.4 / s, 0.35), 0.6, 1.6);
    let mel = step(0.7, hash12(vec2f(xl, 4.1 + ho * 9.0)));
    // Two hue families: the near half of the frame is teal to green, the far half turned about 140
    // degrees round the wheel (amber to orange). Each octave nudges its own family a little.
    let gl = sat(g + 0.03 * (hq - 0.5));
    let famF = smoothstep(0.42, 0.58, gl);
    let hNear = hueB - 0.14 * gl;
    let hFar = hueB - 0.39 - 0.14 * gl;
    var hL = mix(hNear, hFar, famF) + kh + 0.02 * (hq2 - 0.5) + 0.08 * (ho - 0.5);
    hL = mix(hL, hueMel, mel);

    // Line body: a white-hot core in a neon ink, and mean glow where lines pack too tightly.
    let base = sv_hue(hL, 0.95, 1.0);
    let lum = mix(0.55, 1.0, hq);
    let core = 1.0 - smoothstep(lw - 0.7, lw + 0.7, dPx);
    let glow = 0.1 * exp(-dPx / 2.0) + 0.012 * exp(-dPx / 9.0);
    // Melody lines glow brighter while they carry the note.
    var lc = base * (core * 0.9 + glow) * lum * detail * (1.0 + 3.0 * mel * melGlow);
    lc += vec3f(1.0) * core * 0.03 * detail;
    lc += base * 0.04 * (1.0 - detail);
    // Translucent veil between the lines: a low band shaped by the same field, brighter where the
    // lines bunch at the folds, faded out before the band period aliases.
    let vband = 0.5 - 0.5 * cos(TAU * x);
    let vfade = 1.0 - smoothstep(0.2, 0.35, fwpx);
    let bunch = smoothstep(0.08, 0.3, fwpx);
    lc += base * 0.06 * vband * vfade * (0.25 + bunch) * lum;

    // Fires on the lines: the hot edge of each front, then embers, faded with the front's age.
    // Each edge brightens the line in its own hue plus the event's colour, so the veils stay saturated.
    // Kick and snare glows are brief (they have faded before a following note); the note's lasts longer.
    let fk = sv_edge(1.4 * h0) * step(K0.z, 50.0) * lK0 + sv_edge(1.4 * h1) * step(K1.z, 50.0) * lK1;
    let ue = max(h0, 0.0) / 0.15;
    let ek0 = ue * ue * exp(2.0 - 2.0 * ue) * step(K0.z, 50.0) * lK0;
    let onL = (core + 0.5 * glow) * detail;
    // The kick's fire also warms each line's halo and the veil beside it (still riding the line).
    let onK = (core + 1.5 * glow + 0.08 * vband * vfade) * detail;
    lc += ((base * 1.0 + vec3f(1.0, 0.45, 0.1) * 0.6) * fk + vec3f(1.0, 0.3, 0.05) * ek0 * 0.6) * onK;
    let sparkS = sv_edge(1.4 * hs) * step(SN.z, 50.0) * lS;
    lc += (base * 1.2 + sv_hue(hueB + 0.25, 0.85, 1.0) * 1.0) * sparkS * onL;
    let sparkN = sv_edge(hn) * step(NT.z, 50.0) * lN + sv_edge(hnP) * lNp;
    lc += sv_hue(hueMel, 0.9, 1.0) * sparkN * 4.5 * onL;

    // Octaves fade in as they arrive and out as they grow coarse (the weights sum to 1).
    col += lc * wz * 1.3;
  }
  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.3 * max(pk - 0.9, 0.0));
  return vec4f(col, 1.0);
}
`;

export default raymarchScene({
  meta: {
    id: 'smoke-veils',
    name: 'Smoke Veils',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.4 },
    genres: { ambient: 0.9, lofi: 0.8, jazz: 0.7, classical: 0.6, pop: 0.6, synthwave: 0.6, edm: 0.5, techno: 0.5, dubstep: 0.5, hiphop: 0.5, rock: 0.4 },
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
    if (lastT < 0 || Math.abs(m.time - lastT - dt) > 0.5 || g[0] !== seed) {
      kicks = [];
      kickCum = 0;
      snare = NONE;
      snareBase = 0;
      note = { ...NONE, hue: g[2] + 0.5 };
      notePitch = prevPitch = 0;
      prevNoteT = -99;
      prevNoteL = 0;
      mel.hue = note.hue;
      mel.hueV = mel.glow = mel.glowV = 0;
      mel.z = mel.zV = mel.zT = 0;
    }
    lastT = m.time;
    seed = g[0];
    const now = m.time;
    const live = dt > 0;
    if (live && morph.kickAge === 0) {
      const k = morph.kicks;
      const ka = g[4] * 6.283 + 2.39996 * k;
      const kr = Math.sqrt(((k * 0.618034) % 1) * 0.7 + 0.15);
      // Each kick steps the line hue by a small random amount, pulled back toward the base hue, in
      // proportion to its strength: a faint kick nudges the hue, a hard one takes the full step.
      const l = strength(morph.kickLevel);
      const r = ((Math.sin(k * 12.9898 + g[0] * 78.233) * 43758.5453) % 1 + 1) % 1;
      const d = l * ((k % 2 ? 1 : -1) * (0.1 + 0.08 * r) - 0.15 * kickCum);
      kickCum += d;
      kicks.unshift({ x: Math.cos(ka) * kr * aspect * 0.42, y: Math.sin(ka) * kr * 0.42, t: now, n: k, d, l });
      kicks.length = Math.min(kicks.length, 2);
    }
    if (live && morph.snareAge === 0) {
      const n = morph.snares;
      // The previous snare's width step is folded into the lasting phase (its front has long passed).
      snareBase = (snareBase + snare.l) % 3;
      snare = { x: 0.35 * Math.sin(n * 2.7 + g[5] * 6), y: 0.2 * Math.cos(n * 1.9), t: now, n, d: 0, l: strength(morph.snareLevel) };
    }
    if (live && morph.leadAge === 0) {
      const pitch = Math.max(-1.2, Math.min(1.2, m.leadPitch));
      const l = strength(morph.noteLevel);
      // The note's colour, reached in proportion to its strength (the short way round the wheel).
      const full = g[2] + 0.5 + morph.notes * 0.29 + pitch * 0.25 + (m.centroid - 0.5) * 0.2;
      const dh = full - note.hue - Math.round(full - note.hue);
      const hue = note.hue + l * dh;
      prevPitch = notePitch;
      prevNoteT = note.t;
      prevNoteL = note.l;
      notePitch = pitch;
      // Each note also steps the smoke's noise time, so the veils roll over into a new shape (by its
      // strength, so a faint motif barely stirs the whole field and a full lead rolls it).
      mel.zT += l * (0.12 + 0.06 * Math.abs(pitch));
      note = { x: pitch * aspect * 0.32, y: 0.22 * Math.sin(pitch * 4.1 + 1.0), t: now, n: morph.notes, d: 0, hue, l };
    }
    // The melody lines glide to the note's hue from rest (a critically damped spring, settled in about
    // 0.3 s), and brighten while the note sounds (the spring smooths both the rise and the fall).
    [mel.hue, mel.hueV] = spring(mel.hue, mel.hueV, note.hue, 20, dt);
    [mel.z, mel.zV] = spring(mel.z, mel.zV, mel.zT, 16, dt);
    [mel.glow, mel.glowV] = spring(mel.glow, mel.glowV, note.l * Math.exp(-Math.min(morph.leadAge, 9) / 0.2), 20, dt);

    const tr = morph.travel;
    // Form (S.p[0..1]): two warps, the noise frequency, line density; fold angle, ring mix, ring
    // distance, noise time. Every phrase moves each of these to a wide new range.
    // The coordinates run at 0.6 of the morph's pace: the base motion stays low, so the beats stand out.
    p[0] = wave(a[0] * 0.6, 0.8, 2.2);
    p[1] = wave(a[1] * 0.6, 0.2, 0.75);
    p[2] = wave(a[2] * 0.6, 0.55, 1.2);
    p[3] = wave(a[3] * 0.6, 6, 13) * (0.85 + 0.3 * g[7]);
    p[4] = a[4] * 0.6 + g[1] * 6.283;
    p[5] = wave(a[5] * 0.6, 0.0, 0.55);
    p[6] = wave(a[6] * 0.6, 0.8, 2.2);
    // Noise time and parallax drift run slowly: the base motion stays low, so the beats stand out.
    p[7] = tr * 0.04 + g[3] * 40 + mel.z;
    // View (S.p[2]): slight turn, zoom level, whorl height, scale.
    p[8] = 0.35 * Math.sin(a[7] * 0.5) + (g[5] - 0.5) * 0.3;
    // Zoom level in octaves: sinks with the travel (rushing on drops), a new octave every few seconds.
    p[9] = tr * 0.32 + g[6] * 16;
    // Each octave's own whorls (field units), stepping each phrase with the rest of the form.
    p[10] = wave(a[6] * 0.6 + 1.7, 0.25, 0.6);
    // Zoom (thousandths) with the teal base hue packed in the fraction.
    p[11] = Math.round((1.0 + 0.12 * g[7]) * 1000) + 0.98 * g[3];
    // Lasting hue base (the kick walk's total, less the kicks still fronting), the gliding melody hue,
    // the teal base of the gradient and the melody lines' glow.
    const slotSum = kicks.reduce((s, f) => s + f.d, 0);
    p[12] = kickCum - slotSum;
    p[13] = mel.hue;
    // Fine detail (RULES v7): depth from the detail drive (thousandths), phase (turns, in the fraction)
    // flowing with the detail coordinates and stepping with each high note, backing chord and hat.
    // High notes carry the change (a turn of up to 3.5 radians each, by strength squared, so a faint
    // motif only nudges the detail); the detail coordinates, backing and hats only drift it slowly.
    // Glided on a critically damped spring (its quickest about 0.15 s after a note, settled in about
    // 0.7 s), so a note re-forms the detail smoothly.
    const dT = 0.3 * morph.detailAt[0] + 0.2 * morph.detailAt[1] + 0.4 * morph.backingPhase + 0.15 * morph.hatPhase;
    // Its changes count by the music's presence too (a jump means a new cue: start there).
    const dInc = dT - detailSm.raw;
    detailSm.raw = dT;
    if (Math.abs(dInc) > 20) [detailSm.x, detailSm.v, detailSm.t] = [dT, 0, dT];
    else detailSm.t += dInc * presence();
    if (live && morph.upperAge === 0) detailSm.t += 3.5 * morph.upperLevel ** 2 * presence();
    [detailSm.x, detailSm.v] = spring(detailSm.x, detailSm.v, detailSm.t, 12, dt);
    // The detail depth follows the detail drive, weighted by the presence, gliding in over about a second.
    [detailSm.a, detailSm.av] = spring(detailSm.a, detailSm.av, 0.15 + 0.85 * morph.detailDrive * presence(), 3.5, dt);
    const dPh = detailSm.x;
    p[14] = Math.round(Math.min(1, Math.max(0, detailSm.a)) * 1000) + 0.98 * (dPh / 6.283185 - Math.floor(dPh / 6.283185));
    p[15] = mel.glow;
    // Events: two kick fronts, one snare front, one note front (x, y, age, value). The age packs the
    // event's strength (ms in the integer part, strength in the fraction); the snare's value packs
    // its lasting width phase, the note's packs the previous note (pitch and strength, then age).
    const age = (f: Front) => Math.floor(Math.min(99, now - f.t) * 1000) + 0.98 * f.l;
    const k0 = kicks[0] ?? NONE;
    const k1 = kicks[1] ?? NONE;
    p.set([k0.x, k0.y, age(k0), k0.d], 16);
    p.set([k1.x, k1.y, age(k1), k1.d], 20);
    p.set([snare.x, snare.y, age(snare), snare.n + 0.98 * (snareBase / 3)], 24);
    const prevKey = Math.round((prevPitch + 2) * 100) * 16 + Math.round(prevNoteL * 15);
    p.set([note.x, note.y, age(note), prevKey + Math.min(now - prevNoteT, 9) / 10], 28);
  },
  wgsl: SHADER,
});
