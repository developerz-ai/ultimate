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

Every scale is a SCSS map in `packages/ui/src/tokens/`, emitted as a custom property by [`theme.scss`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/src/tokens/theme.scss) — the **only** stylesheet that emits any — and read back through the function in the third column below. `t.tracking(wide)`, never a hand-written `var(--tracking-wide)` — the property name is spelled in one file, and a scale with no function is one every author has to spell for themselves.

Most scales carry a typed mirror in `tokens.ts` as well, for consumers that cannot read CSS. Two do not, and the table says which; `tokens.test.ts` fails the build on drift in the ones that do.

| Scale | Custom property | Read it with | Values |
|---|---|---|---|
| colour | `--color-accent` | `t.role('accent', $alpha)` | the 24 roles above, as RGB channels |
| space | `--space-4` | `t.space(4)` | `0 1 2 3 4 5 6 8 10 12 16` → `0` … `4rem` |
| radius | `--radius-md` | `t.radius(md)` | `none sm md lg xl pill full` |
| stroke | `--stroke-thick` | `t.stroke(thick)` | `hairline 1px`, `thick 2px`, `heavy 3px` — a border, an outline, a focus ring. px on purpose: a line weight does not grow with text size |
| z-index | `--z-dialog` | `t.z(dialog)` | `base raised sticky dropdown drawer dialog popover tooltip toast skip-nav` |
| duration | `--duration-fast` | `t.duration(fast)` | `instant 0ms`, `fast 120ms`, `base 220ms`, `slow 400ms`, `slower 640ms` |
| easing | `--easing-out` | `t.easing(out)` | `out in in-out spring` |
| shadow | `--shadow-md` | `t.shadow(md)` | `xs sm md lg xl` — **themed**, like colour: separate light and dark maps |
| font family | `--font-sans`, `--font-mono` | `var(--font-sans)` | the two slots `defineTheme()` overrides. The one scale with no function and no TS mirror: a stack is replaced whole, not picked off a rung, and a comma list is not one value per key |
| font size | `--text-md` | `t.text(md)` | `xs` … `3xl`, every one a `clamp()` |
| font weight | `--weight-semibold` | `t.weight(semibold)` | `normal medium semibold bold` |
| line height | `--leading-normal` | `t.leading(normal)` | `tight snug normal loose` |
| letter spacing | `--tracking-tight` | `t.tracking(tight)` | `tight normal wide` — SCSS only, no TS mirror |
| breakpoint | **none** | `@include t.respond-to(md)` · `t.respond-down(md)` · `t.respond-between(md, lg)` | `sm 480px` … `2xl 1536px`; never emitted as a custom property, because a media query cannot read one |

### Breakpoints and computed lengths

Every length, breakpoint and fluid size comes from `@ultimat3/ui/tokens`. An app that needs `max-width` does not write its own mixin.

| Helper | Emits | Notes |
|---|---|---|
| `@include t.respond-to(md)` | `@media (min-width: 768px)` | the rung and wider |
| `@include t.respond-down(md)` | `@media (max-width: 767.98px)` | narrower than the rung. 0.02px under it: `max-width: 768px` and `min-width: 768px` both match at exactly 768px |
| `@include t.respond-between(md, lg)` | `@media (min-width: 768px) and (max-width: 1023.98px)` | `$from` up to, not including, `$to` |
| `t.rem(24px)` | `1.5rem` | px, rem or a unitless px count; `t.rem(20px, 10px)` states another root |
| `t.fluid(1rem, 2rem, 20rem, 80rem)` | `clamp(1rem, 0.6666666667rem + 1.6666666667vw, 2rem)` | first size at the `$from` viewport, second at `$to`, linear between; the range defaults to `20rem`–`80rem`; px accepted |

A rung is quoted or bare — `'2xl'` and `2xl` are the same rung. Prefer a container query (`t.container`, `t.container-query`) to all three mixins: reach for the viewport only when the layout depends on it.

Each refusal is a Sass `@error` — the stylesheet does not compile — in the same shape as every other error: code, cause, `fix:`.

| Failure | Code | `fix:` |
|---|---|---|
| a rung not in `$breakpoints` | `X_TOKEN_UNKNOWN` | `use one of sm, md, lg, xl, 2xl` |
| `respond-between(lg, md)` | `X_UI_INVALID_VALUE` | `write respond-between("md", "lg")` |
| `respond-between(md, md)` | `X_UI_INVALID_VALUE` | `write respond-to("md"), or name a higher rung as $to` |
| `t.rem(2em)`, `t.fluid(1vw, 2rem)` | `X_UI_INVALID_VALUE` | `pass a px length, e.g. rem(24px)` |
| `t.fluid(1rem, 2rem, 80rem, 20rem)` | `X_UI_INVALID_VALUE` | `pass the narrower viewport first, e.g. fluid(1rem, 2rem, 20rem, 80rem)` |

### Layout mixins

