import { raymarchScene } from '../raymarchScene';

/**
 * Impossible surfaces: a Möbius band, a figure-8 Klein bottle (a lemniscate cross-section
 * carried round a loop with a half twist), gyro-twisted star tori, and the algebraic
 * Roman (Steiner), Kummer, Clebsch and tangle surfaces drawn as thin double-sided shells.
 * Each cue picks a sequence of three forms that melt into one another on section changes,
 * rendered as layered glass, polished metal, a holographic wireframe or pearlescent
 * satin. The spectrum ripples across the surface, kicks breathe or twist it, chords shift
 * the twist phase, builds tighten and spin it, and drops burst it outward.
 */

const fract = (x: number) => x - Math.floor(x);
const FORMS = 7;

const st = {
  cur: -1, prev: -1, blend: 1, lastSection: -99,
  yaw: 0, pitch: 0, twist: 0, twistT: 0,
  lastChord: -99, lastDrop: 0, lastTime: -1,
};

function formFor(section: number, g0: number): number {
  const start = Math.floor(g0 * FORMS);
  const seq = [start, (start + 3) % FORMS, (start + 5) % FORMS];
  return seq[((section % 3) + 3) % 3];
}

export default raymarchScene({
  // Dropped from auto-direction: a surface floating in a studio void, the "random 3D object"
  // the show is moving away from. An unreachable energy range and mood with no genre
  // affinity keep scoreScene() at the bottom of every ranking. Still available when pinned by hand.
  meta: {
    id: 'klein-morph',
    name: 'Impossible Surfaces',
    energy: [2, 2],
    // Dropped from auto-direction (see docs/QUALITY.md); still available when pinned.
    auto: false,
    mood: { valence: -1, arousal: -1 },
    genres: {},
    trails: 0.2,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    const ev = ctx.evolve;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const sec = Math.max(m.sectionIndex, 0);
    const jumped = Math.abs(m.time - st.lastTime) > 0.5;
    st.lastTime = m.time;
    const target = formFor(sec, g[0]);
    if (jumped || st.cur < 0) {
      st.cur = st.prev = target;
      st.blend = 1;
      st.lastSection = sec;
      st.twist = st.twistT = 0;
    } else if (sec !== st.lastSection) {
      st.lastSection = sec;
      if (target !== st.cur) {
        st.prev = st.cur;
        st.cur = target;
        st.blend = 0;
      }
    }
    st.blend = Math.min(1, st.blend + dt / 3.2);
    const ant = m.anticipation;
    const drop = m.dropPulse;
    const grammar = Math.floor(g[7] * 3);
    if (m.chordIndex !== st.lastChord) {
      st.lastChord = m.chordIndex;
      st.twistT += 0.6 + 0.4 * fract(m.chordIndex * 0.37);
    }
    if (m.dropPulse > 0.9 && st.lastDrop <= 0.9) st.twistT += Math.PI;
    st.lastDrop = m.dropPulse;
    st.twist += (st.twistT - st.twist) * (1 - Math.exp(-dt * 2.5));
    const tumble = [0.05, 0.12, 0.22][Math.floor(g[3] * 3)];
    st.yaw += dt * (tumble + 0.1 * m.energySlow + 0.9 * ant * ant + 0.6 * drop);
    st.pitch += dt * (0.5 * tumble + 0.25 * ant);

    p[0] = st.prev; p[1] = st.cur; p[2] = st.blend * st.blend * (3 - 2 * st.blend);
    p[3] = Math.floor(g[1] * 4); // material
    const k = [1, 3, 1, 5][Math.floor(g[2] * 4)];
    const n = 3 + Math.floor(fract(g[2] * 3.7) * 4);
    p[4] = k; // Möbius half twists
    p[5] = n; // star points
    p[6] = (1 + Math.floor(fract(g[2] * 5.3) * 2)) / n; // star twist rate
    p[7] = 1.15 + 1.2 * ev[0]; // Kummer mu^2
    p[8] = st.yaw; p[9] = Math.sin(st.pitch) * 0.7 + g[3] * 3; p[10] = st.twist + ctx.spin * 0.15;
    const kickAmt = grammar === 0 ? 0.07 : 0.025;
    p[11] = (1 - 0.18 * ant + 0.1 * drop) * (1 + kickAmt * m.kick + 0.03 * m.kickNext);

    // Camera.
    const rig = Math.floor(g[3] * 3);
    const az = ctx.spin * 0.07 + g[3] * 11;
    const dist = [2.9, 2.0, 3.3][rig] + (fract(g[5] * 2.3) < 0.4 && target < 3 ? 0.8 : 0) - 0.5 * ant + 0.4 * drop;
    const el = [0.35, 0.15, 0.85][rig] + 0.2 * Math.sin(ctx.spin * 0.05);
    p[12] = Math.cos(az) * Math.cos(el) * dist;
    p[13] = Math.sin(el) * dist;
    p[14] = Math.sin(az) * Math.cos(el) * dist;
    p[15] = [1.9, 1.6, 2.6][rig];
    const tx = rig === 1 ? 0.45 * Math.sin(ctx.spin * 0.05) : 0;
    p[16] = tx; p[17] = rig === 1 ? 0.25 * Math.cos(ctx.spin * 0.04) : 0; p[18] = 0;
    p[19] = rig === 2 ? 0.25 * Math.sin(ctx.spin * 0.03) : 0.05 * Math.sin(ctx.spin * 0.04);

    // Lighting, copies, ripple style, palette.
    p[20] = Math.floor(g[4] * 3);
    p[21] = fract(g[5] * 2.3) < 0.4 ? 2 : 1;
    p[22] = Math.floor(fract(g[5] * 5.1) * 3);
    p[23] = fract(g[6] + 0.15 * ev[1]);
    // Ripple amplitude, wireframe density, glow, flash.
    p[24] = (0.012 + 0.03 * m.mid + 0.02 * m.high + 0.04 * m.snare * (grammar === 2 ? 1 : 0.3)) * (1 + 1.5 * drop);
    p[25] = 6 + Math.floor(fract(g[6] * 3.9) * 3) * 4;
    p[26] = (0.6 + 0.7 * ctx.intensity + 0.6 * m.beatPulse + 0.8 * m.kick * (grammar === 1 ? 1 : 0.4)) * (1 - 0.3 * ant) + 1.5 * drop;
    p[27] = drop * drop;
    p[28] = ant;
    p[29] = grammar;
    p[30] = 0.012 + 0.006 * fract(g[7] * 4.1);
    p[31] = ev[2];
  },
  wgsl: /* wgsl */ `
var<private> km_rot: mat3x3f;

fn km_box2(q: vec2f, b: vec2f) -> f32 {
  let d = abs(q) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

// Loop coordinates: (cross-section q rotated by the twist, loop angle).
fn km_loop(p: vec3f, R: f32, rate: f32) -> vec3f {
  let th = atan2(p.z, p.x);
  let q = rot2(th * rate + S.p[2].z) * vec2f(length(p.xz) - R, p.y);
  return vec3f(q, th);
}

fn km_implicit(fv: f32, gv: vec3f, s: f32) -> f32 {
  return abs(fv) / max(length(gv), 1e-4) / s;
}

fn km_form(p: vec3f, f: f32) -> f32 {
  let th = S.p[7].z;
  if (f < 0.5) {
    // Möbius band with k half twists.
    let q = km_loop(p, 1.0, S.p[1].x * 0.5);
    return km_box2(q.xy, vec2f(0.4, th)) * 0.8;
  }
  if (f < 1.5) {
    // Figure-8 Klein bottle: two tangent rings swap places over a half twist.
    let q = km_loop(p, 0.95, 0.5);
    let a = 0.27;
    let d = min(abs(length(q.xy - vec2f(0.0, a)) - a), abs(length(q.xy + vec2f(0.0, a)) - a));
    return (d - th) * 0.85;
  }
  if (f < 2.5) {
    // Gyro-twisted star torus.
    let n = S.p[1].y;
    let q = km_loop(p, 0.95, S.p[1].z * n * 0.5);
    let al = atan2(q.y, q.x);
    let rr = 0.3 * (1.0 + 0.32 * cos(n * al));
    return (length(q.xy) - rr) * 0.55;
  }
  if (f < 3.5) {
    // Roman (Steiner) surface: x^2y^2 + y^2z^2 + z^2x^2 - xyz = 0.
    let s = 0.45;
    let x = p * s;
    let x2 = x * x;
    let fv = x2.x * x2.y + x2.y * x2.z + x2.z * x2.x - x.x * x.y * x.z;
    let gv = vec3f(2.0 * x.x * (x2.y + x2.z) - x.y * x.z, 2.0 * x.y * (x2.x + x2.z) - x.x * x.z, 2.0 * x.z * (x2.x + x2.y) - x.x * x.y);
    return max(km_implicit(fv, gv, s) * 0.7 - th, length(p) - 1.1);
  }
  if (f < 4.5) {
    // Kummer quartic with 16 nodes.
    let s = 1.55;
    let x = p * s;
    let mu2 = S.p[1].w;
    let lam = (3.0 * mu2 - 1.0) / (3.0 - mu2);
    let r2 = 1.41421356;
    let a = 1.0 - x.z - r2 * x.x;
    let b = 1.0 - x.z + r2 * x.x;
    let c = 1.0 + x.z + r2 * x.y;
    let d = 1.0 + x.z - r2 * x.y;
    let qq = dot(x, x) - mu2;
    let fv = qq * qq - lam * a * b * c * d;
    let ga = vec3f(-r2, 0.0, -1.0);
    let gb = vec3f(r2, 0.0, -1.0);
    let gc = vec3f(0.0, r2, 1.0);
    let gd = vec3f(0.0, -r2, 1.0);
    let gv = 4.0 * qq * x - lam * (ga * b * c * d + gb * a * c * d + gc * a * b * d + gd * a * b * c);
    return max(km_implicit(fv, gv, s) * 0.6 - th, length(p) - 1.3);
  }
  if (f < 5.5) {
    // Clebsch diagonal cubic.
    let s = 0.8;
    let x = p * s;
    let x2 = x * x;
    let fv = 81.0 * (x2.x * x.x + x2.y * x.y + x2.z * x.z)
      - 189.0 * (x2.x * x.y + x2.x * x.z + x2.y * x.x + x2.y * x.z + x2.z * x.x + x2.z * x.y)
      + 54.0 * x.x * x.y * x.z + 126.0 * (x.x * x.y + x.x * x.z + x.y * x.z)
      - 9.0 * dot(x, x) - 9.0 * (x.x + x.y + x.z) + 1.0;
    let gx = 243.0 * x2.x - 189.0 * (2.0 * x.x * x.y + 2.0 * x.x * x.z + x2.y + x2.z) + 54.0 * x.y * x.z + 126.0 * (x.y + x.z) - 18.0 * x.x - 9.0;
    let gy = 243.0 * x2.y - 189.0 * (2.0 * x.y * x.x + 2.0 * x.y * x.z + x2.x + x2.z) + 54.0 * x.x * x.z + 126.0 * (x.x + x.z) - 18.0 * x.y - 9.0;
    let gz = 243.0 * x2.z - 189.0 * (2.0 * x.z * x.x + 2.0 * x.z * x.y + x2.x + x2.y) + 54.0 * x.x * x.y + 126.0 * (x.x + x.y) - 18.0 * x.z - 9.0;
    return max(km_implicit(fv, vec3f(gx, gy, gz), s) * 0.6 - th, length(p) - 1.25);
  }
  // Tangle cube.
  let s = 1.9;
  let x = p * s;
  let x2 = x * x;
  let fv = dot(x2, x2) - 5.0 * dot(x, x) + 11.8;
  let gv = 4.0 * x2 * x - 10.0 * x;
  return km_implicit(fv, gv, s) * 0.7 - th * 0.6;
}

fn km_shape(p: vec3f, f: f32) -> f32 {
  var d = km_form(p, f);
  if (S.p[5].y > 1.5 && f < 2.5) {
    // A second, linked copy threaded through the first.
    let q = rotX(1.5708) * (p - vec3f(0.95, 0.0, 0.0));
    d = min(d, km_form(q, f));
  }
  return d;
}

fn km_ripple(p: vec3f) -> f32 {
  let style = S.p[5].z;
  var x: f32;
  var ph: f32;
  if (style < 0.5) {
    x = sat(p.y * 0.35 + 0.5);
    ph = length(p) * 9.0;
  } else if (style < 1.5) {
    x = sat(length(p.xz) * 0.5);
    ph = p.y * 11.0 + atan2(p.z, p.x) * 3.0;
  } else {
    x = 0.5 + 0.5 * sin(atan2(p.z, p.x) * 2.0);
    ph = dot(p, vec3f(5.0, 7.0, -6.0));
  }
  let lv = spec(x * 0.8 + 0.04);
  return S.p[6].x * (0.4 + 2.5 * lv * lv) * sin(ph - F.warp * 3.0);
}

fn km_map(pw: vec3f) -> f32 {
  let p0 = km_rot * pw / S.p[2].w;
  let p = p0 * (1.0 - km_ripple(p0));
  var d = km_shape(p, S.p[0].y);
  let b = S.p[0].z;
  if (b < 0.999) { d = mix(km_shape(p, S.p[0].x), d, b); }
  return d * S.p[2].w * 0.92;
}

fn km_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * km_map(p + k.xyy * e) + k.yyx * km_map(p + k.yyx * e) +
                   k.yxy * km_map(p + k.yxy * e) + k.xxx * km_map(p + k.xxx * e));
}

fn km_env(rd: vec3f, soft: f32) -> vec3f {
  let lm = S.p[5].x;
  let hue = S.p[5].w;
  var c = mix(F.pal0.rgb * 0.04, palL(hue + 0.1, 0.05), sat(rd.y * 0.5 + 0.5));
  let w = 1.0 + soft * 6.0;
  if (lm < 0.5) {
    // Overhead softbox and a horizon band.
    c += palL(hue + 0.3, 1.6) * smoothstep(0.75 - 0.1 * soft, 0.85, rd.y);
    c += palL(hue + 0.55, 0.25) * exp(-abs(rd.y) * 14.0 / w);
  } else if (lm < 1.5) {
    // Twin vertical rim strips.
    let az = atan2(rd.z, rd.x);
    let s1 = exp(-pow(abs(fmod(az + 0.6, TAU) - PI) * 9.0 / w, 2.0));
    let s2 = exp(-pow(abs(fmod(az - 1.9, TAU) - PI) * 9.0 / w, 2.0));
    let vy = smoothstep(-0.6, -0.3, rd.y) * smoothstep(0.9, 0.6, rd.y);
    c += (palL(hue + 0.25, 1.8) * s1 + palL(hue + 0.6, 1.4) * s2) * vy;
  } else {
    // Two coloured side panels.
    c += palL(hue + 0.2, 0.9) * smoothstep(0.55 - 0.2 * soft, 0.8, rd.x);
    c += palL(hue + 0.7, 0.7) * smoothstep(0.55 - 0.2 * soft, 0.8, -rd.x) * smoothstep(-0.5, 0.2, rd.y);
  }
  return c;
}

fn km_keyLight() -> vec3f {
  let lm = S.p[5].x;
  if (lm < 0.5) { return normalize(vec3f(0.2, 1.0, 0.3)); }
  if (lm < 1.5) { return normalize(vec3f(-0.6, 0.3, -0.8)); }
  return normalize(vec3f(1.0, 0.25, 0.2));
}

// Line coordinates on the surface for the wireframe and spectrum painting.
fn km_lines(pw: vec3f) -> f32 {
  let p = km_rot * pw / S.p[2].w;
  let dens = S.p[6].y;
  let f = S.p[0].y;
  var u: vec2f;
  if (f < 2.5) {
    let q = km_loop(p, 1.0, 0.0);
    u = vec2f(q.z / TAU * dens * 4.0, atan2(q.y, q.x) / TAU * dens * 0.5 + length(q.xy) * dens);
  } else {
    u = vec2f(p.y * dens * 0.6, length(p.xz) * dens * 0.6);
  }
  let g = abs(fract(u - vec2f(0.0, F.warp * 0.1)) - 0.5);
  return min(g.x, g.y);
}

fn km_film(c: f32, thick: f32) -> vec3f {
  let ph = thick * (2.0 - 1.2 * c);
  return 0.5 + 0.5 * cos(TAU * (ph * vec3f(1.0, 1.2, 1.4) + vec3f(0.0, 0.25, 0.5)));
}

fn km_bound(ro: vec3f, rd: vec3f, r: f32) -> vec2f {
  let b = dot(ro, rd);
  let c = dot(ro, ro) - r * r;
  let h = b * b - c;
  if (h < 0.0) { return vec2f(-1.0); }
  let s = sqrt(h);
  return vec2f(max(-b - s, 0.0), -b + s);
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  km_rot = rotX(S.p[2].y) * rotY(S.p[2].x);
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let ro = S.p[3].xyz;
  let cam = lookAt(ro, S.p[4].xyz, S.p[4].w);
  let rd = normalize(cam * vec3f(q, S.p[3].w));
  let mat = S.p[0].w;
  let hue = S.p[5].w + 0.06 * F.morph2.x + 0.05 * F.tension;
  let glow = S.p[6].z;
  let L = km_keyLight();

  // Backdrop: dim studio plus a soft halo behind the object.
  var bg = km_env(rd, 1.0) * 0.13;
  let halo = exp(-length(q) * 1.6);
  bg += palL(hue + 0.45, 0.035 + 0.03 * F.energySlow) * halo;
  bg *= 1.0 - 0.4 * S.p[7].x;

  let bs = km_bound(ro, rd, select(1.45, 2.2, S.p[5].y > 1.5) * S.p[2].w * 1.1);
  if (bs.y < 0.0) { return vec4f(bg, 1.0); }

  var col = vec3f(0.0);
  var T = 1.0;
  var t = bs.x + ign(frag) * 0.02;
  let layered = mat < 0.5 || (mat > 1.5 && mat < 2.5);
  let maxLayers = select(1, 4, layered);
  var layer = 0;
  for (var i = 0; i < 110; i++) {
    if (t > bs.y || layer >= maxLayers || T < 0.03) { break; }
    let p = ro + rd * t;
    let raw = km_map(p);
    let h = select(raw, abs(raw), layered);
    if (h < 0.001 * t) {
      var n = km_normal(p, 0.0015 * t);
      if (dot(n, rd) > 0.0) { n = -n; }
      let c = sat(dot(n, -rd));
      let r = reflect(rd, n);
      let fre = 0.04 + 0.96 * pow(1.0 - c, 5.0);
      let ln = km_lines(p);
      let lv = spec(fract(ln * 3.0 + 0.2) * 0.8);
      if (mat < 0.5) {
        // Thin glass sheets with a faint interference film.
        let film = mix(vec3f(1.0), km_film(c, 1.2 + S.p[7].w), 0.35);
        let tint = palL(hue + f32(layer) * 0.08, 0.6);
        col += T * (km_env(r, 0.0) * fre * film * 1.4 + tint * 0.025 * glow + palL(hue + 0.5, 1.0) * pow(1.0 - c, 3.0) * 0.06 * glow);
        T *= (1.0 - fre) * 0.82;
      } else if (mat < 1.5) {
        // Polished metal.
        let ao = sat(km_map(p + n * 0.08) / 0.08 * 0.6 + 0.4);
        let tint = palL(hue + 0.1 * dot(n, vec3f(0.0, 1.0, 0.0)), 0.75);
        col += T * (km_env(r, 0.05) * mix(tint, vec3f(1.0), fre) * 1.3 + vec3f(1.0) * pow(sat(dot(r, L)), 60.0) * 2.0) * ao;
        T = 0.0;
      } else if (mat < 2.5) {
        // Holographic wireframe: contour lines glow, the sheet itself barely shows.
        let px = 0.0015 * t * S.p[6].y * 2.0;
        let wl = smoothstep(0.022 + px, 0.0, ln);
        let ec = palL(hue + 0.33 * f32(layer) + 0.1 * lv, 1.0);
        col += T * (ec * wl * glow * (0.35 + 1.1 * lv) + ec * 0.02 * glow + km_env(r, 0.2) * fre * 0.3);
        T *= 0.8;
      } else {
        // Pearlescent satin.
        let ao = sat(km_map(p + n * 0.1) / 0.1 * 0.6 + 0.4);
        let dif = sat(dot(n, L)) * 0.8 + 0.2 * sat(0.5 + 0.5 * n.y);
        let base = palL(hue + 0.05 * n.y, 0.22);
        let pearl = km_film(c, 0.8 + 0.6 * S.p[7].w) * palL(hue + 0.4, 0.6);
        col += T * (base * dif * ao + pearl * pow(1.0 - c, 2.0) * 0.5 * ao + km_env(r, 0.4) * fre * 0.6 + vec3f(1.0) * pow(sat(dot(r, L)), 24.0) * 0.4);
        col += T * palL(hue + 0.3, 1.0) * smoothstep(0.02, 0.0, ln) * lv * glow * 0.6;
        T = 0.0;
      }
      layer++;
      t += 0.03;
      continue;
    }
    t += h * 0.85;
  }
  col += T * bg;
  // Drop flash, anticipation drains.
  col = mix(col, vec3f(luma(col)), 0.4 * S.p[7].x);
  col += F.pal3.rgb * S.p[6].w * 0.3 * (0.1 + luma(col));
  return vec4f(col, 1.0);
}
`,
});
