import type { LayerDef } from '../layer';

const NU = 128; // bell around
const NV = 64; // bell crown to margin
const TN = 24; // tentacles: three per lobe, up to 8 lobes
const TS = 40; // tentacle segments
const TR = 5; // tentacle sides
const BELL = NU * NV;

/**
 * A medusa that swims just ahead of the camera along the path: the harmony is its body, the
 * melody its breath and nerves, the drums its heartbeat.
 *
 * - Body: a bell whose cross-section is a superformula. The chord's quality sets the lobe count
 *   (major 6, minor 5, diminished 7; no chord: 4 soft lobes), its tension sets how sharp the lobes
 *   are (a resolved chord is a soft rounded bell, a tense one a ribbed star with pointed lappets),
 *   and its root turns the lobes to the root's place on the circle of fifths. Three filaments hang
 *   from every lobe. Each chord change morphs over ~0.9 s.
 * - Breath: the bell opens into a wide saucer as the melody rises and closes into a tall bud as it
 *   falls; the filaments spread or gather with it.
 * - Nerves: every lead attack sends a ripple over the bell from the note's own place: its pitch
 *   class sets the longitude (circle of fifths, the frame the lobes turn in), its register the
 *   latitude (high notes start near the crown). The wave runs on down the filaments.
 * - Heartbeat: the kick contracts the bell in a slow, heavy stroke; the bass swells it.
 * - Each lobe's radial canal carries one chord tone and glows as brightly as that tone sounds now.
 */
