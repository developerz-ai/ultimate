# Client data layer

**One record store per tab, one HTTP seam per page, one socket per origin.** Every read, write,
realtime frame and offline replay in a browser passes through those three and lands in the same
record, keyed `entity:id`. The store is the client **projection of `entity`** (axiom 2) — not a
ninth primitive: writes stay `action` / `mutator`, reads stay `query`, channels stay realtime's.

**Status, `As of 2026-09-23`:** shipped in **21.0.0** (`CHANGELOG.md`). All seventeen slices
landed: the tier-0 seam, the entity projection, the
action/query envelope, realtime's record store and hooks, channels, the shared socket, offline
(persister, outbox, page boot), `ui` rendering core's `AsyncState`, the two guards as gate steps,
and both tracked apps migrated. Every table below carries a status column, and that
column is the only place this page claims something exists — re-derive it with `ls` on the path it
names, never from the prose. The plan is
`docs/plans/2026/09/22/101-one-client-store-and-transport/`. The app-author recipe (exact imports, one
idiom per task, the codes you will hit) is [`wiki/Client-Data.md`](../../wiki/Client-Data.md).

## The measured before (20.x, historical)

What 20.x shipped, and what this layer replaced — measured against the 20.x tree on 2026-09-22.
**Historical:** every path and line number in the right-hand column is the 20.x tree's — read it
with `git show v20.2.2:<path>`. Four of the files no longer exist at all (`identity-map.ts`,
`hooks.ts`, `local-store.ts`, `live-socket.ts`), and the rest have moved on.

| Concern | 20.x | Where |
|---|---|---|
| HTTP | four page seams, two raw `fetch` in app islands, one raw `fetch` the scaffolder writes | `packages/action/src/client.ts:100`, `packages/query/src/client.ts:129`, `packages/storage/src/upload-client.ts:63` (XHR) and `:115`, `examples/dummy/apps/web/app/settings/settings.island.tsx:116`, `examples/dummy/apps/web/site/pricing/contact-sales.island.tsx:52`, `packages/cli/src/templates/resource-form-island.ts:87` |
| shared flight control | exported, **no shipped caller constructs one** — `action` and `query` re-export `createClientFlight` and accept one injected | `packages/core/src/client-flight.ts` |
| record store | `IdentityMap`, **one per `LiveClient`** (`client.ts:105`), keyed `privateScope(query)` until a snapshot names the entity; HTTP responses never reach it | `packages/realtime/src/identity-map.ts:24`, `packages/realtime/src/client.ts:250` |
| state per page | a module singleton — `let registered` — and every island is its own `Bun.build` with `splitting: false`, so there is one singleton **per island** | `packages/realtime/src/hooks.ts:23`, `packages/cli/src/island-bundle.ts:84` |
| sockets | the framework never constructs one; the app does, once per island that mounts a client | `examples/dummy/apps/web/shared/live-socket.ts:19` |
| optimistic writes | the socket `mutate` frame answers `X_NOT_IMPLEMENTED` unless `createSyncNode({ onMutate })` is passed, and no host passes it | `packages/realtime/src/sync-frames.ts:144-155`, `packages/cli/src/dev-sync.ts` (renamed `role-sync.ts` in 22.0.0) |
| offline | `createOpfsLocalStore()` throws; the service worker posts to `/_x/outbox/flush`, which nothing mounts | `packages/realtime/src/local-store.ts:237`, `packages/pwa/src/background-sync.ts:38` |

## The one path

```
island ─ useQuery / useRecord / useChannel            useMutation / action.client
            │ reads (AsyncState)                        │ writes (HTTP only)
            ▼                                           ▼
   RecordStore (realtime, 1/tab) ◀── adopt ─── core clientTransport ── fetch
     ▲ overlay (optimistic)  ▲ restore               │ scope fence (rescope)
     │ frames (seq/epoch)    │                        ▼
   socket in a SharedWorker (1/origin/principal) ── channels + live queries, READ-ONLY
     │  ▲ MessagePort per tab, frames routed by wanted channel (in-page fallback)
   LocalStore (IndexedDB, keyed by principal) ◀─ persist + outbox (HTTP replay)
```

