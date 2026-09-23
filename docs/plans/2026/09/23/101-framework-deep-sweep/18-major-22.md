# 18 — 22.0.0: every breaking item, one sweep

> Part of [`overview.md`](overview.md). Depends on: 01–17 for the items each row names. Tier: all.

Rule: a breaking change ships only in a major, with a `BREAKING —` entry under `[Unreleased]` and a
`wiki/Upgrading.md` row in the same PR (`bun run changelog-check`). No codemod: each row names its
manual edit. Plan 102's majors (`ai.mcp.path`, admin tool names, `AuditRecord.action`,
`locales`/`defaultLocale`) join this release too.

## Rows

| # | Break | From | Manual edit the upgrade row states | Decision needed |
|---|---|---|---|---|
| a | `channel()` requires `policy`, and a public channel says `policy: allow()` | 06 a | add `policy` to each channel | no |
| b | delete `core/src/result.ts` (`Result`, `ok`, `err`, `map`, …; no consumer anywhere, and a second error path beside `throw UltimateError`) | `packages/core/src/index.ts:585-586` | replace with `throw`/`try` | no |
| c | delete realtime's exported `backoffDelay` (0-based) and keep core's (1-based). Its caller `client.ts:372` passes `attempt + 1`. Delete `thundering-herd-core-parity.test.ts` | `packages/realtime/src/thundering-herd.ts:69`, `index.ts:161` | import from `@ultimat3/core` and add 1 | no |
| d | `@ultimat3/testing` drops its `startLiveReplicator` re-export | 12 a | import from `@ultimat3/realtime/server` | no |
| e | move the 26 `e2e-*`/`cdp-*` files (~3.4k LOC) from `cli` to `testing`, and delete the stale `packages/cli/CLAUDE.md:396-402` section | `packages/cli/src/e2e-*`, `cdp-*` | import `useE2eDriver` etc. from `@ultimat3/testing` | **yes**: which browser driver survives. Raw CDP (e2e) vs `@ultimat3/scraping` + `puppeteer-core` (`x shot`, `mcp-ui*`, `browser-launcher.ts:14-16`). Moving shot onto raw CDP (`cdpConnect`, `cdp-connection.ts:89`) removes the puppeteer requirement |
| f | prune unreferenced barrel exports. `cli` has 230 of 355 unreferenced. Others: `auth` 112/198, `scraping` 110/160, `ui` 131/246, `jobs` 87/195. Error classes stay (apps use `instanceof`). `reset*` test hooks and internals move to an `./internal` subpath. Delete `ts-scan.ts:37-39`'s re-export of core masks, and point `scripts/` at leaf modules | each `src/index.ts` | import from `./internal` or stop using | **yes**: how aggressive to be. Recommend `cli` fully, and the others' non-error internals only |
| g | auth tables: fold `X_USERS_MIGRATION_1_3` (`auth/src/tables.ts:52`, applied by nothing) into the boot DDL (`cli/src/framework-schema.ts:40,94`). Delete the per-table `X_*_TABLE` exports and the README "paste into a migration" section (`auth/README.md:466-472`) | `packages/auth/src/tables.ts:1-3` | delete any hand-pasted auth migration; boot owns it | **yes**: confirm boot may `add column if not exists` on a live users table |
| h | `cli/src/drift.ts:31`'s private canonical serializer emits `"key":null` where core's drops the key, contradicting its own comment. Switch to `canonicalJson`, which re-stamps every app's `.hash` sidecars | `packages/cli/src/drift.ts:31` | run `x db gen` once after upgrading, to re-stamp | **yes**: ship it with this major (recommended) or defer |
| i | `t.date` refuses non-ISO strings (01 a), if not shipped as a patch | 01 a | pass ISO-8601 | **yes**: patch (a bug fix) or major. Recommend major, because apps may accept user-typed dates |
| j | `invokeAdminAction` drops the `expectedConfirmation` input (09 a derives it) | `packages/admin/src/action-gate.ts` | stop passing it | no |
| k | drop the `x-cache-tags` header (02 k), if anything external reads it | `packages/http/src/response.ts:211` | read `Surrogate-Key`/`Cache-Tag` | no |
| l | plan 102's four majors | plan 102 rows 3, 6, 7, 13 | per 102 | per 102 |

## Steps
1. Decide rows e, f, g, h and i first (record each in `status.yml` `notes`).
2. One PR per row, each with its `BREAKING —` entry and `wiki/Upgrading.md` row. The in-flight major's count is checked by `changelog-check` (`[Unreleased]` `BREAKING —` count).
3. Update both tracked apps in the same PR as each row (`bun run scripts/reference-app-gate.ts`).
4. Release per `PUBLISHING.md` with `scripts/release.ts --bump major` (slice 15 hardened it).

## Tests
- Every row's package suite, plus `bun run scripts/reference-app-gate.ts`, `bun run changelog-check`, `bun run manifest`, `bun run verify`.

## Done when
- `[Unreleased]` holds one `BREAKING —` entry per row.
- `wiki/Upgrading.md`'s 22.0.0 section count matches.
- Both tracked apps are green on their ratchets.
- `bun run verify` is green.
