import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Droste Zoom: an endless spiral tunnel of extruded glossy tiles and neon seams, flown into forever.
 * It is a lattice drawn in log space: w = log z turns the screen into a strip where zooming is a
 * slide and turning is a wrap, so any lattice that contains the period 2*pi*i maps back to a
 * seamless, self-similar picture. With e1 = 2*pi*i / (p + q*tau) and e2 = tau*e1 the lattice
 * contains it for every complex tau, so the tile shape (square, rhombic, hexagonal, sheared) morphs
 * continuously. Perspective in a tunnel acts only along log-radius, so a short heightfield march
 * along rho turns every tile into a real extruded block with a visible near face.
 *
 * Never the same tunnel for more than a phrase. Every phrase (morph.ts carries its coordinates to a
 * new region) a new tunnel state, with new tile and arm counts, tile family, tile shape, extrusion and
 * colour scheme, emerges from the vanishing point and is flown into: its border is a ragged portal
 * ring that rushes outward until the new tunnel has replaced the old one (the Droste picture inside
 * the picture). Tile families blend continuously: Voronoi blocks, organic jittered cells, blocks
 * split into triangles, and a Truchet maze of neon arcs over low relief.
 *
 * Energy: the flight is morph.travel (it rushes with the bass drive, and a drop's surge multiplies
 * it further while it eases off); the bass drive also corkscrews the tunnel (a twist in log space)
 * and spins it.
 *
 * Exact anti-aliasing: |dw/dz| = |m'(z)/m(z)| gives the pixel footprint in log space, so seams stay
 * one pixel crisp at every depth and tiles below a few pixels near the vanishing point fade into a
 * glowing core.
 *
 * Beats change the tunnel globally and for good, each change gliding in over about half a second
 * (block heights re-roll and the colour scheme turns with the kicks, a new set of tiles turns to
 * glowing glass with the snares, the tall blocks take the gliding pitch's colour), and light travels
 * through the tiling cell by cell, fast along the spiral rows and slower across them, with a ragged
 * per-tile delay. Every burst swells in, and a front fades out as a whole before the next may start:
 *  - kick: a fire lit deep in the tunnel;
 *  - snare: a fast cool crackle lit nearer;
 *  - melody: a glow in the note's colour lit at an angle set by the pitch.
 *
 * Every beat change and front scales with its own hit's strength (morph's event levels,
 * captured as each event lands): a faint hit nudges the relief, a hard one re-rolls it in full.
 *
 * Fine scale (high melody, arps, backing, hats): the tile bevels, seam widths and Truchet arc widths
 * are re-formed by them. Every upper note (and, more gently, backing chords and hats) re-cuts each
 * tile's bevel to a new width, eased in by its strength, and morph.detailAt flows the seam and arc
 * widths, so the high end reworks the finest structure while the bass drives the tunnel.
 *
 * DNA: 0 start, 1 first arms, 3 palette, 4 bend direction, 5 light side.
 */

const morph = new Morph(0.8);
/** Coprime (tiles around, spiral arms) pairs. */
const ARMS: readonly [number, number][] = [
  [12, 1], [14, 3], [16, 1], [17, 2], [18, 5], [19, 3], [20, 3], [21, 4], [22, 5], [23, 2],
  [24, 5], [25, 3], [26, 3], [27, 4], [28, 3], [29, 2], [30, 7], [33, 4], [36, 5], [13, 2],
];

/** One tunnel state. */
interface Lat {
  tx: number;
  ty: number;
  P: number;
  Q: number;
  s: number;
  fam: number;
  ext: number;
  hue: number;
}
const lat = (): Lat => ({ tx: 0, ty: 1, P: 20, Q: 3, s: 0, fam: 0, ext: 0.6, hue: 0 });

/**
 * Event glides: each event adds a step that eases in on a smoothstep over `T` seconds (from rest,
 * fastest half-way, settled at the end), so a beat is a smooth change of state, never a snap.
 */
class Glide {
  private base = 0;
  private steps: { t0: number; a: number }[] = [];
  constructor(private readonly T: number) {}
  reset(v = 0): void {
    this.base = v;
    this.steps = [];
  }
  add(t: number, a: number): void {
    this.steps.push({ t0: t, a });
  }
  at(t: number): number {
    let v = this.base;
    this.steps = this.steps.filter((q) => {
      const x = (t - q.t0) / this.T;
      if (x >= 1) {
        this.base += q.a;
        v += q.a;
        return false;
      }
      if (x > 0) v += q.a * x * x * (3 - 2 * x);
      return true;
    });
    return v;
  }
}
// Kick: relief re-roll, shear step, colour turn, the portal's stride. Snare: extrusion and glass.
const gK = new Glide(0.6);
const gS = new Glide(0.4);
const gRb = new Glide(0.4);
/**
 * Seconds each light front runs (it fades out smoothly before then). A new front only starts once
 * the last one has run its course, so no front is ever cut off mid-burn.
 */
const K_LIFE = 0.7;
const S_LIFE = 0.38;
const L_LIFE = 0.36;

const st = {
  seed: -1, n: -1, cur: 0, prev: 0, pe: 0, tr: 0, phr: -1, k: -1, sn: -1,
  A: lat(), B: lat(), rb: -99, rbD: -99, rk: -1, kp: 0, sp: 0, rate: 0, roll: 0, twPh: 0, peV: 0,
  // A phrase waiting for the arriving tunnel to finish; start times of the running light fronts.
  pend: false, kT: -99, sT: -99, lT: -99,
  ign: [[-2, 0], [-1, 0], [-1, 0]] as number[][],
  /** Strength of each running light front, captured when it was lit. */
  kL: 0, sL: 0, lL: 0,
};

