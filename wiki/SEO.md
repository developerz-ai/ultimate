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
| `X_SITEMAP_ENTRY_INVALID` | a page's `lastmod` that is not a `Date` or ISO 8601 with a zone, or a `locales` name the app does not route — names the route file |
| `X_SEO_LINK_INVALID` | a `meta.links` entry whose href is not a path or an `http(s)` URL (`javascript:`, `data:` …), a `preload` with no `as`, or a font preload with no `crossorigin`. Thrown while the page renders (SSR and prerender) and reported at the route file by the `seo` step |

`x verify`'s `seo` step runs `validateMeta` over every `site/` route: missing, duplicate and
over-long meta fail the gate. Canonical checks are skipped there, because an app declares no base
URL; JSON-LD, sitemaps and robots are enforced where they are built — each builder throws. Performance
budgets are **not** here: they are the `budgets` step and `X_BUDGET_EXCEEDED`.

## Head links

`meta.links` puts `<link>` tags in `<head>` — a font preload, a preconnect, a feed — typed, in
declaration order, for SSR and prerender alike. `canonical` and hreflang keep their own fields, and
the surface stylesheet is the renderer's, so neither `rel` is spellable here.

```ts
export const config = defineRoute({
  render: 'static',
  meta: () => ({
    title: 'Acme',
    description: 'Notificaciones electrónicas con constancia de entrega',
    links: [
      {
        rel: 'preload',
        href: asset('assets/fonts/inter-var.woff2'),
        as: 'font',
        type: 'font/woff2',
        crossorigin: 'anonymous',
      },
      { rel: 'alternate', href: '/feed.xml', type: 'application/rss+xml' },
    ],
  }),
});
```

Fields: `rel`, `href`, `as`, `type`, `crossorigin`, `media`. Two links of one `rel` are two tags:
a link's `href` is part of its identity when the head is deduped.

## The social card

A document that may not be indexed carries no card — no `og:*`, no `article:*`, no `twitter:*` tag,
declared or derived — unless the route declares `socialCard: true`. `meta.robots: { index: false }`
says so, and so does a 4xx or 5xx, which `@ultimat3/render` marks `noindex` by construction. A
document that may be indexed carries its card whatever the field says. `As of 2026-10`.

`meta.socialCard: true` is the route's own opt-in, and the only one. With it, a noindex document
carries the card exactly as an indexable one does: declared values win, and the derived ones come
with it — `og:type`, `og:title` and `og:description` from the page's own title and description,
`og:url` from the canonical, `og:locale`, and the `twitter:card` default. The robots directives
never change: `renderMeta()` still answers `<meta name="robots" content="noindex,follow">`, and the
route stays noindex.

```ts
import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'isr',
  revalidate: { ttl: '5m' },
  offline: 'network-only',
  meta: () => ({
    title: 'Pricing',
    description: 'What the plan costs.',
    robots: { index: false },
    socialCard: true,
  }),
});
```

### A card the build photographs: `og.capture`

`og: { capture: '/og/home' }` names a `site/` page — one you write, laid out at exactly 1200 x 630,
`robots: { index: false }` — and `x build --target static` photographs it into `/_og/og/home.png` and
stamps `og:image`, `og:image:width` and `og:image:height` on every exported document that declares
it. `image` and `capture` are one or the other; both together is a type error. `As of 2026-11`.

| Fact | Rule |
|---|---|
| the path | a concrete page path. A dynamic card (`/og/post/[slug]`) lists its pages in its own `prerender()` |
| no such page | `X_SEO_CARD_ROUTE_UNKNOWN` — from `x verify`'s `seo` step, and again from the build for a path only a dynamic route resolves |
| the browser | the CLI's own CDP driver: `CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH` or `SCRAPE_CDP_URL`. None: `X_SEO_CARD_BROWSER_MISSING` |
| `x build --no-capture` | stamps the same tags, takes no picture, needs no browser. `x verify`'s own build and the reference-app gate pass it, and only they do |
| a served document | carries no `og:image` for a capture, on purpose: the PNG exists only in the export, the container holds no browser to take one (axiom 7), and an `og:image` naming a file nothing serves is a broken preview a crawler caches. Deploy `site/` as the static export, or set `og.image` — `twitter:card` falls back to `summary` |

