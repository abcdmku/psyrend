import { raymarchScene } from '../raymarchScene';
import { GENRES } from '../../audio/types';

// Integrated rotation so anticipation can spin the object faster without the
// angle jumping when the speed changes.
let mbYaw = 0;
let mbPitch = 0;

const fract = (x: number) => x - Math.floor(x);
const pick = (g: number, n: number) => Math.min(n - 1, Math.floor(g * n));
const ease = (x: number) => x * x * (3 - 2 * x);

// Power ranges per variant: [low, high] that F.morph glides between.
const POWER_SETS: readonly [number, number][] = [
  [3.5, 6.5],
  [6, 10],
  [4, 8],
  [7.5, 9.5],
  [4, 5.5],
];
// Mandelbox scales (negative ones are organic, positive ones architectural).
const BOX_SCALES = [-1.55, -1.8, -2.1, 2.0, 2.3] as const;
// Quaternion Julia seeds known to give rich, connected shapes.
const QJ_SEEDS: readonly [number, number, number, number][] = [
  [-0.291, -0.399, 0.339, 0.437],
  [-0.2, 0.4, -0.4, -0.4],
  [-0.213, -0.041, -0.563, -0.56],
  [-0.125, -0.256, 0.847, 0.0895],
  [-0.08, 0.0, -0.83, -0.035],
];

/**
 * An orbit around a morphing 3D fractal. DNA picks:
 *  0 construction: Mandelbulb, Julia bulb, Mandelbox or quaternion Julia
 *  1 camera rig: orbit, macro skim, pole view, telephoto dolly
 *  2 material: trap-coloured stone, porcelain, neon contours, gilded metal
 *  3 lighting: key + fill, top spotlight, rim backlight
 *  4 shape parameters (power set, abs-fold, box scale, Julia seed)
 *  5 beat grammar: kick rings from the core, beat swell of the formula, bar-stepped turns
 *  6 trap colour mapping, 7 backdrop (nebula, studio, void).
 * Power glides with sections and chords and snaps on drops, spectrum bands glow on
 * trap contours and anticipation contracts and spins the object.
 */
