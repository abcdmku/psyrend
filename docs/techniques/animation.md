# Animation for music: rules and maths

How to make abstract visuals move like music, with few elements. The helpers live in `src/scenes/anim.ts`. The worked example is `src/scenes/library/phraseBloom.ts` (`phrase-bloom`).

## 1. The four rules as maths

| Rule | What it means in code |
|---|---|
| Motion is constant and fluid, never static | Positions are **integrals of rates**: `x += rate(music) * dt`. The music sets the rate, never the position. The rate has a floor (`morph.flow >= 0.35`), so nothing stops. |
| Beats change things for good | A beat adds 1 to a **counter**. What you see is `f(easedCounter)`, where `f` is periodic or monotonic. Nothing in the picture is `f(envelope)` when the envelope decays back to 0. |
| Reactions propagate through structure | Each point `p` has an **arrival time** `T(p)`, measured along the structure. A point changes when `age > T(p)`, not when the event happens. |
| Every motion has a musical cause | Every duration is in **beats** (`spb = 60 / bpm`). Every free-running clock is beat-tied (`morph.travel`). Noise is advanced by musical time, never by wall time. |

The core idiom comes from TouchDesigner: feed audio into a *Speed* CHOP (integrate it) rather than into the parameter itself. Audio drives the speed. The integral is smooth, keeps rising and never snaps back.

## 2. Timing constants (relative to tempo)

`b = spb(bpm)` is one beat in seconds. At 120 bpm, `b = 0.5 s`.

| What | Duration | Why |
|---|---|---|
| State change after a kick or snare (ease-in) | `b/3` (0.08–0.25 s) | Short enough to read as caused by the hit. Long enough to read as motion, not a cut. Matches `morph.ts`. |
| Hot front edge width | `0.05–0.1 b` | Crisp leading edge. |
| Embers cooling behind a front | `0.2–0.5 b` | Must finish before the next hit, or the "before" frames stay busy and the next hit doesn't read. |
| Front crossing the visible structure | `1–1.7 b` (soft-capped) | Must finish within **two** event intervals (see `frontState`). |
| Melody bend or comet travel | `~1 s` or `2 b` | Follows the phrase contour, not every onset. |
| Chord lean | `1 bar` (settle halflife ≈ 2 s) | Harmony is slow, so it moves slowly. |
| Phrase arc | 8 bars (4 in fast or short forms) | The unit of build and release. |
| Section or drop transition | `1–2 bars`; ignite on the downbeat | The biggest lasting change in the song. |
| Activity rise / fall | 1 s / 10 s | Only long quiet slows the flow. |
| Overlap delay between parts | `0.05–0.15 b` per part | Reads as one gesture, not as separate events. |

## 3. Easing and springs

**First-order settle.** Exact for any `dt`, never overshoots. Use it for lasting state changes:
```ts
x = goal + (x - goal) * 2 ** (-dt / halflife);   // anim.settle
```

