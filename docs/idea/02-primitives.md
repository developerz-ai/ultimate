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
  row:    ({ input, ctx }) => ctx.posts.authorship(input.postId),  // once, before the guard
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: input.orgId });
    return post;
  },
});
```

`orgId` is in the `input` because the policy decides on it. `row` is the async half authz is not
allowed to have: the predicate stays synchronous — see [`policy`](#policy) — and the framework loads
the row once per invocation, after the input parse and before the guard. Omit `row` and the rule
gets `null`, which a row-level rule must read as a denial. The policy object is named, never
re-declared inline: an action and its live query evaluate the same instance.

`mcp.description` is the one string in a declaration that does **not** go through `t()`. It is the
OpenAPI operation `summary` as well as the tool description, and `openapi.json` is bytes `x verify`
diffs — a locale-dependent contract artifact is a gate that fails on the machine that generated it.
Localised agent-facing text is a separate, locale-resolved projection, not a second field here.

### Six generated artifacts

| # | Artifact | Derived from | Notes |
|---|---|---|---|
| 1 | **HTTP route** | name + `input` | `POST /api/posts/publish` — verb first, pluralized resource after. Body parsed by `input`, errors are `UltimateError` JSON |
| 2 | **OpenAPI operation** | `input` + `output` + `mcp.description` | emitted into `x.manifest.json` and `openapi.json`; contract diff runs in `x verify` |
| 3 | **Typed client function** | `input` + `output` | `await publishPost({ postId, orgId })` in `app/`, no fetch, no codegen step to remember |
| 4 | **Job handle** | the whole declaration | `publishPost.job()` — the action's `input`, a namespaced job name, an `idempotencyKey` derived from the payload, and an `invoke` that lands in the same execution core with `surface: 'job'`. It is the shape a queue driver *registers*, not one you call: `.enqueue()` belongs to a declared `job` like `notifySubscribers` above; see [`04-jobs.md`](./04-jobs.md) |
| 5 | **MCP tool** | `mcp` + `input` + `policy` | one tool per exposed action, JSON Schema from `input`, authz unchanged |
| 6 | **Contract tests** | `input` + `policy` | `.contract()` runs what every action owes — garbage input rejected, anonymous actor denied, operation present in OpenAPI — and `x g` emits a cross-org denial through `.as()` beside it; all passing on the first run |

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

A table + its domain type + invariants. The single source of the DB schema, the TS type, and the parse boundary. The row type is **derived** from the columns — there is no second declaration of the same shape to keep in sync.

```ts
export const posts = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().references(() => orgs.id, { onDelete: 'cascade' }).tenant(),
    title: text({ max: TITLE_MAX }),
    status: enumerated(POST_STATUSES).default('draft'),
    likeCount: integer().default(0),
    deletedAt: timestamp().nullable(),   // presence alone makes the entity soft-deletable
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  tenant: 'orgId',      // said out loud; inferred from `.tenant()` or an `orgId` column if omitted
  invariants: (c) => [
    invariant('post_title_present', c.title.trimmed().minLength(1)),
    invariant('post_like_count_non_negative', c.likeCount.atLeast(0)),
  ],
  indexes: [{ on: ['orgId', 'status'] }],
});
```

`invariants` is one callback over the whole list, and each entry is a named `invariant(name, expr)`
— the name becomes the constraint name (`posts_post_title_present_check`), which is what makes a
violation point at a rule instead of at a column. `c` is typed from the `columns` above it, so
`c.titel` is a compile error naming `title`, never a `ColumnExpr | undefined` to assert away.

| Aspect | Rule |
|---|---|
| Projects to | SQL DDL, domain type (`typeof posts.$row`), migration, repo type, admin screen, seed factory |
| Owns | column types, defaults, invariants, tenant column |
| Never | business logic, I/O, HTTP awareness, policy decisions |

## `policy`

An authz rule, evaluated in every surface. A predicate always receives `{ input, actor, row, ctx }`,
whichever surface called it.

```ts
// decides on input alone — `row` arrives as null and the rule never reads it
export const postCreate = can<PostScope>('post:create',
  ({ actor, input }) => actor?.orgId === input.orgId);

// decides about a row — null is a DENIAL, never a pass
export const postPublish = can<PostScope, PostRow>('post:publish',
  ({ actor, input, row }) =>
    actor?.orgId === input.orgId && row !== null && ownsPost(actor, row));
