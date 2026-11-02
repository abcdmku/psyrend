# Conformal geometry for cheap, immersive 2D worlds

Complex analysis gives full-screen structure for the cost of a few complex multiplies per pixel. Conformal maps preserve angles, so a crisp pattern stays crisp through the map, and its local scale is known exactly from the derivative. That is enough for perfect anti-aliasing with no `dpdx`. Two prototypes use these ideas:
- `src/scenes/library/mobiusFlow.ts` (`mobius-flow`): 0.24 ms GPU at 1080p, post chain included.
- `src/scenes/library/drosteZoom.ts` (`droste-zoom`): 1.3 to 2.8 ms, depending on the tile family and phrase transitions.

For comparison, `fold-space` costs 2.7 to 4.2 ms.

Conventions below: complex numbers are `vec2f`, and `z` is the screen point with y up (`q = (uv*2-1)*vec2(aspect,-1)`). Every technique fills the frame, and all have the same three hooks for music:
1. A continuous parameter that `Morph` drives.
2. An integer or discrete structure that is fixed per cue from the DNA.
3. A *structure coordinate* that a front can travel along.

## Shared helpers

```wgsl
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
fn cdiv(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / dot(b, b); }
fn cinv(a: vec2f) -> vec2f { return vec2f(a.x, -a.y) / dot(a, a); }
fn clog(a: vec2f) -> vec2f { return vec2f(0.5 * log(dot(a, a)), atan2(a.y, a.x)); }
fn cexp(a: vec2f) -> vec2f { return exp(a.x) * vec2f(cos(a.y), sin(a.y)); }
```

**The anti-aliasing rule for every map.** For an analytic `w = f(z)`, one screen pixel covers `|f'(z)| * 2/res.y` units of w. A stripe or edge pattern drawn in w-space is box-filtered at that footprint:

```wgsl
let fw = length(fprime) * 2.0 / F.res.y * stripesPerUnit;   // one pixel, in pattern units
// exact box filter of the band |x| < hw by a pixel of width fw centred at x:
let cov = max(0.0, min(x + 0.5*fw, hw) - max(x - 0.5*fw, -hw)) / fw;
// below ~3 px per period the pattern is only noise: fade it to its mean (or to black)
let detail = 1.0 - smoothstep(0.22, 0.55, fw);
```

For a real-valued level-set function such as `sigma = Re(c * log f)`, the screen gradient is `conj(c * f'/f)`. Its direction gives the in-plane normal for gloss shading, and its length gives the line width. Both are exact.

**Colour rule (learned the hard way).** The palette's `palL` normalises by luma. That makes blues and magentas huge in RGB and leaves pastel palettes whitish once auto-exposure (gain up to 1.6) and ACES have run. For neon on black, take the palette *hue*, rebuild it at saturation 0.72 to 0.95, and even out perceived brightness with `c * lvl * pow(0.4 / luma(c), 0.55)`. Guarantee two hues by giving a structural half of the elements (half of every bundle, alternate sectors) a hue rotated 0.36 to 0.38 turns. Keep the melody colour inside the palette family, or it collides with the accent.

---

## 1. Möbius transformations and loxodromic flows (prototype: `mobius-flow`)

**Maths.** `M(z) = (az+b)/(cz+d)`. Every non-identity Möbius map is conjugate to `w -> k w` through `w = (z - z1)/(z - z2)`, where z1 and z2 are its fixed points. In `log w`, the flow `w -> w * exp(t(α + iβ))` is a straight-line translation, so the flow lines are straight lines in log space:
- **Elliptic** (β only): circles through both fixed points, the field lines.
- **Hyperbolic** (α only): Apollonian circles, the equipotentials.
- **Loxodromic** (both): double spirals from the source eye into the sink eye.

**Generalisation used in the prototype.** Take a rational function `f = Π (z-a_i)/(z-b_i)` with paired zeros and poles. Then:

```
log f = L + iθ,   L = Σ log|z-a_i| - Σ log|z-b_i|,   θ = Σ arg - Σ arg
f'/f  = Σ 1/(z-a_i) - Σ 1/(z-b_i)
σ     = a·L + (n/2π)·θ         // bands are σ*M = integer
∇σ    = (a·d.x + b·d.y,  b·d.x - a·d.y),  d = f'/f,  b = n/2π
```

