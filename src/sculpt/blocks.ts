/**
 * Grammar blocks for score sculptures. A sculpture places every musical event in space:
 *   L(t, pitch, lane) -> world position for song time t (seconds), MIDI pitch and role lane
 *   (lane 0 = lead, -1 = bass, 0.5 = harmony voices, 1 = chord layer, 2 = surface).
 * Layout params live in S.p[4] (x, y, z, w). Cameras read S.p[2].
 */
export interface LayoutBlock {
  id: string;
  /** 'travel' layouts lay absolute time along a path the camera flies; 'flow' layouts let music flow to a fixed playhead. */
  kind: 'travel' | 'flow';
  /** Pick likelihood: layouts you travel through are more immersive than objects you orbit. */
  weight?: number;
  /**
   * Lane of the layout's score surface (the ground, wall or tread the music lives on), for world
   * layers that spread everything sounding over (time, pitch). Undefined: the layout has none.
   */
  surface?: number;
  cameras: string[];
  wgsl: string;
}

export interface Block {
  id: string;
  wgsl: string;
}

/** Shared: dt relative to now, pitch offset from the song's pitch centre. */
const H = /* wgsl */ `
fn dtOf(t: f32) -> f32 { return t - F.songTime; }
fn pOff(pitch: f32) -> f32 { return (pitch - S.p[0].z) * S.p[0].y; }
`;

