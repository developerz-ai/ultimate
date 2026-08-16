# 13 — Doc drift as a defect

> Part of [`overview.md`](overview.md). Depends on: every slice that changes behaviour (land last, so
> the docs describe the fixed tree). Tier: docs.

In this repo missing docs are missing features, so a doc that describes something the code does not do
is a defect with a `file:line`, not a tidy-up. Two classes matter most: **a documented command that
does not exist** (an agent runs it and the parser refuses), and **a `fix:` line naming a command that
cannot work** (axiom 4 broken at the exact point an agent needs it).

**The gate cannot catch either.** `checkErrorFixes` resolves cited commands only for `fix:` string
literals in *shipped source*; the `fix` column of `wiki/Error-Codes.md` is held to coverage and
registration, never to runnability. That enforcement gap is the slice's real deliverable.

## Critical

- `wiki/Known-Gaps.md:9` asserts `docker/Dockerfile` "still compiles its binary with a bare
  `bun build --compile`" and offers "add the define to the `RUN bun build` line" as the workaround.
  `docker/Dockerfile:33-39` passes it and ends in `/out/app --version`; `CLAUDE.md:29` records it as
  landed. Delete the row. (The image still fails to build, for the unrelated reason in
  [`11-deploy-ci.md`](11-deploy-ci.md) — do not conflate the two.)

## High — commands documented that do not exist

| Doc | Cites | Reality |
|---|---|---|
| `wiki/Error-Codes.md:180,191` | `x db query` | `DB_SUBCOMMANDS` = `gen\|migrate\|reset\|studio\|branch\|backfill` |
| `wiki/Error-Codes.md:190` | `x entity explain` | the command is `x entities describe` |
| `wiki/Installation.md:79,86` | `x env check --fix` | `cmd-env.ts:80` declares no such flag — dies at the parser |
| `docs/architecture/04-error-contract.md:149` | `x db status --json` | does not exist — and it is the page's **first ✅ Accepted example of a good `fix:`**, on the page that defines the rule; it would fail `fix-command.ts`'s own check |
| `docs/architecture/04-error-contract.md:153`, `08-jobs-internals.md:239` | `x jobs retry --from` | the real flag is `--from-step` |
| `docs/architecture/07-realtime-internals.md:92,180,232` | `x live explain` | exists in no form |

Also documented, none real: `x manifest write`, `x i18n add <key>`, `x i18n prune`, `x db drift`,
`x jobs retry --failed-since`, `x test --keep-db`, `x cache graph --tag`, `x cache purge`,
`bunx x boundaries`, `x serve`, `x jobs run`. Shipped and documented nowhere: **`x jobs cancel`** and
its `--reason`.

Other High drift:

- `wiki/CLI-Reference.md:81` states 99 / 76 scaffold files; `x new --dry-run --json` returns
  **112 / 88**.
- `docs/architecture/02-boundaries.md:95-99` documents two boundary escape hatches
  (`boundaries.allow`, `// boundary-allow:` with a 90-day expiry) with **zero implementation
  anywhere**. `:12` names `schema → core` as the sideways exception, which `SIDEWAYS_ALLOW` does not
  contain and `packages/schema/src/errors.ts:2` explicitly contradicts.

## Medium — framework-level claims the tree disproves

| Claim | Disproved by |
|---|---|
| `CLAUDE.md:16` — all 29 packages "on npm in lockstep" | `README.md:20`, `llms.txt:3`, `docs/idea/README.md:63` all say `@ultimat3/flags` never reached npm — and `release.yml` omits it, so it stays behind ([`11-deploy-ci.md`](11-deploy-ci.md)) |
| `CLAUDE.md:29` — the image build ends in `/out/app --version` | the build dies at `docker/Dockerfile:15` and never reaches it |
| `CLAUDE.md` / `README.md` — "49,981 received a channel patch" | a *reachability* measurement, not a consistency one ([`06-concurrency-lifecycle.md`](06-concurrency-lifecycle.md)) |
| `docs/idea/17-scale-ladder.md:140` — `createPgLeader` is the shipped scheduler leader | the boot uses `createPgLeaseLeader`, precisely because the former is session-scoped and double-fires on a rolling update |
| `docs/idea/12-build-deploy.md:95` — documents `x build --helm` | `CHANGELOG.md:1017` claims it was removed in 1.2.0 |
| `wiki/Known-Gaps.md:14,32,18` | three rows the current scaffold disproves |
| `docker/README.md:20`, `docker/Dockerfile:52` — "All roles expose /healthz and /readyz" | only `web` and `sync` construct a server ([`11-deploy-ci.md`](11-deploy-ci.md)) |
| `docker/Dockerfile:9`, `docker/README.md:80` — "cached on the lockfile alone" | the stage copies full source trees |

