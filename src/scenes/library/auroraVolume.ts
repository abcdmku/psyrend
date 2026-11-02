import { Morph, wave } from '../morph';
import { raymarchScene } from '../raymarchScene';

/**
 * Aurora Veil: you fly through a field of luminous curtains, a veil hanging above you and a second
 * one rising below, with a dark open passage between them. Each curtain is a thin folded sheet of
 * light with a sharp hem and fine vertical rays fading upward. It is drawn as many stacked layers of
 * a 2D curtain footprint, so the sheets stay crisp at any distance.
 *
 * The morph moves the curtain geometry the whole time: the spacing, how deep and how often the
 * folds bend, how far they twist with height, the hem height, the curtain height and the ray grain.
 * Each kick and snare steps that shape on for good. The camera glides at one steady pace and slowly
 * turns its heading.
 * Beats leave the veil changed, and the change travels:
 *  - kick: a broad glow runs out from the camera through the curtains, and behind it they have
 *    stepped round the hue wheel;
 *  - snare: a sharp bright front in a second colour sweeps across from one side, and behind it the
 *    rays are a new pattern;
 *  - melody: each note's colour runs along the curtains from the camera at a height set by its
 *    pitch, replacing the previous note's band.
 */

const morph = new Morph(1);
const KICK_HUE = 0.08;
const lead = { n: -1, cur: 0, prev: 0 };
const cam = { x: 0, z: 0, travel: -1, seed: -1 };

