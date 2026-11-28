# @ultimat3/effects — boundary

Tier 5 (its floor: it imports `ui`, tier 4). Imports `core`, `money`, `ui`, `ui/motion`. Never sideways, never upward. Nothing in the framework imports it.

## Ideas only — never code (non-negotiable)

Every engine here is OURS. React Bits, Paper Shaders, shaders.com, Motion, ogl, 21st.dev, reui and
shadcn are studied for behaviour and technique ONLY. **React Bits source is never opened** (MIT +
Commons Clause forbids redistributing "a ported version"): study it running in a browser. No file
here is copied, ported or transliterated from any of them, and no runtime dependency beyond
`@ultimat3/*` is added. GLSL is written from scratch from published maths (value noise, smoothstep
falloff, CSS gradient-line geometry).

| Rule | Detail |
|---|---|
| Exports | `src/index.ts`, explicit, no `export *` |
| Errors | `src/errors.ts`, `EffectsInvalidValueError` (`X_EFFECTS_INVALID_VALUE`) from every prop screen (`props.ts`); never a bare `Error`. No code for "no WebGL2": it is a backend |
| Files | one responsibility each, < 200 lines, tests beside the source |
| Tier label | every root carries `data-effect-backend` (`static`/`css`/`canvas`/`webgl2`), decided ONLY by `backend.ts`'s `pickBackend` |
| First frame | the server frame is computed by the same function as animated frame 0 (`meshPoints(0)`, `mosaicCell(c, r, 0)`, `dotsRamp(0) = 0`); the canvas never flashes in over a different picture |
| Colour | role tokens only: `var(--color-<role>)` in sheets and inline custom properties, `resolvePalette()` (resolved `--color-*` channels) for canvas and GLSL. Re-read on a theme change |
| Pause | frames run through `frameLoop` (`motion-port.ts` is the one importer of `@ultimat3/ui/motion`); CSS animations hold under `data-effect-paused` and `html[data-motion='paused']` (`_effect.scss`) |
| Pixels | `EFFECT_PIXELS` is the one DPR floor/cap/pixel-ceiling token; no mount picks its own |
| Network | none, from any entry: `network-seal.test.ts` mounts all fourteen for 1,000 frames with the four APIs sealed |
| GLSL | only in `src/shader-background/presets/*.ts`, each loaded by its own literal `import()` (`load-preset.ts`); `shader-mount.ts` is lazy too. The vertex shader is duplicated per preset on purpose (a shared module would be a fourth chunk) |
| Accessibility | the decorative layer (and any canvas) is `aria-hidden="true"`; content sits outside it |
| Tests | rules in `*-view.ts` (pure), wiring through `mount-harness-fixture.ts` (islands) and `@ultimat3/core/render-nodes` (server frame); `fake-host-fixture.ts` is the fake GL/2D/host. Fixtures are TEST-ONLY |

Commands: `bun test ./packages/effects/` (the `./` matters), `bun run --filter @ultimat3/effects catalog` (CATALOG.md is gated by `catalog.test.ts`).
