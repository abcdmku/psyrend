# Pattern, symmetry and line-art techniques

Cheap 2D and 2.5D fragment techniques that can carry a whole world. Each costs a handful of ALU ops per pixel and no raymarch. They read as immersive art, not flat wallpaper, when three things hold:

1. **The pattern is mapped onto a space you are inside:** a tunnel, a floor and ceiling, or a log-polar zoom.
2. **It is anti-aliased by its own derivative,** so detail fades to its mean instead of turning into dust.
3. **The music rewrites the pattern's own parameters behind travelling fronts.**

Two working prototypes use this page: `src/scenes/library/quasiTunnel.ts` (`quasi-tunnel`) and `src/scenes/library/neonHarmonics.ts` (`neon-harmonics`).

## Shared recipes

### Mapping a pattern into space

| Mapping | Pattern coordinates `(u, v)` | Footprint per pixel | Notes |
|---|---|---|---|
| Tunnel (ray vs cylinder `r = 1`, camera on axis) | `u = atan2(p.y, p.x)`, `v = p.z` with `p = rd / length(rd.xy)` | `dv = t / cos` grows with depth | `u` wraps: any wave in `u` needs an integer angular number |
| Floor and ceiling (planes `y = ±h`) | `z = h f / abs(q.y)`, `x = q.x z / f` | `~ z² / (h f)` along depth | The horizon is a natural dark vanishing band. Roll the screen for walls or diagonals. |
| Log-polar (conformal zoom) | `(log r - travel, θ)` | `~ 1 / r` | Self-similar zoom. Patterns must be periodic in `θ` (period 2π). |
| Inversion / Möbius | `z → (az + b) / (cz + d)` | `abs(dw/dz)` | Turns straight stripes into circle families. Good for moiré. |

Depth cues are what make it read as a place: fog by depth (`exp(-k t)`), line width falling with depth, a dark vanishing point, and a slight darkening of the nearest surface so the mid-distance is the focal zone.

### Anti-aliasing any pattern by its own derivative

Write every pattern as a smooth scalar `v` whose level sets are the lines or stripes. Then:

```wgsl
let fw   = max(fwidth(v), 1e-4);               // period units per pixel
let x    = fract(v) - 0.5;                     // distance to the stripe centre, in periods
let cov  = sat((w - abs(x)) / fw + 0.5);       // box-filtered coverage of a stripe of half-width w
let fade = sat(fw * 2.5 - 0.3);                // stripes nearing the pixel size...
let c    = mix(cov, 2.0 * w, fade);            // ...fade to their mean, never alias
// Lines: distance in pixels = abs(v - round(v)) / fw; core = sat(widthPx + 0.5 - dpx); halo = exp(-dpx / r)
```

- `fwidth` needs uniform control flow. Compute `v` before any per-pixel `if`. Loops and branches on `S.p` are uniform.
- `v` must be continuous. For an angle, take the derivative of two `atan2` copies with opposite cuts: `min(fwidth(atan2(y, x)), fwidth(atan2(-y, -x)))`.
- Anything hashed per stripe (hue per band, random delays) also aliases. Multiply it by `1 - fade`.
- For a stripe pattern this is Quilez's analytic box filter; a triangle filter is steadier under slow camera motion. For lines, a 1-pixel core plus an exponential halo reads as neon and survives bloom.

### Music: continuous morph plus lasting changes swept in by fronts

- **Continuous:** feed `morph.at[i]` through periodic maps into the pattern's phases, amplitudes, densities and view axis. Use `morph.travel` for travel.
- **Lasting change behind a front:** keep each event's change as old and new values (TS folds the previous step into an accumulator when the next event arrives). The shader blends them by the front's progress at the pixel:

```wgsl
let T  = arrival(p);                    // seconds for the front to reach p, built from the structure
let e  = eventAge - T;                  // >0 once the front has passed
let pk = smoothstep(0.0, 0.04, e);      // 0 ahead, 1 behind: param = mix(old, new, pk)
let edge = smoothstep(-0.03, 0.0, e) * exp(-max(e, 0.0) / 0.035);  // thin hot edge only
```

