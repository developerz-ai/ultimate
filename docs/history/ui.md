# @ultimat3/ui — history

The reasoning moved out of [`packages/ui/CLAUDE.md`](../../packages/ui/CLAUDE.md) (plan 101,
slice 17 f, `As of 2026-09-23`), verbatim and under its original headings. A record of why, never
a current fact: the rules that still hold are in that file, and where the two disagree it wins.

## @ultimat3/ui — agent notes

Tier 4 (moved 5 → 4 on 2026-08-19, when the `admin → ui` exception was deleted). Imports `@ultimat3/core`, `i18n`, `money`, `time` — **not `schema`**, which this line claimed until 2026-08-24 and `package.json` never declared. That absence is why `src/form/` re-declares Standard Schema's one member structurally (`FormSchema`) and copies `formatPath` as `formatFieldPath`: the tier table permits the edge, the manifest and the lockfile do not. Never `http`, `action`, `render`, `admin` — `render` is tier 4 too, which is what keeps the static bundle graph out of the design system.


## Hard rules

- **The runtime SLOT is `src/theme/runtime-slot.ts`; the RULE is `solid-adapter.ts`, and the split is a byte measurement.** `solid()` throws `runtimeMissingError`, so it imports `../errors`, which bare-imports `error-registry.ts` — the `registerErrorCodes()` call `package.json` declares side-effectful and no bundler may shake — so while the slot sat beside it, an island whose `mount` did nothing but `setSolidRuntime(solidRuntime)` carried @ultimat3/core's whole error registry: **5,719 B against 72 B**. One module owns `let runtime`, `solid()` reads it through `registeredSolidRuntime()`, and `scripts/ui-barrel-bytes.test.ts` holds the ceiling at 1 kB — small enough that the registry re-entering the graph reds it.

