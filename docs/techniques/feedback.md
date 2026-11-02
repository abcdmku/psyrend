# Feedback, image-space techniques and particles from the sound

Cheap techniques that work on the previous frame or on a persistent field, and how the music drives them. Two working prototypes use them:

- `src/scenes/library/feedbackBloom.ts` (`feedback-bloom`): a feedback loop of neon line bundles streaming out of a black vortex core, with an excitable-medium burn carried by the same flow. It costs 0.51 ms of GPU at 1080p.
- `src/scenes/library/spectralNebula.ts` (`spectral-nebula`): GPU particles emitted from the spectrum, splatted into a persistent gas field, with ridge-following fire fronts. It costs 1.09 ms of GPU at 1080p.

Both are custom `SceneFactory` scenes with their own ping-pong textures, in the same style as `liquidLight.ts`. The three rules from `flow.md` hold for both: sound makes matter, beats ignite fronts, and the form keeps travelling.

## How the renderer already does history

- `PostChain` (`src/gpu/post.ts`) keeps two full-resolution HDR textures, `hist[0..1]`, and ping-pongs them in `FEEDBACK_WGSL`. Each frame it applies `fbZoom`, `fbRotate`, a value-noise warp `fbWarp`, a hue rotation `fbHueShift`, and composites either an echo `mix(cur, prev, keep)` or a lighten `max(cur, prev * keep)` (`meta.sparse`). The history is fetched with a 5-tap Catmull-Rom filter. A 1-ulp stochastic rounding term keeps fp16 decay from freezing at high refresh rates.
- `histTex` in `src/gpu/resources.ts` is **not** frame history. It is a 64 × 256 `r8unorm` ring of spectrum rows, read in WGSL with `hist(x, age)` (0 = now, 1 = about 4 s ago). It suits spectral memory, such as an emitter that replays the last bar's spectrum.
- The director's post feedback is global and uniform: one zoom, one rotation and one hue shift for the whole frame. That is the Winamp model. A world that wants premium feedback runs its own loop, sets `meta.trails = 0`, and keeps the post trails off.

## Why classic feedback looks dated, and what fixes it

| Winamp/MilkDrop habit | Why it reads as 2003 | Modern replacement |
|---|---|---|
| One global `zoom` and `rot` about the screen centre | Nested copies of the frame, a tunnel of repeats | A spatially varying, divergence-free warp. Put the spiral centre off-centre and drift it with the morph. |
| Bilinear resample every frame | Everything smears to mush within a second | Catmull-Rom fetch plus a neighbourhood clamp. Never add unsharp gain (see below). |
| Uniform `decay` toward black, 8-bit buffers | Banding, grey haze, dead tails | An HDR float buffer, with decay as per-channel absorption, so light saturates as it cools. |
| Hue cycling | Rainbow soup, no palette | Palette inks. Colour changes only where a front passes, and it stays. |
| Waveform scope as the seed | Literal, thin and jittery | Matter emitted by pens or emitters whose shape is set by the spectrum. |
| Everything flashes on the beat | A pulse, not a reaction | A front that travels through the structure and leaves it changed. |
| Flat light | A poster | Shade the field as a height (gloss, fresnel, dispersion across edges) and add a soft haze where light pools. |

Modern VJ practice is the same list, done in TouchDesigner as a Feedback TOP wrapping Displace, Level and Composite TOPs. Keep each per-pass operation gentle because it compounds, and put bloom and grading *outside* the loop.

## The loop

Work in centred height units, `q = (uv - 0.5) * vec2(aspect, 1)`. Each frame, a pixel fetches where its content was `dt` ago (a semi-Lagrangian backward map):

```
v(q) = a (q - c) + ω perp(q - c) + w(q)        // spiral bloom about focal c, plus a warp
q_src = q - v(q) dt
```

With `a > 0` the image streams outward, so you fly into it. This kind of feedback never samples outside the frame, because only the core is new. Keep a black core with `col *= exp(-5 dt (1 - smoothstep(0, R, |q - c|)))`. Without it, the focal pixel's colour smears outward as a blob.

**Warp: a stream function, not noise displacement.** Noise displacement compresses and expands the image (it has divergence), which reads as a wobble. Take `w = (∂ψ/∂y, -∂ψ/∂x)` of a smooth `ψ`. The analytic form is exact and cheap:

```wgsl
// psi = sin(a1) sin(b1) + 0.55 sin(a2) sin(b2), in a frame turned by angle (c, s)
let p = vec2f(c * q.x + s * q.y, -s * q.x + c * q.y);
let a1 = k1 * p.x + ph.x; let b1 = k1 * p.y + ph.y;
let a2 = k2 * p.x + ph.z; let b2 = k2 * p.y + ph.w;
let dx = cos(a1) * sin(b1) + 0.55 * cos(a2) * sin(b2);
let dy = sin(a1) * cos(b1) + 0.55 * sin(a2) * cos(b2);
let wp = vec2f(dy, -dx) * amp;
let w = vec2f(c * wp.x - s * wp.y, s * wp.x + c * wp.y);
```

