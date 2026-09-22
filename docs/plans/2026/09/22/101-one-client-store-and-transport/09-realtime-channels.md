# 09 — Typed channels that write the store

> Part of [`overview.md`](overview.md). Depends on: 06. Tier: 3.

## Files to change
- `packages/realtime/src/channel.ts` — `channel(name, { params, policy, catchUp, records?, events? })` (`catchUp` = the query ref slice 10 re-reads on a gap) declaration: `name` + a typed param builder is the ONLY way to spell a topic string. Server publish and client subscribe both take the declaration, never a string.
- `packages/realtime/src/client-topics.ts:27`, `client.ts:277,291` — `subscribe(topic: string, handler)` → `useChannel(decl, params)`. Frames of kind `records` go to `RecordStore.adopt/remove` (the store is the only reader); frames of kind `events` (ephemeral: typing, presence — `client-frames.ts:173`) go to the handler and never to the store.
- **Decided:** a new `records` frame kind `{ channel, seq, epoch, adopt?: {[entity]: Row[]}, remove?: {[entity]: string[]} }`; sync protocol version bumps; a client on the old version gets the existing protocol-mismatch close (terminal, `fix:` names the upgrade). `seq`/`epoch` are consumed by slice 10.
- Server side: `ChannelHub` / `SocketRegistry.deliver` (`realtime/src/socket.ts`) — `publishRecords(decl, params, entity, rows)` emits the record frame; keeps `channel_frames_dropped_total` accounting.
- Subscriptions ref-counted per page: N components on one channel = one `subscribe` frame; last release = `unsubscribe`. Reconnect re-sends every wanted channel (`client.ts:158-177` already does this per registration — reuse).
- Authz: channel declaration takes a `policy` (existing primitive) evaluated on subscribe; refusal → the existing close/deny codes, latched per channel.

## Steps
1. Declare `channel()`; register it in the manifest projection so `framework.manifest.json` lists channels (`bun run manifest`).
2. Replace string-topic client API; keep the wire protocol frame names unless a new `records` frame kind is required — if it is, bump the sync protocol version and handle the mismatch close.
3. Writes publish: an action whose output carries records (slice 05 envelope) publishes them on every channel whose declaration lists that entity and whose params match — declared on the channel, derived at the action, never hand-called in a handler (axiom 2).
4. Delete `publish(topic)` on the client (`client.ts:291` sends a `patch` frame from the browser): client writes go through mutators only (axiom 1).

## Tests
- `channel.test.ts`: two `useChannel` on one decl → one subscribe frame; release both → one unsubscribe; reconnect re-subscribes; a `records` frame updates a `useRecord` observer that never subscribed to the channel itself; an `events` frame never touches the store.
- Policy refusal latches that channel only, other channels on the socket keep flowing.
- `bun test packages/realtime/src/channel.test.ts`.

## Done when
- No string topic accepted by any public client API (typecheck proves it).
- Guard `channel-literals` (slice 15) green at zero.
