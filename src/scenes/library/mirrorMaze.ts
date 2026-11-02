import { raymarchScene } from '../raymarchScene';
import type { MusicState } from '../../audio/musicState';
import { Morph } from '../morph';

/**
 * Mirror Maze: a funhouse of mirrors around floating glowing objects, traced
 * with 2-3 true reflection bounces. Walls are analytic planes (or a mirrored
 * sphere), objects are SDFs, every bounce picks up a thin-film tint so the
 * infinite regress shifts hue as it recedes. Mirrors tilt off-parallel with
 * the music so the regress fans and folds.
 * DNA picks the room (cube, hex prism, triangular kaleidoscope, mirrored
 * sphere), object set (orbs, gyroscope rings, polyhedra, a centrepiece),
 * bounce count, lighting (neon panel seams, glowing objects, chrome objects
 * under a spotlight), camera rig, panel size, tilt character and film.
 * Each object listens to a spectrum band, kicks pulse them, hats spark the
 * seams, chords shift the film, anticipation folds the mirrors in and gathers
 * the objects; the drop snaps everything flat and open with a flash.
 *
 * Music: the first object is the melody's voice: it rides up and down with the pitch and
 * flares on every note (eased in, by its strength), so the regress sings with it. Kicks pump the
 * objects and send a ring of light out across the panel seams; snares kick the mirrors off
 * parallel so the regress fans. Orbits and the camera step with the bars and beats.
 */

