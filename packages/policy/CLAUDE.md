# @ultimat3/policy

The one authz rule, evaluated in every surface. Tier 2.

## Boundary

- May import: `@ultimat3/core`. That is all it needs.
- Never import `@ultimat3/http`/`@ultimat3/entity` (same tier) or any surface package.
  Surface denial shapes are declared structurally in `surfaces.ts`.

## Rules

- **Never add a second authz path.** If a surface cannot use `evaluate()`, add an
  adapter to `surfaces.ts` — nothing else.
- A policy is pure and synchronous. No I/O, no `await`. Load the row first, then decide.
- `reason` must be safe to log: name permissions and clauses, never row data or PII.
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
