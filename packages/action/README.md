# @ultimat3/action ⚡

One declaration → six artifacts.

| # | Artifact | Reach it with | Guarantees |
|---|---|---|---|
| 1 | HTTP route `POST /api/<resource>/<verb>` | `toRoute(publishPost)` — the server mounts it | policy + validation + idempotency + invalidation, non-optional |
| 2 | OpenAPI 3.1 operation + document | `publishPost.openapi()` / `buildOpenApi()` | byte-stable output, diffed by `x verify` |
| 3 | Typed RPC client | `publishPost.client({ baseUrl })` / `rpc<Api['actions']>()` | server typo = compile error in Solid |
| 4 | MCP tool | `publishPost.tool()` | *identical* policy evaluation to the route |
| 5 | Job handle | `publishPost.job()` | enqueue durable work, no rewrite |
| 6 | Contract tests | `publishPost.contract()` | garbage rejected, anonymous denied, spec present |

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

`t` is re-exported here — the same object `@ultimat3/schema` exports, so an action file
imports one package for the primitive and its schemas, never two.

```ts
import { action, t } from '@ultimat3/action';

export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  idempotent: true,
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id });
    return post;
  },
});
```

## Register — one call, at boot

`apps/web/api/index.ts` is the whole API surface. Importing it IS the boot.

```ts
import { defineApi } from '@ultimat3/action';
import * as postActions from '../app/posts/actions';
import * as postMutators from '../app/posts/mutator';
import * as postQueries from '../app/posts/live';

export const api = defineApi({
  actions: [postActions],
  mutators: [postMutators],
  queries: [postQueries],
});

export type Api = typeof api;
```

| Key | Goes to | Why |
|---|---|---|
| `actions` | the action registry | the primitive |
| `mutators` | the action registry | a mutator IS an action, on the same authz path |
| `llm` | the action registry | `llm()` returns an action, not a ninth primitive |
| `queries` | `@ultimat3/query`'s registry, via core's registrar table | `query` is on this tier, so importing it here would be a build error |

Names come from **export names** — that is what makes the path, the tool name and the
OpenAPI `operationId` derivable everywhere without a second declaration. Registration
stamps the name onto the action the module exported, so the binding you imported is the
one that projects; a projection attempted before boot is `X_ACTION_UNREGISTERED`. Two
features exporting one name collide with `X_ACTION_DUPLICATE` rather than merging, and two
names deriving one route collide with `X_ACTION_PATH_DUPLICATE` — `pluralize` leaves a trailing
`s` alone, so `archiveOrder` and `archiveOrders` are two exports and one `POST /api/orders/archive`.

`registerActions` / `registerQueries` are what `defineApi` composes. An app calling them
directly is a second path.

## Call it — `rpc`

```ts
import { rpc } from '@ultimat3/action';
import type { Api } from '../api';

export const client = rpc<Api['actions']>({ baseUrl: '/' });
```

`Api['actions']` is the merged module type, so `client.publishPost` is typed from the
declaration with no codegen step. `Api` is imported as a **type only**, which is what keeps
a page's module graph free of any edge to a feature's implementation.

## Path derivation

First camelCase word is the verb; the rest is the resource, last word pluralized,
kebab-cased. The **MCP tool name is not derived** — it is the export name verbatim, because
that is what `defineAppMcp`'s `scopes:` and a `tools/call` have to spell.

| Action | Route | MCP tool |
|---|---|---|
| `publishPost` | `POST /api/posts/publish` | `publishPost` |
| `updateUserProfile` | `POST /api/user-profiles/update` | `updateUserProfile` |
| `likePost` | `POST /api/posts/like` | `likePost` |
| `checkout` (single word) | `POST /api/checkouts/invoke` | `checkout` |

## One invocation core

