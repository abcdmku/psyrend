import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Wormhole: an endless chain of wormhole throats, flown through forever, drawn entirely in crisp
 * neon lines. Space here is a string of bulbs joined by narrow necks (areal radius r(l) swelling and
 * pinching along the throat coordinate l), and every camera ray is integrated as a true geodesic in
 * its own orbital plane (l'' = h^2 r'(l) / r^3, phi' = h / r^2), so each neck lenses the lines
 * beyond it into sweeping curves that pour toward a vanishing point.
 * The light lives on three nested shells of fine lines running along l, each shell with its own
 * count and twist, so they slide past each other in parallax. The shells' axis is tilted away from
 * the camera's, so the throat sweeps past to one side instead of sitting centred like a target.
 *
 * The morph moves the form continuously: how hard the necks pinch (lensing strength), the bulb
 * spacing, the shells' latitude and spread, the axis tilt, the twist and the S-curve of the lines.
 * The camera glides along l at one steady pace.
 *
 * Beats ignite burns that travel along the lines themselves: lit at one line, the fire runs along
 * it both ways and jumps to neighbouring lines after ragged delays, so the front fans out through
 * the bundle like fire through steel wool. The hot head (white, yellow, orange) throws off sparks
 * whose number and colour come from the sound (flux and highs, spectral centroid); behind it the
 * line keeps a lasting change:
 *  - kick: a fire from ahead; each line it burns takes the next hue for good;
 *  - snare: a fast crackle in a cool second colour; the light passes for good to a new set of
 *    lines, tinted that colour;
 *  - melody: a slower glow in the note's colour lit at the line set by the pitch; the shells move
 *    to a latitude set by the pitch, and the lines lean toward the note's colour.
 */

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
function presentAt(seek: boolean): Float64Array {
  const pr = presence();
  for (let i = 0; i < 8; i++) {
    const s = morph.at[i] - morph.flowAt[i];
    const d = s - stepSm.prev[i];
    stepSm.prev[i] = s;
    if (seek || Math.abs(d) > 0.5) stepSm.own[i] = 0;
    else stepSm.own[i] += d * pr;
    stepSm.out[i] = morph.flowAt[i] + stepSm.own[i];
  }
  return stepSm.out;
}

/** One step of a critically damped spring: returns [x, v] moved toward `target` (exact for any dt). */
const spring = (x: number, v: number, target: number, w: number, dt: number): [number, number] => {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
};

/**
 * Burns of one kind of event. A new burn is lit only once the current one has died out (its light
 * is gone by `gap` seconds, see wh_env), so a beat never cuts a burn off mid-flight; events in
 * between still change the lines' lasting state, which glides on the morph's eased counts.
 * Each burn keeps the strength of the event that lit it (0..1), so a faint hit burns faintly.
 */
class Fronts {
  private n = -1;
  private t = -99;
  count = 0;
  age = 99;
  level = 0;
  constructor(private readonly gap: number) {}
  update(events: number, now: number, eventAge: number, level: number, reset: boolean, lit: () => void): void {
    if (reset || this.n < 0 || events < this.n) {
      this.t = -99;
      this.level = 0;
    } else if (events > this.n && now - eventAge - this.t >= this.gap) {
      this.t = now - eventAge;
      this.count++;
      this.level = level;
      lit();
    }
    this.n = events;
    this.age = Math.min(now - this.t, 99);
  }
}

/**
 * Lasting changes of the lines: each snare hands the light to a new set of lines (in its cool
 * colour), each melody note moves the shells to a latitude set by its pitch. Both follow critically
 * damped springs: each change starts from rest, is quickest about 0.12-0.15 s after the hit and
 * settles within about 0.6 s. In a
 * roll of hits the steps shrink with the gap since the last one, so a burst moves about as far as one.
 */
const shift = { lit: 0, vLit: 0, litT: 0, sN: 0, sT: -9, lat: 0, vLat: 0, latT: 0, lN: 0, lN0: 0, lT: -9, hue: 0, vHue: 0, hueT: 0 };
/** Spring rates: peak speed 1 / w seconds after a step. */
const W_LAT = 6.7;
const W_LIT = 8;
const rollStep = (now: number, last: number) => Math.min(1, Math.max(0.2, (now - last) / 0.4));

