import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';
import { Spring } from '../anim';

/**
 * Follows an event-driven target (a count, or a sum of steps): each change eases in by smoothstep over
 * `dur` seconds, from rest to rest, so it never snaps and leaves no tail however close the hits come.
 */
class Glide {
  x: number;
  private base: number;
  private target: number;
  private q: [number, number][] = [];
  constructor(x = 0, private dur = 0.6) {
    this.x = this.base = this.target = x;
  }
  update(target: number, dt: number): number {
    if (target !== this.target) this.q.push([0, target - this.target]);
    this.target = target;
    for (const e of this.q) e[0] += dt;
    while (this.q.length && this.q[0][0] >= this.dur) this.base += this.q.shift()![1];
    this.x = this.base;
    for (const [age, v] of this.q) {
      const t = age / this.dur;
      this.x += v * t * t * (3 - 2 * t);
    }
    return this.x;
  }
  reset(x = 0): void {
    this.x = this.base = this.target = x;
    this.q = [];
  }
}


const morph = new Morph(1.2);

/**
 * Lasting state the music writes into the flow. Every event-driven change eases in by smoothstep over
 * 0.6 s, about a beat (from rest to rest; the pitch follows on springs), and the fronts ride glides that follow the
 * event counts, so nothing snaps however close the hits come.
 */
const sp = (h = 0.2) => new Spring(0, h);
const st = {
  seed: -1,
  kicks: 0,
  snares: 0,
  notes: 0,
  k0: 0,
  s0: 0,
  l0: 0,
  xk: new Glide(),
  xs: new Glide(),
  xl: new Glide(),
  hue: new Glide(),
  hueT: 0,
  off: new Glide(),
  offT: 0,
  par: new Glide(),
  parT: 0,
  gam: [new Glide(), new Glide(), new Glide()],
  gamT: [0, 0, 0],
  row: [new Glide(), new Glide(), new Glide()],
  rowT: [0, 0, 0],
  kp: sp(),
  pc: sp(),
  pcT: 0,
  /** Pulse phase along the fibres: each kick and note pushes it on by its level. */
  pul: new Glide(),
  pulT: 0,
  /** The latest kick / snare / note levels, eased so a new event never snaps a front still burning. */
  kl: sp(0.06),
  sl: sp(0.06),
  nl: sp(0.08),
};

const fract = (x: number) => x - Math.floor(x);
const hash = (x: number) => fract(Math.sin(x * 127.1 + 311.7) * 43758.5453);

/**
 * Neon harmonics: light lines that are the streamlines of a 2D potential flow, laid on a floor and
 * a ceiling that run to a dark vanishing point (ref15, ref16). The stream function is a harmonic
 * function: a uniform stream plus three rows of point vortices, each row periodic along the flow
 * (psi = -G/4pi ln(sin^2(pi x/L) + sinh^2(pi y/L))), so the lines bend, braid and coil round the
 * vortices for ever as you travel down them. Each line is an iso-contour of psi, anti-aliased by
 * its screen-space derivative, with a core, a halo, and light pulses that run along it.
 *
 * Morph: the rows drift across the stream, their strengths and spacings breathe, and the view rolls
 * slowly, so the sheets of lines keep reshaping. Kick: a burn front runs down every line from the
 * lens, each fibre at its own pace, and the palette turns on. Snare: a front hops across the lines
 * from one fibre outward while every line slides onto a new streamline (alternate lines take a
 * second colour). Melody: the note re-tunes and nudges one vortex row, a front runs down the lines,
 * and the lines' hue, weight and the pitch of the light pulses glide to the note's pitch class (round
 * the circle of fifths), the pulses step along the fibres, and a bundle of lines at the pitch's place
 * holds the note's colour. Every change glides on a spring from rest: nothing snaps. Every step and
 * every front's light scales with its event's level, so a faint motif nudges a row and lights a
 * dim front, while a strong lead re-tunes it. Chords lean the shape (Morph).
 * Energy: pace and glow. Each vortex has a soft core (no bullseye rings), and finer streamlines fade
 * in where the flow opens up, so the light stays evenly dense.
 */
