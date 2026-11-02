import type { MusicState } from '../../audio/musicState';
import { Spring } from '../anim';
import { Morph } from '../morph';
import { particleScene } from '../particleScene';
import type { SceneUpdateContext } from '../types';

const pick = (g: number, n: number) => Math.min(n - 1, Math.floor(g * n));
const ATTRACTORS = 10;
const SYM = [1, 2, 3, 5] as const;

/** Beats per second scaled by loudness: drives every free motion, so it rests in silence. */
const musicRate = (m: MusicState) => (m.bpm / 60) * Math.min(1, 1.6 * m.energySlow) * (0.35 + 0.65 * ev.energy + 0.6 * ev.kick);
const chordHue = (m: MusicState, cur: number) => (m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : cur);

/** Music clocks (camera turn, attractor blend) and the eased chord hue, advanced once per frame in camera(). */
const st = { clock: 0, ch: 0, lastTime: -1 };
/** Only its event ages and levels are used: every reaction scales with how hard the hit was. */
const morph = new Morph(1);
/**
 * Eased event envelopes: each follows its hit's level (fading with age) on a critically damped
 * spring, so it swells in over ~0.15 s, never lands in one frame, and a new hit never dips the last.
 */
const ev = { kick: 0, snare: 0, flux: 0, energy: 0, drop: 0 };
const evSpring = { kick: new Spring(0, 0.06), snare: new Spring(0, 0.06), flux: new Spring(0, 0.1), energy: new Spring(0, 0.12), drop: new Spring(0, 0.08) };
/**
 * Melody planes: the latest note's plane sits at its pitch and swells in; the previous note's plane
 * stays at its own pitch and fades out on its own, so a new note never moves or cuts a lit band.
 */
const planes = { n: -1, cur: new Spring(0, 0.09), prev: new Spring(0, 0.06), pitch: 0, prevPitch: 0, prevLvl: 0, prevAge: 9, glide: new Spring(0, 0.05) };

function advance(ctx: SceneUpdateContext) {
  const m = ctx.music;
  const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
  if (Math.abs(m.time - st.lastTime) > 0.5) {
    st.clock = m.time * 0.8;
    st.ch = chordHue(m, st.ch);
    planes.pitch = planes.prevPitch = m.leadPitch;
    planes.glide.reset(m.leadPitch);
    evSpring.energy.reset(m.energy);
  }
  st.lastTime = m.time;
  morph.update(m, ctx.dt, ctx.dna);
  ev.kick = evSpring.kick.update(morph.kickLevel * Math.exp(-morph.kickAge / 0.22), dt);
  ev.snare = evSpring.snare.update(morph.snareLevel * Math.exp(-morph.snareAge / 0.3), dt);
  // Onset flux stirs the turbulence: eased and scaled by presence, so a faint note barely stirs it.
  ev.flux = evSpring.flux.update(m.flux * morph.presence, dt);
  // Loudness paces the camera turn and the blend: eased, so an onset never jolts the whole view.
  ev.energy = evSpring.energy.update(m.energy, dt);
  // A drop lands over a few frames, not in one.
  ev.drop = evSpring.drop.update(m.dropPulse, dt);
  if (morph.notes !== planes.n) {
    if (planes.n >= 0 && morph.notes > planes.n) {
      planes.prev.x = planes.cur.x;
      planes.prev.v = planes.cur.v;
      planes.prevPitch = planes.pitch;
      planes.prevLvl = planes.cur.x;
      planes.prevAge = 0;
      planes.cur.reset(0);
    }
    planes.n = morph.notes;
  }
  // The pitch can settle a frame or two after the onset: the latest plane glides onto it.
  planes.pitch = planes.glide.update(m.leadPitch, dt);
  planes.prevAge += dt;
  // The latest plane: the note's level (fading) plus the held line, scaled by presence.
  planes.cur.update(2.0 * morph.noteLevel * Math.exp(-morph.leadAge / 0.45) + 0.3 * m.leadHeld * morph.presence, dt);
  planes.prev.update(planes.prevLvl * Math.exp(-planes.prevAge / 0.3), dt);
  st.clock += dt * musicRate(m);
  let d = chordHue(m, st.ch) - st.ch;
  d -= Math.round(d);
  st.ch += d * (1 - Math.exp(-dt / 0.45));
}

