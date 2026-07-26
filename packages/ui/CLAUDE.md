# @ultimat3/ui — agent notes

Tier 5. Imports `@ultimat3/core`, `schema`, `i18n`, `money`, `time`. Never `http`, `action`, `render`, `admin`.

## Boundary

| Owns | Does not own |
|---|---|
| design tokens, theme resolution, Solid primitives, a11y helpers | routing, data fetching, business logic, layout of a specific app |

## Hard rules

- **SCSS modules only.** `Foo.tsx` + `Foo.module.scss`, always paired. No Tailwind, no CSS-in-JS, no inline `style` except CSS custom properties.
- **No raw colours.** Only `t.role('<role>')` / `var(--color-*)`. Canonical roles live in `src/tokens/_colors.scss`; `tokens.ts` mirrors them and `tokens.test.ts` fails on drift.
- **Logical properties only.** `margin-inline`, `inset-inline-start`, `text-align: start`. A `left`/`right` in a stylesheet is a bug.
- **solid-js is a type-only import.** All reactive access goes through `src/theme/solid-adapter.ts`, registered once via `setSolidRuntime()`. Never `import { createSignal } from 'solid-js'`.
- **No `{...rest}` prop spreading.** Splitting props reactively needs solid's `splitProps` (a value import), so components declare explicit props and read `props.x` inside JSX.
- **No hardcoded strings.** Label props, or `useUi().t(UI_KEYS.x)`. New built-in strings go in `src/i18n-keys.ts`.
- Formatting logic lives in a pure `*-view.ts` next to the component (`money-view.ts`, `date-time-view.ts`) so it is testable with no renderer.

## Files

| Path | Responsibility |
|---|---|
| `src/tokens/*.scss` | canonical token maps + `_mixins.scss` authoring helpers |
| `src/tokens/theme.scss` | the only stylesheet that emits global custom properties |
| `src/theme/theme.ts` | resolution: stored choice → OS; all side effects via injected `ThemeEnv` |
| `src/theme/inline-script.ts` | anti-flash `<head>` snippet + its CSP sha256 |
| `src/components/` | 39 primitives, `PascalCase.tsx` (component convention overrides the repo's kebab-case) |

## Assumed peer contracts

`@ultimat3/money` → `formatMoney(money, { locale })`; `@ultimat3/time` → `formatDateTime(date, { locale, timeZone, dateStyle?, timeStyle? })`. Both are injectable via a `format` prop, so a signature change touches one line.

## Commands

```
bun test                                  # from the repo root
bun run --filter @ultimat3/ui typecheck
```
