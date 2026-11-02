# Flow fields, advection and simple simulations

Cheap 2D and 2.5D techniques that read as liquid, fibre and light, and how the music drives each one. Two working prototypes use them:

- `src/scenes/library/marbleFlow.ts` (`marble-flow`): domain warp, glossy band tubes and arrival-time fronts. It is fragment-only and costs 0.31 ms at 720p.
- `src/scenes/library/slimeLight.ts` (`slime-light`): physarum agents with an excitable-medium burn and a nebula glow. It runs in compute.

The same three rules apply to every technique below:

1. **Sound makes matter.** An emitter adds stuff (ink, agents, chemical, fuel). The emission rate comes from `flux` and `energy`, colour from `centroid` and melody pitch, size from `bass`, and position from pitch.
2. **Beats ignite fronts.** An event starts a process at a point or along a feature. The process travels through the structure at a finite speed, and the structure is in a new lasting state behind it.
3. **The form keeps travelling.** Map `morph.at[]` through `wave()` onto the technique's own parameters. They are listed per technique.

## What makes these look premium

- **Relief shading from a gradient.** Treat a scalar field `h` (dye density, band profile, trail density) as a height. Then shade the normal `N = normalize(vec3(-k * grad(h), 1))` with a key light, a tight specular `pow(ndh, 60..120)`, and a fresnel or environment term. Flat 2D becomes glass. Take the gradient analytically when you can (see the band tubes below), and with central differences of exact noise (`noise4`) when you can't. Hardware-filtered noise terraces in normals.
- **Light at the rims.** Liquid neon is a dark glassy body with light gathered at its edges, so use `rim = pow(1 - N.z, 1.6)`. A matte, diffusely lit body reads as plastic.
- **Thin rainbow edges.** Turn the hue with the slope near grazing:
  `film = 0.5 + 0.5 * cos(TAU * (slope * k + vec3(0, .33, .67)))`, weighted by `pow(1 - N.z, 2..3)`.
- **Widths in pixels.** For any level-set line, the screen distance to the line is `(x - centre) / |grad x|`. Divide by the pixel size, then smoothstep over about one pixel. Lines stay crisp at any density.
  - Clamp the width to at least 0.75 px and scale the intensity by `width / clampedWidth`, so hairlines dim rather than alias.
  - Fade bands to their mean colour where the period drops below about 4 px.
- **Cap the physical width.** Where a warp is slack, the gradient goes to zero and the bands swell into blobs. Cap the width in field units (`rho = min(rho, 0.03 * |grad|)`), so slack regions draw lines and never blobs.
- **Palette inks, not raw `pal()`.**
  - Normalise each palette colour to its brightest channel.
  - Replace greys with a rotated copy of the most colourful entry.
  - Force the third ink round the hue circle when the palette's hues sit together. Otherwise warm or cold schemes collapse to one hue: Doorframe's palette failed the hue check until this was added.
- **Colour regions, not candy.** Neighbouring bands or strands should vary hue slowly (`b * 0.09`) with sparse accents (about 20% of bands at +0.5), not cycle every band.

## Domain warping (iq's fbm of fbm)

```
q = fbm2(p)
r = fbm2(p + A1 * q + c1)
f = g(p + A2 * r)
```

`fbm2` returns two decorrelated channels (`noise4(vec3(p, z)).xy` gives both in one call). `g` is the base shape: stripes `dot(w, dir)`, rings `length(w - c)`, or a mix of the two. A vortex twist `w' = c + rot(s * exp(-|w-c|²/R²)) (w - c)` before `g` gives ref05's swirl. Draw the *level sets* of `f`, not `f` itself:

```wgsl
let x = f * K;                        // K bands per unit
let fw = length(grad_f) * K / F.res.y;  // one pixel in band units
let dfr = x - (floor(x) + 0.5);       // signed distance to band centre (band units)
let s = clamp(dfr / rr, -1.0, 1.0);   // across-tube coordinate
let N = vec3f(normalize(grad_f) * s, sqrt(1.0 - s * s));  // analytic tube normal
let cov = smoothstep(rr + 0.7 * fw, rr - 0.7 * fw, abs(dfr));
```

Loop over the three nearest bands (`floor(x) - 1 .. + 1`) so halos and wide tubes don't seam at band boundaries.

