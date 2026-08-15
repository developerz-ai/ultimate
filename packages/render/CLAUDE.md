# @ultimat3/render — boundary

Owns: the `route` primitive, the five render modes, the route table, the surface boundary,
islands + budgets, hydration directives, the vendored client router, `<head>` merge, **the server
JSX runtime and the two Bun loaders that make an app's `.tsx` and `.scss` runnable**.

`island()` is a **factory over the route's own `hydrate`**, not a ninth primitive and not a
second render mode — the same rule `llm()` and `backfill()` follow. It adds no key to
`defineRoute`.

Tier 4. May import tiers 0–3: `core`, `schema`, `i18n`, `money`, `time`, `cache`, `seo`,
`entity`, `policy`, `http`, `action`, `query`. **Never** `pwa`, `mcp`, `ai`, `manifest`
(sideways), never `ui`/`cli` (upward).

| Rule | Detail |
|---|---|
| `offline`, `meta` | required by `RouteDefinition`. Never make them optional. |
| `hydrate` | **optional since 1.2.0, derived from `island()`** — `'interaction'` when the module declared one, `'never'` when it did not. Declaring it still wins and is the only way to reach `idle` / `visible`. Not a widening of the contract: it is the one key the declaration above it already answers, and requiring it meant two failures (`X_ISLAND_NOT_HYDRATED`, and a `site/` route refused for a missing `budget.js`) for one omission. Never give the island its own strategy instead — `RouteDescriptor.hydrate` is read by `sw.js`, the web manifest and `x routes`, and two islands wanting different timings would leave it with no true answer. |
| `defineRoute` shape | exactly the contract's 9 keys. New route *metadata* still goes inside `meta` — `load` is not metadata, it is the data `meta` already took a parameter for. |
| `load` | optional, and the ONE server-side data seam. Resolved once per render by `routeDataFor()` and handed to **both** `meta` and the page component. Two resolutions is a `<title>` describing content the body does not contain. Absent `load`, the context IS the data (`{ params, url }`), which is what `meta` received before the key existed — so no consumer branches on whether a route declared one. |
| `load` is required when the context cannot supply the data | `LoadRequirement<TData>` in `defineRoute`'s parameter — `unknown` when `RouteContext` satisfies `TData`, a required `load` when it does not. That is what makes the no-`load` fallback true rather than asserted: it was `ctx as unknown as TData`, so a `meta` reading `data.post` off a route that loads nothing type-checked and rendered `undefined` in a `<title>`. `RouteContext` is a type ALIAS for the same reason — only an alias carries the implicit index signature that makes it a `RouteData`; as an `interface` the compiler cannot see it and the cast comes back. |
| A loader's own error | rethrown only when `isUltimateError` says so — core's brand, never a `code` property. Every `ENOENT` is an `Error` with a string `code`, and the duck-type that preceded this let all of them out of `routeDataFor` unwrapped: no `X_ROUTE_LOAD_FAILED`, no fix line, no route named. A tier-0 error (`@ultimat3/schema` cannot import core) is branded, not a subclass — never narrow this to `instanceof UltimateError`. |
| Type claims | `type-pins.tsx`, never a `.test.ts` — `tsconfig.json` excludes tests, so `tsc` never reads one. `.tsx` since 1.2.0: the island-as-JSX claim is only decidable by writing the JSX an author writes, checked against the same `solid-js` `JSX.Element` a page is. |
| Descriptor `meta` / `load` | always `(x) => Promise<…>`. Authors may declare either sync; consumers never branch. |
| Descriptor `budget` | always an object, `{}` when undeclared. Its *fields* stay optional — `budget.js === undefined` is the site/ hydration failure. |
| No `describe()` on a route | `describeRoutes()` is the one route list. A per-route projection would be a second one. |
| Mode invariants | `modes.ts` only. Never inline a mode check in a render-\* file. |
| Island declaration | `island({ src })` — a **specifier**, never an import. That is the whole boundary: a string has no scope to close over and no edge for a bundler or `checkSurfaceBoundary` to follow, so a `static` page's graph cannot grow the island's dependencies. Never add an overload that takes a component. |
| Island filename | `*.island.tsx`, `ISLAND_EXTENSION` — one spelling, same rule as `page.tsx`: a module ships to the browser iff its name says so. Never widen it to accept a second, and never make it optional. |
| Island timing | the route's `hydrate` and nothing else — derived from the declaration, never declared on the island. An island declaring its own strategy would be a second way to say "this route hydrates" (axiom 1) and a second thing `budget.js` would have to chase. `hydrate: 'never'` + an island is still `X_ISLAND_NOT_HYDRATED`, and so is an `island()` call *below* the `defineRoute` that drains it. The `fix:` names exactly ONE of the two edits — `islandNeverDrained(spec)` tells the causes apart at the throw site, and a message offering both makes half the instruction wrong for every reader. |
| Island node shape | a **branded array** (`IslandNode extends Array<never>`), and every walker tests `isIslandNode` BEFORE `Array.isArray`. An app types JSX with `jsxImportSource: solid-js`, whose `JSX.Element` is a type ALIAS — unaugmentable — and whose only object-shaped member is `ArrayElement`; a plain object was TS2786 at every `<Island />`, so the feature only worked through `h(Island, …)`, which is what render's own tests used. The array stays empty; the shell is `props.children`. Never satisfy this by importing solid's union. |
| Island declaration order | `island()` above `defineRoute`, drained by it (`drainDeclaredIslands`). Package-internal — reachable from `./island`, never re-exported by `src/index.ts`: an app calling the drain between its `island()` and its `defineRoute` would silently un-declare the islands the route derives everything from, and a public export is semver-locked the moment it ships. Ambient, and NOT the thing the collector refuses to be: that one is per RENDER, where two requests would bill each other; this one is per MODULE, evaluated once, before any request — and `src` is resolved relative to the route file, so an `island()` call is route-module-local by construction. |
| Derived budget | `registry.ts`, not `defineRoute`: a ceiling is only meaningful against a surface baseline, and the surface is a fact of the file path the route table already reads. `site/` → `4kb`, `app/` → `18kb` (`DEFAULT_ISLAND_JS_BYTES` above `jsBaselineBytes`). A declared `budget.js` wins; a `'never'` route gets none, so the contradiction stays visible. |
| `RouteEntry.islands` | filled from `config.islands` at registration, and from nothing else — `RegisterRouteInput` has no `islands` key. It was `input.islands ?? []`, undocumented and passed by nothing, so `routeJsBytes`'s "what registration declared" half read `[]` on every route in the framework's history; keeping it as a fallback would be a second answer to one question that can only ever weaken it, since a caller passing `[]` un-weighs a declared island. |
| Island props | declared, JSON-safe, under `ISLAND_PROPS_MAX_BYTES` — `island-props.ts` is the one gate. A structural walk, never a `JSON.stringify` round trip: stringify drops a function and an `undefined` silently, which is the footgun rather than the check. |
| Island collection | per render, passed as `renderToHtml(tree, { islands })`. Never module-global and never on an ambient context — two concurrent requests would bill one page for the other's JS, and `assertNoPerRequestState` refuses a live context under `static` anyway. |
| Island bytes | `routeJsBytes` unions `entry.islands` with the rendered directives' `moduleId`s. Reading either alone is a budget that counts the runtime and not the chunk. |
| Island markup | the props `<script>` is emitted INSIDE the wrapper by `render-html.ts`, so a document assembler has exactly one thing left to remember: `hydrateRuntime(directives)`. |
| Route truth | `registry.ts`. Never keep a second route list anywhere. |
| Route filename | `page.tsx` under `site/`/`app/`, `route.ts` under `api/` — `ROUTE_FILENAME`, one per surface. The URL is the directory path. Anything else is `X_ROUTE_FILE_INVALID`; never widen the table to accept a second spelling. |
| Registry input | descriptors only. `registerRoute` refuses a raw declaration with `X_ROUTE_UNNORMALIZED` — `defineRoute` is the one normalizer of everything the declaration alone decides, and every reader downstream assumes it ran. The registry fills in exactly one value on top: the island budget, which needs the surface, which is a fact of the file path only the route table reads. |
| Descriptors | `describeRoutes()` must stay JSON-safe, sorted by path, deterministic. |
| Boundary | `surfaces.ts` throws; it never warns. Type-only edges are not violations. |
| Stream cancellation | the underlying source has a `cancel()`, and `write` is guarded on it. A client that disconnects mid-stream aborts `StreamHole.resolve(signal)` and every later `write`/`close` is a no-op — `settle()` on a cancelled controller threw out of a `void`ed promise, one unhandled rejection per response, while the resolved holes kept doing their database work with nowhere to write. |
| ISR detach | `attach()`'s returned function clears the revalidator as well as the dependents — and only if the slot is still its own, tracked in `installedRevalidator` because `@ultimat3/cache` holds ONE and offers no read back. Left installed, a detached controller and its whole store stayed reachable and kept receiving revalidations while the live one's pages never went stale. |
| ISR store bound | `memoryIsrStore()` caps at `DEFAULT_ISR_MAX_ENTRIES` (1,000), least recently generated first — a route table supports `:params` and `*`, so `/blog/:slug` retains one full HTML string per slug ever requested, 404-shaped ones included. |
| Errors | `errors.ts` subclasses only. Never a bare `Error`, never a bare `TODO`. |
| Policy | render checks *presence* only. Evaluation belongs to `@ultimat3/policy`. |
| Responses | return `RenderResult`. `@ultimat3/http` builds the `Response`. |
| Solid | no `solid-js` import anywhere in this package — `type-pins.tsx` satisfies its `JSX.Element` structurally, through `jsxImportSource`, and never names it. Inject primitives. The JSX factory in `jsx.ts` builds inert nodes — it is not a Solid renderer and must never become one. |
| The loaders | `module-loader.ts` installs them at `index.ts` module scope, once. A plugin only affects modules loaded after it, so a second install point is a page that renders in one entry point and not another. |
| `<head>` baseline | `documentBaseline()` in `head.ts` — charset, viewport, `color-scheme` — merged FIRST so a route can still override any of them. Absent until `As of 2026-08`, and the missing `viewport` is why every deployed app rendered zoomed-out on a phone whatever its CSS said. |
| Escaping | `html.ts` only. A second escaper is how one of them ends up missing a character, and a missing character in an attribute is an injection. |
| Which export is the page | `route-component.ts`, one precedence: `Page` → a single `…Page` → a single capitalised function. Never a per-generator name table. |
| Stylesheets | compiled by `css-modules.ts` and served **inlined** per surface. `sass` is this package's only third-party dependency and its only reason to exist here. |
| CSS order | `stylesFor` sorts **globals before modules** (`isGlobalStylesheet`), never plain insertion order — the reset styles bare elements at the lowest specificity there is, so whichever page loaded first must not decide who wins a tie. `shared/` is carried by both graphs, like a package sheet: it is where an app's own global layer lives, and filtering it out is what made every deployed app render token-less. |
| The global layer | this package may not import `@ultimat3/ui` (tier 5, upward), so the app's source graph carries it: one `shared/global.scss` that `@use`s `@ultimat3/ui/global.scss`, side-effect-imported by `shared/global.ts`. One file, because each stylesheet is its own Sass compilation — a token file `@use`d per module duplicates its `:root` block per module. `x verify` fails with `X_STYLES_GLOBAL_MISSING` when a surface's document defines none. |
| Colours | tokens and `data-theme` only. No hex in `head.ts` or any emitted script. |
| `<head>` binding | `head.ts` stays injection-only (testable with no catalog); `head-seo.ts` is the ONE binding of `HeadRenderers` to `@ultimat3/seo`. A caller writing its own converter is the drift this file prevents. |

Cross-package: `@ultimat3/pwa` consumes route descriptors as **data**, never by import.
Keep `RouteDescriptor` additive — removing a field breaks `sw.js` generation.

```
bun test                          # from packages/render
bun run typecheck
bun run --cwd ../.. verify        # the contract
```
