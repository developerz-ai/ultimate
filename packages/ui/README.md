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
| `chart-1` … `chart-8` | categorical chart series, in assignment order (`CHART_ROLES`) |

The chart series are Okabe–Ito-derived and **measured, not picked** (`As of 2026-10`): each clears
3:1 against all four surfaces in both themes (WCAG 1.4.11, in `CONTRAST_PAIRS`), and every pair
stays at least `CHART_DISTINCT_MIN` (ΔE 10) apart under protanopia, deuteranopia and tritanopia
simulation (`colour-vision.test.ts`). A ninth series reuses `chart-1` with a second encoding — a
dash, a pattern, a label — never a ninth hue.

Scales: `--space-*` (4px base), `--stroke-*` (line weights: `hairline thick heavy`), `--text-*` (fluid `clamp()`), `--radius-*`,
`--shadow-*` (themed — dark gets deeper, higher-alpha shadows), `--duration-*`,
`--easing-*`, `--z-*` (named ladder, no magic numbers), `--touch-target` (44px, as `2.75rem`).

| Shadow rung (`t.shadow('…')`) | What it is |
|---|---|
| `xs` `sm` `md` `lg` `xl` | elevation: a drop shadow, deeper and darker in dark |
| `glow-sm` `glow-md` `glow-lg` | a halo drawn from the **accent** role, no offset — a live tile, a focused panel, a selected series |
| `tinted-sm` `tinted-md` `tinted-lg` | coloured elevation: a drop shadow in the accent hue |

Glow and tinted rungs read `--color-accent`, so a brand's accent recolours them with no second
override. `SHADOW_NAMES` / `ShadowName` is the list.

| Font slot | Default stack | Read by |
|---|---|---|
| `--font-sans` | `system-ui` … | body copy |
| `--font-mono` | `ui-monospace` … | `code` and `pre`, error frames |
| `--font-data` | `ui-monospace`, `'Cascadia Mono'`, `'JetBrains Mono'` … | `@include t.data-text` — figures in tables, axes and stat tiles, ids, `Kbd` |

Authoring helpers, from the same `@use '@ultimat3/ui/tokens' as t` — an app writes no mixin of its own for any of them:

| Helper | Emits |
|---|---|
| `@include t.respond-to(md)` | `@media (min-width: 768px)` — the rung and wider |
| `@include t.respond-down(md)` | `@media (max-width: 767.98px)` — narrower than the rung; 0.02px under it, so no width matches both arms |
| `@include t.respond-between(md, lg)` | `@media (min-width: 768px) and (max-width: 1023.98px)` |
| `t.rem(24px)` | `1.5rem` — px, rem or a unitless px count in; `t.rem(20px, 10px)` states another root |
| `t.fluid(1rem, 2rem, 20rem, 80rem)` | `clamp(1rem, 0.6666666667rem + 1.6666666667vw, 2rem)` — the first size at a 20rem viewport, the second at 80rem (the default range), linear between. Takes px too; a size that shrinks is legal |
| `@include t.data-text` | `font-family: var(--font-data); font-variant-numeric: tabular-nums` — columns of figures that do not wobble |
| `@include t.touch-target` | `min-block-size` + `min-inline-size` of `var(--touch-target)` — the box itself is hittable |
| `@include t.touch-target($extend: true)` | the box keeps its size; a centred `::after` grows the HIT AREA to the target — a chart point, a dense icon row |
| `@include t.glow-edge` | `box-shadow: inset 0 0 0 var(--stroke-hairline) <accent / 0.55>, var(--shadow-glow-sm)` — `t.glow-edge('glow-lg', 0.8)` picks rung and ring alpha |
| `@include t.grid-texture` | a faint accent grid on a `t.space(6)` pitch with scanlines over it, as `background-image` only; `t.grid-texture(t.space(4), 0.1, false)` drops the scanlines. Withdrawn under `prefers-contrast: more` and `forced-colors: active`; animates nothing |

A rung is `sm md lg xl 2xl`, quoted or bare. Prefer a container query (`t.container` + `t.container-query`) to all three breakpoint mixins.

## The law

| Rule | Enforcement |
|---|---|
| No raw colours | a hex or `rgb()` literal in a component stylesheet fails review; `tokens.test.ts` asserts the shared SCSS is hex-free |
| No Tailwind | not a dependency, not a config, not an escape hatch |
| No CSS-in-JS | styles are `Foo.module.scss` next to `Foo.tsx`, compiled at build |
| No physical directions | `margin-inline`, `inset-inline-start`, `text-align: start` — RTL needs no second stylesheet. Centring is `inset-inline` + `margin-inline: auto`, never a 50% logical inset beside a physical −50% translate, and an edge shadow's physical x offset gets a `[dir='rtl']` mirror (`components/rtl-sheets.test.ts`) |
| No hardcoded strings | labels are props, or `t()` through `UI_KEYS` |
| One token source | `src/tokens/*.scss` is canonical; `tokens.ts` mirrors it and `x verify` fails on drift |
| AA contrast, both themes | `contrast.test.ts` measures every pairing a component renders — text, status fills, soft tints, focus rings, borders, chart series (3:1 on every surface) |

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

