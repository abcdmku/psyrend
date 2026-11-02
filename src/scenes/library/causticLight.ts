import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Caustic Light: a web of bright caustic filaments on black, in two coloured layers at different
 * depths and scales. Each layer is light refracted through its own wave surface (three plane waves
 * per layer). For a surface height h, the refraction map from the surface to the floor is
 * R(x) = x + D grad h(x), so its Jacobian is J = I + D Hess h, and the light density is 1/|det J|.
 * Each wave's Hessian is analytic, so det J costs a few cosines per pixel and needs no inversion.
 * det J = 0 on the fold curves, where the density diverges. That is the caustic network.
 *
 * Brightness is normalised to the pixel footprint (fwidth of det J), so a filament is about a pixel
 * wide at full strength, fades as 1/distance, and is anti-aliased without any blur. The fold lines
 * are the same at every resolution.
 *
 * Wave param per slot: (direction, wavenumber, curvature Q = depth * slope * wavenumber, phase).
 * The CPU keeps the phases (they only move forward, so the network glides), eases the melody's
 * direction offsets, and commits each beat's phase step at once. The shader holds the part of the
 * floor a front hasn't reached yet on the old phase, so the step is swept in behind the front.
 *  - morph: wave directions, wavenumbers, slopes and both layer depths follow the morph (new network
 *    each phrase); the base flow advances the phases.
 *  - kick: steps the next coarse-layer wave's phase for good and ignites a hot radial front from a
 *    golden-angle origin along the brightest filaments, with embers behind it.
 *  - snare: steps a fine-layer wave's phase, and a linear front sweeps across at a new angle, re-tinting
 *    one layer behind it (the layers take alternate hue steps).
 *  - melody: each note sets one wave's direction from its pitch (eased over about 50 ms and held), and
 *    a note-coloured front sweeps in from the left edge at the note's height.
 *  - drops: the phase speed rushes with the surge.
 * Every step, re-tint, turn and front light scales with its event's level squared (which carries how
 * loud the passage is), so a faint intro motif barely turns one wave and sends a dim front, while a
 * full-mix hit re-forms the network behind a bright one.
 *
 * DNA: 0 start, 1-6 wave start phases.
 */

const TAU = Math.PI * 2;
/** Phase steps per kick and per snare, in radians. The shader uses the same values (CL_KICK_STEP, CL_SNARE_STEP). */
const KICK_STEP = 1.9;
const SNARE_STEP = 1.2;

const morph = new Morph(0.8);
const st = {
  seed: -1,
  kicks: 0,
  snares: 0,
  notes: 0,
  ph: new Float64Array(6),
  off: new Float64Array(6),
  offT: new Float64Array(6),
  /** The layers' lasting hue steps (all but the latest snare's), and the latest snare's level squared. */
  hue: [0, 0],
  sLv: 0,
};
const sq = (x: number) => Math.min(1, x * x);

