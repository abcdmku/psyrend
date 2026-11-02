import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Wallpaper Flow: a domain-warped glossy field (marble bands) symmetrised into one of the 17 wallpaper
 * groups, seen on a receding plane.
 *
 * Symmetry: the groups are listed by generators in lattice coordinates (u, v) and closed in TypeScript
 * (translations mod 1, exact in sixths). The field is the orbit sum over the group's coset
 * representatives, F(x) = sum over g of tile(g x) / sqrt(N). Because the sum runs over the whole group
 * mod the lattice, F(h x) = F(x) for every element h, exactly, and F is smooth everywhere: there are no
 * fold seams to hide, and mirror lines carry the bands straight through. Each lattice type gets its own
 * metric (oblique, rectangular or centred, square, hexagonal) so the lattice drawn on the plane really
 * is symmetric under its group. Phrases switch group, scale and angle; the old and new fields are
 * cross-faded over the first bar.
 *
 * Infinite zoom (RULES v8): the field is drawn at three octave scales nested about a slowly drifting
 * centre, each octave with its own motif (seeded by its stable octave id), composited coarse over fine.
 * The zoom level grows with the morph's travel, so a new, finer tiling keeps opening up inside the
 * coarse one and drops rush deeper.
 *
 * The tile is a band coordinate built from integer-frequency sine and cosine warps, so it is periodic
 * in the lattice and every term stays exact under translation. A melody note turns the warp direction
 * from its pitch, gliding in on a critically damped spring (from rest, settled in about 0.6 s), and
 * that direction is constant over the plane so the symmetry holds.
 *
 * Nothing snaps: fronts cross the plane in about 0.3 s, each point eases into its new state from rest
 * on a critically damped curve (settled in about 0.45 s), and every glow rises from rest and cools
 * within about 0.3 s.
 *
 * Music:
 *  - morph: the lattice scale, angle and group change per phrase; the warp is driven by the morph
 *    coordinates, the travel by the drive and drops.
 *  - kick: a ring of heat spreads from a point on the plane, and behind it the band phase steps for
 *    good (a hot front along the bands, with embers).
 *  - snare: a cool front from a second point re-cuts the band widths behind it.
 *  - melody: each note turns the warp direction to its pitch, so the tapestry bends toward the note,
 *    and the bands glide to the note's hue while a glow runs out from the note's point.
 *
 * DNA: 0 seed, 1 lattice angle offset, 3 hue, 4 band density, 7 scale.
 */

const NMAX = 12; // the largest point group (p6m) has 12 cosets mod the lattice

// Lattice classes: 0 oblique, 1 rectangular (centred included), 2 square, 3 hexagonal.
// Generators in lattice coordinates, International Tables style: "x,y" maps (u, v) to (u, v).
const R3 = ['x,y', '-y,x-y', '-x+y,-x'];
const GROUPS: { id: string; lat: number; gens: string[] }[] = [
  { id: 'p1', lat: 0, gens: ['x,y'] },
  { id: 'p2', lat: 0, gens: ['x,y', '-x,-y'] },
  { id: 'pm', lat: 1, gens: ['x,y', '-x,y'] },
  { id: 'pg', lat: 1, gens: ['x,y', '-x+1/2,y+1/2'] },
  { id: 'cm', lat: 1, gens: ['x,y', '-x,y', 'x+1/2,y+1/2'] },
  { id: 'pmm', lat: 1, gens: ['x,y', '-x,y', 'x,-y', '-x,-y'] },
  { id: 'pmg', lat: 1, gens: ['x,y', '-x,y', 'x+1/2,-y', '-x+1/2,-y'] },
  { id: 'pgg', lat: 1, gens: ['x,y', '-x+1/2,-y+1/2', '-x,y+1/2', 'x+1/2,-y'] },
  { id: 'cmm', lat: 1, gens: ['x,y', '-x,y', 'x,-y', '-x,-y', 'x+1/2,y+1/2'] },
  { id: 'p4', lat: 2, gens: ['x,y', '-y,x', '-x,-y', 'y,-x'] },
  { id: 'p4m', lat: 2, gens: ['x,y', '-y,x', '-x,-y', 'y,-x', '-x,y', 'x,-y', 'y,x', '-y,-x'] },
  { id: 'p4g', lat: 2, gens: ['x,y', '-y,x', '-x,-y', 'y,-x', 'y+1/2,x+1/2', '-y+1/2,-x+1/2', '-x+1/2,y+1/2', 'x+1/2,-y+1/2'] },
  { id: 'p3', lat: 3, gens: R3 },
  // Mirrors at 30/90/150 degrees: every three-fold centre sits on a mirror.
  { id: 'p3m1', lat: 3, gens: ['x,y', '-y,x-y', 'x,x-y'] },
  // Mirrors at 0/60/120 degrees: the origin centre sits on one, the other centres do not.
  { id: 'p31m', lat: 3, gens: [...R3, 'y,x', 'x-y,-y', '-x,-x+y'] },
  { id: 'p6', lat: 3, gens: ['x,y', '-y,x-y', '-x+y,-x', '-x,-y', 'y,-x+y', 'x-y,x'] },
  {
    id: 'p6m',
    lat: 3,
    gens: ['x,y', '-y,x-y', '-x+y,-x', '-x,-y', 'y,-x+y', 'x-y,x', 'y,x', 'x-y,-y', '-x,-x+y', '-y,-x', '-x+y,y', 'x,x-y'],
  },
];