```ts
import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'static',
  offline: 'network-only',
  meta: () => ({
    title: 'Postly',
    description: 'A team blog that behaves itself.',
    og: { capture: '/og/home' },
  }),
});
```

A card for a ROW published at runtime is the app's job, not the build's: `scrape()` over the row's
card page, `page.screenshot()`, `disk.put()`, then `og: { image }` with the stored object's URL —
[Scraping](Scraping#pages-as-files-pdf-and-cards).

## The pieces

| Call | Answers |
|---|---|
| `renderMeta()` | the head tags: title (a `$` in a title is kept verbatim), canonical, robots, `og:*`, `twitter:*`, hreflang + `x-default`, `theme-color` per scheme, `links`. A document that may not be indexed carries no `og:*`/`article:*`/`twitter:*` tag unless the route declares `socialCard: true` — [The social card](#the-social-card) |
| `buildSitemap()` | from the route table and each route's `prerender()`, per-locale alternates; one urlset, an index of named `sections`, or a split past a cap (50,000 URLs, 50 MB) |
| `buildRobots()` | **fail-closed**: only the literal `production` environment opts into indexing; anything else — staging, a laptop, an unset variable — is `Disallow: /` with no sitemap line. In production `disallow` is added to **every** group, and a `User-agent: *` group is emitted to carry it when none is declared |
| `buildFeed()` | RSS 2.0, Atom and JSON Feed from one item list. The channel's `author`, `copyright` and `icon` reach Atom as `<author>`, `<rights>` and `<icon>`; an item's `author` is `<author>` in Atom and, in RSS, `<author>` with an email or `<dc:creator>` without one; an item's `image` is an Atom enclosure link and an RSS `<media:content>`. An item date must be ISO-8601 with an offset or `Z`; one that is not is treated as absent (and an offsetless one is logged as `seo.feed.date_offsetless`), never read through the server's zone |
| `builtinImageDriver({ read })` | resize and blur placeholder over core's pipeline — decodes `png`, `jpeg`, `webp`, `gif`; encodes `png`, `jpeg`, `webp`. `avif` needs a CDN driver (`X_IMAGE_UNSUPPORTED`), so `responsiveImage()` offers `webp` only unless given `formats`, and no width past 8192 (`MAX_IMAGE_WIDTH`). `As of 2026-10` |
| `parseImageQuery()` | the one reader of the `?w=&f=&q=` a responsive image URL carries (`X_IMAGE_QUERY_INVALID`) |
| `setStaticExport()` | the static build's seam: while it renders, `responsiveImage()` names `/_img/<variant hash>-<width>.<ext>` files (source bytes, width, format and encoder) and `og.capture` names `/_og/<path>.png`. Unset in a served process — [Static assets](Static-Assets#responsive-images-in-a-static-export) |

Every `X_SEO_*` and image code is in [Error codes](Error-Codes).

## `robots.txt` and `sitemap.xml`

One answer, served two ways. `siteSeo()` from `@ultimat3/cli` builds both from the route table. It
takes the public `site/` routes (no `policy`) and expands a dynamic route through its `prerender()`.

| Where | How |
|---|---|
| static export | the scaffolded `apps/web/prerender.ts` writes `siteSeo()`'s files into `.x/static` (`writeSiteSeo`). A dynamic route lists exactly the pages the build emitted |
| web role (`x dev`, `runRole`) | `GET /robots.txt`, `GET /sitemap.xml` and its parts `GET /sitemaps/:file`, `application/xml`, `public, max-age=3600`, built once per origin and kept for that same hour. Every file shares one answer: a refresh that fails or hangs keeps the previous index **and** its parts. Absolute against `APP_URL`, else `SITE_ORIGIN`, else the request's own origin |

Production `robots.txt` rules come from `app.config.ts`: `seo.robots.disallow` (every crawler, in
every group) and `seo.robots.groups` (per `User-agent`) —
[Configuration](Configuration#site-and-seo). A crawler obeys only the group naming it most
specifically, so a group for `GPTBot` replaces `*`'s rules for it. Any other environment emits
`Disallow: /` alone, whatever either says.

### What is left out

| Left out | Decided by |
|---|---|
| a page whose `meta` says `robots: { index: false }` | the route's own `meta`, read **once per routed locale**: `noindex` in English only lists the other locales and drops English from their hreflang cluster. Read for a route with no params and no `load` — the only `meta` that resolves without a request |
| a page of a dynamic route, or of a route with `load` | its `prerender()` entry: `locales: ['es-co']` lists it there only, `locales: []` nowhere. Its `meta` is **not** read — that would be one `load` per page per refresh |
| a URL `seo.robots.disallow` matches (a `seo.robots.groups` rule does not — it binds only the crawlers it names) | the rule, read as a crawler reads it (prefix, `*`, trailing `$`). A locale copy it blocks leaves the cluster. `As of 2026-10`: such a URL used to be listed — "submitted URL blocked by robots.txt" |
| a gated route, an `app/` page not in `extra` | `policy`, `seo.sitemap.extra` |

### A page's own `lastmod` and locales

`prerender()` answers a bare string, a params object, or an **entry** — the three mix freely:

```ts
import { defineRoute } from '@ultimat3/render';

declare const posts: {
  published(): Promise<readonly { slug: string; updatedAt: Date; englishReviewed: boolean }[]>;
};

export const config = defineRoute({
  render: 'isr',
  revalidate: { ttl: '10m' },
  offline: 'network-only',
  prerender: async () =>
    (await posts.published()).map((post) => ({
      params: { slug: post.slug },
      lastmod: post.updatedAt, // a Date, or ISO 8601 with a zone
      locales: post.englishReviewed ? ['es-co', 'en'] : ['es-co'],
    })),
  meta: ({ params }) => ({ title: params['slug'] ?? '', description: 'A note from the blog.' }),
});
```

| Key | Rule |
|---|---|
| `params` | the page. The build renders it in **every** routed locale whatever `locales` says: `locales` is about listing, not about which documents exist |
| `lastmod` | written as W3C Datetime in UTC (`2026-10-01T15:04:05.000Z`). Wins over `seo.sitemap.lastmod`. A time with no zone (`2026-10-01T10:00:00`) or free text is `X_SITEMAP_ENTRY_INVALID`, never read in the server's zone. A moment in the future is **clamped to now**: refusing it would fail the whole sitemap for one row stamped by a clock a second ahead, and writing it teaches a crawler to distrust every date in the file |
| `locales` | one `<url>` per named locale, hreflang among those only; `x-default` only when the default locale is one of them; a page left in one locale carries no alternates. Omitted: every routed locale. A name the app does not route is `X_SITEMAP_ENTRY_INVALID` |

A route with **no params** may answer `prerender()` too — `() => [{ params: {}, lastmod, locales }]`
— which is how a page with a `load` (a blog index whose date is its newest post's) says either.

A key that is none of the three (`lastMod`) is `X_PRERENDER_FAILED`. The static export still lists
only the pages it emitted; it asks `prerender()` again for what each says of itself.

The `<head>` is separate: a page's hreflang tags come from `meta.alternates`, or from every routed
locale when it declares none. A page listed in one locale declares its own:
`alternates: [{ hreflang: 'es-CO', href: url }]`.

### Sections: an index by configuration

```ts
import { defineConfig } from '@ultimat3/core';

export const config = defineConfig({
  name: 'acme',
  seo: {
    sitemap: {
      pageSize: 1000,
      sections: [
        { name: 'blog', match: '/blog/**' },
        { name: 'ciudades', match: ['/juzgados/**', '/ciudades/*'] },
      ],
    },
  },
});
```

`/sitemap.xml` becomes a `<sitemapindex>`; every listed page goes to `/sitemaps/<name>-<n>.xml`.

| Rule | |
|---|---|
| match | against the page's path **without** its locale prefix, so `/en/blog/a` files with `/blog/a` and a cluster stays in one section. `/precios` that page · `/blog/*` one segment below · `/blog/**` `/blog` and everything below. First section that matches wins, in declaration order |
| unmatched | the default section, `pages` — a reserved name |
| order | `pages` first, then sections as declared; inside one, pages sorted by path, so the bytes depend on which pages exist and never on the order a query returned them |
| pagination | `pageSize` URLs per file (default and ceiling 50,000); a file past 50 MB splits further. Numbered from 1 even when there is one: `blog-1.xml` keeps its URL when `blog-2.xml` appears |
| empty | a section with no page writes no file and is not in the index; a site with no page at all answers one empty urlset |
| index `<lastmod>` | per child, the newest `<lastmod>` inside it; none when no URL in it has one |
| `robots.txt` | names `/sitemap.xml` alone |
| refused at boot | a `name` that is not a lower-case slug (`a-z`, `0-9`, single hyphens), a duplicate, `pages`, a `match` that is not a path pattern, a `pageSize` outside 1–50,000 — `X_CONFIG_INVALID` |

With no `sections` the output is byte-for-byte what it was: one urlset at `/sitemap.xml`, and past
a cap (50,000 URLs, or 50 MB) the index with parts `/sitemaps/1.xml`, `/sitemaps/2.xml`, …
(`SITEMAP_PARTS_DIR`). A part the index does not name is a 404, `no-store`. `As of 2026-10`.

## `llms.txt`

`As of 2026-11-06`. **A third file of the same answer, on by default like the sitemap.**
`/llms.txt` lists the indexable `site/` pages a sitemap lists, by their `meta` title and
description, in path order, under the home page's title and description:

```
# Postly

> Posts for teams.

- [Pricing](https://postly.example/pricing): Plans, per seat.
```

| Rule | |
|---|---|
| served | `GET /llms.txt` from the web role (`text/markdown`, the sitemap's hour of cache); the static export writes the same bytes (`writeSiteSeo`) |
| listed | public, indexable `site/` pages, in the default locale, less `seo.robots.disallow`. A dynamic route (or one with a `load`) is expanded through `prerender()` page by page, each line the title and description that page's own `meta` gives it through its `load` — the export lists only the pages it emitted, as the sitemap does; a page whose `meta` says `robots: { index: false }` is left out. `prerender()` runs once per answer for the sitemap and this file together |
| outside production | an empty document, for `robots.txt`'s reason |
| opt out | `seo: { llms: false }` in `app.config.ts`: the framework mounts no `GET /llms.txt` and the static export writes none — the path is the app's own route to serve, or a 404 |
| build error | while on, a listed page with no `meta.description` is `X_SEO_LLMS_DESCRIPTION_MISSING` in the `seo` step. The step reads `meta` without a database, so it checks the pages whose `meta` needs no `load`; an expanded page with no description is listed by its title alone |

The repository's own `llms.txt` is a separate, hand-kept file and is not this.

**Beyond `site/`, and `<lastmod>`** (`As of 22.10`) — `seo.sitemap` in `app.config.ts`:

```ts
seo: { sitemap: { extra: ['/verificar', '/estado'], lastmod: 'git' } },
```

| Key | Does |
|---|---|
| `extra` | lists public `app/` pages beside the `site/` ones — each path must be answered by an `app/` route declaring no `policy`, and is listed per routed locale with the same hreflang cluster and `x-default`. A path no route answers, an `api/` route, a gated page or a `site/` page (listed already) is `X_SITEMAP_EXTRA_INVALID` — refused, never skipped |
| `lastmod` | `'none'` (default, no `<lastmod>`), `'git'` (the route file's last commit; its mtime without a work tree), `'mtime'`, `'build'` (one timestamp) |

The scaffolded `prerender.ts` passes `sitemap` and `root` from `loadSiteSettings(root)`; an app with
its own `prerender.ts` adds `sitemap: settings.sitemap, root` to its `siteSeo({ … })` call.

The parts of a split were `/sitemap-N.xml` once, which no running process could serve
([Upgrading](Upgrading)).
