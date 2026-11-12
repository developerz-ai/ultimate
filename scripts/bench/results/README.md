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

## Server rendering a big page — `As of 2026-11-10`

One local run (12-core Haswell VM, Bun 1.4.4, `box.runner: local`, other agents' work on the same
box, load average above 7), [`render-html.bench.ts`](../render-html.bench.ts) → [`render-html.json`](render-html.json):
a `<table>` of 50,000 rows, one component and five cells each, through `renderToHtml`. **5.9× a
template string** writing the same markup in the same loop (299.62 ms against 50.51 ms), and the
heap grew by **10.3 MiB** in a fresh process; **10.6 MiB live** at the walk's last row, after a
forced collection (`liveMiB`) — about the 10 MB of output. Core's `escapeHtml` and `safeUrl`
skip their copy when there is nothing to escape or strip; the baseline shares that, so the ratio
does not show it. The walker flattens its output rope every 1,024 fragments: unflattened it held
100.5 MiB live (~3.2M string cells) and its heap figure swung 6.5–100 MiB with GC timing, for
~4.7×. The walker before that (one `async` frame and one `Promise.all` per node) measured ~26× and
~198 MiB on the same page. The regression test holds the ratio (< 12×) and the live set
(< 16 MiB), never a wall-clock figure: [`render-html.bench.test.ts`](../render-html.bench.test.ts).

## One span, the cost every statement pays — `As of 2026-11-09`

One local run (12-core Haswell VM, Bun 1.4.4, `box.runner: local`, other agents' work on the same
box), [`span-overhead.bench.ts`](../span-overhead.bench.ts) → [`span-overhead.json`](span-overhead.json),
median of five 200,000-span loops: an unsampled child span costs **498 ns**, an unsampled root **705 ns**
(target 1,000 ns), and a sampled span with no `span.end` subscriber **1028 ns**. An unsampled span
reads no clock and mints its span id only if something reads it; a root's trace id comes from a 4 KiB
pool filled by one `crypto.getRandomValues` call, each byte handed out once. Before: 1,976 ns, 3,336 ns
and 3,712 ns. The regression test holds the COUNTS (clock reads, random draws, dispatches), never a
wall-clock figure: [`span-overhead.bench.test.ts`](../span-overhead.bench.test.ts).

## The request floor, in-process — `As of 2026-11-11`

