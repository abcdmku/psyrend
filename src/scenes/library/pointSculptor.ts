import { particleScene } from '../particleScene';
import type { Vec3 } from '../math';

/**
 * Point Sculptor: a million points hold a parametric sculpture, then pour into the next
 * one every few bars. Every point owns a latent surface coordinate (u, v) and chases its
 * slot on the current form with an underdamped spring, so a change of form overshoots,
 * wobbles and settles. The surface flows along its own parameter lines and the spectrum
 * pushes it out along the normal.
 *
 * Forms: sphere, torus knot, Klein bottle, supershape, helix stack, rolling vortex rings,
 * Möbius ribbon, spherical-harmonic blob.
 *
 * DNA
 *  0  form sequence (start form and stride through the eight)
 *  1  morph style: spring, sweeping wipe, explode-and-reform, spiral swirl, curl-noise melt
 *  2  point distribution: dust, contour lines, wire grid, bold beads
 *  3  camera: orbit, close sweep, overhead spin, bar-pulsed dolly
 *  4  colouring: flow gradient, rim light, spectrum band, depth, speed
 *  5  morph cadence: every 2, 4 or 8 bars
 *  6  form parameters (knot p:q, supershape symmetry, harmonic orders, helix strands)
 *  7  hue offset and tilt
 */

const FORMS = 8;
const STRIDES = [1, 3, 5, 7];

function plan(dna: readonly number[]) {
  return {
    start: Math.floor(dna[0] * FORMS) % FORMS,
    stride: STRIDES[Math.floor(((dna[0] * FORMS) % 1) * 4) % 4],
    style: Math.floor(dna[1] * 5) % 5,
    dens: Math.floor(dna[2] * 4) % 4,
    rig: Math.floor(dna[3] * 4) % 4,
    colour: Math.floor(dna[4] * 5) % 5,
    cadence: [2, 4, 8][Math.floor(dna[5] * 3) % 3],
  };
}

