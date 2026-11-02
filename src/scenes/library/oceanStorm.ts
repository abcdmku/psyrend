import { raymarchScene } from '../raymarchScene';
import type { MusicState } from '../../audio/musicState';
import { Morph } from '../morph';

/** Critically damped follower (about 0.15 s rise from rest): event reactions ease in, never snap. */
type Glide = { x: number; v: number };
function glide(s: Glide, target: number, dt: number, w = 22): number {
  const e = Math.exp(-w * dt);
  const d = s.x - target;
  const c = s.v + w * d;
  s.v = (s.v - w * c * dt) * e;
  s.x = target + (d + c * dt) * e;
  return s.x;
}

// Event levels and ages only (strength and presence scaled): every reaction follows its event's level.
const mo = new Morph(0.5);
const evs = { kick: { x: 0, v: 0 }, snare: { x: 0, v: 0 }, note: { x: 0, v: 0 } };
const sat01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Open ocean. A heightfield sea of long dispersive swells (deep-water speed, peaked
 * trochoid crests) under choppy wind-wave octaves, foam on the crests, a thin
 * subsurface glow where crests turn translucent, sun glitter and sky reflections.
 * Above it a cloud deck from scattered cumulus to a black storm ceiling, rain on
 * cylinders around the camera, and lightning that strikes on snares and drops.
 *
 * DNA: g1 sea state (glass, swell, chop, mountainous), g2 time of day (golden,
 * day, blue hour, moonlit night), g3 camera (skim, aerial, trough, bobbing boat),
 * g4 weather (clear, broken, overcast, storm), g5 water body (tropical to ink),
 * g6 wind / swell direction and cloud grain, g7 sun bearing (into sun to sun behind).
 *
 * Music: the melody lights the sea: every note makes the water glow with phosphorescence
 * at a height set by the pitch (low notes in the troughs, high notes on the crests) and
 * flares the sun glitter. Kicks break whitecaps along the crests; snares drive a gust that
 * roughens the surface, and strike lightning when the sky is stormy. The waves run faster
 * when the music is louder, and the camera travels on the beats.
 */