- **Make `T` ragged by the structure, never a clean shell.** Add a per-band or per-fibre delay `hash(floor(v0)) * 0.03`. Make dense regions conduct faster: `dist / (v0 + v1 * density)`. Or measure distance along the fibre (the potential `φ` in a flow, or the line index across lines).
- **What `qa.mjs` taught us** (measured, not guessed):
  - Glowing edges and embers that decay over 0.3 s or more mostly raise the *baseline*. The next event's 200 ms pre-window catches them, and the lift falls. Turning the fires off cut motion from 11% to 4% and raised the lead lift from 1.2 to 2.0. Keep the edge thin (τ ≈ 35 ms), make embers faint and slow (τ ≈ 0.8 s, about 8%), and let the lasting change carry the reaction.
  - Fronts should finish their visible sweep in about 100–150 ms. A front that takes 5 or more frames spreads its change past the 3-frame lift window.
  - Big `Morph` scales (above 2) give eased kick and snare steps that last about 6 frames and bury the melody. Use a scale around 1.2 to 1.3 and scale the mapping instead.
  - `m.leadPitch` and `morph.notePitch` glide, so at the attack frame they still hold the *previous* note. Read the real pitches from the score in the shader: `leadAt(0.04 - leadAge).x` is the new note and `leadAt(-0.04 - leadAge).x` the old one.
  - The `qa` palette changes on every run (lifts vary by about ±0.3). For decisions, use `audit.mjs react --variant 0.13|0.47|0.81 --nolook`, which is deterministic.
  - Pale palettes kill the hue count. Mix about 50% of a spectral wheel at the same `t` into `pal(t)`. Before output, apply a hue-preserving roll-off, `c / (1 + 1.2 * max(c))`, so bright bands don't bleach in ACES.

## The 17 wallpaper groups and rosettes

**Math.**
- Every periodic 2D pattern has one of 17 symmetry groups. Each is a lattice (oblique, rectangular, centred rectangular, square or hexagonal) plus a point group (rotations of order 1, 2, 3, 4 or 6, with or without mirrors and glides).
- Rosettes are the finite cases: cyclic `Cn` (rotation only) and dihedral `Dn` (rotation plus mirrors).
- A fragment shader *folds* the pixel into the fundamental domain, then draws any motif there.

```wgsl
// Rosette Dn: fold the angle into one mirrored sector.
let a = atan2(p.y, p.x); let s = PI / n;
let af = abs(fmod(a + s, 2.0 * s) - s);          // D_n; drop abs() for C_n
let q = length(p) * vec2f(cos(af), sin(af));
// p6m (hexagonal, mirrors): reduce to a hex cell, then fold the D6 rosette.
fn fmod2(p: vec2f, r: vec2f) -> vec2f { return p - r * floor(p / r); }
fn hexCell(p: vec2f) -> vec2f {
  let r = vec2f(1.0, 1.7320508); let h = r * 0.5;
  let a = fmod2(p, r) - h; let b = fmod2(p - h, r) - h;
  return select(b, a, dot(a, a) < dot(b, b));
}
// p4m: q = abs(fract(p) - 0.5); if (q.y > q.x) { q = q.yx; }   // square cell + D4 fold
```

**Immersion.**
- Fold the *tunnel* coordinates `(θ n / 2π, depth)`, so symmetry repeats round the bore and down it.
- Or fold in log-polar coordinates, so the symmetry zooms toward you for ever.
- Layer two copies at different depths with fog between them for parallax.
- The motif in the domain should be a soft field (a distance or a smooth noise), not a hard shape, or it reads as tiles.

**AA.** Fold seams are continuous (mirrors), so `fwidth` of the folded field is safe. Rotation-only `Cn` seams are continuous too.

**Music.**
- Morph the motif inside the domain: the Wythoff point, a blob position, a line angle.
- The group itself can step on section changes (p4m to p6m), crossfaded.
- Beats: a front travels outward cell by cell. Use `T = cellDistance(cellId) * 0.03 + hash(cellId) * 0.02`, and each cell flips to a new motif state when the front passes.

