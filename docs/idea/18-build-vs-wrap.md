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

### NATS — WRAP, decided 2026-08-12, pending PR 21

`packages/realtime/src/nats-socket.ts` and `nats-connection.ts` are 464 LOC of hand-rolled wire
protocol with zero integration benefit — the transport seam (`packages/realtime/src/nats-transport.ts`,
`fanout.ts`'s `Transport` interface) already isolates NATS from the rest of `realtime`, so nothing
about connection lifecycle needs to live inside the framework. Verdict: replace it with the
official `nats` (nats.js) client behind that existing seam, gated on Bun compatibility.

**Gate:** `packages/realtime/src/nats-transport.live.test.ts` and `presence.live.test.ts` must pass
**unmodified and actually running** (not `describe.skipIf`-skipped on a missing `TEST_NATS_URL`) —
today's ~1.4k LOC of protocol code is validated only against the fake it was co-written with, so a
green run against the fake proves nothing about a swap. If adopted, the 02 audit's fixes for this
client's connection lifecycle are deleted rather than applied, since the library owns that state
machine now. **If Bun compatibility fails, the reversal is recorded in this section** and the 02
lifecycle fixes are applied to the hand-rolled client instead of the swap.

Status: **pending** — PR 21 in the audit plan has not landed. This page will be updated with the
outcome (swap landed, or reversal + fixes applied) once it does.

## Dependency ledger

Every dependency admitted at a driver/transport seam under this criterion, in one place.

| Library | Seam | Why | Pinned since |
|---|---|---|---|
| `nats` (nats.js) | `packages/realtime/src/nats-transport.ts` | Official client for the NATS wire protocol; replaces 1,402 LOC of hand-rolled framing/connection/JetStream/KV protocol code behind the existing `Transport` seam — pending PR 21, not yet landed | pending |

A row is added only when the dependency lands, with the actual pinned version and PR. This table
is the single source for "what did we decide to depend on and why" — it is not restated in
package `CLAUDE.md` files or the changelog beyond a link back here.
