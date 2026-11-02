import { defineLook } from '../types';
import { OverlayDrive } from './ovlDrive';

const drive = new OverlayDrive();

/**
 * A wall of mirrors: the frame repeated through a wallpaper group (pmm, p4m, p4, glide,
 * cmm, p6m, p3m1). The wall turns and drifts slowly, faster with the eased energy; nothing pulses.
 * Genes: group, tile scale, rotation, tile finish.
 */
export default defineLook({
  meta: { id: 'mirror-tile',
    remaps: true, name: 'Mirror Wall', weight: 0.5, energy: [0.2, 1], amount: [0.6, 0.9], genres: { techno: 0.8, edm: 0.8, pop: 0.6 } },
  params(ctx, p) {
    const d = ctx.dna;
    const v = drive.update(ctx);
    const t = v.flow;
    p[0] = Math.floor(d[0] * 7);
    p[1] = 1.5 + d[1] * 2.6;
    p[2] = d[2] * Math.PI * 2;
    p[3] = d[2] < 0.4 ? 0 : (d[2] < 0.7 ? 0.12 : -0.12);
    // Tile size drifts very slowly.
    p[4] = 1 + 0.05 * Math.sin(t * 0.031);
    p[5] = Math.floor(d[3] * 3);
    p[6] = 0.5 + 0.08 * Math.sin(t * 0.07);
    p[7] = 0.5 + 0.06 * Math.sin(t * 0.09 + 1.7);
    p[8] = 0.7 + 0.25 * d[1];
    p[9] = t * 0.02;
    p[10] = t * 0.02;
    v.write(p, 12);
  },
  wgsl: /* wgsl */ `
fn mt_tri(x: vec2f) -> vec2f { return 1.0 - abs(1.0 - 2.0 * fract(x * 0.5)); }

fn mt_hex(p: vec2f) -> vec4f {
  let s = vec2f(1.0, 1.7320508);
  let h = s * 0.5;
  let a = p - s * floor(p / s) - h;
  let b = (p - h) - s * floor((p - h) / s) - h;
  return select(vec4f(b, p - b), vec4f(a, p - a), dot(a, a) < dot(b, b));
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let group = L.p[0].x;
  let n = L.p[0].y * L.p[1].x;
  let ang = L.p[0].z + L.p[2].y * sign(L.p[0].w + 0.01) * step(0.01, abs(L.p[0].w));
  let style = L.p[1].y;
  let win = L.p[2].x;
  var wc = L.p[1].zw;
  var q = (uv - 0.5) * vec2f(asp, 1.0);
  q = rot2(ang) * q * n + vec2f(0.21, 0.37) * L.p[2].z;

  var f = vec2f(0.5);
  var cell = vec2f(0.0);
  var edge = 0.5;
  var lq = vec2f(0.0);
  if (group < 4.5) {
    var pp = q;
    if (group > 3.5) { pp = rot2(0.785398) * q * 1.4142; }
    cell = floor(pp);
    let fr = fract(pp);
    let ef = abs(fr - 0.5);
    edge = 0.5 - max(ef.x, ef.y);
    if (group < 0.5 || group > 3.5) {
      f = mt_tri(pp);
    } else if (group < 1.5) {
      f = mt_tri(pp);
      if (f.y > f.x) { f = f.yx; }
    } else if (group < 2.5) {
      let k = u32(abs(cell.x)) % 2u + 2u * (u32(abs(cell.y)) % 2u);
      let c = fr - 0.5;
      let r = select(select(select(c, vec2f(-c.y, c.x), k == 1u), vec2f(c.y, -c.x), k == 2u), -c, k == 3u);
      f = r + 0.5;
    } else {
      let row = floor(pp.y);
      let pg = vec2f(pp.x + 0.5 * row, pp.y);
      cell = floor(pg);
      let fg = fract(pg);
      let eg = abs(fg - 0.5);
      edge = 0.5 - max(eg.x, eg.y);
      f = select(fg, vec2f(1.0 - fg.x, fg.y), (u32(abs(row)) % 2u) == 1u);
    }
    lq = (f - 0.5) * win;
  } else {
    let h = mt_hex(q);
    cell = h.zw;
    let c = h.xy;
    edge = 0.5 - max(abs(c.x), dot(abs(c), vec2f(0.5, 0.8660254)));
    let P = select(PI / 3.0, 2.0 * PI / 3.0, group > 5.5);
    let o = select(0.0, PI / 6.0, group > 5.5);
    let a = atan2(c.y, c.x) - o;
    let x = abs(a - P * floor(a / P) - P * 0.5);
    lq = length(c) * vec2f(cos(x), sin(x)) * win * 1.5;
  }

  let hc = hash22(cell + 17.0);
  if (style > 1.5) {
    // Each mirror pane hangs at a slightly different angle.
    wc += (hc - 0.5) * 0.08;
  }
  var col = srcMirror(wc + lq / vec2f(asp, 1.0));
  if (style < 0.5) {
    col *= 0.8 + 0.2 * smoothstep(0.0, 0.025, edge);
  } else {
    let bevel = smoothstep(0.0, 0.07, edge);
    col *= 0.55 + 0.45 * bevel;
    col += palAt(hc.x * 0.3 + 0.6) * exp(-pow((edge - 0.05) / 0.012, 2.0)) * (0.1 + 0.08 * L.p[3].y) * (0.4 + luma(col));
    if (style > 1.5) { col *= 0.9 + 0.2 * hc.y; }
  }
  return col;
}
`,
});