// Affine map on the lattice: A row-major [a, b, c, d], translation t in sixths (mod 6 = mod 1).
type Affine = { A: number[]; t: number[] };
const mod6 = (x: number) => ((x % 6) + 6) % 6;

function parseAffine(str: string): Affine {
  const comps = str.split(',').map((c) => {
    const a = [0, 0];
    let t = 0;
    const re = /([+-]?)([xy]|\d+\/\d+|\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(c))) {
      const sg = m[1] === '-' ? -1 : 1;
      const tok = m[2];
      if (tok === 'x') a[0] += sg;
      else if (tok === 'y') a[1] += sg;
      else if (tok.includes('/')) {
        const [n, d] = tok.split('/').map(Number);
        t += (sg * n * 6) / d;
      } else t += sg * Number(tok) * 6;
    }
    return { a, t: mod6(t) };
  });
  return {
    A: [comps[0].a[0], comps[0].a[1], comps[1].a[0], comps[1].a[1]],
    t: [comps[0].t, comps[1].t],
  };
}

/** f after g: x -> F (G x + t_g) + t_f. */
function compose(f: Affine, g: Affine): Affine {
  const [a, b, c, d] = f.A;
  const [e, h, i, j] = g.A;
  return {
    A: [a * e + b * i, a * h + b * j, c * e + d * i, c * h + d * j],
    t: [mod6(a * g.t[0] + b * g.t[1] + f.t[0]), mod6(c * g.t[0] + d * g.t[1] + f.t[1])],
  };
}

/** Closure of the generators mod the lattice: one entry per coset of Z^2 in the group. */
function closure(gens: Affine[]): Affine[] {
  const id: Affine = { A: [1, 0, 0, 1], t: [0, 0] };
  const key = (o: Affine) => `${o.A.join(',')}|${o.t.join(',')}`;
  const seen = new Map<string, Affine>([[key(id), id]]);
  let frontier = [id];
  while (frontier.length) {
    const next: Affine[] = [];
    for (const x of frontier) {
      for (const g of gens) {
        const y = compose(g, x);
        const k = key(y);
        if (!seen.has(k)) {
          seen.set(k, y);
          next.push(y);
        }
      }
    }
    frontier = next;
    if (seen.size > NMAX) throw new Error('wallpaper group larger than NMAX');
  }
  return [...seen.values()];
}

const OPS = GROUPS.map((g) => closure(g.gens.map(parseAffine)));
const IDENT: Affine = { A: [1, 0, 0, 1], t: [0, 0] };
const padded = (ops: Affine[]) => [...ops, ...Array<Affine>(NMAX - ops.length).fill(IDENT)];

/** WGSL tables: group sizes, lattice classes, and each coset representative (padded to NMAX). */
const WG_TABLES = /* wgsl */ `
var<private> WG_N: array<i32, ${GROUPS.length}> = array<i32, ${GROUPS.length}>(${OPS.map((o) => o.length).join(', ')});
var<private> WG_LAT: array<i32, ${GROUPS.length}> = array<i32, ${GROUPS.length}>(${GROUPS.map((g) => g.lat).join(', ')});
var<private> WG_A: array<vec4f, ${GROUPS.length * NMAX}> = array<vec4f, ${GROUPS.length * NMAX}>(
  ${OPS.flatMap((ops) => padded(ops).map((o) => `vec4f(${o.A.join(', ')})`)).join(',\n  ')}
);
var<private> WG_T: array<vec2f, ${GROUPS.length * NMAX}> = array<vec2f, ${GROUPS.length * NMAX}>(
  ${OPS.flatMap((ops) => padded(ops).map((o) => `vec2f(${o.t[0] / 6}, ${o.t[1] / 6})`)).join(',\n  ')}
);
`;

