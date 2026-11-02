import { defineLook } from '../types';

const hash = (n: number) => {
  const x = Math.sin(n * 91.7 + 17.3) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Radial zoom and rotational blur that bursts on kicks and the drop and rests between hits.
 * Genes: burst centre path, zoom-versus-spin ratio, tint (clean, palette trail, spectral,
 * light rays), tap count and trail falloff.
 */
export default defineLook({
  meta: { id: 'zoom-burst', name: 'Zoom Burst', weight: 0.6, energy: [0.4, 1], amount: [0.75, 1], genres: { edm: 1, dnb: 0.8, techno: 0.8, rock: 0.6, ambient: 0.2 } },
  params(ctx, p) {
    const d = ctx.dna;
    const m = ctx.music;
    const t = ctx.time;
    const path = Math.floor(d[0] * 4);
    let cx = 0;
    let cy = 0;
    if (path === 1) {
      cx = 0.2 * Math.sin(t * 0.37);
      cy = 0.14 * Math.sin(t * 0.23 + 0.7);
    } else if (path === 2) {
      cx = (hash(m.beatIndex) - 0.5) * 0.5;
      cy = (hash(m.beatIndex + 33.1) - 0.5) * 0.35;
    } else if (path === 3) {
      cx = 0.22 * Math.cos(t * 0.5);
      cy = 0.16 * Math.sin(t * 0.5);
    }
    p[0] = cx;
    p[1] = cy;
    p[2] = d[1];
    p[3] = d[1] * 10 - Math.floor(d[1] * 10) > 0.5 ? 1 : -1;
    p[4] = Math.floor(d[2] * 4);
    p[5] = [8, 11, 15][Math.floor(d[3] * 3)];
    p[6] = 0.5 + 2.5 * d[3];
  },
  wgsl: /* wgsl */ `
fn zb_spectrum(t: f32) -> vec3f {
  return sat3(vec3f(1.0 - abs(t * 3.0 - 0.5), 1.0 - abs(t * 3.0 - 1.5), 1.0 - abs(t * 3.0 - 2.5)));
}
fn sat3(v: vec3f) -> vec3f { return clamp(v, vec3f(0.0), vec3f(1.0)); }

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let g = sat(L.kick * L.kick * (0.5 + 0.7 * L.energy) + L.dropPulse * 1.3 + L.anticipation * L.anticipation * 0.35);
  if (g < 0.02) { return src(uv); }
  let asp = L.res.x / L.res.y;
  let ctr = vec2f(0.5) + L.p[0].xy;
  let q = (uv - ctr) * vec2f(asp, 1.0);
  let ratio = L.p[0].z;
  let zoom = g * 0.22 * (0.15 + 0.85 * ratio);
  let spin = g * 0.35 * (1.0 - ratio * 0.85) * L.p[0].w;
  let tint = L.p[1].x;
  let n = i32(L.p[1].y);
  let fall = L.p[1].z;
  let jit = hash12(frag + fract(L.time) * 97.0);
  let c0 = src(uv);
  var acc = vec3f(0.0);
  var wsum = vec3f(0.0);
  for (var i = 0; i < n; i++) {
    let t = (f32(i) + jit) / f32(n);
    let p = ctr + rot2(spin * t) * q * (1.0 - zoom * t) / vec2f(asp, 1.0);
    let c = src(p);
    var w = vec3f(exp(-fall * t));
    if (tint > 1.5 && tint < 2.5) { w *= zb_spectrum(t) + 0.15; }
    var cc = c;
    if (tint > 0.5 && tint < 1.5) {
      let pc = palAt(t * 0.6 + L.time * 0.03);
      cc = mix(c, pc * luma(c) / max(luma(pc), 0.05), t * 0.8);
    }
    if (tint > 2.5) { cc = max(c - vec3f(0.6), vec3f(0.0)) * 1.8; }
    acc += cc * w;
    wsum += w;
  }
  let blur = acc / max(wsum, vec3f(1e-4));
  if (tint > 2.5) { return c0 + blur * (0.6 + 0.6 * g); }
  return mix(c0, blur, smoothstep(0.0, 0.35, g));
}
`,
});
