# 41 — Knowing production: real-user timings, a trace across a live query, error groups, an honest rollback

> Part of [`overview.md`](overview.md). Depends on: [`12-core-error-fingerprint.md`](12-core-error-fingerprint.md), [`24-web-client-errors.md`](24-web-client-errors.md), [`19-cli-deploy-verify.md`](19-cli-deploy-verify.md), [`04-db-migration-safety.md`](04-db-migration-safety.md) (`migrate.ts`, the ledger's neighbour). Tier: 0 (`core`), 1 (`db`), 3 (`realtime`, `query`), 5 (`admin`, `cli`).

## Why
| Gap | Evidence |
|---|---|
| Vitals never measured | `budget.lcp`, `budget.cls`, `budget.tbt` are removed declarations, "never measured" (`docs/idea/07-rendering-seo.md:155`). Byte budgets guard the build; nothing says what users get. Browsers expose it with no library: `PerformanceObserver` |
| A live query loses its trace | HTTP clients send `traceparent` (`action/src/client.ts:167`). `grep -i traceparent` over `realtime/src` and `query/src/live.ts` answers nothing, so a slow subscribe starts a new trace and cannot join the page's |
| Errors have no home without a vendor | `ErrorReporter` is a seam with a memory sink and one vendor wire (`core/src/error-reporter.ts:82`). Two repositories built error-to-issue loops (8,000 and 483 LOC); 12 ships the shared half, the group key. The other shared half is a table: first seen, last seen, count, and "this one is new", exactly once across replicas |
| A rollback can be the second outage | `ledgerAheadOfBuild` lets an older build through (`db/src/migrate-rollback.ts`, `db/src/migrate.ts:210`), logging a warning. The runbook says this is safe "only if the migration was additive" (`docs/ops/06-runbooks.md:130`). The framework knows (`db/src/destructive.ts:87`), and throws the fact away: `LedgerRow` holds no such bit (`db/src/migration-ledger.ts:27`) |

## Decisions
| Question | Answer |
|---|---|
| Vitals transport | the door from 24: same route family, same off-by-default, same `app/`-only. `site/` opts in separately, because a beacon costs that path bytes; measured against its budget (axiom 6) |
| Vitals storage | a histogram metric through `core/src/metrics.ts`. Labels: route pattern, metric. Never the URL: cardinality. No store |
| Trace on a socket | a `traceparent` on the `subscribe` frame. A push answers no request, so re-runs link to it and do not parent |
| Error store | a sink behind `ErrorReporter`, composing with others. Not a new seam. Table `x_error_groups` owns counts; a bundle an agent replays is `x_failures`' ([`40-next-repro.md`](40-next-repro.md)), never stored here |
| Issue opening | `onNewGroup` takes a job handle. Which tracker, title and assignee are the app's (axiom 8). `errorIssueJob()` itself stays out |
| `x rollback` | no command: `x deploy --image <old>` is that already, and the previous image lives in the platform (axiom 7). The check goes in the migrate role, which every deploy path runs, including GitOps |

## Files to change
- `packages/core/src/config-client-errors.ts` (from 24) — `clientVitals: { enabled, sampleRate, surfaces }`.
- `packages/cli/src/client-vitals-script.ts` (new) — LCP, CLS, INP, FCP, TTFB on `visibilitychange` through `sendBeacon`. `packages/cli/src/client-vitals-route.ts` (new).
- `packages/core/src/metric-names.ts` — `web_vital_seconds`, `web_vital_cls`.
- `packages/realtime/src/client.ts:290,328`, `client-channels.ts:454`, `client-frames.ts:151` — optional `traceparent`.
- `packages/query/src/live.ts`, `packages/realtime/src/channel-*` — open the span from it; link on re-run.
- `packages/admin/src/error-groups-store.ts`, `error-groups-pg.ts` (new), `error-groups-schema.ts` (new, leaf) — the sink; a memory twin with a parity test.
- `packages/admin/src/pages.ts`, new `errors-list.tsx`, `errors-detail.tsx` — `/admin/errors`.
- `packages/cli/src/framework-schema.ts:148` — the table's row.
- `packages/db/src/migration-ledger.ts:27,52` — `destructive boolean`, added `if not exists`, set at apply.
- `packages/db/src/migrate-rollback.ts`, `migrate.ts:210` — refuse.
- `examples/dummy/` — `clientVitals` on; the sink; `onNewGroup` enqueuing one app job.
- `wiki/Observability.md`, `wiki/Admin-Dashboard.md`, `wiki/Deployment.md`, `docs/ops/06-runbooks.md:130`, READMEs, `wiki/Error-Codes.md`, `wiki/Upgrading.md`.

## Steps
1. Vitals: a sampled session, one beacon per page view, values clamped, unknown names dropped. Route pattern comes from the document's own marker, never free text. Anonymous by default: no actor on a metric, unlike 24's reports. Rate limited by address. Refused bodies are `204`, so a probe learns nothing.
2. The script stays out of a route's bundle graph: inlined only when on, counted by `measureDocumentJs`, raised by `bun run budget-raises` where measured.
3. Trace: the client sends the current `traceparent` on subscribe. Live: `withSpan` on the snapshot, parented; a later delta opens a span with a link. Refused, invalid values are ignored as `resolveTimeZone`'s are: telemetry never fails a subscribe.
4. Error groups: `errorGroupsSink({ store, onNewGroup?, ignore? })`. Upsert on `errorFingerprint` (12); `xmax = 0` decides "new" atomically, so 5 replicas enqueue once. Stores code, message head, first and last seen, count, a sample report redacted by 10's `.sensitive()`. Writes are outside the request's transaction, because a rollback must not erase its own error. Bounded by a per-minute cap per process; over it counts only. A failure here logs and never re-enters the reporter.
5. `purgeTarget` included, with `olderThanMs` required; retention is the app's. Resolve, ignore and re-open in admin, audited as every admin operation is.
6. Rollback: at apply, store `isDestructiveMigration(up)`. An older build meeting ahead rows with `destructive = true` refuses with `X_MIGRATION_ROLLBACK_DESTRUCTIVE` before anything serves. `ROLLBACK_ALLOW_DESTRUCTIVE=<migration id>` is the operator's written override: naming the row forces a look. A null bit, on rows from before this slice, keeps the warning: the framework cannot know. Note the deploy order: the refusing code must be in the image rolled back to, so the guarantee starts one release after this one, and the docs say so.
7. `x deploy verify` (19) then proves the rolled-back build serves. No `x status`: 19's `--json` answers it.

## Error codes
`bun run new-error-code` for each row.

| Code | When | Fix |
|---|---|---|
| `X_MIGRATION_ROLLBACK_DESTRUCTIVE` (off-socket) | a rollback over a destructive migration | roll forward; or `ROLLBACK_ALLOW_DESTRUCTIVE=<id>` after checking that build |
| `X_CLIENT_VITALS_INVALID` (off-socket) | bad `sampleRate` or `surfaces` | a rate in 0–1; a listed surface |

## Tests
- `packages/cli/src/client-vitals-route.test.ts`: good body lands one histogram sample; an unknown name, a huge value and a raw URL do not. Metric label set stays bounded.
- `packages/cli/e2e/client-vitals.e2e.test.ts`: a real page beacons LCP on hide.
- `packages/realtime/src/client.test.ts`, `query/src/live.test.ts`: subscribe's span shares the trace id; a garbage header starts a fresh trace.
- `packages/admin/src/error-groups.live.test.ts`: two concurrent new reports, one `onNewGroup`; memory parity; a rolled-back transaction keeps its group.
- `packages/db/src/migrate-rollback.test.ts`: destructive refused; additive allowed; override only for the named row; null bit warns.
- `bun test packages/db/src/migrate-rollback.test.ts`

## Semver
**Breaking, two rows.** New framework tables and a ledger column land in each app's dump (`X_SCHEMA_DUMP_DRIFT`). A rollback that passed now refuses. Upgrading: "`x db gen`, commit `packages/db/schema/`"; "a rollback over a destructive migration needs `ROLLBACK_ALLOW_DESTRUCTIVE=<id>`."

## Done when
- `/admin/errors` in `examples/dummy` groups one thrown fault across two requests into one row.
- A rollback across a dropped column refuses in a live test.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
