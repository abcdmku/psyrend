import type { LayerDef } from '../layer';

const SIDES = 6;
const PRISM = SIDES * 6;
const TIP = SIDES * 3;
const SEG = PRISM + TIP;
const ARMS = 6;

/**
 * A crystal reef grown by the melody beside the travel path: every phrase grows one symmetric
 * crystal, one faceted segment per lead note.
 *
 * A sculpture is a motif instance, or a phrase of free lead notes up to a rest, a motif or a bar
 * line (two bars). Its first note raises a central pillar; every later note grows on k identical
 * arms around it, where k is the number of distinct pitch classes the phrase uses (3-6), so a
 * phrase's harmonic vocabulary is the crystal's symmetry. Within an arm the melodic contour is the
 * growth rule:
 * - while the line keeps moving in one direction (or repeats a note) the branch extends from its
 *   tip; where the contour turns, the next note forks from the previous node instead, at an angle
 *   set by the leap (each fork turned by the golden angle, so the arm fills space in 3D);
 * - rising intervals bend the growth upward, falling ones make it droop;
 * - the note's length (in beats) sets the segment's length, its strength the thickness.
 * The shape is a pure function of intervals and rhythm, so a returning motif regrows exactly the same
 * crystal, on the same side, in its signature glow. All k copies of a segment shoot out together as
 * its note sounds, flaring at the attack; the chord under each note colours it, so the harmony bands
 * the generations. Upcoming notes show as faint seeds at their nodes, and each crystal is planted just
 * after its last note: it grows ahead in view, then stays as reef as the camera flies past.
 */
