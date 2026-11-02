# Writing a scene

A scene is one visual world. The director picks scenes per song section, crossfades between them, and feeds them the music. Each scene lives in its own file in `src/scenes/library/` and default-exports a factory. `src/scenes/registry.ts` discovers the files automatically.

Two scene kinds exist:

- **`raymarchScene`** (`src/scenes/raymarchScene.ts`): one fullscreen fragment shader. You write `fn scene(uv: vec2f, frag: vec2f) -> vec4f`, which returns linear HDR color. `uv` is `[0,1]` with y down. `frag` is the pixel coordinate.
- **`particleScene`** (`src/scenes/particleScene.ts`): a GPU particle system. You write `simulate`, `shade` and `background`. The template does compute dispatch, camera projection and motion-blurred streak rendering. See `library/attractorSwarm.ts`.

Reference implementations are `library/fractalCathedral.ts` (raymarch) and `library/attractorSwarm.ts` (particles).

## DNA: one scene, hundreds of visuals

Psyrend's goal is that a viewer almost never sees a recognisable visual twice within 15–30 minutes. Every cue is a *genome*: a scene, eight DNA genes, a post look, a palette scheme and feedback styling. A novelty memory (`src/director/novelty.ts`) picks genomes unlike anything shown in the last 30 minutes. That only works if **different DNA genuinely looks different**.

- `ctx.dna[0..7]` are eight genes in `[0,1)`, fixed for the cue. `ctx.variant` equals `dna[0]`. Copy the genes you need into `S.p[...]` in `params()`.
- Map **at least five genes to structure**, not colour. Structure means:
  - form family or topology (choose between 3–6 genuinely different constructions with `floor(gene * N)`)
  - symmetry or fold count
  - density and scale
  - camera rig: orbit, fly-through, crane, dolly, or a top-down/low-angle variant
  - material model: matte, metal, glass, emissive wireframe, or translucent
  - lighting setup
  - motion grammar: what the beat does
- Two random DNAs should read as two different visuals to a casual viewer, and the scene must look good across the **whole** `[0,1)^8` space. Sweep it with `--variants`.
- `ctx.evolve[0..3]` (`F.evolve` in WGSL) wanders slowly, with periods of about 45–115 s. Use it for continuous morphing within a long cue, so even one cue never sits still.
- Avoid hidden state in module scope. If you must keep spring state, key it by scene and reset it on large time jumps.

### Palette schemes vary widely

Schemes range from noir and glacier to pastel and acid. Use the palette for **hue**, and control **brightness** yourself with lighting, `palL(t, lum)` and `palRampL(t, lum)` (palette hue at a fixed luminance). A scene that is perfectly exposed with one scheme can wash out with another if it uses `pal()` as raw albedo.

## What a shader can read

`src/gpu/shaders/common.ts` is prepended to every scene.

`F` holds the per-frame uniforms shared by all scenes. The layout is in `src/gpu/frameLayout.ts`.

