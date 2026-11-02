import { defineLook } from '../types';

/**
 * Pen-and-ink: up to four hatch layers switch on as tone darkens, with contour lines, hand-drawn
 * wobble that "boils" at 10 fps, and paper grain.
 * dna0 = hatch angles, dna1 = line density, dna2 = ink/paper scheme (black on cream, sepia,
 * palette ink, white-on-black scratchboard, neon palette on black), dna3 = stroke style
 * (straight, wavy, straight + colour wash, stipple).
 */
export default defineLook({
  meta: { id: 'ink-hatch', name: 'Ink Hatching', weight: 0.5, energy: [0, 0.8], amount: [0.65, 0.95], genres: { ambient: 0.8, classical: 0.9, hiphop: 0.7 } },
  params(ctx, p) {
    const m = ctx.music;
    const d = ctx.dna;
    p[0] = d[0] * Math.PI;
    p[1] = 6.5 + 7 * d[1];
    p[2] = Math.floor(d[2] * 5);
    p[3] = Math.floor(d[3] * 4);
    p[4] = Math.floor(ctx.time * 10) + Math.floor(m.snare * 3) * 7;
    p[5] = 1 + 0.6 * m.kick + 0.4 * m.dropPulse;
    p[6] = 1 + 0.6 * m.anticipation;
  },
  wgsl: /* wgsl */ `
fn ih_hue(c: vec3f, l: f32) -> vec3f { let k = c + 0.01; return min(k / max(luma(k), 1e-3) * l, vec3f(1.0)); }
// One hatch layer drawn as broken, tapered pen strokes; t (0..1) is how dark the layer's band is.
fn ih_line(frag: vec2f, ang: f32, sp: f32, w: f32, style: f32, seed: f32, t: f32) -> f32 {
  let dir = vec2f(cos(ang), sin(ang));
  let along = dot(frag, vec2f(-dir.y, dir.x));
  var u = dot(frag, dir) / sp;
  // Hand wobble, re-seeded at the boil rate.
  u += (vnoise(vec2f(along * 0.02, seed * 1.7 + ang)) - 0.5) * 0.18;
  if (style > 0.5 && style < 1.5) { u += 0.35 * sin(along * 0.09); }
  let li = floor(u);
  let v = along / (sp * 16.0) + hash12(vec2f(li * 0.37 + 0.5, ang * 13.0 + 0.2));
  let si = floor(v);
  let fv = v - si;
  let h = hash12(vec2f(li * 1.31 + si * 7.7, ang * 5.0 + 1.0));
  let present = step(h, 0.55 + 0.6 * t);
  let taper = smoothstep(0.0, 0.06, fv) * smoothstep(1.0, 0.9 - 0.2 * h, fv);
  let d = abs(u - li - 0.5);
  let aa = 0.7 / sp;
  let ww = w * taper;
  return smoothstep(ww + aa, ww - aa, d) * present;
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let rs = L.res.y / 720.0;
  let px = vec2f(1.0) / L.res;
  let base = src(uv);
  let sl = base / (1.0 + base);
  let lift = 1.0 / (1.0 - min(luma(sl), 0.8));
  let scheme = L.p[0].z;
  let style = L.p[0].w;
  let darkPaper = scheme > 2.5;
  let o = 1.5 * rs;
  let lx = luma(src(uv + vec2f(o * px.x, 0.0))) - luma(src(uv - vec2f(o * px.x, 0.0)));
  let ly = luma(src(uv + vec2f(0.0, o * px.y))) - luma(src(uv - vec2f(0.0, o * px.y)));
  let edge = smoothstep(0.08, 0.35, length(vec2f(lx, ly)) / (luma(base) + 0.1));
  let tone = pow(luma(sl), 0.6);
  // Ink represents darkness on paper, light on scratchboard.
  let D = select(1.0 - tone, tone, darkPaper);
  let sp = max(L.p[0].y * rs, 3.5) * L.p[1].z;
  let seed = L.p[1].x;
  let thick = L.p[1].y;
  var cov = 0.0;
  if (style > 2.5) {
    // Stipple: jittered dots whose radius grows with ink density.
    let cell = sp * 0.8;
    let id = floor(frag / cell);
    let c = (id + 0.5 + (hash22(id) - 0.5) * 0.6) * cell;
    let r = min(cell * 0.36 * sqrt(sat(D * 1.2)) * thick, cell * 0.45);
    let present = step(hash12(id * 1.7 + 4.0), D * 1.35);
    cov = smoothstep(r + 0.8, r - 0.8, length(frag - c)) * present;
  } else {
    let a0 = L.p[0].x;
    var angs = array<f32, 4>(a0, a0 + 1.5708, a0 + 0.7854, a0 - 0.7854);
    var thr = array<f32, 4>(0.12, 0.3, 0.45, 0.57);
    for (var k = 0; k < 4; k++) {
      let t = sat((D - thr[k]) / 0.16);
      if (t > 0.0) {
        let w = (0.07 + 0.2 * t) * thick;
        cov = max(cov, ih_line(frag, angs[k], sp * (1.0 + 0.15 * f32(k)), w, style, seed + f32(k) * 3.1, t) * smoothstep(0.0, 0.25, t));
      }
    }
  }
  // Deep shadows go to solid ink so dark scenes stay dark.
  cov = max(max(cov, edge * 0.9), smoothstep(0.62, 0.74, D));
  let grain = fbm2(frag * 0.08 / rs);
  var ink = vec3f(0.03, 0.03, 0.045);
  var paper = vec3f(0.96, 0.93, 0.86);
  if (scheme > 3.5) { ink = ih_hue(L.pal3.rgb, 0.7); paper = ih_hue(L.pal0.rgb, 0.012); }
  else if (scheme > 2.5) { ink = vec3f(0.95, 0.93, 0.88); paper = vec3f(0.012, 0.012, 0.016); }
  else if (scheme > 1.5) { ink = ih_hue(L.pal1.rgb, 0.03); paper = mix(vec3f(0.95), ih_hue(L.pal3.rgb, 0.9), 0.2); }
  else if (scheme > 0.5) { ink = vec3f(0.12, 0.05, 0.02); paper = vec3f(0.92, 0.84, 0.68); }
  paper *= 0.93 + 0.1 * grain;
  if (style > 1.5 && style < 2.5) {
    // Watercolour wash under the ink.
    let wash = sl / max(luma(sl), 0.05);
    paper = select(paper * mix(vec3f(1.0), min(wash, vec3f(2.0)), 0.45), paper + sl * 0.5, darkPaper);
  }
  let col = mix(paper, ink, sat(cov));
  return col * lift;
}
`,
});
