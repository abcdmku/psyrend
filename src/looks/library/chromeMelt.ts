import { defineLook } from '../types';
import { COMMIT_WGSL, OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * Liquid chrome: the world turns to molten metal and slowly melts downward. The picture's own light
 * becomes the relief of a smooth liquid surface (bright forms bulge, dark ones sink), dragged
 * through a warped, viscous flow, and that surface mirrors a chrome horizon (a bright sky above, a
 * dark band, the world's own glow below), anodised in the world's colours, with sharp highlights.
 * The metal takes over in broad, slowly drifting regions; between them the picture just melts.
 * Music, always eased: bass deepens the melt, energy speeds the flow and brightens the chrome,
 * each kick carries the warp on to a new lasting shape.
 * Genes: flow scale, melt strength, relief depth, chrome tint.
 */
export default defineLook({
  meta: { id: 'chrome-melt', name: 'Chrome Melt', weight: 0.45, energy: [0.2, 1], amount: [0.8, 1], overlay: true,
    genres: { dubstep: 0.9, edm: 0.8, techno: 0.8, synthwave: 0.8, hiphop: 0.6 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    p[0] = 1.1 + 1.0 * d[0];
    p[1] = (0.016 + 0.016 * d[1]) * (0.8 + 0.5 * v.bass);
    p[2] = 0.7 + 0.6 * d[2];
    p[3] = d[3];
    p[4] = v.kicks * 0.12;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `${COMMIT_WGSL}
fn cm_flow(p: vec2f, t: f32) -> f32 {
  // A smooth warped-sine flow, stretched tall and drifting down, so it reads as liquid running.
  let a = vec2f(p.x, p.y * 0.5 - t * 0.09);
  let w = vec2f(sin(a.y * 1.7 + t * 0.13 + sin(a.x * 1.3)), sin(a.x * 1.9 - t * 0.11 + sin(a.y * 1.1 + 2.0)));
  let b = a + w * 0.6;
  return 0.22 * sin(b.x * 2.2 + 1.3 * sin(b.y * 1.6 + t * 0.07) + L.p[1].x)
       + 0.22 * sin(b.y * 2.7 - 0.8 * b.x + 1.2 * sin(b.x * 1.5 - t * 0.05) - L.p[1].x * 0.7);
}

// The metal's relief slope at one scale: the world's softened light (compressed so highlights round
// off), differenced across about one blur width so the slope stays smooth, never stepped.
fn cm_slope(uv: vec2f, px: f32, asp: f32) -> vec2f {
  let o = px / 720.0;
  let ox = vec2f(o / asp, 0.0);
  let oy = vec2f(0.0, o);
  let a = luma(srcSoft(uv + ox, px)); let b = luma(srcSoft(uv - ox, px));
  let c = luma(srcSoft(uv + oy, px)); let d = luma(srcSoft(uv - oy, px));
  return vec2f(a / (a + 0.35) - b / (b + 0.35), c / (c + 0.35) - d / (d + 0.35));
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let t = L.p[3].x;
  let base = src(uv);
  // Melt: the world is dragged along the flow and a little downhill.
  let sc = L.p[0].x;
  let p = (uv - 0.5) * vec2f(asp, 1.0) * sc;
  let ef = 0.01 * sc;
  let f = cm_flow(p, t);
  let gf = vec2f(cm_flow(p + vec2f(ef, 0.0), t) - f, cm_flow(p + vec2f(0.0, ef), t) - f) / ef;
  let duv = (gf * vec2f(1.0, 1.4) + vec2f(0.0, -0.35 * length(gf))) * L.p[0].y / vec2f(asp, 1.0);
  let mu = uv - duv;
  let world = vec3f(src(mu - duv * 0.04).r, src(mu).g, src(mu + duv * 0.04).b);
  // The liquid surface: relief slope from the softened world, plus the flow's own gentle swell.
  let gr = (cm_slope(mu, 14.0, asp) * 1.2 + cm_slope(mu, 32.0, asp) * 0.9) * L.p[0].z + gf * 0.12;
  let n = normalize(vec3f(-gr, 1.0));
  let r = reflect(vec3f(0.0, 0.0, -1.0), n);
  // A chrome horizon that drifts with the flow: it sits across the middle of the frame and is bent
  // by the relief, so every form carries a bright sky over a dark band.
  let hz = (uv.y - 0.5) * 0.25 + r.y * 1.8 + 0.12 * f + 0.06 * sin(uv.x * asp * 1.7 + t * 0.05);
  let sky = smoothstep(0.02, -0.22, hz);
  let band = exp(-pow((hz - 0.05) / 0.06, 2.0));
  let lip = exp(-pow((hz + 0.02) / 0.025, 2.0));
  let ground = srcSoft(mu + r.xy * vec2f(0.25 / asp, 0.25), 12.0);
  var tint = vec3f(1.0);
  if (L.p[0].w > 0.5) {
    let pc = palAt(0.3 + 0.4 * f + L.p[0].w);
    tint = mix(vec3f(1.0), pc / max(luma(pc), 0.05), 0.4);
  }
  let skyc = tint * (0.4 + 0.3 * smoothstep(0.0, -0.6, hz)) * (0.85 + 0.3 * L.p[3].y);
  var chrome = mix(ground * 1.05 + 0.02, skyc, sky);
  chrome = chrome * (1.0 - 0.8 * band) + tint * lip * 0.35;
  // Anodised in the world's colours: the metal keeps the picture's (softened) hue and the chrome
  // sets its light; where the world is dark it takes a deep palette colour instead of going grey.
  let wc = srcSoft(mu, 16.0);
  let wl = luma(wc);
  let pd = palAt(0.6 + 0.3 * f + L.p[0].w);
  // The metal's body colour: the world, partly softened, a little richer, never quite black.
  let bc = mix(world, wc, 0.4);
  let body = max(mix(vec3f(luma(bc)), bc, 1.25), vec3f(0.0)) + pd * 0.04;
  // The chrome lights the body: dark in the band, bright where it mirrors the sky.
  let cl = luma(chrome);
  var chromeCol = body * (0.15 + 2.2 * cl) + chrome * 0.05;
  let l = normalize(vec3f(-0.4, -0.65, 0.65));
  let rz = max(dot(r, l), 0.0);
  chromeCol += tint * (pow(rz, 90.0) * 1.0 + pow(rz, 12.0) * 0.08) * (0.75 + 0.35 * L.p[3].y);
  // The world turns to metal in broad, slowly drifting regions and stays melted picture between.
  let cov = smoothstep(-0.12, 0.06, f + 0.12 * sin(t * 0.04));
  let col = mix(world, chromeCol + world * 0.12, cov);
  return ov_commit(base, max(col, vec3f(0.0)));
}
`,
});
