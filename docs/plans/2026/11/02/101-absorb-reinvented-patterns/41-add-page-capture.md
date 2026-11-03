# 41 — Pages as files: PDF, social cards, and images a static site can actually serve

> Part of [`overview.md`](overview.md). Depends on: [`28-assets-stored-objects.md`](28-assets-stored-objects.md) (the variant key), [`21-cli-verify-and-stop.md`](21-cli-verify-and-stop.md) (the gate's build). Tier: 1 (`storage`, `seo`), 4 (`scraping`), 5 (`cli`).

## Why
| Gap | Evidence |
|---|---|
| A PDF cannot be laid out | `ScrapePage.pdf()` exists (`scraping/src/page.ts:131`), through a browser the app already brings. It takes `{ fullPage }` only (`wiki/Scraping.md:90`): no paper size, margin, background or header. An invoice needs all four |
| Static images are broken | `responsiveImage` mints `?w=&f=` URLs by default (`seo/src/images.ts:82`). Only `/media` answers them (`cli/src/runtime-assets.ts:183`). `grep` over the static export writes no variant, so a CDN ignores the query: the full PNG under a `<source type="image/webp">`, on the path axiom 6 says must be cheapest |
| A social card is hand-made | `meta.image` takes a URL (`seo/src/meta.ts:42`). `x shot` photographs a route to `shot.png` by hand (`cli/src/cmd-shot.ts`), and nothing connects the two. One card per post is standard for any site with articles |
| Warm variants | the first visitor pays the decode on the request path (`runtime-assets.ts:149`), which an upload could have paid in a job |

Not here: AVIF (see Decisions), font subsetting, video.

## Decisions
| Question | Answer |
|---|---|
| AVIF | not built in. Probe on Linux, Bun 1.4.4: `format not supported on this machine (HEIC/AVIF/TIFF require the OS codec…)`. `core/src/image/pipeline.ts:22` refuses this on purpose. `ImageTransformDriver` stays the door |
| Runtime card rendering | a job, through `scrape()`'s browser. No text rasteriser: writing one is a font engine. No browser in the web image |
| A new factory | none. `scrape()` is already the job over a browser (`core/src/registrar.ts`, `PRIMITIVE_FACTORIES`) |
| Browser at build | required only by a plain `x build` of a route declaring a card; absent, a named error. `x verify` never needs it (`cli/src/cmd-shot.ts:1-5` is why). After 21, `budgets` spawns `x build` (`verify-checks.ts:226`), so without a skip a machine with no Chrome goes red: the gate's build passes `--no-capture`, which stamps the same tags, writes no PNG, and weighs the same script bytes |

## Files to change
- `packages/scraping/src/page.ts:131` — `pdf(options?: PdfRequest)`; `capture-clip.ts:40` keeps the clip refusal.
- `packages/scraping/src/cdp-port.ts`, `cdp-target.ts:325`, `driver-fake.ts`, `driver-recorded.ts` — forward `format`, `margin`, `printBackground`, `preferCssPageSize`, `headerHtml`, `footerHtml`.
- `packages/seo/src/meta.ts:42` — `og: { capture: '/og/post/:slug' }` beside `image`, mutually exclusive.
- `packages/seo/src/images.ts:82` — the variant URL seam: at a static build, a path under `/_img/`.
- `packages/cli/src/static-images.ts` (new) — collect the variants the export's documents minted, write each through `core`'s pipeline.
- `packages/cli/src/static-cards.ts` (new) — capture each declared card over `appBrowser` (`cli/src/browser-launcher.ts`), write `/_og/<path>.png`, stamp `og:image`, `og:image:width`, `og:image:height`.
- `packages/cli/src/cmd-build.ts` — both, after the documents and before `site-seo-write.ts`; `--no-capture`.
- `packages/cli/src/verify-checks.ts:226`, `scripts/reference-app-gate.ts` — the gate's builds pass `--no-capture`. Only they do; `wiki/CLI-Reference.md` says so.
- `packages/storage/src/image.ts` — `warmVariants({ disk, key, widths, formats, revision })`, reusing `variantKey` with 28's revision.
- `examples/dummy/apps/web/site/` — one `og.capture`, one `responsiveImage` on a static page; `examples/dummy` job calling `warmVariants`; one `page.pdf({ format })` in a `scrape()` over the fake driver.
- `wiki/SEO.md:108`, `wiki/Scraping.md:90`, `wiki/Static-Assets.md`, `wiki/Storage-And-Uploads.md`, READMEs, `wiki/Error-Codes.md`.

## Steps
1. `PdfRequest = { fullPage?, format?: 'a4' | 'letter' | …, widthMm?, heightMm?, margin?, printBackground?, preferCssPageSize?, headerHtml?, footerHtml? }`. A size given both ways is refused. A printed invoice: `scrape({ allowHosts: ['app.example'], run })`, `page.goto`, `page.pdf`; `X_SCRAPE_SECRET_EXPOSED` keeps its rule. Who may reach that route is the app's policy. Docs give the recipe, with a token-signed route and `disk.put`.
2. Static renditions: a build-local collector inside `responsiveImage` records `{ src, width, format }` when the export sets the static URL builder. No runtime cost: the builder is absent at serve time. Every width is capped at the source's (`usableWidths`). Written under a content hash, `immutable`.
3. A `src` the export cannot read is `X_IMAGE_SOURCE_UNREADABLE` at build. An `avif` request at static build is the existing `X_IMAGE_UNSUPPORTED`: a build error, never a dead `<source>`.
4. Cards: a card route is an ordinary `page.tsx` on `site/` at 1200 x 630 with `robots: noindex`. A dynamic route's cards come from its own `prerender()`. Dynamic rows at runtime: the app's job, `scrape()` then `disk.put`, then `meta.image`. Recipe in `wiki/SEO.md`.
5. `x verify` `seo` step: a declared capture path that matches no route is `X_SEO_CARD_ROUTE_UNKNOWN`. This is the convention's build error.
6. `warmVariants` answers `{ written, failed }`, one source decode, bounded by `MAX_IMAGE_PIXELS`.

## Error codes
`bun run new-error-code` for each new row.

| Code | When | Fix |
|---|---|---|
| `X_SEO_CARD_ROUTE_UNKNOWN` (new, off-socket) | `og.capture` names no route | add the page, or correct the path |
| `X_SEO_CARD_BROWSER_MISSING` (new, off-socket) | a build with cards and no browser | `x doctor --json` names the browser step; or remove `og.capture` |
| `X_IMAGE_SOURCE_UNREADABLE` (new, off-socket) | a static `src` is not in `public/` | put the file in `public/`, or use an absolute URL |
| `X_SCRAPE_PDF_OPTIONS_INVALID` (new, 422) | two sizes, or a size with `preferCssPageSize` | keep one |

## Tests
- `packages/cli/src/static-images.test.ts`: a page with `responsiveImage` exports, and every `srcset` URL is a real file with the promised type and width. Fails today.
- `packages/cli/e2e/static-cards.e2e.test.ts` with a browser: a PNG of 1200 x 630; `og:image` resolves.
- `packages/scraping/src/page-pdf.test.ts` over the fake: options reach the port; both sizes refused. `driver-cdp` live test where a browser exists: a4 page box in the bytes.
- `packages/cli/src/verify-budgets-build.test.ts`: the spawned build carries `--no-capture`; an app with `og.capture` and no browser stays green on `budgets` and `seo`.
- `packages/storage/src/image.test.ts`: `warmVariants` then `/media?w=` reads the warmed key and never decodes.
- `bun test packages/cli/src/static-images.test.ts`

## Semver
**Breaking, two rows.** A static build's image URLs change from `?w=&f=` to `/_img/`, and a `src` the export cannot read, or an `avif` request at static build, is now a build error. Upgrading: "Run `x build --target static`. Put a `responsiveImage` `src` in `public/` or give an absolute URL; drop `avif` from a static route." The options and `warmVariants` are additive. The budget of `examples/dummy` may rise by its measured bytes (`bun run budget-raises`), with its `x.manifest.json` regenerated.

## Done when
- A static export served by a dumb file server gets `image/webp` for every `<source type="image/webp">`.
- `bun run verify` green.
