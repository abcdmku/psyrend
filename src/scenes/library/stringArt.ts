import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * String Art: straight luminous threads stretched between two guide curves, two thread sets in
 * different hues. Thread i of a set runs from A(u_i) on the near guide to B(m u_i + c) on the far
 * guide, u_i = 2 pi i / 32 (the classic n -> m·n times table). Guides are lobed circles whose
 * radius and height wave with the angle, so the threads' envelope forms curved caustic shapes out
 * of straight lines. Threads are projected through a pinhole (straight 3D lines stay straight on
 * screen), so the far set sits behind the near one in depth.
 *
 * Each thread is measured analytically in pixels (distance to its segment), with a thin
 * anti-aliased core and a soft halo. Fronts run along the threads' own index order and along
 * each thread's length:
 *  - morph: guide radii, lobe depth, heights and twists drift continuously; each phrase re-draws
 *    the multipliers (the envelope type) and the thread set is re-cast with a front.
 *  - kick: steps both multipliers for good; the threads swing to the new envelope behind a hot
 *    front that runs along them from one origin, with embers that cool.
 *  - snare: re-threads one set (its thread offset steps); a cool spark runs along that set.
 *  - melody: each note bends the near guide's lobes by its pitch (eased over about 50 ms) and lights
 *    the threads at the pitch's place in note colour; the threads keep leaning to that colour.
 *  - drops: rush the guides' twists and the view turn.
 * Every beat's change and light scales with its event's level squared (which carries how loud the
 * passage is): a faint kick swings the threads only part of the way to the next envelope, a faint
 * note bends the guide and turns the colour a little, so an intro motif ripples instead of re-casting.
 *
 * DNA: 0 start, 2 near-guide lobes, 4 far-guide lobes, 5 far-set lobes, 7 zoom.
 */

const morph = new Morph(0.8);
const st = {
  seed: -1,
  kicks: 0,
  snares: 0,
  notes: 0,
  phrases: 0,
  tr: 0,
  phA: 0,
  phB0: 0,
  phB1: 0,
  rot: 0,
  pe: 0,
  kickSteps: 0,
  base0: 0,
  base1: 0,
  prev0: 2,
  cur0: 2,
  prev1: 2,
  cur1: 2,
  reformAge: 9,
  reformI0: 0,
  reforms: 0,
  sSet: 0,
  sI0: 0,
  sAge: 9,
  cPrev: 0,
  cs: [0, 0],
  lAge: 9,
  lIdx: 16,
  hueN: 0,
  hueP: 0,
  /** Glided pitch bend of the near guide, and the levels squared of the latest kick / snare / note. */
  peT: 0,
  kLv: 0,
  sLv: 0,
  nLv: 0,
};
const sq = (x: number) => Math.min(1, x * x);

/** Pseudo-random origin on the 32-thread ring, from a counter. */
const ringPick = (x: number) => {
  const f = Math.sin(x * 12.9898) * 43758.5453;
  return (f - Math.floor(f)) * 32;
};
/** Multiplier 2..6 from a base (set at each phrase) and the kick steps taken so far. */
const multFor = (base: number, steps: number) => 2 + ((((base + steps) % 5) + 5) % 5);