const fract = (x: number) => x - Math.floor(x);
const hash = (x: number) => fract(Math.sin(x * 12.9898 + 4.1) * 43758.5453);

/** Fills the continuous parameters of a tunnel state from the morph coordinates. */
function shape(L: Lat, a: Float64Array, g: readonly number[], kp: number, sp: number): void {
  // Each kick re-forms the tiles for good: the shear steps to a new value (eased in on a glide).
  L.tx = wave(a[0], -0.4, 0.4) + 0.08 * Math.sin(kp * 2.399);
  L.ty = wave(a[1], 0.62, 1.35);
  // Family ring: 0 blocks, 1 organic cells, 2 triangles, 3 Truchet (cyclic, blended).
  L.fam = ((((a[2] + 0.6 * Math.sin(a[5])) * 0.65) % 4) + 4) % 4;
  // Each snare sets a new extrusion depth for good.
  L.ext = wave(a[3] + 1.3 * Math.sin(sp * 1.913), 0.45, 1.3);
  L.hue = fract(g[3] + a[4] * 0.11);
}

/** Radial component of e2 (always negative): how fast rho moves per unit of slide. */
const reE2 = (L: Lat) => {
  const dr = L.P + L.Q * L.tx;
  const di = L.Q * L.ty;
  return (-2 * Math.PI * L.ty * L.P) / (dr * dr + di * di);
};
/** e2 as a complex number. */
const e2 = (L: Lat): [number, number] => {
  const dr = L.P + L.Q * L.tx;
  const di = L.Q * L.ty;
  const d2 = dr * dr + di * di;
  // e1 = 2*pi*i / D; e2 = tau * e1.
  const e1r = (2 * Math.PI * di) / d2;
  const e1i = (2 * Math.PI * dr) / d2;
  return [L.tx * e1r - L.ty * e1i, L.tx * e1i + L.ty * e1r];
};

