import type { LayerDef } from '../layer';

const RINGS = 96;
const SEGS = 192;
const NEAR_RINGS = 64;

/**
 * A cymatic sea: a dark liquid plain under the travel path whose relief is the standing-wave
 * pattern of the chord sounding, like sand on a Chladni plate or Faraday waves in a dish.
 *
 * The chord's quality sets the plate's symmetry: a major triad rings a honeycomb of domes (three
 * standing directions), a minor triad a square Chladni grid (two), a diminished triad a five-fold
 * quasi-crystal that never repeats. The root's waves carry the lattice; the third and fifth add
 * standing waves at their just-intonation ratios over the root, and the chord's functional
 * tension both strengthens them and twists them away from the root, so the tonic is a clean
 * crystal and dominant or borrowed chords break into moire interference. The root turns the
 * lattice through its symmetry (a fifth apart is a small turn, a tritone the largest), and each
 * chord centres its pattern on the path where it begins. A chord change sweeps toward you over
 * the sea as a soft front, from the place in the travel where it will sound.
 *
 * The nodal lines (where the plate is still, where the sand gathers) glow faintly in the
 * root's colour. Melody attacks drop rings at the note's place on the path, finer for higher
 * notes; each kick sends a swell outward from the playhead that lifts the pattern as it passes.
 */
