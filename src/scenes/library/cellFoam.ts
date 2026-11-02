import { raymarchScene } from '../raymarchScene';
import { Morph, wave } from '../morph';

const morph = new Morph(1.3);

/**
 * Burns of one kind of event. A new burn is lit only once the current one is `gap` seconds old: by
 * then its lasting change has reached every wall and its light is gone (see the shader's fades),
 * so a beat never cuts a burn off; events in between merge into the burn already running.
 */
class Fronts {
  private n = -1;
  private t = -99;
  count = 0;
  age = 99;
  constructor(private readonly gap: number) {}
  update(events: number, now: number, eventAge: number, reset: boolean, lit: () => void): void {
    if (reset || this.n < 0 || events < this.n) this.t = -99;
    else if (events > this.n && now - eventAge - this.t >= this.gap) {
      this.t = now - eventAge;
      this.count++;
      lit();
    }
    this.n = events;
    this.age = Math.min(now - this.t, 99);
  }
}
const kickF = new Fronts(0.4);
const snareF = new Fronts(0.6);
const noteF = new Fronts(0.6);

/** Held-note glow and where (along the path) each latest burn was lit. Reset on seeks. */
const st = { t: -1, held: 0, heldV: 0, gain: 0, gainV: 0, pitch: 0, zK: -99, zS: -99, zL: -99, lvK: 0, lvS: 0, lvL: 0, accK: 0, accS: 0, accL: 0 };
/** Burn age (< 128 s) packed with the burn's strength (64 steps): age + 128 * level step. */
const packAge = (age: number, lv: number) => Math.min(age, 99) + 128 * Math.max(0, Math.min(63, Math.round(lv * 63)));

/** Camera path through the foam, in cell units (the shader's cf_path matches it). */
const path = (z: number): number[] => [Math.sin(z * 0.19) * 1.5 + Math.sin(z * 0.067 + 1.1) * 1.1, Math.cos(z * 0.15) * 1.0 + Math.sin(z * 0.043) * 0.6, z];

/**
 * Flight through an open foam of glassy, iridescent films, traced exactly: the ray walks a 3D
 * Voronoi diagram cell by cell and meets each flat film analytically. Every site orbits on its own
 * phase, so the cells keep re-forming around you. Each film is a soap film with vivid interference
 * colours, bowed slightly so its reflections flow, and it bends the ray a little as it passes (so
 * the foam behind wavers like glass). The Plateau borders, where three films meet, are fine lit
 * glass threads. Far cells sink into a coloured haze.
 *
 * The form is a morph coordinate set: 0 how irregular the cells are, 1-3 how they stretch or
 * flatten along each axis, 4 the site flow (walls sliding and re-forming), 5 film thickness,
 * 6 border width, 7 how strongly the films refract and reflect.
 *
 * Beats ignite burns that spread through the foam cell by cell: each cell catches after a ragged
 * delay (its distance from the spark plus a random lag), the fire runs first along a wall's
 * borders and then creeps in across the film from its edges, so the front branches through the
 * foam like fire through steel wool. A hot rim (white, yellow, orange) leaves embers along the
 * borders that cool, and behind it the walls keep a new state:
 *  - kick: lit a little way ahead; burned films take new interference colours (a thicker film);
 *  - snare: a fast crackle that runs only along the borders, in a cool second colour; behind it a
 *    new set of borders glows;
 *  - melody: a slow glow of the note's colour; behind it the films lean toward that colour.
 * Energy sets the flow and the flight (steady, easing only in long quiet). Chords turn the hue.
 *
 * DNA: 0 seed and light direction, 1 start, 2 roll, 3 palette offset, 4 light (backlight / two
 * glows), 6 fog depth, 7 lens.
 */
