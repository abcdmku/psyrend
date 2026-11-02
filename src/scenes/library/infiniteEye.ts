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
const evs = { kick: { x: 0, v: 0 }, snare: { x: 0, v: 0 }, note: { x: 0, v: 0 }, pitch: { x: 0, v: 0 }, beat: { x: 0, v: 0 } };
/** The melody's rings: the latest note's strength, and the previous note's age and strength. */
const ring = { n: -1, l: 0, lp: 0, agep: 9, lastAge: 9, pitchT: 0 };

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
 * Iris: a giant eye whose iris is a real heightfield (stroma fibres, crypts,
 * collarette, pupillary ruff) under a wet refracting cornea on a veined
 * eyeball. Inside the pupil floats a smaller, different eye, and inside its
 * pupil another: on every drop the camera dives through the pupil and the inner
 * eye becomes the new world (self-similar zoom, seamless wrap).
 * DNA picks the iris family (organic stroma, mandala petals, reptile slit with
 * cracked gold, spiral galaxy), symmetry/fibre counts, colour layering
 * (two-zone, rainbow rings, sectoral heterochromia, starburst), camera rig
 * (frontal, 3/4 orbit, macro drift, roll), pupil size and zoom ratio, material
 * (matte organic, emissive fibres, iridescent) and surround (lash rays,
 * mandala rings, nebula).
 * Bass dilates the pupil, highs contract it, the fibres carry the spectrum
 * history outward from the pupil, kicks flash the ruff, snares the collarette (every
 * reaction by its event's strength, eased in; the melody's rings are a local ripple),
 * chords shift hue, anticipation contracts the pupil and creeps the camera in.
 */

const fract = (x: number) => x - Math.floor(x);
const ie = { zoom: 0, target: 0, lastDrop: 0, lastTime: -1, dnaKey: -1, clock: 0 };

