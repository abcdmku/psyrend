import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * The fine phase (RULES v7) integrated with the air of the mix: it moves as the detail layer and the
 * high notes say, faster with more air (about as given at typical air), and only faintly in a bare
 * passage, so a high note over near silence re-forms the fine detail gently instead of jolting it.
 * A jump (new cue or seek) restarts it where the raw phase is.
 */
class FinePhase {
  x = 0;
  private last = NaN;
  update(raw: number, air: number): number {
    if (!(Math.abs(raw - this.last) < 2)) this.x = raw;
    else this.x += (raw - this.last) * (0.1 + 1.8 * air);
    this.last = raw;
    return this.x;
  }
}
const finePhase = new FinePhase();


/**
 * Neon Contours: many parallel luminous lines riding a morphing height field (ref16). The field is
 * two plane waves (their interference gives the ridges), a swirl (arms and rings round a vortex in
 * front of the camera). The lines are the rows of constant z across the sheet, so they bunch where the
 * slope turns toward the view and spread where it falls away. Each pixel ray-marches the sheet, takes
 * the row coordinate s = z / spacing of the surface point it hits, and anti-aliases the rows by
 * fwidth(s): rows that would be under a pixel fade to their mean instead of shimmering.
 *
 * The flow is the sheet itself: the waves travel toward the camera with the travel clock (faster on
 * the bass and the drops), and the lines keep their identity as they pass, so each line carries its
 * own colour and width. The morph reshapes the waves, the swirl, the spacing, the camera's height,
 * pitch and roll each phrase; chords lean it through the morph.
 *  - kick: a hot front sweeps across from a point that changes each kick; each line runs it at its own
 *    pace, and behind it the palette steps for good.
 *  - snare: a cool crackle from the opposite edge; behind it every line takes a new width (the sheet is
 *    re-cut from thin hairlines to thick tubes).
 *  - melody: the note lights from the screen height its pitch picks; behind it the sheet takes the
 *    note's hue. Each note also steps the field itself (the first wave turns, the second's height
 *    changes), gliding in on a critically damped spring (from rest, settled in about half a second) and held
 *    until the next note.
 * Fronts are timed in screen x and sweep across the frame in about 0.1 s, but each pixel eases into
 * its new state on a critically damped curve (from rest, settled in about 0.3 s), so a front is a soft
 * gradient, and the hot edges rise from rest and cool within about 0.3 s. The previous kick and note fronts are kept so their changes finish.
 *
 * DNA: 0 start, 1 phase, 2 swirl arms, 3 palette, 4 spacing, 5 wave sense, 6 roll sense, 7 swirl sense.
 */

const morph = new Morph(0.9);
const st = {
  seed: -1, n: -1, k: -1, cur: 0, prev: 0, older: 0, tr: 0, sc: 0, v: 0,
  rot: 0, rotV: 0, rotT: 0, amp: 1, ampV: 0, ampT: 1, drive: 0, driveV: 0, surge: 0, surgeV: 0,
  kAge: 9, kPrev: 9, lAge: 9, lPrev: 9,
  /**
   * Strengths: the latest and previous kick's, the kicks' sum before those two, the latest snare's,
   * the snares' sum before it, and the latest and previous note's.
   */
  kL: 0, kLp: 0, kSum: 0, sL: 0, sSum: 0, sn: -1, lL: 0, lLp: 0,
};

/** Reaction strength from the morph's event level: squared, so it rises from nothing as softly as the hit. */
const strength = (level: number) => level * level;
/** A 0..1 value as an n-bit integer, for packing. */
const qb = (x: number, bits: number) => Math.round(Math.min(1, Math.max(0, x)) * (2 ** bits - 1));

/** One step of a critically damped spring toward `target`: starts from rest, never overshoots. */
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}

