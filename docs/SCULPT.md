# Score sculptures

Auto-directed visuals are **composed**, not picked from a library. Each cue is assembled from blocks and compiled to its own shader:

- a **layout**: where each moment and pitch lives in space
- a **camera**
- a **background**
- a **material**
- a set of **layers**: how each kind of musical event becomes geometry

The novelty memory compares these structural choices, so a recolour counts as a repeat.

The code lives in `src/sculpt/`: `sculptScene.ts` is the engine and core WGSL, `compose.ts` is the composer, `layer.ts` is the layer contract, `blocks.ts` holds the built-in layouts, cameras and backgrounds, and `layers/` holds one layer per file.

## Principles

These come from the user and are not negotiable.

1. **The music generates the image.** Every visible element must correspond to a musical element: a note, chord, tone, overtone, hit, beat, bar, section, motif or arpeggio. The examples below show what that means:
   - Chords, motifs, arpeggios and leads show up as lines, highlights, contours, ripples, fractals and colours.
   - Particle systems and fractals are welcome, but they must be *driven by* musical events. Particles spawn from note attacks. Fractal depth comes from harmonic tension, and fractal branching from motif intervals.
2. **No decorative textures.** Never use noise for its own sake. A surface pattern exists only to convey musical meaning (contours of harmonic salience, chord colour, beat lines).
3. **Clean and well formed.** Use crisp, anti-aliased geometry (the engine renders 4× MSAA at full resolution). Everything must stand on its own without post overlays. Post effects are deliberate devices owned by the director, not by layers.
4. **Truly different structure.** A new layer or layout should be a new *way of seeing* music, not a recolour or reparameterisation of an existing one.
5. **Readable timing.** The playhead is "now". Notes ignite as they cross it, the future is visible ahead (the whole song is known), and the past fades.
6. **Continuous and immersive.** Whatever follows the melody moves continuously; pitch never scatters things to unrelated places. The camera sits *inside* a world made of the music rather than orbiting an object. Nothing shakes: camera motion is averaged over seconds, and there is no screen shake.
7. **Shape, don't transcribe.** Understanding the score is the input, not the output. Don't draw the notes as a MIDI or piano-roll display. Let the melody *steer* things instead: it bends a path, swirls a fluid, morphs a creature, grows a branch, folds an aurora. The mapping must still be *felt*: a rising line visibly lifts or opens something, an attack visibly sets something off, a returning motif makes the same gesture again, and a new chord changes the form's character. Abstract does not mean arbitrary.

## How a cue is composed

A cue is one idea, kept readable:

- **form** (the protagonist): a generative system the music steers (role `'form'`). The literal `notes` layer (role `'hero'`) only carries a cue when no form fits the layout; otherwise it is an occasional accent.
- **world** (usually): a ground layer under the camera.
- **enclosure or sky** (usually): one layer that surrounds the path (role `'enclosure'`, e.g. light-cathedral or bar-gates) or arches over it (role `'sky'`, e.g. aurora).
- **accent** (sometimes, at most one): one layer from another role (harmony, rhythm, particles, fractal, detail or hero).

**Placing a form:** it lives around the playhead, `LCenter(F.songTime)`. Build its frame from `LUp(t)` and the direction `LCenter(t + 0.05) - LCenter(t)`, so it works in every travel layout, including `flight`.

## The melodic gesture

`gestAt(t)` (song time t, past or future) returns the path the melody steers through space, at unit speed per second:

- Rising intervals climb and falling ones dive.
- The chord banks the path within about ±35°.
- Rests fly straight.

The returned `Gest` holds three vectors:

- `pos.xyz` is the position, and `pos.w` is the melodic activity (0..1).
- `fwd.xyz` is the heading, and `fwd.w` is the melody height (−1..1, smoothed pitch relative to the song's melodic centre; 0 in rests).
- `up.xyz` is the frame's up vector, and `up.w` is the onset envelope (the latest attack, decaying).

Shortcuts: `melodyHeight(t)`, `melodyActivity(t)` and `melodyOnset(t)`. The `flight` layout flies along this path (`L` = gesture position, offset across by pitch and up by lane).

Every layer declares its `role`. The composer never picks two layers with the same role. Layout `weight` favours immersive travel layouts (road, river, helix) over orbited objects, and the director adds a matching quality prior so novelty doesn't drift into the weaker layouts. A layer with `weight: 0` is excluded from auto-direction; you can still force it with `?layers=`.

**Score surface:** a layout may declare `surface` (a lane). World layers then get `SURFACE_LANE` and spread everything sounding over (time, pitch) at that lane: the ground under a road, or the wall of the helix tunnel. Use `worldPast()` for how far back a surface reaches, so it extends behind the camera. Layouts with a surface only get dark backgrounds.

## What the score provides

The whole song is analysed before playback.

**Events (storage buffers, group 1):**
- `notes[i]`: `start, end, pitch, strength, role (0 lead, 1 bass, 2 harmony voice), motif (-1 or id), arp (0/1), motifPos`, sorted by start
- `chords[i]`: `start, end, root (-1 none), quality (1 maj, 2 min, 3 dim), tension`
- `hits[i]`: `time, kind (0 kick, 1 snare, 2 hat), strength`
- `W.n` = (noteFirst, noteCount, chordFirst, chordCount) and `W.h` = (hitFirst, hitCount, now, dt): the events inside this frame's time window. Particle simulations use these to find spawning events.

**Continuous score (any time, past or future; `dt` is seconds from now):**
- `score(dt, midi)`: r = harmonic salience (everything sounding), g = lead line, b = bass line, a = note attacks
- `leadAt(dt)`, `bassAt(dt)`: (midi, strength)
- `chordAtT(dt)`: ((root+1)/13, quality, tension, change pulse)
- `drumsAt(dt)`: kick, snare, hat, onset envelopes
- `gridAt(dt)`: beat pulse, bar pulse, section kind, section progress

**Live values:** everything in `F` (see `docs/SCENES.md`), including `F.songTime`, `F.bpm`, `F.centroid`, `F.anticipation`, `F.dropPulse`, `F.evolve`, `F.morph2`, and `F.pal0..3`.

## Engine helpers (core WGSL)

| Area | Helpers |
|---|---|
| Layout | `L(t, pitch, lane)` (song time, MIDI pitch and role lane → world position), `LCenter(t)` (the time axis), `LUp(t)` |
| Lanes | `roleLane(role)`: lead 0, bass −1, voices 0.55 (chord layer ≈ 1–1.5, landscape −1.7) |
| Projection | `toClip(p)`, `hidden()` (returns an invisible vertex), `camEye()`, `camTarget()`, `camUp()` |
| Geometry | `qu(c)` / `qv(c)` (corners of a 6-vertex quad), `stripPoint(a, b, u, v, w)` (camera-facing strip), `lineW(p)` (screen-constant line half-width), `frameX(t, tangent)` |
| Harmony | `chordPc(chord, k)` (pitch class of chord tone k), `fifthsAng(pc)`, `emblemPoint(t, angle, radius, lift)` (a point in the plane across the time axis), `pitchHue(midi)` (circle-of-fifths hue) |
| Light | `playLight(dt)` (lit at/behind the playhead, dim ahead), `shade(base, emis, n, wp)` (material response, opaque layers), `glowOut(rgb, wp)` (emitted light, additive layers), `fogged(rgb, wp)` |
| From `common.ts` | `palL(t, lum)` / `palRampL` (palette hue at a fixed luminance; always use these), `pcg`, `hashU`, `hashU3`, `sat`, `rot2`, and the rest |

**Uniforms `S.p`:**

| Slot | Contents |
|---|---|
| `[0]` | speed, pitchScale, pitchCenter, laneGap |
| `[1]` | pastSec, futureSec, leadRadius, bassRadius |
| `[2]` | camera params |
| `[3]` | hueOffset, glow, fog, surfaceAmp |
| `[4]` | layout params |
| `[5]` | live kick, snare, beatPulse, dropPulse |
| `[6]` | ringRadius, ringWidth, rippleSpeed, lineWidth |
| `[7]` | fov, particleSize, particleSpeed, free |

The composer sets them per cue in `compose.ts`. Don't add new slots; derive what you need, or reuse `[7].w` for one value.

## Writing a layer: `src/sculpt/layers/<camelName>.ts`

Default-export a `LayerDef` (`src/sculpt/layer.ts`), using `satisfies LayerDef`:

- **`id`**: kebab-case, unique.
- **`source`**:
  - `'notes'`, `'chords'` or `'hits'`: one instance per event in the window; `ii` is the absolute event index.
  - `'once'`: one instance, for meshes.
  - `'particles'`: `particles: N` instances; also define `sim_<ID>(i, ptr<function, Particle>)`. State is `Particle {pos: vec4f, vel: vec4f}` in `pstate_<ID>`.
- **`verts`**: vertices per instance. Use 6 per quad, and return `hidden()` for unused vertices.
- **`blend`**: `'opaque'` writes depth and uses `shade()`; `'additive'` is light and uses `glowOut()`.
- **`role`**: `'world' | 'harmony' | 'rhythm' | 'particles' | 'fractal' | 'detail'` (`'hero'` is the notes layer).
- **`weight`** (0 = never auto-picked), **`layouts`** (`'*'` or a list of ids), **`excludes`** (ids it can't coexist with), **`darkOnly`** (large dark masses; kept off light pages).
- Flat emblems that face the camera belong in flow layouts only: in a travel layout they hang in the camera's path.
- **`consts(rand)`** (optional): returns WGSL `const` style switches and a key that becomes part of the recipe.
- **`wgsl`**: must define `fn vs_<ID>(vi: u32, ii: u32) -> LOut` and `fn fs_<ID>(in: LOut) -> vec4f`, where `<ID>` is the id with `-` → `_`. `LOut` has `pos`, `wp`, `nrm`, `a` (interpolated vec4), and `b`, `c` (flat vec4).

**Naming:** prefix every helper function with your layer's `<ID>_`. Several layers share one module, so helper names must be unique.

**Rules:**
- Particle simulation must be frame-rate independent. Use `W.h.w` (dt), and scale per-frame spawn chance by dt. Use `pcg` and `hashU` for per-particle randomness.
- Keep a layer's GPU cost modest: ≤ 0.4 ms at 1280×720 with a dense song.
- Avoid WGSL reserved words: `ref`, `set`, `target`, `active`, `type`, `meta`, `filter`, `from`.
- `select()` cannot pick between matrices, and its operands must match in type.
- `discard` is fine in `fs_` functions.

## Writing a layout: `src/sculpt/layouts/<camelName>.ts`

Default-export `{ layout: LayoutBlock, cameras: Record<string, Block> }` (types in `blocks.ts`).

- The layout WGSL defines `fn L(t, pitch, lane) -> vec3f`, `fn LCenter(t) -> vec3f` and `fn LUp(t) -> vec3f`. It may use `S.p[4]` and must include its own helpers. `dtOf`/`pOff` exist only in the built-in `H` header, so copy them in if you need them.
- `kind` is `'travel'` (absolute time along a path the camera flies) or `'flow'` (music flows to a fixed playhead). Set `weight` (how often it is picked) and, if the layout has a natural ground or wall, `surface` (its lane).
- Pitch must stay legible: a semitone step must be a small, consistent move. Hue can follow the circle of fifths; position should not.
- Each camera defines `camEye()`, `camTarget()` and `camUp()`. List camera ids in `layout.cameras`, and prefix ids to avoid clashes.
- A layout is a musical idea. Examples: octaves as rings, the circle of fifths, time as a spiral, voice-leading as height, a tree that branches per section. Explain the idea in its doc comment.

To add parameter ranges for a new layout, the composer's `composeOne` (`compose.ts`) sets `S.p[4]` and the speed. If your layout needs specific ranges, report what they should be. Don't edit `compose.ts`, because other agents work in parallel.

## Backgrounds: `src/sculpt/backgrounds/<name>.ts`

Default-export `{ id, wgsl }`, where the WGSL defines `fn bgColor(rd: vec3f) -> vec3f`. Use smooth spaces tinted by the harmony ahead (`chordAtT(3.0)`). No noise.

## Testing on real music

Node is not on PATH; run this first:

```sh
export PATH="/c/nvm4w/nodejs:$PATH"
```

**Force your blocks into compositions on a real track:**

```sh
node scripts/verify.mjs --file "C:/Users/Borg/Downloads/03 - Bass Face.wav" --layers my-layer,notes --layout helix --auto --from 10 --until 120 --every 15 --scale 1 --settle 1500 --out artifacts/<you>
node scripts/contact.mjs artifacts/<you>/sheet.jpg artifacts/<you>/*.jpg --cols 4
```

Then Read the sheet.

**Other tracks:**
- `C:/Users/Borg/Downloads/01 - Doorframe.wav` (140 BPM hip-hop/trap)
- `C:/Users/Borg/Downloads/07 - Lock in.wav` (84 s)
- the built-in demo (omit `--file`; 128 BPM EDM; drops at 45 s and 97.5 s)

Test each block in at least two layouts and on two tracks. Exit code 1 means WGSL or console errors.

**Disk:** the C: drive is nearly full. Keep runs small, use JPEG, and delete your `artifacts/<you>` folders when done, except one final sheet.

## Journeys (the default show)

With an analysed song, the director plans **one journey per song** (`src/sculpt/journey.ts`) instead of a sequence of unrelated cues. The whole song is a single composition flown along the melodic gesture (the `flight` layout with the `flight-journey` camera).

- **Cast:** chosen once per song: up to 3 forms, a ground, enclosures, a sky and accents (at most 12 layers, at most 3 particle layers).
- **Places:** every section is a place built from the cast according to its role in the song:
  - a build flies into an enclosure
  - a peak opens under the sky
  - a breakdown settles over open ground
  - intro and outro are sparse

  A returning section (same `cluster`) returns to the same place. In a long section the place develops at its midpoint: the enclosure opens to the sky, an accent arrives, and the camera leans in.
- **Presence:** each layer has a presence channel over song time (`journeyAt(slot, t)`). The engine evaluates it at the song time of each pixel's place on the path (`journeyTime(wp)`). Light fades across about a bar, and solid geometry starts at a clean edge. You therefore see the next place approaching and enter it on the section's downbeat. Layers absent from the visible window are neither simulated nor drawn.
- **Camera and light:** the camera's character (chase, ride or wing, channels 12 and 13) eases with the sections. The director still makes one cue per section, all with the same scene, so the palette and post devices follow the song's form.

Forced test parameters (`?layout=`, `?layers=`) or `?cues` switch back to per-cue compositions. Cameras are evaluated once per frame in a compute pass and cached in `W`, so `camEye()`/`camTarget()`/`camUp()` are free to call anywhere.
