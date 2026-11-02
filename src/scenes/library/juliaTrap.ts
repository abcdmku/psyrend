import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';
import { Spring } from '../anim';

/**
 * Julia Trap: a zoomed-in Julia set of f(z) = (1-p) z^2 + p z^4 + c, fragment-only. The frame is
 * filled with its filaments and spirals (never the whole set floating in a void), coloured by smooth
 * orbit traps: the minimum distance of the orbit to a point, a line or a circle, with the trap
 * blending point -> line -> circle -> point. Each tube of the trap is a glossy neon band whose
 * width and gradient come from the same exact derivative (dz/dz0), so every band edge is
 * anti-aliased by one pixel. Depth comes from the smooth iteration count. The exterior stays near
 * black: colour lives on the filaments, the trap bands and their glow.
 *
 * The view always sits on the boundary. The host samples the escape-time grid, finds where the
 * boundary crosses it, and eases the zoom centre toward the crossing nearest the phrase's anchor
 * (tracking one boundary point, with hysteresis). The zoom is widened until the frame holds at least
 * COVER_MIN boundary crossings. The trap point and circle sit on that centre, so the bands land on it.
 *
 * Each phrase is a new Julia set: a new c angle on the cardioid, a new bulb blend, a discrete power
 * (z^2, mixed, z^4), a new anchor, view angle, trap offset and zoom. The state eases to each new
 * target over about 1.5 s. Within a phrase the morph drifts c, the trap and the zoom slowly.
 *  - morph: the slow drift; kicks and snares step c and the trap shape for good (eased globally).
 *  - kick: a front of colour lit in the screen; behind it every band it crossed takes the next hue.
 *    Its heat is white, yellow, orange, with embers that cool.
 *  - snare: a cool crackle from another point; behind it the band widths are re-cut.
 *  - melody: the pitch leans the cardioid angle (slowly, by the notes' strength, so the set's topology
 *    follows the tune without re-laying the frame). Each note lights a front in its own colour at a
 *    height set by its pitch; the melody bands lean to it behind the front.
 *  Fronts only colour the trap bands. They never pulse the whole frame. Every front's light and step
 *  scales with its event's level and rises over about 0.1 s where it passes.
 *
 * DNA: 0 start, 1 view angle, 2 note colour, 3 palette, 4 kick placement, 5 snare placement, 6 note placement, 7 scale.
 */

const TAU = Math.PI * 2;
const ASPECT = 16 / 9;
/** Escape-time iterations on the host (matches the shader's escape radius of 20). */
const ITER = 40;
/** Frame sample grid for coverage, and the plane grid for boundary candidates. */
const GX = 14;
const GY = 8;
const CG = 44;
const CSPAN = 1.3;

/** Eased per-phrase state. */
interface Phrase {
  phi: number;
  beta: number;
  pw: number;
  del: number;
  sc: number;
  rot: number;
  trap: number;
  anc: number;
  ancR: number;
}
const BASE: Phrase = { phi: 0, beta: 0.1, pw: 0.5, del: 0, sc: 0.5, rot: 0, trap: 0, anc: 0, ancR: 0.6 };

const morph = new Morph(0.9);
const st = {
  seed: -1,
  n: -1,
  k: -1,
  s: -1,
  /** The melody's lean of c: follows pitch x strength squared on a slow critically damped spring. */
  pe: new Spring(0, 1.0),
  /** Level-weighted kick sum (the lasting hue state) and the note colours (new, previous). */
  kSum: 0,
  kLast: 0,
  noteH: 0,
  noteHOld: 0,
  /** The melody's weight (note level squared) for the new and previous note. */
  lNew: 0,
  lOld: 0,
  phrase: -1,
  kz: [0, 0] as [number, number],
  sz: [0, 0] as [number, number],
  nz: [0, 0] as [number, number],
  tgt: { ...BASE },
  cur: { ...BASE },
  zc: null as [number, number] | null,
  zcT: null as [number, number] | null,
  viewF: 1,
  scale: 0.5,
  tick: 0,
};

