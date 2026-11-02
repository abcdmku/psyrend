import { raymarchScene } from '../raymarchScene';

/**
 * Bioluminescent jellyfish drifting through deep water. Bells are translucent
 * shells (several layers composited front to back) that contract on the beat,
 * oral arms ripple as frilled ribbons, tentacles are glowing filaments with
 * light pulses running down them. Marine snow and depth haze give scale.
 *
 * DNA: species (moon jelly, box jelly, comb jelly with travelling rainbow
 * cilia, siphonophore chain), count, bell shape and tentacle length, camera
 * (hero orbit, drift through a swarm, looking up at the surface, side track),
 * depth light (sunlit surface, twilight, abyss), pulse grammar (synchronised,
 * staggered wave, slow breathing), hue and arrangement.
 */
export default raymarchScene({
  // Dropped from auto-direction: creatures floating in a void that the camera orbits; the
  // user called it "dumb" and saw it too often. An unreachable energy range and mood with no genre
  // affinity keep scoreScene() at the bottom of every ranking. Still available when pinned by hand.
  meta: {
    id: 'jellyfish-bloom',
    name: 'Jellyfish Bloom',
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: -1, arousal: -1 },
    genres: {},
    trails: 0.45,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const species = Math.floor(g[1] * 4) % 4;
    const camMode = Math.floor(g[4] * 4) % 4; // 0 hero orbit, 1 drift, 2 look up, 3 side track
    const light = Math.floor(g[5] * 3) % 3; // 0 sunlit, 1 twilight, 2 abyss
    const grammar = Math.floor(g[6] * 3) % 3; // 0 sync, 1 staggered, 2 breathing
    let count = 1 + Math.floor(g[2] * 6.99);
    if (species === 3) count = Math.min(count, 4);
    const antic = m.anticipation;
    const drop = m.dropPulse;
    const sp = ctx.spin;

    let ro: number[];
    let ta: number[];
    let fov = 1.5;
    if (camMode === 0) {
      const a = sp * 0.12 + g[7] * 6.28;
      const d = (species === 3 ? 6.2 : 4.0) - 0.5 * m.energySlow + 0.6 * drop;
      const h = 0.4 + 1.2 * Math.sin(sp * 0.07 + g[3] * 4);
      ro = [Math.cos(a) * d, h - (species === 3 ? 1.5 : 0.3), Math.sin(a) * d];
      ta = [0, species === 3 ? -1.6 : -0.4, 0];
      fov = 1.6;
    } else if (camMode === 1) {
      const z = ctx.travel * 0.25;
      ro = [Math.sin(z * 0.13) * 2, Math.sin(z * 0.09) * 1.2, z];
      ta = [Math.sin((z + 4) * 0.13) * 2, Math.sin((z + 4) * 0.09) * 1.2 - 0.3, z + 4];
      fov = 1.35;
    } else if (camMode === 2) {
      const a = sp * 0.05;
      ro = [Math.cos(a) * 1.5, -5.5, Math.sin(a) * 1.5];
      ta = [Math.sin(sp * 0.03) * 1.5, 2, Math.cos(sp * 0.04) * 1.5];
      fov = 1.2;
    } else {
      const x = ctx.travel * 0.2;
      ro = [x, 0.2 + Math.sin(sp * 0.06) * 0.8, -6.5];
      ta = [x + 1.2, 0, 0];
      fov = 1.5;
    }
    p[0] = ro[0]; p[1] = ro[1]; p[2] = ro[2]; p[3] = fov * (1 + 0.12 * antic);
    p[4] = ta[0]; p[5] = ta[1]; p[6] = ta[2]; p[7] = Math.sin(sp * 0.05 + g[7] * 3) * 0.12;
    p[8] = species; p[9] = count; p[10] = light; p[11] = grammar;
    // bell shape, tentacle length, spread box, seed
    p[12] = g[3];
    p[13] = Math.min(1, 0.35 + 0.65 * ((g[3] * 3.7 + g[7]) % 1)) * (1 - 0.35 * antic) + 0.1 * ev[1];
    p[14] = count <= 2 ? 7 : 9.5;
    p[15] = g[7];
    // hue, contraction drive, glow gain, fog density
    p[16] = g[0] * 0.8 + 0.2 * ev[3];
    const pulse = grammar === 0 ? m.kick * 0.95 + 0.25 * m.kickNext : grammar === 2 ? 0.35 * m.kick : 0.6 + 0.4 * m.energySlow;
    p[17] = Math.min(1, pulse) * (1 - 0.3 * drop) + 0.7 * antic;
    p[18] = (0.9 + 0.6 * ctx.intensity + 0.5 * m.kick + 1.4 * drop + 0.5 * m.chordPulse) * (1 - 0.45 * antic);
    p[19] = [0.11, 0.13, 0.08][light] * (1 + 0.5 * antic) * (camMode === 1 ? 1.15 : 1);
    // anticipation, drop, snow, hat
    p[20] = antic; p[21] = drop; p[22] = 0.6 + 0.6 * m.high + 1.5 * drop; p[23] = m.hat;
    // camMode, rise phase, sway amount, snare
    p[24] = camMode;
    p[25] = ctx.travel * 0.08 + ev[0] * 2;
    p[26] = 0.6 + 1.2 * m.mid + 0.4 * m.lowMid + 0.4 * m.tension;
    p[27] = m.snare;
    p[28] = ev[2]; p[29] = m.bass; p[30] = 0; p[31] = 0;
  },
  wgsl: /* wgsl */ `
struct JfH { d: f32, g: f32, id: i32, part: f32 };

var<private> jf_c: array<vec4f, 7>;   // centre, scale
var<private> jf_m: array<mat3x3f, 7>; // world -> local rotation
var<private> jf_k: array<vec4f, 7>;   // contraction, hash, fade, band
var<private> jf_n: i32;
var<private> jf_lt: f32;

fn jf_setup(ro: vec3f) {
  jf_n = i32(S.p[2].y);
  let camMode = S.p[6].x;
  let B = S.p[3].z;
  let grammar = S.p[2].w;
  let drive = S.p[4].y;
  let species = S.p[2].x;
  jf_lt = 0.9 + 2.6 * S.p[3].y;
  for (var i = 0; i < 7; i++) {
    if (i >= jf_n) { break; }
    let fi = f32(i);
    let h = hash33(vec3f(fi * 3.17 + 1.3, S.p[3].w * 41.0 + 7.1, fi * 0.73));
    var sc = select(mix(0.75, 1.35, h.z), 1.4, jf_n == 1);
    if (species > 2.5) { sc *= 1.1; }
    var c = (h - 0.5) * B * vec3f(1.0, 0.6, 1.0);
    if (i == 0 && camMode < 0.5) { c = vec3f(0.0); sc = select(1.15, 1.0, species > 2.5); }
    // Slow ascent and lateral drift.
    let rise = S.p[6].y * (0.5 + h.x) * select(1.0, 0.0, i == 0 && camMode < 0.5);
    c += vec3f(sin(F.time * 0.07 + h.y * 6.0) * 0.6, rise * 2.0, cos(F.time * 0.05 + h.x * 6.0) * 0.6);
    var fade = 1.0;
    if (i == 0 && camMode > 0.5) {
      // A guide jelly keeps company with the camera.
      let fw = normalize(S.p[1].xyz - ro);
      let sd = normalize(cross(fw, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(fw.y) > 0.8)));
      c = ro + fw * (4.2 + 0.8 * sin(F.time * 0.05)) + sd * sin(F.time * 0.11 + h.x * 6.0) * 1.1 + vec3f(0.0, 0.4 + 0.3 * sin(F.time * 0.09), 0.0);
      sc = max(sc, 1.0);
    }
    if (i > 0) {
      // Wrap into a box around the camera so the swarm never runs out.
      let ctr = ro + normalize(S.p[1].xyz - ro) * B * 0.42;
      let rel = fmod3(c - ctr + B * 0.5, vec3f(B)) - B * 0.5;
      c = ctr + rel;
      let rc = c - ro;
      let edge = max(abs(rel.x), max(abs(rel.y), abs(rel.z)));
      fade = smoothstep(B * 0.5, B * 0.5 - 2.0, edge) * smoothstep(1.4, 3.0, length(rc));
    }
    // Contraction: synchronised kick, staggered wave over two beats, or slow breathing.
    var k = drive;
    if (grammar > 0.5 && grammar < 1.5) {
      let ph = fract(F.beatPhase * 0.5 + h.x);
      k = drive * pow(1.0 - ph, 5.0);
    } else if (grammar > 1.5) {
      k = 0.5 + 0.5 * sin(F.time * (1.2 + 0.6 * h.y) + h.x * TAU);
      k = k * k * 0.7 + drive;
    }
    k = sat(k + S.p[5].x * 0.6);
    let tilt = (h.y - 0.5) * 0.7 + sin(F.time * 0.3 + h.z * 9.0) * 0.12;
    let axis = normalize(vec3f(cos(h.x * TAU), 0.0, sin(h.x * TAU)));
    jf_m[i] = rotAxis(axis, tilt) * rotY(h.z * TAU + F.time * 0.1 * (h.y - 0.5));
    jf_c[i] = vec4f(c, sc);
    jf_k[i] = vec4f(k, h.x, fade, fract((fi + 0.5) / f32(jf_n) * 0.8 + h.y * 0.2));
  }
}

fn jf_seg(q: vec3f, xr: f32, zr: f32, y0: f32, y1: f32) -> f32 {
  let cy = clamp(q.y, y1, y0);
  return length(vec3f(q.x - xr, q.y - cy, q.z - zr));
}

// Moon jelly: shallow scalloped dome, four frilled oral arms, a fringe of fine tentacles.
fn jf_moon(p: vec3f, c: f32, hh: f32) -> vec3f {
  let R = 1.0 - 0.2 * c;
  let H = 0.38 + 0.2 * c + 0.18 * S.p[3].x;
  let rho = length(p.xz);
  let ang = atan2(p.z, p.x);
  let y = p.y + rho * rho * (0.1 + 0.3 * c);
  let rr = R * (1.0 + 0.03 * cos(ang * 8.0));
  let e = length(vec2f(rho / rr, y / H));
  let shell = abs((e - 1.0) * min(rr, H)) - 0.025;
  let bell = max(shell, -0.02 - y);
  // Oral arms.
  let a4 = fmod(ang + PI * 0.25, PI * 0.5) - PI * 0.25;
  let q = vec3f(rho * cos(a4), p.y, rho * sin(a4));
  let La = 0.7 + 0.8 * S.p[3].y;
  let s = sat(-q.y / La);
  let fr = (sin(q.y * 13.0 + F.time * 2.2 + q.x * 22.0) * 0.045 + sin(q.y * 4.0 - F.time * 0.9 + hh * 6.0) * 0.07) * s;
  let wid = 0.1 * (1.0 - 0.5 * s) + 0.02;
  let arm = max(max(abs(q.z - fr) - 0.012, abs(q.x - 0.13 - 0.06 * s + fr * 0.5) - wid), max(q.y + 0.05, -q.y - La)) * 0.6;
  // Rim tentacles (radial sway keeps the polar repetition valid).
  let nt = 28.0;
  let sec = TAU / nt;
  let tid = floor(ang / sec + 0.5);
  let at = ang - tid * sec;
  let tq = vec3f(rho * cos(at), y + 0.02, rho * sin(at));
  let dep = max(-tq.y, 0.0);
  let lt = jf_lt * (0.55 + 0.45 * hash11(tid + hh * 30.0));
  let xr = rr * 0.98 + sin(dep * 2.3 - F.time * 1.4 + tid * 1.7) * 0.07 * dep * S.p[6].z - dep * 0.08 * c;
  let tent = jf_seg(tq, xr, 0.0, 0.0, -lt);
  return vec3f(min(bell, arm), tent, select(0.0, 1.0, arm < bell));
}

// Box jelly: rounded cube bell, four long tentacle bundles from the corners.
fn jf_box(p: vec3f, c: f32, hh: f32) -> vec3f {
  let w = 0.5 * (1.0 - 0.18 * c);
  let H = 0.55 + 0.15 * c + 0.2 * S.p[3].x;
  let rho = length(p.xz);
  let y = p.y - H * 0.4 + rho * rho * 0.2 * c;
  let b = sdBox(vec3f(p.x, y, p.z), vec3f(w * 0.75, H * 0.55, w * 0.75)) - 0.3 - 0.08 * sat(y / H);
  let shell = abs(b) - 0.022;
  let bell = max(shell, -(y + H * 0.55));
  // Bundles at the corners.
  let ang = atan2(p.z, p.x) + PI * 0.25;
  let a4 = fmod(ang + PI * 0.25, PI * 0.5) - PI * 0.25;
  let q = vec3f(rho * cos(a4), y + H * 0.55, rho * sin(a4));
  let dep = max(-q.y, 0.0);
  var tent = 1e9;
  let lt = jf_lt * 1.5;
  for (var j = 0; j < 3; j++) {
    let fj = f32(j) - 1.0;
    let xr = (w + 0.12) * 1.25 + fj * 0.05 + sin(dep * 1.6 - F.time * 1.1 + fj * 2.0 + hh * 5.0) * 0.1 * dep * S.p[6].z * 0.5;
    tent = min(tent, jf_seg(q, xr, fj * 0.04 + sin(dep * 2.0 + fj) * 0.03, 0.0, -lt * (0.85 + 0.1 * fj)));
  }
  return vec3f(bell, tent, 0.0);
}

// Comb jelly: lobed ovoid body; comb rows are painted at shading time.
fn jf_comb(p: vec3f, c: f32, hh: f32) -> vec3f {
  let rho = length(p.xz);
  let ang = atan2(p.z, p.x);
  let pul = 1.0 + 0.06 * c;
  let r = vec3f(0.6, 1.0 + 0.25 * S.p[3].x, 0.6) * pul;
  let lob = 1.0 + 0.05 * cos(ang * 8.0) * smoothstep(1.0, 0.2, abs(p.y));
  let q = vec3f(p.x / lob, p.y, p.z / lob);
  let e = length(q / r);
  let shell = abs((e - 1.0) * 0.6) - 0.02;
  // Two trailing tentacles with side branches.
  let sx = select(-1.0, 1.0, p.x > 0.0);
  let tq = vec3f(abs(p.x), p.y + 0.2, p.z);
  let dep = max(-tq.y, 0.0);
  let lt = jf_lt * 1.3;
  let xr = 0.45 + dep * 0.25 + sin(dep * 1.8 - F.time * 1.2 + sx * 2.0) * 0.12 * dep * S.p[6].z * 0.4;
  var tent = jf_seg(tq, xr, sin(dep * 1.3 + F.time * 0.7) * 0.15 * dep, 0.0, -lt);
  // Fine side branches.
  let bd = fract(dep * 3.0) - 0.5;
  tent = min(tent, length(vec2f(bd * 0.33, tq.z - sin(dep * 1.3 + F.time * 0.7) * 0.15 * dep)) + max(abs(tq.x - xr) - 0.12, 0.0) + select(9.0, 0.0, dep > 0.2 && dep < lt));
  return vec3f(shell, tent, 2.0);
}

// Siphonophore: a swimming bell cluster on a long glowing stem with beads.
fn jf_siph(p: vec3f, c: f32, hh: f32) -> vec3f {
  let y = p.y;
  let dep = max(-y, 0.0);
  let sw = S.p[6].z * 0.5;
  let off = vec2f(sin(y * 0.7 + F.time * 0.6 + hh * 6.0) * 0.4 * sat(dep / 3.0) * sw, cos(y * 0.55 + F.time * 0.45) * 0.3 * sat(dep / 3.0) * sw);
  let q = vec3f(p.x - off.x, y, p.z - off.y);
  // Nectophores: alternating bells along the top of the stem.
  let cell = 0.36;
  let idn = clamp(floor(q.y / cell + 0.5), -4.0, 0.0);
  let ly = q.y - idn * cell;
  let sd = select(-1.0, 1.0, fmod(idn, 2.0) > 0.5);
  let br = 0.2 * (1.0 - 0.15 * c) * (1.0 - 0.06 * idn);
  let bq = vec3f(q.x - sd * 0.16, ly, q.z);
  let shell = abs(length(bq * vec3f(1.0, 0.85 + 0.2 * c, 1.0)) - br) - 0.014;
  let bell = max(shell, -(sd * bq.x) - 0.06);
  // Stem and beads further down.
  let L = 2.5 + jf_lt * 1.4;
  let stem = jf_seg(q, 0.0, 0.0, -1.3, -L);
  let bdy = fract(q.y / 0.42) - 0.5;
  let bead = length(vec3f(q.x, bdy * 0.42, q.z)) - 0.045 * (1.0 + 0.6 * c) + select(9.0, 0.0, q.y < -1.4 && q.y > -L);
  // Short fishing filaments off each bead.
  let fil = length(vec2f(bdy * 0.42 + 0.1, q.z)) + max(abs(q.x - 0.15 * sin(F.time + q.y)) - 0.2, 0.0) + select(9.0, 0.0, q.y < -1.4 && q.y > -L);
  return vec3f(bell, min(min(stem, fil), bead + 0.02), 3.0);
}

fn jf_one(pl: vec3f, i: i32) -> vec3f {
  let sp = S.p[2].x;
  let k = jf_k[i];
  if (sp < 0.5) { return jf_moon(pl, k.x, k.y); }
  if (sp < 1.5) { return jf_box(pl, k.x, k.y); }
  if (sp < 2.5) { return jf_comb(pl, k.x, k.y); }
  return jf_siph(pl, k.x, k.y);
}

fn jf_local(p: vec3f, i: i32) -> vec3f { return jf_m[i] * ((p - jf_c[i].xyz) / jf_c[i].w); }

fn jf_map(p: vec3f) -> JfH {
  var r: JfH;
  r.d = 1e9; r.g = 1e9; r.id = -1; r.part = 0.0;
  let sp = S.p[2].x;
  let top = select(1.0, 0.6, sp > 2.5);
  let bot = select(jf_lt * 1.6 + 0.4, 2.5 + jf_lt * 1.4, sp > 2.5);
  for (var i = 0; i < 7; i++) {
    if (i >= jf_n) { break; }
    let s = jf_c[i].w;
    let pl = jf_local(p, i);
    let bnd = (length(vec3f(pl.x, pl.y - clamp(pl.y, -bot, top), pl.z)) - 1.5) * s;
    if (bnd > 0.3) {
      if (bnd < r.d) { r.d = bnd; }
      if (bnd < r.g) { r.g = bnd; }
      continue;
    }
    let h = jf_one(pl, i) * s;
    if (h.x < r.d) { r.d = h.x; r.id = i; r.part = h.z / s; }
    if (h.y < r.g) { r.g = h.y; if (r.id < 0 || h.y < r.d) { r.id = i; } }
  }
  return r;
}

fn jf_surf(p: vec3f, i: i32) -> f32 { return jf_one(jf_local(p, i), i).x * jf_c[i].w; }

fn jf_normal(p: vec3f, i: i32) -> vec3f {
  let e = 0.004 * jf_c[i].w;
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * jf_surf(p + k.xyy * e, i) + k.yyx * jf_surf(p + k.yyx * e, i) +
                   k.yxy * jf_surf(p + k.yxy * e, i) + k.xxx * jf_surf(p + k.xxx * e, i));
}

fn jf_hue() -> f32 { return S.p[4].x + F.morph2.x * 0.2 + F.chordHue * 0.06; }

fn jf_jellyCol(i: i32, lum: f32) -> vec3f {
  return palL(jf_hue() + jf_k[i].w * 0.35, lum);
}

fn jf_water(rd: vec3f) -> vec3f {
  let light = S.p[2].z;
  let hue = jf_hue();
  let up = rd.y;
  var c = palRampL(0.2 + 0.2 * sat(up), 0.018 + 0.012 * sat(up));
  if (light < 0.5) {
    c += palL(hue + 0.55, 0.05) * pow(sat(up * 0.5 + 0.5), 4.0);
    // Snell's window overhead.
    let win = smoothstep(0.9, 0.93, up);
    let rays = 0.75 + 0.25 * sin(atan2(rd.z, rd.x) * 11.0 + F.time * 0.3) * sin(atan2(rd.z, rd.x) * 7.0 - F.time * 0.2);
    c += mix(palL(hue + 0.5, 0.16), vec3f(0.6, 0.85, 1.0) * 0.16, 0.4) * win * rays * (0.6 + 0.4 * smoothstep(0.93, 1.0, up));
    c += palL(hue + 0.45, 0.12) * exp(-abs(up - 0.91) * 60.0);
  } else if (light < 1.5) {
    c += palL(hue + 0.6, 0.04) * exp(-abs(up - 0.15) * 4.0);
    c += palL(hue + 0.3, 0.012) * sat(-up);
  } else {
    c *= 0.9;
  }
  return c;
}

fn jf_snow(ro: vec3f, rd: vec3f, tmax: f32) -> vec3f {
  var acc = vec3f(0.0);
  // Slice along the dominant ray axis.
  let ad = abs(rd);
  var ax = 2;
  if (ad.x > ad.y && ad.x > ad.z) { ax = 0; } else if (ad.y > ad.z) { ax = 1; }
  let r3 = select(select(rd.zxy, rd.yzx, ax == 1), rd, ax == 2);
  let o3 = select(select(ro.zxy, ro.yzx, ax == 1), ro, ax == 2);
  let spc = 0.7;
  let dir = sign(r3.z);
  let z0 = floor(o3.z / spc) * spc;
  for (var k = 1; k <= 10; k++) {
    let zk = z0 + dir * f32(k) * spc;
    let tk = (zk - o3.z) / r3.z;
    if (tk <= 0.0 || tk > tmax) { continue; }
    let pp = o3 + r3 * tk;
    let gs = 0.4;
    let fall = vec2f(0.0, F.time * 0.04);
    let qq = pp.xy + fall * select(0.0, 1.0, ax == 2);
    let cell = floor(qq / gs);
    let h = hash33(vec3f(cell, zk * 3.17 + f32(ax) * 13.0));
    if (h.z > 0.3) { continue; }
    let mp = (cell + 0.2 + 0.6 * h.xy) * gs;
    let dd = length(qq - mp);
    let size = 0.006 + 0.006 * h.y + 0.001 * tk;
    let fade = exp(-tk * 0.16) * smoothstep(0.2, 1.0, tk);
    acc += palL(jf_hue() + 0.5 + h.x * 0.2, 0.5) * exp(-dd * dd / (size * size)) * fade * (0.25 + 0.6 * F.hat * step(0.7, h.x));
  }
  return acc * S.p[5].z;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[0].xyz;
  let cam = lookAt(ro, S.p[1].xyz, S.p[1].w);
  let rd = normalize(cam * vec3f(q, S.p[0].w));
  jf_setup(ro);
  let sp = S.p[2].x;
  let light = S.p[2].z;
  let hue = jf_hue();
  let glowGain = S.p[4].z;
  let fogD = S.p[4].w;
  let antic = S.p[5].x;
  let drop = S.p[5].y;
  let Lsun = normalize(vec3f(0.2, 1.0, 0.1));
  let sunAmt = select(select(0.0, 0.25, light < 1.5), 1.0, light < 0.5);

  var col = vec3f(0.0);
  var T = 1.0;
  var t = 0.05 + ign(frag) * 0.08;
  let far = 26.0;
  var layers = 0;
  var glow = vec3f(0.0);
  for (var it = 0; it < 120; it++) {
    let p = ro + rd * t;
    let h = jf_map(p);
    if (h.id >= 0) {
      let i = h.id;
      let pl = jf_local(p, i);
      let lt = jf_lt;
      let dep = sat(-pl.y / (lt * 1.8 + 0.5));
      // Light pulses travel down the tentacles after each kick.
      let pulseY = (1.0 - F.kick) * 1.4;
      let pulse = exp(-pow((dep - pulseY) * 6.0, 2.0)) * F.kick;
      let band = jf_k[i].w;
      let lvl = spec(0.05 + 0.85 * band);
      let gw = exp(-h.g * 55.0 / jf_c[i].w) * (0.12 + 0.9 * lvl + 2.5 * pulse) * (1.0 - 0.6 * dep);
      let ds = min(h.d, max(h.g, 0.02));
      glow += jf_jellyCol(i, 1.0) * gw * min(ds, 0.1) * jf_k[i].z * exp(-t * fogD * 0.6) * T;
    }
    if (h.d < 0.0015 * t + 0.001 && h.id >= 0) {
      let i = h.id;
      let n0 = jf_normal(p, i);
      let n = select(n0, -n0, dot(n0, rd) > 0.0);
      let pl = jf_local(p, i);
      let fres = pow(1.0 - sat(dot(n, -rd)), 2.2);
      let k = jf_k[i];
      let band = k.w;
      let lvl = spec(0.05 + 0.85 * band);
      let rho = length(pl.xz);
      let ang = atan2(pl.z, pl.x);
      var em = vec3f(0.0);
      let base = jf_jellyCol(i, 0.12);
      if (sp < 0.5) {
        if (h.part < 0.5) {
          // Gonad horseshoes, radial canals, rim dots.
          let a4 = fmod(ang + PI * 0.25, PI * 0.5) - PI * 0.25;
          let gq = vec2f(rho * cos(a4) - 0.32, rho * sin(a4));
          let ring = abs(length(gq) - 0.13);
          em += jf_jellyCol(i, 0.9) * exp(-ring * 45.0) * (0.4 + 1.2 * lvl) * smoothstep(0.0, 0.2, pl.y + 0.1);
          let can = abs(sin(ang * 8.0));
          em += jf_jellyCol(i, 0.25) * exp(-can * rho * 30.0) * smoothstep(0.2, 0.9, rho);
          let rimDot = exp(-abs(rho - 0.97) * 30.0) * exp(-abs(sin(ang * 4.0)) * 6.0);
          em += palL(hue + 0.4, 2.0) * rimDot * (0.3 + F.hat * 2.0);
        } else {
          em += jf_jellyCol(i, 0.12) * (0.2 + lvl) * (0.3 + fres);
        }
      } else if (sp < 1.5) {
        let edgeL = pow(fres, 1.5);
        em += jf_jellyCol(i, 0.6) * edgeL * (0.5 + lvl);
        let eyes = exp(-length(vec2f(abs(pl.x) - 0.5, pl.y - 0.1)) * 18.0) * exp(-abs(abs(pl.z) - 0.5) * 2.0);
        em += palL(hue + 0.5, 1.0) * eyes;
      } else if (sp < 2.5) {
        // Eight comb rows of beating cilia scattering a travelling rainbow.
        let a8 = fmod(ang + PI / 8.0, PI / 4.0) - PI / 8.0;
        let row = exp(-abs(a8 * rho) * 40.0) * smoothstep(0.95, 0.4, abs(pl.y) / (1.0 + 0.25 * S.p[3].x));
        let wave = 0.5 + 0.5 * sin(pl.y * 26.0 - F.time * (5.0 + 8.0 * F.high) + ang * 2.0);
        let rb = hsv2rgb(vec3f(fract(pl.y * 0.8 - F.time * 0.4 + ang / TAU + hue), 0.85, 1.0));
        let rc = mix(rb, palL(hue + pl.y * 0.3, 1.0), 0.35);
        em += rc * row * (0.3 + 1.6 * wave * wave) * (0.5 + lvl + F.hat * 1.5);
        em += jf_jellyCol(i, 0.08) * (1.0 - fres) * smoothstep(0.6, 0.0, rho);
      } else {
        em += jf_jellyCol(i, 0.5) * pow(fres, 1.3) * (0.6 + lvl);
        em += palL(hue + 0.15, 0.4) * exp(-abs(pl.y) * 2.0) * 0.3;
      }
      let sun = palL(hue + 0.5, 0.35) * sat(dot(n, Lsun)) * sunAmt;
      var lc = base * fres * 1.2 + em * glowGain + sun * (0.03 + 0.6 * fres);
      // Kick flash of bioluminescence and drop burst.
      lc += jf_jellyCol(i, 0.6) * fres * (0.4 * F.kick + 1.5 * drop);
      // Snare: a ring of light runs down the bell.
      lc += jf_jellyCol(i, 1.2) * S.p[6].w * exp(-abs(pl.y + (1.0 - S.p[6].w) * 0.8) * 14.0);
      let fogA = exp(-t * fogD);
      col += T * lc * k.z * fogA;
      let opac = select(0.1 + 0.45 * fres, 0.05 + 0.3 * fres, sp > 0.5 && sp < 1.5);
      T *= 1.0 - opac * k.z;
      layers++;
      if (layers >= 4 || T < 0.05) { break; }
      t += 0.035 * jf_c[i].w + 0.01;
      continue;
    }
    let st = min(h.d, max(h.g, 0.025));
    t += max(st * 0.9, 0.004 * t);
    if (t > far) { break; }
  }
  t = min(t, far);
  let water = jf_water(rd);
  col += T * water;
  col += glow * glowGain * 1.0;
  // God rays for the sunlit setting: shafts along a few long strides.
  if (sunAmt > 0.2) {
    var sh = 0.0;
    let dt = min(t, 16.0) / 6.0;
    for (var k = 0; k < 6; k++) {
      let tk = (f32(k) + ign(frag + 3.0)) * dt;
      let pp = ro + rd * tk;
      let spp = pp.xz - Lsun.xz * (pp.y / Lsun.y);
      let n = sat(noise3fast(vec3f(spp * 0.35, F.time * 0.04)) * 0.9 + 0.4);
      sh += n * n * n * n * dt * exp(-tk * 0.1) * smoothstep(-8.0, 4.0, pp.y);
    }
    col += mix(palL(hue + 0.5, 1.0), vec3f(0.5, 0.8, 1.0), 0.4) * sh * 0.012 * sunAmt * (1.0 - 0.5 * antic);
  }
  col += jf_snow(ro, rd, t);
  col *= 1.0 - 0.35 * antic;
  return vec4f(col, 1.0);
}
`,
});
