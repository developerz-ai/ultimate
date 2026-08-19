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
| Subjects | `src/subject.ts` — one resolver; never a second allow list per record kind |
| Validation | `src/targeting-assert.ts` — every declaration-time refusal. `targeting.ts` stays the evaluation path |

## Invariants

- **`defineFlag()` is a `define*` helper, not a ninth primitive.** A flag has no handler, no input
  schema and no surface of its own, so there is nothing for `primitiveRegistrar` to project. The
  eight kinds in `PRIMITIVE_KINDS` stay eight. A capability that *does* need a handler arrives as a
  factory over an existing primitive — `llm()` returns an `action`.
- **Evaluation is synchronous, and allocates nothing per declared subject kind.** It runs inside
  policy predicates and render passes. No `await`, no I/O, no date parsing (`expiresAtMs` is
  precomputed), and the expired-flag error is built lazily so a rate-limited call costs a map
  lookup. It is **not literally allocation-free** — `roles` allocates a closure for `some()`, and
  `subjectIdOf` takes an options object — so do not restate that stronger claim. What is
  guaranteed: no `Object.entries`/`Object.keys` pass, no normalisation pass, and nothing at all
  allocated for a flag declaring no subject axis.
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
- **Buckets are `fnv1a(key + ':' + subjectId) % 100`.** Never `Math.random()`, and never the
  subject id alone — hashing the subject by itself puts the same cohort in the first slice of every
  rollout the app ever runs. **The assignments are pinned in `bucket.test.ts`**: a rollout already
  live is a promise to the subjects inside it, so changing the hash must break that test, never
  move the boundary silently.
- **A flag decides about a SUBJECT, and the actor is one kind of subject.** `subject.ts` owns the
  resolution. `actor` and `org` come off the `Actor`; every other kind comes from the `subjects`
  argument at the call site. `actors` and `orgs` in targeting are shorthands for the first two
  kinds, not separate mechanisms — do not add a fourth parallel allow list for a new record kind,
  it already works through `subjects`. `roles` is NOT a subject: a role is a predicate over the
  actor, has no id, and cannot bucket.
- **One source per kind.** A built-in kind is never read from the call-site map, so there is no
  precedence rule and no second place a tenant comes from. Passing `org` at a call site is dead
  data; with no `actor.orgId` the evaluation raises and the fix line says to mint the actor.
  `assertTargeting` refuses `subjects.actor` / `subjects.org` for the same reason.
- **The kind space is open, like the flag key space.** No registry of kinds: a typo raises
  `X_FLAG_SUBJECT_REQUIRED` at the first evaluation, the same loud failure `X_FLAG_UNKNOWN` already
  gives an undeclared key. Do not add a `defineSubjectKinds()` — it is a second declaration surface
  buying a check evaluation already makes.
- **Allow lists beat the rollout.** An operator who named a subject is not overruled by a hash.
  `actors`, `roles`, `orgs` and `subjects` are one rank — any hit is `true`, so their order is
  unobservable. That is the same OR Flipper applies across the actors passed to one `enabled?`.
- **The subject axis throws rather than degrades.** A kind the evaluation context does not carry
  raises `X_FLAG_SUBJECT_REQUIRED`. Never fall back to the actor axis or to `default`: an answer
  about a record computed from whoever was calling looks like it worked, which is the whole bug
  class. **Every declared kind is resolved before any branch answers** — allow lists included — so
  the raise depends only on the flag and the context, never on declaration order and never on which
  list happened to match. An early `return true` on an allow-list hit is the regression to watch
  for: it hides a missing record from exactly the callers who are on the list. A `null` actor is
  the one exception and still gets `default` — no evaluation context at all, every such call
  answers alike, so no single subject is split.
- **`bucketBy` defaults to `actor`.** The subject axes are opt-in; a flag declared before they
  existed must answer identically, which is why the default is not `org`.
- **Subject lookups are own-property only.** `subjects[kind]` goes through `Object.hasOwn` and a
  `typeof` re-check, so a kind named `toString` or `constructor` is absent rather than resolving to
  an inherited function, and a non-string id never reaches `bucketOf`. Same rule for the targeting
  map, which is why the loop is `for…in` + `Object.hasOwn` and not `Object.entries`.
- **Every app-supplied string in a `fix:` goes through `JSON.stringify`, and a subject kind becomes
  a computed key.** A `bank-integration` kind is not a valid identifier, so `{ bank-integration: … }`
  would be a fix that does not parse — axiom 4 wants an instruction that runs. Pinned by
  `errors.test.ts` running the generated snippet through `new Function`.
- **An unknown key throws.** Answering `false` is a branch that never runs and never says so.
- `default: true` beside a `rollout` is refused: the two answer the same actors and disagree.
- **`assertTargeting` establishes the argument is an OBJECT before reading a field, and every one
  of the four lists goes through the same check** (`As of 2026-08`). It destructured first, so
  `applyFlagSnapshot({ 'billing.new': null })` was a bare `TypeError` and `{ 'billing.new': 'off' }`
  was ACCEPTED — `default`, `actors`, `rollout` and `subjects` are all `undefined` on a string.
  `default` was the one required field with no shape check while `rollout` got `Number.isInteger`,
  so `{}` answered `undefined` and `{ default: 'yes' }` answered `"yes"` through a declared
  `boolean` return, silently changing the meaning of every `=== true` / `=== false` call site. And
  the `Array.isArray` rule reached `subjects` only, while CLAUDE.md called the four lists one rank:
  `actors: 'user_100'` matched by SUBSTRING (`isEnabled` answered `true` for `user_1`, `user_10`,
  `ser_10` and `u`), `orgs` the same, and a non-array `roles` reached `.some()` as a bare
  `TypeError` out of a path this file documents as pure and synchronous — inside a policy predicate.
  `renderGiven` from `errors.ts` renders every rejected value; never `JSON.stringify` directly, for
  the reason that file states.
- **A temporary flag's `expiresAt` must carry no ambient zone** (`As of 2026-08`). `Date.parse`
  alone honoured the PROCESS's zone for a clock-time form: `'2026-12-01T00:00:00'` measured as
  1796083200000 in UTC, 1796101200000 in America/New_York and 1796050800000 in Asia/Tokyo — fourteen
  hours of spread across a fleet, so `X_FLAG_EXPIRED` started on a different DAY on different pods,
  against a comment claiming the opposite. `flag.ts` carries a local `CLOCK_TIME`/`UTC_OFFSET` pair
  mirroring `@ultimat3/time`'s `fromIso`, restated rather than imported because this package is tier
  1 and may import `@ultimat3/core` only. `scripts/test-setup.ts` pins the runner to UTC, so the
  failure is invisible in process by construction and `flag.test.ts` spawns a `TZ=` subprocess per
  zone — the same reason `packages/time/src/plain-date.test.ts` does.
- **`configureFlags` clears the report watermarks when it swaps the clock, and only then.** A
  monotonic reading is meaningful only against the clock that produced it: a process that reported
  at monotonic 10,000,000 and then took a clock starting at 0 computed `now - previous` as
  -10,000,000, below every interval, so that key could never report again — on a frozen test clock,
  never. `resetFlagReporting()` always did this; `configureFlags` is what apps and test kits call.
  An interval change re-reads the SAME clock and must NOT clear, or the rate limit becomes a
  suggestion one configure call can bypass.

## Open

- Nothing calls `flagsReport()` yet. It is the projection an `x flags [--json]` command and an MCP
  `flags.list` tool should read; neither exists.

## Commands

```
bun test packages/flags
bun run --filter @ultimat3/flags typecheck
```
