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
- **`not()` never inverts `X_UNAUTHENTICATED`.** A null actor is not a fact about this
  actor's grants; inverting it makes `not(can('order:internal'))` a public door into the
  internal one. Any denial carrying that code propagates unchanged.
- **`defineRoles()` merges** and refuses a role two modules define differently
  (`X_ROLE_REDEFINED`, naming both declaration sites). A re-declaration of an *identical*
  role is a no-op, which is what keeps `defineRoles({ ...roleDefinitions(), … })` legal.
- No `any`. Never throw a bare `Error` — use `errors.ts`.
- **This package owns `X_FORBIDDEN`** and registers its title with core. `http`, `auth`
  and every surface adapter reuse the code and must not re-register it.

## The one authz rule — and the one honest exception

Actions, queries, jobs and MCP tools all resolve their rule through `evaluate()`. Routes have
a second, coarser door: `@ultimat3/auth`'s `requireRole()` / `requireScope()`
(`packages/auth/src/guards.ts`), which assert on the ambient actor and — as that file's own
header says — **never evaluate a policy**. They are small and honest about themselves, but a
route gated that way is invisible to `x policy list`, to `framework.manifest.json` and to
`contract-diff`. Anything finer than "is this actor an admin" belongs in a policy.

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
