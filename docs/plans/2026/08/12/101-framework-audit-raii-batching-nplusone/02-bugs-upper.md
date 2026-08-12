# 02 — Bugs: tiers 3–5

> Part of [`overview.md`](overview.md). Depends on: none (01 recommended first). Tiers: 3–5.

## S1 — broken product promises

- **`query` has no HTTP projection.** `packages/query/src/naming.ts:31` derives `/_x/query/<kebab>` and `packages/query/src/client.ts:52` fetches it, but nothing builds or mounts the route — `packages/cli/src/serve.ts:188-193` composes only `listActions().map(toRoute)`. `query.client()` 404s in every app while `wiki/Queries-And-Live-Queries.md:45,57` and `packages/query/README.md:33` document it as shipped. Fix: a `toRoute` in `packages/query/src/http.ts` mirroring `packages/action/src/http.ts:35`, mounted from `serve.ts` (cli → query is downward, legal). Unblocks the dummy-app call sites in [`05-dummy-app.md`](05-dummy-app.md).
- **The realtime client never reconnects.** `packages/realtime/src/client.ts:392-399` computes backoff into a signal but schedules no timer and never calls `connect()`; after `onClose` (`client.ts:150-155`) every registration is `offline` forever. `hooks.test.ts:386` admits it. Fix: schedule the reconnect; cancel on `close()`; test with fake timers.
- **MCP exposure decided two ways.** Fail-open readers `packages/action/src/action.ts:288` (`?? true`) and `http.ts:130` (`!== false`) vs four fail-closed readers (`expose === true`: `action/src/mcp-tool.ts:62`, `query/src/mcp-tool.ts:64`, `mcp/src/from-action.ts:61`, `mcp/src/projectable.ts:88`). Manifest publishes the wrong answer; `manifest/src/diff.ts:94-99` then misclassifies a real opt-in as breaking. Fix: `expose === true` everywhere; one shared predicate.
- **Memory vs SQL semantics diverge on NULL.** `packages/query/src/shape.ts:88-102` sorts/matches `null` as string `"null"` and `same()` matches `null === null`; `source.ts:88-98` emits `= $1`, `:158-172` emits `> $n` — so `where({deletedAt: null})` matches in memory, never in Postgres, and a NULL sort key blanks page 2. The live matcher (`matcher.ts:113-121`) inserts rows at positions the DB wouldn't. Fix: `is null` emission + explicit NULL ordering semantics, mirrored in `shape.ts`; parity tests.

## S2 — correctness under concurrency and failure