- **The barrel is the ONE import path, and component subpath exports are refused on measurement** (2026-08-23, issue #275). `import { Button } from '@ultimat3/ui'` and a deep path into `components/Button` emit the same chunk — the same MODULES, and the same bytes to the character once the bundler's own banner comments are out; so do `useUi` (14 kB) and `moneyText` (25 kB). `@ultimat3/ui/button` would be a second idiom for zero bytes. The two subpaths that exist are not exceptions to that: `./icons/*` is 1,767 data modules no bundler can split, and `./jsx-probe` is test-only and deliberately absent from the barrel. `scripts/ui-barrel-bytes.test.ts` compares the two paths, so the day the barrel stops shaking this argument reds instead of ageing. **Not "to within the length of the entry's own module name"**, which this line said until 2026-08-25 and no build agrees with: measured, an entry file name 29 characters longer produced a chunk of identical size, and the only difference between the two minified chunks was the minifier's identifier allocation — one byte. What DOES differ, from one build to the next and with no source change at all, is whether Bun 1.4.0's shaker dropped `@ultimat3/core`'s `schema-error-codes.ts` (1,116 B, load-correlated, issue #273); the test names that module rather than allowing bytes for it. #276, filed from the same sweep, was a different 1.4.0 shake — a pure re-export entry under a `sideEffects` field that did not name it was emptied to its `export { … }` clause, so every barrel test bundled through a re-exporting wrapper; Bun 1.4.1 fixed it (oven-sh/bun#40578), and on 1.4.2 the wrapper and its negative control were deleted.

- **`useUi()`'s server branch is a SLOT, and the module that fills it is browser-mapped** (2026-09-19, issue #490). `context.ts` is what every component's `useUi()` retains, and it imports NO value from `@ultimat3/i18n` or `@ultimat3/time`: the i18n barrel installs the framework catalog at import, so one `createTranslator`/`currentLocale` there was 16.1 kB of catalog, time and core's logger in every island with a `UiProvider` — for a branch a DOM never takes. The request readers live in `src/theme/ambient.ts`, which registers `ambientUiContext` into `src/theme/ambient-slot.ts` at import; `index.ts` imports it BARE, above every re-export, and `package.json`'s `browser` field maps that file to `ambient.browser.ts` for a browser bundler (measured on Bun 1.4.0 and 1.4.2, symlinked or not — and never at runtime, so `bun test` and SSR always get the server's). `directionOf` is `@ultimat3/core`'s for the same reason, and `fallbackTranslator` is written here with `context.test.ts` holding it member-for-member against `createTranslator({})`. The cost of the shape: a test that reaches components by module path and exercises the inert server path must `import './ambient'` itself, as `inert-render.test.ts` does — the barrel is what registers. `errors.ts` is pure now too: the `registerErrorCodes()` call is `src/error-registry.ts`, imported bare from `errors.ts`, so a bundler honouring `sideEffects` (Bun 1.4.2; 1.4.0 ignored the array, oven-sh/bun#40650) drops the registry from a chunk that reaches `errors.ts` only through the barrel — the setter island was 10,928 B on 1.4.2 before, 72 B over the floor after. `scripts/ui-barrel-bytes.test.ts` pins the island's retained-module list: no `i18n`, `time` or `money` path, no `ambient.ts`, and nothing of this package outside a named list.

- **`useUi()` reads the request on the server**, via `ambientUiContext()` — `currentLocale()`, `currentTimeZone()`, `useI18n()`. Those two read **core's own `Ctx.locale` / `Ctx.tz`**, which `@ultimat3/http`'s `locale` stage writes once per request; `@ultimat3/i18n` and `@ultimat3/time` publish no field of their own. Never add a second ambient store here or there — `time` kept a `ctx['timeZone']` nothing wrote until 2026-08, and the whole cost was invisible: every server-rendered date formatted in UTC under a doc comment saying it did not. `theme`/`currency` deliberately have no ambient source at all.

- **Every locale-sensitive call takes the locale as an ARGUMENT, `toLocaleUpperCase` included.**
  `initialsOf(name, locale)` reads `useUi().locale`, exactly as `DateTime` does. A bare
  `toLocaleUpperCase()` reads the RUNTIME's default — a server's `LANG`, a browser's UI language —
  which is the ambient locale this package does not have; Turkish is where the absence shows,
  because dotted `i` uppercases to `İ`, so a Turkish member's avatar read `I` on a server in
  Ireland. **Breaking**: `initialsOf`'s second parameter is required.

- **`inert-render.test.ts` must not assume which factory its `.tsx` compiled to.** `@ultimat3/render`'s `index.ts` installs a process-global `Bun.plugin` `onLoad` for `/\.tsx$/` at import, and `bun test` is one process — so any file in the run that imports render first makes every ui component after it compile to render's `h` instead of the file's own inert copy. The walker recognises both (`Symbol.for('ultimate.render.jsx')`, off the global registry, never an import), and the first test in the describe asserts a component returned a node it recognises. Without both halves the file silently rendered `"[object Object]"` and 26 assertions were decided by shard packing.

- **Generated source is a CODE sink.** `build-icons.ts` writes modules every app EXECUTES at import, from data fetched over the network, so an attribute value goes through `JSON.stringify` and never `'${value}'` — and `SAFE_ATTR_VALUE` refuses anything that is not glyph geometry one layer earlier. `iconElements` guards tags and attribute NAMES; it has never guarded a value. Malformed upstream data is `X_UI_INVALID_VALUE`; only the generator's real environment faults (no network, no biome binary) are `X_UI_RUNTIME_MISSING`.

- **The icon NAME is the third sink, and it has no escape.** The upstream map key becomes a filesystem path under `GLYPHS_DIR`, an exported identifier and a `//` banner, and `buildIcons` clears `GLYPHS_DIR` before it writes — so `../../index` was a delete of the glyph tree followed by an overwrite of a hand-written module, and a key carrying `;` produced a module that typechecked and ran. `SAFE_ICON_NAME` (`/^[a-z0-9]+(-[a-z0-9]+)*$/`) is checked in `parseIconNodes` BEFORE `out.set`, the same allowlist-over-a-sink shape as `SAFE_ATTR_VALUE` one layer down; all 1767 committed names pass it and `build-icons.test.ts` asserts that.

## Moved 2026-10-01 (plan 101, slice 07)

Eight rules shortened in `packages/ui/CLAUDE.md` to the rule itself; the reasoning each carried, verbatim as it stood:

- **The rule being pure is not enough — the WIRING has to be tested too.** `createRovingTabindex` was correct and `Menu` handed it `[role="menuitem"]`, so a disabled item made every item after it unreachable and every assertion in the package still passed. `src/jsx-probe.ts` reads the props an element actually carries (a `tabindex`, an `aria-live`, an `onKeyDown`, a `ref`) and `src/fake-dom.ts` gives it a DOM where a disabled control REFUSES focus, exactly as the real one does. Both are test-only and neither is in `index.ts`. `jsx-probe`'s `probe`/`unprobe` are the one exception, reachable at the subpath `@ultimat3/ui/jsx-probe` and still absent from the barrel: `globalThis.React` is ONE property, so its install/restore counter has to be ONE counter — `@ultimat3/admin` (tier 5) kept a second pair, and interleaved installs restored the two harnesses in the wrong order, leaving the global holding a harness the run had already torn down. **Gone in 28.0.0 (issue #883)**: Bun 1.4.3 stopped compiling a `.tsx` to `React.createElement`, so the test preloads install `@ultimat3/render`'s loader and nothing reads `globalThis.React`; `probe`/`unprobe` and the subpath were deleted. `components/interaction.test.ts` is where a keyboard or form-participation claim gets proven; asserting the pure helper alone is how these shipped.

- **One async region, four branches, and `empty` is unreachable while `pending`.** `asyncBranch`
  (`src/components/async-branch.ts`) is the ONLY place the `(pending, failed, empty, data)` decision
  is made — `AsyncRegion` renders it and `DataTable` calls it, so a table and a card list cannot
  disagree about what "loading with stale rows" looks like. The property is structural: an
  `AsyncState` (declared in `@ultimat3/core` since 21.0.0 — imported here, never re-exported, so
  it has one import path) in `pending` carries no data, so nothing can be found empty in it, and "No results"
  for one frame before the first page arrives is unconstructible rather than discouraged.
  `<AsyncRegion>`'s `empty` and `ready` are REQUIRED props, so forgetting the empty state is a type
  error. `refreshing` CARRIES the previous data — a refetch dims what is on screen (`aria-busy`) and
  never tears it down, which is what makes a search box feel fast; the empty branch is reachable
  only from a completed result that returned zero. `reserve` feeds the placeholder AND the
  `min-block-size` of every branch, so the skeleton and the loaded content cannot be written into
  different boxes.

- **A toast dwell stops for THREE independent reasons, and one of them is `document.hidden`.**
  Hover and focus-within are the two everybody implements; a backgrounded tab spends the whole dwell
  and the corner is empty when the user comes back. `ToastHold` is a set, never a boolean: a pointer
  leaving a toast a keyboard user is still inside must not restart the countdown, which one flag
  cannot express. Duration is a TOKEN (`TOAST_DWELL_MS`), never a per-call number of milliseconds.
  The queue's rules are pure (`src/toast/toast-state.ts`) and the clock is injected (`ToastEnv`), so
  a server render gets `INERT_TOAST_ENV` — nothing scheduled — and `ToastRegion` still emits its
  empty live region, which is what the document has to carry BEFORE the first message.

- **`announce()` writes into a region `AppShell` already rendered.** A live region created and
  filled in the same frame is not announced by most screen readers, so `announce()`'s own
  create-if-absent branch could only ever be right from its second call. `liveRegionAttrs` is the
  one derivation both halves read. It is for a state change with no surface of its own ("12
  results", "sorted by name"); a notification is a `Toast`, and two announcement paths for one
  message is how a screen reader reads it twice.

- **`loading` never sets the native `disabled` attribute** (`Button`), and that WILL read as a
  mistake. A control that disables itself mid-flow drops focus to `<body>`, is exempt from the
  contrast minimum, announces no reason, and still does not prevent the double submit — that race is
  on the server. `aria-disabled` + a refused click keeps it focusable and readable; `Button.module.scss`
  restores full opacity under `[aria-busy='true']` because `t.disabled` dims to 0.55. `<Form busy>`
  refuses the submit again, because Enter in a text field touches no button at all.

- **A failed submit focuses the first invalid CONTROL, and the summary only when there is none.**
  GOV.UK's summary-with-links shape is not available here: `Field` mints its control ids internally,
  and inverting that ownership is the drift `Field` exists to prevent. `firstInvalidField` answers in
  DECLARATION order, never issue order — a server may report the last field first. `fieldSelector`
  is the allowlist between a caller's string and a selector; a name the grammar refuses reaches no
  `querySelector`.

- **`defineTheme()` refuses a palette that fails WCAG 2.2 AA** (`X_UI_CONTRAST_INSUFFICIENT`),
  measured against `CONTRAST_PAIRS` — the same table `contrast.test.ts` holds the shipped palette to,
  in SOURCE rather than in a test, so an app cannot ship a brand the design system would have failed
  its own suite over. Only pairings the brand can have CHANGED are measured, on the resolved palette
  (shipped channels + overrides): a new `accent` against the shipped `accent-fg` is the commonest way
  a brand goes unreadable. AA, never APCA — APCA is not a standard, and AA is the operative legal
  benchmark.

- **`useUi()`'s server branch is a SLOT, and the module that fills it is browser-mapped** (issue #490). `context.ts` imports no value from `@ultimat3/i18n` or `@ultimat3/time` (the i18n barrel installs the framework catalog at import: 16.1 kB per island). `src/theme/ambient.ts` registers `ambientUiContext` into `ambient-slot.ts` at import; `index.ts` imports it BARE above every re-export, and `package.json`'s `browser` field maps it to `ambient.browser.ts` (bundlers only — `bun test` and SSR get the server's). A test reaching components by module path must `import './ambient'` itself, as `inert-render.test.ts` does. `fallbackTranslator` is held member-for-member against `createTranslator({})` by `context.test.ts`. `errors.ts` is pure: `registerErrorCodes()` is `src/error-registry.ts`, imported bare. `scripts/ui-barrel-bytes.test.ts` pins the theme island's retained-module list.

## Moved out for plan 101's wave 5a (`As of 2026-11-05`)

- **The barrel is the ONE import path.** Its sibling #276 — a pure re-export entry shaken to its export clause — was fixed in Bun 1.4.1 (oven-sh/bun#40578), and barrels have been built as their own entry since.

- **The framework ships the mapping and no copy table.** A `messageFor` that answers `''` or throws falls back to the diagnostic text — the loud-but-safe answer `t()` already gives with `⟦key⟧`, because the alternatives are a control marked `aria-invalid` with nothing to read, or a submit abandoned mid-flight holding the user's input.

- `src/components/data-table-rows.ts`: DataTable's keyed rows, one `createRoot` per `rowKey`, so a live update keeps an unchanged row's node. DataTable calls it from its body, and the table chrome is a memo over the branch KIND (failed / empty / table), so a live update never detaches a kept row.
- `createRoot` joined `SolidRuntime` for keyed rows (v30), making the runtime seven functions.

## Commands and navigation

As of 2026-11 (plan 101, 38-ui-commands, 38-ui-navigation).

- **One current link per list, by `currentOf`** (`nav-list-view.ts`): the longest href covering the page, first on a tie. `NavList` and `BottomNav` both ask it; `AppShell bottomNav` sits in the named grid area `bottom` — auto-placed, it filled the hidden sidebar's cell and pinned the bar to the TOP (`ui-mobile-frame.e2e.test.ts`).
- **The page has ONE hotkey listener and ONE merged table**, on `document` under `Symbol.for('ultimate.hotkeys')` (`use-hotkeys.ts`), because every island bundles its own copy of this package. `ShortcutSheet` lists that table and `useCommandPalette` registers `mod+k` into it, so `?` shows exactly the bindings that work. A duplicate binding across islands is `X_UI_INVALID_VALUE` at registration.
- **`ConfirmDialog` is not `Dialog`**: invoker command to open, `formmethod="dialog"` Cancel with `autofocus`, no backdrop handler at all, `Dialog.module.scss` for the look. `Dialog` opens from an effect and closes from a script button; a confirmation must work with scripting off.

## Moved out for plan 101's wave 10 (`As of 2026-11-06`)

Verbatim, for the 24 KB ceiling; the one-line rule stays in `packages/ui/CLAUDE.md`.

- **Server-rendered first, an island second.** Components run in islands (`examples/dummy`'s settings and feed islands render them), but every one must still be correct server-rendered and usable with scripting off — `<details>` for disclosure, `<input list>`+`<datalist>` for suggestions, a real `rel="next"` link for paging — with listeners and observers as additive extras. A component that renders nothing until JS runs does not ship. In an island the body runs ONCE: a branch decided there (an early `return <ErrorState>`) is decided for the island's life, so branches live inside the returned JSX (`AsyncRegion`, `DataTable`). A server-only spelling is gated on `typeof document` (`Textarea`'s parser newline). Ids minted in an island carry a per-copy scope (`a11y.ts`), because each island bundles its own counter.
- **`UiProvider` is client-only and throws on the server** (`providerNeedsRuntimeError`, the same `X_UI_RUNTIME_MISSING`). A Provider in an inert tree reaches no descendant — the tree is built before the renderer walks it, so consumers are walked outside every owner and read the context default even with a real Solid runtime registered. Rendering the children anyway would drop its locale, zone, currency and translator silently. Making it work needs the *renderer* to scope a context around the walk; until then it refuses.
- **`solid()` always answers off-DOM.** No registered runtime and no DOM is a *server render*, and it gets `INERT_SOLID_RUNTIME` (`src/theme/inert-runtime.ts`) — signals hold, memos recompute on read, effects never run, `useContext` returns the default. No DOM means no reactivity to lose; a **DOM** with no runtime is still `X_UI_RUNTIME_MISSING`, because that one is the theme toggle that does nothing. Never widen this to "no runtime, never throw": that is the silent degradation the split exists to prevent.
- **A form binds to an action; it never decides for one.** `useForm` (`src/form/`) is a binding over an existing `action`, not a ninth primitive and not a component — `submit` is REQUIRED and is the only producer of a `succeeded` state, and the client-side parse's **value** is discarded so that only its issues are read. A binding that submitted the locally-parsed value would let a browser choose what the server was asked to store.
- **The framework ships the mapping and no copy table.** `FormIssue.message` is a schema's diagnostic text and is never user-facing; `messageFor` is required and is the app's; it keys on `FormIssue.rule` and `params` (`issueRuleFacts`, the same from a local parse and a server rejection). There is deliberately no `ui.form.*` key: a built-in wording would be one app's convention shipped to every other. A `messageFor` that answers `''` or throws falls back to the diagnostic text.
- **`inert-render.test.ts` must not assume which factory its `.tsx` compiled to.** `@ultimat3/render` installs a process-global `.tsx` `onLoad` plugin at import, so in one `bun test` process a component may compile to render's `h`. The walker recognises both (`Symbol.for('ultimate.render.jsx')`), and the first test asserts a recognised node — otherwise the file renders `"[object Object]"` and passes by shard packing.

## The rejection line parser

`As of 2026-08-24`, the wire carries no structured issue list. `InputInvalidError` renders the
issues into `cause` and puts nothing in `meta`, and `toProblem` has no `issues` member, so
`issuesFromRejection` reads `meta.issues` where there is one and parses the cause line where there
is not. It binds a fragment to a field only when the fragment's head is a DECLARED path, so a
mis-split degrades to a form-level error rather than to a wrong control. Delete the line parser the
day the wire carries the list. (Moved out of `packages/ui/CLAUDE.md` by plan 101 slice 38, for the
24 KB ceiling.)