## Quasicrystals (sum of plane waves, de Bruijn, Penrose)

**Math.**
- Sum of plane waves: `f(p) = (1/n) Σ_{i<n} cos(K (cos β_i, sin β_i) · p + φ_i)`, with `β_i = β0 + π i / n`.
- No lattice fits n ≥ 4 directions (other than 6), so `f` is quasiperiodic with 2n-fold local symmetry. n = 5 gives Penrose-like rosettes, n = 4 the Ammann–Beenker 8-fold pattern, n = 6 a 12-fold one.
- Moving the phases `φ_i` is a **phason flow**: rosettes open, merge and re-form, a smooth journey through every local configuration. That makes it a natural morph target.
- de Bruijn's pentagrid: five families of parallel lines `p·e_i + γ_i = k`. The integer vector `(⌈p·e_i + γ_i⌉)_i` indexes a lattice point in 5D, and projecting it gives the exact Penrose rhombus tiling.

```wgsl
// Pentagrid → Penrose: which rhombus a point is in (cheap; 5 dot products).
var k: array<f32, 5>;
for (var i = 0; i < 5; i++) { let e = vec2f(cos(TAU * f32(i) / 5.0), sin(TAU * f32(i) / 5.0)); k[i] = ceil(dot(p, e) + gamma[i]); }
// The tile's vertex = Σ k[i] e_i; the edge distance comes from fract(dot(p, e_i) + gamma_i) per family.
```

**On a tunnel, seamlessly** (used by `quasi-tunnel`): round each wave's angular number to an integer, `m_i = round(K R cos β_i)`, `kz_i = K sin β_i`, and `f = Σ cos(m_i θ + kz_i z + φ_i)`. The field closes exactly round the bore and stays quasiperiodic along it, with no mirror seam.

**Making it art.**
- Draw *iso-contours* of `f` (or of `f·amp + carrier`, below) as stripes. Thresholding `f` gives blobs; contours give op-art.
- Shade each stripe as a tube (`ny = sqrt(1 - (x/w)²)`, a narrow specular at `nx ≈ -0.4`) for gloss.
- Colour by `f` and angle across a wide palette range.

**Music.** Phases from `morph.at` give continuous phason flow. Each kick slides the contour level and steps the hue behind a front from the lens. A note changes the phase of the wave selected by its pitch class, behind a front from the pitch's angle.

## Op-art: Riley, Vasarely, moiré, stripe warping (ref11, ref12)