export default raymarchScene({
  meta: {
    id: 'aurora-volume',
    name: 'Aurora Veil',
    // Out of the show: Streaky motion blur without readable structure.
    auto: false,
    energy: [0, 0.6],
    mood: { valence: 0.55, arousal: 0.25 },
    genres: { ambient: 1, classical: 0.9, acoustic: 0.6, jazz: 0.5, lofi: 0.5 },
    trails: 0,
    kaleido: false,
  },
  params(ctx, p) {
    const m = ctx.music;
    const g = ctx.dna;
    morph.update(m, ctx.dt, g);
    const a = morph.at;
    if (morph.notes !== lead.n) {
      lead.prev = morph.notes > lead.n && lead.n >= 0 ? lead.cur : morph.notePitch;
      lead.cur = morph.notePitch;
      lead.n = morph.notes;
    }
    // Glide along a heading that slowly turns with the morph.
    // The curtains run along x: cross them at a slant so they stream past as folds, never as a corridor.
    const head = (g[1] < 0.5 ? 0 : Math.PI) + 0.5 * Math.sin(a[6] * 0.5) + 0.2 * Math.sin(a[7] * 0.8);
    const dTr = morph.travel - cam.travel;
    if (g[0] !== cam.seed || dTr < 0 || dTr > 1) {
      cam.x = 0;
      cam.z = 0;
      cam.seed = g[0];
    } else {
      cam.x += Math.sin(head) * dTr * 6;
      cam.z += Math.cos(head) * dTr * 6;
    }
    cam.travel = morph.travel;
    const yb = wave(a[3], 1.4, 2.4);
    p[0] = cam.x;
    p[1] = cam.z;
    p[2] = head;
    // Gaze up into the veil overhead.
    p[3] = 0.48 + 0.14 * Math.sin(a[7] * 0.6 + g[2] * 6);
    // Curtain geometry.
    p[4] = yb;
    p[5] = yb + wave(a[4], 6, 13);
    p[6] = wave(a[0], 2.4, 4.8);
    p[7] = wave(a[1], 0.6, 3.2);
    p[8] = wave(a[2], 0.07, 0.3);
    p[9] = wave(a[5], 0, 1);
    p[10] = wave(a[6], -0.09, 0.09);
    p[11] = g[3] * 40;
    // Shimmer phase, hue (one step per kick: the kick front carries it), colour model, field of view.
    p[12] = morph.travel * 1.6;
    p[13] = g[4] + 0.12 * Math.sin(a[7]) + morph.kicks * KICK_HUE;
    p[14] = Math.floor(g[5] * 3);
    p[15] = 1.05;
    // Beats: ages, snare count and direction, melody pitches.
    p[16] = Math.min(morph.kickAge, 9);
    p[17] = Math.min(morph.snareAge, 9);
    p[18] = morph.snares % 64;
    p[19] = morph.snares % 2 === 0 ? 1 : -1;
    p[20] = Math.min(morph.leadAge, 9);
    p[21] = lead.cur;
    p[22] = lead.prev;
    p[23] = KICK_HUE;
    p[24] = 0.85 + 0.35 * ctx.intensity;
    p[25] = morph.flow;
  },
  wgsl: /* wgsl */ `
fn av_hueNow() -> f32 { return S.p[3].y + F.morph2.x * 0.15; }

// Curtain field in xz at height h: (u / spacing, where curtains sit at half-integers; along; slope).
fn av_foot(xz: vec2f, h: f32, side: f32) -> vec3f {
  let q = rot2(S.p[2].z * h) * xz;
  let ph = S.p[3].x;
  let seed = S.p[2].w + side * 17.0;
  let amp = S.p[1].w;
  let fq = S.p[2].x;
  let per = S.p[1].z;
  let a1 = q.x * fq + ph * 0.05 + seed;
  let a2 = q.x * fq * 2.3 - ph * 0.04 + seed * 1.7;
  let bend = amp * (sin(a1) + 0.3 * sin(a2)) + amp * 0.7 * fbmFast(vec3f(q.x * 0.025, q.y * 0.018 + seed, ph * 0.015), 2);
  let slope = amp * fq * (cos(a1) + 0.69 * cos(a2));
  return vec3f((q.y + bend) / per, q.x, slope);
}

fn av_col(k: f32, lum: f32) -> vec3f { return palL(k, lum); }

/** One veil (side = 1 above, -1 below): crisp sheets found where the ray crosses each curtain. */
fn av_veil(ro: vec3f, rd: vec3f, side: f32, pix: f32, jit: f32) -> vec3f {
  let ry = rd.y * side;
  if (ry < 0.003) { return vec3f(0.0); }
  let yb = S.p[1].x;
  let yt = S.p[1].y;
  let ph = S.p[3].x;
  let tex = S.p[2].y;
  let per = S.p[1].z;
  let cm = i32(S.p[3].z + 0.5);
  let hor = max(length(rd.xz), 0.05);
  let right = vec2f(cos(S.p[0].z), -sin(S.p[0].z));
  let kAge = S.p[4].x;
  let sAge = S.p[4].y;
  let sK = S.p[4].z;
  let sDir = S.p[4].w;
  let lAge = S.p[5].x;
  let hueNew = av_hueNow();
  // The curtains are thin vertical sheets: walk the ray's ground track and light each crossing.
  let t0 = max((yb - 0.7) / ry, 0.0);
  let t1 = min((yt + 0.5) / ry, 95.0);
  if (t1 <= t0) { return vec3f(0.0); }
  let dt = max(per * 0.32 / (1.0 + S.p[1].w * S.p[2].x * 1.7) / hor, (t1 - t0) / 120.0);
  var t = t0 + dt * jit;
  var fp = av_foot(ro.xz + rd.xz * t, ro.y * side + ry * t, side);
  var prev = fp.x;
  var acc = vec3f(0.0);
  for (var i = 0; i < 120; i++) {
    t += dt;
    if (t > t1) { break; }
    let hh = ro.y * side + ry * t;
    let ft = av_foot(ro.xz + rd.xz * t, hh, side);
    let cur = ft.x;
    let kc = floor(cur - 0.5);
    let kp = floor(prev - 0.5);
    if (kc != kp) {
      let line = max(kc, kp) + 0.5;
      let fr = sat((line - prev) / (cur - prev));
      let tc = t - dt + fr * dt;
      let cell = line - 0.5;
      let pos = ro + rd * tc;
      let h = hh - ry * dt * (1.0 - fr);
      // Path length through the sheet: edge-on sheets glow brighter.
      let cosN = abs(cur - prev) * per / dt / sqrt(1.0 + ft.z * ft.z);
      let thick = min(1.0 / max(cosN, 0.2), 3.5);
      let hc = hash11(cell * 7.31 + S.p[2].w + side * 3.0);
      let along = (rot2(S.p[2].z * h) * pos.xz).x;
      let presence = smoothstep(0.15, 0.3, hc) * smoothstep(-0.2, 0.4, noise3fast(vec3f(along * 0.035 + cell * 3.1, ph * 0.02, 11.0 + side * 5.0)));
      if (presence > 0.0) {
        // Hem: a sharp rippling lower edge, light fading upward.
        let he = yb + 0.5 * hash11(cell * 3.17 + 0.5) + 0.7 * noise3fast(vec3f(along * 0.06, ph * 0.03, cell));
        let up = h - he;
        let soft = 0.08 + pix * tc * 1.5;
        let lower = smoothstep(-soft, soft + 0.15, up);
        let H = (yt - yb) * (0.25 + 0.35 * hash11(cell * 5.1 + 2.0));
        let prof = lower * exp(-max(up, 0.0) / H) * smoothstep(yt + 0.5, yt - 1.5, h);
        // Rays: fine streaks along the curtain; the snare front leaves a new pattern behind it.
        let sl = dot(pos.xz - ro.xz, right) * sDir;
        let sx = -50.0 + sAge * 80.0;
        let seedR = select(sK - 1.0, sK, sl < sx);
        let rf = mix(0.5, 2.6, tex);
        let aa = sat(1.2 - rf * pix * tc * 1.2);
        let s1 = noise3fast(vec3f(along * rf + cell * 7.0, ph * 0.04, seedR * 13.7));
        let s2 = noise3fast(vec3f(along * rf * 2.7 + 3.0, ph * 0.06, seedR * 13.7 + 5.0));
        let rays = mix(0.75, 0.2 + 1.7 * pow(sat(0.5 + 0.8 * s1 + 0.35 * s2), 2.5), aa * smoothstep(70.0, 20.0, tc));
        // Kick: the hue steps behind a broad front running out from the camera.
        let rK = length(pos.xz - ro.xz);
        let kd = rK - kAge * 38.0;
        let hue = hueNew - S.p[5].w * smoothstep(-2.0, 2.0, kd);
        let hr = sat(up / (yt - yb));
        var lowC = av_col(hue + 0.06 * hc, 0.5);
        var topC = av_col(hue + 0.33 + 0.05 * hc, 0.2);
        if (cm == 1) {
          lowC = av_col(hue + 0.45, 0.35);
          topC = av_col(hue + 0.1, 0.3);
        } else if (cm == 2) {
          lowC = av_col(hue + fract(along * 0.006 + hc * 0.3) * 0.5, 0.45);
        }
        var c = mix(lowC, topC, smoothstep(0.0, 0.6, hr));
        c += lowC * exp(-max(up, 0.0) * 5.0) * 0.8 * lower;
        var e = c * prof * rays;
        let kGlow = exp(-kd * kd / 18.0) * exp(-kAge * 1.4);
        e *= 1.0 + 2.6 * kGlow;
        let sd = sl - sx;
        let sGlow = exp(-sd * sd / 0.8) * exp(-sAge * 1.6);
        e += mix(av_col(hue + 0.62, 1.0), vec3f(1.0), 0.3) * sGlow * lower * exp(-max(up, 0.0) / (H * 1.6)) * rays * rays * 0.9;
        // Melody: a band of the note's colour at the pitch's height, running along the curtains.
        let la = abs(along - (rot2(S.p[2].z * h) * ro.xz).x) - lAge * 30.0;
        let behind = smoothstep(1.5, -1.5, la);
        let pN = S.p[5].y * 0.5 + 0.5;
        let pO = S.p[5].z * 0.5 + 0.5;
        let hL = he + (0.12 + 0.55 * mix(pO, pN, behind)) * (yt - yb);
        let lp = mix(S.p[5].z, S.p[5].y, behind);
        let lq = (h - hL) / (0.35 + 0.06 * (yt - yb));
        let band = exp(-lq * lq) * lower;
        let lGlow = exp(-la * la / 6.0) * exp(-lAge * 1.6);
        e += av_col(hue + 0.5 + 0.3 * lp, 0.6) * band * (0.7 + 0.3 * rays) * (0.5 + 2.4 * lGlow);
        let fade = exp(-tc * 0.032) * smoothstep(1.2, 3.5, tc);
        acc += e * presence * thick * fade;
      }
    }
    prev = cur;
  }
  return acc * 0.22 * S.p[6].x;
}

fn scene(uv: vec2f, frag: vec2f) -> vec4f {
  let q = (uv * 2.0 - 1.0) * vec2f(F.aspect, -1.0);
  let head = S.p[0].z;
  let pitch = S.p[0].w;
  let ro = vec3f(S.p[0].x, 0.0, S.p[0].y);
  let fwd = vec3f(sin(head) * cos(pitch), sin(pitch), cos(head) * cos(pitch));
  let camM = lookAt(ro, ro + fwd, 0.0);
  let focal = S.p[3].w;
  let rd = normalize(camM * vec3f(q, focal));
  let pix = 2.0 / (F.res.y * focal);
  let jit = ign(frag);
  let hue = av_hueNow();
  // Deep backdrop: a dark gradient toward the open passage, faint airglow on the horizon line.
  let ay = abs(rd.y);
  var col = F.pal0.rgb * 0.06 * (1.0 - ay) + av_col(hue + 0.2, 0.004) + av_col(hue + 0.05, 0.03) * exp(-ay * 18.0);
  col += av_veil(ro, rd, select(-1.0, 1.0, rd.y > 0.0), pix, jit);
  // Soft shoulder so sheets seen edge-on never clip.
  let pk = max(col.r, max(col.g, col.b));
  col = col / (1.0 + 0.35 * max(pk - 0.8, 0.0));
  return vec4f(col, 1.0);
}
`,
});
