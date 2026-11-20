# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Declare `@ultimat3/*` at the exact `<version>`, as `x new` and `x upgrade` write and `x doctor` holds an app to (`X_FRAMEWORK_PIN_RANGE`); keep every one on the same version, since a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers. From 23.0.0 on, each `BREAKING —` line names its migration as `(#N)` straight after the dash — row N of that major's `Entry by entry` table in Upgrading — and `bun run changelog-check` refuses a line without one (`X_DOC_MIGRATION_UNPAIRED`).

**Majors 1 through 30 were the pre-stability line**: shipped from 2026-08 under semver, often weeks apart, each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading). v31 is the stable line: from it, at most one major every 90 days (`X_RELEASE_MAJOR_WINDOW`), breaking changes wait on `next` (`X_BREAKING_ON_MAIN`), and the previous major gets security fixes for six months — [Stability](https://github.com/developerz-ai/ultimate/wiki/Stability).

## [Unreleased]

### Added

- **Merging two features:** `x merge-driver install`, run by `bun run setup`, lets two branches that each ran `x g resource` merge with no hand edit: registries keep what both sides added, catalogs merge by key, `x.manifest.json` and `openapi.json` are rebuilt by `x manifest`. New apps write one registry entry per line, and `x upgrade` applies it (the `merge-drivers` codemod). `x doctor` warns `X_MERGE_DRIVER_UNSET` on a clone without the drivers ([Many agents → Merging two features](wiki/Many-Agents.md#merging-two-features)).
- `X_MIGRATION_FORKED`: `x db gen`, `x db migrate` and the gate's `drift` step refuse a migration chain two merged branches forked, before suggesting a `record …` migration that could never replay. `x db gen --merge-fork` corrects the newest snapshot, changes no SQL and deletes nothing.
- `X_MERGE_UNRESOLVED` names the files a merge left unresolved, and `X_CATALOG_UNPARSEABLE` names an i18n catalog that does not parse, in place of a parse error blamed on every module that imports it.
- `x heavy run --max-wait <seconds>` gives up with `X_HEAVY_WAIT_EXPIRED` (exit 75); `x heavy status` names each run's wrapper and command pids (`wrapperAlive`, `childPids` in `--json`), and a heavy run also waits while the CPU is saturated and another run is admitted.
- `x clean --services` stops this app's test service stack, and the gate prints one line saying whether it started, reused or shared one.
- `x dev`'s port refusal names the directory of the process holding the port.
- `x upgrade --only <step>[,<step>…]` runs the hop's `x verify` on those steps alone, so `unit`, `live` and `e2e` can be left to CI on a loaded machine. The report never reads as a full gate: `proof: "verify-only"`, `verify.notRun[]`, a `NOT THE FULL GATE` summary and a `then` naming `x verify --only <the rest>`. A bare `x upgrade` still runs the full gate ([Upgrading](wiki/Upgrading.md)).
- auth: `oauthLogin(auth, { mfaPath })` and `identityProviderRoutes(auth, { providers, mfaPath })` let an MFA-enrolled user finish SSO through the built-in routes: the callback answers 303 to the app's second-factor page with the sealed challenge in an `HttpOnly` `__Host-x_mfa` cookie. On that page, `completeMfa(auth, readMfaChallenge(request) ?? '', code)`, then send `clearMfaChallengeCookie()` — both new exports of `@ultimat3/auth`. An `mfaPath` that is not one absolute path on this origin (`'//'` and any path the URL parser rejects included) is `X_CONFIG_INVALID` at the call, never a bare `TypeError`. Without `mfaPath` the callback is the same 401 `X_MFA_REQUIRED`, and its logged fix now names the option.
- jobs: `startQueueWake({ reproveEveryMs })` (default 10 s) re-proves a proven cross-process wake; `installDefaultRetry` / `resetDefaultRetry` / `DefaultRetry` on `@ultimat3/jobs/adapter` install the retry of a job that declares none (the boot does it from `jobs.maxAttempts` / `jobs.backoff`).

- http: `reportLateFault(error, ctx?)` is exported from `@ultimat3/http`: it runs the `error-map` stage's monitor, `onError` and log line for a fault after the response started, once per request; a caller's hang-up records nothing and leaves the one report unspent (`true` only when a pipeline request is bound, else `false`).
- http: `cappedWireDates` and `WIRE_DATES_MAX_BYTES` (1,536): the `x-ultimate-dates` value an answer carries, or none past the cap.
- ai: `GenerateRequest.toolChoice?: 'auto'` (optional) leaves a request's single tool unforced; compaction's summary call sets it.
- auth: `AuthServerClient.host` — a metadata-document client's `client_id` host, beside the `name` its document chose; show it on the consent page.
- jobs/redis: `redisJobDriver({ deadTtlMs })` — how long failed, dead and expired rows are kept (default 90 days, pg's `jobs.deadRetentionMs`; `0` keeps them forever).
- testing: `authServerStoreConformance` checks that `purge` deletes a self-registered client past the idle window that nothing names, and only it.
- `x db rollback [--steps n]` reverses the most recently applied migration(s), most recently applied first, by running each file's `-- down` half; the files stay, so each is pending again (`x db migrate` re-applies). Beside an `x dev` on the embedded database it is run by that dev server (`POST /_x/db/rollback`). A file with no `-- down` marker is `X_MIGRATION_IRREVERSIBLE`; outside development and test it is refused `X_MIGRATION_ROLLBACK_DESTRUCTIVE` until `ROLLBACK_ALLOW_DESTRUCTIVE` names every migration it would reverse. Reversing only the `<id>_concurrently` half of a pair `x db gen` wrote says so and names the still-applied `<id>` to roll back next; a standalone non-transactional migration gets no such line. When the request to a live `x dev` was sent and its answer lost, the fix reads the ledger (`x stop --json && x db status && x dev`), never repeats the rollback. `--json`: `{ reverted, steps, files }`.
- db: `rollback({ confirm })` is called once, under the migrate lock and before the first `down`, with the exact ledger rows about to be reversed, and awaited: an async consent settles before any `down` runs, and a throw or a rejection reverses nothing.
- `x tasks run <name>` fires a scheduled task now — its jobs onto the app's queue through `TaskHandle.enqueue()`, the scheduler's watermark untouched — with `--json`; where the environment resolves `production` it fires only when asked by name, `--production` or (a container whose command line is fixed) `ULTIMATE_TASK_RUN=<name>`, else `X_TASK_RUN_PRODUCTION` with nothing queued — `x db seed`'s gate and refusal form; beside an `x dev` holding the embedded database it is refused. `x g cron-job` names it as its next step.
- `x policy explain <subject> --input '<json>'` evaluates the policy on a request's input, for a rule whose predicate reads one; the value is never echoed.
- `x docs <topic-id>` — the id every search line starts with — prints that topic's body: a package guide's whole section, or a module's header comment and exports. A search ends with that command for its first hit.
- `x new` declares `@ultimat3/realtime` at the exact framework pin, so `useQuery` / `channel()` resolve on a fresh app and `x doctor` stays green; an older app adds it with `bun add --exact` at its `@ultimat3/core` pin ([Realtime](wiki/Realtime.md)).
- `x errors explain <CODE>` answers an app's own `defineError()` codes inside the app, from the error registry: title, HTTP status and the declaring `file:line` (`--json`: `{ code, title, docs, status, site }`).
- `x doctor` warns (`X_ACTION_UNREGISTERED` / `X_QUERY_UNREGISTERED`, never a failure) on an action or query left off an app's `defineApi()` that lists others, with the import line that lists it; an app registering by the module scan alone is told nothing.
- jobs README: "One job per org, from a schedule" — a `tenant: 'none'` `cronJob()` listing orgs inside `crossTenant()` and enqueueing one tenant-scoped job per org, its fence run by a test.
- auth: `mfaChallengeOf`, `mfaChallengeCookie` and `MFA_CHALLENGE_COOKIE` — the write half of the MFA challenge cookie, beside `readMfaChallenge` / `clearMfaChallengeCookie`.
- action: `acceptedIdOf(record)` on `@ultimat3/action/adapter` — the id `batchedAuditSink` minted for a record, for a custom sink's idempotent insert.
- core: `JOBS_MAX_ATTEMPTS_DEFAULT` (3), the one statement of the default retry attempts: `jobs.maxAttempts`' default and `DEFAULT_RETRY.attempts` both read it; `laterHooksReserveMs(deadlineMs)`, the drain's reserve for the hooks behind the in-flight wait; `ShutdownReason.inflightUntil`, the instant that wait ends.
- cache: `CacheTier.scope?` names which entries a tier's bust clears (`redisTier` sets its `x:<APP_VERSION>` namespace); `InvalidationBroadcast` receives the sender's scopes as an optional second argument (type `SharedTierScopes`).
- ui: `HotkeyKeyEvent.keyCode?` (optional).
- realtime: `SocketRegistry.deliverRecords(topic, epoch, frame, to?)` takes the tenant audience as an optional trailing parameter.
- **Processes per container:** a production container runs one process per CPU its quota declares, all on the role's one port (`SO_REUSEPORT`), for `web`, `sync` and `worker`. `ULTIMATE_PROCESSES` = `auto` (default) or a count; `auto` is 1 with no CPU quota, and is clamped by memory (256 MiB per process), the pool, per-process state, the role and the platform; an explicit count is checked (`X_PROCESSES_INVALID`, `X_PROCESSES_ROLE_SINGLETON`, `X_PROCESSES_UNSHARED_STATE`, `X_PROCESSES_OVER_POOL`, `X_PROCESSES_UNBALANCED`), a crash-looping child is `X_PROCESS_CRASH_LOOP`. The supervisor answers `METRICS_PORT` for the container — `/metrics` merged with a `child` label, `/readyz` when every child is ready — and every child's log line carries `child` (a child's boot refusal is one `ultimate child refused to boot` error line; one the same image and environment meet again — a missing variable, invalid config, a mismatched key, any `X_PROCESSES_*` refusal — stops the container with exit 1 at once instead of restarting, while a database or bus still starting is restarted with backoff). `x dev` and tests always run one process; a count `x dev` is handed is said once at boot (`ultimate processes ignored`, info) and never refused ([Deployment → Processes per container](wiki/Deployment.md#processes-per-container)).
- `x doctor` reports processes per role (the count and the clamp that bound it) and connections per container (Σ child pool shares + one LISTEN session per worker process) against `max_connections`; on a production host it warns `X_PROCESSES_CPU_UNDECLARED` (no CPU budget on a multi-core host) and `X_PROCESSES_MIGRATE_REQ_OFF` (N > 1 with `net.ipv4.tcp_migrate_req` at 0). `x deploy verify --json` lists the worker registry's rows per container (`data.queues.containers`).
### Changed

- `jobs.concurrency`, `jobs.maxInFlight` and `DATABASE_POOL_MAX` are per **container**, split across its processes; a queue whose total is below the process count is served only by the lowest-indexed processes, so `concurrency: 1` stays serial. With one process per container — every container without a CPU quota, so every app on upgrade — nothing changes ([Upgrading](wiki/Upgrading.md)).
- The shipped and scaffolded compose files declare a CPU budget per role (`web: '2'`, `sync: '1'`, `worker: '1'`, `scheduler`/`replicator: '0.5'`), `init: true` on every service (Bun as PID 1 neither reaps orphans nor stops on an unhandled SIGTERM) and `net.ipv4.tcp_migrate_req: 1` on `web` and `sync`; both Helm charts pin `ULTIMATE_PROCESSES: "1"` (parallelism per pod is the HPA's). An existing app's files are unchanged.
- `cache.defaultTtlMs` now sets the lease of a value cached with no `ttlMs` on the `lru` and `redis` rungs the boot builds. It was validated and documented and read by nothing; a boot-built Redis rung held such values 300 s, now the configured 60 s by default. A rung supplied through `cacheTiers` keeps its own default (#1260).
- A fix line that ends `then: x …` prints `bunx x …`, as does the gate's stderr pointer and `x errors explain`; a shipped guard's fix re-runs its own step (`x verify --only boundaries`), never the whole gate.
- Fixes no longer send a worker to a whole run: `X_TEST_NO_FILES` suggests `x test --affected --dirty`, `X_TYPECHECK_FAILED` names the file to edit and `x verify --only typecheck`, and an unknown command whose nearest match runs every suite suggests its `--help`.
- A ledger wait says to leave the command running (`bunx x heavy status`), and reads `admission in progress` while no holder is known.
- A new app's `CLAUDE.md` lists a worker's commands, its `/feature` and `/verify` skip the gate for a worker given a file set, and `.claude/settings.json` allows `bunx x heavy` and `bunx x stop` in place of the raw typecheck and lint scripts (the `docs-worker-commands` codemod updates `CLAUDE.md` on `x upgrade`).
- `x doctor`: a port another checkout's dev server holds is a warning, not a failure; the suggested port pair is free when asked, and so is the sync role's; each taken port is reported once, as a warning or a failure, never both.
- `X_JOB_UNREGISTERED` names the job's file and prints the whole import line.
- `x db gen` runs one at a time per checkout; its success line names the tables, and "no migration needed" names the migration that already records them.
- The test step line reads `ran 2 at once (peak), planned 3`, or `1 worker, one per file (plan: …)`, in place of `2 of 4 of 6 workers`.
- A doctor probe that throws is an `X_DOCTOR_PROBE_FAILED` finding, never a crash whose fix is the doctor itself.
- `jobs.maxAttempts` and `jobs.backoff` are read: the attempts of a job that declares no `retry` (a factory's whose `retry` was omitted: `purge()`, `backfill()`, `rollup()`, …), and the curve of any `retry` naming no `backoff`. Installed by `startQueue`, the boot every entry point shares — every role, `x tasks run`, `x jobs` and `x db backfill` — so the enqueuing process stamps the same `max_attempts` the worker retries by. `jobs.maxAttempts` now defaults to `3`, not the documented `5`: the key was read by nothing, and 3 is the retry such a job always had. With neither key set nothing moves. **Upgrading:** an app that set either key gets it applied now — `grep -n 'maxAttempts\|backoff' app.config.ts` and keep the value only if it is the retry you want for every job declaring none.
- `cache.defaultTtlMs: 0` is refused by `defineConfig` (`X_CONFIG_INVALID`) instead of crashing the boot; the minimum is 1, and a value that is not a whole number ≥ 1 refuses the boot naming `cache.defaultTtlMs`. **Upgrading:** an app writing `0` sets a positive lease.
- core: `directionOf` / `isRtl` read an explicit script subtag first (`az-Arab` is `rtl`, `ks-Deva` `ltr`), and bare `ku` is now `ltr` (Kurmanji, Latin script). **Upgrading:** an app serving Kurdish in Arabic script under `ku` renames the locale `ku-Arab` or `ckb`, or its pages render `dir="ltr"`.
- `database.ssl: true` now requires TLS (`sslmode=require`) on the pool every boot opens — serving roles, `x dev`, the migrate step, `x db status`/`recount`/`diagnostics`, primary and replica — unless the URL (`sslmode` or `ssl`) or `PGSSLMODE` states a mode — and on every other pool the framework opens: the replicator's `DATABASE_URL` and `REPLICATION_URL` sessions, `x doctor`'s database probes, `x db branch` and `x deploy verify`'s queue read. It was validated and read by nothing. `PGSSLMODE` is a declared framework env name. **Upgrading:** an app with `ssl: true` whose `DATABASE_URL` states no mode, against a Postgres without TLS, no longer connects: set `database: { ssl: false }`, or put `?sslmode=disable` in that URL.
- A `ROLE` not listed in `roles` in `app.config.ts` refuses to boot with `X_CONFIG_INVALID` (`meta.key: 'roles'`); `ROLE=migrate` is exempt; when `roles` declares no serving role at all (only `migrate`), the fix is the declaration (`roles: ['migrate', 'web']`), never the refused `ROLE`. The list was read by nothing. **Upgrading:** an app declaring `roles` checks every `ROLE` its deploy starts (compose services, Helm values, the platform's processes) is in it, or drops the key.
- `x db migrate` beside an `x dev` holding the embedded database is applied **by that dev server** (`POST /_x/db/migrate`, loopback and same-origin only), never by a second process: PGlite takes no lock, and the holder's next write dropped the tables a second process applied. The request sends `Sec-Fetch-Site: same-origin`, so an app with CSRF protection admits it, and a dev server still booting is waited for (up to 120 s; a sent request is never resent). `x dev`'s own `x db gen "…" && x db migrate` hint works again. A holder that cannot answer (an older server, a dead port) or serves `database.rowSecurity` refuses `X_DEV_ALREADY_RUNNING`, fix `x stop --json && x db migrate && x dev`.
- Beside an `x dev` holding the embedded database, `x db seed` (`--dry-run` and `--generate` included), `x db backfill --write`, `x jobs retry|cancel|delete|promote|resolve-step|pause|resume` and `x auth seal-mfa` refuse `X_DEV_ALREADY_RUNNING`; the fix stops it, runs the command and starts it again. An external `DATABASE_URL` is unaffected. **Upgrading:** a script or agent loop running one of these beside `x dev` runs `x stop --json` first.
- realtime: a records channel keyed by a param that is not the tenant column (a `roomId` topic) delivers a tenanted row only to members of that row's tenant, live and on replay after `since`; every other member receives the seq alone. **Upgrading:** an app whose channel intentionally fanned one tenant's rows out to members of other orgs sees those rows stop; that feed needs its own untenanted table or a channel keyed by the tenant column.

- http: outside dev, an unclassified 5xx whose `code` is not framework-shaped (`X_…`) and not declared — a driver's SQLSTATE (`23505`), `ENOENT`, an app's own `E_UPSTREAM` — is served as `X_INTERNAL` in `code`, `type`, the hidden `fix` and the HTML error page. **Upgrading:** a client that switches on a non-`X_` code from a 5xx needs that code declared — `defineError` or `registerErrorStatus({ E_UPSTREAM: 502 })` — `grep -rn "code: '[A-Z]" apps packages | grep -v "'X_"` lists the candidates. A declared code, and dev, are unchanged.
- http: a caller that hangs up mid-request is answered `499 X_ABORTED`, logged at `info`, not sent to the monitor and not counted as a 5xx; `hooks.onError` receives the coded `X_ABORTED`, not the raw `AbortError`. A library's own wrapped abort stays a reported 500. **Upgrading:** a dashboard or alert on `http.server.request` 5xx volume drops by the hang-ups; an `onError` that matched `name === 'AbortError'` matches `code === 'X_ABORTED'`.
- http: `ctx.peer` reads `x-forwarded-client-cert` from the right, parsing only the elements the trusted hops appended: a client prefix with an unbalanced quote no longer nulls the peer, and a trusted element holding a `"` that is not a whole-value quote (`URI=spiffe://a/b"c`) is no peer. **Upgrading:** an Envoy front quotes whole values, so nothing moves; a proxy that writes bare quotes inside a value shows `ctx.peer === null` — check it in staging.
- http: the request deadline bounds time-to-headers; once a streamed answer has started only the caller going away fires `ctx.signal`. **Upgrading:** a streamed agent answer that relied on `requestTimeoutMs` to end it bounds itself: `withChildContext({ signal: AbortSignal.timeout(ms) }, …)`.
- action: SSE `chunk` frames carry an optional `dates:` line (a reader that does not know it ignores it); `hooks.onError` and the `error-map` log line now fire for a streamed action's fault after the first chunk, 4xx included (4xx: sink and log only).
- core: `defineConfig` refuses a non-boolean `pwa.enabled`, `pwa.backgroundSync` or `pwa.push` (`'false'` turned the PWA **on**), checked even when `enabled` is false; a non-list `pwa.categories`, a non-string `pwa.offline.neverCache` entry, a non-list `pwa.shortcuts` / `pwa.screenshots` and a non-string `site.favicon` are `X_CONFIG_INVALID` too. **Upgrading:** `grep -n "enabled\|backgroundSync\|push" app.config.ts` in the `pwa` block: each is `true` or `false`, never a string or a number.
- core: `clientTransport` sends a write with no idempotency key **once**, whatever the flight's retry policy (a gateway 5xx re-sent it). `rpc`, the outbox and storage are already keyed or single-shot. **Upgrading:** a direct `clientTransport({ method: 'POST', flight, retry })` that relied on a retry passes an `idempotencyKey`.
- core: `drain()` keeps min(2 s, `deadlineMs` / 5) of its budget for the `inflight` / `close` hooks when in-flight work overruns, so the in-flight wait ends that much earlier; the total stays within `deadlineMs`. The instant is handed to every hook as `ShutdownReason.inflightUntil`, and the jobs worker's drain cut-off measures back from it, so a job cut at the cut-off drains with exit 0 (it raced the wait's end to `X_SHUTDOWN_TIMEOUT`, exit 70). **Upgrading:** `x verify`'s `X_JOB_OUTLASTS_DRAIN` (retire off) grades against that earlier cancel — 21 s of a 25 s `drain.deadlineMs`, was 23 s; a job whose `timeout` sits between them now reds `manifest`: raise `drain.workerRetireMs` or lower the `timeout`.
- core: the Sentry transport drops reports during a 429's `Retry-After` pause (60 s when unstated) and warns once per refused status; `X_ERROR_REPORTER_DSN_INVALID`'s `meta.dsn` holds the DSN without its userinfo, and a DSN that is not an http(s) URL (a legacy `key:secret@host/1`) is described, never echoed.
- jobs/redis: failed, dead and expired rows, their steps and debounce fences **expire after 90 days by default**; `stats()` no longer counts `failed`/`dead` members past the window. **Upgrading:** an app on `redisJobDriver()` that reads old dead rows for audit passes `redisJobDriver({ deadTtlMs: 0 })` to keep them forever, or exports them first.
- jobs/redis: with no `clock` injected, leases, retries, settle debts and gauges are measured on the **Redis server's clock** (`TIME`); `claimedAt`, `visibleAt` and `updatedAt` are server times and a nack's `runAt` is server now plus the delay, as on pg. **Upgrading:** a test that freezes time (`installClock`, the preload's `Date`) against a real Redis driver passes `redisJobDriver({ clock })` to keep the frozen clock in charge.
- jobs: a claimed job whose admission took the whole visibility window is handed back uncounted as a debug shed (`jobs.worker.shed`, `reason: 'admitted-late'`) without running its body — no `jobs.lease.lost`, no `job_leases_lost_total`, no `jobs.worker.settle-failed`; one admitted an interval or more late heartbeats at once. **Upgrading:** an alert on `job_leases_lost_total` no longer fires for a slow admission.
- ai: `postgresVectorStore()`'s lexical leg (`searchText`, `hybrid`) matches **any** word of the query, as `memoryVectorStore()` does, and reads no query syntax: `"quoted phrase"`, `-word` and `or` are plain text. **Upgrading:** a caller that passed websearch syntax to exclude or quote drops it; expect more lexical candidates per query.
- ai: `anthropicProvider()` sends `strict: true` only for a schema inside the Messages API's strict subset and under its per-request caps — nearly every tool with a string loses the flag on that wire (those requests were 400s). The output schema still validates.
- ai: `defineEval` refuses a `tolerance` that is not finite or is negative (`X_INVARIANT`). **Upgrading:** `grep -rn 'tolerance' apps packages` — each a number ≥ 0.
- ai: `ULTIMATE_EVAL_RECORD` set to `0`, `false`, `no`, `off` or empty gates (and `x verify` with it is no longer `X_EVAL_RECORDING`); any other value records.
- ai: `chunkDocument` cuts slightly earlier (the joining space is counted), so re-indexing a document can change chunk ids and boundaries.
- db: `x db gen` turning a plain column into a generated one is asked as a drop: `X_MIGRATION_ROLLING_UNSAFE` unless the column was retired first (or `--rolling-unsafe`), then `X_MIGRATION_IRREVERSIBLE` unless `--allow-destructive`; the migration carries `-- rolling-unsafe: true`. **Upgrading:** an app with that change pending passes both flags, or retires the column first.
- db: a column drop's generated `down` also re-creates the indexes and foreign keys the previous snapshot recorded over the column; a `.snapshot.json` whose `dataType` holds a second statement no longer parses (`X_MIGRATION_SNAPSHOT_MISSING`). Files on disk are untouched.
- entity: `.search()` inside `crossTenant()` through an external `SearchIndex` asks the index once per tenant of an `andWhere('<tenant>', 'in', [...])`, and refuses `X_INVARIANT_VIOLATED` when the chain names no tenant (it silently answered the actor's org alone). Under the built-in Postgres index nothing changes. **Upgrading:** an app with an external index running `crossTenant(…, () => t.search(…))` adds the tenant `in` list.
- entity: `matches(/…/)` refuses at declaration a surrogate `\uD8xx` escape (any astral literal), a repetition bound above 255, a `-` straight after a range or `\d`/`\D` inside a class (not last), and a quantified lookaround. Each already failed or answered wrong on Postgres. **Upgrading:** an app that only ran the memory driver and declared one fails at boot; the refusal names the construct and the portable spelling.
- entity: `entity.row` reports an `upsertAll` matched on a natural key (`onConflict` other than `['id']`) as `update` with its `before` row, not `insert` with `before: null`; a composite key's before-rows are read by tuple, never by the product of per-column `in` lists. **Upgrading:** a subscriber or test asserting `insert` for such an upsert asserts `update`.
- entity: the memory driver's refused `updateMany` / `updateWhere` leaves no row changed, as Postgres; a seed replay with a `json()` column reports `skipped` on Postgres where it reported `updated` every run.
- auth: `POST /oauth/register` refuses more than 10 `redirect_uris` or one over 2,048 characters (`invalid_client_metadata`) and deduplicates `scope`; self-registered clients get `d_…` ids (were `c_…`), and `purge()` deletes a `d_` client older than the refresh idle window that no grant, code or device code names (the client re-registers). Registration and client-metadata limits are shared across an IPv6 /64. **Upgrading:** a hand-written `AuthServerStore` runs `authServerStoreConformance` again — its `purge` must reap those clients; clients registered before keep `c_` and are never reaped (a one-off `delete` by the operator, if wanted).
- mcp: `mcpOAuthClient().begin()` refuses a server URL or authorization-server issuer that is not `https:` (loopback `http:` aside), `X_MCP_REMOTE_REFUSED`. **Upgrading:** an app pointing at an internal cleartext MCP server by hostname serves it over TLS.
- mcp: `refresh()` answers the refresh token it was passed when the server's answer omits one (RFC 6749 §6), never `null`. **Upgrading:** code that read `refreshToken: null` from `refresh` as "revoked" reads the refresh's own refusal instead.
- mcp: `docs({ q })` refuses a `q` over 1,000 characters (`X_INPUT_INVALID`); `db.query` refuses `EXPLAIN ANALYSE` and the `pg_copy_*`, `pg_sync_replication_*`, `pg_backup_*`, `pg_start_backup`, `pg_stop_backup`, `pg_restore_*`, `pg_clear_*` families (dev MCP and the admin SQL panel); on a `tenant:` server `tenant.arg` is stripped from `params`; a throwing resource source answers `-32603` on `resources/list`.
- pwa: `pushSubscribe` stores an `expirationTime` that is not a whole number of milliseconds from 0 to `Number.MAX_SAFE_INTEGER` (a fraction, a negative, `1e30`) as no expiry, where the Postgres store answered an uncoded 500 and the memory store kept it. The action's input schema is unchanged.
- pwa: a 401/403 from a push service no longer deletes the subscription: it is refused by code (`X_PWA_PUSH_REJECTED`, logged, counted in `refused`) and kept; only 404/410 and expiry delete. **Upgrading:** after a real VAPID key rotation the old rows stay until each browser re-subscribes (`subscribeToPush` and the emitted `subscribePush` replace them) or expires.
- render: a served-stale `isr` answer carries `public, max-age=0, s-maxage=0` and no `stale-while-revalidate`; surrogate keys and `etag` are kept. **Upgrading:** behind a CDN, the edge's stale window shrinks from `ttl` + 24 h to none — one extra origin request per stale serve.
- render: `navigate()` to a fragment of the page on screen is the browser's fragment navigation: no fetch, no swap, no `ultimate:navigate` / `ultimate:navigated` events.
- ui: `timeRangeUrl().href({ from, to })` writes `:ss` when an instant has seconds and moves an end forward so it reads back at or after the instant (a fall-back hour included); every list cursor on the page is dropped, namespaced or not. `SearchableSelect` and `useCommandPalette` ignore keydowns while an IME is composing (`isComposing`, `Process`, `keyCode` 229); `niceTicks` answers `[low, high]` where it returned duplicate ticks.
- admin: sorting a list by a `money()` column works — by currency, then minor, paging forward and back (it answered 500); the manifest's `sorts` are unchanged. An `ids` batch over the bound answers `after: null` (screen and MCP); only an "all matching" selection continues. **Upgrading:** an MCP client resuming an ids batch re-sends the remaining ids.
- testing: `toBeWithinBudget(limit)` throws `X_TEST_NUMBER_EXPECTED` for a limit that is not finite (`undefined`, `NaN`, `Infinity`), under `.not` too. **Upgrading:** a test passing `Infinity` as "no budget" drops the assertion.
- cli: `x jobs pause|resume <queue>` refuses a queue outside `jobs.queues` and the registered jobs' queues (`X_CLI_BAD_FLAG`, nearest name in the fix). **Upgrading:** a runbook pausing a queue reached only by `enqueue({ queue })` lists it in `jobs.queues`.
- cli: `x g sign-in --oidc` passes `mfaPath` and writes the second-factor page, `sign-in-challenge.ts`, `actions/confirm-session.ts`, their tests and catalog keys. **Upgrading:** an app generated before keeps its 401 `X_MFA_REQUIRED` for an MFA-enrolled user until it adds `mfaPath` to `oauthLogin` / `identityProviderRoutes` and the page ([Auth](wiki/Auth.md)); no codemod.
- cli: `x g query` into a slice whose hand-written `policy.ts` lacks `can<Feature>Read` (and `<feature>Tag` unless `--live`) refuses `X_SLICE_POLICY_INCOMPLETE` and writes nothing; `x g purge` writes a unit test that asserts the declaration and runs no pass.
- docker: the framework's `docker/docker-compose.prod.yml` ships the `replicator` at `replicas: 0`, like `sync`; set it to 1 when you turn realtime on. New scaffolds pin the compose `postgres:18-alpine` by digest.
- `x env check` on a shell that names no environment (no `ULTIMATE_ENV`, no `NODE_ENV`, no `CI`) checks as **development** — what `x dev` in that directory runs as — and says so; it was production, red on a fresh scaffold. A named environment is checked as named, and under `CI` an unnamed one is still production. `--json` carries `data.environment`. **Upgrading:** a deploy script running a bare `x env check` on a host that sets none of the three names it: `ULTIMATE_ENV=production x env check`.
- `x test <type>` exits 1 (`X_TEST_FAILED`) when every test it selected skipped itself — `ran 0`, `skipped N` — naming the unset `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_NATS_URL` and the command that starts the services, then the run's own selection again (`--filter`, `--affected`, `--sample`, `--dirty`, `--seed`, passthrough kept); it exited 0 having checked nothing. `x verify` is unaffected. **Upgrading:** a script calling `x test live` (or any type) with no services starts them first — `docker compose -f docker/docker-compose.test.yml up -d --wait` — or stops calling it.
- `x dev` is `✗ dev ready` (`ok: false` under `--json --once`) while migrations on disk are ahead of its database (`X_APP_MIGRATIONS_UNAPPLIED`, fix `x db migrate`) or an applied one was edited (`X_MIGRATION_CONFLICT`); it was `✓` over a 500. It still serves. A schema finding appearing or clearing no longer restarts it, so `x db gen "…" && x db migrate` runs against a server that is up and the request that was a 500 is answered by the same process. **Upgrading:** a workflow that starts `x dev` before its first `x db migrate` sees a red banner until it migrates; a script waiting for a fresh `✓` banner after `x db gen` reads `/_x` instead.
- `x db gen` on the **embedded** database refuses an applied migration whose SQL was edited since (`X_MIGRATION_CONFLICT`, exit 1, nothing written) — it rewrote the schema dump to match the edit — and opens that database once to read the ledger (through a running `x dev`, else read-only). An external `DATABASE_URL` is never dialled. **Upgrading:** an edited applied migration is restored (`git checkout <rev> -- packages/db/migrations/<id>.sql`), or the dev database rebuilt: `x stop --json && x db reset`.
- `x new` names the test stack's compose project `<app>-test-<hash of the scaffold directory>` and picks its ports from name and directory, so two scaffolds with one name on one machine no longer share a stack. **Upgrading:** nothing; an existing app keeps the `name:` its `docker/docker-compose.test.yml` states. To stop sharing with a same-named app, give it its own `name:` there and its own ports there and in `docker/test-services.env`.
- `x policy explain` reports `needs input` (`verdict: 'needs-input'`, `allowed: null`, counted in `data.pending`), never `deny`, for a predicate that read request input it was not given; the summary names the `--input` command that decides it. A predicate that throws on missing input now gives a `needs-input` row per actor instead of `decidable: false`, and so does one that checks the whole input (`Array.isArray(input)`, `input === null`, `typeof input`): each predicate that has to run is also evaluated over an array, `null` and `''` stand-in, and a verdict that moves with the stand-in needs input. **Upgrading:** a script reading `!allowed` as "denied" checks `verdict === 'deny'`.
- `x g query` and `x g resource` reads answer the slice's `<Feature>View` — the shape the generated actions answer — instead of the whole row: no tenant column on the wire, and a column added to the entity is published only by an edit to the view (live patches included). Files generated before are untouched.
- `X_ENV_MISSING`'s `fix:` is the line to add, in the file the environment loads (`echo 'STRIPE_KEY=<value>' >> .env.development.local`; `.env.test.local` under test, `.env.production` for a deploy), and a malformed key's is `grep -n -e '^KEY=' .env*` — no longer `x env check`, which printed the same error. **Upgrading:** anything matching the old fix text exactly matches the new.
- `x docs <query>` prints one extra closing line naming the first hit's topic command, and a query that is exactly a topic id answers that topic alone instead of a ranked search.
- An unknown subcommand with no near match answers `x help <command>` (that command's own subcommands), not `x help`; a mistyped generator keeps the name and slice you typed (`x g acton foo` → `x g action foo`).
- cache: during a rolling deploy, a write on one build also clears the other build's shared Redis tier: the invalidation broadcast names the namespace its own bust cleared, and a receiver skips its shared tier only when that namespace is its own. Old and new pods read each other's frames (an older frame names no scope and busts every tier). **Upgrading:** a custom `InvalidationBroadcast` callback still type-checks; nothing to change.
- cache: a refused delete's re-join is `ZADD … GT`, so it never lowers a later fill's bucket score. **Upgrading:** Redis ≥ 6.2 (Valkey, Dragonfly included); an older server refuses it only on the already-partial refused-`UNLINK` path, reported in the bust's failures.
- action, query, http: `x-ultimate-dates` (and a streamed frame's `dates:` line) is capped at 1,536 bytes (`WIRE_DATES_MAX_BYTES`); an answer needing more carries none, the client reads those instants as ISO strings, and the operation is logged once at `warn` (`http.wire_dates_dropped`). A proxy with a default 4 KB header buffer no longer answers 502: the framework's own headers (security, CSP, CORS, rate-limit, trace ids, a sealed cookie) measure ~2 KB, and the cap leaves ~0.5 KB for the app's. **Upgrading:** an answer with ~100+ instants that cannot fold (a `[label, instant]` tuple, a `string | Date` column) reaches the client as strings: `grep` the logs for `http.wire_dates_dropped`.
- `x db rollback` needs `ROLLBACK_ALLOW_DESTRUCTIVE` naming each id against an external database that is not on this machine, whatever `ULTIMATE_ENV` says, and on any named deploy (`staging`, `production`, `NODE_ENV=production`). **Upgrading:** a script rolling back a remote database from a shell that names no environment (a compose service host like `db` included) sets `ROLLBACK_ALLOW_DESTRUCTIVE=<id,…>`.
- `x dev` runs only the roles `app.config.ts`'s `roles` declares, when set, and logs the ones it left out; `x dev --role` naming only undeclared roles is `X_CONFIG_INVALID`. **Upgrading:** an app declaring `roles` lists every role it wants `x dev` to run.
- `startQueue` loads `app.config.ts` on every boot, embedded included. **Upgrading:** a command that boots the queue against an invalid config now refuses `X_CONFIG_INVALID`; `x verify --only manifest` shows the same.
- A scheduled occurrence that one fan-out entry cannot queue (its `tenant()` throws or answers empty) queues nothing, logs `jobs.scheduler.entry-refused` naming the task, job and entry, and is retried each tick until repaired, then queued whole. **Upgrading:** alert on `jobs.scheduler.entry-refused`.
- `database.ssl: true` requires TLS on a URL carrying an empty `?sslmode=` / `?ssl=` (it fell back to plaintext), and an upper-case `?SSLMODE=disable` is the operator's and no longer overridden. **Upgrading:** a deployment that relied on the empty value against a non-TLS server states `?sslmode=disable`.
- `x g sign-in --password` holds its second-factor challenge in auth's `__Host-x_mfa` cookie (`mfaChallengeCookie`), as the OIDC shape does, in place of its own `x_mfa_challenge`. **Upgrading:** an app generated before keeps its own `sign-in-challenge.ts` and cookie unchanged; the new shape's `__Host-` cookie needs HTTPS or `localhost`.
- entity: `gt`/`gte`/`lt`/`lte` on a `uuid()` column with an operand that is not a uuid is `X_INVARIANT_VIOLATED` on both drivers (Postgres answered `22P02`, memory compared the text). **Upgrading:** a memory-driver test relying on text order for such a bound passes a uuid.
- ai: compaction's carried user text is one `KEPT_USER_CHARS` (8,000) budget across ALL compactions, newest kept first; the summary note says how many blocks it carried. **Upgrading:** nothing; a long `.continue()` chat no longer grows its head until `X_AGENT_CONTEXT_EXHAUSTED`.
- `X_FORBIDDEN`'s fix names `--input '<the request input as JSON>'` at all four throw sites, so the command it gives can decide a predicate that reads the request; the request's own input is never printed. **Upgrading:** a test asserting the old `fix:` text updates it.
### Fixed

- `bun run preflight` and `bun run coverage` stopped by a signal kill the suites they started, so no orphan keeps its ledger reservation.
- In-process test fixtures no longer join the real ledger queue and leave frozen tickets at its head.
- `x upgrade`'s `docs-many-agents` codemod no longer reports `changed: [], skipped: []` when the app reworded its conventions table: it finds the table in `AGENTS.md` too, and otherwise reports the file as skipped with the row to add. It also checks the brief's byte budget (`agentsMdMaxBytes`, 12,000 by default) before writing, and skips with the byte count instead of pushing `CLAUDE.md` over it into `X_AGENTS_MD_TOO_LARGE`. `docs-worker-commands` does the same.
- `x upgrade` installs the merge drivers a hop's `.gitattributes` names, as `bun run setup` does, so an upgraded clone has no `X_MERGE_DRIVER_UNSET` left to fix by hand.
- A live suite no longer joins another app's test stack that shares its compose project name: it is refused with `X_TEST_SERVICES_UNAVAILABLE`.
- auth: a retired refresh token presented by a client other than the one it was issued to no longer revokes the grant; it is refused as another client's token.
- mcp: `mcpClient` cancels a legacy-server call by its own request id, never a sibling's, and only when the request was sent.
- mcp: a 429, 408 or 403 on the first call no longer switches `mcpClient` to the legacy protocol for good (only a 400/404/405, an era JSON-RPC code or a body that is no answer does); a failed handshake decides nothing; concurrent first calls share one handshake.
- mcp: `listTools` refuses a cursor that never ends (`X_MCP_REMOTE_REFUSED`, `meta.failure: 'malformed'`, past 50 pages) instead of returning a truncated list.
- mail: the SMTP connect is bounded by `timeoutMs` (stage `connect`, retryable), so a dead host no longer holds a pool slot.
- mail: the SES driver sends 7-bit envelope addresses: an encoded-word `From` display name and bare-mailbox destinations.
- scraping: a CDP command the transport refuses to send fails at once with `X_CDP_CALL_FAILED` and leaves no pending entry, and a `null` frame is dropped instead of throwing.
- i18n: `catalogSubset` carries a key's `_select_*` and `_ordinal_*` families, so an island no longer renders `⟦key⟧` where the server renders the message.
- i18n: `t.has(key)` is true for a select or ordinal family defined only in plural forms; a mail's `has()`-guarded preheader and footer no longer drop copy `t()` renders.
- money: a hand-built `Money` with a non-integer `minor` is `X_MONEY_NOT_INTEGER` from every arithmetic, rescale and format entry — never a bare `RangeError`, `$NaN` or `12..5`.
- money: `parseAmount` reads the half-width `¥` in `ja-JP`.
- schema: `sampleGaps` reports a formatted string (`t.email.min(30)`) whose sample cannot meet its length bounds, and `describeSampleGap` names the bound.
- schema: a `.default()` holding a `Date` is published to JSON Schema / OpenAPI / MCP as its ISO string; a default with no JSON form (`Map`, `Set`, `bigint`, a cycle) is omitted. Runtime defaults are unchanged.
- manifest: a non-JSON schema default no longer yields a manifest failing its own `buildId`.
- realtime: the in-process transport expires shared-set keys nobody reads again; a presence room no longer stays in memory after it empties.
- realtime: a live query's policy gets the subscriber's context, so `ctx.actor` is the subscriber, as over HTTP.
- jobs: a scheduled task's jobs are queued under the tenant each declares — a per-org fan-out with one key is one row per org, on the memory and Postgres schedulers.
- jobs: a job fired by the Postgres scheduler carries its `traceparent` (and `enqueued_by`), so its run is a child of the fire's producer span.
- jobs: a proven cross-process wake is re-proven every 10 s (`reproveEveryMs`); a session that stops delivering is un-proven (`jobs.wake.lost`, warn) and the loops return to the 2 s poll until a notification crosses again (`jobs.wake.live`). The deadline counts from the proof's send; a pool that has not sent it by then is no verdict (the wake stays proven, and one proof is re-sent once the pool answers).
- render: an island boots with the props inside its own wrapper (a modal's island took the page's); the hydration runtime is +100 B per strategy.
- render: text in a JSX `<style>` / `<script>` is no longer HTML-escaped; `</script` still cannot close it, and a child thunk returning an element is called once, not twice.
- render: `X_ASSET_MISSING`'s fix names a path `asset()` accepts (`asset('assets/logo.svg')`).
- ui: deeply nested `![` no longer overflows the Markdown parser.
- ui: Escape in a `Popover` or `Menu` no longer also closes the enclosing `Dialog`.
- pwa: a precached or warmed page fetched through a redirect is served offline instead of a network error.
- action: an action's `Date` output reaches the typed client as a `Date`: `x-ultimate-dates` on the plain and the enveloped 200, and a `dates:` field on the streamed `done` frame, which `clientStream` revives. The body and OpenAPI are unchanged; an older server's frame is read as before.
- action, http: a fault after a streamed action's first chunk is recorded as the JSON path's is — the monitor (5xx), `hooks.onError` and the request log line, once per request (`reportLateFault`); a handler unwinding because the reader cancelled the body is not reported.
- action: `X_ACTION_STREAM_INVALID` names a stream action registered by `registerAction`, not `""`.
- action: the memory idempotency store no longer records a success inside a rolled-back memory transaction.
- action: a keyed action whose output is `undefined` replays from the Postgres store instead of failing with `X_OUTPUT_INVALID`.
- query: a download URL minted with a `null` or `[]` optional input member no longer fails with `X_QUERY_DOWNLOAD_TOKEN_INVALID`; when the URL round trip changes the input (`null`/`[]` arriving absent), the policy also judges the round-tripped input before the mint (`X_FORBIDDEN` otherwise), so a token never grants an input the policy did not admit.
- query: a deprecated download query's mint is counted in `deprecated_calls_total`.
- db: `rollback()` reverses the most recently applied migration (`applied_at`), not the highest id; a branch merged late is undone first instead of the previous release's migration.
- cache: Redis tier: a fill landing mid-bust could be left in no tag bucket and serve stale for its whole TTL; a bust now sweeps buckets before deleting values, and re-joins any member whose `UNLINK` was refused: 1,000 members per `ZADD … GT`, 8 commands in flight, each bucket it touches leased again, and a collection-tag bucket only gets back members whose stored value lists that tag.
- cache: an inbound invalidation broadcast from the same build no longer re-busts the shared Redis tier on every replica, which deleted freshly refilled values and cost an extra load per mutation.
- cache: `memorySemanticCache` hits are no longer the writer's live object.
- cache: the `X_CACHE_LIMIT_INVALID` fix for `defaultTtlMs` names `cache.defaultTtlMs` in `app.config.ts`.
- entity: a malformed uuid in `eq`/`neq`/`in`, `findById`, `update` or `delete` is "no such row" on Postgres as on memory, never `22P02`; every uuid spelling Postgres parses is one value in both drivers. An app test that asserts the Postgres driver's SQL text through a fake client with non-uuid ids on uuid columns now sees `1 = 0`.
- entity: one id the server refuses no longer fails the other point lookups batched with it.
- entity: an `in` list of 32,768+ values binds as one array, so a list past 65,535 answers on Postgres.
- entity: `like` on a uuid, boolean, timestamp, date, json or array column is `X_INVARIANT_VIOLATED` in both drivers (Postgres already failed with `42883`).
- entity: a `timestamp()` value outside years 0001–9999 is refused on write and as an operand in both drivers; existing rows still read.
- entity: `avg()` and `aggregate({ fn: 'avg' })` keep six exact decimals at any magnitude on Postgres.
- Unknown-command fixes name the intended command (`x migrate` → `x db migrate`), never a top-level `migrate`, `start` or `check` that does not exist.
- `x merge-driver` resolves CRLF files and never exits 0 over a conflict marker.
- A dev lock naming a reused pid no longer blocks `x db reset|status|diagnostics|recount`; `x stop` clears it.
- `X_NOT_IN_APP`'s fix keeps the subcommand and arguments (`x db migrate`, not `x db`).
- `x dev --role ,` is `X_CLI_BAD_FLAG`, not a dev server running no role.
- ci: workflows that push a branch with the job token (security-channel, bench) dispatch `ci.yml` on it, so their pull requests get a verify check.
- ci: `release.yml` makes up to three attempts at a failed npm publish, re-asking `npm view` before each.
- ci: `next-sync` files its tracking issue when the merge job fails, not only on conflicts.
- ci: `release-tag`'s queue moved onto the cut job, so a non-release CI completion can no longer cancel a pending release.
- scripts: `config-readers` counts only a qualified read, not a bare property name.
- http: a handler that settles just after the request deadline can no longer replace the 504: the answer is the deadline race's winner only, so a late fallback never leaves without security headers, request id or cookies; a stream the orphan built is cancelled, never the 504's own body.
- http (security): `ctx.peer` reads `x-forwarded-client-cert` from the right, only the elements the trusted hops appended — a quote or backslash the client wrote before them can no longer merge elements and name the peer (`URI=…;X="` ahead of a proxy element whose Subject escapes a quote).
- action: a streamed action's `chunk` frames carry a `dates:` line, so instants in a chunk revive as `Date` like the `done` frame's.
- action: a group-commit audit batch that commits but loses its reply no longer stores every record twice: each accepted write keeps one row id through the single retry, and both `x_audit` inserts skip a row already stored with identical facts. A different row under the same id still fails with `unique_violation`. `memoryAuditSink` behind `batchedAuditSink` keeps such a record once.
- core: `outbound()` — a call cancelled by its own `signal` neither retries nor spends the breaker key's retry budget (six cancels emptied it); a 3xx whose `Location` does not parse is `X_OUTBOUND_REDIRECTED` after one attempt (was `X_OUTBOUND_UNREACHABLE`, retried 3×).
- core: the logger redacts an `UltimateError` field's `meta` by key (`password`, `authorization`, `apiKey`, …) the same as a plain field.
- core: `clientStream` revives `Date`s on `chunk` frames that carry a `dates:` line; a stream cut mid-body or a non-JSON frame is `X_CLIENT_TRANSPORT_FAILED` (`failure: 'network'` / `'body'`), never a bare `TypeError` / `SyntaxError`.
- core: `PGSSLMODE` is listed in `FRAMEWORK_ENV`.
- realtime: a channel whose bus subscribe was refused (NATS reconnecting) asks the bus again on the next subscribe; every later subscriber got the old failure while any subscribe to that topic was in flight.
- jobs: a worker claim round whose fleet-slot acquire threw still logs, counts and announces the rows the same claim dead-lettered (`jobs.claim.exhausted`, `jobs_total{outcome=dead}`, `onSettled`).
- jobs/redis: an `onConflict: 'replace'` debounce fence expires with its row; a server debouncing per entity no longer grows one `:debounce` field per key forever. An existing hash drains on its own.
- ai: a failed `agent().run()` / `.continue()` leaves a handle (`transcriptOf(error)`) holding every tool result its last turn completed — a throwing `onCheckpoint`, `X_AGENT_TOOL_LOOP`, the deadline or an abort no longer make the continuation run the same tools (a charge) again; a call cut off in flight is answered "Interrupted: … outcome is unknown", one never started "Not run".
- ai: `openAiProvider()` no longer claims `strict` for a schema with an optional key inside an `anyOf` branch.
- ai: a whitespace-only assistant text is no longer replayed by `agent()` or `llm()`'s repair turn.
- ai: an agent offering no tools of its own can compact on the chat-completions wire: the summary call is no longer forced through `respond`.
- ai: compaction keeps what the user said in the summarised turns (a `.continue()` instruction) verbatim in the first message, up to 8,000 characters in total across every compaction, newest first, and no longer deletes a prompt block that merely starts with `[compacted:`.
- ai: non-finite or negative usage from an app-written `Provider` no longer poisons the budget counter; each of the four counters is screened (a negative one offset by a positive one no longer refunds), the reservation's estimate stands and `ai.budget.usage_invalid` is logged.
- ai: `chunkDocument` never returns a chunk over `size`.
- db: a read carrying a `minPosition` no longer waits on a parked replica: it goes straight to the primary, with no statement sent to the standby.
- db: the `X_MIGRATION_CONFLICT` psql hint for an unknown `down` orders by `applied_at desc, id desc`, the order `rollback()` reverses in.
- mail: an RFC 5322 comment containing a colon (`(sent via: phone) jane@x.test`) is no longer read as a group name.
- scraping: a password input whose earlier attribute holds a quoted `>` is blanked in failure artifacts; the tag scan is one linear pass (the old regex was quadratic on a page of unclosed `<input`).
- pwa: the `subscribePush` that `subscribeSource()` emits replaces an existing subscription made with another VAPID key, as `subscribeToPush` does.
- render: a soft navigation to a URL whose fragment has a malformed percent-escape (`/b#50%`) lands: scripts run and `ultimate:navigated` fires.
- ui: a `DateRangePicker` calendar pick calls `onChange` once, with the range the pick made; a sortable item deleted by a live update while lifted no longer blocks keyboard sorting of every other item, nor is lifted again when it is reinserted.
- admin: a resource keyed on `integer().primaryKey()` works: detail, edit, delete, row actions and batches found no row (404) and update threw.
- cli: `x g resource|entity|policy` grant into the module that calls `defineRoles` when `apps/web/shared/roles.ts` is absent; the `define-error-leaf` codemod rewrites aliased and trailing-comment imports and reports any shape it leaves; `x db seed` discovers a seed once when a second module re-exports it; `x shot --island` renders the island's props inside its element; the jobs retry is installed in every role's boot, not only where the worker config is read.
- ci: `tutorial-run.yml` also runs weekly, and `scripts/health.ts`'s `tutorials-run` row treats a newest `main` run over 8 days old as stale (no run at all is unverdicted); a new `next-sync` row reports a red or stalled weekly main→next merge. The deploy proof's Postgres image is pinned by digest.
- guards: `test-real-sleep` catches `node:timers/promises` `setTimeout(ms)` / `setInterval(ms)` and `scheduler.wait(ms)`; `framework-env` catches a destructured `const { X } = process.env`.
- On the embedded development database (`development`, no `DATABASE_URL`), `X_MIGRATION_CONFLICT` and `X_MIGRATION_ROLLBACK_DESTRUCTIVE` lead their fix with `x stop --json && x db reset` (and `x db rollback` where a restored file makes it possible) instead of `psql "$DATABASE_URL"` and `x deploy --image`, which have nothing to dial there. Production, staging, test and an external database print what they printed.
- `x db gen` names both migrations when a change needs a second, non-transactional one.
- When the test services cannot start and a floored `live` step ran nothing, the step's finding is `X_TEST_SERVICES_UNAVAILABLE` with its working fix, not `X_VERIFY_SUITE_VANISHED`.
- A stopped test stack left under this app's compose name by another checkout is reported as stopped, with `docker compose -p <name> down --volumes` as the fix, never as "already running".
- `X_TEST_FAILED` names up to five failing test files, and its fix reruns the first one alone (`x test <type> --filter <file> --workers 1`).
- A gate step that throws a coded error reports that error's code and fix inside `X_VERIFY_FAILED`, not `x verify --json`.
- `X_BOUNDARY_SITE_TO_APP` is one finding per crossing import, at the file that crosses: a `site/` page importing an `app/` query no longer also reports that query's own `app/ → app/` imports (its policy, its repo) as edges to delete, in `x verify` and in `x fix boundary`.
- `x errors explain X_TENANCY_UNSCOPED` prints the fix for the code's general cause (run inside a context whose actor carries the org) instead of the upsert's `onConflict` fix.
- `X_CATALOG_MISSING_KEYS`'s fix comment, from the CLI, says what `x i18n sync <locale>` writes for that locale: `⟦key⟧` in the default locale, `⟦the default locale's string⟧` in any other, and the generated label for a mounted admin's keys.
- A deploy that cuts a running job at the drain cut-off exits 0 again, not 70 with `X_SHUTDOWN_TIMEOUT`.
- `x tasks run`, `x jobs` and `x db backfill` stamp the app's `jobs.maxAttempts` / `jobs.backoff` on what they enqueue (they stamped the framework's 3).
- `x db gen`: dropping a column that a partial index's predicate, an expression index or an `include` list reads restores that index in the drop's own `down` and emits no follow-up step (the follow-up's `down` failed 42703 on rollback).
- action: when the single retry after a lost batch reply draws `unique_violation`, `postgresAuditSink` re-sends it once.
- entity: a batched point read whose bisected half fails for its own reason (a pool timeout, a failover) reports that reason, not the other id's "invalid input syntax".
- i18n: `catalogSubset` lists a translator's keys once; a subset no longer scans the whole catalog per call, and its first call indexes `_select_*` / `_ordinal_*` families in linear time.
- ui: hotkeys ignore Safari's IME-confirming Enter (`keyCode 229`), like every other field that owns Enter.
- mcp: `db.query` refuses `explain ("analyze") …`, the quoted option form, as it already refused `explain (analyze)`.
- The `/_x` policy panel no longer shows a deny, or calls a permission unreachable, for a rule whose predicate reads request input: the cell says `needs input`, as `x policy explain` does.
- `x upgrade` recognises an unedited `undeclared-env` guard copy from an earlier release again; its released-form hash had been overwritten by a later refresh.
- scripts: the public-API lock judges an optional trailing parameter added to a class method as compatible, as it does for a function.
- core: `defineEnv`'s fix leads with the generated command (or the first declared fix) and keeps every other key's declared fix beside it; a declared remediation was dropped.
- The pasted call in the fix of `X_CONFIG_INVALID` (`cache.defaultTtlMs`), `X_TEST_POLICY_EXPECTED`, `X_TEST_OPENAPI_EXPECTED` and `X_TEST_NUMBER_EXPECTED` ends in a `//` comment, so it parses; prose was spliced onto the call.
- test(action, query): browser client bundle pins raised by measured growth — rpc 25,281 B (≤ 25,303), query client 16,182 B (< 16,186): `clientStream`'s chunk `dates:` revival and coded mid-body cut (+272 B), and the unkeyed-write-once rule (+31 B).
- **examples/dummy:** six route budgets raised by their measured growth against origin/main built the same way — `/feed` `211kb` → `211.4kb`, `/posts/board` `110.5kb` → `111.3kb`, `/posts/new` and `/runs/health` `33.1kb` → `33.2kb`, `/runs` `243.6kb` → `244.3kb`, `/settings` `107kb` → `107.8kb`: the hydration runtime's own-wrapper props (+100 B), the router's fragment fixes (+45 B), `clientStream`/`clientTransport` (+31 B in the page boot, about +300 B in each island calling `rpc`), and the ui, i18n and `isRtl` fixes each island carries. The numbers per chunk are in the comment above each budget, where `bun run budget-raises` reads them.

## Releases

| Version | Date | Summary |
|---|---|---|
| [31.48.0](docs/changelog/31.48.0.md) | 2026-11-19 | **Many agents, one machine:** heavy commands reserve their measured memory in one machine-wide ledger and share a local core cap, so parallel agents queue instead of swamping the box. `x heavy status` shows who runs and who waits. |
| [31.47.1](docs/changelog/31.47.1.md) | 2026-11-18 | **`x upgrade` leaves an old app green:** an app with pages but no `site/page.tsx` gets a working e2e suite or a stated skip, `test-ports` moves both files or neither, old scaffold guard copies are recognised, and re-running at the target version changes nothing. |
| [31.47.0](docs/changelog/31.47.0.md) | 2026-11-18 | **The finish sweep (plan 101):** a replayed offline write is bound to the principal that queued it, the gate's `exercise` step gives the same verdict for the same code, scaffolded apps run their full CI weekly and open one issue on a scheduled failure, and every known gap, stub and exemption now carries a decision or is gone. |
| [31.46.0](docs/changelog/31.46.0.md) | 2026-11-18 | **One redirect path for a browser's form (D10):** the sign-in and invite actions `x g sign-in` and `x g invite` write answer a native form post through `native:` alone, and the hand-written `landAt()` helper is gone. The generated tests now post a real form through the HTTP pipeline. A fresh saas app gates green with no `X_NATIVE_FORM_UNANSWERED`. |
| [31.45.0](docs/changelog/31.45.0.md) | 2026-11-18 | **Faster, steadier CI, and what the adopter rollout taught:** |
| [31.44.0](docs/changelog/31.44.0.md) | 2026-11-17 | **Audit rounds 5 and 6 (plan 101b, slice 20), security first:** |
| [31.43.0](docs/changelog/31.43.0.md) | 2026-11-17 | **Audit round 4 (plan 101b, slice 20):** OAuth client-metadata fetches are metered for every caller; presence leave frames fit the client's frame limit; the `assets.retain` sweep no longer deletes a file another pod's publish reused; `x upgrade` survives a reused pid; scaffold CI pins every action by SHA; one env declaration form, `envSchema`. Each fix has a test that failed first. |
| [31.42.1](docs/changelog/31.42.1.md) | 2026-11-17 | **An s3 disk on R2 (or any endpoint) works in its default addressing:** the Bun client reached the account root instead of the bucket, so reads, lists and `assets.retain` failed unless `S3_FORCE_PATH_STYLE=1` was set. |
| [31.42.0](docs/changelog/31.42.0.md) | 2026-11-17 | **The gate's `live` step holds a strict floor to its word:** a `live` test that skipped with the database in reach is red, and a runner with no database stays a warning. The signal travels through `--json` to `x verify merge`. |
| [31.41.0](docs/changelog/31.41.0.md) | 2026-11-17 | **Audit round 3 (plan 101b, slice 20), its P2s:** `x dev`'s rebuild, the schema wait under an early SIGTERM, the test-services stack for older apps, and the docs the auditors falsified, plus three regressions an adopter's upgrade surfaced. Each fix has a test that failed first. |
| [31.40.1](docs/changelog/31.40.1.md) | 2026-11-17 | **Audit round 3 (plan 101b, slice 20), its security half:** the realtime channel tenant leak (P0) and two P1s, each with a test that failed first. The round's P2s follow in the next release. |
| [31.40.0](docs/changelog/31.40.0.md) | 2026-11-17 | **Audit round 2 (plan 101b, slice 20):** six read-only auditors (bugs in the unread tiers, concurrency, security on injection and secrets, a DX pass, an architecture review). Every confirmed finding is fixed, each with a test that failed first. Counts: P0 0 · P1 6 · P2 22 fixed (the DX pass by real use: 2 P1, 10 P2), plus 2 P2 parked for the next major or deferred to round 3. |
| [31.39.0](docs/changelog/31.39.0.md) | 2026-11-17 | **Audit round 1 (plan 101b, slice 20):** four read-only auditors, production evidence and the open issues. Every confirmed finding is fixed, each with a test that failed first. The security fix ships separately in 31.38.1. |
| [31.38.1](docs/changelog/31.38.1.md) | 2026-11-16 | **Security: live queries no longer cross tenants on a tenant column not named `orgId`.** Upgrade; no code change needed. |
| [31.38.0](docs/changelog/31.38.0.md) | 2026-11-16 | **Eight app shapes, each gated twice in CI.** `x new <name> --shape saas \| agent \| realtime \| content \| offline` join `api`, `dashboard` and `blog`: |
| [31.37.0](docs/changelog/31.37.0.md) | 2026-11-16 | **CI is faster where it was slowest.** Shards are dealt on measured per-file time, with 4 unit shards and 3 live shards: the slowest unit part went from 415 s to 315 s on CI. |
| [31.36.0](docs/changelog/31.36.0.md) | 2026-11-16 | **A fix line opens with what to paste or run.** 917 `fix:` lines across every package and the repository scripts opened with a sentence; 862 now open with a command, a code shape (`policy: '<resource>:<verb>'`, `assertCurrency('USD')`, `` sql`…` ``) or an `edit <file>:<line> — …`, with the old instruction after it as a comment. The 55 that remain carry a reason per package in `scripts/lib/fix-prose-pins.ts`: a remedy that is judgement, or one at a call site the thrower cannot see. |
| [31.35.0](docs/changelog/31.35.0.md) | 2026-11-16 | **The error reference is an index plus one page per owner**, as the changelog is. `wiki/Error-Codes.md` was one 627 KB page of 1,358 rows. It is now: |
| [31.34.0](docs/changelog/31.34.0.md) | 2026-11-16 | **A test states its own verdict with `expect`, never a bare `Error`** (plan 101b slice 12 M6, third PR). 80 sites where a test threw a bare `Error` to fail itself now use `expect.unreachable` or a direct assertion: `realtime`, `http`, `query`, `db`, `entity`, `seo`, `cli`, `jobs`, `testing`, `admin`, `ai`, `auth`, `render` and `ui`. Several were silently weak, a throw the subject or the test's own handler swallowed, and are stronger now: `auth`'s JWKS "never asked for a key", `ai`'s SSE frame count. Every remaining pinned site is an INPUT, a stub that throws at the subject, and its row says what it simulates. |
| [31.33.0](docs/changelog/31.33.0.md) | 2026-11-16 | **Every shipped source file opens with its 1–4 line responsibility header, and every `node:` import says why Bun cannot do the job** (plan 101b slice 12 M6, second PR). The `source-headers` pin table is empty: 316 rows fell. `node-imports` fell from 173 explained-or-not sites to 0. Where Bun has the same API, the import is gone instead: `Bun.CryptoHasher` in `@ultimat3/entity`'s seed ids (pinned by a known-answer test against an independent uuid5), `Bun.file().exists()` in four `x verify` readers, and `Bun.Glob` and `Bun.pathToFileURL` in tests. |
| [31.32.0](docs/changelog/31.32.0.md) | 2026-11-16 | **The security and robustness ratchets are burned down** (plan 101b slice 12 M6). Every site eight guards pinned across `cli`, `scripts` and every package was repaired, or keeps one row with a permanent written reason. Done by the guards' own repair, never a dodge: |
| [31.31.0](docs/changelog/31.31.0.md) | 2026-11-16 | **The `next` lane runs itself up to the merge.** `next-sync.yml` merges `main` into `next` weekly. `scripts/release-due.ts` reports `data.nextLane`: once the major window is open and `next` is green and ahead, it proposes the `chore: release X.0.0` PR, which a person merges. `scripts/next-breaks.ts` renders the tracking issue of every parked break, cited at the line that parked it. |
| [31.30.0](docs/changelog/31.30.0.md) | 2026-11-16 | **Test determinism.** One helper per flake class in `@ultimat3/testing` and one guard per unsafe form, each pin table empty: |
| [31.29.0](docs/changelog/31.29.0.md) | 2026-11-15 | A deploy no longer crash-loops when roles start before migrate: a serving role whose framework schema or app migrations are behind its build **waits** (jittered backoff, one log line, `/healthz` 200 and `/readyz` 503 on its own port), serves once the migrate step lands, and exits with `X_FRAMEWORK_SCHEMA_UNAPPLIED` / `X_APP_MIGRATIONS_UNAPPLIED` after `ULTIMATE_SCHEMA_WAIT_MS` (default 5 minutes; `0` refuses at once). |
| [31.28.0](docs/changelog/31.28.0.md) | 2026-11-15 | `x upgrade` carries an app's scaffold files forward with **codemods**: every scaffold-owned change between your version and the target is applied, and a file you edited is listed with its diff and never overwritten. Apps scaffolded at 31.4, 31.15, 31.20 and 31.22 reach 31.28.0 with no hand edit (`scripts/upgrade-fixtures.ts`, run in CI). |
| [31.27.0](docs/changelog/31.27.0.md) | 2026-11-15 | `x verify` cannot pass on a skipped step: every step that ran no check is listed as `skipped: <reason>` (`data.skipReasons`), and `x.verify.json` gains `strict` — with `strict: true` every step must run a check or carry a written `skip` why (`X_VERIFY_STRICT_UNRUN`); without it, a warning names the steps an app never runs. New scaffolds are strict and run `live` against real Postgres and `e2e` in a real browser. |
| [31.26.0](docs/changelog/31.26.0.md) | 2026-11-15 | `llm()` and `agent()` take `fallbackModels`: an ordered list tried on a declared failure class (rate limited, overloaded, timeout, unavailable), every attempt billed at its own model's price and traced under one span; and a typed `providerOptions` bag, validated per wire before any request. |
| [31.25.0](docs/changelog/31.25.0.md) | 2026-11-15 | `limiter(name, { rate, concurrency })` is a named fleet budget every job naming it spends (`job({ limiter })`); a run over it is deferred, never dead-lettered. |
| [31.24.0](docs/changelog/31.24.0.md) | 2026-11-15 | A policy `scope` takes `or`, `and` and `via` (a hop into another entity, `col in (select …)`), compiled to one statement and tenant-scoped inside every hop — `andWhereNode()` on the chain; a custom driver declares `predicate:or` / `predicate:via` or is refused. |
| [31.23.0](docs/changelog/31.23.0.md) | 2026-11-14 | A retried job attempt no longer pages: it counts on `jobs_retried_total{job,code}`, and only a dead letter reaches the error tracker, once, as `error`. A job opts its retries back in with `retry: { report: 'every-attempt' }`. |
| [31.22.3](docs/changelog/31.22.3.md) | 2026-11-14 | The Redis cache bus never unsubscribes a channel its connection already holds, so a peer's invalidation sent while a node boots is no longer lost (#1132). |
| [31.22.2](docs/changelog/31.22.2.md) | 2026-11-14 | `x dev` holds a stale module pin until the process restarts, so a second save tick never reports "reloaded" over a read still serving the old service, and `/_x` keeps `X_DEV_RESTART_REQUIRED` until the restart. |
| [31.22.1](docs/changelog/31.22.1.md) | 2026-11-14 | `postgresAuditSink({ groupCommit: true })` sends each batch outside any caller's transaction, so one request's rollback no longer loses other requests' audit rows. |
| [31.22.0](docs/changelog/31.22.0.md) | 2026-11-13 | Agent tooling: the format hook `x new` writes now runs (it read a variable Claude Code never sets); the dev MCP server gains `docs.search`, `db.explain`, `requests.statements` and `verify.narrow`; `x docs` answers task phrasing. |
| [31.21.0](docs/changelog/31.21.0.md) | 2026-11-13 | `x verify`'s `drift` step warns `X_DB_INDEX_UNDECLARED` for an index in the schema dump that neither the newest migration snapshot nor any entity declares — the shape that hid seven duplicate indexes in production. A warning in 31.x. |
| [31.20.0](docs/changelog/31.20.0.md) | 2026-11-13 | Security: a revoked, expired or forged session no longer keeps its live-query socket streaming after sign-out, and a stale session cookie no longer answers 401 on every route. Existing apps are protected by upgrading; the `x new` and `x g sign-in --oidc` templates return `null` for a session refusal. |
| [31.19.0](docs/changelog/31.19.0.md) | 2026-11-13 | A release commit no longer cold-installs on every CI job: the bun cache is keyed on the packages `bun.lock` resolves, not the whole file. |
| [31.18.1](docs/changelog/31.18.1.md) | 2026-11-13 | `x exercise` on a large app is about a quarter faster (494 s → 380 s on a 487-primitive app): the seed solver no longer re-tries every parent earlier tenants took, crash-proof id renaming is one pass, and the frozen clock no longer throws per bound string. Findings, verdicts and seed graphs are unchanged. |
| [31.18.0](docs/changelog/31.18.0.md) | 2026-11-13 | The admin search ignores case and reads four resources at a time; a declared row scope stays case-sensitive, because it is authorization. |
| [31.17.0](docs/changelog/31.17.0.md) | 2026-11-13 | New commands: `x token` (API keys), `x config show` (redacted), `x logs tail`, `x cache graph\|bust\|clear`, and `x explain <query>` (plans what a query actually sends, never against production). |
| [31.16.0](docs/changelog/31.16.0.md) | 2026-11-13 | `x exercise` is fairer and stricter: a refused test-seed table is one finding instead of every check going unproven, one call is held to 100 statements (loops declared with `expectedQueryLoop` excluded), and a data-dependent branch no longer reads as an N+1. `x.verify.json` `exercise.unprovenMax` / `statementsMax` floors are red when declared, warnings otherwise. |
| [31.15.0](docs/changelog/31.15.0.md) | 2026-11-12 | An island whose render throws keeps its server HTML instead of going blank (`mountOver`, used by `x g island`, `x new` and the resource form; the `island-mount-clears` guard finds older islands). |
| [31.14.0](docs/changelog/31.14.0.md) | 2026-11-12 | A deploy no longer reloads every live query: a replicator that stops cleanly hands over to its successor (change envelope v2), so sync nodes keep their windows; a crash still re-reads, once. Roll sync nodes before the replicator to get it on the first roll. |
| [31.13.1](docs/changelog/31.13.1.md) | 2026-11-12 | Security: the framework's lockfile resolves `source-map-js` 1.2.2 (GHSA-68fv-2mgg-jv7q). Not reachable through `@ultimat3/render` — `sass` declares it but never loads it — so an app needs only `bun update source-map-js` to clear `bun audit`. |
| [31.13.0](docs/changelog/31.13.0.md) | 2026-11-12 | An idle job queue costs a quarter of what it did: a worker on two queues, the outbox relay and the scheduler leader send 543 statements an hour, down from 2,418 — workers rest until the next due row instead of claiming every 5 s, counters are batched, and lease renewals are HOT updates. |
| [31.12.0](docs/changelog/31.12.0.md) | 2026-11-12 | A page no longer stays unstyled after one stylesheet fails during soft navigation: the router does a full load instead of swapping in a page whose CSS did not load, and keeps the previous sheets. |
| [31.11.0](docs/changelog/31.11.0.md) | 2026-11-12 | Security: a `native:` form answer and `uploadFlow` are host- and row-guarded — a refused form never redirects off this host, and an upload's policy judges the row it attaches to. |
| [31.10.0](docs/changelog/31.10.0.md) | 2026-11-12 | Security: `subjectErase` now reaches `<table>_history` — every image naming the erased person is purged in the parent's transaction, including rows deleted earlier and images a `set null`/`cascade` write records. An undeclared history table is `X_SUBJECT_TABLE_UNDECLARED`. |
| [31.9.0](docs/changelog/31.9.0.md) | 2026-11-12 | Set-based entity writes: `db.x.where(…).updateAll(patch)` / `.deleteAll()` is one statement, and `updateMany([{ id, patch }])` writes 1,000 different rows in one statement. |
| [31.8.0](docs/changelog/31.8.0.md) | 2026-11-12 | A rate-limit check writes no WAL: `x_rate_limit` is unlogged at fillfactor 70 (2 WAL records per take → 0). |
| [31.7.0](docs/changelog/31.7.0.md) | 2026-11-12 | Security: a sealed column no longer enters a history image (its lookup ciphertext was an equality oracle), and the authorization server enforces each client's registered grants and auth method. |
| [31.6.1](docs/changelog/31.6.1.md) | 2026-11-11 | After a deploy, a CDN can no longer hand a page an island chunk from the previous build: every island and `/_x/assets` script is named by a hash of its final bytes (#1075). |
| [31.6.0](docs/changelog/31.6.0.md) | 2026-11-11 | `contract-diff` compares against the manifest as committed, so `x manifest` or `x g` can no longer rebaseline a breaking change away before the gate sees it. |
| [31.5.0](docs/changelog/31.5.0.md) | 2026-11-11 | One address no longer meets 429 on a cold page load: built, content-hashed assets spend a new `assets` rate-limit bucket (2,000 burst, 200/s) instead of `default`. Measured: 180 of 300 island-chunk GETs from one address answered 429 before, 0 after. |
| [31.4.2](docs/changelog/31.4.2.md) | 2026-11-11 | `launchChrome` no longer gives up on a cold Chrome that has already opened its debugging port: the connection now gets what is left of the 60 s launch deadline, not the 10 s per-call one. |
| [31.4.1](docs/changelog/31.4.1.md) | 2026-11-11 | An island that throws an app error code ships about half the bytes: import `defineError` from `@ultimat3/core/page` (12,019 B → 6,507 B). |
| [31.4.0](docs/changelog/31.4.0.md) | 2026-11-11 | `ROLE=migrate` loads 104 fewer modules (977 → 873): the framework schema now reads the auth tables from the new `@ultimat3/auth/schema` leaf instead of the whole auth package. |
| [31.3.0](docs/changelog/31.3.0.md) | 2026-11-11 | Read one row's recorded history in write order with `history(db.postsHistory, id)`: versions numbered from 1, scoped to the tenant. |
| [31.2.0](docs/changelog/31.2.0.md) | 2026-11-10 | `x build` and `x exercise` honour `runtime.ts`: an audit sink declared there makes audited pages measurable and audited primitives reachable. |
| [31.1.0](docs/changelog/31.1.0.md) | 2026-11-10 | `x affected`, `x verify --changed` and `x test --affected` measure a change against `origin/main` by default, not a local `main` nobody pulled, and `bun test $(x affected --paths)` receives only paths. |
| [31.0.0](docs/changelog/31.0.0.md) | 2026-11-10 | **v31 is the stable line.** 74 breaking changes — most delete a second way to do one thing, the rest are security fixes and limits — each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading#30x--3100-entry-by-entry). The next major comes no earlier than 2027-02-08, 90 days from today ([Stability](https://github.com/developerz-ai/ultimate/wiki/Stability)). |
| [30.9.0](docs/changelog/30.9.0.md) | 2026-11-09 | The test network seal is whole: every DNS resolver, `node:net`/`tls`/`http(s)`/`http2` and UDP are refused unless loopback, mocked or allowed — a test that reached the internet through one of them now fails, and `allowHost('<host>')` is the fix it prints. |
| [30.8.0](docs/changelog/30.8.0.md) | 2026-11-08 | Every primitive of a real app can be reached by `x exercise`: an entry can carry its call's cookies and headers, a job and an action of one name get separate entries, and a throwing entry is that primitive's record instead of the end of the pass. |
| [30.7.0](docs/changelog/30.7.0.md) | 2026-11-08 | `x exercise` runs at the size of a real app. A crash proof costs the same over 1,500 seeded rows as over 3: one job's proof cost a 504-primitive app most of a 172-minute pass. Every record and the report now say where the time went. |
| [30.6.0](docs/changelog/30.6.0.md) | 2026-11-08 | `x exercise` counts a job's own statements: never the jobs it queued, never jobs it found queued. A job that queues one child per row is no longer `X_QUERY_SCALES_WITH_ROWS`. |
| [30.5.0](docs/changelog/30.5.0.md) | 2026-11-08 | `x exercise` reports what a 5xx said, seeds a NOT NULL `json(t.json())` column, resolves mocked hosts under the sealed network, and names the step a crash-proof effect ran inside. |
| [30.4.0](docs/changelog/30.4.0.md) | 2026-11-07 | `x exercise` runs vendor-calling handlers for real under the sealed network: `defineExercise(overrides, { setup })` installs an app's `mockFetch` routes or `cassette()` for the pass. |
| [30.3.0](docs/changelog/30.3.0.md) | 2026-11-07 | `x exercise` seats a job in the tenant it is enqueued under, whatever field its `tenant(input)` reads: no more `X_JOB_TENANT_MISMATCH` (and `X_TENANCY_ACTOR_MISMATCH` inside) on a job whose org field the id binder did not recognise. |
| [30.2.0](docs/changelog/30.2.0.md) | 2026-11-07 | `seo: { llms: false }` hands `/llms.txt` to the app: an app serving its own no longer fails to boot with `X_ROUTE_CONFLICT`. |
| [30.1.0](docs/changelog/30.1.0.md) | 2026-11-07 | `x exercise` seeds a table with your own `defineFactory`, so an entity whose rows no generated value satisfies — a cross-column `satisfies`, a JSON column with required keys — runs the gate's `exercise` step. |
| [30.0.0](docs/changelog/30.0.0.md) | 2026-11-07 | One major for the whole of plan 101: every breaking change below lands here once, each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading). |
| [29.4.0](docs/changelog/29.4.0.md) | 2026-10-31 | Added · Changed |
| [29.3.2](docs/changelog/29.3.2.md) | 2026-10-31 | Added · Fixed |
| [29.3.1](docs/changelog/29.3.1.md) | 2026-10-30 | Fixed |
| [29.3.0](docs/changelog/29.3.0.md) | 2026-10-30 | Added · Fixed |
| [29.2.0](docs/changelog/29.2.0.md) | 2026-10-30 | Added · Changed |
| [29.1.0](docs/changelog/29.1.0.md) | 2026-10-29 | Added · Changed |
| [29.0.0](docs/changelog/29.0.0.md) | 2026-10-28 | Added · Changed · Fixed |
| [28.0.0](docs/changelog/28.0.0.md) | 2026-10-24 | Changed · Added · Fixed |
| [27.16.1](docs/changelog/27.16.1.md) | 2026-10-24 | Fixed |
| [27.16.0](docs/changelog/27.16.0.md) | 2026-10-23 | Added · Fixed |
| [27.15.0](docs/changelog/27.15.0.md) | 2026-10-22 | Added · Fixed |
| [27.14.1](docs/changelog/27.14.1.md) | 2026-10-22 | Fixed |
| [27.14.0](docs/changelog/27.14.0.md) | 2026-10-22 | Added · Fixed |
| [27.13.2](docs/changelog/27.13.2.md) | 2026-10-21 | Fixed |
| [27.13.1](docs/changelog/27.13.1.md) | 2026-10-20 | Fixed |
| [27.13.0](docs/changelog/27.13.0.md) | 2026-10-20 | Added · Fixed |
| [27.12.0](docs/changelog/27.12.0.md) | 2026-10-18 | Added · Changed |
| [27.11.0](docs/changelog/27.11.0.md) | 2026-10-17 | Fixed |
| [27.10.4](docs/changelog/27.10.4.md) | 2026-10-15 | Fixed |
| [27.10.3](docs/changelog/27.10.3.md) | 2026-10-15 | Fixed |
| [27.10.2](docs/changelog/27.10.2.md) | 2026-10-14 | Fixed |
| [27.10.1](docs/changelog/27.10.1.md) | 2026-10-12 | Fixed |
| [27.10.0](docs/changelog/27.10.0.md) | 2026-10-12 | Added · Changed · Fixed |
| [27.9.0](docs/changelog/27.9.0.md) | 2026-10-11 | Added · Fixed |
| [27.8.1](docs/changelog/27.8.1.md) | 2026-10-11 | Fixed |
| [27.8.0](docs/changelog/27.8.0.md) | 2026-10-11 | Added · Fixed |
| [27.7.0](docs/changelog/27.7.0.md) | 2026-10-10 | Fixed |
| [27.6.1](docs/changelog/27.6.1.md) | 2026-10-10 | Fixed |
| [27.6.0](docs/changelog/27.6.0.md) | 2026-10-10 | Added · Fixed |
| [27.5.0](docs/changelog/27.5.0.md) | 2026-10-10 | Added · Fixed |
| [27.4.0](docs/changelog/27.4.0.md) | 2026-10-09 | Added · Fixed |
| [27.3.0](docs/changelog/27.3.0.md) | 2026-10-09 | Added · Fixed |
| [27.2.3](docs/changelog/27.2.3.md) | 2026-10-09 | Fixed |
| [27.2.2](docs/changelog/27.2.2.md) | 2026-10-09 | Fixed |
| [27.2.1](docs/changelog/27.2.1.md) | 2026-10-09 | Fixed |
| [27.2.0](docs/changelog/27.2.0.md) | 2026-10-09 | Added · Fixed |
| [27.1.0](docs/changelog/27.1.0.md) | 2026-10-09 | Added |
| [27.0.0](docs/changelog/27.0.0.md) | 2026-10-09 | Changed · Added · Fixed |
| [26.1.1](docs/changelog/26.1.1.md) | 2026-10-08 | Fixed |
| [26.1.0](docs/changelog/26.1.0.md) | 2026-10-08 | Added · Fixed |
| [26.0.0](docs/changelog/26.0.0.md) | 2026-10-08 | Changed · Added |
| [25.2.0](docs/changelog/25.2.0.md) | 2026-10-07 | Added · Fixed |
| [25.1.0](docs/changelog/25.1.0.md) | 2026-10-07 | Added · Fixed |
| [25.0.0](docs/changelog/25.0.0.md) | 2026-10-07 | Added · Security · Changed · Fixed |
| [24.0.0](docs/changelog/24.0.0.md) | 2026-10-04 | Added · Changed · Fixed |
| [23.0.0](docs/changelog/23.0.0.md) | 2026-10-02 | Added · Changed · Fixed · Removed |
| [22.15.0](docs/changelog/22.15.0.md) | 2026-10-01 | Added · Changed · Fixed |
| [22.14.0](docs/changelog/22.14.0.md) | 2026-09-30 | Added |
| [22.13.0](docs/changelog/22.13.0.md) | 2026-09-29 | Added · Changed · Fixed |
| [22.12.0](docs/changelog/22.12.0.md) | 2026-09-29 | Added · Fixed |
| [22.11.0](docs/changelog/22.11.0.md) | 2026-09-29 | Changed · Added · Fixed |
| [22.10.0](docs/changelog/22.10.0.md) | 2026-09-29 | Added · Changed |
| [22.9.1](docs/changelog/22.9.1.md) | 2026-09-29 | Fixed |
| [22.9.0](docs/changelog/22.9.0.md) | 2026-09-29 | Added · Fixed |
| [22.8.2](docs/changelog/22.8.2.md) | 2026-09-28 | Fixed |
| [22.8.1](docs/changelog/22.8.1.md) | 2026-09-28 | Fixed · Added |
| [22.8.0](docs/changelog/22.8.0.md) | 2026-09-28 | Added · Changed |
| [22.7.1](docs/changelog/22.7.1.md) | 2026-09-28 | Fixed |
| [22.7.0](docs/changelog/22.7.0.md) | 2026-09-28 | Changed · Added · Fixed |
| [22.6.2](docs/changelog/22.6.2.md) | 2026-09-27 | Fixed |
| [22.6.1](docs/changelog/22.6.1.md) | 2026-09-27 | Fixed |
| [22.6.0](docs/changelog/22.6.0.md) | 2026-09-27 | Added · Changed · Security |
| [22.5.1](docs/changelog/22.5.1.md) | 2026-09-27 | Security |
| [22.5.0](docs/changelog/22.5.0.md) | 2026-09-27 | Added · Fixed |
| [22.4.0](docs/changelog/22.4.0.md) | 2026-09-27 | Added · Fixed |
| [22.3.6](docs/changelog/22.3.6.md) | 2026-09-26 | Fixed |
| [22.3.5](docs/changelog/22.3.5.md) | 2026-09-26 | Fixed |
| [22.3.4](docs/changelog/22.3.4.md) | 2026-09-26 | Fixed |
| [22.3.3](docs/changelog/22.3.3.md) | 2026-09-26 | Security · Fixed |
| [22.3.2](docs/changelog/22.3.2.md) | 2026-09-26 | Fixed |
| [22.3.1](docs/changelog/22.3.1.md) | 2026-09-26 | Added · Changed · Fixed |
| [22.3.0](docs/changelog/22.3.0.md) | 2026-09-25 | Added · Changed · Fixed |
| [22.2.2](docs/changelog/22.2.2.md) | 2026-09-25 | Added · Fixed |
| [22.2.1](docs/changelog/22.2.1.md) | 2026-09-25 | Fixed |
| [22.2.0](docs/changelog/22.2.0.md) | 2026-09-24 | Added · Fixed |
| [22.1.0](docs/changelog/22.1.0.md) | 2026-09-24 | Changed · Security · Fixed |
| [22.0.0](docs/changelog/22.0.0.md) | 2026-09-24 | Changed · Added · Fixed |
| [21.0.0](docs/changelog/21.0.0.md) | 2026-09-23 | Added · Fixed · Changed |
| [20.2.1](docs/changelog/20.2.1.md) | 2026-09-19 | Changed · Fixed |
| [20.2.0](docs/changelog/20.2.0.md) | 2026-09-19 | Added · Fixed |
| [20.1.6](docs/changelog/20.1.6.md) | 2026-09-18 | Fixed |
| [20.1.5](docs/changelog/20.1.5.md) | 2026-09-18 | Fixed |
| [20.1.4](docs/changelog/20.1.4.md) | 2026-09-18 | Added · Fixed |
| [20.1.3](docs/changelog/20.1.3.md) | 2026-09-18 | Fixed |
| [20.1.2](docs/changelog/20.1.2.md) | 2026-09-16 | Changed · Fixed |
| [20.1.1](docs/changelog/20.1.1.md) | 2026-09-12 | Fixed |
| [20.1.0](docs/changelog/20.1.0.md) | 2026-09-12 | Added · Changed · Fixed |
| [20.0.0](docs/changelog/20.0.0.md) | 2026-09-08 | Added · Changed · Fixed |
| [19.4.0](docs/changelog/19.4.0.md) | 2026-09-08 | Added |
| [19.3.3](docs/changelog/19.3.3.md) | 2026-09-07 | Added |
| [19.3.2](docs/changelog/19.3.2.md) | 2026-09-07 | Added · Fixed |
| [19.3.1](docs/changelog/19.3.1.md) | 2026-09-06 | Fixed |
| [19.3.0](docs/changelog/19.3.0.md) | 2026-09-06 | Removed · Fixed |
| [19.2.0](docs/changelog/19.2.0.md) | 2026-09-06 | Added · Changed · Fixed |
| [19.1.3](docs/changelog/19.1.3.md) | 2026-09-06 | Fixed |
| [19.1.2](docs/changelog/19.1.2.md) | 2026-09-06 | Fixed |
| [19.1.1](docs/changelog/19.1.1.md) | 2026-09-05 | Fixed |
| [19.1.0](docs/changelog/19.1.0.md) | 2026-09-05 | Fixed · Changed · Not changed, and the evidence for why |
| [19.0.0](docs/changelog/19.0.0.md) | 2026-08-27 | Added · Fixed · Changed · Not changed, and the evidence for why |
| [18.0.0](docs/changelog/18.0.0.md) | 2026-08-27 | Added · Changed · Fixed |
| [17.0.0](docs/changelog/17.0.0.md) | 2026-08-26 | Added · Changed · Fixed · Removed |
| [16.0.0](docs/changelog/16.0.0.md) | 2026-08-26 | Added · Fixed · Changed |
| [15.0.0](docs/changelog/15.0.0.md) | 2026-08-25 | Fixed · Changed · Known |
| [14.0.0](docs/changelog/14.0.0.md) | 2026-08-25 | Added · Fixed · Changed |
| [13.0.0](docs/changelog/13.0.0.md) | 2026-08-25 | Added · Fixed · Changed |
| [12.0.0](docs/changelog/12.0.0.md) | 2026-08-24 | Security · Fixed · Added · Removed · Changed |
| [11.3.0](docs/changelog/11.3.0.md) | 2026-08-24 | Fixed · Added · Changed |
| [11.2.0](docs/changelog/11.2.0.md) | 2026-08-23 | Added · Fixed · Changed |
| [11.1.0](docs/changelog/11.1.0.md) | 2026-08-23 | Added |
| [11.0.0](docs/changelog/11.0.0.md) | 2026-08-23 | Added · Changed · Fixed |

## Older releases

`10.0.0` and everything before it are **in git history, not in this file**. No length cap is
enforced: trimming is a deliberate edit that deletes the oldest `## X.Y.Z` sections, because a
changelog nobody scrolls to the bottom of is a changelog nobody reads, and every deleted line is
one `git show` away.

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
