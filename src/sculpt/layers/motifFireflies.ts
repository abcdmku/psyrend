import type { LayerDef } from '../layer';

const N = 32768;

/**
 * Melody as fireflies that know where the music goes. Each note of a recurring motif releases a
 * cloud of fireflies in the motif's colour. They rise from the note and fly ahead to the place the
 * same note of the same motif will sound next (the whole song is known), and wait there, breathing
 * with the beat. When the playhead reaches it they flash with the note and fly on to the following
 * recurrence, so a motif's swarm grows and hops through the song with it, and its shape is the
 * motif's contour. Other lead notes release a smaller cloud in their pitch colour that waits where
 * the melody next returns to that pitch. A note that does not return leaves its fireflies to linger
 * and fade.
 */
export default {
  id: 'motif-fireflies',
  role: 'particles',
  source: 'particles',
  particles: N,
  verts: 6,
  blend: 'additive',
  weight: 0.6,
  layouts: '*',
  wgsl: /* wgsl */ `
fn motif_fireflies_anchor(idx: u32) -> vec3f {
  let n = notes[idx];
  return L(n.start, n.pitch, roleLane(u32(n.role + 0.5)));
}
/**
 * Where note idx returns next in the window (idx if it doesn't): for a motif note, the same note of
 * the motif's next instance; for any other lead note, the lead's next note on the same pitch.
 */
fn motif_fireflies_next(idx: u32) -> u32 {
  let n = notes[idx];
  let end = u32(W.n.x) + u32(W.n.y);
  let isMotif = n.motif >= 0.0;
  var k = idx + 1u;
  loop {
    if (k >= end) { break; }
    let m = notes[k];
    let same = select(m.role < 0.5 && abs(m.pitch - n.pitch) < 0.5, abs(m.motif - n.motif) < 0.5 && abs(m.motifPos - n.motifPos) < 0.5, isMotif);
    if (same && m.start > n.start + 0.3) { return k; }
    k += 1u;
  }
  return idx;
}
/** Seconds a firefly takes to fly from its note to the next recurrence. */
fn motif_fireflies_flight(q: Particle, h: f32) -> f32 {
  return clamp((notes[u32(q.pos.y)].start - q.pos.z) * 0.45, 0.5, 2.2) * (0.7 + 0.6 * h);
}
fn motif_fireflies_pos(i: u32, q: Particle, t: f32) -> vec3f {
  let src = u32(q.pos.x);
  let tgt = u32(q.pos.y);
  let h0 = hashU(i * 5u + 1u);
  let h1 = hashU(i * 5u + 2u);
  let h2 = hashU(i * 5u + 3u);
  let ps = motif_fireflies_anchor(src);
  var base = ps;
  var u = 1.0;
  if (tgt != src) {
    let pt = motif_fireflies_anchor(tgt);
    u = smoothstep(0.0, 1.0, (t - q.pos.z) / motif_fireflies_flight(q, h0));
    let up = LUp(notes[src].start);
    let ctrl = (ps + pt) * 0.5 + up * (length(pt - ps) * 0.25 + S.p[0].w * 0.5);
    base = mix(mix(ps, ctrl, u), mix(ctrl, pt, u), u);
  }
  // Each firefly loops its own slow figure around the note it waits for.
  let rho = max(S.p[0].w, 0.3) * (0.12 + 0.45 * sqrt(h1)) * sat((t - q.pos.z) * 2.0 + 0.15);
  let w = vec3f(0.31 + 0.4 * h0, 0.23 + 0.5 * h2, 0.37 + 0.3 * h1) * TAU * 0.5;
  let ph = vec3f(h0, h1, h2) * TAU * 3.0;
  let loopP = sin(w * t + ph) * vec3f(1.0, 0.7, 1.0);
  return base + loopP * rho * (1.0 + 0.8 * sin(PI * u));
}
fn sim_motif_fireflies(i: u32, p: ptr<function, Particle>) {
  let now = W.h.z;
  let dt = W.h.w;
  let q = *p;
  let total = arrayLength(&notes);
  let src = u32(q.pos.x);
  let tgt = u32(q.pos.y);
  let alive = q.pos.w > now && q.pos.w < now + 40.0 && src < total && tgt < total && notes[src].start < now + 0.5;
  if (!alive) {
    (*p).pos.w = 0.0;
    let cnt = u32(W.n.y);
    if (cnt == 0u) { return; }
    let seed = pcg(i * 9781u + u32(F.frame) * 6271u);
    let k = u32(W.n.x) + seed % cnt;
    let n = notes[k];
    let age = now - n.start;
    // ~120 fireflies per motif note and ~35 per other lead note, frame-rate independent.
    let chance = 480.0 * f32(cnt) * dt / ${N}.0 * select(0.3, 1.0, n.motif >= 0.0);
    if (n.role > 0.5 || age < 0.0 || age > 0.25 || hashU(seed + 1u) > chance) { return; }
    let nx = motif_fireflies_next(k);
    (*p).pos = vec4f(f32(k), f32(nx), now, select(notes[nx].start + 2.5, now + 2.0 + hashU(seed + 2u) * 1.5, nx == k));
    (*p).vel = vec4f(0.0, 0.0, 0.0, 0.0);
    return;
  }
  if (tgt != src && now > notes[tgt].start + 0.12) {
    // Landed with the note: fly on to the motif's next return, or linger and fade.
    let hops = q.vel.x + 1.0;
    let nx = motif_fireflies_next(tgt);
    if (nx != tgt && hops < select(2.0, 4.0, notes[tgt].motif >= 0.0)) {
      (*p).pos = vec4f(f32(tgt), f32(nx), now, notes[nx].start + 2.5);
    } else {
      (*p).pos = vec4f(f32(tgt), f32(tgt), now, now + 2.0 + hashU(i) * 1.5);
    }
    (*p).vel.x = hops;
  }
}
fn vs_motif_fireflies(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = pstate_motif_fireflies[ii];
  let now = W.h.z;
  if (q.pos.w <= now || q.pos.w > now + 40.0) { return hidden(); }
  let c = motif_fireflies_pos(ii, q, now);
  let vw = c - motif_fireflies_pos(ii, q, now - 0.03);
  let src = u32(q.pos.x);
  let tgt = u32(q.pos.y);
  // Brightness: rise in, breathe with the beat while waiting, flash as the awaited note sounds.
  var b = sat((now - q.pos.z) * 3.0) * sat((q.pos.w - now) / 1.2);
  var flash = 0.0;
  if (tgt != src) {
    let a = now - notes[tgt].start;
    flash = select(0.0, exp(-a * 6.0) * 4.0, a >= 0.0);
  } else {
    flash = exp(-(now - q.pos.z) * 5.0) * 3.0 * select(0.0, 1.0, q.vel.x > 0.5);
  }
  // Each firefly blinks once every two beats at its own phase: a shimmer locked to the tempo.
  let blink = pow(0.5 + 0.5 * cos(TAU * (W.h.z * max(F.bpm, 40.0) / 120.0 + hashU(ii * 5u + 4u))), 8.0);
  b *= 0.2 + 0.9 * blink + 0.25 * gridAt(0.0).x + flash;
  let fwd = normalize(c - camEye());
  let w = max(S.p[7].y, 0.004) * 2.0;
  let d = vw - fwd * dot(vw, fwd);
  let hl = length(d) * 0.5;
  let ax = select(normalize(cross(fwd, camUp())), d / max(2.0 * hl, 1e-6), hl > 1e-5);
  let side = normalize(cross(fwd, ax));
  let u = qu(vi) * 2.0 - 1.0;
  let v = qv(vi) * 2.0 - 1.0;
  let wp = c + ax * u * (hl + w) + side * v * w;
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(u * (hl + w) / w, v, 0.0, 0.0);
  o.b = vec4f(hl / w, notes[src].motif, b, flash);
  o.c = vec4f(notes[src].pitch, 0.0, 0.0, 0.0);
  return o;
}
fn fs_motif_fireflies(in: LOut) -> vec4f {
  let dx = max(abs(in.a.x) - in.b.x, 0.0);
  let d = dx * dx + in.a.y * in.a.y;
  if (d > 1.0) { discard; }
  // A hot core inside a soft halo: fireflies, not dust.
  let k = (exp(-d * 9.0) + 0.25 * exp(-d * 2.5)) * in.b.z / (1.0 + in.b.x * 0.3);
  // Motif swarms share the motif colour (as the notes layer does); echoes keep their pitch colour.
  let hue = select(S.p[3].x + pitchHue(in.c.x) * 0.55, fract(in.b.y * 0.618 + S.p[3].x), in.b.y >= 0.0);
  let col = mix(palL(hue, 1.0), vec3f(1.0), sat(in.b.w * 0.2));
  return glowOut(col * k * S.p[3].y * 1.1, in.wp);
}
`,
} satisfies LayerDef;
