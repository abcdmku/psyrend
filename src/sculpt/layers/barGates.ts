import type { LayerDef } from '../layer';

const BARS = 16; // bar slots around the playhead (past + future window)
const SIDES_MAX = 8;
const FACE_V = 4 * 6; // outer, inner, front, back faces per frame side
const FRAME_V = SIDES_MAX * FACE_V;
const PER_BAR = 4 * FRAME_V; // one gate (downbeat) + three ribs (beats 2-4)

/**
 * The meter as architecture. Every downbeat raises a solid polygonal gate across the time axis;
 * beats 2-4 are thin ribs between gates, so you fly down a vaulted nave whose bays are bars.
 * Hierarchy reads by mass: section starts are monumental (deeper, thicker, doubled lintel glow),
 * the first bar of every 4-bar phrase is taller, plain bars are standard, beats are ribs.
 * Gates ahead are dark with only their edges drawn (a blueprint); the downbeat lights the gate as
 * it is played and it cools to a lit outline. Ribs glow with the kick/snare that lands on them.
 * Gate size is measured from the layout itself (where notes can sit), so it frames any layout.
 */
export default {
  id: 'bar-gates',
  role: 'enclosure',
  darkOnly: true,
  source: 'once',
  verts: BARS * PER_BAR,
  blend: 'opaque',
  weight: 0.4,
  // Not flight: square gates on a banking path tilt and slice through the camera.
  layouts: ['road', 'river', 'helix', 'spiral'],
  consts(rand) {
    const sides = [4, 6, 8][Math.floor(rand() * 3) % 3];
    return { wgsl: `const BAR_GATES_SIDES: u32 = ${sides}u;`, key: `${sides}` };
  },
  wgsl: /* wgsl */ `
fn bar_gates_barLen() -> f32 { return 240.0 / max(F.bpm, 40.0); }
/** Exact downbeat near an estimate, recovered from the score's bar pulse (exp decay 0.2 s). */
fn bar_gates_snap(te: f32) -> f32 {
  let probe = te + 0.15;
  let p = gridAt(probe - F.songTime).y;
  let off = probe + 0.2 * log(max(p, 1e-4));
  return select(te, off, p > 0.3 && abs(off - te) < 0.2);
}
/** Half extents (side, up) and centre offset of where the layout can place notes, plus margin. */
fn bar_gates_extent(t: f32, side: vec3f, up: vec3f) -> vec4f {
  let c = LCenter(t);
  var lo = vec2f(1e5);
  var hi = vec2f(-1e5);
  for (var k = 0u; k < 5u; k++) {
    let pitch = S.p[0].z - 24.0 + f32(k) * 9.0;
    for (var l = 0u; l < 2u; l++) {
      let d = L(t, pitch, select(-1.0, 1.0, l == 1u)) - c;
      let q = vec2f(dot(d, side), dot(d, up));
      lo = min(lo, q);
      hi = max(hi, q);
    }
  }
  let half = max((hi - lo) * 0.5, vec2f(0.6)) + vec2f(0.55, 0.75);
  return vec4f(half, (hi + lo) * 0.5);
}

fn vs_bar_gates(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let bar = vi / ${PER_BAR}u;
  let rem = vi % ${PER_BAR}u;
  let beat = rem / ${FRAME_V}u; // 0 = the gate (downbeat), 1..3 = ribs
  let fr = rem % ${FRAME_V}u;
  let sideIdx = fr / ${FACE_V}u;
  let face = (fr % ${FACE_V}u) / 6u;
  let cc = fr % 6u;
  let N = BAR_GATES_SIDES;
  if (sideIdx >= N) { return hidden(); }
  // Ribs are open arches (no floor side), so beats read as the vault between bar gates.
  if (beat > 0u && sideIdx == N - 1u) { return hidden(); }

  let BL = bar_gates_barLen();
  let k = f32(bar) - 3.0; // three bars of past
  let tNow0 = F.songTime - F.barPhase * BL;
  let tb = select(bar_gates_snap(tNow0 + k * BL), tNow0, bar == 3u);
  let tn = bar_gates_snap(tNow0 + (k + 1.0) * BL);
  let t = mix(tb, tn, f32(beat) / 4.0);
  let dt = t - F.songTime;
  if (dt < -S.p[1].x - 1.2 || dt > S.p[1].y) { return hidden(); }

  // Section start / phrase from the score: progress drops across a section boundary.
  let pa = gridAt(tb - F.songTime - 0.12).w;
  let pb = gridAt(tb - F.songTime + 0.12).w;
  let ka = gridAt(tb - F.songTime - 0.12).z;
  let kb = gridAt(tb - F.songTime + 0.12).z;
  let isSec = pb + 0.002 < pa || abs(ka - kb) > 0.05;
  let pm = gridAt(tb - F.songTime + BL * 0.5).w;
  let secLen = BL * 0.38 / max(pm - pb, 1e-4);
  let barsIn = round(pb * secLen / BL);
  let isPhrase = !isSec && fmod(barsIn, 4.0) < 0.5 && pm > pb;
  let tier = select(select(select(1.0, 2.0, isPhrase), 3.0, isSec), 0.0, beat > 0u); // 0 rib, 1 bar, 2 phrase, 3 section

  // Frame across the time axis at t.
  let c = LCenter(t);
  var ax = LCenter(t + 0.05) - c;
  if (length(ax) < 1e-5) { return hidden(); }
  ax = normalize(ax);
  var up = LUp(t) - ax * dot(LUp(t), ax);
  if (length(up) < 1e-3) { up = frameX(t, ax); }
  up = normalize(up);
  let side = cross(up, ax);
  let ex = bar_gates_extent(F.songTime, side, up);

  let grow = select(select(1.0, 1.1, tier > 1.5), 1.45, tier > 2.5);
  let tall = select(1.0, 1.18, tier > 1.5 && tier < 2.5);
  let rad = vec2f(ex.x * grow, ex.y * grow * tall) / cos(PI / f32(N));
  let ctr = vec2f(ex.z, ex.w + ex.y * grow * (tall - 1.0));
  let unit = (ex.x + ex.y) * 0.5;
  let th = unit * select(select(select(0.025, 0.07, tier > 0.5), 0.1, tier > 1.5), 0.2, tier > 2.5);
  let dep = unit * select(select(select(0.025, 0.12, tier > 0.5), 0.16, tier > 1.5), 0.6, tier > 2.5);

  let u = qu(cc);
  let v = qv(cc);
  let a0 = (f32(sideIdx) + 0.5) / f32(N) * TAU - PI * 0.5;
  let a1 = (f32(sideIdx) + 1.5) / f32(N) * TAU - PI * 0.5;
  let p0 = ctr + vec2f(cos(a0), sin(a0)) * rad;
  let p1 = ctr + vec2f(cos(a1), sin(a1)) * rad;
  let tng = normalize(p1 - p0);
  let n2 = vec2f(tng.y, -tng.x);
  // Inner edge: offset each corner along the bisector so sides meet cleanly.
  let m0 = normalize(vec2f(cos(a0), sin(a0)) * vec2f(rad.y, rad.x));
  let m1 = normalize(vec2f(cos(a1), sin(a1)) * vec2f(rad.y, rad.x));
  let i0 = p0 - m0 * th / max(dot(m0, n2), 0.3);
  let i1 = p1 - m1 * th / max(dot(m1, n2), 0.3);
  let po = mix(p0, p1, u);
  let pin = mix(i0, i1, u);
  var q2: vec2f;
  var along: f32;
  var nrm: vec3f;
  if (face == 0u) { q2 = po; along = v - 0.5; nrm = side * n2.x + up * n2.y; }
  else if (face == 1u) { q2 = pin; along = v - 0.5; nrm = -(side * n2.x + up * n2.y); }
  else if (face == 2u) { q2 = mix(po, pin, v); along = -0.5; nrm = -ax; }
  else { q2 = mix(po, pin, v); along = 0.5; nrm = ax; }
  let wp = c + side * q2.x + up * q2.y + ax * along * dep;
  o.pos = toClip(wp);
  o.wp = wp;
  o.nrm = nrm;
  o.a = vec4f(u, v, f32(face), 0.0);
  // Drum weight of the beat this frame stands on.
  let dr = drumsAt(dt + 0.02);
  o.b = vec4f(t, tier, kb, sat(dr.x + dr.y * 0.8));
  o.c = vec4f(f32(beat), dep, th, 0.0);
  return o;
}

fn fs_bar_gates(in: LOut) -> vec4f {
  let t = in.b.x;
  let tier = in.b.y;
  let dt = t - F.songTime;
  let age = -dt;
  let hue = S.p[3].x + in.b.z * 0.62 + 0.08;
  let col = palL(hue, 1.0);
  // Crisp box edges: the across-face coordinate hits 0 or 1 at a real edge.
  let e = min(in.a.y, 1.0 - in.a.y);
  let ew = fwidth(in.a.y) * 1.3;
  let edge = 1.0 - smoothstep(ew * 0.6, ew * 1.6, e);
  let played = step(0.0, age);
  let vis = select(exp(-dt * 0.12), exp(-age * 0.35), age >= 0.0);
  let flash = played * exp(-age * select(3.0, 1.6, tier > 0.5));
  let rank = select(select(select(0.35, 0.6, tier > 0.5), 0.85, tier > 1.5), 1.2, tier > 2.5);
  let drum = select(1.0, 0.35 + 1.4 * in.b.w, tier < 0.5);
  // Ahead: dark stone with drawn edges. Played: lit by its downbeat, cooling to a glowing outline.
  // The downbeat lights the gate's outline; its face only glows faintly, so a gate passing the
  // camera never floods the frame.
  let edgeK = (0.25 + 0.55 * played + 2.0 * flash) * rank * drum;
  let faceK = flash * (0.25 + 0.25 * select(0.0, 1.0, tier > 2.5)) * rank * drum + played * 0.04 * rank;
  let emis = col * (edge * edgeK + faceK) * vis * S.p[3].y;
  let base = palL(hue + 0.5, 0.12) * (0.4 + 0.6 * played);
  return vec4f(shade(base, emis, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
