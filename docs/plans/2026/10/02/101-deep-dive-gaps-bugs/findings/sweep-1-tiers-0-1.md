# Sweep 1 — tiers 0–1 correctness
> Re-checked in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) — where it narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `core`, `schema`, `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage`, `flags`.
> CONFIRMED = a `bun -e` probe ran against `packages/<pkg>/src`. PLAUSIBLE = from reading only.
> This hunt did not consult earlier plans — two rows repeat open rows of the 2026-09-28 audit
> (marked **09-28**); they prove those rows are still live at 23.0.0.

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/time/src/cron-occurrence.ts:102` | `nextCronOccurrence` never fires in the repeated hour of a fall-back night; disagrees with `matchesCron` | `*/5 * * * *`, `Europe/Berlin`, from `2026-10-25T00:50Z` → `00:55Z, 02:00Z…`; nothing 01:00Z–02:00Z while `matchesCron(…, 01:30Z)` is `true`. Every interval schedule dark one hour a year | CONFIRMED | when the wall time maps to an instant not after `after` under `overlap: 'first'`, retry with `'second'` | `packages/time/src/cron-occurrence.test.ts` |
| 2 | `packages/cache/src/cdn.ts:131` | CDN tier purges only the literal wire tags — breaks the two-way row/collection rule `tagMatches`, LRU, Redis and memo keep | `invalidateTags([tag('post','1')])` purges `["post:1"]` only — a list keyed `post` stays for its `s-maxage`; `tag('post')` purges `["post"]` only — a detail page keyed `post:1` stays. Report `errors: []` | CONFIRMED (fake `PurgeDriver`) | purge the entity key with every row tag; `cacheHeaders` emits the entity key with every row tag | `packages/cache/src/cdn.test.ts` |
| 3 | `packages/db/src/statement-funnel.ts:40` | `encodeBoundParameters` runs inside the driver `try`; its refusals re-wrap as `X_DB_UNAVAILABLE` | a ragged bound array or `new Date(NaN)` → "cannot reach the database", fix "set DATABASE_URL", driver never called | CONFIRMED | encode before the `try`; refuse an Invalid Date with a coded error | `packages/db/src/statement-funnel.test.ts` |
| 4 | `packages/core/src/retry.ts:77`, `:128` | `policy.attempts` and `timeBudgetMs` never screened | `attempts: NaN` → `attempt >= NaN` always false; the loop never ends (probe had to be killed). `timeBudgetMs: NaN` PLAUSIBLE | CONFIRMED (attempts) | `finiteCount`, as `packages/core/src/backoff.ts:51-54` | `packages/core/src/retry.test.ts` |
| 5 | `packages/schema/src/iso-date.ts:22` (via `validators.ts:393`, `packages/time/src/instant.ts:36`) | ISO shape regex admits impossible days; `new Date` rolls them over | `t.date.parse('2026-02-30')`, `fromIso('2026-02-30')` → `2026-03-02`; `plain-date.ts` refuses the same string | CONFIRMED | check the day against the month (`daysInMonth`, `packages/time/src/plain-date.ts:41-48`) | `packages/schema/src/iso-date.test.ts` |
| 6 | `packages/storage/src/upload.ts:114` | one `ftyp` magic rule labels every ISO-BMFF file `video/mp4` | `validateUpload` of AVIF bytes under `allowedContentTypes: ['image/avif']` → `X_STORAGE_TYPE_REJECTED … magic bytes are video/mp4`; HEIC, MOV, M4A the same | CONFIRMED | read the major brand at offset 8, or treat `video/mp4` as a container as zip is | `packages/storage/src/upload.test.ts` |

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Test |
|---|---|---|---|---|---|
| 7 | `packages/storage/src/driver-local.ts:293` | local disk cannot hold key `a` and key `a/b`; fails with a bare filesystem `Error` (**09-28**) | `put('a')`, `put('a/b')` → bare `ENOTDIR`; reverse → `EISDIR`. Memory and S3 accept both | CONFIRMED | `packages/storage/src/driver-parity.test.ts` |
| 8 | `packages/money/src/format.ts:154` | `trimZeroFraction` uses `minimumFractionDigits: 0` — trims every trailing zero (**09-28**) | `formatMoney(money(1250,'EUR'),'en-US',{trimZeroFraction:true})` → `€12.5`. Fix: `trailingZeroDisplay: 'stripIfInteger'` | CONFIRMED | `packages/money/src/format.test.ts` (`:41` covers whole amounts only) |
| 9 | `packages/time/src/business.ts:65` | `addBusinessDays` chains `addDaysInZone` a day at a time; a spring-forward day shifts the wall clock for good | Fri 2026-03-27 02:30 Berlin + 1 business day → Mon 03:30; `addDaysInZone(fri, 3)` gives 02:30 | CONFIRMED | `packages/time/src/business.test.ts` |
| 10 | `packages/db/src/transaction.ts:353` | nested `withTransaction` silently ignores `client`, `isolation`, `readOnly`, `deferrable`; only `retry` is refused (`:348`) | inside a tx on A, `withTransaction(fn, { client: B, isolation: 'serializable', readOnly: true })` → A records a savepoint, B nothing | CONFIRMED | `packages/db/src/transaction.test.ts` |
| 11 | `packages/seo/src/images.ts:172` | `responsiveImage` mints a URL its own reader refuses | `width: 10000` → `?w=10000`; `parseImageQuery` → `X_IMAGE_QUERY_INVALID … 8192 or less`. Fix: clamp `usableWidths` at `MAX_IMAGE_WIDTH` | CONFIRMED | `packages/seo/src/images.test.ts` |
| 12 | `packages/seo/src/images.ts:13` | default `FORMAT_ORDER` offers `image/avif` first; the default `builtinImageDriver` refuses AVIF (`packages/cli/src/runtime-assets.ts:115` passes the refusal through) | an AVIF-capable browser picks `f=avif`, gets an error, does not fall back | PLAUSIBLE, low on reachability | `packages/seo/src/images.test.ts` |
| 13 | `packages/cache/src/tiers.ts:300`, `lru.ts:138` | `stack.write` leaves the previous value in a tier whose `set` refuses | LRU `maxBytes: 100`; `write('k','old')`; `write('k', 500 bytes)` → `read('k')` is `'old'`. Fix: `del` on a refused `set` in `fill` | CONFIRMED | `packages/cache/src/tiers.test.ts` |
| 14 | `packages/storage/src/image.ts:76`, `:91` | `variantKey` drops the source extension; width / height unscreened | `p/hero.png` and `p/hero.jpg` → `p/hero@w100.webp`; `{width:NaN}` → `a@wNaN.webp` | CONFIRMED | `packages/storage/src/image.test.ts` |
| 15 | `packages/db/src/sqlstate.ts:35` | `SQLSTATE_SHAPE` `^[0-9A-Z]{5}$` matches five-letter errno codes | `code: 'EPIPE'` → `X_DB_STATEMENT_FAILED` ("fix the SQL"); no replica fallback (`replica-client.ts:45-55`, reading). Fix: require a digit | CONFIRMED (shape); low that Bun.SQL surfaces them | `packages/db/src/sqlstate.test.ts` |
| 16 | `packages/schema/src/coerce.ts:89`, `:81`, `:115`, `:15` | `coerceNode` invents data, against its header | `coerceInput(t.object({a: t.number.optional()}), ['x'])` then `safeParse` passes as `{}`; `t.union(t.literal('auto'), t.literal(2))` with `"2"` matches nothing (first member decides); `"0x10"` → 16. Object-union by first member PLAUSIBLE | CONFIRMED | `packages/schema/src/coerce.test.ts` |
| 17 | `packages/seo/src/rss.ts:126` | `buildAtom` never emits `channel.author` (RFC 4287 §4.1.1); `icon`, `item.image` JSON-only; item authors missing from RSS; `copyright` missing from Atom | `buildFeed({ author: {name:'Ada'}, … })` → Atom with no `<author>` | CONFIRMED (author) | `packages/seo/src/rss.test.ts` |
| 18 | `packages/flags/src/flag.ts:127` | expiry screen restates two of three ISO patterns; non-ISO strings parse at host-local midnight | `expiresAt: 'December 1, 2026'` → instant differs per pod `TZ`; `2026-02-30` rolls over. Fix: `isIsoDateTime` (`packages/core/src/iso-date.ts`) | CONFIRMED | `packages/flags/src/flag.test.ts` |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/i18n/src/define-catalogs.ts:54` | catalogs registered before `configureLocales` validates tags — `X_LOCALE_INVALID` thrown, `registeredLocales()` already holds the bad tag | CONFIRMED |
| `packages/core/src/sampler.ts:142` | `parentbased_always_on` shares the ratio branch — a leftover `OTEL_TRACES_SAMPLER_ARG=0.1` samples ~10% of roots | CONFIRMED |
| `packages/storage/src/signed-url.ts:186` | `verifySignedUrl` compares `url.pathname` with the whole `baseUrl` — an absolute `baseUrl` always verifies `malformed` | CONFIRMED |
| `packages/storage/src/path.ts:115` | `isWithinOrg(key, '')` throws instead of `false`; `accept.ts:120` works around it, `attachment.ts:111,139` do not | CONFIRMED |
| `packages/storage/src/image.ts:149` | `fitDimensions({1000×1},{width:100})` → height 0; `contain` with both dimensions upscales | CONFIRMED |
| `packages/money/src/allocate.ts:22`, `format.ts:127` | `allocate(m, 1e10)`, `fractionDigits: 200` throw a bare `RangeError` | CONFIRMED |
| `packages/time/src/zoned.ts:172` | `addDaysInZone(at, NaN)` bare `RangeError`; `0.5` moves nothing | CONFIRMED |
| `packages/time/src/cron-parse.ts:195`, `:180` | `isValidCron` accepts `0 0 1-5-7 * *`, `0 0 1/2/3 * *`, `0 0 * marzipan *` | CONFIRMED |
| `packages/time/src/format.ts:130` | `formatRelative` truncates — 47 h, two calendar days ahead, reads "tomorrow" | CONFIRMED |
| `packages/time/src/duration.ts:155` | `formatDuration(NaN,'en')` → `"NaN days NaN hr"` | CONFIRMED |
| `packages/time/src/plain-date.ts:128` | `addPlainDays('9999-12-31', 1)` → `'10000-01-01'` branded `PlainDate`, rejected by `isPlainDate` | CONFIRMED |
| `packages/cache/src/lru.ts:53` | `estimateBytes` counts a `Map` / `Set` as 2 bytes | CONFIRMED |
| `packages/seo/src/meta.ts:162` | brand containment is a substring test: `'Ultimately fast'` skips `'%s — Ultimate'` | CONFIRMED |
| `packages/seo/README.md:99` | says the builtin driver refuses webp; `packages/core/src/image/pipeline.ts:22-24` encodes it | reading |
| `packages/core/src/nearest-name.ts:27` | fixed 3-edit cutoff regardless of length: `nearestName('a',['db','gen'])` → `'db'` | CONFIRMED |
| `packages/storage/src/grant.ts:91` | refusal names `createUploadGrant`; the export is `grantUpload` | low confidence |
| `packages/storage/src/driver-s3.ts:161` | missing `lastModified` → epoch 0, read by `sweepOrphans` as old enough to delete | PLAUSIBLE, low |
| `packages/db/src/array-parameter.ts:37` | a `Uint8Array` element in a bound array renders as `"1,2,3"` | PLAUSIBLE |

