# 03 — Principal scope fence

> Part of [`overview.md`](overview.md). Depends on: 01. Tier: 0.

A response, frame or persisted row that belongs to the previous principal must never land in the next one's store. One signal, every layer subscribes.

## Files to change
- `packages/core/src/client-scope.ts` (new) — `ClientScope = { principal: string \| null, epoch: number }` on the page handle (`record-sink.ts`, slice 01). `rescope(next)` bumps `epoch` and notifies subscribers synchronously.
- `packages/core/src/client-transport.ts` — every flight captures `epoch` at dispatch; on `rescope`, in-flight **reads** abort via `createClientFlight`'s supersession and reject with `X_CLIENT_SCOPE_CHANGED`; in-flight **writes** are never aborted (a write may have landed) but their response is NOT adopted into the new scope. A superseded read is never surfaced as a UI error (`isSuperseded(err)` helper).
- `packages/core/src/errors.ts` — `X_CLIENT_SCOPE_CHANGED`.
- Subscribers registered by later slices: store wipes non-persisted records (06), socket drops all channel subscriptions and reconnects with the new ticket (09/11), persister switches DB scope and wipes the old scope on sign-out (12).
- Trigger: the page client reads the principal from the session the server rendered into the page (auth, tier 2, owns the value; core owns only the fence). Sign-in/out actions call `rescope` on success.

## Steps
1. `client-scope.ts` + transport integration.
2. Document the subscriber contract in the file header; later slices register.

## Tests
- `client-transport.test.ts`: a GET in flight across `rescope` rejects `X_CLIENT_SCOPE_CHANGED` and adopts nothing; a POST in flight completes, its records are dropped; `isSuperseded` true for both abort shapes.
- `client-scope.test.ts`: subscribers called once per change, not on a same-principal rescope.

## Done when
- `bun test packages/core/src/client-scope.test.ts packages/core/src/client-transport.test.ts` green.