export default raymarchScene({
  meta: {
    id: 'infinite-eye',
    name: 'Iris',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.2, 1],
    mood: { valence: 0.45, arousal: 0.6 },
    genres: { ambient: 0.9, dubstep: 0.9, edm: 0.8, hiphop: 0.7, rock: 0.6, techno: 0.5 },
    trails: 0.2,
  },
  params(ctx, p) {
    const m = ctx.music;
    const d = ctx.dna;
    const e = ctx.evolve;
    const ant = m.anticipation;
    const drop = m.dropPulse;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const pu = musicPulse(ctx, p);
    mo.update(m, ctx.dt, d);
    // Eased envelopes, each scaled by its event's level (which carries the passage's presence). The
    // beats' are x1.25 (the eased curve peaks near 0.6 of its target; the iris is already bright on a hit).
    const kE = 1.25 * glide(evs.kick, mo.kickLevel * Math.exp(-mo.kickAge / 0.22), dt);
    const sE = 1.25 * glide(evs.snare, mo.snareLevel * Math.exp(-mo.snareAge / 0.25), dt);
    const nE = glide(evs.note, mo.noteLevel * Math.exp(-mo.leadAge / 0.3), dt);
    const beat = glide(evs.beat, m.beatPulse * mo.presence, dt);
    if (ring.n < 0 || mo.notes < ring.n) {
      ring.l = ring.lp = 0;
      ring.agep = 9;
      ring.pitchT = m.leadPitch;
    } else if (mo.notes > ring.n) {
      ring.lp = ring.l;
      ring.agep = ring.lastAge;
      ring.l = mo.noteLevel;
      // The pupil's opening moves toward the note's pitch by the note's strength squared: a faint
      // motif ripples the rings, a strong melody in a full mix reshapes the eye.
      ring.pitchT += (m.leadPitch - ring.pitchT) * mo.noteLevel * mo.noteLevel;
    }
    ring.n = mo.notes;
    ring.agep = Math.min(9, ring.agep + dt);
    ring.lastAge = Math.min(9, mo.leadAge);
    const pitch = glide(evs.pitch, ring.pitchT, dt, 7);
    const dClock = Math.max(0, Math.min(pu.clock - ie.clock, 0.5));
    ie.clock = pu.clock;

    // Dive state: each drop zooms one full level through the pupil; anticipation
    // creeps in; a very slow drift reveals a new eye every couple of minutes.
    if (Math.abs(m.time - ie.lastTime) > 1 || d[0] !== ie.dnaKey) {
      ie.zoom = 0; ie.target = 0; ie.dnaKey = d[0];
    }
    ie.lastTime = m.time;
    if (drop > 0.9 && ie.lastDrop < 0.6) ie.target = Math.floor(ie.target) + 1;
    ie.lastDrop = drop;
    // The dive creeps on with the music (and rests in silence), faster through a build.
    ie.target += dClock * 0.004 + dt * 0.07 * ant * ant;
    ie.zoom += (ie.target - ie.zoom) * (1 - Math.exp(-dt * 1.4));
    // Wrap so floats stay precise (per-level seeds repeat every 64 levels).
    if (ie.zoom > 64) { ie.zoom -= 64; ie.target -= 64; }
    const zf = fract(ie.zoom);
    const level = Math.floor(ie.zoom);

    const fam = Math.floor(d[1] * 4) % 4;
    const syms = [7, 8, 9, 10, 12, 16];
    const n = syms[Math.floor(d[2] * syms.length) % syms.length];
    const colorMode = Math.floor(d[3] * 4) % 4;
    const rig = Math.floor(d[4] * 4) % 4;
    const matMode = Math.floor(d[6] * 3) % 3;
    const surround = Math.floor(d[7] * 3) % 3;

    // Pupil: the melody sets its opening (high notes contract it, low notes open it) and each
    // note makes it flinch; anticipation squeezes, the drop blows it open.
    const rho0 = 0.22 + 0.1 * d[5] + 0.04 * e[0];
    const rho = Math.min(0.55, Math.max(0.1, rho0 - 0.055 * pitch - 0.03 * nE + 0.03 * m.bass - 0.08 * ant + 0.18 * drop));
    const slit = fam === 2 ? 2.6 + 0.8 * e[1] - 1.2 * drop : 1;
    // p[1]: the previous note's ring (age in ms, strength in the fraction).
    p[0] = fam; p[1] = Math.floor(ring.agep * 1000) + 0.98 * ring.lp; p[2] = rho; p[3] = Math.max(1, slit);
    p[4] = colorMode; p[5] = matMode; p[6] = surround; p[7] = fract(d[0] * 4.3) + 0.15 * e[2];
    const lam = 0.17 + 0.05 * fract(d[5] * 3.7);
    const D = 0.85;
    p[8] = lam; p[9] = D; p[10] = zf; p[11] = level;

    // Camera; off-axis rigs recentre while diving so the camera threads the pupil.
    const sp = ctx.spin;
    const centre = Math.sin(Math.PI * zf);
    const w = 1 - centre;
    let ro: number[], ta: number[], roll = 0, fov = 1.5;
    // Close enough that the iris fills the frame: a landscape of fibres, not an eyeball in a void.
    const camD = 1.14 - 0.1 * e[3];
    if (rig === 0) {
      ro = [0.12 * Math.sin(sp * 0.13), 0.1 * Math.cos(sp * 0.11), camD];
      ta = [0, 0, 0];
    } else if (rig === 1) {
      const a = (0.2 * Math.sin(sp * 0.07 + d[4] * 7)) * w;
      const b = (0.12 * Math.cos(sp * 0.05 + d[4] * 3) + 0.05) * w;
      ro = [camD * Math.sin(a) * Math.cos(b), camD * Math.sin(b), camD * Math.cos(a) * Math.cos(b)];
      ta = [0, 0, 0];
    } else if (rig === 2) {
      const a = sp * 0.05 + d[4] * 9;
      const off = 0.55 * w;
      ro = [off * Math.cos(a), off * Math.sin(a), 0.95 + 0.1 * e[3]];
      ta = [off * 1.15 * Math.cos(a + 0.2), off * 1.15 * Math.sin(a + 0.2), 0];
      fov = 1.25;
    } else {
      ro = [0, 0, camD + 0.15 * Math.sin(sp * 0.2)];
      ta = [0, 0, 0];
      roll = sp * 0.1 * (d[4] > 0.875 ? -1 : 1);
    }
    p[12] = ro[0]; p[13] = ro[1]; p[14] = ro[2] - 0.12 * ant * (1 - drop); p[15] = fov;
    p[16] = ta[0]; p[17] = ta[1]; p[18] = ta[2]; p[19] = roll;
    // Light gain, emission gain, spiral twist, relief amplitude.
    p[20] = (0.85 + 0.35 * m.energySlow) * (1 - 0.4 * ant) + 0.55 * kE + 0.8 * drop * drop;
    p[21] = (0.4 + 0.9 * ctx.intensity) * (1 - 0.3 * ant) + 2.4 * m.chordPulse * (1 - m.chordPulse) + 1.2 * drop;
    p[22] = (1.5 + 2 * d[2]) * (1 + 0.5 * m.tension) * (d[0] > 0.5 ? 1 : -1);
    // Kicks swell the stroma relief: the iris breathes in depth on the beat.
    p[23] = (fam === 1 ? 0.07 : 0.06) * (1 + 0.8 * kE + 0.1 * m.kickNext * mo.presence);
    // Crypt count, fibre symmetry, light angle, anticipation.
    p[24] = 9 + Math.floor(fract(d[2] * 5.3) * 10);
    p[25] = n;
    p[26] = d[7] * 6.28 + 0.4 * Math.sin(sp * 0.05);
    // The latest note's ring: age in ms, strength in the fraction.
    p[27] = Math.floor(ring.lastAge * 1000) + 0.98 * ring.l;
    p[28] = sE; p[29] = kE; p[30] = beat;
    // The kick's age in ms, with its strength in the fraction.
    p[31] = Math.floor(Math.min(mo.kickAge, 9) * 1000) + 0.98 * Math.min(1, mo.kickLevel);
  },
  wgsl: /* wgsl */ `
const IE_RC: f32 = 1.12;

fn ie_pupil(xy: vec2f) -> f32 { return length(vec2f(xy.x * S.p[0].w, xy.y)) / S.p[0].z; }

// Iris relief at local xy (iris radius 1). Deep negative in the pupil and past the limbus.
fn ie_h(xy: vec2f, seed: f32) -> f32 {
  let r = length(xy);
  let pd = ie_pupil(xy);
  if (pd < 1.0 || r > 1.0) { return -6.0; }
  let th = atan2(xy.y, xy.x);
  let rho = S.p[0].z;
  let pu = sat((r - rho) / (1.0 - rho));
  let fam = S.p[0].x;
  let n = S.p[6].y;
  var h = 0.0;
  if (fam < 0.5) {
    // Organic stroma: wavy radial fibres, collarette, crypts, contraction furrows.
    let cu = 0.33 + 0.05 * sin(th * floor(n * 0.5) + seed);
    let thw = th + 0.05 * sin(pu * 9.0 + th * 3.0 + seed * 5.0);
    let f1 = pow(0.5 + 0.5 * cos(thw * n * 4.0), 3.0);
    let f2 = pow(0.5 + 0.5 * cos(thw * n * 7.0 + pu * 6.0), 6.0);
    h = 0.35 * smoothstep(0.0, cu, pu) * (1.0 - 0.5 * smoothstep(cu, 1.0, pu));
    h += f1 * 0.28 + f2 * 0.2;
    h += 0.45 * exp(-pow((pu - cu) / 0.035, 2.0));
    let cn = S.p[6].x;
    let cg = vec2f(th / TAU * cn, pu * 5.0);
    let cid = floor(cg);
    let cf = fract(cg) - 0.5;
    let on = step(0.45, hash12(cid + seed * 13.0));
    let cr = smoothstep(0.42, 0.12, length(cf * vec2f(1.5, 1.0))) * on * smoothstep(0.1, 0.25, pu) * smoothstep(0.95, 0.7, pu);
    h -= cr * 0.75;
    h += 0.1 * smoothstep(0.62, 0.85, pu) * sin(pu * 55.0);
  } else if (fam < 1.5) {
    // Mandala: staggered rings of petals with bead bands.
    let sec = TAU / n;
    let ring = pu * 4.0;
    let rid = floor(ring);
    let rf = fract(ring);
    let a = abs(fmod(th + rid * sec * 0.5 + sec * 0.5, sec) - sec * 0.5) / sec;
    let petal = smoothstep(0.06, 0.0, rf - (0.92 - 2.6 * a * a));
    h = 0.4 * petal * (0.4 + 0.6 * rf) + 0.15 * petal * smoothstep(0.05, 0.0, abs(a - 0.0) - 0.02);
    let bead = smoothstep(0.45, 0.25, length(vec2f((fract(th / sec * 3.0) - 0.5) * 1.2, (rf - 0.04) * 6.0)));
    h += 0.45 * bead;
    h += 0.15 * pow(0.5 + 0.5 * cos(th * n * 9.0), 4.0);
  } else if (fam < 2.5) {
    // Reptile: ridged cracked gold with radial streaks.
    let q = xy * 5.0 + vec2f(seed * 3.1);
    let nz = noise3(vec3f(q, seed));
    let ridge = pow(1.0 - abs(nz), 4.0);
    h = 0.3 + 0.35 * ridge * smoothstep(0.0, 0.2, pu);
    h += 0.2 * pow(0.5 + 0.5 * cos(th * n * 6.0 + nz * 3.0), 5.0);
    h -= 0.25 * smoothstep(0.55, 0.85, abs(nz)) ;
  } else {
    // Galaxy: logarithmic spiral arms, fine fibres, star speckles.
    let ths = th + S.p[5].z * log(pu + 0.12);
    let armN = floor(2.0 + n * 0.25);
    let arms = pow(0.5 + 0.5 * cos(ths * armN + seed), 3.0);
    h = 0.45 * arms * (1.0 - 0.4 * pu) + 0.12 * pow(0.5 + 0.5 * cos(ths * n * 8.0), 4.0);
    h += 0.1 * (1.0 - pu);
  }
  h += 0.55 * exp(-(pd - 1.0) * 22.0);
  h *= 1.0 - 0.75 * smoothstep(0.9, 1.0, r);
  return h;
}

// March the iris heightfield in level-local space. Returns (t, hit, exit t).
fn ie_traceIris(ro: vec3f, rd: vec3f, seed: f32) -> vec3f {
  let A = S.p[5].w;
  if (rd.z > -0.01) { return vec3f(-1.0, 0.0, -1.0); }
  let zt = A * 1.15;
  let zb = -A * 0.9;
  let t0 = max((zt - ro.z) / rd.z, 0.0);
  let t1 = (zb - ro.z) / rd.z;
  if (t1 < 0.0) { return vec3f(-1.0, 0.0, -1.0); }
  let N = 20;
  let st = (t1 - t0) / f32(N);
  for (var i = 1; i <= N; i++) {
    let t = t0 + st * f32(i);
    let p = ro + rd * t;
    if (p.z < A * ie_h(p.xy, seed)) {
      var lo = t - st;
      var hi = t;
      for (var j = 0; j < 5; j++) {
        let mid = 0.5 * (lo + hi);
        let pm = ro + rd * mid;
        if (pm.z < A * ie_h(pm.xy, seed)) { hi = mid; } else { lo = mid; }
      }
      return vec3f(hi, 1.0, t1);
    }
  }
  return vec3f(t1, 0.0, t1);
}

fn ie_irisNormal(xy: vec2f, seed: f32) -> vec3f {
  let e = 0.0025;
  let A = S.p[5].w;
  let hx = max(ie_h(xy + vec2f(e, 0.0), seed), -0.6) - max(ie_h(xy - vec2f(e, 0.0), seed), -0.6);
  let hy = max(ie_h(xy + vec2f(0.0, e), seed), -0.6) - max(ie_h(xy - vec2f(0.0, e), seed), -0.6);
  return normalize(vec3f(-hx * A / (2.0 * e), -hy * A / (2.0 * e), 1.0));
}

fn ie_sphere(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> vec2f {
  let oc = ro - c;
  let b = dot(oc, rd);
  let cc = dot(oc, oc) - r * r;
  let h = b * b - cc;
  if (h < 0.0) { return vec2f(-1.0); }
  let s = sqrt(h);
  return vec2f(-b - s, -b + s);
}

fn ie_hue() -> f32 { return S.p[1].w + F.morph2.x * 0.25 + F.chordHue * 0.04; }

fn ie_keyDir() -> vec3f { let a = S.p[6].z; return normalize(vec3f(cos(a) * 0.6, sin(a) * 0.6 + 0.25, 0.9)); }

// Studio reflected in the cornea: a softbox window and a ring light.
fn ie_env(rd: vec3f) -> vec3f {
  let hue = ie_hue();
  var c = palL(hue + 0.5 + 0.1 * rd.y, 0.02 + 0.03 * sat(rd.z));
  let k = ie_keyDir();
  let dk = dot(rd, k);
  let u = normalize(cross(k, vec3f(0.0, 0.0, 1.0) + vec3f(0.001)));
  let v = cross(u, k);
  let pw = vec2f(dot(rd, u), dot(rd, v)) / max(dk, 0.01);
  let win = smoothstep(0.025, 0.0, max(abs(pw.x) - 0.09, abs(pw.y) - 0.06)) * step(0.0, dk);
  let mull = smoothstep(0.008, 0.0, min(abs(pw.x), abs(pw.y)));
  c += mix(vec3f(1.0, 0.95, 0.88), F.pal3.rgb, 0.25) * win * (1.0 - 0.8 * mull) * 22.0 * S.p[5].x;
  let ring = exp(-abs(acos(clamp(rd.z, -1.0, 1.0)) - 0.55) * 60.0) * step(0.0, rd.z);
  c += palL(hue + 0.3, 1.0) * ring * (0.4 + 3.0 * S.p[7].y) * S.p[5].x;
  return c;
}

fn ie_irisColor(xy: vec2f, seed: f32, h: f32, n: vec3f, rd: vec3f, lv: f32) -> vec3f {
  let hue = ie_hue() + seed * 0.37;
  let r = length(xy);
  let th = atan2(xy.y, xy.x);
  let rho = S.p[0].z;
  let pu = sat((r - rho) / (1.0 - rho));
  let mode = S.p[1].x;
  var tone: f32;
  if (mode < 0.5) {
    tone = select(0.42, 0.0, pu < 0.33 + 0.03 * sin(th * 7.0 + seed));
  } else if (mode < 1.5) {
    tone = pu * 0.9;
  } else if (mode < 2.5) {
    tone = 0.5 * smoothstep(-0.3, 0.3, sin(th * 2.0 + seed * 4.0)) + 0.1 * pu;
  } else {
    tone = 0.1 + 0.25 * pu;
  }
  let lumA = 0.07 + 0.27 * sat(h + 0.25) * (1.0 - 0.35 * pu);
  var alb = palL(hue + tone, lumA);
  if (mode > 2.5) {
    // Starburst: hot rays around the pupil fading into a dark ring.
    let burst = exp(-pu * 4.0) * (0.6 + 0.4 * pow(0.5 + 0.5 * cos(th * S.p[6].y * 3.0), 3.0));
    alb += palL(hue + 0.55, 0.5) * burst;
  }
  let limbal = smoothstep(0.82, 1.0, r);
  alb *= 1.0 - 0.75 * limbal;
  let ruff = exp(-(ie_pupil(xy) - 1.0) * 20.0);
  alb = mix(alb, palL(hue + 0.6, 0.05), ruff * 0.7);
  let L = ie_keyDir();
  let lg = S.p[5].x;
  let dif = sat(dot(n, L) * 0.8 + 0.2);
  let ao = sat(0.45 + 0.9 * (h + 0.1));
  let amb = palL(hue + 0.5, 0.25);
  var c = alb * (vec3f(1.0, 0.96, 0.9) * dif * 1.25 * lg + amb * 0.45) * ao;
  let refl = reflect(rd, n);
  c += mix(vec3f(1.0), F.pal3.rgb, 0.3) * pow(sat(dot(refl, L)), 30.0) * 0.25 * lg * ao;
  // Fibres carry the spectrum history outward from the pupil.
  let mat = S.p[1].y;
  let band = fract(abs(th) / PI * 0.85 + 0.03);
  let hl = hist(band, pu * 0.8);
  let ridge = sat(h * 1.6 - 0.15);
  let eg = S.p[5].y;
  var emAmt = 0.25;
  if (mat > 0.5 && mat < 1.5) { emAmt = 1.0; }
  c += palL(hue + tone + 0.15, 1.0) * ridge * ridge * hl * hl * emAmt * eg * 1.2 * ao;
  if (mat > 1.5) {
    // Iridescent stroma: thin-film hue sliding with view angle and height.
    let film = fract(dot(n, -rd) * 1.5 + h * 1.5 + seed + F.warp * 0.03);
    c += palL(hue + film, 0.25) * pow(1.0 - sat(dot(n, -rd)), 1.0) * ridge * lg * 0.8;
  }
  // Collarette flashes with the snare, ruff with the kick.
  let cu = 0.33 + 0.05 * sin(th * floor(S.p[6].y * 0.5) + seed);
  c += palL(hue + 0.25, 1.0) * exp(-pow((pu - cu) / 0.03, 2.0)) * S.p[7].x * 0.8 * eg;
  c += palL(hue + 0.6, 1.0) * ruff * S.p[7].y * 1.5 * eg;
  // Melody: each note sends a ring of light out through the fibres from the pupil to the
  // limbus; its hue follows the pitch, and a held note keeps the inner iris glowing.
  // Each ring goes with its note's strength and rises over about 0.1 s; the previous note's ring keeps
  // running out, so a new note never cuts it off.
  let la = floor(S.p[6].w) / 1000.0;
  let ll = fract(S.p[6].w) / 0.98;
  let lap = floor(S.p[0].y) / 1000.0;
  let llp = fract(S.p[0].y) / 0.98;
  let lc = palL(hue + 0.5 + 0.18 * F.leadPitch, 1.0);
  let front = 0.04 + la * 2.2;
  let ringL = exp(-pow((pu - front) / (0.05 + 0.08 * la), 2.0)) * exp(-la * 2.2) * step(la, 1.2) * smoothstep(0.0, 0.1, la) * ll;
  let frontP = 0.04 + lap * 2.2;
  let ringP = exp(-pow((pu - frontP) / (0.05 + 0.08 * lap), 2.0)) * exp(-lap * 2.2) * step(lap, 1.2) * smoothstep(0.0, 0.1, lap) * llp;
  c += lc * (ringL + ringP) * (0.25 + 0.75 * ridge) * 1.1 * eg;
  let nE = ll * smoothstep(0.0, 0.1, la) * exp(-la / 0.3);
  c += lc * exp(-pu * 6.0) * (0.2 * F.leadHeld + 0.5 * nE) * (0.3 + 0.7 * ridge) * eg;
  // Kick: a contraction wave runs inward along the fibres from the limbus to the pupil.
  let ka = floor(S.p[7].w) / 1000.0;
  let kl = fract(S.p[7].w) / 0.98;
  let kf = 1.0 - ka * 3.2;
  // Its light goes with the hit's strength and rises over about 0.06 s.
  let kw = exp(-pow((pu - kf) / 0.12, 2.0)) * exp(-ka * 3.0) * step(ka, 0.4) * smoothstep(0.0, 0.06, ka) * kl;
  c += palL(hue + 0.6, 1.0) * kw * (0.3 + 0.7 * ridge) * 4.0 * eg;
  return c * lv;
}

fn ie_sclera(p: vec3f, n: vec3f, rd: vec3f, seed: f32, lv: f32) -> vec3f {
  let hue = ie_hue() + seed * 0.37;
  let r = length(p.xy);
  var alb = mix(vec3f(0.34, 0.32, 0.3), palL(hue + 0.08, 0.32), 0.22);
  let nz = noise3(p * 5.0 + vec3f(seed * 7.0));
  let nz2 = noise3(p * 11.0 + vec3f(3.0 + seed));
  let vein = smoothstep(0.06, 0.0, abs(nz)) * smoothstep(1.0, 1.3, r) * (0.6 + 0.4 * nz2);
  alb = mix(alb, palL(hue + 0.92, 0.07), vein * 0.8);
  alb *= 1.0 - 0.55 * smoothstep(1.25, 1.0, r);
  let L = ie_keyDir();
  let dif = sat(dot(n, L));
  let edge = sat(dot(n, -rd));
  var c = alb * (dif * 1.3 * S.p[5].x + palL(hue + 0.5, 0.12)) * (0.15 + 0.85 * pow(edge, 0.6));
  c += palL(hue + 0.9, 1.0) * vein * (0.05 + 0.6 * S.p[7].y) * S.p[5].y * 0.3;
  let refl = reflect(rd, n);
  c += ie_env(refl) * (0.04 + 0.5 * pow(1.0 - edge, 4.0));
  return c * lv;
}

fn ie_backdrop(ro: vec3f, rd: vec3f) -> vec3f {
  let hue = ie_hue();
  let t = (-2.5 - ro.z) / min(rd.z, -0.05);
  let p = ro + rd * max(t, 0.0);
  let r = length(p.xy);
  let th = atan2(p.y, p.x);
  let sty = S.p[1].z;
  var c = palL(hue + 0.6, 0.012) * exp(-r * 0.2);
  if (sty < 0.5) {
    // Lash rays fanning out from the eye, flickering with the hats.
    let nz = noise3(vec3f(th * 3.0, r * 0.2, F.warp * 0.05));
    let rays = pow(0.5 + 0.5 * cos(th * 48.0 + nz * 4.0), 16.0);
    c += palL(hue + 0.15 + nz * 0.1, 0.25) * rays * smoothstep(1.4, 2.2, r) * exp(-(r - 2.0) * 0.4) * (0.5 + 1.2 * F.hat + 0.5 * spec(fract(th / TAU + 0.5)));
  } else if (sty < 1.5) {
    // Concentric mandala rings pulsing outward on the beat.
    let w = r * 2.0 - F.beatPhase * 2.0;
    let rings = pow(0.5 + 0.5 * cos(w * TAU), 10.0);
    let petals = 0.5 + 0.5 * cos(th * S.p[6].y * 2.0 + floor(w) * 1.5);
    c += palL(hue + floor(w) * 0.13, 0.12) * rings * (0.4 + 0.6 * petals) * smoothstep(1.4, 2.0, r) * exp(-(r - 2.0) * 0.35) * (0.5 + 1.5 * S.p[7].z);
  } else {
    let f = fbmFast(vec3f(p.xy * 0.5, F.warp * 0.03), 4);
    c += palL(hue + 0.3 + f * 0.4, 0.12) * smoothstep(-0.1, 0.4, f) * smoothstep(1.3, 2.5, r);
  }
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro0 = S.p[3].xyz;
  let cam = lookAt(ro0, S.p[4].xyz, S.p[4].w);
  var rd = normalize(cam * vec3f(q, S.p[3].w));
  var ro = ro0;
  let lam = S.p[2].x;
  let D = S.p[2].y;
  let f = S.p[2].z;
  let base = S.p[2].w;
  let Z = pow(lam, -f);
  let focus = -D * (1.0 - pow(lam, f)) / (1.0 - lam);

  var col = vec3f(0.0);
  var thr = vec3f(1.0);
  var done = false;
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let lk = pow(lam, fk);
    let zk = -D * (1.0 - lk) / (1.0 - lam);
    let sc = lk * Z;
    let cen = vec3f(0.0, 0.0, (zk - focus) * Z);
    let seed = fract((base + fk) * 0.618) * 10.0;
    // Inner eyes emerge from the dark as the dive approaches them.
    let lv = sat(pow(0.12, max(fk - f, 0.0)));
    var lo = (ro - cen) / sc;
    var ld = rd;
    // Already dived past this eye: it is behind the camera.
    if (lo.z < -0.12 && length(lo.xy) < 1.0) { continue; }
    // Cornea: reflection, then refraction into the eye.
    let cc = vec3f(0.0, 0.0, -sqrt(IE_RC * IE_RC - 1.0));
    let inC = length(lo - cc) < IE_RC;
    if (!inC) {
      let hc = ie_sphere(lo, ld, cc, IE_RC);
      if (hc.x > 0.0) {
        let pc = lo + ld * hc.x;
        if (pc.z > 0.0) {
          let n = normalize(pc - cc);
          let fre = 0.03 + 0.97 * pow(1.0 - sat(dot(n, -ld)), 5.0);
          col += thr * ie_env(reflect(ld, n)) * fre * lv;
          thr *= 1.0 - fre;
          ld = refract(ld, n, 1.0 / 1.336);
          lo = pc;
        }
      }
    }
    let tr = ie_traceIris(lo, ld, seed);
    if (tr.y > 0.5) {
      let p = lo + ld * tr.x;
      let n = ie_irisNormal(p.xy, seed);
      col += thr * ie_irisColor(p.xy, seed, ie_h(p.xy, seed), n, ld, lv);
      done = true;
      break;
    }
    // Where did the ray cross the iris plane?
    var xr = 2.0;
    var px = vec2f(9.0);
    if (ld.z < -0.001) {
      let tz = -lo.z / ld.z;
      if (tz > 0.0) { px = (lo + ld * tz).xy; xr = length(px); }
    }
    if (ld.z < -0.001 && xr < 1.0 && ie_pupil(px) < 1.0) {
      // Through the pupil: continue to the next eye, inside the dark chamber.
      thr *= 0.92;
      ro = cen + lo * sc;
      rd = ld;
      continue;
    }
    // Sclera: an oblate eyeball (wider than deep) so the white shows around the iris.
    let rv = vec3f(2.2, 2.2, 1.2);
    let ec = vec3f(0.0, 0.0, -1.2 * sqrt(1.0 - 1.0 / (2.2 * 2.2)));
    let eo = (lo - ec) / rv;
    let edv = ld / rv;
    let ea = dot(edv, edv);
    let eb = dot(eo, edv);
    let ecc = dot(eo, eo) - 1.0;
    let eh = eb * eb - ea * ecc;
    if (ecc > 0.0 && eh > 0.0) {
      let te = (-eb - sqrt(eh)) / ea;
      if (te > 0.0) {
        let ps = lo + ld * te;
        if (ps.z <= 0.02) {
          let n = normalize((ps - ec) / (rv * rv));
          col += thr * ie_sclera(ps, n, ld, seed, lv);
          done = true;
          break;
        }
      }
    }
    if (k == 0) {
      col += thr * ie_backdrop(lo, ld);
    } else {
      col += thr * palL(ie_hue() + 0.6, 0.01) * lv;
    }
    done = true;
    break;
  }
  if (!done) { col += thr * palL(ie_hue() + 0.6, 0.008); }
  return vec4f(col, 1.0);
}
`,
});
