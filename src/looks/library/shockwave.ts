import { defineLook } from '../types';

/**
 * Refractive shock rings: each beat launches a ring (aged statelessly from beatPhase) from a
 * moving origin, and the drop fires one big ring from the centre. Genes: ring count,
 * thickness, chromatic split, origin pattern.
 */
export default defineLook({
  meta: { id: 'shockwave', name: 'Shockwave', weight: 0.6, energy: [0.35, 1], amount: [0.75, 1], genres: { edm: 1, dubstep: 0.9, techno: 0.8, dnb: 0.7, ambient: 0.2 } },
  params(ctx, p) {
    const d = ctx.dna;
    const m = ctx.music;
    p[0] = 1 + Math.floor(d[0] * 4);
    p[1] = 0.018 + 0.07 * d[1];
    p[2] = 0.08 + 0.7 * d[2] * d[2];
    p[3] = Math.floor(d[3] * 4);
    p[4] = m.beatIndex % 4096;
    p[5] = 0.42 + 0.25 * (1 - d[1]);
  },
  wgsl: /* wgsl */ `
fn sw_origin(bi: f32, mode: f32, asp: f32) -> vec2f {
  if (mode < 0.5) { return vec2f(0.0); }
  let h = hash22(vec2f(bi * 0.137, 4.1));
  if (mode < 1.5) { return (h - 0.5) * vec2f(asp * 0.7, 0.6); }
  if (mode < 2.5) {
    let a = bi * 2.39996;
    return vec2f(cos(a) * 0.3 * asp, sin(a) * 0.28);
  }
  // From the screen edges, alternating sides.
  let side = select(-1.0, 1.0, (u32(bi) % 2u) == 0u);
  return vec2f(side * 0.5 * asp, (h.y - 0.5) * 0.8);
}

fn look(uv: vec2f, frag: vec2f) -> vec3f {
  let asp = L.res.x / L.res.y;
  let q = (uv - 0.5) * vec2f(asp, 1.0);
  let count = i32(L.p[0].x);
  let th = L.p[0].y;
  let split = L.p[0].z;
  let mode = L.p[0].w;
  let bi = L.p[1].x;
  let speed = L.p[1].y * select(1.0, 1.6, mode > 2.5);
  var disp = vec2f(0.0);
  var crest = 0.0;
  for (var k = 0; k < count; k++) {
    let age = L.beatPhase + f32(k);
    let o = sw_origin(bi - f32(k), mode, asp);
    let v = q - o;
    let rl = length(v);
    let d = rl - age * speed;
    let life = 1.0 - age / f32(count + 1);
    let A = life * life * (0.35 + 0.65 * L.energy) * (1.0 + select(0.0, 0.8 * L.kick, k == 0));
    let gss = exp(-d * d / (th * th));
    disp += v / max(rl, 1e-4) * (d / th) * gss * A * th * 2.0;
    crest += gss * A;
  }
  // The drop: one wide ring from the centre.
  let dp = L.dropPulse;
  if (dp > 0.01) {
    let rl = length(q);
    let d = rl - (1.0 - dp) * 1.6;
    let tw = th * 2.5;
    let gss = exp(-d * d / (tw * tw));
    disp += q / max(rl, 1e-4) * (d / tw) * gss * dp * tw * 1.4;
    crest += gss * dp;
  }
  let o = disp / vec2f(asp, 1.0);
  let col = vec3f(
    srcMirror(uv - o * (1.0 + split)).r,
    srcMirror(uv - o).g,
    srcMirror(uv - o * (1.0 - split)).b,
  );
  let hue = palAt(L.time * 0.05 + crest * 0.3);
  return col * (1.0 + 0.25 * crest) + hue * crest * 0.06 * (1.0 + 2.0 * split);
}
`,
});