| Seam | Home | Tier | Status |
|---|---|---|---|
| HTTP — `clientTransport`, record envelope, page handle, scope fence | `@ultimat3/core` | 0 | shipped in 21.0.0; `action`'s and `query`'s `client.ts` both call `clientTransport` |
| record identity — brand, `recordProjection`, `rowsOf` | `@ultimat3/entity` | 2 | shipped in 21.0.0 |
| store, hooks, socket, persister, outbox | `@ultimat3/realtime` | 3 | shipped in 21.0.0: `record-store.ts`, `page-store.ts`, `page-socket.ts`, `use-record.ts`, `use-query.ts`, `use-mutation.ts`, `use-channel.ts`, `record-persister.ts`, `page-outbox.ts`, `socket-host.ts`, `sync-worker.ts` |
| realtime install | `@ultimat3/cli` (`island-bundle.ts`, `island-realtime.ts`) | 5 | shipped in 21.0.0. No general bootstrap: it cost ~7.9 kB of core's error registry on a core-free island. Only an island whose **own** graph reaches `@ultimat3/realtime` is built from an entry that calls `installRealtime({ signal: createSignal })` first, +103 B on a fixture island (the measurement is in `island-bundle.ts`'s header). A package importing realtime on an island's behalf is not seen |

**Why the seam is tier 0.** `action` and `query` (tier 3) must hand decoded records to a store
that lives in `realtime` (tier 3), and a sideways import is a build error. `RecordSink` is an
interface in core; realtime installs the implementation into the page handle; action and query
push into whatever is installed. No edge is declared for it — every import is downward.
`action → entity` and `query → entity` are new, and are ordinary 3 → 2 edges.

## The core seam

All exported by name from `@ultimat3/core`.

| Module | Exports | Owns | Status |
|---|---|---|---|
| `async-state.ts` | `AsyncState<T>` | `pending \| refreshing \| ready \| failed` — moved verbatim from `@ultimat3/ui`, no re-export left behind | shipped in 21.0.0 |
| `conflict-policy.ts` | `Row`, `ConflictPolicy`, `resolveConflict(policy, local, server, options?)` | the one conflict vocabulary, row-shaped | shipped in 21.0.0 |
| `record-envelope.ts` | `RECORDS_HEADER`, `RecordEnvelope`, `encodeRecordEnvelope`, `decodeRecordEnvelope` | the wire shape a response carries rows in | shipped in 21.0.0 |
| `record-sink.ts` | `RecordSink`, `PageClient`, `pageClient()` | the one per-tab handle, `globalThis[Symbol.for('ultimate.client')]`, non-enumerable | shipped in 21.0.0 |
| `client-scope.ts` | `ClientScope`, `rescope`, `onRescope` | the principal fence | shipped in 21.0.0 |
| `client-transport.ts` | `clientTransport` | the ONE browser HTTP function: the flight, the fence check, the envelope, the adopt | shipped in 21.0.0 |
| `client-dispatch.ts` | `TransportRequest`, `FetchLike`, `IDEMPOTENCY_HEADER` | one dispatch: the `RequestInit`, the read's abort, the network fault's code, the ok/error split | shipped in 21.0.0 |
| `page.ts` (`@ultimat3/core/page`) | the browser-light entry: the page handle, the scope fence, the page-meta constants, `UltimateError`, `clientTransport`, `actionPath` / `queryPath` | the one core import for browser code, with **no titles table** (`page-bundle.test.ts`) | shipped in 21.0.0 |
| `client-paths.ts` | `actionRoute`, `actionPath`, `ActionRoute`, `queryPath`, `QUERY_PATH_PREFIX`, `pluralize`, `splitWords` | the one URL rule: an action's export name derives `POST /api/<resource>/<verb>`, and a query's derives `GET /_x/query/<kebab>`. Moved verbatim from `action`'s and `query`'s `naming.ts`, so `action`, `query` and `realtime` (all tier 3) derive one URL with no sideways import | shipped in 21.0.0 |
| `client-problem.ts` | — (internal) | a non-2xx body back into the server's `UltimateError`; anything else into `X_CLIENT_TRANSPORT_FAILED` | shipped in 21.0.0 |

### `clientTransport` — the one browser HTTP function

