import type { LayerDef } from '../layer';

const BAYS = 16; // bar-long bays around the playhead
const PAST_BAYS = 3;
const SEG = 32; // segments per rib
const RIB_V = SEG * 6;
const TONES = 3; // ribs per springer: one per chord tone (root, third, fifth)
const DIAG = 4 * TONES; // four springers per bay
const RIBS = 2 + DIAG; // two transverse-arch halves (with their piers) + the diagonal ribs
const POOL_V = 2 * 6; // a light pool on the floor at each pier foot
const BAY_V = RIBS * 2 * RIB_V + POOL_V; // every rib twice: itself and its reflection in the floor

/**
 * A nave of light you fly through. Every bar is a vaulted bay: a pointed transverse arch on two
 * piers at the downbeat, and from each of the bay's four springers one rib per chord tone fans up
 * to the crown (the root as the great diagonal, the third and fifth as tiercerons landing where
 * their interval puts them), each rib in its tone's colour. The crown height is the melody: the
 * vault ahead rises into tall lancets where the coming phrase climbs and settles low and round
 * where it falls; harmonic tension sharpens the arches. On each downbeat light pours from the
 * crown down every rib of that pier into the floor and spreads there; each melodic attack sends
 * light running up the rib nearest its moment to the crown. A dark mirror floor reflects it all.
 */
