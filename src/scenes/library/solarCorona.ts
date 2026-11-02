import { raymarchScene } from '../raymarchScene';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Corona. You skim the surface of a star: boiling granulation (animated Voronoi cells with
 * dark intergranular lanes), supergranulation, sunspots with filamentary penumbrae and limb
 * darkening, under a glowing corona. Magnetic flux tubes rise out of active regions as
 * emissive coronal loops (torus arcs, glow-marched with sphere tracing), plasma flows along
 * them and prominences hang above the limb.
 *
 * The music drives the star:
 *  - Melody: a great braided loop stands ahead of you. Its apex rises and falls with the
 *    lead's pitch, it glows while a note is held, and each attack launches a knot of plasma
 *    from one footpoint over the top to the other, flaring the footpoints.
 *  - Kick: a Moreton shock wave rings out across the photosphere from the loop's foot,
 *    lighting the granulation and every loop it passes.
 *  - Snare: plasma surges up all the loops of the arcade from their footpoints.
 *  - Harmony: chord changes ease the loops' colour and swell the corona.
 *  - Form: anticipation darkens and tightens; the drop fires a flare and a coronal mass
 *    ejection. The drift over the surface and the boiling follow tempo and energy, and rest
 *    in silence; the heading turns a little with each bar.
 *
 * Events come from the shared morph: every reaction is scaled by its level squared and eased in,
 * and the loop's apex glides to each pitch instead of jumping.
 *
 * DNA: star type (red dwarf / sun / blue giant / orange giant / magnetar), loop
 * density + arcade size, camera rig (grazing / oblique / steep / inside an arcade),
 * granulation scale + spot density, loop form (arcades / tall isolated / twisted
 * / open plumes), drift heading, prominence style (arch / hedgerow / tornado),
 * corona extent + streamers.
 */

const st = {
  u: 0, v: 0, flow: 0, lastTime: -1,
  chordKey: 0, chordGlow: 0,
};

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
const fx = { lead: new Flare(0.15, 0.25), drift: new Flare(0.2, 0.3) };
/** Held-note glow and the loop's apex pitch, glided so neither jumps. */
const held = new Spring(0, 0.12);
const glide = new Spring(0, 0.35);
/** Mid and bass bands, glided so a hit swells the brightness instead of stepping it. */
const midS = new Spring(0, 0.15);
const bassS = new Spring(0, 0.15);

const ease = (x: number) => {
  const c = Math.min(Math.max(x, 0), 1);
  return c * c * (3 - 2 * c);
};

