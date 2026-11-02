import { raymarchScene } from '../raymarchScene';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Event Horizon. A Schwarzschild black hole (rs = 1) rendered by integrating every
 * camera ray as a null geodesic (a = -1.5 h^2 x / r^5), so the accretion disk's far
 * side lifts over the shadow, secondary images wrap underneath, the photon ring
 * hugs the shadow and the starfield swirls into an Einstein ring. The disk is
 * Doppler beamed and gravitationally redshifted.
 *
 * DNA: disk construction (thin turbulent / flared multi-layer / ringlets / spiral
 * arms / torn clumps), camera inclination + distance, temperature profile + ISCO,
 * jets, sky (star density, nebula, lensed background galaxy), companion star with
 * a mass-transfer stream, camera rig, disk warp + Doppler strength + spin sense.
 *
 * The camera sits close over the disk so it and its lensed arc fill the frame. Each kick
 * rolls a compression wave out through the disk; snares light orbiting hot spots and jet
 * knots; each melody note launches a flare that orbits at a radius set by its pitch
 * (higher = inner and hotter); chord changes swell the disk light. Orbit and camera run
 * on a beat-and-energy clock, so they rest in silence.
 *
 * Events come from the shared morph: each reaction is its level squared (so a faint intro motif
 * only glimmers), eased in, and the melody flare glides to each new radius instead of jumping.
 */

const st = { phase: 0, cam: 0, jet: 0, lastTime: -1, leadR: 4, leadAng: 0, chordGlow: 0 };

/** Event source: ages and levels (this world does not use the morph's shape coordinates). */
const morph = new Morph(1);
/**
 * A light answering one kind of event: its level squared (the level carries how loud the passage
 * is, so a faint intro motif only glimmers), eased in over `rise` seconds and fading with time
 * constant `decay`. A new event rises from whatever is still lit, never cutting it off.
 */
class Flare {
  private n = -1;
  private carry = 0;
  value = 0;
  constructor(
    private readonly rise: number,
    private readonly decay: number,
  ) {}
  update(count: number, age: number, level: number): number {
    if (count !== this.n) {
      this.carry = this.n < 0 ? 0 : this.value;
      this.n = count;
    }
    const x = Math.min(1, age / this.rise);
    const fade = Math.exp(-age / this.decay);
    this.value = Math.max(this.carry * fade, level * level * x * x * (3 - 2 * x) * fade);
    return this.value;
  }
}
/** A position-bound front's strength (ring, knot, surge): level squared, eased in over `rise`. */
const onset = (age: number, level: number, rise: number) => {
  const x = Math.min(1, age / rise);
  return level * level * x * x * (3 - 2 * x);
};
const fx = { lead: new Flare(0.12, 0.45), kick: new Flare(0.12, 0.3), snare: new Flare(0.12, 0.25) };
/** Held-note glow and spectral flux, glided so neither jumps. */
const held = new Spring(0, 0.12);
const fluxS = new Spring(0, 0.15);