`invoke()` is the only execution path: **parse input → evaluate policy → handle →
parse output**. HTTP, MCP, jobs and direct server calls differ **only** in the
`surface` they hand to `enforce()` from `@ultimat3/policy`, which selects how a
denial renders (problem+json / tool error / failed job) — never whether authz runs.

Enforced structurally, not by convention: the declaration is held in a private
store inside `invoke.ts`, so `handle` is reachable from nowhere else. An action has
no `.def`. A second authz path cannot be written without deleting that store.

| Stage | Failure |
|---|---|
| parse input | `X_INPUT_INVALID` |
| evaluate policy | the policy's own code — `X_UNAUTHENTICATED` (401), `X_FORBIDDEN` (403) |
| handle | whatever the handler throws |
| parse output | `X_OUTPUT_INVALID` — and fields the schema never declared are dropped |

`cache: { invalidates }` fans out **after** the handler commits, so it never fails it: a
fan-out that refuses — an undeclared tag, `X_CACHE_TAG_UNKNOWN` — is one
`action.invalidate.failed` log line and the entries expire by TTL. A replayed idempotent
call busts nothing; the first call already did.

Registering an action without `policy:` throws `X_ACTION_POLICY_MISSING`; there is
no bypass flag. A look-alike that never came out of `action()` is `X_ACTION_FOREIGN`.

## mutator = action + local twin

`mutator()` is built **on top of** `action()`. A mutator IS an action, so it gets all
six projections; it adds `local(tx, input)` for the optimistic write and a `conflict`
strategy for the rebase.

```ts
export const likePost = mutator({
  input: t.object({ postId: t.uuid }),
  output: PostLikes,
  policy: can('post:like'),
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

The projected surface carries the same three names the declaration used, on top of
every action member above:

```ts
likePost.local(tx, { postId })            // the optimistic write, replayed on rebase
await likePost.server(ctx, { postId })    // the authoritative write
likePost.conflict                         // the declared strategy
```

`.server()` is not a shortcut past `invoke` — it calls the action's own callable, so
the input parse, the policy and the output parse all still run: an actor the policy
denies is denied there exactly as over HTTP. `.local()` is the only half that skips
the core, because it never leaves the client; keep it a pure function of `(tx, input)`
— no I/O, no clock, no randomness — since every rebase replays it.

`LocalTx` is the client write surface (`@ultimat3/realtime` implements it over OPFS
SQLite). Type your tables once: `declare module '@ultimat3/action' { interface
LocalTables { posts: PostRow } }`.

## Determinism + idempotency

`serializeOpenApi(buildOpenApi())` sorts keys at every depth, iterates the registry
name-sorted, and reads no clock, env or random source — same registry ⇒ same bytes ⇒
`x verify` can diff the spec and fail on `X_CONTRACT_DRIFT`.

## `rateLimit:` is the enforced limit

```ts
rateLimit: { limit: 5, windowMs: 600_000 },   // 5 held, one back every two minutes
```

One declaration, three places it lands: the bucket the limiter runs on (named after the action,
registered by `@ultimat3/http`'s `withRouteBuckets` when the route is mounted), the
`ratelimit-limit` header the caller reads, and `x-ultimate.rateLimit` in the OpenAPI operation.
`toBucket` is the only conversion — `capacity: limit`, `refillPerSecond: limit / (windowMs / 1000)`
— so the published numbers and the enforced ones cannot differ. An action that declares nothing
stays on the `default` bucket. An app that also configures `http.rateLimit.buckets.<actionName>`
with **different** numbers is `X_RATE_LIMIT_BUCKET_CONFLICT` at boot: neither source wins, because
the loser would go on being read as enforced.

`idempotent: true` + an `Idempotency-Key` header replays the first response
(`x-ultimate-replayed: 1`); a duplicate still in flight, or a reused key with a new
payload, is `X_IDEMPOTENCY_CONFLICT`. Store is swappable via `setIdempotencyStore()`.

## Audit — the seam, not the row

`audit: true` on any `action` or `mutator` sends **every attempt** — allowed, denied and failed
— to the installed `AuditSink`. Opt-in per declaration, never a global switch: a login and a
price change are not the same event, and the framework is not the thing that knows which of
them your business has to keep.

```ts
import { setAuditSink } from '@ultimat3/action';

