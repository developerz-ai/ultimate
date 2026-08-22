# 07 — Tier 5: cli

> Part of [`overview.md`](overview.md). Depends on: 01 (`HealthReport.registered`), 04 (realtime `./server` path), 06 (`url()`). Tier: 5.

Grouped by command. Each row is one finding; **proven** = reproduced during the audit.

## `x shot`
- `packages/cli/src/shot-verdict.ts:191` — `buildVerdict` never reads `islands.failed`; every island's `mount()` rejecting still reports `ok: true`, "clean". **Proven.** The marker it ignores costs 129 B per island prelude (`packages/render/src/modes.ts:238`). `cmd-shot.test.ts:40`'s `PROBE_ANSWER` has `failed: 1` and asserts only the artifact — a test pinning the defect.
- `packages/cli/src/cmd-shot.ts:75` — `readRoute` rejects `scheme:` only; `//evil.example/x` and `\\evil.example/x` escape the origin at the layer whose comment says it cannot. Cross-origin is caught one layer down (`hosts.ts:45`), but `allowHostsFrom` (`:246`) is hostname-only, so `x shot //localhost:9200/_cat/indices` photographs whatever else is on the dev box. **Proven.**
- `packages/cli/src/cmd-shot.ts:45` — `DEFAULT_SETTLE_MS = IDLE_HYDRATE_TIMEOUT_MS` is the deadline at which `import()` is *called*; `mounted` lands after. Poll `ISLAND_PROBE` until `booted === mounted + failed` or a bounded extra window.
- `packages/cli/src/cmd-shot.ts:216-233` — second check-then-act on the dev lock (see `x dev` below).