| Rule | Why |
|---|---|
| `GET` is a read: abortable on `rescope`, deduped when the caller passes a `ClientFlight` | two islands asking one question are one request — but only through the flight, whose graph a plain call never pays for |
| anything else is a write: shared only under its idempotency key, never aborted by the fence | a write may already have landed; aborting it loses the answer, not the effect |
| `fetchImpl` is injected per request; absent, a wrapper calls `globalThis.fetch` at dispatch | never captured at module scope: a detached browser `fetch` throws `Illegal invocation`. A test passes `fetchImpl` and never patches a global |
| records adopted into `pageClient().store` when the response carries `x-ultimate-records: 1`, then `removed` applied — a key in both is gone. With no store installed yet, a browser page **holds** them (`pending-records.ts`, the latest row per `type:key`) and hands them over when the first realtime hook installs the store. `rescope()` clears the buffer. With no `document` (SSR, tests) they are dropped | an island that answers before another island mounts its hook must not lose the row; SSR has no store and must not throw for lacking one |
| non-2xx with a problem body naming a framework code → that `UltimateError`, `origin: 'remote'`; any other non-2xx, a network `TypeError` or a 2xx body that is not JSON → `X_CLIENT_TRANSPORT_FAILED` — from an action and a query alike | the caller gets a code with a `fix:`, never a `Response` to interpret. A proxy answering instead of the app is named as that. `X_RPC_FAILED` stays registered and nothing throws it |
| a caller specialises through hooks on the request, never a second dispatch: `decodeError(status, text)` answers a non-2xx first (the action client's `RemoteActionError`; `undefined` falls through to the shared decode), `onResponse(response)` runs before the body is read (the action client's build-id check, `X_CONTRACT_DRIFT`), and `retry` overrides the flight's policy | one function stays one function; an action's two extra questions ride on it instead of forking it |
| `ClientFlight` stays an `import type` in `action`/`query` `client.ts` | a value import pulls the whole flight graph into every island — the 36 kB problem `client-flight.ts`'s header records |

### The record envelope

`{ data, records?: { [recordType]: { [recordKey]: Row } }, removed?: { [recordType]: recordKey[] } }`
(`packages/core/src/record-envelope.ts`).

| Rule | Why |
|---|---|
| used **only** when the response header `x-ultimate-records: 1` (`RECORDS_HEADER`) is set | an output with no entity rows stays byte-identical on the wire, so `contract-diff` does not move for it |
| never declared on an `action`: the server derives it from the output schema (`rowsOf`, below) | axiom 2 — a `records:` option would be a second statement of what the schema already says |
| an action's answer: decided once per action, at projection, from its output schema (`packages/action/src/record-wire.ts`, `carriesRecords`); its OpenAPI `200` becomes `{ data, records, removed? }` (`records` required, possibly empty; core's `recordEnvelopeSchema`) plus the header | a body whose shape depended on one call's data would need two OpenAPI shapes for one operation |
| a query's answer: from `rows:` on `query()`, typed against the row `sql:` returns (`packages/query/src/query.ts`). A query whose `rows:` is branded **always** answers the envelope, even for zero rows, which is the action's rule (`record-answer.ts`) | `sql:` names its table as a string, so `rows:` is the only carrier of the schema. It carries the schema; it does not switch anything on |
| schema-free: rows are validated by the sink owner, never here | the envelope is tier 0 and cannot know an entity's schema |
| decoded onto null-prototype maps | a record type is server data, and `JSON.parse` mints `__proto__` as a real own key |
| an empty `removed` is omitted when encoding | an envelope never claims a deletion it does not carry |
| a malformed envelope is `X_CLIENT_RECORD_ENVELOPE_INVALID` | a partial adopt is worse than none |

### The scope fence

A response, frame or persisted row belonging to the previous principal must never land in the next
one's store. `rescope(principal)` bumps `epoch` only when the principal changes, and notifies
subscribers synchronously.

| Layer | On rescope | Status |
|---|---|---|
| transport — read in flight | aborted; rejects `X_CLIENT_SCOPE_CHANGED`; adopts nothing | shipped in 21.0.0 |
| transport — write in flight | finishes and resolves; its records are **not** adopted | shipped in 21.0.0 |
| store | clears every record (`page-store.ts`, `onRescope`) | shipped in 21.0.0 |
| socket | redials, so the node decides the socket's principal again at the upgrade (`page-socket.ts`) | shipped in 21.0.0; the worker host (`socket-host.ts`) names the worker by principal, so a new principal is a new worker |
| persister and outbox | wipe the previous scope's rows **and queue** on an in-page `rescope()`; queued writes are lost, deliberately. A sign-out response first sends `Clear-Site-Data: "cache", "storage"` (`@ultimat3/auth`'s `signOutHeaders()`), which empties IndexedDB, local storage and the service worker in a secure context. The page boot's wipe of every other scope (`boot.ts`, `wipeOthers`) is the second line, for a sign-out that navigates without that response. Trade-off: a second tab signed in as another principal loses its disk copy and keeps its memory | shipped in 21.0.0 (`record-persister.ts`, `page-outbox.ts`) |

