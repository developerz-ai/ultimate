# Adding a feature

The loop, end to end. Worked example: **posts, with publishing, a live feed, and a notification job.** Every command is runnable as written.

## Checklist

| # | Step | Command | Lands in |
|---|---|---|---|
| 0 | Pick the surface | — | see the table below |
| 1 | Generate the slice | `x g resource post --live --admin` | 16 files ([`12-generated-app.md`](./12-generated-app.md)) |
| 2 | Entity + invariants | edit | `packages/db/src/schema/posts.ts`, `apps/web/app/posts/entity.ts` |
| 3 | Migration | `x db gen "create posts"` | `packages/db/migrations/NNNN_create_posts.sql` |
| 4 | Apply | `x db migrate` | the dev database |
| 5 | Policy | edit | `apps/web/app/posts/policy.ts` |
| 6 | Service | edit | `apps/web/app/posts/service.ts` |
| 7 | Action | edit | `apps/web/app/posts/actions.ts` |
| 8 | Query (live?) | edit | `apps/web/app/posts/live.ts` |
| 9 | Job | edit | `apps/web/app/posts/jobs.ts` |
| 10 | Route + meta + offline | edit | `apps/web/site/blog/[slug]/page.tsx` |
| 11 | i18n keys | `x i18n sync es` | `packages/i18n/catalogs/{en,es}.json` (merged in) |
| 12 | Tests | fill the scaffolds | `*.test.ts` next to each source |
| 13 | Manifest | `x manifest` | `x.manifest.json`, `openapi.json` |
| 14 | Gate | `x verify` | exit 0 = shippable |

## 0. Pick the surface

| The feature is | Surface | Default render | Auth |
|---|---|---|---|
| Anonymous, crawler-visible, SEO-critical | `apps/web/site/` | `static` / `isr` | none |
| Behind sign-in, interactive, realtime | `apps/web/app/` | `stream` | required |
| Machine-only (agents, the typed client, webhooks) | `apps/web/api/` | none | policy per action |
| Needed by both | `apps/web/shared/` (leaf, must stay small) | n/a | n/a |

Posts have a public blog page **and** an authed editor, so: entity/service/policy in the `app/` slice, the public page in `site/`. `site/` may never import `app/` ([`02-boundaries.md`](./02-boundaries.md)) — the blog page reaches posts only through the typed query client, below.

Note that `action` declarations still live inside the feature slice (`app/posts/actions.ts`), never under `apps/web/api/`, whether or not the feature also has a public page: an `action` projects to HTTP, OpenAPI, the typed client and an MCP tool on its own, wherever it is declared. `api/` is for surfaces with no primitive behind them at all — webhooks, health checks.

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
  invariants: (c) => [
    invariant('post_title_present', c.title.trimmed().minLength(1)),
    invariant('post_slug_unique', c.unique(['slug'])),
  ],
  indexes: [{ on: ['orgId', 'publishedAt'], order: 'desc' }],
});
```

```ts
// apps/web/app/posts/entity.ts
export const PostView = posts.$view(['id', 'title', 'excerpt', 'cover', 'publishedAt']);
```

- `entity(name, init)` is name-first; `init` is `{ columns, tenant?, primaryKey?, invariants?, indexes?, tags? }`. `invariants` is one callback over the list, and its `c` is typed from `columns`.
- Tenancy is `.tenant()` on the column or `tenant: 'orgId'` in `init`; with neither, a column named `orgId` is inferred. The repo injects the filter, you never write it.
- Each invariant emits its own `CHECK`/`UNIQUE` automatically; only `c.satisfies(fn, [...])` and `c.matches(fn)` stay TS-only, and a rule the DB does not know is a rule a migration can violate.
- Money → `money()`; dates → `timestamp()` (always `timestamptz`) ([`10-cross-cutting.md`](./10-cross-cutting.md)).

## 3–4. Migration

```bash
x db gen "create posts"     # diffs schema vs. the migration ledger, writes the .sql + snapshot
x db migrate                  # applies to the dev database
```

Drift in either direction is `X_DB_DRIFT` with the exact table and column ([`06-data-layer.md`](./06-data-layer.md)) — thrown by `x db gen`/`x db migrate` themselves the moment the entity and the migration ledger disagree, and re-checked against the live catalog by `x verify`'s `drift` step on every gate run. There is no separate "check drift" command; migrating *is* the check.

## 5. Policy

```ts
// apps/web/app/posts/policy.ts
export const postRead    = can<PostScope>('post:read', ({ actor, input }) => actor?.orgId === input.orgId);