export default raymarchScene({
  meta: {
    id: 'droste-zoom',
    name: 'Droste Zoom',
    energy: [0.1, 1],
    mood: { valence: 0.55, arousal: 0.7 },
    genres: { edm: 1, techno: 1, synthwave: 1, dnb: 0.9, dubstep: 0.9, pop: 0.6, ambient: 0.5, hiphop: 0.7, rock: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    // The shape follows the step-free coordinates; kicks and snares get their own fast lasting steps
    // (below), so each beat lands as one clean change instead of a slow slide.
    const a = morph.flowAt;
    if (g[0] !== st.seed || morph.notes < st.n) {
      st.seed = g[0];
      st.n = morph.notes;
      st.cur = st.prev = st.pe = morph.notePitch;
      st.tr = morph.travel;
      st.phr = morph.phrases;
      st.k = morph.kicks;
      st.sn = morph.snares;
      st.rb = st.rbD = -99;
      st.pend = false;
      st.roll = st.twPh = 0;
      st.peV = 0;
      st.kT = st.sT = st.lT = -99;
      gK.reset(morph.kicks);
      gS.reset(morph.snares);
      gRb.reset();
      st.kp = morph.kicks;
      st.sp = morph.snares;
      st.rate = 0.2;
      const [P, Q] = ARMS[Math.floor(g[1] * ARMS.length) % ARMS.length];
      Object.assign(st.A, { P, Q, s: 0 });
      shape(st.A, a, g, st.kp, st.sp);
      Object.assign(st.B, st.A);
    }
    const justNoted = morph.notes !== st.n;
    if (justNoted) {
      st.prev = st.cur;
      // The note colour moves toward the new pitch by the note's strength.
      st.cur += (morph.notePitch - st.cur) * morph.noteLevel;
      st.n = morph.notes;
    }
    {
      // The pitch glides (critically damped, from rest, settled in about 0.4 s).
      const w = 12;
      const e = Math.exp(-w * dt);
      const d0 = st.pe - st.cur;
      const c = st.peV + w * d0;
      st.pe = st.cur + (d0 + c * dt) * e;
      st.peV = (st.peV - w * c * dt) * e;
    }

    // A new phrase: the next tunnel state is born at the vanishing point. If the last one has not
    // finished arriving, the new one waits for it (nothing is ever swapped out half-shown).
    if (morph.phrases !== st.phr) {
      st.phr = morph.phrases;
      st.pend = true;
    }
    if (st.pend && st.rb < -90) {
      st.pend = false;
      let i = Math.floor(hash(morph.phrases * 3.7 + g[1] * 17) * ARMS.length) % ARMS.length;
      if (ARMS[i][0] === st.A.P) i = (i + 7) % ARMS.length;
      Object.assign(st.B, st.A, { P: ARMS[i][0], Q: ARMS[i][1], s: 0 });
      st.rb = st.rbD = -5.5;
      gRb.reset();
      st.rk = morph.kicks;
    }
    // The arriving state follows the morph live (its jump eases in over the first bar); the old one
    // holds its shape while it streams out. Kicks and snares step it on glides.
    // Each beat's lasting step scales with its own strength (a faint hit gives a faint change).
    const kLv = morph.kickLevel;
    const sLv = morph.snareLevel;
    if (morph.kicks !== st.k) gK.add(m.time - morph.kickAge, 1.3 * kLv);
    if (morph.snares !== st.sn) gS.add(m.time - morph.snareAge, 1.5 * sLv);
    st.kp = gK.at(m.time);
    st.sp = gS.at(m.time);
    if (st.rb > -90) shape(st.B, a, g, st.kp, st.sp);
    else shape(st.A, a, g, st.kp, st.sp);

    // Energy: the flight, the roll and the bass corkscrew all advance with the travel, which rushes
    // with the bass drive; a drop's surge multiplies them while it eases off.
    // The travel rate is smoothed over about a second: sustained bass speeds the flight, but single
    // wobbles do not jerk it.
    const rawTr = Math.min(Math.max(morph.travel - st.tr, 0), 1);
    st.tr = morph.travel;
    if (dt > 0) st.rate += (rawTr / dt - st.rate) * (1 - Math.exp(-dt / 1.0));
    const dTr = st.rate * dt;
    const rush = 1 + 7 * morph.surge;
    const dRho = dTr * 0.12 * rush;
    const dsA = dRho / -reE2(st.A);
    st.A.s += dsA;
    st.B.s += dRho / -reE2(st.B);
    st.roll += dTr * 0.04 * (1 + 8 * morph.surge) * (g[4] < 0.5 ? -1 : 1);
    st.twPh += dTr * (0.3 + 0.5 * morph.drive) * rush;
    if (st.rb > -90) {
      // The portal rides outward with the tiles and strides a step further on every kick (eased), so the
      // next tunnel arrives beat by beat; without kicks it drifts out on its own.
      if (morph.kicks !== st.rk) {
        st.rk = morph.kicks;
        gRb.add(m.time - morph.kickAge, 1.4 * kLv);
      }
      st.rbD += dRho + dt * 0.25;
      st.rb = st.rbD + gRb.at(m.time);
      if (st.rb > 1.4) {
        Object.assign(st.A, st.B);
        st.rb = st.rbD = -99;
        gRb.reset();
      }
    }
    // Ignition points live in log space and stream out with the tiles.
    const [er, ei] = e2(st.A);
    for (const q of st.ign) {
      q[0] -= er * dsA;
      q[1] -= ei * dsA;
      q[1] -= Math.round(q[1] / (2 * Math.PI)) * 2 * Math.PI;
    }
    if (morph.kicks !== st.k) {
      st.k = morph.kicks;
      if (m.time - st.kT >= K_LIFE) {
        st.kT = m.time - morph.kickAge;
        st.ign[0] = [0.35, ((morph.kicks * 2.4) % 6.283) - 3.14];
        st.kL = kLv;
      }
    }
    if (morph.snares !== st.sn) {
      st.sn = morph.snares;
      if (m.time - st.sT >= S_LIFE) {
        st.sT = m.time - morph.snareAge;
        st.ign[1] = [0.1, ((morph.snares * 1.9 + 1) % 6.283) - 3.14];
        st.sL = sLv;
      }
    }
    if (justNoted && m.time - st.lT >= L_LIFE) {
      st.lT = m.time - morph.leadAge;
      st.ign[2] = [0.2, st.cur * 3.0];
      st.lL = morph.noteLevel;
    }

    // Fine scale: the upper voice's strength-weighted eased count re-cuts the tile seams, bevels and
    // facets; the detail coordinate (and each backing chord, by its strength) flows the seam and arc widths.
    const fine = [3.5 * morph.upperPhase, morph.detailAt[0] + 0.6 * morph.detailAt[1] + 0.5 * morph.backingPhase];
    fine[0] %= 1024;
    const put = (L: Lat, o: number, extra: number) => {
      p[o] = L.tx;
      p[o + 1] = L.ty;
      // Arms and the hue share a slot: P * 64 + Q + hue (hue in [0, 1)).
      p[o + 2] = L.P * 64 + L.Q + Math.min(L.hue, 0.9999);
      p[o + 3] = L.s;
      p[o + 4] = L.fam;
      p[o + 5] = L.ext;
      p[o + 6] = fine[o >> 3];
      p[o + 7] = extra;
    };
    put(st.A, 0, st.rb);
    // S.p[3].w: the snare glide (glass state) + 1, signed by the light side.
    put(st.B, 8, ((st.sp % 1024) + 1) * (g[5] < 0.5 ? -1 : 1));
    // Front ages (seconds, < 10) with each front's strength packed above them: 10 * round(1000 level) + age.
    const pack = (age: number, lv: number) => 10 * Math.round(1000 * Math.min(Math.max(lv, 0), 1)) + Math.min(Math.max(age, 0), 9);
    p[16] = pack(m.time - st.kT, st.kL);
    p[17] = pack(m.time - st.sT, st.sL);
    p[18] = pack(m.time - st.lT, st.lL);
    // The phrase framing (morph.cam). A lens change in a log-space tunnel is only a slide, so the
    // field of view sets the depth scale of log-radius instead: wide packs more of the tunnel into
    // the frame (deep, compressed rings), telephoto stretches the near tiles long. Glow (0.85..1.2)
    // and that depth scale (integer part, 1/2048) share a slot.
    const cam = morph.cam;
    const lens = Math.pow(Math.min(2.2, Math.max(0.55, cam.fov)), 0.7);
    p[19] = 4 * Math.round(lens * 2048) + 0.85 + 0.35 * m.energySlow * morph.flow;
    // The relief re-roll and the colour turn ride the kick glide.
    p[20] = st.kp % 1024;
    // The note colour follows the gliding pitch.
    p[21] = Math.max(-1, Math.min(1, st.pe));
    // Off-axis bend (disk automorphism parameter b).
    // The framing's yaw, pitch and height tilt the tunnel axis on top (the vanishing point slides).
    const bAng = a[6] * 0.5 + g[4] * 6.283;
    const bR = wave(a[7], 0.05, 0.3);
    let bx = bR * Math.cos(bAng) + 0.3 * cam.yaw;
    let by = bR * Math.sin(bAng) + 0.35 * cam.pitch + 0.08 * cam.height;
    const bl = Math.hypot(bx, by);
    if (bl > 0.5) {
      bx *= 0.5 / bl;
      by *= 0.5 / bl;
    }
    p[22] = bx;
    p[23] = by;
    p[24] = st.ign[0][0];
    p[25] = st.ign[0][1];
    p[26] = st.ign[1][0];
    p[27] = st.ign[1][1];
    p[28] = st.ign[2][0];
    p[29] = st.ign[2][1];
    p[30] = st.roll + 0.8 * cam.roll;
    // The bass corkscrew: radians of twist per unit of log-radius.
    p[31] = (0.015 + 0.03 * morph.drive + 0.45 * morph.surge) * Math.sin(st.twPh);
  },
  wgsl: /* wgsl */ `
fn dz_cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn dz_cdiv(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / max(dot(b, b), 1e-12); }

fn dz_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.25, 0.05) * h * 1.4 + vec3f(1.0, 0.62, 0.2) * h * h * 2.2 + vec3f(1.0, 0.95, 0.9) * pow(h, 5.0) * 2.5;
}

// The director palette's hue at full saturation, rotated by rot turns, at an even perceived level
// (bright hues are only dimmed a little, so yellows stay gold instead of going olive).
fn dz_col(t: f32, lvl: f32, rot: f32) -> vec3f {
  let p = pal(t);
  let mx = max(p.r, max(p.g, p.b));
  let mn = min(p.r, min(p.g, p.b));
  // Hue from the chroma vector, steadied by a pull toward t's own hue, so a near-grey palette colour
  // never makes the hue jump.
  let v = vec2f(p.r - 0.5 * (p.g + p.b), 0.8660254 * (p.g - p.b)) + 0.2 * vec2f(cos(t * TAU), sin(t * TAU));
  let h = fract(atan2(v.y, v.x) / TAU + rot);
  let s = mix(0.75, 0.95, sat((mx - mn) / max(mx, 1e-4)));
  let c = hsv2rgb(vec3f(h, s, 1.0));
  return c * lvl * pow(clamp(0.4 / max(luma(c), 0.08), 0.6, 4.0), 0.55);
}

// One tunnel state, unpacked.
struct Lat { tau: vec2f, P: f32, Q: f32, s: f32, fam: f32, ext: f32, hue: f32, e1: vec2f, e1l: f32 };
fn dz_lat(i: u32) -> Lat {
  let a = S.p[i * 2u];
  let b = S.p[i * 2u + 1u];
  var L: Lat;
  L.tau = a.xy;
  L.P = floor(a.z / 64.0 + 0.001);
  L.Q = floor(a.z - L.P * 64.0 + 0.001);
  L.hue = fract(a.z);
  L.s = a.w;
  L.fam = b.x;
  L.ext = b.y;
  L.e1 = dz_cdiv(vec2f(0.0, TAU), vec2f(L.P + L.Q * L.tau.x, L.Q * L.tau.y));
  L.e1l = length(L.e1);
  return L;
}
// Which state owns a point of log space: the new one inside the portal ring, the old one outside.
fn dz_pick(w: vec2f) -> u32 {
  let rb = S.p[0].w + 0.18 * sin(w.y * 3.0 + S.p[0].w * 2.0) + 0.1 * sin(w.y * 7.0 - S.p[0].w * 3.0);
  return select(0u, 1u, w.x < rb);
}
// Family weights (blocks, organic cells, triangles, Truchet) from the cyclic family coordinate.
fn dz_fw(f: f32) -> vec4f {
  let d = abs(fract((vec4f(f) - vec4f(0.0, 1.0, 2.0, 3.0)) / 4.0 + 0.5) - 0.5) * 4.0;
  return smoothstep(vec4f(1.0), vec4f(0.0), d);
}

// Fine phase: the upper voice's strength-weighted eased count (plus a little of the backing's).
// Each step re-cuts every tile's seam and bevel to new widths, eased by the step itself.
fn dz_recut(c: vec2f, L: Lat, salt: f32) -> f32 {
  let fph = S.p[1].z;
  let f0 = floor(fph);
  let kid = dz_kid(c, L);
  return mix(hash12(vec2f(kid, salt + 5.0 * f0)), hash12(vec2f(kid, salt + 5.0 * f0 + 5.0)), smoothstep(0.0, 1.0, fph - f0));
}
// Which tiles carry fine facets (their top split into triangles): re-chosen by every high note.
fn dz_facet(c: vec2f, L: Lat) -> f32 {
  let fph = S.p[1].z;
  let f0 = floor(fph);
  let kid = dz_kid(c, L);
  let a = smoothstep(0.4, 0.6, hash12(vec2f(kid, 83.0 + 5.0 * f0)));
  let b = smoothstep(0.4, 0.6, hash12(vec2f(kid, 88.0 + 5.0 * f0)));
  return mix(a, b, smoothstep(0.0, 1.0, fph - f0));
}
// Seam (gap) width of a tile: the state's base width, flowed by the fine detail coordinate and
// re-cut tile by tile by the high notes.
fn dz_gap(L: Lat, c: vec2f) -> f32 {
  return (0.03 + 0.03 * fract(L.hue * 7.3)) * (0.75 + 0.5 * (0.5 + 0.5 * sin(S.p[3].z))) * (0.3 + 1.5 * dz_recut(c, L, 23.0));
}
fn dz_kid(c: vec2f, L: Lat) -> f32 { return c.x * L.Q - c.y * L.P; }
fn dz_jit(c: vec2f, L: Lat, amt: f32) -> vec2f {
  if (amt < 0.002) { return vec2f(0.0); }
  let k = dz_kid(c, L);
  return (vec2f(hash12(vec2f(k, 71.0)), hash12(vec2f(k, 93.0))) - 0.5) * amt;
}

// Lattice coordinates (x, y + slide) of w.
fn dz_xy(w: vec2f, L: Lat) -> vec2f {
  let zeta = dz_cdiv(w, L.e1);
  let y = zeta.y / L.tau.y;
  return vec2f(zeta.x - y * L.tau.x, y + fract(L.s));
}

struct DzCell { c: vec2f, pv: vec2f, edge: f32, en: vec2f, nij: vec2f, xy: vec2f };

// The Voronoi cell of the (possibly jittered) lattice point nearest to w (lattice units, e1 = 1),
// with the distance to its nearest edge and that edge's normal. exact = false: F2 - F1 estimate.
fn dz_cell(w: vec2f, L: Lat, jit: f32, exact: bool) -> DzCell {
  let xy = dz_xy(w, L);
  let carry = floor(L.s);
  let base = round(xy);
  var best = vec2f(0.0);
  var bpos = vec2f(0.0);
  var d1 = 1e9;
  var d2 = 1e9;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = base + vec2f(f32(i), f32(j));
      let cp = c + dz_jit(c + vec2f(0.0, carry), L, jit);
      let dv = vec2f(xy.x - cp.x, 0.0) + (xy.y - cp.y) * L.tau;
      let dd = dot(dv, dv);
      if (dd < d1) { d2 = d1; d1 = dd; best = c; bpos = cp; } else if (dd < d2) { d2 = dd; }
    }
  }
  var o: DzCell;
  o.xy = xy;
  o.pv = vec2f(xy.x - bpos.x, 0.0) + (xy.y - bpos.y) * L.tau;
  o.c = vec2f(best.x, best.y + carry);
  o.en = vec2f(1.0, 0.0);
  o.nij = vec2f(1.0, 0.0);
  o.edge = 0.5 * (sqrt(d2) - sqrt(d1));
  if (exact) {
    o.edge = 1e9;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        if (i == 0 && j == 0) { continue; }
        let c = best + vec2f(f32(i), f32(j));
        let cp = c + dz_jit(c + vec2f(0.0, carry), L, jit);
        let nv = vec2f(cp.x - bpos.x, 0.0) + (cp.y - bpos.y) * L.tau;
        let ln = length(nv);
        if (ln > 2.4) { continue; }
        let ed = (ln * ln - 2.0 * dot(o.pv, nv)) / (2.0 * ln);
        if (ed < o.edge) { o.edge = ed; o.en = nv / ln; o.nij = vec2f(f32(i), f32(j)); }
      }
    }
  }
  return o;
}

// Triangle family: seams through the cell centre, perpendicular to the three lattice directions.
// Which of the six triangles round the cell centre pv lies in (0..5), for facet tilts.
fn dz_sector(pv: vec2f, tau: vec2f) -> f32 {
  let n2 = normalize(tau);
  let n3 = normalize(tau - vec2f(1.0, 0.0));
  let a = select(0.0, 1.0, pv.y > 0.0);
  let b = select(0.0, 2.0, n2.x * pv.y - n2.y * pv.x > 0.0);
  let c = select(0.0, 4.0, n3.x * pv.y - n3.y * pv.x > 0.0);
  return a + b + c;
}
fn dz_tri(pv: vec2f, tau: vec2f) -> f32 {
  let n1 = vec2f(1.0, 0.0);
  let n2 = normalize(tau);
  let n3 = normalize(tau - vec2f(1.0, 0.0));
  return min(abs(dot(pv, vec2f(-n1.y, n1.x))), min(abs(dot(pv, vec2f(-n2.y, n2.x))), abs(dot(pv, vec2f(-n3.y, n3.x)))));
}

// Lattice offset (in e1 units) to w-space, reduced modulo the period 2*pi*i.
fn dz_dw(di: f32, dj: f32, L: Lat) -> vec2f {
  var v = dz_cmul(L.e1, vec2f(di, 0.0) + dj * L.tau);
  v.y -= TAU * round(v.y / TAU);
  return v;
}

// Arrival time of a front lit at cell c0 reaching cell c (pixel offset off inside the cell, in w):
// fast along the spiral rows (e1), slower across them, ragged per tile.
fn dz_arrive(c: vec2f, c0: vec2f, off: vec2f, L: Lat, h: f32, vAlong: f32, vAcross: f32) -> f32 {
  let d = dz_dw(c.x - c0.x, c.y - c0.y, L);
  let u = L.e1 / L.e1l;
  let al = dot(d, u);
  let ac = d.x * u.y - d.y * u.x;
  let dir = d / max(length(d), 1e-4);
  return abs(al) / vAlong + abs(ac) / vAcross + 0.06 * h + 0.25 * dot(off, dir) / vAlong;
}

// Block relief: a spiral wave over the cells plus per-cell variation, re-rolled with every kick.
fn dz_relief(cw: vec2f, kid: f32, st: f32) -> f32 {
  let r = hash12(vec2f(kid, 5.0 + 3.0 * st));
  let ph = hash11(st * 1.37) * TAU;
  let m = 2.0 + floor(hash11(st * 2.71 + 0.3) * 3.0);
  let wv = 0.5 + 0.5 * sin(cw.y * m + cw.x * (3.0 + 4.0 * hash11(st * 0.71)) + ph);
  let hh = mix(wv, r, 0.6);
  return hh * hh;
}
// Height (0..1) of a cell: the kick count eases each new relief in, everywhere at once.
fn dz_height(c: vec2f, L: Lat) -> f32 {
  let kp = S.p[5].x;
  let k0 = floor(kp);
  let cw = dz_dw(c.x, c.y, L);
  let kid = dz_kid(c, L);
  return mix(dz_relief(cw, kid, k0), dz_relief(cw, kid, k0 + 1.0), smoothstep(0.0, 1.0, kp - k0));
}

// A light burst at a tile, by seconds since its front arrived: swells in, then fades.
fn dz_burst(b: f32, rise: f32, decay: f32) -> f32 {
  return select(0.0, smoothstep(0.0, rise, b) * exp(-max(b - rise, 0.0) * decay), b > 0.0);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let z = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  // Disk automorphism m(z) = (z - b) / (1 - conj(b) z): bends the tunnel off-axis.
  let b = S.p[5].zw;
  let den = vec2f(1.0, 0.0) - dz_cmul(vec2f(b.x, -b.y), z);
  let mz = dz_cdiv(z - b, den);
  // The lens: log-radius scaled by the framing's depth scale (the angular period is untouched).
  let lens = floor(S.p[4].w * 0.25) / 2048.0;
  // |dw/dz| = |m'(z)| / |m(z)|, m'(z) = (1 - |b|^2) / den^2.
  let jac = (1.0 - dot(b, b)) / max(dot(den, den), 1e-9) / max(length(mz), 1e-9) * max(lens, 1.0);
  var w = vec2f(0.5 * log(max(dot(mz, mz), 1e-30)) * lens, atan2(mz.y, mz.x));
  // Roll and the bass corkscrew (a twist proportional to log-radius).
  w.y += S.p[7].z + S.p[7].w * w.x;
  // Screen direction of a w-space direction: rotate by -arg(dw/dz) = arg(m) + 2 arg(den).
  let argJ = atan2(mz.y, mz.x) + 2.0 * atan2(den.y, den.x);

  let L0 = dz_lat(dz_pick(w));
  let fw0 = jac * 2.0 / max(F.res.y, 540.0) / L0.e1l;
  let inr0 = 0.5 * min(1.0, min(length(L0.tau), length(vec2f(1.0, 0.0) - L0.tau)));
  let detail0 = smoothstep(2.0, 6.0, inr0 / max(fw0, 1e-6));

  // Blocks: a block of height H shows its top shifted inward by H and its near face between.
  // March the levels from the top down, each sample in whichever tunnel state owns it.
  let hbase = 1.25 * L0.e1l * L0.tau.y * detail0;
  let hmax = hbase * max(dz_lat(0u).ext, dz_lat(1u).ext);
  let N = 12;
  let dt = hmax / f32(N);
  var lo = hmax + dt;
  var hi = 0.0;
  for (var k = 0; k <= N; k++) {
    let t = hmax - f32(k) * dt;
    let ws = w + vec2f(t, 0.0);
    let L = dz_lat(dz_pick(ws));
    let fwt = dz_fw(L.fam);
    let cc = dz_cell(ws, L, 0.75 * fwt.y, false);
    let gw = dz_gap(L, cc.c);
    let H = select(0.0, dz_height(cc.c, L) * hbase * L.ext * (1.0 - 0.5 * fwt.w), cc.edge > gw);
    if (H >= t) { hi = t; break; }
    lo = t;
  }
  for (var k = 0; k < 4; k++) {
    let t = 0.5 * (lo + hi);
    let ws = w + vec2f(t, 0.0);
    let L = dz_lat(dz_pick(ws));
    let fwt = dz_fw(L.fam);
    let cc = dz_cell(ws, L, 0.75 * fwt.y, false);
    let gw = dz_gap(L, cc.c);
    let H = select(0.0, dz_height(cc.c, L) * hbase * L.ext * (1.0 - 0.5 * fwt.w), cc.edge > gw);
    if (H >= t) { hi = t; } else { lo = t; }
  }
  let wh = w + vec2f(hi, 0.0);
  let li = dz_pick(wh);
  let L = dz_lat(li);
  let fam = dz_fw(L.fam);
  let cl = dz_cell(wh, L, 0.75 * fam.y, true);
  let gapW = dz_gap(L, cl.c);
  let Hn = dz_height(cl.c, L) * (1.0 - 0.5 * fam.w);
  let Hc = select(0.0, Hn * hbase * L.ext, cl.edge > gapW);
  let isTop = Hc - hi < dt * 0.15 + 1e-5;
  let vfrac = sat(hi / max(Hc, 1e-5));
  let fw = jac * 2.0 / max(F.res.y, 540.0) / L.e1l;
  let inr = 0.5 * min(1.0, min(length(L.tau), length(vec2f(1.0, 0.0) - L.tau)));
  let detail = smoothstep(2.0, 6.0, inr / max(fw, 1e-6));

  let cell = cl.c;
  let kid = dz_kid(cell, L);
  let h = hash12(vec2f(kid, 3.7));
  let h2 = hash12(vec2f(kid, 11.3));
  let depth = -w.x / lens;

  // Front ages, and each front's strength packed above its age.
  let kA = fract(S.p[4].x * 0.1) * 10.0; let sA = fract(S.p[4].y * 0.1) * 10.0; let lA = fract(S.p[4].z * 0.1) * 10.0;
  let kLv = floor(S.p[4].x * 0.1) * 0.001; let sLv = floor(S.p[4].y * 0.1) * 0.001; let lLv = floor(S.p[4].z * 0.1) * 0.001;
  let sN = abs(S.p[3].w) - 1.0;
  let ls = sign(S.p[3].w);
  let pNew = S.p[5].y;
  let hue0 = L.hue;
  let offW = dz_cmul(L.e1, cl.pv);
  let cK = dz_cell(S.p[6].xy, L, 0.0, false).c;
  let cS = dz_cell(S.p[6].zw, L, 0.0, false).c;
  let cL = dz_cell(S.p[7].xy, L, 0.0, false).c;
  let tK = dz_arrive(cell, cK, offW, L, h, 35.0, 14.0);
  let tS = dz_arrive(cell, cS, offW, L, h2, 35.0, 14.0);
  let tL = dz_arrive(cell, cL, offW, L, h, 35.0, 14.0);
  let bK = kA - tK; let bS = sA - tS; let bL = lA - tL;

  // Lasting states, eased in globally on the beat glides: the colour turns with the kicks, a new set
  // of tiles turns to glass with the snares (the fronts carry only light).
  let hState = S.p[5].x;
  let s0 = floor(sN);
  let glassOld = step(0.9, hash12(vec2f(kid, 41.0 + 7.0 * s0)));
  let glassNew = step(0.9, hash12(vec2f(kid, 41.0 + 7.0 * (s0 + 1.0))));
  let glass = mix(glassOld, glassNew, smoothstep(0.0, 1.0, sN - s0));
  // Colour scheme of this tunnel state: two hue families in alternating sectors, the accent's
  // distance round the wheel set by the state, turned a step round the tunnel behind every kick.
  let cw = dz_dw(cell.x, cell.y, L);
  let acc = smoothstep(-0.3, 0.3, cos(3.0 * cw.y - 1.6 * hState));
  let rot = acc * (0.38 + 0.08 * fract(hue0 * 5.7));
  let hue = hue0 + 0.25 * (0.5 + 0.5 * sin(cw.y * 2.0 + cw.x)) + 0.12 * h;
  var alb = dz_col(hue, 0.3, rot);
  let noteCol = dz_col(hue0 + 0.25 + 3.0 * pNew, 0.45, -0.08);
  alb = mix(alb, noteCol, 0.8 * smoothstep(0.15, 0.45, Hn) * (1.0 - 0.6 * acc));

  // The tunnel wall facing the light is brighter (a cylinder lit from one side).
  let l2 = normalize(vec2f(-0.6 * ls, 0.8));
  let radial = normalize(z - b + vec2f(1e-5, 0.0));
  let wl = 0.4 + 0.6 * sat(0.5 + 0.7 * dot(-radial, l2));

  // Top face: a bevelled lacquer or glass tile; normal from the nearest edge, turned to the screen.
  // The bevel of each tile: re-cut by every high note (eased by its strength), so the high end
  // reworks the finest relief tile by tile.
  let bevR = dz_recut(cell, L, 61.0);
  let bev = (0.07 + 0.32 * mix(fract(hue0 * 3.1), bevR, 0.75)) * inr;
  let ed = cl.edge;
  let hgt = smoothstep(gapW, gapW + bev, ed);
  let slope = (1.0 - hgt) * hgt * 4.0 / max(bev / inr, 0.05);
  let enS = rot2(argJ + atan2(L.e1.y, L.e1.x)) * cl.en;
  // Fine facets: on the tiles the high notes split, each triangle tilts its own way, so the facet
  // set re-forms the lit micro relief (eased with the note that chose it).
  let facet = max(fam.z, 0.8 * dz_facet(cell, L));
  let sec = dz_sector(cl.pv, L.tau);
  let fa = hash12(vec2f(kid + sec * 0.37, 29.0)) * TAU;
  let tilt = rot2(argJ) * vec2f(cos(fa), sin(fa)) * 0.9 * dz_facet(cell, L) * hgt;
  let nrm = normalize(vec3f(enS * slope * 0.8 + tilt, 1.0));
  let ld = normalize(vec3f(l2 * 0.7, 0.7));
  let hv = normalize(ld + vec3f(0.0, 0.0, 1.0));
  let dif = 0.3 + 0.7 * max(dot(nrm, ld), 0.0);
  let spc = pow(max(dot(nrm, hv), 0.0), 50.0);
  let fres = pow(1.0 - nrm.z, 2.0);
  let lift = 0.4 + 0.6 * Hn;
  // The seams lean toward the current note colour too (it moves with each note by its strength).
  let seamCol = mix(dz_col(hue0 + 0.4 + 0.3 * h, 0.55, 0.38 - rot), noteCol * 1.3, 0.4);
  var top = (alb * (0.008 + 0.05 * dif) * wl + dz_col(hue + 0.2, 0.5, rot) * fres * 0.6) * lift + mix(vec3f(0.6), alb * 2.0, 0.5) * spc * 0.5;
  // A crisp lit rim just inside each tile's edge (light lines, never murk).
  let rimD = abs(ed - gapW - bev * 0.5);
  top += mix(seamCol, alb * 2.0, 0.5) * (0.15 + 1.0 * Hn * Hn) * sat(1.0 - rimD / max(fw * 1.2, 1e-4)) * min(1.0, bev * 0.15 / max(fw, 1e-4)) * (1.0 - glass);
  // Triangle family: the tile top is split into triangles by thin dark seams.
  let triD = dz_tri(cl.pv, L.tau);
  // The high notes split a changing set of tiles into fine facets too.
  top *= 1.0 - facet * sat((gapW * 0.6 - triD) / fw + 0.5) * 0.85;
  // Truchet family: a maze of glossy neon arcs over low relief.
  let txy = cl.xy;
  let tc = floor(txy);
  var tu = fract(txy) - 0.5;
  if (hash12(vec2f(dz_kid(tc + vec2f(0.0, floor(L.s)), L), 17.0)) > 0.5) { tu.x = -tu.x; }
  let tdist = min(abs(length(tu - vec2f(0.5)) - 0.5), abs(length(tu + vec2f(0.5)) - 0.5));
  let tw = 0.06 + 0.06 * (0.5 + 0.5 * sin(S.p[3].z * 1.3 + 1.0));
  let tcov = sat((tw - tdist) / fw + 0.5);
  let tprof = sqrt(sat(1.0 - (tdist / tw) * (tdist / tw)));
  let tube = alb * (0.25 + 0.9 * tprof) + vec3f(0.5) * pow(tprof, 12.0) * 0.8;
  let core = sat(ed / max(gapW + bev * 2.0, 1e-3));
  let glw = dz_col(hue, 0.3, 0.42 - rot) * (0.35 + 0.6 * core) + vec3f(0.6) * spc * 0.5;
  top = mix(top, glw, glass);
  top = mix(top, tube, fam.w * tcov);
  // Near face of the block: darker, rising from shadow at the wall to a lit lip under the top.
  var side = alb * (0.01 + 0.07 * vfrac * vfrac) * wl + mix(alb, dz_col(hue + 0.2, 0.5, rot), 0.5) * 0.35 * smoothstep(0.85, 1.0, vfrac);
  side = mix(side, alb * (0.15 + 0.35 * vfrac), glass);
  // The wall between blocks: dark, with a neon seam glowing up out of the gap; every fourth ring
  // boundary is a major seam (large structure over fine detail).
  let major = select(0.0, 1.0, floor(cell.y / 4.0) != floor((cell.y + cl.nij.y) / 4.0));
  let lw = gapW * (0.3 + 0.35 * major);
  let seamCov = sat((lw - abs(ed) + 0.5 * fw) / fw) * min(1.0, 2.0 * lw / fw);

  // Fronts: hot heads, embers, crackle, note glow.
  // Every burst swells in, and each front fades out as a whole before its run ends.
  let heat = 0.7 * kLv * dz_burst(bK, 0.18, 5.0) * exp(-kA * 1.5) * (1.0 - smoothstep(0.45, 0.7, kA));
  let emb = kLv * dz_burst(bK, 0.15, 3.0) * step(0.82, h2) * exp(-kA * 0.5) * (1.0 - smoothstep(0.45, 0.7, kA));
  let sh = 2.2 * sLv * dz_burst(bS, 0.12, 8.0) * exp(-sA * 1.8) * (1.0 - smoothstep(0.24, 0.38, sA));
  let lh = 1.0 * lLv * dz_burst(bL, 0.15, 5.0) * exp(-lA * 2.5) * (1.0 - smoothstep(0.22, 0.36, lA));
  let sCol = mix(dz_col(hue0 + 0.55, 0.8, 0.38), vec3f(0.3, 0.55, 0.9), 0.3);
  let burn = dz_fire(heat) * (0.03 + 0.35 * smoothstep(0.35, 0.7, Hn)) + dz_fire(0.3) * emb * 0.25 + noteCol * lh * 0.6;
  top += burn;
  side += burn * 0.6;
  let seam = seamCol * (0.6 + 1.3 * major + 3.0 * sh) + dz_fire(heat) * 2.5 + sCol * sh * 2.0 + noteCol * lh * 2.5;
  let floorCol = seam * seamCov + alb * 0.015;

  var col: vec3f;
  if (isTop && Hc > 0.0) {
    // Tile edges: box-filtered against the near face (or the wall where the block is flat).
    let tileCov = sat((ed - gapW) / fw + 0.5);
    col = mix(select(floorCol, side, Hn > 0.2), top, tileCov);
  } else if (Hc > 0.0) {
    col = side;
  } else {
    col = floorCol + tube * fam.w * tcov * 0.5;
  }
  // The portal ring where the next tunnel is arriving: a ragged neon border in its colour.
  let rbw = S.p[0].w + 0.18 * sin(wh.y * 3.0 + S.p[0].w * 2.0) + 0.1 * sin(wh.y * 7.0 - S.p[0].w * 3.0);
  let pw = jac * 2.0 / max(F.res.y, 540.0);
  col += dz_col(dz_lat(1u).hue + 0.1, 0.9, 0.0) * exp(-abs(wh.x - rbw) / max(pw * 2.5, 0.004)) * 0.7;
  // Depth: the tunnel darkens into fog toward the vanishing point; unresolvable tiles fade into the
  // fog's glow.
  let fogCol = dz_col(hue0 + 0.6, 0.06, 0.0);
  let fogK = 1.0 - exp(-max(depth - 0.4, 0.0) * 0.45);
  col = mix(col * detail + fogCol * (1.0 - detail), fogCol, fogK);
  col *= S.p[4].w - 4.0 * floor(S.p[4].w * 0.25);
  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.3 * max(pk - 0.9, 0.0));
  return vec4f(col, 1.0);
}
`,
});
