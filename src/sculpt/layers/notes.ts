import type { LayerDef } from '../layer';

const SEG = 24;
const SIDES = 6;
const KINDS = ['tube', 'ribbon', 'line', 'beads'] as const;

/**
 * Every transcribed note as a stroke at its exact time and pitch. Lead, bass and harmony voices
 * each get a drawing kind (tube / ribbon / line / beads, or hidden). Strokes swell while they
 * sound, ignite at their attack, and motif notes share a hue so returning motifs are recognisable.
 * Lead and bass are drawn as connected lines: a legato note glides into the next note of its voice,
 * and while it is held the stroke follows the sung pitch, so bends, slides and vibrato are visible.
 */
export default {
  id: 'notes',
  role: 'hero',
  source: 'notes',
  verts: SEG * SIDES * 6,
  blend: 'opaque',
  // Literal: an occasional accent, never the default protagonist.
  weight: 0.15,
  layouts: '*',
  consts(rand) {
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length) % xs.length];
    // The lead is always a continuous line so the melody can be followed; harmony voices are
    // often left to the harmony layers, which keeps the frame readable.
    const lead = pick([0, 2, 2]);
    const bass = pick([0, 2, 2, 9]);
    const poly = pick([9, 9, 2]);
    return {
      wgsl: `const LEAD_KIND: u32 = ${lead}u;\nconst BASS_KIND: u32 = ${bass}u;\nconst POLY_KIND: u32 = ${poly}u;`,
      key: `${KINDS[lead] ?? 'off'}-${KINDS[bass] ?? 'off'}-${KINDS[poly] ?? 'off'}`,
    };
  },
  wgsl: /* wgsl */ `
fn noteKind(role: u32) -> u32 { return select(select(POLY_KIND, BASS_KIND, role == 1u), LEAD_KIND, role == 0u); }

/** The line's pitch at t: the held note plus its inflection, then a glide into the next note. */
fn notes_pitchAt(n: Note, role: u32, t: f32) -> f32 {
  if (t > n.end) {
    let g = sat((t - n.end) / max(n.glide - n.end, 1e-3));
    return mix(n.pitch, n.nextPitch, g * g * (3.0 - 2.0 * g));
  }
  if (role > 1u) { return n.pitch; }
  // Inflection from the continuous pitch track, averaged over ~0.25 s: slides and bends show,
  // tracking grain doesn't.
  var sum = 0.0;
  var k = 0.0;
  for (var j = -2; j <= 2; j++) {
    let dt = t - F.songTime + f32(j) * 0.06;
    let s = select(bassAt(dt), leadAt(dt), role == 0u);
    if (s.y > 0.5 && abs(s.x - n.pitch) < 1.2) { sum += s.x - n.pitch; k += 1.0; }
  }
  return n.pitch + select(0.0, clamp(sum / max(k, 1.0), -0.6, 0.6), k > 2.5);
}

fn vs_notes(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let n = notes[ii];
  let role = u32(n.role + 0.5);
  let kind = noteKind(role);
  if (kind == 9u) { return hidden(); }
  let lane = roleLane(role);
  let t0 = max(n.start, F.songTime - S.p[1].x);
  let joined = n.glide > n.end + 1e-3;
  let t1 = min(n.glide, F.songTime + S.p[1].y);
  if (t1 <= t0) { return hidden(); }
  let quad = vi / 6u;
  let c = vi % 6u;
  let rBase = select(select(S.p[1].z * 0.4, S.p[1].w, role == 1u), S.p[1].z, role == 0u) * (0.55 + 0.6 * n.strength);
  o.b = vec4f(f32(role), n.motif, n.arp, n.strength);
  o.c = vec4f(n.start, n.end, n.pitch, f32(kind));
  if (kind == 3u) {
    // Beads: one camera-facing sphere at the note's attack.
    if (quad > 0u || n.start < F.songTime - S.p[1].x || n.start > F.songTime + S.p[1].y) { return hidden(); }
    let p = L(n.start, n.pitch, lane);
    let fwd = normalize(p - camEye());
    let rt = normalize(cross(fwd, camUp()));
    let up = cross(rt, fwd);
    let q = vec2f(qu(c) * 2.0 - 1.0, qv(c) * 2.0 - 1.0);
    let wp = p + (rt * q.x + up * q.y) * rBase * 2.2;
    o.pos = toClip(wp);
    o.wp = wp;
    o.nrm = -fwd;
    o.a = vec4f(q, n.start, 0.0);
    return o;
  }
  let sides = select(${SIDES}u, 1u, kind == 1u || kind == 2u);
  if (quad >= ${SEG}u * sides) { return hidden(); }
  let s = quad / sides;
  let k = quad % sides;
  let u = (f32(s) + qu(c)) / ${SEG}.0;
  let t = mix(t0, t1, u);
  let p = L(t, notes_pitchAt(n, role, t), lane);
  let tng = normalize(L(t + 0.02, notes_pitchAt(n, role, t + 0.02), lane) - p + vec3f(0.0, 0.0, 1e-5));
  // Rounded attack and release so every note is a well-formed stroke; it swells while sounding.
  // A joined note doesn't release: it thins into the glide and the next note's attack.
  let ua = (t - n.start) / max(n.end - n.start, 1e-3);
  let release = select(sqrt(sat((1.0 - ua) * 10.0)), 1.0 - 0.6 * sat((t - n.end) / max(n.glide - n.end, 1e-3)), joined);
  let taper = sqrt(sat(ua * 10.0)) * release;
  let sounding = step(n.start, F.songTime) * step(F.songTime, n.end);
  let r = rBase * max(taper, 0.08) * (1.0 + 0.35 * sounding);
  var wp: vec3f;
  if (kind == 0u) {
    let nx = frameX(t, tng);
    let ny = cross(nx, tng);
    let a = (f32(k) + qv(c)) / ${SIDES}.0 * TAU;
    let dir = nx * cos(a) + ny * sin(a);
    wp = p + dir * r;
    o.nrm = dir;
  } else {
    let toEye = camEye() - p;
    let side = normalize(cross(tng, toEye));
    // The lead's line is drawn bolder than the other voices: it is the line you follow.
    let w = select(r * 1.7, lineW(p) * (0.5 + n.strength) * select(1.0, 2.0, role == 0u), kind == 2u);
    wp = p + side * (qv(c) * 2.0 - 1.0) * w;
    o.nrm = normalize(toEye);
  }
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(u, qv(c), t, 0.0);
  return o;
}

fn fs_notes(in: LOut) -> vec4f {
  let role = u32(in.b.x + 0.5);
  let kind = u32(in.c.w + 0.5);
  var t = in.a.z;
  if (kind == 3u) {
    if (dot(in.a.xy, in.a.xy) > 1.0) { discard; }
    t = in.c.x;
  }
  let dt = t - F.songTime;
  let attack = step(in.c.x, F.songTime) * exp(-(F.songTime - in.c.x) * 6.0);
  let sounding = step(in.c.x, F.songTime) * step(F.songTime, in.c.y);
  var hue = S.p[3].x + pitchHue(in.c.z) * 0.55 + select(select(0.33, 0.6, role == 1u), 0.0, role == 0u);
  if (in.b.y >= 0.0) { hue = fract(in.b.y * 0.618 + S.p[3].x); }
  let col = palL(hue, select(0.7, 1.2, role == 0u));
  // Restrained emission: a sounding note brightens, but never blooms into a blob that hides its shape.
  var emis = col * (playLight(dt) * (1.0 + 1.2 * sounding) + attack * 1.5) * S.p[3].y * (0.5 + in.b.w);
  if (in.b.z > 0.5) { emis *= 1.0 + 1.5 * attack; }
  if (kind == 2u) { return vec4f(fogged(emis * 1.4, in.wp), 1.0); }
  return vec4f(shade(col, emis, normalize(in.nrm), in.wp), 1.0);
}
`,
} satisfies LayerDef;
