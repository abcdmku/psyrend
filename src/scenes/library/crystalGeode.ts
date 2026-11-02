import type { MusicState } from '../../audio/musicState';
import { raymarchScene } from '../raymarchScene';

const pick = (g: number, n: number) => Math.min(n - 1, Math.floor(g * n));

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
  const surge = 0.2 + 2.0 * m.kick + 0.5 * m.beatPulse;
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
 * Inside a giant geode. DNA picks the crystal habit (amethyst hexagonal points, a druzy carpet,
 * radiating needle sprays), the cave (a tunnel flown through or a spherical chamber), crystal
 * scale and length, the material (clear glass with dispersion fringes, milky quartz glowing from
 * within, iridescent metal), the lighting (a lantern core, a sunbeam through a crack,
 * bioluminescent tips) and the beat grammar.
 *
 * The music: the melody is a wandering light that drifts along the crystal wall ahead; the pitch
 * sets its height up the wall, every note flares it, wakes the crystals around it from inside and
 * sends a ring of light out across the tips. Each kick sends a wave of inner light down the cave
 * through the crystal bodies; each snare strikes a third of the crystal tips. Travel surges on
 * the kicks and rests between them; the chamber turns on downbeats. Chords ease the tint round
 * the wheel; anticipation dims the cave and grows the crystals; the drop opens the light.
 */
const TAU = Math.PI * 2;