- **Cost:** three field evaluations for the gradient, plus one per live front origin. With two octaves of `noise4` that is about 200 texel loads per pixel (0.31 ms at 720p).
- **Keep it liquid, not grainy:** use two octaves, a noise frequency of 0.7–1.4, an inner warp of 1–2.6 and an outer warp of 0.2–0.4.
- **Morph mapping:** `A1`, `A2`, the noise frequency, the twist strength and size, the band density, the stripe/ring mix and the stripe angle each get a `morph.at` coordinate. The noise `z` advances with `morph.travel * 0.11`.
  - Keep base motion slow. Lifts are measured against the motion in the 200 ms before an event, and band density amplifies any warp change.
- **Music:** fragment-only scenes have no persistent state, so lasting change uses phases and arrival-time fronts (next section). Emission uses the spectrum history:

  ```wgsl
  // Spectrum history flowing out of the emitter along the melody bands.
  let emitted = hist(fract(band * 0.137), dist_from_emitter / speed / 4.0);
  ```

## Arrival-time fronts (the shader-only burn)

For a front lit at `c` at time `t0`, the pixel is reached when `R(age) >= T(p)`. `T` must come from the structure itself, or you get a ring:

```wgsl
// x = band coordinate here, xo = band coordinate at the origin, d = screen distance.
// Fire runs along its own band almost freely and pays to cross to the next one; gaps conduct slower
// than ink (lag); each band catches with its own small delay (jag) so the front is fibrous.
fn arrive(x: f32, xo: f32, d: f32, lag: f32, jag: f32) -> f32 {
  return (0.055 * abs(x - xo) + 0.42 * d) * lag + jag;
}
fn radius(age: f32, tau: f32) -> f32 { return 2.4 * (1.0 - exp(-age / tau)) + 0.3 * age; }
let h = radius(age, 0.3) - arrive(...);    // h > 0: behind the front
let state = base + smoothstep(-0.035, 0.035, h);   // lasting change (hue step, width re-deal...)
let fire = exp(-max(h, 0.0) / 0.03) * smoothstep(-0.01, 0.0, h);  // hot edge, on the tubes only
```

- **Decelerate, don't accelerate.** A fire that catches fast and slows puts most of its visible change in the first 100 ms, which is what kick lift measures. An accelerating radius pushes the change into the next event's "before" window: marble-flow's kick lift went from 1.26 to 4.0 when this was flipped.
- **Ease the base, so nothing pops.** Keep two live fronts per kind plus a CPU-eased base value (`base += (count - 2 - base) * ease`). Regions no live front reaches then glide to the old state rather than jumping.
- **Different events, different processes:**
  - **Kick:** fire from a point on a golden-angle walk, white to orange. It steps the band hue one ink round.
  - **Snare:** an electric front from a line at a new angle. It re-deals band widths and brightness (new detail).
  - **Note:** from the pitch-placed emitter, in the note's colour. It recolours and re-widths the melody bands.

## Curl-noise advection

The velocity is `v = curl(psi)`. In 2D, `v = (dpsi/dy, -dpsi/dx)` for a noise potential `psi`. In 3D use `curl3` in `common.ts`. It is divergence-free, so particles and dye never bunch or thin out (Bridson et al. 2007). Add obstacles by ramping `psi` to zero at a boundary distance.

```wgsl
fn curl2(p: vec2f, z: f32) -> vec2f {
  let e = 0.01;
  let a = noise4(vec3f(p + vec2f(0.0, e), z)).x - noise4(vec3f(p - vec2f(0.0, e), z)).x;
  let b = noise4(vec3f(p + vec2f(e, 0.0), z)).x - noise4(vec3f(p - vec2f(e, 0.0), z)).x;
  return vec2f(a, -b) / (2.0 * e);
}
```

- **Uses:** move particles (`pos += v * dt`), or advect a dye texture semi-Lagrangian (`dye(p) = dyePrev(p - v * dt)`, with bicubic or MacCormack sampling to keep edges sharp).
- **Cost:** one compute pass of N particles or one texture pass. It is about the cheapest "fluid" there is.
- **Music:** emitters inject particles or dye (rate from `flux`, colour from `centroid`). Kicks add a lasting vortex: add `k * exp(-|p-c|²/r²)` to `psi` permanently, or step the noise `z` offset by `kickPhase`. Notes rotate the potential's octaves. Never scale `|v|` with a beat, which is a surge.

## Flow-field lines and streamlines (Tyler Hobbs style)