const SHADER = /* wgsl */ `
const CL_KICK_STEP: f32 = 1.9;
const CL_SNARE_STEP: f32 = 1.2;
const CL_KPX: f32 = 0.8;
const CL_CAP: f32 = 1.2;
// The 1/|det| tail is cut at a small threshold, so filaments end crisply and the dark field stays dark.
const CL_TAIL: f32 = 0.12;
// The fine layer's folds are small on screen, so it carries less light per pixel; lift it to read as a layer.
const CL_GAIN_FINE: f32 = 1.2;

// Saturated hue with its brightness evened out across the circle (a pure blue is far darker than green).
fn cl_hue(h: f32) -> vec3f {
  let c = hsv2rgb(vec3f(fract(h), 0.92, 1.0));
  return c * pow(0.45 / max(luma(c), 0.06), 0.5);
}

// Event ages with each event's level squared in hundredths above them (age < 10).
fn cl_age(v: f32) -> f32 { return v - 10.0 * floor(v / 10.0); }
fn cl_lv(v: f32) -> f32 { return floor(v / 10.0) * 0.01; }
// Ragged jitter for a front: the stripe of wave w that y lies on gets its own delay.
fn cl_jag(y: vec2f, w: i32, salt: f32) -> f32 {
  let P = S.p[w];
  let s = floor((P.y * dot(vec2f(cos(P.x), sin(P.x)), y) + P.w) / TAU);
  return hash11(s * 0.731 + salt);
}

// Kick: a radial front from a golden-angle origin. h > 0 behind the front (floor units).
fn cl_kickH(y: vec2f, w: i32) -> f32 {
  let kn = S.p[7].y;
  let ka = kn * 2.39996 + F.seed * TAU;
  let o = 0.45 * sqrt(fract(kn * 0.618034)) * vec2f(cos(ka), sin(ka));
  return cl_age(S.p[7].x) * 5.0 - length(y - o) - 0.12 * cl_jag(y, w, kn * 3.1);
}

// Snare: a linear front sweeping across at a new angle each time.
fn cl_snareH(y: vec2f, w: i32) -> f32 {
  let sn = S.p[7].w;
  let sa = sn * 1.94 + F.seed * 6.0;
  let n = vec2f(cos(sa), sin(sa));
  return cl_age(S.p[7].z) * 7.0 - 1.2 - dot(y, n) - 0.06 * cl_jag(y, w, sn * 1.7);
}

// The note's pitch (-1..1) and the layers' lasting hue steps (thousandths above the pitch / brightness).
fn cl_pitch() -> f32 { return fract(S.p[6].z) * 4.0 - 1.0; }
fn cl_hueA() -> f32 { return floor(S.p[6].w) * 0.001; }
fn cl_hueB() -> f32 { return floor(S.p[6].z) * 0.001; }
// Melody: a note-coloured front from the left edge, at the note's height.
fn cl_noteH(y: vec2f) -> f32 {
  let on = vec2f(-0.95, 0.4 * cl_pitch());
  let d = y - on;
  return cl_age(S.p[6].x) * 6.0 - length(d) - 0.05 * hash11(floor(atan2(d.y, d.x) * 6.0) + S.p[6].y * 2.3);
}

// Phase offset of wave w at y. The latest kick and snare have already been committed by the CPU, so the
// floor the front hasn't reached yet is held on the old phase.
fn cl_off(y: vec2f, w: i32) -> f32 {
  var o = 0.0;
  let kN = S.p[7].y;
  let sN = S.p[7].w;
  if (kN >= 1.0 && w == i32(fmod(kN - 1.0, 3.0))) {
    o -= CL_KICK_STEP * cl_lv(S.p[7].x) * (1.0 - smoothstep(-0.02, 0.02, cl_kickH(y, w)));
  }
  if (sN >= 1.0 && w == 3 + i32(fmod(sN - 1.0, 3.0))) {
    o -= CL_SNARE_STEP * cl_lv(S.p[7].z) * (1.0 - smoothstep(-0.015, 0.015, cl_snareH(y, w)));
  }
  return o;
}

// det J of one layer's refraction map at floor point y: J = I + Hess h with
// Hess h = -sum_w Q_w cos(alpha_w) e_w e_w^T (Q already holds the depth).
fn cl_det(y: vec2f, base: i32) -> f32 {
  var hxx = 0.0;
  var hyy = 0.0;
  var hxy = 0.0;
  for (var i = 0; i < 3; i++) {
    let w = base + i;
    let P = S.p[w];
    let ex = cos(P.x);
    let ey = sin(P.x);
    let c = P.z * cos(P.y * (ex * y.x + ey * y.y) + P.w + cl_off(y, w));
    hxx -= c * ex * ex;
    hyy -= c * ey * ey;
    hxy -= c * ex * ey;
  }
  return (1.0 + hxx) * (1.0 + hyy) - hxy * hxy;
}

// Light density 1/|det J|, normalised to the pixel footprint w = fwidth(det J): about one pixel wide at
// full strength, falling as 1/distance, clamped at the core and cut at the tail threshold.
fn cl_dens(d: f32, w: f32) -> f32 {
  let ww = max(w, 1e-6);
  return max(min(CL_KPX * ww / max(abs(d), 0.5 * ww), CL_CAP) - CL_TAIL, 0.0);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let y = (uv - 0.5) * vec2f(F.aspect, 1.0);
  let dA = cl_det(y, 0);
  let dB = cl_det(y, 3);
  let IA = cl_dens(dA, fwidth(dA));
  let IB = CL_GAIN_FINE * cl_dens(dB, fwidth(dB));

  // Event state.
  let kN = S.p[7].y;
  let sN = S.p[7].w;
  let kV = select(0.0, 1.0, kN >= 1.0);
  let sV = select(0.0, 1.0, sN >= 1.0);
  let nV = select(0.0, 1.0, S.p[6].y >= 1.0);
  let kW = i32(fmod(max(kN - 1.0, 0.0), 3.0));
  let sW = 3 + i32(fmod(max(sN - 1.0, 0.0), 3.0));
  let hK = cl_kickH(y, kW);
  let hS = cl_snareH(y, sW);
  let hN = cl_noteH(y);

  // Layer hues: the snare re-tints one layer behind its front; the layers alternate steps, so they stay apart.
  let arrS = smoothstep(-0.015, 0.015, hS) * sV;
  let cS = i32(fmod(max(sN - 1.0, 0.0), 2.0));
  // Each re-tint is as large as its snare was strong (dS); the earlier ones are folded into cl_hueA/B.
  let dS = 0.2 * cl_lv(S.p[7].z);
  let hueA = F.seed + cl_hueA() + select(0.0, arrS * dS, cS == 0);
  let hueB = F.seed + 0.42 + cl_hueB() + select(0.0, arrS * dS, cS == 1);
  let hueSNew = select(F.seed + cl_hueA() + dS, F.seed + 0.42 + cl_hueB() + dS, cS == 1);

  var col = cl_hue(hueA) * IA + cl_hue(hueB) * IB;

  // Fronts only show on filaments. The hot edge is about 1 px at 720p and wider than a pixel at the
  // gate's thumbnails, so it reads, while the embers carry it behind.
  let fm = smoothstep(0.03, 0.3, IA + IB);
  let kA = cl_age(S.p[7].x);
  let kHot = exp(-abs(hK) / 0.012) * kV * cl_lv(S.p[7].x) * smoothstep(0.0, 0.08, kA);
  let kEmb = exp(-max(hK, 0.0) / 0.35) * exp(-kA / 0.7) * kV * cl_lv(S.p[7].x) * smoothstep(0.0, 0.08, kA);
  col += (vec3f(1.0, 0.82, 0.4) * kHot * 3.2 + vec3f(1.0, 0.4, 0.08) * kEmb * 1.5) * fm;

  let sA = cl_age(S.p[7].z);
  let sHot = exp(-abs(hS) / 0.012) * sV * cl_lv(S.p[7].z) * smoothstep(0.0, 0.08, sA);
  let sEmb = exp(-max(hS, 0.0) / 0.3) * exp(-sA / 0.5) * sV * cl_lv(S.p[7].z) * smoothstep(0.0, 0.08, sA);
  let sCol = cl_hue(hueSNew);
  col += (sCol * sHot * 2.6 + sCol * sEmb * 0.5) * fm;

  let hn = F.seed * 0.5 + 0.5 + cl_pitch() * 0.15 + S.p[6].y * 0.11;
  let nCol = cl_hue(hn);
  let nA = cl_age(S.p[6].x);
  let nL = cl_lv(S.p[6].x) * smoothstep(0.0, 0.1, nA);
  let nHot = exp(-abs(hN) / 0.02) * nV * nL;
  let nEmb = exp(-max(hN, 0.0) / 0.4) * exp(-nA / 0.6) * nV * nL;
  col += (mix(nCol, vec3f(1.0), 0.3) * nHot * 3.2 + nCol * nEmb * 2.0) * fm;

  col *= fract(S.p[6].w) * 2.0;
  // Where two layers overlap, the sum pales toward white: push the chroma back out, then limit the
  // brightest channel to 1 so the colour never washes to white.
  let lu = luma(col);
  col = max(vec3f(lu) + (col - vec3f(lu)) * 1.5, vec3f(0.0));
  let mx = max(col.r, max(col.g, col.b));
  col = col / max(1.0, mx);
  return vec4f(col, 1.0);
}
`;

