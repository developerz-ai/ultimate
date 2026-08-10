# @ultimat3/render — boundary

Owns: the `route` primitive, the five render modes, the route table, the surface boundary,
islands + budgets, hydration directives, the vendored client router, `<head>` merge.

Tier 4. May import tiers 0–3: `core`, `schema`, `i18n`, `money`, `time`, `cache`, `seo`,
`entity`, `policy`, `http`, `action`, `query`. **Never** `pwa`, `mcp`, `ai`, `manifest`
(sideways), never `ui`/`cli` (upward).

| Rule | Detail |
|---|---|
| `offline`, `hydrate`, `meta` | required by `RouteDefinition`. Never make them optional. |
| `defineRoute` shape | exactly the contract's 8 keys. New route metadata goes inside `meta`. |
| Descriptor `meta` | always `(data) => Promise<RouteMeta>`. Authors may declare it sync; consumers never branch. |
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
| Solid | no `solid-js` import anywhere in this package. Inject primitives. |
| Colours | tokens and `data-theme` only. No hex in `head.ts` or any emitted script. |
| `<head>` binding | `head.ts` stays injection-only (testable with no catalog); `head-seo.ts` is the ONE binding of `HeadRenderers` to `@ultimat3/seo`. A caller writing its own converter is the drift this file prevents. |

Cross-package: `@ultimat3/pwa` consumes route descriptors as **data**, never by import.
Keep `RouteDescriptor` additive — removing a field breaks `sw.js` generation.

```
bun test                          # from packages/render
bun run typecheck
bun run --cwd ../.. verify        # the contract
```
