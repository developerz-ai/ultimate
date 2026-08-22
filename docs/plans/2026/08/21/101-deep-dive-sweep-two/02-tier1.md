# 02 — Tier 1: i18n, money, cache, seo

> Part of [`overview.md`](overview.md). Depends on: none (01 only for `renderThrowable`, already exported). Tier: 1.

## Files to change
- `packages/i18n/src/interpolate.ts:109` (`rulesCache`) and `packages/i18n/src/context.ts:161` (`translators`) — unbounded module-level maps keyed on the raw locale string. `context.ts:670-674` describes this exact leak and fixed only `currentLocale()`; `translatorFor`, `pluralCategory`, `createTranslator` are exported raw and `packages/mail/src/render.ts:51` passes an unnormalised value. **Proven**: 5,000 distinct valid tags → +79.9 MB retained.
- `packages/money/src/errors.ts:76-81` — `moneyNotInteger`'s `fix:` is `fromDecimal('12.345', 'USD')`, which throws the same code; for `1e21` it reads `fromDecimal('1e+21', …)`, which `DECIMAL` refuses. **Proven.** `errors.ts:209-213` already names this anti-pattern and `decimalTooPrecise` (`:96-113`) is the fixed shape.
- `packages/money/src/currency.ts:21,93,155` — the 53 shipped rows and `CURRENCIES` are mutable; `registerCurrency` freezes its rows (`:145`). `currencyInfo('USD').exponent = 3` silently rescales every USD amount.
- `packages/cache/src/purge-http.ts:155` — `error instanceof Error ? error.message : …` on a value from an injected `fetch`; `packages/cache/CLAUDE.md` forbids it and `tier-failures.ts:559` / `invalidate.ts:384` use `renderThrowable`.
- `packages/cache/src/tiers.ts:276-278` — the single-flight leader reads `shared()` once before `fill()`; a joiner arriving during the fill merges tags nothing reads again, so the landed entry misses the joiner's tags and `invalidateTags` never reaches it. Unreachable through `packages/query/src/cache.ts:113` (tags are in the key); bites a direct `createCacheStack` caller.
- `packages/cache/src/tiers.ts:258` — `lookup()` runs outside `flight.run`; N concurrent misses each walk every tier. Carried Low.
- `packages/seo/src/sitemap.ts:75` — `locales` without `defaultLocale` emits prefixed `<loc>`s and an `x-default` pointing at the unprefixed path the sitemap never lists. Mirror `packages/seo/src/meta.ts:152-161` (`hreflangSet` takes an explicit fallback).

## Steps
1. i18n: route both caches through `@ultimat3/core`'s `intl-cache.ts:11-25` (`cachedFormatter`, bounded at `MAX_CACHED_FORMATTERS`) keyed on `canonicalLocale(locale) ?? locale` — the shape `packages/money/src/format.ts:471-472` and `packages/time/src/zones.ts:156-157` already use. Put the bound at the cache, not at one caller.
2. money `moneyNotInteger`: when the fraction digits exceed the currency exponent emit `fromDecimal('<v>', '<ccy>', { rounding: 'half-up' })`; when they fit, `{ scale: <digits> }`; when the spelling is not a plain decimal (`1e21`, non-finite), drop the `fromDecimal` offer and name `money(Math.round(…))` or the integer the caller meant.
3. money `currency.ts`: `Object.freeze` each `TABLE` row and the exported array at declaration. `bun run frozen-records` must stay green — use the `Object.freeze<…>({…})` form it accepts.
4. cache `purge-http.ts`: `renderThrowable(error)`.
5. cache `tiers.ts`: re-read `shared()` and `fence.cover` immediately before each `tier.set` inside `fill` (the fence is already re-asked per rung at `:198`), or clear the flight entry when `load()` settles rather than when the fill does. Leave `:258` as a documented Low unless measured.
6. seo `sitemap.ts`: emit `x-default` only when `defaultLocale` (or an explicit `xDefault`) names a URL the sitemap contains.

## Tests
- `packages/i18n/src/context.test.ts` — 1,000 distinct tags through `translatorFor`; map size stops at `MAX_CACHED_FORMATTERS`; `'en-us'` and `'en-US'` share one entry.
- `packages/money/src/errors.test.ts` — for `12.345`, `1e21`, `0.1 + 0.2`: execute the emitted `fix:` line via the package's own exports and assert it does not throw.
- `packages/money/src/currency.test.ts` — assigning `currencyInfo('USD').exponent` throws in strict mode; `Object.isFrozen(CURRENCIES)`.
- `packages/cache/src/purge-http.test.ts` — a `fetch` rejecting a `Proxy` whose `getPrototypeOf` throws still yields `X_CACHE_PURGE_FAILED`.
- `packages/cache/src/tiers.test.ts` — leader with tag `A`, joiner during fill with tag `B`; `invalidateTags(['B'])` evicts.
- `packages/seo/src/sitemap.test.ts` — `locales: ['en','de']`, no `defaultLocale` → no `x-default`; with `defaultLocale: 'en'` → `x-default` equals the `en` `<loc>`.
- Command: `bun test packages/i18n packages/money packages/cache/src/purge-http.test.ts packages/cache/src/tiers.test.ts packages/seo/src/sitemap.test.ts`.

## Done when
- Tests above fail-then-pass; `bun run frozen-records` and `bun run error-render` green; `bun test -t 'formats the fix line'` still green.
