import { Spring } from '../anim';
import { Morph } from '../morph';
import { raymarchScene } from '../raymarchScene';

const pick = (g: number, n: number) => Math.min(n - 1, Math.floor(g * n));

/**
 * A night valley flown at low altitude, led by a lantern. The land is a landform (ridged
 * mountains, islands, dunes or a lake), not a readout of the spectrum: the
 * music acts on it.
 *
 *  - Melody: the lantern floats ahead of the camera over the river. Its height follows the
 *    lead's pitch, it lights the slopes around it, and each note attack flares it and
 *    sends a ring of light (and a small swell) across the ground beneath it.
 *  - Kick: a swell rolls away up the valley, lifting the land and lighting the lines it
 *    crosses (or, by grammar, the whole relief breathes).
 *  - Snare: the line work across the land flashes and the high crests flare.
 *  - Harmony: chord changes ease the sky, sun and mist toward the new chord's colour.
 *  - Form: anticipation flattens the land and swells the sun; the drop fires a shockwave
 *    ring across land and water. Travel speed follows tempo and energy.
 *
 * DNA picks:
 *  0 landform: canyon with a river, archipelago, dunes, mirror lake
 *  1 camera rig: low glide, aerial, side-tracking
 *  2 line style: neon grid + contours, contours only, clean, dense wireframe
 *  3 sky: retro banded sun, moon, dawn haze, eclipse corona
 *  4 relief: ridge vs mountain amplitude and mountain style
 *  5 kick grammar: rolling swell, breathing relief, swell + bar scan
 *  6 hue, 7 lantern side
 */

const st = {
  lastTime: -1,
  lanternY: -1,
  chordHue: 0, chordGlow: 0, lit: 0,
};
/** Only its event ages and levels are used: every reaction scales with how hard the hit was. */
const morph = new Morph(1);
const rise = (age: number, t: number) => {
  const x = Math.min(1, Math.max(0, age / t));
  return x * x * (3 - 2 * x);
};
/**
 * Event glows: each follows its hit's level (decaying with age) on a critically damped spring, so
 * it swells in over ~0.15 s, never lands in one frame, and a new hit never dips the last one.
 */
const env = { kick: new Spring(0, 0.05), lead: new Spring(0, 0.05), snare: new Spring(0, 0.04) };
/**
 * A front that travels with its event's age (the kick swell, the note ripple). A new event starts a
 * new front and the previous one keeps travelling and fading on its own, so nothing is cut off.
 */
class Fronts {
  n = -1;
  age = 9;
  lvl = 0;
  prevAge = 9;
  prevLvl = 0;
  update(count: number, age: number, lvl: number, dt: number): void {
    if (count !== this.n) {
      if (this.n >= 0 && count > this.n) {
        this.prevAge = this.age;
        this.prevLvl = this.lvl;
      }
      this.n = count;
    }
    this.prevAge = Math.min(9, this.prevAge + dt);
    this.age = age;
    this.lvl = lvl;
  }
  /** Strength of the latest (0) or previous (1) front: rises over t and fades by decay. */
  amp(which: 0 | 1, t: number, decay: number): number {
    const a = which ? this.prevAge : this.age;
    return (which ? this.prevLvl : this.lvl) * rise(a, t) * Math.exp(-a * decay);
  }
}
const swell = new Fronts();
const lantern = new Spring(0, 0.1);
const ripple = new Fronts();