Here is the recipe. Make a grid of angles `theta(p)` from smooth noise or any designed field. Start many points and step each along `(cos theta, sin theta)` for a fixed length, then draw the polylines with constant width. Hobbs's guidance:

- Keep `theta` low-frequency.
- Use **collision-avoiding streamlines** for the premium look (Jobard and Lefer 1997): reject a new step if it comes within `d_sep` of any existing line. Evenly spaced, non-touching lines read as engraving or silk.
- Vary the line length and thickness sparingly.

On the GPU:

- **Particle streaks.** N seeds advect along the field each frame, and the trail texture keeps fading. This is the `sparse` lighten-trail look and costs N per frame.
- **Fragment-only.** Streamlines of a divergence-free 2D field are the level sets of its stream function `psi`. So draw `psi` as bands with the pixel-width method above: evenly spaced lines for free, no tracing. marble-flow is exactly this.
- **Music:** the field's angle offset steps with `notePhase` (the melody steers), line count or emission density follows the band energies, and kick fronts ignite along lines (arrival time measured along `psi` levels).

## Line integral convolution (LIC)

`I(p) = (1/2L) * integral of noise(sigma_p(s)) ds` for s in [-L, L], where `sigma_p` is the streamline through `p` (Cabral and Leedom 1993). It shows a whole vector field as fine combed fibres, like brushed metal, hair or silk smoke (ref10).

```wgsl
var acc = 0.0; var q = p; var wsum = 0.0;
for (var i = 0; i < 24; i++) {          // forward; repeat with -v for backward
  let w = 1.0 - f32(i) / 24.0;          // tent kernel
  acc += w * textureSampleLevel(whiteNoise, samp, q, 0.0).x;
  wsum += w;
  q += normalize(v(q)) * step;
}
```

- **Cost:** 2 × L samples per pixel (about 48 taps, a cheap fragment pass).
- **Premium:** use an emission texture of sparse dots, not white noise, so you get distinct fibres. Colour by speed or by a second field. Relief-shade the LIC intensity as a height for satin.
- **Animate:** advect the noise texture along the field ("flow LIC"), or phase the kernel (`sin(s * k - time)`) so fibres stream.
- **Music:** emission dots are spawned by the spectrum (density from band energies), the field's vortices are placed by kicks (lasting), and fronts run along the fibres. LIC is the natural carrier for an arrival-time front because the fibres are the conduction paths.

## Reaction-diffusion (Gray-Scott)

```
du/dt = Du * lap(u) - u v^2 + F (1 - u)
dv/dt = Dv * lap(v) + u v^2 - (F + k) v
```

The usual settings are `Du = 1.0` and `Dv = 0.5` with a 3×3 Laplacian (centre −1, edges 0.2, corners 0.05) and `dt = 1`. Alternatively use `Du = 2e-5` and `Dv = 1e-5` in physical units. Pearson's map has F (feed) on the vertical axis and k (kill) on the horizontal:

| Look | F | k |
|---|---|---|
| Coral and labyrinth stripes | 0.0545 | 0.062 |
| Mitosis (dividing spots) | 0.0367 | 0.0649 |
| Worms and loops (κ) | 0.050–0.066 | 0.063 |
| Solitons, spots | 0.030 | 0.062 |
| Waves and chaos (α, β) | 0.010–0.022 | 0.049 |

Moving along k with F fixed goes from solid to stripes to spots. Moving along F goes from stable to oscillating to chaotic. The interesting band is the thin curve near `k ≈ 0.06`. A spatially varying `F(p), k(p)` gives several patterns on one screen.

- **Cost:** ping-pong `rg16float` at half resolution, with 8–20 iterations per frame. Each is a 9-tap compute pass.
- **Premium:** render `v` as a height. Relief shading gives wet, glossy coral. Map `v` through a palette ramp, and edge-detect `|grad v|` for a thin bright outline.
- **Music:**
  - **Emitter:** writes `v = 1` (seeds) at a pitch-placed point, at a rate set by the flux. That is matter.
  - **Kick:** a lasting step of `(F, k)` along the morph heading within a region swept by a front, so the pattern visibly *grows into* a new morphology behind it. Reaction-diffusion is itself a front-propagating medium.
  - **Snare:** flips `Du/Dv` anisotropy along a line, combing the pattern.

  Never modulate F or k with an envelope; that just pulses.

## Excitable media: Greenberg-Hastings and the forest fire

