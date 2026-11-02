import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';

type V3 = [number, number, number];

const morph = new Morph(1);
/**
 * The morph coordinates with each beat step's increment counted by the passage's presence: the land
 * is sensitive (a small step of the Julia constant re-forms everything in view), so a faint hit in a
 * quiet intro only stirs it while a hard hit in a full mix steps it fully. A cue reset (the steps
 * jump back) starts afresh.
 */
const steps = { prev: new Float64Array(Morph.DIMS), own: new Float64Array(Morph.DIMS), out: new Float64Array(Morph.DIMS) };
function presentAt(): Float64Array {
  for (let i = 0; i < Morph.DIMS; i++) {
    const s = morph.at[i] - morph.flowAt[i];
    const d = s - steps.prev[i];
    steps.prev[i] = s;
    if (Math.abs(d) > 0.5) steps.own[i] = 0;
    else steps.own[i] += d * morph.presence;
    steps.out[i] = morph.flowAt[i] + steps.own[i];
  }
  return steps.out;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/** The shape the shader draws, mirrored here so the camera can follow its surface. */
const shape = { c: [0, 0, 0] as V3, n: 8, np: 8, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] };

/** Same column-major rotation as `rotAxis` in the shared WGSL. */
function setRot(axis: V3, a: number): void {
  const [x, y, z] = axis;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const oc = 1 - c;
  shape.rot = [oc * x * x + c, oc * x * y + z * s, oc * z * x - y * s, oc * x * y - z * s, oc * y * y + c, oc * y * z + x * s, oc * z * x + y * s, oc * y * z - x * s, oc * z * z + c];
}

/** Distance to the Julia bulb (same formula as jb_core in the shader). */
function de(p: V3): number {
  const n = shape.n;
  const np = shape.np;
  const R = shape.rot;
  const c = shape.c;
  let [x, y, z] = p;
  let m = x * x + y * y + z * z;
  let dz = 1;
  for (let i = 0; i < 7; i++) {
    const r = Math.sqrt(m);
    dz = Math.max(n, np) * Math.pow(r, n - 1) * dz;
    const rx = R[0] * x + R[3] * y + R[6] * z;
    const ry = R[1] * x + R[4] * y + R[7] * z;
    const rz = R[2] * x + R[5] * y + R[8] * z;
    const th = n * Math.acos(Math.min(1, Math.max(-1, ry / Math.max(r, 1e-6))));
    const ph = np * Math.atan2(rx, rz);
    const rn = Math.pow(r, n);
    x = c[0] + rn * Math.sin(th) * Math.sin(ph);
    y = c[1] + rn * Math.cos(th);
    z = c[2] + rn * Math.sin(th) * Math.cos(ph);
    m = x * x + y * y + z * z;
    if (m > 256) break;
  }
  return (0.25 * Math.log(m) * Math.sqrt(m)) / dz;
}

/** Radius of the outermost surface along the unit direction u. */
function surfaceR(u: V3, H: number): number {
  let r = 2.2;
  for (let i = 0; i < 200; i++) {
    const d = de(scale(u, r));
    if (d < H * 0.03) return r;
    r -= d * 0.9;
    if (r < 0.5) break;
  }
  // No land found along this direction (a gap in the set): report the mean surface height.
  return 1;
}

/** Turns a and b together about the axis perpendicular to both (moving u along heading h). */
function travelOn(u: V3, h: V3, ang: number): [V3, V3] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [norm(add(scale(u, c), scale(h, s))), norm(add(scale(h, c), scale(u, -s)))];
}
function yaw(u: V3, h: V3, ang: number): V3 {
  const side = cross(u, h);
  return norm(add(scale(h, Math.cos(ang)), scale(side, Math.sin(ang))));
}

/** The flyer: a direction from the centre, a heading along the surface, a smoothed altitude and look. */
const cam = { t: -1, seed: -1, travel: 0, lift: 0, notes: 0, pitch: 0, prevPitch: 0, kNotes: -1, kSum: 0, kLast: 0, sN: -1, sSum: 0, sLast: 0, u: [0, 1, 0] as V3, h: [1, 0, 0] as V3, r: 1.2, fwd: [1, 0, 0] as V3, up: [0, 1, 0] as V3 };

