import { raymarchScene } from '../raymarchScene';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * A blocky world traced voxel by voxel with an exact 3D DDA (no SDF smoothing). Five
 * biomes share one column model (solid span, optional second span, water level):
 * floating islands, a terraced canyon, a block city, a crystal cave (true 3D occupancy)
 * and a pixel ocean. Column heights are built from noise plus the spectrum history, and
 * columns pop, extrude or ripple on beats. Faces get Minecraft-style vertex AO from their
 * voxel neighbours and hard sun shadows from a second DDA; the sky has blocky clouds.
 *
 * DNA: 1 biome, 2 voxel size, 3 camera (flyover, orthographic diorama, low glide, orbit),
 * 4 material (textured, emissive edges, glassy, toon), 5 time of day, 6 feature density,
 * 7 beat grammar (pop, spectral extrusion, ripple).
 *
 * Events come from the shared morph and every band is weighted by the passage loudness, so a
 * faint intro motif only glimmers; kicks are their level squared, eased in.
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
const kickFx = new Flare(0.12, 0.3);
/** Beat glow, hats, bass and chord swell, glided so none of them steps. */
const beatS = new Spring(0, 0.05);
const hatS = new Spring(0, 0.1);
const bassS = new Spring(0, 0.15);
const chordS = new Spring(0, 0.1);
export default raymarchScene({
  // Dropped from auto-direction: blocky by construction, the chunky, primitive look the show is
  // moving away from. An unreachable energy range and mood with no genre affinity keep
  // scoreScene() at the bottom of every ranking. Still pinnable by hand.
  meta: {
    id: 'voxel-world',
    name: 'Voxel Realm',
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: -1, arousal: -1 },
    genres: {},
    trails: 0.1,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const e = ctx.evolve;
    p[0] = Math.floor(g[1] * 5); // biome
    p[1] = 0.75 + 1.0 * g[2]; // voxel scale: features measured in voxels
    p[2] = Math.floor(g[3] * 4); // camera
    p[3] = Math.floor(g[4] * 4); // material
    p[4] = Math.floor(g[5] * 4); // time of day
    p[5] = Math.floor(g[7] * 3); // beat grammar
    p[6] = g[0];
    p[7] = g[6];
    p[8] = ctx.travel;
    p[9] = ctx.spin;
    p[10] = m.anticipation;
    p[11] = m.dropPulse;
    p[12] = e[0];
    p[13] = e[1];
    p[14] = e[2];
    p[15] = e[3];
    p[16] = ctx.intensity;
    p[17] = m.beatIndex % 256;
    morph.update(m, ctx.dt, g);
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const pres = morph.presence;
    // S.p[4].zw: kick (eased, level squared), beat glow; S.p[5]: hats, bass, chord swell, loudness.
    p[18] = kickFx.update(morph.kicks, morph.kickAge, morph.kickLevel);
    p[19] = beatS.update(m.beatPulse * pres * pres, dt);
    p[20] = hatS.update(m.hat * pres, dt);
    p[21] = bassS.update(m.bass * pres, dt);
    p[22] = chordS.update(m.chordPulse * pres, dt);
    p[23] = pres;
  },
  wgsl: /* wgsl */ `
struct VxCol { top: f32, bot: f32, top2: f32, bot2: f32, water: f32, kind: f32, seed: f32 };
struct VxHit { t: f32, c: vec3f, n: vec3f, mat: i32, ok: bool };

var<private> vx_focus: vec3f;

fn vx_biome() -> i32 { return i32(S.p[0].x + 0.5); }
fn vx_sc() -> f32 { return S.p[0].y; }
fn vx_cam() -> i32 { return i32(S.p[0].z + 0.5); }
fn vx_matMode() -> i32 { return i32(S.p[0].w + 0.5); }
fn vx_tod() -> i32 { return i32(S.p[1].x + 0.5); }
fn vx_grammar() -> i32 { return i32(S.p[1].y + 0.5); }
fn vx_hue() -> f32 { return S.p[1].z + F.morph2.x * 0.1; }
fn vx_freq() -> f32 { return (0.7 + 0.6 * S.p[1].w) / vx_sc(); }

fn vx_n2(x: vec2f, k: f32) -> f32 { return noise3fast(vec3f(x, k)); }
fn vx_fbm2(x: vec2f, k: f32) -> f32 {
  return vx_n2(x, k) * 0.6 + vx_n2(x * 2.13 + vec2f(5.3, 1.7), k + 7.0) * 0.3 + vx_n2(x * 4.37 + vec2f(1.1, 8.2), k + 13.0) * 0.15;
}

fn vx_pathX(z: f32) -> f32 { let s = vx_sc(); return (sin(z * 0.021 / s) * 16.0 + sin(z * 0.0083 / s + 1.0) * 22.0) * s; }
fn vx_cavePath(z: f32) -> vec2f { let s = vx_sc(); return vec2f(sin(z * 0.028 / s) * 9.0, cos(z * 0.019 / s) * 5.0 + 10.0) * s; }

/** Beat-driven extra height (whole voxels) for a column. */
fn vx_extra(xz: vec2f) -> f32 {
  let g = vx_grammar();
  let s = vx_sc();
  if (g == 0) {
    let hc = hash12(xz * 0.913 + vec2f(S.p[4].y * 3.1, 0.0));
    return floor((S.p[4].z * 4.0 + S.p[4].w) * step(hc, 0.05 + 0.04 * F.energy) * s);
  }
  if (g == 1) {
    let d = length(xz - vx_focus.xz);
    let band = abs(fract(xz.x / (48.0 * s)) * 2.0 - 1.0) * 0.85 + 0.04;
    return floor(S.p[5].w * hist(band, sat(d / (70.0 * s))) * 7.0 * s * (1.0 + S.p[2].w));
  }
  let d = length(xz - vx_focus.xz);
  let R = F.beatPhase * 40.0 * s;
  return floor((2.5 * S.p[4].w + 2.0 * S.p[4].z) * s * exp(-(d - R) * (d - R) / (9.0 * s * s)));
}

fn vx_col(xz: vec2f) -> VxCol {
  var c: VxCol;
  c.top = -1e9; c.bot = -1e9; c.top2 = -1e9; c.bot2 = -1e9; c.water = -1e9; c.kind = 0.0; c.seed = 0.0;
  let b = vx_biome();
  let s = vx_sc();
  let fq = vx_freq();
  let f = (xz + 0.5) * fq * 0.05;
  if (b == 0) {
    // Floating islands: flat-topped tops, conical undersides, two layers.
    let m1 = vx_fbm2(f * 0.8, 2.0) - 0.08;
    if (m1 > 0.0) {
      c.top = floor((2.0 + 5.0 * vx_n2(f * 3.0, 4.0)) * s + vx_extra(xz));
      c.bot = c.top - floor(sqrt(m1) * 34.0 * s + 2.0);
    }
    let m2 = vx_fbm2(f * 0.7 + vec2f(3.7, 9.1), 5.0) - 0.22;
    if (m2 > 0.0) {
      c.top2 = floor((24.0 + 4.0 * vx_n2(f * 2.0, 6.0)) * s + vx_extra(xz));
      c.bot2 = c.top2 - floor(sqrt(m2) * 22.0 * s + 2.0);
    }
    c.kind = 0.0;
    c.water = floor(-30.0 * s + 1.5 * sin(xz.x * 0.08 + F.time) + vx_extra(xz));
  } else if (b == 1) {
    // Canyon: terraced walls around a winding river.
    let d = abs(xz.x - vx_pathX(xz.y));
    let wall = smoothstep(5.0 * s, 16.0 * s, d + 4.0 * s * vx_n2(f * 2.0, 3.0));
    var h = -2.0 + wall * (20.0 + 9.0 * vx_fbm2(f, 1.0)) * s;
    h = floor(h / (2.0 * s + 1.0)) * (2.0 * s + 1.0) + floor(2.0 * vx_n2(f * 6.0, 2.0));
    c.top = h + vx_extra(xz);
    c.bot = -1e9;
    c.water = 0.0;
    c.kind = 1.0;
  } else if (b == 2) {
    // Block city: 14-voxel blocks of four lots, 3-voxel streets.
    let B = floor(12.0 * s + 2.0);
    let bi = floor(xz / B);
    let l = xz - bi * B;
    let street = 5.0;
    if (l.x < street || l.y < street) {
      c.top = 0.0;
      c.kind = 2.0;
      let li = floor(l);
      c.seed = select(0.0, 1.0, (li.x == 2.0 && fract(xz.y / 4.0) < 0.5) || (li.y == 2.0 && fract(xz.x / 4.0) < 0.5));
    } else {
      let lot = floor((l - street) / ((B - street) * 0.5));
      let hs = hash13(vec3f(bi * 2.0 + lot, S.p[1].w * 17.0));
      let band = fract(hs * 3.7);
      let H = floor((4.0 + 22.0 * hs * hs * (0.6 + 0.8 * S.p[1].w)) * s * (0.6 + 0.6 * S.p[5].w * hist(band * 0.8 + 0.05, 0.1))) + vx_extra(bi * B);
      c.top = max(H, 1.0);
      c.kind = 3.0;
      c.seed = hs;
    }
    c.bot = -1e9;
  } else if (b == 4) {
    // Pixel ocean: islands poke out of a blocky sea whose swell follows the bass.
    let land = vx_fbm2(f * 0.7, 8.0);
    c.top = floor((land * 22.0 - 3.0) * s);
    c.bot = -1e9;
    let sw = 0.6 * sin(xz.x * 0.11 / s + F.time * 1.3) + 0.4 * sin(xz.y * 0.07 / s - F.time * 0.9 + xz.x * 0.03);
    let band = fract(abs(xz.x) / (60.0 * s));
    c.water = floor(1.0 + sw * (0.6 + 1.2 * S.p[5].y) * s + S.p[5].w * hist(band, sat(length(xz - vx_focus.xz) / (80.0 * s))) * 2.0 * s + vx_extra(xz));
    c.kind = 4.0;
  }
  return c;
}

fn vx_occCol(c: vec3f, col: VxCol) -> i32 {
  let y = c.y;
  let b = vx_biome();
  if (y < col.top && y >= col.bot) {
    if (b == 2) {
      if (col.kind > 2.5) {
        // Building: emissive windows on a regular grid.
        let wv = fract(y / 3.0) > 0.3 && fract((c.x + c.z) / 2.0) > 0.4 && y < col.top - 1.0;
        let lit = hash13(c + vec3f(col.seed * 31.0)) < 0.2 + 0.35 * F.energySlow + 0.25 * S.p[2].w;
        return select(6, 5, wv && lit);
      }
      return select(3, 5, c.y == -1.0 && col.seed > 0.5);
    }
    let dt = col.top - y;
    return select(select(3, 2, dt <= 3.0 * vx_sc()), 1, dt <= 1.0);
  }
  if (y < col.top2 && y >= col.bot2) {
    let dt = col.top2 - y;
    return select(select(3, 2, dt <= 3.0), 1, dt <= 1.0);
  }
  if (y < col.water && y >= col.top) { return 4; }
  return 0;
}

fn vx_occCave(c: vec3f) -> i32 {
  let s = vx_sc();
  let pc = vx_cavePath(c.z);
  let fq = vx_freq();
  let n = noise3fast(c * fq * 0.12);
  let r = (7.0 + 3.5 * n) * s + 2.0 * S.p[5].y * s;
  let d = length(c.xy - pc);
  let cav = noise3fast(c * fq * 0.05 + vec3f(7.0)) > 0.25;
  if (d < r || cav) { return 0; }
  let h = hash13(c);
  // Crystals pulse in rings travelling down the tunnel on the beat.
  let ring = fract(c.z / (24.0 * s) - F.beatPhase * 0.5);
  if (h < 0.025 + 0.05 * spec(fract(h * 40.0)) + 0.08 * step(0.92, ring) * S.p[4].w) { return 5; }
  return select(3, 2, n > 0.2);
}

fn vx_occ(c: vec3f) -> i32 {
  if (vx_biome() == 3) { return vx_occCave(c); }
  return vx_occCol(c, vx_col(c.xz));
}

fn vx_slab() -> vec2f {
  let s = vx_sc();
  let b = vx_biome();
  if (b == 0) { return vec2f(-40.0 * s, 40.0 * s); }
  if (b == 1) { return vec2f(-3.0, 40.0 * s); }
  if (b == 2) { return vec2f(-1.0, 40.0 * s); }
  if (b == 4) { return vec2f(-6.0 * s, 20.0 * s); }
  return vec2f(-1e6, 1e6);
}

/** Exact voxel DDA. Returns the first solid cell and the face normal it was entered through. */
fn vx_trace(ro0: vec3f, rd: vec3f, steps: i32, tmax: f32) -> VxHit {
  var h: VxHit;
  h.ok = false; h.t = tmax; h.c = vec3f(0.0); h.n = vec3f(0.0, 1.0, 0.0); h.mat = 0;
  let sl = vx_slab();
  // Clip the ray to the occupied slab.
  var t0 = 0.0;
  var t1 = tmax;
  if (abs(rd.y) > 1e-5) {
    let ta = (sl.x - ro0.y) / rd.y;
    let tb = (sl.y - ro0.y) / rd.y;
    t0 = max(t0, min(ta, tb));
    t1 = min(t1, max(ta, tb));
  } else if (ro0.y < sl.x || ro0.y > sl.y) { return h; }
  if (t0 >= t1) { return h; }
  let ro = ro0 + rd * t0;
  let rs = select(rd, vec3f(1e-6), abs(rd) < vec3f(1e-6));
  let st = sign(rs);
  let inv = 1.0 / rs;
  let tD = abs(inv);
  var c = floor(ro + rd * 1e-4);
  var tM = (c + max(st, vec3f(0.0)) - ro) * inv;
  var n = vec3f(0.0, -st.y, 0.0);
  var t = 0.0;
  let cave = vx_biome() == 3;
  var col: VxCol;
  var lastXZ = vec2f(1e9);
  let tl = t1 - t0;
  for (var i = 0; i < steps; i++) {
    var m = 0;
    if (cave) { m = vx_occCave(c); } else {
      if (any(c.xz != lastXZ)) { col = vx_col(c.xz); lastXZ = c.xz; }
      m = vx_occCol(c, col);
    }
    if (m > 0) {
      h.ok = true; h.t = t0 + t; h.c = c; h.n = n; h.mat = m;
      return h;
    }
    if (tM.x < tM.y && tM.x < tM.z) {
      t = tM.x; c.x += st.x; tM.x += tD.x; n = vec3f(-st.x, 0.0, 0.0);
    } else if (tM.y < tM.z) {
      t = tM.y; c.y += st.y; tM.y += tD.y; n = vec3f(0.0, -st.y, 0.0);
    } else {
      t = tM.z; c.z += st.z; tM.z += tD.z; n = vec3f(0.0, 0.0, -st.z);
    }
    if (t > tl) { break; }
  }
  h.t = t0 + t;
  return h;
}

fn vx_solid(c: vec3f) -> f32 { let m = vx_occ(c); return select(0.0, 1.0, m > 0 && m != 4); }

fn vx_sunDir() -> vec3f {
  let tod = vx_tod();
  let a = S.p[3].z * 1.5 + 0.6;
  let el = select(select(select(0.5, 0.12, tod == 0), 0.95, tod == 1), 0.35, tod == 2);
  return normalize(vec3f(cos(a) * cos(el), sin(el), sin(a) * cos(el)));
}

fn vx_sky(rd: vec3f, ro: vec3f) -> vec3f {
  let tod = vx_tod();
  let hz = vx_hue();
  let sd = vx_sunDir();
  let y = rd.y;
  var horizon: vec3f;
  var zenith: vec3f;
  if (tod == 0) { horizon = palL(hz + 0.05, 0.5); zenith = palL(hz + 0.55, 0.06); }
  else if (tod == 1) { horizon = palL(hz + 0.5, 0.45); zenith = palL(hz + 0.55, 0.16); }
  else if (tod == 2) { horizon = palL(hz + 0.6, 0.03); zenith = palL(hz + 0.6, 0.004); }
  else { horizon = palL(hz + 0.8, 0.22); zenith = palL(hz + 0.3, 0.025); }
  var col = mix(horizon, zenith, pow(sat(y * 1.6 + 0.05), 0.6));
  let sdot = dot(rd, sd);
  let sunCol = select(palL(hz + 0.1, 1.0), vec3f(0.8, 0.85, 1.0), tod == 2);
  // Square pixel sun.
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), sd));
  let upv = cross(sd, right);
  let sp = abs(vec2f(dot(rd, right), dot(rd, upv)));
  let sq = step(max(sp.x, sp.y), 0.035) * step(0.0, sdot);
  col = mix(col, sunCol * select(3.0, 1.5, tod == 2), sq);
  col += sunCol * pow(sat(sdot), 16.0) * select(0.2, 0.04, tod == 2) * (1.0 + 0.5 * S.p[2].z);
  if (tod == 2) {
    let sc = rd * 220.0;
    let hs = hash13(floor(sc));
    col += vec3f(0.9) * step(0.997, hs) * smoothstep(0.0, 0.3, y) * (0.5 + S.p[5].x);
  }
  // Blocky cloud layer.
  if (y > 0.0 && vx_biome() != 3) {
    let cy = 60.0 * vx_sc();
    let tc = (cy - ro.y) / y;
    if (tc > 0.0) {
      let cp = (ro.xz + rd.xz * tc) / (7.0 * vx_sc()) + vec2f(F.time * 0.15, 0.0);
      let cl = noise3fast(vec3f(floor(cp) * 0.17, 3.0)) + 0.4 * noise3fast(vec3f(floor(cp) * 0.5, 9.0));
      let cover = step(0.25 - 0.2 * F.energySlow, cl) * smoothstep(0.0, 0.12, y);
      let cc = mix(palL(hz + 0.5, select(0.6, 0.02, tod == 2)), sunCol * 0.4, 0.3);
      col = mix(col, cc, cover * 0.85);
    }
  }
  return col;
}

fn vx_matColor(m: i32, c: vec3f, n: vec3f) -> vec3f {
  let hz = vx_hue();
  let j = 0.85 + 0.3 * hash13(c * 1.37);
  let b = vx_biome();
  if (m == 1) { return palL(hz + select(0.3, 0.0, b == 4), 0.3) * j; }
  if (m == 2) { return palL(hz + 0.15, 0.13) * j; }
  if (m == 3) { return palL(hz + 0.55 + 0.05 * sin(c.y * 0.7), 0.09 + 0.04 * fract(c.y * 0.37)) * j; }
  if (m == 6) { return palL(hz + 0.6 + 0.2 * fract(c.x * 0.013), 0.08) * j; }
  return palL(hz, 0.2);
}

fn vx_shade(h: VxHit, ro: vec3f, rd: vec3f, pxA: f32) -> vec3f {
  let p = ro + rd * h.t;
  let n = h.n;
  let c = h.c;
  let hz = vx_hue();
  let tod = vx_tod();
  let mm = vx_matMode();
  // Face axes and coordinates.
  let an = abs(n);
  var tu = vec3f(1.0, 0.0, 0.0);
  var tv = vec3f(0.0, 0.0, 1.0);
  if (an.x > 0.5) { tu = vec3f(0.0, 0.0, 1.0); tv = vec3f(0.0, 1.0, 0.0); }
  else if (an.z > 0.5) { tu = vec3f(1.0, 0.0, 0.0); tv = vec3f(0.0, 1.0, 0.0); }
  let fu = fract(dot(p, tu));
  let fv = fract(dot(p, tv));
  // Vertex AO from the eight neighbours in front of the face.
  let fc = c + n;
  let s1 = vx_solid(fc + tu); let s2 = vx_solid(fc - tu);
  let s3 = vx_solid(fc + tv); let s4 = vx_solid(fc - tv);
  let c1 = vx_solid(fc + tu + tv); let c2 = vx_solid(fc - tu + tv);
  let c3 = vx_solid(fc + tu - tv); let c4 = vx_solid(fc - tu - tv);
  let a11 = select(3.0 - s1 - s3 - c1, 0.0, s1 + s3 > 1.5);
  let a01 = select(3.0 - s2 - s3 - c2, 0.0, s2 + s3 > 1.5);
  let a10 = select(3.0 - s1 - s4 - c3, 0.0, s1 + s4 > 1.5);
  let a00 = select(3.0 - s2 - s4 - c4, 0.0, s2 + s4 > 1.5);
  let ao = mix(mix(a00, a10, fu), mix(a01, a11, fu), fv) / 3.0;
  let aoF = 0.25 + 0.75 * ao;
  // Sun shadow by a second DDA.
  let sd = vx_sunDir();
  var sh = 0.0;
  let ndl = dot(n, sd);
  if (ndl > 0.0) {
    let sh0 = vx_trace(p + n * 0.01, sd, 40, 60.0 * vx_sc());
    sh = select(1.0, 0.0, sh0.ok);
  }
  let sunCol = select(select(palL(hz + 0.1, 1.6), vec3f(1.3, 1.3, 1.25), tod == 1), palL(hz + 0.6, 0.35), tod == 2);
  let skyAmb = select(select(palL(hz + 0.5, 0.35), palL(hz + 0.55, 0.45), tod == 1), palL(hz + 0.6, 0.11), tod == 2);
  let m = h.mat;
  var alb = vx_matColor(m, c, n);
  if (m == 1 && n.y < 0.5) {
    // Grass overhang on the side of top blocks.
    alb = mix(vx_matColor(2, c, n), alb, step(0.75, fv) * select(1.0, 0.0, an.y > 0.5));
  }
  var em = vec3f(0.0);
  let lvl = spec(fract(hash13(c * 0.71) * 0.9));
  if (m == 5) {
    let pulse = select(1.0, 0.55, vx_biome() == 2) * (0.5 + 1.5 * lvl + 1.2 * S.p[4].z * step(0.6, hash13(c + 3.0)) + 0.8 * S.p[5].z + 1.0 * S.p[2].w);
    em = palL(hz + 0.35 + 0.3 * hash13(c), 1.2) * pulse * (1.0 - 0.5 * S.p[2].z);
    alb = vec3f(0.05);
  }
  // Pixel texture (8x8 texels per face).
  let tex = 0.82 + 0.3 * hash13(floor(vec3f(fu, fv, 0.0) * 8.0) + c * 8.0 + n * 3.0);
  var lit = alb * (sunCol * max(ndl, 0.0) * sh + skyAmb * (0.55 + 0.45 * n.y) * aoF);
  var col = vec3f(0.0);
  let edgeD = min(min(fu, 1.0 - fu), min(fv, 1.0 - fv));
  let foot = h.t * pxA;
  if (mm == 0) {
    col = lit * tex * (0.85 + 0.15 * aoF) + em;
  } else if (mm == 1) {
    // Emissive edges: dark faces, glowing outlines on open edges.
    let ew = max(0.05, foot * 1.2);
    var e = 0.0;
    e = max(e, max(1.0 - vx_solid(c + tu), s1 * 0.4) * sat(1.0 - (1.0 - fu) / ew));
    e = max(e, max(1.0 - vx_solid(c - tu), s2 * 0.4) * sat(1.0 - fu / ew));
    e = max(e, max(1.0 - vx_solid(c + tv), s3 * 0.4) * sat(1.0 - (1.0 - fv) / ew));
    e = max(e, max(1.0 - vx_solid(c - tv), s4 * 0.4) * sat(1.0 - fv / ew));
    let wave = pow(fract(c.y * 0.08 - F.time * 0.5 + c.x * 0.01), 6.0);
    col = lit * 0.35 + em + palL(hz + 0.15 * f32(m) + 0.2 * hash13(c), 0.6 + 2.5 * wave * lvl + 0.8 * S.p[4].w) * e * (0.05 / max(ew, 0.05));
  } else if (mm == 2) {
    // Glassy: fresnel sky reflection plus tinted inner glow, darker where thick.
    let fre = 0.06 + 0.94 * pow(1.0 - sat(dot(n, -rd)), 4.0);
    let r = reflect(rd, n);
    let inner = palL(hz + 0.12 * f32(m), 0.12) * (0.4 + 0.6 * aoF) * (0.6 + 0.4 * sh) * (1.0 + 2.0 * lvl * lvl);
    col = inner + vx_sky(r, p) * fre * 0.8 + em + sunCol * pow(sat(dot(r, sd)), 60.0) * sh * 2.0;
    col += palL(hz + 0.3, 0.5) * sat(1.0 - edgeD / max(0.03, foot)) * 0.3;
  } else {
    // Toon: flat face-orientation shading with dark pixel outlines.
    let face = select(select(0.55, 0.75, an.z > 0.5), 1.0, n.y > 0.5);
    let tl = select(0.6, 1.0, sh > 0.5 || ndl <= 0.0);
    col = alb * (sunCol * 0.45 + skyAmb) * face * tl * (0.6 + 0.4 * aoF) + em;
    col *= mix(0.25, 1.0, smoothstep(0.0, max(0.04, foot), edgeD));
  }
  if (m == 4) {
    // Water: reflective, depth-tinted, foam on the crests.
    let fre = 0.1 + 0.9 * pow(1.0 - sat(dot(n, -rd)), 5.0);
    let r = reflect(rd, n);
    let deep = palL(hz + 0.55, 0.05) * (0.6 + 0.4 * aoF);
    col = deep + min(vx_sky(r, p), vec3f(0.8)) * fre * 0.9 + sunCol * pow(sat(dot(r, sd)), 80.0) * 0.8;
    let wl = spec(fract(c.x * 0.013) * 0.8 + 0.05);
    col += palL(hz + 0.4 + 0.3 * fract(c.x * 0.013), 0.9) * step(0.94, hash13(c + floor(F.time * 4.0))) * (0.3 * S.p[5].x + 1.5 * wl * wl + 0.5 * S.p[4].w) * aoF;
  }
  return col;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let s = vx_sc();
  let cam = vx_cam();
  let b = vx_biome();
  let ev = F.evolve;
  let tr = S.p[2].x;
  let antic = S.p[2].z;
  let drop = S.p[2].w;
  var ro: vec3f;
  var fwd: vec3f;
  var ortho = false;
  var fov = 1.5;
  // Forward path through the biome.
  let z = tr * 4.0 * s;
  var px = 0.0;
  var py = 30.0 * s;
  if (b == 1) { px = vx_pathX(z); py = 8.0 * s; }
  else if (b == 2) { px = floor(12.0 * s + 2.0) * 3.0 + 2.5; py = 18.0 * s; }
  else if (b == 3) { let cp = vx_cavePath(z); px = cp.x; py = cp.y; }
  else if (b == 4) { py = 12.0 * s; }
  else { py = 34.0 * s; }
  vx_focus = vec3f(px, 0.0, z + 25.0 * s);
  if (cam == 0 || b == 3) {
    // Flyover / cave flight along the path.
    let dz = 6.0 * s;
    var ax = px;
    var ay = py + ev.x * 6.0 * s;
    if (b == 1) { ax = vx_pathX(z + dz); }
    if (b == 3) { let cp = vx_cavePath(z + dz); ax = cp.x; ay = cp.y; }
    ro = vec3f(px, ay - select(0.0, ev.x * 6.0 * s, b == 3), z);
    fwd = normalize(vec3f(ax - px + sin(S.p[2].y * 0.1) * 0.15 * dz, select(-0.25 - 0.15 * ev.y, 0.0, b == 3) * dz, dz));
    fov = 1.35;
  } else if (cam == 1) {
    // Orthographic diorama, slowly orbiting.
    ortho = true;
    let a = S.p[2].y * 0.05 + ev.z * 2.0 + 0.785;
    fwd = normalize(vec3f(cos(a), -0.75 - 0.25 * ev.y, sin(a)));
    ro = vec3f(px, select(0.0, 6.0 * s, b == 0), z) - fwd * 300.0;
  } else if (cam == 2) {
    // Low glide skimming just above the surface.
    var gy = py * 0.45;
    if (b == 1) { gy = 3.0 * s + 1.5; }
    if (b == 2) { gy = 3.5 + 3.0 * ev.x; }
    if (b == 4) { gy = 5.0 * s; }
    if (b == 0) { gy = 13.0 * s; }
    ro = vec3f(px + sin(F.time * 0.3) * select(2.0 * s, 0.4, b == 2), gy, z);
    let ax = select(px, vx_pathX(z + 8.0 * s), b == 1);
    fwd = normalize(vec3f((ax - px) / (8.0 * s) + sin(S.p[2].y * 0.13) * 0.2, 0.02 + 0.08 * ev.y, 1.0));
    fov = 1.2;
  } else {
    // Perspective orbit around a point ahead.
    let a = S.p[2].y * 0.08 + ev.z * 3.0;
    let R = 40.0 * s * (0.8 + 0.4 * ev.x);
    let ctr = vec3f(px, 0.0, z);
    ro = ctr + vec3f(cos(a) * R, 32.0 * s + 12.0 * s * ev.y + select(0.0, 8.0 * s, b == 0), sin(a) * R);
    fwd = normalize(ctr + vec3f(0.0, 4.0 * s, 0.0) - ro);
    fov = 1.6;
  }
  let uu = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let vv = cross(uu, fwd);
  var rd: vec3f;
  var pxA: f32;
  if (ortho) {
    let W = 34.0 * s * (1.0 - 0.15 * antic + 0.1 * drop);
    ro += (q.x * uu + q.y * vv) * W;
    rd = fwd;
    pxA = 0.0;
  } else {
    fov *= 1.0 + 0.1 * antic - 0.1 * drop;
    rd = normalize(q.x * uu + q.y * vv + fov * fwd);
    pxA = 2.0 / (F.res.y * fov);
  }
  let tmax = select(150.0 * s, 700.0, ortho);
  let h = vx_trace(ro, rd, select(150, 190, ortho), tmax);
  var col: vec3f;
  let tod = vx_tod();
  var bgDir = rd;
  if (ortho) { bgDir = normalize(fwd * 0.6 + q.x * uu * 0.5 + (q.y + 0.6) * vv * 0.7); }
  let fogC = select(vx_sky(normalize(vec3f(bgDir.x, 0.02, bgDir.z)), ro), palL(vx_hue() + 0.6, 0.015), b == 3);
  if (h.ok) {
    var pa = pxA;
    if (ortho) { pa = 2.0 * 34.0 * s / F.res.y / max(h.t, 1.0); }
    col = vx_shade(h, ro, rd, pa);
    let dist = select(h.t, h.t - 300.0 + 15.0 * s, ortho);
    let fd = select(0.012, 0.03, b == 3) / s * (1.0 + 0.8 * antic);
    col = mix(col, fogC, 1.0 - exp(-max(dist, 0.0) * fd));
    if (b == 3) { col += palL(vx_hue() + 0.4, 0.04) * exp(-h.t * 0.05 / s) * S.p[4].w; }
  } else {
    col = select(vx_sky(bgDir, ro), fogC, b == 3);
  }
  col *= 1.0 - 0.25 * antic;
  col += palL(vx_hue() + 0.2, 0.25) * drop * drop * exp(-length(q) * 1.5);
  return vec4f(col, 1.0);
}
`,
});