## Medium — package `README.md` / `CLAUDE.md` drift

Each row is `doc:line` vs the code that disproves it. Canonical side named; where it says **fix the
code**, the doc describes the better design.

**`core`** — `README.md:6` omits the entire error-reporting subsystem (`reportError`,
`configureErrorReporting`, `ErrorReporter`, `memoryErrorReporter`, `sentryErrorReporter`,
`sentryEnvelope`, `parseSentryDsn`, `ERROR_SOURCES`) though the sibling telemetry seams are documented
in full. `CLAUDE.md:137` — "one call site per package … http's `pipeline.ts`, jobs' `executeJob`,
realtime's `sync-node.ts`" is wrong three ways: http's only call is `stages.ts:296`,
`realtime/sync-node.ts` has four (`133,202,299,358`), and `packages/flags/src/runtime.ts:56` is an
unlisted fourth package. `CLAUDE.md:83` — "the two codes' titles"; there are three.

**`cli`** — `README.md:49`'s step list has 16 names and omits `roadmap`, contradicting `README.md:14`'s
own "17 named steps"; `:44`'s `--json` sample prints "1 of 16 steps failed" where `{count}` is 17;
`:22` drops the shipped `x jobs cancel`; `:16` omits shipped `x db backfill` and advertises `studio`,
the sole `PLANNED_SUBCOMMANDS` entry that throws `X_NOT_IMPLEMENTED`; `:9`'s command table misses six
shipped groups (`x env`, `x secrets`, `x tasks`, `x policy`, `x i18n`, `x docs`); `:65`'s layout table
never mentions the container-runtime half (`serve.ts`, `prerender.ts`, `metrics-endpoint.ts`) though
the scaffold's `server.ts` imports `runRole`. `CLAUDE.md:155` — "`serve.ts` installs neither it nor
the span exporter" is false: `serve.ts:236` calls `startOtlpExport`.

**`action`** — `README.md:112` says the MCP tool name "is the export name verbatim" but `toMcpTool`
names it `toToolName(name)` (snake_case, `naming.ts:69-71`); **fix the code** —
`@ultimat3/mcp`'s `from-action.ts:74` uses the verbatim name, so action's own projection is the odd
one out, and this is a second instance of the two-schemas-for-one-tool split in
[`04-projection-contract.md`](04-projection-contract.md). `README.md:78-83` omits `jobs`/`tasks` from
the `defineApi` key table; `:93` names `registerQueries`, which is query's and is never imported here.
`CLAUDE.md:37` names a `infer.ts` that does not exist; `:285` claims `policy-gate.ts` is the only
importer of the policy package (`errors.ts:13` also imports it).

**`entity`** — `README.md:121-124,158,217` names `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` and
`MAX_ASSERTED_ROWS` as constants; only `N_PLUS_ONE_THRESHOLD` is re-exported. Either document them as
internal or export them beside it. `pg-sql.ts:210`'s comment still calls `default` "the third and last
`raw()` in this file" where there are two.

**`jobs`** — `README.md:354`'s `createWorker({ driver, queues, concurrency })` does not compile
(`WorkerOptions.context` is non-optional). `CLAUDE.md:352` calls `PgExecutor` "a two-method
duck-typed interface"; it is declared at `driver-pg.ts:62-64` with exactly one method.
`driver.ts:196`'s docstring says a driver without leases "enforces `concurrency` per process and the
worker says so at start (`jobs.worker.concurrency-unenforced`)" — `start()` actually **throws**
`ConcurrencyUnenforceableError` and that log string exists nowhere; `README.md:428` and `CLAUDE.md:75`
describe the throw correctly.

