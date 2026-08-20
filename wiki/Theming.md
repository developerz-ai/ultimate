# Theming

SCSS modules + design tokens. No Tailwind, no CSS-in-JS, no second CSS system. Build-time only, zero runtime.

`As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

Every colour is a semantic token. A raw hex in any component or stylesheet is a lint failure and fails `x verify`'s `lint` step.

**Source of truth:** [`packages/ui/src/tokens/_colors.scss`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/src/tokens/_colors.scss). [`tokens.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/src/tokens/tokens.ts) is a hand-maintained typed mirror for consumers that cannot read CSS — charts, `<canvas>`, OG images, transactional mail — and `tokens.test.ts` fails the build if the two disagree. Values on this page are transcribed from those files; when they differ, the files win.

## Colour roles

Named by **role**, not by value: `--color-bg`, never `--blue-500`. Stored as **space-separated RGB channels** so `rgb(var(--color-accent) / 0.5)` composites without a second token.

**24 roles**, in the order `COLOR_ROLES` declares them. A component that needs a 25th is asking for a design decision, not a variable.

| Role | Light | Dark | Used for |
|---|---|---|---|
| `bg` | `253 246 240` | `18 18 20` | page background |
| `bg-soft` | `245 237 230` | `28 28 32` | subtle zones, hovers |
| `surface` | `250 245 241` | `34 34 39` | cards, sheets |
| `surface-raised` | `255 255 255` | `44 44 50` | popovers, dialogs, inputs |
| `fg` | `38 34 31` | `228 226 222` | body text |
| `fg-strong` | `17 15 13` | `248 247 245` | headings, emphasis |
| `fg-muted` | `110 102 94` | `155 151 145` | captions, placeholders |
| `line` | `208 198 188` | `72 72 80` | borders, dividers |
| `scrim` | `17 15 13` | `0 0 0` | modal backdrops — the darkest role in each theme |
| `accent` | `31 110 178` | `96 170 240` | primary action, links |
| `accent-strong` | `21 92 152` | `130 190 248` | hover/active of accent |
| `accent-fg` | `255 255 255` | `16 20 26` | text **on** accent |
| `success` | `21 123 80` | `74 190 130` | the success tone |
| `success-soft` | `222 244 232` | `22 46 34` | its filled background |
| `success-fg` | `255 255 255` | `12 26 18` | text on `success` |
| `warning` | `155 93 7` | `226 170 66` | the warning tone |
| `warning-soft` | `253 240 213` | `52 42 20` | its filled background |
| `warning-fg` | `255 255 255` | `28 20 6` | text on `warning` |
| `danger` | `190 42 42` | `240 110 110` | the danger tone |
| `danger-soft` | `253 227 227` | `56 26 26` | its filled background |
| `danger-fg` | `255 255 255` | `30 12 12` | text on `danger` |
| `info` | `31 110 178` | `96 170 240` | the info tone |
| `info-soft` | `224 239 252` | `22 38 56` | its filled background |
| `info-fg` | `255 255 255` | `12 20 30` | text on `info` |

The six-name tone vocabulary components expose — `neutral`, `accent`, `success`, `warning`, `danger`, `info` — is `$tones` in `_colors.scss`, mirroring `TONES` in `components/variants.ts`; `variants.test.ts` fails on drift.

### The 1.1.0 contrast retune

`As of 2026-08` seven channels moved, because eight pairings failed WCAG AA. The worst was `line` on `surface-raised` in dark at **1.16:1** — an input border nobody can see.

| Role | Theme | Was | Now |
|---|---|---|---|
| `line` | dark | `54 54 60` | `72 72 80` |
| `line` | light | `224 216 208` | `208 198 188` |
| `accent` | light | `34 122 197` | `31 110 178` |
| `fg-muted` | dark | `150 146 140` | `155 151 145` |
| `surface` | light | `255 255 255` | `250 245 241` |

Anything still carrying the old numbers is stale — including any copy of the palette outside `packages/ui/src/tokens/`. There is no gate that finds one, which is exactly how the `/_x` dashboard shipped the 1.16:1 border of its own.

## Other token scales