**A flex row or column is `@include t.row(…)` / `@include t.column(…)`, never a hand-written
`display: flex` block.** Defined in [`packages/ui/src/tokens/_mixins.scss`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/src/tokens/_mixins.scss); every gap default is a spacing token.

| Write | Emits | Use for |
|---|---|---|
| `@include t.row` | `display: flex; flex-direction: row; align-items: center; justify-content: flex-start; gap: var(--space-3)` | a toolbar, a header, an icon beside a label |
| `@include t.row(t.space(2), baseline, space-between)` | the same, with your `$gap`, `$align`, `$justify` | a row whose items spread |
| `@include t.column` | `display: flex; flex-direction: column; align-items: stretch; gap: var(--space-3)` | a stack of fields, a card body |
| `@include t.column(t.space(5), flex-start)` | the same, with your `$gap`, `$align` | a stack whose items keep their own width |
| `@include t.container(<name>)` + `@include t.container-query(<name>, 30rem)` | a query container and a rule under it | layout that depends on the box, not the viewport |
| `@include t.margin-inline(…)`, `t.padding-block(…)`, `t.inset-inline(…)` | the logical property pair | spacing that flips correctly under RTL |
| `@include t.truncate` / `t.line-clamp(2)` | one-line ellipsis / a clamped block | a cell, a card title |

Measured on one downstream app, `As of 2026-10`: 691 hand-written `display: flex` blocks restated
these two mixins across 211 stylesheet modules. No guard refuses a hand-written flex block yet —
`row` and `column` are the convention, not a build error.

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

**Declare it once, in `apps/web/shared/theme.ts`, as a named export `brand`. The framework does the rest** (`As of 2026-10`):

```ts
// apps/web/shared/theme.ts
import { defineTheme } from '@ultimat3/ui';

export const brand = defineTheme({ preset: 'scifi' });
```

| Who | Does |
|---|---|
| the app | exports `brand` from `apps/web/shared/theme.ts`. Nothing else: no `<style>` in a layout, no CSP edit |
| `x dev`, the container (`ROLE=web`), `x build`'s static export | inline `brandStyleTag(brand)` in the `<head>` of every document — `ssr`, `stream`, `static`, `isr`, and every `/admin` screen — **after** the surface stylesheet `<link>`, so the brand wins the cascade at equal specificity |
| the served processes | admit the same body to `style-src` as a `sha256` source (`brandStyleCspSource(brand)`), so the enforced policy a container sends never blocks it |
| an app with no `shared/theme.ts`, or one whose brand renders no CSS | nothing: no tag, no hash, no bytes |

One file, one reader: `packages/cli/src/theme-brand.ts`. The `/_x` dev dashboard is framework chrome, not an app document, and keeps the shipped palette. No JavaScript is added: the brand is CSS, and the theme toggle and dark mode work as before — the brand answers `html[data-theme]` and `prefers-color-scheme` at every level `theme.scss` does, so the boot script and `ThemeToggle` flip between the brand's two palettes. A save to `theme.ts` is applied on the next `x dev`.

| Failure | Code | When |
|---|---|---|
| a palette below WCAG AA | `X_UI_CONTRAST_INSUFFICIENT` | at boot: `x dev`, `ROLE=web` and `x build` import the module, and `defineTheme()` refuses at import |
| an unknown role, rung or slot / an unusable value | `X_TOKEN_UNKNOWN` / `X_UI_INVALID_VALUE` | the same moment |
| `shared/theme.ts` exports no `brand`, or a `brand` that is not a `defineTheme()` result (or carries `<`) | `X_CONFIG_INVALID` | at boot; `fix:` is the export to write |

The demo app (`dummy/social-media-clone`) ships the `scifi` preset this way; `examples/dummy` keeps the default palette.

```ts
import { brandStyleTag, defineTheme } from '@ultimat3/ui';

const brand = defineTheme({
  colors: { light: { accent: '31 110 178' }, dark: { accent: '96 170 240' } },
  radius: { md: '0.375rem' },
  font: { sans: 'Inter, system-ui, sans-serif' },
});

brand.css;                  // the four CSS blocks, as a string
brandStyleTag(brand);       // '<style>…</style>' — exactly what the framework inlines
```

| Field | Shape | Notes |
|---|---|---|
| `preset` | `'scifi'` | a shipped palette every other slot layers onto, role by role |
| `colors` | `Partial<Record<'light' \| 'dark', Partial<Record<ColorRole, string>>>>` | any subset of the 24 roles, per theme |
| `shadows` | `Partial<Record<'light' \| 'dark', Partial<Record<ShadowName, string>>>>` | elevation is themed like colour |
| `radius` | `Partial<Record<RadiusName, string>>` | `none sm md lg xl pill full` |
| `font` | `Partial<Record<'sans' \| 'mono' \| 'data', string>>` | the font slots |