Morph mapping: phases `ph ← at[5..7], at[0]`, `k1 = TAU / wave(at[3], 0.55, 1.2)`, `k2 = k1 * wave(at[4], 1.7, 2.8)`, `amp ← wave(at[2])`. Kick and snare steps in `morph.at` then leave the current in a new, lasting layout. For noise-based curl (the nebula), use `ψ = noise4fast(vec3(q k, z)).x + 0.45 * noise4fast(...).y` with central differences of `e = 0.02`, and carry `z` with the morph.

**Fetch:** a 5-tap Catmull-Rom (copy `history()` from `feedbackBloom.ts`), then clamp to the min/max of the four bilinear neighbours at `q_src`. That removes ringing.

**Do not sharpen inside the loop.** An unsharp term `c += s (c - avg)` with any gain compounds over hundreds of frames into zigzags along every line. Catmull-Rom alone keeps lines crisp for seconds.

**Decay as absorption.** Weaker channels fade first, so a white-hot stroke cools through a saturated colour, not toward grey:

```wgsl
let m = max(c.r, max(c.g, c.b));
c *= exp(-dt / tau * (1.0 + k * (1.0 - c / max(m, 1e-4))));   // k ≈ 1.4, tau ≈ 2.6–4 s
```

The renderer's rules still apply: scale everything by `dt`, keep fixed-rate sub-steps for anything with a speed (burn steps), and use float buffers.

### Self-displacement (the image pushes itself)

`v_self = κ R(θ) ∇L / (G0 + |∇L|)` moves the image along its own luminance gradient, turned by θ. This is the classic feedback "fold", and it is risky:
- With θ ≈ 0 it moves content uphill. Bundles of fine lines merge into fat ribbed tubes.
- With θ = ±90° it slides content along contours. On high-contrast lines it still fuzzes the edges near bright regions.
- Use it only on soft fields (gas, blurred dye) with a wide stencil (±4 texels). `feedback-bloom` ships with it off.

## Drawing into the loop: pens that move through the medium

A pen drawn in screen space while the medium flows under it leaves disconnected stamps: clumps, not lines. Draw in the medium's frame instead:

