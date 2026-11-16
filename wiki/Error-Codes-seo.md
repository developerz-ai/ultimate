# Error codes: `@ultimat3/seo`

Part of [Error codes](Error-Codes): every code `@ultimat3/seo` registers. `x errors explain <CODE> --json` prints the same row.

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_IMAGE_QUERY_INVALID` | a minted image URL's `?w=`/`?q=` value is present but unusable | `?w=0`, `?w=-5`, `?q=150` on a URL `responsiveImage()` minted | request a positive integer, e.g. `?w=640` (quality is `1`-`100`, e.g. `?q=75`) |
| `X_LD_INVALID` | JSON-LD node is missing a required schema.org field | an `ld.*` helper called with a partial object | supply the field named in `cause` |
| `X_SEO_CANONICAL_MISMATCH` | canonical URL does not match the route path | a hand-written canonical | delete it — canonicals come from the route table |
| `X_SEO_DUPLICATE_META` | two routes share a title or description | copied metadata | make each page's meta unique |
| `X_SEO_LINK_INVALID` | a route meta link is unsafe or would fetch nothing | a javascript:/data: href, a preload with no as, or a font preload with no crossorigin | edit links in the route's defineRoute({ meta }): an http(s) or relative href, as on every preload, crossorigin on a font preload |
| `X_SEO_LLMS_DESCRIPTION_MISSING` | a page listed in llms.txt has no description | seo.llms is on and an indexable site/ route resolves a meta with no description, so its llms.txt line would say nothing about the page | `x verify --only seo --json` — then add meta.description to the route file it names, or set seo: { llms: false } in app.config.ts |
| `X_SEO_META_MISSING` | a `site/` route is missing required metadata | no title, description or `og.image` | add it to `meta`; the file is named in `cause` |
| `X_SEO_META_TOO_LONG` | title or description exceeds what results render | a description over 160 chars | shorten it — `cause` carries the measured length |
| `X_SEO_OG_IMAGE_CONFLICT` | a route meta og declares both image and capture | meta.og carries both image and capture (a cast or a JS caller past the type), so the static export publishes the capture and a served page publishes no og:image at all | `og: { image: '/card.png' }` or `og: { capture: '/og/<page>' }`, never both, in the route file's `defineRoute({ meta })` |
| `X_SITEMAP_ENTRY_INVALID` | a sitemap entry carries a lastmod or a locale the sitemap cannot write | a prerender() entry (or a page handed to buildSitemap) has a lastmod that is not an ISO 8601 date with an explicit zone, or names a locale the app does not route | `x verify --json` after `prerender()` in the route file named in cause answers `lastmod` as a `Date` or an ISO 8601 string with a zone (`row.updatedAt`) and only routed locales in `locales` |
| `X_SITEMAP_TOO_LARGE` | sitemap exceeds the 50,000-entry limit | too many prerendered URLs in one file | enable sitemap index splitting in `app.config.ts` |