`As of 2026-09` **a brand override is measured too, and a failing one is refused.**
`defineTheme()` resolves your channels over the shipped palette and checks every pairing in
`CONTRAST_PAIRS` — the same table the framework's own palette is held to — throwing
`X_UI_CONTRAST_INSUFFICIENT` with the measured ratio, the required one and the role to move.
Only pairings your brand can have *changed* are measured: a new `accent` against the shipped
white `accent-fg` is the commonest way a palette goes unreadable, and it is half a pair.
WCAG 2.2 AA, never APCA — APCA is not a standard, and AA is the operative legal benchmark.

```ts
import { defineTheme } from '@ultimat3/ui';

defineTheme({ colors: { light: { accent: '235 235 235' } } });
// X_UI_CONTRAST_INSUFFICIENT: defineTheme() light palette renders the label on a primary Button:
// "accent-fg" on "accent" measures 1.09:1, and WCAG 2.2 AA requires 4.5:1
```

## One async region

Four states, one decision. `asyncBranch` is the only place `(pending, failed, empty, ready)` is
decided — `<AsyncRegion>` renders it, `<DataTable>` calls it, and an app's own list can call it too.

```tsx
import { AsyncRegion, asyncStateOf, EmptyState } from '@ultimat3/ui';
import type { JSX } from 'solid-js';

declare const posts: { loading: boolean; error: unknown; latest: readonly string[] | undefined };
declare const t: (key: string) => string;
declare const PostList: (props: { rows: readonly string[] }) => JSX.Element;
declare const refetch: () => void;

const region = (
  <AsyncRegion
    state={asyncStateOf({ loading: posts.loading, error: posts.error, data: posts.latest })}
    reserve={{ lines: 5, height: '3rem' }}
    empty={() => <EmptyState title={t('posts.none')} />}
    ready={(rows) => <PostList rows={rows} />}
    onRetry={() => refetch()}
  />
);
```

`empty` and `ready` are **required**, so forgetting the empty state is a type error rather than a
review comment. Three properties are structural, not documented:

- **`empty` is unreachable while pending.** A `pending` state carries no data, so nothing can be
  found empty in it — "No results" before the first page arrives is unconstructible.
- **A refetch keeps the previous data.** `refreshing` carries it: the current page stays rendered
  and dimmed under `aria-busy`, and the empty branch is reachable only from a *completed* result
  that returned zero. `<DataTable loading>` with rows behaves the same way.
- **The placeholder shares the loaded box.** `reserve` feeds the `<Skeleton>` *and* the
  `min-block-size` of every branch, so a skeleton that resizes on load — a slower layout shift —
  cannot be written.

## Toasts

`Toast` and `ToastRegion` render; `toastStore()` is the queue behind them, and `<Toaster>` is
the one way to draw it.

```tsx
import { toastStore, Toaster } from '@ultimat3/ui';

declare const t: (key: string) => string;
declare const restore: () => void;

const toasts = toastStore();
toasts.show({ message: t('post.saved'), tone: 'success' });
toasts.show({ message: t('post.deleted'), action: { label: t('undo'), onAction: restore } });

const region = <Toaster store={toasts} label={t('notifications')} />;
```

Auto-dismiss on a **token** (`short` 4s, `long` 8s, `sticky` never), a three-deep visible cap with
the rest queued — a queued toast has not started its dwell, because nobody has read it — identical
messages deduped rather than stacked, and the countdown held for three independent reasons: pointer
over the stack, focus inside it, **and `document.hidden`**. The last is the one everybody forgets
and the only one that loses the message outright: a backgrounded tab spends the whole dwell and the
corner is empty when the user comes back.

A toast never takes focus, never carries the only copy of anything, and carries at most one
undo-shaped action. The region renders server-side and empty, which is what makes it announce at
all — a live region created with its content already inside it is not read.

## Page layout

Four composites cover the frame of an app screen. Below them are `Container`,
`Stack` and `Grid`; there is no fifth way to build a page.

| Component | Renders | Use for |
|---|---|---|
| `AppShell` | skip link + `header` / `nav` / `main` / `footer` landmarks on a CSS grid | the frame every screen sits in — one per document |
| `PageHeader` | breadcrumbs, the page's one `h1`, description, actions | the top of a screen |
| `Section` | a labelled `section` with a real heading and `aria-labelledby` | second-level structure inside a page |
| `Toolbar` | `role="toolbar"` strip, start + end slots, arrow-key roving between its buttons (`As of 2026-08`) | filters and actions above a table or list |

`AppShell` holds no state: below `md` the sidebar is a native `popover` panel behind a menu
button (`menuLabel`), opened, closed and dismissed by the browser with no script; where `popover`
is unsupported it stays a band above the content. A modal off-canvas panel is still `Drawer`.
Heading levels are props (`headingTag`, `nextHeadingLevel`), so a nested `Section`
never skips a level.

