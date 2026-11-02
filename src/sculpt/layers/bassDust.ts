import type { LayerDef } from '../layer';

const N = 65536;
/** Semitone strings of dust under the bass lane, and the seconds of score they cover. */
const STRINGS = 40;
const PAST = 2.5;
const SPAN = 8.0;
/** How long a bass attack's pressure wave keeps travelling (s). */
const WAVE_T = 1.8;

/**
 * The bass as waves in a medium. Under the bass lane lies a staff of dust: one fine thread per
 * semitone of the bass register, laid along time. Every bass note sends a pressure wave out from
 * the place it sounds, as strong as the note: the dust it passes is thrown outward and up, lights
 * in the note's colour, and springs back, so each attack leaves a ring that crosses the staff and
 * the threads settle between notes. Resting dust only glows where the bass line itself runs.
 */
export default {
  id: 'bass-dust',
  role: 'particles',
  source: 'particles',
  particles: N,
  verts: 6,
  blend: 'additive',
  weight: 0.6,
  layouts: '*',
  wgsl: /* wgsl */ `
const BASS_DUST_LANE: f32 = -1.35;
/** Home of mote i at song time now: (home time, string pitch, lane jitter). */
fn bass_dust_home(i: u32, now: f32) -> vec3f {
  let per = ${N}u / ${STRINGS}u;
  let s = i / ${STRINGS}u;
  let line = i % ${STRINGS}u;
  let base = (f32(s) + 0.5) / f32(per) * ${SPAN};
  let t0 = now - ${PAST};
  let th = t0 + fmod(base - t0, ${SPAN});
  let pitch = floor(S.p[0].z) - 29.0 + f32(line);
  let gen = u32(floor((th - base) / ${SPAN} + 0.5) + 100000.0);
  let jit = (hashU(pcg(i * 3u + gen * 7919u)) - 0.5) * 0.12;
  return vec3f(th, pitch, jit);
}
fn bass_dust_world(h: vec3f) -> vec3f { return L(h.x, h.y, BASS_DUST_LANE + h.z); }
/** First note index in the window whose start is after t. */
fn bass_dust_after(t: f32) -> u32 {
  var lo = u32(W.n.x);
  var hi = lo + u32(W.n.y);
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi) / 2u;
    if (notes[mid].start <= t) { lo = mid + 1u; } else { hi = mid; }
  }
  return lo;
}
fn bass_dust_ease(x: f32) -> f32 { let s = sat(x * 0.5 + 0.5); return s * s * (3.0 - 2.0 * s); }
fn sim_bass_dust(i: u32, p: ptr<function, Particle>) {
  let now = W.h.z;
  let dt = W.h.w;
  let h = bass_dust_home(i, now);
  var d = (*p).pos.xyz;
  var v = (*p).vel.xyz;
  var hue = (*p).vel.w;
  if (abs((*p).pos.w - h.x) > 1e-3) { d = vec3f(0.0); v = vec3f(0.0); hue = h.y; }
  let H = bass_dust_world(h);
  let up = LUp(h.x);
  // Scale of the medium: the wave crosses about 1.4 s of score per second.
  let c = max(S.p[0].x, 0.8) * 1.1;
  let w = c * 0.16;
  let first = u32(W.n.x);
  var k = bass_dust_after(now);
  var guard = 0u;
  loop {
    if (k <= first || guard >= 64u) { break; }
    k -= 1u;
    guard += 1u;
    let n = notes[k];
    if (n.start < now - ${WAVE_T}) { break; }
    if (u32(n.role + 0.5) != 1u) { continue; }
    let src = L(n.start, n.pitch, -1.0);
    var r = H - src;
    let x = length(r);
    r = select(up, r / max(x, 1e-4), x > 1e-4);
    let age = now - n.start;
    // Impulse delivered as the front passes this frame: exact for any frame length.
    let gain = bass_dust_ease((c * age - x) / w) - bass_dust_ease((c * (age - dt) - x) / w);
    let amp = n.strength * exp(-x / (c * 0.9)) * c * 1.3;
    v += (r * 0.55 + up * 0.85) * amp * gain;
    if (gain > 0.02) { hue = n.pitch; }
  }
  // Damped spring back to rest: the dust settles between notes (~1 s).
  let ks = 24.0;
  let kd = 2.6;
  v = (v - d * ks * dt) * exp(-kd * dt);
  d += v * dt;
  (*p).pos = vec4f(d, h.x);
  (*p).vel = vec4f(v, hue);
}
fn vs_bass_dust(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = pstate_bass_dust[ii];
  let h = bass_dust_home(ii, W.h.z);
  if (abs(q.pos.w - h.x) > 1e-3) { return hidden(); }
  let c = bass_dust_world(h) + q.pos.xyz;
  let dtn = h.x - W.h.z;
  // Fade at the ends of the staff and toward the future.
  let edge = sat((dtn + ${PAST}) / 0.6) * sat((${SPAN - PAST} - dtn) / 2.0);
  let sc = max(S.p[0].x, 0.8);
  let energy = length(q.vel.xyz) / sc * 2.2 + length(q.pos.xyz) / sc * 3.0;
  let rest = 0.06 + 0.5 * score(dtn, h.y).b * playLight(dtn);
  let b = (rest + energy) * edge;
  if (b < 0.004) { return hidden(); }
  let fwd = normalize(c - camEye());
  let w = max(S.p[7].y, 0.004) * 0.5;
  let dv = q.vel.xyz * 0.03;
  let d = dv - fwd * dot(dv, fwd);
  let hl = length(d) * 0.5;
  let ax = select(normalize(cross(fwd, camUp())), d / max(2.0 * hl, 1e-6), hl > 1e-5);
  let side = normalize(cross(fwd, ax));
  let u = qu(vi) * 2.0 - 1.0;
  let v = qv(vi) * 2.0 - 1.0;
  let wp = c + ax * u * (hl + w) + side * v * w;
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(u * (hl + w) / w, v, 0.0, 0.0);
  o.b = vec4f(hl / w, q.vel.w, b, sat(energy));
  o.c = vec4f(h.y, 0.0, 0.0, 0.0);
  return o;
}
fn fs_bass_dust(in: LOut) -> vec4f {
  let dx = max(abs(in.a.x) - in.b.x, 0.0);
  let d = dx * dx + in.a.y * in.a.y;
  if (d > 1.0) { discard; }
  let k = exp(-d * 4.0) * in.b.z / (1.0 + in.b.x * 0.3);
  // Resting threads are neutral; pushed dust takes the colour of the bass note that pushed it.
  let col = mix(palL(S.p[3].x + 0.5, 0.55), palL(S.p[3].x + pitchHue(in.b.y) * 0.55 + 0.12, 1.0), in.b.w);
  return glowOut(col * k * S.p[3].y * 0.5, in.wp);
}
`,
} satisfies LayerDef;
