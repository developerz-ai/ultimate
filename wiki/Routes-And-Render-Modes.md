# Routes and render modes

A `route` is a URL + render mode + metadata + offline strategy. Render mode is a per-route property. SEO is enforced by the build, not described in a guide.

v1.0.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

## The canonical shape

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

| Aspect | Rule |
|---|---|
| Projects to | router entry, prerender list, `sw.js` precache/runtime rule, sitemap + RSS row, `<head>` + JSON-LD, per-route budget check |
| Owns | render mode, hydration timing, metadata, offline strategy |
| Never | touch the DB directly, hold business logic, or omit `meta.description` in `site/` — that is a build error |

## The descriptor

`route` is the one primitive whose façade is a **normalized descriptor** rather than a set of projection methods, because a route declares no behaviour to project. It is read by the router, the prerenderer, `sw.js` generation, the sitemap and the budget check, and the descriptor's job is to hand all five **one shape** so none of them branches. There is no `.describe()` on a route either — `describeRoutes()` is the one route list.

| Member | Is | Rule |
|---|---|---|
| `kind: 'route'` | the brand | lets the registry reject a non-route export. `isRouteConfig(value)` is the guard |
| `meta(data)` | the `<head>` producer | **always returns a promise.** A synchronous declared `meta` is wrapped, and a `meta` that throws synchronously becomes a rejection — so `await config.meta(data)` is the one way to fail as well as the one way to succeed, and no consumer branches on a thenable |
| `budget` | the per-route limits | **always an object**, `{}` when undeclared, rather than a second undefined-check at every call site |
| `render` `revalidate` `prerender` `offline` `hydrate` `policy` | the declaration, carried through | unchanged. Optional keys are omitted, never set to `undefined` |
| the whole object | `Object.freeze`d | no consumer can mutate the route another consumer is about to read |

**The always-present `budget` does not weaken the `site/` JS-budget check.** `budget` is always an object, but its *fields* stay optional — so `budget.js === undefined` still means "this route declared no JS budget", and a `site/` route that opts into any `hydrate` other than `never` without one is `X_ROUTE_MODE_INVALID`, exactly as before the normalization. Measuring the declared numbers against the built output is the separate concern in **Budgets**, below.

Validation runs at **module evaluation**. `defineRoute` checks the shape and the mode-local invariants immediately, so a bad route fails at build time rather than on the first request in production.

| Checked | Where | Code |
|---|---|---|
| `offline` present and a known strategy | `defineRoute` | `X_ROUTE_OFFLINE_MISSING` |
| `meta` is a function | `defineRoute` | `X_ROUTE_META_MISSING` |
| mode-local: known `render` and `hydrate`; `static` with a `policy` or a `revalidate`; `isr` with no trigger; `ssr` with a `prerender`; `spa` with no `policy` | `defineRoute` | `X_ROUTE_MODE_INVALID` |
| surface-dependent: mode allowed on the surface; `site/` hydration without `budget.js`; `stream` with no `<Suspense>`; `prerender` on a non-prerenderable mode | `registerRoute` | `X_ROUTE_MODE_INVALID` |
| two files claiming one URL | `registerRoute` | `X_ROUTE_DUPLICATE` |

The split is about what is knowable, not about strictness: everything decidable from the config alone is decided at import; the rest needs the file's surface, which only the route table knows.

## Five render modes

| Mode | Behavior | Use |
|---|---|---|
| `static` | built once, served as a file | marketing, docs |
| `isr` | static + background regen on tag/TTL | catalogs, profiles |
| `ssr` | per-request full render | fresh SEO pages |
| `stream` | static shell flushed instantly, holes streamed | **default for app pages** |
| `spa` | shell only, client fetches | dashboards behind auth |

| Surface | Default | Allowed |
|---|---|---|
| `site/` | `static` | `static`, `isr`, `ssr` |
| `app/` | `stream` | `stream`, `spa`, `ssr` |
| `api/` | n/a | no rendering at all |

A mode outside a surface's allowed set is a build error, not a runtime fallback. Surfaces and their boundaries: [Project layout](Project-Layout).

## Why `stream` is the app default

An authed page needs fresh data and fast first paint. `ssr` gives freshness and a slow TTFB (the whole page waits for the slowest query). `spa` gives an instant shell, a spinner farm, and no HTML for anything. `stream` gives both halves: shell now, data as it resolves.

```tsx
export default function Dashboard() {
  return (
    <Layout>
      <Header />                                {/* in the first flush */}
      <Suspense fallback={<StatsSkeleton />}>
        <Stats />                               {/* streamed when the query resolves */}
      </Suspense>
      <Suspense fallback={<FeedSkeleton />}>
        <Feed />                                {/* independent hole, independent flush */}
      </Suspense>
    </Layout>
  );
}
```

Solid's fine-grained reactivity is what makes this cheap:

| Property | Consequence |
|---|---|
| No VDOM | streamed HTML is patched into place; nothing re-renders to reconcile |
| Signals, not component re-execution | a resolved hole updates the exact DOM nodes bound to it |
| **No hydration pass over the shell** | the static shell costs 0 hydration work — a `<Suspense>` boundary hydrates only its own island, only when its `hydrate` timing fires |
| Compile-time templates | the shell's JS is markup-shaped, not a component tree to replay |

In a VDOM framework a streaming shell still pays for hydrating the whole tree, which is why streaming there buys TTFB but not TBT. Here it buys both.

Independent holes each resolve their own [queries](Queries-And-Live-Queries); the tier-1 request memo means three holes reading the same query hit Postgres once.

## `hydrate` timings

