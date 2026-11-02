export type RGB = [number, number, number];

function oklabToLinear(L: number, a: number, b: number): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (c: RGB) => c.every((v) => v >= -1e-4 && v <= 1.0001);

/** OKLCH (hue in degrees) to linear sRGB, reducing chroma until it fits the gamut. */
export function oklch(L: number, C: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  let lo = 0;
  let hi = C;
  let c = oklabToLinear(L, C * Math.cos(h), C * Math.sin(h));
  if (inGamut(c)) return c;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    c = oklabToLinear(L, mid * Math.cos(h), mid * Math.sin(h));
    if (inGamut(c)) lo = mid;
    else hi = mid;
  }
  c = oklabToLinear(L, lo * Math.cos(h), lo * Math.sin(h));
  return [Math.max(0, c[0]), Math.max(0, c[1]), Math.max(0, c[2])];
}

/** Hue (degrees) for a pitch class, walking the circle of fifths around the colour wheel. */
export function pitchHue(pc: number): number {
  const fifths = (pc * 7) % 12;
  return 25 + fifths * 30;
}

export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}
