# @ultimat3/render — boundary

Owns: the `route` primitive, the four render modes, the route table, the surface boundary,
islands + budgets, hydration directives, `<head>` merge, **the server JSX runtime and the two Bun
loaders that make an app's `.tsx` and `.scss` runnable**.

**Two entry points, disjoint.** `"."` (`index.ts`) is the CLIENT half and bundles for the browser;
`"./server"` (`server.ts`) is the build-time half — `css-modules`, `module-loader`, `render-html`,
`render-isr`, `render-ssr`, `render-static`, `render-stream` — and does not (`css-modules.ts` needs
`node:url`, which a browser build cannot link; no `sideEffects` value repairs that). Never re-export
a name from both barrels: `index.test.ts` asserts the empty name intersection and that `index.ts`'s
runtime import graph reaches none of those seven modules; `scripts/browser-barrel.test.ts` holds
the end property.

`island()` is a **factory over the route's own `hydrate`**, not a ninth primitive and not a second
render mode. It adds no key to `defineRoute`.

Tier 4. May import tiers 0–3: `core`, `schema`, `i18n`, `money`, `time`, `cache`, `seo`,
`entity`, `policy`, `http`, `action`, `query`. **Never** `pwa`, `mcp`, `ai`, `manifest`, `ui` — all
tier 4, so sideways. This package sits above its floor of 2 so `render → pwa` stays refused, and
`ui` is held level with it so `render → ui` stays refused (`FLOOR_ABOVE` in `scripts/lib/tiers.ts`;
axiom 6). Never `cli` (upward).