One local run (12-core Haswell VM, Bun 1.4.4, `box.runner: local`, load average 17–29 from other
agents' work on the same box), [`http-pipeline.bench.ts`](../http-pipeline.bench.ts) →
[`http-pipeline.json`](http-pipeline.json): `pipeline.handle` with no socket, production config, 64
pooled caller addresses, median of five 30,000-request loops. A public `GET` answering `'ok'` costs
**91.8 µs** and a 404 **132.3 µs**. Before (sweep 2, H1/H2), on the same tree with sweep 1's core changes
already in: 145–181 µs and 113–155 µs over three runs — on a box this loaded the spread is wider than
the change, so read the two as one order of magnitude. An interleaved A/B of the slice alone put the 404
~14% lower (no stack render) and the `GET` within noise. The regression test holds the COUNTS —
`AbortSignal.any` calls, `URLSearchParams` builds, `Set`s, entry arrays, header writes, stack reads —
never a wall-clock figure: [`http-pipeline.bench.test.ts`](../http-pipeline.bench.test.ts).

## The scale ladder, measured — `As of 2026-11-09`

Four benches for [`docs/idea/17-scale-ladder.md`](../../../docs/idea/17-scale-ladder.md) (plan 101
slice 22). One local run each on a 12-core box (Intel Haswell, 46 GB, Bun 1.4.4, `box.runner:
local`) that eleven other agents were loading at the same time — load average ~11.6 on 12 cores —
so read every figure as one busy machine's order of magnitude, never as a ceiling. Not yet in
`bench.yml`: each needs a service (Postgres, NATS, a Docker daemon) the weekly job does not start.

**Worker throughput** ([`worker-throughput.bench.ts`](../worker-throughput.bench.ts),
[`worker-throughput.json`](worker-throughput.json)): no-op jobs on the test Postgres, each worker
its own `bun` process running the stock `jobWorker`, elapsed on the server's clock from the first
enqueue to the last ack. With the shipped defaults (8 slots, a pass every 250 ms): 799 claims/s at
1 worker, 1,618 at 4, 2,277 at 16 (As of 2026-11-09). Until that day the defaults read 31 / 124 /
492 — exactly 8 jobs a pass, 4 passes a second: a pass that found work waited the whole floor and a
freed slot could not cut it short. A pass whose every claimed row STARTED now marks a backlog, and the next
freed slot claims at once (`worker-loop.ts`); the floor is the idle poll only. With the tuned
profile (32 slots, a pass every 10 ms): 1,709 claims/s at 1 worker, 3,724 at 4, 3,042 at 16 — the
queue, one Postgres on a shared box, stops scaling between 4 and 16
workers. That plateau is the figure to compare against a Redis or NATS queue, not the defaults.

**Cross-node fan-out** ([`fanout-3-nodes.bench.ts`](../fanout-3-nodes.bench.ts),
[`fanout-3-nodes.json`](fanout-3-nodes.json)): **10,000 subscribers across 3 `sync` nodes**, each
node its own process on its own connection to a nats-server 2.15, one events-channel topic, a
fourth process publishing 20 probes 250 ms apart: **200,000 of 200,000 deliveries**, p50 4.32 ms, p99 23.26 ms, max 31.45 ms, publish to the socket's `send`. The sockets are in-process
`WsLike`s, not WebSockets: this times the bus and the node's fan-out, and the restart bench above
is the real-socket figure. 10,000 is the plan's count, not this box's ceiling.

**Module load against file count** ([`boot-vs-files.bench.ts`](../boot-vs-files.bench.ts),
[`boot-vs-files.json`](boot-vs-files.json)): a synthetic app of `entity()` modules, every tenth
importing the one before, imported cold in a fresh process, median of 3. 500 modules: serial 804
ms, batched 393 ms. 5,000 modules: serial 3,258 ms, batched 1,259 ms — `importInOrder`'s 256-module
batches against one `await import()` per file. Entity files only: the plan's 5,073-file app also
carried routes, islands and actions, and measured ~5 ms a file serially.

**The production image** ([`http-prod-image.bench.ts`](../http-prod-image.bench.ts),
[`http-prod-image.json`](http-prod-image.json)): a fresh scaffold built by `x build --target
docker` and deployed by `x deploy` on its own `docker-compose.prod.yml`
(`docker/deploy-proof/compose.sh` with `KEEP_STACK=1`), the read bucket raised as `bench.yml` does,
`/` for 30 s at concurrency 16 per pod, every answer 2xx. One `web` pod: **1,439 req/s**, p50 9.4 ms, p99 38.09 ms — 5.4× the 267 req/s `x dev` served above. Three pods on the same host: 1,196 req/s in sum, p99 203.89 ms: on one saturated box three pods and the load generator
share the same cores, so this is **not** a horizontal-scaling figure, and none is claimed. A clean
1-vs-3 comparison needs pods on separate hosts.

**The large app, booted whole** ([`boot-large-app.bench.ts`](../boot-large-app.bench.ts),
[`boot-large-app.json`](boot-large-app.json)), `As of 2026-11-10`: the plan's 5k-file done-when,
timed end to end rather than as module load. The app is `examples/dummy` as committed at `HEAD`
(`git archive`) plus 150 generated resources, **5,124 TypeScript files** — every one made by the
real `x g resource` (entity, policy, actions, live query, job, page, island, their tests): 168
entities, 347 actions, 164 queries, 182 jobs, 218 routes, 159 islands. The framework is the
working tree that ran it. One local run, 12-core Haswell VM, Bun 1.4.4, other agents' work on the
box (load average 3.7 at the start, 4.1 at the end); median of 3 boots each, wall clock from spawn
to the first 200 on `/`, peak RSS summed over the process group.

| Boot | Target | Median | Peak RSS | Verdict |
|---|---|---|---|---|
| `x dev`, a restart (`.x/` kept) | < 10 s | 5,686 ms | 643 MiB | met |
| `x dev`, a fresh clone (`.x/` deleted: embedded Postgres made and migrated, no island cache) | — | 29,321 ms | 1,811 MiB | — |
| `web` pod from the prebuilt registry | < 3 s | 2,407 ms | 240 MiB | met |
| the same pod with the registry moved aside (it scans) | — | 3,310 ms | 244 MiB | — |

`x dev` to the first 200 on `/`: **5.7 s** on a restart, and with `.x/` deleted first 29.3 s.
The restart was 21.1 s on the first run of this bench, the same day: the island build was ~12–18 s
of it — 159 islands, one `Bun.build` per route group, nearly every island its own
(`packages/cli/src/island-bundle.ts`). Two changes since: the boot builds the islands beside the
app load instead of after it (`dev-rebuild.ts` `buildGeneration`; 21.0 s → 18.9 s alone), and each
route group's build is cached under `.x/cache/islands/`, keyed by its sources, which took the
islands from ~14.6 s to ~0.4 s on a restart. Since then the cache key gained Sass partials,
per-input directory digests, the tsconfig and `package.json` environment and per-chunk code
hashes: 5.2 s → 5.7 s, inside the box's noise. A fresh clone has no `.x/`, so it builds every island
and creates and migrates the embedded Postgres: the fresh-clone figure is not under 10 s, and the
plan's target is the restart's. A busier run of the same tree (load 18–27 by its pod phase)
measured 7.8 s, 45.2 s and a 3.2 s pod — the box, not the code, as the run above shows.

A `web` pod from the prebuilt registry: **2.4 s**, after `x build --target prebuilt` (the
Dockerfile's `RUN`, 13.1 s once per image). The registry moved aside, so the role scans: 3.3 s. On
the host, not in a container: the entry the image runs (`bun apps/web/server.ts`, `ROLE=web`,
`NODE_ENV=production`, `x env init --production`'s secrets, the image's prebuilt store, a real
Postgres migrated by `ROLE=migrate`), without the container's own start-up. Re-run:
`bun run scripts/bench/boot-large-app.bench.ts --out scripts/bench/results/boot-large-app.json`
with the test services up (`--keep` leaves the app under `.x/bench-large-app/`, `--reuse` boots it
again).
