# @ultimat3/ui 🎨

SolidJS design system. Semantic tokens, SCSS modules, dark + RTL by construction.

## Token roles

Every colour in every component is one of these, stored as **space-separated RGB
channels** so `rgb(var(--color-accent) / 0.12)` gives a tint with no extra token.

| Role | Use |
|---|---|
| `bg` / `bg-soft` | page background; subtle zones, hovers, table headers |
| `surface` / `surface-raised` | cards and sheets; popovers, dialogs, inputs above them |
| `fg` / `fg-strong` / `fg-muted` | body text; headings; captions and placeholders |
| `line` | borders, dividers |
| `scrim` | modal backdrops |
| `accent` / `accent-strong` / `accent-fg` | primary action, its hover, text on it |
| `success` / `warning` / `danger` / `info` | status solid, each with a `-soft` tint and a `-fg` text-on-solid |

Scales: `--space-*` (4px base), `--text-*` (fluid `clamp()`), `--radius-*`,
`--shadow-*` (themed — dark gets deeper, higher-alpha shadows), `--duration-*`,
`--easing-*`, `--z-*` (named ladder, no magic numbers).

## The law

| Rule | Enforcement |
|---|---|
| No raw colours | a hex or `rgb()` literal in a component stylesheet fails review; `tokens.test.ts` asserts the shared SCSS is hex-free |
| No Tailwind | not a dependency, not a config, not an escape hatch |
| No CSS-in-JS | styles are `Foo.module.scss` next to `Foo.tsx`, compiled at build |
| No physical directions | `margin-inline`, `inset-inline-start`, `text-align: start` — RTL needs no second stylesheet |
| No hardcoded strings | labels are props, or `t()` through `UI_KEYS` |
| One token source | `src/tokens/*.scss` is canonical; `tokens.ts` mirrors it and `x verify` fails on drift |

## Example

```tsx
import { Button, Field, Input, setSolidRuntime, UiProvider } from '@ultimat3/ui';
import '@ultimat3/ui/global.scss';

setSolidRuntime(await import('solid-js'));   // once, in the app entry

<UiProvider locale="ar-EG" timeZone="Africa/Cairo" currency="EGP" t={t}>
  <Field label={t('signup.email')} hint={t('signup.email.hint')} error={errors.email}>
    {(control) => <Input {...control} type="email" autocomplete="email" />}
  </Field>
  <Button tone="accent" loading={pending()}>{t('signup.submit')}</Button>
</UiProvider>
```

`Field` owns the ids, so `aria-describedby` / `aria-invalid` can never drift from
what is rendered. `UiProvider` sets `lang` + `dir` on `<html>`; nothing else is
needed to make that form correct in Arabic.

## `<Text>` and `<Image>`

`<Text>` is the typography primitive. Unset `size` and `weight` inherit, so it is
transparent inside a heading or a caption.

| Prop | Values |
|---|---|
| `tone` | `default` `muted` `accent` `success` `warning` `danger` `info` — the `fg` / `fg-muted` / status roles |
| `size` | keys of `fontSizeTokens`: `xs` … `3xl` |
| `weight` | keys of `fontWeightTokens`: `normal` `medium` `semibold` `bold` |
| `as` | `span` (default) `p` `div` `strong` `em` |

`<Image>` is one `<img>` — no JS, no fetch, no client state. `alt` is a required
prop, so a missing description is a type error rather than a review comment.

| Prop | Emitted |
|---|---|
| `variants` | `srcset`, descriptors derived and ordered ascending (`srcsetFor`) |
| `sizes` | `sizes`, verbatim |
| `priority` | `loading="eager"` + `fetchpriority="high"`; otherwise `lazy` + `auto`, always `decoding="async"` |
| `width` + `height` | inlined attributes — both or neither, so the ratio is always reservable |

Shipped here: the element. Measuring intrinsic dimensions, encoding AVIF/WebP
renditions and the data-URI blur placeholder are build-pipeline steps
([`docs/idea/07-rendering-seo.md`](../../docs/idea/07-rendering-seo.md)), not part
of this package. The component emits what it is handed and fabricates nothing —
no variants it was not given, no dimensions it did not measure.

## Theme resolution

`explicit choice in localStorage` → `OS preference`. `setTheme()` persists,
`clearTheme()` forgets and follows the OS again, and the OS listener only applies
while nothing is stored. `themeInlineScriptTag()` goes in `<head>` and applies the
result before first paint, so there is no flash and screenshots are deterministic:

```
Content-Security-Policy: script-src 'self' 'sha256-…'   # themeInlineScriptCspSource()
```

## Errors

| Code | When |
|---|---|
| `X_TOKEN_UNKNOWN` | a token role the SCSS source does not define |
| `X_THEME_INVALID` | a theme other than `light` / `dark` |
| `X_UI_RUNTIME_MISSING` | reactive context or DOM APIs used where they do not exist |
| `X_UI_INVALID_VALUE` | `<Money>` given a float, `<DateTime>` given an unparseable instant, `<Image>` given mixed `w`/`x` descriptors or one dimension without the other |

## Commands

```
bun test                 # token parity, theme resolution, cx, a11y, formatting cores
bun run typecheck
```
