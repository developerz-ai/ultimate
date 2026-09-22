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
edit in `wiki/Upgrading.md`'s 21.0.0 section (slice 10); no codemod, per the house rule. Slices
may merge to `main` one at a time — the major is cut only after slice 10, with
`bun run scripts/release.ts --bump` (see `docs/architecture/19-cutting-a-major.md`). No
compatibility shim for the removed surfaces: a deprecated second path is exactly what axiom 1
forbids, and the major is what makes deleting them legal.

| Removed in 21.0.0 | Replaced by |
|---|---|
| `setLiveClient()` / `connect()` in island code | page client installed by the island bootstrap (slice 07) |
| `ClientSocket` injection, app-owned `new WebSocket` | `realtime/src/browser-socket.ts` (slice 04) |
| `IdentityMap`, `privateScope(query)` keys | `RecordStore`, `entity:id` keys (slice 04) |
| `subscribe(topic: string)`, client `publish(topic)` | `channel()` + `useChannel()`; writes via mutators (slice 05) |
| OPFS `LocalStore` (threw `NotImplemented`) | `IndexedDbLocalStore` (slice 06) |
| `/_x/outbox/flush` background-sync route | realtime's one outbox (slice 06) |
| raw `fetch` default in `rpc()` / `queryClient()` | `clientTransport` in core (slices 01, 03) |

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
island ─ useRecord / useLive / useChannel / useMutation / action.client / query.client
            │ reads                             │ writes / fetches
            ▼                                   ▼
   RecordStore (realtime, 1/page)  ◀── adopt ── core clientTransport (1/page) ── fetch
      ▲         ▲                                        ▲
      │ frames  │ restore                    ticket/http │
   SyncSocket (realtime, 1/page) ── channels + live queries + mutate frames
      │
   LocalStore (IndexedDB) ◀─ persist / outbox replay