**Greenberg-Hastings** has states 0 (rest), 1 (excited) and 2..n (refractory). The rules are:

- rest becomes excited if at least θ neighbours are excited;
- excited becomes 2;
- i becomes i + 1, and n becomes 0.

Fronts travel at one cell per step, annihilate on collision, and can't re-enter refractory tissue, so they look like fire through wire. The continuous version used in `liquidLight.ts` and `slimeLight.ts` keeps heat `x` (fast decay, the hot edge) and refractory `y` (slow decay, embers). A cell ignites when it is ready (`x < 0.1 && y < 0.25`), the hottest neighbour is above 0.4, and the local **fuel** (the structure: dye, trail density, fibre mask) is above a threshold. Conduction comes only from the structure, so the front follows fibres and branches where they branch.

```wgsl
let fuel = smoothstep(thr * 0.5, thr * 1.5, structureDensity);
var o = vec4f(s.x * exp(-h / tauHeat), s.y * exp(-h / tauRef), s.zw);
if (ready && best.x > 0.4 && fuel > 0.3 && strength > 0.25) {
  o = vec4f(1.0, 1.0, best.z, kind + strength);  // z = stamp (hue / behaviour), w = kind + reach
}
```

- **Speed:** a front moves one cell per step. Jump to a radius-2 ring for faster fronts, and run a whole number of fixed steps per frame (`BURN_HZ`) so the speed doesn't depend on frame rate.
- **Reach:** carry a strength in `fract(w)` that multiplies by 0.975–0.993 per hop. A front then dies out after a set distance, which leaves regions of different state.
- **Steel wool, exactly:** a **forest fire** CA (Drossel-Schwabl) has trees, fire and empty cells. Fire spreads to tree neighbours and leaves empty cells, and trees regrow with probability p. For a burn that *consumes* and then regrows, use fuel that the fire depletes (`fuel -= burn`) and that refills slowly from the emitter. Kicks are the lightning; flux and energy drive regrowth. The burnt-out channels are the lasting change.
- **Cost:** one 9–17-tap compute pass per step at half resolution. At 640×360 and 200 steps per second it is negligible.
- **Look:** heat ramps white, yellow, orange, using `vec3(1, .35 + .6h, .08 + .8h²) * (2.2h² + .4h)`. Embers are `(y - x)²` in deep orange. Mask both by the structure so fire never paints the background. Ignite only where the fuel is above about 0.35, or the ignition shows as a disc (the "ring of light" the user rejected).

## Metaballs and SDF blending

The field is `f(p) = sum_i r_i² / |p - c_i|²` (or exponentials), and the surface is where `f = 1`. With SDFs use the polynomial smooth minimum (already `smin` in `common.ts`):

```
smin(a, b, k) = min(a, b) - h² k / 4, where h = max(k - |a - b|, 0) / k
```

There is also the exponential version, `-k log(exp(-a/k) + exp(-b/k))`.

- **Premium:** the analytic gradient `sum_i -2 r² (p - c)/|p - c|⁴` gives the normal, so shade it as glass: refraction offset `N.xy * eta`, dispersion with three offsets for R, G and B, and a fresnel rim. Draw iso-contours of `f` as band tubes (as in marble-flow) for liquid neon instead of blobs.
- **Warning:** solid metaballs are "blobby melting shapes", which the user rejected. Use them as a *field* (contours, refraction source, conduction map), never as visible blobs.
- **Music:**
  - Balls are emitted by the spectrum: one per note, its radius from the bass, its colour from the centroid. They advect in a curl field.
  - A kick front changes `k` (blend softness) permanently behind it.

## Physarum (slime mould)

Each agent (Jones 2010) does four things per step:

1. **Sense** the trail at three points a distance `SO` ahead: forward, `+SA` and `−SA`.
2. **Rotate** by `RA` toward the strongest. Turn randomly if forward is the weakest, keep going if forward is the strongest.
3. **Step** `SS` and **deposit** `D`.
4. The trail map **diffuses** (3×3 mean, partially mixed) and **decays** by `(1 − e)`.

| Parameter | Typical | Effect |
|---|---|---|
| SA, sensor angle | 22.5°–60° | Smaller gives straighter, longer strands. |
| RA, turn | 15°–45° | `RA > SA` makes curly, cellular patterns; `RA < SA` makes networks. |
| SO, sensor reach | 6–25 texels | Sets the network's cell size. |
| SS, step | 1–1.5 texels | Speed. |
| decay | 0.05–0.15 per step | Higher gives thinner, darker networks. |

