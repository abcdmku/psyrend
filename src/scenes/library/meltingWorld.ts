import { raymarchScene } from '../raymarchScene';
import type { MusicState } from '../../audio/musicState';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Melt: a surreal desert plaza under a low sun where architecture and objects
 * slump, drip and droop with the music, then snap back solid on the drop.
 * DNA picks the object set (metaphysical arcade plaza, dead tree with draped
 * clocks, an endless field of pillars and orbs, stairs to nowhere with floating
 * stones), the melt style (gravity sag, drips, Dalí drape, liquid wobble), sun
 * azimuth/elevation (always low: long hard shadows), camera rig, ground
 * (dunes, checker plaza, wet salt-flat mirror) and sky (clear, banded spectrum
 * sky, cloud bars). Clock hands tell the bar and section, the 12 hour ticks
 * glow with the 12 pitch classes, the banded sky scrolls the spectrum history.
 * Anticipation lowers the sun and melts everything; the drop re-solidifies it.
 *
 * Music: a glowing lamp floats over the plaza and plays the melody: its height follows the
 * pitch and every note flares it, throwing light over the objects and the ground. Kicks send
 * a ripple across the ground from the centre of the plaza; snares make everything slump a
 * step. Camera drift steps with the bars and rests when the music does.
 *
 * Events come from the shared morph: every reaction is scaled by its level squared (so a faint
 * intro motif only glimmers) and eased in; the lamp glides to each pitch.
 */

const fract = (x: number) => x - Math.floor(x);

/** Event source: ages and levels (this world does not use the morph's shape coordinates). */
const morph = new Morph(1);
/**
 * A light answering one kind of event: its level squared (the level carries how loud the passage
 * is, so a faint intro motif only glimmers), eased in over `rise` seconds and fading with time
 * constant `decay`. A new event rises from whatever is still lit, never cutting it off.
 */
class Flare {
  private n = -1;
  private carry = 0;
  value = 0;
  constructor(
    private readonly rise: number,
    private readonly decay: number,
  ) {}
  update(count: number, age: number, level: number): number {
    if (count !== this.n) {
      this.carry = this.n < 0 ? 0 : this.value;
      this.n = count;
    }
    const x = Math.min(1, age / this.rise);
    const fade = Math.exp(-age / this.decay);
    this.value = Math.max(this.carry * fade, level * level * x * x * (3 - 2 * x) * fade);
    return this.value;
  }
}
/** A position-bound front's strength (ring, knot, surge): level squared, eased in over `rise`. */
const onset = (age: number, level: number, rise: number) => {
  const x = Math.min(1, age / rise);
  return level * level * x * x * (3 - 2 * x);
};
const fx = { lead: new Flare(0.15, 0.3), snare: new Flare(0.2, 0.8) };
/** Held-note glow, lamp pitch and hats, glided so none of them jumps. */
const held = new Spring(0, 0.12);
const glide = new Spring(0, 0.3);
const hatS = new Spring(0, 0.1);
let lastT = -1;

/** Music clock: `beat` surges on every beat, `bar` steps on every bar, both scaled by loudness. */
const clk = { t: -1, b: 0, r: 0, beat: 0, bar: 0 };
function tickClock(m: MusicState) {
  const b = m.beatIndex + m.beatPhase + 0.095 * Math.sin(m.beatPhase * 2 * Math.PI);
  const e = Math.min(1, m.barPhase * 2);
  const r = m.barIndex + 0.5 * m.barPhase + 0.5 * e * e * (3 - 2 * e);
  const dt = m.time - clk.t;
  if (dt === 0) return;
  if (dt > 0 && dt < 0.25) {
    const drive = Math.min(1, m.energySlow * 5) * (0.25 + 0.6 * m.energySlow) + 0.5 * m.dropPulse;
    clk.beat += Math.min(Math.max(b - clk.b, 0), 1) * drive;
    clk.bar += Math.min(Math.max(r - clk.r, 0), 1) * drive;
  }
  clk.t = m.time;
  clk.b = b;
  clk.r = r;
}

// Where the melody lamp floats per object set (x, base height, z), and the kick ripple centre.
const LAMP = [[0.6, 2.35, -1.3], [-1.1, 2.5, 0.4], [0, 2.3, 5], [0.7, 3.4, 0.2]];
const RING = [[0, 0.5], [0, 0.3], [0, 5], [0, 1]];

