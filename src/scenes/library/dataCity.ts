import type { MusicState } from '../../audio/musicState';
import { raymarchScene } from '../raymarchScene';


/**
 * Music clock for this scene: travel that surges on each beat and rests between them and in
 * silence, a turn phase that steps on downbeats, the age of the latest kick / snare / lead attack,
 * a held-note level with a soft release, and the chord hue eased around the colour wheel.
 */
const mc = { t: -1, travel: 0, turn: 0, kickAge: 9, snareAge: 9, leadAge: 9, k: 0, s: 0, l: 0, held: 0, hx: 1, hy: 0 };
function tick(m: MusicState, dtIn: number): void {
  const dt = Math.min(Math.max(dtIn, 0), 0.1);
  const seek = Math.abs(m.time - mc.t - dt) > 0.5;
  mc.t = m.time;
  const beat = 60 / Math.max(40, m.bpm);
  const tempo = Math.sqrt(Math.max(60, m.bpm) / 120);
  const pulseMean = Math.min(1, 0.12 / beat);
  const surge = 0.35 + (0.65 * m.beatPulse) / pulseMean;
  mc.travel += dt * tempo * (0.06 + 1.1 * m.energy + 0.8 * m.dropPulse) * surge;
  const barMean = Math.min(1, 0.25 / (beat * m.beatsPerBar));
  mc.turn += dt * tempo * (0.05 + 0.9 * m.energySlow) * (0.2 + (0.8 * m.barPulse) / barMean);
  const hue = (m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : 0) * Math.PI * 2;
  if (seek) {
    mc.kickAge = mc.snareAge = mc.leadAge = 9;
    mc.hx = Math.cos(hue);
    mc.hy = Math.sin(hue);
  } else {
    mc.kickAge = m.kick > mc.k + 0.06 ? 0 : mc.kickAge + dt;
    mc.snareAge = m.snare > mc.s + 0.06 ? 0 : mc.snareAge + dt;
    mc.leadAge = m.lead > mc.l + 0.05 ? 0 : mc.leadAge + dt;
    const kh = 1 - Math.exp(-dt / 0.6);
    mc.hx += (Math.cos(hue) - mc.hx) * kh;
    mc.hy += (Math.sin(hue) - mc.hy) * kh;
  }
  mc.k = m.kick;
  mc.s = m.snare;
  mc.l = m.lead;
  mc.held = m.leadHeld > mc.held ? m.leadHeld : mc.held + (m.leadHeld - mc.held) * (1 - Math.exp(-dt / 0.35));
}
const chordHue = () => Math.atan2(mc.hy, mc.hx) / (Math.PI * 2);


/**
 * Night run through a procedural city of glowing circuit-board towers. Space is cut into
 * cells (a Manhattan grid, polar rings around a central spire, megablocks of linked towers,
 * or floating islands over a data ocean); each cell holds one procedural tower, marched
 * with a cell-exit-limited sphere tracer so long street corridors stay cheap. Data packets
 * stream along street lanes and climb facade buses per spectrum band, holographic
 * billboards show equalisers, and the wet ground reflects it all.
 *
 * The music: travel and the packet flow surge on each beat and rest between beats and in silence.
 * The melody is a light drone flying ahead of you down the street: its altitude and colour follow
 * the pitch, it flares on every note, lights the facades around it and sends a ring of light
 * running round the towers at its height and along the streets below. Each kick sends a band of
 * light climbing every facade (and, in the pulse grammar, a swell of tower heights rolling out
 * from you); each snare fires the crown lights and billboards. Chords ease the city's hue round
 * the wheel. Anticipation dims the city; the drop fires a light ring through the streets and
 * turns every window on.
 *
 * DNA: 1 layout, 2 tower style, 3 camera rig, 4 weather, 5 facade material,
 * 6 density/scale, 7 motion grammar.
 */
