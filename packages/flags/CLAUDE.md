# @ultimat3/flags — boundary

Tier 1. May import `@ultimat3/core` and nothing else. Never sideways, never upward.

Tier 1 is the lowest its real imports allow — the same rule that placed `db`. Evaluation needs an
`Actor`, a `Clock` and `UltimateError`, all tier 0. It deliberately does **not** import `entity`,
`query` or `policy`: a store read on the hot path would make `isEnabled()` async, and tier 1 is
what lets `policy` (tier 2) call it from inside a predicate.

| Rule | Detail |
|---|---|
| Exports | `src/index.ts`, explicit, no `export *` |
| Errors | `src/errors.ts`, subclass `UltimateError`, never a bare `Error` |
| Files | one responsibility each, < 200 lines, tests beside the source |

## Invariants

- **`defineFlag()` is a `define*` helper, not a ninth primitive.** A flag has no handler, no input
  schema and no surface of its own, so there is nothing for `primitiveRegistrar` to project. The
  eight kinds in `PRIMITIVE_KINDS` stay eight. A capability that *does* need a handler arrives as a
  factory over an existing primitive — `llm()` returns an `action`.
- **Evaluation is synchronous and allocation-free on the hot path.** It runs inside policy
  predicates and render passes. No `await`, no I/O, no date parsing (`expiresAtMs` is precomputed),
  and the expired-flag error is built lazily so a rate-limited call costs a map lookup.
- **A temporary flag without an expiry must not be declarable.** `FlagExpiryIsMandatory` in
  `flag.ts` is a compile-time assertion: loosen the union and `tsc -b packages/flags` fails on that
  line. `toFlag()` re-checks at runtime for snapshots and JS callers. Do not replace either with a
  lint rule.
- **`X_FLAG_EXPIRED` is reported, never thrown.** A framework that took production down on a date
  nobody remembered setting would teach everyone to declare every flag `permanent`, which is the
  failure this design exists to prevent.
- **The reporter is core's, not this package's.** `reportError({ source: 'process', severity:
  'warning' })` is the one error-monitoring seam; a second one here would be a second place an app
  wires its monitor and a second place to look when a report does not arrive. `runtime.ts` holds
  the framework's ONE `reportError` call site in this package, same rule as the metric recorders.
  Never name a vendor here (axiom 7).
- **The rate limit is keyed on `clock.monotonic()`**, not wall time: an NTP correction or a
  container resuming must not reopen the window and flood the monitor.
- **Buckets are `fnv1a(key + ':' + actorId) % 100`.** Never `Math.random()`, and never the actor id
  alone — hashing the actor by itself puts the same cohort in the first slice of every rollout the
  app ever runs.
- **Allow lists beat the rollout.** An operator who named an actor is not overruled by a hash.
- **An unknown key throws.** Answering `false` is a branch that never runs and never says so.
- `default: true` beside a `rollout` is refused: the two answer the same actors and disagree.

## Open

- Nothing calls `flagsReport()` yet. It is the projection an `x flags [--json]` command and an MCP
  `flags.list` tool should read; neither exists.

## Commands

```
bun test packages/flags
bun run --filter @ultimat3/flags typecheck
```
