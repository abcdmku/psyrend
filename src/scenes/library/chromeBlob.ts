import { raymarchScene } from '../raymarchScene';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Liquid chrome in a procedural light studio, in four forms chosen per cue:
 *  0 metaballs orbiting and merging (the original): every blob listens to one band,
 *    anticipation gathers them into one trembling sphere and the drop splashes them apart
 *  1 a chrome sea the camera glides over, swelling with the spectrum
 *  2 a chrome torus knot, its tube churned by bass and mids
 *  3 chrome rain: droplets falling into the sea, each impact ringing out
 * DNA: 0 form, 1 camera rig, 2 material (mirror, oil film, tinted metal, satin),
 * 3 environment (studio strips, noir ring light, horizon glow, neon grid room),
 * 4 shape (blob count, wave scale, knot type, rain density), 5 beat grammar (kick squash,
 * kick ripples, bar-stepped turns), 6 strip hues, 7 floor or void.
 *
 * Events come from the shared morph: each reaction is its level squared, eased in, and every band
 * is weighted by the passage loudness, so a faint intro motif only ripples the chrome.
 */

/** Event source: ages and levels (this world does not use the morph's shape coordinates). */
const morph = new Morph(1);
/**
 * A light answering one kind of event: its level squared (the level carries how loud the passage
 * is, so a faint intro motif only glimmers), eased in over `rise` seconds and fading with time
 * constant `decay`. A new event rises from whatever is still lit, never cutting it off.
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
/** A position-bound front's strength (ring, knot, surge): level squared, eased in over `rise`. */
const onset = (age: number, level: number, rise: number) => {
  const x = Math.min(1, age / rise);
  return level * level * x * x * (3 - 2 * x);
};
const kickFx = new Flare(0.1, 0.35);
/** Bands and chord swell, glided so none of them steps the surface. */
const band = { bass: new Spring(0, 0.12), lowMid: new Spring(0, 0.12), mid: new Spring(0, 0.12), high: new Spring(0, 0.12), hat: new Spring(0, 0.1), chord: new Spring(0, 0.1) };

// CPU-side spring state (frame-rate independent via ctx.dt).
const st = {
  orbit: 1, orbitV: 0,
  squash: 0, squashV: 0,
  rippleN: -1, rippleDir: [0, 1, 0] as [number, number, number],
  phase: 0,
  lastTime: -1,
};

const pick = (g: number, n: number) => Math.min(n - 1, Math.floor(g * n));
const ease = (x: number) => x * x * (3 - 2 * x);

function spring(x: number, v: number, target: number, freq: number, damp: number, dt: number): [number, number] {
  // Semi-implicit Euler, substepped for stability at low frame rates.
  const n = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / n;
  const w = 2 * Math.PI * freq;
  for (let i = 0; i < n; i++) {
    v += (-(w * w) * (x - target) - 2 * damp * w * v) * h;
    x += v * h;
  }
  return [x, v];
}