/**
 * Low flight over the surface of a huge morphing Julia bulb: the triplex power map z -> z^n + c with
 * a turn applied to z each iteration. The world is drawn inverted in the unit sphere, so the space
 * outside the set is a closed hollow: the land never drops away below a horizon, it rolls on ahead
 * and rises into a lit haze, and the frame is always ground.
 *
 * The music moves the terrain itself. Through the morph engine the Julia constant (size and
 * direction), the power and the twist travel: energy sets how fast the land re-forms and how fast
 * you fly, melody notes turn the direction it flows in, kicks lunge it, snares twist it, chords
 * lean it toward their own region of shapes. On top, each event steps the shape on its own axis:
 * a kick steps the Julia constant (and rings light out across the land from beneath you, and
 * surges the flight); a snare steps the twist; a melody note steps the power, lights the
 * orbit-trap contours at a level set by its pitch and swings the sun toward that pitch.
 * Every front's light and step scales with its event's level and rises over about 0.1 s; a faint
 * note moves the lit contours only part of the way to its pitch.
 *
 * DNA: 0-1 starting shape and place, 2 altitude, 3 palette offset, 4 sun position, 5 azimuthal
 * power and haze density, 6 lens, 7 trap colouring.
 */
export default raymarchScene({
  meta: {
    id: 'julia-surface',
    name: 'Julia Surface',
    // Out of the show: Reads as washed-out terrain or a lone bulb; not yet at the bar.
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.5, arousal: 0.55 },
    genres: { techno: 1, edm: 1, dnb: 0.8, ambient: 1, dubstep: 0.7, rock: 0.6, pop: 0.7, synthwave: 0.8, classical: 0.8, hiphop: 0.6 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const seek = Math.abs(m.time - cam.t - dt) > 0.5;
    const reset = seek || g[0] !== cam.seed;
    const a = presentAt();

    // The shape flows steadily with the morph: Julia constant by size and direction, power, twist.
    // The power: the radial and polar power flows continuously; the azimuthal one stays a whole
    // number for the cue (a fractional one would tear a seam through the set).
    const K = 0.9;
    shape.n = wave(a[3] * 0.6 * K, 5.5, 8.5);
    shape.np = 6 + Math.floor(g[5] * 3);
    // Past |c| ~ 0.6 the set breaks into dust (sooner at low powers); near that edge it is richest,
    // and below ~0.45 it smooths into glossy sheets.
    const cr = wave(a[0] * K, 0.46, 0.52 + 0.02 * (shape.n - 5));
    const ca = a[1] * 0.5 * K;
    const cb = wave(a[2] * K, -0.6, 0.6);
    shape.c = [cr * Math.cos(cb) * Math.cos(ca), cr * Math.sin(cb), cr * Math.cos(cb) * Math.sin(ca)];
    const tax = norm([Math.sin(a[5] * K), 0.6 * Math.cos(a[5] * 0.7 * K + 1), Math.cos(a[5] * K)]);
    const tang = wave(a[4] * K, -0.4, 0.4);
    setRot(tax, tang);

    // The flight: steady with the morph's travel, low over the outermost surface.
    const H = 0.011 + 0.006 * g[2];
    cam.t = m.time;
    if (reset) {
      cam.seed = g[0];
      cam.travel = morph.travel;
      const th = g[0] * 6.28 + m.time * 0.01;
      const ph = (g[1] - 0.5) * 0.6;
      cam.u = [Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)];
      cam.h = norm(cross(cam.u, [Math.sin(th), 0, -Math.cos(th)]));
      cam.r = surfaceR(cam.u, H) + H;
    }
    const v = H * 4.0 * Math.max(0, morph.travel - cam.travel);
    cam.travel = morph.travel;
    [cam.u, cam.h] = travelOn(cam.u, cam.h, v / cam.r);

    // Fly across the bulb's latitudes, never along them: its ridges run east-west, so crossing
    // them they roll toward the camera as folds instead of streaking past. Turn back before the
    // poles, where the power map smears the land.
    const side = cross(cam.u, cam.h);
    const at = (fwd: number, lateral: number) => surfaceR(travelOn(travelOn(cam.u, cam.h, (H * fwd) / cam.r)[0], side, (H * lateral) / cam.r)[0], H);
    const north = norm(add([0, 1, 0], scale(cam.u, -cam.u[1])));
    const lat = Math.asin(Math.max(-1, Math.min(1, cam.u[1])));
    const away = Math.min(1, Math.max(0, (Math.abs(lat) - 0.5) / 0.3));
    const aim = (h: V3) => Math.abs(dot(h, north)) - away * 2 * Math.sign(lat) * dot(h, north);
    const steer = (aim(yaw(cam.u, cam.h, 0.05)) - aim(yaw(cam.u, cam.h, -0.05))) / 0.1;
    cam.h = yaw(cam.u, cam.h, dt * 0.3 * Math.max(-1, Math.min(1, steer)));
    const target = Math.max(at(0, 0), at(4, 0) - H * 0.2, at(10, 0) - H * 0.6) + H;
    // Keep the view clear too: rays across the lower and side frustum must run several camera
    // heights before they meet land, so no slope ever fills the lens as a blurry wall.
    const p0 = scale(cam.u, cam.r);
    let near = 1e9;
    for (const [dn, ds] of [[0, 0], [0.35, 0], [0.55, 0], [0.3, 0.6], [0.3, -0.6]]) {
      const rd = norm(add(add(cam.fwd, scale(cam.u, -dn)), scale(side, ds)));
      let t = H * 0.2;
      for (let i = 0; i < 30 && t < H * 8; i++) {
        const d = de(add(p0, scale(rd, t)));
        if (d < H * 0.05) break;
        t += d;
      }
      near = Math.min(near, t);
    }
    cam.lift += (Math.max(0, H * 6 - near) * 0.7 - cam.lift) * (reset ? 1 : 1 - Math.exp(-dt / 0.5));
    cam.r += (target + cam.lift - cam.r) * (reset ? 1 : 1 - Math.exp(-dt / 0.4));
    // Never inside: rise at once if the land swells up under the camera.
    let pos = scale(cam.u, cam.r);
    const clear = de(pos);
    // (Inside the set the estimate is meaningless, so the rise is capped.)
    if (clear < H * 0.9) cam.r += Math.min(H * 0.9 - clear, H * 1.5) * (reset ? 1 : 1 - Math.exp(-dt / 0.03));
    // Always just above the land: deep inside the hollow (or below its floor) the inverted world
    // would read as a lone object floating in a void.
    cam.r = Math.min(Math.max(cam.r, 0.75), 1.5);
    pos = scale(cam.u, cam.r);

    // Up follows the broad slope of the land (the distance gradient a camera height away), so the
    // view runs along the lobe it is flying over instead of staring at the next one.
    const e = H * 0.6;
    const grad = norm([de(add(pos, [e, 0, 0])) - de(add(pos, [-e, 0, 0])), de(add(pos, [0, e, 0])) - de(add(pos, [0, -e, 0])), de(add(pos, [0, 0, e])) - de(add(pos, [0, 0, -e]))]);
    const upW = norm(add(scale(cam.u, 0.7), scale(grad, 0.3)));
    const kl = reset ? 1 : 1 - Math.exp(-dt / 0.6);
    const ku = reset ? 1 : 1 - Math.exp(-dt / 1.2);
    cam.up = norm(add(cam.up, scale(add(upW, scale(cam.up, -1)), ku)));
    // Look along the heading, pitched down onto the land ahead.
    const hd = norm(add(cam.h, scale(cam.up, -dot(cam.h, cam.up))));
    const pitch = 0.14;
    const want = norm(add(scale(hd, Math.cos(pitch)), scale(cam.up, -Math.sin(pitch))));
    cam.fwd = norm(add(cam.fwd, scale(add(want, scale(cam.fwd, -1)), kl)));

    p[3] = H;
    p[7] = g[3] + 0.06 * Math.sin(a[6] * 0.5);
    p[11] = 1.2 + 0.35 * g[6];
    p[12] = shape.c[0];
    p[13] = shape.c[1];
    p[14] = shape.c[2];
    p[15] = shape.n;
    p[16] = tax[0] * tang;
    p[17] = tax[1] * tang;
    p[18] = tax[2] * tang;
    p[19] = shape.np;
    // Sun, in the flyer's frame: from either side, between abeam and behind, so the folds ahead
    // are cross-lit.
    const sAz = (g[4] < 0.5 ? 1 : -1) * (0.9 + 1.2 * ((g[4] * 2) % 1));
    const sEl = 0.35 + 0.3 * ((g[4] * 7.3) % 1);
    const right = cross(cam.fwd, cam.up);
    const sun = norm(add(add(scale(cam.h, Math.cos(sAz)), scale(right, Math.sin(sAz))), scale(cam.u, Math.tan(sEl))));
    // The world is drawn inverted in the unit sphere, so the open space outside the set becomes a
    // closed hollow inside it: the land curves up ahead into the haze instead of falling away
    // below a horizon. Inversion mirrors directions across the local horizontal.
    const pr2 = dot(pos, pos);
    const flip = (v: V3): V3 => add(v, scale(cam.u, -2 * dot(v, cam.u)));
    p.set(scale(pos, 1 / pr2), 0);
    p.set(flip(cam.fwd), 4);
    p.set(flip(cam.up), 8);
    p.set(flip(sun), 20);
    p[23] = 0.5 + 0.6 * g[5] + 0.3 * m.tension;
    // Beat fronts: event ages and counts (the count sets the state behind each front), and the
    // pitches of the latest and previous melody notes.
    p[24] = morph.kickAge;
    p[25] = morph.snareAge;
    // Ages and counts carry their event's level: the note's in hundredths above its age; the kick
    // and snare counts are level-weighted sums (hundredths, wrapped) with the latest level in the
    // fraction (the snare's sum doubled, with the count's parity, for the side its ring starts on).
    p[26] = Math.min(morph.leadAge, 9.99) + 10 * Math.round(Math.min(1, morph.noteLevel) * 100);
    if (morph.snares !== cam.sN) {
      if (morph.snares > cam.sN && cam.sN >= 0) cam.sSum += cam.sLast;
      cam.sLast = morph.snareLevel;
      cam.sN = morph.snares;
    }
    p[27] = 2 * (Math.round((cam.sSum + cam.sLast) * 100) % 10000) + (morph.snares % 2) + 0.9 * Math.min(1, cam.sLast);
    if (morph.notes !== cam.notes) {
      cam.prevPitch = cam.pitch;
      // A faint note moves the lit contours only part of the way to its pitch.
      cam.pitch += (morph.notePitch - cam.pitch) * morph.noteLevel;
      cam.notes = morph.notes;
    }
    if (morph.kicks !== cam.kNotes) {
      if (morph.kicks > cam.kNotes && cam.kNotes >= 0) cam.kSum += cam.kLast;
      cam.kLast = morph.kickLevel;
      cam.kNotes = morph.kicks;
    }
    p[28] = cam.pitch;
    p[29] = cam.prevPitch;
    p[30] = g[7];
    p[31] = (Math.round((cam.kSum + cam.kLast) * 100) % 1000) + 0.9 * Math.min(1, cam.kLast);
  },
  wgsl: /* wgsl */ `
var<private> JC: vec3f;
var<private> JR: mat3x3f;

// Julia bulb of power n with a turn each iteration: distance and orbit traps.
fn jb_core(p: vec3f) -> vec4f {
  let n = S.p[3].w;
  let np = S.p[4].w;
  var z = p;
  var m = dot(z, z);
  var dz = 1.0;
  var tr = vec3f(1e9);
  for (var i = 0; i < 7; i++) {
    let r = sqrt(m);
    let rn1 = pow(r, n - 1.0);
    dz = max(n, np) * rn1 * dz;
    let zr = JR * z;
    let th = n * acos(clamp(zr.y / max(r, 1e-6), -1.0, 1.0));
    let ph = np * atan2(zr.x, zr.z);
    let rn = rn1 * r;
    z = JC + rn * vec3f(sin(th) * sin(ph), cos(th), sin(th) * cos(ph));
    m = dot(z, z);
    // Traps from the first iterations only: later ones are chaotic and would make the colour
    // flicker as the shape morphs.
    if (i < 3) { tr = min(tr, vec3f(m, abs(z.y), length(z.xz))); }
    if (m > 256.0) { break; }
  }
  return vec4f(0.25 * log(m) * sqrt(m) / dz, tr);
}

// The set seen inverted in the unit sphere (distances scaled by the local stretch).
fn jb_map(p: vec3f) -> vec4f {
  let s2 = dot(p, p);
  let r = jb_core(p / s2);
  return vec4f(r.x * s2 * 0.9, r.yzw);
}

fn jb_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * jb_map(p + k.xyy * e).x + k.yyx * jb_map(p + k.yyx * e).x +
                   k.yxy * jb_map(p + k.yxy * e).x + k.xxx * jb_map(p + k.xxx * e).x);
}

fn jb_ao(p: vec3f, n: vec3f, H: f32) -> f32 {
  var o = 0.0;
  var w = 1.0;
  for (var i = 1; i <= 4; i++) {
    let h = H * (0.05 + 0.2 * f32(i));
    o += (h - jb_map(p + n * h).x) * w;
    w *= 0.6;
  }
  return sat(1.0 - 1.6 * o / H);
}

fn jb_shadow(ro: vec3f, rd: vec3f, t0: f32, H: f32) -> f32 {
  var res = 1.0;
  var t = t0;
  for (var i = 0; i < 18; i++) {
    let h = jb_map(ro + rd * t).x;
    res = min(res, 8.0 * h / t);
    t += clamp(h, H * 0.03, H * 0.8);
    if (res < 0.005 || t > H * 12.0) { break; }
  }
  let s = sat(res);
  return s * s * (3.0 - 2.0 * s);
}

fn jb_haze(rd: vec3f, sun: vec3f, shift: f32) -> vec3f {
  return mix(palL(shift + 0.5, 0.32), palL(shift + 0.12, 0.7), pow(sat(dot(rd, sun)), 5.0) * 0.7);
}

// The haze: horizon glow toward the sun, deeper colour overhead.
fn jb_sky(rd: vec3f, up: vec3f, sun: vec3f, shift: f32) -> vec3f {
  let e = dot(rd, up);
  // Overhead is only more land, far across the hollow: haze, a little deeper in tone.
  var c = jb_haze(rd, sun, shift) * (1.0 - 0.3 * smoothstep(0.0, 0.8, e));
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[0].xyz;
  let H = S.p[0].w;
  let fw = normalize(S.p[1].xyz);
  let shift = S.p[1].w;
  let upR = normalize(S.p[2].xyz);
  let fl = S.p[2].w;
  let rt = normalize(cross(fw, upR));
  let cu = cross(rt, fw);
  let rd = normalize(fw * fl + rt * q.x + cu * q.y);
  JC = S.p[3].xyz;
  let tw = S.p[4].xyz;
  JR = rotAxis(tw / max(length(tw), 1e-6), length(tw));
  let sun = normalize(S.p[5].xyz);
  let fogK = S.p[5].w;

  // Stop at the pixel footprint: finer detail would only alias into dust.
  let pix = 1.4 / (F.res.y * fl);
  let far = H * 60.0;
  var t = H * 0.05;
  var hit = false;
  var r = vec4f(0.0);
  for (var i = 0; i < 150; i++) {
    r = jb_map(ro + rd * t);
    if (r.x < pix * t) { hit = true; break; }
    t += r.x * 0.9;
    if (t > far) { break; }
  }
  if (!hit && r.x < pix * t * 6.0 && t < far) { hit = true; }

  let sky = jb_sky(rd, upR, sun, shift);
  var col = sky;
  if (hit) {
    let pos = ro + rd * t;
    let n = jb_normal(pos, max(pix * t, 1e-6));
    let ao = jb_ao(pos, n, H);
    let sh = jb_shadow(pos + n * pix * t * 2.0, sun, pix * t * 4.0 + H * 0.01, H);
    let ndl = sat(dot(n, sun));
    let ndv = sat(dot(n, -rd));
    let fre = pow(1.0 - ndv, 5.0);

    // Every beat leaves the land changed, and the change travels: a front sweeps across it and
    // behind the front the land is in its new state.
    let kAge = S.p[6].x;
    let sAge = S.p[6].y;
    let lAge = S.p[6].z - 10.0 * floor(S.p[6].z / 10.0);
    let lL = floor(S.p[6].z / 10.0) / 100.0;
    let kicks = floor(S.p[7].w) / 100.0;
    let kL = fract(S.p[7].w) / 0.9;
    let sPk = floor(S.p[6].w);
    let snares = floor(sPk / 2.0) / 100.0;
    let sPar = sPk - 2.0 * floor(sPk / 2.0);
    let sL = fract(S.p[6].w) / 0.9;
    // Kick: a broad front rolling out from beneath the camera; behind it the stone's hue has
    // stepped on round the palette.
    let kf = H * (1.0 + kAge * 110.0);
    let kBehind = smoothstep(kf + H * 3.0, kf - H * 3.0, t);
    let landShift = shift + 0.1 * (kicks - kL * (1.0 - kBehind));
    // Snare: a sharp ring racing out across the land from a point ahead, off to alternating sides;
    // inside it the veins have moved to a new pattern in a new colour.
    let side = select(-1.0, 1.0, sPar > 0.5);
    let sOrigin = ro + fw * (H * 18.0) + rt * (side * H * 8.0);
    let sf = (length(pos - sOrigin) - H * (1.0 + sAge * 120.0)) / H;
    let sBehind = smoothstep(0.6, -0.6, sf);
    // Level-weighted: behind a faint snare's ring the veins shift and turn only a little.
    let sPh = snares - sL * (1.0 - sBehind);

    // Orbit-trap colouring through the palette, kept partly neutral (stone, not lava or glaze).
    let tr = r.yzw;
    let tc = sqrt(tr.x) * (0.9 + 0.6 * S.p[7].z);
    var alb = palL(landShift + 0.1 + 0.45 * tc, 0.32);
    let vein = smoothstep(0.12, 0.0, abs(fract(sqrt(tr.y) * 3.0 + 0.37 * sPh) - 0.5) - 0.36) * exp(-t / (H * 30.0));
    let sHue = palL(shift + 0.55 + 0.13 * sPh, 0.4);
    alb = mix(alb, sHue, vein * 0.75);
    // ...and the hollows take the snare's colour too.
    alb = mix(alb, sHue * 0.6, smoothstep(0.85, 0.35, ao) * 0.7);
    alb = mix(vec3f(luma(alb)), alb, 0.6);

    // Light: a warm-white key, and fill and shadow in the complementary hue of the key's tint, so
    // lit and shaded faces separate in colour whatever the palette.
    let keyHue = palL(shift + 0.1, 1.0);
    let sunCol = mix(vec3f(1.0), keyHue, 0.3) * 2.6;
    let compHue = max(vec3f(luma(keyHue)) * 2.0 - keyHue, vec3f(0.02));
    let fillCol = mix(compHue / max(luma(compHue), 0.02) * 0.2, palL(shift + 0.5, 0.2), 0.4);
    let dif = ndl * sh;
    let skyL = (0.5 + 0.5 * dot(n, upR)) * ao;
    let bounce = sat(0.5 - 0.5 * dot(n, upR)) * ao;
    col = alb * (sunCol * dif + fillCol * skyL + alb * 1.2 * bounce * (0.2 + 0.8 * ndl));
    // Restrained, rough specular and a faint rim, so the stone never reads as wet.
    let hal = normalize(sun - rd);
    col += sunCol * pow(sat(dot(n, hal)), 16.0) * dif * 0.05;
    col += palL(shift + 0.5, 0.3) * fre * ao * 0.35;

    // Light on the fronts themselves.
    let kw = (t - kf) / (H * 5.0);
    col += palL(landShift + 0.2, 2.2) * exp(-kw * kw) * exp(-kAge * 1.5) * smoothstep(0.0, 0.1, kAge) * kL * (0.3 + 0.7 * ao) * (0.4 + 0.6 * ndl);
    let edge = sat(ao * 1.6 - 0.6) * (0.35 + 0.65 * max(fre * 3.0, ndl));
    let sw = sf / 1.8;
    col += palL(shift + 0.55 + 0.13 * snares, 3.0) * exp(-sw * sw) * exp(-sAge * 1.2) * smoothstep(0.0, 0.08, sAge) * sL * (0.3 + 0.7 * edge);
    // Melody: the orbit-trap contours at the note's pitch level glow in the pitch's colour; each
    // note's front sweeps out across the land and moves the lit contours to its own level and hue.
    let pNew = S.p[7].x;
    let pOld = S.p[7].y;
    let lf = H * (1.5 + lAge * 40.0);
    let lBehind = smoothstep(lf + H * 2.0, lf - H * 2.0, t);
    let pitch = mix(pOld, pNew, lBehind);
    let lv = sqrt(tr.x) * 5.0 - pitch * 1.5;
    let line = smoothstep(0.16, 0.0, abs(fract(lv) - 0.5) - 0.34) * exp(-t / (H * 20.0));
    let lw = (t - lf) / (H * 4.0);
    let glow = 0.3 + 1.6 * exp(-lw * lw) * exp(-lAge * 1.2) * smoothstep(0.0, 0.12, lAge) * lL;
    col += palL(shift + 0.35 + 0.25 * pitch, 1.2) * line * glow * (0.4 + 0.6 * ao);
  }
  // Aerial perspective: mist that pools in the valleys (thinning with height above the ground the
  // camera skims) plus a thin haze over distance, lit toward the sun.
  let b = 1.0 / (2.5 * H);
  let y0 = H * 1.5;
  let ry = dot(rd, upR) * b;
  let span = select((1.0 - exp(-ry * t)) / ry, t, abs(ry) < 1e-4);
  let mist = min(fogK / (H * 60.0) * exp(-y0 * b) * span, 0.9);
  let fog = 1.0 - exp(-mist - t * fogK / (H * 75.0));
  if (hit) { col = mix(col, jb_haze(rd, sun, shift), fog); }
  return vec4f(min(col, vec3f(16.0)), 1.0);
}
`,
});
