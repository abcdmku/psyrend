import type { LayerDef } from '../layer';

const SEGS = 240; // segments along the stroke
const STRANDS = 14; // bristles across it

/**
 * The melody as the motion of a giant flat brush sweeping around you. The brush paints at the
 * playhead and the stroke stays in space as you fly through it, drying as it ages.
 *  - Where it is: an arc around the path. The melody's height lifts the brush; the chord carries
 *    it to its side of the arc (the root's place on the circle of fifths); every melodic turn of
 *    the gesture curls the stroke.
 *  - How it is laid: pressure (width) follows the melody's dynamics and each attack presses the
 *    brush; when the melody runs fast the bristles split into separate dry strands; a held note
 *    pools the ink thick and glossy; rests lift the brush, so phrases become separate strokes with
 *    ragged bristle ends. Harmonic tension rolls the flat brush toward its edge, so a tense chord
 *    draws a fine line and a resolved one a broad sweep.
 *  - Ink: the chord's colour, wet and luminous at the brush, drying darker behind it.
 * Every signal is sampled on a fixed time grid and joined by a cubic B-spline, so the stroke is
 * smooth however the score steps.
 */
export default {
  id: 'gesture-brush',
  role: 'form',
  source: 'once',
  verts: SEGS * STRANDS * 6,
  blend: 'opaque',
  weight: 0,
  layouts: ['flight', 'road', 'river', 'helix'],
  wgsl: /* wgsl */ `
/** Uniform cubic B-spline weights at u. */
fn gesture_brush_bw(u: f32) -> vec4f {
  let v = 1.0 - u;
  return vec4f(v * v * v, 3.0 * u * u * u - 6.0 * u * u + 4.0, -3.0 * u * u * u + 3.0 * u * u + 3.0 * u + 1.0, u * u * u) / 6.0;
}
/** Their derivatives (per knot interval). */
fn gesture_brush_bd(u: f32) -> vec4f {
  let v = 1.0 - u;
  return vec4f(-v * v, 3.0 * u * u - 4.0 * u, -3.0 * u * u + 2.0 * u + 1.0, u * u) * 0.5;
}

struct GestureBrushPath { c: vec3f, side: vec3f, up: vec3f };
/** The layout's path at path time t, splined on a 0.6 s grid (smooth even where a layout steps). */
fn gesture_brush_path(t: f32) -> GestureBrushPath {
  var o: GestureBrushPath;
  let x = t / 0.6;
  let i = floor(x);
  let w = gesture_brush_bw(x - i);
  let d = gesture_brush_bd(x - i);
  let p0 = LCenter((i - 1.0) * 0.6);
  let p1 = LCenter(i * 0.6);
  let p2 = LCenter((i + 1.0) * 0.6);
  let p3 = LCenter((i + 2.0) * 0.6);
  o.c = p0 * w.x + p1 * w.y + p2 * w.z + p3 * w.w;
  var f = p0 * d.x + p1 * d.y + p2 * d.z + p3 * d.w;
  f = select(vec3f(0.0, 0.0, 1.0), normalize(f), length(f) > 1e-6);
  var up = LUp(t) - f * dot(LUp(t), f);
  up = select(frameX(t, f), normalize(up), length(up) > 1e-3);
  o.up = up;
  o.side = cross(up, f);
  return o;
}

struct GestureBrushKnot { off: vec2f, brush: vec4f, ink: vec3f, ang: f32 };
/** The brush at music time t: offset on its arc, (pressure, dryness, pooling, roll), ink, arc angle. */
fn gesture_brush_knot(t: f32) -> GestureBrushKnot {
  var o: GestureBrushKnot;
  let dt = t - F.songTime;
  // Harmony: the side of the arc (the root's bank on the circle of fifths), tension and colour.
  var bank = 0.0;
  var ten = 0.0;
  var ink = vec3f(0.0);
  for (var k = -1; k <= 1; k++) {
    let ch = chordAtT(dt + f32(k) * 0.25);
    let root = floor(ch.x * 13.0 - 0.5);
    let has = ch.x > 0.02 && root >= 0.0;
    bank += select(0.0, sin(fifthsAng(root)), has);
    ten += select(0.2, ch.z, has);
    ink += palL(select(S.p[3].x + 0.1, S.p[3].x + pitchHue(root) * 0.55, has), 1.0);
  }
  bank /= 3.0;
  ten /= 3.0;
  o.ink = ink / 3.0;
  let g = gestAt(t);
  let m = g.fwd.w;
  let act = g.pos.w;
  let ons = g.up.w;
  // The gesture's own turning (its deviation from its chord), so each interval curls the stroke.
  let dev = g.pos.xyz - (gestAt(t - 0.6).pos.xyz + gestAt(t + 0.6).pos.xyz) * 0.5;
  let gr = normalize(cross(g.fwd.xyz, g.up.xyz));
  let curl = vec2f(dot(dev, gr), dot(dev, g.up.xyz)) * 3.0;
  let R = 2.6 + 8.0 * S.p[0].y;
  // On an arc around the path: overhead by default, swung toward the chord's side, lifted by the melody.
  o.ang = PI * 0.5 - bank * 0.7;
  let r = R * (0.9 + 0.35 * m);
  o.off = vec2f(cos(o.ang) * r + curl.x, sin(o.ang) * r - 0.55 * R + 0.5 * R * m + curl.y);
  // How the brush is used: the melody's dynamics press it, fast runs dry it, held notes pool it.
  let s = leadAt(dt).y;
  let pres = smoothstep(0.03, 0.3, max(s, act * 0.9));
  let press = pres * (0.55 + 0.25 * s + 0.5 * ons);
  let mv = abs(gestAt(t + 0.1).fwd.w - gestAt(t - 0.1).fwd.w) * 5.0;
  let dry = sat(smoothstep(0.35, 0.85, act) + 0.6 * smoothstep(0.4, 1.6, mv));
  // A hold: the lead still sounding ~0.5 s after its last attack (the onset envelope has died away).
  let pool = smoothstep(0.15, 0.45, s) * (1.0 - smoothstep(0.004, 0.05, ons)) * (1.0 - act);
  // Tension turns the nib toward its edge; the chord's bank tilts it.
  let roll = 0.1 + 0.9 * smoothstep(0.25, 0.9, ten) + 0.35 * bank;
  o.brush = vec4f(press, dry, pool, roll);
  return o;
}

fn vs_gesture_brush(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let quad = vi / 6u;
  let cc = vi % 6u;
  let strand = quad % ${STRANDS}u;
  let seg = quad / ${STRANDS}u;
  let span = worldPast() + 0.6;
  let age = span * (1.0 - (f32(seg) + qv(cc)) / ${SEGS}.0);
  let t = F.songTime - age;

  // The stroke is laid far enough ahead along the path that its wet end is always in view.
  let c0 = LCenter(F.songTime);
  let fw = LCenter(F.songTime + 0.5) - LCenter(F.songTime - 0.5);
  let vel = max(length(fw), 1e-3);
  let dcam = dot(c0 - camEye(), fw / vel) / vel;
  let lead = clamp(2.2 - dcam, 0.0, 2.2);

  // Brush state: four knots on a 0.12 s grid, splined.
  let KD = 0.12;
  let x = t / KD;
  let i = floor(x);
  let u = x - i;
  let k0 = gesture_brush_knot((i - 1.0) * KD);
  let k1 = gesture_brush_knot(i * KD);
  let k2 = gesture_brush_knot((i + 1.0) * KD);
  let k3 = gesture_brush_knot((i + 2.0) * KD);
  let w = gesture_brush_bw(u);
  let eps = 0.15;
  let w2 = gesture_brush_bw(u + eps);
  let off = k0.off * w.x + k1.off * w.y + k2.off * w.z + k3.off * w.w;
  let off2 = k0.off * w2.x + k1.off * w2.y + k2.off * w2.z + k3.off * w2.w;
  let br = k0.brush * w.x + k1.brush * w.y + k2.brush * w.z + k3.brush * w.w;
  let ink = k0.ink * w.x + k1.ink * w.y + k2.ink * w.z + k3.ink * w.w;
  let ang = k0.ang * w.x + k1.ang * w.y + k2.ang * w.z + k3.ang * w.w;
  let press = br.x;
  let dry = sat(br.y);
  let pool = sat(br.z);
  let roll = br.w;

  let pa = gesture_brush_path(t + lead);
  let pb = gesture_brush_path(t + lead + eps * KD);
  let C = pa.c + pa.side * off.x + pa.up * off.y;
  let C2 = pb.c + pb.side * off2.x + pb.up * off2.y;
  var T = C2 - C;
  T = select(vec3f(0.0, 0.0, 1.0), normalize(T), length(T) > 1e-6);
  // A broad nib held at an angle in the cross-section, like a calligrapher's pen: it lies along the
  // arc (facing you) when the harmony is at rest and turns toward its edge with tension. The stroke
  // is broad where it moves across the nib and a hairline where it moves along it.
  let arcT = pa.up * cos(ang) - pa.side * sin(ang);
  let radial = pa.side * cos(ang) + pa.up * sin(ang);
  let B = arcT * cos(roll) + radial * sin(roll);
  var N = cross(B, T);
  N = select(radial, normalize(N), length(N) > 1e-5);

  // Bristles: each strand's place across the brush, its share of the width and when it drops out.
  let K = f32(${STRANDS}u);
  let kf = f32(strand);
  let hs = hashU3(strand * 7u + 3u);
  // The brush tip: at the playhead the bristles gather to the point of the brush.
  let tip = smoothstep(0.0, 0.14, age);
  let ac = (-1.0 + (2.0 * kf + 1.0 + (hs.y - 0.5) * 0.8 * dry) / K) * (1.0 + 0.35 * dry) * mix(0.08, 1.0, sqrt(tip));
  let thr = hs.x * 0.28 + abs(ac) * 0.2;
  let sw = smoothstep(thr, thr + 0.12, press);
  let hw = (1.0 / K) * mix(1.5, 0.3 + 0.6 * hs.z, dry) * sw * mix(0.08, 1.0, sqrt(tip));
  let a = ac + (qu(cc) * 2.0 - 1.0) * hw;
  // Where the stroke sweeps past the lens it thins away rather than filling the frame.
  let near = smoothstep(1.0, 3.5, length(C - camEye()));
  let Wd = (0.3 + 1.4 * S.p[0].y) * press * (1.0 + 0.35 * pool + 0.15 * dry) * near;
  let th = Wd * (0.06 + 0.45 * pool);
  if (sw < 1e-3 || Wd < 1e-3) { return hidden(); }
  let p = C + B * (a * Wd) + N * (th * (1.0 - a * a) + kf * 1e-3);
  o.pos = toClip(p);
  o.wp = p;
  o.nrm = normalize(N + B * (2.0 * a * th / max(Wd, 1e-3)));
  o.a = vec4f(age, a, pool, dry);
  o.b = vec4f(dry, kf, 0.0, 0.0);
  o.c = vec4f(ink, 0.0);
  return o;
}

fn fs_gesture_brush(in: LOut) -> vec4f {
  let age = in.a.x;
  let pool = in.a.z;
  let ink = in.c.rgb;
  // Wet at the brush, drying darker behind it; pools stay wet longer.
  let wet = exp(-age / (0.7 + 1.5 * pool));
  // Each bristle leaves its own streak, strongest where the brush runs dry.
  let tone = 1.0 + (hashU(u32(in.b.y) * 13u + 5u) - 0.5) * (0.1 + 0.25 * in.b.x);
  let base = ink * mix(0.16, 0.6, wet) * tone;
  let emis = ink * (0.04 + 0.9 * wet * wet) * tone * S.p[3].y;
  return vec4f(shade(base, emis, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