### Data display

Server-rendered, no island and no JS: a chart costs a route nothing until it asks to be focusable.
Every chart stands in a `ChartFrame` — a `figure`, its caption, a legend and a visually-hidden data
table — and every series has a dash and a marker as well as a colour (`chart-1` … `chart-8`).

| Component | Renders | Use for |
|---|---|---|
| `LineChart` / `AreaChart` | multi-series line on a 1-2-5 axis (filled for `AreaChart`); `null` is a gap | a trend over keys |
| `BarChart` | bars, an optional stacked second series with a legend | a count per key |
| `DonutChart` | ring segments, a centre figure, a legend with value and share | parts of a whole |
| `Gauge` | a 270° `meter` dial with a tone and a visible label | one value against its max |
| `ChartFrame` | the figure, caption, legend and data table every chart stands in | a custom chart |
| `niceTicks` · `chartTable` · `seriesStyle` | axis ticks, the fallback table, a series' dash and marker | building a custom chart |
| `DataTable` | sort, cursor paging, states; `narrow: 'cards'` (default) collapses rows to labelled cards below `sm`; `Column.priority` hides a column behind a per-row disclosure, never losing its value; `stickyFirstColumn` | any list of records |
| `Table` | a captioned table with a sticky header; `stickyFirstColumn` | static tabular data |
| `InlineBar` | a caller-formatted figure with a decorative proportional bar | a number in a table cell |
| `StatTile` / `Meter` / `Sparkline` | a KPI with its delta; a bar against a max; an inline mini line | the KPI row |


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

## Icons