export const LAYOUTS: LayoutBlock[] = [
  {
    id: 'road',
    kind: 'travel',
    weight: 1.3,
    surface: -1.7,
    cameras: ['chase-low', 'chase-low', 'chase-side', 'chase-high'],
    wgsl:
      H +
      /* wgsl */ `
// Time runs ahead along +z, pitch across x, roles stack in height.
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  return vec3f(pOff(pitch), lane * S.p[0].w, t * S.p[0].x);
}
fn LCenter(t: f32) -> vec3f { return vec3f(0.0, 0.0, t * S.p[0].x); }
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  {
    id: 'river',
    kind: 'travel',
    weight: 1.3,
    surface: -1.7,
    cameras: ['chase-low', 'chase-low', 'chase-high'],
    wgsl:
      H +
      /* wgsl */ `
// A road whose centre line meanders with the bass line, so the whole river follows the harmony's root.
// The bass is averaged over two seconds: the river bends with the harmony, it never jumps per note.
fn riverX(t: f32) -> f32 {
  var s = 0.0;
  var w = 0.0;
  for (var i = 0; i < 8; i++) {
    let b = bassAt(t - F.songTime + (f32(i) - 3.5) * 0.28);
    s += (b.x - S.p[0].z + 12.0) * b.y;
    w += b.y;
  }
  return select(0.0, s / max(w, 1e-3) * S.p[0].y * 0.35 * sat(w / 3.0), w > 0.0) + sin(t * 0.21) * S.p[4].x;
}
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  return vec3f(riverX(t) + pOff(pitch), lane * S.p[0].w, t * S.p[0].x);
}
fn LCenter(t: f32) -> vec3f { return vec3f(riverX(t), 0.0, t * S.p[0].x); }
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  {
    id: 'helix',
    kind: 'travel',
    weight: 1.1,
    surface: 2.2,
    // Inside only: from outside, the tunnel's score wall would hide the music within.
    cameras: ['axis'],
    wgsl:
      H +
      /* wgsl */ `
// A tunnel of the song: time runs along the axis and pitch climbs the wall, a semitone a small
// turn, so a melody reads as one line rising and falling around you (66 semitones per turn, so
// the whole range nearly closes the tunnel). Voices sit at their own radius.
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  let a = S.p[4].y + (pitch - S.p[0].z) * TAU / 66.0;
  // Keep every voice clear of the axis, where axis cameras fly.
  let r = max(0.7, S.p[4].x + lane * S.p[0].w * 0.5);
  return vec3f(cos(a) * r, sin(a) * r, t * S.p[0].x);
}
fn LCenter(t: f32) -> vec3f { return vec3f(0.0, 0.0, t * S.p[0].x); }
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  {
    id: 'spiral',
    kind: 'flow',
    weight: 0.35,
    cameras: ['overhead', 'tilted-orbit'],
    wgsl:
      H +
      /* wgsl */ `
// A record seen from above: the playhead ring sits at radius a; the future spirals in from outside,
// the past drains toward the centre. Pitch is height above the disc.
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  let dt = dtOf(t);
  let r = max(0.15, S.p[4].x + dt * S.p[0].x * 0.35);
  let a = t * S.p[4].y;
  return vec3f(cos(a) * r, pOff(pitch) * 0.4 + lane * S.p[0].w, sin(a) * r);
}
fn LCenter(t: f32) -> vec3f { let p = L(t, S.p[0].z, 0.0); return vec3f(p.x, 0.0, p.z); }
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  {
    id: 'converge',
    kind: 'flow',
    weight: 0.3,
    cameras: ['tilted-orbit', 'overhead'],
    wgsl:
      H +
      /* wgsl */ `
// Music arrives from deep space toward a sphere and lands on it as it sounds: pitch is latitude
// (high notes land high), song time turns slowly in longitude, so a melody arrives as a readable
// contour wound around the globe. Distance is time until it sounds.
fn sphereDir(t: f32, pitch: f32, lane: f32) -> vec3f {
  let lat = clamp(pOff(pitch) * 0.45, -1.35, 1.35);
  let lon = S.p[4].y + lane * 0.8 + t * 0.12;
  return vec3f(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
}
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  let dt = dtOf(t);
  let d = S.p[4].x * (1.0 + lane * 0.15) + max(dt, -0.4) * S.p[0].x * 0.6;
  return sphereDir(t, pitch, lane) * max(d, 0.2);
}
fn LCenter(t: f32) -> vec3f { return vec3f(0.0); }
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  {
    id: 'knot',
    kind: 'flow',
    weight: 0.25,
    cameras: ['tilted-orbit', 'helix-outside'],
    wgsl:
      H +
      /* wgsl */ `
// Time wraps around a (p,q) torus knot once every 8 bars, so repeated phrases land on top of
// each other and the song's repetition becomes visible structure. Pitch offsets from the curve.
fn knotC(u: f32) -> vec3f {
  let p = S.p[4].z;
  let q = S.p[4].w;
  let r = cos(q * u) + 2.0;
  return vec3f(r * cos(p * u), r * sin(p * u), -sin(q * u)) * S.p[4].x * 0.5;
}
fn knotU(t: f32) -> f32 { return t / (240.0 / max(F.bpm, 40.0) * 2.0) * TAU / 4.0; }
fn L(t: f32, pitch: f32, lane: f32) -> vec3f {
  let u = knotU(t);
  let c = knotC(u);
  let tng = normalize(knotC(u + 0.01) - c);
  let nrm = normalize(cross(tng, vec3f(0.0, 0.0, 1.0)) + vec3f(0.0, 0.0, 1e-3));
  let bin = cross(tng, nrm);
  return c + nrm * pOff(pitch) * 0.25 + bin * lane * S.p[0].w * 0.6;
}
fn LCenter(t: f32) -> vec3f { return knotC(knotU(t)); }
fn LUp(t: f32) -> vec3f { return vec3f(0.0, 0.0, 1.0); }`,
  },
];

/** Cameras return eye / target / up. Travel cameras keep the playhead a little ahead. */
export const CAMERAS: Record<string, Block> = {
  'chase-low': {
    id: 'chase-low',
    wgsl: /* wgsl */ `
/** The camera leans toward where the melody is heading, averaged over 2.4 s so it glides, never jolts. */
fn camSway() -> f32 {
  var s = 0.0;
  var w = 0.0;
  for (var i = 0; i < 16; i++) {
    let l = leadAt(f32(i) * 0.15 - 0.6);
    s += (l.x - S.p[0].z) * l.y;
    w += l.y;
  }
  return s / max(w, 1e-3) * S.p[0].y * 0.2 * sat(w / 6.0);
}
fn camEye() -> vec3f { return LCenter(F.songTime - S.p[2].x) + vec3f(camSway(), S.p[2].y, 0.0); }
fn camTarget() -> vec3f { return LCenter(F.songTime + S.p[2].z) + vec3f(0.0, S.p[2].y * 0.2, 0.0); }
fn camUp() -> vec3f { return vec3f(sin(S.p[2].w * 0.2), 1.0, 0.0); }`,
  },
  'chase-high': {
    id: 'chase-high',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f { return LCenter(F.songTime - S.p[2].x * 1.6) + vec3f(S.p[2].w, S.p[2].y * 1.2 + 1.2, 0.0); }
fn camTarget() -> vec3f { return LCenter(F.songTime + S.p[2].z * 1.4); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  'chase-side': {
    id: 'chase-side',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f { return LCenter(F.songTime - S.p[2].x * 0.3) + vec3f(-6.0 - S.p[2].y * 2.0, 1.2 + S.p[2].y, 0.0); }
fn camTarget() -> vec3f { return LCenter(F.songTime + S.p[2].z * 0.6) + vec3f(0.0, 0.2, 0.0); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
  axis: {
    id: 'axis',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f { return LCenter(F.songTime - S.p[2].x) + vec3f(S.p[2].w * 0.3, S.p[2].y * 0.3, 0.0); }
fn camTarget() -> vec3f { return LCenter(F.songTime + S.p[2].z); }
fn camUp() -> vec3f { let a = F.spin * 0.04 + S.p[2].w * 0.3; return vec3f(sin(a), cos(a), 0.0); }`,
  },
  'helix-outside': {
    id: 'helix-outside',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f { let a = F.spin * 0.08 + S.p[2].w; let d = S.p[4].x * 3.2 + S.p[2].y; return LCenter(F.songTime + S.p[2].z * 0.4) + vec3f(cos(a) * d, sin(a) * d, -S.p[2].x * 1.5); }
fn camTarget() -> vec3f { return LCenter(F.songTime + S.p[2].z * 0.6); }
fn camUp() -> vec3f { return vec3f(0.0, 0.0, 1.0); }`,
  },
  overhead: {
    id: 'overhead',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f { let a = F.spin * 0.05 + S.p[2].w; let d = S.p[4].x * 1.2 + S.p[2].y; return vec3f(cos(a) * d * 0.5, S.p[4].x * 2.2 + S.p[2].y, sin(a) * d * 0.5); }
fn camTarget() -> vec3f { return vec3f(0.0, 0.0, 0.0); }
fn camUp() -> vec3f { return vec3f(0.0, 0.0, 1.0); }`,
  },
  'tilted-orbit': {
    id: 'tilted-orbit',
    wgsl: /* wgsl */ `
fn camEye() -> vec3f { let a = F.spin * 0.07 + S.p[2].w; let d = S.p[4].x * 2.6 + S.p[2].y; return vec3f(cos(a) * d, d * (0.35 + S.p[2].z * 0.05), sin(a) * d); }
fn camTarget() -> vec3f { return vec3f(0.0, 0.0, 0.0); }
fn camUp() -> vec3f { return vec3f(0.0, 1.0, 0.0); }`,
  },
};

