import { raymarchScene } from '../raymarchScene';
import type { SceneUpdateContext } from '../types';
import { Morph } from '../morph';
import { Spring } from '../anim';

/** Per-instance music clock: a phase that advances with tempo and loudness and rests in silence. */
interface Pulse { t: number; clock: number; seek: boolean }
const pulses = new WeakMap<Float32Array, Pulse>();
function musicPulse(ctx: SceneUpdateContext, key: Float32Array): Pulse {
  const m = ctx.music;
  let s = pulses.get(key);
  if (!s) {
    s = { t: m.time, clock: 0, seek: true };
    pulses.set(key, s);
  }
  const dt = m.time - s.t;
  s.t = m.time;
  s.seek = !(dt >= 0 && dt < 0.5);
  if (dt > 0 && dt < 0.5) {
    const gate = Math.min(1, m.energy * 5);
    s.clock += dt * (m.bpm / 60) * gate * (0.3 + 0.7 * m.energySlow) * (0.4 + 1.8 * Math.exp(-m.beatPhase * 5));
  }
  return s;
}

/**
 * Event source: ages, counts and levels. Every level carries how loud the passage is, so a faint
 * intro motif only glints at the vent while the lead in a full mix throws the fire high.
 */
const morph = new Morph(1);
/**
 * A light answering one kind of event: its level squared, eased in over `rise` seconds and fading
 * with time constant `decay`. A new event rises from whatever is still lit (never cut off).
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
const fx = { lead: new Flare(0.15, 0.35), kick: new Flare(0.12, 0.3), snare: new Flare(0.12, 0.2) };
/** The held melody, its pitch (the height it lights the ash) and the hats, glided so none jumps. */
const held = new Spring(0, 0.1);
const pitch = new Spring(0.5, 0.3);
const hat = new Spring(0, 0.06);

/**
 * Volcanic landscape. A basalt heightfield holds lava as a second surface: radial
 * channels down a shield volcano, a caldera lake around a spatter island, glowing
 * fissure cracks between spatter ramparts, or braided rivers across a lava plain.
 * The lava wears a cooling crust (plates, ropy pahoehoe, clinkery aa, or a thin
 * cracked skin) that flows, throbs on kicks and breaks open as pressure builds.
 * A vent throws ballistic fire fountains (bands of the spectrum), an ash plume
 * rises lit from below, embers drift past the lens, and the drop erupts.
 *
 * DNA: g1 terrain type, g2 crust pattern, g3 camera rig, g4 sky, g5 eruption style,
 * g6 lava exposure / heat, g7 terrain roughness and plume wind; g0 seeds the layout.
 */

/** The last four melody notes: song time of each attack and the fountain height its pitch set. */
interface Bursts { t: number[]; h: number[]; k: number; last: number }
const bursts = new WeakMap<Float32Array, Bursts>();

