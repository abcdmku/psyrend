import type { LayerDef } from '../layer';

const MAXD = 4; // 4^4 = 256 sub-segments per melodic step

/**
 * The lead melody as a Koch coastline. Each melodic step (one lead note to the next, or a held
 * note to its release) is a Koch curve: the bumps rise on upward steps and dip on downward ones,
 * sharpen with the size of the leap, and recurse one level deeper for each of: a note longer than
 * a short tap, a held note (over a beat), a strong note, a leap of a fourth or more, an arpeggio. Ahead of the playhead the line is nearly flat; it crystallises into its full fractal as
 * the playhead crosses it, then glows and fades.
 */
export default {
  id: 'koch-melody',
  role: 'fractal',
  source: 'notes',
  verts: 4 ** MAXD * 6,
  blend: 'additive',
  weight: 0.7,
  layouts: '*',
  wgsl: /* wgsl */ `
/** Koch crystallisation at song time t: flat ahead, full at and behind the playhead. */
fn koch_melody_amp(t: f32) -> f32 { return mix(1.0, 0.18, smoothstep(0.0, 2.5, t - F.songTime)); }
/** A point on the step from pitch pA to pB at time t: blends positions, not pitches (layouts may map pitch non-linearly). */
fn koch_melody_base(t: f32, pA: f32, pB: f32, x: f32) -> vec3f { return mix(L(t, pA, 0.0), L(t, pB, 0.0), x); }

fn vs_koch_melody(vi: u32, ii: u32) -> LOut {
  let n = notes[ii];
  if (n.role > 0.5) { return hidden(); }
  if (n.start > F.songTime + S.p[1].y || n.end < F.songTime - S.p[1].x - 1.0) { return hidden(); }
  let s = vi / 6u;
  let cc = vi % 6u;

  // Next lead note: a legato step joins the two pitches, otherwise the note holds flat to its end.
  var tB = n.end;
  var pB = n.pitch;
  for (var j = ii + 1u; j < ii + 32u; j++) {
    let m = notes[j];
    if (m.start < n.start || m.start > n.end + 0.35) { break; }
    if (m.role < 0.5 && m.start > n.start + 0.02) {
      tB = m.start;
      pB = m.pitch;
      break;
    }
  }
  let iv = pB - n.pitch;
  let beat = 60.0 / max(F.bpm, 40.0);
  let held = n.end - n.start > beat;
  let depth = clamp(1u + u32(n.end - n.start > beat * 0.4) + u32(n.arp > 0.5) + u32(n.strength > 0.6) + u32(held) + u32(abs(iv) >= 5.0), 1u, ${MAXD}u);
  if (s >= (1u << (2u * depth))) { return hidden(); }
  let h = select(-1.0, 1.0, iv >= 0.0) * (0.16 + 0.032 * min(abs(iv), 7.0));

  // Sub-segment s of the Koch curve on the unit base (0,0)-(1,0).
  var P = vec2f(0.0, 0.0);
  var Q = vec2f(1.0, 0.0);
  for (var l = 0u; l < depth; l++) {
    let dg = (s >> (2u * (depth - 1u - l))) & 3u;
    let v = Q - P;
    let apex = P + v * 0.5 + vec2f(-v.y, v.x) * h;
    var g = array<vec2f, 5>(P, P + v / 3.0, apex, P + v * (2.0 / 3.0), Q);
    P = g[dg];
    Q = g[dg + 1u];
  }

  let A0 = L(n.start, n.pitch, 0.0);
  let B0 = L(tB, pB, 0.0);
  let span = length(B0 - A0);
  let tng = normalize(B0 - A0 + vec3f(0.0, 1e-5, 1e-5));
  let tP = mix(n.start, tB, P.x);
  let tQ = mix(n.start, tB, Q.x);
  let bP = koch_melody_base(tP, n.pitch, pB, P.x);
  let bQ = koch_melody_base(tQ, n.pitch, pB, Q.x);
  let sideP = normalize(cross(tng, camEye() - bP));
  let sideQ = normalize(cross(tng, camEye() - bQ));
  let a = bP + sideP * P.y * span * koch_melody_amp(tP);
  let b = bQ + sideQ * Q.y * span * koch_melody_amp(tQ);
  let p = mix(a, b, qu(cc));
  let wp = stripPoint(a, b, qu(cc), qv(cc), lineW(p) * 1.0);
  var o: LOut;
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(mix(tP, tQ, qu(cc)), mix(n.pitch, pB, mix(P.x, Q.x, qu(cc))), qv(cc), 0.0);
  o.b = vec4f(n.start, n.end, n.strength, f32(depth));
  return o;
}
fn fs_koch_melody(in: LOut) -> vec4f {
  let dt = in.a.x - F.songTime;
  let attack = step(in.b.x, F.songTime) * exp(-(F.songTime - in.b.x) * 4.0);
  let sounding = step(in.b.x, F.songTime) * step(F.songTime, in.b.y);
  let col = palL(S.p[3].x + pitchHue(in.a.y) * 0.55 + 0.05, 1.0);
  let k = (playLight(dt) * (0.7 + 1.2 * sounding) + 2.0 * attack) * (0.5 + in.b.z) * S.p[3].y * 1.2;
  return glowOut(col * k, in.wp);
}
`,
} satisfies LayerDef;
