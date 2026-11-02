import type { LayerDef } from '../layer';

const GT = 220;
const GV = 12;

/**
 * The space between melody and bass as a lofted sheet: at every moment a vaulted span runs from
 * the bass line to the lead line, arching higher the wider the interval. Lines along the sheet sit
 * on the semitones of the sounding chord that fall between the two voices, so the harmony filling
 * the interval reads as a staff. Lead and bass attacks light the sheet from their own edge, and
 * when a voice falls silent the sheet folds onto the voice that remains.
 */
export default {
  id: 'melody-sheet',
  role: 'world',
  source: 'once',
  verts: GT * GV * 6,
  blend: 'opaque',
  // Off in auto-direction: as a world it reads as a large abstract object, not as a place.
  weight: 0,
  // Tested in road, river, spiral and staircase; in converge/helix the sheet fills the frame.
  layouts: ['road', 'river', 'spiral', 'staircase'],
  wgsl: /* wgsl */ `
/** Lead or bass at dt, smoothed over ~0.3 s: (midi, presence). The pitch is exact through silence edges. */
fn melody_sheet_voice(dt: f32, bassSel: bool) -> vec2f {
  var sp = 0.0;
  var ss = 0.0;
  for (var k = -3; k <= 3; k++) {
    let w = 4.0 - f32(abs(k));
    let c = scoreEvents(dt + f32(k) * 0.05, 3.0);
    let v = select(c.xy, c.zw, bassSel);
    sp += v.x * w;
    ss += v.y * w;
  }
  return vec2f(28.0 + 72.0 * sp / max(ss, 1e-4), ss / 16.0);
}
/** Sheet ends at song time t: (bass midi, lead midi, bass lane, lead lane). A missing voice folds onto the other. */
fn melody_sheet_ends(t: f32) -> vec4f {
  let dt = t - F.songTime;
  let l = melody_sheet_voice(dt, false);
  let b = melody_sheet_voice(dt, true);
  let wl = smoothstep(0.08, 0.6, l.y);
  let wb = smoothstep(0.08, 0.6, b.y);
  let sw = max(wl + wb, 1e-4);
  let cp = select(S.p[0].z, (l.x * wl + b.x * wb) / sw, wl + wb > 1e-3);
  let cl = -wb / sw;
  return vec4f(mix(cp, b.x, wb), mix(cp, l.x, wl), mix(cl, -1.0, wb), mix(cl, 0.0, wl));
}
fn melody_sheet_pos(t: f32, v: f32, e: vec4f) -> vec3f {
  let pa = L(t, e.x, e.z);
  let pb = L(t, e.y, e.w);
  let pm = mix(pa, pb, 0.5);
  let along = L(t + 0.05, mix(e.x, e.y, 0.5), mix(e.z, e.w, 0.5)) - pm;
  let span = pb - pa;
  let nb = cross(along, span);
  let nl = length(nb);
  // The vault: arch height grows with the span (the interval).
  let bulge = select(vec3f(0.0), nb / max(nl, 1e-6), nl > 1e-6) * sin(PI * v) * length(span) * 0.22;
  return mix(pa, pb, v) + bulge;
}
fn vs_melody_sheet(vi: u32, ii: u32) -> LOut {
  var o: LOut;
  let q = vi / 6u;
  let cc = vi % 6u;
  let it = q % ${GT}u;
  let iv = q / ${GT}u;
  let ft = (f32(it) + qu(cc)) / ${GT}.0;
  let v = (f32(iv) + qv(cc)) / ${GV}.0;
  let t = F.songTime - worldPast() + ft * (worldPast() + S.p[1].y);
  let e = melody_sheet_ends(t);
  let e2 = melody_sheet_ends(t + 0.04);
  let p = melody_sheet_pos(t, v, e);
  let pt = melody_sheet_pos(t + 0.04, v, e2);
  let pv = melody_sheet_pos(t, v + 0.02, e);
  let n = cross(pt - p, pv - p);
  o.pos = toClip(p);
  o.wp = p;
  o.nrm = select(LUp(t), n / max(length(n), 1e-6), length(n) > 1e-7);
  o.a = vec4f(t - F.songTime, v, e.y, e.x);
  return o;
}
fn fs_melody_sheet(in: LOut) -> vec4f {
  let dt = in.a.x;
  let v = in.a.y;
  let lead = in.a.z;
  let bass = in.a.w;
  let pitch = mix(bass, lead, v);
  let fw = max(fwidth(pitch), 1e-4);
  // How fast the pitch under this fragment moves in time (screen derivatives solved for d/dt at
  // fixed v): chord-tone lines only run where the voices hold, so glides don't hatch the sheet.
  let gx = vec3f(dpdx(dt), dpdx(v), dpdx(pitch));
  let gy = vec3f(dpdy(dt), dpdy(v), dpdy(pitch));
  let det = gx.x * gy.y - gx.y * gy.x;
  let rate = select(0.0, abs((gx.z * gy.y - gx.y * gy.z) / det), abs(det) > 1e-12);
  let steady = 1.0 - smoothstep(3.0, 9.0, rate);
  let iv = abs(lead - bass);
  // Chord tones inside the interval as lines of constant pitch (root brightest).
  let ch = chordAtT(dt);
  let root = floor(ch.x * 13.0 - 0.5);
  let pr = floor(pitch + 0.5);
  let rel = fmod(pr - root, 12.0);
  let third = select(3.0, 4.0, ch.y > 0.75);
  let fifth = select(7.0, 6.0, ch.y < 0.4);
  var tone = 0.0;
  if (root >= 0.0 && ch.y > 0.1) {
    tone = select(0.0, 1.0, rel < 0.5) + select(0.0, 0.65, abs(rel - third) < 0.5) + select(0.0, 0.45, abs(rel - fifth) < 0.5);
  }
  let hw = max(0.045, fw * 0.75);
  let line = tone * (1.0 - smoothstep(hw - fw * 0.5, hw + fw * 0.5, abs(pitch - pr))) * step(0.5, iv) * steady;
  // Attacks light the sheet from the voice that played them.
  let att = score(dt, lead).a * v * v + score(dt, bass).a * (1.0 - v) * (1.0 - v);
  let ivc = fmod(floor(iv + 0.5), 12.0);
  let body = palL(S.p[3].x + pitchHue(ivc) * 0.55 + 0.5, 0.26);
  let toneCol = palL(S.p[3].x + pitchHue(pr) * 0.55, 1.0);
  let lit = playLight(dt);
  let now = exp(-abs(dt) * 5.0);
  var emis = toneCol * line * (0.35 + 1.4 * lit) + body * (0.12 * lit + 0.25 * now) + palL(S.p[3].x + pitchHue(lead) * 0.55, 1.0) * att * 2.2;
  emis *= S.p[3].y;
  var n = normalize(in.nrm);
  if (dot(n, camEye() - in.wp) < 0.0) { n = -n; }
  return vec4f(shade(body, emis, n, in.wp), 1.0);
}
`,
} satisfies LayerDef;
