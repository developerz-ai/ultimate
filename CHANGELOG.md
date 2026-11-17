# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Declare `@ultimat3/*` at the exact `<version>`, as `x new` and `x upgrade` write and `x doctor` holds an app to (`X_FRAMEWORK_PIN_RANGE`); keep every one on the same version, since a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers. From 23.0.0 on, each `BREAKING —` line names its migration as `(#N)` straight after the dash — row N of that major's `Entry by entry` table in Upgrading — and `bun run changelog-check` refuses a line without one (`X_DOC_MIGRATION_UNPAIRED`).

**Majors 1 through 30 were the pre-stability line**: shipped from 2026-08 under semver, often weeks apart, each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading). v31 is the stable line: from it, at most one major every 90 days (`X_RELEASE_MAJOR_WINDOW`), breaking changes wait on `next` (`X_BREAKING_ON_MAIN`), and the previous major gets security fixes for six months — [Stability](https://github.com/developerz-ai/ultimate/wiki/Stability).

## [Unreleased]

### Security

- admin: a field marked `sensitive` is no longer a list filter or a sort key by default, though its column is indexed or unique. An operator with `admin:read` could otherwise read the hidden value back a few characters at a time with `?f.<field>.contains=` (UI or MCP `where`) or recover its order with `?sort=`. An explicit `filterable: true` / `sortable: true` override still applies.
- admin: row links URL-encode the row id: the list, detail, edit and cancel links, the 303 after a create or update, reference widgets and search hits all build them through one `rowPath`. A text key holding `/`, `#`, `?` or `%` used to open another row's screen (`acme/edit` opened the edit form of `acme`).
- **admin**: every admin decision is evaluated against core's `Actor` of the caller's REAL kind, with its `scopes` and `onBehalfOf`. `policyAuthz`/`roleAuthz`/`singlePolicyAuthz` rebuilt every caller as a `userActor` keeping only id, roles, permissions and orgId, so a policy refusing agents (`actor.kind === 'agent'`), reading `scopes` or refusing an impersonated actor never fired on the admin MCP surface (an agent token deleted a row such a rule forbids), and a queued `admin.batch` chunk an agent queued ran — judged and ambient — as a user. The MCP caller, the request actor and the queued chunk now carry kind, scopes and onBehalfOf end to end.
- **`x config`, `x repro` and an `X_OUTBOUND_UNREACHABLE` cause cut a URL's whole password.** Each redactor ended the userinfo at its FIRST `@`, where a URL parser ends it at the LAST: `postgres://app:hunter@2secret@db/app` printed `@2secret`. One core helper, `replaceUrlUserinfo(text, render)` (+ `redactUrlPassword(text)`), now owns the cut; `config-redact.ts`, `repro-scrub.ts` and `transportText` call it.
- **`x env check --json` masks every credential-named key.** `maskedEnvValues` masked only `secret: true`, so an undeclared `DATABASE_URL` or `STRIPE_KEY` printed in clear; it now also masks every key `isRedactedKey` names (the logger's and `x config`'s rule) and cuts the password from any other value's URL userinfo.
- **scraping**: a `robots.txt` past the 500 KiB cap is no longer read as "no file" (allow everything). Its whole lines inside the cap are parsed, after RFC 9309 §2.5; one with no line end inside the cap is unreachable — complete disallow. A site padding its robots.txt past the cap used to switch robots enforcement off.

### Changed

- core: `ACTOR_KINDS` is exported from `@ultimat3/core`.
- **admin**: `AdminActor` gains optional `kind`, `scopes` and `onBehalfOf` (additive; absent `kind` = `'user'`, the old behaviour for a hand-built actor). `adminActorFrom()` now returns `kind` always, and `scopes`/`onBehalfOf` when present — an app asserting its exact shape gains a `kind` key. `adminMcp`'s `resolveToken` passes the resolver's `scopes` and `onBehalfOf` into the agent actor.
- `@ultimat3/core` exports `replaceUrlUserinfo` and `redactUrlPassword`.
- `x db gen` output for a NOT NULL column with no default, or for a column turned NOT NULL, is now two files (`<id>.sql` + `<id>_concurrently.sql`), or one `-- transaction: false` file when the contract is the only change. A table holding NULL in that column fails the second step at `validate constraint` (`X_DB_STATEMENT_FAILED`, naming `<t>_<c>_not_null_check`) until the rows are backfilled.
- `@ultimat3/testing`: `OverrideHint` gains two optional members, `declared` (the entry's actor, which `overrideLine` spells and prefers over `actor`) and `perRun` (fields the pass binds every run, left out of the line). Compatible: `bun run scripts/public-api.ts --write` records them.
- `@ultimat3/realtime`: an ack for a throw with no code (a live query's `TypeError`) is `X_INTERNAL`, as HTTP labels it. It was `X_PROTOCOL_VERSION` with fix `x doctor realtime`. The socket gets a fixed cause; the throwable's own words stay in the node's error report, as HTTP withholds an unclassified 5xx cause. An explicit `X_INTERNAL` cause is withheld too. Decode failures keep `X_PROTOCOL_VERSION`.
- `x new --shape offline`: the `/posts` JS budget is 156kb, up from 155kb. It was measured at 158,737 B; `uuidV7`'s pre-1970 clamp added 12 B to each of the two chunks the page loads.

### Fixed

- **`uuidV7` on a pre-1970 clock mints at timestamp 0** instead of throwing `X_INVARIANT`, so `ctxOf({ clock: frozenClock('1969-07-20T20:17:00Z') })` works as `frozenClock` intends; still monotonic. An Invalid Date and an instant past 2^48-1 ms are still refused.
- **ai**: a `BudgetStore.add` that throws while the gateway books a paid call (`generate` or a stream's `done`) no longer drives the ledger negative. The reconcile writes the store first and moves the in-memory counters only once every write landed; a write that landed on one scope before the next threw is taken back. The release of the whole reservation now lands at zero instead of `actual − 2 × reserved`, which let the `request` ceiling (and the actor counter, on a two-scope store) admit more than it declared.
- **scraping**: `storageSessionStore().load()` no longer deletes a session sealed under a key this process does not hold (`X_SEAL_KEY_UNKNOWN`). During a rolling `x secrets rotate`, an old pod deleted every session a new pod had just saved. It now answers `undefined` and keeps the object; a record whose tag fails under a key the process holds is still burned.
- entity: `arrayOf()` equality (`where({ tags })`, or `eq`/`neq`/`in` with a list) now compares element by element in the memory driver, as Postgres' `array_eq` does. It used to match no row.
- entity: a `Date` operand on a `date()` column is now its UTC calendar date (`plainDateUtc`) in both drivers. Memory used to compare the `Date` with the stored `YYYY-MM-DD` as text.
- entity: a `timestamp()` predicate given ISO text with no zone (`'2026-01-01'`, `'2026-01-01T10:00'`) now reads it as UTC in both drivers. Memory used to compare it with a `Date` as text and matched every row; Postgres read it in the session's `TimeZone`. A number used as an instant is `X_INVARIANT_VIOLATED`; Postgres already refused it.
- entity: a fractional operand (`1.5`, `'1.5'`, `'1e1'`) on an `integer()`/`bigint()` column, and any `like` on an `integer()`/`bigint()`/`decimal()` column, is now `X_INVARIANT_VIOLATED` in both drivers. Postgres failed these as `X_DB_STATEMENT_FAILED` (500), while memory returned rows.
- money: `parseAmount` reads a currency mark only before or after the number (either side of a leading sign), never between its digits. `10€50` in `fr-FR` was read as 1050.00 EUR, `1$000` in `en-US` as 1000.00 USD, `3R50` in `en-ZA` as 350.00 ZAR. Each is now `X_MONEY_INPUT_INVALID`. Every `formatMoney` display still reads back. A text carrying a mark on BOTH sides (`$5 USD`) is refused too.
- storage: an s3 disk with `forcePathStyle: false` and an endpoint that already names the bucket (`https://media.acct.r2.cloudflarestorage.com`) signed its metadata/lock/copy/multipart requests for `media.media.acct…`, while the Bun client used `media.acct…`. Both transports now build the host with one `bucketHost`.
- `x db gen` writes a column becoming NOT NULL in full, and each migration's snapshot now records what its own SQL leaves. A NOT NULL column with no default is added nullable in the transaction, and its snapshot says nullable. The contract follows in the `-- transaction: false` step: `add constraint "<t>_<c>_not_null_check" check (… is not null) not valid`, `validate constraint`, `set not null`, then the check is dropped. Before, the generator left a `-- backfill …, then: … set not null;` comment under a snapshot that claimed NOT NULL. `x db migrate`, `x db reset` and `bun run setup` then exited `X_DB_DRIFT` on every database, fresh ones included, with a `psql` fix that cannot run against the embedded database, and a second `x db gen` wrote nothing. An existing nullable column turned NOT NULL gets the same contract step instead of the comment. A NULL row stops only the contract step; backfill those rows and `x db migrate` finishes it. (`packages/db/src/not-null-contract.ts`)
- `x exercise` / `x verify`'s exercise step: an action whose name spells no entity (`x g action send-reminder --feature invoice`) now has its bare `id` bound to a seeded row of the entity its policy's grant names (`invoice:write` -> `invoices`), so the generated handler is reached instead of `X_CONTRACT_EXERCISE_UNREACHED` "stopped on X_INVOICE_NOT_FOUND". The primitive's name still wins; grants naming two entities bind none.
- An unreached record's paste line (`override`) keeps the entry's declared actor, spelled as the builder that made it (`actor: userActor({ id: "member", orgId: "…", permissions: ["invoice:write"] })`, `// userActor: @ultimat3/core`) — pasted, it no longer runs as the pass's own pick and turns `X_FORBIDDEN`. A tenant field is the declared actor's org (the pass re-homes it), or left to `...drawn` when none is declared: the line no longer carries the run's random tenant, and is identical from run to run.
- `@ultimat3/cli`: `ULTIMATE_SCHEMA_WAIT_MS` now bounds each schema read, not only the backoff between reads. A read on a database that never answers ends at the remaining deadline (at least 1 s, `SCHEMA_READ_FLOOR_MS`), with the last verdict's refusal, or `X_DB_UNAVAILABLE` if no read has answered yet. Before, a hung read held the boot for the pool's own bound (about 125 s on a worker), even with `ULTIMATE_SCHEMA_WAIT_MS=0`.
- `@ultimat3/ui`: `niceTicks` no longer returns a scale that leaves out the data. For a range straddling zero under a tight cap, `niceTicks(-24, 575, 2)` was `0..5e10`; it now falls back to the data's own ends, `-24..575`.
- The `agent` shape's eval test now refuses a prompt edit made under the old `version` with `X_EVAL_BASELINE_MISSING`, whose fix is `ULTIMATE_EVAL_RECORD=1 x test eval` after bumping `version`. Before, it was a bare `expect`, so the failure was `X_TEST_FAILED` and the fix just re-ran the failing test. The check runs inside the one test that re-records, so a re-record that kept the version fails too. Baselines are now filed per version (`suggest-title.v<version>.baseline.json`).
- The fix for the shipped `untranslated-string` guard now ends `then: x verify --only boundaries`, the check that catches the typed string. Before, it ended `x i18n check`, which passes while the string is still hardcoded.
- The shipped `undeclared-env` guard now refuses a `defineEnv(` record in app source whose keys `envSchema` in `app.config.ts` does not declare. The record can be inline or a same-file `const`. Such keys were invisible to `x env check`/`example`, `x secrets` and `x deploy`. A record built from `envSchema.X`, like the agent shape's `model.ts`, still passes.
- In `x env check`, the summary now counts only declared variables and names the framework's deploy secrets (`X_CURSOR_SECRET_DEV`, `X_STORAGE_SECRET_DEV`) separately by code. Before, it could print "3 of 2 declared variable(s) missing or malformed".

## Releases

| Version | Date | Summary |
|---|---|---|
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
