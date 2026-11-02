import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';
import { Spring } from '../anim';

const morph = new Morph(0.45);
/** The melody's lean of the offset: pitch x strength squared, glided from rest. */
const lean = new Spring(0, 0.4);
const TAU = Math.PI * 2;
/** Fractal families round the morph's circle (the WGSL's FS_FAMS). */
const FAMS = 4;

const st = { drive: 0, t: -1, pitch: 0, hx: 1, hy: 0, kicks: 0, kickT: -99, snares: 0, snareT: -99, kSum: 0, kLast: 0, sSum: 0, sLast: 0 };
/** A level-weighted event sum (hundredths, wrapped) with the latest level packed in the fraction. */
const packSum = (sum: number, wrap: number, level: number) => (Math.round(sum * 100) % (wrap * 100)) + 0.9 * Math.min(1, level);

/**
 * Fold Space: an endless flight through one coherent fractal whose formula keeps changing family.
 * The space is a mirrored lattice of cells, each holding the fractal, so you travel through it
 * forever; a smooth passage is carved along the flight so nothing reaches the lens.
 *
 * The formula: every iteration blends two families' operators, p = mix(opA(p), opB(p), w), out of
 * Mandelbox (box and sphere folds), Kali (abs and inversion), octahedral KIFS and Menger, with all
 * their constants (scale, minimum radius, fold limit, offset, rotation) mapped from the morph. The
 * odd iterations can swap the pair, making alternating hybrids. All parameters change globally and
 * smoothly in time, so the shape morphs as one fractal. The morph jumps to a new region every
 * phrase, which here means a new family and new constants: a genuinely different fractal.
 *
 * Music (each event acts on its own term, eased, never undone):
 * - kick: steps the scale (the fractal's density and size of its chambers);
 * - snare: steps the rotation inside each iteration (the fractal twists into new symmetries);
 * - melody: steers the offset vector with the pitch, and each note bends the morph's heading;
 * - chords: lean the morph toward a region and ease the palette;
 * - energy: drive and drop surges speed the flight and the morph, and widen the twist of space.
 * Light only: each kick re-colours the orbit-trap palette as a front running out from the viewer.
 * Every front's light and colour step scales with its event's level and rises over about 0.1 s, and
 * the pitch leans the offset at a rate set by the note's strength, so a faint motif only ripples.
 *
 * DNA: 0-1 starting point, 2 material (lacquer / chrome / pearl), 3 palette offset, 4 cell size,
 * 5 pan, 6 fog, 7 lens.
 */
