# Adding a feature

The loop, end to end. Worked example: **posts, with publishing, a live feed, and a notification job.** Every command is runnable as written.

## Checklist

| # | Step | Command | Lands in |
|---|---|---|---|
| 0 | Pick the surface | — | see the table below |
| 1 | Generate the slice | `x g resource post --live --admin` | 16 files ([`12-generated-app.md`](./12-generated-app.md)) |
| 2 | Entity + invariants | edit | `packages/db/src/schema/posts.ts`, `apps/web/app/posts/entity.ts` |
| 3 | Migration | `x db gen "create posts"` | `packages/db/migrations/NNNN_create_posts.sql` |
| 4 | Apply | `x db apply` | the dev database |
| 5 | Policy | edit | `apps/web/app/posts/policy.ts` |
| 6 | Service | edit | `apps/web/app/posts/service.ts` |
| 7 | Action | edit | `apps/web/api/posts.ts` |
| 8 | Query (live?) | edit | `apps/web/app/posts/live.ts` |
| 9 | Job | edit | `apps/web/app/posts/jobs.ts` |
| 10 | Route + meta + offline | edit | `apps/web/app/posts/page.tsx` |
| 11 | i18n keys | `x i18n add post.publish` | `packages/i18n/{en,es}/posts.json` |
| 12 | Tests | fill the scaffolds | `*.test.ts` next to each source |
| 13 | Manifest | `x manifest write` | `x.manifest.json`, `openapi.json` |
| 14 | Gate | `x verify` | exit 0 = shippable |

## 0. Pick the surface

| The feature is | Surface | Default render | Auth |
|---|---|---|---|
| Anonymous, crawler-visible, SEO-critical | `apps/web/site/` | `static` / `isr` | none |
| Behind sign-in, interactive, realtime | `apps/web/app/` | `stream` | required |
| Machine-only (agents, the typed client, webhooks) | `apps/web/api/` | none | policy per action |
| Needed by both | `apps/web/shared/` (leaf, must stay small) | n/a | n/a |

Posts have a public blog page **and** an authed editor, so: entity/service/policy in the `app/` slice, actions in `api/`, the public page in `site/`. `site/` may never import `app/` ([`02-boundaries.md`](./02-boundaries.md)).

## 1. Generate

```bash
x g resource post --live --admin
```

Generates schema, entity, repo, service, policy, actions, live query, job stub, components, route, i18n keys, admin screens, MCP entries, and failing test scaffolds. Everything below is *editing* generated files — not creating them.

## 2. Entity + invariants

```ts
// packages/db/src/schema/posts.ts
export const posts = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().references(() => orgs.id, { onDelete: 'cascade' }).tenant(),
    slug: text({ max: SLUG_MAX }),
    title: text({ max: TITLE_MAX }),
    excerpt: text({ max: EXCERPT_MAX }),
    cover: url().nullable(),
    publishedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
  },
  invariants: [
    invariant('post_title_present', (c) => c.title.trimmed().minLength(1)),
    invariant('post_slug_unique', (c) => c.unique(['slug'])),
  ],
  indexes: [{ on: ['orgId', 'publishedAt'], order: 'desc' }],
});
```

```ts
// apps/web/app/posts/entity.ts
export const PostView = posts.$view(['id', 'title', 'excerpt', 'cover', 'publishedAt']);
```

- `entity(name, init)` is name-first; `init` is `{ columns, tenant?, primaryKey?, invariants?, indexes?, tags? }`. `invariants` is plural.
- Tenancy is `.tenant()` on the column or `tenant: 'orgId'` in `init`; with neither, a column named `orgId` is inferred. The repo injects the filter, you never write it.
- Each invariant emits its own `CHECK`/`UNIQUE` automatically; only `c.satisfies(fn, [...])` and `c.matches(fn)` stay TS-only, and a rule the DB does not know is a rule a migration can violate.
- Money → `money()`; dates → `timestamp()` (always `timestamptz`) ([`10-cross-cutting.md`](./10-cross-cutting.md)).

## 3–4. Migration

```bash
x db gen "create posts"     # diffs schema vs. the migration ledger
x db apply                  # applies to the dev database
x db status --json          # confirm: no drift
```

Drift in either direction is `X_DB_DRIFT` with the exact table and column ([`06-data-layer.md`](./06-data-layer.md)).

## 5. Policy

```ts
// apps/web/app/posts/policy.ts
export const canReadPost    = can('post:read',    ({ actor, row }) => row.orgId === actor.orgId);
export const canPublishPost = can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId));
```

- One policy, every surface: HTTP, typed client, job, MCP tool, live subscription — the same function.
- Pure. No I/O; a policy needing a lookup declares the repo and the lookup is memoized.
- The denial reason is a policy id, never row data — a reason that leaks is a leak.
- Never authorize inside `handle`. That is a second door.

## 6. Service

```ts
// apps/web/app/posts/service.ts — business logic, composed from repos
export async function publish(ctx: Ctx, postId: string): Promise<Post> {
  const post = await ctx.posts.byId(postId);
  if (!post) throw new PostError({ code: 'X_POST_NOT_FOUND', cause: `post ${postId}`,
                                   fix: 'check the id, or list posts with x db query' });
  return ctx.posts.update(postId, { publishedAt: ctx.now() });
}
```

No HTTP imports — that is what lets the same rule run in a job, a cron task, and an MCP tool.

## 7. Action

