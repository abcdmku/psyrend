import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

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

/**
 * The strength of every event since a seed, by index (1-based), with running sums (over all events,
 * and over the odd and the even ones). A front phase glides over the event count; the shader needs, at
 * the glide's integer part N, the levels of events N and N + 1 (the two that can be in flight), so
 * every front and the lasting step it leaves keep the strength of their own hit.
 */
class Levels {
  private lv = [0];
  private odd = [0];
  private even = [0];
  total = 0;
  reset(): void {
    this.lv = [0];
    this.odd = [0];
    this.even = [0];
    this.total = 0;
  }
  /** Records new events up to `count`, each with the latest event strength. */
  sync(count: number, level: number): void {
    while (this.lv.length <= count) {
      const i = this.lv.length;
      this.lv.push(level);
      this.total += level;
      this.odd.push(this.odd[i - 1] + (i % 2 ? level : 0));
      this.even.push(this.even[i - 1] + (i % 2 ? 0 : level));
    }
  }
  /** Levels of events N and N + 1, packed as floor(1000 a) + 0.999 b. */
  ab(x: number): number {
    const N = Math.max(0, Math.floor(x));
    const a = N >= 1 ? (this.lv[N] ?? 0) : 0;
    return Math.floor(a * 1000) + 0.999 * (this.lv[N + 1] ?? 0);
  }
  /** Summed levels of the odd and the even events before N, wrapped (3 and 5) and packed in one float. */
  sums(x: number): number {
    const N = Math.max(1, Math.floor(x));
    const o = this.odd[N - 1] % 3;
    const e = this.even[N - 1] % 5;
    return Math.floor(o * 1000) + (0.999 * e) / 5;
  }
}

/**
 * Hyperbolic Weave: a {p,q} hyperbolic tiling seen through the band model, gliding along it.
 *
 * The frame is a strip of the hyperbolic plane, w = X + iY with 0 < Y < pi, mapped to the half-plane
 * by z = exp(w) and to the Poincare disk by the Cayley map. The strip's metric is |dw| / sin Y, so
 * tiles shrink toward the top and bottom edges of the frame and the picture has no disk rim. A
 * screen point's disk position is then moved by a running disk isometry M (a Mobius map, or
 * anti-Mobius when flipped). Gliding is M <- M o T, with T a hyperbolic translation whose direction
 * the melody sets. Every pixel is folded into the {p,q} fundamental triangle by reflections in its
 * three sides, which gives the tile; the fold's accumulated Jacobian gives the exact pixel footprint.
 *
 * The triangle has angles pi/p at the polygon centre, pi/2 at an edge midpoint and pi/q at a vertex.
 * Its sides are two spoke mirrors (through the centre, drawn as a second, finer weave) and the
 * polygon edge (drawn as glossy tubes). Each family has its own hue, offset by 0.42 of a turn.
 *
 * Gliding by a non-group isometry drifts the view, so the view is re-centred with the tiling's own
 * group element G (the fold). Picture(M) = Picture(G o M), so the reset is invisible. A phrase cross-
 * fades between the two tilings with the same view; the reset waits until the fade is complete.
 *
 * Music:
 *  - morph: p and q change each phrase (a cross-fade to the new tiling); the glide speed follows the
 *    flow and bass; the edge style (width and glow of the tubes) drifts with the morph.
 *  - melody: each note turns the glide toward its pitch (a critically damped spring, about half a
 *    second), surges the weave a short way along it (squared by strength), and lights a front just off
 *    the view centre that fades with distance (a local ripple) in
 *    the edge colour.
 *  - kick: surges the glide one step further (kept for good), easing in from rest over 0.4 s, with
 *    a fire front lit at the view centre that burns along the polygon edges (the spokes keep their
 *    own colour, so both hue families always show).
 *  Every front is a phase that follows the event count (each hit eases in by smoothstep over 0.4 s),
 *  so a front glows up and fades as it passes the point, and nothing can snap however dense the hits.
 *  - snare: turns the weave about the view centre and slides it sideways across the heading (each
 *    eased in by smoothstep over a third of a second; a turn alone can land near one of the tiling's
 *    own symmetries, the slide never does), and a cool front from another point re-tints the two
 *    edge families in turn (the spokes and the polygon edges alternate), and each re-tint stays.
 *  Every event's reaction (its surge, turn, front glow and lasting re-tint) scales with that hit's own
 *  strength (morph's event levels captured per event; kicks and snares squared), so a faint hit makes a faint change.
 *  Fine scale (high melody, arps, backing): the spokes are beaded, their width rippling along each
 *  spoke; morph.detailAt flows the ripple and every upper note (by its strength, eased) and backing
 *  chord shifts it on, so the high end re-forms the fine weave while the bass drives the glide.
 *  Colour: the spokes are a second hue family turned 125-145 degrees from the edges; tiles are
 *  near-black glass, and the fronts light the lines, not the space between them.
 *  - drops: rush the glide (speed x (1 + 5 surge)).
 *
 * DNA: 0 start, 1 glide start angle, 2 tiling choice, 3 palette, 4 unused, 5 weave style (bold edges
 * or fine lace), 6 unused, 7 zoom.
 */

