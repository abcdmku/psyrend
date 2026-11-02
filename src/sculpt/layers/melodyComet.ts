import type { LayerDef } from '../layer';

const N = 49152;
/** Seconds between a particle's rebirths: the comet emits N particles per CYCLE seconds. */
const CYCLE = 3.0;

/**
 * The lead line as a comet. Every particle is an emission from the lead at one instant of the
 * last few seconds: it is born on the melody at that moment's pitch and drifts slowly off it, so the
 * tail is the recent melody contour itself, widening with age. Note attacks and leaps throw the
 * dust wider; the tail leans away from the time axis like a comet's tail from its sun. Silence
 * leaves a gap in the tail. Emission is analytic in (particle, song time), so it is frame-rate
 * independent and survives seeking.
 */
export default {
  id: 'melody-comet',
  role: 'particles',
  source: 'particles',
  particles: N,
  verts: 6,
  blend: 'additive',
  weight: 0.25,
  layouts: '*',
  wgsl: /* wgsl */ `
fn melody_comet_row(r: i32) -> vec4f {
  return textureLoad(eventsTex, vec2i(3, clamp(r, 0, i32(F.scoreTexRows) - 1)), 0);
}
/** Lead (pitch, strength) at dt, smoothed over ~60 ms so leaps glide instead of tearing the tail. */
fn melody_comet_lead(dt: f32) -> vec2f {
  let f = F.scoreRow + dt * F.scoreRate;
  let r0 = i32(floor(f));
  var pw = 0.0;
  var pa = 0.0;
  var sa = 0.0;
  var wa = 0.0;
  for (var k = -2; k <= 3; k++) {
    let w = max(0.0, 1.0 - abs(f32(r0 + k) - f) / 2.5);
    let c = melody_comet_row(r0 + k);
    let on = select(0.0, 1.0, c.x > 0.001 && c.y > 0.02);
    pa += w * on * (28.0 + c.x * 72.0);
    pw += w * on;
    sa += w * on * c.y;
    wa += w;
  }
  if (pw < 1e-3 || F.scoreRows <= 0.0) { return vec2f(0.0); }
  return vec2f(pa / pw, sa / max(wa, 1e-3));
}
fn sim_melody_comet(i: u32, p: ptr<function, Particle>) {
  let now = W.h.z;
  let R = ${N}.0 / ${CYCLE};
  let kNow = i32(floor(now * R));
  let back = ((kNow - i32(i)) % ${N} + ${N}) % ${N};
  let k = kNow - back;
  let seed = pcg(u32(k) * 747796405u + 2891336453u);
  let tb = (f32(k) + hashU(seed)) / R;
  let age = max(now - tb, 0.0);
  let life = ${CYCLE} * (0.45 + 0.55 * hashU(seed + 1u));
  (*p).pos = vec4f(0.0);
  if (age > life || tb < 0.0) { return; }
  let ld = melody_comet_lead(tb - now);
  if (ld.y < 0.05) { return; }
  let pitch = ld.x;
  // The contour's direction at the emission: where the melody went next.
  let pa = melody_comet_lead(tb - now - 0.05);
  let pb = melody_comet_lead(tb - now + 0.05);
  let p0 = select(pitch, pa.x, pa.y > 0.0);
  let p1 = select(pitch, pb.x, pb.y > 0.0);
  let A = L(tb, pitch, 0.0);
  var T = (L(tb + 0.05, p1, 0.0) - L(tb - 0.05, p0, 0.0)) / 0.1;
  if (length(T) < 1e-4) { T = LCenter(tb + 0.05) - LCenter(tb - 0.05) + vec3f(0.0, 1e-4, 0.0); }
  let td = normalize(T);
  var out = A - LCenter(tb);
  if (length(out) < 1e-3) { out = LUp(tb); }
  out = normalize(out - td * dot(out, td) + LUp(tb) * 1e-3);
  let e1 = out;
  let e2 = normalize(cross(td, e1));
  // Attacks and leaps throw the dust wider; long tones leave a tight, bright filament.
  let atk = score(tb - now, pitch).a;
  let leap = min(abs(p1 - p0) / 7.0, 1.0);
  let unit = max(S.p[0].w, 0.3) * max(S.p[7].z, 0.3);
  let ang = hashU(seed + 2u) * TAU;
  let rad = sqrt(hashU(seed + 3u));
  let v0 = unit * (0.25 + 0.9 * atk + 0.6 * leap) * rad;
  let spread = (1.0 - exp(-age * 2.5)) / 2.5;
  let wind = unit * 0.3 * (0.5 + hashU(seed + 4u)) * age * age;
  let P = A + (e1 * cos(ang) + e2 * sin(ang)) * v0 * spread + e1 * wind;
  let fade = 1.0 - age / life;
  let b = ld.y * fade * fade * (0.35 + 0.65 * exp(-age * 5.0)) * (1.0 + atk);
  (*p).pos = vec4f(P, b);
  (*p).vel = vec4f(T * 0.045 * (0.4 + 0.6 * fade), pitch);
}
fn vs_melody_comet(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = pstate_melody_comet[ii];
  if (q.pos.w <= 0.002) { return hidden(); }
  let c = q.pos.xyz;
  let fwd = normalize(c - camEye());
  let w = max(S.p[7].y, 0.004) * 0.7;
  let d = q.vel.xyz - fwd * dot(q.vel.xyz, fwd);
  let h = length(d) * 0.5;
  let ax = select(normalize(cross(fwd, camUp())), d / max(2.0 * h, 1e-6), h > 1e-5);
  let side = normalize(cross(fwd, ax));
  let u = qu(vi) * 2.0 - 1.0;
  let v = qv(vi) * 2.0 - 1.0;
  let wp = c + ax * u * (h + w) + side * v * w;
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(u * (h + w) / w, v, 0.0, 0.0);
  o.b = vec4f(h / w, q.vel.w, q.pos.w, 0.0);
  return o;
}
fn fs_melody_comet(in: LOut) -> vec4f {
  let dx = max(abs(in.a.x) - in.b.x, 0.0);
  let d = dx * dx + in.a.y * in.a.y;
  if (d > 1.0) { discard; }
  let k = exp(-d * 4.0) * in.b.z / (1.0 + in.b.x * 0.35);
  // The head burns white-hot; the tail keeps the pitch colour.
  let col = mix(palL(S.p[3].x + pitchHue(in.b.y) * 0.55, 1.0), vec3f(1.0), sat(in.b.z - 0.7) * 0.6);
  return glowOut(col * k * S.p[3].y * 0.9, in.wp);
}
`,
} satisfies LayerDef;
