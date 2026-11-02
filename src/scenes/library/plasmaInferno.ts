import { raymarchScene } from '../raymarchScene';

/**
 * Volumetric plasma fire. A domain-warped turbulence volume is advected by integrated
 * motion phases and rendered emission/absorption with a blackbody ramp blended into the
 * palette. Bass flares the volume, snares burst it, hats spray embers. Before a drop it
 * compresses into a hotter, faster-flickering core; on the drop it erupts.
 *
 * DNA picks the construction (flame column, fire tornado, plasma sun, vortex ring,
 * firestorm wall, or an electric plasma globe of glass and tendrils), the camera rig,
 * the colour model (blackbody, palette, blue-hot, ghost), the setting (scorched ground,
 * starry void, mirror floor), turbulence scale, smoke, and what the kick does
 * (shockwave ring, size pump, or jets that surge the fire upward).
 */

const st = {
  kickAge: 9, prevKick: 0, kickAmp: 0,
  burstAge: 9, prevSnare: 0, burstAmp: 0, burstPos: [0, 0.5, 0] as [number, number, number],
  flare: 1, lastTime: -1, jet: 0, pump: 0,
};

export default raymarchScene({
  // Dropped from auto-direction: a fire object floating in a void, not a place to fly through.
  // An unreachable energy range and mood with no genre affinity keep scoreScene() at the
  // bottom of every ranking. Still available when pinned by hand.
  meta: {
    id: 'plasma-inferno',
    name: 'Plasma Inferno',
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: -1, arousal: -1 },
    genres: {},
    trails: 0.35,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    if (Math.abs(m.time - st.lastTime) > 0.5) {
      st.kickAge = 9; st.burstAge = 9; st.flare = 1; st.pump = 0;
    }
    st.lastTime = m.time;

    if (m.kick > st.prevKick + 0.2) { st.kickAge = 0; st.kickAmp = Math.min(1.2, m.kick); }
    st.prevKick = m.kick;
    st.kickAge += dt;
    if (m.snare > st.prevSnare + 0.15) {
      st.burstAge = 0;
      st.burstAmp = Math.min(1, m.snare);
      const a = Math.random() * Math.PI * 2;
      const r = 0.25 + Math.random() * 0.45;
      st.burstPos = [Math.cos(a) * r, -0.1 + Math.random() * 1.1, Math.sin(a) * r];
    }
    st.prevSnare = m.snare;
    st.burstAge += dt;

    const mode = Math.floor(g[0] * 6); // 0 column, 1 tornado, 2 orb, 3 vortex ring, 4 firestorm wall, 5 plasma globe
    const rig = Math.floor(g[1] * 5); // 0 low orbit, 1 crane above, 2 worm's-eye, 3 close push, 4 side dolly
    const cmode = Math.floor(g[2] * 4); // 0 blackbody/palette, 1 palette, 2 blue-hot, 3 ghost
    const env = Math.floor(g[4] * 3); // 0 scorched ground, 1 void, 2 mirror floor
    const grammar = Math.floor(g[5] * 3); // 0 shock ring, 1 size pump, 2 jets

    const ant = m.anticipation;
    const drop = m.dropPulse;
    // Flare follows bass with a fast attack and slower release.
    const flareTarget = 0.82 + 0.35 * m.bass + 0.15 * m.sub + 0.2 * m.energySlow;
    const k = flareTarget > st.flare ? 1 - Math.exp(-dt / 0.05) : 1 - Math.exp(-dt / 0.35);
    st.flare += (flareTarget - st.flare) * k;
    const kickEnv = st.kickAmp * Math.exp(-st.kickAge * 5);
    st.jet += dt * (grammar === 2 ? 2.5 * kickEnv : 0);
    const pump = grammar === 1 ? 1 + 0.22 * kickEnv : 1;
    const ringy = grammar === 0 || mode === 5 ? 1 : 0.35;

    // S.p[0]: size, compress, warp amount, mode
    p[0] = st.flare * (1 - 0.32 * ant) * (1 + 0.45 * drop) * pump * (mode === 4 ? 1.05 : 1);
    p[1] = ant;
    p[2] = (0.6 + 0.8 * g[3] + 0.4 * ev[1]) * (0.7 + 0.5 * m.flux + 0.4 * m.tension) + 0.8 * drop + 0.4 * ant;
    p[3] = mode;
    // S.p[1]: density gain, emission gain, temperature boost, flicker
    p[4] = 1.0 + 0.5 * m.energy + 0.6 * ant;
    p[5] = (0.8 + 0.5 * ctx.intensity + 0.35 * m.energy + 1.4 * drop) * (1 + 0.5 * m.kickNext) * (grammar === 2 ? 1 + 0.5 * kickEnv : 1) * (mode === 4 ? 0.6 : mode === 2 ? 0.8 : 1);
    p[6] = 0.35 * ant + 0.25 * drop + 0.15 * m.chordPulse + 0.1 * m.mid + 0.12 * (ev[3] - 0.5) + (grammar === 2 ? 0.25 * kickEnv : 0);
    p[7] = ant * ant;
    // S.p[2]: kick ring radius, amp, burst radius, amp
    p[8] = 0.25 + st.kickAge * 4.0;
    p[9] = st.kickAmp * Math.exp(-st.kickAge * 2.6) * ringy;
    p[10] = 0.05 + st.burstAge * 1.6;
    p[11] = st.burstAmp * Math.exp(-st.burstAge * 4.0);
    // S.p[3]: burst position, palette mix
    p[12] = st.burstPos[0];
    p[13] = st.burstPos[1];
    p[14] = st.burstPos[2];
    p[15] = cmode === 1 ? 0.95 : Math.min(0.7, 0.25 + 0.3 * g[7] + 0.2 * m.tension);
    // S.p[4]: camera position + roll
    const dir = g[6] < 0.5 ? 1 : -1;
    let a = ctx.spin * 0.3 * dir + g[7] * 6.28;
    let dist = 4.4 - 0.4 * m.energySlow - 0.7 * ant + 0.8 * drop;
    let h: number;
    let ty = mode === 0 || mode === 1 || mode === 4 ? 0.55 : 0.35;
    let focal = 1.5 + 0.25 * ant;
    let side = 0;
    if (rig === 0) h = 0.1 + 0.4 * Math.sin(ctx.spin * 0.27) + 0.3 * ev[2];
    else if (rig === 1) h = 1.9 + 0.5 * Math.sin(ctx.spin * 0.2) + 0.6 * ev[2];
    else if (rig === 2) { h = -0.75 + 0.25 * Math.sin(ctx.spin * 0.33); ty += 0.6; dist *= 0.85; }
    else if (rig === 3) { h = 0.4 + 0.3 * ev[2]; dist *= 0.62; focal = 1.05 + 0.2 * ant; }
    else { h = 0.3 + 0.2 * ev[2]; side = Math.sin(ctx.spin * 0.22) * 2.6; a = g[7] * 6.28; }
    // The firestorm wall is watched from the front, sweeping side to side.
    if (mode === 4) a = Math.PI * 1.5 + 0.55 * Math.sin(ctx.spin * 0.18 + g[7] * 6.28);
    if (mode === 1) ty += 0.35;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    p[16] = ca * dist - sa * side;
    p[17] = h;
    p[18] = sa * dist + ca * side;
    p[19] = Math.sin(ctx.spin * 0.19 + g[6] * 5) * (rig === 3 ? 0.18 : 0.08);
    // S.p[5]: target y, focal length, ember gain, shimmer
    p[20] = ty;
    p[21] = focal;
    p[22] = (0.4 + 1.8 * m.hat + 1.2 * m.high + 2.5 * drop) * (0.4 + 1.2 * g[6]);
    p[23] = 0.5 + 0.8 * m.energy + 0.8 * ant;
    // S.p[6]: rise phase, smoke amount, hue offset, morph
    p[24] = ctx.travel * (0.55 + 0.25 * g[3]) + st.jet;
    p[25] = (0.25 + 0.75 * g[6]) * (0.5 + 0.5 * (1 - m.energySlow));
    p[26] = g[7] * 0.25;
    p[27] = ev[0];
    // S.p[7]: noise frequency, ground height, packed (env, colour, grammar), globe tendrils
    p[28] = 2.2 + 2.8 * g[3];
    p[29] = env === 1 ? -100 : -1.25;
    p[30] = env + 4 * cmode + 16 * grammar;
    p[31] = 5 + Math.floor(g[5] * 7 * 0.999) % 4 + Math.floor(ev[0] * 3);
  },
  wgsl: /* wgsl */ `
const PI_CENTER: vec3f = vec3f(0.0, 0.35, 0.0);

fn pi_env() -> i32 { return i32(S.p[7].z + 0.5) & 3; }
fn pi_cmode() -> i32 { return (i32(S.p[7].z + 0.5) >> 2) & 3; }

// Blackbody-ish ramp blended into the palette: pal0 smoke -> pal1/pal2 -> pal3/white core.
fn pi_col(T: f32) -> vec3f {
  let t = sat(T);
  var bb = vec3f(sat(t * 1.9), pow(sat(t * 1.9 - 0.5), 1.5), pow(sat(t * 2.3 - 1.4), 2.0));
  let cm = pi_cmode();
  if (cm == 2) { bb = vec3f(bb.b * 0.8, bb.g * 0.95, bb.r * 1.05); }
  if (cm == 3) { bb = mix(vec3f(luma(bb)), luma(bb) * F.pal3.rgb / max(luma(F.pal3.rgb), 0.05), 0.35); }
  let pr = palRamp(t * 0.95 + S.p[6].z + F.chordHue * 0.04);
  var pc = pr / max(luma(pr), 0.02);
  pc = max(mix(vec3f(1.0), pc, 1.5), vec3f(0.0)) * max(luma(bb), 0.002);
  var c = mix(bb, pc, S.p[3].w * (1.0 - smoothstep(0.8, 1.0, t)));
  c += vec3f(1.0, 0.95, 0.9) * smoothstep(0.86, 1.0, t) * 0.9;
  return c;
}

// Rotated octaves (cubic first octave) so linear-filtered noise shows no axis-aligned creases.
fn pi_fbm(p: vec3f) -> f32 {
  let m = mat3x3f(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  var q = m * p;
  var s = 0.5 * noise3(q);
  var a = 0.25;
  for (var i = 0; i < 3; i++) {
    q = m * q * 2.03 + vec3f(1.7, 9.2, 3.1);
    s += a * noise3fast(q);
    a *= 0.5;
  }
  return s;
}

// Returns (density, temperature).
fn pi_field(p: vec3f) -> vec2f {
  let size = S.p[0].x;
  let ps = (p - PI_CENTER) / size;
  let mode = i32(S.p[0].w);
  let rise = S.p[6].x;
  let freq = S.p[7].x;
  let morph = S.p[6].w;
  var shape: f32;
  var q: vec3f;
  var hgt: f32;
  var smokeM = 0.0;
  if (mode == 0) {
    // Column: wide flaring base narrowing into licking tongues.
    let h = ps.y + 1.0;
    let rad = (0.9 + 0.3 * morph) * exp(-h * 0.45) + 0.12;
    let r = length(ps.xz);
    shape = 1.0 - r / rad - 1.6 * smoothstep(1.1, 2.7, h) - 2.0 * smoothstep(0.05, -0.35, h);
    q = vec3f(ps.x * freq, (ps.y - rise) * freq * 0.5, ps.z * freq);
    // Smoke plume above the flame tips, widening as it rises.
    smokeM = smoothstep(1.3, 2.2, h) * (1.0 - smoothstep(2.9, 3.6, h)) * sat(1.0 - r / (0.35 + 0.3 * h));
    hgt = sat(h / 2.6);
  } else if (mode == 1) {
    // Fire tornado: a narrow twisting funnel whose turbulence spirals up its axis.
    let h = ps.y + 1.0;
    let off = vec2f(sin(h * 1.3 + rise * 0.4), cos(h * 1.1 + rise * 0.3)) * 0.12 * h;
    let pq = ps.xz - off;
    let r = length(pq);
    let rad = 0.2 + 0.16 * h + 0.25 * exp(-h * 4.0);
    shape = 1.0 - r / rad - 1.4 * smoothstep(2.4, 3.2, h) - 2.0 * smoothstep(0.05, -0.3, h);
    let tw = h * (1.4 + 1.6 * morph) + rise * 1.1;
    let rq = rot2(tw) * pq;
    q = vec3f(rq.x * freq * 1.3, (h * 0.5 - rise * 0.25) * freq, rq.y * freq * 1.3);
    smokeM = smoothstep(2.6, 3.1, h) * sat(1.0 - r / (0.5 + 0.3 * h));
    hgt = sat(h / 3.0);
  } else if (mode == 2) {
    // Orb: plasma sun with outward flow.
    let r = length(ps);
    shape = 1.0 - r / (1.05 + 0.3 * morph);
    let dir = ps / max(r, 1e-3);
    q = ps * freq - dir * rise * 0.8 + vec3f(0.0, -rise * 0.25, 0.0);
    hgt = sat(r * 0.75);
  } else if (mode == 3) {
    // Vortex ring: swirling torus of fire that also lifts.
    let rr = length(ps.xz);
    let R = 1.0 + 0.3 * morph;
    let d = length(vec2f(rr - R, ps.y * 1.1));
    shape = 1.0 - d / 0.62;
    let ang = atan2(ps.z, ps.x) + rise * 0.35;
    q = vec3f(cos(ang) * rr, ps.y - rise * 0.6, sin(ang) * rr) * freq * 1.2;
    hgt = sat(d * 1.2 + 0.25 * (ps.y + 0.5));
  } else {
    // Firestorm wall: a long curtain of flame with ragged crests.
    let h = ps.y + 1.0;
    let zc = ps.z + 0.18 * sin(ps.x * 2.1 + rise * 0.2);
    let thick = 0.3 + 0.1 * sin(ps.x * 1.7 + rise * 0.3);
    let top = 1.0 + 0.6 * morph + 0.35 * sin(ps.x * 1.3 - rise * 0.15);
    shape = 1.0 - abs(zc) / thick - 1.4 * smoothstep(top * 0.6, top + 0.9, h) - 2.0 * smoothstep(0.05, -0.3, h) - 2.0 * smoothstep(1.6, 2.2, abs(ps.x));
    q = vec3f(ps.x * freq * 1.4, (ps.y - rise) * freq * 0.8, ps.z * freq * 1.4);
    smokeM = smoothstep(top, top + 0.8, h) * (1.0 - smoothstep(2.6, 3.2, h)) * sat(1.0 - abs(zc) / (0.4 + 0.3 * h)) * smoothstep(2.0, 1.4, abs(ps.x));
    hgt = sat(h / 2.4);
  }
  // Kick shockwave (flattened shell) and snare burst (expanding puff), analytic.
  let ka = S.p[2].y;
  var ring = 0.0;
  if (ka > 0.01) {
    // A torus of fire racing outward from the base (orb/ring: through the equator).
    let ry = select(0.0, -0.55, mode <= 1 || mode == 4);
    let tr = vec2f(length(ps.xz) - S.p[2].x, (ps.y - ry) * 1.3);
    ring = exp(-dot(tr, tr) * 45.0) * ka;
  }
  let ba = S.p[2].w;
  var puff = 0.0;
  if (ba > 0.01) {
    let bd = length(ps - S.p[3].xyz) - S.p[2].z;
    puff = exp(-bd * bd * 18.0) * ba;
  }
  // Empty-space skip: the turbulence can't lift density above zero this far out.
  if (shape < -0.9 && smokeM < 0.01 && ring < 0.01 && puff < 0.01) { return vec2f(0.0); }
  // Fast flicker under anticipation.
  q += vec3f(0.0, F.time * 2.5 * S.p[1].w, 0.0);
  // Domain warp from a single 4-channel sample, then turbulent fbm.
  // (Cubic-smoothed: linear filtering here leaves creases on horizontal texel planes.)
  let w = noise4(q * 0.42 + vec3f(0.0, -F.warp * 0.25, 0.0)).xyz;
  let n = pi_fbm(q + w * S.p[0].z);
  let turb = abs(n) * 2.0;
  var dens = sat((shape * 1.25 + n * 3.0 - 0.1 + S.p[0].y * 0.2) * 1.8);
  // Temperature: hot core, cooling outward; turbulence carves cooler tongues.
  var temp = shape * 0.5 + n * 0.95 + 0.1 - turb * 0.2 + S.p[1].z * sat(shape + 0.3);
  // Spectrum by height (smoothed over neighbouring bands so it never stripes):
  // the base listens to bass, the tips to highs, broken up by the turbulence.
  let sx = hgt * 0.8 + 0.05;
  let lvl = (spec(sx - 0.05) + spec(sx) + spec(sx + 0.05)) * 0.333;
  temp += lvl * 0.3 * sat(shape + 0.6) * sat(n * 2.5 + 0.6);
  // Dark smoke: dense, cold.
  let sm = smokeM * sat(n * 3.0 + 0.35) * S.p[6].y;
  dens = max(dens, sm * 0.9);
  temp -= sm * 0.8;
  let rn = ring * (0.5 + 0.9 * sat(n + 0.5));
  dens += rn * 0.8;
  temp = max(temp, 0.55 * rn + 0.2) + rn * 0.25;
  let pn = puff * (0.5 + sat(n * 2.0 + 0.6));
  dens += pn * 0.9;
  temp += pn * 0.45;
  return vec2f(dens, sat(temp));
}

fn pi_sphere(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> vec2f {
  let oc = ro - c;
  let b = dot(oc, rd);
  let h = b * b - dot(oc, oc) + r * r;
  if (h < 0.0) { return vec2f(-1.0); }
  let s = sqrt(h);
  return vec2f(-b - s, -b + s);
}

fn pi_embers(ro: vec3f, rd: vec3f, cam: mat3x3f, q: vec2f, tMax: f32) -> vec3f {
  var acc = vec3f(0.0);
  let fwd = cam[2];
  let gain = S.p[5].z;
  let wide = select(0.0, 1.6, i32(S.p[0].w) == 4);
  for (var k = 0; k < 5; k++) {
    let fk = f32(k);
    let depth = 2.6 + fk * 1.1;
    let tt = depth / max(dot(rd, fwd), 0.2);
    if (tt > tMax) { continue; }
    let wp = ro + rd * tt;
    // Lateral coordinates on the slice, sparks rise through cells.
    let sp = vec2f(dot(wp, cam[0]), wp.y - F.travel * (0.9 + 0.25 * fk) - fk * 7.3);
    let cs = 0.32;
    let cell = floor(sp / cs);
    let h = hash33(vec3f(cell, fk * 13.1 + 1.0));
    if (h.z < 0.86) { continue; }
    let wob = vec2f(sin(F.warp * 2.0 + h.x * 30.0) * 0.25, 0.0);
    let c = (cell + 0.5 + (h.xy - 0.5) * 0.6 + wob) * cs;
    let d = length((sp - c) * vec2f(1.0, 0.3));
    // Fade with distance from the fire axis and height.
    let ax = vec2f(max(abs(wp.x) - wide, 0.0), wp.z);
    let fade = exp(-max(length(ax) - 0.4, 0.0) * 2.0) * smoothstep(3.6, 0.0, wp.y) * smoothstep(-1.3, -0.6, wp.y);
    let flick = 0.5 + 0.5 * sin(F.time * (8.0 + h.y * 14.0) + h.x * 40.0);
    let core = exp(-d * d * 12000.0 / (1.0 + fk * 0.3));
    let halo = exp(-d * d * 900.0) * 0.08;
    acc += pi_col(0.6 + 0.35 * h.y) * (core + halo) * fade * flick * gain * 1.6;
  }
  return acc;
}

// Volume march through the bounding sphere; returns (colour, transmittance).
fn pi_march(ro: vec3f, rd: vec3f, tMax: f32, steps: f32, jit: f32) -> vec4f {
  var col = vec3f(0.0);
  var trans = 1.0;
  let size = S.p[0].x;
  let mode = i32(S.p[0].w);
  let up = select(0.0, 0.6, mode <= 1 || mode == 4);
  let bC = PI_CENTER + vec3f(0.0, up * size, 0.0);
  let bR = 2.35 * size;
  let bs = pi_sphere(ro, rd, bC, bR);
  if (bs.y > 0.0) {
    let t0 = max(bs.x, 0.0);
    let t1 = min(bs.y, tMax);
    // Empty space is crossed at double stride.
    let dt = (t1 - t0) / steps;
    var t = t0 + dt * jit;
    let emit = S.p[1].y;
    let densG = S.p[1].x;
    let flick = 1.0 + 0.35 * S.p[1].w * sin(F.time * 31.0);
    let smokeAmt = S.p[6].y;
    for (var i = 0; i < 64; i++) {
      if (t > t1) { break; }
      let p = ro + rd * t;
      let f = pi_field(p);
      let d = f.x * densG * sat((bR - length(p - bC)) * 1.5);
      if (d > 0.002) {
        let T = f.y;
        // Cool, dense regions read as smoke: absorb more, emit little.
        let smoke = smoothstep(0.45, 0.15, T) * smokeAmt;
        let sigma = d * (1.3 + 4.0 * smoke);
        let e = pi_col(T) * (0.12 + 0.5 * T + 1.1 * T * T * T * T) * d * emit * flick;
        let sc = mix(F.pal0.rgb * 0.4, pi_col(0.4) * 0.6, 0.5) * smoke * d * 0.12;
        let a = exp(-sigma * dt);
        col += trans * (e + sc) * (1.0 - a) / max(sigma, 1e-3);
        trans *= a;
        if (trans < 0.03) { break; }
        t += dt;
      } else {
        t += dt * select(1.0, 2.0, f.x <= 0.0);
      }
    }
  }
  return vec4f(col, trans);
}

// Closest approach between a ray and segment [a, b]: (distance, t along ray).
fn pi_raySeg(o: vec3f, d: vec3f, a: vec3f, b: vec3f) -> vec2f {
  let ba = b - a;
  let oa = o - a;
  let baba = dot(ba, ba);
  let bard = dot(ba, d);
  let s = sat((dot(ba, oa) - dot(d, oa) * bard) / max(baba - bard * bard, 1e-6));
  let t = max(s * bard - dot(d, oa), 0.0);
  let sp = sat(dot(oa + d * t, ba) / max(baba, 1e-6));
  return vec2f(length(oa + d * t - ba * sp), t);
}

// Plasma globe: glass sphere, glowing electrode, wandering tendrils to the glass.
// Returns (colour, coverage of the glass).
fn pi_globe(ro: vec3f, rd: vec3f, pa: f32) -> vec4f {
  let size = S.p[0].x;
  let R = 1.2 * size;
  let c = PI_CENTER;
  let hs = pi_sphere(ro, rd, c, R);
  if (hs.y <= 0.0) { return vec4f(0.0); }
  let n = i32(S.p[7].w);
  let seed = S.p[3].xyz * 3.0;
  var glow = vec3f(0.0);
  let rise = S.p[6].x;
  for (var k = 0; k < 8; k++) {
    if (k >= n) { break; }
    let fk = f32(k);
    // Base direction on a slowly turning Fibonacci sphere, reseeded by snares.
    let zz = 1.0 - (fk + 0.5) / f32(n) * 2.0;
    let az = fk * 2.39996 + F.warp * 0.15 + seed.x;
    var dir = normalize(vec3f(sqrt(1.0 - zz * zz) * cos(az), zz, sqrt(1.0 - zz * zz) * sin(az)));
    var prev = c + dir * 0.18 * size;
    var best = 1e9;
    var tb = 0.0;
    for (var j = 1; j <= 5; j++) {
      let fj = f32(j) / 5.0;
      let wq = noise4fast(vec3f(fk * 7.1 + seed.y, fj * 3.5 - rise * 0.6, F.time * 1.3 + seed.z)).xyz;
      let pj = c + normalize(dir + wq * 0.8 * fj) * mix(0.18, 1.0, fj) * R * 0.985;
      let e = pi_raySeg(ro, rd, prev, pj);
      if (e.x < best) { best = e.x; tb = e.y; }
      prev = pj;
    }
    let w = max(0.012 * size, pa * tb);
    let lvl = spec(0.1 + 0.8 * fract(fk * 0.37));
    let core = exp(-best * best / (w * w)) * (0.012 * size / w);
    let halo = 1.0 / (1.0 + best * best * 900.0 / (size * size));
    let amp = 0.6 + 2.5 * lvl * lvl + 1.5 * F.kick + 1.5 * S.p[2].y;
    glow += (pi_col(0.97) * core * 2.5 + pi_col(0.7 + 0.2 * lvl) * halo * 0.12) * amp;
  }
  // Electrode ball.
  let eb = pi_sphere(ro, rd, c, 0.16 * size);
  var col = glow * min(S.p[1].y, 1.5) * 0.5;
  // Thin ionised haze filling the glass, swirling with the mids.
  let chord = (hs.y - max(hs.x, 0.0)) / R;
  let hz = 0.5 + 0.5 * noise3fast(rd * 6.0 + vec3f(0.0, -rise * 0.3, F.time * 0.2));
  col += pi_col(0.55) * chord * chord * 0.05 * (0.4 + hz) * (0.6 + 1.2 * F.mid);
  if (eb.x > 0.0) {
    let pn = normalize(ro + rd * eb.x - c);
    col += pi_col(0.9) * (0.6 + 1.5 * pow(sat(dot(pn, -rd)), 2.0)) * (1.0 + F.kick);
  }
  col += pi_col(0.8) * 0.4 / (1.0 + 60.0 * pow(length(cross(rd, c - ro)) / size, 2.0)) * (0.5 + F.bass);
  // Glass: fresnel rim and a window highlight.
  let gp = ro + rd * max(hs.x, 0.0);
  let gn = normalize(gp - c);
  let fre = pow(1.0 - sat(dot(gn, -rd)), 4.0);
  let L = normalize(vec3f(0.5, 0.8, 0.3));
  let spc = pow(sat(dot(reflect(rd, gn), L)), 80.0);
  col += (F.pal1.rgb * 0.05 + pi_col(0.6) * 0.08) * fre + vec3f(1.0, 0.97, 0.92) * spc * 1.2;
  return vec4f(col, 0.1 + 0.4 * fre);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  var q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[4].xyz;
  let ta = vec3f(0.0, S.p[5].x, 0.0);
  let cam = lookAt(ro, ta, S.p[4].w);
  let mode = i32(S.p[0].w);
  let env = pi_env();
  // Heat shimmer: refract rays above and around the fire.
  let sh = noise4(vec3f(q * 7.0, 0.0) + vec3f(0.0, -F.travel * 1.6, F.time * 0.7)).xy;
  let shMask = smoothstep(1.2, 0.0, abs(q.x)) * smoothstep(-0.8, 0.4, q.y) * select(1.0, 0.2, mode == 5);
  q += sh * 0.006 * S.p[5].w * shMask;
  let rd = normalize(cam * vec3f(q, S.p[5].y));
  let groundY = S.p[7].y;
  let size = S.p[0].x;
  let jit = ign(frag);

  // Background: dark glow behind the fire so smoke can silhouette against it.
  let glowDir = normalize(PI_CENTER + vec3f(0.0, 0.6, 0.0) - ro);
  let gd = sat(dot(rd, glowDir));
  var bg = F.pal0.rgb * (0.05 + 0.06 * sat(rd.y + 0.3)) + pi_col(0.45) * pow(gd, 7.0) * 0.12 * (0.6 + F.energySlow);
  bg += F.pal1.rgb * pow(gd, 3.0) * 0.03;
  if (env == 1) {
    // Starry void.
    let g = rd * 180.0;
    let hs = hash13(floor(g));
    bg += vec3f(0.8, 0.85, 1.0) * pow(smoothstep(0.996, 1.0, hs), 2.0) * smoothstep(0.4, 0.0, length(fract(g) - 0.5)) * 0.6;
    bg += F.pal2.rgb * 0.02 * pow(sat(fbm3(rd * 3.0, 3) + 0.4), 3.0);
  }

  var tMax = 40.0;
  if (rd.y < 0.0 && env != 1) {
    tMax = (groundY - ro.y) / rd.y;
    let gp = ro + rd * tMax;
    // Ground lit by the fire, with scorched texture and the shockwave ring of light.
    let toF = PI_CENTER + vec3f(0.0, -0.4, 0.0) * size - gp;
    let dl = length(toF);
    let tex = fbm3(vec3f(gp.xz * 1.6, 0.0), 3);
    let alb = 0.35 + 0.4 * sat(tex + 0.5);
    let ndl = sat(normalize(toF).y + 0.15);
    var light = pi_col(0.5 + 0.2 * S.p[1].z) * S.p[1].y * 0.6 * ndl / (0.5 + dl * dl * 0.8);
    let gr = length(gp.xz) / max(size, 0.3);
    light += pi_col(0.7) * exp(-pow(gr - S.p[2].x * 1.05, 2.0) * 20.0) * S.p[2].y * 0.25;
    var gcol = F.pal0.rgb * 0.04 * alb + light * alb * 0.5;
    if (env == 2) {
      // Mirror floor: dark polished stone reflecting the fire.
      let rr = reflect(rd, normalize(vec3f(tex * 0.02, 1.0, 0.0)));
      var rc = vec3f(0.0);
      if (mode == 5) { rc = pi_globe(gp, rr, 2.0 / F.res.y).rgb; }
      else { rc = pi_march(gp, rr, 40.0, 22.0, jit).rgb; }
      gcol = F.pal0.rgb * 0.015 + light * 0.15 + rc * 0.55;
    } else {
      // Glossy streak of fire reflected on the floor.
      gcol += pi_col(0.6) * pow(sat(dot(reflect(rd, vec3f(0.0, 1.0, 0.0)), glowDir)), 30.0) * 0.12 * S.p[1].y;
    }
    bg = mix(gcol, bg, smoothstep(6.0, 16.0, tMax));
  }

  var col: vec3f;
  if (mode == 5) {
    let gl = pi_globe(ro, rd, 2.0 / (F.res.y * S.p[5].y));
    col = gl.rgb + bg * (1.0 - gl.w);
  } else {
    let v = pi_march(ro, rd, tMax, select(42.0, 56.0, mode == 4), jit);
    col = v.rgb + bg * v.w;
    col += pi_embers(ro, rd, cam, q, tMax) * (0.35 + 0.65 * v.w);
  }
  return vec4f(col, 1.0);
}
`,
});