export default {
  id: 'melodic-coral',
  role: 'form',
  source: 'notes',
  verts: SEG * ARMS,
  blend: 'opaque',
  weight: 0,
  layouts: ['flight', 'road', 'river'],
  wgsl: /* wgsl */ `
/** Rodrigues rotation of v about unit axis k. */
fn melodic_coral_rot(v: vec3f, k: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
fn melodic_coral_isLead(m: Note) -> bool { return m.role < 0.5; }
/** Whether lead note m belongs to the same sculpture stream (motif instance or free phrase). */
fn melodic_coral_member(m: Note, isMotif: bool, motif: f32) -> bool {
  if (!melodic_coral_isLead(m)) { return false; }
  return select(m.motif < 0.0, abs(m.motif - motif) < 0.5, isMotif);
}
/** Which two-bar span a time falls in; cut 1/8 beat before the line so on-beat notes never sit on it. */
fn melodic_coral_span(t: f32) -> f32 {
  let beat = 60.0 / max(F.bpm, 40.0);
  let grid0 = F.songTime - F.barPhase * beat * 4.0;
  return floor((t - grid0) / (beat * 8.0) + 1.0 / 64.0);
}
/** Whether free lead note m starts a new phrase sculpture after the previous lead note pv. */
fn melodic_coral_breaks(pv: Note, m: Note) -> bool {
  let beat = 60.0 / max(F.bpm, 40.0);
  return pv.motif >= 0.0 || m.start - pv.end > beat * 0.75 || melodic_coral_span(m.start) != melodic_coral_span(pv.start);
}
fn melodic_coral_pcBit(p: f32) -> u32 { return 1u << u32(fmod(floor(p + 0.5), 12.0)); }

/** Note ii's segment in its sculpture: local arm-0 geometry (units of the sculpture's scale) and its frame. */
struct melodic_coral_Seg {
  a: vec3f, b: vec3f, dir: vec3f, ra: f32,
  base: vec3f, wx: vec3f, wy: vec3f, wz: vec3f, u: f32,
  ta: f32, k: u32, arms: u32, ok: bool,
};

/** Growth state of one arm (the pillar first), in the sculpture's local frame. */
struct melodic_coral_G {
  k: u32, pcs: u32, prevP: f32, ivPrev: f32, az: f32, radP: f32, reach: f32,
  nodeA: vec3f, tipP: vec3f, dirP: vec3f,
};

/** Grows one note: the pillar, then the arm, by the contour rule. */
fn melodic_coral_step(g: ptr<function, melodic_coral_G>, m: Note, beat: f32, isMotif: bool) {
  let rise = vec3f(0.0, 1.0, 0.0);
  // Length in beats, quantised (whole doublings for motifs, so articulation never changes a returning shape).
  let qs = select(2.0, 1.0, isMotif);
  let q = clamp(floor(log2(max(m.end - m.start, 0.03) / beat) * qs + 0.5) / qs, -2.0, 2.0);
  var a: vec3f;
  var d: vec3f;
  var r: f32;
  var len = clamp(1.0 + 0.3 * q, 0.55, 1.6);
  let k = (*g).k;
  if (k == 0u) {
    a = vec3f(0.0);
    d = rise;
    r = 0.15 * (0.8 + 0.4 * m.strength);
    len = 0.6 + len * 0.4;
  } else {
    let iv = clamp(m.pitch - (*g).prevP, -12.0, 12.0);
    let ivPrev = (*g).ivPrev;
    let turns = k >= 2u && abs(iv) > 0.5 && abs(ivPrev) > 0.5 && sign(iv) != sign(ivPrev);
    if (k == 1u) {
      a = (*g).tipP;
      d = vec3f(0.64, 0.77, 0.0);
      r = (*g).radP * 0.6;
    } else if (turns) {
      // The contour turns: fork from the previous segment's base, golden-angle around it.
      var p1 = cross((*g).dirP, rise);
      if (length(p1) < 1e-3) { p1 = vec3f(0.0, 0.0, 1.0); }
      p1 = normalize(p1);
      let p2 = cross((*g).dirP, p1);
      (*g).az += 2.39996;
      let axis = p1 * cos((*g).az) + p2 * sin((*g).az);
      a = (*g).nodeA;
      d = melodic_coral_rot((*g).dirP, axis, 0.5 + 0.045 * abs(iv));
      r = (*g).radP * 0.85;
    } else {
      a = (*g).tipP;
      d = (*g).dirP;
      r = (*g).radP * 0.92;
    }
    // Rising intervals lift the growth, falling ones droop it (never down into the floor).
    d = normalize(d + rise * iv * 0.07);
    let dn = dot(d, rise);
    if (dn < -0.3) { d = normalize(d + rise * (-0.3 - dn)); }
    if (abs(iv) > 0.5) { (*g).ivPrev = iv; }
    len *= pow(0.93, f32(k - 1u));
  }
  (*g).nodeA = a;
  (*g).tipP = a + d * len;
  (*g).dirP = d;
  (*g).radP = r;
  (*g).prevP = m.pitch;
  (*g).pcs |= melodic_coral_pcBit(m.pitch);
  (*g).reach = max((*g).reach, length((*g).tipP.xz) + r * 2.4);
  (*g).k = k + 1u;
}

/**
 * Grows the sculpture containing note ii in a local frame (y = up from the floor, x = away from the
 * path, z = along it), then finds where it is planted.
 */
fn melodic_coral_grow(ii: u32) -> melodic_coral_Seg {
  var sg: melodic_coral_Seg;
  sg.ok = false;
  let n = notes[ii];
  let beat = 60.0 / max(F.bpm, 40.0);
  let motif = n.motif;
  let isMotif = motif >= 0.0;

  // Walk back to the first note of this sculpture.
  var first = ii;
  var cur = n;
  var guard = 0u;
  for (var j = ii; j > 0u && guard < 600u; guard++) {
    if (isMotif && cur.motifPos < 0.5) { break; }
    j -= 1u;
    let m = notes[j];
    if (!melodic_coral_isLead(m)) { continue; }
    if (cur.start - m.start > 8.0) { break; }
    if (isMotif) {
      if (abs(m.motif - motif) > 0.5) { continue; }
    } else if (melodic_coral_breaks(m, cur)) { break; }
    first = j;
    cur = m;
  }

  // Grow forward from it, up to note ii.
  var g: melodic_coral_G;
  g.dirP = vec3f(0.0, 1.0, 0.0);
  var tLast = cur.start;
  guard = 0u;
  for (var j = first; j <= ii && guard < 600u; j++) {
    guard++;
    let m = notes[j];
    if (!melodic_coral_member(m, isMotif, motif)) { continue; }
    melodic_coral_step(&g, m, beat, isMotif);
    tLast = m.start;
  }
  if (g.k == 0u) { return sg; }
  sg.a = g.nodeA;
  sg.b = g.tipP;
  sg.dir = g.dirP;
  sg.ra = max(g.radP, 0.025);
  sg.k = g.k - 1u;
  // Grow the rest of the sculpture too: when it is complete, its pitch classes and its reach.
  var last = n;
  guard = 0u;
  for (var j = ii + 1u; guard < 600u; j++) {
    guard++;
    let m = notes[j];
    if (m.start < tLast - 0.01 || m.start - tLast > 8.0) { break; }
    if (!melodic_coral_isLead(m)) { continue; }
    if (isMotif) {
      if (abs(m.motif - motif) > 0.5) { continue; }
      if (m.motifPos < 0.5) { break; }
    } else if (m.motif >= 0.0 || melodic_coral_breaks(last, m)) { break; }
    melodic_coral_step(&g, m, beat, isMotif);
    tLast = m.start;
    last = m;
  }

  // Plant it on the floor beside the path just after its last note, so it grows in view ahead and
  // the camera flies past it once it is whole; far enough out that no arm reaches into the corridor
  // the camera flies down. Motifs keep a side; phrases take their chord's.
  let ch0 = chordAtT(cur.start - F.songTime);
  var side = select(-1.0, 1.0, sin(fifthsAng(ch0.x * 13.0 - 1.0)) >= 0.0);
  if (isMotif) { side = select(-1.0, 1.0, fract(motif * 0.5) < 0.25); }
  let ta = tLast + 1.2;
  let c = S.p[0].z;
  let floorC = L(ta, c, SURFACE_LANE);
  let top = L(ta, c, 0.0);
  sg.wy = normalize(top - floorC + vec3f(0.0, 1e-5, 0.0));
  var sd = L(ta, c + side * 12.0, SURFACE_LANE) - floorC;
  sd = sd - sg.wy * dot(sd, sg.wy);
  sg.wx = normalize(sd + vec3f(1e-5, 0.0, 0.0));
  sg.wz = cross(sg.wx, sg.wy);
  sg.u = clamp(1.05 * length(top - floorC), 0.5, 2.0);
  // Where the lead lane circles the centre (the helix tunnel), stay clear of the camera axis.
  let clr = length(L(ta, c, 0.0) - LCenter(ta));
  if (clr > 0.3) { sg.u = min(sg.u, clr * 0.25); }
  let lane = length(L(ta, c + select(-12.0, 18.0, side > 0.0), 0.0) - top);
  sg.base = floorC + sg.wx * (max(lane, 1.2) + 0.5 + g.reach * sg.u);
  sg.ta = ta;
  sg.arms = clamp(countOneBits(g.pcs), 3u, ${ARMS}u);
  sg.ok = true;
  return sg;
}

fn vs_melodic_coral(vi: u32, ii: u32) -> LOut {
  let n = notes[ii];
  if (!melodic_coral_isLead(n)) { return hidden(); }
  let now = F.songTime;
  let age = now - n.start;
  // Future: seeds only for the next few seconds; past: the reef lasts until it is far behind.
  if (age < -2.5 || age > S.p[1].x + 7.5) { return hidden(); }
  let arm = vi / ${SEG}u;
  let lv = vi % ${SEG}u;
  let sg = melodic_coral_grow(ii);
  if (!sg.ok || now - sg.ta > S.p[1].x + 6.0) { return hidden(); }
  if (arm >= sg.arms || (sg.k == 0u && arm > 0u)) { return hidden(); }

  // Growth: out of its parent while the note sounds (done before the next note needs its tip).
  var ioi = 1.0;
  for (var j = ii + 1u; j < ii + 24u; j++) {
    let m = notes[j];
    if (m.start < n.start) { break; }
    if (melodic_coral_isLead(m) && m.start > n.start + 0.01) { ioi = m.start - n.start; break; }
  }
  let growT = clamp(min(n.end - n.start, ioi) * 0.9, 0.05, 0.45);
  let g = smoothstep(0.0, 1.0, sat(age / growT));
  let seed = age < 0.0;
  let full = length(sg.b - sg.a);
  let len = select(full * mix(0.08, 1.0, g), full * 0.1, seed);
  let ra = sg.ra * select(mix(0.55, 1.0, g), 0.4, seed);
  let rb = ra * 0.78;
  // Arm copies turn about the pillar; arm 0 points away from the path.
  let ang = f32(arm) / f32(sg.arms) * TAU;
  let ca = cos(ang);
  let sa = sin(ang);
  let A0 = vec3f(sg.a.x * ca - sg.a.z * sa, sg.a.y, sg.a.x * sa + sg.a.z * ca);
  let D0 = vec3f(sg.dir.x * ca - sg.dir.z * sa, sg.dir.y, sg.dir.x * sa + sg.dir.z * ca);
  let dir = normalize(sg.wx * D0.x + sg.wy * D0.y + sg.wz * D0.z);
  let A = sg.base + (sg.wx * A0.x + sg.wy * A0.y + sg.wz * A0.z) * sg.u;
  let B = A + dir * len * sg.u;
  let r0 = ra * sg.u;
  let r1 = rb * sg.u;

  var e1 = cross(dir, sg.wz);
  if (length(e1) < 1e-3) { e1 = cross(dir, sg.wx); }
  e1 = normalize(e1);
  let e2 = cross(dir, e1);
  var p: vec3f;
  var nrm: vec3f;
  var along = 0.0;
  if (lv < ${PRISM}u) {
    // Hexagonal prism, flat-faceted.
    let face = lv / 6u;
    let cc = lv % 6u;
    let an = (f32(face) + qu(cc)) / ${SIDES}.0 * TAU;
    along = qv(cc);
    p = mix(A, B, along) + (e1 * cos(an) + e2 * sin(an)) * mix(r0, r1, along);
    let am = (f32(face) + 0.5) / ${SIDES}.0 * TAU;
    nrm = normalize(e1 * cos(am) + e2 * sin(am) + dir * (r0 - r1) / max(len * sg.u, 1e-3));
  } else {
    // Pointed crystal tip.
    let t = (lv - ${PRISM}u) / 3u;
    let cc = (lv - ${PRISM}u) % 3u;
    let a0 = f32(t) / ${SIDES}.0 * TAU;
    let a1 = f32(t + 1u) / ${SIDES}.0 * TAU;
    let c0 = B + (e1 * cos(a0) + e2 * sin(a0)) * r1;
    let c1 = B + (e1 * cos(a1) + e2 * sin(a1)) * r1;
    let apex = B + dir * r1 * 2.4;
    p = select(select(apex, c1, cc == 1u), c0, cc == 0u);
    nrm = normalize(cross(c1 - c0, apex - c0));
    if (dot(nrm, c0 - B) < 0.0) { nrm = -nrm; }
    along = select(1.0, 1.4, cc == 2u);
  }
  var o: LOut;
  o.pos = toClip(p);
  o.wp = p;
  o.nrm = nrm;
  o.a = vec4f(along, 0.0, 0.0, 0.0);
  let ch = chordAtT(n.start - now);
  let hue = select(S.p[3].x + 0.5, S.p[3].x + pitchHue(ch.x * 13.0 - 1.0) * 0.55 + 0.5, ch.x > 0.02);
  o.b = vec4f(n.start, n.end, hue, select(-1.0, fract(n.motif * 0.618), n.motif >= 0.0));
  o.c = vec4f(n.strength, f32(sg.k), select(0.0, 1.0, seed), n.pitch);
  return o;
}
fn fs_melodic_coral(in: LOut) -> vec4f {
  let now = F.songTime;
  let age = now - in.b.x;
  let col = palL(in.b.z, 1.0);
  // Ignites at the attack, glows while sounding, then cools to the reef's own faint light.
  let flash = step(0.0, age) * exp(-max(age, 0.0) * 4.0);
  let sounding = step(in.b.x, now) * step(now, in.b.y);
  // Crystal light gathers toward each segment's tip, where its note grew it.
  let tipGlow = smoothstep(0.0, 1.4, in.a.x);
  let tip2 = tipGlow * tipGlow;
  let after = 0.1 + 0.45 * tip2 * exp(-max(age, 0.0) * 0.25);
  var emis = col * (after + 0.6 * sounding * tipGlow + 2.4 * flash * (0.25 + 0.75 * tipGlow)) * (0.6 + 0.6 * in.c.x);
  if (in.b.w >= 0.0) {
    // Motif crystals carry their motif's signature glow at the tips, so a return is recognised at a glance.
    emis += palL(S.p[3].x + in.b.w, 1.0) * (0.1 + 0.5 * tipGlow) * step(0.0, age);
  }
  if (in.c.z > 0.5) {
    // A seed: faint, brightening as its note approaches.
    emis = col * 0.2 * exp(age * 1.2);
  }
  return vec4f(shade(col * 0.32, emis * S.p[3].y, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
