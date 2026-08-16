# 01 — Bugs: tiers 0–1

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 0–1.

Fix in severity order. Every new failure mode gets a registered `X_*` code with a runnable `fix:`
(pattern: `packages/db/src/errors.ts:11-44`), a row in `wiki/Error-Codes.md`, then `bun run manifest`.

Findings proven empirically with `bun -e` against workspace source unless marked CONFIDENCE: low.

## Critical

- `packages/money/src/convert.ts:72` — `convert()` derives the decimal shift from
  `exponentOf(amount.currency)` instead of `moneyScale(amount)`, then drops the scale at `:80`. Any
  `Money` carrying an explicit `scale` (the sub-cent AI-cost case `MoneyValue.scale` exists for)
  converts wrong by `10 ** (scale - exponent)`. Proven: `convert(money(2,'USD',6), 'EUR', {rate:1})`
  → `{minor:2,currency:'EUR'}` = €0.02, a 10,000× overstatement; unscaled values convert correctly,
  so only the scaled path bites. Violates the package's own rule in `packages/money/CLAUDE.md`
  ("never `exponentOf(amount.currency)` for a value's own precision — that is `moneyScale(amount)`").
  Fix: `const exponent = exponentOf(target) - moneyScale(amount)`, return
  `money(converted, target, amount.scale)`. Follow `packages/money/src/arithmetic.ts:22-30` (`add`),
  which already does `commonScale`/`minorAt` then re-attaches the scale.

## High

- `packages/core/src/logger.ts:135` — `emit()` ends in a bare `JSON.stringify(line)` and
  `serialiseValue` (`:86-101`) walks arbitrary values with `Object.entries`, so a `bigint` field or
  an object with a throwing getter makes **the logger itself throw**. Proven both ways. Two
  framework call sites feed it caught values: `packages/core/src/lifecycle.ts:230`
  (`log.error('shutdown hook failed', { error: thrown })`) — a throw there escapes `runPhase`'s
  catch, rejects `drainPromise`, and `installSignalHandlers`' `void drain(signal).then(…)` (`:281`)
  never reaches `process.exit(0)`, so **SIGTERM hangs**; and `lifecycle.ts:147` (`readiness check
  threw`) — a throw there takes `/readyz` with it. Fix: render inside `serialiseValue` via
  `renderCauseValue` / `renderThrowable` (`packages/core/src/error-render.ts`), as
  `renderMetaRecord` (`error-render.ts:184-191`) already does for `UltimateError.meta`; wrap the
  final `JSON.stringify` so a log line can never replace the event it describes.

- `packages/time/src/zones.ts:141` and `packages/time/src/format.ts:166` — the `Intl` formatter
  caches are unbounded `Map`s keyed on the **raw, unnormalized** zone/locale string, and
  `isValidTimeZone` (`zones.ts:38-46`) accepts every casing of an IANA name. `x-timezone:
  eUrOpE/bErLiN` passes `resolveTimeZone` (`packages/time/src/context.ts:52-63`) and
  `packages/http/src/locale.ts:118-124` unchanged, so each casing mints a permanent
  `Intl.DateTimeFormat`. Proven: 4,096 case-variants of `Europe/Berlin` grow the heap **44.3 MB**
  (~11 KB each); a 13-letter zone gives 2^12 variants across ~600 zones — unbounded memory keyed on
  a request header. `packages/time/src/cron-describe.ts:126-144` documents this exact hazard and
  bounds itself at `MAX_CACHED_LOCALES = 32`. Fix: reuse that bounded-FIFO `formatterFor` in both
  sites, and canonicalize in `isValidTimeZone`/`resolveTimeZone` via
  `new Intl.DateTimeFormat('en',{timeZone:z}).resolvedOptions().timeZone` so one zone is one key.

- `packages/cache/src/graph.ts:79-82` — `dependentsOf` expands a *row* tag to its collection but
  never expands a *collection* tag to its rows, so busting `tag.post` misses every dependent
  registered under `tag('post', id)`. Proven: `dependentsOfKind([{entity:'post'}],'isr-route')`
  returns only `['/posts']` while `LruCache.invalidateTags([{entity:'post'}])` returns both keys
  (`lru.ts:172-175` walks `entityIndex`; `redis.ts:178-179` puts every row key in the collection
  bucket). Consequence: `invalidateTags([tag.post])` clears the cached detail page in every tier but
  never revalidates its ISR route, never purges its `cdn-path`, never refreshes its `live-query` —
  and the report shows the bust as clean. Contradicts `tags.ts:73-77`'s deliberately symmetric
  `tagMatches`. Fix: keep a `byEntity` index in `link()`/`unregisterDependent()` and, when
  `value.id === undefined`, collect every wire key whose entity matches — mirroring `entityIndex`.

## Medium

- `packages/core/src/telemetry.ts:217` — `Span.recordError` reads
  `error instanceof Error ? error.message : String(error)`, so rendering the error can throw and
  **replace the caller's real failure**. Proven: a `Proxy` with a throwing `getPrototypeOf` trap
  rethrows `TypeError: proxy trap` instead of `real failure`. `withSpan` wraps `cache.invalidate`,
  `db.<verb>` and every HTTP/job span. Forbidden by `packages/core/CLAUDE.md`'s own rule table.
  Fix: `renderThrowable(error)` (`error-render.ts:89`). The same unsafe read is live at five more
  sites the earlier conversion missed: `error-reporter.ts:183`, `:203` (breaking that function's
  documented "never throws"), `otlp.ts:211`, `error-reporter-sentry.ts:167`, and `assert.ts:18`
  (`JSON.stringify(value)` throws on a bigint before `X_UNREACHABLE` is built).