export default raymarchScene({
  meta: {
    id: 'neon-harmonics',
    name: 'Neon Harmonics',
    // Out of the show until fixed (gate: reactions do not register (lines finer than the gate render)).
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.55 },
    genres: { edm: 0.8, synthwave: 0.9, techno: 0.7, ambient: 0.8, pop: 0.6, dnb: 0.6, classical: 0.5, jazz: 0.5 },
    trails: 0,
    sparse: true,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const at = morph.at;

    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    // Pitch class round the circle of fifths (neighbouring keys get neighbouring colours).
    const fifths = (x: number) => fract((Math.round(x * 12 + 1200) % 12) * 7 / 12);
    if (g[0] !== st.seed || morph.kicks < st.kicks || morph.snares < st.snares || morph.notes < st.notes) {
      st.seed = g[0];
      st.kicks = st.k0 = morph.kicks;
      st.snares = st.s0 = morph.snares;
      st.notes = st.l0 = morph.notes;
      for (const q of [st.xk, st.xs, st.xl, st.off, st.par, st.pul, ...st.gam, ...st.row]) q.reset(0);
      st.pulT = 0;
      st.hueT = g[5];
      st.hue.reset(g[5]);
      st.offT = st.parT = 0;
      st.gamT = [0, 0, 0];
      st.rowT = [0, 0, 0];
      st.kp.reset(Math.round(morph.notePitch * 24));
      st.pcT = fifths(morph.notePitch);
      st.pc.reset(st.pcT);
    }
    if (morph.kicks > st.kicks) {
      st.kicks = morph.kicks;
      st.hueT += (0.22 + 0.1 * hash(st.kicks)) * morph.kickLevel ** 2;
      st.pulT += 0.3 * morph.kickLevel ** 2;
    }
    if (morph.snares > st.snares) {
      st.snares = morph.snares;
      // The lines slide onto new streamlines, and alternate lines take a second colour.
      st.offT += (0.5 + 0.4 * hash(st.snares * 3.3)) * morph.snareLevel ** 2;
      st.parT += 0.29 * morph.snareLevel ** 2;
    }
    if (morph.notes > st.notes) {
      st.notes = morph.notes;
      // The note re-tunes one vortex row (by its pitch class) and nudges it across the stream; a row
      // is pushed toward a moderate strength so it never runs away.
      const j = Math.round((((morph.notePitch * 12) % 12) + 12) % 12) % 3;
      const cur = st.gamT[j];
      // By the note's strength: a faint note nudges the row, a strong one re-tunes it.
      const dG = (Math.abs(cur) > 0.4 ? -Math.sign(cur) : morph.notes % 2 ? 1 : -1) * (0.7 + 0.2 * Math.abs(morph.notePitch)) * morph.noteLevel ** 2;
      st.gamT[j] += dG;
      st.rowT[j] += dG * 1.6;
      const pc = fifths(morph.notePitch);
      st.pcT += (pc + Math.round(st.pcT - pc) - st.pcT) * morph.noteLevel ** 2;
      st.pulT += 0.382 * morph.noteLevel ** 2;
    }
    const xk = st.xk.update(morph.kicks - st.k0, dt);
    const xs = st.xs.update(morph.snares - st.s0, dt);
    const xl = st.xl.update(morph.notes - st.l0, dt);
    const row = st.row.map((q, i) => q.update(st.rowT[i], dt));
    const gam = st.gam.map((q, i) => q.update(st.gamT[i], dt));

    const L = 3.2 + 2.5 * g[2];
    p[0] = morph.travel * 1.0;
    p[1] = g[1] * Math.PI + 0.3 * Math.sin(at[7] * 0.5 + g[3] * 6);
    p[2] = 1;
    p[3] = wave(at[6] * 0.7, 0.6, 1.1);
    // Row positions: the morph's drift plus where the melody has nudged each row.
    p[4] = 1.6 * Math.sin(at[0] * 0.8 + g[1] * 6) + row[0];
    p[5] = 2.4 * Math.sin(at[1] * 0.7 + g[2] * 6) + row[1];
    p[6] = 3.2 * Math.sin(at[2] * 0.6 + g[3] * 6) + row[2];
    p[7] = 0.1 + 0.05 * g[4];
    p[8] = L * (wave(at[3], 0.2, 0.55) * (g[6] < 0.5 ? 1 : -1) + gam[0]);
    p[9] = L * (wave(at[4], -0.5, 0.5) + gam[1]);
    p[10] = L * (wave(at[5], 0.15, 0.5) * (g[7] < 0.5 ? -1 : 1) + gam[2]);
    p[11] = L;
    p[12] = xk;
    p[13] = st.hue.update(st.hueT, dt);
    p[14] = st.pul.update(st.pulT, dt);
    p[15] = morph.travel * 0.4;
    p[16] = xs;
    p[17] = st.off.update(st.offT, dt);
    p[18] = 20 * Math.sin(xs * 2.3);
    p[19] = st.kl.update(morph.kickLevel ** 2, dt);
    p[20] = xl;
    p[21] = st.kp.update(Math.round(morph.notePitch * 24), dt);
    p[22] = st.sl.update(morph.snareLevel ** 2, dt);
    p[23] = st.nl.update(morph.noteLevel ** 2, dt);
    p[24] = 0;
    p[25] = st.pc.update(st.pcT, dt);
    p[26] = 0;
    p[27] = (0.8 + 0.25 * ctx.intensity) * (0.85 + 0.25 * m.energy);
    p[28] = 1.3 + 2 * g[4];
    p[29] = 1.15;
    p[30] = st.par.update(st.parT, dt);
    p[31] = Math.min(xl, 1) * p[23];
  },
  wgsl: /* wgsl */ `
fn nh_hash(x: f32) -> f32 { return fract(sin(x * 91.17 + 3.1) * 43758.5453); }

// ln |sin(pi (a + i b) / L)|^2, stable far from the row.
fn nh_lnsin(a: f32, b: f32, L: f32) -> f32 {
  let u = PI * a / L;
  let v = PI * abs(b) / L;
  let s = sin(u);
  let sh = sinh(min(v, 9.0));
  // The 0.06 gives each vortex a soft core (Rankine-like): a smooth swirl, no bullseye of rings.
  return select(log(s * s + sh * sh + 0.06), 2.0 * v - 1.3863, v > 9.0);
}

// Stream function at plane coords (d along the stream, y across).
fn nh_psi(d: f32, y: f32, side: f32) -> f32 {
  let L = S.p[2].w;
  let U = S.p[0].w;
  var psi = U * y;
  var per = array<f32, 3>(1.0, 1.618, 0.77);
  for (var k = 0; k < 3; k++) {
    let G = S.p[2][k];
    let yk = S.p[1][k] + side * S.p[7].x;
    let Lk = L * per[k];
    let dk = f32(k) * 1.37 * L + side * 0.5 * L;
    psi -= G / (4.0 * PI) * nh_lnsin(d - dk, y - yk, Lk);
  }
  return psi;
}

// Phase fronts. x follows an event count, each event easing in by smoothstep over 0.6 s (about a beat) (from rest, one unit per
// event, however close the events come); tau in [0, 0.5] the point's arrival fraction. Returns u, how
// far the front has gone past (0..1, at least 0.5 at rest). Continuous in x, so nothing can snap.
fn nh_u(x: f32, tau: f32) -> f32 { return fract(x - tau); }
// A soft bump on 0 < u < h: the glow at the front.
fn nh_bump(u: f32, h: f32) -> f32 { let s = sin(PI * min(u / h, 1.0)); return s * s; }
fn nh_tau(t: f32) -> f32 { return 0.5 * (1.0 - exp(-t / 0.6)); }

// The front's light: a hot head that swells and fades as it passes, cooling to a faint ember.
fn nh_fire(u: f32, hot: vec3f, cool: vec3f) -> vec3f {
  let h = nh_bump(u, 0.45);
  return mix(cool, hot, h) * h * 0.9 + cool * nh_bump(u, 0.5) * 0.08;
}

fn nh_col(h: f32, lum: f32) -> vec3f {
  let wheel = cosPal(h, vec3f(0.5), vec3f(0.5), vec3f(1.0), vec3f(0.0, 0.33, 0.67));
  let c = mix(pal(h), wheel, 0.65);
  return c * (lum / max(luma(c), 0.02));
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  var q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  q = rot2(S.p[0].y) * q;
  let focal = S.p[7].y;
  let h = S.p[0].z;
  let side = select(-1.0, 1.0, q.y > 0.0);
  let ay = max(abs(q.y), 1e-3);
  // Floor (below) and ceiling (above): depth and lateral position on the plane.
  let z = h * focal / ay;
  let y = q.x * z / focal;
  let d = z + S.p[0].x;

  let spacing = S.p[1].w;
  let xk = S.p[3].x;
  let xs = S.p[4].x;
  let xl = S.p[5].x;

  // The structure: every lasting change (row strengths and places, the snare's slide onto new
  // streamlines) arrives through springs, so the lines glide.
  let psi = nh_psi(d, y, side);
  let s = (psi + S.p[4].y) / spacing;
  let fw = max(fwidth(s), 1e-4);
  let k = floor(s + 0.5);
  let r0 = nh_hash(k * 0.731 + side * 17.0);

  // Fronts run along the fibres. Kick: from the lens down every line, each at its own pace. Snare: hops
  // across the lines from one (drifting) fibre outward. Melody: down the lines from the lens.
  let uk = nh_u(xk, nh_tau(z / 25.0 * (0.8 + 0.4 * r0) + 0.06 * r0));
  let us = nh_u(xs, nh_tau(abs(s - S.p[4].z) * 0.05 + z * 0.02 + 0.06 * nh_hash(k * 1.91 + 3.0)));
  let um = nh_u(xl, nh_tau(z / 20.0 + 0.05 * nh_hash(k * 2.37 + 7.0)));

  let dl = abs(s - k);
  let dpx = dl / fw;
  let near = exp(-z * 0.12);
  // Line weight and the pitch of the light pulses follow the note's pitch class (round the circle of
  // fifths), gliding to each new note.
  let pc = S.p[6].y;
  let wpx = (0.5 + 1.5 * near) * (1.0 + 0.6 * sin(pc * TAU));
  let fade = sat(fw * 2.6 - 0.3);
  let core = sat(wpx + 0.5 - dpx);
  let halo = exp(-dpx / (2.5 + 5.0 * near)) * 0.3;
  let avg = min(1.0, fw * (2.0 * wpx + 1.5 * (2.5 + 5.0 * near)));
  // A line level grazing a vortex's soft core makes a tiny ring (a dot): dim lines whose
  // neighbours are hundreds of pixels away.
  let lone = 1.0 - 0.75 * smoothstep(160.0, 420.0, 1.0 / fw);
  var lineI = mix(core + halo, avg * 0.16, fade) * lone;
  // Where the flow opens up and lines spread apart on screen, finer streamlines fade in between
  // them (half, then quarter spacing), so the sheet keeps an even density of light.
  let gap = 1.0 / fw;
  for (var o = 1; o <= 2; o++) {
    let m = f32(1 << u32(o));
    let so = s * m;
    let ko = floor(so + 0.5);
    let fresh = step(0.25, abs(fract(ko / m + 0.5) - 0.5) * 2.0);
    let dpo = abs(so - ko) / (fw * m);
    let wo = smoothstep(18.0, 40.0, gap / m * 2.0) * fresh;
    lineI += (sat(wpx * 0.8 + 0.5 - dpo) + exp(-dpo / 3.0) * 0.2) * wo * 0.55;
  }

  // Light running along each line; kicks and notes step the pulses along the fibres.
  let rk = nh_hash(k * 0.917 + side * 5.0);
  let pph = z * (0.13 + 0.06 * sin(pc * TAU));
  // Kicks and notes push the pulses on along the fibres, with the flow.
  let pulse = 0.5 + 0.5 * cos(TAU * (pph + rk - S.p[3].z) - S.p[3].w * 2.0);
  // Band-limit the pulses: where they would alias (near the horizon) they flatten to their mean.
  let pAA = sat(fwidth(pph) * 3.0 - 0.2);
  let flowI = mix(0.45 + 0.55 * pulse * pulse, 0.65, max(fade, pAA));

  // Colour: lines in hue families; kicks turn the palette, snares recolour alternate lines, the
  // melody's bundle (at the pitch's line) holds the note's colour.
  let parity = fract(k * 0.5) * 2.0 * (1.0 - fade);
  var hue = S.p[3].y + 0.4 * pc + (0.05 * k + 0.08 * rk) * (1.0 - fade) + 0.22 * side + 0.03 * y + S.p[7].z * parity;
  let hasNote = S.p[7].w;
  let bundle = exp(-pow((k - S.p[5].y) / 5.0, 2.0)) * hasNote * (1.0 - fade);
  let glow = S.p[6].w;
  var col = nh_col(hue, 0.3) * lineI * flowI * glow;
  col = mix(col, nh_col(pc + 0.5, 0.6) * lineI * glow, bundle * 0.85);

  // Fronts burn along the lines.
  let onL = core + halo * 1.5;
  // Each front burns as bright as its event was strong (the levels in S.p[4].w, S.p[5].z, S.p[5].w).
  col += nh_fire(uk, vec3f(1.0, 0.85, 0.6), vec3f(1.0, 0.35, 0.08)) * onL * min(xk, 1.0) * S.p[4].w * 1.8 * (1.0 - fade);
  col += nh_fire(us, vec3f(0.7, 0.9, 1.0), nh_col(hue + 0.5, 0.6)) * onL * min(xs, 1.0) * S.p[5].z * 1.6 * (1.0 - fade);
  let lc = nh_col(pc + 0.5, 0.9);
  col += nh_fire(um, mix(lc, vec3f(1.0), 0.4), lc) * onL * exp(-pow((k - S.p[5].y) / 5.0, 2.0)) * hasNote * 2.4 * (1.0 - fade);

  // Depth: the sheets run into a dark vanishing band.
  col *= exp(-z * 0.085) * smoothstep(0.03, 0.16, ay);
  col += nh_col(S.p[3].y + 0.6, 0.01) * exp(-ay * 6.0);
  col = col / (1.0 + 1.2 * max(col.r, max(col.g, col.b)));
  return vec4f(col, 1.0);
}
`,
});