```

**Predicates are synchronous, and that is the constraint everything else follows from.** A live query
re-evaluates one per subscriber on every change, so an `await` here would be one database round trip
per row per connected client — a 10k-watcher feed would cost 10k reads per write. The caller loads
what a rule needs and passes it in: tenancy travels in `input`, the row through the surface. A live
query passes one per change event; an action declares a `row` loader, which the framework runs once
per invocation between the input parse and the guard. Never reach for a row through `input`.

**A rule that reads `row` fails closed on `null`.** `row === null || ownsPost(actor, row)` reads like
a convenience for the surfaces that have no row, and it is a bypass: "no loader declared" and "row
not found" are the same `null`, so any same-org holder of `post:publish` publishes a colleague's
draft by calling an action that never loaded one. `null` is the absence of evidence, and absent
evidence denies. A rule whose row branch adds nothing the input branch has not already decided — a
feed subscription re-checking the org it already filtered on — may allow `null`, and should say in a
comment why that is not this mistake.

| Aspect | Rule |
|---|---|
| Projects to | HTTP guard, live-query row filter, job actor check, MCP tool gate, admin visibility |
| Owns | the yes/no and the denial reason |
| Never | mutate, perform I/O of any kind, or return partial data (filter in the `query`) |

## `mutator`

An action with an optimistic local twin. `local` runs client-side against the local store; `server` is authoritative. Same input, same name, both halves in one file.

```ts
// mutator (action + optimistic local twin)
export const likePost = mutator({
  input:  t.object({ postId: t.uuid, orgId: t.uuid }),
  output: PostView,
  policy: postLike,
  // Convergent, not incremental: applying it N times equals applying it once.
  local(tx, { postId }) {
    tx.posts.update(postId, (p) =>
      p.likedByMe ? {} : { likedByMe: true, likeCount: p.likeCount + 1 });
  },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
```

**Replayable means convergent, not merely deterministic.** `local` re-runs on every rebase, so
`likeCount: p.likeCount + 1` — pure, clock-free, random-free — still counts one member's like three
times on a device that replayed its queue three times. The fix is to derive the counter from a flag
the mutation itself sets, so the second application is a no-op. `likedByMe` is per-device state
about the acting member, not a column: the authoritative row is a `likes` composite key, and the
server half converges for the same reason — insert-or-ignore on that key, then recount from it.

| Aspect | Rule |
|---|---|
| Projects to | everything `action` does, plus a local-store transaction and a rebase entry |
| Owns | conflict strategy |
| Never | let `local` do I/O, randomness, or `Date.now()`, or write a value that depends on how many times it has already run |

## `query`

A read; optionally live (subscribable).

```ts
// query — `t` and `from` come from @ultimat3/query; a query file imports one framework package
import { from, query, t } from '@ultimat3/query';
import { orgId as toOrgId } from '@myapp/domain';   // uuid string in, branded OrgId out

export const liveFeed = query({
  input: t.object({ orgId: t.uuid, limit: t.number.int().min(1).max(50).default(50) }),
  policy: feedRead,
  live: true,
  sql: ({ orgId, limit }) =>
    from<PostSummary>('posts', () => repo.feedPage(toOrgId(orgId), limit))
      .where({ orgId })
      .orderBy('createdAt', 'desc')
      .orderBy('id')                // the tail key — see below
      .limit(limit),
});
```

**Every order ends with a key that is unique in the row shape.** The matcher computes a row's
insertion position, and whether a change moved it, from this `orderBy` list and nothing else.
`createdAt desc` alone is a partial order: two posts written in the same millisecond may swap places
between evaluations, and a bounded page then drops or repeats one at the limit boundary. The tail
key is what makes the order total, so a live read is stable and a cursor over it is resumable.

| Aspect | Rule |
|---|---|
| Projects to | HTTP GET, typed client hook, live subscription (`live: true`), cache entry with tags, MCP read tool |
| Owns | shape + row-level filtering |
| Never | write, enqueue, or send mail. `live: true` requires a deterministic, bounded `sql` whose final sort key is unique |

## `job`

Durable background work, optionally multi-step. `idempotencyKey` is **required by the type**.

```ts
// job — `t` comes from @ultimat3/jobs; a job file imports one package
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';

export const onboardOrg = job({
  input: t.object({ orgId: t.uuid, to: t.email, locale: t.locale }),
  tenant: ({ orgId }) => orgId,                       // REQUIRED by the type
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
  load:       ({ params }) => db.posts.bySlug(params.slug),   // once per render
  meta:       ({ data, url }) => ({ title: data.title, description: data.excerpt,
                                    og: { image: data.cover }, canonical: url,
                                    ld: ld.Article(data) }),
});

export function Page(props: { data: Post }) { /* the SAME object meta was given */ }
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
  enqueue: (occurrenceMs) => [[sendDigest, { runDate: localDateIn(new Date(occurrenceMs), 'UTC') }]],
});
```

The payload is not empty, and that is the point: a job's `idempotencyKey` derives from `input`
alone, so `{}` would make every night's run collide with the first one and the digest would send
exactly once, ever.

`enqueue` is handed the instant of the **occurrence** it is firing for, and never reads the clock,
because catch-up exists: a tick dispatched late — or replayed for a missed occurrence — has a wall
clock that no longer matches the occurrence. `systemClock.now()` there dates the 03:00 digest to the
following day, which becomes a wrong idempotency key that nothing downstream catches.

| Aspect | Rule |
|---|---|
| Projects to | scheduler entry (lease-row leader), next-run introspection, MCP `tasks.list` |
| Owns | cron expression + explicit `tz` |
| Never | contain a handler body. If it does work, it is a `job` |

## Composition

`entity` → `policy` → `action` → `job` → `task`; `query` (optionally live) → `route`; `mutator` = `action` + local twin. Feature-sliced, one of each per folder — never one layer per app:

```
apps/web/app/<feature>/{entity,repo,service,actions,mutator,live,jobs,policy,ui}.ts
```