**Math.**
- Riley-style stripes are the level sets of `v = carrier + warp`. The carrier is a linear phase (`z · pitch + θ · arms / 2π` on a tunnel; integer `arms` keeps it seamless and spirals it). The warp is any smooth field: a quasicrystal, a sum of a few sines, a vortex.
- Moiré is the beat between two stripe families `v1`, `v2`. Its lines are the level sets of `v1 - v2`, so you can design the moiré directly.
- Vasarely's bulges: displace a grid by a radial lens `p' = p · (1 + a · exp(-|p - c|² / s²))` and shade the cells by the lens's slope.
- Checker tunnel (ref12): `checker = sign(sin(π u)) * sign(sin(π v))` on tunnel coordinates. Box-filter it with Quilez's closed form: integral of the square wave, `tri(x) = abs(fract(x/2) - 0.5)`, differenced over `±fw/2`.

```wgsl
let v = f * amp + z * pitchZ + th * arms / TAU + off;   // warped spiral stripes on a tunnel
let fw = max(fwidth(f * amp + z * pitchZ) + dth * abs(arms) / TAU, 1e-4);
```

**Immersion.** Op-art is strongest on a tunnel or a converging floor, where perspective compresses the stripes into a dark vanishing core. Keep 50% duty and real black between the stripes, and let the near stripes be big and glossy.

**AA.** This is the most alias-prone family: fade by `fwidth` and fog the far end hard (`exp(-0.3 z)`).

**Music.** Kick: a level slide of 0.3–0.45 periods plus a palette step. Snare: a new arm count (the spiral rewinds behind an angular front) and alternate stripes recoloured by parity. Melody: line weight and hue set by the note's pitch class, plus a level slide.

## Truchet tiles and their animation

**Math.**
- Per cell, pick a random orientation `r = hash(cell) < 0.5` and draw two quarter-arcs at opposite corners. The arcs join into endless meandering paths.
- Distance to the arc: `d = abs(length(q - corner) - 0.5)`, with `q = fract(p)` mirrored by `r`.
- Multi-scale Truchet (Carlson): subdivide some cells into four half-size cells with inverted colour, so paths flow between scales.
- Arc length along the path: `s = angle * 0.5 * π / 2` per cell. A global along-path coordinate needs the cell's path parity, so use `fract(s + checker(cell) * 0.5)` to keep the flow direction consistent.

```wgsl
let c = floor(p); var q = fract(p) - 0.5;
if (hash12(c) < 0.5) { q.x = -q.x; }
let s = sign(q.x + q.y + 1e-6);                 // which corner pair
let d = abs(length(q - 0.5 * s) - 0.5);          // distance to the nearer arc
```

**Immersion.** Map onto a tunnel wall with `u = θ N / 2π` (integer N) and `v = depth`. Draw the arcs as neon tubes with a halo, and let the paths carry light pulses along `s`.

**AA.** `d / fwidth(d)` for the line. Fade the tiles to mean grey-light once a cell is under about 4 pixels.

**Music.**
- **Kick:** fibres burn. Light runs along the connected paths from an ignition cell, with arrival time = path length. Approximate it as `cellDistance * 0.04 + s * 0.02` for a ragged, path-following front.
- **Snare:** flips the orientation of the cells a front passes (`r` XOR a front mask). The paths rewire behind the front, a lasting structural change.

## Voronoi and Worley with smooth edges

**Math.**
- F1 is the distance to the nearest feature point and F2 to the second. `F2 - F1` approximates the cell edge.
- The exact edge distance (Quilez): run a second pass over the 3×3 cells and take `dot(0.5 * (mi + mj) - x, normalize(mj - mi))`.
- Smooth Voronoi: `-log(Σ exp(-k d_i)) / k` gives rounded, organic cells.
- Animated points: `o = 0.5 + 0.5 sin(t + TAU * hash2(cell))`.

```wgsl
var md = 8.0; var mr: vec2f; let n = floor(x); let f = fract(x);
for (var j = -1; j <= 1; j++) { for (var i = -1; i <= 1; i++) {
  let g = vec2f(f32(i), f32(j)); let o = 0.5 + 0.5 * sin(phase + TAU * hash22(n + g));
  let r = g + o - f; let d = dot(r, r); if (d < md) { md = d; mr = r; } } }
