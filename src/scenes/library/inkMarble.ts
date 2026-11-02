import { Morph } from '../morph';
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
 * Ink Marble: Turkish marbling (ebru / suminagashi) as a stack of smooth, lasting maps. Each pixel
 * is traced back through the events, newest first, to the base picture of ink bands:
 *  - a kick bulges the sheet outward: q -> c + (q-c) (1 - A exp(-|q-c|^2 / s^2)) in reverse. No disc,
 *    no fill, no ring; the bands near the kick are pushed out for good. The kick also turns the whole
 *    sheet's ink a step round the palette and swings the light, so every band's gloss moves;
 *  - a melody note is a small lasting twist about its spot (pitch sets the spot): the bands that pass
 *    through the spot take the note's colour, and the twist stays;
 *  - a snare is a comb stroke: a shear along a line, q -> q - t g(s), with s the distance to the line,
 *    and it re-cuts every band to a new width;
 *  - a slow global swirl, rushed by drops, turns the whole sheet and is undone first.
 * The base is a comb of glossy ink bands (stripes or rings) that changes every phrase. Each map
 * is applied to the pixel in reverse, so the events are carried by the bands themselves.
 *
 * Ring: the last 18 events live in params 0..17. Each packs (kind, melody pitch, count, strength) into
 * its integer part and its age (up to 1.5 s) into the fraction, which is exact in f32. Every event's
 * map is scaled by its strength (the morph's level, squared): a faint hit a faint change. The oldest events
 * fade out before they leave the ring, so no event pops out of the sheet. Param 18 is the eased snare
 * count; param 19 is a slot offset that jumps by one when the ring shifts and then glides back to
 * zero, so the fade weights never step. Params 20..31 hold the seed, the base picture (phrase,
 * cross-fade, morph coordinates), the surge, the drive, the travel, the palette, and the swirl's sense
 * with the eased kick count.
 *
 * Every change eases in from rest (smoothstep or a critically damped spring) over half a second or
 * more, so nothing snaps.
 *
 * Music:
 *  - kick: a smooth outward bulge at a hashed point, then permanent; the whole sheet steps one ink on
 *    round the palette and the light swings round, so the gloss slides across every band;
 *  - snare: a comb stroke across the sheet, its teeth shearing the bands, and every band re-cut to a
 *    new width (the widths glide from one set to the next);
 *  - melody: a local twist at a spot set by pitch, and the bands through it tinted in the note's colour;
 *  - phrase: a new base picture, and the old one cross-fades out (on a spring) as events accumulate;
 *  - drop: the global swirl rushes and the flow speeds up (surge and drive).
 *
 * DNA: 0 start, 1 swirl sense, 3 palette offset.
 */

const RING = 18;
/** Ages are encoded up to this many seconds; every event has fully eased in by then. */
const AGE_MAX = 1.5;
type Drop = { kind: number; code: number; cnt: number; lv: number; t: number };

/** Reaction strength from the morph's event level: squared, so it rises from nothing as softly as the hit. */
const strength = (level: number) => level * level;

const morph = new Morph(0.8);
let ring: Drop[] = [];
let seed = -1;
let lastT = -1;
let kn = 0;
let sn = 0;
let nn = 0;
let phrase = -1;
let phraseStart = 0;
/** When the shown phrase began (-1: the cue's first picture, shown in full). */
let phraseT = -1;
let kick0 = 0;
/** The kicks' and snares' strength sums: the sheet's ink step and band re-cut follow them. */
let kSum = 0;
let sSum = 0;
// Springs (value, velocity): the kicks' ink step, the ring's slot offset, the phrase cross-fade, the swirl's surge and drive.
const sp = { kick: 0, kickV: 0, snare: 0, snareV: 0, lag: 0, lagV: 0, mix: 1, mixV: 0, surge: 0, surgeV: 0, drive: 0, driveV: 0 };

/** One step of a critically damped spring toward `target`: starts from rest, never overshoots. */
function spring(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  const e = Math.exp(-w * dt);
  const d = x - target;
  const c = v + w * d;
  return [target + (d + c * dt) * e, (v - w * c * dt) * e];
}

/**
 * Packs strength (4 bits), count (1..15), melody pitch code (7 bits) and kind (2 bits) into the
 * integer (17 bits); age in 1/128 (24 bits in all, exact in f32).
 */
function encode(e: Drop, now: number): number {
  const lv = Math.round(Math.min(1, Math.max(0, e.lv)) * 15);
  const I = lv + 16 * (((e.cnt - 1) % 15) + 1 + 16 * (e.code + 128 * e.kind));
  const age = Math.min(AGE_MAX, Math.max(0, now - e.t));
  return I + Math.round((age / AGE_MAX) * 127) / 128;
}

function push(e: Drop): void {
  ring.push(e);
  if (ring.length > RING) ring.shift();
  // Every event moved down a slot (the ring fills from the top, and once full the oldest drops out):
  // the offset keeps each fade weight where it was, then glides back.
  sp.lag += 1;
}

const SHADER = /* wgsl */ `
struct MbMap { q: vec2f, glow: vec3f, tint: vec3f, tw: f32 };

fn mb_ev(i: u32) -> f32 { return S.p[i >> 2u][i & 3u]; }
fn mb_seed() -> f32 { return S.p[5].x; }
// The kicks so far, eased (each glides in from rest over most of a second).
fn mb_kick() -> f32 { return abs(S.p[7].w) - 1.0; }

fn mb_hrot(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027);
  let ca = cos(a);
  return max(c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca), vec3f(0.0));
}

// Full-chroma ink for a palette position: brightest channel at 1, greys replaced by a wheel hue.
fn mb_ink(t: f32) -> vec3f {
  let c = max(pal(t), vec3f(0.0));
  let m = max(max(c.r, c.g), max(c.b, 1e-4));
  let n = c / m;
  let lo = min(n.r, min(n.g, n.b));
  let k = (n - lo) / max(1.0 - lo, 0.4);
  // A near-grey entry blends smoothly into a wheel hue (a hard switch would flip as the palette glides).
  return mix(k, hsv2rgb(vec3f(fract(t), 0.9, 1.0)), smoothstep(0.5, 0.8, lo));
}

// Box-filtered coverage of the band |x| < hw by a pixel of width fw centred at x.
fn mb_cover(x: f32, hw: f32, fw: f32) -> f32 {
  return max(0.0, min(x + 0.5 * fw, hw) - max(x - 0.5 * fw, -hw)) / fw;
}

// The stack, newest first. Each event maps the pixel back to where its content was before the event.
// A melody twist and a kick bulge are smooth (no discs, no fill), so every edge is a band edge.
fn mb_map(x: vec2f) -> MbMap {
  let sd = mb_seed();
  let th = sign(S.p[7].w) * (0.1 + S.p[5].w) * exp(-dot(x, x) / 1.2);
  var q = rot2(-th) * x;
  var glow = vec3f(0.0);
  var tint = vec3f(0.0);
  var tw = 0.0;
  let lag = S.p[4].w;
  for (var i: i32 = ${RING - 1}; i >= 0; i--) {
    let v = mb_ev(u32(i));
    let I = floor(v);
    let lv = fmod(I, 16.0) / 15.0;
    let J = floor(I / 16.0);
    let cnt = fmod(J, 16.0);
    if (cnt < 0.5) { continue; }
    // The oldest slots fade out; the glided slot offset keeps the weights from stepping on a shift.
    let w = smoothstep(1.0, 7.0, f32(i) + lag);
    if (w <= 0.0) { continue; }
    let kind = floor(J / 2048.0);
    let code = fmod(floor(J / 16.0), 128.0);
    let age = floor(fract(v) * 128.0 + 0.5) / 127.0 * ${AGE_MAX.toFixed(1)};
    // Each event eases in from rest on a critically damped curve (half in by 0.34 s, 90% by 0.78 s).
    let ua = age / 0.2;
    let rr = 1.0 - (1.0 + ua) * exp(-ua);
    // The snare's glow rises from rest, peaks 200 ms in and has cooled by about 0.8 s.
    let hot = ua * ua * exp(2.0 - 2.0 * ua) * w * lv;
    let hb = vec3f(
      hash12(vec2f(cnt, 1.0 + kind * 7.0 + sd * 31.0)),
      hash12(vec2f(cnt, 17.0 + kind * 3.0 + sd * 13.0)),
      hash12(vec2f(cnt + code * 0.37, 5.0 + sd * 7.0)));
    if (kind == 1.0) {
      // Snare: a comb stroke shears the bands along its line.
      let an = hb.x * 3.14159265;
      let n = vec2f(cos(an), sin(an));
      let tg = vec2f(-n.y, n.x);
      let s = dot(q - vec2f((hb.y - 0.5) * 1.2, (hb.z - 0.5) * 1.2), n);
      let comb = exp(-s * s / 0.04) * (0.55 + 0.45 * cos(s * 26.0 + hb.x * TAU));
      q = q - tg * (0.28 * w * rr * lv * comb);
      let cool = mix(mb_ink(sd * 0.7 + 0.5 + cnt * 0.21), vec3f(1.0), 0.35);
      glow += cool * hot * exp(-s * s / 0.004) * 0.45;
    } else if (kind == 0.0) {
      // Kick: a smooth radial bulge. The pixel samples from slightly inside the bulge, so the
      // bands near the kick are pushed outward. The bulge widens and strengthens over about 0.3 s.
      let an = hb.x * TAU;
      let c = vec2f(cos(an), sin(an)) * (0.15 + 0.7 * hb.y) * vec2f(F.aspect, 1.0);
      let sK = (0.26 + 0.18 * hb.z) * (0.4 + 0.6 * rr);
      let d = q - c;
      let e = exp(-dot(d, d) / (sK * sK));
      q = c + d * (1.0 - 0.85 * w * rr * lv * e);
    } else {
      // Melody: a local lasting twist about the note's spot. Its bands take the note colour.
      let pn = code / 127.0 * 2.0 - 1.0;
      let c = vec2f(pn * 0.9 * F.aspect, (hb.y - 0.5) * 1.2);
      let d = q - c;
      let e = exp(-dot(d, d) / 0.2);
      let amp = w * rr * lv;
      let hue = pn * 0.4 + 0.5 + sd * 0.3 + cnt * 0.07;
      tint += mb_ink(hue) * e * amp;
      tw += e * amp;
      q = c + rot2(-2.6 * amp * e) * d;
    }
  }
  return MbMap(q, glow, tint, tw);
}

// Base picture for one phrase: a band coordinate (band units) of stripes or rings, carried by the morph.
fn mb_band(q: vec2f, ph: f32) -> f32 {
  let sd = mb_seed();
  let h1 = hash12(vec2f(ph, 3.0 + sd * 11.0));
  let h2 = hash12(vec2f(ph * 1.7 + 0.3, 9.0 + sd * 5.0));
  let h3 = hash12(vec2f(ph * 0.9 + 2.0, 21.0 + sd * 3.0));
  let at0 = S.p[6].y; let at1 = S.p[6].z; let at2 = S.p[6].w; let at3 = S.p[7].x;
  let tr = S.p[7].y;
  // Fine scale from the high end: the band edges ripple along their length (two octaves), phased by
  // the detail layer and deeper with the air of the mix, so a high note re-forms the bands' fine edge.
  let fph = S.p[6].x;
  let fa = 0.05 + 0.09 * floor(S.p[7].z / 2.0) / 63.0;
  if (h1 < 0.5) {
    let th = h2 * TAU + 0.6 * sin(at0);
    let dir = vec2f(cos(th), sin(th));
    let perp = vec2f(-dir.y, dir.x);
    let K = mix(1.8, 3.4, h3) * (0.85 + 0.3 * sin(at1));
    let W = 0.25 + 0.3 * (0.5 + 0.5 * sin(at3));
    let rip = fa * (sin(dot(q, perp) * 9.0 + fph) + 0.5 * sin(dot(q, perp) * 19.0 - 1.6 * fph + 1.0));
    return dot(q, dir) * K + W * sin(dot(q, perp) * (2.0 + 2.0 * h2) + at2) + 0.08 * tr + rip;
  }
  let c = vec2f(sin(at0 * 0.5) * (h2 - 0.3), cos(at1 * 0.5) * (h3 - 0.3)) * 1.6;
  let d = q - c;
  let K = mix(2.0, 3.6, h3) * (0.85 + 0.3 * sin(at2));
  let an = atan2(d.y, d.x);
  let rip = fa * (sin(9.0 * an + fph) + 0.5 * sin(17.0 * an - 1.6 * fph + 1.0)) * smoothstep(0.0, 0.25, length(d));
  return length(d) * K + 0.3 * sin(3.0 * an + at3) + 0.08 * tr + rip;
}

// Glossy ink bands from the band coordinate V and its screen gradient gv (band units per pixel).
fn mb_shade(V: f32, gv: vec2f, ph: f32) -> vec3f {
  let sd = mb_seed();
  let fw = clamp(length(gv), 0.02, 1.5);
  let bi = floor(V);
  let x = V - bi - 0.5;
  let hb = hash12(vec2f(bi, 13.0 + ph * 2.3 + sd * 7.0));
  let ha = hash12(vec2f(bi * 1.3, 31.0 + ph * 1.1 + sd * 3.0));
  // Each snare re-cuts the band widths across the whole sheet, for good, gliding from one set of
  // widths to the next as its count eases in.
  let sn = S.p[4].z;
  let sf = fract(sn);
  let hb1 = hash12(vec2f(bi, 41.0 + floor(sn) * 3.7 + sd * 5.0));
  let hb2 = hash12(vec2f(bi, 41.0 + (floor(sn) + 1.0) * 3.7 + sd * 5.0));
  let hw = mix(0.05, 0.24, hb) * mix(0.55, 1.45, mix(hb1, hb2, sf * sf * (3.0 - 2.0 * sf)));
  let cov = mb_cover(x, hw, fw);
  let t = clamp(x / hw, -1.0, 1.0);
  let hgt = sqrt(max(1.0 - t * t, 0.0));
  let gd = gv / max(length(gv), 1e-6);
  let N = normalize(vec3f(gd * (t / max(hgt, 0.25)) * 0.8, 1.0));
  // Each kick swings the light a step round the sheet, for good, so every band's gloss moves.
  let la = mb_kick() * 1.3;
  let L = normalize(vec3f(rot2(la) * vec2f(-0.45, -0.6), 0.7));
  let Hv = normalize(L + vec3f(0.0, 0.0, 1.0));
  let dif = 0.3 + 0.7 * max(dot(N, L), 0.0);
  let spc = pow(max(dot(N, Hv), 0.0), 60.0);
  let fres = pow(1.0 - N.z, 2.0);
  let hue = sd * 0.7 + fmod(S.p[7].z, 2.0) + mb_kick() * 0.2 + bi * 0.15 + ph * 0.37 + step(0.7, ha) * 0.5;
  var ink = mb_ink(hue);
  if (ha > 0.6) { ink = mb_hrot(ink, 2.5); }
  let band = ink * (0.25 + 0.9 * hgt) * dif + ink * fres * 0.5 + mix(ink, vec3f(1.0), 0.3) * spc * 0.6;
  let gap = mb_ink(hue + 0.5) * 0.008;
  return band * cov + gap * (1.0 - cov);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let x = (uv - 0.5) * vec2f(F.aspect, 1.0) * 2.0;
  let e = 2.0 / F.res.y;
  let m0 = mb_map(x);
  let mx = mb_map(x + vec2f(e, 0.0));
  let my = mb_map(x + vec2f(0.0, e));
  let phN = S.p[5].y;
  let phO = phN - 1.0;
  let wN = S.p[5].z;
  let vN = mb_band(m0.q, phN);
  let vO = mb_band(m0.q, phO);
  let gN = vec2f(mb_band(mx.q, phN) - vN, mb_band(my.q, phN) - vN);
  let gO = vec2f(mb_band(mx.q, phO) - vO, mb_band(my.q, phO) - vO);
  var base = mix(mb_shade(vO, gO, phO), mb_shade(vN, gN, phN), wN);
  // Melody: the bands that passed a note's spot take the note's colour (gaps stay dark).
  let tk = clamp(m0.tw, 0.0, 1.0);
  let noteCol = m0.tint / max(m0.tw, 1e-4);
  base = mix(base, base * noteCol * 2.6, tk);
  return vec4f(base + m0.glow, 1.0);
}
`;

export default raymarchScene({
  meta: {
    id: 'ink-marble',
    name: 'Ink Marble',
    energy: [0, 1],
    mood: { valence: 0.6, arousal: 0.5 },
    genres: { ambient: 0.9, edm: 0.8, techno: 0.7, synthwave: 0.8, pop: 0.7, lofi: 0.8, jazz: 0.7, classical: 0.7, dubstep: 0.6, dnb: 0.6, hiphop: 0.6, rock: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, g);
    // Song time detects seeks and times the phrase cross-fade. The drops age on the world's paced
    // clock (like the morph's event ages), so they ease in faster in a driving song.
    const now = m.time;
    const clk = ctx.clock;
    if (g[0] !== seed || Math.abs(now - lastT - dt) > 0.5) {
      seed = g[0];
      ring = [];
      kn = morph.kicks;
      sn = morph.snares;
      nn = morph.notes;
      phrase = morph.phrases;
      phraseStart = kn + sn + nn;
      phraseT = -1;
      sp.kick = kick0 = kSum = 0;
      sp.snare = sSum = 0;
      sp.snareV = 0;
      sp.lag = sp.kickV = sp.lagV = sp.mixV = sp.surgeV = sp.driveV = 0;
      sp.mix = 1;
      sp.surge = morph.surge;
      sp.drive = morph.drive;
    }
    lastT = now;

    // Events since the last frame enter the ring (kick, snare, melody note).
    // Each carries its strength, so it keeps it while it eases in.
    while (kn < morph.kicks) {
      kn++;
      kSum += strength(morph.kickLevel);
      push({ kind: 0, code: 0, cnt: kn, lv: strength(morph.kickLevel), t: clk });
    }
    while (sn < morph.snares) {
      sn++;
      sSum += strength(morph.snareLevel);
      push({ kind: 1, code: 0, cnt: sn, lv: strength(morph.snareLevel), t: clk });
    }
    while (nn < morph.notes) {
      nn++;
      const code = Math.min(127, Math.max(0, Math.round(((morph.notePitch + 1) / 2) * 127)));
      // Notes take the level itself: lead strengths sit mid-range, and squared they would barely read.
      push({ kind: 2, code, cnt: nn, lv: morph.noteLevel, t: clk });
    }

    // A new phrase starts a new base picture; the old one fades out as events accumulate, and with
    // time (over two bars at most), so a sparse passage still finishes it. The shown picture moves on
    // only once the last cross-fade has finished: it restarts from 0 where the new picture still
    // matches the old one, so a phrase change never cuts a fade short.
    const total = kn + sn + nn;
    const beat = 60 / Math.max(40, m.bpm);
    if (morph.phrases !== phrase && sp.mix >= 0.995) {
      phrase = morph.phrases;
      phraseStart = total;
      phraseT = now;
      sp.mix = 0;
      sp.mixV = 0;
    }
    const mixT = phraseT < 0 ? 1 : Math.min(1, Math.max((total - phraseStart) / 6, (now - phraseT) / (8 * beat)));
    // The cross-fade glides toward its target on a spring of about a bar, so no event steps it.
    [sp.mix, sp.mixV] = spring(sp.mix, sp.mixV, mixT, 5 / Math.max(0.8, beat * 4), dt);
    // The ring offset glides back over about a beat; the swirl's surge and drive glide in too, so a
    // drop turns the sheet smoothly instead of jumping it.
    const wBeat = 6 / Math.max(0.3, beat * 1.3);
    [sp.lag, sp.lagV] = spring(sp.lag, sp.lagV, 0, wBeat, dt);
    [sp.surge, sp.surgeV] = spring(sp.surge, sp.surgeV, morph.surge, wBeat * 0.6, dt);
    [sp.drive, sp.driveV] = spring(sp.drive, sp.driveV, morph.drive, wBeat, dt);
    // Each kick also turns every band one ink step on, for good: it glides in from rest over most
    // of a second (half in by 0.42 s), so the whole sheet changes colour with the bulge.
    [sp.kick, sp.kickV] = spring(sp.kick, sp.kickV, kSum, 4.0, dt);
    [sp.snare, sp.snareV] = spring(sp.snare, sp.snareV, sSum, 6.5, dt);

    p.fill(0);
    const off = RING - ring.length;
    for (let k = 0; k < ring.length; k++) p[off + k] = encode(ring[k], clk);
    p[18] = sp.snare;
    p[19] = sp.lag;
    p[20] = g[0];
    p[21] = phrase;
    p[22] = Math.min(1, Math.max(0, sp.mix));
    // The swirl's rush (surge and drive), and the fine phase from the high end (RULES v7): the detail
    // layer flows it and each high note, backing chord and hat steps it (by level, eased by the morph).
    p[23] = 0.8 * sp.surge + 0.1 * sp.drive;
    p[24] = finePhase.update(1.2 * morph.detailAt[0] + 1.3 * morph.upperPhase + 0.5 * morph.backingPhase + 0.25 * morph.hatPhase, morph.detailDrive);
    p[25] = morph.at[0];
    p[26] = morph.at[1];
    p[27] = morph.at[2];
    p[28] = morph.at[3];
    p[29] = morph.travel;
    // Palette offset (fraction of 2) and the air of the mix (6 bits, in steps of 2).
    p[30] = g[3] + 2 * Math.round(Math.min(1, Math.max(0, morph.detailDrive)) * 63);
    // The swirl's sense in the sign, the eased kick count in the size.
    p[31] = (g[1] < 0.5 ? -1 : 1) * (1 + Math.max(0, sp.kick - kick0));
  },
  wgsl: SHADER,
});
