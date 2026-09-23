# 06 — Audited queries

> Part of [`overview.md`](overview.md). Depends on: 01 (audit types in core). Tier: 3.

Rule: a read that must leave a trace declares `audit: true`, exactly like an action. It writes to
the same one sink. The query still never writes: the sink is framework observability, like the
span at `packages/query/src/read.ts:141-157`, not the query's own effect.

Without this, an app turns every personal-data read into an action (`view*`, `list*`), which is a
real downstream workaround. That loses `live`, caching and the `/_x/query` projection, and it
splits one concept across two primitives.

## Files to change
- `packages/query/src/query.ts` — `readonly audit?: boolean` on the query definition, published as `audited` on the descriptor, following `action/src/action.ts:119,183-187,352`.
- `packages/query/src/read.ts:134-157` (`readRows`) — when `audited`:
  - after the policy gate, call `auditSettled(getAuditSink(), record)` with `kind: 'query'`, `name`, `surface`, `ctx`, `input`, `outcome: 'allowed'`, and `rows: n` (a count, never rows);
  - on a policy denial or a thrown read, record `'denied'` or `'failed'` through the same helpers.

  Move `auditSettled`/`auditThrew`/`auditOutcomeFor`/`auditFailureFor` (`action/src/audit-gate.ts:17-90`) to `packages/core/src/audit-gate.ts` next to slice 01's types, so both packages call one implementation.
- **Live queries**: audit the subscription start and each re-snapshot sent to the client, never each patch. Document this. A per-patch record is unbounded, and the subscription is the read the actor asked for.
- **Cached reads**: audit even on a cache or memo hit, because the audited fact is "this actor read this", not "the database was hit". Place the call outside `readOnce`/`readThrough` (`read.ts:188-196`).
- A sink that throws on an audited read fails the read (`audit.sink.failed`, `audit-gate.ts:77-90`). This matches the action rule: an unaudited personal-data read is the failure the flag exists to prevent.
- `packages/query/README.md`, `wiki/Queries-And-Live-Queries.md:3` — the first line becomes "A `query` is a read … never writes (an `audit: true` query reaches the audit sink, which is the framework's, not the query's)".
- `packages/mcp/src/projectable.ts` — nothing to change. MCP-projected queries go through `sourceFor`/`readRows`, so they are audited for free. Assert this with a test.

## Steps
1. Move the gate helpers to core and re-point action's imports. The action tests must stay green unchanged.
2. Add the `audit` option, then the allowed, denied and failed paths, then live and cache placement.

## Tests
- `bun test packages/query/src/read.test.ts packages/query/src/live.test.ts packages/action/src/audit.test.ts`.
- An audited query writes one record per call, including on a memo hit. A policy denial records `denied`.
- A live subscription records one entry on subscribe and none per patch.
- A sink that throws turns the read into an error.
- An MCP `tools/call` of an audited query records `surface: 'mcp'`.

## Done when
- `query({ audit: true })` and `action({ audit: true })` reach one `setAuditSink` sink with one record shape, `kind`-discriminated.
