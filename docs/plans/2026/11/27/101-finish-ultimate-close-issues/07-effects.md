# 07 — Effects: `@ultimat3/effects`

> Part of [`overview.md`](overview.md). Depends on: 06 (`frameLoop`, `motionAllowed`, `inView`). Tier: 5 (new package). Issue #1374, parts 2 and 4.

Bar: cool and efficient — as striking as the reference it studies, at a fraction of the bytes.

Rule: every effect is server-rendered first, works at 0 kB JS in its CSS tier, and enhances inside an
island. A fallback is not a prop — the static frame is the fallback.

## Decisions (as of 2026-11)

| Question | Verdict | Evidence |
|---|---|---|
| Package | New optional `@ultimat3/effects`, tier 5 (imports `ui` tier 4; floor = 5, no `FLOOR_ABOVE` row). Apps that don't import it pay 0 B. Decided: an "extra package". | `scripts/lib/tiers.ts:21` |
| Shader engine | **Build our own** `shader-mount.ts` on WebGL2 (~300 lines) and our own fragment shaders, written from scratch. Techniques studied in Paper Shaders' `shader-mount.ts` (IntersectionObserver + `visibilitychange` pause, `maxPixelCount` cap, DPR floor, ResizeObserver, `dispose()`) and in published shader maths (simplex noise, mesh/grain gradients) — no code copied. Zero runtime dependencies beyond `@ultimat3/*`. | technique only |
| shaders.com, Paper Shaders, Motion, ogl | **Inspiration only, not dependencies.** Studied for techniques; shaders.com additionally rejected as a dependency (WebGPU-only, telemetry on by default posting `location.hostname`). | cloned sources |
| React Bits | **Ideas only.** MIT + Commons Clause forbids redistributing "a ported version". Study behaviour in a browser; never open or copy source into this repo. Rule written into `packages/effects/CLAUDE.md`. | `LICENSE.md` |
| Distribution | npm package; no copy-in registry (a second path). Apps customise via tokens/props or by wrapping. | axiom 1, 8 |
| Record | `docs/idea/18-build-vs-wrap.md` verdict row; `docs/history/tier-decisions.md` row. | — |

## Contract (every entry)

| Tier | When | `data-effect-backend` |
|---|---|---|
| static first frame | server render, no JS, reduced motion, `data-motion="paused"` | `static` |
| CSS | `site/` pages, any island before hydration | `css` |
| Canvas2D | island, no WebGL2 | `canvas` |
| WebGL2 | island, `getContext('webgl2')` succeeds, not lost | `webgl2` |

- First frame computed by the same function as animated frame 0 (no flash).
- Canvas `aria-hidden`, DPR cap from one token, colours from resolved role tokens only.
- Paused by `frameLoop` (06) on reduced motion, hidden tab, offscreen, `MotionToggle`.
- Zero network: no `fetch`/`sendBeacon`/`XMLHttpRequest`/`WebSocket` from any entry.

## Starter catalogue (this sweep): 6 backgrounds, 7 interaction/text

| Entry | Kind | Studied | Better axis |
|---|---|---|---|
| `Aurora` | background | React Bits Aurora | CSS tier by default, 0 kB on `site/`; themes with dark/brand |
| `GradientOrbs` | background | 21st.dev glassy dashboard | transform/opacity only; pauses offscreen/hidden |
| `MosaicGrid` | background | React Bits holo-mosaic | clean-room Canvas2D + static tier; server first frame, no blank canvas |
| `GridGlow` | background | shadcn/reui grid heroes | extends `grid-texture` (`packages/ui/src/tokens/_effects.scss:25`); withdrawn under `prefers-contrast` |
| `Noise` | background | shaders.com grain | static SVG turbulence, no rAF |
| `ShaderBackground` (`preset: 'mesh' \| 'grain' \| 'dots'`) | background | Paper / shaders.com gradient + dot presets (behaviour only) | own GLSL; | role-token palette; reduced motion → speed 0 + fixed frame |
| `SpotlightCard` | interaction | React Bits spotlight | keyboard focus gets the same highlight |
| `Tilt` | interaction | React Bits tilted card | off for coarse pointer and inside focus traps; capped angle |
| `GlassSurface` | surface | 21st.dev glassy dashboard (measured: 4 `backdrop-filter` layers, `blur(5–15px)`) | extends `@mixin surface`/`scrim-backdrop` (`_mixins.scss:193,234`); contrast checked against `CONTRAST_PAIRS`; opaque under `prefers-reduced-transparency` |
| `Marquee` | interaction | reui/React Bits | pauses on hover, focus-within, `MotionToggle`; duplicate track `aria-hidden`; RTL logical direction |
| `TextReveal` (`by: word \| line \| char`) | text | React Bits split/blur text | one readable node + `aria-hidden` split; `Intl.Segmenter` with locale |
| `CountUp` | text | React Bits count-up | final value server-rendered; `Intl.NumberFormat` with `useUi().locale`; `Money`-aware |
| `Shimmer` | text/surface | React Bits shiny text | replaces private `ultimate-shimmer` (`Skeleton.module.scss:3`); `Skeleton` adopts it |