Steps: add `(islands?.failed ?? 0) === 0` to `ok`; a fourth `shotSummary` branch (`:318`) naming `failures[0]`; key `cli.shot.islandFailed` in `SHOT_MESSAGE_KEYS` (`:24`) and the framework catalog. `readRoute`: refuse a `//` prefix and any `\` with `X_CLI_BAD_FLAG` naming `x shot /<path> --json`. Settle: poll.

## `x pr`, `x ci`
- `packages/cli/src/output.ts:161,165` — `renderHuman` emits `result.lines` verbatim; `cmd-pr.ts:178` fills them with GitHub comment bodies. **Proven**: ESC/OSC bytes survive to fd 1; `renderFinding` (`:116-125`) runs `singleLine`, this path does not. Consequence: terminal control + prompt injection into the agent this command exists for. `ci-log.ts:18`'s regex is CSI-only (no OSC, `ESC c`, DCS).
- Steps: `singleLine` from `@ultimat3/core` at the one renderer for every line; fence each foreign body in an id-labelled block the way `packages/ai/src/rag.ts:233` fences documents; keep `ci-log.ts`'s regex for the log's own colour only.

## `sync` role
- `packages/cli/src/sync-authenticator.ts:57` — `{ actor }` with no `expiresAt`, no `refresh`; `dev-sync.ts:75` makes it the default for every scaffolded `server.ts`; `GrantBook.expired()` (`packages/realtime/src/sync-auth.ts:63`) skips such grants, so `sweepGrants` — the only path to `hub.onActorChange`/`registry.reauthorize` (`sync-node.ts:250-251`) — never fires. `logout`, `revokeSession`, `disableUser`, `updatePrivileges` close HTTP and never the socket; the 15 s heartbeat beats the 120 s idle sweep. **Proven**: sweep one year later → `{refreshed:0, revoked:0}`.
- Steps: capture the upgrade request's `cookie`/`authorization` in the closure (what `sync-auth.ts:13-16` says the closure is for); `expiresAt = clock.now() + SYNC_GRANT_TTL_MS`; `refresh: () => authenticate(...)` through `configuredAuthenticator()`. `sweepGrants` (`:99-124`) already distinguishes a denial from a backend failure.

## `x dev`, readiness, rate limit
- `packages/cli/src/cmd-dev.ts:305,313,371` — `preflight` reads the lock, `startDev` boots (seconds), `writeLock` after. Two boots both pass preflight and both open `.x/pgdata`; `X_DEV_ALREADY_RUNNING` unreachable; the operator gets `X_DB_UNAVAILABLE` with `fix: x dev` — the incident `dev-lock.ts:11-14` records. **Proven** with two `preflight()` calls and `portBound: () => false`.
- `packages/cli/src/dev-runtime.ts` `startServices` — nothing in the tree calls `registerReadinessCheck`; `/readyz` is `markReady()` alone, which `packages/http/src/server.ts:165` calls before `Bun.serve` and `dev-roles.ts:277` before `sync`/`worker`/`scheduler` start. The chart (`docker/helm/templates/_helpers.tpl:117`, `scaffold-helm-templates.ts:98`) and the container healthcheck (`scaffold-container.ts:58`) route on it.
- `packages/cli/src/dev-roles.ts:227` — `rateLimit.scope` derived from the installed store → always `'process'`; `X_RATE_LIMIT_NOT_SHARED` can never fire while the charts run 2–3 replicas.
- Steps: claim the lock inside `preflight()` and roll back on boot failure (`serve.ts:227` `releaseBoot` shape); `cmd-shot.ts` consults the same claim. Register one readiness check per owned resource in `startServices` (db pool liveness, `NatsTransport.connected`), holding the unregister the way `hold.ts:24` does. `startWeb`: log the replica multiplier it is enforcing when `scope === 'process'` (the `warnIfUnauthenticatable` shape, `dev-roles.ts:165`) until `12-decisions.md`'s store lands.

## `x verify` — `drift`
- `packages/cli/src/drift.ts:21` — `SCHEMA_GLOB = 'packages/db/src/**/*.ts'`; app entities live in `apps/web/app/<feature>/entity.ts`. **Proven**: three generated entities, one migration, `drift` green; every `.hash` sidecar identical (`3e3b975ee07b6f1a`). `x db gen` loads the registry, so `scaffold-db-package.ts:60`'s "an entity not exported here does not exist" is false, and no generator adds the export.
- Steps: hash the loaded entity registry's `describe()` output (the zero-migration branch already loads the app) instead of a source glob. Slice 08 deletes the `schema.ts` claim.

## `x errors explain`, `x docs`
- `packages/cli/src/framework-scope.ts:34` — `frameworkScopeDir()` lists the parent of resolved `@ultimat3/core`; under Bun's isolated layout that is `node_modules/.bun/@ultimat3+core@7.0.0/node_modules/@ultimat3/` with one entry. **Proven**: 400 of 405 codes answer "nothing in the installed framework raises …" with `ok: true`; `x docs` sees 1 of 17 packages (741 entries exist under `node_modules/@ultimat3`).
- Steps: when an app root exists, scan `<appRoot>/node_modules/@ultimat3` or `Bun.resolveSync('@ultimat3/<name>', root)` over the dependency names; never `readdir` on core's parent.

## `x i18n sync`
- `packages/i18n/src/errors.ts:60` + `packages/cli/src/cmd-i18n.ts:185` — `X_CATALOG_MISSING_KEYS` says `x i18n sync en`; `runSync` merges from `catalogs[defaultLocale]`, so for the default locale `added` is empty by construction. **Proven**: exit 0, "0 key(s) added", check still red. It is a gate step; the only escape is a hand edit nothing names.
- Steps: for the default locale, `sync` adds every extracted-but-absent key with `⟦key⟧` as value (the placeholder `x verify` already refuses shipping), and the fix line says so.

## Fix lines that generate the wrong thing
- `packages/cli/src/app-boundaries.ts:136,150` — `subjectOf = path.split('/').at(-2)`; a surface-root route yields the surface, so `X_BOUNDARY_ROUTE_TO_DB` on `apps/web/site/page.tsx` says `x g query site` → 7 files and a `sites` table. **Proven.** Same helper in `X_BOUNDARY_SERVICE_TO_HTTP`.
- `packages/cli/src/generate-kinds.ts:48-52` — `x g rout x` → `fix: x g resource` (hardcoded, not runnable alone, wrong primitive); `nearest()` is used correctly by the top-level dispatcher.
- `packages/policy/src/errors.ts:75` — `X_PERMISSION_UNKNOWN` leads with "add `'billing:wirte'` to definePermissions"; only the generated `policy.test.ts` caught it. (Tier 2 file; one line, land it here with the cli tests that prove it.)
- Steps: refuse surface names (`site`, `app`, `api`, `shared`) as resource names and name the route path instead; `nearest(raw, GENERATORS)` echoing the caller's name; policy: nearest-first.

## Parser and flags
- `packages/cli/src/parse.ts:236` — `readSubcommand` throws before `--help` is honoured: `x db --help`, `x mcp --help`, `x pr --help` exit 1. **Proven** across all 30 commands.
- `packages/cli/src/parse.ts:208` — a string value beginning `--` is refused with no `--flag=value` hint; `:180-206` `--no-<name>` on a string flag consumes the next token.
- `packages/cli/src/cmd-db.ts:97` — `--dry-run` accepted on `gen`, ignored; the migration is written. **Proven.** Same for any command-level flag on a subcommand that does not read it.
- `packages/cli/src/serve.ts:197` — boot logger writes to stdout; `x db migrate --json` is two JSON objects. **Proven**: `json.load` fails.
- `packages/cli/src/cmd-new.ts` — usage says `--no-example`, flag table lists `--example` (the default); neither states the default.
- `packages/cli/src/cmd-mcp.ts:127` — `x mcp serve --transport stdio` prints `✓ mcp stdio serving 13 tools` on stdout after the loop exits (CONFIDENCE medium).
- Steps: skip `readSubcommand` when `-h/--help` present; hint `--name=<value>`; refuse `--no-` on a string flag; validate flags per subcommand through `subcommandPositionals`, or make `gen` honour `--dry-run`; logger to stderr under `--json`; fix `new`'s help text; mcp banner to stderr.

## Duplicated vocabularies
- `packages/cli/src/jobs-report.ts:25-34` + `index.ts:196` — `JOB_STATES` copy with 7 members; `packages/jobs/src/driver.ts:20` has 8 (`cancelled`). `x jobs ls --state cancelled` is refused while `x jobs cancel` creates the state. `jobs-report.test.ts:61` loops over the CLI's own copy. Delete; import from `@ultimat3/jobs`.
- `packages/cli/src/verify-tests.ts:23-25` — `TEST_TYPES` duplicates `packages/testing/src/test-types.ts:8`; `cli → testing` is declared. Delete; import.

## `x deploy`
- `packages/cli/src/cmd-deploy.ts:118-132,179` — compose branch never uses `image`; `--json` reports the requested ref while `docker compose` resolves `${IMAGE:-…}` from the ambient env. **Proven** with `--dry-run`. Deferred from the prior sweep. Pass `{ env: { IMAGE: plan.image } }` through the `Runner` (`exec.ts:24,56`); the helm branch (`:79-86`) is the correct shape.

## Carried in from slice 03 (found during execution, 2026-08-22)

- **Wire the shared rate-limit stores that slice 03 shipped.** `startWeb`/`startServices` must
  install both and run their two `if not exists` table statements the way boot already runs
  `SQL_IDEMPOTENCY_TABLE`:
  `postgresRateLimitStore({ executor })` from `@ultimat3/http` and `postgresAuthLimiter({ executor, clock, policy })`
  from `@ultimat3/auth`. **Do NOT write a new executor wrapper** — `pgExecutorFor(client: DbClient): PgExecutor`
  already exists at `packages/cli/src/dev-queue.ts:74`, was built for `@ultimat3/jobs`' structurally
  identical seam, and `dev-roles.ts:318` already calls it with the value in scope. `Bun.sql` does
  NOT satisfy `PgExecutor` (`Bun.sql.query` is `undefined`).
  Auth needs **two** limiters over one table — `policy: rateLimit` and `policy: orgRateLimit(rateLimit)`;
  keys are prefix-disjoint (`account:`/`ip:`/`org:`). Neither table self-bounds, so `purgeExpired`
  wants a `task`; http's **requires** `nowMs` from the same clock the limiter uses (a purge reading
  the server's clock instead of the caller's deleted a bucket holding 0 of 4 tokens — that bug is
  fixed in the store, do not reintroduce it at the call site).
  Once wired, `dev-roles.ts:227`'s hardcoded process-scoped limiter and the interim warning can go.

- **`nearest()` / edit distance now exists twice.** `packages/cli/src/parse.ts`'s `nearest` (tier 5)
  and the new `packages/policy/src/nearest-permission.ts` (tier 2), which could not import it
  because that would be an upward import. Same algorithm, same cutoff (≤ 3), kept in agreement by
  hand — which axiom 1 forbids. **Hoist the function to `@ultimat3/core` (tier 0)** and delete both
  copies; `nearest-permission.ts` carries a header comment saying exactly this so it is easy to
  remove. Three call sites. Land it in this PR, since `cli` holds one of the two copies.
- **`packages/cli/src/dev-storage.ts:88`** calls `policy`'s `forbidden(policy.label, …)`, which
  slice 03 corrected to branch on whether the label is a bare `permission:action`. It inherits the
  fix with no edit — but confirm the value passed there really is a `Policy.label` and not something
  else, or the branch is wrong at this one caller.

## Tests
- `cmd-shot.test.ts` — `failed: 1` → `ok: false`, summary names the island; clean run → `ok: true`, `redirected: false`; `readRoute('//evil/x')` and `readRoute('\\evil')` → `X_CLI_BAD_FLAG`.
- `output.test.ts` — `renderHuman({ lines: ['[2Jx'] })` contains no ``, byte-equal to `renderFinding`'s escape of the same string.
- `sync-authenticator.test.ts` + a `.live.` test: subscribe over a real socket, delete the session row, advance the clock past the TTL → close `1008`.
- `dev-lock.test.ts` — two `preflight()` with `portBound: () => false` → second throws `X_DEV_ALREADY_RUNNING`.
- `dev-runtime.live.test.ts` — boot `web`, close the pool, `GET /readyz` → 503; `HealthReport.registered >= 1`.
- `drift.test.ts` — add a column to a generated entity under `apps/` → `X_DB_DRIFT`.
- `framework-scope.test.ts` — a fixture `node_modules` in Bun's isolated layout → all installed packages listed.
- `cmd-i18n.test.ts` — `sync en` on the default locale adds the extracted keys; `check` goes green.
- `app-boundaries.test.ts` — `apps/web/site/page.tsx` → fix names no surface; `generate-kinds.test.ts` — `rout` → `x g route <name>`.
- `parse.test.ts` — `--help` with a missing subcommand returns help; `--no-x` on a string flag refused; `--x --y` hint present.
- `cmd-db.test.ts` — `gen --dry-run` writes nothing; `serve.test.ts` — `migrate --json` stdout is one JSON object.
- `jobs-report.test.ts` — loops over `@ultimat3/jobs`'s `JOB_STATES`; `cancelled` parses.
- `cmd-deploy.test.ts` — compose plan's runner env carries `IMAGE`.
- Command: `bun test packages/cli/src`, then `bun run x -- test live --workers 4`.

## Done when
- Every test above fails on `main` and passes after; `bun run x -- verify` green; new `X_*` codes (if any) in `wiki/Error-Codes.md` and `bun run manifest` clean; `wiki/CLI-Reference.md` re-derived for the `--help`/`--dry-run`/`new` changes (`bun run scripts/doc-commands.ts`).
