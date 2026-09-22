# Realtime

Three tiers, one ladder. Same mutator shape at every rung — climbing is a config change, never a rewrite.

`As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)). Tiers 1–2 ship. Tier 3 (local-first) has **not shipped**, `As of 2026-08`.

## Two entries: `.` is the browser's, `./server` is the node's

`@ultimat3/realtime` ships **two** entry points, and which one a name lives in is a mechanical fact
rather than a convention — the barrels are disjoint, and a test asserts it.

| Entry | Holds | Reaches |
|---|---|---|
| `@ultimat3/realtime` | `useQuery`, `useRecord`, `useMutation`, `useConnection`, `installRealtime`, `hasPageSocket`, `RecordStore`, `channel()` and `topic()`, the offline queue, the wire protocol, cursors | an island, a browser bundle |
| `@ultimat3/realtime/server` | `createSyncNode`, `ChannelHub`, `SocketRegistry`, `LiveQueryRegistry`, `NatsTransport`, `openNatsClient`, the replicator, the change feed, pg replication | a `sync` node, a worker, `server.ts` |

```ts
import { useQuery } from '@ultimat3/realtime';             // island
import { createSyncNode } from '@ultimat3/realtime/server'; // sync node
```

A server render is not a missing install. With no DOM, every read hook answers `pending` with no subscription, and `useMutation()` refuses with `X_LIVE_SERVER_RENDER`. `hasPageSocket()` answers `false` there, every time, so it is **not** a guard that makes a page-body read safe: a browser-only read in code no island imports is `X_LIVE_ROUTE_NO_ISLAND` at the `budgets` step, `hasPageSocket()` included. In a **browser**, a hook in a bundle that never called `installRealtime()` is `X_REALTIME_UNINSTALLED`.

A file that needs both writes both imports. **Nothing was deleted in the split** — if an import
stops resolving after upgrading to 8.0.0, the name moved to `./server`.

Why it is two entries and not one: a single barrel carried `useLive` beside `openNatsClient`, so
`bun build --target=browser` on an entry importing *only* the hook failed with *"Browser build
cannot require() Node.js builtin: `stream/web`"*, out of `nats` — the island this page tells you to
write could not be bundled at all. The package's `sideEffects` array is what lets the bundler shake
the bus out; the split is what makes "the client entry cannot reach the bus" something a build
cannot quietly undo, since a namespace import or an `export *` defeats tree-shaking.

## The ladder

| Tier | Name | You write | Server owns | Client owns | Cost |
|---|---|---|---|---|---|
| 1 | **Channels** | `channel('org-feed', { params, policy, catchUp, records?, events? })`, then `useChannel(decl, params)` | truth + fanout | subscription | ~0 — pubsub over WS |
| 2 | **Live queries** | `query({ live: true, sql })` | truth + change detection | a reactive result set | one replication slot + a matcher |
| 3 | **Local-first** | the same `mutator`, plus `entity(name, { persist: true })`, see [below](#tier-3-is-pending-in-2100) | truth + rebase | a durable local store, offline writes | IndexedDB + the one outbox |

Tier 1 for presence, typing indicators, toasts, cursors. Tier 2 for "the list updates when someone else edits". Tier 3 for offline-capable apps.

**Row 3 is on the entity, not the query.** `persist: true` is an `entity()` option in 21.0.0 (unreleased), read by realtime's IndexedDB persister and one outbox. Read the row's own section before writing anything against it.

**Tier 1's `events` are at-most-once, by construction; its `records` frames are repaired.** A dropped `events` frame is counted and logged, never resent. A dropped `records` frame is marked on the server, which sends the socket a `replay-gap` frame once it drains, and the client re-runs the channel's `catchUp` read (21.0.0, unreleased; [below](#why-delivery-needs-its-own-counter)). State that must arrive belongs on a live query or a `records` channel; ephemera belong on `events`.

Tier 2 covers what people almost always mean by "make it realtime": the list updates without a refresh, and my own click feels instant. It delivers both with **no client database, no client schema versioning, no conflict-resolution UX, and no offline-write semantics to design**. Tier 3 buys exactly one additional property — writes that survive being offline — and costs a durable local store, a rebase log, client migrations, and a conflict story per mutator. Charging every app for that is how realtime frameworks become slow frameworks.

## Same mutator at every rung

```ts
// mutator (action + optimistic local twin)
export const likePost = mutator({
  // Convergent, not incremental: `local` replays on every rebase, so applying it N times has to
  // equal applying it once — `likedByMe` is what makes the second application a no-op.
  local(tx, { postId }) {
    tx.posts.update(postId, (p) =>
      p.likedByMe ? {} : { likedByMe: true, likeCount: p.likeCount + 1 });
  },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
```

| Tier | What `local` does | What `server` does |
|---|---|---|
| 1 | not called | runs, publishes an event |
| 2 | applies to the page's record-store **overlay** immediately, visible in every island; dropped when the HTTP answer's records land, or on refusal | runs as an HTTP `POST` to the action's path, with an idempotency key; its records flow back into the store |
| 3 | applies to the overlay, and when the network takes nothing the write is queued in the page's outbox (the call resolves `undefined`) with the overlay kept on screen | runs on replay, over HTTP with the same idempotency key |

**A mutation the server *refuses* is rolled back, not retried.** The optimistic write goes, and so does every write made after it — undone newest first, then replayed without it, which is sound only because `local` is pure. The refused intent is dropped from the rebase log: a denial is a decision about that intent, and retrying it would put the write the server refused back on the screen. A refused key stays in the queue as `failed` for the UI to render, and re-issuing the same idempotency key is treated as a **new** intent with a new sequence at the back of the queue, not a collapse onto the denial.

`local` is a pure function of `(tx, input)`, therefore replayable. Hence the rule: **no I/O, no `Date.now()`, no `Math.random()` inside `local`.** Same input, same patch, every replay.

## The fluent surface

`interface Mutator extends Action` — a mutator **is** an action, so every action member is already on it (`likePost.tool()`, `.openapi()`, `.client({ baseUrl })`, `.job()`, `.contract()`, `.as()`, `.describe()`, `.named()`, and the lifted `.input` `.output` `.policy` `.mcp`). The three names it was authored with — `.local`, `.server`, `.conflict` — project unchanged, plus a brand and its own descriptor. Both halves are reached through the mutator itself, `likePost.local(tx, input)`, never a declaration object. A mutator has no `.def`.

| Member | Is | Rule |
|---|---|---|
| `.local(tx, input)` | the optimistic twin | runs against the local store, synchronously, no I/O, returns `void`. Takes **already-parsed** input — nothing re-parses on this half |
| `.server(ctx, input)` | the authoritative half | takes **raw** input, like the callable and `.as()`, because this is where parsing happens |
| `.conflict` | the rebase strategy, lifted | `'server-wins'` \| `'last-write-wins'` \| `custom(merge)` — the declared value verbatim, merge function included |
| `.isMutator` | the brand | always `true`; `isMutator(value)` is the guard |
| `.describeMutator()` | the manifest row | the action descriptor plus `kind: 'mutator'` and the **resolved** strategy name — `custom(merge)` describes as `'custom'` |
| `.describe()` | the action descriptor | still reports `kind: 'action'`, with `mutator: true` — that flag is what puts the `mutator` count in `x.manifest.json`. `describeMutator()` is the one that says `kind: 'mutator'`, plus the resolved strategy |

**`.server()` routes through the action's own callable, never the declared `server`.** It calls `base(input, { ctx })`, and that callable *is* `invoke` — so the authoritative half cannot skip the input parse, the policy or the output parse. Reaching the declaration from there would be a second execution path, which is the one thing `@ultimat3/action` exists to prevent. Hence the guarantee this page rests on: the offline/realtime half of a mutator gets exactly the same parse → policy → handle → parse core as an HTTP call, an MCP tool call and a job run, because it **is** that call. A denied `.server()` never reaches the declared half, and neither does one whose input fails the schema — `X_UNAUTHENTICATED`, `X_FORBIDDEN` and `X_INPUT_INVALID` come back from the same core that serves the HTTP route.

The parsed-vs-raw asymmetry between `.local()` and `.server()` is deliberate, not an inconsistency. `local` replays on every rebase and must stay a pure function of `(tx, input)` — no I/O, no clock, no randomness — so re-parsing on each replay would be wasted work on input that was already validated once.

`.local()` is the name. No alias: the old `.applyLocal` is gone, not deprecated.

`.named()` rewraps rather than dropping the twin — a renamed mutator keeps both halves, its `conflict`, and every inherited action member.

## Tier 3 is pending in 21.0.0

The heading keeps its name because other pages link to it; the pieces it describes are in the
tree. `As of 2026-09-22`, 21.0.0, **unreleased**: the 20.x shape (`store`, `queue` and `log` on
`LiveClientOptions`, `MemoryLocalStore`, a `createOpfsLocalStore()` that threw
`X_NOT_IMPLEMENTED`) is deleted with `LiveClient`. What replaces it:

| Piece | 21.0.0 |
|---|---|
| what persists | `entity(name, { persist: true })`, default `false`. The server renders the persisted record types into a private document's `<meta name="ultimate-persist">` (`packages/cli/src/page-sync.ts`, `persistedRecordTypes`) |
| where | IndexedDB, every entry keyed `[scope, type, key]`. Scope is `p:<principal>` or `anon`; an unscoped page persists nothing |
| what is written | synced rows only, never an overlay. Debounced 250 ms, flushed on `pagehide` and when the page is hidden |
| boot | the rows are restored **before** the socket connects, as provisional records; the first server row for a key wins outright |
| an answer that did not carry every row the overlay wrote | the overlay stays for those rows until a server row for them arrives, capped at 10 s (`DEFAULT_AWAIT_SERVER_MS`), after which server truth stands |
| a write with no response | only `X_CLIENT_TRANSPORT_FAILED` with `meta.failure: 'network'`: `useMutation` queues it in the page's one outbox under its idempotency key, keeps its overlay on screen, and resolves `undefined`. `'status'` rejects and drops the overlay; `'body'` (a 2xx that was not JSON, which may have landed) rejects and keeps the overlay until the next server row |
| replay | in order, over HTTP, each write with its original idempotency key: whenever the page socket (re)connects, on `online`, and on the service worker's `OUTBOX_DRAIN_MESSAGE` ([PWA and offline](PWA-And-Offline)). A retryable failure stops the pass; a refusal is final and rolls back its overlay |
| a principal change | **within one page** (`rescope()`): the previous principal's rows and queue are wiped, and writes still queued are lost, deliberately. **A sign-out that navigates** to a new document (the reference app's idiom: the `endSession` action at `POST /api/sessions/end`, posted by a native form) clears the browser first: its response carries `signOutHeaders()` from `@ultimat3/auth`, whose `Clear-Site-Data: "cache", "storage"` drops IndexedDB, local storage, the service worker and its cache, in a secure context. The next boot is the second line: it wipes every stored scope except the current principal's before restoring anything (`packages/realtime/src/boot.ts`, `wipeOthers`). An unscoped page wipes nothing |
| blocked storage | memory, plus one `X_LOCAL_STORE_UNAVAILABLE` warning; nothing survives a reload |

The boot runs as **one deferred classic script per page** (`/_x/page-boot/<hash>.js`, from
`@ultimat3/realtime/boot`). It is rendered only on a scope-tagged (private) document that emitted
an island reaching `@ultimat3/realtime`. It wipes other scopes, restores this principal's rows,
and opens the outbox, so a reload that opens no live hook and writes nothing still replays what
the previous load queued.

**Trade-off: two principals in two tabs of one browser.** The newer page's boot wipes the other principal's rows and queued writes from disk. The older tab keeps its records and its queue in memory, and re-persists them on its next write; if it closes first, what it had queued offline is gone.

## Live query in the browser, end to end

Written `As of 2026-09-05` because four agents building one app each **polled** a query from an
island instead of subscribing. Rewritten for 21.0.0 (unreleased), which deletes the app's socket
adapter, its sync URL and its `LiveClient`: the page's one socket is the framework's.

| Step | Where | What |
|---|---|---|
| 1. the dependency | root `package.json` | `bun add @ultimat3/realtime`. `x new` installs `@ultimat3/query` and **not** `@ultimat3/realtime` |
| 2. the query | `app/<feature>/live.ts` | `query({ …, live: true, subscribes: ['posts'] })`, bounded and ordered; `x g query <name> --live` writes it |
| 3. the ref | the island | `{ name: 'liveFeed', live: true }`, the query's registered **name**, never the query value: importing that drags its whole read path into the island. `live` is stated beside the name, not derived (see below) |
| 4. the install | nothing to write | `x build` builds every island whose own import graph reaches `@ultimat3/realtime` from an entry that calls `installRealtime({ signal: createSignal })` first, for about 100 B. An island not reaching realtime pays nothing. The sync target is read from the document's `<meta name="ultimate-sync">` ([Configuration](Configuration), `SYNC_URL`) |
| 5. the hook | the component | `useQuery(ref, input)` returns an `AsyncState` accessor. **In an island, never a page body**: a page component never runs in a browser, so the hook answers `pending` there forever |

```tsx
// app/feed/feed.island.tsx — the only module of /feed a browser downloads
import { useConnection, useQuery } from '@ultimat3/realtime';
import { For, Match, Switch } from 'solid-js';
import { render } from 'solid-js/web';

type FeedRow = { id: string; title: string };
const LIVE_FEED = { name: 'liveFeed', live: true } as const;

export function mount(el: HTMLElement, props: { orgId: string }) {
  el.textContent = '';                       // Solid's render APPENDS; the server's loading shell goes first
  render(() => <Feed orgId={props.orgId} />, el);
}

function Feed(props: { orgId: string }) {
  const feed = useQuery<FeedRow>(LIVE_FEED, { orgId: props.orgId }); // subscribe, once
  const connection = useConnection();
  return (
    <Switch>
      <Match when={feed().status === 'pending'}><p>loading…</p></Match>
      <Match when={feed().status === 'failed'}><p>could not load the feed</p></Match>
      <Match when={'data' in feed()}>
        {connection.offline && <p>offline — showing the last rows</p>}
        <ul><For each={(feed() as { data: readonly FeedRow[] }).data}>{(row) => <li>{row.title}</li>}</For></ul>
      </Match>
    </Switch>
  );
}
```

`feed()` is an `AsyncState`: `pending`, then `ready` (or `refreshing`) carrying the rows, or
`failed`. It re-renders on every patch the sync node sends, with no timer and no refetch. The list
holds **ids**; the rows come from the page's one `RecordStore`, so a write to a record through
any path re-renders every list showing it. A non-live query uses the same hook: drop `live`, and
name its entity (`{ name, entity: 'post' }`) so its rows are store records too.

**Two limits, `As of 2026-09-22`.** `x build` sees realtime only in the island's **own** graph. An
island that reaches it through a package, rather than importing it, calls
`installRealtime({ signal: createSignal })` in `mount` itself, or throws `X_REALTIME_UNINSTALLED`.
And `live` and `entity` on the ref are stated by hand, not derived from the query declaration. Both
are in the plan-101 DX ledger.

### In development, the feed is this process

`As of 2026-09-05`. The sync node's changes come from Postgres logical replication — a real
`DATABASE_URL` and the `replicator` role (`x dev --role replicator`). The embedded database has no
walsender, so under a plain `x dev` a subscription took its snapshot and then heard nothing: every
`--live` query in every scaffolded app was dead in development, which is where an author first
tries one. `x dev` now installs the in-process bridge (`@ultimat3/testing`'s `startLiveReplicator`
— the row observer the framework's own live tests run on) whenever the database is embedded, and
the ready line says so:

| `db=` | `live=` | What reaches a subscriber |
|---|---|---|
| `embedded` | `in-process` | every repository write **this process** makes — a write made by another process is invisible, which is the bridge's honest bound and holds by construction under `x dev` |
| `external` | `replication` | what the WAL decoder delivers, in this process (`--role replicator`) or in another |
| no `sync` role | `none` | nothing; there is no node to feed |

Never both: with a real database the decoder already carries this process's own writes, and a
bridge beside it would deliver each of them twice. `--json` carries the same fact as `liveFeed`.

## Live query pipeline

```
Postgres (logical replication slot)
    │  WAL decode, per-table
    ▼
replicator role  ──► change feed (ordered, per-table, with LSN)
    │
    ▼
incremental matcher  ──► for each registered live query: does this row enter/leave/update the result?
    │                      (predicate + order + limit evaluated against the changed row only)
    ▼
NATS subject per query-hash + tenant  ──► fanout
    │
    ▼
sync role (stateless)  ──► WS frame: {qid, op: insert|update|delete, row, lsn}
    │
    ▼
Solid signal patch — fine-grained, no re-render of the list
```

| Stage | Owned by | Guarantee |
|---|---|---|
| WAL decode | `replicator` (1 per DB) | ordered by LSN, at-least-once |
| matcher | `replicator` | a change touching no registered query costs one predicate check |
| fanout | NATS | subject = hash(query, params, tenant); no per-socket state on the bus |
| socket | `sync` (stateless, no sticky sessions) | client re-subscribes anywhere; scales on connection count |
| authz | `policy` on the `query` | evaluated at subscribe **and** re-checked on row delivery — a row that fails the policy is dropped, never sent |

The matcher is why this is affordable: membership is decided from the changed row plus the query's predicate, order, and limit — never by re-running the query. Which is exactly why `live: true` requires a deterministic, bounded `sql` ([Queries and live queries](Queries-And-Live-Queries)).

## One record per `type:key`

The page holds **one** `RecordStore` per tab, shared by every island through a `globalThis` handle.
It is an identity-mapped store: a record is one value per record type (the entity name) and record key,
however many lists, islands and paths hold it. It is 21.0.0, unreleased
(`packages/realtime/src/record-store.ts`).

| Consequence | Why it matters |
|---|---|
| A socket patch, an HTTP answer's records and an optimistic write all move the same record | two components rendering post #7 cannot disagree about it, in one island or across two |
| A list holds **ids**; the rows come from the store, for a live and a non-live query alike | a write to a record re-renders every list holding it, with no refetch |
| Two layers: **synced** is server truth, and the **overlay** is every pending optimistic write, replayed over it on every change | rolling back an optimistic write cannot delete a row the server has since sent |
| A patch that omits a field never clears it | two queries may project different columns; a narrower answer must not blank what a wider one renders |
| A row that is not an object, or has no key, is dropped and reported (`X_RECORD_REJECTED`) | a keyless row would overwrite another record |
| A record lives exactly as long as something holds it | the last release drops it, so an infinite scroll is not a leak |

**The key comes from the server, on every path.** A browser cannot compute a key without importing
the app's `entity()` declarations, so it never does.

| Path | Where the key is |
|---|---|
| an HTTP envelope | `records`: record type → record key → row, keyed by the entity's `recordProjection` |
| a live snapshot | `keys`, parallel to `rows`, sent only when some key is not its row's `id` |
| a live patch | `key`, sent only when it is not the row's `id` |

So an entity with a **composite primary key can be live**. A non-live `useQuery` lists its records
in the envelope's `records[type]` key order, which `rowsOf` fills in data order. An answer with no
envelope holds its rows itself, and they are not records. A live window whose node named no type
keeps its rows under `?query:<name>` (`unnamedType`), so two unnamed windows never merge two
entities' rows.

## Channels are declared

`As of 2026-09-22`, 21.0.0, unreleased. A channel is a declaration, never a string. The hub API that
took raw topics (`hub.guard`, `subscribe(socket, topic)`, `publish(topic)`, `publishFrame`,
`channelFrame`, `TopicGuard*`, the `nodeId` option, and a `{ kind: 'topic' }` subscribe target) is
deleted.

A channel is written **once, in two halves on one ref**, the same split as a query's `QueryRef`: an
island holds the browser half and never imports an entity or a database package.

```ts
// app/feed/channel-ref.ts — the BROWSER half: name, params, catch-up read. No entity, no policy.
import { channelRef } from '@ultimat3/realtime';

export const ORG_FEED = channelRef('org-feed', {
  params: ['orgId'],
  catchUp: { name: 'orgFeed' }, // the query re-read on replay-gap or a new epoch
});
```

```ts
// app/feed/channels.ts — the SERVER half, on the same ref. Registers on import.
import { channel } from '@ultimat3/realtime';
import { Post } from '../posts/entity';
import { ORG_FEED } from './channel-ref';
import { feedRead } from './policies';

export const orgFeed = channel(ORG_FEED, {
  records: [Post],  // every param must be a column of each listed entity, or refused
  policy: feedRead, // decided at subscribe, with the params as input
  events: true,     // ephemeral payloads: typing, presence
});
```

```ts
// in an island: the ref, never the server half (which would bundle the entity and its driver)
import { useChannel } from '@ultimat3/realtime';
import { ORG_FEED } from './channel-ref';

declare const orgId: string;
const feed = useChannel(ORG_FEED, { orgId }, { onEvent: (event) => console.debug(event) });
```

`channel(name, { params, catchUp, … })` in one call still exists for a channel no browser holds.
The reference app's idiom is `examples/dummy/apps/web/app/posts/channel-ref.ts` beside `channels.ts`. The catch-up
query's name is written by hand on the ref, like a `QueryRef`'s; `x build` emitting refs is
plan-101 DX ledger #21.

| Fact | Rule |
|---|---|
| a policy subject | `row: ({ params, ctx }) => …` loads what the policy decides about, the way an action's `row:` does |
| registration | `channel()` registers itself in the process's channel table. `new ChannelHub({ transport, sockets })` serves every declared channel |
| subscribe | by declared name + params. An undeclared name is `X_TOPIC_FORBIDDEN`, and so is a policy denial, latched per (socket, topic) until the session changes |
| the first join | a join with no cursor on a channel that carries records is answered with **one** `replay-gap`, so the client runs one catch-up read. Rows written between a page's render and its join are otherwise never seen. A resubscribe with `since` replays from the ring, or gets `replay-gap` when `since` fell out of it (`channel-logs.ts`, `resume`) |
| records | rows of the listed entities travel as `records` frames, carrying `seq` and `epoch`, into the record store |
| events | `hub.publishEvent(decl, params, event)` on a channel declared with `events: true`; otherwise `X_CHANNEL_DECLARATION_INVALID` |
| presence | a roster arrives as an `events` frame `{ presence: op, members, total? }`. Read it with `readPresence(frame.event)` in the channel's events handler. There is no separate presence frame |
| the browser | `useChannel(decl, params, handlers?)`; `topic()` is the one way to spell a topic, and `bun run channel-literals` refuses any other |
| the manifest | lists every channel (`describeChannels`, on `@ultimat3/realtime/server`). In a contract diff these are **breaking**: a channel removed, its params changed, its policy changed, a record type no longer carried, `events` switched off |

## LSN cursors

Every frame carries an LSN. The client's last-seen LSN is what makes reconnect a **delta** instead of a refetch.

| Property | Behavior |
|---|---|
| Cursor | the highest LSN the client has applied, per subscription. It advances on **every patch**, not only on a snapshot — a cursor whose `at` freezes at the last snapshot fails the lag check, and every client connected longer than `maxLagMs` re-snapshots instead of resuming |
| Reconnect inside the change buffer window | delta replay from the `replicator`'s ring buffer — zero DB work |
| Reconnect outside the window | one bounded snapshot query at a current LSN. Never WAL history traversal |
| Cursor unusable and no snapshot path supplied | `X_CURSOR_STALE` |
| Ordering | LSN is monotonic per DB, so a client can never apply an older change over a newer one |
| What a cursor carries | `{ qid, lsn, ids, at }` and nothing else, `As of 2026-08-24`. `digest` and `count` were written by every snapshot, encoded and validated on every `subscribe` frame, and **read by nothing** — `digest` cost a canonical-JSON render plus a hash over EVERY ROW of every snapshot, paid once per live query per reconnecting socket in the restart storm this package is measured on, and `count` would have been wrong had it ever gained a reader, because `advance` seeds its set from the already-truncated `ids`. Both are deleted, and that is what moved the wire version ([below](#wire-protocol-version)) |

## Inbound frame order

A frame is routed as soon as it arrives, so two frames from one socket can be in flight at once. What is ordered is narrow and deliberate `As of 2026-08` — a lane per socket would put every frame behind the slowest one, and the slowest one is a subscribe's snapshot read.

| Frames | Ordered against | Why that unit |
|---|---|---|
| `subscribe` on a query | the same `sid` | `add` then `drop` for one sid, or the drop finds nothing and the add strands the subscription it was meant to end |
| `subscribe` on a topic | the same topic name | one membership, same add/drop pair |
| `hello`, everything else | nothing | they read state and write none |

**Ordering is not what bounds the caps.** N sequential subscribes still pass a check-then-act limit N times, so every refusal a subscribe can answer with — the sid claim, `maxPerSocket`, `maxPerTenant`, `maxTopicsPerSocket`, `maxTopicsPerNode` — is decided **synchronously, before the first `await`**, against a count that already includes the subscribes still in flight. One WebSocket write carrying N subscribe frames used to pass each cap N times.

## Staying connected

A dead TCP connection that was never closed fires no `close` event. Only the client can end one, so it beats.

| Property | Behaviour |
|---|---|
| Interval | **15s**, fixed for the page's one socket. The client option that set it went with `LiveClient` in 21.0.0 |
| One beat | a `hello`, plus one subscribe frame per topic held. A beat and an opening frame are **byte-identical** — `hello` carries no cursors — so a beat asks for nothing and resumes nothing |
| Silence | nothing received for **two** intervals ⇒ the socket is closed with code `4000` and the reconnect timer arms |
| Why re-sending topics | on the node, subscribing to a topic **is** joining its presence set, and repeating the frame is the presence heartbeat |
| No knob | `realtime.heartbeatMs` in `app.config.ts` was read by nothing and is **deleted** `As of 2026-08-19`; an app still setting it fails `typecheck` with `TS2353` |

**A reconnect re-announces everything, one frame at a time.** `hello`, then one `subscribe` per registration carrying that registration's cursor, then one per topic. `hello` itself carries **neither** cursors nor topic membership — resume is decided per subscription, by the frame that also names the query and its input, and topic membership is state on the node's socket. Without the topic half a channel stayed silent from the first reconnect onwards while its handler was still installed, and its presence membership was swept.

**Writes never ride the socket**, `As of 21.0.0` (unreleased). The socket `mutate` path is deleted: `useMutation` posts the mutator's action over HTTP through `clientTransport`, with an idempotency key, so a resend after a lost answer is served from the action's idempotency store. Its answer's records are adopted before the overlay goes, so nothing flickers.

## The reconnect risk

**Reconnect is the expensive part of any sync engine, and it is where naive designs fall over.** A deploy or a network blip drops N sockets at once; each client then asks "what changed since LSN X?" If the answer requires replaying arbitrary WAL history or re-running every query, a rolling restart becomes a self-inflicted thundering herd that outlasts the deploy.

| # | Mitigation | Detail |
|---|---|---|
| 1 | **Prototype before locking topology** | the reconnect benchmark: 50k sockets, forced `sync` restart, recovery time and DB load. **Measured `As of 2026-08`** — the numbers are below, and both results are committed |
| 2 | **Bounded per-query change buffer** | the `replicator` keeps a ring buffer of recent changes per query-hash. Reconnect within the window = delta replay from the buffer, zero DB work |
| 3 | **Snapshot fallback, not WAL replay** | outside the window the client gets a fresh snapshot at a current LSN. Cost is one bounded query, never history traversal |
| 4 | **Jittered reconnect-with-backoff, server-directed** | draining `sync` nodes send a `reconnect` frame with a per-client delay so clients redistribute instead of stampeding. the page socket arms **one** timer per closed socket: the node's assigned delay when there is one, otherwise `browserBackoff`, which is base 500 ms, factor 2, `equal` jitter, **capped at 4 s** (`BROWSER_RECONNECT_MAX_MS`, `thundering-herd.ts`). It was the server-side `defaultBackoff`'s 30 s until 21.0.0: after a deploy that left the returning node, and its `update-available`, unreached for 27 s. `equal` keeps a floor, so a SIGKILLed node's herd redials across a 2–4 s window rather than at once, and the `AcceptBudget` sheds the excess before any query runs. `useConnection().reconnectAt` renders the wait. The committed benchmark runs predate the cap |
| 5 | **Per-tenant subscription caps** | a registered-query explosion is a load-shedding decision, made with a limit and a typed `X_SUBSCRIPTION_LIMIT`, not by falling over. **Reachable, not yet wired** `As of 2026-08`: the boot passes no caps, and the per-tenant scope needs both `maxPerTenant` and `tenantOf`. The **per-socket** cap applies today at its default of 128 |
| 6 | **Consider wrapping an existing protocol** | if the benchmark says our matcher is the bottleneck, adopting an existing open sync protocol beats inventing one |

## The forced-restart benchmark

One harness, two runs, two questions. **Reachability**: how long until a killed node's clients are back and receiving. **Delivery**: how many patches were lost getting there. A first-delivery timer answers the first and is blind to the second, which is why there are two.

[`scripts/bench/restart-bench.ts`](https://github.com/developerz-ai/ultimate/blob/main/scripts/bench/restart-bench.ts) produced both, each with its own transcript beside it in [`scripts/bench/results/`](https://github.com/developerz-ai/ultimate/tree/main/scripts/bench/results).

```bash
# reachability, 50,000 clients — 2026-08-11
bun run scripts/bench/restart-bench.ts --clients 50000 \
  --out scripts/bench/results/50k-restart.json

# delivery, 10,000 clients, a probe every 200ms — 2026-08-17
bun run scripts/bench/restart-bench.ts --clients 10000 --probe-interval-ms 200 \
  --out scripts/bench/results/10k-restart-seq.json
```

| Setup | Value |
|---|---|
| Clients | real WebSocket connections, split across client-shard OS processes — 50,000 over 10, 10,000 over 8 |
| Server | **one** `sync` node (the shipped `createSyncNode`) in its own process, over `InProcessTransport` |
| Admission | the shipped `AcceptBudget` at its defaults — 500/s, burst 2000 |
| Kill | `SIGKILL`, no drain, **no `reconnect` frame** — recovery is driven only by each client's own `backoffDelay` |
| Readiness | read from the server's own socket count, never the load generator's self-report |
| Subscription under test | a **channel** topic. Neither run subscribes to a live query, so no cursor, snapshot or gap-repair path is exercised |

### Reachability — 50,000 clients

Per client, the **first channel patch received on the reconnected socket**: reconnect *and* resubscribe *and* one delivery. It is not a consistency metric, and cannot be one — see below.

| Restart-phase result | Value |
|---|---|
| Reconnected | **50,000 / 50,000** |
| Received a channel patch inside the window | **49,981** |
| Time to first patch, p50 | **54.0s** |
| Time to first patch, p90 | **105.5s** |
| Time to first patch, p99 | 127.8s |
| Time to first patch, max | **145.7s** |
| Connect attempts shed before any query path | **156,851** — the DB-load proxy: none of them reached a query or snapshot |
| New server accepting | 2.3s after the kill |

**The timings are unchanged and still stand.** Only the name was wrong: this metric was published as "time-to-consistent" until 2026-08, and it never measured consistency. The harness recorded each client's last-seen sequence number and read it nowhere, so a patch the node dropped was invisible to it by construction. Nothing here is retracted — a number that timed reachability is now called reachability.

### Delivery — 10,000 clients

Every client counts **observed sequence gaps** in the probe stream it received, per connection. An observed gap is a break between two frames one connection actually received — the publisher numbers every probe, so a missing number *between* two arrivals is a frame that was published to a subscriber and never came.

| Restart-phase result | Value |
|---|---|
| Reconnected | **10,000 / 10,000** |
| Patches received | **1,666,882** |
| Observed sequence gaps | **0** — 0 gap events, 0 missing frames, 0 duplicates, 0 publisher rewinds, 0 malformed |
| Clients that observed a gap | **0 / 10,000** |
| Time to first patch, p50 / p90 / max | 10.9s / 22.3s / 43.5s |
| Connect attempts shed before any query path | 33,424 |

**Zero observed gaps is a lower bound on loss, not a proof of zero loss.** The counter can only see a hole with a received frame on each side of it, so three losses are invisible to it by construction:

| Invisible to the counter | Why |
|---|---|
| frames lost before a connection's first arrival | there is no lower anchor to measure the gap from |
| frames lost after a connection's last arrival | there is no upper anchor, and the connection may simply have ended |
| every frame, on a connection that received nothing at all | no anchors, so the connection contributes no sequence to check |

So the honest claim is **"no client observed a lost channel frame"**, not "no channel frame was lost". Every other statement of this result on the wiki is shorthand for this paragraph.

**Not evidence about 50,000.** The 50,000-client run predates the counter and carries no delivery number; `As of 2026-08` the 10,000-client run is the only one with delivery accounting, and it does not extrapolate.

### Why delivery needs its own counter

A dropped **`records`** channel frame is now **repaired**, `As of 2026-09-22` (21.0.0,
unreleased). `SocketRegistry.deliver` still counts every refusal (the series
`channel_frames_dropped_total`, the warn line `channel.frames_dropped` carrying
`{ topic, dropped, total }`, and `node.sockets.droppedChannelFrames` for a test that cannot scrape).
It also marks the (socket, topic) as gapped, and once the socket drains it sends one `replay-gap`
frame, counted in `channel_replay_gaps_total`. That series counts gaps announced, by design: the
repair happens in the browser. The client (`client-channels.ts`) keeps a cursor per channel. On
`replay-gap`, or a new epoch, it re-runs the channel's `catchUp` query and applies the frames that
arrived meanwhile after it. A dropped `events` frame is ephemeral by design and is only counted. The live-query path
already repairs the same drop, as it has since 2026-08: the subscriber is marked desynced, and the
next change re-snapshots it.

What it is **not**: a multi-node result — neither run crossed NATS, so this is **per-node recovery**, not fanout. Not a throughput figure either: no requests/sec, no message rate, no sustained-load number. Per-node socket capacity in the tables above this section is still a target derived from Bun's native WebSocket implementation, not a benchmark result. Long-running Bun processes are also less battle-proven than Node's; sustained-socket memory profiling is explicit roadmap work.

## `sync` drain

`sync` holds no durable state, so a restart is only dangerous in aggregate. Closing 50,000 sockets at once means 50,000 simultaneous reconnects, all resubscribing, all asking "what changed since my LSN?" — a self-inflicted DDoS landing during a deploy, when capacity is already reduced. Worse, it is fractal: surviving nodes overload, drop connections, and the herd re-forms.

So the drain is **server-directed**:

```json
{ "type": "reconnect", "afterMs": 1830, "resumeFrom": "0/1A2B3C4", "reason": "drain" }
```

| Property | Effect |
|---|---|
| Per-client `afterMs`, jittered over a window | reconnects arrive spread out, not as a spike |
| Server chooses the window from live connection count | 500 clients drain in a second; 500k spread over minutes |
| `resumeFrom` LSN | reconnect is a delta from the change buffer, not a resubscribe-and-refetch |
| Clients redistribute | the LB places them across remaining nodes; no sticky session to honour |
| Client-side backoff is a floor, not the mechanism | a client that loses the socket without a frame still backs off exponentially with jitter |
| Ordering in the drain sequence | `/readyz` → 503, stop new subscribes, send `reconnect` frames, close cleanly, flush spans, exit 0 |

Full drain sequence per role: [Deployment](Deployment).

## Wire protocol version

`PROTOCOL_VERSION` is **3** `As of 2026-09-22` (21.0.0, unreleased; it was 2 from 2026-08-24) ([`packages/realtime/src/sync-protocol.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/realtime/src/sync-protocol.ts)). A mismatch is `X_PROTOCOL_VERSION` on the frame, with one instruction, rather than a per-field decode error nobody can act on.

