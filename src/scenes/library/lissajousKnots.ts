import { raymarchScene } from '../raymarchScene';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Knot weave: bundles of glowing tubes tracing 3D Lissajous knots, woven torus knots,
 * ring plaits, spherical Lissajous (Clelia-like) cages, or stereographically projected
 * Hopf fibres (every ring linked with every other). Each strand listens to one spectrum
 * band: its thickness swells with the band, the band's recent history flows along it as
 * travelling bulges, and its glow follows the level. Tubes are traced exactly (analytic
 * ray-capsule tests over a phasor-generated polyline) and shaded as neon glass, satin
 * with anisotropic highlights, chrome, or dark rope carrying light dashes. Bars retie the
 * knot by gliding its phases, builds tighten it, drops fling it open.
 *
 * Event and band reactions are scaled by the morph's passage loudness (and events by their level
 * squared, eased in), so a faint intro motif only glimmers along a strand.
 */

const fract = (x: number) => x - Math.floor(x);
const hash = (n: number) => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);

const LISS: readonly number[][] = [[3, 2, 5], [3, 4, 7], [2, 3, 7], [5, 4, 3], [3, 5, 4]];
const TORUS: readonly number[][] = [[2, 3], [3, 4], [2, 5], [3, 5], [3, 7], [4, 5]];
const SPHERE: readonly number[][] = [[3, 1], [5, 2], [4, 1], [7, 2], [5, 1]];
const SEGS = [88, 80, 96, 72, 64];
const NMAX = [5, 5, 4, 6, 7];
const NMIN = [2, 2, 2, 2, 4];

/** Upper bound on |dP/du| (per unit curve scale) so the shader can bound 8-segment chunks. */
function speedBound(fam: number, p: Float32Array): number {
  if (fam === 0) return Math.hypot(p[4], p[5], p[6]);
  if (fam === 1) return Math.hypot((1 + p[6]) * p[4], p[6] * p[5]);
  if (fam === 2) return 1 + p[5] + p[5] * p[4] + 2 * p[6] * p[4];
  if (fam === 3) return Math.hypot(p[5], p[6] * p[4]);
  return 1 / Math.max(1 - Math.sin(0.3 + p[4]), 0.2);
}

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
const fx = { kick: new Flare(0.12, 0.25), snare: new Flare(0.12, 0.2) };
/** Hats and chord swell, glided so neither steps the light. */
const hatS = new Spring(0, 0.1);
const chordS = new Spring(0, 0.1);

const st = { ph: [0, 0, 0, 0], tgt: [0, 0, 0, 0], lastBar: -1, ties: 0, yaw: 0, pitch: 0, lastTime: -1, open: 0 };

