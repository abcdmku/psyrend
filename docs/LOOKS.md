# Writing a look

A **look** is a full-frame stylisation applied after feedback and before bloom and tone mapping. The director gives about half of all cues a look. Because looks multiply with scenes, DNA and palettes, every good look adds hundreds of distinct visuals.

Each look is one file in `src/looks/library/<camelName>.ts` that default-exports `defineLook({...})` (`src/looks/types.ts`). They are discovered automatically. The examples are `neonEdges.ts` and `gradientMap.ts`.

## Contract

You write `fn look(uv: vec2f, frag: vec2f) -> vec3f`, which returns linear HDR colour. The framework mixes it over the clean image by `L.amount`, which the director picks from `meta.amount` and fades through transitions. The framework also sanitises NaN and inf.

`L` contains:

| Field | Meaning |
|---|---|
| `res` | Render size |
| `amount` | Mix strength |
| `time` | Seconds |
| `beat`, `kick`, `snare`, `hat` | Decaying pulses |
| `energy`, `bass`, `high` | Levels, 0..1 |
| `anticipation`, `dropPulse` | Look-ahead tension and drop release |
| `beatPhase` | 0→1 across each beat |
| `spin`, `travel` | Integrated motion |
| `dna` (vec4) | The look's 4 genes for this cue, fixed |
| `pal0..pal3` | The palette |
| `p[0..3]` | Your own vec4 slots, filled by `params(ctx, p)` from `ctx.dna` and `ctx.music` |

Helpers:

- **Sampling:** `src(uv)` (clamped) and `srcMirror(uv)` (mirror-repeat, for tilings and remaps)
- **Colour:** `luma`, `palAt(t)`, `palRamp(t)`, `hsv2rgb`
- **Noise and maths:** `hash12`, `hash22`, `vnoise`, `fbm2`, `rot2`, `sat`, `PI`, `TAU`

## Rules

1. **Stay tasteful and keep it 3D.** The 3D scene underneath should still read. Prefer looks that re-light, re-colour, re-sample or re-compose the image (contours, false colour, halftone, refraction, tiling, slit and echo remaps, prism splits) over looks that bury it.
2. **Use the 4 DNA genes** to make each look a family: cell size, angle, mode, colour mapping. Two genomes of the same look should differ visibly.
3. **React to the music:** kicks and snares, `beatPhase`, energy, anticipation (tension), and the drop (release).
4. **Stay in HDR range.** Keep roughly the input's brightness. The output feeds bloom and auto-exposure, so don't turn mid-grey into 5.0.
5. **Be cheap.** Aim for ≤ 0.3 ms at 1280×720, with at most ~16 texture samples per pixel.
6. **Stay stateless.** There is no history, and the result must be frame-rate independent.
7. **Mark remapping looks.** Set `remaps: true` if the look re-composes the frame (tiling, spirals, mosaics, lens remaps). The director keeps those off naturalistic scenes.
8. **Set honest metadata.** `weight` is the base pick likelihood (subtle looks 0.6–1, extreme ones 0.2–0.5). `energy` is the section-energy fit. `amount` is the mix range.

## Verify

```sh
export PATH="/c/nvm4w/nodejs:$PATH"
node scripts/verify.mjs --looks <id>[,<id>] --look-scene kaleido-temple --look-dna 0.2,0.7,0.4,0.9 --times 20,47,80 --out artifacts/look-<id>
node scripts/verify.mjs --looks <id> --look-scene curl-nebula --times 47 --out artifacts/look-<id>
node scripts/contact.mjs artifacts/look-<id>/sheet.jpg artifacts/look-<id>/*.jpg --cols 3
```

Check each look over at least one surface scene (`kaleido-temple`, `chrome-blob`) and one sparse scene (`curl-nebula`, `attractor-swarm`).
