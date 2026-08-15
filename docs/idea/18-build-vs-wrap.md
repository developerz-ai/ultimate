# Build vs wrap

**As of 2026-08.** The criterion for when the framework owns an implementation outright versus
wraps a third-party library at a seam — and the verdicts it has produced so far.

## The criterion

Two layers, never blurred:

- **Integration layer** — the code that joins a primitive to the framework's own machinery:
  transactions, `ctx`, the error contract, the observer seam, the outbox. This is where "one way
  to do each thing" (axiom 1) lives, and it is never delegated.
- **Protocol layer** — a wire format or delivery mechanic that a dominant, maintained library
  already implements correctly: retry backoff, framing, reconnect/heartbeat state machines,
  cluster topology. Re-deriving this is where the framework's own bugs have come from.

| Own it when | Wrap it when |
|---|---|
| The code must join the transaction/context/error machinery (a primitive, the outbox, an entity driver, the observer seam) | A dominant, maintained library embodies years of production hardening on the wire protocol |
| A Bun native already **is** the implementation (`Bun.SQL`, `Bun.serve`) | No Bun native exists and the library is the ecosystem default |
| The surface is framework vocabulary — an `entity`/`policy`/`action`/`mutator`/`query`/`job`/`route`/`task` API a caller writes against | The dependency sits at the driver/transport seam only, never in the vocabulary a caller writes against |
| AI agents would have to learn a bespoke reimplementation from this repo alone | AI agents already know the dominant library's semantics from training data |

`CLAUDE.md`'s "no new dependencies without a strong reason" is not relaxed by this page — it is
scoped by it. A dependency earns its place only at the driver/transport seam, pinned, with the
reason stated in the PR that adds it. It never enters the primitive vocabulary: callers still
write one `job()`, one `query()`, one channel API, regardless of what delivers it underneath.

Rationale: the framework's own audit (worker races, an orphaned timeout, a swallowed heartbeat, a
reconnect that never fires — `docs/plans/2026/08/12/101-framework-audit-raii-batching-nplusone/02-bugs-upper.md`)
is the cost of re-deriving what battle-tested libraries already fixed. Choosing BUILD is not free —
it is an obligation to make the hand-rolled code as hardened as the library it declined, proven by
tests that would have caught the audit's bug list.

## Verdicts

### Jobs — BUILD, decided 2026-08-12

No BullMQ driver. The pg-backed queue joined to the transactional outbox is the differentiator:
BullMQ cannot join a Postgres transaction, requires Redis, and is Node-centric on a Bun-only
stack. A second delivery semantics alongside it would be a permanent explanation and test burden
for marginal gain — it fails the "own it when" column on the first row (outbox integration) and
the dependency does nothing a Bun-only stack needs.

**The obligation this verdict creates:** battle-tested must be *earned*, not assumed. PR 13
(`docs/plans/2026/08/12/101-framework-audit-raii-batching-nplusone/10-build-vs-wrap.md`) turned the
02 audit's worker/scheduler bug list — a leaked shutdown hook per `start()`, `stop()` racing a live
tick, a timed-out job left running after its lease is nacked, a heartbeat failure swallowed instead
of surfaced, a scheduler tick with no re-entrancy guard — into a hardening pass, added
`packages/jobs`'s first `*.job.test.ts` suite (step-replay, idempotency-dedupe, outbox-atomicity),
and added a kill/restart soak under the live gate asserting no double-execution and no orphan.

### SMTP — BUILD, decided 2026-08-12

Candidates (nodemailer) are Node-centric, not Bun-native, and the hand-rolled client is small.
Keeping it costs less than adopting and adapting a Node-shaped library on a Bun-only stack; the
protocol-layer case for wrapping doesn't clear the bar here the way it does for a stateful,
multiplexed wire protocol like NATS. Covered by the framework's test pass
(`docs/plans/2026/08/12/101-framework-audit-raii-batching-nplusone/04-tests.md`). Revisit only if a
Bun-native SMTP client emerges.

### NATS — WRAP, decided 2026-08-12, **adopted `As of 2026-08`**