export default raymarchScene({
  meta: {
    id: 'chrome-blob',
    name: 'Liquid Chrome',
    // Dropped from auto-direction: in most DNA this is a chrome object in a studio void, the
    // opposite of an immersive world. An energy range above 1 gives it no energy fit, so the
    // director never ranks it among its candidates; it stays available for pinning.
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: 0.55, arousal: 0.55 },
    genres: { hiphop: 1, pop: 0.9, dubstep: 0.7, edm: 0.6, lofi: 0.4, synthwave: 0.5 },
    trails: 0.2,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const v = g[0];
    const fam = pick(g[0], 4);
    const rig = pick(g[1], 3);
    const mat = pick(g[2], 4);
    const env = pick(g[3], 4);
    const motion = pick(g[5], 3);
    const floor = g[7] < 0.7 ? 1 : 0;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    // A seek (time jump) resets the dynamics.
    if (Math.abs(m.time - st.lastTime) > 0.5) {
      st.orbit = 1; st.orbitV = 0; st.squash = 0; st.squashV = 0;
    }
    st.lastTime = m.time;
    morph.update(m, ctx.dt, g);
    const pres = morph.presence;
    const kickF = kickFx.update(morph.kicks, morph.kickAge, morph.kickLevel);
    const bass = band.bass.update(m.bass * pres, dt);
    const lowMid = band.lowMid.update(m.lowMid * pres, dt);
    const mid = band.mid.update(m.mid * pres, dt);
    const high = band.high.update(m.high * pres, dt);

    const gather = fam === 0 ? Math.min(1, m.anticipation * 1.15) : 0;
    // Orbit radius: gather pulls in, the drop flings outward with spring overshoot.
    const orbitTarget = (1 - 0.92 * gather) * (0.85 + 0.25 * m.energySlow) + 1.6 * m.dropPulse * m.dropPulse;
    [st.orbit, st.orbitV] = spring(st.orbit, st.orbitV, orbitTarget, 0.9 + 0.6 * m.dropPulse, 0.35, dt);
    // Kick squash on a wobbly jelly spring; kickNext pre-stretches.
    const squashK = motion === 0 ? 1 : 0.35;
    const squashTarget = (-0.42 * kickF + 0.12 * m.kickNext * pres) * squashK;
    [st.squash, st.squashV] = spring(st.squash, st.squashV, squashTarget, 3.2, 0.22, dt);
    // Ripple: restart on each new snare (or kick, for the ripple grammar) from a hashed origin,
    // its amplitude the hit's level squared, eased in.
    const hitN = motion === 1 ? morph.kicks : morph.snares;
    const hitAge = Math.min(motion === 1 ? morph.kickAge : morph.snareAge, 9);
    const hitLevel = motion === 1 ? morph.kickLevel : morph.snareLevel;
    if (hitN !== st.rippleN) {
      st.rippleN = hitN;
      const hh = (k: number) => { const x = Math.sin(hitN * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
      const a = hh(1) * Math.PI * 2;
      const z = hh(2) * 1.6 - 0.8;
      const r = Math.sqrt(1 - z * z);
      st.rippleDir = [r * Math.cos(a), z, r * Math.sin(a)];
    }
    const rippleAmp = onset(hitAge, hitLevel, 0.12) * (motion === 1 ? 1.4 : 1);
    st.phase += dt * (0.25 + 0.55 * m.energySlow + 0.35 * m.arousal + 1.2 * m.dropPulse) * (1 - 0.6 * gather);

    const count = 6 + pick(g[4], 5); // 6..10
    const ve = (v * 7.31) % 1;
    const barTurn = motion === 2 ? (m.barIndex + ease(m.barPhase)) * 0.7 : 0;

    // S.p[0]: count, orbit scale, radius scale, seed
    p[0] = count;
    p[1] = st.orbit;
    p[2] = (0.92 + 0.12 * bass) * Math.sqrt(8 / count);
    p[3] = v;
    // S.p[1]: squash, gather, tremble, displacement
    p[4] = st.squash;
    p[5] = gather;
    p[6] = gather * gather * (0.6 + 0.4 * m.energy);
    p[7] = 0.03 + 0.11 * bass + 0.06 * lowMid + 0.05 * m.dropPulse;
    // S.p[2]: iridescence, film thickness, hat glint, spectrum relief
    const iriBase = mat === 1 ? 0.75 : 0.12 + 0.25 * ve;
    p[8] = Math.min(1, iriBase + 0.7 * m.tension * (mat === 1 ? 0.3 : 1) + 0.6 * band.chord.update(m.chordPulse, dt));
    p[9] = (g[6] * 3.7) % 1 + ctx.spin * 0.05;
    p[10] = band.hat.update(m.hat * pres, dt);
    p[11] = 0.05 + 0.12 * mid + 0.05 * high;
    // S.p[3]: camera position + roll
    const sea = fam === 1 || fam === 3;
    const a = ctx.spin * (rig === 1 ? -0.55 : 0.45) + g[1] * 6.28 + barTurn * (sea ? 0 : 0.3);
    let dist = (4.6 - 0.5 * m.energySlow - 0.6 * gather + 0.9 * m.dropPulse) * (fam === 2 ? 1.05 : 1);
    let h: number;
    if (rig === 0) h = 0.55 + 0.6 * Math.sin(ctx.spin * 0.31);
    else if (rig === 1) h = 2.0 + 0.5 * Math.sin(ctx.spin * 0.27);
    else { h = -0.2 + 0.35 * Math.sin(ctx.spin * 0.4); dist *= 0.82; }
    if (sea) h = [1.0, 1.9, 0.8][rig] + 0.1 * Math.sin(ctx.spin * 0.3) + 0.3 * m.dropPulse;
    p[12] = sea ? 0.8 * Math.sin(ctx.spin * 0.11) : Math.cos(a) * dist;
    p[13] = h;
    p[14] = sea ? ctx.travel * 0.9 : Math.sin(a) * dist;
    p[15] = Math.sin(ctx.spin * 0.23 + v * 4) * (rig === 2 ? 0.22 : 0.1);
    // S.p[4]: ripple origin + age
    p[16] = st.rippleDir[0];
    p[17] = st.rippleDir[1];
    p[18] = st.rippleDir[2];
    p[19] = hitAge;
    // S.p[5]: smin k, env rotation, strip gain, ripple amplitude
    p[20] = 0.55 + 0.25 * ve - 0.35 * gather;
    p[21] = ctx.spin * 0.2 + v * 3.0 + (sea ? barTurn : 0);
    p[22] = (0.7 + 0.8 * ctx.intensity + 0.5 * m.dropPulse) * (1 - 0.45 * m.anticipation) + 0.6 * kickF;
    p[23] = rippleAmp * 0.04;
    // S.p[6]: focal length, background dim, strip count, orbit tilt
    p[24] = (sea ? 1.35 : 1.9) + 0.35 * gather + 0.15 * m.anticipation;
    p[25] = 0.5 * (1 - 0.4 * m.anticipation) + 0.2 * m.dropPulse;
    p[26] = 3 + pick((g[6] * 5.3) % 1, 3) + 0.45 * Math.min(1, kickF); // 3..5 strips; fraction: kick light
    p[27] = ((v * 2.9) % 1) * 1.2 - 0.2;
    // S.p[7]: orbit phase, shape gene, object turn, packed form/material/env/floor/motion
    p[28] = st.phase;
    p[29] = g[4];
    p[30] = barTurn + ctx.spin * 0.08;
    p[31] = fam + 4 * mat + 16 * env + 64 * floor + 128 * motion + 0.45 * pres; // fraction: passage loudness
  },
  wgsl: /* wgsl */ `
/** The spectrum with its attack eased over ~120 ms (now and the last three history rows), so
 *  an onset swells a band in instead of stepping it. */
fn cb_specE(x: f32) -> f32 {
  return 0.25 * (spec(x) + hist(x, 0.01) + hist(x, 0.02) + hist(x, 0.03));
}

var<private> cb_ball: array<vec4f, 10>;
var<private> cb_count: i32;
var<private> cb_bound: f32;
var<private> cb_fam: i32;
var<private> cb_envMode: i32;
var<private> cb_knotPQ: vec2f;
var<private> cb_obj: mat3x3f;
// Per-strip light: rgb = colour * spectrum level, w = azimuth; geometry in cb_stripG.
var<private> cb_strip: array<vec4f, 5>;
var<private> cb_stripG: array<vec2f, 5>;
// Passage loudness (0.15..1, weights every band) and the eased kick light.
var<private> cb_pres: f32;
var<private> cb_kick: f32;
// The glided, loudness-weighted bass, recovered from the radius scale (0.92 + 0.12 bass) sqrt(8 / count).
var<private> cb_bass: f32;

const CB_FLOOR: f32 = -1.65;

// pal() without a dynamically indexed local array (cheaper in hot loops).
fn cb_pal(t: f32) -> vec3f {
  let x = fract(t) * 4.0;
  let f = smoothstep(0.0, 1.0, fract(x));
  let a = select(select(select(F.pal3.rgb, F.pal2.rgb, x < 3.0), F.pal1.rgb, x < 2.0), F.pal0.rgb, x < 1.0);
  let b = select(select(select(F.pal0.rgb, F.pal3.rgb, x < 3.0), F.pal2.rgb, x < 2.0), F.pal1.rgb, x < 1.0);
  return mix(a, b, f);
}
fn cb_palL(t: f32, lum: f32) -> vec3f { let c = cb_pal(t); return c * (lum / max(luma(c), 0.02)); }
fn cb_bits(shift: u32, mask: u32) -> i32 { return i32((u32(S.p[7].w + 0.5) >> shift) & mask); }
fn cb_isSea() -> bool { return cb_fam == 1 || cb_fam == 3; }

fn cb_setup() {
  cb_pres = fract(S.p[7].w) / 0.45;
  cb_kick = fract(S.p[6].z) / 0.45;
  cb_bass = (S.p[0].z / sqrt(8.0 / S.p[0].x) - 0.92) / 0.12;
  cb_fam = cb_bits(0u, 3u);
  cb_envMode = cb_bits(4u, 3u);
  cb_count = i32(S.p[0].x);
  let orbit = S.p[0].y;
  let rs = S.p[0].z;
  let seed = S.p[0].w;
  let gather = S.p[1].y;
  let tilt = S.p[6].w;
  let ph = S.p[7].x;
  let gk = S.p[7].y;
  cb_knotPQ = select(select(vec2f(3.0, 2.0), vec2f(2.0, 5.0), gk > 0.66), vec2f(2.0, 3.0), gk < 0.33);
  cb_obj = rotY(S.p[7].z) * rotX(0.5 + 0.3 * sin(ph * 0.3));
  var bound = 0.0;
  if (cb_fam == 0) {
    for (var i = 0; i < 10; i++) {
      if (i >= cb_count) { break; }
      let fi = f32(i);
      let h = hash33(vec3f(fi * 1.37 + 0.3, seed * 91.7 + 2.1, fi * 0.71 + 5.3));
      let axis = normalize(h * 2.0 - 1.0 + vec3f(0.0, tilt * 2.0, 0.0));
      let perp = normalize(cross(axis, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(axis.x) > 0.8)));
      let dir = select(-1.0, 1.0, h.y > 0.4);
      let ang = ph * (0.6 + 0.9 * h.x) * dir + fi * 2.39996;
      let ro = orbit * (0.75 + 0.75 * h.z);
      var c = rotAxis(axis, ang) * perp * ro + axis * sin(ph * 0.83 + fi * 1.7) * 0.35 * orbit;
      let band = (fi + 0.5) / f32(cb_count) * 0.75 + 0.03;
      var r = rs * (0.38 + 0.2 * hash11(fi * 3.7 + seed * 17.0)) * (0.9 + 0.45 * cb_pres * cb_specE(band));
      // Gather: collapse into one sphere.
      c = c * (1.0 - 0.97 * gather);
      r = mix(r, 0.85 + 0.05 * fi / f32(cb_count), gather * gather);
      cb_ball[i] = vec4f(c, r);
      bound = max(bound, length(c) + r);
    }
  } else {
    bound = 1.75 + 0.15 * cb_bass;
  }
  cb_bound = bound + 0.45;
  // Studio strips depend only on uniforms: resolve them once per pixel.
  let ns = i32(S.p[6].z);
  for (var k = 0; k < 5; k++) {
    let fk = f32(k);
    let band = (fk + 0.5) / f32(ns) * 0.8 + 0.05;
    let lvl = 0.45 + 2.2 * cb_pres * cb_specE(band);
    let col = mix(cb_palL(fk / f32(ns) + F.morph2.x * 0.35 + 0.15 + S.p[2].y * 0.3, 0.35), cb_palL(0.9, 0.5), 0.25);
    let a0 = fk / f32(ns) * TAU + F.morph.y * 0.7;
    cb_strip[k] = vec4f(col * lvl * S.p[5].z * 2.2 * select(0.0, 1.0, k < ns), a0);
    cb_stripG[k] = vec2f(0.07 + 0.03 * fract(fk * 0.618 + seed), 0.55 + 0.25 * fract(fk * 0.41 + seed * 3.0));
  }
}

fn cb_warp(p: vec3f) -> vec3f {
  // Volume-preserving squash/stretch along y.
  let sq = S.p[1].x;
  let sy = 1.0 + sq;
  let sx = 1.0 / sqrt(max(sy, 0.2));
  return p / vec3f(sx, sy, sx);
}

fn cb_knot(p: vec3f) -> f32 {
  let q = cb_obj * p;
  let R = 1.0;
  let r2 = 0.42;
  let a = atan2(q.z, q.x);
  let rr = vec2f(length(q.xz) - R, q.y);
  var d = 1e9;
  let P = cb_knotPQ.x;
  let Q = cb_knotPQ.y;
  for (var k = 0; k < 3; k++) {
    if (f32(k) >= P) { break; }
    let ang = (a + TAU * f32(k)) * Q / P;
    d = min(d, length(rr - vec2f(cos(ang), sin(ang)) * r2));
  }
  return d - (0.2 + 0.04 * cb_bass);
}

// Sea height: crossing swells, spectrum swell and kick rings ahead of the camera.
fn cb_seaH(xz: vec2f, detail: bool) -> f32 {
  let w = F.warp * 0.6;
  let sc = 0.8 + 0.6 * S.p[7].y;
  var h = 0.11 * sin(dot(xz, vec2f(0.8, 0.6)) * sc * 1.3 + w)
        + 0.08 * sin(dot(xz, vec2f(-0.5, 0.86)) * sc * 1.9 - w * 1.3)
        + 0.05 * sin(dot(xz, vec2f(0.95, -0.3)) * sc * 3.1 + w * 1.7);
  h *= min(0.6 + 0.6 * cb_bass + 1.2 * S.p[1].w, 1.3);
  if (detail) {
    let q = vec3f(xz * 2.2, w * 0.5);
    h += 0.025 * dot(sin(q * 1.7), cos(q.zxy * 2.3)) * (0.5 + (F.mid * cb_pres));
  }
  // Ring wave from a point ahead on each hit.
  let c = vec2f(S.p[3].x, S.p[3].z + 5.0);
  let rd = length(xz - c);
  let age = S.p[4].w;
  let ring = sin(rd * 7.0 - age * 16.0) * exp(-age * 1.6) * exp(-pow(rd - age * 3.2, 2.0) * 1.5);
  h += ring * S.p[5].w * 4.0;
  h += F.dropPulse * 0.4 * exp(-pow(rd - (1.0 - F.dropPulse) * 14.0, 2.0) * 0.3);
  return h;
}

// Rain: one droplet per cell, falling into the sea, ringing on impact.
fn cb_cell(xz: vec2f) -> vec2f { return floor(xz / 1.1); }
fn cb_dropPhase(id: vec2f) -> vec2f {
  let h = hash12(id * 1.7 + 3.1);
  let rate = 0.35 + 0.3 * hash12(id + 9.2);
  return vec2f(fract(F.songTime * rate + h), rate);
}
fn cb_drop(p: vec3f) -> f32 {
  let id = cb_cell(p.xz);
  let ctr = (id + 0.5) * 1.1 + (vec2f(hash12(id), hash12(id + 5.0)) - 0.5) * 0.5;
  let ph = cb_dropPhase(id);
  let y = 3.0 - ph.x * 3.6;
  let rad = 0.07 + 0.05 * hash12(id + 2.0) + 0.04 * cb_bass;
  let q = vec3f(p.x - ctr.x, (p.y - y) * 0.6, p.z - ctr.y);
  let dens = step(hash12(id + 7.7), 0.35 + 0.5 * S.p[7].y);
  return mix(1.0, (length(q) - rad) * 0.6, dens);
}
fn cb_rainRipple(xz: vec2f) -> f32 {
  let id = cb_cell(xz);
  let ctr = (id + 0.5) * 1.1 + (vec2f(hash12(id), hash12(id + 5.0)) - 0.5) * 0.5;
  let ph = cb_dropPhase(id);
  let age = fract(ph.x - 0.833) / ph.y;
  let r = length(xz - ctr);
  let dens = step(hash12(id + 7.7), 0.35 + 0.5 * S.p[7].y);
  return sin(r * 26.0 - age * 22.0) * exp(-age * 2.2) * exp(-pow(r - age * 0.9, 2.0) * 30.0) * 0.03 * smoothstep(0.55, 0.3, r) * dens;
}

fn cb_seaMap(p: vec3f, detail: bool) -> f32 {
  var h = cb_seaH(p.xz, detail);
  if (cb_fam == 3 && detail) { h += cb_rainRipple(p.xz); }
  var d = (p.y - h) * 0.7;
  if (cb_fam == 3) { d = min(d, cb_drop(p)); }
  return d;
}

// Undisplaced field: used for secondary rays (reflections of reflections).
fn cb_mapBase(p0: vec3f) -> f32 {
  if (cb_isSea()) { return cb_seaMap(p0, false); }
  let p = cb_warp(p0);
  var d = 1e9;
  if (cb_fam == 2) {
    d = cb_knot(p);
  } else {
    let k = max(S.p[5].x, 0.12);
    for (var i = 0; i < 10; i++) {
      if (i >= cb_count) { break; }
      let b = cb_ball[i];
      d = smin(d, length(p - b.xyz) - b.w, k);
    }
  }
  let sy = 1.0 + S.p[1].x;
  return d * min(sy, 1.0 / sqrt(max(sy, 0.2))) * 0.9;
}

fn cb_normalBase(p: vec3f) -> vec3f {
  let k = vec2f(1.0, -1.0);
  let e = 0.004;
  return normalize(k.xyy * cb_mapBase(p + k.xyy * e) + k.yyx * cb_mapBase(p + k.yyx * e) +
                   k.yxy * cb_mapBase(p + k.yxy * e) + k.xxx * cb_mapBase(p + k.xxx * e));
}

fn cb_traceBase(ro: vec3f, rd: vec3f, maxSteps: i32) -> f32 {
  let bs = cb_sphere(ro, rd, cb_bound * 1.15);
  if (bs.y < 0.0) { return -1.0; }
  var t = max(bs.x, 0.0);
  // A displaced surface point can sit inside the base field: walk out first.
  var outside = false;
  for (var i = 0; i < maxSteps; i++) {
    let h = cb_mapBase(ro + rd * t);
    if (outside) {
      if (h < 0.004 * (1.0 + t)) { return t; }
      t += h;
    } else {
      outside = h > 0.01;
      t += max(abs(h), 0.03);
    }
    if (t > bs.y) { break; }
  }
  return -1.0;
}

fn cb_map(p0: vec3f) -> f32 {
  if (cb_isSea()) { return cb_seaMap(p0, true); }
  let p = cb_warp(p0);
  var d = 1e9;
  if (cb_fam == 2) {
    d = cb_knot(p);
  } else {
    let k = max(S.p[5].x, 0.12);
    for (var i = 0; i < 10; i++) {
      if (i >= cb_count) { break; }
      let b = cb_ball[i];
      d = smin(d, length(p - b.xyz) - b.w, k);
    }
  }
  if (d > 0.6) { return d * 0.8; }
  let dir = normalize(p + vec3f(1e-4));
  // Smooth analytic waves (domain-warped gyroids): liquid, and free of the texture
  // filtering staircase that finite-difference normals pick up on a mirror.
  let w = F.warp * 0.55;
  var q1 = p * 1.6 + vec3f(0.0, w, F.travel * 0.05);
  q1 += 0.45 * sin(q1.yzx * 0.8 + vec3f(w * 0.7, 1.3, 2.9));
  let g1 = dot(sin(q1), cos(q1.zxy));
  let q2 = p.zxy * 3.1 + vec3f(w * 1.3, -w * 0.6, 0.7) + 0.6 * sin(q1 * 0.9);
  let g2 = dot(sin(q2), cos(q2.yzx));
  var disp = (g1 * 0.42 + g2 * 0.16) * S.p[1].w * select(1.0, 0.6, cb_fam == 2);
  // Spectrum painted over the surface: a slow wave field picks the band (biased low
  // at the bottom, high at the top), so bands swell as organic patches.
  let lat = 0.5 + 0.5 * dir.y;
  let sel = dot(sin(p * 0.9 + vec3f(1.3, w * 0.3, 2.1)), cos(p.yzx * 1.1 + 0.5));
  let fx = sat(0.45 * lat + 0.55 * (0.5 + 0.33 * sel));
  disp += cb_pres * spec(fx * 0.85 + 0.03) * S.p[2].w * smoothstep(-0.6, 1.0, g1) * select(1.0, 0.5, cb_fam == 2);
  // Anticipation tremble.
  let tr = S.p[1].z;
  if (tr > 0.01) {
    let tq = p * 5.5 + F.time * vec3f(9.0, 7.3, 8.1);
    disp += dot(sin(tq), cos(tq.zxy * 1.07)) * tr * 0.025;
  }
  // Ripple travelling across the surface from a random origin.
  let age = S.p[4].w;
  let ramp = S.p[5].w;
  if (ramp * exp(-age * 2.5) > 0.002) {
    let ang = acos(clamp(dot(dir, S.p[4].xyz), -1.0, 1.0));
    let front = age * 4.5;
    let env = exp(-age * 2.2) * exp(-(ang - front) * (ang - front) * 7.0);
    disp += sin(ang * 13.0 - age * 26.0) * env * ramp;
  }
  let sy = 1.0 + S.p[1].x;
  let smin3 = min(sy, 1.0 / sqrt(max(sy, 0.2)));
  return (d - disp) * smin3 * select(0.78, 0.6, cb_fam == 2);
}

fn cb_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * cb_map(p + k.xyy * e) + k.yyx * cb_map(p + k.yyx * e) +
                   k.yxy * cb_map(p + k.yxy * e) + k.xxx * cb_map(p + k.xxx * e));
}

fn cb_sphere(ro: vec3f, rd: vec3f, r: f32) -> vec2f {
  let b = dot(ro, rd);
  let c = dot(ro, ro) - r * r;
  let h = b * b - c;
  if (h < 0.0) { return vec2f(-1.0); }
  let s = sqrt(h);
  return vec2f(-b - s, -b + s);
}

// Returns t of the hit or -1.
fn cb_trace(ro: vec3f, rd: vec3f, maxSteps: i32, jitter: f32, eps: f32) -> f32 {
  var t: f32;
  var tEnd: f32;
  if (cb_isSea()) {
    // Slab above the sea (rain falls from y = 3).
    let top = select(0.6, 3.3, cb_fam == 3);
    if (rd.y >= 0.0 && (ro.y > top || cb_fam == 1)) { return -1.0; }
    t = jitter;
    if (ro.y > top) { t = (top - ro.y) / rd.y; }
    tEnd = select(40.0, (-1.0 - ro.y) / rd.y, rd.y < 0.0);
    tEnd = min(tEnd, 40.0);
  } else {
    // Bound already carries a displacement margin; 1.15 covers the kick stretch.
    let bs = cb_sphere(ro, rd, cb_bound * 1.15);
    if (bs.y < 0.0) { return -1.0; }
    t = max(bs.x, 0.0) + jitter;
    tEnd = bs.y;
  }
  for (var i = 0; i < maxSteps; i++) {
    let h = cb_map(ro + rd * t);
    if (h < eps * (1.0 + t)) { return t; }
    t += h;
    if (t > tEnd) { break; }
  }
  return -1.0;
}

fn cb_wrap(a: f32) -> f32 { return abs(fmod(a + PI, TAU) - PI); }

// Procedural light environment. soft widens every edge (blur for background / rough reflections).
fn cb_env(rd0: vec3f, soft: f32) -> vec3f {
  let rd = rotY(S.p[5].y) * rd0;
  let y = rd.y;
  let az = atan2(rd.z, rd.x);
  let gain = S.p[5].z;
  let mode = cb_envMode;
  // Studio cyclorama: dark floor, a crisp horizon split, a lit wall fading up into
  // a darker ceiling.
  let split = smoothstep(-0.01 - soft * 0.25, 0.01 + soft * 0.25, y);
  let floorC = cb_palL(0.05, 0.006) + cb_palL(0.3, 0.004) * smoothstep(-0.6, 0.0, y);
  let wallK = select(1.0, 0.25, mode == 1);
  let wall = mix(cb_palL(0.3, 0.09) * wallK, cb_palL(0.55, 0.04) * wallK, smoothstep(0.0, 0.55, y));
  let ceil = cb_palL(0.6, 0.015);
  let side = 0.75 + 0.25 * sin(az * 1.0 + F.morph.x * 6.0);
  var c = mix(floorC, mix(wall * side, ceil, smoothstep(0.45, 0.95, y)), split);
  let hzK = select(1.0, 4.0, mode == 2);
  let hz = exp(-abs(y - 0.015) * 30.0 / (1.0 + soft * 6.0 + select(0.0, 3.0, mode == 2)));
  c += cb_palL(0.6 + 0.15 * sin(az * 2.0 + F.morph.x * 6.0), 0.12) * hz * (0.3 + 0.5 * F.energySlow) * hzK;
  if (mode == 2) {
    // Horizon glow: a wide sunset band and a soft sun.
    c += cb_palL(0.75, 0.25) * exp(-max(y, 0.0) * 5.0) * split * (0.6 + 0.4 * F.energySlow);
    c += cb_palL(0.9, 3.0) * pow(sat(dot(rd, normalize(vec3f(0.0, 0.08, 1.0)))), 200.0 / (1.0 + soft * 30.0));
  }
  if (mode == 3) {
    // Neon grid room.
    let gx = abs(fract(az * 12.0 / TAU) - 0.5);
    let gy = abs(fract(y * 8.0) - 0.5);
    let lw = 0.03 + soft * 0.3;
    let grid = max(smoothstep(lw, 0.0, 0.5 - gx), smoothstep(lw, 0.0, 0.5 - gy)) * split;
    c += cb_palL(az / TAU + y * 0.3 + F.morph2.x * 0.3, 0.6) * grid * gain * (0.5 + cb_kick);
  }
  // Vertical softbox strips, one per spectrum region (studio and noir).
  let ns = select(i32(S.p[6].z), 0, mode >= 2);
  let sw = 0.012 + soft * 0.2;
  let yIn = smoothstep(-0.12 - sw, -0.12 + sw, y);
  if (ns > 0 && yIn > 0.0 && y < 0.81 + sw) {
    for (var k = 0; k < 5; k++) {
      if (k >= ns) { break; }
      let sc = cb_strip[k];
      let g = cb_stripG[k];
      let da = cb_wrap(az - sc.w);
      if (da > g.x + sw) { continue; }
      var m = smoothstep(g.x + sw, g.x - sw, da) * yIn * smoothstep(g.y + sw, g.y - sw, y);
      // Inner panel gradient to read as a lit box, not a flat line.
      m *= 0.75 + 0.25 * smoothstep(g.x, 0.0, da);
      c += sc.rgb * m * select(1.0, 0.5, mode == 1);
    }
  }
  // Overhead rectangular panel.
  if (y > 0.05) {
    let q = rd.xz / y;
    let sb = 0.03 + soft * 0.5;
    let pm = smoothstep(1.1 + sb, 1.1 - sb, abs(q.x)) * smoothstep(0.5 + sb, 0.5 - sb, abs(q.y));
    c += mix(cb_palL(0.9, 0.6), vec3f(0.6), 0.35) * pm * (1.4 + 1.4 * cb_kick) * gain * select(1.0, 0.3, mode >= 2) * select(1.0, 0.5, cb_isSea());
    // Thin ring light.
    let rr = length(q);
    c += cb_palL(0.55, 0.5) * exp(-abs(rr - 1.9) * 40.0 / (1.0 + soft * 12.0)) * (0.6 + 2.5 * cb_kick) * gain * select(1.0, 2.5, mode == 1);
  }
  // Floor-level bounce glow.
  c += cb_palL(0.3, 0.02) * smoothstep(-0.05, -0.6, y);
  return c;
}

fn cb_film(cosT: f32, thick: f32) -> vec3f {
  // Cheap thin-film interference: phase shifts per channel, tinted by the palette.
  let ph = thick * (2.4 - 1.4 * cosT);
  let rgb = 0.5 + 0.5 * cos(TAU * (ph * vec3f(1.0, 1.18, 1.38) + vec3f(0.0, 0.2, 0.45)));
  return mix(rgb, cb_palL(ph * 0.5 + 0.1, 0.8), 0.35);
}

fn cb_floor(ro: vec3f, rd: vec3f, t: f32, frag: vec2f) -> vec3f {
  let pos = ro + rd * t;
  // Soft occlusion from each blob (analytic sphere occlusion).
  var occ = 1.0;
  if (cb_fam == 0) {
    for (var i = 0; i < 10; i++) {
      if (i >= cb_count) { break; }
      let b = cb_ball[i];
      let dv = b.xyz - pos;
      let l = length(dv);
      let o = sat(dv.y / l) * (b.w * b.w) / (l * l);
      occ *= 1.0 - o * 0.95;
    }
  } else {
    occ = 1.0 - 0.8 * exp(-length(pos.xz) * 0.9);
  }
  let fres = 0.06 + 0.5 * pow(1.0 - sat(-rd.y), 5.0);
  let rdr = reflect(rd, vec3f(0.0, 1.0, 0.0));
  var refl = cb_env(rdr, 0.35) * 0.6;
  let th = cb_traceBase(pos + vec3f(0.0, 0.01, 0.0), rdr, 24);
  if (th > 0.0) {
    let hp = pos + rdr * th;
    let n = cb_normalBase(hp);
    refl = cb_env(reflect(rdr, n), 0.1) * 0.85;
  }
  var col = cb_palL(0.05, 0.008) + refl * fres * 1.6;
  col += cb_palL(0.3, 0.01) * exp(-length(pos.xz) * 0.35);
  col *= occ;
  return col;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  cb_setup();
  let mat = cb_bits(2u, 3u);
  let hasFloor = cb_bits(6u, 1u) == 1;
  let sea = cb_isSea();
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[3].xyz;
  var ta = vec3f(0.0, -0.1, 0.0);
  if (sea) {
    let yaw = 0.25 * sin(F.spin * 0.07) + S.p[7].z * 0.2;
    ta = ro + vec3f(sin(yaw) * 4.0, -0.35 - 0.25 * ro.y, cos(yaw) * 4.0);
  }
  let cam = lookAt(ro, ta, S.p[3].w);
  let rd = normalize(cam * vec3f(q, S.p[6].x));

  let t = cb_trace(ro, rd, select(84, 110, sea), ign(frag) * 0.01, 0.0006);
  if (t < 0.0) {
    var col = cb_env(rd, 0.25) * S.p[6].y;
    if (rd.y < -0.001 && hasFloor && !sea) {
      let tFloor = (CB_FLOOR - ro.y) / rd.y;
      let fc = cb_floor(ro, rd, tFloor, frag);
      let fd = length((ro + rd * tFloor).xz);
      col = mix(fc, col, smoothstep(5.0, 13.0, fd));
    }
    return vec4f(col, 1.0);
  }
  let pos = ro + rd * t;
  let n = cb_normal(pos, 0.002 + 0.0006 * t);
  let v = -rd;
  let cosT = sat(dot(n, v));
  let r = reflect(rd, n);
  let soft = select(0.0, 0.35, mat == 3);
  // Second bounce: chrome reflects itself.
  var refl: vec3f;
  var t2 = -1.0;
  if (!sea) { t2 = cb_traceBase(pos + n * 0.03, r, 28); }
  if (t2 > 0.0) {
    let p2 = pos + r * t2;
    let n2 = cb_normalBase(p2);
    let r2 = reflect(r, n2);
    let f2 = 0.55 + 0.45 * pow(1.0 - sat(dot(n2, -r)), 5.0);
    refl = cb_env(r2, 0.05 + soft) * f2 * mix(vec3f(0.9), cb_palL(0.55, 0.9), 0.25);
  } else if (r.y < 0.0 && !sea && hasFloor) {
    // Reflected floor.
    let tf = (CB_FLOOR - pos.y) / r.y;
    let fp = pos + r * tf;
    refl = mix(cb_palL(0.05, 0.004) + cb_env(reflect(r, vec3f(0.0, 1.0, 0.0)), 0.4) * 0.12, cb_env(r, 0.2), smoothstep(4.0, 12.0, length(fp.xz)));
  } else {
    refl = cb_env(r, soft);
  }
  // Chrome fresnel and slightly palette-tinted metal.
  let fres = 0.68 + 0.32 * pow(1.0 - cosT, 5.0);
  var tint = mix(vec3f(1.0), cb_palL(0.55, 1.0), 0.18);
  if (mat == 2) { tint = mix(cb_palL(0.8 + S.p[2].y * 0.2, 0.75), vec3f(1.0), pow(1.0 - cosT, 3.0)); }
  let iri = S.p[2].x;
  let thick = S.p[2].y + 0.6 * noise3(pos * 1.2 + vec3f(F.warp * 0.2)) + 0.4 * luma(F.morph2.xyz);
  tint = mix(tint, cb_film(cosT, thick) * 1.3, iri * (0.35 + 0.65 * pow(1.0 - cosT, 1.5)));
  // Cheap AO for crevices where blobs merge.
  var ao = 1.0;
  if (!sea) {
    ao = sat(0.35 + 0.65 * (cb_map(pos + n * 0.12) / 0.12)) * sat(0.55 + 0.45 * cb_map(pos + n * 0.35) / 0.35);
  }
  var c = refl * tint * fres * ao;
  if (mat == 3) {
    // Satin: add a soft diffuse response to the overhead light.
    c += tint * cb_palL(0.6, 0.06) * (0.5 + 0.5 * n.y) * ao;
  }
  // Hat glints: tiny sparkle cells catching the light.
  let cell = floor(pos * 26.0);
  let gl = step(0.992, hash13(cell + floor(F.time * 12.0)));
  c += cb_palL(0.9, 1.0) * gl * S.p[2].z * 6.0 * pow(sat(dot(r, normalize(vec3f(0.2, 1.0, 0.1)))), 2.0);
  // Faint rim from the palette accent.
  c += cb_palL(0.9, 0.5) * pow(1.0 - cosT, 4.0) * 0.08 * (1.0 + 2.0 * F.dropPulse);
  if (sea) {
    // Distance haze into the horizon.
    let hz = cb_env(normalize(vec3f(rd.x, 0.02, rd.z)), 0.4) * S.p[6].y;
    c = mix(c, hz, 1.0 - exp(-t * 0.06));
  }
  return vec4f(c, 1.0);
}
`,
});