export default raymarchScene({
  // Dropped from auto-direction: glowing tubes knotted in a void, an object you orbit rather
  // than a place to fly through. An unreachable energy range and mood with no genre
  // affinity keep scoreScene() at the bottom of every ranking. Still available when pinned by hand.
  meta: {
    id: 'lissajous-knots',
    name: 'Knot Weave',
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: -1, arousal: -1 },
    genres: {},
    trails: 0.35,
    sparse: true,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    if (Math.abs(m.time - st.lastTime) > 0.5) {
      for (let i = 0; i < 4; i++) st.ph[i] = st.tgt[i] = hash(i * 3.1 + g[4] * 9) * 6.28;
      st.open = 0;
    }
    st.lastTime = m.time;
    morph.update(m, ctx.dt, g);
    const pres = morph.presence;
    const kickF = fx.kick.update(morph.kicks, morph.kickAge, morph.kickLevel);
    // Dash light: snares and hats, eased (0..1.5).
    const dashG = Math.min(1.5, fx.snare.update(morph.snares, morph.snareAge, morph.snareLevel) + 0.5 * hatS.update(m.hat * pres, dt));
    const ant = m.anticipation;
    const drop = m.dropPulse;
    const fam = Math.floor(g[0] * 5);
    const grammar = Math.floor(g[7] * 3);
    const tieEvery = grammar === 1 ? 1 : 2;
    if (m.barIndex !== st.lastBar) {
      if (m.barIndex % tieEvery === 0) {
        st.ties++;
        for (let i = 0; i < 4; i++) st.tgt[i] += (hash(st.ties * 5.3 + i * 1.7 + g[4]) - 0.5) * 1.6;
      }
      st.lastBar = m.barIndex;
    }
    const k = 1 - Math.exp(-dt * (1.5 + 2 * m.energySlow));
    for (let i = 0; i < 4; i++) {
      st.tgt[i] += dt * (0.05 + 0.04 * i) * (1 + 2 * ant);
      st.ph[i] += (st.tgt[i] - st.ph[i]) * k;
    }
    st.yaw += dt * (0.08 + 0.12 * m.energySlow + 0.8 * ant * ant + 0.5 * drop);
    st.pitch += dt * 0.05;

    const N = NMIN[fam] + Math.floor(g[1] * (NMAX[fam] - NMIN[fam] + 1));
    p[0] = fam; p[1] = N; p[2] = SEGS[fam]; p[3] = Math.floor(g[2] * 4) + 0.3 * dashG; // material; fraction: dash light / 1.5 * 0.45
    const fi = Math.floor(g[4] * 5);
    if (fam === 0) { const f = LISS[fi]; p[4] = f[0]; p[5] = f[1]; p[6] = f[2]; }
    else if (fam === 1) { const f = TORUS[Math.floor(g[4] * 6)]; p[4] = f[0]; p[5] = f[1]; p[6] = 0.38 + 0.12 * ev[0]; }
    else if (fam === 2) { p[4] = 2 + Math.floor(g[4] * 3); p[5] = 0.22 + 0.06 * ev[0]; p[6] = 0.16 + 0.05 * ev[1]; }
    else if (fam === 3) { const f = SPHERE[fi]; p[4] = f[0]; p[5] = f[1]; p[6] = 1.05 + 0.25 * ev[0]; }
    else { p[4] = 0.15 + 0.3 * fract(g[4] * 3.1); p[5] = 0.3 + 0.4 * ev[0]; p[6] = 0; }
    // Builds tighten the knot, drops fling it open.
    st.open += ((1 - 0.22 * ant + 0.3 * drop) - st.open) * (1 - Math.exp(-dt * 6));
    p[7] = (fam === 4 ? 0.95 : 1.05) * st.open * (1 + 0.04 * m.kickNext);
    p[8] = st.ph[0]; p[9] = st.ph[1]; p[10] = st.ph[2]; p[11] = st.ph[3];

    // Camera rigs: orbit, macro, fly-through, top-down.
    const rig = Math.floor(g[3] * 4);
    const sp = ctx.spin;
    let eye: number[];
    let tgt: number[];
    let focal: number;
    if (rig === 0) {
      const a = sp * 0.1 + g[3] * 9;
      eye = [Math.cos(a) * 3.4, 0.6 * Math.sin(sp * 0.05), Math.sin(a) * 3.4];
      tgt = [0, 0, 0];
      focal = 1.6;
    } else if (rig === 1) {
      const a = sp * 0.07 + g[3] * 5;
      eye = [Math.cos(a) * 2.0, 0.4 + 0.3 * Math.sin(sp * 0.06), Math.sin(a) * 2.0];
      tgt = [0.35 * Math.sin(sp * 0.05), 0.15 * Math.cos(sp * 0.04), 0.35 * Math.cos(sp * 0.045)];
      focal = 2.2;
    } else if (rig === 2) {
      const s = sp * 0.12 + g[3] * 7;
      const path = (u: number) => [0.75 * Math.sin(u * 1.0), 0.45 * Math.sin(u * 1.3 + 1), 0.75 * Math.cos(u * 0.8)];
      eye = path(s);
      tgt = path(s + 0.35);
      focal = 1.0;
    } else {
      const a = sp * 0.06 + g[3] * 3;
      eye = [Math.cos(a) * 0.4, 3.0, Math.sin(a) * 0.4];
      tgt = [0, 0, 0];
      focal = 1.5;
    }
    p[12] = eye[0]; p[13] = eye[1]; p[14] = eye[2]; p[15] = focal;
    p[16] = tgt[0]; p[17] = tgt[1]; p[18] = tgt[2]; p[19] = rig === 2 ? 0.4 * Math.sin(sp * 0.09) : 0.08 * Math.sin(sp * 0.05);

    const thick = (0.02 + 0.022 * fract(g[5] * 2.9)) * (fam === 4 ? 1.05 : 1);
    p[20] = thick * (1 + (grammar === 0 ? 0.45 : 0.15) * kickF);
    p[21] = (0.6 + 0.8 * ctx.intensity + 0.4 * chordS.update(m.chordPulse, dt)) * (1 - 0.35 * ant) + 0.6 * drop;
    p[22] = fract(g[6] + 0.1 * ev[2]);
    p[23] = Math.floor(fract(g[6] * 3.7) * 3) + 0.45 * pres; // hue mode; fraction: passage loudness
    p[24] = st.yaw; p[25] = Math.sin(st.pitch) * 0.6 + g[3] * 2; p[26] = grammar; p[27] = m.beatPhase + m.beatIndex % 8;
    p[28] = ant; p[29] = drop * drop; p[30] = rig === 2 ? 0.3 : 0.02; p[31] = speedBound(fam, p) * p[7] * 1.12;
  },
  wgsl: /* wgsl */ `
/** The spectrum with its attack eased over ~120 ms (now and the last three history rows), so
 *  an onset swells a band in instead of stepping it. */
fn lk_specE(x: f32) -> f32 {
  return 0.25 * (spec(x) + hist(x, 0.01) + hist(x, 0.02) + hist(x, 0.03));
}

fn lk_cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn lk_cis(a: f32) -> vec2f { return vec2f(cos(a), sin(a)); }

// Curve point from three phasors (see the per-family setup in scene()).
fn lk_eval(fam: f32, z1: vec2f, z2: vec2f, z3: vec2f, eta: f32) -> vec3f {
  let S0 = S.p[1].w;
  if (fam < 0.5) { return S0 * vec3f(z1.x, z2.x, z3.x); }
  if (fam < 1.5) {
    let a = S.p[1].z;
    let r = 1.0 + a * z2.x;
    return S0 * vec3f(r * z1.x, a * z2.y, r * z1.y);
  }
  if (fam < 2.5) {
    let off = vec2f(S.p[1].y * z2.x, S.p[1].z * z3.y);
    return S0 * vec3f((1.0 + off.x) * z1.x, off.y, (1.0 + off.x) * z1.y);
  }
  if (fam < 3.5) {
    let th = S.p[1].z * z2.y;
    let c = cos(th);
    return S0 * vec3f(c * z1.x, sin(th), c * z1.y);
  }
  // Hopf fibre: (cos eta e^{i(u+xi)}, sin eta e^{iu}) in S^3, stereographically projected.
  let x = vec4f(cos(eta) * z1, sin(eta) * z2);
  // Rotate within the (x1, x3) plane: it animates the linking without moving fibres toward the pole.
  let w = rot2(S.p[2].w * 0.4) * vec2f(x.x, x.z);
  return S0 * vec3f(w.x, x.y, w.y) / max(1.0 - x.w, 0.2);
}

fn lk_capsule(ro: vec3f, rd: vec3f, pa: vec3f, pb: vec3f, r: f32) -> f32 {
  let ba = pb - pa;
  let oa = ro - pa;
  let baba = dot(ba, ba);
  let bard = dot(ba, rd);
  let baoa = dot(ba, oa);
  let rdoa = dot(rd, oa);
  let oaoa = dot(oa, oa);
  let a = baba - bard * bard;
  let b = baba * rdoa - baoa * bard;
  let c = baba * oaoa - baoa * baoa - r * r * baba;
  let h = b * b - a * c;
  if (h >= 0.0) {
    let t = (-b - sqrt(h)) / max(a, 1e-8);
    let y = baoa + t * bard;
    if (y > 0.0 && y < baba) { return t; }
    let oc = select(ro - pb, oa, y <= 0.0);
    let b2 = dot(rd, oc);
    let c2 = dot(oc, oc) - r * r;
    let h2 = b2 * b2 - c2;
    if (h2 > 0.0) { return -b2 - sqrt(h2); }
  }
  return -1.0;
}

fn lk_env(d: vec3f) -> vec3f {
  let hue = S.p[5].z;
  var c = mix(F.pal0.rgb * 0.03, palL(hue + 0.2, 0.12), sat(d.y * 0.6 + 0.4));
  c += palL(hue + 0.5, 1.4) * smoothstep(0.7, 0.95, d.y);
  c += palL(hue + 0.15, 0.8) * exp(-pow((atan2(d.z, d.x) - 1.0) * 3.0, 2.0)) * smoothstep(-0.3, 0.2, d.y) * smoothstep(0.6, 0.2, d.y);
  return c;
}

fn lk_hue(j: f32, N: f32) -> f32 {
  let mode = floor(S.p[5].w);
  let h = S.p[5].z;
  if (mode < 0.5) { return h + j / N * 0.75; }
  if (mode < 1.5) { return h + fmod(j, 2.0) * 0.33; }
  return h + 0.06 * sin(j * 1.7);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let roW = S.p[3].xyz;
  let cam = lookAt(roW, S.p[4].xyz, S.p[4].w);
  let rdW = normalize(cam * vec3f(q, S.p[3].w));
  // Rotate the ray into object space instead of rotating every curve point.
  let orot = rotX(S.p[6].y) * rotY(S.p[6].x);
  let ro = orot * roW;
  let rd = orot * rdW;

  let fam = S.p[0].x;
  let N = i32(S.p[0].y);
  let K = i32(S.p[0].z);
  let mat = floor(S.p[0].w);
  let dashG = fract(S.p[0].w) / 0.3;
  // How loud the passage is (0.15..1): quiet passages only glimmer with the spectrum.
  let pres = fract(S.p[5].w) / 0.45;
  let fN = f32(N);
  let du = TAU / f32(K);
  let baseR = S.p[5].x;
  let glowG = S.p[5].y;
  let glowW = baseR * select(2.2, 1.0, mat > 0.5 && mat < 2.5);
  let ph = S.p[2];

  var bg = mix(F.pal0.rgb * 0.02, palL(S.p[5].z + 0.6, 0.03), exp(-length(q) * 1.3));
  bg *= 1.0 - 0.5 * S.p[7].x;

  // Whole-weave bounding sphere (glow margin included).
  let bR = select(1.95, 4.6, fam > 3.5) * S.p[1].w + glowW * 4.0;
  let bb = dot(ro, rd);
  let bh = bb * bb - (dot(ro, ro) - bR * bR);
  if (bh < 0.0) { return vec4f(bg, 1.0); }

  var tBest = 1e9;
  var bestA = vec3f(0.0);
  var bestB = vec3f(1.0);
  var bestR = 0.01;
  var bestJ = 0.0;
  var bestU = 0.0;
  var glow = vec3f(0.0);

  for (var j = 0; j < 12; j++) {
    if (j >= N) { break; }
    let fj = f32(j);
    let band = (fj + 0.5) / fN * 0.8 + 0.04;
    let lv = lk_specE(band) * pres;
    let sR = baseR * (0.55 + 0.9 * lv);
    let hue = lk_hue(fj, fN);
    let gc = palL(hue, 1.0) * glowG * (0.15 + 1.6 * lv * lv);
    let psi = fj / fN * TAU;
    // Phasor setup per family: start values and per-segment rotations.
    var z1: vec2f; var z2: vec2f; var z3: vec2f;
    var w1: vec2f; var w2: vec2f; var w3: vec2f;
    var eta = 0.0;
    if (fam < 0.5) {
      let sp = psi / 3.0;
      z1 = lk_cis(ph.x + sp); z2 = lk_cis(ph.y + sp * 2.0); z3 = lk_cis(ph.z + sp * 1.5);
      w1 = lk_cis(S.p[1].x * du); w2 = lk_cis(S.p[1].y * du); w3 = lk_cis(S.p[1].z * du);
    } else if (fam < 1.5) {
      z1 = lk_cis(ph.x * 0.3); z2 = lk_cis(ph.y + psi); z3 = vec2f(1.0, 0.0);
      w1 = lk_cis(S.p[1].x * du); w2 = lk_cis(S.p[1].y * du); w3 = vec2f(1.0, 0.0);
    } else if (fam < 2.5) {
      let m = S.p[1].x;
      z1 = lk_cis(ph.x * 0.3); z2 = lk_cis(ph.y + psi); z3 = lk_cis(2.0 * (ph.y + psi));
      w1 = lk_cis(du); w2 = lk_cis(m * du); w3 = lk_cis(2.0 * m * du);
    } else if (fam < 3.5) {
      z1 = lk_cis(ph.x + psi); z2 = lk_cis(ph.y + psi * 0.5);
      w1 = lk_cis(S.p[1].y * du); w2 = lk_cis(S.p[1].x * du); z3 = vec2f(1.0, 0.0); w3 = z3;
    } else {
      eta = 0.3 + S.p[1].x * (0.5 + 0.5 * sin(fj * 2.39 + ph.z));
      z1 = lk_cis(fj * 2.39996 + ph.x); z2 = vec2f(1.0, 0.0); z3 = z2;
      w1 = lk_cis(du); w2 = w1; w3 = z3;
    }
    // Hierarchical culling: chunks of 8 segments are bounded by a sphere around the chunk's
    // arc midpoint whose radius is half the maximum arc length (speed bound x parameter span).
    let w1b = lk_cmul(w1, w1); let w2b = lk_cmul(w2, w2); let w3b = lk_cmul(w3, w3);
    let w1q = lk_cmul(w1b, w1b); let w2q = lk_cmul(w2b, w2b); let w3q = lk_cmul(w3b, w3b);
    let w1o = lk_cmul(w1q, w1q); let w2o = lk_cmul(w2q, w2q); let w3o = lk_cmul(w3q, w3q);
    let rMax = sR * 1.4;
    let reachC = S.p[7].w * du * 4.0 + glowW * 4.0;
    let gk0 = glowW * glowW;
    let nC = K / 8;
    for (var c = 0; c < 12; c++) {
      if (c >= nC) { break; }
      let pm = lk_eval(fam, lk_cmul(z1, w1q), lk_cmul(z2, w2q), lk_cmul(z3, w3q), eta) - ro;
      let tmc = dot(pm, rd);
      if (dot(pm, pm) - tmc * tmc > reachC * reachC) {
        z1 = lk_cmul(z1, w1o); z2 = lk_cmul(z2, w2o); z3 = lk_cmul(z3, w3o);
        continue;
      }
      var prev = lk_eval(fam, z1, z2, z3, eta);
      for (var s = 0; s < 8; s++) {
        z1 = lk_cmul(z1, w1); z2 = lk_cmul(z2, w2); z3 = lk_cmul(z3, w3);
        let cur = lk_eval(fam, z1, z2, z3, eta);
        let k = c * 8 + s + 1;
        let u = (f32(k) - 0.5) / f32(K);
        // Closest approach between the ray and this segment.
        let ba = cur - prev;
        let oa = ro - prev;
        let baba = dot(ba, ba);
        let bard = dot(ba, rd);
        let s0 = sat((dot(ba, oa) - dot(rd, oa) * bard) / max(baba - bard * bard, 1e-7));
        let tc = max(s0 * bard - dot(rd, oa), 0.0);
        let sp2 = sat(dot(oa + rd * tc, ba) / max(baba, 1e-7));
        let dd = length(oa + rd * tc - ba * sp2);
        if (dd < rMax) {
          // Spectrum history flows along the strand as bulges.
          let r = sR * (0.8 + 0.6 * pres * hist(band, (0.5 - 0.5 * cos(u * TAU)) * 0.8));
          let th = lk_capsule(ro, rd, prev, cur, r);
          if (th > S.p[7].z && th < tBest) {
            tBest = th; bestA = prev; bestB = cur; bestR = r; bestJ = fj; bestU = (f32(k - 1) + sp2) / f32(K);
          }
        }
        if (tc < tBest + glowW * 4.0) {
          glow += gc * max(gk0 / (dd * dd + gk0) - 1.0 / 17.0, 0.0) * 1.07 * sqrt(baba) * exp(-tc * 0.25);
        }
        prev = cur;
      }
    }
  }

  let gk = select(0.04, 0.08, mat < 0.5 || mat > 2.5);
  var col = bg + glow * gk;
  if (tBest < 1e8) {
    let p = ro + rd * tBest;
    let ba = bestB - bestA;
    let ax = bestA + ba * sat(dot(p - bestA, ba) / dot(ba, ba));
    let n = normalize(p - ax);
    let T = normalize(ba);
    let c = sat(dot(n, -rd));
    let hue = lk_hue(bestJ, fN);
    let band = (bestJ + 0.5) / fN * 0.8 + 0.04;
    let lv = lk_specE(band) * pres;
    let L = normalize(vec3f(0.3, 1.0, 0.4));
    let r = reflect(rd, n);
    let fog = exp(-max(tBest - 1.5, 0.0) * 0.12);
    var sc: vec3f;
    let grammar = S.p[6].z;
    // Light dashes travel along strands on the beat.
    let dash = smoothstep(0.75, 0.95, fract(bestU * 6.0 - S.p[6].w * 0.5 + bestJ * 0.37)) * select(0.35, 1.0, grammar > 1.5) * (1.0 + dashG);
    if (mat < 0.5) {
      // Neon glass: hot core seen through a clear tube.
      let core = pow(c, 2.5);
      let e = palL(hue, 0.42) * glowG * (0.4 + 1.6 * lv);
      sc = e * (0.25 + 1.2 * core) + vec3f(luma(e)) * pow(c, 10.0) * 0.3 + lk_env(r) * pow(1.0 - c, 4.0) * 0.6;
      sc += palL(hue + 0.1, 1.0) * dash * glowG * 0.8;
    } else if (mat < 1.5) {
      // Satin with Kajiya-Kay highlights along the fibre.
      let H = normalize(L - rd);
      let th = dot(T, H);
      let aniso = pow(sqrt(max(1.0 - th * th, 0.0)), 80.0);
      let dif = sat(dot(n, L)) * 0.75 + 0.25 * sat(0.5 + 0.5 * n.y);
      let base = palL(hue, 0.2);
      sc = base * dif + palL(hue + 0.05, 0.9) * aniso * 0.7 + lk_env(r) * pow(1.0 - c, 3.0) * 0.3;
      sc += palL(hue, 1.0) * dash * glowG * 0.5 * (0.4 + lv);
    } else if (mat < 2.5) {
      // Chrome.
      let tint = mix(vec3f(1.0), palL(hue, 0.8), 0.45);
      sc = lk_env(r) * tint * (0.7 + 0.3 * pow(1.0 - c, 5.0)) * 1.3 + vec3f(pow(sat(dot(r, L)), 50.0)) * 2.0;
      sc += palL(hue, 1.0) * dash * glowG * 0.4;
    } else {
      // Dark rope carrying light.
      let dif = sat(dot(n, L)) * 0.6 + 0.1;
      sc = palL(hue, 0.04) * dif + lk_env(r) * pow(1.0 - c, 4.0) * 0.25;
      sc += palL(hue + 0.08, 1.0) * dash * glowG * (1.2 + 2.0 * lv) * 1.4;
    }
    col = mix(bg, sc, fog * smoothstep(S.p[7].z, S.p[7].z * 1.5 + 0.01, tBest)) + glow * gk * 0.4;
  }
  col *= 1.0 - 0.3 * S.p[7].x;
  col += (F.pal3.rgb * 0.3 + vec3f(0.1)) * S.p[7].y * (0.03 + 0.4 * luma(col));
  return vec4f(col, 1.0);
}
`,
});