export default raymarchScene({
  // DROPPED from auto-direction: an object floating in a void, not a place you are inside.
  // An impossible energy range, an unreachable mood and zero genre affinity keep scoreScene
  // near zero, so the director never ranks it; it stays available when pinned by hand.
  meta: {
    id: 'mandelbulb-bloom',
    name: 'Mandelbulb Bloom',
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: 0.5, arousal: 3 },
    genres: Object.fromEntries(GENRES.map((id) => [id, 0])),
    trails: 0.3,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const ant = m.anticipation;
    const drop = m.dropPulse;
    const fam = pick(g[0], 4);
    const rig = pick(g[1], 4);
    const mat = pick(g[2], 4);
    const light = pick(g[3], 3);
    const motion = pick(g[5], 3);
    const bg = pick(g[7], 3);
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const dir = Math.floor(g[1] * 11) % 2 ? 1 : -1;
    mbYaw += dt * dir * (0.1 + 0.2 * m.energySlow + 1.3 * ant + 0.9 * drop);
    mbPitch += dt * (0.04 + 0.08 * m.arousal + 0.35 * ant);
    const barTurn = motion === 2 ? (m.barIndex + ease(m.barPhase)) * 0.55 * dir : 0;
    const swell = motion === 1 ? m.beatPulse * m.beatPulse : 0;

    const set = POWER_SETS[pick(g[4], POWER_SETS.length)];
    // S.p[0]: power low, power high, scale, drop snap (+ beat swell)
    p[0] = set[0];
    p[1] = set[1];
    p[2] = 1 - 0.24 * ant + 0.22 * drop + 0.035 * m.kick + 0.02 * m.kickNext + 0.02 * m.bass;
    p[3] = 2.5 * drop + 1.2 * swell;
    // S.p[1]: julia offset / quaternion seed, julia weight
    const ja = ctx.spin * 0.21 + g[4] * 12 + ev[0] * 3;
    if (fam === 3) {
      // Quaternion Julia seed: drifts slowly through a well-behaved neighbourhood.
      const c = QJ_SEEDS[pick(g[4], QJ_SEEDS.length)];
      const b = ctx.spin * 0.07 + ev[0] * 3;
      p[4] = c[0] + 0.05 * Math.sin(b * 1.2) - 0.04 * swell;
      p[5] = c[1] + 0.05 * Math.sin(b * 1.7 + 1);
      p[6] = c[2] + 0.05 * Math.sin(b * 1.3 + 2);
      p[7] = c[3] + 0.05 * Math.sin(b * 2.5 + 3);
    } else {
      // Pure Julia bulbs need a larger seed or they collapse into a plain ball.
      const js = fam === 1 ? 1.55 : 1;
      p[4] = 0.45 * Math.cos(ja) * js;
      p[5] = 0.35 * Math.sin(ja * 0.7) * js;
      p[6] = 0.3 * Math.sin(ja * 1.3 + 1) * js;
      p[7] = fam === 1 ? 1 : 0;
    }
    // S.p[2]: yaw, pitch, emissive gain, core gain
    p[8] = mbYaw + barTurn;
    p[9] = Math.sin(mbPitch) * 0.6 + g[6] * 3;
    p[10] = 0.3 + 1.0 * ctx.intensity + 3 * drop * drop;
    // Core: kicks and the melody (each note flares it) glow through the gaps.
    p[11] = Math.max(0.1, 0.3 + 0.6 * m.bass + 1.5 * m.kick + 0.8 * m.kickNext * (1 - ant) + 4 * drop - 0.2 * ant + 3 * m.lead + 0.4 * m.leadHeld) * (motion === 0 ? 1 : 0.6);
    // S.p[3]: eye position, focal length
    const a = ctx.spin * 0.35 * dir + g[1] * 6.28;
    let r = 3.0 + 0.35 * Math.sin(ctx.spin * 0.17 + g[1] * 5);
    let h = Math.sin(ctx.spin * 0.13 + g[1] * 3.3) * (0.6 + 0.8 * fract(g[1] * 3.1));
    let fl = 2.3;
    if (rig === 1) { r = 1.95 + 0.1 * Math.sin(ctx.spin * 0.21); h = 0.35 * Math.sin(ctx.spin * 0.17); fl = 1.45; }
    else if (rig === 2) { r = 0.6; h = 2.9 + 0.2 * Math.sin(ctx.spin * 0.1); fl = 2.0; }
    else if (rig === 3) { r = 5.2 + 1.2 * Math.sin(ctx.spin * 0.09 + ev[1] * 3); fl = 4.2 + 1.0 * Math.sin(ctx.spin * 0.09 + ev[1] * 3); }
    r += 0.3 * ant - 0.25 * drop;
    p[12] = Math.cos(a) * r;
    p[13] = h;
    p[14] = Math.sin(a) * r;
    p[15] = fl + 0.2 * ant - 0.3 * drop;
    // S.p[4]: colour shift, trap mapping, darkness, band density
    p[16] = g[6] * 0.73 + ev[2] * 0.3;
    p[17] = fract(g[6] * 5.3);
    p[18] = Math.min(0.8, ant * 0.85);
    p[19] = 3 + 4 * fract(g[6] * 8.7);
    // S.p[5]: roll, rim gain, family, abs-fold
    p[20] = Math.sin(ctx.spin * 0.23) * 0.2;
    p[21] = 0.6 + 0.8 * m.high + 0.6 * m.snare;
    p[22] = fam;
    p[23] = fam === 0 && fract(g[4] * 7.7) > 0.6 ? 1 : 0;
    // S.p[6]: material, light, backdrop, motion
    p[24] = mat;
    p[25] = light;
    p[26] = bg;
    p[27] = motion;
    // S.p[7]: mandelbox scale, quaternion slice, spare
    p[28] = BOX_SCALES[pick(fract(g[4] * 3.3), BOX_SCALES.length)] + 0.05 * Math.sin(ctx.spin * 0.1 + ev[3] * 4) + 0.06 * swell;
    p[29] = 0.12 * Math.sin(ctx.spin * 0.05 + ev[3] * 5);
    p[30] = 0;
    p[31] = 0;
  },
  wgsl: /* wgsl */ `
var<private> mbP: f32;
var<private> mbJ: vec3f;
var<private> mbJW: f32;
var<private> mbFam: i32;

fn mb_bulb(p: vec3f, iters: i32) -> vec4f {
  var z = p;
  var dr = 1.0;
  var r = length(z);
  var trap = vec4f(1e9);
  let c = mix(p, mbJ, mbJW);
  let dk = 1.0 - mbJW;
  let fold = S.p[5].w > 0.5;
  for (var i = 0; i < iters; i++) {
    if (r > 2.0) { break; }
    if (fold) { z = abs(z); }
    let rr = max(r, 1e-6);
    let theta = acos(clamp(z.z / rr, -1.0, 1.0)) * mbP;
    let phi = atan2(z.y, z.x) * mbP;
    let rp = pow(rr, mbP - 1.0);
    dr = rp * mbP * dr + dk;
    let st = sin(theta);
    z = rp * rr * vec3f(st * cos(phi), st * sin(phi), cos(theta)) + c;
    r = length(z);
    trap = min(trap, vec4f(abs(z.xy), length(z.xz), r));
  }
  let d = 0.5 * log(max(r, 1e-6)) * r / max(dr, 1e-6);
  return vec4f(d, trap.w, trap.y, trap.z);
}

fn mb_box(pw: vec3f, iters: i32) -> vec4f {
  let s = S.p[7].x;
  // Fit the box into roughly the bulb's radius.
  let k = select(3.0, 6.8, s > 0.0);
  let p0 = pw * k;
  var z = p0;
  var dr = 1.0;
  var trap = vec4f(1e9);
  for (var i = 0; i < iters; i++) {
    z = clamp(z, vec3f(-1.0), vec3f(1.0)) * 2.0 - z;
    let r2 = dot(z, z);
    if (r2 < 0.25) { z *= 4.0; dr *= 4.0; } else if (r2 < 1.0) { z /= r2; dr /= r2; }
    z = z * s + p0;
    dr = dr * abs(s) + 1.0;
    trap = min(trap, vec4f(abs(z.xy), length(z.xz), r2));
  }
  return vec4f(length(z) / abs(dr) / k, sqrt(trap.w) * 0.6, trap.y * 0.3, trap.z * 0.3);
}

fn mb_qj(p: vec3f, iters: i32) -> vec4f {
  var z = vec4f(p.x, p.y, p.z, S.p[7].y);
  let c = S.p[1];
  var dz2 = 1.0;
  var m2 = dot(z, z);
  var trap = vec4f(1e9);
  for (var i = 0; i < iters; i++) {
    dz2 *= 4.0 * m2;
    z = vec4f(z.x * z.x - dot(z.yzw, z.yzw), 2.0 * z.x * z.yzw) + c;
    m2 = dot(z, z);
    trap = min(trap, vec4f(abs(z.xy), length(z.xz), m2));
    if (m2 > 64.0) { break; }
  }
  let d = 0.25 * log(max(m2, 1e-6)) * sqrt(m2 / max(dz2, 1e-9));
  return vec4f(d, sqrt(trap.w) * 1.2, trap.y, trap.z);
}

// x: distance, y: orbit trap |z|, z: plane trap, w: axis trap
fn mb_de(p0: vec3f, iters: i32) -> vec4f {
  let sc = S.p[0].z;
  let p = p0 / sc;
  var r: vec4f;
  if (mbFam == 2) { r = mb_box(p, iters + 3); }
  else if (mbFam == 3) { r = mb_qj(p * 1.1, iters + 3); r.x /= 1.1; }
  else { r = mb_bulb(p, iters); }
  return vec4f(r.x * sc, r.yzw);
}

fn mb_dist(p: vec3f) -> f32 { return mb_de(p, 7).x; }

fn mb_normal(p: vec3f, eps: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(vec3f(1e-9) + k.xyy * mb_dist(p + k.xyy * eps) + k.yyx * mb_dist(p + k.yyx * eps) +
                   k.yxy * mb_dist(p + k.yxy * eps) + k.xxx * mb_dist(p + k.xxx * eps));
}

fn mb_shadow(ro: vec3f, rd: vec3f) -> f32 {
  var res = 1.0;
  var t = 0.015;
  for (var i = 0; i < 12; i++) {
    let h = mb_de(ro + rd * t, 5).x;
    res = min(res, 9.0 * h / t);
    t += clamp(h, 0.02, 0.25);
    if (res < 0.02 || t > 2.5) { break; }
  }
  return sat(res);
}

fn mb_ao(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  var w = 1.0;
  for (var i = 1; i <= 4; i++) {
    let h = 0.015 + 0.045 * f32(i);
    occ += (h - mb_de(p + n * h, 5).x) * w;
    w *= 0.6;
  }
  return sat(1.0 - occ * 3.0);
}

// Cyclic gradient through the three lit palette colours at a fixed luminance.
fn mb_hue(t: f32, lum: f32) -> vec3f {
  let x = fract(t) * 3.0;
  let f = smoothstep(0.0, 1.0, fract(x));
  let i = floor(x);
  let a = select(select(F.pal3.rgb, F.pal2.rgb, i < 1.5), F.pal1.rgb, i < 0.5);
  let b = select(select(F.pal1.rgb, F.pal3.rgb, i < 1.5), F.pal2.rgb, i < 0.5);
  let c = mix(a, b, f);
  return c * (lum / max(luma(c), 0.02));
}

fn mb_bg(rd: vec3f, uv: vec2f) -> vec3f {
  let mode = i32(S.p[6].z + 0.5);
  let vig = 1.0 - 0.6 * length(uv - 0.5);
  let sh = S.p[4].x;
  var c = palL(sh + 0.05, 0.012) * (0.4 + 0.6 * vig) * (1.0 - 0.5 * S.p[4].z);
  if (mode == 0) {
    let n = fbmFast(rd * 2.2 + vec3f(0.0, F.warp * 0.03, 0.0), 4);
    let neb = pow(sat(n * 0.9 + 0.45), 3.0);
    c += palL(n * 0.7 + sh + 0.3, 0.05) * neb * (0.6 + 0.6 * F.energySlow);
    let s = hash13(floor(rd * 500.0));
    c += vec3f(step(0.9985, s)) * (0.15 + 0.35 * F.high) * s;
  } else if (mode == 1) {
    // Studio: lit backdrop wall above a soft horizon.
    let y = rd.y;
    c += palL(sh + 0.45, 0.05) * smoothstep(-0.3, 0.4, y) * (0.7 + 0.5 * F.energySlow);
    c += palL(sh + 0.7, 0.08) * exp(-abs(y + 0.02) * 12.0);
  }
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  mbFam = i32(S.p[5].z + 0.5);
  let mat = i32(S.p[6].x + 0.5);
  let lightK = i32(S.p[6].y + 0.5);
  let motion = i32(S.p[6].w + 0.5);
  // Power glides with the section (morph) and nudges with chords (morph2); the drop snaps it.
  mbP = mix(S.p[0].x, S.p[0].y, smoothstep(0.0, 1.0, F.morph.x)) + (F.morph2.x - 0.5) * 0.9 + S.p[0].w;
  mbP = max(mbP, 3.3);
  mbJ = S.p[1].xyz + (F.morph2.yzw - 0.5) * 0.12;
  mbJW = select(0.0, 1.0, S.p[1].w > 0.5 && mbFam == 1);

  let q2 = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let eye = S.p[3].xyz;
  let camM = lookAt(eye, vec3f(0.0), S.p[5].x);
  // Low powers and Julia offsets grow the bulb: widen the lens to keep it framed.
  let grow = select(1.0, (1.0 + 0.13 * max(0.0, 6.5 - mbP)) * (1.0 + 0.25 * mbJW), mbFam < 2);
  let fl = S.p[3].w / grow;
  let rdW = normalize(camM * vec3f(q2, fl));
  // Work in object space: rotate the camera instead of the object.
  let R = rotY(S.p[2].x) * rotX(S.p[2].y);
  let Ri = transpose(R);
  let ro = Ri * eye;
  let rd = Ri * rdW;
  var keyW = normalize(vec3f(0.6, 0.8, -0.35));
  if (lightK == 1) { keyW = normalize(vec3f(0.15, 1.0, 0.1)); }
  else if (lightK == 2) { keyW = normalize(-eye + vec3f(0.0, 1.2, 0.0)); }
  let key = Ri * keyW;

  var col = mb_bg(rdW, uv);
  let sc = S.p[0].z;
  // Bounding sphere.
  var bR = (1.3 * select(1.0, 1.35, mbJW > 0.0) + 0.12 * max(0.0, 5.0 - mbP)) * sc;
  if (mbFam >= 2) { bR = 1.5 * sc; }
  let bb = dot(ro, rd);
  let closest = sqrt(max(dot(ro, ro) - bb * bb, 0.0));
  let bc = dot(ro, ro) - bR * bR;
  let disc = bb * bb - bc;
  var hit = false;
  var t = 0.0;
  var glow = vec3f(0.0);
  var core = 0.0;
  var res = vec4f(0.0);
  let sh = S.p[4].x;
  if (disc > 0.0) {
    let sq = sqrt(disc);
    t = max(-bb - sq, 0.0) + ign(frag) * 0.01;
    let tEnd = -bb + sq;
    for (var i = 0; i < 90; i++) {
      let pos = ro + rd * t;
      res = mb_de(pos, 7);
      let lp = length(pos) / sc;
      // Inner core glow seen through the gaps, plus a faint skin glow.
      core += exp(-lp * lp * 9.0) * max(res.x, 0.0);
      glow += palL(lp * 0.6 + sh, 0.6) * exp(-max(res.x, 0.0) * 60.0) * 0.0012;
      if (res.x < 0.0005 * t) { hit = true; break; }
      t += res.x * select(0.75, 0.6, mbFam == 2);
      if (t > tEnd) { break; }
    }
  }
  let coreCol = mb_hue(0.55 + 0.3 * F.morph2.z + sh, 0.6);

  let dark = S.p[4].z;
  if (hit) {
    let pos = ro + rd * t;
    let n = mb_normal(pos, max(0.0008, 0.0016 * t));
    let ao = mb_ao(pos, n);
    let shd = mb_shadow(pos + n * 0.004, key);
    let lp = length(pos) / sc;
    let tv = res.y;
    let ndv = sat(dot(n, -rd));

    // Orbit-trap colouring: the DNA picks how traps map into the palette.
    let tmap = mix(tv, sqrt(res.z) * 1.6, S.p[4].y);
    let hue = mb_hue(tmap * 1.6 + res.w * 0.7 + sh + F.morph2.y * 0.3, 0.35);
    var base = mix(palRampL(0.1 + 0.75 * sat(tmap * 0.9), 0.3), hue, 0.75) * (0.4 + 0.6 * smoothstep(0.15, 0.9, tv));

    let dif = sat(dot(n, key));
    let spe = pow(sat(dot(reflect(rd, n), key)), 24.0);
    let fre = pow(1.0 - ndv, 3.0);
    let sky = 0.5 + 0.5 * dot(n, Ri * vec3f(0.0, 1.0, 0.0));
    let back = sat(dot(n, -key) + 0.25);
    let keyCol = mix(vec3f(0.9), palL(sh + 0.8, 0.9), 0.5);
    let keyGain = select(1.2, 1.7, lightK == 1);
    let fill = select(0.1, 0.04, lightK == 1);

    if (mat == 1) {
      // Porcelain: pale glaze with a palette-tinted subsurface in the crevices.
      base = mix(palRampL(0.85, 0.6), hue * 1.4, 0.2);
      col = base * (0.02 + keyGain * keyCol * dif * shd * ao + fill * 1.5 * sky * ao);
      col += keyCol * pow(sat(dot(reflect(rd, n), key)), 60.0) * shd * 1.5;
      col += hue * (1.0 - ao) * 0.4;
    } else if (mat == 2) {
      // Neon: near-black body, glowing trap contours and rim.
      col = base * (0.01 + 0.15 * dif * shd * ao);
      let cu = tmap * 2.2 + res.w * 0.8 - F.warp * 0.1;
      let wire = smoothstep(0.05, 0.0, abs(fract(cu) - 0.5) - 0.45);
      col += mb_hue(floor(cu) * 0.19 + sh, 0.6) * wire * (0.3 + 0.7 * ao) * (0.6 + 1.0 * F.beatPulse);
      col += mb_hue(sh + 0.4, 0.5) * fre * 0.8;
    } else if (mat == 3) {
      // Gilded metal reflecting the backdrop.
      let r = reflect(rdW, R * n);
      let env = mb_bg(r, uv) * 5.0 + keyCol * pow(sat(dot(r, keyW)), 10.0) * 1.5;
      let tint = mix(palRampL(0.8, 0.8), vec3f(1.0), 0.25 + 0.6 * fre);
      col = env * tint * (0.25 + 0.75 * ao) * (0.4 + 0.6 * shd) + base * dif * shd * ao * 0.3;
    } else {
      col = base * (0.02 + keyGain * keyCol * dif * shd * ao + fill * sky * ao * 1.5);
      col += keyCol * spe * shd * ao * 0.6;
    }
    col += mb_hue(sh + 0.5, 0.4) * fre * back * 0.6 * S.p[5].y * ao * select(1.0, 2.0, lightK == 2);
    // Crevices leak light from the glowing core.
    let leak = (1.0 - ao) * smoothstep(1.25, 0.45, lp);
    col += coreCol * leak * leak * S.p[2].w * 0.3;

    // Spectrum bands on trap contours.
    let u = tv * S.p[4].w - F.warp * 0.15;
    let idx = floor(u + 0.5);
    let w = 0.06 + 0.15 * F.dropPulse;
    let line = smoothstep(w, 0.0, 0.5 - abs(fract(u) - 0.5));
    let bx = fract(idx * 0.173 + 0.03) * 0.85 + 0.02;
    let lvl = spec(bx);
    col += mb_hue(bx * 1.3 + sh + 0.4, 0.45) * line * (0.02 + 4.0 * lvl * lvl * lvl) * S.p[2].z * (0.25 + 0.75 * ao) * ndv * (1.0 - 0.6 * dark);

    // Kick ring travelling out from the core.
    if (motion == 0) {
      let ringR = 0.3 + (1.0 - F.kick) * 1.0;
      let ring = exp(-(lp - ringR) * (lp - ringR) * 45.0) * F.kick * F.kick;
      col += coreCol * ring * 2.2 * (0.3 + 0.7 * ao) * (0.4 + 0.6 * ndv);
    } else {
      // Beat sweep: a plane of light passes through the object on each beat.
      let y = dot(pos, Ri * vec3f(0.0, 1.0, 0.0)) / sc;
      let sweep = exp(-pow(y - (1.4 - 2.8 * F.beatPhase), 2.0) * 30.0) * (0.3 + F.beatPulse);
      col += coreCol * sweep * 0.8 * ao;
    }
  }
  // Halo around the silhouette (behind and around the object).
  let halo = exp(-max(closest - 0.85 * sc, 0.0) * 4.0);
  let haloGain = select(1.0, 2.5, lightK == 2 || i32(S.p[6].z + 0.5) == 2);
  col += mb_hue(sh + 0.6, 0.5) * halo * select(1.0, 0.2, hit) * (0.04 + 0.3 * F.dropPulse + 0.06 * F.kick) * haloGain;
  col += glow + coreCol * min(core * S.p[2].w * 0.25, 1.2);
  // Anticipation darkens and pulls toward the shadow colour.
  col *= 1.0 - 0.65 * dark;
  col = mix(col, vec3f(luma(col)) * palL(sh + 0.25, 1.0) * 2.0, dark * 0.35);
  return vec4f(min(col, vec3f(10.0)), 1.0);
}
`,
});