export default {
  id: 'cymatic-sea',
  role: 'world',
  darkOnly: true,
  source: 'once',
  verts: RINGS * SEGS * 6,
  blend: 'opaque',
  weight: 1,
  layouts: ['flight', 'road', 'river'],
  wgsl: /* wgsl */ `
const CYMATIC_SEA_REACH: f32 = 340.0;
const CYMATIC_SEA_R0: f32 = 1.2;
const CYMATIC_SEA_NEAR_R: f32 = 28.0;
/** Seconds a melody ring lives. */
const CYMATIC_SEA_LIFE: f32 = 2.2;
/** Wavenumber of the root's standing wave (world units). */
const CYMATIC_SEA_K: f32 = 1.8;

/**
 * The sea's frame for this frame: xy = travel direction on the level plane, z = path speed
 * (world units per second), w = sea level.
 */
fn cymatic_sea_frame() -> vec4f {
  let now = F.songTime;
  let a = LCenter(now - 2.0);
  let b = LCenter(now + 2.0);
  let d = vec2f(b.x - a.x, b.z - a.z);
  let sp = max(length(b - a) / 4.0, 0.3);
  let f = select(vec2f(0.0, 1.0), normalize(d), length(d) > 1e-3);
  // The level sits under the score surface, following the path's altitude over the surrounding
  // seconds as a soft minimum, so the sea sinks ahead of a dive but a climb lifts you away from it.
  let y0 = LCenter(now).y;
  var acc = 0.0;
  var wsum = 0.0;
  for (var i = -4; i <= 4; i++) {
    let t = now + f32(i) * 2.0;
    let y = (LCenter(t) + LUp(t) * SURFACE_LANE * S.p[0].w).y - y0;
    let w = exp(-f32(i * i) / 10.0);
    acc += w * exp(-0.7 * clamp(y, -40.0, 40.0));
    wsum += w;
  }
  return vec4f(f, sp, y0 - log(acc / wsum) / 0.7 - 0.3);
}

/** Standing-wave mode of chord k at sea point p: (height in -1..1, d/dx, d/dz). lod = footprint in world units. */
fn cymatic_sea_mode(k: i32, p: vec2f, lod: f32) -> vec3f {
  if (k < 0) { return vec3f(0.0); }
  let c = chords[k];
  if (c.root < 0.0) { return vec3f(0.0); }
  // The chord's drive point: where it begins on the path.
  let q = p - LCenter(c.start).xz;
  // Just-intonation ratios of the chord tones over the root.
  var ratio = array<f32, 3>(1.0, select(1.2, 1.25, c.quality < 1.5), select(1.5, 1.40625, c.quality > 2.5));
  // The root's lattice carries the form; the other tones interfere more the more tense the chord.
  let t2 = c.tension * c.tension;
  var amp = array<f32, 3>(1.0, 0.12 + 0.5 * t2, 0.1 + 0.4 * t2);
  // Symmetry of the plate: a major triad rings a honeycomb (3 standing directions), a minor triad
  // a square Chladni grid (2), a diminished triad a five-fold quasi-crystal that never repeats.
  let nd = select(select(2, 3, c.quality < 1.5), 5, c.quality > 2.5);
  let step = PI / f32(nd);
  // The root turns the lattice through its symmetry period: a fifth apart is one small step.
  let th0 = fifthsAng(c.root) / TAU * step;
  var s = vec3f(0.0);
  for (var i = 0; i < 3; i++) {
    let kk = CYMATIC_SEA_K * ratio[i];
    let a = amp[i] * exp(-0.5 * kk * kk * lod * lod);
    // Tension twists each tone's star away from the root's.
    let th = th0 + c.tension * f32(i) * 0.36;
    for (var j = 0; j < nd; j++) {
      let ang = th + f32(j) * step;
      let d = vec2f(cos(ang), sin(ang)) * kk;
      let ph = dot(d, q);
      s += vec3f(cos(ph), -sin(ph) * d) * a;
    }
  }
  return s / (f32(nd) * (amp[0] + amp[1] + amp[2]));
}

struct CymaticSeaHarm { f: vec3f, pres: f32, col: vec3f };

fn cymatic_sea_rootCol(k: i32) -> vec3f {
  let r = chords[k].root;
  return select(palL(S.p[3].x + 0.1, 1.0), palL(S.p[3].x + pitchHue(r) * 0.55 + 0.5, 1.0), r >= 0.0);
}

/**
 * The harmony at sea point p. Ahead of the playhead the sea holds the chord that will sound when
 * you get there, behind it the chord that sounded; chord changes ease across a front ~1 s wide.
 */
fn cymatic_sea_harm(p: vec2f, lod: f32, fm: vec4f, ph: vec2f) -> CymaticSeaHarm {
  var h: CymaticSeaHarm;
  h.col = palL(S.p[3].x + 0.1, 1.0);
  let c0 = i32(W.n.z);
  let cn = i32(W.n.w);
  if (cn <= 0) { return h; }
  let now = F.songTime;
  let tc = clamp(now + dot(p - ph, fm.xy) / fm.z, now - worldPast(), now + S.p[1].y);
  var k = c0;
  for (var i = c0 + 1; i < c0 + cn; i++) { if (chords[i].start <= tc) { k = i; } }
  var a = k;
  var b = k;
  var s = 0.0;
  let E = 0.55;
  if (k > c0 && tc - chords[k].start < E) {
    a = k - 1;
    s = smoothstep(-E, E, tc - chords[k].start);
  } else if (k + 1 < c0 + cn && chords[k + 1].start - tc < E) {
    b = k + 1;
    s = smoothstep(-E, E, tc - chords[k + 1].start);
  }
  let fa = cymatic_sea_mode(a, p, lod);
  var fb = fa;
  if (b != a) { fb = cymatic_sea_mode(b, p, lod); }
  h.f = mix(fa, fb, s);
  h.pres = mix(select(0.0, 1.0, chords[a].root >= 0.0), select(0.0, 1.0, chords[b].root >= 0.0), s);
  h.col = mix(cymatic_sea_rootCol(a), cymatic_sea_rootCol(b), s);
  return h;
}

/** First note in the window starting after t. */
fn cymatic_sea_after(t: f32) -> u32 {
  var lo = u32(W.n.x);
  var hi = lo + u32(W.n.y);
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi) / 2u;
    if (notes[mid].start <= t) { lo = mid + 1u; } else { hi = mid; }
  }
  return lo;
}

struct CymaticSeaRip { f: vec3f, glow: vec3f };

/** Rings from recent melody attacks: height and gradient, plus the light of each ring's front. */
fn cymatic_sea_ripples(p: vec2f, lod: f32, fm: vec4f, ph: vec2f) -> CymaticSeaRip {
  var o: CymaticSeaRip;
  let now = F.songTime;
  let first = u32(W.n.x);
  let cv = fm.z * 1.5;
  // Rings never reach further than this from the playhead: the far sea skips the search.
  if (length(p - ph) > CYMATIC_SEA_LIFE * cv + 4.0 + S.p[0].y * 14.0) { return o; }
  var k = cymatic_sea_after(now);
  var guard = 0u;
  loop {
    if (k <= first || guard >= 32u) { break; }
    k -= 1u;
    guard += 1u;
    let n = notes[k];
    let age = now - n.start;
    if (age > CYMATIC_SEA_LIFE) { break; }
    if (u32(n.role + 0.5) != 0u) { continue; }
    let dv = p - L(n.start, n.pitch, 0.0).xz;
    let r = length(dv) + 1e-4;
    let x = r - age * cv;
    // Higher notes ring finer.
    let lam = 1.3 * exp2((S.p[0].z - n.pitch) / 24.0);
    let kr = TAU / lam;
    let sig2 = lam * lam * 0.9;
    let g = exp(-x * x / sig2);
    let fade = exp(-age * 1.3) * (1.0 - age / CYMATIC_SEA_LIFE) * (0.4 + 0.6 * n.strength) / (1.0 + 0.12 * age * cv);
    let a = 0.4 * fade * exp(-0.5 * kr * kr * lod * lod);
    let dr = a * g * (-2.0 * x / sig2 * cos(kr * x) - kr * sin(kr * x));
    o.f += vec3f(a * g * cos(kr * x), dv / r * dr);
    o.glow += palL(S.p[3].x + pitchHue(n.pitch) * 0.55, 1.0) * exp(-x * x / (lam * lam * 0.03)) * fade;
  }
  return o;
}

/** Each kick swells outward from the playhead and lifts the pattern as it passes. */
fn cymatic_sea_swell(p: vec2f, ph: vec2f) -> f32 {
  let tau = length(p - ph) / 22.0;
  let k = (drumsAt(-tau - 0.05).x + drumsAt(-tau).x * 2.0 + drumsAt(-tau + 0.05).x) * 0.25;
  return 0.45 + 0.8 * k;
}

/**
 * Radius of ring x (0..RINGS). Near rings are spaced geometrically, fine enough to carry the relief;
 * beyond NEAR_R they step evenly in view angle (a few px apart), so the horizon is never a stack of
 * sub-pixel slivers. h = eye height above the sea.
 */
fn cymatic_sea_ringR(x: f32, h: f32) -> f32 {
  let n1 = ${NEAR_RINGS}.0;
  if (x <= n1) { return CYMATIC_SEA_R0 * (exp(x / n1 * log(1.0 + CYMATIC_SEA_NEAR_R / CYMATIC_SEA_R0)) - 1.0); }
  let th = mix(atan(h / CYMATIC_SEA_NEAR_R), atan(h / CYMATIC_SEA_REACH), (x - n1) / (${RINGS}.0 - n1));
  return h / tan(th);
}

fn cymatic_sea_amp() -> f32 { return 0.3 + 0.35 * S.p[3].w; }

fn vs_cymatic_sea(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = vi / 6u;
  let cc = vi % 6u;
  let ir = q / ${SEGS}u;
  let ia = q % ${SEGS}u;
  let fr = (f32(ir) + qv(cc)) / ${RINGS}.0;
  let fa = (f32(ia) + qu(cc)) / ${SEGS}.0;
  let eye = camEye();
  var fm = cymatic_sea_frame();
  // Cameras beside the path drop with its bank: the sea always stays well below the eye.
  fm.w = smin(fm.w, eye.y - 1.4, 1.0);
  let h = max(eye.y - fm.w, 0.4);
  let x = fr * ${RINGS}.0;
  let r = cymatic_sea_ringR(x, h);
  let ph = LCenter(F.songTime).xz;
  let p = eye.xz + vec2f(cos(fa * TAU), sin(fa * TAU)) * r;
  // Grid spacing here: the relief fades where the mesh is too coarse to carry it (shading still does).
  let spacing = max(cymatic_sea_ringR(x + 1.0, h) - r, r * TAU / ${SEGS}.0);
  let hm = cymatic_sea_harm(p, spacing, fm, ph);
  let rp = cymatic_sea_ripples(p, spacing, fm, ph);
  let hgt = hm.f.x * cymatic_sea_amp() * cymatic_sea_swell(p, ph) + rp.f.x;
  let wp = vec3f(p.x, fm.w + hgt * exp(-spacing * spacing * 0.8), p.y);
  o.pos = toClip(wp);
  o.wp = wp;
  // The space mirrored in the calm sea, per vertex: the background is smooth, and the waves still
  // modulate it per pixel through the Fresnel term and the glitter.
  var rf = reflect(normalize(wp - eye), vec3f(0.0, 1.0, 0.0));
  rf.y = abs(rf.y);
  o.nrm = bgColor(rf);
  o.a = vec4f(p, 0.0, 0.0);
  // Constant for the frame (the eye is costly to recompute per pixel): eye + path speed, playhead + light hue + heading.
  o.b = vec4f(eye, fm.z);
  // A low light ahead in the colour of the coming chord: its glitter path draws the relief toward the horizon.
  let ch = chordAtT(3.0);
  o.c = vec4f(ph, select(S.p[3].x + 0.1, S.p[3].x + pitchHue(ch.x * 13.0 - 1.0) * 0.55 + 0.5, ch.x > 0.02), atan2(fm.y, fm.x));
  return o;
}

fn fs_cymatic_sea(in: LOut) -> vec4f {
  let p = in.a.xy;
  let fm = vec4f(cos(in.c.w), sin(in.c.w), in.b.w, 0.0);
  let ph = in.c.xy;
  let lod = length(fwidth(p)) * 0.7;
  let hm = cymatic_sea_harm(p, lod, fm, ph);
  let sw = cymatic_sea_swell(p, ph);
  // Nodal lines: where the plate stands still. Anti-aliased; once thinner than a pixel they merge into a faint sheen.
  let fw = fwidth(hm.f.x);
  let rp = cymatic_sea_ripples(p, lod, fm, ph);
  let line = 1.0 - smoothstep(0.0, fw * 1.4, abs(hm.f.x));
  let nodal = line * sat(1.3 - lod * CYMATIC_SEA_K * 3.0);

  let H = hm.f * cymatic_sea_amp() * sw + rp.f;
  let n = normalize(vec3f(-H.y, 1.0, -H.z));
  let eye = in.b.xyz;
  let v = normalize(eye - in.wp);
  let nv = max(dot(n, v), 1e-3);
  let fre = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  // The mirrored space comes per vertex (for a calm sea); a wave tilted toward the horizon mirrors
  // more of its glow, one tilted away mirrors the darker sky above.
  let ry = abs(reflect(-v, n).y);
  let env = in.nrm * clamp(exp((v.y - ry) * 6.0), 0.3, 2.0);
  let sunC = mix(vec3f(1.0), palL(in.c.z, 1.0), 0.55);
  let sunDir = normalize(vec3f(fm.x, 0.32, fm.y));
  let spec = core_ggx(n, v, sunDir, 0.16 + 0.45 * sat(lod * CYMATIC_SEA_K * 0.8), vec3f(0.02)) * sunC * 0.5;
  let body = hm.col * 0.006 * (0.6 + 0.4 * sat(H.x * 2.0 + 0.5));
  // The antinodes, where the plate moves most, hold a soft light that the kick swell lifts.
  let crest = sat(hm.f.x * 1.4);
  let emis = (hm.col * hm.pres * (nodal * (0.2 + 0.4 * sw) * 0.35 + crest * crest * crest * sw * 0.1) + rp.glow * 0.45) * S.p[3].y;
  let c = body + env * fre * 1.3 + spec + core_emis(emis);
  return vec4f(fogged(c, in.wp), 1.0);
}
`,
} satisfies LayerDef;