| Rule | Detail |
|---|---|
| `offline`, `meta` | required by `RouteDefinition`. Never make them optional. |
| `hydrate` | optional, **derived from `island()`** — `'interaction'` when the module declared one, `'never'` when not. Declaring it still wins and is the only way to reach `idle` / `visible`. Never give an island its own strategy: `RouteDescriptor.hydrate` is read by `sw.js`, the web manifest and `x routes`. |
| `defineRoute` shape | exactly the contract's 10 keys (`cache`, `ssr` only, is the tenth). New route *metadata* goes inside `meta`. |
| `load` | optional, and the ONE server-side data seam. Resolved once per render by `routeDataFor()` and handed to **both** `meta` and the page component. Absent `load`, the context IS the data (`{ params, url }`). |
| `load` is required when the context cannot supply the data | `LoadRequirement<TData>` in `defineRoute`'s parameter. `RouteContext` is a type ALIAS on purpose — only an alias carries the implicit index signature that makes it a `RouteData`. |
| A loader's own error | rethrown only when `isUltimateError` says so (core's brand), never a `code` property and never `instanceof UltimateError` — a tier-0 error is branded, not a subclass. Everything else is `X_ROUTE_LOAD_FAILED`. |
| A loader's own STATUS | `withStatus(status, data)` (`route-status.ts`) — the ONE way a page answers 404/410/503 while rendering its own component in the app's shell. The status rides on the data by IDENTITY in a `WeakMap`; `routeStatusOf(data)` is the total reader (200 by default). A 3xx is `X_ROUTE_STATUS_INVALID`. A 4xx/5xx is `robots.index = false` by construction in `defineRoute`'s `meta` wrapper. The `Response` status is minted by `@ultimat3/cli`'s `dev-render.ts`. |
| Type claims | `type-pins.tsx`, never a `.test.ts` — `tsconfig.json` excludes tests. `.tsx` so the island-as-JSX claim is checked against the JSX an author writes. |
| Descriptor `meta` / `load` | always `(x) => Promise<…>`. Authors may declare either sync; consumers never branch. |
| Descriptor `budget` | always an object, `{}` when undeclared. `budget.js === undefined` is the site/ hydration failure. |
| `RouteBudget` keys | **`js` and `lcp` only, and every key is PROJECTED** (`budgetJs`, `budgetLcp`). `type-pins.tsx` derives the allowed set from `RouteDescriptor`'s `budget*` keys, so an unprojected key is a build error; `scripts/declaration-readers.ts` finds the class across every declaration. |
| No `describe()` on a route | `describeRoutes()` is the one route list. |
| Mode invariants | `modes.ts` only; never inline a mode check in a render-\* file. **Four modes, and every one renders the route's component.** A fifth mode has to name the function that renders it. |
| Island declaration | `island({ src })` — a **specifier**, never an import, so a `static` page's graph cannot grow the island's dependencies. Never add an overload that takes a component. |
| Island filename | `*.island.tsx`, `ISLAND_EXTENSION` — one spelling. Never widen it. |
| Island timing | the route's `hydrate` and nothing else. `hydrate: 'never'` + an island, or an `island()` call below the `defineRoute` that drains it, is `X_ISLAND_NOT_HYDRATED`; `islandNeverDrained(spec)` tells the two causes apart so the `fix:` names exactly one edit. |
| Island node shape | a **branded array** (`IslandNode extends Array<never>`); every walker tests `isIslandNode` BEFORE `Array.isArray`. Solid's `JSX.Element` is an unaugmentable alias whose only object member is `ArrayElement`. Never import solid's union. |
| Island declaration order | `island()` above `defineRoute`, drained by it (`drainDeclaredIslands`), reachable from `./island` and never from `src/index.ts`. Per MODULE (evaluated once), unlike the per-render collector. |
| Derived budget | `registry.ts`, from the surface: `site/` → `20kb`, `app/` → `34kb` (`DEFAULT_ISLAND_JS_BYTES` above `jsBaselineBytes`), calibrated on a Solid island. A declared `budget.js` wins; a `'never'` route gets none. |
| `RouteEntry.islands` | filled from `config.islands` at registration and nothing else — `RegisterRouteInput` has no `islands` key. |
| Island props | declared, JSON-safe, under `ISLAND_PROPS_MAX_BYTES` (16 KiB; the doc comment carries the arithmetic) — `island-props.ts` is the one gate, a structural walk, never a `JSON.stringify` round trip. Over the cap the cause names the heaviest props and the fix names the endpoint pattern, never "raise the cap". `X_ISLAND_PROPS_INVALID` has a row in `@ultimat3/http`'s table (500). |
| A prop lands via `Object.defineProperty` | never `out[key] = v` — `__proto__` (a real own key off `JSON.parse`) would run the prototype setter. |
| An attribute alias is a `Map` | never a record (`toString` resolved to a function). `MODE_SPECS[config.render]` is guarded by `Object.hasOwn` for the same reason. |
| An attribute NAME is validated too | `ATTRIBUTE_NAME` in `html.ts` (`/^[A-Za-z_:][-A-Za-z0-9_:.]*$/`), refused as `null`; the `on*` handler check folds case. `head.ts`'s `renderTag` shares the predicate (`isAttributeName`). One predicate, never two. |
| Which attributes take a URL | `URL_BEARING_ATTRIBUTES` in `html.ts` — core's four plus `data`, `poster`, `ping`, `xlink:href`. `srcdoc` is refused outright (entity-decoded, then parsed as HTML). |
| Island collection | per render, `renderToHtml(tree, { islands })`. Never module-global and never on an ambient context. |
| A byte count in a message | `formatBytes` from `@ultimat3/core`, never a local one. |
| Island bytes | **not this package's**: `@ultimat3/cli`'s `packages/cli/src/budgets.ts` measures the EMITTED document and is the gate. What stays here is the budget grammar (`parseByteBudget`) and `defaultIslandBudget`. |
| The hydration runtime's CSP | `HYDRATE_RUNTIME_BODIES` — every body `hydrateRuntime` can emit (seven subsets). It is inline in every document with an island and `@ultimat3/http`'s `script-src` is `'self' 'wasm-unsafe-eval'`, so `@ultimat3/cli`'s `script-csp.ts` hashes this list at boot. `runtimeBody` is the one place the served and hashed text are one string. **Uncovered**: `render-stream.ts`'s per-hole `<script>$X("id")</script>` (unreachable today; the first real hole needs a nonce). |
| Island markup | the props `<script>` is emitted INSIDE the wrapper by `render-html.ts`; an assembler only adds `hydrateRuntime(directives)`. |
| Island boot | `el.__x` holds the boot PROMISE, never a boolean. |
| Island mount markers | `data-x-mounted=""` when `mount()` resolved, `data-x-failed="<message>"` when it rejected — set by the runtime, never by `emitIslandAttributes`. The rejection handler RETHROWS. Prelude sizes `As of 2026-09-22`: `idle` 1,744, `visible` 846, `interaction` 1,629 B (what `DEFAULT_ISLAND_JS_BYTES` derives from). |
| A runtime that calls `boot` | TERMINATES the chain: `idle`/`visible` end in `.catch(hush)`, `interaction` passes `off` as the rejection arm. `hydrate-runtime.test.ts` reds on an unhandled rejection. |
| `idle` replays too | `idle` and `interaction` share ONE `catchUp(el)` in `hydrate.ts` (capture listeners for `data-x-events`, default `click`; a queue; `aim`; one flush). A caught event wakes an `idle` island early; each event replays once. `hydrate-replay.test.ts`. |
| Where `interaction` replays | `aim(el, ev)`, never `ev.target` — `mount` usually clears the root, detaching the pressed node. Kept → original target; replaced → `path(el, target)`'s structural walk (same tag, same place), then `document.elementFromPoint(ev.clientX, ev.clientY)` (unless `ev.detail === 0`), then the island root. A hit outside the island falls back to the root. `hydrate-replay.test.ts`. |
| `idle`'s deadline | `IDLE_HYDRATE_TIMEOUT_MS`, interpolated INTO the runtime string and exported for `x shot`'s settle. |
| Route truth | `registry.ts`. Never a second route list and never a second matcher — `@ultimat3/http`'s trie (`stages.ts`) serves requests. `routeFor` is an exact-path `Map` lookup. |
| Route filename | `page.tsx` under `site/`/`app/`, `route.ts` under `api/` — `ROUTE_FILENAME`. Anything else is `X_ROUTE_FILE_INVALID`. |
| Registry input | descriptors only. `registerRoute` refuses a raw declaration with `X_ROUTE_UNNORMALIZED`; it fills in only the island budget. |
| Descriptors | `describeRoutes()` stays JSON-safe, sorted by path, deterministic. |
| Every string order | `byCodeUnit` (`code-unit-order.ts`), never `localeCompare` (ICU default locale and collation version vary by machine). |
| Boundary | `surfaces.ts` throws; it never warns. Type-only edges are not violations. |
| Stream cancellation | the source has a `cancel()` and `write` is guarded on it; a disconnect aborts `StreamHole.resolve(signal)`. |
| ISR detach | `attach()`'s returned function clears the revalidator too — only if the slot is still its own (`installedRevalidator`). |
| "Is this a TTL?" has one reader | `parseTtlMs` in `duration.ts`, below `modes.ts` and `render-isr.ts`. |
| A build-time frame reads a throw with `renderThrowable` | `render-html.ts`, `render-static.ts`, `css-modules.ts`, `module-loader.ts`, `route-data.ts`. `bun run error-render` cannot see a value laundered through a local helper. |
| `X_ROUTE_LOAD_FAILED` computes its pathname BEFORE the try | `pathnameOf` never throws on a relative `ctx.url`. |
| The ISR key | `isrKey(url, locale)` — pathname, the negotiated locale in the reserved `__x_locale` parameter, then the sorted query. The locale is REQUIRED. The time zone is deliberately not a dimension. `toResult` emits `vary: accept-language`; the rest of the shared key is `@ultimat3/http`'s `cache-headers` stage. |
| A bust that lands MID-render | fenced with `@ultimat3/cache`'s `sampleFence({ key, tags })`, taken before `render()` and asked before `store.set`. `registerPath` runs BEFORE the render. |
| Marking a page stale | `IsrStore.markStale(path)`, in place — never `set({ ...entry, stale: true })` (`set` means "just generated" and orders eviction). |
| ISR store bound | `memoryIsrStore()` caps at `DEFAULT_ISR_MAX_ENTRIES` (1,000), least recently generated first. |
| A `RenderResult.status` | `finiteStatus(subject, status)` (`finite-status.ts`), 200–599 whole, at every site that takes one from a caller; `isRenderStatus` is the TOTAL read of a stored `IsrEntry.status`. The name carries `finite` so `bun run finite-bounds` recognises it. |
| `IsrEntry.ttlMs` off a store | normalised by `entryTtlMs`, TOTAL — anything not positive-finite is tag-only `null`, with an `isr.entry_ttl_invalid` warning. |
| Route path from file | `locateSurface()` answers which surface AND where it starts. Never re-derive the offset from the surface name. |
| An undecodable path segment | not a match, never a throw — `decodeSegment` in `registry.ts`. |
| ISR registration | reconciled against `store.paths()` after every generation (`forgetEvictedPaths`). |
| Stream hole deadline | `DEFAULT_HOLE_TIMEOUT_MS` (15 s), `holeTimeoutMs: null` to opt out, otherwise a whole number ≥ 1. A hole reveals exactly once — promise, rejection or deadline. |
| Errors | `errors.ts` subclasses only. Never a bare `Error`, never a bare `TODO`. |
| Policy | render checks *presence* only. Evaluation belongs to `@ultimat3/policy`. |
| A gated route is never a cached one | `modes.ts` refuses `policy` on both `static` and `isr` (`X_ROUTE_MODE_INVALID`, `modes.test.ts`). `ssr` is the one gated mode. |
| Responses | return `RenderResult`. `@ultimat3/http` builds the `Response`. |
| Who owns `cache-control` | a mode states intent; `@ultimat3/http`'s `cache-headers` stage decides and may overrule. This package cannot see the actor and never tries. |
| Solid | no `solid-js` import anywhere in this package; `type-pins.tsx` satisfies `JSX.Element` structurally. `jsx.ts` builds inert nodes. Islands are compiled by `@ultimat3/cli`'s `solid-loader.ts` with `babel-preset-solid`. |
| Root element | `ROOT_ELEMENT_ID` (`render-html.ts`). |
| The loaders | `module-loader.ts` installs them at **`server.ts`** module scope, once. `packages/cli/src/app-load.ts` imports `@ultimat3/render/server` for that side effect. |
| Client sync tags | `client-sync-tags.ts` — `ultimate-sync`, `ultimate-build`, `ultimate-sync-worker`. Principal-free, on every document. |
| Client scope tag | `client-scope-tag.ts` — `<meta name="ultimate-scope">`, read by core's `pageClient()`. `documentCarriesScope(headers)` is the one rule: only a `private` document carries it; absent means "not rendered for anyone". The literal is duplicated in core until core exports a constant. |
| `<head>` baseline | `documentBaseline()` in `head.ts` — charset, viewport, `color-scheme` — merged FIRST so a route can override any of them. |
| Escaping | `html.ts` only — including `render-stream.ts`'s `holeMarker` and `revealChunk` (`JSON.stringify`), and `head.ts`'s `themeScript`. `escapeAttribute` is `@ultimat3/seo`'s, re-exported by `html.ts`. |
| Script and style CONTENT | never raw: `escapeText`, `escapeRawTextContent` (`</` → `<\/`, `<!--` → `<\!--`), or `escapeJsonContent` for a `type` ending in `json`. Never HTML-escape a script body. |
| Which export is the page | `route-component.ts`: `Page` → a single `…Page` → a single capitalised function. |
| Stylesheets | compiled by `css-modules.ts`, grouped per surface, served by the CLI as one content-hashed file per surface (`@ultimat3/cli`'s `style-bundle.ts`) from `stylesFor`. `sass` is this package's only third-party dependency. Each compile goes through `sass-cache.ts`: `.x/cache/sass/` under cwd, a hit only while every file the compile read hashes the same; `setSassCacheDir(null)` turns it off. |
| CSS order | `stylesFor` sorts **globals before modules** (`isGlobalStylesheet`). `shared/` is carried by both graphs. |
| The global layer | the app's `shared/global.scss` `@use`s `@ultimat3/ui/global.scss`, side-effect-imported by `shared/global.ts` (this package may not import `ui`). `x verify` fails with `X_STYLES_GLOBAL_MISSING` when a surface's document defines none. |
| Colours | tokens and `data-theme` only. No hex in `head.ts` or any emitted script. |
| An island's `mount` | may return `() => void`, its disposer; the runtime never calls it, `@ultimat3/testing`'s `mountIsland` does. |
| `<head>` binding | `head.ts` stays injection-only; `head-seo.ts` is the ONE binding of `HeadRenderers` to `@ultimat3/seo`. |

Cross-package: `@ultimat3/pwa` consumes route descriptors as **data**, never by import.
Keep `RouteDescriptor` additive — removing a field breaks `sw.js` generation.

```
bun test                          # from packages/render
bun run typecheck
bun run --cwd ../.. verify        # the contract
```

Why each rule above is shaped the way it is: [`docs/history/render.md`](../../docs/history/render.md).
