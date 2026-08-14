# @ultimat3/render — boundary

Owns: the `route` primitive, the five render modes, the route table, the surface boundary,
islands + budgets, hydration directives, the vendored client router, `<head>` merge, **the server
JSX runtime and the two Bun loaders that make an app's `.tsx` and `.scss` runnable**.

Tier 4. May import tiers 0–3: `core`, `schema`, `i18n`, `money`, `time`, `cache`, `seo`,
`entity`, `policy`, `http`, `action`, `query`. **Never** `pwa`, `mcp`, `ai`, `manifest`
(sideways), never `ui`/`cli` (upward).

| Rule | Detail |
|---|---|
| `offline`, `hydrate`, `meta` | required by `RouteDefinition`. Never make them optional. |
| `defineRoute` shape | exactly the contract's 9 keys. New route *metadata* still goes inside `meta` — `load` is not metadata, it is the data `meta` already took a parameter for. |
| `load` | optional, and the ONE server-side data seam. Resolved once per render by `routeDataFor()` and handed to **both** `meta` and the page component. Two resolutions is a `<title>` describing content the body does not contain. Absent `load`, the context IS the data (`{ params, url }`), which is what `meta` received before the key existed — so no consumer branches on whether a route declared one. |
| `load` is required when the context cannot supply the data | `LoadRequirement<TData>` in `defineRoute`'s parameter — `unknown` when `RouteContext` satisfies `TData`, a required `load` when it does not. That is what makes the no-`load` fallback true rather than asserted: it was `ctx as unknown as TData`, so a `meta` reading `data.post` off a route that loads nothing type-checked and rendered `undefined` in a `<title>`. `RouteContext` is a type ALIAS for the same reason — only an alias carries the implicit index signature that makes it a `RouteData`; as an `interface` the compiler cannot see it and the cast comes back. |
| A loader's own error | rethrown only when `isUltimateError` says so — core's brand, never a `code` property. Every `ENOENT` is an `Error` with a string `code`, and the duck-type that preceded this let all of them out of `routeDataFor` unwrapped: no `X_ROUTE_LOAD_FAILED`, no fix line, no route named. A tier-0 error (`@ultimat3/schema` cannot import core) is branded, not a subclass — never narrow this to `instanceof UltimateError`. |
| Type claims | `type-pins.ts`, never a `.test.ts` — `tsconfig.json` excludes tests, so `tsc` never reads one. |
| Descriptor `meta` / `load` | always `(x) => Promise<…>`. Authors may declare either sync; consumers never branch. |
| Descriptor `budget` | always an object, `{}` when undeclared. Its *fields* stay optional — `budget.js === undefined` is the site/ hydration failure. |
| No `describe()` on a route | `describeRoutes()` is the one route list. A per-route projection would be a second one. |
| Mode invariants | `modes.ts` only. Never inline a mode check in a render-\* file. |
| Route truth | `registry.ts`. Never keep a second route list anywhere. |
| Route filename | `page.tsx` under `site/`/`app/`, `route.ts` under `api/` — `ROUTE_FILENAME`, one per surface. The URL is the directory path. Anything else is `X_ROUTE_FILE_INVALID`; never widen the table to accept a second spelling. |
| Registry input | descriptors only. `registerRoute` refuses a raw declaration with `X_ROUTE_UNNORMALIZED` — `defineRoute` is the one normalizer, and every reader downstream assumes it ran. |
| Descriptors | `describeRoutes()` must stay JSON-safe, sorted by path, deterministic. |
| Boundary | `surfaces.ts` throws; it never warns. Type-only edges are not violations. |
| Errors | `errors.ts` subclasses only. Never a bare `Error`, never a bare `TODO`. |
| Policy | render checks *presence* only. Evaluation belongs to `@ultimat3/policy`. |
| Responses | return `RenderResult`. `@ultimat3/http` builds the `Response`. |
| Solid | no `solid-js` import anywhere in this package. Inject primitives. The JSX factory in `jsx.ts` builds inert nodes — it is not a Solid renderer and must never become one. |
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
