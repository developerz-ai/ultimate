# 01 — Core transport seam

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0.

## Files to change
- `packages/core/src/client-transport.ts` (new) — the ONE browser HTTP function. Composes `createClientFlight` (`client-flight.ts`) for dedupe / deadline / retry / supersession; owns `credentials: 'same-origin'`, `Accept`, JSON body, idempotency-key header, non-2xx → `UltimateError` via the existing error-envelope decode. `fetch` is an injected default parameter (`fetchImpl = globalThis.fetch`), never a module-scope call — the shape `scripts/flight-copies.ts` already recognises.
- `packages/core/src/record-envelope.ts` (new) — decode `{ data, records?: { [entity]: Row[] }, removed?: { [entity]: string[] } }`; pure, schema-free (rows are validated by the sink owner).
- `packages/core/src/record-sink.ts` (new) — `RecordSink` interface (`adopt(entity, rows)`, `remove(entity, ids)`) + the page handle: `pageClient()` reads/creates `globalThis[Symbol.for('ultimate.client')]`. Store, transport and socket slots; realtime fills the store/socket slots.
- `packages/core/src/errors.ts` — codes: `X_CLIENT_TRANSPORT_FAILED` (network fault), `X_CLIENT_RECORD_ENVELOPE_INVALID`. Follow `bun run add-error-code` skill; rows in `wiki/Error-Codes.md`.
- `packages/core/src/index.ts` — named re-exports; `package.json` `sideEffects` unchanged (none of these run at import).

## Steps
1. Read `client-flight.ts` header: value imports stay out of `action`/`query` `client.ts` — `clientTransport` must be a small module whose value import does NOT pull `createClientFlight`'s full graph unless flight options are used (measure with `bun build --target=browser --minify`).
2. Write `record-sink.ts`; the handle is the only `globalThis` write — one `Symbol.for` key, the pattern core already uses for `ultimate.error`.
3. Write `client-transport.ts`: `request(desc)` → dispatch → decode envelope → if `records`, `pageClient().store?.adopt(...)` → return `data`. No store installed = records dropped silently (SSR / tests).
4. `bun run manifest`.

## Tests
- `client-transport.test.ts`: dedupe of concurrent identical GETs (one `fetchImpl` call); a write never dedupes without an idempotency key; non-2xx becomes the registered code; `TypeError` → `X_CLIENT_TRANSPORT_FAILED`; records reach a fake sink; no sink = no throw.
- `record-sink.test.ts`: two module copies (import via two distinct specifiers / `?v=` query) resolve the SAME handle — the per-island-bundle bug, reproduced.
- `bun test packages/core/src/client-transport.test.ts`.

## Done when
- Browser bundle of `import { clientTransport } from '@ultimat3/core'` measured and recorded in the file header.
- `bun run typecheck && bun run boundaries` green.
