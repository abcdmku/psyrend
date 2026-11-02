import { defineLook } from '../types';
import { OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * Metallic relief: the image's luminance becomes a height field pressed into foil and lit by a
 * slowly moving light, with a sheen that drifts across now and then.
 * dna0 = metal (gold, silver, copper, palette anodised), dna1 = light angle, dna2 = depth,
 * dna3 = relief vs engraved, and how much of the original colour shows through.
 */
export default defineLook({
  meta: { id: 'emboss', name: 'Embossed Foil', weight: 0.5, energy: [0.1, 0.9], amount: [0.55, 0.9], genres: { hiphop: 0.8, classical: 0.7, techno: 0.6 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    p[0] = Math.floor(d[0] * 4);
    p[1] = d[1] * 6.283 + 0.5 * Math.sin(v.flow * 0.2);
    p[2] = 2.5 + 7 * d[2];
    p[3] = d[3] < 0.5 ? 1 : -1;
    p[4] = 0.15 + 0.6 * ((d[3] * 2) % 1);
    p[5] = 0.15 + 0.2 * v.energy;
    p[6] = (v.flow * 0.05) % 1;
    p[7] = 1 + 0.3 * v.energy;
  },
  wgsl: /* wgsl */ `
fn eb_h(uv: vec2f) -> f32 { let l = luma(src(uv)); return l / (1.0 + l); }
fn eb_metal(mode: f32) -> vec3f {
  if (mode < 0.5) { return vec3f(1.0, 0.72, 0.3); }
  if (mode < 1.5) { return vec3f(0.92, 0.93, 0.96); }
  if (mode < 2.5) { return vec3f(0.96, 0.58, 0.42); }
  let c = L.pal2.rgb + 0.02;
  return min(c / max(luma(c), 1e-3) * 0.7, vec3f(1.0));
}
fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let rs = L.res.y / 720.0;
  let t = vec2f(1.3 * rs) / L.res;
  let base = src(uv);
  let h00 = eb_h(uv - t); let h10 = eb_h(uv + vec2f(0.0, -t.y)); let h20 = eb_h(uv + vec2f(t.x, -t.y));
  let h01 = eb_h(uv - vec2f(t.x, 0.0)); let h21 = eb_h(uv + vec2f(t.x, 0.0));
  let h02 = eb_h(uv + vec2f(-t.x, t.y)); let h12 = eb_h(uv + vec2f(0.0, t.y)); let h22 = eb_h(uv + t);
  let gx = (h20 + 2.0 * h21 + h22) - (h00 + 2.0 * h01 + h02);
  let gy = (h02 + 2.0 * h12 + h22) - (h00 + 2.0 * h10 + h20);
  let depth = L.p[0].z * L.p[0].w;
  let n = normalize(vec3f(-gx * depth, -gy * depth, 1.0));
  let la = L.p[0].y;
  let ld = normalize(vec3f(cos(la), sin(la), 0.75));
  let metal = eb_metal(L.p[0].x);
  let tone = base / (1.0 + base);
  let lum = luma(tone);
  // Fake environment: a soft studio gradient reflected off the normal.
  let r = reflect(vec3f(0.0, 0.0, -1.0), n);
  let env = 0.35 + 0.65 * smoothstep(-0.6, 0.8, dot(r.xy, vec2f(cos(la), sin(la))));
  let diff = max(dot(n, ld), 0.0);
  let spec = pow(max(dot(reflect(-ld, n), vec3f(0.0, 0.0, 1.0)), 0.0), 40.0) * L.p[1].w;
  // A sheen band drifting across now and then (it wraps well off screen).
  let sweep = dot(uv - 0.5, vec2f(cos(la + 1.2), sin(la + 1.2))) + 0.5;
  let sheen = exp(-pow((sweep - (L.p[1].z * 2.4 - 0.7)) * 9.0, 2.0)) * L.p[1].y;
  let albedo = metal * 1.5 * lum;
  var col = albedo * (0.25 * env + 0.95 * diff) + metal * spec * (0.08 + lum) + metal * sheen * 0.9 * (0.04 + lum);
  // Let the original colour tint the foil.
  col = mix(col, col * min(tone / max(lum, 0.02), vec3f(2.5)), L.p[1].x);
  // Map back from display-ish range toward the input's HDR level.
  return col / max(1.0 - 0.75 * lum, 0.2);
}
`,
});