**`auth`** — `README.md:150` lists `BUILTIN_OAUTH_PROVIDER_IDS`, which `index.ts:142` does not
re-export; **fix the code**. `:255` claims `x db gen "auth tables"` emits `AUTH_TABLES` — the command
diffs `describeEntities()` and nothing outside `tables.ts` reads it. `:14` and `:33` — the entire
MFA/TOTP subsystem (`enrolTotp`, `verifyTotp`, `generateRecoveryCodes`, `redeemRecoveryCode`,
`createTotpReplayGuard`) and the whole verification subsystem (`issueVerification`,
`consumeVerification`, `VERIFICATION_PURPOSES`, `VERIFICATION_TEMPLATES`, `MailSender`) are exported
and undocumented. Coordinate with [`07-security.md`](07-security.md): MFA's documentation and its
missing second leg are one piece of work.

**`ai`** — `README.md:401` claims `x db gen` emits vector-store DDL; no CLI file references
`PgVectorStore` or `ddl()`. `:358` quotes the fix line `x test summarize`, which is not runnable
(`x test`'s positional must be a `TestType`); **fix the code** at `eval-errors.ts:32`. `:11` documents
`budget: { request, actor, org }` without the `BudgetStore` seam or its per-process
`MemoryBudgetStore` default, so actor/org ceilings read as fleet-wide — which is also where the
budget bug in [`03-tier45-bugs.md`](03-tier45-bugs.md) hides.

**`cache`** — `README.md:232` tells a test author `resetTierFailures()` "is still fine", but
`index.ts:94` re-exports only `recentTierFailures`; the reset is deliberately package-internal per
`CLAUDE.md:41`.

**`render`** — `README.md:80`'s example calls `config.meta({ post })`, but `meta` takes a
`RouteMetaContext` (`{ data, params, url, t }`, all required) — the shape `README.md:36` documents
four lines earlier. The fence contradicts its own page and will not typecheck.

**`db`** — `CLAUDE.md` claims `errors.ts` guards `registerErrorCodes` with `hasErrorCode`; it
registers unconditionally and says so ([`01-tier01-bugs.md`](01-tier01-bugs.md)).

**`http`** — `errors.ts:303` and `:387` contradict each other about where `toBucket` lives; it is
`rate-limit.ts:103`.

**`admin` / `mail`** — two documented APIs that do not exist, already listed in
[`03-tier45-bugs.md`](03-tier45-bugs.md) (`x mail list`/`preview`; `<Widget input={…} />`).

**Clean**: `packages/schema`, `packages/storage`, `packages/query` (one cosmetic duplicate row at
`CLAUDE.md:32-33`).

## Enforcement — the actual deliverable

Three checks, each turning a class above into a build error (axiom 3):

1. **Runnable `fix:` everywhere, not just in source.** Extend `checkErrorFixes` to the `fix` column of
   `wiki/Error-Codes.md`, resolving each cited `x <command>` against `loadCommandCatalog()` — the
   machinery already exists at `packages/cli/src/error-contract.ts`; it is only pointed at source.
2. **Documented commands exist.** Scan `wiki/` and `docs/` for `` `x <command> …` `` in prose and
   resolve each against the catalog, with an explicit allowlist for the nine planned commands so
   "planned" stays sayable. This catches every High row above.
3. **README examples compile.** Extract fenced `ts`/`tsx` blocks from each package `README.md` into a
   typecheck-only fixture. This catches the `render`, `jobs` and `action` rows and prevents the class.

## Verified correct — do not "fix"

17 steps and their order; 28 + `create-ultimate` = 29 packages all at 1.2.0; the tier table and all
five sideways edges row-for-row against `scripts/lib/tiers.ts`; error-code coverage both ways (378
declared, 0 findings from the gate's own `errorCodeDocs`); the bench numbers against
`scripts/bench/results/50k-restart.json`; `replicas: 1` on `web`/`sync` in all four compose files; one
`resolveEnvironment` (core's); nine planned commands; thirteen `x g` kinds; every relative markdown
link resolves (0 broken).

## Done when

- Every High row is either implemented or deleted — no doc names a command an agent cannot run.
- The three enforcement checks are verify steps, so this slice cannot silently recur.
- `CLAUDE.md`'s status block, `README.md` and `llms.txt` agree with each other and with the tree on
  the npm count, the image claim and the bench claim.
- `bun run verify` green.
