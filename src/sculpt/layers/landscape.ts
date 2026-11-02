import type { LayerDef } from '../layer';

const GT = 192;
const GP = 64;

/**
 * A harmony landscape: the layout's score surface (the ground under a road, the wall of a tunnel,
 * the treads of a stair) as a mesh whose relief is everything sounding at each moment and pitch,
 * raised gently toward the melody. Every semitone is a fine line along time that glows only where
 * that pitch sounds, so each partial, chord tone and slide is drawn exactly, like a lit piano roll
 * you travel over; the melody burns brightest as it crosses the playhead.
 */
export default {
  id: 'landscape',
  role: 'world',
  source: 'once',
  verts: GT * GP * 6,
  blend: 'opaque',
  weight: 0.3,
  // Only as a tunnel wall: on open roads it reads as a plain slab.
  layouts: ['helix'],
  wgsl: /* wgsl */ `
/** Score smoothed over neighbouring semitones and ~0.1 s, so the relief reads as harmony, not grain. */
fn landScore(dt: f32, pitch: f32) -> vec4f {
  var s = score(dt, pitch) * 2.0;
  for (var k = 1; k <= 2; k++) {
    let o = f32(k);
    s += (score(dt, pitch - o) + score(dt, pitch + o) + score(dt - 0.06 * o, pitch) + score(dt + 0.06 * o, pitch)) * (1.0 / o);
  }
  return s / 8.0;
}
/** Direction from the surface toward the music above it (up on a road, inward in a tunnel). */
fn landRise(t: f32, pitch: f32) -> vec3f { return normalize(L(t, pitch, 0.0) - L(t, pitch, SURFACE_LANE) + vec3f(0.0, 1e-4, 0.0)); }
fn landPos(t: f32, pitch: f32) -> vec3f {
  let s = landScore(t - F.songTime, pitch);
  let base = L(t, pitch, SURFACE_LANE);
  // Relief stays under half the gap to the melody, so the land never swallows the notes above it.
  let amp = min(S.p[3].w, 0.45 * length(L(t, pitch, 0.0) - base));
  return base + landRise(t, pitch) * amp * (s.r * 0.6 + s.g * 0.35 + s.b * 0.3);
}
fn vs_landscape(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = vi / 6u;
  let cc = vi % 6u;
  let it = q % ${GT}u;
  let ip = q / ${GT}u;
  let ft = (f32(it) + qu(cc)) / ${GT}.0;
  let fp = (f32(ip) + qv(cc)) / ${GP}.0;
  let t = F.songTime - worldPast() + ft * (worldPast() + S.p[1].y);
  // 66 semitones: exactly one turn of the helix tunnel, so its wall closes.
  let pitch = S.p[0].z - 33.0 + fp * 66.0;
  let p = landPos(t, pitch);
  var n = normalize(cross(landPos(t, pitch + 0.5) - p, landPos(t + 0.05, pitch) - p));
  if (dot(n, landRise(t, pitch)) < 0.0) { n = -n; }
  o.pos = toClip(p);
  o.wp = p;
  o.nrm = n;
  o.a = vec4f(t - F.songTime, pitch, 0.0, 0.0);
  return o;
}
fn fs_landscape(in: LOut) -> vec4f {
  let dt = in.a.x;
  let pitch = in.a.y;
  // Semitone lines, anti-aliased; where they get thinner than a pixel they merge into a soft glow.
  let aa = max(fwidth(pitch), 1e-3);
  let pc = floor(pitch + 0.5);
  let line = sat((0.06 + aa - abs(pitch - pc)) / aa);
  let k = mix(line, 0.2, sat(aa * 2.5 - 0.3));
  let s = score(dt, pc);
  let ch = chordAtT(dt);
  let gr = gridAt(dt);
  let base = palL(S.p[3].x + pitchHue(ch.x * 13.0 - 1.0) * 0.55 + 0.5, 0.05 + 0.03 * ch.y);
  let now = exp(-abs(dt) * 4.0);
  let lit = playLight(dt);
  let col = palL(S.p[3].x + pitchHue(pc) * 0.55, 1.0);
  let emis = col * k * (s.r * 1.1 * lit + s.g * (0.5 * lit + 3.0 * now)) * S.p[3].y + F.pal3.rgb * pow(gr.y, 24.0) * 0.08;
  return vec4f(shade(base, emis, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