export default raymarchScene({
  meta: {
    id: 'melting-world',
    name: 'Melt',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.15, 0.8],
    mood: { valence: 0.45, arousal: 0.35 },
    genres: { jazz: 1, lofi: 1, rock: 0.6, pop: 0.6, hiphop: 0.7, ambient: 0.5, classical: 0.5 },
    trails: 0.15,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    tickClock(m);
    const d = ctx.dna;
    const e = ctx.evolve;
    const ant = m.anticipation;
    const drop = m.dropPulse;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    morph.update(m, ctx.dt, d);
    if (Math.abs(m.time - lastT) > 0.5) {
      held.reset(0);
      glide.reset(Math.max(-1, Math.min(1, m.leadPitch)));
    }
    lastT = m.time;
    const heldL = held.update(m.leadHeld * morph.presence ** 2, dt);
    const pitchL = glide.update(Math.max(-1, Math.min(1, m.leadPitch)), dt);

    const set = Math.floor(d[1] * 4) % 4;
    const style = Math.floor(d[2] * 4) % 4;
    const camRig = Math.floor(d[4] * 4) % 4;
    const ground = Math.floor(d[5] * 3) % 3;
    const sky = Math.floor(d[7] * 3) % 3;

    // Melt: grows with loudness, tension and anticipation; the drop snaps it solid.
    const meltBase = 0.55 + 0.5 * d[6];
    let amt = meltBase * (0.45 + 0.4 * m.energySlow + 0.3 * e[0]) + 0.55 * ant + 0.3 * fx.snare.update(morph.snares, morph.snareAge, morph.snareLevel);
    amt *= 1 - 0.92 * drop;
    amt = Math.min(Math.max(amt, 0), 1.4);

    const sunAz = d[3] * Math.PI * 2 + 0.3 * (e[1] - 0.5);
    const sunEl = Math.max(0.035, (0.07 + 0.26 * fract(d[3] * 7.1)) * (1 - 0.55 * ant) + 0.06 * drop);
    p[0] = set; p[1] = style; p[2] = ground; p[3] = sky;
    p[4] = amt; p[5] = fract(d[0] * 5.3) + 0.12 * e[2]; p[6] = Math.cos(sunEl) * Math.cos(sunAz); p[7] = Math.sin(sunEl);
    p[8] = Math.cos(sunEl) * Math.sin(sunAz);
    p[9] = (1.15 + 0.35 * m.energySlow) * (1 - 0.35 * ant) + 0.6 * drop;
    p[10] = m.tension;
    p[11] = d[6] * 37.0;

    // Camera rig.
    const sp = clk.bar * 0.5;
    const pitch = (fract(d[5] * 3.7) - 0.5) * 1.1;
    let ro: number[], ta: number[], fov: number;
    if (camRig === 0) {
      ro = [2.4 * Math.sin(sp * 0.05 + d[4] * 9), 0.35 + 0.08 * Math.sin(sp * 0.13), -4.6];
      ta = [ro[0] * 0.4, 1.0 + pitch, 1.5];
      fov = 1.3;
    } else if (camRig === 1) {
      const az = sp * 0.04 + d[0] * 6.28;
      const r = 7.2 - 1.2 * e[3];
      ro = [r * Math.sin(az), 3.6 + 1.6 * e[3], -r * Math.cos(az) + 1];
      ta = [0, 0.7 + pitch * 0.7, 1];
      fov = 1.5;
    } else if (camRig === 2) {
      ro = [6 * Math.sin(sp * 0.06 + d[4] * 5), 1.7, -6.5];
      ta = [ro[0] * 0.35, 1.3 + pitch, 2];
      fov = 1.35;
    } else {
      const dist = 6.8 - 2.5 * e[3] - 0.8 * ant;
      const az = 0.5 * Math.sin(sp * 0.03 + d[0] * 4);
      ro = [dist * Math.sin(az), 1.1 + 0.4 * e[1], -dist * Math.cos(az) + 1];
      ta = [0, 1.4 + pitch * 0.8, 1];
      fov = 1.8;
    }
    const walk = set === 2 ? clk.beat * 0.22 : 0;
    ro[2] += walk;
    ta[2] += walk;
    p[12] = ro[0]; p[13] = ro[1]; p[14] = ro[2]; p[15] = fov;
    p[16] = ta[0]; p[17] = ta[1]; p[18] = ta[2];
    p[19] = 0.06 * (m.tension - 0.3) * Math.sin(sp * 0.07) + 0.05 * Math.sin(d[7] * 20);
    p[20] = clk.beat * 0.012; // cloud drift
    // S.p[5].y: glided melody pitch (lamp hue); .z: glided hats (sun glints).
    p[21] = pitchL;
    p[22] = hatS.update(m.hat * morph.presence, dt);
    p[23] = ant;
    // Melody lamp: position (height from pitch) and brightness (flares on each note).
    const lp = LAMP[set];
    p[24] = lp[0]; p[25] = lp[1] + 0.95 * pitchL; p[26] = lp[2] + walk;
    p[27] = 0.12 + 0.35 * heldL + 3.2 * fx.lead.update(morph.notes, morph.leadAge, morph.noteLevel);
    // Kick ripple centre and the ripple's travelled radius.
    p[28] = RING[set][0]; p[29] = RING[set][1] + walk; 
    const kAge = Math.min(morph.kickAge, 9);
    p[30] = 0.4 + 9 * kAge; p[31] = onset(kAge, morph.kickLevel, 0.15) * Math.exp(-kAge / 0.35);
  },
  wgsl: /* wgsl */ `
struct MwHit { d: f32, mat: f32, uv: vec2f, id: f32 };

fn mw_sun() -> vec3f { return normalize(vec3f(S.p[1].z, S.p[1].w, S.p[2].x)); }
fn mw_hue() -> f32 { return S.p[1].y + F.morph2.x * 0.2; }
fn mw_sunCol() -> vec3f { return mix(vec3f(1.0, 0.82, 0.62), F.pal3.rgb / max(luma(F.pal3.rgb), 0.05) * 0.8, 0.35) * S.p[2].y; }

fn mw_drip(xz: vec2f) -> f32 {
  let a = 0.5 + 0.5 * sin(xz.x * 5.3 + sin(xz.y * 3.1) * 1.7 + S.p[2].w);
  let b = 0.5 + 0.5 * sin(xz.y * 4.7 + xz.x * 1.9 + 1.3);
  return pow(a, 6.0) * (0.4 + 0.6 * b);
}

// Melt deformation of an object-local point (base on y = 0, height H).
fn mw_warp(p: vec3f, H: f32, amt: f32) -> vec3f {
  var q = p;
  let st = S.p[0].y;
  let hy = sat(q.y / H);
  if (st < 0.5) {
    // Gravity sag: shorter, bulging at the foot.
    q.y = q.y * (1.0 + 1.1 * amt);
    let b = 1.0 + 0.5 * amt * (1.0 - hy) * (1.0 - hy);
    q = vec3f(q.x / b, q.y, q.z / b);
  } else if (st < 1.5) {
    // Drips: streaks of material sliding down.
    q.y += amt * H * 0.65 * mw_drip(q.xz * 2.2 / max(H, 0.6)) + amt * 0.12 * H * hy;
  } else if (st < 2.5) {
    // Drape: everything droops away from its core like a soft clock.
    q.y += amt * 0.8 * (q.x * q.x + 0.4 * q.z * q.z) / H * (0.3 + hy);
  } else {
    // Liquid wobble rolling up the form.
    let w = F.warp * 1.5;
    q.x += amt * 0.14 * H * sin(q.y * 4.0 / H + w + q.z * 2.0) * hy;
    q.z += amt * 0.14 * H * cos(q.y * 3.3 / H + w * 0.8 + q.x * 2.0) * hy;
    q.y += amt * 0.07 * H * sin(q.x * 3.0 + q.z * 2.0 + w * 1.3);
  }
  return q;
}

fn mw_box2(p: vec2f, b: vec2f) -> f32 { let q = abs(p) - b; return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0); }
fn mw_cyl(p: vec3f, r: f32, h: f32) -> f32 {
  let w = vec2f(length(p.xz) - r, abs(p.y - h) - h);
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0)));
}

fn mw_arcade(q: vec3f, halfW: f32) -> f32 {
  let wall = sdBox(q - vec3f(0.0, 1.35, 0.0), vec3f(halfW, 1.35, 0.32));
  let qx = fmod(q.x + 0.9, 1.8) - 0.9;
  let op = min(mw_box2(vec2f(qx, q.y - 0.8), vec2f(0.55, 0.8)), length(vec2f(qx, q.y - 1.6)) - 0.55);
  var d = max(wall, -op);
  d = min(d, sdBox(q - vec3f(0.0, 2.75, 0.0), vec3f(halfW + 0.1, 0.08, 0.4)));
  return d;
}

fn mw_pillar(q: vec3f, h: f32, r: f32) -> f32 {
  let flute = 0.012 * cos(atan2(q.z, q.x) * 14.0);
  var d = mw_cyl(q, r + flute, h * 0.5);
  d = min(d, sdBox(q - vec3f(0.0, 0.1, 0.0), vec3f(r * 1.45, 0.1, r * 1.45)));
  d = min(d, sdBox(q - vec3f(0.0, h, 0.0), vec3f(r * 1.4, 0.09, r * 1.4)));
  return d;
}

// Soft clock in its own frame (disc in xz), drooping beyond |x| > edge.
fn mw_clock(q: vec3f, R: f32, droop: f32, edge: f32) -> vec3f {
  var c = q;
  let ex = max(abs(c.x) - edge, 0.0);
  c.y += droop * ex * ex;
  let w = vec2f(length(c.xz) - R, abs(c.y) - 0.035);
  let d = min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0))) - 0.008;
  return vec3f(d * 0.5, c.x / R, c.z / R);
}

// Kick ripple: a soft ring lifting the ground as it runs out from the plaza centre.
fn mw_ripple(xz: vec2f) -> f32 {
  let r = length(xz - S.p[7].xy) - S.p[7].z;
  return 0.15 * S.p[7].w * exp(-r * r * 4.0);
}

fn mw_ground(p: vec3f) -> f32 {
  let rip = mw_ripple(p.xz);
  if (S.p[0].z < 0.5) {
    return p.y - 0.12 * sin(p.x * 0.35 + 1.0) * sin(p.z * 0.29 + 0.4) - 0.05 * sin(p.x * 0.9 + p.z * 0.7) - rip;
  }
  return p.y - rip;
}

fn mw_lampCol() -> vec3f { return palL(mw_hue() + 0.5 + 0.12 * S.p[5].y, 1.0); }

fn mw_try(res: ptr<function, MwHit>, d: f32, mat: f32, uv: vec2f, id: f32) {
  if (d < (*res).d) { (*res).d = d; (*res).mat = mat; (*res).uv = uv; (*res).id = id; }
}

fn mw_objects(p: vec3f) -> MwHit {
  var r: MwHit;
  r.d = 1e9; r.mat = 1.0; r.uv = vec2f(0.0); r.id = 0.0;
  if (p.y > 6.8) { r.d = p.y - 6.6; return r; }
  let amt = S.p[1].x;
  let lip = 0.6 / (1.0 + 0.9 * amt);
  let oset = S.p[0].x;
  if (oset < 0.5) {
    // Metaphysical plaza: arcade, two pillars, an orb on a plinth, a far tower.
    let b0 = length(p - vec3f(0.0, 1.4, 3.6)) - 7.6;
    if (b0 > 0.5) { r.d = b0; } else {
      mw_try(&r, mw_arcade(mw_warp(p - vec3f(0.0, 0.0, 3.6), 2.8, amt), 6.3) * lip, 1.0, vec2f(0.0), 0.0);
    }
    mw_try(&r, mw_pillar(mw_warp(p - vec3f(-2.4, 0.0, 0.6), 3.0, amt * 1.2), 3.0, 0.28) * lip, 1.0, vec2f(0.0), 1.0);
    mw_try(&r, mw_pillar(mw_warp(p - vec3f(2.7, 0.0, -0.7), 2.4, amt * 0.8), 2.4, 0.24) * lip, 1.0, vec2f(0.0), 2.0);
    let q = mw_warp(p - vec3f(0.6, 0.0, -1.3), 1.9, amt * 1.3);
    mw_try(&r, sdBox(q - vec3f(0.0, 0.45, 0.0), vec3f(0.5, 0.45, 0.5)) * lip, 1.0, vec2f(0.0), 3.0);
    mw_try(&r, (length(q - vec3f(0.0, 1.35, 0.0)) - 0.48) * lip, 4.0, vec2f(0.0), 4.0);
    let tq = mw_warp(p - vec3f(-6.5, 0.0, 9.0), 6.0, amt * 0.7);
    mw_try(&r, max(mw_cyl(tq, 0.9, 3.0), -mw_box2(vec2f(fmod(atan2(tq.z, tq.x) * 1.3, 0.9) - 0.45, fmod(tq.y, 1.2) - 0.6), vec2f(0.18, 0.32))) * lip, 1.0, vec2f(0.0), 5.0);
  } else if (oset < 1.5) {
    // Dead tree with a draped clock, a plinth with a clock sliding off, a clock pooled on the ground, an egg.
    let tq = mw_warp(p - vec3f(1.6, 0.0, 1.6), 3.0, amt * 0.6);
    var tr = sdCapsule(tq, vec3f(0.0), vec3f(0.25, 2.3, 0.0), 0.13);
    tr = smin(tr, sdCapsule(tq, vec3f(0.25, 2.2, 0.0), vec3f(-0.15, 2.45, -1.3), 0.06), 0.1);
    tr = smin(tr, sdCapsule(tq, vec3f(0.2, 1.7, 0.0), vec3f(1.3, 2.6, 0.3), 0.05), 0.1);
    mw_try(&r, tr * lip, 5.0, vec2f(0.0), 0.0);
    // Clock on the branch (branch runs along -z; droop across x).
    let ck = mw_clock(rotY(0.25) * (tq - vec3f(0.05, 2.42, -0.75)), 0.62, 1.3 + 1.2 * amt, 0.08);
    mw_try(&r, ck.x * lip, 2.0, ck.yz, 1.0);
    let pq = mw_warp(p - vec3f(-1.9, 0.0, 0.2), 1.2, amt * 0.5);
    mw_try(&r, sdBox(pq - vec3f(0.0, 0.55, 0.0), vec3f(0.65, 0.55, 0.65)) * lip, 1.0, vec2f(0.0), 2.0);
    let ck2 = mw_clock(rotY(-0.4) * (pq - vec3f(0.35, 1.14, 0.05)), 0.55, 0.9 + 1.6 * amt, 0.28);
    mw_try(&r, ck2.x * lip, 2.0, ck2.yz, 2.0);
    let ck3 = mw_clock(rotY(1.1) * (p - vec3f(0.4, 0.05 + 0.04 * sin(p.x * 3.0 + F.warp), -1.6)), 0.7, 0.15 * amt, 0.3);
    mw_try(&r, ck3.x * lip, 2.0, ck3.yz, 3.0);
    let eq = mw_warp(p - vec3f(-4.5, 0.0, 6.0), 3.2, amt);
    mw_try(&r, (length((eq - vec3f(0.0, 1.6, 0.0)) * vec3f(1.0, 0.7, 1.0)) - 1.15) * 0.7 * lip, 4.0, vec2f(0.0), 4.0);
  } else if (oset < 2.5) {
    // Endless field of pillars carrying orbs, rings and cubes.
    let cs = 3.4;
    let cid = floor(p.xz / cs);
    let lxz = (fract(p.xz / cs) - 0.5) * cs;
    let h = hash12(cid + S.p[2].w);
    let lp = vec3f(lxz.x, p.y, lxz.y);
    r.d = 1e9;
    if (h > 0.22) {
      let ph = 0.8 + 2.2 * fract(h * 7.3);
      let a = amt * (0.6 + 0.8 * fract(h * 3.1));
      let q = mw_warp(lp, ph + 0.8, a);
      r.d = 1e9;
      mw_try(&r, mw_pillar(q, ph, 0.22) * lip, 1.0, vec2f(0.0), h);
      let kind = fract(h * 13.7);
      let tp = q - vec3f(0.0, ph + 0.5, 0.0);
      if (kind < 0.4) {
        mw_try(&r, (length(tp) - 0.42) * lip, 4.0, vec2f(0.0), h);
      } else if (kind < 0.7) {
        mw_try(&r, sdTorus(rotX(1.5708) * (tp - vec3f(0.0, 0.1, 0.0)), vec2f(0.4, 0.08)) * lip, 3.0, vec2f(0.0), h);
      } else {
        mw_try(&r, (sdBox(rotY(h * 6.0) * tp, vec3f(0.3)) - 0.02) * lip, 1.0, vec2f(0.0), h + 0.5);
      }
    }
    // Keep steps short near cell walls (neighbours not evaluated).
    r.d = min(r.d, max(cs * 0.5 - max(abs(lxz.x), abs(lxz.y)), 0.0) + 0.2);
  } else {
    // Stairs to nowhere, a lone doorway and floating stones.
    let sq = mw_warp(p - vec3f(-2.6, 0.0, 2.0), 3.2, amt);
    let bb = sdBox(sq - vec3f(1.6, 1.6, 0.0), vec3f(1.9, 1.9, 0.9));
    if (bb > 0.4) { r.d = bb; } else {
      var st = 1e9;
      for (var i = 0; i < 7; i++) {
        let fi = f32(i);
        st = min(st, sdBox(sq - vec3f(fi * 0.45 + 0.225, (fi + 1.0) * 0.225, 0.0), vec3f(0.225, (fi + 1.0) * 0.225, 0.7)));
      }
      mw_try(&r, st * lip, 1.0, vec2f(0.0), 0.0);
    }
    let dq = mw_warp(p - vec3f(2.2, 0.0, 1.8), 2.8, amt * 1.1);
    var door = min(sdBox(dq - vec3f(-0.75, 1.2, 0.0), vec3f(0.18, 1.2, 0.18)), sdBox(dq - vec3f(0.75, 1.2, 0.0), vec3f(0.18, 1.2, 0.18)));
    door = min(door, sdBox(dq - vec3f(0.0, 2.5, 0.0), vec3f(1.05, 0.15, 0.24)));
    mw_try(&r, door * lip, 1.0, vec2f(0.0), 1.0);
    for (var i = 0; i < 3; i++) {
      let fi = f32(i);
      let c = vec3f(-0.8 + fi * 1.4, 2.3 + 0.5 * fi + 0.12 * sin(F.warp * 0.7 + fi * 2.0) + 0.1 * F.beatPulse, -0.6 + 0.9 * sin(fi * 2.3));
      let fq = mw_warp(p - c + vec3f(0.0, 0.5, 0.0), 1.0, amt * 1.2) - vec3f(0.0, 0.5, 0.0);
      let rs = 0.28 + 0.12 * fi;
      let sd = select(sdBox(rotY(fi + F.warp * 0.1) * fq, vec3f(rs * 0.8)) - 0.03, length(fq) - rs, i == 1);
      mw_try(&r, sd * lip, select(1.0, 4.0, i == 1), vec2f(0.0), 2.0 + fi);
    }
  }
  return r;
}

fn mw_map(p: vec3f) -> MwHit {
  var o = mw_objects(p);
  let g = mw_ground(p);
  let k = 0.05 + 0.45 * S.p[1].x;
  let d = smin(o.d, g, k);
  if (g < o.d) { o.mat = 0.0; }
  o.d = d;
  return o;
}

fn mw_dist(p: vec3f) -> f32 { return mw_map(p).d; }

fn mw_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * mw_dist(p + k.xyy * e) + k.yyx * mw_dist(p + k.yyx * e) +
                   k.yxy * mw_dist(p + k.yxy * e) + k.xxx * mw_dist(p + k.xxx * e) + vec3f(1e-9));
}

fn mw_shadow(ro: vec3f, rd: vec3f) -> f32 {
  var res = 1.0;
  var t = 0.03;
  for (var i = 0; i < 30; i++) {
    let h = mw_objects(ro + rd * t).d;
    res = min(res, 18.0 * h / t);
    if (res < 0.01 || t > 18.0 || (ro.y + rd.y * t > 7.0 && rd.y > 0.0)) { break; }
    t += clamp(h, 0.06, 0.9);
  }
  return sat(res);
}

fn mw_sky(rd: vec3f) -> vec3f {
  let hue = mw_hue();
  let y = rd.y;
  let sun = mw_sun();
  let sd = sat(dot(rd, sun));
  let zen = palL(hue + 0.55, 0.035);
  let hor = palL(hue + 0.08 + 0.1 * S.p[2].z, 0.24);
  var c = mix(hor, zen, pow(sat(y + 0.02), 0.45));
  c += mw_sunCol() * (pow(sd, 8.0) * 0.06 + pow(sd, 80.0) * 0.3);
  let skyStyle = S.p[0].w;
  if (skyStyle > 0.5 && skyStyle < 1.5) {
    // Spectrum horizon: thin glowing stripes above the mesas, one band each,
    // its history drifting along the azimuth.
    let ys = (y - 0.03) * 40.0;
    let b = floor(ys);
    if (b >= 0.0 && b < 9.0) {
      let az0 = atan2(rd.z, rd.x);
      let lvl = hist(0.04 + b * 0.1, fract(az0 * 0.3 + b * 0.17));
      let line = exp(-abs(fract(ys) - 0.5) * 9.0);
      c += palL(hue + 0.3 + b * 0.06, 0.25) * line * (0.1 + 1.6 * lvl * lvl) * (1.0 - b / 10.0);
    }
  } else if (skyStyle > 1.5) {
    // Long horizontal cloud bars lit from below by the sun.
    let pc = rd.xz / max(y + 0.1, 0.03);
    let cl = fbm3(vec3f(pc.x * 0.09 + S.p[5].x, pc.y * 0.35, 3.0), 2);
    let m = smoothstep(0.0, 0.25, cl) * smoothstep(0.02, 0.1, y) * smoothstep(0.6, 0.15, y);
    c = mix(c, palL(hue + 0.6, 0.05) + mw_sunCol() * 0.15 * pow(sd, 3.0), m * 0.8);
  }
  // Distant flat-topped mesas.
  let az = atan2(rd.z, rd.x);
  let mh = min(0.035, max(0.0, 0.02 + 0.035 * sin(az * 3.0 + 1.3) + 0.02 * sin(az * 7.7)));
  let mesa = smoothstep(mh + 0.002, mh - 0.002, y) * step(0.0, y + 0.01);
  c = mix(c, mix(hor, zen, 0.6) * 0.8, mesa * 0.8);
  // Sun disc.
  c += mw_sunCol() * smoothstep(0.99955, 0.9998, sd) * 3.0;
  return c;
}

fn mw_clockFace(uv: vec2f, id: f32) -> vec3f {
  let hue = mw_hue();
  let r = length(uv);
  let a = atan2(uv.x, -uv.y);
  var c = palL(hue + 0.1, 0.55) * 0.9;
  // Hour ticks glow with the 12 pitch classes.
  let seg = fract(a / TAU * 12.0 + 0.5) - 0.5;
  let tick = smoothstep(0.08, 0.03, abs(seg)) * smoothstep(0.66, 0.7, r) * smoothstep(0.9, 0.86, r);
  let pc = i32(fmod(floor(a / TAU * 12.0 + 0.5), 12.0));
  let ch = chromaAt(pc);
  c = mix(c, vec3f(0.02), tick);
  c += palL(hue + 0.4 + f32(pc) / 12.0, 1.0) * tick * ch * ch * 3.0;
  // Hands: minute = bar phase, hour = section progress.
  let ma = F.barPhase * TAU + id;
  let ha = F.sectionProgress * TAU + id * 2.0;
  let mdir = vec2f(sin(ma), -cos(ma));
  let hdir = vec2f(sin(ha), -cos(ha));
  let mh = smoothstep(0.035, 0.015, abs(uv.x * mdir.y - uv.y * mdir.x)) * step(0.0, dot(uv, mdir)) * step(dot(uv, mdir), 0.75);
  let hh = smoothstep(0.05, 0.025, abs(uv.x * hdir.y - uv.y * hdir.x)) * step(0.0, dot(uv, hdir)) * step(dot(uv, hdir), 0.5);
  c = mix(c, vec3f(0.015), max(mh, hh));
  c = mix(c, mix(vec3f(1.0, 0.75, 0.35), palL(hue, 0.6), 0.3), smoothstep(0.9, 0.93, r));
  return c;
}

fn mw_shade(pos: vec3f, rd: vec3f, h: MwHit, t: f32, deep: bool) -> vec3f {
  let hue = mw_hue();
  let n = mw_normal(pos, max(0.0008, 0.0006 * t));
  let sun = mw_sun();
  let sunC = mw_sunCol();
  var nb = n;
  var alb = palL(hue + 0.06, 0.4);
  var spe = 0.15;
  var rough = 20.0;
  var metal = 0.0;
  let melt = S.p[1].x;
  if (h.mat < 0.5) {
    let gt = S.p[0].z;
    if (gt < 0.5) {
      let rip = sin(pos.x * 7.0 + sin(pos.z * 1.3) * 2.0 + pos.z * 2.0);
      let rf = exp(-t * 0.12);
      nb = normalize(n + vec3f(0.06 * cos(pos.x * 7.0 + pos.z * 2.0), 0.0, 0.03 * rip) * rf);
      alb = palL(hue + 0.07, 0.3) * (0.92 + 0.08 * rip);
      spe = 0.05;
    } else if (gt < 1.5) {
      let cq = floor(pos.xz * 0.9);
      let chk = fmod(cq.x + cq.y, 2.0);
      let fq = abs(fract(pos.xz * 0.9) - 0.5);
      let grout = smoothstep(0.47, 0.49, max(fq.x, fq.y));
      alb = mix(palL(hue + 0.05, 0.42), palL(hue + 0.55, 0.05), chk);
      alb = mix(alb, vec3f(0.02), grout * 0.7);
      spe = 0.35;
      rough = 60.0;
    } else {
      alb = palL(hue + 0.1, 0.3);
      spe = 1.0;
      rough = 200.0;
    }
  } else if (h.mat < 1.5) {
    let v = fbm3(pos * vec3f(1.5, 3.0, 1.5), 2);
    alb = palL(hue + 0.28 + 0.12 * fract(h.id * 0.37) + 0.05 * v, 0.34 + 0.05 * v);
    spe = 0.12 + 0.6 * melt;
    rough = 30.0 + 60.0 * melt;
  } else if (h.mat < 2.5) {
    alb = mw_clockFace(h.uv, h.id);
    spe = 0.4; rough = 80.0;
  } else if (h.mat < 3.5) {
    alb = mix(vec3f(1.0, 0.72, 0.35), palL(hue + 0.05, 0.6), 0.35); metal = 1.0; spe = 1.0; rough = 60.0;
  } else if (h.mat < 4.5) {
    alb = mix(vec3f(0.9), palL(hue + 0.5, 0.7), 0.2); metal = 1.0; spe = 1.0; rough = 300.0;
  } else {
    alb = palL(hue + 0.9, 0.08); spe = 0.05;
  }
  let dif = sat(dot(nb, sun));
  var sh = 1.0;
  if (dif > 0.001) { sh = mw_shadow(pos + n * 0.02, sun); }
  let occ = sat(0.4 + 0.6 * mw_dist(pos + n * 0.25) / 0.25) * sat(0.6 + 0.4 * mw_dist(pos + n * 0.8) / 0.8);
  let skyA = mix(palL(hue + 0.08, 0.2), palL(hue + 0.55, 0.06), 0.5 + 0.5 * nb.y);
  let bounce = palL(hue + 0.07, 0.12) * sat(-nb.y * 0.5 + 0.5);
  let refl = reflect(rd, nb);
  let fre = pow(1.0 - sat(dot(nb, -rd)), 5.0);
  var c = alb * (1.0 - metal) * (sunC * dif * sh + (skyA * (0.5 + 0.5 * nb.y) * 0.85 + bounce * 0.7) * occ);
  let hl = pow(sat(dot(refl, sun)), rough) * sh * min((rough + 2.0) / 24.0, 2.5);
  let f0 = mix(vec3f(0.04), alb, metal);
  let fr = f0 + (vec3f(1.0) - f0) * fre;
  c += sunC * hl * spe * fr * 2.0;
  if (metal > 0.5 || (h.mat < 0.5 && S.p[0].z > 1.5)) {
    var rc = mw_sky(refl);
    if (refl.y < 0.0) { rc = palL(hue + 0.07, 0.08); }
    c += rc * fr * occ * select(0.6, 1.0, metal > 0.5);
  } else {
    c += mw_sky(refl) * fr * spe * 0.3 * occ;
  }
  // Wet sheen on melting surfaces glints on the hats.
  if (h.mat > 0.5 && h.mat < 1.5) {
    c += sunC * pow(sat(dot(refl, sun)), 120.0) * sh * melt * (0.5 + 2.0 * S.p[5].z);
  }
  // The melody lamp lights everything near it (unshadowed point light plus a glint).
  let lv = S.p[6].xyz - pos;
  let ld2 = dot(lv, lv);
  let ldir = lv * inverseSqrt(ld2);
  let li = S.p[6].w / (1.0 + ld2 * 0.9);
  let lc = mw_lampCol();
  c += lc * li * (alb * (1.0 - metal) * sat(dot(nb, ldir) * 0.8 + 0.2) * 1.4 + pow(sat(dot(refl, ldir)), rough * 0.5 + 8.0) * spe * fr * 2.0);
  // The kick ripple glows faintly as it runs across the ground.
  if (h.mat < 0.5) { c += palL(hue + 0.35, 0.45) * mw_ripple(pos.xz) * 6.0 * (0.4 + 0.6 * occ); }
  return c;
}

fn mw_trace(ro: vec3f, rd: vec3f, steps: i32, far: f32, jit: f32) -> vec2f {
  var t = jit;
  for (var i = 0; i < steps; i++) {
    let d = mw_dist(ro + rd * t);
    if (d < 0.0005 * t + 0.0005) { return vec2f(t, 1.0); }
    t += d;
    if (t > far || (rd.y > 0.0 && ro.y + rd.y * t > 7.0)) { break; }
  }
  return vec2f(t, 0.0);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[3].xyz;
  let cam = lookAt(ro, S.p[4].xyz, S.p[4].w);
  let rd = normalize(cam * vec3f(q, S.p[3].w));
  let far = 60.0;
  let tr = mw_trace(ro, rd, 100, far, 0.05 + 0.05 * ign(frag));
  var col = mw_sky(rd);
  let hue = mw_hue();
  let haze = palL(hue + 0.08, 0.2);
  if (tr.y > 0.5) {
    let pos = ro + rd * tr.x;
    let h = mw_map(pos);
    col = mw_shade(pos, rd, h, tr.x, false);
    // Mirror salt flat: one reflection trace.
    if (h.mat < 0.5 && S.p[0].z > 1.5) {
      let rr = reflect(rd, vec3f(0.0, 1.0, 0.0));
      let t2 = mw_trace(pos + vec3f(0.0, 0.02, 0.0), rr, 48, 30.0, 0.0);
      let fre = 0.25 + 0.6 * pow(1.0 - sat(-rd.y), 4.0);
      if (t2.y > 0.5) {
        let p2 = pos + vec3f(0.0, 0.02, 0.0) + rr * t2.x;
        let h2 = mw_objects(p2);
        let sun = mw_sun();
        let n2 = mw_normal(p2, 0.002);
        let a2 = palL(hue + 0.06 + 0.08 * fract(h2.id * 0.37), 0.4);
        let c2 = a2 * (mw_sunCol() * sat(dot(n2, sun)) + palL(hue + 0.3, 0.08));
        col = mix(col, c2, fre);
      } else {
        col = mix(col, mw_sky(rr), fre);
      }
    }
    let fog = 1.0 - exp(-max(tr.x - 6.0, 0.0) * 0.035);
    col = mix(col, haze, fog);
  }
  // Heat shimmer: anticipation warms the air near the horizon.
  let shimmer = exp(-abs(rd.y) * 30.0) * (0.03 + 0.08 * S.p[5].w);
  col += mw_sunCol() * shimmer * 0.3;
  // The melody lamp: a small hot sphere with a halo, hidden behind nearer surfaces.
  let lo = S.p[6].xyz - ro;
  let lt = dot(lo, rd);
  let lperp = length(lo - rd * lt);
  let vis = select(1.0, 0.0, tr.y > 0.5 && tr.x < lt - 0.2) * step(0.0, lt);
  let li = S.p[6].w;
  let core = smoothstep(0.17, 0.13, lperp);
  col += mw_lampCol() * vis * (core * (1.5 + 2.5 * li) + li * 0.012 / (lperp * lperp + 0.004));
  return vec4f(col, 1.0);
}
`,
});
