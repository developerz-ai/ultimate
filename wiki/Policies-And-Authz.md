# Policies and authz

One authz system. Authentication is Better Auth, wrapped ([Configuration](Configuration)); **authorization is ours**, because it must be identical in HTTP, WebSocket, jobs, and MCP.

```ts
policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId))
```

## `can(permission, predicate)`

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `permission` | `string` | yes | a capability id, `resource:verb`. Must exist in the declared permission set or the build fails (`X_PERMISSION_UNKNOWN`) |
| `predicate` | `(args: PolicyArgs) => boolean \| PolicyDecision` | no | the row-level condition. Omitted means the capability alone decides. **Synchronous** — a live query evaluates it per subscriber per change, so an `await` here costs one round trip per watcher |

`PolicyArgs` — the one signature, identical on every surface:

| Member | Type | Notes |
|---|---|---|
| `actor` | `Actor \| null` | `{ kind: 'user' \| 'service' \| 'agent' \| 'anonymous', id, orgId?, roles, scopes }`. Anonymous is `null`-safe; policies branch on it |
| `input` | parsed input | already validated against the primitive's `input` schema |
| `row` | `R \| null` | the already-loaded row a row-level rule decides about; `null` when the rule decides on input alone. Never pass a row through `input` |
| `ctx` | `Ctx` | repos for lookups, `ctx.tz`, `ctx.logger`. Read-only use |

Policies live in `<feature>/policy.ts` and are referenced by name from `actions.ts` and `live.ts`. `agent` is a first-class actor kind: an MCP caller goes through this same function, with no separate path.

## Where a policy is evaluated

| Surface | When | Denial rendering |
|---|---|---|
| HTTP call | before `handle`, after input parse | `X_FORBIDDEN` (403), or `X_UNAUTHENTICATED` (401) if the actor is anonymous |
| Typed client call | server-side, on the same route | same as HTTP; the client sees the JSON body |
| Direct server call | in-process invocation | throws `X_FORBIDDEN` |
| Job execution | per attempt, per step boundary — an actor's rights can be revoked mid-workflow | throws `X_FORBIDDEN`; the job fails, it does not silently skip |
| MCP tool call | before the tool body, same evaluation | tool error carrying `X_FORBIDDEN` + `fix` |
| Live query **subscribe** | at subscribe time | subscription rejected with `X_FORBIDDEN` |
| Live query **per delivered row** | on every patch, for every row, for the lifetime of the subscription | the row is not delivered; no partial object, no id leak |
| Admin visibility | screen and field level | the screen does not render, and its MCP tool is not listed |

The decision is surface-blind. The surface selects only how a denial is *rendered* — never whether authz runs, and never how input was validated.

| Aspect | Rule |
|---|---|
| Projects to | HTTP guard, live-query row filter, job actor check, MCP tool gate, admin visibility |
| Owns | the yes/no and the denial reason |
| Never | mutate, query outside the declared repos, or return partial data (filter in the `query`) |

## Denials

Same code, three encodings.

```
X_FORBIDDEN: policy denied the request
  cause: actor user_2 (roles: editor) lacks post:publish on post_9
  fix:   x actions describe publishPost --json   # the capability it enforces; grant post:publish to editor in apps/web/shared/policies.ts
```

```json
{ "code": "X_FORBIDDEN",
  "cause": "actor user_2 (roles: editor) lacks post:publish on post_9",
  "fix": "x actions describe publishPost --json   # the capability it enforces; grant post:publish to editor in apps/web/shared/policies.ts",
  "docs": "https://github.com/developerz-ai/ultimate/wiki/Error-Codes" }
```

A `fix` is a command to run, a call to paste, or a file to open — never advice. `x errors explain <CODE> --json` prints the same `{ code, cause, fix, docs }` for any registered code.

| Code | Where | Status |
|---|---|---|
| `X_FORBIDDEN` | everywhere a denial is decided: internal, jobs, direct calls, MCP tool errors, and the HTTP edge for an authenticated actor without the capability | 403 at the HTTP edge, no status elsewhere |
| `X_UNAUTHENTICATED` | HTTP edge, anonymous actor hitting a policy that needs a session | 401 |

`--json` and the MCP response carry the identical code and `fix` string as the terminal and the dev overlay. A denial reason never includes data the actor could not otherwise read.

## Missing or unknown policy is a build error

```
X_ACTION_POLICY_MISSING: action registered without a policy
  cause: action "publishPost" was registered without a policy
  fix:   add `policy: can('publishPost')` to the action definition in the file that exports it
```

| Code | Trigger |
|---|---|
| `X_ACTION_POLICY_MISSING` | an `action` / `mutator` / `query` registered without `policy` |
| `X_POLICY_MISSING` | a permission is referenced but no policy defines it |
| `X_PERMISSION_UNKNOWN` | `can('post:pubish')` — a capability not in the declared set. Typos die at build time |

There is no `policy: 'public'` shortcut and no default-allow. A route that is genuinely public is a `site/` route with no action behind it; a genuinely public action declares an explicit anonymous-allowing policy, which is greppable and shows up in `x policy explain`.

## Introspection

