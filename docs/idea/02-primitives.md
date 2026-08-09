# Primitives

Eight. Everything in the framework is one of them. **If a feature doesn't fit a primitive, it doesn't ship.**

```
entity    — a table + its domain type + invariants
policy    — an authz rule, evaluated in every surface
action    — a mutation or command (server-authoritative)
mutator   — an action with an optimistic local twin (offline/realtime)
query     — a read; optionally live (subscribable)
job       — durable background work, optionally multi-step
route     — a URL + render mode + metadata + offline strategy
task      — a scheduled trigger (cron) that enqueues jobs
```

## `action` — the load-bearing one

A mutation or command, server-authoritative. Declared once.

```ts
// action — `t` comes from @ultimat3/action; an action file imports one package
import { action, t } from '@ultimat3/action';

export const publishPost = action({
  input:  t.object({ postId: t.uuid, orgId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: postPublish,                // declared once in the feature's policy.ts
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id });
    return post;
  },
});
```

`orgId` is in the `input` because the policy decides on it. A predicate is synchronous — see
[`policy`](#policy) — so authz reads the declaration, never the database. The policy object is
named, never re-declared inline: an action and its live query evaluate the same instance.

### Six generated artifacts

| # | Artifact | Derived from | Notes |
|---|---|---|---|
| 1 | **HTTP route** | name + `input` | `POST /_x/action/publish-post`, body parsed by `input`, errors are `UltimateError` JSON |
| 2 | **OpenAPI operation** | `input` + `output` + `mcp.description` | emitted into `x.manifest.json` and `openapi.json`; contract diff runs in `x verify` |
| 3 | **Typed client function** | `input` + `output` | `await publishPost({ postId })` in `app/`, no fetch, no codegen step to remember |
| 4 | **Job handle** | the whole declaration | `ctx.jobs.enqueue(publishPost, input)` runs the same handler durably; see [`04-jobs.md`](./04-jobs.md) |
| 5 | **MCP tool** | `mcp` + `input` + `policy` | one tool per exposed action, JSON Schema from `input`, authz unchanged |
| 6 | **Test scaffold** | `input` + `policy` | a contract test asserting schema round-trip and a denial test per policy branch |

Plus cache invalidation: `cache.invalidates` propagates to every tier in one hop ([`05-caching.md`](./05-caching.md)).

### One authz system

`policy` is evaluated for the HTTP call, the typed client call, the job execution, the MCP tool call, and the live query subscription — the same function, the same actor resolution, the same denial error.

> **Two authz systems is how every Meteor-like framework died.** Meteor had `allow`/`deny` rules for the client sync path and plain method bodies for the server path; the two drifted, and the drift *was* the security model. Anything that lets an agent expose data through a second door — a "public" MCP tool, an "internal" RPC, a sync rule table — is a rejected design, not a config option.

### `action` must never

- read the request object, headers, or cookies directly — actor and tenant come from `ctx`
- render, redirect, or return HTML
- perform its own authorization inside `handle` — that belongs in `policy`
- do slow work inline — enqueue a `job`
- be defined outside `api/` or a feature's `actions.ts`

## `entity`

A table + its domain type + invariants. The single source of the DB schema, the TS type, and the parse boundary.

| Aspect | Rule |
|---|---|
| Projects to | Drizzle table, domain type, migration, repo type, admin screen, seed factory |
| Owns | column types, defaults, invariants, tenant column |
| Never | business logic, I/O, HTTP awareness, policy decisions |

## `policy`

An authz rule, evaluated in every surface. A predicate always receives `{ input, actor, row, ctx }`,
whichever surface called it.

```ts
// decides on input — `row` is null
export const postCreate = can<PostScope>('post:create',
  ({ actor, input }) => actor?.orgId === input.orgId);

// decides about a row the SURFACE already loaded — a live query passes one per change event
export const postPublish = can<PostScope, PostRow>('post:publish',
  ({ actor, input, row }) =>
    actor?.orgId === input.orgId && (row === null || ownsPost(actor, row)));
```

**Predicates are synchronous, and that is the constraint everything else follows from.** A live query
re-evaluates one per subscriber on every change, so an `await` here would be one database round trip
per row per connected client — a 10k-watcher feed would cost 10k reads per write. The caller loads
what a rule needs and passes it in: tenancy travels in `input`, an already-loaded row in `row`. Never
reach for a row through `input`.

| Aspect | Rule |
|---|---|
| Projects to | HTTP guard, live-query row filter, job actor check, MCP tool gate, admin visibility |
| Owns | the yes/no and the denial reason |
| Never | mutate, perform I/O of any kind, or return partial data (filter in the `query`) |

## `mutator`

An action with an optimistic local twin. `local` runs client-side against the local store; `server` is authoritative. Same input, same name, both halves in one file.

```ts
// mutator (action + optimistic local twin)
export const toggleLike = mutator({
  input:  t.object({ postId: t.uuid, orgId: t.uuid }),
  output: PostView,
  policy: postLike,
  local(tx, { postId }) { tx.posts.update(postId, (p) => ({ likeCount: p.likeCount + 1 })); },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
```

| Aspect | Rule |
|---|---|
| Projects to | everything `action` does, plus a local-store transaction and a rebase entry |
| Owns | conflict strategy |
| Never | let `local` do I/O, randomness, or `Date.now()` — it must be replayable |

## `query`

A read; optionally live (subscribable).

```ts
// query — `t` and `from` come from @ultimat3/query; a query file imports one package
import { from, query, t } from '@ultimat3/query';

export const liveFeed = query({
  input: t.object({ orgId: t.uuid, limit: t.number.int().min(1).max(50).default(50) }),
  policy: feedRead,
  live: true,
  sql: ({ orgId, limit }) =>
    from<PostSummary>('posts', () => repo.feedPage(orgId, limit))
      .where({ orgId }).orderBy('createdAt', 'desc').limit(limit),
});
```

| Aspect | Rule |
|---|---|
| Projects to | HTTP GET, typed client hook, live subscription (`live: true`), cache entry with tags, MCP read tool |
| Owns | shape + row-level filtering |
| Never | write, enqueue, or send mail. `live: true` requires a deterministic, bounded `sql` |

## `job`

Durable background work, optionally multi-step. `idempotencyKey` is **required by the type**.

```ts
// job — `t` comes from @ultimat3/jobs; a job file imports one package
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';

export const onboardOrg = job({
  input: t.object({ orgId: t.uuid, to: t.email, locale: t.locale }),
  idempotencyKey: ({ orgId }) => `onboard:${orgId}`,   // REQUIRED by the type
  retry: { attempts: 5, backoff: 'exponential' },
  async run({ input, step, ctx }) {
    const org = await step.run('provision', () => ctx.orgs.provision(input.orgId));
    const to  = { to: input.to, locale: input.locale };
    await step.run('welcome-email', () => send(welcomeEmail, org, to));
    await step.sleep('3d');
    await step.run('nudge', () => send(nudgeEmail, org, to));
  },
});
```

The recipient rides in the payload, not in `ctx`: a run resumed three days later must not depend on
a request context that stopped existing the moment the signup returned. Enqueue through the handle —
`onboardOrg.enqueue(input)` — so the retry policy, the key and the queue come from the declaration
rather than from a call site.

| Aspect | Rule |
|---|---|
| Projects to | queue row, per-step persistence, retry schedule, dashboard entry, MCP `jobs.status` tool |
| Owns | retries, steps, concurrency class |
| Never | assume it runs once — assume at-least-once. Durable business state lives in your tables, never only in the payload |

## `route`

A URL + render mode + metadata + offline strategy.

```ts
// route
export const config = defineRoute({
  render:     'isr',                  // static | isr | ssr | stream | spa
  revalidate: { tags: [tag.post] },
  prerender:  () => db.posts.slugs(),
  offline:    'precache',             // precache | runtime | network-only
  hydrate:    'visible',              // idle | visible | interaction | never
  budget:     { js: '40kb', lcp: 2000 },
  meta:       ({ post }) => ({ title: post.title, description: post.excerpt,
                               og: { image: post.cover }, ld: ld.Article(post) }),
});
```

| Aspect | Rule |
|---|---|
| Projects to | router entry, prerender list, `sw.js` precache/runtime rule, sitemap + RSS row, `<head>` + JSON-LD, per-route budget check |
| Owns | render mode, hydration timing, metadata, offline strategy |
| Never | touch the DB directly, hold business logic, or omit `meta.description` in `site/` — that is a build error |

## `task`

A scheduled trigger. Enqueues jobs; never does work itself.

```ts
// task (cron)
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: () => [[sendDigest, { runDate: localDateIn(systemClock.now(), 'UTC') }]],
});
```

The payload is not empty, and that is the point: a job's `idempotencyKey` derives from `input`
alone, so `{}` would make every night's run collide with the first one and the digest would send
exactly once, ever.

| Aspect | Rule |
|---|---|
| Projects to | scheduler entry (advisory-lock leader), next-run introspection, MCP `tasks.list` |
| Owns | cron expression + explicit `tz` |
| Never | contain a handler body. If it does work, it is a `job` |

## Composition

`entity` → `policy` → `action` → `job` → `task`; `query` (optionally live) → `route`; `mutator` = `action` + local twin. Feature-sliced, one of each per folder — never one layer per app:

```
apps/web/app/<feature>/{entity,repo,service,actions,mutator,live,jobs,policy,ui}.ts
```
