import { raymarchScene } from '../raymarchScene';
import { Morph } from '../morph';
import { Spring } from '../anim';

/**
 * Endless brutalist megacity voids. DNA picks one of four layout families (a vertical
 * atrium shaft ringed with galleries, a terraced canyon spanned by bridges, a stepped
 * amphitheatre pit ringed by pylons, or an infinite lattice of beams and floating
 * blocks), the camera rig (crane, dolly, fly-through), the material (raw board-formed
 * concrete, polished black stone, white marble), the time of day (haze day, dusk,
 * night), the sun angle, module scale, symmetry and what the beat does (pistoning
 * slabs, a spectrum waterfall in the windows, or a light sequencer along the floors).
 * Thousands of tiny windows each listen to one spectrum band. Anticipation thickens
 * the haze and blacks out the city; the drop floods every window and the light shafts.
 * The melody is a floor of light (a tier ring in the amphitheatre) set at the note
 * pitch that lights its windows and washes the concrete on each attack; snares flare the
 * light shafts; travel and turning run on a beat-and-energy clock.
 * Events come from the shared morph: every reaction (pistons, the melody floor, the shafts, strip
 * and window lights) scales with its event's level (which includes how loud the passage is) and
 * rises over about 0.1 s; the floor glides to each pitch and the drop eases in as a surge, so a
 * faint intro motif only lights a dim floor.
 */
const TAU = Math.PI * 2;

/** Event source: ages and levels (this world does not use the morph's shape coordinates). */
const morph = new Morph(1);
/**
 * A light answering one kind of event: its level squared (the level already carries how loud the
 * passage is, so a faint intro hit stays a glimmer while a full-mix hit lands fully), eased in over
 * `rise` seconds and fading with time constant `decay`. A new event rises from whatever is still
 * lit, so a quick retrigger never cuts the previous light off.
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
const fx = { lead: new Flare(0.25, 0.5), kick: new Flare(0.15, 0.25), snare: new Flare(0.15, 0.15) };
/** The pistons, the held melody and the floor's pitch, glided so none of them jumps in a frame. */
const piston = new Spring(0, 0.1);
const held = new Spring(0, 0.1);
const pitch = new Spring(0, 0.35);
const hat = new Spring(0, 0.06);
/** The energy driving the travel clock, glided so a transient never jolts the camera. */
const energy = new Spring(0, 0.15);

// Music clocks (travel, turn) and envelopes, reset on seeks.
const st = { T: 0, sp: 0, chord: 0, lastTime: -1 };

