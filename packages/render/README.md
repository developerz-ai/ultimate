# 🖼 @ultimat3/render

The `route` primitive and the five render modes.

| Mode | Behavior | Use |
|---|---|---|
| `static` | built once, served as a file | marketing, docs |
| `isr` | static + background regen on tag/TTL | catalogs, profiles |
| `ssr` | per-request full render | fresh SEO pages |
| `stream` | static shell flushed instantly, holes streamed | **default for app pages** |
| `spa` | shell only, client fetches | dashboards behind auth |

```ts
export const config = defineRoute({
  render:     'isr',                  // static | isr | ssr | stream | spa
  revalidate: { tags: [tag.post] },
  prerender:  () => db.posts.slugs(),
  offline:    'precache',             // precache | runtime | network-only
  hydrate:    'visible',              // idle | visible | interaction | never
  budget:     { js: '40kb', lcp: 2000 },
  meta:       ({ post }) => ({ title: post.title, description: post.excerpt,
                               og: { image: post.cover }, ld: ld.Article(post) }),
});
```

## `offline`, `hydrate` and `meta` are required by the type

Not by a lint rule, not by a doc — by `RouteDefinition`. Axiom 3 lives in the type system:
a route that forgets its offline strategy or its `<head>` does not compile. `defineRoute`
re-checks the same three at runtime (`X_ROUTE_OFFLINE_MISSING`, `X_ROUTE_META_MISSING`) for
JS callers and generators.

## Mode invariants, checked at registration

| Mode | Invariant | Error if violated |
|---|---|---|
| `static` | no per-request state — no `policy`, no `revalidate` | `X_ROUTE_MODE_INVALID` |
| `isr` | needs a trigger: `revalidate.tags` or `revalidate.ttl` | `X_ROUTE_MODE_INVALID` |
| `ssr` | cannot be prerendered | `X_ROUTE_MODE_INVALID` |
| `stream` | at least one `<Suspense>` boundary | `X_ROUTE_MODE_INVALID` |
| `spa` | requires a `policy` (authed dashboards only) | `X_ROUTE_MODE_INVALID` |

Plus surface rules: `site/` allows `static | isr | ssr`, `app/` allows `stream | spa | ssr`,
`api/` renders nothing, and a `site/` route that opts into hydration without a `budget.js`
is a build error.

## The route table is the single source of route truth

`registry.ts` maps file paths to URLs and `describeRoutes()` projects the table into a
sorted, JSON-safe descriptor list. Every downstream generator reads that one table.

| File | URL |
|---|---|
| `site/page.tsx` | `/` |
| `site/pricing/page.tsx` | `/pricing` |
| `site/(marketing)/about/page.tsx` | `/about` |
| `site/blog/[slug]/page.tsx` | `/blog/:slug` |
| `site/docs/[...path]/page.tsx` | `/docs/*path` |
| `app/dashboard/page.tsx` | `/dashboard` |
| `api/posts/route.ts` | `/api/posts` |

Consumers: `x.manifest.json`, the `/_x` routes panel, `sitemap.xml`, `sw.js`
(`@ultimat3/pwa` takes descriptors as data — tier 4 packages never import each other).

## `site/` cannot import `app/` — build error, resolved transitively

```
X_SURFACE_BOUNDARY: site/ imported app/
  cause: site/pricing/page.tsx → shared/ui/button.tsx → app/charts/sparkline.tsx
  fix:   x fix boundary site/pricing/page.tsx   (or move sparkline out of shared/ui)
```

The failure this prevents, in order:

1. Someone puts `<Button>` in `shared/ui/` — correct, both surfaces need buttons.
2. A dashboard needs a button with an inline trend line, so `<Sparkline>` joins the same
   file and pulls in the charting library.
3. `site/pricing` imports `<Button>`.
4. The highest-intent page in the product now ships chart.js. Nothing broke, nothing
   warned, LCP regressed 900ms, discovered a quarter later by a Lighthouse audit nobody
   scheduled.

The import that costs you is three hops from the file anyone reviewed, so
`checkSurfaceBoundary()` walks the whole value-import graph. `import type` edges are erased
at build time and therefore never carry the boundary. `shared/` is a leaf; `app/ → api/` is
types-only.

## Public API

| Export | Owns |
|---|---|
| `defineRoute` | the `route` primitive |
| `MODE_SPECS`, `assertModeShape`, `assertModeInvariants` | the mode invariant table |
| `registerRoute`, `describeRoutes`, `matchRoute`, `routePathFromFile` | the route table |
| `checkSurfaceBoundary`, `assertSurfaceBoundary`, `surfaceOf` | the hard boundary |
| `renderStatic`, `enumeratePrerender` | build-time render, content hashing |
| `createIsrController`, `invalidateAndRevalidate` | SWR + single-flight + tag triggers |
| `renderSsr`, `streamResult`, `renderSpa` | the per-request modes |
| `emitIslandAttributes`, `hydrateRuntime` | the four hydration strategies |
| `graphFor`, `checkBudget`, `assertBudget` | two bundle graphs, per-route budgets |
| `createRouter` | the vendored client router |
| `mergeHead`, `renderHead`, `themeScript` | `<head>` merge + the one inlined script |

## Notes

- **ISR** serves stale instantly, regenerates single-flight (a burst renders once), and
  registers each rendered page in `@ultimat3/cache`'s invalidation graph as an
  `isr-route` dependent of its `revalidate.tags`. So
  `action({ cache: { invalidates: [tag.post] } })` reaches ISR in the same hop as memo,
  LRU, Redis and the CDN, and regenerates exactly the dependent pages — nobody lists
  pages by hand, so nobody forgets one. `controller.attach()` installs it as the
  framework's `Revalidator`.
- **`stream`** flushes the shell first, then reveals holes in completion order with a
  ~200-byte inline script. Solid's compiled templates and signals mean the shell costs zero
  hydration work, so streaming buys TTFB *and* TBT here, not just TTFB.
- **`hydrate: 'interaction'`** replays the event that woke the island; without replay the
  first click on a cold island is silently lost.
- **`hydrate: 'never'`** emits no attributes beyond the marker and no runtime — the `site/`
  0kb default is mechanical, not aspirational.
- **The client router is vendored** rather than depending on a moving SolidStart alpha. It
  imports no `solid-js`: reactive primitives and the DOM host are injected.
- `@ultimat3/http`'s `html()` / `stream()` turn a `RenderResult` into a `Response`; render
  never constructs one.
