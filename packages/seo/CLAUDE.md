# @ultimat3/seo — agent notes

Tier 1. May import `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/i18n`. Nothing above tier 1, no external deps.

## Boundary

| Owns | Does not own |
|---|---|
| metadata model, the build gate, JSON-LD, sitemap/robots/feeds, image contract, budgets | rendering, routing, the route table itself (it consumes `RouteRecord`) |

## Hard rules

- **Enforced, not documented.** Every check has an `assert*` that throws a coded `SeoError`, and a `--json`-shaped report the CLI prints. A check that only returns a boolean does not exist.
- **Errors name the file, not the URL.** `RouteRecord.file` is in every cause and every fix; an agent must be able to open the source without guessing.
- **Fail closed, and core reads the key.** `isIndexable()` is `environment === 'production'` and
  nothing else — `staging`, a laptop, a typo and an unset variable all disallow. `ULTIMATE_ENV` has
  exactly one reader and it is `@ultimat3/core`'s (`Environment`, `tryResolveEnvironment`); this
  package owns only what an *unnameable* environment means, which is core's `DEFAULT_ENVIRONMENT`
  and never a throw — nothing in a web container's boot path resolves the environment
  unconditionally, so a `robots.txt` render is routinely the first reader and it must answer.
  Never invert that default and never re-read the key here.
- **Required schema.org fields are required in the input type.** Runtime `required()` only catches empty strings from a CMS; the type is the primary gate.
- **No ambient defaults for meta.** A missing description is an error, never a fallback string.
- **Head tags are CONSTRUCTED here and serialised nowhere here.** `renderMeta` returns data;
  `HeadTag.text` is raw, and `@ultimat3/render`'s `renderHead` picks the escape from the element
  (raw text for code, the total `\uXXXX` JSON rule for a `type` ending in `json`). `meta.ts` had a
  `renderHeadTags` that emitted HTML with a weaker escape — `</` neutralised, `<!--<script>` not —
  and **nothing called it**; deleted `As of 2026-08`. Never add it back, and never escape `text`
  at construction: it would double-escape at tier 4, and the two rules would drift apart. seo
  cannot import render's escapers either — seo is tier 1, render is tier 4. `xml.ts` stays the
  package's one escaper for the XML and attribute surfaces it really does emit (sitemap, feeds,
  robots, `<picture>`), whose rules are the opposite of a raw-text element's.
- **`builtinImageDriver({ read })` takes its reader.** `TransformRequest.src` is a string, and
  whether that string is a path, a storage key or a URL is the app's fact, not seo's — never add
  a filesystem fallback. Pixels come from `@ultimat3/core`'s pipeline; seo owns no second scaler,
  and the driver reports the size it probed off the output, never the size that was requested.
- **One spelling of the transform query keys.** `IMAGE_QUERY_KEYS` in `images.ts` is the only
  place `w`/`f`/`q` are spelled; `defaultUrlFor` writes them and `parseImageQuery` is the only
  reader — never hand-roll either half against a literal. A present-but-unusable `w` or `q`
  (`?w=0`, `?q=150`, empty, negative, fractional, or so many digits that `parseInt` returns
  `Infinity`) throws `X_IMAGE_QUERY_INVALID` instead of
  falling back to the untransformed original — that silent fallback is the layout shift this
  whole contract exists to prevent. `parseImageQuery` never validates `f` against real format
  names; that refusal stays `image-driver.ts`'s `X_IMAGE_UNSUPPORTED`, so one bad URL never
  carries two codes.
- **A feed date never throws and never lies.** `feed-dates.ts` is the only place a feed timestamp
  is parsed or formatted; `buildFeed` resolves every date once, so no builder ever sees a string it
  has to parse. An item date that will not parse is **absent** — the element is omitted (Atom's
  required `<updated>` falls back to the feed's) — never `Invalid Date`, never today standing in
  for it, and never a `RangeError` out of a route a reader is polling. Scan a feed with a loop, not
  `Math.max(...times)`: a spread is one argument per item and the engine's limit is the caller's
  stack depth, not the feed's size. "Now" arrives through `BuildFeedOptions.clock`; nothing in
  `rss.ts` reads a clock of its own.
- Only `site/` routes are SEO-checked — `app/` is behind auth and crawlers never authenticate.

## Files

| Path | Responsibility |
|---|---|
| `routes.ts` | the `RouteRecord` shape + `indexableRoutes` / `expandRoute` |
| `meta.ts` | model + `renderMeta()`; the only place head tags are constructed, and no place they are serialised |
| `validate.ts` | the gate; `MetaIssue` is the serialisable projection of a `SeoError` |
| `xml.ts` | all escaping. Never hand-roll an escape in another module |
| `rss.ts` | `buildFeed()` — the three feed formats; owns markup, never a date |
| `feed-dates.ts` | all timestamp parsing and formatting for feeds. Never `Date.parse` in another module |
| `images.ts` | what the markup promises: `srcset` widths, `<picture>` order, inlined dimensions — plus `IMAGE_QUERY_KEYS` and `parseImageQuery`, the contract that reads a minted URL back. Decodes nothing |
| `image-driver.ts` | the bytes behind that promise: `ImageTransformDriver` + `builtinImageDriver({ read })` over core's pipeline — png/jpeg only |

## Commands

```
bun test packages/seo
bun run --filter @ultimat3/seo typecheck
```
