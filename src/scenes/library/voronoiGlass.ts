import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Voronoi Glass: an endless dive into a wall of deep, saturated stained glass. The wall is three
 * octaves of cells at scales a factor of two apart (each octave with its own seeds and rotation), and a
 * zoom level that grows with the travel (rushing on drops) slides them all larger: a finer cell network
 * etches into the glass while the coarsest leads fade away, so the dive keeps finding new cells inside
 * the cells. The glass colour blends the octaves' cell hues by weight, so each coarse cell splits into
 * finer shards of its own shades. Most glass is dark tinted glass. Three soft backlights move across the
 * wall, and only the cells and lead lines they pass behind light up, so real black stays between them.
 *
 * Each cell is shaded from its exact edge distance (the bevel's normal comes from the edge's own
 * normal), so the rims go dark and small glints catch the light. The morph sets the cell count, the
 * jitter, the stretch of the lattice (from round to shard-like), the rim width, the lead width and the
 * rotation. The high end orbits the cells' feature points and turns their hues, most in the finest octave.
 *
 * Fronts run cell to cell. Each cell's arrival time is its distance from the ignition point plus a
 * per-cell random lag, so the fire spreads raggedly, and a burned cell keeps its new colour. Nothing
 * snaps: each cell eases into its new state from rest on a critically damped curve (settled in about
 * 0.4 s), every glow rises from rest and cools within about 0.3 s, and the two previous kicks and the previous note
 * fronts are kept so their changes always finish:
 *  - kick: fire lit at an angle on the wall; the cells it passes glow up, the lead lines burn white to
 *    orange, and the cell takes the next colour for good;
 *  - snare: a fast cool crackle from the top or bottom edge along the lead lines, and the leads
 *    glide to new widths over about half a second;
 *  - melody: a glow of the note's colour from the side, at the height of its pitch; the melody cells
 *    glide to the note's colour on a critically damped spring, and the wall slides a little.
 *
 * DNA: 0 seed, 1 drift direction, 2 melody hue, 3 palette offset, 4 kick angle, 5 snare side,
 * 6 light side, 7 scale.
 */

const morph = new Morph(0.5);
const aspect = 16 / 9;
const st = {
  seed: -1, kicks: 0, snares: 0, notes: 0, noteNew: 0.5, hue: 0.5, hueV: 0, pitch: 0, pitchPrev: 0,
  kAge: 9, kPrev: 9, kPrev2: 9, kLpp: 0, sPh: 0, sPhV: 0, z: 0, zr: 0, zrV: 0, tr: -1, lAge: 9, lPrev: 9, drive: 0, driveV: 0, surge: 0, surgeV: 0,
  // Event strengths (0..1), captured as each lands: the latest and previous kick and note, the latest
  // snare. The lasting kick colour and snare lead phases sum the strengths already folded in.
  kL: 0, kLp: 0, kBase: 0, sL: 0, sBase: 0, lL: 0, lLp: 0,
  // Each note slides the panes a little (a spring toward a target that steps with the notes).
  nx: 0, nxV: 0, nxT: 0, ny: 0, nyV: 0, nyT: 0,
};

/** The fine detail phase, glided (value, velocity), and its raw input last frame. */
const detailSm = { x: 0, v: 0, t: 0, raw: 0, a: 0.15, av: 0 };
/**
 * How strongly an event lands: its level (0..1) through a soft curve that rises at twice the
 * level's slope from zero and eases into 1, times the music's presence right now (the morph's drive,
 * loudness and bass, through a smooth S-curve that starts at 0 and reaches 1 at full drive: about 0.9 in a full mix, about 0.1 at a near-silent gap). A hit in near silence barely stirs the world, a hard hit
 * in a full mix lands fully, and there is no threshold anywhere in between.
 */
const presence = () => {
  const x4 = Math.max(0, morph.drive) ** 4;
  return (x4 * (1 + 0.55 ** 4)) / (x4 + 0.55 ** 4);
};
const strength = (lv: number) => lv * (2 - lv) * presence();
/**
 * The morph coordinates with its beat steps weighted by the music's presence: each frame's step
 * increment (already eased and scaled by the hit's level) counts by how present the music is right
 * now, so a hit in a near-silent gap barely moves the form. A cue reset (the steps jump back) resets them.
 */
