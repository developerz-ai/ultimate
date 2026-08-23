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

**No exception, as of 1.3.0.** `@ultimat3/auth`'s `requireRole()` / `requireScope()` used to gate
*routes* on the ambient actor without evaluating a policy; they are deleted. They were documented
here as "one honest exception" and had **zero callers** in the framework or in either tracked app —
a sanctioned second door nobody walked through, whose own documentation admitted that a route
gated that way is invisible to `x policy list`, to `framework.manifest.json` and to `openapi.json`.
Gate a route with a `Policy`: `can('admin:access')`, which every introspection surface can read.
`requireActor()` and `currentActor()` remain — those assert *authentication*, which is what
`@ultimat3/auth` produces.

## Shape

A policy is a pure `(input, actor, row, ctx) => PolicyDecision`.

```ts
type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; code: string };
```

`reason` is always **safe to log** (it names permissions, never row data) and useful
to an agent: `actor lacks post:publish` and `post:publish predicate returned false`
are different problems with different fixes.

## One predicate signature, every surface

```ts
interface PolicyArgs<I = unknown, R = unknown> {
  input: I;
  actor: Actor | null;
  row: R | null; // required — `null` means "this rule decides on input alone"
  ctx?: Ctx;
}
```

A predicate is written once and is correct in an HTTP route, a job, an MCP tool and a
live query's per-row gate:

```ts
// decides on input alone — `row` is null
can<{ orgId: string }>('post:create', ({ actor, input }) => actor?.orgId === input.orgId);

// decides about a row the surface already loaded
can<{ postId: string }, Post>('post:publish', ({ actor, row }) => row?.authorId === actor?.id);
```

`row` is required and nullable, not optional. An optional field is how the two shapes
drifted apart the first time: the realtime row gate nested the row inside `input`, so a
row rule and an input rule received different objects and nothing caught it.

Callers have it easier — `EvaluateArgs.row` **is** optional, and `evaluate()` normalises a
missing row to `null`. A surface that has no row passes `{ input, actor, ctx }` unchanged.

## Combinators

| Builder | Behaviour |
|---|---|
| `can(p, predicate?)` | permission first, then the row-level predicate |
| `allow()` / `deny(reason)` | terminal; `allow()` is how "public" is said out loud |
| `and(...)` | first denial wins, its reason is the reason |
| `or(...)` | first allowance wins; otherwise the last denial is reported |
| `not(p)` | inverts — except `X_UNAUTHENTICATED`, which propagates unchanged |

`not()` never turns "there is no actor" into an allow. `can()` denies a null actor with
`X_UNAUTHENTICATED`, and inverting that would make `not(can('order:internal'))` — the natural
simplification of `and(can('order:read'), not(can('order:internal')))` — a public door into the
internal one.

`policy.permissions` (or `policyPermissions(policy)`) is the flattened, deduped, sorted list of
every permission a tree references, `not()` clauses included. It is what a compliance report has
to read: `label` renders a composite as `and(post:publish, org:administer)`, which is a sentence,
never a permission.

`admitsAnonymous(policy)` is the other derived question `As of 2026-08`, and it is a **walk, not a
root read**:
whether an anonymous caller can be allowed at all. `policy.kind === 'allow'` is the read it
replaces, and it answered "needs a session" for `or(allow(), can('x:y'))` — so an HTTP route 401'd
a caller the policy itself allows, while the same policy over MCP or a job let that caller in.

```ts
import { admitsAnonymous, allow, and, can, not, or } from '@ultimat3/policy';

admitsAnonymous(or(allow('public'), can('post:publish'))); // true
admitsAnonymous(and(allow('public'), can('post:publish'))); // false
admitsAnonymous(not(can('order:internal'))); // false — X_UNAUTHENTICATED propagates
```

It is **exact for an anonymous caller, not a heuristic**: with `actor === null`, `can()`
short-circuits on the actor check before its predicate runs and `allow()`/`deny()` ignore their
arguments, so no predicate is ever consulted and the tree alone decides. `true` never means
"unguarded" — it says only that a 401 before the handler is wrong; the surface still calls
`enforce()`. `@ultimat3/action` and `@ultimat3/query` derive `RouteMeta.auth` from it.

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

`enforce(surface, policy, args)` dispatches over that table with `Object.hasOwn`, and a surface
with no adapter is `X_POLICY_SURFACE_UNKNOWN`. Not a formality: the table is an object literal, so
it inherits `Object.prototype` — `enforce('valueOf' as Surface, …)` used to call
`Object.prototype.valueOf` with the table as its receiver and return a truthy value, so an authz
dispatch failed **closed with a `SurfaceDenial` no caller could read**.

## Permissions and roles

`definePermissions(['post:publish', ...])` gives a typed set; augmenting
`PermissionRegistry` (which `x g policy` generates) makes a typo a compile error, and
`can()` throws `X_PERMISSION_UNKNOWN` at declaration time either way. Roles are sugar:
`defineRoles({ owner: { grants: ['post:delete'], inherits: ['editor'] } })` expands
depth-first to a flat set, cycles included. `post:*` and `*` are supported.

`defineRoles()` **merges** into the app's one role map. A second call in a new feature folder
adds roles; it never deletes the first module's. A role two modules define *differently* is
`X_ROLE_REDEFINED`, naming both declaration sites — and an identical re-declaration is a no-op,
so `defineRoles({ ...roleDefinitions(), … })` stays legal.

The flattened grant set is memoised per actor and invalidated the moment the role map changes.
It is keyed on the actor object, so it lives exactly as long as the request does: `@ultimat3/auth`
re-reads the user row every request, and a revoked role takes effect on the next one.

## Traces

`evaluate()` returns a depth-first trace naming the clause that decided. `/_x` renders
it, `explain()` logs one line, and `policyMatrix()` turns actors × policy into an
assert-ready table:

```
owner   allow
editor  deny   post:read predicate returned false
viewer  deny   actor lacks post:publish
```

Building it is opt-in: on outside production, and in production only once a decision sink is
installed. A live query evaluates policy per subscriber on every change event, so an unread
`TraceEntry[]` per evaluation is real allocation on the busiest path there is. Force it with
`evaluate(policy, args, { trace: true })`.

## The decision log

```ts
setDecisionSink({
  record(event) {
    // { label, allowed, code, reason, actorId, actorKind, orgId, surface, deciding }
  },
});
```

No-op until installed, emitted from **one place** — inside `evaluate()`, so a fifth surface
inherits it — and it records the **allow** as well as the denial, which is the half an access
review actually asks for. It never carries `row` or `input`: `reason` is safe to log by
construction, and the sink inherits that guarantee. A sink that throws is logged and swallowed;
it never turns an allowed request into a 500.

## Errors

`X_FORBIDDEN` · `X_POLICY_MISSING` · `X_PERMISSION_UNKNOWN` · `X_POLICY_SURFACE_UNKNOWN` ·
`X_ROLE_REDEFINED`

A missing policy is a **type** error, not a throw: `ActionDef.policy` is required, so an action
without one does not compile. `policyMissing()` stays for a declaration site that cannot say it
in a type — a config-driven route table, a policy resolved by name.

## Boundaries

Tier 2. Imports `@ultimat3/core` only. Surface error shapes are declared structurally
so this package never imports `@ultimat3/http` (sibling tier) or the tier-3/4 surfaces
that import it.