**Clients and `sync` nodes must be redeployed together across this bump.** A cursor rides in BOTH directions — the client's `subscribe` and the node's `snapshot` — so a skew breaks resume from either side.

| Skew | What happens |
|---|---|
| new node ← old client (v2) | `decode` refuses the frame: `X_PROTOCOL_VERSION`. v3 deleted the `mutate` and `rebase` kinds (writes go over HTTP) and the `presence` kind (a roster is an `events` payload now), added `records`, `events` and `replay-gap` for channels, and narrowed the `ack` frame to a refusal: it carries the sid of a subscription the node refused, or the socket id for a frame it could not read, and is never a write receipt |
| old node ← new client (v3) | the same, at the other end |
| v1 ↔ v2 (2026-08-24) | the old node's `cursor()` reads `digest` through a `str()` that **throws on an absent field**, which is precisely why that was a version and not a silent widening |

**The version guards incompatibility, never novelty.** Two earlier realtime changes deliberately did not move it: an additive optional field (`snapshot.entity`) and a removed field read through `list()` (`hello.resume`) are both readable in either direction, because `decode` builds a whitelist object and `list()` answers `[]` for an absent key. `cursor()` is the other kind of reader — `str`/`num` throw — so removing a field it reads is the one shape that needs the number.

## Build skew