Subscribers run synchronously, once per real change, in registration order, before `rescope()`
returns; a throwing subscriber does not stop the others, and the first throw is re-raised after all
have run (`packages/core/src/client-scope.ts` header). The **trigger** is not core's: the page
bootstrap and sign-in / sign-out call `rescope()`.

A superseded read is never surfaced as a UI error. `isSuperseded(error)` in
`packages/core/src/generation-fence.ts` answers `true` for `X_SUPERSEDED` **and**
`X_CLIENT_SCOPE_CHANGED` — one function, not a second export of the same name.

## Record identity from the entity

Shipped in 21.0.0 (slice 04). Exported from the `@ultimat3/entity` barrel for server code, and from
**`@ultimat3/entity/record`** (`packages/entity/src/record.ts`) for browser code: the package
declares no `sideEffects`, so the barrel retains ~1 MB of SQL rendering and `@ultimat3/db`, which
`packages/entity/src/record-bundle.test.ts` measures. The record **key travels on the wire**,
because a browser cannot compute one without importing the app's `entity()` declarations.

| Export | Answers |
|---|---|
| `ENTITY_BRAND` | `Symbol.for('ultimate.entity')`, set non-enumerably on an `entity()`'s row schema |
| `recordProjection(entity)` | `{ type, key(row), schema, persist }` — `type` is the wire name, `key` the primary key as a string, composite keys joined stably; a row missing its key is `X_RECORD_KEY_MISSING` |
| `rowsOf(schema, value)` | every value under an output schema whose schema carries the brand — through object fields, arrays, nullable and union arms. `{}` when none |
| `hasEntityRows(schema)` | statically, whether an output schema references any branded row — what decides the header |

**A `.pick()`ed, `.omit()`ed or `.extend()`ed row is not a record.** The brand does not survive a
combinator, deliberately: a partial row adopted as a record would overwrite the full one every
other view is showing. If a *wrapper* (`nullable`, `array`) strips the brand, the wrapper in
`@ultimat3/schema` is the bug — a `records:` option is not the repair.

`persist` is `entity(name, { persist: true })`, default `false`, read into the projection
(`packages/entity/src/entity.ts`, `init.persist === true`). The server lists the persisted types in a
private document's `<meta name="ultimate-persist">` (`packages/cli/src/page-sync.ts`), which
realtime's persister reads.

## The service worker's pages cache

A private document is one principal's (`packages/pwa/src/service-worker.ts`, `pagesCache`). The
server stamps `x-ultimate-scope` (`CLIENT_SCOPE_HEADER`) on every scope-tagged document
(`packages/cli/src/runtime-render.ts`). The worker never answers a private document from cache while
online, keeps it in a per-principal partition that only the offline path reads, wipes the other
partitions when it stores one, and keeps nothing for a private document with no scope. Before this,
the cache was keyed by URL alone, and one member's `/feed` answered the next on a shared browser.
That was affected since 19.0.0, and is fixed in 21.0.0.

## The record store

`packages/realtime/src/record-store.ts`, shipped in 21.0.0. One per tab, on
`globalThis[Symbol.for('ultimate.realtime')]` (`page-store.ts`), installed as core's `RecordSink` on
the first realtime hook. Records answered earlier wait in core's pending buffer.