/** Cue structure decoded from the DNA (all of it is fixed for the cue). */
function genes(ctx: SceneUpdateContext) {
  const g = ctx.dna;
  const a = pick(g[0], ATTRACTORS);
  const b = (a + 1 + pick((g[0] * 37) % 1, ATTRACTORS - 1)) % ATTRACTORS;
  return {
    a,
    b,
    rig: pick(g[1], 5),
    spawn: pick(g[2], 5),
    shade: pick(g[3], 4),
    zoom: pick(g[4], 4),
    grammar: pick(g[5], 4),
    bg: pick(g[6], 3),
    hue: (g[6] * 7.3) % 1,
    sym: pick(g[7], 4),
  };
}

/**
 * A million particles riding strange-attractor flow fields, seen from inside the swarm.
 * Each cue blends two of ten attractors and decodes its DNA into: 0 attractor pair, 1
 * camera rig (orbit through the halo, inside fly-through, looking up from the core, low
 * skim, telephoto crop), 2 spawn shape (ball, ring, disc, axis, shell), 3 shading
 * (spectrum bands, speed dust, height beads, sparks), 4 zoom and turbulence scale, 5 beat
 * grammar (shove, implode, surge, swirl), 6 backdrop and hue, 7 rotational symmetry
 * (1, 2, 3 or 5 copies arranged in a rosette).
 *
 * Music: the melody is a plane of light cutting through the swarm at the height of the
 * lead pitch; every note lights the particles crossing it. Kicks shove the flow (per the
 * beat grammar), snares burst a shell of light outward from the core, chord changes ease
 * the hue. The flow speed, attractor morph and camera turn all advance with tempo and
 * energy and rest in silence; every particle listens to one spectrum band.
 */