type Cx = [number, number];
/** A disk isometry: z -> (a z + b)/(c z + d), applied to conj(z) when f = 1. */
interface Iso {
  m: [Cx, Cx, Cx, Cx];
  f: number;
}
/** Fundamental triangle of {p,q}: the fold mirrors are y = 0, n2 . v = 0 and the circle |v - (cc,0)| = rc. */
interface Tiling {
  p: number;
  q: number;
  n2: [number, number];
  cc: number;
  rc: number;
}

const PQ: [number, number][] = [
  [4, 5], [5, 4], [4, 6], [6, 4], [5, 5], [8, 3], [3, 8], [6, 6], [4, 8],
];

const ID: Iso = { m: [[1, 0], [0, 0], [0, 0], [1, 0]], f: 0 };
const CONJ: Iso = { m: ID.m, f: 1 };

const cmul = (a: Cx, b: Cx): Cx => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cadd = (a: Cx, b: Cx): Cx => [a[0] + b[0], a[1] + b[1]];
const cconj = (a: Cx): Cx => [a[0], -a[1]];
const cdiv = (a: Cx, b: Cx): Cx => {
  const n = Math.max(b[0] * b[0] + b[1] * b[1], 1e-20);
  return [(a[0] * b[0] + a[1] * b[1]) / n, (a[1] * b[0] - a[0] * b[1]) / n];
};
const expI = (t: number): Cx => [Math.cos(t), Math.sin(t)];
const smooth = (x: number) => x * x * (3 - 2 * x);
const wrapPi = (x: number) => {
  let y = (x + Math.PI) % (2 * Math.PI);
  if (y < 0) y += 2 * Math.PI;
  return y - Math.PI;
};

function mmul(A: Iso['m'], B: Iso['m']): Iso['m'] {
  return [
    cadd(cmul(A[0], B[0]), cmul(A[1], B[2])),
    cadd(cmul(A[0], B[1]), cmul(A[1], B[3])),
    cadd(cmul(A[2], B[0]), cmul(A[3], B[2])),
    cadd(cmul(A[2], B[1]), cmul(A[3], B[3])),
  ];
}

/** T o S: applies S first. The conjugate of S's matrix is used when T is flipped. */
function compose(T: Iso, S: Iso): Iso {
  const sm = T.f ? (S.m.map(cconj) as Iso['m']) : S.m;
  const m = mmul(T.m, sm);
  let s = 0;
  for (const e of m) s += e[0] * e[0] + e[1] * e[1];
  s = Math.sqrt(s) || 1;
  return { m: m.map((e) => [e[0] / s, e[1] / s]) as Iso['m'], f: T.f ^ S.f };
}

function applyIso(S: Iso, z: Cx): Cx {
  const w = S.f ? cconj(z) : z;
  const [a, b, c, d] = S.m;
  return cdiv(cadd(cmul(a, w), b), cadd(cmul(c, w), d));
}

/** Hyperbolic translation by distance e along the disk diameter in direction phi. */
function glide(e: number, phi: number): Iso {
  const t = Math.tanh(e / 2);
  const bx = t * Math.cos(phi);
  const by = t * Math.sin(phi);
  return { m: [[1, 0], [-bx, -by], [-bx, by], [1, 0]], f: 0 };
}