export default raymarchScene({
  meta: {
    id: 'black-hole',
    name: 'Event Horizon',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.2, 1],
    mood: { valence: 0.35, arousal: 0.55 },
    genres: { ambient: 0.9, techno: 0.85, dubstep: 0.8, classical: 0.75, edm: 0.5, dnb: 0.45, synthwave: 0.4 },
    trails: 0.25,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    if (Math.abs(m.time - st.lastTime) > 0.5) {
      st.phase = m.time * 0.2; st.cam = m.time * 0.5; st.jet = 0; st.chordGlow = 0;
      held.reset(0);
    }
    st.lastTime = m.time;
    morph.update(m, ctx.dt, g);
    const kickF = fx.kick.update(morph.kicks, morph.kickAge, morph.kickLevel);
    const h = (k: number) => {
      const x = Math.sin((g[k % 8] * 91.7 + k * 12.9898) * 7.31) * 43758.5453;
      return x - Math.floor(x);
    };
    const ant = m.anticipation;
    const drop = m.dropPulse;

    // Music clock: beats scaled by how much is playing; rests in silence.
    const act = Math.min(1, 1.6 * m.energySlow);
    const beats = (m.bpm / 60) * act * (0.35 + 0.65 * m.energy + 0.6 * kickF + 0.8 * drop);
    st.phase += dt * beats * 0.3;
    st.cam += dt * beats;

    const form = Math.floor(g[0] * 5);
    const rig = Math.floor(g[6] * 4);
    const rin = 1.7 + 1.6 * g[2];
    const rout = rin + 3.5 + 5 * h(21);
    const thick = form === 1 ? 0.06 + 0.1 * h(22) : 0.0;
    const spinS = h(63) < 0.5 ? 1 : -1;

    // Kick: a density wave rolling out through the disk from the inner edge, lit by the kick's
    // eased level.
    const kAge = Math.min(morph.kickAge, 9);
    const kAmp = onset(kAge, morph.kickLevel, 0.15);
    // Melody: each note lights the orbiting flare, which glides to the radius set by its pitch
    // (high = inner, hot).
    const leadEnv = Math.max(fx.lead.update(morph.notes, morph.leadAge, morph.noteLevel), 0.35 * held.update(m.leadHeld * morph.presence ** 2, dt));
    st.leadR += ((rin * 1.15 + (rout * 0.85 - rin * 1.15) * (0.5 - 0.5 * Math.max(-1, Math.min(1, m.leadPitch)))) - st.leadR) * (1 - Math.exp(-dt / 0.25));
    st.leadAng += dt * beats * 0.3 * 7.2 * Math.pow(st.leadR, -1.5) * spinS;
    // Chord change: an eased swell of the disk light.
    st.chordGlow += (m.chordPulse - st.chordGlow) * (1 - Math.exp(-dt / 0.18));

    // Camera: close to the disk so it and its lensed arc fill the frame. Motion follows the music clock.
    const elBase = 0.05 + 0.85 * Math.pow(g[1], 1.4);
    let dist = 6.8 + 4.2 * h(11);
    let el = elBase;
    let az = st.cam * 0.02 + g[1] * 40;
    let roll = (h(12) - 0.5) * 0.4;
    let offX = 0;
    let offY = 0;
    if (rig === 0) {
      el += 0.05 * Math.sin(st.cam * 0.025 + ev[0] * 6);
    } else if (rig === 1) {
      // Crane: inclination sweeps toward the disk plane and back.
      el = 0.06 + 0.45 * (0.5 + 0.5 * Math.sin(st.cam * 0.012 + g[1] * 9)) + 0.3 * elBase;
      az = st.cam * 0.01 + g[1] * 40;
    } else if (rig === 2) {
      dist *= 0.8 + 0.3 * (0.5 + 0.5 * Math.sin(st.cam * 0.015 + ev[1] * 6));
      roll += 0.25 * Math.sin(st.cam * 0.008);
    } else {
      // Fly-by: off-centre framing, the shadow sits on a third.
      offX = (h(13) < 0.5 ? -1 : 1) * (0.16 + 0.06 * Math.sin(st.cam * 0.012));
      offY = 0.05 * Math.sin(st.cam * 0.01 + 1);
      az = st.cam * 0.03 + g[1] * 40;
      dist *= 0.9;
    }
    dist *= 1 - 0.15 * ant;
    el = Math.max(Math.min(el, 1.3), thick > 0 ? thick * 1.6 + 0.08 : 0.05);
    const ro = [dist * Math.cos(el) * Math.cos(az), dist * Math.sin(el), dist * Math.cos(el) * Math.sin(az)];
    const fw = [-ro[0] / dist, -ro[1] / dist, -ro[2] / dist];
    const rt = [-fw[2], 0, fw[0]];
    const rl = Math.hypot(rt[0], rt[2]) || 1;
    const tgt = [(rt[0] / rl) * offX * dist, offY * dist, (rt[2] / rl) * offX * dist];
    p[0] = ro[0]; p[1] = ro[1]; p[2] = ro[2]; p[3] = roll;
    p[4] = tgt[0]; p[5] = tgt[1]; p[6] = tgt[2];
    p[7] = 1.0 + 0.3 * h(14) + 0.15 * ant;

    p[8] = form;
    p[9] = thick;
    p[10] = rin;
    p[11] = rout;
    p[12] = 0.6 + 1.2 * h(23);
    p[13] = 0.45 + 0.55 * h(71);
    p[14] = g[7] > 0.55 ? (g[7] - 0.55) * 0.5 * (1 + 0.5 * m.tension) : 0;
    p[15] = g[7] * 30 + ev[2] * 2;
    const jetStyle = Math.floor(g[3] * 3);
    const jetTarget = (jetStyle === 0 ? 0 : 0.5 + 0.5 * m.energySlow) + 2.2 * drop + 0.4 * ant * jetStyle;
    st.jet += (jetTarget - st.jet) * (1 - Math.exp(-dt / (jetTarget > st.jet ? 0.05 : 0.6)));
    p[16] = st.jet;
    p[17] = jetStyle === 2 ? 0.16 : 0.05;
    p[18] = st.leadR;
    p[19] = g[5] * 50 + st.phase * 0.02;
    // Sky: style * 2 + star density.
    p[20] = Math.floor(h(41) * 3) * 2 + 0.3 + 0.69 * g[4];
    p[21] = st.leadAng;
    p[22] = (0.36 + 0.25 * ctx.intensity + 0.15 * m.energySlow + 0.45 * drop + 0.35 * st.chordGlow) * (1 - 0.35 * ant);
    // Palette offset: per cue, drifting with evolve, and leaning with the chord (morph2 glides).
    p[23] = h(42) * 0.3 + ev[3] * 0.15;
    p[24] = st.phase;
    p[25] = 2 + Math.floor(h(51) * 3) + (g[5] > 0.5 ? 8 : 0);
    p[26] = kAge < 3 ? rin + kAge * (rout - rin) * 1.6 : -10;
    p[27] = fx.snare.update(morph.snares, morph.snareAge, morph.snareLevel);
    p[28] = 0.6 + 0.8 * m.tension + 0.5 * fluxS.update(m.flux * morph.presence, dt);
    p[29] = leadEnv;
    p[30] = h(61) < 0.55 ? 0.6 + 0.6 * h(62) : 0;
    // Spin sense in the sign, the kick wave's strength in |w| - 2.
    p[31] = spinS * (2 + kAmp);
  },
  wgsl: /* wgsl */ `
/** The spectrum with its attack eased over ~120 ms (now and the last three history rows), so
 *  an onset swells a band in instead of stepping it. */
fn bh_specE(x: f32) -> f32 {
  return 0.25 * (spec(x) + hist(x, 0.01) + hist(x, 0.02) + hist(x, 0.03));
}

fn bh_layerC(k: i32) -> f32 {
  // Cone slope of layer k (flared multi-layer disk); single layer when thickness is 0.
  return S.p[2].y * (f32(k) - 1.5) / 1.5;
}

fn bh_surf(p: vec3f, k: i32) -> f32 {
  let r = length(p.xz);
  let wr = smoothstep(S.p[2].z, S.p[2].w * 1.2, r);
  let warp = S.p[3].z * wr * r * sin(atan2(p.z, p.x) + S.p[3].w + r * 0.15);
  return p.y - bh_layerC(k) * r - warp;
}

fn bh_noise(q: vec3f) -> f32 {
  return noise3fast(q) * 0.55 + noise3fast(q * 2.13 + 7.1) * 0.3 + noise3fast(q * 4.7 + 3.3) * 0.15;
}

/** Disk emission (rgb) and opacity (a) at the crossing point hp. vdir = photon travel direction. */
fn bh_disk(hp: vec3f, vdir: vec3f, layer: f32, lod: f32) -> vec4f {
  let r = length(hp.xz);
  let rin = S.p[2].z;
  let rout = S.p[2].w;
  let ang = atan2(hp.z, hp.x);
  let spinS = sign(S.p[7].w);
  let kAmp = abs(S.p[7].w) - 2.0;
  let form = i32(S.p[2].x);
  var dens = 0.0;
  var T = 0.0;
  var hot = 0.0;
  // Companion mass-transfer stream: spiral from the companion down to the outer edge.
  var stream = 0.0;
  if (S.p[6].y > 7.5 && (S.p[2].y <= 0.0 || layer == 1.0)) {
    let ac = S.p[4].w;
    let rc = rout * 1.35 + 3.0;
    let dphi = fmod((ang - ac) * spinS, TAU);
    let rs = mix(rc - 1.0, rout * 0.92, sat(dphi / 2.2));
    let ws = 0.15 + 0.35 * sat(dphi / 2.2);
    stream = exp(-pow((r - rs) / ws, 2.0)) * smoothstep(3.0, 1.8, dphi) * (0.6 + 0.4 * noise3fast(vec3f(r * 3.0, dphi * 4.0 - S.p[6].x * 2.0, 1.0)));
  }
  if (r < rin * 0.8 || r > rout * 1.25) {
    if (stream < 0.01) { return vec4f(0.0); }
  }
  let x = sat((r - rin) / (rout - rin));
  let edge = smoothstep(rin * 0.92, rin * 1.08, r) * smoothstep(rout * 1.2, rout * 0.8, r);
  // Novikov-Thorne-like temperature, normalised to peak ~1.
  let u = rin / r;
  T = pow(u, 0.75 * S.p[3].x) * pow(max(1.0 - sqrt(u) * 0.985, 0.0), 0.25) * 2.05;
  T = sat(T) * edge;

  // Differential rotation via two crossfaded flow layers (avoids infinite winding).
  let om = 2.4 * pow(r, -1.5) * spinS;
  let fp = S.p[6].x * 0.25;
  let f1 = fract(fp);
  let f2 = fract(fp + 0.5);
  let w1 = 1.0 - abs(2.0 * f1 - 1.0);
  let a1 = ang - om * f1 * 12.0;
  let a2 = ang - om * f2 * 12.0;
  let turb = S.p[7].x;
  let rq = r * (1.6 + 0.3 * turb) + layer * 5.0;
  let n1 = bh_noise(vec3f(cos(a1) * 2.2, sin(a1) * 2.2, rq));
  let n2 = bh_noise(vec3f(cos(a2) * 2.2 + 9.0, sin(a2) * 2.2, rq));
  // Higher-order images (rays that skimmed the photon sphere) are minified hugely: smooth them.
  let n = mix(n2, n1, w1) * (1.0 - 0.8 * lod);

  if (form == 0) {
    // Thin, turbulent, Interstellar-like.
    dens = sat(0.55 + 1.6 * n * turb) * edge;
    dens *= 0.7 + 0.6 * sat(bh_noise(vec3f(cos(mix(a2, a1, w1)) * 7.0, sin(mix(a2, a1, w1)) * 7.0, r * 9.0)) + 0.4);
  } else if (form == 1) {
    // Flared puffy layers: translucent turbulent sheets.
    dens = sat(0.15 + 2.2 * n * turb) * edge * 0.55;
  } else if (form == 2) {
    // Ringlets with gaps; each ringlet plays a slice of the recent spectrum.
    let fr = 3.2;
    let cell = floor(r * fr + n * 0.4);
    let hc = hash11(cell * 1.37 + 3.0);
    let fx = fract(r * fr + n * 0.4);
    let ring = mix(smoothstep(0.0, 0.18, fx) * smoothstep(1.0, 0.75 - 0.4 * hc, fx), 0.45, lod);
    let lvl = hist(0.08 + 0.8 * hc, x * 0.7);
    dens = ring * step(0.22, hc) * (0.35 + 0.65 * hc) * edge * (0.6 + 1.4 * lvl);
  } else if (form == 3) {
    // Logarithmic spiral density waves.
    let arms = fmod(S.p[6].y, 8.0);
    let lr = log(r);
    let sa = mix(a2, a1, w1);
    let arm = 0.5 + 0.5 * cos(arms * (sa * spinS + lr * 3.2) + n * 1.5);
    dens = (0.12 + 0.95 * pow(arm, 3.0)) * sat(0.6 + n * turb) * edge;
  } else {
    // Torn disk: orbiting plasma clumps on a faint sheet.
    let sa = ang - om * S.p[6].x * 3.0;
    let ring = floor(r * 1.4);
    let nseg = 6.0 + ring * 3.0;
    let cid = floor(fract(sa / TAU + hash11(ring) ) * nseg);
    let ca = (cid + 0.5) / nseg;
    let hc = hash12(vec2f(ring, cid));
    let da = (fract(sa / TAU + hash11(ring)) - ca) * TAU * r;
    let dr = r - (ring + 0.25 + 0.5 * hc) / 1.4;
    let blob = mix(exp(-(da * da * 7.0 + dr * dr * 70.0)) * step(0.3, hc), 0.15, lod);
    dens = (0.12 * sat(0.5 + n) + 1.2 * blob) * edge;
  }

  // Music: kick flash from the inner edge, beat wave rolling outward, spectrum by radius.
  // Kick: a compression wave rolling outward through the disk (sharp front, soft wake).
  let wr = S.p[6].z;
  let wAge = sat((wr - rin) / max((rout - rin) * 1.6, 1e-3));
  let wd = r - wr;
  let wave = select(exp(-wd * wd * 1.4), exp(-wd * wd * 6.0), wd > 0.0) * exp(-wAge * 2.2) * kAmp;
  var gain = 1.0 + 1.6 * wave + 0.35 * kAmp * exp(-wAge * 4.0) * exp(-(r - rin) * 0.9);
  gain *= 0.65 + 0.9 * bh_specE(0.04 + 0.8 * (1.0 - x));
  // Snare hot spots orbiting at fixed radii.
  for (var k = 0; k < 2; k++) {
    let hr = rin * (1.25 + 0.9 * f32(k));
    let ha = S.p[6].x * 2.2 * pow(hr, -1.5) * spinS * 2.0 + f32(k) * 3.0;
    let hpos = vec2f(cos(ha), sin(ha)) * hr;
    let d2 = dot(hp.xz - hpos, hp.xz - hpos);
    hot += exp(-d2 * 1.4) * (0.15 + 2.2 * S.p[6].w);
  }

  // Melody: a flare launched on each note, orbiting at a radius set by its pitch; the whole
  // ring at that radius warms while the note sounds.
  let le = S.p[7].y;
  var flare = 0.0;
  if (le > 0.005) {
    let lr = S.p[4].z;
    let dr = (r - lr) / (0.22 + 0.05 * lr);
    let da = fmod(ang - S.p[5].y + PI, TAU) - PI;
    flare = le * exp(-dr * dr) * (0.25 + 1.6 * exp(-da * da * 1.5));
  }

  // Doppler beaming and gravitational redshift.
  let beta = min(sqrt(0.5 / max(r - 1.0, 0.3)), 0.75);
  let vel = normalize(vec3f(-hp.z, 0.0, hp.x)) * spinS;
  let cosT = dot(vel, -vdir);
  let gam = inverseSqrt(1.0 - beta * beta);
  let D = 1.0 / (gam * (1.0 - beta * cosT));
  let Dw = mix(1.0, D * D * D, S.p[3].y);
  let grav = sqrt(max(1.0 - 1.0 / r, 0.0));
  let shift = (D - 1.0) * S.p[3].y;

  let lum = (0.03 + 1.3 * T * T + 0.2 * T) * Dw * grav * gain * S.p[5].z;
  var c = palRampL(sat(0.18 + 0.72 * T + 0.35 * shift + S.p[5].w + 0.12 * (F.morph2.x - 0.5)), 1.0);
  c = mix(c, vec3f(1.0), sat((T * D - 0.75) * 1.8) * 0.55);
  let leadC = palRampL(sat(0.55 + 0.4 * (1.0 - (S.p[4].z - rin) / max(rout - rin, 1e-3)) + S.p[5].w), 1.0);
  var emis = c * lum * dens + palRampL(0.85, 1.0) * hot * dens * 1.5 + leadC * flare * Dw * grav * (0.4 + dens) * 2.2 * S.p[5].z;
  var alpha = sat(dens * (0.35 + 0.9 * T) * select(1.3, 0.55, form == 1) + flare * 0.3);
  if (stream > 0.01) {
    emis += palL(0.62 + S.p[5].w, 1.0) * stream * 0.9 * S.p[5].z * Dw;
    alpha = max(alpha, stream * 0.7);
  }
  return vec4f(emis, alpha);
}

fn bh_stars(rd: vec3f, dens: f32) -> vec3f {
  var col = vec3f(0.0);
  for (var k = 0; k < 2; k++) {
    let sc = 140.0 + 230.0 * f32(k);
    let g = rd * sc;
    let cell = floor(g);
    let hs = hash13(cell + f32(k) * 31.0);
    let thr = 1.0 - (0.004 + 0.01 * f32(k)) * dens;
    let off = hash33(cell) - 0.5;
    let d = length(fract(g) - 0.5 - off * 0.5);
    let core = exp(-d * d * 40.0);
    let tw = 0.85 + 0.6 * F.hat * step(0.7, fract(hs * 17.0));
    let tint = mix(vec3f(0.7, 0.8, 1.0), vec3f(1.0, 0.85, 0.65), fract(hs * 41.0));
    col += tint * smoothstep(thr, 1.0, hs) * core * tw * mix(2.5, 0.8, f32(k));
  }
  return col;
}

fn bh_sky(rd: vec3f, ro: vec3f) -> vec3f {
  let style = i32(floor(S.p[5].x * 0.5));
  var col = F.pal0.rgb * 0.004 + vec3f(0.0015, 0.002, 0.004);
  let dens = S.p[5].x - 2.0 * floor(S.p[5].x * 0.5);
  if (style == 1) {
    let n = fbmFast(rd * 2.3 + vec3f(3.0, 1.0, F.evolve.x), 4);
    let n2 = fbmFast(rd * 6.0 + vec3f(1.0), 2);
    col += palL(0.3 + n * 0.5 + S.p[5].w, 0.035) * smoothstep(-0.05, 0.4, n + n2 * 0.3);
    col += palL(0.75, 0.02) * smoothstep(0.15, 0.5, n2) * smoothstep(0.0, 0.3, n);
  } else if (style == 2) {
    let bn = normalize(vec3f(0.3, 0.9, -0.2 + S.p[5].w));
    let md = dot(rd, bn);
    let dust = fbmFast(rd * 5.0 + 2.0, 4);
    let band = exp(-md * md * 9.0);
    col += palL(0.55 + S.p[5].w, 0.05) * band * sat(0.6 + dust) * (1.0 - 0.8 * smoothstep(0.05, 0.25, dust) * exp(-md * md * 60.0));
    col += bh_stars(rd.zxy, band * 2.0) * 0.4;
  }
  col += bh_stars(rd, dens);
  // Background galaxy directly behind the hole (lensed into an Einstein ring).
  if (S.p[7].z > 0.0) {
    let gd = normalize(-ro + vec3f(0.0, 0.5, 0.0));
    let ca = dot(rd, gd);
    let tang = rd - gd * ca;
    let gx = normalize(cross(gd, vec3f(0.2, 1.0, 0.1)));
    let gy = cross(gd, gx);
    let q = vec2f(dot(tang, gx), dot(tang, gy) * 2.2);
    let rr = length(q);
    let sw = atan2(q.y, q.x) - log(rr + 1e-4) * 2.5;
    let arms = 0.6 + 0.4 * cos(2.0 * sw);
    let gal = (exp(-rr * rr * 4000.0) * 3.0 + exp(-rr * 28.0) * arms) * step(0.0, ca);
    col += palL(0.6 + S.p[5].w, 0.25) * gal * S.p[7].z;
  }
  return col;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[0].xyz;
  let cam = lookAt(ro, S.p[1].xyz, S.p[0].w);
  let rd = normalize(cam * vec3f(q, S.p[1].w));
  let jit = ign(frag);

  var p = ro;
  var v = rd;
  let hc = cross(p, v);
  let h2 = dot(hc, hc);
  var col = vec3f(0.0);
  var trans = 1.0;
  var rmin = 1e3;
  var captured = false;
  var escaped = false;
  let nl = select(1, 4, S.p[2].y > 0.0);
  let jetAmt = S.p[4].x;
  let jetSpread = S.p[4].y;
  let comp = step(7.5, S.p[6].y);
  let rout = S.p[2].w;
  let rc = rout * 1.35 + 3.0;
  let cpos = vec3f(cos(S.p[4].w), 0.0, sin(S.p[4].w)) * rc;
  let crad = 0.7 + 0.25 * sin(S.p[4].w * 3.0);
  var jetAcc = 0.0;
  var cglow = 0.0;
  var first = true;
  var ncross = 0;
  for (var i = 0; i < 200; i++) {
    let r2 = dot(p, p);
    let r = sqrt(r2);
    if (r < 1.0) { captured = true; break; }
    rmin = min(rmin, r);
    if (r > 30.0 && dot(p, v) > 0.0) { escaped = true; break; }
    var dt = clamp(0.03 * r2, 0.03, 0.4 * r);
    // Keep steps small near the jet axis so thin jets don't alias.
    let rho = length(p.xz);
    if (jetAmt > 0.02) { dt = min(dt, max(0.2, rho * 0.6 + abs(p.y) * 0.04)); }
    if (comp > 0.5) { dt = min(dt, max(0.2, length(p - cpos) - crad * 0.9)); }
    if (first) { dt *= 0.3 + 0.7 * jit; first = false; }
    let acc = -1.5 * h2 * p / (r2 * r2 * r);
    v += acc * dt;
    let np = p + v * dt;
    // Disk crossings (one or four flared layers).
    for (var k = 0; k < 4; k++) {
      if (k >= nl) { break; }
      let s0 = bh_surf(p, k);
      let s1 = bh_surf(np, k);
      if (s0 * s1 < 0.0) {
        let hp = mix(p, np, s0 / (s0 - s1));
        let d = bh_disk(hp, normalize(v), f32(k), sat((2.6 - rmin) * 1.5) * sat(f32(ncross)));
        ncross += 1;
        col += trans * d.rgb;
        trans *= 1.0 - d.a;
      }
    }
    // Jets along the spin axis, Doppler-favouring the approaching one.
    if (jetAmt > 0.02) {
      let z = abs(np.y);
      let rj = length(np.xz);
      let w = 0.08 + z * jetSpread;
      let core = exp(-rj * rj / (w * w));
      if (core > 0.002) {
        let along = smoothstep(1.3, 3.0, z) * exp(-z / (9.0 + 6.0 * jetAmt));
        let knots = 0.5 + pow(0.5 + 0.5 * sin(z * 1.3 - S.p[6].x * 6.0 + sign(np.y)), 6.0) * (1.0 + 2.0 * S.p[6].w);
        let jd = 1.0 / (2.0 * (1.0 - 0.85 * dot(vec3f(0.0, sign(np.y), 0.0), -normalize(v))));
        jetAcc += trans * core * along * knots * dt * min(jd * jd, 6.0) / (w * 6.0);
      }
    }
    // Companion star.
    if (comp > 0.5) {
      let dc = length(np - cpos);
      cglow += trans * exp(-dc * 1.4) * dt * 0.05;
      if (dc < crad) {
        let n = normalize(np - cpos);
        let mu = sat(dot(n, -normalize(v)));
        let gran = noise3fast(n * 9.0 + S.p[6].x * 0.2) * 0.15;
        col += trans * palL(0.55 + S.p[5].w, 1.0) * (0.15 + 1.1 * pow(mu, 0.8) + gran) * S.p[5].z;
        trans = 0.0;
        break;
      }
    }
    p = np;
    if (trans < 0.02) { break; }
    if (i == 199) { escaped = true; }
  }
  let jetC = mix(palL(0.7 + S.p[5].w, 1.0), vec3f(1.0), 0.35);
  col += jetC * jetAcc * jetAmt * 0.55;
  col += palL(0.55 + S.p[5].w, 1.0) * cglow * S.p[5].z;
  if (!captured && trans > 0.02) {
    let dir = normalize(v);
    col += trans * bh_sky(dir, ro) * (1.0 + 0.6 * F.anticipation);
    // Photon ring: rays that skimmed the photon sphere.
    let pr = exp(-max(rmin - 1.5, 0.0) * 9.0) * (0.35 + 0.3 * (abs(S.p[7].w) - 2.0) + 0.6 * S.p[7].y + 0.8 * F.anticipation + 1.2 * F.dropPulse);
    col += trans * palRampL(0.9, 1.0) * pr * 0.6;
  }
  // Faint lensed glow around the shadow for depth.
  return vec4f(col, 1.0);
}
`,
});
