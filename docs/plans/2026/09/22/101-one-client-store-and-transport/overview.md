# One client store, one transport, one socket

## Goal
By default, every Ultimate page has ONE identity-mapped record store (Ember Data's shape: one
record per `entity + id`, shown in N places, updated once), ONE HTTP seam every browser request
passes through, and ONE WebSocket per page carrying every channel and live query. Realtime frames,
action/query responses and optimistic mutators all write the same record; offline restores and
replays it. Enforced by the gate, not documented.

## Release
**Ships as the next major — 21.0.0** (tree at 20.2.1, `As of 2026-09-22`; re-read with
`bun run scripts/list-workspaces.ts --json`, never quote this line). Decided 2026-09-22. Every
removal below lands as a `BREAKING —` entry under `[Unreleased]` in `CHANGELOG.md` and a manual
edit in `wiki/Upgrading.md`'s 21.0.0 section (slice 17); no codemod, per the house rule. Slices
may merge to `main` one at a time — the major is cut only after slice 17, with
`bun run scripts/release.ts --bump` (see `docs/architecture/19-cutting-a-major.md`). No
compatibility shim for the removed surfaces: a deprecated second path is exactly what axiom 1
forbids, and the major is what makes deleting them legal.

| Removed in 21.0.0 | Replaced by |
|---|---|
| `setLiveClient()` / `connect()` in island code | page client installed by the island bootstrap (slice 14) |
| `ClientSocket` injection, app-owned `new WebSocket` | `realtime/src/browser-socket.ts` (slice 06) |
| `IdentityMap`, `privateScope(query)` keys | `RecordStore`, `entity:id` keys (slice 06) |
| `subscribe(topic: string)`, client `publish(topic)` | `channel()` + `useChannel()`; writes via `useMutation` (slice 09) |
| OPFS `LocalStore` (threw `NotImplemented`) | `IndexedDbLocalStore` (slice 12) |
| `/_x/outbox/flush` background-sync route | realtime's one outbox (slice 12) |
| raw `fetch` default in `rpc()` / `queryClient()` | `clientTransport` in core (slices 01, 05) |
| `useLive`, `liveHookFor` | `useQuery` (slice 07) |
| socket `mutate`/`ack`/`rebase` frames, `createSyncNode({ onMutate })` | `useMutation` over HTTP (slice 08) |
| `custom(merge)` over outputs; `ConflictLike` | `ConflictPolicy` over rows, in core (slice 02) |
| `AsyncState` from `@ultimat3/ui` | `AsyncState` from `@ultimat3/core` (slice 02) |

## Context
- Bun-only, SolidJS 1.9.x islands, Postgres, no ORM. Browser code = islands (`*.island.tsx`),
  each built by its own `Bun.build` with `splitting: false` (`packages/cli/src/island-bundle.ts:71,84`).
- **Not a ninth primitive.** The store is the client **projection of `entity`** (axiom 2): a record
  type, its key, and its schema all come from the `entity()` declaration. Writes stay `action` /
  `mutator`; reads stay `query` (live or not); channels stay realtime's tier-1 mechanism
  (`docs/idea/03-realtime.md:9-15`).
- Today, `As of 2026-09` — the fragmentation this plan removes:

| Concern | Today | Where |
|---|---|---|
| HTTP | 4 page seams + SW + 2 raw app `fetch` + 1 raw `fetch` the scaffolder writes | `action/src/client.ts:100`, `query/src/client.ts:129`, `storage/src/upload-client.ts:63,115`, `examples/dummy/apps/web/app/settings/settings.island.tsx:116`, `examples/dummy/apps/web/site/pricing/contact-sales.island.tsx:52`, `packages/cli/src/templates/resource-form-island.ts:87` |
| Shared flight control | exists, **zero callers** | `packages/core/src/client-flight.ts` (291 LOC) |
| Record store | `IdentityMap`, but keyed `privateScope(query)` until a snapshot names the entity; one per `LiveClient` | `packages/realtime/src/identity-map.ts:24,35` |
| Sockets | one per island that mounts a client; the framework never constructs one — the app does | `examples/dummy/apps/web/shared/live-socket.ts:19`, `feed.island.tsx:88-95`, `like.island.tsx:172-182` |
| Channel API | raw string topics, `subscribe(topic, handler)`; frames never reach the store | `packages/realtime/src/client.ts:277,291`, `client-topics.ts:27` |
| Optimistic writes | always roll back: no host wires `onMutate` | `packages/cli/src/dev-sync.ts:190-205`, `packages/realtime/src/sync-frames.ts:143-160` |
| Offline | OPFS `LocalStore` throws `NotImplemented`; SW posts to unmounted `/_x/outbox/flush` | `realtime/src/local-store.ts:236`, `pwa/src/background-sync.ts:38,77` |
| App data paths | 7 distinct ways (SSR service call, SSR rpc, form POST, raw fetch, `useLive`, `useMutation`+queue, hand-mirrored `identity.subscribe`→`createSignal`) | `like.island.tsx:110-116` is the mirror |