```ts
// apps/web/api/posts.ts
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

| Field | Why it is not optional in practice |
|---|---|
| `input` / `output` | drive parse, types, OpenAPI, MCP schema, and the typed client ([`05-type-chain.md`](./05-type-chain.md)) |
| `policy` | the only authz. Runs before the handler, after validation |
| `cache.invalidates` | one hop reaches memo, LRU, Redis, ISR, CDN ([`09-rendering-internals.md`](./09-rendering-internals.md)) |
| `mcp` | one line makes it an agent-callable tool with identical authz ([`11-ai-surface.md`](./11-ai-surface.md)) |
| `<job>.enqueue` | joins the request transaction — outbox by default ([`08-jobs-internals.md`](./08-jobs-internals.md)) |

Actions must never read headers/cookies, render, redirect, authorize inside `handle`, or do slow work inline.

## 8. Query — live or not?

```ts
// apps/web/app/posts/live.ts
export const liveFeed = query({
  input: t.object({ orgId: t.uuid }),
  policy: can('feed:read'),
  live: true,
  sql: ({ orgId }) => db.posts.where({ orgId }).orderBy('createdAt').limit(50),
});
```

- `live: false` — the data changes on user action only; a refetch after a mutation is enough.
- `live: true` — someone else's write must appear without a refresh.
- `live: true, persist: true` — writes must survive being offline (tier 3).

`live: true` requires a total order + `limit`, and `REPLICA IDENTITY FULL` on the table (the generated migration adds it). Check the matcher class before shipping: `x live explain liveFeed --json`.

## 9. Job

```ts
// apps/web/app/posts/jobs.ts
export const notifySubscribers = job({
  input: t.object({ postId: t.uuid }),
  idempotencyKey: ({ postId }) => `notify:${postId}`,   // REQUIRED by the type
  retry: { attempts: 5, backoff: 'exponential' },
  concurrency: { key: ({ postId }) => postId, limit: 1 },
  async run({ input, step, ctx }) {
    const subs = await step.run('load-subscribers', () => ctx.subs.forPost(input.postId));
    await step.run('send', () => ctx.mail.sendBatch(newPostEmail, subs));
  },
});
```

- `idempotencyKey`: compile error if omitted; deterministic from `input` only.
- The step is the retry unit — a failure in `send` replays `load-subscribers` from storage.
- Payload is a pointer (`{ postId }`), never a record. Durable business state lives in your tables.
- `step.sleep('3d')` releases the worker; the job resumes in a fresh process.

## 10. Route + meta + offline

```ts
// apps/web/site/blog/[slug]/page.tsx
export const config = defineRoute({
  render:     'isr',
  revalidate: { tags: [tag.post] },
  prerender:  () => db.posts.slugs(),
  offline:    'precache',
  hydrate:    'visible',
  budget:     { js: '40kb', lcp: 2000 },
  meta:       ({ post }) => ({ title: post.title, description: post.excerpt,
                               og: { image: post.cover }, ld: ld.Article(post) }),
});
```

Build errors: missing `meta.title` → `X_SEO_NO_TITLE`; missing or out-of-range (50–160 char) `meta.description` on a `site/` route → `X_SEO_NO_DESCRIPTION`; over budget → `X_BUDGET_EXCEEDED` naming the import chain; a contradiction like `offline: 'precache'` on `ssr` → `X_SW_UNCACHEABLE`. A `site/` route emitting JS must declare `hydrate` explicitly.

## 11. i18n keys

```bash
x i18n add post.publish post.draft post.published-at
x i18n check --json          # missing in any locale = X_I18N_MISSING_KEY
```

Zero hardcoded user-facing strings — a literal outside `t()` is a build error. Plurals come from CLDR: define every category the locale needs ([`10-cross-cutting.md`](./10-cross-cutting.md)).

## 12. Tests

Fill the scaffolds; they fail until you do.

```bash
x test contract apps/web/api/posts.contract.test.ts
x test job      apps/web/app/posts/jobs.test.ts
x test live     apps/web/app/posts/live.test.ts
x test e2e      apps/web/site/blog
```

The assertion that matters per type: **contract** — a non-owner is denied with `X_POLICY_DENIED`; **live** — a policy-failing row is never delivered; **job** — a replayed step's `executions` stays 1; **e2e** — the streamed hole fills and the offline fallback renders.

## 13–14. Manifest + gate

```bash
x manifest write
x verify
x verify --json | jq '.checks[] | select(.ok == false)'
```

Green = shippable. There is no `--skip`.

## When it fails

| Error | Meaning | Command |
|---|---|---|
| `X_BOUNDARY_VIOLATION` | an import crossed a surface or tier; `data.chain` shows the path | `x fix boundary <file>` |
| `X_DB_DRIFT` | schema ≠ migrations | `x db gen "<name>"` |
| `X_POLICY_DENIED` in a test | the policy is right and the fixture actor is wrong, or vice versa | `x policies list --json` |
| `X_I18N_MISSING_KEY` | a key missing in some locale | `x i18n add <key>` |
| `X_BUDGET_EXCEEDED` | a route got heavier; `data.cause` names the import | `x fix boundary <file>` |
| `X_QUERY_UNBOUNDED` | live query without total order + `limit` | add `orderBy` tiebreak + `limit` |
| `X_JOB_NO_IDEMPOTENCY_KEY` | job declared without a key | add `idempotencyKey` |
| `X_MANIFEST_STALE` | manifest differs from the code | `x manifest write` |
| `X_CACHE_UNTAGGED_QUERY` | a cached query no tag covers | add the tag to `cache.invalidates` |
| anything else | every error carries a `fix:` | `x errors explain <CODE>` |

## Rules that keep the loop short

- One way to do each thing. If two shapes look valid, one of them is wrong.
- Never write a second authz check. `policy` is the only one.
- Never enqueue outside a transaction, never paginate with an offset, never format a date without a zone, never put money in a float.
- Never hand-edit a generated artifact (`sw.js`, `x.manifest.json`, `openapi.json`, migrations already applied).
- Read the `fix:` line. It is a command, and it is meant to be run.
