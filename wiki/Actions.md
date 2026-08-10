# Actions

The load-bearing primitive. A mutation or command, server-authoritative, declared once.

```ts
export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id });
    return post;
  },
});
```

Declared in `api/` or a feature's `actions.ts`. Named export, never default. The export name is the identity: it derives the HTTP path, the OpenAPI `operationId`, and the MCP tool name, and it must be globally unique.

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `input` | Standard Schema (`t` from `@ultimat3/schema`) | yes | parsed before anything else runs; drives the TS type, JSON Schema, OpenAPI request body, MCP tool schema. `t` is the shipped dependency-free builtin provider; ArkType, Zod and Valibot are optional swaps behind `configureSchemaProvider` and ship no adapter |
| `output` | Standard Schema | yes | the response contract; drives the typed client return type and the OpenAPI response |
| `policy` | `Policy` from `can(...)` | yes | the one authz decision, evaluated on every surface. Omitting it is a build error |
| `cache.invalidates` | `readonly CacheTag[]` | no | tags dropped from every cache tier after `handle` settles; unknown tag = compile error |
| `mcp.expose` | `boolean` | no (opt-in) | only a literal `true` makes the action a tool; silence exposes nothing. Listing an un-exposed action in `defineAppMcp` is `X_MCP_TOOL_UNDECLARED` at boot |
| `mcp.description` | `string` | no | the tool description an agent reads, and the OpenAPI `summary`. Contract text, so it stays outside `t()` — `openapi.json` must not depend on a locale. Write it for a stranger |
| `rateLimit` | `{ limit: number; windowMs: number }` | no | per-actor limit enforced at the HTTP and MCP edges |
| `idempotent` | `boolean` | no | marks the action safe to retry with an `Idempotency-Key` header |
| `handle({ input, ctx })` | `(args) => Promise<Output>` | yes | the body. Parsed `input`, ambient `ctx`. Returns `output`-shaped data |

`ctx` members an action may use:

| Member | Type | Use |
|---|---|---|
| `ctx.actor` | `Actor` | `{ kind: 'user' \| 'service' \| 'agent' \| 'anonymous', id, orgId?, roles, scopes }`. Read-only; authz already ran |
| `ctx.<service>` | app-augmented | repos and services (`ctx.posts`, `ctx.orgs`, `ctx.mail`) — declared via `CtxServices` |
| `ctx.jobs` | job client | the facade `<job>.enqueue(input)` resolves; enqueue is transactional via the outbox |
| `ctx.requestId` / `ctx.traceId` | `string` | W3C trace id; the same value crosses HTTP → job → live query |
| `ctx.locale` / `ctx.tz` | `string` | BCP-47 and IANA. Never format a date without `ctx.tz` |
| `ctx.clock` / `ctx.now()` | `Clock` / `Date` | frozen and advanceable in tests. Never `Date.now()` |
| `ctx.logger` | `Logger` | structured, role-tagged, correlated to the span |
| `ctx.signal` | `AbortSignal` | client disconnect / drain; pass it to long calls |
| `ctx.role` / `ctx.buildId` | `Role` / `string` | which runtime role is executing, and which build |

## Six generated artifacts

| # | Artifact | Derived from | Notes |
|---|---|---|---|
| 1 | **HTTP route** | name + `input` | `POST /_x/action/publish-post`, body parsed by `input`, errors are `UltimateError` JSON |
| 2 | **OpenAPI operation** | `input` + `output` + `mcp.description` | emitted into `x.manifest.json` and `openapi.json`; contract diff runs in `x verify` |
| 3 | **Typed client function** | `input` + `output` | `await api.publishPost({ postId })` in `app/` — no fetch, no codegen step to remember |
| 4 | **Job handle** | the whole declaration | `publishPost.job()` — a namespaced name, an `idempotencyKey` from the payload, and an `invoke` that runs the same handler durably. Register it with the queue; `.enqueue()` belongs to a declared `job` |
| 5 | **MCP tool** | `mcp` + `input` + `policy` | one tool per exposed action, JSON Schema from `input`, authz unchanged |
| 6 | **Test** | `input` + `policy` | schema round-trip plus a denial test per policy branch — generated green, not as a `TODO` |

Plus cache invalidation: `cache.invalidates` fans out to request memo, in-process LRU (all instances, over NATS), Redis, ISR pages, and the CDN purge webhook in one hop ([Caching and invalidation](Caching-And-Invalidation)).

There is **one execution path**. HTTP, MCP, jobs, and direct server calls differ only in the surface they declare, which selects how a denial is rendered — never whether authz runs and never how input is validated.

## One authz system

`policy` is evaluated for the HTTP call, the typed client call, the job execution, the MCP tool call, and the live-query subscription — the same function, the same actor resolution, the same denial error.

> **Two authz systems is how every Meteor-like framework died.** Meteor had `allow`/`deny` rules for the client sync path and plain method bodies for the server path; the two drifted, and the drift *was* the security model. Anything that lets an agent expose data through a second door — a "public" MCP tool, an "internal" RPC, a sync rule table — is a rejected design, not a config option.

Rejected by that rule: an MCP-specific permission table, a "trusted tool" mode, a broad-rights service account for agents, and an internal RPC surface that skips `policy`. Details in [Policies and authz](Policies-And-Authz).

## `action` must never