// `PostRow` is the second type argument: this rule decides about a row, not just about `input`.
export const postPublish = can<PostScope, PostRow>('post:publish', ({ actor, input, row }) => {
  if (actor?.orgId !== input.orgId) return false;
  // `row === null` DENIES. It means "no row was loaded", which is not evidence the actor may act
  // on one — treating an absent fact as a satisfied one is how a same-org holder of `post:publish`
  // ends up publishing someone else's draft.
  return row !== null && ownsPost(actor, row);
});
```

- One policy, every surface: HTTP, typed client, job, MCP tool, live subscription — the same function.
- Pure and synchronous. No I/O — a live query re-evaluates a row-level rule once per subscriber on every change, so an `await` here is a database round trip per row per connected client. A rule needing a row never fetches one itself: the surface that calls the policy loads the row first and passes it in as `row` (the action's `row:` loader, below, or the live matcher's own delivery). There is no mechanism for a policy to declare its own repo.
- `row` is `R | null`, never optional — a rule that reads `row` must fail closed on `null`, because "no loader declared" and "row not found" are the same value and neither is evidence of permission.
- Row identity travels through `row`, loaded by the surface, never reconstructed from `input` — the id in `input` is what the loader used to fetch the row, not a stand-in for it.
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
// apps/web/app/posts/actions.ts
export const publishPost = action({
  input:  t.object({ postId: t.uuid, orgId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: postPublish,
  // `postPublish` decides about a row, so the row has to be loaded before the guard runs rather
  // than inside it — the predicate stays synchronous, and this loader runs once per invocation,
  // never once per live subscriber.
  row:    ({ input, ctx }) => ctx.posts.authorship(input.orgId, input.postId),
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
| `policy` | the only authz. Runs after `row`, before the handler |
| `row` | required by any row-level `policy` — loads once, synchronously usable by the predicate |
| `cache.invalidates` | one hop reaches memo, LRU, Redis, ISR, CDN ([`09-rendering-internals.md`](./09-rendering-internals.md)) |
| `mcp` | one line makes it an agent-callable tool with identical authz ([`11-ai-surface.md`](./11-ai-surface.md)) |
| `<job>.enqueue` | joins the request transaction — outbox by default ([`08-jobs-internals.md`](./08-jobs-internals.md)) |

Actions must never read headers/cookies, render, redirect, authorize inside `handle`, or do slow work inline.

## 8. Query — live or not?

```ts
// apps/web/app/posts/live.ts
export const liveFeed = query({
  input: t.object({ orgId: t.uuid, limit: t.number.int().min(1).max(50).default(50) }),
  policy: feedRead,
  live: true,
  sql: ({ orgId, limit }) =>
    from<PostSummary>('posts', () => repo.feedPage(orgId, limit))
      .where({ orgId })
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(limit),
});
```

- `live: false` — the data changes on user action only; a refetch after a mutation is enough.
- `live: true` — someone else's write must appear without a refresh.
- `live: true, persist: true` — writes must survive being offline (tier 3).

Every order ends with a key unique in the row shape, written out explicitly (`.orderBy('id')` last) — the live matcher computes a row's position from this list alone, and `createdAt desc` by itself is a partial order: two rows written in the same millisecond can swap places between evaluations. `sql` builds `SqlSource` through `from()`/`.where()`/`.orderBy()`/`.limit()` from `@ultimat3/query`, never a direct `db.<table>` call — that stays inside `repo.ts`. A `live: true` read the incremental matcher cannot evaluate (a join, an aggregate, an unbounded predicate) is `X_MATCHER_UNSUPPORTED`, naming the fix: simplify the `sql`, add `orderBy` + `limit`, or drop `live`. `x queries describe liveFeed --json` shows the declaration — schema, policy, tags, live flag — for anything already registered.

## 9. Job

```ts
// apps/web/app/posts/jobs.ts
export const notifySubscribers = job({
  input: t.object({ postId: t.uuid }),
  idempotencyKey: ({ postId }) => `notify:${postId}`,   // REQUIRED by the type
  retry: { attempts: 5, backoff: 'exponential' },
  concurrency: 1,   // max in-flight runs of THIS job across the fleet — a plain number, not a key
  async run({ input, step, ctx }) {
    const subs = await step.run('load-subscribers', () => ctx.subs.forPost(input.postId));
    // One step PER recipient, because the step is the replay unit: a provider blip on recipient 40
    // of 50 re-sends recipient 40 and replays the other 39 from storage — a single step around the
    // whole loop would re-send all 50 for one transient failure.
    for (const sub of subs) {
      await step.run(`send:${sub.id}`, () => ctx.mail.send(newPostEmail, sub));
    }
  },
});
```

- `idempotencyKey`: compile error if omitted; deterministic from `input` only.
- The step is the retry unit — a failure mid-loop replays only the steps storage does not already have a result for.
- Payload is a pointer (`{ postId }`), never a record. Durable business state lives in your tables.
- `step.sleep('3d')` releases the worker; the job resumes in a fresh process.

## 10. Route + meta + offline

```ts
// apps/web/site/blog/[slug]/page.tsx
export const config = defineRoute({
  render:     'isr',
  revalidate: { tags: [tag.blog] },
  // The route never touches the database — `prerender` and `load` both go through the typed
  // query client, so this file has no edge into `app/` (X_BOUNDARY_ROUTE_TO_DB otherwise).
  prerender:  async () => (await queries.publicPostSlugs({})).map((post) => post.slug),
  offline:    'runtime',
  hydrate:    'visible',
  budget:     { js: '40kb', lcp: 2000 },
  // `load` is the one server-side data seam, resolved once per render and handed to both `meta`
  // and the page component.
  load:       async ({ params }) => oneRow(await queries.publicPost({ slug: params.slug ?? '' })),
  meta:       ({ data, t, url }) => ({ title: data.title, description: data.excerpt,
                                        og: { image: data.cover }, canonical: url,
                                        ld: [ld.Article(data)] }),
});
```

Build errors: missing/out-of-range `meta.title`, `meta.description` (50–160 chars) or `og.image` on a `site/` route → `X_SEO_META_MISSING`; over budget → `X_BUDGET_EXCEEDED` naming the import chain; `site/` opting into a `hydrate` other than `'never'` with no `budget.js`, or any other contradiction between `render` and the rest of the config (`isr` with no `revalidate` trigger, `ssr` with `prerender`, `spa` with no `policy`) → `X_ROUTE_MODE_INVALID` naming the exact edit. `offline`, `hydrate` and `meta` are required by the type — there is no route without them.

## 11. i18n keys

```bash
x i18n check --json           # scans source for t() calls, reports gaps per locale
x i18n sync es                # copies missing keys for one locale from the app's default locale
```

Zero hardcoded user-facing strings — a literal outside `t()` is a build error (`X_CATALOG_MISSING_KEYS` names the locale and the missing keys). Plurals come from CLDR: define every category the locale needs ([`10-cross-cutting.md`](./10-cross-cutting.md)).

## 12. Tests

Fill the scaffolds; they fail until you do.

```bash
x test contract --filter posts.contract
x test job      --filter posts/jobs
x test live     --filter posts/live
x test e2e      --filter blog
```

`x test <type>` takes one positional — the type — never a file path; `--filter` matches a substring of the path instead.

The assertion that matters per type: **contract** — a non-owner is denied with `X_FORBIDDEN`; **live** — a policy-failing row is never delivered; **job** — a replayed step's `executions` stays 1; **e2e** — the streamed hole fills and the offline fallback renders.

## 13–14. Manifest + gate

```bash
x manifest
x verify
x verify --json | jq '.steps[] | select(.ok == false)'
```

Green = shippable. There is no `--skip`.

## When it fails

| Error | Meaning | Command |
|---|---|---|
| `X_BOUNDARY_SITE_TO_APP` (and the other `X_BOUNDARY_*` codes) | an import crossed a surface or tier; `data.chain` shows the path | `x fix boundary <file>` |
| `X_DB_DRIFT` | schema ≠ migrations | `x db gen "<name>"` |
| `X_FORBIDDEN` in a test | the policy is right and the fixture actor is wrong, or vice versa | `x policy explain <path> --json` |
| `X_CATALOG_MISSING_KEYS` | a key used in source is missing from a locale's catalog | `x i18n sync <locale>` |
| `X_BUDGET_EXCEEDED` | a route got heavier; `data.cause` names the import | `x fix boundary <file>` |
| `X_MATCHER_UNSUPPORTED` | a `live: true` read the incremental matcher cannot evaluate | simplify the `sql`, add `orderBy` + `limit`, or drop `live` |
| `X_IDEMPOTENCY_REQUIRED` | job declared without a key | add `idempotencyKey` |
| `X_MANIFEST_STALE` | `x.manifest.json`/`openapi.json` differ from the code | `x manifest` |
| `X_CACHE_TAG_UNKNOWN` | `cache.invalidates` names a tag no entity declared | fix the typo, or `x manifest` to regenerate the tag graph |
| anything else | every error carries a `fix:` | `x errors explain <CODE>` |

## Rules that keep the loop short

- One way to do each thing. If two shapes look valid, one of them is wrong.
- Never write a second authz check. `policy` is the only one.
- Never enqueue outside a transaction, never paginate with an offset, never format a date without a zone, never put money in a float.
- Never hand-edit a generated artifact (`sw.js`, `x.manifest.json`, `openapi.json`, migrations already applied).
- Read the `fix:` line. It is a command, and it is meant to be run.
