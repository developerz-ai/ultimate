# 10 — Build vs wrap: adopt battle-tested libraries at the protocol layer

> Part of [`overview.md`](overview.md). Depends on: 02 (fixes the hand-rolled bugs this partially deletes). Tiers: 3 (`jobs`, `realtime`), 4 (`mail`), plus `docs/idea/`.

The rule: **own the integration layer, wrap the protocol layer.** Own what must join the
transaction/context/error machinery (primitives, outbox, entity drivers, the observer seam) or
where a Bun native *is* the implementation (`Bun.SQL`, `Bun.serve`). Wrap where a dominant,
maintained library embodies years of production hardening — queue delivery mechanics, wire-protocol
clients. Rationale: the 02 bug table (worker races, orphaned timeouts, swallowed heartbeats, a
reconnect that never fires) is the cost of re-deriving what battle-tested libraries already fixed;
and AI agents know the dominant libraries' semantics from training — they will never know a
reimplementation as well.

`CLAUDE.md`'s "no new dependencies without a strong reason" stands — this slice *states* the
strong reason and scopes it: dependencies are admissible at the driver/transport seam only, never
in the primitive vocabulary (axiom 1: one `job()` API regardless of what delivers it).

## Work

1. **Decision page** — `docs/idea/18-build-vs-wrap.md`: the criterion as a table (own when: transaction/context/error integration, Bun native exists, API is framework vocabulary; wrap when: wire protocol with a dominant client, hardened delivery mechanics, AI familiarity). Dated `As of 2026-08`. Cross-link from `docs/idea/README.md` and `CLAUDE.md`'s non-negotiables (amend the dependency rule to cite the criterion).
2. **Jobs: verdict is BUILD — decided 2026-08-12.** No BullMQ driver. The pg-backed queue joined to the transactional outbox is a core differentiator (BullMQ cannot join a Postgres transaction, requires Redis, and is Node-centric on a Bun-only stack); a second delivery semantics is a permanent explanation and test burden for marginal gain. The obligation this verdict creates: battle-tested must be *earned* — the 02 worker/scheduler bug list becomes the hardening suite, `.job.test.ts` lands under the job gate (see [`04-tests.md`](04-tests.md)), and a soak test (N workers, kill/restart under load, assert no double-execution and no orphan) joins the live suite. Record the verdict + obligation in the decision page.
3. **NATS: verdict is WRAP — decided 2026-08-12, gated on Bun compatibility.** Replace the hand-rolled wire client (`packages/realtime/src/nats-socket.ts:142`, `nats-connection.ts` — 464 LOC of protocol reimplementation with zero integration benefit) with the official `nats` (nats.js) client behind the existing transport seam (`packages/realtime/src/nats-transport.ts`). Gate: the existing `nats-transport.live.test.ts` + `presence.live.test.ts` suites pass unchanged. If adopted, the 02 fixes for this client's connection lifecycle are deleted rather than applied. If Bun compatibility fails, record the reversal in the decision page and apply the 02 fixes.
4. **SMTP: verdict is BUILD (keep ours) — decided 2026-08-12.** Candidates are Node-centric (nodemailer) and the hand-rolled client is small; keep it, record the verdict in the decision page, and cover it with the 04 test pass. Revisit only if a Bun-native SMTP client emerges.
5. Each adopted dependency: reason stated in the PR per `CLAUDE.md`, pinned version, listed in the decision page's ledger table (library, seam, why, date).

## Tests

- Jobs hardening: the 02 fixes' failing-first tests + `.job.test.ts` (step-replay, idempotency-dedupe, outbox-atomicity) + the kill/restart soak under the live gate.
- NATS swap: `packages/realtime/src/nats-transport.live.test.ts` and `presence.live.test.ts` pass unmodified — the seam holds or the swap is wrong.
- Command: `bun test packages/jobs`, `TEST_NATS_URL=… bun test packages/realtime`.

## Done when

- `docs/idea/18-build-vs-wrap.md` exists, linked, with the criterion, the three verdicts (jobs BUILD, NATS WRAP, SMTP BUILD) and the dependency ledger; `CLAUDE.md` dependency rule cites it.
- Jobs hardening suite green; NATS swap landed with live suites unchanged (or reversal recorded).
- `bun run verify` green.
