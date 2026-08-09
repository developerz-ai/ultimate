# @ultimat3/action ⚡

One declaration → six artifacts.

| # | Artifact | Reach it with | Guarantees |
|---|---|---|---|
| 1 | HTTP route `POST /api/<resource>/<verb>` | `toRoute(action)` — the server mounts it | policy + validation + idempotency + invalidation, non-optional |
| 2 | OpenAPI 3.1 operation + document | `action.openapi()` / `buildOpenApi()` | byte-stable output, diffed by `x verify` |
| 3 | Typed RPC client | `action.client({ baseUrl })` / `createClient<typeof actions>()` | server typo = compile error in Solid |
| 4 | MCP tool | `action.tool()` | *identical* policy evaluation to the route |
| 5 | Job handle | `action.job()` | enqueue durable work, no rewrite |
| 6 | Contract tests | `action.contract()` | garbage rejected, anonymous denied, spec present |

## The fluent surface

An action carries its own projections, so app code never reaches through `.def` and
never imports a projection function:

```ts
publishPost.input                              // the declared input schema
publishPost.output                             // the declared output schema
publishPost.policy                             // the one policy object
publishPost.mcp                                // { expose, description }, as declared
await publishPost.as(actor, { postId })        // run as someone, one execution path
publishPost.tool()                             // MCP descriptor
publishPost.openapi()                          // OpenAPI operation
publishPost.client({ baseUrl })                // typed RPC method
publishPost.job()                              // durable-work handle
publishPost.contract()                         // the three generated assertions
```

`publishPost.tool().policy === publishPost.policy` — the same object, so an MCP call
cannot reach a different authz path. `.as()` keeps the surrounding context whole and
swaps only the actor: impersonation, not a second context.

## Declare

```ts
export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  idempotent: true,
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await ctx.jobs.enqueue(notifySubscribers, { postId: post.id });
    return post;
  },
});
```

Then, once, at boot: `registerActions(await import('./actions'))`. Names come from
**export names** — that is what makes the path, the tool name and the OpenAPI
`operationId` derivable everywhere without a second declaration. Registration stamps
the name onto the action the module exported, so the binding you imported is the one
that projects; a projection attempted before boot is `X_ACTION_UNREGISTERED`.

## Path derivation

First camelCase word is the verb; the rest is the resource, last word pluralized,
kebab-cased.

| Action | Route | MCP tool |
|---|---|---|
| `publishPost` | `POST /api/posts/publish` | `publish_post` |
| `updateUserProfile` | `POST /api/user-profiles/update` | `update_user_profile` |
| `toggleLike` | `POST /api/likes/toggle` | `toggle_like` |
| `checkout` (single word) | `POST /api/checkouts/invoke` | `checkout` |

## One authz system

`runAction()` is the only execution path. HTTP, MCP, jobs and direct server calls
differ **only** in the `surface` they hand to `enforce()` from `@ultimat3/policy`,
which selects how a denial renders (problem+json / tool error / failed job) — never
whether authz runs. The denial keeps the policy's own code, so an anonymous caller
gets `X_UNAUTHENTICATED` (401) on both surfaces and a permission gap gets
`X_FORBIDDEN` (403). Registering an action without `policy:` throws
`X_ACTION_POLICY_MISSING`; there is no bypass flag.

## mutator = action + local twin

`mutator()` is built **on top of** `action()`. A mutator IS an action, so it gets all
six projections; it adds `local(tx, input)` for the optimistic write and a `conflict`
strategy for the rebase.

```ts
export const toggleLike = mutator({
  input: t.object({ postId: t.uuid }),
  output: PostLikes,
  policy: can('post:like'),
  local(tx, { postId }) { tx.posts.update(postId, (p) => ({ likes: p.likes + 1 })); },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
```

`LocalTx` is the client write surface (`@ultimat3/realtime` implements it over OPFS
SQLite). Type your tables once: `declare module '@ultimat3/action' { interface
LocalTables { posts: PostRow } }`.

## Determinism + idempotency

`serializeOpenApi(buildOpenApi())` sorts keys at every depth, iterates the registry
name-sorted, and reads no clock, env or random source — same registry ⇒ same bytes ⇒
`x verify` can diff the spec and fail on `X_CONTRACT_DRIFT`.

`idempotent: true` + an `Idempotency-Key` header replays the first response
(`x-ultimate-replayed: 1`); a duplicate still in flight, or a reused key with a new
payload, is `X_IDEMPOTENCY_CONFLICT`. Store is swappable via `setIdempotencyStore()`.

## Errors

| Code | When | Fix |
|---|---|---|
| `X_ACTION_DUPLICATE` | two actions registered under one name | rename one export |
| `X_ACTION_POLICY_MISSING` | registration without `policy:` | add `policy: can('…')` |
| `X_INPUT_INVALID` | input failed the Standard Schema | `x actions describe <name> --json` |
| `X_IDEMPOTENCY_CONFLICT` | key reused with a new payload / still in flight | new key, or retry later |
| `X_CONTRACT_DRIFT` | client/server build skew, missing spec entry | reload / `x verify --contract` |
| `X_RPC_FAILED` | non-`problem+json` failure reached the client | check the gateway |
| `X_ACTION_UNREGISTERED` | projected before `registerActions()` ran | register at boot |

Denials re-throw the policy layer's own codes (`X_FORBIDDEN`, `X_UNAUTHENTICATED`) —
this package never invents an authz code.

## Boundaries

Tier 3. Imports `@ultimat3/core`, `schema`, `cache`, `policy`, `http`. Never imports
`query`, `jobs`, `realtime` (same tier) or anything above it — those import *this*.