export default raymarchScene({
  meta: {
    id: 'string-art',
    name: 'String Art',
    // Out of the show: too few threads to form envelopes; reads as a cluster of sticks in a void.
    auto: false,
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.55 },
    genres: { edm: 0.9, techno: 0.8, ambient: 0.8, synthwave: 1, pop: 0.6, dnb: 0.6, classical: 0.5, hiphop: 0.5, dubstep: 0.6, rock: 0.4 },
    trails: 0,
    sparse: true,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    const a = morph.at;

    if (g[0] !== st.seed || morph.kicks < st.kicks || morph.phrases < st.phrases) {
      st.seed = g[0];
      st.kicks = morph.kicks;
      st.snares = morph.snares;
      st.notes = morph.notes;
      st.phrases = morph.phrases;
      st.tr = morph.travel;
      st.phA = st.phB0 = st.phB1 = st.rot = 0;
      st.pe = morph.notePitch;
      st.kickSteps = 0;
      st.base0 = Math.floor(wave(a[3], 0, 4.999));
      st.base1 = Math.floor(wave(a[7], 0, 4.999));
      st.prev0 = st.cur0 = multFor(st.base0, 0);
      st.prev1 = st.cur1 = multFor(st.base1, 0);
      st.reformAge = 9;
      st.reformI0 = 0;
      st.reforms = 0;
      st.sSet = 0;
      st.sI0 = 0;
      st.sAge = 9;
      st.cPrev = 0;
      st.cs = [0, 0];
      st.lAge = 9;
      st.lIdx = 16;
      st.hueN = st.hueP = 0;
      st.peT = st.pe;
      st.kLv = st.sLv = st.nLv = 0;
    }

    // Phrase change: a new envelope type for both sets, cast in by a front.
    // Kick: steps both multipliers by one, for good. Either one re-forms the threads.
    let reform = false;
    let reach = 1;
    if (morph.phrases !== st.phrases) {
      st.phrases = morph.phrases;
      st.base0 = Math.floor(wave(a[3], 0, 4.999));
      st.base1 = Math.floor(wave(a[7], 0, 4.999));
      reform = true;
    }
    if (morph.kicks !== st.kicks) {
      st.kickSteps += morph.kicks - st.kicks;
      st.kicks = morph.kicks;
      // A kick swings the threads as far toward the next envelope as it is strong (a phrase: all the way).
      if (!reform) reach = sq(morph.kickLevel);
      reform = true;
    }
    if (reform) {
      // The swing starts from wherever the threads are (a multiplier part-way between envelopes).
      const mk = Math.min(1, Math.max(0, (st.reformAge - 0.05) / 0.12));
      st.prev0 = st.prev0 + (st.cur0 - st.prev0) * mk;
      st.prev1 = st.prev1 + (st.cur1 - st.prev1) * mk;
      st.cur0 = st.prev0 + reach * (multFor(st.base0, st.kickSteps) - st.prev0);
      st.cur1 = st.prev1 + reach * (multFor(st.base1, st.kickSteps) - st.prev1);
      st.kLv = reach;
      st.reforms++;
      st.reformI0 = ringPick(st.reforms + g[0] * 97);
      st.reformAge = 0;
    } else st.reformAge += dt;

    // Snare: re-threads the set picked by the count; its thread offset steps by 0.9 rad.
    if (morph.snares !== st.snares) {
      st.snares = morph.snares;
      st.sSet = morph.snares % 2;
      st.cPrev = st.cs[st.sSet];
      st.sLv = sq(morph.snareLevel);
      st.cs[st.sSet] = st.cPrev + 0.9 * st.sLv;
      st.sI0 = ringPick(morph.snares * 3.7 + g[0] * 53);
      st.sAge = 0;
    } else st.sAge += dt;

    // Melody: a note lights its place on the ring and sets the bend of the near guide.
    if (morph.notes !== st.notes) {
      st.notes = morph.notes;
      st.lAge = 0;
      st.lIdx = (0.5 + 0.5 * morph.notePitch) * 32;
      st.nLv = sq(morph.noteLevel);
      // The threads' lean colour turns toward the note's colour as far as the note is strong.
      st.hueP = st.hueN;
      let dh = (morph.notes * 0.618034 + g[2]) % 1 - st.hueN;
      dh -= Math.round(dh);
      st.hueN = (((st.hueN + st.nLv * dh) % 1) + 1) % 1;
      st.peT += st.nLv * (morph.notePitch - st.peT);
    } else st.lAge += dt;
    st.pe += (st.peT - st.pe) * (1 - Math.exp(-dt / 0.25));

    // Travel: the twists advance with the flow, and a drop rushes them.
    const dTr = Math.min(Math.max(morph.travel - st.tr, 0), 1);
    st.tr = morph.travel;
    const rush = 1 + 6 * morph.surge;
    st.phA += dTr * 0.5 * rush;
    st.phB0 += dTr * 0.4 * rush;
    st.phB1 -= dTr * 0.3 * rush;
    st.rot += dTr * 0.05 * rush;

    // Near guide A: radius, lobe depth (bent by the melody), height, twist.
    p[0] = wave(a[0], 0.6, 0.95);
    p[1] = wave(a[1], 0.06, 0.26) + 0.2 * st.pe;
    p[2] = wave(a[2], -0.95, -0.55);
    p[3] = st.phA;
    // Far guide for set 0 (near, warm).
    p[4] = wave(a[4], 0.45, 0.85);
    p[5] = wave(a[5], 0.04, 0.24);
    p[6] = wave(a[6], 0.15, 0.55);
    p[7] = st.phB0;
    // Far guide for set 1 (further back, cool).
    p[8] = wave(a[0] * 0.6 + a[4], 0.4, 0.9);
    p[9] = wave(a[3], 0.04, 0.24);
    p[10] = wave(a[7], 0.85, 1.25);
    p[11] = st.phB1;
    // Multipliers, previous and current, per set.
    p[12] = st.prev0;
    p[13] = st.cur0;
    p[14] = st.prev1;
    p[15] = st.cur1;
    // Kick front: age and origin; the thread offsets of both sets.
    // (with the kick's reach in hundredths above the age)
    p[16] = Math.min(st.reformAge, 9.99) + 10 * Math.round(st.kLv * 100);
    p[17] = st.reformI0;
    p[18] = st.cs[0];
    p[19] = st.cs[1];
    // Snare front: set, origin, age, and the offset before the re-thread.
    p[20] = st.sSet;
    p[21] = st.sI0;
    p[22] = Math.min(st.sAge, 9.99) + 10 * Math.round(st.sLv * 100);
    p[23] = st.cPrev;
    // Melody front and the re-threaded set's new offset.
    p[24] = st.cs[st.sSet];
    p[25] = Math.min(st.lAge, 9.99) + 10 * Math.round(st.nLv * 100);
    p[26] = st.lIdx;
    // The note colour, with the one before it in thousandths above it (the front sweeps one into the other).
    p[27] = Math.round(st.hueP * 1000) % 1000 + Math.min(st.hueN, 0.999);
    // View: zoom, turn; lobe counts packed 3 bits each (per cue); drive.
    p[28] = 0.85 + 0.12 * g[7];
    p[29] = st.rot;
    p[30] = (2 + Math.floor(g[2] * 4)) + 8 * (2 + Math.floor(g[4] * 4)) + 64 * (3 + Math.floor(g[5] * 4));
    p[31] = morph.drive;
  },
  wgsl: /* wgsl */ `
const SA_DC: f32 = 2.4;

// Saturated neon colour of the palette at t, luminance lvl, hue turned by rot.
fn sa_col(t: f32, lvl: f32, rot: f32) -> vec3f {
  let p = pal(t);
  let mx = max(p.r, max(p.g, p.b));
  let mn = min(p.r, min(p.g, p.b));
  let d = max(mx - mn, 1e-4);
  var h = select(select((p.r - p.g) / d + 4.0, (p.b - p.r) / d + 2.0, mx == p.g), (p.g - p.b) / d, mx == p.r);
  h = fract(h / 6.0);
  // Full saturation, and every hue peaks at the same channel level: a bright hue (yellow) would
  // otherwise climb into the tone curve's shoulder and read as pale, and a dark one (blue) as murk.
  let c = hsv2rgb(vec3f(fract(h + rot), 0.95, 1.0));
  return c * lvl * 0.6;
}

// A guide at parameter u: a lobed circle (k lobes) whose radius and height wave with the angle.
fn sa_g(u: f32, R: f32, e: f32, z0: f32, ph: f32, k: f32) -> vec3f {
  let a = k * u + ph;
  let r = R * (1.0 + e * cos(a));
  let ang = u + 0.5 * ph;
  return vec3f(r * cos(ang), r * sin(ang), z0 + 0.35 * R * sin(a));
}

// Pinhole projection, camera at z = -SA_DC looking down +z: straight 3D threads stay straight.
fn sa_proj(X: vec3f) -> vec2f { return X.xy * SA_DC / (X.z + SA_DC); }

// Event ages with each event's level squared in hundredths above them.
fn sa_age(v: f32) -> f32 { return v - 10.0 * floor(v / 10.0); }
fn sa_lv(v: f32) -> f32 { return floor(v / 10.0) * 0.01; }

// Distance around the 32-thread ring.
fn sa_cdist(a: f32, b: f32) -> f32 { let d = abs(a - b); return min(d, 32.0 - d); }

// Pixel distance to the segment a..b, and the position along it (0 at a, 1 at b).
fn sa_seg(p: vec2f, a: vec2f, b: vec2f, px: f32) -> vec2f {
  let ba = b - a;
  let h = clamp(dot(p - a, ba) / max(dot(ba, ba), 1e-10), 0.0, 1.0);
  return vec2f(length(p - a - ba * h) / px, h);
}

// Thin anti-aliased core plus a soft halo, both in pixels; nearer threads are thicker.
fn sa_line(dpx: f32, df: f32) -> f32 {
  let wpx = 0.6 + 0.5 * df;
  return clamp(wpx + 0.5 - dpx, 0.0, 1.0) + 0.22 * exp(-dpx / (3.0 + 4.0 * df));
}

// Light of one thread at pixel P, with the kick, snare and melody fronts that pass along it.
fn sa_thread(P: vec2f, px: f32, aP: vec2f, za: f32, PB: vec3f, t: f32, rot: f32, snareOn: f32, dK: f32, dS: f32, dL: f32) -> vec3f {
  let sg = sa_seg(P, aP, sa_proj(PB), px);
  let dpx = sg.x;
  let h = sg.y;
  if (dpx > 24.0) { return vec3f(0.0); }
  let df = SA_DC / (mix(za, PB.z, h) + SA_DC);
  let msk = sa_line(dpx, df);
  let kAge = sa_age(S.p[4].x);
  let sAge = sa_age(S.p[5].z);
  let lAge = sa_age(S.p[6].y);
  let drive = S.p[7].w;
  // Melody: the set's colour leans from the previous note colour to this one once its front has passed.
  let dLp = dL + 0.04 * h;
  let hN = fract(S.p[6].w);
  let lc = mix(sa_col(floor(S.p[6].w) * 0.001, 0.9, 0.0), sa_col(hN, 0.9, 0.0), smoothstep(0.0, 0.1, lAge - dLp));
  let bc = mix(sa_col(t, 0.85, rot), lc, 0.2);
  // Depth shades the thread a little (far is dimmer). Far threads stay bright enough that the tone
  // curve does not wash their hue toward grey.
  var col = bc * msk * (0.9 + 0.2 * drive) * (0.8 + 0.15 * min(df, 2.0));
  // Kick front: a hot edge running along the thread, then faint embers.
  let bK = kAge - (dK + 0.05 * h);
  let hot = smoothstep(-0.012, 0.0, bK) * exp(-max(bK, 0.0) / 0.03) * exp(-kAge / 0.9);
  let emb = smoothstep(-0.01, 0.0, bK) * exp(-max(bK, 0.0) / 0.6) * exp(-kAge / 0.8);
  let fc = mix(vec3f(1.0, 0.92, 0.75), vec3f(1.0, 0.42, 0.07), sat(max(bK, 0.0) / 0.06));
  col += (fc * hot * 2.2 + vec3f(1.0, 0.3, 0.05) * emb * 0.12) * msk * sa_lv(S.p[4].x);
  // Snare front on the re-threaded set: a cool electric spark.
  let bS = sAge - (dS + 0.05 * h);
  let sh = smoothstep(-0.012, 0.0, bS) * exp(-max(bS, 0.0) / 0.03) * exp(-sAge / 0.6);
  col += mix(sa_col(t + 0.25, 0.9, 0.5), vec3f(1.0), 0.12) * sh * 2.0 * msk * snareOn * sa_lv(S.p[5].z);
  // Melody front: the note's colour, lit where its pitch lands on the ring.
  let bL = lAge - dLp;
  let nh = smoothstep(-0.012, 0.0, bL) * exp(-max(bL, 0.0) / 0.04) * exp(-lAge / 0.5);
  col += mix(sa_col(hN, 0.9, 0.0), vec3f(1.0), 0.1) * nh * 2.0 * msk * sa_lv(S.p[6].y);
  return col;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let zoom = S.p[7].x;
  let P = rot2(S.p[7].y) * ((uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0)) * zoom;
  let px = 2.0 * zoom / F.res.y;
  let RA = S.p[0].x; let eA = S.p[0].y; let zA = S.p[0].z; let phA = S.p[0].w;
  let pk = u32(S.p[7].z);
  let kA = f32(pk & 7u); let kB0 = f32((pk >> 3u) & 7u); let kB1 = f32((pk >> 6u) & 7u);
  let prev0 = S.p[3].x; let cur0 = S.p[3].y; let prev1 = S.p[3].z; let cur1 = S.p[3].w;
  let kAge = sa_age(S.p[4].x); let kI0 = S.p[4].y; let cs0 = S.p[4].z; let cs1 = S.p[4].w;
  let sSet = S.p[5].x; let sI0 = S.p[5].y; let sAge = sa_age(S.p[5].z); let cPrev = S.p[5].w;
  let cNew = S.p[6].x; let lIdx = S.p[6].z;
  let t0 = F.seed * 0.8;
  var acc = vec3f(0.0);
  for (var i = 0; i < 32; i++) {
    let fi = f32(i);
    let u = TAU * (fi + 0.5) / 32.0;
    let jit = hash11(fi * 1.71 + F.seed * 19.0);
    let dK = 0.006 * sa_cdist(fi, kI0) + 0.01 * jit;
    let dS = 0.006 * sa_cdist(fi, sI0) + 0.01 * hash11(fi * 2.3 + 9.0);
    let dL = 0.006 * sa_cdist(fi, lIdx);
    let mk = smoothstep(0.0, 0.12, kAge - dK);
    let ms = smoothstep(0.0, 0.12, sAge - dS);
    let snareMix = mix(cPrev, cNew, ms);
    let PA = sa_g(u, RA, eA, zA, phA, kA);
    let aP = sa_proj(PA);
    let PB0 = sa_g(mix(prev0, cur0, mk) * u + select(cs0, snareMix, sSet < 0.5), S.p[1].x, S.p[1].y, S.p[1].z, S.p[1].w, kB0);
    let PB1 = sa_g(mix(prev1, cur1, mk) * u + select(cs1, snareMix, sSet > 0.5), S.p[2].x, S.p[2].y, S.p[2].z, S.p[2].w, kB1);
    acc += sa_thread(P, px, aP, PA.z, PB0, t0 + 0.12 * jit, 0.0, select(0.0, 1.0, sSet < 0.5), dK, dS, dL);
    acc += sa_thread(P, px, aP, PA.z, PB1, t0 + 0.12 * jit, 0.5, select(0.0, 1.0, sSet > 0.5), dK, dS, dL);
  }
  acc += sa_col(t0 + 0.25, 0.01, 0.0);
  let pm = max(acc.r, max(acc.g, acc.b));
  // Hue-preserving roll-off: a crossing of threads stays saturated instead of clipping toward white.
  return vec4f(acc / (1.0 + 1.2 * max(pm - 0.4, 0.0)), 1.0);
}
`,
});
