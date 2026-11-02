import type { MusicState } from '../../audio/musicState';
import { settle, Spring } from '../anim';
import { Morph } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Music clock for this scene: travel that surges on each beat and rests between them and in
 * silence, a turn phase that steps on downbeats, the age of the latest kick / snare / lead attack,
 * a held-note level with a soft release, and the chord hue eased around the colour wheel.
 */
const mc = { notes: -1, ringAge: 9, prevAge: 9, prevRing: 0, t: -1, travel: 0, turn: 0, turnRate: 0, surge: 0.2, held: 0, heldV: 0, hx: 1, hy: 0, pitch: 0, pitchV: 0, kick: 0, snare: 0, lead: 0, ring: 0, kickWave: 0 };
/** Only its event ages and levels are used: every reaction scales with how hard the hit was. */
const morph = new Morph(1);
/**
 * Event glows and motion rates on critically damped springs: each swells in over ~0.15 s and a new
 * hit never dips the last one, so nothing lands or drops in one frame.
 */
const sp = { kick: new Spring(0, 0.05), snare: new Spring(0, 0.04), lead: new Spring(0, 0.05), surge: new Spring(0.2, 0.06), turn: new Spring(0, 0.08), energy: new Spring(0, 0.12) };
const rise = (age: number, t: number) => {
  const x = Math.min(1, Math.max(0, age / t));
  return x * x * (3 - 2 * x);
};
function tick(m: MusicState, dtIn: number, dna: readonly number[]): void {
  const dt = Math.min(Math.max(dtIn, 0), 0.1);
  const seek = Math.abs(m.time - mc.t - dt) > 0.5;
  mc.t = m.time;
  const beat = 60 / Math.max(40, m.bpm);
  const tempo = Math.sqrt(Math.max(60, m.bpm) / 120);
  morph.update(m, dtIn, dna);
  const ka = morph.kickAge;
  const la = morph.leadAge;
  mc.kick = sp.kick.update(morph.kickLevel * Math.exp(-ka * 4), dt);
  mc.snare = sp.snare.update(morph.snareLevel * Math.exp(-morph.snareAge * 4), dt);
  mc.lead = sp.lead.update(morph.noteLevel * Math.exp(-la * 2.5), dt);
  // The note ring and the kick wave travel with their age, so their strength follows that age
  // directly: each starts from nothing. A new note starts a new ring; the previous one keeps
  // spreading and fading on its own age.
  if (morph.notes !== mc.notes) {
    if (mc.notes >= 0) {
      mc.prevRing = mc.ring;
      mc.prevAge = mc.ringAge;
    }
    mc.notes = morph.notes;
  }
  mc.prevAge += dt;
  mc.ringAge = la;
  mc.ring = morph.noteLevel * rise(la, 0.12);
  mc.kickWave = morph.kickLevel * rise(ka, 0.08);
  // Travel surges on kicks (eased, by strength) and on the beat grid, never in one frame.
  mc.surge = sp.surge.update(0.2 + 2.0 * mc.kick + 0.5 * m.beatPulse * morph.presence, dt);
  // Loudness paces the walk, eased so an onset never jolts the whole view forward.
  const energy = sp.energy.update(m.energy, dt);
  mc.travel += dt * tempo * (0.06 + 1.1 * energy + 0.8 * m.dropPulse) * mc.surge;
  const barMean = Math.min(1, 0.25 / (beat * m.beatsPerBar));
  // The turn steps on downbeats, eased in so the camera never jerks.
  mc.turnRate = sp.turn.update(tempo * (0.05 + 0.9 * m.energySlow) * (0.2 + (0.8 * m.barPulse * morph.presence) / barMean), dt);
  mc.turn += dt * mc.turnRate;
  const hue = (m.chord && m.chord.root >= 0 ? ((m.chord.root * 7) % 12) / 12 : 0) * Math.PI * 2;
  if (seek) {
    mc.pitch = mc.pitchV = m.leadPitch;
    mc.hx = Math.cos(hue);
    mc.hy = Math.sin(hue);
  } else {
    // The lamp glides to each note's height instead of jumping there.
    mc.pitchV = settle(mc.pitchV, m.leadPitch, 0.07, dt);
    mc.pitch = settle(mc.pitch, mc.pitchV, 0.07, dt);
    const kh = 1 - Math.exp(-dt / 0.6);
    mc.hx += (Math.cos(hue) - mc.hx) * kh;
    mc.hy += (Math.sin(hue) - mc.hy) * kh;
  }
  // Two-stage follower: the held glow starts from rest, so a new note never lights it in one frame.
  const held = m.leadHeld * morph.presence;
  mc.heldV += (held - mc.heldV) * (1 - Math.exp(-dt / (held > mc.heldV ? 0.06 : 0.25)));
  mc.held += (mc.heldV - mc.held) * (1 - Math.exp(-dt / (mc.heldV > mc.held ? 0.06 : 0.15)));
}
const chordHue = () => Math.atan2(mc.hy, mc.hx) / (Math.PI * 2);