| Value | Wakes when | Use |
|---|---|---|
| `idle` | after first paint, on `requestIdleCallback` | default in `app/` — above-the-fold interactivity |
| `visible` | the island intersects the viewport | below-the-fold lists, comment threads, charts |
| `interaction` | first pointer/focus/key event on the island | menus, modals, popovers, dropdowns |
| `never` | not at all — server HTML is final | static islands, rendered markdown, badges |

Hydration is per-island, never per-page. A blown `budget.js` is a build failure, so islands cannot quietly accumulate.

## Budgets

Per route. `budget.js` in bytes, `budget.lcp` in milliseconds.

| Check | Source of truth |
|---|---|
| Per-route JS bytes | `budget.js` on the route; measured from the real bundle graph |
| LCP / CLS / TBT | headless Lighthouse against the built output, median of N runs |
| Lighthouse SEO + a11y scores | minimum thresholds in `app.config.ts`, defaults 100 / 95 |
| Precache size | total `sw.js` precache set, see [PWA and offline](PWA-And-Offline) |
| Regression | budgets ratchet — the recorded baseline can tighten, never loosen silently |

A blown budget is a **build failure**, not a warning:

```
x verify
  ✓ typecheck            ✓ import boundaries      ✓ migration drift
  ✓ lint                 ✓ tests (6 types)        ✓ contract diff
  ✗ budgets
      site/pricing   js 61kb > 40kb   (chart.js via shared/ui/button.tsx)
      app/reports    lcp 2400 > 2000
```

Failures name the *cause* — the transitive import that added the bytes — because "bundle too big" without a chain is not an instruction. `x verify --json` emits the same content machine-readably.

## SEO enforcement

| Concern | Enforcement |
|---|---|
| `meta.title` missing on any route | build error `X_SEO_NO_TITLE` |
| `meta.description` missing on a **`site/`** route | build error `X_SEO_NO_DESCRIPTION` + `fix: add description to meta in <file>` |
| Description outside 50–160 chars | build error, with the measured length |
| Duplicate title/description across routes | build error — duplicate meta is a ranking bug, not a style issue |
| `og.image` missing on a shareable route | build error; the generated fallback OG image must be opted into explicitly |
| Broken internal link | build error, resolved against the route table |
| Missing `alt` on an `<Image>` | build error |
| Canonical URL | emitted for every route from the route table; never hand-written |
| `robots` / `noindex` | a route-level field, so "we shipped staging to Google" is impossible without editing the route |

A convention that isn't a build error doesn't exist. SEO is the archetype — every SEO regression in history was a documented convention someone forgot.

## Typed JSON-LD

```ts
meta: ({ post }) => ({ /* ... */ ld: ld.Article(post) })
```

Helpers, typed against schema.org shapes:

| Helper | For |
|---|---|
| `ld.Article` | posts, news, docs pages |
| `ld.Product` | catalog and detail pages with price + availability |
| `ld.Organization` | the site's own identity, emitted once |
| `ld.BreadcrumbList` | derived from the route's path segments |
| `ld.FAQPage` | Q&A blocks |
| `ld.SoftwareApplication` | app landing pages |
| `ld.Event` | dated, located events |
| `ld.Recipe` | ingredient + step content |

A missing required property is a **type error**, not a Rich Results Test failure discovered next week. Output is a single `<script type="application/ld+json">`, deduped per page.

## Generated from the route table

| Artifact | Derived from | Notes |
|---|---|---|
| `sitemap.xml` | all indexable routes + `prerender()` results | `lastmod` from the entity's `updatedAt`; auto-split at 50k URLs into a sitemap index |
| `robots.txt` | route `robots` fields + `app.config.ts` | sitemap reference included |
| `rss.xml` / `atom.xml` / `feed.json` | routes tagged as feed items | one declaration, three formats |
| `llms.txt` | `site/` route titles + descriptions | machine-readable site summary for agents |
| `404` / `500` | required routes | missing one is a build error |

Nothing here is a plugin. Deleting a route removes it from the sitemap in the same build.

## i18n routing

| Feature | Behavior |
|---|---|
| Locale routing | `/`, `/es/`, `/de/` from the configured locale list — no per-route wiring |
| `hreflang` | full reciprocal set emitted per route, including `x-default` |
| Per-locale static output | each locale is prerendered separately; no client-side locale swap on `site/` |
| Missing key | renders `⟦key⟧` in dev, **fails `x verify`** in CI |
| Numbers / dates / money | `Intl.*` with an explicit IANA `timeZone` and ISO currency; never a hand-rolled format |
| Localized metadata | `meta` receives `locale`; a locale missing a description is the same build error |

See [I18n](I18n), [Timezones and dates](Timezones-And-Dates), [Money](Money).

## Image pipeline

```tsx
<Image src={post.cover} alt={post.title} sizes="(max-width: 700px) 100vw, 700px" priority />
```

One `<Image>` shape, one capability contract, stated once — in [`docs/idea/07-rendering-seo.md` → Image pipeline](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/07-rendering-seo.md#image-pipeline): variants, `srcset`, inlined dimensions, the blur placeholder, the `@ultimat3/core` runtime, and the `ImageTransformDriver` seam AVIF/WebP variants come from. Restating it here would let the two copies drift.

## Rules

- `render` and `offline` are declared on the route or defaulted by surface. Never inferred at runtime.
- `revalidate.tags` are typed handles from the tag graph — an unknown tag is a compile error ([Caching and invalidation](Caching-And-Invalidation)).
- Routes never touch the DB directly. Data comes from a `query`.
- A route holds no business logic. That is a service, behind an [action](Actions).
- `prerender()` must be deterministic and bounded — it is a build input.
- Never hand-write a canonical URL, a sitemap entry, or `sw.js`.