| Property | Rule |
|---|---|
| key | `type:key`: the entity name, then the record key. `:` never occurs in an entity name, so the split is unambiguous |
| where the key comes from | **the server**, on every path. An envelope carries record type → record key → row; a live snapshot carries `keys` and a live patch `key`, each only when it differs from the row's `id`. So a composite-key entity can be live. A non-live `useQuery` lists records in `records[type]` key order; an answer with no envelope holds its own rows. A window whose node named no type keeps its rows under `?query:<name>` (`unnamedType`) |
| two layers | **synced** is server truth (HTTP envelopes, socket frames); the **overlay** is every pending optimistic write, replayed over synced truth on every change |
| a write | `useMutation` pushes the twin into the overlay, POSTs the action, adopts the answer's records, then settles the overlay. Adopt comes first, so nothing flickers. Rows the answer did not carry keep their overlay until a server row arrives, capped at 10 s (`DEFAULT_AWAIT_SERVER_MS`). A refusal drops the overlay |
| a server row that lands **during** an in-flight write | the store notes, per pending overlay, which of the rows it wrote the server has since reached (`#hear`; a row restored from disk does not count). When the HTTP answer arrives without those rows, they settle anyway instead of waiting for another frame. Only rows neither carried nor heard wait, capped at 10 s |
| the write's own echo | a `records` frame names the write that produced it (`write`, the SHA-256 digest of its idempotency key, never the key). A frame naming a write still pending on this page settles that overlay against the frame's rows **in the same notification** as the merge (`settleWrite`, `record-names.ts`), so its twin is never replayed over truth that already holds it. Without this, a like replayed from the outbox painted `3` for one like until the answer landed. A frame naming another write, or none, is truth under the overlay. Rows the echo carried stop showing the twin (`OverlayEntry.confirmed`); rows it did not keep it. The server stamps it in process from `withWriteOrigin` (opened by `@ultimat3/action`'s HTTP projection from the `idempotency-key` header), and through the WAL from the `pg_logical_emit_message` the Postgres driver opens a keyed write's transaction with (`packages/entity/src/write-tag.ts`) |
| the join race | a page renders, then joins a channel; a write in between reaches no one. So the first join with no cursor on a channel that carries records gets one `replay-gap`, and the client's catch-up read covers the window. A resubscribe with `since` replays from the ring instead |
| a rejected row | not an object, or no key: dropped and reported as `X_RECORD_REJECTED`, never partially merged |
| lifetime | reference-counted per record; the last release evicts it |
| a new principal | `rescope()` clears every record |

**`@ultimat3/query/client` is a second import path, deliberately.** It is the browser entry of
`queryClient`, like `@ultimat3/entity/record`: 16,458 B against 23,611 B through the barrel
(`bun build --target=browser --minify`, per `packages/query/CLAUDE.md`). The barrel's extra cost
is its anchored registry, which a browser never needs. `browser-transport` refuses the barrel in
browser code (`X_BROWSER_SERVER_BARREL`), so the second path is enforced, not optional.

**Two `globalThis` handles, not one.** Core's `Symbol.for('ultimate.client')` (transport, sink,
scope) and realtime's `Symbol.for('ultimate.realtime')` (store, sync target, socket, write counts).
The first carries the sink slot the second fills. `record-sink.ts`'s header calls `pageClient()`
the only `globalThis` write "in the client seam", which is true of core and not of the page (DX
ledger #6).

## Rules

| Rule | Why |
|---|---|
| one record per `recordType:recordKey`, always — never a per-query scope | two components holding two copies of one row is the bug the store exists to make unrepresentable |
| lists hold ids; the store holds rows — for live **and** non-live queries | an update to a record re-renders every list containing it, with no refetch |
| optimistic writes live in an **overlay**, never in the synced layer | rolling back an overlay cannot delete a row the server has since sent |
| one frame, one write | a frame applied twice is a duplicate; a frame applied never is a gap |
| a patch that omits a field never clears it | two queries project different columns; a narrower answer must not blank a wider view |
| channels are the only realtime subscription; a topic is never a string | a literal topic is a typo the typecheck cannot see |
| persisted rows are keyed by principal scope | one principal's cache never restores into another's |
| the socket is read-only; every write is HTTP | HTTP already has authz, the input schema, the idempotency store and the contract tests |

## Decisions

Decided 2026-09-22 and not reopened. Status per row.

| Decision | Status |
|---|---|
| ships as major 21.0.0, with no compatibility shim for any removed surface — a deprecated second path is what axiom 1 forbids | shipped in 21.0.0: each removal is a `BREAKING —` entry under `CHANGELOG.md`'s `[Unreleased]` |
| writes over HTTP only; the socket `mutate` / `rebase` path is deleted, not wired, and `ack` only answers a refusal | shipped in 21.0.0 (sync protocol 3) |
| the envelope is derived from the entity brand; no `records:` option | shipped in 21.0.0 (a query names its row schema with `rows:`) |
| `useQuery` is the one read hook; live-ness belongs to the query declaration; `useLive` and `liveHookFor` are deleted | shipped in 21.0.0. **But live-ness is restated on the browser-side ref** (`{ name, live, entity }`), not derived from the declaration (see Open items) |
| channels carry `seq` + `epoch`; the **server** owns the gap verdict (`replay-gap`); a numeric hole is not a gap; the catch-up read is named on the channel declaration | shipped in 21.0.0: server `channel-gaps.ts`, client `client-channels.ts` (a cursor per channel, a `catchUp` re-read on `replay-gap` or a new epoch). `channel_replay_gaps_total` counts announcements. Not measured at scale |
| one socket per origin, in a `SharedWorker` named by principal; an in-page `MessageChannel` host is the transparent fallback, running the same engine; the store stays per tab | shipped in 21.0.0: `socket-engine.ts` (per-port reference counts, frames routed only to ports that want the channel, a port reaped after `REAP_AFTER_BEATS = 3` silent beats), `socket-host.ts` (worker named by principal, in-page fallback, `bye` on `pagehide`), `sync-worker.ts`. Exercised by `examples/dummy/apps/web/e2e/two-tabs.e2e.test.ts` (two tabs, one socket; closing one costs the other zero reconnects; the in-page fallback with `SharedWorker` deleted), run by the reference app's `e2e` step |
| the scope fence is in core: reads abort, writes finish but never adopt into the new scope | shipped in 21.0.0 |
| one conflict vocabulary, row-shaped, in core; `@ultimat3/action`'s output-shaped `custom()` is gone | shipped in 21.0.0 — realtime's `ConflictLike`, `custom`, `CustomMerge`, `MergeArgs` and `ConflictStrategy` are gone; its rebase calls core's `resolveConflict`, and never calls a merge for a server delete or a row the client never held |
| `AsyncState` lives in core; `@ultimat3/ui` takes hook accessors directly, with no adapter | shipped in 21.0.0: `@ultimat3/ui` imports it from core (`AsyncRegion.tsx`, `DataTable.tsx`, `async-branch.ts`), and a hook's answer is passed as `state={feed()}` with no adapter |
| offline is IndexedDB, `persist` per entity (default `false`), one outbox replayed over HTTP with idempotency keys; OPFS and `/_x/outbox/flush` are deleted | shipped in 21.0.0: `local-store-idb.ts`, `record-persister.ts` (restored before the socket connects, provisional until the first server row), `page-outbox.ts` (a write with no response at all, `meta.failure: 'network'`, is queued and `useMutation` resolves `undefined`; replay on socket up, `online` and the SW drain message). The outbox opens with the page's realtime state, right after the restore |
| XHR stays only in `storage/upload-client.ts`, for progress events, as a declared seam; service-worker `fetch` is exempt by path | shipped in 21.0.0: the seams and the exemption are `scripts/browser-transport.ts`'s |

**Why a `SharedWorker` and not a leader tab.** A Web Locks leader was considered and dropped: when
the leader tab closes, every other tab reconnects. A worker lives as long as any tab of the origin
does, so closing a tab costs zero reconnects — the property the e2e asserts.

## Where the page's socket dials

The framework decides this; no app owns a `sync-url.ts`, `As of 2026-09-22`.

| Fact | Where |
|---|---|
| default target `/_x/sync`, on the page's own origin. `x dev`, a combined-role container and the Helm ingress all serve it there | `packages/cli/src/sync-url.ts` (`SYNC_PATH`, `syncUrlFrom`) |
| `SYNC_URL` overrides the target, and must be `ws:`/`wss:` or boot fails with `X_CONFIG_INVALID`. It is never derived from a port: behind any ingress, a neighbouring port is a URL nothing publishes | `packages/cli/src/sync-url.ts` |
| the Compose rung needs `SYNC_URL`, because `sync` is published on its own port with no proxy | [`docs/ops/README.md`](../ops/README.md), rung 2 |
| every document carries `<meta name="ultimate-sync">` and `<meta name="x-ultimate-build">`, plus `<meta name="ultimate-sync-worker">` when the app has realtime (and so has a worker). All principal-free, so a shareable document may carry them | `packages/render/src/client-sync-tags.ts`; the names are declared once, in `packages/core/src/page-meta.ts` |
| the worker is built once at boot, from its source graph, and served `immutable` at `/_x/sync-worker/<hash>.js`, so a deploy gets a new URL and an open tab keeps the worker it started with | `packages/cli/src/worker-bundle.ts` |
| `x dev` and `serve.ts` compose all of it through one call, so the two cannot serve different targets | `packages/cli/src/page-sync.ts` |

## What each hook costs

Island chunk bytes per hook are recorded in **one** place:
[`packages/realtime/CLAUDE.md`](../../packages/realtime/CLAUDE.md), "Browser bytes, per hook", three
columns from before the page boot moved out to after the light core entry. `queryClient` from
`@ultimat3/query/client` is in [`packages/query/CLAUDE.md`](../../packages/query/CLAUDE.md). No test
pins any of these; re-measure before quoting.

**What a browser bundle gives up:** it imports `@ultimat3/core/page`, which carries no titles
table, so an error thrown in it and rendered there shows the code's **name** as its title. The
registered title is in `core-error-codes.ts`, anchored by the barrel, and reaches any process that
imports the barrel (every server). That is the trade for about 6 kB per island.

**The page boot** (`/_x/page-boot/<hash>.js`) is one deferred classic script, rendered only on a
document that carries a scope tag **and** emitted an island reaching `@ultimat3/realtime`
(`packages/cli/src/runtime-render.ts`). The worker and the boot are resolved from the app root, then
from each `apps/*` workspace (`worker-bundle.ts`). Until 2026-09-22 only the root was read, so a
workspace app, the reference app included, got neither a worker nor a boot. It restores the principal's
persisted records and opens the outbox once per page, so that work is not repeated in every island
chunk. `X_BUILD_FAILED` names `page boot` or `sync worker` when one of them fails to bundle.

## `splitting: false` stays

Every island is still its own `Bun.build` with `splitting: false`
(`packages/cli/src/island-bundle.ts:84`), because the budget compares one chunk's bytes and a shared
chunk would make that number a graph walk. The page handle on `globalThis` makes **state** single
even though **code** is duplicated per island. A shared runtime chunk is the next lever for bytes,
with its own budget semantics — named here, not in 21.0.0.

## Enforcement

| Rule | Enforced by | Status |
|---|---|---|
| a browser `fetch(` call, `new WebSocket(`, `new XMLHttpRequest(`, `new EventSource(` outside its one seam file | `scripts/browser-transport.ts` (`scripts/browser-transport.test.ts`, on the gate's `unit` step): `X_BROWSER_TRANSPORT_BYPASS`, with `X_BROWSER_TRANSPORT_UNSCANNED` when the seam moved | enforced, pinned at **zero**. Standalone: `bun run browser-transport` |
| a channel spelled as a string literal or a concatenation | `scripts/channel-literals.ts` (`scripts/channel-literals.test.ts`, on the gate's `unit` step): `X_CHANNEL_LITERAL`, with `X_CHANNEL_LITERAL_UNSCANNED` when the seam moved | enforced, pinned at **zero**. Standalone: `bun run channel-literals` |
| two island bundles resolve one page handle | `packages/core/src/record-sink.test.ts` | in tree |
| `AsyncState`'s status union has one declaration | `packages/core/src/async-state.test.ts` (a second union with two or more of its `status` arms in any `packages/*/src` file), and `scripts/render-modes.ts` (a union sharing three statuses with it, read off `async-state.ts`) | enforced |

## Open items

| Item | Owner | Decided |
|---|---|---|
| sign-out by full navigation left the previous scope on disk | realtime | closed 2026-09-22: the boot wipes every other scope (`boot.ts`) |
| `X_REALTIME_UNINSTALLED` / `X_SYNC_UNCONFIGURED` fix lines ("`x build`") were false while no build step installed realtime. `island-realtime.ts` made them true for an island whose own graph imports realtime | cli | closed 2026-09-22 |
| a `QueryRef` states `live` and `entity` by hand, beside the name; nothing checks them against the query declaration | cli (`x build` emits typed refs), DX ledger | open |
| `examples/dummy`'s `setTheme` is declared `last-write-wins`, and `MemberView` has no `updatedAt`, so core's resolver keeps the server row every time. It becomes `server-wins`, because the server row already carries the write | slice 16 | 2026-09-22 |