- Reference patterns:
  - one-seam guard: `scripts/async-context-guard.ts` (seam constant, scans `APP_ROOTS`, zero pin).
  - call-vs-injected-default rule: `scripts/flight-copies.ts` (a `Math.random()` **call** is reported, a `random = Math.random` default is not — same split as `fetch(` vs `options.fetch`).
  - bundle proof: `examples/dummy/apps/web/island-bytes.test.ts`, `scripts/browser-barrel.test.ts`.

## Design (the one path)

```
island ─ useQuery / useRecord / useChannel            useMutation / action.client
            │ reads (AsyncState)                        │ writes (HTTP only)
            ▼                                           ▼
   RecordStore (realtime, 1/tab) ◀── adopt ─── core clientTransport ── fetch
     ▲ overlay (optimistic)  ▲ restore               │ scope fence (rescope)
     │ frames (seq/epoch)    │                        ▼
   socket (leader tab only, 1/origin) ── channels + live queries, READ-ONLY
     │  ▲ BroadcastChannel relay to follower tabs
   LocalStore (IndexedDB, keyed by principal) ◀─ persist + outbox (HTTP replay)
```

- **Seam in core (tier 0):** `clientTransport`, `RecordSink`, record envelope, page handle,
  `ClientScope` fence, `AsyncState`, `ConflictPolicy`. action/query (tier 3) push decoded records
  into the sink without importing realtime — no sideways edge.
- **Store in realtime (tier 3):** `IdentityMap` → `RecordStore`, keyed `entity:id`, installed as the
  sink. One per tab via `Symbol.for('ultimate.client')` on `globalThis`, because islands are separate
  bundles and a module singleton is one per island (the bug today).
- **Default, not opt-in:** `island-bundle.ts` prepends a bootstrap that installs the page client; an
  island never calls `connect()` / `setLiveClient()`. The socket module loads on the first
  live/channel hook, so a form-only island pays no socket bytes.

## Decisions (2026-09-22)
All made; an executor does not reopen them.

| # | Decision | Slice |
|---|---|---|
| 1 | Ships as major **21.0.0**; no compatibility shims | all |
| 2 | Writes go over **HTTP only**; the socket is read-only. The broken socket `mutate` path is deleted, not wired | 08 |
| 3 | Record envelope **derived** from a `Symbol.for('ultimate.entity')` brand on the entity row schema; no `records:` option; a `.pick()`ed partial row is not a record | 04, 05 |
| 4 | **One read hook** `useQuery`; live-ness belongs to the query declaration. `useLive` and `liveHookFor` deleted | 07 |
| 5 | Lists hold ids; rows come from the store, for live AND non-live queries | 06, 07 |
| 6 | Channels carry `seq` + `epoch`; server owns the gap verdict (`replay-gap`); catch-up read named on the channel declaration | 09, 10 |
| 7 | One socket per origin via Web Locks leader + `BroadcastChannel`; store stays per tab | 11 |
| 8 | Principal scope fence in core: reads abort, writes finish but never adopt into the new scope | 03 |
| 9 | One conflict vocabulary, row-shaped, in core; action's output-shaped `custom()` is gone | 02 |
| 10 | `AsyncState` moves to core; ui takes hook accessors directly, no adapter | 02, 13 |
| 11 | Offline: IndexedDB, `persist` per entity (default `false`), one outbox replayed over HTTP with idempotency keys; OPFS and `/_x/outbox/flush` deleted | 12 |
| 12 | `splitting: false` kept; state is single via the page handle; a shared runtime chunk is the next lever, not this major | 14 |
| 13 | XHR kept only in `storage/upload-client.ts` for progress, as a declared seam; SW `fetch` exempt by path | 15 |

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `core` | 0 | transport, sink, envelope, page handle, scope fence, `AsyncState`, `ConflictPolicy`; new codes |
| `storage` | 1 | upload `fetch` fallback → `clientTransport`; XHR declared seam |
| `entity` | 2 | row-schema brand, `recordProjection`, `rowsOf`, `persist` |
| `action`, `query` | 3 | clients on `clientTransport`; derived envelope; row-shaped `custom()` |
| `realtime` | 3 | `RecordStore`, `useQuery`/`useRecord`/`useMutation`/`useChannel`, channels + seq, cross-tab, IndexedDB, socket write path deleted |
| `ui`, `pwa` | 4 | `AsyncState` from core; background sync → realtime outbox |
| `cli` | 5 | island bootstrap, scaffold template, `LIVE_HOOKS`, host cleanup |
| `scripts/` | — | `browser-transport`, `channel-literals` guards |

Land lowest tier first. No new declared edge: every import is downward.

