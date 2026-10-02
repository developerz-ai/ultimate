# Sweep 1 — tier 5 and tooling
> Re-checked in [`sweep-3-verify-tier-4-5.md`](sweep-3-verify-tier-4-5.md) — where it corrects a citation or narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `cli`, `admin`, `testing`, `scraping`, `create-ultimate`, `scripts/`. ~50 `x` invocations
> probed in a scratch scaffold. CONFIRMED = a probe ran. PLAUSIBLE = from reading only.
> No file under `docs/plans/` was consulted by this hunt — dedupe happens in the overview.

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/admin/src/repo-entity.ts:91-113,154-161` | admin keyset pagination seeks `gte` on the sort column alone; `dropThroughTie`'s "+1" covers one tied row | 10 rows with equal `rank`, page size 3 → page 1 serves 3, page 2 serves 2 with `hasMore: false`; 5 rows unreachable. Bulk-inserted rows sharing `createdAt` (the default sort) hit it | CONFIRMED (memory driver) | seek on the pair: `sort > v OR (sort = v AND id > cursorId)` | `packages/admin/src/repo-entity.test.ts` (its tie case has 2 tied rows) |

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 2 | `packages/admin/src/pagination.ts:101-105`, `repo-entity.ts:96` | `cursorValue` encodes null as `''`; the seek excludes NULL on later pages; `sortable()` (`fields.ts:219`) admits nullable columns | 4 rows `rank: null` + 4 valued, asc, page size 3 → the null rows are never served | CONFIRMED (memory); Postgres half PLAUSIBLE | carry null-ness in the cursor and seek with `is-null` branches, or refuse `sortable` on a nullable column | `packages/admin/src/repo-entity.test.ts` |
| 3 | `packages/admin/src/form-decode.ts:71`, `widgets.tsx:74-75` | edit form renders `iso.slice(0,16)`; `adminUpdate` (`crud.ts:277-296`) writes every submitted key | `publishedAt = …T10:20:45.123Z`, operator edits the title → `…T10:20:00.000Z` written; the audit diff records a change nobody made | PLAUSIBLE | omit a datetime from the patch when the posted value equals the rendered `before`, or post full precision | `packages/admin/src/form-decode.test.ts`, a round trip in `crud.test.ts` |
| 4 | `packages/cli/src/verify-merge.ts:216-249` | `x verify merge` never checks the shards' `files` partition the corpus | shard 1/2 round-robin, 2/2 with `--timings` → slices `[a,c]`, `[b,c,d]`; swapped, a file runs in no shard; merge `ok: true`. Two shards with `files: []`, `ran > 0` also green. Latent here: `ci.yml:178` passes no `--timings` | CONFIRMED (`shardFiles` + `mergeParts`) | in `mergeStep`: union of `shard.files` duplicate-free and `corpusHash(union) === shard.corpusHash` | `packages/cli/src/verify-merge.test.ts` |
| 5 | `scripts/lib/args.ts:22-26,43` | `flagBool` reads a boolean flag given a value as false | `release.ts --bump minor --dry-run=true` performs the real release writes (`release.ts:257,330`); `--json=true` gives human output; `--json merge x.json` swallows `merge` | CONFIRMED at the parser; release not run | `flagBool` refuses a string value, as the CLI does (`X_CLI_BAD_FLAG`) | `scripts/lib/args.test.ts`, `scripts/release.test.ts` |
| 6 | `scripts/lib/workspaces.ts:141-147` | publish order is tier then alphabetical — `core` before `schema`, `cli` before `testing`, both declared dependencies (`packages/core/package.json:43`, `packages/cli/package.json:67`); `release.yml:244-259` publishes in that order | a run that dies between the two leaves an immutable `core@X` whose `schema@X` does not exist — `release.yml:256-258` records this at v22.4.0 | CONFIRMED (script output) | order within a tier topologically by `@ultimat3/*` dependencies | `scripts/lib/workspaces.test.ts` |
| 7 | `packages/cli/src/api-registration.ts:52,109` | the namespace binding is the file's basename alone | (a) `x g job reindex-post --feature comment` when `post` has one → `ok: true`, 3 files written, never registered in `apps/web/api/index.ts`, no finding. (b) `x g action api --feature post` / `x g query define-api` → `import * as api` beside `export const api`; every app-loading command dies `ReferenceError` | CONFIRMED (scratch scaffold) | refuse a binding already bound (or `api` / `defineApi`) with a finding, or derive it from feature + file | `packages/cli/src/api-registration.test.ts` |
| 8 | `scripts/to-throw-returns.ts:52-53` | the "toThrow cannot fail" guard misses `expect(() => new Error('x')).toThrow()`, any callback wrapped onto a second line, a `{ return boom(); }` block, and a factory typed `: Error` (`:37-40`) | 0 findings on each | CONFIRMED (`checkToThrowReturns`) | optional name prefix; match across newlines with `scripts/lib/balanced-paren.ts` | `scripts/to-throw-returns.test.ts` |

## Low

| Where | Defect | Verdict | Test |
|---|---|---|---|
| `scripts/lib/verify-args.ts:92-94` | `bun run verify --workers` unvalidated: `abc` dropped, `4x` → 4, `5000` accepted; `readWorkers` (`cmd-verify.ts:183`) caps at 64 | CONFIRMED | `scripts/lib/verify-args.test.ts` |
| `scripts/lib/coverage-units.ts:37` | unit target is bare `packages/<name>`, a substring filter — `bun test packages/mcp` runs 40 files, 3 from the tracked apps | CONFIRMED | `scripts/coverage-gate.test.ts` |
| `packages/cli/src/cmd-generate.ts:92-97` | `--dry-run` says `ok: true`, "would write 33" where the real run is `X_GENERATE_CONFLICT`; `if-absent` skips listed as writes | CONFIRMED | `packages/cli/src/cmd-generate.test.ts` |
| `packages/cli/src/templates/scaffold-repo.ts:102` | scaffold pins `solid-js` `1.9.14`; root is `1.9.15`, `packages/cli/package.json:69` needs `babel-preset-solid ^1.9.15`; unpinned by `scaffold-repo.test.ts` | CONFIRMED (static) | `packages/cli/src/templates/scaffold-repo.test.ts` |
| `packages/testing/src/sealed-network.ts:39` | `mockFetch` RegExp with `g` / `y` matches every other call | CONFIRMED | `packages/testing/src/sealed-network.test.ts` |
| `packages/testing/src/determinism.ts:214-215` | `assertDeterministic` throws a bare `TypeError` on a BigInt or cyclic result | CONFIRMED | `packages/testing/src/determinism.test.ts` |
| `scripts/test-bare-error.ts:43` | ratchet misses `throw Error('…')` without `new` (no instance today) | CONFIRMED | `scripts/test-bare-error.test.ts` |
| `packages/cli/src/cmd-help.ts:93-102` | `x help nosuch --json` exits 0 with the whole catalogue | CONFIRMED | `packages/cli/src/cmd-help.test.ts` |
| `packages/cli/src/cmd-jobs.ts:214` | `x jobs show nosuch` → raw `X_DB_STATEMENT_FAILED [22P02]` with a `psql` fix; `readableId` (`packages/admin/src/repo-entity.ts:144-151`) is the pattern | CONFIRMED | `packages/cli/src/cmd-jobs.test.ts` |
| `packages/cli/src/cmd-verify.ts:153-158`, `scripts/lib/verify-args.ts:44-50` | empty `--only` item gets an invented step in its `fix:` (`lint,` → `lint,job`) | CONFIRMED | `packages/cli/src/cmd-verify.test.ts` |
| `packages/cli/src/verify-merge.ts:103-110` | `parsePart` casts a step with only `name` and `ok`; merges green with `findings:[null]`; only the last line is tried, not "the last that parses" (`:73`) | CONFIRMED | `packages/cli/src/verify-merge.test.ts` |
| `packages/cli/src/templates/naming.ts:74-78` | plural resource name pluralised again: `x g resource posts` → `entity('postses')`; the framework's own fix line (`generate-write.ts:105`) uses `posts` | CONFIRMED | `packages/cli/src/generate-names.test.ts` |
| `scripts/new-package.ts:261-279` | package name never validated: `../../x` escapes `packages/`; no `--tier` → `UNLISTED_TIER` | PLAUSIBLE, low impact | `scripts/new-package.test.ts` |

## Gaps

- `registry-audit.ts:221`, `release.ts:186` — no floor on the workspace list: zero publishable workspaces reads `0/0 … every one attested`, `ok: true`.
- `performReleaseWrites` (`scripts/lib/release-writes.ts:151-194`) wraps only the manifest write in a `try`; a throw in the lockfile or footer step leaves a half-bumped tree and a stack trace.
- `frozenClock()` (`packages/testing/src/determinism.ts:194-205`) moves the clock without `announceMove`; the frozen scheduler does not hear it.
- `FrozenDate` cannot be called without `new`.
- `packages/cli/src/source-files.ts:7-19` — in an app, `guards/*.ts`, `apps/*/server.ts`, `apps/*/prerender.ts` are outside `SOURCE_GLOBS`; `filesize` never sees them.
- `list-workspaces.ts --tier 9` → `ok: true`, "0 workspaces".
- `verify-shard.ts:103` reads `timings[file]` without `Object.hasOwn`; `:108` guards the same read.
- `x docs <no match>` exits 1 with no finding and no `fix:`.
- The scaffold writes `@ultimat3/*` as `^version` though the framework is lockstep — no doc block argues it.

## Not a bug (do not re-open)

- `reference-app-gate.ts` — missing / unknown / duplicate step, a skipped pinned step: all handled.
- `verify-run.ts` — throwing `applies`, throwing `run`, timeout, zero-test suite each fail by name.
- `verify-merge.ts` — missing part, missing shard, duplicate shard, mixed totals, differing corpus hash, a step in two parts: all red.
- `scripts/lib/corpus.ts` scope floors prevent a zero-file green.
- `release.ts` — unknown flags, `--bump` typos, non-forward versions, a dirty tree refused before any write.
- `scraping` `robots.ts`, `cookie-scope.ts`, `http-redirect.ts`.
- Reserved-word, digit-leading, path-shaped generator names are refused.
- `generate-write.ts` — two-pass, no half-write, containment proven first.
- `coverage-lcov.ts` merge rule; `x verify --workers 1`; `packages/testing/src/matchers.ts`.

## Not read — handed to sweep 2

| Area | Files |
|---|---|
| `cli` | `x dev`, `serve`, role boot, `runtime-*`, `x build`, prerender, islands, `x db` and migrations, `x doctor`, the MCP host, `x shot` / CDP, `x pr`, `x ci`, `error-contract` / `fix-scan`, `workspace-checks`, `parse`, `dispatch`, most templates |
| `admin` | MCP tools, audit, `action-gate`, relations, search, dev dashboard, jobs screens |
| `testing` | fixtures, island harness, CDP / e2e stack, `template-db` |
| `scraping` | `http.ts`, CDP drivers, `session-state`, `secrets`, `scrape-run` |
| `scripts/` | `manifest`, `lockfile-pins`, `version-stamps`, `changelog-check`, `gate-steps`, `doc-commands`, `error-map`, `error-render`, `image-contract`, `release-workflow`, `trust-publishers`, `setup`, `scaffold-gate`, `roadmap`, remaining ratchet guards, `bench/` |