1. Mirror the flow on the CPU (`flowAt()` in `feedbackBloom.ts`).
2. Carry last frame's head by it: `prev' = prev + v(prev) dt`.
3. Draw the segment `prev' → head`.
4. Lay the brush across the pen's motion *relative to the medium* (`head - prev'`).
5. Move the pens against the swirl, so the relative speed never falls to zero.

**Overlap the strokes.** Extend each stroke back over the previous one by `max(len, 2w)` and composite with `c = mix(c, max(c, pen), e)`. Max blending is idempotent, so the overdraw is free and there are no seams at joints at any frame rate.

**Spectral rake.** Each band pen is a rake of `T` fine tines spaced 3 to 5 px apart. Tine `k` gets its light from the spectrum at its own frequency:

```wgsl
let lvl = 0.25 + 1.6 * pow(spec(mix(lo, hi, (f32(k) + 0.5) / T)), 1.3);
```

The ribbon's cross-section is the sound's signature, so it is not a spectrum display. Ease band levels per pen (attack 0.03 s, release 0.16 s), so the ribbons bead rather than flicker.

## Feedback with a reaction term

### Excitable-medium burn (shipped in both prototypes)

A coarse grid (320 × 180, `rgba16float`) holds `x` heat, `y` ember/refractory, `z` front hue, and `w = kind + life/2`. It runs at a fixed `BURN_RATE` (80 steps/s) and is advected by the same flow as the image, so fronts ride the structure.

```
ready  = x < 0.12 && y < 0.25
heat   = Σ neighbours with x > 0.4 (3×3; radius 2 for all kinds; radius 3 for snares)
chance = sat(0.3 heat) · fuel · step(0, life_best - dec_kind)
if ready && hash < chance:  (x, y, z, w) = (1, 1, best.z, kind + (life_best - dec)/2)
else: x *= exp(-h/τ_heat), y *= exp(-h/τ_ember)       // τ_heat ≈ 0.05 s, τ_ember ≈ 1 s
```

- Read the neighbours with `textureLoad` at the advected cell, not bilinear, so kind and life don't blend.
- The random catch makes the front ragged. The life budget (`dec` ≈ 0.03 for kick, 0.035 for snare, 0.045 for a note, per hop) makes a front run a finite way and die, so each beat's front is its own event.
- **Fuel decides the shape.** In `feedback-bloom` fuel is the light of the filaments, so fronts run along the bundles. In the nebula, fuel from raw density burns uniform clouds as expanding discs: the "ring of light" the user rejected. Use the **ridges** instead: `fuel = smoothstep(.06, .3, d) · smoothstep(0, .12, d - mean₆(d) + .03)`, with the mean taken over six taps 3 cells away. Fronts then finger along filaments and cloud edges.
- **The lasting change:** wherever `y > 0.05`, recolour the field toward `ink(z)` at its own brightness, `c = mix(c, ink(z) · max(c), (1 - e^{-14 dt}) sat(1.3y - 0.1))`. Read `z` with a B-spline at display time, because nearest reads show the coarse cells as blocks.
- **Display:** add a hot edge `fire(x)` (white → yellow → orange for kicks; `mix(ink, white, x²)` for snares and notes) and embers `(y - x)²`, multiplied by the *display* fuel, so only the structure glows.
- Give each ignition point its own ink (`hue + k · 0.34`), so fronts leave several colours rather than repainting everything one colour.

### Gray-Scott inside the loop (feedback-RD, not prototyped)

Run reaction-diffusion on the feedback buffer itself. Each frame, advect the `(A, B)` chemicals by the warp, then:

```
A' = A + (Da ∇²A - A B² + f (1 - A)) dt
B' = B + (Db ∇²B + A B² - (k + f) B) dt          // Da = 1, Db = 0.5, f ≈ .03–.06, k ≈ .055–.065
```

The warp shears the spots and stripes into flowing fingers. This is the "viscous fingering" family on Shadertoy, often driven by a noise force field used as the displacement. Music mapping:
- `f ← energy` (more growth when loud), `k ← tension`.
- Seed `B` from the pens (sound makes matter).
- Make a kick a local `f` boost that travels as a front, giving a lasting change of pattern.

Use 4 to 8 substeps per frame at half resolution, and shade `B` as a height.

## Echo and trail compositing

- **Echo:** `mix(cur, prev, keep)` conserves energy and suits surface scenes. **Lighten:** `max(cur, prev · keep)` makes trails glow on sparse scenes. Use `keep = exp(-dt / τ)` with τ in seconds, never a per-frame constant.
- **Multi-tap echo** (a premium VJ look): keep a ring of four or so history frames, and composite taps at about 0.1, 0.2 and 0.4 s, each tinted one palette ink further and scaled by `0.6ⁿ`. The taps read as deliberate ghosts, not smear. Tie the tap delays to the beat period (¼, ½ and 1 beat), so the ghosts land on the grid. That is tempo-locked motion, not a pulse.
- Trails must follow the displayed scene, not the cue (see `psyrend-architecture` notes).

## Pixel sorting, tastefully

The GPU form is an odd-even transposition sort along a direction `d`, limited to a mask (spans where luminance lies in `[lo, hi]`). One pass compares and swaps each pixel pair `(i, i + d)` on alternating parity:

```wgsl
let par = (dot(vec2i(pix), dirI) + i32(F.frame)) & 1;
let j = select(pix - dirI, pix + dirI, par == 0);
let a = load(pix); let b = load(j);
let inSpan = mask(a) && mask(b);
let swap = inSpan && ((par == 0) == (luma(a) > luma(b)));
store(pix, select(a, b, swap));
```

Taste rules:
- Sort along the flow direction, never along screen axes.
- Run only a few passes per frame, so the sort is a visible *process* (a melt), not a finished glitch.
- Mask to a band of the structure (a ribbon, a gas filament).
- Make it a lasting change: a kick starts the sorting inside one span, which then stays sorted.

As a constant effect it reads as a 2015 glitch filter.

## Chromatic dispersion, tastefully

Screen-space radial aberration on everything is a crutch. Disperse only across edges and along the local gradient:

```wgsl
let gd = g / (0.15 + length(g)) * amountPx * texel;    // g = ∇ height, ~1–2 px
col = vec3f(sample(uv + gd).r, sample(uv).g, sample(uv - gd).b);
```

Flat areas stay clean, and every filament gets a thin prismatic rim. A refractive variant offsets by `N.xy · thickness` with a per-channel scale (1.35, 1, 0.65), as in `liquidLight.ts`.

## Particles from the audio signature

**Exact emission with a ring buffer.** The CPU accumulates `rate · dt` and advances a `head` by the integer count. The compute shader respawns particle `i` when `(i - head) mod N < count`. The emission rate is exact at any frame rate, with no atomics. Bursts (kicks, snares) take the next slots in the same window.

**The spectrum picks each particle.** Upload cumulative band weights `cw` (from `sub, bass, lowMid, mid, high`, plus 0.05 each) and pick `band` with one hash against `cw`. The band then sets everything:

| Audio | Drives |
|---|---|
| band (by energy) | position along the emitter line (lows at one end, highs at the other), size (lows larger), hue offset |
| band energy | particle mass and size |
| `flux`, `energy` | emission rate (`6k + 16k·flux + 10k·energy` per second) |
| `centroid` | emitter hue (bright sounds turn it one way, dark ones the other) |
| melody pitch | emitter height and hue lean; each note's attack multiplies the mass of matter born then (a brighter layer) |
| kick | 3 fire fronts at a golden-angle walk, plus a few embers |
| snare | 2 fast electric fronts along the fresh veil |
| chord | palette rotation (circle of fifths), eased |
| `morph.at` | current layout, emitter line angle, length and bow, focal drift |

**Emit from a line, not a point.** A point emitter piles matter into one blown-out blob. A line laid out by the spectrum breathes out a veil whose density along it is the spectrum. The current folds the veil into smoke threads (ref10), and pitch moves the line, so a phrase stacks layers.

**Splatting into gas.** Draw each live gas particle as a Gaussian quad into the gas texture, with additive blend:

```wgsl
let amount = mass * fade * dt * deposit / (size * size * 1600.0);   // same total gas at any size
o.color = vec4f(inkDeep(hue) * amount, amount);                      // premultiplied colour + density
```

- Ramp `fade` in over 0.12 **seconds** (not a fraction of life) and out over the last 40% of life.
- Young splats must be at least about 2 gas pixels wide, or the fresh veil reads as rows of dots.

**The gas step** (800 × 450): semi-Lagrangian advection by the same current, a very light 4-neighbour blur (0.2% per 1/60 s; the current makes the detail and diffusion only kills it), fade `τ ≈ 2.6–5 s`, and the absorption ageing above.
- A τ much longer than 5 s fills the frame with mush.
- An empty first frame fails the 1.5 s warm-up, so open each cue on a laid-down state. Use marbled veils of domain-warped threads, not fbm blobs.

**Display it as a lit volume:**
- Colour `C = vivid(rgb / a)`, body `1 - exp(-1.3a)`.
- Take the normal from the *coarse* blurred density. Per-texel normals light every splat as grain.
- Self-shadow with `exp(-max(d(uv - L·0.02) - 0.6d, 0) · 1.6)`, plus an iridescent rim `rot(C, 2.1) · pow(1 - N.z, 1.5)` and two levels of haze.
- Upsample with Catmull-Rom, because a B-spline makes it look out of focus.

**Colour discipline.**
- Additive splats of several hues sum toward white, so the cloud goes pastel. Splat with deep inks (subtract 85% of the minimum channel), keep the hue span along the emitter small (0.2), and re-voice any mixture with a hue to a clean saturated colour at display time.
- Build the three inks so they are always about 120° apart, whatever the director's palette: replace a grey entry *or one that repeats an earlier ink's hue* with that ink rotated ±2.1 rad about the grey axis. An all-red palette otherwise makes the world monochrome, and the recolouring fronts become invisible.

**Sparks:** few, slow and large (2 to 3 px), and only from fronts. Hundreds of 1-px sparks per beat read as the grainy dust the user rejected.

## Passing the gate

- **Lifts are ratios against baseline motion.** A lift compares the picture change in the 100 ms after an event with the 200 ms before it. Feedback worlds have a high baseline because every line moves every frame, so:
  - Keep the flow moderate (expansion about 0.07–0.13 /s, swirl 0.035–0.12 rad/s).
  - Make fronts short-lived bursts (life budgets).
  - Ignite on dense structure: kicks at four points with r ≈ 0.11 on the bundles, notes at the pen and at a pitch angle.
  - Give each note a short (0.09 s) flare that leaves a bead in its thread.
- **Coverage.** Thin lines on black average away at 96 × 54 and fail `black <= 0.7`. A two-level haze (an 8 × 8 box, then a Gaussian, upsampled with a B-spline) fixes it, and it is the light pooling the references show anyway.
- **Hue count.** Red, orange and yellow fall in adjacent 30° bins and count as one hue. Space pen hues 0.2 apart in ink space, so all three inks appear.

## Sources

- MilkDrop preset authoring guide (per-frame `zoom`, `rot`, `warp`, `decay`; per-pixel equations; warp and composite shaders): https://www.geisswerks.com/milkdrop/milkdrop_preset_authoring.html
- TouchDesigner feedback-loop practice (Feedback TOP around Displace and Level; keep per-pass values low): https://www.superhi.com/catalog/generative-art-with-touchdesigner/chapter-01-alla-prima/creating-a-feedback-loop and https://github.com/LucieMrc/TD_textEffects
- Reaction-diffusion as feedback with a noise force field used as displacement: https://vimeo.com/352178040 and https://forum.derivative.ca/t/convertion-of-shaders-based-on-reaction-diffusion/129347
- Stable fluids and semi-Lagrangian advection (Stam 1999), Greenberg–Hastings excitable media, and the Gray-Scott model (Pearson 1993): standard references.