- read the request object, headers, or cookies directly — actor and tenant come from `ctx`
- render, redirect, or return HTML
- perform its own authorization inside `handle` — that belongs in `policy`
- do slow work inline — enqueue a `job`
- be defined outside `api/` or a feature's `actions.ts`

Logic lives in `service.ts`; `actions.ts` holds declarations. An action whose `handle` is more than a few lines of orchestration is a service waiting to be extracted.

## `mutator` — action + optimistic twin

Same declaration surface as `action`, plus a local half that runs client-side against the local store while the server call is in flight.

```ts
export const likePost = mutator({
  // Convergent, not incremental: `local` replays on every rebase, so applying it N times has to
  // equal applying it once — `likedByMe` is what makes the second application a no-op.
  local(tx, { postId }) {
    tx.posts.update(postId, (p) =>
      p.likedByMe ? {} : { likedByMe: true, likeCount: p.likeCount + 1 });
  },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
```

| Aspect | Rule |
|---|---|
| Projects to | everything `action` does, plus a local-store transaction and a rebase entry |
| Owns | conflict strategy: `'server-wins'`, `'last-write-wins'`, or `custom(merge)` |
| Authz | the `server` half carries the policy; the `local` half is presentation only and never a security boundary |
| Never | let `local` do I/O, randomness, or `Date.now()` |

**Replayability rule:** `local` is re-executed on every rebase — after each server confirmation, on reconnect, and when a conflicting remote write arrives. It must be a pure function of `(tx, input)`. I/O, `Math.random()`, `crypto.randomUUID()`, or a wall-clock read makes the local timeline diverge from the server's, and the divergence surfaces as flicker, then as wrong data. Ids and timestamps come from the input, generated once at call time. Tier 3 local-first (`persist: true`) is v2; mutators work today at realtime tiers 1–2 ([Realtime](Realtime)).

## Errors

| Code | When | Fix |
|---|---|---|
| `X_ACTION_POLICY_MISSING` | an action registered without `policy` | add `policy: can('<name>')` to the declaration |
| `X_ACTION_DUPLICATE` | two actions share an export name | rename one — names are globally unique |
| `X_INPUT_INVALID` | body fails the `input` schema | `x actions describe <name> --json` prints the expected schema |
| `X_POLICY_DENIED` | the policy said no | grant the capability, or call as an actor who has it |
| `X_FORBIDDEN` | the HTTP/MCP rendering of a denial (403) | same as above |
| `X_UNAUTHENTICATED` | no session; anonymous actor hit a policy needing one (401) | sign in, or send a valid token |
| `X_IDEMPOTENCY_CONFLICT` | key reused with a different payload, or still in flight | send a fresh `Idempotency-Key`, or retry after the first settles |
| `X_CONTRACT_DRIFT` | client build id ≠ server build id, or a breaking published-contract change | reload the client / bump the action version |
| `X_TENANCY_UNSCOPED` | a query inside `handle` had no tenant predicate | scope it through the repo, never raw SQL |
| `X_BOUNDARY_VIOLATION` | action declared outside `api/` or `<feature>/actions.ts` | move the file, or `x fix boundary <file>` |

```
X_ACTION_POLICY_MISSING: action registered without a policy
  cause: action "publishPost" was registered without a policy
  fix:   add `policy: can('publishPost')` to the action definition in the file that exports it
```

Every code carries the same `{ code, cause, fix, docs }` in the terminal, the dev overlay, the HTTP body, `--json`, and the MCP tool error. Full list: [Error codes](Error-Codes).

## Introspection

```
$ x actions list --json
{"actions":[{"name":"publishPost","path":"/_x/action/publish-post","capability":"post:publish",
  "idempotent":false,"mcp":{"expose":true,"tool":"publishPost"},
  "invalidates":["post","feed"]}]}
```

```
$ x actions describe publishPost --json
{"kind":"action","name":"publishPost","verb":"publish","resource":"posts",
 "method":"POST","path":"/_x/action/publish-post","capability":"post:publish",
 "input":{"type":"object","required":["postId"],
   "properties":{"postId":{"type":"string","format":"uuid"},
                 "notify":{"type":"boolean","default":true}}},
 "output":{"$ref":"#/components/schemas/PostView"},
 "invalidates":["feed","post"],"idempotent":false,
 "mcp":{"expose":true,"tool":"publishPost","description":"Publish a draft post"},
 "rateLimit":null}
```

`invalidates` is sorted and de-duplicated, so descriptor output never depends on declaration order — a diffable contract. The same data is the MCP `actions.describe` tool (actions and queries in one call) and the `/_x` **Routes** panel.

## Generated contract test

Emitted with the action, and green on the first run: it pins the invariant the action owns — a non-owner is denied — rather than a `TODO` someone has to notice.

```ts
// contract test — generated with the action
test('publishPost denies a non-owner', async ({ seed, actorFor }) => {
  const { post, stranger } = await seed('two-orgs');
  await expect(publishPost.as(actorFor(stranger), { postId: post.id }))
    .rejects.toBeUltimateError('X_POLICY_DENIED');
});
```

Runs against a cloned Postgres (`CREATE DATABASE … TEMPLATE`), never a mock. `x test contract` asserts the input/output schema round-trip, one denial per policy branch, and that the emitted OpenAPI operation plus MCP tool shape still match the declaration. See [Testing](Testing).
