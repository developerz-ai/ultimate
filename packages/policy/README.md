# @ultimat3/policy 🔐

**One authz system.** Two authz systems — one for HTTP, one for "the API", one for
jobs — is how every Meteor-shaped framework died: the surfaces drift, one of them is
wrong, and nobody finds out until it is a CVE. This package exists so a second one is
never necessary. Every MCP tool, live query, job and route resolves the *same* policy
object through the *same* `evaluate()`.

```ts
export const publishPost = action({
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
});
```

## Shape

A policy is a pure `(input, actor, ctx) => PolicyDecision`.

```ts
type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; code: string };
```

`reason` is always **safe to log** (it names permissions, never row data) and useful
to an agent: `actor lacks post:publish` and `post:publish predicate returned false`
are different problems with different fixes.

## Combinators

| Builder | Behaviour |
|---|---|
| `can(p, predicate?)` | permission first, then the row-level predicate |
| `allow()` / `deny(reason)` | terminal; `allow()` is how "public" is said out loud |
| `and(...)` | first denial wins, its reason is the reason |
| `or(...)` | first allowance wins; otherwise the last denial is reported |
| `not(p)` | inverts |

## Four surfaces, four adapters, one rule

`surfaces.ts` is the proof. Each adapter evaluates and maps a denial to that surface's
error shape; allowed returns `undefined`.

| Adapter | Denial shape |
|---|---|
| `enforceHttp` | `403` + RFC-9457 fields |
| `enforceLive` | close frame `4403` |
| `enforceJob` | `failed`, `retryable: false` — the answer will not change on retry |
| `enforceMcp` | `isError: true` with readable text |

Adding a fifth surface means adding an adapter here **and nothing else**.

## Permissions and roles

`definePermissions(['post:publish', ...])` gives a typed set; augmenting
`PermissionRegistry` (which `x g policy` generates) makes a typo a compile error, and
`can()` throws `X_PERMISSION_UNKNOWN` at declaration time either way. Roles are sugar:
`defineRoles({ owner: { grants: ['post:delete'], inherits: ['editor'] } })` expands
depth-first to a flat set, cycles included. `post:*` and `*` are supported.

## Traces

`evaluate()` returns a depth-first trace naming the clause that decided. `/_x` renders
it, `explain()` logs one line, and `policyMatrix()` turns actors × policy into an
assert-ready table:

```
owner   allow
editor  deny   post:read predicate returned false
viewer  deny   actor lacks post:publish
```

## Errors

`X_FORBIDDEN` · `X_POLICY_MISSING` (an action with no policy is a **build** error, not
a public endpoint) · `X_PERMISSION_UNKNOWN`

## Boundaries

Tier 2. Imports `@ultimat3/core` only. Surface error shapes are declared structurally
so this package never imports `@ultimat3/http` (sibling tier) or the tier-3/4 surfaces
that import it.
