import { raymarchScene } from '../raymarchScene';
import type { MusicState } from '../../audio/musicState';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Fungal and vascular vein networks spreading over a substrate. Veins are real
 * raised tubes (two calibres) carrying glowing nutrient flow that lights the
 * ground around them; luminous mushrooms sprout as intensity rises and burst up
 * on drops.
 *
 * DNA: substrate (forest floor, small planet, floating leaf skeleton), network
 * pattern (cellular hyphal mesh, branching ridges, radial colonies that fork as
 * they grow), vein scale, camera (low glide, high overview, macro), light (night
 * bioluminescence, low dusk sun, vascular x-ray), flow grammar (kick waves out of
 * the colony centres, streaming dashes, breathing), hue and seed.
 *
 * Music: the melody travels through the network: each note lights a ring of veins around
 * the point you look at, its radius set by the pitch, and the mushrooms tuned to that pitch
 * flare. Kicks send a wave of nutrient light out of the colony centres; snares swell the
 * thick veins. Travel and orbit advance with the beats and bars and rest in silence.
 *
 * Events come from the shared morph: each reaction is scaled by its level squared (so a faint
 * intro motif only glimmers), eased in, and the melody ring glides to each pitch.
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
const fx = { lead: new Flare(0.15, 0.3), kick: new Flare(0.15, 0.3), snare: new Flare(0.2, 0.5) };
/** Held-note glow, melody pitch, hats and bass, glided so none of them jumps. */
const held = new Spring(0, 0.12);
const glide = new Spring(0, 0.25);
const hatS = new Spring(0, 0.1);
const bassS = new Spring(0, 0.12);
let lastT = -1;

/** Music clock: `beat` surges on every beat, `bar` steps on every bar, both scaled by loudness. */
const clk = { t: -1, b: 0, r: 0, beat: 0, bar: 0 };
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
  }
  clk.t = m.time;
  clk.b = b;
  clk.r = r;
}

