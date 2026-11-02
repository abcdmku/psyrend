import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';
import { Spring } from '../anim';

/**
 * The fine phase (RULES v7) integrated with the air of the mix: it moves as the detail layer and the
 * high notes say, faster with more air (about as given at typical air), and only faintly in a bare
 * passage, so a high note over near silence re-forms the fine detail gently instead of jolting it.
 * A critically damped spring (half-life 0.07 s) eases each high note's step in, so the finest veins
 * re-form smoothly. A jump (new cue or seek) restarts it where the raw phase is.
 */
class FinePhase {
  x = 0;
  private last = NaN;
  private ease = new Spring(0, 0.07);
  update(raw: number, air: number, dt: number): number {
    if (!(Math.abs(raw - this.last) < 2)) {
      this.x = raw;
      this.ease.reset(raw);
    } else this.x += (raw - this.last) * (0.1 + 1.8 * air);
    this.last = raw;
    return this.ease.update(this.x, dt);
  }
}
const finePhase = new FinePhase();


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
 * The strength side of a front: each event adds its level (0..1) to a sum that eases in exactly like
 * the count glide, and the latest level follows on a quick spring. The lasting state behind a front,
 * sum + level * (phase state - count), then steps by that event's level (a faint hit a faint change),
 * and it is continuous however the levels and fronts overlap.
 */
class Strength {
  readonly sum: Glide;
  readonly level = new Spring(0, 0.06);
  private total = 0;
  private n = 0;
  constructor(dur: number) {
    this.sum = new Glide(0, dur);
  }
  reset(events: number, morphLevel: number): void {
    this.n = events;
    this.total = 0;
    this.sum.reset(0);
    this.level.reset(morphLevel * morphLevel);
  }
  update(events: number, morphLevel: number, dt: number): void {
    // Squared: the reaction rises from nothing as softly as the hit does, so a faint hit in a quiet
    // passage is a faint ripple and a hard hit the full change.
    const level = morphLevel * morphLevel;
    if (events > this.n) this.total += (events - this.n) * level;
    this.n = events;
    this.sum.update(this.total, dt);
    this.level.update(level, dt);
  }
}


/**
 * Marble Flow: glossy neon liquid marble on black (ref05), fragment-only.
 *
 * The field is an endless zoom: three octaves of a warped, twisted height with its own stripe or
 * ring bands (each octave its own noise slice), sampled around a slowly drifting centre at
 * zoomScale and blended by zoomWeight, so as the zoom level grows with morph.travel each octave
 * magnifies, the finest fades in with new veins and the coarsest fades out. Its level sets are drawn as glossy tubes of neon ink: each band is a cylinder in
 * cross-section (the normal comes analytically from the band's signed distance and the field
 * gradient), lit by a key light, with a white-hot core, a thin rainbow film at its grazing edges
 * and a coloured halo spilling into the black. Widths are measured in pixels through the gradient,
 * so lines stay crisp and anti-aliased at any density; bands finer than ~4 px fade to their mean.
 * The fine phase (high notes, backing, hats, the air of the mix) moves each octave through its
 * noise in proportion to its scale and displaces the point at screen-fine scale before the octave
 * scaling, so the high end re-forms the finest structure most.
 *
 * Music:
 *  - morph: warp strengths, frequency, twist and band density flow continuously (kicks and snares
 *    step them for good); the noise evolves along `morph.travel`.
 *  - kick: ignites the ink at a new point (a golden-angle walk); the fire runs along the bands
 *    first (bands conduct, black gaps resist, each band catches with its own delay), a white to
 *    orange edge with embers behind, and every band it passes takes the next palette colour.
 *  - snare: an electric front in a second colour sweeps from a line; behind it the band widths
 *    are re-dealt (thick tubes thin out, hairlines swell): new detail.
 *  - melody: each note's front leaves the melody bands in the note's colour (pitch and centroid),
 *    from an emitter placed by pitch; the spectrum history streams out of the emitter along those
 *    bands (sound makes the ink brighter where it flows).
 * Every front rides a glide that follows its event count (each hit eases in by smoothstep over 0.6 s for kicks, 0.9 s for snares and notes): it swells in from rest
 * with a soft edge, and the state it leaves eases in, however close the hits come. Nothing snaps.
 */

