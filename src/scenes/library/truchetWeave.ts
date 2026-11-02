import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Truchet Weave: multi-scale Truchet tiles on the wall of a tunnel. Each cell is a pair of quarter
 * arcs (glossy neon tubes that join into long meandering paths), a straight diagonal, or a weave
 * cross where two diagonals pass over and under each other. Some cells split into four half-size
 * cells in inverted colour, so the paths run between scales.
 *
 * The tunnel is the wall of a cylinder seen from its axis: u = angle around, z = depth. The pattern
 * recedes to a dark vanishing core, and a cell that falls under a few pixels fades to its mean colour.
 *
 * Fronts run along the tubes. A tube's arrival time is the lattice distance from the ignition cell
 * plus its own arc length, so a front follows the connected paths, ragged per cell. The lattice
 * distance stands in for the traced path length, so a front is close to the path, not exact.
 *  - kick: a fire lit at the near end; behind it every tube it burned takes the next hue for good;
 *  - snare: a cool crackle from the far end; behind it each cell rewires (its arcs turn the other way);
 *  - melody: a row lit at the depth the pitch sets; behind it the tubes take a new width.
 * Every reaction goes by its hit's strength (the morph levels): glows scale with it, the kick's hue
 * step and the width step move by it, and a snare rewires a share of the cells equal to it. Glows
 * rise over about 0.1 s after a front arrives.
 * Each phrase re-rolls (cross-fading over about a bar) the ring count (tile scale), the subdivision
 * share, the arc-to-diagonal mix,
 * the weave share and the weave's checker phase. The morph drifts the mix and the weave, and turns
 * the tunnel; drops rush the scroll and the twist.
 *
 * DNA: 0 start, 3 palette, 5 twist sense.
 */