export default raymarchScene({
  meta: {
    id: 'mycelium-veins',
    name: 'Mycelium',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.1, 0.75],
    mood: { valence: 0.5, arousal: 0.35 },
    genres: { ambient: 1, acoustic: 0.85, lofi: 0.9, hiphop: 0.7, jazz: 0.5, classical: 0.4 },
    trails: 0.3,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    tickClock(m);
    const g = ctx.dna;
    const ev = ctx.evolve;
    const sub = Math.floor(g[1] * 3) % 3; // 0 floor, 1 planet, 2 leaf
    const pattern = Math.floor(g[2] * 3) % 3; // 0 mesh, 1 ridges, 2 radial
    // 0 glide, 1 overview, 2 macro. The planet is only ever seen from low over its surface:
    // an overview of it is a ball floating in space, not a place.
    const camMode = Math.floor(g[4] * 3) % 3 === 1 && sub === 1 ? 0 : Math.floor(g[4] * 3) % 3;
    const light = Math.floor(g[5] * 3) % 3; // 0 night, 1 dusk, 2 x-ray
    const grammar = Math.floor(g[6] * 3) % 3;
    const antic = m.anticipation;
    const drop = m.dropPulse;
    const sp = clk.bar * 0.5;
    const tr = clk.beat * 0.6;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    if (Math.abs(m.time - lastT) > 0.5) {
      held.reset(0);
      glide.reset(Math.max(-1, Math.min(1, m.leadPitch)));
    }
    lastT = m.time;
    const pres = morph.presence;
    const heldL = held.update(m.leadHeld * pres ** 2, dt);
    const pitch01 = 0.5 + 0.5 * glide.update(Math.max(-1, Math.min(1, m.leadPitch)), dt);
    const kickF = fx.kick.update(morph.kicks, morph.kickAge, morph.kickLevel);
    const snareF = fx.snare.update(morph.snares, morph.snareAge, morph.snareLevel);
    const bass = bassS.update(m.bass * pres, dt);
    // The kick wave: its front runs out with the kick's age, lit by the kick's eased level.
    const kAge = Math.min(morph.kickAge, 9);
    const kFront = Math.min(1, kAge / 0.6);
    const kAmp = onset(kAge, morph.kickLevel, 0.15) * (1 - kFront);

    let ro: number[];
    let ta: number[];
    let fov = 1.5;
    if (sub === 1) {
      // Planet radius 3.
      if (camMode === 1) {
        const a = sp * 0.08 + g[7] * 6.28;
        const d = 8.5 - 0.6 * m.energySlow;
        ro = [Math.cos(a) * d, 2.5 * Math.sin(sp * 0.04), Math.sin(a) * d];
        ta = [0, 0, 0];
        fov = 1.6;
      } else {
        // Skim low so the surface fills the view (higher up it reads as a ball in space).
        const alt = camMode === 0 ? 0.55 : 0.3;
        const a = tr * (camMode === 0 ? 0.05 : 0.02) + g[7] * 6.28;
        const r = 3 + alt;
        const tilt = 0.4 * Math.sin(sp * 0.03);
        ro = [Math.cos(a) * r, Math.sin(tilt) * r, Math.sin(a) * r];
        const a2 = a + (camMode === 0 ? 0.3 : 0.2);
        ta = [Math.cos(a2) * 3, Math.sin(tilt) * 3 - 0.1, Math.sin(a2) * 3];
        fov = camMode === 0 ? 1.3 : 1.7;
      }
    } else if (sub === 2) {
      // Leaf (9 long on x, ~7 wide on z): orbit and hover, never leave it.
      const a = sp * 0.05 + g[7] * 6.28;
      if (camMode === 0) {
        ro = [Math.cos(a) * 5.2, 1.8 + 0.4 * Math.sin(sp * 0.07), Math.sin(a) * 3.6];
        ta = [Math.cos(a + 0.9) * 1.5, -0.2, Math.sin(a + 0.9) * 1.0];
        fov = 1.35;
      } else if (camMode === 1) {
        ro = [Math.cos(a) * 3, 7.5, Math.sin(a) * 3];
        ta = [0, 0, 0];
        fov = 1.3;
      } else {
        const u = tr * 0.04 + g[7] * 6.28;
        ro = [Math.sin(u) * 3.2, 1.15, Math.sin(u * 0.7) * 1.4];
        ta = [Math.sin(u + 0.25) * 3.2 + 0.4, -0.1, Math.sin((u + 0.25) * 0.7) * 1.4 + 0.3];
        fov = 1.6;
      }
    } else {
      // Forest floor; heights are relative to the ground (resolved in the shader).
      if (camMode === 0) {
        const z = tr * 0.35;
        ro = [Math.sin(z * 0.09) * 2, 1.7 + 0.3 * Math.sin(sp * 0.05), z];
        ta = [Math.sin((z + 5) * 0.09) * 2, 0.15, z + 5];
        fov = 1.35;
      } else if (camMode === 1) {
        const a = sp * 0.05 + g[7] * 6.28;
        const c = [tr * 0.05, 0, tr * 0.2];
        ro = [c[0] + Math.cos(a) * 3, 6.5, c[2] + Math.sin(a) * 3];
        ta = [c[0], 0, c[2]];
        fov = 1.4;
      } else {
        const z = tr * 0.1;
        ro = [Math.sin(z * 0.2) * 0.6, 0.6, z];
        ta = [Math.sin(z * 0.2 + 0.3) * 0.6 + 0.2, 0.05, z + 1.6];
        fov = 1.6;
      }
    }
    p[0] = ro[0]; p[1] = ro[1]; p[2] = ro[2]; p[3] = fov * (1 + 0.1 * antic);
    p[4] = ta[0]; p[5] = ta[1]; p[6] = ta[2]; p[7] = Math.sin(sp * 0.05 + g[3] * 5) * 0.08;
    // Fractions (all under the shader's 0.5 comparisons): passage loudness, glided pitch 0..1,
    // kick wave strength.
    p[8] = sub + 0.45 * pres; p[9] = pattern; p[10] = light + 0.45 * pitch01; p[11] = grammar + 0.45 * Math.min(1, kAmp);
    // vein scale, thickness, mushroom growth, seed
    p[12] = (0.7 + 0.8 * g[3]) * (sub === 1 ? 2.2 : 1);
    p[13] = (1 + 0.25 * bass * (grammar === 2 ? 2 : 1) + 0.15 * kickF + 0.35 * snareF) * (1 - 0.2 * antic);
    const grow = Math.min(1, Math.max(0, ctx.intensity * 1.1 - 0.25 + 0.6 * drop + 0.15 * ev[1]));
    p[14] = grow * (1 - 0.5 * antic);
    p[15] = g[7];
    // hue, glow gain, fog, kick wave
    p[16] = g[0] * 0.8 + 0.15 * ev[3];
    p[17] = (0.45 + 0.4 * ctx.intensity + 0.3 * kickF + 0.5 * drop) * (1 + 0.2 * antic) * (sub === 1 ? 0.75 : 1);
    p[18] = sub === 1 ? 0.02 : [0.12, 0.07, 0.18][camMode];
    p[19] = kFront;
    // anticipation, drop, hat, snare
    p[20] = antic; p[21] = drop; p[22] = hatS.update(m.hat * pres, dt); p[23] = 0.8 * snareF;
    // flow phase, light dir
    p[24] = clk.beat * 0.35;
    const la = g[5] * 7 + ev[2];
    p[25] = Math.cos(la); p[26] = light === 1 ? 0.25 : 0.8; p[27] = Math.sin(la);
    // Melody ring radius (from the pitch) and brightness; chord swell (eased); leaf sway phase.
    const ringBase = sub === 1 ? 0.35 : camMode === 2 ? 0.25 : 0.6;
    const ringSpan = sub === 1 ? 1.2 : camMode === 2 ? 1.0 : 2.4;
    p[28] = ringBase + ringSpan * pitch01;
    p[29] = 0.5 * heldL + 5 * fx.lead.update(morph.notes, morph.leadAge, morph.noteLevel);
    p[30] = 4 * m.chordPulse * (1 - m.chordPulse);
    p[31] = clk.beat * 0.1;
  },
  wgsl: /* wgsl */ `
struct MyH { d: f32, mat: f32, flow: f32, cls: f32, e: f32 };

var<private> my_rd: vec3f;
var<private> my_lod: f32;
var<private> my_ta: vec3f;

// Melody: a ring of veins around the point in view lights on each note; its radius is the pitch.
fn my_sing(p: vec3f) -> f32 {
  let r = length(p - my_ta) - S.p[7].x;
  return S.p[7].y * exp(-r * r * 12.0);
}

fn my_vnoise(x: vec2f) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = hash12(i); let b = hash12(i + vec2f(1.0, 0.0));
  let c = hash12(i + vec2f(0.0, 1.0)); let d = hash12(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

// Voronoi edges: (edge distance, distance to site, site hash).
fn my_vor2(x: vec2f, seed: f32) -> vec3f {
  let n = floor(x);
  let f = x - n;
  var mg = vec2f(0.0);
  var mr = vec2f(0.0);
  var md = 8.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let o = vec2f(hash12(n + g + seed), hash12(n + g + seed + 17.3)) * 0.85 + 0.075;
      let r = g + o - f;
      let d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  var e = 8.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = mg + vec2f(f32(i), f32(j));
      let o = vec2f(hash12(n + g + seed), hash12(n + g + seed + 17.3)) * 0.85 + 0.075;
      let r = g + o - f;
      if (dot(mr - r, mr - r) > 1e-5) { e = min(e, dot(0.5 * (mr + r), normalize(r - mr))); }
    }
  }
  return vec3f(e, sqrt(md), hash12(n + mg + seed + 3.1));
}

// Spherical Voronoi: sites of the cells around the sphere through x are projected onto
// it, so every bisector plane passes through the centre and cuts the surface at right
// angles (plain 3D Voronoi grazes the surface and smears into wide bands).
fn my_site3(c: vec3f, seed: f32, rs: f32) -> vec3f {
  let s = c + hash33(c + seed) * 0.85 + 0.075;
  let keep = abs(length(c + 0.5) - rs) < 0.8;
  return select(vec3f(1e4), normalize(s) * rs, keep);
}
fn my_vor3(x: vec3f, seed: f32) -> vec3f {
  let n = floor(x);
  let rs = length(x);
  var st: array<vec3f, 27>;
  var mc = n;
  var ms = vec3f(1e4);
  var md = 1e9;
  for (var k = 0; k < 27; k++) {
    let c = n + vec3f(f32(k % 3), f32((k / 3) % 3), f32(k / 9)) - 1.0;
    let s = my_site3(c, seed, rs);
    st[k] = s;
    let d = dot(s - x, s - x);
    if (d < md) { md = d; ms = s; mc = c; }
  }
  var e = 8.0;
  for (var k = 0; k < 27; k++) {
    let s = st[k];
    if (dot(s - ms, s - ms) > 1e-5 && s.x < 1e3) {
      e = min(e, dot(x - 0.5 * (ms + s), normalize(ms - s)));
    }
  }
  return vec3f(e, sqrt(md), hash13(mc + seed));
}

// Distance to the zero set of noise measured along the surface (normal N): |n| / |tangent grad|.
fn my_ridge(q: vec3f, N: vec3f) -> f32 {
  let h = 0.06;
  let n0 = noise3(q);
  var g = vec3f(noise3(q + vec3f(h, 0.0, 0.0)), noise3(q + vec3f(0.0, h, 0.0)), noise3(q + vec3f(0.0, 0.0, h))) - n0;
  g = g / h;
  g -= N * dot(g, N);
  return abs(n0) / max(length(g), 0.25);
}

// Vein network in surface coordinates. Returns (thick-vein dist, fine-vein dist, flow coordinate).
// On the leaf the thick veins are its own venation (midrib + curving secondaries) and the
// DNA pattern fills the areoles.
fn my_veins(uv: vec2f, p3: vec3f) -> vec3f {
  let v = my_pattern(uv, p3);
  if (S.p[2].x < 1.5) { return v; }
  let az = abs(uv.y);
  let mid = az * 1.4;
  let s = 0.85;
  let u = (uv.x + 4.5 - 0.95 * az - 0.12 * az * az) / s;
  let sec = abs(fract(u + 0.5) - 0.5) * s * 0.75 + select(0.0, 9.0, az < 0.04);
  return vec3f(min(mid, sec), min(v.x, v.y) * 0.8, (uv.x + 4.5) + az * 1.5);
}

fn my_pattern(uv: vec2f, p3: vec3f) -> vec3f {
  let pat = S.p[2].y;
  let sc = S.p[3].x;
  let seed = S.p[3].w * 50.0;
  let planet = S.p[2].x > 0.5 && S.p[2].x < 1.5;
  if (pat < 0.5) {
    // Cellular hyphal mesh: coarse cells plus a finer mesh.
    if (planet) {
      // Wobbly, hyphal cell walls.
      let wp = p3 + noise4(p3 * 2.2 + seed).xyz * (0.1 / sc);
      let a = my_vor3(wp * sc * 1.1, seed);
      var fine = 9.0;
      if (my_lod < 12.0) { fine = my_ridge(wp * sc * 2.4 + vec3f(seed), normalize(p3)) / (sc * 2.4) + select(0.0, 9.0, noise3(wp * sc * 1.3 + 4.0) < -0.15); }
      return vec3f(a.x / (sc * 1.1), fine, a.y + a.z * 3.0);
    }
    let w = uv * sc * 1.2 + 0.35 * vec2f(my_vnoise(uv * 1.1 + seed), my_vnoise(uv * 1.1 + seed + 9.0));
    let a = my_vor2(w, seed);
    let b = my_vor2(w * 2.7 + 3.3, seed + 7.0);
    return vec3f(a.x / (sc * 1.2), b.x / (sc * 1.2 * 2.7), a.y + a.z * 3.0);
  } else if (pat < 1.5 || planet) {
    // Branching ridges: zero sets of warped noise at two scales, measured along the surface.
    let q = select(vec3f(uv * sc * 0.8, seed), p3 * sc * 0.8 + vec3f(seed), planet);
    let N = select(vec3f(0.0, 0.0, 1.0), normalize(p3), planet);
    let wq = q + 0.5 * vec3f(noise3(q * 0.5 + 3.0), noise3(q * 0.5 + 7.0), noise3(q * 0.5 + 1.0)) * select(vec3f(1.0, 1.0, 0.0), vec3f(1.0), planet);
    let e1 = my_ridge(wq, N) / (sc * 0.8);
    let e2 = my_ridge(wq * 2.3 + 11.0, N) / (sc * 0.8 * 2.3) + select(0.0, 9.0, noise3(wq * 1.7 + 2.0) < -0.1);
    return vec3f(e1, e2, noise3(wq * 0.3 + 5.0) * 6.0);
  }
  // Radial colonies whose hyphae fork as they grow outward.
  let cs = 3.2 / sc;
  let x = uv / cs;
  let nn = floor(x);
  var best = 9.0;
  var cc = vec2f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = nn + vec2f(f32(i), f32(j));
      let c = g + 0.5 + (vec2f(hash12(g + seed), hash12(g + seed + 4.0)) - 0.5) * 0.7;
      let d = length(x - c);
      if (d < best) { best = d; cc = c; }
    }
  }
  let rel = (x - cc) * cs;
  let r = length(rel) + 1e-4;
  let wob = my_vnoise(vec2f(r * 1.3, atan2(rel.y, rel.x) * 2.0) + seed) * 0.25;
  let ang = atan2(rel.y, rel.x) + wob;
  let lvl = clamp(floor(log2(max(r / 0.35, 1.0))), 0.0, 5.0);
  let N = 9.0 * exp2(lvl);
  let a = ang * N / TAU;
  let e1 = abs(fract(a) - 0.5) * TAU * r / N;
  let N2 = N * 2.0;
  let a2 = ang * N2 / TAU + 0.5;
  let e2 = abs(fract(a2) - 0.5) * TAU * r / N2 + select(0.0, 9.0, fract(r * 2.0 + hash12(floor(vec2f(a2, r * 2.0)))) < 0.4);
  return vec3f(e1, e2, r);
}

fn my_ground(xz: vec2f) -> f32 {
  return my_vnoise(xz * 0.18) * 0.55 + my_vnoise(xz * 0.6 + 7.0) * 0.12 + noise4(vec3f(xz * 1.7, 3.0)).x * 0.025;
}

// Leaf sheet height and outline (negative inside).
fn my_leaf(xz: vec2f) -> vec2f {
  let L = 9.0;
  let x = xz.x;
  let s = sat((x + L * 0.5) / L);
  let W = 3.4 * pow(sin(PI * s), 0.75) * (1.0 - 0.25 * s);
  let serr = 0.06 * sin(x * 6.0);
  let outline = abs(xz.y) - W - serr;
  let h = 0.04 * xz.y * xz.y - 0.012 * x * x + 0.25 * sin(x * 0.5 + S.p[7].w) + 0.12 * sin(xz.y * 1.3 + x * 0.3);
  return vec2f(h, max(outline, abs(x) - L * 0.5));
}

fn my_shroomCell() -> f32 { return 1.6; }

// Mushroom in local space (y up from its foot); g = growth 0..1.
fn my_shroom(q: vec3f, g: f32, h: f32) -> vec2f {
  let hs = (0.18 + 0.25 * h) * g;
  let rc = (0.1 + 0.12 * fract(h * 7.3)) * g;
  let bend = vec2f(sin(q.y * 3.0 + h * 6.0), cos(q.y * 2.0 + h * 4.0)) * 0.03 * q.y;
  let sq = vec3f(q.x - bend.x, q.y, q.z - bend.y);
  let stem = length(vec3f(sq.x, sq.y - clamp(sq.y, 0.0, hs), sq.z)) - (0.018 + 0.012 * (1.0 - sq.y / max(hs, 0.01))) * g;
  let cq = sq - vec3f(0.0, hs, 0.0);
  let cap = max(length(cq * vec3f(1.0, 1.0 / 0.6, 1.0)) * 0.6 - rc * 0.6, -cq.y - rc * 0.08);
  return vec2f(min(stem, cap), select(0.0, 1.0, cap < stem));
}

fn my_map(p: vec3f) -> MyH {
  var r: MyH;
  r.mat = 0.0; r.flow = 0.0; r.cls = 0.0; r.e = 9.0;
  let sub = floor(S.p[2].x);
  let th = S.p[3].y;
  var hgt = 0.0;
  var uv = p.xz;
  var outline = -1.0;
  if (sub < 0.5) {
    hgt = p.y - my_ground(p.xz);
  } else if (sub < 1.5) {
    let R = 3.0;
    hgt = length(p) - R;
    uv = vec2f(atan2(p.z, p.x) * 3.0, p.y * 3.0);
  } else {
    let lf = my_leaf(p.xz);
    hgt = p.y - lf.x;
    outline = lf.y;
  }
  // Base surface (leaf: only a faint lamina remains between veins).
  var d = hgt * 0.7;
  if (sub > 1.5) { d = 1e9; }
  r.d = d;
  if (abs(hgt) < 0.035 && outline < 0.15) {
    let v = my_veins(uv, p);
    let pr = select(1.0, 0.6, sub > 0.5 && sub < 1.5);
    let r1 = 0.014 * th * pr;
    let r2 = 0.006 * th * pr * smoothstep(12.0, 3.0, my_lod);
    let t1 = length(vec2f(v.x, hgt - r1 * 0.6)) - r1;
    let t2 = length(vec2f(v.y, hgt - r2 * 0.5)) - r2;
    var vt = min(t1, t2);
    if (sub > 1.5) {
      vt = max(vt, outline);
      // Leaf edge vein.
      let ev = length(vec2f(outline, hgt)) - r1 * 0.8;
      vt = min(vt, ev);
      // Translucent lamina as a very thin sheet in some areoles.
      let lam = max(abs(hgt) - 0.004, outline);
      if (lam < r.d) { r.d = lam; r.mat = 3.0; }
    }
    r.e = min(v.x, v.y * 1.5);
    if (vt < r.d + 0.01) {
      r.mat = 1.0;
      r.cls = select(1.0, 0.0, t1 < t2);
      r.flow = v.z;
    }
    r.d = smin(r.d, vt * 0.8, 0.02);
  } else if (sub > 1.5) {
    r.d = max(abs(hgt) - 0.03, outline) * 0.7;
    r.d = max(r.d, 0.004);
  }
  // Fruiting bodies in a grid of cells over the substrate.
  let grow = S.p[3].z;
  if (grow > 0.02 && sub != 1.0 && hgt < 0.8 && outline < 0.0) {
    let cs = my_shroomCell();
    let id = floor(p.xz / cs);
    let hh = hash12(id + S.p[3].w * 13.0);
    let gate = sat((grow - hh * 0.85) * 4.0);
    if (gate > 0.01) {
      let c = (id + 0.5 + (vec2f(hh, fract(hh * 9.1)) - 0.5) * 0.5) * cs;
      var base = 0.0;
      if (sub < 0.5) { base = my_ground(c); } else { base = my_leaf(c).x; }
      let q = vec3f(p.x - c.x, p.y - base + 0.02, p.z - c.y);
      let ms = my_shroom(q, gate, fract(hh * 3.7));
      if (ms.x < r.d) { r.d = ms.x; r.mat = 2.0 + ms.y * 0.5; r.flow = hh; }
    }
    // Never step past the cell boundary while marching.
    if (my_rd.x != 0.0 || my_rd.z != 0.0) {
      let lc = p.xz - (id + 0.5) * cs;
      let tx = select(1e5, (sign(my_rd.x) * cs * 0.5 - lc.x) / my_rd.x, abs(my_rd.x) > 1e-5);
      let tz = select(1e5, (sign(my_rd.z) * cs * 0.5 - lc.y) / my_rd.z, abs(my_rd.z) > 1e-5);
      r.d = min(r.d, max(min(tx, tz), 0.0) + 0.01);
    }
  }
  return r;
}

fn my_dist(p: vec3f) -> f32 { return my_map(p).d; }

fn my_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * my_dist(p + k.xyy * e) + k.yyx * my_dist(p + k.yyx * e) +
                   k.yxy * my_dist(p + k.yxy * e) + k.xxx * my_dist(p + k.xxx * e));
}

fn my_hue() -> f32 { return S.p[4].x + F.morph2.x * 0.2 + S.p[7].z * 0.06; }

// Nutrient flow brightness along a vein.
fn my_flowI(flow: f32, cls: f32) -> f32 {
  let g = floor(S.p[2].w);
  let kAmp = fract(S.p[2].w) / 0.45;
  let band = select(0.12, 0.65, cls > 0.5);
  let lv = spec(band) * fract(S.p[2].x) / 0.45;
  var I = 0.25 + 0.9 * lv + S.p[5].w * 1.2 * cls + 0.3 * F.tension * (1.0 - cls);
  // Kick: a wave of nutrient light runs out of the colony centres.
  let front = S.p[4].w * 6.0;
  let w = fract(flow * 0.35) * 6.0 - front;
  I += select(1.4, 2.2, g < 0.5) * exp(-w * w * 3.0) * kAmp;
  if (g < 0.5) {
    I += 0.4 * kAmp;
  } else if (g < 1.5) {
    let s = 0.5 + 0.5 * sin(flow * 9.0 - S.p[6].x * 4.0 + cls * 2.0);
    I += 1.6 * pow(s, 10.0) * (0.6 + F.energy);
  } else {
    I *= 0.6 + 1.2 * F.bass * fract(S.p[2].x) / 0.45 + 0.6 * kAmp;
  }
  return I;
}

fn my_sky(rd: vec3f) -> vec3f {
  let light = S.p[2].z;
  let hue = my_hue();
  let L = normalize(S.p[6].yzw);
  let sub = floor(S.p[2].x);
  var c = palRampL(0.15 + 0.25 * sat(rd.y), 0.012);
  if (light > 0.5 && light < 1.5) {
    let ld = max(dot(rd, L), 0.0);
    c = palRampL(0.25 + 0.35 * sat(rd.y + 0.2), 0.03) + palL(hue + 0.1, 0.25) * pow(ld, 8.0) + palL(hue + 0.12, 2.5) * pow(ld, 400.0);
    c += palL(hue + 0.05, 0.06) * exp(-abs(rd.y) * 6.0);
  }
  if (sub > 0.5 && sub < 1.5) {
    // Space: stars.
    let st = hash13(floor(rd * 400.0));
    c = c * 0.4 + vec3f(1.0) * step(0.997, st) * 0.6 * hash13(floor(rd * 400.0) + 3.0);
  }
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let sub = floor(S.p[2].x);
  var ro = S.p[0].xyz;
  var ta = S.p[1].xyz;
  if (sub < 0.5) {
    // Floor cameras ride a smoothed ground height.
    ro.y += max(my_ground(ro.xz), my_ground(ro.xz + vec2f(0.0, 1.5)));
    ta.y += my_ground(ta.xz);
  }
  let cam = lookAt(ro, ta, S.p[1].w);
  let rd = normalize(cam * vec3f(q, S.p[0].w));
  my_ta = ta;
  if (sub > 0.5 && sub < 1.5) { my_ta = normalize(select(ro, ta, dot(ta, ta) > 0.01)) * 3.0; }
  let light = S.p[2].z;
  let hue = my_hue();
  let gain = S.p[4].y;
  let fogD = S.p[4].z;
  let antic = S.p[5].x;
  let drop = S.p[5].y;
  let L = normalize(S.p[6].yzw);
  let far = select(30.0, 16.0, sub > 0.5 && sub < 1.5);

  var t = 0.02 + ign(frag) * 0.02;
  var tmax = far;
  if (sub > 0.5 && sub < 1.5) {
    // Planet bounding sphere.
    let b = dot(ro, rd);
    let c = dot(ro, ro) - 3.4 * 3.4;
    let hd = b * b - c;
    if (hd < 0.0) { tmax = -1.0; } else { t = max(t, -b - sqrt(hd)); tmax = -b + sqrt(hd); }
  }
  var hit = false;
  var h: MyH;
  var glow = vec3f(0.0);
  my_rd = rd;
  if (tmax > 0.0) {
    for (var i = 0; i < 120; i++) {
      let p = ro + rd * t;
      my_lod = t;
      h = my_map(p);
      // Glow haze hanging over the veins.
      if (h.e < 0.5) {
        glow += exp(-h.e * 40.0) * min(h.d, 0.08) * exp(-t * fogD) * (my_flowI(h.flow, h.cls) + my_sing(p));
      }
      if (h.d < 0.0007 * t + 0.0005) { hit = true; break; }
      t += h.d * 0.85;
      if (t > tmax) { break; }
    }
  }
  my_rd = vec3f(0.0);
  let sky = my_sky(rd);
  var col = sky;
  if (hit) {
    let p = ro + rd * t;
    let n = my_normal(p, 0.001 + 0.0007 * t);
    let dif = sat(dot(n, L));
    let fres = pow(1.0 - sat(dot(n, -rd)), 4.0);
    // Glow spill from nearby veins onto everything.
    var uvh = p.xz;
    if (sub > 0.5 && sub < 1.5) { uvh = vec2f(atan2(p.z, p.x) * 3.0, p.y * 3.0); }
    let vv = my_veins(uvh, p);
    let ve = min(vv.x, vv.y * 1.6);
    let flowI = my_flowI(vv.z, select(1.0, 0.0, vv.x < vv.y)) + my_sing(p);
    let vcol = palL(hue + select(0.35, 0.0, vv.x < vv.y) + vv.z * 0.02, 1.0);
    // Light cast by nearby veins (multiplied by albedo where it lands).
    let spill = vcol * (exp(-ve * 45.0) * 0.7 + exp(-ve * 8.0) * 0.08) * flowI;
    var keyCol = palL(hue + 0.55, 0.05);
    var amb = palRampL(0.3, 0.02);
    if (light > 0.5 && light < 1.5) { keyCol = palL(hue + 0.1, 0.9); amb = palRampL(0.4, 0.04); }
    if (light > 1.5) { keyCol = palL(hue + 0.6, 0.12); }
    let ao = sat(0.4 + 0.6 * my_dist(p + n * 0.08) / 0.08);
    var c = vec3f(0.0);
    if (h.mat < 0.5) {
      // Substrate.
      var alb = palRampL(0.1 + 0.15 * noise3(p * 3.0) + 0.1, 0.1);
      if (sub < 0.5) {
        let lit = noise4(vec3f(p.xz * 2.2, 1.0));
        alb = mix(alb, palL(hue + 0.08 + lit.y * 0.1, 0.12), sat(lit.x + 0.3)) * (0.8 + 0.4 * lit.z);
      } else if (sub < 1.5) {
        alb = palRampL(0.2 + 0.2 * noise3(p * 2.0), 0.08);
      }
      if (light > 1.5) { alb *= 0.35; }
      c = alb * (keyCol * dif + amb + spill * 1.5) * ao;
    } else if (h.mat < 1.5) {
      // Vein tube: emissive core, glassy sheath.
      let ndv = sat(dot(n, -rd));
      let em = vcol * flowI * (0.2 + 0.8 * ndv * ndv) * select(1.0, 0.7, h.cls > 0.5);
      c = em * 0.6 + keyCol * dif * 0.2 + vcol * fres * 0.3;
      if (light > 1.5) { c = em * 0.9 + vcol * fres * 0.6; }
    } else if (h.mat < 2.75) {
      // Mushroom: stem (2.0) or cap (2.5); gills glow under the cap.
      let isCap = h.mat > 2.25;
      let mh = h.flow;
      let alb = palL(hue + 0.45 + mh * 0.2, select(0.12, 0.2, isCap));
      let under = sat(-n.y);
      let gcol = palL(hue + 0.5 + mh * 0.25, 1.0);
      // Each mushroom is tuned to a pitch: the melody's notes flare the ones that match.
      let tp = fract(mh * 7.7) - fract(S.p[2].z) / 0.45;
      let tune = exp(-tp * tp * 40.0) * 1.2 * S.p[7].y;
      let pulse = 0.6 + 1.5 * fract(S.p[2].w) / 0.45 * select(0.3, 1.0, isCap) + 2.0 * drop + spec(0.3 + 0.5 * mh) * 1.5 + tune;
      c = alb * (keyCol * dif + amb * 2.0) * ao + gcol * (under * 0.8 + fres * 0.4) * pulse * select(0.3, 1.0, isCap) + alb * spill;
      // Spots on caps sparkle with the hats.
      let spots = step(0.82, hash13(floor(p * 40.0))) * select(0.0, 1.0, isCap && n.y > 0.3);
      c += gcol * spots * (0.3 + 3.0 * S.p[5].z);
    } else {
      // Leaf lamina remnant: thin and backlit.
      let bl = sat(dot(rd, L) * 0.5 + 0.5);
      c = palL(hue + 0.1, 0.05) * (0.4 + 1.5 * bl + spill * 2.0);
    }
    c *= gain;
    let fa = exp(-t * fogD);
    col = mix(sky, c, fa);
  }
  col += palL(hue + 0.3, 1.0) * glow * gain * 0.2;
  // Planet atmosphere rim.
  if (sub > 0.5 && sub < 1.5) {
    let b = dot(ro, rd);
    let dmin = sqrt(max(dot(ro, ro) - b * b, 0.0));
    col += palL(hue + 0.55, 0.25) * exp(-abs(dmin - 3.05) * 6.0) * select(0.0, 1.0, b < 0.0) * (0.6 + 0.4 * gain);
  }
  col *= 1.0 - 0.3 * antic;
  return vec4f(col, 1.0);
}
`,
});