export default {
  id: 'light-cathedral',
  role: 'enclosure',
  source: 'once',
  verts: BAYS * BAY_V,
  blend: 'additive',
  weight: 1,
  layouts: ['flight', 'road', 'river', 'helix'],
  wgsl: /* wgsl */ `
struct LightCathedralFrame { c: vec3f, x: vec3f, y: vec3f, v: vec3f };
/** The path's frame at song time t: centre, across, up and velocity (world units per second). */
fn light_cathedral_frame(t: f32) -> LightCathedralFrame {
  var o: LightCathedralFrame;
  // A cubic B-spline through the path sampled on a fixed 0.6 s grid: the architecture follows the
  // path's course but never its small steps (a river's centre jumps with the bass).
  let k = 0.6;
  let x = t / k;
  let i = floor(x);
  let u = x - i;
  let p0 = LCenter((i - 1.0) * k);
  let p1 = LCenter(i * k);
  let p2 = LCenter((i + 1.0) * k);
  let p3 = LCenter((i + 2.0) * k);
  let v = 1.0 - u;
  o.c = (p0 * (v * v * v) + p1 * (3.0 * u * u * u - 6.0 * u * u + 4.0) + p2 * (-3.0 * u * u * u + 3.0 * u * u + 3.0 * u + 1.0) + p3 * (u * u * u)) / 6.0;
  var f = -p0 * (v * v) + p1 * (3.0 * u * u - 4.0 * u) + p2 * (-3.0 * u * u + 2.0 * u + 1.0) + p3 * (u * u);
  if (length(f) < 1e-5) { f = vec3f(0.0, 0.0, 1e-3); }
  o.v = f / k;
  f = normalize(f);
  var up = LUp(t) - f * dot(LUp(t), f);
  if (length(up) < 1e-3) { up = frameX(t, f); }
  o.y = normalize(up);
  o.x = cross(o.y, f);
  return o;
}
/** Nave half-width, floor height, springer height. */
fn light_cathedral_dims() -> vec3f {
  let w = 2.6 + 8.0 * S.p[0].y;
  let yf = -(0.9 + 1.0 * S.p[0].w);
  return vec3f(w, yf, yf + 0.36 * w);
}
/** Crown rise above the springers at song time t: the melody's height, smoothed over ~1 s. */
fn light_cathedral_rise(t: f32, w: f32) -> f32 {
  var m = 0.0;
  for (var k = -2; k <= 2; k++) { m += melodyHeight(t + f32(k) * 0.22); }
  return w * (0.6 + 1.3 * sat(0.5 + 1.5 * m * 0.2));
}
fn light_cathedral_barLen() -> f32 { return 240.0 / max(F.bpm, 40.0); }
/** Exact downbeat near an estimate, recovered from the score's bar pulse. */
fn light_cathedral_snap(te: f32) -> f32 {
  let probe = te + 0.15;
  let p = gridAt(probe - F.songTime).y;
  let off = probe + 0.2 * log(max(p, 1e-4));
  return select(te, off, p > 0.3 && abs(off - te) < 0.2);
}
/** Half a transverse arch from the springer (u = 0) to the apex (u = 1): round to pointed. */
fn light_cathedral_arch(u: f32, w: f32, h: f32, pointed: f32) -> vec2f {
  let a = u * PI * 0.5;
  let el = vec2f(w * cos(a), h * sin(a));
  let hp = max(h, w * 1.02);
  let r = (hp * hp + w * w) / (2.0 * w);
  let ph = u * asin(min(hp / r, 1.0));
  let pt = vec2f(w - r + r * cos(ph), r * sin(ph) * h / hp);
  return mix(el, pt, pointed);
}
/**
 * The latest melodic attack in [t0, t1) already played: (age, strength), age < 0 if none.
 * Read from the gesture track's onset envelope (a jump marks an attack), so it is the same melody
 * the flight path follows.
 */
fn light_cathedral_attack(t0: f32, t1: f32) -> vec2f {
  let rate = W.g.x;
  let rows = i32(W.g.y);
  let te = min(t1, F.songTime);
  if (te <= t0 || rows < 3) { return vec2f(-1.0, 0.0); }
  let i0 = max(i32(ceil(t0 * rate)), 1);
  let i1 = min(i32(floor(te * rate)), rows - 1);
  var i = i1;
  for (var n = 0; n < 40; n++) {
    if (i < i0) { break; }
    let e = gest[i].up.w;
    if (e > gest[i - 1].up.w + 0.04) { return vec2f(F.songTime - f32(i) / rate, sat((e - 0.4) / 0.6)); }
    i--;
  }
  return vec2f(-1.0, 0.0);
}

struct LightCathedralRib { tc: f32, tl: f32, side: f32, rise: f32, pointed: f32, diag: f32 };
/** Local point on a rib at s: 0 floor, 0.25 springer, 1 crown. */
fn light_cathedral_ribAt(rb: LightCathedralRib, s: f32, d: vec3f) -> vec3f {
  let sc = 0.25;
  if (rb.diag < 0.5) {
    if (s <= sc) { return vec3f(rb.tc, rb.side * d.x, mix(d.y, d.z, s / sc)); }
    let p = light_cathedral_arch((s - sc) / (1.0 - sc), d.x, rb.rise, rb.pointed);
    return vec3f(rb.tc, rb.side * p.x, d.z + p.y);
  }
  // A diagonal rib: an arc in its own vertical plane, rising steeply off the springer and
  // arriving level at the crown.
  let u = sat((s - sc) / (1.0 - sc)) * PI * 0.5;
  let q = 1.0 - cos(u);
  return vec3f(mix(rb.tc, rb.tl, q), rb.side * d.x * (1.0 - q), d.z + rb.rise * sin(u));
}

fn vs_light_cathedral(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let bay = vi / ${BAY_V}u;
  let rem = vi % ${BAY_V}u;
  let BL0 = light_cathedral_barLen();
  let tNow0 = F.songTime - F.barPhase * BL0;
  let k = f32(bay) - ${PAST_BAYS}.0;
  let tb = select(light_cathedral_snap(tNow0 + k * BL0), tNow0, bay == ${PAST_BAYS}u);
  let tn = light_cathedral_snap(tNow0 + (k + 1.0) * BL0);
  let BL = max(tn - tb, 0.2);
  if (tn < F.songTime - worldPast() - 1.0 || tb > F.songTime + S.p[1].y) { return hidden(); }
  let d = light_cathedral_dims();

  // The bay's chord: its tones set the ribs, its tension the arch.
  let ch = chordAtT(tb + BL * 0.5 - F.songTime);
  let root = floor(ch.x * 13.0 - 0.5);
  let hasChord = root >= 0.0 && ch.x > 0.02;
  let third = select(3.0, 4.0, ch.y > 0.75);
  let fifth = select(7.0, 6.0, ch.y < 0.4);
  let f3 = 0.5 * (1.0 - third / 12.0);
  let f5 = 0.5 * (1.0 - fifth / 12.0);
  let pointed = 0.25 + 0.75 * smoothstep(0.15, 0.85, ch.z);
  let chArch = chordAtT(tb + 0.05 - F.songTime);
  let pointedArch = select(pointed, 0.25 + 0.75 * smoothstep(0.15, 0.85, chArch.z), chArch.x > 0.02);

  if (rem >= ${RIBS * 2 * RIB_V}u) {
    // Floor pools at the pier feet.
    let pr = rem - ${RIBS * 2 * RIB_V}u;
    let side = select(-1.0, 1.0, pr >= 6u);
    let cc = pr % 6u;
    let R = 1.7;
    let fr = light_cathedral_frame(tb);
    let fwd = cross(fr.x, fr.y);
    let uv = vec2f(qu(cc), qv(cc)) * 2.0 - 1.0;
    let wp = fr.c + fr.x * (side * d.x + uv.x * R) + fr.y * d.y + fwd * uv.y * R;
    o.pos = toClip(wp);
    o.wp = wp;
    o.nrm = vec3f(tb - F.songTime, 0.0, 0.0);
    o.a = vec4f(uv, R, 0.0);
    let hue = select(S.p[3].x + 0.1, S.p[3].x + pitchHue(root) * 0.55, hasChord);
    o.b = vec4f(F.songTime - tb, -1.0, 0.0, 1.0);
    o.c = vec4f(palL(hue, 1.0), 2.0);
    return o;
  }

  let ribIdx = rem / ${RIB_V}u;
  let mirror = ribIdx >= ${RIBS}u;
  let r = ribIdx % ${RIBS}u;
  let local = rem % ${RIB_V}u;
  let seg = local / 6u;
  let cc = local % 6u;

  var rb: LightCathedralRib;
  var pc = root;
  var fl = 0.0; // landing point as a fraction of the bay
  var sMin = 0.0;
  if (r < 2u) {
    rb.tc = tb;
    rb.tl = tb;
    rb.side = select(-1.0, 1.0, r == 1u);
    rb.rise = light_cathedral_rise(tb, d.x);
    rb.pointed = pointedArch;
    rb.diag = 0.0;
  } else {
    let dg = r - 2u;
    let corner = dg / ${TONES}u;
    let tone = dg % ${TONES}u;
    if (tone > 0u && !hasChord) { return hidden(); }
    let f = select(select(f5, f3, tone == 1u), 0.5, tone == 0u);
    let late = corner >= 2u;
    rb.tc = select(tb, tn, late);
    rb.tl = select(tb + f * BL, tn - f * BL, late);
    rb.side = select(-1.0, 1.0, corner % 2u == 1u);
    rb.rise = light_cathedral_rise(rb.tl, d.x);
    rb.pointed = 0.0;
    rb.diag = 1.0;
    pc = root + select(select(fifth, third, tone == 1u), 0.0, tone == 0u);
    fl = select(f, 1.0 - f, late);
    sMin = 0.25;
  }

  // The rib nearest each melodic attack carries it: slots are halfway to the neighbouring ribs.
  let a5 = select(0.25, f5, hasChord);
  let b3 = select(0.25, f3, hasChord);
  var lf = array<f32, 7>(0.0, a5, b3, 0.5, 1.0 - b3, 1.0 - a5, 1.0);
  var j = 0;
  for (var i = 0; i < 7; i++) { if (abs(lf[i] - fl) < 1e-4) { j = i; } }
  var slo = select((lf[max(j - 1, 0)] + lf[j]) * 0.5, -a5 * 0.5, j == 0);
  var shi = (lf[j] + lf[min(j + 1, 6)]) * 0.5;
  if (!hasChord && rb.diag > 0.5) { slo = 0.25; shi = 0.75; }
  let att = light_cathedral_attack(tb + slo * BL, tb + shi * BL);

  let s = sMin + (1.0 - sMin) * (f32(seg) + qu(cc)) / ${SEG}.0;
  let ds = 0.004;
  var q = light_cathedral_ribAt(rb, s, d);
  var qa = light_cathedral_ribAt(rb, max(s - ds, sMin), d);
  var qb = light_cathedral_ribAt(rb, min(s + ds, 1.0), d);
  let hgt = q.z - d.y;
  if (mirror) {
    q.z = 2.0 * d.y - q.z;
    qa.z = 2.0 * d.y - qa.z;
    qb.z = 2.0 * d.y - qb.z;
  }
  // One frame per vertex; the tangent is carried through it (the frame turns slowly along the path).
  let fr = light_cathedral_frame(q.x);
  let p = fr.c + fr.x * q.y + fr.y * q.z;
  let dq = qb - qa;
  let tg = fr.v * dq.x + fr.x * dq.y + fr.y * dq.z;
  let tgn = select(vec3f(0.0, 1.0, 0.0), normalize(tg), length(tg) > 1e-6);
  let unit = d.x;
  let core = unit * select(0.0045, 0.0032, rb.diag > 0.5);
  let cEff = max(core, lineW(p) * 0.6);
  // The halo is a few pixels wide at any distance, so near ribs stay fine lines rather than flares.
  let hr = lineW(p) * 2.2;
  let hw = cEff + hr * 2.2;
  var sideV = cross(tgn, camEye() - p);
  sideV = select(vec3f(1.0, 0.0, 0.0), normalize(sideV), length(sideV) > 1e-6);
  let wp = p + sideV * (qv(cc) * 2.0 - 1.0) * hw;
  o.pos = toClip(wp);
  o.wp = wp;
  // Reflections are dimmer the further the reflected point is below the floor.
  let refl = select(1.0, 0.26 * exp(-hgt * 0.55), mirror);
  // Ribs passing close to the camera dissolve instead of flaring across the frame.
  let near = smoothstep(2.5, 9.0, length(p - camEye()));
  // Diagonal ribs far ahead stay faint, so the bays ahead read as arches rather than a tangle.
  let ahead = select(1.0, exp(-max(q.x - F.songTime, 0.0) * 0.35), rb.diag > 0.5);
  o.nrm = vec3f(q.x - F.songTime, refl * near * ahead * core / cEff, hr);
  o.a = vec4f(s, qv(cc), hw, cEff);
  let hue = select(S.p[3].x + 0.1, S.p[3].x + pitchHue(pc) * 0.55, hasChord);
  var col = palL(hue, 1.0);
  // The transverse arches carry the light itself, tinted by the root.
  if (rb.diag < 0.5) { col = mix(vec3f(luma(col)), col, 0.45); }
  o.b = vec4f(F.songTime - rb.tc, att.x, att.y, rb.diag);
  o.c = vec4f(col, 0.0);
  return o;
}

fn fs_light_cathedral(in: LOut) -> vec4f {
  let x = abs(in.a.y * 2.0 - 1.0) * in.a.z;
  let aa = max(fwidth(x), 1e-5);
  let dt = in.nrm.x;
  // Ahead: a faint drawing of the vault to come. At and behind the playhead it stands lit.
  let base = 0.16 + 0.55 * smoothstep(0.8, -0.3, dt) * exp(min(dt, 0.0) * 0.12);
  let tau = 0.5;
  if (in.c.w > 1.5) {
    // Pool: light arriving at the pier foot spreads over the floor as a widening ring.
    let rr = length(in.a.xy) * in.a.z;
    let since = in.b.x - tau;
    var e = exp(-rr * rr * 1.2) * base * 0.12;
    if (since >= 0.0) {
      let ringR = since * 2.2;
      let ring = exp(-pow((rr - ringR) * 3.0, 2.0)) * exp(-since * 2.2);
      e += (exp(-rr * rr * 2.0) * 0.35 + ring * 0.3) * exp(-since * 1.6);
    }
    let fade = (1.0 - smoothstep(0.7, 1.0, length(in.a.xy))) * smoothstep(2.5, 9.0, length(in.wp - camEye()));
    return glowOut(in.c.rgb * e * fade * S.p[3].y, in.wp);
  }
  let c = in.a.w;
  let line = 1.0 - smoothstep(c - aa, c + aa, x);
  let halo = exp(-max(x - c, 0.0) / in.nrm.z) * 0.12;
  let s = in.a.x;
  // Downbeat flood: light pours from the crown down to the floor, each point lit as the front passes.
  var flood = 0.0;
  let fa = in.b.x;
  if (fa >= 0.0) {
    let since = fa - (1.0 - s) * tau;
    flood = smoothstep(-0.03, 0.0, since) * (exp(-max(since, 0.0) * 2.4) + 0.12 * exp(-max(since, 0.0) * 0.35));
  }
  // Attack: light runs up from the springer to the crown and rests there as a glowing boss.
  var spark = 0.0;
  let ag = in.b.y;
  if (ag >= 0.0) {
    let head = 0.25 + 0.75 * ag / 0.45;
    let dd = head - s;
    let run = select(exp(dd * 30.0), exp(-dd * 5.0) * 0.6 + exp(-dd * 40.0), dd >= 0.0);
    let arrive = max(ag - 0.45, 0.0);
    spark = (run * exp(-arrive * 2.5) + exp(-(1.0 - s) * 14.0) * smoothstep(0.3, 0.46, ag) * exp(-arrive * 1.3)) * (0.5 + 0.6 * in.b.z);
  }
  let col = in.c.rgb;
  let light = mix(col, vec3f(luma(col)), 0.5);
  let steady = col * base * 0.55 + light * flood * (0.75 - 0.35 * in.b.w);
  // A spark is a bead of light wider than the rib that carries it.
  let bead = mix(col, vec3f(luma(col)), 0.3) * spark * 2.4;
  let emis = steady * (line + halo) + bead * (line + halo * 3.5);
  return glowOut(emis * in.nrm.y * S.p[3].y, in.wp);
}
`,
} satisfies LayerDef;
