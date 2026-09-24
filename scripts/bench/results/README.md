# Realtime restart benchmarks — what the committed results measured

The prose `scripts/bench-claims.ts` holds equal to the JSON beside it (`X_BENCH_CLAIM_STALE`). Moved out of the root `CLAUDE.md` on 2026-09-23 (plan 101, slice 17 f).

Realtime capacity is **measured on one node, in two halves that answer different questions**.

**Reachability, 50,000 clients:** real WebSocket clients against a single `sync` node over
`InProcessTransport`, `SIGKILL`ed with no drain. All 50,000 reconnected; **49,981** received a
channel patch inside the window, p50 54.0s / p90 105.5s / max 145.7s; 156,851 connect attempts shed
by the `AcceptBudget` before any query or snapshot path. That figure times **first delivery on the
reconnected socket** — reconnect *and* resubscribe *and* one patch. It was labelled
"time-to-consistent" until 2026-08 and never measured consistency: the harness recorded
`lastSeenSeq` and read it nowhere, so a patch the node dropped was invisible to it by construction.
The timings are unchanged and still stand; only the name was wrong.

**Delivery, 10,000 clients:** the same harness, now counting holes in the probe sequence each client
receives, per connection ([`scripts/bench/restart-bench-seq.ts`](../restart-bench-seq.ts)).
10,000 clients, a probe every 200ms, all 10,000 reconnected: **1,666,882 patches received, 0 observed
sequence gaps** — no gap, no duplicate, no rewind on any client. A **lower bound**, not a proof of
zero loss: a hole is only visible between two frames one connection received, so anything lost before
a connection's first message or after its last is invisible, as is a connection that received nothing.

**Channel gap repair is built, and not yet measured**, `As of 2026-09-22` (21.0.0).
This paragraph said a frame `SyncSocket.send` drops under backpressure was "unrepairable, not
uncounted"; that is no longer true of a `records` frame.
- **Server.** `SocketRegistry.deliver` ([`packages/realtime/src/socket.ts`](../../../packages/realtime/src/socket.ts))
  counts a dropped frame in `channel_frames_dropped_total`, logs `channel.frames_dropped`, and marks a
  dropped **`records`** frame as a gap on that (socket, topic). Once the socket drains it sends one
  `replay-gap` frame (`channel-gaps.ts`), counted in `channel_replay_gaps_total`. That series counts
  gaps **announced**, by design: a node can count what it said, never what a browser did about it.
  A dropped `events` frame is ephemeral and is only counted.
- **Client.** `client-channels.ts` keeps a cursor per channel, and on `replay-gap` or a new epoch
  re-runs the channel's `catchUp` query, holding the frames that arrive meanwhile.
- **Repair is not yet measured at any scale.** The 10,000-client run above predates all of it, and
  its sequence check is still the only evidence that a run had no holes.

`As of 2026-08` the 10,000-client run is the only one with delivery accounting. The 50,000-client
result predates the counter and carries no delivery number at all.

**Both figures were measured on the 30 s server curve.** The bench client redialled on
`backoffDelay`'s default, `defaultBackoff` (full jitter, 30 s cap). As of 21.0.0 it reconnects on
`browserBackoff` (equal jitter, 4 s cap, `scripts/bench/restart-bench-client.ts`), as a browser now
does. A new run is not directly comparable, and the figures above stand only for what they
measured.

Per-node recovery in both: neither run crossed NATS and neither subscribes to a live query, so no
cursor, snapshot or gap-repair path is under test. Not a multi-node result and not a throughput
figure. [`scripts/bench/restart-bench.ts`](../restart-bench.ts), results committed under
[`scripts/bench/results/`](./).
