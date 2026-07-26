# Rendering & SEO

Render mode is a per-route property. SEO is enforced by the build, not described in a guide.

## Five render modes

| Mode | Behavior | Use |
|---|---|---|
| `static` | built once, served as a file | marketing, docs |
| `isr` | static + background regen on tag/TTL | catalogs, profiles |
| `ssr` | per-request full render | fresh SEO pages |
| `stream` | static shell flushed instantly, holes streamed | **default for app pages** |
| `spa` | shell only, client fetches | dashboards behind auth |

Declared on the route, alongside everything else the router needs to know:

```ts
// route
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

| Surface | Default | Allowed |
|---|---|---|
| `site/` | `static` | `static`, `isr`, `ssr` |
| `app/` | `stream` | `stream`, `spa`, `ssr` |
| `api/` | n/a | no rendering at all |

## Why `stream` is the app default

An authed page needs fresh data and fast first paint. `ssr` gives freshness and a slow TTFB (the whole page waits for the slowest query). `spa` gives instant shell and a spinner farm plus no HTML for anything. `stream` gives both halves: shell now, data as it resolves.

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

`hydrate` controls when an island wakes: `idle` (default in `app/`), `visible` (below the fold), `interaction` (menus, modals), `never` (static islands). A blown `budget.js` is a build failure, so islands cannot quietly accumulate.

## SEO is handled, not documented

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

The rule from [`00-thesis.md`](./00-thesis.md): a convention that isn't a build error doesn't exist. SEO is the archetype — every SEO regression in history was a documented convention someone forgot.

### Typed JSON-LD

```ts
meta: ({ post }) => ({ /* ... */ ld: ld.Article(post) })
```

`ld.*` helpers are typed against schema.org shapes: `ld.Article`, `ld.Product`, `ld.Organization`, `ld.BreadcrumbList`, `ld.FAQPage`, `ld.SoftwareApplication`, `ld.Event`, `ld.Recipe`. A required property missing is a **type error**, not a Rich Results Test failure discovered next week. Output is a single `<script type="application/ld+json">`, deduped per page.

### Generated from the route table

| Artifact | Derived from | Notes |
|---|---|---|
| `sitemap.xml` | all indexable routes + `prerender()` results | `lastmod` from the entity's `updatedAt`; auto-split at 50k URLs into a sitemap index |
| `robots.txt` | route `robots` fields + `app.config.ts` | sitemap reference included |
| `rss.xml` / `atom.xml` / `feed.json` | routes tagged as feed items | one declaration, three formats |
| `llms.txt` | `site/` route titles + descriptions | machine-readable site summary for agents |
| `404` / `500` | required routes | missing one is a build error |

Nothing here is a plugin. Deleting a route removes it from the sitemap in the same build.

### i18n

| Feature | Behavior |
|---|---|
| Locale routing | `/`, `/es/`, `/de/` from the configured locale list — no per-route wiring |
| `hreflang` | full reciprocal set emitted per route, including `x-default` |
| Per-locale static output | each locale is prerendered separately; no client-side locale swap on `site/` |
| Missing key | renders `⟦key⟧` in dev, **fails `x verify`** in CI |
| Numbers / dates / money | `Intl.*` with an explicit IANA `timeZone` and ISO currency; never a hand-rolled format |
| Localized metadata | `meta` receives `locale`; a locale missing a description is the same build error |

### Image pipeline

```tsx
<Image src={post.cover} alt={post.title} sizes="(max-width: 700px) 100vw, 700px" priority />
```

| Step | Output |
|---|---|
| Variants | AVIF + WebP + original fallback, at the widths implied by `sizes` |
| `srcset` / `sizes` | generated; a raw `<img>` in `site/` is a build error |
| Dimensions | read at build time and **inlined** as width/height → **CLS 0** |
| Placeholder | blur hash inlined as a data URI, swapped on decode |
| Loading | `lazy` by default, `priority` → eager + `<link rel="preload">` for the LCP image |
| Where | build-time for `site/`, on-demand + cached for user uploads (`Bun.s3` + the cache tiers) |
| Runtime | Bun's native image APIs. No `sharp`, no vendor image CDN ([axiom 7](./00-thesis.md)) |

### Budgets in `x verify`

```
x verify
  ✓ typecheck            ✓ import boundaries      ✓ migration drift
  ✓ lint                 ✓ tests (6 types)        ✓ contract diff
  ✗ budgets
      site/pricing   js 61kb > 40kb   (chart.js via shared/ui/button.tsx)
      app/reports    lcp 2400 > 2000
```

| Check | Source of truth |
|---|---|
| Per-route JS bytes | `budget.js` on the route; measured from the real bundle graph |
| LCP / CLS / TBT | headless Lighthouse against the built output, median of N runs |
| Lighthouse SEO + a11y scores | minimum thresholds in `app.config.ts`, defaults 100 / 95 |
| Regression | budgets ratchet — the recorded baseline can tighten, never loosen silently |

Failures name the *cause* (the transitive import that added the bytes), because "bundle too big" without a chain is not an instruction.
