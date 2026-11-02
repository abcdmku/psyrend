import { raymarchScene } from '../raymarchScene';
import type { SceneUpdateContext } from '../types';
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
const evs = { kick: { x: 0, v: 0 }, snare: { x: 0, v: 0 }, note: { x: 0, v: 0 }, held: { x: 0, v: 0 }, pitch: { x: 0, v: 0 }, hat: { x: 0, v: 0 } };
const sat01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Per-instance music clock: a phase that advances with tempo and loudness, surges on each beat
 * and rests in silence, plus the seconds since the last kick, snare and melody attack.
 */
interface Pulse { t: number; clock: number; lead: number; kick: number; snare: number; leadAge: number; kickAge: number; snareAge: number }
const pulses = new WeakMap<Float32Array, Pulse>();
function musicPulse(ctx: SceneUpdateContext, key: Float32Array): Pulse {
  const m = ctx.music;
  let s = pulses.get(key);
  if (!s) {
    s = { t: m.time, clock: 0, lead: 0, kick: 0, snare: 0, leadAge: 9, kickAge: 9, snareAge: 9 };
    pulses.set(key, s);
  }
  const dt = m.time - s.t;
  s.t = m.time;
  if (dt > 0 && dt < 0.5) {
    const gate = Math.min(1, m.energy * 5);
    s.clock += dt * (m.bpm / 60) * gate * (0.3 + 0.7 * m.energySlow) * (0.4 + 1.8 * Math.exp(-m.beatPhase * 5));
    s.leadAge += dt;
    s.kickAge += dt;
    s.snareAge += dt;
  } else if (dt !== 0) {
    s.leadAge = s.kickAge = s.snareAge = 9;
  }
  if (m.lead > s.lead + 0.08) s.leadAge = 0;
  if (m.kick > s.kick + 0.15) s.kickAge = 0;
  if (m.snare > s.snare + 0.15) s.snareAge = 0;
  s.lead = m.lead;
  s.kick = m.kick;
  s.snare = m.snare;
  return s;
}

/**
 * Frozen spires. A glide along a path through ice: a forest of tilted hexagonal
 * spires, a blue ice cave hung with icicles, a fluted frozen waterfall, or a grove
 * of branching crystal trees on snow. Ice is shaded with fresnel reflection, a
 * refracted view absorbed by an estimated thickness, subsurface blue where it is
 * thin, feathery frost and sparkling glints. Every reaction goes by its event's strength
 * (morph levels) and eases in. Kicks send glowing cracks racing
 * outward through the ice, hats sparkle the frost, the drop shatters the air into
 * diamond dust, and snow drifts through it all.
 *
 * DNA: g1 formation, g2 light (moon, polar day, aurora, inner glow), g3 camera rig,
 * g4 snow, g5 ice material (clear, glacial blue, frosted), g6 formation scale /
 * density, g7 crack pattern and hue, g0 layout seed.
 */

