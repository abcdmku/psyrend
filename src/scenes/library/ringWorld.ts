import { raymarchScene } from '../raymarchScene';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Ringed Giant. You fly inside the ring system of an oblate gas giant: banded,
 * storm-swirled cloud decks with differential rotation, a ring sheet with gaps and
 * ringlets, a field of ring boulders streaming past, shepherd and outer moons, all lit by
 * one sun with real shadowing and forward-scattering dust that makes backlit rings glow.
 *
 * The music plays the rings:
 *  - Melody: each lead note plucks a ringlet. Pitch sets which ringlet (low notes inner,
 *    high notes outer), the attack sends a bright packet racing along it away from you,
 *    and the ringlet keeps glowing while the note is held. The previous note fades out
 *    on its own ringlet, so a phrase leaves a trace across the sheet.
 *  - Kick: a density wave rolls outward through the rings, thickening and lighting them.
 *  - Snare: radial spokes flash across the ring sheet, and storm cells on the planet flicker.
 *  - Harmony: chord changes ease the cloud bands' hue and brighten the aurora.
 *  - Travel: the orbit advances with tempo and energy, so the boulders stream past on the
 *    music and rest in silence; the planet's spin follows energy too.
 *
 * DNA: band style (jovian / saturnine / ice giant / marbled / striped), ring
 * architecture (classic A/B/Cassini / narrow ringlets / dusty + bright cores /
 * separated bands), oblateness + roll, camera rig (skim above / skim below / crane /
 * backlit), sun position, moon count, storm scale + band frequency, atmosphere + aurora.
 *
 * Events come from the shared morph: every light (pluck, density wave, spokes) scales with its
 * event's level (which includes how loud the passage is) and rises over about 0.1 s, and the drop
 * eases in as a surge, so a faint intro motif only glints on one ringlet.
 */

/** Event source: ages and levels (this world does not use the morph's shape coordinates). */
const morph = new Morph(1);
/**
 * A light answering one kind of event: its level squared (the level already carries how loud the
 * passage is, so a faint intro hit stays a glimmer while a full-mix hit lands fully), eased in over
 * `rise` seconds and fading with time constant `decay`. A new event rises from whatever is still
 * lit, so a quick retrigger never cuts the previous light off.
 */
class Flare {
  private n = -1;
  private carry = 0;
  value = 0;
  /** The two parts of `value`: this event's own light, and what the previous one still has lit. */
  fresh = 0;
  old = 0;
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
    this.old = this.carry * fade;
    this.fresh = level * level * x * x * (3 - 2 * x) * fade;
    this.value = Math.max(this.old, this.fresh);
    return this.value;
  }
}
/** A plucked ringlet's light: swells in over about a quarter second, flares and settles to a glow. */
const pluck = (s: number, age: number) => {
  const x = Math.min(1, age / 0.25);
  return s * (0.25 + 2.6 * Math.exp(-age * 3)) * Math.exp(-age * 0.5) * x * x * (3 - 2 * x);
};
const fx = { spin: new Flare(0.15, 0.25), wave: new Flare(0.15, 0.33), snare: new Flare(0.15, 0.2) };
/** The held melody's strength, glided so the ringlet's glow never jumps. */
const held = new Spring(0, 0.1);
/** The hats, glided (and weighted by the passage's loudness) so a hat never sparkles the sheet in one frame. */
const hat = new Spring(0, 0.06);

const st = {
  spinPh: 0, moonPh: 0, lastTime: -1, orbit: 0,
  noteN: -1,
  notes: [{ x: 0.5, s: 0, age: 9, off: 9 }, { x: 0.5, s: 0, age: 9, off: 9 }, { x: 0.5, s: 0, age: 9, off: 9 }],
  held: 0,
  chordHue: 0, chordGlow: 0,
};

const chordHueOf = (root: number) => ((root * 7) % 12) / 12;