**Branch cuts.** Every `atan2` jumps by 2π, so `θ` jumps by 2π and `σ` jumps by n. If n (arms) and M (stripes per arm) are integers, the band index taken mod `n*M` is continuous across every cut. Nothing else is needed. The pitch `a` is free and continuous: it winds bands from spokes (a = 0) into tight spirals.

**Topological morphs that are continuous.** A zero/pole pair placed at a common centre cancels exactly. Separating it from 0 grows a new dipole out of a point, turning the field into a quadrupole with saddles where the bands branch. Moving the eyes is free.

**Along-band coordinate.** Along a level set of σ, `L` is strictly monotone (`Im(c log f)` is linear in L there), so L parametrises each band from source to sink. **Trap:** in the far field L ≈ 0 over most of the screen, so a front timed in L floods huge areas at once. Use screen distance from an ignition point for the along-band term. Keep the band-index distance as the across-band term:

```wgsl
T = length(z - z0) / (v * (0.7 + 0.6*h)) + circDist(band, band0, n*M) * jump * (0.4 + 1.2*h);
```

Here h is a per-band hash. The result runs along fibres, fans out band by band and splits at the saddles.

**Look.** Treat each band as a glossy tube. The profile `t = x/hw` gives height `sqrt(1-t²)` and normal `normalize(vec3(gdir * t/h, 1))`, where gdir is the unit screen gradient. Add a coloured fresnel rim and a restrained specular. Bands of hashed widths (thick, hairline, gap) look like ref05. Cap the half-width at about 3.5% of the screen height in pixels, so far-field bands never become wide flat slabs. The eyes fade to black where bands drop below a pixel, which reads like ref07's black core.

**Music.**
- **Melody pitch:** winds the spiral (`a += 0.35 * pitch`, eased over 70 ms). This is what made melody legible (lift 1.0 became 1.6).
- **Kick:** fire bursts from the source eye. Behind it, bands step hue for good.
- **Snare:** a cool crackle from the sink. Behind it, band widths are re-cut (eased).
- **Note front:** lit at a height set by pitch. Behind it, bands take the note colour.
- **Flow:** the σ phase advances with `morph.travel` (bands stream source to sink). Keep it slow (0.13 × travel) or `corr` drops below 0.25.

## 2. Log-polar, Droste and Escher zooms (prototype: `droste-zoom`)

