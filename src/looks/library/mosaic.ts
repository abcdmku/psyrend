import { defineLook } from '../types';

/**
 * Tile mosaic: square / diamond / hex / triangle tiles of averaged colour with grout and bevel lighting.
 * Tile size steps per beat and breathes with the kick.
 * dna0 = tile shape, dna1 = size, dna2 = bevel depth, dna3 = grout width and colour mode (pure, posterised, palette).
 */
export default defineLook({
  meta: { id: 'mosaic',
    remaps: true, name: 'Bevel Mosaic', weight: 0.5, energy: [0.2, 1], amount: [0.6, 0.95], genres: { edm: 0.8, synthwave: 0.8, pop: 0.7 } },
  params(ctx, p) {
    const m = ctx.music;
    const d = ctx.dna;
    // Per-beat size step from a small set, keyed by the beat index (stateless).
    const steps = [1, 1, 1.35, 0.8, 1.6, 1];
    const h = Math.abs(Math.sin(m.beatIndex * 12.9898 + d[1] * 78.233) * 43758.5453) % 1;
    const step = steps[Math.floor(h * steps.length)];
    p[0] = Math.floor(d[0] * 4);
    p[1] = (9 + 22 * d[1]) * step * (1 + 0.18 * m.kick) * (1 + 0.6 * m.anticipation) * (1 - 0.3 * m.dropPulse);
    p[2] = 0.04 + 0.3 * d[2];
    p[3] = d[3];
    p[4] = d[2] * 6.283 + ctx.time * 0.5 + m.kick * 0.8;
    p[5] = m.snare;
  },
  wgsl: /* wgsl */ `
// Returns (tile centre in px, edge distance in tile units where 0 = edge, ~0.5 = centre).
fn mz_tile(frag: vec2f, size: f32, shape: f32) -> vec3f {
  if (shape < 0.5 || (shape > 2.5)) {
    var p = frag / size;
    var R = mat2x2f(1.0, 0.0, 0.0, 1.0);
    if (shape > 2.5) { R = rot2(0.785398); p = R * p; }
    let id = floor(p);
    let q = p - id - 0.5;
    let c = transpose(R) * (id + 0.5);
    return vec3f(c * size, 0.5 - max(abs(q.x), abs(q.y)));
  }
  if (shape < 1.5) {
    let p = frag / size;
    let s = vec2f(1.0, 1.7320508);
    let a = p - s * floor(p / s) - s * 0.5;
    let pb = p - s * 0.5;
    let b = pb - s * floor(pb / s) - s * 0.5;
    let g = select(b, a, dot(a, a) < dot(b, b));
    let ag = abs(g);
    let hd = max(ag.x, dot(ag, vec2f(0.5, 0.8660254)));
    return vec3f((p - g) * size, 0.5 - hd);
  }
  // Triangles on a skewed lattice.
  let p = frag / size;
  let q = vec2f(p.x - p.y * 0.57735027, p.y * 1.15470054);
  let id = floor(q);
  let f = q - id;
  let up = f.x + f.y > 1.0;
  let qc = id + select(vec2f(1.0 / 3.0), vec2f(2.0 / 3.0), up);
  let c = vec2f(qc.x + qc.y * 0.5, qc.y * 0.8660254);
  let e = select(min(min(f.x, f.y), 1.0 - f.x - f.y), min(min(1.0 - f.x, 1.0 - f.y), f.x + f.y - 1.0), up);
  return vec3f(c * size, e * 1.5);
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let rs = L.res.y / 720.0;
  let shape = L.p[0].x;
  let size = max(L.p[0].y * rs * select(1.0, 1.8, shape > 1.5 && shape < 2.5), 3.0);
  let t = mz_tile(frag, size, shape);
  let ed = t.z;
  let cuv = t.xy / L.res;
  let o = vec2f(0.22 * size) / L.res;
  var c = (src(cuv) * 2.0 + src(cuv + vec2f(o.x, 0.0)) + src(cuv - vec2f(o.x, 0.0)) + src(cuv + vec2f(0.0, o.y)) + src(cuv - vec2f(0.0, o.y))) / 6.0;
  let mode = L.p[0].w;
  if (mode > 0.66) {
    // Snap hue to the palette, keep luminance.
    let l = luma(c);
    let cn = c / max(l, 1e-3);
    var best = cn;
    var bd = 1e9;
    for (var k = 0; k < 4; k++) {
      let pc = palAt(f32(k) * 0.25);
      let pn = pc / max(luma(pc), 1e-3);
      let dd = dot(pn - cn, pn - cn);
      if (dd < bd) { bd = dd; best = pn; }
    }
    c = mix(c, min(best, vec3f(2.5)) * l, 0.5);
  } else if (mode > 0.33) {
    let s = c / (1.0 + c);
    let q = floor(s * 5.0 + 0.5) / 5.0;
    c = q / max(vec3f(1.0) - q, vec3f(0.08));
  }
  // Bevel: height rises from the grout over bevelW, lit by an orbiting light.
  let bw = L.p[0].z;
  let hgt = smoothstep(0.0, bw, ed);
  let n = normalize(vec3f(-dpdx(hgt), -dpdy(hgt), 0.0) * size * bw * 0.9 + vec3f(0.0, 0.0, 1.0));
  let la = L.p[1].x;
  let ld = normalize(vec3f(cos(la), sin(la), 0.9));
  let diff = 1.0 + 1.6 * (dot(n, ld) - ld.z);
  let spec = pow(max(dot(reflect(-ld, n), vec3f(0.0, 0.0, 1.0)), 0.0), 24.0) * (0.25 + 0.6 * L.p[1].y);
  var col = c * max(diff, 0.15) + spec * (0.3 + luma(c)) * vec3f(1.0, 0.97, 0.92);
  // Grout.
  let gw = 0.02 + 0.06 * fract(L.p[0].w * 3.0);
  let aa = 1.0 / size;
  let grout = smoothstep(gw, gw + aa, ed);
  return mix(L.pal0.rgb * 0.05 + vec3f(0.01), col, grout);
}
`,
});