## Gaps

- `packages/core/src/flight-gate.ts:68` — `maxConcurrent` / `maxQueued` unscreened; `NaN` or `0` queues forever.
- `packages/flags/src/runtime.ts:46` — `reportEveryMs` unscreened.
- `packages/core/src/logger.ts:305` — unknown `LOG_LEVEL` falls back to `info` silently; `createLogger({level})` refuses the same value.
- `packages/i18n/src/locales.ts:123` — `en;q=abc` keeps quality 1.
- `packages/db/src/generate.ts` — a changed `primaryKey` on an existing table emits no statement while the snapshot records it. PLAUSIBLE, not probed.
- `packages/cache/src/redis.ts` — values round-trip through JSON (`Date` → string, `Map` → `{}`); the LRU returns the same object. No README statement of the serialisable-value contract.

## Not a bug (do not re-open)

- Money rounding, `factorFraction`, allocation, `convert`, `-0`, `fromDecimal`.
- `fromZonedDetailed` gap / overlap search, including a skipped day.
- Cron wrap ranges and the 30-Feb refusal; day-of-month / day-of-week OR rule (argued in code).
- `canonicalJson` folding `[undefined]` onto `[null]`.
- Redis tag buckets, row-vs-collection bust, fence generation, LRU index maintenance.
- `statementsOf` / `noiseAt`; `isPlainRead`.
- Migration ordering, checksum audit, advisory-lock pinning, FK and drop order in `generateMigration`.
- `defaultClient()` without `close` / `listen` — `packages/cli/src/runtime-replica.ts` wires its own.
- `safeUrl` stripping every character ≤ 0x20.
- NOT NULL column add emitted nullable with a `-- backfill` note — argued design.

## Not read — handed to sweep 2

| Package | Files |
|---|---|
| `db` (~55% unread) | `drift*`, `introspect*`, `catalog*`, `schema-dump*`, `schema-load`, `snapshot-*`, `branch`, `pglite-branch`, `pglite-snapshot`, `pglite-extensions`, `readonly-role`, `retype-*`, `dependent-view`, `invariant-ddl`, `unrendered`, `replica-identity`, `replica-scope`, `listen`, `observe`, `pool-gauge` |
| `core` (~65% unread) | `config*`, `context`, `lifecycle*`, `telemetry`, `otlp*`, `secrets*`, `client-*`, `errors`, `error-reporter*`, `registrar`, `process-metrics`, `runtime-metrics`, `record-sink`, rest of `image/`, `exports/` |
| `schema` | `node`, `provider`, `standard`, `t`, `errors` |
| others | `i18n/framework.ts`, `seo/routes.ts`, `seo/locale-tags.ts`, `storage/driver-s3-region.ts` |
