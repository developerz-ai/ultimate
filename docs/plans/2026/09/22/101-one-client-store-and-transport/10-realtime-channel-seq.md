# 10 — Channel sequence and gap repair

> Part of [`overview.md`](overview.md). Depends on: 09. Tier: 3.

Today a channel topic "has no cursor and no re-snapshot", so a frame `SyncSocket.send` drops under backpressure is "unrepairable, not uncounted" (root `CLAUDE.md`, realtime section; `packages/realtime/src/socket.ts` `SocketRegistry.deliver`). Once channels write the store, a lost frame is a wrong record shown in every place. The server owns the gap verdict; the client never guesses from holes.

## Files to change
- Server `ChannelHub` (`packages/realtime/src/channel.ts`) — per channel: monotonically increasing `seq` and an `epoch` (new on node restart / hub reset). When `deliver` drops a `records` frame for a socket, mark that (socket, channel) as gapped and send a `replay-gap { channel, epoch }` frame as soon as the socket drains — the drop is now counted **and** repaired.
- `packages/realtime/src/channel-cursor.ts` (new, client) — one cursor per subscribed channel: drop `seq <= last` (duplicate), accept `seq > last` (a numeric hole is NOT a gap — only `replay-gap` is), reset on new `epoch`. Cursor dropped when the channel is released.
- Catch-up: `replay-gap` or an epoch change → re-run that channel's **catch-up read**: the channel declaration names a query (`channel(name, { catchUp: queryRef })`, slice 09) dispatched through `clientTransport`; records adopted; buffer frames arriving meanwhile, apply those with `seq` after the read.
- Resubscribe after reconnect sends `since: seq` per channel; the server replays from a bounded per-channel ring or answers `replay-gap` when `since` is out of the ring.
- Metrics: `channel_replay_gaps_total (renamed from `channel_gaps_repaired_total` before release: it counts gaps announced)`, beside `channel_frames_dropped_total`.

## Steps
1. Server seq/epoch + ring + `replay-gap`.
2. Client cursor + catch-up.
3. Update `scripts/bench/restart-bench-seq.ts` to assert **zero unrepaired** gaps (today it counts holes as a lower bound).

## Tests
- `channel-seq.test.ts`: duplicate dropped; epoch reset accepted; forced backpressure drop → `replay-gap` → catch-up read → store correct; reconnect with `since` inside the ring replays, outside it catches up.
- Concurrency: frames during catch-up applied once, in order (`channel-concurrency.test.ts` extended).

## Done when
- A frame deliberately dropped in a test ends with the store equal to the server's rows.
