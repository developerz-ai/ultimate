---
title: The eight primitives
menu: true
nav: Primitives
description: Entity, policy, action, mutator, query, job, route, task — the whole vocabulary of the framework, with the canonical shape of each.
lede: Everything in the framework is one of eight things. If a feature doesn't fit a primitive, it doesn't ship.
updated: 2026-07-26
---

```text
entity    — a table + its domain type + invariants
policy    — an authz rule, evaluated in every surface
action    — a mutation or command (server-authoritative)
mutator   — an action with an optimistic local twin (offline/realtime)
query     — a read; optionally live (subscribable)
job       — durable background work, optionally multi-step
route     — a URL + render mode + metadata + offline strategy
task      — a scheduled trigger (cron) that enqueues jobs
```

## entity

A table + its domain type + invariants. The single source of the DB schema, the TS type, and
the parse boundary.

| Aspect | Rule |
|---|---|
| Projects to | Drizzle table, domain type, migration, repo type, admin screen, seed factory |
| Owns | column types, defaults, invariants, tenant column |
| Never | business logic, I/O, HTTP awareness, policy decisions |

## policy

An authz rule, evaluated in every surface.

```ts
policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId))
```

| Aspect | Rule |
|---|---|
| Projects to | HTTP guard, live-query row filter, job actor check, MCP tool gate, admin visibility |
| Owns | the yes/no and the denial reason |
| Never | mutate, query outside the declared repos, or return partial data (filter in the `query`) |

## action

The load-bearing one. A mutation or command, server-authoritative, declared once.

```ts
// action
export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await ctx.jobs.enqueue(notifySubscribers, { postId: post.id });
    return post;
  },
});
```

Six artifacts fall out of that declaration — HTTP route, OpenAPI operation, typed client
function, job handle, MCP tool, test scaffold — plus cache invalidation that reaches every
tier in one hop.

An `action` must never read the request object, headers or cookies directly; render, redirect
or return HTML; authorise inside `handle`; do slow work inline; or live outside `api/` or a
feature's `actions.ts`.

## mutator

An action with an optimistic local twin. `local` runs client-side against the local store;
`server` is authoritative. Same input, same name, both halves in one file.

```ts
// mutator (action + optimistic local twin)
export const toggleLike = mutator({
  local(tx, { postId }) { tx.posts.update(postId, (p) => ({ likes: p.likes + 1 })); },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
```

| Aspect | Rule |
|---|---|
| Projects to | everything `action` does, plus a local-store transaction and a rebase entry |
| Owns | conflict strategy |
| Never | let `local` do I/O, randomness, or `Date.now()` — it must be replayable |

## query

A read; optionally live (subscribable).

```ts
// query
export const liveFeed = query({
  input: t.object({ orgId: t.uuid }),
  policy: can('feed:read'),
  live: true,
  sql: ({ orgId }) => db.posts.where({ orgId }).orderBy('createdAt').limit(50),
});
```

| Aspect | Rule |
|---|---|
| Projects to | HTTP GET, typed client hook, live subscription (`live: true`), cache entry with tags, MCP read tool |
| Owns | shape + row-level filtering |
| Never | write, enqueue, or send mail. `live: true` requires a deterministic, bounded `sql` |

## job

Durable background work, optionally multi-step. `idempotencyKey` is **required by the type**.

```ts
// job
export const onboardOrg = job({
  input: t.object({ orgId: t.uuid }),
  idempotencyKey: ({ orgId }) => `onboard:${orgId}`,   // REQUIRED by the type
  retry: { attempts: 5, backoff: 'exponential' },
  async run({ input, step, ctx }) {
    const org = await step.run('provision', () => ctx.orgs.provision(input.orgId));
    await step.run('welcome-email', () => ctx.mail.send(welcomeEmail, org));
    await step.sleep('3d');
    await step.run('nudge', () => ctx.mail.send(nudgeEmail, org));
  },
});
```

| Aspect | Rule |
|---|---|
| Projects to | queue row, per-step persistence, retry schedule, dashboard entry, MCP `jobs.status` tool |
| Owns | retries, steps, concurrency class |
| Never | assume it runs once — assume at-least-once. Durable business state lives in your tables, never only in the payload |

## route

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

## task

A scheduled trigger. Enqueues jobs; never does work itself.

```ts
// task (cron)
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: () => [[sendDigest, {}]],
});
```

| Aspect | Rule |
|---|---|
| Projects to | scheduler entry (advisory-lock leader), next-run introspection, MCP `tasks.list` |
| Owns | cron expression + explicit `tz` |
| Never | contain a handler body. If it does work, it is a `job` |

## Composition

```text
entity ──> policy ──> action ──> job ──> task
   │          │         │
   │          └──> query (live) ──> route
   └──> mutator (action + local twin)
```

Feature slicing puts one of each in a folder, not one layer per app:

```text
apps/web/app/<feature>/{entity,repo,service,actions,live,jobs,policy,ui}.ts
```

:::info deeper
The wiki carries the exhaustive field-by-field reference:
[Actions](https://github.com/developerz-ai/ultimate/wiki/Actions) ·
[Entities and migrations](https://github.com/developerz-ai/ultimate/wiki/Entities-And-Migrations) ·
[Policies and authz](https://github.com/developerz-ai/ultimate/wiki/Policies-And-Authz) ·
[Queries and live queries](https://github.com/developerz-ai/ultimate/wiki/Queries-And-Live-Queries)
:::