/**
 * Impossible architecture you walk through. DNA picks the topology: an endless square stair
 * tower climbed from the inside, or (more often) an infinite house of stairs folded into a
 * kaleidoscope of itself that turns a quarter about you on refolds. It also picks the camera, the palette mapping (lithograph tones, one hue
 * per gravity frame, pastel blocks), the lighting (soft sky bounce, hard noir key, carried
 * lantern), arch style, density and what triggers the refolds (bars, chord changes, or a drift
 * that advances with the music).
 *
 * The music: the melody is a lamp floating in the stairwell ahead; the pitch sets its height, every
 * note flares it, lights the steps and arches around it and sends a ring of light out through
 * the stone. Each kick sends a wave of light climbing the stair nosings; each snare lights the
 * arch walls near you. Travel surges on kicks and rest between them; chords
 * ease the tint and can refold the house; anticipation darkens it, the drop opens the light.
 */
const TAU = Math.PI * 2;
const st = { lastTime: -1, chordIdx: -1, chordCount: 0 };

export default raymarchScene({
  meta: {
    id: 'escher-stairs',
    name: 'Impossible Stairs',
    // Kept out of auto-direction: the architecture is built from flat block slabs (stairs, walls,
    // piers), which reads as chunky next to the fractal and organic worlds. Still pinnable.
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: 0.55, arousal: 0.4 },
    genres: {},
    trails: 0.15,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    tick(m, ctx.dt, ctx.dna);
    const g = ctx.dna;
    const ev = ctx.evolve;
    const topo = g[0] < 0.3 ? 1 : 3;
    const rig = topo === 1 ? 1 : Math.floor(g[1] * 3) % 3;
    const palMap = Math.floor(g[2] * 3) % 3;
    const light = Math.floor(g[3] * 3) % 3;
    const grammar = Math.floor(g[7] * 3) % 3;
    const antic = m.anticipation;
    const drop = m.dropPulse;
    if (Math.abs(m.time - st.lastTime) > 0.5) { st.chordIdx = m.chordIndex; }
    st.lastTime = m.time;
    if (m.chordIndex !== st.chordIdx) { st.chordIdx = m.chordIndex; st.chordCount++; }

    // Refold clock: integer count of refold events plus the eased fraction since the last.
    let clkInt: number;
    let clkFrac: number;
    if (grammar === 0) {
      clkInt = m.barIndex; clkFrac = Math.min(1, m.barPhase * (1.6 + 2.5 * antic));
    } else if (grammar === 1) {
      clkInt = st.chordCount; clkFrac = Math.min(1, (1 - m.chordPulse) * 1.3);
    } else {
      const c = mc.turn * 0.25;
      clkInt = Math.floor(c); clkFrac = c - clkInt;
    }

    const scale = 0.8 + 0.5 * g[4];
    const T = mc.travel;
    const sp = mc.turn;
    let ro = [0, 0, 0];
    let ta = [0, 0, 0];
    let roll = 0;
    let fov = 1.4;
    const C = 4 * scale;
    // The lamp: distance ahead and height range in this topology's units.
    let lampD: number;
    let lampH: number;
    let walk = [0, 0, 0];
    if (topo === 1) {
      // Walk the endless square tower from the inside.
      const Hl = 5 * scale;
      const Rr = 3.2 * scale;
      const s = T * 0.09;
      const pos = (u: number): number[] => {
        const side = Math.floor(u) % 4;
        const f = u - Math.floor(u);
        const along = (f * 2 - 1) * Rr;
        const ang = side * Math.PI / 2;
        // local x = outward normal, z = along the side; rotate by side quarter turns
        const x = Rr * Math.cos(ang) - along * Math.sin(ang);
        const z = Rr * Math.sin(ang) + along * Math.cos(ang);
        return [x, (u * Hl) / 4, z];
      };
      const a0 = pos(s);
      const a1 = pos(s + 0.18);
      ro = [a0[0], a0[1] + 1.3 * scale, a0[2]];
      ta = [a1[0], a1[1] + 1.1 * scale + 0.8 * (ev[1] - 0.5), a1[2]];
      fov = 1.0;
      walk = pos(s + 0.22);
      walk[1] += 1.3 * scale;
      lampD = 2.4 * scale;
      lampH = 0.9 * scale;
    } else {
      // House of stairs: travel along the empty corridor row (cells y = z = 0).
      const x = T * 1.1;
      const c = C * 0.5;
      if (rig === 0) {
        ro = [x, c, c];
        ta = [x + 6, c + C * 0.6 * (ev[0] - 0.5), c + C * 0.8 * Math.sin(sp * 0.15)];
        fov = 1.3;
      } else if (rig === 1) {
        ro = [x, c + 0.22 * C * Math.sin(T * 0.3), c + 0.18 * C * Math.cos(T * 0.21)];
        const a = sp * 0.3 + g[5] * TAU;
        ta = [ro[0] + 2 * Math.cos(a * 0.5), ro[1] + Math.sin(a) * 1.5, ro[2] + Math.cos(a) * 1.5];
        fov = 1.0;
      } else {
        ro = [x, c, c];
        ta = [x + 6, c, c];
        roll = sp * 0.35;
        fov = 1.15;
      }
      lampD = 0.75 * C;
      lampH = 0.2 * C;
    }
    // The lamp hangs over the walkway ahead (the stair path in the tower, the corridor axis in
    // the house), so it never lands in a wall beside the camera.
    let lamp: number[];
    if (topo === 1) {
      const fw = [walk[0] - ro[0], walk[2] - ro[2]];
      const fl = Math.hypot(fw[0], fw[1]) || 1;
      lamp = [ro[0] + (fw[0] / fl) * lampD, walk[1] + mc.pitch * lampH, ro[2] + (fw[1] / fl) * lampD];
    } else {
      // Ahead along the view, but held inside the corridor tube.
      const fw = [ta[0] - ro[0], ta[1] - ro[1], ta[2] - ro[2]];
      const fl = Math.hypot(fw[0], fw[1], fw[2]) || 1;
      const c = C * 0.5;
      const q = [ro[0] + (Math.abs(fw[0]) / fl) * lampD + 0.3 * C, ro[1] + (fw[1] / fl) * lampD - c, ro[2] + (fw[2] / fl) * lampD - c];
      const r = Math.hypot(q[1], q[2]);
      const k = r > 0.22 * C ? (0.22 * C) / r : 1;
      lamp = [q[0], c + q[1] * k + mc.pitch * lampH, c + q[2] * k];
    }

    const N = 3 + Math.floor(g[4] * 5);
    // House refold: a quarter turn about the corridor every second event.
    const ef = clkFrac * clkFrac * (3 - 2 * clkFrac);
    const foldT = (Math.floor(clkInt / 2) + (clkInt % 2 === 1 ? ef : 0)) * (Math.PI / 2) * (g[6] < 0.5 ? 1 : -1);

    p[0] = topo; p[1] = rig; p[2] = palMap; p[3] = light;
    p[4] = grammar; p[5] = C; p[6] = mc.kickWave; p[7] = N;
    p[8] = ro[0]; p[9] = ro[1]; p[10] = ro[2]; p[11] = roll;
    p[12] = ta[0]; p[13] = ta[1]; p[14] = ta[2]; p[15] = fov;
    p[16] = lamp[0]; p[17] = lamp[1]; p[18] = Math.floor(g[5] * 3) + 0.45 * Math.min(1, mc.prevRing); p[19] = (g[0] * 31.7) % 1;
    p[20] = ((g[2] * 2.3 + g[6] * 0.4) % 1) + 0.3 * chordHue();
    p[21] = lamp[2]; p[22] = Math.round(Math.min(mc.ringAge, 3) * 1000) + 4096 * Math.round(Math.min(mc.prevAge, 3) * 1000); p[23] = mc.held;
    p[24] = Math.min(morph.kickAge, 3); p[25] = mc.snare;
    p[26] = (0.7 + 0.7 * ctx.intensity) * (1 - 0.5 * antic) + 1.0 * drop; p[27] = antic * (1 - drop);
    p[28] = mc.lead; p[29] = mc.ring; p[30] = foldT; p[31] = scale;
  },
  wgsl: /* wgsl */ `
fn es_u(a: vec4f, b: vec4f) -> vec4f { return select(a, b, b.x < a.x); }
fn es_b2(p: vec2f, b: vec2f) -> f32 { let q = abs(p) - b; return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0); }

// Arch opening in 2D: uv.x centred, uv.y up from the threshold. Negative inside the opening.
fn es_arch(uv: vec2f, hw: f32, sh: f32) -> f32 {
  let style = S.p[4].z;
  let rect = es_b2(vec2f(uv.x, uv.y - sh * 0.5), vec2f(hw, sh * 0.5));
  if (style < 0.5) { return min(rect, length(uv - vec2f(0.0, sh)) - hw); }
  if (style < 1.5) {
    let g = max(length(uv - vec2f(-0.5 * hw, sh)) - 1.5 * hw, length(uv - vec2f(0.5 * hw, sh)) - 1.5 * hw);
    return min(rect, max(g, sh - uv.y));
  }
  return es_b2(vec2f(uv.x, uv.y - sh * 0.6), vec2f(hw, sh * 0.6));
}

// Flight of n steps rising along +z / +y from the origin; returns (distance, step index).
fn es_stairs(q: vec3f, n: f32, a: f32, b: f32, w: f32) -> vec2f {
  let k = clamp(floor(q.z / a), 0.0, n - 1.0);
  var d = 1e9;
  for (var j = -1; j <= 1; j++) {
    let kk = clamp(k + f32(j), 0.0, n - 1.0);
    let th = b * 1.6;
    d = min(d, sdBox(q - vec3f(0.0, (kk + 1.0) * b - (b + th) * 0.5, (kk + 0.5) * a), vec3f(w, (b + th) * 0.5, a * 0.5)));
  }
  return vec2f(d, k);
}

// One room cell in [-2,2]^3: landing, flight to the far top edge, arch wall, column.
// Returns (d, material, step index, -) with materials 0 stone, 1 stair, 2 arch wall.
fn es_room(l: vec3f, h: f32) -> vec4f {
  var r = vec4f(sdBox(l - vec3f(0.0, -1.85, -1.0), vec3f(1.0, 0.15, 1.0)), 0.0, 0.0, 0.0);
  let s = es_stairs(l - vec3f(0.0, -1.7, 0.0), 8.0, 0.25, 0.4625, 0.85);
  r = es_u(r, vec4f(s.x, 1.0, s.y, 0.0));
  if (h > 0.3) {
    let wall = sdBox(l - vec3f(1.88, 0.0, 0.0), vec3f(0.12, 2.0, 2.0));
    let op = es_arch(vec2f(l.z + 1.0 - 2.0 * step(0.65, h), l.y + 2.0), 0.55, 1.5);
    r = es_u(r, vec4f(max(wall, -op), 2.0, 0.0, 0.0));
  }
  if (fract(h * 7.3) > 0.45) {
    r = es_u(r, vec4f(sdBox(l - vec3f(-1.75, 0.0, 1.75), vec3f(0.2, 2.0, 0.2)), 0.0, 0.0, 0.0));
  }
  return r;
}

// Topology 1: endless square stair tower with arcades.
fn es_tower(p: vec3f) -> vec4f {
  let sc = S.p[7].w;
  let Rr = 3.2 * sc;
  let Hl = 5.0 * sc;
  let w = 0.75 * sc;
  let n = 10.0;
  let a = 2.0 * Rr / n;
  let b = Hl / (4.0 * n);
  let ang = atan2(p.z, p.x);
  let side = fmod(floor((ang + PI * 0.25) / (PI * 0.5)), 4.0);
  let lp = rotY(side * PI * 0.5) * p;
  // lp.x outward, lp.z along the side (in climbing direction)
  var yl = p.y - side * Hl * 0.25;
  yl = yl - Hl * round((yl - Hl * 0.12) / Hl);
  let s = es_stairs(vec3f(lp.x - Rr, yl, lp.z + Rr), n, a, b, w);
  var r = vec4f(s.x, 1.0, s.y + side * n, side);
  // Inner arcade wall around the courtyard, one row of arches between consecutive loops.
  let flightY = (lp.z + Rr) * b / a;
  var wall = abs(lp.x - (Rr - w - 0.15 * sc)) - 0.15 * sc;
  let v = fmod(yl - flightY, Hl);
  let pa = 2.0 * Rr / 3.0;
  let az = lp.z - pa * round(lp.z / pa);
  wall = max(wall, -es_arch(vec2f(az, v - 0.25 * sc), pa * 0.27, Hl * 0.42));
  r = es_u(r, vec4f(wall, 2.0, 0.0, side));
  // Corner piers.
  let cq = abs(p.xz) - vec2f(Rr + w + 0.3 * sc);
  r = es_u(r, vec4f(length(cq) - 0.45 * sc, 0.0, 0.0, side));
  // Inner parapet.
  r = es_u(r, vec4f(sdBox(vec3f(lp.x - Rr - w + 0.06 * sc, yl - flightY - 0.3 * sc, lp.z), vec3f(0.06 * sc, 0.3 * sc, Rr)), 0.0, 0.0, side));
  return r;
}

// Topology 3: an infinite house of stairs, every cell mirrored into its neighbours, which
// turns a quarter about the travel corridor on refolds.
fn es_folded(p0: vec3f) -> vec4f {
  let C = S.p[1].y;
  let ax = vec3f(0.0, C * 0.5, C * 0.5);
  let p = rotX(-S.p[7].z) * (p0 - ax) + ax;
  let c = floor(p / C);
  var l = p - (c + 0.5) * C;
  let par = fmod3(c, vec3f(2.0));
  l = l * (1.0 - 2.0 * par);
  let q = C * 0.5 - abs(l);
  let faceD = max(min(q.x, min(q.y, q.z)), 0.0);
  let empty = hash13(c + vec3f(S.p[4].w * 19.0)) < 0.3;
  if ((c.y == 0.0 && c.z == 0.0) || empty) { return vec4f(faceD + 0.02 * C, 0.0, 0.0, 0.0); }
  var r = es_room(l * (4.0 / C), 0.8 + 0.15 * fmod(c.x + c.y * 2.0 + c.z, 2.0));
  r.x *= C * 0.25;
  r.w = fmod(par.x + par.y * 2.0, 3.0);
  return r;
}

fn es_map(p: vec3f) -> vec4f {
  let t = S.p[0].x;
  if (t < 1.5) { return es_tower(p); }
  return es_folded(p);
}

fn es_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * es_map(p + k.xyy * e).x + k.yyx * es_map(p + k.yyx * e).x +
                   k.yxy * es_map(p + k.yxy * e).x + k.xxx * es_map(p + k.xxx * e).x);
}

fn es_shadow(ro: vec3f, rd: vec3f, k: f32, tmax: f32) -> f32 {
  var res = 1.0;
  var t = 0.02 * S.p[7].w;
  for (var i = 0; i < 24; i++) {
    let h = es_map(ro + rd * t).x;
    res = min(res, k * h / t);
    if (res < 0.01) { break; }
    t += clamp(h, 0.02, tmax * 0.1);
    if (t > tmax) { break; }
  }
  return sat(res);
}

fn es_ao(p: vec3f, n: vec3f, s: f32) -> f32 {
  var o = 0.0; var w = 1.0;
  for (var i = 1; i <= 4; i++) {
    let h = s * (0.04 + 0.12 * f32(i));
    o += (h - es_map(p + n * h).x) / s * w;
    w *= 0.6;
  }
  return sat(1.0 - o * 2.0);
}

fn es_sky(rd: vec3f) -> vec3f {
  let lt = S.p[0].w;
  let hue = S.p[5].x;
  let lum = select(select(0.3, 0.03, lt > 0.5), 0.012, lt > 1.5);
  var c = mix(palL(hue + 0.5, lum * 0.5), palL(hue + 0.4, lum), sat(rd.y * 0.5 + 0.5));
  c = mix(c, vec3f(luma(c)), 0.75);
  return c;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[2].xyz;
  let cam = lookAt(ro, S.p[3].xyz, S.p[2].w);
  let rd = normalize(cam * vec3f(q, S.p[3].w));
  let topo = S.p[0].x;
  let lt = S.p[0].w;
  let pm = S.p[0].z;
  let hue = S.p[5].x + F.morph2.x * 0.15;
  let sc = S.p[7].w;
  let unit = sc;

  var t = 0.0;
  var far = 80.0 * sc;
  t = max(t, 0.0) + ign(frag) * 0.02 * unit;
  var hit = false;
  var r = vec4f(0.0);
  for (var i = 0; i < 120; i++) {
    r = es_map(ro + rd * t);
    if (r.x < 0.0006 * t + 0.0005 * unit) { hit = true; break; }
    t += r.x;
    if (t > far) { break; }
  }
  // Light rig.
  let key = select(normalize(vec3f(0.45, 0.8, 0.3)), normalize(vec3f(-0.65, 0.55, -0.25)), lt > 0.5 && lt < 1.5);
  let keyI = select(select(2.3, 3.4, lt > 0.5), 0.25, lt > 1.5);
  let keyC = mix(vec3f(1.0, 0.92, 0.8), palL(hue + 0.1, 1.0), 0.3) * keyI;
  var col = es_sky(rd);
  // The lamp floating in the stairwell: its height follows the melody.
  let lampP = vec3f(S.p[4].x, S.p[4].y, S.p[5].y);
  let lampR = select(1.1 * sc, S.p[1].y * 0.55, topo > 2.5);
  let leadCol = palL(hue + 0.45 + 0.2 * F.leadPitch, 1.0);
  let lampI = 0.3 * S.p[5].w + 3.5 * S.p[7].x;
  if (hit) {
    let pos = ro + rd * t;
    let n = es_normal(pos, max(0.0004 * unit, 0.0005 * t));
    let ao = es_ao(pos, n, sc);
    let sk = select(select(9.0, 48.0, lt > 0.5 && lt < 1.5), 8.0, lt > 1.5);
    var sh = 1.0;
    if (lt < 1.5) { sh = es_shadow(pos + n * 0.01 * sc, key, sk, 25.0 * sc); }
    // Face classes by orientation relative to the gravity frame: tread, riser, side.
    let fid = r.w;
    let an = abs(n);
    let up = an.y;
    let fr = select(an.z, an.x, topo > 0.5 && topo < 1.5 && fmod(fid, 2.0) < 0.5);
    let tread = smoothstep(0.6, 0.9, up);
    let riser = smoothstep(0.6, 0.9, fr) * (1.0 - tread);
    var tone = mix(0.16, 0.65, tread) + riser * 0.18;
    var tint: vec3f;
    if (pm < 0.5) {
      // Lithograph: one hue, engraved hatching on the darker faces.
      let hd = dot(pos, normalize(vec3f(1.0, 0.6, -0.8))) * 20.0 / unit;
      let hatch = 1.0 - 0.22 * (1.0 - tread) * smoothstep(0.3, 0.7, sin(hd) * 0.5 + 0.5) * sat(1.0 - t / (10.0 * unit));
      tone *= hatch;
      tint = mix(vec3f(1.0), palL(hue, 1.0), 0.25);
    } else if (pm < 1.5) {
      tint = mix(vec3f(1.0), palL(hue + fid * 0.29, 1.0), 0.45);
    } else {
      let cellH = hash13(floor(pos / (unit * 2.0)) + vec3f(r.z));
      tint = mix(vec3f(1.0), palL(hue + cellH * 0.6, 1.0), 0.35);
      tone = tone * 0.8 + 0.12;
    }
    let alb = tint * tone;
    let dif = sat(dot(n, key)) * sh;
    var amb = es_sky(normalize(n + vec3f(0.0, 0.7, 0.0)));
    if (lt < 0.5) { amb = amb * 1.1 + palL(hue + 0.15, 0.05) * sat(-n.y + 0.4) + keyC * 0.03 * sat(dot(n, -key) + 0.5); }
    var c = alb * (keyC * dif + amb * ao * 1.6);
    if (lt > 0.5 && lt < 1.5) {
      // Noir rim and a faint cold fill so the shadows still read.
      c += alb * palL(hue + 0.5, 0.25) * pow(1.0 - sat(dot(n, -rd)), 3.0) * ao;
      c += alb * palL(hue + 0.55, 0.05) * (0.5 + 0.5 * dot(n, -key)) * ao;
    }
    if (lt > 1.5) {
      // Carried lantern at the camera.
      let lv = ro + vec3f(0.0, 0.3, 0.0) * unit - pos;
      let ld = length(lv);
      let lan = palL(hue + 0.08, 1.0) * 1.3 * sat(dot(n, lv / ld)) / (1.0 + ld * ld / (16.0 * unit * unit)) * 2.0;
      c += alb * lan * ao;
    }
    // Stair nosings: one band per step; each kick sends a wave of light climbing them.
    if (r.y > 0.5 && r.y < 1.5) {
      let stepI = r.z;
      let edge = riser * 1.0;
      let band = fract(stepI * 0.137 + 0.05);
      let kA = S.p[6].x;
      let sf = select(fract(stepI / 10.0), stepI / 8.0, topo > 2.5);
      let wave = exp(-pow((sf - kA * 2.8) * 4.0, 2.0)) * exp(-kA * 2.5) * S.p[1].z;
      let lvl = spec(0.04 + 0.85 * band);
      c += palL(hue + 0.3 + band * 0.3, 1.0) * edge * (0.03 + 0.6 * lvl * lvl) * S.p[6].z * 0.6;
      c += palL(hue + 0.12, 1.0) * (0.35 + 0.65 * edge) * wave * 1.0;
    }
    // In the tower each kick also sends a ring of light rising up the stairwell.
    if (topo < 1.5) {
      let kA = S.p[6].x;
      let wy = (pos.y - (ro.y - 2.0 * sc + kA * 5.0 * sc)) / (0.45 * sc);
      c += palL(hue + 0.12, 1.0) * exp(-wy * wy) * exp(-kA * 2.5) * S.p[1].z * (0.3 + 0.7 * ao) * 0.9;
    }
    // Snares light the arch walls near you.
    if (r.y > 1.5) {
      c += palL(hue + 0.55, 1.0) * S.p[6].y * 1.0 * (0.3 + 0.7 * riser) * exp(-t / (3.0 * unit));
    }
    // The lamp: lights the stone around it and rings out through it on each note.
    let lv = pos - lampP;
    let ldd = length(lv);
    let lg = exp(-ldd * ldd / (lampR * lampR));
    c += alb * leadCol * lampI * lg * (sat(dot(n, -lv / max(ldd, 1e-5))) * 0.8 + 0.2) * 3.0;
    // Rings of the latest and the previous note (a new note never cuts the last ring off), each
    // fading out before it reaches the camera so it never sweeps across the whole view.
    let ages = vec2f(fmod(S.p[5].z, 4096.0), floor(S.p[5].z / 4096.0)) / 1000.0;
    let amps = vec2f(S.p[7].y, fract(S.p[4].z) / 0.45);
    let near = smoothstep(0.25 * lampR, 1.1 * lampR, length(pos - ro));
    let ringR = lampR * (0.25 + ages * 5.0);
    let rq = (vec2f(ldd) - ringR) / (lampR * 0.3);
    let ring = dot(exp(-rq * rq) * exp(-ages * 3.0), amps) * near;
    c += leadCol * ring * (0.55 + 0.35 * S.p[5].w) * (0.4 + 0.6 * ao);
    col = c;
  }
  // Atmosphere.
  let fogK = 0.012 / sc;
  let fogA = 1.0 - exp(-t * fogK * (1.0 + S.p[6].w));
  col = mix(col, es_sky(rd) * 0.9, fogA);
  col *= 1.0 - 0.4 * S.p[6].w;
  // The lamp itself, unless the stone hides it.
  let tl = dot(lampP - ro, rd);
  if (tl > 0.0 && (!hit || tl < t)) {
    let dd = length(lampP - ro - rd * tl) / (lampR * 0.6);
    col += leadCol * (0.002 / (dd * dd + 0.0012) + 0.02 / (dd + 0.04)) * (0.15 + 0.4 * S.p[5].w + 1.6 * S.p[7].x);
  }
  return vec4f(col, 1.0);
}
`,
});