Later sweeps (one PR each, same contract): particles, beams, dot-wave, magnetic button, border beam,
scroll progress, scramble text, parallax, audio-visualizer bars (pull into the starter PR if the
acceptance run in 10 needs it).

## Files to change

- `packages/effects/` — `bun run scripts/new-package.ts effects --tier 5` (README, CLAUDE, CATALOG; `CLAUDE.md` states the rule: ideas and techniques only, never copied code), `src/<name>/{<Name>.tsx,<Name>.module.scss,<name>-view.ts,<name>-view.test.ts}`, shared `src/shader-mount.ts` (our own WebGL2 mount: compile/link, uniforms, context-loss recovery, pause, pixel cap), `src/effect-canvas.tsx` (`<EffectCanvas draw fallback>` escape hatch, `fallback` required by type), `src/backend.ts`.
- `scripts/lib/tiers.ts:21` + root `CLAUDE.md` tier table + `llms.txt`.
- `scripts/effects-bytes.test.ts` (new) — per-entry ceiling; CSS-tier entries 0 B JS; each shader preset in its own lazy chunk.
- `packages/cli/src/shot-gpu.ts` — add a WebGL2 probe line beside WebGPU.
- `packages/cli/src/templates/guard-effect-without-fallback.ts` (new) — `<canvas`, `getContext('webgl`, `navigator.gpu` in app `.tsx` outside `EffectCanvas`; warning in existing apps, error in new.
- Error code: `bun run new-error-code X_EFFECTS_INVALID_VALUE --package effects --status 500 …` (tier 5: no pair-1 flag). No code for "no WebGL2" — that is a backend, not an error.
- `wiki/Effects.md`, `wiki/Error-Codes-effects.md`, `wiki/UI-Components.md` link; `catalog/build-catalog.ts` takes a package root so `effects` generates its CATALOG with the same builder.
- `.github/workflows/release.yml` publish list via `bun run scripts/release-workflow.ts`.
- Adoption: `examples/dummy/site/page.tsx` (`Aurora` CSS), `site/pricing` (`SpotlightCard`), `app/runs/health` (`CountUp`); `dummy/social-media-clone/site/page.tsx:22`, `site/signin/page.tsx:28` stay `0kb` (CSS tier + `TextReveal`), `app/dashboard/page.tsx:46` gets `Presence`/`stagger`/`CountUp` with its budget restated as measured.

## Steps

1. First task: `shader-mount.ts` + one shader (`mesh`) behind the full tier contract, measured bytes in the PR; the other presets follow it.
2. Package scaffold + shared mount + network-seal test (slice A), then backgrounds (A) and interaction/text (B) in parallel.
3. Tier/bytes/guard/wiki (C), adoption (D).
4. Each reference-app island declares `static`, `reduced-motion`, `no-webgl` states so `x shot --all-islands` photographs every fallback.

## Tests

- Per-entry `*-view.test.ts`; backend selection (no WebGL2, context lost, reduced motion, paused) picks the right tier.
- `packages/effects/src/network-seal.test.ts` — every entry mounted with network APIs replaced by `expect.unreachable`, 1,000 frames.
- `*.e2e.test.ts` — zero requests outside the app origin; reduced-motion emulation yields `static`.
- `bun test ./packages/effects/`, `bun test ./scripts/effects-bytes.test.ts`.

## Done when

- ≥ 5 backgrounds and ≥ 5 interaction/text effects, all reduced-motion safe (#1374 checkbox 4 — met in `@ultimat3/effects` by decision; say so when closing).
- `site/` pages that use a CSS-tier effect still ship 0 kB JS.
- `bun run verify` green; app gate green.