setAuditSink({
  async write(record) { await record.ctx.db.auditRows.insert(myRow(record)); },
});
```

What the framework supplies is what it genuinely knows:

| Field | |
|---|---|
| `at` | when the attempt began, from `ctx.now()` — an instant, never a rendering |
| `action` / `mutator` | the registered name, and which primitive it was |
| `surface` | `server` \| `http` \| `mcp` \| `job` — the same price change over MCP is not the same event |
| `ctx` | the whole context: actor, `requestId`, `traceId`, locale, and the services a sink needs to write a row |
| `input` | the **parsed** input, or `undefined` when the parse is what failed — never the raw payload |
| `idempotencyKey` / `replayed` | the namespaced key, and whether this was a call rather than a write |
| `outcome` | `allowed` \| `denied` \| `failed` |
| `failure` | the `X_*` code and the thrown value, on every outcome but `allowed` |

What it does **not** supply: an audit entity, a schema, a retention policy, a storage backend, a
hash chain, a subject index, or an opinion on what "who" means under impersonation. Four apps
model those four ways; shipping one would make three of them wrong.

A denial is recorded because `invoke` wraps the whole path — `guard` throws **before** `handle`,
so nothing you could write around your own handler would ever see one. That is the reason this
lives in the framework and the row does not.

**Failure is loud, both ways.** `audit: true` with no sink installed is `X_AUDIT_SINK_MISSING`,
raised before the input parse — the one audit failure with no committed write behind it. A sink
that refuses a **successful** record is `X_AUDIT_SINK_FAILED`: the deliberate opposite of the
cache tier's `bestEffort`, because a dropped cache entry expires by TTL and the stack heals
itself while nothing ever re-derives an audit row that was never written. It is post-commit all
the same, and the error says so.

**Its `fix:` branches, because only one of the two is ever true.** Retrying is safe exactly when
*this invocation* went through the idempotency store — then the settled record replays and the
audit row is re-attempted without re-running the handler. It did not when the action is not
`idempotent`, **and it did not when the action is `idempotent` but the caller sent no
`Idempotency-Key`**: `invoke` reads `def.idempotent === true ? (options.idempotencyKey ?? null)
: null`, so both collapse to the same `null`. In that case the error says *do not retry* and
names the edit — telling a caller to re-run a committed mutator is worse than saying nothing.
`meta.replayable` carries the same fact to `--json`.

A sink that refuses a **denied or failed** record is logged as
`audit.sink.failed` and the original error still reaches the caller: answering
`X_AUDIT_SINK_FAILED` there would hide the `X_FORBIDDEN` from whoever has to act on it.

Your house rule goes in a wrapper, not in a config option — the same shape as `tenantEntity()`:

```ts
// apps/web/shared/base/audited-mutator.ts — the app's convention, written once
import { mutator, type MutatorDef } from '@ultimat3/action';
import type { StandardSchemaV1 } from '@ultimat3/schema';

