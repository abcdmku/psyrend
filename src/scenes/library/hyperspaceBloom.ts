import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

const morph = new Morph(1);
const KICK_HUE = 0.09;
const lead = { n: -1, cur: 0, prev: 0 };
/** Level-weighted kick hue: the sum of the earlier kicks' levels, and the latest level. */
const kick = { n: -1, sum: 0, last: 0 };
/** An event age (seconds, below 10) with its level packed in hundredths above it. */
const packAge = (age: number, level: number) => Math.min(age, 9.99) + 10 * Math.round(Math.min(1, level) * 100);
const cam = { flow: 0, travel: -1, seed: -1 };

/**
 * Hyperspace Bloom: nested petal whorls over a jewelled bowl. Two framings share one petal language:
 * a tunnel of petal rings the camera glides through, and a dive straight down a steep self-similar
 * (log-polar) funnel whose whorls are born at the heart and flow outward forever. DNA picks the
 * petal family (chrysanthemum, lotus, faceted jewel, pleated fan), framing, fold count, rows per
 * whorl, surface (enamel cloisonne, jewel, light-emitting contours), motion grammar and light rig.
 *
 * The morph flows the petal shape the whole time (width, curl, profile, ridge, pleat, cone tilt and
 * the whorl spacing), and each kick and snare steps it on for good. Flow and spin keep one steady
 * pace. Beats leave the bloom changed, as fronts running through the whorls:
 *  - kick: a front runs from the lens down the tunnel (or up from the funnel's heart), and behind it
 *    the hue has stepped round the wheel;
 *  - snare: a front runs back the other way, firing the rims, and behind it the petals carry a new
 *    count of engraved contour lines;
 *  - melody: a ripple spreads from the whorl set by the pitch, and behind it the petal tips carry
 *    the new note's colour (reached in proportion to the note's strength).
 * Every front's glow and step scales with its event's level and rises over about 0.1 s.
 */

const fract = (x: number) => x - Math.floor(x);
const FOLDS = [
  [12, 14, 16, 18, 20, 24], // chrysanthemum
  [5, 6, 7, 8, 9], // lotus
  [6, 7, 8, 10, 12], // jewel
  [6, 7, 8, 9, 10], // fan
];

