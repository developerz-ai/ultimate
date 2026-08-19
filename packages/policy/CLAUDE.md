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
- **`not()` never inverts `X_UNAUTHENTICATED`.** A null actor is not a fact about this
  actor's grants; inverting it makes `not(can('order:internal'))` a public door into the
  internal one. Any denial carrying that code propagates unchanged.
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
- No `any`. Never throw a bare `Error` — use `errors.ts`.
- **This package owns `X_FORBIDDEN`** and registers its title with core. `http`, `auth`
  and every surface adapter reuse the code and must not re-register it.

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
| `policy.ts` | `can`/`allow`/`deny`/`and`/`or`/`not` + decision recording |
| `evaluate.ts` | the single entry point; builds the trace, emits the one decision event |
| `decisions.ts` | the `DecisionSink` seam — no-op default, one call site, never PII |
| `surfaces.ts` | http/live/job/mcp adapters — the "one system" proof |
| `roles.ts` | the role map: merge, conflict, inheritance, wildcards |
| `grant-index.ts` | the per-actor flattened grant set, memoised against the role generation |
| `test-kit.ts` | `policyMatrix()` for generated policy tests |

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