`nats-protocol.ts`, `nats-commands.ts`, `nats-socket.ts` and `nats-connection.ts` were 1,019 LOC of
hand-rolled wire protocol with zero integration benefit — the transport seam
(`packages/realtime/src/nats-transport.ts`, `fanout.ts`'s `Transport` interface) already isolated
NATS from the rest of `realtime`, so nothing about connection lifecycle needed to live inside the
framework. They are deleted, with their tests, their connection fixture and the 431-line wire-level
fake. The official `nats` (nats.js) client sits behind that unchanged seam.

**Gate: passed, 2026-08-14.** The Bun-compatibility condition the verdict was gated on, exercised
through the library on **Bun 1.3 against a real nats-server 2.11.17**:

| Proven through the library | Why it was the gate |
|---|---|
| connect, core publish/subscribe | the fanout path; a Bun socket the library dials itself |
| the JetStream API | the presence bucket is created and read over it |
| per-message TTL (`Nats-TTL`) | presence expires on the server's clock; without it a dead node's members are never announced gone |
| batch direct get (`multi_last`) | a room is listed in one round trip, not one read per member |

What landed, layer by layer:

| Layer | After the swap |
|---|---|
| the port | `nats-client.ts` — publish, subscribe, request, requestMany, close, version, connected, and nothing else. Plus `parseNatsUrl`: the library takes `host:port` with credentials as options and never reads a URL's userinfo, so URL parsing stays ours |
| the adapter | `nats-lib-client.ts` — the only file in the repo that imports `nats` |
| the fake | `nats-fake.ts`, rewritten as an in-memory bus implementing the port: server semantics, not wire bytes. Multi-node fanout is still provable under the sealed-network preload |
| the seam | **unchanged** — `Transport` in `fanout.ts`, `NatsTransport` and its options, `selectTransport` in `transport-env.ts` |
| reconnect | the library's. The hand-rolled dial/rebind/loss-recovery bookkeeping is deleted rather than fixed, so the 02 audit's connection-lifecycle findings for this client are moot; the thundering-herd jitter is kept and handed over as the library's `reconnectDelayHandler` — the herd is ours to spread |
| the test seam | one level up: an injected client (`connect?: NatsConnect`) instead of an injected byte stream (`open: (target) => Promise<NatsStream>`), on `NatsTransportOptions` and on `selectTransport`'s options |

**What the wrap did not take: the library's KV abstraction.** `nats-jetstream.ts` (the bucket's
stream and the direct reads) and `nats-kv.ts` (`TransportSet` over it) stay ours, retyped onto the
port and unchanged in responsibility. This version of the library's KV cannot express a per-message
TTL (`Nats-TTL`) or a batch `multi_last` direct get — the two 2.11 features that make presence
expire on the server's clock and list a room in one round trip. Consistent with the criterion: the
wrap takes the wire, not the semantics presence is built on.

The verdict in one line: 1,019 LOC of protocol with zero integration benefit, and an agent knows the
dominant client's semantics from training data but can never know a reimplementation.

## Dependency ledger

Every dependency admitted at a driver/transport seam under this criterion, in one place.

| Library | Version | Seam | Why | Pinned since |
|---|---|---|---|---|
| `nats` (nats.js) | `2.29.3`, exact — no caret | `@ultimat3/realtime`'s bus port (`nats-client.ts`), imported by `nats-lib-client.ts` and nothing else | the NATS wire protocol, framing, PING/PONG, the TLS upgrade and the reconnect state machine — 1,019 LOC of ours deleted for it | 2026-08-14 |

`nats` is the **first external runtime dependency any `@ultimat3/*` package has taken**, `As of
2026-08`. It brings two transitive packages, `nkeys.js` and `tweetnacl` — no native addon in either,
so the "no native addons in the dependency graph" property holds.

A row is added only when the dependency lands, with the actual pinned version. This table is the
single source for "what did we decide to depend on and why" — a package `CLAUDE.md` states its own
import boundary and links back here rather than restating the argument, and the changelog names the
version and nothing more.

### Approved, not yet landed

A verdict is not a dependency. A WRAP verdict with no row in the ledger belongs here — the row is
written when the code lands, not when the argument is won.

| Library | Verdict | Gate | Tracked by |
|---|---|---|---|
| _(none)_ | | | |
