import { Morph, wave } from '../morph';
import { particleScene } from '../particleScene';

/**
 * Inside a galaxy of a million stars: a grand-design spiral (or a barred spiral, by DNA), with clean
 * orbits on a flat rotation curve, herded into log-spiral density-wave arms, folded into filaments
 * with dust lanes on the arms' inner edges. The camera drifts round the core inside the disc.
 *
 * The music moves the form, never the speed: the stars orbit and the camera drifts at one steady
 * pace (easing only in long quiet), while the morph winds and unwinds the arms (pitch angle), sharpens
 * or softens them, and folds the disc into more or fewer filaments of different grain, so each
 * appearance is a different galaxy and it keeps changing shape as the music goes on.
 * Beats are light travelling through the stars:
 *  - kick: a broad warm ring of light runs out from the core through the disc;
 *  - snare: a thin bright front in a second colour closes in from the rim, catching only the arm
 *    crests and the young clusters, so it sparkles along the arms;
 *  - melody: each note sends a packet of its own colour (by pitch) running along the arm crests at a
 *    radius set by the pitch (high notes near the core, low notes out in the arms);
 *  - bass history ripples outward as density; chords ease the hue.
 *
 * Only S.p[6..7] are free in particle scenes: the event ages and counts are packed into integer
 * parts, with form parameters in the fractions.
 */

const q = (x: number, bits: number) => Math.min((1 << bits) - 1, Math.floor(x * (1 << bits)));
const morph = new Morph(0.9);
const ms = (age: number) => Math.floor(Math.min(age, 0.999) * 1000);
/** An event's age (ms) with its level (0..15) in the thousands, so the shader scales each front by it. */
const aged = (age: number, lvl: number) => ms(age) + 1000 * Math.round(Math.min(1, Math.max(0, lvl)) * 15);
const KICK_HUE = 0.1;
/** The latest and previous melody notes' pitch (the note front repaints one with the other). */
const lead = { n: -1, cur: 0, prev: 0 };
/** Hue steps so far: each kick steps the hue by its level (a faint kick, a small step). */
const kickHue = { n: -1, steps: 0 };

