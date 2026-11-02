# Psychedelic (LSD) visual effects as post looks

What people report seeing on LSD and similar psychedelics, why those forms appear, and how to build each one as a cheap image-space post effect over a world. The looks in `src/looks/library/lsd*.ts` implement them. They share eased music inputs and WGSL helpers from `lsdCommon.ts`.

## What the reports agree on

The visuals are mostly not new objects. They are the world being distorted: surfaces breathe, textures flow, motion leaves trails, colour intensifies, and geometry shows up on and in surfaces. Three properties hold across trip reports, the Subjective Effects Index (SEI), Psychedelic Replications and the research literature:

- **They are slow and wave-like.** Breathing is a steady expansion and contraction on multi-second cycles. Drifting flows "like a river in a looped animation". Nothing snaps.
- **They grow with stimulation and attention.** Drifting is strongest on detailed or rough textures (wood grain, carpet, fur). It intensifies the longer you stare and resets when you refocus. Music, light and motion strengthen everything.
- **They come in levels.** The SEI scale for drifting runs from peripheral (straight lines wiggle at the edge of vision), through direct and ubiquitous, to all-encompassing (the whole scene is a smudged, flowing mass). Moderate doses sit at levels 2 and 3, and that is the target here. Distortion you notice, but the world stays readable.

## Why these forms: Klüver and Bressloff–Cowan

**Klüver's form constants (1920s, from mescaline).** These four geometric forms recur across drugs, migraine, flicker and near-sleep:

1. Tunnels and funnels.
2. Spirals.
3. Lattices: honeycombs, checkerboards, triangles and fretworks.
4. Cobwebs.

**Bressloff, Cowan et al. (2001, 2002).** The map from retina to primary visual cortex (V1) is close to a complex logarithm: `(r, θ) → (u, v) = (log r, θ)`. When drugs destabilise V1's resting state, its lateral connections form spontaneous stripes and hexagonal patterns. These are plane waves and their combinations in cortical coordinates. Projected back to the visual field:

| Cortical pattern (in u, v) | What you see |
|---|---|
| Stripes along u | Concentric rings: tunnels and funnels |
| Stripes along v | Radial rays: funnel spokes |
| Oblique stripes | Logarithmic spirals |
| Hexagons and squares | Lattices of rings and rays, which read as cobwebs and honeycomb tunnels |

When the model includes V1's edge-orientation columns, contour-like patterns appear as well. That accounts for lattices and cobwebs made of lines rather than blobs.

**Implementation consequence.** A form constant is a plane wave in `(log r, θ)`, which costs one `log`, one `atan2` and a few `sin` calls. Use it as a *displacement* of the image, not a drawing on top, so the world itself bends into the form.

## The phenomenology frameworks

**Qualia Computing, "Algorithmic Reduction of Psychedelic States" (Gómez Emilsson, 2016).** The article reduces the effects to four mechanisms:

1. **Control interruption.** Perceptual feedback control is weakened, so earlier frames are not suppressed. This causes tracers and "frame stacking".
2. **Drifting.** Local features lose their anchoring and slide, breathe and flow, while the global layout holds.
3. **Enhanced pattern recognition.** Apophenia: faces and objects in textures. This is deliberately not implemented, because the user rejects recognisable objects.
4. **Symmetry detection and propagation.** The threshold for finding symmetry drops, so textures snap into local mirror and rotational symmetry. These symmetric patches spread and merge ("symmetrical texture repetition").

**Subjective Effects Index (Effect Index, Josie Kins).** Its visual entries:

- **Drifting**, with subtypes:
  - breathing: rhythmic swelling and shrinking;
  - flowing: textures stream;
  - morphing: shapes reconfigure;
  - melting: surfaces droop and blend.
- **Tracers**: trails behind moving things, translucent at low levels and longer and more opaque at high levels.
- **After images**.
- **Colour enhancement**: more saturated, more vivid.
- **Colour shifting**: hues cycle across surfaces.
- **Symmetrical texture repetition**.
- **Geometry**, in levels. At low levels it is faint and overlaid on surfaces; at high levels it is structured and 3D.
- **Visual haze, halos and auras.**
- **Depth perception distortions**.
- **Scenery slicing**.
- **Visual snow / static**.

**Psychedelic Replications (r/replications).** Artists' image and video recreations of specific trips. The recurring techniques are:

- subtle flow-map warps of photographs;
- hue-shifted echo stacks;
- small mirrored patches;
- saturation pushed hard on contours;
- geometry seen *through* surfaces as a faint lattice.

## Effects and how to build them

Every look reads music only through `Groove` (`lsdCommon.ts`). It provides:

- a continuous beat clock, tempo-locked but never stepping;
- an energy-scaled flow clock;
- `energySlow` eased over 1.5 s;
- a fine-detail drive: highs, upper melody and hats, eased over 0.6 s;
- backing pads, eased;
- an 8-bar phrase counter eased over 2 s.

No look reads `kick`, `snare`, `beat` or `beatPhase`, so none can pulse or snap. Warping looks return `lsd_out(base, warped)`, which cancels the pass's `mix(base, look, amount)` so the warp never double-exposes. They fade to zero at the frame border (`lsd_edge`) so they never pull in mirrored edges.

### Breathing — `lsd-breathe`

**What it looks like:** the scene slowly inhales and exhales. Walls swell toward you, and regions swell and shrink out of phase, so the breath travels across surfaces.

**How to build it:** a global scale about the centre, plus displacement along the gradient of a slow stream function. Displacing along `∇ψ` magnifies its peaks and shrinks its troughs. A phase that depends on `ψ` makes the swelling travel.

```wgsl
let ph = TAU * bars / 2.0;                       // one breath per 2 or 4 bars
var d = -p * sin(ph) * 0.022 * (1.0 - reg);      // global inhale/exhale
let s = lsd_psi(p, flow * 0.12, k);              // (psi, dpsi/dx, dpsi/dy)
d += -s.yz / k * sin(ph - s.x * 1.3) * 0.035 * reg;
col = vec3f(src(p + d*1.1).r, src(p + d).g, src(p + d*0.9).b);  // faint chromatic split
```

**Music:** breath period = 2 or 4 bars; depth = `energySlow`; the highs add a faint 11× finer shimmer.

### Drifting and flowing textures — `lsd-drift`

**What it looks like:** fine texture streams along slow currents while the large forms stay put.

**How to build it:** split the image into a soft base and its detail (`src - lowpass`). Advect only the detail with a two-phase flow map along a curl (divergence-free) field. Normalise the crossfade so contrast doesn't dip.

```wgsl
let dir = curl(p) / (|curl| + c);  let off = dir * reach;
let ph0 = fract(t); let ph1 = fract(t + 0.5); let w0 = 1 - |2ph0 - 1|; let w1 = 1 - w0;
let d0 = detail(uv - off*(ph0-0.5)); let d1 = detail(uv - off*(ph1-0.5));
col = low(uv) + (d0*w0 + d1*w1) / sqrt(w0*w0 + w1*w1) * gain;
```

**Music:** flow speed = energy (the flow clock); reach and detail gain = fine-detail drive. Busier highs make the texture flow more, the way stimulation strengthens drifting.

### Tracers — `lsd-tracers`

**What it looks like:** bright forms leave a stack of fading echoes. These are discrete and stroboscopic rather than a smooth smear, and each echo is shifted in hue.

**How to build it:** looks only see the current frame, so the echoes are placed spatially, along a slow curl flow or the radial tunnel direction. Composite them with a soft lighten, so an echo only shows where it is brighter than the pixel, and darks survive.

```wgsl
for (i = 1..6) { w *= persist;
  let c = vivid(hueRotate(src(p - dir*gap*i), hueStep*i)) * w;
  acc += max(c - acc, 0) * 0.75; }
```

**Music:** gap = energy (longer trails when loud), tighter with busy highs; hue spread = pads. True temporal tracers belong in the feedback pass (`docs/techniques/feedback.md`), with a hue rotation per feedback step.

### Form constants — `lsd-form-constant`

**What it looks like:** the world bends into a tunnel, spiral, honeycomb or cobweb. The geometry is in the image, not drawn over it.

**How to build it:** plane waves in `(u, v) = (log r, θ)` give displacements `du` and `dv`, which are mapped back with `r' = exp(u + du)` and `θ' = θ + dv`.

| Form | Displacement |
|---|---|
| Tunnel | `du = A sin(TAU (u k + t))`. The rings stream inward as `t` grows. |
| Spiral | Oblique waves `sin(TAU (u k' + θ m / TAU + t))` with integer `m` arms, so there is no seam at ±π. |
| Lattice | Screen-space `∇` of three cosines 120° apart, which turns the image into a field of soft honeycomb lenses. |
| Cobweb | `du = A sin(ring) (0.55 + 0.45 cos(2nθ))` and `dv ∝ sin(2nθ) / 2n`, giving spokes crossed by rings. |

**Rules:**
- Keep each warp's slope below about 0.5, otherwise the map folds over and looks glitchy. The test: `amp * TAU * freq < 0.5`.
- Fade the warp out at the centre, where `log r` is singular.