export default raymarchScene({
  meta: {
    id: 'cell-foam',
    name: 'Cell Foam',
    // Out of the show until fixed (gate: one hue, snaps, snare/melody do not register).
    auto: false,
    energy: [0.05, 0.85],
    mood: { valence: 0.6, arousal: 0.4 },
    genres: { ambient: 1, edm: 0.6, pop: 0.7, classical: 0.8, lofi: 0.5, jazz: 0.4, synthwave: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const reset = st.t < 0 || Math.abs(m.time - st.t - dt) > 0.5;
    if (reset) {
      st.held = m.leadHeld;
      st.heldV = 0;
      st.gain = ctx.intensity;
      st.gainV = 0;
      st.zK = st.zS = st.zL = -99;
    }
    st.t = m.time;
    // The held-note glow glides on a critically damped spring: up over about 0.4 s, down over about 0.8 s.
    // It follows the held note scaled by how loud the passage is, so a faint motif barely glows.
    const heldT = m.leadHeld * morph.presence;
    const w = heldT > st.held ? 12 : 6;
    const e = Math.exp(-w * dt);
    const d = st.held - heldT;
    const c = st.heldV + w * d;
    st.heldV = (st.heldV - w * c * dt) * e;
    st.held = heldT + (d + c * dt) * e;
    // The director's intensity jumps at a drop: the glow gain glides to it instead.
    const eg = Math.exp(-6 * dt);
    const dg = st.gain - ctx.intensity;
    const cg = st.gainV + 6 * dg;
    st.gainV = (st.gainV - 6 * cg * dt) * eg;
    st.gain = ctx.intensity + (dg + cg * dt) * eg;

    // Anisotropy of cell space (product 1): cells stretch into prisms or flatten into plates.
    const ax = Math.exp(wave(a[1], -0.33, 0.33));
    const ay = Math.exp(wave(a[2], -0.33, 0.33));
    const az = Math.exp(wave(a[3], -0.3, 0.3));
    const an = Math.cbrt(ax * ay * az);
    const aniso = [ax / an, ay / an, az / an];

    // Camera: steady travel along a winding path in cell space.
    const z = morph.travel * 2.3 + g[1] * 40;
    const ro = path(z);
    const ta = path(z + 2.6);
    // Each burn is lit at a point on the path ahead, fixed in the foam (the camera flies on past).
    // Each keeps its hit's strength: its light and the lasting step it leaves scale with it (the
    // lasting states are level-weighted counts), so a faint note is a faint glow and a small tint.
    kickF.update(morph.kicks, m.time, morph.kickAge, reset, () => {
      st.zK = z + 2.6;
      st.lvK = morph.kickLevel;
      st.accK += st.lvK;
    });
    snareF.update(morph.snares, m.time, morph.snareAge, reset, () => {
      st.zS = z + 2.2;
      st.lvS = morph.snareLevel;
      st.accS += st.lvS;
    });
    noteF.update(morph.notes, m.time, morph.leadAge, reset, () => {
      st.zL = z + 2.4;
      st.pitch = morph.notePitch;
      st.lvL = morph.noteLevel;
      st.accL += st.lvL;
    });
    // World-space forward (cell space divided by the anisotropy).
    const fw = [(ta[0] - ro[0]) / aniso[0], (ta[1] - ro[1]) / aniso[1], (ta[2] - ro[2]) / aniso[2]];
    p[0] = ro[0]; p[1] = ro[1]; p[2] = ro[2];
    p[3] = wave(a[0], 0.45, 0.8);
    p[4] = fw[0]; p[5] = fw[1]; p[6] = fw[2];
    p[7] = 1.45 + 0.3 * g[7];
    p[8] = aniso[0]; p[9] = aniso[1]; p[10] = aniso[2];
    p[11] = 0.25 * Math.sin(morph.travel * 0.11 + g[2] * 6);
    // Site flow phase, refraction/reflection strength, border width, film thickness.
    p[12] = a[4] * 2.2;
    p[13] = wave(a[7], 0.3, 1.0);
    p[14] = wave(a[6], 0.004, 0.009);
    p[15] = 0.4 + 0.35 * Math.sin(a[5]);
    // Hue, light mode, fog per cell, glow gain.
    p[16] = g[3] + 0.08 * Math.sin(a[5] * 0.5);
    p[17] = Math.floor(g[4] * 2) % 2;
    p[18] = 0.3 + 0.12 * g[6];
    p[19] = (0.75 + 0.35 * st.gain) * (0.6 + 0.4 * morph.flow);
    // Burn ages with their strengths, the note's pitch, level-weighted burn counts.
    p[20] = packAge(kickF.age, st.lvK);
    p[21] = packAge(snareF.age, st.lvS);
    p[22] = packAge(noteF.age, st.lvL);
    p[23] = st.pitch;
    p[24] = st.accS % 4096;
    p[25] = st.accK % 4096;
    p[26] = st.accL % 4096;
    p[27] = st.held;
    p[28] = st.zK;
    p[29] = st.zS;
    p[30] = st.zL;
    p[31] = g[0];
  },
  wgsl: /* wgsl */ `
var<private> cf_J: f32;
var<private> cf_ph: f32;
var<private> cf_L: vec3f;
var<private> cf_L2: vec3f;
var<private> cf_A: vec3f;
var<private> cf_B: vec3f;

fn cf_path(z: f32) -> vec3f {
  return vec3f(sin(z * 0.19) * 1.5 + sin(z * 0.067 + 1.1) * 1.1, cos(z * 0.15) * 1.0 + sin(z * 0.043) * 0.6, z);
}

fn cf_hueRot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735);
  let ca = cos(a);
  return max(c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca), vec3f(0.0));
}

// Each site orbits inside its own cell (|offset| < 0.5, so the 3x3x3 search stays exact).
fn cf_site(g: vec3f) -> vec3f {
  let h = hash33(g * 0.7313 + vec3f(S.p[7].w * 57.1 + 3.7, 11.3, 5.9));
  let w = hash33(g * 1.917 + vec3f(2.1, S.p[7].w * 31.0, 8.3));
  return g + 0.5 + 0.5 * cf_J * sin(h * TAU + cf_ph * (0.55 + 0.9 * w));
}

// What a film reflects (world directions): a deep ground with broad washes of the two key colours
// and two soft-edged glows, so the films show clean bands of colour rather than a grey sheen.
fn cf_env(d: vec3f) -> vec3f {
  let a = sat(dot(d, cf_L) * 0.5 + 0.5);
  let b = sat(dot(d, cf_L2) * 0.5 + 0.5);
  var c = cf_A * 0.004 + cf_B * 0.004;
  c += cf_A * 0.16 * pow(a, 5.0) + cf_B * 0.14 * pow(b, 5.0);
  c += cf_A * 0.9 * smoothstep(0.82, 0.97, dot(d, cf_L));
  c += cf_B * 0.7 * smoothstep(0.8, 0.96, dot(d, cf_L2));
  return c;
}

// Thin-film interference: colours from the film's optical thickness (in hundreds of nm) and angle.
fn cf_film(cosT: f32, th: f32) -> vec3f {
  let ctT = sqrt(1.0 - (1.0 - cosT * cosT) / 1.77);
  let opd = 2.0 * 1.33 * th * 100.0 * ctT;
  return 0.5 - 0.5 * cos(TAU * opd / vec3f(650.0, 532.0, 450.0));
}

fn cf_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.25, 0.05) * h * 1.4 + vec3f(1.0, 0.62, 0.2) * h * h * 2.0 + vec3f(1.0, 0.95, 0.9) * pow(h, 5.0) * 2.0;
}

// Fronts burst out fast and slow as they spread: their reach goes with the root of the age (k sets
// the pace). The first 0.4 s ease in from rest, so even the cells at the spark catch gradually.
fn cf_warp(a: f32, k: f32) -> f32 { return sqrt(a * k) * smoothstep(0.0, 0.4, a); }
// A glow that swells in from nothing over r, then cools at rate k: never a flash.
fn cf_pulse(x: f32, r: f32, k: f32) -> f32 { return smoothstep(0.0, r, x) * exp(-max(x - r, 0.0) * k); }

// When a cell catches fire from a spark lit at o: its distance plus a ragged random lag, so the
// front advances cell by cell and splits round slow cells (seconds; v in cells per second).
fn cf_catch(s: vec3f, g: vec3f, o: vec3f, v: f32, lag: f32, seed: f32) -> f32 {
  return (length(s - o) + lag * hash13(g * 1.31 + vec3f(seed))) / v;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  cf_J = S.p[0].w;
  cf_ph = S.p[3].x;
  let ro = S.p[0].xyz;
  let aniso = S.p[2].xyz;
  let focal = S.p[1].w;
  let cam = lookAt(vec3f(0.0), S.p[1].xyz, S.p[2].w);
  let rdW0 = normalize(cam * vec3f(q, focal));
  let fwdW = normalize(S.p[1].xyz);
  let hue = S.p[4].x + F.chordHue * 0.08;
  let refr = S.p[3].y;
  let edgeW = S.p[3].z;
  let fogD = S.p[4].z;
  let gainG = S.p[4].w;
  let seed = S.p[7].w;

  // Key colours, kept two distinct hues even for a narrow palette.
  cf_A = palL(hue + 0.05, 1.0);
  var b = palL(hue + 0.5, 1.0);
  let ca = cf_A - vec3f(dot(cf_A, vec3f(0.3333)));
  let cb = b - vec3f(dot(b, vec3f(0.3333)));
  b = mix(b, cf_hueRot(cf_A, 2.4), smoothstep(-0.2, 0.5, dot(ca, cb) / max(length(ca) * length(cb), 1e-4)));
  cf_B = b;
  let la = seed * TAU;
  if (S.p[4].y < 0.5) {
    cf_L = normalize(fwdW * 0.9 + vec3f(cos(la) * 0.5, 0.35, sin(la) * 0.5));
    cf_L2 = normalize(vec3f(-cf_L.x, -0.4, -cf_L.z));
  } else {
    cf_L = normalize(vec3f(cos(la), 0.7, sin(la)));
    cf_L2 = normalize(fwdW * 0.7 - cf_L * 0.5 + vec3f(0.0, -0.3, 0.0));
  }

  // Events: where each was lit (on the path, fixed in the foam), their ages and counts.
  let lvK = floor(S.p[5].x / 128.0) / 63.0;
  let lvS = floor(S.p[5].y / 128.0) / 63.0;
  let lvL = floor(S.p[5].z / 128.0) / 63.0;
  let kA = S.p[5].x - floor(S.p[5].x / 128.0) * 128.0;
  let sA = S.p[5].y - floor(S.p[5].y / 128.0) * 128.0;
  let lA = S.p[5].z - floor(S.p[5].z / 128.0) * 128.0;
  let pitch = S.p[5].w;
  let held = S.p[6].w;
  let sN = S.p[6].x;
  let kN = S.p[6].y;
  let nN = S.p[6].z;
  let oK = cf_path(S.p[7].x) + vec3f(0.6 * sin(kN * 2.3), 0.5 * cos(kN * 1.7), 0.0);
  let oS = cf_path(S.p[7].y) + vec3f(0.8 * cos(sN * 1.9), 0.6 * sin(sN * 2.7), 0.0);
  let oL = cf_path(S.p[7].z) + vec3f(0.7 * sin(nN * 1.3), 0.9 * pitch, 0.0);
  let sCol = mix(cf_B, vec3f(0.7, 0.9, 1.0), 0.4);
  let lCol = palL(hue + 0.3 + 0.3 * pitch, 1.0);

  let pix0 = 1.4 / (F.res.y * focal);
  let hazeCol = mix(cf_B, cf_A, 0.5 + 0.5 * dot(rdW0, cf_L)) * 0.006;

  // Find the cell containing the camera.
  var rd = normalize(rdW0 * aniso);
  var rdW = rdW0;
  let g0 = floor(ro + rd * 1e-3);
  var cur = g0;
  var cs = cf_site(g0);
  var best = 1e9;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let g = g0 + vec3f(f32(x), f32(y), f32(z));
        let s = cf_site(g);
        let d = dot(ro - s, ro - s);
        if (d < best) { best = d; cur = g; cs = s; }
      }
    }
  }

  var col = vec3f(0.0);
  var T = vec3f(1.0);
  var pIn = ro;
  var tAcc = 0.0;
  var prev = vec3f(1e9);
  var prevS = vec3f(0.0);
  let tEnd = 22.0;

  var sites: array<vec3f, 27>;
  for (var i = 0; i < 16; i++) {
    // All 26 neighbours (with strong jitter or stretch, corner cells own films too): their sites,
    // and the distance from the entry point to the nearest other wall (the border).
    var edge = 1e9;
    for (var j = 0; j < 27; j++) {
      if (j == 13) { continue; }
      let g = cur + vec3f(f32(j % 3 - 1), f32((j / 3) % 3 - 1), f32(j / 9 - 1));
      let s = cf_site(g);
      sites[j] = s;
      let n = s - cs;
      let pd = dot(0.5 * (s + cs) - pIn, n);
      if (any(g != prev) && pd > -1e-3) { edge = min(edge, pd * inverseSqrt(dot(n, n))); }
    }

    // ---- the film we just crossed (between prev and cur), at pIn ----
    if (i > 0) {
      // Clearance: films close to the lens fade out, so nothing pops through or fills the frame.
      let near = smoothstep(0.8, 2.2, tAcc);
      let pix = pix0 * max(tAcc, 0.3);
      let nC = normalize(cs - prevS);
      // Films bow gently, so their reflections flow across them instead of lying flat.
      var tg = pIn - 0.5 * (cs + prevS);
      tg -= nC * dot(tg, nC);
      let nW = normalize((nC + tg * 0.7) / aniso);
      let cosT = abs(dot(rdW, nW));
      let fres = pow(1.0 - cosT, 5.0);
      let rn = select(nW, -nW, dot(rdW, nW) > 0.0);
      let rl = reflect(rdW, rn);
      let ph = hash13(prev + cur * 1.7 + vec3f(seed * 7.0));

      // ---- burns: when this wall catches, and how far in from its borders the fire has crept ----
      let ed = max(edge, 0.0);
      let wK = min(cf_catch(prevS, prev, oK, 8.0, 1.6, 1.0), cf_catch(cs, cur, oK, 8.0, 1.6, 1.0));
      let wS = min(cf_catch(prevS, prev, oS, 11.0, 1.2, 5.0), cf_catch(cs, cur, oS, 11.0, 1.2, 5.0));
      let wL = min(cf_catch(prevS, prev, oL, 5.0, 1.0, 9.0), cf_catch(cs, cur, oL, 5.0, 1.0, 9.0));
      // Fire runs along the borders first, then creeps across the film from its edges.
      let rK = cf_warp(kA, 1.5);
      let rS = cf_warp(sA, 1.0);
      let rL = cf_warp(lA, 0.6);
      let bK = rK - (wK + ed / 1.5);
      let bS = rS - wS;
      let bL = rL - (wL + ed / 1.0);
      // The lasting state takes over within 0.3 s of reach everywhere (the arrival is capped), so
      // it has reached every wall before the next burn of its kind can be lit.
      // Each step is the burn's own strength (the counts are level-weighted).
      let kS = kN - lvK * (1.0 - smoothstep(0.0, 0.3, rK - min(wK + ed / 1.5, 0.3)));
      let sS = sN - lvS * (1.0 - smoothstep(0.0, 0.25, rS - min(wS, 0.3)));
      let nS = nN - lvL * (1.0 - smoothstep(0.0, 0.3, rL - min(wL + ed / 1.0, 0.25)));
      // Every burn's light fades out before the next burn of its kind can be lit, and is as bright
      // as its hit was strong.
      let fadeK = (1.0 - smoothstep(0.25, 0.4, kA)) * lvK;
      let fadeS = (1.0 - smoothstep(0.35, 0.6, sA)) * lvS;
      let fadeL = (1.0 - smoothstep(0.35, 0.6, lA)) * lvL;

      // Film: interference colours from its thickness, which drains toward the bottom of each
      // film and thickens toward its borders; each kick burn leaves the film a step thicker.
      let th = 2.4 + 2.2 * S.p[3].w + 1.4 * (0.5 * (cs.y + prevS.y) - pIn.y) + 1.5 * exp(-ed / 0.12) + 0.9 * fract(kS * 0.38 + ph * 0.3) * 2.0;
      let film = cf_film(cosT, th);
      let tint = mix(cf_A, cf_B, fract(ph + 0.13 * nS));
      let filmC = mix(film * 1.3, film * tint / max(luma(tint), 0.05) * 0.5, 0.35);
      let refl = cf_env(rl);
      let R = 0.04 + 0.96 * pow(1.0 - cosT, 3.0);
      var add = filmC * refl * (0.015 + 3.0 * R * R) * (0.5 + 0.7 * refr);
      // Borders: fine glass threads, a crisp core lit by the key glow; a set of them burns bright,
      // and each snare front moves that set on.
      let ew = max(edgeW, pix * 1.1);
      let core = (1.0 - smoothstep(ew * 0.35, ew, ed)) * (edgeW / ew);
      let halo = exp(-ed / (ew * 3.0)) * (edgeW / ew);
      let s0 = floor(sS);
      let litA = step(0.8, fract(ph * 7.31 + s0 * 0.618));
      let litB = step(0.8, fract(ph * 7.31 + (s0 + 1.0) * 0.618));
      let lit = mix(litA, litB, fract(sS));
      let bandC = mix(cf_A, cf_B, fract(ph * 3.0 + 0.3 * kS));
      add += bandC * (core * (0.015 + 0.4 * lit) + halo * 0.006) * gainG;
      // Fire: a hot rim crossing the wall, embers along its borders that cool.
      let heat = cf_pulse(bK, 0.2, 5.0) * fadeK;
      let ember = cf_pulse(bK, 0.2, 1.8) * step(0.55, fract(ph * 13.7 + floor(ed * 30.0) * 0.37)) * fadeK;
      add += cf_fire(heat) * (0.12 + 1.5 * core + 0.25 * halo);
      add += cf_fire(0.4) * ember * (core * 0.6 + halo * 0.06);
      // Snare: a crackle along the borders only, in the cool colour.
      let sh = cf_pulse(bS, 0.15, 6.0) * fadeS;
      add += sCol * sh * (2.6 * core + 0.3 * halo + 0.12);
      // Melody: a soft glow of the note's colour spreading over the films.
      let lh = cf_pulse(bL, 0.15, 3.5) * fadeL;
      add += (lCol * lh + palL(hue + 0.45, 1.0) * 0.1 * held) * (0.1 + 0.7 * R + 1.1 * core);

      // The spark that lights each fire: a bloom that swells on the walls round its ignition point.
      let dK = length(pIn - oK);
      let dS = length(pIn - oS);
      let dL = length(pIn - oL);
      add += cf_fire(0.9) * exp(-dK * dK * 0.45) * cf_pulse(kA, 0.15, 6.0) * fadeK * (0.12 + 1.2 * core + 0.8 * R);
      add += sCol * exp(-dS * dS * 0.6) * cf_pulse(sA, 0.25, 6.0) * fadeS * (0.15 + 1.6 * core + 0.9 * R);
      add += lCol * exp(-dL * dL * 0.35) * cf_pulse(lA, 0.3, 4.0) * fadeL * (0.3 + 1.8 * core + 1.6 * R);
      // Depth: far films sink into the haze.
      let fogT = exp(-fogD * tAcc);
      col += T * add * near * fogT;
      let a = (0.04 + 0.4 * R * (0.4 + 0.6 * refr)) * near;
      // Light passing through takes the film's complementary colours and the glass's tint.
      let body = mix(vec3f(1.0), tint / max(max(tint.r, max(tint.g, tint.b)), 0.01), 0.12 * refr);
      T *= (1.0 - sat(a)) * mix(vec3f(1.0), (vec3f(1.0) - 0.5 * film * R) * body, near);
      // Refraction: the film bends the ray a little by its bow, so the foam behind it wavers.
      let bend = (nW - nC / aniso * inverseSqrt(dot(nC / aniso, nC / aniso))) * 0.35 * refr * near;
      rdW = normalize(rdW - bend * sign(dot(rdW, nW)));
      rd = normalize(rdW * aniso);
    }

    // Exit through the nearest wall ahead (after any bend at the entry).
    var tEx = 1e9;
    var nx = cur;
    var ns = cs;
    for (var j = 0; j < 27; j++) {
      if (j == 13) { continue; }
      let s = sites[j];
      let n = s - cs;
      let dn = dot(rd, n);
      if (dn > 1e-5) {
        let t = max(dot(0.5 * (s + cs) - pIn, n), 0.0) / dn;
        if (t < tEx) { tEx = t; nx = cur + vec3f(f32(j % 3 - 1), f32((j / 3) % 3 - 1), f32(j / 9 - 1)); ns = s; }
      }
    }

    // Haze over the cell's interior.
    let t1 = min(tEx, tEnd - tAcc);
    let fT = exp(-fogD * 0.25 * max(t1, 0.0));
    col += T * hazeCol * (1.0 - fT);
    T *= fT;

    pIn = pIn + rd * tEx;
    tAcc += tEx;
    prev = cur;
    prevS = cs;
    cur = nx;
    cs = ns;
    if (tAcc > tEnd || max(T.x, max(T.y, T.z)) < 0.03) { break; }
  }
  col += T * (hazeCol + cf_env(rdW) * 0.3);
  // Contrast and richer colour (thin films otherwise sum toward white), then a soft shoulder:
  // broad bright areas roll off instead of clipping.
  col = pow(max(mix(vec3f(luma(col)), col, 1.4), vec3f(0.0)), vec3f(1.35));
  let pk = max(col.r, max(col.g, col.b));
  col *= 1.0 / (1.0 + 0.5 * max(pk - 0.7, 0.0));
  return vec4f(col, 1.0);
}
`,
});
