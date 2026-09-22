# 02 — Shared client vocabulary moves to core

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0.

Two types every client layer needs are declared in a package the others may not import. Tier 0 is the only home all of `ui` (4), `action` (3) and `realtime` (3) can reach.

## Files to change
| From | To | Why |
|---|---|---|
| `AsyncState<T>` in `packages/ui/src/components/async-branch.ts:13` | `packages/core/src/async-state.ts` | realtime's `useQuery` / `useRecord` (slice 07) must return it; ui (tier 4) and realtime (tier 3) cannot import each other's way |
| two conflict vocabularies: `custom(merge)` over **outputs** in `packages/action/src/mutator.ts:54-63,178-199`; `CustomMerge` over **rows** in realtime, output spelling silently dropped by `replayable()` in `packages/realtime/src/hooks.ts:269-277` | ONE `ConflictPolicy` in `packages/core/src/conflict-policy.ts`: `'server-wins' \| 'last-write-wins' \| { kind: 'custom', merge(local: Row, server: Row): Row }` | the store is row-shaped, so rows win; a silent drop is the "answered the wrong thing" defect |

- `packages/ui/src/components/async-branch.ts` — imports `AsyncState` from core; **no re-export** (one home).
- `packages/action/src/mutator.ts` — `conflict` typed `ConflictPolicy`; `custom()` builder merges rows; `strategyOf`/`resolve` collapse onto core's.
- `packages/realtime/src/hooks.ts:170,269-277` — `ConflictLike` + `replayable()` deleted; `rebase.ts` consumes `ConflictPolicy` directly.

## Steps
1. Add both core modules; export named from `packages/core/src/index.ts`.
2. Repoint ui, action, realtime; delete the old declarations.
3. `BREAKING —` entries: `AsyncState` import path; `custom(merge)` now receives rows. Each names its manual edit.

## Tests
- `packages/core/src/conflict-policy.test.ts`: each strategy resolves as documented; `custom` receives the two rows.
- `packages/realtime/src/rebase.test.ts`: a `custom` policy declared on a mutator is CALLED on rebase (today it is dropped — this test fails on the old tree).
- `bun run boundaries` — no new edge.

## Done when
- `rg "ConflictLike|replayable\(" packages` empty; `rg "export type AsyncState" packages` → only core.
