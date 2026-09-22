# 05 — Typed clients on the one transport

> Part of [`overview.md`](overview.md). Depends on: 01, 04. Tier: 3.

## Files to change
- `packages/action/src/client.ts:74,96,100` — `rpc()` / `.client()` dispatch through `clientTransport`; delete the local `fetch` default. Keep `import type { ClientFlight }` (header rule in `core/src/client-flight.ts`).
- `packages/query/src/client.ts:103,125,129` — same for `queryClient()` / `.client()` GET `/_x/query/<kebab>`.
- Server handlers (action HTTP projection, query HTTP route) — wrap output in the record envelope when the output schema references an entity row (slice 04 `rowsOf`). Envelope-less output stays byte-identical, so `contract-diff` stays green for outputs with no entity rows.
- `packages/storage/src/upload-client.ts:115` — `fetch` fallback → `clientTransport`. `:63` XHR stays (progress events); header comment names why.

## Steps
1. Move dispatch; preserve every current option (headers, signal, idempotency key, flight).
2. Server: add envelope; the typed client strips it, so the client's return type is unchanged (no breaking change on `.client()`).
3. OpenAPI projection: `records` documented as an optional sibling of the payload; regenerate via the action OpenAPI projection, never hand-written.
4. Re-measure `rpc` (14.8 kB) and `queryClient` (12.8 kB) browser bundles; record the delta in `packages/action/CLAUDE.md` and `packages/query/CLAUDE.md`. Must not grow by more than the envelope decoder.

## Tests
- `action/src/client.test.ts`: a response carrying `records` adopts into a fake installed sink and returns only `data`.
- `query/src/client.test.ts`: same; concurrent identical queries share one dispatch.
- Contract tests (`*.contract.test.ts`) for one action returning an entity row: the envelope is present on the wire.
- `bun test packages/action packages/query`.

## Done when
- `rg -n 'fetch\(' packages/action/src packages/query/src --glob '!*.test.ts'` finds no call (only `idempotency-postgres.ts:210`'s local function named `fetch`, which the guard in slice 15 must not report).
- `bun run contract-diff` and `bun run verify` steps `unit`, `contract` green.