const SHADER = /* wgsl */ `
${WG_TABLES}

// Euclidean basis of the lattice (columns), unit scale. Oblique angle and rectangle aspect come from the phrase.
fn wg_basis(lat: i32, sh: f32) -> mat2x2f {
  if (lat == 0) {
    let g = mix(1.0, 2.1, sh);
    return mat2x2f(vec2f(1.0, 0.0), vec2f(cos(g), sin(g)));
  }
  if (lat == 1) { return mat2x2f(vec2f(1.0, 0.0), vec2f(0.0, mix(0.6, 1.5, sh))); }
  if (lat == 2) { return mat2x2f(vec2f(1.0, 0.0), vec2f(0.0, 1.0)); }
  return mat2x2f(vec2f(1.0, 0.0), vec2f(-0.5, 0.8660254));
}
fn wg_inv(M: mat2x2f) -> mat2x2f {
  let a = M[0].x; let b = M[0].y; let c = M[1].x; let d = M[1].y;
  return (1.0 / (a * d - b * c)) * mat2x2f(vec2f(d, -b), vec2f(-c, a));
}

// Periodic tile in lattice coordinates (period 1 in u and v): integer-frequency warps, then a band
// coordinate (s) and a hue coordinate (h). The warp vector wa is constant over the plane.
// mo: the octave's motif (two warp phases, then the fine warp's depth scale), so each zoom octave
// carries its own tile inside the shared symmetry group.
fn wf_tile(x: vec2f, wa: vec2f, mo: vec3f) -> vec2f {
  var w = x + 0.16 * vec2f(sin(TAU * x.y + mo.x), sin(TAU * x.x + mo.y));
  w += wa * sin(TAU * (w.x - w.y));
  // The finest warp belongs to the high end (RULES v7): its depth follows the detail drive and its
  // phase turns with the high notes, so each one re-forms the bands' fine ripples. The phase is
  // constant over the plane, so the symmetry holds.
  let dAmp = floor(S.p[6].z) / 1000.0;
  let dPh = fract(S.p[6].z) / 0.98 * TAU;
  w += mo.z * (0.05 + 0.1 * dAmp) * vec2f(sin(TAU * (2.0 * w.y + w.x) + dPh), cos(TAU * (2.0 * w.x - w.y) - dPh));
  // One sine and cosine per axis give both: sin(a + b) and cos(a - b) by the angle-sum identities.
  let ax = TAU * w.x;
  let ay = TAU * w.y;
  let sx = sin(ax); let cx = cos(ax); let sy = sin(ay); let cy = cos(ay);
  let s = 0.7 * cx + 0.3 * cy;
  let h = (sx * cy + cx * sy) + 0.5 * (cx * cy + sx * sy);
  return vec2f(s, h);
}

// The symmetric field for the three zoom octaves at once: the orbit sum over the group's coset
// representatives, with each coset fetched once and applied to all three octaves (octave k at plane
// point Y * ks[k], with its own warp wa[k] and motif mo[k]).
struct WfOct { f: array<vec2f, 3> }
fn wg_sum3(g: i32, sh: f32, sc: f32, ang: f32, Y: vec2f, ks: vec3f, wa: array<vec2f, 3>, mo: array<vec3f, 3>) -> WfOct {
  let x = wg_inv(wg_basis(WG_LAT[g], sh)) * (rot2(ang) * Y) / sc;
  let x0 = x * ks.x;
  let x1 = x * ks.y;
  let x2 = x * ks.z;
  let n = WG_N[g];
  var o: WfOct;
  for (var i = 0; i < n; i++) {
    let kk = g * ${NMAX} + i;
    let A = mat2x2f(WG_A[kk].xz, WG_A[kk].yw);
    let T = WG_T[kk];
    o.f[0] += wf_tile(A * x0 + T, wa[0], mo[0]);
    o.f[1] += wf_tile(A * x1 + T, wa[1], mo[1]);
    o.f[2] += wf_tile(A * x2 + T, wa[2], mo[2]);
  }
  let nn = 1.0 / sqrt(f32(n));
  o.f[0] *= nn;
  o.f[1] *= nn;
  o.f[2] *= nn;
  return o;
}

// Band half-width for band b at snare phase n: a mix of hairlines and fat tubes, dealt afresh at each
// whole step of n and blended smoothly between deals, so a snare re-cuts the widths as far as its
// strength takes the phase.
fn wf_hw1(b: f32, k: f32, sd: f32) -> f32 {
  let r = hash12(vec2f(b * 1.13 + sd * 31.0, 7.0 + (k - 64.0 * floor(k / 64.0)) * 2.71));
  return mix(0.05, 0.36, r * r);
}
fn wf_hw(b: f32, n: f32, sd: f32) -> f32 {
  let k = floor(n);
  let f = n - k;
  return mix(wf_hw1(b, k, sd), wf_hw1(b, k + 1.0, sd), f * f * (3.0 - 2.0 * f));
}

// A critically damped ease from rest, b seconds after a front arrives: no jump in value or speed, 90%
// there by 0.3 s and settled by about 0.45 s (the whole plane shifts, so it glides a little longer).
fn wf_ease(b: f32) -> f32 { let u = max(b, 0.0) / 0.08; return 1.0 - (1.0 + u) * exp(-u); }
// A glow that rises from rest, peaks tau after the front arrives and fades over a few tau.
fn wf_pulse(b: f32, tau: f32) -> f32 { let u = max(b, 0.0) / tau; return u * u * exp(2.0 - 2.0 * u); }
// An event's age (s) and its strength (0..1), packed as ms in the integer part and strength in the fraction.
fn wf_age(v: f32) -> f32 { return floor(v) / 1000.0; }
fn wf_lv(v: f32) -> f32 { return sat(fract(v) / 0.98); }

// The tapestry at plane point W (field coordinates, depth z). Fronts travel in these coordinates; the
// zoomed field uses the screen-anchored ones.
fn wf_layer(W: vec2f, z: f32) -> vec3f {
  let rag = 0.05 * sin(7.0 * W.x + 4.0 * W.y);

  // Kick: the newest kick and the one before it, each a front from its origin (b0, b1: seconds since
  // it reached this point; it covers 14 units a second). The band phase is the strengths of the older
  // kicks, plus how far each of the two fronts has eased in here, times its strength.
  let l0 = wf_lv(S.p[3].y);
  let l1 = wf_lv(S.p[3].z);
  let b0 = wf_age(S.p[3].y) - (length(W - S.p[4].xy) + rag) / 14.0;
  let pa0 = wf_ease(b0) * l0;
  let b1 = wf_age(S.p[3].z) - (length(W - S.p[4].zw) + rag) / 14.0;
  let pa1 = wf_ease(b1) * l1;
  let phase = S.p[3].x + pa1 + pa0;

  // Snare: one front from its own origin.
  let lS = wf_lv(S.p[5].y);
  let bS = wf_age(S.p[5].y) - (length(W - S.p[5].zw) + 0.7 * rag) / 18.0;
  let paS = wf_ease(bS) * lS;

  // Melody front: light from a point set by the note's pitch (the hue shift glides on the TS side).
  // The note's light rises from a point ahead of the camera (its x set by the pitch); the previous note's
  // light is still drawn (pitch in the integer part of S.p[7].w, its age / 10 in the fraction), so a new
  // note never cuts it off.
  let lN = wf_lv(S.p[7].y);
  let bN = wf_age(S.p[7].y) - (length(W - vec2f(S.p[7].x, 1.2 + S.p[3].w)) + 0.6 * rag) / 18.0;
  let pKey = floor(S.p[7].w);
  let xNp = 1.3 * (floor(pKey / 16.0) / 100.0 - 2.0);
  let lNp = (pKey - 16.0 * floor(pKey / 16.0)) / 15.0;
  let bNp = fract(S.p[7].w) * 10.0 - (length(W - vec2f(xNp, 1.2 + S.p[3].w)) + 0.6 * rag) / 18.0;

  let hueNow = fract(S.p[6].x) / 0.98;
  let sd = S.p[6].y;
  let dens = floor(S.p[6].x) / 1000.0;
  let L = normalize(vec3f(-0.45, 0.6, 0.75));
  let Hv = normalize(L + vec3f(0.0, 0.0, 1.0));
  let heat0 = wf_pulse(b0, 0.04) * l0 + wf_pulse(b1, 0.04) * l1;
  let heatS = wf_pulse(bS, 0.04) * lS;
  let sCol = hsv2rgb(vec3f(fract(hueNow + 0.5), 0.85, 1.0));
  let heatN = wf_pulse(bN, 0.04) * lN + wf_pulse(bNp, 0.04) * lNp;
  let nCol = hsv2rgb(vec3f(fract(hueNow + 0.5 + S.p[7].z), 0.85, 1.0));

  // Infinite zoom: three octaves about a slowly drifting centre, each drawn as crisp glossy bands
  // (anti-aliased by its own band gradient) and composited finest first, coarser over it, each with a
  // tube width from its zoom weight. So a finer tiling shows through the gaps of the coarse one, and as the
  // zoom deepens the coarse tubes thin out of view and the finer tiling takes over, with the next one
  // already opening up inside it. Everything per octave depends only on its id and scale, so the zoom
  // loop has no seam.
  let zz = S.p[0].w;
  let dPh = fract(S.p[6].z) / 0.98 * TAU;
  let c = vec2f(0.45 * sin(zz * 0.37 + sd * 6.0), 1.35 + 0.22 * cos(zz * 0.29 + sd * 4.0));
  let W0 = W - vec2f(0.0, S.p[3].w);
  // Each octave's seed r (from its stable id): its motif phases and warp turn differ, so each new octave
  // is a new pattern, not a copy. All octaves are scaled about the same point (the lattice origin, a
  // symmetry centre of every group), so the finer lattices nest exactly inside the coarse tiling. The
  // fine warp's depth grows with the octave's scale, so the high end re-forms the finest octave most.
  var rs: array<vec4f, 3>;
  var was: array<vec2f, 3>;
  var mos: array<vec3f, 3>;
  for (var k = 0; k < 3; k++) {
    let id = zoomOctaveId(zz, k);
    let r = vec4f(hash12(vec2f(id, sd * 17.0 + 3.1)), hash12(vec2f(id + 0.37, sd * 5.0)),
                  hash12(vec2f(id * 1.7, 9.3)), hash12(vec2f(id + 4.1, sd * 3.0 + 1.0)));
    rs[k] = r;
    was[k] = rot2(TAU * r.z) * S.p[2].zw * (0.8 + 0.4 * r.w);
    mos[k] = vec3f(TAU * r.x, TAU * r.y, 0.9 + 0.25 * zoomScale(zz, k));
  }
  let ks = 0.7 * vec3f(zoomScale(zz, 0), zoomScale(zz, 1), zoomScale(zz, 2));
  var fl = wg_sum3(i32(S.p[0].y), S.p[1].z, S.p[1].w, S.p[2].y, W0 - c, ks, was, mos);
  if (S.p[0].z < 0.999) {
    let fo = wg_sum3(i32(S.p[0].x), S.p[1].x, S.p[1].y, S.p[2].x, W0 - c, ks, was, mos);
    for (var k = 0; k < 3; k++) { fl.f[k] = mix(fo.f[k], fl.f[k], S.p[0].z); }
  }

  var col = vec3f(0.0);
  for (var k = 2; k >= 0; k--) {
    let w = zoomWeight(zz, k);
    let id = zoomOctaveId(zz, k);
    let r = rs[k];
    let fld = fl.f[k];

    // Bands: level sets of the band coordinate, shifted by the kick phase.
    let xb = dens * fld.x + 0.44 * phase + r.x;
    let b = floor(xb);
    let bx = fract(xb) - 0.5;
    let fw = max(fwidth(xb), 1e-4);
    let gv = vec2f(dpdx(xb), dpdy(xb));
    let gd = gv / max(length(gv), 1e-6);
    // An octave enters and leaves by its tubes thinning to hairlines (not by fading to a haze), so
    // every octave stays crisp and opaque.
    let op = 0.85 * smoothstep(0.0, 0.5, w);
    let hw = wf_hw(b + 17.0 * id, S.p[5].x + paS, sd) * op;
    let cov = clamp((hw - abs(bx)) / fw + 0.5, 0.0, 1.0);
    let tt = clamp(bx / max(hw, 1e-3), -1.0, 1.0);
    let hgt = sqrt(max(1.0 - tt * tt, 0.0));
    let nrm = normalize(vec3f(gd * (tt / max(hgt, 0.2)) * 0.8, 1.0));

    // Two hue families (the sign of the symmetric hue field), a hue turn of the octave's own, and each
    // kick steps the hue behind its front.
    let fam = step(0.0, fld.y);
    // The high notes turn the octave's hue too (more the finer it is), as they re-form its ripples.
    let hiTurn = 0.1 * (0.6 + 0.2 * zoomScale(zz, k)) * sin(dPh + TAU * r.z);
    let hue = hueNow + S.p[6].w + 0.42 * fam + 0.11 * phase + 0.14 * hash12(vec2f(b, 1.0)) + 0.3 * r.w + hiTurn;
    let base = hsv2rgb(vec3f(fract(hue), 0.92, 1.0));

    // Glossy tube shading from the band normal.
    let dif = 0.25 + 0.75 * max(dot(nrm, L), 0.0);
    let spc = pow(max(dot(nrm, Hv), 0.0), 60.0);
    let rim = pow(1.0 - nrm.z, 2.0);
    let detail = 1.0 - smoothstep(0.12, 0.3, fw);
    var oc = base * (0.2 + 0.9 * hgt) * dif + base * rim * 0.7 + vec3f(1.0, 0.97, 0.92) * spc * 0.45;
    // Fronts brighten the bands in their own colour (with a touch of the event's), so the tapestry
    // stays saturated and the gaps stay dark.
    oc += (base * 0.4 + vec3f(1.0, 0.6, 0.2) * 0.1) * heat0;
    oc += (base * 0.35 + sCol * 0.15) * heatS;
    oc += (base * 0.7 + nCol * 0.25) * heatN;

    col = mix(col, oc, cov * detail * smoothstep(0.0, 0.08, w));
    col += base * 0.05 * (1.0 - detail) * w;
  }
  return col * exp(-z * 0.06);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  // Camera tilted steeply down: the horizon sits above the frame, so the plane fills it with gentle
  // perspective (depth z from about 0.75 at the top to 2 at the bottom).
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let dd = 2.2 - q.y;
  let z = 2.4 / dd;
  var col = wf_layer(vec2f(q.x * z, z + S.p[3].w), z);
  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.3 * max(pk - 0.9, 0.0));
  return vec4f(col, 1.0);
}
`;

