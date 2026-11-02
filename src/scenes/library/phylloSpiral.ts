import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Phyllo Spiral: a phyllotaxis lattice (Vogel's model: point k at radius sqrt(k), angle k * alpha)
 * drawn as glossy beads on black. The view is log-polar: screen x is log radius and screen y is angle,
 * so the origin always sits off the edge of the frame, and the arms (parastichies) sweep across the
 * whole screen, curving as they go. The window breathes in and out of the lattice with the travel.
 *
 * Beads are shaded spheres (or ellipses, radially or tangentially stretched) with a fresnel rim and a
 * hairline glint. Two hue families alternate by bead index parity, so neighbouring spirals take
 * different hues. Each 34-arm also turns the hue by its own amount, and the hue sweeps across the frame.
 *
 * Music:
 *  - morph: the divergence angle alpha moves around the golden angle (the spirals re-form), and bead
 *    size and stretch drift with the morph.
 *  - kick: alpha steps by a tiny amount for good (the lattice keeps its new twist), and a hot front
 *    runs out along one 21-arm from an ignition index just inside the frame.
 *  - snare: a cool front runs inward along a 34-arm from the outer edge; behind it the second family
 *    of beads takes a new hue for good.
 *  - melody: each note leans the bead stretch toward its pitch's stretch, by the note's strength (a
 *    faint note only a little). The new stretch ripples out from a screen x set by the pitch and holds
 *    until the next note.
 *  Every front's light and lasting step scales with its event's level and rises over about 0.1 s
 *  where it passes, so nothing flashes on in one frame.
 *  - drops: the travel rushes, so the breathing zoom swings faster and wider.
 *
 * Nearest bead: point k lies at radius sqrt(k). For a point at radius R, any bead within 1.4 of it has
 * index within 2.8 R of R^2, so the window is exact. Candidates are rejected with a cheap angle test
 * (fract of k * alpha / 2pi) before any trig.
 *
 * DNA: 0 start, 1 spin, 2 zoom phase, 3 palette.
 */

const morph = new Morph(0.9);
const st = { seed: -1, n: -1, k: -1, s: -1, ki: 0, si: 0, eOld: 0, eNew: 0, xL: 0, sSum: 0, sLast: 0 };

const GOLD = 2.39996323;
const TAU = Math.PI * 2;
/** Log radius of the window centre (the lattice has scale 1). Small enough that beads read at low res. */
const RC = 8;
/** Horizontal log-radius per unit of screen x (about +-0.32 across a 16:9 frame). */
const AX = 0.18;
const ASPECT = 16 / 9;

/** Writes the vec4 slot i of the scene parameters. */
function put(p: Float32Array, i: number, x: number, y: number, z: number, w: number): void {
  p[4 * i] = x;
  p[4 * i + 1] = y;
  p[4 * i + 2] = z;
  p[4 * i + 3] = w;
}

export default raymarchScene({
  meta: {
    id: 'phyllo-spiral',
    name: 'Phyllo Spiral',
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.5 },
    genres: { edm: 0.8, techno: 0.7, ambient: 0.8, synthwave: 0.9, pop: 0.6, dnb: 0.6, classical: 0.5, hiphop: 0.5, dubstep: 0.6, rock: 0.4 },
    trails: 0,
    kaleido: false,
    // Fails 'several hues' (1.3-1.7 of 2) and riddim melody (1.31 of 1.4): the bead hues collapse to one or two warm clusters after the post chain.
    auto: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    if (g[0] !== st.seed || morph.notes < st.n) {
      st.seed = g[0];
      st.n = morph.notes;
      st.k = morph.kicks;
      st.s = morph.snares;
      st.eOld = st.eNew = st.xL = st.sSum = st.sLast = 0;
    }
    if (morph.notes !== st.n) {
      st.n = morph.notes;
      st.eOld = st.eNew;
      st.eNew += (0.3 * morph.notePitch - st.eNew) * morph.noteLevel ** 2;
      st.xL = 0.85 * morph.notePitch;
    }

    // The window breathes in and out of the lattice; a drop widens the swing (the travel rushes too).
    const zp = morph.travel * 0.45 + g[2] * TAU;
    const U = Math.log(RC) + (0.42 + 0.25 * morph.surge) * Math.sin(zp);
    // Ignition indices are fixed when each event lands: a kick just inside the inner edge, a snare
    // just outside the outer edge.
    if (morph.kicks !== st.k) {
      st.k = morph.kicks;
      st.ki = Math.floor(Math.exp(2 * (U - AX * ASPECT)) * 0.85) + ((morph.kicks * 7) % 21);
    }
    if (morph.snares !== st.s) {
      st.s = morph.snares;
      // Level-weighted snare sum: the lasting hue step behind each front is as strong as its snare.
      st.sSum = (st.sSum + st.sLast) % 1024;
      st.sLast = morph.snareLevel;
      st.si = Math.floor(Math.exp(2 * (U + AX * ASPECT)) * 1.1) + ((morph.snares * 5) % 34);
    }

    // Alpha: around the golden angle (the spirals re-form), plus a tiny lasting step per kick.
    put(p, 0, GOLD + wave(a[0], -0.06, 0.06) + 0.0005 * morph.kickPhase, wave(a[2], 0.5, 0.7), wave(a[3], -0.15, 0.15), wave(a[4], 0.8, 1.15));
    put(p, 1, U, AX, g[1] * TAU + morph.travel * 0.035, morph.noteLevel ** 2);
    put(p, 2, st.ki, Math.min(morph.kickAge, 9), morph.kicks % 1024, morph.kickLevel);
    put(p, 3, st.si, Math.min(morph.snareAge, 9), st.sSum + st.sLast, st.sLast);
    put(p, 4, st.eOld, st.eNew, st.xL, Math.min(morph.leadAge, 9));
    put(p, 5, g[3] + 0.06 * Math.sin(a[6] * 0.4), morph.drive, morph.surge, morph.flow);
  },
  wgsl: /* wgsl */ `
// Nearest bead to P (lattice scale 1). Bead k sits at radius sqrt(k) and angle k * al. Any bead within
// 1.4 of P has index within 2.8 |P| of |P|^2, so only that window is searched. Candidates fail a cheap
// angle test (fract of k * al / TAU) before any trig.
fn ps_near(P: vec2f, al: f32) -> vec4f {
  let r = length(P);
  let kc = i32(r * r);
  let W = min(i32(2.8 * r) + 2, 200);
  let an = al / TAU;
  let tn = atan2(P.y, P.x) / TAU;
  var best = vec4f(1e9, 0.0, 0.0, 0.0);
  for (var j = -W; j <= W; j++) {
    let k = f32(max(kc + j, 0));
    let rk = sqrt(k);
    if (abs(rk - r) > 1.4) { continue; }
    let a = fract(k * an - tn + 0.5) - 0.5;
    if (abs(a) * TAU * r > 1.6) { continue; }
    let ang = k * al;
    let B = rk * vec2f(cos(ang), sin(ang));
    let dd = length(P - B);
    if (dd < best.x) { best = vec4f(dd, k, B.x, B.y); }
  }
  return best;
}

// Saturated palette hue at a chosen level (neon on black). rot turns the hue explicitly, in turns.
fn ps_col(t: f32, lvl: f32, rot: f32) -> vec3f {
  let p = pal(t);
  let mx = max(p.r, max(p.g, p.b));
  let mn = min(p.r, min(p.g, p.b));
  let d = max(mx - mn, 1e-4);
  var h = select(select((p.r - p.g) / d + 4.0, (p.b - p.r) / d + 2.0, mx == p.g), (p.g - p.b) / d, mx == p.r);
  h = fract(h / 6.0 + rot);
  // Full saturation: the hue alone carries the colour, so the post tone curve can't wash it out.
  let c = hsv2rgb(vec3f(h, 1.0, 1.0));
  return c * lvl * pow(0.4 / max(luma(c), 0.08), 0.55);
}

// Fire by heat (1 = just lit): white core, yellow, orange.
fn ps_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.25, 0.05) * h * 1.4 + vec3f(1.0, 0.62, 0.2) * h * h * 2.2 + vec3f(1.0, 0.95, 0.9) * pow(h, 5.0) * 2.5;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let dq = 2.0 / F.res.y;
  let al = S.p[0].x; let rho = S.p[0].y; let Eb = S.p[0].z; let Ay = S.p[0].w;
  let U = S.p[1].x; let Ax = S.p[1].y; let Th = S.p[1].z;
  // Log-polar window: plane point = exp(U + Ax q.x) * (cos v, sin v), v = Th + Ay q.y.
  let R = exp(U + Ax * q.x);
  let v = Th + Ay * q.y;
  let P = R * vec2f(cos(v), sin(v));
  let fp = R * dq * Ay;   // one pixel in plane units (the taller direction)

  let nb = ps_near(P, al);
  let k = nb.y;
  let B = nb.zw;
  let rB = max(length(B), 1e-4);
  let ur = B / rB;
  let ut = vec2f(-ur.y, ur.x);
  // Two hue families: beads alternate by index parity, so each spiral's neighbours take the other hue.
  let fam = fmod(k, 2.0);

  // Melody: the stretch steps behind a front that ripples out from the note's screen x.
  let eO = S.p[4].x; let eN = S.p[4].y; let xL = S.p[4].z; let lA = S.p[4].w;
  let xB = (log(rB) - U) / Ax;
  let tL = abs(xB - xL) * 0.12 + 0.03 * hash11(k * 0.37 + 0.5);
  let bL = lA - tL;
  let Em = mix(eO, eN, smoothstep(0.0, 0.25, bL));
  let E = Eb + Em;
  let ax = max(1.0 + E, 0.3);
  let ay = max(1.0 - E, 0.3);

  // Bead coverage, anti-aliased by the pixel footprint.
  let e = P - B;
  let w = vec2f(dot(e, ur) / (rho * ax), dot(e, ut) / (rho * ay));
  let rn = length(w);
  let fwn = fp / (rho * min(ax, ay));
  // No bead within reach (nb.x is 1e9): no coverage.
  let cov = step(nb.x, 1.5) * (1.0 - smoothstep(1.0 - fwn, 1.0 + fwn, rn));
  let fade = smoothstep(0.8, 2.0, rho / fp);

  // Glossy sphere normal.
  let hgt = sqrt(max(1.0 - rn * rn, 0.0));
  let nxy = ur * w.x + ut * w.y;
  let N = normalize(vec3f(nxy, hgt));
  let L = normalize(vec3f(-0.5, 0.55, 0.7));
  let Hv = normalize(L + vec3f(0.0, 0.0, 1.0));
  let dif = max(dot(N, L), 0.0);
  let spc = pow(max(dot(N, Hv), 0.0), 60.0);
  let fres = pow(1.0 - N.z, 2.0);

  let H0 = S.p[5].x;
  // Kick: a hot front running out along one 21-arm from its ignition index (beads off the arm lag).
  let kI = S.p[2].x; let kA = S.p[2].y;
  let dI = k - kI;
  let mo = dI - 21.0 * floor(dI / 21.0);
  let Tk = dI / 21.0 * 0.035 + min(mo, 21.0 - mo) * 0.012;
  let bK = kA - Tk;
  let heat = select(0.0, smoothstep(0.0, 0.1, bK) * exp(-bK * 6.0), dI >= 0.0) * exp(-kA * 1.3) * S.p[2].w;
  // Snare: a cool front running inward along a 34-arm from the outer edge; behind it the second family
  // takes a new hue for good.
  let sI = S.p[3].x; let sA = S.p[3].y; let sN = S.p[3].z;
  let dS = sI - k;
  let mS = dS - 34.0 * floor(dS / 34.0);
  let Ts = dS / 34.0 * 0.03 + min(mS, 34.0 - mS) * 0.01;
  let bS = sA - Ts;
  let sPass = smoothstep(0.0, 0.4, bS) * step(0.0, dS);
  let sh = select(0.0, smoothstep(0.0, 0.08, bS) * exp(-bS * 9.0), dS >= 0.0) * exp(-sA * 1.8) * S.p[3].w;
  // (sN is the level-weighted snare sum, so a faint snare turns the hue a little.)
  let snState = sN - S.p[3].w * (1.0 - sPass);
  // Hue: the palette sets the base (H0). On top, the hue turns across the frame, each 34-arm turns by its
  // own amount, and family B turns a third of a circle more (half a circle goes cool, and the warm
  // split-tone of the post chain darkens cool hues, so that family would vanish). The snare steps family B.
  let rot = 0.45 * q.x + 0.08 * q.y + 0.33 * fam + 0.3 * hash11(fmod(k, 34.0) + 0.5) + 0.19 * fam * max(snState, 0.0);
  // Mid-range levels: the post chain's tone curve pulls bright saturated colour toward white, so the
  // bodies stay well below full scale and only the fronts run hot. The rim shares the body's hue.
  var bead = ps_col(H0, 0.2, rot) * (0.15 + 0.8 * dif) * (0.3 + 0.7 * hgt);
  bead += ps_col(H0, 0.35, rot) * fres * 0.4;
  bead += vec3f(1.0) * spc * 0.06;
  // Fronts: the kick's fire, the snare's cool spark, and the melody's glow in the note colour.
  let snC = ps_col(H0 + 0.62, 1.0, 0.0);
  let lC = ps_col(H0 + 0.3 + 0.25 * xL, 1.0, 0.0);
  let gl = smoothstep(0.0, 0.12, bL) * exp(-bL * 5.0) * exp(-lA * 1.6) * S.p[1].w;
  bead += ps_fire(heat) * 2.0 + snC * sh * 2.0 + lC * gl * 3.0;
  bead *= cov * fade;
  // Hue-preserving highlight limit: over-bright beads keep their colour instead of clipping to cream.
  let pk = max(bead.r, max(bead.g, bead.b));
  bead = bead / max(pk, 1.0);
  return vec4f(bead, 1.0);
}
`,
});
