# @ultimat3/policy

The one authz rule, evaluated in every surface. Tier 2.

## Boundary

- May import: `@ultimat3/core`. That is all it needs.
- Never import `@ultimat3/http`/`@ultimat3/entity` (same tier) or any surface package.
  Surface denial shapes are declared structurally in `surfaces.ts`.

## The one predicate signature

```ts
interface PolicyArgs<I = unknown, R = unknown> {
  readonly input: I;
  readonly actor: Actor | null;
  readonly row: R | null; // required; `null` = this rule decides on input alone
  readonly ctx?: Ctx;
}
```

Every predicate on every surface sees these four fields. `row` is `R | null` rather than
`row?: R` on purpose — an optional field lets a surface forget it and lets the two shapes
drift apart again, which is exactly how the realtime row gate ended up nesting the row
inside `input`.

`EvaluateArgs<I, R>` is what *callers* pass and its `row` **is** optional; `evaluate()`
normalises a missing row to `null` before the predicate sees it. That is the only place the
two differ, and it is why a surface that decides on input alone needs no edit.

## Rules

- **Never add a second authz path.** If a surface cannot use `evaluate()`, add an
  adapter to `surfaces.ts` — nothing else.
- **`enforce()` dispatches with `Object.hasOwn`, never a bare index** (`As of 2026-08-23`). The
  adapter table is an object literal and so inherits `Object.prototype`: `adapters['valueOf']`
  answered a FUNCTION, so `enforce('valueOf' as Surface, …)` called it with the table as receiver
  and returned the table typed as a `SurfaceDenial` — truthy, so the public authz dispatcher failed
  **closed with a denial carrying no code and no reason**. Same hazard, same fix and same reason as
  the role map below (`Object.hasOwn`, `defineProperty`). An unknown surface is `X_POLICY_SURFACE_UNKNOWN`, whose `fix:`
  lists `Object.keys(adapters)` so a fifth surface joins it by existing. Pinned in
  `surfaces.test.ts`.
- **A derived question about a policy TREE is answered in this PACKAGE, once.** `policyPermissions`
  (in `policy.ts`) and `admitsAnonymous` (in `policy-anonymous.ts`) both walk the combinators
  `policy.ts` declares, so an answer computed in a surface package would drift from them the first
  time one changes — and could not be shared:
  `@ultimat3/action` and `@ultimat3/query` are the same tier and may not import each other, so a
  copy in either is a second answer for the other. Both shipped that copy briefly and it was
  hoisted here. `admitsAnonymous` in particular is EXACT for `actor === null` rather than a
  heuristic, because `can()` short-circuits on the actor check before its predicate and
  `allow()`/`deny()` ignore their arguments — no predicate is consulted, so the tree alone decides.
- **One predicate shape.** A row-level rule reads `args.row`. Never pass a row through
  `input`, and never add a per-surface args type.
- A policy is pure and synchronous. No I/O, no `await`. Load the row first, then decide.
- `reason` must be safe to log: name permissions and clauses, never row data or PII —
  `row` being in scope changes nothing about what a denial is allowed to say. The same
  guarantee is what a `DecisionSink` event inherits: `decisions.ts` carries the label, the
  deciding clause and the actor's identifiers, and **never `row` or `input`**.
- A missing policy is refused by the **type system**, not by a throw: `ActionDef.policy`
  is a required field in `@ultimat3/action`, so an action without one does not compile.
  `X_POLICY_MISSING` / `policyMissing()` stay published for a declaration site that cannot
  say it in a type (a config-driven route table, a policy resolved by name). Never default
  to allow.
