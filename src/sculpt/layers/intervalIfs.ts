import type { LayerDef } from '../layer';

const DEPTH = 5; // address lengths 0..5 over 4 maps
const ADDRS = (4 ** (DEPTH + 1) - 1) / 3; // 1365
const SPOKES = 3; // third, fifth, seventh
const SEGS = ADDRS * SPOKES;

/**
 * The sounding chord as an iterated function system with a condensation set. The set is the
 * chord's interval star: spokes from the root (at the centre) to the third, fifth and seventh at
 * their circle-of-fifths angles. Each chord tone is one contraction: the root spirals the whole
 * figure inward (curling one way for major, the other for minor, tighter with tension); the other
 * tones copy it toward their anchors, shrunk by their frequency ratio over the root and turned by
 * their interval. Every copy up to five levels deep is drawn as crisp spokes coloured by tone and
 * brightened while that pitch class sounds; the seventh appears with harmonic tension. A new chord
 * morphs the maps from the previous one; the next chord waits ahead at lower depth.
 */
export default {
  id: 'interval-ifs',
  role: 'fractal',
  source: 'chords',
  verts: SEGS * 6,
  blend: 'additive',
  // Same place as the other chord emblems at the playhead.
  excludes: ['chord-fractal', 'chord-prism'],
  weight: 0.6,
  // A flat emblem: in travel layouts it would hang face-on in the camera's path.
  layouts: ['spiral', 'converge', 'knot', 'rose', 'tonnetz', 'fountain'],
  wgsl: /* wgsl */ `
/** Interval (semitones above the root) of chord tone k: root, third, fifth, seventh. */
fn interval_ifs_iv(c: ChordE, k: u32) -> f32 {
  let third = select(3.0, 4.0, c.quality < 1.5);
  let fifth = select(7.0, 6.0, c.quality > 2.5);
  let seventh = select(10.0, 9.0, c.quality > 2.5);
  var iv = array<f32, 4>(0.0, third, fifth, seventh);
  return iv[k];
}
/** Map k of chord c: (anchor angle, anchor radius, scale, rotation). */
fn interval_ifs_map(c: ChordE, k: u32) -> vec4f {
  let iv = interval_ifs_iv(c, k);
  if (k == 0u) {
    let curl = select(-1.0, 1.0, c.quality < 1.5) * (0.3 + 0.45 * sat(c.tension));
    return vec4f(0.0, 0.0, 0.7 - 0.06 * sat(c.tension), curl);
  }
  var s = 0.42 / sqrt(exp2(iv / 12.0));
  if (k == 3u) { s *= 0.15 + 0.85 * sat(c.tension); }
  return vec4f(fifthsAng(fmod(c.root + iv, 12.0)), 1.0, s, iv / 12.0 * 3.14159265);
}
fn interval_ifs_wrap(a: f32) -> f32 { return a - TAU * floor(a / TAU + 0.5); }
fn interval_ifs_apply(q: vec4f, z: vec2f) -> vec2f {
  let ctr = vec2f(cos(q.x), sin(q.x)) * q.y;
  return ctr + rot2(q.w) * (z - ctr) * q.z;
}
/** The playhead's emblem plane, pushed ahead if the camera has flown past it. */
fn interval_ifs_anchorT() -> f32 {
  let e = camEye();
  let f = normalize(camTarget() - e);
  var t = F.songTime;
  for (var k = 0; k < 10; k++) {
    if (dot(LCenter(t) - e, f) > S.p[6].x * 2.2) { break; }
    t += 0.4;
  }
  return t;
}

fn vs_interval_ifs(vi: u32, ii: u32) -> LOut {
  let c = chords[ii];
  if (c.root < 0.0 || c.quality < 0.5) { return hidden(); }
  let now = F.songTime;
  let current = c.start <= now && now < c.end;
  let upcoming = c.start > now && c.start < now + S.p[1].y * 0.5 && ii > 0u && chords[ii - 1u].end > now - 0.05;
  if (!current && !upcoming) { return hidden(); }
  let seg = vi / 6u;
  let cc = vi % 6u;
  let e = seg / ${SPOKES}u;
  let spoke = seg % ${SPOKES}u + 1u;
  // Address e in the flattened list of all addresses of length 0..DEPTH.
  var len = 0u;
  var first = 0u;
  var count = 1u;
  for (var l = 0u; l < ${DEPTH}u; l++) {
    if (e < first + count) { break; }
    first += count;
    count *= 4u;
    len += 1u;
  }
  let a = e - first;
  // The waiting chord is sketched three levels deep.
  if (upcoming && len > 3u) { return hidden(); }

  // Morph from the previous chord's maps over the first part of this one.
  var prev = c;
  if (ii > 0u) {
    let pc = chords[ii - 1u];
    if (pc.root >= 0.0 && pc.quality > 0.5 && c.start - pc.end < 0.6) { prev = pc; }
  }
  let m = select(1.0, smoothstep(0.0, 0.5, now - c.start), current);
  var mp: array<vec4f, 4>;
  for (var k = 0u; k < 4u; k++) {
    let ma = interval_ifs_map(prev, k);
    let mb = interval_ifs_map(c, k);
    mp[k] = vec4f(ma.x + interval_ifs_wrap(mb.x - ma.x) * m, mix(ma.yzw, mb.yzw, m));
  }

  // The spoke from the root to tone 'spoke', carried through the address (innermost map first).
  let tip = mp[spoke];
  var zA = vec2f(0.0);
  var zB = vec2f(cos(tip.x), sin(tip.x));
  var scale = 1.0;
  var region = 0u;
  for (var j = 0u; j < len; j++) {
    let d = (a >> (2u * (len - 1u - j))) & 3u;
    zA = interval_ifs_apply(mp[d], zA);
    zB = interval_ifs_apply(mp[d], zB);
    scale *= mp[d].z;
    if (d != 0u) { region = d; }
  }

  let progress = sat((now - c.start) / max(c.end - c.start, 1e-3));
  let tA = interval_ifs_anchorT() + select(0.0, c.start - now, upcoming);
  let spin = progress * 0.6 + f32(ii) * 0.37;
  // A camera-facing plane through the time axis at the anchor.
  let ctr = LCenter(tA) + LUp(tA) * S.p[0].w * 1.2;
  let ax = normalize(camEye() - ctr);
  var ex = cross(camUp(), ax);
  if (length(ex) < 1e-3) { ex = frameX(tA, ax); }
  ex = normalize(ex);
  let ey = cross(ax, ex);
  let R = min(S.p[6].x * 1.3, length(camEye() - ctr) * 0.3) * select(1.0, 0.6, upcoming);
  let ra = rot2(spin) * zA;
  let rb = rot2(spin) * zB;
  let A = ctr + (ex * ra.x + ey * ra.y) * R;
  let B = ctr + (ex * rb.x + ey * rb.y) * R;
  let p = mix(A, B, qu(cc));
  let wp = stripPoint(A, B, qu(cc), qv(cc), lineW(p) * mix(0.45, 1.0, sqrt(scale)));
  var o: LOut;
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(qu(cc), qv(cc), 0.0, 0.0);
  let pcT = fmod(c.root + interval_ifs_iv(c, spoke), 12.0);
  let pcR = fmod(c.root + interval_ifs_iv(c, region), 12.0);
  o.b = vec4f(pcT, pcR, c.start, select(1.0, 0.0, upcoming));
  o.c = vec4f(c.tension, scale, f32(spoke), f32(len));
  return o;
}
fn fs_interval_ifs(in: LOut) -> vec4f {
  let isCur = in.b.w;
  let change = isCur * exp(-max(F.songTime - in.b.z, 0.0) * 3.0);
  // Brighter where the tone of the spoke is sounding right now; the seventh only exists with tension.
  let sounding = chromaAt(i32(in.b.x + 0.5));
  let seventh = select(1.0, sat(in.c.x * 1.6), in.c.z > 2.5);
  let hue = S.p[3].x + mix(pitchHue(in.b.x), pitchHue(in.b.y), 0.3) * 0.55 + 0.1;
  let col = palL(hue, 1.0);
  let size = 0.35 + 0.65 * sqrt(in.c.y);
  let k = (0.12 + 0.45 * isCur + 0.7 * sounding * isCur + 1.4 * change) * size * seventh * S.p[3].y * 0.6;
  let edge = 1.0 - abs(in.a.y * 2.0 - 1.0);
  return glowOut(col * k * sat(edge * 2.0), in.wp);
}
`,
} satisfies LayerDef;