const morph = new Morph(1.0);
const TAU = Math.PI * 2;
/** Ring counts (cells around the tunnel). Integers, so the seam at angle +-pi closes. */
const RINGS = [6, 8, 10, 12, 16];
const hash = (x: number) => {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const st = {
  seed: -1,
  n: -1,
  k: -1,
  s: -1,
  phrase: -1,
  ni: 0,
  cells: 8,
  sub: 0.2,
  mix: 0.7,
  wv: 0.1,
  mode: 0,
  par: 0,
  tr: 0,
  z0: 0,
  tw: 0,
  pNew: 0,
  pOld: 0,
  ko: [0, 0],
  so: [0, 0],
  lo: 0,
  /**
   * Event strengths (morph levels, which carry the passage's presence): the latest hit's, and the sum of
   * the earlier ones (the lasting state: hue steps, rewired share, tube widths all move by strength).
   */
  kL: 0,
  kB: 0,
  sL: 0,
  sB: 0,
  nL: 0,
  nB: 0,
  /** The previous note (row, age, strength): its glow and width step still finish as the next one lands. */
  loP: 0,
  ageP: 9,
  nLp: 0,
  lastAge: 9,
  /** The outgoing phrase's tiling, cross-faded out over about a bar (fade 0 -> 1), so a phrase never snaps. */
  old: { cells: 8, sub: 0.2, mix: 0.7, wv: 0.1, mode: 0, par: 0 },
  fade: 1,
};

export default raymarchScene({
  meta: {
    id: 'truchet-weave',
    name: 'Truchet Weave',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.6 },
    genres: { edm: 0.9, techno: 0.9, synthwave: 0.9, dnb: 0.7, dubstep: 0.6, pop: 0.6, hiphop: 0.5, ambient: 0.5, rock: 0.4, classical: 0.3 },
    trails: 0,
    kaleido: false,
    // Kick and snare lifts stay near 1.2 on the dense riddim track (the gate needs 1.8 and 1.4); it passes the default track.
    auto: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.at;

    // A new cue (or a seek back) restarts the wall; the phrase below then re-rolls the tiling.
    if (g[0] !== st.seed || morph.notes < st.n) {
      st.seed = g[0];
      st.n = morph.notes;
      st.pNew = st.pOld = morph.notePitch;
      st.tr = morph.travel;
      st.z0 = 0;
      st.tw = 0;
      st.phrase = -1;
      st.kL = st.kB = st.sL = st.sB = st.nL = st.nB = st.nLp = 0;
      st.ageP = st.lastAge = 9;
    }
    // Each phrase: a new ring count (never the same as before), subdivision, arc share, weave share,
    // and the weave's checker mode and phase.
    if (morph.phrases !== st.phrase) {
      if (st.phrase >= 0) {
        st.old = { cells: st.cells, sub: st.sub, mix: st.mix, wv: st.wv, mode: st.mode, par: st.par };
        st.fade = 0;
      } else st.fade = 1;
      st.phrase = morph.phrases;
      const r = (k: number) => hash(st.phrase * 7.13 + st.seed * 101.7 + k);
      st.ni = (st.ni + 1 + Math.floor(r(1) * (RINGS.length - 1))) % RINGS.length;
      st.cells = RINGS[st.ni];
      st.sub = 0.05 + 0.4 * r(2);
      st.mix = 0.4 + 0.55 * r(3);
      st.wv = 0.08 + 0.4 * r(4);
      st.mode = r(5) < 0.5 ? 0 : 1;
      st.par = r(6) < 0.5 ? 0 : 1;
    }

    // Energy: the wall scrolls toward the viewer and the twist turns with the travel. A drop rushes both.
    const dTr = Math.min(Math.max(morph.travel - st.tr, 0), 1);
    st.tr = morph.travel;
    const rush = 1 + 3 * morph.surge;
    st.z0 += dTr * 0.5 * rush;
    st.tw += dTr * (0.1 + 0.2 * morph.drive) * rush;
    const N = st.cells;
    const sense = g[5] < 0.5 ? -1 : 1;

    // Ignitions are fixed on the wall when the event lands (wall coordinates: cell x, cell row).
    if (morph.notes !== st.n) {
      st.n = morph.notes;
      st.pOld = st.pNew;
      st.pNew = morph.notePitch;
      const z = 0.6 + 2.2 * ((morph.notePitch + 1) / 2);
      st.loP = st.lo;
      st.lo = (z + st.z0) * N / TAU;
      st.ageP = st.lastAge;
      st.nB += st.nLp;
      st.nLp = st.nL;
      st.nL = morph.noteLevel;
    }
    st.ageP = Math.min(9, st.ageP + Math.min(Math.max(ctx.dt, 0), 0.1));
    st.lastAge = morph.leadAge;
    if (morph.kicks !== st.k) {
      st.k = morph.kicks;
      st.ko = [hash(st.k * 2.3 + st.seed * 19.0) * N, (0.55 + st.z0) * N / TAU];
      st.kB += st.kL;
      st.kL = morph.kickLevel;
    }
    if (morph.snares !== st.s) {
      st.s = morph.snares;
      st.so = [hash(st.s * 4.1 + st.seed * 23.0 + 5.0) * N, (2.6 + st.z0) * N / TAU];
      st.sB += st.sL;
      st.sL = morph.snareLevel;
    }

    const mixT = Math.min(1, Math.max(0, st.mix + 0.03 * Math.sin(a[3])));
    const wv = Math.min(0.6, Math.max(0, st.wv + 0.015 * Math.sin(a[4])));
    const bar = (60 / Math.max(40, m.bpm)) * Math.max(1, m.beatsPerBar);
    st.fade = Math.min(1, st.fade + Math.min(Math.max(ctx.dt, 0), 0.1) / Math.max(0.8, bar));
    const o = st.old;
    const mixO = Math.min(0.999, Math.max(0, o.mix + 0.03 * Math.sin(a[3])));
    const wvO = Math.min(0.6, Math.max(0, o.wv + 0.015 * Math.sin(a[4])));

    // Slot 0: wall scroll, twist, ring count, subdivision share.
    p[0] = st.z0;
    p[1] = sense * wave(a[1], -0.7, 0.7);
    p[2] = N;
    p[3] = st.sub;
    // Slot 1: arc share, weave share, weave mode and phase.
    p[4] = mixT;
    p[5] = wv;
    p[6] = st.mode;
    p[7] = st.par;
    // Slot 2: kick origin, age, summed strength of the earlier kicks.
    p[8] = st.ko[0];
    p[9] = st.ko[1];
    p[10] = Math.min(morph.kickAge, 9);
    p[11] = st.kB % 1024;
    // Slot 3: snare origin, age, summed strength of the earlier snares.
    p[12] = st.so[0];
    p[13] = st.so[1];
    p[14] = Math.min(morph.snareAge, 9);
    p[15] = st.sB % 1024;
    // Slot 4: melody row, age, pitch, summed strength of the earlier notes.
    p[16] = st.lo;
    p[17] = Math.min(morph.leadAge, 9);
    p[18] = st.pNew;
    p[19] = st.nB % 1024;
    // Slot 5: palette hue, luminance, previous pitch, latest kick strength.
    p[20] = g[3] + 0.06 * Math.sin(a[5] * 0.5);
    p[21] = 0.7 + 0.2 * morph.drive + 0.3 * morph.surge;
    p[22] = st.pOld;
    p[23] = st.kL;
    // Slot 6: latest snare and note strengths, previous note's row and age; slot 7: its strength.
    p[24] = st.sL;
    p[25] = st.nL;
    p[26] = st.loP;
    p[27] = st.ageP;
    p[28] = st.nLp;
    // Slot 7 yzw: the outgoing tiling (ring count, weave mode and phase; subdivision and arc shares;
    // weave share with the cross-fade in the fraction).
    p[29] = o.cells + 32 * o.mode + 64 * o.par;
    p[30] = Math.floor(o.sub * 1000) * 1000 + Math.floor(mixO * 1000);
    p[31] = Math.floor(wvO * 1000) + 0.999 * st.fade * st.fade * (3 - 2 * st.fade);
  },
  wgsl: /* wgsl */ `
struct TwT { d1: f32, s1: f32, d2: f32, s2: f32, x: f32 };
// One tiling: ring count, subdivision share, arc share, weave share, weave mode and phase.
struct TwP { N: f32, sub: f32, mixT: f32, wv: f32, mode: f32, par: f32 };
struct TwC { d1: f32, s1: f32, d2: f32, s2: f32, x: f32, gap: f32, hA: f32, bK1: f32, bK2: f32, bS: f32, bL: f32, hw: f32, bLp: f32 };

// Palette colour at a luminance, pushed toward full saturation (neon on black).
fn tw_col(t: f32, lvl: f32, rot: f32) -> vec3f {
  let p = pal(t);
  let mx = max(p.r, max(p.g, p.b));
  let mn = min(p.r, min(p.g, p.b));
  let d = max(mx - mn, 1e-4);
  var h = select(select((p.r - p.g) / d + 4.0, (p.b - p.r) / d + 2.0, mx == p.g), (p.g - p.b) / d, mx == p.r);
  h = fract(h / 6.0);
  let s = mix(0.75, 0.97, sat((mx - mn) / max(mx, 1e-4)));
  let c = hsv2rgb(vec3f(fract(h + rot), s, 1.0));
  return c * lvl * pow(0.4 / max(luma(c), 0.08), 0.55);
}

// Fire by heat (1 = just lit): white core, yellow, orange.
fn tw_fire(h: f32) -> vec3f {
  return vec3f(1.0, 0.25, 0.05) * h * 1.4 + vec3f(1.0, 0.62, 0.2) * h * h * 2.2 + vec3f(1.0, 0.95, 0.9) * pow(h, 5.0) * 2.5;
}

// Lattice distance (in cells) between two cells; x wraps around n cells, y does not.
fn tw_cdist(a: vec2f, b: vec2f, n: f32) -> f32 {
  let dx = abs(a.x - b.x);
  let wx = dx - n * floor(dx / n);
  return min(wx, n - wx) + abs(a.y - b.y);
}

// Arrival of a front at a tube: lattice distance plus the tube's arc length, at a ragged speed.
fn tw_arrive(D: f32, s: f32, h: f32, v: f32) -> f32 {
  return (D + s) / (v * (0.75 + 0.5 * h)) + 0.4 * h * h;
}

// Box-filtered coverage of a tube of half-width hw by a pixel whose distance footprint is fw.
fn tw_cover(d: f32, hw: f32, fw: f32) -> f32 {
  return clamp(0.5 + (hw - d) / max(fw, 1e-4), 0.0, 1.0);
}

// Strands of one cell in cell coordinates f (0..1). kind 0: arc tile, 1: diagonal tile, 2: weave cross.
// ori picks the orientation pair. Over0 = 1 puts the corner-to-corner strand (0,0)-(1,1) on top of a cross.
fn tw_tile(f: vec2f, ori: f32, kind: f32, over0: f32) -> TwT {
  // Quarter arcs of radius 0.5 centred on corners; arc length from the corner is 0.5 * angle.
  let dA = abs(length(f) - 0.5);
  let sA = 0.5 * atan2(f.y, f.x);
  let dB = abs(length(1.0 - f) - 0.5);
  let sB = 0.5 * atan2(1.0 - f.y, 1.0 - f.x);
  let hC = vec2f(1.0 - f.x, f.y);
  let dC = abs(length(hC) - 0.5);
  let sC = 0.5 * atan2(hC.y, hC.x);
  let hD = vec2f(f.x, 1.0 - f.y);
  let dD = abs(length(hD) - 0.5);
  let sD = 0.5 * atan2(hD.y, hD.x);
  // Straight strands: E corner to corner (0,0)-(1,1), F the other (1,0)-(0,1).
  let dE = abs(f.x - f.y) * 0.70710678;
  let sE = (f.x + f.y) * 0.70710678;
  let dF = abs(f.x + f.y - 1.0) * 0.70710678;
  let sF = (1.0 - f.x + f.y) * 0.70710678;

  let up = ori > 0.5;
  let arc0 = select(dB, dA, dA < dB);
  let arc0s = select(sB, sA, dA < dB);
  let arc1 = select(dD, dC, dC < dD);
  let arc1s = select(sD, sC, dC < dD);
  let arcD = select(arc0, arc1, up);
  let arcS = select(arc0s, arc1s, up);
  let dg = select(dE, dF, up);
  let dgs = select(sE, sF, up);
  let pri = select(dg, arcD, kind < 0.5);
  let pris = select(dgs, arcS, kind < 0.5);

  let ov = over0 > 0.5;
  let cross = kind > 1.5;
  let cOver = select(dF, dE, ov);
  let cOverS = select(sF, sE, ov);
  let cUnder = select(dE, dF, ov);
  let cUnderS = select(sE, sF, ov);

  var t: TwT;
  t.d1 = select(pri, cOver, cross);
  t.s1 = select(pris, cOverS, cross);
  t.d2 = select(1000.0, cUnder, cross);
  t.s2 = select(0.0, cUnderS, cross);
  t.x = select(0.0, 1.0, cross);
  return t;
}

// One cell: its tile, its tube width, and the state each front has left in it.
fn tw_cell(c: vec2f, f: vec2f, cc: vec2f, T: TwP) -> TwC {
  let N = T.N;
  let hA = hash12(c);
  let hT = hash12(c * vec2f(1.31, 0.77) + vec2f(4.1, 9.7));
  let hK = hash12(c * vec2f(0.53, 1.91) + vec2f(2.3, 6.1));
  // Tile kind: a weave cross, else an arc tile, else a diagonal tile.
  let kind = select(select(1.0, 0.0, hK < T.mixT), 2.0, hT < T.wv);

  // Snare: behind the front each cell's rewiring count rises by the snare's strength, offset per
  // cell, so a share of the cells equal to the strength re-rolls its orientation (a faint snare
  // rewires a few cells, a full one all of them).
  let Ds = tw_cdist(cc, S.p[3].xy, N);
  let bSc = S.p[3].z - tw_arrive(Ds, 0.0, hA, 12.0);
  let sSt = floor(S.p[3].w + S.p[6].x * step(0.0, bSc) + fract(hT * 7.31));
  let ori = step(0.5, hash12(c + vec2f(sSt * 17.31, sSt * 5.73)));

  // Weave: which diagonal is on top, by a checker (or row) pattern with a phase.
  let pk = select(c.y, c.x + c.y, T.mode < 0.5) + T.par;
  let over0 = 1.0 - step(0.5, fract(pk * 0.5));

  let t = tw_tile(f, ori, kind, over0);

  // Kick: a front from the near end reaches each strand after its own arc length.
  let Dk = tw_cdist(cc, S.p[2].xy, N);
  let bK1 = S.p[2].z - tw_arrive(Dk, t.s1, hA, 7.0);
  let bK2 = S.p[2].z - tw_arrive(Dk, t.s2, hA, 7.0);
  // Melody: a row at the note's depth; each cell's width steps behind it.
  let Dl = abs(cc.y - S.p[4].x);
  let bL = S.p[4].y - tw_arrive(Dl, 0.0, hA, 9.0);
  // The width follows a smooth per-cell curve of the notes' summed strength, so a faint note moves
  // it a little and a strong one a lot.
  let bLp = S.p[6].w - tw_arrive(abs(cc.y - S.p[6].z), 0.0, hA, 9.0);
  let lN = S.p[4].w + S.p[7].x * smoothstep(0.0, 0.9, bLp) + S.p[6].y * smoothstep(0.0, 0.9, bL) + hK * 7.0;
  let li = floor(lN);
  let hwOld = 0.13 + 0.05 * hash12(c + vec2f(li * 5.3, li * 2.9));
  let hwNew = 0.13 + 0.05 * hash12(c + vec2f((li + 1.0) * 5.3, (li + 1.0) * 2.9));
  let hw = mix(hwOld, hwNew, smoothstep(0.0, 1.0, lN - li));

  // Under a cross, the under strand is cut around the crossing.
  let gap = smoothstep(0.2, 0.26, length(f - 0.5));

  var o: TwC;
  o.d1 = t.d1; o.s1 = t.s1; o.d2 = t.d2; o.s2 = t.s2; o.x = t.x;
  o.gap = gap; o.hA = hA; o.bK1 = bK1; o.bK2 = bK2; o.bS = bSc; o.bL = bL; o.hw = hw; o.bLp = bLp;
  return o;
}

// The wall in one tiling, at the tunnel point pt.
fn tw_layer(pt: vec3f, T: TwP) -> vec3f {
  let N = T.N;
  let P = vec2f((atan2(pt.y, pt.x) + S.p[0].y * pt.z) * N / TAU, (pt.z + S.p[0].x) * N / TAU);
  // Cells per pixel at the top level (derivatives stay out of branches).
  let px = max(fwidth(P.x), fwidth(P.y));

  // Subdivided cells (a share of the parents) are shown at half size, in inverted colour.
  let isSub = hash12(floor(P) * vec2f(0.37, 1.13) + vec2f(9.1, 3.3)) < T.sub;
  let subf = select(0.0, 1.0, isSub);
  let c = select(floor(P), floor(2.0 * P), isSub);
  let f = select(fract(P), fract(2.0 * P), isSub);
  let cc = select(floor(P) + 0.5, (floor(2.0 * P) + 0.5) * 0.5, isSub);
  let K = tw_cell(c, f, cc, T);

  // Fade cells under about 3 to 8 pixels to their mean colour.
  let detail = 1.0 - smoothstep(0.12, 0.3, px * select(1.0, 2.0, isSub));

  let fw1 = max(fwidth(K.d1), 1e-4);
  let fw2 = max(fwidth(K.d2), 1e-4);
  let cov1 = tw_cover(K.d1, K.hw, fw1);
  let cov2 = tw_cover(K.d2, K.hw, fw2) * K.gap * K.x;

  // Hue: palette by cell, a step for good behind each kick.
  let hue0 = S.p[5].x;
  let kN = S.p[2].w;
  let kL = S.p[5].w;
  let hs1 = kN + kL * smoothstep(0.0, 0.6, K.bK1);
  let hs2 = kN + kL * smoothstep(0.0, 0.6, K.bK2);
  let hue1 = hue0 + 0.75 * fract(K.hA * 3.7 + 0.22 * hs1) + 0.5 * subf;
  let hue2 = hue1 + 0.3;

  // Glossy tube normals from the screen gradient of the distance.
  let g1 = vec2f(dpdx(K.d1), dpdy(K.d1));
  let t1 = clamp(K.d1 / K.hw, 0.0, 1.0);
  let hg1 = sqrt(max(1.0 - t1 * t1, 0.0));
  let nrm1 = normalize(vec3f(g1 / max(length(g1), 1e-6) * (t1 / max(hg1, 0.2)) * 0.9, 1.0));
  let t2 = clamp(K.d2 / K.hw, 0.0, 1.0);
  let hg2 = sqrt(max(1.0 - t2 * t2, 0.0));

  let ld = normalize(vec3f(-0.45, 0.6, 0.75));
  let hv = normalize(ld + vec3f(0.0, 0.0, 1.0));
  let base1 = tw_col(hue1, 0.34, 0.0);
  let dif1 = 0.25 + 0.75 * max(dot(nrm1, ld), 0.0);
  let spc1 = pow(max(dot(nrm1, hv), 0.0), 60.0);
  let fres1 = pow(1.0 - nrm1.z, 2.0);
  var tube1 = base1 * (0.25 + 0.9 * hg1) * dif1;
  tube1 += tw_col(hue1 + 0.22, 0.4, 0.0) * fres1 * 0.6;
  tube1 += base1 * 2.5 * spc1 * 0.5;
  // The under strand sits in shadow.
  let tube2 = tw_col(hue2, 0.3, 0.0) * (0.3 + 0.6 * hg2) * 0.7;

  // Fronts: fire from a kick, a cool crackle from a snare, a note-coloured glow from the melody.
  let kA = S.p[2].z;
  let sA = S.p[3].z;
  let lA = S.p[4].y;
  // Each glow rises over about 0.1 s after its front arrives (never a one-frame flash) and is scaled
  // by its hit's strength.
  let heat = smoothstep(0.0, 0.08, K.bK1) * exp(-max(K.bK1, 0.0) * 8.0) * exp(-kA * 1.3) * kL;
  let emb = smoothstep(0.0, 0.1, K.bK1) * exp(-max(K.bK1, 0.0) * 1.2) * step(0.8, hash12(vec2f(floor(K.s1 * 9.0), K.hA * 97.0))) * exp(-kA * 0.35) * kL;
  let sh = smoothstep(0.0, 0.08, K.bS) * exp(-max(K.bS, 0.0) * 9.0) * exp(-sA * 1.8) * S.p[6].x;
  let sCol = mix(tw_col(hue0 + 0.55, 0.9, 0.0), vec3f(0.3, 0.7, 1.0), 0.4);
  let lh = smoothstep(0.0, 0.15, K.bL) * exp(-max(K.bL, 0.0) * 2.5) * exp(-lA * 4.0) * S.p[6].y;
  // The previous note's row keeps glowing out (in its own colour), so a new note never cuts it off.
  let lhP = smoothstep(0.0, 0.15, K.bLp) * exp(-max(K.bLp, 0.0) * 2.5) * exp(-S.p[6].w * 4.0) * S.p[7].x;
  let nCol = (tw_col(hue0 + 0.5 * S.p[4].z + 0.25, 0.9, 0.0) * lh + tw_col(hue0 + 0.5 * S.p[5].z + 0.25, 0.9, 0.0) * lhP) / max(lh + lhP, 1e-4);
  let lhT = lh + lhP;

  let fire1 = tw_fire(heat) * 0.9 + tw_fire(0.3) * emb * 0.35 + sCol * sh * 2.0 + nCol * lhT * 3.5;
  var col = (tube1 + fire1) * cov1 * detail + tube2 * cov2 * (1.0 - cov1) * detail;
  // Glow in the gaps beside burning tubes.
  let gapd = max(K.d1 - K.hw, 0.0);
  let halo = exp(-gapd / max(0.12, fw1 * 3.0)) * (heat * 0.8 + sh * 0.6 + lhT * 0.3) * detail;
  col += (tw_fire(heat) * 0.3 + sCol * sh * 0.5 + nCol * lhT) * halo;
  // Fine cells settle to their mean colour.
  col += tw_col(hue0 + 0.3, 0.12, 0.0) * (1.0 - detail) * 0.6;
  return col;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  // Tunnel: a ray meets the unit cylinder at pt; u = angle around, depth = pt.z.
  let rd = vec3f(q, 1.15);
  let pt = rd / length(rd.xy);
  let cur = TwP(S.p[0].z, S.p[0].w, S.p[1].x, S.p[1].y, S.p[1].z, S.p[1].w);
  var col = tw_layer(pt, cur);
  // A new phrase's tiling cross-fades in over about a bar.
  let fade = fract(S.p[7].w) / 0.999;
  if (fade < 0.999) {
    let oc = S.p[7].y;
    let ot = TwP(oc % 32.0, floor(S.p[7].z / 1000.0) / 1000.0, (S.p[7].z % 1000.0) / 1000.0, floor(S.p[7].w) / 1000.0, floor(oc / 32.0) % 2.0, floor(oc / 64.0));
    col = mix(tw_layer(pt, ot), col, fade);
  }

  col *= S.p[5].y;
  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.3 * max(pk - 0.9, 0.0));
  return vec4f(col, 1.0);
}
`,
});