Every scale is a SCSS map in `packages/ui/src/tokens/` with a typed mirror in `tokens.ts`. [`theme.scss`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/src/tokens/theme.scss) is the **only** stylesheet that emits global custom properties.

| Scale | Custom property | Values |
|---|---|---|
| colour | `--color-accent` | the 24 roles above, as RGB channels |
| space | `--space-4` | `0 1 2 3 4 5 6 8 10 12 16` → `0` … `4rem` |
| radius | `--radius-md` | `none sm md lg xl pill full` |
| z-index | `--z-dialog` | `base raised sticky dropdown drawer dialog popover tooltip toast skip-nav` |
| duration | `--duration-fast` | `instant 0ms`, `fast 120ms`, `base 220ms`, `slow 400ms`, `slower 640ms` |
| easing | `--easing-out` | `out in in-out spring` |
| shadow | `--shadow-md` | `xs sm md lg xl` — **themed**, like colour: separate light and dark maps |
| font family | `--font-sans`, `--font-mono` | the two slots `defineTheme()` overrides |
| font size | `--text-md` | `xs` … `3xl`, every one a `clamp()` |
| font weight | `--weight-semibold` | `normal medium semibold bold` |
| line height | `--leading-normal` | `tight snug normal loose` |
| letter spacing | `--tracking-tight` | `tight normal wide` — SCSS only, no TS mirror |
| breakpoint | **none** | `sm 480px` … `2xl 1536px`, consumed only via `@include t.respond-to(<name>)`; never emitted as a custom property, because a media query cannot read one |

Note the naming: font size is `--text-*`, weight is `--weight-*`, line height is `--leading-*`, tracking is `--tracking-*` — not `--font-size-*`.

## Defined once per theme

Light in `:root`, dark behind the media query, and **both** mirrored under `html[data-theme]` so an explicit user choice always beats the OS. `_colors.scss`'s `emit` mixin writes all four blocks from the same two maps, so a role cannot be defined in one block and forgotten in another.

```scss
:root                                { color-scheme: light; /* $light */ }
@media (prefers-color-scheme: dark)  { :root { color-scheme: dark; /* $dark */ } }
html[data-theme='dark']              { color-scheme: dark;  /* $dark  */ }
html[data-theme='light']             { color-scheme: light; /* $light */ }
```

`color-scheme` rides along, so form controls, scrollbars, and the UA's own `::selection` follow the theme without a second declaration.

## Consuming tokens

Channels, not `#rrggbb`, so any opacity is `rgb(var(--token) / a)`. Inside `@ultimat3/ui` the wrapper is `t.role('<name>', $alpha)`.

```scss
/* apps/web/app/nav/toolbar.module.scss */
.toolbar {
  background: rgb(var(--color-bg) / 0.8);
  backdrop-filter: blur(12px);
  color: rgb(var(--color-fg));
  border-bottom: 1px solid rgb(var(--color-line));
}

.toolbar__action {
  background: rgb(var(--color-accent));
  color: rgb(var(--color-accent-fg));

  &:hover { background: rgb(var(--color-accent-strong)); }
  &[disabled] { color: rgb(var(--color-fg-muted) / 0.6); }
}
```

Text on a filled surface takes that surface's `-fg` role — `accent-fg` on `accent`, `danger-fg` on `danger`. Hardcoding `accent-fg` for every tone is the bug `IconButton` shipped with before 1.1.0: a danger icon button wore accent's on-colour.

No `dark:` variants, no `@media` in a component. A component is `bg` + `fg` + `line`; the theme flip happens above it.

### From TypeScript

For anything that cannot read a custom property — a chart, a `<canvas>`, an OG image, an email:

```ts
import { color, colorRgb, colorVar } from '@ultimat3/ui';

colorVar('accent');            // 'var(--color-accent)'      — the channel list
color('accent', 0.5);          // 'rgb(var(--color-accent) / 0.5)'
colorRgb('dark', 'accent');    // 'rgb(96 170 240)'          — resolved, no indirection
```

An unknown role throws `X_TOKEN_UNKNOWN` naming every role that exists.

## Brand overrides — `defineTheme()`