| Finding | Where | Fix direction |
|---|---|---|
| No single-flight: concurrent identical reads all execute; `undefined` never memoizes | `packages/query/src/cache.ts:79-95`, hit test `:83` | memoize the in-flight promise; sentinel for `undefined`. Prerequisite for [`07-batching.md`](07-batching.md) |
| Uncached queries never memoized at all | `packages/query/src/read.ts:106-108` | request-memo every query, `cache:` or not |
| Worker leaks an `onShutdown` per `start()` | `packages/jobs/src/worker.ts:412-414` | keep the unregister fn; call in `stop()` (pattern: `packages/realtime/src/sync-node.ts:381-395`) |
| `stop()` races in-flight `tick()`; driver closes under running jobs | `worker.ts:320-321`, `:396-402` | await the current tick before snapshot/close |
| Timed-out job orphaned, runs concurrently with its retry | `worker.ts:181-195`, `:137-142` | AbortSignal through the handler; fence step writes |
| Heartbeat failures swallowed silently | `worker.ts:300-302` | log + metric on lease loss |
| Head-of-line blocking: per-tick `Promise.allSettled` | `worker.ts:375` | refill slots as jobs settle |
| `state = 'stopped'` after `driver.close()`; rejection wedges `'draining'` | `worker.ts:403` | set state in `finally` |
| Scheduler: no re-entrancy guard, no drain on stop, no `onShutdown` | `packages/jobs/src/scheduler.ts:395-410` | copy the worker's settle-then-reschedule loop; register shutdown |
| Row gate swallows every predicate error as "denied" | `packages/realtime/src/policy-gate.ts:39-46` | rethrow non-`QueryDeniedError`; drop the decorative `await` at `:26,41` |
| Unknown live-query name reported as protocol-version mismatch | `packages/realtime/src/live-query.ts:166-172` | dedicated code + fix line |
| `reauthorize` unsubscribes on transient errors | `live-query.ts:254-263` | distinguish denial from failure |
| Shared-window double build, mismatched matcher/source | `packages/realtime/src/live-definition.ts:73-99`, `live-query.ts:342` | in-flight dedup keyed on qid |
| `deliver()` mutates shared window across awaits; callers don't serialize | `live-query.ts:272-316`, `sync-node.ts:231` | per-entry delivery queue |
| `#read` once per subscribe, clobbers shared rows | `live-query.ts:366-379` | read once per entry, share |
| Cache invalidation after success fails the committed write; re-runs on idempotent replay | `packages/action/src/invoke.ts:112-118` | guard + skip on replay |
| Contract test #2 vacuous: `code: null` passes on `X_INPUT_INVALID` before policy runs | `packages/action/src/contract-test.ts:52-61`, `:112` | assert `X_FORBIDDEN` specifically; synthesize minimal valid input or invoke past validation |
| `.job()` absent from `AnyAction` | `packages/action/src/action.ts:165-181` | add to the erased view |
| Client synthesizes unregistered error codes | `packages/action/src/client.ts:135-146` | mark as remote-origin; don't fake docs URLs |
| `route-data` rethrows any error with a string `code` (ENOENT bypasses wrap) | `packages/render/src/route-data.ts:30` | use `isUltimateError` (pattern: `action/src/http.ts:66`) |
| `ctx as unknown as TData` when route has no `load` | `route-data.ts:23` | type it honestly |
| pg-replication leaves connection open when stream dies | `packages/realtime/src/pg-replication.ts:214-228` | close in the catch |
| `drain()` leaks changefeed subscription + sweep timer | `packages/realtime/src/sync-node.ts:341-357` | make drain include stop's teardown |
| `create-ultimate` stdout truncation (the bug `x` fixed) | `packages/create-ultimate/src/bin.ts:31-33` | copy `packages/cli/src/bin.ts:8-35` |

## S3 — dev-surface polish

- `packages/admin/src/dev/data.ts:160-163` — live panel's `sql` always empty; `packages/query/src/sql.ts:57` (`describeSql`) produces the fact. Wire it.
- `packages/admin/src/dev/data.ts:165` — `subscribers` panel permanently unwired (`packages/cli/src/dev-dashboard.ts:122-123`). Wire or remove the panel.
- `packages/admin/src/dev/panel-db.ts:19,29-35` — regex write-guard false-positives on `where kind = 'create'` and ignores comments. Harden.
- Panel `question`/refusal strings are English literals beside an i18n `titleKey` (`packages/admin/src/dev/panel.ts:12-13`, every `panel-*.ts`) — route through `t()`.
- `packages/mcp/src/registry.ts:135` — `private` instead of `#`, against house convention.
- `packages/jobs/src/scheduler.ts:28-30` vs `:381-385` — `catchUp: 'skip'` doc says wait, code dispatches latest missed. Align code or comment.

## Tests

- Failing-first per S1/S2: reconnect fires after backoff (fake timers); query route mounts and serves (`bun test packages/query`); one exposure predicate (`bun test -t 'mcp expos'`); `where null` parity memory-vs-SQL (recording client asserting `is null`); single-flight (two concurrent reads, one execution); worker start/stop/start registers one hook; contract test #2 fails on a policy that allows anonymous.

## Done when

- All S1/S2 fixed with tests; S3 fixed or moved to `wiki/Known-Gaps.md` with a row each; new codes registered + documented + `bun run manifest`; `bun run verify` green.
