# @ultimat3/ui — agent notes

Tier 5. Imports `@ultimat3/core`, `schema`, `i18n`, `money`, `time`. Never `http`, `action`, `render`, `admin`.

## Boundary

| Owns | Does not own |
|---|---|
| design tokens, theme resolution, Solid primitives, a11y helpers, the Lucide icon wrapper | routing, data fetching, business logic, layout of a specific app, icon **artwork** |

## Hard rules

- **SCSS modules only.** `Foo.tsx` + `Foo.module.scss`, always paired. No Tailwind, no CSS-in-JS, no inline `style` except CSS custom properties.
- **No raw colours.** Only `t.role('<role>')` / `var(--color-*)`. Canonical roles live in `src/tokens/_colors.scss`; `tokens.ts` mirrors them and `tokens.test.ts` fails on drift.
- **Logical properties only.** `margin-inline`, `inset-inline-start`, `text-align: start`. A `left`/`right` in a stylesheet is a bug.
- **solid-js is a type-only import.** All reactive access goes through `src/theme/solid-adapter.ts`, registered once via `setSolidRuntime()`. Never `import { createSignal } from 'solid-js'`.
- **No `{...rest}` prop spreading.** Splitting props reactively needs solid's `splitProps` (a value import), so components declare explicit props and read `props.x` inside JSX.
- **No hardcoded strings.** Label props, or `useUi().t(UI_KEYS.x)`. New built-in strings go in `src/i18n-keys.ts`.
- **Page layout is four composites**: `AppShell` (frame + skip link + landmarks), `PageHeader`, `Section`, `Toolbar`. A screen that hand-rolls a header grid is the bug they exist to prevent. `AppShell` holds no state — off-canvas is `Drawer`.
- **Restyling goes through `defineTheme()`**, never a forked stylesheet and never an SCSS `with ()` override. Its values are validated, not escaped: the output lands in a `<style>` element.
- **`@include t.tone-classes`** emits the `.tone-*` custom-property blocks. Never hand-write a seventh copy; `$tones` in `_colors.scss` mirrors `TONES` and `variants.test.ts` gates it.
- **Icons are generated, never authored.** `src/icons/glyphs/*.ts` is one module per Lucide icon, written by `bun run icons` from `lucide-static@LUCIDE_VERSION`. Never hand-edit a glyph, never add a hand-drawn one, never introduce a second icon source. An upstream fix is a version bump plus a re-run. `lucide` itself is NOT a dependency — the data is committed, so the package still installs, typechecks and renders offline with zero runtime deps.
- **One icon, one module.** The `Icon` component takes a `glyph`, not a name: a `name → glyph` map would be one module holding 1767 icons, and no bundler can split that. Per-icon imports are the whole point (1 icon = 104 B minified, 50 = 8.9 kB).
- **No client runtime exists yet.** A new interactive component must be correct server-rendered and usable with scripting off — `<details>` for disclosure, `<input list>`+`<datalist>` for suggestions, a real `rel="next"` link for paging — with listeners and observers as additive extras. A component that renders nothing until JS runs does not ship.
- **Components are not unit-tested through a renderer.** `.tsx` compiles to `@ultimat3/render`'s `h`, which this package may not import, so every rule lives in a pure module beside the component (`icon-glyph.ts`, `accordion-view.ts`, `combobox-filter.ts`, `infinite-scroll-view.ts`) and *that* is what the tests assert.
- Formatting logic lives in a pure `*-view.ts` next to the component (`money-view.ts`, `date-time-view.ts`) so it is testable with no renderer. Every other renderer-free core follows the same rule under its own name (`sort-state.ts`, `image-source.ts`) — the `.tsx` holds markup, never a rule.

## Files

| Path | Responsibility |
|---|---|
| `src/tokens/*.scss` | canonical token maps + `_mixins.scss` authoring helpers |
| `src/tokens/theme.scss` | the only stylesheet that emits global custom properties |
| `src/theme/theme.ts` | resolution: stored choice → OS; all side effects via injected `ThemeEnv` |
| `src/theme/inline-script.ts` | anti-flash `<head>` snippet + its CSP sha256 |
| `src/components/` | 50 components, `PascalCase.tsx` (component convention overrides the repo's kebab-case) |
| `src/icons/glyphs/` | GENERATED: 1767 per-icon modules, `@ultimat3/ui/icons/<name>` → `icon<Name>` |
| `src/icons/build-icons.ts` | the generator + the pinned `LUCIDE_VERSION`; `LICENSE.lucide` is upstream's ISC text |
| `src/theme/brand.ts` | `defineTheme()` — the ONE brand-override seam; there is no SCSS `@use ... with ()` path |
| `src/tokens/contrast.ts` | WCAG ratios over the channel tokens; `contrast.test.ts` gates AA in both themes |
| `src/catalog/` | parses `components/*.tsx` into `CATALOG.md`; `bun run catalog` writes it, `catalog.test.ts` fails on drift |

## Assumed peer contracts

`@ultimat3/money` → `formatMoney(money, { locale })`; `@ultimat3/time` → `formatDateTime(date, { locale, timeZone, dateStyle?, timeStyle? })`. Both are injectable via a `format` prop, so a signature change touches one line.

## Commands

```
bun test                                  # from the repo root
bun run --filter @ultimat3/ui typecheck
bun run --filter @ultimat3/ui catalog     # after any prop change — CATALOG.md is gated
bun run --filter @ultimat3/ui icons       # regenerate the glyph set (network; dev-only)
```

## Deep import

`@ultimat3/ui/icons/*` resolves through the package's `exports` map. Inside this monorepo a
`tsconfig` that maps `@ultimat3/*` to `packages/*/src` needs the more specific entry
`"@ultimat3/ui/icons/*": ["./packages/ui/src/icons/glyphs/*"]` for TypeScript to follow it —
runtime resolution is the `exports` map either way.
