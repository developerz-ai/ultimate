# Policies and authz

One authz system. Authentication is Better Auth, wrapped ([Configuration](Configuration)); **authorization is ours**, because it must be identical in HTTP, WebSocket, jobs, and MCP.

```ts
policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId))
```

## `can(permission, predicate)`

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `permission` | `string` | yes | a capability id, `resource:verb`. Must exist in the declared permission set or the build fails (`X_PERMISSION_UNKNOWN`) |
| `predicate` | `(subject) => boolean \| Promise<boolean>` | no | the row-level condition. Omitted means the capability alone decides |

The `subject` handed to the predicate:

| Member | Type | Notes |
|---|---|---|
| `actor` | `Actor \| null` | `{ kind: 'user' \| 'service' \| 'agent' \| 'anonymous', id, orgId?, roles, scopes }`. Anonymous is `null`-safe; policies branch on it |
| `input` | parsed input | already validated against the primitive's `input` schema |
| `ctx` | `Ctx` | repos for lookups, `ctx.tz`, `ctx.logger`. Read-only use |
| `action` | `string` | the name of the primitive being guarded — for logging and denial text |

Policies live in `<feature>/policy.ts` and are referenced by name from `actions.ts` and `live.ts`. `agent` is a first-class actor kind: an MCP caller goes through this same function, with no separate path.

## Where a policy is evaluated

| Surface | When | Denial rendering |
|---|---|---|
| HTTP call | before `handle`, after input parse | `X_FORBIDDEN` (403), or `X_UNAUTHENTICATED` (401) if the actor is anonymous |
| Typed client call | server-side, on the same route | same as HTTP; the client sees the JSON body |
| Direct server call | in-process invocation | throws `X_POLICY_DENIED` |
| Job execution | per attempt, per step boundary — an actor's rights can be revoked mid-workflow | throws `X_POLICY_DENIED`; the job fails, it does not silently skip |
| MCP tool call | before the tool body, same evaluation | tool error carrying `X_POLICY_DENIED` + `fix` |
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
X_POLICY_DENIED: policy denied the request
  cause: actor user_2 (roles: editor) lacks post:publish on post_9
  fix:   grant post:publish to the actor's role, or call as the post owner
```

```json
{ "code": "X_POLICY_DENIED",
  "cause": "actor user_2 (roles: editor) lacks post:publish on post_9",
  "fix": "grant post:publish to the actor's role, or call as the post owner",
  "docs": "https://ultimate.dev/errors/X_POLICY_DENIED" }
```

| Code | Where | Status |
|---|---|---|
| `X_POLICY_DENIED` | internal, jobs, direct calls, MCP tool errors | — |
| `X_FORBIDDEN` | HTTP edge, authenticated actor without the capability | 403 |
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
{"action":"publishPost","capability":"post:publish","predicate":"ownsPost(actor, input.postId)",
 "surfaces":["http","client","job","mcp"],
 "branches":[{"outcome":"allow","when":"actor owns post"},
             {"outcome":"deny","code":"X_POLICY_DENIED","when":"actor does not own post"},
             {"outcome":"deny","code":"X_UNAUTHENTICATED","when":"actor.kind == anonymous"}],
 "tests":["apps/web/app/posts/actions.test.ts:publishPost denies a non-owner"]}
```

| Want | Command | MCP tool |
|---|---|---|
| one path explained | `x policy explain <path> --json` | `policies.list` |
| every policy + its users | `x policy list --json` | `policies.list` |
| unprotected surfaces | `x verify --json` (the `boundaries` step) | `budgets.report` / `manifest.get` |

The `branches` array is what the generated tests enumerate — one denial test per branch. An untested branch is a red build.

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
    .rejects.toMatchError('X_POLICY_DENIED');
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