function tilingOf(p: number, q: number): Tiling {
  const a = Math.PI / p;
  // Hyperbolic law of cosines for the right triangle: cosh(centre to edge midpoint) = cos(pi/q) / sin(pi/p).
  const d = Math.acosh(Math.cos(Math.PI / q) / Math.sin(a));
  const m = Math.tanh(d / 2);
  return { p, q, n2: [-Math.sin(a), Math.cos(a)], cc: (1 + m * m) / (2 * m), rc: (1 - m * m) / (2 * m) };
}

function pickTiling(g: readonly number[], phrase: number, avoid: Tiling | null): Tiling {
  const h = (((g[2] * 13.7 + phrase * 0.6180339) % 1) + 1) % 1;
  let i = Math.floor(h * PQ.length);
  if (avoid && PQ[i][0] === avoid.p && PQ[i][1] === avoid.q) i = (i + 1) % PQ.length;
  return tilingOf(PQ[i][0], PQ[i][1]);
}

/**
 * Re-centres the view. Folds v into the fundamental triangle and returns the accumulated isometry G
 * (G(v) lands in the triangle), so Picture(G o M) = Picture(M).
 */
function foldReset(v: Cx, T: Tiling): Iso {
  const a = Math.PI / T.p;
  const R2: Iso = { m: [expI(a), [0, 0], [0, 0], expI(-a)], f: 1 };
  const R3: Iso = { m: [[T.cc, 0], [T.rc * T.rc - T.cc * T.cc, 0], [1, 0], [-T.cc, 0]], f: 1 };
  const [nx, ny] = T.n2;
  let G = ID;
  let x = v;
  for (let i = 0; i < 48; i++) {
    let moved = false;
    if (x[1] < 0) {
      x = [x[0], -x[1]];
      G = compose(CONJ, G);
      moved = true;
    }
    const dd = x[0] * nx + x[1] * ny;
    if (dd > 0) {
      x = [x[0] - 2 * dd * nx, x[1] - 2 * dd * ny];
      G = compose(R2, G);
      moved = true;
    }
    const wx = x[0] - T.cc;
    const r2 = Math.max(wx * wx + x[1] * x[1], 1e-12);
    if (r2 < T.rc * T.rc) {
      const k = (T.rc * T.rc) / r2;
      x = [T.cc + wx * k, x[1] * k];
      G = compose(R3, G);
      moved = true;
    }
    if (!moved) break;
  }
  return G;
}

const morph = new Morph(0.9);
const st = {
  seed: -1,
  M: ID as Iso,
  phi: 0,
  target: 0,
  phiVel: 0,
  /** Total surge the events asked for, and the spring that glides toward it (applied along phi). */
  surge: 0,
  surgeAt: 0,
  surgeG: new Glide(0, 0.4),
  /** Snares turn the weave about the view centre: a glide of 0.7 rad per snare. */
  spin: new Glide(0, 0.32),
  spinAt: 0,
  /** Snares also slide the weave sideways (across the heading): a glide of 0.5 per snare. */
  side: new Glide(0, 0.32),
  sideAt: 0,
  kicks: 0,
  snares: 0,
  notes: 0,
  phrases: 0,
  A: tilingOf(4, 5),
  B: tilingOf(4, 5),
  fade: 1,
  mix: 0,
  /** Glides following the kick, snare and note counts since the seed: the fronts' phases. */
  xk: new Glide(0, 0.4),
  xs: new Glide(0, 0.4),
  xn: new Glide(0, 0.4),
  /** Each event's strength by index. */
  lk: new Levels(),
  ls: new Levels(),
  ln: new Levels(),
  k0: 0,
  s0: 0,
  n0: 0,
};

