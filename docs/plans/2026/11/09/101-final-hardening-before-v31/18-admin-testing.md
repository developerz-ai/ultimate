# 18 — admin and testing: one SQL role, exported stores, honest test tools

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 (`admin`, `testing`). Conformance suites are [`19`](19-conformance-suites.md); `AuditSink` merge is [`21`](21-adapter-wiring.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| T1 | Low (security) | `admin/src/dev/sql-runner.ts:22-26` | the `/_x` DB panel runs `readOnlyQuery` without `role` — as the app's own (often superuser in dev) user; MCP `db.query` adds the SELECT-only role (`cli/src/mcp-host.ts:225`). Guarded by host check and same-origin; a parse-guard miss has no second layer | `role: await ensureReadOnlyRole(client)`, as `mcp-host.ts:225` |
| T2 | Low | `admin/src/error-groups-store.ts:64` | `ErrorGroupsStore` and its implementations unexported: a port no one can implement | export from `admin`'s adapter subpath; conformance in [`19`](19-conformance-suites.md) |
| T3 | Med (adopter-found) | `testing/src/plan-sweep-fix.ts:200-251` | index advice misfires: (a) recommends an index led by `id` for `where x < $1 order by id limit n`; (b) ignores a partial unique index under `one()`. Shape `on: []` already fixed (`plan-sweep-report.ts:86`) | failing tests for (a) and (b), then fix the advice |
| T4 | Low (CI flake) | `testing/src/drill-run.test.ts:191`, `drill-run.ts` | a `recovers` failure appeared beside the expected `requests-coded`; the recovery window likely reads the real clock, not `s.sleep` | thread the injected clock through the recovery window |
| T5 | Low (quality) | `testing/src/seed-writer.ts:18` | writes `bytes` as hex: non-injective against a hex `text` column (also listed in [`29`](29-v31-deletions.md) D8) | use `action/src/stable.ts` document form |

## Files to change
- `packages/admin/src/dev/sql-runner.ts` — T1. `admin/src/error-groups-store.ts`, `admin/src/index.ts` or `admin/src/adapter.ts` — T2.
- `packages/testing/src/plan-sweep-fix.ts`, `plan-sweep-fix.test.ts` — T3. `drill-run.ts` — T4. `seed-writer.ts` — T5.

## Tests
- `sql-runner.contract.test.ts`: recording client sees `SET LOCAL ROLE`.
- `plan-sweep-fix.test.ts`: shapes (a) and (b).
- `drill-run.test.ts`: run 50× in a loop locally with no failure.
- `bun test packages/admin packages/testing`

## Done when
- The three tests above are green and the drill test has not flaked across 3 CI runs.
