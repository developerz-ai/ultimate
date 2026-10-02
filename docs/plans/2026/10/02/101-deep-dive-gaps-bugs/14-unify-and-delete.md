# 14 — unify and delete

> Part of [`overview.md`](overview.md). Depends on: 01–13 merged (it touches files near most of them). Tier: cross-cutting.
> Second paths that need **no owner call**. Axiom 1: replace the original or do not plan it. Prefer deletion.

## Files to change
| Where | Change | Row |
|---|---|---|
| **new** `packages/cli/src/app-config-load.ts` + 17 sites in 16 files (`app-auth.ts:25`, `runtime-jobs.ts:39`, `runtime-cache.ts:77`, `runtime-realtime.ts:45`, `runtime-notify-retention.ts:58`, `serve-drain.ts:20,34`, `site-config.ts:46`, `theme-boot.ts:31`, `pwa-artifacts.ts:139`, `page-navigation.ts:72`, `page-speculation.ts:40`, `shot-locale.ts:26`, `app-env.ts:56`, `cmd-deploy-helm.ts:70`, `island-bundle.ts:367`, `app-mcp.ts:69`) | one `loadAppConfig(root)` returning the validated, default-merged `AppConfig`; the 17 structural walks deleted | `s1-arch #2` (count corrected in `s3-t45`) |
| `packages/cache/src/purge-env.ts:3`, `packages/jobs/src/driver.ts:319`, `packages/mail/src/driver.ts:219`, `packages/scraping/src/driver.ts:105` | headers match what the loader does | `s1-arch #2` |
| ten `X_NOT_IMPLEMENTED` constructors: `auth/src/errors.ts:383`, `db/src/errors.ts:422`, `storage/src/errors.ts:370`, `seo/src/errors.ts:185`, `pwa/src/errors.ts:135`, `realtime/src/errors.ts:409`, `jobs/src/errors.ts:457`, `cli/src/errors.ts:386`, `scraping/src/error-throws.ts:436`, `admin/src/errors.ts:261` | deleted — callers use core's `notImplemented(feature, fix)` (`packages/core/src/errors.ts:219,236`) | `s1-arch #10` |
| `packages/auth/src/oauth-errors.ts:163-165` | its own code — "the adapter returned no row" is a runtime fault | `s1-arch #10` |
| `PgExecutor` in `action/src/idempotency-postgres.ts:31`, `auth/src/rate-limit-postgres.ts:20`, `http/src/rate-limit-postgres.ts:21`, `jobs/src/driver-pg.ts:83` | one exported type in `core` (http stays db-free); three copies deleted | `s1-arch #12` |
| `packages/ai/src/llm-cache.ts:122`, `embeddings.ts:107` | keys through core's `fingerprint`; the `fnv1a` copy deleted | `s1-arch #13` |
| `packages/mcp/src/validate-args.ts` (236 LOC), `packages/action/src/mcp-tool.ts` (`mcpSchemaOf`), `packages/mcp/src/projectable.ts:59,99` | `narrow()` moves to `schema`; `.tool()` returns the served shape; the second validator deleted for projected primitives | `s2-arch M3` |
| `packages/cli/src/cmd-test.ts:186-192`, `cmd-test-spec.ts:32` | `--worker`, `X_TEST_SHARD_FAILED`, `ULTIMATE_TEST_WORKER` deleted — `--shard i/n` is the one way | `s2-arch M4` |
| `packages/cli/src/templates/scaffold-db-client.ts:90`, `examples/dummy/apps/web/app/runs/keys.ts:33`, `dummy/social-media-clone/apps/admin/app/admin/admin.ts:101` | one `storeMode(env)` in `core`; three ternaries deleted | `s2-arch M6` |
| `packages/cli/src/budgets.ts:44-51`, `examples/dummy/apps/web/site/page.tsx:21` | `RouteBudget.lcp`, the `lcpMs` branch, the `_EveryBudgetKeyIsProjected` arm deleted | `s2-arch L2` |
| `packages/testing/src/preload.ts:59`, `packages/cli/src/test-shards.ts:56` | import the constant from `packages/testing/src/isolated-plugins.ts:13` | `s2-arch L3` |
| `packages/cli/src/error-catalog.ts:47-62` | `admin` and `ui` removed from the optional hosts | `s2-arch L4` |
| `packages/cli/src/tasks-facts.ts:33` | local `isoInZone` deleted — import from `time` (slice 03 exports it) | `s2-arch L5` |
| `packages/storage/src/driver.ts:45-58`, `driver-s3.ts:206`, `driver-local.ts:182`, `driver-memory.ts:98` | `serverSideEncryption` and its three refusals deleted | `s1-arch` low (low confidence — read the doc block first) |
| `packages/jobs/src/errors-requeue.ts`, `packages/auth/src/oauth-errors.ts`, `packages/cli/src/build-errors.ts`, `verify-errors.ts` | each constructor next to its one thrower; size-split error files folded | `s1-arch #14` |
| `packages/ui/src/theme/inline-script.ts`, `packages/ui/src/index.ts:316-320` | the export marked "removed in 21" deleted (BREAKING) | `s1-t4` low |

## Steps
1. One PR per row group; each lands with the guard that keeps the second path from returning (axiom 3):

| Unification | Enforced by |
|---|---|
| one config loader | a `boundaries` rule refusing `import(` of `APP_CONFIG_FILE` outside `app-config-load.ts` |
| one `notImplemented` | `scripts/` guard: a local constructor of `X_NOT_IMPLEMENTED` outside `core` |
| one `PgExecutor` | typecheck — the copies are gone |
| one `fingerprint` | `scripts/flight-copies.ts`-style copy guard, or extend it |
| one shard flag | the spec no longer declares `--worker` |
| one store mode | the scaffold test pins the template to `storeMode` |

2. Config loader: `scripts/config-readers.ts` already answers "who reads key X" — re-point it at the single loader and delete pins it no longer needs. The state-dir bug (`s2-cli #1`, fixed narrowly in slice 12) disappears structurally: delete that narrow fix's `dirname` remnants.
3. `narrow()` moving to `schema` is a downward move (tier 4 → 0); `from-action.ts:23`'s stated tier reason points the wrong way — delete the comment.
4. BREAKING rows (`--worker`, the `ui` export, `serverSideEncryption`) each get a CHANGELOG entry and a `wiki/Upgrading.md` row; batch them into one major.
5. Run `bun run manifest` after the error-code moves; `bun run boundaries` after every move.

## Tests
- `packages/cli/src/app-config-load.test.ts` (new) — every key each old walker read, with its old default, in one fixture.
- A chord-free parity run of `bun run x -- doctor --json` and `bun run x -- routes --json --cwd examples/dummy` before and after: byte-equal.
- `bun test packages/cli packages/mcp packages/action packages/ai`; `bun run scripts/reference-app-gate.ts`.

## Owned elsewhere
- xxHash32 ×3, four HTML escapers, `readCookie` ×2, hand-written sideways-edge lists, typed step names — **2026-09-28 plan, slice 08. All open.** `s1-arch #8, #9` add two escaper sites and two edge-list sites: append them there.
- Query's comparator — slice 06. Three CDP drivers — slice 15 (blocked on scraping's tier).

## Done when
- `grep -rn "import(configPath)" packages/cli/src` shows one file.
- `grep -rn "X_NOT_IMPLEMENTED" packages/*/src/errors*.ts` shows `core` only (plus pinned exceptions with a `why:`).
- Each unification's guard fails on a reintroduced copy (mutation-test it once).
- `bun run verify` green; no `FLOOR_ABOVE` or `SIDEWAYS_ALLOW` row added.
