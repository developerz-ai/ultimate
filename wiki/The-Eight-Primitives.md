# The eight primitives

Everything in the framework is one of these. `x g resource <name>` scaffolds a whole feature slice — an entity + repo, a policy, **two** actions (`create-*`, `archive-*`), a live query, a job, an app route, plus service, UI and i18n files — each with a test that **passes on the first run**. Not one of each: the slice emits no `mutator` and no `task`. Those have their own generators.

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

| Primitive | Declared in | Generator | Deep page |
|---|---|---|---|
| `entity` | `<feature>/entity.ts` | `x g entity <name>` | [Entities and migrations](Entities-And-Migrations) |
| `policy` | `<feature>/policy.ts` | `x g policy <name>` | [Policies and authz](Policies-And-Authz) |
| `action` | `api/` or `<feature>/actions.ts` | `x g action <name>` | [Actions](Actions) |
| `mutator` | `<feature>/actions.ts` | `x g mutator <name>` | [Realtime](Realtime) |
| `query` | `<feature>/live.ts` | `x g query <name>` | [Queries and live queries](Queries-And-Live-Queries) |
| `job` | `<feature>/jobs.ts` | `x g job <name>` | [Jobs and workflows](Jobs-And-Workflows) |
| `route` | a route folder's `config` export | `x g route <path>` | [Routes and render modes](Routes-And-Render-Modes) |
| `task` | `<feature>/jobs.ts` | `x g task <name>` | [Scheduled tasks](Scheduled-Tasks) |

## Every primitive projects itself

A primitive's surfaces are methods **on the primitive**, never free functions taking it. `publishPost.tool()`, not `toMcpTool(publishPost)`. Every declared field is lifted onto it, and the declaration object — the `handle`, the `sql`, the `server` — is not reachable from app code at all.

| Primitive | Its surface |
|---|---|
| `entity` | `$`-sigil members: `posts.$view([...])`, `posts.$parse(row)`, `posts.$assert(row)`, `posts.$migration()`. An entity *is* its columns, so the sigil keeps the namespace clear — `posts.name` is a column, `posts.$name` is the entity |
| `policy` | one signature, `({ actor, input, row, ctx })`, identical on every surface. `row` is required and nullable, never smuggled through `input` |
| `action` | `.as()` `.tool()` `.openapi()` `.client()` `.job()` `.contract()` `.describe()`, plus `.input` `.output` `.policy` `.mcp`. `handle` is not among them |
| `mutator` | everything `action` has, plus `.local()` `.server()` `.conflict` `.describeMutator()` |
| `query` | `.as()` `.live()` `.tool()` `.client()` `.describe()`, plus `.input` `.policy` `.cache` `.mcp` `.isLive`. `sql` is not among them |
| `job` | `.enqueue()` `.as()` `.describe()`, plus `.parse()` and `.idempotencyKeyFor()` |
| `route` | a normalized descriptor rather than methods — `meta()` always awaits, `budget` is always an object. A route declares no behaviour to project; `describeRoutes()` is the one route list |
| `task` | `.entries()` `.enqueue()` `.describe()` |

The declaration lives in a private store inside the package that runs it, and nothing exports a reader for it. So there is one execution path and one authz path structurally, not by convention: a hand-rolled look-alike carrying the right `kind` is `X_ACTION_FOREIGN` / `X_QUERY_FOREIGN`, never a registered primitive. Registration stamps the export name **in place**, so `import { publishPost }` is the object that projects once the app has booted — there is no second, differently-named twin to remember.

Each primitive's deep page carries the full member table.

## `entity`

A table + its domain type + invariants. The single source of the DB schema, the TS type, and the parse boundary.

| Aspect | Rule |
|---|---|
| Projects to | Postgres table, domain type, migration, repo (`postgresRepo`), admin screen, seed factory |
| Owns | column types, defaults, invariants, tenant column |
| Never | business logic, I/O, HTTP awareness, policy decisions |

## `policy`

An authz rule, evaluated in every surface.

```ts
policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId))
```

| Aspect | Rule |
|---|---|
| Projects to | HTTP guard, live-query row filter, job actor check, MCP tool gate, admin visibility |
| Owns | the yes/no and the denial reason |
| Never | mutate, query outside the declared repos, or return partial data (filter in the `query`) |

## `action`

A mutation or command, server-authoritative. Declared once, projected six ways.

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

| Aspect | Rule |
|---|---|
| Projects to | HTTP route, OpenAPI operation, typed client function, job handle, MCP tool, contract test |
| Owns | input/output contract, its policy, what it invalidates, MCP exposure |
| Never | read headers or cookies, render, authorize inside `handle`, do slow work inline |

## `mutator`

An action with an optimistic local twin. `local` runs client-side against the local store; `server` is authoritative. Same input, same name, both halves in one file.

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
| Owns | conflict strategy |
| Never | let `local` do I/O, randomness, or `Date.now()` — it must be replayable |

## `query`

A read; optionally live (subscribable).

```ts
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

## `job`

Durable background work, optionally multi-step. `idempotencyKey` is **required by the type**.

```ts
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
| Projects to | queue row, per-step persistence, retry schedule, dashboard entry, MCP `jobs.inspect` tool |
| Owns | retries, steps, concurrency class |
| Never | assume it runs once — assume at-least-once. Durable business state lives in your tables, never only in the payload |

## `route`

A URL + render mode + metadata + offline strategy.

```ts
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
| Never | touch the DB directly, hold business logic, or omit `meta.description` in `site/` — that is a build error (`X_SEO_NO_DESCRIPTION`; a missing title is `X_SEO_NO_TITLE`) |

Render modes: `static` (built once), `isr` (static + background regen), `ssr` (per-request), `stream` (shell flushed instantly, holes streamed — **default for app pages**), `spa` (shell only). Table in [Routes and render modes](Routes-And-Render-Modes).

## `task`

A scheduled trigger. Enqueues jobs; never does work itself.

```ts
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: () => [[sendDigest, {}]],
});
```

| Aspect | Rule |
|---|---|
| Projects to | scheduler entry (advisory-lock leader), next-run introspection, a `tasks` row in `x.manifest.json` |
| Owns | cron expression + explicit `tz` |
| Never | contain a handler body. If it does work, it is a `job` |

## Composition

```
entity ──> policy ──> action ──> job ──> task
   │          │         │
   │          └──> query (live) ──> route
   └──> mutator (action + local twin)
```

Feature slicing puts a feature's primitives in one folder, not one layer per app:

```
apps/web/app/<feature>/{entity,repo,service,actions,live,jobs,policy,ui}.ts
```

Every primitive emits its test beside it, and that test **passes on the first run** — a generator that emits a `TODO` has moved the work, not done it. What it pins is the distant invariant the primitive owns: a policy denial, an idempotency key, a budget. Extend it as the feature grows ([Testing](Testing)). Every primitive appears in `x.manifest.json`, so `x manifest --json` and the MCP `manifest.read` tool describe the whole app as data.

## The rule

**If a feature doesn't fit a primitive, it doesn't ship.** No ninth primitive, no escape-hatch `mode:` option, no plugin API in 1.0. Removing an alternative is a feature — ambiguity is the tax agents pay. Source: [`docs/idea/02-primitives.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/02-primitives.md).