const hash = (x: number) => {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeTo = (v: number, t: number, k: number, period = 0) => {
  let d = t - v;
  if (period) d -= period * Math.round(d / period);
  return v + d * k;
};

/**
 * A new Julia set for this phrase: every target is drawn from the cue's DNA and the phrase number.
 * The c angle is the richest of six hashed angles on the cardioid (most boundary crossings), so the
 * phrase's set has many filaments to show, and it is still different from the last phrase.
 */
function retarget(seed: number, n: number): Phrase {
  const h = (k: number) => hash((n + 1) * 12.9898 * k + seed * 78.233 + k * 4.1);
  const pw = [0.05, 0.4, 0.75][Math.min(2, Math.floor(h(3) * 3))];
  let phi = TAU * h(1);
  let bestRich = -1;
  for (let j = 0; j < 12; j++) {
    const t = TAU * h(10 + j);
    const cr = 1.04 * (0.5 * Math.cos(t) - 0.25 * Math.cos(2 * t));
    const ci = 1.04 * (0.5 * Math.sin(t) - 0.25 * Math.sin(2 * t));
    const rich = boundary(pw, cr, ci).length;
    if (rich > bestRich) {
      bestRich = rich;
      phi = t;
    }
  }
  return {
    phi,
    beta: 0.35 * h(2),
    pw,
    del: 0.02 + 0.05 * h(4),
    sc: 0.2 + 0.25 * h(5),
    rot: TAU * h(6),
    trap: 3 * h(7),
    anc: TAU * h(8),
    ancR: 0.35 + 0.5 * h(9),
  };
}

/** Escape test on the host, with the same power blend as the shader. */
function escapes(zx: number, zy: number, cr: number, ci: number, pw: number): boolean {
  let x = zx;
  let y = zy;
  for (let n = 0; n < ITER; n++) {
    const x2 = x * x - y * y;
    const y2 = 2 * x * y;
    const x4 = x2 * x2 - y2 * y2;
    const y4 = 2 * x2 * y2;
    x = (1 - pw) * x2 + pw * x4 + cr;
    y = (1 - pw) * y2 + pw * y4 + ci;
    if (x * x + y * y > 400) return true;
  }
  return false;
}

/**
 * How the boundary sits in the frame. ring: escape changes around the frame's edge (each one is a
 * place the boundary enters or leaves the frame). out: the escaping share of the frame. Mirrors the shader's view map.
 */
function coverage(cx: number, cy: number, vr: number, s: number, pw: number, cr: number, ci: number): { ring: number; out: number } {
  const co = Math.cos(vr);
  const si = Math.sin(vr);
  const ok = new Uint8Array(GX * GY);
  for (let j = 0; j < GY; j++) {
    for (let i = 0; i < GX; i++) {
      const qx = ((i + 0.5) / GX) * 2 - 1;
      const qy = -(((j + 0.5) / GY) * 2 - 1);
      const x = qx * ASPECT;
      ok[j * GX + i] = escapes(cx + (co * x - si * qy) * s, cy + (si * x + co * qy) * s, cr, ci, pw) ? 1 : 0;
    }
  }
  // The edge of the frame, walked once round.
  const edge: number[] = [];
  for (let i = 0; i < GX; i++) edge.push(ok[i]);
  for (let j = 1; j < GY; j++) edge.push(ok[j * GX + GX - 1]);
  for (let i = GX - 2; i >= 0; i--) edge.push(ok[(GY - 1) * GX + i]);
  for (let j = GY - 2; j >= 1; j--) edge.push(ok[j * GX]);
  let ring = 0;
  for (let k = 0; k < edge.length; k++) if (edge[k] !== edge[(k + 1) % edge.length]) ring++;
  let escaped = 0;
  for (let k = 0; k < ok.length; k++) escaped += ok[k];
  return { ring, out: escaped / ok.length };
}

/** Boundary arcs the frame must show (entries and exits at its edge) before the view is accepted. */
const RING_MIN = 4;

/** Midpoints of boundary crossings on a plane grid: the points of the Julia set's boundary. */
function boundary(pw: number, cr: number, ci: number): [number, number][] {
  const coord = (i: number) => -CSPAN + ((i + 0.5) / CG) * 2 * CSPAN;
  const ok = new Uint8Array(CG * CG);
  for (let j = 0; j < CG; j++) for (let i = 0; i < CG; i++) ok[j * CG + i] = escapes(coord(i), coord(j), cr, ci, pw) ? 1 : 0;
  const out: [number, number][] = [];
  for (let j = 0; j < CG; j++) {
    for (let i = 0; i < CG; i++) {
      const v = ok[j * CG + i];
      if (i + 1 < CG && ok[j * CG + i + 1] !== v) out.push([(coord(i) + coord(i + 1)) / 2, coord(j)]);
      if (j + 1 < CG && ok[(j + 1) * CG + i] !== v) out.push([coord(i), (coord(j) + coord(j + 1)) / 2]);
    }
  }
  return out;
}

/**
 * Picks a boundary point and a zoom. The `maxN` boundary crossings nearest `ref` are tried, each at a
 * 0.6x, full and 1.6x zoom, and scored by their boundary arcs in the frame; the best wins.
 */
function pickView(
  cand: [number, number][],
  ref: [number, number],
  maxN: number,
  arcs: (z: [number, number], f: number) => number,
): { z: [number, number]; f: number } {
  if (!cand.length) return { z: ref, f: 1 };
  const d = (p: [number, number]) => (p[0] - ref[0]) ** 2 + (p[1] - ref[1]) ** 2;
  // Evenly spaced across the whole boundary (so different arcs are tried), and the nearest one first.
  const stride = Math.max(1, Math.floor(cand.length / maxN));
  const order: [number, number][] = [cand.reduce((b, p) => (d(p) < d(b) ? p : b), cand[0])];
  for (let i = 0; i < cand.length; i += stride) order.push(cand[i]);
  let best = { z: order[0], f: 1, score: -1 };
  for (const z of order) {
    for (const f of [1, 0.6, 1.6]) {
      const s = arcs(z, f);
      if (s > best.score) best = { z, f, score: s };
    }
  }
  return { z: best.z, f: best.f };
}

export default raymarchScene({
  meta: {
    id: 'julia-trap',
    name: 'Julia Trap',
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.6 },
    genres: { edm: 0.9, techno: 0.8, ambient: 0.8, synthwave: 1, pop: 0.7, dnb: 0.7, dubstep: 0.7, hiphop: 0.6, rock: 0.5, classical: 0.5 },
    trails: 0,
    kaleido: false,
    // Default-song sheet still has single-arc frames and too much black (coloured, void, bass corr fail).
    auto: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    const a = morph.at;

    // A new cue (or a seek) snaps every eased state to its targets.
    const cue = g[0] !== st.seed || morph.notes < st.n;
    if (cue) {
      st.seed = g[0];
      st.n = morph.notes;
      st.k = -1;
      st.s = -1;
      st.pe.reset(morph.notePitch * morph.noteLevel ** 2);
      st.lNew = st.lOld = 0;
      st.kSum = st.kLast = 0;
      st.noteH = st.noteHOld = g[2] + 0.5;
      st.phrase = -1;
      st.zc = null;
      st.zcT = null;
    }
    const justNoted = morph.notes !== st.n;
    if (justNoted) st.n = morph.notes;
    // The melody pitch leans the set by the note's strength (a faint motif barely, a strong lead
    // fully), gliding from rest over a couple of seconds. Never a jump of the whole set.
    const pe = st.pe.update(morph.notePitch * morph.noteLevel ** 2, dt);

    // Event ignition points, fixed when each event lands (screen plane, y up).
    if (morph.kicks !== st.k) {
      st.kSum = (st.kSum + st.kLast) % 1024;
      st.kLast = morph.kickLevel;
      st.k = morph.kicks;
      const an = morph.kicks * 2.4 + g[4] * TAU;
      st.kz = [0.5 * ASPECT * Math.cos(an), 0.5 * Math.sin(an)];
    }
    if (morph.snares !== st.s) {
      st.s = morph.snares;
      const an = morph.snares * 1.9 + g[5] * TAU;
      st.sz = [0.7 * ASPECT * Math.sin(an), 0.6 * Math.cos(an)];
    }
    if (justNoted) {
      // The note's colour, reached in proportion to its strength (the short way round the wheel).
      const full = g[2] + 0.5 + morph.notes * 0.29 + morph.notePitch * 0.25 + (m.centroid - 0.5) * 0.2;
      const dh = full - st.noteH - Math.round(full - st.noteH);
      st.noteHOld = st.noteH;
      st.noteH += morph.noteLevel * dh;
      st.lOld = st.lNew;
      st.lNew = morph.noteLevel ** 2;
      st.nz =[0.9 * ASPECT * 0.5 * Math.sin(morph.notes * 2.1 + g[6] * TAU), 0.75 * morph.notePitch];
    }

    // Each phrase redefines the set: new targets, and the state eases to them.
    const phraseChanged = morph.phrases !== st.phrase;
    if (phraseChanged) {
      st.phrase = morph.phrases;
      st.tgt = retarget(g[0], morph.phrases);
    }
    const tgt = st.tgt;
    const cur = st.cur;
    // A new phrase is a new Julia set: it cuts to its view. Only the morph drift moves between phrases.
    if (cue || phraseChanged) {
      Object.assign(cur, tgt);
    } else {
      const k = 1 - Math.exp(-dt / 1.5);
      cur.phi = easeTo(cur.phi, tgt.phi, k, TAU);
      cur.beta = easeTo(cur.beta, tgt.beta, k);
      cur.pw = easeTo(cur.pw, tgt.pw, k);
      cur.del = easeTo(cur.del, tgt.del, k);
      cur.sc = easeTo(cur.sc, tgt.sc, k);
      cur.rot = easeTo(cur.rot, tgt.rot, k, TAU);
      cur.trap = easeTo(cur.trap, tgt.trap, k, 3);
      cur.anc = easeTo(cur.anc, tgt.anc, k, TAU);
      cur.ancR = easeTo(cur.ancR, tgt.ancR, k);
    }

    // The drift (0.35x) keeps the set moving between events, so the events carry the frame's change.
    const pwNow = clamp01(cur.pw + 0.08 * Math.sin(0.35 * a[6]));
    const beta = Math.min(0.4, Math.max(0, cur.beta + 0.04 * Math.sin(0.35 * a[2])));
    const kr = 1 + cur.del + 0.02 * Math.sin(0.35 * a[1]);
    // c on the Mandelbrot boundary: the cardioid e^{it}/2 - e^{2it}/4, blended toward the bulb -1 + e^{is}/4.
    const phi = cur.phi + 0.35 * a[0] + 0.9 * pe;
    const cardRe = 0.5 * Math.cos(phi) - 0.25 * Math.cos(2 * phi);
    const cardIm = 0.5 * Math.sin(phi) - 0.25 * Math.sin(2 * phi);
    const bulbA = cur.anc + 0.35 * a[3];
    const cr = kr * ((1 - beta) * cardRe + beta * (-1 + 0.25 * Math.cos(bulbA)));
    const ci = kr * ((1 - beta) * cardIm + beta * 0.25 * Math.sin(bulbA));

    // The view's rotation and base zoom for this phrase.
    const vr = cur.rot + 0.25 * Math.sin(0.35 * a[4]);
    const sBase = cur.sc * (1 + 0.08 * Math.sin(0.35 * a[7]));

    // Track a boundary point: refresh the candidates a few times a second, and on a new phrase.
    st.tick += dt;
    const anchor: [number, number] = [cur.ancR * Math.cos(cur.anc), cur.ancR * Math.sin(cur.anc)];
    if (st.zcT === null || st.tick >= 0.5 || cue || phraseChanged) {
      st.tick = 0;
      // Score a view by its boundary arcs in the frame; -1 if the frame is mostly interior or exterior.
      const arcs = (z: [number, number], f: number) => {
        const c = coverage(z[0], z[1], vr, sBase * f, pwNow, cr, ci);
        return c.out >= 0.1 && c.out <= 0.95 ? c.ring : -1;
      };
      // Within a phrase the view is kept while it still shows enough arcs as the c drifts; otherwise search again.
      const prev = st.zcT;
      const full = phraseChanged || cue || prev === null;
      const keep = !full && arcs(prev, st.viewF) >= RING_MIN;
      if (!keep) {
        const v = pickView(boundary(pwNow, cr, ci), full ? anchor : prev, full ? 60 : 30, arcs);
        st.zcT = v.z;
        st.viewF = v.f;
      }
    }
    const zT = st.zcT ?? anchor;
    if (!st.zc || cue || phraseChanged) st.zc = [zT[0], zT[1]];
    else {
      const kz = 1 - Math.exp(-dt / 1.2);
      st.zc = [st.zc[0] + (zT[0] - st.zc[0]) * kz, st.zc[1] + (zT[1] - st.zc[1]) * kz];
    }
    const zc = st.zc;

    // Zoom: the phrase's scale, widened only if no nearby boundary point frames at that scale.
    let kw = 1;
    while (kw < 1.4 && coverage(zc[0], zc[1], vr, sBase * st.viewF * kw, pwNow, cr, ci).ring < RING_MIN) kw *= 1.1;
    const sT = sBase * st.viewF * kw;
    st.scale = cue || phraseChanged ? sT : st.scale + (sT - st.scale) * (1 - Math.exp(-dt / 0.8));
    const scale = st.scale;

    // Trap: a point and a circle on the view centre, and a line through it, so the bands land on the boundary.
    const Px = zc[0] + 0.3 * scale * Math.cos(cur.anc);
    const Py = zc[1] + 0.3 * scale * Math.sin(cur.anc);
    const R = scale * (0.6 + 0.3 * Math.sin(0.35 * a[5] + cur.phi));
    // The trap shape steps with each kick (eased globally) and drifts with the phrase and the morph.
    const tS = ((morph.kickPhase + cur.trap + 0.3 * wave(0.35 * a[2], 0, 1)) % 3 + 3) % 3;

    // S.p[0] c, zoom centre.
    p[0] = cr;
    p[1] = ci;
    p[2] = zc[0];
    p[3] = zc[1];
    // S.p[1] zoom half-height, power p (z^2 to z^4), trap shape (point, line, circle), view angle.
    p[4] = scale;
    p[5] = pwNow;
    p[6] = tS;
    p[7] = vr;
    // S.p[2] trap point, circle radius, line angle.
    p[8] = Px;
    p[9] = Py;
    p[10] = R;
    p[11] = cur.anc + 0.5 * Math.sin(0.35 * a[3]);
    // S.p[3] event ages and palette.
    p[12] = Math.min(morph.kickAge, 9);
    p[13] = Math.min(morph.snareAge, 9);
    p[14] = Math.min(morph.leadAge, 9);
    p[15] = g[3];
    // S.p[4] event counts (lasting hue, width and mel-band states) and the note colour.
    p[16] = st.kSum + st.kLast;
    p[17] = morph.snares % 1024;
    p[18] = morph.notes % 1024;
    p[19] = st.noteH;
    // S.p[5], S.p[6] ignition points; drive and surge; flow.
    p[20] = st.kz[0];
    p[21] = st.kz[1];
    p[22] = st.sz[0];
    p[23] = st.sz[1];
    p[24] = st.nz[0];
    p[25] = st.nz[1];
    p[26] = morph.drive;
    p[27] = morph.surge;
    // S.p[7] the previous note's colour, and the latest kick / snare / note levels (scale each front).
    // (The previous note's colour in thousandths of a turn, its weight in the fraction.)
    p[28] = Math.floor((st.noteHOld - Math.floor(st.noteHOld)) * 1000) + 0.9 * st.lOld;
    p[29] = morph.kickLevel;
    p[30] = morph.snareLevel;
    p[31] = st.lNew;
  },
  wgsl: /* wgsl */ `
fn jt_cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

// Fire by heat (1 = just lit): white core, yellow, orange.
fn jt_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.25, 0.05) * h * 1.4 + vec3f(1.0, 0.62, 0.2) * h * h * 2.2 + vec3f(1.0, 0.95, 0.9) * pow(max(h, 0.0), 5.0) * 2.5;
}

// Neon ink: the palette hue at saturation 0.72 to 0.95, with perceived brightness evened out across hues.
fn jt_col(t: f32, lvl: f32, rot: f32) -> vec3f {
  let p = pal(t);
  let mx = max(p.r, max(p.g, p.b));
  let mn = min(p.r, min(p.g, p.b));
  let d = max(mx - mn, 1e-4);
  var h = select(select((p.r - p.g) / d + 4.0, (p.b - p.r) / d + 2.0, mx == p.g), (p.g - p.b) / d, mx == p.r);
  h = fract(h / 6.0);
  let s = mix(0.72, 0.95, sat((mx - mn) / max(mx, 1e-4)));
  let c = hsv2rgb(vec3f(fract(h + rot), s, 1.0));
  return c * lvl * pow(0.4 / max(luma(c), 0.08), 0.55);
}

// Tube half-width in pixels for a band in a snare state: glossy tubes, hairlines and gaps.
fn jt_width(fid: f32, st: f32) -> f32 {
  let r = hash12(vec2f(fid, 31.0 + 13.0 * st));
  let thick = 2.6 + 2.6 * hash12(vec2f(fid, 3.0 + st));
  let hair = 1.0 + 0.5 * hash12(vec2f(fid, 17.0 + st));
  return select(select(0.0, hair, r > 0.3), thick, r > 0.5);
}

// Arrival time of a front lit at o reaching the screen point q: it runs at speed v, and each band catches with its own delay.
fn jt_arrive(q: vec2f, o: vec2f, h: f32, v: f32) -> f32 {
  return length(q - o) / (v * (0.7 + 0.6 * h)) + 0.05 * h;
}

// Orbit trap at orbit point z (u = z - P) with derivative dz = dz/dz0. Returns the blended trap
// distance D and its gradient G in z0 units. The trap shape t3 in [0,3) walks point -> line -> circle -> point.
fn jt_trap(u: vec2f, dz: vec2f, nrm: vec2f, R: f32, t3: f32) -> vec3f {
  let rdz = vec2f(-dz.y, dz.x);
  let r = max(length(u), 1e-6);
  let dP = r;
  let gP = vec2f(dot(u, dz), dot(u, rdz)) / r;
  let L = dot(u, nrm);
  let dL = abs(L);
  let gL = select(-1.0, 1.0, L >= 0.0) * vec2f(dot(dz, nrm), dot(rdz, nrm));
  let dC = abs(r - R);
  let gC = select(-1.0, 1.0, r >= R) * gP;
  let w = smoothstep(0.0, 1.0, fract(t3));
  let k = min(u32(floor(t3)), 2u);
  var D: f32;
  var G: vec2f;
  if (k == 0u) {
    D = mix(dP, dL, w); G = mix(gP, gL, w);
  } else if (k == 1u) {
    D = mix(dL, dC, w); G = mix(gL, gC, w);
  } else {
    D = mix(dC, dP, w); G = mix(gC, gP, w);
  }
  return vec3f(D, G.x, G.y);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let c = S.p[0].xy;
  let scale = S.p[1].x;
  let pw = S.p[1].y;
  let t3 = fmod(S.p[1].z, 3.0);
  let vr = S.p[1].w;
  let P = S.p[2].xy;
  let R = S.p[2].z;
  let la = S.p[2].w;
  let nrm = vec2f(cos(la), sin(la));
  // The view: screen point -> orbit start z0 (y up), and one pixel in z0 units.
  let z0 = S.p[0].zw + rot2(vr) * q * scale;
  let pix = 2.0 * scale / F.res.y;

  // Escape-time orbit with the power blend p: f(z) = (1-p) z^2 + p z^4 + c.
  var z = z0;
  var dz = vec2f(1.0, 0.0);
  var best = 1e9;
  var bestG = vec2f(1.0, 0.0);
  var bestA = 0.0;
  var bestI = 0.0;
  var nu = 0.0;
  var esc = 0.0;
  var dzE = vec2f(1.0, 0.0);
  var mE = 1.0;
  for (var i = 0; i < 30; i++) {
    let u = z - P;
    let tr = jt_trap(u, dz, nrm, R, t3);
    if (tr.x < best) {
      best = tr.x;
      bestG = tr.yz;
      bestA = atan2(u.y, u.x);
      bestI = f32(i);
    }
    let z2 = jt_cmul(z, z);
    let z3 = jt_cmul(z2, z);
    let z4 = jt_cmul(z2, z2);
    dz = jt_cmul((1.0 - pw) * 2.0 * z + pw * 4.0 * z3, dz);
    z = (1.0 - pw) * z2 + pw * z4 + c;
    let m = length(z);
    if (m > 20.0) {
      esc = 1.0;
      nu = f32(i) + 1.0 - log(log(m) / log(20.0)) / log(2.0 + 2.0 * pw);
      dzE = dz;
      mE = m;
      break;
    }
  }

  // The set's boundary as a filament: the distance estimate 0.5 |z| log|z| / |dz| from the same derivative.
  let deE = 0.5 * mE * log(max(mE, 1.0001)) / max(length(dzE), 1e-9);
  let dpxE = deE / pix;
  let covF = clamp(2.0 - dpxE + 0.5, 0.0, 1.0) * esc;
  let fc = jt_col(S.p[3].w + 0.35 * (bestA / TAU) + 0.02 * nu, 0.5, 0.36 * step(0.5, fract(bestI * 0.31)));
  let filCol = mix(fc, vec3f(1.0, 0.92, 0.85), 0.3 * exp(-dpxE * 1.5));
  let filBloom = fc * exp(-dpxE * 0.12) * 0.35 * esc;

  // Distance to the trap curve in pixels, exact from the gradient; its screen direction for gloss.
  let gl = max(length(bestG), 1e-9);
  let dpx = best / (gl * pix);
  let gdir = rot2(-vr) * (bestG / gl);
  // Each tube is a band keyed by the orbit step that caught it and the trap's angle.
  let fid = bestI + 40.0 * floor((bestA / TAU + 0.5) * 8.0);
  let h = hash12(vec2f(fid, 7.0));

  let kA = S.p[3].x; let sA = S.p[3].y; let lA = S.p[3].z; let hue0 = S.p[3].w;
  let kN = S.p[4].x; let sN = S.p[4].y; let nN = S.p[4].z; let noteH = S.p[4].w;
  let surge = S.p[6].w;
  // The previous note's colour and the latest event levels: every front scales with its event.
  // (The melody's weights are the note levels squared: a faint motif only tints its bands.)
  let noteHOld = floor(S.p[7].x) / 1000.0; let lOld = fract(S.p[7].x) / 0.9;
  let kL = S.p[7].y; let sL = S.p[7].z; let nL = S.p[7].w;

  // Fronts: arrival times from the ignition points; each is a colour front riding the bands.
  let tK = jt_arrive(q, S.p[5].xy, h, 2.8);
  let tSn = jt_arrive(q, S.p[5].zw, h, 4.5);
  let tL = jt_arrive(q, S.p[6].xy, h, 7.0);
  let bK = kA - tK;
  let bS = sA - tSn;
  let bL = lA - tL;

  // Lasting states: the hue steps behind the kicks, the widths are re-cut behind the snares.
  // (kN is the level-weighted kick sum, so a faint kick steps the hue a little.)
  let hState = kN - kL * (1.0 - smoothstep(0.0, 0.6, bK));
  let hw = mix(jt_width(fid, sN - 1.0), jt_width(fid, sN), smoothstep(0.0, 0.9, bS));
  let cov = clamp(hw - dpx + 0.5, 0.0, 1.0) * step(0.01, hw);
  let t = clamp(dpx / max(hw, 0.25), 0.0, 1.0);
  let hgt = sqrt(max(1.0 - t * t, 0.0));

  // Depth from the smooth iteration count; interior orbits are dimmed, not blacked out.
  let dep = 1.0 - exp(-nu * 0.12);
  let lvl = mix(0.6, 1.0, dep) * mix(0.5, 1.0, esc);

  // Each band: the palette hue for its state, with an accent family turned 0.36 turns.
  let hue = hue0 + 0.75 * fract(h * 3.7 + 0.13 * hState);
  let acc = step(0.5, fract(h * 2.9));
  let rot = acc * (0.36 + 0.1 * sin(hState * 0.7));
  var base = jt_col(hue, 0.42, rot);
  // Melody bands: ahead of the note's front they keep the previous note's bands and colour, behind
  // it they take the new ones, so a note only changes what its front has reached.
  let noteCol = jt_col(noteH, 0.38, 0.0);
  let melOld = step(0.6, fract(h * 2.3 + 0.37 * (nN - 1.0)));
  let melNew = step(0.6, fract(h * 2.3 + 0.37 * nN));
  let passL = smoothstep(0.0, 0.4, bL);
  base = mix(mix(base, jt_col(noteHOld, 0.38, 0.0), melOld * 0.8 * lOld), mix(base, noteCol, melNew * 0.8 * nL), passL);

  // Glossy tube: normal from the band profile across the gradient direction.
  let slope = t / max(hgt, 0.2);
  let nrmT = normalize(vec3f(gdir * slope * 0.9, 1.0));
  let ld = normalize(vec3f(-0.45, 0.6, 0.75));
  let hv = normalize(ld + vec3f(0.0, 0.0, 1.0));
  let dif = 0.25 + 0.75 * max(dot(nrmT, ld), 0.0);
  let spc = pow(max(dot(nrmT, hv), 0.0), 70.0);
  let fres = pow(1.0 - nrmT.z, 2.0);
  var band = base * (0.25 + 0.9 * hgt) * dif * lvl;
  band += jt_col(hue + 0.22, 0.4, rot) * fres * 0.6 * lvl;
  band += mix(vec3f(0.6), base * 2.5, 0.7) * spc * 0.5 * lvl;

  // Fronts as colour on the bands: a hot head and embers from the kick, a cool crackle from the snare, the note's colour.
  // Each rises over about 0.1 s where the front passes (never a one-frame flash) and scales with its level.
  let heat = smoothstep(0.0, 0.1, bK) * exp(-bK * 5.0) * exp(-kA * 1.3) * kL;
  let emb = smoothstep(0.0, 0.15, bK) * exp(-bK * 1.2) * step(0.7, hash12(vec2f(floor(nu * 3.0), fid))) * exp(-kA * 0.35) * kL;
  let sh = smoothstep(0.0, 0.08, bS) * exp(-bS * 9.0) * exp(-sA * 1.8) * sL;
  let lh = smoothstep(0.0, 0.15, bL) * exp(-bL * 2.5) * exp(-lA * 2.0) * nL;
  let sCol = mix(jt_col(hue0 + 0.55, 0.8, 0.0), vec3f(0.3, 0.55, 0.9), 0.3);
  band += jt_fire(heat) * 1.3 + jt_fire(0.3) * emb * 0.5 + sCol * sh * 2.4 + noteCol * lh * 3.5;

  // Glow in the gaps next to burning bands, and a soft bloom round the tubes only. The exterior is near-black.
  let gap = max(dpx - hw, 0.0);
  let halo = exp(-gap * 0.35) * (heat * 0.5 + sh * 0.6 + lh * 0.3);
  let bloom = exp(-gap * 0.16) * 0.3 * lvl;
  let bg = jt_col(hue0 + 0.7 + 0.03 * nu, 0.02 * lvl * (1.0 + surge), 0.18 * (1.0 - cos(nu * 0.45)));
  var col = band * cov + bg * (1.0 - cov) + base * bloom + (jt_fire(heat) * 0.3 + sCol * sh * 0.5 + noteCol * lh * 1.0) * halo;
  col += (filCol * covF + filBloom) * (0.6 + 0.4 * dep);
  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.3 * max(pk - 0.9, 0.0));
  return vec4f(col, 1.0);
}
`,
});