## Plan files (execute in order)
1. [`01-core-transport.md`](01-core-transport.md) — tier 0: `clientTransport`, `RecordSink`, envelope, page handle.
2. [`02-core-shared-types.md`](02-core-shared-types.md) — tier 0: `AsyncState` + `ConflictPolicy` move to core.
3. [`03-core-scope-fence.md`](03-core-scope-fence.md) — tier 0: principal change fences reads, writes, store, socket, disk.
4. [`04-entity-record-key.md`](04-entity-record-key.md) — tier 2: record identity + schema brand + `rowsOf`.
5. [`05-action-query-clients.md`](05-action-query-clients.md) — tier 3: typed clients on the one transport; derived envelope.
6. [`06-realtime-store-socket.md`](06-realtime-store-socket.md) — tier 3: `RecordStore`, one socket, `useRecord`.
7. [`07-realtime-use-query.md`](07-realtime-use-query.md) — tier 3: `useQuery`; delete `useLive`, `liveHookFor`.
8. [`08-realtime-writes-over-http.md`](08-realtime-writes-over-http.md) — tier 3: `useMutation` over HTTP; socket writes deleted.
9. [`09-realtime-channels.md`](09-realtime-channels.md) — tier 3: typed `channel()`, `records` frames, derived publish.
10. [`10-realtime-channel-seq.md`](10-realtime-channel-seq.md) — tier 3: `seq`/`epoch`, `replay-gap`, catch-up.
11. [`11-realtime-cross-tab.md`](11-realtime-cross-tab.md) — tier 3: one socket per origin.
12. [`12-offline.md`](12-offline.md) — tiers 3–4: IndexedDB, persist, one outbox.
13. [`13-ui-async-state.md`](13-ui-async-state.md) — tier 4: ui takes hook state directly.
14. [`14-cli-default.md`](14-cli-default.md) — tier 5: island bootstrap, scaffold, `LIVE_HOOKS`.
15. [`15-guards.md`](15-guards.md) — scripts: `browser-transport`, `channel-literals`, gate wiring.
16. [`16-apps.md`](16-apps.md) — migrate `examples/dummy`; e2e for every *Done when* below.
17. [`17-docs.md`](17-docs.md) — architecture page, wiki, idea docs, CHANGELOG/Upgrading.

Parallelisable after 06: {07, 08}, {09 → 10 → 11}, {12} touch disjoint files except `hooks.ts` (07, 08 — sequence them).

## Done when
- One record displayed in two islands updates in both from ONE socket frame.
- Two tabs, one `/_x/sync` upgrade; a write in one tab shows in the other.
- An action response containing an entity row updates every `useRecord`/`useQuery` showing it, no refetch.
- A deliberately dropped channel frame is repaired: store ends equal to server rows.
- Sign-out leaves no record of the previous principal in memory or IndexedDB.
- A mutator applied offline shows immediately, survives reload, replays once on reconnect.
- `useMutation` persists in dev and under `serve.ts` (today: `X_NOT_IMPLEMENTED`).
- `bun run browser-transport && bun run channel-literals` green at zero pins.
- Island budgets in `examples/dummy` unchanged or lower (`island-bytes.test.ts`).
- `bun run manifest`; `bun run scripts/reference-app-gate.ts` holds its ratchet; `bun run changelog-check`; `bun run verify` green, all 20 steps. Then `bun run scripts/release.ts --bump` to 21.0.0.

## Risks / open questions
- **Ask vs tree.** "Ultimate should have one store" — `docs/idea/00-thesis.md:39` already claims an identity-mapped client store "Shipped As of 2026-08". False in practice: it is per-`LiveClient`, per-island (`island-bundle.ts:84`), keyed per query until a snapshot names the entity (`identity-map.ts:24`), and HTTP responses never reach it. Slice 17 corrects the claim.
- **Ask vs tree.** `wiki/Realtime.md` says "One `setLiveClient` per app"; per-island bundles make it one per island (`realtime/src/hooks.ts:23` is a module singleton).
- **Breaking — decided: 21.0.0** (see *Release*). Risk is a slice merging a removal without its `BREAKING —` entry; `bun run changelog-check` counts entries per major against `wiki/Upgrading.md`, so each slice that removes a surface writes its entry in the same PR.
- **Bundle bytes.** `rpc` 14.8 kB, `queryClient` 12.8 kB; value-importing `LiveClient` took a chunk 8.4→26.6 kB. The transport stays value-light; the socket module loads via `import()`. If an island budget still breaks, shrink the runtime — never raise the budget, never reintroduce raw `fetch`.
- **Schema brand survival.** Decision 3 depends on the brand surviving `t` wrappers (nullable, array). Slice 04 tests it; if a wrapper strips it, fix the wrapper in `@ultimat3/schema` — do not add a `records:` option.
- **Protocol bump.** Slices 08 and 09 both change the sync protocol; bump the version ONCE (whichever lands first) and make the other reuse it.
- `dummy/social-media-clone` has zero islands (`hydrate: 'never'`); nothing to migrate there — its `expectedRed` table must not move.
