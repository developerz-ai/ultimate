# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Pin `@ultimat3/*` exactly; a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers.

## [Unreleased]

One sweep, in tier order, against a single defect class: **a numeric bound whose own non-finite
value makes its guard read false.** `??` guards *nullish*, and `NaN` is not nullish — so
`Number(process.env.X)` on an unset variable, a `parseInt` of a typo and an untyped config value all
walk past the default and land on the bound intact. `Math.max`, `Math.min` and `Math.floor` are not
validators either: all three **propagate** `NaN`, and this repo was relying on all three as guards.

| Shape | What actually happens |
|---|---|
| `value > limit` | false for **every** input — the limit stops being enforced rather than enforced wrongly |
| `Array.from({ length: NaN })`, `slice(0, NaN)` | `[]` — zero workers spawned, reported as success |
| `setTimeout(fn, NaN)` | `setTimeout(fn, 0)` — a poll becomes a spin |
| `while (n < limit)` | never terminates, synchronously, past every `AbortSignal` |

### Added

- **`finiteOption()` and `finiteCount()` in `@ultimat3/core`**, at tier 0, so every tier above
  reaches one check. Four private copies had grown before they were collapsed — `jobs`, `realtime`,
  `query`, and `@ultimat3/storage`'s `assertFiniteSignedUrlBound`, deleted after confirming
  `finiteCount`'s predicate is byte-identical to it, so no tier-0 widening was needed.
