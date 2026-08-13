# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Pin `@ultimat3/*` exactly; a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers.

## [Unreleased]

### Changed

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

- **`x verify` counts skips apart from passes, and names them.** A step with nothing to check here is recorded green so the run continues, and the summary counted it among the passes — so a repo whose `job` and `eval` suites do not exist printed the same `all 17 steps passed` as a repo where both ran. The line is now `12 of 17 steps passed in 53224ms — 5 skipped: job, eval, drift, contract-diff, budgets` in this repo, and `14 of 17 steps passed in 11153ms — 3 skipped: e2e, contract-diff, roadmap` in the scaffolded app of [tutorial 2](https://github.com/developerz-ai/ultimate/wiki/Tutorial-02-First-Feature); `all {n} steps passed` survives only when nothing was skipped. `--json` gains `data.skipped`, the list of names beside `data.failed` (`steps[].skipped` is unchanged). Exit codes are untouched: a skipped step is still not a failure — it is now just impossible to mistake one for a passing one.

### Added

- **`x.verify.json` — the suite floor, so a step that once applied must keep applying.** Counting the skips made a vacuous gate visible; nothing made one fail. Delete a suite and its step goes from passing to skipped, and `x verify` still exits 0. The floor is this repo's committed claim about which steps it already runs — hand-written, read by the gate, written by nothing, because a gate that edits its own floor ratchets both ways:

  ```json
  {
    "steps": [
      "typecheck", "lint", "boundaries", "filesize", "package-shape", "errors",
      "unit", "contract", "live", "e2e", "manifest", "roadmap"
    ]
  }
  ```

  A step named there that reports nothing to check is recorded **failed and not skipped**, with `X_VERIFY_SUITE_VANISHED` and both edits that resolve it — so it lands in the failure count, in `data.failed`, and in every step table another gate parses. Not a breaking change for an existing app: a repo that commits no floor is not ratcheted and behaves exactly as before. A floor naming a step the gate does not run enforces nothing and is refused by the `manifest` step (`X_CONFIG_INVALID`), because a typo covering no suite is the same false green. This repo's own floor pins 12 of 17; `job`, `eval`, `drift`, `contract-diff` and `budgets` are the honest skips.
- **`setStatementObserver()` — the seam a statement-level diagnostic installs into.** `@ultimat3/db` emits no span, no counter and no log for a statement, so nothing above it can count one: the dev timeline's `repeatedSql` groups span names and has never seen a repository read, which makes an N+1 invisible by construction. The seam is one process-wide observer, the `setDbClient` shape, with a `StatementEvent` carrying `{ text, values, durationMs, rows, error?, attribution?, expected? }`:

  ```ts
  setStatementObserver({ onStatement: (e) => ledger.count(e.text) });
  setStatementObserver(undefined);   // production, and what every test must leave behind
  ```

  `attribution` — the `{ entity, op }` pair that would let a report read `50× findById on members` instead of 50 copies of one `select` — is declared and **not yet produced**: both funnels omit it, so every event today carries `attribution: undefined`. Its producer is `@ultimat3/entity`'s `postgresDriver()`, the last caller that still knows the entity and the operation once the SQL exists; until it lands, read the field as reserved rather than optional.

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

### Fixed

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

  `fresh: true` now skips the memo as well as the tiers, a memo being a cache whose lifetime is the request. That makes it the one way to read past a write made earlier in the same request: an action's `invalidates` drops tier entries, not memo entries.

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

- `x build --target binary` compiles but crashes at import: `FRAMEWORK_VERSION` reads `package.json` at module scope and a single-file executable has none.
- `docker-compose.prod.yml` declares a host port and `replicas: 3` together — two processes cannot bind one port. This is the rung-1 ceiling.
- The shared cache tier's Lua invalidation `DEL`s keys it never declared in `KEYS`, so it fails on Dragonfly and on Redis Cluster.
- `resolveEnvironment` now exists in both `core` and `seo` with different return types.

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