export default raymarchScene({
  meta: {
    id: 'hyperspace-bloom',
    name: 'Hyperspace Bloom',
    energy: [0.4, 1],
    mood: { valence: 0.65, arousal: 0.72 },
    genres: { edm: 1, techno: 0.8, dnb: 0.7, dubstep: 0.8, ambient: 0.6, synthwave: 0.4 },
    trails: 0,
    kaleido: false,
    // Petal whorls over ornament tiles still read as a literal flower, not an abstract world.
    auto: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const d = ctx.dna;
    morph.update(m, ctx.dt, d);
    const a = morph.at;
    if (morph.notes !== lead.n) {
      const next = morph.notes > lead.n && lead.n >= 0;
      lead.prev = next ? lead.cur : morph.notePitch;
      // The new colour is reached in proportion to the note's strength.
      lead.cur = lead.prev + (morph.notePitch - lead.prev) * (next ? morph.noteLevel ** 2 : 1);
      lead.n = morph.notes;
    }
    if (morph.kicks !== kick.n) {
      if (morph.kicks > kick.n && kick.n >= 0) kick.sum += kick.last;
      kick.last = morph.kickLevel;
      kick.n = morph.kicks;
    }

    const fam = Math.floor(d[1] * 4) % 4;
    const framing = Math.floor(d[2] * 2) % 2 === 0 ? 0 : 2;
    const folds = FOLDS[fam];
    const n = folds[Math.floor(d[3] * folds.length) % folds.length];
    const rows = 1 + (Math.floor(d[4] * 3) % 3);
    const mat = Math.floor(d[5] * 3) % 3;
    const motion = Math.floor(d[6] * 4) % 4;
    const light = Math.floor(d[7] * 3) % 3;
    const dir = fract(d[6] * 7.3) < 0.5 ? 1 : -1;

    // The petal form flows with the morph (each kick and snare steps it on for good).
    let W: number, curl: number, thick: number, q: number, pw: number, ridge: number, pleat: number;
    if (fam === 0) { W = wave(a[0], 0.08, 0.2); curl = wave(a[1], 0.4, 1.1); thick = 0.026; q = wave(a[2], 0.35, 0.8); pw = wave(a[3], 0.6, 1.2); ridge = wave(a[4], -0.18, 0.05); pleat = 0; }
    else if (fam === 1) { W = wave(a[0], 0.26, 0.5); curl = wave(a[1], 0.2, 0.75); thick = 0.02; q = wave(a[2], 0.7, 1.3); pw = wave(a[3], 0.9, 1.6); ridge = wave(a[4], -0.05, 0.15); pleat = 0; }
    else if (fam === 2) { W = wave(a[0], 0.22, 0.42); curl = wave(a[1], 0.05, 0.5); thick = 0.02; q = 1; pw = 1; ridge = wave(a[4], 0.1, 0.45); pleat = 0; }
    else { W = wave(a[0], 0.3, 0.52); curl = wave(a[1], 0.15, 0.6); thick = 0.018; q = wave(a[2], 0.3, 0.6); pw = wave(a[3], 0.45, 0.9); ridge = 0; pleat = wave(a[5], 0.03, 0.1); }

    // Snare: grammar | snare count | age in hundredths. Pitches of the new and previous note.
    const hund = (x: number) => Math.min(255, Math.floor(x * 100));
    const p8 = (x: number) => Math.round((Math.max(-1, Math.min(1, x)) * 0.5 + 0.5) * 255);
    p[0] = fam; p[1] = framing; p[2] = n; p[3] = rows + 4 * p8(lead.cur) + 1024 * p8(lead.prev);
    // (The snare's level, in 31sts, sits above its age.)
    p[4] = mat; p[5] = motion + 4 * (morph.snares % 8) + 32 * hund(morph.snareAge) + 8192 * Math.round(Math.min(1, morph.snareLevel) * 31); p[6] = light;
    // Hue: the cue's own, a slow drift, and one step per kick by its level (the kick front carries it).
    p[7] = fract(d[0] * 3.1) + 0.08 * Math.sin(a[6]) + (kick.sum + kick.last) * KICK_HUE;
    p[8] = W; p[9] = curl; p[10] = thick; p[11] = q;
    p[12] = pw; p[13] = ridge; p[14] = pleat; p[15] = morph.travel;

    // Flow: tunnel position or self-similar zoom phase, at one steady pace, wrapped by 8 cells so it
    // stays precise (per-cell variation repeats every 8).
    const spin = morph.travel;
    const rot = spin * (0.12 + 0.08 * d[3]) * dir;
    const lnS = framing === 0 ? wave(a[7], 1.0, 1.7) : wave(a[7], 0.26, 0.5);
    const dTr = morph.travel - cam.travel;
    if (d[0] !== cam.seed || dTr < 0 || dTr > 1) { cam.flow = 0; cam.seed = d[0]; }
    else cam.flow += dTr * (framing === 0 ? 3.2 : 0.42);
    cam.travel = morph.travel;
    const wrap = framing === 0 ? 8 * lnS : 8;
    cam.flow = ((cam.flow % wrap) + wrap) % wrap;
    p[16] = cam.flow;
    p[17] = rot;
    // Cone: petal tilt in the tunnel, a steep funnel for the vortex dive.
    p[18] = framing === 0 ? wave(a[5], 0.45, 1.05) : wave(a[5], 1.1, 1.7);
    p[19] = lnS;

    // Camera: a steady glide; nothing moves on the beat.
    let ro: number[], ta: number[], roll: number, fov: number;
    if (framing === 0) {
      const z = cam.flow;
      const ox = 0.3 * Math.sin(spin * 0.5 + d[5] * 6), oy = 0.3 * Math.cos(spin * 0.4 + d[5] * 3);
      ro = [ox, oy, z];
      ta = [ox * 0.2 + 0.3 * Math.sin(spin * 0.3), oy * 0.2, z + 4];
      roll = spin * 0.2 * dir;
      fov = 1.0;
    } else {
      const h = 1.35 + 0.25 * Math.sin(a[6] * 0.7);
      ro = [0.15 * Math.sin(spin * 0.55), 0.15 * Math.cos(spin * 0.45), h];
      ta = [0.04 * Math.sin(spin * 0.7), 0.04 * Math.cos(spin * 0.6), 0];
      roll = spin * 0.3 * dir;
      fov = 0.95;
    }
    p[20] = ro[0]; p[21] = ro[1]; p[22] = ro[2]; p[23] = fov;
    p[24] = ta[0]; p[25] = ta[1]; p[26] = ta[2]; p[27] = roll;
    // Kick age, light gain, emission gain, melody age (each age with its event's level packed above).
    p[28] = packAge(morph.kickAge, morph.kickLevel);
    p[29] = 0.75 + 0.25 * m.energySlow;
    p[30] = 0.6 + 0.6 * ctx.intensity;
    p[31] = packAge(morph.leadAge, morph.noteLevel ** 2);
  },
  wgsl: /* wgsl */ `
struct HbHit { d: f32, mat: f32, s: f32, edge: f32, band: f32, row: f32, cu: f32 };

const HB_KICK_HUE: f32 = 0.09;
fn hb_motion() -> f32 { return fmod(S.p[1].y, 4.0); }
fn hb_rows() -> i32 { return i32(fmod(S.p[0].w, 4.0) + 0.5); }
// Packed music: snare count and age, the new and previous melody pitches (-1..1).
fn hb_snareK() -> f32 { return fmod(floor(S.p[1].y / 4.0), 8.0); }
fn hb_snareAge() -> f32 { return fmod(floor(S.p[1].y / 32.0), 256.0) / 100.0; }
fn hb_snareL() -> f32 { return floor(S.p[1].y / 8192.0) / 31.0; }
// An event age with its level packed in hundredths above it.
fn hb_age(x: f32) -> f32 { return x - 10.0 * floor(x / 10.0); }
fn hb_lvl(x: f32) -> f32 { return floor(x / 10.0) / 100.0; }
fn hb_pitchNew() -> f32 { return fmod(floor(S.p[0].w / 4.0), 256.0) / 255.0 * 2.0 - 1.0; }
fn hb_pitchOld() -> f32 { return floor(S.p[0].w / 1024.0) / 255.0 * 2.0 - 1.0; }

fn hb_width(s: f32) -> f32 {
  let sc = sat(s);
  if (S.p[0].x > 1.5 && S.p[0].x < 2.5) {
    return S.p[2].x * min(sc / 0.42, (1.0 - sc) / 0.58);
  }
  return S.p[2].x * pow(max(sin(PI * pow(sc, S.p[3].x)), 0.0), S.p[2].w);
}

// Petal in its own frame: s along the blade (0 base, 1 tip), v lateral, h height
// above the base plane, L blade length. Returns (distance, edge distance).
fn hb_petal(s: f32, v: f32, h: f32, L: f32, curl: f32) -> vec2f {
  let w = hb_width(s) * L;
  let av = abs(v);
  var surf = curl * s * s * L + S.p[3].y * max(w - av, 0.0);
  if (S.p[3].z > 0.0) {
    surf += S.p[3].z * L * abs(fract(v / L * 7.0) - 0.5) * sat(s * 3.0);
  }
  let th = S.p[2].z * L * (1.0 - 0.6 * sat(s));
  let shell = abs(h - surf) - th;
  let outline = max(av - w, max(-s, s - 1.0) * L);
  return vec2f(max(shell, outline) * 0.55, av - w);
}

fn hb_rowRot(c: f32, j: f32) -> f32 {
  let sector = TAU / S.p[0].z;
  var r = (c + j) * sector * 0.5 + S.p[4].y;
  let par = fmod(c + j, 2.0) * 2.0 - 1.0;
  r += par * select(0.0, S.p[3].w * 0.3, hb_motion() > 0.5 && hb_motion() < 1.5);
  return r;
}

fn hb_rowCurl(c: f32, j: f32) -> f32 {
  var k = S.p[2].y * (1.0 - 0.15 * j);
  if (hb_motion() > 1.5 && hb_motion() < 2.5) {
    // Unfold wave: a ripple of opening runs through the whorls.
    k *= 1.0 + 0.7 * sin(c * 1.3 + j * 0.9 - S.p[3].w * 1.6) * 0.7;
  }
  return k;
}

// Jewel tile relief (0..1) on tile coordinates g.
fn hb_relief(g: vec2f) -> f32 {
  let f = fract(g) - 0.5;
  let dm = abs(f.x) + abs(f.y);
  let sq = max(abs(f.x), abs(f.y));
  let frame = smoothstep(0.49, 0.42, sq);
  let gem = sat((0.4 - dm) * 2.0);
  return frame * 0.45 + gem * 0.55;
}

// Emissive star-polygon glyph inside a tile.
fn hb_glyph(g: vec2f, seed: f32) -> f32 {
  let f = fract(g) - 0.5;
  let a = atan2(f.y, f.x);
  let r = length(f);
  let k = 3.0 + floor(hash11(seed) * 4.0);
  let star = 0.2 + 0.1 * cos(k * a + seed * 6.0);
  let ring = smoothstep(0.025, 0.0, abs(r - 0.3));
  let line = smoothstep(0.03, 0.0, abs(r - star));
  let dot0 = smoothstep(0.07, 0.04, r);
  return max(max(ring * 0.7, line), dot0);
}

fn hb_motionH(s: f32, L: f32) -> f32 {
  if (hb_motion() > 2.5) {
    return 0.03 * L * sin(s * 7.0 - S.p[3].w * 3.0);
  }
  return 0.0;
}

fn hb_mapTunnel(p: vec3f) -> HbHit {
  var res: HbHit;
  let R = 2.2;
  let P = S.p[4].w;
  let r = length(p.xy);
  let ang = atan2(p.y, p.x);
  let sector = TAU / S.p[0].z;
  let rows = hb_rows();
  // Glyph wall.
  let g = vec2f(ang / sector * 2.0, p.z / P * 2.0);
  res.d = (R + 0.05 - r - 0.06 * hb_relief(g)) * 0.7;
  res.mat = 1.0;
  res.band = fract(floor(g.x) * 0.137 + floor(g.y) * 0.29);
  let zc = p.z / P;
  res.cu = zc - 0.5;
  let k = floor(zc);
  let nb = select(k + 1.0, k - 1.0, zc - k < 0.5);
  // Each cell is a flower cup: petals rise from the wall toward the camera at the cone tilt.
  let tilt = S.p[4].z;
  let ca = inverseSqrt(1.0 + tilt * tilt);
  let sa = tilt * ca;
  let Lb = min(1.45, 0.8 * P / sa);
  for (var ci = 0; ci < 2; ci++) {
    let c = select(nb, k, ci == 0);
    let zl = p.z - (c + 0.5) * P;
    for (var j = 0; j < 3; j++) {
      if (j >= rows) { break; }
      let fj = f32(j);
      let rot = hb_rowRot(c, fj);
      let a = fmod(ang + rot + sector * 0.5, sector) - sector * 0.5;
      let uu = r * cos(a);
      let vv = r * sin(a);
      let L = Lb * (1.0 - 0.17 * fj);
      let du = uu - R;
      let dz = zl - P * (0.45 - 0.2 * fj);
      let s = -(du * ca + dz * sa) / L;
      let curl = min(hb_rowCurl(c, fj), 0.3 * P / L);
      let h = du * sa - dz * ca - hb_motionH(s, L);
      let pet = hb_petal(s, vv, h, L, curl);
      if (pet.x < res.d) {
        res.d = pet.x; res.mat = 0.0; res.s = s; res.edge = pet.y / L; res.row = fj; res.cu = c;
        let sid = fmod(floor((ang + rot) / sector + 0.5), S.p[0].z);
        res.band = fract(fmod(c, 8.0) * 0.137 + sid * 0.071 + fj * 0.29);
      }
    }
  }
  return res;
}

fn hb_mapLog(p: vec3f) -> HbHit {
  var res: HbHit;
  let r = length(p.xy);
  let lnS = S.p[4].w;
  let ph = S.p[4].x;
  let cone = S.p[4].z;
  let ca = inverseSqrt(1.0 + cone * cone);
  let sa = cone * ca;
  let sector = TAU / S.p[0].z;
  let rows = hb_rows();
  let ang = atan2(p.y, p.x);
  let rmax = 9.0;
  let u = log(max(r, 1e-4)) / lnS - ph;
  // Jewelled bowl under the petals (scale-invariant tiles).
  let g = vec2f(u * 2.0, ang / sector * 2.0);
  var bowl = ((p.z - cone * r) * ca + 0.22 * r - 0.035 * r * hb_relief(g)) * 0.7;
  bowl = max(bowl, r - rmax);
  res.d = bowl;
  res.mat = 1.0;
  res.cu = u;
  res.band = fract(floor(g.x) * 0.137 + floor(g.y) * 0.29);
  // Core jewel.
  let core = length(p - vec3f(0.0, 0.0, 0.02)) - 0.07;
  if (core < res.d) { res.d = core; res.mat = 2.0; }
  let k = floor(u);
  let nb = select(k + 1.0, k - 1.0, u - k < 0.5);
  let Sx = exp(lnS);
  for (var ci = 0; ci < 2; ci++) {
    let c = select(nb, k, ci == 0);
    let rk = exp((c + ph) * lnS);
    if (rk < 0.045 || rk > rmax * 0.8) { continue; }
    let lr = r / rk;
    let lz = p.z / rk;
    for (var j = 0; j < 3; j++) {
      if (j >= rows) { break; }
      let fj = f32(j);
      let rot = hb_rowRot(c, fj);
      let a = fmod(ang + rot + sector * 0.5, sector) - sector * 0.5;
      let uu = lr * cos(a);
      let vv = lr * sin(a);
      let L = (Sx - 1.0) * (1.3 - 0.25 * fj);
      let dz = lz - cone - (0.06 + 0.07 * fj) * (Sx - 1.0) * 2.0;
      let du = uu - 1.0;
      let along = du * ca + dz * sa;
      let Ls = L / ca;
      let s = along / Ls;
      let h = -du * sa + dz * ca - hb_motionH(s, Ls);
      let pet = hb_petal(s, vv, h, Ls, hb_rowCurl(c, fj));
      let dd = pet.x * rk;
      if (dd < res.d) {
        res.d = dd; res.mat = 0.0; res.s = s; res.edge = pet.y / Ls; res.row = fj; res.cu = c;
        let sid = fmod(floor((ang + rot) / sector + 0.5), S.p[0].z);
        res.band = fract(fmod(c, 8.0) * 0.137 + sid * 0.071 + fj * 0.29);
      }
    }
  }
  return res;
}

fn hb_map(p: vec3f) -> HbHit {
  var h: HbHit;
  if (S.p[0].y < 0.5) { h = hb_mapTunnel(p); } else { h = hb_mapLog(p); }
  // Keep a clear sphere around the lens, carved smoothly.
  h.d = smax(h.d, select(0.5, 0.6, S.p[0].y < 0.5) - length(p - S.p[5].xyz), 0.25);
  return h;
}

fn hb_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * hb_map(p + k.xyy * e).d + k.yyx * hb_map(p + k.yyx * e).d +
                   k.yxy * hb_map(p + k.yxy * e).d + k.xxx * hb_map(p + k.xxx * e).d + vec3f(1e-9));
}

fn hb_core(pos: vec3f, ro: vec3f) -> vec3f {
  if (S.p[0].y < 0.5) { return vec3f(0.0, 0.0, ro.z + 3.5); }
  return vec3f(0.0, 0.0, 0.08);
}

fn hb_lightCol() -> vec3f { return mix(F.pal3.rgb, vec3f(1.0, 0.92, 0.8), 0.35); }

fn hb_env(rd: vec3f, axis: vec3f) -> vec3f {
  let a = sat(dot(rd, axis));
  let hue = S.p[1].w + F.morph2.x * 0.3;
  var c = palL(hue + 0.6 + rd.x * 0.1, 0.012) + palL(hue + 0.2, 0.03) * pow(a, 4.0);
  c += hb_lightCol() * pow(a, 30.0) * 0.4 * S.p[7].y;
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let framing = S.p[0].y;
  let ro = S.p[5].xyz;
  let ta = S.p[6].xyz;
  let roll = S.p[6].w;
  var up = vec3f(sin(roll), cos(roll), 0.0);
  if (framing > 0.5) { up = normalize(vec3f(sin(roll), cos(roll), select(0.0, 2.5, framing < 1.5))); }
  let ww = normalize(ta - ro);
  let uu = normalize(cross(ww, up));
  let vv = cross(uu, ww);
  let rd = normalize(q.x * uu + q.y * vv + S.p[5].w * ww);
  let hue0 = S.p[1].w + F.morph2.x * 0.3;
  // Beat fronts, in whorl-index units. Kick: out from the lens down the tunnel, or up from the
  // vortex's heart; behind it the hue has stepped. Snare: back the other way; behind it the petals
  // carry a new count of engraved contour lines. Melody: a ripple spreading from the whorl set by the
  // pitch; behind it the petal tips carry the new note's colour.
  let kAge = hb_age(S.p[7].x);
  let sAge = hb_snareAge();
  let lAge = hb_age(S.p[7].w);
  // Each front's glow scales with its event's level and rises over about 0.1 s.
  let kAmp = hb_lvl(S.p[7].x) * smoothstep(0.0, 0.1, kAge);
  let sAmp = hb_snareL() * smoothstep(0.0, 0.08, sAge);
  let lAmp = hb_lvl(S.p[7].w) * smoothstep(0.0, 0.12, lAge);
  let pitch01 = hb_pitchNew() * 0.5 + 0.5;
  var cK: f32;
  var cS: f32;
  var cL: f32;
  if (framing < 0.5) {
    cL = (S.p[4].x + 1.6 + 2.8 * pitch01) / S.p[4].w - 0.5;
    cK = (S.p[4].x + 0.3 + kAge * 26.0) / S.p[4].w - 0.5;
    cS = (S.p[4].x + 32.0 - sAge * 32.0) / S.p[4].w - 0.5;
  } else {
    cL = mix(log(1.6), log(0.25), pitch01) / S.p[4].w - S.p[4].x;
    cK = log(0.05) / S.p[4].w - S.p[4].x + kAge * 22.0;
    cS = log(9.0) / S.p[4].w - S.p[4].x - sAge * 22.0;
  }
  let lg = S.p[7].y;
  let eg = S.p[7].z;
  let tunnel = framing < 0.5;
  let axis = select(normalize(-ro), vec3f(0.0, 0.0, 1.0), tunnel);

  let far = select(14.0, 32.0, tunnel);
  let pix = 1.4 / (F.res.y * S.p[5].w);
  var t = 0.02 + ign(frag) * 0.03;
  var hit = false;
  var h: HbHit;
  var glow = 0.0;
  for (var i = 0; i < 110; i++) {
    let pos = ro + rd * t;
    h = hb_map(pos);
    if (h.d < pix * t) { hit = true; break; }
    let st = h.d;
    // Core glow: axis beam (tunnel) or the bloom's heart.
    var dc: f32;
    if (tunnel) {
      dc = length(pos.xy) + 0.3 * (0.5 + 0.5 * sin(pos.z * 2.0 - S.p[3].w * 4.0));
    } else {
      dc = length(pos - vec3f(0.0, 0.0, 0.05)) * 4.0;
    }
    glow += exp(-dc * dc * 3.0) * min(st, 0.3);
    t += st;
    if (t > far) { break; }
  }

  var col = hb_env(rd, axis);
  if (hit) {
    let pos = ro + rd * t;
    let n = hb_normal(pos, max(0.0004, pix * t));
    // Kick: the hue behind the front has stepped on.
    let kx = h.cu - cK;
    let hue = hue0 - HB_KICK_HUE * hb_lvl(S.p[7].x) * smoothstep(-0.25, 0.25, kx);
    let kGlow = exp(-kx * kx * 2.0) * exp(-kAge * 1.6) * kAmp;
    // Snare: behind the front, a new number of engraved contour lines.
    let sx = h.cu - cS;
    let sBehind = sx > 0.0;
    let sGlow = exp(-sx * sx * 8.0) * exp(-sAge * 2.0) * sAmp;
    // Melody: behind the ripple, the new note's colour.
    let lx = abs(h.cu - cL) - lAge * 9.0;
    let lBehind = smoothstep(0.3, -0.3, lx);
    let lGlow = exp(-lx * lx * 3.0) * exp(-lAge * 1.5) * lAmp;
    let leadC = palL(hue + 0.5 + 0.3 * mix(hb_pitchOld(), hb_pitchNew(), lBehind), 1.0);
    let v = -rd;
    let ndv = sat(dot(n, v));
    let refl = reflect(rd, n);
    let fre = pow(1.0 - ndv, 5.0);
    let ao = sat(0.35 + 0.65 * hb_map(pos + n * 0.06).d / 0.06) * sat(0.5 + 0.5 * hb_map(pos + n * 0.2).d / 0.2);
    // Lighting rig.
    let lightSet = S.p[1].z;
    let cp = hb_core(pos, ro);
    let lv0 = cp - pos;
    let ldist = length(lv0);
    let lc = lv0 / ldist;
    var keyDir = normalize(vec3f(0.5, 0.6, 0.7));
    if (tunnel) { keyDir = normalize(vec3f(0.3 * sin(S.p[4].y * 2.0), 0.4, -1.0)); }
    var lDir = lc;
    var lCol = hb_lightCol() * lg * select(2.2 / (1.0 + ldist * ldist * 1.5), 1.6 / (1.0 + ldist * 0.15), tunnel);
    var fillDir = -keyDir;
    var fillCol = palL(hue + 0.5, 0.25) * lg;
    if (lightSet > 0.5 && lightSet < 1.5) {
      lDir = keyDir;
      lCol = hb_lightCol() * lg * 1.1;
      fillDir = lc;
      fillCol = palL(hue + 0.33, 0.5) * lg / (1.0 + ldist * ldist);
    } else if (lightSet > 1.5) {
      // Rim rig: strong backlight against the view, dim headlight.
      lDir = normalize(-ww + vec3f(0.0, 0.0, 0.3) + up * 0.5);
      lCol = palL(hue + 0.1, 0.9) * lg * 1.4;
      fillDir = v;
      fillCol = hb_lightCol() * 0.3 * lg;
    }
    let dif = sat(dot(n, lDir));
    let difF = sat(dot(n, fillDir)) * 0.6 + 0.2;
    let back = sat(dot(-n, lDir));
    let spe = pow(sat(dot(refl, lDir)), 50.0);
    let env = hb_env(refl, axis);
    let mat = S.p[1].x;
    if (h.mat < 0.5) {
      let s = sat(h.s);
      let th = hue + h.row * 0.17 + s * 0.22 + h.band * 0.25;
      if (mat < 0.5) {
        // Enamel cloisonné: saturated glaze, clear coat, gold wire outlines.
        let alb = palL(th, 0.3 + 0.3 * s);
        col = alb * (lCol * dif + fillCol * difF + lCol * back * 0.35) * ao;
        col += (lCol * spe * 0.9 + env * 0.6) * mix(0.04, 1.0, fre);
        let wire = smoothstep(-0.03, -0.012, h.edge) + smoothstep(0.012, 0.0, abs(s - 0.02));
        let gold = mix(vec3f(1.0, 0.75, 0.38), palL(hue + 0.05, 0.6), 0.4);
        let gc = gold * (lCol * (0.25 + 0.75 * pow(sat(dot(refl, lDir)), 12.0)) + env * 3.0 + fillCol * 0.3) * ao;
        col = mix(col, gc, sat(wire));
      } else if (mat < 1.5) {
        // Jewel: dark body, inner glow at grazing angles, sharp facet highlights.
        let alb = palL(th, 0.5);
        let inner = pow(1.0 - ndv, 1.5) * (0.35 + 0.5 * s) + back * 0.6;
        col = alb * (0.14 * dif * lCol + inner * 0.75 * (0.6 + 0.4 * lg)) * ao;
        col += (lCol * spe * 2.2 + env * 2.0) * (0.08 + 0.9 * fre);
        let disp = hsv2rgb(vec3f(fract(fre * 2.0 + h.band + S.p[3].w * 0.05), 0.8, 1.0));
        col += disp * fre * 0.25 * lg;
      } else {
        // Light-emitting contours: dark lacquer, glowing outline rings drifting inward.
        let alb = palL(th, 0.05);
        col = alb * (lCol * dif + fillCol * difF) * ao + env * mix(0.05, 0.6, fre);
        let rings = fract(-h.edge * 14.0 - S.p[3].w * 0.4 + h.row * 0.3);
        let contour = smoothstep(0.12, 0.0, abs(rings - 0.5) - 0.32) * smoothstep(-0.4, -0.02, h.edge);
        let rim = smoothstep(-0.03, 0.0, h.edge);
        let em = palL(th + 0.1, 1.0) * (contour * 0.7 + rim * 0.6) * eg;
        col += em * 0.6;
      }
    } else if (h.mat < 1.5) {
      // Jewelled glyph bowl / wall.
      var g = vec2f(0.0);
      if (tunnel) {
        let sector = TAU / S.p[0].z;
        g = vec2f(atan2(pos.y, pos.x) / sector * 2.0, pos.z / S.p[4].w * 2.0);
      } else {
        let r = length(pos.xy);
        g = vec2f((log(max(r, 1e-4)) / S.p[4].w - S.p[4].x) * 2.0, atan2(pos.y, pos.x) / (TAU / S.p[0].z) * 2.0);
      }
      let gl = hb_glyph(g, floor(g.x) * 3.1 + floor(g.y) * 7.7);
      let alb = palL(hue + 0.55 + h.band * 0.3, 0.1);
      col = alb * (lCol * dif * 0.8 + fillCol * difF) * ao;
      col += (env * 1.5 + lCol * spe) * mix(0.05, 0.8, fre) * ao;
      col += palL(hue + h.band * 0.5 + 0.3, 1.0) * gl * 0.25 * eg * 0.5;
      // The kick front runs through the jewelled tiles.
      col += palL(hue + 0.15, 1.0) * (0.25 + gl) * kGlow * 0.7;
    } else {
      col = mix(hb_lightCol(), palL(hue, 1.0), 0.3) * 2.5 * lg;
    }
    if (h.mat > 0.5 && h.mat < 1.5) { col += leadC * lGlow * select(0.15, 0.3, tunnel) * ao; }
    if (h.mat < 0.5) {
      let s = sat(h.s);
      // Melody: the petal tips carry the note's colour; a glow rides the ripple.
      col += leadC * (0.07 + 1.4 * lGlow) * smoothstep(0.35, 1.0, s) * (0.35 + 0.65 * ndv) * ao;
      // Engraved contour lines; the snare front leaves a new count behind it.
      let k = select(hb_snareK() + 7.0, hb_snareK(), sBehind);
      let nl = 3.0 + fmod(k, 4.0) * 2.0;
      let lines = abs(fract(-h.edge * nl * 2.0 + 0.5) - 0.5);
      let lw = 0.06 + pix * t * nl * 3.0;
      let eng = smoothstep(lw, lw * 0.4, lines) * smoothstep(-0.45, -0.05, h.edge) * sat(1.0 - pix * t * nl * 6.0);
      col += palL(hue + 0.75, 0.25) * eng * (0.4 + 0.6 * ndv) * eg;
      // Front glows: the kick catches the petal tips, the snare fires the rims and the lines.
      col += palL(hue + 0.15, 1.0) * kGlow * 0.7 * s;
      let rim = smoothstep(-0.05, 0.0, h.edge);
      col += mix(palL(hue + 0.75, 1.2), vec3f(1.0), 0.25) * sGlow * (rim + eng) * 1.2;
    }
    let fogK = select(0.08, 0.055, tunnel);
    col = mix(col, hb_env(rd, axis) + palL(hue + 0.4, 0.02), 1.0 - exp(-t * fogK));
  }
  col += mix(hb_lightCol(), palL(hue0 + 0.15, 1.0), 0.5) * glow * select(0.5, 0.12, tunnel) * lg;
  return vec4f(col, 1.0);
}
`,
});