/** Background environments: gradient spaces tinted by the harmony ahead. No decorative noise. */
export const BACKGROUNDS: Block[] = [
  {
    id: 'deep',
    // Near-black space with a low-chroma vertical gradient: the chord ahead tints the floor, so
    // colour belongs to the music and the space only carries value.
    wgsl: /* wgsl */ `
fn bgColor(rd: vec3f) -> vec3f {
  let ch = chordAtT(3.0);
  let h = sat(rd.y * 0.5 + 0.5);
  let lo = palL(S.p[3].x + pitchHue(ch.x * 13.0 - 1.0) * 0.55 + 0.5, 0.006);
  let hi = palL(S.p[3].x + 0.1, 0.022);
  let c = mix(lo, hi, smoothstep(0.1, 0.9, h));
  return mix(vec3f(luma(c)), c, 0.45);
}`,
  },
  {
    id: 'horizon',
    // A dark plain under a dark sky; the horizon glows in the colour of the chord ahead and
    // brightens with its tension, so an approaching cadence is visible on the skyline.
    wgsl: /* wgsl */ `
fn bgColor(rd: vec3f) -> vec3f {
  let ch = chordAtT(3.0);
  let cu = normalize(camUp());
  // World up unless the camera is rolled onto another axis (helix, knot): then the camera's horizon.
  let up = select(cu, vec3f(0.0, 1.0, 0.0), abs(cu.y) > 0.6);
  let h = dot(rd, up);
  let hue = select(S.p[3].x + 0.1, S.p[3].x + pitchHue(ch.x * 13.0 - 1.0) * 0.55 + 0.5, ch.x > 0.02);
  let glowC = palL(hue, 1.0);
  let sky = mix(vec3f(0.006, 0.006, 0.008), palL(S.p[3].x + 0.1, 0.012), sat(h * 2.0));
  let ground = vec3f(0.003) + glowC * 0.004;
  let band = exp(-abs(h) * mix(22.0, 11.0, ch.z)) * (0.035 + 0.05 * ch.z);
  return mix(ground, sky, smoothstep(-0.02, 0.02, h)) + glowC * band;
}`,
  },
  {
    id: 'paper',
    // Light environment: the score reads as ink and colour on a warm page lit from above.
    wgsl: /* wgsl */ `
fn bgColor(rd: vec3f) -> vec3f {
  let h = sat(rd.y * 0.5 + 0.5);
  let page = vec3f(0.98, 0.92, 0.82) * mix(0.66, 0.76, smoothstep(0.0, 1.0, h));
  // Undo most of the post split-tone (shadow tint from pal0), so the page stays warm paper.
  let tS = max(1.0 + (F.pal0.rgb / (luma(F.pal0.rgb) + 1e-4) - 1.0) * 0.18, vec3f(0.5));
  return page / mix(vec3f(1.0), tS, 0.85);
}`,
  },
];