- `packages/seo/src/meta.ts:99` — `applyTitleTemplate` tests `template.includes(title)` where the
  doc comment at `:67` says "Applied unless the title already contains the brand" — the containment
  is inverted. `applyTitleTemplate('About Ultimate', '%s — Ultimate')` → `'About Ultimate —
  Ultimate'`, and `validate.ts:64-73` then measures the duplicated string against
  `TITLE_MAX_LENGTH`. `meta.test.ts:40-41` pins only the exact-equality case. Fix: derive the brand
  (`template.replace('%s','').trim()`) and test `title.includes(brand)`.

## Low

- `packages/seo/src/xml.ts:38` — `absoluteUrl` ends in `.replace(/\/$/, '')`, so a path that
  legitimately ends in `/` loses it: `absoluteUrl('https://x.com','/blog/')` → `.../blog`. `/blog/`
  and `/blog` are different resources, and this builds every `<loc>` (`sitemap.ts:103`) and every
  canonical (`meta.ts:137`), so trailing-slash sites emit URLs that redirect. Fix: strip only when
  `path` is `/` — the `|| baseUrl` branch already covers that.

- `packages/db/src/branch.ts:118` — `dropBranch` returns `affected >= 0` and `DbClient.execute`
  returns a non-negative count by construction (`client.ts:191-195`), so the function is a constant
  `true`; dropping a branch that never existed reports success. Fix: check existence before the
  drop, or return `void` so no caller reads a verdict that is not there.

- `packages/storage/src/upload-client.ts:73` — `input.signal?.addEventListener('abort', …)` is never
  removed and never checks `signal.aborted`, so a reused `AbortSignal` accumulates one listener per
  call and an already-aborted signal uploads the whole body anyway (per spec, adding an `abort`
  listener to an aborted signal does not fire it). Fix: early-reject on `signal.aborted`; pass
  `{ once: true }` / remove the listener in the `load`/`error` handlers.

- `packages/storage/src/driver-local.ts:83-86` — `isStringRecord` accepts an array
  (`typeof [] === 'object'`, `Object.values(['a']).every(isString)` is `true`), so a sidecar holding
  `"metadata": ["a","b"]` is handed back through `head()`/`get()` as object metadata. Fix: add
  `&& !Array.isArray(value)`, matching `isPlainObject` (`packages/schema/src/builder.ts:46`).

- `packages/schema/src/coerce.ts:52-58` — the `record` branch builds `const out = {}` and assigns
  `out[key]`, so `out['__proto__'] = value` hits the `Object.prototype` setter and the key vanishes
  instead of reaching validation. `recordSchema`'s deliberate refusal of `__proto__`
  (`validators.ts:238,252-257`) is therefore silently skipped on the HTTP query path — reported as
  absent rather than rejected. Nothing is globally polluted. Fix: `Object.create(null)`, as
  `validators.ts:250` already does.

- `packages/db/src/errors.ts:159` — `SQLSTATE_FIXES[code].replace('{constraint}', constraint ?? …)`
  expands `$&`, `` $` ``, `$'`, `$$` inside a constraint name, so the `fix:` line names a constraint
  that does not exist. CONFIDENCE: low on exploitability (constraint names are schema-authored).
  Fix: pass a function — `.replace('{constraint}', () => constraint ?? UNNAMED_CONSTRAINT)`.

- `packages/core/src/env.ts:220` — a **non-secret** variable failing validation has its raw value
  interpolated verbatim into `X_ENV_MISSING`'s cause (`${issue.key}="${issue.received ?? ''}"`), so
  a malformed `DATABASE_URL` (not `secret: true` in the scaffold) writes its password to the boot
  log. `describe-value.ts`'s header states this rule for the schema layer. CONFIDENCE: low —
  operator-supplied, boot-time, and `x env check` deliberately prints it. Fix: render
  `issue.received` through `describeValue` in the thrown cause; leave `EnvCheckReport.issues` intact.

## Docs

- `packages/db/CLAUDE.md` — claims `errors.ts` guards `registerErrorCodes` with `hasErrorCode`.
  `errors.ts:66-68` registers unconditionally and its comment says that is deliberate; `entity`
  borrows `X_DB_DRIFT` rather than registering it (`packages/entity/src/errors.ts:28`). The code is
  right, the doc is stale — delete the sentence.

## Tests

- Failing-first test per finding, next to source. Key ones: `convert()` on a scaled `Money`
  (`bun test packages/money/src/convert.test.ts`); `log.info('x', {total: 10n})` does not throw and
  a shutdown hook throwing a hostile value still reaches `process.exit(0)`; 4,096 zone casings hold
  the formatter cache at its cap; `dependentsOfKind` on a collection tag returns row dependents;
  `withSpan` rethrows the original value for a hostile throwable; `applyTitleTemplate('About
  Ultimate', '%s — Ultimate')` does not duplicate the brand.
- `packages/time/src/zones.test.ts` needs the canonicalization case (`eUrOpE/bErLiN` → one key).

## Done when

- Every Critical/High/Medium fixed with a failing-first test; Low items fixed or carrying a
  `wiki/Known-Gaps.md` row.
- New codes registered + documented + `bun run manifest`; `bun run verify` green.