export default raymarchScene({
  meta: {
    id: 'crystal-geode',
    name: 'Geode',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.1, 0.85],
    mood: { valence: 0.6, arousal: 0.35 },
    genres: { ambient: 1, classical: 0.85, pop: 0.7, edm: 0.6, acoustic: 0.5, synthwave: 0.5, lofi: 0.5, jazz: 0.4 },
    trails: 0.2,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    tick(m, ctx.dt);
    const g = ctx.dna;
    const ev = ctx.evolve;
    const habit = [0, 2, 3][pick(g[0], 3)];
    const shape = pick(g[1], 2);
    const mat = pick(g[3], 3);
    const light = pick(g[5], 3);
    const grammar = pick(g[7], 3);
    const antic = m.anticipation;
    const drop = m.dropPulse;
    const R0 = shape === 0 ? 3.2 + 1.6 * g[2] : 4 + 2.5 * g[2];
    // Cell size along the wall per habit (druzy is dense, needles sparse).
    const cs = [0.9, 0.85, 0.32, 1.0][habit] * (0.75 + 0.6 * g[4]) * (R0 / 4.5);
    const len = [1.25, 0.6, 0.3, 1.7][habit] * (0.7 + 0.6 * g[4]) * (R0 / 4.5);
    const T = mc.travel;
    const sp = mc.turn;
    let ro: number[];
    let ta: number[];
    let roll = 0;
    let fov = 1.25;
    if (shape === 0) {
      const z = T * 0.9;
      ro = [0.22 * R0 * Math.sin(z * 0.13), 0.18 * R0 * Math.cos(z * 0.1), z];
      ta = [0.22 * R0 * Math.sin(z * 0.13 + 0.5) + Math.sin(sp * 0.3) * 0.8 * (g[6] - 0.3), 0.18 * R0 * Math.cos(z * 0.1 + 0.4), z + 4];
      roll = 0.12 * Math.sin(sp * 0.4);
    } else {
      const a = sp * 0.2 + g[6] * TAU;
      const r = 0.25 * R0;
      ro = [Math.cos(a) * r, 0.2 * R0 * Math.sin(sp * 0.12), Math.sin(a) * r];
      const b = a + (g[6] < 0.5 ? 0.9 : -0.9) + 0.4 * Math.sin(sp * 0.15);
      ta = [Math.cos(b) * R0, R0 * 0.5 * (ev[0] - 0.5), Math.sin(b) * R0];
      fov = 1.1;
    }
    const growth = (1 + 0.3 * antic * (1 - drop)) * (grammar === 1 ? 1 + 0.04 * m.kick : 1);
    const coreI = (0.7 + 1.2 * m.energySlow) * (1 - 0.6 * antic) + 1.2 * drop;

    p[0] = habit; p[1] = shape; p[2] = mat; p[3] = light;
    p[4] = R0; p[5] = cs; p[6] = len * growth; p[7] = grammar;
    p[8] = ro[0]; p[9] = ro[1]; p[10] = ro[2]; p[11] = roll;
    p[12] = ta[0]; p[13] = ta[1]; p[14] = ta[2]; p[15] = fov;
    p[16] = coreI; p[17] = ((g[2] * 1.9 + g[5] * 0.37) % 1) + 0.3 * chordHue(); p[18] = 0.25 + 0.5 * g[6]; p[19] = (g[0] * 53.1) % 1;
    p[20] = m.snare; p[21] = 0.02 + 0.03 * g[6] + 0.03 * m.tension; p[22] = (0.6 + 0.6 * ctx.intensity) * (1 - 0.4 * antic) + 0.6 * drop; p[23] = m.leadPitch;
    // Tunnel lantern runs ahead of the camera; the chamber keeps it at the centre.
    p[24] = shape === 0 ? ro[0] * 0.3 : 0; p[25] = shape === 0 ? ro[1] * 0.3 : 0; p[26] = shape === 0 ? ro[2] + 5 + 2 * Math.sin(sp * 0.3) : 0; p[27] = drop;
    // Melody light and kick wave.
    p[28] = m.lead; p[29] = mc.held; p[30] = mc.leadAge; p[31] = mc.kickAge;
  },
  wgsl: /* wgsl */ `
var<private> cg_id: f32;
var<private> cg_h: f32;

fn cg_hexN(x: f32, y: f32) -> f32 { return max(abs(x) * 0.866025 + abs(y) * 0.5, abs(y)); }

// One crystal in its local frame: (x, y) across, h along the growth axis from the base.
fn cg_crystal(x: f32, y: f32, h: f32, L: f32, hs: vec3f) -> f32 {
  let habit = S.p[0].x;
  if (habit < 0.5 || (habit > 1.5 && habit < 2.5)) {
    // Hexagonal point (amethyst), or a short druzy pyramid.
    let r = L * select(0.27, 0.42, habit > 1.5);
    let tipK = select(1.6, 1.0, habit > 1.5);
    let hx = cg_hexN(x, y);
    let side = hx - r;
    let tip = (hx * tipK / r * r + h - L) / sqrt(1.0 + tipK * tipK);
    return max(max(side, tip), -h - r);
  }
  // Needle.
  let r = L * 0.035;
  let hx = cg_hexN(x, y);
  let tip = (hx * 8.0 + h - L) / 8.06;
  return max(max(hx - r, tip), -h);
}

fn cg_place(p: vec3f, B: vec3f, N: vec3f, T1: vec3f, T2: vec3f, hs: vec3f) -> f32 {
  let tilt = S.p[4].z;
  let L = S.p[1].z * (0.45 + 0.75 * hs.z);
  var d = 1e9;
  let habit = S.p[0].x;
  let sprays = select(1, 3, habit > 2.5 && habit < 3.5);
  for (var k = 0; k < sprays; k++) {
    let fk = f32(k);
    let hk = fract(hs * (1.0 + fk * 3.17) + fk * 0.37);
    let spread = select(tilt * select(1.0, 0.45, habit > 3.5), 0.9, sprays > 1);
    let A = normalize(N + spread * ((hk.x - 0.5) * T1 + (hk.y - 0.5) * T2));
    let e1 = normalize(cross(A, T2 + vec3f(0.0, 0.0, 1e-3)));
    let e2 = cross(A, e1);
    let dp = p - B;
    let h = dot(dp, A);
    let ca = cos(hk.z * 6.0); let sa = sin(hk.z * 6.0);
    let x0 = dot(dp, e1); let y0 = dot(dp, e2);
    let x = ca * x0 - sa * y0;
    let y = sa * x0 + ca * y0;
    let Lk = L * select(1.0, 0.6 + 0.6 * hk.z, sprays > 1);
    let c = cg_crystal(x, y, h, Lk, hk);
    if (c < d) { d = c; cg_h = sat(h / Lk); }
  }
  return d;
}

// Crystals on a cylinder wall (tunnel along z).
fn cg_tunnel(p: vec3f) -> f32 {
  let R0 = S.p[1].x;
  let cs = S.p[1].y;
  let nA = max(floor(TAU * R0 / cs), 6.0);
  let csA = TAU / nA;
  let u = atan2(p.y, p.x) / csA;
  let v = p.z / cs;
  let i0 = floor(u - 0.5);
  let j0 = floor(v - 0.5);
  var d = 1e9;
  for (var a = 0; a < 2; a++) {
    for (var b = 0; b < 2; b++) {
      let ci = i0 + f32(a);
      let cj = j0 + f32(b);
      let cw = fmod(ci, nA);
      let hs = hash33(vec3f(cw, cj, S.p[4].w * 17.0));
      let th = (ci + 0.2 + 0.6 * hs.x) * csA;
      let rad = vec3f(cos(th), sin(th), 0.0);
      let B = rad * R0 * 1.02 + vec3f(0.0, 0.0, (cj + 0.2 + 0.6 * hs.y) * cs);
      let c = cg_place(p, B, -rad, vec3f(-rad.y, rad.x, 0.0), vec3f(0.0, 0.0, 1.0), hs);
      if (c < d) { d = c; cg_id = hs.z + hs.x * 0.37; }
    }
  }
  return d;
}

// Crystals on a sphere wall, placed on a cube-sphere grid.
fn cg_sphere(p: vec3f) -> f32 {
  let R0 = S.p[1].x;
  let cs = S.p[1].y / R0;
  let ap = abs(p);
  var ax = vec3f(0.0, 0.0, sign(p.z));
  var uvw = vec2f(p.x, p.y) / max(ap.z, 1e-4);
  var e1 = vec3f(1.0, 0.0, 0.0);
  var e2 = vec3f(0.0, 1.0, 0.0);
  if (ap.x >= ap.y && ap.x >= ap.z) {
    ax = vec3f(sign(p.x), 0.0, 0.0); uvw = vec2f(p.y, p.z) / ap.x; e1 = vec3f(0.0, 1.0, 0.0); e2 = vec3f(0.0, 0.0, 1.0);
  } else if (ap.y >= ap.z) {
    ax = vec3f(0.0, sign(p.y), 0.0); uvw = vec2f(p.x, p.z) / ap.y; e1 = vec3f(1.0, 0.0, 0.0); e2 = vec3f(0.0, 0.0, 1.0);
  }
  let g = uvw / cs;
  let i0 = floor(g - 0.5);
  var d = 1e9;
  for (var a = 0; a < 2; a++) {
    for (var b = 0; b < 2; b++) {
      let c = i0 + vec2f(f32(a), f32(b));
      let hs = hash33(vec3f(c, dot(ax, vec3f(1.0, 3.0, 5.0)) + S.p[4].w * 17.0));
      let uc = (c + 0.2 + 0.6 * hs.xy) * cs;
      let dir = normalize(ax + e1 * uc.x + e2 * uc.y);
      let B = dir * R0 * 1.02;
      let t1 = normalize(cross(dir, e2 + vec3f(0.0, 1e-3, 0.0)));
      let t2 = cross(dir, t1);
      let cr = cg_place(p, B, -dir, t1, t2, hs);
      if (cr < d) { d = cr; cg_id = hs.z + hs.x * 0.37; }
    }
  }
  return d;
}

// Returns (distance, material): 0 rock, 1 crystal.
fn cg_map(p: vec3f) -> vec2f {
  let R0 = S.p[1].x;
  let shape = S.p[0].y;
  var rock: f32;
  var cr: f32;
  let bump = 0.05 * R0 * sin(p.x * 1.3 + 2.0 * sin(p.z * 0.9)) * sin(p.y * 1.1 + 1.7 * sin(p.x * 0.7)) ;
  // Crystals only live in a band inside the wall: skip them elsewhere.
  let reach = S.p[1].z * 1.3 + S.p[1].y * 0.6;
  if (shape < 0.5) {
    let rr = length(p.xy);
    rock = R0 * 1.05 - rr + bump;
    let wd = R0 * 1.02 - rr;
    if (wd > reach) { cr = wd - reach + 0.1; } else { cr = cg_tunnel(p); }
  } else {
    let r = length(p);
    rock = R0 * 1.05 - r + bump;
    let wd = R0 * 1.02 - r;
    if (wd > reach) { cr = wd - reach + 0.1; } else if (wd < -0.3 * R0) { cr = -wd; } else { cr = cg_sphere(p); }
  }
  return select(vec2f(rock, 0.0), vec2f(cr * 0.8, 1.0), cr * 0.8 < rock);
}

fn cg_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * cg_map(p + k.xyy * e).x + k.yyx * cg_map(p + k.yyx * e).x +
                   k.yxy * cg_map(p + k.yxy * e).x + k.xxx * cg_map(p + k.xxx * e).x);
}

fn cg_core() -> vec3f { return S.p[6].xyz; }
fn cg_coreCol() -> vec3f { return palL(S.p[4].y + 0.1 + F.morph2.x * 0.12, 1.0); }

// Radiance seen inside the cave in direction rd from pos (no tracing): the lantern,
// a speckle of distant glowing crystals and a dim palette ambience.
fn cg_env(pos: vec3f, rd: vec3f) -> vec3f {
  let hue = S.p[4].y;
  let lt = S.p[0].w;
  var c = mix(palL(hue + 0.55, 0.012), palL(hue + 0.35, 0.03), sat(rd.y * 0.5 + 0.5));
  let sp = pow(sat(noise3fast(rd * 9.0 + vec3f(3.0)) * 0.5 + 0.5), 8.0);
  c += palL(hue + 0.2 + rd.x * 0.2, 1.0) * sp * 0.6;
  if (lt < 0.5) {
    let tc = cg_core() - pos;
    let dl = length(tc);
    let al = sat(dot(rd, tc / dl));
    c += cg_coreCol() * S.p[4].x * (pow(al, 60.0) * 1.5 + pow(al, 6.0) * 0.12) / (1.0 + 0.04 * dl * dl);
  } else if (lt < 1.5) {
    let L = normalize(vec3f(0.3, 1.0, -0.25));
    c += mix(vec3f(1.0, 0.95, 0.85), palL(hue + 0.05, 1.0), 0.3) * (pow(sat(dot(rd, L)), 80.0) * 6.0 + pow(sat(dot(rd, L)), 4.0) * 0.12);
  }
  return c;
}

fn cg_ao(p: vec3f, n: vec3f, s: f32) -> f32 {
  var o = 0.0; var w = 1.0;
  for (var i = 1; i <= 3; i++) {
    let h = s * (0.05 + 0.15 * f32(i));
    o += (h - cg_map(p + n * h).x) / s * w;
    w *= 0.6;
  }
  return sat(1.0 - o * 1.8);
}

fn cg_light(pos: vec3f, n: vec3f) -> vec3f {
  let lt = S.p[0].w;
  let hue = S.p[4].y;
  if (lt < 0.5) {
    let tc = cg_core() - pos;
    let dl = length(tc);
    return cg_coreCol() * S.p[4].x * (sat(dot(n, tc / dl)) * 0.8 + 0.2) / (1.0 + 0.12 * dl * dl) * select(1.6, 0.6, S.p[0].y > 0.5);
  }
  if (lt < 1.5) {
    let L = normalize(vec3f(0.3, 1.0, -0.25));
    // Sunbeam through a crack: a soft shaft around a line through the cave centre.
    let axisP = cg_core();
    let rel = pos - axisP;
    let off = length(rel - L * dot(rel, L));
    let beam = exp(-off * off / (S.p[1].x * S.p[1].x * 0.08));
    return mix(vec3f(1.0, 0.95, 0.85), palL(hue + 0.05, 1.0), 0.3) * (sat(dot(n, L)) * 2.2 * beam + 0.05) + cg_coreCol() * 0.05 * S.p[4].x;
  }
  return palL(hue + 0.6, 0.05) * (0.5 + 0.5 * n.y) + cg_coreCol() * 0.03 * S.p[4].x;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[2].xyz;
  let cam = lookAt(ro, S.p[3].xyz, S.p[2].w);
  let rd = normalize(cam * vec3f(q, S.p[3].w));
  let R0 = S.p[1].x;
  let hue = S.p[4].y + F.morph2.x * 0.12;
  let mat = S.p[0].z;
  let lt = S.p[0].w;
  let shape = S.p[0].y;

  var t = 0.01 + ign(frag) * 0.02;
  let far = select(R0 * 5.0, R0 * 7.0, shape < 0.5);
  let us = R0 / 4.5;
  // The melody light: drifts along the wall ahead, its height up the wall set by the pitch.
  let pitch = S.p[5].w;
  let flare = S.p[7].x;
  let held = S.p[7].y;
  let leadAge = S.p[7].z;
  var lp: vec3f;
  if (shape < 0.5) {
    let side = select(-1.0, 1.0, S.p[4].z > 0.5);
    let a = -0.5 * PI + side * (pitch + 1.0) * 0.43 * PI;
    lp = vec3f(cos(a) * 0.6 * R0, sin(a) * 0.6 * R0, ro.z + 3.5 * us);
  } else {
    let hd = normalize(S.p[3].xz - ro.xz + vec2f(1e-4, 0.0));
    let e = pitch * 0.9;
    lp = vec3f(hd.x * cos(e), sin(e), hd.y * cos(e)) * 0.6 * R0;
  }
  let leadCol = palL(hue + 0.45 + 0.2 * pitch, 1.0);
  let LI = (0.3 * held + 3.2 * flare) * select(1.0, 0.6, shape > 0.5);
  var hit = false;
  var m = 0.0;
  for (var i = 0; i < 96; i++) {
    let r = cg_map(ro + rd * t);
    if (r.x < 0.0005 * t + 0.0005) { hit = true; m = r.y; break; }
    t += r.x;
    if (t > far) { break; }
  }
  var col = cg_env(ro, rd) * 0.5;
  if (hit) {
    let pos = ro + rd * t;
    cg_id = 0.0; cg_h = 0.0;
    _ = cg_map(pos);
    let id = cg_id;
    let hh = cg_h;
    let n = cg_normal(pos, max(0.0005, 0.0005 * t));
    let ao = cg_ao(pos, n, S.p[1].y * 0.6);
    let lit = cg_light(pos, n);
    let v = -rd;
    let cosT = sat(dot(n, v));
    let band = fract(id * 3.7);
    let lvl = spec(0.04 + 0.9 * band);
    let tint = palL(hue + 0.08 * (id - 0.5) + 0.05, 1.0);
    if (m < 0.5) {
      // Rock: agate banding by depth into the shell, polished on the cut face.
      let r = length(pos);
      let bandP = r / R0 * 9.0 + 0.6 * sin(atan2(pos.y, pos.x) * 3.0 + r * 2.0) + noise3(pos * 1.5) * 0.6;
      let agate = 0.5 + 0.5 * sin(bandP * TAU * 0.5);
      let alb = palRampL(0.15 + 0.5 * agate, 0.03 + 0.12 * agate * agate);
      col = alb * (lit + cg_env(pos, n) * 2.0) * ao;
    } else {
      let fre = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);
      let rf = reflect(rd, n);
      if (mat < 1.5) {
        // Through the crystal: march to the exit, refract out per channel (dispersion).
        let ior = 1.55;
        let ri = refract(rd, n, 1.0 / ior);
        var tt = 0.02 * S.p[1].y;
        for (var k = 0; k < 10; k++) {
          let hdist = -cg_map(pos + ri * tt).x;
          if (hdist < 0.002) { break; }
          tt += max(hdist, 0.01);
        }
        let ex = pos + ri * tt;
        let n2 = -cg_normal(ex, 0.002);
        let disp = S.p[5].y * 6.0;
        var tr = vec3f(0.0);
        for (var c = 0; c < 3; c++) {
          let io = ior + (f32(c) - 1.0) * disp * 0.05;
          var od = refract(ri, n2, io);
          if (dot(od, od) < 0.01) { od = reflect(ri, n2); }
          var e = cg_env(ex, od) + cg_light(ex, od) * 0.15;
          tr[c] = e[c];
        }
        let absorb = select(0.15, 0.9, mat > 0.5);
        let tcol = mix(vec3f(1.0), tint * 0.9, sat(tt * absorb / S.p[1].y));
        col = tr * tcol * 1.1 * (1.0 - fre) + cg_env(pos, rf) * fre * 1.5;
        if (mat > 0.5) {
          // Milky quartz: light scatters inside and glows.
          col += tint * (lit * 0.35 + 0.05) * (0.4 + 0.6 * hh);
        }
        col += lit * 0.08 * tint;
      } else {
        // Iridescent metal (bismuth / pyrite).
        let ph = cosT * 1.7 + id * 2.0 + F.morph2.y * 0.5;
        let film = 0.5 + 0.5 * cos(TAU * (ph + vec3f(0.0, 0.33, 0.67)));
        let f0 = mix(tint * 0.7, film, 0.55);
        col = (f0 + (vec3f(1.0) - f0) * fre) * (cg_env(pos, rf) * 2.5 + lit * 0.5) * ao;
      }
      // Facet highlights from the light rig, and a thin bright rim.
      var Ld = normalize(vec3f(0.3, 1.0, -0.25));
      var Lc = mix(vec3f(1.0, 0.95, 0.85), tint, 0.3) * 1.5;
      if (lt < 0.5) { Ld = normalize(cg_core() - pos); Lc = cg_coreCol() * S.p[4].x / (1.0 + 0.04 * dot(cg_core() - pos, cg_core() - pos)); }
      if (lt > 1.5) { Ld = normalize(vec3f(-0.4, 0.8, 0.5)); Lc = tint * 0.4; }
      col += Lc * (pow(sat(dot(rf, Ld)), 120.0) * 4.0 + pow(sat(dot(rf, Ld)), 12.0) * 0.12);
      col += tint * pow(1.0 - cosT, 4.0) * 0.12 * (0.5 + S.p[5].z);
      // Inner light biased toward the tip; one band per crystal.
      let pulse = (0.25 + 0.8 * lvl * lvl) * min(S.p[5].z, 1.3);
      let em = select(0.12, 0.8, lt > 1.5) * pulse + S.p[6].w * S.p[6].w * 0.3;
      col += tint * em * smoothstep(0.0, 1.0, hh) * select(0.35, 1.0, lt > 1.5) * select(1.0, 0.4, mat > 1.5);
      // Kick: a wave of inner light running down the tunnel, or sweeping round the chamber wall,
      // through the crystal bodies.
      let kA = S.p[7].w;
      var wz = t - us * (1.5 + kA * 4.0);
      if (shape > 0.5) {
        let fa = atan2(S.p[3].z - ro.z, S.p[3].x - ro.x) - 1.1;
        let wa = atan2(pos.z, pos.x) - fa - kA * 3.0;
        wz = (wa - TAU * round(wa / TAU)) * R0 * 0.5;
      }
      let kw = exp(-wz * wz / (us * us * 0.35)) * exp(-kA * 3.5) * select(1.0, 1.4, S.p[1].w < 0.5);
      col += palL(hue + 0.12, 1.0) * kw * (0.3 + 0.9 * hh) * 1.9;
      // Melody: each note rings the crystals tuned to its pitch, all through the cave.
      let tuned = smoothstep(0.08, 0.0, abs(band - (pitch * 0.5 + 0.5)));
      col += leadCol * tuned * (2.2 * flare + 0.25 * held) * (0.3 + 0.9 * hh) * select(1.0, 0.6, mat > 1.5);
      // Snare: a third of the tips strike.
      let sel = step(fract(id * 5.31), 0.34);
      col += mix(tint, vec3f(1.0), 0.5) * S.p[5].x * sel * smoothstep(0.6, 1.0, hh) * 1.6;
    }
    // The melody light: lights the wall around it, wakes the crystals there from inside and
    // sends a ring of light out across the tips on every note.
    let ld = pos - lp;
    let ldd = length(ld);
    let lg = exp(-ldd * ldd / (us * us * select(2.0, 0.8, shape > 0.5)));
    let lh = select(0.0, hh, m > 0.5);
    col += leadCol * LI * lg * (sat(dot(n, -ld / max(ldd, 1e-4))) * 0.6 + 0.2 + 0.8 * lh);
    let ringR = us * (0.3 + leadAge * 8.0);
    let ring = exp(-pow((ldd - ringR) / (us * 0.45), 2.0)) * exp(-leadAge * 3.0);
    col += leadCol * ring * (2.2 + held) * select(0.25, 0.3 + lh, m > 0.5);
  }
  // Cave haze toward the light.
  let fogA = 1.0 - exp(-t * 0.05 / us);
  col = mix(col, cg_env(ro, rd) * 0.6 + palL(hue + 0.5, 0.01), fogA);
  if (lt < 0.5) {
    // Lantern glow in the air.
    let co = cg_core() - ro;
    let tc = clamp(dot(co, rd), 0.0, t);
    let dd = length(co - rd * tc);
    col += cg_coreCol() * S.p[4].x * 0.08 / (1.0 + dd * dd * 4.0);
  }
  // The melody light itself, where the crystals don't hide it.
  let tl = dot(lp - ro, rd);
  if (tl > 0.0 && (!hit || tl < t)) {
    let dd = length(lp - ro - rd * tl) / us;
    let core = 0.002 / (dd * dd + 0.0012) + 0.02 / (dd + 0.04);
    col += leadCol * core * (0.15 + 0.4 * held + 1.6 * flare);
  }
  return vec4f(col, 1.0);
}
`,
});
