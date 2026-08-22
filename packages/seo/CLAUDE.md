# @ultimat3/seo — agent notes

Tier 1. May import `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/i18n`. Nothing above tier 1, no external deps.

## Boundary

| Owns | Does not own |
|---|---|
| metadata model, JSON-LD, sitemap/robots/feeds, image contract | rendering, routing, the route table itself (it consumes `RouteRecord`), **performance budgets** |

## Hard rules

- **Enforced, not documented — and `As of 2026-08` the gate half of this package is not yet
  enforcing anything.** Every check here has an `assert*` that throws a coded `SeoError` beside a
  `--json`-shaped report; a check that only returns a boolean does not exist. That is a rule about
  the SHAPE of a check, and it must not be read as a claim that CI fails on one. What is actually
  reached from outside this package is `renderMeta` (through `@ultimat3/render`'s `seoRenderers`),
  `ld.*` (an app's own `meta`), `buildFeed`, and the image contract (`parseImageQuery` /
  `builtinImageDriver` / `responsiveImage`, through `@ultimat3/cli`'s `dev-assets.ts`).
  `validateMeta`/`assertMeta`, `buildSitemap`, `buildRobots`, `isIndexable` and
  `indexableRoutes`/`expandRoute` have **no caller anywhere** — no step of `x verify` runs them.
  Wiring them is a `HostCheck` on an existing step in `packages/cli/src/cmd-verify.ts`; until that
  lands, do not restate the CI claim here, in `README.md` or in the wiki.
- **Performance budgets are not this package's, `As of 2026-08`.** `checkBudgets`/`assertBudgets`/
  `parseBytes`/`DEFAULT_BUDGET`/`BUDGET_UNITS`, `RouteBudget`, `RouteRecord.budget` and
  `X_SEO_BUDGET_EXCEEDED` are deleted: the whole surface was callerless, and `parseBytes` reported a
  malformed size string *as a budget violation*. The live gate is `@ultimat3/cli`'s `checkBudgets`
  over the route manifest and the build's own stats, throwing `@ultimat3/render`'s
  `X_BUDGET_EXCEEDED`. seo is tier 1 and cannot see a build's bytes, so it was never the package
  that could answer. `errors.test.ts` pins the code set, so re-adding one is a failing test.
- **A length bound with no enforcer does not ship.** `DESCRIPTION_MIN_LENGTH` (50) sat in
  `meta.ts` under the comment "validate.ts enforces it", was re-exported from `index.ts`, and no
  validator anywhere read it — a 10-character description passed the gate the constant claimed to
  fail. Deleted `As of 2026-08`, comment included; `validateMeta` enforces maxima only. Adding a
  minimum back means adding the check AND a new `X_SEO_*` code in the same change.
  `meta.test.ts` pins the exported `*_LENGTH` set, so a bound with no enforcer is a failing test.
- **The `<img src>` fallback is the LARGEST usable width, chosen with `Math.max`.**
  `usableWidths` preserves the CALLER's order, so `widths[widths.length - 1]` was the largest only
  because `DEFAULT_WIDTHS` happens to ascend — `widths: [1200, 640]` handed every browser without
  `srcset` support the 640 variant of a 1200-wide image. Never re-derive it from position, and
  never sort inside `usableWidths`: the `srcset` order is the caller's to choose.
- **`x-default` names a URL the sitemap CONTAINS, or it is not emitted.** `buildSitemap` pushed
  the unprefixed `path` for every route with `locales` set — and with no `defaultLocale`,
  `localize` prefixes every locale, so the whole hreflang cluster pointed at a URL the sitemap
  never lists. A dangling `x-default` is the shape a search engine drops the entire cluster for,
  which costs the alternates that WERE right. `defaultLocaleUrl` answers `undefined` unless the
  default locale's own URL is among the ones this route emits — the same explicit-fallback shape
  `meta.ts`'s `hreflangSet` takes. Never re-derive it from `path`.
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
- **`applyTitleTemplate` is TOTAL; `validateMeta` is where a broken template is refused.**
  `'Ultimate'.replace('%s', title)` on a template with no slot is a no-op that returned the BRAND,
  so every route's `<title>` became the brand and the page's own title was discarded — visible only
  as a duplicate-title issue, weeks later. The renderer runs per request, so it falls back to the
  title rather than throwing; the refusal is `titleTemplateSlotMissing`, `X_SEO_META_MISSING`,
  naming the file. Same split as every other check here: the renderer degrades, the gate refuses.
- **Head tags are CONSTRUCTED here and serialised nowhere here.** `renderMeta` returns data;
  `HeadTag.text` is raw, and `@ultimat3/render`'s `renderHead` picks the escape from the element
  (raw text for code, the total `\uXXXX` JSON rule for a `type` ending in `json`). `meta.ts` had a
  `renderHeadTags` that emitted HTML with a weaker escape — `</` neutralised, `<!--<script>` not —
  and **nothing called it**; deleted `As of 2026-08`. Never add it back, and never escape `text`
  at construction: it would double-escape at tier 4, and the two rules would drift apart. seo
  cannot import render's escapers either — seo is tier 1, render is tier 4. `xml.ts` stays the
  package's one escaper for the XML and attribute surfaces it really does emit (sitemap, feeds,
  robots, `<picture>`), whose rules are the opposite of a raw-text element's.
- **One producer of the JSON-LD tags, and it is `renderMeta`.** `ld.*` builds nodes; `renderMeta`
  emits `meta.ld` as one `<script type="application/ld+json">` **per node**. `ld.ts` also carried a
  `renderLd(nodes)` that collapsed the same nodes into ONE script with a `@graph` — a second
  serialisation of one input, exported, callerless, and the reason `@ultimat3/render`'s
  `head-seo.ts` had to write down that it binds no `renderLd` half on purpose. Deleted
  `As of 2026-08`. Never add it back: an app that found it on the public surface and called it from
  `meta` emitted its graph twice, which is exactly the duplicate that comment was defending against.
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
