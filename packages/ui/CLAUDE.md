# @ultimat3/ui — agent notes

Tier 4. Imports `@ultimat3/core`, `i18n`, `money`, `time` — **not `schema`**, which `package.json` does not declare: that is why `src/form/` re-declares Standard Schema's one member structurally (`FormSchema`) and copies `formatPath` as `formatFieldPath`. Never `http`, `action`, `render`, `admin` — `render` is tier 4 too, which keeps the static bundle graph out of the design system.

## Boundary

| Owns | Does not own |
|---|---|
| design tokens, theme resolution, Solid primitives, a11y helpers, the Lucide icon wrapper | routing, data fetching, business logic, layout of a specific app, icon **artwork** |

## Hard rules

- **SCSS modules only.** `Foo.tsx` + `Foo.module.scss`, always paired. No Tailwind, no CSS-in-JS, no inline `style` except CSS custom properties.
- **No raw colours.** Only `t.role('<role>')` / `var(--color-*)`. Canonical roles live in `src/tokens/_colors.scss`; `tokens.ts` mirrors them and `tokens.test.ts` fails on drift.
- **No raw length, breakpoint, z-index, shadow or duration** in any sheet here: `t.space()` / `t.stroke()` / `t.rem()`, `respond-*`, `t.z()`, `t.shadow()`, `t.duration()`. Held by `packages/cli/src/templates/scaffold-guards-style.test.ts`, which runs the guards `x new` ships over this package.
- **Logical properties only.** `margin-inline`, `inset-inline-start`, `text-align: start`. A `left`/`right` in a stylesheet is a bug.
- **solid-js is a type-only import.** All reactive access goes through `src/theme/solid-adapter.ts`. Never `import { createSignal } from 'solid-js'`.
- **The runtime SLOT is `src/theme/runtime-slot.ts`; the RULE is `solid-adapter.ts`, and the split is a byte measurement.** `solid-adapter.ts` reaches `../errors` and so core's error registry; the slot imports nothing, so an island that only calls `setSolidRuntime` pays 72 B, not 5,719. `barrel-bytes.test.ts` holds the ceiling at 1 kB.
- **The barrel is the ONE import path; component subpath exports are refused on measurement** (issue #275). A barrel import and a deep path emit the same modules and bytes, so `@ultimat3/ui/button` would be a second idiom for zero bytes. The two subpaths that exist are not exceptions: `./icons/*` is 1,767 data modules no bundler can split, and `./jsx-probe` is test-only. `barrel-bytes.test.ts` compares the two paths and names `schema-error-codes.ts` (Bun 1.4.0's load-correlated shake, issue #273) rather than allowing bytes for it. Its sibling #276 — a pure re-export entry shaken to its export clause — was fixed in Bun 1.4.1 (oven-sh/bun#40578), and barrels have been built as their own entry since.
- **`useUi()`'s server branch is a SLOT, and the module that fills it is browser-mapped** (issue #490). `context.ts` imports no value from `@ultimat3/i18n` or `@ultimat3/time`. `src/theme/ambient.ts` registers into `ambient-slot.ts` at import; `index.ts` imports it BARE above every re-export; `package.json`'s `browser` field maps it to `ambient.browser.ts`. A test reaching components by module path must `import './ambient'` itself. `errors.ts` is pure: `registerErrorCodes()` is `src/error-registry.ts`, imported bare.
- **`solid()` always answers off-DOM.** No registered runtime and no DOM is a *server render*, and it gets `INERT_SOLID_RUNTIME` (`src/theme/inert-runtime.ts`) — signals hold, memos recompute on read, effects never run, `useContext` returns the default. No DOM means no reactivity to lose; a **DOM** with no runtime is still `X_UI_RUNTIME_MISSING`, because that one is the theme toggle that does nothing. Never widen this to "no runtime, never throw": that is the silent degradation the split exists to prevent.
- **`useUi()` reads the request on the server**, via `ambientUiContext()` — `currentLocale()`, `currentTimeZone()`, `useI18n()`, which read **core's own `Ctx.locale` / `Ctx.tz`** (written once per request by `@ultimat3/http`'s `locale` stage). Never add a second ambient store here or in `i18n`/`time`. `theme`/`currency` have no ambient source at all.
- **Every locale-sensitive call takes the locale as an ARGUMENT, `toLocaleUpperCase` included.** `initialsOf(name, locale)` reads `useUi().locale`; a bare `toLocaleUpperCase()` reads the runtime's default (Turkish dotted `i` → `İ`).
- **`UiProvider` is client-only and throws on the server** (`providerNeedsRuntimeError`, the same `X_UI_RUNTIME_MISSING`). A Provider in an inert tree reaches no descendant — the tree is built before the renderer walks it, so consumers are walked outside every owner and read the context default even with a real Solid runtime registered. Rendering the children anyway would drop its locale, zone, currency and translator silently. Making it work needs the *renderer* to scope a context around the walk; until then it refuses.
- **A component may call `solid()` freely.** Its effects must stay DOM-only work — they simply never run on the server.
- **No `{...rest}` prop spreading.** Splitting props reactively needs solid's `splitProps` (a value import), so components declare explicit props and read `props.x` inside JSX.
- **One mode per use is a UNION of interfaces** (`LinkProps`, `PaginationProps`, `DataTableProps` — where the mode covers the pager AND the sort headers: `hrefFor` + `sortHrefFor`, or `onCursor` + `onSortChange`; a linked table never renders a button with no handler): a mode forbids the other's props with `x?: undefined`, and `catalog/parse-component.ts` merges the modes.
- **No hardcoded strings.** Label props, or `useUi().t(UI_KEYS.x)`. New built-in strings go in `src/i18n-keys.ts`.
- **Page layout is four composites**: `AppShell` (frame + skip link + landmarks), `PageHeader`, `Section`, `Toolbar`. A screen that hand-rolls a header grid is the bug they exist to prevent. `AppShell` holds no state; its mobile nav is a no-JS `popover`, and `Drawer` stays the modal off-canvas.
- **Restyling goes through `defineTheme()`**, never a forked stylesheet and never an SCSS `with ()` override. Its values are validated, not escaped: the output lands in a `<style>` element.
- **`@include t.tone-classes`** emits the `.tone-*` custom-property blocks. Never hand-write a seventh copy; `$tones` in `_colors.scss` mirrors `TONES` and `variants.test.ts` gates it.
- **Icons are generated, never authored.** `src/icons/glyphs/*.ts` is one module per Lucide icon, written by `bun run icons` from `lucide-static@LUCIDE_VERSION`. Never hand-edit a glyph, never add a hand-drawn one, never introduce a second icon source. An upstream fix is a version bump plus a re-run. `lucide` itself is NOT a dependency — the data is committed, so the package still installs, typechecks and renders offline with zero runtime deps.
- **One icon, one module.** The `Icon` component takes a `glyph`, not a name: a `name → glyph` map would be one module holding 1767 icons, and no bundler can split that. Per-icon imports are the whole point (1 icon = 104 B minified, 50 = 8.9 kB).
- **Server-rendered first, an island second.** Components run in islands (`examples/dummy`'s settings and feed islands render them), but every one must still be correct server-rendered and usable with scripting off — `<details>` for disclosure, `<input list>`+`<datalist>` for suggestions, a real `rel="next"` link for paging — with listeners and observers as additive extras. A component that renders nothing until JS runs does not ship. In an island the body runs ONCE: a branch decided there (an early `return <ErrorState>`) is decided for the island's life, so branches live inside the returned JSX (`AsyncRegion`, `DataTable`). A server-only spelling is gated on `typeof document` (`Textarea`'s parser newline). Ids minted in an island carry a per-copy scope (`a11y.ts`), because each island bundles its own counter.
- **`inert-render.test.ts` must not assume which factory its `.tsx` compiled to.** `@ultimat3/render` installs a process-global `.tsx` `onLoad` plugin at import, so in one `bun test` process a component may compile to render's `h`. The walker recognises both (`Symbol.for('ultimate.render.jsx')`), and the first test asserts a recognised node — otherwise the file renders `"[object Object]"` and passes by shard packing.
- **Components are not unit-tested through a renderer.** `.tsx` compiles to `@ultimat3/render`'s `h`, which this package may not import, so every rule lives in a pure module beside the component (`icon-glyph.ts`, `accordion-view.ts`, `combobox-filter.ts`, `infinite-scroll-view.ts`) and *that* is what the tests assert.
- Formatting logic lives in a pure `*-view.ts` next to the component (`money-view.ts`, `date-time-view.ts`) so it is testable with no renderer. Every other renderer-free core follows the same rule under its own name (`sort-state.ts`, `image-source.ts`) — the `.tsx` holds markup, never a rule.
- **The rule being pure is not enough — the WIRING is tested too.** `src/jsx-probe.ts` reads the props an element carries and `src/fake-dom.ts` is a DOM where a disabled control refuses focus; both TEST-ONLY, neither in `index.ts`. `probe`/`unprobe` are the framework's ONE owner of `globalThis.React`, reachable at `@ultimat3/ui/jsx-probe` (admin imports them). A keyboard or form-participation claim is proven in `components/interaction.test.ts`.
- **A roving group excludes disabled items from both answers** — the set arrows walk and the one item holding the tab stop (`src/roving.ts`). `focus()` on a disabled control is a no-op, so a disabled item left in the list pins the reducer on its index forever. And a control that answers arrows itself (`handlesOwnArrowKeys`) keeps them: a `Toolbar` exists to hold a search field.
- **A single-winner state attribute is decided by POSITION, never by a missing prop.** `Breadcrumb` gives `aria-current="page"` to the last item and to nothing else; an href-less ancestor renders as plain text with no `aria-current` at all. Reading "no href" as "is the current page" put two of them in one `<nav>`. `Tabs.tsx` is the same rule for `tabindex`, and `Breadcrumb.test.ts` proves it through `jsx-probe` rather than through the pure helper.
- **One async region, four branches, and `empty` is unreachable while `pending`.** `asyncBranch` (`src/components/async-branch.ts`) is the ONLY place the decision is made — `AsyncRegion` renders it, `DataTable` calls it. `AsyncState` is core's (imported, never re-exported). `empty` and `ready` are REQUIRED props; `refreshing` carries the previous data and dims it (`aria-busy`), never tears it down; `reserve` feeds the placeholder AND every branch's `min-block-size`.
- **A toast dwell stops for THREE independent reasons** — hover, focus-within, `document.hidden` — so `ToastHold` is a set, never a boolean. Duration is a TOKEN (`TOAST_DWELL_MS`). Rules are pure (`src/toast/toast-state.ts`), the clock injected (`ToastEnv`); a server render gets `INERT_TOAST_ENV` and `ToastRegion` still emits its empty live region.
- **`announce()` writes into a region `AppShell` already rendered** (`liveRegionAttrs` is the one derivation). For a state change with no surface of its own; a notification is a `Toast` — never both for one message.
- **`loading` never sets the native `disabled` attribute** (`Button`): `aria-disabled` + a refused click keeps it focusable and readable; `Button.module.scss` restores full opacity under `[aria-busy='true']`. `<Form busy>` refuses the submit again.
- **A failed submit focuses the first invalid CONTROL, and the summary only when there is none.** `firstInvalidField` answers in DECLARATION order; `fieldSelector` is the allowlist between a caller's string and a selector.
- **`defineTheme()` refuses a palette that fails WCAG 2.2 AA** (`X_UI_CONTRAST_INSUFFICIENT`), measured against `CONTRAST_PAIRS` on the RESOLVED palette, only for pairings the brand changed. AA, never APCA.
- **A preset is a BASE, never a mode.** `defineTheme({ preset })` merges `THEME_PRESETS[name]` under the app's overrides key by key (an `undefined` override is no override), then runs every existing check on the merged result. A preset states ALL colour roles in both themes, so `presets.test.ts` measures it alone against `CONTRAST_PAIRS`, the chart CVD floor and the scrim rule. A new preset is a row in `presets.ts` plus its file; no preset forces a theme or ships CSS.
- **Chart series are measured twice**: 3:1 on all four surfaces (`CONTRAST_PAIRS`), and `CHART_DISTINCT_MIN` ΔE apart under protan/deutan/tritan simulation (`colour-vision.ts`, `colour-vision.test.ts`). Moving one channel of one series can break the second check without touching the first.
- **A `defineTheme()` shadow is a GRAMMAR match** (`theme/shadow-value.ts`), not a pattern of allowed characters: layers of lengths plus `rgb(R G B / a)` or `rgb(var(--color-<known role>) / a)`. The glow and tinted rungs read `--color-accent`, so a brand's accent recolours them for free — `tokens.test.ts` refuses a channel literal there.
- **Live semantics belong to the container that outlives the message.** `ToastRegion`'s `<ol>` carries `aria-live`; a `Toast` is a plain `<li>`. A region created with its content already inside it is not announced, and a `role="status"` on the `<li>` also strips its `listitem` semantics.
- **`aria-checked` never mirrors a native `checked`.** ARIA outranks host state in the accessibility tree, and on the no-JS path this package supports there is nothing to rewrite the attribute after the user ticks the box. `Checkbox` writes only `'mixed'` (an IDL property with no attribute form, so ARIA is the only server-side lever); `Switch` writes none at all, over a `biome-ignore` that says why.
- **A form binds to an action; it never decides for one.** `useForm` (`src/form/`) is a binding over an existing `action`, not a ninth primitive and not a component — `submit` is REQUIRED and is the only producer of a `succeeded` state, and the client-side parse's **value** is discarded so that only its issues are read. A binding that submitted the locally-parsed value would let a browser choose what the server was asked to store; `FormSchema` has no output type for that reason.
- **One path grammar, both directions.** A control's `name` and a schema issue's path are the same string (`items[0].price`), which is what lets a rejection find its control with no per-form mapping table. `formatFieldPath` mirrors `@ultimat3/schema`'s `formatPath` — **keep it in sync**, because the server rendered the incoming path with THAT function — and `parseFieldPath` is its inverse, refusing `__proto__`, `items[]`, `items.0.price` and an index above `MAX_FIELD_INDEX`.
- **An issue that matches no declared field is SURFACED, never swallowed.** It goes to `formErrors`, which `<Form error>` announces and focuses; a near miss (`items` against a form holding `items[0].price`) goes there too, because an error rendered against the wrong input is a lie the user acts on. Two issues on one field both survive in the state — `Field`'s one slot renders the first, `messagesFor` has the rest.
- **The framework ships the mapping and no copy table.** `FormIssue.message` is a schema's diagnostic text and is never user-facing; `messageFor` is required and is the app's. There is deliberately no `ui.form.*` key: a built-in wording would be one app's convention shipped to every other. A `messageFor` that answers `''` or throws falls back to the diagnostic text — the loud-but-safe answer `t()` already gives with `⟦key⟧`, because the alternatives are a control marked `aria-invalid` with nothing to read, or a submit abandoned mid-flight holding the user's input.
- **The wire carries no structured issue list, `As of 2026-08-24`.** `InputInvalidError` renders the issues into `cause` and puts nothing in `meta`, and `toProblem` has no `issues` member, so `issuesFromRejection` reads `meta.issues` where there is one and parses the cause line where there is not. It binds a fragment to a field only when the fragment's head is a DECLARED path, so a mis-split degrades to a form-level error rather than to a wrong control. Delete the line parser the day the wire carries the list.
- **Generated source is a CODE sink.** `build-icons.ts` writes modules every app executes, from network data: attribute values go through `JSON.stringify`, and `SAFE_ATTR_VALUE` refuses anything that is not glyph geometry. Malformed upstream data is `X_UI_INVALID_VALUE`; only real environment faults (no network, no biome) are `X_UI_RUNTIME_MISSING`.
- **The icon NAME is the third sink, and it has no escape.** It becomes a path under `GLYPHS_DIR` (which `buildIcons` clears), an identifier and a banner, so `SAFE_ICON_NAME` (`/^[a-z0-9]+(-[a-z0-9]+)*$/`) is checked in `parseIconNodes` before `out.set`; `build-icons.test.ts` asserts all 1767 committed names pass.

## Files

| Path | Responsibility |
|---|---|
| `src/tokens/*.scss` | canonical token maps + `_mixins.scss` authoring helpers (`respond-to`/`-down`/`-between`) + `_units.scss` (`rem()`, `fluid()`). Every `@error` is `string.unquote('X_CODE: … fix: …')` with a REGISTERED code — `mixins.test.ts` |
| `src/tokens/theme.scss` | the only stylesheet that emits global custom properties |
| `src/tokens/reset.scss` | the reset, ZERO specificity: every rule a component may restyle sits in `:where(…)` whole, pseudo-class inside (`:where(a:hover)`, never `:where(a):hover`). `a:hover` (0,1,1) beat `.primary` and hid a button link's text until 22.3.2. `reset.test.ts` computes it |
| `src/theme/runtime-slot.ts` | the module-scope slot holding the app's Solid runtime — and nothing else, so registering one costs an island 72 B |
| `src/theme/solid-adapter.ts` | the runtime's SHAPE, and the one rule that decides which runtime a render gets |
| `src/theme/inert-runtime.ts` | `INERT_SOLID_RUNTIME` — what a server render IS, not a stub of what it lacks |
| `src/theme/theme.ts` | resolution: stored choice → the theme the boot stamped on `<html>` (`ThemeEnv.current()`) → the app default (`data-theme-default`, `ThemeEnv.appDefault()`) → OS; clearing and the OS listener answer the app default too; all side effects via injected `ThemeEnv` |
| `src/theme/ambient-slot.ts` | the module-scope slot holding the reader `useUi()` falls back to on the server — imports nothing, so a browser chunk pays nothing for it |
| `src/theme/ambient.ts` | the server's reader (`ambientUiContext`: request locale, zone, direction, translator), registered at import; `index.ts` imports it bare, and the `browser` field maps it to `ambient.browser.ts`, which answers the defaults and registers nothing |
| `src/error-registry.ts` | the `registerErrorCodes()` call, alone, so `errors.ts` is pure and the barrel's re-export of it costs a chunk nothing |
| `src/components/` | 67 components, `PascalCase.tsx` (component convention overrides the repo's kebab-case) |
| `src/icons/glyphs/` | GENERATED: 1767 per-icon modules, `@ultimat3/ui/icons/<name>` → `icon<Name>` |
| `src/icons/build-icons.ts` | the generator + the pinned `LUCIDE_VERSION`; `LICENSE.lucide` is upstream's ISC text |
| `src/theme/brand.ts` | `defineTheme()` — the ONE brand-override seam; there is no SCSS `@use ... with ()` path. Merges a preset under the overrides, measures, emits at every level `theme.scss` does |
| `src/theme/brand-declarations.ts` | each slot's validation + its custom-property lines, in canonical order (colours, shadows, radius, font) |
| `src/theme/shadow-value.ts` | the shadow-value grammar a brand override must match |
| `src/theme/presets.ts` · `preset-shape.ts` · `preset-scifi.ts` | `THEME_PRESETS` (`scifi`), the `ThemePreset` shape + `FONT_SLOTS`, and the scifi data |
| `src/tokens/color-tokens.ts` | `COLOR_ROLES`, `CHART_ROLES`, the channel mirror — split from `tokens.ts` by size, re-exported by it |
| `src/tokens/colour-vision.ts` | Machado 2009 dichromacy simulation + CIE76 ΔE; `closestChartPair()` answers the pair to move |
| `src/tokens/_touch.scss` · `_effects.scss` | `--touch-target` + `touch-target` mixin; `glow-edge` and `grid-texture` (CSS only, static, withdrawn under `prefers-contrast: more` / `forced-colors`) |
| `src/tokens/contrast.ts` | WCAG ratios over the channel tokens; `contrast.test.ts` gates AA in both themes |
| `src/catalog/` | parses `components/*.tsx` into `CATALOG.md`; `bun run catalog` writes it, `catalog.test.ts` fails on drift |
| `src/roving.ts` | the pure rules of a keyboard group: navigable set, tab stop, who keeps their own arrows |
| `src/components/async-branch.ts` | the one `(pending, failed, empty, ready)` decision, plus the `reserve` box both the placeholder and the loaded content land in |
| `src/toast/toast-state.ts` | the toast queue's pure rules: dedupe, the visible cap, and what a tick may spend |
| `src/toast/toast-store.ts` | the same queue with a clock and the three pause holds; `ToastEnv` is the injected host |
| `src/toast/use-toasts.ts` | the Solid shell: the store's queue in a signal, subscribed from an effect so a server render never does |
| `src/form/form-touch.ts` | touched and dirty — progress through a form, never a second copy of its values |
| `src/tokens/contrast-pairs.ts` | every pairing a component renders, with its AA floor; read by `defineTheme()` and by `contrast.test.ts` |
| `src/form/field-path.ts` | the one path grammar, both directions — pure, and deliberately free of `../errors` so mapping an issue costs no chunk the error registry |
| `src/form/form-issue.ts` | the two readers of an issue: a local parse result, and whatever the server rejected with |
| `src/form/form-state.ts` | where an issue LANDS — the declared field, or the form |
| `src/form/form-binding.ts` | the submit state machine; the one place a `succeeded` exists |
| `src/form/use-form.ts` | the Solid shell: the same binding with its state in a signal |
| `src/form/form-values.ts` | `FormData` → the nested object the action's input schema declares |
| `src/form/field-binding.test.ts` | the WIRING, end to end: a rejection reaching `aria-invalid` and `aria-describedby` on the control it named |
| `src/sass-probe.ts` | TEST-ONLY: what Sass EMITS. `sass` is resolved from `packages/render`'s directory — never an import of render, never a second copy |
| `src/components/button-classes.ts` | the keys of a button's look, asked by `Button` AND `<Link appearance="button">` (`link-classes.ts`). `Button` gets no `href` |
| `src/fake-dom.ts` | TEST-ONLY: a DOM where a disabled control refuses focus. Never exported from `index.ts` |
| `src/jsx-probe.ts` | TEST-ONLY: a component's node tree, so a test can assert the props and call the handlers an element carries. `probe`/`unprobe` are the framework's ONE owner of `globalThis.React`, reached from `@ultimat3/admin` at `@ultimat3/ui/jsx-probe`; the walkers stay internal |
| `src/barrel-bytes.test.ts` | the build error behind the three claims above: the setter's byte ceiling, barrel-vs-deep-path parity, and the theme-toggle island's retained-module list — the last two read off the `minify: false` banners, never a byte allowance |
| `src/components/style-classes.test.ts` | the build error behind "every `styles['x']` a component names is declared in its own `.module.scss`" — under `bun test` a `.module.scss` import resolves to the file PATH, so no render can catch a dead class |

## Assumed peer contracts

`@ultimat3/money` → `formatMoney(money, { locale })`; `@ultimat3/time` → `formatDateTime(date, { locale, timeZone, dateStyle?, timeStyle? })`. Both are injectable via a `format` prop, so a signature change touches one line.

## Commands

```
bun test                                  # from the repo root
bun run --filter @ultimat3/ui typecheck
bun run --filter @ultimat3/ui catalog     # after any prop change — CATALOG.md is gated
bun run --filter @ultimat3/ui icons       # regenerate the glyph set (network; dev-only)
bun run --filter @ultimat3/ui icons --bump  # move LUCIDE_VERSION to the latest lucide-static, then regenerate
```

## Deep import

`@ultimat3/ui/icons/*` resolves through the package's `exports` map. Inside this monorepo a
`tsconfig` that maps `@ultimat3/*` to `packages/*/src` needs the more specific entry
`"@ultimat3/ui/icons/*": ["./packages/ui/src/icons/glyphs/*"]` for TypeScript to follow it —
runtime resolution is the `exports` map either way.

Why each rule above is shaped the way it is: [`docs/history/ui.md`](../../docs/history/ui.md).
