# 29 — v31 deletions: one way to do each thing, a public API that is the API

> Part of [`overview.md`](overview.md). Depends on: [`20`](20-observability.md), [`21`](21-adapter-wiring.md) (they delete the slots and setters; this slice deletes the rest). Tier: every package. Two sweeps: 14 (D1, D5–D9, D11, names) and 15 (D10 barrel split, last because it touches every package).

## Deletions
| # | Delete | Keep | Est. files |
|---|---|---|---|
| D1 | The six framework mails (`welcome`, `verify-email`, `reset-password`, `invite`, `mfa-enrolled`, `security-alert`) and `FRAMEWORK_MAILS` (`mail/src/templates/index.ts:34`, `mail/src/catalog.ts:52,64`). Nothing sends them; `verify-email`/`reset-password` expect `{name, url, expiresMinutes}` while auth sends `auth.email-verify`/`auth.password-reset` with `{link, expiresAt}` (`auth/src/verify.ts:40-43,110`); `welcome`/`invite` are business convention (axiom 8) | auth's `auth.<purpose>` templates in the app catalog | ~12 |
| D5 | Retry shapes `RetryPolicy` (`ai/src/gateway.ts:48`), `BackoffPolicy` (`realtime/src/thundering-herd.ts:25`), jobs' `jitter: boolean` (`jobs/src/retry.ts:18`) | core `RetryPolicy` (`core/src/retry-loop.ts:16`) | ~15 |
| D6 | `JsonValue` copies: `cli/src/output.ts:95`, `manifest/src/schema.ts:26`, `render/src/island-props.ts:10` | `schema/src/json-value.ts:23` | 4 |
| D7 | `Surface` in `seo/src/routes.ts:9` | render's (`render/src/surfaces.ts:12`) moved to `core/src/route-vocabulary.ts` | 4 |
| D8 | Serializer copies: `mcp/src/remote-lock.ts:127`, `testing/src/seed-writer.ts:18`, `testing/src/cassette-format.ts:124` | `action/src/stable.ts:15` (document form), `core` `canonicalJson` (hash form) | 4 |
| D9 | Legacy unkeyed fingerprint branch: `core/src/keyed-fingerprint.ts:50`, `action/src/idempotency.ts:403` | keyed form | 3 |
| D11 | Public `registerAction(s)`/`registerQuery(ies)`/`registerJob(s)`/`registerTask(s)` (`action/src/registry.ts:46,154`, `query/src/registry.ts:19,41`, `jobs/src/register.ts:27,48`); zero app callers; `defineApi` is the path | a `./loader` subpath used by `cli` | ~8 |
| N1 | `Row` declared three times (`core/conflict-policy.ts:9`, `entity/expr.ts:36`, `realtime/json.ts:24`) | rename realtime's to `LiveRow` | 4 |
| D10 | ~2,672 barrel exports named nowhere outside their package (1,790 types, 287 constants, 513 functions, 82 error classes; e.g. `storage/src/index.ts:79-106`, http `rateLimitInvalid`, db `migrationChecksum`, admin `batchPlan`, testing `lockSql`) | `.` = app API; `./adapter` = ports + driver errors ([`21`](21-adapter-wiring.md)); everything else unexported | ~30 barrels + fallout |

Not deleted (falsified as defects): `config-removed.ts` rows (kept forever by design), the MCP `legacy` protocol era (clients still speak it), `stableStringify` vs `canonicalJson` (two forms, argued), `t` re-exported from eight packages (one object), IndexedDB `QueueState` migration (`realtime/src/local-store-idb.ts:170` — deleting loses queued offline writes on stale devices; keep).

## Steps
1. Sweep 14: D1, D5–D9, D11, N1. Each deletion adds its `wiki/Upgrading.md` row (old → new) in the same PR.
2. Sweep 15: D10. Re-run the scan first (`scripts/` one-off in the scratch dir: every `src/index.ts` name vs uses outside its package, README/CLAUDE.md counting as use). Move port types to `./adapter`; unexport the rest; fix fallout; regenerate `framework.manifest.json` (`bun run manifest`, coordinator).

## Tests
- `bun run typecheck`; the app gate on all three tracked apps (`bun run scripts/reference-app-gate.ts`); scaffold-smoke on every shape.
- `scripts/` export scan re-run: zero names unused outside their package except those listed in a reviewed allowlist (driver-author errors in `./adapter`).

## Done when
- `wiki/Upgrading.md` 30 → 31 lists every deletion with its replacement; the three tracked apps and all scaffold shapes gate green.