type Cfg = { g: number; sh: number; sc: number; ang: number };
const fract = (x: number) => x - Math.floor(x);
const hash = (x: number) => fract(Math.sin(x) * 43758.5453);

/** The phrase's group, lattice scale and angle (a different group from `avoid`). */
function cfgFor(n: number, seed: number, avoid: number, dna: readonly number[]): Cfg {
  let g = Math.floor(hash(n * 12.9898 + seed * 78.233) * GROUPS.length);
  if (g === avoid) g = (g + 5) % GROUPS.length;
  return {
    g,
    sh: hash(n * 5.31 + seed * 3.7 + 1),
    sc: (0.75 + 0.45 * hash(n * 2.9 + seed * 9.1 + 2)) * (0.85 + 0.3 * dna[7]),
    ang: 2 * Math.PI * (hash(n * 7.7 + seed * 1.3 + 3) + dna[1]),
  };
}

const morph = new Morph(0.8);
const st = {
  seed: -1,
  time: -1e9, // song time last frame, to spot a seek
  phrase: 0,
  cur: { g: 0, sh: 0, sc: 1, ang: 0 } as Cfg,
  prev: { g: 0, sh: 0, sc: 1, ang: 0 } as Cfg,
  kT: [-99, -99], // times of the newest and previous kick
  kO: [[0, 0], [0, 0]], // their origins, in field coordinates
  kL: [0, 0], // their strengths (0..1, captured as each lands)
  kBase: 0, // the band phase of the kicks before them (their strengths summed)
  sL: 0, // the latest snare's strength, and the width phase of the snares before it
  sBase: 0,
  nL: 0, // the latest and previous note's strengths
  prevNL: 0,
  sT: -99,
  sO: [0, 0],
  nT: -99, // latest melody note
  prevNT: -99, // the one before it, and the two notes' pitches
  pitch: 0,
  prevPitch: 0,
  nO: [0, 0],
  nShift: 0, // hue shift of the latest note (from its pitch)
  hue: 0, // the bands' gliding hue shift (springs toward nShift)
  hueV: 0,
  ma: 0, // gliding melody angle and its target
  maT: 0,
  maV: 0,
  drive: 0, // gliding drive
  driveV: 0,
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
function presentAt(seek: boolean): Float64Array {
  const pr = presence();
  for (let i = 0; i < 8; i++) {
    const s = morph.at[i] - morph.flowAt[i];
    const d = s - stepSm.prev[i];
    stepSm.prev[i] = s;
    if (seek || Math.abs(d) > 0.5) stepSm.own[i] = 0;
    else stepSm.own[i] += d * pr;
    // The flow part at half weight: the zoom carries the steady motion now, the beat steps stay full.
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

export default raymarchScene({
  meta: {
    id: 'wallpaper-flow',
    name: 'Wallpaper Flow',
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.55 },
    genres: { edm: 0.9, techno: 0.8, ambient: 0.8, synthwave: 0.9, pop: 0.7, dnb: 0.7, dubstep: 0.6, hiphop: 0.6, rock: 0.5, classical: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const live = dt > 0;
    morph.update(m, ctx.dt, g);
    // A seek (a time jump, spotted as the morph does): the morph's counts and travel run on through it,
    // so the fronts in flight, their captured strengths and the glides are dropped here. The lasting
    // look (the group, the band and width phases, the hue and the warp direction) carries on.
    const seek = Math.abs(m.time - st.time - dt) > 0.5;
    st.time = m.time;
    const a = presentAt(seek);
    const now = m.time;
    if (seek && g[0] === st.seed) {
      st.prev = st.cur;
      st.kT = [-99, -99];
      st.kL = [0, 0];
      st.sT = -99;
      st.sL = st.nL = st.prevNL = 0;
      st.nT = st.prevNT = -99;
      st.prevPitch = st.pitch;
      st.hue = st.nShift;
      st.ma = st.maT;
      st.hueV = st.maV = 0;
      st.drive = morph.drive;
      st.driveV = 0;
    }

    if (g[0] !== st.seed) {
      st.seed = g[0];
      st.phrase = 0;
      st.cur = cfgFor(0, g[0], -1, g);
      st.prev = st.cur;
      st.kT = [-99, -99];
      st.kO = [[0, 0], [0, 0]];
      st.kL = [0, 0];
      st.kBase = st.sBase = st.sL = st.nL = st.prevNL = 0;
      st.sT = -99;
      st.sO = [0, 0];
      st.nT = st.prevNT = -99;
      st.pitch = st.prevPitch = 0;
      st.nShift = st.hue = st.hueV = 0;
      st.ma = st.maV = st.maT = 0;
      st.drive = morph.drive;
      st.driveV = 0;
    }
    if (morph.phrases !== st.phrase) {
      st.phrase = morph.phrases;
      st.prev = st.cur;
      st.cur = cfgFor(st.phrase, g[0], st.cur.g, g);
    }

    const travel = morph.travel * 0.3;
    if (live && morph.kickAge === 0) {
      const n = morph.kicks;
      st.kT = [now, st.kT[0]];
      st.kBase = (st.kBase + st.kL[1]) % 100;
      st.kL = [strength(morph.kickLevel), st.kL[0]];
      st.kO = [[0.7 * Math.sin(n * 2.4 + g[0] * 6), 0.9 + 0.8 * fract(n * 0.618) + travel], st.kO[0]];
    }
    if (live && morph.snareAge === 0) {
      const n = morph.snares;
      st.sT = now;
      st.sBase = (st.sBase + st.sL) % 64;
      st.sL = strength(morph.snareLevel);
      st.sO = [0.8 * Math.cos(n * 1.9 + 1), 1.2 + 1.0 * fract(n * 0.37) + travel];
    }
    if (live && morph.leadAge === 0) {
      st.prevPitch = st.pitch;
      st.prevNT = st.nT;
      st.nT = now;
      st.pitch = morph.notePitch;
      st.prevNL = st.nL;
      st.nL = strength(morph.noteLevel);
      st.nO = [1.3 * morph.notePitch, 1.2 + travel];
      // The note's strength sets how far the hue steps and the warp turns.
      st.nShift += st.nL * (0.24 + 0.06 * morph.notePitch);
      // The warp turns toward 3.5 rad per unit of pitch, between 0.6 and 1.4 rad per full-strength note:
      // a repeated note still turns it, and a wide leap turns smoothly rather than in a whirl.
      const dTurn = morph.notePitch * 3.5 - st.maT;
      st.maT += st.nL * Math.sign(dTurn || 1) * Math.min(1.4, Math.max(0.6, Math.abs(dTurn)));
    }

    // Melody: the warp direction (settled in about 0.6 s) and the bands' hue (about 0.5 s) glide to the
    // note from rest on critically damped springs and hold; the drive glides too.
    [st.ma, st.maV] = spring(st.ma, st.maV, st.maT, 9, dt);
    [st.hue, st.hueV] = spring(st.hue, st.hueV, st.nShift, 10, dt);
    [st.drive, st.driveV] = spring(st.drive, st.driveV, morph.drive, 8, dt);

    // Morph: the warp vector (constant over the plane, so the symmetry holds) and the lattice angle wobble.
    const dr = 1 + 0.3 * st.drive;
    const wa0 = dr * (0.42 * Math.cos(st.ma) + 0.03 * Math.sin(a[0]));
    const wa1 = dr * (0.42 * Math.sin(st.ma) + 0.03 * Math.sin(a[1] + 1));
    const wob = wave(a[2], -0.08, 0.08);

    // Cross-fade the old group into the new one over the first bar of a phrase.
    const bar = (60 / Math.max(40, m.bpm)) * Math.max(1, m.beatsPerBar);
    const xf = Math.min(1, Math.max(0, morph.phraseAge / bar));
    const xfe = xf * xf * (3 - 2 * xf);

    const bandK = 0.55 + 0.35 * g[4];
    // The zoom level in octaves: paced by the music's travel (rushing on drops), offset by the seed.
    const zoom = morph.travel * 0.32 + 37 * g[0];
    p.set([st.prev.g, st.cur.g, xfe, zoom], 0);
    // Melody: origin, age, new hue shift; the gliding hue shift goes in slot 6.
    p.set([st.prev.sh, st.prev.sc, st.cur.sh, st.cur.sc], 4);
    p.set([st.prev.ang + wob, st.cur.ang + wob, wa0, wa1], 8);
    // Event ages (ms in the integer part) with the event's strength packed in the fraction.
    const ev = (t: number, l: number) => Math.floor(Math.min(99, now - t) * 1000) + 0.98 * l;
    p.set([st.kBase, ev(st.kT[0], st.kL[0]), ev(st.kT[1], st.kL[1]), travel], 12);
    p.set([st.kO[0][0], st.kO[0][1], st.kO[1][0], st.kO[1][1]], 16);
    p.set([st.sBase, ev(st.sT, st.sL), st.sO[0], st.sO[1]], 20);
    // Band density (thousandths) with the hue base in the fraction; the seed; fine detail (RULES v7:
    // depth from the detail drive in thousandths, phase in turns in the fraction, flowing with the
    // detail coordinates and stepping with each high note, backing chord and hat); the gliding hue.
    // High notes carry the change (a turn of up to 3.5 radians each, by strength); the detail
    // coordinates, backing and hats only drift it slowly. Glided on a critically damped spring (its
    // quickest about 0.15 s after a note, settled in about 0.7 s), so a note re-forms the detail smoothly.
    const dT = 0.15 * morph.detailAt[0] + 0.1 * morph.detailAt[1] + 3.5 * morph.upperPhase + 0.6 * morph.backingPhase + 0.15 * morph.hatPhase;
    // Its changes count by the music's presence too (a jump means a new cue: start there).
    const dInc = dT - detailSm.raw;
    detailSm.raw = dT;
    if (seek || Math.abs(dInc) > 20) [detailSm.x, detailSm.v, detailSm.t] = [dT, 0, dT];
    else detailSm.t += dInc * presence();
    [detailSm.x, detailSm.v] = spring(detailSm.x, detailSm.v, detailSm.t, 11, dt);
    // The detail depth follows the detail drive, weighted by the presence, gliding in over about a second.
    [detailSm.a, detailSm.av] = spring(detailSm.a, detailSm.av, 0.15 + 0.85 * morph.detailDrive * presence(), 3.5, dt);
    const dPh = detailSm.x;
    const detail = Math.round(Math.min(1, Math.max(0, detailSm.a)) * 1000) + 0.98 * fract(dPh / (2 * Math.PI));
    p.set([Math.round(bandK * 1000) + 0.98 * g[3], g[0], detail, st.hue], 24);
    // The previous note: pitch and strength in the integer part, its age (s) / 10 in the fraction.
    const prevKey = Math.round((Math.max(-1.9, Math.min(1.9, st.prevPitch)) + 2) * 100) * 16 + Math.round(st.prevNL * 15);
    const prevCode = prevKey + Math.min(now - st.prevNT, 9) / 10;
    p.set([st.nO[0], ev(st.nT, st.nL), st.nShift, prevCode], 28);
  },
  wgsl: SHADER,
});
