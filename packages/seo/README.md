# @ultimat3/seo 🔍

SEO is **enforced, not documented**. These are build errors, not lint warnings.

## What fails the build

| Code | Trigger | Why it is fatal |
|---|---|---|
| `X_SEO_META_MISSING` | a `site/` route with no `meta.title` or `meta.description` | a page with no description gets a snippet Google invents; that is the one string you cannot fix after launch |
| `X_SEO_DUPLICATE_META` | two routes share a title or description | duplicate meta makes the pages compete with each other, and the wrong one wins |
| `X_SEO_META_TOO_LONG` | title > 60 chars, description > 160 | the tail is truncated in results — the words are paid for and never read |
| `X_SEO_CANONICAL_MISMATCH` | `meta.canonical` does not resolve to the route's own URL | a wrong canonical de-indexes the page in favour of another |
| `X_LD_INVALID` | a JSON-LD node missing a required schema.org field | invalid structured data drops the rich result silently |
| `X_BUDGET_EXCEEDED` | a route over its `js` / `css` / `lcp` / `cls` / `inp` budget | performance is a ranking factor and regressions are invisible without a gate |
| `X_SITEMAP_TOO_LARGE` | the sitemap index exceeds 50,000 files | past the protocol limit the whole sitemap is discarded |

Every error names the exact route **file** and the exact edit:

```
X_SEO_META_MISSING: a site/ route is missing required metadata
  cause: apps/web/site/about/page.tsx (route "/about") has no meta.description
  fix:   add description to defineRoute({ meta }) in apps/web/site/about/page.tsx
```

## Modules

| File | Owns |
|---|---|
| `meta.ts` | the metadata model, `renderMeta()` → head tags: title template, canonical, robots, `og:*`, `twitter:*`, hreflang + `x-default`, `theme-color` per colour scheme |
| `validate.ts` | the build gate — `validateMeta()` (`--json`-shaped) and `assertMeta()` |
| `ld.ts` | typed JSON-LD builders; required fields are required in the **input type** |
| `sitemap.ts` | `buildSitemap()` from the route table + each route's `prerender()`, per-locale alternates, automatic index splitting past 50k |
| `robots.ts` | `buildRobots()`, environment-aware and fail-closed |
| `rss.ts` | `buildFeed()` → RSS 2.0 + Atom + JSON Feed from one item list |
| `images.ts` | `srcset` widths, AVIF → WebP → original, blur placeholders, inlined intrinsic dimensions |
| `budgets.ts` | `checkBudgets()` / `assertBudgets()`, the CI gate |

## Type-level enforcement

```ts
ld.Article({ headline: 'Ship it', author: { name: 'Ada' } });
//  ^ error: Property 'datePublished' is missing — required by schema.org
```

A missing `datePublished` is a compile error, not a Search Console warning three
weeks later.

## robots.txt is fail-closed

Only the literal string `production` in `ULTIMATE_ENV` / `NODE_ENV` opts a deploy
into indexing. A typo, an unset variable, or a branch deploy all resolve to
`preview`, and preview emits:

```
User-agent: *
Disallow: /
```

No sitemap line either — advertising one invites the crawl that was just refused.

## Usage

```ts
export const config = defineRoute({
  render: 'isr',
  prerender: () => db.posts.slugs(),
  meta: ({ post }) => ({
    title: post.title,
    titleTemplate: '%s — Ultimate',
    description: post.excerpt,
    og: { type: 'article', image: post.cover, publishedTime: post.publishedAt },
    alternates: post.locales.map((l) => ({ hreflang: l, href: `/${l}/blog/${post.slug}` })),
    ld: [ld.Article({ headline: post.title, datePublished: post.publishedAt, author: post.author })],
  }),
  budget: { js: '0kb', lcp: 2000 },
});
```

## Commands

```
bun test                 # meta, validation, JSON-LD, sitemap, robots, feeds, images, budgets
bun run typecheck
```
