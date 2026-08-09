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
| `images.ts` | `srcset` widths, AVIF → WebP → original, inlined intrinsic dimensions |
| `image-driver.ts` | `ImageTransformDriver` + `builtinImageDriver()`: the variant bytes and the blur placeholder |
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

## Image transforms

`builtinImageDriver({ read })` is the one built-in `ImageTransformDriver`, and it runs
`@ultimat3/core`'s pipeline — zero dependencies, no `sharp`, no native binary.

```ts
const images = builtinImageDriver({ read: (src) => Bun.file(`public${src}`).bytes() });

// a 1200x630 source
await images.transform({ src: '/img/hero.png', width: 640 });
// → { bytes, contentType: 'image/jpeg', width: 640, height: 336 }
await images.blurPlaceholder('/img/hero.png');
// → 'data:image/png;base64,…'
```

| | |
|---|---|
| decodes | `png`, `jpeg` |
| encodes | `png`, `jpeg` |
| probes only | `webp`, `avif`, `gif`, `svg` — intrinsic size, never a transform |

- **`read` is required.** `src` is a string and only the app knows whether it is a path, a
  storage key or a URL. Guessing would mean a filesystem read off a URL-shaped string.
- **No `format` → the pixels decide:** PNG when the raster has alpha, JPEG otherwise. A logo
  never grows a black background because nobody passed a format.
- **`format: 'avif'` or `'webp'` → `X_IMAGE_UNSUPPORTED`,** with the fix line. Those `<source>`
  entries need a CDN driver; the framework will not pretend to encode what it cannot.
- **`width`/`height` are probed off the output bytes,** never echoed from the request. A width
  above the intrinsic one clamps to the source and reports the source's size, so the box the
  browser reserves is the box the bytes fill.
- `blurPlaceholder()` returns a 16px-wide PNG `data:` URI, ready for `ImageInput.blurDataUrl`.

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
