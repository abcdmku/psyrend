import type { LayerDef } from '../layer';

const N = 49152;

/**
 * A particle system fed by the score: every note attack throws sparks from the exact place the
 * note sits as it sounds, in the note's pitch colour, with energy from its strength. Dense melodic
 * passages fill the air; silence leaves it empty.
 */
export default {
  id: 'note-sparks',
  role: 'particles',
  source: 'particles',
  particles: N,
  verts: 6,
  blend: 'additive',
  weight: 0.6,
  layouts: '*',
  wgsl: /* wgsl */ `
fn sim_note_sparks(i: u32, p: ptr<function, Particle>) {
  let dt = W.h.w;
  let life = (*p).pos.w;
  if (life <= 0.0) {
    let cnt = u32(W.n.y);
    if (cnt == 0u) { return; }
    let seed = pcg(i * 9781u + u32(F.frame) * 6271u);
    let n = notes[u32(W.n.x) + seed % cnt];
    let age = W.h.z - n.start;
    // ~300 sparks per attack, frame-rate independent: per-frame chance scales with dt and window size.
    let chance = 900.0 * f32(cnt) * dt / ${N}.0 * (0.4 + n.strength);
    if (age < 0.0 || age > 0.35 || hashU(seed + 1u) > chance) { return; }
    let role = u32(n.role + 0.5);
    let pos = L(W.h.z, n.pitch, roleLane(role));
    let dir = normalize(hashU3(seed + 2u) * 2.0 - 1.0 + vec3f(1e-3));
    (*p).pos = vec4f(pos, 0.6 + 0.6 * hashU(seed + 3u));
    (*p).vel = vec4f(dir * (0.3 + 1.4 * n.strength) * max(S.p[7].z, 0.2), n.pitch + f32(role) * 1000.0);
    return;
  }
  let v = (*p).vel.xyz * exp(-dt * 1.6);
  (*p).pos = vec4f((*p).pos.xyz + v * dt, life - dt * 0.8);
  (*p).vel = vec4f(v, (*p).vel.w);
}
fn vs_note_sparks(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = pstate_note_sparks[ii];
  if (q.pos.w <= 0.0) { return hidden(); }
  let p = q.pos.xyz;
  let fwd = normalize(p - camEye());
  let rt = normalize(cross(fwd, camUp()));
  let up = cross(rt, fwd);
  let uv = vec2f(qu(vi) * 2.0 - 1.0, qv(vi) * 2.0 - 1.0);
  let size = max(S.p[7].y, 0.004) * (0.5 + q.pos.w);
  let wp = p + (rt * uv.x + up * uv.y) * size;
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(uv, 0.0, 0.0);
  let role = floor(q.vel.w / 1000.0);
  o.b = vec4f(q.vel.w - role * 1000.0, role, q.pos.w, 0.0);
  return o;
}
fn fs_note_sparks(in: LOut) -> vec4f {
  let d = dot(in.a.xy, in.a.xy);
  if (d > 1.0) { discard; }
  let col = palL(S.p[3].x + pitchHue(in.b.x) * 0.55 + select(0.0, 0.33, in.b.y > 1.5), 1.0);
  return glowOut(col * exp(-d * 3.0) * in.b.z * in.b.z * S.p[3].y * 1.2, in.wp);
}
`,
} satisfies LayerDef;
