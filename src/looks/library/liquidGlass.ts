import { defineLook } from '../types';
import { OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * The scene seen through a large, slowly moving pane of sculpted glass. The glass is one big form
 * (a molten sheet with a few wide swells, drifting lens bodies that merge, wide fluted glass whose
 * flutes bend and change width, or long slow ripples), domain-warped so it never repeats. It
 * refracts the world with dispersion and catches thin, tinted highlights along its steep slopes.
 * Music, always eased: energy sets how fast the glass flows, bass deepens the refraction, the
 * melody brings up the highlights. Nothing pulses on the beat.
 * Genes: form scale, refractive strength, highlight tint, glass family.
 */
export default defineLook({
  meta: { id: 'liquid-glass', name: 'Liquid Glass', weight: 0.75, energy: [0, 0.85], amount: [0.7, 0.95], overlay: true, genres: { ambient: 1, lofi: 0.9, jazz: 0.7, classical: 0.7, dubstep: 0.3 } },
  params(ctx, p) {
    const d = ctx.dna;
    // Big forms: about one to two swells across the screen height.
    p[0] = 0.7 + 0.8 * d[0];
    p[1] = 0.16;
    p[2] = 0.035 + 0.035 * d[1];
    p[3] = d[1] > 0.6 ? 0.06 : 0.035;
    p[4] = Math.floor(d[2] * 4);
    p[5] = Math.floor(d[3] * 4);
    drive.update(ctx).write(p, 12);
  },
  wgsl: /* wgsl */ `
// A slow, large warp so no family ever shows a regular, repeating pattern.
fn lg_warp(p: vec2f, t: f32) -> vec2f {
  return p + 0.55 * vec2f(fbm2(p * 0.45 + vec2f(t * 0.11, 1.7)) - 0.5, fbm2(p * 0.45 + vec2f(4.3, -t * 0.09)) - 0.5) * 2.0;
}

// Drifting lens bodies that merge where they meet (a smooth union of soft domes).
fn lg_lenses(p: vec2f, t: f32) -> f32 {
  var s = 0.0;
  for (var i = 0; i < 5; i++) {
    let fi = f32(i);
    let c = vec2f(sin(t * (0.07 + 0.02 * fi) + fi * 2.4) * 1.3, cos(t * (0.06 + 0.017 * fi) + fi * 1.3) * 0.8);
    let r = 0.55 + 0.25 * sin(fi * 3.7 + t * 0.05);
    let d = length(p - c) / r;
    s += exp(-d * d * 1.6);
  }
  return 1.0 - exp(-s * 1.3);
}

fn lg_height(p0: vec2f, t: f32, kind: f32) -> f32 {
  let p = lg_warp(p0, t);
  if (kind < 0.5) {
    // Molten sheet: two wide octaves only, so it reads as a few broad swells.
    return 0.65 * vnoise(p * 0.9 + vec2f(t * 0.12, 0.0)) + 0.35 * vnoise(p * 1.9 + vec2f(3.1, t * 0.1));
  }
  if (kind < 1.5) { return lg_lenses(p, t); }
  if (kind < 2.5) {
    // Wide flutes that bend with the warp and change width along their length.
    let w = 1.0 + 0.45 * sin(p.y * 0.6 + t * 0.07);
    let ph = p.x / (0.85 * w) + 0.3 * sin(p.y * 0.35 - t * 0.05);
    return 0.5 + 0.5 * cos(ph * 6.2831853);
  }
  // Long slow ripples from two drifting sources.
  let a = length(p - vec2f(sin(t * 0.05) * 1.5, -1.2));
  let b = length(p - vec2f(1.6, cos(t * 0.04) * 1.2));
  return 0.5 + 0.25 * sin(a * 3.2 - t * 0.5) + 0.25 * sin(b * 2.6 - t * 0.4);
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let kind = L.p[1].y;
  let t = L.p[3].x * 0.5;
  let p = (uv - 0.5) * vec2f(asp, 1.0) * 2.0 * L.p[0].x;
  let e = 2.0 * L.p[0].x / L.res.y * 2.0;
  let h = lg_height(p, t, kind);
  let hx = lg_height(p + vec2f(e, 0.0), t, kind);
  let hy = lg_height(p + vec2f(0.0, e), t, kind);
  let g = vec2f(hx - h, hy - h) / e;
  let amp = 1.0 + 0.4 * L.p[3].z;
  // Families differ in how steep they are; even out how strongly each bends the world.
  var fam = 1.0;
  if (kind > 0.5 && kind < 1.5) { fam = 2.6; }
  if (kind > 1.5 && kind < 2.5) { fam = 0.55; }
  if (kind > 2.5) { fam = 1.8; }
  let off = g * L.p[0].z * amp * fam / vec2f(asp, 1.0);
  let disp = L.p[0].w;
  let col = vec3f(
    src(uv - off * (1.0 - disp)).r,
    src(uv - off).g,
    src(uv - off * (1.0 + disp)).b,
  );
  // Thin highlights on steep slopes, tinted, never white smudges.
  let n = normalize(vec3f(-g * 0.25 * amp * fam, 1.0));
  let l = normalize(vec3f(0.45 * sin(L.p[3].x * 0.05), -0.6, 0.75));
  let spec = pow(max(dot(reflect(-l, n), vec3f(0.0, 0.0, 1.0)), 0.0), 90.0);
  let tm = L.p[1].x;
  var tint = vec3f(1.0);
  if (tm < 0.5) { let c = palAt(0.25 + h * 0.5); tint = c / max(luma(c), 0.05) * 0.7; }
  if (tm > 0.5 && tm < 1.5) { tint = L.pal3.rgb / max(luma(L.pal3.rgb), 0.05) * 0.7; }
  if (tm > 1.5 && tm < 2.5) { let c = palAt(h * 0.8 + L.p[3].x * 0.02); tint = c / max(luma(c), 0.05) * 0.7; }
  if (tm > 2.5) { tint = mix(vec3f(1.0), col / max(luma(col), 0.05), 0.5) * 0.8; }
  let shine = spec * (0.3 + 0.25 * L.p[3].w) * (0.4 + luma(col));
  // A faint shading by slope gives the glass body.
  let body = 0.92 + 0.12 * dot(n.xy, vec2f(-0.5, 0.6));
  return col * body + tint * shine;
}
`,
});
