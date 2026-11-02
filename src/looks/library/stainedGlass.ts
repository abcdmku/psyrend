import { defineLook } from '../types';
import { OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * Stained glass: Voronoi panes filled with the averaged image colour, lead came between them,
 * panes back-lit by a slow wave of light that swells with the eased energy (nothing flashes).
 * dna0 = pane size, dna1 = jitter (near-hex grid to wild shards), dna2 = lead width,
 * dna3 = glass (flat, palette-tinted, refractive cathedral glass).
 */
export default defineLook({
  meta: { id: 'stained-glass',
    remaps: true, name: 'Stained Glass', weight: 0.45, energy: [0.1, 0.9], amount: [0.6, 0.9], genres: { ambient: 0.8, classical: 1, acoustic: 0.7 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    p[0] = 16 + 46 * d[0] * d[0];
    p[1] = 0.15 + 0.85 * d[1];
    p[2] = 0.025 + 0.09 * d[2];
    p[3] = Math.floor(d[3] * 3);
    p[4] = v.energy;
    p[5] = v.flow * 0.35;
    p[6] = 0;
    p[7] = v.flow;
    p[8] = 0;
    p[9] = 0;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `
fn sg_pt(c: vec2f) -> vec2f {
  let h = hash22(c);
  let jit = L.p[0].y;
  // Low jitter: offset rows give a near-hex lattice; high jitter: random shards that slowly drift.
  let row = select(0.0, 0.5 * (1.0 - jit) * (c.y - 2.0 * floor(c.y * 0.5)), jit < 0.6);
  return vec2f(0.5 + row, 0.5) + jit * 0.42 * sin(L.p[1].w * (0.25 + 0.2 * h.yx) + TAU * h);
}
fn sg_vor(p: vec2f) -> vec4f {
  let n = floor(p);
  let f = p - n;
  var mg = vec2f(0.0);
  var mr = vec2f(0.0);
  var md = 8.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let r = g + sg_pt(n + g) - f;
      let d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  md = 8.0;
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let g = mg + vec2f(f32(i), f32(j));
      let r = g + sg_pt(n + g) - f;
      if (dot(mr - r, mr - r) > 1e-5) { md = min(md, dot(0.5 * (mr + r), normalize(r - mr))); }
    }
  }
  return vec4f(p + mr, md, hash12(n + mg));
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let rs = L.res.y / 720.0;
  let size = L.p[0].x * rs * (1.0 + L.p[2].x);
  let v = sg_vor(frag / size);
  let site = v.xy * size / L.res;
  let ed = v.z;
  let h = v.w;
  let o = vec2f(0.28 * size) / L.res;
  var c = (src(site + vec2f(o.x, 0.0)) + src(site - vec2f(o.x, 0.0)) + src(site + vec2f(0.0, o.y)) + src(site - vec2f(0.0, o.y))) * 0.25;
  let glass = L.p[0].w;
  if (glass > 1.5) {
    // Cathedral glass: each pane refracts a shrunken, slightly offset view of the scene.
    let rfuv = site + (uv - site) * 0.55 + (hash22(vec2f(h * 91.0, 3.0)) - 0.5) * o;
    c = mix(c, src(rfuv), 0.65);
  } else if (glass > 0.5) {
    // Tint toward the nearest palette hue, keeping the pane's brightness.
    let cn = c / max(luma(c), 1e-3);
    var best = L.pal1.rgb;
    var bd = 1e9;
    for (var k = 0; k < 4; k++) {
      let pc = palAt(f32(k) * 0.25);
      let pn = pc / max(luma(pc), 1e-3);
      let dd = dot(pn - cn, pn - cn);
      if (dd < bd) { bd = dd; best = pn; }
    }
    c = mix(c, min(best, vec3f(4.0)) * luma(c), 0.7);
  }
  let l = luma(c);
  c = max(mix(vec3f(l), c, 1.45), vec3f(0.0)) + 0.02 * L.pal2.rgb;
  // Glass body: thicker (darker) near the came, rippled, with a seed-dependent shade.
  let ripple = vnoise(frag * 0.06 / rs + h * 40.0);
  c *= (0.62 + 0.38 * smoothstep(0.0, 0.35, ed)) * (0.88 + 0.24 * ripple) * (0.85 + 0.3 * h);
  // Back-light: a slow wave of light drifts across the panes, fuller with the eased energy.
  let hb = hash12(vec2f(h * 113.0, 5.0));
  let flare = (0.1 + 0.25 * L.p[1].x) * (0.5 + 0.5 * sin(L.p[1].y + hb * TAU));
  c *= 1.0 + flare * smoothstep(0.0, 0.3, ed);
  // Lead came with a soft highlight ridge.
  let lw = L.p[0].z;
  let aa = 1.2 / size;
  let lead = 1.0 - smoothstep(lw, lw + aa, ed);
  let ridge = pow(sat(1.0 - ed / max(lw, 1e-3)), 3.0);
  let leadCol = vec3f(0.012, 0.012, 0.014) + ridge * 0.06 * (0.6 + L.pal3.rgb * 0.3);
  return mix(c, leadCol, lead);
}
`,
});