export default raymarchScene({
  meta: {
    id: 'brutalist-megastructure',
    name: 'Megastructure',
    // Representational (a recognizable object or place): the show is abstract only.
    auto: false,
    energy: [0.3, 0.95],
    mood: { valence: 0.35, arousal: 0.6 },
    genres: { techno: 1, dnb: 0.85, rock: 0.75, ambient: 0.45, dubstep: 0.6, edm: 0.5, synthwave: 0.4, hiphop: 0.4 },
    trails: 0.12,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const layout = Math.floor(g[0] * 4) % 4;
    const rig = Math.floor(g[1] * 3) % 3;
    const mat = Math.floor(g[3] * 3) % 3;
    const light = Math.floor(g[5] * 3) % 3;
    const grammar = Math.floor(g[7] * 3) % 3;
    const s = 0.8 + 0.7 * g[4];
    const H = 3.0 * s;
    morph.update(m, ctx.dt, g);
    const antic = m.anticipation;
    // The drop as the morph's surge: it swells in, never a one-frame jump.
    const drop = morph.surge;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    if (Math.abs(m.time - st.lastTime) > 0.5) {
      st.T = m.time * 0.6; st.sp = m.time * 0.12; st.chord = 0;
      piston.reset(0); held.reset(0); pitch.reset(m.leadPitch); hat.reset(0); energy.reset(m.energy);
    }
    st.lastTime = m.time;
    // Travel and turning advance with the beat and the energy, and rest in silence.
    const act = Math.min(1, 1.6 * m.energySlow);
    const beats = (m.bpm / 60) * act * (0.35 + 0.65 * energy.update(m.energy, dt) + 0.8 * drop);
    st.T += dt * beats * 0.6 * (1 - 0.5 * antic);
    st.sp += dt * beats * 0.12;
    // The melody floor: swells on each note by its strength, glows while the note is held.
    const leadEnv = Math.max(fx.lead.update(morph.notes, morph.leadAge, morph.noteLevel), held.update(0.3 * m.leadHeld * morph.presence ** 2, dt));
    const leadPitch = pitch.update(m.leadPitch, dt);
    const kickEnv = fx.kick.update(morph.kicks, morph.kickAge, morph.kickLevel);
    const snareEnv = fx.snare.update(morph.snares, morph.snareAge, morph.snareLevel);
    const hatL = hat.update(m.hat * morph.presence ** 2, dt);
    st.chord += (m.chordPulse - st.chord) * (1 - Math.exp(-dt / 0.2));

    // Layout dimension: shaft half-width / canyon half-width / amphitheatre tread / lattice cell.
    const dim = [11 + 9 * g[4], 7 + 5 * g[4], 3.2 * s, 15 + 9 * g[4]][layout];
    const shape = g[6] < 0.5 ? 0 : 1; // square vs round shaft/pit, overhang vs setback canyon
    const T = st.T;
    const sp = st.sp;
    let ro: number[];
    let ta: number[];
    let roll = 0;
    let fov = 1.25 + 0.25 * g[4];
    if (layout === 0) {
      const rc = dim * 0.22;
      if (rig === 0) {
        ro = [rc * Math.sin(sp * 0.13), T * 1.6, rc * Math.cos(sp * 0.13)];
        const a = sp * 0.11 + g[2] * TAU;
        const pitch = -0.9 + 1.9 * ev[0];
        ta = [ro[0] + Math.cos(a), ro[1] + Math.tan(Math.max(-1.3, Math.min(1.3, pitch))), ro[2] + Math.sin(a)];
      } else if (rig === 1) {
        ro = [rc * 0.5 * Math.sin(sp * 0.07), -T * 1.8, rc * 0.5 * Math.cos(sp * 0.09)];
        const a = sp * 0.05;
        ta = [ro[0] + 0.35 * Math.cos(a), ro[1] - 1, ro[2] + 0.35 * Math.sin(a)];
        roll = sp * 0.07;
        fov = 1.0 + 0.2 * g[4];
      } else {
        const a = sp * 0.35 + T * 0.05;
        ro = [rc * Math.cos(a), T * 1.2, rc * Math.sin(a)];
        ta = [ro[0] - Math.sin(a) * 2, ro[1] + 0.8 + 0.6 * ev[1], ro[2] + Math.cos(a) * 2];
        roll = 0.25;
      }
    } else if (layout === 1) {
      const hz = 4.5 + 7 * ev[0];
      if (rig === 0) {
        ro = [0.2 * dim * Math.sin(sp * 0.11), hz, T * 1.3];
        ta = [ro[0] + Math.sin(sp * 0.09) * 2, ro[1] + 4 + 3 * ev[1], ro[2] + 10];
      } else if (rig === 1) {
        ro = [0.15 * dim, 6.5, T * 2.0];
        ta = [0.05 * dim, 7.0 + 1.5 * ev[1], ro[2] + 14];
      } else {
        ro = [0.3 * dim * Math.sin(T * 0.13), 8 + 3.5 * Math.sin(T * 0.09), T * 2.2];
        ta = [0.3 * dim * Math.sin(T * 0.13 + 0.6), 8 + 3.5 * Math.sin(T * 0.09 + 0.5), ro[2] + 5];
        roll = -0.3 * Math.cos(T * 0.13);
      }
    } else if (layout === 2) {
      const w = dim;
      const h = 0.5 * H;
      if (rig === 0) {
        const a = sp * 0.12 + g[2] * TAU;
        const R = 9.0 * w;
        ro = [R * Math.cos(a), 9 * h + 3 + 6 * ev[0], R * Math.sin(a)];
        ta = [0, 5 * h + 6 * ev[1], 0];
      } else if (rig === 1) {
        const x = 6 * w * Math.sin(T * 0.04);
        ro = [x, 4 * h + 9, -2.5 * w];
        ta = [x * 0.6 + 4 * w * Math.cos(T * 0.04), 2 * h, 3 * w];
      } else {
        const a = T * 0.06 + g[2] * TAU;
        const R = (4.2 + 1.5 * Math.sin(T * 0.05)) * w;
        ro = [R * Math.cos(a), (R / w) * h + 7.5, R * Math.sin(a)];
        ta = [(R - 1.5 * w) * Math.cos(a + 0.5), (R / w) * h * 0.4 + 3, (R - 1.5 * w) * Math.sin(a + 0.5)];
        roll = 0.18;
      }
    } else {
      const L = dim;
      if (rig === 0) {
        ro = [L * 0.5, T * 1.5, L * 0.5];
        const a = sp * 0.1 + g[2] * TAU;
        ta = [ro[0] + Math.cos(a), ro[1] + 0.9 * (ev[0] * 2 - 1), ro[2] + Math.sin(a)];
      } else if (rig === 1) {
        ro = [T * 2, L * 0.5, L * 0.5];
        ta = [ro[0] + 10, L * 0.5 + 2 * (ev[0] - 0.5), L * 0.5 + 3 * (ev[1] - 0.5)];
      } else {
        ro = [T * 2.2, L * (0.5 + 0.18 * Math.sin(T * 0.21)), L * (0.5 + 0.18 * Math.cos(T * 0.15))];
        ta = [ro[0] + 6, L * (0.5 + 0.18 * Math.sin(T * 0.21 + 0.6)), L * (0.5 + 0.18 * Math.cos(T * 0.15 + 0.5))];
        roll = 0.3 * Math.sin(T * 0.21);
      }
    }

    // Sun: shafts need a steep sun, the others take the gene's angle.
    const az = g[2] * TAU + (ev[2] - 0.5) * 0.8;
    let el = 0.3 + 0.75 * ((g[2] * 3.7) % 1);
    if (layout === 0) el = 1.22 + 0.25 * ((g[2] * 5.3) % 1);
    if (light === 1) el = Math.min(el, layout === 0 ? 1.15 : 0.32);
    const sun = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const sunLum = [1.5, 1.4, 0.45][light] * (mat === 2 ? 0.7 : 1) * (1 - 0.55 * antic) * (1 + 1.2 * drop);
    const winGain = [0.6, 1.0, 1.8][light] * (0.6 + 0.6 * ctx.intensity + 0.5 * st.chord);

    p[0] = layout;
    // Melody: a floor of light whose height follows the pitch, relative to the eye.
    // (The amphitheatre uses a tier ring instead: higher notes light higher, wider tiers.)
    p[1] = layout === 2 ? dim * (1.5 + 7 * (0.5 + 0.5 * leadPitch))
      : layout === 0 && rig === 1 ? ro[1] - H * (3.2 - 2.0 * leadPitch) // falling, looking down the shaft: a ring below
      : ro[1] + (layout === 3 ? dim * 0.32 * leadPitch : H * (0.3 + 2.4 * leadPitch));
    // (The glided hats ride in the light index's fraction, below its 0.5 marks.)
    p[2] = mat; p[3] = light + 0.45 * Math.min(1, hatL);
    // (The snare's light rides in the shape flag's fraction, below its 0.5 mark.)
    p[4] = grammar; p[5] = H; p[6] = dim; p[7] = shape + 0.45 * Math.min(1, snareEnv);
    p[8] = ro[0]; p[9] = ro[1]; p[10] = ro[2]; p[11] = roll;
    p[12] = ta[0]; p[13] = ta[1]; p[14] = ta[2]; p[15] = fov;
    p[16] = sun[0]; p[17] = sun[1]; p[18] = sun[2]; p[19] = sunLum;
    p[20] = (g[6] * 1.7 + g[0] * 0.3) % 1; // hue offset
    p[21] = 0.18 + 0.5 * g[5] * (light === 2 ? 1.3 : 0.8); // window density
    // The glided melody pitch (the floor's hue follows it). (The sky's level comes from the light index.)
    p[22] = leadPitch;
    p[23] = (0.008 + 0.008 * g[1]) * (1 + 1.4 * antic + 0.4 * m.tension) / s; // haze density
    // The look-ahead lean hands over to the kick without a dip (the larger of the two, glided).
    p[24] = piston.update(Math.max(kickEnv * (grammar === 0 ? 1 : 0.25), 0.3 * m.kickNext * morph.presence), dt);
    p[25] = leadEnv;
    p[26] = drop;
    // Snare: the light shafts through the haze flare.
    p[27] = (0.45 + 0.4 * m.energySlow + 1.6 * snareEnv) * (1 - 0.5 * antic) + 1.5 * drop;
    p[28] = (g[0] * 97.31) % 1; // seed
    p[29] = layout === 1 ? (shape ? -0.9 : 1.6) * s : g[6]; // canyon tier step / amph rotation
    p[30] = winGain;
    p[31] = m.beatIndex + m.beatPhase;
  },
  wgsl: /* wgsl */ `
// Eased, level-scaled events: the kick (the pistons' drive, without the beat grammar's damping),
// the snare (in the shape flag's fraction) and a beat clock pulse that rises instead of snapping on.
fn bm_kick() -> f32 { return S.p[6].x / select(0.25, 1.0, S.p[1].x < 0.5); }
fn bm_snare() -> f32 { return fract(S.p[1].w) / 0.45; }
// The sky's level for the light index (haze day, dusk, night); the index's fraction carries the hats.
fn bm_skyLum() -> f32 { return array<f32, 3>(0.075, 0.04, 0.01)[min(i32(floor(S.p[0].w)), 2)]; }
fn bm_beat() -> f32 { return smoothstep(0.0, 0.08, F.beatPhase) * exp(-3.0 * F.beatPhase); }
fn bm_b2(p: vec2f, b: vec2f) -> f32 { let q = abs(p) - b; return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0); }
fn bm_u(a: vec2f, b: vec2f) -> vec2f { return select(a, b, b.x < a.x); }

// Material ids: 0 walls / blocks (windows), 1 slab fronts (light strips), 2 bridges, 3 floor pool.
fn bm_shaft(p: vec3f) -> vec2f {
  let H = S.p[1].y; let W = S.p[1].z; let rnd = S.p[1].w > 0.5;
  let seed = S.p[7].x;
  let rl = length(p.xz);
  let q = abs(p.xz);
  let u = select(max(q.x, q.y), rl, rnd);
  let s = select(min(q.x, q.y), atan2(p.z, p.x) * W, rnd);
  var r = vec2f(W - u, 0.0);
  // Gallery slabs every floor, depth hashed per floor; some piston on kicks.
  let fk = round(p.y / H);
  let ys = p.y - fk * H;
  let hf = hash11(fk * 3.17 + seed * 13.0);
  let dep = H * (0.35 + 0.6 * hf) + S.p[6].x * step(0.7, fract(hf * 7.3)) * H * 0.8;
  let slab = min(bm_b2(vec2f(u - (W - dep * 0.5), ys), vec2f(dep * 0.5, 0.32)),
                 bm_b2(vec2f(u - (W - dep + 0.1), ys - 0.75), vec2f(0.1, 0.45)));
  r = bm_u(r, vec2f(slab, 1.0));
  // Deep vertical fins.
  let P = H * 2.4;
  let sm = s - P * round(s / P);
  r = bm_u(r, vec2f(bm_b2(vec2f(sm, u - (W - H * 0.3)), vec2f(0.28, H * 0.3)), 0.0));
  // Bridges every few floors, alternating axis, cut by a central ring gallery.
  let Hb = H * 4.0;
  let bk = round(p.y / Hb);
  let by = p.y - bk * Hb - H * 0.5;
  let hb = hash11(bk * 1.73 + seed * 7.0);
  let ax = select(p.x, p.z, fract(bk * 0.5) > 0.25);
  let o = (hb - 0.5) * W * 0.9;
  let Rc = W * 0.3;
  var br = bm_b2(vec2f(ax - o, by), vec2f(0.9 + 0.8 * fract(hb * 5.1), 0.45));
  br = max(br, Rc + 0.6 - rl);
  r = bm_u(r, vec2f(br, 2.0));
  return r;
}

fn bm_canyon(p: vec3f) -> vec2f {
  let H = S.p[1].y; let W0 = S.p[1].z; let st = S.p[7].y;
  let seed = S.p[7].x;
  let x = abs(p.x);
  let Ht = H * 3.0;
  let k = max(floor(p.y / Ht), 0.0);
  var d = p.y;
  for (var j = -1; j <= 1; j++) {
    let kk = max(k + f32(j), 0.0);
    let Wk = max(W0 + kk * st, W0 * 0.35);
    d = min(d, bm_b2(vec2f(x - Wk - 60.0, p.y - (kk + 0.5) * Ht), vec2f(60.0, Ht * 0.5)));
  }
  var r = vec2f(d, select(0.0, 3.0, p.y < 0.3));
  let Wy = max(W0 + k * st, W0 * 0.35);
  let fk = round(p.y / H);
  let ys = p.y - fk * H;
  let hf = hash11(fk * 2.71 + floor(p.z / 23.0) * 0.37 + sign(p.x) * 5.0 + seed * 11.0);
  let dep = H * (0.25 + 0.45 * hf) + S.p[6].x * step(0.72, fract(hf * 9.1)) * H;
  let slab = min(bm_b2(vec2f(x - (Wy - dep * 0.5), ys), vec2f(dep * 0.5, 0.3)),
                 bm_b2(vec2f(x - (Wy - dep + 0.1), ys - 0.7), vec2f(0.1, 0.4)));
  r = bm_u(r, vec2f(select(slab, 1e9, p.y < H * 0.5), 1.0));
  let P = H * 2.2;
  let zm = p.z - P * round(p.z / P);
  r = bm_u(r, vec2f(bm_b2(vec2f(zm, x - (Wy - H * 0.25)), vec2f(0.3, H * 0.25)), 0.0));
  // Bridges: one low walkway band and two high spans per bay, clear of the camera band.
  let Pz = 19.0 + 6.0 * H;
  let zi = round(p.z / Pz);
  let zb = p.z - zi * Pz;
  let hb = hash11(zi * 1.31 + seed * 3.0);
  let y1 = 19.0 + hb * 18.0;
  let y2 = 26.0 + fract(hb * 7.7) * 30.0;
  var br = bm_b2(vec2f(zb, p.y - y1), vec2f(1.0 + 1.2 * hb, 0.55));
  br = min(br, bm_b2(vec2f(zb - Pz * 0.3, p.y - y2), vec2f(0.8, 0.45)));
  br = min(br, bm_b2(vec2f(zb + Pz * 0.27, p.y - 1.6), vec2f(1.4, 0.35)));
  r = bm_u(r, vec2f(br, 2.0));
  return r;
}

fn bm_amph(p: vec3f) -> vec2f {
  let w = S.p[1].z; let h = S.p[1].y * 0.5; let rnd = S.p[1].w > 0.5;
  let rl = length(p.xz);
  let rq = rotY(S.p[7].y * 1.57) * p;
  let r = select(max(abs(rq.x), abs(rq.z)), rl, rnd);
  let i = floor(r / w);
  var d = 1e9;
  for (var j = -1; j <= 1; j++) {
    let ii = max(i + f32(j), 0.0);
    d = min(d, bm_b2(vec2f(r - (ii + 0.5) * w, p.y - (ii * h - 100.0)), vec2f(w * 0.5, 100.0)));
  }
  var res = vec2f(d, select(0.0, 3.0, r < w));
  // Ring of pylon fins with a lintel ring.
  let N = 8.0 + 4.0 * floor(S.p[7].y * 3.0);
  let sec = TAU / N;
  let an = atan2(p.z, p.x);
  let a = an - sec * round(an / sec);
  let lx = rl * cos(a); let lz = rl * sin(a);
  let Rp = 11.0 * w;
  let base = 11.0 * h;
  let top = base + 34.0 * h;
  res = bm_u(res, vec2f(sdBox(vec3f(lx - Rp, p.y - (base + top) * 0.5, lz), vec3f(w * 0.45, (top - base) * 0.5, w * 1.1)), 0.0));
  res = bm_u(res, vec2f(bm_b2(vec2f(rl - Rp, p.y - top - 1.2), vec2f(w * 0.8, 1.2)), 1.0));
  // Two crossing walkways with a slim central disc.
  let Hb = 3.2 * h + 2.0;
  let c1 = abs(dot(p.xz, vec2f(cos(S.p[7].y * 3.0), sin(S.p[7].y * 3.0))));
  let c2 = abs(dot(p.xz, vec2f(-sin(S.p[7].y * 3.0 + 0.6), cos(S.p[7].y * 3.0 + 0.6))));
  var br = bm_b2(vec2f(min(c1, c2), p.y - Hb), vec2f(1.1, 0.4));
  br = min(br, bm_b2(vec2f(rl - w * 0.9, p.y - Hb), vec2f(w * 0.25, 0.4)));
  res = bm_u(res, vec2f(br, 2.0));
  return res;
}

fn bm_lattice(p: vec3f) -> vec2f {
  let L = S.p[1].z;
  let b = L * 0.055;
  let c = floor(p / L);
  let l = p - (c + 0.5) * L;
  let q = L * 0.5 - abs(l);
  var d = min(min(bm_b2(q.yz, vec2f(b)), bm_b2(q.xz, vec2f(b * 1.5))), bm_b2(q.xy, vec2f(b)));
  var r = vec2f(d, 4.0);
  let zc = select(0.0, 1.0, c.x == 0.0) + select(0.0, 1.0, c.y == 0.0) + select(0.0, 1.0, c.z == 0.0);
  let mg = b * 0.9;
  if (zc < 1.5) {
    let h = hash33(c + vec3f(S.p[7].x * 31.0));
    let ty = floor(h.x * 4.0);
    let e = L * 0.5 - mg;
    var cd = 1e9;
    if (ty < 0.5) {
      cd = sdBox(l - vec3f(0.0, -L * 0.5 + b + 0.4, 0.0), vec3f(e, 0.4, e));
      cd = min(cd, sdBox(l - vec3f((h.y - 0.5) * L * 0.4, -L * 0.5 + b + 0.8 + h.z * L * 0.2, (h.z - 0.5) * L * 0.4), vec3f(L * 0.12, h.z * L * 0.2, L * 0.15)));
    } else if (ty < 1.5) {
      let sz = vec3f(0.18 + 0.2 * h.y, 0.2 + 0.25 * h.z, 0.18 + 0.2 * fract(h.y * 7.0)) * L;
      let off = vec3f((h.z - 0.5) * (e - sz.x), -L * 0.5 + b + sz.y + S.p[6].x * step(0.5, h.y) * L * 0.04, (h.y - 0.5) * (e - sz.z));
      cd = sdBox(l - off, sz);
    } else if (ty < 2.5) {
      let side = select(1.0, -1.0, h.y > 0.5);
      let pp = select(l.xyz, l.zyx, h.z > 0.5);
      cd = sdBox(pp - vec3f(0.0, 0.0, side * (e - 0.4)), vec3f(e, e, 0.4));
    }
    r = bm_u(r, vec2f(cd, 0.0));
  }
  r.x = min(r.x, min(q.x, min(q.y, q.z)) + mg);
  return r;
}

fn bm_map(p: vec3f) -> vec2f {
  let lay = S.p[0].x;
  if (lay < 0.5) { return bm_shaft(p); }
  if (lay < 1.5) { return bm_canyon(p); }
  if (lay < 2.5) { return bm_amph(p); }
  return bm_lattice(p);
}

fn bm_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * bm_map(p + k.xyy * e).x + k.yyx * bm_map(p + k.yyx * e).x +
                   k.yxy * bm_map(p + k.yxy * e).x + k.xxx * bm_map(p + k.xxx * e).x);
}

fn bm_shadow(ro: vec3f, rd: vec3f, k: f32, n: i32) -> f32 {
  var res = 1.0;
  var t = 0.15;
  for (var i = 0; i < n; i++) {
    let h = bm_map(ro + rd * t).x;
    res = min(res, k * h / t);
    if (res < 0.01) { break; }
    t += clamp(h, 0.2, 6.0);
    if (t > 45.0) { break; }
  }
  return sat(res);
}

fn bm_ao(p: vec3f, n: vec3f, sc: f32) -> f32 {
  var o = 0.0; var w = 1.0;
  for (var i = 1; i <= 4; i++) {
    let h = sc * (0.1 + 0.3 * f32(i));
    o += (h - bm_map(p + n * h).x) / sc * w;
    w *= 0.6;
  }
  return sat(1.0 - o * 0.9);
}

fn bm_sunCol() -> vec3f {
  let night = S.p[0].w > 1.5;
  let warm = select(vec3f(1.0, 0.86, 0.66), vec3f(0.65, 0.78, 1.0), night);
  return mix(warm, palL(S.p[5].x + 0.1, 1.0), 0.35) * S.p[4].w;
}

fn bm_sky(rd: vec3f) -> vec3f {
  let sl = bm_skyLum();
  let up = sat(rd.y * 0.5 + 0.5);
  let hz = mix(vec3f(sl * 0.6), palL(S.p[5].x + 0.55, sl * 0.6), 0.55);
  let zen = mix(vec3f(sl * 1.3), palL(S.p[5].x + 0.45, sl * 1.3), 0.45);
  var c = mix(hz, zen, up);
  let sd = sat(dot(rd, S.p[4].xyz));
  c += bm_sunCol() * (pow(sd, 6.0) * 0.05 + pow(sd, 400.0) * 1.5);
  return c;
}

/** Melody light band around p (0..1): a floor at the note's height, or a tier ring in the amphitheatre. */
fn bm_lead(p: vec3f, wide: f32) -> f32 {
  let amph = S.p[0].x > 1.5 && S.p[0].x < 2.5;
  let fl = select(S.p[1].y * 0.55, S.p[1].z * 0.1, S.p[0].x > 2.5);
  let d = select((p.y - S.p[0].y) / (fl * wide), (length(p.xz) - S.p[0].y) / (S.p[1].z * 0.6 * wide), amph);
  return exp(-d * d) * S.p[6].y;
}

// Tiny windows on vertical faces; every window listens to one band.
fn bm_windows(p: vec3f, n: vec3f, t: f32, pix: f32) -> vec3f {
  if (abs(n.y) > 0.4) { return vec3f(0.0); }
  let H = S.p[1].y;
  let horiz = select(p.z, p.x, abs(n.z) > abs(n.x));
  let cs = vec2f(H * 0.17, H / 4.0);
  let g = vec2f(horiz / cs.x, p.y / cs.y);
  let id = floor(g);
  let f = fract(g);
  let face = floor(dot(sign(n), vec3f(1.0, 7.0, 3.0)));
  let h = hash13(vec3f(id, face + S.p[7].x * 17.0));
  let dens = S.p[5].y * (1.0 - 0.9 * F.anticipation * (1.0 - min(S.p[6].z, 1.0))) + 0.5 * S.p[6].z;
  let band = fract(h * 7.31);
  var lvl = spec(0.03 + 0.9 * band);
  let gram = S.p[1].x;
  if (gram > 0.5 && gram < 1.5) {
    // Spectrum waterfall climbing the walls.
    lvl = hist(0.03 + 0.9 * fract(id.x * 0.0731 + face * 0.17), fract(id.y * 0.023));
  } else if (gram > 1.5) {
    let row = fmod(floor(id.y / 3.0), 8.0);
    lvl = lvl * 0.5 + 1.2 * exp(-abs(row - fmod(floor(S.p[7].w), 8.0)) * 2.0) * bm_beat();
  }
  // The melody floor: every window on it lights.
  let lf = bm_lead(p, 1.0);
  let on = max(step(h, dens), smoothstep(0.15, 0.45, lf));
  lvl += 2.0 * lf;
  let flick = 1.0 + 1.5 * fract(S.p[0].w) / 0.45 * step(0.85, fract(h * 13.7)) + 1.2 * bm_snare() * step(0.7, fract(h * 5.3));
  let em = (0.1 + 2.5 * lvl * lvl) * flick * on;
  let mask = step(0.25, f.x) * step(f.x, 0.75) * step(0.35, f.y) * step(f.y, 0.8);
  // Fade to the average where windows get smaller than a pixel.
  let foot = sat((pix * t / cs.y - 0.25) * 2.0);
  let lit = mix(mask * em, (dens + lf) * 0.6 * (0.15 + 1.0 * F.energySlow + lf), foot);
  return palL(S.p[5].x + 0.12 + 0.18 * band + F.morph2.x * 0.2, 1.0) * lit * S.p[7].z;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[2].xyz;
  let cam = lookAt(ro, S.p[3].xyz, S.p[2].w);
  let rd = normalize(cam * vec3f(q, S.p[3].w));
  let pix = 2.0 / (F.res.y * S.p[3].w);
  let sun = S.p[4].xyz;
  let sunCol = bm_sunCol();
  let H = S.p[1].y;
  let hue = S.p[5].x;

  let far = 120.0;
  var t = 0.05 + ign(frag) * 0.1;
  var hit = false;
  var m = 0.0;
  for (var i = 0; i < 100; i++) {
    let r = bm_map(ro + rd * t);
    if (r.x < 0.0008 * t + 0.002) { hit = true; m = r.y; break; }
    t += r.x * select(0.9, 1.0, r.x > 2.0);
    if (t > far) { break; }
  }
  t = min(t, far);
  let fogCol = bm_sky(rd) * 0.85 + palL(hue + 0.6, bm_skyLum() * 0.3);
  var col = bm_sky(rd);
  if (hit) {
    let pos = ro + rd * t;
    var n = bm_normal(pos, max(0.002, 0.0008 * t));
    let ao = bm_ao(pos, n, H * 0.6);
    // Walls: chamfered piers between the window columns (shading detail, fades with distance).
    if (m < 0.5 && abs(n.y) < 0.4) {
      let cw = H * 0.17;
      let hzr = select(pos.z, pos.x, abs(n.z) > abs(n.x));
      let fr = fract(hzr / cw) - 0.5;
      let tng = normalize(cross(n, vec3f(0.0, 1.0, 0.0)));
      let fade = sat(1.5 - pix * t / cw * 4.0);
      n = normalize(n + tng * 0.7 * sign(fr) * smoothstep(0.32, 0.47, abs(fr)) * fade);
    }
    let sh = bm_shadow(pos + n * 0.05, sun, 12.0, 20);
    let mat = S.p[0].z;
    let dif = sat(dot(n, sun)) * sh;
    // Board-formed concrete: horizontal pour lines, panel seams, tie holes, stains.
    let nz = noise3(pos * 0.7) * 0.5 + noise3(pos * 2.3) * 0.25;
    let board = 0.85 + 0.15 * smoothstep(0.0, 0.08, abs(fract(pos.y / (H * 0.25)) - 0.5) - 0.42);
    let hz = select(pos.z, pos.x, abs(n.z) > abs(n.x));
    let tie = smoothstep(0.06, 0.03, length(fract(vec2f(hz, pos.y) / (H * 0.25)) - 0.5));
    var alb: vec3f;
    var spc = 0.0;
    var rough = 0.0;
    if (mat < 0.5) {
      let grey = 0.26 * (0.8 + 0.5 * nz) * board * (1.0 - 0.5 * tie);
      alb = mix(vec3f(grey), palL(hue + 0.3, grey), 0.15) * (0.75 + 0.25 * smoothstep(-1.0, 0.2, -pos.y / 40.0));
      spc = 0.02;
      rough = 1.0;
    } else if (mat < 1.5) {
      alb = vec3f(0.025) + palL(hue + 0.2, 0.01);
      spc = 1.0;
      rough = 0.08 + 0.1 * sat(nz + 0.3);
    } else {
      let vein = smoothstep(0.02, 0.0, abs(fbm3(pos * vec3f(0.5, 1.2, 0.5), 3) - 0.05));
      alb = mix(vec3f(0.55), palL(hue + 0.75, 0.2), vein * 0.6) * (0.94 + 0.06 * nz);
      spc = 0.35;
      rough = 0.3;
    }
    if (m > 1.5 && m < 2.5) { alb *= 0.8; }
    let skyAmb = bm_sky(normalize(n + vec3f(0.0, 0.6, 0.0))) * (0.55 + 0.45 * n.y);
    let bounce = sunCol * 0.04 * sat(-n.y + 0.3) * alb;
    col = alb * (sunCol * dif + skyAmb * 1.4 * ao) + bounce * ao;
    // Specular: sun glint and a sky reflection with fresnel.
    let rf = reflect(rd, n);
    let fre = 0.04 + 0.96 * pow(1.0 - sat(dot(n, -rd)), 5.0);
    let sharp = mix(600.0, 20.0, rough);
    col += sunCol * pow(sat(dot(rf, sun)), sharp) * sh * spc * min(sharp * 0.02, 3.0) * ao;
    col += bm_sky(rf) * fre * spc * ao * select(1.0, 0.5, rough > 0.5);
    // Emissive windows on walls / blocks.
    if (m < 0.5) { col += bm_windows(pos, n, t, pix) * ao; }
    // The melody floor washes the concrete around it like a lit gallery.
    let lband = bm_lead(pos, 1.3);
    col += palL(hue + 0.3 + 0.2 * S.p[5].z, 1.0) * lband * (alb * 3.5 + 0.05) * (S.p[7].z + 0.8 * S.p[4].w);
    // Slab fronts: a strip light per floor, kicked or sequenced.
    if (m > 0.5 && m < 1.5) {
      let fk = round(pos.y / H);
      let strip = smoothstep(0.08, 0.0, abs(pos.y - fk * H + 0.18)) * step(0.4, abs(n.x) + abs(n.z));
      let hb = hash11(fk * 1.91 + S.p[7].x);
      let seq = exp(-abs(fmod(fk, 8.0) - fmod(floor(S.p[7].w * 2.0), 8.0)) * 1.5);
      let lv = (0.2 + 2.0 * spec(0.05 + 0.6 * hb) + 3.0 * bm_kick() * step(0.6, hb) + 2.0 * seq * bm_beat() * step(1.5, S.p[1].x)) ;
      col += palL(hue + 0.05 + 0.25 * hb + F.morph2.y * 0.2, 1.0) * strip * lv * S.p[7].z * 0.5;
    }
    // Bridge undersides: snare-flashed light lines.
    if (m > 1.5 && m < 2.5) {
      let under = sat(-n.y);
      let ln = smoothstep(0.85, 1.0, fract((pos.x + pos.z) * 0.4));
      col += palL(hue + 0.5 + F.morph2.z * 0.2, 1.0) * under * (0.25 + ln * (0.4 + 4.0 * bm_snare() + 1.5 * F.chordPulse)) * S.p[7].z * 0.35;
    }
    // Floor pool light.
    if (m > 2.5 && m < 3.5) {
      let ring = exp(-abs(fract(length(pos.xz) * 0.15 - F.beatPhase * 0.5) - 0.5) * 10.0);
      col += palL(hue + 0.15, 1.0) * ring * (0.1 + 0.5 * bm_kick() + 0.6 * F.bass) * S.p[7].z * 0.25 * sat(n.y);
    }
  }
  // Haze with sun shafts: inscatter sampled through the shadow field.
  let dens = S.p[5].w;
  let trans = exp(-t * dens);
  col = col * trans + fogCol * (1.0 - trans);
  let tv = min(t, 70.0);
  let ns = 6;
  var sc = 0.0;
  let jit = ign(frag + vec2f(17.0, 3.0));
  for (var i = 0; i < ns; i++) {
    let ts = tv * (f32(i) + jit) / f32(ns);
    let sp = ro + rd * ts;
    let s = bm_shadow(sp, sun, 40.0, 7);
    sc += s * exp(-ts * dens);
  }
  let mu = dot(rd, sun);
  let phase = 0.2 + 1.6 * pow(sat(mu), 6.0) + 0.3 * sat(mu);
  col += sunCol * sc / f32(ns) * tv * dens * phase * S.p[6].w * 0.6;
  // Drop: white-out flash of the sky through every opening.
  col += fogCol * S.p[6].z * S.p[6].z * 0.15 * (1.0 - trans * 0.5);
  return vec4f(col, 1.0);
}
`,
});