const stepSm = { prev: new Float64Array(8), own: new Float64Array(8), out: new Float64Array(8) };
function presentAt(): Float64Array {
  const pr = presence();
  for (let i = 0; i < 8; i++) {
    const s = morph.at[i] - morph.flowAt[i];
    const d = s - stepSm.prev[i];
    stepSm.prev[i] = s;
    if (Math.abs(d) > 0.5) stepSm.own[i] = 0;
    else stepSm.own[i] += d * pr;
    stepSm.out[i] = 0.5 * morph.flowAt[i] + stepSm.own[i];
  }
  return stepSm.out;
}

/** One step of a critically damped spring toward `target`: starts from rest, never overshoots. */
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}

const SHADER = /* wgsl */ `
struct VgCell { d: f32, id: vec2f, rel: vec2f, nd: vec2f, ds: f32, ns: vec2f };

fn vg_h2(id: vec2f, sd: f32) -> vec2f {
  return vec2f(hash12(id + vec2f(sd, 0.0)), hash12(id + vec2f(0.0, sd + 17.0)));
}

// Feature point of a cell: jittered from the cell centre, and orbiting it by oa (the high end's fine
// detail, RULES v7): each cell's point circles at its own phase, turned by the high notes, so the
// facets re-cut at the fine scale.
fn vg_point(id: vec2f, jit: f32, sd: f32, oa: f32) -> vec2f {
  let h = vg_h2(id, sd);
  let ph = fract(S.p[7].w) / 0.98 * TAU;
  let orb = oa * vec2f(cos(ph + TAU * h.x), sin(2.0 * ph + TAU * h.y));
  return vec2f(0.5) + clamp((h - 0.5) * jit + orb, vec2f(-0.42), vec2f(0.42));
}

// Exact Voronoi: nearest feature (rel = its offset from the pixel, id = its cell), and the distance to
// the nearest cell edge (d) with that edge's outward normal (nd, pointing from the pixel to the edge).
// The glass is shaded from a smooth edge distance instead (ds, a soft minimum over all the cell's edges,
// with its gradient ns): the exact one has a crease along the cell's skeleton where the nearest edge
// changes, and a bevel shaded from it shows thin straight lines across the pane.
fn vg_cell(q: vec2f, jit: f32, sd: f32, oa: f32) -> VgCell {
  let n = floor(q);
  let f = q - n;
  var md = 8.0;
  var mr = vec2f(0.0);
  var mg = vec2f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let r = g + vg_point(n + g, jit, sd, oa) - f;
      let dd = dot(r, r);
      if (dd < md) { md = dd; mr = r; mg = g; }
    }
  }
  var de = 8.0;
  var nd = vec2f(1.0, 0.0);
  var sw = 0.0;
  var sn = vec2f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let r = g + vg_point(n + g, jit, sd, oa) - f;
      let dr = r - mr;
      let l2 = dot(dr, dr);
      if (l2 > 1e-6) {
        let u = dr / sqrt(l2);
        let e = dot(0.5 * (mr + r), u);
        if (e < de) { de = e; nd = u; }
        let wsm = exp(-14.0 * max(e, 0.0));
        sw += wsm;
        sn += wsm * u;
      }
    }
  }
  let ds = -log(max(sw, 1e-6)) / 14.0;
  let ns = sn / max(length(sn), 1e-4);
  return VgCell(de, n + mg, mr, nd, max(ds, 0.0), ns);
}

// A critically damped ease from rest, b seconds after a front arrives: no jump in value or speed, 90%
// there by 0.2 s and settled by about 0.3 s.
fn vg_ease(b: f32) -> f32 { let u = max(b, 0.0) / 0.09; return 1.0 - (1.0 + u) * exp(-u); }
// A slower ease for the snare's re-cut, which moves every lead at once: settled in about 0.7 s.
// A glow that swells in from rest over r seconds after the front arrives (eased, so its brightening
// is spread over several frames instead of landing in the first), then cools at time constant k.
fn vg_pulse(b: f32, r: f32, k: f32) -> f32 { return smoothstep(0.0, r, b) * exp(-max(b - r, 0.0) / k); }
// An event's age (s) and its strength (0..1), packed as ms in the integer part and strength in the fraction.
fn vg_age(v: f32) -> f32 { return floor(v) / 1000.0; }
fn vg_lv(v: f32) -> f32 { return sat(fract(v) / 0.98); }

// Fire by heat (1 = just lit): a pale gold core, yellow, orange (the came glows, never flat white).
fn vg_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.25, 0.05) * h * 1.4 + vec3f(1.0, 0.62, 0.2) * h * h * 2.2 + vec3f(1.0, 0.85, 0.6) * pow(h, 5.0) * 0.8;
}

// Full-chroma palette colour: pal(t) with its chroma pushed to the maximum (brightest channel at 1, no
// white). A fifth of a spectral wheel keeps the hue count up if a palette is pale or grey.
fn vg_chroma(t: f32) -> vec3f {
  let c = pal(t);
  let mn = min(c.r, min(c.g, c.b));
  let mx = max(c.r, max(c.g, c.b));
  let pc = (c - vec3f(mn)) / max(mx - mn, 1e-3);
  return mix(pc, hsv2rgb(vec3f(fract(t), 1.0, 1.0)), 0.2);
}

// The zoom: level z (octaves, growing with the travel) and its slowly drifting centre, derived from z.
fn vg_z() -> f32 { return S.p[0].y; }
fn vg_centre(z: f32) -> vec2f {
  let sd = S.p[2].w * 0.01;
  return vec2f(0.32 * sin(z * 0.37 + sd * 6.0) * F.aspect, 0.22 * cos(z * 0.29 + sd * 4.0));
}

// What one zoom octave of the glass gives a pixel. Every property is a function of the octave's scale s
// and its stable id only (never its slot), so nothing pops when the zoom wraps.
struct VgOct {
  hue: f32,
  lit: f32,
  lc: vec3f,
  mel: f32,
  inner: f32,     // 0 at the lead, 1 inside the pane (smooth)
  thick: f32,     // glass thickness (deepens the colour)
  slope: vec2f,   // the glass surface's slope (refraction and sheen)
  ev: vec4f,
  hot: f32,
  cov: f32,
  lead: vec3f,
  fq: f32,        // cells per pixel at this octave (for band-limiting)
};

fn vg_oct(p: vec2f, z: f32, i: i32, cz: vec2f) -> VgOct {
  let s = zoomScale(z, i);
  let ls = log2(s);
  let oid = zoomOctaveId(z, i);
  let k = S.p[0].x * 0.45;
  let A = S.p[1].x;
  let rot = S.p[1].y + 0.9 * oid;
  let bw = S.p[1].z;
  let lwB = S.p[1].w * pow(s / 1.4, 0.6);
  let drift = S.p[2].xy;
  let hue0 = S.p[2].z;
  let sd0 = S.p[2].w;
  let sd = sd0 + 13.7 * oid;
  let po = cz + (p - cz) * s;
  let q = rot2(rot) * ((po + drift) * k * vec2f(1.0, A));
  // Fine detail orbit (RULES v7): deepest in the finest octave, so the high end re-forms the small cells.
  let vc = vg_cell(q, S.p[0].w, sd, floor(S.p[7].w) / 1000.0 * (0.06 + 0.04 * (ls + 1.0)));
  let d = vc.d;
  let fw = max(fwidth(d), 1e-4);
  let fq = length(fwidth(q));

  // The cell centre on the screen.
  let sc = rot2(-rot) * (vc.id + vec2f(0.5)) / vec2f(1.0, A);
  let spos = cz + (sc / k - drift - cz) / s;
  let lagH = hash12(vc.id + vec2f(sd + 5.0, 1.0));

  let R = 0.27;
  let d1 = spos - S.p[5].xy;
  let d2 = spos - S.p[5].zw;
  let d3 = spos - S.p[6].xy;
  let g1 = exp(-dot(d1, d1) / (R * R));
  let g2 = exp(-dot(d2, d2) / (R * R));
  let g3 = exp(-dot(d3, d3) / (R * R));
  let gs = g1 + g2 + g3;
  let lit = smoothstep(0.4, 1.0, gs) * (0.5 + 0.7 * S.p[3].w);
  let lc = (g1 * vg_chroma(hue0) + g2 * vg_chroma(hue0 + 0.33) + g3 * vg_chroma(hue0 + 0.66)) / max(gs, 1e-3);

  let kN = floor(S.p[4].x);
  let sN = floor(S.p[4].y);
  let kBase = fract(S.p[4].x) / 0.98 * 100.0;
  let sBase = fract(S.p[4].y) / 0.98 * 3.0;
  let lK = vg_lv(S.p[3].x);
  let lKp = vg_lv(S.p[7].y);
  let lS = vg_lv(S.p[3].y);
  let lN = vg_lv(S.p[3].z);
  let lNp = vg_lv(S.p[7].z);
  let nN = S.p[4].z;
  let ka = sd0 + 2.4 * kN;
  let kI = vec2f(cos(ka) * 0.6 * F.aspect, sin(ka) * 0.6);
  let kap = sd0 + 2.4 * (kN - 1.0);
  let kIp = vec2f(cos(kap) * 0.6 * F.aspect, sin(kap) * 0.6);
  let pitchPrev = fract(S.p[6].z) / 0.98 * 6.0 - 3.0;
  let nIp = vec2f(select(-1.0, 1.0, fmod(nN - 1.0, 2.0) >= 1.0) * F.aspect * 0.6, pitchPrev * 0.85);
  let sI = vec2f(sin(sN * 2.7 + sd0 * 0.06) * 0.8 * F.aspect, select(1.0, -1.0, fmod(sN, 2.0) >= 1.0));
  let nI = vec2f(select(-1.0, 1.0, fmod(nN, 2.0) >= 1.0) * F.aspect * 0.6, (floor(S.p[6].z) / 1000.0 - 3.0) * 0.85);
  // Finer cells catch each front a little later, so it burns down through the scales.
  let lz = 0.015 * (ls + 1.0);
  let bK = vg_age(S.p[3].x) - (length(spos - kI) / 18.0 + 0.05 * lagH + lz);
  let bKp = vg_age(S.p[7].y) - (length(spos - kIp) / 18.0 + 0.05 * lagH + lz);
  let kapp = sd0 + 2.4 * (kN - 2.0);
  let kIpp = vec2f(cos(kapp) * 0.6 * F.aspect, sin(kapp) * 0.6);
  let lKpp = vg_lv(S.p[0].z);
  let bKpp = vg_age(S.p[0].z) - (length(spos - kIpp) / 18.0 + 0.05 * lagH + lz);
  let bS = vg_age(S.p[3].y) - (length(spos - sI) / 22.0 + 0.03 * lagH + lz);
  let bL = vg_age(S.p[3].z) - (length(spos - nI) / 14.0 + 0.06 * lagH + lz);
  let bLp = vg_age(S.p[7].z) - (length(spos - nIp) / 14.0 + 0.06 * lagH + lz);
  let hotK = vg_pulse(bK, 0.1, 0.09) * lK + vg_pulse(bKp, 0.1, 0.09) * lKp + vg_pulse(bKpp, 0.1, 0.09) * lKpp;
  let flashK = vg_pulse(bK, 0.1, 0.11) * lK + vg_pulse(bKp, 0.1, 0.11) * lKp + vg_pulse(bKpp, 0.1, 0.11) * lKpp;
  let crackS = 0.7 * smoothstep(0.0, 0.15, bS) * exp(-max(bS - 0.12, 0.0) / 0.14) * lS;
  let glowN = vg_pulse(bL, 0.16, 0.16) * lN + vg_pulse(bLp, 0.16, 0.16) * lNp;
  let headL = vg_pulse(bL, 0.13, 0.1) * lN + vg_pulse(bLp, 0.13, 0.1) * lNp;

  let hc = hash12(vc.id + vec2f(sd * 1.3, 3.0));
  let hState = kBase + vg_ease(bKpp) * lKpp + vg_ease(bKp) * lKp + vg_ease(bK) * lK;
  // The high end also turns the fine cells' hues, each at its own phase, most in the finest octave.
  let dph = fract(S.p[7].w) / 0.98 * TAU;
  let hue = 1.4 * hc + 0.23 * hState + 0.1 * (ls + 2.0) * sin(dph + TAU * fract(hc * 7.3));
  let mel = step(0.5, fract(hc * 2.9 + 0.3));
  let wr = 1.0 + floor(3.0 * hash12(vc.id + vec2f(sd, 11.0)));
  let wph = TAU * hash12(vc.id + vec2f(sd, 9.0));
  let lw = lwB * (0.45 + 0.9 * pow(0.5 + 0.5 * sin(wph + wr * (TAU / 3.0) * sBase), 2.0));

  // The glass: thicker toward the came (a soft bevel on the smooth edge distance), each pane its own
  // base thickness, and one slow ripple across it (hand-rolled glass), its direction and phase per cell.
  let t = clamp(vc.ds / bw, 0.0, 1.0);
  let inner = t * t * (3.0 - 2.0 * t);
  let hT = hash12(vc.id + vec2f(sd, 23.0));
  let ra = TAU * hash12(vc.id + vec2f(sd, 29.0));
  let rdir = vec2f(cos(ra), sin(ra));
  // The high end's detail phase rolls the ripple (most in the finest octave), so a high note re-forms
  // how each pane bends the light, and it stays that way.
  let dphR = fract(S.p[7].w) / 0.98 * TAU;
  let rph = dot(vc.rel, rdir) * 3.2 + TAU * hT + (1.0 + 0.5 * (ls + 1.0)) * dphR;
  let thick = 0.55 + 0.7 * hT + 0.35 * sin(rph) + 0.55 * (1.0 - inner);
  // Slope of the surface (in cell units): the ripple's, and the bevel's rising toward the edge.
  let slope = 0.35 * 3.2 * cos(rph) * rdir + 0.55 * 6.0 * t * (1.0 - t) / bw * vc.ns;

  // The lead came: a rounded strip along the edge; its bevel catches a soft light from the upper left.
  let cov = 1.0 - smoothstep(lw - fw, lw + fw, d);
  let x = clamp(d / max(lw, 1e-4), 0.0, 1.0);
  let Nl = vec3f(-vc.nd * x, sqrt(max(1.0 - x * x, 0.0)) + 0.35);
  let Hl = normalize(vec3f(-0.45, 0.55, 1.0));
  let bev = pow(max(dot(normalize(Nl), Hl), 0.0), 12.0);
  let lead = vec3f(0.045, 0.043, 0.05) * (0.6 + 0.8 * x) + vec3f(0.55, 0.5, 0.45) * bev * (0.18 + 0.25 * lit) + lc * lit * 0.05;
  return VgOct(hue, lit, lc, mel, inner, thick, slope, vec4f(flashK, glowN, headL, crackS), hotK, cov, lead, fq);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let p = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let z = vg_z();
  let cz = vg_centre(z);
  // One pass per octave, finest first, folding each into running sums so little stays live.
  // Body fields blend by weight (normalised at the end): every cell of every octave tints the glass,
  // coarse cells subdivided by finer ones, each its own shade. The leads composite finest first,
  // coarsest on top, each anti-aliased at its own scale.
  var ws = 0.0;
  var hueS = 0.0;
  var melS = 0.0;
  var litS = 0.0;
  var lcS = vec3f(0.0);
  var evS = vec4f(0.0);
  var hotS = 0.0;
  var thS = 0.0;
  var slS = vec2f(0.0);
  var inner = 1.0;
  var leadC = vec3f(0.0);
  var leadA = 0.0;
  for (var i = 2; i >= 0; i--) {
    let o = vg_oct(p, z, i, cz);
    let wz = zoomWeight(z, i);
    // Band-limit: an octave whose cells shrink below a few pixels fades out (on a small screen)
    // instead of shimmering. It depends on the scale only, so it is continuous across the zoom wrap.
    let aa = smoothstep(0.45, 0.15, o.fq);
    let wa = wz * aa;
    // Edge visibility: an octave's leads and rims etch in as its weight rises (0 at entry and exit).
    let we = smoothstep(0.0, 0.45, wz) * aa;
    ws += wa;
    hueS += wa * o.hue;
    melS += wa * o.mel;
    litS += wa * o.lit;
    lcS += wa * o.lc;
    evS += wa * o.ev;
    hotS += wa * o.hot;
    thS += wa * o.thick;
    slS += wa * o.slope;
    inner *= mix(1.0, o.inner, we);
    let a = o.cov * we * 0.92;
    leadC = leadC * (1.0 - a) + o.lead * a;
    leadA = leadA * (1.0 - a) + a;
  }
  let iw = 1.0 / max(ws, 1e-4);
  let mel = melS * iw;
  let hue = mix(S.p[2].z + hueS * iw, S.p[7].x, 0.7 * mel);
  let lit = litS * iw;
  let lc = lcS * iw;
  let ev = evS * iw;
  let surge = S.p[4].w;
  let drive = S.p[3].w;

  let thick = thS * iw;
  let slope = slS * iw;

  // Light through glass. The colour is the pane's hue through its thickness (Beer's law: thicker glass
  // is deeper and more saturated, never grey). Behind the wall is a soft field of light: a dim even
  // glow everywhere plus the three moving backlights. Each pane bends it by its slope (the ripple and
  // the bevel), so a light seen through the panes breaks into shifted, curved patches.
  let cc = vg_chroma(hue);
  let tint = pow(mix(cc, vec3f(1.0), 0.06), vec3f(0.6 + 0.9 * thick)) * exp(-0.5 * thick);
  let pr = p + 0.05 * slope;
  let R2 = 0.6 * 0.6;
  // The light's bright core, seen through the glass: bent further by the slope, so each pane shows
  // its own shifted, curved piece of it.
  let pc = p + 0.11 * slope;
  let C2 = 0.16 * 0.16;
  let f1 = pc - S.p[5].xy;
  let f2 = pc - S.p[5].zw;
  let f3 = pc - S.p[6].xy;
  let core = exp(-dot(f1, f1) / C2) + exp(-dot(f2, f2) / C2) + exp(-dot(f3, f3) / C2);
  let e1 = pr - S.p[5].xy;
  let e2 = pr - S.p[5].zw;
  let e3 = pr - S.p[6].xy;
  let b1 = exp(-dot(e1, e1) / R2);
  let b2 = exp(-dot(e2, e2) / R2);
  let b3 = exp(-dot(e3, e3) / R2);
  let warm = vec3f(1.0, 0.94, 0.84);
  let back = warm * (0.03 + 0.05 * drive + 1.1 * core)
    + (b1 * mix(warm, vg_chroma(S.p[2].z), 0.3) + b2 * mix(warm, vg_chroma(S.p[2].z + 0.33), 0.3) + b3 * mix(warm, vg_chroma(S.p[2].z + 0.66), 0.3)) * (1.1 + 0.6 * drive);
  // The pane glows from within (light scattered in the glass, brightest away from the came), and a
  // pane a backlight sits behind fills with its light.
  let glowIn = 0.12 + 0.88 * inner * sqrt(inner);
  let cl = 0.12 * ev.x + 0.45 * ev.y * mel + 0.45 * ev.z * mel + 0.2 * ev.w;
  var c = tint * back * glowIn * 1.5 + tint * mix(cc, lc, 0.3) * (0.55 * lit + 0.9 * cl) * (0.5 + 0.5 * inner);
  // A faint front sheen on the glass surface, from its smooth slope (no creases, so no lines).
  let Ng = normalize(vec3f(-0.12 * slope, 1.0));
  let sheen = pow(max(dot(Ng, normalize(vec3f(-0.3, 0.4, 1.0))), 0.0), 60.0);
  c += vec3f(0.9, 0.92, 1.0) * sheen * 0.06;

  let fire = vg_fire(clamp(hotS * iw, 0.0, 1.0)) * (1.0 + 0.5 * surge) * 0.35;
  let ice = vec3f(0.3, 0.8, 1.0) * ev.w * 1.0;
  // In the gliding melody colour: the previous note's glow, still burning, eases to the new colour rather
  // than switching to it in one frame.
  let noteG = vg_chroma(S.p[7].x) * ev.y * 1.1 * (1.0 + surge) * (0.5 + 0.5 * drive);
  // The melody's glow belongs to the glass; the came only catches a little of it.
  let hot = fire + ice + 0.3 * noteG + lc * ev.x * 0.2;
  // Events burn along the came (kept below white, so the came reads as metal between bursts).
  c = c * (1.0 - leadA) + leadC + hot * leadA * 0.85;
  c += noteG * 1.3 * (1.0 - leadA) * mel * (0.4 + 0.6 * inner);

  c *= 1.0 - 0.25 * dot(uv - 0.5, uv - 0.5);
  // A soft shoulder that keeps the hue: the brightest channel rolls off toward 1, the others scale
  // with it, so a hot pane stays its colour instead of clipping to flat white.
  let pk = max(c.r, max(c.g, c.b));
  c *= (1.0 - exp(-pk)) / max(pk, 1e-4);
  return vec4f(c, 1.0);
}
`;