The set is [Lucide](https://lucide.dev) (ISC), wrapped — not redrawn. Every one of its
**1767 icons** is a module of its own, generated from upstream `lucide-static` node data
by `bun run icons`, so an import is one glyph and a bundler drops the rest.

```tsx
import { Icon } from '@ultimat3/ui';
import { iconSearch } from '@ultimat3/ui/icons/search';       // one module, one icon
import { iconCircleAlert } from '@ultimat3/ui/icons/circle-alert';

<Icon glyph={iconSearch} />                                    // decorative → aria-hidden
<Icon glyph={iconCircleAlert} label={t('form.invalid')} />     // meaningful → role="img"
```

| Rule | How |
|---|---|
| Module per icon | `@ultimat3/ui/icons/<kebab-name>`, exporting `icon<PascalName>` — `iconDelete`, not `delete`, so reserved words stay legal |
| Pay for what you use | one icon **104 B** minified, fifty **8.9 kB**, all 1767 **365 kB** — measured with `bun build --minify` |
| Colour | `currentColor` only; a glyph carrying a literal colour is refused with `X_UI_INVALID_VALUE` |
| Size | `sm` / `md` / `lg` map to `--text-*` and the box is `1em` — no icon carries a pixel literal |
| Accessible name | omitted `label` means `aria-hidden="true"`; a `label` promotes it to `role="img"` with that name |
| Attributes | only the tags and attributes in `ICON_TAGS` reach the DOM — glyph data never becomes an arbitrary attribute |

Upstream bump: raise `LUCIDE_VERSION` in `src/icons/build-icons.ts`, run `bun run icons`,
commit the diff. There is no hand-edited icon in the package.

## Works without JavaScript

These components are interactive without a client runtime, because the platform already
has the behaviour. Each is correct server-rendered, and the script layer only adds.

| Component | Platform base | The enhancement |
|---|---|---|
| `Accordion` | `<details>` / `<summary>`; `exclusive` is the native `name` group | `onToggle` notification, after the browser has applied it |
| `Combobox` | `<input list>` + `<datalist>` — typing, filtering, keyboard, mobile | `onFilter`, debounced, for a live/server-side query |
| `InfiniteScroll` | a real `rel="next"` link to the next page | an `IntersectionObserver` sentinel that calls `onLoadMore` and intercepts the click |
| `Pagination` with `hrefFor` | `<a rel="next">` / `<a rel="prev">`, one per cursor | none — link mode attaches no handler |
| `Link appearance="button"` | an `<a href>` wearing Button's classes | none |

```tsx
<Accordion level={3} exclusive items={[{ id: 'ship', title: t('faq.ship'), panel: <p>…</p> }]} />

<Combobox name="city" value={query()} options={cities} onFilter={setQuery} debounceMs={250} />

<InfiniteScroll hasMore={page.hasNext} nextHref={`?page=${page.next}`} onLoadMore={loadNext}>
  {rows}
</InfiniteScroll>
```

`InfiniteScroll` refuses `hasMore` without a `nextHref` (`X_UI_INVALID_VALUE`): with
scripting off the control is a link, and a link needs somewhere to go. `Combobox` filters
what it is given by `value` (`filterOptions` — case- and accent-insensitive, prefix first),
so the list is right on the first paint and after a form round-trip, not only once JS runs.

### A pager and a button that navigate

```tsx
import { Link, Pagination } from '@ultimat3/ui';
import type { JSX } from 'solid-js';

interface PostsFooterProps {
  prevCursor?: string | undefined;
  nextCursor?: string | undefined;
  /** Already translated: `t('posts.new')` at the call site. */
  newLabel: string;
}

export function PostsFooter(props: PostsFooterProps): JSX.Element {
  return (
    <footer>
      <Link appearance="button" variant="secondary" size="sm" href="/posts/new">
        {props.newLabel}
      </Link>
      <Pagination
        prevCursor={props.prevCursor}
        nextCursor={props.nextCursor}
        hrefFor={(cursor, direction) =>
          `/posts?${direction === 'next' ? 'after' : 'before'}=${cursor}`
        }
      />
    </footer>
  );
}
```

| Rule | Held by |
|---|---|
| `Pagination` is one mode per use: `hrefFor`, or `onCursor` / `onPage` / `page` / `totalPages` — never both | the type: `PaginationProps` is `PaginationLinkProps \| PaginationCallbackProps`, and each forbids the other's props |
| `DataTable` takes the same pair — `hrefFor` or `onCursor` — and hands it to its pager | the type: `DataTableProps<Row>` is `DataTableLinkProps<Row> \| DataTableCallbackProps<Row>` |
| a `DataTable` sort header follows the table's mode: an anchor at `sortHrefFor(next)` in link mode, a button calling `onSortChange` in callback mode; a linked table with no `sortHrefFor` renders the header as text | the same union — `sortHrefFor` lives on `DataTableLinkProps`, `onSortChange` on `DataTableCallbackProps` — and `DataTable.test.ts` |
| link mode pages by cursor only; a side with no cursor is a disabled button, never an anchor with nowhere to go | `Pagination.test.ts` |
| a control that navigates is a `Link`; `Button` has no `href` | `ButtonProps` |
| a button-link takes `variant` / `tone` / `size` / `fullWidth` / `iconStart` / `iconEnd`; a text link takes `underline` and `tone: 'accent' \| 'inherit'` | the type: `LinkProps` is `TextLinkProps \| ButtonLinkProps` |
| both elements wear ONE set of classes | `buttonClassKeys` (`button-classes.ts`), asked by `Button` and `Link` |

`debounce(fn, ms)` is exported on its own: trailing edge, `cancel()`, `flush()`, `pending()`.
Components cancel theirs on cleanup, so a filter never fires into a tree that is gone.

## Branding

`defineTheme()` is the **only** seam for restyling. No SCSS `@use ... with ()`
override, no forked package, no second entry point — one call, validated, rendered
as the custom properties that beat `theme.scss` at every specificity level it emits.

An app declares it once, as `export const brand` in `apps/web/shared/theme.ts`. `x dev`, the
container, `x build`'s static export and `/admin` inline it after the surface stylesheet, with its
`sha256` in `style-src`; with no such module nothing is emitted. There is nothing to paste.

```ts
// apps/web/shared/theme.ts
import { defineTheme } from '@ultimat3/ui';

export const brand = defineTheme({
  colors: {
    light: { accent: '99 46 210', 'accent-strong': '76 32 168' },
    dark: { accent: '178 148 255', 'accent-strong': '198 176 255' },
  },
  radius: { md: '0.125rem', lg: '0.25rem' },
  font: { sans: "Inter, system-ui, sans-serif" },
});
```

`brandStyleTag(brand)` and `brandStyleCspSource(brand)` are what the framework emits — exported
for a host that renders documents itself.

| Slot | Accepts | Refused with |
|---|---|---|
| `colors.light` / `colors.dark` | any `ColorRole`, as `R G B` channels | `X_TOKEN_UNKNOWN` for the role, `X_UI_INVALID_VALUE` for the value |
| `radius` | any `RadiusName`, as a bare CSS length | `X_TOKEN_UNKNOWN` / `X_UI_INVALID_VALUE` |
| `font` | `sans`, `mono`, `data`, as a `font-family` list | `X_TOKEN_UNKNOWN` / `X_UI_INVALID_VALUE` |
| `shadows.light` / `shadows.dark` | any `ShadowName`, as a `box-shadow`: comma-separated layers of lengths plus `rgb(R G B / a)` or `rgb(var(--color-<role>) / a)`, or `none` | `X_TOKEN_UNKNOWN` for the rung, `X_UI_INVALID_VALUE` for the value |
| `preset` | a `THEME_PRESETS` name — `'scifi'` | `X_UI_INVALID_VALUE` |

Values are validated, never escaped: the output goes into a `<style>` element, so
anything carrying `;`, `}` or `</style>` is a refusal at the app's entry point rather
than a CSS injection. Every component in the system follows the override — they only
ever read the roles, never a colour.

### The sci-fi preset

`defineTheme({ preset: 'scifi' })` swaps the whole palette for a dashboard look: near-black
panels in dark (`bg` `5 7 13`), cool paper in light, a cyan `accent` whose `accent-strong` (hover)
is magenta, its own eight chart series, sharper radii, and — dark only — every elevation rung
redrawn as an accent hairline plus a halo, so each card and popover has a glowing edge with no
stylesheet of yours. It is a **base**: every other slot layers onto it role by role, and the
merged palette is what `CONTRAST_PAIRS` measures.

```ts
import { defineTheme } from '@ultimat3/ui';

export const brand = defineTheme({
  preset: 'scifi',
  colors: { dark: { 'chart-1': '120 220 255' } },   // scifi, with your own first series
});
```

The preset ships tokens only (axiom 8). The texture and the edge are yours to place:

```scss
@use '@ultimat3/ui/tokens' as t;

.main { background-color: t.role('bg'); @include t.grid-texture; }
.tile { @include t.surface; @include t.glow-edge; }
.tile[aria-current='true'] { @include t.glow-edge('glow-lg', 0.8); }
```

A dashboard that should open dark whatever the OS says sets the app default theme
(`data-theme-default`, [Theme resolution](#theme-resolution)) — the preset never forces a theme.
Like every brand, export it from `apps/web/shared/theme.ts` and the framework ships it with its CSP hash.

## The two render paths

Every component renders on the server. Half of them read the ambient presentation context —
locale, time zone, currency, direction, translator — and where that context comes from is the
only thing that differs between a server render and a hydrated one. **An app registers nothing
to render on the server.**

| | Server render | Client render |
|---|---|---|
| The renderer | `@ultimat3/render`'s inert JSX factory — a component is a plain function, called once | Solid, with a reactive graph |
| The runtime | `INERT_SOLID_RUNTIME`, handed out automatically: signals hold, memos recompute on read, effects never run | the real one, registered once: `setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup })`, six named imports from `'solid-js'` — never `import * as`, which keeps every export of solid-js in the chunk (14.8 kB minified, measured) |
| Where `useUi()` reads | the request — `currentLocale()`, `currentTimeZone()`, `useI18n()` | `<UiProvider>`, through Solid's context |
| `<UiProvider>` | **throws** `X_UI_RUNTIME_MISSING` | the one injection point |

`<UiProvider>` is client-only on purpose. A Provider in an inert tree reaches no descendant —
the tree is already built when the renderer walks it, so every consumer is walked outside every
owner and sees the context default, with a real Solid runtime registered too. Rendering the
children anyway would drop the locale, zone, currency and translator it was handed while looking
like it worked, so it refuses instead and names the fix.

The mirror image is just as loud: a **DOM** with no registered runtime is the "my theme toggle
does nothing" bug, and `solid()` still throws there. No DOM, no reactivity to lose.

Server-side, the locale and zone are `ctx.locale` and `ctx.tz` — **core's own fields**, written
once per request by `@ultimat3/http`'s `locale` stage and read back by `currentLocale()` /
`currentTimeZone()`. `withChildContext({ locale, tz })` scopes a subtree. There is no second
ambient store, here or anywhere: `@ultimat3/time` used to keep its own `ctx['timeZone']` that
nothing ever wrote, so every server-rendered date was UTC however the request arrived.

## Example

```tsx
import { Button, Field, Input } from '@ultimat3/ui';
import '../../shared/global'; // `shared/global.scss` is the app's one `@use '@ultimat3/ui/global.scss'`

// A server render. `useUi()` inside <Field> reads the request's locale, direction and zone —
// nothing to register, nothing to wrap.
<Field label={t('signup.email')} hint={t('signup.email.hint')} error={errors.email}>
  {(control) => <Input {...control} type="email" autocomplete="email" />}
</Field>
<Button tone="accent">{t('signup.submit')}</Button>
```

```tsx
// A client entry — an island's `mount()`, or a hydrated app shell. In this order, once.
import { catalogTranslator } from '@ultimat3/i18n';
import { setSolidRuntime, UiProvider } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';

interface Props {
  readonly locale: string;
  readonly timeZone: string;
  readonly currency: string;
  /** The `ui.*` keys this tree renders, resolved on the server. A catalog crosses the seam as
   *  JSON; a `Translator` is a function and cannot. */
  readonly strings: Readonly<Record<string, string>>;
  readonly tree: JSX.Element;
}

export function mount(el: HTMLElement, props: Props): void {
  // NOT `await import('solid-js')`: the chunk already carries Solid statically, so the await buys
  // no bytes and makes `mount` async — and the hydration runtime calls it synchronously.
  // NOT `import * as solidRuntime` either: a namespace handed to a function cannot be shaken, and
  // it costs 14.8 kB of solid-js per island chunk that nothing calls. The six picks are the whole
  // contract.
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup });
  el.textContent = ''; // Solid's `render` APPENDS; the server's shell would stay above this one.
  render(
    () => (
      <UiProvider
        locale={props.locale}
        timeZone={props.timeZone}
        currency={props.currency}
        t={catalogTranslator(props.strings, props.locale)}
      >
        {props.tree}
      </UiProvider>
    ),
    el,
  );
}
```

**The prop is `t`, it takes a `Translator`, and omitting it is not neutral.** `<UiProvider>` with
no `t` falls back to `fallbackTranslator(locale)` — `catalogTranslator({}, locale)`, an **empty**
catalog — so every built-in string in the tree renders its key: `<Dialog>`'s close button reads
`⟦ui.close⟧`, `<Field>`'s marker `⟦ui.required⟧`. The keys are `UI_KEYS`, and they live in the
framework catalog the SERVER has registered; a browser chunk has none, which is why
`translatorFor(locale)` on the client is the same empty answer wearing a better name. Send the
subset and build the translator from it — the framework's two halves (`As of 2026-10`, #710):
the page passes `ui={uiCatalog(t)}` (every `UI_KEYS` template in the request's locale, plurals
included) and the island renders `<UiProvider t={subsetTranslator(props.ui)}>`, with
`subsetTranslator` from `@ultimat3/i18n/subset` — an entry that carries no framework catalog, so
only an island that imports it pays for the lookup. `t` itself — `@ultimat3/i18n`'s bare
exported function — is not a `Translator` and is `TS2739` in this position.

An island's own copy is a different thing and stays a plain prop: it arrives already translated,
as text, because `t()`'s catalog does not cross the seam and neither does a callback.

`Field` owns the ids, so `aria-describedby` / `aria-invalid` can never drift from
what is rendered. `UiProvider` sets `lang` + `dir` on `<html>` from `locale`, so
`ar-EG` needs no second stylesheet and no second component.

**An island pays for what it names, and `import { … } from '@ultimat3/ui'` is the one way to
name it.** Measured through `buildIslands` — minified, production Solid, `As of 2026-08-23`:

| An island that imports | Chunk |
|---|---|
| nothing | 52 B |
| `setSolidRuntime` alone | 74 B |
| `<UiProvider>` + one `<Button>` | 49.4 kB, of which Solid's own runtime is 12.6 kB |
| `<UiProvider>` + `<Form>` + `<Input>` + `<Button>` | 55.3 kB |

**There are no component subpath exports, and there will not be** — measured, not asserted:
`import { Button } from '@ultimat3/ui'` and a deep path into `components/Button` produce the
same chunk to within the bytes of the entry's own name, and so do `useUi` (14 kB) and
`moneyText` (25 kB). `@ultimat3/ui/button` would be a second way to import one name for zero
bytes, which is axiom 1 for nothing. `src/barrel-bytes.test.ts` is the build error, and it will
red the day the barrel stops shaking. `@ultimat3/ui/icons/*` is a subpath for the opposite
reason: 1,767 glyph modules are data, and no bundler splits one module holding all of them.

What a component's 49 kB actually is: Solid's runtime, `@ultimat3/i18n`'s translator and plural
machinery reached through `useUi()`, and `@ultimat3/core`'s error registry reached through
`errors.ts` — none of which a different export shape removes. Budget an island against these
numbers, not against the component's own source.

## `<Text>` and `<Image>`

`<Text>` is the typography primitive. Unset `size` and `weight` inherit, so it is
transparent inside a heading or a caption.

| Prop | Values |
|---|---|
| `tone` | `default` `muted` `accent` `success` `warning` `danger` `info` — the `fg` / `fg-muted` / status roles |
| `size` | keys of `fontSizeTokens`: `xs` … `3xl` |
| `weight` | keys of `fontWeightTokens`: `normal` `medium` `semibold` `bold` |
| `as` | `span` (default) `p` `div` `strong` `em` |

`<Image>` is one `<img>`, or a `<picture>` around one when `sources` is given — no
JS, no fetch, no client state. `alt` is a required prop, so a missing description
is a type error rather than a review comment.

| Prop | Emitted |
|---|---|
| `variants` | `srcset`, descriptors derived and ordered ascending (`variantSrcset`) |
| `sources` | `{ avif?, webp? }` width lists → `<source type="image/avif">`, then `image/webp`, before the `<img>` (`sourceSetsFor`) |
| `sizes` | `sizes`, verbatim, on the `<img>` and every `<source>` |
| `priority` | `loading="eager"` + `fetchpriority="high"`; otherwise `lazy` + `auto`, always `decoding="async"` |
| `width` + `height`, or `aspectRatio` | required — one of the two. Inlined attributes plus `--image-ratio` (`aspect-ratio`), so the box is always reserved (`reservedRatio`) |

Shipped here: the element. Measuring intrinsic dimensions and encoding AVIF/WebP
renditions are build-pipeline steps; the URLs come from `asset('assets/…')` in
`@ultimat3/render` ([Static Assets](../../wiki/Static-Assets.md)). The component
emits what it is handed and fabricates nothing — no variants it was not given, no
dimensions it did not measure.

## Keyboard groups

`As of 2026-08`: a roving group — `Menu`, `Tabs`, `Toolbar` — is one Tab stop into a set of
controls, and arrows move within it. Three rules, all of them in `src/roving.ts` and all of them
enforced by tests:

| Rule | Why |
|---|---|
| a disabled item is in neither the navigable set nor the tab stop (`MENU_ITEM_SELECTOR`, `TAB_SELECTOR`, `tabStopIndex`) | `focus()` on a disabled control is a **no-op**, so a disabled item left in the list pins the reducer on its index and hides everything after it |
| the tab stop is the selection, or the first **enabled** item (`tabStopIndex`) | a group whose only tab stop is disabled cannot be entered at all |
| a control that answers arrows itself keeps them (`handlesOwnArrowKeys`) | `Toolbar` exists to hold a search field, and stealing ArrowRight from it eats the keystroke moving the caret |

`Toolbar` is deliberately **not** a single Tab stop: it holds arbitrary children it cannot reach
into to set an initial `tabindex`, and a search field at its inline start keeps its own arrows —
one stop there would strand every control past it.

`As of 2026-08`, `ToastRegion` owns the live region, not `Toast`: the `<ol>` carries `aria-live`
and outlives every message, because a region created with its content already inside it is not announced. One region,
one politeness — `politeness="assertive"` for a region that carries errors alone.

## Theme resolution

`explicit choice in localStorage` → `the theme already on <html>` → `defaultTheme(env)`: the
app's `theme.defaultMode` (`data-theme-default`), and the OS only when that is `'system'` or
absent. The framework's boot inlines `themeScript({ fallback })` from
`@ultimat3/render` and stamps `data-theme` before first paint, and `resolveTheme()` reads it back
through `ThemeEnv.current()` — so with `defaultMode: 'dark'` on a light-OS machine the first toggle
flips to light rather than writing the dark already on screen. `setTheme()` persists,
`clearTheme()` forgets and returns to the app default (`data-theme-default`, which the boot stamps
from `theme.defaultMode`; the OS for `'system'`), and the OS listener applies only while nothing is
stored and that default is `'system'`.

## Forms bound to an action's input schema

`As of 2026-08-24`. Four things already existed and none were connected: the action's `input`
schema, the issue paths its parse produces, the rejection the server sends back, and `Field`'s
error slot. `useForm` is the binding — **not** a ninth primitive and not a component: a form is a
binding over an existing `action`, the way `llm()` is a factory over one.

```tsx
import { t } from '@ultimat3/i18n';
import { Field, Form, type FormSchema, Input, useForm, valuesOfForm } from '@ultimat3/ui';

// In an app this is `InferInput<typeof createPost.input>` — an object type, not an interface,
// which is what lets `valuesOfForm`'s `Record<string, unknown>` be narrowed to it below.
type CreatePostInput = { readonly title: string };
interface Post {
  readonly id: string;
}

// The action and its typed client, both the app's: `createPost.input` IS a `FormSchema`.
declare const createPost: { readonly input: FormSchema };
declare const api: { createPost(values: CreatePostInput): Promise<Post> };

export function CreatePostForm() {
  const form = useForm<CreatePostInput, Post>({
    fields: ['title', 'items[0].price'],
    schema: createPost.input,            // optional: latency only, never authority
    submit: (values) => api.createPost(values),
    // The app's wording, not the framework's: one `t()` key per thing a user can get wrong.
    messageFor: (issue) => (issue.path === 'title' ? t('post.title.invalid') : t('post.invalid')),
  });

  return (
    // `undefined` and never `''`: `error` being PRESENT is what makes Form render the summary
    // and move focus to it, so an empty string is an error box on a form with nothing wrong.
    <Form
      error={form.state().formErrors.join(' ') || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit(valuesOfForm(new FormData(event.currentTarget)) as CreatePostInput);
      }}
    >
      <Field label={t('post.title')} error={form.errorFor('title')}>
        {(control) => <Input {...control} name="title" />}
      </Field>
    </Form>
  );
}
```

| Rule | Why |
|---|---|
| **`submit` is required and is the only producer of `succeeded`** | a form that decides for itself that a value is acceptable is a security defect. The client-side parse is a latency optimisation; the action re-parses server-side on every path |
| the local parse's **value** is discarded — only its issues are read | otherwise the browser decides what the server was asked to store. `FormSchema` deliberately has no output type |
| a `name` attribute and an issue path are the **same string** (`items[0].price`) | one grammar, so a rejection finds its control with no per-form mapping table. `formatFieldPath` / `parseFieldPath` are the two directions; a name the grammar cannot read is `X_UI_FORM_PATH_INVALID`, refused where it is DECLARED |
| an issue whose path matches no declared field goes to **`formErrors`**, never to a neighbouring control | a form that silently drops "the server rejected this" is worse than one with no binding at all. A near miss (`items` against a form holding `items[0].price`) is one of these |
| every message is the app's, through `messageFor` | a schema issue (`expected number`) is diagnostic text, not a user-facing string. The framework ships the mapping and **no copy table** — there is no `ui.form.*` key to override. A translator that answers `''` or throws falls back to the diagnostic text, the way a missing catalog key renders `⟦key⟧` |
| a second `submit` while one is in flight **joins** it | a double click is not a second write |

**The wire carries no structured issue list yet.** A server-side validation failure arrives as
`X_INPUT_INVALID` with the issues rendered into `cause` (`title: too short; items[0].price:
expected number`) — `packages/action/src/errors.ts` puts nothing in `meta`, and `toProblem`
(`packages/http/src/error-facts.ts`) has no `issues` member — so `issuesFromRejection` reads
`meta.issues` where it exists and parses that line where it does not. It binds a fragment to a
field only when the head is a declared path, so a message holding `'; '` or `': '` degrades to a
form-level error rather than to a wrong control.

### The submit state, and why `disabled` is refused

`form.pending()` is the one value that reaches both halves: `<Button loading>` and `<Form busy>`.
Neither sets the native `disabled` attribute, and that is deliberate — a control that disables
itself mid-flow drops focus to `<body>`, is exempt from the contrast minimum, announces no reason,
and does not actually prevent the double write, which is a race on the server. `aria-disabled` says
unavailable and keeps the control focusable; the click is refused in the component, and `<Form busy>`
refuses the submit again because Enter in a text field touches no button at all.

A failed submit focuses the **first invalid control** (`form.firstInvalidField()`, in declaration
order — a server may report the last field first), and the announced summary keeps the focus only
when the rejection names no control at all. Focus moves once per failure: a `touch()` or `edit()`
afterwards re-renders the form but never pulls focus back, so the user can work down the list.
`form.touch(path)` and `form.edit(path, value)` record touched and dirty against the binding's
`initial`; an empty control and an absent baseline are the same thing, so deleting what you just
typed leaves the form clean. A successful submit clears dirty except for the fields edited while it
was in flight — the server never saw those, so a navigation guard still has something to protect.

Blur-time validation is deliberately **absent**: this binding is server-authoritative, the local
parse's value is already discarded, and a client-side "is this field valid" would be a second source
of truth for the one thing the server decides.

## Errors

| Code | When |
|---|---|
| `X_TOKEN_UNKNOWN` | a token role the SCSS source does not define — including a `defineTheme()` override of a role, radius or font slot that is not in the scale, and a breakpoint rung `respond-to` / `respond-down` / `respond-between` was handed that is not in `$breakpoints` (a Sass `@error`: the stylesheet does not compile) |
| `X_THEME_INVALID` | a theme other than `light` / `dark` |
| `X_UI_RUNTIME_MISSING` | a DOM render with no registered Solid runtime, `<UiProvider>` on the server, or `browserThemeEnv()` off-DOM. A server render with no runtime is **not** one of them — it gets `INERT_SOLID_RUNTIME` |
| `X_UI_FORM_PATH_INVALID` | a form field or control name the path grammar cannot read (`items.0.price`, `items[]`, `__proto__`), or two control names describing different shapes for one path (`user` beside `user.name`) |
| `X_UI_CONTRAST_INSUFFICIENT` | a `defineTheme()` palette whose resolved channels put a pairing in `CONTRAST_PAIRS` below WCAG 2.2 AA — 4.5:1 for text, 3:1 for the focus ring. Only pairings the brand changed are measured; the cause names the measured ratio and the required one |
| `X_UI_QR_CAPACITY` | a `<QrCode>` value over version 3's 42-byte ceiling (byte mode, error-correction level M). The encoder draws versions 1–3 only; the cause names the byte count and the ceiling |
| `X_UI_INVALID_VALUE` | `<Money>` given a float, `<DateTime>` given an unparseable instant, `<Image>` given mixed `w`/`x` descriptors, one dimension without the other, or no reserved box at all, a heading level off 1–6, a `defineTheme()` value that is not a token value, an `<Icon>` glyph with a tag/attribute/colour outside `ICON_TAGS`, two `Accordion` items sharing an id, `InfiniteScroll` with `hasMore` and no `nextHref`, a negative `debounce` window, or (`As of 2026-08`) upstream icon data `bun run icons` refuses (not an object, no renderable nodes, an attribute value that is not glyph geometry), or — as a Sass `@error` — `t.rem()` / `t.fluid()` given a unit other than px or rem, `t.fluid()` given a viewport range that is empty or reversed, `respond-between` given `$from` at or above `$to` |

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `UiError` | any `UiErrorCode` — `UI_ERROR_CODES` | `src/errors.ts` |

## Commands

```
bun test                 # token parity, contrast, theme resolution, brand, catalog drift, a11y
bun run typecheck
bun run catalog          # regenerate CATALOG.md after changing a component's props
bun run icons            # regenerate src/icons/glyphs/* from lucide-static (network, dev-only)
```