export default raymarchScene({
  meta: {
    id: 'lava-world',
    name: 'Lava World',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.45, 1],
    mood: { valence: 0.3, arousal: 0.8 },
    genres: { rock: 1, dubstep: 0.9, hiphop: 0.7, dnb: 0.8, techno: 0.5, edm: 0.4 },
    trails: 0.25,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const antic = m.anticipation;
    morph.update(m, ctx.dt, g);
    // The drop as the morph's surge (it swells in, never a one-frame jump); the shockwave keeps the raw pulse.
    const drop = morph.surge;
    const q = (x: number, n: number) => Math.floor(Math.min(x, 0.9999) * n);

    const type = q(g[1], 4);
    const cam = q(g[3], 4);
    const sky = q(g[4], 4);
    const erupt = q(g[5], 3);
    const pu = musicPulse(ctx, p);
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    let b = bursts.get(p);
    if (!b) {
      b = { t: [-99, -99, -99, -99], h: [0, 0, 0, 0], k: 0, last: morph.notes };
      bursts.set(p, b);
    }
    if (pu.seek) {
      b.last = morph.notes;
      held.reset(0);
      hat.reset(0);
      pitch.reset(0.5 + 0.5 * morph.notePitch);
    }
    if (morph.notes !== b.last) {
      b.last = morph.notes;
      b.k = (b.k + 1) % 4;
      b.t[b.k] = m.time;
      // The fountain's height is the pitch, scaled by the note's level: a faint note only spits.
      const lv = morph.noteLevel;
      b.h[b.k] = 12 * (0.8 + 0.4 * g[5]) * (0.35 + 1.25 * (0.5 + 0.5 * morph.notePitch)) * (0.1 + 0.9 * lv * lv);
    }
    const pr2 = morph.presence * morph.presence;
    const vent = 1.4 * fx.lead.update(morph.notes, morph.leadAge, morph.noteLevel) + 0.25 * held.update(m.leadHeld * pr2, dt);
    const kickL = fx.kick.update(morph.kicks, morph.kickAge, morph.kickLevel);
    const snareL = fx.snare.update(morph.snares, morph.snareAge, morph.snareLevel);
    const hatL = hat.update(m.hat * pr2, dt);
    const pitchL = pitch.update(0.5 + 0.5 * Math.max(-1, Math.min(1, morph.notePitch)), dt);
    // Packed per burst: whole centiseconds since the note, fraction = height / 40 (negative: none).
    const burst = (i: number) => {
      const age = m.time - b.t[i];
      return age >= 0 && age < 3 ? Math.floor(age * 100) + Math.min(b.h[i] / 40, 0.99) : -1;
    };

    // Camera: angle around the vent, radius, height above ground, mode.
    const R = [[50, 80, 24, 55], [27, 60, 45, 28], [55, 80, 22, 45], [50, 75, 22, 40]][type][cam];
    const angSpeed = [0.012, 0.006, 0.0035, 0.004][cam];
    p[0] = cam;
    p[1] = g[0] * 6.283 + ctx.travel * angSpeed + (ev[0] - 0.5) * 0.6;
    p[2] = R * (cam === 2 ? 1 : 0.9 + 0.25 * ev[1]) * (1 - 0.06 * antic);
    p[3] = [(type === 1 ? 11 : 6) + 5 * g[7], 30 + 16 * g[0], type === 1 ? 1.2 : type === 2 ? 4.5 : 2.6, 9][cam];
    p[4] = burst(0);
    p[5] = [1.3, 1.5, 1.15, 1.35][cam] + 0.12 * antic - 0.15 * drop;
    p[6] = burst(1);
    // Kick age (under 1 s) with the kick's level squared in hundredths above it.
    p[7] = Math.min(morph.kickAge, 0.99) + Math.round(Math.min(1, morph.kickLevel ** 2) * 99);

    // Terrain.
    p[8] = type;
    // Crust style plus 4 x sky type.
    p[9] = q(g[2], 4) + 4 * sky;
    p[10] = 1.5 + 3.0 * g[7];
    p[11] = (g[6] * 2.3 + g[0]) % 1; // hue offset

    // Lava: exposure (molten fraction), glow gain, flow speed, kick throb.
    p[12] = 0.15 + 0.5 * g[6] + 0.3 * antic + 0.25 * drop + 0.08 * m.bass;
    p[13] = (0.75 + 0.35 * ctx.intensity + 0.3 * m.energy) * (1 + 0.25 * drop);
    // Flow phase: the lava moves with the music (faster when loud, on the beat) and rests in silence.
    p[14] = pu.clock * (0.45 + 0.6 * g[6]);
    p[15] = kickL * 0.6 + m.kickNext * 0.15 * pr2 + m.bass * 0.1;

    // Sky.
    // The eased snare (fraction) with the glided hats in hundredths above it.
    p[16] = Math.min(snareL, 0.999) + Math.round(Math.min(1, hatL) * 100);
    // The vent light (melody flare + held note) with the glided pitch in thousandths x 4 above it.
    p[17] = Math.min(vent, 3.99) + 4 * Math.round(pitchL * 1000);
    p[18] = p[1] + Math.PI + (g[4] * 4 - sky - 0.5) * 1.6;
    p[19] = [0.025, 0.2, 0.03, 0.26][sky] * (1 - 0.25 * antic);

    // Eruption: the vent is the melody's voice. Each note throws a fire fountain whose height is
    // the pitch (bursts above); plume amount and darkness.
    p[20] = (0.8 + 0.4 * m.energySlow) * (1 + 0.8 * drop);
    p[21] = burst(2);
    p[22] = Math.min(1, [0.55, 0.45, 1.0][erupt] * (0.6 + 0.4 * ev[3]) + (sky === 2 ? 0.3 : 0) + 0.2 * antic);
    p[23] = 0.4 + 0.5 * m.tension + 0.3 * antic;

    // Embers, fissure angle, layout seed, tremble.
    p[24] = 0.3 + 0.7 * m.high + 0.6 * hatL + 1.0 * drop;
    p[25] = g[0] * 3.1 + g[7] * 1.3;
    p[26] = g[0] * 37.0 + g[2] * 5.0;
    p[27] = burst(3);

    // Drop shockwave radius, volcanic lightning, plume wind.
    p[28] = m.dropPulse > 0.01 ? (1 - m.dropPulse) * 140 : -1;
    p[29] = (sky === 2 ? 1 : 0.5) * (snareL * 1.2 + drop);
    p[30] = (g[7] - 0.5) * 0.9 + (ev[3] - 0.5) * 0.4;
    p[31] = 4 * m.chordPulse * (1 - m.chordPulse);
  },
  wgsl: /* wgsl */ `
// p0: camMode, camAng, camR, camH       p1: burst0, fov, burst1, kickAge + 99 x kick level (hundredths)
// p2: type, crust + 4 x sky, rough, hue  p3: exposure, glow, flowPhase, throb
// p4: snare + hats (hundredths), vent light + 4 x pitch (thousandths), sunAz, skyLum
//                                        p5: fountain, burst2, plume, plumeDark
// p6: embers, fissAng, seed, burst3     p7: shockR, lightning, wind, chordSwell

fn lv_skyTy() -> f32 { return floor(S.p[2].y / 4.0); }
/** The eased snare and the glided hats (both scaled by how loud the passage is). */
fn lv_snare() -> f32 { return fract(S.p[4].x); }
fn lv_hat() -> f32 { return floor(S.p[4].x) / 100.0; }
/** The melody's light at the vent (eased flare + held note) and its glided pitch 0..1. */
fn lv_vent() -> f32 { return S.p[4].y - 4.0 * floor(S.p[4].y / 4.0); }
fn lv_pitch() -> f32 { return floor(S.p[4].y / 4.0) / 1000.0; }

/** Vent flare from the melody's latest note: lights the ground and lava around the vent. */
fn lv_flare(p: vec3f) -> f32 {
  return lv_vent() * exp(-length(p.xz) / 28.0);
}

/** Melody burst i: (seconds since its note, fountain height), or x < 0 when idle. */
fn lv_burst(i: i32) -> vec2f {
  var v = S.p[1].x;
  if (i == 1) { v = S.p[1].z; } else if (i == 2) { v = S.p[5].y; } else if (i == 3) { v = S.p[6].w; }
  if (v < 0.0) { return vec2f(-1.0, 0.0); }
  return vec2f(floor(v) * 0.01, fract(v) * 40.0);
}

fn lv_terrain(p: vec2f, oct: i32) -> vec4f {
  let ty = S.p[2].x;
  let sc = S.p[2].z;
  let seed = S.p[6].z;
  let n = fbm3(vec3f(p * 0.035, seed), oct);
  let d = length(p);
  var rock = 0.0;
  var lava = -1e3;
  var heat = 1.0;
  var prox = 0.0;
  if (ty < 0.5) {
    // Shield volcano with a summit pond and radial channels.
    let R = 70.0;
    let cone = 20.0 * exp(-pow(d / R, 1.5) * 2.2);
    let rc = 7.0;
    let crater = 5.5 * smoothstep(rc + 2.5, rc - 1.0, d);
    let base = cone - crater + n * sc * (0.3 + 0.7 * smoothstep(8.0, 40.0, d));
    let a = atan2(p.y, p.x);
    let N = 6.0;
    let u = a / TAU * N + 0.3 * noise3(vec3f(p * 0.025, seed + 3.0));
    let cd = abs(fract(u) - 0.5) / N * TAU * d;
    let w = 2.2 + d * 0.05;
    let on = smoothstep(rc, rc + 4.0, d) * smoothstep(R * 2.0, R * 1.3, d);
    rock = base - 1.0 * smoothstep(w, 0.0, cd) * on;
    lava = select(-1e3, base - 0.55, cd < w * 0.72 && on > 0.3);
    lava = max(lava, select(-1e3, 15.6, d < rc + 1.0));
    heat = select(1.0 - 0.6 * smoothstep(rc, R * 1.6, d), 1.0, d < rc + 1.0);
    prox = max(exp(-cd / (w * 2.5)) * on, smoothstep(rc + 6.0, rc, d));
  } else if (ty < 1.5) {
    // Caldera: ring wall around a lava lake with a spatter island vent.
    let R = 46.0;
    let a = atan2(p.y, p.x);
    let wallH = 15.0 * (0.75 + 0.35 * noise3(vec3f(a * 2.5, 0.5, seed)));
    let wall = wallH * smoothstep(R - 10.0, R - 1.0, d) * exp(-max(d - R, 0.0) / 28.0);
    let isl = 4.5 * exp(-d * d / 50.0) - 1.6 * smoothstep(2.2, 1.0, d);
    rock = -2.2 + wall + isl + n * sc * (0.25 + 0.75 * smoothstep(R - 6.0, R + 4.0, d));
    lava = select(-1e3, 0.0, d < R + 2.0);
    lava = max(lava, select(-1e3, 2.4, d < 1.6));
    heat = 1.0 - 0.35 * smoothstep(5.0, R, d);
    prox = smoothstep(R + 4.0, R - 8.0, d);
  } else if (ty < 2.5) {
    // Fissure field: long glowing cracks lined by spatter ramparts.
    let rp = rot2(S.p[6].y) * p;
    let x = rp.x + 9.0 * noise3(vec3f(rp.y * 0.015, 0.3, seed)) + 2.0 * noise3(vec3f(rp.y * 0.06, 1.3, seed));
    let spc = 18.0;
    let id = round(x / spc);
    let fd = abs(x - spc * id);
    let segN = noise3(vec3f(id * 7.1, rp.y * 0.016, seed + 1.0));
    let seg = select(smoothstep(-0.15, 0.2, segN), 1.0, id == 0.0 && abs(rp.y) < 70.0);
    let base = n * sc * 1.3 + 3.0 * noise3(vec3f(p * 0.008, seed + 4.0)) + 10.0 * smoothstep(70.0, 190.0, d) * (n + 0.6);
    let rampart = 1.0 * exp(-(fd - 3.4) * (fd - 3.4) / 1.6) * seg * (0.7 + 0.5 * noise3(vec3f(rp * 0.2, seed)));
    let crack = 2.0 * smoothstep(3.0, 1.2, fd) * seg;
    rock = base + rampart - crack;
    lava = select(-1e3, base - 0.35, fd < 2.6 && seg > 0.45);
    heat = 0.75 + 0.25 * seg;
    prox = exp(-fd / 4.5) * seg;
  } else {
    // Lava plain: braided rivers around a spatter cone.
    let base = 0.7 + n * sc * 0.9 + 7.0 * smoothstep(80.0, 210.0, d) * (n + 0.6);
    let wp = p + 22.0 * vec2f(noise3(vec3f(p * 0.012, seed + 2.0)), noise3(vec3f(p * 0.012, seed + 7.0)));
    let rv = abs(noise3(vec3f(wp * 0.02, seed + 5.0)));
    let carve = 4.2 * smoothstep(0.22, 0.03, rv);
    let cone = 7.0 * exp(-d * d / 160.0) - 2.6 * smoothstep(3.0, 1.2, d);
    rock = base - carve + cone;
    lava = 0.0;
    lava = max(lava, select(-1e3, 5.6, d < 1.6));
    heat = 0.8;
    prox = max(smoothstep(0.32, 0.0, rv), smoothstep(1.5, -0.5, rock));
  }
  // Anticipation tremble and drop shockwave.
  let sr = S.p[7].x;
  if (sr > 0.0) { rock += 0.8 * exp(-(d - sr) * (d - sr) * 0.05) * (1.0 - sr / 140.0); }
  return vec4f(rock, lava, heat, prox);
}

fn lv_h(p: vec2f, oct: i32) -> f32 { let t = lv_terrain(p, oct); return max(t.x, t.y); }

fn lv_normal(p: vec2f, e: f32, oct: i32) -> vec3f {
  let hx = lv_h(p + vec2f(e, 0.0), oct) - lv_h(p - vec2f(e, 0.0), oct);
  let hz = lv_h(p + vec2f(0.0, e), oct) - lv_h(p - vec2f(0.0, e), oct);
  return normalize(vec3f(-hx, 2.0 * e, -hz));
}

fn lv_march(ro: vec3f, rd: vec3f, t0: f32, tmax: f32) -> f32 {
  var t = t0;
  var lt = t0;
  for (var i = 0; i < 110; i++) {
    let p = ro + rd * t;
    let d = p.y - lv_h(p.xz, 2);
    if (d < 0.002 * t) {
      var a = lt;
      var b = t;
      for (var k = 0; k < 5; k++) {
        let m = 0.5 * (a + b);
        let pm = ro + rd * m;
        if (pm.y - lv_h(pm.xz, 2) < 0.0) { b = m; } else { a = m; }
      }
      return b;
    }
    if (rd.y > 0.0 && p.y > 40.0) { break; }
    lt = t;
    t += max(d * 0.5, 0.02 + 0.006 * t);
    if (t > tmax) { break; }
  }
  return -1.0;
}

/** Blackbody-ish ramp, tinted toward the palette. T in [0,1]. */
fn lv_heat(T: f32) -> vec3f {
  let t = sat(T);
  let bb = vec3f(sat(t * 2.4), pow(sat(t * 1.7 - 0.45), 1.6), pow(sat(t * 2.2 - 1.3), 2.0));
  let tint = palL(S.p[2].w + 0.05 * F.morph2.x, 1.0);
  let tn = tint / max(max(tint.r, max(tint.g, tint.b)), 0.05);
  return bb * mix(vec3f(1.0), tn, 0.18) * (pow(t, 2.5) * 6.0 + t * 0.25);
}

fn lv_vor(c: vec2f) -> vec2f {
  let i = floor(c);
  let f = fract(c);
  var d1 = 9.0;
  var d2 = 9.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2f(f32(x), f32(y));
      let h = hash33(vec3f(i + o, 3.0)).xy;
      let r = o + 0.5 + 0.42 * sin(h * 6.2831 + S.p[3].z * 0.12) - f;
      let dd = dot(r, r);
      if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) { d2 = dd; }
    }
  }
  return vec2f(sqrt(d1), sqrt(d2));
}

/** Flow-advected crust coordinates for the lava surface at p. */
fn lv_flowCoord(p: vec2f) -> vec2f {
  let ty = S.p[2].x;
  let ft = S.p[3].z;
  let d = length(p);
  if (ty < 0.5) {
    if (d < 9.0) { return rot2(ft * 0.04) * p * 0.6; }
    let a = atan2(p.y, p.x);
    return vec2f(a * d * 0.6, (d - ft * 1.2) * 0.6);
  } else if (ty < 1.5) {
    return rot2(ft * 0.012) * p * 0.35 - vec2f(0.0, ft * 0.05);
  } else if (ty < 2.5) {
    let rp = rot2(S.p[6].y) * p;
    return vec2f(rp.x * 1.2, rp.y * 0.5 - ft * 0.7);
  }
  let fl = rot2(S.p[6].y) * vec2f(0.0, 1.0);
  return p * 0.5 - fl * ft * 0.5;
}

/** Lava surface temperature 0..1 from the crust pattern. */
fn lv_line(d: f32, w: f32, fp: f32) -> f32 {
  // Anti-aliased bright line: widens to the pixel footprint but keeps its energy.
  let we = max(w, fp);
  return smoothstep(we, 0.0, d) * (w / we);
}

fn lv_crust(p: vec2f, heat: f32, fpW: f32) -> f32 {
  let c = lv_flowCoord(p);
  let style = S.p[2].y - 4.0 * floor(S.p[2].y / 4.0);
  let expo = S.p[3].x;
  let fp = fpW * 0.6;
  var T = 0.0;
  if (style < 0.5) {
    // Drifting crust plates with incandescent seams and a warm halo along them.
    let sc = 1.1;
    let v = lv_vor(c * sc);
    let edge = (v.y - v.x) / sc;
    let fine = abs(noise3(vec3f(c * 1.7, 5.0)));
    let sv = 0.6 + 0.4 * noise3(vec3f(c * 0.4, 7.0));
    T = 0.05 + 0.2 * smoothstep(0.4, 0.0, edge) + 0.8 * sv * lv_line(edge, 0.025 + 0.06 * expo, fp) + 0.25 * lv_line(fine, 0.02, fp * 1.7);
  } else if (style < 1.5) {
    // Ropy pahoehoe folds.
    let w = noise3(vec3f(c * 0.25, 1.0));
    let ph = c.y * 4.5 + w * 6.0 + noise3(vec3f(c * 0.8, 4.0)) * 1.4;
    let fd = abs(fract(ph / TAU) - 0.5) * TAU / 4.5;
    T = 0.05 + 0.15 * smoothstep(0.3, 0.7, w) + 0.75 * lv_line(fd, 0.06 + 0.12 * expo, fp);
  } else if (style < 2.5) {
    // Clinkery aa: dark rubble with hot gaps.
    let n = fbm3(vec3f(c * 1.3, 2.0), 3);
    T = 0.03 + 0.55 * smoothstep(-0.18 - 0.15 * expo, -0.34 - 0.1 * expo, n) + 0.18 * smoothstep(0.0, -0.2, n);
  } else {
    // Thin cracked skin with hot spots.
    let n1 = abs(noise3(vec3f(c * 0.45, 6.0)));
    let n2 = abs(noise3(vec3f(c * 1.3, 9.0)));
    let crack = lv_line(n1 / 0.45 * 0.6, 0.05 + 0.05 * expo, fp) + 0.6 * lv_line(n2 / 1.3 * 0.6, 0.025, fp);
    let spots = smoothstep(0.25, 0.6, noise3(vec3f(c * 0.12, 3.0 + S.p[3].z * 0.04)));
    T = 0.08 + 0.8 * sat(crack) + 0.35 * spots * expo;
  }
  // Molten breakthroughs grow with exposure; kicks throb the heat.
  let br = smoothstep(0.6 - 0.4 * expo, 0.8 - 0.35 * expo, noise3(vec3f(c * 0.16, 11.0 + S.p[3].z * 0.025)));
  T = max(T, br * (0.36 + 0.1 * expo));
  let ty = S.p[2].x;
  let chan = select(0.0, select(0.32, 0.26, ty > 2.5), ty < 0.5 || ty > 1.5);
  T = max(T, chan * (0.6 + 0.5 * noise3(vec3f(c * 0.35, 2.0)) + 0.15 * noise3(vec3f(c * 1.4, 5.0))));
  T = T * heat * (1.0 + S.p[3].w * 0.9 + 0.35 * lv_snare());
  // Kick: a pulse of heat runs outward from the vent through the molten surface.
  let ka = fract(S.p[1].w);
  let kl = floor(S.p[1].w) / 99.0;
  let kr = length(p) - ka * 140.0;
  T = max(T, T + 0.45 * exp(-kr * kr / 60.0) * exp(-ka * 3.0) * smoothstep(0.0, 0.12, ka) * step(ka, 0.8) * kl);
  return sat(T);
}

fn lv_sunDir() -> vec3f {
  let sk = lv_skyTy();
  let e = select(select(0.0, 0.45, sk > 2.5), 0.07, sk > 0.5 && sk < 1.5);
  let a = S.p[4].z;
  return normalize(vec3f(sin(a) * cos(e), sin(e), cos(a) * cos(e)));
}

fn lv_glowCol() -> vec3f { return lv_heat(0.55) / 2.2; }

fn lv_sky(rd: vec3f) -> vec3f {
  let ty = lv_skyTy();
  let y = max(rd.y, 0.0);
  let L = S.p[4].w;
  let hue = S.p[2].w;
  var horizon: vec3f;
  var zenith: vec3f;
  if (ty < 0.5) {
    horizon = palL(hue + 0.05, 1.0) * 0.4 + lv_glowCol() * 0.6;
    zenith = palL(hue + 0.55, 1.0) * 0.25;
  } else if (ty < 1.5) {
    horizon = mix(vec3f(1.0, 0.45, 0.2) * 1.4, palL(hue + 0.1, 1.0), 0.45);
    zenith = mix(vec3f(0.25, 0.2, 0.6), palL(hue + 0.6, 1.0), 0.4) * 0.35;
  } else if (ty < 2.5) {
    horizon = mix(vec3f(0.8, 0.35, 0.15), palL(hue, 1.0), 0.35);
    zenith = mix(vec3f(0.35, 0.3, 0.28), palL(hue + 0.5, 1.0), 0.3) * 0.25;
  } else {
    horizon = mix(vec3f(1.0, 0.9, 0.75), palL(hue + 0.15, 1.0), 0.3);
    zenith = mix(vec3f(0.55, 0.62, 0.75), palL(hue + 0.5, 1.0), 0.35) * 0.7;
  }
  var col = mix(horizon, zenith, pow(sat(y * 2.0), 0.6)) * L;
  // Lava light under the horizon haze.
  col += lv_glowCol() * exp(-y * 14.0) * 0.06 * S.p[3].y;
  let sd = lv_sunDir();
  let mu = sat(dot(rd, sd));
  if (ty > 0.5 && ty < 1.5) {
    col += mix(vec3f(1.0, 0.5, 0.25), horizon, 0.3) * (pow(mu, 10.0) * 0.4 + pow(mu, 400.0) * 12.0) * L * 3.0;
  } else if (ty > 2.5) {
    col += vec3f(1.0, 0.92, 0.8) * (pow(mu, 6.0) * 0.25 + pow(mu, 3000.0) * 10.0) * L * 2.0;
  }
  // Ash overcast / smoke banks.
  let cl = fbmFast(vec3f(rd.xz / (y + 0.08) * 0.35 + vec2f(S.p[3].z * 0.008, 0.0), 2.0), 4);
  let cover = select(select(0.15, 0.85, ty > 1.5 && ty < 2.5), 0.35, ty > 2.5);
  let cd = smoothstep(0.25 - cover * 0.6, 0.55 - cover * 0.4, cl) * smoothstep(0.0, 0.08, y);
  let under = lv_glowCol() * 0.08 * S.p[3].y * (0.6 + 0.6 * F.bass) + horizon * L * 0.25;
  col = mix(col, under * (0.6 + 0.6 * cl), cd * 0.85);
  // Stars on clear nights.
  if (ty < 0.5) {
    let g = rd * 280.0;
    let hs = hash13(floor(g));
    col += vec3f(0.9, 0.9, 1.0) * smoothstep(0.996, 1.0, hs) * smoothstep(0.4, 0.0, length(fract(g) - 0.5)) * smoothstep(0.05, 0.3, y) * (1.0 - cd) * (0.6 + lv_hat());
  }
  return col;
}

/**
 * The melody's fire fountains: every note throws a burst of glowing bombs from the vent whose
 * height is set by its pitch (four bursts in flight at most), occluded by the hit distance.
 */
fn lv_fountain(ro: vec3f, rd: vec3f, vent: vec3f, tHit: f32) -> vec3f {
  let amt = S.p[5].x;
  let ty = S.p[2].x;
  let fiss = ty > 1.5 && ty < 2.5;
  let fAx = rot2(-S.p[6].y) * vec2f(0.0, 1.0);
  var acc = vec3f(0.0);
  var colGlow = vec3f(0.0);
  let gr = 24.0;
  let boost = 1.0 + 0.5 * F.dropPulse;
  for (var b = 0; b < 4; b++) {
    let bu = lv_burst(b);
    if (bu.x < 0.0) { continue; }
    let age = bu.x;
    let H = bu.y;
    let fade = exp(-age * 0.9);
    // A fissure throws its curtain of fire from a point along the crack chosen per note.
    var o = vent;
    if (fiss) { o += vec3f(fAx.x, 0.0, fAx.y) * (fract(H * 7.31) - 0.5) * 40.0; }
    for (var i = 0; i < 20; i++) {
      let fi = f32(i) + f32(b) * 20.0;
      let h = hash33(vec3f(fi, floor(H * 13.0), 3.3));
      let s = age - h.y * 0.1;
      let v0 = sqrt(2.0 * gr * H * (0.5 + 0.5 * h.x));
      let Tf = 2.0 * v0 / gr;
      if (s <= 0.0 || s > Tf) { continue; }
      let ang = h.z * TAU;
      let spread = (0.05 + 0.18 * fract(h.x * 7.0)) * v0;
      let dir = vec3f(cos(ang) * spread, 0.0, sin(ang) * spread);
      let pos = o + dir * s * boost + vec3f(0.0, (v0 * s - 0.5 * gr * s * s) * boost, 0.0);
      let vel = (dir + vec3f(0.0, v0 - gr * s, 0.0)) * boost;
      // Motion-blurred streak: closest approach between the view ray and the segment.
      let sa = pos - vel * 0.06;
      let ba = vel * 0.06;
      let w0 = ro - sa;
      let bb = dot(rd, ba);
      let cc = dot(ba, ba);
      let dd0 = dot(rd, w0);
      let ee = dot(ba, w0);
      let den = max(cc - bb * bb, 1e-5);
      let hh = sat((ee - bb * dd0) / den);
      let qp = sa + ba * hh;
      let tp = dot(qp - ro, rd);
      if (tp < 1.0 || tp > tHit) { continue; }
      let dd = length(ro + rd * tp - qp);
      let r = 0.1 + 0.08 * fract(h.y * 5.0);
      let w = max(r, tp * 0.0016);
      let core = exp(-dd * dd / (w * w)) * (r / w);
      let halo = exp(-dd / (w * 5.0)) * 0.06;
      let Tm = 0.98 - 0.45 * s / Tf;
      acc += lv_heat(Tm) * (core + halo) * fade * smoothstep(3.0, 20.0, tp);
    }
    // The column of fire over the vent while the burst rises.
    let rel = o + vec3f(0.0, H * 0.45, 0.0) - ro;
    let tv = dot(rel, rd);
    if (tv > 0.0 && tv < tHit + 6.0) {
      let dv = length(rel - rd * tv);
      colGlow += lv_heat(0.75) * exp(-dv / (1.2 + H * 0.15)) * 0.15 * exp(-age * 3.5);
    }
  }
  return (acc * 0.8 + colGlow) * amt;
}

/** Ash plume rising from the vent, lit from below by the lava. */
fn lv_plume(ro: vec3f, rd: vec3f, vent: vec3f, tHit: f32, jit: f32) -> vec4f {
  let amt = S.p[5].z;
  if (amt < 0.02) { return vec4f(0.0); }
  let wind = S.p[7].z;
  // Bounding vertical cylinder (leaning with the wind) around the vent.
  let Rb = 26.0 + 12.0 * amt;
  let oc = ro.xz - vent.xz;
  let a = dot(rd.xz, rd.xz);
  let b = dot(oc, rd.xz);
  let c = dot(oc, oc) - Rb * Rb;
  let disc = b * b - a * c;
  if (disc < 0.0 || a < 1e-5) { return vec4f(0.0); }
  let sq = sqrt(disc);
  var t0 = max((-b - sq) / a, 0.0);
  var t1 = min((-b + sq) / a, tHit);
  if (t1 <= t0) { return vec4f(0.0); }
  let steps = 26;
  let dt = (t1 - t0) / f32(steps);
  var t = t0 + dt * jit;
  var trans = 1.0;
  var col = vec3f(0.0);
  let glow = lv_glowCol() * S.p[3].y;
  let sky = lv_sky(vec3f(0.0, 1.0, 0.0));
  let fl = S.p[7].y;
  for (var i = 0; i < steps; i++) {
    let p = ro + rd * t;
    let y = p.y - vent.y;
    if (y > -2.0) {
      let lean = vec2f(wind * y * 0.35, 0.0);
      let rad = 3.0 + y * 0.32 * (0.6 + 0.6 * amt);
      let rq = length(p.xz - vent.xz - lean);
      let q = vec3f(p.x, p.y - S.p[3].z * 2.0, p.z) * 0.09;
      let n = fbmFast(q + vec3f(0.0, 0.0, S.p[3].z * 0.04), 4);
      var dens = smoothstep(rad, rad * 0.3, rq + n * rad * 0.8) * smoothstep(-2.0, 3.0, y) * smoothstep(90.0, 50.0, y);
      dens *= amt * 0.35;
      if (dens > 0.001) {
        let low = exp(-max(y, 0.0) / 12.0);
        let lit = glow * (0.35 * low + 0.03) * (1.0 + 0.5 * S.p[3].w) + sky * 0.25 * (0.4 + 0.6 * sat(n + 0.5)) * (1.0 - 0.6 * S.p[5].w);
        let flash = vec3f(0.7, 0.6, 1.0) * fl * 0.6 * smoothstep(0.1, 0.4, n) * step(10.0, y);
        // The melody lights the ash from inside at the height its pitch throws the fire.
        let hy = y - (6.0 + 30.0 * lv_pitch());
        let leadLit = lv_heat(0.7) * exp(-hy * hy / 50.0) * 1.15 * lv_vent() * (0.5 + 0.5 * sat(n + 0.6));
        let a2 = 1.0 - exp(-dens * dt);
        col += trans * a2 * (lit * 0.6 + flash + leadLit);
        trans *= 1.0 - a2;
        if (trans < 0.03) { break; }
      }
    }
    t += dt;
  }
  return vec4f(col, 1.0 - trans);
}

/** Embers swirling up around the camera on nested cylinders. */
fn lv_embers(rd: vec3f, pxA: f32) -> vec3f {
  let amt = S.p[6].x;
  var acc = vec3f(0.0);
  let hl = max(length(rd.xz), 0.05);
  let ang = atan2(rd.x, rd.z);
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let r = 2.5 + fk * fk * 4.0;
    let y = rd.y / hl * r;
    let dens = 5.0;
    let mc = S.p[3].z;
    let sway = sin(y * 0.4 + mc * 0.5 + fk) * 0.3;
    let u = vec2f((ang * r + sway) * dens / r * 3.0, (y - mc * (1.2 + 0.8 * fk)) * 1.2);
    let cell = floor(u);
    let h = hash33(vec3f(cell, fk));
    let fp = fract(u) - 0.5 - (h.xy - 0.5) * 0.7;
    let px = pxA * r / hl * dens / r * 3.0;
    let sz = max(0.04 / (1.0 + fk), px * 0.8);
    let dot1 = smoothstep(sz, 0.0, length(fp)) * (0.04 / (1.0 + fk)) / sz;
    let on = step(h.z, 0.12 * amt);
    let flick = 0.6 + 0.4 * sin(mc * (5.0 + 6.0 * h.x) + h.y * 30.0);
    acc += lv_heat(0.55 + 0.3 * h.x) * dot1 * on * flick * 0.5;
  }
  return acc;
}

/** Camera ground position on its orbit; fissure fields squash it along the main fissure. */
fn lv_camXZ(ang: f32, R: f32) -> vec2f {
  let ty = S.p[2].x;
  if (ty > 1.5 && ty < 2.5) {
    let ax = rot2(-S.p[6].y) * vec2f(0.0, 1.0);
    let pp = vec2f(ax.y, -ax.x);
    return ax * cos(ang) * R + pp * (8.0 + R * 0.6 * (0.5 + 0.5 * sin(ang)));
  }
  return vec2f(cos(ang), sin(ang)) * R;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let mode = S.p[0].x;
  let ang = S.p[0].y;
  let R = S.p[0].z;
  var ro: vec3f;
  var ta: vec3f;
  let ventT = lv_terrain(vec2f(0.0), 3);
  let vent = vec3f(0.0, max(ventT.x, ventT.y), 0.0);
  if (mode < 0.5) {
    // Low flyover circling the vent, looking ahead and slightly inward.
    let xz = lv_camXZ(ang, R);
    let ahead = lv_camXZ(ang + 0.35, R * 0.8);
    let gy = lv_h(xz, 2);
    ro = vec3f(xz.x, max(gy, 0.0) + S.p[0].w, xz.y);
    ta = vec3f(ahead.x, max(lv_h(ahead, 2), 0.0) + S.p[0].w * 0.4 - 0.8 * F.anticipation, ahead.y);
  } else if (mode < 1.5) {
    // High orbit looking down into the vent.
    let xz = lv_camXZ(ang, R);
    ro = vec3f(xz.x, vent.y + S.p[0].w, xz.y);
    ta = vent + vec3f(0.0, 3.0, 0.0);
  } else if (mode < 2.5) {
    // On foot, at the edge of the flow, facing the vent.
    let xz = lv_camXZ(ang, R);
    ro = vec3f(xz.x, lv_h(xz, 3) + S.p[0].w + 0.1 * sin(F.spin * 0.5), xz.y);
    ta = vent + vec3f(0.0, 5.5, 0.0) + vec3f(sin(F.spin * 0.07) * 8.0, 0.0, 0.0);
  } else {
    // Crane: slow rise and fall on a fixed bearing.
    let xz = lv_camXZ(ang, R);
    let crane = 0.5 + 0.5 * sin(F.spin * 0.06);
    ro = vec3f(xz.x, max(lv_h(xz, 2), 0.0) + 2.5 + crane * 26.0, xz.y);
    ta = vent + vec3f(0.0, 2.0 + (1.0 - crane) * 8.0, 0.0);
  }
  let cam = lookAt(ro, ta, (F.evolve.z - 0.5) * 0.25 + 0.02 * sin(F.spin * 0.13));
  let fov = S.p[1].y;
  let rd = normalize(cam * vec3f(q, fov));
  let pxA = 2.0 / (F.res.y * fov);
  let jit = ign(frag);

  let sd = lv_sunDir();
  let skyTy = lv_skyTy();
  let sunI = select(select(0.0, 1.6, skyTy > 0.5 && skyTy < 1.5), 1.1, skyTy > 2.5);
  let L = S.p[4].w;
  let glowC = lv_glowCol() * S.p[3].y;

  let tHit = lv_march(ro, rd, 0.1 + jit * 0.1, 260.0);
  var col: vec3f;
  var tEnd = 1e4;
  if (tHit < 0.0) {
    col = lv_sky(rd);
  } else {
    tEnd = tHit;
    let p = ro + rd * tHit;
    let tr = lv_terrain(p.xz, 4);
    let isLava = tr.y >= tr.x;
    let n = lv_normal(p.xz, 0.02 + 0.002 * tHit, select(5, 2, isLava));
    let hemi = 0.5 + 0.5 * n.y;
    let skyAmb = lv_sky(vec3f(0.0, 1.0, 0.0)) * hemi * 0.6;
    if (isLava) {
      let T = lv_crust(p.xz, tr.z, tHit * pxA / max(abs(rd.y), 0.15));
      let crustAlb = palRampL(0.1, 0.03) + vec3f(0.02);
      var c = crustAlb * (skyAmb + sunI * L * 2.0 * sat(dot(n, sd)) + glowC * 0.4);
      // Sheen of the glassy crust.
      let fre = pow(1.0 - sat(dot(n, -rd)), 4.0);
      c += lv_sky(reflect(rd, n)) * fre * 0.08;
      c += lv_heat(T) * S.p[3].y;
      c += crustAlb * lv_glowCol() * lv_flare(p) * 6.0 + lv_heat(0.6) * lv_flare(p) * smoothstep(0.25, 0.7, T) * 0.4;
      // Chord change: a heat wave rolls across the surface.
      c += lv_heat(0.6) * S.p[7].w * 0.25 * smoothstep(0.4, 0.9, T);
      col = c;
    } else {
      // Basalt with fine cooling cracks, lit by sky, sun and nearby lava.
      let alb = mix(palRampL(0.05, 0.035), vec3f(0.045, 0.04, 0.04), 0.5);
      let rough = fbm3(vec3f(p.xz * 0.9, p.y * 0.9), 2);
      var c = alb * (0.75 + 0.5 * rough);
      let dif = sat(dot(n, sd));
      let toLava = sat(0.35 + 0.65 * n.y);
      var light = skyAmb + sunI * L * 3.0 * dif;
      light += glowC * tr.w * (0.55 + 0.5 * toLava) * (1.0 + 1.2 * S.p[3].w);
      light += lv_glowCol() * lv_flare(p) * (0.4 + 0.6 * toLava) * 3.0;
      // Drop shock ring glow.
      let sr = S.p[7].x;
      if (sr > 0.0) { light += glowC * 2.0 * exp(-abs(length(p.xz) - sr) * 0.5) * (1.0 - sr / 140.0); }
      c *= light;
      // Hot fractures near the flow.
      let fr = smoothstep(0.035, 0.0, abs(noise3(vec3f(p.xz * 0.6, 4.0)))) * smoothstep(0.15, 0.45, noise3(vec3f(p.xz * 0.13, 8.0)));
      // Snares crack the cooling rock open: the fractures near the flows flare.
      c += lv_heat(0.45 + 0.2 * S.p[3].x + 0.15 * lv_snare()) * fr * (pow(tr.w, 4.0) * (0.35 + 3.0 * lv_snare()) + 0.5 * lv_snare() * tr.w) * S.p[3].y;
      // Rim light from the sky on ridges.
      c += lv_sky(normalize(vec3f(rd.x, 0.2, rd.z))) * pow(1.0 - sat(dot(n, -rd)), 4.0) * 0.25;
      col = c;
    }
    // Haze: sky colour far away, hot glow low down.
    let fogT = 1.0 - exp(-tHit * (0.006 + 0.01 * S.p[5].z * 0.5));
    col = mix(col, lv_sky(normalize(vec3f(rd.x, max(rd.y, 0.0) * 0.4, rd.z))), fogT);
    col += glowC * 0.04 * (1.0 - exp(-tHit * 0.02)) * exp(-max(p.y, 0.0) * 0.15);
  }

  let pl = lv_plume(ro, rd, vent, tEnd, jit);
  col = col * (1.0 - pl.a) + pl.rgb;
  col += lv_fountain(ro, rd, vent, tEnd);
  col += lv_embers(rd, pxA) * select(1.0, 0.0, tHit > 0.0 && tHit < 3.0);
  // Drop flash.
  col += glowC * F.dropPulse * F.dropPulse * 0.04;
  return vec4f(col, 1.0);
}
`,
});