const SHADER = /* wgsl */ `
fn mf_chroma(c: vec3f) -> f32 {
  let hi = max(c.r, max(c.g, c.b));
  return (hi - min(c.r, min(c.g, c.b))) / max(hi, 1e-4);
}
fn mf_hrot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}
// Saturated ink normalised to its brightest channel, cycling the palette's coloured entries; a grey
// entry is replaced by the most colourful one turned round the hue circle.
fn mf_ink(h: f32) -> vec3f {
  let c0 = F.pal1.rgb;
  let c1 = F.pal2.rgb;
  let c2 = F.pal3.rgb;
  let s0 = mf_chroma(c0);
  let s1 = mf_chroma(c1);
  let s2 = mf_chroma(c2);
  var best = c0;
  var sb = s0;
  if (s1 > sb) { best = c1; sb = s1; }
  if (s2 > sb) { best = c2; }
  let k0 = mix(mf_hrot(best, 2.1), c0, smoothstep(0.15, 0.35, s0));
  let k1 = mix(mf_hrot(best, -2.1), c1, smoothstep(0.15, 0.35, s1));
  let k2a = mix(mf_hrot(best, 1.0), c2, smoothstep(0.15, 0.35, s2));
  // The third ink is the accent: if the palette's hues all sit close together (a warm or a cold
  // scheme), it turns well away round the circle, so every frame has a contrasting hue.
  let ch0 = k0 - dot(k0, vec3f(0.3333));
  let ch1 = k1 - dot(k1, vec3f(0.3333));
  let ch2 = k2a - dot(k2a, vec3f(0.3333));
  let near = max(dot(ch0, ch2) / max(length(ch0) * length(ch2), 1e-4), dot(ch1, ch2) / max(length(ch1) * length(ch2), 1e-4));
  let k2 = mix(k2a, max(mf_hrot(k0, 2.4), vec3f(0.0)), smoothstep(0.3, 0.8, near));
  let x = fract(h) * 3.0;
  let f = smoothstep(0.0, 1.0, fract(x));
  let c = max(select(select(mix(k2, k0, f), mix(k1, k2, f), x < 2.0), mix(k0, k1, f), x < 1.0), vec3f(0.0));
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let n = (c - lo) / max(hi - lo, 1e-4);
  return mix(vec3f(1.0), n, 0.97);
}

// One octave of the marble in its own space q: a warped, twisted height with its own bands (a
// periodic stripe or ring term) and its own noise slice per octave id, so every octave brings real
// structure at its own scale. cheap = hardware-filtered height (for front origins only).
fn mf_oct(q: vec2f, id: f32, s: f32, cheap: bool) -> f32 {
  let hs = hash11(id * 7.31 + F.seed * 13.0 + 0.5);
  let hv = hash11(id * 3.17 + F.seed * 5.0 + 1.5);
  // The fine phase (high notes, backing, hats) moves each octave through its noise by its scale:
  // the finest structure re-forms most, the large flow least (continuous across the zoom wrap).
  let zo = S.p[1].x + hs * 48.0 + S.p[3].z * (0.03 + 0.1 * s);
  let qa = q * S.p[0].z;
  let wv = noise4(vec3f(qa + vec2f(5.2, 1.3), zo)).xy;
  let q2 = qa + S.p[0].x * 0.42 * wv;
  let d = q2 - (S.p[2].xy + vec2f(hs - 0.5, hv - 0.5) * 0.9) * S.p[0].z;
  let tw = rot2(S.p[0].w * exp(-dot(d, d) / (S.p[1].w * 4.0))) * d;
  var nz: vec2f;
  if (cheap) { nz = noise4fast(vec3f(tw * 0.9 + 3.1, zo + 9.0)).xy; }
  else { nz = noise4(vec3f(tw * 0.9 + 3.1, zo + 9.0)).xy; }
  let ang = S.p[2].z + hv * 6.283;
  let st = mix(dot(tw, vec2f(cos(ang), sin(ang))), length(tw) * 1.3, S.p[1].z);
  return nz.x * 0.75 + 0.5 * sin(st * 2.6 + nz.y * S.p[0].y * 6.0);
}

// The zoom centre drifts slowly with the zoom level.
fn mf_centre(z: f32) -> vec2f {
  return vec2f(0.3 * sin(z * 0.37 + F.seed * 6.0), 0.2 * cos(z * 0.29 + F.seed * 4.0));
}

// The marble at view point p: three octaves of mf_oct around the drifting zoom centre, blended by
// zoomWeight. As z grows each octave magnifies, the finest fades in and the coarsest out: an endless
// zoom that keeps finding new veins. An octave's height scales as 1/sqrt(s), so finer octaves still
// bring their own fine lines. The high end's fine displacement is applied before the octave scaling,
// so it lands hardest on the finest octave (and is continuous across the zoom wrap).
fn mf_field(pv: vec2f, cheap: bool) -> f32 {
  let z = S.p[3].x;
  let c = mf_centre(z);
  var p = pv;
  if (!cheap) {
    let fine = noise4(vec3f(pv * 9.0 + vec2f(1.7, 9.2), S.p[3].z * 0.6)).xy;
    p += 0.016 * fine;
  }
  var f = 0.0;
  for (var i = 0; i < 3; i++) {
    let s = zoomScale(z, i);
    let q = (p - c) * (s * 1.3);
    f += zoomWeight(z, i) * inverseSqrt(s) * mf_oct(q, zoomOctaveId(z, i), s, cheap);
  }
  return f;
}
fn mf_view(sp: vec2f) -> vec2f { return rot2(S.p[2].w) * sp; }

fn mf_width(b: f32, n: f32) -> f32 {
  let h = hash12(vec2f(b * 1.37 + F.seed * 17.0, n * 7.13 + 3.0));
  return mix(0.035, 0.42, pow(h, 1.7));
}

// Phase fronts. x follows an event count, each event easing in by smoothstep over 0.9 s (about two beats) (from rest, one unit per
// event, however close the events come); tau in [0, 0.5] the point's arrival fraction. Returns
// (state, u): the lasting state steps by 1 per event, eased in as the front passes; u is how far the
// front has gone past (0..1, at least 0.5 at rest). Continuous in x, so nothing can snap.
fn mf_phase(x: f32, tau: f32) -> vec2f {
  let y = x - tau;
  let u = fract(y);
  return vec2f(floor(y) + smoothstep(0.0, 0.5, u), u);
}
// A soft bump on 0 < u < h: the glow at the front.
fn mf_bump(u: f32, h: f32) -> f32 { let s = sin(PI * min(u / h, 1.0)); return s * s; }
// Arrival time to arrival fraction: the fire catches fast near its origin and slows as it spreads.
fn mf_tau(t: f32) -> f32 { return 0.5 * (1.0 - exp(-t / 1.0)); }

// Arrival time of a front lit at a point on band level xo: fire runs along its own band almost
// freely and crosses to the next band at a cost, slower through the black gaps than through ink,
// and each band catches with its own small delay. The result is a ragged, fibrous front.
fn mf_arrive(x: f32, xo: f32, d: f32, lag: f32, jag: f32) -> f32 {
  return (0.055 * abs(x - xo) + 0.42 * d) * lag + jag;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let sp = (uv - 0.5) * vec2f(F.aspect, 1.0);
  let p = mf_view(sp);
  let px = 1.0 / F.res.y;
  let f0 = mf_field(p, false);
  let K = S.p[1].y;
  // Field gradient from the pixel quad (the field is evaluated once per pixel): solve g.dp = df.
  let dfx = dpdxFine(f0);
  let dfy = dpdyFine(f0);
  let dpx = dpdxFine(p);
  let dpy = dpdyFine(p);
  let det = dpx.x * dpy.y - dpx.y * dpy.x;
  let grad = vec2f(dfx * dpy.y - dfy * dpx.y, dpx.x * dfy - dpy.x * dfx) / det * K;
  let gl = max(length(grad), 1e-4);
  let nd = grad / gl;
  let x = f0 * K;
  let fw = gl * px;           // one pixel in band units
  let bi = floor(x);
  let fr = x - bi;

  let cond = 1.0 - abs(fr - 0.5) * 2.0;
  let lag = 1.25 - 0.4 * smoothstep(0.2, 0.9, cond);
  let jag = 0.05 * hash12(vec2f(bi, F.seed * 31.0));

  // Kick front from a gliding point (S.p[4] = origin, phase).
  let K0 = S.p[4];
  let pK = mf_phase(K0.z, mf_tau(mf_arrive(x, mf_field(mf_view(K0.xy), true) * K, length(sp - K0.xy), lag, jag)));
  // Lasting states step by each event's level: sum + level * (phase state - count).
  let kickState = S.p[5].x + S.p[4].w * (pK.x - K0.z);
  // Snare: an electric front from a line through its point, its angle turning with each snare.
  let SN = S.p[6];
  let sa = SN.z * 1.94 + F.seed * 6.0;
  let sn = vec2f(cos(sa), sin(sa));
  let pS = mf_phase(SN.z, mf_tau(mf_arrive(x, mf_field(mf_view(SN.xy), true) * K, abs(dot(sp - SN.xy, sn)), lag, jag * 0.6)));
  let sState = S.p[5].y + S.p[5].z * (pS.x - SN.z);
  let sN = floor(sState);
  let snarePass = sState - sN;
  // Melody: the note's front from the emitter (S.p[7] = emitter, phase, pitch).
  let NT = S.p[7];
  let de = length(sp - NT.xy);
  let pN = mf_phase(NT.z, mf_tau(mf_arrive(x, mf_field(mf_view(NT.xy), true) * K, de, lag, jag * 1.4)));
  let nState = S.p[5].w + S.p[6].w * (pN.x - NT.z);
  let nN = floor(nState);
  let notePass = nState - nN;
  // Each note steps the melody ink round the palette (by its level), shaded by the (gliding) pitch.
  let noteHue = S.p[3].w + nState * 0.29 + NT.w * 0.25;

  // Bands: three nearest tubes (each a glossy cylinder), their halos, and the dark between.
  let L = normalize(vec3f(-0.45, -0.55, 0.7));
  let Hv = normalize(L + vec3f(0.0, 0.0, 1.0));
  let detail = 1.0 - smoothstep(0.12, 0.3, fw);
  var col = vec3f(0.0);
  var cov = 0.0;
  var halo = vec3f(0.0);
  var tube = 0.0;
  for (var j = -1; j <= 1; j++) {
    let b = bi + f32(j);
    let dfr = x - (b + 0.5);
    let mel = select(0.0, 1.0, fmod(b + floor(F.seed * 3.0), 3.0) < 0.5);
    // Snares re-deal the widths and brightness of the bands; notes re-deal the melody bands.
    var rho = mix(mf_width(b, sN), mf_width(b, sN + 1.0), snarePass);
    rho = mix(rho, mix(mf_width(b, nN * 7.0 + 0.5), mf_width(b, nN * 7.0 + 7.5), notePass), mel);
    // Cap the physical width: where the field is slack the bands stay lines, never blobs.
    rho = min(rho, 0.03 * gl);
    let rr = max(rho, fw * 0.75);
    let c = smoothstep(rr + fw * 0.7, rr - fw * 0.7, abs(dfr)) * min(1.0, rho / rr);
    let accent = step(0.78, hash12(vec2f(b * 0.71, F.seed * 5.0)));
    let hue = F.seed * 0.7 + b * 0.09 + accent * 0.5 + kickState * 0.333;
    let ink = max(mf_hrot(mix(mf_ink(hue), mf_ink(noteHue), mel * 0.9), (hash12(vec2f(b, 3.3 + F.seed)) - 0.5) * 0.7), vec3f(0.0));
    // The sound's ink: the melody bands carry the spectrum history out of the emitter.
    let flowAge = de / 1.2;
    let emitted = hist(fract(b * 0.137 + 0.1), flowAge * 0.25) * smoothstep(4.0, 1.5, flowAge);
    let lum = mix(0.22, 0.62, mix(hash12(vec2f(b * 2.1, 9.0 + F.seed + sN)), hash12(vec2f(b * 2.1, 10.0 + F.seed + sN)), snarePass)) * (1.0 + mel * 1.3 * emitted);
    let s = clamp(dfr / rr, -1.0, 1.0);
    let nz = sqrt(max(1.0 - s * s, 0.0));
    let N = vec3f(nd * s, nz);
    let ndl = max(dot(N, L), 0.0);
    let ndh = max(dot(N, Hv), 0.0);
    let core = pow(nz, 14.0);
    // Dark glass body, light gathered at the rims (liquid neon, not plastic), a faint core line.
    let rim = pow(1.0 - nz, 1.6);
    var body = ink * lum * (0.1 + 0.4 * ndl + 1.5 * rim) + mix(ink, vec3f(1.0), 0.1) * core * lum * 0.25;
    let rainbow = 0.5 + 0.5 * cos(TAU * (s * 0.7 + b * 0.13 + vec3f(0.0, 0.33, 0.67)));
    body += rainbow * pow(1.0 - nz, 2.5) * 0.35 * lum;
    body += mix(vec3f(1.0), ink, 0.55) * (pow(ndh, 120.0) * 1.2 + pow(ndh, 24.0) * 0.08);
    col += body * c * detail;
    cov += c * detail;
    halo += ink * lum * exp(-max(abs(dfr) - rr, 0.0) / 0.08) * 0.1;
    tube = max(tube, c);
  }
  cov = min(cov, 1.0);
  // Where the bands are finer than a few pixels they merge into their mean glow.
  let mean = mf_ink(F.seed * 0.7 + bi * 0.09 + kickState * 0.333) * 0.07;
  let gap = palL(F.seed + 0.6, 0.004) + halo * detail + mean * (1.0 - detail);
  let vig = 1.0 - 0.35 * dot(uv - 0.5, uv - 0.5) * 2.0;
  var c = (gap * (1.0 - cov) + col) * vig;

  // Fire on the fibres: the hot edge of each front, then embers, faded with the front's age.
  let fm = tube + 0.06 * (1.0 - tube);
  // Each swells and fades as its front passes: a soft edge, never cut off by the next hit.
  let fire0 = mf_bump(pK.y, 0.45);
  let ember0 = mf_bump(pK.y, 0.5);
  let fireC = mix(vec3f(1.0, 0.92, 0.75), vec3f(1.0, 0.42, 0.07), smoothstep(0.05, 0.25, pK.y));
  // Each front's light scales with its event's level: a faint hit a faint glow.
  var glow = (fireC * fire0 * 0.75 + vec3f(1.0, 0.28, 0.04) * ember0 * 0.3) * fm * S.p[4].w;
  let sparkS = mf_bump(pS.y, 0.45);
  glow += mix(mf_ink(F.seed * 0.7 + 0.5 + sState * 0.21), vec3f(1.0), 0.45) * sparkS * 1.1 * fm * S.p[5].z;
  let sparkN = mf_bump(pN.y, 0.45);
  glow += mix(mf_ink(noteHue), vec3f(1.0), 0.3) * sparkN * 1.1 * fm * S.p[6].w;
  // Fronts that meet add their light softly (a faint glow stays linear), so a hard kick and snare
  // landing together brighten the fibres without flashing them.
  c += glow / (1.0 + 1.2 * max(glow.r, max(glow.g, glow.b)));
  return vec4f(c, 1.0);
}
`;