const SHADER = /* wgsl */ `
fn hw_cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn hw_cdiv(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / max(dot(b, b), 1e-20); }
fn hw_conj(a: vec2f) -> vec2f { return vec2f(a.x, -a.y); }

// The disk isometry z -> (a z + b)/(c z + d), applied to conj(z) when flipped. n0 = (a, b), n1 = (c, d).
fn hw_apply(n0: vec4f, n1: vec4f, flip: f32, z0: vec2f) -> vec2f {
  let z = select(z0, hw_conj(z0), flip > 0.5);
  return hw_cdiv(hw_cmul(n0.xy, z) + n0.zw, hw_cmul(n1.xy, z) + n1.zw);
}
// Magnitude of its derivative at z0.
fn hw_jac(n0: vec4f, n1: vec4f, flip: f32, z0: vec2f) -> f32 {
  let z = select(z0, hw_conj(z0), flip > 0.5);
  let det = hw_cmul(n0.xy, n1.zw) - hw_cmul(n0.zw, n1.xy);
  let den = hw_cmul(n1.xy, z) + n1.zw;
  return length(det) / max(dot(den, den), 1e-12);
}
// Hyperbolic distance in the Poincare disk: 2 atanh(|u - v| / |1 - conj(v) u|).
fn hw_dh(u: vec2f, v: vec2f) -> f32 {
  let num = length(u - v);
  let den = length(vec2f(1.0, 0.0) - hw_cmul(hw_conj(v), u));
  let x = min(num / max(den, 1e-6), 0.999999);
  return log((1.0 + x) / (1.0 - x));
}

// Phase fronts. x follows an event count, each event easing in by smoothstep over 0.4 s (it starts from rest
// and glides one unit per event, however close the events come). tau in [0, 0.5] is the point's arrival
// fraction: the front reaches it when x has moved tau of the way. Returns (state, u): the lasting state
// steps by 1 per event, eased in as the front passes, and u is how far the front has gone past (0..1).
// Everything is a continuous function of x, so nothing can snap.
//
// Levels: ab packs the strengths of events N = floor(x) and N + 1. Returns (e, u, level, first): e is
// how far the event being applied at this point has eased in, level its strength (the front glow and
// the lasting step scale by it), first = 1 when that event is N (else N + 1).
fn hw_phase(x: f32, tau: f32, ab: f32) -> vec4f {
  let y = x - tau;
  let u = fract(y);
  let first = floor(y) < floor(x);
  let la = floor(ab) / 1000.0;
  let lb = fract(ab) / 0.999;
  return vec4f(smoothstep(0.0, 0.5, u), u, select(lb, la, first), select(0.0, 1.0, first));
}
// A soft bump on 0 < u < h: the glow at the front (0 at rest, since u >= 0.5 then).
fn hw_bump(u: f32, h: f32) -> f32 { let s = sin(PI * min(u / h, 1.0)); return s * s; }
// Arrival fraction from a hyperbolic distance, ragged by a smooth ripple (continuous as the origin glides).
fn hw_tau(d: f32, k: f32, salt: f32) -> f32 {
  let r = 0.75 + 0.25 * sin(d * 7.0 + salt) * sin(d * 2.3 + salt * 1.7);
  return 0.5 * (1.0 - exp(-d * r / k));
}

// Folds v into the {p,q} fundamental triangle by reflections. Returns (v, Jacobian of the fold, fold parity).
fn hw_fold(v0: vec2f, n2: vec2f, cc: f32, rc: f32) -> vec4f {
  var v = v0;
  var j = 1.0;
  var par = 0.0;
  for (var i = 0; i < 48; i++) {
    var fl = 0.0;
    if (v.y < 0.0) { v.y = -v.y; fl += 1.0; }
    let dd = dot(v, n2);
    if (dd > 0.0) { v = v - 2.0 * dd * n2; fl += 1.0; }
    let w = v - vec2f(cc, 0.0);
    let r2 = max(dot(w, w), 1e-12);
    if (r2 < rc * rc) { v = vec2f(cc, 0.0) + w * (rc * rc / r2); j = j * (rc * rc / r2); fl += 1.0; }
    par += fl;
    if (fl == 0.0) { break; }
  }
  return vec4f(v, j, par);
}

// The director palette at a luminance, pushed toward full saturation (neon on black).
fn hw_col(t: f32, lvl: f32, rot: f32) -> vec3f {
  let p = pal(t);
  let mx = max(p.r, max(p.g, p.b));
  let mn = min(p.r, min(p.g, p.b));
  let d = max(mx - mn, 1e-4);
  var h = select(select((p.r - p.g) / d + 4.0, (p.b - p.r) / d + 2.0, mx == p.g), (p.g - p.b) / d, mx == p.r);
  h = fract(h / 6.0);
  let s = mix(0.9, 1.0, sat((mx - mn) / max(mx, 1e-4)));
  let c = hsv2rgb(vec3f(fract(h + rot), s, 1.0));
  return c * lvl * pow(0.4 / max(luma(c), 0.08), 0.55);
}

// Fire by heat (1 = just lit): a saturated orange, gold at the core (kept off white so the colour stays vivid).
fn hw_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.28, 0.03) * h * 1.4 + vec3f(1.0, 0.62, 0.05) * h * h * 1.6;
}

// A glossy tube of half-width hw (pixels) at distance e (pixels): rgb, and its box-filtered coverage in w.
fn hw_tube(e: f32, hw: f32, base: vec3f, detail: f32, Rpx: f32) -> vec4f {
  let cov = clamp(hw - e + 0.5, 0.0, 1.0) * detail;
  let t = clamp(e / max(hw, 1e-3), 0.0, 1.0);
  let hgt = sqrt(max(1.0 - t * t, 0.0));
  let shade = base * (0.25 + 0.9 * hgt) + base * 0.7 * pow(1.0 - t, 6.0);
  let halo = base * 0.25 * exp(-max(e - hw, 0.0) / (2.0 * Rpx)) * detail;
  return vec4f(shade * cov + halo, cov);
}

// One tiling's picture of the point v0 (already viewed through M). hAB: (edge hue, spoke hue offset in turns).
// fr: (kick heat, kick embers, snare spark, melody front).
fn hw_tile(v0: vec2f, pre: f32, tm: vec4f, hAB: vec2f, fr: vec4f, sty: f32, Rpx: f32) -> vec3f {
  // The cue's weave style: bold polygon edges over faint spokes, or a fine even lace.
  let bold = fract(S.p[7].z) / 0.999;
  let n2 = tm.xy;
  let cc = tm.z;
  let rc = sqrt(max(cc * cc - 1.0, 1e-8));
  let fo = hw_fold(v0, n2, cc, rc);
  let vf = fo.xy;
  // Pixel footprint in the fundamental triangle: exact, from the chain of conformal maps.
  let px = max(pre * fo.z, 1e-7);
  let e1 = abs(vf.y) / px;
  let e2 = abs(dot(vf, n2)) / px;
  let e3 = abs(length(vf - vec2f(cc, 0.0)) - rc) / px;
  let eB = min(e1, e2);
  let par = fract(fo.w * 0.5) * 2.0;
  // Tiles too small to resolve fade to their mean colour instead of turning to dust.
  let detail = 1.0 - smoothstep(0.02, 0.05, px);
  let colA = hw_col(hAB.x, 0.42, 0.0);
  let colB = hw_col(hAB.x, 0.6, hAB.y);
  // Fine scale: the spokes are beaded, their width rippling along each spoke; the ripple's phase is
  // the fine phase (detail flow, upper notes, backing), so the high end re-forms the fine weave. The
  // beads fade out where they would be finer than a few pixels.
  let bk = 60.0;
  let bAA = 1.0 - smoothstep(0.08, 0.25, px * bk);
  // The spokes' weight also turns with the fine phase (the lace thickens and thins note by note).
  let bead = (1.0 + 0.55 * bAA * sin(bk * length(vf) - S.p[2].y)) * (1.0 + 0.45 * sin(S.p[2].y * 0.41));
  let tB = hw_tube(eB, (0.8 + 0.6 * sty) * mix(1.1, 0.6, bold) * bead * Rpx, colB, detail, Rpx);
  // The polygon edges ripple too, more gently, along their own arc.
  let beadA = 1.0 + 0.35 * bAA * sin(bk * rc * atan2(vf.y, vf.x - cc) * 1.3 + S.p[2].y * 0.8);
  let tA = hw_tube(e3, (1.2 + 1.0 * sty) * mix(0.8, 2.2, bold) * beadA * Rpx, colA, detail, Rpx);
  let cov = tA.w + 0.5 * tB.w;
  // The two families meet at every vertex: taking the brighter one there keeps the crossings saturated.
  var c = max(tA.xyz, tB.xyz);
  let gl = exp(-min(e3, eB) / (5.0 * Rpx)) * detail;
  c += hw_fire(fr.x) * (1.6 * tA.w + 0.2 * tB.w + 0.2 * gl) + hw_fire(0.3) * fr.y * 0.35 * tA.w;
  c += hw_col(hAB.x + 0.5, 1.0, 0.0) * fr.z * (2.2 * tB.w + 0.25 * gl);
  c += hw_col(hAB.x, 1.0, 0.0) * fr.w * (3.0 * (tA.w + 0.6 * tB.w) + 0.06 * gl);
  c += hw_fire(fr.w * 0.8) * 0.9 * tA.w;
  // Near-black glass tiles, alternating tint by fold parity, with a faint sheen toward their walls.
  let dmin = min(e3, eB);
  let glass = exp(-dmin / (12.0 * Rpx));
  c += hw_col(hAB.x + 0.5 * par, 0.03, 0.0);
  c += colA * 0.06 * glass * detail;
  c += colA * 0.02 * (1.0 - detail) + colB * 0.03 * (1.0 - detail);
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let Z = S.p[2].w;
  // Band model: X runs along the glide, Y across the band. z = exp(X + iY) is in the half-plane.
  let rb = exp(Z * q.x);
  let yb = 1.5707963 + Z * q.y;
  let zb = rb * vec2f(cos(yb), sin(yb));
  let zp = zb + vec2f(0.0, 1.0);
  let u = hw_cdiv(zb - vec2f(0.0, 1.0), zp);
  let jb = 2.0 * rb / max(dot(zp, zp), 1e-12);
  let flip = floor(S.p[2].x * 0.5);
  let n0 = S.p[0];
  let n1 = S.p[1];
  let v0 = hw_apply(n0, n1, flip, u);
  let pre = (2.0 * Z / max(F.res.y, 1.0)) * jb * hw_jac(n0, n1, flip, u);
  let Rpx = max(F.res.y, 540.0) / 540.0;

  // Events, in the plane frame of the tiling: each front spreads from a gliding point of the tiling.
  let dK = hw_dh(v0, S.p[6].xy);
  let dS = hw_dh(v0, S.p[6].zw);
  let dN = hw_dh(v0, S.p[7].xy);
  let pK = hw_phase(S.p[5].x, hw_tau(dK, 1.6, 0.0), S.p[3].w);
  let pS = hw_phase(S.p[5].y, hw_tau(dS, 2.0, 3.0), S.p[5].w);
  let pN = hw_phase(S.p[7].w, hw_tau(dN, 2.2, 7.0), S.p[4].w);
  // Each glow carries its own hit's strength.
  let heat = hw_bump(pK.y, 0.45) * pK.z;
  let emb = hw_bump(pK.y, 0.5) * pK.z * step(0.75, hash12(vec2f(floor(dK * 14.0), 5.0)));
  let spark = hw_bump(pS.y, 0.45) * pS.z;
  // The melody front is a local ripple: it fades with distance from its origin instead of re-lighting
  // the whole weave.
  let note = hw_bump(pN.y, 0.45) * pN.z * exp(-dN * 0.9);

  // Snare: the families alternate (odd snares re-tint the polygon edges, even ones the spokes),
  // each easing to its new tint as the front passes.
  // Lasting re-tints by strength: the summed levels of the odd (cA) and even (cB) snares before
  // N = floor(x), then event N (fully, or as far as it has eased in here) and event N + 1 (as far as
  // it has eased in here), each into its own family.
  let N = floor(S.p[5].y);
  let la = floor(S.p[5].w) / 1000.0;
  let lb = fract(S.p[5].w) / 0.999;
  let aN = la * select(1.0, pS.x, pS.w > 0.5);
  let aN1 = lb * select(pS.x, 0.0, pS.w > 0.5);
  let nOdd = N - 2.0 * floor(N * 0.5);
  let cA = floor(S.p[5].z) / 1000.0 + aN * nOdd + aN1 * (1.0 - nOdd);
  let cB = fract(S.p[5].z) / 0.999 * 5.0 + aN * (1.0 - nOdd) + aN1 * nOdd;
  let base = floor(S.p[7].z) / 1000.0;
  // The spokes are a second hue family, turned 125 to 145 degrees from the edges.
  let hAB = vec2f(base + cA / 3.0, 0.375 + 0.025 * sin(cB * 1.2566371));
  let fr = vec4f(heat, emb, spark, note);
  let sty = S.p[2].z;

  // Cross-fade between the outgoing and incoming tilings, both viewed through the same M.
  let w = S.p[2].x - 2.0 * flip;
  var col = vec3f(0.0);
  if (w < 0.999) { col += (1.0 - w) * hw_tile(v0, pre, S.p[3], hAB, fr, sty, Rpx); }
  if (w > 0.001) { col += w * hw_tile(v0, pre, S.p[4], hAB, fr, sty, Rpx); }
  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.3 * max(pk - 0.9, 0.0));
  return vec4f(col, 1.0);
}
`;

