# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Declare `@ultimat3/*` at `^<version>`, as `x new` writes, and let `bun.lock` pin the build; keep every one on the same version, since a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers. From 23.0.0 on, each `BREAKING —` line names its migration as `(#N)` straight after the dash — row N of that major's `Entry by entry` table in Upgrading — and `bun run changelog-check` refuses a line without one (`X_DOC_MIGRATION_UNPAIRED`).

**Majors 1 through 30 were the pre-stability line**: shipped from 2026-08 under semver, often weeks apart, each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading). v31 is the stable line: from it, at most one major every 90 days (`X_RELEASE_MAJOR_WINDOW`), breaking changes wait on `next` (`X_BREAKING_ON_MAIN`), and the previous major gets security fixes for six months — [Stability](https://github.com/developerz-ai/ultimate/wiki/Stability).

## [Unreleased]

### Highlights

- Agent tooling: the format hook `x new` writes now runs (it read a variable Claude Code never sets); the dev MCP server gains `docs.search`, `db.explain`, `requests.statements` and `verify.narrow`; `x docs` answers task phrasing.
- Two report-only guards ship: `repo-await-in-loop` and `repo-unbounded` (a bare `.all()` stops at 50 rows). A guard may declare `severity: 'warning'`; `x doctor` warns about a missing shipped guard.
- Framework tests have no unexplained wall-clock wait left, and every test file can run again in one process (`--rerun-each`), so CI's flaky-test job only reds a real flake.
- The public API lock tells an additive change from a breaking one.

### Added

- The dev MCP server has four more tools (23 in all): `docs.search` (`x docs` as a tool), `db.explain` (the plan of one `SELECT`/`WITH … SELECT` as `EXPLAIN (FORMAT JSON)`; `analyze: true` executes it inside `db.query`'s SELECT-only role, read-only transaction and 5 s timeout, and a production database is refused as `x explain` refuses it), `requests.statements` (the running `x dev`'s per-request statement ledger — SQL count, repeated statements and N+1 verdicts — or `X_NOT_IMPLEMENTED` naming `x dev` when none runs) and `verify.narrow` (`{ file }` → the steps `x verify --changed` selects for it and the narrowest commands, its tests first; runs nothing). `schema.describe` takes `{ entity }` — a name or a table — and an unknown one answers the names there are.
- Two shipped guards, **report-only**: `repo-await-in-loop` (`X_REPO_AWAIT_IN_LOOP`: an `await` in a loop body or a `.forEach`/`.map` callback in a `repo.ts`, one round trip per element; a loop inside `expectedQueryLoop` is declared) and `repo-unbounded` (`X_REPO_UNBOUNDED`: a `.all()` with no `.limit()`, whose fix names `.limit(n)`, `.inBatches(size)` and `.page()`). A guard that exports `severity: 'warning'` lists its findings on the `boundaries` step as warnings — in `--json` and on the step line — and never fails it; a finding that breaks the guard contract fails either way. `x new` writes 25 guards.
- `x verify --changed`: a route's `page.tsx` under `apps/<app>/site/` or `app/` is its own rule, `page` — `typecheck`, `lint`, `boundaries`, `filesize`, `i18n` and the suites, cut to that route's tests — where the `source` rule ran every step but `drift` (16 of 21 for a one-line page edit). An inner-loop answer: the full `x verify` stays the verdict.
- `x docs` ranks a task-phrased question: a synonyms table maps task words to the mechanism that does the task (`paginate` → `keyset`, `poll`/`interval` → `pollEvery`/`visibleInterval`, `concurrency` → `mapBounded`, `latest` → `latestBy`, `debounce`, `lockKeys`, `countedIn`, `retryMemo`), held by a test of ten questions and their expected pages. `x docs "paginate a query with a cursor"` answers `@ultimat3/db`'s `keyset` first. The docs site's `/search` ranks the same way — its island ships `searchDocs` — and its JS budget moves 18 → 19 kB (measured 18,940 B).
- `x doctor` warns `X_SHIPPED_GUARD_MISSING` for each shipped guard the app's `guards/` does not hold, with `x g guard <name> && x verify --only boundaries --json` — a warning beside the verdict, so the exit status is unchanged on `main`. It used to be a listing under "no findings — environment is shippable".
- The repository's agent harness (`.claude/`): a Stop hook that blocks once when `framework.manifest.json` or a tracked app's schema dump is stale for the uncommitted change, with the command that regenerates it; a PreToolUse hook that refuses `bun test packages/…` without the leading `./`; read-only commands that prompted are allow-listed (`git show`, `git ls-files`, `git for-each-ref`, `git stash list`, `npm view`, `gh pr checks`, `docker compose ps`, `bun run scripts/*.ts --check/--json`); `scripts/claude-harness.test.ts` holds every agent's and command's tools to what exists or `.mcp.json.example` wires, every allow rule to one Claude Code can match and every hook to a file that exists. `.mcp.json.example` wires the dev MCP for the reference app as `ultimate-dev` (the `mcp__ultimate-dev__*` every agent lists), and `bun run setup` copies it to the gitignored `.mcp.json` when absent.
- A scaffolded app's agents list the app's own MCP server (`mcp__<app>__*`), and its allow-list adds `bunx x impact`, `x graph`, `x affected`, `x exercise`, `x i18n sync`, `x fix boundary` and `x mcp tools`.
- Test-only registry restores, each the exact inverse of the package's own lister, for `@ultimat3/testing`'s rerun seam: `registeredServices()` / `restoreServices(registrations)` (and the `ServiceRegistration` type) in `@ultimat3/core`; `registeredOAuthProviders()` / `restoreOAuthProviders(providers)` in `@ultimat3/auth`; `restoreActions(actions)` in `@ultimat3/action/loader`; `restoreMails(mails)` and `restoreLayouts(registrations)` (and the `LayoutRegistration` type) in `@ultimat3/mail`, where `layoutFor(name)` is now public too. An app does not call them; `resetX()` stays the writer a test reaches for.

### Changed

- `x verify` and `bun run verify` without `--json` print each finished step to stderr for a person — `✓ lint 22.0s`, `○ seo 0.0s` for a step that did not apply, and for a red one its narrowest re-run (`✗ unit 3.1s → x test unit --filter <files> --json`, else `x verify --only <step> --json`). Under `--json` the line is the JSON one, as before.
- `x verify`'s `lint` step reports every format and import-order miss as ONE `X_LINT_FAILED` whose fix is a single `bunx biome check --write <file…>`; a lint-rule diagnostic stays a finding of its own.
- `x db gen`, `x db migrate` and `bun run setup` print a schema-dump refresh of more than five files as a count (`packages/db/schema/ +75`) instead of one path per line; `--json` still carries every path.
- The repository's PostToolUse hook runs: it read `$CLAUDE_FILE_PATHS`, which the harness never sets, so it formatted nothing. `.claude/hooks/after-edit.ts` reads the path from stdin (`tool_input.file_path`), runs `bunx biome check --write` on it and `bun run boundaries` for a package file, and shows Claude what it cannot fix. `x new`'s `.claude/settings.json` runs `.claude/hooks/format-edited.ts` the same way (matcher `Edit|Write|MultiEdit`).
- The git guard hook allows `git stash list` and `git stash show`, and judges only checkouts of this repository; `snapshot-tree.sh` records a snapshot only when tracked files differ from `HEAD` and the caller is not a read-only agent, and deletes snapshots older than 7 days. `.claude/commands/feature.md` is cut to what `CLAUDE.md` does not say (16 KB ceiling, pinned in `scripts/claude-md-size.ts`); the history moved to `docs/history/feature-workflow.md`.
- `X_INPUT_INVALID` for a refused MCP tool argument names `tools/list` (the tool's `inputSchema`) in its fix; `x actions show`, which knows actions alone, stays the fix for an action's input.
- Framework tests: no test waits on the wall clock without saying why. `cli` went from 104 unexplained waits to 0 and `scripts` from 2 to 0 (88 replaced with an awaited event, an injected clock or fake timers); each of the 18 that wait on another process — Chrome, a child, Postgres, nats-server, the kernel — carries a `// real-clock:` reason. `scripts/lib/test-real-sleep-pins.ts` is empty: every package is pinned at zero.

### Fixed

- `x mcp serve --transport stdio` writes nothing but JSON-RPC to stdout: an app module that logged while the host loaded it (the reference app's demo-viewer warning) put its line ahead of the `initialize` reply. Logs go to stderr for the session.
- The reference app's org member reads (`ownersToText`, `digestRecipients`, `allDigestRecipients`) take every row, `.inBatches(500)`: `.all()` stopped at 50, so the 51st owner was never texted and the 51st opted-in reader never mailed. The post window orders and limits by `take`, where `.all()` cut it at 50 whatever `take` was. The demo's task-reset loop is declared with `expectedQueryLoop`.
- `docs/architecture/15-adding-a-feature.md`: the entity export is the singular (`post`, table `'posts'`), as `x g resource` writes it; a hardcoded string is `X_UNTRANSLATED_STRING` from the shipped guard; `X_IDEMPOTENCY_REQUIRED` and `X_JOB_DECLARATION_INVALID` say which job declarations each refuses. `scripts/architecture-codes.test.ts` holds every `X_*` code `docs/architecture/` names to a row in `wiki/Error-Codes.md`, an owning tracked app, or a stated reason.
- `bun run scripts/scaffold-smoke-overrides.ts` packs `packages/cli/wiki/` before pointing the smoke app at the checkout, so `x docs` on a `file:` install answers as a published one; CI's `scaffold-smoke` asks it a task-phrased question (`scripts/scaffold-agent.ts`).
- `@ultimat3/testing`: a test file loaded again in the same process (`bun test --rerun-each`, CI's `flaky` job) forgets everything it declared on its last run — in its module body, its hooks and its tests — before it declares again, so it no longer fails with `X_*_DUPLICATE`. A name a module it imported first evaluated meanwhile exports (`sendMailJob`) stays. It covers jobs, services, entities, actions, queries, mails, mail layouts and OAuth providers, each once its package is loaded. The 53 framework test files that could not run twice in one process now pass `--rerun-each 5` together. Reading a loaded module's exports never loads it again: a page a loader plugin imported under `?x-reload=` and a fixture since deleted is no longer an unhandled `ENOENT` at the file's end.
- Root scripts: `run()` (`scripts/lib/run.ts`) has one deadline, not two. Bun's spawn `timeout` raced its own timer at the same deadline, and when Bun's won, a hung child was reported as an ordinary non-zero exit (`timedOut: false`, exit 1 on Windows) instead of `X_SPAWN_TIMED_OUT`. The spawn now takes an abort `signal` that the timer fires after it has answered.
- The API lock tells an additive change from a breaking one: `scripts/lib/public-api.lock.json` (format 2) records each exported symbol's shape beside its hash — members with their optionality, parameters, return type — so a new optional member, a new optional trailing parameter or a parameter that accepts more is listed as `compatible` and recorded by `--write`, never reported as `X_PUBLIC_API_BREAK_UNDECLARED`. A removed or newly required member, a changed member or return type, a required parameter and anything unclassifiable stay breaks, each finding naming what broke. A format-1 lock is re-baselined from its release tags; the five warnings since 31.20.0 (`RedisPubSubOptions`, `RedisSubscriberLike`, `redisPubSubAt`, `NatsTransportOptions`, `SelectTransportOptions`) were all additive.

## Releases

| Version | Date | Summary |
|---|---|---|
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