```

- **Seam in core (tier 0):** `clientTransport` + a `RecordSink` interface + the record envelope
  decoder. action/query (tier 3) push decoded records into the sink without importing realtime —
  no sideways edge.
- **Store in realtime (tier 3):** `IdentityMap` promoted to `RecordStore`, keyed `entity:id`,
  installed as the sink. One per page via a `Symbol.for('ultimate.client')` handle on `globalThis`,
  because islands are separate bundles — a module singleton is one per island (the bug today).
- **Default, not opt-in:** `island-bundle.ts` prepends a bootstrap that installs the page client;
  an island never calls `connect()` / `setLiveClient()`. The socket opens lazily on the first
  live/channel hook, so a form-only island pays no socket bytes.

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `core` | 0 | `clientTransport`, `RecordSink`, record envelope, page-client handle; new error codes |
| `entity` | 2 | expose `recordKey(entity, row)` + wire name for the envelope (no new edge) |
| `action`, `query` | 3 | clients route through `clientTransport`; server responses carry the record envelope |
| `realtime` | 3 | `RecordStore`, one socket per page, typed `channel()`, `useRecord`, IndexedDB `LocalStore` |
| `storage` | 1 | upload client's `fetch` fallback goes through `clientTransport` (XHR kept only for progress, as a declared seam) |
| `pwa` | 4 | background sync replays the mutator queue; delete or mount `/_x/outbox/flush` |
| `cli` | 5 | wire `onMutate` in dev + `serve.ts`; island bootstrap; scaffold template; guard wiring |
| `scripts/` | — | `browser-transport` guard + `channel-literals` guard |

Land lowest tier first. No new declared edge: every import above is downward
(`realtime → entity`, `realtime → core`, `action/query → core`, `cli → realtime`).

## Plan files (execute in order)
1. [`01-core-transport.md`](01-core-transport.md) — tier 0: `clientTransport`, `RecordSink`, envelope, page handle.
2. [`02-entity-record-key.md`](02-entity-record-key.md) — tier 2: record identity from the entity declaration.
3. [`03-action-query-clients.md`](03-action-query-clients.md) — tier 3: both typed clients on the one transport; responses adopt into the sink.
4. [`04-realtime-store-socket.md`](04-realtime-store-socket.md) — tier 3: `RecordStore`, one socket per page, `useRecord`.
5. [`05-realtime-channels.md`](05-realtime-channels.md) — tier 3: typed `channel()`, frames adopt into the store, name builder.
6. [`06-offline.md`](06-offline.md) — tiers 3–4: IndexedDB `LocalStore`, persist per entity, outbox = mutator queue.
7. [`07-cli-default-and-mutate.md`](07-cli-default-and-mutate.md) — tier 5: island bootstrap, `onMutate` wiring, scaffold template.
8. [`08-guards.md`](08-guards.md) — scripts: `browser-transport`, `channel-literals`, gate wiring, error codes.
9. [`09-apps.md`](09-apps.md) — migrate `examples/dummy` islands; fix the inert publish button.
10. [`10-docs.md`](10-docs.md) — architecture page, wiki, idea docs, CHANGELOG/Upgrading.

## Done when
- One record displayed in two islands on one page updates in both from ONE socket frame (e2e test, `examples/dummy`, `*.e2e.test.ts`).
- One socket per page regardless of island count (e2e counts upgrades on `/_x/sync`).
- An action response containing an entity row updates every `useRecord` of that row without a refetch (unit, realtime).
- A mutator applied offline shows immediately, survives a reload (IndexedDB), and reconciles on reconnect (e2e).
- `rg 'fetch\(|new WebSocket|XMLHttpRequest|new EventSource'` in browser-reachable source finds only the declared seam files; `bun run browser-transport` green at zero pins.
- `useMutation` no longer answers `X_NOT_IMPLEMENTED` in dev or under `serve.ts`.
- Island budgets in `examples/dummy` unchanged or lower (`island-bytes.test.ts`).
- `bun run manifest` regenerated; `bun run scripts/reference-app-gate.ts` holds its ratchet; `bun run verify` green, all 20 steps.

## Major-window candidates (not yet sliced)
Breaking changes that belong in the same 21.0.0 because they touch the same surfaces; each becomes a slice only once chosen. Ordered by value.

| # | Candidate | Evidence | Why now |
|---|---|---|---|
| A | **Per-channel sequence + gap repair.** Every record frame carries `seq`; the client keeps one cursor per channel, drops duplicates, detects epoch restart; a server `replay-gap` frame triggers a catch-up read for that channel only (server owns the gap verdict) | root `CLAUDE.md` realtime section: a channel topic "has no cursor and no re-snapshot", a dropped frame is "unrepairable, not uncounted" | once channels write the store, a lost frame is a stale record shown in N places |
| B | **One socket per origin across tabs.** Leader tab (Web Locks) owns the socket, relays frames over `BroadcastChannel`; followers declare wanted channels; no Web Locks → every tab leads | today: one socket per island per tab | N tabs × M islands sockets against `AcceptBudget` |
| C | **One conflict vocabulary.** action's `custom()` merges outputs, realtime's merges rows; `hooks.ts:269-277` silently drops the action spelling | `packages/realtime/src/hooks.ts:269-277` | silent drop is the "answered the wrong thing" half of every major |
| D | **Scope fence on principal change.** Sign-out / account switch aborts in-flight GETs (`ScopeChangedError`-style supersession via `client-flight`), wipes that scope's records + outbox, drops channel subscriptions | none exists; slice 06 covers only the wipe | a response from the old principal adopted into the new principal's store is a data leak |
| E | **Delete `liveHookFor`** or make it island-safe | value import cost 698,801 B (`examples/dummy/apps/web/app/feed/live.ts:4-8`) | a public API no island can use is a second path to `useLive` |
| F | **`@ultimat3/ui` reads the store via `AsyncState`** — an adapter in realtime (`useRecord` → `AsyncState`) so ui (tier 4, cannot import realtime) renders store data with no app glue | `packages/ui/src/components/async-branch.ts:13` | otherwise every app hand-writes the same adapter |
| G | **One write transport decision.** Writes go over HTTP (`action.client`) AND socket `mutate` frames; pick: mutators over the socket, plain actions over HTTP, both adopting into the store — and write it as a rule | `client-mutations.ts:94` vs `action/src/client.ts:100` | two write paths is axiom 1; the major is when the losing one can be deleted |
| H | **Lists hold ids, never rows** extended to non-live `query.client()` results (slice 03 adopts; this makes the returned list an id window backed by the store) | `live-rows.ts:31` already does it for live queries | otherwise a paginated list is a second copy that goes stale |

## Risks / open questions
- **Ask vs tree.** "Ultimate should have one store" — `docs/idea/00-thesis.md:39` already claims an identity-mapped client store "Shipped As of 2026-08". False in practice: it is per-`LiveClient`, per-island (`island-bundle.ts:84`), keyed per query until a snapshot names the entity (`identity-map.ts:24`), and HTTP responses never reach it. Slice 10 corrects the claim.
- **Ask vs tree.** `wiki/Realtime.md` says "One `setLiveClient` per app"; per-island bundles make it one per island (`realtime/src/hooks.ts:23` is a module singleton).
- **Breaking — decided: 21.0.0** (see *Release*). Risk is a slice merging a removal without its `BREAKING —` entry; `bun run changelog-check` counts entries per major against `wiki/Upgrading.md`, so each slice that removes a surface writes its entry in the same PR.
- **Bundle bytes.** `rpc` is 14.8 kB, `queryClient` 12.8 kB, value-importing `LiveClient` took a chunk 8.4→26.6 kB. The transport must stay value-free in `useRecord`-only chunks; the socket module loads via `import()` on first live/channel use. If the per-island duplicated runtime blows a budget, the fallback is ONE shared runtime chunk emitted by `island-bundle.ts` (turning `splitting` on) — decide by measurement in slice 07, not by argument.
- **Envelope derivation.** Which action/query outputs carry records: derive from the output schema referencing an entity row schema (preferred, zero app code) vs an explicit `records:` option on `action()`. The first is axiom 2; if schema identity is not traceable through `t`, stop and decide before slice 03.
- **Upload progress.** XHR stays the one way to get upload progress in browsers; it is declared a second seam file inside `storage`, not exempted by pin.
- **Service worker** `fetch` is a different realm (no page store); it stays exempt by path (`packages/pwa/src/service-worker.ts`, `strategies.ts`) and is named in the guard's seam list, not pinned.
- `dummy/social-media-clone` has zero islands (`hydrate: 'never'`); nothing to migrate there — its `expectedRed` table must not move.
