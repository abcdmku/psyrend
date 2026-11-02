import type { LayerDef } from '../layer';

const BRANCHES = 256; // heap indices 1..255: up to 8 levels of binary branching

/**
 * Melodic cells grown as L-system trees. A tree sprouts from every lead note that starts a phrase
 * (after a rest) or a detected motif. Its rule is the next four melodic intervals: level k branches
 * bend by the k-th interval (sign = up/down, size = leap), spread wider for bigger leaps, and
 * shorten by the k-th inter-onset ratio; the 4-interval rule repeats for finer twigs. The shape is a
 * pure function of the intervals, so a returning motif (at any transposition) regrows exactly the
 * same tree. Strong cells grow one level deeper; detected motifs deeper still with each return.
 * Levels 0-4 unfold and ignite as their notes sound, in the motif's hue when it has one.
 */
export default {
  id: 'motif-tree',
  role: 'fractal',
  source: 'notes',
  verts: BRANCHES * 6,
  blend: 'additive',
  weight: 0.7,
  layouts: '*',
  wgsl: /* wgsl */ `
fn motif_tree_dir(a: f32) -> vec2f { return vec2f(cos(a), sin(a)); }
/** Time at which tree level l ignites: the cell's notes, then a cascade of finer twigs. */
fn motif_tree_tLv(mt: array<f32, 5>, l: u32) -> f32 {
  var m = mt;
  if (l <= 4u) { return m[l]; }
  return m[4] + f32(l - 4u) * 0.09;
}

fn vs_motif_tree(vi: u32, ii: u32) -> LOut {
  let n = notes[ii];
  if (n.role > 0.5) { return hidden(); }
  if (n.start > F.songTime + S.p[1].y || n.start < F.songTime - S.p[1].x - 3.0) { return hidden(); }
  let b = vi / 6u + 1u;
  let cc = vi % 6u;
  let isMotif = n.motif >= 0.0;
  if (isMotif && n.motifPos > 0.5) { return hidden(); }

  // A cell starts at the first lead note of each bar, after a rest of a beat, or at a motif's first note.
  let beat = 60.0 / max(F.bpm, 40.0);
  if (!isMotif) {
    let bar = beat * 4.0;
    let grid0 = F.songTime - F.barPhase * bar;
    var prev = -1e9;
    var prevEnd = -1e9;
    for (var j = 1u; j <= 48u && j <= ii; j++) {
      let m = notes[ii - j];
      if (m.start < n.start - 8.0) { break; }
      if (m.role < 0.5) { prev = m.start; prevEnd = m.end; break; }
    }
    let newBar = floor((n.start - grid0) / bar + 0.02) > floor((prev - grid0) / bar + 0.02);
    if (!newBar && n.start - prevEnd < beat) { return hidden(); }
  }

  // The cell: this note and the next four lead notes.
  var mp = array<f32, 5>(n.pitch, n.pitch, n.pitch, n.pitch, n.pitch);
  var mt = array<f32, 5>(n.start, n.start, n.start, n.start, n.start);
  var found = 1u;
  for (var j = ii + 1u; j < ii + 96u && found < 5u; j++) {
    let m = notes[j];
    if (m.start < n.start || m.start > mt[found - 1u] + beat * 2.0) { break; }
    if (m.role < 0.5 && m.start > mt[found - 1u] + 0.02) {
      mp[found] = m.pitch;
      mt[found] = m.start;
      found++;
    }
  }
  if (found < 3u) { return hidden(); }
  for (var k = found; k < 5u; k++) { mp[k] = mp[k - 1u] + (mp[k - found + 1u] - mp[k - found]); mt[k] = mt[k - 1u] + beat * 0.5; }

  // Depth: strong cells +1; motifs +1 and +1 more once they have returned before.
  var depth = 6u + u32(n.strength > 0.55);
  if (isMotif) {
    depth += 1u;
    for (var j = 1u; j <= 320u && j <= ii; j++) {
      let m = notes[ii - j];
      if (abs(m.motif - n.motif) < 0.5 && m.motifPos < 0.5 && m.role < 0.5) { depth += 1u; break; }
    }
  }
  depth = min(depth, 8u);
  if (b >= (1u << depth)) { return hidden(); }
  let lv = firstLeadingBit(b);

  // Interval / rhythm rule.
  var iv = array<f32, 4>(mp[1] - mp[0], mp[2] - mp[1], mp[3] - mp[2], mp[4] - mp[3]);
  var io = array<f32, 4>(mt[1] - mt[0], mt[2] - mt[1], mt[3] - mt[2], mt[4] - mt[3]);
  let ioMean = max((mt[4] - mt[0]) * 0.25, 0.05);

  var pos = vec2f(0.0);
  var ang = 1.5707963;
  var len = 1.0;
  var segA = vec2f(0.0);
  for (var l = 0u; l <= lv; l++) {
    if (l > 0u) {
      let r = (l - 1u) % 4u;
      let side = (b >> (lv - l)) & 1u;
      let x = iv[r];
      let spread = clamp(0.32 + 0.06 * abs(x), 0.32, 0.95);
      let bend = clamp(x * 0.07, -0.55, 0.55);
      ang += bend + select(-spread, spread, side == 1u);
      len *= clamp(0.74 + 0.12 * (io[r] / ioMean - 1.0), 0.6, 0.86);
    }
    let grow = mix(0.7, 1.0, smoothstep(-0.05, 0.25, F.songTime - motif_tree_tLv(mt, l)));
    segA = pos;
    pos += motif_tree_dir(ang) * len * grow;
  }

  // Place the tree in the plane across the time axis at the cell's first note, trunk pointing away from the axis.
  let base = L(n.start, n.pitch, 0.0);
  let ctr = LCenter(n.start);
  var ax = LCenter(n.start + 0.05) - ctr;
  if (length(ax) < 1e-4) { ax = camEye() - base; }
  ax = normalize(ax);
  var rad = base - ctr;
  rad -= ax * dot(rad, ax);
  var ey = LUp(n.start);
  ey = ey - ax * dot(ey, ax);
  if (length(rad) > 0.25) { ey = rad; }
  ey = normalize(ey);
  let ex = cross(ax, ey);
  let sc = S.p[6].x * 0.4;
  let A = base + (ex * segA.x + ey * segA.y) * sc;
  let B = base + (ex * pos.x + ey * pos.y) * sc;
  let p = mix(A, B, qu(cc));
  let w = lineW(p) * max(1.3 - 0.12 * f32(lv), 0.45);
  let wp = stripPoint(A, B, qu(cc), qv(cc), w);
  var o: LOut;
  o.pos = toClip(wp);
  o.wp = wp;
  o.a = vec4f(qu(cc), qv(cc), 0.0, 0.0);
  let hue = select(pitchHue(n.pitch) * 0.55 + 0.1, fract(n.motif * 0.618), isMotif);
  o.b = vec4f(motif_tree_tLv(mt, lv), hue, f32(lv), n.strength);
  o.c = vec4f(mp[min(lv, 4u)], f32(depth), 0.0, 0.0);
  return o;
}
fn fs_motif_tree(in: LOut) -> vec4f {
  let tl = in.b.x;
  let age = F.songTime - tl;
  let lv = in.b.z;
  let flash = step(0.0, age) * exp(-max(age, 0.0) * 3.0);
  let light = playLight(-age);
  let hue = S.p[3].x + in.b.y + (pitchHue(in.c.x) - 0.5) * 0.12;
  let col = palL(hue + lv * 0.015, 1.0);
  let tip = select(1.0, 1.6, lv + 1.5 > in.c.y);
  let k = (0.22 + 0.9 * light + 2.4 * flash) * (1.0 - lv * 0.05) * tip * (0.55 + in.b.w) * S.p[3].y * 0.75;
  return glowOut(col * k, in.wp);
}
`,
} satisfies LayerDef;
