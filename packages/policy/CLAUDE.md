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
  `row` being in scope changes nothing about what a denial is allowed to say.
- A missing policy is `X_POLICY_MISSING` at build time. Never default to allow.
- `can()` validates its permission at declaration time, not at request time.
- No `any`. Never throw a bare `Error` — use `errors.ts`.
- **This package owns `X_FORBIDDEN`** and registers its title with core. `http`, `auth`
  and every surface adapter reuse the code and must not re-register it.

## Files

| File | Job |
|---|---|
| `policy.ts` | `can`/`allow`/`deny`/`and`/`or`/`not` + decision recording |
| `evaluate.ts` | the single entry point; builds the decision trace |
| `surfaces.ts` | http/live/job/mcp adapters — the "one system" proof |
| `roles.ts` | role → permission expansion, inheritance, wildcards |
| `test-kit.ts` | `policyMatrix()` for generated policy tests |

## Commands

```
bun test packages/policy
bun run --filter @ultimat3/policy typecheck
```
