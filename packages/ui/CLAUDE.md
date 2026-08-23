# @ultimat3/ui — agent notes

Tier 4 (moved 5 → 4 on 2026-08-19, when the `admin → ui` exception was deleted). Imports `@ultimat3/core`, `schema`, `i18n`, `money`, `time`. Never `http`, `action`, `render`, `admin` — `render` is tier 4 too, which is what keeps the static bundle graph out of the design system.

## Boundary

| Owns | Does not own |
|---|---|
| design tokens, theme resolution, Solid primitives, a11y helpers, the Lucide icon wrapper | routing, data fetching, business logic, layout of a specific app, icon **artwork** |

## Hard rules

- **SCSS modules only.** `Foo.tsx` + `Foo.module.scss`, always paired. No Tailwind, no CSS-in-JS, no inline `style` except CSS custom properties.
- **No raw colours.** Only `t.role('<role>')` / `var(--color-*)`. Canonical roles live in `src/tokens/_colors.scss`; `tokens.ts` mirrors them and `tokens.test.ts` fails on drift.
- **Logical properties only.** `margin-inline`, `inset-inline-start`, `text-align: start`. A `left`/`right` in a stylesheet is a bug.
- **solid-js is a type-only import.** All reactive access goes through `src/theme/solid-adapter.ts`. Never `import { createSignal } from 'solid-js'`.
- **The runtime SLOT is `src/theme/runtime-slot.ts`; the RULE is `solid-adapter.ts`, and the split is a byte measurement.** `solid()` throws `runtimeMissingError`, so it imports `../errors`, which `package.json` declares side-effectful (`registerErrorCodes()` runs at import) and no bundler may shake — so while the slot sat beside it, an island whose `mount` did nothing but `setSolidRuntime(solidRuntime)` carried @ultimat3/core's whole error registry: **5,719 B against 72 B**. One module owns `let runtime`, `solid()` reads it through `registeredSolidRuntime()`, and `barrel-bytes.test.ts` holds the ceiling at 1 kB — small enough that the registry re-entering the graph reds it.
- **The barrel is the ONE import path, and component subpath exports are refused on measurement** (2026-08-23, issue #275). `import { Button } from '@ultimat3/ui'` and a deep path into `components/Button` emit the same chunk, to within the length of the entry's own module name; so do `useUi` (14 kB) and `moneyText` (25 kB). `@ultimat3/ui/button` would be a second idiom for zero bytes. The two subpaths that exist are not exceptions to that: `./icons/*` is 1,767 data modules no bundler can split, and `./jsx-probe` is test-only and deliberately absent from the barrel. `barrel-bytes.test.ts` compares the two paths, so the day the barrel stops shaking this argument reds instead of ageing.
- **`solid()` always answers off-DOM.** No registered runtime and no DOM is a *server render*, and it gets `INERT_SOLID_RUNTIME` (`src/theme/inert-runtime.ts`) — signals hold, memos recompute on read, effects never run, `useContext` returns the default. No DOM means no reactivity to lose; a **DOM** with no runtime is still `X_UI_RUNTIME_MISSING`, because that one is the theme toggle that does nothing. Never widen this to "no runtime, never throw": that is the silent degradation the split exists to prevent.
- **`useUi()` reads the request on the server**, via `ambientUiContext()` — `currentLocale()`, `currentTimeZone()`, `useI18n()`. Those two read **core's own `Ctx.locale` / `Ctx.tz`**, which `@ultimat3/http`'s `locale` stage writes once per request; `@ultimat3/i18n` and `@ultimat3/time` publish no field of their own. Never add a second ambient store here or there — `time` kept a `ctx['timeZone']` nothing wrote until 2026-08, and the whole cost was invisible: every server-rendered date formatted in UTC under a doc comment saying it did not. `theme`/`currency` deliberately have no ambient source at all.
- **`UiProvider` is client-only and throws on the server** (`providerNeedsRuntimeError`, the same `X_UI_RUNTIME_MISSING`). A Provider in an inert tree reaches no descendant — the tree is built before the renderer walks it, so consumers are walked outside every owner and read the context default even with a real Solid runtime registered. Rendering the children anyway would drop its locale, zone, currency and translator silently. Making it work needs the *renderer* to scope a context around the walk; until then it refuses.
- **A component may call `solid()` freely.** Its effects must stay DOM-only work — they simply never run on the server.
- **No `{...rest}` prop spreading.** Splitting props reactively needs solid's `splitProps` (a value import), so components declare explicit props and read `props.x` inside JSX.
- **No hardcoded strings.** Label props, or `useUi().t(UI_KEYS.x)`. New built-in strings go in `src/i18n-keys.ts`.
- **Page layout is four composites**: `AppShell` (frame + skip link + landmarks), `PageHeader`, `Section`, `Toolbar`. A screen that hand-rolls a header grid is the bug they exist to prevent. `AppShell` holds no state — off-canvas is `Drawer`.
- **Restyling goes through `defineTheme()`**, never a forked stylesheet and never an SCSS `with ()` override. Its values are validated, not escaped: the output lands in a `<style>` element.
- **`@include t.tone-classes`** emits the `.tone-*` custom-property blocks. Never hand-write a seventh copy; `$tones` in `_colors.scss` mirrors `TONES` and `variants.test.ts` gates it.
- **Icons are generated, never authored.** `src/icons/glyphs/*.ts` is one module per Lucide icon, written by `bun run icons` from `lucide-static@LUCIDE_VERSION`. Never hand-edit a glyph, never add a hand-drawn one, never introduce a second icon source. An upstream fix is a version bump plus a re-run. `lucide` itself is NOT a dependency — the data is committed, so the package still installs, typechecks and renders offline with zero runtime deps.
- **One icon, one module.** The `Icon` component takes a `glyph`, not a name: a `name → glyph` map would be one module holding 1767 icons, and no bundler can split that. Per-icon imports are the whole point (1 icon = 104 B minified, 50 = 8.9 kB).
- **No client runtime exists yet.** A new interactive component must be correct server-rendered and usable with scripting off — `<details>` for disclosure, `<input list>`+`<datalist>` for suggestions, a real `rel="next"` link for paging — with listeners and observers as additive extras. A component that renders nothing until JS runs does not ship.
- **`inert-render.test.ts` must not assume which factory its `.tsx` compiled to.** `@ultimat3/render`'s `index.ts` installs a process-global `Bun.plugin` `onLoad` for `/\.tsx$/` at import, and `bun test` is one process — so any file in the run that imports render first makes every ui component after it compile to render's `h` instead of the file's own inert copy. The walker recognises both (`Symbol.for('ultimate.render.jsx')`, off the global registry, never an import), and the first test in the describe asserts a component returned a node it recognises. Without both halves the file silently rendered `"[object Object]"` and 26 assertions were decided by shard packing.
- **Components are not unit-tested through a renderer.** `.tsx` compiles to `@ultimat3/render`'s `h`, which this package may not import, so every rule lives in a pure module beside the component (`icon-glyph.ts`, `accordion-view.ts`, `combobox-filter.ts`, `infinite-scroll-view.ts`) and *that* is what the tests assert.
- Formatting logic lives in a pure `*-view.ts` next to the component (`money-view.ts`, `date-time-view.ts`) so it is testable with no renderer. Every other renderer-free core follows the same rule under its own name (`sort-state.ts`, `image-source.ts`) — the `.tsx` holds markup, never a rule.
- **The rule being pure is not enough — the WIRING has to be tested too.** `createRovingTabindex` was correct and `Menu` handed it `[role="menuitem"]`, so a disabled item made every item after it unreachable and every assertion in the package still passed. `src/jsx-probe.ts` reads the props an element actually carries (a `tabindex`, an `aria-live`, an `onKeyDown`, a `ref`) and `src/fake-dom.ts` gives it a DOM where a disabled control REFUSES focus, exactly as the real one does. Both are test-only and neither is in `index.ts`. `jsx-probe`'s `probe`/`unprobe` are the one exception, reachable at the subpath `@ultimat3/ui/jsx-probe` and still absent from the barrel: `globalThis.React` is ONE property, so its install/restore counter has to be ONE counter — `@ultimat3/admin` (tier 5) kept a second pair, and interleaved installs restored the two harnesses in the wrong order, leaving the global holding a harness the run had already torn down. `components/interaction.test.ts` is where a keyboard or form-participation claim gets proven; asserting the pure helper alone is how these shipped.
- **A roving group excludes disabled items from both answers** — the set arrows walk and the one item holding the tab stop (`src/roving.ts`). `focus()` on a disabled control is a no-op, so a disabled item left in the list pins the reducer on its index forever. And a control that answers arrows itself (`handlesOwnArrowKeys`) keeps them: a `Toolbar` exists to hold a search field.
- **A single-winner state attribute is decided by POSITION, never by a missing prop.** `Breadcrumb` gives `aria-current="page"` to the last item and to nothing else; an href-less ancestor renders as plain text with no `aria-current` at all. Reading "no href" as "is the current page" put two of them in one `<nav>`. `Tabs.tsx` is the same rule for `tabindex`, and `Breadcrumb.test.ts` proves it through `jsx-probe` rather than through the pure helper.
- **Live semantics belong to the container that outlives the message.** `ToastRegion`'s `<ol>` carries `aria-live`; a `Toast` is a plain `<li>`. A region created with its content already inside it is not announced, and a `role="status"` on the `<li>` also strips its `listitem` semantics.
- **`aria-checked` never mirrors a native `checked`.** ARIA outranks host state in the accessibility tree, and on the no-JS path this package supports there is nothing to rewrite the attribute after the user ticks the box. `Checkbox` writes only `'mixed'` (an IDL property with no attribute form, so ARIA is the only server-side lever); `Switch` writes none at all, over a `biome-ignore` that says why.
- **Generated source is a CODE sink.** `build-icons.ts` writes modules every app EXECUTES at import, from data fetched over the network, so an attribute value goes through `JSON.stringify` and never `'${value}'` — and `SAFE_ATTR_VALUE` refuses anything that is not glyph geometry one layer earlier. `iconElements` guards tags and attribute NAMES; it has never guarded a value. Malformed upstream data is `X_UI_INVALID_VALUE`; only the generator's real environment faults (no network, no biome binary) are `X_UI_RUNTIME_MISSING`.
- **The icon NAME is the third sink, and it has no escape.** The upstream map key becomes a filesystem path under `GLYPHS_DIR`, an exported identifier and a `//` banner, and `buildIcons` clears `GLYPHS_DIR` before it writes — so `../../index` was a delete of the glyph tree followed by an overwrite of a hand-written module, and a key carrying `;` produced a module that typechecked and ran. `SAFE_ICON_NAME` (`/^[a-z0-9]+(-[a-z0-9]+)*$/`) is checked in `parseIconNodes` BEFORE `out.set`, the same allowlist-over-a-sink shape as `SAFE_ATTR_VALUE` one layer down; all 1767 committed names pass it and `build-icons.test.ts` asserts that.

## Files

| Path | Responsibility |
|---|---|
| `src/tokens/*.scss` | canonical token maps + `_mixins.scss` authoring helpers |
| `src/tokens/theme.scss` | the only stylesheet that emits global custom properties |
| `src/theme/runtime-slot.ts` | the module-scope slot holding the app's Solid runtime — and nothing else, so registering one costs an island 72 B |
| `src/theme/solid-adapter.ts` | the runtime's SHAPE, and the one rule that decides which runtime a render gets |
| `src/theme/inert-runtime.ts` | `INERT_SOLID_RUNTIME` — what a server render IS, not a stub of what it lacks |
| `src/theme/theme.ts` | resolution: stored choice → OS; all side effects via injected `ThemeEnv` |
| `src/theme/inline-script.ts` | anti-flash `<head>` snippet + its CSP sha256 |
| `src/components/` | 50 components, `PascalCase.tsx` (component convention overrides the repo's kebab-case) |
| `src/icons/glyphs/` | GENERATED: 1767 per-icon modules, `@ultimat3/ui/icons/<name>` → `icon<Name>` |
| `src/icons/build-icons.ts` | the generator + the pinned `LUCIDE_VERSION`; `LICENSE.lucide` is upstream's ISC text |
| `src/theme/brand.ts` | `defineTheme()` — the ONE brand-override seam; there is no SCSS `@use ... with ()` path |
| `src/tokens/contrast.ts` | WCAG ratios over the channel tokens; `contrast.test.ts` gates AA in both themes |
| `src/catalog/` | parses `components/*.tsx` into `CATALOG.md`; `bun run catalog` writes it, `catalog.test.ts` fails on drift |
| `src/roving.ts` | the pure rules of a keyboard group: navigable set, tab stop, who keeps their own arrows |
| `src/fake-dom.ts` | TEST-ONLY: a DOM where a disabled control refuses focus. Never exported from `index.ts` |
| `src/jsx-probe.ts` | TEST-ONLY: a component's node tree, so a test can assert the props and call the handlers an element carries. `probe`/`unprobe` are the framework's ONE owner of `globalThis.React`, reached from `@ultimat3/admin` at `@ultimat3/ui/jsx-probe`; the walkers stay internal |
| `src/barrel-bytes.test.ts` | the build error behind the two byte claims above: the setter's ceiling, and barrel-vs-deep-path parity |
| `src/components/style-classes.test.ts` | the build error behind "every `styles['x']` a component names is declared in its own `.module.scss`" — under `bun test` a `.module.scss` import resolves to the file PATH, so no render can catch a dead class |

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