const fract = (x: number) => x - Math.floor(x);

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
const ev = { kick: { x: 0, v: 0 }, snare: { x: 0, v: 0 }, note: { x: 0, v: 0 }, held: { x: 0, v: 0 }, pitch: { x: 0, v: 0 } };

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
    id: 'mirror-maze',
    name: 'Mirror Maze',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.3, 1],
    mood: { valence: 0.6, arousal: 0.65 },
    genres: { techno: 0.9, edm: 0.9, pop: 0.8, synthwave: 0.9, dnb: 0.4, hiphop: 0.4 },
    trails: 0.2,
  },
  params(ctx, p) {
    const m = ctx.music;
    tickClock(m);
    const d = ctx.dna;
    const e = ctx.evolve;
    const ant = m.anticipation;
    const drop = m.dropPulse;
    const room = Math.floor(d[1] * 4) % 4;
    const objSet = Math.floor(d[2] * 4) % 4;
    const bounces = 2 + (Math.floor(d[3] * 2) % 2);
    const light = Math.floor(d[4] * 3) % 3;
    const rig = Math.floor(d[5] * 4) % 4;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    mo.update(m, ctx.dt, d);
    // Eased envelopes, each scaled by its event's level (which carries the passage's presence). The
    // beats' are x1.6: the eased curve peaks near 0.6 of its target, so a full hit still lands fully.
    const kE = 1.6 * glide(ev.kick, mo.kickLevel * Math.exp(-mo.kickAge / 0.22), dt);
    const sE = 1.6 * glide(ev.snare, mo.snareLevel * Math.exp(-mo.snareAge / 0.35), dt);
    const nE = glide(ev.note, mo.noteLevel * Math.exp(-mo.leadAge / 0.3), dt);
    const held = glide(ev.held, m.leadHeld * mo.presence, dt, 12);
    const pitch = glide(ev.pitch, m.leadPitch, dt, 9);

    // Mirrors fold in with anticipation, lean off parallel on snares, snap flat on the drop.
    const tilt = ((0.02 + 0.07 * d[6]) * (0.6 + 0.8 * e[0]) + 0.07 * sE * sE + 0.16 * ant * ant) * (1 - 0.9 * drop);
    const size = room === 2 ? 1.0 : room === 3 ? 1.05 : 1.0;
    p[0] = room; p[1] = objSet; p[2] = bounces; p[3] = light;
    p[4] = tilt; p[5] = size * (1 - 0.12 * ant + 0.1 * drop); p[6] = fract(d[7] * 3.3) + 0.4 * m.tension; p[7] = fract(d[0] * 2.9) + 0.12 * e[2];

    // Camera inside the room.
    const sp = clk.bar * 0.5;
    const lim = room === 2 ? 0.75 : room === 3 ? 1.6 : 1.9;
    let ro: number[], ta: number[], roll = 0, fov = 1.15;
    if (rig === 0) {
      const a = sp * 0.12 + d[5] * 9;
      ro = [lim * Math.cos(a), 0.25 * Math.sin(sp * 0.17), lim * Math.sin(a)];
      ta = [0, -0.1, 0];
    } else if (rig === 1) {
      ro = [0.12 * Math.sin(sp * 0.2), -1.5, 0.12 * Math.cos(sp * 0.17)];
      ta = [0.25 * Math.sin(sp * 0.11), 2, 0.25 * Math.cos(sp * 0.13)];
      roll = sp * 0.15;
      fov = 0.95;
    } else if (rig === 2) {
      ro = [lim * 0.8 * Math.sin(sp * 0.07), 0.4 * Math.sin(sp * 0.13), lim * 0.8 * Math.cos(sp * 0.05 + 1)];
      const a = sp * 0.09 + d[5] * 5;
      ta = [ro[0] + Math.cos(a), ro[1] + 0.2 * Math.sin(sp * 0.1), ro[2] + Math.sin(a)];
      fov = 1.0;
    } else {
      const a = d[5] * 20 + 0.4 * Math.sin(sp * 0.05);
      ro = [lim * 0.95 * Math.cos(a), -1.3, lim * 0.95 * Math.sin(a)];
      ta = [0, 0.5, 0];
      fov = 1.05;
    }
    p[8] = ro[0]; p[9] = ro[1]; p[10] = ro[2]; p[11] = fov - 0.15 * drop;
    p[12] = ta[0]; p[13] = ta[1]; p[14] = ta[2]; p[15] = roll;
    // Objects: orbit phase (advances on the beats), size (kick pump), gather, count.
    p[16] = sp * 0.35 + clk.beat * 0.04;
    p[17] = (0.85 + 0.3 * e[1]) * (1 + 0.2 * kE + 0.06 * m.kickNext * mo.presence);
    p[18] = Math.min(1, ant * 1.1) * (1 - drop);
    p[19] = objSet === 3 ? 3 : 4 + (Math.floor(d[7] * 3) % 3);
    // Emission gain, seam gain (a chord change swells it smoothly), panel size, seed.
    const chordSwell = 4 * m.chordPulse * (1 - m.chordPulse);
    p[20] = (0.6 + 0.7 * ctx.intensity) * (1 - 0.35 * ant) + 0.5 * drop;
    p[21] = (0.5 + 0.6 * m.energySlow + 0.5 * chordSwell) * (1 - 0.4 * ant) + 0.6 * drop;
    p[22] = 0.7 + 0.6 * fract(d[6] * 4.1);
    p[23] = d[0] * 13.7;
    // Hat, kick seam-ring radius (runs out from the centre after each kick), melody flare (eased,
    // by the note's strength), melody height, kick glow.
    p[24] = m.hat * mo.presence; p[25] = 0.4 + 3.4 * (1 - Math.exp(-mo.kickAge / 0.25)); p[26] = 0.6 * held + 3 * nE; p[27] = pitch;
    p[28] = kE;
  },
  wgsl: /* wgsl */ `
var<private> mm_c: array<vec4f, 6>;
var<private> mm_m: array<mat3x3f, 6>;
var<private> mm_n: i32;
var<private> mm_pl: array<vec4f, 8>;
var<private> mm_np: i32;
var<private> mm_bound: f32;

fn mm_setup() {
  let oset = S.p[0].y;
  let ph = S.p[4].x;
  let sz = S.p[4].y;
  let gather = S.p[4].z;
  mm_n = i32(S.p[4].w);
  mm_bound = 0.0;
  let seed = S.p[5].w;
  for (var i = 0; i < 6; i++) {
    if (i >= mm_n) { break; }
    let fi = f32(i);
    let h = hash33(vec3f(fi * 1.7 + 0.3, seed, fi * 0.37 + 2.0));
    let band = (fi + 0.5) / f32(mm_n) * 0.8 + 0.05;
    let lvl = spec(band);
    var c: vec3f;
    var r: f32;
    if (oset > 2.5) {
      // Centrepiece: a big ring, a core and an orbiting moon.
      if (i == 0) { c = vec3f(0.0); r = 1.05; }
      else if (i == 1) { c = vec3f(0.0); r = 0.38 + 0.12 * lvl; }
      else { c = rotY(ph * 0.9) * vec3f(1.65, 0.35 * sin(ph * 1.3), 0.0); r = 0.2 + 0.08 * lvl; }
    } else {
      let a = fi / f32(mm_n) * TAU + ph * (0.4 + 0.3 * h.x) * select(-1.0, 1.0, h.y > 0.4);
      let rr = 0.9 + 0.7 * h.z;
      c = vec3f(rr * cos(a), (h.y - 0.5) * 1.3 + 0.25 * sin(ph * 0.8 + fi * 2.0), rr * sin(a));
      r = (0.27 + 0.12 * h.x) * (0.9 + 0.35 * lvl);
    }
    c = c * (1.0 - 0.7 * gather) * select(1.0, 0.62, S.p[0].x > 1.5 && S.p[0].x < 2.5);
    if (i == 0) {
      // The melody's voice: rides the pitch up and down and swells on each note.
      c.y = S.p[6].w * select(1.15, 0.75, S.p[0].x > 1.5 && S.p[0].x < 2.5);
      r *= 1.0 + 0.05 * S.p[6].z;
    }
    mm_c[i] = vec4f(c, r * sz);
    let axis = normalize(h * 2.0 - 1.0 + vec3f(0.0, 0.3, 0.0));
    mm_m[i] = rotAxis(axis, ph * (0.6 + 0.8 * h.z) + fi);
    mm_bound = max(mm_bound, length(c) + r * sz * 1.45 + 0.7);
  }
  // Mirror planes (outward normal, offset). The last two are floor and ceiling.
  let room = S.p[0].x;
  let tilt = S.p[1].x;
  let rs = S.p[1].y;
  var nv = 4;
  var R = 3.0;
  if (room > 0.5 && room < 1.5) { nv = 6; R = 3.0; }
  if (room > 1.5) { nv = 3; R = 1.9; }
  let H = 2.3 * rs;
  mm_np = nv + 2;
  for (var i = 0; i < 6; i++) {
    if (i >= nv) { break; }
    let fi = f32(i);
    let a = fi / f32(nv) * TAU + PI * 0.5;
    let n0 = vec3f(cos(a), 0.0, sin(a));
    let tv = vec3f(-sin(a), 0.0, cos(a));
    let w = F.warp * 0.25;
    let n = normalize(n0 + tilt * (tv * sin(fi * 2.3 + w) + vec3f(0.0, 1.0, 0.0) * cos(fi * 1.7 + w * 0.8)));
    mm_pl[i] = vec4f(n, dot(n0 * R * rs, n));
  }
  let w2 = F.warp * 0.2;
  let nf = normalize(vec3f(tilt * 0.5 * sin(w2), -1.0, tilt * 0.5 * cos(w2 * 1.3)));
  mm_pl[nv] = vec4f(nf, dot(vec3f(0.0, -H, 0.0), nf));
  let nc = normalize(vec3f(tilt * 0.7 * cos(w2 * 0.9), 1.0, tilt * 0.7 * sin(w2)));
  mm_pl[nv + 1] = vec4f(nc, dot(vec3f(0.0, H, 0.0), nc));
}

fn mm_twist(q: vec3f, r: f32) -> f32 {
  // Ring with a twisted square cross-section.
  let l = length(q.xz) - r;
  let a = atan2(q.z, q.x);
  let cs = rot2(a * 1.5 + F.warp * 0.4) * vec2f(l, q.y);
  return (max(abs(cs.x), abs(cs.y)) - r * 0.13) * 0.8;
}

fn mm_obj(p: vec3f, i: i32) -> f32 {
  let c = mm_c[i];
  let q = mm_m[i] * (p - c.xyz);
  let oset = S.p[0].y;
  if (oset < 0.5) { return length(p - c.xyz) - c.w; }
  if (oset < 1.5) { return sdTorus(q, vec2f(c.w * 1.25, c.w * 0.22)); }
  if (oset < 2.5) {
    if ((i & 1) == 0) { return sdOcta(q, c.w * 1.35); }
    // Cube frame: fine edges instead of a solid slab.
    let b = c.w * 0.72;
    let e = c.w * 0.06;
    let pq = abs(q) - vec3f(b);
    let qq = abs(pq + vec3f(e)) - vec3f(e);
    return min(min(
      length(max(vec3f(pq.x, qq.y, qq.z), vec3f(0.0))) + min(max(pq.x, max(qq.y, qq.z)), 0.0),
      length(max(vec3f(qq.x, pq.y, qq.z), vec3f(0.0))) + min(max(qq.x, max(pq.y, qq.z)), 0.0)),
      length(max(vec3f(qq.x, qq.y, pq.z), vec3f(0.0))) + min(max(qq.x, max(qq.y, pq.z)), 0.0));
  }
  if (i == 0) { return mm_twist(q, c.w); }
  return length(p - c.xyz) - c.w;
}

fn mm_map(p: vec3f) -> vec2f {
  var d = 1e9;
  var id = 0.0;
  for (var i = 0; i < 6; i++) {
    if (i >= mm_n) { break; }
    let o = mm_obj(p, i);
    if (o < d) { d = o; id = f32(i); }
  }
  return vec2f(d, id);
}

fn mm_normal(p: vec3f) -> vec3f {
  let k = vec2f(1.0, -1.0);
  let e = 0.0015;
  return normalize(k.xyy * mm_map(p + k.xyy * e).x + k.yyx * mm_map(p + k.yyx * e).x +
                   k.yxy * mm_map(p + k.yxy * e).x + k.xxx * mm_map(p + k.xxx * e).x + vec3f(1e-9));
}

fn mm_hue() -> f32 { return S.p[1].w + F.morph2.x * 0.25 + F.chordHue * 0.04; }

fn mm_film(cosT: f32, thick: f32) -> vec3f {
  let ph = thick * (2.2 - 1.2 * cosT);
  let rgb = 0.5 + 0.5 * cos(TAU * (ph * vec3f(1.0, 1.18, 1.38) + vec3f(0.0, 0.2, 0.45)));
  let c = mix(rgb, palL(ph * 0.5 + mm_hue(), 0.6), 0.5);
  return c * (0.75 / max(luma(c), 0.1));
}

// Emission painted on a mirror: panel seams (or lat/long seams on the sphere), floor grid, spotlight.
fn mm_wallEmit(p: vec3f, n: vec3f, wi: i32, isFloor: bool, isCeil: bool) -> vec3f {
  let hue = mm_hue();
  let light = S.p[0].w;
  let g = S.p[5].z;
  var uv: vec2f;
  if (S.p[0].x > 2.5) {
    let dir = normalize(p);
    uv = vec2f(atan2(dir.z, dir.x) / TAU * 16.0, acos(clamp(dir.y, -1.0, 1.0)) / PI * 8.0) * g;
  } else if (isFloor || isCeil) {
    uv = p.xz / g;
  } else {
    let tv = normalize(cross(n, vec3f(0.0, 1.0, 0.0)));
    uv = vec2f(dot(p, tv), p.y) / g;
  }
  let cell = floor(uv);
  let f = abs(fract(uv) - 0.5);
  let seam = smoothstep(0.47, 0.495, max(f.x, f.y));
  let band = fract(cell.x * 0.137 + cell.y * 0.071 + f32(wi) * 0.29);
  let lvl = spec(0.05 + 0.85 * band);
  var e = vec3f(0.0);
  let sg = S.p[5].y;
  var seamAmt = select(0.45, 1.0, light < 0.5) * select(1.0, 0.55, S.p[0].x > 2.5);
  if (light > 0.5 && light < 1.5) { seamAmt = 0.12; }
  e += palL(hue + 0.3 + band * 0.4, 1.0) * seam * seamAmt * sg * (0.25 + 2.5 * lvl * lvl);
  let spark = step(0.985, hash12(cell + floor(F.time * 9.0))) * seam * S.p[6].x;
  e += vec3f(1.0) * spark * 3.0;
  // Kick: a ring of light runs out across the seams from the room's centre.
  let kr = length(p) - S.p[6].y;
  e += palL(hue + 0.45, 1.0) * seam * S.p[7].x * exp(-kr * kr * 6.0) * 4.0;
  if (isFloor) {
    let pool = exp(-dot(p.xz, p.xz) * 0.6);
    e += palL(hue + 0.6, 0.06) * (1.0 - seam) + palL(hue, 0.4) * pool * select(0.15, 1.2, light > 1.5);
  }
  if (isCeil && light > 1.5) {
    e += mix(vec3f(1.0, 0.95, 0.85), F.pal3.rgb, 0.3) * smoothstep(0.62, 0.58, length(p.xz)) * 5.0;
  }
  return e;
}

fn mm_shadeObj(p: vec3f, rd: vec3f, n: vec3f, id: f32) -> vec3f {
  let hue = mm_hue();
  let ndv = sat(dot(n, -rd));
  let band = (id + 0.5) / f32(mm_n) * 0.8 + 0.05;
  let lvl = spec(band);
  let eg = S.p[5].x;
  let light = S.p[0].w;
  let base = palL(hue + id * 0.17 + 0.1, 1.0);
  let sing = mm_sing(id);
  if (light > 0.5 && light < 1.5) {
    // Glowing objects: hot core, glowing rim.
    return base * eg * (0.3 + 1.5 * lvl * lvl + 0.6 * S.p[7].x) * (0.25 + 0.9 * pow(1.0 - ndv, 2.0) + 0.15 * ndv) + mm_singCol() * sing * (0.4 + 0.6 * ndv);
  }
  // Solid satin objects lit by a top light and the seams, rim of emission.
  let L = normalize(vec3f(0.3, 1.0, 0.2));
  let dif = sat(dot(n, L)) * 0.8 + 0.15;
  let alb = palL(hue + id * 0.17 + 0.1, 0.35);
  var c = alb * dif * (0.7 + 0.5 * S.p[5].y);
  c += pow(sat(dot(reflect(rd, n), L)), 40.0) * mix(vec3f(1.0), F.pal3.rgb, 0.3) * 1.5;
  c += base * pow(1.0 - ndv, 3.0) * eg * (0.3 + 2.0 * lvl * lvl);
  c += mm_singCol() * sing * (0.25 + 0.75 * ndv);
  return c;
}

// Melody flare on the first object (zero elsewhere) and its colour (hue follows the pitch).
fn mm_sing(id: f32) -> f32 { return select(0.0, S.p[6].z, id < 0.5); }
fn mm_singCol() -> vec3f { return palL(mm_hue() + 0.5 + 0.15 * S.p[6].w, 1.0); }

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  mm_setup();
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  var ro = S.p[2].xyz;
  let cam = lookAt(ro, S.p[3].xyz, S.p[3].w);
  var rd = normalize(cam * vec3f(q, S.p[2].w));
  let room = S.p[0].x;
  let B = i32(S.p[0].z);
  let light = S.p[0].w;
  let hue = mm_hue();
  let sphR = 3.2 * S.p[1].y;
  var col = vec3f(0.0);
  var thr = vec3f(1.0);
  var jit = ign(frag) * 0.02;
  for (var b = 0; b <= 3; b++) {
    if (b > B) { break; }
    // Nearest mirror.
    var tw = 1e9;
    var wn = vec3f(0.0, 1.0, 0.0);
    var wi = -1;
    if (room < 2.5) {
      for (var i = 0; i < 8; i++) {
        if (i >= mm_np) { break; }
        let pl = mm_pl[i];
        let dn = dot(rd, pl.xyz);
        if (dn > 1e-4) {
          let t = (pl.w - dot(ro, pl.xyz)) / dn;
          if (t > 0.0 && t < tw) { tw = t; wi = i; wn = pl.xyz; }
        }
      }
    } else {
      let bb = dot(ro, rd);
      let cc = dot(ro, ro) - sphR * sphR;
      tw = -bb + sqrt(max(bb * bb - cc, 0.0));
      wi = 0;
      wn = normalize(ro + rd * tw);
      // Tilt: the sphere's mirror is gently dented by the fold.
      wn = normalize(wn + S.p[1].x * 0.6 * vec3f(sin(wn.y * 5.0 + F.warp * 0.3), 0.0, cos(wn.x * 5.0)));
    }
    tw = min(tw, 40.0);
    // Objects along the segment, with a halo glow.
    // Only march inside the objects' bounding sphere (halo margin included).
    let bb0 = dot(ro, rd);
    let bc = dot(ro, ro) - mm_bound * mm_bound;
    let bh = bb0 * bb0 - bc;
    var t = 0.003 + jit;
    var tEnd = -1.0;
    if (bh > 0.0) {
      let sq = sqrt(bh);
      t = max(t, -bb0 - sq + jit);
      tEnd = min(tw, -bb0 + sq);
    }
    jit = 0.0;
    var hit = false;
    var hid = 0.0;
    var glow = 0.0;
    var gid = 0.0;
    if (tEnd > t) {
      let maxS = 64 - 12 * b;
      let eps = 0.0008 * f32(1 + b);
      for (var s = 0; s < 64; s++) {
        if (s >= maxS) { break; }
        let h = mm_map(ro + rd * t);
        if (h.x < eps * (1.0 + t)) { hit = true; hid = h.y; break; }
        let gw = exp(-h.x * 7.0) * min(h.x, 0.25);
        if (gw > glow * 0.5) { gid = h.y; }
        glow += gw;
        t += h.x;
        if (t > tEnd) { break; }
      }
    }
    let gcol = palL(hue + gid * 0.17 + 0.1, 1.0) * S.p[5].x + mm_singCol() * mm_sing(gid) * 0.6;
    col += thr * gcol * glow * select(0.1, 0.22, light > 0.5 && light < 1.5);
    if (hit) {
      let p = ro + rd * t;
      let n = mm_normal(p);
      if (light > 1.5) {
        // Chrome objects: one more bounce off the object.
        let ndv = sat(dot(n, -rd));
        let tint = mix(vec3f(0.9), palL(hue + hid * 0.17 + 0.1, 0.8), 0.5);
        let band = (hid + 0.5) / f32(mm_n) * 0.8 + 0.05;
        col += thr * palL(hue + hid * 0.17, 1.0) * pow(1.0 - ndv, 3.0) * spec(band) * 2.0 * S.p[5].x;
        col += thr * mm_singCol() * mm_sing(hid) * (0.2 + 0.8 * pow(1.0 - ndv, 2.0));
        thr *= tint * (0.55 + 0.4 * pow(1.0 - ndv, 5.0));
        ro = p + n * 0.004;
        rd = reflect(rd, n);
        continue;
      }
      col += thr * mm_shadeObj(p, rd, n, hid);
      thr = vec3f(0.0);
      break;
    }
    // Mirror hit.
    let p = ro + rd * tw;
    let isFloor = room < 2.5 && wi == mm_np - 2;
    let isCeil = room < 2.5 && wi == mm_np - 1;
    col += thr * mm_wallEmit(p, wn, wi, isFloor, isCeil);
    let cosT = sat(-dot(rd, wn));
    var refl = select(select(0.84, 0.72, room > 2.5), 0.5, isFloor);
    thr *= refl * mm_film(cosT, S.p[1].z + f32(b) * 0.37 + f32(wi) * 0.11);
    ro = p - wn * 0.002;
    rd = reflect(rd, wn);
  }
  // Remaining regress fades into a deep palette haze.
  col += thr * palL(hue + 0.6, 0.03);
  return vec4f(col, 1.0);
}
`,
});
