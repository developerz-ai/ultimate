# UI components

`@ultimat3/ui` — SolidJS components on the semantic tokens in [Theming](Theming). SCSS modules, logical properties, no Tailwind, no CSS-in-JS.

`As of 2026-09`. Stable API — semver from here ([Upgrading](Upgrading)).

## The catalog is generated — read it, don't ask

**[`packages/ui/CATALOG.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/CATALOG.md)** documents every component with every prop, every type, and the token scales, parsed straight out of `packages/ui/src/components/*.tsx`. It ships inside the npm tarball, so it is on disk at `node_modules/@ultimat3/ui/CATALOG.md` in any app.

**How many there are is a question for the file, never for this page.** It carried `52` for two majors:

```bash
head -7 node_modules/@ultimat3/ui/CATALOG.md   # the count and every name, on one line
```

| Concern | Answer |
|---|---|
| Regenerate | `bun run --filter @ultimat3/ui catalog` |
| Drift | `catalog.test.ts` compares the committed file byte-for-byte against a fresh build; a prop change with no regen is a red `x verify` |
| Hand edits | refused by the same test — the file carries a `GENERATED` banner |

This page does **not** restate the catalog. It covers the four page composites, because they are the ones an agent picks wrong.

**Which component to reach for is not the same question as how it must behave.** The four-state
decision, skeleton-versus-spinner, response tiers, optimistic writes, forms, motion, focus, toasts
and images are [Interface rules](Interface-Rules) — one page, every rule marked either with the
guard, type or gate step that refuses it, or as judgement nothing checks.

**Form errors are translated on `FormIssue.rule`.** `formBinding`'s `messageFor` receives the same
`rule` and `params` (`string.min`, `{ min: 3 }`) from the local parse and from the server's
`X_INPUT_INVALID`, whose problem document carries the structured `issues` list —
``messageFor: (issue) => t(`form.${issue.rule}`, issue.params)``. See [I18n](I18n).

## The four page composites

A screen that hand-rolls a header grid is the bug these exist to prevent. All four hold no state — the route owns it.

### `AppShell`

The frame: skip link, landmarks, optional sidebar. Off-canvas navigation is `Drawer`, not a prop here.

| Prop | Type | Default |
|---|---|---|
| `children` | `JSX.Element` | required |
| `header` | `JSX.Element` | omitted → no `<header>` |
| `sidebar` | `JSX.Element` | omitted → no `<nav>`, and the grid collapses to one column |
| `footer` | `JSX.Element` | omitted → no `<footer>` |
| `bottomNav` | `JSX.Element` — a `<BottomNav>` | omitted → none; given, shown below `md` only, last, sticky to the bottom edge and in flow, so it reserves its own height |
| `sidebarLabel` | `string` | `t('ui.navigation')` |
| `skipLabel` | `string` | `t('ui.skip')` |
| `sidebarWidth` | `string` | `'16rem'` |
| `stickyHeader` | `boolean` | **sticky unless explicitly `false`** — `undefined` is sticky |
| `class` | `string` | — |

Landmark order in the DOM: `banner` → `navigation` → `main` → `contentinfo` → the bottom bar's `navigation`. `<main>` is unconditional.

The sidebar's content is `NavList` and the bottom bar's is `BottomNav` (five links at most); both mark the current page by one rule, `currentOf(items, href)` — the longest covering href wins, so `/runs/7` marks `/runs`. The bar's padding clears the home indicator through `t.safe-area-padding(block-end)` (`viewport-fit=cover` on the page).

The skip link is real, not decorative: `<main>` carries `tabindex={-1}` so focus actually moves there, and the link's `href` and the target's `id` are derived from one `shellIds()` call, so they cannot drift apart. It sits off-screen at `translate: 0 -400%` and slides in on `:focus-visible`.

### `PageHeader`

| Prop | Type | Default |
|---|---|---|
| `title` | `string` | required |
| `description` | `string` | omitted |
| `actions` | `JSX.Element` | omitted |
| `breadcrumbs` | `readonly BreadcrumbItem[]` | omitted → no `Breadcrumb` |
| `level` | `1 \| 2 \| 3 \| 4 \| 5 \| 6` | **`1`** |
| `media` | `JSX.Element` | omitted |
| `class` | `string` | — |

### `Section`

| Prop | Type | Default |
|---|---|---|
| `children` | `JSX.Element` | required |
| `title` | `string` | omitted → an unlabelled grouping, no `aria-labelledby` |
| `description` | `string` | omitted |
| `actions` | `JSX.Element` | omitted |
| `level` | `1` … `6` | **`2`** |
| `as` | `'section' \| 'article' \| 'aside'` | **`'section'`** |
| `class` | `string` | — |

A `title` wires `aria-labelledby` to the heading's generated id automatically. The head block disappears entirely when both `title` and `actions` are absent, so an untitled `Section` costs no markup.

A `level` outside 1–6 throws `X_UI_INVALID_VALUE` rather than emitting an `<h7>`.

### `Toolbar`

| Prop | Type | Default |
|---|---|---|
| `children` | `JSX.Element` | required |
| `actions` | `JSX.Element` | omitted → no trailing group |
| `label` | `string` | **required** |
| `surface` | `boolean` | falsey |
| `class` | `string` | — |

`label` is required because `role="toolbar"` with no accessible name is an unnamed group. Arrow keys move through the focusable children via a roving tabindex, horizontal, direction-aware, **not** looping.

## A control that navigates is a `Link`

`Button` has no `href`. A link that looks like a button is `<Link appearance="button">`; a pager on a server-rendered list is `<Pagination hrefFor>`. Neither needs an island.

```tsx
<Link appearance="button" variant="secondary" size="sm" href="/posts/new">{t('posts.new')}</Link>

// `page` is a framework `Page` (a query's `.page()`): `nextCursor` is `string | null`, handed as is.
const list = listUrl(props.url, { sorts: ['title', 'createdAt'] });
<Pagination nextCursor={page.nextCursor} hrefFor={list.hrefFor} firstHref={list.firstHref} />
```

`listUrl(url, { sorts, ns?, limit? })` reads a list's state out of its URL — `sort`, `cursor`, `limit`, `q`, never throwing: an unknown sort or a hostile limit is the default — and writes it back as hrefs: `hrefFor` (the cursor, everything else kept), `sortHrefFor` and `href(change)` (the change, the cursor dropped), `firstHref` (`undefined` on the first page). Param names are `sort`, `dir`, `after`, `limit`, `q`; `ns: 'runs'` prefixes them all (`runs.after`) for two lists on a page, and then any change but a cursor drops every cursor on the page, since a cursor is bound to its filter and sort (`X_CURSOR_INVALID`). The same object feeds a `DataTable`'s `hrefFor`, `sortHrefFor` and `firstHref`.

| Component | Mode | Props | Renders |
|---|---|---|---|
| `Link` | text (default) | `underline`, `tone: 'accent' \| 'inherit'` | `<a>` with the link classes |
| `Link` | `appearance="button"` | `variant`, `tone` (any `Tone`), `size`, `fullWidth`, `iconStart`, `iconEnd` | `<a>` with `Button`'s classes — one set of button styles, two elements |
| `Pagination` | callbacks | `onCursor`, or `page` + `totalPages` + `onPage`; `onFirst` | `<button>`s; needs an island |
| `Pagination` | links | `hrefFor(cursor, direction)`; `firstHref` | `<a rel="prev">` / `<a rel="next">`; Next with no cursor is a disabled button |
| `DataTable` | callbacks / links | `onCursor` + `onFirst`, or `hrefFor(cursor, direction)` + `firstHref` | its pager, in that mode — the props are handed straight to `Pagination` |

A cursor that is `null` or absent is one state: no page that way. Previous is drawn only when a `prevCursor` is given or the pager is numbered — a keyset `Page` has no way back, so its pager draws Next and, given `firstHref` / `onFirst`, First. Next holds the trailing edge either way.

One mode per use, and the type holds it: `hrefFor` beside `onCursor`, `onPage`, `page` or `totalPages` does not compile, and neither does `underline` on a button-link or `variant` on a text link. Link mode pages by cursor only. `Link` also takes `rel?: 'next' | 'prev'`, which joins the `noopener noreferrer` an external link always carries.

## Rules an agent must not break

- **SCSS modules only.** `Foo.tsx` + `Foo.module.scss`, always paired. The only inline `style` allowed is a CSS custom property.
- **Logical properties.** `margin-inline`, `inset-inline-start`, `text-align: start`. A `left`/`right` in a stylesheet is a bug.
- **No hardcoded strings.** Label props, or the built-in keys in `src/i18n-keys.ts` → [I18n](I18n).
- **No raw colours.** `t.role('<role>')` or `var(--color-*)` → [Theming](Theming).
- **No prop spreading.** Components declare explicit props; there is no `{...rest}`.
- **`solid-js` is a type-only import** inside the package — reactive access goes through one registered adapter, so the design system does not pin a renderer version.
- Formatting logic lives in a pure `*-view.ts` beside the component (`money-view.ts`, `date-time-view.ts`), testable with no renderer.
- **Choosing from a list is three controls, never one with modes.** `Select` (short, closed), `SearchableSelect` (long, closed, value ≠ label — no-script it is the native `<select>`), `Combobox` (free text). There is no `<Select searchable>`: every `Select` island would carry the listbox.
- **A destructive question is `ConfirmDialog`, never `confirm(`.** Cancel is focused, the backdrop never dismisses, `action` posts with scripting off, `onConfirm` stays open on a refusal; the confirm label is a verb with no default. `guards/native-confirm.ts` refuses `confirm(` in app code.
- **Shortcuts are one table per island, merged per page.** `useHotkeys([{ keys, label, run }])`; `ShortcutSheet` lists the merged table on `?` and `useCommandPalette` adds `mod+k` to it — so the legend cannot drift from the bindings. The framework reserves no key.
- **The bottom sheet is `Drawer side="block-end" grabber`.** There is no `Sheet`. Link tabs are `Tabs` with `hrefFor` — a `<nav>`, never `role="tab"`.
- **Charts: options on the shipped charts, not new charts.** Signed bars and sparklines, `null` gaps, `at` for true x, `references`, `stacked` areas, `tone` per series, `Gauge` `thresholds`/`target`, `Meter` `target`. The two new names are `HeatStrip` and `LiveIndicator`, which no chart's shape covers. A stat grid is `Grid minColumn`.
- **Which list, when.** Records with columns: `DataTable`. Thousands of one-shape rows: `VirtualList` (no script, every row renders; with script, under 100 mounted). Things inside things: `Tree` — `hrefFor` is `<details>` and links at 0 B, `onSelect` is the island's `role="tree"`. What happened: `Timeline` (+ `InfiniteScroll` + `RelativeTime` is the activity feed; there is no feed component). Facts about one thing: `DescriptionList`, never a two-column `Table`.
- **Dates are the native input first.** `DatePicker`/`DateRangePicker` are `<input type="date">` with a `Calendar` popover only on a fine pointer with script. A date is a `PlainDate`; a window (`TimeRangePicker`, `timeRangeUrl`) is instants and takes a REQUIRED `timeZone`. Presets are the app's. `Slider` is `<input type="range">`; a segmented control is `Radio appearance="segmented"`; there is no number stepper.
- **Reordering is `SortableList` and `Board`, a split is `SplitPane`** — one Pointer Events gesture, never HTML5 drag. A drop calls `onMove` once and is a request: the row holds until it settles, a rejection restores it and says so. `canDrop(item, group)` is the one seam for a WIP limit or a status machine. With `action`, each row is a real `<form>` (Up/Down, or a target `select` per card). The handle alone has `touch-action: none`, so a phone still scrolls from a row's body. `SplitPane` is one column below `md`; `onResize` + `value` is how a split persists — storage is the app's.
- **What a model wrote is `Markdown`; code is `CodeBlock`; never `innerHTML`.** Raw HTML prints as text, links only http/https/mailto/relative, a remote image prints its alt as a link unless `resolveImage` vouches for it, `baseLevel` defaults to 2. Fences go through `CodeBlock`, highlighted only by the `languages` the caller passes (`allLanguages` on a server page; one named language in an island). Structured payloads are `JsonView`, changes `DiffView` (two texts or a unified patch), structured logs `LogViewer`, terminal output `TerminalView` (SGR colours as roles). A rich-text editor is `Textarea` plus a `Markdown` preview.

## Error codes

| Code | Means |
|---|---|
| `X_TOKEN_UNKNOWN` | a design token role that does not exist; `cause` lists the ones that do |
| `X_THEME_INVALID` | a theme that is not `light` or `dark` |
| `X_UI_RUNTIME_MISSING` | a host capability the component needs is absent (`IntersectionObserver`, `localStorage`) |
| `X_UI_INVALID_VALUE` | a formatting component got an unrenderable value — `NaN` money, an invalid date, a heading level off the scale |

Full rows: [Error codes](Error-Codes).
