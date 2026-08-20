# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Pin `@ultimat3/*` exactly; a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers.

## [Unreleased]

Six bug sweeps since 3.0.0. The second was six independent auditors over the packages the 3.0.0
sweep did not reach; the third added a whole-repo security pass and an architecture review, and
found more than the first two combined; the fourth closed the known-gaps backlog; the fifth
typechecked the 966 test files no compiler had ever read and then deleted what nothing calls; the
sixth closed the known-gaps backlog and mounted two gates that had been built and never wired.
**Twenty-six** of the entries below are breaking changes to documented APIs and one needs a
migration run, so the next release is a major.

Four findings are worth reading even if you skip the rest, because each was a guarantee the code
stated in a comment and did not keep: every authenticated websocket carried `actor: null`, every
`Date` in a query input collided into one cache key, the scraping wedge watchdog's abort signal was
built and handed to nobody, and `references(() => t.id, { onDelete: 'cascade' })` had type-checked
since 1.0 while reaching no SQL at all.

### Removed — BREAKING (sixth sweep: the known-gaps backlog)

- **BREAKING — `CaptureOptions.timeoutMs` and the public `CaptureRequest.timeout` are deleted from
  `@ultimat3/scraping`** (#211). The port required it, `page-over-target.ts` threaded it, and **no
  driver honoured it** — `cdp-target.ts` reads only `fullPage`, its `pdf` names the parameter
  `_options`, and `html-target.ts` ignores it. Deleted rather than honoured for a reason worth
  recording: the CDP port's own `screenshot({ fullPage })` has no timeout slot to forward to, and a
  generic deadline in `page-over-target.ts` would have to race `ScrapeClock.sleep` — which under
  `testClock` advances the clock and resolves on the first microtask, so the deadline would win
  every race and **every capture in every test would time out**. A knob no driver honoured takes
  nothing away when it goes; a deadline that fires in tests and not in production would. Both
  layers went, because leaving the public `CaptureRequest.timeout` behind would make it the new lie.
- **BREAKING — `ScrapeTarget.click`'s `index` parameter is deleted** (#212). The HTML driver
  honoured it and the CDP driver dropped it, and they agreed only because the sole caller passed
  `0`. The decisive fact: **`index` was unreachable from the public vocabulary** — `ScrapeFrame.click`
  takes `(selector, options?: WaitOptions)` and has no index, so no app could set it. A port member
  no caller can reach, honoured by one driver and dropped by the other, is a divergence waiting for
  an app to find. A three-driver parity test over a multi-match fixture now covers it.
- **BREAKING — `adminResource` no longer pluralises an entity name.** `@ultimat3/admin` carried a
  private English pluralizer, and **every entity in both tracked apps is already named plural** —
  so `entity('orgs')` was served at `/admin/orgses`, with `/admin/medias` and `/admin/likeses`
  queued behind it. The fix is a deletion rather than a better pluralizer: which plural a name
  takes is an app's convention, not a mechanism the framework can own (axiom 8), and `path:` was
  always the override. Migration: an app relying on the old doubled URL sets `path:` explicitly.

### Added (sixth sweep)

- **`X_SCRAPE_YIELD_HISTORY_MISSING`** (#154) — `expect.maxDrop` measures a fall against a trailing
  baseline, and with no `history:` store `expect.ts` reads `[]` forever, so `X_SCRAPE_YIELD_COLLAPSED`
  could never fire. A silent no-op in a scrape *expectation* is a scrape that cannot fail. Refused
  at declaration time, where it is written, before any attempt exists. `expect.minRows` is an
  absolute floor checked *before* the history gate and stays legal on its own.
- **`StorageDriver.verifySigned` and `X_STORAGE_URL_UNVERIFIABLE`** (#145) — `acceptSignedUpload`
  required a `secret:` that no route could supply, because the signing secret was closed over inside
  `localDriver`'s factory. `StorageDriver` already hoisted `signedUrlBase` so "the minting half and
  the verifying half cannot state it twice"; the secret was the other half of that pair and was
  never hoisted. The new member exposes **verification, never the key** — a member returning the
  secret would let any holder of a driver mint a URL for any key, and would put it in every
  `JSON.stringify(disk)` a log performs. `acceptSignedUpload` now works with no secret in the call.
  The `PUT` route is still unmounted; the seam that blocked it is not.

### Removed — BREAKING (fifth sweep: delete what nothing calls)

- **BREAKING — `PrecacheAsset.critical` is deleted from `@ultimat3/pwa`.** It was declared and read
  nowhere: `buildPrecacheManifest` copies `url`/`revision`/`bytes` and hardcodes
  `reason: 'asset'`, so `critical` never survived. The documented promise — "critical assets are
  precached even if large" — was kept by nothing, because **there is no size filter at all**;
  `warnBytes` warns on the *total* and excludes no asset, so the promise was vacuously true of
  every entry and the word distinguished nothing. Deleted rather than implemented, deliberately:
  adding the filter now would silently stop precaching assets an app precaches today, and a
  precache manifest quietly missing an entry is an app that 404s offline. Migration: delete the
  property. No runtime behaviour changes.
- **BREAKING — `PERIODIC_SYNC_TAG` and `BackgroundSyncOptions.periodicMinIntervalMs` are deleted
  from `@ultimat3/pwa`.** Periodic Background Sync was never implemented in any sense: no
  `periodicsync` listener was ever emitted, `periodicSync.register` was never called, and
  `CAPABILITIES` has no `periodicSync` flag to gate one. Two declarations describing a feature that
  does not exist, plus a tag for a registration the framework never makes, received by no listener.
  `wiki/PWA-And-Offline.md` and `docs/idea/08-pwa-offline.md` documented it as a shipping flag;
  both are corrected. Migration: delete the option.

### Fixed (fifth sweep)

- **`badging: true` on its own changes nothing, and now says so.** The badge call is emitted only
  inside the push block (`service-worker.ts:161`, gated on `push && config.vapid !== undefined`),
  while `CAPABILITIES` carries a `badging` entry and `resolveCapabilities({ badging: true })`
  accepts it — so the capability reports `true` against a worker with no badge call. Pinned by a
  test asserting both halves rather than fixed: standalone badging is a feature, and inventing one
  inside a dead-declaration sweep is a behaviour change smuggled in the side door.
- **`EnvExampleReport.extra` is reported only as a passenger on another failure.** `ok` is
  `missing.length === 0`, so `assertEnvExample` returns before building the
  `EnvExampleDriftError` that carries `extra` as `meta` whenever an undeclared key is the *only*
  finding. The doc said "Reported, never fatal"; it is narrower than that, and now says which
  reader drops it.
- **`CAPABILITY_SW_MARKERS` documented itself as "checked in BOTH directions" and the OFF loop
  iterated two hand-picked entries.** It now iterates the whole table, so a capability added later
  is covered by declaring its markers.
- **`epochMsOf`'s comment claimed a tolerance no type permits.** `Clock.now()` returns a `Date`, so
  the number branch is unreachable through the typed API; it is kept for the untyped caller, where
  it turns a `TypeError` into `X_INSTANT_INVALID`. The branch stays, the claim is corrected.

### Changed — BREAKING (fourth sweep)

- **BREAKING — `on delete` reaches the generated SQL. Any app that ever declared a rule generates
  different DDL now.** `references(() => orgs.id, { onDelete: 'cascade' })` type-checked, and the
  rule was dropped one layer below the declaration: `describe.ts` rendered the reference as the
  string `"<entity>.<column>"` with nowhere to put it, so every `add constraint` this framework has
  ever emitted said `references "orgs" ("id");` — a declared cascade under which the database
  refuses the delete instead. Drift could not see it either: the catalog answers `a`/`c`/`r` and the
  snapshot held nothing truthful, so a hand-added `on delete cascade` and its absence both read
  `ok: true`.

  **The edit:** none to your entities. Run `x db gen "<name>"` and read the diff — an app with an
  `onDelete` rule already applied by hand gets a `changed-foreign-key` difference, whose `fix:` is
  the drop/add pair, because Postgres has no `alter constraint` for a referential action. An app that
  declared a rule and never noticed it was inert gets the constraint it always asked for, and
  **child rows will now be deleted or nulled where they previously blocked the parent delete**.
  Check that before you apply.

- **BREAKING — `ColumnDescription` and `ReferenceDescription` gain `onDelete: OnDelete | null`.**
  The projection `@ultimat3/db` reads is the only path a rule can travel, since `db` is tier 1 and
  cannot import `@ultimat3/entity`. **The edit:** a hand-built description literal — a test fixture,
  a custom generator — must add the field; `null` is Postgres' `no action` and is the old behaviour.

- **BREAKING — `DriftKind` gains `changed-foreign-key`.** The key points where it was declared to
  point and one side's `on delete` rule is not the other's. Reported apart from
  `missing-foreign-key` because it is a different repair — the constraint is there, and what changed
  is what happens to the child rows. **The edit:** a `switch` over `DriftKind` with no `default` no
  longer compiles. Its `fix:` is deliberately not `x db migrate`: `add constraint` alone is `42710`
  on a name already taken and no `x db gen` diff emits either statement, so it hands over the pair.

- **BREAKING — `BranchInfo` gains `base: string | null`.** The `comment on database` marker is
  `ultimate:branch:<base>:<iso>`, split on the ISO tail rather than the first `:` because a database
  name may contain one. `reapBranches` was **source-blind**: `listBranches()` walks `pg_database` for
  the whole server, so two Ultimate apps on one Postgres plus one nightly sweep was the other app's
  branches dropped — a `DROP DATABASE` nobody asked for and nothing recovers from. It now skips any
  branch whose base is not `current_database()`, **and skips an older marker that records no base
  rather than dropping it**: a branch of nothing is not a branch of this database, which makes the
  change self-healing with no migration — the next `createBranch` writes the base down.

  **The edit:** a consumer destructuring `BranchInfo` gets a new field, `null` on every branch made
  before this. Nothing back-fills the comment; re-create a branch to give it a base.

- **BREAKING — `realtime.heartbeatMs` is removed from `RealtimeConfig`.** It was declared, defaulted
  to `15_000`, and read by nothing. The socket beat is `new LiveClient({ heartbeatMs })` — browser
  code, which cannot read server config — and the presence beat is derived
  (`PresenceRegistry.heartbeatMs` is `max(1000, floor(ttlMs / 3))`). A second knob is a second number
  that can disagree with the one it is a fraction of. `RealtimeConfig` is now
  `{ enabled, tier, transport, urlEnv }`.

  **The edit:** delete the key. **There is no runtime refusal, and this is not what the gap row
  predicted:** `section()` copies every own key of the patch and `validate()` checks only the fields
  it names, so a leftover `heartbeatMs` is silently kept in the resolved config and changes nothing.
  The only failure is at typecheck — `TS2353`, excess property on `Input<RealtimeConfig>` — and an
  app that assigns its config to a variable before passing it loses excess-property checking and gets
  **no error at all**. Grep for it rather than trusting the compiler.

- **BREAKING — `createRateLimiter({ now })` is `createRateLimiter({ clock })`.** The same `Clock`
  shape `createRequestContext`'s `init.clock` takes; a second spelling of "what time is it" is a
  second way to set one number. **The edit:**
  `createRateLimiter({ config, now: () => t })` → `createRateLimiter({ config, clock: { now: () => new Date(t) } })`.
  Callers that passed neither are unaffected — it defaults to `systemClock`.

- **BREAKING — five generators write typed test filenames.** `x verify` selects a suite by filename,
  so a generated `contractTest(…)` inside a plain `*.test.ts` ran under `unit` and `x test contract`
  answered `X_TEST_NO_FILES` — a step that passes by having nothing to run. `x g action` and
  `x g mutator` now write `<name>.contract.test.ts` beside `<name>.test.ts`; `x g query --live`
  writes `<name>.live.test.ts`; `x g job`, `x g task` and `x g backfill` write `<name>.job.test.ts`.
  `x g action`/`x g mutator` therefore emit **9** files into a bare slice, not 8, and its own 3
  rather than 2.

  **The edit:** re-running a generator with `--force` writes the new name and **leaves a file under
  the old name where it is** — the old name is not in the output list, so nothing touches it. Delete
  the orphan by hand, or the same declaration is tested twice under two step names.

- **BREAKING — a local disk's signed URLs carry the registered disk name, not the driver kind.**
  `localDriver` minted `/_storage/<driver>/<key>` while the mounted route resolves the segment
  through the registry, so a disk registered as `uploads` 404'd every signature it had just written.
  `StorageDriver.registerAs(diskName)` is optional on the interface and called by `defineStorage` at
  boot; `acceptSignedUpload` reads the base back off `disk.signedUrlBase` rather than re-deriving it
  from `disk.name`, which is what let the minting half and the verifying half agree with each other
  and disagree with the route.

  **The edit:** a URL signed before this and not yet redeemed no longer verifies if the disk's
  registered name differs from its driver's. Re-sign. A third-party `StorageDriver` that ignores
  `registerAs` keeps minting under `name`, which is the old behaviour.

### Fixed — the fourth sweep

- **A removed `references()` emits its `drop constraint`.** It emitted nothing, and that is not the
  harmless omission a removed index is: the key stayed on the database *and* the snapshot beside it
  recorded `foreignKeys: []`, actively denying a constraint the catalog held — and
  `compareForeignKeys` judges the declared side, so no check the framework runs could see it. The
  drop names the constraint the **previous snapshot** recorded rather than the name this generator
  would have chosen, so a hand-written `fk_legacy` is dropped by its own name instead of `42704`. A
  column dropped in the same migration takes its constraint with it and gets no second statement.
- **Drift compares an index's direction and its predicate's presence.** A `desc` index rebuilt
  ascending by hand served a feed's newest page off the wrong end and a partial index recreated as a
  total one silently widened the constraint, both under `ok: true`. `asc` normalises to `null` first,
  because `createIndex` writes `"col" asc` and Postgres stores that as not-descending. The
  predicate's **text** stays uncompared on purpose — the catalog answers its own rewriting
  (`(deleted_at IS NULL)`) where the snapshot holds the author's spelling, and normalising that means
  shipping an expression parser to compete with the server's.
- **`X_LIVE_REPLICA_IDENTITY` exists and fires.** It was documented and present in neither the source
  nor the manifest. `preflight` now asks `pg_class` which replicated tables sit on
  `relreplident <> 'f'` and **warns** with the exact `ALTER TABLE` per table — a warning and not a
  refusal, deliberately, because every app on the default identity would otherwise stop booting.
  `ReplicationStreamStats.partialBefore` counts the running half: every non-insert change whose
  relation is not on identity `f`. The hard `x verify` refusal is still open.
- **A malformed request body no longer echoes itself into the 422 or the log store.** The parser's
  message quotes the bytes it choked on and reached `cause:` through `String(error)`, which is itself
  a `TypeError` on a null-prototype throwable. The caller-facing half names the format alone and the
  parser's message rides in `meta` through `renderThrowable`.
- **The scaffold's `.dockerignore` no longer leaks `.env.production` or `.env.development` into the
  image.** The patterns were `.env` and `.env.*.local`, neither of which matches the file
  `docker-compose.prod.yml`'s `env_file:` tells the operator to create. Proven by a real
  `docker build`. Now `**/.env` + `**/.env.*` + `!**/.env.example` plus `**/.npmrc`, in the
  framework's file, both tracked apps' and the one `x new` writes. **An image already built still
  carries them** — rebuild.
- **`x new` writes the Helm chart** — `docker/helm`, 8 files — and `x deploy`'s
  `X_NOT_IMPLEMENTED` branch is deleted. It claimed the *build* did not implement helm, over a build
  that implemented it completely; what was actually missing was the chart in the app, because
  `docker/helm` ships in no npm tarball. An app that deletes its chart now gets helm's own error.
  The framework repo's own chart carries two templates the scaffold does not, `pdb.yaml` and
  `servicemonitor.yaml`.
- **An unknown `--method` on `x deploy` is refused rather than treated as `compose`.**
  `x deploy --method helmm` ran the six-step Compose plan and reported `method: "compose"` back to an
  operator who had asked for a Helm upgrade. It is `X_CLI_UNKNOWN_COMMAND` listing the two.
- **A planned command answers `X_NOT_IMPLEMENTED`, not `X_CLI_BAD_FLAG`.** The parser read flags
  against the spec first, and a planned command declares none — so `x logs tail --follow` reported
  the unknown flag instead of the honest status. A **shipped** command still refuses an unknown flag.
- **`x new` writes `apps/web/api/index.ts`,** so a scaffolded app's jobs and tasks register under
  their own names instead of `anonymous-job-2` / `anonymous-task-1`.
- **The robots.txt read exits through the session's proxy.** It was documented and unpassable: the
  gate is an argument to `driver.open()` while the exit is a driver option resolved inside it, so a
  value passed at construction could only ever be the one nobody has yet. `ScrapeSession.proxy`
  reports the exit and `createRobotsGate` takes a **resolver**. Without it the read left from the
  worker's IP while every page load left through the proxy — two client identities at one origin —
  and an origin reachable only through the proxy answered nothing, which the gate reads as
  allow-everything.
- **`x db branch`'s `lock:` doc comments no longer name `x db branch` as a caller.** No shipped path
  passes it; every caller in the repo is a test.

### Changed — BREAKING (third sweep)

- **BREAKING — `llm()`'s `cache.semantic.scope` receives `{ input, ctx }` and defaults to the
  calling actor.** It took the bare parsed `input` and defaulted to the literal `'global'`, and a
  semantic lookup is a cosine nearest-neighbour with no tenant predicate — so one shared store
  answered one tenant with another tenant's completion, which by construction contains that
  tenant's rows. Reproduced at similarity 1.0.

  **The edit:** `scope: (input) => input.orgId` becomes `scope: ({ ctx }) => ctx.actor.orgId ?? 'none'`,
  or delete the `scope` and take the actor-narrow default. A deliberately shared cache is now
  `scope: () => 'global'` — written down rather than inherited.

- **BREAKING — `@ultimat3/realtime` no longer exports `qidOf` or `canonicalJson`.** A qid is
  `queryHash(name, input)` from `@ultimat3/query`; the canonical form and its hash are
  `canonicalJson` / `fingerprint` from `@ultimat3/core`. The two spellings had already diverged on
  an input carrying an `undefined`-valued key.

  **The edit:** change the import. **No live subscription re-keys and nothing re-snapshots** — every
  qid a node computes comes from a `JSON.parse` result, and the two spellings differed only on
  values JSON cannot carry.

- **BREAKING — a read whose input carries a `Date`, `Map` or `Set` gets a new cache key and cursor
  scope, once.** `queryHash`'s canonical form had no `Date` branch, and `Object.keys(date)` is
  `[]`, so every date rendered `{}` and one key answered for every date window a read ever served.

  **The edit:** none. Affected cursors answer `X_CURSOR_INVALID` once with "request the first page
  again", and those cache entries are cold once. Ordinary inputs are byte-identical.

- **BREAKING — `@ultimat3/seo` no longer exports `extensionOf`.** It had no caller anywhere in the
  tree. **The edit:** delete the import; `parseImageQuery` reads the format off the query.

- **BREAKING — `ordinal(value)` takes no locale.** It selected the plural category with the
  caller's locale and appended the English suffix regardless, so `ordinal(1, 'de')` was `'1th'`.
  **The edit:** delete the second argument.

- **BREAKING — `isValidCron` / `parseCron` refuse an unsatisfiable day/month pair** such as
  `'0 0 30 2 *'`. It used to parse clean and then cost ~184ms of blocking CPU before
  `nextCronOccurrence` threw — paid per tick by the scheduler's leader loop.
  **The edit:** fix the expression; the refusal names the pair.

- **BREAKING — `requiresApp` is enforced by the dispatcher.** The field was documented "the
  dispatcher enforces it" and the dispatcher never read it; the guarantee held only because all 17
  declaring commands happened to call `requireAppRoot` themselves. Outside an app, `x secrets set`
  and its siblings now answer `X_NOT_IN_APP` rather than a refusal naming a flag that does not
  exist. **The edit:** none, unless a script matched on the old message.

### Migration — run this

- **The `x_jobs` idempotency index gains the tenant.** It was `(name, idempotency_key)` while the
  row already carried `tenant_id`, so two tenants deriving the same natural key — every shape the
  docs suggest, such as `` `invoice:${input.invoiceId}` `` — shared one dedupe slot: one tenant's
  work never ran, with no error and no dead letter, and its caller received the other tenant's job
  id, which `cancelJob` accepts with no tenant predicate.

  Re-run the boot install of `SQL_JOBS_TABLE` (`x db migrate`, or the release-phase `ROLE=migrate`
  step). It drops the old index and creates `(name, coalesce(tenant_id, ''), idempotency_key)` —
  `coalesce` because a null compares unequal to every other null under a unique index, which would
  lose dedupe entirely for an untenanted queue. Every statement is `if exists` / `if not exists`,
  and there is **no data backfill**: existing rows already carry `tenant_id`.

  Two operational notes. The `create unique index` is **not** `concurrently`, so on a large
  `x_jobs` it is a brief blocking build — apply it in the release phase, not under load. And the
  window between the drop and the create is unprotected, so a duplicate enqueue landing in it
  inserts two live rows. A rolling deploy is otherwise safe: old pods keep their own SQL and dedupe
  more coarsely until they cycle out.

### Fixed — the third sweep

Each PR names the defect it closes; these are the ones an operator would have seen. Every
authenticated websocket carried `actor: null`, because Bun runs `websocket.open` synchronously
*inside* `server.upgrade()` and the grant was recorded on the next line — so every channel
subscribe on an authenticated client was denied, per-row visibility decided about nobody, and
`maxPerTenant` never applied. The scraping wedge watchdog's abort half was never wired and its
`kill()` is a no-op on the attach path, which is incident #1 in that file's own header, still open.
Admin authorization was evaluated with `orgId: undefined` and `row: null`, so an org-scoped or
ownership rule could not fire. `resources/list` and `resources/read` took no caller at all, so any
token could enumerate and read every resource. A thrown code named `toString` made
`Pipeline.handle` reject. `localDriver.list()` omitted every dot-prefixed key, so the orphan sweep
reported a clean run over objects still on disk. A flag allow list delivered as a string did a
**substring** match. And every app tool call over stdio answered `X_NO_CONTEXT`, because nothing
installed a root context.

### Also changed, no migration

`parseDuration` accepts `PT0S` / `PT0H0M0S` / `PT0M` / `P0W`; `toSeconds('-1500ms')` is now −2
(was −1); `formatDuration(…, { maxUnits: 0 })` throws rather than rendering `"0 sec"`;
`addBusinessDays` refuses a fractional or `NaN` count; `configureTime({ defaultZone })` refuses an
unknown zone at boot instead of at render time; `t.date` refuses a date-time with no offset;
`applyFlagSnapshot` refuses malformed targeting it used to accept; `in` with a non-array operand
matches no rows on **both** drivers; `ctx.signal` now aborts when the caller disconnects and not
only when the deadline passes; and the entity write path reads `ctx.clock`.

### Changed — BREAKING (second sweep)

A second bug sweep, run by six independent auditors over the packages the 3.0.0 sweep did not
reach. Five of the entries below are **breaking changes to documented APIs**.

### Changed — BREAKING

- **BREAKING — `NackOptions.countsAsAttempt: false` no longer files a job `suspended`.** Both
  drivers derived state as `deadLetter ? 'dead' : counts ? 'ready' : 'suspended'`, so "do not burn
  an attempt" and "this is a `step.sleep` suspension" were one flag — and the worker's limiter and
  `job.concurrency` sheds use `countsAsAttempt: false`, because a shed is not a failed attempt. Those
  rows were then excluded from `ready` and `oldest_ready_ms`, which `worker.ts` publishes as
  `queue_depth` and `queue_oldest_ready_seconds`: measured at 20 jobs with `concurrency: 10` and
  `createLimiter({ global: 1 })`, `ready` fell 20 → 10 while 19 were still waiting. Under sustained
  overload the scaling signal and the "oldest job older than five minutes" page both go quiet
  exactly when the queue is saturated.

  **The edit:** a genuine suspension now passes `park: true`; `countsAsAttempt: false` means only
  "do not increment the attempt counter". Every caller inside the framework is updated. A
  hand-rolled `JobDriver` that ignores `park` keeps its old behaviour, so the change is opt-in for
  a third-party driver and mandatory only for callers of `nack`.

- **BREAKING — `registerFrameworkCatalog()` takes no `locale`.** It was
  `registerFrameworkCatalog(locale)`, and `defineCatalogs` called it once per locale — registering
  the English-only framework catalog under every locale an app declared. An app shipping only `es`
  served `Page not found` and English `ui.*` chrome with `isMiss` reading **false**, so nothing
  downstream could see the gap; `assertCatalogsComplete` could not either, because `CatalogSet.catalogs`
  carries app strings only. That is a fallback locale chain, which `packages/i18n/CLAUDE.md` forbids
  by name.

  **The edit:** delete the argument — `registerFrameworkCatalog()`. **An app shipping a locale it
  has not fully translated now renders `⟦key⟧` for the framework keys it is missing**, which is the
  golden rule working. Translate those keys into the app's own catalog, which is the same merge an
  override already is. The function is also genuinely idempotent now; it was documented as such and
  was not, so a second call used to revert every app override of a framework key.

- **BREAKING — `t.date` refuses a date-time with no offset and no `Z`.** It accepted
  `2026-08-19T10:00` and resolved it against the **host process's** zone, so one wire value meant
  `14:00Z` on one pod and `10:00Z` on another — reachable from a request, since `coerceQuery` routes
  a `t.date` field through the same case, and published as `format: 'date-time'`, which RFC 3339
  requires an offset for. This is the repo's "no date without an explicit IANA `timeZone`, no
  ambient default anywhere" non-negotiable failing at the parse end.

  **The edit:** send an offset or `Z` — `2026-08-19T10:00:00Z`. A date-only form (`2026-08-19`)
  carries no clock time and still passes, being UTC by specification.

- **BREAKING — `in` with a non-array operand matches no rows on both drivers.** It matched one row
  in Postgres (the scalar was wrapped into a one-element list) and none in memory. `in` with a NULL
  in the list was the same disagreement in the other direction: the NULL row matched in memory and
  nothing in Postgres, because `col = NULL` is UNKNOWN. Both now answer as `@ultimat3/query` already
  documented, and the SQL emits `(col in (…) or col is null)`.

- **BREAKING — `registerMailCatalog()` takes no `locale`.** Same defect as the framework catalog:
  it seated English subjects and headings under whatever locale it was handed. Not idempotent, and
  its comment claimed it was — stated plainly in the source now rather than guarded, because a guard
  by content needs an i18n primitive that does not exist and a remembered flag goes stale the moment
  `resetCatalogs()` runs.

### Fixed

- The entity write path reads `ctx.clock`. `defaultNow`, `touch`, the soft-delete stamp, `removal`
  and `seed.now` all read `systemClock` directly, so a frozen test clock drove nothing the framework
  wrote. Byte-identical outside a request.
- Everything else in PRs #179–#186, each of which names the defect it closes.


## 3.0.1

### Added

- four conventions become build errors, and two were already broken
- typecheck the tests, on a ratchet — 966 files the gate never read (#208)
- canonicalJson, fingerprint and compareDecimalText — one home for three that had two (#191)

### Fixed

- the production image ran the dev server, and nothing built it (#215)
- two documented options that no caller could make effective (#207)
- both tracked apps could bake .env.production into their image (#206)
- secrets shipped inside the production image, and four other things x new got wrong (#205)
- delete a knob nothing read, stop echoing request bodies, and check the identity live queries depend on (#203)
- the generated schema told four lies, and drift could see none of them (#202)
- the error-render gate could not see the shape it let through six times (#198)
- the wedge watchdog's abort half was built and never wired (#197)
- the semantic cache defaulted to one store for every tenant (#196)
- qidOf was queryHash written twice, and the two already disagreed (#195)
- every Date collided into one cache key, and two tenants shared one dedupe slot (#194)
- a thrown code named toString made Pipeline.handle reject (#193)
- an allow list sent as a string matched every subject containing it (#192)
- 90 recorded ranges said 1.2.0 and 2.0.0 while every package.json said 3.0.0 (#190)
- deleting every scheduled task and dropping every primary key was a clean x verify (#185)
- the icon name from network data reached a filesystem path and a TypeScript identifier (#186)
- a permanent mail refusal was retried five times, and one document indexed as nine copies of one sentence (#184)
- every authenticated websocket carried actor: null, and the test stub hid it (#183)
- a limiter shed vanished from queue_depth, silencing the HPA exactly when saturated (#182)
- an actor holding a role named "constructor" turned every authz denial into a 500 (#181)
- an app shipping only Spanish served English error pages, and nothing could see it (#180)
- a declared field named toString was unsatisfiable for every input (#179)
- two admin actions could share a name and dispatch to the wrong one (#178)
- an ISR route with a policy served the first actor's HTML to everybody (#177)
- an unreadable TOTP secret verified against a code needing no secret (#176)
- a serialization retry budget of NaN ran the transaction zero times (#175)
- three of these bugs were reachable through a key nobody typed (#174)
- close the four deferred issues — and two of them were not what their issue said (#163)

### Changed

- a direct grant was unspellable, and userActor silently dropped it (#218)
- delete two declarations that describe features nothing implements (#217)
- the last 102 test typecheck errors, and RowPatch could not spell the value it refuses (#216)
- 229 more test typecheck errors, and the fetch seam no caller could fill (#214)
- the tests typecheck, and four of the errors were the type being wrong (#210)
- the gap registry said "fixed" about six things that were not, and "open" about fourteen that were (#209)
- replace a stale economy measurement with a reproducible one (#204)
- all 30 packages clear 95%, and six bugs found while getting there (#201)
- ui moves 5 → 4, and the admin → ui exception is deleted (#200)
- three sweeps, twelve breaking changes and one migration — the next release is a major (#199)
- how much code you do not write, and why the bugs matter more than the lines (#189)
- one job per package — its own tests, its own lint, its own coverage bar (#188)
- the second sweep landed five breaking changes, and the next release is a major (#187)
- 3.0.0 is on npm, and the publishers were re-attached, not attached (#162)


## 3.0.0 - 2026-08-19

The first release the workflow has published since 1.2.0. Every package has an OIDC trusted
publisher again — **re-attached, not attached for the first time**, and this time with
`Environment: npm-publish` set. The registry records the history: `@ultimat3/core@1.1.0` and
`@1.2.0` were published under `oidc:b02ce1e0…`, `@2.0.0` under no publisher at all, and `@3.0.0`
under a new `oidc:53a7edab…`. So a publisher existed, was lost or removed before 2.0.0 — which is
why that release was hand-published with no attestation — and nothing noticed until now. `@ultimat3/scraping` — 404 since it
landed after the 2.0.0 run — was bootstrapped by hand at 2.0.0 so the derived publish list can
reach it here.

Whether this release *did* publish with provenance is a fact about the registry, not about this
file: `npm view @ultimat3/core@3.0.0 dist.attestations` answers it.

A major because a five-agent bug sweep landed breaking changes to documented APIs. The
entries below are that sweep; each names the manual edit it costs.

### Added

- **`agent()` — the tool loop, as an action factory.** The third instance of the rule after `llm()`
  and `backfill()`: a tool-using run is one server-authoritative operation with an input schema, an
  output schema and a policy, so `agent()` returns an `action` and inherits `.tool()`,
  `.openapi()`, `.client()`, `.job()`, `.contract()` and its manifest row.

  `tools` takes the **real `action()`s an app already wrote** — `agent({ tools: [lookupOrder,
  issueRefund] })`, the imports themselves. The list took a hand-shaped `ProjectableAction` alone
  until now, which no `action()` structurally satisfies (an action carries
  `as`/`tool`/`openapi`/`job`/`contract` and never `run`), so the documented shape was a `TS2741`
  against every real action and the only thing that satisfied it was a stand-in written for a test
  — which is why the suite stayed green over an API that did not compile (issue #124). Every tool
  must be `mcp: { expose: true }`, checked at **declaration** (`X_AGENT_TOOL_UNEXPOSED`), so an
  in-app agent and an external MCP client are offered exactly the same catalogue.

  Because an agent **is** an action, an agent is a tool of another agent with no supervisor
  primitive anywhere.

- **`agent()` honours `ctx.signal`.** Read at the top of every turn, before every tool batch, and
  forwarded to the transport on `GenerateRequest` — so a provider call already in flight is cut
  rather than paid for. The transcript IS the request, so a loop that kept going after the caller
  disconnected re-sent it once per remaining turn, ran every remaining tool's side effects, and
  discarded the answer.

- **`onTurn` on `agent()`.** One call per completed model turn, before the answer or the tool calls
  are acted on, carrying `{ turn, maxTurns, model, toolCalls, stopReason, usage, cost }` — this
  turn's cost alone, never a running total. A 90-second run emitted nothing until it returned, so a
  progress indicator, a per-turn spend line and a transcript log all had to be hand-rolled outside
  the framework, which is exactly the loop `agent()` exists to replace. Observation only: it cannot
  steer the loop, see the transcript or reach the actor, and a throw from it **fails the run**
  rather than being swallowed. The same facts always land on the span as an `agent.turn` event.
  It is not `.stream()` — tokens on a screen is a different contract, and `agent()` has no
  `.stream()`.

- **Tool calls within one turn run concurrently.** One `Promise.all` over what a single model turn
  asked for, deliberately unbounded: each entry is an ordinary `action` with its own `policy` and
  `rateLimit`, and a second ceiling here would be a throttle competing with those. Results pair
  **positionally**, each carrying the `tool_use` id it was handed, so a fast tool answering first
  cannot be paired with a slow tool's call. Serial cost 5x wall clock for a turn asking for five
  tools, and nothing in the types or the docs ever said so.

- **`hive()` — one action fanned out over many inputs.** The fourth factory over `action()`.
  `member` is any action, most usefully an `agent()`. Bounded `concurrency` (default 4) over a
  shared cursor, results in **split order** with `index` on every arm, and a **three-way** member
  outcome — `ok`, `failed`, `skipped` — because *ran and threw* and *never ran* are different facts
  and an aborted sibling is the second. `onMemberError` is required, no default: `'abort'` stops
  and leaves the rest `skipped`, `'collect'` harvests the rest, and both are right for somebody.
  `minMembers` (default 2) stops paying for a pool on a trivial split and **drops nothing**. An
  empty split is `X_HIVE_EMPTY`, because "0 ok, 0 failed" cannot be told apart from a query that
  returned no rows and nobody noticed.

- **`agentJob()` — an agent as durable background work.** `As of 2026-08` the only way an agent
  reaches a queue at all: `.job()` hands back `kind: 'action-job'`, and `isJobHandle` needs
  `kind === 'job'` **plus** membership of a `WeakMap` only `job()` writes, so nothing externally
  shaped has ever reached the registry, the worker or the dead-letter path (issue #125). It
  composes `job()` rather than imitating a handle, so `.enqueue()`, the outbox, the worker's
  cancellation, `x jobs show` and its manifest row all arrive for free. `name`, `tenant` and
  `retry` are required; both reads of the action projection are lazy, because `agentJob()` runs at
  module scope beside the `agent()` it wraps and names are stamped at boot.

  **`idempotencyKey` dedupes the ENQUEUE, never the ATTEMPT** — one row a worker claims, half-runs
  and loses the lease on is claimed again, and the agent runs a second time from the top. Every
  tool an agent may call therefore has to be idempotent. The framework does **not** check this and
  cannot: `mutates` is not a fact an `action()` declares, so a read-only `lookupOrder` and a
  destructive `issueRefund` are indistinguishable at that seam, and a rule refusing both would be a
  wrong refusal.

- **`describeAgents()`.** Every registered agent, by name: prompt, prompt id, **prompt hash**,
  model, `maxTurns`, `maxToolResultChars`, its sorted tool list — the agent's blast radius — its
  declared budget, and whether it is MCP-exposed. An agent projects to an `ActionDescriptor` like
  every other action, and that descriptor deliberately knows nothing about turns or tools, so "how
  far can this loop, and what may it call" had no answer outside the source. Names are read when
  you ask, not when the agent was declared; an agent nothing registered has no row, because an
  action with no name reaches no route, no tool catalogue and no queue.

- **`x db seed [<name>] [--tier reference|dev] [--dry-run]`.** The fixture graph, applied and
  replayable. Seeds are discovered by importing `packages/*/seeds/**/*.ts` and
  `packages/*/src/seed*.ts` — deliberately not `loadApp`'s whole-`src` glob, because importing
  every module of every package to find a fixture graph makes an unrelated broken module into a
  failed seed run. **One transaction per seed**, never one around the run: a seed that fails must
  not roll back the ones that already succeeded. `--dry-run` reads and reports what each seed
  *would* write and writes nothing. Which tiers an environment takes is one table
  (`seedTiersFor`) — production runs `reference` only.

- **`X_SEED_ENVIRONMENT`.** A seed whose tier this environment does not run, refused rather than
  confirmed: `dev` fixtures reaching production is the one irreversible thing `x db seed` can do.
  Its own code and not `X_CLI_BAD_FLAG` — the argv was well formed, and the one remedy is naming
  the tier (`--tier <tier>`, or `ULTIMATE_SEED_TIER` for a container whose command line is fixed)
  rather than re-reading `x help`. The check runs twice, in `selectSeeds` and again before the
  driver is booted, because the layer that opens a connection to production must not be the only
  layer that decided it was allowed to.

- **`X_HIVE_EMPTY`**, owned by `@ultimat3/ai` — a hive whose `split()` produced no members.

- **`wiki/Agents.md`** — the public reference for `agent()`, `hive()` and `agentJob()`.
  `agent()` appeared nowhere in the public documentation before it — `wiki/MCP-And-AI.md` was the
  only public AI page and never named it — so "how do I build an agent in Ultimate?" had no public
  answer at all.

- **`wiki/Migrating-An-Existing-App.md`** — a phased runbook for adopting Ultimate incrementally in
  front of a production app on another stack, written for the agent executing it: entry and exit
  conditions per phase, machine-checkable postconditions, error-code branch tables, and explicit
  stop conditions for everything irreversible or outward-facing.

- **The column vocabulary an existing schema needs.** `json(schema)`, `bigint()`, `decimal({
  precision, scale })`, `date()`, `bytes()` and `arrayOf(column)`, in `columns-data.ts` and kept
  apart from the opinionated builders on purpose: those are decisions the framework made for a
  table it was going to create, and these are the shapes a table already has. Two rules run through
  all of them — a value crossing the driver is parsed by the column that declared it, because the
  two drivers disagree about what they hand back (`int8` is a string from Bun's `sql` and a
  `bigint` from PGlite; `bytea` is a `Buffer` and a `Uint8Array`); and nothing here is an `any`
  hole, so `json()` **requires** a schema. `bigint()`'s row type is a decimal **string** — a JS
  `bigint` is what `JSON.stringify` throws on, and a `number` loses digits exactly where a legacy
  `int8` key lives. `decimal()` refuses a value with more decimal places than the column stores
  rather than letting Postgres round it silently. `arrayOf(money())` and nested arrays are refused
  at declaration.

- **Physical-name overrides, so an entity can describe a table it did not create.**
  `entity(name, { table })` for the physical table — the entity **name** stays the framework's key,
  so the registry, the `entity:<name>` cache tag, every relation and every policy are unmoved by a
  rename, while index names follow the table because an index is a physical object;
  `.column('<physical>')` per column, named last in a chain; and `money({ columns })` per money
  part, merged over the `<name>_minor`/`<name>_currency`/`<name>_scale` defaults so a table that
  renamed one of the three does not restate the other two. `columnName(property, meta)` is the one
  place the physical name is decided — a second `snake(property)` anywhere would be a statement
  naming a column the table does not have.

- **`@ultimat3/scraping`, tier 5**, with 24 owned `X_SCRAPE_*` codes and two borrowed from core.
  Every code is classified `retryable` or `terminal` once, in `SCRAPE_ERROR_RETRY`, rather than
  re-decided by whichever `catch` saw it. Two sets override the table: `NEVER_RETRIED`
  (`X_SCRAPE_AUTH_FAILED`, `X_SCRAPE_PROMPT_UNANSWERED`) — a site that locks an account after three
  wrong attempts turns a retrying framework into the thing that destroys the user's account — and
  `BURNS_SESSION` (`X_SCRAPE_BLOCKED`, `X_SCRAPE_SESSION_EXPIRED`), which discards the persisted
  identity **before** the retry, because a flagged profile stays flagged. `X_SCRAPE_YIELD_COLLAPSED`
  is the silent-green alarm: a run that succeeds and returns far too little, checked **before** the
  run is recorded so the baseline cannot follow a collapse downward.

- **`MoneyValue.scale`** — the decimal places `minor` counts, when they are not the currency's own.
  Absent still means the currency's minor unit and round-trips byte for byte; `0` means whole
  units, and the two must not collapse. `MAX_MONEY_SCALE` is 15, because 10^15 is the last power of
  ten that is itself a safe integer. It exists because a cents-only value could not name a sub-cent
  amount at all, so the one place that needed one — a model call costing $0.00016 — rounded up to a
  whole cent and reported 62x the real spend; the alternative was a second money type. Arithmetic
  meets at the finer of two scales, comparison widens as `bigint`, and narrowing is `rescale()`,
  which takes a mode out loud. A money entity column is now **three** physical columns, the third
  nullable — `NULL` decodes to an absent key, never to `0`.

### Changed

- **BREAKING — `defineAuth({ mfa: { required: true } })` is refused at boot** with
  `X_CONFIG_INVALID`, and `AuthMfaPolicy.required` is narrowed from `boolean` to the literal `false`
  so the same refusal is a type error. Nothing read the flag: `login()` branches only on
  `user.mfaSecret !== null` and mints `mfaSatisfied: true` otherwise, so a user who never enrolled
  got a fully-privileged session under a setting that reads *"this deployment requires a second
  factor"*. **Enforcing it at login was rejected as a lockout**: the half-authenticated actor that
  exists so a request can reach the finish-MFA route and nothing else is, by construction,
  unavailable to an un-enrolled user (`policy-bridge.ts` gates it on `mfaSecret !== null`), and the
  framework ships no enrolment route — so refusing at login closes the only door to the app's own
  enrolment handler. A guarantee that cannot be shown to hold is refused where it is declared, the
  `assertAuthLimiterPolicy` / `assertRateLimitScope` precedent. **Manual edit:** delete
  `mfa.required`; enforce the requirement in your own enrolment flow. A test now pins that an
  un-enrolled user can still sign in, so re-adding the login check fails the build.

- **BREAKING — `enrolTotp(input)` is now `enrolTotp(auth, input)`**, and `input.issuer` is optional,
  defaulting to `auth.mfa.issuer`. The configured issuer — advertised in the README as the product
  name shown in the authenticator app — never reached an `otpauth://` URI, because `enrolTotp` read
  only its own argument. **Manual edit:** pass the `auth` you built with `defineAuth`.

- **BREAKING — `@ultimat3/http` no longer exports `appErrorStatus()`.** It was documented as feeding
  `x errors list` and the manifest and was called by neither — and could not have been:
  `registerErrorStatus()` fills a process-global map from the app's own imports, while both surfaces
  are build artefacts derived from source, so in a CLI or manifest process it answered `{}`.
  `registerErrorStatus()` and `statusFor()` are unchanged. **Manual edit:** read your own
  registration module instead.

- **BREAKING — `SyncSocket.lastSeenAt` is renamed `lastSeenMonotonicMs`**, and idle tracking now
  reads `Clock.monotonic()` rather than the wall clock. An NTP correction otherwise either evicted
  sockets that were actively talking (clock steps forward) or spared long-dead ones (steps
  backward) — newly load-bearing, because this release wired the idle sweep for the first time.
  The field is renamed rather than quietly re-based so that `new Date(socket.lastSeenAt)` becomes a
  compile error instead of a silently wrong date. `openedAt` stays wall-clock: a human reads it.
  **Manual edit:** rename the read; if you were formatting it as a date, you were already wrong.

- **BREAKING — `SQL_OUTBOX_RELEASE` and `SQL_OUTBOX_MARK_PUBLISHED` take one more parameter each**
  (1 → 2 and 2 → 3): the claimant, so both are fenced on `claimed_by`. Without it a relay whose
  lease had already lapsed could release rows a **newer** claimant was actively publishing, letting
  a third relay claim them mid-batch — the same duplicate the claim lease exists to prevent.
  `SQL_OUTBOX_MARK_PUBLISHED` also gains `published_at is null`, which it never had, making the
  stamp first-writer-wins instead of rewriting an audit timestamp. **Manual edit:** pass the
  claimant; `OutboxStore.release`/`markPublished` take it as an optional trailing argument, so a
  store that does not fence still compiles.

- **BREAKING — `SocketRegistry.sweepIdle()` is replaced by `idle()`**, which returns the sockets past
  the budget and removes nothing. The old method had no caller anywhere, so `idleTimeoutMs` (120s)
  configured nothing and `SyncSocket.touch()`/`idleFor` existed for a dead path — and wiring it as
  written would have reproduced the drain leak below, one object down. Eviction now belongs to
  `sync-node`, which routes it through `teardown`. `createSyncNode({ idleTimeoutMs })` reaches it;
  the sweep period is derived (a quarter of the budget, floored at 1s) rather than configured,
  because a second number can disagree with the one it is a fraction of. **Manual edit:** call
  `idle()` and evict through the node, or set the budget through `createSyncNode`.

- **`stepTimeout` and `eventPoll` are declarable on `job()`.** Both were implemented, tested and
  unreachable: `execute.ts` never passed them and `JobDefinition` had no per-step key, so the only
  exercise was a runner built by hand in a test. A non-positive value is refused at declaration —
  `withStepTimeout` reads `<= 0` as "no ceiling", the `concurrency: 0` trap. They are deliberately
  **not** in `JobDescriptor`, which would drift both tracked apps' committed `x.manifest.json`.

- **BREAKING — `DESCRIPTION_MIN_LENGTH` is deleted from `@ultimat3/seo`.** It was exported,
  documented as *"validate.ts enforces it"*, and read by no validator anywhere in the repo — a
  length bound whose only effect was to be importable. Enforcing it instead would have needed a new
  `X_SEO_*` code and would have newly failed both tracked apps (`dummy/social-media-clone`'s
  `admin.home.description` is 32 characters), so the honest change is to stop shipping a gate that
  does not exist. **Manual edit:** delete the import; there is no replacement, and no minimum
  description length is checked. A test now pins that every bound `@ultimat3/seo` exports is one
  `validateMeta` actually enforces, so this cannot recur.

- **BREAKING — a metric redeclared with different `bounds` or a different `observe` is refused**
  (`X_METRIC_NAME_INVALID`) rather than silently answering the first declaration's instrument.
  `InstrumentOptions.maxSeries` documented "the first declaration of a name wins" and `bounds`/
  `observe` did not, so a second `histogram('x', { bounds })` kept the original buckets with no
  signal. An **omitted** option is still a handle-fetch — `gauge(name)` is unchanged — and
  `maxSeries`/`unit`/`description` keep their shipped first-wins rule. **Manual edit:** make the
  second declaration state the same `bounds`/`observe`, or fetch the handle without options.

- **`cachedFormatter` and `canonicalLocale` moved from `@ultimat3/time` to `@ultimat3/core`.** Both
  are re-exported from `time`, so no import breaks. They moved because `@ultimat3/money` needed the
  same bound and `money → time` is a **sideways** tier-1 import the boundary check refuses — the
  choice was one mechanism in tier 0 or a second copy of it, and axiom 1 settles that.

- **BREAKING — `Seed.run()` resolves with a result object instead of `void`.** It now answers
  `SeedRun` — `{ name, tier, metrics: { inserted, updated, skipped } }` — which is what lets
  `x db seed` report a table and a `--json` body rather than "done". A caller that awaited it for
  its side effect alone is unaffected; one that typed the result as `void` re-types it.

- **BREAKING — `SeedContext.insert` skips a stored row instead of overwriting it.** The bulk verb
  writes with `on conflict … do nothing` against the entity's own primary key, so a replay leaves
  every row already stored exactly as it is and counts it `skipped`. Never `'update'`: a do-nothing
  conflict needs no tenant column in the target, which is the one form that replays on a
  tenant-scoped entity whose unique keys are global. `upsert` is the verb for a row the *table*
  keys, and it still reads first so the answer can be `'skipped'`.

### Fixed

- **SECURITY — the icon generator wrote network-fetched data into TypeScript source unescaped, so a
  crafted glyph executed at import.** `build-icons.ts` emitted `${key}: '${value}'` where `value`
  came from `icon-nodes.json` fetched over the network. `iconElements` validated tag names,
  attribute *names* and the `fill` value — never the value of `d`, `points` or `cx`. A value that
  closes the string, the object and the array element and reopens all three produces a glyph module
  that runs arbitrary code **in every app that imports that icon**. **Proven exploitable**: the
  regression test transpiles and evaluates the generated module, and the payload set a global before
  the fix. `JSON.stringify` is the fix; a `SAFE_ATTR_VALUE` allowlist is defence in depth, added only
  because it demonstrably refuses none of the 1767 committed glyphs. The sibling `icon-glyph.ts`
  already stated the principle — *"data reaching an attribute sink unchecked is how `onload=` gets
  into the DOM"* — and this was a **code** sink, which is worse.

- **SECURITY — a scraped session's cookies were sent to hosts they do not belong to.** The match was
  `host.endsWith(cookie.domain)`, with no dot boundary in either direction: a host-only cookie for
  `bank.test` was sent to **`evilbank.test`** *and* to `sub.bank.test`. The CDP jar is every domain
  the session ever touched, so an SSO hop's cookies rode along. Cookie scoping is now one function
  implementing RFC 6265 §5.1.3 and §5.1.4 — domain **and** path, both boundaries — failing closed on
  an unparseable URL, and a `secure` cookie no longer reaches an `http:` URL. Path scoping was a
  third leak the audit had not named.

- **SECURITY — two tenants shared one authenticated scrape session.** A declared `auth.key` replaced
  the whole session key instead of discriminating within the tenant, so `orgOf(ctx)` was never
  consulted and the value was never sanitised. `sessionKeyFor`'s third parameter is named
  `discriminator` and had no caller anywhere — it does now.

- **A disabled item made the rest of a `Menu` or `Tabs` unreachable by keyboard.** A disabled control
  cannot take focus, so the roving reducer returned its index forever and arrow keys stopped dead. If
  the disabled item was first, nothing in the group was tabbable at all. A `Toolbar` separately stole
  arrow keys from a text field inside it — its own documented use — swallowing the caret move.

- **`ToastRegion` was not a live region**, which is precisely the failure its own header says the
  region/child split exists to prevent: each toast created a fresh live region with its content
  already in it, which most screen readers do not announce.

- **A file dropped on `Dropzone` never reached the form.** `onSelect` fired, `input.files` stayed
  empty, and `required` blocked the submit — while `name`/`required` are props and native form
  participation is the advertised contract.

- **Seven more instances of the caught-value totality class**, in `@ultimat3/ai` and `@ultimat3/mcp`:
  a tool result that could not be serialised took down the tool loop, a hostile provider rejection
  escaped the gateway's retry classifier, and the MCP server's error renderer read four fields off a
  value the framework did not build. A tool whose *output* is unserialisable now reports that the
  tool **ran**, never that it failed — so the model does not re-buy the side effects.

- Also: a refused scrape credential was walked back to the login form when `reuse: false`;
  `robots: 'obey'` was unenforced on the offline HTTP leg every test exercises, so a `Disallow:`ed
  endpoint replayed green and failed in production; a browser process leaked per failed attempt, and
  the throws that caused it reached the job retry classifier as bare `Error`s with no code; and
  restored `localStorage` was written on `about:blank` where it can never reach the site's origin.

- **An apostrophe in JSX text silently disabled the `errors` gate for a whole file, and it was not
  hypothetical.** `maskLiterals` treated `'` as a literal opener and blanked everything up to the
  next one, so `scanFixes` returned nothing for the rest of the file — while `scanCodes` kept
  passing, masking the hole. `packages/http/src/errors.ts` contains
  `…already route "${input.otherRoute}"'s`, so **eight real `fix:` lines in that file had never been
  checked**. All eight pass now. One test asserted "nothing in the installed framework raises
  `X_DRAINING`" — disproved by `draining()` in the very file the gate had stopped reading.

- **A page with zero executable JavaScript could fail its JS budget**, with a `fix:` line naming an
  import that does not exist. Every inline `<script>` body was counted, including
  `application/ld+json` (which the SEO helpers emit) and island props. `@ultimat3/render`'s `head.ts`
  already owned the rule: *"the body is data, not code."*

- **`x verify --workers 5000` was accepted** although both flag summaries say "max 8", and
  `planShards` clamps only to the file count — 842 concurrent Bun processes, each with the framework
  module graph and a cloned database. Both summaries also named `CPUs - 1` as the default, a value
  the code measured and rejected as *"slower than not sharding at all"*.

- **`agent()` sent the Anthropic API a transcript it rejects, in two places.** A turn emitting a tool
  call **and** `respond` replayed the `respond` `tool_use` with no matching `tool_result` → 400. The
  repair path had the same hole and is more reachable: **any** output-schema mismatch in an `agent()`
  run was a 400. The loop now answers the superseded `respond` with an `is_error` result telling the
  model to read the tool results and answer again — rather than discarding a block the model emitted,
  or using an answer composed before the tools it called had run.

- **MCP `additionalProperties: false` accepted and dropped every argument named after an
  `Object.prototype` member** (`constructor`, `__proto__`, `toString`), because the check walked the
  prototype chain. Third instance of this class in one release, after `@ultimat3/i18n`'s catalog and
  `@ultimat3/schema`'s coercion. `Object.hasOwn` alone was **not** sufficient: it turns the
  `__proto__` *drop* into a `__proto__` *re-prototype* of the record the handler reads, so every
  write now goes through `Object.defineProperty`.

- Also: a request arriving with an inbound `traceparent` never appeared in `/_x/timeline`; a second
  `x dev` died with a bare `Error` on a port collision and `METRICS_PORT` was honoured in the
  container but ignored in dev; a missing binary produced `fix: x doctor --json`, which checks
  nothing about missing binaries; a root `tsconfig.json` written as JSONC silently disabled
  `X_PACKAGE_UNREFERENCED`; and `x doctor --port 65535` suggested `--port 65536`, which `x dev`
  refuses.

- **The outbox relay's claim locked nothing, so two relays could publish one batch and a job could
  run twice.** `SQL_OUTBOX_CLAIM` ends in `for update skip locked`, but the relay issues it on a
  **pooled** connection with no transaction — a bare statement runs in an implicit transaction that
  commits the instant it returns, so every row lock was released before `claim()` resolved, and
  there was no `claimed_at` column to fence the batch either. Two relay replicas one `intervalMs`
  apart therefore received the identical rows. The duplicate is not collapsed by the idempotency
  key the way `dev-roles.ts` claimed: `SQL_ENQUEUE`'s conflict target is a **partial** index over
  live states only, so once the first job reaches a terminal state the second insert matches nothing
  and the handler runs again.

  The claim is now a lease taken in the statement that locks the row — a CTE whose `update` and
  `for update skip locked` select commit together — with `claimed_at`/`claimed_by` added additively
  (`add column if not exists`) and a reclaim window that returns a crashed relay's rows. **An
  existing deployment re-applies `SQL_JOBS_TABLE`**; the alters are additive and idempotent, so
  re-applying is safe. The outer `order by staged_at` is load-bearing: `update … returning` has no
  defined row order and the relay publishes in the order it is handed rows. `OutboxStore.release`
  is new and optional — without it the lease would turn a one-tick pool blip into a 30-second stall
  of all committed work, a failure mode the fix would otherwise have introduced.

  The claim's sort key is now total — `order by staged_at, id` — because rows staged in one
  transaction share a `staged_at` and a tie left the batch composition arbitrary. `id` is a UUIDv7
  primary key, monotonic and bytewise-comparable, so the tiebreak *is* stage order and **no DDL was
  needed** for it.

  **What is proven and what is argued**, because the difference matters here: that
  `for update skip locked` fences nothing outside a transaction is Postgres semantics and is
  demonstrated; the ownership fence and the total order are proven as statement text plus the
  parameters the store binds, and behaviourally in the memory store, which is built to answer the
  same question. That the second publish lands *after* the first job reached a terminal state is a
  timing argument, not reproduced — it needs two worker processes and a live server.

- **`drain()` closed every socket without releasing anything it held.** It inlined three of
  `teardown`'s five steps, so `registry.unsubscribeSocket`, `hub.unsubscribe` and `presence.leave`
  never ran, and Bun's `close` callback could not cover for it — `sockets.remove` runs synchronously
  on the next line, so the callback takes its early return. The `QueryEntry` (matcher, shared row
  window, `WindowLock`) was never dropped and `source.forget(qid)` never called; worse, presence
  lives in the shared store with a 30s TTL, so during a **rolling restart** every room rendered each
  user twice — once under the drained socket id, once under the reconnected one. Two auditors proved
  it independently. `evict()` is now the one eviction path, and the idle sweep routes through it.

- **A live query with a `limit` stopped sending patches for a window that was never full.**
  `removeAt` emitted a `refill` on every removal whenever `limit !== null`, naming a position
  outside the result set (`from: 49` for a 3-row window). The bridge folds any refill into
  `BridgeResult.refill`, and the fanout then marks the entry stale and `continue`s past every
  subscriber — **no frame that round**. On a quiet feed the client kept rendering the deleted row
  until some unrelated change to the same query arrived. The refill is now gated on the window
  having actually been full.

- **A read issued before a change-stream gap could overwrite the refill that repaired it.** The
  never-backwards guard was expressed purely in lsn terms, but a definition with no lsn provider
  answers `''` and `'' >= ''` is true — so a stale read landing last won, and `startRead` had
  already cleared `stale`, so the fanout's repair never fired again. Every subscriber of that query
  stayed permanently stale on a healthy socket. Reads now carry a monotonic generation and apply
  only if still newest: identity against another read, lsn against a change.

- **A clean job completion reported a lost lease.** `stop()` cleared the interval but did not fence
  a renewal already on the wire, so a heartbeat landing after `ack` found the row out of `running`,
  answered `false`, and logged `jobs.lease.lost` at error while calling `recordLeaseLost` — the one
  signal that means *"the queue re-delivered a job this process was still running"*. A page for a
  non-event, and the window widened exactly when the pool was slow. `worker-fleet-slots` had the
  identical defect; both now share one `startRenewalTimer` helper whose `stopped()` latch is
  re-read after the await.

- **A `subscribe` landing after `close()` joined the socket to a topic with no bridge**, silently:
  it received nothing on that topic for the life of the connection, with no error on either side.
  It now refuses with `X_TRANSPORT_UNAVAILABLE` so the client redials. Releasing a bridge now
  verifies identity too, which closes the same latent bug on the pre-existing authorize-throws path.

- **`Pipeline.handle` could reject instead of resolving to a `Response`.** Two independent escapes,
  both the tier-0/1 pattern one tier up: `recoverWith` — documented *"Never throws, by
  construction"* — interpolated `String(failure)`, and `factsOf` read `source[key]` on a caught
  value. The second is the live one: `error-map` **is** the recover-phase stage, so a throwable
  whose `code` read throws broke the stage *and* the `problem(ctx.error)` the guard degrades to.
  `auditOutcomeFor` in `@ultimat3/action` had the third instance — its `instanceof
  ActionDeniedError` probe ran a `Proxy` trap from the frame holding the app's error, handing the
  caller a `TypeError` in place of its own throwable. It now fails closed to `failed`: a value that
  refuses to be examined is not evidence of a policy denial.

- **`createTotpReplayGuard`'s subject map grew forever** — one permanent entry per user who ever
  completed a TOTP check. Every sibling table in the framework carries a cap for exactly this. The
  guard is now swept and bounded, and the eviction order is part of the guarantee: a subject whose
  every remembered step has left the drift window is *forgotten* (free — it already answered as a
  missing one), and only then does the cap evict, furthest-from-the-live-window first, tie-broken
  least-recently-seen. Eviction can only make an already-spent step reusable, so the subject who
  just authenticated is the last one out.

- **A throw between clearing the batch and issuing it left every coalesced `findById` caller's
  promise unsettled forever**, plus an unhandled rejection Bun ends the process on. The whole flush
  body is now guarded and fails every waiting entry. Latent rather than reachable —
  `statementChunks` is a numeric loop over a plain array — but the failure mode is severe and the
  guard now covers anything a later edit puts there.

- **`registeredJobs()`/`registeredTasks()` sorted with `localeCompare`**, and that ordering reaches
  `x.manifest.json`, which the `drift` gate step compares byte for byte. `localeCompare` with no
  locale depends on the runtime's ICU collation, so the artefact was machine-dependent.
  `@ultimat3/http`'s router had already written the rule down.

- **`@ultimat3/action`'s `X_SCHEMA_UNSUPPORTED` told the reader to configure a provider whose
  `toJsonSchema` returns an object** — a member `SchemaProvider` does not declare. The user-visible
  half of a doc clause deleted from `@ultimat3/schema` in the same release; it survived because it
  lived in another package. `x verify`'s `errors` step checks a `fix:` line's *shape*, never whether
  the API it names exists.

- **SECURITY — a signed storage key differing only in the case of its `org/` prefix escaped the
  tenancy gate.** `isTenantScoped` compared the first segment exactly, so `Org/org-2/secret.png`
  read as *not* tenant-scoped and skipped the org check entirely — and `Org/` and `org/` are one
  directory on APFS and NTFS, so the local driver then opened the other tenant's file. The
  predicate now folds case on that segment, which also closes it in `x dev`'s asset and storage
  routes, where the key is client-supplied with no signature at all. `isWithinOrg` stays
  exact-case, so a folded prefix is refused outright rather than matched.

- **No signed storage URL verified under the documented defaults.** `localDriver` signed under
  `/_storage/local` while `verifySignedUrl` / `acceptSignedUpload` / `readSignedObject` defaulted to
  `/_storage`, so the key parsed as `local/<key>` and `grantUpload` → `acceptSignedUpload` — the
  pair `docs/architecture/17-uploads.md` documents, neither call passing `baseUrl` — always failed
  `X_STORAGE_URL_INVALID`. The base is now stated once as `signedUrlBaseFor(driverName)` and the
  verify side derives it from `disk.name`, which the caller already passes.

- **An app's own shared assets were unreachable through a signed URL.** `constraintsFor` gated on
  `isWithinOrg` alone, so any key outside `org/<id>/` was refused `X_STORAGE_ORG_MISMATCH`.
  `packages/storage/src/path.ts` had already written down that *"the pair is the question"* and
  shipped `isTenantScoped` for it; only the dev route used the pair. Nine spoof keys — traversal,
  encoded separator, longer-id borrow, reserved segment, leading slash, empty segment, Cyrillic
  homoglyph and two case folds — are each pinned refused, every one signed with the real secret.

- **`policy.requireChecksum` could only ever fail.** `acceptSignedUpload` is the sole production
  caller of `validateUpload` and had no field to carry a checksum, so declaring the option broke
  every signed upload it governed. `AcceptSignedUploadInput` now carries `checksum`, travelling
  exactly as `declaredContentType` does.

- **`t('valueOf')` threw out of the translator that documents "never throws".** The catalog lookup
  was a raw index on a `{}`-prototyped object, so any key naming an `Object.prototype` member
  resolved to the inherited value: `t('valueOf')` died with `TypeError: template.includes is not a
  function`, and `t('constructor')` returned a **function** through a signature typed `string`.
  Reachable wherever a key travels as data (`t(row.labelKey)`). The lookup now goes through the
  `Object.hasOwn` guard that sat one line above it, `t.raw()` with it, and `flattenCatalog` /
  `mergeCatalogs` build on `Object.create(null)` as `nestCatalog` already did.

- **A cron day-of-week range that wraps with a step walked an 8-day week.** The wrap span was
  `max - min + 1`, which is **8** for day-of-week because the field is 0–7 with two spellings of
  Sunday: `0 3 * * sat-tue/2` fired Tue, Sat **and** Sun where Vixie gives Sat and Mon. A `task`
  declaring one ran on the wrong days. The span is now stated (7) rather than recomputed, which
  leaves every non-wrapping expression byte-identical — normalising the field to 0–6 instead would
  have silently changed `0 0 * * 5/2` from `[5,7]` to `[5]`.

- **Two functions whose entire contract is absorbing a refusal could themselves throw.**
  `invalidateTags()` documents *"a dead Redis must not fail the write that triggered the bust"* and
  `bestEffort` *"absorbs its refusal"*, but both rendered the caught value with
  `error instanceof Error ? error.message : String(error)` — and on a value the framework did not
  build, **both halves throw** (a `Proxy` trapping `getPrototypeOf` defeats `instanceof`; a
  null-prototype object defeats `String`). All four sites now call `renderThrowable`, which exists
  in core for exactly this. `checkDb` had the same line and backs `/readyz`, so a hostile driver
  failure took the readiness probe with it.

- **A rejecting `drain()` was an unhandled rejection that ended the process mid-drain.**
  `installSignalHandlers` observed it with `.then()` alone, and the drain body logged outside any
  `try` through an injectable sink — an app `Logger` that throws in `info` left `state` short of
  `'stopped'`, made the memo re-reject on every later `drain()`, and stopped `release()` running at
  all. The body is now total and the handler is attached on both settle paths. `readinessChecks`
  had the identical hole off the drain path, where a throwing logger made `/readyz` throw.

- **`applyFlagSnapshot` left a snapshot half-applied.** It validated and wrote key by key, so an
  invalid targeting on the Nth flag threw with the first N−1 already retargeted and the report
  discarded — while the doc block argued the throw protects the fleet. It now validates every
  declared key before it writes any.

- **`rollback({ steps: -1 })` reverted every migration but the last.** `slice(0, steps)` with a
  negative value selects from the front; `steps` is now refused unless it is a positive integer,
  before the advisory lock is taken.

- **A migration deleted from the tree was invisible to the ledger audit in `x dev` and CI.**
  `auditLedger` only refused an unknown row when its `app_version` differed from the running one,
  and `runningAppVersion()` is `dev` for every development build — so drift then reported `ok: true`
  against a database that still had the table. The predicate is now membership alone; the version
  moved into the cause.

- **`reapBranches` dropped a branch whose `createdAt` would not parse.** `NaN > cutoff` is `false`,
  so an unparseable timestamp read as infinitely old and the database was dropped on the next
  sweep regardless of `maxAgeMs`.

- **`formatMoney` cached one `Intl.NumberFormat` per distinct locale tag, unbounded, keyed on a
  request value.** 20,000 tags retained ~55 MB. It now shares core's bounded, canonicalising
  formatter cache — the mechanism `@ultimat3/time` already had and `money` could not import.
  `formatMoneyDecimal` built a second uncached formatter in the same file and shares it too.

- **`zoneAbbrev` was the one `Intl` construction in `@ultimat3/time` outside its own cache**, built
  fresh per call from the caller's raw zone and locale, and an invalid zone escaped as a bare
  `RangeError` where every other entry point raises `X_TIMEZONE_INVALID`.

- **`coerce` read submitted values off the prototype chain.** `key in record` on a `{}`-literal
  record meant a schema field named `toString` or `constructor` read the inherited member as client
  input and forwarded a **function** into validation. `Object.hasOwn` throughout, and `toRecord`
  builds on `Object.create(null)`. The query-string path was already mitigated upstream by
  `@ultimat3/http`; route params and form data were not.

- **`responsiveImage`'s no-`srcset` fallback took the last width, not the largest** — correct only
  because `DEFAULT_WIDTHS` happens to be ascending, so `widths: [1280, 640]` fell back to 640.

- **`SchemaProvider.introspect`'s doc described an alternative that does not exist**, telling
  implementers they could omit it "if the provider also supplies `toJsonSchema`" — a member
  `SchemaProvider` does not declare, so following the doc produced `X_SCHEMA_UNSUPPORTED` on every
  OpenAPI and MCP projection.

- **SECURITY — `verifyPassword` threw on a stored hash Bun cannot parse, which was an
  account-enumeration oracle.** `Bun.password.verify` *throws* rather than answering on a hash it
  cannot read (measured, bun 1.3.14: a Django `pbkdf2_sha256$…` row is `UnsupportedAlgorithm`, a
  truncated bcrypt string is `InvalidEncoding`), and that escaped. Two faults from one line: a bare
  `Error` reached `login()`, so the caller answered **500** instead of the one credential failure;
  and it landed on exactly the rows that have not migrated off a legacy scheme, so "has this
  account been migrated" — and therefore "does this account exist" — was readable from the outside.
  That is the oracle `packages/auth/src/password.ts` is built end to end to close, on the one table
  where a foreign hash is normal.

  An unreadable hash now takes the **same branch as an unknown user**: it burns the same full KDF
  and answers the same `FAILED`, so neither the response nor the response time separates it from a
  wrong password. `X_OVERLOADED` from the KDF gate is re-thrown rather than swallowed — load
  shedding is not a verdict on the credential, and answering "wrong password" for a request this
  process refused to do the work for would be a worse lie than the 500 was. **Nothing is logged**,
  deliberately: the algorithm name of an unreadable hash is the same oracle one layer down, and a
  line per attempt is a spray amplifier.

  Two things this does **not** change. An unreadable hash consumes lockout budget like any other
  failure, so a table of foreign hashes locks accounts out through ordinary login attempts; and it
  is still not a migration path, because nothing rewrites the row. Supported-but-old remains a
  verdict — bcrypt verifies natively and `needsRehash` flags it, which is the lever a legacy
  migration actually rewrites rows with. `''` also joins the no-user branch now, so an oauth-only
  account with no password credential is not a stopwatch away from being enumerated either.

- **The connection string replaced an operator's libpq `options` instead of merging them.**
  `connectionUrl` wrote `searchParams.set('options', '-c statement_timeout=…')` over whatever the
  operator had put in `DATABASE_URL`, and only when the role's bound was above zero — so a
  `?options=-c search_path=app` was **dropped** on `web`, `sync`, `worker` and `scheduler` and
  **kept** on `migrate` and `replicator`, leaving the role that runs the migrations and the role
  that serves the traffic reading different schemas, with nothing reporting it. A connection string
  is the operator's file, not the framework's.

  `mergeLibpqOptions` (`packages/db/src/libpq-options.ts`) now merges: the framework wins on the
  settings it names and the operator keeps everything else. Precedence is enforced by removing the
  framework's own names before appending, never by argument position — "the last `-c` wins" would
  make a safety bound depend on backend ordering nobody measured — and all three spellings a
  backend accepts are recognised (`-c name=value`, `-cname=value`, `--name=value`). A role's
  `statement_timeout` is a bound the pool is sized around, so a value in the URL may not raise it;
  a `search_path` or any other `-c` survives.

  **Behaviour change worth naming:** the bound is now emitted for **all six** roles, `migrate` and
  `replicator` included at `0`. Those two connection strings therefore carry an `options` parameter
  where they previously carried none, and `-c statement_timeout=0` now overrides a server-side
  `alter database … set statement_timeout` for them — which is the point: `0` is `migrate` saying
  it may take as long as it takes, and left unsaid the server-side setting kills the one role that
  must outlive it. Operationally: a connection pooler that rejects unsupported startup parameters
  (PgBouncer's default) would newly refuse those two roles. The other four have always sent
  `options`, so this is not a new class of failure.

- **`packages/db`'s README and a `drift.ts` comment both described an `x db drift` command that
  does not exist.** `x db` takes `gen`, `migrate`, `reset`, `seed`, `studio`, `branch` and
  `backfill`. The README additionally claimed a `ROLE=migrate` container logs drift and exits 0,
  where `runRole` throws the first difference through `assertNoDrift` and exits non-zero — the
  release phase has one channel, the exit code, and a deploy that rolled past a schema nobody can
  reconstruct is the failure drift exists to catch.

- **`docs/architecture/11-ai-surface.md` named five MCP dev tools this server has never
  projected.** `actions.list` (it is `actions.describe`), `manifest.get` (`manifest.read`),
  `budgets.report`, `live.explain` and the `jobs.list`/`jobs.status`/`jobs.retry` triple (one tool,
  `jobs.inspect`); `queue.depth` and `verify.run` ship and were absent from the table. An agent
  that trusted that page called five tools the server answers ToolNotFound for. The table is now
  the thirteen `devTools(host)` declares, with each one's scope.

### Merged pull requests

The prose above says what changed and why; this is which pull request carried it.

**Added**

- browser automation as a job factory, with zero new dependencies (#140)
- an agent's tool can be a real action, and a hive of agents is an action (#139)
- adopt an existing database, and make a seed replayable (#137)

**Fixed**

- an apostrophe in JSX text turned the errors gate off for a whole file (#158)
- a crafted icon executed at import, and a session cookie went to the wrong host (#152)
- the outbox claim locked nothing, and a drain released nothing (#148)
- the contracts that said "never throws" threw, and a gate that was never enforced (#147)
- an unreadable password hash was an enumeration oracle (#141)
- a terminal error is retried, because the executor never reads the classification (#138)
- the trusted publisher was attached without its environment, and the check could never see it (#136)

**Changed**

- the release status said the opposite of the registry, in ten files (#159)
- agents, and a migration guide an AI agent can execute (#142)


## 2.0.0 - 2026-08-17

**The first major.** 33 entries below are marked `BREAKING —`, and each one changes a surface semver covers: a primitive field, an export, a CLI flag, an `app.config.ts` key, or a tier edge. Semver applies from 1.0.0, so none of them could ship as a minor. Read [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading), then the `BREAKING —` entries in order — **no codemod ships with this release**, so each one is a manual edit, and the entry names it.

All 29 workspaces move together — 28 `@ultimat3/*` plus the unscoped `create-ultimate`, one version, one commit, one tag. Publication is not in lockstep: **`@ultimat3/flags` is still not on the registry**, and its first publish is a manual bootstrap by an npm org member ([PUBLISHING.md](PUBLISHING.md), step 1) because a trusted publisher cannot attach to a package that does not exist. The workflow's publish list is derived from `scripts/list-workspaces.ts`, so no package can be silently absent from a release again.

### Fixed

- **An unregistered currency arriving over HTTP answered 500 and paged the on-call.**
  `X_CURRENCY_UNKNOWN` had no row in `packages/http/src/error-map.ts`, so it took `DEFAULT_STATUS`
  — and `stages.ts` reports every `status >= 500` to the error monitor. It is **400** now, beside
  `X_LOCALE_UNSUPPORTED`: a well-formed value naming something outside the set this process carries.

  It was never merely theoretical, and this release is what makes it undeniable. The currency table
  is **open** as of `registerCurrency`, and every surface between the wire and the throw accepts any
  `^[A-Z]{3}$` — `@ultimat3/schema`'s `CURRENCY_CODE_PATTERN`, the OpenAPI `pattern` emitted from
  it, and `@ultimat3/entity`'s `char(3)` CHECK. So `{ "minor": 100, "currency": "ZWL" }` parsed,
  passed validation, reached `money()` -> `assertCurrency`, and the caller was told the server had
  broken over a code the framework's own schema had just accepted. Pinned end to end in
  `packages/http/src/error-map.test.ts`: the request answers 400 with `X_CURRENCY_UNKNOWN` in the
  problem document, and the error monitor records nothing. Clients that branched on the 500 will
  see a 400; there was no declared contract to break, because the 500 was a default nobody chose.

- **`registerCurrency`'s two refusals are classified.** `X_CURRENCY_INVALID` and
  `X_CURRENCY_REDEFINED` are pinned in `scripts/error-map-backlog.ts` with the reason:
  `registerCurrency` is their only thrower, it is a boot-time module-scope registry like
  `registerRoute` and `registerErrorStatus`, and its `REGISTERED` map is per process — so a
  request-driven registration is broken on a second replica before a status could describe it.

- **`packages/money/README.md`'s examples compile.** Both fences were missing their import line; the
  README fence ratchet **falls** from 155 to 154 and `money` leaves `scripts/readme-fences-backlog.ts`
  entirely, so any future breakage in that file is a build error rather than a pin.

- **A freshly scaffolded app could not run its first database command, and its first migration was
  wrong four ways.** All four reproduced against a real `x new` scaffold on the embedded PGlite.

  **The cycle.** `x db migrate` applied the scaffold's migration and then answered `X_DB_DRIFT` —
  *records no schema snapshot* — with `x db gen "snapshot initial"` as its `fix:`; `x db gen`
  answered `X_MIGRATION_SNAPSHOT_MISSING`, whose `fix:` read *"restore … from version control"* for
  a file version control never had, and refused before writing anything. Two errors, each naming
  the command that raises the other, on the app's first database command. Both `fix:` lines now
  carry the same two remedies in the same order: `git checkout --` the sidecar, or — when it was
  never written — delete the migration's files **first** and only then `x db gen "<name>"`.

  **Foreign keys were emitted in entity-registration order.** `x db gen` wrote every key as a
  `references` clause inside `create table`, and the order it walks is `describeEntities()`: the
  app's import order, which says nothing about which table a key points at. Measured:
  `create table "comments" (… references "posts" …)` ahead of `create table "posts"` is
  `relation "posts" does not exist` on statement one, and `down` had the mirror fault —
  `drop table "posts"` while `comments` still references it is `2BP01`. Every key is now its own
  `alter table … add constraint`, merged in after every table statement, and `down` drops
  constraints before tables. **No topological sort and no cycle error**: separate constraints need
  no ordering at all, and two tables referencing each other cannot be expressed inline in any order.

  **The same clause is why a `references()` added to an existing column generated an EMPTY
  migration.** The column was already there, so nothing was emitted — while the entity hash moved,
  so `x db gen` wrote no file and `x verify`'s `drift` step stayed red forever behind a fix that did
  nothing. One call site answers both cases: which of this entity's keys the database does not hold
  yet. Removing a `references()` still emits nothing, exactly as a removed index does.

  **The generated snapshot failed the app's own `lint`.** The sidecar was written with
  `JSON.stringify(value, null, 2)`; Biome collapses a one-element array onto one line and
  `JSON.stringify` never does, so a scaffolded app's `biome check .` answered `X_LINT_FAILED` —
  *Formatter would have printed the following content* — on a file no author typed.
  `snapshotJson()` (`packages/db/src/snapshot-json.ts`) emits Biome's shape instead, proved by
  running the repo's own `biome format` over its output and demanding no change, with the naive
  spelling asserted to fail the same check so the test cannot pass by doing nothing. `x new`'s
  `biome.json` also excludes `**/migrations`, the glob this repo's own config already carried. It
  had already bitten: the demo app's committed `…_initial_schema.snapshot.json` is in *Biome's*
  shape, which `JSON.stringify(value, null, 2)` cannot produce — it was reformatted by hand after
  generation.

  **None of it was in CI.** `scaffold-smoke` proved `x new` → `bun install` → `x verify` and stopped
  there, so it never invoked a generator and never opened a database.
  `scripts/scaffold-first-run.ts` is the first ten minutes after `x new` run as a check —
  `x db migrate` against the pristine scaffold, every generator projected from the CLI's own
  `GENERATORS` registry rather than a sample, then `x db gen` and a second `x db migrate` over what
  they wrote — reporting each failing step as `X_SCAFFOLD_FIRST_RUN_FAILED` with the command that
  reproduces it, and never stopping at the first. The scaffold's `x verify` now runs after it and
  over its output, which is what makes generated code typechecked and linted rather than merely
  written.

- **Five generators imported slice modules they never wrote.** `x g action`, `x g mutator`,
  `x g query`, `x g job`, `x g task` and `x g backfill` all open with
  `import * as repo from '../repo'` — an action adds `../policy` and `../errors` — while only
  `x g resource` emitted any of them, so each of those generators wrote a file that does not load
  (`TS2307`, then `X_CLI_UNEXPECTED` from every registry command) in any slice a resource had not
  been run in first. Each now composes exactly the modules its own source imports, through
  `sliceFoundation(target, needs)`: into a **bare** slice `x g job` writes 5 files where it wrote 2,
  and `x g action` 8 where it wrote 3.

  **Named per generator, never one fixed set.** A job has no request behind it and evaluates no
  policy, so it plants no `policy.ts` — a generated file nobody reads is one an author has to read
  before deleting. `'entity'` is the *pair*: `repo.ts` imports `./entity` for its row type, so
  emitting one without the other moves the unresolved import rather than closing it.

  Counts, `As of 2026-08`, into a slice that has none of them: `x g action` and `x g mutator` 8,
  `x g query` (with or without `--live`) 7, `x g task` 7, `x g job` and `x g backfill` 5.
  `x g resource` still writes 25 — it composes the same sub-generators, and the five copies of
  `entity.ts` that composition produces are collapsed by `dedupe`.

  **A planted module is never a conflict and never overwritten**, which is the half that makes a
  second run work. `planFile` gives `merge: 'if-absent'` a third answer beside write and conflict:
  an existing one is a **skip**, `--force` included — a foundation module belongs to the slice, not
  to the generator that needed it, and `--force` is about the primitive the author named, so
  clobbering `policy.ts` to regenerate one action would delete every rule they wrote. Regenerating a
  slice module is `x g entity` / `x g policy`. Measured on a slice holding an authored `policy.ts`:
  `x g action` writes 7 of 8 — everything missing, including `policy.test.ts`, and not that file —
  and a second `x g action` into the finished slice writes exactly its own 2, with the authored file
  byte-for-byte. Before this, a second `x g action` was `X_GENERATE_CONFLICT` on `errors.ts` and
  wrote **nothing**, and its only offered fix (`x g --force`) would have deleted the feature's error
  codes.

- **The deployed demo had no persistence, and its own comment said it did.** `client.ts` exported an
  unconditional `memoryDriver()` under a comment claiming *"in production `DATABASE_URL` selects the
  Postgres driver."* It did not — and the shape is worse than "data is lost on redeploy": the app
  runs `web`, `sync`, `worker` and `scheduler` as **separate containers**, so four processes held
  four disconnected worlds and a job's write was never visible to the web role, even at one replica
  each.

  Flipping the driver was necessary and nowhere near sufficient. **The committed migration created
  zero tables** — five lines, all comments — so the branch alone would have taken the demo from "no
  persistence" to "does not boot". And the regenerated one could not apply either: `x db gen` emits
  `create table` in entity-registration order with foreign keys inline, so `blocks references users`
  came first and Postgres answered `relation "users" does not exist`. That generator bug is **fixed
  below** — every foreign key is now its own `alter table … add constraint`, after every table.

  Three writes had to become upserts with it. An insert on an existing key overwrites **only** in
  the memory driver; on Postgres every re-block, every answered friend request and every re-opened
  decline was a unique violation.

- **Three test suites failed for reasons the pin file did not name, and one fixture was lying
  green.** `examples/dummy`'s `contract`, `live` and `job` steps were pinned with a single stated
  cause — an unscoped repo — that was wrong for all three. The repo scopes correctly. What was
  actually wrong: the seed fixture wrote into a **private driver** nothing else in the process could
  read, so every action's row loader saw an empty table; and the actor factory minted a **user** id
  where this app's identity is the *membership*, so an actor owned nothing it wrote and the policy
  denied an author their own draft. `contract` is now green.

  A fixture in the job suite stood in for a service the app has never registered — `channel` — over
  a job that dead-lettered on a `TypeError` on every real run. Its file already carried the rule it
  broke, four lines above: *"the three services the job reads, and nothing else: a stub that
  answered more would hide a read."*

- **Every control in the demo's admin toolbar did nothing.** The buttons had no handler and no
  enclosing form on a `hydrate: 'never'` page, while `invokeAdminAction` and its siblings had zero
  callers. They are now form posts to a real action — and the test that let them ship asserted only
  that a label was absent for a read-only actor, which a dead button satisfies as easily as a live
  one.

- **A suspended account kept a public profile.** Suspension stopped the account *acting* and left
  its profile, bio and posts readable. It now answers the same `null` an unknown handle does, so
  suspension is not probeable.

- **Eleven more**, each with a failing test first: forms posting to `/_x/action/*` routes that are
  not mounted; four authed pages declared public, so no `vary: cookie` and a cache could serve one
  user's page to another; a route guard that passed a whole `Policy` where a `{ permission }` is
  required, so the permission read as `undefined` while the route still marked itself gated; an
  `unblockPerson` that threw while instructing its reader to add a function that already exists;
  reads capped at 100 that callers fed 300; a messages screen at ~152 statements per render, now
  ~52; up to 99 sequential inserts, now one; a hardcoded 15/30-day billing cycle; and an admin count
  that bypassed the authorization decision its neighbours respect.

- **A deployment with no mail credential reported `accepted` for mail that never left the process.**
  `selectMailDriver` fell back to the memory driver in **every** environment, and `serve.ts` — what
  a production container's `ENTRYPOINT` runs — reaches it. Password resets, receipts and
  invitations: all "sent", none delivered, no error anywhere. Outside `development` and `test` the
  boot now installs a driver that **refuses** every send with `X_MAIL_CREDENTIAL_MISSING`. Refusal
  is at the send rather than at boot, so an app that sends no mail still deploys, and the failure
  lands on the path that needed the capability — where the queue's five attempts and its dead-letter
  path already know what to do with it.

  Found alongside it: the SMTP transport minted its `Message-ID` with a fresh random per **attempt**,
  so **a retry after a timeout past `DATA` was a second email**. It is now a one-way digest of the
  idempotency key — stable across attempts, and exposing no recipient, which is what the comment
  arguing against deriving it had actually been protecting.

- **OAuth sign-in linked an existing account in `x dev` and created a duplicate in production.**
  The OAuth path normalised the address **not at all**, while `register()` and `login()` both
  lowercased — and `x_users.email` is `text not null unique` with no `citext` and no `lower()` index,
  so Postgres is exactly case-sensitive. A provider returning `Ada@Example.com` for a user registered
  as `ada@example.com` therefore **minted a second account at the same address**, which the index
  accepts. That row can never be reached by `login()`, so the user loses password sign-in to the
  account they registered, and a later `register()` makes a third.

  The memory adapter had been case-folding, which is what hid it: fixing the two adapters to agree
  would have left the OAuth path storing provider casing in both. One `normaliseEmail` now serves
  all four doors and both adapters became pure storage.

- **A row-level cache bust emptied the whole collection on the shared tier.** Redis used one bucket
  for two jobs — "the collection tag's members" and "any member of this entity" — so
  `invalidateTags([tag('post', '1')])` dropped **every** post-tagged key on every node, while the
  LRU one rung closer correctly kept the ones that had not changed. Three implementations of one
  matching rule, and the shared tier was the outlier. The entity index is now its own key.

  Two more in the same seam: `request-memo` never validated its TTL, though the package's own
  contract claimed every tier did — and because the stack swallows the other rungs' refusals as
  best-effort, a `ttlMs: 0` write produced a **hit** out of the one rung that should never have held
  it. And `CacheTier.set` threw *synchronously* on two rungs while rejecting on the third, so
  `tier.set(...).catch(...)` missed half the failures.

- **A listing that the disk refused was reported as a disk with nothing in it.** The local driver
  swallowed every error as an empty page and the s3 driver leaked a bare provider error — opposite
  failures at one seam. `sweepOrphans` walks `list()`, so the swallow **certified an unreadable
  prefix as having no orphans**. Both now raise `X_STORAGE_LIST_FAILED`, and a genuinely empty root
  is still an honest empty page.

  While there: `head()` hashed the whole object whenever a sidecar was missing, and `list()` calls
  `head()` per entry — so listing *N* sidecar-less keys buffered *N* whole objects, sequentially, in
  a function whose comment promised it did not. `copy()` inherited the same read, and `get()` was
  reading its file twice.

- **A lapsed job slot was killed in dev and ran on in production.** `SQL_LEASE_RENEW` fenced on the
  holder but not on expiry, so Postgres revived an expired-and-unclaimed slot that the memory store
  correctly refuses — and the caller turns a refused renewal into `X_JOB_SLOT_LOST` and cancels the
  run. The two stores now agree. Separately, `stats()` counted any future-dated row as `delayed`
  regardless of state, so **every sleeping job was counted twice** and the five buckets summed past
  the row count.

- **A model provider's error body reached the logs with the credential still in it.** The Anthropic
  4xx path put the endpoint's response body into the raised error **unscrubbed**, so a proxy echoing
  `x-api-key` back in a 400 put the key into a log index, a span and a problem document at once. The
  scrubber existed — it was private to the other provider. Both now share it.

  Three more one-sided rules in the same file, each a failure that read as a success: a 200 carrying
  an error object was parsed as an empty finished answer, a tool call's `input` was cast rather than
  checked, and an unrecognised stop reason fell through to `end_turn` where callers branch on the
  reason alone.


- **Every server-side render formatted its dates in UTC, however the request arrived.** The
  framework had two ambient stores for the request's time zone — or rather one and a half, which is
  the part that made it survive four releases. `@ultimat3/i18n`'s key was already `locale`, the same
  field `@ultimat3/core` declares and `@ultimat3/http` writes, so the locale half worked end to end.
  `@ultimat3/time`'s was `timeZone` against core's `tz`, so `currentTimeZone()` — the reader every
  `@ultimat3/ui` component goes through — answered the configured default for every request. http
  had been writing the right value all along inside `runWithContext`; only the reader looked in the
  wrong place. **The defect was a field-name divergence in one constant**, and the fix is that
  `Ctx.tz` is the store: it is declared, typed, and the only tier a tier-4 reader like
  `@ultimat3/mail` can reach.

  Three more defects came out with it, all from `@ultimat3/http` re-implementing what tier 1 owns:
  an app shipping `{ en, fr }` resolved `ctx.locale` to `'en'` **forever**; a language switcher
  writing the documented `LOCALE_COOKIE` (`x_locale`) was read by nothing, because http spelled the
  cookie `x-locale`; and `x-timezone: +01:00` — a fixed offset with no DST rules — became `ctx.tz`
  and threw four packages later. http is tier 2 and `time`/`i18n` are tier 1, so importing them was
  always legal; `docs/architecture/01-package-map.md` had declared both edges all along. They are
  real now.

- **Four distinct payloads shared one idempotency record and one job dedupe key.**
  `@ultimat3/action`'s canonical form folded `NaN`, `Infinity` and `-Infinity` onto `null`, and `-0`
  onto `0` — so `{n: NaN}` and `{n: null}` produced one `requestHash`. 1.2.0's cycle recorded this
  as **blocked**, because the same function serialises the OpenAPI document and a bare `NaN` token
  would make a published spec invalid JSON. It is not blocked: the two duties differ in exactly one
  branch. The document form keeps folding to `null` and is pinned by a `JSON.parse` round trip; the
  hash form is injective. Ordinary payloads are byte-identical, so nothing re-keyed.

  `@ultimat3/realtime` had the third copy of the same defect, and there it decides a **`qid`** — a
  sharing key where a hit hands the joiner the first subscriber's compiled source, matcher and
  seated window. Narrower than it looks and the tests say so: `NaN` and `±Infinity` have no JSON
  spelling and cannot arrive on a `subscribe` frame, but **`-0` is wire-reachable** —
  `JSON.parse('{"a":-0}')` answers `-0`.

- **A cached query's read cache was a second registry the boot hand-wired to the first.**
  `@ultimat3/query` shipped its own `ReadCache`, outside `@ultimat3/cache`'s tag fan-out, and the
  seam joining them lived in a CLI file: `dev-cache.ts` installed the read tier **over** an object
  it also registered, a correctness property held by one wiring line. Its `tierReadCache` was a
  second `ReadCache` implementation that dated entries with `Date.now()` while the other used an
  injected `Clock`, so the two disagreed about "now" and no frozen clock could drive the
  Redis-backed path. And `invalidateQueryTags` called `tier.invalidateTags()` from outside
  `invalidate.ts`, which `@ultimat3/cache`'s own contract forbids in as many words.

  A `cache:` read now fills `createCacheStack(registeredTiers(), { clock })`, so an action's
  `cache.invalidates` drops it through the one fan-out by construction. The read path computes no
  expiry at all — it hands the ladder a **relative** `ttlMs` and the tier's own clock decides.

- **Four admin pages could not disagree with the route table, and the fifth one nobody looked at.**
  `@ultimat3/admin` built a route table the router never received, while each demo admin page
  hand-wrote its own `policy`. The audit called this "two permission answers"; measured, **all five
  pairs agreed** — both sides reach `permissionsForOperation`. What the hole actually cost is one
  row down: the table declares **17 routes and 6 are served**, and the orphans include create and
  edit routes gated `admin:write`. The four list pages were byte-identical apart from the entity
  name, so the next admin page gets written by copying one — and copying `permission: 'admin:read'`
  onto `/admin/users/:id/edit` is a write screen behind a read gate, with the framework's own table
  declaring `admin:write` for it. A page now reads its gate from `adminRouteFor(app, path)`, and an
  app-level source scan fails if a permission string reappears in a page file — a rule that catches
  a re-added declaration **even when it agrees**, which is the only way to see this hole while the
  two sides match.

- **Every container this image ever started was dead on arrival, and the build stayed green.** The
  binary was compiled on an Alpine base (musl) and shipped on a glibc-only runtime, so `/app/x`
  asked for a loader that was not there and every `docker run` exited
  `exec /app/x: no such file or directory`. The `--version` guard that was supposed to catch exactly
  this ran in the **build** stage, which is not what ships — so it proved a binary nobody would ever
  execute. The guard now runs in the runtime stage, which makes the base pairing enforced instead of
  assumed, and `scripts/image-contract.ts` refuses the mismatch at `x verify` time.

  Two more Dockerfile defects sat on top of it, each hiding the next: the deps stage never copied
  `dummy/`, whose seven workspace members are in `bun.lock`, so `--frozen-lockfile` failed outright;
  and it copied only the root `node_modules`, while Bun's isolated linker symlinks each workspace's
  own. The manifests are now derived from the build context, so the next workspace glob cannot be
  forgotten.

- **Every generated `app/` route registered no route at all.** The route template declared
  `render: 'stream'`, which sets `needsSuspense`; the framework ships no hole marker, so
  `defineRoute` threw `X_ROUTE_MODE_INVALID` **at import**. Every `x g route --surface app` and
  every `x g resource` produced a URL absent from `x routes`, from `x.manifest.json` and from
  `budgets` — a page that scaffolds, compiles, and does not exist.

- **`@ultimat3/flags` has never been published, and the release workflow was why.** The publish
  steps named workspaces by hand with `-w` and omitted it, so every release skipped the package
  while the registry answered 404 and nothing noticed — every consumer resolves it through the
  workspace. The workflow now derives its list from `scripts/list-workspaces.ts`, and
  `scripts/release-workflow.ts` fails the gate if a publishable workspace is ever unreachable again.
  Publishing `flags` itself needs one manual `npm publish`: trusted publishing cannot bootstrap a
  package that does not exist, and the next release now **fails loudly** on that rather than
  silently skipping it.

- **The publish workflow could be dispatched from any ref, with no environment gate**, while
  holding `id-token: write` for OIDC trusted publishing. It now refuses any ref that is not
  `refs/tags/v*` and declares `environment: npm-publish`. Three settings must still be made in the
  GitHub and npm UIs — they are listed in `PUBLISHING.md`. **`As of 2026-08`** the npm side does not
  name the environment, so a token from any run of the workflow is accepted; that stops being true
  the moment those settings land, which is the point of listing them.

- **`x errors explain` answered `x verify --json` for 318 of 375 codes.** That is the tool an agent
  reaches for when it hits a code it does not recognise, and for the overwhelming majority it
  returned a shrug — the single surface where *errors are instructions* is most load-bearing.
  Every framework error already carries an executable `fix:` at its throw site, enforced by the
  `errors` step, so the answer was to **project** it rather than restate it: 197 codes now return
  their throw site's fix verbatim, 29 return the first of several naming the count and the exact
  `@ultimat3/<pkg>/src/<file>:<line>`, and the 92 that genuinely cannot be projected say **why** —
  a fix built from values only the raised error has, or a code nothing in the installed framework
  raises. **Zero** still answer `x verify --json`, and both fallbacks were asserted against
  `fixProblem` for every code.

- **Three of the four "policy missing" errors handed the reader a snippet that does not compile.**
  `action`, `query` and `admin` all interpolated the primitive's *name* into `can('…')`, where
  `Permission` is `` `${string}:${string}` `` — so `can('createPost')` neither typechecks nor
  matches a grant. Only `@ultimat3/policy`'s own got it right. The cause is worth naming because it
  explains three independent authors making one mistake: the constructor is handed a name, the name
  is the only value in scope, and it gets pasted wherever the sentence has a hole. The name now
  stays in the `cause`, which is what finds the file, and the `fix` carries the shape.

- **The Helm chart pulled a tag that has never existed.** `Chart.yaml` sat at `0.0.1` through every
  1.x release, and `values.yaml` ships `image.tag: ""` — so `appVersion` *is* the tag `helm install`
  pulls, and the result was an `ImagePullBackOff`, not a documentation nit. `scripts/release.ts` now
  rewrites the chart in the same pass it rewrites workspace manifests, so it stops being hand-kept,
  and `scripts/chart-version.ts` fails the gate if it drifts.

- **Three roles had a liveness probe that could never answer, and three had none at all.** The
  chart's probes assumed every role opens an HTTP port; `worker`, `scheduler` and `replicator` do
  not. They now probe the metrics endpoint they actually serve — liveness only, deliberately, since
  a readiness flap would drop the pod from the Service endpoints and so from the Prometheus scrape,
  exactly when a worker is busiest.

- **`.env.production` was not ignored**, by git or by Docker. The deny-lists named `.env.*.local`
  and missed the file most likely to hold real credentials, and the build context had no `.env`
  entry at all while `COPY . .` ran under a shared build cache. Both are now allow-lists:
  everything `.env*` is excluded except `.env.example`.

- **A scaffolded app was red on its own first gate**, on three steps. `errors` cited `x db studio`,
  a *planned* subcommand that exits `X_NOT_IMPLEMENTED` — the exact rule the framework enforces on
  itself. `lint` was red from **a single trailing blank line** in an emitted test file (the two
  lint-rule defects that looked like the cause are Biome *infos*; `biome check` exits 0 with them
  present). `budgets` remains red and is now the only allowance on CI's shrink-only ratchet.

- **Five more**, each with a failing test first: `x db`'s bare form ran the migration *generator*
  because `gen` sorted first, and a default is now declared rather than inferred from array order;
  `x deploy` passed `--set image=<ref>` against a chart that declares `image` as a map, so the
  override silently did nothing; the `budgets` step discarded the findings from loading the app, so
  a module that would not compile was reported as an unmeasured route; `x help` printed its hint
  line twice; and `x fix boundary`'s one-line summary promised a repair the command has never
  performed.

- **Any string reaching `meta.ld` could close the `<script>` element and inject markup.**
  `renderTag` emitted `<script>`/`<style>` content **raw**, and JSON-LD is built from route data, so
  a title, a product name or a `t()` string was enough. Escaping HTML the usual way is both
  insufficient and corrupting here: script and style are **raw text**, where the parser does not
  decode character references — `&lt;` breaks the code and closes nothing, and `<` alone ends
  nothing, which is why `if (1<2)` has to survive untouched. What ends the element is `</` plus the
  tag name, and a `<script>` has a **second** exit nobody had handled: `<!--` moves the tokenizer
  into script-data-escaped state and `<!--<script>` into double-escaped, where the element's own
  `</script>` no longer closes it and the rest of the document is swallowed as script text.

  So two rules, one per context. Code gets `</` → `<\/` and `<!--` → `<\!--`, which are identity
  escapes in a JS or CSS string. A JSON-carrying script gets the total rule — `<`, `>`, `&`, U+2028
  and U+2029 to `\uXXXX` — which is safe **by construction**, because none of those can occur
  outside a JSON string literal, so every replacement lands where `\u` means an escape and
  `JSON.parse` returns an identical string. Two more partial escapers went with it: head's private
  pair, and island props, which escaped `<` only.

- **An envelope address could inject SMTP commands.** `envelopeRecipients()` folds `bcc` into the
  recipient list and `RCPT TO:<…>` is built by interpolation with no CR/LF check — while **every
  header** is gated through one such check. On the inline path (`sync: true`, or no job driver) no
  schema runs either, since `mailMessageSchema` only guards the queued path. A `bcc` of
  `ops@example.test\r\nRCPT TO:<attacker@evil.test>` was arbitrary mail relay through the app's own
  authenticated connection; the fix is proven by asserting on the bytes written to the socket.

  `to`, `cc` and `replyTo` were **protected by accident, not by design** — they reach headers, and
  the MIME is built before the envelope, so the header gate throws first. Nothing stated that
  ordering; reordering two lines would have removed it silently. The check now sits in the socket
  writer, which is the module that builds command lines, mirroring the one place headers are gated.
  Refused, never stripped: stripping a CR out of an address yields a *different address*, so the
  mail silently goes elsewhere and the attempt leaves no trace.

- **The MCP read-only SQL guard failed open on five kinds of unterminated delimiter.** An
  unterminated `'`, `E'…'`, `"`, `$tag$` or `/*` made the stripper blank the remainder, so the `;`
  and the write keyword vanished before the statement count, the leader check and the write scan:
  `select $tag$ ; delete from members` was accepted and returned verbatim. Postgres answers a syntax
  error either way, so this was never exploitable through the database — the defect is that this
  layer leaned on the layer below, which is exactly what a guard exists not to do. Found from the
  other side, when the admin DB panel started delegating to it and its own weaker check turned out
  to fail *closed* on two of the five.

  Related, in the same scanner: `E'\''` was read as a string that never closes, so
  `select E'\'' ; drop table posts --'` was accepted whole. It cannot be fixed by guessing the other
  reading — `standard_conforming_strings` is a session setting this tool can neither see nor set —
  and the two readings differ exactly where a `;` hides, so a backslash escape inside a
  single-quoted run is now refused rather than parsed under one guess.

- **Every admin screen rendered `⟦admin.list.loading⟧`.** 69 keys the admin package renders were
  absent from the framework catalog, which instead shipped an `admin.nav.*`/`admin.table.*` block
  describing a UI that no longer exists — drift in **both** directions, so the catalog did not read
  as incomplete. Twenty of the missing keys travel as **data** (`titleKey`, `labelKey`, `reason`
  literals reached through `t(variable)`), which is why a count of the `t('literal')` call sites
  found 27 and missed the rest.

  `x i18n check` could never have caught it: it reads an app's `CATALOG_ROOT`, which does not exist
  in this repo, so it loads zero locales and answers **ok**. A check that cannot fail is not a
  check. The `boundaries` step gained a fourth rule reusing i18n's own extractor, with
  `X_CATALOG_KEY_UNREACHABLE` for the other direction — a key in a namespace the framework renders
  that no framework source names. Namespaces the catalog only *ships to apps* are exempt, derived
  from the source rather than listed.

- **A second server in one process, a derived budget that reported to nobody, and six more.**
  `pageFrom` reported `hasMore` without regard to the cursor's direction, so paging backwards
  reported the wrong end. A derived `BudgetLedger` reset `costMinor` and `requestTokens` with no
  parent link, so the `request` ceiling and `gateway.spent()` never saw a child's spend — the actor
  and org scopes did, because those keys were already shared. The ISR path registry only ever grew,
  since the store evicts silently and nothing reconciled. A surface prefix matched anywhere in a
  path, so `apps/myapp/app/page.tsx` resolved to `/app`. A second interaction before an island's
  chunk resolved flushed the queue early. `moreCapableThan` ranked across vendors by registry
  order. A stream hole that never settled had **no deadline anywhere** and leaked a response for the
  life of the process; holes now settle exactly once, at 15s by default. `isManifest` validated five
  of thirteen keys, one unparseable `package.json` killed a whole docs scan, and `Bun.stdout.write`
  went unawaited on a path that truncates.

- **`docker run my-app db backfill --all --write` started a web server, healthy, forever.** A
  scaffolded app's entrypoint reads `ROLE` and `PORT` and nothing else, so any argv appended to it
  was silently discarded — including the `command:` the generated compose file itself shipped for
  its backfill service. **`ROLE=migrate` was never broken**: every documented release-phase promise
  runs through the environment, not argv. The generated compose now overrides the entrypoint, which
  is what turns those words into a command.

- **A budget on an ssr or isr route could not be measured by any invocation.** `isPrerenderable`
  gates on `render === 'static'`, so a route declaring `budget:` with any other mode produced no
  stats row and `X_BUDGET_UNMEASURED` was unclosable. Such a route is now rendered **in memory**
  through the same document builder a request uses, weighed, and thrown away — never written.
  Renaming the failure to "unmeasurable" was the alternative and would have made those budgets
  permanently unenforced.

- **`x db` ran the code generator.** `readSubcommand` returned the first declared subcommand when
  none was given, and `gen` sorts first — so `x db` generated migrations, and `cmd-db.ts`'s
  `?? 'migrate'` was dead code documenting an intention the parser overrode. A default is now
  **declared**, not inferred from array order: nine commands genuinely want theirs and say so, while
  `x db` and `x mcp` refuse and print usage. A bare `x mcp` used to start a server.

- **A failed build reported success, and CI got nothing to act on.** `x build`'s summary line was
  set unconditionally, and a failed static pre-check returned a result labelled `verify`. The
  builder's output went only to the human-rendered lines, so `--json` — which is what CI reads —
  carried `X_BUILD_FAILED` and no output at all.

- **Nine more**, each with a failing test first: `x generate` wrote files before discovering a
  conflict, leaving a half-generated resource; a throw during boot leaked the Postgres pool, the
  queue and the OTLP exporter; `createTestClock` never restored the frozen clock, so `advance('3d')`
  reached every later test **file**; fixture destructuring stopped at the first `}`; `toMatchOpenApi`
  compared only removed operation ids, so a newly-required parameter passed; MCP resources silently
  overwrote on duplicate registration while tools threw; an admin listing wrote no audit entry
  though detail did; `<textarea>` and `<select>` took `value` as an attribute the platform ignores,
  so every admin edit view rendered empty controls; and a widget built links by appending `s` to the
  entity name.

- **One caller's idempotent response was replayed to another, and a blank header was a live key.**
  `idempotencyKeyFor(actionName, key)` namespaced by **action name only** — no actor anywhere — so
  alice's stored response for `charge` was returned to bob whenever bob sent the same key. With a
  *differing* payload bob instead got `X_IDEMPOTENCY_CONFLICT`, which is a cross-actor denial of
  service: any caller could poison any key. Compounding it, `Headers.get()` answers `''` and never
  `null` for `Idempotency-Key:`, so a **blank** header became a live key that every blank sender
  shared. The key is now `JSON.stringify([action, kind, id, orgId ?? null, key])` — a fixed-arity
  tuple rather than the joined string the scheduler uses, because an actor id is app data that may
  contain the separator, and a value that can spell a boundary can spell someone else's. A blank or
  whitespace-only key is refused before the handler as the new `X_IDEMPOTENCY_KEY_INVALID`, a 400,
  and so is one past the 255 characters the OpenAPI operation had been publishing without enforcing.

  A blank key is a **client error, not an absent key**, and the asymmetry decides it: reading blank
  as absent silently removes retry protection at exactly the moment a client's key interpolation
  broke, and the double charge then lands on that client's own automatic retry.

- **Ten error codes answered 500 and paged the on-call for a caller's mistake.** `error-map.ts`
  holds a **closed** status table: a code with no row falls to `DEFAULT_STATUS` (500), and
  `stages.ts` reports every `status >= 500` to the error monitor. So a reused idempotency key, an
  expired cursor, a weak password and a duplicate signup each woke somebody at 3am. The sharpest
  case was a contradiction the framework published about itself: `packages/action/src/http.ts:151`
  declared `'409'` for `X_IDEMPOTENCY_CONFLICT` in its OpenAPI document while the runtime answered
  500 — now pinned by a test that reads that file's bytes, since `http` is tier 2 and can never
  import `action`.

  Thirteen rows landed. `X_IDEMPOTENCY_CONFLICT` is 409 because the published contract outranks
  preference; `X_TENANCY_ACTOR_MISMATCH` and `X_TENANCY_CROSS_DENIED` are 403 and **not** the 404
  storage takes, because storage hides existence for a caller-supplied *key* while these compare an
  actor against an argument, name no resource and read no row — 404 would buy no secrecy;
  `X_DB_UNIQUE_VIOLATION` is 409 because db's own `fix:` already said so. Two are **500 by
  decision, with a row so the decision is recorded rather than defaulted**: `X_QUERY_NOT_PAGEABLE`
  is a developer bug by its own `fix:` (an edit to the read's own SQL — nothing the caller sends
  changes it), and `X_IDEMPOTENCY_REPLAYED_FAILURE` surfaces as itself only when the first attempt
  carried no code at all.

- **A second server in one process bound a port it could never serve from.** `core`'s lifecycle
  `state` and `drainPromise` are module-level singletons and `markReady()` only promoted from
  `'starting'`, so any process that drained once and then called `createServer().start()` got a
  server born `stopped`: it bound a socket, answered 503 to everything, and — measured with a real
  connection after its own `stop()` returned — **kept accepting connections**. `markReady()` now
  refuses a drained lifecycle with the new `X_LIFECYCLE_DRAINED`, raised as the **first** statement
  of `start()`, above `Bun.serve`: refusing after the bind still takes the port, which the failing
  test caught holding one.

  No shipped path reaches this — the only `createServer` call site runs once per process, and
  `x dev`'s watcher rebuilds bundles without restarting roles. It ships because **three test files
  had independently discovered the rule and written a `resetLifecycle()` workaround around it**,
  one of them spelling out the symptom: "a suite that only passes when its tests are run one at a
  time." Three discoveries of one unenforced convention is the case for a mechanism. Letting
  `markReady()` promote from `'stopped'` was rejected as a half-fix — `drain()` is memoized, so the
  restarted server's `stop()` never reaches its close hook and the socket leaks anyway; un-memoizing
  it means a second live lifecycle able to cancel a SIGTERM already in flight.

- **A query string could replace the parsed object's prototype.** `parseQuery` built a bare `{}`,
  so `?__proto__=x` reached the inherited `Object.prototype` through the property setter. The
  mechanism is not the textbook one: because `out['__proto__']` on a plain object reads a value that
  is **not `undefined`**, the very first occurrence took the repeated-key branch and assigned
  `[Object.prototype, 'x']` — an array, which the setter accepts. `Object.prototype` itself is never
  mutated; the object gets a new prototype, inherits `length` and `push`, yields phantom `'0'`/`'1'`
  keys under `for…in`, and silently swallows the parameter. `Object.create(null)` closes it.

  It closed a second defect nobody had filed: `coerceQuery` decides whether to coerce a declared
  property with `key in record`, and every `Object.prototype` member answered `true` — so a schema
  declaring `toString` or `constructor` coerced an inherited function no request ever carried.

- **A schema that failed with an empty `issues` array was read as success.** `validate.ts` tested
  `issues !== undefined && issues.length > 0`, so a degenerate failure returned
  `{ ok: true, value: undefined }` and handed a handler an `undefined` its type says is impossible —
  a `TypeError`, then `X_INTERNAL`, then a 500 and a page, for an invalid request. Presence is the
  discriminator, not length: the Standard Schema contract declares `issues?: undefined` on success
  and carries no `value` on failure. An empty array now still refuses, with a substituted sentence
  so the refusal is sayable.

- **The third copy of a 32-bit hash over client-chosen input.** `@ultimat3/realtime`'s was fixed in
  1.2.0's cycle and `@ultimat3/query`'s above; `@ultimat3/action`'s `fingerprint` was still FNV-1a/32.
  Here it is worse than the cursor case: it backs the idempotency `requestHash`, so a collision makes
  the payload-mismatch check pass and replays one caller's stored response for a **different**
  request, and it backs `job-handle.ts`'s queue dedupe key, so a collision silently drops an enqueue
  as a duplicate of an unrelated job. Now SHA-256, first 16 hex.

- **A late settlement overwrote an idempotency record that had already been replaced.**
  `SQL_IDEMPOTENCY_SETTLE` and `SQL_IDEMPOTENCY_FAIL` carried no status fence, so a straggler from a
  superseded attempt could land on a fresh reservation. Both now fence on `status = 'in-flight'` and
  return the key, and the no-op is logged rather than thrown — a settlement is post-commit, and
  throwing there would fail a request whose work already succeeded. The same fence landed on the
  memory store, so the guarantee does not depend on which store is installed.

- **A `cache:` query served one actor's rows to the next.** `cacheKeyFor` returned
  `query:<name>:<fingerprint(input)>:<tags>` — no actor, no tenant — and `readThrough` wrote that
  key into a **process-wide** tier, while `sql(input, ctx)` is handed the `Ctx` and `@ultimat3/entity`
  scopes every tenant-scoped read off `ctx.actor.orgId`. Reproduced: a query declaring
  `cache: { tags: [], ttlMs: 60_000 }` and filtering on `ctx.actor.orgId` answered an **`org-b`**
  actor with `{id:'a1', orgId:'org-a', secret:'ALPHA'}`. Cross-tenant disclosure, no attacker
  required — two logged-in users and one cached query.

  The key now carries the read's authority: `query:<name>:<authority>:<fingerprint>:<tags>`, where
  the authority is `JSON.stringify([kind, id, orgId ?? null])`. JSON rather than a joined string
  because an actor id containing the separator could otherwise spell a boundary it does not own —
  the rule `@ultimat3/entity`'s `scopeKey` already states. A new `cache.scope` picks the sharing
  width: **`'actor'` (the default)**, `'tenant'`, or `'global'`. The default is the narrowest, which
  is what makes forgetting safe; widening is a written claim that the rows do not vary by caller,
  and `'tenant'` with no `orgId` narrows to the actor rather than widening to everyone. A fourth
  scope is an `assertNever` compile error. The **request memo was never affected** — it keys on `ctx`
  identity and `.as()` mints a child context — so only the tier key was wrong.

- **An action's `cache.invalidates` busted nothing on any deployment without Redis.** The read cache
  was installed beside the tier registry rather than inside it, and `invalidateTags` fans out to
  registered tiers only; `invalidateQueryTags` — the function that would have closed the gap — had
  **zero production callers**. So after an invalidation reported `errors: []` over
  `['request-memo','lru']`, a fresh `Ctx` was served pre-write rows without executing the source.
  The read cache is now always a view of an object the same boot also registers, so it sits inside
  the one fan-out. This one landed first: it produces a failure indistinguishable from the two
  race conditions below and would have masked them in any reproduction.

- **An invalidation landing while a read was in flight was overwritten by pre-write rows, for the
  full TTL.** T0 miss → `run()`; T1 a mutator commits and the bust drops a key that is not there
  yet (a no-op); T2 `run()` resolves with rows read *before* the write; T3 the fill publishes them.
  Invisible to every reader until the TTL expired, and the invalidation report said `errors: []`.
  A read-through fill now samples a **fence** before the source read and re-checks it before every
  tier write, taking back what it already wrote. The fence is a bounded ring of recent invalidation
  marks (`FENCE_MEMORY = 1024`) sampled by generation, not a per-tag epoch map: a map keyed by tag
  is unbounded and a single global counter over-invalidates every fill. It degrades
  **conservatively** — a sample older than the ring proves answers invalid, on the argument that one
  refetch beats a stale TTL. `markInvalidated` fires on an explicit `write` too, since a write is
  newer truth than a load already in flight.

  This is the executed path for every `cache:` query: `runQuery` → `readRows` → `readThrough` →
  `fill`. `createCacheStack` carries the same fence and **still has no production caller**, so its
  copy is dormant. The fence is also **per process** — two pods can still interleave a load on one
  with a write and bust on the other; that residual has a `wiki/Known-Gaps.md` row.

- **Two ordering defects on the shared Redis tier, and fixing the second one alone would have made
  it worse.** The invalidation script dropped the tag bucket atomically with `SMEMBERS`, so a
  refusal in the client-side `DEL` batch orphaned the surviving members permanently — a retry
  answered `keys: []` and those value keys lived out their TTL unreachable. And `set` wrote the
  value key before the tag `SADD`s, so a bust landing between them found an empty bucket and the
  just-written value survived its own invalidation. Reversing that order **on its own is worse**:
  `SADD`-then-`SET` with no re-check lets the bust `SREM` the membership and the later `SET`
  publish a row unreachable by *any* tag, so it can never be invalidated at all. Both halves landed
  together — buckets joined first, then `SET`, then an `SISMEMBER` re-check that deletes the value
  it just wrote when a bucket says it is gone (only a literal `0` counts as evidence; a reply the
  tier cannot read is not). The sweep now `DEL`s, then `SREM`s **only the members that actually
  died**, and rethrows the first refusal. Every command stays single-key and slot-local, so the
  Redis Cluster and Dragonfly fix from 1.2.0 is not reintroduced. Proven against a real Redis, not
  a fake.

- **Invalidation fanned out in read order, so a racing read promoted a stale value backwards.**
  After `invalidateTags` returned `errors: []` over `['request-memo','lru','redis']`, `lru.get`
  still answered `'STALE'` — a read racing the bust pulled the value out of the not-yet-cleared far
  tier and promoted it into the already-cleared near ones. The fan-out and `CacheStack.drop` now
  clear **farthest-first**; the report is re-sorted into read order afterwards so the `/_x` panel is
  unchanged.

- **One transient database error killed the `worker` role, permanently and silently.** A rejecting
  `fleetSlots.acquire()` left the in-process limiter lease unreleased, so each failure burned one
  concurrency slot for good. Proven: a concurrency-4 worker whose lease store rejects four times
  reports `limiter.inFlight() === 4` and then claims nothing — after the store recovers,
  `worker.tick()` returns 0 executions, forever. The only symptom was four `jobs.worker.tick-failed`
  lines and a climbing queue depth. The acquire now runs inside a `try` whose `catch` releases
  before rethrowing.

- **A fleet-slot renewal answering `false` was discarded, so `job.concurrency` was silently
  exceeded.** `LeaseStore.renew` documents `false` as "the slot is no longer this holder's" and
  `SQL_LEASE_RENEW` is guarded on `holder = $3` for exactly that, but the renewal was
  fire-and-forget. A worker stalling past the slot TTL kept running after another worker took slot
  0 — two concurrent runs under `concurrency: 1`, nothing logged. The renewal now reads its answer,
  stops the timer, logs, and aborts the run with the new `X_JOB_SLOT_LOST`. The file's own comment
  claiming "the heartbeat is what reports a lost lease" was **wrong** and is deleted: the heartbeat
  renews `x_jobs.visible_at`, a different row on a different clock.

- **`OutboxRelay.stop()` did not join the tick in flight** — the one loop in the package whose
  `stop()` did not, where `worker.ts` and `scheduler.ts` both do. A SIGTERM between `driver.enqueue`
  and `markPublished` either re-published the row next boot or hit a closed pool. It now awaits the
  pass, and the dev runtime's two teardown paths hold the promise rather than dropping it.

- **`x jobs ls` against `x dev` paged the hundred *oldest* rows.** The memory driver's
  `introspect.list` sorted `createdAt` ascending where the Postgres driver sorts `created_at desc`,
  and the limit lands after the sort — so an operator looking for what had just broken got the
  oldest jobs in the queue. The two drivers now answer the same question, pinned by a new
  `driver-parity.test.ts`; there was no driver-parity mechanism in the package before this.

- **`configureLifecycle({ deadlineMs })` did not bound a drain at all.** Only the in-flight wait was
  bounded; every shutdown hook was awaited with no deadline, so the file header's "under one
  deadline" was false. Proven: `deadlineMs: 100` with one 5-second `accept`-phase hook resolved
  after **5053 ms**. A `worker` pod holding a 10-minute job ignored its budget and was SIGKILLed
  mid-job by the kubelet — turning at-least-once into the every-deploy duplicate that draining
  exists to prevent. Each phase is now raced against the remaining budget. See *Changed* for the
  behaviour this now has by default.

- **A statement from a finished transaction landed inside the next one.** The PGlite driver skipped
  its turn queue whenever an `AsyncLocalStorage` transaction store was present, and that store
  survives into any promise chain started inside a transaction body — so a statement an app forgot
  to `await` jumped the single-session queue into somebody else's open transaction. Reproduced as
  `BEGIN, select 'inside tx', COMMIT, BEGIN, select 'straggler', select 'inside tx 2', COMMIT`. The
  fence is now the transaction's **liveness**, not the store's presence. The late statement takes
  its own turn quietly, matching what the pooled driver already does — a throw here would mean an
  app that works in production crashes under `x dev`.

- **A `cache.ttlMs` mistake became a permanent runtime failure.** Nothing validated it at
  declaration, so `ttlMs: Infinity` compiled, passed review, and made **every** read of that query
  fail forever with `X_CACHE_TTL_INVALID`. `query()` now refuses it at declaration with the new
  `X_QUERY_CACHE_TTL_INVALID`.

- **A dropped `await` was caught by nothing, and the deployed app was linted against nothing.**
  Three floating promises shipped in this one sweep — a relay teardown, an outbox pass, and an
  `authorize` call in a test that therefore asserted nothing at all. `lint/nursery/noFloatingPromises`
  is now `error`: 2 pre-existing violations repo-wide, 3884 files, and `bun run lint` costs 6s → 7.1s.
  Found while enabling it: `dummy/social-media-clone/biome.json` set `"root": false` with **no
  `extends`**, so the one **deployed** app inherited none of the repo's lint rules — proven both ways
  with a planted probe. It now extends the root, and its config no longer pins a stale Biome schema
  or a field Biome will remove in its next major.

- **A subscribe cap was checked before the registration that grows the count, so one batch of
  frames walked past every one of them.** `LiveQueryRegistry.subscribe` called `assertCapacity` at
  the top and attached the subscription three awaits later; `ChannelHub.subscribe` read
  `socket.topics.size` and the bridge table and acted after two. `sync-node.message` dispatches
  every frame as `void (async () => routeFrame(…))()`, so one WebSocket write carrying N subscribe
  frames is N concurrent reads of a count nothing has grown yet — `maxPerSocket`, `maxPerTenant`,
  `maxTopicsPerSocket` and `maxTopicsPerNode` bounded nothing, in the ordinary case, with no
  attacker required. Each is now a **reservation** taken synchronously before the first await:
  `SubscriptionBook.reserve(socket, sid)` decides the sid claim and both live-query caps in one
  step, `ChannelHub` decides both topic caps and the node's bridge slot in another, and every path
  gives the slot back in a `finally` where a second release is a no-op. The tenant is captured at
  reservation and never re-derived — a re-auth can `retenant` a socket while its snapshot read is
  in flight, and the release has to credit the tenant that took the slot.

  Inbound frames now also run in **per-key FIFO lanes** (`frame-lanes.ts`: `mutate` is one lane per
  socket, `subscribe` is `sub:<sid>` or `topic:<name>`, every other kind is unlaned, and a lane
  exists only while work is queued on it because a lane keyed by a client-chosen sid that outlived
  its work is an unbounded map one socket can grow). The lane is deliberately never the whole
  socket: the slowest frame is a subscribe's snapshot read, the DB round trip every reconnecting
  client pays once per live query, and a global lane puts every other frame behind it during the
  restart storm this package is measured on. **The lane is not what closes the cap hole** — N
  sequential subscribes still pass a check-then-act cap N times, and the per-tenant cap spans
  sockets where no lane can see it at all. The reservation is what closes it.

- **Two concurrent subscribes to one topic opened two transport subscriptions, and the orphan
  outlived `hub.close()`.** `#bridge` looked the topic up before its `await` and wrote the result
  after it, so the second open replaced the first in the table and the first became unreachable —
  by `#release`, by a socket dying, by `close()`, by anything — delivering every message on that
  topic twice for the life of the node. A bridge is now `{ sub: Promise<TransportSubscription> |
  null; refs }` published into the table **before** it is awaited, so a second subscriber joins the
  in-flight open instead of starting one, and a bridge released while it is still opening is
  unsubscribed when the handle lands (`unsubscribeWhenOpen`) rather than dropped on the floor.

  Two more from the same window. A socket that closed mid-`subscribe` stranded its `QueryEntry`
  for the process lifetime: `SocketRegistry.remove` reports a connection that has already gone, so
  nothing called `close()` on the object, `socket.closed` stayed false, and the attach three awaits
  later had no way to learn the socket was torn down while it read. `remove()` closes the socket it
  drops, and the attach is `#attachUnlessGone`. And `startRead` cleared `entry.stale` on the way in
  and never put it back, so a snapshot that **rejected** — the pool exhausted by the same incident
  that invalidated the window — left the entry unmarked over rows it is known to have missed a
  change on; nothing re-read, and `#resnapshot` then served every desynced subscriber out of that
  divergent window and cleared their marks. `readSnapshot` restores the mark when the read does not
  answer.

- **A reconnected client was subscribed to its channels in name only, and every committed mutation
  was replayed forever.** Seven defects on the client half of the protocol, all of them on the
  reconnect path this package is measured on.

  | Defect | Consequence |
  |---|---|
  | `onOpen` replayed registrations and never `#topics` | topic membership is state on the node's socket and `hello` carries none of it, so `client.subscribe(topic, …)` was dead from the first reconnect onward — handler still installed, presence membership swept, no frame ever arriving |
  | `onOpen` carried no `#socket !== socket` guard, which `onMessage` and `onClose` both had | a replaced socket opening late marked the connection up and replayed every subscription onto the current one |
  | a `patch` frame did not advance `registration.cursor` | `cursor.at` froze at the last snapshot, so `shouldResnapshot`'s lag check answered "re-snapshot" for every client connected longer than `maxLagMs` — the delta resume the retained window exists for, dead exactly during the deploy storm it was built for |
  | a successful `ack` retired nothing | the journal row and the rebase-log entry both stayed, and `reconcile`'s `candidate.seq >= (entry?.seq ?? 0)` (`rebase.ts:112`) reads a key the log no longer holds as **everything in the log** — so a later rebase replayed mutations the server had already applied, over rows that had moved on. `commitAccepted` drops both; the row itself is left exactly as the optimistic twin wrote it, because an accepted write must not flicker |
  | a refused `ack` rolled nothing back | the denied write stayed on screen forever. `rollbackMutation` (new in `rebase.ts`) undoes it and every write made after it, newest first, then replays the others without it — sound only because `local` is pure — and drops the intent rather than retrying it, because a denial is a decision about that intent |
  | `drain()` marked a mutation `acked` when `send()` returned | a browser `WebSocket.send` on a CLOSING socket discards the frame and returns normally, so every in-flight mutation was lost on exactly the socket death the durable queue exists to survive. A drained mutation is now `inflight` until an `ack`/`fail` settles it or `requeueInflight()` returns it |
  | `connect()` reported the state of the socket it was replacing | a `useLive` opened in that window sent a subscribe frame ahead of `hello` and a second one for the same sid when `onOpen` replayed it (`X_SUBSCRIPTION_ID_TAKEN`), and a `connect` callback that threw — mixed content, a URL the page may not open — left the client reporting itself online with no socket and no armed timer |

  Alongside them: `drain()` is one pass at a time, chained rather than joined, because two
  overlapping passes read one entry as sendable and put one key on the wire twice while a later
  pass can overtake the one in front of it; a terminally `failed` key no longer collapses a
  re-enqueue onto itself, since nothing retries a denial and collapsing made an explicit
  idempotency key unusable for the rest of the session; `useLive` opens in `offline` rather than
  `loading` when there is no socket, because `loading` is a promise that rows are on their way;
  every fire-and-forget promise goes through `#detach`, which reports to the client's own `onError`
  instead of becoming a `window.onerror`; and `setLiveClient` releases the previous registration's
  queue listener, which leaked one listener per hot reload and per test case.

- **A `sync` node accepted websocket upgrades between SIGTERM and close, and a failed frame acked
  something no client could look up.** The shutdown hook was registered with no phase, so both
  halves landed in `close` and `fetch` went on upgrading new sockets onto a process that was going
  away. There are two phases now: `accept` calls the new `SyncNode.stopAccepting()` — `/readyz`
  answers 503, a late upgrade is shed with `retry-after-ms`, and **every socket the node holds
  keeps its patch stream**, because a draining node still owes its clients their patches and
  `stop()` is what releases the change subscription carrying them — and `close` is `drain()` then
  `stop()`. `listenSyncNode` unregisters both.

  The failure ack named `ws.data.socketId`. A client resolves `ack.ref` through
  `queue.fail(ref)`, which looks a mutation up by its idempotency key, so a socket id named a key
  no queue holds and the whole rollback path was inert end to end. `ackRefOf(frame, socketId)`
  answers the mutation key for a `mutate`, the sid for a `subscribe`, and the socket id only for a
  frame that could not be decoded — where there is nothing else true to say. Two more: the `rebase`
  frame is now sent **before** its `ack`, since the ack is the receipt that retires the client's
  rebase entry and a rebase landing after it has no entry left to read the mutator's conflict
  strategy off (every merge silently becoming `server-wins`); and a topic guard that **fails** on
  the re-auth pass keeps the topic instead of dropping it — `catch { unsubscribe }` reported a store
  that timed out as a revoked grant, on every topic of every re-authenticated socket on the node,
  silently, with the client never told to resubscribe. Only a denial unsubscribes; anything else
  counts `hub.guardFailures` and logs `channel.guard_failed`. The initial `subscribe` is
  deliberately not split that way: there is no subscription to keep, so a raising guard refuses that
  subscribe and the client hears about it.

- **`t.nullable(x)` produced a JSON Schema that rejects `null`, and a scaled `Money` round-tripped
  as unscaled.** `json-schema.ts` set `nullable: true`, a keyword no JSON Schema draft after
  OpenAPI 3.0 defines, so the generated OpenAPI, an MCP client and a contract test each saw
  `{ type: 'string' }` and rejected the one value the declaration exists to permit. It is
  `{ anyOf: [<converted>, { type: 'null' }] }` now, annotations hoisted outside the `anyOf` because
  they describe the field and not one branch of it, and `requiredKeys` is untouched — nullable is
  not optional. Four more on the same projection seam:

  | Defect | Fix |
  |---|---|
  | `.default(value)` stored one object and handed the same reference to every parse that omitted the field, so a handler's mutation became the next request's starting value | cloned per parse through `structuredClone`; a default that cannot be cloned is refused at the first import of the authoring file as `X_SCHEMA_DEFAULT_UNSHAREABLE` |
  | a `Money` with an explicit `scale` was written to a column recording minor units only, so six decimal places read back at two — a 10,000× error on the read path, the mirror of the conversion bug #105 fixed on the compute path | scale persists as a third physical column, `<p>_scale`; `pg-row.ts`, `describe.ts`, `realtime`'s logical-decoding row decoder and both scaffold templates fold it back the same way, and `pg-entity-row-parity.test.ts` pins the replication decoder against the query decoder, which had already drifted |
  | a cursor is JSON, so a `Date` became a string and a `bigint` threw — a read ordered by `createdAt` resumed at a position no comparison could reproduce, and pages repeated or skipped | values are tagged (`{ $x: 'date' \| 'bigint', v }`) and revived; a sort value that is neither scalar nor one of those two is refused where the cursor is minted, `X_CURSOR_VALUE_UNSUPPORTED`, because the mistake is the read's own `orderBy` and no retry repairs it |
  | a query is served as `GET /_x/query/<name>`, so its input is characters — the typed client encoded a nested object as JSON text with no inverse in `coerceQuery`, and a required `t.nullable(...)` member was skipped entirely | `X_QUERY_INPUT_UNENCODABLE` raises at `query()`, in the file that declared it, rather than at the first request that hits it |

  Also, each with a failing test written first: `logger.ts` threw inside the writer on a value
  `JSON.stringify` refuses — a `bigint`, a circular reference, a throwing getter — losing the line
  it was writing and, on a `console` writer, the ones after it, so serialisation is total now;
  `cache/graph.ts` walked every registered dependency per invalidation and reads a `byEntity` index
  instead; and `mcp/cross-surface.test.ts` pins `action`'s `mcpSchemaOf` against `mcp`'s
  `toWireSchema`, which had already diverged once on `pattern` — the two live either side of a tier
  line and cannot share a home below tier 4 today, so the guard is the honest fix until one exists.

- **`convert()` derived the decimal shift from the currency's exponent instead of the amount's own
  scale, and then dropped the scale.** `convert(money(1_000_000, 'USD', 6), 'EUR', { rate: 1 })` —
  $1.00 in micros — answered `{ minor: 1000000, currency: 'EUR' }`, EUR 10,000.00 for an expected
  EUR 1.00. That is precisely the failure `scale` was introduced to prevent, and it violates the
  package's own written rule: never `exponentOf(amount.currency)` for a value's own precision. The
  shipped derivation is `resultScale = amount.scale ?? exponentOf(target)`, which leaves every
  unscaled conversion byte-identical.

  `fromDecimal` rounded through a float — the one thing `@ultimat3/money` says it never does — so
  `Number('0.4999…9')` collapsed to exactly 0.5 and `roundToInteger` saw a tie the exact decimal
  does not have: `fromDecimal('1.0049999999999999999', 'EUR', { rounding: 'half-up' })` answered
  101 where the exact answer is 100, and `'1.0250000000000000001'` under `half-even` answered 102
  where it is 103. It is the entry point every user-typed price goes through, and `roundRatio` —
  exact over bigints — already existed for `multiply`/`divide`/`convert`. It uses it now.

  In `@ultimat3/time`: two `Intl` formatter caches were unbounded `Map`s keyed on the raw
  zone/locale string while `isValidTimeZone` accepts every casing of an IANA name, so
  `x-timezone: eUrOpE/bErLiN` minted a permanent formatter per casing — unbounded memory keyed on
  a request header, measured at 31.4 MB for 4,096 casings. Both share one bounded FIFO now, and
  `canonicalTimeZone` (exported) plus an internal `canonicalLocale()` collapse spellings so one
  zone and one locale are one key each. `businessDaysBetween` depended on the time of day —
  `Mon 09:00 → Fri 10:00` was 4 and `Mon 09:00 → Fri 08:00` was 3 for the same calendar span — and
  now compares local dates over a stated `[from, to)`, returning `0` and never `-0` for an empty
  reversed interval. `describeCron` ignored the seconds field, rendering `*/10 * * * * *` as "every
  minute", and refuses what it cannot describe with the new `X_CRON_NOT_DESCRIBABLE`: a summary
  that is wrong is worse than one that declines, and `CronPhrases` is a public interface built
  outside the package, so adding a phrase is a cross-package change. `observesDst` probed with
  `setUTCMonth(+n)`, which rolls over at month end, so its twelve probes were not twelve distinct
  months — fixed with **no test**, because a search of all 445 IANA zones × month-end days × 7
  months in 2026 found zero cases where the answer differs, and a test that cannot fail is not a
  test.

- **A deployment that declared production the framework's own documented way served the dev error
  overlay and a report-only CSP.** `http/config.ts` read `NODE_ENV` alone while `core/environment.ts`
  makes `ULTIMATE_ENV` the one environment key with `NODE_ENV` as its fallback. Proven: with
  `NODE_ENV` unset and `ULTIMATE_ENV=production`, `dev` is true and `csp.reportOnly` is true — so
  any unauthenticated request with `Accept: text/html` provoking a 5xx gets absolute filesystem
  paths, module layout and internal cause strings, and the app's CSP is not enforced at all,
  un-mitigating every XSS elsewhere. The shipped container path sets `NODE_ENV=production`, which is
  why it had not bitten; a binary artifact, a PaaS rung of the documented ops ladder, or a Helm
  `env:` override following the documented key all reach it. `ULTIMATE_ENV` is the single signal now
  in `http/config.ts`, `admin/dev/server.ts` and `cli/cmd-doctor.ts` — the last of which also
  silently skipped `X_CURSOR_SECRET_DEV` and `X_STORAGE_SECRET_DEV`, leaving the published
  `DEV_SIGNING_SECRET` usable to mint signed uploads. `X_ENV` was a spelling nothing else read, and
  its `??` short-circuit made `X_ENV=prod` answer "not production" outright.

  Six surfaces that trusted their input, in the same sweep:

  | Surface | What it trusted |
  |---|---|
  | JWKS cache | an unknown `kid` short-circuited before the TTL was consulted, so a forged token issued one outbound fetch per attempt — measured at 500 attempts, 500 fetches. Unauthenticated: `kid` is read out of the attacker-supplied header before any signature check, and auth is pipeline stage 6 while rate-limit is stage 7, so the framework's own limiter never saw it. The damage lands on the IdP, and recovery waits on *their* unblock timeline |
  | log redaction | three of eight default keys were inert — the literal `Set` stored `apiKey`/`accessToken`/`refreshToken` in camelCase while the lookup lowercases, and those are the exact field names on `OAuthTokens` |
  | uploads | `image/svg+xml` left the default allowlist |
  | links | nothing in `render`/`ui`/`admin` checked a URL scheme, and `isExternal()` tests `/^https?:/`, so a `javascript:` href was additionally treated as internal and got no `rel="noopener"`. `safeUrl` lives in `@ultimat3/core`, not `render`: `ui` may not import `render`, so the Link/Avatar/Breadcrumb half — the half the finding names — would have been unreachable or a second implementation. The `timing-safe-equal` precedent |
  | argon2id | both existing limits are per-source and bound memory rather than work, so an attacker rotating an IPv6 /64 could queue ~19 GB of arenas. A concurrency gate now bounds the work |
  | the MCP transport, the remote embedder, RAG context | the transport reads through core's counting reader instead of Bun's 128 MiB default (`readWithinLimit`, moved down to core rather than duplicated); the embedder got a deadline and a response cap; RAG context is fenced, id-labelled blocks instead of a separator a document can contain |

  MFA's error named a route that does not exist — there is no handler, no `completeMfa` export and
  no pending-MFA state — and **the second leg is not shipped here**: the only correlation value
  handed over is the user id, so the natural implementation is unauthenticated by construction and
  would turn MFA from a second factor into the only factor. The `fix:` and the wiki row describe
  what an app must actually do, the user id moved from `cause` to `meta` (both public surfaces
  publish `cause` and drop `meta`, which also closes `oauth-route.ts`'s 401 leaking internal user
  ids), and `packages/auth/CLAUDE.md` carries the design constraint for the real fix.
  `acceptSignedUpload` stays deliberately unmounted for a recorded reason: the HMAC secret is
  closure-private in `localDriver`, so a CLI-side route would re-derive it from env — a second
  resolution of one secret, wrong for any app passing `signingSecret` explicitly, leaving the route
  verifying against the published `DEV_SIGNING_SECRET` while the driver signs with the real one. A
  mounted route accepting forged grants is worse than a 404. And `x dev` stopped printing
  `DATABASE_URL`, `NATS_URL` and `S3_ENDPOINT` with their credentials.

- **One mass event blocked a `sync` node for 17.7 seconds.** `ofSocket()` copied the node's entire
  subscription map on every call and both callers run once **per socket** — every WebSocket close,
  every revoked grant, and the 30-second grant sweep. No attacker capability required: the trigger
  is a deploy, a network blip, or a batch of grants whose `expiresAt` expire together. Measured at
  2,000 sockets × 50 subscriptions: 17.7s of blocking main-thread work per sweep, during which the
  node answers no heartbeat, no patch and no accept — a routine reconnect storm becomes a
  self-sustaining outage. A `#bySocket` secondary index makes it sub-millisecond, the shape
  `lru.ts` and `presence.ts` already use. Three more capacity gaps beside it:

  | Gap | What shipped |
  |---|---|
  | `AcceptBudget` spends one token per **upgrade**; after the socket was open, `message()` spawned an unawaited task per frame with no ceiling | one authenticated socket — the cheapest foothold there is — reached three amplifiers, the worst a per-tenant walk measured at 7.96 ms/frame at 100k subscriptions, so ~155 frames/s consumed the node. That walk is O(1) off the same index, and every socket carries its own token bucket checked at the top of the frame router, before the frame touches anything (`X_FRAME_RATE_LIMIT`) |
  | the frame decoder enforced no size cap on any array or payload, and `Bun.serve` was called with no `maxPayloadLength` | `FRAME_LIMITS` are hard ceilings a caller may narrow and never widen, the `query-limits.ts` shape. `CURSOR_ID_LIMIT` had applied only where the **server** builds a cursor, so a client-supplied one was consumed raw, and `canonicalJson` recurses, so a deeply nested `input` was a stack overflow on the frame path — `input` is walked iteratively for exactly that reason |
  | nothing bounded the concurrent socket **count** | the audit credited a 120-second idle sweep, and that premise was wrong in the dangerous direction: `SocketRegistry.sweepIdle()` has no production caller anywhere, and the only idle enforcement is Bun's ping timeout, which a client answering pings never trips. `maxConnections` is the ceiling, and the accept **rate** and the socket **count** are two different attacks — 500 accepts/s held open with one keepalive each is 1.8M sockets an hour |

  Plus a node-wide entry cap (a `qid` derives from client-chosen input, so distinct inputs mint
  distinct matchers and row windows), a **byte** budget on the change buffer where an entry-count
  budget retained up to 4.19M whole rows, `forget(qid)` finally called from `unsubscribe` — which
  had no caller at all — and a replication URL that no longer echoes its password into a coded
  error. Both audit measurements reproduced within 12%: 17.7s against a claimed 15.8s, and
  7.96 ms/frame against 6.45. Every new ceiling is a constructor option whose default clears this
  repo's own measured 50,000-socket bench with margin, because a default that refuses a proven
  workload is an outage the framework caused. `X_SUBSCRIPTION_LIMIT`'s `fix:` named
  `realtime.limits.perSocket in app.config.ts`, a field that does not exist — and that
  `docs/architecture/07-realtime-internals.md` says outright does not exist — and now names the
  constructor options that do.

- **The tenancy guard was inert on the job surface: the same write, the same actor, naming another
  org, was refused over HTTP and accepted through the queue.** An explicit `ctx` was honoured as a
  parameter and never installed as the **ambient** context — `runWithContext` appeared nowhere in
  `packages/jobs` — and `@ultimat3/entity`'s guard derives from the ambient one, so `actorTenant`
  was undefined, `scopedPlan` derived no predicate, `verifyScope` returned early, and a
  caller-named tenant was accepted unchecked. Reachable by any app routing user input into a job,
  which is the framework's own documented instruction.

  ```text
  HTTP surface, write naming another org -> X_TENANCY_ACTOR_MISMATCH
  JOB  surface, write naming another org -> ACCEPTED
  rows now visible to org-B: 1
  ```

  Installing the context fails **closed** — the worker context carries no actor — so the fix could
  not land alone, which is why `tenant` is now a required field on `job()` and `backfill()`; the
  migration is below under *Changed*. The design choice is recorded in `packages/jobs/CLAUDE.md`:
  jobs declare their tenant rather than a boot-supplied service actor, because one identity shared
  by every job **is** the cross-tenant read the declaration exists to prevent, and it would move the
  decision into deployment config where no reviewer sees it. Also fixed here: a run was acting as
  two tenants, because `executeJob` built its context as `Object.freeze({ ...ctx, actor: runActor })`
  and a registered service closes over the ctx it was built for — so the body received
  `ctx.<service>` bound to the **worker's** org while every ambient repository call used the
  **job's**. `withChildContext` already existed for exactly this and rebuilds managed factories
  against the new actor. `createLimiter` silently meant "no cap" for a non-finite `maxTenants`
  (`Math.floor(NaN)` is `NaN`, `Math.floor(Infinity)` is `Infinity`, and both make `size >
  maxTenants` false in either branch) and is refused now, the `createPacer`-refusing-`rate: 0`
  precedent; jobs' four per-tenant limiter maps gained the sweep and cap `http`'s limiter already
  had, having grown one permanent entry per org on a never-restarting worker.

- **The gate did not check what it claimed: `scripts/` compiled nowhere and two Lua scripts had
  never run.** `bun run typecheck` is `tsc -b`, which builds only referenced projects, and
  `scripts/tsconfig.json` set `composite: false` with no root `references` entry naming it — so
  `verify.ts`, `boundaries.ts`, `manifest.ts`, `reference-app-gate.ts`, `release.ts`, `roadmap.ts`
  and `error-render.ts` were typechecked by nothing. Proven by probe: `export const probe: number =
  'nope'` under `scripts/` passed `tsc -b` with exit 0. The project is composite and referenced now,
  and the 7 real errors it was hiding are fixed — one of them a live bug, `bun run workspaces:list`
  printing "may import 0-NaN" for all 29 workspaces because `allowedTiersFor` was handed a directory
  name where a tier number was required. `X_PACKAGE_UNREFERENCED` fails a package the root
  `tsconfig.json` does not reference, so the hole cannot reopen.

  The Redis tier's two Lua scripts had never executed: both fakes matched on the exported constant's
  identity and then applied their own TypeScript copy of what the script was supposed to do, so the
  tests asserted the fake against itself. Gutting `REDIS_INVALIDATE_SCRIPT` to `return {}` survived
  all 517 tests in `cache` + `query` — and that script is the shared tier's entire invalidation
  path, so every Redis deployment would have served pre-write rows until TTL with the bust reading
  as clean. `packages/cache/src/redis.live.test.ts` runs behind `TEST_REDIS_URL`, green against a
  real server and red under both mutations, and the fakes now throw on an `EVAL` they cannot run.

  `describeApp`'s teardown unsealed the network and restored the real clock for every later test
  file in the process — it restored state it never captured, so every file after the first
  `describeApp` ran with real `fetch` (unmocked egress), a real `Date` and a real `Math.random`. The
  framework's own suite survived only because `harness.test.ts` hand-patched it in an `afterAll`
  whose comment admitted the leak; that hand-patch is deleted and teardown captures what it takes,
  in a `finally`. `bootApp()` had the same defect in its own new code: a rejecting
  `acquireWorkerDatabase`/seed/boot returns no `BootedHarness`, so no caller can reach `close()` —
  init is its own teardown now, and a drop that throws does not replace the boot's failure.

  Also: a floor step whose suite runs zero non-skipped tests is a finding rather than a pass (`live`
  was reporting green over 4 of 118 tests); both tracked apps commit an `x.verify.json` and `x new`
  scaffolds one, with `X_REFERENCE_APP_NO_FLOOR` refusing a gated app that ships none; a pinned step
  that turns *skipped* is still pinned rather than a stale pin; type-only imports no longer dodge
  the tier check; test-suite ownership is exclusive again (`e2e` matched both `e2e/` and
  `.e2e.test.`, so `e2e/payment.contract.test.ts` would have run twice — latent, since every file
  under an `e2e/` directory today is `*.e2e.test.ts`); `scaffold-smoke` lost `continue-on-error` and
  blocks on its own ratchet (`X_SCAFFOLD_GATE_RED`), whose first blocking run proved the blanket
  waiver stale — it was justified by one pinned `typecheck` gap that now **passes**, while covering
  `lint`, `errors` and `budgets`; and `timing-safe-equal`'s branch-free property is pinned by source
  shape. Three audit premises were falsified and recorded rather than fixed: every test shard
  already runs `--isolate` (the real divergence was one flag missing from the root `test` script),
  `source-files.ts` already listed `scripts/**`, and `/e2e/` is not expressible as a bun filter —
  bun 1.3.14 answers "had no matches", and the working form is `e2e/`.

- **The one flaky test in this repo asserted a sleep ordering as a fact.** Core's `stays isolated
  across concurrent async tasks` asserted that three tasks sleeping 30ms, 5ms and 15ms observe in
  exactly the order b, c, a — under load a 5ms sleep overshoots a 15ms one, and one unit shard
  failed and passed on retry across three separate PRs before it was caught. The assertion is the
  observed **set** now, which still catches a leak as a duplicate or a wrong id, proven by mutation;
  the property the test exists for, each task seeing its own ambient context, is asserted separately
  and was never at risk. It falsifies the audit's own "verified sound — do not fix" note that there
  is no wall-clock flakiness because the preload freezes `Date` and seeds `Math.random`: `Bun.sleep`
  is a real timer, and three byte-identical runs on an idle machine is the evidence that misses a
  load-dependent race.

- **`docker-compose.prod.yml` no longer publishes a host port and asks for three binders of it.**
  `web` shipped `ports: ['3000:3000']` beside `deploy: { replicas: 3 }` and `sync` had the same
  shape — one host port has exactly one binder, so the second container dies on
  `Bind for 0.0.0.0:3000 failed: port is already allocated`, reproduced with Docker rather than
  reasoned about. Both roles are `replicas: 1` in all four files now: the framework's, both tracked
  apps', and the one `x new` writes. That makes the rung-1 ceiling **declared** rather than
  discovered at the second container — it is not lifted, and each file's header names the two ways
  up: delete the `ports:` lines and put your own reverse proxy on the compose network, or climb to
  `docker/helm`, which already carries a per-role HPA and an Ingress. The framework ships neither
  proxy; one in the compose file is a dependency every app inherits and a second answer to "how
  does traffic reach a role" beside the chart's Ingress. `docs/ops/README.md` carries the table.

- **`sync`'s `PORT` named a port the process never opens, in compose and in the chart.** The role
  binds `PORT + 1`, so `PORT: 3001` opened 3002 while the compose file published 3001 — a mapping
  to a socket nothing in the container ever bound. Compose now sets `PORT: 3000` and publishes
  `3001:3001`. The chart had the worse half of the same defect: `roles.sync.port` was rendered into
  **both** `PORT` and `containerPort`, so the readiness probe polled a socket nobody bound and the
  rollout never completed. `_helpers.tpl` derives the env as `port - 1` for that one role, so
  `values.yaml` still holds one number — the port the role listens on — and the two cannot drift.

- **The chart's Ingress routed `/_sync`; the sync node serves `/_x/sync`.** Every websocket fell
  through to the `/` rule and reached `web`, which answers no upgrade. The path is now the one
  `createSyncNode` matches on.

- **A typed client is not a thenable.** `rpc` and `queryClient` are `Proxy` objects that answer any string property with a call method, `then` included — so `await client`, `Promise.resolve(client)` and returning one from an `async` function each read `then`, got a function back, and were resolved by calling it: a POST to an action named `then`, or a GET of `/_x/query/then`, with the await settling on that response instead of the client. Both proxies now answer `undefined` for `then` — the one name the language reserves at this seam — and both test files pin `await client === client` with a fetch that counts its calls. The symbol assertion that stood there covered `Symbol.toPrimitive` and `Symbol.iterator` and could not have caught a plain string key.

- **The digest's window is calendar arithmetic at both ends, and its slots come from the occurrence.** Two defects in `examples/dummy`'s nightly digest, both of them a day of milliseconds standing in for a day. The delivery loaded `slotAt - 86_400_000`, while consecutive 09:00 slots are 23 hours apart on spring-forward and 25 on autumn-back: in Madrid on 2026-03-29 the window opened an hour *before* the previous digest closed and mailed that hour's posts twice, and an autumn transition left an hour that reached no digest at all. It now opens at `previousDigestAt(slotAt, zone)` — new in `@postly/core`, the mirror of `nextDigestAt` and the same `fromZoned` arithmetic — and the `postly.digestPreview` MCP tool, which promises "the same window", was computing the old one. The fan-out's slots were derived from `ctx.now()`, which runs on every attempt while only the enqueues already stored replay: an attempt taken after a zone's 09:00 had passed rolled that zone into tomorrow, so groups the first attempt had not reached were enqueued as a *different* digest — a next-day `slotAt` and `localDate` under a step name carrying no date to catch it. The base is now midnight UTC of `input.runDate`, the occurrence the task fired for, identical on every attempt.

- **Four call sites in the reference app that a review found before a user did.** `signedAvatarUrl` read one page of `disk().list()` and picked the newest key in it — S3 truncates at 1000 — so a member who re-uploaded past a page boundary kept rendering whichever avatar landed on page one; it now follows the cursor to the end, folding a page at a time rather than collecting every key to choose one. `toggleDigestOptIn`'s `custom()` resolver returned the whole optimistic row whenever the server was opted in, reverting a theme, a locale or a role changed on another device while the toggle sat in the offline queue; it now starts from the server row and resolves the one field it is about. `app/feed/page.tsx` fetched `feedActivity` inside an `async` component wrapped in a `<Suspense>` shim that ignored its `fallback` — nothing splits a page into holes yet, so the shell waited for the count anyway and the skeleton never rendered; the read moved to the route's `load()`, where every other read in the app lives, and the shim is deleted rather than left as a boundary that boundaries nothing. And because a query declares no output schema, a `Date` column arrives from the client as the ISO string `JSON.stringify` wrote: `site/blog/[slug]/page.tsx` called `.toISOString()` on it while rendering JSON-LD. The blog routes and the post page rehydrate at their loader through `shared/wire.ts`; the client's own header and the wiki now say what the wire hands back.

- **The reference app's pages pass the inputs their reads require and render the rows they were given.** Four call-site classes in `examples/dummy`, all of them the app calling a real API wrongly rather than the API being wrong. **Missing required input:** `app/posts/[id]/page.tsx` read `postById({ postId })` without the `orgId` `postRead` decides on — the org now comes off the actor, because `/posts/{id}` carries no tenant and a foreign id must read as absent; `app/feed/page.tsx` rendered `<LikeButton>` with no `orgId`, which `postLike` needs in the mutator's input so an offline queue replayed hours later still reaches the rule. **Wrong row shape:** the blog index fed `{ slug, updatedAt }` rows to `toCardPost`, which needs a title, an excerpt and a byline — there is now a `publicPosts` read behind it, `publicPostSlugs` going back to being only what its name says, the prerender enumeration; and `site/blog/[slug]/page.tsx` read `updatedAt` off a `PostView` that excludes it, so the JSON-LD's `dateModified` is gone (`ld.Article` defaults it to `datePublished`) and `datePublished` is an ISO string rather than a `Date`. **UUID in a name slot:** `app/posts/mail.ts` and `app/digest/mail.ts` interpolated `member.orgId` into `{org}` — a UUID where the reader expects their organisation's name — so both payloads now carry the org's name, top-level, which is the only level `renderMail` interpolates a subject from. **Hardcoded strings:** `'Postly'` in two JSON-LD nodes and two breadcrumbs is `t('common.appName')`, and `priceCurrency: 'USD'` on the landing and pricing pages is resolved from the URL by one shared rule both `meta` and the page body read, so structured data cannot quote a currency the visitor was never shown. Alongside them, in the same expressions: `ld` takes an array, `canonical` is its own key and not a field on `alternates`, `robots` is a `RobotsDirectives` object and not the string `'noindex'`, `ld.SoftwareApplication` requires `operatingSystem`, `ld.Product` takes one offer (so a pricing page with three plans emits three products), an offer's `price` is a decimal string, and `defineRoute` has no `feed:` key — the blog index declared three feed formats and emitted none. The app's typecheck baseline drops from 184 errors to 165.

- **The reference app's posts repository runs on the entity API that exists.** `examples/dummy`'s `apps/web/app/posts/repo.ts` was written against `.join()`, `.with()`, `.returning()`, `.onConflictDoNothing()` and `.returningInserted()` — five builder methods `@ultimat3/entity`'s `Table`/`ReadBuilder` has never had — so every function in it threw at the builder before a driver ever saw a statement, and the file carried 18 of the app's typecheck errors. Rewritten on the real surface: `authorName` is `preload('author')`, one extra `where id in (…)` for a whole page rather than a join that does not exist; an idempotent like is `upsertAll([row], { onConflict: ['postId', 'memberId'], onMatch: 'nothing' })`, whose empty result IS "that like was already there"; an unlike is `deleteWhere`, the only write path a composite primary key has; the recount is `count()` + `update(id, patch, { orgId })`; and the feed's projection is `select()`. `andWhere('publishedAt', '>=', since)` named an operator that does not exist and is now `'gte'`. `publishPost`'s policy row loader is scoped to the org its own input names instead of reading `posts` unscoped — `postPublish` denies a null row exactly as it denies a row from another org, so the scope decides nothing the rule did not already decide, and `X_TENANCY_UNSCOPED` no longer refuses the read before the guard runs. The app's typecheck baseline drops from 202 errors to 184 and five pinned-red tests turn green, `contract · every post action passes the contract an action owes` among them. One gap is left in the file, and it is now the only one: the public blog resolves `/blog/{slug}` with no tenant anywhere in the URL — which is why `post_slug_unique` is global — so `publishedBySlug` and `publishedSlugs` read a tenant-columned entity with no org predicate, and a deliberately cross-tenant read has no escape hatch.

- **One SQL scanner under the splitter, the read-only guards and the destructive rail.** `stripSqlNoise()` blanked spans by a sequence of replacements, comments first — so the `--` in `select '--'; delete from posts` read as a line comment and the `delete` was erased before `inspectStatement()` ever saw it, letting a mutating fragment through `readOnly(client, { seal: false })`. It now walks the same left-to-right lexer `statementsOf()` uses (new internal `sql-scan.ts`), where a `--` inside a literal is data because the literal is scanned first. Two more from the same lexer: a `$tag$` immediately after an identifier is no longer read as a dollar-quote opener — `$` is legal in a name after the first character, so `select foo$tag$; select 2;` is two statements and used to go out as one send — and `hasDestructiveMarker()` now finds `-- destructive: true` only as a **top-level line comment**, never inside a `/* … */` or a dollar-quoted body where a regex over the raw file matched it and bought an unmarked destructive migration past `x verify`.

- **A migration snapshot is the newest migration's, or there is none.** `declaredSchema()` returned the newest snapshot it could find, so a later migration written without one silently answered with an obsolete schema: `0001` records `posts`, `0002` adds a column by hand, and drift reported the column the database correctly holds as `unexpected-column`, fixed by generating a migration that already exists. It now returns `SchemaDescription | undefined` — the newest migration's snapshot, or nothing. `checkDrift()` reports that as an `unknown-schema` difference instead of `ok: true`, and `x db gen` refuses with the new `X_MIGRATION_SNAPSHOT_MISSING` rather than diffing against the empty schema, which would have emitted `create table` for every table the database already holds.

- **A generated index keeps its predicate and its direction, and a changed one is rebuilt.** The migration snapshot recorded an index's name, columns and uniqueness and dropped `where` and `order`, while the diff treated a matching *name* as a matching definition — so narrowing an index to a predicate or reversing it to `desc` generated an empty migration and the database kept serving the old one. The snapshot now carries all five fields and `x db gen` emits `drop index` + `create index` for any of them moving, since Postgres has no `alter index` for a column list, a uniqueness, a predicate or a direction.

- **`introspect()` reads a composite foreign key as one ordered pairing, not a cross product.** The catalog query matched `conkey` and `confkey` independently — `sa.attnum = any(c.conkey)`, `ta.attnum = any(c.confkey)` — so a two-column key joined four ways and `array_agg` emitted four source columns against four referenced ones, duplicated and misaligned. `compareForeignKeys` then read a correct database as `missing-foreign-key`, and the admin schema view and the MCP `schema.describe` tool both showed a key that does not exist. Both arrays are now unnested together (`unnest(c.conkey, c.confkey) with ordinality`) and ordered by that shared key position, so `references t (y, x)` no longer describes itself as `references t (x, y)`. Only a real engine can tell the two queries apart; the new `introspect-embedded.test.ts` boots PGlite and asserts the pair comes back whole.

- **`introspect()` reads an index's columns in index key order.** They were ordered by `attnum`, so a composite index on `(created_at, org_id)` whose columns were declared the other way round in the table came back reversed — a description that reads correct and compares wrong. It now orders by `indkey`, drops `INCLUDE` payload columns, and carries the index's predicate and direction alongside.

- **Drift compares the indexes migrations declare, not columns alone.** `compareTable` read column names only, so a dropped index or a composite index rebuilt with its columns transposed answered `ok: true`. It now reports `missing-index` and `changed-index` for indexes a snapshot names. A live index no migration declares is deliberately not reported — Postgres creates one per primary key and per unique constraint — and the predicate and direction are not compared, because the catalog returns its own rewriting of an expression and a text comparison would call two identical indexes drift. Named in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps).

- **Drift compares the foreign keys migrations declare.** `snapshotOf()` recorded `foreignKeys: []` beside an `up` that emitted `references "orgs" ("id")` — a snapshot denying a constraint its own migration creates — so `compareTable` had nothing to compare and `alter table "posts" drop constraint "posts_org_id_fkey"` on the database answered `ok: true`. A snapshot now records every key its `references()` columns write, and one the catalog does not hold is `missing-foreign-key`. Matched on **where the key points** and never on its name, because Postgres names an inline clause `posts_org_id_fkey` and a hand-written migration may have said `constraint fk_posts_org` — the same key under another name is the same key. `on delete` is not compared: the catalog spells it as one character and no generated clause declares one. A key the database has and no migration declares is not drift, for the reason index comparison gives. Named in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps).

- **`ROLE=migrate` exits non-zero on post-migration drift.** `runMigrations` logged the first difference and `runRole` returned success, so a release phase completed over a schema nobody can reconstruct. `x db migrate` and `ROLE=migrate` are still the same function call; the role entrypoint now throws the first difference, because the exit code is the only channel a release phase has.

- **A snapshot sidecar is validated, not asserted.** `readMigrations` checked that `tables` was an array and cast the rest, so `{"tables":[null]}` — valid JSON — became a `SchemaDescription` the diff then threw on. Every nested field is parsed by the new `parseSnapshot()` in `@ultimat3/db`; a file that does not describe a schema is *absent*, which the reader already handles.

- **A ledger the MCP host cannot read is not an empty ledger.** `db.migrate`'s dry run mapped every `readLedger()` failure to `[]`, so a permission denied or an unreachable server reported every migration as pending. Only Postgres' `undefined_table` does that now, through the new `isLedgerMissing()`; everything else propagates.

- **Four repo-scanning gate tests no longer time out under their own sharding.** `x test unit`
  runs eight shards competing for the same cores, and four tests in `scripts/` pay a whole-repo
  cost against bun's default 5000ms budget: `boundaries.test.ts`'s two `collectSourceFiles(repoRoot())`
  scans, `manifest.test.ts`'s `buildManifest(repoRoot())` `beforeAll`, and `verify.test.ts`'s error
  reference check — which is not a directory walk at all, but `registeredErrorCodes()` dynamically
  importing all 29 packages no matter how small the temp dir it was handed. Serially all four pass
  in well under a second of headroom; under contention that headroom is exactly what disappears,
  and **which** shard a file lands in depends on the file count, so it presented as an intermittent
  failure rather than a slow test. It surfaced now because this release adds files: every
  repo-scanning test got slower.

  The budget moves to `30_000`, following `error-contract.test.ts`, which had already been fixed
  this way and whose comment ends "same shape as `scripts/verify.test.ts`" — the diagnosis was
  written down and never applied to the file it named. Both `collectSourceFiles` tests moved, not
  just the one observed failing: they call the identical scan, so fixing one relocates the failure
  to another shard on another run. Proven by reproducing the failure under the gate's own
  `--workers 8` command and re-running it after the fix, once plain and once with four extra CPU
  hogs — 16 of 16 shard processes exit 0.

- **`scripts/stdout-truncation.test.ts` no longer asserts a race.** The premise case measured a naive `process.stdout.write` against a reader draining concurrently, and on a fast runner the whole payload landed by luck — a flaky gate step. It now writes past any kernel buffer and reads nothing until the child has exited, so what `process.exit()` discarded was genuinely discarded.

### Changed

- **BREAKING — `x db branch` takes a verb, and `x db branch <name>` no longer creates anything.**
  The argument *was* the branch name and `cmd-db.ts` fell through to it, so `x db branch ls` — the
  `fix:` line the planned `x branch` command hands out — cloned the database into one called `ls`.
  A stray database is not a typo an agent can see: it is a copy of production-shaped data with a
  name nobody will recognise a week later.

  | Was | Now |
  |---|---|
  | `x db branch feat-new-billing` | `x db branch create feat-new-billing` |
  | — | `x db branch ls` — name, location, created-at, size |
  | `dropBranch('<name>', { force: true })` from code only | `x db branch drop <name>` |
  | `import { branchSql } from '@ultimat3/cli'` | **removed** — it was the SQL text the `psql` shell-out ran |

  Every verb is itself a legal branch name, so verb-first is the only shape where a name cannot be
  read as a subcommand. A word outside `ls`/`create`/`drop` is `X_CLI_UNKNOWN_COMMAND`, and its
  `fix:` hands the caller's own word back inside the command that still creates it — so the one
  migration this breaks tells you what to type. `subcommandPositionals` in the registry now declares
  the verb set, so a `fix:` line or a wiki page naming a fourth verb fails the gate rather than the
  reader — including one that writes a `<placeholder>` where a verb belongs.

  **`drop` has no confirmation flag, deliberately**: it may only remove what `ls` shows, so the typo
  is impossible rather than the keystroke tedious. Externally that is a database carrying the
  `comment on database` marker `createBranch()` writes; embedded, a `pgdata-<name>` directory. The
  shared database this session is connected to is in neither set. A flag would also have broken a
  shipped instruction — `packages/db/src/errors.ts:326` already hands out
  `x db branch drop <branch>` with nothing on it.

  **`branchSql` went because `create` did.** An external clone now runs through `@ultimat3/db`'s
  `createBranch()` on one `role: 'migrate'` client rather than shelling out to `psql`, and that is
  what makes `ls` work at all: the old path wrote the database and no marker comment, so every
  branch the CLI made was invisible to the only lister the framework has. A second place spelling
  `CREATE DATABASE … TEMPLATE` would be two answers to what a branch is. Branches created by the
  old path carry no marker and are listed and dropped by neither — [Known gaps](wiki/Known-Gaps.md)
  carries the `psql` line that removes one.

  There is deliberately **no `reap` verb**: `reapBranches()` is a `task`, its max age is an app
  decision, and a CLI verb would be a second path to one job.

- **`x db --help` and `x mcp --help` now tell you what does work.** `MissingSubcommandError`'s
  `fix:` was `x <command> --help` — which throws `MissingSubcommandError` again, because the
  subcommand is resolved before the flag loop ever sees `--help`. A fix line that reproduces its own
  failure, forever, on the only two commands that raise it. It now reads `x help <command>`.
  `--help` is unchanged and still works everywhere else: `db` and `mcp` are exactly the commands
  that declare no `defaultSubcommand`, and `parse.test.ts` pins that pair.

- **BREAKING — `x new` writes no migration.** `packages/db/migrations/0000_initial.sql` and its
  `.hash` are gone from the scaffold, and `x db gen` is that directory's single writer (axiom 1). A
  hand-written first migration could not carry a `.snapshot.json` — the artifact only the generator
  produces — which is the whole of the refusal cycle above, and it also let the source and the
  ledger disagree about what "initial" meant. **Consequence, and it is correct behaviour rather
  than a defect:** a scaffold that declares an entity — the default `--example` slice does — is red
  on `x verify`'s `drift` step, *packages/db has a schema but no migration recorded it*, until the
  first generate runs. `--no-example` declares none and stays green: `checkSourceDrift` now reads
  the declared-entity count in that one branch, because zero declared against zero recorded is
  agreement, and the weaker "a `packages/db` directory exists" test it replaced held such an app
  permanently red behind a fix that succeeds and writes nothing (an empty diff produces no `.hash`).
  **Fix:** a new app's first two database commands are `x db gen "initial"` then `x db migrate`;
  `bin/setup` runs both for you, generating only when the directory holds no `.sql`.

- **BREAKING — an MCP tool is named by the export name, verbatim, on every surface. `snake_case`
  tool names are gone, and so is `toToolName`.** One primitive was reachable under one name and
  published under another. The served name has only ever been the export name —
  `packages/mcp/src/from-action.ts:82` is the one name `tools/call` accepts and the one
  `defineAppMcp`'s `scopes:` map is keyed on, and `@ultimat3/ai`'s LLM tool list agrees
  (`packages/ai/src/tools.ts:72`) — while three *publishers* spelled the same tool
  `publish_post`. So an agent handed `openapi.json` read `"mcpTool": "publish_post"`, called
  `tools/call { name: "publish_post" }`, and got ToolNotFound: the catalog it was given was the
  wrong one. The served side was right, so the publishers moved.

  | Was | Now |
  |---|---|
  | `publishPost.tool().name` → `'publish_post'` | `'publishPost'` |
  | `liveFeed.tool().name` → `'live_feed'` | `'liveFeed'` |
  | `openapi.json` → `"x-ultimate": { "mcpTool": "publish_post" }` | `"mcpTool": "publishPost"` |
  | `publishPost.describe().mcp.tool` → `'publish_post'`, and with it `x actions describe <name> --json`, the `actions.describe` MCP dev tool and the `/_x` **Routes** panel | `'publishPost'` |
  | `import { toToolName } from '@ultimat3/action'` / `'@ultimat3/query'` | removed from both — there is no derivation left to call |

  **What an app author changes.** Nothing that *worked* moves: a `tools/call`, a `scopes:` entry
  and a `visibleTo` list were already spelled verbatim, and a snake_case `scopes:` entry was
  already `X_MCP_SCOPE_UNKNOWN` at boot. What moves is everything read off the published contract
  — run `x manifest` to regenerate `openapi.json`, and re-point any agent prompt, saved tool
  allowlist, generated client or test that took its tool name from `x-ultimate.mcpTool`,
  `describe().mcp.tool` or `.tool().name`. **15 committed names change** in the two tracked apps
  alone — of 17 published `x-ultimate.mcpTool` values, `examples/dummy` moves 9 of 10 and
  `dummy/social-media-clone` 6 of 7; a single-word export (`summarize`, `health`) was already its
  own snake_case form and does not move. An app that fed `.tool()` descriptors
  into its own MCP host — public API, and the one case where the name was live on a wire — renames
  those tools for real. `x.manifest.json` is unaffected: its `mcp` fact is
  `{ expose, description }` and never carried a tool name (`packages/manifest/src/schema.ts:85`).
  Issue #120.

- **BREAKING — with no `SMTP_URL` and no `RESEND_API_KEY`, `selectMailDriver` refuses instead of
  falling back to memory.** `development` and `test` are unchanged; `staging` and `production` now
  install a driver that rejects every send with `X_MAIL_CREDENTIAL_MISSING`. An app that sends no
  mail still deploys — the refusal is on the send, not at boot. **Also**: the SMTP transport's
  `Message-ID`, and therefore `SendResult.id`, is content-derived and stable across attempts of one
  send where it was previously random per attempt.

- **BREAKING — a fleet slot whose lease has lapsed can no longer be renewed by its own holder.**
  `SQL_LEASE_RENEW` fences on `expires_at > now()` as well as `holder`, matching the memory store. A
  run whose slot lapsed is cancelled with `X_JOB_SLOT_LOST` rather than continuing uncapped past
  `job.concurrency` — which is what the documented contract already said, and what `x dev` already
  did.

- **The shared cache tier's key layout changed.** An entity index (`<ns>:e:{entity}`) is now its own
  key rather than sharing the collection tag's bucket. Upgrading costs a colder shared tier once,
  which the default build-id namespace already pays per deploy; a `buildId: null` deployment is
  covered because a collection bust also reads the old bucket during the rollover. One extra `SADD`
  per write.


- **BREAKING — `@ultimat3/query` no longer ships a read-cache seam of its own.** Removed:
  `setReadCache`, `getReadCache`, `invalidateQueryTags`, `MemoryReadCache`,
  `DEFAULT_READ_CACHE_MAX_BYTES`, and the types `ReadCache` and `ReadCacheEntry`.
  `DEFAULT_READ_CACHE_TTL_MS` stays. **A Redis deployment's read path changes in both directions**:
  it was the Redis tier *alone*, so every cached read was a network round trip and this process's
  own LRU was never consulted for one; it is now read-down/promote-up across
  `request-memo → lru → redis`, a warm key answered locally and promoted with its *remaining* lease,
  and concurrent misses of one key share a single load. The cost is one extra local `get` on a
  genuine miss and a copy of each entry in the local LRU. **Fix:** an app that installed its own
  read cache calls `registerTier(myTier)` from `@ultimat3/cache`, which was already the only way to
  add a backend for every other cached surface; `invalidateQueryTags(tags)` becomes
  `invalidateTags(tags)`, which is now literally the same call. A process that registers no tier
  reads **uncached** rather than filling a store no fan-out can see. A cached query is cold once on
  deploy.

- **BREAKING — `@ultimat3/auth` no longer exports `requireRole` / `requireScope`.** They decided a
  403 outside `@ultimat3/policy`, with **zero callers** in the framework or either tracked app —
  and they were *documented*, which is what makes deletion right rather than wrong.
  `packages/policy/README.md` named them "one honest exception", and the same paragraph admitted the
  cost: a route gated that way reports `policy: null` in `x routes`, in `framework.manifest.json`
  and in `openapi.json`, and `x policy list` reports its permission unenforced. A sanctioned second
  door nobody walked through. `requireActor`/`currentActor` stay — those assert *authentication*,
  which is what this package produces. **Fix:** declare the rule as a `Policy` — `can('admin:access')`
  — which every introspection surface can read.

- **BREAKING — `@ultimat3/db` no longer exports `readOnly()`, `assertReadOnly()`,
  `inspectStatement()`, `MutationVerdict`, `ReadOnlyOptions` or `readonlyViolation()`, and
  `X_READONLY_VIOLATION` is retired.** The framework shipped three "is this SQL a write?" lexers;
  admin's folded into mcp's last release, and this was the last one standing — zero callers, and the
  only one on a public API. It was also the weakest: a keyword list matched with `\b…\b` judges
  statement keywords and nothing else, so `select pg_sleep(60)`, `select pg_read_file('/etc/passwd')`
  and any writing function call all read as reads. What remains is what the server enforces or a
  real scanner decides: a `NOLOGIN` SELECT-only role, `BEGIN READ ONLY` with a statement timeout,
  and `@ultimat3/mcp`'s `assertReadOnlyQuery`. **Fix:**
  `readOnly(db()).query(f)` → `readOnlyQuery(text, { role: await ensureReadOnlyRole() })`, which
  reports which defences engaged.

- **BREAKING — `@ultimat3/seo` no longer ships a performance-budget surface, and
  `X_SEO_BUDGET_EXCEEDED` is retired.** `checkBudgets`, `assertBudgets`, `parseBytes`,
  `DEFAULT_BUDGET`, `BUDGET_UNITS`, the four `Budget*` types, `budgetExceeded()`, `RouteBudget` and
  `RouteRecord.budget` are gone; nothing but their own test ever called them. seo is **tier 1** and
  cannot see a build's bytes, so it was never the package that could answer — the gate that runs is
  `@ultimat3/cli`'s, raising `@ultimat3/render`'s `X_BUDGET_EXCEEDED`. Two codes for one fault, and
  the one nothing threw was the one an agent got a fix line from — a fix naming a report no step
  produces. `parseBytes` also reported a malformed size string *as a budget violation*, so the code
  already meant two things. The name is never reused; its row moves under **Reserved codes** so an
  old log line still resolves. A deprecation note would have been worse: a deprecated code still
  answers `x errors explain` with a fix for a check that does not exist.

- **BREAKING — `@ultimat3/seo` no longer exports `renderLd`.** `renderMeta` already emits `meta.ld`
  as one `<script type="application/ld+json">` **per node**; `renderLd` collapsed the same nodes
  into **one** script with a `@graph` — a second serialisation of one input, exported and callerless,
  and an app calling both emitted its graph twice. It could not satisfy `@ultimat3/render`'s
  `LdRenderer` slot either, so the comment claiming it filled that seam was false before this
  release. `ld.*` and `meta.ld` are unchanged and are the one way to declare JSON-LD.

- **BREAKING — `@ultimat3/time` and `@ultimat3/i18n` no longer export `attachTimeZone`,
  `timeZoneOf`, `attachLocale` or `localeOf`, and `@ultimat3/http` no longer exports
  `negotiateLocale`, `isValidTimeZone` or `resolveTimeZone`.** All seven had zero callers. Write the
  zone with `createContext({ tz })` or `withChildContext({ tz })` and read it with
  `currentTimeZone()`; take the other three from the packages that own them. Note the stricter zone
  rule that comes with it: `CET`, `EST5EDT`, `+01:00` and `''` are refused, and a resolved zone comes
  back canonically spelled, so one zone is one formatter-cache key. `HttpConfig.locale` and
  `HttpConfig.tz` now hold header and cookie **names** only — the supported set and fallback locale
  are `defineCatalogs({ locales, default })`, the fallback zone is `configureTime({ defaultZone })`.
  `TimeZoneSources` gains `cookie` and the default order is `user, cookie, query, header` — explicit
  before inferred, the rule i18n's locale order already stated.


- **BREAKING — `@ultimat3/seo` no longer exports `renderHeadTags`.** It serialised `renderMeta()`'s
  tags to HTML, escaped `</` and nothing else, and **had no caller anywhere** — while
  `@ultimat3/render`'s `renderHead`, the path every `x dev` and every build takes, escaped nothing
  at all. Two serializers, the unused one weaker, and the used one vulnerable. It also broke its own
  package's stated rule (*"all escaping lives in `xml.ts`; never hand-roll an escape in another
  module"*), and it could not simply borrow render's escapers: `seo` is tier 1 and `render` is tier
  4, and the two doctrines are opposites — `xml.ts` escapes **into** entities, which is right for
  XML and attributes and exactly wrong inside a raw-text element. An app that called it should
  render through `renderHead(headFromMeta(meta, seoRenderers()))`. `renderMeta`, `HeadTag` and every
  other `meta.ts` export are unchanged.

- **BREAKING — a derived `BudgetLedger` now bills its parent.** No signature changed, so nothing
  fails to compile, but a call that previously slipped past a `request` ceiling can now throw
  `X_AI_BUDGET_EXCEEDED`, and `gateway.spent()` returns a larger — correct — number. Listed as
  breaking because it is observable to an app already at its ceiling, even though it makes the
  documented contract (*"derive can only tighten"*) true for the first time.

- **BREAKING — `idempotencyKeyFor` takes the actor as a required third argument, and records
  written before this release are unreachable after it.** Required and positional for the reason
  `cacheKeyFor`'s `authority` is: an optional one is one a call site can forget, and the forgotten
  one is the cross-actor replay above. The stored key's **shape** changed with it, so on the shared
  Postgres store a retry that crosses the deploy boundary finds no record and **re-runs the
  handler**, inside the 24h idempotency window. The memory store dies with its process and is
  unaffected. `truncate x_idempotency` after deploying makes that state honest rather than
  half-reachable.

- **BREAKING — `Idempotency-Key` is enforced at 255 characters.** The OpenAPI operation had
  published `maxLength: 255` all along and nothing checked it, so a client sending longer keys
  worked by accident and now gets a 400. A contract that disagrees with the runtime is worse than
  no contract.

- **BREAKING — `@ultimat3/action`'s `fingerprint` is SHA-256/16.** Action idempotency is unaffected
  in practice (the key changed too, so no pre-deploy record is looked up), but `job-handle.ts`'s
  dedupe key `action:<name>:<fingerprint>` changed: a job enqueued before the deploy and re-enqueued
  after it will not dedupe against the earlier row.

- **BREAKING — `markReady()` throws `X_LIFECYCLE_DRAINED` on a drained lifecycle.** It used to
  decline silently. Any process that drains and then starts a role now fails loudly at the mistake
  instead of binding a socket that answers 503 forever. A test that drains and starts another
  server needs `resetLifecycle()` between the two — which is what three test files were already
  doing by hand.

- **BREAKING — a drain is bounded by default: 25s, and a hook that outruns it is ABANDONED.**
  `configureLifecycle({ deadlineMs })` had existed since 1.0.0 and `drainDeadlineMs()` answered
  `undefined` until something declared one — so a role that declared none drained *unbounded*, and
  the two roles that most need a bound declare none: `jobs` and `realtime` set no budget anywhere.
  A worker pod holding a long job past `terminationGracePeriodSeconds` is `SIGKILL`ed by the
  kubelet mid-statement, which is the failure the deadline exists to prevent and the one it was
  not preventing. `drainDeadlineMs()` now returns a `number` always, and `remainingBudget()` is a
  `number` rather than `number | undefined`.

  Read `X_SHUTDOWN_TIMEOUT` literally: the hook is **abandoned, not stopped**. It is still running
  when the process exits, so whatever it had in flight may be half-done — the framework cannot
  cancel app code it did not write. Both `fix:` lines now name the pair that has to move together:
  `configureLifecycle({ deadlineMs: 600_000 })` **and** a `terminationGracePeriodSeconds` at least
  as large, because raising one without the other just relocates the kill.

  An app whose drain legitimately takes longer than 25s must now say so. That is the point: a
  budget nobody declared was previously read as "no limit", and a limit nobody can see is not a
  limit anyone tuned.

- **BREAKING — `cacheKeyFor(name, input, tags, authority)` takes a fourth, required, positional
  argument.** Optional would have defeated it: an optional authority is one a call site can forget,
  and the forgotten one is the cross-tenant read above. `readAuthority(actor, scope)` is the only
  thing that produces the value. A direct caller — the export is public — passes
  `readAuthority(ctx.actor, 'actor')` to keep 1.2.0 behaviour for a per-caller read, and must
  choose deliberately before writing `'global'`.

- **BREAKING — the query fingerprint is SHA-256/16 hex; cursors minted before this are rejected
  once.** It was FNV-1a/32 — 4×10⁹ values, brute-forceable offline in seconds — and a fingerprint
  here is a **sharing key over client-chosen input**, not a checksum: it decides which read-cache
  entry two callers are served from and which scope a cursor is bound to. The canonical form is
  unchanged, so only the hash moved. A cursor issued by 1.2.0 fails its scope check as
  `X_CURSOR_INVALID`, whose `fix:` is already "request the first page again", and a warm read
  cache is cold exactly once. Same primitive and width `@ultimat3/realtime`'s `stableDigest` and
  `@ultimat3/entity`'s `planScope` chose.

- **BREAKING — `semantic.remember` rejects a TTL the tiers would have rejected.** It computed
  `ttlMs` itself and handed it on, so a non-finite or negative lease reached the tier as a value
  no other write path can produce. It now goes through `assertTtl` like every other write, with
  `jitterFraction: 0` — jitter is a herd defence for expiry, and a semantic lease is not a herd.

- **BREAKING — `OutboxRelay.stop()` returns `Promise<void>`.** It was `void`: it cleared the timer
  and returned *underneath* the pass in flight, so a test or a role shutdown that awaited it
  resumed while a publish and its `markPublished` were still running — a torn write against a
  closing pool. It now retains the tick chain and joins it, the way `worker.stop()` waits out its
  rounds and `scheduler.stop()` its dispatch. Callers ignoring the return value keep compiling and
  keep the old race; `x dev`'s role teardown awaits it.

- **BREAKING — `TierFailure.tier` is `TierLabel`, not `TierName`.** `TierLabel = TierName |
  'query-read'`, because `@ultimat3/query`'s read tier degrades through the same `bestEffort`
  wrapper and had nowhere to report as. The union is closed by hand rather than widened to
  `string`: a label is a value operators read in `/_x`, and an open one is a typo nobody catches.
  A `switch` over `TierFailure.tier` needs a `'query-read'` arm.

- **BREAKING — `hello` carries no cursors: `HelloFrame.resume` and `FRAME_LIMITS.resume` are
  deleted.** The field was filled by every client on open and read by nobody — the node replied
  `resume: []` and decided resume per subscription from the `subscribe` frame — so every reconnect
  shipped each cursor twice, up to `CURSOR_ID_LIMIT` (512) ids per subscription, during the exact
  restart storm `thundering-herd.ts` exists to bound.

  | Was | Now |
  |---|---|
  | `{ type: 'hello', v, buildId, sessionId, actorId, resume: [...cursors] }` | `{ type: 'hello', v, buildId, sessionId, actorId }` — drop the key; a cursor rides its own `subscribe` frame, which is where resume was always decided |
  | `FRAME_LIMITS.resume` (256) | gone. `FRAME_LIMITS` still carries `cursorIds`, `patches`, `rows`, `members`, `inputDepth` and `inputNodes` |

  Wiring the field would have been the wrong half of the choice: a cursor's `qid` is
  `qidOf(name, input)`, a digest, so a node reading a resume list cannot resolve the query name,
  cannot run `definition.authorize` and cannot build the entry the retained window hangs off — it
  could only ever restate, unauthorized, what `subscribe` decides with the input in hand. Two places
  deciding one thing is what axiom 1 refuses.

  **`PROTOCOL_VERSION` was deliberately not bumped**, and that is the same rule `snapshot.entity`
  followed: `decode` builds a whitelist, so a new node drops an old client's `resume` and an old
  node reads a new client's omission as the empty list it always received. Both skews are readable,
  and bumping would refuse every in-flight client on a rolling deploy to buy nothing — the version
  guards incompatibility, not novelty. Removing a field something *does* read is the opposite case
  and bumps.

- **BREAKING — three more `@ultimat3/realtime` surfaces moved, each because the old behaviour was
  unsound.** All three are described above under *Fixed*; this is what a caller has to change.

  | Was | Now |
  |---|---|
  | `qidOf(name, input)` = `<name>:<fnv1a 32-bit>` | `<name>:<first 16 hex of SHA-256>`. A `qid` is a **sharing** key — a hit hands back the existing entry and the seated window, carrying the first subscriber's input and rows — and input is client-chosen, so 32 bits is a collision found offline in seconds and one client served out of another's window. A rolling deploy across the change costs one bounded snapshot per subscription: a cursor minted under the old format names a ring entry the new node never held, so the resume falls back rather than silently mismatching. `fnv1a` is unchanged and still the cursor's result-set digest, where a collision costs a missed re-sort |
  | `queue.drain(send)` marked each mutation `acked` when `send` resolved, and `DrainReport.remaining` counted `pending` + `inflight` | a drained mutation stays `inflight` until the server settles it with `ack`/`fail` or `requeueInflight()` returns it. `remaining` is now what is still **sendable**, so a UI rendering "unsynced" should read `pending()`, which is unchanged and still counts both. Read `status === 'acked'` after a drain and you will now read `'inflight'` |
  | `SyncNode` had one teardown, `stop()` | `SyncNode` also declares `stopAccepting()`, called by the SIGTERM `accept` phase. Additive for a `createSyncNode` caller; a **breaking** change for anything implementing the `SyncNode` interface structurally. `SyncNode.websocket` also no longer carries `publishToSelf`: this node never publishes to a Bun native topic, and a flag configuring a mechanism nothing uses reads as a live one |

  `SyncSocket.subscribeTopic`/`unsubscribeTopic` no longer call Bun's `ws.subscribe`/`ws.unsubscribe`
  either. Every channel message is one filtered `send` per socket through `SocketRegistry.deliver`,
  because a native publish cannot be refused per socket, cannot report the frame it dropped and
  cannot mark a subscriber desynced. `WsLike.subscribe`/`unsubscribe` stay **declared and unused** —
  the interface is structural and a tracked app implements it, so deleting the members is a separate
  breaking edit to every implementer.

- **BREAKING — what a value becomes when it leaves the process.** Four projection changes from the
  same slice, all of them a contract that was wrong rather than a preference that changed.

  | Was | Now |
  |---|---|
  | `t.nullable(x)` emitted `{ …converted, nullable: true }` | `{ anyOf: [<converted>, { type: 'null' }], …annotations }`. `nullable` is an OpenAPI 3.0 keyword no later draft defines, so every validating consumer rejected `null`. OpenAPI 3.1 accepts the new shape unchanged; a hand-written consumer reading `schema.nullable` reads `schema.anyOf` instead |
  | `.default(value)` accepted any value | a default `structuredClone` refuses — a function, a class instance, a `Proxy` — now throws `X_SCHEMA_DEFAULT_UNSHAREABLE` at the **first import of the file that declares it**. Pass a plain value, or a factory the handler calls |
  | `query({ input })` accepted any schema | an input that cannot survive a query string is refused at `query()` with `X_QUERY_INPUT_UNENCODABLE`, in the declaring file. A read is `GET /_x/query/<name>`, so its input is characters: flatten the nested object, or make it an `action` |
  | a `money()` property was two physical columns | three: `<p>_minor`, `<p>_currency` and the new `<p>_scale` (`integer`, nullable, `CHECK` 0–15). **Every existing app needs a migration** — without the column, every read of that table names a column it does not have: `alter table "<t>" add column "<p>_scale" integer check (<p>_scale is null or (<p>_scale >= 0 and <p>_scale <= 15));`, which is byte-for-byte what `generateMigration`'s `columnClause` emits. `NULL` is the right value for every existing row: it means "the currency's own minor unit", which is what those rows always meant, where `0` would mean whole units. `examples/dummy/packages/db/migrations/0002_money_scale.sql` is the worked example, hand-written because `x db gen` answers `X_MIGRATION_SNAPSHOT_MISSING` in an app whose `0001` records no snapshot |

- **BREAKING — `EPOCH` is removed from `@ultimat3/time`; call `epoch()`.** It was one shared mutable
  `Date` exported from a tier-1 package, so any consumer calling `EPOCH.setUTCFullYear(...)`
  corrupted it for every other consumer in the process, permanently and silently. A `Date` cannot be
  frozen — `Object.freeze` does not close `setTime`, verified — so the constant could not be fixed in
  place, and keeping both spellings is the second path axiom 1 forbids. Zero in-repo callers.

  ```ts
  import { EPOCH } from '@ultimat3/time';   // before
  import { epoch } from '@ultimat3/time';   // after — call it: epoch()
  ```

  `instant()` also returned the caller's own object and now does not. `describeCron` is the other
  behaviour change worth stating: it ignored the seconds field entirely, so it now **refuses** a
  6-field expression with `X_CRON_NOT_DESCRIBABLE` where it used to return a wrong sentence. No
  tracked app or package declares a 6-field cron today.

- **BREAKING — `job()` and `backfill()` require a `tenant`.** The guard behind it is above under *Fixed*:
  installing the ambient context fails closed, so the field cannot be optional.

  ```ts
  export const notifySubscribers = job({
    input: t.object({ postId: t.uuid, orgId: t.uuid }),
    idempotencyKey: ({ postId }) => `notify:${postId}`,
    // The one new line: the org this body runs under, derived from the payload the author
    // already had to pass. `tenant: 'none'` is the other legal answer — see below.
    tenant: ({ orgId }) => orgId,
    retry: { attempts: 5, backoff: 'exponential' },
    async run({ input, ctx }) {
      await ctx.posts.byId(input.postId);
    },
  });
  ```

  `tenant: 'none'` means the opposite thing on each side of the factory, and both meanings are in
  the `fix:` line and the wiki row. On a `job()` it declares the body touches no tenant-scoped
  table, because every scoped read then fails closed with `X_TENANCY_ACTOR_ORG_REQUIRED`. On a
  `backfill()` — which forwards `tenant` to `job()` verbatim — it is how a sweep declares it spans
  every tenant, and `backfillPass` opens the bounded `crossTenant` scope for it, never the author:
  minted on the pass's own actor, only for a `'none'` sweep, only on an explicit enqueue. An app
  author holding a lazy `ReadBuilder` cannot wrap an iteration that has not started, which is why
  the capability lives there. A definition with no `tenant` is `X_JOB_TENANT_REQUIRED` at
  declaration.

  In the same slice, and breaking on the read primitive: `sourceFor(target, input, { ctx, enforce:
  false })` — a bare boolean policy bypass, exported and reachable from app code — is now
  `sourceFor(target, input, { ctx, unenforced: 'explain returns no rows' })`. The reason is required, a blank one is refused before the source is
  built, and one `query.policy.unenforced` audit line is written at `debug`. It could not be made
  internal as the audit suggested: the CLI's own query template emits it into every scaffolded test.

- **BREAKING — one `resolveEnvironment`, and it is `@ultimat3/core`'s.** The name existed in
  `@ultimat3/core` and `@ultimat3/seo` with different parameters and different return unions — an
  axiom-1 violation the 1.1.0 notes named and deferred, because unifying two shipped public APIs is
  a major. This is the major. `@ultimat3/seo` now exports neither `resolveEnvironment` nor the type
  `SeoEnvironment`; `ULTIMATE_ENV` has exactly one reader, and the seo package owns only what an
  unreadable environment means for a crawler.

  | Was | Now |
  |---|---|
  | `import { resolveEnvironment } from '@ultimat3/seo'` | `import { resolveEnvironment } from '@ultimat3/core'` — an options object, `resolveEnvironment({ env })`, never a positional env record, and it **throws** `X_ENVIRONMENT_INVALID` on a typo'd `ULTIMATE_ENV` instead of failing closed |
  | a caller that must answer rather than fail | `tryResolveEnvironment()`, and supply your own fallback — `tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT` |
  | `import type { SeoEnvironment } from '@ultimat3/seo'` | `import type { Environment } from '@ultimat3/core'` |
  | `buildRobots({ environment: 'preview' })` | `buildRobots({ environment: 'staging' })` |
  | `isIndexable('preview')` | `isIndexable('staging')` |

  `isIndexable()` and `RobotsConfig.environment` take `Environment`, so `'staging'` is accepted and
  `'preview'` is a compile error. **No `robots.txt` body changes**: neither spelling was ever
  indexable, and only the `# environment:` comment line moves.

  `tryResolveEnvironment()` is new in `@ultimat3/core` and exists for one reason worth stating.
  `ULTIMATE_ENV` is **not** in the env schema, so nothing validates it at boot and nothing in a web
  container's boot path resolves the environment unconditionally — a `robots.txt` render is
  routinely its first reader. A typo would otherwise 500 the one response whose body was already
  going to be `Disallow: /`. It resolves identically to `resolveEnvironment()` for every other
  input and returns `undefined` for exactly the one case that throws, so the key still has one
  reader and only the failure policy differs. It names no fallback of its own; the caller does.

- **BREAKING — the NATS wire client is `nats@2.29.3`, behind the transport seam that did not
  move.** `@ultimat3/realtime` hand-rolled the protocol: `nats-protocol.ts`, `nats-commands.ts`,
  `nats-socket.ts` and `nats-connection.ts` — 1,019 LOC of framing, parser, PING/PONG, TLS upgrade,
  inbox muxing and reconnect, with zero integration benefit, plus a 431-line fake nats-server to
  test them. All of it is deleted. The criterion is
  [`docs/idea/18-build-vs-wrap.md`](docs/idea/18-build-vs-wrap.md): own what must join the
  transaction, context and error machinery; wrap a wire protocol with a dominant maintained client,
  because an agent knows that client's semantics from training and can never know a
  reimplementation. `nats` is the first external runtime dependency any `@ultimat3/*` package has
  taken, pinned exact, importable from exactly one file (`nats-lib-client.ts`) — every other file
  is written against the port in `nats-client.ts`.

  What did not change is the point: `Transport`, `NatsTransport`, `NatsTransportOptions` and
  `selectTransport` are the same seam, and `presence.live.test.ts` passes **unmodified** against a
  real nats-server. What did: reconnect and re-subscription are the library's, so the transport
  keeps no subscription bookkeeping at all — our thundering-herd jitter is handed down as its
  `reconnectDelayHandler`, and the JetStream KV layer stays ours because this client's KV
  abstraction expresses neither per-message TTL (`Nats-TTL`) nor a batch `multi_last` direct get.
  The test seam moved up one level, from an injected byte stream to an injected client:

  ```ts
  new NatsTransport({ url, bucket, open: (target) => Promise.resolve(stream) });  // before
  new NatsTransport({ url, bucket, connect: fakeNatsConnect(broker) });           // after
  ```

  Removed exports: `NatsConnection`, `NatsConnectionOptions`, `NatsConnectOptions`,
  `NatsProtocolParser`, `NatsOperation`, `NatsServerInfo`, `NatsStream`, `natsStreamOver`,
  `bunNatsStream`, `FakeNatsServer`, `fakeNatsStream`. Added: `NatsClient`, `NatsConnect`,
  `NatsClientOptions`, `NatsRequestOptions`, `NatsRequestManyOptions`, `openNatsClient`,
  `FakeNatsBroker`, `fakeNatsConnect`. `NatsHeaders`, `NatsMessage`, `NatsMessageHandler`,
  `NatsSubscription`, `NatsTarget` and `parseNatsUrl` keep their names and move to
  `nats-client.ts`.

- **BREAKING — `@ultimat3/cli` exports `checkSourceDrift`, not `checkDrift`.** Two functions named
  `checkDrift` answered two different questions; the name now says which is which. `@ultimat3/db`'s
  `checkDrift()` keeps its name and its meaning — the live database against the ledger, the
  post-migrate verification. `@ultimat3/cli`'s becomes `checkSourceDrift()` — the entity source
  hashed against what `x db gen` recorded, no database, which is what `x verify`'s `drift` step
  needs to run in CI. `recordedHashes`, `schemaHash` and `writeSchemaHash` are unchanged.

  ```ts
  import { checkDrift } from '@ultimat3/cli';        // before
  import { checkSourceDrift } from '@ultimat3/cli';  // after — same signature, same findings
  ```

  Nothing an app writes calls either: both are the CLI's own step implementations. The defect
  behind the rename is below under *Fixed*.

- **BREAKING — `invariants` is a function, and `invariant()` takes a built expression.** `invariants: (c) => [...]` receives the column proxy once, so `invariant(name, expr)` no longer carries a `(c) => Expr` builder of its own. The array form is gone; there is one way to write a rule.

  The defect it fixes: `InvariantColumns` was an index-signature type, so under `noUncheckedIndexedAccess` every `c.title` was `ColumnExpr | undefined` and **every** entity `x new`, `x g entity` and `x g resource` write failed `typecheck` until the author added `!`. Typing the proxy from the declared columns only reaches `c` when the whole `invariants` argument is context-sensitive — a per-element `invariant(name, build)` is a call TypeScript checks before `entity()`'s `C` is fixed. `InvariantColumns<C>` is now a mapped type over `C`, so `c.title` is a `ColumnExpr` and `c.titel` is `TS2551: Property 'titel' does not exist … Did you mean 'title'?`. `unique()` and `satisfies()` take `keyof C & string`, so a typo in a column *list* is caught too.

  Before:

  ```ts
  invariants: [
    invariant('post_title_not_blank', (c) => c.title!.trimmed().minLength(1)),
    invariant('post_price_non_negative', (c) => c.price!.minor.atLeast(0)),
  ],
  ```

  After:

  ```ts
  invariants: (c) => [
    invariant('post_title_not_blank', c.title.trimmed().minLength(1)),
    invariant('post_price_non_negative', c.price.minor.atLeast(0)),
  ],
  ```

  Mechanical migration: move the `[` to after `(c) => `, drop each `(c) =>` inside `invariant()`, drop every `!`. `indexes[].where` is unchanged — it was already a callback, and its `c` is now typed too. Nothing else changes: a rule still runs in the app on every write **and** emits its `CHECK`/`UNIQUE` through `toSql()`, and an untranslatable JS predicate still reports `kind: 'assert'` with `sql: null`. The runtime Proxy stays, so a JS caller still gets `no column "titel"; declared columns are …` at declaration time.

- **BREAKING — the framework's version is a call, not a constant.** `FRAMEWORK_VERSION` is gone; `frameworkVersion()` from `@ultimat3/core` replaces it, and `@ultimat3/mcp`'s `DEFAULT_SERVER_INFO` becomes `defaultServerInfo()` and `@ultimat3/cli`'s `CLI_VERSION` becomes `cliVersion()` for the same reason — a constant holding the result is the module-scope read again, one import away.

  ```ts
  import { FRAMEWORK_VERSION } from '@ultimat3/core';   // before
  import { frameworkVersion } from '@ultimat3/core';    // after — call it: frameworkVersion()
  ```

  The defect it fixes is below under *Fixed*: read at module scope, the version resolved before `main` in every process that imported core, so `x build --target binary` produced an executable that threw at import. Resolution order is manifest → build define → throw, and the throw is unchanged in the case it was written for: a manifest that exists and declares no semver is still a broken publish, still `X_INVARIANT`, define or no define. The value is resolved once and cached, so a call site pays one `existsSync` for the process.

- **`x verify` counts skips apart from passes, and names them.** A step with nothing to check here is recorded green so the run continues, and the summary counted it among the passes — so a repo whose `job` and `eval` suites do not exist printed the same `all 17 steps passed` as a repo where both ran. The line is now `14 of 17 steps passed — 3 skipped: drift, contract-diff, budgets` in this repo — the three correctly inapplicable at a non-app root, and the count every run in this sweep reported — and `14 of 17 steps passed in 11153ms — 3 skipped: e2e, contract-diff, roadmap` in the scaffolded app of [tutorial 2](https://github.com/developerz-ai/ultimate/wiki/Tutorial-02-First-Feature); `all {n} steps passed` survives only when nothing was skipped. `--json` gains `data.skipped`, the list of names beside `data.failed` (`steps[].skipped` is unchanged). Exit codes are untouched: a skipped step is still not a failure — it is now just impossible to mistake one for a passing one.

### Added

- **The currency table is open, and it is opened by a call.**
  `registerCurrency({ code, exponent, name })` declares a currency the shipped ISO-4217 rows do not
  carry — a local currency, a scrip, a loyalty point, a token — once at boot. `CURRENCIES` still
  means the 53 rows this package ships; `currencyCodes()` now answers for *this process*,
  registrations included, which is the one list `X_CURRENCY_UNKNOWN`'s fix line names.

  Not a preference. **Three layers already treated the currency set as open**, independently:
  `@ultimat3/schema`'s `moneySchema`, `@ultimat3/entity`'s `parseCurrency` and the Postgres `CHECK`
  `currencyCheck()` emits, and the **published OpenAPI contract** all accept any `^[A-Z]{3}$`. An app
  could therefore take `GHS` over HTTP, validate it, write it to Postgres and read it back — and only
  `@ultimat3/money`'s arithmetic refused it. The table was never a closed set; it was one package
  disagreeing with the boundary, the storage layer and the contract the framework publishes.
  `CurrencyCode` is `string`, not a union, and the table had **zero consumers outside
  `packages/money/`**, so nothing depended on it being total. Those three restatements are now one
  exported `CURRENCY_CODE_PATTERN` in `packages/schema/src/money-value.ts`, deliberately held to the
  syntax ECMAScript, JSON Schema and POSIX ERE spell identically — a `\d` or a lookahead would make
  the SQL `CHECK` stop meaning what `isCurrencyCode` means.

  A registration is refused, never defaulted: no exponent is guessable, and a silent 2 reads
  `1.23456789 XBT` as `1.23`, shifting every stored `minor` by a power of ten. Two new codes,
  both documented in [`wiki/Error-Codes.md`](wiki/Error-Codes.md) — **`X_CURRENCY_INVALID`** for a
  declaration that cannot become a currency (code shape, an exponent outside `0…15`, an empty name)
  and **`X_CURRENCY_REDEFINED`** for one code declared twice with different meanings, a shipped ISO
  row included. An *identical* second call returns the row in force rather than throwing, so a module
  imported twice is not a process death.

  Additive, not breaking: an app that registers nothing sees the same 53 rows and the same
  behaviour. `x money add-currency` stays **planned**; `wiki/CLI-Reference.md`'s row for it now names
  the shipped call instead of `x manifest --json`.

- **Eight claims the repo made about itself, now enforced.** Each one was true when written and
  checked by nothing, which is the state axiom 3 exists to refuse. All ride existing `verify` steps
  — `VerifyStepName` is a closed union a generated app inherits, and an app cannot run a check only
  this repository can.

  | Code | What it refuses |
  |---|---|
  | `X_PUBLISH_LIST_INCOMPLETE` / `X_PUBLISH_LIST_UNKNOWN` | a release that would skip a publishable workspace, or name one that does not exist |
  | `X_BENCH_CLAIM_STALE` | a realtime capacity figure in `CLAUDE.md` that the committed bench JSON does not carry |
  | `X_WIKI_TABLE_MALFORMED` | a markdown table that will not render as one on the public wiki |
  | `X_FRAME_DOCS_STALE` | a wire frame the protocol sends and `wiki/Realtime.md` never names, or the reverse |
  | `X_CHART_VERSION_STALE` | a Helm chart that has drifted from the lockstep version |
  | `X_IMAGE_LIBC_MISMATCH` | a runtime that cannot load the binary the build stage produced |
  | `X_IMAGE_GUARD_MISSING` | an `ENTRYPOINT` no `RUN` in that same stage ever executes |

  Two of them are shaped by what a *naive* implementation would have done. The table checker splits
  on **unescaped** pipes only: 36 rows across 16 wiki pages carry a correctly-escaped `\|` — mostly
  TypeScript union literals — and a naive split reports every one of them as malformed, which is
  worse than no checker, because the first thing an author does is "fix" the good row. And the image
  rule checks libc **family**, not base-image version: matching Debian *generations* would need a
  hand-kept tag table that fails on a correct Dockerfile the day the base rebases.

  `X_IMAGE_GUARD_MISSING` is deliberately not "the file contains a guard" — the Dockerfile that
  shipped the dead image **had** one, in the wrong stage, which is how it survived review. The rule
  is that the final stage's `ENTRYPOINT` must be executed by a `RUN` in that same stage: the guard
  runs on what ships. Both image rules were verified by running them against the Dockerfile as
  committed, where they reproduce both defects at the right lines.

- **The status table is closed, and the gate now enforces that it is.** A framework code with no
  row in `error-map.ts` falls to 500 and pages the on-call; ten such codes had accumulated, and
  nothing would have caught the eleventh. The `errors` step gained a fourth host rule:
  `X_ERROR_STATUS_MISSING` for an in-scope code with neither a row nor a pin,
  `X_ERROR_STATUS_BACKLOG_STALE` for a pin that has since been resolved or names a code nobody
  declares, and `X_ERROR_STATUS_UNKNOWN_CODE` for a row mapping a code that does not exist — a
  mistyped row reads as enforced and maps nothing, which is the most expensive edit that file
  accepts. It reads the exported `ERROR_STATUS` object rather than parsing the source, so
  `Object.hasOwn` can tell "no row" from "row = 500", which `statusFor` structurally cannot.

  **A ratchet, not a wall.** The obvious rule — every code owned by a tier ≤ 4 package needs a row —
  flags **237 of 394 codes**, including `X_MIGRATION_DESTRUCTIVE` and `X_CRON_INVALID`: a step an
  agent disables in its first week. Whether a code can reach a request is **not derivable**:
  `X_MIGRATION_DESTRUCTIVE` and `X_TENANCY_CROSS_DENIED` are the same tier and the same shape, and
  blanket `index.ts` re-exports collapse import reachability to "the whole package" at every
  boundary. So the 226 undecided codes are pinned in `scripts/error-map-backlog.ts`, grouped by
  owner with a reason per group, and the list may only shrink — the same `expectedRed` idiom the
  tracked-app gate already uses. A pin says "nobody has decided yet", never "this can never reach a
  request", and the promise the gate keeps is that the undecided set never grows.

  It is a rule on the existing `errors` step rather than an eighteenth step, because `VerifyStepName`
  is a closed union a generated app inherits, and an app cannot run a check that only this
  repository can. It caught two codes on its first run against live work.

- **`channel_frames_dropped_total` — the only trace a lost channel message leaves.** Tier 1 is **at
  most once** and always was: a topic has no cursor, no `desynced` mark and no re-snapshot, so a
  frame `SyncSocket.send` refuses under backpressure is gone. `SocketRegistry.deliver` and the
  channel hub above it both discarded the `false` that said so, which made the loss invisible.
  Three readers of one event now: the counter (a data-loss series, not a saturation one — alert on
  any non-zero rate), the log line `channel.frames_dropped` at `warn` carrying
  `{ topic, dropped, total }`, and `SocketRegistry.droppedChannelFrames` for a test or a bench that
  cannot scrape. **No attributes on the series**: a topic is client-chosen — `topic()` admits any
  `[A-Za-z0-9_-]+` segment — so a per-topic label is unbounded series one socket can mint, and the
  topic goes in the log line where cardinality is somebody else's index. Node-wide and cumulative,
  because a socket past `maxDroppedFrames` is closed and removed and a per-socket count leaves
  exactly when loss is worst; distinct from `SyncSocket.droppedFrames`, which counts every frame
  kind one connection lost and dies with it. Declared in `packages/realtime/src/socket.ts` rather
  than core's `runtime-metrics.ts`: that file is the series every Ultimate process emits and the
  chart scales on, and this one exists only where channels do. Repair is not shipped and would need
  a per-topic sequence on the wire — a channel's `lsn` is the publishing hub's own per-node counter,
  so a client cannot tell a gap from a message that arrived via another node. **Anything that must
  arrive belongs on a live query.**

- **The client beats, because only the client can end a half-open socket.** A dead TCP connection
  that fires no `close` is invisible to a browser, and the client had no heartbeat at all — so a
  subscribed client was swept out of every presence room within one 30s TTL while still reporting
  itself online. `new LiveClient({ …, heartbeatMs })` defaults to `DEFAULT_HEARTBEAT_MS` (15s) and
  `0` disables the pass; **it is on by default**, so a fake socket in a test now sees the beat.

  | Property | Behaviour |
  |---|---|
  | One beat | a `hello` — byte-identical to the opening frame, since it has no resume list to leave out — plus one subscribe frame per topic held |
  | Why the topics | on the node, repeating the subscribe frame **is** the presence heartbeat; presence has no frame of its own in either direction |
  | Silence | nothing received for **two** intervals ⇒ close `4000` (private-use, so it is distinguishable in a log) and arm the reconnect. Judged from the last frame of any kind, since the point is that bytes still cross |
  | Not a deploy check | `socket.skewed` compares the build id recorded at the upgrade against the node's, both fixed for the socket's life, so every `hello` on one socket answers the same forever. `update-available` reaches a client on the socket it opens against the **new** node |
  | Not an interval | one armed tick that re-arms itself, on the same injected `Scheduler` the reconnect uses — a client is either beating on a live socket or backing off toward a new one, never both |

  The 15s is **restated** from `realtime.heartbeatMs`, not read: that is server config and this is
  browser code. `realtime.heartbeatMs` is read by nothing today — see *Known gaps*.

- **`createSyncNode({ maxBufferedBytes, maxDroppedFrames })`.** Both existed on `SyncSocket` and the
  node constructs every socket it holds, so unforwarded they were reachable only by abandoning
  `createSyncNode` — a ceiling on the one loss nothing replays, with no way to move it. Forwarded
  the way `maxFramesPerSecond`/`frameBurst` already are, so an unset option keeps `SyncSocket`'s own
  default rather than overwriting it with `undefined`. In the same pass, a `SubscriptionLimitError`
  names its knob at every throw site (`maxTopicsPerSocket`, `maxTopicsPerNode`, `maxEntries`,
  `maxPerSocket`, `maxPerTenant`): the default was `maxPerSocket`/`maxPerTenant`, which are
  `LiveQueryRegistry`'s, so the channel hub's per-socket **topic** cap told an operator to move a
  number in a different constructor that would not have helped — a fix line naming the wrong setting
  is worse than none, because it is an instruction that runs and changes nothing.

- **A delivery benchmark, because the one we had measured reachability.** The 50,000-client figure
  was published as "time-to-consistent" and never measured consistency: the harness recorded
  `lastSeenSeq` and read it nowhere, so a patch the node dropped was invisible to it by
  construction. It times each client's **first** channel patch after the kill — reconnect *and*
  resubscribe *and* one delivery. **The timings are unchanged and still stand**; only the name was
  wrong, and every doc that quoted it now says reachability.

  `scripts/bench/restart-bench-seq.ts` is the second number: every client counts holes in a probe
  sequence, per connection. 10,000 clients, a probe every 200ms, all 10,000 reconnected —
  **1,666,882 patches received, 0 lost**, no gap, no duplicate, no rewind on any client
  (`scripts/bench/results/10k-restart-seq.json`, `As of 2026-08`). `BenchReport` gains `seq` and
  `probeIntervalMs`; a result file written before this has no `seq` key at all, because that run did
  not measure it. Two limits stated in the report's own notes: the zero is a **lower bound** — a
  hole is only visible between two messages one connection received, so a patch lost before a
  connection's first or after its last is uncounted — and it is **not evidence about 50,000**. That
  run predates the counter and carries no delivery number.

- **`queryClient` — the map-wide typed read client, the mirror of `rpc`.** `@ultimat3/query` shipped
  `.client({ baseUrl })`, which needs the query object — so the one surface that most needs a typed
  read could not have one: a `site/` route importing a feature's `live.ts` to reach it is
  `X_BOUNDARY_VIOLATION`, and the reference app had all seven of its read call sites taken off the
  **action** client instead, where none of those names exist. `queryClient<Api['queries']>({ baseUrl })`
  binds every registered read off the `Api` **type** alone, exactly as `rpc<Api['actions']>` binds
  every write. Both spellings proxy to `queryClientMethodFor`, so a read has one URL however it is
  addressed.

  ```ts
  // apps/web/shared/client.ts — two registries, two clients, one origin
  export const client = rpc<Api['actions']>({ baseUrl });          // writes
  export const queries = queryClient<Api['queries']>({ baseUrl }); // reads
  ```

- **`backfill()` — one pass over a table, declared as a `job`.** `@ultimat3/jobs` gains a factory, not a ninth primitive: a backfill is durable work with an input schema, a retry policy, an idempotency key and a queue, so `backfill({ name, source, batch, handle })` *returns* a `JobHandle` and inherits `.enqueue()`, the worker's cancellation, the dead-letter path, `x jobs show` and its manifest row with no line of its own. Same rule `llm()` follows: a new capability arrives as a factory over an existing primitive.

  ```ts
  export const rewriteSlugs = backfill({
    name: 'rewrite-slugs',
    batch: 1_000,
    source: () => db.posts.where({ published: true }),
    async handle({ rows }) {
      await db.posts.upsertAll(rows.map(slugged), { onConflict: ['id'] });
    },
  });
  ```

  `source` is read through `inBatches()` — one statement per page, keyset, never OFFSET — and every page is handled inside its own `step.run`, named `batch:0`, `batch:1`, … So a run killed mid-pass resumes on the page it stopped at: the completed steps replay from storage without touching the database, and the iteration is opened at the cursor they leave behind. What a step persists is that cursor and a row count, **never the page** — `steps.ts` hands a completed step's output back for the whole run, so checkpointing rows would retain every row already processed until the job ended. The body is handed no `step` for the same reason step names are positional: a name minted inside it would collide with itself on the second batch. `idempotencyKey` is the backfill's name, so re-enqueueing a live pass is the same pass.

  **`handle` is at least once, and that is a requirement on the handler.** It runs *before* its checkpoint lands, so an attempt killed, cancelled or lease-expired between the last row and the step record hands the same page to the next attempt: write through `upsertAll`, `updateWhere` or a statement whose second run changes nothing, never `count + 1` and never an unguarded external side effect. The order is the only one that is safe — a checkpoint written first would report a page as swept that no attempt ever wrote, and a lost page is unrecoverable where a repeated one is a handler's problem to be idempotent about.

  **`x_backfills` records what has already been swept**, the twin of `x_migrations` one level up: name, definition checksum, status, app version, rows processed, last cursor, started/completed. It ships in the same DDL as `x_jobs` and `x_job_steps` and hangs off the queue driver as `driver.backfills`, so a ledger a pass cannot write is a queue it could not have been claimed from — and a driver without one runs backfills with no bookkeeping rather than refusing them, exactly as `introspect` already degrades. Re-enqueueing a **completed** name is a no-op with a report (`{ skipped: true, previousRunId }`) — no statement, no body call, no row. `enqueue({ force: true })` sweeps again and writes a **new** row: reruns are history, never an edit of the row they rerun. A definition whose checksum moved since the completed pass **warns** and still does not run, because this checksum is over function source text, which a bundler can move without a line of behaviour changing — where `@ultimat3/db`'s `auditLedger` throws on the same fact, since SQL text is what it applied.

  The row is a **report**, never a resume source: where a resumed pass restarts is decided by the step checkpoints and by nothing else. A retry adopts its own row (`started_at` is when the pass began, not this attempt) and clears `completed_at`, which `finish` stamps for `failed` as well as for `completed` — every surface projects that column, so a running pass keeping it would render with a completion time in the past. An attempt that failed is recorded as `failed` with its cursor kept, because where a pass stopped is the first thing anyone asks about one.

  **A backfill is throttled, and the default is slow.** `rate` is batches per second and defaults to `DEFAULT_BACKFILL_RATE` (5) — 5,000 rows/sec at the default batch, one statement every 200ms, so the pool spends the rest of each interval serving the requests the app is still taking. There is **no unthrottled mode**: to sweep faster you raise the number, and a rate above what the batches can achieve simply produces no wait. The pause is spent **inside** each batch's `step.run`, which is what stops a resumed attempt from re-paying the throttle of the five hundred batches it is replaying, and it unwinds on the run's cancellation (`X_ABORTED`) rather than sitting in a timer nobody is waiting for. `rate` is not part of the definition checksum, for the reason `batch` is not: pacing is tuning, and changing it does not make a completed sweep a different sweep.

  **Progress is readable from three surfaces, all reading the one ledger.** `x db backfill --list` prints it (`--name`, `--status`, `--limit`, and `--json` carrying the same rows); `x jobs ls` reports the passes **in flight** with rows-so-far and cursor, and `x jobs show <id>` carries the ledger row for that run under `backfill`; `/_x`'s jobs panel carries the whole ledger plus a live count. One projection behind all of them — `inspectBackfills()` in `@ultimat3/jobs` — so the dashboard renders what `--json` prints. `x db backfill` without `--list` is refused with the command that works, because `x db backfill <name>` will one day *run* a pass and a bare invocation that quietly listed would be a silent no-op the day it lands.

- **`appVersion()` in `@ultimat3/core`.** One reader for `APP_VERSION`, defaulting to `dev`. It was spelled inside `@ultimat3/db`'s `runningAppVersion`, which now delegates — `x_migrations.app_version` and `x_backfills.app_version` are two durable columns an operator reads side by side, `@ultimat3/jobs` cannot reach `db` for the answer, and two packages defaulting the key their own way would put two names on one build.

- **The destructive-SQL rail: a migration that destroys data must say so, and `x verify` refuses one that does not.** `x db gen` now writes `-- destructive: true` into any migration whose `up` drops a table, drops a column, truncates or retypes; `x verify`'s `drift` step reads the committed files back and fails an unmarked one with the new `X_MIGRATION_DESTRUCTIVE`. The strong-migrations idea, enforced rather than documented — a drop is allowed, an *undeclared* drop is not.

  ```text
  X_MIGRATION_DESTRUCTIVE: this migration destroys data and does not say so
    cause: packages/db/migrations/0002_drop_legacy.sql drops a column and does not declare it:
           alter table "posts" drop column "legacy"
    fix:   add the line "-- destructive: true" to packages/db/migrations/0002_drop_legacy.sql,
           or regenerate it: x db gen "<name>" --allow-destructive
  ```

  One classifier decides for both halves (`@ultimat3/db`'s new `destructive.ts`, exported as `destructiveStatements()`, `hasDestructiveMarker()`, `isDestructive()` and `DESTRUCTIVE_MARKER`), so the generator cannot write a file that fails its own gate. Four rules: only `up` is judged — reversing a `create table` is a `drop table`, and marking every `down` marks nothing; the kind list is closed at four — `drop constraint`/`default`/`not null` and `drop index` are rebuildable and excluded by name; the decision runs over comment- and literal-blanked text, so `-- drop table users` is prose and `values ('drop table users')` is data; and the marker is a whole line, so a file merely mentioning it has declared nothing.

  `X_MIGRATION_DESTRUCTIVE` is not a second spelling of `X_MIGRATION_IRREVERSIBLE`. Irreversible refuses to *generate* a plan whose `down` cannot restore the rows, with `--allow-destructive` as the override. Destructive refuses to *ship* a plan whose `up` destroys them without saying so — which is why a column retype, reversible in DDL and gated by no flag, is now marked though it is never refused. Mark a migration before it is applied: the marker is SQL the checksum covers, so adding it to an applied file is an edit, and `X_MIGRATION_CONFLICT` correctly says so. Existing migrations are unaffected — the reference app's `0001_init` creates and drops nothing.

  `GeneratedMigration` gains a `destructive: boolean` field. `stripSqlNoise()` moves from `readonly.ts` to its own `sql-noise.ts` — same export, same behaviour, now shared by three guards without putting the error registry in an import cycle.

- **`job_leases_lost_total{queue}` — a counter for jobs the queue took back while they were still running.** Declared beside the other runtime series in `@ultimat3/core` (`leasesLost`, `recordLeaseLost(queue)`) and emitted from one place, the worker's lease heartbeat. Alert on any non-zero rate: it is the one queue failure that at-least-once delivery cannot paper over, and until now it was invisible. See the `Fixed` entry below.
- **Realtime subscription handles are `Disposable` — `using sub = client.useLive(...)` unsubscribes on scope exit.** `LiveHandle` (`useLive`'s return, and `LiveRows` one layer up through the `useLive` hook) and `Unsubscribe` (`client.subscribe(topic, handler)`'s return) now carry `[Symbol.dispose]`, wired to the exact same function `unsubscribe` already was — never a second teardown implementation to drift from it. Purely additive: `unsubscribe()` and the callable topic-unsubscribe function both still work exactly as before, so no call site needs to change. Pinned in `packages/realtime/src/type-pins.ts` so a future refactor that drops the member fails the build rather than a call site months later.
- **`findById` batches itself — one microtask of point lookups is one `where "id" in (…)`.** A page that resolves an author per row sent one `select … where "id" = $1` per row. Inside a request, `postgresRepo()` now collects the lookups issued in the same microtask and sends one statement for all of them:

  ```ts
  // One statement, not one per post. findById's signature and its meaning are unchanged.
  const authors = await Promise.all(posts.map((post) => users.findById(post.authorId, { orgId })));
  ```

  No `dataloader()`, no `batch()`, nothing to opt into: the capability lives inside the method that already exists, which is the only place it can reach code already written. The batch is keyed by context identity — a `WeakMap`, so it dies with the request, the shape `@ultimat3/query`'s request memo has one tier up — and by a scope key covering every input to the statement except the id, so another tenant, another soft-delete visibility, another projection, another entity or another client is a different statement and never joins one. What goes out is the statement each single lookup would have been served by, `in` instead of `=`: the tenant predicate and the `deleted_at is null` clause are inside it, so an id whose row is missing, soft-deleted or another tenant's still reads as `null`. Past 500 ids it becomes several whole statements rather than one Postgres refuses for its bind count, and it declines outright — sending exactly what it always sent — with no request in scope (a job, a script), on a composite primary key, or on a scope it cannot compare. The window is one microtask and closes before the statement is sent, so a sequential `for … of` loop shares nothing through this path — what batches one is the sibling preload below. Proved against a real Postgres in `pg-driver.live.test.ts`: five lookups, one statement, the same five answers.
- **A `for … of` loop over a page is two statements — the sibling-aware preload.** A microtask window cannot see a sequential loop: its `await` closes the window before the next lookup exists. `findMany` now leaves its page's foreign key **values** behind for the request, so the first `findById` for any one of them resolves that key for **every** row of the page in one statement and the rest of the loop is served from memory. On by default; `postgresDriver({ jitPreload: false })` is the one switch that turns it off, where the driver is already constructed — not an `app.config.ts` key, because nothing reads config at the seam that builds a repository and a switch the framework cannot read is a switch that does nothing:

  ```ts
  const page = await posts.findMany({ orgId });
  for (const post of page.rows) {
    // Two statements for the whole loop: the page, then one `select … where "id" in (…)` over
    // every author on it. Every lookup after the first is memory.
    const author = await users.findById(post.authorId, { orgId });
  }
  ```

  Nothing new to write — the relation is the `references()` already declared, and `findById` keeps its signature, so the fix reaches loops that are already written. The scope guard is a security boundary, not a tuning knob: a preloaded row is served only to a lookup with the same scope key the batch above uses (tenant predicate, soft-delete visibility, projection, entity), the same client, and no write to that entity since — anything else reads the statement it always read. The preload statement is that same statement widened to the page's ids, so its tenant predicate and `deleted_at is null` clause are in the SQL Postgres runs; a page's ids can therefore never resolve rows outside the reader's own scope. The index holds values and not rows, keyed by context identity, so it pins nothing and dies with the request; a page of a hundred rows by one author is still one bind; a nullable key that resolved to nothing is not a row to go looking for; past 500 ids it becomes whole statements; and with no request in scope (a job, a script) a page leaves nothing behind at all.
- **`preload(name)` — the join a `for … of` loop would have earned, without writing the loop.** The two paths above catch a lookup pattern already written; `preload()` is the same join, named on the chain instead of triggered by a loop:

  ```ts
  export const db = database({ orgs, posts, members });

  // Two statements: the page, then one `select … where "id" in (…)` over its authors.
  const page = await db.posts.where({ orgId }).preload('author').page();
  page.rows[0].author;        // the member row, or null — always present
  ```

  One vocabulary, `preload('<relation>')` — no `include`, `join` or `with`, and nothing new to declare: the name is the `references()` already written, resolved by `relationNamed()` when `preload()` is called, so an unknown one is `X_PRELOAD_UNKNOWN_RELATION` on the chain and not a page later. A `belongsTo` attaches the row or `null`, a `hasMany` an array — always present, so "no author" and "nobody preloaded the author" never read the same. Several `preload()` calls resolve concurrently, never one after the other, and naming one relation twice is one statement; keys are chunked at `MAX_IDS_PER_STATEMENT` (500) exactly as a coalesced point read already is, so past 500 keys a relation costs several statements rather than one Postgres refuses for its bind count, and a relation with more rows than one page holds costs another keyset page rather than a silent truncation. The page's own tenant predicate carries onto the related read only when the other entity's tenant column has the same name — a value that scopes one entity is a guess on another, and a guess here is a cross-tenant read — so a differently-named tenant column carries nothing, and carrying nothing is not silent: the related read builds its own plan and `assertScoped` refuses it there as `X_TENANCY_UNSCOPED`. The related read is `findMany`, so `deleted_at is null` applies exactly as it does anywhere else. Attached to a copy of each row — `{ ...row }`, because the in-memory driver hands back the row it stores — after `select()`, which is widened internally with the relation's local key so a projection can drop neither the key a preload reads nor the relation it attaches; `plan().select` reports the widened list. `page()`, `all()` and `one()` preload; `count()` and `plan()` do not, since a count reads no rows. A table reaches only the entities its own `database()` call named, through the driver that call was given, so a preload against memory means what a preload against Postgres means — a relation whose other end is outside the set is `X_INVARIANT_VIOLATED` naming the `database({ … })` call that fixes it, and `tableFor(entity, repo)` built by hand reaches no other table. `preload('author')` returns `ReadBuilder<Row & { readonly author: unknown }>` — `unknown`, not a generated type, because the name is a string resolved at runtime and the row on the other side is parsed by its own entity.
- **`insertAll(rows)` and `upsertAll(rows, { onConflict })` — the write loop, as one statement.** Three bullets above make a read loop stop being N statements; a loop of `insert()` calls still was. Both land on `Repo`, on `Table` and on **both** drivers:

  ```ts
  // One `insert into … values (…), (…), (…) returning *`, not three round trips.
  await db.tags.insertAll(names.map((name) => ({ orgId, name })));

  // The like nobody can like twice, without a read to find out first.
  await db.likes.upsertAll(rows, { onConflict: ['orgId', 'postId', 'memberId'], onMatch: 'nothing' });
  ```

  `insertStatement` builds every insert in the framework now, one row or ten thousand, so `insertAll([row])` compiles to the text `insert(row)` always compiled to and there is no second builder for the two to drift apart in. Rows are `Insertable`, parsed by `$parse` exactly as one row is — declared defaults are filled here, not by the caller — and `upsertAll` also stamps `onUpdateNow()` columns through `touch()`, the one place that happens, because an upsert that lands on a stored row *is* an update. The result is the rows the call actually **wrote**: under `onMatch: 'nothing'` a row already stored is skipped and absent, which is what `returning *` says on the server and is therefore how a caller counts what it inserted. A collision overwrites every column in the batch except three closed sets — the conflict target, which is how the stored row was found, the primary key, which is where it lives, and the soft-delete stamp, which is whether the row is there at all; moving either of the first two would move a row nobody asked to move and every foreign key pointing at that id would miss it, and writing the third would bring back a row the app had deleted. A soft-deleted row still occupies its conflict target — the unique index it collides with is not partial — so `excluded."deleted_at"` is the resurrection `update(id, patch)` and `updateWhere` both refuse by carrying `deleted_at is null`, which an `on conflict` clause cannot carry; it is dropped from the set list rather than refused, because `$parse` fills `deletedAt: null` into every row before the plan is built, so that value is the framework's and not the caller's. `insertAll` is untouched: a row that collides with nothing writes the stamp it carries, exactly as `insert` does. Past Postgres's 65535 bind parameters the batch becomes several whole statements rather than one the server refuses, so an all-or-nothing caller wraps the call in `withTransaction`. Four refusals precede the statement, each of them a `42P10`, a cross-tenant write or a silent surprise otherwise: a conflict target no declared unique constraint matches, a target that omits the tenant column under `onMatch: 'update'` (`X_TENANCY_UNSCOPED` — another tenant's row would match and be rewritten, so an updating upsert must be scoped by the constraint itself), a batch that repeats one conflict target under `'update'` (Postgres answers that `ON CONFLICT DO UPDATE command cannot affect row a second time`), and a batch whose rows name different columns under `'update'`, where `excluded.<column>` is that column's default and not "leave it alone". The in-memory driver answers all four the same way and judges the whole batch before storing any of it, so a test that passes against memory still says something about Postgres — including `NULLS DISTINCT`: a null in the conflict target collides with nothing, there and here.
- **`inBatches(size)` — reading a whole table is a terminal on the chain, not a loop around `page()`.** A page is bounded on purpose, so every backfill, export and reindex hand-rolled the cursor loop, and the hand-rolled ones are where an `offset` creeps back in. `ReadBuilder` now ends in one:

  ```ts
  // One statement per batch, one page of rows in memory at a time.
  for await (const batch of db.posts.where({ orgId }).preload('author').inBatches(500)) {
    await search.index(batch);
  }

  // Stopping early keeps the position, so a job resumes where it ran out of time.
  await using batches = db.posts.where({ orgId }).after(checkpoint).inBatches(500);
  for await (const batch of batches) {
    await search.index(batch);
    if (ctx.clock.now() > deadline) break;
  }
  await db.checkpoints.update(id, { cursor: batches.cursor });
  ```

  A batch **is** the page `page()` would have returned at that position — same filters, same tenancy, same soft-delete visibility, same `select()`, same `preload()` — so there is no second read path to learn or to drift, and both drivers inherit it from the one they already share. The handle is the iteration: `break`, `return`, a throw and `await using` all stop the *next* statement (`close()` is the generator's own `return()`, so it is idempotent by construction), a second `for await` continues it rather than re-reading the table from the top, and an empty batch is never yielded. `.cursor` is where the next batch starts and advances before the yield, so a consumer that breaks reads the position it stopped at and `.after(cursor)` resumes it. Three refusals land on the chain instead of one batch later: a size that is not a whole number of rows, a chain that also called `limit()` — one number with two meanings, and honouring it reads a fraction of a batch while dropping it reads the whole table the caller thought they had bounded — and an ordering no cursor can carry, which is the one that matters most: a nullable sort column mints no cursor when the result fits in a single batch, so it would pass every test and fail once the table grew.
- **`countBy(column)` — a `count()` per row is one grouped count.** Recounting a page of posts' likes sent one `select count(*)` per post, and no batch above reaches those: each of them asks a different question. This asks all of them at once, on `Repo`, on the chain and on **both** drivers:

  ```ts
  // Before: one statement per post.
  for (const id of ids) {
    const likeCount = await db.likes.where({ orgId, postId: id }).count();
    await db.posts.update(id, { likeCount });
  }

  // After: one statement for every post in `ids`.
  const counts = await db.likes.where({ orgId }).andWhere('postId', 'in', ids).countBy('postId');
  for (const id of ids) await db.posts.update(id, { likeCount: counts.get(id) ?? 0 });
  ```

  It counts the whole predicate and never the page, exactly as `count()` does: the chain's filters, its tenancy (`X_TENANCY_UNSCOPED` on a tenant-scoped entity with no org predicate) and its `deleted_at is null` visibility are all in the statement, and `limit()`/`after()` bound it no more than they bound a `count()`. **A value nothing matched is absent, never `0`** — that is what `group by` returns, and it is what lets a caller tell "none" from "never asked"; the default is the caller's `?? 0`. **NULL is one group**, keyed `null`, in both drivers: in memory a property the row never carried is `?? null`, so it lands in the group Postgres files its NULL rows under, while `0`, `''` and `false` stay the values they are. Entries come back biggest group first, ties by the value — numbers and bigints numerically, everything else by its text — and `null` last; the order is applied in `count-by.ts` after the rows are in rather than in the statement, because a hash aggregate returns groups in whatever order it built them and a `Map` filled row by row returns insertion order, so an `order by` there would let the two drivers disagree about a result they agree on. Groupable columns are a closed set — `uuid`, `text`, `char`, `boolean`, `integer`, `bigint` — and a `timestamptz`, a `jsonb` or `money` is `X_INVARIANT_VIOLATED` whose `fix` names a column of that entity that *is* groupable: a `Map` compares a non-primitive key by identity, so such a map could only ever answer `undefined`. The number of groups is bounded at `MAX_GROUPS` (1000), and going past it is a **refusal, not a truncation** — the statement asks for one group more than the bound, the trick a page already uses when it reads one row past its limit, and that extra group fires `X_INVARIANT_VIOLATED` spelling `andWhere('<column>', 'in', <values>).countBy('<column>')`, because a map that silently lost its tail reads exactly like a complete one and a caller recounting from it would write the wrong number to every row it missed. One statement: `select "post_id" as group_value, count(*) as group_count from "likes" where … group by "post_id" limit $n`. Both output names are fixed aliases, so they cannot collide with each other whatever the table declares — an entity is free to have a column called `count` — and the grouped value is re-parsed by the column that declared it, since `int8` arrives as a string and would otherwise key the map by text where the in-memory driver keys it by a `bigint`. No new error code, no `groupBy()` builder, nothing to declare: it is a terminal on the chain that already exists. Pinned in both drivers — in memory, and against the recording client.
- **`relationMap()` — the foreign keys an entity already declared, readable at query time.** `ColumnMeta.references` was resolved in exactly one place, `describe.ts`, to spell a DDL constraint; at query time nothing could answer "what is a post's author". `@ultimat3/entity` now derives a named map from the same thunks — `belongsTo` from an entity's own foreign keys, `hasMany` from the inbound ones:

  ```ts
  relationMap().posts;
  // { org:    { kind: 'belongsTo', to: 'orgs',    localKey: 'orgId',    remoteKey: 'id' },
  //   author: { kind: 'belongsTo', to: 'members', localKey: 'authorId', remoteKey: 'id' },
  //   likes:  { kind: 'hasMany',   to: 'likes',   localKey: 'id',       remoteKey: 'postId' } }

  relationsFor('posts');              // one entity's relations
  relationNamed('posts', 'author');   // one relation, or X_PRELOAD_UNKNOWN_RELATION listing the rest
  ```

  No new declaration syntax, and there will not be one: a `hasMany: […]` init key would be a second copy of a fact the foreign key already states, free to drift from the constraint the migration emits. `local*` is always a property of `from` and `remote*` of `to`, so a traversal reads the same in both directions. Names come off the key (`authorId` ⇒ `author`) and, for a `hasMany`, off the entity the rows come from; when two keys want one name **every** member of that group takes its long form (`author`/`authorId`, `postsByAuthor`/`postsByReviewer`), so adding a second foreign key never renames an existing relation by declaration order. Two keys differing only by an `Id` suffix are `X_INVARIANT_VIOLATED` naming both columns, never one relation swallowing the other. A money column declares no relation, since one property is two physical columns.

  The relations reach query time through the registry, not through a list the caller assembles: `RegistryEntry` gains `references()`, the resolved records, and `ColumnDescription.references` is now *rendered* from them, so the `"<table>.<column>"` string a migration reads and the record a traversal reads cannot disagree. It is a method because a `references()` thunk may point at an entity two modules of an import cycle have not finished evaluating. `relationMap()` memoises against a registry generation, so a schema module imported late rebuilds the map instead of being missed by it; `relationsOf(entries)` is the same derivation over a named subset. A name that resolves to nothing is `X_PRELOAD_UNKNOWN_RELATION`, and its `fix` is a `relationNamed()` call on one that does exist with the rest named after it — they are derived, so there is no schema file listing them to go and read; an entity with no foreign key at all gets `x entities list --json`, since the declaration it needs names a target the error cannot know. Additive — nothing consumes the map yet; a preload is what will.
- **`x.verify.json` — the suite floor, so a step that once applied must keep applying.** Counting the skips made a vacuous gate visible; nothing made one fail. Delete a suite and its step goes from passing to skipped, and `x verify` still exits 0. The floor is this repo's committed claim about which steps it already runs — hand-written, read by the gate, written by nothing, because a gate that edits its own floor ratchets both ways:

  ```json
  {
    "steps": [
      "typecheck", "lint", "boundaries", "filesize", "package-shape", "errors",
      "unit", "contract", "live", "job", "e2e", "eval", "manifest", "roadmap"
    ]
  }
  ```

  A step named there that reports nothing to check is recorded **failed and not skipped**, with `X_VERIFY_SUITE_VANISHED` and both edits that resolve it — so it lands in the failure count, in `data.failed`, and in every step table another gate parses. Not a breaking change for an existing app: a repo that commits no floor is not ratcheted and behaves exactly as before. A floor naming a step the gate does not run enforces nothing and is refused by the `manifest` step (`X_CONFIG_INVALID`), because a typo covering no suite is the same false green. This repo's own floor pins 14 of 17; `drift`, `contract-diff` and `budgets` are the honest skips, and they are the three every run of the gate in this sweep reported.
- **`setStatementObserver()` — the seam a statement-level diagnostic installs into.** `@ultimat3/db` emits no span, no counter and no log for a statement, so nothing above it can count one: the dev timeline's `repeatedSql` groups span names and has never seen a repository read, which makes an N+1 invisible by construction. The seam is one process-wide observer, the `setDbClient` shape, with a `StatementEvent` carrying `{ text, values, durationMs, rows, error?, attribution?, expected? }`:

  ```ts
  setStatementObserver({ onStatement: (e) => ledger.count(e.text) });
  setStatementObserver(undefined);   // production, and what every test must leave behind
  ```

  `attribution` — the `{ entity, op }` pair that lets a report read `50× findById on members` instead of 50 copies of one `select` — is produced, `As of 2026-08`: `@ultimat3/entity`'s `postgresRepo` is the one producer, the last caller that still knows both once the SQL exists, and it wraps every repository method around its send through `withStatementAttribution()`. Hand-written SQL, a migration, a health probe and `@ultimat3/jobs`' own queue statements still carry none — nothing above them knows an entity to name — which is why the field stays optional rather than required.

  Uninstalled costs one property read and one branch, which is why the accessor hands back the installed observer itself instead of notifying through a wrapper: no event object is built for nobody to receive (axiom 6). One observer, not a list — a second install replaces the first, so "which diagnostic saw this statement" is never order-dependent, and the one consumer that needs several composes them itself, where that order is reviewable. A throw from `onStatement` reaches whoever ran the statement, deliberately: strict test mode is an observer that fails the test its N+1 happened in, and containment here would make that impossible.

  It is invoked from the two funnels every statement already passes through, and from nowhere else: `runOn` in `client.ts` — pooled and pinned alike — and `statement()` in `pglite.ts`, which is the queued path, the pinned path and the in-transaction path that skips the queue. Both settle paths notify, so a statement that failed is reported with `rows: 0` and the `X_DB_UNAVAILABLE` its caller is about to be thrown: fifty identical timeouts are still fifty statements. `rows` is the count `execute()` answers with, off the same helper, so the report and the return value cannot disagree about one statement. Reserving a connection, booting PGlite and closing a pool are not statements and emit nothing.

  **Installing an observer is also what puts the database in the trace.** Both funnels now open one span per statement around the send alone — named `db.<verb>` (`db.select`, `db.begin`; a text opening with a comment is `db.statement`), OTel kind `client`, carrying the statement under `STATEMENT_ATTRIBUTE` (`db.statement`), now exported from `@ultimat3/db` so the CLI's recorder imports the key instead of restating it — a third copy of that string is a rename that leaves the timeline grouping nothing with every test still green. That is the attribute `x dev`'s recorder already preferred over the span name, and `db.` joins `query.`/`cache.`/`job.` in the prefix table that gives the `/_x` timeline its kind — so a request's flame gains the DB children `packages/http/src/pipeline.ts` has claimed since 1.0, and `repeatedSql` counts one SQL text fifty times instead of one `query.feed` once. It is one switch, not two: with no observer installed the branch that skips the event skips the span, so a production process mints no span id and allocates no span object for the hottest path it has.

- **`expectedQueryLoop(reason, fn)` — the one way to say a loop of queries is deliberate.** Some loops are optimal and a detector counting repeats cannot know which: the admin's cross-entity search issues one indexed lookup per text field because the query IR is a conjunction and three small indexed reads beat one unindexed `OR`, and `migrate()` applies one migration per transaction because a failure has to leave the ledger describing exactly what ran. Both are now declared at source, in the loop, with the argument for it:

  ```ts
  return expectedQueryLoop('admin search runs one indexed lookup per text field', async () => {
    for (const field of fields) hits.push(...(await repo.list({ where: [match(field)] })));
    return hits;
  });
  ```

  One mechanism, and deliberately not two: no comment pragma, no config list of exempt call sites, no per-code threshold table (axiom 1) — each of those puts the argument somewhere other than the loop it defends, where the next reader will not find it. `reason` is required and non-blank (`X_INVARIANT` otherwise), because an exemption with no argument is a pragma with extra steps.

  The scope rides an `AsyncLocalStorage`, so it survives every `await` at any depth and two loops running at once never read each other. Both funnels stamp the innermost reason onto the `StatementEvent` as `expected` at settle time — captured with the statement rather than read later, because a diagnostic that judges a whole request judges it after every scope in it has closed. What is suppressed is a **verdict**, never a statement: the SQL is still sent, still observed, still a span on the trace, so everything that measures still sees the loop and only the thing that warns is told the author already answered. Production is unchanged: the reason is read inside the branch that already checks for an installed observer, so an app with no diagnostic pays nothing.

- **`withStatementAttribution(entity, op, fn)` — the `{ entity, op }` pair behind `StatementEvent.attribution`, produced.** The field shipped with `setStatementObserver()` (above) and no producer: every event in every running process read `attribution: undefined`. `@ultimat3/entity`'s `postgresRepo` is now the one producer — the last caller that still knows both once the SQL exists — and every repository method wraps its send:

  ```ts
  const attributed = <T>(op: string, send: () => Promise<T>) =>
    withStatementAttribution(entity.$name, op, send);

  async findById(id, options) {
    const op = 'findById';   // the same string idPlan(entity, id, options, op) reports on refusal
    return attributed(op, () => coalesceFindById(entity, client(), plan, shapeOf(args), id) ?? one(plan, args));
  }
  ```

  A scope, not a parameter: the statement leaves several frames and at least one microtask below the repository call that caused it — the coalescer flushes its batch from a `queueMicrotask`, a wide write is a chunked loop, a preload sends through `readByIds` — and threading a parameter through all of those is the same fact written five times, with every path an author forgot it emitting unattributed SQL instead. `withStatementAttribution` rides an `AsyncLocalStorage`, `expectedQueryLoop`'s own shape, so it survives every one of those `await`s; nesting keeps the innermost pair for the same reason `expectedQueryLoop` keeps the innermost reason — a relation preloaded during `findMany` reads through the *related* repository, so its statement is attributed to the related entity and its own operation, never to the read that triggered the preload. `findById`'s coalesced batch is flushed from a microtask scheduled inside the scope, so the one statement sent on behalf of fifty lookups carries the pair every one of those fifty would have carried.

  With no observer installed the scope is never entered — one property read, one branch, no object allocated, on the path every statement in the process takes (axiom 6), which is also why the pair arrives as two strings rather than a `StatementAttribution` literal: a literal at the call site would be allocated before the branch could decline it. An observer installed *during* `fn` therefore sees the statements that follow unattributed — installation happens once, at boot. Both funnels call `statementAttribution()` inside the branch that already found an observer, next to `expectedQueryLoopReason()`, and stamp it onto the event on **both** settle paths — the same argument as `expected`: a diagnostic that judges a whole request runs long after every scope in it closed. Hand-written SQL, a migration, a health probe, `x db` commands and `@ultimat3/jobs`' own queue statements stay unattributed — nothing above them knows an entity to name, which is why the field stays optional and a detector must still fall back to the statement text. Additive — nothing reads `attribution` yet; the N+1 detector is what will.

- **`x dev` counts repeated statement shapes per request — and it is the only process that does.** `x dev` now installs a `StatementObserver` at boot, next to the span exporter and for the same reason: an installed observer is the single switch that turns statement instrumentation on at all, so the `/_x` timeline's SQL rows and the repeat counts arrive together instead of through two toggles. `serve.ts` installs neither — a production process still pays the one `undefined` branch the seam costs uninstalled, and nothing more (axiom 6), which is the same line `serve.ts` already draws for `/_x` itself.

  The visible half is immediate: **`/_x/timeline` has DB children.** Before this, no process in the framework installed an observer, so `@ultimat3/db`'s funnels opened no span, the panel's `repeatedSql` grouped span names, and a repository loop was invisible in the one panel built to show it. A `x dev` trace now carries one `db.<verb>` span per statement with the SQL under `db.statement`.

  The ledger behind it counts one shape per request. A shape is `entity.op` when the statement is attributed — `members.findById` fifty times is the report an author can act on, and the SQL is one sample of it — and the statement's own text, whitespace collapsed, when it is not. Counting state hangs off the request's own `Ctx` in a `WeakMap`, so it is collected with the request and never swept, and a statement issued outside a request (a migration, a boot probe, a script) is not counted at all: "five of one shape" only means something inside one unit of work. Five is the default threshold, a shape is promoted to a verdict exactly once — a loop of fifty is one verdict reading `count: 50`, not forty-six verdicts — and the verdict list is bounded so a dev server up for a week retains the recent loops rather than every loop it ever saw. `expectedQueryLoop` silences the verdict and nothing else: the statement is still sent, still observed and still a span, because that scope suppresses a judgement and this ledger *is* the judgement. A statement that threw still counts — fifty identical timeouts are fifty statements, and a detector that went quiet there would go quiet exactly when the loop cost the most.

  What renders those verdicts is the entry below: the ledger counts and warns once, and the four surfaces read one projection of it.

- **`X_N_PLUS_ONE_QUERY` and `X_N_PLUS_ONE_WRITE`, whose `fix` is a line that already compiles.** Both are owned by `@ultimat3/entity`, because the fix speaks that package's vocabulary — `preload`, `insertAll`, `updateWhere` — and a code owned by the process that detects loops would put the one sentence an author acts on in a package the entity layer cannot see. `nPlusOne(loop)` takes a ledger's verdict and returns the error; it counts nothing, holds no threshold and installs no observer.

  ```ts
  nPlusOne({ kind: 'read', subject: 'members.findById', count: 50, entity: 'members', op: 'findById' });
  // X_N_PLUS_ONE_QUERY: a read repeated once per row
  //   cause: members.findById ran 50 times in one request — one read per row
  //   fix:   db.posts.preload('author')   # one statement for the whole page
  ```

  The relation in that `fix` is **derived, never invented**: `preloadsFor(entity, op)` reads the same `relationMap()` `preload()` resolves against, so the pasted line resolves against the schema that produced the loop. The operation picks the side — a point lookup per row is the `belongsTo` edge (`posts.preload('author')`), a filtered read per row the `hasMany` edge (`posts.preload('comments')`) — and every other operation falls back to the batched form of the statement that repeated, `db.members.andWhere('id', 'in', ids).all()`. Edges are read by their `to` end, because the loop repeated on the entity being *looked up* and the ledger only ever saw the statement, never the `for … of` above it: two entities may both reference it, so both pages are named, the first pasteable and the rest after it, exactly as `X_PRELOAD_UNKNOWN_RELATION` spells its names. A write loop names the bulk form of the same call — `insertAll(rows)`, `updateWhere(filter, patch)`, `deleteWhere(filter)`, and both of the first two when the operation has no single bulk form of its own — and hand-written SQL, which is attributed to no entity, names the statement's own `any($1)` form instead of a chain that does not exist.

  A schema whose relations cannot be named still reports the loop it was asked about: `relationMap()` throws `X_INVARIANT_VIOLATED` on two foreign keys it cannot tell apart, and a diagnostic that let that escape would replace the N+1 with a schema complaint the loop did not cause — in a dev process, as an uncaught throw — so the derivation falls back to the `in` form. Neither code is ever thrown and neither carries a flag to turn the warning off: `expectedQueryLoop(reason, fn)` from `@ultimat3/db` is the one way to declare a loop deliberate, and it silences the count upstream of the error rather than answering it.

- **A loop in `x dev` reaches four surfaces, and no surface counts a second time.** The ledger's verdicts now arrive wherever a diagnostic is already read, through the channels that already existed:

  | Surface | What it shows |
  |---|---|
  | `x dev` findings | the verdict as a `Finding`, located by request id — text and `--json` render it for free |
  | `/_x/timeline` | `nPlusOne`, the loops of the request on screen, beside the flame that drew them |
  | the browser overlay | the same code/cause/fix under the error, on the page the author is looking at |
  | the log | one `logger.warn` per request per code, carrying `requestId`/`traceId` automatically |

  **One detector, four renderers.** `statement-loop.ts` in `@ultimat3/cli` is the single projection: it hands a verdict to `nPlusOne()` and every surface reads what comes back, so the `fix:` the timeline prints is the `fix:` the terminal prints is the `fix:` in the log. The count is read when a surface asks, not frozen at promotion — a loop of fifty reads `ran 50 times` — while the log line names the count at the moment the threshold was crossed, because that is when it was emitted.

  The timeline keeps **two** fields on purpose. `repeatedSql` stays what it was, a measurement over the recorded trace: every SQL text that appeared twice. `nPlusOne` is the verdict, counted per request with attribution applied and `expectedQueryLoop` honoured. A measurement that started warning would be a second detector — blind to a declared loop, grouping fifty point lookups by their bind values — disagreeing with the one whose `fix:` an author pastes. A host that installed no ledger gets `null` there, never `[]`: "nobody counted" is not "this request was clean".

  New seam, dev-only: `ServerHooks.devNotices` in `@ultimat3/http`, called **inside** the `config.dev && wantsOverlay` branch and nowhere else, so a production process and an agent asking for `problem+json` never pay for it. `OverlayNotice` is declared structurally there for the reason `AuthzDecision` is — tier 2 can never import the package that owns the codes. `x dev` is the only host that supplies one; `serve.ts` boots through the same `startRoles` and passes nothing.

- **`statements` — the fixture that fails a test on its own N+1.** A warning in a dev server is a warning nobody is looking at during CI. Destructuring `statements` installs the detector in **throw** mode for the length of one test, and the loop's fifth statement rejects where it was issued:

  ```ts
  import { expect, test } from '@ultimat3/testing';

  test('the feed reads its authors once', async ({ statements }) => {
    await renderFeed();                              // a per-row findById throws here:
    //   X_N_PLUS_ONE_QUERY: members.findById ran 5 times in one request — one read per row
    //   fix: db.posts.preload('author')   # one statement for the whole page
    expect(statements.count('posts.findMany')).toBe(1);
  });
  ```

  Opting in is naming it: a fixture nobody destructures is a fixture nobody built, so there is no `strict: true` to remember and no suite-wide switch to forget. The threshold is `N_PLUS_ONE_THRESHOLD` from `@ultimat3/entity` — the same number `x dev` warns at, now exported, because a loop that fails a test and a loop that warns in dev have to be the same loop — and the error is `nPlusOne()`'s, so the `fix:` names the `preload()` the schema's own relations spell.

  Two differences from the dev ledger, both deliberate. **The unit of work is the test, not the request**: the ledger keys its tally on the `Ctx` object and ignores a statement issued outside a request, and a unit test calling `posts.findById(id)` with no request anywhere is exactly the loop it was written to catch. **It throws once per shape and keeps counting**, so a test that catches the error gets one failure at the statement that crossed the threshold rather than one per statement after it — and `statements.all()`, `.count(fingerprint?)` and `.shapes()` still measure the whole loop, expected statements included. `expectedQueryLoop(reason, fn)` remains the one way to declare a loop deliberate: it suppresses the verdict, never the measurement. The seam is handed back on disposal like `network` and `runJobs` — the observer that was installed before, not a fixed default.

- **`statementFingerprint()`, `statementKind()` and `statementVerb()` from `@ultimat3/db`.** What shape a statement is — `entity.op` when attributed, its own whitespace-collapsed text when not; read or write from the leading verb — is now one rule next to the `StatementEvent` it reads, rather than a copy per detector. `x dev`'s ledger and the `statements` fixture group by the same identity by construction, and `statementSpanName` reads its verb from the same scanner.

### Fixed

- **`x db migrate` verifies the database it just migrated — the third engine split, closed.**
  `checkDrift` existed twice under one name and one `X_DB_DRIFT`. `@ultimat3/db`'s read the ledger,
  introspected the live catalog and diffed the two — and had **zero callers anywhere**.
  `@ultimat3/cli`'s hashes the entity source against what `x db gen` recorded, never opens a
  database, and was the one wired into `x verify`, `x doctor` and `x db migrate`. So the comment on
  `x db migrate` promising "a schema that migrated cleanly and still disagrees is the failure this
  command exists to surface" described a check that reads files and answers the same before and
  after a migration: a column added by hand was invisible on every path the framework ships.

  `@ultimat3/db`'s `checkDrift()` is now **the post-migrate verification**, and it runs where a
  connection is open: `runMigrations` calls it inside the queue's lifetime and returns it on
  `MigratedApp.drift`, so `x db migrate`, `x db reset` and `ROLE=migrate` verify one post-condition
  through one call, the way they already apply migrations through one. `x db migrate` renders each
  difference through `driftError` — the pinned three-line `X_DB_DRIFT` output, never a second copy
  — and exits non-zero; a `ROLE=migrate` container logs the first difference and still exits 0,
  because its contract is "apply every migration, then exit" and a diagnostic after a clean apply
  is not a failed migration.

  It could not have run before: `x_migrations`, `x_jobs`, `x_job_steps`, `x_outbox` and every
  `@ultimat3/auth` table are `create table if not exists` at boot, declared by no migration and
  carried in no snapshot, so a correct database reported eight `unexpected-table` findings. New
  `appTables()` / `FRAMEWORK_TABLE_PREFIX` in `@ultimat3/db` drop the whole `x_` namespace before
  the diff — a prefix, so a table a future package adds needs no second list. `introspect()` keeps
  its narrower exclusion, because the admin schema view and MCP's `schema.describe` legitimately
  show `x_users`.

  The source check keeps its job and loses the collided name (see *Changed*): it stays `x verify`'s
  `drift` step and `x doctor`'s probe, where no database exists to open, and is no longer repeated
  on `x db migrate`. One condition, one reporter, each. `packages/cli/src/drift.ts` also gains the
  test file it never had — eight tests over a check that has been failing builds since 1.0.0.

- **`x db gen|migrate|reset` run the framework's own migration engine — there is no second one.**
  All three shelled out to `bunx drizzle-kit`, and `x db studio` to `bunx drizzle-kit studio`.
  drizzle-kit is declared in **no** `package.json` in this repo and is not installed, so `bunx`
  network-fetched an unpinned version at run time — a supply-chain surface, and the reason a
  scaffolded app's very first documented command (`bin/setup` → `x db migrate`) exited
  `X_DB_MIGRATE_FAILED` on *drizzle.config.json file does not exist*. Worse than broken: two
  engines with two journals for the same question, while `ROLE=migrate` already applied migrations
  through `@ultimat3/db`'s ledger.

  `x db gen` now calls `generateMigration()`, and `x db migrate` / `x db reset` call `serve.ts`'s
  own `runMigrations` — literally the function `ROLE=migrate` runs. A laptop, CI, staging and
  production share one `x_migrations` ledger, one checksum rule and one advisory lock. The MCP
  `db.migrate` tool joins them; it kept a fifth shell-out and a third hand-rolled scanner of
  "which migrations exist", both now the framework's own `readMigrations` + `pendingMigrations`.

  `x db gen` opens no database at all: it diffs the app's entities against the schema the newest
  migration **declares**, and writes that schema beside the SQL as `<id>.snapshot.json` so the next
  generation is incremental. `declaredSchema()` is new in `@ultimat3/db` and `expectedSchema()` is
  now defined over it, so generation and drift can never read one snapshot two ways. `--allow-destructive`
  is now a real flag, because `X_MIGRATION_IRREVERSIBLE`'s own `fix:` line has always named it and
  the parser used to refuse it.

  `x db studio` moves to the planned table (`PLANNED_SUBCOMMANDS`, new): `X_NOT_IMPLEMENTED` with
  `x dev   # then the db panel at /_x`. One subcommand does not earn a second schema engine.
  `X_DB_STUDIO_FAILED` is now reserved and never thrown, like `X_MIGRATE_CONCURRENT`.

  Two smaller fixes ride along. `readMigrations` skipped nothing, so a hand-written pre-1.2.0
  `<id>.down.sql` beside its `<id>.sql` was read as a migration named `<id>.down` and would have
  **dropped every table it exists to reverse** — it is now never applied, and the reference app's
  own migration is one file with a `-- down` marker like every generated one. And `packages/db/migrations`
  was spelled in two places that had to agree; it is one constant now, in the module that reads it.

- **A migration `up` holding two statements applies — on both drivers.** `migrate()` sent the whole
  script through one `tx.execute(raw(migration.up))`, and the two drivers disagreed about what that
  means. PGlite's `query()` is the extended protocol always, so it refused the send outright:
  *cannot insert multiple commands into a prepared statement*. Bun.SQL degrades to the simple
  protocol whenever the text carries no bound value, so against a server the same script happened to
  apply — until it carried one, and never by contract. The embedded driver is the one `x dev` and
  `x db branch` run on, and `createTable` emits the table **and** every index it carries, so an
  entity with one index generated a migration the local database could not apply. The documented
  workaround was one statement per file.

  `migrate()` and `rollback()` now split the script and send one statement at a time, inside the
  **same** transaction: a half-applied migration is worse than an unapplied one. Splitting is
  `statementsOf()` (`@ultimat3/db`), and it is a scan, not a `split(';')` — a `;` inside a string
  literal, a quoted identifier, a dollar-quoted body, a `--` comment or a **nested** block comment is
  data, and a generated migration holds all five, including the `-- backfill "c", then: … set not
  null;` note written for a NOT NULL column added to a populated table. A chunk of whitespace and
  comments alone is dropped rather than sent as an empty query, so a no-op `up` reaches its ledger
  row instead of failing on nothing. The seven copies of this rule hand-rolled across
  `@ultimat3/entity`'s and `@ultimat3/ai`'s live tests are gone — they import the one migrations use.
  Pinned where it actually broke: `pglite-embedded.test.ts` applies a table-plus-index `up` against
  the real embedded database and reverses it, and `migrate.live.test.ts` does the same against a
  real server.

- **A composite index reaches the generated migration whole.** `EntityDescription.indexes` carried
  index *names* and `parseIndexName` recovered the column list back out of one, so
  `indexes: [{ on: ['orgId', 'createdAt'] }]` emitted
  `create index "todos_org_id_created_at_idx" on "todos" ("org_id_created_at")` — one column that
  does not exist, `42703`, and a migration nobody can apply. The convention that builds the name
  joins with `_` and does not run backwards: two columns and one column called `org_id_created_at`
  are the same string. `IndexDescription` now carries `columns`, `unique`, `where` and `order`, and
  the generator spells every part of them — so a **partial** index keeps its predicate (emitted as
  a total one, it refused rows the entity allows) and a `desc` index keeps its direction.
  `parseIndexName`/`ParsedIndex` are gone; nothing derives an index from a string any more.
  Composite unique indexes are what `upsertAll`'s `on conflict` is inferred against, so
  `packages/entity/src/pg-driver-bulk.live.test.ts` no longer creates its own by hand — it asserts
  the generated migration carries it. An index over no columns is `X_INVARIANT` at `entity()`
  rather than DDL Postgres cannot parse.

- **The `/_x` DB panel's read-only guard read a comment marker inside a quoted identifier as a
  comment.** `select 1 as "--"; delete from members` blanked from the `--` onward, so the scan saw
  `select 1 as "`, called it a read, and handed the whole string to Postgres — which ran both
  statements. The passes could not be ordered correctly, because each opaque form can contain
  another's opener: blanking comments first eats the `--` inside a string, blanking strings first
  eats the `'` inside a comment. `sanitize()` is now ONE left-to-right alternation over every span
  Postgres reads as opaque text — `'…'`, `"…"`, `$tag$…$tag$`, `--` and block comments — which
  resolves them the way a lexer does: whichever token starts first consumes the rest. An
  unterminated quote matches nothing and leaves the rest of the statement visible to the scan;
  failing open there would be the same bypass by another route.

- **`/_x/live` reported every subscriber-lookup failure as "no sync node".** A bare `catch` around
  `sources.subscribers()` folded an authz refusal, a dropped NATS connection and a bug in the
  recorder into `dev.live.no-sync-node` — the note for a tier that was never installed — and threw
  the diagnostic away, telling the reader to wire up something they already had. It now catches
  `DevSourceUnavailableError` and nothing wider; everything else reaches `panelPayload`, which
  renders its code and its fix line.

- **The policy contract test called any coded failure "before its policy decided".** `invoke` runs
  parse input → row → policy → handle → parse output, and every `UltimateError` from any stage
  landed in one branch: an `X_OUTPUT_INVALID` from the parse *after* the handler was reported as
  input drift, with `pass \`input:\`` as the fix — a knob that changes nothing about an output
  schema. Worse, it hid the case the assertion exists to catch: a `policy: allow()` whose handler
  throws was read as drift rather than as an anonymous actor getting through. Only
  `X_INPUT_INVALID` becomes `X_CONTRACT_DRIFT` now; every other code keeps its own code and its own
  fix, the same reasoning that already rethrew a non-`UltimateError` untouched.

- **An unusable `docs` link buried a usable `type`.** `nonEmpty(body['docs'] ?? body['type'])`
  selected on presence, not on being a link, so a problem document carrying `docs:
  'javascript:alert(1)'` alongside a valid HTTPS `type` reached `RemoteActionError` with only the
  unusable one and fell back to the error index. Both now travel in preference order and
  `remoteDocs` takes the first that is an absolute `http(s)` URL.

- **`/_x/live`'s `sql` field was permanently `''`.** `QueryDescriptor` never carried SQL text —
  `defaultDevSources().liveQueries()` read a field the registry does not produce — so every row in
  the live panel printed an empty string forever, not the query it described. It now compiles real
  SQL through `@ultimat3/query`'s `describeSql`, given a sample input via the new `sqlSamples`
  option on `defaultDevSources`; a query with no sample answers `sql: null`, honestly "unknown",
  never an invented `''`. `LiveQueryFact.sql` is `string | null` to say so.

- **`/_x/live`'s "no sync node" note fired for a sync node with zero subscribers.** `panel-live.ts`
  folded "the source is unwired" and "the source answered `[]`" into one empty array, so a live
  tier that was up and running with nobody attached printed `dev.live.no-sync-node` — a different
  and wrong diagnosis. The two are now told apart: an unwired source still degrades to the note,
  a wired one with no subscribers shows an empty list and no note.

- **The `/_x` DB panel's write guard matched a write word inside a string literal.** `assertReadOnly`
  tested `\b(insert|update|…)\b` against the raw SQL text, so `select * from events where kind =
  'create'` was refused as a write statement — a false positive on the exact kind of filtered read
  the panel exists to answer. It also read only `--` line comments, so a `/* … */` block comment
  naming a write word could still trip the same false refusal, or a comment could hide a real one
  past the leading-keyword check. `assertReadOnly` now sanitizes string literals and both comment
  forms (blanking them, not deleting them, so `whe` + `re` never fuses into a new keyword) before
  the keyword scan runs.

- **`ToolRegistry`'s field used TypeScript `private` instead of a real `#` private field**
  (`@ultimat3/mcp`), the one place in `registry.ts` that had drifted from the rest of the package's
  convention — `private` is erased at compile time only, `#tools` is actually inaccessible outside
  the class at runtime.

- **`DevPanel.question` was an English literal sitting beside `titleKey`**, in `panel.ts` and every
  `panel-*.ts` (`@ultimat3/admin`) plus the CLI's two process panels — rendered raw into `/_x`'s
  `<p class="question">` with no `t()` in the path, and `titleKey` itself was declared on every
  panel but never actually read anywhere. Replaced with `questionKey` (`t()`'d the same way
  `titleKey` now is, for the tab label), both following the `dev.panel.<key>.title` /
  `dev.panel.<key>.question` convention the rest of `catalogs/en.json` already uses.

- **A route's `load` swallowed every failure that carried a `code`, and a route that loaded nothing claimed to load anything.** `routeDataFor` rethrew a caught error untouched whenever it was an `Error` with a string `code` — the shape of a framework error, and equally the shape of every `ENOENT`, `ECONNREFUSED` and `ERR_MODULE_NOT_FOUND` a loader can raise. A `load` that read a missing file surfaced Bun's own rejection, with no `X_ROUTE_LOAD_FAILED`, no fix line and no mention of the route an author has to go and fix. The check is now `isUltimateError` from `@ultimat3/core`, which reads the well-known brand: a policy denial or a tier-0 `X_VALIDATION_FAILED` still passes through with its own code, and everything else gets wrapped, as it always should have.

  The second half is the branch above it. With no `load` the context IS the route's data, and it was handed back as `ctx as unknown as TData` — a double cast that let a route declare `meta: ({ data }) => ({ title: data.post.title })`, load nothing, and render `undefined` in a `<title>` on the surface whose entire purpose is SEO. `defineRoute` now takes `RouteDefinition<TData> & LoadRequirement<TData>`: data the context cannot supply requires a `load`, so that route is a compile error, and the fallback narrows to `RouteContext & TData` — checked, not laundered. `RouteContext` is an alias rather than an `interface` for the same reason; only an alias is a `RouteData`. Pinned in `packages/render/src/type-pins.ts`. Routes reading `data.url` / `data.params`, and every route `x new` and `x g route` write, are unaffected.

- **The typed client rebuilt a server's failure as a locally-declared one, and invented the page documenting it.** Any `problem+json` body with a string `code` became a bare `UltimateError` carrying that code plus `docs: https://ultimate.dev/errors/<code>` — a URL synthesized in the browser for a code this bundle never registered. The codes that reach a browser are exactly the ones that need it least: an app's own `X_SIGNUP_CLOSED`, declared through `registerErrorStatus`, printed a `docs:` line pointing at a framework page that does not exist, under a title humanised from the code as if the framework owned it. `typeof code === 'string'` was the only check, so a gateway answering `{"code":""}` produced an error rendering `: `.

  Failures now come back as `RemoteActionError`: the code rides along verbatim — matching on it is the point of `problem+json` — but the error says where it came from, `name` in a stack trace and `meta: { origin: 'remote', action, status }` in `--json`, the dev overlay and the error reporter, with the status also typed as `.status`. The docs link is the server's own when it sent a resolvable `http(s)` one (RFC-9457's `type` counts, `about:blank` and `javascript:` do not), this build's registered link when it knows the code, and otherwise the index — never a per-code page nobody wrote. A body naming no `X_SCREAMING_SNAKE` code is a proxy answering rather than the app, which is what `X_RPC_FAILED` already says.

- **`.job()` was missing from the view the registry hands back.** `listActions()` and `getAction(name)` answer in `AnyAction`, the schema-erased view, and it projected an action to every surface except the queue: `getAction('publishPost')?.job()` was a type error against an object that has carried the method since `facadeFor` bound it. The erased view now declares `job(): ActionJobHandle`, and `Action` narrows it to its own schemas as before. `client()` stays off it and now says why in a build error rather than a comment — a `ClientMethod` is a function type, so its input is contravariant and no erased spelling is assignable from a concrete one. Both halves are pinned in `packages/action/src/type-pins.ts`, source rather than a test, because `tsconfig.json` excludes tests and `tsc` never reads one.

- **`.contract()`'s policy assertion never reached a policy.** The generated `"<action>: policy denies an anonymous actor"` test invoked the action with `{}` and accepted **any** `UltimateError` as proof of a denial. Every action with a required input field — which is every action `x g action` writes, and all three in the reference app — failed `input:` before `guard()` ran, so the assertion passed on `X_INPUT_INVALID` and proved nothing about authz. An action whose policy was `allow()` passed it too.

  The test now sends an input the schema accepts, synthesized from the schema's own IR (required keys only, formats included: `t.uuid` gets a uuid, `t.money` gets minor units and a currency, a nullable field gets `null`), and accepts only an `ActionDeniedError` — the one outcome that means the policy decided. It is the class and not `X_FORBIDDEN`, because a denial carries the policy decision's own code and the blessed `can()` answers a null actor with `X_UNAUTHENTICATED`; pinning one code would fail every action authored the way the framework teaches. Anything else thrown before the policy is `X_CONTRACT_DRIFT` naming the culprit code, with `pass \`input:\` to contractTestsFor(<action>)` as the fix — the new `input` option, for a schema carrying a constraint the IR cannot invert (a bare `pattern`) or a `row:` loader that needs an id which resolves. `contractTestsFor` is unchanged for callers that pass neither.

- **A cache bust that refused failed the write it followed.** `invoke` awaited `invalidateTags()` after the handler had already committed, so a fan-out that refuses outright — `invalidates: [tag.pots]`, or any tag a manifest older than the entity never declared, raising `X_CACHE_TAG_UNKNOWN` — turned a durable write into a failed action, and the caller retried a write that had already happened. The bust now goes through `bustAfterCommit` in `cache-gate.ts`, the one place this package calls `invalidateTags`: the refusal becomes a single `action.invalidate.failed` error line and the stale entries expire by TTL. That is the rule `@ultimat3/cache` already held for one dead tier, now held for a fan-out that never started. A replay busts nothing either — `idempotent: true` plus a repeated `Idempotency-Key` runs no handler, so re-purging the CDN and re-queueing ISR on every retry was work for a write nobody made.

- **An `ack` that failed re-queued a job that had already finished.** `executeJob` settled inside the `try` it ran the body in, so an `ack` rejected by a pool timeout or a reset on that one statement fell into the retry branch: the queue was told the attempt FAILED, `nack` re-delivered work whose side effects outside a step had already happened, and the run was reported as `retried` — a point in `jobs_total{outcome}` for a failure that never occurred. Settlement now lives outside the retry decision. Only the body's own rejection reaches the `catch`; an `ack` that cannot land propagates to the worker, which logs `jobs.worker.settle-failed` and lets the lease lapse, so the queue re-delivers because nobody could say the job ended rather than because it failed.

- **A heartbeat that renewed too LATE hid the lease it lost.** Expiry was decided before the driver was asked, which catches a renewal that hangs or rejects — but a renewal that *succeeds* after the visibility window (an event-loop stall, a driver answering at the end of its connect timeout) then set `renewedAt = now()` and restarted the clock on a lease the queue had already handed to another worker. The one failure shape with nothing to catch is now checked after the `await` as well: a renewal that lands past its own window reports `jobs.lease.lost` and `job_leases_lost_total` instead of silently extending somebody else's lease.

- **`task({ tz: '+02:00' })` was accepted.** The zone check was a local `Intl.DateTimeFormat` probe, and ES2024 `Intl` accepts a numeric offset — the one kind of "zone" that carries no DST rules, which is the entire reason a cron needs a zone. `task()` now validates through `@ultimat3/time`'s `isValidTimeZone`, the same rule the rest of the framework holds dates to: one validator, so a zone `task()` accepts is a zone `@ultimat3/time` can do arithmetic in. `'Bogota'` and `'Not/AZone'` are refused as before.

- **`jobs.scheduler.tick-failed` threw away everything that made the failure actionable.** The round's catch logged `error.message` only, so an `UltimateError` reaching it lost the stable code an operator searches on and the `fix:` they run. The log line now carries `code`, `cause` and `fix` when the failure has them, and is unchanged for a plain `Error`.

- **`X_ABORTED` said `no action needed`.** A `fix:` line an agent cannot act on is a defect in the error (axiom 4), and both throw sites — `@ultimat3/core`'s `throwIfAborted` and `@ultimat3/jobs`' `JobAbortedError` — said exactly that. Both now name the call: `add throwIfAborted(ctx) before expensive work, or pass fetch(url, { signal: ctx.signal })`. The wiki row matches.

- **The `job` verify gate step was a silent no-op.** `packages/jobs` — the package the suffix names — shipped zero `*.job.test.ts` files, so `x verify`'s `job` step (step-replay, idempotency-dedupe, outbox-atomicity, per its own summary line) always reported green with nothing run, and none of the package's 12+ unit test files ever called a worker's real `start()`/`stop()` — every prior test drove the loop by hand through `tick()`. Four new opt-in suites close it: `replay.job.test.ts` proves a completed step survives both a real retry and a real suspend/resume without re-running, over an actual polling worker; `idempotency.job.test.ts` proves two enqueues racing on one key collapse to a single row that a real worker (even three contending) runs exactly once, and that the dedupe window is "currently live" rather than "ever existed"; `outbox-atomicity.job.test.ts` follows a staged row past the queue boundary the existing `outbox.test.ts` stops at, through to a real worker, proving a rollback never reaches one and a relay that republishes after a crash still yields one execution; `worker-soak.job.test.ts` runs several real workers against one shared driver with one killed mid-job (its queue connection severed, never a clean `stop()`) and asserts every job still reaches a terminal state — no orphan — with the actual unit of work behind it executed exactly once — no double-execution.

- **The scheduler dispatched a tick it was already dispatching.** `start()` guarded a second `start()`, never a second tick: the loop was a `setInterval` at the tick interval, so a round slower than one second — a task with twenty entries, a `run-all` catch-up after downtime, a queue under load — had the timer open a second round while the first was still enqueueing. Both read the same `lastFiredAt`, both walked the same occurrences and both dispatched them. The occurrence-scoped idempotency key deduped the jobs, which is exactly why nobody saw it: what was left was a re-marked watermark, occurrences reported as dispatched that were never enqueued, and a catch-up sequence interleaved with itself.

  The loop now re-arms on the round it just finished, so the interval is the **gap between rounds** rather than a fixed period, and every other caller of `tick()` joins the round in flight instead of opening a second one. Cron accuracy pays nothing for it: an occurrence is computed from the clock, not from tick counts.

- **`stop()` released the leader lock out from under a live dispatch.** It cleared the timer and released immediately, without waiting for the round it was racing — so a standby promoted while this node was still enqueueing an occurrence's jobs, and both then owned it. The advisory lock exists to make that impossible; releasing mid-dispatch handed it away. `stop()` now stops dispatching, waits out the round in flight and only then releases, and the round re-reads the drain state before each task, so a stop between two tasks means stop now rather than at the next round. A task not reached keeps its `lastFiredAt` untouched, so the next leader owes it.

- **The scheduler registered no shutdown hook at all.** `onShutdown` was not imported: on SIGTERM the lock was held until the lease expired, and any occurrence mid-dispatch was abandoned wherever the process died. It now registers one hook at the `accept` phase, exactly as the worker does — one while it runs, handed back in the teardown's `finally`, so a `release()` that threw still gives it up and a start → stop → start cycle holds one rather than one per start. `drainOnShutdown: false` opts out.

- **`catchUp: 'skip'` was documented as waiting for the next occurrence.** It never did: it fires the latest missed one and drops the older ones (`'run-once'` fires the earliest missed one instead). The code was right and shipped that way — the comment, the README and `wiki/Scheduled-Tasks.md` were wrong.

- **A lost lease was the quietest bug a queue can have.** The worker's heartbeat ended in `.catch(() => undefined)`, so a renewal that stopped landing — a connection reset, a pool exhausted, a Postgres failover — produced nothing at all: no line, no series, no signal. The visibility timeout then expired under a job that was still running, the queue handed it to the next worker that claimed, and the only evidence was a job that ran twice for reasons nobody could reconstruct.

  A renewal now decides between two different facts. **One failed renewal is not a lost lease** — there is a whole visibility window left and, at the default interval, three tries inside it — so it logs `jobs.heartbeat.failed` at `warn` and nothing more. **A window that passes with no renewal landing is a lost lease**: `jobs.lease.lost` at `error`, with the job, the queue and the attempt, plus one point on the new `job_leases_lost_total{queue}` counter. Every point on that series is one job that ran twice, which is why it is a series of its own and not an outcome on `jobs_total`.

  The window is measured on the worker's own clock from the last renewal that **landed**, not on `claimed.visibleAt` — that timestamp comes from the driver's clock, and comparing the two would make every lease decision a function of clock skew. Two failure modes fall out of it that a rejection-only check could never see: a heartbeat hung on a dead connection (it neither resolves nor rejects, so expiry is checked before the driver is asked), and a renewal that lands long after the window is gone (a late success is not a lease — the job belongs to another worker now, and renewing would extend theirs).

- **One slow job froze the whole worker.** A claim pass ended on `Promise.allSettled([...inFlight])` — every job the process held, across every queue — so nothing was claimed again until the slowest member of the batch finished. A `concurrency: 10` pool ran the ten it started and then sat idle behind one long job; a second queue was not asked at all.

  The claim loop now re-arms on the **pass**, not on the jobs. A slot belongs to its own job and is free the moment that job settles, so the next poll refills exactly that slot and every other queue keeps being served. `worker.tick()` still resolves with the executions **that pass** started, so tests read unchanged; a saturated queue still costs zero driver calls, because free slots are counted before anything is claimed.

- **A job that could not be settled with its driver vanished.** `allSettled` swallowed the rejection, so an `ack` that failed on a closed connection left no trace anywhere. It is now `jobs.worker.settle-failed` at `error` — and, since nothing else awaits those promises any more, the one place a job's failure is observed at all.

- **A job that hit its `timeout` kept running beside its own retry.** The deadline rejected the attempt and nothing told the body about it: the rejection nacked the job, the queue handed it to the next worker that claimed, and the original handler carried on — two copies of one job, in one process or two, both writing steps into the same `runId`. The one thing that had to happen first — telling the body to stop — never happened at all.

  A deadline is now a **cancellation**, in that order: cancel, then fail the attempt. The signal is `ctx.signal`, the seam an action body already reads, so nothing jobs-only has to be learned:

  ```ts
  run: async ({ input, ctx, step }) => {
    // Aborted at the job's `timeout`, and also when the caller's own ctx goes away.
    const res = await fetch(url, { signal: ctx.signal });
    throwIfAborted(ctx); // or check ctx.signal.aborted in a long loop
    await step.run('save', (signal) => save(res, { signal }));
  },
  ```

  Three rules fall out of it:

  - **A cancelled attempt writes no steps.** Nothing in JS can kill a body that ignores a signal, so the durable state is fenced instead: past the cancel, `step.run`, `step.sleep` and `step.waitForEvent` refuse to write and raise `X_ABORTED`. A late `completed` would hand the attempt that replaced this one a step it never ran; a late `failed` would erase one it did. The refusal is what unwinds an uncooperative body, and it is one guard on one write path, not a check per call site.
  - **`step.run`'s callback receives an `AbortSignal`** — the run's cancellation and that step's own `stepTimeoutMs` ceiling composed, so a body reads one signal and sees whichever deadline lands first. Purely additive: every zero-argument `() => …` callback already written is unchanged. The per-step timeout aborts before it rejects too, same order and same reason.
  - **A body that runs past its deadline is named.** `jobs.timeout.abandoned` logs at `warn` with the job and how it ended, which is how an app finds the handler that never reads `ctx.signal`. A body that stopped *because* it was cancelled is the intended end and stays quiet.

  `executeJob` moved to `packages/jobs/src/execute.ts` — same export from `@ultimat3/jobs`, and `worker.ts` is back under the file-size ceiling it was one line from.

- **The jobs worker's drain closed the queue connection under a job it had just claimed.** `tick()` read the drain flag on entry and never again, so a round that got past that read kept going: it was still awaiting `driver.claim()`, and the jobs it started joined `inFlight` *after* `stop()` had already snapshotted that set. The snapshot was empty, the drain concluded there was nothing to wait for, and `driver.close()` ran with a handler mid-flight — the ack never lands, the lease expires, and the queue hands the job to the next worker that claims. That is the "always twice" draining exists to prevent, on exactly the deploys where a poll and a SIGTERM land in the same tick.

  `stop()` now waits out the claim round it is racing before it waits on the jobs. A round registers itself in the same synchronous step as its guard — no await between them — so it is either refused by a drain already under way or visible to every drain that starts after it. Two rules fall out of that:

  - **A round already in flight stops claiming the moment the drain starts.** The state is re-read before each queue rather than once on entry, so a `stop()` landing between two queues is honoured by the round it landed in, not the next one. What that round already holds still runs to the end — that is the drain, and `stop()` waits for it.
  - **A `driver.close()` that throws leaves the worker `'stopped'`.** The state was assigned after the close, so a throwing close pinned it at `'draining'` for the life of the process: `stats()` reported a drain that had already finished, and `start()` — which leaves only `'idle'` or `'stopped'` — refused to run that worker again. It is now set in the same `finally` that hands the shutdown hook back. The failure still reaches the caller, on the promise it awaited.

- **The jobs worker leaked a shutdown hook per `start()`.** `onShutdown` returns an unregister and `createWorker`'s `start()` threw it away, while `stop()` unregistered nothing — so a stopped worker stayed on the process's drain list forever, holding its driver, its in-flight set and the whole worker closure alive. The `start()` guard read `'running'`, so start → stop → start stacked a second registration on the first, and every later drain called all of them. `@ultimat3/realtime`'s `listenSyncNode` and `@ultimat3/http`'s `server.ts` already kept theirs; the worker now does too, released in a `finally` so a `driver.close()` that throws still hands it back.

  Two rules fall out of making the registration single:

  - **`start()` only starts from a standstill.** It used to restart mid-drain, putting the claim loop back on a driver the drain was about to close — and stacking a hook on the one still running, which is the leak again by another route.
  - **`stop()` is one teardown, joined.** A SIGTERM landing on a manual stop used to run the whole drain a second time and close the driver underneath it. Concurrent callers now await the same promise, which is cleared as it settles so a worker that started again tears down again rather than joining a promise that settled a lifetime ago.

  `@ultimat3/core` exports a test-only `shutdownHookCount()` — the same shape as `idleWaiterCount()` — so "one hook while it runs, none once it has stopped" is assertable rather than asserted in prose.

- **`LiveClient` never reconnected.** `#scheduleReconnect` computed the delay, incremented the attempt counter and published `reconnectAt` — and armed nothing. No `setTimeout`, no call to `connect()` from any close path; `reconnectAt` was read in exactly one place, `useConnection()`, to render a countdown that then expired and sat there. A client that lost its socket stayed offline until the app called `connect()` itself, which meant every deploy, every idle timeout and every dropped Wi-Fi packet ended the session. `drainPlan()`, the `reconnect` frame and `AcceptBudget` — the three mechanisms that spread a reconnect herd — were spreading clients that were never coming back.

  The timer is now armed by the same method, through an injected `Scheduler` (`(fn, ms) => cancel`) defaulting to `timeoutScheduler`, so the reconnect is provable without sleeping. Four consequences fall out of making it real:

  - **`onClose` drops the socket reference, and speaks only for its own socket.** `#send` is fire-and-forget, so a retained dead socket turned every later frame into a silent no-op the caller believed had landed. And a socket `connect()` had already replaced could close later and take the live connection down with it — offline, every subscription `offline`, a backoff armed against a healthy socket — so the handler returns before touching any state when `#socket` is no longer the socket that closed. `close()` reports its own subscriptions offline as a result: the close it triggers is now one of the events that returns.
  - **A server-assigned delay survives the close it triggers.** A `reconnect` frame arms the node's slot *before* closing, and `onClose` only schedules when nothing is armed — otherwise the delay `drainPlan()` computed for this socket was immediately overwritten by a local backoff, re-clustering the herd the node had just spread.
  - **A dial that throws arms the next attempt, and is reported rather than rethrown.** A socket constructor is allowed to refuse — mixed content, a URL the page may not open — and one throw inside the timer would otherwise end the chain as completely as never arming it did. Nothing awaits a timer, so a throw out of one is `window.onerror` in a tab and an uncaught exception under Bun that can kill the very process that was about to retry. The failure goes to the new `LiveClientOptions.onError` seam instead, defaulting to `console.error` — never `@ultimat3/core`'s `logger`, whose writer is `process.stderr` and this is browser code. A `connect()` the app called itself is still the app's to handle, still throws to it, and still arms nothing.
  - **`LiveClient.close(code?, reason?)` is new**: cancels the armed reconnect and drops the socket, so a client whose owner is gone stops dialling. `connect()` starts over — it is a stop, not a tombstone.

  ```ts
  const client = new LiveClient({ signal: createSignal, connect, buildId });
  client.connect();
  // socket drops → reconnectAt renders the countdown → and now the client actually dials again
  client.close();   // …and this is how you make it stop
  ```

- **A live gate that could not decide reported "denied". Rows left the screen and nothing paged anyone.** `visibleWithPolicy` in `@ultimat3/realtime` wrapped its `guard` call in `catch { return false }`, so a rule whose repo lookup timed out, a predicate with a typo in it and a genuine policy denial were one answer. The subscriber's rows were dropped, `live.rows_denied` counted the drop — the metric that exists precisely so a drop is never invisible — and the node published a database outage as a permission change. `reauthorize` had the mirror-image bug: any throw from `authorize` **destroyed** the subscription, so one pool timeout during a login told the client it may no longer see a query it is still entitled to, and a client does not resubscribe to a denial.

  A denial is now the only thing read as one. `guard` throws `QueryDeniedError` for a decision and nothing else, so the row gate matches that class and rethrows everything else; the registry's gates ask `isPolicyDenial(error)`, because `LiveQueryDefinition.authorize` and `.visible` are caller-supplied functions and the question has to be asked of the error's code (`X_FORBIDDEN`, `X_UNAUTHENTICATED`) rather than of a class this package could import. What each surface then costs:

  | Where | Denial | Failure |
  |---|---|---|
  | `subscribe` snapshot | row dropped, `rowsDenied` + 1 | raises out of `subscribe` — a snapshot missing the rows nobody could decide about is a short result set the client renders as the whole one |
  | `deliver` patch | row dropped, or a `delete` if the subscriber holds it | that **one** subscriber is marked desynced and re-snapshotted on the next flush; the fanout to everyone else completes |
  | `reauthorize` | unsubscribed, sid returned in `dropped` | subscription **survives**, desynced — the row gate still decides every row under the new actor, from the same policy `authorize` consults |

  A third answer joins them, and it is neither: **a patch whose row the shared window does not hold is withheld.** An update patch carries the changed columns plus the id — never the whole row — so merging it onto nothing and calling the result a row hands `visible` an `undefined` for every column the change did not touch. That fails closed for `row.ownerId === actor.id` and leaks for every `!row.private`. The window *is* the result set, so a row it does not hold is one this subscriber may not keep: the patch is dropped, or converted to the one `delete` that tells a subscriber holding it so. Nothing decided anything, so it counts as neither `rowsDenied` nor `gateFailures`. The single path that could have met an empty window — a delta resume onto an entry nothing has read yet — fills the window first, and only then, so a restart storm resuming onto live entries still pays nothing.

  `LiveQueryRegistry` gains a second counter, `gateFailures` (`live.gate_failed`), and an `onGateFailed` callback carrying the qid, sid, actor, stage (`authorize` | `snapshot` | `patch`), row id and the error unwrapped. It is deliberately not folded into `onRowDenied`: an alert fires on one of them and a dashboard that summed them would show a permission change. `reauthorize` still returns the dropped sids and they are now denials only, so a caller may tell the client "you may no longer see this" and be right. The per-subscriber pass moved to `packages/realtime/src/subscriber-gate.ts`; `policy-gate.ts` remains the package's only authz seam.

- **Two changes off the bus raced each other through one live query, and the loser's patch landed last.** Nothing ordered `deliver`: the `sync` node fires `void registry.deliver(change)` from its bus subscription — it has to, the handler must return before the next change arrives — while `deliver` itself mutated the shared window and then awaited a policy pass per subscriber. Two changes back to back both started. A subscriber whose gate answered quickly for the second change was handed lsn 2 and then asked to fold lsn 1 on top of it: the row settled at the *older* value and stayed there, and its cursor was rewound to lsn 1, so the next reconnect replayed the same patch again. Nothing logged it. On top of that, every cold subscribe re-read the query and wrote the result straight over the shared window — N subscribers on one query id were N reads, and a read that resolved after a change had already been fanned out silently rewound the window to rows the fanout had moved past.

  Each query id now has one FIFO lane (`packages/realtime/src/window-lock.ts`) and every fanout takes its turn in it. Across query ids nothing is ordered and nothing needs to be — a qid pins the query *and* its input. `deliver` *enters* every lane before it awaits any of them, and no fanout ever takes a second lane, so holding all of them at once cannot be a cycle — and two deliveries queue onto each query id in call order, which is what makes "serialized per query id, not per node" a claim rather than a hope. Each task chains on a settled shadow of the one before it, so a fanout that threw rejects its own caller and not the changes queued behind it.

  A lane that fails costs one query id and no more. `deliver` awaits the lanes with `allSettled`, so one rejection neither cancels the others nor goes unhandled: every other query id still sees the change, the failed entry's own subscribers are marked desynced — the window advanced under a fanout that did not finish, so they hold a cursor below the change and no later flush would have corrected them — and the first failure still reaches the caller. Awaiting one entry before entering the next was two bugs in one line: one slow policy pass set the whole node's pace, and a throw ended the loop, so every entry behind it silently missed the change with nobody desynced. That is the divergence `markDesynced` exists to prevent.

  The read is now once per entry: a cold subscriber arriving while another's read is in flight joins it and runs its own policy pass over the result — the read is shared, the authz is not. It stays a share and not a cache, cleared as it settles, so a subscriber arriving later still reads current rows. Its result is assigned in the lane and only ever forwards; a snapshot that resolved behind the fanout is discarded and its caller served from the newer window, because writing it back hands that subscriber stale rows at a cursor behind the change that would have corrected them.

  The `sync` node's fire-and-forget call site is guarded too: a fanout that fails now logs `live.deliver failed` and is reported, where before it was an unhandled rejection — the one outage whose only symptom is a dead process.

- **A typo in a live query's name told the client to rebuild itself, and the shared window was compiled twice.** Two defects on one path, both of them a second thing pretending to be the first.

  `subscribe` answered a name it had never registered with `X_PROTOCOL_VERSION` — *"client and sync node disagree on the wire protocol"*, fix `x build && redeploy the client`. The frame had parsed and the version had matched; one string in it named nothing. So the instruction was the only one that cannot work: a rebuilt client spells the typo the same way, and the registry that would have shown the mismatch never gets opened. `X_LIVE_QUERY_UNKNOWN` is new, its fix is `x queries list --json`, and it is a client fault — an unknown name never pages anyone. The name the client sent is echoed back and the registry is not: a socket walking `a`…`zz` is not entitled to a list of every read the app declares.

  ```text
  X_PROTOCOL_VERSION  no live query registered as "liveFed" — client and server manifests differ
    fix: x build && redeploy the client            # before — rebuilds the same typo

  X_LIVE_QUERY_UNKNOWN  no live query is registered as "liveFed" on this node — subscribe under
                        a name the registry prints, or pass the query to defineApi({ queries })
    fix: x queries list --json                     # after — a command, and only a command
  ```

  Underneath it, `liveQueryDefinition` built the same `(query, input)` twice per query id: once through `target.live()` for the shape, the dependency set and the matcher, and once more through a subject-less `sourceFor` because `LiveQuery` described the read but could not run it. Two parses, two `sql()` calls, and — the part that is not merely waste — two descriptions of one read that agreed only by luck. Where a declaration's `sql()` is not a pure function of its input, the subscriber was served the *second* build's rows while the matcher patching them belonged to the first. `LiveQuery` gains `execute()`, the source it was already built from, run; the shared window reads through it, and one build now serves both halves.

- **A replicator whose stream ended kept reporting itself live, and a drained `sync` node kept consuming the bus.** Two leaks of the same shape in `@ultimat3/realtime`: the thing that stopped never released what it held.

  `PgReplicationStream`'s pump had two exits and neither finished the job. On a throw it recorded `stats().failure` and cleared the confirm timer, but left `#connection` set and its socket open — so the next `start()` overwrote the field and orphaned a walsender connection holding the slot `active`. On a *clean* exit — `nextCopyData()` returning `undefined`, which is the walsender ending the copy, a dropped slot or a server shutting down — it returned from the loop and touched nothing at all: `#running` stayed `true`, so `failure` stayed `null` for a loop that reads no WAL, `/readyz` answered ready, `start()` was a silent no-op, and the confirm timer went on telling the walsender a dead stream was keeping up. Both exits now run one teardown (`#die`) that records the failure, stops the timer, and closes and drops the connection; a `start()` that goes live clears the previous death, and `stop()` waits for a pump that is still going down rather than reporting a released slot to the supervisor about to start the next process.

  Two more ways the same slot leaked, both closed here. **A restart waits for the previous pump's terminal cleanup, because `#pump` *is* that cleanup** — `#drain` awaits `#die` and `#die` awaits `connection.close()`, but `#die` clears `#running` and nulls `#connection` *before* that close settles, so a `start()` that only checked `#running` dialled into a slot the dead walsender still owned and replaced `#pump` with its own; the next `stop()` then awaited only the new pump and reported a slot that was still `active`. `start()` now takes the old pump and awaits it before it dials anything, and its failure path swallows `stop()`'s own failure on purpose: the boot diagnosis is the one an operator can act on, and a teardown that also failed must not replace it. **And a `stop()` releases everything before it reports anything** — a `#confirm` or an `endCopy` that threw used to skip the close and the pump await entirely, so the socket leaked and the failure reached a supervisor that was already starting the next process. Every step now runs whatever the step before it did, and the first failure is rethrown only once the connection is closed and the pump has ended.

  `createSyncNode`'s `drain()` closes the hub and evicts every socket — it is terminal — but released neither the change-bus subscription nor the presence sweep interval; only `stop()` did, and `stop()` is not required to follow. A drained node went on pulling every change off the bus into a fanout with no sockets left, and sweeping presence for a fleet it had already left, through a hub `drain()` had closed. Both are now released by whichever of the two runs first, and running it twice is a no-op — `listenSyncNode` calls both, in that order.

- **Docs: a read's cache key does not include the actor, and six pages said it did.** "Cache keys always include the actor's tenant and policy scope, so a cache hit can never leak across tenants" was a guarantee an app could have designed around. `cacheKeyFor` in `@ultimat3/query` is `query:<name>:<parsed-input fingerprint>:<sorted tag keys>` and has never carried the actor. The rule that actually holds: the tenant reaches the key through the read's **input**, so `feed({ orgId })` is one entry per org, and a `cache:` read whose answer varies by actor for one input must not declare `cache:` — tier 1, the request memo, is keyed by `Ctx` identity and already separates it. Policy still runs on every read before a tier is consulted; it decides whether *this* caller may ask, not which rows the entry holds. Corrected in `wiki/Caching-And-Invalidation.md`, `wiki/Queries-And-Live-Queries.md`, `wiki/Entities-And-Migrations.md`, `docs/architecture/01-package-map.md`, `03-request-lifecycle.md` and `06-data-layer.md`; `docs/idea/05-caching.md` keeps the scoped key as the design intent and now names the gap rather than claiming it shipped. No code changed.

- **MCP exposure has one answer, `isMcpExposed`, and the contract stops publishing tools nothing serves.** Six readers across five packages decided `mcp: { expose }` three ways: `=== true` where a tool is actually built (`@ultimat3/action`'s `toMcpTools`, `@ultimat3/query`'s, `@ultimat3/mcp`'s two projections), `!== false` in the OpenAPI operation's `x-ultimate.mcpTool`, and `?? true` in `describeAction`'s manifest fact. So an action with **no `mcp` block at all** was published as a tool by `x.manifest.json` and by `openapi.json`, and refused by every surface an agent could call — and the first honest `mcp: { expose: false }` an author wrote then read as a *withdrawn* capability, which `x verify`'s contract diff classifies as breaking and demands a major version bump for.

  `isMcpExposed(declared)` in `@ultimat3/core` is now the single predicate. Core owns it because the readers span tiers 3–5 and this is the only tier all of them reach — the same reason `timingSafeEqual` lives there. Opt-in is unchanged and unchanged everywhere: an absent block, an omitted `expose` and a literal `false` are one answer.

  ```jsonc
  // an action declaring no mcp block, in openapi.json
  "x-ultimate": { "mcpTool": "publish_post" }   // before — a tool no catalog listed
  "x-ultimate": { "mcpTool": null }             // after
  ```

  `diffManifest` reads both sides through the same predicate, so a manifest parsed off disk whose `mcp.expose` is absent or non-boolean reads as un-exposed rather than as a third state. **Upgrading:** run `x manifest` once — an app whose actions never declared `mcp.expose` will see those facts flip `true → false`, which is the correction, not a withdrawal; re-commit the regenerated file before the next `x verify`.

  `@ultimat3/admin`'s own catalog keeps the opposite default on purpose and says so in code: every tool there is already gated on an admin permission and its CRUD tools carry no `mcp` block at all, so opt-in would list `admin.posts.delete` while hiding the action button beside it. That exception is the only one, and `packages/cli/src/mcp-exposure-pin.test.ts` pins every other reader to one answer.

- **`query.client()` now reaches a route. Reads are served over HTTP, in `x dev` and in a container alike.** `@ultimat3/query` derived `/_x/query/<kebab>` in `naming.ts`, `client.ts` fetched exactly that URL, and nothing anywhere built or mounted a route for it — so every typed read compiled, shipped, and 404'd, while the README and the wiki documented the projection as shipped.

  `toQueryRoute(target)` in `packages/query/src/http.ts` is that projection, mirroring `@ultimat3/action`'s `toRoute`:

  ```ts
  GET /_x/query/live-feed?orgId=…   // the URL liveFeed.client({ baseUrl }) already derived
  ```

  Three decisions it makes, each for a reason a read has and a write does not. The search string is **coerced** at the boundary (`@ultimat3/schema`'s `coerceQuery`, the one HTTP-boundary decoder) and **validated** by `runQuery` — one parser, so a bad `orgId` is the read's own `X_INPUT_INVALID` with the line that prints its schema, never the pipeline's `X_BODY_INVALID`. `meta.input` is therefore absent: the pipeline validates it against a *body*, and a GET has none. The answer is `no-store` — the URL names no actor while the rows are scoped to one — and `enforcedBy: 'handler'`, because `runQuery` is the read's one policy evaluation and it holds the parsed input; an authz stage deciding first would be a second authz system deciding from raw strings.

  `@ultimat3/cli`'s new `apiRoutes()` is what mounts it, and it is now the **one** composition of the app's HTTP API — both `x dev` and `serve.ts` mount it, so a read cannot answer in one and 404 in the other. `@ultimat3/query` gains a dependency on `@ultimat3/http` (tier 3 → tier 2, downward).

- **`useLiveFeed({ orgId })` exists. The typed client hook the wiki has always documented is a projection you can bind.** [Queries and live queries](https://github.com/developerz-ai/ultimate/wiki/Queries-And-Live-Queries) listed a typed client hook among a query's five projections and showed exactly that line; no `useLiveFeed`, `useQuery` or `createLiveQuery` existed in any package. What shipped was `useLive(query, input)` — untyped on both sides, because its `query` parameter is anything carrying a `name`, so neither the input nor the row type could come off the declaration.

  `liveHookFor` (`@ultimat3/realtime`) is the missing projection: one declared `query({ live: true })` bound to one named hook, in one line, with no generated file.

  ```ts
  export const useLiveFeed = liveHookFor(liveFeed);  // app/feed/hooks.ts

  const feed = useLiveFeed({ orgId: actor.orgId });  // feed()[0].title typechecks
  useLiveFeed({ orgIdd: actor.orgId });              // does not compile
  ```

  It **binds** `useLive` rather than re-implementing it — one subscribe path, given the query's name and types, because two of those is two places a subscription can be opened wrong. `LiveQuerySource` names `Query`'s shape structurally instead of importing `@ultimat3/query` as a value: a hook is browser code, and a value import would carry the server's read path into the bundle. The name is read **per call**, never captured at bind time, because a module-level binding runs at import and `registerQueries()` stamps the name at boot — later. Binding a query with no `live: true` is the new `X_QUERY_NOT_SUBSCRIBABLE`, thrown where the binding is written rather than at the first render: a read that never patches has no subscription for a hook to hold, and the non-live read from a component is `query.client({ baseUrl })` over the route above. `LiveRows`'s row parameter widens from the wire's `Row` to `object` so a query's own row type survives; the four type claims are pinned in `packages/realtime/src/type-pins.ts`, which `tsc` checks and a `.test.ts` could not.

- **`X_INPUT_INVALID` is a 400 over HTTP, not a 500.** The code had no row in `error-map.ts`, so it took the 500 default on every surface that throws it — an action route and now a query read alike. A caller's typo'd uuid was answered as a server fault *and* reported to the error monitor by the `error-map` stage, which pages the on-call for someone else's mistake. 400 is also what the published OpenAPI operation has always promised for it.

- **`LruCache.clear()` now resets `hits`/`misses`/`evictions` along with entries and bytes.** `stats()` after a `clear()` used to keep reporting whatever the cache had accumulated before the clear — a fresh cache with stale lifetime counters. `clear()` is a reset, and `stats()` now reads as one.

- **A drain that times out no longer leaks its waiter.** `waitForIdle()` pushed a closure onto `idleWaiters` and relied on the eventual `beginWork()` completion to remove it; a drain that gave up at the deadline resolved its own promise but left that closure in the array forever, to be invoked (harmlessly, but pointlessly) whenever in-flight work eventually finished. The timeout branch now removes its own waiter. `@ultimat3/core` exports a test-only `idleWaiterCount()` so this stays provable.

- **A storage disk's `get()`/`list()` now return the `cacheControl`/`metadata` a `put()` wrote.** `StorageObject` gained optional `cacheControl`/`metadata` fields, and the local driver's sidecar parser — which validated only `contentType`/`etag` — now preserves both, closing the round trip `packages/storage/CLAUDE.md` already promised ("`get` must round-trip exactly what `put` was handed"). The s3 driver's `list()` still reports `DEFAULT_CONTENT_TYPE` for every entry; that one is commented, not fixed — ListObjectsV2 does not return Content-Type, and reading it for real would cost one HeadObject per listed row.

- **`HttpServer.stop()` no longer leaves its shutdown hooks registered when `drain()` throws.** `unregister()`/`unregisterClose()` ran after `await drain('manual')`, so a rejecting drain skipped both — the next drain in this process would still find and re-run this handle's hooks against a server that already tore down. Both now run in a `finally`.

- **Nine call sites across `entity` and `db` read the ambient wall clock instead of `@ultimat3/core`'s `Clock`.** Column defaults, `onUpdate` stamps, soft-delete writes, and three `now?: Date` fallbacks called `new Date()` directly, in violation of the framework's "only `clock.ts` calls `new Date()`" rule. All now read `systemClock.now()` — a behavior-preserving substitution, not a new injection seam; `now?: Date` overrides are unchanged.

- **A row with a money column can be returned from an action again — `Money` is one declaration, and its `minor` is a `number` everywhere.** The framework carried three structural restatements of one shape: `Money` in `@ultimat3/money`, `MoneyValue` in `@ultimat3/schema`, and a third in `@ultimat3/entity` whose `minor` was a `bigint`. The third was not a stylistic difference. `JSON.stringify` throws on a bigint, so returning a decoded row from an `action`, a `query`, a job payload or an MCP tool result **crashed the response**; `t.money` — the node that becomes the OpenAPI contract — rejected the row this framework's own driver produced; and `@ultimat3/realtime` normalised the *same column* to a `number`, so two readers of one column disagreed about what it held.

  `number` is the decision, and it is the one every other surface already made: `@ultimat3/money`'s whole arithmetic, allocation and `Intl` surface, `t.money`'s IR, `@ultimat3/ai`'s budgets, `@ultimat3/ui`'s `<Money>`, `@ultimat3/admin`'s widgets, the `x new` scaffold and this repo's own root convention. `@ultimat3/schema` (tier 0 — the only tier every package may import) now owns the single declaration; `Money` and `entity`'s `MoneyValue` are **aliases** of it, so a row a `money()` column decodes *is* a `Money` and goes to `add()`, `formatMoney()` or `<Money>` with no cast.

  What the wide column bought is kept, honestly. `<name>_minor` is still `bigint`, and a stored value past ±2^53 — written by a psql session, a backfill, another service — is now **refused where it is read** (`X_INVARIANT_VIOLATED`, naming the value it could not carry) rather than rounded into the row or carried as a bigint that crashes three layers later. That is the same refusal `@ultimat3/realtime` already made, so the two readers agree.

  Additive on the write side: `MoneyInput` still takes a `bigint | number`, so a minor unit read straight off a `bigint` column reaches an insert with no conversion at the call site. `narrowMoney` is called by **both** drivers — `bindValues` before a statement, `memoryRepo`'s `write` before it stores — so a row's money never depends on which driver produced it; previously the in-memory driver stored the caller's bigint verbatim and produced the one row in the framework `JSON.stringify` refused.

  `Money.minor` and `Money.currency` are now `readonly`, which the type's own documentation had asked for and nothing enforced. Type-only, and pinned in `packages/entity/src/type-pins.ts`: re-declaring the alias, widening `minor` back to a `bigint`, or dropping either `readonly` is a build error rather than a review comment.

- **A rotating-address scan can no longer grow a rate limiter until the process dies.** Both in-memory limiters keyed a `Map` by the connection address and never removed an entry: `@ultimat3/http`'s `memoryRateLimitStore` only deleted on an explicit `reset(key)`, and `@ultimat3/auth`'s `createAuthLimiter` only on a successful login. A scan walking an IPv6 /64 mints a fresh key per request against both, so the table grew for as long as the scan ran — the throttle that exists to survive a flood was the thing the flood consumed. Neither had a sweep, and neither had a cap.

  Both now hold one rule: **an entry that answers exactly as a missing one is forgotten, not evicted.** Each entry carries the instant it reaches that state — a token bucket back at capacity, or an auth key whose failure window has emptied *and* whose lockout has expired — and a sweep drops everything past it. That alone flattens a scan: a one-request bucket on the default route refills in half a second.

  The cap is the backstop for what the sweep cannot claim, and it decides *which* live entry goes with the same care, because getting that backwards is a rate-limit bypass. The entries nearest to being forgotten anyway go first, so the most-throttled key is the last to go — and in `@ultimat3/auth` a live lockout outranks its own deadline, so filling the table is not a way to buy back attempts against the account you just locked:

  ```ts
  memoryRateLimitStore({ maxKeys: 20_000 });                      // DEFAULT_MAX_RATE_LIMIT_KEYS
  createAuthLimiter(clock, { ...DEFAULT_AUTH_RATE_LIMIT, maxKeys: 10_000 });
  ```

  Defaults are `DEFAULT_MAX_RATE_LIMIT_KEYS` (20,000 — an http key is `route|subject`, so one subject throttled on N routes is N entries) and `DEFAULT_MAX_AUTH_LIMIT_KEYS` (10,000 — an auth key is one identity). A few megabytes, held, instead of an unbounded map. Both are also observable now: `memoryRateLimitStore()` and `createAuthLimiter()` return their interface plus a `size`, so the bound is something a test can assert rather than something a comment claims. Sweeping is amortized — a sort is paid once per 10% of the cap, never per request — and a key that is dropped throttles again from a clean bucket, never a half-written one. Nothing about the decisions themselves changed: same buckets, same window, same lockout, same headers.

- **`{constructor}` in a translated string no longer renders a function's source into the page.** `interpolate` read a variable as `vars?.[name]`, an ordinary property access, so every member of `Object.prototype` was a variable a catalog could reach: `{constructor}` rendered `function Object() { [native code] }`, `{toString}`, `{valueOf}` and `{hasOwnProperty}` rendered their own source, and `{__proto__}` rendered `[object Object]` — all through the path that is supposed to render `⟦name⟧` for anything the caller did not pass. Only an **own** property is a variable now, which is the guard `catalog.ts` already applies from the other side by nesting keys into null-prototype nodes. A caller that genuinely passes `{ toString: 'ok' }` still gets `ok`.

  The same function's fast path returned early on a template with no `{`, which skipped `}}` un-escaping — so one escape had two meanings: `'{{a}}b'` collapsed to `'{a}b'` while `'a}}b'` came back untouched. It now tests both braces.

- **One bad date no longer takes the whole feed down.** `buildFeed` parsed item timestamps straight into `new Date(...).toISOString()`, so a `published` that would not parse — a CMS column holding prose, a hand-typed front-matter line — reached `toISOString()` as `NaN` and threw a bare `RangeError` out of the feed route. The same line spread its work into `Math.max(...times)`, one argument per item, so a feed that grew past the engine's argument limit crashed in proportion to how well the blog did; and the empty-feed branch called `Date.now()` directly, the one clock read in the package no test could freeze.

  All three are gone. `feed-dates.ts` is now the only place a feed timestamp is parsed or formatted, `buildFeed` resolves every date once, and the three builders only ever see instants:

  ```ts
  const feed = buildFeed(channel, [{ ...post, published: 'sometime last spring' }]);
  // renders: the item keeps its title, link and guid — only the date is missing
  ```

  A date that will not parse is treated as **absent**, never invented: RSS drops that item's `<pubDate>`, Atom drops its `<published>`, JSON Feed drops `date_published`, and Atom's *required* `<updated>` falls back to the feed's own instant, which is always real. An unparseable date sorts last instead of turning the comparator into `NaN` and handing the feed's order to the engine's sort. An unparseable `channel.updated` falls back to the newest item rather than poisoning `lastBuildDate`. Every timestamp the three formats emit is now normalised to UTC from one instant, so an offset-bearing input means the same moment in all three.

  "Now" is a seam: `buildFeed(channel, items, { clock })` takes a `Clock` — `frozenClock(at)` makes a feed with no usable dates byte-for-byte reproducible — and defaults to `systemClock`.

- **`Pipeline.handle()` keeps its one promise: a Response, always.** The lifecycle absorbed a throw from every stage that runs *before* the response exists, and then ran the two that finish it — `cache-headers` and `response` — in a bare loop outside that guard. A stage refusing the response it was handed (headers that cannot be set, on a `Response.redirect` or anything else a handler returned) rejected `handle()` against the contract written on it, and the caller got whatever the runtime prints instead of a document naming the defect. The recover stage had the same hole from the other side: it is the single place a throw becomes a status, so an app's `onError` sink or a `devNotices` producer throwing inside it left nothing to render its own throw.

  Both are now guarded in `finalize.ts`, and a refusal degrades to the new **`X_PIPELINE_FINALIZE_FAILED`** — 500, with the stage name and the underlying message in `cause`:

  ```json
  { "code": "X_PIPELINE_FINALIZE_FAILED",
    "cause": "the \"response\" stage threw while finishing the response: immutable headers" }
  ```

  The degraded answer is finished, not shipped bare: the finalize chain runs a second time over the problem document, whose headers *are* writable, so `x-request-id`, CORS and the security headers still reach the client that has to report this. A second failure keeps its 500 and stops — two passes, never a loop. The failure travels through the recover stage rather than around it, so it is reported, logged and rendered by this package's one call site for each, and `x dev` still shows it in the overlay. A request the stages *can* finish is byte for byte what it was.

- **A mis-encoded path is a 400, not a 500 and a page for the on-call.** `decodeURIComponent('%ZZ')` throws a bare `URIError`, and the router called it unguarded on every `:param` and `*wildcard` segment it walked past. A client typo — a lone `%`, a truncated `%A`, a value concatenated into a URL instead of run through `encodeURIComponent` — escaped `matchRoute` as an uncoded throw, so the pipeline mapped it to `X_INTERNAL`, answered **500**, and reported it to the error monitor (`error-map` pages on `status >= 500`). The caller was told nothing about a request only the caller could fix.

  `matchRoute` now answers with the fourth `MatchResult` variant instead of throwing, and the pipeline turns it into the new **`X_PATH_INVALID`** — 400, with the offending segment in `cause` and `encodeURIComponent` in `fix`:

  ```ts
  const match = matchRoute(table, 'GET', '/posts/%ZZ');
  // { ok: false, reason: 'path-invalid', segment: '%ZZ' }
  ```

  Only the branch that would have decoded can fail: static segments are compared raw, so a path that reaches no param or wildcard is the 404 it always was, a static route still wins the precedence it always won, and a sibling that does match still wins over one that could not decode. `X_PATH_INVALID` is registered in `HTTP_ERROR_TITLES` and mapped to 400 in `ERROR_STATUS`; `pathInvalid()` is exported for a host that matches routes itself.

- **`verifySignedUrl` keeps its promise never to throw.** `parseConstraints` decoded each key segment with a bare `decodeURIComponent`, so a signed URL whose path carried `%ZZ` raised a `URIError` out of a function whose header says verification never throws — an uncoded 500 on the storage read path, for a URL this package would never have minted (`buildSignedUrl` percent-encodes every segment). A segment that will not decode is now `'malformed'`, already a `SIGNED_URL_FAILURES` member, and it is refused before the signature is computed. Nothing is loosened: the reason is the same one an off-base URL gets, and it leaks nothing about the secret.

- **A cache tier that refuses no longer fails the read it was supposed to speed up.** `createCacheStack` walked the ladder with every tier call unguarded, so a tier throwing anywhere on the value path threw straight out of `read()` — the caller saw a failed business read where the source had already answered correctly. The common one needs no outage to reproduce: `LruCache.set` raises `X_CACHE_TOO_LARGE` for any entry over the tier's whole byte budget, so a page that grew past `maxBytes` stopped *loading* rather than stopping *caching*. A `get` was the same shape — a Redis with no socket failed every read that walked past it, including ones the memo or the LRU would have answered.

  Every `get`/`set`/`del` the stack makes now goes through `bestEffort()`, which reads a refusal as "that tier did not answer": the walk continues, later tiers are still populated, `write` and `drop` still reach the tiers behind the refusing one, and the value still comes back.

  ```ts
  const hit = await bestEffort(tier.name, 'get', key, () => tier.get<T>(key));
  if (hit === undefined) continue;                  // a miss and a refusal read the same here
  ...
  const value = await load();                       // the one call still left to throw
  ```

  `load()` stays unguarded on purpose — it *is* the business read, and absorbing it would hand back `undefined` as though it were the value. Silence is the other half of the bug, so the absorbed refusals are readable: **`recentTierFailures()`** returns the last 100, newest first, each carrying the tier, the operation, the key, the message and the `X_*` code when there is one, and each one is logged as `cache.tier.failed`. That is `report.errors` applied to the path that has no report to return, and `resetTiers()` clears it alongside the invalidation log. `LruCache.set` is unchanged and still throws for a direct caller: the stack is the layer that degrades, not the tier.

- **Two identical reads in one request are one read, even when they race.** The request memo behind a cached `query` stored the *value*, and stored it only after the read had settled — so two holes rendering concurrently both missed the memo, both asked the cache tier, and both executed the source. The memo now holds the read **in flight**, published before `readThrough`'s first await: the second reader joins the first instead of starting a competing one, and five concurrent readers cost one execution and one tier round trip.

  ```ts
  const memo = requestMemo(ctx);          // Map<string, Promise<unknown>> — was Map<string, unknown>
  const joined = memo.get(key);
  if (joined !== undefined) return (await joined) as T;
  ```

  A promise is never `undefined`, so the same change fixes a second defect for free: a read that legitimately resolves `undefined` now memoizes, where a value-keyed map read it back as a miss on every subsequent call. A rejection is evicted rather than memoized — a failed read is not the request's answer, so the next read in the same request retries instead of replaying one failure until the request ends. `requestMemo()` is exported, and its entries are now promises; nothing in the framework reads them but `readThrough`.

- **A query with no `cache:` block is memoized per request too.** The memo only ever ran for a query that declared `cache:` — `readRows` returned straight from the source on the `fresh || def.cache === undefined` branch, without so much as looking at `requestMemo`. So the reads that most need deduplicating were the ones that never got it: an uncached lookup called once per row of a list cost one round trip per row, and the request memo, the thing that exists to collapse exactly that, sat unused beside it.

  The memo is now what every read goes through, and the tier is the half a query opts into:

  ```ts
  if (options.fresh === true) return (await read()) as readonly TRow[];   // no cache may answer
  const key = cacheKeyFor(name, raw, def.cache?.tags ?? []);
  return (def.cache === undefined
    ? await readOnce(ctx, key, read)                                      // memo only
    : await readThrough(ctx, key, def.cache.ttlMs ?? null, read)          // memo, then the tier
  ) as readonly TRow[];
  ```

  `readOnce(ctx, key, run)` is the single-flight half of `readThrough`, split out and exported; `readThrough` is now `readOnce` plus the tier fill and nothing else, so there is one place a key is joined and one place it is stored. What the memo holds is the **execution**, never the decision: `readRows` parses the input, evaluates the policy and calls `sql()` before it reaches the memo on every call, and `.as()` reads in a child context whose identity is its own memo — so a memoized answer is still one that actor was allowed to ask for, and an impersonated read can never join one made as someone else.

  `fresh: true` now skips the memo as well as the tiers, a memo being a cache whose lifetime is the request. That makes it the one way to read past a write made earlier in the same request: an action's `invalidates` drops tier entries, not memo entries. It skips the memo on the way *in* and publishes to it on the way *out* — `readFresh` is `readOnce` minus the join, both sharing one publish step — so the read it just made is the request's answer from then on. Returning the rows early instead would leave the pre-write entry standing and end the guarantee at the one call that asked for it, handing the next plain read of that key the answer the write had already moved past.

- **A read filtered on NULL matched every row in memory and no row in the database.** `@ultimat3/query`'s source emitted `"col" = $n` whatever the value was, and `= $n` with a NULL argument is *unknown* in Postgres, never true — so `where({ deletedAt: null })` selected every live row from `from()` and nothing at all from a driver. The keyset predicate had the same defect one page later: `"publishedAt" > $n` is unknown for every draft, so page two stopped at the first NULL and the rows behind it could not be reached through a cursor at all.

  NULL now means one thing across the SQL, the in-memory execution and the live matcher, and `null` and a column the row omits are the same absence:

  | Operator | NULL is | Emitted as |
  |---|---|---|
  | `=` `!=` `in` | a value — it matches itself and nothing else | `is null` · `is not null` · `is distinct from` · `in (…) or is null` |
  | `>` `>=` `<` `<=` | unknown — a NULL on either side matches nothing | unchanged; `matchesFilter` now answers the same |
  | `order by`, the cursor | the largest value: last ascending, first descending | `asc nulls last` · `desc nulls first` |

  ```sql
  -- before                                    -- after
  where "deletedAt" = $1                       where "deletedAt" is null
  order by "publishedAt" asc                   order by "publishedAt" asc nulls last
  ("publishedAt" > $1)                         (("publishedAt" > $1 or "publishedAt" is null))
  ```

  Two behaviour changes ride along, both making the memory path answer what Postgres answers: an ordering operator against a NULL no longer compares the string `"null"` (a null `score` used to sort past `5` and land in a `score > 5` feed), and `compareValues` sorts NULL after every value instead of between `"m"` and `"o"`, which is what `compareRows`, `isAfterKey` and the live matcher's insertion position all read. `!=` compiles to `is distinct from`, the pair `@ultimat3/entity`'s `predicateSql` already emitted. An empty `in` list is `1 = 0` rather than `in ()`, which Postgres refuses outright — and so is an `in` handed something that is not a list at all, which used to fall through to `"col" in $1`: a syntax error from the driver where `matchesFilter` had quietly answered no rows. `isNull` is exported beside `isAfterKey`, for the same reason: a custom `SqlSource` has to agree on what NULL is rather than re-decide it.

  A generated `order by` now carries `nulls last`/`nulls first` explicitly. It is Postgres' own default — no plan changes, and `asc nulls last` is still the default btree order — but an assertion on exact SQL text needs updating.

- **The live matcher places a new row where the database would put it.** A page is served `order by <declared keys>, "id" asc` and `isAfterKey` reads the next one the same way, but the incremental matcher compared the declared keys alone — so a row tied on every one of them was appended after the whole tie group rather than placed by its id. The client rendered an order no re-read agrees with, and the cursor cut from that window's tail skipped every tie the matcher had pushed past it.

  `totalOrder(orderBy)` is now the one definition of that list — the declared keys, then `id asc` unless the ordering already names `id` — and `positionFor`, `Builder.seek()` and the in-memory sort all read it:

  ```ts
  // window [b(t=10), c(t=10)], insert a(t=10)
  positionFor(shape, window, a);   // 0, was 2 — the database returns a, b, c
  ```

  A row with no `id` is now `X_QUERY_NOT_PAGEABLE` at the matcher, as it already was at `seekKeyOf`: `String(undefined)` is `"undefined"`, an id every id-less row shares, so one row's patch landed on another's position and a `remove` named a row no client held. An unordered query still appends — SQL promises no position there to get wrong. `totalOrder` is exported for the reason `isNull` and `isAfterKey` are: a custom `SqlSource` has to serve the order the cursor assumes rather than re-decide it.

  **And the live window is now served in that order too.** Placing the patch by `totalOrder` fixed two of the three readers and left the third: the initial window came from the query's own `sql()` unpaged, so it arrived ordered by the declared keys alone and a tied row sat wherever the database returned it — the matcher then inserted by id into a list that was not sorted by id, and the resume `seek()` read the next page as though it had been. `SqlSource` gains an optional `total()` — the same read, no cursor and no window, ordered `<declared keys>, "id" asc` — and `sourceFor` calls it for `surface: 'live'` and nothing else:

  ```sql
  -- a live feed's window, before          -- after
  order by "createdAt" asc nulls last      order by "createdAt" asc nulls last, "id" asc nulls last
  ```

  `Builder.total()` implements it (`seek()` already implied it, and the private `pageOrder()` is now `servedOrder()` because a live window is not a page). A source that does not implement `total()` is untouched, as is every non-live read: a plain `from()` over rows with no `id` still generates exactly the SQL it was asked for. An assertion on a live query's `sqlText` needs updating.

- **A `BEGIN` that fails no longer leaks the connection it was going to run on.** `withTransaction` reserved a connection, ran `BEGIN` *above* its `try`, and released the pin in the block's `finally` — so the one statement that opens the transaction was the one statement not covered by the guard that closes it. A `BEGIN` that rejected (a connection killed mid-pool, a server in recovery, `statement_timeout` on a hung `SET`) returned the pin to nobody: one leaked pool connection per failure on Postgres, and on PGlite the single session's turn, which every later statement in the process then waits for forever.

  The pin is now held by a `using` declaration and `BEGIN` runs inside the guarded scope — the shape `readOnlyQuery` already had, and it too is converted, so both sites read the same:

  ```ts
  using reserved = isReservable(client) ? await client.reserve() : undefined;
  try {
    await connection.execute(raw(beginStatement(options)));   // inside the guard, not above it
    ...
  }
  ```

  One visible consequence: a failed `BEGIN` now also emits a best-effort `ROLLBACK`, which the server answers with a notice — cheaper than a second exit path for the statement that opened nothing. Nothing else changes: the same statements, in the same order, on the same connection.
- **A failing `ROLLBACK TO SAVEPOINT` no longer masks the error that caused the rollback.** A nested `withTransaction` whose body threw rolled back to its savepoint *uncaught*, so when the failure was the connection itself the caller got `X_DB_UNAVAILABLE: statement failed: ROLLBACK TO SAVEPOINT x_sp_1` instead of the error the unit of work actually died of — and the `onRollback` undos never ran. It is best-effort now, matching the root's `ROLLBACK`. `SAVEPOINT` and `RELEASE SAVEPOINT` stay uncaught on purpose and are documented as such: a savepoint that was never taken means the scope never opened, and a release that failed means its work is not durable in the outer scope. Both are failures the caller has to see.
- **A released `DbConnection` is inert, and releasing it twice releases it once.** `createPostgresClient().reserve()` returned a handle whose `query`/`one`/`execute` kept issuing on the pinned connection after `release()` — but the pool had already handed that physical connection to another unit of work, so a `tx` leaked past its transaction scope wrote its row inside *their* transaction, committed or rolled back with it, with no error anywhere to explain it. The handle now runs direct **only while the pin is held**; a late statement takes its own connection out of the pool like any other caller. That is the rule `pglite.ts` already enforced with its turn queue, so the two drivers finally mean the same thing. `release()` is idempotent for the same reason it needed to be there: two owners reach it on one exit path, and the second was freeing a pin that was no longer ours.

  `DbConnection` is `Disposable` — `[Symbol.dispose]` **is** `release()`, not a second code path — so the pin can be held by a declaration instead of a hand-rolled `finally`:

  ```ts
  using connection = await client.reserve();
  await connection.execute(raw('BEGIN'));
  // released on every exit path, including the one nobody wrote a test for
  ```

  Not a breaking change: `release()` stays, with the same signature and the same semantics on the first call. An implementer of `DbConnection` outside the framework — there is no supported reason to have one — must add `[Symbol.dispose]`.
- **The migration advisory lock is held by one session, so migrators actually serialise.** `migrate()` issued `pg_advisory_lock(MIGRATION_LOCK_KEY)` on the *pool*, and `pg_advisory_lock` is scoped to a Postgres session, not to a statement: the pool lent a connection for that one statement and took the session back. Both halves of the lock then failed. The unlock ran later on whatever connection the pool lent next, answered `false`, and left the lock held until that backend died — the next `ROLE=migrate` container waited on a lock nobody would ever release. And the session actually holding it sat idle for the whole run, so the pool's idle timeout (`migrate`'s is 10s) closed it and released the lock *mid-migration*, which is the case the lock exists to prevent. `ROLE=migrate` masked the first half by accident — its pool is `max: 1`, so every statement found the same connection; no other role and no test has that.

  The lock scope now pins one connection (`using`, so it comes back on every exit path), takes the lock on it, and hands that session down — `ensureLedger`, the ledger read and every migration's `withTransaction` run on it, which is also the only thing that can work on `max: 1`. The unlock stays best-effort and now reaches the session that took the lock. `rollback()` took **no** lock at all and takes the same one, with the same `lock: false` escape hatch as `migrate()` for a private branch database.
- **PGlite's turn queue holds its turn with `using`, matching `DbConnection`.** `TurnQueue.run()` gave the turn back in a hand-rolled `finally`, the same shape `withTransaction` had before its own fix above — one exit path a future edit can still slip above. `Turn` (`pglite-turns.ts`) is now `Disposable`: `release()` and `[Symbol.dispose]` are the same call, idempotent for the same reason `DbConnection.release()` is, and `run()` holds it with `using turn = await take()` instead. `reserve()` in `pglite.ts` cannot do the same — its turn outlives the function, released later by the caller's own `release()` — so it calls `turn.release()` explicitly where it used to call `turn()` directly. Not a breaking change: both functions are package-internal, and the queue's public shape (`take()`/`run()`) is unchanged.
- **A `close()` that rejects no longer caches a dead pool.** `PostgresClient.close()` awaited the driver's teardown and *then* dropped its handle, so a teardown that threw — a connection already terminated, a socket that never drained — skipped the drop and left the corpse cached. The next `connect()` handed it straight back, every statement after that failed for a reason no caller could see, and a second `close()` could not clear it because it threw in the same place. The handle is now read and cleared **before** the await, matching `pglite.ts`: the rejection still reaches the caller — a shutdown that could not drain wants to know — but the client is empty either way, so the next statement opens a live pool. Clearing first also settles the race: a `connect()` arriving while the teardown is in flight gets a new pool rather than joining the one draining.
- **`x build --target binary` produces an executable that boots.** It compiled and then died on `ENOENT … '/$bunfs/package.json'` before any role started: a single-file executable carries no `package.json`, and `FRAMEWORK_VERSION` read one at module scope. The read is now lazy and accepts a second source — `x build` compiles the version in as `--define ULTIMATE_FRAMEWORK_VERSION="<version>"`, which is the only thing inside `/$bunfs` that can answer. A binary built any other way exits `X_INVARIANT` at the first version read, naming the flag, rather than reporting a version it does not have. `packages/core/e2e/version.e2e.test.ts` compiles a real executable and runs it, with the define and without, on every push — the gap lasted two releases because nothing ever executed the artifact. Still unproven, and still named in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps): the target end to end. Booting is not serving, and no scaffolded app has been compiled and run from a bare VM.
- **`@ultimat3/cli`'s command registry no longer reads a manifest at import.** The same eager read survived one file over: `export const CLI_VERSION = loadVersion()` sits at the module scope of `registry.ts`, and `index.ts` re-exports it — so importing the package for `runRole` alone, which is all a compiled `apps/web/server.ts` does, died on `ENOENT … '/$bunfs/package.json'` before the first role started. `cliVersion()` resolves at the call and caches, and falls back to the same `ULTIMATE_FRAMEWORK_VERSION` define `x build` already passes — the packages ship one version, one commit, one tag, so a second define would be a second version fact to hold in step, and without the fallback `x --version` inside a binary answered `X_INVARIANT` for a version the build knew. `packages/cli/e2e/registry-boot.e2e.test.ts` compiles the registry into an executable and runs it: the binary builds the whole command list, reports the defined version when the build passed one, and throws only when something asks for a version the artifact does not carry. Its last test compiles the module-scope read and asserts the binary dies before it boots — the fix and the defect are both executable, so neither can regress silently.
- `@ultimat3/cli` declares `@ultimat3/schema`, which `error-catalog.ts` has always imported — an undeclared dependency that resolved only because the workspace hoisted it.
- **`Invariant<T>.holds` is a method, not a function-typed property.** A property is checked contravariantly, so `Invariant<Post>` was not assignable to `Invariant<unknown>`, `Entity<Post, C>` did not satisfy `EntityCore`, and every `database({ posts, orgs })` call silently degraded to `Table<unknown>` — 36 cascading errors in the reference app from one position.
- Both regressions are pinned by `packages/entity/src/type-pins.ts`, which is source rather than a test: `tsconfig.json` excludes `src/**/*.test.ts`, so a type-level assertion written in a test file is never read by `tsc` and can never fail.
- `KNOWN_GAPS` in the scaffold typecheck gate is **empty**: every file `x new` and `x g` write now compiles with no diagnostic to excuse.
- **One `timingSafeEqual`, not two.** `@ultimat3/auth`'s `tokens.ts` and `@ultimat3/storage`'s `signed-url.ts` carried byte-identical constant-time string comparisons — the kind of duplication that drifts silently, since a fix to one copy's branch-free XOR loop would say nothing about the other. The implementation now lives in `@ultimat3/core` (`timingSafeEqual`), tier 0 and reachable from both; each package re-exports it so every existing `from '@ultimat3/auth'` and `from '@ultimat3/storage'` import keeps working unchanged.
- **`@ultimat3/schema`'s error codes render their real titles in every process, not just the CLI's.** `X_VALIDATION_FAILED` and `X_SCHEMA_UNSUPPORTED` were exported as data from `SCHEMA_ERROR_CODES` and registered nowhere except `@ultimat3/cli`'s `error-catalog.ts` — a process that never loads the CLI (a worker, a job runner, a plain script importing `@ultimat3/schema` on its own) rendered the humanised fallback (`X_VALIDATION_FAILED: validation failed`) instead of the authored title. `@ultimat3/core` now registers both at import time (`schema-error-codes.ts`) — every process gets them just by importing core, which is unconditional. Schema is tier 0 alongside core and cannot register its own codes or have core import it back to read them, so the titles are a deliberate, tested duplicate: `schema-error-codes-pin.test.ts` (in `@ultimat3/cli`, a package that may import both) pins core's copy equal to schema's own declarations. `error-catalog.ts`'s CLI-only registration is gone — it is now redundant with what core already does for every process.

### Known gaps

Found in this sweep, not closed. Full list in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps).

- **No test file in `packages/` is typechecked.** All 29 package `tsconfig.json`s carry
  `"exclude": ["src/**/*.test.ts"]`, so `bun run typecheck` — a `tsc -b` — reads none of them and
  the gate's `typecheck` step reports green over every one. Measured `As of 2026-08`: dropping the
  exclusion surfaces **282 errors across 110 files in 24 packages** (worst: `entity` 60, `cli` 55,
  `render` 36), overwhelmingly mechanical — `TS4111` index-signature access, `TS2345`/`TS2769`
  argument and overload mismatches, `TS2379` under `exactOptionalPropertyTypes`. `packages/*/e2e/**`
  is in no package's `include` either, so those three directories compile nowhere at all. `scripts/`
  is exempt as of this sweep: it has no such `exclude`, so its tests do typecheck. Nothing to work
  around at runtime — the tests run, they are simply not compiler-checked.
- **Live queries need `REPLICA IDENTITY FULL` and nothing sets it.** No generator emits
  `ALTER TABLE … REPLICA IDENTITY FULL`, no `x verify` step checks it, and `X_LIVE_REPLICA_IDENTITY`
  — the code `docs/architecture/07-realtime-internals.md` documented for it until this sweep —
  exists in neither the source nor the manifest. Postgres replicates only the key columns on a
  delete without it, so "did this row leave the result set" is decided from a partial row. An app
  running live queries against a real slot writes it into the migration itself, one line per table.
  Per axiom 3 this is a convention, not a rule, until a check exists.
- **`realtime.heartbeatMs` is read by nothing.** The key is declared in `RealtimeConfig`
  (`packages/core/src/config.ts:84`) with a default of 15 000 (`:205`) and no code anywhere reads
  it. The client heartbeat shipped in this release with its own `DEFAULT_HEARTBEAT_MS`, deliberately
  the same 15 000, kept equal by hand because browser code cannot read server config. Setting the
  config key changes no behaviour today; set the client's `heartbeatMs` option instead. Two honest
  closes, neither taken: delete the key so the client option is the only knob, or have the `sync`
  role size `PresenceRegistry`'s TTL from it so the server value governs the sweep the client beats
  against.

## 1.2.0

### Added

- **`/metrics` is served by every role**, on its own port (`METRICS_PORT`, default 9090) rather than the role's HTTP port — the Helm ingress routes `/` with no path exclusion, so mounting it beside `/healthz` would publish route patterns, request volumes and error rates to the internet. `worker`, `scheduler` and `replicator` open no HTTP socket at all, so a separate listener is the only thing they could ever be scraped on.
- **The three recorders are wired**, each in the package that owns the event: `recordRequest` in the HTTP pipeline's `finally` (counts a request whose finalize stage throws, which the happy path misses), `recordConnection` in `SocketRegistry.add`/`remove` (the idle sweep now routes through `remove()` — that was the one leaking path), `recordQueueDepth` at the top of the worker's `tick()`, throttled to 15s because `stats()` aggregates the whole jobs table.
- **Six tutorials** in the wiki, first app through deploying free and growing up. Every command and every pasted output was executed against the published 1.1.0 packages.
- **`wiki/Known-Gaps.md`**, plus `Observability` and `UI-Components` reference pages.

### Changed

- **The GitHub Pages site is gone.** The wiki is the single public documentation surface. `site/`, `.github/workflows/pages.yml` and the custom domain are removed, and the repo homepage points at the wiki.

### Fixed

- Metric labels use the route **pattern** (`/posts/:id`), never the concrete path, and unmatched paths collapse to one `unmatched` series — a scanner hitting `/wp-admin` and `/.env` cannot mint unbounded series.
- **Documentation that had drifted from the code.** `wiki/Theming.md` and the admin dev server both hardcoded the pre-retune palette, including the `line` value that measured 1.16:1 in dark; the admin server now derives from `colorTokens` so it cannot drift again. `ROLE=all` was documented in three places and does not exist (`X_ROLE_UNKNOWN` at boot). `x status`, `x deploy static --to`, and `x build --target docker --helm` were documented as shipped and are not. `X_MIGRATE_CONCURRENT` was described as "no advisory lock" — the lock is real (`pg_advisory_lock`), the code simply has no throw site because concurrent migrators *wait*.

### Known gaps found while writing the tutorials

Not fixed, and each one hit by actually running the command. Full list in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps).

- **`x db gen` and `x db migrate` fail in every scaffolded app** — both shell out to `bunx drizzle-kit`, which `x new` neither installs nor configures. This also breaks `bin/setup`, the scaffold's own documented first command.
- `generateMigration` mangles composite indexes; a migration `up` holding two statements cannot be applied.
- Every generated entity fails `typecheck` on its `invariant()` calls, not just the `x new` example slice.
- The Helm chart still cannot reach `/metrics`: no role declares a metrics container port and no scrape target ships, so the HPAs read `<unknown>`.

## 1.1.0

**The first release published by the workflow.** 1.0.0 was the manual bootstrap; every `@ultimat3/*` package now carries an OIDC trusted publisher for `developerz-ai/ultimate` → `release.yml`, so this version reaches npm with no `NPM_TOKEN` and provenance attached automatically.

### Added

- **`x` serves in production.** `serve.ts` boots a role without the dev watcher, `/_x` or `dev: true`. `ROLE=migrate` applies migrations through the db ledger and exits — the release phase a PaaS asks for. `x new` now writes `apps/web/server.ts`, `apps/web/prerender.ts`, a Dockerfile, a `.dockerignore` and `docker-compose.prod.yml`.
- **Metrics.** `metrics.ts` — counter, gauge and histogram on the OpenTelemetry data model, a `MetricExporter` seam, and `/metrics` in Prometheus text with no dependency. The Helm chart's `connections` and `queue_depth` are emitted verbatim; `rps` is derived from the monotonic `http_requests_total`, because a rate is not a series.
- **`Secret`.** Redacts by value — `toString`, `toJSON`, `Symbol.toPrimitive`, the inspect symbol and the logger — at any depth, under any key, frozen so a spread cannot unwrap it.
- **`resolveEnvironment()`** in core: `development | test | staging | production`, from `ULTIMATE_ENV`.
- **`renderEnvExample()`** generates `.env.example` from the typed env declaration, so the two cannot drift.
- **Page-level UI composites** — `AppShell` (with a working skip link), `PageHeader`, `Section`, `Toolbar`.
- **`defineTheme()`** — the one brand-override seam. Values are validated, never escaped; a `;` or a `</style>` is a refusal.
- **`CATALOG.md`** — 46 components with every prop and the token vocabulary, generated from source and drift-tested, so an agent picks a component without reading it.
- **Factory traits, associations and `create()`**, plus `sharedExamples` / `behavesLike` in the test harness.
- **`docs/ops/`** — running an Ultimate app for real: the PaaS → Compose → Kubernetes ladder, secrets, observability, datastore sizing, disaster recovery, runbooks. Recommendations only; the framework depends on none of it.
- **`scripts/trust-publishers.ts`** — attaches and verifies the OIDC trusted publisher for every published package. `--check` is the read-only form.

### Fixed

- **A scaffolded app produced no deployable artifact.** `x build --target binary|static` pointed at entry files nothing created, and `--target docker` routed through the same missing file.
- **Eight colour pairings failed WCAG AA.** `line` on `surface-raised` scored **1.16:1** in dark — an input border nobody can see. Seven channels retuned; `tokens/contrast.ts` measures every pairing so it cannot regress.
- **Secrets leaked through the log.** Redaction was by key name, so `{ dsn: 'postgres://user:pw@host/db' }` printed the credential. `checkEnv().values` carried plaintext too; `maskedEnvValues` is now the printing path.
- **Every registry factory defaulted to `seed: 1`**, so two tables minted the same uuid and a join assertion could pass for the wrong reason.
- A scaffolded `biome.json` carried `//` comments Biome rejects; the root tsconfig never mapped `@app/*` for paths the scaffold itself writes; the scaffolded `package.json` had no `version`; `resolveServices` created `.x/` unconditionally, which is `EACCES` in a non-root container.
- `IconButton`'s primary variant hardcoded `accent-fg`, so a danger icon button used accent's on-colour.

### Known gaps

- `x build --target binary` compiles but crashes at import: `FRAMEWORK_VERSION` reads `package.json` at module scope and a single-file executable has none. **Closed in 2.0.0**: the read is lazy, `x build` and `docker/Dockerfile` both pass `--define ULTIMATE_FRAMEWORK_VERSION`, and the image build ends in `/out/app --version`.
- `docker-compose.prod.yml` declares a host port and `replicas: 3` together — two processes cannot bind one port. This is the rung-1 ceiling. **Closed in 2.0.0**: `web` and `sync` are `replicas: 1` in all four files, and the ceiling is declared with the two ways up named.
- The shared cache tier's Lua invalidation `DEL`s keys it never declared in `KEYS`, so it fails on Dragonfly and on Redis Cluster. **Closed in 2.0.0**.
- `resolveEnvironment` now exists in both `core` and `seo` with different return types. **Closed in 2.0.0**, as a breaking change: `@ultimat3/seo` exports neither it nor `SeoEnvironment`.

## [1.0.0] - 2026-08-10

First release. 27 `@ultimat3/*` packages plus the unscoped `create-ultimate` — 28 in all — publish at 1.0.0 to npm, in tier order.

1.0.0 itself is the **manual bootstrap**: a trusted publisher can only be attached to a package that already exists, so this one version is published by hand by an npm org member. Every release after it goes through the workflow over OIDC trusted publishing, no `NPM_TOKEN` — see [PUBLISHING.md](PUBLISHING.md).

### Added

- **The eight primitives**, shapes frozen under semver: `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task`. There is no ninth — a new capability arrives as a factory over an existing primitive, which is why `llm()` returns an `action`.
- **One authz object across every surface.** A `policy` decides the HTTP call, the typed client call, the job run, the MCP tool call and the live-query subscription. No trusted-tool mode, no second permission table.
- **`@ultimat3/core`** — `UltimateError` and the error contract, ALS request context, `defineEnv`, roles, clock, structured logging, OpenTelemetry spans, graceful drain, signed cursors, `defineService`.
- **`@ultimat3/schema`** — Standard Schema over a built-in default provider, JSON Schema projection, and one `formatIssues` shared by every package that reports a validation failure.
- **`@ultimat3/entity` + `@ultimat3/db`** — a Postgres driver (`postgresDriver()`) and an in-memory one over one shared plan/cursor layer, so the two cannot drift; PGlite and database branching, so `x dev` needs no Docker.
- **`@ultimat3/action` + `@ultimat3/query`** — one declaration projecting to an HTTP route, an OpenAPI operation, a typed client method, a job handle, an MCP tool and contract tests, all through a single `invoke` path.
- **`@ultimat3/http`** — the owned `Bun.serve` lifecycle with an explicit, ordered request pipeline.
- **`@ultimat3/jobs`** — Postgres queue driver, durable steps with memoized replay, transactional outbox on by default, cron `task`s with a required IANA timezone and leader election.
- **`@ultimat3/realtime`** — tiers 1–2: channels, presence, live queries with per-subscriber policy, an incremental matcher, a Postgres logical-replication change feed (`pgoutput` over `Bun.connect`), and a NATS bus for fanout.
- **`@ultimat3/render` · `pwa` · `seo`** — five render modes with `stream` the default, the `site/` → `app/` surface boundary as a build error, a generated service worker, and SEO gates that fail the build rather than the audit.
- **`@ultimat3/cache`** — four tiers and one tag invalidation graph; an untagged cached query fails the gate.
- **`@ultimat3/mcp` · `ai` · `manifest`** — the AI-first surface: an MCP dev server whose tool catalog is per-connection and fail-closed, a read-only SQL guard with four independent defenses, `x.manifest.json`, `llm()` with token-and-money budgets and a scope-partitioned semantic cache, `PgVectorStore` fusing pgvector cosine and Postgres FTS through RRF, and evals that gate on score delta from a committed baseline.
- **`@ultimat3/auth` · `mail` · `storage`** — OAuth authorization-code exchange with id-token verification, ESMTP and Resend transports, S3 storage.
- **`@ultimat3/i18n` · `money` · `time`** — enforced, not documented: no hardcoded user-facing string, no float money, no date without an explicit IANA `timeZone`.
- **`@ultimat3/ui` · `admin`** — an SCSS-module design system on semantic tokens for both colour schemes, and the `/_x` dashboard.
- **`@ultimat3/cli`** — the `x` binary. `x dev` boots the real app in any role, and every fact it reports comes from a framework package rather than a second implementation inside the CLI.
- **`create-ultimate`** — `bunx create-ultimate myapp` scaffolds a monorepo whose unmodified generated code passes `x verify`.
- **`x verify`, 17 steps**, with no way to run fewer: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, manifest, roadmap.
- **The error contract, as gate steps.** Every failure carries a stable `X_*` code, a cause, a runnable `fix:` and a `--json` form. `x verify` fails a `fix:` that names no command, and an `X_*` code with no documented row.

### Fixed

- A lockstep release now rewrites sibling `@ultimat3/*` pins, not only each package's own version. Moving versions alone would have published `@ultimat3/jobs@1.0.0` naming `@ultimat3/core@0.0.1` — a version that is not on the registry, so every install of the release would fail.
- Version skew is a `package-shape` finding (`X_RELEASE_VERSION_SKEW`), so it fails the gate instead of reaching npm.
- A changelog entry inserts under `[Unreleased]` instead of appending, which keeps the file newest-first past the second release.

### Notes

Not claimed at 1.0.0, named here rather than left to be discovered:

| Open | Where it stands |
|---|---|
| Realtime capacity | no published benchmark. The 50k-socket forced-restart number is unmeasured; documented capacity figures are targets, not results |
| Two-platform deploy proof | `x build --target docker\|binary\|static`, both compose files and the Helm chart ship. The demo app on Compose **and** K8s from one image, with an invisible rolling restart, is [milestone 11](docs/idea/14-roadmap.md) and is not yet demonstrated |
| Deferred to v2 | realtime tier 3 local-first (`persist: true`), the plugin API, multi-region replication, and the Redis/NATS **job** drivers — each behind an interface that ships today, throwing `X_NOT_IMPLEMENTED` with a runnable `fix:` rather than pretending to work |

## [0.0.1] - 2026-07-26

Repository bootstrap: monorepo layout, tier-enforced package boundaries, Biome and strict TypeScript, free-runner CI, npm OIDC trusted publishing, and the design docs. Never published to npm.