export default particleScene({
  meta: {
    id: 'attractor-swarm',
    name: 'Attractor Swarm',
    // Dropped from auto-direction: however close the camera gets, a strange attractor is a thin
    // ribbon of light in a black void, not a place to be inside. Still pinnable by hand.
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: 0.5, arousal: 0.65 },
    genres: { dnb: 1, dubstep: 0.9, edm: 0.8, hiphop: 0.7, techno: 0.6, jazz: 0.4, classical: 0.4 },
    trails: 0.6,
    sparse: true,
  },
  count: 1 << 20,
  camera(ctx) {
    advance(ctx);
    const m = ctx.music;
    const G = genes(ctx);
    const v = ctx.dna[1];
    const ext = SYM[G.sym] > 1 ? 1.45 : 1;
    const breathe = 1 + 0.12 * m.anticipation - 0.06 * ev.drop;
    const c = st.clock;
    const a = c * 0.05 + v * 6.28;
    switch (G.rig) {
      case 1: {
        // Inside the swarm: ride a loop through the cloud, looking along the tangent.
        const r = 1.0 * ext;
        const b = c * 0.035 + v * 6.28;
        const eye: [number, number, number] = [Math.cos(b) * r, 0.25 * Math.sin(b * 1.7), Math.sin(b) * r];
        const target: [number, number, number] = [Math.cos(b + 0.7) * r * 0.6, 0.1 * Math.sin(b * 1.7 + 1), Math.sin(b + 0.7) * r * 0.6];
        return { eye, target, fovY: 1.25 * breathe, roll: Math.sin(c * 0.03) * 0.3 };
      }
      case 2: {
        // From just below the core, looking up into the swarm.
        const h = -0.35 * ext;
        return { eye: [Math.cos(a) * 0.25 * ext, h, Math.sin(a) * 0.25 * ext], target: [0, 1.2 * ext, 0], fovY: 1.35 * breathe, roll: a * 0.5 };
      }
      case 3: {
        // Low skim through the lower halo.
        const r = 1.55 * ext * breathe;
        return { eye: [Math.cos(a * 0.8) * r, -0.45 * ext, Math.sin(a * 0.8) * r], target: [0, 0.2 * ext, 0], fovY: 1.3, roll: 0 };
      }
      case 4: {
        // Telephoto crop: the swarm overfills the lens.
        const r = 5.0 * ext * breathe;
        const h = Math.sin(c * 0.025 + v * 3) * 1.2;
        return { eye: [Math.cos(a * 0.7) * r, h, Math.sin(a * 0.7) * r], target: [0, 0, 0], fovY: 0.36, roll: Math.sin(c * 0.02) * 0.12 };
      }
      default: {
        // Orbit through the halo, close enough that the swarm fills the frame.
        const r = (1.75 - 0.2 * m.energySlow + 0.25 * m.anticipation - 0.15 * ev.drop) * ext;
        const h = Math.sin(c * 0.03 + v * 3) * 0.6;
        return { eye: [Math.cos(a) * r, h, Math.sin(a) * r], target: [0, 0, 0], fovY: 1.2, roll: Math.sin(c * 0.025) * 0.2 };
      }
    }
  },
  streak: (ctx) => {
    // Trails lengthen with loudness, eased so an onset never stretches them in one frame.
    const e = ev.energy;
    switch (genes(ctx).shade) {
      case 1: return 0.07 + 0.09 * e;
      case 2: return 0.012 + 0.015 * e;
      case 3: return 0.05 + 0.06 * e;
      default: return 0.035 + 0.05 * e;
    }
  },
  params(ctx, p) {
    const m = ctx.music;
    const G = genes(ctx);
    const act = Math.min(1, 1.6 * m.energySlow);
    const surge = G.grammar === 2 ? 1 + 1.6 * ev.kick * ev.kick : 1;
    p[24] = (0.08 + (0.5 + 1.1 * m.energySlow) * act + 0.6 * ev.drop) * Math.sqrt(m.bpm / 120) * surge;
    // Attractor pair (8 bits) + the previous plane's pitch (8 bits) + the latest plane's light (fraction).
    const p01 = (x: number) => Math.max(0, Math.min(1, x * 0.5 + 0.5));
    p[25] = G.a + 16 * G.b + 256 * Math.round(p01(planes.prevPitch) * 255) + Math.min(0.99, Math.max(0, planes.cur.x) / 3.4);
    p[26] = G.hue + ctx.evolve[3] * 0.3 + 0.25 * st.ch;
    // Blend weight between the two attractors morphs with the music clock and the evolve gene.
    // Blend weight (10 bits) + the previous plane's light (6 bits) + the latest plane's pitch (fraction).
    const blend = 0.5 + 0.5 * Math.sin(st.clock * 0.06 + ctx.dna[0] * 10 + ctx.evolve[0] * 4);
    const prevLight = Math.round(Math.max(0, Math.min(1, planes.prev.x / 3.4)) * 63);
    p[27] = Math.round(blend * 1023) + 1024 * prevLight + p01(planes.pitch) * 0.99;
    p[28] = (0.1 + 0.9 * ev.flux * act + 1.2 * m.anticipation) * (0.6 + 0.3 * G.zoom);
    const kickShove = G.grammar === 3 ? 1.6 * ev.kick + 0.5 * ev.snare : G.grammar === 2 ? 0.3 * ev.kick : 1.2 * ev.kick;
    p[29] = kickShove;
    // Drop push (8 bits) + how far the snare shell has spread (8 bits, from the hit's age) + the
    // eased kick light (fraction).
    const shell = 1 - Math.exp(-Math.min(morph.snareAge, 3) / 0.3);
    p[30] = Math.round(ev.drop * 255) + 256 * Math.round(shell * 255) + Math.min(0.99, ev.kick);
    // Genes + the eased snare shell (fraction).
    p[31] = G.spawn + (G.sym << 3) + (G.grammar << 6) + (G.shade << 9) + (G.zoom << 12) + (G.bg << 15) + Math.min(0.98, ev.snare);
  },
  wgsl: /* wgsl */ `
fn attractor(k: i32, q: vec3f) -> vec3f {
  switch k {
    case 0: { // Lorenz
      return vec3f(10.0 * (q.y - q.x), q.x * (28.0 - q.z) - q.y, q.x * q.y - 2.6667 * q.z) * 0.012;
    }
    case 1: { // Aizawa
      let x = q.x; let y = q.y; let z = q.z;
      return vec3f((z - 0.7) * x - 3.5 * y, 3.5 * x + (z - 0.7) * y,
        0.6 + 0.95 * z - z * z * z / 3.0 - (x * x + y * y) * (1.0 + 0.25 * z) + 0.1 * z * x * x * x) * 0.35;
    }
    case 2: { // Thomas
      let b = 0.208186;
      return vec3f(sin(q.y) - b * q.x, sin(q.z) - b * q.y, sin(q.x) - b * q.z) * 1.1;
    }
    case 3: { // Halvorsen
      let a = 1.89;
      return vec3f(-a * q.x - 4.0 * q.y - 4.0 * q.z - q.y * q.y, -a * q.y - 4.0 * q.z - 4.0 * q.x - q.z * q.z,
        -a * q.z - 4.0 * q.x - 4.0 * q.y - q.x * q.x) * 0.1;
    }
    case 4: { // Dadras
      return vec3f(q.y - 3.0 * q.x + 2.7 * q.y * q.z, 1.7 * q.y - q.x * q.z + q.z, 2.0 * q.x * q.y - 9.0 * q.z) * 0.05;
    }
    case 5: { // Rossler
      return vec3f(-q.y - q.z, q.x + 0.2 * q.y, 0.2 + q.z * (q.x - 5.7)) * 0.12;
    }
    case 6: { // Chen
      return vec3f(35.0 * (q.y - q.x), -7.0 * q.x - q.x * q.z + 28.0 * q.y, q.x * q.y - 3.0 * q.z) * 0.009;
    }
    case 7: { // Arneodo
      return vec3f(q.y, q.z, 5.5 * q.x - 3.5 * q.y - q.z - q.x * q.x * q.x) * 0.09;
    }
    case 8: { // Nose-Hoover
      return vec3f(q.y, -q.x + q.y * q.z, 1.5 - q.y * q.y) * 0.22;
    }
    default: { // Rucklidge
      return vec3f(-2.0 * q.x + 6.7 * q.y - q.y * q.z, q.x, -q.z + q.y * q.y) * 0.05;
    }
  }
}
// World <-> attractor space: (center, scale) per attractor.
fn attrCenter(k: i32) -> vec4f {
  switch k {
    case 0: { return vec4f(0.0, 0.0, 25.0, 22.0); }
    case 1: { return vec4f(0.0, 0.0, 0.6, 1.3); }
    case 2: { return vec4f(0.0, 0.0, 0.0, 3.2); }
    case 3: { return vec4f(-2.0, -2.0, -2.0, 7.0); }
    case 4: { return vec4f(0.0, 0.0, 0.0, 9.0); }
    case 5: { return vec4f(0.0, 0.0, 3.0, 11.0); }
    case 6: { return vec4f(0.0, 0.0, 22.0, 20.0); }
    case 7: { return vec4f(0.0, 0.0, 0.0, 4.5); }
    case 8: { return vec4f(0.0, 0.0, 0.0, 2.6); }
    default: { return vec4f(0.0, 0.0, 8.0, 8.0); }
  }
}
fn sw_upright(k: i32) -> bool { return k == 0 || k == 6 || k == 9; }
fn fieldOf(k: i32, p: vec3f) -> vec3f {
  let c = attrCenter(k);
  // Lorenz-like systems lie on their side in native coords; stand them up.
  var w = p;
  if (sw_upright(k)) { w = vec3f(p.x, p.z, p.y); }
  let q = w * c.w + c.xyz;
  var v = attractor(k, q) / c.w * 6.0;
  if (sw_upright(k)) { v = vec3f(v.x, v.z, v.y); }
  return v;
}
fn field(p: vec3f) -> vec3f {
  let ab = i32(fmod(floor(S.p[6].y), 256.0));
  let a = ab % 16;
  let b = ab / 16;
  let w = smoothstep(0.0, 1.0, fmod(floor(S.p[6].w), 1024.0) / 1023.0);
  var v = mix(fieldOf(a, p), fieldOf(b, p), w);
  // Soft containment so morphs never fling particles to infinity.
  let r = length(p);
  v -= p * smoothstep(1.6, 3.0, r) * 2.0;
  let sp = length(v);
  return v * min(1.0, 6.0 / max(sp, 1e-4));
}

fn sw_bits(shift: u32) -> u32 { return (u32(floor(S.p[7].w)) >> shift) & 7u; }
fn sw_drop() -> f32 { return fmod(floor(S.p[7].z), 256.0) / 255.0; }
fn sw_shell() -> f32 { return floor(floor(S.p[7].z) / 256.0) / 255.0; }
fn sw_kick() -> f32 { return fract(S.p[7].z) / 0.99; }
fn sw_snare() -> f32 { return fract(S.p[7].w) / 0.98; }
// Melody planes: (latest, previous) light and pitch.
fn sw_planes() -> vec2f { return vec2f(fract(S.p[6].y) / 0.99, floor(S.p[6].w / 1024.0) / 63.0) * 3.4; }
fn sw_pitches() -> vec2f { return vec2f(fract(S.p[6].w) / 0.99, floor(S.p[6].y / 256.0) / 255.0) * 2.0 - 1.0; }
fn sw_symN() -> u32 {
  let s = sw_bits(3u);
  return select(select(select(5u, 3u, s == 2u), 2u, s == 1u), 1u, s == 0u);
}
/** Local attractor-space scale and rosette radius for this cue. */
fn sw_frame() -> vec2f {
  let n = sw_symN();
  let zoom = 0.8 + 0.13 * f32(sw_bits(12u));
  return select(vec2f(0.62 * zoom, 1.45), vec2f(zoom, 0.0), n == 1u);
}

fn sw_spawn(seed: u32) -> vec3f {
  let h = hashU3(seed);
  let u = hashU(seed + 7u);
  let ang = h.x * TAU;
  switch sw_bits(0u) {
    case 1u: { // ring
      let r = 1.25 + 0.08 * (h.y - 0.5);
      return vec3f(cos(ang) * r, (h.z - 0.5) * 0.08, sin(ang) * r);
    }
    case 2u: { // disc
      let r = sqrt(u) * 1.5;
      return vec3f(cos(ang) * r, (h.z - 0.5) * 0.04, sin(ang) * r);
    }
    case 3u: { // axis
      return vec3f((h.y - 0.5) * 0.06, (u - 0.5) * 3.0, (h.z - 0.5) * 0.06);
    }
    case 4u: { // shell
      return normalize(h * 2.0 - 1.0 + vec3f(1e-3)) * 1.55;
    }
    default: { // ball
      return normalize(h * 2.0 - 1.0 + vec3f(1e-3)) * pow(u, 0.33) * 1.2;
    }
  }
}

fn simulate(idx: u32, p: ptr<function, Particle>) {
  let dt = min(F.dt, 1.0 / 30.0);
  let n = sw_symN();
  let fr = sw_frame();
  let ang = f32(idx % n) / f32(n) * TAU;
  let toW = rotY(ang);
  let toL = rotY(-ang);
  let off = vec3f(fr.y, 0.0, 0.0);
  var life = (*p).pos.w;
  var pos = (toL * (*p).pos.xyz - off) / fr.x;
  if (life <= 0.0) {
    let seed = pcg(idx ^ pcg(u32(F.frame)));
    pos = sw_spawn(seed);
    life = 0.5 + hashU(seed + 13u) * 4.0;
    (*p).vel = vec4f(0.0, 0.0, 0.0, hashU(idx * 3u + 1u));
  }
  let speed = S.p[6].x;
  let v1 = field(pos);
  let v2 = field(pos + v1 * dt * speed * 0.5);
  var np = pos + v2 * dt * speed;
  let tz = 1.0 + 0.25 * f32(sw_bits(12u));
  np += curl3(pos * 1.3 * tz + vec3f(0.0, F.warp * 0.4, 0.0)) * dt * S.p[7].x * 0.35;
  let rad = normalize(pos + vec3f(1e-4));
  let jit = 0.6 + hashU(idx) * 0.8;
  let gram = sw_bits(6u);
  let shove = S.p[7].y;
  if (gram == 1u) {
    np -= rad * dt * shove * jit * min(length(pos), 1.0);
  } else if (gram == 3u) {
    np += cross(vec3f(0.0, 1.0, 0.0), pos) * dt * shove * jit;
  } else {
    np += rad * dt * shove * jit;
  }
  let drop = sw_drop();
  np += rad * dt * 3.0 * drop * drop * jit;
  life -= dt * (0.25 + drop * 2.0 * hashU(idx * 5u + 3u));
  let wOld = toW * (pos * fr.x + off);
  let wNew = toW * (np * fr.x + off);
  (*p).vel = vec4f((wNew - wOld) / max(dt, 1e-4), (*p).vel.w);
  (*p).pos = vec4f(wNew, life);
}

fn shade(p: Particle, idx: u32) -> Shade {
  let band = p.vel.w;
  let sp = length(p.vel.xyz);
  let lvl = spec(band);
  var s: Shade;
  let fade = smoothstep(0.0, 0.3, p.pos.w);
  let gain = fade * (0.9 + 0.6 * F.intensity);
  let shift = S.p[6].z;
  switch sw_bits(9u) {
    case 1u: { // speed dust
      let k = sat(sp * 0.35);
      s.color = palL(shift + k * 0.5 + F.morph.x * 0.3, 0.55) * (0.012 + 0.08 * k * k + 0.06 * lvl * lvl + 0.02 * sw_kick()) * gain;
      s.size = 0.0024 + 0.002 * lvl;
    }
    case 2u: { // height beads
      let y = p.pos.y * 0.3 + 0.5;
      s.color = palRampL(0.25 + 0.6 * sat(y), 0.55) * (0.008 + 0.05 * lvl * lvl + 0.02 * sw_kick()) * gain;
      s.size = 0.0055 + 0.004 * lvl;
    }
    case 3u: { // sparks
      let hot = step(hashU(idx * 7u + 11u), 0.08);
      s.color = palL(band * 0.4 + shift + 0.5, 0.55) * mix(0.004, 0.16 + 0.4 * lvl, hot) * (1.0 + 0.6 * sw_kick()) * gain;
      s.size = mix(0.002, 0.0065 + 0.004 * lvl, hot);
    }
    default: { // spectrum bands
      let hue = band * 0.65 + sp * 0.04 + F.morph.x * 0.5 + shift;
      s.color = palL(hue, 0.55) * (0.012 + 0.09 * lvl * lvl + 0.03 * sw_kick()) * gain;
      s.size = 0.0035 + 0.004 * lvl;
    }
  }
  let ext = select(1.0, 1.45, sw_symN() > 1u);
  // Melody: a plane of light at the height of the lead pitch; each note lights the particles crossing it.
  let pitches = sw_pitches();
  let pitch = pitches.x;
  let lq = (vec2f(p.pos.y) - pitches * 0.85 * ext) / (0.08 * ext);
  let lplane = dot(exp(-lq * lq), sw_planes());
  // Snare: a shell of light bursting outward from the core as the hit decays.
  let sn = sat(sw_snare() * 1.2);
  let rs = (0.25 + 1.5 * sw_shell()) * ext;
  let sq = (length(p.pos.xyz) - rs) / (0.13 * ext);
  // It fades in as it leaves the core, so a new hit never lights the dense core in one frame.
  let shell = exp(-sq * sq) * sn * 3.0 * smoothstep(0.0, 0.3, sw_shell());
  let accent = palL(shift + 0.5 + 0.15 * pitch, 0.6);
  s.color = s.color * (1.0 + 4.0 * lplane + shell) + accent * lplane * 0.025 * gain;
  // Inside the swarm, fade the few particles that brush the lens instead of letting them blot the frame.
  s.color *= smoothstep(0.03, 0.3, length(p.pos.xyz - S.p[4].xyz));
  // The template sizes particles for a ~0.9 rad lens; keep their screen size under telephoto rigs.
  s.size *= 0.483 / max(S.p[4].w, 0.05);
  return s;
}

fn background(uv: vec2f, rd: vec3f) -> vec3f {
  let shift = S.p[6].z;
  let vig = 1.0 - length(uv - 0.5);
  let mode = sw_bits(15u);
  var c = palL(shift + 0.1, 0.012) * (0.4 + 0.8 * vig);
  if (mode == 0u) {
    let n = fbm3(rd * 3.0 + vec3f(0.0, 0.0, F.warp * 0.05), 4);
    let neb = pow(sat(n * 0.9 + 0.35), 3.0);
    c += palL(n + 0.2 + shift, 0.02) * neb * (0.4 + F.energySlow);
  } else if (mode == 1u) {
    // A dim horizon band gives the swarm a ground to float over.
    let hz = exp(-abs(rd.y + 0.05) * 9.0);
    c += palL(shift + 0.6, 0.03) * hz * (0.5 + 0.5 * F.energySlow) + palL(shift + 0.3, 0.008) * sat(-rd.y * 3.0);
  }
  // Sparse, dim stars: the lighten feedback turns every bright point into a streak.
  let star = step(0.9992, hash13(floor(rd * 420.0)));
  c += vec3f(star) * select(0.25, 0.4, mode == 2u) * (0.5 + 0.5 * F.high);
  return c;
}
`,
});