- `can()` validates its permission at declaration time, not at request time.
- **`definePermissions()` merges, and an EMPTY registry is permissive.** It only ever `add`s, so a
  package that declares its own names at import time (`@ultimat3/admin`'s policy bridge) cannot
  clobber an app's set. What it does change is the mode: `isKnownPermission` answers `true` to
  everything while nothing is declared, so the first declaration anywhere in the process turns
  strict checking on for everyone. A test that uses `can()` declares the set it uses and restores
  the one it found — never leans on the empty registry.
- **`clearPermissions()` / `clearRoles()` are one-way; `restorePermissions()` / `restoreRoles()` are the
  other halves.** Both declaration calls run at MODULE scope, and a module evaluates once per `bun test`
  process — so a clear in one test file is permanent for every file after it, whose own `import` is a
  cache hit that declares nothing. `restoreRoles` takes the declaration sites too: `defineRoles()` derives
  them from the CALLER's stack, so restoring through it would make `X_ROLE_REDEFINED` name the harness.
- **`and()` and `or()` REFUSE an empty clause list** (`X_POLICY_CLAUSE_EMPTY`, `As of 2026-08-25`),
  at the call that builds them. An empty `and()` found nothing to deny and answered ALLOWED, so
  `and(...requiredCaps.map(can))` over a list that filtered to nothing — a config-driven or
  per-tenant rule table — admitted an **anonymous** caller on all four surfaces, with `meta.auth`
  deriving from `admitsAnonymous` so `@ultimat3/http` did not 401 first either, and no diagnostic:
  the label renders as `and()`. `allow('public')` is the explicit spelling, so refusing costs a
  caller nothing they cannot say another way. `or()` is refused for symmetry and for axiom 1 rather
  than for safety — it fails closed, but with "no clause allowed this actor", a reason naming no
  clause; `deny('<reason>')` carries one. Refused where it is WRITTEN, the same call
  `@ultimat3/scraping`'s `allowHosts: []` and `discriminated-union.ts`'s unroutable member make.
- **`not()` never inverts `X_UNAUTHENTICATED`, and `or()` is what makes that true of a TREE**
  (`As of 2026-08-25`). A null actor is not a fact about this actor's grants; inverting it makes
  `not(can('order:internal'))` a public door into the internal one. Any denial carrying that code
  propagates unchanged — but the rule held only while `not`'s DIRECT child was a `can()`:
  `not(or(can('order:internal'), deny('read-only mode')))` **allowed `actor: null`**, because `or`
  reported the LAST denial and `deny`'s `X_FORBIDDEN` overwrote the code `not()` had to recognise.
  So `or` now reports a denial carrying `X_UNAUTHENTICATED` over a later one that does not, and
  `policy-anonymous.ts`'s `or` walk mirrors it. **`and` needs no such rule** — it short-circuits, so
  the denial it reports IS the deciding one. The other candidate repair, `not()` re-reading
  `args.actor === null` itself, was refused: it would deny an anonymous caller under `not(deny(…))`,
  which this file and `policy-anonymous.ts` both document as ALLOWED, and it states the wrong rule —
  `not` inverts a decision about grants, and whether one was made without an actor is `or`'s to
  report.
- **`defineRoles()` merges** and refuses a role two modules define differently
  (`X_ROLE_REDEFINED`, naming both declaration sites). A re-declaration of an *identical*
  role is a no-op, which is what keeps `defineRoles({ ...roleDefinitions(), … })` legal.
- **A role name is ACTOR data, so the role map is read with `Object.hasOwn` and written with
  `defineProperty`** (`roles.ts`, `As of 2026-08`). An app's map is a plain object literal, so
  `map['constructor']` answered the `Object` FUNCTION, the `definition === undefined` guard passed,
  and `for (const grant of definition.grants)` threw a bare `TypeError` out of `evaluate` — which
  `@ultimat3/http` re-raises to the error boundary, so an actor holding a role named `constructor`,
  `__proto__` or `toString` turned every authz decision it made into a **500 instead of a 403**.
  `map[name] = value` is the same hazard writing: for `__proto__` it runs `Object.prototype`'s
  setter and files no key at all. `test-kit.ts`'s verdict map has the same two rules for the same
  reason — `allowedFor('constructor')` answered a truthy function — and `policyMatrix` builds it
  through `Object.fromEntries`, which defines own keys whatever they spell.
- **`Actor` is an ALIAS of core's, and `PolicyActorFields` is deleted** (`As of 2026-08-19`).
  It was `CoreActor & PolicyActorFields`, a four-field interface declared here. Three fields
  (`id`, `roles`, `orgId`) were already core's, so the intersection only restated them, and
  `PolicyActorFields.orgId`'s `| null` never survived it — it was intersected straight back to
  core's `string | undefined`. The fourth, `permissions`, was the only real content, and declaring
  it here is what made it **unbuildable**: core is tier 0 and cannot import this package, so
  `build()` had no field to carry and `userActor({ permissions })` compiled and discarded the
  argument. Every caller worked around it with `{ ...userActor({ id }), permissions: [...] }` — a
  spread over a frozen actor, producing an unfrozen one — so **32 fixtures across `query`,
  `action` and a tracked app proved authz against a shape no request mints**. `@ultimat3/auth`
  kept a second, hand-synced copy of the same interface for the same tier reason. `permissions`
  now sits beside `roles` and `scopes` in `@ultimat3/core`.
- **`testActor()` goes through `userActor()`** (`As of 2026-08-19`), so it is frozen with frozen
  arrays and a field added to `Actor` arrives here without a second list to keep in sync. It used
  to hand-roll the literal — it had to, since core's builder had no `permissions` — and omitted
  `kind` and `scopes` behind an `as unknown as Actor`, so `hasScope(actor, …)` threw a bare
  `TypeError` on every actor it built and `actorLabel()` rendered `undefined:editor`: a generated
  scope-gated policy test failed as a 500-shaped throw instead of as the denial it asserts. The one
  cast left is `orgId: null` — core declares `orgId?: string`, so nothing typed can mint the
  `null` that `@ultimat3/query`'s `orgless()` guards against, and that test needs a producer.
- No `any`. Never throw a bare `Error` — use `errors.ts`.
- **This package owns `X_FORBIDDEN`** and registers its title with core. `http`, `auth`
  and every surface adapter reuse the code and must not re-register it.
- **Every owned code is classified `terminal`, and every one is LISTED** (`As of 2026-08-25`).
  `classifyThrown` reads an unregistered code carrying `terminal` as UNCLASSIFIED, so the attempt
  count governs and a job spends its whole retry policy re-proving a denial — the cost
  `@ultimat3/jobs`' webhook block is written up against. Core's own `ErrorRetry` doc names "a
  permission denial" as the canonical `terminal` case and `X_FORBIDDEN` was not classified at all.
  `errors.test.ts` pins the whole list, so a new code with no classification is a failing test.

## The one authz rule — and the one honest exception

Actions, queries, jobs, MCP tools **and routes** all resolve their rule through `evaluate()`.
There is no second door. `@ultimat3/auth`'s `requireRole()` / `requireScope()` were one until
1.3.0 — they asserted on the ambient actor and never evaluated a policy, and a route gated that
way was invisible to `x policy list`, to `framework.manifest.json` and to `openapi.json`. They
are deleted: in the repo's whole history, and in both tracked apps, **nothing ever called them**,
so the framework shipped a documented invitation to an under-reported route and nobody accepted
it. `packages/auth/src/guards.test.ts` pins that module's export list, so an authz decision
reappearing there is a failing test.

## Files

| File | Job |
|---|---|
| `policy.ts` | `can`/`allow`/`deny`/`and`/`or`/`not` + decision recording, and `policyPermissions` |
| `policy-anonymous.ts` | `admitsAnonymous` — the one question a SURFACE asks of a built tree, apart from the file that builds them |
| `evaluate.ts` | the single entry point; builds the trace, emits the one decision event |
| `decisions.ts` | the `DecisionSink` seam — no-op default, one call site, never PII |
| `surfaces.ts` | http/live/job/mcp adapters — the "one system" proof |
| `roles.ts` | the role map: merge, conflict, inheritance, wildcards |
| `grant-index.ts` | the per-actor flattened grant set, memoised against the role generation |
| `test-kit.ts` | `policyMatrix()` for generated policy tests, and `testActor()` |

## The hot path

A live query evaluates policy **per subscriber on every change event** — one write to a channel
with 10k watchers is 10k evaluations in one tick. Two consequences, both load-bearing:

- `grant-index.ts` memoises the flattened grant set on a `WeakMap<Actor, …>`, invalidated by
  `roleMapGeneration()` — the same shape `@ultimat3/entity`'s `relationMap()` uses against
  `registryGeneration()`. Keyed on the actor **object**, never on its id: `@ultimat3/auth`
  re-reads the user row every request and mints a fresh frozen actor, so a revoked role still
  takes effect on the next request and the entry dies with it. **Never cache an actor, or a
  grant set, across requests** — that is the stale-authz window the framework does not have.
- The trace is opt-in: on outside production, and in production only once a `DecisionSink` is
  installed. `evaluate(policy, args, { trace: true })` forces it — `policyMatrix()` does,
  because `deciding` *is* the matrix.

## Commands

```
bun test packages/policy
bun run --filter @ultimat3/policy typecheck
```
