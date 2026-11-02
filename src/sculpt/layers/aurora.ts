import type { LayerDef } from '../layer';

const SEGS = 640;
const CURTAINS = 2;
/** Taps of the easing filter over the lead line (~0.5 s of history at 35 ms). */
const TAPS = 15;

/**
 * An aurora the melody writes across the sky. A pen of light runs a few seconds ahead of you along
 * the path, and the main curtain is drawn up to it in real time: its lower border is the lead line.
 * Each new note moves the border to the note's height through a short spring (about 0.2 s, a
 * slight overshoot, then still), and the curtain swings sideways as it goes and settles again, so
 * every note is a visible gesture of the sky. Each attack leaves a bright ray where it was written
 * and launches a bright fold that runs back along the curtain over what was already written. The
 * written phrase stays in the sky as you fly along it; rests let the border hold and dim.
 *
 * Across the path a second, fainter curtain carries the phrase: the same line eased over a couple
 * of seconds. Colour comes from the harmony (the border in the chord root's colour, the crown in
 * its third's), brightness from how busy the melody is.
 */
export default {
  id: 'aurora',
  role: 'sky',
  darkOnly: true,
  source: 'once',
  verts: CURTAINS * SEGS * 6,
  blend: 'additive',
  weight: 1,
  layouts: ['flight', 'road', 'river', 'helix'],
  wgsl: /* wgsl */ `
/** Seconds of melody the curtain keeps behind the pen. */
const AURORA_TRAIL: f32 = 14.0;
/** How far ahead along the path (in seconds of travel) the pen writes. */
const AURORA_LEAD: f32 = 6.0;
/** Seconds an attack's fold runs along the curtain. */
const AURORA_LIFE: f32 = 1.6;
const AURORA_DX: f32 = 0.035;

/** Spring step response: reaches the note in ~0.2 s with a ~10% overshoot, settled by ~0.45 s. */
fn aurora_spring(x: f32) -> f32 {
  let w = 18.0;
  let z = 0.6;
  let wd = w * 0.8;
  return 1.0 - exp(-z * w * x) * (cos(wd * x) + z / 0.8 * sin(wd * x));
}
/** A plain lag (~0.3 s): the curtain's sideways swing is how far the spring runs ahead of it. */
fn aurora_lag(x: f32) -> f32 { return 1.0 - exp(-x / 0.3); }

/** Lead line at song time t: x = height (octaves from the melodic centre), y = sounding (0/1). */
fn aurora_leadRow(t: f32) -> vec2f {
  let r = clamp(i32(floor(F.scoreRow + (t - F.songTime) * F.scoreRate)), 0, max(i32(F.scoreTexRows) - 1, 0));
  let c = textureLoad(eventsTex, vec2i(3, r), 0);
  let on = c.x > 0.001 && c.y > 0.02 && F.scoreRows > 0.0;
  let pitch = floor(28.0 + c.x * 72.0 + 0.5);
  return vec2f((pitch - S.p[0].z) / 12.0, select(0.0, 1.0, on));
}

/**
 * The written line at song time t: x = border height (sprung), y = sideways swing, z = how much
 * the lead sounds (eased). Short gaps hold the last note; long rests settle toward the centre.
 */
fn aurora_line(t: f32) -> vec3f {
  var hold = melodyHeight(t - f32(${TAPS}) * AURORA_DX);
  var hs = 0.0;
  var hl = 0.0;
  var on = 0.0;
  for (var i = ${TAPS - 1}; i >= 0; i--) {
    let x0 = f32(i) * AURORA_DX;
    let x1 = x0 + AURORA_DX;
    let g = aurora_leadRow(t - x0);
    hold = select(hold, g.x, g.y > 0.5);
    // The oldest tap carries everything the filters have not yet absorbed.
    let last = i == ${TAPS - 1};
    let ws = select(aurora_spring(x1) - aurora_spring(x0), 1.0 - aurora_spring(x0), last);
    let wl = select(aurora_lag(x1) - aurora_lag(x0), 1.0 - aurora_lag(x0), last);
    hs += ws * hold;
    hl += wl * hold;
    on += wl * g.y;
  }
  return vec3f(hs, hs - hl, on);
}

/** The phrase: the line eased over ~2 s, for the far curtain. */
fn aurora_phrase(t: f32) -> f32 {
  var s = 0.0;
  var w = 0.0;
  for (var i = -4; i <= 4; i++) {
    let x = f32(i) / 4.0;
    let k = exp(-x * x * 2.0);
    s += melodyHeight(t + x * 1.6) * k;
    w += k;
  }
  return s / w;
}

/** First note in the window starting after t. */
fn aurora_after(t: f32) -> u32 {
  var lo = u32(W.n.x);
  var hi = lo + u32(W.n.y);
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi) / 2u;
    if (notes[mid].start <= t) { lo = mid + 1u; } else { hi = mid; }
  }
  return lo;
}

/** Folds launched by recent attacks, running back along the written curtain from the pen. */
fn aurora_folds(t: f32) -> f32 {
  let now = F.songTime;
  let first = u32(W.n.x);
  var k = aurora_after(now);
  var out = 0.0;
  var guard = 0u;
  loop {
    if (k <= first || guard >= 48u) { break; }
    k -= 1u;
    guard += 1u;
    let n = notes[k];
    let age = now - n.start;
    if (age > AURORA_LIFE) { break; }
    if (u32(n.role + 0.5) != 0u) { continue; }
    let x = (t - (n.start - age * 3.2)) / (0.12 + 0.2 * age);
    out += exp(-x * x) * (1.0 - age / AURORA_LIFE) * exp(-age * 1.2) * (0.5 + 0.5 * n.strength);
  }
  return out;
}

struct AuroraRay { base: vec3f, up: vec3f, len: f32, lum: f32 };
/** Curtain c's ray for melody written at song time t: where its lower border is and how bright. */
fn aurora_ray(t: f32, c: u32) -> AuroraRay {
  let u = max(S.p[0].x, 1.0) / 3.5;
  let isMain = c == 0u;
  // Where it hangs: the pen writes ahead along the path; what it wrote stays where it was written.
  let s = t + AURORA_LEAD;
  var C = LCenter(s);
  // The sky is far away: it keeps most of its altitude while the path climbs and dives toward it.
  C.y = mix(C.y, LCenter(F.songTime).y, 0.7);
  var fw = LCenter(s + 0.6) - LCenter(s - 0.6);
  if (length(fw) < 1e-4) { fw = vec3f(0.0, 0.0, 1.0); }
  fw = normalize(fw);
  // Rays hang close to vertical, leaning only half-way into the path's bank.
  let u0 = normalize(LUp(s) + vec3f(0.0, 1.001, 0.0));
  var rt = cross(fw, u0);
  if (length(rt) < 1e-4) { rt = vec3f(1.0, 0.0, 0.0); }
  rt = normalize(rt);
  let up = cross(rt, fw);
  var h = 0.0;
  var swing = 0.0;
  var on = 0.0;
  var fold = 0.0;
  if (isMain) {
    let ln = aurora_line(t);
    h = ln.x;
    swing = ln.y;
    on = ln.z;
    fold = aurora_folds(t);
  } else {
    h = aurora_phrase(t);
    on = sat(melodyActivity(t) * 2.0);
  }
  // (across, border height, height per octave, ray length)
  let sh = select(vec4f(16.0, 5.0, 4.0, 20.0), vec4f(-3.5, 1.0, 5.0, 10.0), isMain);
  let side = select(1.0, -1.0, sh.x < 0.0);
  var r: AuroraRay;
  // A note's step lifts the border; the swing and each travelling fold push the sheet outward.
  r.base = C + rt * (sh.x + side * (swing * 8.0 + fold * 1.2)) * u + up * (sh.y + sh.z * h) * u;
  r.up = up;
  r.len = sh.w * u * (0.7 + 0.4 * melodyActivity(t));
  // The newest writing burns at the pen and cools as it ages; attacks leave bright rays.
  let age = F.songTime - t;
  let pen = 1.0 + 1.6 * exp(-age / 0.18);
  let atk = select(0.0, 2.6 * melodyOnset(t), isMain);
  r.lum = select(0.4, 1.0, isMain) * (0.15 + 0.85 * on) * pen * exp(-age * 0.12) * (1.0 + atk) + 2.4 * fold;
  return r;
}

fn vs_aurora(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = vi / 6u;
  let cc = vi % 6u;
  let c = q / ${SEGS}u;
  let sg = q % ${SEGS}u;
  let fs = (f32(sg) + qu(cc)) / ${SEGS}.0;
  // The sheet starts a little below its border, for the soft glow under the lower edge.
  let v = qv(cc) * 1.08 - 0.08;
  let now = F.songTime;
  // Written up to the pen, never beyond.
  let t = now - AURORA_TRAIL + fs * AURORA_TRAIL;
  let r = aurora_ray(t, c);
  let r2 = aurora_ray(t - 0.04, c);
  let p = r.base + r.up * r.len * v;
  // A sheet seen edge-on is a long path through glowing air: the folds burn brighter.
  let eye = camEye();
  let tng = r.base - r2.base;
  let n = normalize(cross(tng + vec3f(0.0, 0.0, 1e-6), r.up));
  let ndv = abs(dot(n, normalize(eye - p)));
  let edge = 0.45 + 0.55 * 0.25 / (0.25 + ndv);
  // The far end of the trail fades out; the pen's tip is cut cleanly.
  let ends = smoothstep(0.0, 0.18, fs) * smoothstep(1.0, 0.996, fs);
  o.pos = toClip(p);
  o.wp = p;
  o.nrm = n;
  o.a = vec4f(v, r.lum * ends, edge, t - now);
  o.b = vec4f(eye, 0.0);
  return o;
}

/** Colours of the chord at dt: [0] its root, [1] its third, eased over ~0.5 s. */
fn aurora_chordCols(dt: f32) -> array<vec3f, 2> {
  var root = vec3f(0.0);
  var third = vec3f(0.0);
  for (var i = -1; i <= 1; i++) {
    let ch = chordAtT(dt + f32(i) * 0.25);
    let pc = ch.x * 13.0 - 1.0;
    let iv = select(3.0, 4.0, ch.y > 0.75);
    let none = palL(S.p[3].x + 0.1, 1.0);
    root += select(none, palL(S.p[3].x + pitchHue(pc) * 0.55 + 0.5, 1.0), ch.x > 0.02);
    third += select(none, palL(S.p[3].x + pitchHue(pc + iv) * 0.55 + 0.5, 1.0), ch.x > 0.02);
  }
  return array<vec3f, 2>(root / 3.0, third / 3.0);
}

fn fs_aurora(in: LOut) -> vec4f {
  let v = in.a.x;
  // A crisp lower border with a faint glow beneath it, then light thinning upward along the rays.
  let aa = fwidth(v);
  let border = smoothstep(-aa, 0.015 + aa * 1.5, v);
  let vp = max(v, 0.0);
  let fall = (exp(-vp * 4.5) * 0.6 + 0.05 + 0.9 * exp(-vp * 40.0)) * (1.0 - vp) * (1.0 - vp);
  let below = exp(min(v, 0.0) * 45.0) * 0.3;
  let cols = aurora_chordCols(in.a.w);
  let col = mix(cols[0], cols[1], smoothstep(0.08, 0.7, v));
  let eye = in.b.xyz;
  // The sky lies above the haze: it dims with distance more gently than the ground.
  let k = mix(below, fall, border) * in.a.y * in.a.z * S.p[3].y * 0.5;
  return glowOut(col * k, eye + (in.wp - eye) * 0.45);
}
`,
} satisfies LayerDef;