export default raymarchScene({
  meta: {
    id: 'hyperbolic-weave',
    name: 'Hyperbolic Weave',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.6 },
    genres: { edm: 0.8, techno: 0.8, ambient: 0.8, synthwave: 0.9, pop: 0.5, dnb: 0.6, classical: 0.5, hiphop: 0.5, dubstep: 0.6, rock: 0.4 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);

    if (g[0] !== st.seed) {
      st.seed = g[0];
      st.M = ID;
      st.k0 = morph.kicks;
      st.s0 = morph.snares;
      st.n0 = morph.notes;
      st.xk.reset(0);
      st.xs.reset(0);
      st.xn.reset(0);
      st.lk.reset();
      st.ls.reset();
      st.ln.reset();
      st.kicks = morph.kicks;
      st.snares = morph.snares;
      st.notes = morph.notes;
      st.phrases = morph.phrases;
      st.A = pickTiling(g, morph.phrases, null);
      st.B = st.A;
      st.fade = 1;
      st.mix = 0;
      st.phi = st.target = wrapPi(Math.PI * morph.notePitch);
      st.phiVel = 0;
      st.surge = st.surgeAt = 0;
      st.surgeG.reset(0);
      st.spin.reset(0);
      st.spinAt = 0;
      st.side.reset(0);
      st.sideAt = 0;
    }

    // Events. A kick surges the weave along the glide and sends a front out from the view centre.
    // Each reaction scales with its hit's strength (beats squared: a faint hit after quiet stays a touch).
    const kL = morph.kickLevel ** 2;
    const sL = morph.snareLevel ** 2;
    const nL = morph.noteLevel;
    st.lk.sync(morph.kicks - st.k0, kL);
    st.ls.sync(morph.snares - st.s0, sL);
    st.ln.sync(morph.notes - st.n0, nL);
    if (morph.kicks !== st.kicks) {
      st.kicks = morph.kicks;
      st.surge += 0.95 * kL;
    }
    st.snares = morph.snares;
    if (morph.notes !== st.notes) {
      st.notes = morph.notes;
      // A note turns the heading toward its pitch by its strength.
      st.target = wrapPi(st.target + wrapPi(Math.PI * morph.notePitch + 0.35 * Math.sin(morph.at[3]) - st.target) * morph.noteLevel);
      // A note carries the weave only a short way (squared: a faint note is a ripple, not a re-layout).
      st.surge += 0.45 * nL * nL;
    }
    st.xk.update(morph.kicks - st.k0, dt);
    st.xs.update(morph.snares - st.s0, dt);
    st.xn.update(morph.notes - st.n0, dt);
    // The heading turns on a critically damped spring: from rest, settled in about half a second.
    const wPhi = 8;
    const ePhi = Math.exp(-wPhi * dt);
    const dPhi = -wrapPi(st.target - st.phi);
    const cPhi = st.phiVel + wPhi * dPhi;
    st.phiVel = (st.phiVel - wPhi * cPhi * dt) * ePhi;
    st.phi = st.target + (dPhi + cPhi * dt) * ePhi;

    // Glide: right-multiplied, so the motion is in the screen's frame. Drops rush it.
    const speed = (0.015 + 0.03 * morph.flow + 0.05 * morph.drive ** 1.3) * (1 + 5 * morph.surge);
    st.M = compose(st.M, glide(speed * dt, st.phi));
    // Kick and note surges: a spring glides the weave on along the heading, starting from rest.
    const next = st.surgeG.update(st.surge, dt);
    if (next > st.surgeAt) st.M = compose(st.M, glide(next - st.surgeAt, st.phi));
    st.surgeAt = next;
    // Snare turn: the spring's step this frame, as a rotation about the view centre.
    const spin = st.spin.update(st.ls.total * 0.7, dt);
    const dSpin = spin - st.spinAt;
    st.spinAt = spin;
    if (Math.abs(dSpin) > 1e-7) st.M = compose(st.M, { m: [expI(dSpin / 2), [0, 0], [0, 0], expI(-dSpin / 2)], f: 0 });
    // A turn alone can land close to one of the tiling's own symmetries; the sideways slide never does.
    const side = st.side.update(st.ls.total * 0.5, dt);
    if (side > st.sideAt) st.M = compose(st.M, glide(side - st.sideAt, st.phi + Math.PI / 2));
    st.sideAt = side;

    // Phrase: start a cross-fade to a new tiling; the outgoing tiling is replaced when it completes.
    if (morph.phrases !== st.phrases) {
      st.phrases = morph.phrases;
      st.B = pickTiling(g, morph.phrases, st.A);
      st.fade = 0;
    }
    if (st.fade < 1) {
      st.fade = Math.min(1, st.fade + dt / 2.5);
      if (st.fade >= 1) {
        st.A = st.B;
        st.mix = 0;
      } else st.mix = smooth(st.fade);
    }

    // Re-centre the view with the tiling's own group element, so it stays near the fundamental triangle.
    if (st.fade >= 1) {
      const v = applyIso(st.M, [0, 0]);
      if (Math.hypot(v[0], v[1]) > 0.3) {
        const G = foldReset(v, st.A);
        st.M = compose(G, st.M);
      }
    }

    const Mm = st.M.m;
    p[0] = Mm[0][0]; p[1] = Mm[0][1]; p[2] = Mm[1][0]; p[3] = Mm[1][1];
    p[4] = Mm[2][0]; p[5] = Mm[2][1]; p[6] = Mm[3][0]; p[7] = Mm[3][1];
    // Flip and the cross-fade share a slot: 2 * flip + mix.
    p[8] = 2 * st.M.f + st.mix;
    // Fine phase: the spoke ripple flows with the detail coordinate and steps on with every upper note
    // and backing chord (strength-weighted eased counts).
    p[9] = 3 * morph.detailAt[0] + 3.5 * morph.upperPhase + 0.6 * morph.backingPhase;
    p[10] = wave(morph.at[4], 0.15, 0.95);
    // Layout per cue: zoom (large tiles to a fine lace) and the weave style. Z stays under pi/2 so
    // the band never reaches past the edge of the plane.
    p[11] = 0.8 + 0.7 * g[7];
    const A = st.A;
    const B = st.B;
    // rc follows from cc (cc^2 - rc^2 = 1), so the w slots carry the event levels instead.
    p[12] = A.n2[0]; p[13] = A.n2[1]; p[14] = A.cc;
    p[16] = B.n2[0]; p[17] = B.n2[1]; p[18] = B.cc;
    p[20] = st.xk.x;
    p[21] = st.xs.x;
    p[15] = st.lk.ab(st.xk.x);
    p[19] = st.ln.ab(st.xn.x);
    p[22] = st.ls.sums(st.xs.x);
    p[23] = st.ls.ab(st.xs.x);
    // Front origins glide with the view (kick: its centre; snare: a point turning round it; note: just
    // off the centre on the side the glide heads), so every front is continuous in time.
    const th = st.xs.x * 1.9 + 1;
    const qk = applyIso(st.M, [0, 0]);
    const qs = applyIso(st.M, [0.5 * Math.cos(th), 0.5 * Math.sin(th)]);
    const qn = applyIso(st.M, [0.25 * Math.cos(st.phi), 0.25 * Math.sin(st.phi)]);
    p[24] = qk[0]; p[25] = qk[1]; p[26] = qs[0]; p[27] = qs[1];
    p[28] = qn[0]; p[29] = qn[1];
    // Palette offset and weave style share a slot: floor(1000 g3) + 0.999 g5.
    p[30] = Math.floor(g[3] * 1000) + 0.999 * g[5];
    p[31] = st.xn.x;
  },
  wgsl: SHADER,
});
