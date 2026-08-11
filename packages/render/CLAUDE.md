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
| Escaping | `html.ts` only. A second escaper is how one of them ends up missing a character, and a missing character in an attribute is an injection. |
| Which export is the page | `route-component.ts`, one precedence: `Page` → a single `…Page` → a single capitalised function. Never a per-generator name table. |
| Stylesheets | compiled by `css-modules.ts` and served **inlined** per surface. `sass` is this package's only third-party dependency and its only reason to exist here. |
| Colours | tokens and `data-theme` only. No hex in `head.ts` or any emitted script. |
| `<head>` binding | `head.ts` stays injection-only (testable with no catalog); `head-seo.ts` is the ONE binding of `HeadRenderers` to `@ultimat3/seo`. A caller writing its own converter is the drift this file prevents. |

Cross-package: `@ultimat3/pwa` consumes route descriptors as **data**, never by import.
Keep `RouteDescriptor` additive — removing a field breaks `sw.js` generation.

```
bun test                          # from packages/render
bun run typecheck
bun run --cwd ../.. verify        # the contract
```