export default {
  id: 'chord-creature',
  role: 'form',
  source: 'once',
  verts: (BELL + TN * TS * TR) * 6,
  blend: 'opaque',
  // Off: reads as a gimmick, and was recognisable every time it appeared.
  weight: 0,
  layouts: ['flight', 'road', 'river', 'helix'],
  wgsl: /* wgsl */ `
struct chord_creature_St {
  ctr: vec3f, ax: vec3f, e1: vec3f, e2: vec3f, up: vec3f,
  R: f32, open: f32, kick: f32,
  mA: f32, nA: f32,
  mB: f32, nB: f32,
  rot: f32, mixp: f32, chord: u32, hueA: f32, hueB: f32,
  nrip: u32,
  rip: array<vec4f, 6>,
  ripB: array<vec4f, 6>,
};

/**
 * Lobe profile, a superformula with b -> infinity: |cos(m th / 2)|^p, 1 on a lobe's crest, 0 at the
 * seam. p < 1 gives broad rounded lobes meeting in creases (a soft flower); p > 1 narrow pointed
 * ridges over flat troughs (a star).
 */
fn chord_creature_sf(th: f32, m: f32, p: f32) -> f32 {
  return pow(max(abs(cos(m * th * 0.5)), 1e-5), p);
}
/** Lobe count and lobe exponent for a chord. */
fn chord_creature_shape(c: ChordE) -> vec2f {
  if (c.root < 0.0 || c.quality < 0.5) { return vec2f(4.0, 0.5); }
  let m = select(select(7.0, 5.0, c.quality < 2.5), 6.0, c.quality < 1.5);
  let t = sat(c.tension);
  return vec2f(m, mix(0.3, 2.6, t * t * (3.0 - 2.0 * t)));
}
/** Direction on the reference sphere for (th, v); ripples travel over this, whatever the bell's shape. */
fn chord_creature_sdir(th: f32, v: f32) -> vec3f {
  let ph = v * PI * 0.6;
  return vec3f(sin(ph) * cos(th), sin(ph) * sin(th), cos(ph));
}

/** Body colour of a chord: its root on the circle of fifths. */
fn chord_creature_hue(c: ChordE) -> f32 { return select(S.p[3].x + 0.5, S.p[3].x + pitchHue(c.root) * 0.55 + 0.5, c.root >= 0.0); }

fn chord_creature_state() -> chord_creature_St {
  var s: chord_creature_St;
  let now = F.songTime;
  // Just ahead of the playhead, where the camera is looking (a side camera looks further ahead),
  // its frame averaged over two seconds so it glides with the path.
  let eye = camEye();
  let look = normalize(camTarget() - eye);
  var tw = 0.0;
  var ws = 0.0;
  for (var k = 0; k < 7; k++) {
    let t = now + 0.6 + f32(k) * 0.6;
    let w = exp(-(1.0 - dot(normalize(LCenter(t) - eye), look)) * 40.0 - f32(k) * 0.4) + 1e-6;
    tw += t * w;
    ws += w;
  }
  let tc = tw / ws;
  var ctr = vec3f(0.0);
  var up = vec3f(0.0);
  for (var j = -2; j <= 2; j++) {
    ctr += LCenter(tc + f32(j) * 0.5);
    up += LUp(tc + f32(j) * 0.5);
  }
  ctr *= 0.2;
  let fwd = normalize(LCenter(tc + 1.5) - LCenter(tc - 1.5) + vec3f(0.0, 0.0, 1e-4));
  up = normalize(up - fwd * dot(up, fwd) + vec3f(0.0, 1e-4, 0.0));
  var R = length(ctr - camEye()) * 0.14;
  // Where the lead lane runs around the centre (the helix tunnel), stay inside it.
  let clr = length(L(tc, S.p[0].z, 0.0) - LCenter(tc));
  if (clr > 0.3) { R = min(R, clr * 0.4); }
  s.ctr = ctr + up * R * 1.0;
  s.up = up;

  // Heartbeat: the kick low-passed over ~0.4 s, and the bass swelling.
  var kick = 0.0;
  var bass = 0.0;
  for (var k = 0; k < 8; k++) {
    let w = 1.0 - f32(k) * 0.1;
    kick += drumsAt(-f32(k) * 0.05).x * w;
    bass += bassAt(-f32(k) * 0.08).y * w;
  }
  s.kick = sat(kick / 3.5);
  s.R = R * (1.0 + 0.07 * sat(bass / 4.0));

  // Breath: melody height opens the bell.
  var mh = 0.0;
  for (var k = 0; k < 4; k++) { mh += melodyHeight(now - f32(k) * 0.12); }
  s.open = smoothstep(-0.7, 0.7, mh * 0.25 * 1.3 + 0.1);

  // The crown leans back toward the camera so its symmetry reads; filaments trail ahead and down.
  s.ax = normalize(up * 0.72 - fwd * 0.7);
  s.e1 = normalize(cross(s.ax, fwd));
  s.e2 = cross(s.ax, s.e1);

  // Harmony: morph from the previous chord's body to the current one.
  var cur = u32(W.n.z);
  var prev = cur;
  let last = u32(W.n.z + W.n.w);
  for (var i = u32(W.n.z); i < last; i++) {
    if (chords[i].start <= now) { prev = cur; cur = i; }
  }
  let cA = chords[prev];
  let cB = chords[cur];
  s.chord = cur;
  s.hueA = chord_creature_hue(cA);
  s.hueB = chord_creature_hue(cB);
  let shA = chord_creature_shape(cA);
  let shB = chord_creature_shape(cB);
  s.mA = shA.x; s.nA = shA.y;
  s.mB = shB.x; s.nB = shB.y;
  s.mixp = select(smoothstep(0.0, 0.9, now - cB.start), 1.0, cur == prev);
  let rA = select(fifthsAng(cA.root), 0.0, cA.root < 0.0);
  let rB = select(fifthsAng(cB.root), rA, cB.root < 0.0);
  let per = TAU / shB.x;
  s.rot = rA + (fmod(rB - rA + per * 0.5, per) - per * 0.5) * s.mixp;

  // Nerves: the latest lead attacks (binary search for now, then walk back).
  var lo = u32(W.n.x);
  var hi = u32(W.n.x + W.n.y);
  for (var it = 0; it < 16 && lo < hi; it++) {
    let mid = (lo + hi) / 2u;
    if (notes[mid].start <= now) { lo = mid + 1u; } else { hi = mid; }
  }
  var n = 0u;
  var i = lo;
  for (var it = 0; it < 48 && i > u32(W.n.x) && n < 6u; it++) {
    i -= 1u;
    let nt = notes[i];
    if (nt.start < now - 2.4) { break; }
    if (nt.role > 0.5) { continue; }
    let th0 = fifthsAng(fmod(floor(nt.pitch + 0.5), 12.0));
    let v0 = clamp(0.45 - (nt.pitch - S.p[0].z - 4.0) / 30.0, 0.05, 0.9);
    s.rip[n] = vec4f(chord_creature_sdir(th0, v0), now - nt.start);
    s.ripB[n] = vec4f(0.45 + 0.75 * nt.strength, nt.pitch, 0.0, 0.0);
    n++;
  }
  s.nrip = n;
  return s;
}

const CHORD_CREATURE_SPEED: f32 = 2.2;
/** Ripple field at a point on the reference sphere: x = displacement, yzw = emitted light. */
fn chord_creature_ripple(s: chord_creature_St, sd: vec3f, delay: f32) -> vec4f {
  var o = vec4f(0.0);
  for (var k = 0u; k < s.nrip; k++) {
    let r = s.rip[k];
    let d = acos(clamp(dot(sd, r.xyz), -1.0, 1.0)) + delay;
    let x = (d - r.w * CHORD_CREATURE_SPEED) / 0.09;
    let ring = exp(-x * x);
    let a = s.ripB[k].x * exp(-r.w * 1.3);
    let spark = exp(-d * d / 0.008) * exp(-r.w * 8.0);
    o.x += a * ring;
    o = o + vec4f(0.0, palL(S.p[3].x + pitchHue(s.ripB[k].y) * 0.55 + 0.1, 1.0) * (a * ring * 1.1 + spark * 2.5));
  }
  return o;
}

/** Lobe profile at angle th, 1 at a lobe peak, 0 in a trough, morphing between chords. */
fn chord_creature_lobe(s: chord_creature_St, th: f32) -> f32 {
  return mix(chord_creature_sf(th - s.rot, s.mA, s.nA), chord_creature_sf(th - s.rot, s.mB, s.nB), s.mixp);
}

/** Bell surface for (th, v): v = 0 is the crown, v = 1 the scalloped margin. */
fn chord_creature_bell(s: chord_creature_St, th: f32, v: f32, rip: f32) -> vec3f {
  let o = s.open;
  let k = s.kick;
  let ln = chord_creature_lobe(s, th);
  // Lobes hang a little lower than the troughs: a gently scalloped margin.
  let phMax = mix(0.6, 0.47, o) * PI;
  let ph = v * phMax * (1.0 - 0.12 * (1.0 - ln));
  // Ribs: the cross-section takes the lobe shape, deepening from crown to margin.
  let rib = (1.0 - ln) * 0.08 * pow(sin(min(v * 1.4, 1.0) * PI * 0.5), 1.5);
  let rho = sin(ph) * (1.0 - rib) * mix(0.95, 1.3, o) * (1.0 - 0.14 * k * v * v);
  let h = cos(ph) * mix(1.0, 0.62, o) * (1.0 + 0.1 * k);
  let radial = s.e1 * cos(th) + s.e2 * sin(th);
  let nr = radial * sin(ph) + s.ax * cos(ph);
  return s.ctr + (radial * rho + s.ax * h + nr * rip * 0.05) * s.R;
}

/** Brightness of chord tone k right now (its salience over four octaves). */
fn chord_creature_toneSal(c: ChordE, k: u32) -> f32 {
  if (c.root < 0.0) { return 0.0; }
  let pc = chordPc(c, k);
  var sal = 0.0;
  for (var oc = 4; oc <= 7; oc++) { sal += score(0.0, pc + f32(oc) * 12.0).r; }
  return 0.15 + 0.85 * sat(sal);
}
fn chord_creature_toneCol(c: ChordE, k: u32) -> vec3f { return palL(S.p[3].x + pitchHue(chordPc(c, k)) * 0.55 + 0.15, 1.0); }

/** Filament centre line: hangs from the lobe tip, then curls under toward the frame's down. */
fn chord_creature_fil(s: chord_creature_St, root: vec3f, radial: vec3f, u: f32, len: f32, spread: f32) -> vec3f {
  let l = len * s.R;
  return root + (-s.ax * u * (1.0 - 0.3 * u) - s.up * 0.45 * u * u + radial * spread * sin(u * 1.6) * 0.5) * l;
}

fn vs_chord_creature(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = vi / 6u;
  let cc = vi % 6u;
  let s = chord_creature_state();
  let cB = chords[s.chord];
  var p: vec3f;
  var n: vec3f;
  var emis: vec3f;
  var lobeC = -1000.0;
  if (q < ${BELL}u) {
    let th = (f32(q % ${NU}u) + qu(cc)) / ${NU}.0 * TAU;
    let v = (f32(q / ${NU}u) + qv(cc)) / ${NV}.0;
    let eth = TAU / ${NU}.0 * 0.5;
    let ev = 0.5 / ${NV}.0;
    let vv = clamp(v, ev, 1.0 - ev);
    let rp = chord_creature_ripple(s, chord_creature_sdir(th, v), 0.0);
    p = chord_creature_bell(s, th, v, rp.x);
    let pu = chord_creature_bell(s, th + eth, vv, chord_creature_ripple(s, chord_creature_sdir(th + eth, vv), 0.0).x)
      - chord_creature_bell(s, th - eth, vv, chord_creature_ripple(s, chord_creature_sdir(th - eth, vv), 0.0).x);
    let pv = chord_creature_bell(s, th, vv + ev, chord_creature_ripple(s, chord_creature_sdir(th, vv + ev), 0.0).x)
      - chord_creature_bell(s, th, vv - ev, chord_creature_ripple(s, chord_creature_sdir(th, vv - ev), 0.0).x);
    n = normalize(cross(pu, pv) + vec3f(0.0, 0.0, 1e-7));
    if (v < ev) { n = s.ax; }
    emis = rp.yzw;
    // Lobe coordinate for the radial canals (integers = lobe crests), drawn crisp in the fragment.
    lobeC = (th - s.rot) * s.mB / TAU + v * 0.001;
  } else {
    // Filaments: three from every lobe; when the lobe count changes they slide apart and the
    // new lobe's grow in (or the lost one's withdraw).
    let tq = q - ${BELL}u;
    let ti = tq / ${TS * TR}u;
    let seg = (tq / ${TR}u) % ${TS}u;
    let side = tq % ${TR}u;
    let lobe = f32(ti / 3u);
    let sub = f32(ti % 3u) - 1.0;
    let have = select(0.0, 1.0, lobe < s.mA) * (1.0 - s.mixp) + select(0.0, 1.0, lobe < s.mB) * s.mixp;
    if (have < 0.01) { return hidden(); }
    let m = mix(s.mA, s.mB, s.mixp);
    let th = s.rot + (lobe + sub * 0.24) * TAU / m;
    let u = (f32(seg) + qv(cc)) / ${TS}.0;
    let central = 1.0 - abs(sub);
    let len = (1.5 + 0.7 * (1.0 - s.open)) * mix(0.72, 1.0, central) * have;
    let radial = s.e1 * cos(th) + s.e2 * sin(th);
    let root = chord_creature_bell(s, th, 0.97, 0.0);
    // Spread as the bell opens, gather under it as it closes; the kick flicks them out.
    let spread = mix(-0.25, 0.55, s.open) + 0.3 * s.kick + sub * 0.1;
    // The ripple reaching this lobe runs on down the filament as a travelling kink of light.
    let rp = chord_creature_ripple(s, chord_creature_sdir(th, 1.0), u * len * 0.8);
    let c0 = chord_creature_fil(s, root, radial, u, len, spread);
    let c1 = chord_creature_fil(s, root, radial, u + 0.01, len, spread);
    let tng = normalize(c1 - c0);
    let b1 = normalize(cross(tng, radial) + vec3f(0.0, 0.0, 1e-6));
    let b2 = cross(tng, b1);
    let ang = (f32(side) + qu(cc)) / ${TR}.0 * TAU;
    n = b1 * cos(ang) + b2 * sin(ang);
    let rad = s.R * mix(0.012, 0.022, central) * pow(1.0 - u, 0.8) * (0.4 + 0.6 * have) + s.R * 0.003;
    p = c0 + n * rad + radial * rp.x * 0.05 * s.R * u;
    let tone = u32(lobe) % 3u;
    emis = rp.yzw + chord_creature_toneCol(cB, tone) * chord_creature_toneSal(cB, tone) * 0.35 * (1.0 - u) * central;
  }
  o.pos = toClip(p);
  o.wp = p;
  o.nrm = n;
  o.a = vec4f(emis * S.p[3].y, lobeC);
  // Flat: the previous and current chord's colours, the change's progress, the heartbeat.
  o.b = vec4f(s.hueA, s.hueB, s.mixp, s.kick);
  o.c = vec4f(f32(s.chord), s.mB, 0.0, 0.0);
  return o;
}
fn fs_chord_creature(in: LOut) -> vec4f {
  var emis = in.a.xyz;
  let aa = max(fwidth(in.a.w), 1e-4);
  let body = mix(palL(in.b.x, 1.0), palL(in.b.y, 1.0), in.b.z);
  let base = body * 0.3;
  // Heartbeat: the kick lights the jelly from within, strongest where the bell turns away (its thickness seen edge-on).
  let nv = abs(dot(normalize(in.nrm), normalize(camEye() - in.wp)));
  emis += body * (0.04 + 0.4 * in.b.w) * (0.25 + 0.75 * pow(1.0 - nv, 2.0)) * S.p[3].y;
  if (in.a.w > -500.0) {
    // Radial canals along each lobe's crest, anti-aliased, in the colour of the tone it carries.
    let lc = in.a.w;
    let k = floor(lc + 0.5);
    let d = abs(lc - k);
    let line = (sat((0.016 + aa - d) / aa) + 0.3 * exp(-d * d / 0.006)) * sat(0.05 / aa);
    let c = chords[u32(in.c.x)];
    if (c.root >= 0.0 && line > 0.002) {
      let tone = u32(fmod(k, in.c.y)) % 3u;
      emis += chord_creature_toneCol(c, tone) * line * chord_creature_toneSal(c, tone) * in.b.z * 1.4 * S.p[3].y;
    }
  }
  return vec4f(shade(base, emis, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
