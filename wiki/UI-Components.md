# UI components

`@ultimat3/ui` — 46 SolidJS components on the semantic tokens in [Theming](Theming). SCSS modules, logical properties, no Tailwind, no CSS-in-JS.

v1.1.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

## The catalog is generated — read it, don't ask

**[`packages/ui/CATALOG.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/CATALOG.md)** documents all 46 components with every prop, every type, and the token scales, parsed straight out of `packages/ui/src/components/*.tsx`. It ships inside the npm tarball, so it is on disk at `node_modules/@ultimat3/ui/CATALOG.md` in any app.

| Concern | Answer |
|---|---|
| Regenerate | `bun run --filter @ultimat3/ui catalog` |
| Drift | `catalog.test.ts` compares the committed file byte-for-byte against a fresh build; a prop change with no regen is a red `x verify` |
| Hand edits | refused by the same test — the file carries a `GENERATED` banner |

This page does **not** restate those 848 lines. It covers the four page composites, because they are the ones an agent picks wrong.

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
| `sidebarLabel` | `string` | `t('ui.navigation')` |
| `skipLabel` | `string` | `t('ui.skip')` |
| `sidebarWidth` | `string` | `'16rem'` |
| `stickyHeader` | `boolean` | **sticky unless explicitly `false`** — `undefined` is sticky |
| `class` | `string` | — |

Landmark order in the DOM: `banner` → `navigation` → `main` → `contentinfo`. `<main>` is unconditional.

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

## Rules an agent must not break

- **SCSS modules only.** `Foo.tsx` + `Foo.module.scss`, always paired. The only inline `style` allowed is a CSS custom property.
- **Logical properties.** `margin-inline`, `inset-inline-start`, `text-align: start`. A `left`/`right` in a stylesheet is a bug.
- **No hardcoded strings.** Label props, or the built-in keys in `src/i18n-keys.ts` → [I18n](I18n).
- **No raw colours.** `t.role('<role>')` or `var(--color-*)` → [Theming](Theming).
- **No prop spreading.** Components declare explicit props; there is no `{...rest}`.
- **`solid-js` is a type-only import** inside the package — reactive access goes through one registered adapter, so the design system does not pin a renderer version.
- Formatting logic lives in a pure `*-view.ts` beside the component (`money-view.ts`, `date-time-view.ts`), testable with no renderer.

## Error codes

| Code | Means |
|---|---|
| `X_TOKEN_UNKNOWN` | a design token role that does not exist; `cause` lists the ones that do |
| `X_THEME_INVALID` | a theme that is not `light` or `dark` |
| `X_UI_RUNTIME_MISSING` | a host capability the component needs is absent (`IntersectionObserver`, `localStorage`) |
| `X_UI_INVALID_VALUE` | a formatting component got an unrenderable value — `NaN` money, an invalid date, a heading level off the scale |

Full rows: [Error codes](Error-Codes).
