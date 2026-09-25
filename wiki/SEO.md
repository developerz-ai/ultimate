# SEO

Metadata, JSON-LD, sitemaps, `robots.txt`, feeds and responsive images, each rule an `assert*` that
throws a coded `SeoError` naming the route file and the edit. Package `@ultimat3/seo` (tier 1) —
the full reference is
[`packages/seo/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/seo/README.md).
Route metadata itself is declared on `defineRoute({ meta })` ([Routes and render
modes](Routes-And-Render-Modes)).

```ts
export const config = defineRoute({
  render: 'isr',
  meta: ({ post }) => ({
    title: post.title,
    titleTemplate: '%s — Ultimate',
    description: post.excerpt,
    og: { type: 'article', image: post.cover, publishedTime: post.publishedAt },
    ld: [ld.Article({ headline: post.title, datePublished: post.publishedAt, author: post.author })],
  }),
});
```

## What the rules refuse

| Code | Trigger |
|---|---|
| `X_SEO_META_MISSING` | a `site/` route with no `meta.title` or `meta.description` |
| `X_SEO_DUPLICATE_META` | two routes share a title or a description |
| `X_SEO_META_TOO_LONG` | title over 60 characters, description over 160 |
| `X_SEO_CANONICAL_MISMATCH` | `meta.canonical` does not resolve to the route's own URL |
| `X_LD_INVALID` | a JSON-LD node missing a required schema.org field — and a required field is required in the builder's **input type**, so `ld.Article` without `datePublished` does not compile. A CMS `null` in one is the same coded refusal |
| `X_SITEMAP_TOO_LARGE` | the sitemap index past 50,000 files |

`x verify`'s `seo` step runs `validateMeta` over every `site/` route: missing, duplicate and
over-long meta fail the gate. Canonical checks are skipped there, because an app declares no base
URL; JSON-LD, sitemaps and robots are enforced where they are built — each builder throws. Performance
budgets are **not** here: they are the `budgets` step and `X_BUDGET_EXCEEDED`.

## The pieces

| Call | Answers |
|---|---|
| `renderMeta()` | the head tags: title (a `$` in a title is kept verbatim), canonical, robots, `og:*`, `twitter:*`, hreflang + `x-default`, `theme-color` per scheme |
| `buildSitemap()` | from the route table and each route's `prerender()`, per-locale alternates, split into an index past 50k |
| `buildRobots()` | **fail-closed**: only the literal `production` environment opts into indexing; anything else — staging, a laptop, an unset variable — is `Disallow: /` with no sitemap line |
| `buildFeed()` | RSS 2.0, Atom and JSON Feed from one item list. An item date must be ISO-8601 with an offset or `Z`; one that is not is treated as absent (and an offsetless one is logged as `seo.feed.date_offsetless`), never read through the server's zone |
| `builtinImageDriver({ read })` | resize and blur placeholder over core's pipeline — decodes and encodes `png` and `jpeg`; `webp`/`avif` need a CDN driver (`X_IMAGE_UNSUPPORTED`) |
| `parseImageQuery()` | the one reader of the `?w=&f=&q=` a responsive image URL carries (`X_IMAGE_QUERY_INVALID`) |

Every `X_SEO_*` and image code is in [Error codes](Error-Codes).

## `robots.txt` and `sitemap.xml`

One answer, served two ways. `siteSeo()` from `@ultimat3/cli` builds both from the route table. It
takes the public `site/` routes (no `policy`), leaves out any page whose `meta` says
`robots: { index: false }`, and expands a dynamic route through its `prerender()`.

| Where | How |
|---|---|
| static export | the scaffolded `apps/web/prerender.ts` writes `siteSeo()`'s files into `.x/static`. A dynamic route lists exactly the pages the build emitted |
| web role (`x dev`, `runRole`) | `GET /robots.txt` and `GET /sitemap.xml`, `public, max-age=3600`, built per request. Absolute against `APP_URL`, else `SITE_ORIGIN`, else the request's own origin. `As of 2026-09-25` (22.2.2) |

Past 50,000 URLs, `/sitemap.xml` is the index. The web role serves the index but not the
`/sitemap-N.xml` parts, so a site that large serves its sitemap from the static export.