const morph = new Morph(0.5);
const kickF = new Fronts(0.5);
const snareF = new Fronts(0.5);
const noteF = new Fronts(0.5);
/** Glided note pitch (the lines' note colour) and director intensity (it jumps at a drop). */
const gl = { pitch: 0, vp: 0, gain: 0, vg: 0, notePitch: 0 };
const cam = { phase: 0, travel: -1, seed: -1, kL: 0, sL: 0, lL: 0, time: -1e9 };
/** l units the camera moves per unit of morph travel. */
const L_PER_TRAVEL = 0.8;

export default raymarchScene({
  meta: {
    id: 'wormhole',
    name: 'Wormhole',
    energy: [0.2, 1],
    mood: { valence: 0.5, arousal: 0.65 },
    genres: { edm: 1, dnb: 0.9, techno: 0.85, synthwave: 0.9, dubstep: 0.6, ambient: 0.6, pop: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    // A seek (a time jump, detected as the morph does) clears every burn, glide and stored count in
    // flight: the morph's counts and travel keep running through it, so nothing else would.
    const seek = Math.abs(m.time - cam.time - dt) > 0.5;
    cam.time = m.time;
    const a = presentAt(seek);
    const period = wave(a[0], 2.6, 4.6);
    // Glide along l at a steady pace; the camera's place within a bulb is a phase, so the bulb
    // spacing can morph without a jump.
    const dTr = morph.travel - cam.travel;
    const reset = g[0] !== cam.seed || seek || dTr < 0 || dTr > 1;
    const dl = reset ? 0 : dTr * L_PER_TRAVEL;
    if (reset) {
      cam.phase = 0.3;
      cam.seed = g[0];
      cam.kL = cam.sL = cam.lL = -99;
      gl.pitch = morph.notePitch;
      gl.gain = ctx.intensity;
      gl.vp = gl.vg = 0;
      shift.lit = shift.vLit = shift.litT = 0;
      shift.lat = shift.vLat = shift.latT = 0;
      shift.hue = shift.vHue = shift.hueT = 0;
      shift.sN = morph.snares;
      shift.lN = shift.lN0 = morph.notes;
      shift.sT = shift.lT = -9;
    } else {
      cam.phase = (cam.phase + dl / period) % 1;
    }
    cam.travel = morph.travel;
    // Ignition points, fixed in the throat: set ahead of the camera when a burn is lit, then
    // carried back past it as the camera flies on.
    cam.kL -= dl;
    cam.sL -= dl;
    cam.lL -= dl;
    const now = m.time;
    kickF.update(morph.kicks, now, morph.kickAge, strength(morph.kickLevel), reset, () => (cam.kL = 3.5 + 1.5 * Math.sin(kickF.count * 1.7)));
    snareF.update(morph.snares, now, morph.snareAge, strength(morph.snareLevel), reset, () => (cam.sL = 2.0 + 1.0 * Math.cos(snareF.count * 2.3)));
    noteF.update(morph.notes, now, morph.leadAge, strength(morph.noteLevel), reset, () => {
      gl.notePitch = morph.notePitch;
      cam.lL = 2.5 + 1.5 * morph.notePitch;
    });
    if (morph.snares > shift.sN) {
      // The snare's strength sets how far the light moves on to the next set of lines.
      shift.litT += strength(morph.snareLevel) * rollStep(now, shift.sT);
      shift.sT = now;
    }
    shift.sN = morph.snares;
    if (morph.notes > shift.lN) {
      // A new latitude from the pitch (and alternately up and down, so even a repeated note moves).
      const goal = 0.25 * morph.notePitch + ((morph.notes - shift.lN0) % 2 ? 0.14 : -0.14);
      shift.latT += (goal - shift.latT) * rollStep(now, shift.lT) * strength(morph.noteLevel);
      // The note colour on the lines steps on round the wheel by the note's strength, for good.
      shift.hueT += 0.5 * strength(morph.noteLevel);
      shift.lT = now;
    }
    shift.lN = morph.notes;
    [shift.lit, shift.vLit] = spring(shift.lit, shift.vLit, shift.litT, W_LIT, dt);
    [shift.lat, shift.vLat] = spring(shift.lat, shift.vLat, shift.latT, W_LAT, dt);
    [shift.hue, shift.vHue] = spring(shift.hue, shift.vHue, shift.hueT, W_LAT, dt);
    const lat = shift.lat;
    // The note colour and the overall gain glide on springs (a drop's intensity would jump).
    [gl.pitch, gl.vp] = spring(gl.pitch, gl.vp, morph.notePitch, 8, dt);
    [gl.gain, gl.vg] = spring(gl.gain, gl.vg, ctx.intensity, 6, dt);
    p[0] = cam.phase * period;
    p[1] = period;
    // Fine detail (RULES v7): depth from the detail drive (thousandths), phase (turns, in the fraction)
    // flowing with the detail coordinates and stepping with each high note, backing chord and hat.
    // High notes carry the change (a turn of up to 3.5 radians each, by strength); the detail
    // coordinates, backing and hats only drift it slowly. Glided on a critically damped spring (its
    // quickest about 0.15 s after a note, settled in about 0.7 s), so a note re-forms the detail smoothly.
    const dT = 0.15 * morph.detailAt[0] + 0.1 * morph.detailAt[1] + 3.5 * morph.upperPhase + 0.5 * morph.backingPhase + 0.15 * morph.hatPhase;
    // Its changes count by the music's presence too (a jump means a new cue: start there).
    const dInc = dT - detailSm.raw;
    detailSm.raw = dT;
    if (reset || Math.abs(dInc) > 20) [detailSm.x, detailSm.v, detailSm.t] = [dT, 0, dT];
    else detailSm.t += dInc * presence();
    [detailSm.x, detailSm.v] = spring(detailSm.x, detailSm.v, detailSm.t, 7, dt);
    // The detail depth follows the detail drive, weighted by the presence, gliding in over about a second.
    [detailSm.a, detailSm.av] = spring(detailSm.a, detailSm.av, 0.15 + 0.85 * morph.detailDrive * presence(), 3.5, dt);
    const dPh = detailSm.x;
    p[2] = Math.round(Math.min(1, Math.max(0, detailSm.a)) * 1000) + 0.98 * (dPh / 6.283185 - Math.floor(dPh / 6.283185));
    p[3] = wave(a[1], 0.25, 0.9);
    // Shells: base latitude, spread, axis tilt and its direction.
    // Melody notes shift the shells' latitude (kept clear of the axis so the tilt stays positive).
    // A shift toward the axis eases off softly as it uses up the room the tilt leaves, so a note
    // never drags the tilt along with it (that would re-form the whole frame at once).
    const lat0 = wave(a[2], 0.6, 1.05);
    p[5] = wave(a[3], 0.16, 0.36);
    const tilt0 = wave(a[4], 0.2, 0.42);
    const room0 = lat0 - p[5] - 0.12 - tilt0;
    const room = 0.5 * (room0 + Math.sqrt(room0 * room0 + 0.0016)) + 0.01;
    p[4] = Math.max(lat0 + (lat >= 0 ? lat : -room * (1 - Math.exp(lat / room))), 0.5);
    // The tilt keeps the camera inside the innermost shell (seen from outside, a shell would show a
    // hard silhouette edge).
    p[6] = Math.min(tilt0, p[4] - p[5] - 0.12);
    p[7] = g[1] * 6.283 + 0.6 * Math.sin(a[4] * 0.7);
    // Twist (base and S-curve along l), palette offset, line count.
    p[8] = wave(a[5], -0.3, 0.3);
    p[9] = wave(a[6], 1.0, 2.2);
    p[10] = g[3] + 0.08 * Math.sin(a[6]);
    p[11] = 32 + 3 * Math.floor(g[2] * 8);
    // Burn ages (ms in the integer part, the burn's strength in the fraction) and counts (the counts
    // place each burn's origin), the note's pitch at its burn.
    const burn = (f: Fronts) => Math.floor(Math.min(f.age, 9) * 1000) + 0.98 * f.level;
    p[12] = burn(kickF);
    p[13] = burn(snareF);
    p[14] = snareF.count % 64;
    p[15] = burn(noteF);
    p[16] = gl.notePitch;
    // The glided pitch sets the lines' note colour.
    p[17] = gl.pitch;
    p[18] = kickF.count % 64;
    p[19] = 0.85 + 0.3 * gl.gain;
    // Gaze: off the throat's line, drifting slowly with the morph (never with a beat). The phrase
    // framing (morph.cam) turns and tilts the gaze further, adds its roll to the slow roll and swings
    // the lens from long (the throat flattened into a narrow tube) to wide (the bulbs wrapping round).
    // The camera rides the throat's centre by construction, so the height has nowhere to go here.
    const cf = morph.cam;
    const yaw = 0.38 + 0.1 * Math.sin(a[7] * 0.7 + g[4] * 6) + 0.55 * cf.yaw * (g[4] < 0.5 ? 1 : -1);
    const pitch = 0.1 * Math.sin(a[6] * 0.6 + g[5] * 6) + 0.7 * cf.pitch;
    p[20] = 1;
    p[21] = Math.tan(g[4] < 0.5 ? yaw : -yaw);
    p[22] = Math.tan(pitch);
    p[23] = Math.min(1.9, Math.max(0.5, 1.05 / cf.fov));
    p[24] = morph.travel * 0.07 * (g[6] < 0.5 ? 1 : -1) + g[7] * 6.283 + 1.3 * cf.roll;
    p[25] = cam.kL;
    p[26] = cam.sL;
    p[27] = cam.lL;
    // Lasting state: the lines' hue after kicks (the morph's eased count), the lit set after snares.
    p[28] = morph.kickPhase;
    p[29] = shift.lit;
    p[30] = shift.hue;
  },
  wgsl: /* wgsl */ `
// Areal radius r(l) and dr/dl: bulbs of radius rho * (1 + A) joined by necks of radius rho.
fn wh_r(l: f32) -> vec2f {
  let k = TAU / S.p[0].y;
  let rho = 1.0;
  let A = S.p[0].w;
  return vec2f(rho * (1.0 + A * 0.5 * (1.0 - cos(k * l))), rho * A * 0.5 * k * sin(k * l));
}

// Fire by heat (1 = just lit): white core, yellow, orange.
fn wh_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.25, 0.05) * h * 1.4 + vec3f(1.0, 0.62, 0.2) * h * h * 2.2 + vec3f(1.0, 0.95, 0.9) * pow(h, 5.0) * 2.5;
}

// Fronts burst out fast and slow as they spread: their reach goes with the root of the age.
// The first 0.4 s ease in from rest, so even the lines at the spark catch gradually.
fn wh_warp(a: f32) -> f32 { return sqrt(a * 0.35) * smoothstep(0.0, 0.4, a); }
// A glow that swells in from nothing over r, then cools at rate k: never a flash.
fn wh_pulse(x: f32, r: f32, k: f32) -> f32 { return smoothstep(0.0, r, x) * exp(-max(x - r, 0.0) * k); }
// A burn's light over its age: swells in over 0.4 len and is gone by len seconds (len <= 0.5,
// the gap before the next burn of its kind).
fn wh_env(a: f32, len: f32) -> f32 { return smoothstep(0.0, 0.4 * len, a) * (1.0 - smoothstep(0.5 * len, len, a)); }

// Hue of a colour from its chroma vector, steadied by a pull toward t's own hue, so a near-grey
// palette colour never makes the hue jump.
fn wh_hue(c: vec3f, t: f32) -> f32 {
  let v = vec2f(c.r - 0.5 * (c.g + c.b), 0.8660254 * (c.g - c.b)) + 0.2 * vec2f(cos(t * TAU), sin(t * TAU));
  return fract(atan2(v.y, v.x) / TAU);
}
// A vivid colour dh round the wheel from the palette's hue at t, at the palette's brightness there:
// even a one-hue palette gives the glows their own hues.
fn wh_neon(t: f32, dh: f32) -> vec3f {
  let c = palL(t, 1.0);
  let v = hsv2rgb(vec3f(wh_hue(c, t) + dh, 0.8, 1.0));
  return v * max(luma(c), 0.2) / max(luma(v), 0.05);
}

// Circular distance between two angles.
fn wh_adist(a: f32, b: f32) -> f32 { return abs(fract((a - b) / TAU + 0.5) - 0.5) * TAU; }

// Arrival time (seconds) of a fire lit at line angle a0, place l0, reaching line (shell k, angle
// la, hash hl) at l: it runs along the line at speed v and jumps across lines with ragged delays.
fn wh_arrive(l: f32, la: f32, k: f32, hl: f32, l0: f32, a0: f32, v: f32, jump: f32) -> f32 {
  return abs(l - l0) / v + wh_adist(la, a0) * jump * (0.5 + hl) + abs(k - 1.0) * 0.06;
}

// Globals the shells read (set once per pixel in scene()).
var<private> W: WhCtx;
struct WhCtx { dAmp: f32, dPh: f32, twist: f32, curve: f32, hue0: f32, nf0: f32, kA: f32, sA: f32, sN: f32, lA: f32, kLv: f32, sLv: f32, lLv: f32, kN: f32, kL: f32, sL: f32, lL: f32, a0K: f32, a0S: f32, a0L: f32, nTurn: f32, kPh: f32, sPh: f32, sparkRate: f32, sparkCol: vec3f };

// The lines on shell k where a ray crosses it at (l, psi, th): lines run along l, twisting at a
// rate that swings back and forth (the S-curves), gathered in bundles of related hues. Burns run
// along them and throw sparks that slide off along the shell.
fn wh_shell(kf: f32, l: f32, lr: f32, psi0: f32, th: f32, r: f32, s: f32, pix: f32) -> vec3f {
  // The lines' fine wobble belongs to the high end (RULES v7): a short ripple along each line, deeper
  // with the detail drive, whose phase turns with the high notes, so each one re-forms it.
  let tw = W.twist * (1.0 + 0.12 * kf) * l + W.curve * sin(l * 0.45 + kf * 0.5)
    + W.dAmp * (0.012 + 0.03 * kf) * sin(l * 5.0 + kf * 1.9 + W.dPh) + W.dAmp * 0.015 * sin(l * 9.0 - kf * 2.3 - 2.0 * W.dPh);
  let nf = W.nf0 + 10.0 * kf;
  let psi = psi0 - tw;
  let ang = psi * nf / TAU;
  let idx0 = floor(ang + 0.5);
  let la = (idx0 / nf) * TAU + tw;
  // Line number, the same on both sides of the azimuth's wrap.
  let idx = idx0 - nf * floor(idx0 / nf);
  let hl = hash12(vec2f(idx, kf * 17.0 + 3.0));
  let sth = r * sin(max(th, 0.15));
  let fd = abs(fract(ang) - 0.5) * TAU / nf * sth;
  let wf = 0.003 + pix * s * 0.8;
  let core = exp(-fd * fd / (wf * wf)) * min(1.0, 0.006 / wf) * 1.3;
  let halo = exp(-fd / (wf * 2.5)) * min(1.0, 0.006 / wf) * 0.15;
  let bund = smoothstep(0.15, 0.75, sin(la * (2.0 + kf) + kf * 2.2 + 0.5 * sin(l * 0.3 + kf)));
  // Where the lines crowd closer than a few pixels they merge into their average glow (no moire).
  let spacing = TAU / nf * sth / (pix * s + 1e-4);
  let crowd = smoothstep(2.5, 6.0, spacing);
  let line = mix(0.25 * 0.006 / (TAU / nf * sth) * 1.3, core + halo, crowd) * (0.03 + 0.97 * bund);
  // Burns along the lines.
  let bK = wh_warp(W.kA) - wh_arrive(lr, la, kf, hl, W.kL, W.a0K, 14.0, 0.18);
  let bS = wh_warp(W.sA) - wh_arrive(lr, la, kf, hl, W.sL, W.a0S, 30.0, 0.06);
  let bL = wh_warp(W.lA) - wh_arrive(lr, la, kf, hl, W.lL, W.a0L, 7.0, 0.08);
  // Lasting state, gliding on the eased counts: the hue steps on after each kick, the lit set moves
  // on after each snare (cross-faded), the lines lean toward the note's colour.
  let hState = W.kPh;
  let hue = W.hue0 + 0.6 * (0.5 + 0.5 * sin(la + kf * 1.3)) + 0.05 * hl + 0.17 * hState;
  let s0 = floor(W.sPh);
  let litA = step(0.55, fract(hl * 7.3 + s0 * 0.618));
  let litB = step(0.55, fract(hl * 7.3 + (s0 + 1.0) * 0.618));
  let lit = mix(litA, litB, smoothstep(0.0, 1.0, W.sPh - s0));
  let bright = 0.15 + 0.85 * lit;
  // Hues spread round the bundle (turned round the wheel, so even a one-hue palette gives several).
  // Snares also turn the colours round the bundle (W.sPh), a lasting change eased on its spring.
  var lc0 = wh_neon(hue, 0.25 * sin(la + kf * 0.9 + hState + 0.9 * W.sPh)) * bright;
  lc0 = max(mix(vec3f(luma(lc0)), lc0, 1.7), vec3f(0.0));
  // The note's and the snare's colours are set against each line's own hue (the note turned by its
  // pitch, the snare opposite), so their light always stands apart from the lines it runs along.
  let nCol = wh_neon(hue, W.nTurn);
  let sCol = mix(wh_neon(hue, 0.5), vec3f(0.6, 0.85, 1.0), 0.25);
  lc0 = mix(lc0, nCol * bright, 0.4);
  // The snare's lit set burns in its cool second colour.
  lc0 = mix(lc0, sCol * bright, 0.4 * lit);
  var e = lc0 * line;
  // Hot heads and embers: each swells in where the fire arrives, and every burn's light is gone
  // by half a second (wh_env), before the next burn of its kind can be lit.
  // Each burn's light is scaled by the strength of the event that lit it.
  let heat = wh_pulse(bK, 0.1, 6.0) * wh_env(W.kA, 0.5) * W.kLv;
  let emb = wh_pulse(bK, 0.15, 1.5) * step(0.8, hash12(vec2f(floor(l * 9.0), idx + kf * 64.0))) * wh_env(W.kA, 0.5) * W.kLv;
  e += wh_fire(heat) * line * 3.0 + wh_fire(0.35) * emb * core * 0.8;
  let sh = wh_pulse(bS, 0.08, 9.0) * wh_env(W.sA, 0.5) * W.sLv;
  e += sCol * sh * line * 5.0;
  let lh = wh_pulse(bL, 0.12, 4.0) * wh_env(W.lA, 0.5) * W.lLv;
  e += nCol * lh * line * 3.6;
  // The spark that lights each fire: a bloom that swells along the lines round its ignition point.
  let gK = (lr - W.kL) * (lr - W.kL) * 0.5 + wh_adist(la, W.a0K) * wh_adist(la, W.a0K) * 0.8;
  let gS = (lr - W.sL) * (lr - W.sL) * 0.7 + wh_adist(la, W.a0S) * wh_adist(la, W.a0S) * 1.2;
  let gL = (lr - W.lL) * (lr - W.lL) * 0.4 + wh_adist(la, W.a0L) * wh_adist(la, W.a0L) * 0.04;
  e += wh_fire(0.9) * line * exp(-gK) * wh_env(W.kA, 0.45) * 6.0 * W.kLv;
  e += sCol * line * exp(-gS) * wh_env(W.sA, 0.45) * 4.0 * W.sLv;
  e += nCol * line * exp(-gL) * wh_env(W.lA, 0.45) * 9.0 * W.lLv;
  // Sparks off the kick's hot head: each spark cell along a line launches when the fire reaches
  // it and slides off across the shell while it cools.
  let cl = floor(lr * 6.0);
  for (var j = -1; j <= 1; j++) {
    let cj = cl + f32(j);
    let hs = hash12(vec2f(cj + 0.5, idx * 1.37 + kf * 41.0));
    if (hs >= W.sparkRate) { continue; }
    let ls = (cj + hash12(vec2f(cj, idx + 7.0))) / 6.0;
    let age = wh_warp(W.kA) - wh_arrive(ls, la, kf, hl, W.kL, W.a0K, 14.0, 0.18);
    if (age <= 0.0 || age > 1.2) { continue; }
    let hs2 = hash12(vec2f(cj * 3.1, idx + 1.9));
    let dz = lr - ls - age * 0.9 * (hs - 0.5 * W.sparkRate);
    let dA = (fract((psi0 - la) / TAU + 0.5) - 0.5) * TAU * sth - age * 0.5 * (hs2 - 0.5);
    let sw = 0.006 + pix * s;
    let sd = dz * dz + dA * dA;
    e += mix(vec3f(1.0, 0.9, 0.7), W.sparkCol, sat(age * 2.0)) * exp(-sd / (sw * sw)) * min(1.0, 0.008 / sw) * exp(-age * 3.0) * smoothstep(0.0, 0.12, age) * 3.0 * wh_env(W.kA, 0.5) * W.kLv;
  }
  return e;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  // Local camera frame: x = increasing l, y/z = across the throat.
  let fwd = normalize(S.p[5].xyz);
  let roll = S.p[6].x;
  let upRef = vec3f(0.0, sin(roll), cos(roll));
  let rt = normalize(cross(fwd, upRef));
  let up = cross(rt, fwd);
  let focal = S.p[5].w;
  let dl = normalize(rt * q.x + up * q.y + fwd * focal);
  let pix = 1.4 / (F.res.y * focal);

  // The camera sits at the pole c of the sphere of directions; tdir is the ray's way across it.
  let c = vec3f(0.0, 0.0, 1.0);
  let u1 = vec3f(1.0, 0.0, 0.0);
  let u2 = vec3f(0.0, 1.0, 0.0);
  let st = length(dl.yz);
  let tdir = normalize(u1 * dl.y + u2 * dl.z + c * 1e-6);
  // The shells' axis, tilted away from the camera's pole.
  let tilt = S.p[1].z;
  let taz = S.p[1].w;
  let ax = normalize(c * cos(tilt) + (u1 * cos(taz) + u2 * sin(taz)) * sin(tilt));
  let e1 = normalize(cross(ax, vec3f(0.3, 0.5, 0.81)));
  let e2 = cross(ax, e1);

  let P = S.p[0].y;
  let lc = S.p[0].x;
  let th0 = S.p[1].x;
  let spread = S.p[1].y;
  W.twist = S.p[2].x;
  W.dAmp = floor(S.p[0].z) / 1000.0;
  W.dPh = fract(S.p[0].z) / 0.98 * TAU;
  W.curve = S.p[2].y;
  let hue0 = S.p[2].z;
  W.hue0 = hue0;
  W.nf0 = S.p[2].w;
  W.kA = floor(S.p[3].x) / 1000.0;
  W.sA = floor(S.p[3].y) / 1000.0;
  W.sN = S.p[3].z;
  W.lA = floor(S.p[3].w) / 1000.0;
  W.kLv = sat(fract(S.p[3].x) / 0.98);
  W.sLv = sat(fract(S.p[3].y) / 0.98);
  W.lLv = sat(fract(S.p[3].w) / 0.98);
  let pNew = S.p[4].x;
  let pGlide = S.p[4].y;
  W.kN = S.p[4].z;
  W.kL = S.p[6].y;
  W.sL = S.p[6].z;
  W.lL = S.p[6].w;
  W.a0K = W.kN * 2.4;
  W.a0S = W.sN * 1.9 + 1.0;
  W.a0L = pNew * 2.6;
  W.nTurn = 0.2 + 0.45 * pGlide + S.p[7].z;
  W.kPh = S.p[7].x;
  W.sPh = S.p[7].y;
  // Sparks: their number from the flux and highs, their colour from the spectral centroid (soft
  // curves that rise from zero and level off, with no clamp corner).
  W.sparkRate = 0.12 + 0.35 * (1.0 - exp(-2.0 * max(F.flux, 0.0))) + 0.25 * (1.0 - exp(-2.0 * max(F.high, 0.0)));
  W.sparkCol = mix(vec3f(1.0, 0.55, 0.2), mix(vec3f(1.0, 0.95, 0.8), palL(hue0 + 0.15, 1.0), 0.5), 1.0 - exp(-2.5 * max(F.centroid, 0.0)));

  var l = lc;
  var pl = dl.x;
  let r0 = wh_r(lc).x;
  let hh = r0 * st;
  var phi = 0.0;
  var s = 0.0;
  var emis = vec3f(0.0);
  var prevD = vec3f(0.0);
  var prevL = l;
  var prevPhi = 0.0;
  var prevS = 0.0;
  let jit = ign(frag);
  for (var i = 0; i < 140; i++) {
    let r = wh_r(l).x;
    let Pd = cos(phi) * c + sin(phi) * tdir;
    let th = acos(clamp(dot(Pd, ax), -1.0, 1.0));
    // Signed arc distance to each shell.
    let dW = (vec3f(th) - (vec3f(th0) + (vec3f(0.0, 1.0, 2.0) - 1.0) * spread)) * r;
    if (i > 0) {
      for (var k = 0; k < 3; k++) {
        let d0 = prevD[k];
        let d1 = dW[k];
        if (d0 * d1 > 0.0) { continue; }
        // The ray crosses shell k: find the crossing and draw the lines there, brighter at
        // grazing angles (a thin glowing film seen edge-on).
        let fr = d0 / (d0 - d1 + 1e-6);
        let lI = mix(prevL, l, fr);
        let phiI = mix(prevPhi, phi, fr);
        let sI = mix(prevS, s, fr);
        let PdI = cos(phiI) * c + sin(phiI) * tdir;
        let thI = acos(clamp(dot(PdI, ax), -1.0, 1.0));
        let psiI = atan2(dot(PdI, e2), dot(PdI, e1));
        let rI = wh_r(lI).x;
        let graze = min(1.0 / max(abs(d1 - d0) / max(s - prevS, 1e-4), 1e-3), 2.5);
        let fade = exp(-sI * 0.1) * smoothstep(0.1, 0.8, sI);
        emis += wh_shell(f32(k), lI, lI - lc, psiI, thI, rI, sI, pix) * graze * fade;
      }
    }
    prevD = dW;
    prevL = l;
    prevPhi = phi;
    prevS = s;
    let dmin = min(abs(dW.x), min(abs(dW.y), abs(dW.z)));
    var ds = clamp(dmin * 0.8, 0.01, 0.25);
    if (i == 0) { ds *= 0.5 + jit; }
    // Integrate the geodesic (semi-implicit Euler).
    let rr = wh_r(l);
    pl += hh * hh * rr.y / (r * r * r) * ds;
    l += pl * ds;
    phi += hh / (r * r) * ds;
    s += ds;
    if (s > 40.0) { break; }
  }
  // Distance fades with the integrated light (the throat ahead dims into a deep glow).
  var col = palL(hue0 + 0.62, 0.004) + emis * S.p[4].w * 0.15;
  // Richer colour: where lines crowd, their light would otherwise sum toward white.
  col = max(mix(vec3f(luma(col)), col, 1.6), vec3f(0.0));
  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.35 * max(pk - 0.8, 0.0));
  return vec4f(col, 1.0);
}
`,
});
