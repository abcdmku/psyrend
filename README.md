# psyrend

A fullscreen, real-time 3D music visualizer that runs entirely in the browser on your own GPU (WebGPU). Drop in a song. Psyrend analyzes the whole track first (tempo, beats, key, chords, song structure, mood, genre), then plays it while a director steers a set of raymarched and particle worlds. Because the whole song is known ahead of time, visuals can build tension before a drop and land cuts exactly on it.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

You need a WebGPU browser: current Chrome or Edge, or Safari 26+. Audio is decoded and analyzed locally and never leaves the machine.

### Controls

| Key | Action |
|---|---|
| Space | Play or pause |
| ← → | Seek 5 s |
| ↑ ↓ | Volume |
| N / P, 1–0 | Pin next / previous / numbered visual |
| A | Return to auto-directed |
| S | Visuals list |
| I | Live analysis panel |
| H | Hide UI |
| F | Fullscreen |

Drop a file anywhere at any time to switch tracks. **Live input** uses the microphone with real-time analysis. That mode has no look-ahead: tempo is estimated from the last 8 s and a phase-locked beat clock.

## How it works

```
file → decode → OfflineAudioContext (mono, 22.05 kHz) → analysis worker → TrackAnalysis
                                                                            │
player.audibleTime() ──► AnalysisTimeline.sample(t) ──► MusicState ──► Director ──► Renderer
                         (interpolated features,        (per frame)   (show plan,    (scenes → post)
                          sample-accurate hit envelopes)               palette, post)
```

### Analysis

All analysis code is in `src/audio/analysis/` and runs in a worker. A 4-minute track takes about 1–2 s.

- **Spectral front end:** 2048-point real FFT at an 11.6 ms hop. It produces 64 log bands, mel bands and MFCCs, peak-interpolated chroma, centroid, flatness, band energies, and harmonic/percussive balance (median-filter HPSS).
- **Rhythm:** spectral-flux onset envelopes split into kick, snare and hat. Tempo comes from autocorrelation with harmonic enhancement and a log-normal prior. Beats come from Ellis dynamic-programming tracking. Meter and downbeat phase come from kick salience and chord-change accents.
- **Harmony:** Krumhansl–Kessler key detection with relative major/minor disambiguation. Chords are recognised per beat by template matching plus Viterbi smoothing. Each chord gets a tension value from its scale degree.
- **Structure:** Foote novelty at two scales over a beat-synchronous self-similarity matrix, plus an energy-step term. Boundaries snap to bar lines. Segments that repeat are clustered, so every chorus gets the same scene. Each section is labelled intro, verse, build, peak, breakdown, bridge or outro.
- **Look-ahead:** drop detection, and an `anticipation` curve that ramps up through the bars before each energy arrival.
- **Mood and genre:** valence and arousal curves from mode, chords, brightness, tempo, energy and onset density. Genre is a heuristic Gaussian-prototype classifier over global descriptors (13 classes). It's an estimate, not a trained model.

### Director

The director lives in `src/director/`. It plans the whole show before playback:

- **Scene choice:** each section gets a scene based on genre affinity, energy fit, mood fit and variety. Repeated sections reuse their scene.
- **Peaks:** these change visuals every 8 bars.
- **Transitions:** cuts land exactly on drops. Rising sections get zoom-warps, and calm sections get slow fades. Every transition starts ahead of its boundary so it lands on the bar.
- **Palette:** follows the key (circle of fifths around an OKLCH hue wheel), with chords pulling the hue, valence warming it and arousal widening the spread.
- **Feedback and post:** trails, kaleidoscope, bloom, aberration and shake follow the music. Anticipation tightens and darkens the image, and the drop releases it.

### Rendering

The renderer is in `src/gpu/`. Scenes draw into HDR (`rgba16float`) targets. The post chain then runs in this order:

1. Transition compositing.
2. Frame-rate-independent feedback: Catmull-Rom history sampling with stochastic rounding, so trails behave the same at 60 and 480 Hz.
3. Kaleidoscope.
4. Compute-shader auto-exposure.
5. 6-level bloom.
6. ACES tone mapping, palette split-toning, contrast-adaptive sharpening, grain and dither.

Extended-range output is used on HDR displays. Dynamic resolution reads GPU timestamp queries and scales the internal resolution to fit the detected refresh rate, so it holds 240 Hz where the GPU allows and never drops below a sensible floor.

### Visuals

The scenes are in `src/scenes/library/`, and the registry discovers them automatically.

| Scene | Look | Leans toward |
|---|---|---|
| Fractal Cathedral | Kaleidoscopic-IFS corridor flight | Techno, EDM, DnB |
| Attractor Swarm | 1M particles morphing between strange attractors | DnB, bass, EDM |
| Gyroid Flight | Minimal-surface tunnel | Techno, trance |
| Mandelbulb Bloom | Morphing Mandelbulb | EDM, rock, pop |
| Liquid Chrome | Chrome metaballs in a studio | Hip-hop, pop |
| Spectral Terrain | The spectrum as a landscape | Synthwave, lo-fi |
| Aurora Veil | Volumetric aurora | Ambient, classical |
| Curl Nebula | 1M-particle galaxy | Ambient |
| Plasma Inferno | Volumetric fire | Rock, metal |
| Hyper Lattice | Rotating 4D polytopes | Techno, jazz |
| Coral Bloom | Bioluminescent reef | Acoustic, jazz |
| Kaleido Temple | Mirrored sacred architecture | House, EDM |

Each scene has variants, so a scene that returns later in a song is related but not identical. To write a new one, see [docs/SCENES.md](docs/SCENES.md).

## Verify

```sh
npm test                                   # analysis + show-planning tests (synthesized demo song)
npm run typecheck
node scripts/verify.mjs                    # every scene in GPU Chrome: screenshots, fps, GPU ms, WGSL errors
node scripts/verify.mjs --auto --every 5   # the auto-directed show across the demo song
node scripts/verify.mjs --scenes chrome-blob --variants 0,0.5 --nopost
node scripts/contact.mjs artifacts/shots/sheet.jpg artifacts/shots/*.jpg --cols 4
node scripts/ui-shots.mjs                  # start screen and player UI
```

URL parameters for debugging:

- `?demo`: autoplay the built-in song
- `?scene=<id>`: pin a scene
- `?t=<sec>`: start at a time
- `?nopost`: show the raw scene output
- `?scale=<0..1>`: fix the render scale
- `?post.<param>=<value>`: override a post parameter
