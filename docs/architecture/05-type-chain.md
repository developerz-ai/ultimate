# Type chain

One inferred chain, no codegen step to remember, no hand-written duplicate of any shape:

```
DB column → entity → repo row → action input/output → OpenAPI + MCP schema → typed client → Solid component
```

Every hop is inference, not generation. A generated artifact can be stale; an inferred type cannot.

## The hops

| # | Hop | Mechanism | Stale-able? |
|---|---|---|---|
| 1 | column → row type | Drizzle `$inferSelect` / `$inferInsert` | no |
| 2 | row type → entity domain type | `entity()` wraps the table; invariants narrow the type (branded ids, non-empty strings) | no |
| 3 | entity → repo signatures | repo factory is generic over the entity | no |
| 4 | entity → view schema | `view(posts, ['id','title','excerpt'])` — a compile error if a field does not exist | no |
| 5 | view → action `output` | assignment; the handler's return type must satisfy it | no |
| 6 | `input`/`output` → JSON Schema | Standard Schema → `toJsonSchema()` at build | **generated** — drift is `X_MANIFEST_STALE` |
| 7 | action declaration → typed client | `typeof publishPost` projected to `(input) => Promise<output>` | no |
| 8 | client → component | Solid resource/signal types flow from the client function | no |
| 9 | entity → migration | diff of the schema against applied migrations | **generated** — drift is `X_DB_DRIFT` |

Only hops 6 and 9 emit files, and both have a drift check in `x verify`. Everything else is `tsc`.

## Worked example

```ts
// packages/db/src/schema/posts.ts                        ← hop 1
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  title: text('title').notNull(),
  excerpt: text('excerpt').notNull(),
  cover: text('cover'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});
```

```ts
// apps/web/app/posts/entity.ts                           ← hops 2, 4
export const Post = entity(posts, {
  tenant: 'orgId',
  invariants: [inv('title-not-blank', (p) => p.title.trim().length > 0)],
});

export const PostView = view(Post, ['id', 'title', 'excerpt', 'cover', 'publishedAt']);
```

```ts
// apps/web/api/posts.ts                                  ← hops 5, 6, 7
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

```tsx
// apps/web/app/posts/ui/post-card.tsx                    ← hop 8
export function PostCard(props: { post: PostView }) {
  return (
    <article>
      <h3>{props.post.title}</h3>
      <p>{props.post.excerpt}</p>
      <button onClick={() => publishPost({ postId: props.post.id })}>{t('post.publish')}</button>
    </article>
  );
}
```

## Rename one column, count the errors

Rename `excerpt` → `summary` in `packages/db/src/schema/posts.ts` and change nothing else. `x verify` reports, in this order:

| Where it breaks | Error | Message shape |
|---|---|---|
| `apps/web/app/posts/entity.ts` | `tsc` | `view(Post, [...])` — `'excerpt'` is not assignable to `keyof Post` |
| `apps/web/api/posts.ts` | `tsc` | handler return type missing `summary`, only after `PostView` is fixed |
| `apps/web/app/posts/ui/post-card.tsx` | `tsc` | `Property 'excerpt' does not exist on type 'PostView'` |
| `apps/web/site/blog/[slug]/page.tsx` | `tsc` | `meta: ({ post }) => ({ description: post.excerpt })` — same error, in the SEO callback |
| `apps/web/app/posts/repo.ts` | `tsc` | any explicit column list referencing `excerpt` |
| `apps/web/api/posts.contract.test.ts` | `tsc` | the generated contract test asserts the view's keys |
| migrations | `X_DB_DRIFT` | `cause: table "posts" has column "summary" not present in any migration` / `fix: x db gen "rename excerpt to summary"` |
| `openapi.json`, `x.manifest.json` | `X_MANIFEST_STALE` | `fix: x manifest write` |

Eight failures, each naming a file and a line. Zero silent behavior changes. The rename is **complete when the build is green** — there is no seventh place to remember.

Contrast: the same rename in a stack where the API response is hand-written and the client types are a copied interface. Nothing fails. The field arrives as `undefined`, renders as an empty paragraph, and the SEO description silently becomes blank on every blog post.

## Why a server-function typo is a compile error in a component

There is no fetch boundary to launder types across.

```tsx
await publishPost({ postId: props.post.id, notifyy: true });
//                                          ^^^^^^^ Object literal may only specify
//                                                  known properties
```

| Layer | What normally erases the type | What Ultimate does |
|---|---|---|
| transport | `fetch(url, { body: JSON.stringify(x) })` — `x` is `any`-shaped | the client function is `typeof action` projected; the body is typed at the call site |
| response | `await res.json()` returns `any` | the return type is the action's `output` schema type |
| route path | a string literal, typo-able | derived from the action name; there is no URL in app code |
| codegen | a client SDK regenerated on a good day | inference — nothing to regenerate |

The typed client is the *only* way `app/` reaches `api/`. A runtime import of `api/` from `app/` is a boundary violation ([`02-boundaries.md`](./02-boundaries.md)); `import type` is how the shapes travel.

## Where inference stops

Be honest about the seams. Each one is an explicit, greppable parse — never a cast.

| Seam | Risk | Required handling |
|---|---|---|
| `jsonb` columns | Drizzle infers `unknown` | declare `$type<T>()` **and** parse with a schema on read |
| raw SQL (`sql\`...\``) | result shape is asserted, not inferred | wrap in a repo function whose return value is schema-parsed |
| external HTTP / webhooks | `any` | `t` parse at the boundary; failure is `X_INPUT_INVALID` |
| `process.env` | `string \| undefined` | the env schema below |
| MCP tool arguments | JSON from a model | parsed by the same `input` schema as HTTP ([`11-ai-surface.md`](./11-ai-surface.md)) |
| the client's local store (tier 3) | persisted by an older build | schema-versioned; a mismatch triggers a rebuild from a fresh snapshot ([`07-realtime-internals.md`](./07-realtime-internals.md)) |

`any` is banned by lint, and a cast that erases one of these seams is a rejected PR. `unknown` + a parse is the only accepted pattern.

## Typed env, validated at boot

```ts
// app.config.ts
export const env = envSchema({
  DATABASE_URL: t.string.url,
  REDIS_URL: t.string.url.optional(),
  ROLE: t('"web"|"sync"|"worker"|"scheduler"|"migrate"|"replicator"'),
  DRAIN_TIMEOUT_MS: t.number.integer.default(30_000),
  DEFAULT_LOCALE: t.string.default('en-US'),
  DEFAULT_TZ: t.string.default('UTC'),
  VAPID_PUBLIC: t.string.optional(),
});
```

| Property | Behavior |
|---|---|
| When | at boot, before the first listener binds — a bad env fails in ~40ms, not on the first request |
| Failure | `X_CONFIG_INVALID`, listing **every** missing/invalid key at once, with the expected type per key |
| Access | `env.DATABASE_URL` is `string`; reading `process.env` directly outside `app.config.ts` is a boundary violation |
| Defaults | in the schema, so there is one place to look — not scattered `?? 30000` |
| Roles | `ROLE` is a union, so a role switch is exhaustively checked in `cli` ([`13-topology-runtime.md`](./13-topology-runtime.md)) |
| Secrets | never logged; the boot report prints key names and `set`/`unset`, never values |

Same schema library as actions and entities, so the whole system has one parse mechanism and one failure shape.
