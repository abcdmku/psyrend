import { raymarchScene } from '../raymarchScene';

/**
 * Oscilloscope / vector-display geometry in true 3D. Five families: truncation-morphing
 * polyhedra with concentric face outlines, torus-knot tubes ringed with wire, 3D Lissajous
 * and spirograph traces drawn as beam segments (brighter where the beam slows), spectrum-
 * history ridgeline terrain, and polygonal wire tunnels. Solid families are raymarched with
 * black fill for hidden-line removal, or peeled through up to three layers for see-through
 * wireframes. Lines are anti-aliased in screen space, depth-faded, and coloured by a phosphor
 * model. Kicks punch, glitch or snap the geometry; builds speed the rotation and drain the
 * colour; drops flash and blow the geometry outward.
 *
 * DNA: 1 geometry family, 2 line density, 3 projection/camera, 4 phosphor model,
 * 5 multiplicity, 6 hidden-line removal + line style, 7 beat grammar.
 */
export default raymarchScene({
  // Dropped from auto-direction: most families are a wireframe object floating in a void, the
  // ridgeline family is a spectrogram readout, and the look leans on a CRT overlay and a screen
  // glitch. An unreachable energy range and mood with no genre affinity keep scoreScene() at
  // the bottom of every ranking. Still pinnable by hand.
  meta: {
    id: 'vector-geometry',
    name: 'Vector Display',
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: -1, arousal: -1 },
    genres: {},
    trails: 0.4,
    sparse: true,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const e = ctx.evolve;
    p[0] = Math.floor(g[1] * 5); // family
    p[1] = g[2]; // line density
    p[2] = Math.floor(g[3] * 4); // camera / projection
    p[3] = Math.floor(g[4] * 4); // phosphor model
    p[4] = Math.floor(g[5] * 3); // multiplicity
    p[5] = g[6] < 0.6 ? 1 : 0; // hidden-line removal
    p[6] = Math.floor(((g[6] * 4.3) % 1) * 3); // line style: solid, dashed, dotted
    p[7] = Math.floor(g[7] * 3); // beat grammar
    p[8] = ctx.travel;
    p[9] = ctx.spin;
    p[10] = m.anticipation;
    p[11] = m.dropPulse;
    p[12] = e[0];
    p[13] = e[1];
    p[14] = e[2];
    p[15] = e[3];
    p[16] = g[0];
    p[17] = ctx.intensity;
    p[18] = m.beatIndex % 512;
    p[19] = (g[5] * 7.7) % 1; // sub-shape seed
  },
  wgsl: /* wgsl */ `
const VG_PHI: f32 = 1.61803399;

var<private> vg_rot: mat3x3f;
var<private> vg_scale: f32;

fn vg_fam() -> i32 { return i32(S.p[0].x + 0.5); }
fn vg_dens() -> f32 { return S.p[0].y; }
fn vg_camMode() -> i32 { return i32(S.p[0].z + 0.5); }
fn vg_phos() -> i32 { return i32(S.p[0].w + 0.5); }
fn vg_mult() -> i32 { return i32(S.p[1].x + 0.5); }
fn vg_hidden() -> bool { return S.p[1].y > 0.5 || vg_fam() == 3; }
fn vg_style() -> i32 { return i32(S.p[1].z + 0.5); }
fn vg_grammar() -> i32 { return i32(S.p[1].w + 0.5); }
fn vg_hue() -> f32 { return S.p[4].x + F.morph2.x * 0.1; }
fn vg_morph() -> f32 { return fract(F.morph.x + 0.3 * F.evolve.x + S.p[4].w); }

// ---------- polyhedra: top two plane distances over a cube/octa or dodeca/icosa set ----------
fn vg_top2(v: f32, t: vec2f) -> vec2f {
  if (v > t.x) { return vec2f(v, t.x); }
  return vec2f(t.x, max(t.y, v));
}
fn vg_poly(p: vec3f) -> vec2f {
  let m = vg_morph();
  var t = vec2f(-1e9);
  if (S.p[4].w < 0.5) {
    let kc = 1.0;
    let ko = mix(1.75, 1.05, m);
    t = vg_top2(abs(p.x) - kc, t);
    t = vg_top2(abs(p.y) - kc, t);
    t = vg_top2(abs(p.z) - kc, t);
    let s3 = 0.57735027;
    t = vg_top2(abs(dot(p, vec3f(1.0, 1.0, 1.0) * s3)) - ko, t);
    t = vg_top2(abs(dot(p, vec3f(1.0, 1.0, -1.0) * s3)) - ko, t);
    t = vg_top2(abs(dot(p, vec3f(1.0, -1.0, 1.0) * s3)) - ko, t);
    t = vg_top2(abs(dot(p, vec3f(-1.0, 1.0, 1.0) * s3)) - ko, t);
  } else {
    let kd = 1.0;
    let ki = mix(1.26, 1.02, m);
    let a = normalize(vec3f(0.0, 1.0, VG_PHI));
    let b = normalize(vec3f(1.0, VG_PHI, 0.0));
    let c = normalize(vec3f(VG_PHI, 0.0, 1.0));
    t = vg_top2(abs(dot(p, a)) - kd, t);
    t = vg_top2(abs(dot(p, vec3f(0.0, -a.y, a.z))) - kd, t);
    t = vg_top2(abs(dot(p, b)) - kd, t);
    t = vg_top2(abs(dot(p, vec3f(-b.x, b.y, 0.0))) - kd, t);
    t = vg_top2(abs(dot(p, c)) - kd, t);
    t = vg_top2(abs(dot(p, vec3f(c.x, 0.0, -c.z))) - kd, t);
    let s3 = 0.57735027;
    let ip = 1.0 / VG_PHI;
    t = vg_top2(abs(dot(p, vec3f(1.0, 1.0, 1.0) * s3)) - ki, t);
    t = vg_top2(abs(dot(p, vec3f(1.0, 1.0, -1.0) * s3)) - ki, t);
    t = vg_top2(abs(dot(p, vec3f(1.0, -1.0, 1.0) * s3)) - ki, t);
    t = vg_top2(abs(dot(p, vec3f(-1.0, 1.0, 1.0) * s3)) - ki, t);
    let n0 = normalize(vec3f(0.0, ip, VG_PHI));
    let n1 = normalize(vec3f(ip, VG_PHI, 0.0));
    let n2 = normalize(vec3f(VG_PHI, 0.0, ip));
    t = vg_top2(abs(dot(p, n0)) - ki, t);
    t = vg_top2(abs(dot(p, vec3f(0.0, -n0.y, n0.z))) - ki, t);
    t = vg_top2(abs(dot(p, n1)) - ki, t);
    t = vg_top2(abs(dot(p, vec3f(-n1.x, n1.y, 0.0))) - ki, t);
    t = vg_top2(abs(dot(p, n2)) - ki, t);
    t = vg_top2(abs(dot(p, vec3f(n2.x, 0.0, -n2.z))) - ki, t);
  }
  return t;
}

/** Object-local position for the polyhedra and knot families (handles multiplicity). */
fn vg_local(p: vec3f) -> vec4f {
  let mu = vg_mult();
  var q = p;
  var id = 0.0;
  if (mu == 1) {
    // Ring of N around the y axis.
    let n = 5.0;
    let sec = TAU / n;
    let a = atan2(q.z, q.x);
    let k = floor(a / sec + 0.5);
    id = k;
    let r = rotY(k * sec);
    q = r * q;
    q = q - vec3f(3.2, 0.0, 0.0);
    q = rotY(F.spin * 0.3 + k) * q;
  } else if (mu == 2) {
    // Field of copies in a 3D lattice.
    let c = select(4.0, 6.0, vg_fam() == 1);
    let cid = floor(q / c + 0.5);
    id = hash13(cid);
    q = q - cid * c;
    q = rotAxis(normalize(hash33(cid) - 0.5), F.spin * 0.4 + id * 6.0) * q;
  }
  q = vg_rot * q;
  return vec4f(q / vg_scale, id);
}

// ---------- torus knot ----------
fn vg_pq() -> vec2f {
  let k = i32(floor(vg_morph() * 5.0));
  let pqs = array<vec2f, 5>(vec2f(2.0, 3.0), vec2f(3.0, 2.0), vec2f(2.0, 5.0), vec2f(3.0, 4.0), vec2f(3.0, 5.0));
  var r = vec2f(2.0, 3.0);
  for (var i = 0; i < 5; i++) { if (i == k) { r = pqs[i]; } }
  return r;
}
/** Returns (distance, knot parameter s, angle around the tube). */
fn vg_knot(p: vec3f) -> vec3f {
  let pq = vg_pq();
  let R0 = 1.0;
  let r1 = 0.42;
  let rt = 0.13 + 0.03 * F.bass;
  let phi = atan2(p.z, p.x);
  let cs = vec2f(length(p.xz) - R0, p.y);
  var best = vec3f(1e9, 0.0, 0.0);
  for (var j = 0; j < 3; j++) {
    if (f32(j) >= pq.x) { break; }
    let s = (phi + TAU * f32(j)) / pq.x;
    let th = pq.y * s;
    let c = r1 * vec2f(cos(th), sin(th));
    let v = cs - c;
    let d = length(v) - rt;
    if (d < best.x) { best = vec3f(d, s, atan2(v.y, v.x) - th); }
  }
  return best;
}

// ---------- terrain ----------
fn vg_terrH(x: f32, z: f32) -> f32 {
  let rel = z - S.p[2].x * 1.6;
  let age = sat((rel + 2.0) / 22.0);
  let bx = abs(x) / 7.0;
  let band = sat(0.04 + bx * 0.85);
  let env = smoothstep(9.0, 2.0, abs(x));
  let s = 0.5 * (hist(band, age) + hist(band + 0.04, age));
  let ridge = pow(s, 1.3) * 2.0 * env * (1.0 - 0.5 * S.p[2].z) * (0.8 + 0.4 * noise3(vec3f(x * 0.6, z * 0.4, 5.0)));
  let n = noise3(vec3f(x * 0.25, z * 0.25, 1.0)) * 0.3;
  return ridge + n * (0.4 + env) - 0.4 + S.p[2].w * 1.2 * exp(-abs(rel - (1.0 - S.p[2].w) * 20.0) * 0.6);
}

// ---------- tunnel ----------
fn vg_tunC(z: f32) -> vec2f { return vec2f(sin(z * 0.11) * 1.6 + sin(z * 0.043) * 2.0, cos(z * 0.083) * 1.2); }
fn vg_sides() -> f32 { return 3.0 + floor(fract(vg_morph() + S.p[4].w) * 6.0); }

fn vg_map(p: vec3f) -> f32 {
  let f = vg_fam();
  if (f == 0) {
    let l = vg_local(p);
    return vg_poly(l.xyz).x * vg_scale;
  }
  if (f == 1) {
    let l = vg_local(p);
    var d = vg_knot(l.xyz).x;
    if (vg_mult() == 0) {
      let q2 = rotX(1.5708) * l.xyz * 1.6;
      d = min(d, vg_knot(q2).x / 1.6 + 0.0) * 1.0;
    }
    return d * vg_scale * 0.6;
  }
  if (f == 3) {
    return (p.y - vg_terrH(p.x, p.z)) * 0.55;
  }
  let q = p.xy - vg_tunC(p.z);
  let n = vg_sides();
  let sec = TAU / n;
  let a = fmod(atan2(q.y, q.x) + F.spin * 0.1 + sec * 0.5, sec) - sec * 0.5;
  let r = 1.6 + 0.25 * F.bass - 0.5 * S.p[2].z + 1.5 * S.p[2].w;
  return (r - length(q) * cos(a)) * 0.8;
}

fn vg_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * vg_map(p + k.xyy * e) + k.yyx * vg_map(p + k.yyx * e) + k.yxy * vg_map(p + k.yxy * e) + k.xxx * vg_map(p + k.xxx * e));
}

/** Anti-aliased line from a distance in world units; returns (core, glow). */
fn vg_line(d: f32, w: f32, foot: f32) -> f32 {
  let ww = max(w, foot);
  return sat(1.0 - abs(d) / ww) * (w / ww);
}

fn vg_dash(x: f32) -> f32 {
  let st = vg_style();
  if (st == 1) { return step(0.35, fract(x)); }
  if (st == 2) { return smoothstep(0.3, 0.1, abs(fract(x) - 0.5)); }
  return 1.0;
}

/** Line intensity on a surface point: (intensity, line family id). */
fn vg_surfLines(p: vec3f, n: vec3f, rd: vec3f, foot: f32) -> vec2f {
  let f = vg_fam();
  let dn = vg_dens();
  let lw = select(0.012, 0.018, vg_mult() == 2);
  if (f == 0) {
    let l = vg_local(p);
    let t = vg_poly(l.xyz);
    let e = (t.x - t.y) * vg_scale;
    let rings = 1.0 + floor(dn * 5.0);
    let sp = 0.16 / rings * 3.0;
    let edge = vg_line(e, lw * 1.4, foot);
    let ring = vg_line(abs(fract(e / sp + 0.5) - 0.5) * sp, lw * 0.8, foot) * step(e, sp * rings + 0.001);
    let dash = vg_dash(dot(l.xyz, vec3f(3.1, 2.3, 1.7)) * 2.0);
    return vec2f(max(edge, ring * 0.7 * dash), select(1.0, 0.0, edge > ring));
  }
  if (f == 1) {
    let l = vg_local(p);
    var k = vg_knot(l.xyz);
    var kid = 0.0;
    if (vg_mult() == 0) {
      let q2 = rotX(1.5708) * l.xyz * 1.6;
      let k2 = vg_knot(q2);
      if (k2.x / 1.6 < k.x) { k = k2; kid = 1.0; }
    }
    let nr = 24.0 + floor(dn * 80.0);
    let nl = 4.0 + floor(dn * 8.0);
    let rt = 0.13 * vg_scale;
    let ring = vg_line(abs(fract(k.y * nr / TAU) - 0.5) * TAU / nr * vg_scale * 1.0, lw, foot);
    let lng = vg_line(abs(fract(k.z * nl / TAU) - 0.5) * TAU / nl * rt, lw, foot) * vg_dash(k.y * 6.0);
    return vec2f(max(ring, lng), kid + select(0.0, 0.5, lng > ring));
  }
  if (f == 3) {
    let rs = mix(0.75, 0.35, dn);
    let rel = p.z - S.p[2].x * 1.6;
    let gz = abs(fract(rel / rs) - 0.5) * rs;
    let ridge = vg_line(gz / max(sqrt(max(1.0 - n.z * n.z, 0.0)), 0.15), lw, foot);
    var gx = 0.0;
    if (dn > 0.55) {
      let xs = rs * 1.5;
      gx = vg_line(abs(fract(p.x / xs) - 0.5) * xs, lw * 0.7, foot) * 0.6;
    }
    return vec2f(max(ridge, gx), select(0.0, 1.0, gx > ridge));
  }
  // Tunnel: rings, vertex rails and optional mid rails.
  let q = p.xy - vg_tunC(p.z);
  let ns = vg_sides();
  let sec = TAU / ns;
  let ang = atan2(q.y, q.x) + F.spin * 0.1;
  let a = fmod(ang + sec * 0.5, sec) - sec * 0.5;
  let r = length(q);
  let rz = mix(0.9, 0.3, dn);
  let ring = vg_line(abs(fract(p.z / rz) - 0.5) * rz, lw, foot);
  let rail = vg_line((sec * 0.5 - abs(a)) * r, lw * 1.3, foot);
  let mid = vg_line(abs(fract(a / sec * (1.0 + floor(dn * 3.0)) + 0.5) - 0.5) * r * sec / (1.0 + floor(dn * 3.0)), lw * 0.7, foot) * vg_dash(p.z * 1.5);
  return vec2f(max(max(ring, rail), mid * 0.6), select(0.0, 1.0, rail > ring));
}

fn vg_phosphor(id: f32, depth: f32, inten: f32) -> vec3f {
  let pm = vg_phos();
  let hz = vg_hue();
  let L = 1.8;
  if (pm == 0) { return palL(hz, L) * inten; }
  if (pm == 1) { return mix(palL(hz + 0.1, L), vec3f(L), sat(inten * 0.6)) * inten; }
  if (pm == 2) { return palL(hz + depth * 0.5, L) * inten; }
  return palL(hz + id * 0.33, L) * inten;
}

// ---------- Lissajous / spirograph beam traces ----------
fn vg_curve(t: f32, k: f32) -> vec3f {
  let m = vg_morph();
  let sub = S.p[4].w;
  if (sub < 0.5) {
    let a = 2.0 + floor(m * 3.0);
    let b = 3.0 + floor(fract(m * 3.7) * 3.0);
    let c = a + 1.0 + floor(fract(m * 5.3) * 2.0);
    let ph = F.spin * 0.05 + k * 0.7;
    return vec3f(sin(a * t + ph), sin(b * t), sin(c * t + ph * 1.3)) * 1.75;
  }
  let R = 1.0;
  let r = 0.27 + 0.1 * floor(m * 4.0) * 0.5;
  let d = 0.55 + 0.2 * F.evolve.y;
  let q = (R - r) / r;
  let x = (R - r) * cos(t) + d * cos(q * t + k);
  let y = (R - r) * sin(t) - d * sin(q * t + k);
  return vec3f(x, y, sin(t * 3.0 + F.spin * 0.1 + k) * 0.5) * 1.9;
}

fn vg_traces(ro: vec3f, rd: vec3f, pxA: f32, ortho: bool) -> vec3f {
  var col = vec3f(0.0);
  let nc = min(1 + vg_mult(), select(3, 2, S.p[4].w >= 0.5));
  let ns = select(70, 110, S.p[4].w >= 0.5) + i32(vg_dens() * 60.0);
  let sub = S.p[4].w;
  let turns = select(TAU, TAU * 4.0, sub >= 0.5);
  // Bounding sphere test.
  let bb = dot(ro, rd);
  if (dot(ro, ro) - bb * bb > 12.0 * vg_scale * vg_scale) { return col; }
  for (var k = 0; k < 3; k++) {
    if (k >= nc) { break; }
    let fk = f32(k);
    var pa = vg_rot * vg_curve(0.0, fk * 2.1) * vg_scale;
    let segL = turns / f32(ns);
    for (var i = 1; i <= 180; i++) {
      if (i > ns) { break; }
      let pb = vg_rot * vg_curve(f32(i) * segL, fk * 2.1) * vg_scale;
      let ba = pb - pa;
      let oa = ro - pa;
      let baba = dot(ba, ba);
      let bard = dot(ba, rd);
      let den = max(baba - bard * bard, 1e-7);
      let sp = sat((dot(ba, oa) - dot(rd, oa) * bard) / den);
      let tt = max(dot(pa + ba * sp - ro, rd), 0.0);
      let dv = ro + rd * tt - (pa + ba * sp);
      let dist = length(dv);
      let foot = select(tt * pxA, pxA, ortho);
      let w = 0.011 * vg_scale;
      if (dist > 0.3 * vg_scale) { pa = pb; continue; }
      let core = vg_line(dist, w, foot);
      let glow = exp(-dist / (0.05 * vg_scale)) * 0.04;
      if (core + glow > 0.002) {
        // Slower beam (shorter segment) burns brighter, like a real scope.
        let speed = sqrt(baba) / (segL * vg_scale);
        let bright = clamp(2.2 / (speed + 0.4), 0.5, 3.5);
        let depth = sat(dot(pa, -normalize(ro)) / (2.0 * vg_scale) * 0.5 + 0.5);
        let dash = vg_dash(f32(i) * 0.25);
        col += vg_phosphor(fk + f32(i) / f32(ns) * 0.3, depth, (core * dash + glow) * bright * (0.5 + 0.5 * depth));
      }
      pa = pb;
    }
  }
  return col;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  var q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let fam = vg_fam();
  let cm = vg_camMode();
  let antic = S.p[2].z;
  let drop = S.p[2].w;
  let gram = vg_grammar();
  let ev = F.evolve;
  // Glitch grammar: displace horizontal bands on snares.
  if (gram == 1) {
    let band = floor(uv.y * 40.0);
    let gl = step(0.8, hash12(vec2f(band, floor(F.time * 12.0)))) * (F.snare + 0.5 * F.hat + antic * 0.5);
    q.x += (hash12(vec2f(band, 3.0)) - 0.5) * 0.15 * gl;
  }
  // Object rotation and scale.
  var rphase = S.p[2].y * 0.25 * (1.0 + 2.0 * antic);
  if (gram == 2) { rphase = (S.p[4].z + smoothstep(0.0, 0.3, F.beatPhase)) * 0.4 + S.p[2].y * 0.05; }
  vg_rot = rotY(rphase + F.morph2.y * 0.6) * rotX(rphase * 0.61 + ev.y) * rotZ(rphase * 0.37 + F.morph2.z * 0.4);
  vg_scale = 1.0 * (1.0 + select(0.0, 0.12 * F.kick, gram == 0) + 0.35 * drop - 0.12 * antic);

  var ro: vec3f;
  var ta = vec3f(0.0);
  var fov = 1.6;
  var ortho = false;
  if (fam == 3) {
    let z = S.p[2].x * 1.6;
    ro = vec3f(sin(S.p[2].y * 0.07) * 1.0, 1.3 + 1.0 * ev.x + select(0.0, 2.5, cm == 2), z - 4.0);
    ta = vec3f(0.0, 0.3, z + 8.0 + 4.0 * ev.y);
    ortho = cm == 1;
    fov = select(1.5, 1.1, cm == 3);
  } else if (fam == 4) {
    let z = S.p[2].x * 2.0;
    let c = vg_tunC(z);
    ro = vec3f(c, z);
    let c2 = vg_tunC(z + 3.0);
    ta = vec3f(c2, z + 3.0);
    fov = select(1.2, 0.85, cm == 2 || cm == 1);
  } else {
    let mu = vg_mult();
    var dist = select(3.7, 9.5, mu == 1 && fam < 2);
    if (cm == 2) { dist *= 0.62; fov = 0.95; }
    let a = S.p[2].y * 0.1 + ev.z * 3.0;
    let el = 0.25 + 0.5 * (ev.w - 0.5);
    ro = vec3f(cos(a) * cos(el), sin(el), sin(a) * cos(el)) * dist;
    if ((mu == 2 && fam < 2) || cm == 3) {
      let cc = select(2.0, 3.0, fam == 1);
      ro = vec3f(cc + sin(S.p[2].y * 0.05) * 0.5, cc + cos(S.p[2].y * 0.04) * 0.4, S.p[2].x * 2.0 + 2.0);
      ta = ro + vec3f(sin(S.p[2].y * 0.09) * 0.4 + 0.6, 0.4 + 0.25 * sin(S.p[2].y * 0.05), 1.0);
      if (mu != 2) { ro = vec3f(0.0, 0.3, -2.2 - 3.5 * (0.5 + 0.5 * sin(S.p[2].x * 0.15))); ta = vec3f(0.0); }
    }
    ortho = cm == 1 && mu != 2;
  }
  let cam = lookAt(ro, ta, select(0.0, sin(S.p[2].y * 0.05) * 0.2, fam == 4));
  var rd: vec3f;
  var pxA: f32;
  var rorg = ro;
  fov *= 1.0 + 0.1 * antic;
  if (ortho) {
    let W = select(3.0, 6.5, vg_mult() == 1 && fam < 3) * select(1.0, 2.2, fam == 3);
    rorg = ro + cam * vec3f(q * W, 0.0) - cam[2] * 10.0;
    rd = cam[2];
    pxA = 2.0 * W / F.res.y;
  } else {
    rd = normalize(cam * vec3f(q, fov));
    pxA = 2.0 / (F.res.y * fov);
  }

  var col = vec3f(0.0);
  if (fam == 2) {
    col = vg_traces(rorg, rd, pxA, ortho);
  } else {
    // March, peeling up to three layers when hidden lines are shown.
    let layers = select(select(3, 2, vg_mult() == 2), 1, vg_hidden());
    var t = 0.01;
    var att = 1.0;
    let tmax = select(select(40.0, 26.0, vg_mult() == 2), 70.0, fam >= 3);
    var layer = 0;
    var inside = false;
    for (var i = 0; i < 140; i++) {
      let p = rorg + rd * t;
      var d = vg_map(p);
      if (inside) { d = -d; }
      if (d < 0.0006 * (t + 1.0)) {
        let n = vg_normal(p, 0.002 + 0.0005 * t);
        let foot = select(t * pxA, pxA, ortho) / max(abs(dot(n, rd)), 0.25);
        let ln = vg_surfLines(p, n, rd, foot);
        let depth = exp(-t * select(select(0.08, 0.09, vg_mult() == 2), 0.035, fam >= 3));
        // Silhouette rim: the beam traces outlines too.
        let rim = smoothstep(0.1, 0.02, abs(dot(n, rd))) * 0.5;
        let inten = max(ln.x, rim) * depth * att * (1.0 + 0.6 * F.chordPulse);
        col += vg_phosphor(ln.y, 1.0 - depth, inten * (1.0 + 1.2 * F.kick * select(0.0, 1.0, gram != 1) + 2.0 * drop));
        // Faint fill so solids read as occluders.
        if (vg_hidden()) {
          col += palL(vg_hue() + 0.5, 0.004) * (0.5 + 0.5 * n.y) * depth;
          break;
        }
        layer++;
        if (layer >= layers) { break; }
        att *= 0.55;
        inside = !inside;
        t += 0.02;
        continue;
      }
      t += max(d, 0.002);
      if (t > tmax) { break; }
    }
    // Beat pulse running down the tunnel / across the terrain.
    if (fam == 4) {
      col *= 1.0 + 1.5 * F.beatPulse * exp(-abs(fract(F.beatPhase) * 12.0 - t) * 0.6);
    }
  }
  // CRT: scanlines, vignette, a touch of flicker.
  let scan = 0.85 + 0.15 * sin(frag.y * 3.14159 * 0.5);
  let vig = 1.0 - 0.35 * dot(q, q) / (F.aspect * F.aspect + 1.0);
  col *= scan * vig * (0.97 + 0.03 * sin(F.time * 120.0));
  col *= 1.0 - 0.3 * antic;
  col = mix(col, vec3f(luma(col)), 0.5 * antic);
  col += vg_phosphor(0.0, 0.5, 0.12) * drop * drop * exp(-dot(q, q));
  return vec4f(col, 1.0);
}
`,
});
