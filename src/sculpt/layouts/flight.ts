import type { Block, LayoutBlock } from '../blocks';

/**
 * Flight: time runs along the melodic gesture (see gestAt): the path the melody steers. Rising
 * intervals climb, falling ones dive, the harmony banks the path into its own plane, rests fly
 * straight. Everything placed by L() rides that path, offset across it by pitch and above it by
 * role, so the space itself is shaped by the melody rather than laid out as a score.
 *
 * S.p[4]: x = across-path spread of pitch.
 */
const layout: LayoutBlock = {
  id: 'flight',
  kind: 'travel',
  weight: 1.6,
  surface: -1.7,
  cameras: ['flight-chase', 'flight-chase', 'flight-wing', 'flight-ride'],
  wgsl: /* wgsl */ `
fn fl_scale() -> f32 { return S.p[0].x * 0.8; }
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  let g = gestAt(t);
  let right = normalize(cross(g.fwd.xyz, g.up.xyz));
  return g.pos.xyz * fl_scale() + right * (pitch - S.p[0].z) * S.p[0].y * (0.5 + 0.3 * S.p[4].x) + g.up.xyz * lane * S.p[0].w;
}
fn LCenter(t: f32) -> vec3f { return gestAt(t).pos.xyz * fl_scale(); }
fn LUp(t: f32) -> vec3f { return gestAt(t).up.xyz; }
/** The path's up, averaged over two seconds so the camera banks with the harmony but never twitches. */
fn fl_upSmooth(t: f32) -> vec3f {
  var u = vec3f(0.0);
  for (var i = -2; i <= 2; i++) { u += gestAt(t + f32(i) * 0.5).up.xyz; }
  return normalize(u + vec3f(0.0, 1e-3, 0.0));
}
/** Where the path is heading over the next few seconds (a smoothed look target). */
fn fl_ahead(t: f32, span: f32) -> vec3f {
  var p = vec3f(0.0);
  for (var i = 1; i <= 4; i++) { p += LCenter(t + span * f32(i) * 0.25); }
  return p * 0.25;
}`,
};

const cameras: Record<string, Block> = {
  // Behind and above the playhead, banking with the harmony, looking down the coming melody.
  'flight-chase': {
    id: 'flight-chase',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f { let t = F.songTime - S.p[2].x * 0.8; return LCenter(t) + fl_upSmooth(t) * (0.6 + S.p[2].y); }
fn camTarget() -> vec3f { return fl_ahead(F.songTime, S.p[2].z * 0.8); }
fn camUp() -> vec3f { return normalize(mix(fl_upSmooth(F.songTime), vec3f(0.0, 1.0, 0.0), 0.35)); }`,
  },
  // Riding the melody itself, just behind the playhead: every climb and dive is felt.
  'flight-ride': {
    id: 'flight-ride',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f { let t = F.songTime - 0.6; return LCenter(t) + fl_upSmooth(t) * 0.35; }
fn camTarget() -> vec3f { return fl_ahead(F.songTime, 3.0) + fl_upSmooth(F.songTime) * 0.2; }
fn camUp() -> vec3f { return fl_upSmooth(F.songTime); }`,
  },
  // Alongside: the melody's flight seen in profile, so its climbs and dives draw against the sky.
  'flight-wing': {
    id: 'flight-wing',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f {
  let t = F.songTime + 0.5;
  let u = fl_upSmooth(t);
  let f = normalize(fl_ahead(t, 2.0) - LCenter(t - 2.0));
  let side = normalize(cross(f, u));
  return LCenter(t) + side * (4.0 + S.p[2].y * 2.0) * sign(S.p[2].w + 1e-3) + u * (0.8 + S.p[2].y * 0.5) - f * 1.5;
}
fn camTarget() -> vec3f { return LCenter(F.songTime + 1.0); }
fn camUp() -> vec3f { return normalize(mix(fl_upSmooth(F.songTime), vec3f(0.0, 1.0, 0.0), 0.5)); }`,
  },
  // Journeys: one camera for the whole song whose character follows the section (journey channels
  // 12 ride and 13 wing, eased over bars): chase through verses, ride the melody at peaks, drift
  // alongside in breakdowns.
  'flight-journey': {
    id: 'flight-journey',
    wgsl: /* wgsl */ `
fn fj_w() -> vec3f {
  let ride = sat(journeyAt(12u, F.songTime));
  let wing = sat(journeyAt(13u, F.songTime));
  return vec3f(max(0.0, 1.0 - ride - wing), ride, wing);
}
fn fj_wingEye() -> vec3f {
  let t = F.songTime + 0.5;
  let u = fl_upSmooth(t);
  let f = normalize(fl_ahead(t, 2.0) - LCenter(t - 2.0));
  let side = normalize(cross(f, u));
  return LCenter(t) + side * (4.0 + S.p[2].y * 2.0) * sign(S.p[2].w + 1e-3) + u * (0.8 + S.p[2].y * 0.5) - f * 1.5;
}
fn camEye() -> vec3f {
  let w = fj_w();
  let tc = F.songTime - S.p[2].x * 0.8;
  let chase = LCenter(tc) + fl_upSmooth(tc) * (0.6 + S.p[2].y);
  let ride = LCenter(F.songTime - 0.6) + fl_upSmooth(F.songTime - 0.6) * 0.35;
  return chase * w.x + ride * w.y + fj_wingEye() * w.z;
}
fn camTarget() -> vec3f {
  let w = fj_w();
  return fl_ahead(F.songTime, S.p[2].z * 0.8) * w.x + (fl_ahead(F.songTime, 3.0) + fl_upSmooth(F.songTime) * 0.2) * w.y + LCenter(F.songTime + 1.0) * w.z;
}
fn camUp() -> vec3f {
  let w = fj_w();
  let u = fl_upSmooth(F.songTime);
  // Bank only partly with the path: enough to feel the harmony tilt the flight, not enough to list.
  return normalize(mix(u, vec3f(0.0, 1.0, 0.0), 0.7 * w.x + 0.45 * w.y + 0.8 * w.z));
}`,
  },
};

export default { layout, cameras };