**Critically damped spring** (Holden's exact form). Both position and velocity stay continuous, so a goal that jumps on a beat becomes an S-curve with no kink. Use it for anything visible that a step drives: a camera heading, a layer that follows another, a smoothed parameter.
```ts
const y = (2 * Math.LN2) / halflife;              // damping / 2
const j0 = x - goal, j1 = v + j0 * y, e = fastNegExp(y * dt);
x = e * (j0 + j1 * dt) + goal;
v = e * (v - j1 * y * dt);                       // anim.Spring
```

**Never underdamped.** A spring with damping ratio below 1 swings past the goal and comes back. That is a pulse, and it breaks the beat rule. "Overshoot" here means follow-through in *space* (a part that lags, see §5), never a value that bounces back in time.

**Easing curves**, all mapping `[0,1]` to `[0,1]`:
- `smooth` = `x²(3−2x)`: the default for a front's colour blend.
- `smoother` = `x³(10−15x+6x²)`: when the second derivative must also be 0, for camera paths.
- `outCubic` = `1−(1−x)³`: a hit, with a fast start and a soft landing.
- `inCubic` = `x³`: anticipation, slow into a downbeat.
- `outExpo`: a long tail.

`easeBeats(age, bpm, beats, fn)` gives the progress of an eased transition measured in beats.

## 4. Lasting change that travels

**Arrival time along fibres.** A front runs fast along the structure (streamlines, veins, ribbons) and hops slowly across it. A per-fibre jitter `h` makes each fibre burn at its own speed, so the front comes out ragged, like steel wool:
```wgsl
T = abs(along) / vAlong * (0.65 + 0.7 * h) + abs(across) * hop * (0.6 + 0.8 * h);
T = Tmax * (1.0 - exp(-T / Tmax));   // soft cap: every front finishes in Tmax beats
```
Useful "along" coordinates:
- the **potential** φ of a 2D flow (streamline length);
- the imaginary part of a conformal map;
- the arclength parameter of a ribbon;
- an orbit-trap channel's iteration index.

The level-set index (`floor(psi * N)`) counts how many fibres a front crosses.

**Lasting state behind two fronts.** A kick can land while the previous kick's front is still travelling, so carry the latest two:
```wgsl
state = max(count - 2, 0) + ease((prevAge - prevT) / e) + ease((age - T) / e);  // anim_frontState
```
Map `state` through something periodic (a hue rotation, `pat(floor(state))`, a fold angle), so every event moves the structure to somewhere new.

**Heat** is light only, layered on top of the change:
```wgsl
heat = ease((age - T + edge) / edge) * exp(-max(age - T, 0) / ember);         // anim_frontHeat
```
Colour the heat white to yellow to orange by its value. Add sparks where `heat` is high and a cell hash passes a threshold.

**Colour changes that survive any palette.** Rotate the colour about the grey axis (`pb_rot`) rather than only offsetting `pal(t)`. A one-hue director palette makes `pal(t + 0.1)` invisible, but a rotation still reads.

## 5. The 12 principles, translated to abstract music visuals

| Principle | Abstract meaning | Psyrend recipe |
|---|---|---|
| Timing | Duration carries meaning: fast means percussive, slow means harmonic | Durations in beats, as in the §2 table |
| Slow-in, slow-out | No linear starts or stops | `smooth`/`smoother` for blends, a critically damped spring for anything driven by steps |
| Anticipation | Tension before the event | Ahead of a drop, `music.anticipation` and `toNextDrop` tighten, refine or compress the structure (`phraseArc().tension`). Never move the camera in anticipation. |
| Follow-through | The parts keep going after the main action stops | Behind a front, embers cool over `0.3 b`. The new state is already in place. |
| Overlapping action / drag | Parts lag the leader by different amounts | `FollowChain`: layer *i* follows layer *i−1* with a halflife times 1.6 to 3.5 (the ceiling trails the floor in `phrase-bloom`). Per-part delay `overlapDelay(i, n)`. |
| Secondary action | A second, smaller motion supports the main one | Light streaks stream down every line at the steady `morph.travel` pace. Spectrum bands modulate line brightness. |
| Arcs | Natural paths are curves | Move in shape space along a heading that melody notes bend (`morph.ts`). Map coordinates through sin/cos, never along straight lerps. |
| Staging | One readable idea, clear focus | One structure per cue. Fog and dark gaps leave a focal area. Only one event owns each property (§6). |
| Exaggeration | Push the change past "barely visible" | A lasting step must be visible: about a 30° hue rotation, or a fully reshuffled pattern, or a fold step of 0.1–0.2 rad |
| Squash and stretch | Volume-preserving deformation | In abstract work, fronts stretch along the fibre direction and stay thin across it (vAlong is much larger than 1/hop) |
| Solid drawing | Consistent 3D space | A real perspective plane or SDF, so depth cues (fog, convergence) agree |
| Appeal | Clean, intentional shapes | Pixel-footprint anti-aliasing. Fade per-fibre detail to its average where fibres go sub-pixel. |

## 6. Ownership: one musical event per visual property

VJ practice: a screen reads clearly when each property has **one** owner, and the owners work on **different timescales**. If two events drive the same property, neither reads.

| Musical event | Timescale | Owns | Never touches |
|---|---|---|---|
| Kick | 1 beat | Lasting **hue step** or form step, carried by a fire front from deep ahead along the fibres | Camera, speed, scale |
| Snare | 2 beats | Lasting **pattern** change (colour layout, detail level), carried by a fast front that hops *across* fibres | Hue base |
| Hat or onset flux | sub-beat | Spark emission rate, streak density (secondary motion) | Anything lasting |
| Melody note | 0.25–2 beats | A **ribbon or comet at pitch position** in pitch colour, travelling along the structure; the heading bend in shape space | Global colour |
| Chord | 1–4 bars | The **region of shape space** the form leans toward (`morph.harm`); the palette via the director | Fast motion |
| Energy / `morph.flow` | seconds | The **rate** of every integral (travel, streaming, morph speed) | Positions directly |
| Phrase (8 bars) | 8 bars | **Tension**: finer detail, tighter glow, compression. A **release front** on the downbeat that turns the palette for good | Per-beat anything |
| Section / drop | 16–64 bars | A new world, or a full-field front that changes the largest property (topology, density) | — |
| Spectrum (centroid, bands) | continuous | Colour and size of emitted matter; per-fibre brightness | Geometry |

Rules of thumb:
- **Timescale separation.** Adjacent layers should differ by at least 2× in timescale. Kick (1 b), snare (2 b), phrase (32 b) and section (128 b) separate cleanly. Hats and kicks don't, so give hats only secondary motion.
- **Distinct front signatures.** Each event's front differs in origin, speed and topology: the kick from a point deep ahead running *along* fibres, the snare from a struck fibre jumping *across* them, the melody along the fibre at pitch position.
- **Keep the baseline calm.** The gate's lift compares the frames after an event to the frames before it. Busy secondary motion and long embers raise the baseline and hide every event. Keep secondary motion low-contrast and finish embers inside one beat.

## 7. Phrase arcs

```ts
const { index, pos, tension, release } = phraseArc(m.barIndex, m.barPhase, 8, m.anticipation);
// pos      0..1 through the phrase
// tension  = inCubic(pos)·0.8 + 0.2·pos + 0.6·anticipation (clamped): slow build, steep at the end
// release  = exp(-barsSinceDownbeat / 0.6): fast decay after the phrase downbeat
```
- **Build.** Tension refines the structure rather than moving it. Hairlines appear between the fibres, the glow tightens and contrast rises. Smooth the tension with a spring whose halflife is about 2 beats, so it never steps.
- **Drop or phrase downbeat.** Fire a broad front (from the horizon or the whole field) that makes the *largest* lasting change of the phrase. Use `EventTrack` on the phrase index so it is an event with an age like any other.
- **Release.** The tension detail relaxes over about a bar. Because the downbeat front has already installed a new state, the release reads as "breathing out into somewhere new", not as going back.
- **Breakdown.** `morph.flow` eases the rates down over about 10 s. The motion slows but never stops.

## 8. How the reference loops get their feel, with less

The references (smooth flowing liquid, ethereal light, cosmic waves, neon tunnel) and Beeple, Notch and TouchDesigner loops share a few habits:
1. **Few elements, many instances.** One primitive (a line, a ribbon, a band) repeated by a field. `phrase-bloom` is one 2D flow drawn as its own streamlines on two perspective planes. It has no SDF march and costs about two potential evaluations per front.
2. **Constant velocity plus slow curvature change.** The camera or pattern streams at one speed, and the field bends slowly. Acceleration is rare and always eased.
3. **Depth from convergence and fog**, not from geometry: lines converging to a vanishing point, light falling off with distance, dark gaps.
4. **Two or three hues, separated by structure** (per fibre or per layer), on black. Highlights roll off and nothing clips.
5. **Detail at one scale, AA'd.** Lines are about 1.5 px wide with a soft halo (`fwidth`). Where they go sub-pixel, they merge into an average glow instead of moiré.

Where to find "along the structure" coordinates cheaply:
- 2D potential flow `w = U·z·e^{-iα} + Σ μ/(z − z_k)`: Re is along the flow and Im is across it. Soften the dipoles with `/(|d|² + a²)`. Avoid `log` terms, which have branch cuts.
- Conformal maps (`exp`, `log`, `z^n`, Möbius) for tunnels and spirals.
- Polar or log-polar for vortices (ref07) and tunnels (ref12, ref15).

## 9. Anti-patterns (fail on sight)

- `x = base + k * F.kick`: an envelope drives a position, so the shape goes out and comes back.
- `scale *= 1 + beatPulse`, FOV punches, a camera `z += kick`.
- Spherical shells (`exp(-(|p - o| - age·v)²)`): this is a ring of light, not propagation.
- `time`-driven noise with no beat-tied clock: it does its own thing.
- An underdamped spring on anything a beat drives.
- Per-fibre hashes where the fibres are sub-pixel: sparkle noise.
- Embers longer than the event interval: the next hit disappears.

## Sources

- Daniel Holden, "Spring-It-On: The Game Developer's Spring-Roll-Call": exact critically damped springs. https://theorangeduck.com/page/spring-roll-call
- Ryan Juckett, damped simple harmonic oscillator; the Harmonica port: https://github.com/charmbracelet/harmonica
- Unreal Engine `FCriticalDamper` (clamping a critically damped spring near settle): https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/GameplayCameras/FCriticalDamper
- Follow-through and overlapping action (drag cascades along a chain): https://blog.cg-wire.com/follow-through-overlapping-action
- TouchDesigner beat detection; driving time-based visuals from beats: https://derivative.ca/tags/beat-detection
- TouchDesigner audio-reactive basics (Select, Math and Filter CHOP chains): https://interactiveimmersive.io/blog/touchdesigner-3d/audio-reactive-visuals-a-beginner-guide/
- Thomas and Johnston, *The Illusion of Life* (1981): the 12 principles.