export default particleScene({
  // Dropped from auto-direction: a sculpture floating in a void that the camera orbits, the
  // "random 3D object" the show is moving away from. An unreachable energy range and mood with
  // no genre affinity keep scoreScene() at the bottom of every ranking. Still pinnable by hand.
  meta: {
    id: 'point-sculptor',
    name: 'Point Sculptor',
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: -1, arousal: -1 },
    genres: {},
    trails: 0.45,
    sparse: true,
  },
  count: 1 << 20,
  camera(ctx) {
    const m = ctx.music;
    const { rig } = plan(ctx.dna);
    const s = ctx.spin;
    const v = ctx.dna[7] * 6.283;
    const push = 0.8 * m.anticipation - 0.7 * m.dropPulse;
    let eye: Vec3;
    let target: Vec3 = [0, 0, 0];
    let fovY = 0.85;
    let roll = 0;
    switch (rig) {
      case 0: {
        const a = s * 0.35 + v;
        const el = 0.3 + 0.3 * Math.sin(s * 0.13 + v);
        const r = 3.6 + push;
        eye = [Math.cos(a) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(a) * Math.cos(el) * r];
        roll = 0.12 * Math.sin(s * 0.11);
        break;
      }
      case 1: {
        const a = s * 0.22 + v;
        const el = 0.45 * Math.sin(s * 0.09 + v);
        const r = 2.5 + 0.35 * Math.sin(s * 0.15) + push * 0.6;
        eye = [Math.cos(a) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(a) * Math.cos(el) * r];
        target = [0.35 * Math.sin(s * 0.17), 0.25 * Math.sin(s * 0.13), 0.35 * Math.cos(s * 0.17)];
        fovY = 1.05;
        roll = 0.3 * Math.sin(s * 0.07 + v);
        break;
      }
      case 2: {
        const a = s * 0.1 + v;
        const el = 1.15 + 0.2 * Math.sin(s * 0.08);
        const r = 3.8 + push;
        eye = [Math.cos(a) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(a) * Math.cos(el) * r];
        roll = s * 0.25 + v;
        break;
      }
      default: {
        // Dolly that breathes with the bar: in on the downbeat, out across the bar.
        const a = s * 0.28 + v;
        const el = 0.2 + 0.25 * Math.sin(s * 0.1);
        const pulse = Math.pow(1 - m.barPhase, 3);
        const r = 4.4 - 1.3 * pulse + push;
        eye = [Math.cos(a) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(a) * Math.cos(el) * r];
        fovY = 0.8;
      }
    }
    return { eye, target, fovY, roll };
  },
  streak: (ctx) => 0.02 + 0.03 * ctx.music.energy + 0.05 * ctx.music.dropPulse,
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const pl = plan(g);
    const bar = Math.max(m.barIndex, 0);
    const barLen = (m.beatsPerBar * 60) / Math.max(m.bpm, 40);
    const k = Math.floor(bar / pl.cadence);
    const age = ((bar % pl.cadence) + m.barPhase) * barLen;
    const form = (i: number) => (((pl.start + i * pl.stride) % FORMS) + FORMS) % FORMS;
    p[24] = form(k - 1);
    p[25] = form(k);
    p[26] = Math.min(age, 60);
    p[27] = pl.style + 0.98 * g[7];
    p[28] = pl.dens + 0.98 * g[2];
    p[29] = pl.colour + 0.98 * g[6];
    p[30] = ctx.spin * 0.25 + 1.5 * m.anticipation * m.anticipation;
    p[31] = (0.15 + 0.35 * m.energySlow + 0.4 * m.dropPulse) * (1 - 0.5 * m.anticipation);
  },
  wgsl: /* wgsl */ `
struct PsF { p: vec3f, n: vec3f };

fn ps_g6() -> f32 { return fract(S.p[7].y); }

fn ps_knot(t: f32) -> vec3f {
  var pq = array<vec2f, 6>(vec2f(2.0, 3.0), vec2f(3.0, 2.0), vec2f(2.0, 5.0), vec2f(3.0, 4.0), vec2f(3.0, 5.0), vec2f(2.0, 7.0));
  let k = pq[min(i32(ps_g6() * 6.0), 5)];
  let r = cos(k.y * t) * 0.5 + 1.0;
  return vec3f(r * cos(k.x * t), -sin(k.y * t) * 0.55, r * sin(k.x * t)) * 0.95;
}

fn ps_super(ph: f32, m: f32, n1: f32, n2: f32) -> f32 {
  let a = pow(abs(cos(m * ph * 0.25)), n2) + pow(abs(sin(m * ph * 0.25)), n2);
  return min(pow(max(a, 1e-4), -1.0 / n1), 2.2);
}

fn ps_raw(f: i32, u: f32, v: f32) -> vec3f {
  let g6 = ps_g6();
  let tm = F.travel * 0.04;
  switch f {
    case 0: {
      let th = acos(1.0 - 2.0 * v);
      let ph = u * TAU;
      return vec3f(sin(th) * cos(ph), cos(th), sin(th) * sin(ph)) * 1.15;
    }
    case 2: {
      // The classic Klein "bottle" immersion, recentred and scaled.
      let uu = u * PI;
      let vv = v * TAU;
      let c = cos(uu); let s = sin(uu); let cv = cos(vv); let sv = sin(vv);
      let c2 = c * c; let c4 = c2 * c2; let c6 = c4 * c2;
      let x = -2.0 / 15.0 * c * (3.0 * cv - 30.0 * s + 90.0 * c4 * s - 60.0 * c6 * s + 5.0 * c * cv * s);
      let y = -1.0 / 15.0 * s * (3.0 * cv - 3.0 * c2 * cv - 48.0 * c4 * cv + 48.0 * c6 * cv - 60.0 * s + 5.0 * c * cv * s
        - 5.0 * c2 * c * cv * s - 80.0 * c4 * c * cv * s + 80.0 * c6 * c * cv * s);
      let z = 2.0 / 15.0 * (3.0 + 5.0 * c * s) * sv;
      return vec3f(x - 0.15, y - 2.1, z) * 0.62;
    }
    case 3: {
      let m1 = 3.0 + floor(g6 * 6.0);
      let n1 = 0.35 + 1.4 * F.evolve.x + 0.6 * F.bass;
      let th = u * TAU - PI;
      let ph = v * PI - PI * 0.5;
      let r1 = ps_super(th, m1, n1, 1.0 + F.evolve.y);
      let r2 = ps_super(ph, m1 * 0.5 + 1.0, n1 * 1.3, 1.2);
      return vec3f(r1 * cos(th) * r2 * cos(ph), r2 * sin(ph), r1 * sin(th) * r2 * cos(ph)) * 0.85;
    }
    case 6: {
      // Moebius ribbon with 1 or 3 half-twists.
      let tw = select(1.0, 3.0, g6 > 0.5);
      let th = fract(u + tm * 0.5) * TAU;
      let s = (v * 2.0 - 1.0) * 0.5;
      let r = 1.05 + s * cos(tw * th * 0.5);
      return vec3f(r * cos(th), s * sin(tw * th * 0.5) + 0.12 * sin(th * 2.0 + tm), r * sin(th));
    }
    default: {
      // Spherical-harmonic blob.
      let l = 2.0 + floor(g6 * 5.0);
      let mm = 1.0 + floor(fract(g6 * 7.0) * 4.0);
      let th = acos(1.0 - 2.0 * v);
      let ph = u * TAU;
      let r = 0.95 + 0.32 * sin(l * th) * cos(mm * ph + tm * 2.0) * (0.6 + 0.6 * F.evolve.z);
      return vec3f(sin(th) * cos(ph), cos(th), sin(th) * sin(ph)) * r;
    }
  }
}

fn ps_form(f: i32, u0: f32, v: f32, w: f32) -> PsF {
  var o: PsF;
  let g6 = ps_g6();
  let tm = F.travel * 0.04;
  switch f {
    case 0: {
      o.p = ps_raw(0, u0, v);
      o.n = normalize(o.p);
    }
    case 1: {
      // Torus knot tube; points stream along the knot.
      let t = fract(u0 + tm * 0.3) * TAU;
      let c = ps_knot(t);
      let T = normalize(ps_knot(t + 0.01) - ps_knot(t - 0.01));
      let B = normalize(cross(T, c + vec3f(0.0, 0.3, 0.0)));
      let N = cross(B, T);
      let a = v * TAU;
      o.n = cos(a) * N + sin(a) * B;
      o.p = c + o.n * 0.17;
    }
    case 4: {
      // Helix stack: N strands around the axis, with rungs between pairs.
      let ns = 2.0 + floor(g6 * 4.0);
      let s = floor(v * ns);
      let t = fract(u0 + tm * 0.25);
      let ang = t * TAU * 2.5 + s * TAU / ns + tm;
      let y = (t * 2.0 - 1.0) * 1.35;
      let R = 0.72 + 0.12 * sin(t * TAU * 2.0 + tm);
      let rung = fract(v * ns) < 0.18;
      if (rung) {
        let rk = floor(t * 40.0) / 40.0;
        let ang2 = rk * TAU * 2.5 + s * TAU / ns + tm;
        let a2 = ang2 + TAU / ns;
        let yy = (rk * 2.0 - 1.0) * 1.35;
        let pa = vec3f(cos(ang2) * R, yy, sin(ang2) * R);
        let pb = vec3f(cos(a2) * R, yy, sin(a2) * R);
        o.p = mix(pa, pb, fract(v * ns) / 0.18);
        o.n = normalize(vec3f(o.p.x, 0.0, o.p.z) + vec3f(1e-4));
      } else {
        o.n = vec3f(cos(ang), 0.0, sin(ang));
        o.p = o.n * R + vec3f(0.0, y, 0.0) + o.n * (w - 0.5) * 0.06;
      }
    }
    case 5: {
      // Rolling vortex rings: points circulate around each ring's core.
      let k = floor(v * 3.0);
      let tor = fract(v * 3.0) * TAU;
      let pol = fract(u0 - tm * 0.8) * TAU;
      let R = 0.95 - 0.12 * k;
      let r = 0.26 + 0.05 * k;
      let yc = -0.85 + 0.85 * k + 0.1 * sin(tm * 2.0 + k);
      let er = vec3f(cos(tor), 0.0, sin(tor));
      o.n = er * cos(pol) + vec3f(0.0, sin(pol), 0.0);
      o.p = er * R + vec3f(0.0, yc, 0.0) + o.n * r;
    }
    default: {
      o.p = ps_raw(f, u0, v);
      let e = 0.004;
      let du = ps_raw(f, u0 + e, v) - ps_raw(f, u0 - e, v);
      let dv = ps_raw(f, u0, v + e) - ps_raw(f, u0, v - e);
      var n = cross(du, dv);
      let nl = length(n);
      n = select(normalize(o.p + vec3f(1e-4)), n / max(nl, 1e-9), nl > 1e-9);
      // Keep normals pointing outward-ish so displacement inflates rather than folds.
      o.n = select(n, -n, dot(n, o.p) < 0.0);
    }
  }
  return o;
}

// Latent surface coordinate for a point under the current distribution style.
fn ps_uv(idx: u32) -> vec3f {
  var h = hashU3(idx * 2654435761u + 7u);
  let dens = floor(S.p[7].x);
  if (dens == 1.0) {
    let nc = 18.0 + floor(fract(S.p[7].x) * 30.0);
    h.y = (floor(h.y * nc) + 0.5) / nc;
  } else if (dens == 2.0) {
    let nc = 16.0 + floor(fract(S.p[7].x) * 16.0);
    if ((idx & 1u) == 0u) { h.y = (floor(h.y * nc) + 0.5) / nc; } else { h.x = (floor(h.x * nc * 1.5) + 0.5) / (nc * 1.5); }
  }
  return h;
}

fn ps_target(idx: u32, f: i32, uvw: vec3f) -> PsF {
  var o = ps_form(f, uvw.x, uvw.y, uvw.z);
  // Spectrum pushes the skin out along its normal; the band runs along v.
  let band = 0.03 + 0.8 * uvw.y;
  let lvl = spec(band);
  o.p += o.n * (lvl * lvl * 0.45 + (uvw.z - 0.5) * 0.02) * S.p[7].w * 2.0;
  return o;
}

fn simulate(idx: u32, p: ptr<function, Particle>) {
  let dens = floor(S.p[7].x);
  if (dens == 3.0 && (idx & 7u) != 0u) { (*p).pos.w = 0.0; return; }
  let dt = min(F.dt, 1.0 / 30.0);
  let uvw = ps_uv(idx);
  let fa = i32(S.p[6].x);
  let fb = i32(S.p[6].y);
  let age = S.p[6].z;
  let style = floor(S.p[6].w);
  let hk = hashU(idx * 97u + 13u);
  // When does this point switch to the new form?
  var delay = 0.0;
  if (style == 1.0) {
    let tb = ps_form(fb, uvw.x, uvw.y, uvw.z).p;
    delay = (tb.y + 1.6) * 0.45 + hk * 0.1;
  } else {
    delay = hk * 0.12;
  }
  let switched = age > delay;
  let tf = select(fa, fb, switched);
  var tg = ps_target(idx, tf, uvw);
  // Global motion: slow rotation, chord twist, kick breath, anticipation gather.
  let rot = rotY(S.p[7].z + 0.6 * (F.morph2.x - 0.5)) * rotX(0.35 * sin(S.p[7].z * 0.37 + fract(S.p[6].w) * 6.0) + 0.3 * (F.morph2.y - 0.5));
  let twist = 0.5 * F.tension + 1.2 * F.anticipation;
  var tp = rotY(tg.p.y * twist) * tg.p;
  tp = rot * tp * (1.0 + 0.07 * F.kick + 0.05 * F.kickNext - 0.3 * F.anticipation);
  let tn = rot * tg.n;

  var pos = (*p).pos.xyz;
  var vel = (*p).vel.xyz;
  if ((*p).pos.w <= 0.0) {
    pos = tp + (hashU3(idx * 3u + 5u) - 0.5) * 0.4;
    vel = vec3f(0.0);
  }
  let since = age - delay;
  let fresh = select(0.0, exp(-max(since, 0.0) * 2.5), switched && since < 3.0);
  var k = 26.0 * (0.75 + 0.5 * hk);
  var c = 3.2;
  var acc = vec3f(0.0);
  if (style == 2.0) {
    // Explode and reform: a radial blast and loose springs right after the switch.
    acc += normalize(pos + vec3f(1e-4)) * 30.0 * fresh * fresh;
    k *= 1.0 - 0.8 * fresh;
    acc += curl3(pos * 1.5 + vec3f(F.time * 0.3)) * 18.0 * fresh;
  } else if (style == 3.0) {
    acc += vec3f(-pos.z, 0.0, pos.x) * 22.0 * fresh;
  } else if (style == 4.0) {
    acc += curl3(pos * 1.2 + vec3f(0.0, F.time * 0.2, 0.0)) * 26.0 * fresh;
    k *= 1.0 - 0.6 * fresh;
  } else {
    c = 2.2;
  }
  acc += (tp - pos) * k - vel * c;
  // Drop: everything bursts outward, then springs home.
  acc += normalize(pos + vec3f(1e-4)) * 40.0 * F.dropPulse * F.dropPulse * (0.5 + hk);
  acc += curl3(pos * 2.0 + vec3f(F.warp * 0.1)) * (0.6 + 2.0 * F.snare) * S.p[7].w;
  vel += acc * dt;
  pos += vel * dt;
  // Facing ratio for rim lighting, packed with the flow coordinate.
  let eye = S.p[4].xyz;
  let face = abs(dot(tn, normalize(eye - pos)));
  (*p).pos = vec4f(pos, 1.0);
  (*p).vel = vec4f(vel, floor(uvw.x * 4096.0) + min(face, 0.999));
}

fn shade(p: Particle, idx: u32) -> Shade {
  let dens = floor(S.p[7].x);
  let model = i32(floor(S.p[7].y));
  let hue0 = fract(S.p[6].w);
  let u = floor(p.vel.w) / 4096.0;
  let face = fract(p.vel.w);
  let uvw = ps_uv(idx);
  let band = 0.03 + 0.8 * uvw.y;
  let lvl = spec(band);
  let sp = length(p.vel.xyz);
  let eye = S.p[4].xyz;
  let dist = distance(p.pos.xyz, eye);
  var hue = hue0;
  var b = 1.0;
  switch model {
    case 0: { hue += u * 0.7; }
    case 1: { hue += uvw.y * 0.35; b = 0.25 + 2.2 * pow(1.0 - face, 3.0); }
    case 2: { hue += band * 0.8; b = 0.45 + 2.0 * lvl * lvl; }
    case 3: { hue += 0.15 * dist; b = 2.2 * exp(-max(dist - 2.5, 0.0) * 0.6); }
    default: { hue += 0.08 * sp; b = 0.4 + 0.5 * sp; }
  }
  var col = palL(hue + 0.15 * F.morph2.z, 1.0);
  col = mix(col, palL(hue + 0.5, 1.4), 0.3 * sat(sp * 0.2));
  b *= 0.7 + 0.5 * F.intensity + 0.3 * F.chordPulse + 0.8 * F.dropPulse;
  b *= 1.0 - 0.4 * F.anticipation;
  b *= 1.0 + 0.6 * F.kick * lvl;
  // Hats: a sprinkle of bright beads.
  let bead = step(1.0 - 0.0006 * F.hat, hashU(idx ^ pcg(u32(F.time * 15.0))));
  var size = 0.0032 + 0.0035 * fract(S.p[7].x);
  var e = 0.055;
  if (dens == 1.0 || dens == 2.0) { e = 0.07; }
  if (dens == 3.0) { size = 0.009 + 0.008 * fract(S.p[7].x); e = 0.12; }
  let near = smoothstep(0.08, 0.6, dist);
  var s: Shade;
  s.color = col * b * e * (1.0 + 6.0 * bead) * near;
  s.size = size * (1.0 + 1.5 * bead);
  return s;
}

fn background(uv: vec2f, rd: vec3f) -> vec3f {
  let eye = S.p[4].xyz;
  let toC = normalize(-eye);
  let ca = max(1.0 - dot(rd, toC), 0.0);
  let n = fbm3(rd * 2.0 + vec3f(F.warp * 0.02, 0.0, 0.0), 3);
  var c = palRampL(0.1, 0.004 + 0.004 * sat(rd.y + 0.5)) + palL(fract(S.p[6].w) + 0.3 + n * 0.3, 0.006) * sat(n + 0.5);
  c += palL(fract(S.p[6].w) + 0.1, 1.0) * exp(-ca * 18.0) * (0.012 + 0.03 * F.bass + 0.06 * F.dropPulse);
  // A faint floor of light far below for scale.
  let fl = smoothstep(-0.15, -0.6, rd.y);
  c += palRampL(0.3, 0.006) * fl * (0.5 + 0.5 * sin(rd.x / max(-rd.y, 0.1) * 12.0) * sin(rd.z / max(-rd.y, 0.1) * 12.0));
  return c;
}
`,
});