/** Music clock: `beat` surges on every beat, `bar` steps on every bar, `sea` runs with loudness. */
const clk = { t: -1, b: 0, r: 0, beat: 0, bar: 0, sea: 0 };
function tickClock(m: MusicState) {
  const b = m.beatIndex + m.beatPhase + 0.095 * Math.sin(m.beatPhase * 2 * Math.PI);
  const e = Math.min(1, m.barPhase * 2);
  const r = m.barIndex + 0.5 * m.barPhase + 0.5 * e * e * (3 - 2 * e);
  const dt = m.time - clk.t;
  if (dt === 0) return;
  if (dt > 0 && dt < 0.25) {
    const drive = Math.min(1, m.energySlow * 5) * (0.25 + 0.6 * m.energySlow) + 0.5 * m.dropPulse;
    clk.beat += Math.min(Math.max(b - clk.b, 0), 1) * drive;
    clk.bar += Math.min(Math.max(r - clk.r, 0), 1) * drive;
    clk.sea += dt * (0.35 + 0.9 * m.energySlow + 0.5 * m.dropPulse);
  }
  clk.t = m.time;
  clk.b = b;
  clk.r = r;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const pick = (rows: number[][], x: number) => {
  const n = rows.length;
  const f = Math.min(x, 0.9999) * n;
  const i = Math.floor(f);
  return rows[i];
};

// swellAmp, swellLen, sharp, chopAmp, chopFreq, choppy, foam, chopSpeed
const SEA = [
  [0.25, 95, 1.0, 0.07, 0.15, 2.2, 0.0, 0.5],
  [1.0, 75, 1.6, 0.38, 0.16, 4.0, 0.3, 0.8],
  [1.2, 42, 2.0, 0.62, 0.21, 5.0, 0.75, 1.1],
  [3.4, 115, 2.6, 0.75, 0.14, 4.6, 1.0, 1.2],
];
// sunElev, sunInt, skyLumH, skyLumZ, stars
const TOD = [
  [0.07, 5.0, 0.3, 0.07, 0.0],
  [0.62, 3.2, 0.36, 0.15, 0.0],
  [-0.06, 0.0, 0.13, 0.035, 0.4],
  [0.28, 1.2, 0.085, 0.025, 1.0],
];
// cover, dark, rain, lightning
const WEATHER = [
  [0.0, 0.0, 0.0, 0.0],
  [0.42, 0.2, 0.0, 0.15],
  [0.72, 0.55, 0.25, 0.4],
  [0.9, 0.85, 1.0, 1.0],
];

export default raymarchScene({
  meta: {
    id: 'ocean-storm',
    name: 'Open Ocean',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.45, arousal: 0.5 },
    genres: { classical: 1, rock: 0.8, ambient: 0.8, dnb: 0.7, acoustic: 0.5, edm: 0.4 },
    trails: 0.2,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    tickClock(m);
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    mo.update(m, ctx.dt, g);
    // Eased envelopes, each scaled by its event's level (which carries the passage's presence). The
    // beats' are x1.6: the eased curve peaks near 0.6 of its target, so a full hit still lands fully.
    const kE = sat01(1.6 * glide(evs.kick, mo.kickLevel * Math.exp(-mo.kickAge / 0.3), dt));
    const sE = sat01(1.6 * glide(evs.snare, mo.snareLevel * Math.exp(-mo.snareAge / 0.35), dt));
    const nE = sat01(glide(evs.note, mo.noteLevel * Math.exp(-mo.leadAge / 0.35), dt));
    const antic = m.anticipation;
    const drop = m.dropPulse;

    const sea = pick(SEA, g[1]);
    const tod = pick(TOD, g[2]);
    const cam = Math.floor(Math.min(g[3], 0.9999) * 4);
    const wx = pick(WEATHER, g[4]);
    const seaIdx = Math.floor(Math.min(g[1], 0.9999) * 4);

    // Storm skies whip up at least a moderate sea; calm skies keep a calm sea quieter.
    const stormy = wx[2];
    const swellBoost = (0.75 + 0.45 * m.energySlow + 0.3 * m.bass + 0.25 * ctx.intensity) * (1 + 0.45 * antic + 0.5 * drop);
    const trough = cam === 2 ? 1.6 : 1;
    const swellAmp = Math.max(sea[0] * trough, 0.6 * stormy, cam === 2 ? 2.4 : 0) * swellBoost * lerp(0.85, 1.15, ev[0]);
    const wind = g[6] * Math.PI * 2 + (ev[1] - 0.5) * 0.5;

    // Camera.
    const heading = wind + [0.35, -0.9, Math.PI + 0.45, 0][cam] + (g[0] - 0.5) * 0.8 + (ev[2] - 0.5) * 0.6;
    const speed = [1.6, 2.2, 0.35, 0.25][cam];
    const turn = clk.bar * 0.5;
    p[0] = clk.beat * 0.6 * speed;
    // Heading wanders a little with the bars (the bobbing boat swings round slowly).
    p[1] = heading + Math.sin(turn * 0.04) * 0.12 + (cam === 3 ? turn * 0.05 : 0);
    p[2] = [1.4 + 1.6 * g[0], 26 + 22 * g[0], 0.55, 1.25][cam] + (cam === 1 ? 6 * ev[3] : 0);
    // The camera mode carries the snare's eased level in its fraction (the shader compares at .5).
    p[3] = cam + 0.45 * sE;
    p[4] = [0.0, -0.42 - 0.2 * g[0], 0.12, 0.02][cam] - 0.06 * antic + 0.05 * drop;
    p[5] = [1.35, 1.25, 1.05, 1.15][cam];
    p[6] = clk.sea; // sea time: the waves run faster when the music is louder
    p[7] = swellAmp;

    // Swell / chop.
    p[8] = swellAmp;
    p[9] = sea[1] * lerp(0.85, 1.2, g[0]);
    p[10] = sea[2];
    p[11] = wind;
    const chopWind = 1 + 0.6 * stormy + 0.5 * antic + 0.4 * drop;
    p[12] = Math.min(sea[3] * chopWind * (0.85 + 0.3 * m.energySlow), 0.95);
    p[13] = sea[4];
    p[14] = sea[5] + 0.8 * antic;
    p[15] = sea[6] * (1 + 0.5 * antic) + 0.35 * stormy;

    // Sun / sky.
    const bearing = [0.0, 0.9, -1.4, Math.PI][Math.floor(Math.min(g[7], 0.9999) * 4)];
    const sunAz = heading + bearing + (ev[3] - 0.5) * 0.4;
    p[16] = tod[0];
    p[17] = sunAz;
    p[18] = tod[1] * (1 - 0.8 * wx[0] * wx[1]);
    // Time of day, with the melody's eased level in the fraction.
    p[19] = Math.floor(Math.min(g[2], 0.9999) * 4) + 0.45 * nE;
    p[20] = tod[2] * (1 - 0.35 * wx[1]) * (1 - 0.3 * antic) * (1 + 0.5 * m.chordPulse * (1 - m.chordPulse));
    p[21] = tod[3] * (1 - 0.5 * wx[1]);
    p[22] = tod[4] * (1 - wx[0] * 0.8);
    p[23] = (g[7] * 3.7 + g[5] * 0.5) % 1;

    // Weather.
    p[24] = Math.min(1, wx[0] + 0.12 * antic + 0.15 * ev[0] - 0.07);
    p[25] = Math.min(1, wx[1] + 0.25 * antic + 0.2 * m.tension * wx[0]);
    p[26] = (wx[2] * (0.6 + 0.4 * m.energySlow) + 0.4 * antic * wx[0]) * (cam === 1 ? 0.35 : 1);
    p[27] = wx[3];

    // Water + misc.
    p[28] = g[5];
    p[29] = lerp(0.25, 1.4, 1 - g[5]) * (seaIdx === 0 ? 0.5 : 1);
    p[30] = lerp(0.7, 2.2, g[6]) * lerp(0.8, 1.2, ev[1]); // cloud grain
    p[31] = kE; // the kick's eased level
  },
  wgsl: /* wgsl */ `
// ---- uniforms ----
// p0: travel, heading, camHeight, camMode   p1: pitch, fov, seaTime, swellAmp(cam)
// p2: swellAmp, swellLen, sharp, wind       p3: chopAmp, chopFreq, choppy, foam
// p4: sunElev, sunAz, sunInt, tod           p5: skyLumH, skyLumZ, stars, hue
// p6: cover, dark, rain, lightning          p7: water, sss, cloudGrain, kick level

fn os_vn(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return -1.0 + 2.0 * mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x),
                          mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn os_swell(p: vec2f) -> f32 {
  let A = S.p[2].x;
  let L = S.p[2].y;
  let sharp = S.p[2].z;
  let th = S.p[2].w;
  var h = 0.0;
  for (var i = 0; i < 3; i++) {
    let fi = f32(i);
    let a = th + (fi - 0.8) * 0.42;
    let dir = vec2f(cos(a), sin(a));
    let lam = L * (1.0 - 0.27 * fi);
    let k = TAU / lam;
    let w = sqrt(9.8 * k);
    let ph = dot(p, dir) * k - w * S.p[1].z + fi * 1.7;
    let c = 0.5 + 0.5 * sin(ph);
    h += A * (1.0 - 0.32 * fi) * (2.0 * pow(c, sharp) - 1.0);
  }
  return h * 0.6;
}

fn os_oct(uv0: vec2f, choppy: f32) -> f32 {
  let uv = uv0 + os_vn(uv0);
  var wv = 1.0 - abs(sin(uv));
  let swv = abs(cos(uv));
  wv = mix(wv, swv, wv);
  return pow(1.0 - pow(wv.x * wv.y, 0.65), choppy);
}

fn os_chop(p: vec2f, oct: i32) -> f32 {
  var freq = S.p[3].y;
  var amp = S.p[3].x;
  var ch = S.p[3].z;
  let T = 1.0 + S.p[1].z * 0.8;
  let r = rot2(-S.p[2].w) * p;
  var uv = vec2f(r.x * 0.75, r.y);
  var h = 0.0;
  let m = mat2x2f(1.6, 1.2, -1.2, 1.6);
  for (var i = 0; i < oct; i++) {
    var d = os_oct((uv + T) * freq, ch);
    d += os_oct((uv - T) * freq, ch);
    h += d * amp;
    uv = m * uv;
    freq *= 1.9;
    amp *= 0.22;
    ch = mix(ch, 1.0, 0.2);
  }
  return h - S.p[3].x * 1.1;
}

// The rendered sea: snares drive a gust that roughens the chop. The camera rides os_hc, without it.
// Eased event levels (scaled by each hit's strength and the passage's presence).
fn os_kick() -> f32 { return S.p[7].w; }
fn os_snare() -> f32 { return fract(S.p[0].w) / 0.45; }
fn os_note() -> f32 { return fract(S.p[4].w) / 0.45; }
fn os_h(p: vec2f, oct: i32) -> f32 { let s = os_snare(); return os_swell(p) + os_chop(p, oct) * (1.0 + 0.55 * s * s); }
fn os_hc(p: vec2f, oct: i32) -> f32 { return os_swell(p) + os_chop(p, oct); }

fn os_sunDir() -> vec3f {
  let e = S.p[4].x;
  let a = S.p[4].y;
  return normalize(vec3f(sin(a) * cos(e), sin(e), cos(a) * cos(e)));
}

// Natural tint per time of day, blended with the palette for hue.
fn os_horizonCol() -> vec3f {
  let tod = S.p[4].w;
  let nat = select(select(select(vec3f(0.05, 0.08, 0.2), vec3f(0.45, 0.35, 0.6), tod < 2.5), vec3f(0.6, 0.78, 1.0), tod < 1.5), vec3f(1.0, 0.55, 0.3), tod < 0.5);
  let pc = palL(S.p[5].w + 0.6 + F.morph2.x * 0.1, 1.0);
  let c = mix(nat / max(luma(nat), 0.02), pc, 0.5);
  return c / max(luma(c), 0.02);
}
fn os_zenithCol() -> vec3f {
  let tod = S.p[4].w;
  let nat = select(vec3f(0.25, 0.45, 1.0), vec3f(0.12, 0.2, 0.8), tod > 1.5);
  let c = mix(nat / luma(nat), palL(S.p[5].w + 0.3, 1.0), 0.45);
  return c / max(luma(c), 0.02);
}
fn os_sunCol() -> vec3f {
  let tod = S.p[4].w;
  let nat = select(select(vec3f(1.0, 0.95, 0.85), vec3f(1.0, 0.55, 0.25), tod < 0.5 || (tod > 1.5 && tod < 2.5)), vec3f(0.75, 0.85, 1.0), tod > 2.5);
  return mix(nat, palL(S.p[5].w + 0.8, luma(nat)), 0.25);
}

// Lightning: overall strength now (flickers), and the bolt bearing for this beat.
fn os_flash() -> f32 {
  let beat = floor(F.songTime * F.bpm / 60.0);
  let lv = S.p[6].w;
  let gate = step(0.45, hash11(beat * 1.37 + 0.5));
  let chordSwell = 4.0 * F.chordPulse * (1.0 - F.chordPulse);
  return lv * os_snare() * (0.35 + 0.65 * gate) * 1.4 + F.dropPulse * F.dropPulse * (0.3 + 1.4 * lv) + 0.3 * lv * chordSwell * F.tension;
}
fn os_boltAz() -> f32 {
  let beat = floor(F.songTime * F.bpm / 60.0);
  return S.p[0].y + (hash11(beat * 7.13) - 0.5) * 1.6;
}

fn os_clouds(rd: vec3f) -> vec4f {
  let cover = S.p[6].x;
  if (rd.y < 0.004 || cover < 0.02) { return vec4f(0.0); }
  let grain = S.p[7].z;
  let uv = rd.xz / (rd.y + 0.06) * grain * 0.9 + vec2f(S.p[1].z * 0.012, S.p[1].z * 0.006) + vec2f(S.p[0].x * 0.004, 0.0);
  let q = vec3f(uv.x, uv.y * 1.25, S.p[1].z * 0.01);
  let n = fbmFast(q, 5) + 0.12 * F.tension * noise3fast(q * 3.0);
  let thr = 0.32 - cover * 0.7;
  let d = smoothstep(thr, thr + 0.35 + 0.2 * (1.0 - cover), n);
  // Light toward the sun: density gradient gives silver linings.
  let sd = os_sunDir();
  let n2 = fbmFast(q + vec3f(sd.x, sd.z, 0.0) * 0.18, 3);
  let lit = sat(0.55 + (n - n2) * 3.0);
  let dark = S.p[6].y;
  let skyL = S.p[5].x;
  let sunI = S.p[4].z;
  let base = os_zenithCol() * skyL * mix(0.55, 0.3, dark) + vec3f(0.008);
  var c = base + os_sunCol() * lit * (0.04 * sunI) * (1.0 - 0.75 * dark);
  // Bright rims where the cloud thins in front of the sun.
  let toward = pow(sat(dot(rd, sd)), 6.0);
  c += os_sunCol() * toward * (1.0 - d) * sunI * 0.25 * (1.0 - dark);
  // Internal lightning glow around the bolt bearing.
  let fl = os_flash();
  let az = atan2(rd.x, rd.z);
  let dA = abs(fract((az - os_boltAz()) / TAU + 0.5) - 0.5) * TAU;
  c += vec3f(0.75, 0.8, 1.0) * fl * exp(-dA * 2.5) * (0.3 + 0.7 * n2 * n2 * 4.0) * 0.9;
  let horizonFade = mix(smoothstep(0.0, 0.05, rd.y), 1.0, cover * cover);
  return vec4f(c, d * horizonFade * 0.95);
}

fn os_bolt(rd: vec3f) -> f32 {
  let fl = os_flash();
  let lv = S.p[6].w;
  let bg = step(1.0 - 0.75 * lv, hash11(floor(F.songTime * F.bpm / 60.0) * 2.71 + 0.3)) + step(0.3, F.dropPulse);
  if (fl < 0.02 || lv < 0.35 || bg < 0.5) { return 0.0; }
  let e = rd.y;
  let top = 0.3;
  if (e < -0.01 || e > top) { return 0.0; }
  let az = atan2(rd.x, rd.z);
  let beat = floor(F.songTime * F.bpm / 60.0);
  let dx = (fract((az - os_boltAz()) / TAU + 0.5) - 0.5) * TAU;
  let s = e / top;
  let jag = os_vn(vec2f(s * 4.0, beat)) * 0.09 + os_vn(vec2f(s * 17.0, beat + 3.0)) * 0.025 + os_vn(vec2f(s * 70.0, beat)) * 0.004;
  let d1 = abs(dx - jag);
  let split = 0.55;
  let br = abs(dx - jag - (split - s) * 0.12 - os_vn(vec2f(s * 30.0, beat + 9.0)) * 0.01) + select(1.0, 0.0, s < split);
  let w = 0.0018;
  let core = exp(-d1 / w) + 0.6 * exp(-br / (w * 0.8));
  let glow = exp(-min(d1, br) * 60.0) * 0.25;
  return (core + glow) * fl * smoothstep(0.0, 0.08, top - e + 0.02);
}

fn os_sky(rdIn: vec3f, disc: bool) -> vec3f {
  let rd = normalize(vec3f(rdIn.x, max(rdIn.y, 0.0), rdIn.z));
  let y = rd.y;
  let skyH = S.p[5].x;
  let skyZ = S.p[5].y;
  let sd = os_sunDir();
  let sunC = os_sunCol();
  var col = mix(os_horizonCol() * skyH, os_zenithCol() * skyZ, pow(sat(y * 2.2), 0.55));
  // Sun glow (also below the horizon at blue hour).
  let mu = dot(rd, sd);
  let sunI = S.p[4].z;
  let tod = S.p[4].w;
  let glowAmt = select(sunI, 1.2, tod > 1.5 && tod < 2.5);
  col += sunC * (pow(sat(mu), 8.0) * 0.12 + pow(sat(mu), 60.0) * 0.4) * glowAmt * (0.6 + 0.4 * (1.0 - S.p[6].y));
  col += sunC * exp(-abs(y - max(sd.y, -0.05)) * 18.0) * pow(sat(mu * 0.5 + 0.5), 4.0) * 0.08 * glowAmt;
  // Stars.
  let st = S.p[5].z;
  if (st > 0.01) {
    let g = rd * 300.0;
    let hs = hash13(floor(g));
    let star = smoothstep(0.996, 1.0, hs) * smoothstep(0.4, 0.0, length(fract(g) - 0.5));
    col += vec3f(0.9, 0.93, 1.0) * star * st * smoothstep(0.03, 0.25, y) * (0.8 + 1.5 * F.hat * hash11(hs * 31.0));
  }
  if (disc) {
    let r = select(0.022, 0.03, tod > 2.5);
    let dd = acos(clamp(mu, -1.0, 1.0));
    let edge = smoothstep(r, r * 0.85, dd);
    var dcol = sunC * select(30.0, 3.0, tod > 2.5);
    if (tod > 2.5) {
      let right = normalize(cross(vec3f(0.0, 1.0, 0.0), sd));
      let up = cross(sd, right);
      let lp = vec2f(dot(rd, right), dot(rd, up)) / r;
      dcol *= 0.75 + 0.35 * fbm3(vec3f(lp * 2.5, 1.0), 3);
    }
    col += dcol * edge * step(-0.01, sd.y) * (1.0 + 0.4 * F.kickNext);
  }
  let cl = os_clouds(rd);
  col = mix(col, cl.rgb, cl.a);
  // Flash lights the cloud deck faintly (the bolt and its cloud glow carry the strike).
  let fl = os_flash();
  col += vec3f(0.6, 0.65, 0.85) * fl * 0.025 * S.p[6].x;
  col += vec3f(0.85, 0.88, 1.0) * os_bolt(rd) * 6.0;
  return col;
}

fn os_fogCol(rd: vec3f) -> vec3f {
  let sd = os_sunDir();
  var c = os_horizonCol() * S.p[5].x * mix(0.9, 0.45, S.p[6].y);
  c += os_sunCol() * pow(sat(dot(normalize(vec3f(rd.x, 0.0, rd.z)), sd)), 6.0) * 0.08 * S.p[4].z * (1.0 - 0.7 * S.p[6].y);
  return c + vec3f(0.6, 0.65, 0.85) * os_flash() * 0.05 * S.p[6].x;
}

fn os_trace(ro: vec3f, rd: vec3f, jit: f32) -> f32 {
  let ceilY = abs(S.p[2].x) * 0.6 * 2.4 + S.p[3].x * 1.6 + 0.3;
  var t = 0.05 + jit * 0.1;
  if (ro.y > ceilY) {
    if (rd.y >= 0.0) { return -1.0; }
    t = max(t, (ro.y - ceilY) / -rd.y);
  }
  var lt = t;
  var found = false;
  for (var i = 0; i < 110; i++) {
    let p = ro + rd * t;
    let d = p.y - os_h(p.xz, 3);
    if (d < 0.0015 * t) { found = true; break; }
    if (rd.y > 0.0 && p.y > ceilY) { return -1.0; }
    lt = t;
    t += max(d * 0.55, 0.02 + 0.006 * t);
    if (t > 600.0) { break; }
  }
  if (!found) { return select(-1.0, 600.0, rd.y < 0.0); }
  var a = lt;
  var b = t;
  for (var k = 0; k < 6; k++) {
    let m = 0.5 * (a + b);
    let pm = ro + rd * m;
    if (pm.y - os_h(pm.xz, 3) < 0.0) { b = m; } else { a = m; }
  }
  return b;
}

fn os_rain(rd: vec3f, pxA: f32) -> f32 {
  let amt = S.p[6].z;
  if (amt < 0.02) { return 0.0; }
  var acc = 0.0;
  let hl = max(length(rd.xz), 0.05);
  let ang = atan2(rd.x, rd.z);
  let slant = 0.2 * sin(S.p[2].w * 3.0) + 0.15 * F.anticipation;
  for (var k = 0; k < 4; k++) {
    let fk = f32(k);
    let r = 1.2 + fk * fk * 2.2;
    let y = rd.y / hl * r;
    let dens = 9.0;
    let len = 1.6 + 0.6 * fk;
    let u = vec2f((ang * r + slant * y) * dens, (y + F.time * (11.0 + 3.0 * fk)) / len);
    let cell = floor(u);
    let h = hash12(cell + fk * 17.0);
    let fx = fract(u.x) - 0.15 - 0.7 * hash12(cell + 3.1);
    let fy = fract(u.y + h);
    let wpx = pxA * r * dens / hl;
    let wv = max(wpx * 0.7, 0.004);
    let streak = smoothstep(wv, 0.0, abs(fx)) * (min(0.7, wpx * 0.7) / wv) * smoothstep(0.0, 0.5, fy) * smoothstep(1.0, 0.8, fy);
    acc += streak * step(h, amt * 0.6) * (0.16 - fk * 0.025);
  }
  return acc;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let mode = S.p[0].w;
  let head = S.p[0].y;
  let fwd = vec2f(sin(head), cos(head));
  var side = vec2f(fwd.y, -fwd.x);
  var xz = fwd * S.p[0].x;
  if (mode > 1.5 && mode < 2.5) { xz = side * S.p[0].x * 3.0; }
  var camY = S.p[0].z;
  var roll = 0.03 * sin(S.p[1].z * 0.1);
  var pitch = S.p[1].x;
  if (mode < 0.5) {
    camY += os_swell(xz) * 0.9;
  } else if (mode > 1.5 && mode < 2.5) {
    // Trough: hold low so passing swells tower over the lens.
    camY += os_swell(xz) * 0.3;
  } else if (mode > 2.5) {
    // Ride the surface: height and tilt from the local swell.
    let e = 1.5;
    let h0 = os_swell(xz);
    let hx = os_swell(xz + side * e) - os_swell(xz - side * e);
    let hz = os_swell(xz + fwd * e) - os_swell(xz - fwd * e);
    camY += h0 + 0.25 * os_chop(xz, 1);
    roll += -atan(hx / (2.0 * e)) * 0.8;
    pitch += atan(hz / (2.0 * e)) * 0.6;
  }
  camY = max(camY, os_hc(xz, 3) + 0.3);
  let ro = vec3f(xz.x, camY, xz.y);
  let ta = ro + vec3f(fwd.x, sin(pitch) * 1.2, fwd.y);
  let cam = lookAt(ro, ta, roll);
  let fov = S.p[1].y + 0.12 * F.anticipation - 0.1 * F.dropPulse;
  let rd = normalize(cam * vec3f(q, fov));
  let jit = ign(frag);

  let sd = os_sunDir();
  let sunC = os_sunCol();
  let sunI = S.p[4].z;
  let skyL = S.p[5].x;
  let dark = S.p[6].y;
  let fl = os_flash();
  var col: vec3f;
  let t = os_trace(ro, rd, jit);
  if (t < 0.0) {
    col = os_sky(rd, true);
  } else {
    var p = ro + rd * t;
    if (t >= 599.0) { p = ro + rd * (-(ro.y) / min(rd.y, -0.0005)); }
    let dist = length(p - ro);
    let oct = select(select(5, 4, dist > 30.0), 3, dist > 120.0);
    let e = 0.02 + dist * 0.0025;
    let h0 = os_h(p.xz, oct);
    let hx = os_h(p.xz + vec2f(e, 0.0), oct);
    let hz = os_h(p.xz + vec2f(0.0, e), oct);
    var n = normalize(vec3f(h0 - hx, e, h0 - hz));
    n = normalize(mix(n, vec3f(0.0, 1.0, 0.0), sat(dist / 500.0) * 0.6));

    let fres = sat(pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * 0.65 + 0.02);
    var rr = reflect(rd, n);
    rr = normalize(vec3f(rr.x, abs(rr.y), rr.z));
    let refl = os_sky(rr, false);

    // Water body: deep tone plus a turquoise scatter colour, both following the palette.
    let w = S.p[7].x;
    let deepNat = mix(vec3f(0.0, 0.12, 0.16), vec3f(0.01, 0.03, 0.08), w);
    let deep = mix(deepNat / luma(deepNat), palL(S.p[5].w + 0.15, 1.0), 0.4) * (0.015 + 0.06 * skyL);
    let sssNat = mix(vec3f(0.1, 0.75, 0.6), vec3f(0.1, 0.35, 0.55), w);
    let sssC = mix(sssNat / luma(sssNat), palL(S.p[5].w + 0.45, 1.0), 0.35);
    let amb = skyL * 0.6 + 0.02;
    let dif = pow(sat(dot(n, sd) * 0.4 + 0.6), 40.0);
    var refr = deep + sssC * dif * 0.03 * (sunI * 0.2 + amb);
    // Subsurface: crests and sun-backlit wave faces glow.
    let swellA = abs(S.p[2].x) + 0.3;
    let crest = sat((p.y + swellA * 0.4) / (swellA * 1.6 + S.p[3].x * 2.0));
    let back = pow(sat(dot(rd, sd) * 0.5 + 0.5), 3.0) * sat(1.0 - n.y + 0.2);
    let atten = exp(-dist * 0.004);
    refr += sssC * crest * crest * S.p[7].y * (0.05 * amb + 0.06 * sunI * (0.25 + back)) * atten * (1.0 + 2.0 * os_note());
    col = mix(refr, refl, fres);

    // Sun specular with glitter on hats and spectrum.
    let hv = normalize(sd - rd);
    let sp = pow(sat(dot(n, hv)), 220.0) * sunI * 6.0 * (1.0 - dark * 0.8);
    col += sunC * sp * step(-0.02, sd.y);
    let gq = p.xz * 4.0;
    let gcell = floor(gq);
    let gdot = smoothstep(0.22, 0.05, length(fract(gq) - 0.5 - (hash33(vec3f(gcell, 1.0)).xy - 0.5) * 0.5)) * smoothstep(4.0, 12.0, dist);
    let gh = hash12(gcell);
    let glit = gdot * step(0.97 - 0.03 * F.hat, gh) * pow(sat(dot(n, hv)), 18.0) * (0.3 + 2.5 * spec(gh) + 2.0 * F.hat + 2.5 * os_note()) * sunI;
    col += sunC * glit * atten * step(-0.02, sd.y) * 0.5;

    // Melody: the water glows with phosphorescence at a height set by the pitch (troughs for low
    // notes, crests for high ones); each note flares it, a held note keeps a faint glow.
    // The glow is carried by plankton: fine streaks along the wind, not a uniform sheet.
    // Height within the local wind waves, so every stretch of sea has troughs and crests to light.
    let wh = sat(0.5 + (p.y - os_swell(p.xz)) / (S.p[3].x * 2.2 + 0.08));
    let lh = wh - (0.5 + 0.3 * F.leadPitch);
    let wq = rot2(-S.p[2].w) * p.xz;
    let plank = noise3fast(vec3f(wq.x * 1.6, wq.y * 5.0, S.p[1].z * 0.4)) * 0.5 + noise3fast(vec3f(wq * 7.0, 3.0)) * 0.5;
    let streak = smoothstep(0.05, 0.6, plank);
    let phos = exp(-lh * lh * 25.0) * streak * (4.0 * os_note() + 0.12 * F.leadHeld) * exp(-dist * 0.01);

    // Foam: crests, whitecaps on kicks, streaks along the wind.
    let foamAmt = S.p[3].w;
    if (foamAmt > 0.01) {
      let ch = os_chop(p.xz, 2) / max(S.p[3].x, 0.05);
      let wr = rot2(-S.p[2].w) * p.xz;
      let fn1 = fbmFast(vec3f(wr.x * 0.35, wr.y * 1.1, S.p[1].z * 0.15), 4);
      let crestF = ch * 0.5 + crest * 0.45 + 0.85 * os_kick() + 0.6 * F.dropPulse + 0.1 * F.kickNext;
      let thr = 1.45 - 0.6 * foamAmt;
      let foam = smoothstep(thr, thr + 0.35, crestF + fn1 * 0.5) * (0.5 + 0.5 * smoothstep(-0.2, 0.3, fn1));
      let lace = smoothstep(0.1, 0.0, abs(fn1 - 0.05)) * smoothstep(thr - 0.4, thr, crestF) * 0.4;
      let fCol = mix(vec3f(1.0), sssC, 0.2) * (amb * 0.75 + sunI * 0.08 * sat(dot(n, sd) + 0.3) + 0.02);
      col = mix(col, fCol, sat(foam + lace) * foamAmt * mix(1.0, 0.5, sat(dist / 300.0)));
    }
    // Lightning lights the sea (mostly as a reflection).
    col += vec3f(0.6, 0.65, 0.85) * fl * 0.25 * fres;

    // Haze to horizon (thicker in rain and storm).
    let fogD = 0.0035 + 0.006 * S.p[6].z + 0.002 * dark;
    col = mix(col, os_fogCol(rd), 1.0 - exp(-dist * fogD));
    // The glow sits on top of foam and shines through the haze (it is light, not paint).
    col += palL(S.p[5].w + 0.5 + 0.1 * F.leadPitch, 0.9) * phos * (0.4 + 0.6 * (1.0 - fres)) * exp(-dist * fogD * 0.5);
  }

  // Rain streaks lit by sky and lightning.
  let rain = os_rain(rd, 2.0 / (F.res.y * fov));
  col += (os_horizonCol() * skyL * 0.6 + vec3f(0.03) + vec3f(0.7, 0.75, 0.9) * fl * 0.8) * rain * 0.6;
  return vec4f(col, 1.0);
}
`,
});