export default raymarchScene({
  meta: {
    id: 'ring-world',
    name: 'Ringed Giant',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0, 0.7],
    mood: { valence: 0.6, arousal: 0.25 },
    genres: { ambient: 1, classical: 0.9, synthwave: 0.7, pop: 0.6, lofi: 0.5, acoustic: 0.4, jazz: 0.4 },
    trails: 0.2,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    if (Math.abs(m.time - st.lastTime) > 0.5) {
      st.spinPh = 0; st.moonPh = 0; st.chordGlow = 0; st.orbit = ctx.travel;
      st.noteN = morph.notes;
      held.reset(0);
      hat.reset(0);
      for (const n of st.notes) n.age = 9;
      st.chordHue = m.chord && m.chord.root >= 0 ? chordHueOf(m.chord.root) : 0;
    }
    st.lastTime = m.time;
    const h = (k: number) => {
      const x = Math.sin((g[k % 8] * 77.3 + k * 19.19) * 5.17) * 43758.5453;
      return x - Math.floor(x);
    };
    const ant = m.anticipation;
    // The drop as the morph's surge: it swells in, never a one-frame jump.
    const drop = morph.surge;
    const tempo = Math.min(Math.max(m.bpm / 120, 0.6), 1.6);

    // Events: each note plucks a ringlet as bright as the note is strong.
    const ringX = 0.1 + 0.8 * (0.5 + 0.5 * Math.max(-1, Math.min(1, m.leadPitch)));
    for (const n of st.notes) n.age += dt;
    // The sounding ringlet: its pluck, plus the held note's glow swelling in with it.
    const glow = (n: { s: number; age: number }) => {
      const x = Math.min(1, n.age / 0.25);
      return pluck(n.s, n.age) + 0.5 * st.held * x * x * (3 - 2 * x);
    };
    if (morph.notes !== st.noteN) {
      st.noteN = morph.notes;
      // The two previous ringlets keep the light they had and fade on from there (never cut off);
      // the one before keeps its racing packet too (`off`: how old its attack already was).
      const [n, o] = st.notes;
      st.notes[2] = { x: o.x, s: o.s * Math.exp(-o.age * 1.2), age: 0, off: 9 };
      st.notes[1] = { x: n.x, s: glow(n), age: 0, off: Math.min(n.age, 9) };
      st.notes[0] = { x: ringX, s: morph.noteLevel ** 2, age: 0, off: 0 };
    }
    st.held = held.update(m.leadHeld * morph.presence ** 2, dt);
    const hatL = hat.update(m.hat * morph.presence ** 2, dt);
    // The sounding note's ringlet follows the pitch glide.
    if (st.notes[0].age < 0.15) st.notes[0].x = ringX;
    const target = m.chord && m.chord.root >= 0 ? chordHueOf(m.chord.root) : st.chordHue;
    let dh = target - st.chordHue;
    dh -= Math.round(dh);
    st.chordHue += dh * (1 - Math.exp(-dt / 0.5));
    st.chordGlow += (m.chordPulse - st.chordGlow) * (1 - Math.exp(-dt / (m.chordPulse > st.chordGlow ? 0.1 : 0.6)));
    const kickEnv = fx.spin.update(morph.kicks, morph.kickAge, morph.kickLevel);
    st.spinPh += dt * (0.004 + 0.016 * m.energySlow + 0.012 * kickEnv + 0.03 * drop) * tempo;
    st.moonPh += dt * (0.01 + 0.05 * m.energySlow + 0.1 * drop) * tempo;
    // The orbit's own travel: the director's rate (tempo x energy, surging on kicks and drops), with
    // the kick surge eased in by its level and the drop as the surge, so a kick never jolts the orbit.
    st.orbit += dt * (0.25 + 1.4 * m.energySlow + 0.5 * kickEnv + 1.4 * drop + 0.8 * ant) * Math.sqrt(Math.max(60, m.bpm) / 120);

    const ringStyle = Math.floor(g[1] * 4);
    const rin = 1.18 + 0.35 * h(10);
    const rout = rin + [1.1, 0.9, 1.5, 1.4][ringStyle] * (0.7 + 0.5 * h(11));
    const rig = Math.floor(g[3] * 4);
    // The orbit advances with the integrated travel (tempo x energy, surging on kicks and drops).
    const dir = h(30) < 0.5 ? 1 : -1;
    const az = h(32) * 6.28 + dir * st.orbit * 0.02;
    // The sun keeps its place relative to the camera so the lighting composition holds.
    const sunAz = az + (h(40) < 0.5 ? 1 : -1) * (0.35 + 1.1 * g[4]);
    // Above the ring plane, or below it for the under-skim, so the side we see is sunlit.
    const sunEl = (0.1 + 0.25 * h(41)) * (rig === 1 ? -1 : 1);
    let ro: number[];
    let tgt: number[];
    let roll = (g[2] - 0.5) * 0.35;
    let focal: number;
    const ahead = az + (dir * Math.PI) / 2;
    if (rig === 0 || rig === 1) {
      // Skim: low over (or under) the ring sheet, flying along the rings, planet off to one side.
      const rr = rin + (rout - rin) * (0.45 + 0.6 * h(31));
      const y = (0.06 + 0.12 * h(33)) * (rig === 1 ? -1 : 1) * (1 + 0.6 * ant);
      ro = [rr * Math.cos(az), y, rr * Math.sin(az)];
      const mixP = 0.5 + 0.3 * h(34);
      const dx = Math.cos(ahead) * (1 - mixP) - Math.cos(az) * mixP;
      const dz = Math.sin(ahead) * (1 - mixP) - Math.sin(az) * mixP;
      tgt = [ro[0] + dx * 2, rig === 1 ? 0.12 : y * 0.4, ro[2] + dz * 2];
      focal = 1.15 + 0.3 * h(35);
    } else if (rig === 2) {
      // Crane: above the inner rings, the planet filling half the frame, rings sweeping past.
      const rr = rin + (rout - rin) * (0.15 + 0.4 * h(31));
      const y = 0.22 + 0.25 * h(33) - 0.08 * ant;
      ro = [rr * Math.cos(az), y, rr * Math.sin(az)];
      tgt = [Math.cos(ahead) * 0.9, -0.1, Math.sin(ahead) * 0.9];
      focal = 1.2 + 0.25 * h(35);
    } else {
      // Backlit: in the ring plane on the night side; crescent planet, glowing rings.
      const rr = rout + 0.2 + 0.6 * h(31);
      const y = 0.05 + 0.1 * h(33);
      ro = [rr * Math.cos(az), y, rr * Math.sin(az)];
      tgt = [Math.cos(ahead) * 0.6, 0.05, Math.sin(ahead) * 0.6];
      focal = 1.3 + 0.3 * h(35);
      roll *= 0.5;
    }
    p[0] = ro[0]; p[1] = ro[1]; p[2] = ro[2]; p[3] = roll;
    p[4] = tgt[0]; p[5] = tgt[1]; p[6] = tgt[2]; p[7] = focal;
    let sx = Math.cos(sunEl) * Math.cos(sunAz);
    let sy = Math.sin(sunEl);
    let sz = Math.cos(sunEl) * Math.sin(sunAz);
    if (rig === 3) {
      // Sun hidden just behind the planet's limb.
      const d = Math.hypot(ro[0], ro[1], ro[2]);
      const ang = Math.asin(1 / d) * (0.55 + 0.4 * h(42));
      const pa = h(43) * 6.28;
      const fw = [-ro[0] / d, -ro[1] / d, -ro[2] / d];
      const rt = [-fw[2], 0, fw[0]];
      const rl = Math.hypot(rt[0], rt[2]) || 1;
      const up = [(fw[1] * rt[2]) / rl, (fw[2] * rt[0]) / rl - (fw[0] * rt[2]) / rl, (-fw[1] * rt[0]) / rl];
      sx = fw[0] + Math.tan(ang) * ((Math.cos(pa) * rt[0]) / rl + Math.sin(pa) * up[0]);
      sy = fw[1] + Math.tan(ang) * (Math.sin(pa) * up[1]);
      sz = fw[2] + Math.tan(ang) * ((Math.cos(pa) * rt[2]) / rl + Math.sin(pa) * up[2]);
      const l = Math.hypot(sx, sy, sz); sx /= l; sy /= l; sz /= l;
    }
    p[8] = sx; p[9] = sy; p[10] = sz;
    p[11] = (0.9 + 0.35 * ctx.intensity + 0.25 * m.energySlow + 0.5 * drop) * (1 - 0.3 * ant);
    // S.p[3]: packed styles (+ desaturation in the fraction), oblateness, spin phase, band freq.
    const boulders = rig === 2 ? 0 : 1;
    p[12] = Math.floor(g[0] * 5) + 8 * ringStyle + 32 * Math.floor(g[5] * 6.99) + 256 * boulders + 0.5 * h(62);
    // Oblateness, with the oldest plucked ringlet's brightness in thousandths above it.
    const n2 = st.notes[2];
    p[13] = 0.02 + 0.09 * g[2] + Math.round(Math.min(4, n2.s * Math.exp(-n2.age * 1.2)) * 1000);
    p[14] = st.spinPh;
    p[15] = 6 + 10 * h(61) * (0.5 + g[6]);
    // S.p[4]: ring radii, seed, pluck age (the glided hats in hundredths above it).
    p[16] = rin; p[17] = rout; p[18] = h(12) * 10; p[19] = Math.min(morph.leadAge, 9.99) + 10 * Math.round(Math.min(1, hatL) * 100);
    // S.p[5]: moon phase, storm turbulence, atmosphere, hue (eased toward the chord).
    p[20] = st.moonPh;
    p[21] = 0.6 + 0.9 * g[6] + 0.4 * m.tension;
    // Atmosphere, with the oldest plucked ringlet's position in thousandths above it.
    p[22] = 0.02 + 0.06 * g[7] + Math.round(n2.x * 1000);
    p[23] = h(51) + ev[0] * 0.2 + st.chordHue * 0.15;
    // S.p[6]: aurora, snare (count * 4 + envelope), kick density wave position and amplitude.
    p[24] = (g[7] > 0.5 ? 0.3 : 0.05) + 0.9 * ant + 1.6 * drop + 0.6 * st.chordGlow;
    fx.snare.update(morph.snares, morph.snareAge, morph.snareLevel);
    p[25] = (morph.snares % 64) * 4 + Math.min(fx.snare.fresh, 0.999);
    // The density wave's radius, with the previous snare's spokes (still fading) in hundredths x 10 above it.
    p[26] = Math.min(morph.kickAge, 9) * 0.9 + 10 * Math.round(Math.min(1, fx.snare.old) * 100);
    p[27] = fx.wave.update(morph.kicks, morph.kickAge, morph.kickLevel);
    // S.p[7]: the two most recent plucked ringlets (position, brightness).
    const n0 = st.notes[0];
    const n1 = st.notes[1];
    p[28] = n0.x;
    p[29] = glow(n0);
    // The older ringlet: whole hundredths of a second its attack was old at the new note, x as the fraction.
    p[30] = Math.round(n1.off * 100) + n1.x;
    p[31] = n1.s * Math.exp(-n1.age * 1.2);
  },
  wgsl: /* wgsl */ `
fn rw_styles() -> i32 { return i32(floor(S.p[3].x)); }
fn rw_bandStyle() -> i32 { return rw_styles() & 7; }
fn rw_ringStyle() -> i32 { return (rw_styles() >> 3u) & 3; }
fn rw_moons() -> i32 { return (rw_styles() >> 5u) & 7; }
fn rw_boulders() -> bool { return (rw_styles() & 256) != 0; }
fn rw_desat() -> f32 { return fract(S.p[3].x) + 0.5; }
fn rw_hue() -> f32 { return S.p[5].w; }
// The glided hats, packed in hundredths above the pluck age.
fn rw_hat() -> f32 { return floor(S.p[4].w / 10.0) / 100.0; }
fn rw_snare() -> f32 { return S.p[6].y - 4.0 * floor(S.p[6].y / 4.0); }
fn rw_snareSeed() -> f32 { return floor(S.p[6].y / 4.0); }
/** The previous snare's spokes, still fading (drawn with its own pattern so a new snare never re-deals them). */
fn rw_snareOld() -> f32 { return floor(S.p[6].z / 10.0) / 100.0; }
fn rw_kickR() -> f32 { return S.p[6].z - 10.0 * floor(S.p[6].z / 10.0); }

fn rw_planetT(ro: vec3f, rd: vec3f) -> f32 {
  // Oblate spheroid (equatorial radius 1).
  let k = 1.0 / (1.0 - fract(S.p[3].y));
  let o = vec3f(ro.x, ro.y * k, ro.z);
  let d = vec3f(rd.x, rd.y * k, rd.z);
  let a = dot(d, d);
  let b = dot(o, d);
  let c = dot(o, o) - 1.0;
  let disc = b * b - a * c;
  if (disc < 0.0) { return -1.0; }
  let t = (-b - sqrt(disc)) / a;
  return t;
}

fn rw_sph(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> f32 {
  let oc = ro - c;
  let b = dot(oc, rd);
  let h = b * b - dot(oc, oc) + r * r;
  if (h < 0.0) { return -1.0; }
  return -b - sqrt(h);
}

/** Moon i: xyz centre, w radius. */
fn rw_moon(i: i32) -> vec4f {
  let fi = f32(i);
  let hs = hash11(fi * 7.13 + S.p[4].z);
  var R: f32;
  var rad: f32;
  if (i < 2) {
    // Shepherds hug the outer edge / a gap.
    R = S.p[4].y + 0.04 + 0.05 * fi;
    rad = 0.012 + 0.01 * hs;
  } else {
    R = S.p[4].y + 0.8 + 1.1 * (fi - 1.0) + 0.8 * hs;
    rad = 0.05 + 0.1 * hash11(fi * 3.7 + 1.0);
  }
  let a = S.p[5].x * 2.5 * pow(R, -1.5) + hs * TAU;
  let inc = (hash11(fi * 1.9 + 4.0) - 0.5) * 0.08 * step(2.0, fi);
  return vec4f(cos(a) * R, sin(a) * R * inc, sin(a) * R, rad);
}

/** Ring radial profile: x opacity, y brightness, z hue. fp = radial footprint of the pixel. */
fn rw_ring(r: f32, fp: f32) -> vec3f {
  let rin = S.p[4].x;
  let rout = S.p[4].y;
  let x = (r - rin) / (rout - rin);
  if (x < -0.05 || x > 1.08) { return vec3f(0.0); }
  let seed = S.p[4].z;
  let style = rw_ringStyle();
  let sw = fp / (rout - rin);
  var op = 0.0;
  // Fine ringlets, faded out where they'd alias.
  let aa1 = sat(1.0 - fp * 40.0);
  let aa2 = sat(1.0 - fp * 140.0);
  let aa0 = sat(1.0 - fp * 12.0);
  let fine = 1.0 + 0.3 * aa0 * noise3(vec3f(r * 11.0, seed, 7.5)) + 0.45 * aa1 * noise3(vec3f(r * 38.0, seed, 0.5)) + 0.4 * aa2 * noise3(vec3f(r * 150.0, seed, 3.5));
  if (style == 0) {
    // C / B / Cassini / A (+ Encke gap) / F.
    let c = smoothstep(0.0, 0.04, x) * 0.18;
    let b = smoothstep(0.24, 0.27, x) * smoothstep(0.6, 0.585, x) * (0.75 + 0.2 * sin(x * 31.0 + seed));
    let a = smoothstep(0.66, 0.68, x) * smoothstep(0.97, 0.955, x) * 0.55 * (1.0 - 0.95 * exp(-pow((x - 0.9) / max(0.004, sw), 2.0)));
    let fw = max(0.004, sw);
    let f = exp(-pow((x - 1.03) / fw, 2.0)) * 0.6 * (0.004 / fw);
    op = max(max(c * step(x, 0.6), b), a) + f;
    op *= smoothstep(0.0, 0.01, x) * smoothstep(1.06, 1.04, x);
  } else if (style == 1) {
    // Narrow dense ringlets on a faint sheet.
    op = 0.05 * smoothstep(0.0, 0.1, x) * smoothstep(1.0, 0.85, x);
    for (var k = 0; k < 9; k++) {
      let fk = f32(k);
      let pos = (fk + 0.3 + 0.4 * hash11(fk + seed)) / 9.0;
      let w = (0.004 + 0.01 * hash11(fk * 3.1 + seed)) ;
      let we = sqrt(w * w + sw * sw);
      op += exp(-pow((x - pos) / we, 2.0)) * (w / we) * (0.5 + 0.45 * hash11(fk * 5.3 + seed));
    }
  } else if (style == 2) {
    // Broad dusty sheet with three bright cores.
    op = 0.22 * smoothstep(0.0, 0.3, x) * smoothstep(1.0, 0.6, x);
    for (var k = 0; k < 3; k++) {
      let fk = f32(k);
      let pos = 0.2 + 0.3 * fk + 0.1 * hash11(fk + seed);
      let w = 0.02 + 0.03 * hash11(fk + seed * 2.0);
      let we = sqrt(w * w + sw * sw);
      op += exp(-pow((x - pos) / we, 2.0)) * (w / we) * 0.6;
    }
  } else {
    // Separated broad bands.
    let bands = 4.0;
    let cell = floor(x * bands);
    let fx = fract(x * bands);
    let hb = hash11(cell + seed * 3.0);
    let gap = 0.12 + 0.25 * hb;
    op = smoothstep(gap, gap + 0.04, fx) * smoothstep(1.0, 0.94, fx) * (0.3 + 0.5 * hb);
  }
  // Kick: a density wave bursts from the camera's own ringlet and rolls inward and outward,
  // thickening and lighting the sheet it passes.
  let xc = (length(S.p[0].xz) - rin) / (rout - rin);
  let kx = (abs(x - xc) - rw_kickR()) / (0.05 + 0.5 * rw_kickR());
  let wave = exp(-kx * kx) * S.p[6].w;
  let inside = smoothstep(-0.03, 0.03, x) * smoothstep(1.06, 1.0, x);
  op = sat((op + 0.3 * wave * inside) * fine * (0.7 + 0.3 * hash11(seed * 3.1)));
  let band = hash11(floor(x * 24.0) + seed);
  let bright = 0.55 + 0.35 * fine + 0.25 * band + 3.5 * wave;
  let hue = rw_hue() + 0.08 + x * 0.22 + 0.15 * band;
  return vec3f(op, bright, hue);
}

/** Plucked ringlets (the melody): emission at ring coordinate x and azimuth ang. */
fn rw_harp(x: f32, sw: f32, ang: f32, camAng: f32) -> f32 {
  let w = 0.009;
  let we = sqrt(w * w + sw * sw);
  let d0 = (x - S.p[7].x) / we;
  let x1 = fract(S.p[7].z);
  let d1 = (x - x1) / we;
  // The attack races along the ringlet away from the camera.
  let da = abs(fmod(ang - camAng + PI, TAU) - PI);
  let age = S.p[4].w - 10.0 * floor(S.p[4].w / 10.0);
  let pk = (da - age * 2.2) * 4.0;
  // It swells in as it leaves the camera, so the attack never flashes the near ring in a frame.
  let packet = 1.0 + 4.0 * exp(-pk * pk) * exp(-age * 1.5) * smoothstep(0.0, 0.3, age);
  let core0 = exp(-d0 * d0) * (w / we) * packet + 0.08 * exp(-abs(x - S.p[7].x) * 25.0);
  // The older ringlet keeps its own packet racing on, so a new note never cuts it off.
  let age1 = age + floor(S.p[7].z) * 0.01;
  let pk1 = (da - age1 * 2.2) * 4.0;
  let packet1 = 1.0 + 4.0 * exp(-pk1 * pk1) * exp(-age1 * 1.5) * smoothstep(0.0, 0.3, age1);
  let core1 = exp(-d1 * d1) * (w / we) * packet1 + 0.08 * exp(-abs(x - x1) * 25.0);
  // The oldest ringlet, fading on where it was.
  let x2 = floor(S.p[5].z) * 0.001;
  let d2 = (x - x2) / we;
  let core2 = exp(-d2 * d2) * (w / we) + 0.08 * exp(-abs(x - x2) * 25.0);
  return core0 * S.p[7].y + core1 * S.p[7].w + core2 * floor(S.p[3].y) * 0.001;
}

/** Snare: radial spokes flashing across the inner/middle ring. */
fn rw_spokes(x: f32, ang: f32) -> f32 {
  let env = rw_snare();
  let envO = rw_snareOld();
  if (env + envO < 0.002) { return 0.0; }
  let n = 40.0;
  let a = ang * n / TAU + x * 2.0;
  let id = floor(a);
  let f = fract(a) - 0.5;
  // This snare's spokes, with the previous snare's (its own pattern) fading out under them.
  let on = step(0.45, hash11(id + rw_snareSeed() * 7.31)) * env + step(0.45, hash11(id + (rw_snareSeed() - 1.0) * 7.31)) * envO;
  let w = 0.12 + 0.2 * x;
  return on * exp(-f * f / (w * w)) * smoothstep(0.0, 0.15, x) * smoothstep(1.0, 0.85, x);
}

/** Transmittance toward the sun from p: planet, moons, optionally rings. */
fn rw_shadow(p: vec3f, L: vec3f, withRings: bool) -> f32 {
  if (rw_planetT(p, L) > 0.0) { return 0.0; }
  var tr = 1.0;
  let nm = rw_moons();
  for (var i = 0; i < 6; i++) {
    if (i >= nm) { break; }
    let mo = rw_moon(i);
    let oc = mo.xyz - p;
    let tc = dot(oc, L);
    if (tc > 0.0) {
      let d = length(oc - L * tc);
      tr *= smoothstep(mo.w * 0.8, mo.w * 1.25, d);
    }
  }
  if (withRings && abs(L.y) > 1e-3) {
    let s = -p.y / L.y;
    if (s > 0.0) {
      let q = p + L * s;
      let rr = rw_ring(length(q.xz), 0.01);
      tr *= 1.0 - 0.92 * rr.x;
    }
  }
  return tr;
}

fn rw_stars(rd: vec3f) -> vec3f {
  var col = vec3f(0.0);
  for (var k = 0; k < 2; k++) {
    let sc = 150.0 + 220.0 * f32(k);
    let g = rd * sc;
    let cell = floor(g);
    let hs = hash13(cell + f32(k) * 19.0);
    let off = hash33(cell) - 0.5;
    let d = length(fract(g) - 0.5 - off * 0.5);
    let tw = 0.85 + 0.6 * rw_hat() * step(0.75, fract(hs * 13.0));
    col += mix(vec3f(0.75, 0.82, 1.0), vec3f(1.0, 0.88, 0.7), fract(hs * 29.0)) * smoothstep(0.994 - 0.004 * f32(k), 1.0, hs) * exp(-d * d * 40.0) * tw * mix(1.6, 0.6, f32(k));
  }
  return col;
}

/** Rotate unit vector u about axis by angle a (Rodrigues). */
fn rw_rot(u: vec3f, ax: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return u * c + cross(ax, u) * s + ax * dot(ax, u) * (1.0 - c);
}

/** Cloud deck: rgb albedo (luminance controlled here). u = planet-fixed unit dir. */
fn rw_clouds(u0: vec3f, lightning: ptr<function, f32>) -> vec3f {
  let style = rw_bandStyle();
  let turb = S.p[5].y;
  let seed = S.p[4].z;
  let hue0 = rw_hue();
  var u = u0;
  // Storm vortices: swirl the lookup direction around each storm axis.
  var stormMask = 0.0;
  let nst = select(3, 1, style == 2);
  for (var i = 0; i < 3; i++) {
    if (i >= nst) { break; }
    let fi = f32(i);
    let la = (hash11(fi * 3.3 + seed) - 0.5) * 1.6;
    let lo = hash11(fi * 5.1 + seed) * TAU;
    let ax = vec3f(cos(la) * cos(lo), sin(la), cos(la) * sin(lo));
    let R = (0.12 + 0.12 * hash11(fi + seed * 2.0)) * (0.6 + 0.5 * turb) * select(1.0, 1.6, i == 0);
    let d = acos(clamp(dot(u, ax), -1.0, 1.0));
    let w = sat(1.0 - d / R);
    u = rw_rot(u, ax, w * w * (5.0 + 3.0 * turb) * select(1.0, -1.0, la < 0.0));
    stormMask = max(stormMask, smoothstep(0.0, 0.7, w) * select(0.6, 1.0, i == 0));
  }
  let lat = asin(clamp(u.y, -1.0, 1.0));
  let lon = atan2(u.z, u.x);
  let wq = fbmFast(u * 3.0 + vec3f(seed, 0.0, F.evolve.z), 4);
  let wq2 = fbmFast(u * 11.0 + vec3f(1.0, seed, 2.0), 3);
  let freq = S.p[3].w;
  var lum = 0.4;
  var hue = hue0;
  if (style == 0) {
    // Jovian: contrasting belts and zones with turbulent edges.
    let bl = lat * freq + wq * 1.3 * turb + wq2 * 0.35;
    let z = smoothstep(-0.35, 0.35, sin(bl));
    lum = mix(0.13, 0.5, z) * (0.85 + 0.3 * wq2);
    hue = hue0 + 0.12 * sin(bl * 0.37 + 1.0) + 0.05 * z;
  } else if (style == 1) {
    // Saturnine: soft pastel bands.
    let bl = lat * freq * 0.7 + wq * 0.35;
    lum = 0.36 + 0.07 * sin(bl) + 0.05 * sin(bl * 2.7) + 0.04 * wq2;
    hue = hue0 + 0.05 * sin(bl * 0.5);
    lum *= 1.0 - 0.25 * smoothstep(1.2, 1.5, abs(lat));
  } else if (style == 2) {
    // Ice giant: smooth deep body, faint bands, bright streak clouds.
    lum = 0.3 + 0.04 * sin(lat * 5.0 + wq);
    let streak = pow(sat(noise3fast(vec3f(lon * 1.5, lat * 24.0, seed) ) * 0.5 + 0.5 + 0.3 * wq2), 6.0);
    lum += streak * 0.6 * smoothstep(0.1, 0.6, abs(lat));
    hue = hue0 + 0.33 + 0.03 * wq;
  } else if (style == 3) {
    // Marbled turbulence.
    let q = u * 2.0 + vec3f(wq, wq2, wq) * 1.6 * turb;
    let v = fbmFast(q * 2.5 + 3.0, 4);
    lum = 0.14 + 0.45 * smoothstep(-0.35, 0.35, v + 0.2 * sin(lat * freq * 0.5));
    hue = hue0 + 0.45 * v + 0.1 * wq;
  } else {
    // Sharp stripes with Kelvin-Helmholtz waves.
    let kh = sin(lon * 9.0 + lat * 13.0 + wq * 2.0) * 0.18 * smoothstep(-0.5, 1.0, wq2 + 0.5);
    let bl = lat * freq * 1.8 + kh + wq * 0.4;
    let s = abs(fract(bl / TAU) - 0.5) * 2.0;
    lum = mix(0.1, 0.52, smoothstep(0.42, 0.5, s) + 0.4 * smoothstep(0.85, 0.9, s));
    hue = hue0 + floor(bl / TAU) * 0.13;
  }
  // Storm interiors: bright rim, saturated eye.
  lum = mix(lum, 0.3 + 0.25 * sin(stormMask * 12.0), stormMask * 0.6);
  hue += stormMask * 0.25;
  // Lightning in storm cells on the snare.
  let cell = floor(u0 * 18.0);
  let hc = hash13(cell + seed);
  let fr = fract(u0 * 18.0) - 0.5 - (hash33(cell) - 0.5) * 0.4;
  let sn = max(rw_snare(), rw_snareOld());
  *lightning = step(1.0 - 0.06 * sn, hc) * sn * (0.4 + stormMask) * exp(-dot(fr, fr) * 30.0);
  return mix(palL(hue, lum), vec3f(lum), rw_desat() * 0.35);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[0].xyz;
  let cam = lookAt(ro, S.p[1].xyz, S.p[0].w);
  let rd = normalize(cam * vec3f(q, S.p[1].w));
  let L = normalize(S.p[2].xyz);
  let sunI = S.p[2].w;
  let pixA = 2.0 / (F.res.y * S.p[1].w);
  let f = fract(S.p[3].y);
  let hue = rw_hue();
  let desat = rw_desat();

  // Background: stars, faint palette nebula, sun.
  var bg = rw_stars(rd) * 0.8;
  let nb = fbmFast(rd * 1.8 + vec3f(5.0, 2.0, F.evolve.y * 3.0), 4);
  bg += palL(hue + 0.5 + nb * 0.4, 0.012) * smoothstep(-0.1, 0.5, nb);
  let sd = dot(rd, L);
  bg += vec3f(1.0, 0.95, 0.85) * (pow(sat(sd), 4000.0) * 30.0 + pow(sat(sd), 200.0) * 0.6) + palL(0.9, 0.08) * pow(sat(sd), 12.0);

  // Planet.
  let tp = rw_planetT(ro, rd);
  // Ring plane.
  var tr = -1.0;
  if (abs(rd.y) > 1e-5) { tr = -ro.y / rd.y; }

  var col = bg;
  var planetCol = vec3f(0.0);
  var hitP = tp > 0.0;
  // Closest approach for atmospheric limb glow.
  let tc = max(-dot(ro, rd), 0.0);
  let dmin = length(ro + rd * tc);
  let atmH = fract(S.p[5].z);
  if (hitP) {
    let p = ro + rd * tp;
    let k = 1.0 / (1.0 - f);
    let n = normalize(vec3f(p.x, p.y * k * k, p.z));
    let u0 = normalize(vec3f(p.x, p.y * k, p.z));
    // Differential rotation: equator faster.
    let lat0 = asin(clamp(u0.y, -1.0, 1.0));
    let rotA = S.p[3].z * (6.0 + 1.5 * cos(lat0 * 2.0));
    let cr = cos(rotA); let sr = sin(rotA);
    let u = vec3f(u0.x * cr - u0.z * sr, u0.y, u0.x * sr + u0.z * cr);
    var lightning = 0.0;
    let alb = rw_clouds(u, &lightning);
    let ndl = dot(n, L);
    let sh = rw_shadow(p + n * 1e-3, L, true);
    let diff = smoothstep(-0.08, 0.5, ndl) * (0.25 + 0.75 * sat(ndl)) * sh;
    let mu = sat(dot(n, -rd));
    // Limb darkening / haze toward the edge.
    let haze = palL(hue + 0.55, 0.5) * pow(1.0 - mu, 3.0) * atmH * 18.0 * sat(ndl + 0.25);
    planetCol = (alb * diff * 0.6 + haze) * sunI;
    // Ring-shine on the night side.
    planetCol += alb * 0.04 * sat(-ndl) * sat(abs(L.y) * 3.0);
    planetCol += palL(hue + 0.7, 1.0) * lightning * 1.5 * smoothstep(0.1, -0.2, ndl);
    // Polar aurora ovals.
    let alat = abs(lat0);
    let aur = exp(-pow((alat - 1.22) * 14.0, 2.0)) * S.p[6].x * (0.6 + 0.4 * noise3fast(vec3f(u0 * 9.0 + S.p[3].z * 4.0)));
    planetCol += palL(hue + 0.35 + F.morph2.x * 0.2, 1.0) * aur * (0.6 + 0.6 * pow(1.0 - mu, 2.0));
    col = planetCol;
  } else {
    // Atmospheric limb: lit rim + forward-scattered halo when backlit.
    let hgt = dmin - 1.0;
    if (hgt > 0.0 && tc > 0.0) {
      let cp = normalize(ro + rd * tc);
      let lit = sat(dot(cp, L) + 0.25);
      let fwd = pow(sat(sd), 6.0) * 3.0;
      col += palL(hue + 0.55, 1.0) * exp(-hgt / atmH) * (lit * 0.35 + fwd) * sunI;
      let alat = abs(asin(clamp(cp.y, -1.0, 1.0)));
      col += palL(hue + 0.35, 1.0) * exp(-hgt / (atmH * 1.5)) * exp(-pow((alat - 1.22) * 14.0, 2.0)) * S.p[6].x * 0.12;
    }
  }

  // Rings: in front of the planet, or over the background.
  if (tr > 0.0 && (!hitP || tr < tp)) {
    let rp = ro + rd * tr;
    let r = length(rp.xz);
    let fp = pixA * tr / max(abs(rd.y), 0.02) + 1e-4;
    let rg = rw_ring(r, fp);
    let x = (r - S.p[4].x) / (S.p[4].y - S.p[4].x);
    let ang = atan2(rp.z, rp.x);
    let harp = rw_harp(x, fp / (S.p[4].y - S.p[4].x), ang, atan2(ro.z, ro.x));
    if (rg.x > 0.001) {
      let camSide = sign(ro.y);
      let sunSide = sign(L.y);
      let mu0 = abs(L.y);
      let sh = rw_shadow(rp + vec3f(0.0, 1e-4, 0.0), L, false);
      let ph = sd;
      let g = 0.65;
      let hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * ph, 1.5) * 0.08;
      var lit: f32;
      if (camSide == sunSide) {
        lit = (0.25 + 0.75 * sqrt(mu0)) * (1.0 + 0.5 * pow(sat(-ph), 8.0));
      } else {
        lit = (1.0 - rg.x) * 1.8 * pow(mu0, 0.3);
      }
      lit += hg * (1.0 - rg.x * 0.6) * 3.0;
      let rc = mix(palL(rg.z, 0.45), vec3f(0.45), desat * 0.6) * rg.y;
      var ringCol = rc * lit * sh * sunI * rg.x * 0.7;
      // Snare spokes: bright radial streaks in the ring particles.
      ringCol += mix(palL(hue + 0.15, 1.0), vec3f(1.0), 0.4) * rw_spokes(x, ang) * (0.3 + rg.x) * (1.0 + lit) * sunI * 1.5;
      // Hat sparkles on the ring particles.
      let gl = step(0.996, hash12(floor(rp.xz * 900.0) + floor(F.time * 12.0))) * rw_hat() * sat(1.0 - fp * 200.0);
      ringCol += vec3f(1.0) * gl * rg.x * 2.0 * sh;
      col = ringCol + col * (1.0 - rg.x);
    }
    // The plucked ringlets glow on their own, brightest where there is ring material.
    col += palL(hue + 0.85, 1.0) * harp * (0.3 + 0.7 * sqrt(rg.x)) * 2.6;
  }

  // Moons (in front of everything they beat).
  let nm = rw_moons();
  var tBest = 1e9;
  if (hitP) { tBest = tp; }
  if (tr > 0.0) {
    let rr = length((ro + rd * tr).xz);
    if (rw_ring(rr, 0.01).x > 0.3) { tBest = min(tBest, tr); }
  }
  for (var i = 0; i < 6; i++) {
    if (i >= nm) { break; }
    let mo = rw_moon(i);
    let tm = rw_sph(ro, rd, mo.xyz, mo.w);
    if (tm > 0.0 && tm < tBest) {
      tBest = tm;
      let mp = ro + rd * tm;
      let n = normalize(mp - mo.xyz);
      let cr = fbmFast(n * 6.0 + f32(i) * 5.0, 3);
      let crater = 1.0 - 0.4 * smoothstep(0.05, 0.25, abs(fbmFast(n * 14.0 + f32(i), 2)));
      let sh = rw_shadow(mp + n * 1e-3, L, true);
      let a = palL(hue + 0.2 + 0.4 * hash11(f32(i)), 0.3 + 0.12 * cr) * crater;
      col = a * smoothstep(-0.05, 0.4, dot(n, L)) * sh * sunI + a * 0.02;
    }
  }

  // Close to the ring plane: layered boulder field around it, for parallax.
  if (rw_boulders() && abs(rd.y) > 1e-5) {
    for (var k = 0; k < 5; k++) {
      let fk = f32(k);
      let yk = (fk - 2.0) * 0.006;
      let tk = (yk - ro.y) / rd.y;
      if (tk <= 0.0 || tk > tBest || tk > 2.0) { continue; }
      let pk = ro + rd * tk;
      let rg = rw_ring(length(pk.xz), 0.01);
      if (rg.x < 0.05) { continue; }
      let cs = 0.025 + 0.01 * fk;
      let cell = floor(pk.xz / cs);
      let hb = hash12(cell + fk * 17.0);
      if (hb > rg.x * 0.5) { continue; }
      let o = hash33(vec3f(cell, fk)) - 0.5;
      let c3 = vec3f((cell.x + 0.5 + o.x * 0.4) * cs, yk + o.y * 0.004, (cell.y + 0.5 + o.z * 0.4) * cs);
      let rad = cs * (0.04 + 0.08 * fract(hb * 13.0) * fract(hb * 7.0));
      let tm = rw_sph(ro, rd, c3, rad);
      if (tm > 0.0 && tm < tBest) {
        let n = normalize(ro + rd * tm - c3);
        let bump = fbmFast(n * 4.0 + vec3f(cell * 0.37, fk), 2);
        let nl = smoothstep(-0.1, 0.6, dot(n, L) + bump * 0.3);
        let a = mix(palL(rg.z, 0.22), vec3f(0.22), 0.4 + 0.4 * desat) * (0.03 + nl * sunI) * (0.5 + 0.5 * bump + 0.3 * rg.y);
        let rim = pow(1.0 - sat(dot(n, -rd)), 3.0) * pow(sat(sd), 4.0) * sunI;
        col = mix(col, a + vec3f(rim), smoothstep(2.0, 0.6, tm));
        tBest = tm;
      }
    }
  }
  return vec4f(col, 1.0);
}
`,
});