| Field | Meaning |
|---|---|
| `F.res`, `F.aspect` | Render-target size (dynamic resolution, so don't assume a size). |
| `F.time`, `F.dt` | Wall-clock seconds and frame delta. |
| `F.travel`, `F.spin`, `F.warp` | **Integrated** motion phases (monotonic). They speed up with energy and tempo. Use these for camera motion and rotation, never `F.time * audioSpeed` (that jitters when the speed changes). |
| `F.beatPhase`, `F.barPhase` | 0→1 sawtooth across each beat / bar. |
| `F.beatPulse`, `F.barPulse` | Decaying pulse at each beat / downbeat. |
| `F.kick`, `F.snare`, `F.hat`, `F.onset` | Decaying envelopes at detected hits, sample-accurate. |
| `F.kickNext` | Rises *into* the next kick (look-ahead). Use it to pre-swell. |
| `F.energy`, `F.energySlow` | Loudness 0..1 (fast / ~1 s smoothed). |
| `F.sub`, `F.bass`, `F.lowMid`, `F.mid`, `F.high` | Band levels 0..1. |
| `F.centroid`, `F.flatness`, `F.percussive`, `F.flux` | Brightness, noisiness, drum share, spectral change. |
| `F.valence`, `F.arousal` | Emotion, 0..1. |
| `F.tension`, `F.majorness`, `F.chordPulse`, `F.chordHue` | Harmony: tension relative to the key, major/minor colour, pulse on chord change, chord root on the circle of fifths. |
| `F.anticipation` | 0→1 ramp in the bars *before* a drop or big arrival (look-ahead). Build tension: compress, darken, shake, slow down, and gather energy. |
| `F.dropPulse` | Decays from 1 at the drop. Release everything. |
| `F.sectionProgress` | 0→1 through the current section. |
| `F.intensity` | The director's overall intensity, 0..1. |
| `F.morph` (vec4) | Random per-cue vector, glides over ~4 beats when the section changes. |
| `F.morph2` (vec4) | Per-chord vector, glides over ~¾ beat on each chord change. `.w` = chord tension. |
| `F.pal0..pal3` | The director's palette in linear RGB. `pal0` is a deep shadow, `pal1` and `pal2` are the main hues, `pal3` is a bright accent. It follows key, chord, and mood. |
| `F.seed` | Current cue's variant. |

The scene's own uniforms are `S.p[0..7]` (eight `vec4f`). You fill them on the CPU in `params(ctx, p)`, where `p` is a `Float32Array(32)` and `p[4*i + c]` is `S.p[i][c]`. `ctx` gives `music` (a full `MusicState`), `variant` (cue seed 0..1), `intensity`, `travel`, `spin`, `time`, `dt`.

Particle scenes reserve `S.p[0..5]`. Only `S.p[6]` and `S.p[7]` (floats 24..31) are free.

## Helpers in `common.ts`

- **Math:** `sat`, `fmod`, `fmod3`, `rot2`, `rotX/Y/Z`, `rotAxis`, `lookAt(ro, ta, roll) -> mat3x3f`, `smin`, `smax`, `sdBox`, `sdTorus`, `sdOcta`, `sdCapsule`
- **Hash and noise:**
  - `hash11/12/13/33` are float hashes. Use `pcg(u32)`, `hashU(u32)` and `hashU3(u32)` for particle indices, because float hashes of large indices band.
  - `ign(frag)` is a per-frame dither for ray starts.
  - `noise3`, `noise4` and `fbm3(p, octaves)` interpolate exactly (8 texel loads per call). Use them for normals and heightfields.
  - `noise4fast`, `noise3fast` and `fbmFast` use one hardware-filtered sample each. They are about 8× cheaper and fine for volumes and flow, but they terrace if you take their normals.
  - `curl3` returns curl noise.
- **Color:** `pal(t)` (cyclic palette gradient), `palRamp(t)` (shadow to highlight), `hsv2rgb`, `cosPal`, `luma`
- **Audio:** `spec(x)` (smoothed spectrum at frequency position `x` in 0..1), `hist(x, age)` (spectrum history, `age` 0 = now to 1 ≈ 4 s ago), `chromaAt(i)` (pitch class 0..11), `beatEnv(k)`

Do not redefine these names. Prefix your own helpers (`gy_map`, `cb_normal`, and so on). Every scene is compiled into its own module, but a collision with `common.ts` fails compilation.

## Rules that keep scenes good together

1. **Exposure.** Output linear HDR. Keep average screen luminance around 0.08–0.25. Emissive highlights can reach 5–15, but only over small areas, because bloom picks them up. Auto-exposure exists but its gain is clamped (0.25×–1.6×), so a scene that is white everywhere stays white. Check with `--nopost`.
2. **Use the palette.** Color comes from `pal()`, `palRamp()` and `F.palN`, so every scene follows the song's key and mood. Hard-coded colors are for small accents only.
3. **React on several time scales.** Each scene must respond to:
   - hits: `kick`, `snare`, `hat`, `beatPulse`
   - timbre: bands, `spec()`
   - harmony: `morph2`, `chordPulse`, `tension`
   - structure: `morph`, `anticipation`, `dropPulse`, `intensity`

   Look-ahead fields make the difference. Gather tension on `anticipation` and release on `dropPulse`. Pre-swell on `kickNext`.
4. **Real 3D.** No flat 2D patterns. Use camera motion with parallax, lighting, depth fog, and occlusion. Morph geometry, not just color.
5. **Variants.** Use `ctx.variant` in `params()` to choose sub-variants (fold sets, attractor pairs, color mappings, camera paths), so a scene that returns later in a song looks related but not identical.
6. **Performance.** Pinned alone at 1280×720, a scene should cost about ≤ 1.5 ms of GPU time on the dev GPU (RTX 5080). Use at most ~128 march steps. Scale the hit epsilon with distance (`h < 0.0005 * t`). Use cheaper SDFs for normals and AO, and `fbmFast` for volumes. Dynamic resolution compensates, but cheap scenes stay sharp.
7. **Frame-rate independence.** The app runs at 60–480 Hz. Anything stateful (particle integration) must use `F.dt`. Shaders are otherwise stateless functions of the uniforms.
8. **Feedback mode.** Set `sparse: true` in `meta` if the scene is mostly light on black (particles, lines). Its trails then glow (lighten blend). Surface scenes get a short echo instead. `trails` (0..1) is the scene's appetite for trails.
9. **Director metadata.** `meta.energy` is the section-energy range the scene suits. `meta.mood` is the preferred valence and arousal. `meta.genres` gives genre affinity (0..1). Choose honestly: they drive which songs and sections get the scene.

## WGSL gotchas

- No swizzle assignment: `p.xy = ...` is invalid. Rebuild the vector: `p = vec3f(r * p.xy, p.z)`. Single-component assignment (`p.x = ...`) is fine.
- No ternary operator. Use `select(falseVal, trueVal, cond)`.
- `%` on floats truncates. Use `fmod` for a positive modulo.
- Loops with `break` are fine. Arrays you index dynamically must be `var`, not `let`.
- `smoothstep(a, b, x)` with `a > b` works and inverts the ramp.
- Integer and float types never mix implicitly: write `f32(i)`, `1.0` not `1`.
- Reserved or shadowing names break compilation in surprising ways. Avoid `set`, `ref`, `target`, `active`, `type`, `meta`, `filter`, `from`, and never name a local after a helper (`spec`, `dot`, `pal`).
- `select()` cannot pick between matrices, and its operands must have the same type (`select(vec3f(0.0), v, c)`, not `select(0.0, v, c)`). `fmod` is scalar-only; use `fmod3` for vectors.

## Verifying

```sh
export PATH="/c/nvm4w/nodejs:$PATH"     # Windows dev box: node via nvm
node scripts/verify.mjs --scenes <id> --times 8,30,46,80,97 --out artifacts/<id>
node scripts/verify.mjs --scenes <id> --times 46 --nopost --out artifacts/<id>-raw
node scripts/contact.mjs artifacts/<id>/sheet.jpg artifacts/<id>/*.jpg --cols 3
```

The harness plays the built-in demo song in real GPU Chrome, pins your scene, seeks to each time, and screenshots. It prints `fps`, `gpu` ms and render scale, and it exits non-zero on WGSL or console errors.

Demo song landmarks (128 BPM, A minor):

| Time | Section |
|---|---|
| 0–7.5 s | intro |
| 7.5–45 s | verse; the build rises toward 45 s |
| **45 s** | drop |
| 45–75 s | peak |
| 75–90 s | breakdown |
| 90–97.5 s | build |
| **97.5 s** | drop |
| 127.5 s on | outro |

`--post name=value,...` overrides post parameters, for example `--post fbAmount=0,kaleidoMix=0`.

`--look none` turns post looks off so you judge the scene itself, and `--scale 1` pins the render scale so a busy GPU doesn't soften the shots.

`--variants 0.07,0.31,0.55,0.79,0.93` forces DNA from each seed in turn (every gene is derived from the seed), so one sweep shows how far a scene travels. Always sweep before you finish.