The **one** seam for restyling. Not a forked stylesheet, not an SCSS `@use ... with ()` override — there is no second path.

```ts
import { brandStyleTag, defineTheme } from '@ultimat3/ui';

const brand = defineTheme({
  colors: { light: { accent: '31 110 178' }, dark: { accent: '96 170 240' } },
  radius: { md: '0.375rem' },
  font: { sans: 'Inter, system-ui, sans-serif' },
});

brand.css;                  // the four CSS blocks, as a string
brandStyleTag(brand);       // '<style>…</style>' — ship it after global.scss
```

| Field | Shape | Notes |
|---|---|---|
| `colors` | `Partial<Record<'light' \| 'dark', Partial<Record<ColorRole, string>>>>` | any subset of the 24 roles, per theme |
| `radius` | `Partial<Record<RadiusName, string>>` | `none sm md lg xl pill full` |
| `font` | `Partial<Record<'sans' \| 'mono', string>>` | the two slots |

Returns a frozen `{ css: string }`. It emits `:root`, `html[data-theme='light']`, the `prefers-color-scheme: dark` block and `html[data-theme='dark']` — radius and font ride `:root` only. Output is ordered by the canonical scale arrays rather than by your object, so re-rendering the same input is byte-identical. Empty input gives `css: ''`.

**Nothing is applied automatically.** `defineTheme()` returns a string; you ship it.

### Values are validated, never escaped

The output lands in a `<style>` element, so a value that could close it is refused rather than sanitised.

| Slot | Accepted | Refused |
|---|---|---|
| colour | `^\d{1,3} \d{1,3} \d{1,3}$`, each channel ≤ 255 | `#1e6eb2`, `rgb(1,2,3)`, `1 1 1; } html { display: none }` |
| radius | `^(0\|\d+(\.\d+)?(px\|rem\|em\|ch\|%))$` | `calc(…)`, `var(…)`, `1` with no unit |
| font | `^[\w\s,'"-]{1,200}$` | anything with `;` `}` `<` `>` `(` `)` `/` `:` — so `Menlo</style><script>` cannot get through |

| Failure | Code | Means |
|---|---|---|
| unknown role, radius name or font slot | `X_TOKEN_UNKNOWN` | the key is not in the scale; `cause` lists every name that is |
| known key, unusable value | `X_UI_INVALID_VALUE` | `cause` names the slot and what was expected |

## Resolution and first paint