export default raymarchScene({
  meta: {
    id: 'data-city',
    name: 'Data City',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.3, 1],
    mood: { valence: 0.45, arousal: 0.65 },
    genres: { synthwave: 1, techno: 0.8, dnb: 0.8, hiphop: 0.75, edm: 0.7, dubstep: 0.5, pop: 0.4 },
    trails: 0.2,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    tick(m, ctx.dt);
    const g = ctx.dna;
    const e = ctx.evolve;
    const antic = m.anticipation;
    p[0] = Math.floor(g[1] * 4); // layout
    p[1] = Math.floor(g[2] * 4); // tower style
    p[2] = Math.floor(g[3] * 4); // camera rig
    p[3] = Math.floor(g[4] * 4); // weather
    p[4] = Math.floor(g[5] * 4); // facade material
    p[5] = 1.0; // base cell size
    p[6] = 0.9 + 1.5 * g[6]; // height scale
    p[7] = Math.floor(((g[7] * 3) % 1) * 3); // motion grammar
    p[8] = mc.travel * 0.45;
    p[9] = mc.turn;
    p[10] = g[0];
    p[11] = g[6];
    p[12] = antic;
    p[13] = m.dropPulse;
    p[14] = ctx.intensity;
    p[15] = 0.1 + 0.08 * g[6]; // street half-width (fraction of cell)
    p[16] = e[0];
    p[17] = e[1];
    p[18] = e[2];
    p[19] = e[3];
    p[20] = g[7] < 0.5 ? 1 : -1; // twist / orbit direction
    p[21] = (g[7] * 7.3) % 1; // billboard content bias
    p[22] = m.beatIndex % 64;
    p[23] = m.barIndex % 64;
    // S.p[6]: lead flare, held glow, pitch, age since the last lead attack
    p[24] = m.lead;
    p[25] = mc.held;
    p[26] = m.leadPitch;
    p[27] = mc.leadAge;
    // S.p[7]: age since the last kick, snare, packet flow clock, eased chord hue
    p[28] = mc.kickAge;
    p[29] = m.snare;
    p[30] = mc.travel * 0.6;
    p[31] = 0.25 * chordHue();
  },
  wgsl: /* wgsl */ `
struct DcCell { id: vec2f, l: vec2f, ctr: vec2f, cs: f32, ang: f32, bx: f32, bz: f32,
  alX: f32, alZ: f32, lnX: f32, lnZ: f32, maxT: f32, rIn: f32, rOut: f32, a0: f32, w: f32, sideX: f32, sideZ: f32 };
struct DcB { d: f32, lp: vec3f, hx: f32, hz: f32, H: f32, band: f32, seed: f32, kind: i32, on: bool };

var<private> dc_ro: vec3f;
var<private> dc_E: vec3f;
var<private> dc_ECol: vec3f;
fn dc_flow() -> f32 { return S.p[7].z; }

fn dc_layout() -> i32 { return i32(S.p[0].x + 0.5); }
fn dc_style() -> i32 { return i32(S.p[0].y + 0.5); }
fn dc_camMode() -> i32 { return i32(S.p[0].z + 0.5); }
fn dc_weather() -> i32 { return i32(S.p[0].w + 0.5); }
fn dc_matMode() -> i32 { return i32(S.p[1].x + 0.5); }
fn dc_hs() -> f32 { return S.p[1].z; }
fn dc_grammar() -> i32 { return i32(S.p[1].w + 0.5); }
fn dc_hue() -> f32 { return S.p[2].z + F.morph2.x * 0.12 + S.p[7].w; }
fn dc_spireOn() -> bool { return dc_camMode() == 2 || dc_layout() == 1; }
fn dc_cs() -> f32 {
  let L = dc_layout();
  return S.p[1].y * select(select(1.0, 2.4, L == 2), 1.5, L == 3);
}
fn dc_plazaR() -> f32 { return select(0.0, select(2.6, 2.0, dc_layout() == 1) * dc_cs(), dc_spireOn()); }
fn dc_groundY() -> f32 { return select(0.0, -dc_hs() * 1.6, dc_layout() == 3); }
fn dc_spireH() -> f32 { return dc_hs() * 3.6; }
fn dc_hmax() -> f32 { return max(dc_hs() * select(2.65, 3.1, dc_layout() == 3), select(0.0, dc_spireH() * 1.3, dc_spireOn())); }

fn dc_cell(q: vec2f) -> DcCell {
  var c: DcCell;
  let cs = dc_cs();
  c.cs = cs;
  if (dc_layout() == 1) {
    let r = length(q);
    let a = atan2(q.y, q.x);
    let ring = floor(r / cs);
    let rc = (ring + 0.5) * cs;
    let n = max(floor(TAU * rc / cs), 3.0);
    let w = TAU / n;
    let sf = floor(a / w);
    let ac = (sf + 0.5) * w;
    let co = cos(ac);
    let si = sin(ac);
    let lq = vec2f(co * q.x + si * q.y, -si * q.x + co * q.y);
    c.l = vec2f(lq.x - rc, lq.y);
    c.id = vec2f(ring, fmod(sf, n));
    c.ang = ac;
    c.ctr = rc * vec2f(co, si);
    c.bx = 0.5 * cs - abs(r - rc);
    c.bz = r * sin(max(0.5 * w - abs(a - ac), 0.0));
    c.alX = a * r;
    c.lnX = round(r / cs);
    c.alZ = r;
    c.lnZ = round(a / w) + ring * 37.0;
    c.maxT = (rc - 0.5 * cs) * sin(0.5 * w);
    c.rIn = ring * cs;
    c.rOut = (ring + 1.0) * cs;
    c.a0 = sf * w;
    c.w = w;
    c.sideX = sign(r - rc);
    c.sideZ = sign(a - ac);
  } else {
    c.id = floor(q / cs);
    c.ctr = (c.id + 0.5) * cs;
    c.l = q - c.ctr;
    c.ang = 0.0;
    c.bx = 0.5 * cs - abs(c.l.x);
    c.bz = 0.5 * cs - abs(c.l.y);
    c.alX = q.y;
    c.lnX = round(q.x / cs);
    c.alZ = q.x;
    c.lnZ = round(q.y / cs) + 517.0;
    c.maxT = 0.5 * cs;
    c.sideX = sign(c.l.x);
    c.sideZ = sign(c.l.y);
  }
  return c;
}

/** Distance along the ray to the boundary of the current cell. */
fn dc_exit(p: vec3f, rd: vec3f, c: DcCell) -> f32 {
  if (dc_layout() == 1) {
    let o = p.xz;
    let d = rd.xz;
    let A = max(dot(d, d), 1e-8);
    let B = dot(o, d);
    let C2 = dot(o, o);
    var t = (-B + sqrt(max(B * B - A * (C2 - c.rOut * c.rOut), 0.0))) / A;
    if (c.rIn > 0.0) {
      let di = B * B - A * (C2 - c.rIn * c.rIn);
      if (di > 0.0) {
        let ti = (-B - sqrt(di)) / A;
        if (ti > 0.0) { t = min(t, ti); }
      }
    }
    for (var k = 0; k < 2; k++) {
      let an = c.a0 + f32(k) * c.w;
      let nr = vec2f(-sin(an), cos(an));
      let den = dot(d, nr);
      if (abs(den) > 1e-6) {
        let tl = -dot(o, nr) / den;
        if (tl > 0.0) { t = min(t, tl); }
      }
    }
    return t;
  }
  let h = 0.5 * c.cs;
  let dd = select(rd.xz, vec2f(1e-6), abs(rd.xz) < vec2f(1e-6));
  let tt = (sign(dd) * h - c.l) / dd;
  return min(tt.x, tt.y);
}

fn dc_tower(q: vec3f, hx: f32, hz: f32, H: f32, kind: i32) -> f32 {
  if (kind == 0) {
    var d = sdBox(q - vec3f(0.0, H * 0.3, 0.0), vec3f(hx, H * 0.3, hz));
    d = min(d, sdBox(q - vec3f(0.0, H * 0.42, 0.0), vec3f(hx * 0.76, H * 0.42, hz * 0.76)));
    d = min(d, sdBox(q - vec3f(0.0, H * 0.5, 0.0), vec3f(hx * 0.5, H * 0.5, hz * 0.5)));
    return d;
  }
  if (kind == 1) {
    let r = min(hx, hz) * (1.0 - 0.28 * sat(q.y / H));
    let a = abs(q.xz);
    let d2 = max(max(a.x, a.y), (a.x + a.y) * 0.7071) - r;
    return max(d2 * 0.85, abs(q.y - H * 0.5) - H * 0.5);
  }
  if (kind == 2) {
    let tw = S.p[5].x * 1.4 / max(H, 0.3);
    let rq = rot2(q.y * tw) * q.xz;
    let m = min(hx, hz);
    return sdBox(vec3f(rq.x, q.y - H * 0.5, rq.y), vec3f(m, H * 0.5, m * 0.78)) * 0.7;
  }
  let m = min(hx, hz);
  var d = sdBox(q - vec3f(0.0, H * 0.3, 0.0), vec3f(hx, H * 0.3, hz));
  let y2 = q.y - H * 0.6;
  let a = abs(q.xz);
  let pyr = max(max(a.x, a.y) - m * 0.82 * (1.0 - y2 / (H * 0.45)), -y2) * 0.65;
  d = min(d, pyr);
  d = min(d, sdCapsule(q, vec3f(0.0, H * 0.95, 0.0), vec3f(0.0, H * 1.18, 0.0), 0.012));
  return d;
}

struct DcP { on: bool, hx: f32, hz: f32, H: f32, base: f32, kind: i32, band: f32, seed: f32, hx2: f32, half: f32 };

/** Per-cell tower parameters (computed once per cell while marching). */
fn dc_bparams(c: DcCell) -> DcP {
  var b: DcP;
  b.on = false; b.hx = 0.1; b.hz = 0.1; b.H = 0.0; b.base = 0.0; b.kind = 0; b.band = 0.0; b.seed = 0.0; b.hx2 = 0.0; b.half = 0.1;
  let L = dc_layout();
  let h = hash33(vec3f(c.id * vec2f(1.0, 1.37) + vec2f(f32(L) * 11.0, 3.0), S.p[2].w * 53.0 + 0.5));
  let h2 = hash33(h * 41.3 + vec3f(1.7, 9.1, 4.4));
  if (h2.x < 0.04 + 0.08 * (1.0 - S.p[2].w) || length(c.ctr) < dc_plazaR()) { return b; }
  b.on = true;
  let cs = c.cs;
  let half = min(0.5 * cs, c.maxT) - cs * S.p[3].w;
  b.half = half;
  b.seed = h.z;
  b.band = fract(h.x * 5.3 + h.y * 2.7 + h.z);
  let district = 0.5 + 0.5 * noise3fast(vec3f(c.ctr * 0.06, 2.0) + vec3f(S.p[2].w * 9.0));
  var H = dc_hs() * (0.3 + 1.25 * pow(h.z, 1.5)) * (0.5 + 0.8 * district);
  let g = dc_grammar();
  let dist = length(c.ctr - dc_ro.xz);
  if (g == 1) {
    H *= 0.75 + 0.5 * hist(b.band * 0.85 + 0.04, sat(dist / (cs * 22.0)));
  } else if (g == 2) {
    let kAge = S.p[7].x;
    let R = cs * (1.5 + kAge * 9.0);
    H += dc_hs() * 0.3 * exp(-kAge * 3.0) * exp(-(dist - R) * (dist - R) / (cs * cs * 2.5));
  }
  H *= 1.0 - 0.2 * S.p[3].x + 0.15 * S.p[3].y;
  b.H = min(H, dc_hs() * 2.15);
  if (L == 3) { b.base = (h2.z - 0.5) * dc_hs() * 0.9 + 0.04 * sin(S.p[2].y * 0.5 + h.x * 6.28); }
  var kind = dc_style();
  if (h2.y < 0.22) { kind = (kind + 1 + i32(h2.z * 3.0)) % 4; }
  b.kind = kind;
  b.hx = half * (0.6 + 0.4 * h.x);
  b.hz = half * (0.6 + 0.4 * h.y);
  b.hx2 = select(0.0, 0.35 * cs + 0.3 * cs * h2.y, L == 3);
  return b;
}

fn dc_bsdf(p: vec3f, c: DcCell, bp: DcP) -> DcB {
  var b: DcB;
  b.d = 1e9; b.lp = vec3f(0.0); b.hx = bp.hx; b.hz = bp.hz; b.H = bp.H; b.band = bp.band; b.seed = bp.seed; b.kind = bp.kind; b.on = bp.on;
  if (!bp.on) { return b; }
  let q = vec3f(c.l.x, p.y - bp.base, c.l.y);
  if (dc_layout() == 2) {
    // Megablock: podium, four towers and two sky bridges.
    let half = bp.half;
    let a = half * 0.5;
    let sx = half * 0.42;
    let H = bp.H;
    var d = sdBox(q - vec3f(0.0, 0.05 * dc_hs(), 0.0), vec3f(half, 0.05 * dc_hs(), half));
    b.lp = q; b.hx = half; b.hz = half; b.H = 0.1 * dc_hs();
    for (var k = 0; k < 4; k++) {
      let o = vec2f(select(-a, a, (k & 1) != 0), select(-a, a, (k & 2) != 0));
      let hk = fract(bp.seed * 7.31 + f32(k) * 0.618);
      let Hk = min(H * (0.55 + 0.75 * hk) + 0.2, dc_hs() * 2.15);
      let qk = q - vec3f(o.x, 0.0, o.y);
      let hxk = sx * (0.75 + 0.25 * hk);
      let hzk = sx * (0.95 - 0.2 * hk);
      let dk = dc_tower(qk, hxk, hzk, Hk, (bp.kind + k) % 4);
      if (dk < d) { d = dk; b.lp = qk; b.hx = hxk; b.hz = hzk; b.H = Hk; b.band = fract(bp.band + f32(k) * 0.27); b.kind = (bp.kind + k) % 4; }
    }
    let by = H * 0.45;
    d = min(d, sdBox(q - vec3f(0.0, by, -a), vec3f(a, 0.03, 0.05)));
    d = min(d, sdBox(q - vec3f(a, by * 0.7, 0.0), vec3f(0.05, 0.03, a)));
    b.d = d;
    return b;
  }
  b.lp = q;
  var d = dc_tower(q, bp.hx, bp.hz, bp.H, bp.kind);
  if (dc_layout() == 3) {
    let P = 0.5 * c.cs - 0.06 * c.cs;
    let plat = sdBox(q - vec3f(0.0, -0.025, 0.0), vec3f(P, 0.025, P));
    let rock = max(max(abs(q.x), abs(q.z)) - P * (1.0 + q.y / bp.hx2), q.y) * 0.6;
    d = min(d, min(plat, rock));
  }
  b.d = d;
  return b;
}

fn dc_bld(p: vec3f, c: DcCell) -> DcB { return dc_bsdf(p, c, dc_bparams(c)); }

fn dc_spire(p: vec3f) -> f32 {
  if (!dc_spireOn()) { return 1e9; }
  let H = dc_spireH();
  let R = dc_cs() * 0.42;
  let a = abs(p.xz);
  let rr = R * (1.0 - 0.85 * sat(p.y / H));
  var d = max((max(max(a.x, a.y), (a.x + a.y) * 0.7071) - rr) * 0.8, max(p.y - H, -p.y));
  let seg = H / 7.0;
  let yy = fmod(p.y, seg) - seg * 0.5;
  let ring = sdTorus(vec3f(p.x, yy, p.z), vec2f(rr + 0.06, 0.012));
  d = min(d, max(ring, p.y - H));
  d = min(d, sdCapsule(p, vec3f(0.0, H, 0.0), vec3f(0.0, H * 1.25, 0.0), 0.02));
  return d;
}

/** Returns (t, material): material 0 ground, 1 building, 2 spire; t < 0 for sky. */
fn dc_march(ro: vec3f, rd: vec3f, tmax: f32, steps: i32) -> vec2f {
  let hmax = dc_hmax();
  let gy = dc_groundY();
  var tEnd = tmax;
  var gHit = false;
  if (rd.y < 0.0) {
    let tg = (gy - ro.y) / rd.y;
    if (tg < tmax) { tEnd = tg; gHit = true; }
  }
  var t = 0.0;
  var lastId = vec2f(1e9);
  var bp: DcP;
  var tExit = 0.0;
  for (var i = 0; i < steps; i++) {
    if (t >= tEnd) { break; }
    let p = ro + rd * t;
    if (p.y > hmax) {
      if (rd.y >= 0.0) { return vec2f(-1.0, 0.0); }
      t += (p.y - hmax) / -rd.y + 0.005;
      continue;
    }
    let c = dc_cell(p.xz);
    if (any(c.id != lastId)) {
      lastId = c.id;
      bp = dc_bparams(c);
      tExit = t + dc_exit(p, rd, c) + 0.004 * c.cs;
    }
    let ds = dc_spire(p);
    let eps = 0.0005 * t + 0.001;
    if (ds < eps) { return vec2f(t, 2.0); }
    var b = 1e9;
    let top = bp.base + bp.H * 1.2 + 0.05;
    let bot = bp.base - bp.hx2 - 0.06;
    if (bp.on && p.y < top && p.y > bot) {
      b = dc_bsdf(p, c, bp).d;
      if (b < eps) { return vec2f(t, 1.0); }
    } else if (bp.on) {
      b = max(p.y - top, bot - p.y);
    }
    t += max(min(min(b, tExit - t), ds), 0.0005);
  }
  if (gHit && t >= tEnd) { return vec2f(tEnd, 0.0); }
  return vec2f(-1.0, 0.0);
}

fn dc_mapD(p: vec3f) -> f32 {
  let c = dc_cell(p.xz);
  return min(dc_bld(p, c).d, dc_spire(p));
}
fn dc_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * dc_mapD(p + k.xyy * e) + k.yyx * dc_mapD(p + k.yyx * e) +
                   k.yxy * dc_mapD(p + k.yxy * e) + k.xxx * dc_mapD(p + k.xxx * e));
}

fn dc_fogDensity() -> f32 {
  let w = dc_weather();
  return select(select(select(0.018, 0.035, w == 1), 0.075, w == 2), 0.04, w == 3) * (1.0 + 0.8 * S.p[3].x);
}
fn dc_wet() -> f32 {
  let w = dc_weather();
  return select(select(0.45, 1.0, w == 1 || w == 3), 0.6, w == 2);
}

fn dc_sky(rd: vec3f) -> vec3f {
  let w = dc_weather();
  let y = rd.y;
  let hz = dc_hue();
  let glow = palL(hz + 0.5, 0.075 + 0.04 * f32(w == 2)) * (1.0 + 0.5 * F.energySlow) * (1.0 - 0.5 * S.p[3].x);
  let zen = palRampL(0.05, 0.004);
  var col = mix(glow, zen, pow(sat(y * 2.0 + 0.03), 0.6));
  if (w == 0) {
    let sc = rd * 300.0;
    let hs = hash13(floor(sc));
    let star = smoothstep(0.996, 1.0, hs) * smoothstep(0.45, 0.0, length(fract(sc) - 0.5));
    col += vec3f(0.8, 0.85, 1.0) * star * smoothstep(0.05, 0.35, y) * 0.8;
    let md = normalize(vec3f(-0.4, 0.35, 1.0));
    let mm = dot(rd, md);
    col += palL(hz + 0.25, 0.9) * smoothstep(0.99975, 0.9999, mm) + palL(hz + 0.25, 0.05) * pow(sat(mm), 60.0);
  } else {
    // Low cloud deck lit from below by the city.
    let cp = rd.xz / max(y + 0.08, 0.05) * 1.5 + vec2f(0.0, dc_flow() * 0.04 + S.p[2].x * 0.03);
    let cl = fbmFast(vec3f(cp, dc_flow() * 0.02), 3);
    let cover = smoothstep(-0.1, 0.35, cl) * smoothstep(-0.05, 0.25, y);
    col = mix(col, palL(hz + 0.45, 0.06) * (1.0 + 0.6 * F.bass), cover * 0.8);
  }
  return col;
}

/** Ground: wet asphalt with data packets streaming along the street lanes. */
fn dc_groundEmit(p: vec3f, foot: f32) -> vec3f {
  let c = dc_cell(p.xz);
  let sw = S.p[3].w * c.cs;
  var col = vec3f(0.0);
  let speed = (1.6 + 2.0 * F.energy) * (1.0 + 2.0 * S.p[3].x);
  // Two street directions: near the x-boundary and near the z-boundary.
  for (var k = 0; k < 2; k++) {
    let bd = select(c.bz, c.bx, k == 0);
    if (bd < sw) {
      let side = select(c.sideZ, c.sideX, k == 0);
      let al = select(c.alZ, c.alX, k == 0);
      let ln = select(c.lnZ, c.lnX, k == 0);
      let lane = clamp(floor(bd / sw * 3.0), 0.0, 2.0);
      let off = (lane + 0.5) * sw / 3.0;
      let lid = ln * 7.0 + lane * 2.0 + side;
      let band = fract(hash11(lid * 1.31 + 0.7) * 0.9 + lane * 0.13);
      let lvl = spec(band);
      let dir = select(-1.0, 1.0, side > 0.0);
      let x = (al * 0.9 * dir - dc_flow() * speed * 0.5 * (0.7 + 0.6 * hash11(lid))) + hash11(lid * 3.1) * 9.0;
      let f = fract(x);
      let gate = step(hash12(vec2f(floor(x), lid)), 0.25 + 0.9 * lvl * lvl + 0.4 * S.p[3].y);
      let wl = max(0.006, foot);
      let line = sat(1.0 - abs(bd - off) / wl) * (0.006 / wl);
      let head = pow(f, 9.0) * smoothstep(1.0, 0.985, f);
      let hue = dc_hue() + band * 0.6;
      col += palL(hue, 1.0) * line * gate * head * (1.2 + 6.0 * lvl * lvl) ;
      col += palL(hue, 0.04) * line * 0.6;
      // Dashed centre line on the boundary itself.
      let cw = max(0.004, foot);
      col += palL(hue + 0.5, 0.06) * sat(1.0 - bd / cw) * step(0.5, fract(al * 3.0)) * (0.004 / cw);
    }
  }
  // The melody's ring along the streets.
  let age = S.p[6].w;
  let dxz = length(p.xz - dc_E.xz) / c.cs;
  col += dc_ECol * 0.2 * exp(-pow((dxz - 0.3 - age * 5.0) * 4.0, 2.0)) * exp(-age * 3.0) * (0.5 + S.p[6].y);
  // Drop ring sweeping out from ahead of the camera.
  let rc = dc_ro.xz;
  let R = (1.0 - S.p[3].y) * c.cs * 22.0;
  col += palL(dc_hue() + 0.3, 2.5) * exp(-abs(length(p.xz - rc) - R) * 5.0) * S.p[3].y;
  return col;
}

/**
 * The melody's drone: light from it on nearby surfaces (flare on each note, glow while held) and
 * the ring each note sends running outward at the drone's altitude.
 */
fn dc_drone(p: vec3f, n: vec3f) -> vec3f {
  let flare = S.p[6].x;
  let held = S.p[6].y;
  let age = S.p[6].w;
  let cs = dc_cs();
  let L = dc_E - p;
  let d2 = dot(L, L) / (cs * cs);
  let near = exp(-d2 * 1.6);
  let lit = (0.3 + 0.7 * sat(dot(n, normalize(L)))) * near * (0.2 * held + 1.1 * flare);
  let dxz = length(p.xz - dc_E.xz) / cs;
  let R = 0.3 + age * 5.0;
  let ring = exp(-pow((dxz - R) * 2.0, 2.0)) * exp(-pow((p.y - dc_E.y) / (0.17 * dc_hs()), 2.0)) * exp(-age * 2.8);
  return dc_ECol * (lit + ring * (3.5 + 1.6 * held));
}

/** Facade, roof and spire shading for a building hit. */
fn dc_building(p: vec3f, n: vec3f, rd: vec3f, t: f32, foot: f32, isSpire: bool) -> vec3f {
  let hz = dc_hue();
  let c = dc_cell(p.xz);
  var b: DcB;
  var lp: vec3f;
  var nl: vec3f;
  if (isSpire) {
    b.hx = dc_cs() * 0.42; b.hz = b.hx; b.H = dc_spireH(); b.band = 0.15; b.seed = 0.77; b.kind = 1;
    lp = p; nl = n;
  } else {
    b = dc_bld(p, c);
    lp = b.lp;
    let ca = cos(c.ang); let sa = sin(c.ang);
    nl = vec3f(ca * n.x + sa * n.z, n.y, -sa * n.x + ca * n.z);
    if (b.kind == 2) {
      let tw = S.p[5].x * 1.4 / max(b.H, 0.3);
      let r = rot2(lp.y * tw);
      let q2 = r * lp.xz;
      let n2 = r * nl.xz;
      lp = vec3f(q2.x, lp.y, q2.y);
      nl = vec3f(n2.x, nl.y, n2.y);
    }
  }
  var u: f32;
  var fw: f32;
  var face: f32;
  if (b.kind == 1) {
    u = atan2(lp.z, lp.x) * min(b.hx, b.hz);
    fw = 3.14159 * min(b.hx, b.hz);
    face = floor(atan2(lp.z, lp.x) / 0.785 + 4.5);
  } else if (abs(nl.x) > abs(nl.z)) {
    u = lp.z; fw = b.hz * select(1.0, 0.76, b.kind == 0 && lp.y > b.H * 0.6); face = select(1.0, 3.0, nl.x < 0.0);
  } else {
    u = lp.x; fw = b.hx * select(1.0, 0.76, b.kind == 0 && lp.y > b.H * 0.6); face = select(0.0, 2.0, nl.z < 0.0);
  }
  let v = lp.y;
  let roof = nl.y > 0.6;
  let lvl = spec(b.band * 0.85 + 0.05);
  let bh = hz + b.band * 0.5;
  let mat = dc_matMode();

  // Lighting: moon key, sky ambient, street glow from below.
  let md = normalize(vec3f(-0.4, 0.55, 1.0));
  let amb = palRampL(0.35, 0.045) * (0.6 + 0.4 * n.y);
  let up = palL(hz + 0.3, 0.12) * exp(-max(v, 0.0) * 3.0) * (0.6 + F.bass) * (1.0 - f32(roof));
  let key = palL(hz + 0.6, 0.1) * sat(dot(n, md));
  var albedo = 0.35;
  var em = vec3f(0.0);
  let gate = 1.0 - 0.6 * S.p[3].x;

  if (roof) {
    albedo = 0.2;
    // Roof: a faint data grid, a helipad ring on the tallest towers, blinking corner lights.
    let rg = abs(fract(lp.xz / 0.06) - 0.5) * 0.06;
    let rw = max(0.003, foot);
    em += palL(hz + 0.5, 0.05) * sat(1.0 - min(rg.x, rg.y) / rw) * (0.003 / rw) * (1.0 + 2.0 * lvl);
    let rr = length(lp.xz);
    em += palL(hz + 0.5, 0.5) * smoothstep(0.012, 0.0, abs(rr - min(b.hx, b.hz) * 0.5)) * (0.3 + F.beatPulse) * step(0.75, b.seed) * step(dc_hs() * 0.5, b.H);
    let blink = 0.12 + 2.5 * S.p[7].y;
    em += palL(hz + 0.1, 2.0) * smoothstep(0.03, 0.0, length(abs(lp.xz) - vec2f(b.hx, b.hz) * 0.85)) * blink;
  } else if (mat == 0) {
    // Circuit board: hashed traces on a fine grid, packet buses climbing the facade.
    albedo = 0.18;
    let gs = 0.05;
    let gp = vec2f(u, v) / gs;
    let gi = floor(gp);
    let gf = fract(gp) - 0.5;
    let hh = hash13(vec3f(gi, face + b.seed * 19.0));
    let lw = max(0.07, foot / gs);
    var tr = 0.0;
    if (hh < 0.35) { tr = sat(1.0 - abs(gf.y) / lw); } else if (hh < 0.6) { tr = sat(1.0 - abs(gf.x) / lw); }
    else if (hh < 0.75) { tr = max(sat(1.0 - abs(gf.x) / lw) * step(gf.y, 0.0), sat(1.0 - abs(gf.y) / lw) * step(gf.x, 0.0)); }
    let pad = sat(1.0 - (length(gf) - 0.16) / lw) * step(0.88, hh);
    tr = max(tr, pad) * (0.07 / lw);
    em += palL(bh + 0.15, 0.07 + 0.25 * lvl) * tr * gate;
    let bus = floor(u / (gs * 4.0));
    let bx = fract(u / (gs * 4.0)) - 0.5;
    let bl = sat(1.0 - abs(bx) / max(0.06, foot / (gs * 4.0)));
    let pk = fract(v * 1.8 - dc_flow() * 0.7 * (1.0 + 2.0 * lvl + 2.0 * S.p[3].x) + hash11(bus + b.seed * 31.0) * 5.0);
    em += palL(bh, 1.0) * bl * pow(pk, 12.0) * (0.5 + 5.0 * lvl * lvl) * step(0.4, hash11(bus * 1.7 + face));
  } else if (mat == 1) {
    // Window grid: occupancy follows energy; whole floors flash on the kick.
    albedo = 0.12;
    let fh = 0.06;
    let wc = vec2f(u / 0.045, v / fh);
    let wi = floor(wc);
    let wf = fract(wc);
    let win = smoothstep(0.1, 0.18, wf.x) * smoothstep(0.9, 0.82, wf.x) * smoothstep(0.15, 0.25, wf.y) * smoothstep(0.85, 0.75, wf.y);
    let hw = hash13(vec3f(wi, face + b.seed * 13.0));
    let occ = (0.25 + 0.45 * F.energySlow) * gate + S.p[3].y;
    let lit = step(hw, occ);
    let wcol = palL(bh + 0.35 * fract(hw * 7.0), 0.5 + 0.7 * fract(hw * 3.1));
    let aa = sat(0.02 / max(foot, 0.002));
    em += wcol * win * lit * mix(0.3, 1.0, aa);
    em += palL(hz, 0.015) * (1.0 - win);
  } else if (mat == 2) {
    // Glass curtain wall: sky reflection, mullions, LED bands chasing around the floors.
    albedo = 0.05;
    let r = reflect(rd, n);
    let fre = 0.12 + 0.88 * pow(1.0 - sat(dot(n, -rd)), 4.0);
    em += dc_sky(r) * fre * 2.5;
    let mw = max(0.004, foot);
    let mu = abs(fract(u / 0.08) - 0.5) * 0.08;
    em += palL(hz + 0.5, 0.03) * sat(1.0 - mu / mw) * (0.004 / mw);
    let band = 0.25;
    let bv = abs(fract(v / band) - 0.5) * band;
    let bw = max(0.008, foot);
    let chase = pow(fract(u * 1.5 / max(fw, 0.05) - dc_flow() + v * 0.7), 6.0);
    em += palL(bh + floor(v / band) * 0.07, 0.8) * sat(1.0 - bv / bw) * (0.008 / bw) * (0.3 + 2.5 * lvl * chase + F.beatPulse * 0.6) * gate;
  } else {
    // Tron edges: black faces with glowing corners and floor rings pulsing upward.
    albedo = 0.06;
    let ew = max(0.01, foot);
    let edge = sat(1.0 - (fw - abs(u)) / ew) * (0.01 / ew);
    let rings = abs(fract(v / 0.2) - 0.5) * 0.2;
    let rw = max(0.005, foot);
    let ring = sat(1.0 - rings / rw) * (0.005 / rw);
    let wave = pow(fract(v * 0.6 - dc_flow() * (0.6 + 0.6 * lvl) + b.seed * 3.0), 8.0);
    em += palL(bh, 0.4 + 2.0 * wave) * edge * gate;
    em += palL(bh + 0.2, 0.15 + 2.2 * wave * lvl) * ring * gate;
    em += palL(hz, 0.01);
  }

  // Holographic billboard on one face of some towers.
  let hb = hash11(b.seed * 91.7 + 3.0);
  if (!roof && !isSpire && hb < 0.45 && face == floor(hb * 8.0) % 4.0 && b.H > 0.4) {
    let bw = fw * 0.82;
    let bhh = min(bw * 0.75, b.H * 0.25);
    let vb = b.H * (0.45 + 0.3 * fract(hb * 13.0)) - bhh;
    let pu = (u + bw) / (2.0 * bw);
    let pv = (v - vb) / (2.0 * bhh);
    if (pu > 0.0 && pu < 1.0 && pv > 0.0 && pv < 1.0) {
      let kind = i32(fract(hb * 7.0 + S.p[5].y) * 3.0);
      var img = 0.0;
      if (kind == 0) {
        let col = floor(pu * 12.0);
        let lv = spec(col / 12.0 * 0.85 + 0.03);
        img = step(pv, 0.08 + 0.9 * lv) * step(0.12, fract(pu * 12.0)) * step(0.2, fract(pv * 14.0));
      } else if (kind == 1) {
        let rr = length((vec2f(pu, pv) - 0.5) * vec2f(bw / bhh, 1.0));
        img = smoothstep(0.08, 0.0, abs(fract(rr * 2.5 - F.beatPhase) - 0.5) - 0.1) * smoothstep(1.2, 0.3, rr);
      } else {
        let gi = floor(vec2f(pu * 16.0 + floor(dc_flow() * 4.0) * select(0.0, 1.0, hb > 0.2), pv * 8.0));
        img = step(0.55, hash12(gi + floor(S.p[5].z))) * step(0.15, fract(pu * 16.0)) * step(0.2, fract(pv * 8.0));
      }
      let scan = 1.0;
      let frame = step(min(min(pu, 1.0 - pu), min(pv, 1.0 - pv)), 0.03);
      let bc = palL(bh + 0.5 + pu * 0.2, 1.0) * (0.5 + 2.0 * S.p[7].y + 0.6 * F.chordPulse + 1.5 * S.p[3].y);
      em = em * 0.2 + bc * (img * scan + frame * 0.6) * mix(1.0, 0.4, S.p[3].x);
    }
  }
  if (isSpire) {
    // Spire: ring lights pulsing up on beats, light strips on the octagon edges, beacon.
    let sh = dc_spireH();
    let seg = sh / 7.0;
    let ri = floor(p.y / seg);
    let ry = abs(fmod(p.y, seg) - seg * 0.5);
    let ringLit = step(length(p.xz), dc_cs() * 0.42 * (1.0 - 0.85 * sat(p.y / sh)) + 0.08) * smoothstep(0.03, 0.01, ry);
    let climb = exp(-pow((ri / 7.0 - S.p[7].x * 2.5) * 5.0, 2.0)) * exp(-S.p[7].x * 2.0);
    em += palL(hz + ri * 0.08, 0.6 + 4.0 * climb + 2.0 * S.p[3].y) * ringLit;
    let oa = atan2(p.z, p.x) / 0.7854;
    let ow = abs(fract(oa + 0.5) - 0.5) * 0.7854 * length(p.xz);
    let sw2 = max(0.004, foot);
    em += palL(hz + 0.5, 0.5 + 3.0 * lvl * pow(fract(p.y * 0.5 - dc_flow()), 4.0)) * sat(1.0 - ow / sw2) * (0.004 / sw2) * step(p.y, sh);
    em += palL(hz + 0.1, 6.0) * smoothstep(0.06, 0.0, length(p - vec3f(0.0, sh * 1.25, 0.0))) * (0.4 + 2.5 * S.p[7].y);
  }
  // Kick: a band of light climbing every facade from the street.
  if (!roof) {
    let kAge = S.p[7].x;
    let hk = kAge * dc_hs() * 2.2;
    let kb = exp(-pow((v - hk) / (0.1 * dc_hs()), 2.0)) * exp(-kAge * 5.0);
    em += palL(hz + 0.15, 0.3) * kb * (0.5 + 0.5 * F.energy) * smoothstep(0.8, 2.5, length(p - dc_ro) / dc_cs());
  }
  em += dc_drone(p, n);
  // Snare: the crown floors of every tower fire.
  if (!roof && !isSpire) {
    let crown = smoothstep(b.H * 0.86, b.H * 0.9, v) * step(v, b.H * 1.001);
    em += palL(hz + 0.85, 0.9) * crown * S.p[7].y * 1.6 * smoothstep(0.8, 2.5, length(p - dc_ro) / dc_cs());
  }
  // Drop ring on facades.
  let R = (1.0 - S.p[3].y) * dc_cs() * 22.0;
  em += palL(hz + 0.3, 2.0) * exp(-abs(length(p.xz - dc_ro.xz) - R) * 5.0) * S.p[3].y;
  let ao = 0.35 + 0.65 * sat(v / 0.5 + 0.2);
  return albedo * (amb + key + up) * ao + em;
}

fn dc_shade(p: vec3f, rd: vec3f, t: f32, mat: f32, pxA: f32) -> vec3f {
  let foot = t * pxA;
  if (mat < 0.5) {
    return dc_groundEmit(p, foot / max(abs(rd.y), 0.15));
  }
  let n = dc_normal(p, 0.0015 + 0.0006 * t);
  return dc_building(p, n, rd, t, foot / max(abs(dot(n, rd)), 0.2), mat > 1.5);
}

fn dc_fog(col: vec3f, rd: vec3f, t: f32) -> vec3f {
  let fd = dc_fogDensity();
  let fogAmt = 1.0 - exp(-t * fd);
  let fc = dc_sky(normalize(vec3f(rd.x, min(rd.y, 0.0) * 0.2 + 0.01, rd.z)));
  return mix(col, fc, fogAmt);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let cs = dc_cs();
  let hs = dc_hs();
  let mode = dc_camMode();
  let L = dc_layout();
  let tr = S.p[2].x;
  let ev = F.evolve;
  let antic = S.p[3].x;
  var ro: vec3f;
  var fwd: vec3f;
  var fov = 1.6;
  let sw = S.p[3].w * cs;
  if (mode == 0 || mode == 1) {
    // Corridor flight along a street: rooftop level (0) or street level (1).
    let low = mode == 1;
    let y = select(hs * (1.15 + 0.45 * ev.x), 0.06 * hs + 0.08 + 0.06 * ev.x, low) + select(0.0, 0.2 * hs, L == 3 && low);
    let sway = sin(S.p[2].y * 0.5 + ev.z * 3.0) * sw * 0.35;
    let lookY = select(-0.28 - 0.2 * ev.y, 0.05 + 0.12 * ev.y, low);
    let yaw = (sin(S.p[2].y * 0.11) + (F.morph.y - 0.5) * 0.6) * select(0.3, 0.14, low);
    if (L == 1) {
      let R = 5.0 * cs + sway;
      let a = tr * cs * select(1.2, 1.6, low) / R;
      ro = vec3f(cos(a) * R, y, sin(a) * R);
      let tg = vec3f(-sin(a), 0.0, cos(a));
      let rad = vec3f(cos(a), 0.0, sin(a));
      fwd = normalize(tg + rad * (yaw - 0.12) + vec3f(0.0, lookY, 0.0));
    } else {
      let z = tr * cs * select(1.3, 1.7, low);
      ro = vec3f(cs * 3.0 + sway, y, z);
      fwd = normalize(vec3f(yaw, lookY, 1.0));
    }
    fov = select(1.35, 1.2, low);
  } else if (mode == 2) {
    let a = S.p[2].y * 0.08 * S.p[5].x + S.p[2].z * 6.28;
    let R = dc_plazaR() * (0.7 + 0.2 * ev.x);
    ro = vec3f(cos(a) * R, hs * (0.7 + 1.3 * ev.y), sin(a) * R);
    let ta = vec3f(sin(a * 1.7) * cs * 0.6, hs * (0.6 + 1.1 * ev.w), cos(a * 1.3) * cs * 0.6);
    fwd = normalize(ta - ro);
    fov = 1.15;
  } else {
    // High crane: circles a point that drifts through the city, looking down at 40-60 degrees.
    let z = tr * cs * 0.5;
    let ctr = vec3f(sin(z * 0.04) * cs * 4.0 + 0.5 * cs, 0.0, z);
    let a = S.p[2].y * 0.03 * S.p[5].x + S.p[2].z * 6.28;
    let R = hs * (2.2 + 1.0 * ev.y);
    ro = ctr + vec3f(cos(a) * R, hs * (2.9 + 1.0 * ev.x), sin(a) * R);
    if (L == 1) { ro = vec3f(ro.x * 0.3, ro.y, ro.z * 0.0 + sin(a) * R); }
    fwd = normalize(select(ctr, vec3f(0.0, hs * 0.8, 0.0), L == 1) + vec3f(0.0, hs * 0.3, 0.0) - ro);
    fov = 1.4;
  }
  // Anticipation: tighten; drop: punch out.
  fov *= 1.0 + 0.12 * antic - 0.1 * S.p[3].y;
  dc_ro = ro;
  // The melody's drone flies ahead; its altitude follows the pitch.
  let pitch = S.p[6].z;
  let fh = normalize(vec3f(fwd.x, 0.0, fwd.z) + vec3f(1e-4, 0.0, 0.0));
  let dAhead = select(hs * 1.4, cs * 2.4, mode == 0 || mode == 1);
  let eY = select(dc_groundY() + hs * (0.75 + 0.5 * pitch), dc_groundY() + hs * (0.5 + 0.3 * pitch), mode == 0);
  dc_E = vec3f(ro.x + fh.x * dAhead, eY, ro.z + fh.z * dAhead);
  dc_ECol = palL(dc_hue() + 0.45 + 0.2 * pitch, 1.0);
  let rollRef = select(vec3f(0.0, 1.0, 0.0), normalize(vec3f(sin(S.p[2].y * 0.03), 0.0, cos(S.p[2].y * 0.03))), mode == 3);
  let roll = select(0.0, sin(S.p[2].y * 0.07) * 0.06, mode == 1);
  let uu = normalize(cross(fwd, normalize(rollRef + vec3f(roll, 0.0, 0.0))));
  let vv = cross(uu, fwd);
  let rd = normalize(q.x * uu + q.y * vv + fov * fwd);
  let pxA = 2.0 / (F.res.y * fov);

  let tmax = 70.0 * cs;
  let hit = dc_march(ro, rd, tmax, 110);
  var col: vec3f;
  if (hit.x < 0.0) {
    col = dc_sky(rd);
  } else {
    let p = ro + rd * hit.x;
    col = dc_shade(p, rd, hit.x, hit.y, pxA);
    if (hit.y < 0.5) {
      if (L == 3) {
        // Data ocean far below the islands: a slow glowing grid.
        let g = abs(fract(p.xz * 0.5 + vec2f(0.0, dc_flow() * 0.08)) - 0.5);
        let w = max(0.02, hit.x * pxA * 0.5 / max(abs(rd.y), 0.1));
        let ln = sat(1.0 - min(g.x, g.y) / w) * (0.02 / w);
        col = palL(dc_hue() + 0.6, 0.02) + palL(dc_hue() + 0.6, 0.6) * ln * (0.3 + spec(fract(p.x * 0.05)) * 2.0);
      } else {
        // Wet reflection with ripples and puddles.
        let wet = dc_wet();
        let pud = smoothstep(-0.1, 0.25, fbmFast(vec3f(p.xz * 0.8, 1.0), 3)) * 0.6 + 0.4 * wet;
        let rn = noise4fast(vec3f(p.xz * 9.0, dc_flow() * 1.5)).xy * (0.02 + 0.05 * wet * f32(dc_weather() % 2 == 1));
        let n = normalize(vec3f(rn.x, 1.0, rn.y));
        let rr = reflect(rd, n);
        let fre = 0.2 + 0.8 * pow(1.0 - sat(-rd.y), 5.0);
        let rh = dc_march(p + vec3f(0.0, 0.002, 0.0), rr, 30.0 * cs, 56);
        var refl: vec3f;
        if (rh.x < 0.0) { refl = dc_sky(rr); } else {
          let p2 = p + rr * rh.x;
          refl = dc_fog(dc_shade(p2, rr, hit.x + rh.x, rh.y, pxA * 1.5), rr, rh.x);
        }
        let base = palRampL(0.1, 0.006);
        let c2 = dc_cell(p.xz);
        let ao = sat(0.4 + dc_bld(p, c2).d * 5.0);
        col = col + base * ao + refl * fre * wet * pud * 0.9;
      }
    }
    col = dc_fog(col, rd, hit.x);
  }
  // The drone itself, where the city doesn't hide it.
  let tl = dot(dc_E - ro, rd);
  if (tl > 0.0 && (hit.x < 0.0 || tl < hit.x)) {
    let dd = length(dc_E - ro - rd * tl) / cs;
    let core = 0.0015 / (dd * dd + 0.001) + 0.004 / (dd + 0.02);
    col += dc_ECol * core * (0.12 + 0.35 * S.p[6].y + 1.4 * S.p[6].x);
  }
  col *= 1.0 - 0.3 * antic;
  return vec4f(col, 1.0);
}
`,
});