Multiple species (Sage Jenson's "36 points") can attract to their own trail and avoid others', for coloured territories.

The GPU layout in `slimeLight.ts`:

- **Agents:** an `array<Agent>` of `{ pos, ang, info }` (16 bytes). One million agents fit in 16 MB.
- **Deposits:** `atomicAdd` into a `u32` buffer in fixed point (RGB of the agent's colour, plus total density in alpha). Integer atomics are order-independent, so offline renders are deterministic.
- **Diffuse:** one pass reads the trail texture and the deposit buffer, writes the next trail, and clears the buffer with `atomicExchange`.
- **Ping-pong:** keep a persistent parity rather than copying textures.
- **Steps:** a fixed number of simulation steps per second (90).
- **Cost:** 1M agents plus 1280×720 diffuse is well under 1 ms per step on the dev GPU.

Rendering:

- Density `a` goes to `I = 1 − exp(−g a)`. Colour is `rgb / a`, re-saturated.
- Body is `pow(I, 1.6)`, with a white core of `pow(I, 8)`.
- Relief normal from the gradient of `I`, specular, and a slope-driven rainbow film.
- A quarter-resolution blur gives the nebula.
- Keep the background black by raising the decay and using a power curve, not by lowering exposure.

Music:

- **Matter:** a ring buffer respawns agents at a pitch-placed emitter: 1.5k–46k per second from `flux` and `energy`, each note opening it fully, the colour from pitch, centroid and note count, the spread from `bass`.
- **Steering:** every agent leans by `steer * sin(target − ang)`, where the target heading comes from the melody contour. A phrase combs the network.
- **Character:** SA, SO, RA, decay and deposit map to `morph.at`, so the network keeps changing what kind of network it is.
- **Beats:** a burn field (above) conducts only along strands. Agents that a front passes change for good:
  - **Kick:** the agent turns one ink round, once per kick (the agent stores the last kick id). Use a relative step, not "set to the kick's hue": an absolute stamp turns the whole connected network one colour within a few kicks.
  - **Snare:** the agent switches behaviour preset (long reach, tight curls or the morph's own), so a different network grows behind the front.
  - **Note:** the agent takes the note's colour, with a short reach.

  Agents then carry the change along the strands, so colour keeps propagating after the fire is gone.

## Gate notes

- Lift is "change in the 100 ms after" over "change in the 200 ms before". Fast base motion and long fronts both raise the denominator. Use decelerating fronts, a short hot edge (`tauHeat` of about 0.03 s) and slow base flow.
- The hue check bins 30° hues. Palette-derived inks need a forced contrasting accent (above), or warm and cold palettes fail.
- Test on Bass Face from 60 s (drums) and on Doorframe from 40 s (melody and a warm palette).

## Sources

- Inigo Quilez, *Domain warping*, https://iquilezles.org/articles/warp/
- Bridson, Hourihan, Nordenstam, *Curl-noise for procedural fluid flow*, SIGGRAPH 2007.
- Tyler Hobbs, *Flow fields*, https://www.tylerxhobbs.com/words/flow-fields
- Jobard and Lefer, *Creating evenly-spaced streamlines of arbitrary density*, 1997.
- Cabral and Leedom, *Imaging vector fields using line integral convolution*, SIGGRAPH 1993.
- Pearson, *Complex patterns in a simple system*, Science 1993. Parameter atlas: https://mrob.com/pub/comp/xmorphia/ and https://mrob.com/pub/comp/xmorphia/pearson-classes.html
- Greenberg and Hastings, *Spatial patterns for discrete models of diffusion in excitable media*, SIAM J. Appl. Math. 1978. Drossel and Schwabl, *Self-organized critical forest-fire model*, PRL 1992.
- Lu, Jaffer, Jin, *Mathematical Marbling*, IEEE CG&A 2012 (drop map `C + (P − C) sqrt(1 + r²/|P − C|²)`). See https://people.csail.mit.edu/jaffer/Marbling/Mathematics
- Jeff Jones, *Characteristics of pattern formation and evolution in approximations of Physarum transport networks*, Artificial Life 2010. Parameters as used in https://arxiv.org/pdf/1511.07654
- Sage Jenson, *Physarum*, https://sagejenson.com/physarum