export default raymarchScene({
  meta: {
    id: 'ice-forest',
    name: 'Frozen Spires',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0, 0.75],
    mood: { valence: 0.45, arousal: 0.3 },
    genres: { ambient: 1, classical: 0.9, acoustic: 0.7, edm: 0.6, synthwave: 0.4, pop: 0.4 },
    trails: 0.3,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const antic = m.anticipation;
    const drop = m.dropPulse;
    const q = (x: number, n: number) => Math.floor(Math.min(x, 0.9999) * n);
    const form = q(g[1], 4);
    const light = q(g[2], 4);
    const cam = q(g[3], 4);
    const snow = q(g[4], 4);
    const mat = q(g[5], 3);
    const pu = musicPulse(ctx, p);
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    mo.update(m, ctx.dt, g);
    // Eased envelopes, each scaled by its event's level (which carries the passage's presence). The
    // beats' are x1.6: the eased curve peaks near 0.6 of its target, so a full hit still lands fully.
    const kE = sat01(1.6 * glide(evs.kick, mo.kickLevel * Math.exp(-mo.kickAge / 0.3), dt));
    const sL = sat01(glide(evs.snare, mo.snareLevel, dt, 12));
    const nE = glide(evs.note, mo.noteLevel * Math.exp(-mo.leadAge / 0.35), dt);
    const held = glide(evs.held, m.leadHeld * mo.presence, dt, 12);
    const pitch = glide(evs.pitch, m.leadPitch, dt, 9);
    const hat = glide(evs.hat, m.hat * mo.presence, dt);

    // Camera.
    p[0] = ctx.travel * [0.55, 0.3, 0.4, 0.22][cam] * (1 - 0.4 * antic);
    // The camera mode carries the kick front's progress in its fraction (the shader compares at .5).
    p[1] = cam + 0.45 * Math.exp(-mo.kickAge / 0.3);
    p[2] = [1.5, 1.7, 0.6, 0.55][cam] + (form === 1 ? 0.2 : 0);
    p[3] = [1.35, 1.5, 1.25, 2.0][cam] + 0.15 * antic - 0.12 * drop;

    // Formation.
    p[4] = form;
    p[5] = 0.75 + 0.6 * g[6] + 0.1 * (ev[0] - 0.5);
    p[6] = g[0] * 40;
    p[7] = (g[7] * 2.9 + g[0] * 0.3) % 1;

    // Light.
    // The light mode carries the latest snare's strength in its fraction (compared at .5).
    p[8] = light + 0.45 * sL;
    p[9] = [0.55, 0.13, 0.9, 0.3][light] + (ev[1] - 0.5) * 0.08;
    p[10] = g[0] * 6.283 + [0.4, 2.4, 0, 1.2][q(g[6], 4)];
    p[11] = [1.2, 2.4, 0.9, 0.35][light] * (1 - 0.35 * antic) * (0.9 + 0.3 * m.tension);

    // Sky, snow, wind, absorption.
    p[12] = [0.07, 0.22, 0.045, 0.07][light] * (1 - 0.3 * antic);
    p[13] = [0, 0.35, 0.8, 1.4][snow] * (0.7 + 0.5 * m.energySlow) + 0.4 * antic;
    p[14] = [0.1, 0.25, 0.6, 1.6][snow] + 0.8 * antic;
    p[15] = [0.25, 0.9, 0.5][mat];

    // Frost, SSS, glints, crack glow.
    p[16] = [0.25, 0.4, 0.9][mat];
    p[17] = [0.6, 1.2, 0.8][mat];
    p[18] = 0.5 + 1.5 * m.high + 2.5 * hat + 6 * drop;
    p[19] = (light === 3 ? 0.5 : 0.008) + 0.2 * m.tension * (light === 3 ? 1 : 0.3);

    // Crack pulse (kick), drop, anticipation, crack scale.
    p[20] = kE;
    p[21] = drop;
    p[22] = antic;
    p[23] = 0.8 + 1.6 * g[7];

    // Evolution: growth / tilt, aurora phase, side bias.
    // Kicks push the ice up a little (by their strength, eased in): the formation grows on the beat.
    p[24] = 0.85 + 0.25 * ev[2] + 0.1 * kE + 0.04 * m.kickNext * mo.presence;
    p[25] = pu.clock * 0.08 + ev[3];
    p[26] = (g[3] * 7.3) % 1 < 0.5 ? 1 : -1;
    p[27] = 4 * m.chordPulse * (1 - m.chordPulse);

    // Melody: a band of light inside the ice at a height set by the pitch, struck by each note.
    const caveH = form === 1 ? 3.6 : form === 2 ? 9 : 6.5;
    // The band glides to the pitch's height; its light eases in by the note's strength.
    p[28] = 0.35 + caveH * (0.5 + 0.5 * pitch);
    p[29] = 2.2 * nE + 0.45 * held;
    // Snare: a wave of frost light runs away down the path. Music clock for snow and wind.
    p[30] = Math.min(mo.snareAge, 9);
    p[31] = pu.clock;
  },
  wgsl: /* wgsl */ `
// p0: travel, camMode, camH, fov        p1: form, scale, seed, hue
// p2: light, keyElev, keyAz, keyInt     p3: skyLum, snow, wind, absorb
// p4: frost, sss, glint, crackGlow      p5: kick, drop, antic, crackScale
// p6: growth, auroraPh, side, chord     p7: leadY, leadAmt, snareAge, clock

fn if_path(z: f32) -> f32 { return sin(z * 0.07) * 3.5 + sin(z * 0.031 + 1.7) * 5.0; }

fn if_hex(q: vec2f) -> f32 { let k = abs(q); return max(k.x * 0.866025 + k.y * 0.5, k.y); }

/** Hexagonal crystal with a pyramidal tip at height h. */
fn if_crystal(q: vec3f, r: f32, h: f32) -> f32 {
  let hx = if_hex(q.xz);
  let side = hx - r;
  let tip = (q.y + hx * 2.2 - h) * 0.41;
  return max(max(side, tip), -q.y - 0.6);
}

fn if_ground(xz: vec2f) -> f32 {
  // Broad drifts plus cheap wind ripples (sastrugi).
  return 0.25 * noise3(vec3f(xz * 0.18, 1.0)) + 0.035 * sin(xz.x * 1.7 + 1.2 * sin(xz.y * 0.6)) * sin(xz.y * 0.9 + xz.x * 0.3);
}

fn if_keyDir() -> vec3f {
  let e = S.p[2].y;
  let a = S.p[2].z;
  return normalize(vec3f(sin(a) * cos(e), sin(e), cos(a) * cos(e)));
}

// Spire field: own cell and three neighbours, two crystals per cell.
fn if_spires(p: vec3f) -> f32 {
  let sc = S.p[1].y;
  let cs = 3.4 * sc;
  let seed = S.p[1].z;
  let grow = S.p[6].x;
  let base = floor(p.xz / cs - 0.5);
  var d = 1e5;
  for (var j = 0; j < 4; j++) {
    let cell = base + vec2f(f32(j & 1), f32(j >> 1));
    let hc = hash33(vec3f(cell, seed));
    let ctr = (cell + 0.5 + (hc.xy - 0.5) * 0.5) * cs;
    let clear = smoothstep(1.6, 3.2, abs(ctr.x - if_path(ctr.y)));
    if (clear < 0.05 || hc.z > 0.85) { continue; }
    var q = p - vec3f(ctr.x, -0.3, ctr.y);
    let tq = rotX((hc.x - 0.5) * 0.5) * rotZ((hc.y - 0.5) * 0.5) * q;
    let h = (1.6 + 9.0 * hc.z * hc.z) * sc * clear * grow;
    let r = (0.3 + 0.45 * hc.x) * sc;
    d = min(d, if_crystal(tq, r, h));
    let h2 = hash33(vec3f(cell, seed + 5.0));
    let q2 = rotZ((h2.x - 0.5) * 1.1) * rotX((h2.y - 0.5) * 1.1) * (q - vec3f((h2.z - 0.5) * 0.9 * sc, 0.0, (h2.x - 0.5) * 0.9 * sc));
    d = min(d, if_crystal(q2, r * 0.6, h * (0.35 + 0.4 * h2.y)));
  }
  return d;
}

// Crystal trees: a trunk with three levels of folded, tilted shards.
fn if_trees(p: vec3f) -> f32 {
  let sc = S.p[1].y;
  let cs = 8.0 * sc;
  let seed = S.p[1].z;
  let cell = floor(p.xz / cs);
  let hc = hash33(vec3f(cell, seed + 2.0));
  let ctr = (cell + 0.5 + (hc.xy - 0.5) * 0.3) * cs;
  let clear = smoothstep(2.0, 3.8, abs(ctr.x - if_path(ctr.y)));
  let cc0 = (cell + 0.5) * cs;
  let edge0 = cs * 0.5 - max(abs(p.x - cc0.x), abs(p.z - cc0.y));
  if (clear < 0.05) { return max(edge0, 0.0) + 0.4; }
  let s0 = sc * (1.7 + 1.0 * hc.z) * clear * S.p[6].x;
  var q = (p - vec3f(ctr.x, -0.2, ctr.y)) / s0;
  q = rotY(hc.x * 6.28) * q;
  var d = if_crystal(q, 0.16, 4.2);
  // Whorls of upward-angled shards, shorter toward the crown.
  let sector = TAU / 5.0;
  for (var k = 0; k < 4; k++) {
    let fk = f32(k);
    let qk = q - vec3f(0.0, 0.5 + fk * 0.85, 0.0);
    let off = fk * 0.7 + hc.y * 3.0;
    let ang = atan2(qk.z, qk.x);
    let a0 = round((ang - off) / sector) * sector + off;
    let c = cos(a0);
    let sn = sin(a0);
    let lq = vec3f(qk.x * c + qk.z * sn, qk.y, -qk.x * sn + qk.z * c);
    let tilt = 0.95 - fk * 0.12 + (hc.z - 0.5) * 0.3;
    let qb = rotZ(tilt) * lq;
    d = min(d, if_crystal(qb, 0.1 - fk * 0.012, 2.3 - fk * 0.42));
  }
  let cc = (cell + 0.5) * cs;
  let edge = cs * 0.5 - max(abs(p.x - cc.x), abs(p.z - cc.y));
  return min(d * s0, max(edge, 0.0) + 0.4);
}

// Ice cave: noisy tube around the path, icicles from the roof, a frozen floor.
fn if_cave(p: vec3f) -> vec2f {
  let c = vec2f(p.x - if_path(p.z), p.y - 1.6);
  let ang = atan2(c.y, c.x);
  let R = 3.4 * S.p[1].y + 0.9 * noise3(vec3f(cos(ang) * 1.5, sin(ang) * 1.5, p.z * 0.12)) + 0.25 * noise3(p * 0.7);
  let wall = (R - length(c)) * 0.8;
  let flo = p.y - if_ground(p.xz) * 0.3;
  // Icicles.
  let ic = 0.75;
  let cell = floor(p.xz / ic);
  let hc = hash33(vec3f(cell, 9.0));
  let cc = (cell + 0.5 + (hc.xy - 0.5) * 0.5) * ic;
  let cx = cc.x - if_path(cc.y);
  let top = 1.6 + sqrt(max(R * R - cx * cx, 0.0)) * 0.95;
  let L = (0.3 + 1.6 * hc.z * hc.z) * S.p[6].x;
  let rel = p.y - (top - L);
  let rad = 0.16 * sat(rel / L) + 0.005;
  let ici = select(1e5, (length(p.xz - cc) - rad) * 0.6, hc.z > 0.25 && rel > 0.0);
  let iciB = select(ici, max(ici, -rel), rel <= 0.0);
  let d = min(min(wall, flo), max(iciB, -0.1));
  let m = select(select(3.0, 0.0, flo < wall), 2.0, iciB < min(wall, flo));
  return vec2f(min(d, ic * 0.4 + max(0.0, min(wall, flo))), m);
}

// Frozen waterfalls: cascades of fluted ice down a dark cliff beside the path,
// fringed with icicles at the lip and spreading into mounds at the foot.
fn if_fall(p: vec3f) -> vec2f {
  let side = S.p[6].z;
  let sc = S.p[1].y;
  let xw = if_path(p.z) + side * 9.0 * sc;
  let dist = side * (xw - p.x);
  let top = 11.0 * sc + 2.0 * noise3(vec3f(p.z * 0.05, 1.0, 2.0));
  // Rock cliff with strata.
  let rn = 0.6 * noise3(vec3f(p.y * 0.25, p.z * 0.25, 1.0)) + 0.25 * noise3(vec3f(p.y * 1.4, p.z * 0.6, 4.0));
  let rock = max((dist + 0.3 - rn) * 0.7, p.y - top);
  // Fall zones along the cliff.
  let per = 26.0 * sc;
  let id = floor(p.z / per);
  let hz = hash11(id * 3.7 + S.p[1].z);
  let w = per * (0.2 + 0.18 * hz);
  let across = abs(p.z - (id + 0.5) * per) / w;
  let foot = exp(-max(p.y, 0.0) * 0.35);
  let u = p.z * 1.4 + 1.5 * noise3(vec3f(p.y * 0.07, p.z * 0.1, 3.0));
  let flutes = (0.45 * sqrt(abs(sin(u))) + 0.25 * sqrt(abs(sin(u * 2.3 + 1.0)))) * (0.7 + 0.5 * noise3(vec3f(p.y * 0.2, p.z * 0.3, 5.0)));
  let drip = 0.15 * noise3(vec3f(p.y * 0.9, p.z * 2.5, 7.0));
  let bulge = (1.0 - across * across) * (1.2 + 3.2 * foot) * S.p[6].x + flutes + drip;
  let ice = max((dist - bulge) * 0.55, max(across - 1.0 - 0.3 * foot, p.y - top - 0.3));
  // Icicle fringe hanging from the lip across each fall.
  let ic = 0.4;
  let cz = (floor(p.z / ic) + 0.5) * ic;
  let hl = hash11(floor(p.z / ic) * 1.7 + 3.0);
  let L = (0.6 + 3.2 * hl * hl) * S.p[6].x * step(across, 1.15);
  let rel = p.y - (top - L);
  let rr = 0.13 * sat(rel / max(L, 0.01));
  let qx = dist - (1.0 - min(across * across, 1.0)) * 1.4 - 0.5;
  let ici = select(1e5, (length(vec2f(qx, p.z - cz)) - rr) * 0.6, rel > 0.0 && p.y < top + 0.2 && L > 0.1);
  let iceD = min(ice, max(ici, -0.05));
  return select(vec2f(rock, 4.0), vec2f(iceD, 1.0), iceD < rock);
}

fn if_map(p: vec3f) -> vec2f {
  let f = S.p[1].x;
  if (f > 0.5 && f < 1.5) { return if_cave(p); }
  let g = p.y - if_ground(p.xz);
  var r = vec2f(1e5, 1.0);
  if (f < 0.5) { r.x = if_spires(p); }
  else if (f < 2.5) { r = if_fall(p); }
  else { r.x = if_trees(p); }
  return select(r, vec2f(g, 0.0), g < r.x);
}

fn if_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * if_map(p + k.xyy * e).x + k.yyx * if_map(p + k.yyx * e).x + k.yxy * if_map(p + k.yxy * e).x + k.xxx * if_map(p + k.xxx * e).x);
}

fn if_aurora(rd: vec3f) -> vec3f {
  if (rd.y < 0.02) { return vec3f(0.0); }
  let ph = S.p[6].y;
  var acc = vec3f(0.0);
  // Vertical curtains: sample the same folded ribbon at several heights.
  for (var j = 0; j < 7; j++) {
    let fj = f32(j);
    let H = 1.0 + fj * 0.3;
    let w = rd.xz / rd.y * H * 0.22 + vec2f(0.0, ph * 0.4);
    let band = w.y + 0.9 * sin(w.x * 0.45 + ph) + 0.6 * noise3(vec3f(w * 0.35, ph * 0.5));
    let curtain = exp(-pow(fract(band * 0.18) - 0.5, 2.0) * 90.0);
    let along = w.x + 0.3 * band;
    let rays = 0.35 + 0.65 * noise3fast(vec3f(along * 3.0, ph * 2.0, 0.5));
    let lvl = 0.5 + 1.5 * spec(0.1 + fract(along * 0.05) * 0.7);
    let c = palL(S.p[1].w + 0.3 + fj * 0.05 + F.morph2.x * 0.1, 1.0);
    acc += c * curtain * rays * lvl * exp(-fj * 0.3);
  }
  return acc * smoothstep(0.02, 0.2, rd.y) * 0.2;
}

fn if_sky(rd: vec3f) -> vec3f {
  let lt = S.p[2].x;
  let L = S.p[3].x;
  let hue = S.p[1].w;
  let y = rd.y;
  let iceNat = vec3f(0.35, 0.6, 1.0);
  let zen = mix(iceNat / luma(iceNat), palL(hue + 0.55, 1.0), 0.25);
  let horNat = select(vec3f(0.55, 0.65, 1.0), vec3f(1.0, 0.85, 0.75), lt > 0.5 && lt < 1.5);
  let hor = mix(horNat / luma(horNat), palL(hue + 0.1, 1.0), 0.25);
  var col = mix(hor * L * 1.2, zen * L * 0.6, pow(sat(y * 1.5), 0.6));
  col = mix(col, hor * L * 0.8, smoothstep(0.0, -0.3, y));
  let kd = if_keyDir();
  let mu = dot(rd, kd);
  let ki = S.p[2].w;
  if (lt < 0.5) {
    // Moon, stars.
    let dd = acos(clamp(mu, -1.0, 1.0));
    col += vec3f(0.85, 0.9, 1.0) * smoothstep(0.03, 0.026, dd) * (2.5 + 0.6 * fbm3(vec3f(rd * 60.0), 3));
    col += vec3f(0.6, 0.7, 1.0) * pow(sat(mu), 30.0) * 0.08;
  } else if (lt < 1.5) {
    // Low polar sun with a 22-degree halo and a sun pillar.
    let dd = acos(clamp(mu, -1.0, 1.0));
    let sunC = mix(vec3f(1.0, 0.88, 0.7), palL(hue + 0.05, 0.9), 0.25);
    col += sunC * (smoothstep(0.02, 0.016, dd) * 25.0 + pow(sat(mu), 12.0) * 0.4 * L / 0.22);
    col += sunC * exp(-pow((dd - 0.384) * 40.0, 2.0)) * 0.12 * (1.0 + 4.0 * F.chordPulse * (1.0 - F.chordPulse));
    let right = normalize(cross(vec3f(0.0, 1.0, 0.0), kd));
    col += sunC * exp(-abs(dot(rd, right)) * 90.0) * exp(-abs(y - kd.y) * 4.0) * 0.12;
  } else if (lt < 2.5) {
    col += if_aurora(rd) * (1.0 + 2.4 * F.chordPulse * (1.0 - F.chordPulse) + 0.8 * F.dropPulse);
  }
  // Stars on dark skies.
  if (lt != 1.0 && y > 0.0) {
    let g = rd * 300.0;
    let hs = hash13(floor(g));
    col += vec3f(0.9, 0.93, 1.0) * smoothstep(0.996, 1.0, hs) * smoothstep(0.4, 0.0, length(fract(g) - 0.5)) * smoothstep(0.02, 0.2, y) * (0.6 + 1.2 * F.hat * hash11(hs * 13.0)) * select(1.0, 0.4, lt > 2.5);
  }
  return col;
}

/** Key light colour per lighting mode. */
fn if_keyCol() -> vec3f {
  let lt = S.p[2].x;
  let hue = S.p[1].w;
  var c = vec3f(0.7, 0.8, 1.0);
  if (lt > 0.5 && lt < 1.5) { c = mix(vec3f(1.0, 0.85, 0.65), palL(hue + 0.05, 0.85), 0.25); }
  else if (lt > 1.5 && lt < 2.5) { c = mix(vec3f(0.4, 1.0, 0.7), palL(S.p[1].w + 0.3 + F.morph2.x * 0.1, 0.8), 0.6); }
  else if (lt > 2.5) { c = palL(hue + 0.6, 0.7); }
  return c * S.p[2].w;
}

/** Environment seen through/reflected by ice: sky outside, glowing blue walls in the cave. */
fn if_env(rd: vec3f) -> vec3f {
  let f = S.p[1].x;
  if (f > 0.5 && f < 1.5) {
    let blue = mix(vec3f(0.2, 0.55, 1.0), palL(S.p[1].w + 0.5, 1.0), 0.2);
    return blue * (0.05 + 0.08 * sat(rd.y + 0.5)) * (1.0 + S.p[2].w * 0.3);
  }
  return if_sky(rd);
}

fn if_shadow(ro: vec3f, rd: vec3f) -> f32 {
  var res = 1.0;
  var t = 0.08;
  for (var i = 0; i < 22; i++) {
    let h = if_map(ro + rd * t).x;
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.06, 0.8);
    if (res < 0.02 || t > 18.0) { break; }
  }
  return sat(res);
}

/** Glowing crack network that races outward from a point on each kick. */
fn if_vorEdge(c: vec2f) -> f32 {
  let i = floor(c);
  let f = fract(c);
  var d1 = 9.0;
  var d2 = 9.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2f(f32(x), f32(y));
      let r = o + hash33(vec3f(i + o, 1.0)).xy - f;
      let dd = dot(r, r);
      if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) { d2 = dd; }
    }
  }
  return sqrt(d2) - sqrt(d1);
}

fn if_cracks(p: vec3f, n: vec3f, fp: f32) -> f32 {
  let s = S.p[5].w;
  // Project on the dominant plane of the normal so crack polygons stay crisp.
  let an = abs(n);
  var uv = p.xy;
  if (an.x > an.y && an.x > an.z) { uv = p.zy; } else if (an.y > an.z) { uv = p.xz; }
  let wq = uv * s + 0.35 * vec2f(noise3(p * 1.3), noise3(p * 1.3 + 7.0));
  let e1 = if_vorEdge(wq);
  let e2 = if_vorEdge(wq * 2.6 + 3.0);
  let w1 = max(0.03, fp * s);
  let line = smoothstep(w1, 0.0, e1) * (0.03 / w1) + 0.45 * smoothstep(w1, 0.0, e2) * (0.03 / w1) * smoothstep(0.35, 0.05, e1);
  let beat = floor(F.songTime * F.bpm / 60.0);
  let o = vec3f(if_path(S.p[0].x + 8.0) + (hash11(beat * 3.7) - 0.5) * 8.0, 1.5, S.p[0].x + 6.0 + hash11(beat * 1.3) * 8.0);
  let r = length(p - o);
  // The front races out with the kick's age (camera-mode fraction); its light is the kick's eased level.
  let front = (1.0 - fract(S.p[0].y) / 0.45) * 14.0;
  let lit = (exp(-abs(r - front) * 1.2) + 0.05 * smoothstep(front, front - 2.0, r)) * S.p[5].x;
  return line * (S.p[4].w + 4.0 * lit + 2.0 * S.p[5].y);
}

/** Melody: a band of light held inside the ice at the pitch's height, struck by each note. */
fn if_leadLight(p: vec3f) -> f32 {
  let y = p.y - S.p[7].x;
  return exp(-y * y * 4.0 / (1.0 + 0.6 * S.p[7].y)) * S.p[7].y;
}

fn if_leadCol() -> vec3f { return palL(S.p[1].w + 0.18 + F.morph2.x * 0.2, 1.0); }

/** Snare: a ring of frost light racing away from the camera along the path. */
fn if_snareWave(p: vec3f) -> f32 {
  let age = S.p[7].z;
  if (age > 1.2) { return 0.0; }
  let dz = p.z - (S.p[0].x + 1.0 + age * 32.0);
  // Rises over 0.1 s and goes with the snare's strength (light-mode fraction).
  return exp(-dz * dz * 0.3) * exp(-age * 2.5) * smoothstep(0.0, 0.1, age) * fract(S.p[2].x) / 0.45;
}

fn if_snow(rd: vec3f, pxA: f32, snowK: f32) -> vec3f {
  let amt = S.p[3].y * snowK;
  let dd = S.p[5].y;
  if (amt < 0.02 && dd < 0.02) { return vec3f(0.0); }
  var acc = vec3f(0.0);
  let hl = max(length(rd.xz), 0.05);
  let ang = atan2(rd.x, rd.z);
  let wind = S.p[3].z;
  for (var k = 0; k < 4; k++) {
    let fk = f32(k);
    let r = 1.0 + fk * fk * 1.8;
    let y = rd.y / hl * r;
    let dens = 2.2;
    let mc = S.p[7].w;
    let u = vec2f((ang * r + wind * mc * 0.45 / r + sin(y * 0.8 + mc * 0.35 + fk) * 0.15) * dens, (y + mc * (0.45 + 0.12 * fk) * (1.0 + wind * 0.5)) * dens);
    let cell = floor(u);
    let h = hash33(vec3f(cell, fk + 4.0));
    let fpp = fract(u) - 0.5 - (h.xy - 0.5) * 0.7;
    let px = pxA * r / hl * dens;
    let sz = max(0.05 / (1.0 + fk * 0.6), px);
    let dot1 = smoothstep(sz, sz * 0.3, length(fpp)) * min(1.0, 0.05 / (1.0 + fk * 0.6) / sz);
    let on = step(h.z, amt * 0.35);
    acc += vec3f(1.0) * dot1 * on * (0.5 - fk * 0.08);
    // Diamond dust on the drop: glinting coloured crystals.
    let on2 = step(h.z, dd * 0.6) * step(0.5, h.x);
    acc += palL(h.y + S.p[1].w, 1.0) * dot1 * on2 * 3.0 * (0.5 + 0.5 * sin(S.p[7].w * 16.0 + h.x * 40.0));
  }
  return acc;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let mode = S.p[0].y;
  let z = S.p[0].x;
  let f = S.p[1].x;
  let side = S.p[6].z;
  var h = S.p[0].z;
  if (mode > 1.5 && mode < 2.5) { h = 0.5 + 6.0 * (0.5 + 0.5 * sin(F.spin * 0.05)); }
  if (f > 0.5 && f < 1.5) { h = min(h, 2.6); }
  let ro = vec3f(if_path(z), h + 0.06 * sin(F.spin * 0.3) + if_ground(vec2f(if_path(z), z)) * 0.5, z);
  var ta = vec3f(if_path(z + 4.0), h * 0.85 + 0.25, z + 4.0);
  if (mode > 0.5 && mode < 1.5) { ta = ro + vec3f(side * 3.0, 0.6, 1.4); }
  if (mode > 2.5) { ta = ro + vec3f(side * 2.0 + sin(F.spin * 0.07), 0.35, 2.5); }
  if (f > 0.5 && f < 1.5 && mode > 0.5) { ta = vec3f(if_path(z + 4.0) + side * 0.8, 1.9, z + 4.0); }
  if (f > 1.5 && f < 2.5) { ta = ta + vec3f(side * 0.6, 0.6, 0.0); }
  let cam = lookAt(ro, ta, 0.04 * sin(F.spin * 0.11));
  let fov = S.p[0].w;
  let rd = normalize(cam * vec3f(q, fov));
  let pxA = 2.0 / (F.res.y * fov);

  let kd = if_keyDir();
  let kc = if_keyCol() * select(1.0, 0.3, f > 0.5 && f < 1.5);
  let lt = S.p[2].x;
  let L = S.p[3].x;
  let ambSky = if_sky(vec3f(0.0, 1.0, 0.0)) * 0.9 + vec3f(0.004, 0.006, 0.012);
  let caveBlue = mix(vec3f(0.2, 0.55, 1.0), palL(S.p[1].w + 0.5, 1.0), 0.2);
  let isCave = f > 0.5 && f < 1.5;

  var t = 0.02 + ign(frag) * 0.03;
  var hit = false;
  var m = 0.0;
  for (var i = 0; i < 120; i++) {
    let r = if_map(ro + rd * t);
    if (r.x < 0.0006 * t + 0.0005) { hit = true; m = r.y; break; }
    t += r.x * 0.9;
    if (t > 90.0) { break; }
  }

  var col: vec3f;
  var fogC = if_sky(normalize(vec3f(rd.x, 0.03, rd.z))) * 0.9;
  if (isCave) { fogC = caveBlue * 0.16; }
  if (!hit) {
    col = select(if_sky(rd), caveBlue * 0.3, isCave);
  } else {
    let p = ro + rd * t;
    let n = if_normal(p, 0.0015 + 0.0006 * t);
    let v = -rd;
    let ndv = sat(dot(n, v));
    let sh = select(if_shadow(p + n * 0.02, kd), 0.12, isCave);
    let dif = sat(dot(n, kd)) * sh;
    let fp = t * pxA;
    if (m < 0.5) {
      // Snow: soft diffuse with blue shadow fill and sparkles.
      let alb = 0.55;
      var c = alb * (kc * dif * 0.55 + ambSky * (0.5 + 0.5 * n.y) * 1.2 + caveBlue * 0.02);
      if (isCave) {
        let fre0 = pow(1.0 - ndv, 4.0);
        c = alb * caveBlue * (0.1 + 0.08 * n.y) + caveBlue * (0.08 + 0.5 * fre0) * (0.6 + 0.4 * noise3(p * 2.0));
      }
      let gl = step(0.985, hash13(floor(p * 60.0))) * pow(sat(dot(reflect(rd, n), kd)), 12.0) * smoothstep(12.0, 2.0, t);
      c += vec3f(1.0) * gl * S.p[4].z * sh * 0.8;
      // The melody band and snare wave light the snow beneath the ice.
      c += if_leadCol() * if_leadLight(vec3f(p.x, p.y + 0.6, p.z)) * 0.08;
      c += (ambSky * 3.0 + vec3f(0.04)) * if_snareWave(p) * (0.4 + 0.6 * step(0.9, hash13(floor(p * 40.0))));
      col = c;
    } else if (m > 3.5) {
      // Dark cliff rock, snow on the ledges.
      let snowy = smoothstep(0.45, 0.8, n.y + 0.2 * noise3(p * 1.5));
      let strata = 0.7 + 0.3 * noise3(vec3f(p.y * 3.0, p.z * 0.3, 2.0));
      let alb = mix((palRampL(0.1, 0.05) + vec3f(0.03)) * strata, vec3f(0.5), snowy);
      col = alb * (kc * dif * 0.55 + ambSky * (0.4 + 0.6 * n.y) * 1.2);
    } else {
      // Ice.
      let fre = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
      let refl = if_env(reflect(rd, n));
      let rr = refract(rd, n, 0.76);
      let d1 = max(-if_map(p + rr * 0.35).x, 0.0);
      let d2 = max(-if_map(p + rr * 1.1).x, 0.0);
      let th = d1 + d2 * 1.5 + select(0.0, 1.2, m > 2.5) - select(0.0, 0.5, f > 1.5 && f < 2.5);
      let absorb = S.p[3].w;
      let tintNat = vec3f(0.25, 0.65, 1.0);
      let tint = mix(tintNat / luma(tintNat), palL(S.p[1].w + 0.5, 1.0), 0.22);
      let trans = exp(-th * absorb * (vec3f(1.6, 0.6, 0.25) * 1.2));
      var body = if_env(rr) * trans * 0.9;
      // Subsurface: light leaking through thin ice.
      let back = sat(dot(rd, kd) * 0.5 + 0.5);
      let thin = exp(-th * 1.2);
      let sssK = select(0.5, 0.9, f > 1.5 && f < 2.5);
      body += tint * (kc * (0.1 + 0.35 * back * back) * sh + ambSky * 0.6 + vec3f(0.01)) * S.p[4].y * (0.25 + 0.75 * thin) * sssK;
      if (isCave) { body += tint * 0.12 * (0.5 + 0.5 * noise3(p * 0.8)) * exp(-th * 0.4) * (1.0 + 0.4 * F.bass); }
      // Frost feathers whiten the surface.
      let fq = p * 7.0 + vec3f(S.p[1].z);
      let fr1 = 1.0 - abs(noise3(fq) + 0.5 * noise3(fq * 2.7));
      let fr2 = 1.0 - abs(noise3(fq * 6.1));
      let frost = sat(pow(sat(fr1), 14.0) * 0.8 + 0.5 * pow(fr2, 10.0)) * S.p[4].x * smoothstep(0.5, 0.0, fp * 6.0);
      let frostC = (kc * dif * 0.4 + ambSky * 0.6 + caveBlue * select(0.0, 0.15, isCave)) * 0.5;
      var c = mix(body, frostC, frost * 0.7 + S.p[4].x * 0.15);
      c = mix(c, refl, fre * (1.0 - frost * 0.5));
      // Sharp key highlight and glints.
      let hv = normalize(kd - rd);
      c += kc * pow(sat(dot(n, hv)), 140.0) * 2.5 * sh;
      let gc = floor(p * 24.0);
      let gl = step(0.975 - 0.02 * S.p[5].y, hash13(gc)) * pow(sat(dot(n, hv)), 20.0) * smoothstep(10.0, 1.5, t);
      c += (kc + vec3f(0.3)) * gl * S.p[4].z * 0.6 * sh;
      // Refraction highlight: rainbow-ish edge fire at grazing angles.
      c += palL(S.p[1].w + ndv * 1.5 + F.morph2.y * 0.2, 1.0) * pow(1.0 - ndv, 6.0) * 0.12 * (kc.x + kc.y + kc.z + 0.3);
      // Cracks.
      let cr = if_cracks(p, n, fp);
      c += palL(S.p[1].w + 0.45 + F.morph2.x * 0.15, 1.0) * cr * 0.4 * (1.0 + S.p[6].w);
      // Melody light glowing through the ice body; snare frost wave across the surface.
      c += if_leadCol() * if_leadLight(p) * (0.3 + 0.7 * thin) * 0.75;
      c += mix(vec3f(0.8, 0.9, 1.0), if_leadCol(), 0.2) * if_snareWave(p) * (0.25 + frost) * 0.9;
      col = c;
    }
    let fogD = select(0.025 + 0.02 * S.p[3].y, 0.06, isCave);
    col = mix(col, fogC, 1.0 - exp(-t * fogD));
  }
  // Snow and diamond dust in front of everything.
  col += if_snow(rd, pxA, select(1.0, 0.0, isCave)) * (ambSky * 1.6 + kc * 0.25 + select(vec3f(0.0), caveBlue * 0.15, isCave)) * select(1.0, 0.0, hit && t < 0.8);
  return vec4f(col, 1.0);
}
`,
});
