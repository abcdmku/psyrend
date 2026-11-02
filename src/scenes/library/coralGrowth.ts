import { raymarchScene } from '../raymarchScene';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Drift through a bioluminescent seabed. Bass breathes the growth, mids sway it, every
 * tip glows with its own spectrum band, chords shift the bioluminescent hue. Caustics
 * dance on every surface, light shafts and plankton hang in palette-tinted water.
 * Anticipation contracts and dims the growth while the tips gather light; the drop
 * blooms it outward behind a ring of light.
 *
 * DNA picks the biome (coral reef of folded-IFS branches and anemones, a towering kelp
 * forest, abyssal hydrothermal vents with glowing plumes and tube-worm clusters, or a
 * dense anemone meadow), the coral growth style, the camera rig (glide, high drift
 * looking down, low gaze up toward the surface, slow orbit), density and scale, the
 * light (sunlit shallows, twilight, midnight bioluminescence), the beat grammar
 * (breathing, kick rings rolling across the floor, hat sparkle cascades), hue and the
 * seabed cover.
 *
 * Events come from the shared morph: every reaction (kick rings and glow, the snare's crown flush,
 * the melody's band, hat sparkles) scales with its event's level (which includes how loud the
 * passage is) and rises over about 0.1 s; the melody band's height glides with the pitch and the
 * drop's light eases in as a surge. A faint intro motif only lights a dim band on the growth.
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
const fx = { lead: new Flare(0.12, 0.22), kick: new Flare(0.15, 0.33), snare: new Flare(0.15, 0.2) };
/** Held melody strength, its pitch and the hats, glided so none of them jumps in a frame. */
const held = new Spring(0, 0.1);
const pitch = new Spring(0, 0.3);
const hat = new Spring(0, 0.06);
// Music clocks (module state, reset on seeks): travel and water flow advance with the beat and
// energy and rest in silence; kick rings and the chord bloom are tracked here too.
const st = { z: 0, flow: 0, lastTime: -1, hue: 0, bloom: 0 };

export default raymarchScene({
  meta: {
    id: 'coral-growth',
    name: 'Coral Bloom',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.1, 0.7],
    mood: { valence: 0.6, arousal: 0.35 },
    genres: { acoustic: 1, jazz: 0.8, lofi: 0.8, ambient: 0.7, classical: 0.6, pop: 0.4 },
    trails: 0.35,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    const chordHue = m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : st.hue;
    if (Math.abs(m.time - st.lastTime) > 0.5) {
      st.z = m.time * 0.4;
      st.flow = m.time * 0.5;
      held.reset(0);
      pitch.reset(m.leadPitch);
      hat.reset(0);
      st.hue = chordHue;
      st.bloom = 0;
    }
    st.lastTime = m.time;
    const act = Math.min(1, 1.6 * m.energySlow);
    // Events, by level and eased in; the drop as the morph's surge (it swells in).
    const kickEnv = fx.kick.update(morph.kicks, morph.kickAge, morph.kickLevel);
    const snareEnv = fx.snare.update(morph.snares, morph.snareAge, morph.snareLevel);
    const noteEnv = fx.lead.update(morph.notes, morph.leadAge, morph.noteLevel);
    const heldL = held.update(m.leadHeld * morph.presence ** 2, dt);
    const pitchL = pitch.update(Math.max(-1, Math.min(1, m.leadPitch)), dt);
    const hatL = hat.update(m.hat * morph.presence, dt);
    const drop = morph.surge;
    st.z += dt * (m.bpm / 60) * act * (0.35 + 0.6 * m.energy + 0.5 * kickEnv + 0.8 * drop) * 0.22 * (1 - 0.5 * m.anticipation);
    st.flow += dt * act * (0.35 + 0.8 * m.mid + 0.5 * m.energy);
    // Harmony eases: the chord root drifts the bioluminescent hue, a change blooms the water.
    const dh = ((chordHue - st.hue + 1.5) % 1) - 0.5;
    st.hue += dh * (1 - Math.exp(-dt / 0.6));
    st.bloom += (m.chordPulse - st.bloom) * (1 - Math.exp(-dt / 0.25));
    const sw = st.flow;
    const biome = Math.floor(g[0] * 4); // 0 reef, 1 kelp, 2 vents, 3 anemone meadow
    // Growth style: 0 bushy four-way, 1 sea fan, 2 tall spiral.
    const style = Math.floor(g[1] * 3) % 3;
    const rig = Math.floor(g[2] * 4); // 0 glide, 1 high drift, 2 gaze up, 3 orbit
    let light = Math.floor(g[4] * 3); // 0 sunlit, 1 twilight, 2 midnight
    if (biome === 2) light = g[4] < 0.5 ? 1 : 2;
    if (biome === 1) light = g[4] < 0.6 ? 0 : 1; // kelp forests grow toward the sun
    const grammar = Math.floor(g[5] * 3); // 0 breathe, 1 kick rings, 2 hat sparkle
    const tilt = [0.6, 0.5, 0.42][style];
    const twist = [-0.785, 0.35, -0.3][style];
    const ratio = [0.72, 0.76, 0.75][style];
    const height = [1.6, 1.75, 1.95][style];
    const len0 = (height * (1 - ratio)) / (1 - Math.pow(ratio, 5));
    const breathe = 1 + (grammar === 0 ? 0.1 : 0.05) * m.bass + 0.08 * kickEnv + 0.03 * m.kickNext * morph.presence;
    const grow = breathe * (1 - 0.3 * m.anticipation) * (1 + 0.1 * drop) * (0.85 + 0.25 * ev[3]);
    const lightK = [1, 0.45, 0.14][light];
    const glowK = [1, 1.6, 2.4][light];
    p[0] = tilt + 0.06 * Math.sin(sw * 0.13 + g[1] * 7) + 0.05 * m.tension - 0.12 * m.anticipation;
    p[1] = twist + 0.1 * Math.sin(sw * 0.07);
    p[2] = ratio;
    p[3] = Math.min(grow, 1.15);
    p[4] = Math.min(2, (0.35 + 1.5 * m.mid + 0.5 * m.lowMid) * (0.6 + 0.8 * ev[0]) * (biome === 1 ? 1.4 : 1));
    p[5] = (0.8 + 0.5 * ctx.intensity) * (1 + 0.9 * m.anticipation) * (1 + 0.5 * st.bloom) * glowK;
    p[6] = ((1.1 + 0.35 * m.energySlow) * (1 - 0.5 * m.anticipation) + 0.5 * drop) * lightK;
    p[7] = g[6] + 0.12 * ev[1] + 0.2 * st.hue;
    p[8] = 1 + Math.min(morph.kickAge, 9) * 9;
    p[9] = hatL * (grammar === 2 ? 3 : 1);
    // The drop's ring: its radius runs out as the drop pulse decays; its light swells in over the
    // first few percent of that decay instead of switching on.
    p[10] = (1 - m.dropPulse) * 22;
    p[11] = m.dropPulse > 0.02 ? Math.sqrt(m.dropPulse) * Math.min(1, (1 - m.dropPulse) / 0.03) : 0;
    let camH = 0.95 + 0.2 * Math.sin(g[2] * 11) + 0.3 * (ev[2] - 0.5);
    if (rig === 1) camH += 2.2;
    if (rig === 2) camH = 0.75;
    p[12] = camH;
    p[13] = 1.6 + 1.2 * g[3];
    // The glided melody pitch (-1..1).
    p[14] = pitchL;
    p[15] = biome === 3 ? 1.01 : biome === 2 ? 0.4 : 0.15 + 0.3 * ((g[1] * 13.1) % 1);
    p[16] = (0.8 + 0.6 * m.high + 0.4 * m.energySlow) * [1, 0.5, 0][light] * (0.6 + 0.6 * g[7]);
    p[17] = (0.085 - 0.02 * m.energySlow) * (0.75 + 0.5 * g[3]) * (light === 2 ? 1.25 : 1);
    p[18] = (0.5 + 1.0 * m.high + 0.8 * drop) * (light === 2 ? 1.8 : 1) * (grammar === 2 ? 1 + 2 * hatL : 1);
    p[19] = len0;
    p[20] = Math.sin(st.z * 0.35 + g[2] * 4) * 0.08;
    p[21] = st.z;
    p[22] = st.flow;
    p[23] = Math.sin(st.z * 0.18 + g[2] * 9) * 1.0;
    p[24] = st.bloom;
    p[25] = rig === 1 ? 2.6 : rig === 2 ? -1.1 - (biome === 1 ? 2.2 : 0) : 0.25 + 0.12 * Math.sin(g[3] * 21);
    p[26] = 0.25 * g[7] + (biome === 0 ? 0.1 : biome === 3 ? 0 : biome === 2 ? -0.6 : -0.35);
    // Packed small integers: biome, rig, beat grammar, branching flag (style !== sea fan).
    p[27] = biome + 4 * rig + 16 * grammar + 64 * (style === 1 ? 0 : 1);
    p[28] = (biome === 3 ? 1.5 : biome === 1 ? 3.2 : 2.6) * (0.8 + 0.45 * g[3]);
    // The snare's flush, the kick's light, and the melody's light (the attack plus the held glow).
    p[29] = snareEnv;
    p[30] = kickEnv;
    p[31] = 3 * noteEnv + 0.1 * heldL;
  },
  wgsl: /* wgsl */ `
struct CgHit { d: f32, tip: f32, band: f32, mat: f32, y: f32 };

// Packed small integers in S.p[6].w: biome + 4 rig + 16 grammar + 64 branching flag.
fn cg_pk() -> f32 { return floor(S.p[6].w + 0.5); }
fn cg_biome() -> i32 { return i32(fmod(cg_pk(), 4.0)); }
fn cg_rig() -> i32 { return i32(fmod(floor(cg_pk() / 4.0), 4.0)); }
fn cg_grammar() -> i32 { return i32(fmod(floor(cg_pk() / 16.0), 4.0)); }
fn cg_branch() -> f32 { return floor(cg_pk() / 64.0); }

// Ray direction while marching (zero while probing normals/AO): growth is confined
// to its own cell, so the march may step straight to the next cell boundary.
var<private> cg_rd: vec3f;

fn cg_path(z: f32) -> f32 { return sin(z * 0.11) * S.p[3].y + sin(z * 0.047 + 1.3) * S.p[3].y * 0.6; }

// ALU value noise for the seabed height: the texture noise is hardware-filtered with
// 8-bit lerp weights, which terraces a large, low-frequency heightfield into tiles.
fn cg_vnoise(x: vec2f) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = hash12(i);
  let b = hash12(i + vec2f(1.0, 0.0));
  let c = hash12(i + vec2f(0.0, 1.0));
  let d = hash12(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}
// Seabed: broad mounds plus finer lumps; also anchors each cell's growth.
fn cg_ground2(xz: vec2f) -> f32 { return cg_vnoise(xz * 0.13) * 0.8 + noise4(vec3f(xz * 0.3, 4.2)).x * 0.2; }

// Folded-IFS branching coral: each level mirrors, twists, tilts and shrinks space.
fn cg_coral(q0: vec3f, hs: vec3f, sz: f32) -> CgHit {
  var p = q0 / sz;
  var sc = 1.0;
  var d = 1e9;
  var code = hs.x;
  let len0 = S.p[4].w;
  let ratio = S.p[0].z;
  let rt = rot2(S.p[0].x + (hs.y - 0.5) * 0.25);
  let rw = rot2(S.p[0].y + (hs.z - 0.5) * 0.6);
  // A third of the cells grow the other branching mode, so the reef mixes fans and bushes.
  let four = (cg_branch() > 0.5) != (hs.y > 0.68);
  for (var i = 0; i < 5; i++) {
    let ln = select(len0, len0 * 0.7, i == 0);
    let hy = clamp(p.y, 0.0, ln);
    let rr = 0.072 * (1.0 - 0.3 * hy / ln) + 0.016;
    let seg = (length(vec3f(p.x, p.y - hy, p.z)) - rr) / sc;
    d = smin(d, seg, 0.06 / sc);
    p.y -= ln;
    code = fract(code * 1.37 + step(p.x, 0.0) * 0.29 + step(p.z, 0.0) * 0.53);
    p.x = abs(p.x);
    if (four) { p.z = abs(p.z); }
    let a = rw * p.xz;
    p = vec3f(a.x, p.y, a.y);
    let b = rt * p.xy;
    p = vec3f(b.x, b.y, p.z);
    p = p / ratio;
    sc = sc / ratio;
  }
  let tipD = length(p) / sc;
  d = smin(d, tipD - 0.038, 0.02);
  var r: CgHit;
  r.d = d * sz;
  r.tip = tipD * sz;
  r.band = code;
  r.mat = 1.0;
  r.y = q0.y / (sz * 1.7);
  return r;
}

// Anemone: flared column with two polar-repeated rings of curling tentacles.
fn cg_anemone(q0: vec3f, hs: vec3f, sz: f32) -> CgHit {
  let p = q0 / sz;
  let r = length(p.xz);
  let colR = 0.2 + 0.1 * smoothstep(0.15, 0.5, p.y) + 0.012 * sin(p.y * 40.0);
  var d = max(r - colR, abs(p.y - 0.25) - 0.27) * 0.8;
  let n = 12.0 + floor(hs.x * 6.0);
  let sector = TAU / n;
  let ang = atan2(p.z, p.x) + hs.y * 3.0;
  var tip = 1e9;
  var band = 0.0;
  for (var ring = 0; ring < 2; ring++) {
    let fr = f32(ring);
    let a0 = ang + fr * sector * 0.5;
    let id = floor(a0 / sector + 0.5);
    let a = a0 - id * sector;
    let lp = vec3f(r * cos(a), p.y - 0.48, r * sin(a));
    let h = hash11(id * 1.31 + fr * 31.0 + hs.z * 17.0);
    let L = mix(1.0, 0.7, fr) * (0.8 + 0.35 * h);
    let s = clamp(lp.y / L, 0.0, 1.0);
    let ph = S.p[5].z * 1.3 + id * 0.9 + hs.z * 6.0 + fr * 2.0;
    let sw = S.p[1].x * 0.12 * s * s;
    let cx = mix(0.24, 0.12, fr) + mix(0.58, 0.28, fr) * s * sqrt(s) * L + sw * sin(ph);
    let cz = sw * cos(ph * 0.8);
    let rad = 0.042 * (1.0 - 0.5 * s);
    let td = (length(vec3f(lp.x - cx, lp.y - s * L, lp.z - cz)) - rad) * 0.7;
    let tp = length(vec3f(lp.x - cx, lp.y - L, lp.z - cz));
    d = smin(d, td, 0.05);
    if (tp < tip) { tip = tp; band = h; }
  }
  d = smin(d, tip - 0.045, 0.03);
  var res: CgHit;
  res.d = d * sz;
  res.tip = tip * sz;
  res.band = band;
  res.mat = 2.0;
  res.y = q0.y / (sz * 1.5);
  return res;
}

fn cg_kelpH(hs: vec3f) -> f32 { return 4.5 + 3.5 * hs.x; }

// Kelp: a swaying stipe with alternating blades and a glowing float at the crown.
fn cg_kelp(q0: vec3f, hs: vec3f) -> CgHit {
  let H = cg_kelpH(hs);
  let y = clamp(q0.y, 0.0, H);
  let u = y / H;
  let ph = S.p[5].z * 0.55 + hs.y * 6.28;
  let sw = (0.15 + 0.15 * S.p[1].x) * u * u;
  let off = vec2f(sin(ph + u * 2.5) * sw + 0.4 * u * (hs.z - 0.5), cos(ph * 0.8 + u * 2.0) * sw * 0.6);
  let lq = vec3f(q0.x - off.x, q0.y, q0.z - off.y);
  var d = length(vec2f(lq.x, lq.z)) - (0.06 - 0.02 * u);
  d = max(d, -q0.y);
  // Blades every 0.32 units, each one leaning out on a turning side.
  let sp = 0.42;
  let k = clamp(floor(q0.y / sp), 0.0, floor(H / sp) - 1.0);
  let ba = k * 2.4 + hs.z * 5.0 + 0.3 * sin(ph + k);
  let bq = rotY(ba) * vec3f(lq.x, q0.y - (k + 0.5) * sp, lq.z);
  let bl = vec3f(bq.x - 0.32, bq.y - bq.x * 0.45, bq.z);
  let blade = sdBox(bl, vec3f(0.3, 0.01, 0.1 * (1.0 - 0.6 * min(abs(bl.x) / 0.3, 1.0)))) - 0.008;
  d = min(d, blade);
  let fl = vec3f(lq.x, q0.y - H, lq.z);
  let tip = length(fl);
  d = min(d, tip - 0.07);
  var r: CgHit;
  r.d = d * 0.55;
  r.tip = tip;
  r.band = hs.y;
  r.mat = 4.0;
  r.y = u;
  return r;
}

fn cg_ventH(hs: vec3f, sz: f32) -> f32 { return (1.6 + 1.6 * hs.x) * sz; }

// Hydrothermal chimney: a lumpy tapering stack whose mouth feeds a glowing plume.
fn cg_vent(q0: vec3f, hs: vec3f, sz: f32) -> CgHit {
  let H = cg_ventH(hs, sz);
  let u = clamp(q0.y / H, 0.0, 1.0);
  let lump = noise3(q0 * 3.0 + hs * 9.0) * 0.06 + 0.04 * sin(q0.y * 9.0 + hs.y * 6.0);
  let rad = mix(0.42, 0.13, sqrt(u)) * sz + lump * sz;
  var d = (length(q0.xz) - rad) * 0.7;
  d = max(d, q0.y - H);
  // Mouth: hollow at the top.
  d = max(d, -(length(vec3f(q0.x, q0.y - H, q0.z)) - 0.09 * sz));
  // Plume: a column rising and widening above the mouth (glow only, no surface).
  let py = max(q0.y - H, 0.0);
  let drift = vec2f(sin(py * 0.9 - S.p[5].z * 0.7 + hs.z * 6.0), cos(py * 0.7 - S.p[5].z * 0.5)) * 0.08 * py;
  let plume = max(length(q0.xz - drift) - 0.04 * sz - 0.06 * py, 0.0) + max(H - q0.y, 0.0) + max(py - 3.0, 0.0) * 2.0;
  var r: CgHit;
  r.d = d;
  r.tip = plume * 0.6;
  r.band = hs.z;
  r.mat = 5.0;
  r.y = u;
  return r;
}

// Ray vs. vertical bounding cylinder: 0 if p is inside, entry distance if the ray
// reaches it ahead, 1e5 if it never does.
fn cg_rayCyl(p: vec3f, rd: vec3f, c: vec2f, r: f32, ylo: f32, yhi: f32) -> f32 {
  let o = p.xz - c;
  let a = dot(rd.xz, rd.xz);
  let b = dot(o, rd.xz);
  let k = dot(o, o) - r * r;
  var t0 = -1e5;
  var t1 = 1e5;
  if (a > 1e-8) {
    let disc = b * b - a * k;
    if (disc < 0.0) { return 1e5; }
    let sq = sqrt(disc);
    t0 = (-b - sq) / a;
    t1 = (-b + sq) / a;
  } else if (k > 0.0) { return 1e5; }
  var s0 = -1e5;
  var s1 = 1e5;
  if (abs(rd.y) > 1e-6) {
    let ta = (ylo - p.y) / rd.y;
    let tb = (yhi - p.y) / rd.y;
    s0 = min(ta, tb);
    s1 = max(ta, tb);
  } else if (p.y < ylo || p.y > yhi) { return 1e5; }
  let tin = max(max(t0, s0), 0.0);
  if (min(t1, s1) < tin) { return 1e5; }
  return tin;
}

// Returns a safe step (every term is pre-scaled to be Lipschitz-safe).
fn cg_map(p: vec3f) -> CgHit {
  var res: CgHit;
  let biome = cg_biome();
  let CELL = S.p[7].x;
  // One 4-channel texture sample drives ripple warp and sponge coverage.
  let n2 = noise4(vec3f(p.xz * 0.3, 4.2));
  let g = cg_vnoise(p.xz * 0.13) * 0.8 + n2.x * 0.2;
  let rip = sin(dot(p.xz, vec2f(2.3, 1.1)) + 2.5 * n2.z) * 0.015;
  res.d = (p.y - g - rip) * 0.9;
  res.tip = 1e9;
  res.band = 0.0;
  res.mat = 0.0;
  res.y = 0.0;
  // Fungal sponge lattice: gyroid walls that thin out toward the top of each mound.
  let ph = smoothstep(0.0, 0.7, (n2.y + 0.5 * n2.w) * 1.4 + S.p[6].z) * 0.65 * S.p[0].w * smoothstep(0.4, 1.6, abs(p.x - cg_path(p.z)));
  if (ph > 0.01) {
    let top = g + ph - 0.04;
    let gp = p * 10.0;
    let gy = dot(sin(gp), cos(gp.zxy));
    let lat = abs(gy) / (10.0 * 1.8) - (0.022 * sat((top - p.y) * 3.0) - 0.004);
    let crust = max(lat, p.y - top) * 0.8;
    if (crust < res.d) { res.d = crust; res.mat = 3.0; res.y = sat((p.y - g) / max(ph, 0.01)); }
  }
  let cell = floor(p.xz / CELL);
  let lc = p.xz - (cell + 0.5) * CELL;
  let hs = hash33(vec3f(cell, 11.0));
  let center = (cell + 0.5) * CELL + (hs.xy - 0.5) * 0.22 * CELL / 2.6;
  let anem = hs.z < S.p[3].w;
  var sz = 0.5 + 0.4 * hash12(cell * 1.7 + 3.1);
  if (biome == 3) { sz *= 0.62; }
  let off = abs(center.x - cg_path(center.y));
  let clear = smoothstep(0.6, 2.2, off);
  sz *= mix(0.3, 1.0, clear) * S.p[0].w;
  // Bound the growth by a cylinder padded for sway; its base sits within ~0.5 of the
  // local ground height because the seabed slopes gently.
  var rc = 1.12 * sz + 0.25;
  var topY = 0.6 + 2.0 * sz;
  let kelp = biome == 1 && clear > 0.3;
  let chimney = biome == 2 && anem;
  if (kelp) { rc = 1.3; topY = cg_kelpH(hs) + 0.4; }
  if (chimney) { rc = 0.55 * sz + 0.35; topY = cg_ventH(hs, sz) + 3.2; }
  let marching = cg_rd.x != 0.0 || cg_rd.z != 0.0;
  var grow = true;
  if (marching) {
    // Growth lives only in its own cell, so the ray can skip straight to the bound.
    let tIn = cg_rayCyl(p, cg_rd, center, rc, g - 0.95, g + topY);
    if (tIn > 0.0) { res.d = min(res.d, tIn + 0.004); grow = false; }
  } else {
    let bxz = max(length(p.xz - center) - rc, p.y - g - topY);
    if (bxz > 0.25) { res.d = min(res.d, bxz); grow = false; }
  }
  if (grow) {
    let base = cg_ground2(center) - 0.06;
    var q = vec3f(p.x - center.x, p.y - base, p.z - center.y);
    var c: CgHit;
    if (kelp) {
      c = cg_kelp(q, hs);
    } else if (chimney) {
      c = cg_vent(q, hs, sz);
    } else {
      // Mid-driven sway: lean grows with height.
      let hy = max(q.y, 0.0);
      let swayA = S.p[1].x * hy * hy * 0.025;
      q.x += swayA * sin(S.p[5].z * 0.8 + hs.x * 6.28 + hy * 0.6);
      q.z += swayA * cos(S.p[5].z * 0.67 + hs.y * 6.28);
      if (anem || biome == 2) {
        // Vent fields grow tube-worm clusters between the chimneys.
        c = cg_anemone(q, hs, sz * select(1.0, 0.7, biome == 2));
      } else if (biome == 1) {
        c = cg_anemone(q, hs, sz * 0.6);
      } else {
        c = cg_coral(q, hs, sz);
      }
    }
    let cd = c.d * 0.75;
    if (cd < res.d + 0.02) { res.mat = c.mat; res.y = c.y; }
    res.d = smin(res.d, cd, 0.1);
    res.tip = c.tip;
    res.band = fract(c.band + hs.x * 0.37);
  }
  // While marching, never step past the next cell boundary along the ray.
  if (marching) {
    let hc = CELL * 0.5;
    let tx = select(1e5, (sign(cg_rd.x) * hc - lc.x) / cg_rd.x, abs(cg_rd.x) > 1e-5);
    let tz = select(1e5, (sign(cg_rd.z) * hc - lc.y) / cg_rd.z, abs(cg_rd.z) > 1e-5);
    res.d = min(res.d, max(min(tx, tz), 0.0) + 0.012);
  }
  return res;
}

fn cg_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * cg_map(p + k.xyy * e).d + k.yyx * cg_map(p + k.yyx * e).d +
                   k.yxy * cg_map(p + k.yxy * e).d + k.xxx * cg_map(p + k.xxx * e).d);
}

fn cg_ao(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  var w = 1.0;
  for (var i = 1; i <= 2; i++) {
    let h = 0.08 + 0.18 * f32(i);
    occ += (h - cg_map(p + n * h).d) * w;
    w *= 0.6;
  }
  return sat(1.0 - occ * 1.6);
}

// Thickness probe: how quickly the field stays negative when stepping inward.
fn cg_thin(p: vec3f, n: vec3f) -> f32 {
  var s = 0.0;
  for (var i = 1; i <= 2; i++) {
    let k = 0.04 * f32(i * i);
    s += sat((k + cg_map(p - n * k).d) / k);
  }
  return s / 2.0;
}

fn cg_caustic(p: vec2f, time: f32) -> f32 {
  let q = vec2f(fmod(p.x * TAU, TAU), fmod(p.y * TAU, TAU)) - 250.0;
  var i = q;
  var c = 1.0;
  let inten = 0.005;
  for (var n = 0; n < 4; n++) {
    let tt = time * (1.0 - 3.5 / f32(n + 1));
    i = q + vec2f(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2f(q.x / (sin(i.x + tt) / inten), q.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}

fn cg_hue() -> f32 { return S.p[1].w + F.morph2.x * 0.35; }

fn cg_tipCol(band: f32) -> vec3f {
  let fb = 0.3 + 0.65 * band;
  let lvl = spec(fb);
  let sparkle = step(0.7, hash11(band * 91.7 + floor(S.p[5].z * 9.0))) * S.p[2].y;
  var c = pal(cg_hue() + band * 0.3);
  c = c / max(max(c.r, max(c.g, c.b)), 0.05) + vec3f(0.05, 0.12, 0.1);
  return c * (0.08 + 5.0 * lvl * lvl + 1.5 * sparkle) * S.p[1].y;
}

fn cg_water(rd: vec3f) -> vec3f {
  let tint = mix(F.pal1.rgb, F.pal2.rgb, 0.4);
  let deep = mix(F.pal0.rgb * 0.8, vec3f(0.0, 0.03, 0.045), 0.5);
  let shallow = mix(tint, vec3f(0.1, 0.45, 0.55), 0.55) * 0.4;
  let up = sat(rd.y * 0.7 + 0.5);
  var c = mix(deep, shallow, up * up) * S.p[1].z;
  // Snell's window: the bright, rippling surface overhead.
  let sw = smoothstep(0.55, 0.85, rd.y);
  if (sw > 0.0) {
    let rp = rd.xz / max(rd.y, 0.2) * 3.0;
    let rip = 0.6 + 0.4 * noise3fast(vec3f(rp, S.p[5].z * 0.4));
    c += mix(shallow, vec3f(0.6, 0.85, 0.9), 0.4) * sw * rip * 0.6 * S.p[1].z * S.p[1].z;
  }
  return c;
}

// Plankton: world-anchored z slices, one hashed mote per cell, lit by spectrum.
fn cg_plankton(ro: vec3f, rd: vec3f, tmax: f32) -> vec3f {
  var acc = vec3f(0.0);
  if (abs(rd.z) < 0.05) { return acc; }
  let sp = 0.8;
  let dir = sign(rd.z);
  let z0 = floor(ro.z / sp) * sp;
  for (var k = 1; k <= 9; k++) {
    let zk = z0 + dir * f32(k) * sp;
    let tk = (zk - ro.z) / rd.z;
    if (tk <= 0.0 || tk > tmax) { continue; }
    let pp = ro + rd * tk;
    let gs = 0.45;
    let cell = floor(pp.xy / gs);
    let h = hash33(vec3f(cell, zk * 3.17));
    if (h.z > 0.22) { continue; }
    let drift = vec2f(sin(S.p[5].z * 0.3 + h.x * 6.28), cos(S.p[5].z * 0.23 + h.y * 6.28)) * 0.08;
    let mp = (cell + 0.2 + 0.6 * h.xy) * gs + drift;
    let dd = length(pp.xy - mp);
    let size = 0.005 + 0.004 * h.y + 0.0012 * tk;
    let lvl = spec(0.3 + 0.65 * h.x);
    let fade = exp(-tk * 0.12) * smoothstep(0.3, 1.2, tk);
    acc += mix(pal(h.x * 0.6 + cg_hue() + F.morph2.y * 0.3), vec3f(0.5, 0.9, 1.0), 0.2) *
           exp(-dd * dd / (size * size)) * (0.3 + 3.0 * lvl * lvl + S.p[7].z * 0.8 + 0.667 * S.p[2].y * select(0.0, 1.0, cg_grammar() == 2)) * fade;
  }
  return acc * S.p[4].z;
}

// Light shafts: noise projected along the light direction (constant along each shaft).
fn cg_shaft(pos: vec3f, L: vec3f, t: f32) -> f32 {
  let sp = pos.xz - L.xz * (pos.y / L.y);
  let sh = sat(noise3fast(vec3f(sp * 0.45, S.p[5].z * 0.05)) * 0.9 + 0.45);
  return sh * sh * sh * sh * exp(-t * 0.08);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let biome = cg_biome();
  let rig = cg_rig();
  let grammar = cg_grammar();
  // Eased, level-scaled events: kick, snare, melody light; the glided melody pitch.
  let kickL = S.p[7].z;
  let snareL = S.p[7].y;
  let melL = S.p[7].w;
  let lp = S.p[3].z;
  var z = S.p[5].y;
  var ro: vec3f;
  var ta: vec3f;
  if (rig == 3) {
    // Slow orbit around a point on the path that itself creeps forward.
    let zc = S.p[5].y * 0.2;
    let c = vec3f(cg_path(zc) + 2.0, 0.0, zc);
    let a = S.p[5].y * 0.6;
    let rr = 3.2;
    let cp = c.xz + vec2f(cos(a), sin(a)) * rr;
    ro = vec3f(cp.x, cg_ground2(cp) + S.p[3].x + 0.3, cp.y);
    ta = vec3f(c.x, cg_ground2(c.xz) + 0.6, c.z);
    z = zc;
  } else {
    let cx = cg_path(z);
    let camY = cg_ground2(vec2f(cx, z)) + S.p[3].x;
    ro = vec3f(cx, camY, z);
    let tz = z + 3.0;
    let tx = cg_path(tz) + S.p[5].w;
    ta = vec3f(tx, cg_ground2(vec2f(tx, tz)) + S.p[3].x * 0.5 - S.p[6].y, tz);
  }
  let cam = lookAt(ro, ta, S.p[5].x);
  let fov = 1.15 + 0.3 * F.anticipation - 0.2 * S.p[2].w * S.p[2].w - select(0.0, 0.25, rig == 2);
  let rd = normalize(cam * vec3f(q, fov));
  let L = normalize(vec3f(0.35, 1.0, 0.25));

  let far = 21.0;
  // Nothing grows above the ceiling: rays climbing past it can stop marching.
  let ceilY = select(3.4, 9.2, biome == 1 || biome == 2);
  let ceilT = select(far, (ceilY - ro.y) / rd.y, rd.y > 0.01);
  let tmax = min(far, ceilT);
  var t = 0.05 + ign(frag) * 0.06;
  var hit = false;
  var res: CgHit;
  var glowW = 0.0;
  var glowB = 0.0;
  var shaft = 0.0;
  let glowK = select(40.0, 14.0, biome == 2);
  cg_rd = rd;
  for (var i = 0; i < 96; i++) {
    let pos = ro + rd * t;
    res = cg_map(pos);
    // Halo around tips: accumulate weight and band, colour it once after the march.
    let gw = exp(-res.tip * glowK) * 0.006;
    glowW += gw;
    glowB += gw * res.band;
    if (res.d < 0.001 * t + 0.0004) { hit = true; break; }
    // Relax steps with distance; fog hides any overshoot far away.
    var st = res.d * (1.0 + 0.015 * t);
    if (biome == 2) { st = min(st, 0.35); }
    shaft += cg_shaft(pos, L, t) * min(st, 0.8);
    t += st;
    if (t > tmax) { break; }
  }
  cg_rd = vec3f(0.0);
  if (!hit) {
    // Open water beyond the growth: finish the shaft integral in a few long strides.
    let t0 = min(t, far);
    let dt = (far - t0) / 6.0;
    for (var k = 0; k < 6; k++) {
      let tk = t0 + (f32(k) + ign(frag + 17.0)) * dt;
      shaft += cg_shaft(ro + rd * tk, L, tk) * dt;
    }
    t = far;
  }

  let water = cg_water(rd);
  var col = water;
  let antic = F.anticipation;
  let hue = cg_hue();
  if (hit) {
    let pos = ro + rd * t;
    // A slightly wider kernel on the seabed keeps sand ripples soft.
    let n = cg_normal(pos, select(max(0.0015, 0.0015 * t), 0.01, res.mat < 0.5));
    let ao = cg_ao(pos, n);
    let cau = cg_caustic(pos.xz * 0.3 + pos.y * 0.08, S.p[5].z * 0.45);
    let sunCol = mix(F.pal2.rgb, vec3f(0.55, 0.9, 1.0), 0.5) * S.p[1].z;
    let dif = sat(dot(n, L));
    let sky = sat(n.y * 0.5 + 0.5);
    let amb = mix(F.pal0.rgb * 0.6 + vec3f(0.0, 0.015, 0.02), water * 2.0, sky) * ao + vec3f(0.006, 0.01, 0.014);
    var alb = vec3f(0.0);
    var sss = 0.0;
    var emit = vec3f(0.0);
    if (res.mat < 0.5) {
      let sn = noise3(vec3f(pos.xz * 2.0, 5.0)) + 0.35 * noise3(vec3f(pos.xz * 9.0, 2.0));
      alb = mix(F.pal0.rgb + vec3f(0.07, 0.075, 0.07), mix(F.pal1.rgb, vec3f(0.6, 0.55, 0.45), 0.6) * 0.5, sat(0.5 + 0.5 * sn));
      if (biome == 2) { alb = alb * 0.35 + vec3f(0.01); }
      alb *= 0.92 + 0.16 * hash12(floor(pos.xz * 140.0));
    } else if (res.mat < 1.5) {
      alb = mix(palRamp(0.3 + 0.35 * res.band), pal(hue + 0.15 + res.y * 0.3), sat(res.y)) * 0.62 + vec3f(0.015);
      sss = cg_thin(pos, n);
    } else if (res.mat < 2.5) {
      alb = mix(F.pal1.rgb, pal(hue + 0.4), sat(res.y)) * 0.7 + vec3f(0.015);
      if (biome == 2) { alb = mix(vec3f(0.6, 0.58, 0.52), palL(hue + 0.02, 0.3), smoothstep(0.55, 0.95, res.y)); }
      sss = cg_thin(pos, n);
    } else if (res.mat < 3.5) {
      alb = palRampL(0.25 + 0.35 * res.y, 0.04 + 0.12 * res.y) + vec3f(0.01);
      sss = 0.35;
    } else if (res.mat < 4.5) {
      // Kelp: translucent olive fronds tinted by the palette.
      alb = mix(palRampL(0.35 + 0.2 * res.band, 0.22), vec3f(0.3, 0.27, 0.08), 0.45);
      sss = 0.75;
    } else {
      // Chimney: dark mineral crust with veins glowing from the heat inside.
      alb = F.pal0.rgb * 0.4 + vec3f(0.02, 0.018, 0.016);
      let vein = smoothstep(0.09, 0.0, abs(noise3(pos * 3.5))) * (0.3 + 0.7 * res.y);
      emit = palL(hue + 0.05, 0.6) * vein * (0.4 + 2.0 * F.bass + 0.8 * kickL) * S.p[1].y * 0.5;
    }
    let sunAmt = 0.25 + 2.6 * cau * S.p[4].x;
    col = alb * (sunCol * dif * sunAmt * (0.4 + 0.6 * ao) + amb);
    // Subsurface: light leaking through thin growth, tinted by the bioluminescent hue.
    let bl = sat(dot(rd, L) * 0.5 + 0.5);
    col += pal(hue + 0.08 + res.band * 0.15) * sss * sss * (0.12 + 0.3 * bl + 0.35 * F.bass) * ao * max(S.p[1].z, 0.25);
    // Wet sheen and rim.
    let spe = pow(sat(dot(reflect(rd, n), L)), 40.0);
    let gloss = select(1.0, 0.25, res.mat < 0.5);
    col += sunCol * spe * (0.15 + 0.6 * cau) * ao * gloss;
    let fre = pow(1.0 - sat(dot(n, -rd)), 4.0);
    col += water * fre * 1.5 * ao * gloss;
    col += emit;
    if (res.mat > 2.5 && res.mat < 3.5) {
      // Sponge pores glow from inside with the low-mids.
      col += pal(hue + 0.55) * (1.0 - ao) * (1.0 - ao) * (0.04 + 1.0 * spec(0.15) * spec(0.15) + 0.2 * kickL) * S.p[1].y;
    } else if (res.mat > 0.5 && res.mat < 4.5) {
      // Bioluminescent tips and a faint glow creeping up the growth.
      col += cg_tipCol(res.band) * exp(-res.tip * 30.0) * 1.6;
      // Snare: the crowns of the growth flush with light from within.
      col += pal(hue + 0.5) * smoothstep(0.3, 1.0, res.y) * S.p[1].y * (0.08 * (0.3 + spec(0.4 + 0.5 * res.band)) + 1.0 * snareL);
    }
    if (res.mat > 0.5) {
      // Melody: a band of bioluminescence on every growth at the height the lead's pitch sets,
      // flaring on each note's attack and glowing faintly while it is held.
      let mY = 0.5 + 0.42 * lp;
      let mb = exp(-pow((res.y - mY) / 0.2, 2.0));
      let mCol = palL(hue + 0.45 + 0.2 * lp, 1.0);
      col += mCol * mb * melL * max(S.p[1].y, 0.6) * 0.6;
    }
    // Drop: a ring of light sweeps outward across the reef.
    let wc = vec2f(cg_path(z + 2.0), z + 2.0);
    let wd = length(pos.xz - wc) - S.p[2].z;
    col += mix(F.pal3.rgb, pal(hue + 0.3), 0.4) * exp(-wd * wd * 1.5) * S.p[2].w * 2.5;
    // Kick: a ring of light rolls outward from ahead over the seabed and up the growth.
    let kd = length(pos.xz - wc) - S.p[2].x;
    let kw = select(4.0, 1.5, grammar == 1);
    col += palL(hue + 0.25, 0.5) * exp(-kd * kd * kw) * S.p[7].z * max(S.p[1].y, 0.6) * 0.5;
  }
  let fogAmt = max(1.0 - exp(-t * S.p[4].y * (1.0 + 0.6 * antic)), smoothstep(far * 0.55, far, t));
  col = mix(col, water, fogAmt);
  let glowCol = select(cg_tipCol(glowB / max(glowW, 1e-6)), palL(hue + 0.05, 0.5) * (0.5 + 2.0 * F.bass + 1.0 * kickL) * S.p[1].y, biome == 2);
  col += glowCol * glowW * (1.0 + 1.5 * antic + 0.67 * melL) * select(1.0, 0.6, biome == 2);
  let shaftCol = mix(F.pal2.rgb, vec3f(0.5, 0.85, 1.0), 0.5);
  col += shaftCol * shaft * 0.05 * S.p[1].z * (0.6 + 0.6 * F.energySlow);
  col += cg_plankton(ro, rd, select(far, t, hit));
  // Chord change: soft bloom of the water.
  col += pal(hue + 0.6) * S.p[6].x * 0.02;
  return vec4f(col, 1.0);
}
`,
});