export default raymarchScene({
  meta: {
    id: 'voronoi-glass',
    name: 'Voronoi Glass',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.5 },
    genres: { ambient: 0.8, edm: 0.7, pop: 0.8, synthwave: 0.8, lofi: 0.7, classical: 0.6, hiphop: 0.6, dubstep: 0.6, dnb: 0.6, rock: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = presentAt();

    if (g[0] !== st.seed || morph.kicks < st.kicks || morph.snares < st.snares || morph.notes < st.notes) {
      st.seed = g[0];
      st.kicks = morph.kicks;
      st.snares = morph.snares;
      st.notes = morph.notes;
      st.noteNew = st.hue = 0.5 + g[2];
      st.hueV = 0;
      st.pitch = st.pitchPrev = morph.notePitch;
      st.kAge = st.kPrev = st.kPrev2 = st.lAge = st.lPrev = 9;
      st.kLpp = st.sPh = st.sPhV = st.zr = st.zrV = 0;
      st.z = morph.travel * 0.45 + g[7] * 8;
      st.tr = morph.travel;
      st.drive = morph.drive;
      st.surge = morph.surge;
      st.driveV = st.surgeV = 0;
      st.nx = st.nxV = st.nxT = st.ny = st.nyV = st.nyT = 0;
      st.kL = st.kLp = st.kBase = st.sL = st.sBase = st.lL = st.lLp = 0;
    }
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    // Melody: each note is a new colour (a step round the palette), shaded by its pitch and the centroid.
    if (morph.notes !== st.notes) {
      st.notes = morph.notes;
      // The note's strength sets how far the colour turns toward it (the short way), how far the panes
      // slide and how bright its glow burns. Squared (the level already carries the passage's
      // loudness), so a faint motif in a quiet intro is a faint glow, a lead in a drop a full one.
      const l = morph.noteLevel ** 2;
      const full = g[2] + 0.5 + morph.notes * 0.29 + morph.notePitch * 0.25 + (m.centroid - 0.5) * 0.2;
      st.noteNew += l * (full - st.noteNew - Math.round(full - st.noteNew));
      st.pitchPrev = st.pitch;
      st.pitch = morph.notePitch;
      st.lPrev = st.lAge + dt;
      st.lLp = st.lL;
      st.lL = l;
      st.nxT += l * 0.02 * Math.cos(st.pitch * 2.6 + morph.notes * 1.7);
      st.nyT += l * 0.02 * Math.sin(st.pitch * 2.6 + morph.notes * 1.7);
    } else st.lPrev = Math.min(9, st.lPrev + dt);
    st.lAge = morph.leadAge;
    // The two previous kicks' ages: their fronts are still drawn, so their changes always finish, even in a fast fill.
    if (morph.kicks !== st.kicks) {
      st.kPrev2 = st.kPrev + dt;
      st.kPrev = st.kAge + dt;
      // The kick three back has finished: fold its strength into the lasting colour.
      st.kBase = (st.kBase + st.kLpp) % 100;
      st.kLpp = st.kLp;
      st.kLp = st.kL;
      st.kL = strength(morph.kickLevel);
    } else {
      st.kPrev = Math.min(9, st.kPrev + dt);
      st.kPrev2 = Math.min(9, st.kPrev2 + dt);
    }
    st.kAge = morph.kickAge;
    st.kicks = morph.kicks;
    if (morph.snares !== st.snares) {
      st.sL = strength(morph.snareLevel);
      st.sBase += st.sL;
    }
    // The snare re-cuts the leads by gliding their width phase (settled in about half a second), so a
    // fast fill of snares never cuts one re-cut short.
    [st.sPh, st.sPhV] = spring(st.sPh, st.sPhV, st.sBase, 10, dt);
    st.snares = morph.snares;
    // The melody cells glide to the note's colour from rest (settled in about 0.3 s); the backlights'
    // drive and the drop's surge glide too, so the light never jumps.
    [st.hue, st.hueV] = spring(st.hue, st.hueV, st.noteNew, 7, dt);
    [st.nx, st.nxV] = spring(st.nx, st.nxV, st.nxT, 6, dt);
    [st.ny, st.nyV] = spring(st.ny, st.nyV, st.nyT, 6, dt);
    [st.drive, st.driveV] = spring(st.drive, st.driveV, morph.drive, 8, dt);
    [st.surge, st.surgeV] = spring(st.surge, st.surgeV, morph.surge, 4, dt);

    const tr = morph.travel;
    // The zoom level (octaves) runs at the travel's pace, its rate glided over about half a second so
    // the dive speeds up into a drop (or as the music comes back) without a jolt.
    const dTr = tr - st.tr;
    st.tr = tr;
    if (dt > 0 && dTr >= 0 && dTr < 0.5) {
      [st.zr, st.zrV] = spring(st.zr, st.zrV, dTr / dt, 5, dt);
      st.z += Math.max(0, st.zr) * 0.45 * dt;
    }
    const dir = g[1] * 6.283;
    const put = (i: number, v: number[]) => p.set(v, i * 4);

    const ev = (age: number, l: number) => Math.floor(Math.min(age, 9) * 1000) + 0.98 * l;
    // Shape: each value sweeps a wide range, so every phrase carries the wall somewhere new. Cell count,
    // the zoom level (octaves: grows with the travel, so the wall dives into new cells and rushes on
    // drops), the third kick back, jitter; stretch (exp of a wide range: round to shard-like),
    // rotation, rim width and lead width.
    put(0, [wave(a[0], 3.5, 9), st.z, ev(st.kPrev2, st.kLpp), wave(a[1], 0.3, 1.0)]);
    put(1, [Math.exp(wave(a[2], -0.9, 0.9)), wave(a[5], -0.5, 0.5), wave(a[3], 0.15, 0.4), wave(a[6], 0.02, 0.06)]);
    // Drift: the panes slide with the travel at their own rates (parallax); the seed and palette offset.
    put(2, [Math.cos(dir) * tr * 0.06 + st.nx, Math.sin(dir) * tr * 0.06 + st.ny, g[3] + 0.05 * Math.sin(a[2] * 0.5), g[0] * 97.3]);
    // Ages (ms in the integer part) with the event's strength packed in the fraction; the counts with
    // the lasting kick colour and snare lead phase packed in theirs.
    put(3, [ev(morph.kickAge, st.kL), ev(morph.snareAge, st.sL), ev(morph.leadAge, st.lL), st.drive]);
    put(4, [morph.kicks + 0.98 * (st.kBase / 100), morph.snares + 0.98 * ((((st.sPh % 3) + 3) % 3) / 3), morph.notes, st.surge]);
    // Three moving backlights, paced by the travel and phased by the morph (so a phrase moves them).
    const light = (i: number) => [
      aspect * 0.75 * Math.sin(tr * 0.2 * (1 + 0.3 * i) + a[2] * 0.5 + i * 2.2 + g[5] * 6.283),
      0.65 * Math.sin(tr * 0.15 * (1.2 - 0.2 * i) + a[3] * 0.4 + i * 1.4 + g[6] * 6.283),
    ];
    const l0 = light(0);
    const l1 = light(1);
    const l2 = light(2);
    put(5, [l0[0], l0[1], l1[0], l1[1]]);
    // Light 3, the note's pitch and colour; the gliding melody hue, the previous kick's and note's ages
    // and the previous note's pitch.
    // The note's pitch (thousandths, offset by 3) with the previous note's pitch in the fraction.
    const pc = (x: number) => Math.max(-2.9, Math.min(2.9, x)) + 3;
    put(6, [l2[0], l2[1], Math.round(pc(st.pitch) * 1000) + (0.98 * pc(st.pitchPrev)) / 6, st.noteNew]);
    // Fine detail (RULES v7): depth from the detail drive (thousandths), phase (turns, in the fraction)
    // flowing with the detail coordinates and stepping with each high note, backing chord and hat.
    // High notes carry the change (a turn of up to 3.5 radians each, by strength); the detail
    // coordinates, backing and hats only drift it slowly. Glided on a critically damped spring (its
    // quickest about 0.15 s after a note, settled in about 0.7 s), so a note re-forms the detail smoothly.
    const dT = 0.3 * morph.detailAt[0] + 0.2 * morph.detailAt[1] + 3.5 * morph.upperPhase + 0.9 * morph.backingPhase + 0.15 * morph.hatPhase;
    // Its changes count by the music's presence too (a jump means a new cue: start there).
    const dInc = dT - detailSm.raw;
    detailSm.raw = dT;
    if (Math.abs(dInc) > 20) [detailSm.x, detailSm.v, detailSm.t] = [dT, 0, dT];
    else detailSm.t += dInc * presence();
    [detailSm.x, detailSm.v] = spring(detailSm.x, detailSm.v, detailSm.t, 7, dt);
    // The detail depth follows the detail drive, weighted by the presence, gliding in over about a second.
    [detailSm.a, detailSm.av] = spring(detailSm.a, detailSm.av, 0.15 + 0.85 * morph.detailDrive * presence(), 3.5, dt);
    const dPh = detailSm.x;
    const detail = Math.round(Math.min(1, Math.max(0, detailSm.a)) * 1000) + 0.98 * (dPh / 6.283185 - Math.floor(dPh / 6.283185));
    put(7, [st.hue, ev(st.kPrev, st.kLp), ev(st.lPrev, st.lLp), detail]);
  },
  wgsl: SHADER,
});