A client on build `A` connecting to a `sync` node on build `B` is **accepted**, then sent an `update-available` frame carrying the node's `buildId`; the socket is not killed. Skew is the build the client claims against the node's own: `?build=` on the dial, and the `hello` frame's `buildId`, which the node records on every hello and which is the later word — a dial without `?build=` starts as "not skewed" and the first hello settles it. Neither side's build moves while a socket is open, so the answer is a property of that socket for its lifetime — a client learns about a deploy on the socket it opens against the new node, never on one it is already holding. Every `hello` on that socket re-reports the same answer, the heartbeat's included. The client's `AppUpdateAvailable` signal flips and the app renders its own update affordance. See [PWA and offline](PWA-And-Offline).

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_TOPIC_FORBIDDEN` | an undeclared channel name, or the declaration's policy denied the actor | `x policy list --json`, then widen the policy on the `channel()` declaration, or subscribe as an actor it allows |
| `X_SUBSCRIPTION_LIMIT` | a socket, tenant or node reached a cap; the error names which scope refused, and which knob | `raise maxPerSocket / maxPerTenant / maxEntries on the LiveQueryRegistry (per socket, default 128), or unsubscribe unused live queries` — a **channel topic** cap answers `maxTopicsPerSocket` (64) / `maxTopicsPerNode` (10,000) on the `ChannelHub`. All constructor options, none an `app.config.ts` field |
| `X_PROTOCOL_VERSION` | client and server disagree on the wire format, or a malformed frame. The wire is at **3** `As of 2026-09-22` ([above](#wire-protocol-version)) — a v2 client and a v3 node cannot talk in either direction, so the two are redeployed together | `x build && redeploy the client; the sync node sends 'update-available' before it drains` |
| `X_LIVE_QUERY_UNKNOWN` | a `subscribe` frame named a live query this node does not have | `x queries list --json` |
| `X_CURSOR_STALE` | resume cursor cannot be honoured and no snapshot path was supplied | `pass 'snapshot' to resumeFrom() so the fallback path can re-snapshot instead of failing` |
| `X_REBASE_CONFLICT` | a `custom(merge)` returned something other than a row with a string `id` | `set conflict: 'server-wins' on the mutator, or return a row from custom(merge)` |
| `X_REALTIME_UNINSTALLED` | a hook ran in a browser island whose bundle never called `installRealtime()` | `x build`, which installs it on every island whose own graph imports realtime. An island that reaches realtime only through a package calls `installRealtime({ signal: createSignal })` in `mount` |
| `X_SYNC_UNCONFIGURED` | a live hook needed the page socket, and neither `installRealtime({ sync })` nor `<meta name="ultimate-sync">` named a target | serve the page through `x dev` or the container, which render the meta, or pass `installRealtime({ signal, sync: { url, buildId } })` |
| `X_RECORD_REJECTED` | a row reached the record store with no key, or not as an object | `x entities describe <entity> --json`, then return whole rows |
| `X_MUTATOR_CLOCK_MISSING` | `conflict: 'last-write-wins'` with no number `updatedAt` on the entity | add the clock, or declare `conflict: 'server-wins'` |
| `X_TRANSPORT_UNAVAILABLE` | the fanout bus is down | `x doctor — then check NATS_URL points at a reachable nats-server` |
| `X_TRANSPORT_PROTOCOL` | the bus answers in a protocol this build does not speak | `the bus must be nats-server >= 2.11 with JetStream enabled (nats-server -js)` |
| `X_BUILD_SKEW` | client build's contract is incompatible with the server's | reload the client; see the fix line on the error |

Verbatim shapes: [`packages/realtime/src/errors.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/realtime/src/errors.ts). Full index: [Error codes](Error-Codes).

## Rules

- Truth is always the server. A client is never the merge authority.
- One authz system — the `query`'s `policy`, re-evaluated per delivered row.
- `sync` is stateless. Any state that must survive a restart lives in Postgres or NATS.
- A live query must be deterministic and bounded (`orderBy` + `limit`), or `x verify` rejects it.
- Presence and typing indicators are tier 1 forever — never model ephemeral state as rows.
- `local` does no I/O, no `Date.now()`, no `Math.random()`. It must be replayable.
- Offline writes go through the tier-3 mutator queue, never Background Sync guesswork.
- Climb the ladder for a property you need, not for a tier you like. Tier 3 costs a durable client store forever.