Returns a frozen `{ css: string }`. It emits `:root`, `html[data-theme='light']`, the `prefers-color-scheme: dark` block and `html[data-theme='dark']` — radius and font ride `:root` only. Output is ordered by the canonical scale arrays rather than by your object, so re-rendering the same input is byte-identical. Empty input gives `css: ''`, which the framework emits nothing for.

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

Order: **explicit `localStorage` choice → `theme.defaultMode`**, where `'system'` (the default) means the OS preference and `'dark'` or `'light'` is the app's own opinion. Applied by a blocking inline `<head>` script, before first paint and before the render-blocking stylesheet, so there is no flash of the wrong theme.

**The boot writes the script; the app writes nothing** (`As of 20.2.0`). `x dev`, the container and `x build`'s static export all inline `themeScript({ fallback })` from `@ultimat3/render` with `theme.defaultMode` from `app.config.ts` as the fallback, and the served processes admit its `sha256` to `script-src` from the same string — `packages/cli/src/theme-boot.ts`. An app that wants to open dark sets `theme: { defaultMode: 'dark' }` and is done. The storage key is `ultimate.theme` on both sides: the boot reads it, `ThemeToggle` writes it, and a test pins the two literals equal. Before this release neither of the framework's two theme scripts was inlined by anything, both fell back to light, and they disagreed on the key.

`@ultimat3/ui`'s own inline script (`THEME_INLINE_SCRIPT`, `themeInlineScriptTag`, `themeInlineScriptHash`, `themeInlineScriptCspSource`) is **gone**: an app that still inlined it by hand deletes that code — the boot's script already runs first.

On the client, `resolveTheme()` reads the same order back: stored choice, then the `data-theme` the boot stamped (`ThemeEnv.current()`), then `defaultTheme(env)` — the app's own `defaultMode` as the boot stamped it in `data-theme-default` (`ThemeEnv.appDefault()`), and the OS only when that is `'system'` or absent — so with `defaultMode: 'dark'` on a light-OS machine the first toggle flips to light instead of writing the dark already on screen.

| Concern | Rule |
|---|---|
| Persist | only when the user explicitly picks. `clearTheme()` removes the key and returns to the app default — `theme.defaultMode` when it is `'light'` or `'dark'`, the OS for `'system'` |
| OS flip | a `matchMedia` change listener re-applies **only** when no explicit choice is stored **and** `theme.defaultMode` is `'system'`. The boot stamps the mode itself as `data-theme-default` (`ThemeEnv.appDefault()`), so a fixed `'dark'` is never flipped light by the OS |
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
| `apps/web/shared/theme.ts` | the app's `brand` export — the one place an app declares its theme; read by `packages/cli/src/theme-brand.ts` |
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
  outline: var(--stroke-thick) solid rgb(var(--color-accent));
  outline-offset: var(--stroke-thick);
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
| Contrast, shipped pairings | the table above, run by `x verify`'s `unit` step |
| Contrast, a `defineTheme()` override | **refused when `defineTheme()` runs** — at import, since a brand is declared at module top level — before a single declaration renders. Every pair in `CONTRAST_PAIRS` (`packages/ui/src/tokens/contrast-pairs.ts`, the same list `contrast.test.ts` holds the shipped palette to) is measured on the resolved palette — your overrides on top of the shipped channels — at its floor: 4.5:1 text, 3:1 the focus ring, 1.4:1 `line`. Only pairs the brand changed, either side, are measured; the rest are the shipped palette's. A miss throws `X_UI_CONTRAST_INSUFFICIENT` naming the pair, the theme and the ratio. The `scrim` ordering is not measured for a brand |
| Focus ring | `:focus-visible` from `--color-accent` in `reset.scss`, and `@include t.focus-ring` per control. Taking one away without painting one back is refused in an **app** by `guards/focus-visible.ts`, on `x verify`'s `boundaries` step — **not by lint**, which ignores `.scss` entirely |
| Reduced motion | honored globally, not per component — and it *deletes* rather than reduces, see below |
| Lighthouse a11y | minimum threshold in `app.config.ts`, default 95 → [Testing](Testing) |

**The global guard collapses motion to `0.01ms !important` on `*`.** Substituting a cross-fade for
a movement therefore needs the component's own `prefers-reduced-motion` block, `!important`, on a
selector more specific than `*` — otherwise the feedback is gone rather than calmed. The rule and
the rest of the motion vocabulary: [Interface rules](Interface-Rules#motion).

## Rules

- Semantic tokens everywhere. A raw hex — or an `rgb()`/`hsl()` called with numbers — in any `.scss` this package ships is a failing **test**, `packages/ui/src/tokens/tokens.test.ts`, on `x verify`'s `unit` step. Not lint: biome ignores `.scss`, and the rule said "lint" while nothing read it. Two files are exempt, because a literal is *supposed* to live in them: `tokens/_colors.scss` and `tokens/_shadow.scss`. In an app the same rule is `guards/raw-colour.ts`.
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
What a screen has to do with those tokens — motion, focus, contrast, the four loading states: [Interface rules](Interface-Rules).