/** Every write in this app is recorded and retryable — declared once, not at forty call sites. */
export const auditedMutator = <I extends StandardSchemaV1, O extends StandardSchemaV1>(
  def: MutatorDef<I, O>,
) => mutator({ ...def, audit: true, idempotent: true });
```

Nothing downstream can tell the difference: `isMutator()` is structural and `registerActions`
names the object in place, so every projection, the manifest and admin CRUD work on it exactly
as on a hand-written one.

The row it produces is the app's, and so is every question the framework refused to answer —
which fields, whose tenant, chained or not, kept how long:

```ts
setAuditSink({
  async write(record) {
    const { ctx } = record;                             // the services a sink needs to write a row
    const prev = await chainHead(ctx);                  // hash-chained: the app's choice
    await ctx.db.auditRows.insert({
      orgId: orgOf(ctx.actor),                          // tenancy: derived from the actor
      subjectId: subjectOf(record.action, record.input),// queryable by subject: the app's index
      actorId: impersonatorOf(ctx.actor) ?? ctx.actor.id,
      at: record.at, outcome: record.outcome, code: record.failure?.code ?? null,
      prevHash: prev, hash: await sha256(prev, record),
    });
  },
});
```

## Contract tests

`publishPost.contract()` returns three assertions. Run them; they throw `X_CONTRACT_DRIFT`.

| Assertion | Holds when |
|---|---|
| input schema rejects garbage | the invocation fails `X_INPUT_INVALID` — that code, not any failure |
| policy denies an anonymous actor | the invocation fails with an `ActionDeniedError` |
| OpenAPI document contains its operation | the derived path is in `buildOpenApi()` |

The denial assertion sends an input synthesized from `input:`'s own schema — required keys
only, formats included — because a payload the schema rejects never reaches a policy. It
asserts the denial, not `X_FORBIDDEN`: a denial carries the policy decision's own code, and
`can()` answers a null actor with `X_UNAUTHENTICATED`.

```ts
publishPost.contract({
  garbage: 42,                                 // what the input schema must reject
  input: { postId, orgId },                    // when the synthesized one cannot fit
  ctx: myCtx,                                  // default: an anonymous context
})
```

Pass `input:` when the schema carries a constraint the IR cannot invert (a bare `pattern`) or
when `row:` needs an id that resolves. Anything thrown *before* the policy decides is drift,
never a pass — the assertion says which code got in the way and names `input:` as the fix.

## Errors

| Code | When | Fix |
|---|---|---|
| `X_ACTION_DUPLICATE` | two actions registered under one name | rename one export |
| `X_ACTION_PATH_DUPLICATE` | two actions derive one HTTP path (`archiveOrder` / `archiveOrders`) | rename one export |
| `X_ACTION_POLICY_MISSING` | registration without `policy:` | add `policy: can('…')` |
| `X_ACTION_RATE_LIMIT_INVALID` | `rateLimit:` with a non-positive or non-finite half — `windowMs: 0` refills infinitely | make both positive, or delete the block |
| `X_INPUT_INVALID` | input failed the Standard Schema | `x actions describe <name> --json` |
| `X_IDEMPOTENCY_CONFLICT` | key reused with a new payload / still in flight | new key, or retry later |
| `X_CONTRACT_DRIFT` | client/server build skew, missing spec entry | reload / `x verify --contract` |
| `X_RPC_FAILED` | non-`problem+json` failure, or a body naming no `X_` code | check the gateway |
| `X_ACTION_UNREGISTERED` | projected before `registerActions()` ran | register at boot |
| `X_AUDIT_SINK_MISSING` | `audit: true` and no sink installed — raised before the input parse | `setAuditSink(yourSink)` at boot |
| `X_AUDIT_SINK_FAILED` | the sink refused the record for an attempt that **succeeded** | fix the sink — then retry the same `Idempotency-Key` if this call carried one, else reconcile by hand |

Denials re-throw the policy layer's own codes (`X_FORBIDDEN`, `X_UNAUTHENTICATED`) —
this package never invents an authz code.

The client does the same with the server's: a `problem+json` failure comes back as a
`RemoteActionError` keeping the code the server sent, marked `meta.origin: 'remote'` because
the browser bundle may never have registered it, and linked only to a page that exists — the
server's own `docs`/`type` when it sent an `http(s)` one, this build's registered link when it
knows the code, otherwise the error index. A per-code URL is never synthesized for a code
nothing here declares.

## Boundaries

Tier 3. Imports `@ultimat3/core`, `schema`, `cache`, `policy`, `http`. Never imports
`query`, `jobs`, `realtime` (same tier) or anything above it — those import *this*.