// Second pass for the edge distance: for cells with dot(mr - r, mr - r) > 1e-5,
// edge = min(edge, dot(0.5 * (mr + r), normalize(r - mr)))
```

**Immersion.**
- Use it as a cell foam on a tunnel or as stained glass lit from behind (cells glow, edges dark).
- Or extrude: height = smoothed F1 gives pillowed cells with a cheap analytic normal from the gradient of F1.
- Two layers at different scales and depths give parallax.

**AA.** Edge distance divided by `fwidth`. Fade cell colours (hashed) with the footprint.

**Music.**
- Moving the feature points by `morph.at` makes the cells divide and merge continuously.
- Kick: a front that hops cell to cell (`T = graphDistance * 0.03`), recolouring each cell for good.
- Snare: new seed points appear behind a front (detail revealed: increase the cell density inside the swept region).

## Phyllotaxis

**Math.** Vogel's model gives point `k` at radius `c √k` and angle `k · 137.507°` (the golden angle). Varying the angle off golden makes spirals (parastichies) appear in Fibonacci counts. Inverse lookup per pixel: estimate `k ≈ (r / c)²` and test the few nearest indices `k ± m · F_n` (Fibonacci neighbours), so the cost is O(1).

```wgsl
let k0 = floor(pow(length(p) / c, 2.0));
var dmin = 9.0;
for (var j = -12; j <= 12; j++) {                  // neighbours along the parastichies
  let k = max(k0 + f32(j), 0.0); let a = k * 2.39996323; let r = c * sqrt(k);
  dmin = min(dmin, length(p - r * vec2f(cos(a), sin(a))));
}
```

(Testing the Fibonacci offsets 1, 2, 3, 5, 8, 13, 21, 34 instead of a contiguous window is cheaper at large k.)

**Immersion.** Wrap the spiral onto a dome overhead, or into log-polar coordinates so it zooms toward you for ever (phyllotaxis is self-similar under `r → r φ`). Draw each element as a glossy bead or a neon ring.

**AA.** Bead radius against the footprint. Fade beyond the radius where beads are under about 3 px.

**Music.** The divergence angle is the morph: `137.5° ± 2°` reshapes the spirals continuously (an off-golden angle produces spokes). Kick: a front runs outward *along the spiral index*, `T = k * 1e-4`, which follows the parastichies. Notes light the parastichy whose family index equals the pitch class.

## Harmonographs, Lissajous and Fourier epicycles, as light rather than plots

**Math.**
- Harmonograph: `x(t) = Σ A_i sin(f_i t + φ_i) e^{-d_i t}`, and the same form for `y`.
- Lissajous: `(sin(a t + δ), sin(b t))`.
- Epicycles: `z(t) = Σ c_k e^{i k ω t}`.
- To draw a *curve* in a fragment shader, take the distance to the polyline sampled at N points (N ≈ 64–200). Or, cheaper, splat it in a compute pass into an accumulation texture and blur.

**Make it light, not a plot.**
- Draw 20–60 copies, each with a slightly different phase (`φ + i ε`), as thin neon lines with halos. You get a *ribbon of light*, a ruled sheet, rather than one line.
- Put the curve in 3D (`z(t)` as a third harmonic) and project with perspective, so the ribbon passes near and far with depth-scaled width and fog.
- Accumulate with feedback trails (`meta.sparse: true`), so the figure is drawn by a moving pen of light.

**AA.** Analytic distance to segments, `sat(w + 0.5 - d/px)`, plus an exponential halo.

**Music.** The frequency ratios come from the chord (root intervals as integer ratios: a fifth is 3:2, a third 5:4), so harmony literally shapes the figure. Notes add a damped partial at the note's ratio. Kicks advance the pen's phase permanently.

## String art and ruled surfaces

**Math.**
- String art: lines from `P(i)` to `P(m · i mod N)` on a circle make cardioids and nephroids as envelopes.
- A ruled surface `S(u, v) = (1 - v) A(u) + v B(u)`, between two curves, gives a hyperboloid when the curves are twisted circles.
- Per pixel, the distance to a family of lines: for line `i`, `d_i = abs(cross(p - a_i, dir_i))`. Loop over N ≈ 64 lines, or invert analytically for circle-to-circle families.

**Immersion.**
- A hyperboloid of light threads seen from inside (a tunnel of straight threads whose envelope is a curved waist) is very striking.
- Two twisted families crossing give a moiré.
- Depth-scale the thread width and use fog.

**AA.** Thread core 1 px plus halo. Beyond about 1 thread per 2 px, fade to the mean.

**Music.** The twist (offset `m` or angle) is the morph. Kicks step `m` (the envelope changes shape behind a front that runs along the threads, `T = v` position along each thread). Snares recolour alternate threads.

## Neon line fields (ref15, ref16), via harmonic stream functions

**Math** (used by `neon-harmonics`):
- Lines are iso-contours of a *stream function* ψ of a 2D potential flow. Any harmonic function works.
- With a uniform stream plus periodic rows of point vortices (period L along the stream):

  `ψ(x, y) = U y - Σ_k (Γ_k / 4π) · ln( sin²(π(x - x_k)/L) + sinh²(π(y - y_k)/L) + ε )`
- The rows are periodic along the flow, so travel never runs out.
- `ε` (about 0.06) gives each vortex a soft Rankine-like core, so no bullseye of rings forms (they read as eyes). Keep `abs(Γ) / L` small against `U`, or the closed cat's-eye loops grow large.
- For `abs(y)` > 9 L/π, use the asymptote `2 abs(π y / L) - ln 4`. Raw `sinh²` overflows.
- The along-line coordinate (the potential φ) carries light pulses and propagation fronts *along* the fibres.

```wgsl
fn lnsin(a: f32, b: f32, L: f32) -> f32 {
  let u = PI * a / L; let v = PI * abs(b) / L; let s = sin(u); let sh = sinh(min(v, 9.0));
  return select(log(s * s + sh * sh + 0.06), 2.0 * v - 1.3863, v > 9.0);
}
let s = (psi + offset) / spacing; let fw = fwidth(s);
let dpx = abs(s - round(s)) / fw;                        // pixels to the nearest line
let line = sat(wpx + 0.5 - dpx) + 0.3 * exp(-dpx / haloPx);
// Adaptive density: where lines are > ~20 px apart, fade in half- and quarter-spacing lines.
```

**Immersion.**
- Put ψ on a floor and ceiling (`z = h f / abs(q.y)`) and roll the screen to any angle: diagonal sheets, walls or floors.
- The horizon is a dark vanishing band like ref15. Line width and brightness fall with depth.
- Lines that merge near the horizon fade to their mean, dimmed (otherwise it smears).
- Band-limit the light pulses by `fwidth` of their phase (otherwise they alias into dashes).
- For ref16's undulating terrain instead: draw N depth slices `y_i(x) = H(x, z_i)` projected by perspective, with distance `abs(sy - y_i(sx)) / sqrt(1 + slope²)`, looping over about 48 slices.

**Music.**
- Rows drift and breathe with `morph.at`.
- **Kick:** fronts run down every fibre from the lens, each at its own pace (`T = z / (110 + 60 · hash(line))`). Behind them the lines are stepped round the palette.
- **Snare:** a front hops *across* fibres from one line outward (`T = abs(k - k0) · 0.0015`) and slides all lines to new streamlines (a ψ offset). Alternate lines take a second colour.
- **Melody:** the note re-tunes and nudges one vortex row (the lines bend behind the front). Its pitch class sets the line weight, the hue and the pitch of the light pulses along the lines. A bundle of lines at the pitch's place holds the note's colour.

## Sources

- [Quasicrystals: projections of the 5D lattice into 2 and 3 dimensions (arXiv math-ph/0606028)](https://arxiv.org/pdf/math-ph/0606028)
- [arXiv 1306.6698 (pentagrid and quasicrystal geometry)](https://arxiv.org/pdf/1306.6698)
- [Quasicrystal shader (sum of plane waves, 5–12 fold)](https://www.shadcn.io/shaders/quasicrystal-shader) and [Penrose tiling shader](https://www.shadcn.io/shaders/penrose-tiling-shader)
- [Inigo Quilez: checker filtering](https://iquilezles.org/articles/checkerfiltering/), [triangle-filtered checkers](https://iquilezles.org/articles/morecheckerfiltering), [filterable procedurals](https://iquilezles.org/articles/filterableprocedurals)
- [GPU Gems ch. 25: fast filter-width estimates](https://developer.nvidia.com/gpugems/gpugems/part-iv-image-processing/chapter-25-fast-filter-width-estimates-texture-maps)
- [Blender Voronoi node (smooth F1, distance to edge)](https://docs.blender.org/manual/en/dev/modeling/geometry_nodes/texture/voronoi.html)
- [Multi-scale Truchet patterns (Bridges 2018)](https://archive.bridgesmathart.org/2018/bridges2018-39.html), [truchet R package](https://www.github.com/paezha/truchet)
- Background (standard results): Conway, Burgiel and Goodman-Strauss, *The Symmetries of Things* (wallpaper groups); de Bruijn (1981), the pentagrid; Vogel (1979), phyllotaxis; Lamb, *Hydrodynamics* (vortex rows, the Kelvin–Stuart cat's eye).
