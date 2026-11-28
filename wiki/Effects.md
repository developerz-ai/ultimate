# Effects

`@ultimat3/effects` — background, interaction and text effects. Optional package, tier 5: an app that does not import it pays 0 B. Every engine is ours; no runtime dependency beyond `@ultimat3/*`.

`As of 2026-11`. The component list is the generated [`CATALOG.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/effects/CATALOG.md) (`bun run --filter @ultimat3/effects catalog`, drift is a red `x verify`); this page is the contract every entry meets.

## The rule

Server-rendered first. Works at 0 kB JS in its CSS tier. Enhances inside an island. **A fallback is not a prop — the static frame is the fallback.** The one exception, `EffectCanvas`, takes `fallback` as a required prop, so the type refuses a canvas with none.

## The contract: four tiers

Every root element carries `data-effect-backend`.

| Tier | When | `data-effect-backend` |
|---|---|---|
| static | reduced motion, `data-motion="paused"`, or an entry with no CSS animation — a still frame | `static` |
| CSS | server render of an entry whose CSS animates (every `site/` page; any island before hydration). CSS itself freezes it under reduced motion; the label stays `css` | `css` |
| Canvas2D | island, no WebGL2 | `canvas` |
| WebGL2 | island, `getContext('webgl2')` succeeds and is not lost | `webgl2` |

| Rule | Held by |
|---|---|
| First frame is computed by the same function as animated frame 0 — no flash | each entry's `*-view.test.ts` |
| Canvas is `aria-hidden`; DPR capped from one token; colours from resolved role tokens only | `*-view.test.ts`; the raw-colour guard |
| Paused by `frameLoop` on reduced motion, hidden tab, offscreen, `MotionToggle` ([Motion](Motion)) | backend-selection tests |
| Zero network: no `fetch`, `sendBeacon`, `XMLHttpRequest`, `WebSocket` from any entry | `network-seal.test.ts` (1,000 frames, every entry) |
| A canvas, `getContext('webgl…')` or `navigator.gpu` in app code outside `EffectCanvas` | `guard-effect-without-fallback` (warning in an existing app, error in a new one) |
| No WebGL2 is a backend, never an error | no code exists for it |

A bad prop value is `X_EFFECTS_INVALID_VALUE` ([Error codes](Error-Codes-effects)).

## Catalogue

| Entry | Kind | Notes |
|---|---|---|
| `Aurora` | background | CSS tier by default; themes with dark/brand |
| `GradientOrbs` | background | transform/opacity only; pauses offscreen and hidden |
| `MosaicGrid` | background | Canvas2D with a server-rendered first frame — never a blank canvas |
| `GridGlow` | background | extends `grid-texture`; withdrawn under `prefers-contrast` |
| `Noise` | background | static SVG turbulence, no animation frame |
| `ShaderBackground` | background | `preset: 'mesh' \| 'grain' \| 'dots'`; each preset is its own lazy chunk; reduced motion is speed 0 on a fixed frame |
| `SpotlightCard` | interaction | keyboard focus gets the same highlight as the pointer |
| `Tilt` | interaction | off for coarse pointers and inside focus traps; capped angle |
| `GlassSurface` | surface | opaque under `prefers-reduced-transparency`; contrast checked against the role pairs |
| `Marquee` | interaction | pauses on hover, focus-within and `MotionToggle`; duplicate track is `aria-hidden`; logical (RTL-safe) direction |
| `TextReveal` | text | `by: 'word' \| 'line' \| 'char'`; one readable node plus an `aria-hidden` split; `Intl.Segmenter` with the locale |
| `CountUp` | text | final value server-rendered; `Intl.NumberFormat` with the `useUi()` locale; `Money`-aware |
| `Shimmer` | text/surface | consumes `@mixin shimmer` from `@ultimat3/ui` — the same sweep `Skeleton` uses |
| `EffectCanvas` | escape hatch | `<EffectCanvas draw fallback>`; `fallback` required by type |

A new effect is a new row in a later sweep, under this same contract: one PR each.

## Ideas only

Reference libraries (Paper Shaders, shaders.com, Motion, React Bits, 21st.dev, reui, shadcn) are studied for behaviour and technique. **No code is copied, and none is added as a dependency.** React Bits is MIT with the Commons Clause, which forbids redistributing a ported version: its source is never opened for this repo. Rule stated in `packages/effects/CLAUDE.md`; verdicts in `docs/idea/18-build-vs-wrap.md`.

## Reduced motion

| Setting | Result |
|---|---|
| `prefers-reduced-motion: reduce` | CSS animations freeze (`reset.scss`); canvas and shader entries draw their frame 0 and stop; backend reads `static` |
| `data-motion="paused"` (`MotionToggle`) | same as above, user-chosen, persists |
| `prefers-contrast: more` | `GridGlow` withdrawn |
| `prefers-reduced-transparency` | `GlassSurface` opaque |

`x shot --all-islands` photographs each island in the states its `*.island.states.ts` declares (the harness emulates colour scheme, not reduced motion or a missing WebGL2 — reduced motion and the canvas fallback are held by the unit tests); the verdict's `gpu` block reports `webgl2` beside WebGPU so a blank canvas is read as the machine or the app.

## Budgets

`scripts/effects-bytes.test.ts` builds a one-entry island per effect (minified, `solid-js` external) and holds it to a ceiling.

| Claim | Pinned by |
|---|---|
| CSS-tier entries (`Aurora`, `GridGlow`, `Noise`, `GlassSurface`, `Shimmer`, `Marquee`, `TextReveal`) are 0 B of JS | no client-only machinery in their source or browser build |
| Every other entry stays under its ceiling | one ceiling per entry in the test |
| A shader preset is paid for only by the page that uses it | entry chunk holds no GLSL; `mesh`, `grain`, `dots` each a lazy chunk |

A ceiling is a measurement, not a number to game: raise one with the measured bytes and the reason in the same diff (`bun run budget-raises`, `X_BUDGET_RAISE_UNSTATED`). Never cut an effect to hold a figure.

## See also

[UI components](UI-Components) · [Motion](Motion) · [Interface rules](Interface-Rules) · [Theming](Theming)