Order: **explicit `localStorage` choice → OS preference**. Applied by a blocking inline `<head>` script, before first paint, so there is no flash of the wrong theme. The snippet and its CSP `sha256` both come from [`packages/ui/src/theme/inline-script.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/src/theme/inline-script.ts) — never hand-copied, or the hash stops matching and CSP drops the script.

| Concern | Rule |
|---|---|
| Persist | only when the user explicitly picks. `clearTheme()` removes the key and returns to OS-following |
| OS flip | a `matchMedia` change listener re-applies **only** when no explicit choice is stored |
| Determinism | `data-theme` beating the media query is what makes Playwright screenshots reproducible — set the attribute, don't emulate |
| SSR | the server never guesses a theme; it emits the boot script and neutral markup |
| No flash | the script is blocking and inline. An async or deferred theme script is a regression, not an optimization |
| Bad value | `X_THEME_INVALID` — `light` or `dark`, or clear the attribute to follow the OS |

## Where tokens live

| Path | Contents |
|---|---|
| `packages/ui/src/tokens/_colors.scss` | the two colour maps, the tone list, the `emit` mixin — canonical |
| `packages/ui/src/tokens/tokens.ts` | the typed mirror, gated by `tokens.test.ts` |
| `packages/ui/src/tokens/theme.scss` | the only stylesheet emitting global custom properties |
| `packages/ui/src/tokens/contrast.ts` | WCAG ratios over the channel tokens |
| `packages/ui/src/theme/brand.ts` | `defineTheme()` — the one brand-override seam |
| `packages/ui/src/tokens/_index.scss` | what `@use '@ultimat3/ui/tokens' as t` forwards: maps, `t.role()`, `t.space()`, the mixins. Emits no CSS |
| `apps/web/shared/tokens.scss` | the generated app's own layer. One line — `@forward '@ultimat3/ui/tokens'` — and it emits **zero bytes** of CSS by design: every module is its own Sass compilation, so a `:root` block here would be inlined once per stylesheet. Compiles as scaffolded, verified `As of 2026-08-19`; the bare specifier is resolved by `css-modules.ts`'s package importer, since `./tokens` is an `exports` entry only the module resolver can place |

`shared/` is importable by `site/`, `app/`, and `api/`. `site/` importing from `app/` stays a build error — see [Project layout](Project-Layout). The `/_x` dev dashboard reads its six channels from `colorTokens` at render time rather than keeping a copy → [Admin dashboard](Admin-Dashboard).

## Derived surfaces

| Surface | Derived from |
|---|---|
| PWA manifest `theme_color` | `--color-bg` of the light theme, resolved to hex at build time |
| PWA manifest `background_color` | same token, so the splash screen matches the shell → [PWA and offline](PWA-And-Offline) |
| `<meta name="theme-color">` | emitted twice, one per `prefers-color-scheme` media attribute |
| Maskable icon background | `--color-surface` |
| OG image background | `--color-bg`, `--color-fg-strong` for text |

The manifest is generated. Hand-editing a colour there drifts from the tokens and fails `x verify`'s `manifest` step.

## Accessibility

```scss
:focus-visible {
  outline: 2px solid rgb(var(--color-accent));
  outline-offset: 2px;
}

::selection {
  background: rgb(var(--color-accent) / 0.25);
  color: rgb(var(--color-fg-strong));
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### What contrast is actually gated

`contrast.test.ts` measures every pairing below **in both themes**, over the four surfaces (`bg`, `bg-soft`, `surface`, `surface-raised`) and the four status tones. A failure reports the measured ratio, not just a boolean.

| Pairing | Threshold |
|---|---|
| `fg`, `fg-strong`, `fg-muted` on every surface | `AA_TEXT` **4.5:1** |
| `accent`, `accent-strong` on every surface | 4.5:1 |
| `accent-fg` on `accent` / `accent-strong`; each `<tone>-fg` on its tone | 4.5:1 |
| each `<tone>` on its own `-soft`; `fg-muted` on every `-soft` | 4.5:1 |
| each `<tone>` on every surface | 4.5:1 |
| `accent` (the focus ring) on every surface | `AA_LARGE` **3:1** |
| `line` on every surface | **1.4:1** — a framework floor, not a WCAG level: a border is not text, but 1.16 is invisible |
| `scrim` | must be the darkest role in its theme — a luminance ordering, not a ratio |

`shadow` is not contrast-gated.

| Check | Enforcement |
|---|---|
| Contrast | the table above, run by `x verify`'s `unit` step |
| Focus ring | `:focus-visible` from `--color-accent`; removing an outline without replacing it fails lint |
| Reduced motion | honored globally, not per component |
| Lighthouse a11y | minimum threshold in `app.config.ts`, default 95 → [Testing](Testing) |

## Rules

- Semantic tokens everywhere. A raw hex outside `packages/ui/src/tokens/` is a lint failure.
- Each token defined once per theme, by the `emit` mixin: `:root`, the media query, and both `data-theme` mirrors.
- `html[data-theme]` always beats `prefers-color-scheme`.
- Theme applied before first paint by a blocking inline script.
- 24 colour roles. Adding one is a design-system change, reviewed as one, and it lands in `_colors.scss` **and** `tokens.ts` in the same commit.
- Text on a filled surface uses that surface's `-fg` role, never `accent-fg` by default.
- Restyle through `defineTheme()`. A forked stylesheet is the wrong answer to every brand question.
- Components never contain a media query for theme. They read tokens.
- Contrast verified in light **and** dark; a token pair that passes in one theme only is a failure.
- Colours are themed; numbers, dates, and money are localized → [I18n](I18n), [Money](Money), [Timezones and dates](Timezones-And-Dates).

Component-by-component props and the token vocabulary each one accepts: [UI components](UI-Components).