const morph = new Morph(1);
/** Glides following the kick, snare and note counts since the seed (the fronts' phases), and the pitch. */
const st = { seed: -1, xk: new Glide(0, 0.6), xs: new Glide(0, 0.9), xl: new Glide(0, 0.9), pitch: new Spring(0, 0.2), pitchT: 0, ln: 0, k0: 0, s0: 0, l0: 0 };
/** The fronts' strengths (level sums and recent levels) for kick, snare and melody. */
const str = { k: new Strength(0.6), s: new Strength(0.9), l: new Strength(0.9) };

export default raymarchScene({
  meta: {
    id: 'marble-flow',
    name: 'Marble Flow',
    energy: [0, 1],
    mood: { valence: 0.55, arousal: 0.5 },
    genres: { ambient: 0.9, edm: 0.9, techno: 0.8, synthwave: 0.9, pop: 0.8, lofi: 0.8, jazz: 0.7, classical: 0.6, dubstep: 0.7, dnb: 0.7, hiphop: 0.7, rock: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    // The zoom carries much of the steady motion, so the morph's flow runs at half reach while the
    // beat steps (at - flowAt) run a little larger: a calmer base that the hits stand out from.
    const a = Array.from(morph.at, (v, i) => 0.5 * morph.flowAt[i] + 1.3 * (v - morph.flowAt[i]));
    const aspect = 16 / 9;
    if (g[0] !== st.seed || morph.kicks < st.k0 || morph.snares < st.s0 || morph.notes < st.l0) {
      st.seed = g[0];
      st.k0 = morph.kicks;
      st.s0 = morph.snares;
      st.l0 = morph.notes;
      st.xk.reset(0);
      st.xs.reset(0);
      st.xl.reset(0);
      st.pitchT = Math.max(-1.2, Math.min(1.2, morph.notePitch));
      st.pitch.reset(st.pitchT);
      st.ln = morph.notes;
      str.k.reset(morph.kicks, morph.kickLevel);
      str.s.reset(morph.snares, morph.snareLevel);
      str.l.reset(morph.notes, morph.noteLevel);
    }
    str.k.update(morph.kicks, morph.kickLevel, dt);
    str.s.update(morph.snares, morph.snareLevel, dt);
    str.l.update(morph.notes, morph.noteLevel, dt);
    // Front phases: glides that follow the event counts, so every front and step glides in from rest.
    const xk = st.xk.update(morph.kicks - st.k0, dt);
    const xs = st.xs.update(morph.snares - st.s0, dt);
    const xl = st.xl.update(morph.notes - st.l0, dt);
    // Each note moves the emitter and the note colour toward its pitch by its level (squared, as the fronts).
    if (morph.notes > st.ln) st.pitchT += (Math.max(-1.2, Math.min(1.2, morph.notePitch)) - st.pitchT) * morph.noteLevel ** 2;
    st.ln = morph.notes;
    const pitch = st.pitch.update(st.pitchT, dt);

    const tr = morph.travel;
    // Form (S.p[0..2]).
    p[0] = wave(a[0], 1.0, 2.6); // inner warp
    p[1] = wave(a[1], 0.2, 0.4); // outer warp
    p[2] = wave(a[2], 0.7, 1.35); // noise frequency
    p[3] = (g[1] > 0.5 ? 1 : -1) * wave(a[4], 1.5, 5.0); // vortex twist
    p[4] = tr * 0.08 + g[3] * 40; // noise evolution
    p[5] = wave(a[3], 7, 11) * (0.8 + 0.4 * g[7]); // bands per unit
    p[6] = wave(a[7] * 0.7 + g[6] * 6, 0.0, 0.85); // stripes vs rings
    p[7] = wave(a[5], 0.05, 0.22); // vortex size
    p[8] = 0.45 * Math.sin(a[5] * 0.6 + g[4] * 6);
    p[9] = 0.25 * Math.sin(a[6] * 0.55 + g[5] * 6);
    p[10] = a[6] * 0.25 + g[0] * 6.283; // stripe direction
    p[11] = tr * 0.012 + g[1] * 6.283; // slow turn
    // Zoom level in octaves (S.p[3].x): grows with travel, so a drop rushes deeper. The centre
    // drifts in the shader from z. S.p[3].y is spare.
    p[12] = tr * 0.4 + g[3] * 7;
    p[13] = 0;
    // Fine phase: the detail layer flows it, each high note steps it by its level (eased by the morph).
    p[14] = finePhase.update(0.4 * morph.detailAt[0] + 3.0 * morph.upperPhase + 0.5 * morph.backingPhase + 0.25 * morph.hatPhase, morph.detailDrive, dt);
    p[15] = g[2] + 0.5;
    // Fronts: origins glide with their phases. Kicks walk a golden-angle spiral, snares sweep from a
    // line through a wandering point, the melody's emitter sits where the pitch says.
    const ka = g[4] * 6.283 + 2.39996 * xk;
    const kr = Math.sqrt(0.5 + 0.35 * Math.sin(xk * 1.7 + g[4] * 6));
    // Each front's strength: the level sums (S.p[5].xyw) and the recent levels (S.p[4].w, S.p[5].z, S.p[6].w).
    p.set([Math.cos(ka) * kr * aspect * 0.42, Math.sin(ka) * kr * 0.42, xk, str.k.level.x], 16);
    p.set([str.k.sum.x, str.s.sum.x, str.s.level.x, str.l.sum.x], 20);
    p.set([0.35 * Math.sin(xs * 2.7 + g[5] * 6), 0.2 * Math.cos(xs * 1.9), xs, str.l.level.x], 24);
    p.set([pitch * aspect * 0.32, 0.22 * Math.sin(a[6] * 0.8 + g[6] * 6), xl, pitch], 28);
  },
  wgsl: SHADER,
});
