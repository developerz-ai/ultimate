# @ultimat3/ui 🎨

SolidJS design system. Semantic tokens, SCSS modules, dark + RTL by construction.

**[`CATALOG.md`](CATALOG.md) is the reference** — every component, every prop, every
token, generated from source by `bun run catalog` and drift-checked by
`catalog.test.ts`. Read it instead of reading `src/`.

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
| AA contrast, both themes | `contrast.test.ts` measures every pairing a component renders — text, status fills, soft tints, focus rings, borders |

## Contrast

`As of 2026-08` every foreground/background pairing the components render clears
**WCAG AA (4.5:1)** in light *and* dark, and borders clear a 1.4:1 visible-edge floor.
It is measured, not asserted: `roleContrast('dark', 'fg-muted', 'surface-raised')`
returns the number, and the test fails the build on a regression.

```ts
import { AA_TEXT, contrastRatio, roleContrast } from '@ultimat3/ui';

roleContrast('dark', 'accent', 'bg') >= AA_TEXT;   // true
contrastRatio('31 110 178', '253 246 240');        // 4.99 — check a brand before shipping it
```

## Page layout

Four composites cover the frame of an app screen. Below them are `Container`,
`Stack` and `Grid`; there is no fifth way to build a page.

| Component | Renders | Use for |
|---|---|---|
| `AppShell` | skip link + `header` / `nav` / `main` / `footer` landmarks on a CSS grid | the frame every screen sits in — one per document |
| `PageHeader` | breadcrumbs, the page's one `h1`, description, actions | the top of a screen |
| `Section` | a labelled `section` with a real heading and `aria-labelledby` | second-level structure inside a page |
| `Toolbar` | `role="toolbar"` strip, start + end slots, arrow-key roving | filters and actions above a table or list |

`AppShell` holds no state: below `md` the sidebar becomes a band above the content,
and an off-canvas menu is `Drawer` — the one component that already does that.
Heading levels are props (`headingTag`, `nextHeadingLevel`), so a nested `Section`
never skips a level.

```tsx
<AppShell header={<Toolbar label={t('nav.main')}>{nav}</Toolbar>} sidebar={<SideNav />}>
  <PageHeader
    title={t('orders.title')}
    description={t('orders.subtitle')}
    breadcrumbs={[{ label: t('nav.home'), href: '/' }, { label: t('orders.title') }]}
    actions={<Button>{t('orders.new')}</Button>}
  />
  <Section title={t('orders.recent')} actions={<Toolbar label={t('orders.filters')}>{filters}</Toolbar>}>
    <DataTable caption={t('orders.title')} columns={columns} rows={rows} rowKey={(row) => row.id} />
  </Section>
</AppShell>
```

## Branding

`defineTheme()` is the **only** seam for restyling. No SCSS `@use ... with ()`
override, no forked package, no second entry point — one call, validated, rendered
as the custom properties that beat `theme.scss` at every specificity level it emits.

```ts
import { brandStyleTag, defineTheme } from '@ultimat3/ui';

export const brand = defineTheme({
  colors: {
    light: { accent: '99 46 210', 'accent-strong': '76 32 168' },
    dark: { accent: '178 148 255', 'accent-strong': '198 176 255' },
  },
  radius: { md: '0.125rem', lg: '0.25rem' },
  font: { sans: "Inter, system-ui, sans-serif" },
});

// in <head>, AFTER global.scss
`${brandStyleTag(brand)}`;
```

| Slot | Accepts | Refused with |
|---|---|---|
| `colors.light` / `colors.dark` | any `ColorRole`, as `R G B` channels | `X_TOKEN_UNKNOWN` for the role, `X_UI_INVALID_VALUE` for the value |
| `radius` | any `RadiusName`, as a bare CSS length | `X_TOKEN_UNKNOWN` / `X_UI_INVALID_VALUE` |
| `font` | `sans`, `mono`, as a `font-family` list | `X_TOKEN_UNKNOWN` / `X_UI_INVALID_VALUE` |

Values are validated, never escaped: the output goes into a `<style>` element, so
anything carrying `;`, `}` or `</style>` is a refusal at the app's entry point rather
than a CSS injection. Every component in the system follows the override — they only
ever read the roles, never a colour.

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
| `X_TOKEN_UNKNOWN` | a token role the SCSS source does not define — including a `defineTheme()` override of a role, radius or font slot that is not in the scale |
| `X_THEME_INVALID` | a theme other than `light` / `dark` |
| `X_UI_RUNTIME_MISSING` | reactive context or DOM APIs used where they do not exist |
| `X_UI_INVALID_VALUE` | `<Money>` given a float, `<DateTime>` given an unparseable instant, `<Image>` given mixed `w`/`x` descriptors or one dimension without the other, a heading level off 1–6, or a `defineTheme()` value that is not a token value |

## Commands

```
bun test                 # token parity, contrast, theme resolution, brand, catalog drift, a11y
bun run typecheck
bun run catalog          # regenerate CATALOG.md after changing a component's props
```