**Music:** the family changes once per 8-bar phrase, crossfaded over about 2 s; depth and inward speed follow energy.

### Halos and auras — `lsd-aura`

**What it looks like:** bright forms radiate soft, layered, chromatic glows. Inner rings are close to the object's colour, and outer rings move further round the hue circle.

**How to build it:** gather the bright part of the image on four tap rings (2.5, 5, 9 and 15 px at 720p; 8, 10, 12 and 14 taps). Hue-rotate each ring a step further and lean it toward the palette. Mask the aura off the bright source itself so it sits outside it, and the downstream bloom softens the rest.

```wgsl
for ring { sum = avg(bright(src(uv + ring_r * dir_j))); aura += vivid(hue(sum, step*(ring+1))) * fall; }
out = base + aura * gain * (1 - 0.75 * selfBright);
```

**Music:** the radius breathes on a 4-bar cycle; glow = energy; hue spread = pads. Rings sparser than about 6 px per tap show as ghost copies on thin-line worlds, so keep the taps dense.

### Symmetrical texture repetition — `lsd-symmetry`

**What it looks like:** patches of texture snap into mirror symmetry. The patches catch, hold and release, and they spread as stimulation rises.

**How to build it:** use a drifting hex lattice of large cells, about half the screen height. Fold the sampling coordinate in each cell's rotated frame: mostly bilateral, some 4-fold and a few 3-fold. Blend the *coordinate* (`mix(q, fold(q), w)`), not the colour, so the image bends into symmetry without a double exposure. `w` falls to 0 at the cell border, so the cells join seamlessly.

**Rules:**
- Use a smooth `|x|` (`sqrt(x² + k²) - k`) so mirrored lines bend instead of kinking.
- Avoid 6-fold folds in small cells. They read as stamped rosettes, which the user rejects as emblems.

**Music:** coverage grows with energy; each phrase reshuffles which cells are folded.

### Colour enhancement and hue waves — `lsd-hue-flow`

**What it looks like:** colours become more saturated, and slow bands of hue pour across the image along brightness contours.

**How to build it:**
- Rotate the hue around the grey axis while preserving luma.
- Set the rotation angle from `sin(TAU * (log2(luma) * density - t))`, which makes iso-brightness bands shift colour in sequence.
- Add a vibrance boost and a small local-contrast lift.
- Push greys gently toward the palette colour of their band.
- Leave pixels below about 0.05 luma alone, so blacks stay black.

**Music:** speed = energy; hue swing = pads; band density = highs.

### Covered in the doc but not built as separate looks

- **After images.** These need the previous frame, so build them in the feedback pass: a complementary-hue ghost of strong edges that decays over about 1 s.
- **Depth and scale shifts.** Covered by breathing (global scale) and tunnel warps.
- **Fractal recursion and objects morphing into patterns.** The Droste and conformal looks (`docs/techniques/conformal.md`) handle recursion. The worlds themselves morph.
- **Edges glowing and vibrating.** Partly covered by aura and hue-flow clarity. A vibrating edge, meaning a sub-pixel displacement along the edge normal at high frequency, reads as jitter, which the user rejects.
- **Visual snow.** Skipped on purpose: it is a decorative noise texture, which the user rejects.

## Cost

The look pass at 1920×1080 on the RTX (Blackwell) adds about 0.05–0.35 ms over no look; measurement noise is about ±0.2 ms. `lsd-aura` (45 taps) and `lsd-drift` (13 taps) are the heaviest.

## Sources

- Bressloff, Cowan, Golubitsky, Thomas, Wiener. *What geometric visual hallucinations tell us about the visual cortex*, Neural Computation 14 (2002). https://www.math.utah.edu/~bresslof/publications/01-3.pdf
- Bressloff et al. *Geometric visual hallucinations, Euclidean symmetry and the functional architecture of striate cortex*, Phil. Trans. R. Soc. B (2001). https://www.math.utah.edu/~bresslof/publications/01-1.pdf
- Klüver, H. *Mescal and Mechanisms of Hallucinations* (1966; studies from 1926–1942).
- Gómez Emilsson, A. *Algorithmic Reduction of Psychedelic States*, Qualia Computing (2016). https://qualiacomputing.com/2016/06/20/algorithmic-reduction-of-psychedelic-states/
- Subjective Effect Index, Effect Index. https://www.effectindex.com/effects/drifting (also: tracers, geometry, symmetrical texture repetition, colour enhancement). Background: https://en.wikipedia.org/wiki/Subjective_Effect_Index
- Psychedelic Replications community (r/replications).