export default raymarchScene({
  meta: {
    id: 'caustic-light',
    name: 'Caustic Light',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.55 },
    genres: { ambient: 0.9, edm: 0.9, techno: 0.7, synthwave: 0.8, pop: 0.7, lofi: 0.6, jazz: 0.5, classical: 0.6, dubstep: 0.6, dnb: 0.6, hiphop: 0.5, rock: 0.4 },
    trails: 0,
    sparse: true,
    kaleido: false,
    // Fails the gate: beat lifts sit at about 1.3-1.5 (bar 1.4-1.8) and hue count dips on some variants.
    auto: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);

    // A new cue, or a seek (the morph has reset its counts), starts the state again from the DNA.
    if (g[0] !== st.seed || morph.kicks < st.kicks || morph.snares < st.snares || morph.notes < st.notes) {
      st.seed = g[0];
      st.kicks = morph.kicks;
      st.snares = morph.snares;
      st.notes = morph.notes;
      for (let w = 0; w < 6; w++) {
        st.ph[w] = g[1 + w] * TAU;
        st.off[w] = 0;
        st.offT[w] = 0;
      }
      st.hue = [0, 0];
      st.sLv = 0;
    }

    // Beat events: commit each phase step (the shader holds the unreached floor on the old phase).
    if (morph.kicks !== st.kicks) {
      st.kicks = morph.kicks;
      st.ph[(st.kicks - 1) % 3] = (st.ph[(st.kicks - 1) % 3] + KICK_STEP * sq(morph.kickLevel)) % TAU;
    }
    if (morph.snares !== st.snares) {
      // Fold the previous snare's re-tint into its layer, then commit this one's step.
      if (st.snares >= 1) st.hue[(st.snares - 1) % 2] = (st.hue[(st.snares - 1) % 2] + 0.2 * st.sLv) % 1;
      st.snares = morph.snares;
      st.sLv = sq(morph.snareLevel);
      const w = 3 + ((st.snares - 1) % 3);
      st.ph[w] = (st.ph[w] + SNARE_STEP * st.sLv) % TAU;
    }
    if (morph.notes !== st.notes) {
      st.notes = morph.notes;
      // The note turns one wave toward its pitch's direction, as far as the note is strong.
      const w = (st.notes - 1) % 6;
      st.offT[w] += sq(morph.noteLevel) * (morph.notePitch * 1.6 - st.offT[w]);
    }

    // Shape from the morph's base coordinates (flowAt: no beat steps). Each parameter mixes two dimensions
    // so that every phrase carries the network somewhere new.
    const a = morph.flowAt;
    const q = (i: number) => a[i % 8] + 0.6 * a[(i * 3 + 1) % 8] + 0.37 * i;
    const depth = [wave(q(0), 0.03, 0.06), wave(q(1), 0.012, 0.03)];
    // The phase rushes with the bass and the surge of a drop.
    const rush = 1 + 2.2 * morph.surge;
    const speed = (0.09 + 0.12 * morph.drive) * (0.7 + 0.3 * morph.flow) * rush;
    const ease = 1 - Math.exp(-dt / 0.2);
    // Each layer's three waves sit 120 degrees apart, so their folds form a web, not stripes.
    const base = [wave(q(2), 0, TAU), wave(q(3), 0, TAU)];
    const Q = new Float64Array(6);
    const K6 = new Float64Array(6);
    for (let w = 0; w < 6; w++) {
      const L = w < 3 ? 0 : 1;
      K6[w] = wave(q(5 + 3 * w), L ? 60 : 28, L ? 92 : 44);
      Q[w] = depth[L] * wave(q(6 + 3 * w), 0.25, 0.55) * K6[w];
    }
    // Each layer's total curvature is eased toward a set level (partly, so depth still matters), so every
    // phrase fills the frame with a web of similar density rather than a bare lattice or a solid mesh.
    for (let L = 0; L < 2; L++) {
      const sum = Q[3 * L] + Q[3 * L + 1] + Q[3 * L + 2];
      const f = Math.pow(1.9 / Math.max(sum, 1e-3), 0.7);
      for (let w = 3 * L; w < 3 * L + 3; w++) Q[w] *= f;
    }
    for (let w = 0; w < 6; w++) {
      const L = w < 3 ? 0 : 1;
      const th = base[L] + (w % 3) * (TAU / 3) + wave(q(4 + 3 * w), -0.5, 0.5);
      st.ph[w] = (st.ph[w] + K6[w] * speed * dt) % TAU;
      st.off[w] += (st.offT[w] - st.off[w]) * ease;
      p[4 * w] = th + st.off[w];
      p[4 * w + 1] = K6[w];
      p[4 * w + 2] = Q[w];
      p[4 * w + 3] = st.ph[w];
    }

    // Event slots: note (age, count, pitch, brightness), kick and snare (age, count each). Each age
    // carries its event's level squared in hundredths above it; the pitch and the brightness carry the
    // layers' lasting hue steps in thousandths above them.
    const lv = (age: number, level: number) => Math.min(age, 9.99) + 10 * Math.round(sq(level) * 100);
    p[24] = lv(morph.leadAge, morph.noteLevel);
    p[25] = morph.notes;
    p[26] = Math.round(st.hue[1] * 1000) + (Math.max(-1, Math.min(1, morph.notePitch)) + 1) * 0.2499;
    p[27] = Math.round(st.hue[0] * 1000) + (0.85 + 0.35 * morph.flow) * 0.5;
    p[28] = lv(morph.kickAge, morph.kickLevel);
    p[29] = morph.kicks;
    p[30] = lv(morph.snareAge, st.sLv ** 0.5);
    p[31] = morph.snares;
  },
  wgsl: SHADER,
});