export default raymarchScene({
  meta: {
    id: 'solar-corona',
    name: 'Corona',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.3, 1],
    mood: { valence: 0.45, arousal: 0.7 },
    genres: { rock: 0.9, dubstep: 0.85, edm: 0.8, classical: 0.75, techno: 0.5, ambient: 0.4, hiphop: 0.4 },
    trails: 0.3,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    if (Math.abs(m.time - st.lastTime) > 0.5) {
      st.u = 0; st.v = 0; st.flow = 0; st.chordGlow = 0;
      held.reset(0);
      glide.reset(Math.max(-1, Math.min(1, m.leadPitch)));
      st.chordKey = m.chord && m.chord.root >= 0 ? (((m.chord.root * 7) % 12) / 12) : 0;
    }
    st.lastTime = m.time;
    const h = (k: number) => {
      const x = Math.sin((g[k % 8] * 57.7 + k * 13.37) * 6.11) * 43758.5453;
      return x - Math.floor(x);
    };
    const ant = m.anticipation;
    const drop = m.dropPulse;
    const tempo = Math.min(Math.max(m.bpm / 120, 0.6), 1.6);

    morph.update(m, ctx.dt, g);
    const lit = 0.2 + 0.5 * held.update(m.leadHeld * morph.presence ** 2, dt);
    const pitchL = glide.update(Math.max(-1, Math.min(1, m.leadPitch)), dt);
    const mid = midS.update(m.mid * morph.presence, dt);
    const bass = bassS.update(m.bass, dt);
    const target = m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : st.chordKey;
    let dh = target - st.chordKey;
    dh -= Math.round(dh);
    st.chordKey += dh * (1 - Math.exp(-dt / 0.5));
    st.chordGlow += (m.chordPulse - st.chordGlow) * (1 - Math.exp(-dt / (m.chordPulse > st.chordGlow ? 0.1 : 0.6)));
    const kickEnv = fx.drift.update(morph.kicks, morph.kickAge, morph.kickLevel);

    const rig = Math.floor(g[2] * 4);
    // Drift over the surface: heading from DNA, speed from tempo x energy, surging on kicks.
    const head = g[5] * 6.28;
    const spd = (0.12 + 0.3 * h(51)) * tempo * (0.12 + 1.1 * m.energySlow + 0.6 * kickEnv + 1.5 * drop);
    st.u += dt * spd * Math.cos(head);
    st.v += dt * spd * Math.sin(head);
    st.flow += dt * tempo * (0.12 + 0.9 * m.energy + 0.5 * kickEnv + 1.5 * drop + 0.6 * ant);

    const roll = (h(21) - 0.5) * 0.25;
    let focal = 1.5;
    // The heading turns a little each bar, eased in at the downbeat.
    const yaw = h(22) * 6.28 + 0.035 * (Math.max(m.barIndex, 0) + ease(m.barPhase * 3));
    let alt: number;
    let pitch: number;
    if (rig === 0) {
      // Grazing: just above the photosphere, limb on the horizon.
      alt = 0.5 + 0.8 * h(23) + 0.3 * ant;
      pitch = -0.04 - 0.08 * h(24);
      focal = 1.25 + 0.3 * h(25);
    } else if (rig === 1) {
      // Oblique: mid altitude, horizon high in the frame.
      alt = 3 + 3 * h(23) - 0.8 * ant + 1.2 * drop;
      pitch = -0.28 - 0.2 * h(24);
      focal = 1.3 + 0.3 * h(25);
    } else if (rig === 2) {
      // Steep: looking down into the arcade, the horizon kept at the top of the frame.
      alt = 3.5 + 2 * h(23) - 1 * ant + 1.5 * drop;
      pitch = -0.55 - 0.15 * h(24);
      focal = 1.2 + 0.3 * h(25);
    } else {
      // Inside a dense arcade, loops towering on both sides.
      alt = 1.4 + 1.2 * h(23) + 0.3 * ant;
      pitch = -0.12 - 0.1 * h(24);
      focal = 1.15 + 0.2 * h(25);
    }
    const fw = [Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)];
    // S.p[0].x: plasma knot strength, .z: glided melody pitch (the camera sits at x = z = 0).
    p[0] = onset(morph.leadAge, morph.noteLevel, 0.15); p[1] = alt; p[2] = pitchL; p[3] = roll;
    p[4] = fw[0]; p[5] = fw[1]; p[6] = fw[2]; p[7] = focal;
    // S.p[2]: melody loop brightness, pluck age, drift offset.
    p[8] = lit + 4.0 * fx.lead.update(morph.notes, morph.leadAge, morph.noteLevel);
    p[9] = Math.min(morph.leadAge, 9);
    p[10] = st.u; p[11] = st.v;
    const type = Math.floor(g[0] * 5);
    p[12] = type;
    p[13] = [0.13, 0.21, 0.3, 0.17, 0.1][type] * (0.85 + 0.3 * ctx.intensity) * (1 - 0.3 * ant) * (rig === 0 ? 1.7 : rig === 3 ? 1.3 : 1);
    p[14] = [0.2, 0.12, 0.07, 0.17, 0.1][type] * (0.4 + 0.5 * g[3]) * (rig === 0 ? 0.55 : rig === 3 ? 0.8 : 1.1);
    p[15] = [0.7, 0.35, 0.1, 0.5, 0.25][type] * (0.5 + h(31));
    p[16] = (2.2 + 2.8 * (1 - g[1])) * (rig === 3 ? 0.75 : 1);
    p[17] = rig === 3 ? 0.7 + 0.25 * g[1] : 0.3 + 0.55 * g[1];
    p[18] = Math.floor(g[4] * 4);
    p[19] = (0.8 + 0.4 * h(41)) * (rig === 2 ? 1.6 : 1) * (1 + 0.25 * m.energySlow - 0.2 * ant + 0.35 * drop);
    p[20] = 0.04 + 0.05 * h(42) + 0.02 * bass;
    p[21] = Math.floor(g[6] * 3);
    p[22] = h(43) * 1000;
    p[23] = 0.5 + 0.8 * g[7];
    p[24] = (0.6 + 0.6 * g[7]) * (1 + 0.6 * drop + 0.5 * st.chordGlow);
    p[25] = [0.12, 0.35, 0.7, 0.25, 0.85][type] + 0.1 * h(44) + 0.05 * ev[0] + 0.1 * st.chordKey;
    // S.p[6].zw: kick shock wave radius and amplitude.
    const kAge = Math.min(morph.kickAge, 9);
    p[26] = 0.4 + kAge * 14;
    p[27] = onset(kAge, morph.kickLevel, 0.25) * Math.exp(-kAge * 2.2);
    p[28] = (0.75 + 0.35 * m.energySlow + 0.25 * mid) * (1 + 1.2 * drop) * (1 - 0.25 * ant) * [1.3, 1, 0.8, 1.1, 1.8][type];
    // S.p[7].yz: snare surge age and strength; w: flow phase.
    p[29] = Math.min(morph.snareAge, 9);
    p[30] = onset(morph.snareAge, morph.snareLevel, 0.25);
    p[31] = st.flow;
  },
  wgsl: /* wgsl */ `
const SC_RS: f32 = 20.0;

var<private> sc_hc: vec2f;    // melody loop centre (chart)
var<private> sc_hdir: vec2f;  // its footpoint axis
var<private> sc_ha: f32;      // half the footpoint separation

fn sc_center() -> vec3f { return vec3f(0.0, -SC_RS, 0.0); }

/** Chart: x/z = surface coordinates (with drift offset), y = height above the photosphere. */
fn sc_chart(p: vec3f) -> vec3f {
  let d = p - sc_center();
  let r = length(d);
  let n = d / r;
  let uv = vec2f(atan2(n.x, n.y), atan2(n.z, n.y)) * SC_RS + S.p[2].zw;
  return vec3f(uv.x, r - SC_RS, uv.y);
}

fn sc_loopCol(k: f32, lum: f32) -> vec3f {
  return mix(palRampL(sat(S.p[6].y + k), lum), vec3f(lum), 0.25);
}

/** Kick shock wave intensity at chart position uv. */
fn sc_wave(uv: vec2f) -> f32 {
  let d = length(uv - sc_hc) - S.p[6].z;
  let w = 0.5 + 0.06 * S.p[6].z;
  return exp(-d * d / (w * w)) * S.p[6].w;
}

/** Coronal loop field: x = distance to nearest tube, y = emission weight, z = colour key, w = step limit. */
fn sc_loops(c: vec3f) -> vec4f {
  let cs = S.p[4].x;
  let uv = c.xz;
  let h = c.y;
  let cell = floor(uv / cs);
  let f = uv - (cell + 0.5) * cs;
  let edge = cs * 0.5 - max(abs(f.x), abs(f.y));
  let seed = S.p[5].z;
  let hc = hash12(cell + seed);
  if (hc > S.p[4].y) { return vec4f(1e3, 0.0, 0.0, max(edge, 0.0) + 0.05); }
  let h2 = hash12(cell * 1.7 + seed + 3.1);
  let h3 = hash12(cell * 2.3 + seed + 7.7);
  let al = h2 * PI;
  let dir = vec2f(cos(al), sin(al));
  var x = dot(f, dir);
  var y = dot(f, vec2f(-dir.y, dir.x));
  let form = i32(S.p[4].z);
  let hs = S.p[4].w * (0.7 + 0.6 * h3);
  let w = S.p[5].x * (0.7 + 0.6 * hash11(hc * 91.0));
  let ph = S.p[7].w;
  var d = 1e3;
  var along = 0.0;
  // Everything stays inside 0.45 cs of the cell centre (no clipping at cell edges).
  let n = select(select(select(2.0, 0.0, form == 1), 1.0, form == 2), 4.0, form == 3);
  let sp = select(w * 4.0, cs * 0.075, form == 3);
  let room = max(0.45 * cs - n * sp - w * 3.0, 0.12 * cs);
  let cdepK = select(0.5 - 0.9 * hash11(h2 * 37.0), -0.6, form == 1);
  let a = room / ((1.0 + 0.12 * n + 0.1) * sqrt(1.0 + max(-cdepK, 0.0) * max(-cdepK, 0.0))) * (0.65 + 0.35 * h3) * select(1.0, 0.6, form == 3);
  let cdep = a * cdepK;
  let yi = clamp(round(y / sp), -n, n);
  var yy = y - sp * yi;
  let sc = 1.0 + 0.12 * yi + 0.1 * sin(yi * 7.1 + hc * 20.0);
  // Organic wiggle so strands never look like rigid hoops; it drifts with the flow phase.
  let ang0 = atan2(h / hs + cdep, x);
  yy += sin(ang0 * 4.0 + yi * 3.0 + ph * 0.5 + hc * 9.0) * w * 0.9;
  if (form == 2) {
    // Twisted: neighbouring strands shear and braid around each other.
    let ang = atan2(h + cdep, x);
    yy += sin(ang * 3.0 + yi * 2.0 + ph * 0.3) * w * 2.5;
    x += sin(ang * 2.0 + yi) * w * 2.0;
  }
  let R = sqrt(a * a + cdep * cdep) * sc;
  let hh = h / hs;
  let q = vec2f(length(vec2f(x, hh + cdep)) - R, yy);
  d = length(q) * min(hs, 1.0);
  along = atan2(hh + cdep, x) / PI;
  if (along < -0.5) { along += 2.0; }
  // Brightness: plasma blobs flowing along, snare surge up from both footpoints, kick wave,
  // spectrum per region.
  let flow = 0.55 + 0.45 * sin(along * 14.0 - ph * 3.0 + hc * 30.0);
  let up = sat(1.0 - abs(2.0 * along - 1.0));
  let sAge = S.p[7].y;
  let surge = exp(-pow((up - sAge * 2.6) * 3.0, 2.0)) * S.p[7].z * exp(-sAge * 2.5) * 5.0;
  let lvl = spec(0.04 + 0.85 * h3);
  let foot = 1.0 + 1.4 * pow(sat(abs(2.0 * along - 1.0)), 6.0);
  let strand = 0.4 + 0.6 * hash11(floor(y / max(w * 3.0, 1e-3)) + hc * 13.0);
  let kw = sc_wave(uv);
  let em = (0.3 + 0.7 * flow + surge + 3.0 * kw + 1.2 * S.p[6].w) * (0.35 + 1.2 * lvl * lvl) * foot * strand * step(0.0, h);
  let wgt = exp(-d * d / (w * w)) + 0.12 * exp(-d / (w * 3.0));
  return vec4f(d - w, em * wgt / w, h3, max(edge, 0.0) + 0.05);
}

/** The melody loop: x = distance, y = emission. A braided half-ellipse whose apex follows pitch. */
fn sc_hero(c: vec3f) -> vec2f {
  let f = c.xz - sc_hc;
  let x = dot(f, sc_hdir);
  let y = dot(f, vec2f(-sc_hdir.y, sc_hdir.x));
  let a = sc_ha;
  let H = a * (0.55 + 0.75 * (clamp(S.p[0].z, -1.0, 1.0) + 1.0));
  let qn = vec2f(x / a, max(c.y, 0.0) / H);
  let ln = length(qn);
  let th = atan2(qn.y, qn.x);
  let w = 0.035 + 0.01 * a;
  let dr = (ln - 1.0) * min(a, H);
  // Three strands braided around the centre line, plus a soft plasma sheath.
  let br = w * 2.6;
  var d = 1e3;
  for (var k = 0; k < 3; k++) {
    let phs = th * 7.0 + f32(k) * 2.094 + S.p[7].w * 0.4;
    d = min(d, length(vec2f(dr - br * cos(phs), y - br * sin(phs))));
  }
  d = max(d, -c.y);
  let dc = length(vec2f(dr, y));
  // A knot of plasma launched over the top at each attack.
  let s = th / PI;
  let age = S.p[2].y;
  let kp = (s - min(age * 1.4, 1.2)) * 7.0;
  let knot = exp(-kp * kp) * exp(-age * 1.0) * 9.0 * S.p[0].x;
  let em = (S.p[2].x + knot) * (1.0 + 1.5 * pow(abs(2.0 * s - 1.0), 8.0));
  let sheath = exp(-dc * dc / (36.0 * w * w)) * 0.06;
  let wgt = exp(-d * d / (w * w)) + 0.08 * exp(-d / (w * 3.0)) + sheath;
  return vec2f(min(d - w, dc - 6.0 * w), em * wgt / w);
}

/** Prominences on a coarse grid: x = density, y = step limit. */
fn sc_prom(c: vec3f) -> vec2f {
  let gs = 28.0;
  let cell = floor(c.xz / gs);
  let hp = hash12(cell + S.p[5].z + 11.0);
  let ctr = (cell + 0.3 + 0.4 * vec2f(hp, fract(hp * 7.3))) * gs;
  let f = c.xz - ctr;
  let al = hp * 6.0;
  let x = dot(f, vec2f(cos(al), sin(al)));
  let y = dot(f, vec2f(-sin(al), cos(al)));
  let h = c.y;
  let style = i32(S.p[5].y);
  let size = 3.0 + 3.0 * fract(hp * 13.0);
  let bnd = length(vec3f(x, h - size * 0.4, y)) - size * 1.35;
  if (bnd > 0.0) { return vec2f(0.0, bnd + 0.1); }
  let n = noise3fast(vec3f(x * 0.7, h * 1.2 - S.p[7].w * 0.2, y * 0.7 + hp * 9.0));
  var base = 0.0;
  if (style == 0) {
    // Arch: a thick, ragged magnetic arch.
    let q = vec2f(length(vec2f(x, h + size * 0.2)) - size, y);
    base = exp(-dot(q, q) / 0.6);
  } else if (style == 1) {
    // Hedgerow: a soft curtain, ragged on top.
    let e = length(vec2f(x / size, h / (size * 0.55)));
    base = exp(-y * y / 0.2) * smoothstep(1.0, 0.55, e + n * 0.25);
  } else {
    // Tornado: a twisted column fanning into a canopy.
    let rw = 0.45 + 0.12 * h + 0.6 * smoothstep(size * 0.6, size, h);
    let ang = atan2(y, x) + h * 1.3 - S.p[7].w * 0.5;
    let r = length(vec2f(x, y)) * (1.0 + 0.25 * sin(ang * 3.0));
    base = exp(-r * r / (rw * rw)) * smoothstep(size, size * 0.75, h);
  }
  let thr = noise3fast(vec3f(x * 3.0, h * 0.5 - S.p[7].w * 0.3, y * 3.0));
  let fil = pow(sat(1.0 - abs(thr) * 2.2), 3.0);
  let dens = sat(base * 1.5 + n * 0.5 - 0.35) * (0.12 + 1.2 * fil) * smoothstep(0.0, 0.4, h);
  return vec2f(dens, 0.15);
}

fn sc_surface(c: vec3f, mu: f32, fp: f32) -> vec3f {
  let gsz = S.p[3].z;
  let uv = c.xz / gsz;
  let aa = sat(1.6 - fp / gsz * 3.0);
  let tt = S.p[7].w * 0.12;
  // Voronoi granulation (F1, F2).
  let ic = floor(uv);
  var d1 = 9.0;
  var d2 = 9.0;
  var hid = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cc = ic + vec2f(f32(i), f32(j));
      let hh = hash33(vec3f(cc, 3.0));
      let o = 0.5 + 0.38 * sin(tt * (0.6 + hh.z) + hh.xy * 6.28);
      let dv = cc + o - uv;
      let dd = dot(dv, dv);
      if (dd < d1) { d2 = d1; d1 = dd; hid = hh.z; } else if (dd < d2) { d2 = dd; }
    }
  }
  // Bright domed granules, narrow soft lanes.
  let lane = sat((sqrt(d2) - sqrt(d1)) * 3.0);
  let dome = 1.0 - 0.35 * sat(sqrt(d1));
  let cellB = mix(0.66, smoothstep(0.0, 0.55, lane) * dome * (0.8 + 0.2 * hid), aa);
  let sg = fbmFast(vec3f(c.xz * 0.06, tt * 0.3), 3);
  let mott = fbmFast(vec3f(c.xz * 0.7, tt * 0.5), 3);
  var I = (0.55 + 0.45 * cellB) * (0.9 + 0.3 * sg) * (0.88 + 0.3 * mott);
  // Sunspots: umbra / penumbra with radial filaments, plus bright faculae nearby.
  let ss = 16.0;
  let sc = floor(c.xz / ss);
  let hs = hash12(sc + 5.0 + S.p[5].z);
  var spotT = 0.0;
  if (hs < S.p[3].w) {
    let ctr = (sc + 0.25 + 0.5 * hash33(vec3f(sc, 9.0)).xy) * ss;
    let dv = c.xz - ctr;
    let rr = length(dv);
    let R = 1.2 + 2.0 * fract(hs * 17.0);
    let fil = 0.75 + 0.25 * sin(atan2(dv.y, dv.x) * 40.0 + noise3fast(vec3f(dv * 2.0, 1.0)) * 3.0);
    let pen = smoothstep(R, R * 0.9, rr);
    let umb = smoothstep(R * 0.5, R * 0.38, rr);
    I *= mix(1.0, 0.35 * fil, pen);
    I *= mix(1.0, 0.12, umb);
    I *= 1.0 + 0.25 * exp(-pow((rr - R * 1.5) / R, 2.0));
    spotT = pen;
  }
  // Kick: the shock wave brightens the granulation it crosses.
  I *= 1.0 + 2.4 * sc_wave(c.xz) * (0.5 + 0.5 * cellB);
  // Melody: the loop's footpoints flare.
  let fa = c.xz - (sc_hc + sc_hdir * sc_ha);
  let fb = c.xz - (sc_hc - sc_hdir * sc_ha);
  let fpt = exp(-dot(fa, fa) * 0.6) + exp(-dot(fb, fb) * 0.6);
  I *= 1.0 + fpt * (0.5 * S.p[2].x + 1.2 * max(S.p[2].x - 0.8, 0.0));
  // Limb darkening.
  I *= 0.6 + 0.4 * pow(mu, 0.5);
  let key = S.p[6].y - 0.15 + 0.25 * I - 0.2 * spotT;
  return mix(palRampL(sat(key), 1.0), vec3f(1.0), 0.2 + 0.3 * sat(I - 0.8)) * I * S.p[3].y;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = vec3f(0.0, S.p[0].y, 0.0);
  let fw = normalize(S.p[1].xyz);
  let cam = lookAt(ro, ro + fw, S.p[0].w);
  let rd = normalize(cam * vec3f(q, S.p[1].w));
  let Rs = SC_RS;
  let C = sc_center();
  let bright = S.p[7].x;
  // The melody loop stands where the view meets the surface (clamped to a comfortable range).
  let fl = max(length(fw.xz), 1e-3);
  let fwxz = fw.xz / fl;
  let D = clamp(ro.y * fl / max(-fw.y, 0.01), 5.0, 8.5);
  sc_hc = S.p[2].zw + fwxz * D;
  sc_hdir = vec2f(-fwxz.y, fwxz.x);
  sc_ha = 1.3 + 0.1 * ro.y;
  let Hmax = max(8.0 * S.p[4].w + 2.0, sc_ha * 2.2 + 0.5);

  // Star surface and corona shell intersections.
  let oc = ro - C;
  let b = dot(oc, rd);
  let cc = dot(oc, oc);
  let disc = b * b - cc + Rs * Rs;
  var tSurf = 1e9;
  if (disc > 0.0) {
    let t0 = -b - sqrt(disc);
    if (t0 > 0.0) { tSurf = t0; }
  }
  let Ro = Rs + Hmax;
  let disc2 = b * b - cc + Ro * Ro;
  var col = vec3f(0.0);
  var trans = 1.0;
  var emis = vec3f(0.0);
  let heroCol = mix(sc_loopCol(0.75, 1.0), vec3f(1.0, 0.96, 0.9), 0.25);
  let snEnv = S.p[7].z * exp(-S.p[7].y * 5.0);
  if (disc2 > 0.0) {
    let sq = sqrt(disc2);
    var t = max(-b - sq, 0.0);
    let tEnd = min(-b + sq, tSurf);
    t += ign(frag) * 0.05;
    for (var i = 0; i < 64; i++) {
      if (t >= tEnd) { break; }
      let p = ro + rd * t;
      let c = sc_chart(p);
      let L = sc_loops(c);
      let hl = sc_hero(c);
      let pr = sc_prom(c);
      var ds = min(L.w, max(L.x * 0.75, 0.03 + t * 0.003));
      ds = min(ds, max(hl.x * 0.7, 0.02 + t * 0.002));
      ds = min(ds, pr.y);
      // Chromosphere / spicule fuzz near the surface.
      if (c.y < 0.6) { ds = min(ds, 0.25); }
      ds = clamp(ds, 0.02, 3.0);
      // Emission-absorption so legs seen end-on saturate instead of blowing out.
      let sig = L.y * 0.12;
      let ab = exp(-sig * ds);
      emis += trans * sc_loopCol(0.15 + 0.45 * L.z, 1.0) * L.y * 0.1 * bright * (1.0 - ab) / max(sig, 1e-4);
      trans *= mix(1.0, ab, 0.5);
      let hs = hl.y * 0.12;
      emis += trans * heroCol * hl.y * 0.1 * (1.0 - exp(-hs * ds)) / max(hs, 1e-4);
      if (pr.x > 0.0) {
        let pc = palRampL(sat(S.p[6].y - 0.25), 1.0);
        emis += trans * pc * pr.x * ds * 0.16 * bright * (1.0 + 0.8 * snEnv);
        trans *= exp(-pr.x * ds * 0.12);
      }
      if (c.y < 0.6) {
        let sp = pow(sat(noise3fast(vec3f(c.x * 3.0, c.y * 0.6 - S.p[7].w * 0.2, c.z * 3.0)) + 0.3), 3.0);
        emis += trans * palRampL(sat(S.p[6].y - 0.1), 1.0) * sp * smoothstep(0.6, 0.0, c.y) * ds * 0.06 * bright * (1.0 + F.hat + 3.0 * snEnv);
      }
      t += ds;
      if (trans < 0.05) { break; }
    }
  }
  if (tSurf < 1e8) {
    let p = ro + rd * tSurf;
    let n = normalize(p - C);
    let mu = sat(dot(n, -rd));
    var sc = sc_surface(sc_chart(p), mu, tSurf * 2.0 / (F.res.y * S.p[1].w) / max(mu, 0.12));
    // Flare ribbons light up the surface on drops.
    sc *= 1.0 + 0.6 * F.dropPulse;
    col = sc * trans;
    // Atmospheric depth: far surface fades into the glow.
    col = mix(col, palRampL(S.p[6].y, 0.15) * S.p[3].y * 2.0, sat(tSurf / 120.0) * 0.4);
  } else {
    // Corona: glow falls off with altitude of the ray's closest approach, with streamers.
    let tc = max(-b, 0.0);
    let pc = ro + rd * tc;
    let alt = max(length(pc - C) - Rs, 0.0);
    let ang = atan2(rd.x, rd.z) * 3.0 + rd.y * 4.0;
    let strm = 0.6 + 0.6 * pow(sat(noise3fast(vec3f(ang, alt * 0.05, 3.0)) + 0.5), 3.0);
    let hc = S.p[5].w * 1.2;
    let corona = (exp(-alt / hc) + 0.25 * exp(-alt / (hc * 4.0))) * strm * S.p[6].x * exp(min(-b, 0.0) / (hc * 3.0));
    col += palRampL(sat(S.p[6].y + 0.1), 1.0) * corona * 0.025 * bright * (1.0 + 0.5 * F.anticipation);
    // Stars faintly beyond the glare.
    let g = rd * 200.0;
    let hs = hash13(floor(g));
    col += vec3f(0.8, 0.85, 1.0) * smoothstep(0.996, 1.0, hs) * exp(-dot(fract(g) - 0.5, fract(g) - 0.5) * 30.0) * 0.6;
  }
  col += emis;
  // CME on drops: an expanding luminous shell erupting from the surface ahead.
  let drop = F.dropPulse;
  if (drop > 0.02) {
    let fxz = normalize(vec3f(fw.x, 0.0, fw.z) + vec3f(1e-4, 0.0, 0.0));
    let ctr = C + normalize(ro - C + fxz * 10.0) * Rs;
    let R = 0.5 + (1.0 - drop) * 16.0;
    let oc2 = ro - ctr;
    let b2 = dot(oc2, rd);
    let h2 = b2 * b2 - dot(oc2, oc2) + R * R;
    if (h2 > 0.0) {
      let sq2 = sqrt(h2);
      for (var k = 0; k < 2; k++) {
        let tk = -b2 + select(-sq2, sq2, k == 1);
        if (tk > 0.0 && tk < tSurf) {
          let pk = ro + rd * tk;
          let nk = (pk - ctr) / R;
          let up = dot(nk, normalize(ctr - C));
          let mu2 = abs(dot(nk, rd));
          let lobes = pow(0.5 + 0.5 * noise3(nk * 2.5 + vec3f(0.0, S.p[7].w * 0.2, 0.0)), 2.0) * 1.8;
          col += palRampL(0.85, 1.0) * lobes * smoothstep(-0.1, 0.4, up) / (mu2 + 0.12) * 0.035 * pow(drop, 1.5) * bright;
        }
      }
    }
  }
  return vec4f(col, 1.0);
}
`,
});