- **`bun run finite-bounds`** — a step of the gate's `unit` check, standalone. Every `a.b ?? <number>`
  in `packages/*/src` needs a finite check on the same value, or a pinned count. It ships **with**
  the sweep and not after it, because three files documented it before it existed and a doc
  promising a command that does not exist is what axiom 3 forbids. A ratchet: 129 sites across 19
  packages on day one, falling as each slice lands, and `X_FINITE_BOUND_PIN_STALE` fires the moment
  a slice repairs a package and leaves its row behind.

  It matches on the **shape** and has been widened twice by defects that walked past it, both on
  2026-08-26: an optional chain on the *object* (`options?.ttlMs ?? C`, which is
  `auth/src/oauth-cookie.ts`'s handshake TTL) and a default read out of a **table** of numbers
  (`?? DEFAULT_VERIFICATION_TTL_MS[input.purpose]`, `auth/src/verify.ts`). Each sat behind a green
  ratchet and a `CLAUDE.md` sentence claiming that package's numbers were screened.
- **`X_CACHE_LIMIT_INVALID`** — a tier's ceiling, duration or similarity floor refused at
  **construction** rather than on the first write.
- **`X_TRUST_PROXY_UNSET`** and `assertClaimBounds` (`@ultimat3/jobs`), exported.
- **No shipped code changed.** This sweep adds codes and removes none.

### Changed

- **BREAKING — every numeric option below refuses a value it used to accept.** The accepted domain
  narrows to *finite*, and in most cases to *whole* and *non-negative*; the refusal is at the option
  boundary, with a `fix:` naming the option and its domain. An app passing a real number is
  unaffected. An app that was passing `NaN` was not working — the bound it declared was not being
  enforced, and nothing said so.

  | Package | Options |
  |---|---|
  | `@ultimat3/http` | `port` (`0…65535`, whole), `bodyLimitBytes`, `requestTimeoutMs`, `maxInflight`, `drainTimeoutMs` (whole, `≥ 0`; `null` still declines the drain), `memoryRateLimitStore({ maxKeys })` (`≥ 1`), `verifyWebhookSignature({ maxBytes })` (`≥ 1`) |
  | `@ultimat3/query` | `search()`'s `page.max`, `page.default`, `termMax`; `cache.ttlMs` |
  | `@ultimat3/jobs` | `createLimiter`'s five options; `JobDriver.claim`, `introspect.list` and `deadLetters` limits |
  | `@ultimat3/realtime` | `maxPerTenant`, `maxReconnectAttempts`, `maxPerSocket` and four socket ceilings — the five now refused at **boot** rather than per-frame; `createMemoryEventBus` / `createPgEventBus` `defaultTtl` |
  | `@ultimat3/auth` | `HandshakeSealOptions.ttlMs`, `IssueVerificationInput.ttlMs`, `SessionCookieOptions.maxAgeSeconds` (negatives and fractions newly refused), `KdfLimits.maxConcurrent` and `maxQueued` |
  | `@ultimat3/ai` | `llm`/`agent`/`defineEval`/`llmJudge`/`gateway` `maxTokens`, `agent` `maxTurns` and `maxToolResultChars`, `createGateway` `retry.attempts`, `RemoteEmbedder` `batchSize`/`timeoutMs`/`dimension`, `HashEmbedder.dimension`, `embedBatched` size, `registerModel` `contextWindow`/`maxOutput` (whole ≥ 1); `budget.tokensIn`/`tokensPerRun`, `BudgetLimits`, `hive` `concurrency`/`minMembers`, `retrieve` k, `assembleContext` `maxTokens`, vector `k`/`candidates`, `registerModel` `cacheMinimumTokens` and both prices' `minor` (whole ≥ 0); `chunk` `size`/`overlap`, `k1`, `b`, `rrfK` (finite, fractions still allowed) |
  | `@ultimat3/render` | `renderSsr` and `streamResult` `status` (whole, 200–599), `holeTimeoutMs`, `render-isr` `maxEntries`, `themeScript` `maxBytes`, `registerRoute` `suspenseBoundaries` |
  | `@ultimat3/pwa` | `minEngagementMs`, `warnBytes`, each precache entry's own `bytes`, `retentionPlan` `keep` |
  | `@ultimat3/mail` | `driver-resend` and `driver-smtp` `timeoutMs` (whole ≥ 1 — both hand the value straight to `AbortSignal.timeout`, so `0` aborts on the next tick and is not "no deadline") |
  | `@ultimat3/manifest` | `checkAgentsMd` `maxBytes` |
  | `@ultimat3/mcp` | `serveStdio` `lineLimitBytes` (whole ≥ 1), `mcpHttpRoute` `bodyLimitBytes` (now refused at **construction**, not on the first request), `capQueryRows` `maxRows`/`maxBytes` |
  | `@ultimat3/notify` | `createMemoryDeliveryLedger` `max`, `InboxQuery.limit` (both drivers), `notifier` `maxRecipients`, `deliver[].wait` and `deliver[].digest.window` |
  | `@ultimat3/ui` | `DataTable` `skeletonRows`, `Skeleton` `lines`, `filterOptions` limit |

  **What to do:** run your app. Every refusal is at boot or at the call boundary, so one `bun test`
  or one `x verify` surfaces all of them at once and the `fix:` line carries the edit.
- **BREAKING — `http.trustedProxyHops` accepts `1…64`.** `0` was the failure state, not a setting:
  `forwarded.ts` returns `undefined` for `hops < 1`, so a declared `0` silently trusted nothing while
  reading as a configured value. It is a boot-owned key, so no app can write it; the blast radius is
  embedders calling `defineHttpConfig` directly. The unreachable `?? 0` beside it is removed rather
  than left as a dead line that reads as a live default.
- **BREAKING — `search().page(input, { first })` serves a window narrower than the read.** It was
  briefly refused outright during this sweep, which was wrong in the one direction that matters: the
  framework's own defaults collide — `limit` defaults to `20` and `first` has no default — so
  `search({…})` + `.page(input, { first: 10 })` was a 500 on page **one** with nothing misdeclared.
  A screen that fires on its own defaults is not a screen. The refusal now fires only when rows
  would actually be **cut**, and names both edits; when the page fits, `hasNextPage` is false by
  construction, so no cursor is minted that a second call is guaranteed to throw on.

### Fixed

- **`X_LOCALE_INVALID` was answering 500.** It sat in the never-reaches-a-request backlog on the
  strength of the http `locale` stage never throwing — true of that stage, irrelevant to `?locale=`,
  a path segment, or an action input reaching `formatDate` / `formatMoney` / `describeCron`. Those
  paged the on-call for a string the caller typed. It is `400` now, beside its sibling.
- **`pick` / `omit` returned a schema validating nothing.** `packages/schema/src/validators.ts`
  built the rebuilt shape on a plain `{}`, so a schema declaring a `__proto__` field returned **zero
  properties** — publishing nothing and dropping the field from `parse()` output. Found while
  verifying an unrelated finding; `bun run proto-index` cannot see it, because it is a computed
  **write** rather than a read.
- **`packages/db/src/client.ts` split 510 → 263 lines** across five files. 213 public exports
  before, 213 after, checked against the pre-existing `dist/index.d.ts`.
- **A JSDoc block that had drifted onto the next symbol** in `packages/http/src/rate-limit.ts`, and
  two stacked blocks in `packages/http/src/config.ts` whose rationale was dead text.
- **A `NaN` token estimate did not bypass the AI budget — it POISONED it.** `@ultimat3/ai`'s
  gateway used the pre-flight estimate as its ceiling check and then wrote it onto both the ledger
  and the per-process `BudgetStore`. Measured: a `NaN` estimate passed a 1,000-token ceiling, and
  every later call was then compared against a poisoned total, so a **5,000,000-token call passed
  the same ceiling**. Screened at the seam every model call crosses, and at each declaration under
  the key name the declaration itself uses — a bound reported under the framework's internal name
  sends the reader to a key their app never wrote.
- **`chunk({ size })` and `embedBatched` were a synchronous infinite loop**, past every
  `AbortSignal`, past the job timeout, on the worker's only thread. Both are now pinned by tests
  that HANG when the screen is removed — the runner has to be killed, which is the honest shape of
  that assertion.
- **An ISR page with a non-finite TTL was never fresh, so it regenerated on EVERY request.**
  `render-isr`'s freshness test is `now - generatedAt < ttlMs`, false for a `NaN` ttl, and the entry
  comes from a **pluggable** `IsrStore`. Silent unbounded origin load, on top of the `s-maxage=NaN`
  it also emitted. Repaired totally rather than by throwing: a ttl that is not positive-finite
  becomes the tag-only `null`, with an `isr.entry_ttl_invalid` warning.
- **`cache-control` emitted `max-age=NaN`**, which is not a shorter age — it is an unparseable
  directive a conforming cache **ignores**, so the response fell back to heuristic caching rather
  than to the declared age. `finiteDeltaSeconds` drops a field that is not RFC-9111 delta-seconds;
  every fallback goes the SHORTER direction, so nothing can lengthen an age the caller did not ask
  for. Total, never a throw — this is the response path. The boot-time half, screening `Route.cache`
  at registration, is issue #373.
- **A `NaN` `precache` entry took down the budget warning for every OTHER entry** — one bad entry
  makes the total `NaN`, and `NaN > warnBytes` is false. Reproduced: an `Infinity` entry printed
  `precache is 0b (over 1b)`.
- **`retentionPlan` evicted every deploy, including the running one**, for a non-finite `keep`:
  `Math.max(1, NaN)` is `NaN` and `slice(0, NaN)` is `[]`.
- **The MCP query cap answered an empty table as a complete answer.** `capQueryRows` with a
  non-finite ceiling gives the agent **zero rows with `truncated: false`**, and switches the 256 KiB
  context guard off entirely.

### Removed

- **`packages/time/src/locale.ts`** — unimported; the eleven hits for `'./locale'` are all
  `packages/http/src/locale.ts`, a different file.
- **`SQL_OUTBOX_TABLE`** from the `@ultimat3/jobs` barrel. It was a byte-for-byte second copy of the
  statements `SQL_JOBS_TABLE` already creates, so `x_outbox` was declared twice and created once.

## 16.0.0 - 2026-08-26

### Added

- **`invariant()` can express a pattern that reaches the database**, and the existing spelling was
  the defect. `c.slug.matches(/re/)` already emitted `slug ~ '…'` — what it did not do was check
  that the two engines READ that string the same way, so `matches(/\bfoo/)` shipped a CHECK that
  compiled cleanly, errored nowhere, and enforced a **backspace**: Postgres reads `\b` as `BACKSPACE`
  and `'foo' ~ '\bfoo'` is FALSE. Nothing is translated — `pattern.source` is the string `.test()`
  runs *and* the string spliced into the constraint — and every construct where the two disagree is
  now **refused at declaration** with the portable spelling in the `fix:`. Measured against a live
  server, one shape at a time: `\b`, `.`, `\w`, `\s`, `\A`/`\Z`, backreferences, named groups,
  inline flags, POSIX classes, a leading `]` in a class, `\x`, and a non-ASCII range endpoint.
- **BREAKING — `c.<col>.matches(/re/)` refuses a construct the two regex engines read differently.**
  It previously accepted any `RegExp` and emitted a maybe-equivalent POSIX pattern, so
  `matches(/\bfoo/)` shipped a CHECK that compiled cleanly, errored nowhere, and enforced a
  BACKSPACE. A pattern outside the portable subset now throws `X_INVARIANT_VIOLATED` at `entity()`
  time, naming the construct, its index, both readings, and either the portable spelling or the
  app-only predicate form.

  **What to do:** run your entities. Every refusal is at declaration, so a `bun test` or a `x db
  gen` surfaces all of them at once; the `fix:` line carries the edit. An app whose patterns are
  already inside the subset compiles and emits exactly what it emitted before. Apps that were
  refused were not working — they had two rules under one name and no way to notice.
- **`iff(a, b)`, `isNull()` and `isNotNull()`** — the vocabulary a cross-column coherence rule
  needed. `iff(c.status.eq('published'), c.publishedAt.isNotNull())` renders
  `(status = 'published') = (published_at is not null)`.

  `=` and deliberately **not** `IS NOT DISTINCT FROM`, which is the total form and measurably the
  wrong one: every operator in this language is *false* on a null operand in TS, so with a partial
  operand the total form makes Postgres **refuse a row TypeScript accepted** — a raw `23514` in
  place of `X_INVARIANT_VIOLATED`. `=` keeps the disagreement in the direction where the app refuses
  first. One combinator, not a boolean algebra: `and`/`or`/`not` arrive with a real caller or not at
  all.
- **`bun run sql-literal-copies`** — a step of the gate's `unit` check. One module may turn `'` into
  `''`, matched on the transformation rather than on a name. Pinned at zero.

### Fixed

- **`x db gen` never dropped an index an entity stopped declaring.** `diffTable`'s index loop
  walked DECLARED indexes only and matched by name, so a recorded index no entity declares stayed
  on the database forever while the next sidecar quietly stopped recording it. `checkPlan` has that
  arm and `foreignKeyPlan` gained it in 2026-08; the index arm never did.

  Measured on `examples/dummy`: the chain created `member_unique_per_org`, `members_tz_idx` and
  `post_slug_unique_per_org`, dropped none, and the newest sidecar recorded none. `declaredSchema`
  reads only that sidecar and calls it the database, so the **next** `x db gen` was blind to all
  three — and `drift` was green over it, because drift judges the declared side.
  `post_slug_unique_per_org` matters most: its replacement is **narrower**, `(slug)` against
  `(org_id, slug)`.

  Dropping one is not one statement. A recorded unique CONSTRAINT and a plain unique INDEX are
  indistinguishable in `TableDescription`, and the *same declaration* reaches the server as either
  kind depending on which migration created it. Measured on 18.4: `drop index` on a
  constraint-backed index is `2BP01`, and **`if exists` does not suppress it** — so the emitted
  repair is a guarded pair, constraint first, and only for the shape a constraint's index can have.
- **A materialised view's `fix:` line emitted DDL Postgres refuses.** `dependentViews` selects
  `relkind in ('v', 'm')` deliberately, while `restoreView` always wrote `drop view` — answered
  with `WRONG_OBJECT_TYPE`. The one kind the query went out of its way to include was the one whose
  fix could not run.
- **An app's declared column default could be stored as a different value, silently.**
  `.default('C:\logs')` emitted `default 'C:\logs'`, which stores `C:\logs` with
  `standard_conforming_strings` on and **`C:logs`** with it off — a GUC settable per session, per
  database and per role, needing no privilege. A declaration that type-checks, a migration that
  applies, a column defaulting to a value nobody wrote, and no error anywhere. A value *ending* in a
  backslash was worse: the escaped quote left the literal unterminated.

  Three copies of the escape existed and **two stopped at doubling the quote**. `literal()` in
  `@ultimat3/db` is now the one answer and emits `E'…'` **only** when the value carries a backslash,
  so every migration already on disk is byte-identical and nothing regenerates.
- **A foreign key over a retyped column aborted the migration.** `42804`, thrown by the ALTER
  itself, inside `ROLE=migrate`, with the ledger recording nothing. It could not be answered from
  inside `diffTable`: the constraint that breaks is recorded on the table that *owns* it, so for a
  retype of the key's target it is a different entity's row. The retype set is now derived over the
  whole schema before the entity loop, and `retypeColumn` reads it instead of deciding again.
- **A view over a retyped column reached the operator as `X_DB_UNAVAILABLE`** — "cannot reach the
  database", on a database the migrator was connected to and mid-transaction on, while the server's
  own `rule _RETURN on view … depends on column` sat unread in a `DETAIL` field.
  `X_MIGRATION_VIEW_DEPENDS` names the view, the table and the column, caught by a preflight inside
  the migration's own transaction so nothing partial applies. A refusal, not a repair: no
  `SchemaDescription` records a view and no `entity()` can declare one.
- **A generated column's rebuild silently dropped a partial index and a CHECK naming it.**
  Plain → generated has no `set expression`, so the column is dropped and re-added — and
  `drop column` takes both with it, while the snapshot went on recording them.
- **`sqlType` answered the `Object` function for the kind `constructor`** and spliced its source
  into the type position of an `alter` statement.

### Changed

- **`examples/dummy` regenerates its migrations, for the first time.** Its `drift` step is green
  and unpinned — 17/20 to **18/20** on the app ratchet. `REPLICA IDENTITY FULL` turned out not to
  be the blocker its pin claimed: that measurement was taken against a **squash**, and the
  incremental path keeps `0001_init.sql` and both `ALTER`s. What it needed was the
  `-- ungeneratable: 7` header the error's own `fix:` line asked for. Still a real gap for a NEW
  app, tracked as #357.
- **Both tracked apps now render every invariant.** `examples/dummy` and
  `dummy/social-media-clone` had **five** rules between them declared as JS predicates, so each
  reported `sql: null` and reached no database — while three source comments claimed a Postgres
  CHECK was enforced "from one declaration". `dummy/social-media-clone`'s `users` table has had no
  handle constraint at all, and `friendships` none on its responded-coherence rule.

  `examples/dummy`'s `member_email_shape` was the subtle one: it declared `contains('@')`, which
  renders `position('@' in email) > 0` — weaker than the `> 1` the hand-written migration has
  enforced since day one, so regenerating on that form would have *introduced* a regression.

### Commits

- fix(db): drop the index an entity stopped declaring, so the reference app can regenerate (#358)
- fix(db,entity): a pattern that reaches the database, a literal that survives the GUC, and a retype that no longer aborts (#356)

## 15.0.0 - 2026-08-25

The four items 14.0.0 left open, closed — and one deliberately left open, with the reason.

### Fixed

- **A retype aborted whenever a predicate named the column.** `alter column … type` failed
  `42883` when a partial index's `where` or a CHECK named it: both were compiled against the old
  type and cannot be recompiled. **`examples/dummy` could not regenerate at all**, aborting at
  statement 68 of 85; it now applies 86 statements clean and reverses in 66, measured on a
  populated database.

  The dependency set was larger than reported. Measured on PG 18.4, one shape at a time: a plain
  btree, a composite btree and a unique index all **survive** the ALTER; a partial index naming the
  column and a CHECK naming it are both `42883`. A **foreign key** over the column and a **view**
  are fatal too — measured, not fixed, written into `packages/db/CLAUDE.md`.

  The reference scan **over-approximates deliberately**: narrowing by type name was tried and
  rejected with data — `char(1)→char(3)`, `varchar(80)→text` and `numeric→integer` all re-derive
  their predicates, but `integer→text` under `check (c >= 0)` does not, all built-ins. Whether an
  expression re-resolves is *operator resolution*, so a miss is `42883` inside `ROLE=migrate` and a
  false positive is a rebuild on a statement already rewriting the whole table.
- **Two byte allowances were stale, and flaky only under load.** The module Bun's tree-shaker drops
  non-deterministically grew from 379 B to ~1,124 B when `schema-error-codes.ts` gained
  `registerErrorRetry`. The drop is load-correlated — 0 in 80 idle builds, 22 in 240 under six-way
  contention — which is why CI failed and a laptop never did. Both tests now discriminate on the
  module itself: **51 bytes of planted real source made the minified chunk 47 bytes SMALLER**, so
  the old `<= 512` bound could not catch a regression in either direction.

  **The root cause is upstream and the fix is a workaround.** `@ultimat3/core` *declares* that
  module in `sideEffects` and `bun run side-effects` agrees the declaration is true, so Bun 1.4.0
  is dropping a module its own package marks side-effecting — the family of `oven-sh/bun#27709`,
  open. Recorded in both files so nobody tidies it back into a threshold.
- **A compiled module imported a specifier it could not resolve.** `JSX_PRELUDE` emitted a bare
  `'@ultimat3/render'`, so any `.tsx` outside the repo failed — invisible to the gate because
  `bun test --isolate` gives each file its own module registry. Bun 1.4.0's **runtime** plugin does
  not support `onResolve` (three registrations, none fires), so the specifier is resolved in the
  loader's frame. Nothing persists that output: islands are built by a separate `Bun.build`.
- **The app gate reported a shard's exit code and nothing else.** `packages/cli` already carried the
  failing test's name and assertion diff through `--json`; `scripts/reference-app-gate.ts` dropped
  it in three places. An unpinned red step now prints it and a pinned one stays quiet. That absence
  is why one flaky shard cost a clean-checkout reproduction and 300 instrumented builds.

### Changed

- **BREAKING — `DriftKind` gains `missing-check`.** A `switch` over `DriftKind` with no `default`
  no longer compiles, the same shape 4.0.0 recorded for `changed-foreign-key`. It compares
  `conname` and **never** the definition: `pg_get_constraintdef` answers Postgres' own rewriting, so
  a text comparison would report a correct database forever. `checks` (declaration) and
  `checkNames` (catalog) are two fields, and `CheckRow` has no definition column, so merging them
  requires visibly adding one.

### Known

- **The reference app is deliberately NOT regenerated.** `x db gen` reports three `-- UNRENDERED`
  entries and would drop three real CHECKs. `invariant()` has **no SQL-expressible pattern form** —
  `matches` takes a JS `RegExp` and yields `sql: null` — so a regex constraint can only be
  hand-written and only be lost. The guard is correct; the gap is the framework's, and it is
  recorded in that app's schema file.

### Commits

- fix: a retype that aborted, a drift that could not see, and two stale byte allowances (#353)

## 14.0.0 - 2026-08-25

The gaps 13.0.0 left, closed — and the three packages that release never opened, audited.

### Added

- **A real e2e browser driver.** `hasE2eDriver()` had answered `false` since it was written; no
  driver had ever existed. `installE2eDriver()` in `@ultimat3/cli` adapts a live `ScrapePage` to
  `PageLike` — `goto`, `reload`, `title`, `url`, `gotoStreamed`, `waitForServiceWorker`,
  `evaluate`, `locator`, `getByRole`, `getByText` and every `LocatorLike` method, driving the
  retrying `toBeVisible` matcher unchanged. `cli` is the composition point because it already holds
  declared tier edges to **both** `testing` and `scraping`; a `testing → scraping` edge would have
  been a new sideways exception.
- `ScrapeFrame.query(selector)` and `ScrapePage.offline(enabled)`, so a frame read and a browser's
  offline mode are drivable rather than approximated.
- `resetE2eDriver()` — `useE2eDriver` shipped with no inverse and wrote process-global module
  scope, so `packages/testing`'s own test file leaked a driver into every later file in a run.

### Fixed

- **BREAKING — a frame verb acted on the parent document.** `frameTarget` spread the parent target
  and `clear` was missed when the overrides were added. On CDP, `frame.fill()` cleared the
  **parent's** same-id field and then **appended** to the frame's, so a remembered username
  submitted as `oldUserNEWUSER` while a parent field was silently emptied. On the offline drivers
  one shared overlay meant `page.values('#password')` read back what was typed into the frame.
  `driver-parity.test.ts` exists to catch a CDP/offline divergence and had no frame coverage;
  `driver-parity-frames.test.ts` now does.
- **BREAKING — two tenants could share one authenticated session.** `sessionKeyFor` collapsed every
  non-`[a-zA-Z0-9._-]` run to a single `-`, so `alice@corp.com` and `alice-corp.com` were one key.
  The browser then loaded account A's cookies, `auth.validate()` answered `true` — the session *is*
  valid, for the wrong account — and A's rows were stored under B's tenant. Each segment now
  carries a hash of its raw value. **Every stored session key changes spelling**: a miss reads as
  "no session", so it costs one extra login per stored session and orphans the old objects.
- **A schema refusal burned a job's whole retry policy.** `classifyThrown` reports the fail-closed
  default only for a code that was *explicitly declared*, so `X_VALIDATION_FAILED` — unclassified —
  let the attempt count govern. Measured: a page carrying `<div constructor="…">` cost
  `@ultimat3/scraping` five browser launches, five arrivals at a login, and a dead letter claiming
  the browser went away, about a browser that answered perfectly.
- **`X_FORBIDDEN` was unclassified too**, so a job retried an authz denial five times.
- A site's response body reached an error `cause` unredacted, and `secrets.ts`'s header promised
  otherwise. `page.console()`, `page.network()` and `page.pageErrors()` were unredacted as well —
  three of the four surfaces that header named, plus a fifth it did not.
- `createRing` with a negative capacity **hung forever** — past `ctx.signal`, past the wedge
  watchdog and past the job timeout. Reproduced at `exit 124`.
- A recorded 204 could not be replayed: `t.string` refuses an empty string, so `body: ''`,
  `html: ''` and an empty header value all raised `X_VALIDATION_FAILED`, and the two offline
  drivers disagreed about the same recording.

### Changed

- **BREAKING — `$migration()` is removed from `EntityCore`**, and `toSql`, `invariantsToSql` and
  `constraintName` are removed from `@ultimat3/entity`'s public API. They were a **second** renderer
  of the same CHECK and UNIQUE statements `@ultimat3/db` emits, under the same naming convention,
  called by nothing but tests — and `$migration()` passed the entity NAME where the renderer expects
  the TABLE, so `entity('account', { table: 'legacy_accounts' })` produced
  `ALTER TABLE "account" …`: a `42P01` against a relation that does not exist, under a constraint
  name no migration writes.

  Two tests were pinning it. `physical-names.test.ts` — whose own header says *"the second place
  that spells a name is the one that gets it wrong"* — checked the **column** half of the renderer
  that got the **table** half wrong, on the one entity in the repo that could have shown it. And
  `dsl.test.ts` asserted `$migration()` passes `$name`, making the bug the definition of correct
  delegation. `x db gen` is the one path to a constraint, and it was always correct.

- **BREAKING — `t.number.int()` demands a SAFE integer.** It used `Number.isInteger`, so
  `9007199254740992` passed the boundary as a 200 and failed at the row write as a 500 — the same
  value refused twice, once with a field path and once without. `money-value.ts`, one file over,
  already carried the write-up for having fixed exactly this. `toJsonSchema` now publishes the safe
  range on an integer node, so the contract stops promising what the parser refuses.
- **BREAKING — `and()` and `or()` refuse an empty clause list.** `and()` answered **allowed** and
  `admitsAnonymous(and())` agreed, so a policy built from a list that filtered to empty admitted an
  anonymous caller on all four surfaces.
- **BREAKING — a `t.record` issue path names the failing entry by POSITION**, not by the caller's
  key. The key *is* caller data, and it reached `X_BODY_INVALID`'s cause and the log line —
  the surface `describe-value.ts` exists to keep caller content out of.
- **BREAKING — `ScrapeTarget.setOfflineMode` is required** and `CdpTargetInit.ringCapacity` is
  deleted (declared, exported, read, and passed by nothing but a test).
- **BREAKING — `Repo.insert`/`insertAll`/`upsertAll` take `RowWrite<T>`.** They took the ROW type
  where money's WRITE type belongs, so `postgresRepo()` — exported — was a compile error for a
  `bigint` minor the framework documents, implements and stores correctly. Measured while fixing
  it: `Bun.SQL` hands `int8` back as a **string**, never a `bigint`, so the runtime was right in
  both directions and only the declaration was wrong.
- An `or` denying an anonymous caller reports `X_UNAUTHENTICATED` where it reported `X_FORBIDDEN`.

### Commits

- fix(db,render,cli): a column's CHECK left the database, and the first click was lost (#352)
- fix: the gaps 13.0.0 left, and the three packages that release never opened (#351)

## 13.0.0 - 2026-08-25

Six capabilities the readiness register graded **Ship**, all of them, plus the defects found while
building them — which were worse than the gaps. Every one is a factory over an existing primitive:
no ninth primitive, no new `PrimitiveKind`, and `PRIMITIVE_FACTORIES` grew by three rows.

`@ultimat3/notify` is the framework's **31st package** and its first new one since `scraping`.

### Added

- **Notifications — `notifier()`, a job factory in the new `@ultimat3/notify` (tier 4).** One
  declaration, many channels: fan-out, a preference gate, a digest window, a delivery ledger and an
  in-app inbox. Inspired by Rails' `noticed` and translated rather than copied — params are a
  **schema** (which is how every primitive here declares input, and what earns the manifest row),
  and the unit of retry is a durable **step** per (recipient × channel) rather than `noticed`'s
  queue row per pair, because `step.run` already *is* the retry unit. Ultimate goes further than
  `noticed` on the two the register demanded: `noticed` has no preference storage at all and no
  digest coalescing. The notification **taxonomy** and `quietHours` deliberately never ship — the
  framework ships the gate, the app declares what the gate reads.
- **Full-text search — `searchable()` on a text column, `search()` as a query factory.** One
  `tsvector` per entity, so one GIN index and one predicate, with per-source weights `A`–`D`.
  `websearch_to_tsquery`, never bare `to_tsquery` — which reads a user's `&`, `|`, `!`, `:*` and
  parens as **operators** — and never `plainto_tsquery`, which silently discards `"a phrase"` and
  `-negation`. Paging is by the entity's declared total order: relevance ordering needs `ts_rank`
  as a seekable key across four files, and shipping `order by ts_rank` without the cursor half is
  exactly the pager 12.0.0 fixed.
- **`generated always as (…) stored` reaches the migration.** `x db gen` could not emit a generated
  column at all, which is what the search vector needs. An expression that moves is
  `alter column … set expression as (…)` (Postgres 17+, which is the shipped floor everywhere):
  it rewrites the table, recomputes every row and **keeps the column's indexes** — measured.
  Drop-and-recreate loses the GIN index, and nothing in the diff puts it back.
- **Outbound webhooks — `webhook()`, a job factory — and `verifyWebhookSignature()` inbound.**
  One canonical string, `v1:<timestamp>:<eventId>:<topic>:<body>`, HMAC-SHA256, in
  `@ultimat3/core` so the signer and the verifier are one function rather than two that agree
  today. **`:` is refused in an id or a topic on both sides**: without that, one MAC over
  `v1:t:evt:01HZ:orders.paid:<body>` authenticates **two** different id/topic splits — the
  sender's own signature under a label it never wrote.
- **Async export — `exportRows()`, a job factory.** A paged read streamed to object storage with a
  resumable cursor, ndjson or RFC-4180 csv. **The part key is the page index**, so a replayed page
  rewrites the same object with the same bytes and a duplicate row in the artifact is not
  expressible. The csv formula guard (a cell leading `=`/`+`/`-`/`@`/TAB/CR is *evaluated* by
  Excel, Sheets and LibreOffice) is on strings only, so a negative number stays a number.
- **State machines — `enumerated().transitions()`, and `transition()` as a mutator factory.** The
  legality check is in the statement's predicate, not around it: **twenty concurrent transitions at
  one row produced 14 winners with a read-then-check-then-write and 1 with `from` in the
  predicate.** `TransitionTable<S>` is a mapped type over the app's own union, so there is no enum
  of state names anywhere in the framework and an unknown target is a compile error.
- **Form binding — `useForm()` in `@ultimat3/ui`**, mapping an action's validation issues back to
  the field that caused them, `items[2].price` included. Server authority is structural: `submit`
  is a required option and `succeeded` is constructed at exactly one site from its resolved value,
  so the local parse's result is never read.
- **`bun run framework-tables`** — a gate ratchet refusing a literal `create table` in
  `packages/*/src` that no boot path creates. Pinned at zero, enforcing outright.

### Fixed

- **`defineService` was a job-and-CLI feature, and nothing said so.** An app that registered
  `defineService('posts', …)` got that service in a job, a task and a CLI command and **nowhere
  else**: `@ultimat3/http` built its own service bag and never called core's `installedServices()`.
  So on the surface an app spends its life on, `ctx.services` was `{}` and `useService('posts')`
  threw `X_SERVICE_MISSING` for a service that was registered and working one process over. The
  second half compounded it — core's `createContext` spreads the bag **onto** the context, so
  `ctx.posts` *is* the service, and http never did. `ctx.posts` is the spelling
  `docs/architecture/15-adding-a-feature.md` writes in its worked example, so **the documented path
  was the broken one**. `createRequestContext` now composes `createContext()` instead of building a
  second context beside it, so both halves are fixed at once and cannot drift again.
  **`defineService` factories now run once per HTTP request**, which they never did.
- **Five auth tables were created by nothing.** `x_users`, `x_sessions`, `x_accounts`,
  `x_verifications` and `x_api_keys` — the five `BuiltinAdapter` reads — were declared, exported
  and applied by **no boot path, in dev or in production, from the initial commit through all 21
  released versions.** They are not `entity()` declarations, so `x db gen` never saw them, and the
  file exported the DDL "so an app can paste it into a migration" that no app wrote.
  `examples/dummy/CLAUDE.md` recorded the consequence in the app's own words — nobody could hold a
  session — without anyone connecting it to the cause. Now in `FRAMEWORK_SCHEMA`, and
  `bun run framework-tables` is what keeps the class closed.
- **Two error codes were unreachable by any caller.** `X_TEST_SCHEMA_EXPECTED` and
  `X_TEST_JOB_EXPECTED` were declared, registered and titled, and Bun **replaces** an error thrown
  from an `async` matcher body with its own `returned a promise that rejected`. The three matchers
  are no longer `async`.
- **Per-field validation issues now survive the wire.** `InputInvalidError` flattened the issue
  list to one string and put nothing in `meta`; `ProblemDocument` had no `issues` member; the typed
  client reconstructed only `code`/`cause`/`fix`/`docs`. So the only carrier of per-field
  information was the prose `cause` line, and every app writing forms parsed it. The list is now
  carried end to end — action → http → mcp → client → form — **dropped under exactly the opacity
  condition** an unclassified 5xx already uses, bounded, and rebuilt member by member with
  `received` forced empty, because a foreign schema library's raw issue object may carry the value
  that was rejected.
- **A phantom write chain in the reference app.** `setPlan` and `updatePreferences` were
  `.where({id}).update({…}).returning()` — `ReadBuilder` has no `update`, and nothing in
  `@ultimat3/entity` has `returning`. Both were `TypeError`s on every call; nothing had ever
  exercised the server half of a preference write. `examples/dummy`'s typecheck went 116 → 0.
- **Nine e2e assertions used a matcher that does not exist.** `toBeVisible` was not among
  `UltimateMatchers`' seven. It exists now and genuinely retries — a budget counted in
  **observations, not milliseconds**, because this package freezes `Date.now()` and a clock
  deadline never expires, turning a failing test into a hanging one.
- **Two notify codes burned the whole retry policy.** `X_NOTIFY_FANOUT_TOO_WIDE` and
  `X_NOTIFY_STORE_MISSING` are thrown inside a job body and were never classified, so an audience
  over the cap and a missing store each re-proved an answer no attempt could change. Both are
  `terminal`; `X_NOTIFY_DELIVERY_FAILED` is `retryable` and **502, not 500** — it wraps a
  provider's rejection, and every `status >= 500` is reported to the error monitor, so a wrong 500
  pages the on-call for someone else's outage.

### Changed

- `x db gen` emits `generated always as (…) stored`; `ColumnDescription` carries `generated`.
- `enumerated()` returns `EnumeratedColumn<V>` rather than `Column<V[number]>` — structurally
  widening, assignable everywhere the old type was.
- **BREAKING — `ServiceFactory` receives `CtxFacts` rather than `Ctx`.** A factory reading a
  sibling service no longer typechecks. Reading one was already documented as unsupported and no
  app in the tree does it, but the type permitted it and now does not, which is a compile error
  where there was none.
- **BREAKING — `PageLike.content()` is deleted.** Its comment claimed every member was one the
  reference app's e2e suite already calls; that was false for three of eleven, and `content()` had
  **zero call sites anywhere in the repository**. `title()` and `reload()` stay, with the caveat
  recorded: their only caller is a generated template that nothing executes.

### Commits

- feat(scripts,testing,docs): the defects found building 13.0.0, and the rules that keep them closed (#350)
- feat(jobs,action,notify,ui,mcp,cli): notifications, webhooks, exports, form binding (#349)
- feat(core,http,db,entity,query): the request-context repair, full-text search, and state machines (#348)

## 12.0.0 - 2026-08-24

One sweep, in the two halves every major here has had: things **declared and never wired** are wired
or deleted, and things that **answered the wrong thing** are corrected. The declared-and-never-wired
half is now mechanised a second time — `scripts/declaration-readers.ts` ratchets every leaf key of
every primitive declaration, where `scripts/config-readers.ts` only ever saw `AppConfig`.

### Security

- **BREAKING — every physical name is asserted at `entity()`: `[a-z_][a-z0-9_$]*`, at most 63 bytes.**
  `columnName` is `meta.name ?? snake(property)`
  and only the FIRST branch was validated, so a column declared
  `n" , "x" text); drop table t; --` produced a `create table` carrying a real `drop table` —
  measured through `generateMigration`, not theorised. `entity('t" (x int); drop table u; --')` did
  the same through the table-name fallback. Both are asserted at declaration now
  (`packages/entity/src/column.ts`, `entity.ts`). Found while testing an unrelated index-name guard.

### Fixed

- **Keyset pagination silently dropped rows.** The seek treated a whole millisecond as one equality
  class while `ORDER BY` evaluated `timestamptz` at microsecond precision — two different equality
  classes over one page boundary. Reproduced against Postgres 16: three rows inside one millisecond,
  uuid-v7 ids, `orderBy('createdAt','desc').limit(1)` — the walk returned **1 of 3 rows and stopped**.
  Under `desc` with time-ordered ids the boundary row always holds the largest id in its millisecond,
  so every remaining row in it was dropped, every time. Invisible to the whole parity suite by
  construction: `memoryRepo` stores millisecond `Date`s, and the pg tests asserted SQL *text* against
  a recording client. The cursor now carries microseconds and the seek is a plain comparison;
  `nextMillisecond` is gone.
- **A nullable sort key was refused only when a next page existed** — green on 15 seeded rows,
  `X_INVARIANT_VIOLATED` on the first real read in production. The check moved to plan time, and then
  the refusal itself was mostly deleted: see Added.
- **Two partial indexes on the same columns silently collapsed to one.** An index's identity was its
  name and the name omitted `where` and `order`, so the second declaration was dropped with no error,
  no warning and no drift finding.
- **Extension-owned relations failed every deploy** (#340). A stock managed Postgres with
  `pg_stat_statements` in `public` made `x db migrate`'s drift audit refuse terminally, and the
  printed fix (`x db gen "add pg_stat_statements"`) asked the app to own an extension's view.
  Introspection now excludes relations Postgres records as extension-owned (`pg_depend`,
  `deptype = 'e'`) — ownership, not a name prefix, because an extension may install any name.
- **The MCP argument validator counted UTF-16 code units** while the schema that minted and publishes
  those numbers counts code points. An astral-character argument was silently passed and then refused
  by the action's own parse, or refused outright on a bound the agent had obeyed.
- **No HTTP request ever spent an org rate-limit bucket.** The key builder consulted `orgId` only when
  `actorId` was null, and the anonymous actor answers `null` for both — so the branch was unreachable.
- **`x new` scaffolded an app that served HTTP 500 on two of its three routes.** The template granted
  `dashboard:read` and required it on a route, and nothing called `definePermissions`. A green
  19-step gate said nothing, because the scaffold's own test asserted role *expansion* and never
  registry *membership*.
- **`x i18n add <locale>` wrote a file that turned the gate red, printing a fix that repaired
  nothing** — it named an edit already made by `x new`, so an agent following it changed nothing and
  stayed red.
- **`x dev --port N` died on port N+1** with a caught `Error` rendered into the cause, `X_CLI_UNEXPECTED`
  rather than a stable code, and `x doctor` answering "shippable" because it probed only the web port.
  `x doctor` now probes both ports and the database.
- **The gate's own verdict depended on machine load** — three `scripts/side-effects.test.ts` cases each
  re-scanned every file of every package and timed out at 5000ms under `x verify`'s workers.

### Added

- **Read replicas.** `DATABASE_REPLICA_URL`, `withReplicaReads(fn)`, and read-your-writes as the rule
  rather than an option: any write, or any `withTransaction` that is not `readOnly`, pins the rest of
  the scope to the primary. A 3-failure/10s breaker falls back to the primary. Opt-in and byte-identical
  when unconfigured. The boot installs both halves — until it did, `DATABASE_REPLICA_URL` was read by
  no process at all.
- **A durable admin audit sink.** `postgresAuditSink({ executor })`, append-only, no purge (retention
  is the app's). `memoryAuditSink` is now a bounded ring that reports `dropped`, rather than an
  unbounded array retaining a whole `Ctx` per record. The sink never walks the `Ctx` — a fixed
  allow-list — and redacts `input` through core's own `isRedactedKey`.
- **`configureHttp()`.** The entire HTTP tuning surface — CORS origins, body limit, request timeout,
  max in-flight, rate-limit buckets — was reachable from no app config key that existed. `DEFAULT_CORS.origins`
  is `[]`, so every cross-origin browser call was refused in every deployment, permanently, with nowhere
  to say otherwise.
- **Per-tenant HTTP rate limits.** A request spends a list of keys; `rateLimit.tenantBucket` caps an org.
- **The request deadline propagates.** `traceHeaders()` sends the *remaining* budget, so a downstream
  hop cannot start a fresh full budget after its caller has already been answered `X_TIMEOUT`.
- **Aggregates and containment on entities.** `sum`/`avg`/`min`/`max`/`approximateCount`, and
  `contains`/`contained-by`/`overlaps`/`has-key` so a declared `json()` or `arrayOf()` column is no
  longer write-only from the query language. `min`/`max` on text is refused (Postgres orders by
  collation, JS by code unit); `avg` over money is refused, naming `sum()` + `count()`.
- **Nullable sort keys order.** `asc nulls last` / `desc nulls first`, with the null position encoded in
  the cursor. Only a nullable primary-key column is still refused.
- **`scripts/declaration-readers.ts`** — every leaf key of every primitive declaration needs a reader.
  173 leaves across 18 roots, pinned at zero.
- **A `policy` gate step**, twentieth. It is what would have caught the scaffold's 500s.
- **MCP rate limits are enforced.** `MCP_RATE_LIMITS` was published on the descriptor and applied by
  nobody; the real ceiling was Bun's accept rate.

### Removed

- **BREAKING — `LiveCursor.digest` and `LiveCursor.count`, `digestOf`, `DIGEST_UNVERIFIED` and `fnv1a`
  are deleted from `@ultimat3/realtime`.** Every snapshot ran `canonicalJson` over every row and hashed it for a value
  no code path read — in the reconnect storm this package is benchmarked on, that is a full
  serialize-and-hash of every result set for nothing. `PROTOCOL_VERSION` moves 1 → 2: the fields were
  decoded through `str()`/`num()`, which throw on absence, so removal is unreadable in both directions
  and a version bump is what says so.
- **BREAKING — `RouteBudget.css`, `.cls` and `.tbt` are deleted.** Declared on the route contract, projected by nothing, so
  a declared CSS budget was silently ignored while `budgets` reported green. A type pin now makes a new
  budget key a build error until it is projected.
- **The four `doc-config-key-pins.ts` waivers.** That table said the repair "is a release decision, not
  an edit to the four rows below". This is that decision; the table is empty.

### Changed

- **BREAKING — `claim({ queues: [] })` is refused** rather than meaning "every queue" on the memory
  driver and "the default queue" on Postgres. Each meaning is silently wrong in the other's
  deployment. `X_JOB_CLAIM_QUEUES_EMPTY`. The memory driver's `claim` is `async` to raise it, so a
  caller that read its return synchronously now gets a `Promise`.
- **BREAKING — the primary-key tiebreak takes the last declared key's direction**, so the default total order is
  no longer mixed-direction and therefore un-indexable by this framework's own index DSL. A uniform
  order is emitted as a row comparison — measured on PG16: `Index Only Scan`, against `BitmapOr` + `Sort`
  for the or-chain.
- **BREAKING — every cursor minted before 12.0.0 is `X_CURSOR_INVALID`.** A `timestamp()` sort key is
  carried as a microsecond epoch rather than an ISO string, and every entry is tagged — `~` for an
  absent value, `!` before a present one, so a `text` column holding the four characters `null` can
  never be read as an absence. Both are what let the seek be a plain `<` / `>` / `=` against
  `$n::timestamptz` instead of the `>= v and < v + 1ms` window that dropped rows. A read ordered by a
  `timestamp()` column also carries one extra output column on the wire, `"<col>$US"` — under a name
  no entity can declare, stripped by `decodeRow`, and visible only to a test asserting SQL text.
- **BREAKING — an index that declares `where` or `order` is named
  `<table>_<cols>_<hash8>_idx`.** Plain and `unique()` names are unchanged, because those are
  load-bearing: Postgres names a column-level `unique()` index `<table>_<column>_key` itself, and a
  foreign key's own index is deduped against a hand-declared one by that name. The discriminator is
  what stops two different partial indexes on one column from being one name and one index. A name
  over 63 bytes is now refused at declaration rather than truncated by the server in silence.
- **BREAKING — `Repo` gains `aggregate(fn, column, args?)` and `approximateCount(args?)`, and
  `ReadBuilder` gains `sum`, `avg`, `min`, `max` and `approximateCount`.** A hand-rolled `Repo` or
  `Driver` no longer satisfies the interface.
- **BREAKING — `Operator` gains `contains`, `contained-by`, `overlaps` and `has-key`.** An exhaustive
  `switch` over it stops compiling until it widens.
- **BREAKING — `introspect()` returns app tables only.** Views, materialised views, foreign tables
  and every relation Postgres records as extension-owned are excluded before the fold, and
  `IntrospectOptions.exclude` no longer decides the set on its own. It issues four catalog queries
  where it issued three.
- **BREAKING — `rateLimitKey` is deleted; `rateLimitSpends` replaces it**, because one request now
  spends a LIST of keys — the caller's, then the tenant's — where the old builder answered `actor`
  else `org` else `ip`, exclusively, and so never reached an org bucket at all.
  `RateLimitConfig.tenantBucket` is a required member of the resolved config.
- **BREAKING — `Ctx` gains a required `deadlineAt: number | null`.** A hand-written `Ctx` — a test
  fixture, a custom host — no longer compiles. `createContext` defaults it to `null`.
- **BREAKING — `traceHeaders()` sends the remaining request budget**, so a downstream hop is given
  what is LEFT of its caller's deadline rather than a fresh one. A spent budget sends no header at
  all rather than `0`, which the far side would read as "the caller asked for nothing".
- **BREAKING — `mcpHttpRoute` and `defineAppMcp` enforce `MCP_RATE_LIMITS`** — 120 read and 20 write
  per minute per actor, `X_MCP_RATE_LIMITED` with a `Retry-After` past it. The numbers were published
  on the descriptor and applied by nobody, so the real ceiling was Bun's accept rate.
- **BREAKING — `memoryAuditSink()` is a bounded ring that discards**, `DEFAULT_MAX_AUDIT_RECORDS`
  (1,000) oldest-first, with `{ maxRecords }` to raise it. `MemoryAuditSink` gains required `size` and
  `dropped`, so a hand-written implementer no longer compiles.
- **BREAKING — `DoctorProbe` gains a required `database()`**, and `portFree` is called for two ports:
  `x doctor` answered "shippable" while probing only the web port and never the database.
- **`@ultimat3/schema` exports `charCount`**; `@ultimat3/mcp` now depends on `@ultimat3/http`.

### Commits

- feat: 12.0.0 — batteries for scale, and the gaps mechanised shut (#347)
- fix(db): extension-owned relations, read replicas, and index access methods (#340) (#346)

## 11.3.0 - 2026-08-24

### Fixed

- **`llm()`'s semantic cache answered in the wrong language.** Reported against the reference app:
  the summary comes back in Spanish for an English reader. The model was never wrong — it is told
  `Write the summary in the locale {{locale}}` and it obeys. The cache was: `lookup` is a cosine
  nearest neighbour, and two renderings of one prompt differing ONLY in that token, while carrying
  a whole post, are neighbours — measured with this package's own `HashEmbedder` over the reference
  app's template, **0.9986**, against the declared `threshold: 0.97`. So whichever language was
  asked for first was served to everyone. No threshold repairs it: the same number has to keep an
  honest repeat above it. The store key now carries `ctx.locale`, in the **unconditional** half
  beside the prompt hash rather than in the scope — a `scope` answers "who may share this answer",
  and a locale is part of what the answer IS, so a written-down `scope: () => 'global'` is
  partitioned by it too. `@ultimat3/render`'s ISR keys by locale for the same reason. Two failing
  tests came first, and both go red again if the key loses the locale.

### Added

- **`x shot --cdp-url <ws://…>` — photograph a route through a browser this box could not have
  started.** `@ultimat3/scraping` has had `remoteBrowser({ cdpUrl })` since it shipped and calls
  attach its **primary production path**; no CLI command could reach it, because
  `browser-launcher.ts` only ever called `localBrowser()`. So the framework's answer to "an agent
  cannot look at anything" needed a Chrome on the same box — which a CI runner, a distroless
  container and every stealth provider's customer do not have. `SCRAPE_CDP_URL` is the environment
  fallback, and it is `@ultimat3/scraping`'s own spelling rather than a second one: the package's
  `remoteRequired` refusal already names it.
- **A connect-only browser library is now a valid launcher.** `cdp-port.ts` declares `launch` and
  `connect` both optional precisely so a provider SDK that can only attach satisfies the port, and
  `launcherIn` asked every module for `launch` regardless — refusing exactly the library that
  works. It now asks for the method the run is going to call, and names the one that was missing.

### Fixed

- **An island chunk carried the `NODE_ENV` of the process that built it, not the one it ships
  under.** `Bun.build` picks the `development` / `production` export condition from the build
  process's own `NODE_ENV`, and inlines that value into app code — measured on the pinned 1.4.0:
  unset → Solid's development build, `test` → development, `production` → production. So every
  island built anywhere a container did not run (`x dev`, `x build` on a laptop, `bun test`) shipped
  with `process.env.NODE_ENV === "development"` baked into the file a browser downloads, and its
  bytes — therefore its content hash and its byte budget — depended on the box. `island-bundle.ts`
  now pins `define: { 'process.env.NODE_ENV': '"production"' }`: an island chunk is only ever built
  to be shipped, and `x dev` serves the same chunk the container does.
- **`packages/cli/src/island-solid-production.ts` is deleted — 120 lines re-implementing Node's
  conditional-exports walk to keep Solid's development build out of an island.** Its premise was
  that `target: 'browser'` always adds the `development` condition and *"no option removes it —
  `conditions`, `production`, `env` and `define` were each measured under Bun 1.4 and none of them
  does"*. Three of those four still hold; `define` does not, and one line reproduces what the plugin
  produced **byte for byte** (16,703 B for an entry importing `solid-js`, `solid-js/web` and
  `solid-js/store`). The likely origin of the wrong measurement is that the unquoted form is a
  silent no-op: `'process.env.NODE_ENV': 'production'` leaves the development build in place and
  `'"production"'` does not. Axiom 1 — the plugin was a second path to what the bundler already
  does.

### Changed

- **Which browser a `x shot` run gets is three rules, and each was chosen against a silent
  failure.** Both flags together is **refused** rather than ranked — one names a Chrome to start,
  the other says the browser is somebody else's, so honouring either ignores what was typed. An
  exported `SCRAPE_CDP_URL` is a shell-wide default and not a typed intent, so `--browser` beside
  it **wins**: the alternative is a flag that parses, reports nothing and quietly attaches
  somewhere else, which is the `--critical` defect class `flag-reads.ts` exists for and cannot see
  here, because the flag *is* read. And `--browser` is not read at all on an attach, so a correct
  remote run is never refused for a binary it will never execute.

- **Every Bun-version-stamped claim in shipped source was re-measured on the pinned series**, which
  is the half of the 1.3 → 1.4 move that never happened: a comment stamped `1.3.14` under a `1.4.x`
  pin says the behaviour was last checked on a runtime nothing in the repo runs. Re-measured true
  and restamped: `Bun.sql.query` is still `undefined` (`jobs/driver-pg.ts`), `server.upgrade()`
  still runs `websocket.open` synchronously before returning (`realtime/sync-upgrade.ts` and two
  tests), `expect(fn).toThrow(Class)` still passes when `fn` merely RETURNS an error (three test
  files), and Bun's dotenv precedence is unchanged — `NODE_ENV=staging` still reads
  `.env.development` and `test` still skips `.env.local` (`core/env-example.ts`).
- **Two of those claims were false, and are corrected rather than restamped.** `jobs/job.test.ts`
  said a bare `declare(0)();` expression statement "does not run at all under Bun 1.3.14 — the call
  is elided when its value is unused"; re-measured against that exact `declare` on 1.4.0, the
  statement runs and `job()` throws `X_INVARIANT`. `cli/compile-externals.ts` said Bun 1.3 is "what
  CI pins and what `docker/Dockerfile` builds on" — both moved to 1.4 on 2026-08-20, so every
  builder now takes the branch the comment describes as the other one.

### Commits

- feat(cli): x shot attaches to a browser it did not start (#344)
- fix(cli): an island chunk is built to be shipped, and every Bun-stamped claim is re-measured on the pinned series (#341 #342) (#343)

## 11.2.0 - 2026-08-23

### Added

- **`x shot --island <name> [--state <id>]` — one component, photographed in a state you cannot
  click to.** The framework's stated primary developer is an AI agent, and an agent could
  photograph a *route* and nothing smaller; the states worth reviewing are the failed read, the
  empty list, the over-quota banner, the offline fallback, and reaching those through a route needs
  a database in that state and a session that sees it. Both halves already existed and had never
  been joined: `mountIsland` runs a real island chunk over a micro-DOM that cannot rasterize, and
  `page.screenshot()` drives a real browser but was reachable only for a route.
  A **flag on `x shot`**, never a second command — `cmd-shot.ts` already owns the browser launch,
  the dev-server reuse, the settle window and the verdict writer.
- **The state manifest is pure data** — no JSX, no `solid-js`, no import of the component — so the
  CLI knows the complete expected picture list *before a browser exists*. That is what makes
  "produced nothing and exited 0" impossible: the run diffs what it owed against what landed and
  refuses independently of the browser's own exit code. `defineIslandStates` carries `timeZone` and
  `now`, so the framework's no-unzoned-dates rule is structural here rather than remembered — a
  harness that freezes the instant and leaves the zone ambient renders every date in the host
  machine's.
- **An unstubbed request fails the run, by name.** A component whose fetch quietly hangs paints its
  own loading branch, and the picture then shows a fixture gap dressed up as a component state.
  Every address is sealed and every capture asserts before the shutter: host attached, target
  visible, readiness reached (**quiet, not zero** — a deliberately-pending fixture never settles),
  a non-zero box, a box with actual children or text, then a byte floor as backstop.
- **A clip rectangle on `@ultimat3/scraping`'s capture port.** It was `fullPage` only, all the way
  down to the CDP port, so every picture was the whole viewport — and the reader is a vision model
  whose pixels are the scarce resource. `clip` and `fullPage` are mutually exclusive and the pair is
  refused by name, because CDP silently ignores one. A rectangle merely below the fold is
  **accepted**: this package sets and reads no viewport, and refusing it would reject the case the
  feature exists for.
- **The 500-line ceiling now exempts a pure re-export manifest**, detected mechanically — every
  statement an `import`/`export` that declares nothing. `packages/core/src/index.ts` was at 496 and
  adding six factory exports lands at 503, so no new subject could be added to core's public API at
  all. The ceiling re-arms the instant anyone adds a line of logic; it is not a path allowlist.

### Fixed

- **The island purity guard answered "pure" for an impure file.** It refused `solid-js` and a
  `.tsx` specifier, but `import { X } from './settings.island'` resolves to the `.tsx` under Bun and
  passed. The reference app was safe only because it used `import type`, which is erased — deleting
  one keyword would have dragged Solid into a browser-free context with the guard still green. Any
  relative runtime specifier is now refused; `import type` is exempt in both directions, proved
  against Bun rather than assumed.
- `packages/cli/src/ts-scan.ts` read **every** depth-0 string literal in a `fix:` expression,
  including a ternary's *condition*, so nine phantom fix sites across `action`, `auth`, `mcp`,
  `entity`, `cli` and `flags` were published as fixes to check. 952 → 943 real sites.


- **One flight layer, in `@ultimat3/core`.** The framework carried **four** retry engines
  (`jobs/retry.ts`, `ai/gateway.ts`, `realtime/thundering-herd.ts`, and `db/transaction.ts`, which
  retried on no backoff at all), with three different jitter strategies between them; **five**
  retryability tables, two of them byte-identical
  (`RETRYABLE_STATUSES = new Set([408, 409, 425, 429])` in both `cache/purge-http.ts` and
  `mail/driver-resend.ts`, packages that cannot import each other); four concurrency limiters; four
  dedup mechanisms; and sixteen independent timeout sites. `error-retry.ts` owned the *vocabulary*
  (`terminal | retryable | retry-after`) and nothing executed it. Now: `backoff.ts` (one curve, all
  three shapes, all three jitter modes, `random` injected), `retry.ts` (the executor that
  vocabulary never had), `single-flight.ts`, `flight-gate.ts`, `generation-fence.ts` — which nothing
  in the tree had — and `retryable-status.ts`. `classifyThrown` and `statedDelayMs` moved DOWN from
  `@ultimat3/jobs` into `core/error-retry.ts`. Tier 0, so no package pays a tier edge to reach it.
- **`X_FLIGHT_GATE_OVERLOADED`** (503, beside `X_OVERLOADED`) and **`X_SUPERSEDED`** (499, beside
  `X_ABORTED` — the caller went away there, the caller's generation moved on here, and in both cases
  nobody will act on the answer; deliberately not 409, which asks a client to reconcile against
  something a fenced answer has nothing to reconcile against).
- **`bun run flight-copies`**, a step of the gate's `unit` check. Refuses a second backoff curve —
  matched on **shape**, a factor raised to an attempt and clamped in one expression, never on a name
  — and any **call** to `Math.random()` in shipped source, which is what made `ai/gateway.ts` the one
  engine of four with no test at all. A `random = Math.random` default parameter is the injectable
  seam and is never reported. Pinned at **zero**, enforcing outright. Written because deleting three
  copies enforces nothing: the first draft keyed on a roll named `random`/`rng`/`roll` and read
  straight past a planted copy whose parameter was `r`, exactly as a rule spelled `RenderMode` once
  read past `PwaRenderMode`.
- **Deadlines on three shared reads that could previously wedge forever.** `createCacheStack`'s
  `load()` (`DEFAULT_LOAD_DEADLINE_MS = 30_000`, anchored to `http`'s own request-timeout default,
  because a load still running then has no reader left to serve), `@ultimat3/auth`'s JWKS refresh
  (twice its transport timeout: `AbortSignal.timeout` bounds only the default transport, and an
  app-injected `fetch` that ignores its signal pinned the slot for the life of the client), and
  `@ultimat3/realtime`'s query-window read. Eviction frees the KEY — it never cancels or rejects the
  work — so the worst case is one duplicate fetch, never a failed answer.
- **Flight control on both typed clients, and the browser bundle cut by two thirds.**
  `queryClient()` and `rpc()` were each one bare `fetch` — no dedup, no retry, no deadline, no
  concurrency ceiling, no supersession fence, only a pass-through `signal`. So N concurrent reads of
  one resource resolved in N orders and whichever landed last won, and a stale answer arriving after
  the caller's context moved on was applied anyway, because nothing could tell "superseded" from
  "succeeded". `createClientFlight` is now opt-in on both, composed from the tier-0 layer. Reads
  dedup on `[principal, url]` — **no principal means no sharing**, so the unsafe configuration (one
  caller joining another's open read across a sign-in or tenant switch) cannot be spelled. A
  caller-supplied `signal` disqualifies sharing outright rather than refcounting joiners, because
  not sharing cannot be wrong. **A mutation never joins another mutation, and a fence never aborts a
  write** — closing a mutation's socket does not un-commit it. A write retries only alongside an
  `Idempotency-Key`.
- **`rpc` measured 42,584 B in a browser bundle and is now 14,759 B; `queryClient` 40,412 → 12,755 B.**
  Two thirds of it was never the typed client: `client.ts` imported `BUILD_ID_HEADER` and
  `IDEMPOTENCY_HEADER` from `./http`, which is the route projection, so `@ultimat3/http`,
  `@ultimat3/cache`, `@ultimat3/policy` and the whole invoke runtime rode into every island calling
  `rpc()` for the sake of two string literals. Both packages now declare honest `sideEffects` arrays
  and the flight pipeline is `import type`-only at the call site, so it reaches a chunk only when a
  caller writes `createClientFlight`.
- **The client pipeline lives in `@ultimat3/core`, once.** It first shipped as a 288-line twin in
  both typed clients, kept in step by a byte-equality test — which makes drift loud, not absent, and
  is the defect this release is otherwise about. `client-flight.ts` and `client-wire.ts` are tier 0
  now (a module importing only tier 0 *is* a tier 0 module), both packages re-export the same
  objects, and `createClientFlight` from `@ultimat3/action` is `===` the one from `@ultimat3/query`
  where it used to be a distinct copy. Two further copies of `isJsonObject` went with them.
- `DB_ERROR_RETRY` and `AI_ERROR_RETRY`: five codes classified `retryable` that rendered
  `retry: "terminal"` — including `X_DB_SERIALIZATION_FAILURE`, whose own `fix:` line said
  `withTransaction(fn, { retry: 3 })` while the document beside it told every client not to retry.

### Changed

- **`@ultimat3/ai` retries 408, 409 and 425** in addition to `429` and `>= 500`. Every other 4xx
  still burns the budget for nothing; those three are transient by construction. Its jittered delay
  is now rounded rather than floored (≤1 ms), and a policy carrying `NaN` waits 0 instead of
  producing `setTimeout(NaN)`, which fires immediately — a "backoff" that was a tight spin.
- **`@ultimat3/db`'s `withTransaction` waits between re-runs** — exponential from 10 ms, capped at
  500 ms, full jitter, because two callers that just deadlocked are by construction scheduled at the
  same offset from the same event. **The default is unchanged: `retry` absent or `0` waits nothing,
  ever**, and nothing waits after the final attempt.

### Fixed

- **`UltimateError.retry` now reads `retryable` on a wire failure whose status says so.**
  `RemoteActionError`, `RpcFailedError` and `QueryRequestFailedError` previously always rendered
  `terminal`, because `retryFor` fails closed and no code declared for them — so `--json` told every
  client not to retry a 503. The status classifies only where nobody declared for the code: an
  `X_NOT_IMPLEMENTED` behind a 501 stays terminal, because a status that overrode a declaration
  would have a client hammer a config fault. Observable in `toJSON()` and to anything reading
  `error.retry`.
- `docs/idea/14-roadmap.md`'s milestone 2 claimed "a CRUD app driven entirely by the typed client,
  **no hand-written fetch**". The framework's own generator falsifies it: `rpc()` pulls
  `@ultimat3/action` into a browser chunk, so
  `cli/src/templates/resource-form-island.ts` emits a plain `fetch` into every `x g resource` output
  and both tracked apps do the same. Corrected, with the cost stated.
- The same page claimed tier 3 local-first "lands in v2 as `persist: true` — a flag, not a rewrite",
  wrong in both halves: `query()` has never accepted `persist`, and the in-memory half is ~1,000
  lines already on the client barrel. Only the durable backing is missing.
- `packages/testing/CLAUDE.md` claimed its micro-DOM was the tree's only one. There are two, for
  different grammars, and they cannot be merged: `ui` is tier 4 and `testing` is tier 5.
- `docs/architecture/11-ai-surface.md` still said "a 4xx is never retried".

### Commits

- feat(cli): x shot --island photographs one component in a state you cannot click to (#334) (#336)
- feat(core): one flight layer, and the four copies collapse onto it (#332 #333) (#335)

## 11.1.0 - 2026-08-23

### Added

- **`X_ERROR_CODE_UNRESOLVED`, and a `code:` may now be a name.** `scanCodes` matched
  `code\s*[:=]\s*'X_…'` — a string literal — so `const STALE = 'X_…'` followed by `code: STALE`,
  which is what a DRY author writes, was a declaration to nobody: no manifest row, no wiki row
  demanded, nothing for `bun run gate-codes`, and `x errors explain` answering
  `X_ERROR_CODE_UNKNOWN` for a code the build throws. Silent, in the permissive direction (#277).
  `scanCodeDeclarations` is now the one pass: it resolves the identifier against the same file's
  module-scope consts and reports every name it cannot resolve as `X_ERROR_CODE_UNRESOLVED`.
  Cross-file resolution is refused deliberately. Measured over the framework and both tracked apps:
  **0 findings**, enforcing outright with no pin table; the code set moved 554 → 555, nothing else.

### Commits

- fix(cli): a code declared behind a same-file constant is a declaration, and one behind anything else is a finding (#277) (#330)

## 11.0.0 - 2026-08-23

### Added

- **`/favicon.ico` is answered on every served surface.** `x dev`, `x serve` and the static export
  all carry a favicon: the app's own `apps/web/site/favicon.ico` when one exists, otherwise a
  32×32 default the framework draws itself. Every scaffolded app 404'd on it before (#272), and a
  permanent console error trains the reader to ignore console errors.
- **`X_ERROR_FIX_PATH_MISSING`** — a `fix:` that cites a file path or glob this tree does not have
  is now refused by the `errors` step, beside the `x <command>` rule (#274). `X_UI_RUNTIME_MISSING`
  named a line no generator wrote and passed every gate since it shipped; 117 path citations read,
  zero offenders under the rule as it ships.
- `@ultimat3/cli` declares `@ultimat3/flags` and `@ultimat3/money` as dependencies, which
  `x errors explain` already imported at run time (#283). In an app that did not depend on them,
  41 documented codes answered `X_ERROR_CODE_UNKNOWN` while the wiki promised they resolved.
  `error-catalog.test.ts` now derives the importable set from `package.json`.
- **Error pages a browser can read, and an app can override.** A production process answered a
  browser's 404 or 500 with `problem+json` — carrying the internal `cause` and the author-facing
  `fix:`. Now a request that accepts HTML gets the framework's error page: status, code, request
  id, nothing off the throwable, a footer linking the Ultimate repository and developerz.ai. Copy
  is the catalog's `errors.*` keys, declared since 1.0 and read by nothing until now. Override one
  per status with `apps/web/site/errors/<status>.html`, served byte for byte and read per request;
  `x build --target static` writes `404.html`. `x dev` keeps the overlay.
- **`X_LIVE_ROUTE_NO_ISLAND`** — a route whose module graph reaches a live hook and declares no
  island (or `hydrate: 'never'`) can never receive a row; the `budgets` step now refuses it at
  build time instead of a 500 on first request (#271's second half). `examples/dummy`'s `/feed` is
  now a real island that connects, subscribes by name and renders the snapshot.
- **`x new` scaffolds a development authenticator** (`apps/web/app/auth/dev-actor.ts`, installed
  in `development` only), so a fresh app no longer boots with `X_CONFIG_INVALID: 7 route(s)
  declare auth: 'required' and no authenticator is configured` and `/dashboard` opens. A deploy
  still warns until the app issues sessions. `@ultimat3/http` joins the scaffold's dependencies —
  it was absent.
- **`docs/idea/21-the-range.md`** — who Ultimate is for, homework to very large, measured at the
  small end (`x new` asks 0 questions, 136 files, 4 commands to a running app) and anchored at the
  large end (the gate, the tiers, the ladder, the realtime numbers), with the model-cost axis
  stated: enforced conventions and errors-as-instructions matter more with a cheap model.
  Linked, never restated, from `README.md`, `wiki/Home.md`, `llms.txt`, the FAQ and ops.
- **A server render gets a live client instead of a 500.** With no DOM, every `@ultimat3/realtime`
  hook falls back to `serverRenderLiveClient()` — `loading`, no rows, no subscription — so a page
  whose body reads a live query renders its loading branch on the server and the browser takes
  over on hydrate (#271). `mutate()` / `drain()` there are **`X_LIVE_SERVER_RENDER`**, a new code;
  `X_LIVE_CLIENT_MISSING` now means a *browser* with no registration. `LiveClientLike` is the
  structural seam the hooks read — a subclass would have put the `LiveClient` class on the island
  graph (8,368 B → 26,571 B, measured).
- **`@ultimat3/ui`'s Solid-runtime slot is its own module** (`theme/runtime-slot.ts`), so an
  island that only calls `setSolidRuntime` no longer carries `@ultimat3/core`'s error registry:
  5,719 B → 72 B (#275). Component subpath exports were measured and refused — the barrel and a
  deep import emit byte-identical chunks; `barrel-bytes.test.ts` pins both facts.
- `buildIslands` byte reproducibility is pinned on `examples/dummy`'s real islands (#273). The
  ±377 B flap is Bun 1.4.0's tree-shaker racing on a `sideEffects`-declared module, reproduced
  with no plugins; the recipe is in the test header.

### Changed

- **The `worker` role drains in two phases, and its wait is bounded.** `accept` stops claiming and
  returns; `close` waits out the in-flight jobs — now counted with `beginWork()`, so the drain's own
  in-flight phase does the waiting — and closes the driver under the deadline the hook is handed.
  One `accept` hook doing all of it spent the whole budget before `@ultimat3/http`'s "stop
  listening" and `listenSyncNode`'s "stop upgrading" had been invoked at all: 4 hooks started, none
  finished. Behaviour change: a job that outruns `configureLifecycle({ deadlineMs })` is now
  abandoned (`jobs.worker.drain-abandoned`) and the queue redelivers it, where the teardown used to
  hang forever with the driver open. Raise the budget past your slowest job.
- **The `scheduler` role drains the same way.** `accept` stops dispatching, `close` waits the round
  out and hands the lease back under the deadline. An ABANDONED round deliberately keeps the lease
  and lets it expire: releasing under a live dispatch promotes a standby onto the occurrence this
  node is still enqueueing for, which is the double-fire leader election exists to prevent.
- **A `sync` node's `drain()` waits for its presence leaves to land**, in bounded chunks of sockets,
  before it releases and closes the hub. Started and never awaited, the process could exit with them
  on the wire and every other node rendered every drained member for a full TTL — the rolling-restart
  double vision the leave exists to prevent. `drain()` now resolves later by one bus round trip.
- **The scheduler re-asserts leadership before EVERY task, not once per round.** A 30s lease and a
  serial walk leave the tail of the round dispatching under a lease another node already took, and
  the occurrence key does not absorb it: `SQL_ENQUEUE`'s conflict target is partial over the live
  states, so a duplicate landing after that job finished inserts a new row and the handler runs twice.
- **BREAKING — `@ultimat3/render`: `isrKey(url, locale)` takes the negotiated locale as a required
  second argument, and it is part of the store key.** An app with more than one locale was serving
  the first visitor's document to every later one for the whole TTL, and telling the CDN to do the
  same; `vary: accept-language` is emitted now.
- **BREAKING — `@ultimat3/render`: `IsrStore` gains a required `markStale(path)` member.** A custom
  store implements it in place; `set()` means "just generated" and orders eviction — `markStale`
  through `set` refreshed the stalest pages' position. Regeneration also samples a cache fence, so a
  bust landing mid-render is no longer erased by pre-write HTML (a tag-only route served it forever).
- **BREAKING — `@ultimat3/http`: `config.drainTimeoutMs` is `number | null`, default `null`.**
  `createServer` no longer calls `configureLifecycle` unless the app declared one, so
  `configureLifecycle({ deadlineMs })` — the remedy `X_SHUTDOWN_TIMEOUT` prints — is no longer
  reverted to 15 s at boot.
- **BREAKING — `@ultimat3/http`: an unclassified 5xx problem document no longer carries the
  exception's own text in `title` / `detail` / `cause`.** A `pg` message quoting the rejected row,
  a driver message quoting the DSN, went to any non-HTML client in production. `dev: true` is
  unchanged; the text stays on the log and error-report path. `code`, `fix` and `requestId` remain.
- **BREAKING — `@ultimat3/http`: a request carrying an identity gets `private, max-age=0` even when
  the handler declared a shared `cache-control`** (`immutable` excepted), and every shared response
  varies on `cookie` and `x-timezone`. An ungated `ssr` page — the shape `x g route --surface app`
  scaffolds — answered `public, s-maxage=30` with a signed-in name in the body. The `cache-headers`
  stage is the one owner; a render mode states intent.
- **BREAKING — `@ultimat3/ui`: `initialsOf(name, locale)` takes a required locale.** `<Avatar>`
  upper-cased against the host's ambient locale (`İ` on a `tr` server, `I` in the browser).
- **The framework's CSP admits its own hydration runtime in production.** `script-src` was
  `'self' 'wasm-unsafe-eval'` with no hash, while the runtime is an inline module — report-only in
  `x dev`, enforced in a container, so no island ever booted after deploy. `startWeb` now hashes the
  seven runtime bodies (`HYDRATE_RUNTIME_BODIES`) into `script-src`, as it already did for styles.
- **`holdUntilShutdown` reaches the exit.** The one production `installSignalHandlers` call was
  `exit: false` and `release()` re-awaited the teardown the drain had just abandoned, so an overrun
  wedged the process until the kubelet's SIGKILL — the job lease lapsed and another worker re-ran it.
  `release()` runs under the drain's remaining budget; `runRole` passes the exit.
- `X_CSP_DIRECTIVE_INVALID` — `security.csp.extend` with a malformed directive name or source is
  refused at `defineHttpConfig`; `{ toString: [...] }` threw a bare `TypeError` at boot.
- **BREAKING — `RetryPolicy`, `DEFAULT_RETRY`, `retryDelayMs`, `shouldRetry` and
  `BackgroundSyncOptions.retry` are deleted (`@ultimat3/pwa`).** This package schedules no retry
  and never did: the one-shot `sync` handler rejects and the PLATFORM decides when to wake it
  again. Only `maxAttempts` ever reached the worker, as a `SYNC_MAX_ATTEMPTS` constant nothing
  read, and the emitted `X_PWA_SYNC_INCOMPLETE` fix told the reader to raise
  `pwa.backgroundSync.retry.maxAttempts` — a key `PwaConfig` has never carried, because
  `backgroundSync` is a boolean. Delete the import; there is nothing to replace it with, and
  `wiki/Error-Codes.md` already said so.
- `@ultimat3/mcp` audits the resource surface: `auditResourceRead` / `McpResourceAuditEntry`, log
  event `mcp.resource-read.<outcome>` for hidden, scope-denied, ok and failed — an enumeration alert
  should match `mcp.tool-call.*` **and** `mcp.resource-read.*`. `resources/list` stays silent, as
  `tools/list` does: a pre-filtered list reveals nothing the caller cannot already read.
- Admin over MCP carries the operator's `orgId` to every authz decision and into the ambient
  actor; it was dropped at both hops, so an org-scoped rule could not fire and entity tenancy
  derived no predicate (26 of 26 decisions measured with `orgId` absent).
- `bun run secret-compare` reads names case-insensitively, as its comment always claimed:
  `SESSION_SECRET`, `API_KEY`, `CSRF_TOKEN`, `password`, `otp` were invisible to it. The suffix
  rule requires a boundary so a bare `key` stays out. Two new pins (`storage`, a published dev
  literal; `core`, a PNG magic number).
- Every sort that is projected into a committed artifact is a code-unit compare: the service
  worker's route table, the precache manifest, `docs-search`'s tie-break and `docs-scan`'s corpus
  were `localeCompare`, an ICU property the file headers' byte-identical promise denied.
- The memory job driver clears `visibleAt` / `claimedBy` on ack and nack, as `SQL_ACK` / `SQL_NACK`
  do; `x jobs show` under `x dev` reported a settled job as still leased.

### Fixed

- **`maxConnections` is re-asked after `authenticate` resolves**, beside the readiness recheck that
  already was. Read once, the cap decided against a socket count that was already history: a restart
  storm parks every client of a dead node in the token service at once, and `maxConnections: 2` with
  ten parked upgrades took ten sockets — reproduced, `upgraded 10, shed 0`.
- **A worker's fleet slot is released before the driver closes.** `void fleetSlots.release(...)` left
  the `x_job_leases` DELETE on the wire when the teardown returned, so the row held its slot for a
  full TTL and a `concurrency: 1` job was unclaimable by the replacement pod for one visibility
  window after every deploy.
- **A lease/slot renewal interval is `unref`ed.** Armed from inside a job run, a refed one was the
  single thing holding a drained process open — past every phase of the shutdown, until SIGKILL —
  once the drain abandoned the hook that would have stopped it.
- **A replayed backfill batch writes no ledger row.** `ledger.progress` sits outside `step.run`, so a
  resumed pass re-issued one `x_backfills` UPDATE per already-completed batch before reading a single
  new row — 4,800 statements on a 5M-row sweep killed at batch 4,800, on every attempt, inside the
  visibility lease. The value is absolute, so the first batch that runs reports everything behind it.
- A dynamic `static` route was always `X_BUDGET_UNMEASURED`: the prerender recorded the filled path
  (`/blog/hello`) and the budget looked up the pattern (`/blog/:slug`). One row per route, heaviest
  page wins.
- A urlencoded or multipart body collapsed a repeated field (`tags` ×3 → `'c'`) where the query
  parser built an array; one collector now serves all three.
- `bunx create-ultimate` with no name told the reader to run `x new myapp` — `x` is by definition
  not installed yet; the fix line names the invocation used.
- `examples/dummy`'s island-bytes test pinned byte equality on an island whose graph reaches a
  `sideEffects`-declared module, which Bun 1.4.0's tree-shaker drops about one build in sixty
  (#273, #276); the classification is now derived from each island's import graph, equality is
  asserted on the pure ones and a documented band on the rest.
- `/_x` stayed unstyled for the process life after one transient `@ultimat3/ui` import failure;
  the rejection is no longer memoised.
- `x new <name>` was lint-red on run one whenever the name sorted after `ultimat3`: every
  template emitted the `@<app>/…` import above `@ultimat3/…`, the only order Biome's
  `organizeImports` accepts for names a–t. `sortedImports` orders every emitted block;
  `generate-format.test.ts` now scaffolds `zebra-demo` through the real Biome.
- `x new /abs/path` slugified the path into a directory inside the current repository and
  `git init`ed it. It is refused with the invocation meant: `x new <name> --dir <path>`.
- One documented first run: `x new`'s closing line said `bun install && x db gen … && x dev`
  while the scaffold's own README and CI say `bin/setup`. Eight doc pages told readers
  `cd myapp && x dev`, which fails on `X_BUILD_FAILED` because `x new` installs nothing — every
  one now says `bin/setup`. `wiki/Installation.md` listed six `x new` flags that do not exist.
- Docs falsified against 10.0.0 and corrected: `realtime.tier` (deleted — tier 3 is
  `persist: true` on a query), `ServeOptions.runtime`, the jobs driver seam, the shared
  rate-limit store, the `x dev` transcript, `.x/pgdata`, the tutorial's file and step counts.
- The memory entity driver answered `eq null` / `neq null` / `in [null]` differently from Postgres
  for a column the row never named — reachable through the repo/seed seam and, always, through a
  NULL money column's parts. Absent and NULL are now one value to every predicate, as the file's
  own header promised.
- `memoryRepo.updateWhere` judged a cross-tenant patch per merged row, so a filter matching zero
  rows answered `0` where Postgres throws `X_TENANCY_ROW_MISMATCH`. The patch is judged first,
  on both drivers.
- `MemoryAdapter.createUser` refused a second user with `externalId: null`, which every OAuth
  sign-up without an external-id grant passes — the second first-time OAuth user on a memory-backed
  app failed `X_AUTH_WRITE_FAILED`. `x_users.external_id` is `text unique`, NULLS DISTINCT, and the
  adapter now agrees. `takeVerification` stamped `consumedAt` with the issue time; it reads a clock
  — **`new MemoryAdapter(clock?)`**, defaulting to the system clock.
- `beginStatement` interpolated `options.isolation` into `raw()` SQL; the three levels are now
  re-derived from the closed set and anything else is `X_SQL_UNSAFE`.
- `readOnlyQuery('select 1; -- note')` passed the one-statement guard and then emitted
  `DECLARE … CURSOR FOR select 1; -- note`, an uncoded driver error. The cursor splices the
  splitter's own first statement.
- `createLogger({ level: 'verbose' })` built a logger that failed **open** (every level emitted).
  An unknown level is refused at construction; `LOG_LEVEL` from the environment is still filtered.
- `seriesKey` in `@ultimat3/core` metrics was not injective across attribute values carrying the
  pair separators; two label sets could merge into one series.
- `escapeXml` left XML-1.0-illegal control characters verbatim, so one byte in a feed item's title
  made the whole document not well-formed; they are stripped in element text, attributes and CDATA.
- `defineAuth()` retained two limiters per call for the life of the process; one per distinct
  window is kept.
- `srcsetFor` in `@ultimat3/ui` emitted a variant `src` holding whitespace or a leading/trailing
  comma verbatim, which the browser parses as a different URL and drops in silence; it is now
  `X_UI_INVALID_VALUE`.
- `x db backfill <name> --list` silently dropped the positional and listed the whole ledger with
  `ok: true`. It is now `X_CLI_BAD_FLAG`, with `--name` as the fix.

### Commits

- fix: the CSP admits its own hydration runtime, cache-control has one owner, ISR keys by locale, and the drain reaches the exit (#328)
- docs: the range — homework to very large, measured at both ends — and fifteen pages corrected against 10.0.0 (#327)
- fix: error pages a browser can read and an app can override, X_LIVE_ROUTE_NO_ISLAND, and two audit sweeps (tiers 0–2, 3–5) (#326)
- fix: a server render gets a live client, fix: paths must resolve, /favicon.ico answers, and the ui runtime slot (#271 #272 #274 #275 #283) (#325)

## Older releases

`10.0.0` and everything before it are **in git history, not in this file**. This file is capped at
1,000 lines: a changelog nobody scrolls to the bottom of is a changelog nobody reads, and every
deleted line is one `git show` away.

| Want | Run |
|---|---|
| one past release's section | `git show v10.0.0:CHANGELOG.md` — or any tag; every release from 1.0.0 on is tagged |
| when a line was written, and by whom | `git log -p --follow -- CHANGELOG.md` |
| the whole file as it stood at the last full release | `git show v13.0.0:CHANGELOG.md` |
| what a major broke, without git | [`wiki/Upgrading.md`](https://github.com/developerz-ai/ultimate/wiki/Upgrading) — it walks **every** major, oldest first, and is deliberately NOT truncated |

**The upgrade guide is the one that has to stay complete**, and it does: a reader upgrading across
four majors needs every walkthrough in order, where a reader of this file wants the last release.
Two documents, two jobs — `bun run changelog-check` reads the oldest `## X.Y.Z` heading still here
as the retention boundary and stops demanding a section below it, so trimming this file again is
deleting sections and nothing else.