export default particleScene({
  meta: {
    id: 'curl-nebula',
    name: 'Curl Nebula',
    // Out of the show: Reads as a glowing disc floating in a void.
    auto: false,
    energy: [0, 0.6],
    mood: { valence: 0.55, arousal: 0.3 },
    genres: { ambient: 1, classical: 0.8, lofi: 0.7, jazz: 0.6, synthwave: 0.5, acoustic: 0.5 },
    trails: 0.45,
    kaleido: false,
    sparse: true,
  },
  count: 1 << 20,
  camera(ctx) {
    const m = ctx.music;
    morph.update(m, ctx.dt, ctx.dna);
    const a = morph.at;
    const g = ctx.dna;
    const rig = Math.min(2, Math.floor(g[2] * 3)); // 0 low flyover, 1 high flyover, 2 orbital flow
    // A steady drift round the core; radius and height wander with the morph.
    const ang = morph.travel * (rig === 2 ? 0.22 : 0.12) + g[1] * 6.28;
    const r = (rig === 0 ? 1.15 : rig === 1 ? 1.05 : 1.12) + 0.18 * Math.sin(a[6]);
    const h = (rig === 0 ? 0.22 : rig === 1 ? 0.48 : 0.34) * (1 + 0.25 * Math.sin(a[7]));
    const eye: [number, number, number] = [Math.cos(ang) * r, h, Math.sin(ang) * r];
    let target: [number, number, number];
    if (rig === 2) {
      // Look along the orbit, slightly inward, so the disc streams past.
      const b = ang + 0.85;
      target = [Math.cos(b) * r * 0.85, -0.12, Math.sin(b) * r * 0.85];
    } else {
      // Look down into the disc, the core off to one side, so the arms fill the frame.
      const b = ang + (0.55 + 0.3 * g[5]) * (g[6] > 0.5 ? 1 : -1);
      const tr = rig === 1 ? 0.15 : 0.3;
      target = [Math.cos(b) * tr, -0.1, Math.sin(b) * tr];
    }
    return { eye, target, fovY: rig === 1 ? 1.0 : 1.15, roll: rig === 2 ? 0.12 * (g[7] - 0.5) : 0 };
  },
  streak: () => 0.07,
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const a = morph.at;
    if (morph.notes !== lead.n) {
      lead.prev = morph.notes > lead.n && lead.n >= 0 ? lead.cur : morph.notePitch;
      lead.cur = morph.notePitch;
      lead.n = morph.notes;
    }
    if (morph.kicks !== kickHue.n) {
      if (morph.kicks > kickHue.n && kickHue.n >= 0) kickHue.steps += morph.kickLevel;
      kickHue.n = morph.kicks;
    }
    const fam = Math.min(1, Math.floor(g[0] * 2));
    const arms = fam === 1 ? 2 : [2, 3, 2, 4, 3][Math.floor(g[3] * 5) % 5];
    // The arms wind and unwind: pitch angle 9..36 degrees.
    const cot = 1 / Math.tan((wave(a[0], 9, 36) * Math.PI) / 180);
    const cmode = Math.floor(g[4] * 4);
    const p01 = (x: number) => (Math.max(-1, Math.min(1, x)) * 0.5 + 0.5) * 0.99;
    // Snare: age (ms) * 8 + snare count (which clusters are lit).
    p[24] = aged(morph.snareAge, morph.snareLevel) * 8 + (morph.snares % 8);
    // Pattern phase: one steady pace.
    p[25] = morph.travel * 0.22;
    // Orbit rate (x1000) + the new note's pitch.
    p[26] = Math.round(750 * morph.flow) + p01(lead.cur);
    // Kick age (ms) * 8 + arm sharpness (< 8).
    p[27] = aged(morph.kickAge, morph.kickLevel) * 8 + Math.min(7.99, wave(a[2], 0.15, 1) * 7.99);
    // A: arms | family | colour mode | hue | shape gene.
    p[28] = arms + fam * 8 + cmode * 64 + q(g[7], 6) * 256 + q(g[5], 5) * 16384;
    // Pitch-angle cotangent (x500) + the previous note's pitch.
    p[29] = Math.round(cot * 500) + p01(lead.prev);
    // Lead age (ms) + filament displacement amount (fraction).
    const disp = wave(a[1], 0.05, 0.34) * (0.8 + 0.4 * m.energySlow);
    p[30] = aged(morph.leadAge, morph.noteLevel) + Math.min(0.99, disp);
    // Filament grain (x100) + the hue: a slow drift plus one step per kick (the kick front carries it).
    const hue = wave(a[4], 0, 0.3) + kickHue.steps * KICK_HUE;
    p[31] = Math.round(wave(a[3], 0.55, 1.7) * 100) + (hue - Math.floor(hue)) * 0.999;
  },
  wgsl: /* wgsl */ `
fn cn_pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Precise per-index hash (hash11 on f32 indices near 1e6 loses precision and stripes).
fn cn_h(i: u32, k: u32) -> f32 { return f32(cn_pcg(cn_pcg(i) + k * 0x9E3779B9u) >> 8u) / 16777216.0; }

// Packed per-cue genes and music.
const CN_KICK_HUE: f32 = 0.1;
fn cn_bitsA(sh: u32, n: u32) -> u32 { return (u32(S.p[7].x + 0.5) >> sh) & ((1u << n) - 1u); }
fn cn_arms() -> f32 { return f32(cn_bitsA(0u, 3u)); }
fn cn_fam() -> u32 { return cn_bitsA(3u, 3u); }
fn cn_cmode() -> u32 { return cn_bitsA(6u, 2u); }
fn cn_hue() -> f32 { return f32(cn_bitsA(8u, 6u)) / 63.0 + fract(S.p[7].w) / 0.999; }
fn cn_shape() -> f32 { return f32(cn_bitsA(14u, 5u)) / 31.0; }
fn cn_kickAge() -> f32 { return fmod(floor(S.p[6].w / 8.0), 1000.0) / 1000.0; }
fn cn_kickLvl() -> f32 { return floor(floor(S.p[6].w / 8.0) / 1000.0) / 15.0; }
fn cn_armK() -> f32 { return mix(0.5, 3.2, fract(S.p[6].w / 8.0) * 8.0 / 7.99); }
fn cn_snareAge() -> f32 { return fmod(floor(S.p[6].x / 8.0), 1000.0) / 1000.0; }
fn cn_snareLvl() -> f32 { return floor(floor(S.p[6].x / 8.0) / 1000.0) / 15.0; }
fn cn_snareK() -> u32 { return u32(fmod(S.p[6].x, 8.0) + 0.5); }
fn cn_orbit() -> f32 { return floor(S.p[6].z) / 1000.0; }
fn cn_cot() -> f32 { return floor(S.p[7].y) / 500.0; }
fn cn_disp() -> f32 { return fract(S.p[7].z); }
fn cn_leadAge() -> f32 { return fmod(floor(S.p[7].z), 1000.0) / 1000.0; }
fn cn_leadLvl() -> f32 { return floor(floor(S.p[7].z) / 1000.0) / 15.0; }
fn cn_grain() -> f32 { return floor(S.p[7].w) / 100.0; }
fn cn_pitchNew() -> f32 { return fract(S.p[6].z) / 0.99 * 2.0 - 1.0; }
fn cn_pitchOld() -> f32 { return fract(S.p[7].y) / 0.99 * 2.0 - 1.0; }

fn cn_leadCol(pitch: f32, hue: f32) -> vec3f { return palL(hue + 0.5 + 0.3 * pitch + 0.25 * F.morph2.x, 0.6); }
fn cn_snareCol(hue: f32) -> vec3f { return mix(palL(hue + 0.78, 1.0), vec3f(1.0), 0.35); }

// Each beat leaves the disc changed, and the change travels as a front with a glow on it:
//  - kick: a broad ring runs out from the core; behind it the disc has stepped round the hue wheel;
//  - snare: a thin front closes in from the rim; behind it a new set of young clusters burns;
//  - melody: a ring spreads both ways from the radius set by the pitch; behind it the arm crests
//    carry the new note's colour.
struct CnBeat { hue: f32, knotSet: u32, tint: vec3f, glow: vec3f, gain: f32 };
fn cn_beats(pos: vec3f, rn: f32, arm: f32, idx: u32) -> CnBeat {
  var o: CnBeat;
  let away = smoothstep(0.3, 1.0, length(pos - S.p[4].xyz));
  // Kick.
  let ka = cn_kickAge();
  let kr = ka * 4.6;
  let kd = rn - kr;
  let kBehind = smoothstep(0.12, -0.12, kd);
  let kl = cn_kickLvl();
  o.hue = cn_hue() - CN_KICK_HUE * kl * (1.0 - kBehind);
  // Each front swells in over its first ~0.1 s and carries its hit's strength.
  let kw = exp(-kd * kd * 4.0) * exp(-ka * 1.8) * kl * smoothstep(0.0, 0.1, ka);
  // Snare.
  let sa = cn_snareAge();
  let sr = 4.3 - sa * 4.8;
  let sd = rn - sr;
  let k = cn_snareK();
  o.knotSet = select((k + 7u) % 8u, k, sd > 0.0);
  let sw = exp(-sd * sd * 70.0) * exp(-sa * 2.5) * cn_snareLvl() * smoothstep(0.0, 0.08, sa);
  // Melody.
  let la = cn_leadAge();
  let rL = mix(2.6, 0.5, cn_pitchNew() * 0.5 + 0.5);
  let ld = abs(rn - rL) - la * 4.2;
  let lBehind = smoothstep(0.1, -0.1, ld);
  o.tint = mix(cn_leadCol(cn_pitchOld(), o.hue), cn_leadCol(cn_pitchNew(), o.hue), lBehind);
  let lw = exp(-ld * ld * 14.0) * exp(-la * 1.8) * cn_leadLvl() * smoothstep(0.0, 0.15, la);
  let knot = step(0.992, cn_h(idx, 7u + o.knotSet));
  o.glow = (cn_leadCol(cn_pitchNew(), o.hue) * lw * (0.3 + 0.7 * arm) * 0.09 + cn_snareCol(o.hue) * sw * sat(0.1 + arm + knot * 4.0) * 0.05) * away;
  o.gain = 1.0 + (2.8 * kw + 2.0 * lw * (0.3 + 0.7 * arm) + 2.0 * sw * sat(arm + knot * 3.0)) * away;
  return o;
}

// Per-particle constants: home radius, home height, bulge flag, spectrum band.
fn cn_home(idx: u32) -> vec4f {
  let h1 = cn_h(idx, 1u);
  let h2 = cn_h(idx, 2u);
  let h3 = max(cn_h(idx, 3u), 1e-5);
  let h4 = cn_h(idx, 4u);
  let g = sqrt(-2.0 * log(h3)) * cos(TAU * h4);
  let bulge = h1 < 0.08 + 0.12 * cn_shape();
  let rDisc = 0.3 + min(-log(1.0 - h2 * 0.985) * 0.95, 3.6);
  if (bulge) {
    // Oblate spheroid: a 3D radius split into cylindrical radius and height.
    let rb = 0.05 + 0.6 * pow(h2, 1.4);
    let u = h4 * 2.0 - 1.0;
    return vec4f(rb * sqrt(1.0 - u * u) + 0.02, rb * u * 0.65, 1.0, cn_h(idx, 5u));
  }
  return vec4f(rDisc, g * (0.035 + 0.02 * rDisc), 0.0, cn_h(idx, 5u));
}

// Spiral-arm phase in [-PI, PI]; 0 on an arm crest. Arms trail the rotation.
fn cn_armPsi(theta: f32, r: f32) -> f32 {
  let m = cn_arms();
  let psi = m * (theta - S.p[6].y + log(max(r, 0.05)) * cn_cot());
  return atan2(sin(psi), cos(psi));
}

// Displacement field, built so it inverts exactly given the stored clean radius rc:
// azimuth shift depends on (rc, yc) only, height shift on (theta_world, rc),
// radius shift on (theta_world, rc, yc).
fn cn_dTheta(rc: f32, yc: f32) -> f32 {
  return noise3(vec3f(rc * 2.3, yc * 3.0, S.p[6].y * 0.3 + 5.0)) * cn_disp() * 0.9 / max(rc, 0.35);
}
fn cn_dY(thw: f32, rc: f32) -> f32 {
  let a = thw - S.p[6].y;
  let n = noise4(vec3f(cos(a) * rc, S.p[6].y * 0.22, sin(a) * rc) * 2.1 * cn_grain());
  return (n.x + 0.5 * n.y) * cn_disp() * 0.22 * smoothstep(0.2, 0.8, rc);
}
fn cn_dR(thw: f32, rc: f32, yc: f32) -> f32 {
  let a = thw - S.p[6].y;
  let q = vec3f(cos(a) * rc, yc * 2.0 + S.p[6].y * 0.3, sin(a) * rc);
  let gq = q * cn_grain();
  let n = noise4(gq * 2.4) + 0.5 * noise4(gq * 5.3 + vec3f(11.0));
  return (n.x + n.z * 0.6) * cn_disp() * smoothstep(0.15, 0.7, rc);
}

fn cn_gauss(idx: u32, k: u32) -> f32 {
  return sqrt(-2.0 * log(max(cn_h(idx, k), 1e-5))) * cos(TAU * cn_h(idx, k + 1u));
}

fn simulate(idx: u32, p: ptr<function, Particle>) {
  let dt = min(F.dt, 1.0 / 30.0);
  let fam = cn_fam();
  let world = (*p).pos.xyz;
  var life = (*p).pos.w;
  let home = cn_home(idx);
  let m = cn_arms();
  // Barred spiral: a rigid bar of stars whose ends feed the two arms.
  if (fam == 1u) {
    let hb = cn_h(idx, 1u);
    if (hb > 0.2 && hb < 0.4) {
      let L = 0.7 + 0.6 * cn_shape();
      let x = (cn_h(idx, 2u) * 2.0 - 1.0) * L;
      let a = S.p[6].y - log(max(L, 0.05)) * cn_cot();
      let w = 0.11 * L * (1.0 - 0.5 * abs(x) / L);
      let lz = w * cn_gauss(idx, 3u);
      let ly = 0.05 * L * cn_gauss(idx, 6u) * (1.0 - 0.6 * abs(x) / L);
      let np = vec3f(cos(a) * x - sin(a) * lz, ly, sin(a) * x + cos(a) * lz);
      let v = select((np - world) / max(dt, 1e-4), vec3f(0.0), life <= 0.0);
      (*p).vel = vec4f(v, abs(x));
      (*p).pos = vec4f(np, 5.0);
      return;
    }
  }
  let rh = home.x;
  // Invert the displacement to recover the clean orbit (rc is stored in vel.w).
  var rc = (*p).vel.w;
  if (rc > 9.0 || rc <= 0.0) { life = 0.0; }
  let thw = atan2(world.z, world.x);
  var yc = world.y - cn_dY(thw, rc);
  var theta = thw - cn_dTheta(rc, yc);
  if (life <= 0.0) {
    let fr = u32(F.frame);
    let hx = cn_h(idx, 10u + fr);
    let hy = cn_h(idx, 20u + fr);
    let hz = cn_h(idx, 30u + fr);
    // Spawn near an arm crest so the arms stay populated; bulge stars spawn anywhere.
    let k = floor(hx * m);
    let spread = (hy + hz - 1.0) * 2.8;
    rc = rh;
    yc = home.y;
    theta = S.p[6].y - log(max(rh, 0.05)) * cn_cot() + (k * TAU + spread) / m + select(0.0, hz * TAU, home.z > 0.5);
    life = 3.0 + cn_h(idx, 40u + fr) * 10.0;
  }

  let discW = 1.0 - home.z * 0.7;
  let omega = 0.5 * cn_orbit() / sqrt(rc * rc + 0.1);
  let psi = cn_armPsi(theta, rc);
  let arm = exp(-psi * psi * 1.4);
  theta += omega * dt - 0.5 * sin(psi) / m * dt * discW;

  // Gravity: relax radius and height toward home.
  rc = rh + (rc - rh) * exp(-0.85 * dt);
  let yHome = home.y * (1.0 - 0.45 * arm * discW);
  yc = yHome + (yc - yHome) * exp(-1.4 * dt);

  // Forward displacement.
  let tw = theta + cn_dTheta(rc, yc);
  let yw = yc + cn_dY(tw, rc);
  let rw = max(rc + cn_dR(tw, rc, yc), 0.0);
  let np = vec3f(cos(tw) * rw, yw, sin(tw) * rw);
  life -= dt;
  let v = select((np - world) / max(dt, 1e-4), vec3f(0.0), (*p).pos.w <= 0.0 || length(np - world) > 1.0);
  (*p).vel = vec4f(v, rc);
  (*p).pos = vec4f(np, life);
}

// Colour model: t is normalized radius, arm the arm/feature weight.
fn cn_color(t: f32, band: f32, lvl: f32, arm: f32, core: f32, hue0: f32) -> vec3f {
  let hue = hue0 + 0.12 * F.morph2.x;
  let cm = cn_cmode();
  let warmCore = mix(F.pal3.rgb, vec3f(1.0, 0.88, 0.7) * max(luma(F.pal3.rgb), 0.3) * 1.3, 0.3);
  var col: vec3f;
  if (cm == 1u) {
    // Radial rainbow through the palette.
    col = palL(hue + t * 0.45 + band * 0.08, 0.35);
  } else if (cm == 2u) {
    // Cool palette ramp with the arms in a second hue.
    col = mix(palRampL(0.55 + 0.3 * band, 0.3), palL(hue + 0.4, 0.4), arm * 0.5);
  } else if (cm == 3u) {
    // Emission-line look: dim disc, hot knots along the features.
    col = mix(palRampL(0.3 + 0.2 * band, 0.2), palL(hue + 0.5 * band, 0.5), arm);
  } else {
    col = palRamp(sat(0.88 - t * 0.2));
    col = mix(col, pal(band * 0.5 + hue + t * 0.07), 0.4);
    col = col * (0.32 / max(luma(col), 0.05));
    col = mix(col, mix(F.pal2.rgb, F.pal3.rgb, sat(lvl * 1.5)), arm * 0.45);
  }
  return mix(col, warmCore, core * 0.75);
}

fn shade(p: Particle, idx: u32) -> Shade {
  var s: Shade;
  let fam = cn_fam();
  let home = cn_home(idx);
  let band = home.w;
  let pos = p.pos.xyz;
  let lvl = spec(band);
  let rc = p.vel.w;
  let rn = rc;
  let theta = atan2(pos.z, pos.x);
  let psi = cn_armPsi(theta, rc);
  var arm = exp(-psi * psi * cn_armK()) * smoothstep(0.25, 0.7, rn);
  // Dust lane on the inner edge of each arm, broken up by noise.
  let pr = rotY(-S.p[6].y) * pos;
  let dn = noise3(pr * 3.4 + vec3f(7.0)) * 0.5 + 0.5;
  let lane = psi + 0.7;
  let dust = exp(-lane * lane * 6.0) * smoothstep(0.3, 0.75, dn) * smoothstep(0.35, 1.0, rn) * (1.0 - home.z);
  // Bass ripples outward from the core: older bass history lives at larger radius.
  let ripple = hist(0.04, sat(rn * 0.09));
  let mids = hist(0.3 + band * 0.5, sat(rn * 0.09));
  let core = exp(-rn * rn * 6.0);
  let bar = fam == 1u && cn_h(idx, 1u) > 0.2 && cn_h(idx, 1u) < 0.4;
  if (bar) { arm = 0.6; }
  let bt = cn_beats(pos, rn, arm, idx);
  // Melody: the arm crests carry the latest note's colour.
  let col = mix(cn_color(rn, band, lvl, arm, core, bt.hue), bt.tint, arm * 0.45 * (1.0 - core));
  // Young clusters along the arm crests (the snare front relights a new set).
  let knot = step(0.992, cn_h(idx, 7u + bt.knotSet)) * arm;

  var bright = 0.013 * (0.7 + 1.1 * arm) * select(1.0, 0.7, bar) * select(1.0, 0.4, home.z > 0.5);
  bright *= 1.0 + 0.5 * lvl * lvl + 0.6 * mids * mids * arm;
  bright *= 1.0 + 1.0 * ripple * ripple * (1.0 - core * 0.6);
  bright *= 1.0 - 0.9 * dust;
  bright *= 1.0 + core * 0.3;
  bright *= 0.8 + 0.4 * F.intensity;
  bright *= mix(0.5, 1.0, smoothstep(0.15, 0.8, rn));
  // Stars brushing the lens fade instead of blowing up.
  let live = smoothstep(0.0, 0.8, p.pos.w) * smoothstep(0.05, 0.45, length(pos - S.p[4].xyz));
  s.color = (col * bright + mix(F.pal3.rgb, pal(band + 0.3 + bt.hue), 0.5) * knot * 0.12) * bt.gain * live + bt.glow * live;
  s.size = 0.006 + 0.003 * lvl + 0.012 * knot;
  return s;
}

fn background(uv: vec2f, rd: vec3f) -> vec3f {
  let eye = S.p[4].xyz;
  let toCore = normalize(-eye);
  let ca = max(1.0 - dot(rd, toCore), 0.0);
  // Deep-space gradient, faint nebular haze and a soft halo around the core.
  let n = fbm3(rd * 2.4 + vec3f(S.p[6].y * 0.15, cn_hue() * 7.0, 0.0), 4);
  let nb = pow(sat(n * 0.8 + 0.4), 3.0);
  var c = F.pal0.rgb * (0.1 + 0.15 * sat(0.6 - rd.y)) + mix(F.pal1.rgb, F.pal2.rgb, n + 0.5) * nb * 0.025 * (0.5 + F.energySlow);
  c += mix(F.pal2.rgb, F.pal3.rgb, 0.5) * exp(-ca * 70.0) * 0.05;
  c += F.pal1.rgb * exp(-ca * 14.0) * 0.012;
  // Sparse distant stars: one soft dot per lucky cell.
  let qs = rd * 150.0;
  let cell = floor(qs);
  let h = hash33(cell);
  let sp = cell + 0.5 + (h - 0.5) * 0.7;
  let d = length(qs - sp);
  let on = step(0.988, hash13(cell + vec3f(7.1, 3.3, 1.9)));
  c += mix(vec3f(1.0), F.pal3.rgb, h.z) * on * exp(-d * d * 30.0) * (0.08 + 0.25 * h.x * h.x);
  return c;
}
`,
});