export default raymarchScene({
  meta: {
    id: 'fold-space',
    name: 'Fold Space',
    // Out of the show: some family blends read as rocks floating in a void and it changes too
    // restlessly (rated 5/10); needs per-family range tuning.
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.5, arousal: 0.6 },
    genres: { techno: 1, edm: 1, dnb: 0.9, ambient: 0.8, dubstep: 0.9, rock: 0.6, pop: 0.6, synthwave: 0.7, classical: 0.7, hiphop: 0.6 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const seek = Math.abs(m.time - st.t - dt) > 0.5;
    st.t = m.time;
    const hue = m.chord && m.chord.root >= 0 ? (((m.chord.root * 7) % 12) / 12) * TAU : 0;
    if (seek) {
      lean.reset(morph.notePitch * morph.noteLevel ** 2);
      st.pitch = lean.x;
      st.hx = Math.cos(hue);
      st.hy = Math.sin(hue);
      st.kicks = morph.kicks;
      st.snares = morph.snares;
      st.kickT = st.snareT = m.time - 9;
    } else {
      // The pitch leans the offset by the note's strength squared (a faint motif barely, a strong
      // lead fully), gliding from rest over about a second. Never a jump of the whole fractal.
      st.pitch = lean.update(morph.notePitch * morph.noteLevel ** 2, dt);
      const kh = 1 - Math.exp(-dt / 1.2);
      st.hx += (Math.cos(hue) - st.hx) * kh;
      st.hy += (Math.sin(hue) - st.hy) * kh;
    }
    if (morph.kicks !== st.kicks) {
      st.kicks = morph.kicks;
      st.kickT = m.time - morph.kickAge;
      st.kSum += st.kLast;
      st.kLast = morph.kickLevel;
    }
    if (morph.snares !== st.snares) {
      st.snares = morph.snares;
      st.snareT = m.time - morph.snareAge;
      st.sSum += st.sLast;
      st.sLast = morph.snareLevel;
    }
    // Drive eased over about half a second for the warp, so bass wobble never jitters the form.
    st.drive = seek ? morph.drive : st.drive + (morph.drive - st.drive) * (1 - Math.exp(-dt / 0.5));
    const drive = st.drive;

    // Family pair and blend: a[0] travels round a circle of families; the blend dwells on each
    // family and crosses quickly between neighbours.
    const x = ((((a[0] / TAU) * FAMS) % FAMS) + FAMS) % FAMS;
    const fa = Math.floor(x);
    const fr = x - fa;
    const w = fr * fr * (3 - 2 * fr);
    p[0] = fa;
    p[1] = (fa + 1) % FAMS;
    p[2] = w * w * (3 - 2 * w);
    p[3] = Math.max(0, wave(a[1], -0.6, 1));
    // Constants, each family maps them onto its own good range (0..1 here).
    p[4] = wave(a[2] + 0.6 * morph.kickPhase, 0, 1);
    p[5] = wave(a[3], 0, 1);
    p[6] = wave(a[7] + 0.4 * Math.sin(a[5]), 0, 1);
    p[7] = wave(a[5] + 0.6 * morph.snarePhase, -0.55, 0.55);
    // Offset vector: base from the morph, steered by the melody's pitch.
    p[8] = wave(a[4], 0, 1) + 0.3 * st.pitch;
    p[9] = wave(a[6], 0, 1) - 0.2 * st.pitch;
    p[10] = wave(a[4] * 0.7 + a[6] * 0.5, 0, 1) + 0.06 * Math.sin(morph.notePhase * 1.3);
    // Twist of space about the flight axis, wider as the music drives.
    p[11] = (0.04 + 0.22 * drive * (1 + morph.surge)) * Math.sin(a[1] * 0.5 + g[5] * 6);
    // Flight: travel down the lattice, cell half-size, fractal zoom, focal length.
    p[12] = morph.travel * 0.55 + g[0] * 37;
    p[13] = 1.6 + 0.5 * g[4];
    p[14] = 1.0 + 0.15 * Math.sin(a[7] * 0.6 + g[4] * 3);
    p[15] = 1.0 + 0.25 * g[7];
    const tr = morph.travel;
    p[16] = 0.22 * Math.sin(tr * 0.21 + g[5] * 6.3);
    p[17] = 0.12 * Math.sin(tr * 0.17 + g[6] * 5);
    p[18] = 0.25 * Math.sin(tr * 0.13 + g[1] * 6) + 0.1 * Math.sin(a[6] * 0.5);
    p[19] = g[3] + 0.25 * (Math.atan2(st.hy, st.hx) / TAU) + 0.05 * Math.sin(a[2] * 0.5);
    // Light: kick count and age (a colour front), snare age, pitch.
    p[20] = packSum(st.kSum + st.kLast, 50, st.kLast);
    p[21] = Math.min(m.time - st.kickT, 30);
    p[22] = Math.min(m.time - st.snareT, 30);
    p[23] = st.pitch;
    p[24] = Math.min(2, Math.floor(g[2] * 3));
    p[25] = 0.1 + 0.08 * g[6];
    p[26] = drive;
    p[27] = morph.surge;
    // Colour state: snare count (its front re-colours the reflections), melody's eased note count.
    p[28] = packSum(st.sSum + st.sLast, 100, st.sLast);
    p[29] = morph.notePhase % 64;
    p[30] = Math.min(morph.leadAge, 30);
    p[31] = morph.noteLevel ** 2;
  },
  wgsl: /* wgsl */ `
const FS_FAMS: i32 = 4;
const FS_ITER: i32 = 5;
// World units per second of the kick's colour front.
const FS_FRONT: f32 = 55.0;

// Per-pixel constants (uniform-derived), set once before marching.
var<private> fs_rot: mat3x3f;
var<private> fs_mono: f32;

fn fs_mirror(x: vec3f, c: f32) -> vec3f {
  let u = x + c - 4.0 * c * floor((x + c) / (4.0 * c));
  return c - abs(u - 2.0 * c);
}

fn fs_path(z: f32) -> vec2f {
  let zz = z + S.p[3].x;
  return vec2f(0.35 * sin(zz * 0.21), 0.25 * sin(zz * 0.17 + 1.3));
}

fn fs_sort(q: vec3f) -> vec3f {
  var p = q;
  if (p.x < p.y) { p = p.yxz; }
  if (p.x < p.z) { p = p.zyx; }
  if (p.y < p.z) { p = p.xzy; }
  return p;
}

// One family's operator. Returns the new point and running derivative.
fn fs_op(fam: i32, p: vec3f, dr: f32, p0: vec3f) -> vec4f {
  let u = S.p[1].x;
  let v = S.p[1].y;
  let lim = S.p[1].z;
  let o = S.p[2].xyz;
  if (fam == 0) {
    // Mandelbox: box fold, sphere fold, negative scale, Julia offset.
    let s = -1.55 - 1.0 * u;
    let mr2 = 0.12 + 0.38 * v;
    let L = 0.8 + 0.5 * lim;
    var q = clamp(p, vec3f(-L), vec3f(L)) * 2.0 - p;
    let r2 = dot(q, q);
    let k = select(select(1.0, 1.0 / max(r2, 1e-4), r2 < 1.0), 1.0 / mr2, r2 < mr2);
    q = fs_rot * (q * k);
    // Mandelbrot-style (the start point as the offset) leaning toward a Julia set.
    return vec4f(q * s + p0 + (o - 0.5) * 0.8, dr * abs(s) * k + 1.0);
  } else if (fam == 1) {
    // Kali: abs and inversion.
    let s = 1.25 + 0.55 * u;
    let q = abs(p);
    let r2 = clamp(dot(q, q), 0.08 + 0.3 * v, 30.0);
    let qq = fs_rot * (q * (s / r2));
    return vec4f(qq - (vec3f(0.5) + o * 0.7) * (0.6 + 0.6 * lim), dr * s / r2);
  } else if (fam == 2) {
    // Octahedral KIFS: mirror into the fundamental wedge, rotate, scale about a vertex.
    let s = 1.85 + 0.55 * u;
    var q = fs_rot * fs_sort(abs(p));
    let c = vec3f(1.0, 0.6 + 0.6 * v, 0.2 + 0.8 * o.z) * (0.8 + 0.4 * lim);
    return vec4f(q * s - c * (s - 1.0), dr * s);
  } else {
    // Menger: mirror, sort, scale about the cube's corner with the classic z correction.
    let s = 2.8 + 0.4 * u;
    var q = fs_rot * fs_sort(abs(p));
    let c = vec3f(1.0, 1.0, 0.8 + 0.4 * v) * (0.9 + 0.2 * lim);
    q = q * s - c * (s - 1.0);
    if (q.z < -0.5 * c.z * (s - 1.0)) { q.z += c.z * (s - 1.0); }
    return vec4f(q, dr * s);
  }
}

// The family's distance from its final point.
fn fs_end(fam: i32, p: vec3f, dr: f32) -> f32 {
  if (fam == 0) { return (length(p) - 1.2) / abs(dr); }
  if (fam == 1) { return (length(p) - 0.35) / max(dr, 1e-4) * 0.5; }
  if (fam == 2) { return (length(p) - 1.1) / dr; }
  let b = abs(p) - vec3f(1.0);
  return (min(max(b.x, max(b.y, b.z)), 0.0) + length(max(b, vec3f(0.0)))) / dr;
}

// Distance in fractal units and two orbit traps (nearest approach to the origin, to a plane).
fn fs_fractal(p0: vec3f) -> vec3f {
  let fa = i32(S.p[0].x + 0.5);
  let fb = i32(S.p[0].y + 0.5);
  let w = S.p[0].z;
  let hyb = S.p[0].w;
  var p = p0;
  var dr = 1.0;
  var trap = vec2f(1e9);
  for (var i = 0; i < FS_ITER; i++) {
    // Odd iterations swap the blend toward the other family: alternating hybrids.
    let wi = select(w, mix(w, 1.0 - w, hyb), (i & 1) == 1);
    var r: vec4f;
    if (wi < 0.002) {
      r = fs_op(fa, p, dr, p0);
    } else if (wi > 0.998) {
      r = fs_op(fb, p, dr, p0);
    } else {
      r = mix(fs_op(fa, p, dr, p0), fs_op(fb, p, dr, p0), wi);
    }
    p = r.xyz;
    dr = r.w;
    // Colour traps from the first iterations only: large regions, not per-pixel speckle.
    if (i < 3) { trap = min(trap, vec2f(dot(p, p), abs(p.y))); }
  }
  let d = mix(fs_end(fa, p, dr), fs_end(fb, p, dr), w);
  return vec3f(d, trap);
}

fn fs_map(pw: vec3f) -> vec3f {
  // Twist of space about the flight axis (zero at the viewer, so nothing near swings).
  let tw = S.p[2].w * pw.z;
  let cs = vec2f(cos(tw), sin(tw));
  let H = S.p[3].y;
  // The flight runs along a line where four cells meet, so it threads the open corridors between
  // the fractal bodies (each centred in its cell) rather than tunnelling through one.
  let pt = vec3f(cs.x * pw.x - cs.y * pw.y + H, cs.y * pw.x + cs.x * pw.y + H, pw.z + S.p[3].x);
  // Each family's cell half-size in its own units, so its body nearly fills the cell and meets
  // its neighbours, leaving corridors between.
  let ext = array<f32, 4>(4.0, 1.2, 2.5, 1.3);
  let fa = i32(S.p[0].x + 0.5);
  let fb = i32(S.p[0].y + 0.5);
  let w = S.p[0].z;
  let zoom = mix(ext[fa], ext[fb], w) * S.p[3].z / H;
  let q = fs_mirror(pt, H);
  let r = fs_fractal(q * zoom);
  // A smooth passage along the flight, so nothing comes near the lens.
  let c = pw.xy - fs_path(pw.z);
  let passage = 0.4 - length(c);
  return vec3f(smax(r.x / zoom * 0.8, passage, 0.25), r.y, r.z);
}

fn fs_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * fs_map(p + k.xyy * e).x + k.yyx * fs_map(p + k.yyx * e).x +
                   k.yxy * fs_map(p + k.yxy * e).x + k.xxx * fs_map(p + k.xxx * e).x);
}

fn fs_ao(p: vec3f, n: vec3f) -> f32 {
  var o = 0.0;
  for (var i = 1; i <= 2; i++) {
    let h = 0.08 * f32(i * i);
    o += (h - fs_map(p + n * h).x) / f32(i);
  }
  return sat(1.0 - 1.6 * o);
}

// Vivid palette colour (more saturated than the palette); second-role colours turn round the wheel
// when the palette is a single hue.
fn fs_pal(t: f32, lum: f32) -> vec3f {
  let c = pal(t);
  let v = max(mix(vec3f(luma(c)), c, 1.5), vec3f(0.0));
  return v * (lum / max(luma(v), 0.02));
}
fn fs_hueVec(c: vec3f) -> vec2f { return c.rg / max(c.r + c.g + c.b, 1e-3) - vec2f(1.0 / 3.0); }
fn fs_palR(t: f32, lum: f32, turn: f32) -> vec3f {
  let c = fs_pal(t, lum);
  let a = max(fs_mono, 0.7) * turn;
  let k = vec3f(0.57735);
  let r = max(c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a)), vec3f(0.0));
  return r * (lum / max(luma(r), 0.02));
}

// Coloured softboxes on black for the glossy coat.
fn fs_env(d: vec3f, h: f32) -> vec3f {
  var c = fs_pal(h + 0.05, 1.0) * pow(sat(dot(d, normalize(vec3f(-0.7, 0.6, 0.4)))), 14.0) * 1.6;
  c += fs_palR(h + 0.4, 1.0, 2.1) * pow(sat(dot(d, normalize(vec3f(0.8, 0.25, 0.5)))), 10.0) * 1.3;
  c += fs_palR(h + 0.7, 1.0, 4.2) * pow(sat(dot(d, normalize(vec3f(0.1, -0.6, 0.8)))), 8.0) * 0.7;
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q2 = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let focal = S.p[3].w;
  let h = S.p[4].w;
  let mat = i32(S.p[6].x + 0.5);
  let drive = S.p[6].z;
  // Rotation inside every iteration (snare and drive), about two axes.
  // Each family tolerates a different twist before it falls apart (Menger and KIFS the least).
  let rf = array<f32, 4>(0.6, 1.0, 0.45, 0.3);
  let ra = S.p[1].w * mix(rf[i32(S.p[0].x + 0.5)], rf[i32(S.p[0].y + 0.5)], S.p[0].z);
  let c1 = cos(ra);
  let s1 = sin(ra);
  let c2 = cos(ra * 0.7 + 0.3);
  let s2 = sin(ra * 0.7 + 0.3);
  fs_rot = mat3x3f(vec3f(c1, s1, 0.0), vec3f(-s1, c1, 0.0), vec3f(0.0, 0.0, 1.0)) *
           mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, c2, s2), vec3f(0.0, -s2, c2));
  let v0 = fs_hueVec(pal(h));
  let v1 = fs_hueVec(pal(h + 0.25));
  let v2 = fs_hueVec(pal(h + 0.5));
  let v3 = fs_hueVec(pal(h + 0.75));
  fs_mono = smoothstep(0.75, 0.95, length(v0 + v1 + v2 + v3) / max(length(v0) + length(v1) + length(v2) + length(v3), 1e-4));

  let ro = vec3f(fs_path(0.0), 0.0);
  let yaw = S.p[4].x;
  let fwd = vec3f(fs_path(1.0) - ro.xy, 1.0) + vec3f(sin(yaw), S.p[4].y, 0.0);
  let cam = lookAt(ro, ro + fwd, S.p[4].z);
  let rd = normalize(cam * vec3f(q2, focal));

  let pix = 1.4 / (F.res.y * focal);
  var t = 0.05 + 0.03 * ign(frag);
  var hit = false;
  var r = vec3f(0.0);
  let far = 11.0;
  for (var i = 0; i < 80; i++) {
    r = fs_map(ro + rd * t);
    if (r.x < pix * t * 1.5) { hit = true; break; }
    t += r.x * 0.85;
    if (t > far) { break; }
  }

  let bg = fs_palR(h + 0.6, 0.004, 2.1) + fs_pal(h + 0.2, 0.01) * pow(sat(dot(rd, normalize(fwd))), 12.0);
  var col = bg;
  if (hit) {
    let pos = ro + rd * t;
    let n = fs_normal(pos, max(0.002, pix * t * 2.0));
    let ao = fs_ao(pos, n);
    let ndv = sat(dot(n, -rd));
    let fre = pow(1.0 - ndv, 4.0);
    let rf = reflect(rd, n);
    // Kick: the orbit-trap palette steps on, as a front running out from the viewer through the
    // structure (arrival held back where the orbit trap is deep).
    let tr = sqrt(r.y);
    let arrive = t + 0.6 * tr;
    let kf = S.p[5].y * FS_FRONT;
    let kAhead = smoothstep(kf - 0.4, kf + 0.4, arrive);
    // Kick and snare: level-weighted sums with the latest level in the fraction (a faint hit steps
    // the colour a little, a hard one fully).
    let kSum = floor(S.p[5].x) / 100.0;
    let kL = fract(S.p[5].x) / 0.9;
    let sSum = floor(S.p[7].x) / 100.0;
    let sL = fract(S.p[7].x) / 0.9;
    let kc = kSum - kL * kAhead;
    let hBody = h + 0.18 * sin(tr * 0.7) + 0.12 * sin(sqrt(r.z) * 1.5 + 1.0) + 0.3 + 0.2 * kc + 0.12 * S.p[5].w + 0.05 * S.p[7].y;
    // The melody's pitch turns the coat's colour (and the softboxes it reflects).
    // Each note steps the coat's colour on; the snare's front (running back toward the viewer from
    // deep ahead) turns the reflected softboxes.
    let sf = S.p[5].z * FS_FRONT;
    let sReached = smoothstep(sf - 0.4, sf + 0.4, 11.0 - arrive);
    let sc = sSum - sL * (1.0 - sReached);
    let hCoat = h + 0.45 + 0.2 * ndv + 0.4 * S.p[5].w + 0.08 * S.p[7].y + 0.23 * sc;
    // A light travelling with the viewer (a little above) plus a high key.
    let lp = ro + vec3f(0.0, 0.25, 0.3);
    let ld = lp - pos;
    let L = normalize(ld);
    let att = 2.5 / (1.0 + 0.25 * dot(ld, ld));
    let dif = sat(dot(n, L)) * att + 0.8 * sat(dot(n, normalize(vec3f(-0.4, 0.8, 0.3))));
    let spec = pow(sat(dot(rf, L)), 40.0);
    let env = fs_env(rf, hCoat);
    if (mat == 0) {
      // Lacquer: deep coloured body, a clear coat with vivid reflections.
      col = fs_pal(hBody, 0.1) * (0.25 + 1.5 * dif) * ao;
      col += env * (0.05 + 0.9 * fre) * ao;
      col += fs_palR(hCoat, 0.5, 2.1) * spec * ao * 0.4;
    } else if (mat == 1) {
      // Chrome with a thin-film tint.
      let film = fs_palR(hBody + 0.3 * (1.0 - ndv), 1.0, 2.1);
      col = env * mix(film, vec3f(1.0), 0.2) * (0.3 + 0.4 * fre) * ao;
      col += fs_pal(hBody, 0.06) * (0.3 + dif) * ao;
      col += film * spec * 0.3 * ao;
    } else {
      // Pearl: iridescent body, colour shifting with the facing.
      let irid = fs_palR(hBody + 0.35 * (1.0 - ndv), 0.12, 2.1);
      col = irid * (0.3 + 1.6 * dif) * ao;
      col += env * (0.04 + 0.6 * fre) * ao * 0.8;
      col += fs_pal(hCoat, 0.4) * spec * 0.3 * ao;
    }
    // A faint warm edge rides the kick's colour front.
    let ew = (arrive - kf) / 1.6;
    let edge = exp(-ew * ew) * exp(-S.p[5].y * 3.0) * smoothstep(0.0, 0.1, S.p[5].y) * kL;
    col += mix(vec3f(1.0, 0.75, 0.45), fs_pal(hBody + 0.1, 1.0), 0.4) * edge * 1.8 * (0.35 + fre) * (0.4 + 0.6 * ao);
    // Each melody note sends a glow of its colour out along the rims of the structure.
    let lf = S.p[7].z * FS_FRONT * 0.7;
    let lw = (arrive - lf) / 1.2;
    let lgl = exp(-lw * lw) * exp(-S.p[7].z * 3.0) * smoothstep(0.0, 0.12, S.p[7].z) * S.p[7].w;
    col += fs_palR(h + 0.3 + 0.3 * S.p[5].w, 1.0, 1.5) * lgl * (0.3 + 1.2 * fre) * (0.4 + 0.6 * ao) * 2.0;
    col = mix(bg, col, smoothstep(0.15, 0.5, t));
  }
  let fog = 1.0 - exp(-t * S.p[6].y * 0.7 - max(t - 6.5, 0.0) * 0.5);
  col = mix(col, bg, fog);
  col *= 1.0 / (1.0 + 0.8 * max(luma(col) - 0.5, 0.0));
  return vec4f(min(col, vec3f(8.0)), 1.0);
}
`,
});
