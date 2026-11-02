import type { LayerDef } from '../layer';

const BARS = 18; // bar slots: 3 behind the playhead, the rest ahead
const BOX_V = 36;
const PER_BAR = 4 * BOX_V; // left/right wall block + left/right section tower

/**
 * The song's form as a skyline. Both sides of the time axis are walled with one stone block per
 * bar; each section shapes its blocks by kind and raises them by its energy:
 *   intro  low steps rising per phrase      verse     steady wall, phrase pilasters
 *   build  a ramp climbing bar by bar       peak      tall crenellated wall
 *   breakdown  low, broken half-bar stones  bridge    a raised deck floating over a gap
 *   outro  steps descending to the end
 * Every section start stands a tower whose height is the coming section's energy, so the next
 * part of the song is visible approaching. Blocks light along their top as the bar is played.
 * Section bounds come from the score's section progress; energy from its drum/onset density.
 */
export default {
  id: 'section-monoliths',
  role: 'world',
  darkOnly: true,
  source: 'once',
  verts: BARS * PER_BAR,
  blend: 'opaque',
  weight: 0,
  layouts: ['road', 'river', 'helix', 'spiral'],
  wgsl: /* wgsl */ `
fn section_monoliths_barLen() -> f32 { return 240.0 / max(F.bpm, 40.0); }
fn section_monoliths_snap(te: f32) -> f32 {
  let probe = te + 0.15;
  let p = gridAt(probe - F.songTime).y;
  let off = probe + 0.2 * log(max(p, 1e-4));
  return select(te, off, p > 0.3 && abs(off - te) < 0.2);
}
/** Section containing song time tq: (start, length, kind 0..6). */
fn section_monoliths_secAt(tq: f32) -> vec3f {
  let g = gridAt(tq - F.songTime);
  let qb = gridAt(tq + 3.0 - F.songTime).w;
  var len = 3.0 / max(qb - g.w, 1e-4);
  if (qb <= g.w + 1e-4) { len = 3.0 / max(g.w - gridAt(tq - 3.0 - F.songTime).w, 1e-4); }
  return vec3f(tq - g.w * len, len, round(g.z * 6.0));
}
/** Canonical section bounds (precise, identical for every bar in it) and its energy 0..1. */
fn section_monoliths_section(tq: f32) -> vec4f {
  let rough = section_monoliths_secAt(tq);
  let s = section_monoliths_secAt(rough.x + 0.5);
  var e = 0.0;
  for (var j = 0u; j < 16u; j++) {
    let d = drumsAt(s.x + s.y * (f32(j) + 0.5) / 16.0 - F.songTime);
    e += d.w + 0.5 * d.x + 0.3 * d.y;
  }
  return vec4f(s.x, s.y, s.z, sat(e / 16.0 * 2.2));
}
fn section_monoliths_extent(t: f32, side: vec3f, up: vec3f) -> vec4f {
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
  return vec4f(max((hi - lo) * 0.5, vec2f(0.6)), (hi + lo) * 0.5);
}
/** Frame at t: side, up, axis. Axis is zero when the layout has no time axis. */
fn section_monoliths_frame(t: f32) -> mat3x3f {
  var ax = LCenter(t + 0.05) - LCenter(t);
  if (length(ax) < 1e-5) { return mat3x3f(vec3f(0.0), vec3f(0.0), vec3f(0.0)); }
  ax = normalize(ax);
  var up = LUp(t) - ax * dot(LUp(t), ax);
  if (length(up) < 1e-3) { up = frameX(t, ax); }
  up = normalize(up);
  return mat3x3f(cross(up, ax), up, ax);
}
/** Block height profile (fraction of the full height) and floor lift for a bar. */
fn section_monoliths_profile(kind: f32, prog: f32, phase: f32, barsIn: f32) -> vec2f {
  let k = u32(kind + 0.5);
  if (k == 0u) { return vec2f(0.25 + 0.5 * floor(prog * 4.0) / 3.0, 0.0); }
  if (k == 1u) { return vec2f(select(0.6, 0.75, fmod(barsIn, 4.0) < 0.5), 0.0); }
  if (k == 2u) { return vec2f(0.2 + 0.85 * prog, 0.0); }
  if (k == 3u) { return vec2f(select(1.0, 0.82, fmod(barsIn, 2.0) > 0.5), 0.0); }
  if (k == 4u) { return vec2f(0.22, 0.0); }
  if (k == 5u) { return vec2f(0.7, 0.42); }
  return vec2f(0.75 * (1.0 - floor(prog * 4.0) / 4.0) + 0.1, 0.0);
}

fn vs_section_monoliths(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let bar = vi / ${PER_BAR}u;
  let rem = vi % ${PER_BAR}u;
  let box = rem / ${BOX_V}u; // 0/1 wall block left/right, 2/3 tower left/right
  let f = (rem % ${BOX_V}u) / 6u;
  let cc = rem % 6u;
  let sgn = select(-1.0, 1.0, (box & 1u) == 1u);
  let tower = box >= 2u;

  let BL = section_monoliths_barLen();
  let k = f32(bar) - 3.0;
  let tNow0 = F.songTime - F.barPhase * BL;
  let tb = select(section_monoliths_snap(tNow0 + k * BL), tNow0, bar == 3u);
  let tn = section_monoliths_snap(tNow0 + (k + 1.0) * BL);
  if (tb - F.songTime < -S.p[1].x - 2.0 || tb - F.songTime > S.p[1].y) { return hidden(); }

  let sec = section_monoliths_section(tb + 0.5 * (tn - tb));
  let kind = sec.z;
  let energy = sec.w;
  let barsIn = round((tb - sec.x) / BL);
  let prog = sat((tb + 0.5 * (tn - tb) - sec.x) / sec.y);
  let isStart = abs(tb - sec.x) < 0.3 * BL;
  if (tower && !isStart) { return hidden(); }

  let fr0 = section_monoliths_frame(F.songTime);
  if (length(fr0[2]) < 0.5) { return hidden(); }
  let ex = section_monoliths_extent(F.songTime, fr0[0], fr0[1]);
  let unit = (ex.x + ex.y) * 0.5;
  let floorY = ex.w - ex.y - 0.25;
  // A camera flying outside the walls would look through the near one: leave that side open.
  let camX = dot(camEye() - LCenter(F.songTime), fr0[0]) - ex.z;
  if (sgn * camX > ex.x * 0.45) { return hidden(); }
  let full = unit * (0.6 + 1.5 * energy);
  let pr = section_monoliths_profile(kind, prog, 0.0, barsIn);
  let broken = u32(kind + 0.5) == 4u;

  // Box extents: x lateral (outward from the axis), y vertical, t along time.
  var x0 = ex.z + sgn * (ex.x + 0.5);
  var x1 = x0 + sgn * unit * 0.32;
  var y0 = floorY + pr.y * full;
  var y1 = y0 + max(pr.x * full, unit * 0.12);
  let gap = BL * 0.05;
  var t0 = tb + gap;
  var t1 = select(tn - gap, mix(tb, tn, 0.45), broken);
  if (tower) {
    // A tower at the section start, its height the energy of the section it opens.
    x0 = ex.z + sgn * (ex.x + 0.35);
    x1 = x0 + sgn * unit * 0.6;
    y0 = floorY;
    y1 = floorY + unit * (1.4 + 2.6 * energy);
    t0 = tb - BL * 0.08;
    t1 = tb + BL * 0.14;
  }

  // Unit cube corner for face f (0 -x, 1 +x, 2 -y, 3 +y, 4 -t, 5 +t), quad corner cc.
  let u = qu(cc);
  let v = qv(cc);
  var cube: vec3f;
  var nl: vec3f;
  if (f == 0u) { cube = vec3f(0.0, u, v); nl = vec3f(-1.0, 0.0, 0.0); }
  else if (f == 1u) { cube = vec3f(1.0, v, u); nl = vec3f(1.0, 0.0, 0.0); }
  else if (f == 2u) { cube = vec3f(v, 0.0, u); nl = vec3f(0.0, -1.0, 0.0); }
  else if (f == 3u) { cube = vec3f(u, 1.0, v); nl = vec3f(0.0, 1.0, 0.0); }
  else if (f == 4u) { cube = vec3f(v, u, 0.0); nl = vec3f(0.0, 0.0, -1.0); }
  else { cube = vec3f(u, v, 1.0); nl = vec3f(0.0, 0.0, 1.0); }
  let tt = mix(t0, t1, cube.z);
  let fr = section_monoliths_frame(tt);
  let xx = mix(x0, x1, cube.x);
  let yy = mix(y0, y1, cube.y);
  let wp = LCenter(tt) + fr[0] * xx + fr[1] * yy;
  let flip = select(1.0, -1.0, x1 < x0);
  o.pos = toClip(wp);
  o.wp = wp;
  o.nrm = fr[0] * nl.x * flip + fr[1] * nl.y + fr[2] * nl.z;
  o.a = vec4f(u, v, tt, cube.y);
  o.b = vec4f(tb, kind, energy, select(0.0, 1.0, tower));
  o.c = vec4f(f32(f), sec.x, 0.0, 0.0);
  return o;
}

fn fs_section_monoliths(in: LOut) -> vec4f {
  let kind = in.b.y;
  let tower = in.b.w > 0.5;
  let hue = S.p[3].x + kind * 0.143 + 0.3;
  let col = palL(hue, 1.0);
  // Crisp box edges on every face.
  let d = min(min(in.a.x, 1.0 - in.a.x), min(in.a.y, 1.0 - in.a.y));
  let ew = max(fwidth(in.a.x), fwidth(in.a.y)) * 1.4;
  let edge = 1.0 - smoothstep(ew * 0.6, ew * 1.6, d);
  let tt = in.a.z;
  let played = step(tt, F.songTime);
  let dt = in.b.x - F.songTime;
  let vis = select(exp(-dt * 0.1), exp(dt * 0.3), dt < 0.0);
  let topFace = select(0.0, 1.0, u32(in.c.x + 0.5) == 3u);
  // The top lights as the bar is played; the wall's top edge is the section's played progress.
  let topLine = smoothstep(0.82, 1.0, in.a.w);
  let barFlash = exp(-max(F.songTime - in.b.x, 0.0) * 2.5) * step(in.b.x, F.songTime);
  var emis = col * edge * (0.18 + 0.5 * played) * (0.5 + in.b.z);
  emis += col * (topFace * 0.5 + topLine * 0.6) * played * (0.4 + in.b.z);
  emis += col * barFlash * 0.8 * (0.3 + in.b.z) * (topFace + topLine);
  if (tower) {
    let open = exp(-max(F.songTime - in.c.y, 0.0) * 0.8) * step(in.c.y, F.songTime);
    emis = col * (edge * (0.5 + 1.2 * played) + open * 1.8 + topLine * (0.4 + 1.2 * played));
  }
  let base = palL(hue + 0.5, 0.14);
  return vec4f(shade(base, emis * vis * S.p[3].y, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
