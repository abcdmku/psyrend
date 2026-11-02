import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Moire Field: two or three high-contrast line gratings (straight, circular or three-armed spiral)
 * on black, each drawn as neon bands of its own hue. Where the bands of different gratings overlap
 * their hues add, and where the gaps of two gratings drift in and out of step the beat between
 * them is a large flowing interference pattern (op-art, ref11). Nothing is drawn but the gratings.
 *
 * Every grating is a phase v(z) whose light bands are |fract(v) - 1/2| < 0.09. Each band edge is
 * box-filtered by one pixel using the exact gradient of v (analytic per family, so the spiral's
 * atan2 cut is seamless), and gratings whose period nears a pixel fade to their mean rather than
 * alias. The families are blended by coverage, not by phase, so a grating can change its type
 * smoothly without the lines tearing.
 *
 * Music:
 *  - morph: centres, frequencies, angles, family weights and warp are wide maps of the morph
 *    coordinates, so each phrase carries the gratings to a new arrangement. The gratings also turn
 *    against each other with the travel, so the moire drifts.
 *  - kick: a fire from an interior point runs out along the grating 0 bands (fast, 18 units/s); behind
 *    it their phase steps by 0.5 period for good, and the hue steps with it (white-hot to orange edge).
 *  - snare: a cool front sweeps across from one side (a line, 16 units/s) and steps grating 2 by 0.4.
 *  - melody: a note's front leaves grating 1 in the note's colour, from an emitter at a height set by
 *    its pitch (32 units/s, so it clears the screen before the next note), and steps it by 0.4.
 * Each front shifts the lines it crosses, so the moire re-forms behind it. Every step, edge and glow
 * (and the note's colour change) scales with its event's level squared, which carries how loud the
 * passage is: a faint intro motif sends a faint ripple, a full-mix hit re-forms the moire.
 *
 * DNA: 0 start, 1 spin sense, 2 unused, 3 palette hue, 4 kick sequence, 5 snare side, 6 note side, 7 scale.
 */

const TAU = Math.PI * 2;
/** Lasting phase step each front leaves on its grating (periods). Must match the shader's 0.5 / 0.4 / 0.4. */
const DK = 0.5;
const DS = 0.4;
const DN = 0.4;
/** A front has crossed the whole screen (with its ragged delays) by this age: fold it into the lasting phase. */
const DONE = 0.32;

/** A front: origin, start time, and its amplitude (the event's level squared: step size and light). */
type Front = { t: number; x: number; y: number; on: boolean; a: number };
const NONE: Front = { t: 0, x: 0, y: 0, on: false, a: 0 };

const morph = new Morph(1);
let lastT = -1;
let seed = -1;
let kick: Front = NONE; // drives grating 0
let note: Front = NONE; // drives grating 1
let snare: Front = NONE; // drives grating 2
/** Lasting phase of each grating behind the fronts already past (periods, unbounded; read mod 1). */
const base = [0, 0, 0];
let noteHue = 0;
let hueOld = 0;

/** Folds a front into the lasting phase once it has finished sweeping. */
function settle(f: Front, now: number, i: number, d: number): Front {
  if (!f.on || now - f.t <= DONE) return f;
  base[i] += d * f.a;
  return { ...f, on: false };
}

const SHADER = /* wgsl */ `
const LHW: f32 = 0.09;   // half-width of a light band, in periods (18% duty: neon bands, black between)
const SPD_K: f32 = 18.0; // front speeds, plane units per second
const SPD_S: f32 = 16.0;
const SPD_N: f32 = 32.0;

// Box-filtered coverage of the light band |fract(v) - 1/2| < LHW by one pixel of width fw (periods).
// Where the period nears a pixel the band fades to its mean instead of aliasing.
fn band(v: f32, fw: f32) -> f32 {
  let x = fract(v) - 0.5;
  let f = max(fw, 1e-4);
  let c = max(0.0, min(x + 0.5 * f, LHW) - max(x - 0.5 * f, -LHW)) / f;
  return mix(c, 2.0 * LHW, smoothstep(0.3, 0.7, fw));
}

// Family weights (straight, circle, spiral) for a morph value t in [0, 2]; they always sum to one.
fn hat3(t: f32) -> vec3f {
  return vec3f(max(0.0, 1.0 - abs(t)), max(0.0, 1.0 - abs(t - 1.0)), max(0.0, 1.0 - abs(t - 2.0)));
}

// One grating: a blend of straight, circular and three-armed spiral families about centre c, with a
// shared sine warp and a phase shift sh (periods). Returns (coverage, straight phase for the hue).
fn grate(z: vec2f, c: vec2f, f: f32, ang: f32, tw: vec3f, g: f32, wa: f32, sh: f32) -> vec2f {
  let d = z - c;
  let r = max(length(d), 1e-4);
  let u = vec2f(cos(ang), sin(ang));
  let ka = 0.7 + 2.1 * g;
  let kw = (2.6 + 0.5 * g) * vec2f(cos(ka), sin(ka));
  let wp = dot(z, kw) + 2.0 * ang;
  let wv = wa * sin(wp) + sh;
  let wg = wa * cos(wp) * kw;
  let px = 2.0 / F.res.y;
  // Exact gradients of each family (z units), so the anti-aliasing width is exact.
  let vS = f * dot(d, u) + wv;
  let gS = f * u + wg;
  let vC = f * r + wv;
  let gC = f * d / r + wg;
  // Integer arms keep the phase continuous across the atan2 cut.
  let vP = 3.0 * atan2(d.y, d.x) / TAU + 0.35 * f * r + wv;
  let gP = (3.0 / TAU) * vec2f(-d.y, d.x) / (r * r) + 0.35 * f * d / r + wg;
  let cov = tw.x * band(vS, length(gS) * px) + tw.y * band(vC, length(gC) * px) + tw.z * band(vP, length(gP) * px);
  return vec2f(cov, vS);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let z = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let G0 = S.p[0]; let G1 = S.p[1]; let G2 = S.p[2];
  let T = S.p[3];
  let B = S.p[4];
  let KF = S.p[5]; let SF = S.p[6]; let NF = S.p[7];

  // Fronts. sb is how far behind the front a pixel sits, in plane units: the front reaches it after
  // distance / speed, plus a small ragged delay per line. Ages are negative when a front is inactive.
  let u0 = vec2f(cos(G0.w), sin(G0.w));
  let u1 = vec2f(cos(G1.w), sin(G1.w));
  let u2 = vec2f(cos(G2.w), sin(G2.w));
  let sbK = (KF.z - 0.012 * hash11(floor(G0.z * dot(z - G0.xy, u0)))) * SPD_K - length(z - KF.xy);
  let sbS = (SF.z - 0.012 * hash11(floor(G2.z * dot(z - G2.xy, u2)))) * SPD_S
    - abs(dot(z - vec2f(SF.x, 0.0), normalize(vec2f(1.0, SF.y))));
  let sbN = (NF.z - 0.012 * hash11(floor(G1.z * dot(z - G1.xy, u1)))) * SPD_N - length(z - NF.xy);

  // Front amplitudes (each event's level squared), packed in hundredths in KF.w.
  let aK = (KF.w - 100.0 * floor(KF.w / 100.0)) / 99.0;
  let aS = (floor(KF.w / 100.0) - 100.0 * floor(KF.w / 10000.0)) / 99.0;
  let aN = floor(KF.w / 10000.0) / 99.0;
  // Lasting phase: the live front steps the lines it has passed, as far as its event was strong.
  let shK = 0.5 * aK * smoothstep(-0.02, 0.02, sbK);
  let shS = 0.4 * aS * smoothstep(-0.02, 0.02, sbS);
  let shN = 0.4 * aN * smoothstep(-0.02, 0.02, sbN);
  // Grating 1 changes colour behind the note's front (inactive means fully changed).
  let passN = select(smoothstep(-0.02, 0.02, sbN), 1.0, NF.z < 0.0);
  let hueN = mix(SF.w, NF.w, passN);

  let r0 = grate(z, G0.xy, G0.z, G0.w, hat3(T.x), 0.0, S.p[4].w, B.x + shK);
  let r1 = grate(z, G1.xy, G1.z, G1.w, hat3(T.y), 1.0, S.p[4].w, B.y + shN);
  let r2 = grate(z, G2.xy, G2.z, G2.w, hat3(T.z), 2.0, S.p[4].w, B.z + shS);
  // Overlapping bands take the brighter channel, not the sum, so crossings stay saturated instead of
  // washing out to white.
  let c0 = r0.x * hsv2rgb(vec3f(fract(T.w + 0.25 * r0.y), 0.92, 1.0));
  let c1 = r1.x * hsv2rgb(vec3f(fract(hueN + 0.25 * r1.y), 0.92, 1.0));
  let c2 = r2.x * hsv2rgb(vec3f(fract(T.w + 0.33 + 0.25 * r2.y), 0.92, 1.0));
  var col = max(c0, max(c1, c2));
  // Melody glow: the note's bands stay lit for a fifth of a second behind its front, then cool.
  let bN = sbN / SPD_N;
  col += c1 * select(0.0, exp(-bN / 0.2), bN > 0.0) * 1.2 * aN;

  // Hot edges: a thin white-to-orange kick edge, a cool snare crackle, a note-coloured melody edge,
  // each with a faint ember tail behind it.
  let hK = select(0.0, exp(-sbK / 0.02) + 0.12 * exp(-sbK / 0.12), sbK > 0.0);
  let hS = select(0.0, exp(-sbS / 0.02) + 0.12 * exp(-sbS / 0.12), sbS > 0.0);
  let hN = select(0.0, exp(-sbN / 0.02) + 0.12 * exp(-sbN / 0.12), sbN > 0.0);
  let fireK = mix(vec3f(1.0, 0.96, 0.82), vec3f(1.0, 0.42, 0.06), smoothstep(0.0, 0.05, sbK));
  let fireS = mix(vec3f(0.7, 0.97, 1.0), vec3f(0.25, 0.6, 1.0), smoothstep(0.0, 0.05, sbS));
  let fireN = mix(hsv2rgb(vec3f(fract(hueN), 0.9, 1.0)), vec3f(1.0), 0.55);
  col += fireK * hK * 2.6 * aK + fireS * hS * 1.8 * aS + fireN * hN * 3.0 * aN;

  // Soft per-channel roll-off. Plain bands peak under the bloom threshold (0.75), so only the fronts
  // bloom and the black gaps stay black.
  return vec4f(vec3f(1.0) - exp(-col), 1.0);
}
`;

export default raymarchScene({
  meta: {
    id: 'moire-field',
    name: 'Moiré Field',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.6 },
    genres: { edm: 0.9, techno: 0.8, synthwave: 1, pop: 0.7, dnb: 0.7, dubstep: 0.6, hiphop: 0.5, rock: 0.5 },
    trails: 0,
    kaleido: false,
    // Fails the kick/snare lift gate on the riddim bass track (1.17 / 1.13 against 1.8 / 1.4): the wobble's
    // continuous motion raises the baseline. Passes the default track; pinnable but never auto-chosen.
    auto: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    const now = m.time;
    if (lastT < 0 || Math.abs(now - lastT - dt) > 0.5 || g[0] !== seed) {
      kick = snare = note = NONE;
      base.fill(0);
      noteHue = hueOld = g[3] + 0.5;
    }
    lastT = now;
    seed = g[0];
    const live = dt > 0;

    kick = settle(kick, now, 0, DK);
    note = settle(note, now, 1, DN);
    snare = settle(snare, now, 2, DS);
    if (live && morph.kickAge === 0) {
      if (kick.on) base[0] += DK * kick.a; // a kick came before the last one finished: fold it in now
      const k = morph.kicks;
      const ka = g[4] * TAU + 2.39996 * k;
      const kr = 0.25 + 0.5 * ((k * 0.618034) % 1);
      kick = { t: now, x: Math.cos(ka) * kr, y: Math.sin(ka) * kr, on: true, a: morph.kickLevel ** 2 };
    }
    if (live && morph.snareAge === 0) {
      if (snare.on) base[2] += DS * snare.a;
      const n = morph.snares;
      snare = { t: now, x: n % 2 === 0 ? -1.95 : 1.95, y: 0.6 * Math.sin(n * 1.7 + g[5] * 6), on: true, a: morph.snareLevel ** 2 };
    }
    if (live && morph.leadAge === 0) {
      if (note.on) base[1] += DN * note.a;
      const pitch = Math.max(-1, Math.min(1, morph.notePitch));
      const lv = morph.noteLevel ** 2;
      hueOld = noteHue;
      // The note's colour, reached as far as the note is strong (a faint note only tints).
      let dh = g[3] + 0.5 + morph.notes * 0.29 + pitch * 0.25 + (m.centroid - 0.5) * 0.2 - hueOld;
      dh -= Math.round(dh);
      noteHue = hueOld + lv * dh;
      note = { t: now, x: 0.9 * Math.sin(morph.notes * 2.1 + g[6] * 6), y: 0.8 * pitch, on: true, a: lv };
    }
    const age = (f: Front) => (f.on ? now - f.t : -10);

    // Shape: three gratings (centre, frequency, angle), family weights, hue and warp, all wide maps of the
    // morph. Frequencies are near each other so the beats between them are large.
    const tr = morph.travel;
    const sg = g[1] < 0.5 ? -1 : 1;
    const f0 = wave(a[6], 3.5, 6.5) * (0.85 + 0.3 * g[7]);
    const f1 = f0 * wave(a[7], 0.88, 1.14);
    const f2 = f0 * wave(a[1] * 0.8 + a[4] * 0.4, 0.9, 1.1);
    const ang0 = wave(a[2], -Math.PI, Math.PI) + sg * 0.05 * tr;
    const ang1 = ang0 + wave(a[3] * 0.7, -0.6, 0.6) + sg * 0.04 * tr;
    const ang2 = ang0 + wave(a[5] * 0.9, -0.9, 0.9) - sg * 0.025 * tr;
    p[0] = wave(a[0], -1.1, 1.1);
    p[1] = wave(a[1], -0.7, 0.7);
    p[2] = f0;
    p[3] = ang0;
    p[4] = wave(a[2], -1.1, 1.1);
    p[5] = wave(a[3], -0.7, 0.7);
    p[6] = f1;
    p[7] = ang1;
    p[8] = wave(a[4], -1.1, 1.1);
    p[9] = wave(a[5], -0.7, 0.7);
    p[10] = f2;
    p[11] = ang2;
    // Family weights (0 straight, 1 circle, 2 spiral), palette hue, lasting phases, warp amplitude.
    p[12] = wave(a[3] * 0.6, 0, 2);
    p[13] = wave(a[5] * 0.9 + 1, 0, 2);
    p[14] = wave(a[7] * 0.5 + a[2] * 0.3, 0, 2);
    p[15] = g[3] + 0.06 * Math.sin(a[6] * 0.4);
    p[16] = base[0];
    p[17] = base[1];
    p[18] = base[2];
    p[19] = wave(a[4] * 0.5 + a[0] * 0.3, 0.15, 0.55);
    // Fronts: origin x, y, age (negative when inactive); the snare's y is its tilt, the note's w its hue.
    p[20] = kick.x;
    p[21] = kick.y;
    p[22] = age(kick);
    // Front amplitudes in hundredths: kick, snare (x 100), note (x 10000).
    const q = (f: Front) => (f.on ? Math.round(Math.min(1, f.a) * 99) : 0);
    p[23] = q(kick) + 100 * q(snare) + 10000 * q(note);
    p[24] = snare.x;
    p[25] = snare.y;
    p[26] = age(snare);
    p[27] = hueOld;
    p[28] = note.x;
    p[29] = note.y;
    p[30] = age(note);
    p[31] = noteHue;
  },
  wgsl: SHADER,
});