export default raymarchScene({
  meta: {
    id: 'spectral-terrain',
    name: 'Lantern Valley',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.2, 0.85],
    mood: { valence: 0.6, arousal: 0.5 },
    genres: { synthwave: 1, lofi: 0.8, pop: 0.7, edm: 0.6, hiphop: 0.5, techno: 0.5 },
    trails: 0.3,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    if (Math.abs(m.time - st.lastTime) > 0.5) {
      st.chordGlow = 0; st.lit = 0; st.lanternY = -1;
      env.kick.reset(0); env.lead.reset(0); env.snare.reset(0);
      st.chordHue = m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : 0;
    }
    st.lastTime = m.time;
    morph.update(m, ctx.dt, ctx.dna);
    const ka = Math.min(morph.kickAge, 3);
    const la = Math.min(morph.leadAge, 3);
    const kickEnv = env.kick.update(morph.kickLevel * Math.exp(-ka * 3.2), dt);
    const leadEnv = env.lead.update(morph.noteLevel * Math.exp(-la * 5), dt);
    const snare = env.snare.update(morph.snareLevel * Math.exp(-morph.snareAge * 4), dt);
    swell.update(morph.kicks, ka, morph.kickLevel, dt);
    ripple.update(morph.notes, la, morph.noteLevel, dt);
    // Chord: ease the hue toward the new root (shortest way round), glow with a soft attack.
    const target = m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : st.chordHue;
    let dh = target - st.chordHue;
    dh -= Math.round(dh);
    st.chordHue += dh * (1 - Math.exp(-dt / 0.45));
    st.chordGlow += (m.chordPulse - st.chordGlow) * (1 - Math.exp(-dt / (m.chordPulse > st.chordGlow ? 0.08 : 0.5)));
    // Lantern: sustained glow while a note is held, smooth release in rests.
    const litT = 0.35 + 0.65 * m.leadHeld * morph.presence;
    st.lit += (litT - st.lit) * (1 - Math.exp(-dt / (litT > st.lit ? 0.15 : 0.6)));

    const v = g[4];
    const h = (k: number) => {
      const x = Math.sin(v * 12.9898 * k + k * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    // Landforms 0 canyon, 1 archipelago, 2 dunes, 4 lake (3 was a boxy canal city, retired).
    const fam = [0, 1, 2, 4][pick(g[0], 4)];
    const rig = pick(g[1], 3);
    const lines = pick(g[2], 4);
    const sky = pick(g[3], 4);
    const motion = pick(g[5], 3);
    const antic = m.anticipation;
    // Camera: forward glide (travel follows tempo and energy, surging on kicks), sway, height, bank.
    const camZ = ctx.travel * (0.9 + 0.5 * h(1)) * (rig === 1 ? 1.3 : 1);
    p[0] = camZ;
    p[1] = fam === 4 ? 0.4 + 0.4 * h(2) : 0.6 + 0.9 * h(2);
    const famLift = [0, 1.0, 1.1, 0.1, 0][fam];
    const rigH = rig === 1 ? 3.6 + 0.8 * h(3) : 0.95 + 0.7 * h(3);
    const camH = rigH + famLift + 0.15 * m.energySlow - 0.25 * antic;
    p[2] = camH;
    p[3] = 0.08 + 0.14 * h(4);
    // Relief (flattens under anticipation; the breathing grammar pumps it on kicks), mountains, style.
    p[4] = (1.5 + 1.2 * ctx.intensity + 0.6 * m.energySlow + 0.8 * m.dropPulse) * (1 - 0.65 * antic) * (0.7 + 0.6 * h(14)) * (motion === 1 ? 1 + 0.22 * kickEnv : 1);
    p[5] = (1.1 + 0.9 * h(5)) * (1 - 0.35 * antic);
    p[6] = h(6);
    p[7] = st.chordHue * 0.12;
    // Sun / sky.
    p[8] = (0.15 + 0.06 * h(8) + 0.09 * antic + 0.015 * m.kickNext + 0.03 * m.dropPulse) * (sky === 2 ? 1.4 : 1);
    p[9] = (0.06 + 0.06 * h(9)) * (rig === 1 ? 1.8 : 1);
    p[10] = sky;
    p[11] = (h(11) - 0.5) * 0.4;
    // Lines and light.
    p[12] = g[6] + ctx.evolve[2] * 0.25;
    p[13] = lines === 3 ? 0.35 + 0.15 * h(13) : 0.6 + 0.8 * h(13);
    p[14] = 0.5 + 1.0 * ctx.intensity + 2.0 * m.dropPulse;
    p[15] = (1 - 0.6 * antic) * (sky === 2 ? 1.6 : 1);
    // S.p[4]: family, rig, line style, motion
    p[16] = fam;
    p[17] = rig;
    // Style ints, with the previous kick swell's / note ripple's strength in the fraction (< 0.5).
    p[18] = lines + 0.45 * Math.min(1, motion === 1 ? 0 : swell.amp(1, 0.1, 3.2));
    p[19] = motion + 0.45 * Math.min(1, ripple.amp(1, 0.15, 2.2));
    // S.p[5]: kick swell radius (ahead of the camera), swell amplitude, snare, chord glow
    // Latest and previous swell radii (x10) packed in one slot.
    const sr = (a: number) => Math.round((2.5 + Math.min(a, 3) * 20) * 10);
    p[20] = sr(swell.age) + 1024 * sr(swell.prevAge);
    p[21] = motion === 1 ? 0 : swell.amp(0, 0.1, 3.2);
    p[22] = snare;
    p[23] = st.chordGlow;
    // S.p[6]: lantern position, intensity. Pitch sets its height.
    const side = g[7] < 0.5 ? -1 : 1;
    const lz = camZ + 6.5;
    const sway = p[1] * (Math.sin(lz * 0.061) * 1.4 + Math.sin(lz * 0.023 + 1.3) * 1.9);
    const base = rig === 1 ? 1.2 : 0.5 + 0.45 * camH;
    p[24] = sway + side * 0.35;
    // The lantern glides to each note's height instead of jumping there.
    const ly = base + 0.75 * (1 + m.leadPitch) + (fam === 1 || fam === 2 ? 0.4 : 0);
    if (st.lanternY < 0) lantern.reset(ly);
    st.lanternY = lantern.update(ly, dt);
    p[25] = st.lanternY;
    p[26] = lz;
    p[27] = st.lit + 1.4 * leadEnv;
    // S.p[7]: lead ripple radius, ripple amplitude, lantern hue offset, kick env (breathing grammar)
    // Latest and previous ripple radii (x100) packed in one slot.
    const rr = (a: number) => Math.round((0.2 + Math.min(a, 3) * 6.5) * 100);
    p[28] = rr(ripple.age) + 2048 * rr(ripple.prevAge);
    p[29] = ripple.amp(0, 0.15, 2.2);
    p[30] = 0.12 * m.leadPitch;
    p[31] = kickEnv;
  },
  wgsl: /* wgsl */ `
const ST_WATER: f32 = 0.0;

var<private> stFam: i32;

fn st_camZ() -> f32 { return S.p[0].x; }
fn st_pathX(z: f32) -> f32 { return S.p[0].y * (sin(z * 0.061) * 1.4 + sin(z * 0.023 + 1.3) * 1.9); }
fn st_hue() -> f32 { return S.p[3].x + S.p[1].w; }
// Kick swells and note ripples: the latest and the previous front, radii and strengths.
fn st_swellR() -> vec2f { let v = S.p[5].x; return vec2f(fmod(v, 1024.0), floor(v / 1024.0)) / 10.0; }
fn st_swellA() -> vec2f { return vec2f(S.p[5].y, fract(S.p[4].z) / 0.45); }
fn st_ripR() -> vec2f { let v = S.p[7].x; return vec2f(fmod(v, 2048.0), floor(v / 2048.0)) / 100.0; }
fn st_ripA() -> vec2f { return vec2f(S.p[7].y, fract(S.p[4].w) / 0.45); }
// Sum of the two kick swells at distance rel up the valley (gaussian width k).
fn st_swell(rel: f32, k: f32) -> f32 { let q = vec2f(rel) - st_swellR(); return dot(exp(-q * q * k), st_swellA()); }
// Sum of the two note ripples at distance d from the lantern's foot.
fn st_ring(d: f32, k: f32) -> f32 { let q = vec2f(d) - st_ripR(); return dot(exp(-q * q * k), st_ripA()); }
fn st_ringWave(d: f32) -> f32 { let q = vec2f(d) - st_ripR(); return dot(sin(q * 9.0) * exp(-q * q * 4.0), st_ripA()); }
fn st_lanternCol() -> vec3f { return palL(st_hue() + 0.85 + S.p[7].z, 1.0); }

/** Heightfield. oct = fbm octaves; oct > 3 adds fine rock detail (normals only). */
fn st_h(p: vec2f, oct: i32) -> f32 {
  let rel = p.y - st_camZ();
  let dx = abs(p.x - st_pathX(p.y));
  let far = smoothstep(6.0, 50.0, rel);
  var h: f32;

  {
    let nz = noise4(vec3f(p * vec2f(0.6, 0.45), 7.7));
    // Sharp ridges riding on the mountains.
    let rr = 1.0 - abs(nz.w);
    let rdg = S.p[1].x * 0.5 * rr * rr * rr * (0.7 + 0.55 * nz.y);
    var mount = 0.0;
    if (stFam != 1) {
      let n = fbm3(vec3f(p * 0.11, 1.3), oct);
      let ridge = 1.0 - abs(n * 2.0);
      let mshape = mix(sat(n + 0.5), ridge * ridge, S.p[1].z);
      mount = S.p[1].y * mshape * (0.35 + 1.75 * far);
    }
    if (stFam == 1) {
      // Archipelago: fbm islands rising from the sea, ridges only on land.
      let isl = fbm3(vec3f(p * 0.16, 2.1), oct);
      let land = isl * 2.6 + 0.12 + 0.4 * far;
      h = land * (0.8 + 0.4 * S.p[1].y) + rdg * 0.6 * smoothstep(-0.05, 0.25, land);
    } else if (stFam == 2) {
      // Dunes: sharp-crested sand ridges.
      let w = p.x * 0.42 + 0.9 * sin(p.y * 0.13) + 0.5 * nz.x;
      let crest = 1.0 - abs(sin(w));
      let trough = smoothstep(0.6, 3.0, dx);
      h = 0.45 + (0.55 * S.p[1].y * crest * crest + 0.3 * rdg + mount * 0.5) * mix(0.3, 1.0, trough);
    } else if (stFam == 4) {
      // Mirror lake ringed by ridges.
      let shore = smoothstep(3.2, 6.0, dx);
      h = shore * (rdg + mount) - 0.25 * (1.0 - shore);
    } else {
      let valley = smoothstep(0.7, 3.8, dx);
      h = valley * (rdg + mount);
      h += nz.z * 0.12 * (0.3 + h * 0.4);
      // River bed.
      h -= 0.4 * (1.0 - valley);
    }
    if (oct > 3) {
      let d = noise4(vec3f(p * 3.3, 5.0));
      h += (d.x * 0.05 + d.y * 0.02) * (0.3 + max(h, 0.0) * 0.5) * select(1.0, 0.3, stFam == 2);
    }
  }

  let land = smoothstep(0.7, 3.8, dx);
  // Kick: a swell rolling away up the valley.
  if (dot(st_swellA(), vec2f(1.0)) > 0.004) {
    h += 0.32 * st_swell(rel, 0.35) * mix(0.35, 1.0, land);
  }
  // Melody: a ring swell spreading from beneath the lantern on each note.
  if (dot(st_ripA(), vec2f(1.0)) > 0.004) {
    h += 0.09 * st_ring(length(p - S.p[6].xz), 3.0);
  }
  // Drop shockwave: expanding ring centred ahead of the camera.
  let c = vec2f(st_pathX(st_camZ() + 14.0), st_camZ() + 14.0);
  let r = length(p - c);
  let R = (1.0 - F.dropPulse) * 38.0;
  h += F.dropPulse * 1.4 * exp(-(r - R) * (r - R) * 0.6) * (0.3 + 0.7 * land);
  return h;
}

fn st_normal(p: vec3f, e: f32, oct: i32) -> vec3f {
  let hx = st_h(p.xz + vec2f(e, 0.0), oct) - st_h(p.xz - vec2f(e, 0.0), oct);
  let hz = st_h(p.xz + vec2f(0.0, e), oct) - st_h(p.xz - vec2f(0.0, e), oct);
  return normalize(vec3f(-hx, 2.0 * e, -hz));
}

/** Heightfield march with binary refinement. Returns t or -1. */
fn st_march(ro: vec3f, rd: vec3f, t0: f32, tmax: f32, steps: i32, oct: i32) -> f32 {
  var t = t0;
  var lt = t0;
  // Open landforms (sea, dunes, lake) send many grazing rays to the horizon: stride faster.
  let open = stFam == 1 || stFam == 2 || stFam == 4;
  let minStep = select(0.008, 0.017, open);
  let ceilY = select(9.0, 5.0, open);
  for (var i = 0; i < steps; i++) {
    let p = ro + rd * t;
    let d = p.y - max(st_h(p.xz, oct), ST_WATER);
    if (d < 0.0015 * t) {
      var a = lt; var b = t;
      for (var k = 0; k < 6; k++) {
        let m = 0.5 * (a + b);
        let pm = ro + rd * m;
        if (pm.y - max(st_h(pm.xz, oct), ST_WATER) < 0.0) { b = m; } else { a = m; }
      }
      return b;
    }
    if (rd.y > 0.0 && p.y > ceilY) { break; }
    lt = t;
    t += max(d * 0.5, 0.015 + minStep * t);
    if (t > tmax) { break; }
  }
  return -1.0;
}

fn st_sunDir() -> vec3f { return normalize(vec3f(S.p[2].w, S.p[2].y, 1.0)); }

/**
 * The lantern seen along a ray that ends at tmax: a hot core (hidden behind terrain) plus the
 * light it scatters in the valley air, integrated analytically over the visible ray.
 */
fn st_lantern(ro: vec3f, rd: vec3f, tmax: f32) -> vec3f {
  let oc = S.p[6].xyz - ro;
  let tc = dot(oc, rd);
  let d2 = max(dot(oc, oc) - tc * tc, 0.0);
  let I = S.p[6].w;
  let lc = st_lanternCol();
  // In-scatter: integral of 1 / (d^2 + a^2) along the ray from 0 to tmax.
  let a2 = 0.03;
  let b = sqrt(d2 + a2);
  let te = min(tmax, 200.0);
  let scat = (atan((te - tc) / b) + atan(tc / b)) / b;
  var col = lc * scat * I * 0.05;
  if (tc > 0.0 && tc < tmax) {
    let r2 = 0.006 * (1.0 + 0.5 * I);
    let core = exp(-d2 / r2) * 7.0;
    col += mix(lc, vec3f(1.0, 0.97, 0.92), sat(core * 0.2)) * core * I;
  }
  return col;
}

fn st_sky(rd: vec3f, withSun: bool) -> vec3f {
  let y = rd.y;
  let bright = S.p[3].w;
  let mode = i32(S.p[2].z + 0.5);
  let sh = st_hue();
  let horizon = palL(sh + 0.6, 0.09);
  let zenith = palL(sh + 0.05, 0.012);
  var col = mix(horizon, zenith, pow(sat(y * select(2.4, 1.2, mode == 2) + 0.02), 0.5));
  col += palL(sh + 0.3, 0.05) * exp(-abs(y) * 25.0) * (1.0 + 1.5 * S.p[5].w);
  col *= bright;
  // Stars, fading toward the horizon and glinting with hats.
  let sc = rd * 260.0;
  let hs = hash13(floor(sc));
  let star = smoothstep(0.9975, 1.0, hs) * smoothstep(0.42, 0.0, length(fract(sc) - 0.5));
  col += vec3f(0.9, 0.95, 1.0) * star * smoothstep(0.05, 0.3, y) * (1.0 + 2.0 * F.hat * hash11(hs * 91.0)) * max(1.7 - bright, 0.0) * select(1.0, 0.0, mode == 2);

  let sd = st_sunDir();
  let rad = S.p[2].x;
  let ang = acos(clamp(dot(rd, sd), -1.0, 1.0));
  let sunTint = palL(sh + 0.75, 0.6);
  let haloK = select(1.0, 2.2, mode == 2);
  col += sunTint * (exp(-ang * 4.0) * 0.12 + exp(-ang * 12.0) * 0.25) * haloK * (0.7 + 0.5 * F.bass + 1.2 * F.dropPulse + 0.8 * F.anticipation + 0.8 * S.p[5].w);
  if (mode == 3) {
    // Eclipse corona.
    let ring = exp(-abs(ang - rad) * 60.0 / max(rad, 0.05) * 0.15) * (1.2 + 1.5 * S.p[7].w + 3.0 * F.dropPulse);
    col += palL(sh + 0.85, 1.4) * ring;
  }
  if (withSun && ang < rad * 1.03) {
    let right = normalize(cross(vec3f(0.0, 1.0, 0.0), sd));
    let up = cross(sd, right);
    let lp = vec2f(dot(rd, right), dot(rd, up)) / rad;
    let v = lp.y;
    // Retro cut bands in the lower part; gaps widen downward and drift down as we travel.
    let g = sat(-v * 0.8 + 0.2);
    let stripe = fract(v * 6.0 + S.p[0].x * 0.12);
    let bands = mix(smoothstep(g * 0.75 - 0.03, g * 0.75 + 0.03, stripe), 1.0, select(0.0, 1.0, mode != 0));
    let edge = smoothstep(1.0, 0.97, length(lp));
    let top = palL(sh + 0.85, 1.2);
    let bot = palL(sh + 0.3, 0.6);
    var disc = mix(bot, top, smoothstep(-0.9, 0.7, v)) * 0.8;
    if (mode == 1) {
      let maria = fbm3(vec3f(lp * 2.2, 2.0), 4);
      disc = palRampL(0.8, 0.45) * (0.8 + 0.35 * maria) * mix(0.8, 1.1, sat(v * 0.4 + 0.6));
    } else if (mode == 2) {
      disc = palL(sh + 0.85, 1.0);
    } else if (mode == 3) {
      disc = zenith * 0.3;
    }
    disc *= 1.0 + 0.35 * F.kickNext + 1.5 * F.dropPulse * select(1.0, 0.0, mode == 3) + 0.5 * F.anticipation;
    col = mix(col, disc, edge * bands);
  }
  return col;
}

/** Shade a terrain hit, including emissive grid / contour lines and the lantern's light. */
fn st_shade(p: vec3f, n: vec3f, rd: vec3f, t: f32, pxAngle: f32) -> vec3f {
  let rel = p.z - st_camZ();
  let sd = st_sunDir();
  let hgt = p.y;
  let sh = st_hue();
  let style = i32(S.p[4].z + 0.5);
  let motion = i32(S.p[4].w + 0.5);

  // Albedo per landform; back-lit by the sun, soft fill from the camera side.
  var base = mix(palRampL(0.05, 0.03), palRampL(0.4 + 0.3 * sat(hgt * 0.25), 0.07), sat(hgt * 0.3 + 0.1));
  if (stFam == 1) {
    base = mix(palRampL(0.75, 0.16), palRampL(0.35 + 0.2 * sat(hgt), 0.06), smoothstep(0.03, 0.3, hgt));
  } else if (stFam == 2) {
    base = palRampL(0.55 + 0.25 * sat(hgt * 0.4), 0.2);
  }
  let dif = sat(dot(n, sd));
  let fill = sat(dot(n, normalize(vec3f(-sd.x * 0.5, 0.7, -1.0))));
  let sky = 0.5 + 0.5 * n.y;
  let ao = sat(0.35 + 0.65 * smoothstep(-0.4, 1.6, hgt));
  let fre = pow(1.0 - sat(dot(n, -rd)), 3.0);
  var col = base * (0.18 * sky + 0.9 * dif + 0.35 * fill) * ao;
  col += palL(sh + 0.6, 0.35) * fre * dif * 0.6 * S.p[3].w;
  col += palL(sh + 0.85, 0.6) * pow(sat(dot(reflect(rd, n), sd)), 24.0) * 0.35 * ao;

  // Lantern light: a warm point light that the slopes around it catch.
  let lv = S.p[6].xyz - p;
  let ld2 = dot(lv, lv);
  let ldir = lv * inverseSqrt(max(ld2, 1e-4));
  let lI = S.p[6].w / (1.0 + ld2 * 0.3);
  let lc = st_lanternCol();
  col += (base * 4.0 + vec3f(0.03)) * lc * sat(dot(n, ldir)) * lI * 3.0;
  col += lc * pow(sat(dot(reflect(rd, n), ldir)), 16.0) * lI * 0.25 * ao;

  // Line footprint (world units per pixel, stretched at grazing angles).
  let foot = t * pxAngle / max(abs(dot(n, rd)), 0.15);
  let gs = S.p[3].y;
  // Grid fixed to the land. Distances are converted to along-surface distance so lines stay
  // thin on steep walls.
  let gx = abs(fract(p.x / gs - 0.5) - 0.5) * gs / max(sqrt(max(1.0 - n.x * n.x, 0.0)), 0.06);
  let gz = abs(fract(p.z / gs - 0.5) - 0.5) * gs / max(sqrt(max(1.0 - n.z * n.z, 0.0)), 0.06);
  let lw = 0.011;
  let wx = max(lw, foot);
  let grid = max(sat(1.0 - gx / wx), sat(1.0 - gz / wx)) * (lw / wx) * select(1.0, 0.0, style == 1 || style == 2);
  // Height contours.
  let cs = select(0.3, 0.15, style == 3);
  let slope = sqrt(max(1.0 - n.y * n.y, 0.0)) / max(n.y, 0.08);
  let cw = lw * max(slope, 0.3);
  let cf = max(cw, foot * slope) + 1e-4;
  let gc = abs(fract(hgt / cs - 0.5) - 0.5) * cs;
  let contour = sat(1.0 - gc / cf) * (cw / cf) * smoothstep(0.05, 0.4, hgt) * select(1.0, 0.0, style == 2);

  // Kick swell front (or the breathing relief) lights what it passes.
  var kf = st_swell(rel, 0.35);
  if (motion == 1) { kf = S.p[7].w * 0.6; }
  // Bar scan: a laser line sweeping the land each bar.
  var scan = 0.0;
  if (motion == 2) {
    let sz = F.barPhase * 30.0 - 1.0;
    scan = exp(-abs(rel - sz) * 6.0) * (0.3 + 0.7 * F.barPulse);
  }
  // Melody ripple ring beneath the lantern.
  let ripple = st_ring(length(p.xz - S.p[6].xz), 6.0);
  // Snare: the line work flashes everywhere, the high crests most.
  let snr = S.p[5].z;
  let crest = smoothstep(0.5, 1.6, hgt) * snr;
  // Drop ring.
  let c = vec2f(st_pathX(st_camZ() + 14.0), st_camZ() + 14.0);
  let ringR = (1.0 - F.dropPulse) * 38.0;
  let ring = exp(-abs(length(p.xz - c) - ringR) * 1.5) * F.dropPulse;

  let hue = sh + 0.25 * sat(hgt * 0.3) + F.morph2.x * 0.15;
  let gain = S.p[3].z;
  let fade = exp(-t * 0.03);
  let near = 1.0 + 3.0 * lI;
  let lines = grid + contour;
  col += palL(hue, 0.4) * grid * fade * gain * (0.35 + 0.4 * F.energySlow + 3.0 * snr) * near;
  col += palL(hue + 0.3, 0.4) * contour * fade * gain * (0.3 + 2.0 * snr + 2.5 * crest) * near;
  col += palL(sh + 0.7, 0.6) * kf * (0.6 + 5.0 * lines) * fade;
  col += lc * ripple * (0.5 + 4.0 * lines) * fade;
  col += palL(sh + 0.7, 0.4) * scan * 0.8 * fade;
  col += palL(sh + 0.6, 0.8) * fre * crest * 0.9 * fade;
  col += palL(sh + 0.85, 1.0) * ring * 1.8;
  return col;
}

fn st_fog(col: vec3f, rd: vec3f, t: f32, p: vec3f) -> vec3f {
  let hz = st_sky(normalize(vec3f(rd.x, max(rd.y, 0.0) * 0.3, rd.z)), false);
  let dens = select(1.0, 1.8, i32(S.p[2].z + 0.5) == 2);
  let fogAmt = 1.0 - exp(-t * 0.02 * dens - max(t - 30.0, 0.0) * 0.025);
  var c = mix(col, hz, fogAmt);
  // Low valley mist, glowing with the palette and the lantern.
  let mist = exp(-max(p.y + 0.2, 0.0) * 2.5) * (1.0 - exp(-t * 0.05));
  c += palL(st_hue() + 0.55, 0.05) * mist * (0.6 + F.mid + S.p[5].w);
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  stFam = i32(S.p[4].x + 0.5);
  let rig = i32(S.p[4].y + 0.5);
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let cz = st_camZ();
  let camH = S.p[0].z;
  let px = st_pathX(cz);
  let slopeX = st_pathX(cz + 0.5) - st_pathX(cz - 0.5);
  let ro = vec3f(px, camH, cz);
  var ta = vec3f(st_pathX(cz + 7.0), camH * 0.35 + 0.2, cz + 7.0);
  if (rig == 1) {
    ta = vec3f(st_pathX(cz + 9.0), 0.0, cz + 9.0);
  } else if (rig == 2) {
    let fwd = normalize(ta - ro);
    ta = ro + rotY(0.25) * fwd * 5.0 - vec3f(0.0, 0.3, 0.0);
  }
  let roll = -slopeX * S.p[0].w * select(3.0, 1.0, rig == 2);
  let cam = lookAt(ro, ta, roll);
  let fov = 1.55 + F.anticipation * 0.25 - F.dropPulse * 0.2;
  let rd = normalize(cam * vec3f(q, fov));
  let pxAngle = 2.0 / (F.res.y * fov);

  let open = stFam == 1 || stFam == 2 || stFam == 4;
  let t = st_march(ro, rd, 0.05 + ign(frag) * 0.04, select(90.0, 65.0, open), 100, 3);
  var col: vec3f;
  if (t < 0.0) {
    col = st_sky(rd, true);
  } else {
    let p = ro + rd * t;
    let th = st_h(p.xz, 3);
    if (th < ST_WATER) {
      // Wet water: rippled mirror reflecting terrain, sun and lantern.
      let calm = select(1.0, 0.35, stFam == 4);
      let rq = vec3f(p.x * 0.7, (p.z - cz * 0.2) * 4.0, cz * 0.35);
      let rn = noise4(rq);
      let rip = vec2f(rn.x * 0.35, rn.y * 1.6 + noise3(rq * 2.3) * 0.6);
      let c = vec2f(st_pathX(cz + 14.0), cz + 14.0);
      let rr = length(p.xz - c);
      let wave = sin(rr * 3.0 - F.time * 8.0) * exp(-abs(rr - (1.0 - F.dropPulse) * 38.0) * 0.4) * F.dropPulse;
      let dl = length(p.xz - S.p[6].xz);
      let lrip = st_ringWave(dl);
      let amp = (0.03 + 0.07 * F.bass) * calm + 0.25 * wave + 0.12 * lrip;
      let n = normalize(vec3f(rip.x * amp, 1.0, rip.y * amp));
      let rr2 = reflect(rd, n);
      let fre = 0.15 + 0.85 * pow(1.0 - sat(dot(n, -rd)), 5.0);
      var refl: vec3f;
      let t2 = st_march(p + vec3f(0.0, 0.02, 0.0), rr2, 0.05, select(50.0, 30.0, open), select(48, 32, open), select(2, 1, open));
      if (t2 < 0.0) {
        refl = st_sky(rr2, true);
      } else {
        let p2 = p + rr2 * t2;
        let n2 = st_normal(p2, 0.02 + 0.003 * t2, 2);
        refl = st_fog(st_shade(p2, n2, rr2, t + t2, pxAngle * 2.0), rr2, t2, p2);
      }
      refl += st_lantern(p, rr2, select(t2, 1e9, t2 < 0.0));
      col = mix(palL(st_hue() + 0.05, 0.01), refl, sat(fre + 0.4)) * 0.85;
      // Lantern glow pooled on the water around its foot.
      let lv = S.p[6].xyz - p;
      col += st_lanternCol() * S.p[6].w * 0.12 / (0.2 + dot(lv.xz, lv.xz));
      col += st_lanternCol() * st_ring(dl, 6.0) * 0.8 * exp(-t * 0.03);
      // The kick swell rolls across the water as a band of light.
      col += palL(st_hue() + 0.7, 0.6) * st_swell(p.z - cz, 0.35) * 0.5 * exp(-t * 0.03);
      // Grid rows continue faintly across the water, flashing on the snare.
      let foot = t * pxAngle / max(abs(rd.y), 0.05);
      let gs = S.p[3].y;
      let gz = abs(fract(p.z / gs - 0.5) - 0.5) * gs;
      let wx = max(0.012, foot);
      let style = i32(S.p[4].z + 0.5);
      col += palL(st_hue() + 0.5, 0.4) * sat(1.0 - gz / wx) * (0.012 / wx) * (0.3 + 2.0 * S.p[5].z) * S.p[3].z * exp(-t * 0.05) * select(1.0, 0.0, style == 1 || style == 2);
    } else {
      let n = st_normal(p, 0.012 + 0.0015 * t, 5);
      col = st_shade(p, n, rd, t, pxAngle);
    }
    col = st_fog(col, rd, t, p);
  }
  col += st_lantern(ro, rd, select(t, 1e9, t < 0.0));
  return vec4f(col, 1.0);
}
`,
});
