import { raymarchScene } from '../raymarchScene';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Flight through a volumetric cloudscape. One jittered march integrates cloud density
 * (low-frequency shape eroded by detail noise) with a short light march toward the sun,
 * a three-octave multiple-scattering approximation, dual-lobe phase (silver linings when
 * backlit) and powder darkening; clear air between clouds collects god rays. A cirrus
 * veil, sky, stars and a hazy ground below complete the world.
 *
 * DNA: g1 cloud type (cumulus field, cumulonimbus towers, stratus sea, mammatus ceiling),
 * g2 time of day (golden, noon, dusk afterglow, moonlit night), g3 altitude / camera
 * (below, between, skimming the tops, high above), g5 coverage and density, g6 sun
 * bearing (backlit to front-lit), g7 heading and cloud scale, g4 cirrus and haze, g0 seed.
 *
 * Events come from the shared morph: every light (the kick's shell, the snare's lightning cell, the
 * melody's lantern) scales with its event's level (which includes how loud the passage is) and
 * rises over about 0.1 s, the lantern's height glides with the pitch, and the drop eases in as a
 * surge, so a faint intro motif only glimmers and nothing snaps on in one frame.
 */

/** Event source: ages and levels (this world does not use the morph's shape coordinates). */
const morph = new Morph(1);
/**
 * A light answering one kind of event: its level squared (the level already carries how loud the
 * passage is, so a faint intro hit stays a glimmer while a full-mix hit lands fully), eased in over
 * `rise` seconds and fading with time constant `decay`. A new event rises from whatever is still
 * lit, so a quick retrigger never cuts the previous light off.
 */
class Flare {
  private n = -1;
  private carry = 0;
  value = 0;
  constructor(
    private readonly rise: number,
    private readonly decay: number,
  ) {}
  update(count: number, age: number, level: number): number {
    if (count !== this.n) {
      this.carry = this.n < 0 ? 0 : this.value;
      this.n = count;
    }
    const x = Math.min(1, age / this.rise);
    const fade = Math.exp(-age / this.decay);
    this.value = Math.max(this.carry * fade, level * level * x * x * (3 - 2 * x) * fade);
    return this.value;
  }
}
const fx = { lead: new Flare(0.12, 0.25), kick: new Flare(0.15, 0.33), snare: new Flare(0.15, 0.15) };
/** The melody's held strength and pitch, glided so the lantern never jumps. */
const held = new Spring(0, 0.1);
const pitch = new Spring(0, 0.3);

// Per cloud type: layer base, thickness, flight height, flight-corridor half-width and half-height.
const TYPES = [
  { base: 36, thick: 12, fly: 22, W: 30, H: 11 }, // cumulus canyon under a broken ceiling
  { base: 8, thick: 30, fly: 24, W: 34, H: 12 }, // cumulonimbus towers
  { base: 4, thick: 4.5, fly: 17, W: 30, H: 9 }, // skimming a stratus sea between banks
  { base: 26, thick: 6, fly: 17, W: 30, H: 9 }, // under a mammatus ceiling
];
// sunElev, sunI, skyLum
const TOD = [
  [0.08, 3.2, 0.2],
  [0.85, 3.4, 0.26],
  [-0.05, 0.8, 0.1],
  [0.4, 0.95, 0.05],
];

/** Lateral offset of the flight corridor at distance s along it (mirrored in WGSL cf_pathX). */
function pathX(s: number, A: number, ph: number): number {
  return A * (Math.sin(s * 0.0095 + ph) + 0.45 * Math.sin(s * 0.0215 + ph * 2.1));
}

const st = {
  z: 0, wind: 0, lastTime: -1,
  hue: 0, cp: 0,
};

export default raymarchScene({
  meta: {
    id: 'cloud-flight',
    name: 'Cloud Flight',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0, 0.7],
    mood: { valence: 0.7, arousal: 0.3 },
    genres: { ambient: 1, pop: 0.7, acoustic: 0.8, classical: 0.9, synthwave: 0.7, lofi: 0.6, jazz: 0.4 },
    trails: 0.3,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    morph.update(m, ctx.dt, g);
    const antic = m.anticipation;
    // The drop as the morph's surge: it swells in, never a one-frame jump.
    const drop = morph.surge;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const q = (x: number, n: number) => Math.floor(Math.min(x, 0.9999) * n);
    const type = q(g[1], 4);
    const T = TYPES[type];
    const tod = TOD[q(g[2], 4)];
    const chordHue = m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : st.hue;

    if (Math.abs(m.time - st.lastTime) > 0.5) {
      st.z = m.time * 3;
      st.wind = m.time * 0.05;
      held.reset(0);
      pitch.reset(m.leadPitch);
      st.hue = chordHue;
      st.cp = 0;
    }
    st.lastTime = m.time;

    // Flight advances with the beat and the energy, surges on kicks, and rests in silence.
    const beat = m.bpm / 60;
    const act = Math.min(1, 1.6 * m.energySlow);
    const kickEnv = fx.kick.update(morph.kicks, morph.kickAge, morph.kickLevel);
    const rate = beat * act * (0.45 + 0.9 * m.energy + 0.7 * kickEnv + 1.2 * drop) * (1 - 0.5 * antic);
    st.z += dt * rate * 3.2;
    st.wind += dt * beat * act * 0.05;

    // Kick: a shell of light expanding through the cloud banks. Snare: a lightning cell in a wall.
    const heldL = held.update(m.leadHeld * morph.presence ** 2, dt);
    const pitchL = pitch.update(Math.max(-1, Math.min(1, m.leadPitch)), dt);

    // Harmony eases the light: chord root tints sun and sky, a change swells the sunlight.
    const dh = ((chordHue - st.hue + 1.5) % 1) - 0.5;
    st.hue += dh * (1 - Math.exp(-dt / 0.5));
    st.cp += (m.chordPulse - st.cp) * (1 - Math.exp(-dt / 0.2));

    // Camera rides the corridor centreline, yawing into its bends and banking with them.
    const H0 = g[7] * Math.PI * 2;
    const A = 14 + 22 * ((g[3] * 5.3) % 1);
    const ph = g[0] * 50 * 0.37;
    const W = T.W * (0.85 + 0.3 * g[5]) * (1 - 0.25 * antic + 0.2 * drop);
    const u = pathX(st.z, A, ph);
    const fly = T.fly + (ev[1] - 0.5) * 1.5;
    const c = Math.cos(H0);
    const s = Math.sin(H0);
    p[0] = u * c + st.z * s;
    p[1] = fly;
    p[2] = -u * s + st.z * c;
    p[3] = H0 + Math.atan((pathX(st.z + 20, A, ph) - u) / 20);

    // Clouds.
    // (The surge rides in the fraction, below the type's 0.5 boundaries, for the lens.)
    p[4] = type + 0.4 * Math.min(1, drop);
    p[5] = T.base + (g[0] - 0.5) * 2;
    p[6] = T.thick * (0.8 + 0.4 * g[5]) * (1 + 0.15 * antic);
    p[7] = Math.min(1, 0.35 + 0.55 * g[5] + 0.15 * antic + 0.15 * m.tension + (ev[2] - 0.5) * 0.15);

    // Density, scale, seed, wind.
    p[8] = (0.6 + 0.8 * g[5]) * (1 + 0.3 * antic + 0.2 * m.tension);
    p[9] = 0.7 + 0.6 * ((g[7] * 3.3) % 1);
    p[10] = g[0] * 50;
    p[11] = st.wind;

    // Sun.
    const bearing = [0, 0.7, -1.3, 2.6][q(g[6], 4)] + (ev[3] - 0.5) * 0.5;
    p[12] = tod[0] + (ev[3] - 0.5) * 0.04;
    p[13] = H0 + bearing;
    p[14] = tod[1] * (1 - 0.35 * antic) * (1 - 0.2 * m.tension) * (1 + 0.5 * drop + 0.25 * st.cp);
    // Time of day, with the glided melody pitch (0..1) in the fraction (the comparisons use .5 marks).
    p[15] = q(g[2], 4) + 0.2 * Math.min(0.999, 0.5 + 0.5 * pitchL);

    // Sky, corridor height, cirrus, haze.
    p[16] = tod[2] * (1 - 0.25 * antic);
    p[17] = T.H * (1 - 0.15 * antic);
    p[18] = 0.2 + 0.8 * g[4];
    p[19] = 0.6 + 0.8 * ((g[4] * 2.7) % 1);

    // Hue (with the eased chord), shafts, path amplitude, corridor half-width.
    p[20] = (g[4] * 1.7 + g[6] * 0.3 + 0.3 * st.hue) % 1;
    p[21] = (0.5 + 0.8 * ctx.intensity + 1.5 * drop) * (1 - 0.4 * antic);
    p[22] = A;
    p[23] = W;

    // Frame heading, pitch, bank, melody light.
    const curv = -A * (0.0095 * 0.0095 * Math.sin((st.z + 12) * 0.0095 + ph) + 0.45 * 0.0215 * 0.0215 * Math.sin((st.z + 12) * 0.0215 + ph * 2.1));
    p[24] = H0;
    p[25] = 0.03 + 0.05 * antic - 0.03 * drop;
    p[26] = Math.max(-0.14, Math.min(0.14, -curv * 120));
    // The melody's lantern: swells on each attack by the note's strength, glows while the note is
    // held, dims in rests.
    p[27] = (0.06 * act + 0.35 * heldL + 2.4 * fx.lead.update(morph.notes, morph.leadAge, morph.noteLevel)) * (1 + 0.3 * drop);

    // Kick shell radius and strength, snare cell strength and placement (signed by side).
    p[28] = 18 + Math.min(morph.kickAge, 9) * 140;
    p[29] = kickEnv;
    p[30] = fx.snare.update(morph.snares, morph.snareAge, morph.snareLevel);
    const sn = morph.snares;
    const hs = Math.sin(sn * 12.9898) * 43758.5453;
    p[31] = (sn % 2 ? 1 : -1) * (50 + 40 * (hs - Math.floor(hs)));
  },
  wgsl: /* wgsl */ `
// p0: camera xyz, yaw                 p1: type, base, thick, coverage
// p2: density, scale, seed, wind      p3: sunElev, sunAz, sunI, tod
// p4: skyLum, corridor H, cirrus, haze p5: hue, shafts, path amplitude, corridor W
// p6: frame heading, pitch, bank, melody light   p7: kick shell r, kick amp, snare amp, snare place

fn cf_sunDir() -> vec3f {
  let e = S.p[3].x;
  let a = S.p[3].y;
  return normalize(vec3f(sin(a) * cos(e), sin(e), cos(a) * cos(e)));
}

fn cf_sunCol() -> vec3f {
  let tod = S.p[3].w;
  let e = max(S.p[3].x, 0.0);
  let warm = vec3f(1.0, 0.55 + 0.4 * sat(e * 3.0), 0.3 + 0.6 * sat(e * 2.5));
  let nat = select(select(warm, vec3f(1.0, 0.45, 0.35), tod > 1.5 && tod < 2.5), vec3f(0.7, 0.82, 1.0), tod > 2.5);
  let c = mix(nat, palL(S.p[5].x + 0.1, luma(nat)), 0.3);
  return c / max(luma(c), 0.05);
}

fn cf_skyCol(rd: vec3f) -> vec3f {
  let tod = S.p[3].w;
  let y = rd.y;
  let L = S.p[4].x;
  let hue = S.p[5].x + 0.08 * F.morph2.x;
  let zenNat = select(vec3f(0.18, 0.35, 0.9), vec3f(0.06, 0.08, 0.3), tod > 1.5);
  let horNat = select(select(vec3f(1.0, 0.62, 0.4), vec3f(0.7, 0.82, 1.0), tod > 0.5 && tod < 1.5), vec3f(0.9, 0.5, 0.6), tod > 1.5 && tod < 2.5);
  let zen = mix(zenNat / luma(zenNat), palL(hue + 0.5, 1.0), 0.4);
  let hor = mix(horNat / luma(horNat), palL(hue, 1.0), 0.4);
  var col = mix(hor * L * 1.1, zen * L * 0.45, pow(sat(y * 1.6 + 0.02), 0.5));
  // Below the horizon: haze fading to the ground's tone.
  col = mix(col, hor * L * 0.55, smoothstep(0.0, -0.25, y));
  let sd = cf_sunDir();
  let mu = sat(dot(rd, sd));
  col += cf_sunCol() * (pow(mu, 8.0) * 0.12 + pow(mu, 64.0) * 0.3) * S.p[3].z * 0.25 * (0.4 + 0.6 * L / 0.2);
  return col;
}

fn cf_sky(rd: vec3f) -> vec3f {
  var col = cf_skyCol(rd);
  let sd = cf_sunDir();
  let tod = S.p[3].w;
  let mu = dot(rd, sd);
  // Sun or moon disc.
  let r = select(0.012, 0.016, tod > 2.5);
  let dd = acos(clamp(mu, -1.0, 1.0));
  col += cf_sunCol() * smoothstep(r, r * 0.8, dd) * select(40.0, 4.0, tod > 2.5) * step(-0.02, sd.y);
  // Stars.
  let st = select(0.0, select(0.35, 1.0, tod > 2.5), tod > 1.5);
  if (st > 0.01 && rd.y > 0.0) {
    let g = rd * 300.0;
    let hs = hash13(floor(g));
    col += vec3f(0.9, 0.93, 1.0) * smoothstep(0.995, 1.0, hs) * smoothstep(0.4, 0.0, length(fract(g) - 0.5)) * st * smoothstep(0.0, 0.2, rd.y) * (0.7 + 0.6 * F.high * hash11(hs * 17.0));
  }
  // Cirrus veil, streaked along the wind; brightness follows the spectrum across the sky.
  if (rd.y > 0.01) {
    let ci = S.p[4].z;
    let uv = rd.xz / (rd.y + 0.05) * 0.6;
    let w = rot2(S.p[6].x) * uv;
    let n = fbmFast(vec3f(w.x * 0.6, w.y * 3.0, S.p[2].z) + vec3f(S.p[2].w * 0.5, 0.0, 0.0), 4);
    let c = smoothstep(0.05, 0.45, n + ci * 0.35 - 0.25) * ci * smoothstep(0.0, 0.15, rd.y);
    let band = spec(fract(atan2(rd.x, rd.z) / TAU + 0.5) * 0.8 + 0.05);
    let lit = cf_sunCol() * S.p[3].z * (0.05 + 0.25 * pow(sat(mu), 4.0)) + cf_skyCol(vec3f(0.0, 1.0, 0.0)) * 0.6;
    col = mix(col, lit * (0.8 + 0.6 * band), c * 0.6);
  }
  return col;
}

// ---- cloud density ----
var<private> cf_ro: vec3f;

fn cf_bubble(p: vec3f, ro: vec3f) -> f32 {
  // A clear bubble around the camera so it never sits inside an opaque wall.
  return smoothstep(1.2, 5.0, length(p - ro));
}

/** World xz -> (across, along) the flight corridor frame. */
fn cf_local(p: vec3f) -> vec2f {
  let h = S.p[6].x;
  return vec2f(p.x * cos(h) - p.z * sin(h), p.x * sin(h) + p.z * cos(h));
}
fn cf_world(u: f32, s: f32, y: f32) -> vec3f {
  let h = S.p[6].x;
  return vec3f(u * cos(h) + s * sin(h), y, -u * sin(h) + s * cos(h));
}
fn cf_pathX(s: f32) -> f32 {
  let ph = S.p[2].z * 0.37;
  return S.p[5].z * (sin(s * 0.0095 + ph) + 0.45 * sin(s * 0.0215 + ph * 2.1));
}

/** Cloud envelope: the layer's own clouds plus towering banks walling the flight corridor. */
fn cf_shape(p: vec3f, hi: bool) -> f32 {
  let l = cf_local(p);
  let off = l.x - cf_pathX(l.y);
  let side = select(-1.0, 1.0, off > 0.0);
  let cy = S.p[0].y;
  let W = S.p[5].w;
  let H = S.p[4].y;
  let seed = S.p[2].z;
  // Shadow and god-ray probes (hi = false) skip the fine detail.
  var bil = 0.0;
  var topN = 0.0;
  var lump = noise3fast(p * 0.045 + vec3f(seed));
  var sea = noise3fast(vec3f(p.xz * 0.02, seed + 9.0));
  if (hi) {
    bil = fbmFast(vec3f(l.y * 0.016, p.y * 0.025, side * 5.0 + seed), 2);
    topN = noise3fast(vec3f(l.y * 0.006, side * 3.0, seed + 5.0));
    lump = fbmFast(p * 0.045 + vec3f(seed), 2) + 0.4 * noise3fast(p * 0.11 + vec3f(seed + 2.0));
    sea = fbmFast(vec3f(p.xz * 0.02, seed + 9.0), 3);
  }
  let inner = W * (1.0 + 0.35 * bil) + 8.0 * lump;
  let topY = cy + H * (0.3 + 1.6 * sat(topN + 0.5));
  let botY = cy - 1.7 * H;
  var wall = min((abs(off) - inner) / 7.0, min(topY - p.y + 8.0 * lump, p.y - botY) / (0.5 * H));
  // Cumulus heaps towering out of each bank, one per cell along the corridor.
  let cs = 46.0;
  let ci = floor(l.y / cs);
  for (var k = -1; k <= 1; k++) {
    let cid = ci + f32(k);
    let h3 = hash33(vec3f(cid, side * 7.0, seed));
    let r = 15.0 + 15.0 * h3.x;
    let hs = (cid + 0.5 + (h3.y - 0.5) * 0.5) * cs;
    let hy = botY + r * (0.7 + 1.1 * h3.z);
    let dv = vec3f(off - side * (W + r * 0.5), (p.y - hy) * 0.75, l.y - hs);
    wall = max(wall, (r - length(dv) + 10.0 * lump) / 7.0);
  }
  // A billowing cloud sea below the corridor.
  let deck = (cy - 1.9 * H + 0.7 * H * sea + 3.0 * lump - p.y) / 4.0;
  let tube = length(vec2f(off / (W * 0.7), (p.y - cy) / H)) - 1.0;
  return min(max(cf_layer(p), min(max(wall, deck), 1.0)), tube * 2.5);
}

/** The layer's own low-frequency shape (cheap). Positive inside the cloud envelope. */
fn cf_layer(p: vec3f) -> f32 {
  let ty = S.p[1].x;
  let base = S.p[1].y;
  let thick = S.p[1].z;
  let cov = S.p[1].w;
  let sc = S.p[2].y;
  let seed = S.p[2].z;
  let wind = vec2f(S.p[2].w, S.p[2].w * 0.3);
  let xz = p.xz * sc;
  if (ty < 0.5) {
    let h = (p.y - base) / thick;
    if (h < 0.0 || h > 1.0) { return -1.0; }
    let c = fbmFast(vec3f((xz + wind) * 0.035, seed), 3) + cov - 0.45;
    return c * 1.8 - h * 0.9 - (1.0 - smoothstep(0.0, 0.1, h)) * 0.5 - smoothstep(0.75, 1.0, h) * 2.0;
  } else if (ty < 1.5) {
    let h = (p.y - base) / thick;
    if (h < -0.02 || h > 1.0) { return -1.0; }
    let spc = 90.0;
    let cell = floor(xz / spc);
    let hc = hash33(vec3f(cell, seed));
    let ctr = (cell + 0.5 + (hc.xy - 0.5) * 0.35) * spc;
    let pres = step(hc.z, 0.35 + 0.55 * cov);
    let r0 = (7.0 + 6.0 * hc.x) * (0.8 + 0.4 * cov);
    let topH = 0.55 + 0.45 * hc.y;
    let hn = h / topH;
    let anvil = smoothstep(0.75, 0.95, hn) * smoothstep(1.08, 0.97, hn);
    let lump = fbmFast(vec3f(p.x, p.y * 0.7, p.z) * 0.06 + vec3f(seed), 3) + 0.45 * fbmFast(p * 0.17 + vec3f(seed + 3.0), 2);
    let rad = (r0 * (0.75 + 0.25 * smoothstep(0.0, 0.3, hn)) * (1.0 - 0.25 * smoothstep(0.4, 0.8, hn)) + anvil * r0 * 1.4) * (1.0 + 0.85 * lump);
    let drift = vec2f(1.0, 0.3) * smoothstep(0.6, 1.0, hn) * r0 * 1.2;
    let col = (1.0 - length(xz - ctr - drift) / rad) * pres * step(hn, 1.08);
    // Low cumulus skirt between the towers.
    let lowC = fbmFast(vec3f((xz + wind) * 0.04, seed + 3.0), 2) + cov * 0.6 - 0.4;
    let low = lowC * 1.8 - h * 9.0 - (1.0 - smoothstep(0.0, 0.02, h)) * 0.5;
    return max(col * 1.4, low);
  } else if (ty < 2.5) {
    // Stratus sea: billowing top surface, flat base.
    let billow = fbmFast(vec3f((xz + wind) * 0.11, seed), 4);
    let top = base + thick * (0.7 + 0.8 * billow);
    let towers = fbmFast(vec3f((xz + wind) * 0.012, seed + 9.0), 2);
    let tw = max(towers - 0.3 + cov * 0.15, 0.0);
    let topT = min(top + tw * tw * 70.0 * (0.7 + 0.6 * billow), base + thick * 1.3 + 18.0 - 2.0 * billow);
    let d = min(topT - p.y, p.y - base + 0.5);
    return d * 0.9;
  }
  // Mammatus: dense ceiling with pouches hanging below.
  let ceil = base + 0.6 * fbmFast(vec3f((xz + wind) * 0.03, seed), 2);
  if (p.y > ceil + thick) { return -1.0; }
  let deck = (p.y - ceil) * 0.8;
  let sz = 4.5;
  var lobe = -1.0;
  for (var k = 0; k < 2; k++) {
    let szk = sz * (1.0 - 0.3 * f32(k));
    let off = vec2f(f32(k) * 0.37, f32(k) * 0.71) * szk + wind * 0.5;
    let qq = (xz + off) / szk;
    let cell = floor(qq);
    let hc = hash33(vec3f(cell, seed + f32(k) * 7.0));
    let ctr = (cell + 0.5 + (hc.xy - 0.5) * 0.45) * szk - off;
    let rr = szk * (0.34 + 0.2 * hc.z) * (0.85 + 0.3 * cov);
    let dv = vec3f(xz.x - ctr.x, (p.y - ceil) * 1.2, xz.y - ctr.y);
    lobe = max(lobe, (1.0 - length(dv) / rr) * smoothstep(150.0, 60.0, length(p.xz - cf_ro.xz)));
  }
  return max(deck, lobe * 1.5) * select(1.0, 0.0, p.y < ceil - sz);
}

fn cf_density(p: vec3f, shape: f32, oct: i32) -> f32 {
  let ty = S.p[1].x;
  let wind = vec3f(S.p[2].w, 0.0, S.p[2].w * 0.3) * 1.3;
  let q = (p * S.p[2].y + wind) * select(0.24, 0.16, ty > 0.5 && ty < 1.5);
  let n = fbmFast(q + vec3f(0.0, S.p[2].w * 0.3, 0.0), oct);
  let er = select(0.9, 0.6, ty > 2.5);
  // A steep ramp keeps surfaces crisp so the eroded billows read as cauliflower detail.
  return sat((shape * 2.0 - (n + 0.5) * er * (1.0 - sat(shape * 1.5))) * 2.5) * S.p[2].x;
}

fn cf_hg(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

fn cf_lightDepth(p: vec3f, sd: vec3f) -> f32 {
  var acc = 0.0;
  var st = 1.0;
  var x = p;
  for (var j = 0; j < 2; j++) {
    x += sd * st;
    let s = cf_shape(x, false);
    if (s > 0.0) { acc += cf_density(x, s, 1) * st; }
    st *= 3.0;
  }
  return acc;
}

fn cf_ground(ro: vec3f, rd: vec3f) -> vec3f {
  let t = -ro.y / rd.y;
  let p = ro + rd * t;
  let sd = cf_sunDir();
  let n = fbmFast(vec3f(p.xz * 0.02, 3.0), 4);
  let sea = smoothstep(0.0, 0.08, n - 0.05);
  let land = mix(palRampL(0.35, 0.05), vec3f(0.06, 0.07, 0.04), 0.5) * (0.6 + 0.8 * fbmFast(vec3f(p.xz * 0.15, 1.0), 2));
  let water = palRampL(0.25, 0.02) + cf_skyCol(reflect(rd, vec3f(0.0, 1.0, 0.0))) * 0.3;
  var c = mix(water, land, sea);
  // Cloud shadow on the ground.
  let mid = S.p[1].y + S.p[1].z * 0.3;
  let pc = p + sd * (mid / max(sd.y, 0.1));
  let sh = sat(cf_shape(pc, false) * 2.0);
  c *= (cf_sunCol() * S.p[3].z * max(sd.y, 0.0) * 0.6 * (1.0 - 0.8 * sh) + cf_skyCol(vec3f(0.0, 1.0, 0.0)) * 0.8);
  let haze = 1.0 - exp(-t * 0.012 * S.p[4].w);
  return mix(c, cf_skyCol(vec3f(rd.x, -0.02, rd.z)), haze);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let yaw = S.p[0].w;
  let fwd = vec3f(sin(yaw), 0.0, cos(yaw));
  let ro = S.p[0].xyz;
  let ta = ro + fwd + vec3f(0.0, sin(S.p[6].y), 0.0);
  let cam = lookAt(ro, ta, S.p[6].z);
  let fov = 1.05 - 0.1 * fract(S.p[1].x) / 0.4 + 0.1 * F.anticipation;
  let rd = normalize(cam * vec3f(q, fov));
  let jit = ign(frag);
  cf_ro = ro;

  let sd = cf_sunDir();
  let sunC = cf_sunCol() * S.p[3].z;
  let skyUp = cf_skyCol(vec3f(0.0, 1.0, 0.0));
  let skyHor = cf_skyCol(normalize(vec3f(rd.x, 0.05, rd.z)));
  let mu = dot(rd, sd);
  let phase = mix(cf_hg(mu, 0.65), cf_hg(mu, -0.2), 0.3) * 4.0 * PI;

  // Slab bounds per type.
  let ty = S.p[1].x;
  let base = S.p[1].y;
  let thick = S.p[1].z;
  var y0 = base - 0.5;
  var y1 = base + thick + 0.5;
  if (ty > 0.5 && ty < 1.5) { y1 = base + thick * 1.1; }
  if (ty > 1.5 && ty < 2.5) { y1 = base + thick * 1.3 + 22.0; }
  if (ty > 2.5) { y0 = base - 6.0; y1 = base + thick + 1.0; }
  y0 = min(y0, ro.y - 1.7 * S.p[4].y - 1.0);
  y1 = max(y1, ro.y + 4.5 * S.p[4].y + 1.0);
  var t0 = 0.0;
  var t1 = 400.0;
  if (abs(rd.y) > 1e-4) {
    let ta0 = (y0 - ro.y) / rd.y;
    let ta1 = (y1 - ro.y) / rd.y;
    t0 = max(min(ta0, ta1), 0.0);
    t1 = min(max(ta0, ta1), 400.0);
  } else if (ro.y < y0 || ro.y > y1) {
    t1 = -1.0;
  }

  var trans = 1.0;
  var col = vec3f(0.0);
  var shaft = 0.0;
  var tFirst = -1.0;
  let camS = cf_local(ro).y;
  let H = S.p[4].y;
  // Melody lantern: rides ahead in the corridor at a height set by the lead's pitch.
  let orbI = S.p[6].w;
  let oS = camS + 45.0;
  // The glided melody pitch (-1..1), packed in the time of day's fraction.
  let lp = fract(S.p[3].w) * 10.0 - 1.0;
  let orbPos = cf_world(cf_pathX(oS), oS, ro.y + lp * H * 0.85);
  let orbC = mix(vec3f(1.0, 0.85, 0.7), palL(S.p[5].x + 0.5 + 0.18 * lp, 1.0), 0.6);
  let tc = max(dot(orbPos - ro, rd), 0.0);
  let dmin = length(ro + rd * tc - orbPos);
  var transAt = -1.0;
  // Kick: a shell of light running out through the banks.
  let ringR = S.p[7].x;
  let ringA = S.p[7].y;
  let ringW = 8.0 + ringR * 0.12;
  let ringC = mix(sunC / max(S.p[3].z, 0.1), palL(S.p[5].x + 0.25, 1.0), 0.5);
  // Snare: a lightning cell flashing inside one wall ahead, alternating sides.
  let snA = S.p[7].z;
  let snD = abs(S.p[7].w);
  let sS = camS + snD;
  let snPos = cf_world(cf_pathX(sS) + sign(S.p[7].w) * (S.p[5].w * 1.2 + 10.0), sS, ro.y + H * (0.3 + 1.0 * fract(snD * 3.7)));
  if (t1 > t0) {
    let steps = 40;
    let span = t1 - t0;
    var dt = max(span / f32(steps), 0.25);
    var t = t0 + dt * jit;
    for (var i = 0; i < steps; i++) {
      if (t > t1 || trans < 0.03) { break; }
      if (transAt < 0.0 && t >= tc) { transAt = trans; }
      let p = ro + rd * t;
      let s = cf_shape(p, true) * cf_bubble(p, ro);
      let stepL = min(dt, 0.35 + t * 0.012);
      if (s > 0.0) {
        let d = cf_density(p, s, select(2, 4, t < 60.0));
        if (d > 0.002) {
          if (tFirst < 0.0) { tFirst = t; }
          let ld = cf_lightDepth(p, sd);
          let sigma = 1.2;
          // Multiple scattering: three octaves with softened extinction and phase.
          var sc = 0.0;
          var a = 1.0;
          var b = 1.0;
          var c = 1.0;
          for (var o = 0; o < 3; o++) {
            let ph = mix(cf_hg(mu, 0.65 * c), cf_hg(mu, -0.2 * c), 0.3) * 4.0 * PI;
            sc += a * ph * exp(-sigma * b * ld);
            a *= 0.5;
            b *= 0.35;
            c *= 0.5;
          }
          let powder = 1.0 - exp(-d * 3.0);
          let hFrac = max(sat((p.y - base) / thick), sat((p.y - ro.y + 2.0 * H) / (5.0 * H)));
          let ambK = select(0.9, 0.55, ty > 1.5 && ty < 2.5);
          let amb = (skyUp * (0.4 + 0.6 * hFrac * hFrac) * 0.9 + skyHor * 0.2) * ambK;
          var lum = sunC * sc * (0.3 + 0.7 * powder) * 0.24 + amb * (0.35 + 0.4 * powder);
          let scat = 0.35 + 0.65 * powder;
          if (orbI > 0.005) {
            let dv = p - orbPos;
            lum += orbC * orbI * 2.4 * scat / (1.0 + dot(dv, dv) * 0.005);
          }
          if (ringA > 0.01) {
            let dd = t - ringR;
            lum += ringC * ringA * 1.25 * scat * exp(-dd * dd / (ringW * ringW));
          }
          if (snA > 0.01) {
            lum += vec3f(0.75, 0.8, 1.0) * snA * 9.0 * scat * exp(-length(p - snPos) * 0.04);
          }
          let Tr = exp(-d * sigma * stepL);
          col += trans * lum * (1.0 - Tr);
          trans *= Tr;
        }
      } else {
        // Clear air: god rays where the sun line is unshadowed by the layer above.
        let mid = base + thick * 0.35;
        if (p.y < mid && sd.y > 0.02 && (i & 1) == 0) {
          let pc = p + sd * ((mid - p.y) / sd.y);
          let occ = sat(cf_shape(pc, false) * 3.0);
          shaft += trans * (1.0 - occ) * stepL * 2.0;
        }
      }
      let jj = 0.75 + 0.5 * fract(jit + f32(i) * 0.618034);
      t += select(max(stepL, -s * 1.5), stepL, s > 0.0) * jj;
    }
  }

  var bg: vec3f;
  if (rd.y < 0.0 && ro.y > 0.0) { bg = cf_ground(ro, rd); } else { bg = cf_sky(rd); }
  col += trans * bg;
  if (transAt < 0.0) { transAt = trans; }
  // The lantern itself, seen through the clear air of the corridor.
  col += orbC * orbI * transAt * (1.5 * exp(-dmin * dmin * 0.4) + 0.12 / (1.0 + dmin * dmin * 0.015));
  // Aerial perspective on the clouds themselves.
  if (tFirst > 0.0) {
    let fog = 1.0 - exp(-tFirst * 0.004 * S.p[4].w);
    col = mix(col, skyHor, fog * (1.0 - trans));
  }
  // God rays, music-lifted on the drop.
  col += sunC * shaft * 0.0025 * phase * S.p[5].y * step(-0.02, sd.y);
  return vec4f(col, 1.0);
}
`,
});
