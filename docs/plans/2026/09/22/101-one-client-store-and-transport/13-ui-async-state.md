# 13 — ui renders store state with no glue

> Part of [`overview.md`](overview.md). Depends on: 02, 07. Tier: 4.

`@ultimat3/ui` (tier 4) may not import `realtime`; it already takes data as `AsyncState` (`packages/ui/src/components/async-branch.ts:13`). With `AsyncState` in core (slice 02) and `useQuery`/`useRecord` returning it (slice 07), a component takes the hook's accessor directly.

## Files to change
- `packages/ui/src/components/*` taking async data — accept `Accessor<AsyncState<T>>` (core type), no adapter.
- `packages/realtime/src/hooks.ts` — `useRecord` returns `Accessor<AsyncState<Row | undefined>>`-compatible shape (`pending` until first adopt / load; `ready` after; `failed` on `X_RECORD_REJECTED` or load failure). Decide one shape with slice 07 and keep it identical.
- `packages/ui/README.md` — the canonical island snippet: `<AsyncList state={useQuery(feed, {})} />`.

## Steps
1. Align types; update ui components that took ad-hoc props.
2. One example in `examples/dummy` feed island uses a ui list over `useQuery` (slice 16).

## Tests
- `async-branch.test.ts`: unchanged behaviour on the moved type.
- A typecheck pin (`packages/ui/src/type-pins.tsx` pattern) that `useQuery(...)`'s return type is assignable to the ui prop — lives in `examples/dummy` (it may import both), not in ui.

## Done when
- No `toAsyncState`-style adapter exists anywhere (`rg -i "toAsyncState|asAsyncState"` empty).