**Maths.** `w = log z = (ρ, θ)` turns scaling into translation in ρ and rotation into translation in θ. A pattern that is periodic in w under the lattice Λ, with `2πi ∈ Λ`, maps back to a seamless, self-similar picture. Zooming is a slide in ρ and never ends. De Smit and Lenstra's analysis of Escher's *Print Gallery* is exactly this: a quotient `C*/q^Z`, with the complex exponential providing the twist. [Leiden Escher/Droste site](https://pub.math.leidenuniv.nl/~smitbde/escherdroste/page_menu=intro&sub=people.html), [Jos Leys](https://www.josleys.com/article_show.php?id=82), [K. Conrad on C*/q^Z](https://kconrad.math.uconn.edu/blurbs/grouptheory/CstarqZ.pdf).

**A lattice that contains 2πi for every shape.** Pick integers (p, q), coprime, and any complex τ with Im τ > 0:

```
e1 = 2πi / (p + qτ),  e2 = τ·e1      ⇒  p·e1 + q·e2 = 2πi
lattice coords: x + yτ = w / e1
```

This means τ (square, rhombic, hex, sheared) morphs continuously while p (tiles around) and q (spiral arms) are fixed per cue. Cells `(i, j)` and `(i+p, j+q)` are the same tile, so `kid = i·q - j·p` is a period-invariant tile id for hashing (it is complete when gcd(p, q) = 1).

**Endless flight with persistent tiles.** Slide along e2 by s, and pass `fract(s)` as a continuous offset and `floor(s)` as an integer carry added to j. Tiles keep their identity, and therefore their burnt state, while they stream past. The radial component is `Re(e2) = -2π·Im(τ)·p / |p+qτ|²`, which is always negative. Use it to convert a steady ρ speed into `ds/dt`.

**Off-axis bend.** Before the log, apply the disk automorphism `m(z) = (z-b)/(1-conj(b)z)`. The Jacobian stays analytic:

```wgsl
let den = vec2f(1,0) - cmul(vec2f(b.x,-b.y), z);
let mz  = cdiv(z - b, den);
let jac = (1.0 - dot(b,b)) / dot(den,den) / length(mz);   // |dw/dz|
let argJ = atan2(mz.y,mz.x) + 2.0*atan2(den.y,den.x);      // rotate w-dirs to screen
```

**The cheap 3D trick.** In a tunnel seen down its axis, perspective acts only along log-radius. A block of height H on the wall shows its top shifted inward by Δρ ∝ H, and its near face lies between. So a heightfield parallax march along +ρ in w-space, from the top level down, gives real extruded blocks like ref04:
- Use 10 steps plus 4 bisection steps.
- Use a cheap 3×3 Voronoi with an F2−F1 edge estimate inside the march, and the exact 4×4 cell only for the final hit. This cut the cost from 6.3 ms to 0.9 ms.
- Seams count as height 0, so they are real gaps with neon grout down in them.

**Anti-aliasing.** The pixel footprint in lattice units is `jac * 2/res.y / |e1|`. Draw seams with the box-filter formula. Tiles under about 4 px near the vanishing point fade into a fog glow, never into dust.

**Fronts.** Cell-to-cell arrival time is computed from the lattice offset reduced mod 2πi:

```wgsl
var d = cmul(e1, vec2f(di, 0) + dj*tau);  d.y -= TAU*round(d.y/TAU);
T = |d·ê1|/vAlong + |d×ê1|/vAcross + 0.12*hash(kid) + 0.25*dot(pixelOffset, dir)/vAlong;
```

Fire races round the spiral rows, spreads ring to ring more slowly, and each tile fills from the side the fire comes from.

**Music.**
- **Kick:** fire lit deep in the tunnel. Tiles it burns step hue, and block heights are re-rolled as it passes, so the relief itself changes for good.
- **Snare:** a crackle lit nearer. Behind it a new set of tiles becomes glowing glass.
- **Melody:** pitch shears τ (`τx += 0.4·pitch`), so the spiral leans with the line. The note front tints the tall blocks.
- **Chords:** lean the morph. Travel is the flight.

**Variant: a true Droste of an image.** Apply `w' = w · (1 + i·log(r)/2π)^-1` (Escher's twist), then `ρ' = fract(ρ'/log r)·log r`, then `exp`. Any annular picture becomes a spiral that contains itself. Feed it the previous frame (`histTex`) for an infinite feedback zoom.

## 3. Domain colouring

**Maths.** Colour each pixel by `arg f(z)` (hue) and `log|f(z)|` (brightness bands). Wegert's *enhanced phase portraits* add contour lines of phase and of modulus, which makes zeros and poles read as points where all colours meet ([AMSI explainer](https://amsi.org.au/?p=12447), [complex-analysis.com](https://complex-analysis.com/content/domain_coloring.html)). Good functions:
- Blaschke products `Π (z-a_k)/(1-conj(a_k)z)`, which are unimodular on the unit circle and look like a ring of eyes.
- `z^n`, `sin z`, `exp(1/z)` (an essential singularity: infinite detail).
- Rational functions with moving roots.

**WGSL sketch.**

```wgsl
let fz = ...; let lf = clog(fz);
let ph = lf.y / TAU * nPhase;           // phase isolines
let md = lf.x / log(2.0);               // one band per doubling of |f|
let g  = length(fprime / fz) * 2.0 / F.res.y;   // |d log f / dz| per pixel
let linePh = 1.0 - smoothstep(0.0, g*nPhase/TAU*1.5, abs(fract(ph)-0.5)*... );
```

Both contour families are level sets of `Re` and `Im` of `log f`. They share the footprint `|f'/f|`, so one number anti-aliases both. Never draw raw HSV phase at full screen, because it reads as a test pattern. Instead use the palette for phase, keep black between thin contours (neon), and fade the contour density near zeros and poles.

**Music.**
- **Roots:** each root is a morph coordinate. Roots braid around each other with the melody, and the braid is visible as phase spirals.
- **Kick:** a root jumps one step along its orbit. A lasting change.
- **Fronts:** travel in `log|f|` near zeros (fine there) but in screen distance far away (the same trap as section 1).

## 4. The Poincaré disk, the half-plane and hyperbolic tilings

**Maths.** A Schwarz triangle (p, q, r) with `1/p + 1/q + 1/r < 1` tiles the disk by reflections. Each reflection is a mirror line or an inversion in a circle orthogonal to the unit circle ([Heidelberg notes](https://hegl.mathi.uni-heidelberg.de/?p=726)). The shader folds the point into the fundamental triangle and counts the folds:

```wgsl
for (var i = 0; i < 24; i++) {
  var flips = 0;
  // mirror 1: x-axis; mirror 2: line at angle π/p; mirror 3: circle centre c, radius r
  if (z.y < 0.0) { z.y = -z.y; flips++; }
  let m = vec2f(-sin(PI/p), cos(PI/p)); let dd = dot(z, m);
  if (dd > 0.0) { z -= 2.0*dd*m; flips++; }
  let v = z - c; let r2 = dot(v,v);
  if (r2 < R*R) { z = c + v * (R*R / r2); scale *= R*R / r2; flips++; }
  parity += flips; if (flips == 0) { break; }
}
```

The accumulated `scale` (the product of `R²/r²`) is the conformal factor. Line width is `pix * scale`, which is the same Jacobian rule. Fold parity gives a checkerboard, and the fold count gives depth (tiles near the rim have high counts).

**Immersion.** Apply a disk automorphism `m_b` with `b` moving steadily. That is hyperbolic translation: you fly through an infinite tiling and tiles never get closer. With `b(t)` along a geodesic it is a loxodromic glide, like section 1 inside the disk. `hyperbolic-dome` already exists in 3D; this 2D version costs about 1/10 of that.

**Music.**
- **Fronts:** fold count is a natural arrival time (`T = foldCount * delay + hash`). A beat ignites at the centre tile and the front crosses one generation of tiles per delay. It branches exactly as the tiling does, which is the "steel wool" brief done by the group itself.
- **Morph:** p, q, r are discrete, but the circle mirror can morph between valid triangles, or blend two tilings across a front.
- **Kick:** steps the colouring generation, permanently.

## 5. Circle inversion, Schottky groups and Kleinian limit sets (Indra's Pearls)

**Maths.** Pair up 2g disjoint circles. Each generator maps the outside of one circle to the inside of its partner. The limit set (the "pearls") is the closure of all infinite words ([Indra's Pearls overview](https://www-users.york.ac.uk/~ss44/books/pages/w/DavidWright.htm)). Kissing circles give parabolic generators, and the Apollonian gasket is one example.

**Shader approach.** Run inverse iteration per pixel. While the point lies inside any generator circle, apply that generator's inverse to send it out, and count the steps. The count is the word length, which shows how deep in the pearl necklace the pixel is. The distance estimate comes from the accumulated derivative (for an inversion, `R²/|z-c|²`):

```wgsl
var dz = 1.0; var n = 0;
for (var i = 0; i < 40; i++) {
  var hit = false;
  for (var k = 0; k < 4; k++) {
    let v = z - C[k]; let r2 = dot(v,v);
    if (r2 < R[k]*R[k]) { z = C[k] + v*R[k]*R[k]/r2; dz *= R[k]*R[k]/r2; n++; hit = true; }
  }
  if (!hit) { break; }
}
let de = distToCircles(z) / dz;     // screen distance to the nearest pearl boundary
```

Draw `de` with `smoothstep(pix, 0, de)` for crisp necklaces at every depth. Fade where `dz` exceeds about 1e4 (sub-pixel pearls) to a glow, not dust.

**Music.**
- **Morph:** circle radii and the trace parameters (Maskit or Riley slice) morph the necklace continuously, but leaving the slice turns it to dust. Clamp ranges and test the extremes.
- **Fronts:** word length is the arrival time. A front propagates from the outer circles into ever smaller pearls, so a beat "drips" down the necklace.
- **Melody:** pitch picks which generator's pearls light.

## 6. Conformal tunnels: `log z` and friends

`log z` turns the screen into an infinite cylinder, so any periodic strip pattern becomes a tunnel. Variants:
- `log(z - a) - log(z - b)`: a two-ended wormhole, the Möbius flow of section 1.
- `log(sinh z)` or `log(z^n - 1)`: n tunnels braided together.
- `z^k` before the log: k-fold symmetric tunnels. Use a non-integer k only with a matching θ period.

Line width is always `|w'| * pix`, and depth fog is `exp(-max(-ρ, 0) * k)`. Keep a pixel-size fade toward each vanishing point, or the centre turns into moiré. Fly by sliding ρ with `morph.travel`, never with beats.

## 7. Complex iteration: Julia and Mandelbrot with smooth orbit traps

**Maths.** Iterate `z <- z² + c`. Use smooth escape `ν = n - log2(log|z|)`, plus traps: the minimum distance of the orbit to a point, a line or a circle, and which iteration achieved it. Use the distance estimate `G/|G'| ≈ 0.5·|z|·log|z| / |dz|` with `dz <- 2 z dz` for crisp filaments. Width is `smoothstep(pix, 0, de)`, so no supersampling is needed.

**Look.** Trap distance gives the glossy channels (shade them as tubes as in section 1). Trap iteration index gives the colour family. Black interior and thin neon filaments. Keep the iteration count low (≤ 10 to 64 at 2D cost), and lerp `c` along a path through interesting regions (the main cardioid's boundary `c = e^{iφ}/2 - e^{2iφ}/4` is safe everywhere).

**Music.**
- **Morph:** `c` traces the cardioid boundary with the morph, and melody pitch picks φ, so the Julia set's topology follows the tune.
- **Fronts:** the trap's iteration index is a ready-made arrival time (`T = trapIter * delay + hash`). A beat lights the outermost orbit layer first and crawls inward through the filaments, branching where the set branches.
- **Kick:** steps the trap shape (point to line to circle) behind its front.

---

## Phrase redefinition and energy (RULES v5)

**A Droste portal for new looks.** A tunnel must not keep one look for more than a phrase. Keep two tunnel states A and B, each with its own `(τ, p, q, slide s, family, extrusion, hue)`. Each phrase, B gets new p and q and follows the morph's new region. Pixels with `ρ < ρ_b(θ)` use B, so the new tunnel appears at the vanishing point:
- The ragged ring at `ρ_b` rides out with the tiles and strides further on every kick.
- When the ring leaves the screen, B becomes A.

Each march sample picks its own state, so blocks of both tunnels stay correct across the ring. `droste-zoom` packs both states into the 32 parameter floats with a few tricks: `P*64+Q` in one float, a single slide `s` (fract and carry), and two pitches in one float.

**Families that blend continuously** on one lattice:
- Voronoi blocks.
- Organic cells: jittered lattice points with the same bisector edge formula.
- Triangles: seams through the cell centre, perpendicular to `1`, `τ` and `τ-1`.
- Truchet: quarter arcs in lattice coordinates, flipped by a period-invariant hash. These are continuous across cells for any τ.

**Energy.**
- **Travel:** drive the flight, roll and twist from `morph.travel`, smoothed over about 1 s. Raw travel follows the bass contour (80 ms attack), and every wobble then jerks the whole tunnel.
- **Surge:** multiply by `1 + k·morph.surge` so drops rush (`scripts/drops.mjs` rush 2.0 to 5.2 for both prototypes).
- **Twist:** a corkscrew `θ += k(t)·ρ` in log space is a cheap bass twist. Keep it small outside drops.

## Lessons from building the prototypes

- **The gate renders at 96×54.** A shader that fades or flattens detail by pixel footprint (`detail`, extrusion depth) shows the gate a flat fog, and the beats become invisible to it. Compute the footprint against `max(F.res.y, 540)`.
- **Beat changes must land within 100 ms, and must not keep moving into the next beat's window.**
  - Ease your own lasting steps over about 50 ms.
  - Shape from `morph.flowAt` and add your own fast steps, instead of `morph.at`, whose steps ease over a third of a beat.
  - Ignite fronts where the large on-screen elements are (near the viewer in a tunnel), so the big pixels change on the hit.
  - Let fronts finish in about 150 ms.
  - Avoid global changes on every melody note (a lattice shear three times a second fills every kick's before-window).
- **Neon on black survives every palette.** Dim warm colours on large areas read as olive or brown mud. Keep surfaces near black and put the colour in rims, seams, fresnel and glass.

- **Lifts come from lasting structural steps, not light.** Kick and snare passed easily because `Morph` steps the shape. The melody passed only once pitch drove a structural parameter (spiral winding, lattice shear).
- **`corr` drops when constant motion is large.** Thin crisp lines turn small continuous drifts into big pixel differences. Keep flow phases slow and let the morph steps carry the change.
- **Decay a front's light with the event age.** Use `exp(-age * 1.3..2)`, so the head is brightest at ignition and change concentrates after the onset. The lasting state change still travels the full distance.
- **Never time a front in a coordinate that saturates.** Examples are log-modulus in the far field and fold depth near a limit circle. Mix in screen distance.