```
$ x policy explain publishPost --json
{"ok":true,"command":"policy","summary":"publishPost — allowed for 0 of 5 actor evaluation(s)","findings":[],
 "data":{"subject":"publishPost","kind":"action","grantingRoles":["admin","author","owner"],
  "declarations":[{"name":"publishPost","kind":"action","capability":"post:publish",
   "label":"post:publish","decidable":true,"rows":[
    {"actor":"anonymous","allowed":false,"reason":"no actor for post:publish","deciding":"post:publish"},
    {"actor":"admin","allowed":false,"reason":"post:publish predicate returned false","deciding":"post:publish"},
    {"actor":"author","allowed":false,"reason":"post:publish predicate returned false","deciding":"post:publish"},
    {"actor":"owner","allowed":false,"reason":"post:publish predicate returned false","deciding":"post:publish"},
    {"actor":"reader","allowed":false,"reason":"actor lacks post:publish","deciding":"post:publish"}]}]}}
```

One row per actor per declaration — every declared role plus `anonymous`, evaluated once for each action or query that enforces the subject. A permission two declarations enforce therefore reports twice the evaluations, which is why the summary counts evaluations and never roles. `deciding` is the clause that produced the verdict and `reason` is why — which is what separates "this role was never granted the permission" from "it holds the grant and the row predicate said no".

The matrix runs **outside a request**: no input, no row. A rule that reads either decides again on the real call, so a `predicate returned false` here is a no-input verdict rather than a standing denial — the human render says so under every table. `decidable` is `false` for a policy that cannot be evaluated at all outside a request (a predicate dereferencing `input.post.id` has nothing to dereference); `rows` is then empty and the render says that instead of printing a table of invented denials.

`<subject>` resolves in order against a permission, an action name, a query name, then an action's HTTP path — so whichever of the four a throwing surface had to hand, the `fix:` line it printed is runnable.

| Want | Command | MCP tool |
|---|---|---|
| one subject explained | `x policy explain <subject> --json` | none — no dev tool takes a subject, and `policies.list` returns the catalog without the per-declaration matrix |
| every permission + who grants and enforces it | `x policy list --json` | `policies.list` (no arguments) |
| unprotected surfaces | `x verify --json` (the `boundaries` step) | `budgets.report` / `manifest.get` |

`x policy list` also names the permissions **no** action or query enforces. A grant nothing checks is a grant that does nothing, and it is invisible from any single declaration.

## Tenancy

Authz and tenancy are separate checks, both mandatory.

```
X_TENANCY_UNSCOPED: query is not scoped to a tenant
  cause: select on "posts" has no predicate on tenant column "orgId"
  fix:   query through posts repo (ctx.posts.*) — it applies the tenant scope from ctx.actor
```

| Rule | Detail |
|---|---|
| Every query is tenant-scoped or it fails | the predicate comes from `ctx.actor.orgId` via the repo, never hand-written per call site |
| Cache keys include tenant + policy scope | framework-generated; a hand-built key is a rejected PR, so a cache hit cannot cross tenants |
| Live queries scope in the matcher | not as a post-filter, so a cross-tenant row never enters the fanout path |
| Vector and FTS search filter in SQL | similarity search cannot leak across tenants |
| An agent actor cannot exceed its human | the actor is the signed-in user's session; no broad-rights service account |

## Testing denials

Generated with the primitive, fails until filled in:

```ts
// contract test — generated as a scaffold with the action
test('publishPost denies a non-owner', async ({ seed, actorFor }) => {
  const { post, stranger } = await seed('two-orgs');
  await expect(publishPost.as(actorFor(stranger), { postId: post.id }))
    .rejects.toBeUltimateError('X_FORBIDDEN');
});
```

| Test type | Asserts about authz |
|---|---|
| `x test unit` | policy predicates in isolation — pure logic, no DB |
| `x test contract` | one denial per policy branch, plus the MCP tool + OpenAPI shape |
| `x test live` | a policy-failing row is **never delivered**, including after a reconnect delta |
| `x test job` | a revoked actor fails the job instead of skipping the step |

Fixtures are deterministic: `seed('two-orgs')` produces identical rows and identical UUIDs every run, so a denial test cannot pass by accident.

## Why it is shaped this way

> **Two authz systems is how every Meteor-like framework died.** Meteor had `allow`/`deny` rules for the client sync path and plain method bodies for the server path; the two drifted, and the drift *was* the security model. Anything that lets an agent expose data through a second door — a "public" MCP tool, an "internal" RPC, a sync rule table — is a rejected design, not a config option.

Designs this rejects, permanently:

| Rejected | Why |
|---|---|
| A sync/subscription rule table separate from server authz | the two drift; the drift is the vulnerability |
| MCP-specific permissions, "trusted tool" mode, agent service accounts | an agent must never exceed the human it acts for |
| An "internal" RPC surface that skips `policy` | a second door, and the one no one audits |
| GraphQL | a second schema language **and** a second authz surface, per resolver |
| Row-level security as the only mechanism | policy must also run for jobs and MCP calls, where no DB session carries the actor |
| Authorization inside `handle` | unreachable from the live-query and MCP paths, so it silently protects one door of four |

Source: [`docs/idea/02-primitives.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/02-primitives.md), [`docs/idea/09-ai-first.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/09-ai-first.md). Related: [Actions](Actions), [Queries and live queries](Queries-And-Live-Queries), [MCP and AI](MCP-And-AI), [Error codes](Error-Codes).