export default raymarchScene({
  meta: {
    id: 'neon-contours',
    name: 'Neon Contours',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.6 },
    genres: { edm: 0.8, synthwave: 0.9, techno: 0.7, ambient: 0.8, pop: 0.7, dnb: 0.6, classical: 0.5, hiphop: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    if (g[0] !== st.seed || morph.notes < st.n) {
      st.seed = g[0];
      st.n = morph.notes;
      st.cur = st.prev = st.older = morph.notePitch;
      st.k = morph.kicks;
      st.tr = morph.travel;
      st.sc = 0;
      st.v = 0;
      st.rot = st.rotT = st.rotV = 0;
      st.amp = st.ampT = 1;
      st.ampV = 0;
      st.drive = morph.drive;
      st.surge = morph.surge;
      st.driveV = st.surgeV = 0;
      st.kAge = st.kPrev = st.lAge = st.lPrev = 9;
      st.kL = st.kLp = st.kSum = st.sL = st.sSum = st.lL = st.lLp = 0;
      st.sn = morph.snares;
    }
    const dt = Math.max(ctx.dt, 1e-3);
    // Ages of the latest and the previous kick and note (the previous one is still drawn while it cools).
    if (morph.kicks !== st.k) {
      st.k = morph.kicks;
      st.kPrev = st.kAge + dt;
      st.kSum += st.kLp;
      st.kLp = st.kL;
      st.kL = strength(morph.kickLevel);
    } else st.kPrev = Math.min(9, st.kPrev + dt);
    st.kAge = morph.kickAge;
    if (morph.snares !== st.sn) {
      st.sn = morph.snares;
      st.sSum += st.sL;
      st.sL = strength(morph.snareLevel);
    }
    if (morph.notes !== st.n) {
      // Each note moves the pitch the sheet follows toward its own by its strength.
      const lv = strength(morph.noteLevel);
      st.lLp = st.lL;
      st.lL = lv;
      st.older = st.prev;
      st.prev = st.cur;
      st.cur = st.prev + (morph.notePitch - st.prev) * lv;
      st.n = morph.notes;
      st.lPrev = st.lAge + dt;
      // Each note steps the field: the ridge direction turns and the second wave's height changes,
      // both set by the note's pitch (and a swing that alternates per note), by its strength, and
      // held until the next note.
      st.rotT += (0.9 * morph.notePitch + (morph.notes % 2 ? 0.35 : -0.35) - st.rotT) * lv;
      st.ampT += (1 + 0.5 * morph.notePitch - st.ampT) * lv;
    } else st.lPrev = Math.min(9, st.lPrev + dt);
    st.lAge = morph.leadAge;
    // The melody's shape step glides in from rest on a critically damped spring (settled in about
    // half a second); drive and surge glide more slowly.
    const beat = 60 / Math.max(40, m.bpm);
    const w = 6 / Math.max(0.3, beat * 1.3);
    [st.rot, st.rotV] = spring(st.rot, st.rotV, st.rotT, 11, dt);
    [st.amp, st.ampV] = spring(st.amp, st.ampV, st.ampT, 11, dt);
    [st.drive, st.driveV] = spring(st.drive, st.driveV, morph.drive, w, dt);
    [st.surge, st.surgeV] = spring(st.surge, st.surgeV, morph.surge, w * 0.5, dt);
    // The sheet flows toward the camera at the travel pace, eased so the bass wobble does not jitter it;
    // a drop rushes it.
    const dTr = Math.min(Math.max(morph.travel - st.tr, 0), 1);
    st.tr = morph.travel;
    st.v += (dTr / dt - st.v) * (1 - Math.exp(-dt / 0.4));
    // Half the travel pace: the flow stays fluid but calm enough that the beats stand out against it.
    st.sc += 0.5 * st.v * dt * (1 + 6 * st.surge);

    const amp = 1 + 0.25 * st.drive;
    const sense = g[5] < 0.5 ? -1 : 1;
    // Two plane waves (ridges where they interfere).
    p[0] = wave(a[0], 0.08, 0.3) * amp;
    // The first wave's direction turns with the melody's eased step.
    const kx1 = wave(a[1], -2.6, 2.6);
    const kz1 = sense * wave(a[2], 0.3, 2.4);
    const cr = Math.cos(st.rot);
    const sr = Math.sin(st.rot);
    p[1] = kx1 * cr - kz1 * sr;
    p[2] = kx1 * sr + kz1 * cr;
    p[3] = 0.5 * a[0] + 6.283 * g[1];
    p[4] = wave(a[3], 0.05, 0.24) * amp * st.amp;
    p[5] = wave(a[4], -2.4, 2.4);
    p[6] = wave(a[5], -2.4, 2.4);
    p[7] = 0.5 * a[3];
    // The swirl: amplitude, centre in front of the camera, ring frequency.
    p[8] = wave(a[6], 0.0, 0.28) * amp;
    p[9] = wave(a[7], -2.4, 2.4);
    p[10] = wave(a[2] * 0.5 + a[5] * 0.5, 2.5, 9.0);
    p[11] = wave(a[6] * 0.5 + a[3] * 0.5, 0.8, 4.0) * (g[7] < 0.5 ? -1 : 1);
    // Arms (integer, so the swirl closes), camera height, pitch (rad, down) and roll (rad).
    // Arms (integer part) and the glow (fraction, 0.8..1.2).
    p[12] = 2 + Math.floor(g[2] * 4) + 0.999 * Math.min(1, m.energySlow * morph.flow);
    // The phrase framing (morph.cam) rides on top: a wider lens tips the view down a little so the
    // horizon stays put; height rises more than it sinks (clearance over the ridges).
    const cam = morph.cam;
    const focal = Math.min(2.2, Math.max(0.62, 1.25 / cam.fov));
    p[13] = wave(a[7] * 0.5, 1.3, 2.1) + 0.45 * cam.height + 0.35;
    p[14] = Math.max(0.1, wave(a[4] * 0.3, 0.12, 0.5) + 0.6 * cam.pitch + 0.35 * (1.25 / focal - 1));
    // Roll (integer part, 1/4096 rad) and yaw (fraction) share a slot.
    const roll = wave(a[6] * 0.4, -0.4, 0.4) + 0.6 * cam.roll;
    const yaw = Math.max(-0.35, Math.min(0.35, 0.7 * cam.yaw));
    p[15] = Math.round((roll + 2) * 4096) + 0.999 * (yaw / 0.7 + 0.5);
    // Scroll, line spacing, palette, glow.
    p[16] = st.sc;
    p[17] = wave(a[1] * 0.25 + a[7] * 0.2, 0.2, 0.42);
    // Palette, plus the kicks' hue steps (by strength) before the two still drawn.
    p[18] = g[3] + 0.36 * st.kSum;
    // Fine scale from the high end (RULES v7): a phase the detail layer flows and each high note,
    // backing chord and hat steps (by level, eased by the morph). It winds the lines.
    p[19] = finePhase.update(1.2 * morph.detailAt[0] + 1.3 * morph.upperPhase + 0.5 * morph.backingPhase + 0.25 * morph.hatPhase, morph.detailDrive);
    // Event ages and counts; melody pitches (new, old).
    p[20] = Math.min(morph.kickAge, 9);
    // Kick count (10 bits) and the latest and previous note's strengths (7 bits each).
    p[21] = (morph.kicks % 1024) + 1024 * (qb(st.lL, 7) + 128 * qb(st.lLp, 7));
    p[22] = Math.min(morph.snareAge, 9);
    // The snares' strength sum before the latest (the width pattern's coordinate).
    p[23] = st.sSum;
    p[24] = Math.min(morph.leadAge, 9);
    // The latest and previous kick's strengths and the latest snare's (8 bits each).
    p[25] = qb(st.kL, 8) + 256 * qb(st.kLp, 8) + 65536 * qb(st.sL, 8);
    p[26] = st.cur;
    p[27] = st.prev;
    // Lateral camera sway.
    // Lateral camera sway (fraction) and the focal length (integer part, 1/2048) share a slot.
    p[28] = Math.round(focal * 2048) + 0.999 * (0.5 * wave(a[5] * 0.3, -1, 1) + 0.5);
    // The previous kick's and note's ages, and the pitch before the old one.
    p[29] = st.kPrev;
    p[30] = st.lPrev;
    p[31] = st.older;
  },
  wgsl: /* wgsl */ `
// The sheet: two travelling plane waves (flow frame, scrolled by sc) plus a swirl round a fixed
// vortex (camera frame). zc is the camera-frame depth of the point.
fn nc_H(x: f32, zc: f32, sc: f32) -> f32 {
  let zf = zc + sc;
  let w1 = S.p[0].x * sin(S.p[0].y * x + S.p[0].z * zf + S.p[0].w);
  let w2 = S.p[1].x * sin(S.p[1].y * x + S.p[1].z * zf + S.p[1].w);
  let dx = x - S.p[2].y;
  let dzc = zc - S.p[2].z;
  let r = sqrt(dx * dx + dzc * dzc);
  let sw = S.p[2].x * sin(floor(S.p[3].x) * atan2(dzc, dx) + S.p[2].w * r);
  return w1 + w2 + sw;
}

// The sky sheet's height: the two plane waves only (no swirl), so it stays smooth into the distance.
fn nc_Hu(x: f32, zc: f32, sc: f32) -> f32 {
  let zf = zc + sc;
  return S.p[0].x * sin(S.p[0].y * x + S.p[0].z * zf + S.p[0].w) + S.p[1].x * sin(S.p[1].y * x + S.p[1].z * zf + S.p[1].w);
}

// Signed distance-like residual of the ray against the sheet.
fn nc_f(o: vec3f, rd: vec3f, t: f32, sc: f32) -> f32 {
  let P = o + t * rd;
  return P.y - nc_H(P.x, P.z, sc);
}

fn nc_normal(x: f32, zc: f32, sc: f32) -> vec3f {
  let e = 0.03;
  let hx = (nc_H(x + e, zc, sc) - nc_H(x - e, zc, sc)) / (2.0 * e);
  let hz = (nc_H(x, zc + e, sc) - nc_H(x, zc - e, sc)) / (2.0 * e);
  return normalize(vec3f(-hx, 1.0, -hz));
}

// The palette hue at full chroma (saturation pushed to the top), at a chosen intensity (neon on black).
// rot turns the hue about the colour wheel (saturation and value unchanged).
fn nc_col(h: f32, rot: f32, lum: f32) -> vec3f {
  let p = pal(h);
  let mx = max(p.r, max(p.g, p.b));
  let mn = min(p.r, min(p.g, p.b));
  let d = max(mx - mn, 1e-4);
  var hh = select(select((p.r - p.g) / d + 4.0, (p.b - p.r) / d + 2.0, mx == p.g), (p.g - p.b) / d, mx == p.r);
  hh = fract(hh / 6.0 + rot);
  let s = mix(0.92, 0.99, sat((mx - mn) / max(mx, 1e-4)));
  let c = hsv2rgb(vec3f(hh, s, 1.0));
  // Even out perceived brightness across hues (a pure blue is far darker than a pure green).
  return c * lum * pow(0.4 / max(luma(c), 0.08), 0.55);
}

// A critically damped ease from rest (e = seconds since the front): 0 before it, no jump in value or
// speed, 90% there by 0.2 s and settled by about 0.3 s.
fn nc_ease(e: f32) -> f32 { let u = max(e, 0.0) / 0.05; return 1.0 - (1.0 + u) * exp(-u); }
// A hot edge that rises from rest when a front passes, peaks 50 ms later and has cooled by about 0.25 s.
fn nc_edge(e: f32) -> f32 { let u = max(e, 0.0) / 0.05; return u * u * exp(2.0 - 2.0 * u); }
// Embers that rise from rest and cool a little slower (faint, so they do not raise the baseline).
fn nc_ember(e: f32) -> f32 { let u = max(e, 0.0) / 0.12; return u * u * exp(2.0 - 2.0 * u); }

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  var q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let rp = S.p[3].w;
  q = rot2(floor(rp) / 4096.0 - 2.0) * q;
  let yaw = (fract(rp) / 0.999 - 0.5) * 0.7;
  let focal = floor(S.p[7].x) / 2048.0;
  let sway = 0.6 * (2.0 * fract(S.p[7].x) / 0.999 - 1.0);
  let camH = S.p[3].y;
  let pitch = S.p[3].z;
  let sc = S.p[4].x;
  let dz = S.p[4].y;
  let A = S.p[0].x + S.p[1].x + S.p[2].x + 0.02;
  let o = vec3f(sway, camH, 0.0);

  // Camera rays: the phrase framing's focal length, tilted down by pitch and turned by yaw.
  let vy = q.y / focal;
  let rd0 = normalize(vec3f(q.x / focal, vy * cos(pitch) - sin(pitch), vy * sin(pitch) + cos(pitch)));
  let rd = vec3f(rd0.x * cos(yaw) + rd0.z * sin(yaw), rd0.y, rd0.z * cos(yaw) - rd0.x * sin(yaw));
  // Slab of the sheet's amplitude: march it between its top and bottom planes (uniform loop).
  let dn = max(-rd.y, 1e-3);
  let t0 = min(max(camH - A, 0.0) / dn, 39.0);
  let t1 = min((camH + A) / dn, 40.0);
  // Adaptive steps (a fraction of the height above the sheet, so thin crests are not stepped over and
  // their silhouettes stay smooth), then the bracketed crossing is refined.
  var fp = nc_f(o, rd, t0, sc);
  var tp = t0;
  var ta = t0;
  var tb = t1;
  var fa = 1.0;
  var fb = -1.0;
  var hit = 0.0;
  for (var i = 0; i < 72; i++) {
    let t = min(tp + clamp(0.35 * fp, 0.008 + 0.003 * tp, 1.6), t1);
    let ft = nc_f(o, rd, t, sc);
    let c = fp > 0.0 && ft <= 0.0 && hit < 0.5;
    ta = select(ta, tp, c);
    tb = select(tb, t, c);
    fa = select(fa, fp, c);
    fb = select(fb, ft, c);
    hit = max(hit, select(0.0, 1.0, c));
    let go = hit < 0.5;
    fp = select(fp, ft, go);
    tp = select(tp, t, go);
  }
  // Refine the crossing (false position), so the contours sit exactly on the sheet and do not step.
  for (var k = 0; k < 4; k++) {
    let tm = ta + (tb - ta) * fa / max(fa - fb, 1e-6);
    let fm = nc_f(o, rd, tm, sc);
    let up = fm > 0.0;
    ta = select(ta, tm, up);
    fa = select(fa, fm, up);
    tb = select(tm, tb, up);
    fb = select(fm, fb, up);
  }
  let th = select(t1, ta + (tb - ta) * fa / max(fa - fb, 1e-6), hit > 0.5);

  // The sheet point: s is the row coordinate (rows at integer s), fw its footprint per pixel.
  let P = o + th * rd;
  let zc = P.z;
  // Fine scale from the high end: every line winds along its length (two octaves, phase from the
  // detail layer), so a high note re-forms the lines themselves; fwidth below keeps them filtered.
  let fph = S.p[4].w;
  let s = (zc + sc) / dz + 0.16 * sin(2.3 * P.x + 0.35 * zc + fph) + 0.07 * sin(5.1 * P.x - 0.6 * zc - 1.7 * fph + 1.0);
  let fw = max(fwidth(s), 1e-5);
  let j = floor(s + 0.5);
  let dpx = abs(s - j) / fw;
  let nrm = nc_normal(P.x, zc, sc);

  // Per-line attributes, fixed to the line (not the pixel).
  let hj = hash12(vec2f(j, 7.0));
  let hj2 = hash12(vec2f(j, 19.0));
  let kA = S.p[5].x; let kN = fmod(S.p[5].y, 1024.0); let sA = S.p[5].z; let sSum = S.p[5].w;
  // Strengths: kick (latest, previous), snare, note (latest, previous).
  let lk = S.p[6].y;
  let lvK = fmod(lk, 256.0) / 255.0;
  let lvKp = fmod(floor(lk / 256.0), 256.0) / 255.0;
  let lvS = floor(lk / 65536.0) / 255.0;
  let ll = floor(S.p[5].y / 1024.0);
  let lvL = fmod(ll, 128.0) / 127.0;
  let lvLp = floor(ll / 128.0) / 127.0;
  let lA = S.p[6].x; let pNew = S.p[6].z; let pOld = S.p[6].w;
  let kP = S.p[7].y; let lP = S.p[7].z; let pOlder = S.p[7].w;

  // Fronts in screen x: kick from a point that changes each kick, snare from the far edge,
  // melody from the height its pitch picks. Each sweeps the frame in about 0.1 s while every pixel
  // eases into its new state on a critically damped curve over about 0.3 s, and the previous kick and note fronts are kept so their
  // changes always finish.
  let qx = q.x;
  let x0 = (hash11(kN * 3.1 + 0.5) * 2.0 - 1.0) * 1.2;
  let x0p = (hash11((kN - 1.0) * 3.1 + 0.5) * 2.0 - 1.0) * 1.2;
  let xs = select(1.5, -1.5, x0 > 0.0);
  let xm = pNew * 1.1;
  let xmp = pOld * 1.1;
  let Tk = abs(qx - x0) / (24.0 + 12.0 * hj) + 0.03 * hj2;
  let TkP = abs(qx - x0p) / (24.0 + 12.0 * hj) + 0.03 * hj2;
  let Ts = abs(qx - xs) / (26.0 + 12.0 * hj2) + 0.03 * hj;
  let Tm = abs(qx - xm) / (24.0 + 12.0 * hj2) + 0.03 * hj;
  let TmP = abs(qx - xmp) / (24.0 + 12.0 * hj2) + 0.03 * hj;
  let bK = kA - Tk;
  let bKp = kP - TkP;
  let bS = sA - Ts;
  let bL = lA - Tm;
  let bLp = lP - TmP;

  // Lasting states: the palette steps behind each kick, the widths re-cut behind each snare,
  // the hue follows the note behind the melody front. Each pixel eases into its new state.
  let hueK = (lvKp * nc_ease(bKp) + lvK * nc_ease(bK)) * 0.36;
  let pm = nc_ease(bL);
  let pmP = nc_ease(bLp);
  let hueM = mix(mix(0.5 + 1.2 * pOlder, 0.5 + 1.2 * pOld, pmP), 0.5 + 1.2 * pNew, pm);
  let hueRow = S.p[4].z + 0.045 * j + hueK;
  let rotRow = 0.45 * sin(0.9 * P.x + 0.07 * j);
  // The width pattern is a smooth walk along the snares' strength sum: a faint snare re-cuts it a little.
  let sC = sSum + lvS * nc_ease(bS);
  let sI = floor(sC);
  let wOld = 0.3 + 1.9 * hash12(vec2f(j, 31.0 + sI));
  let wNew = 0.3 + 1.9 * hash12(vec2f(j, 32.0 + sI));
  // The melody's lasting change: line weight set by the note's pitch, re-cut behind its front.
  let mOlder = 0.7 + 0.9 * (0.5 + 0.5 * sin(3.0 * pOlder));
  let mOld = 0.7 + 0.9 * (0.5 + 0.5 * sin(3.0 * pOld));
  let mNew = 0.7 + 0.9 * (0.5 + 0.5 * sin(3.0 * pNew));
  let wpx = mix(wOld, wNew, sC - sI) * mix(mix(mOlder, mOld, pmP), mNew, pm);

  // Anti-aliased line: a sharp core and a halo; rows under a pixel fade to their mean.
  let fade = sat(fw * 2.6 - 0.3);
  let core = sat(wpx + 0.5 - dpx);
  let halo = exp(-dpx / 2.2) * 0.35;
  let avg = min(1.0, fw * 2.0 * wpx) * 0.3;
  let lineI = mix(core + halo, avg, fade);

  // Lines are the palette at full chroma (no white or grey mixed in); the note shifts the hue.
  // The note moves the line along the palette (not an RGB blend), so every line keeps full chroma.
  // Iridescence: the hue also turns a little with the angle the sheet is seen at (a thin-film shift).
  let facing = sat(dot(nrm, -rd));
  let irid = 0.14 * (1.0 - facing);
  let hueN = 0.5 * (hueM - 0.5);
  let lineCol = nc_col(hueRow + hueN, rotRow + irid, 1.0);
  let dif = 0.55 + 0.45 * max(dot(nrm, normalize(vec3f(-0.35, 0.8, 0.45))), 0.0);
  var col = lineCol * lineI * dif;

  // Sheen: a thin brighter seam along the middle of each tube, catching the light (fades with the
  // line when the rows go sub-pixel).
  let seam = pow(sat(1.0 - dpx / max(0.55 * wpx, 0.4)), 2.0) * (1.0 - fade) * sat(wpx - 0.3);
  col += mix(lineCol, vec3f(1.0), 0.3) * seam * 0.45 * dif;

  // Luminous depth between the lines: the band between two rows glows from within with a gradient
  // from one row's colour to the next (the row coordinate is continuous, so it never steps), brighter
  // on the crests and where the slope faces the view. A lower octave of wide terraces (every five
  // rows) layers soft light bands under the lines; it fades to its mean before it could alias.
  let fillCol = nc_col(S.p[4].z + 0.045 * s + hueK + hueN + 0.08, rotRow + irid + 0.06, 1.0);
  let hN = sat((P.y + A) / (2.0 * A));
  let terr = mix(0.5 + 0.5 * cos(TAU * (s / 5.0 + 0.1 * sin(0.7 * P.x))), 0.5, sat(fw * 2.0 - 0.4));
  let between = 1.0 - exp(-abs(s - j) * 2.5);
  let fillI = (0.05 + 0.1 * terr) * (0.45 + 0.75 * hN) * (0.55 + 0.6 * facing) * (0.7 + 0.3 * between);
  col += fillCol * fillI;

  // Fronts burn along the lines. Each edge brightens the line in its own hue (plus a little of the
  // event's colour), so the sheet stays saturated rather than washing toward white.
  let onL = core + 0.8 * halo;
  // Kick and snare glows are brief (they have faded before a following note); the note's lasts longer.
  // Each edge is as bright as its hit.
  let kEdge = nc_edge(1.4 * bK) * lvK + nc_edge(1.4 * bKp) * lvKp;
  col += (lineCol * 1.6 + vec3f(1.0, 0.45, 0.1) * 0.4) * kEdge * onL + lineCol * nc_ember(bK) * 0.3 * onL * lvK;
  let sEdge = nc_edge(1.4 * bS) * lvS;
  col += (lineCol * 2.2 + vec3f(0.3, 0.75, 1.0) * 0.6) * sEdge * onL;
  let lEdge = nc_edge(bL);
  let lc = nc_col(hueM, 0.0, 1.0);
  col += lc * (lEdge * lvL + nc_edge(bLp) * lvLp) * (4.5 * onL + 2.0 * halo) + lc * nc_ember(bL) * 0.2 * onL * lvL;

  let glow = 0.8 + 0.4 * fract(S.p[3].x) / 0.999;

  // The haze: a soft light the sheets run into at the horizon, in the palette's colour (stepped by the
  // kicks and the melody like the lines), so the distance glows instead of going black.
  let hazeCol = nc_col(S.p[4].z + hueK + hueN + 0.22, 0.0, 1.0);
  let horizon = exp(-abs(rd.y) * 7.0);
  let haze = hazeCol * (0.04 + 0.16 * horizon);

  // The sky sheet: a second, slower contour map on a plane far overhead (a lower octave of the same
  // field: wider, softer rows that scroll at half the pace, for parallax). Its rows are level lines of
  // depth bent by the two plane waves, drawn dimmer, so the floor stays the subject.
  let ry = max(rd.y, 1e-3);
  let cY = camH + 2.4;
  let scU = 0.5 * sc + 11.0;
  let tu = min((cY - camH) / ry, 80.0);
  let Pu = o + tu * rd;
  let su = (Pu.z + scU + 1.6 * nc_Hu(0.5 * Pu.x + 3.0, 0.5 * Pu.z, scU)) / (1.8 * dz) + 0.12 * exp(-0.06 * tu) * sin(1.3 * Pu.x + 0.2 * Pu.z + 0.5 * fph);
  let fwu = max(fwidth(su), 1e-5);
  let ju = floor(su + 0.5);
  let dpu = abs(su - ju) / fwu;
  let fadeU = sat(fwu * 4.0 - 0.3);
  let lineU = mix(sat(0.9 - dpu) + exp(-dpu / 3.0) * 0.3, 0.25 * min(1.0, fwu * 1.6), fadeU);
  let colU = nc_col(S.p[4].z + 0.045 * ju + hueK + hueN + 0.5, 0.35 * sin(0.5 * Pu.x + 0.05 * ju) + 0.1, 1.0);
  let fillU = nc_col(S.p[4].z + 0.045 * su + hueK + hueN + 0.58, 0.1, 1.0);
  let terrU = mix(0.5 + 0.5 * cos(TAU * su / 4.0), 0.5, sat(fwu * 2.5 - 0.3));
  var sky = colU * lineU * 0.42 + fillU * (0.035 + 0.07 * terrU);
  let skyOn = smoothstep(0.0, 0.14, rd.y);
  sky = mix(haze, sky * glow, skyOn * exp(-tu * 0.05));

  // Depth: the floor runs into the haze; where neither sheet is met, the haze shows.
  let fog = exp(-th * 0.07);
  let floorC = mix(haze, col * glow, fog);
  col = mix(sky, floorC, hit);
  col = col / (1.0 + 0.8 * max(col.r, max(col.g, col.b)));
  return vec4f(col, 1.0);
}
`,
});
