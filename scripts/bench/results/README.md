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

## A stranger's first hour, and requests per second — `As of 2026-11-06`

One local run on an 8-core laptop (Intel i7-10610U, Bun 1.4.4, `box.runner: local`), **not yet a CI
figure**: `.github/workflows/bench.yml` re-measures five runs on `ubuntu-latest` weekly and opens a
pull request. Other work was running on the same box, so read these as one machine's order of
magnitude, never as a ceiling.

**First hour** ([`first-hour.ts`](../first-hour.ts), [`first-hour.json`](first-hour.json)): the
published `create-ultimate@latest` — `29.4.0` that day (`npm view create-ultimate version`) — under
a clean `HOME` and `BUN_INSTALL`. Scaffold 4.7s, `bun run setup` 43.3s with a cold Bun cache, leaving
165 MB of `node_modules` across 106 installed packages and 261 app files. **The first
`bun run verify` was red** on 29.4.0: `budgets` reported `X_BUDGET_UNMEASURED` because nothing had
built yet — the step builds first since plan 101's slice 21, which 29.4.0 predates — so the run
records `verify` as failed and every later step as skipped, with no time.

**Requests per second** ([`http-hello.ts`](../http-hello.ts)): that scaffold under `x dev` — every
role in one process, embedded Postgres, a development server and not the production image —
loaded by one client at concurrency 16, three 30 s runs back to back, every answer 2xx. The
scaffold's read bucket was raised for the run in its own `apps/web/app/http.ts` (the shipped one
answers a single client 429 past a 120-request burst, and a 429 is `X_BENCH_RUN_FAILED`). `/`
([`http-hello.json`](http-hello.json)): median 267 req/s, p50 45.74 ms, p99 181.85 ms; cold start
to the first 2xx 4.8s, 542 MiB resident across the process group. A typed read through the whole
pipeline, `/_x/query/post-list?limit=10` ([`http-hello-query.json`](http-hello-query.json)): median
183 req/s, p50 60.36 ms, p99 258.26 ms.

**Live-query fan-out, unrelated tables** ([`realtime-fanout.bench.ts`](../realtime-fanout.bench.ts)),
`As of 2026-11-09`: 10,000 windows reading `posts`, 5,000 changes on `comments`, in process. Before
the registry indexed windows by table, 34.6 ms per change (29/s); after, 0.13 ms (7,868/s) — one
machine, no committed JSON, so unchecked by `bench-claims.ts`. `realtime-fanout.bench.test.ts` holds
the shape instead: 20× the windows stays under 8× the cost.

## Server rendering a big page — `As of 2026-11-09`

One local run (12-core Haswell VM, Bun 1.4.4, `box.runner: local`, other agents' work on the same
box, load average above 10), [`render-html.bench.ts`](../render-html.bench.ts) → [`render-html.json`](render-html.json):
a `<table>` of 50,000 rows, one component and five cells each, through `renderToHtml`. **4.7× a
template string** writing the same markup in the same loop (240.82 ms against 51.61 ms), and the
heap grew by **49.9 MiB** in a fresh process — about 29 MiB of it the page's own JSX tree. Core's `escapeHtml` and `safeUrl`
skip their copy when there is nothing to escape or strip; the baseline shares that, so the ratio
does not show it. The walker it replaced (one `async` frame and one `Promise.all` per node) measured ~26× and ~198 MiB
on the same page. The regression test holds the ratio (< 12×) and the heap (< 100 MiB), never a
wall-clock figure: [`render-html.bench.test.ts`](../render-html.bench.test.ts).

## One span, the cost every statement pays — `As of 2026-11-09`

One local run (12-core Haswell VM, Bun 1.4.4, `box.runner: local`, other agents' work on the same
box), [`span-overhead.bench.ts`](../span-overhead.bench.ts) → [`span-overhead.json`](span-overhead.json),
median of five 200,000-span loops: an unsampled child span costs **498 ns**, an unsampled root **705 ns**
(target 1,000 ns), and a sampled span with no `span.end` subscriber **1028 ns**. An unsampled span
reads no clock and mints its span id only if something reads it; a root's trace id comes from a 4 KiB
pool filled by one `crypto.getRandomValues` call, each byte handed out once. Before: 1,976 ns, 3,336 ns
and 3,712 ns. The regression test holds the COUNTS (clock reads, random draws, dispatches), never a
wall-clock figure: [`span-overhead.bench.test.ts`](../span-overhead.bench.test.ts).
