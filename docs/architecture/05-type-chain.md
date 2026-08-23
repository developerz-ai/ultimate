# Type chain

One inferred chain, no codegen step to remember, no hand-written duplicate of any shape:

```
DB column → entity → repo row → action input/output → OpenAPI + MCP schema → typed client → Solid component
```

Every hop is inference, not generation. A generated artifact can be stale; an inferred type cannot.

## The hops

| # | Hop | Mechanism | Stale-able? |
|---|---|---|---|
| 1 | column → row type | `RowOf<C>`, derived from the `columns` object — there is no ORM and no second table declaration | no |
| 2 | column set → entity domain type | `entity(name, init)` binds the tenant column and the invariants; `$parse` is the write boundary | no |
| 3 | entity → repo signatures | repo factory is generic over the entity | no |
| 4 | entity → view schema | `posts.$view(['id','title','excerpt'])` — a compile error if a field does not exist | no |
| 5 | view → action `output` | assignment; the handler's return type must satisfy it | no |
| 6 | `input`/`output` → JSON Schema | Standard Schema → `toJsonSchema()` at build | **generated** — drift is `X_MANIFEST_STALE` |
| 7 | action declaration → typed client | `typeof publishPost` projected to `(input) => Promise<output>` | no |
| 8 | client → component | Solid resource/signal types flow from the client function | no |
| 9 | entity → migration | diff of the schema against applied migrations | **generated** — drift is `X_DB_DRIFT` |

Only hops 6 and 9 emit files, and both have a drift check in `x verify`. Everything else is `tsc`.

## Worked example

```ts
// packages/db/src/schema/posts.ts                        ← hops 1, 2
import { entity, integer, invariant, text, timestamp, url, uuid } from '@ultimat3/entity';

export const posts = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().references(() => orgs.id, { onDelete: 'cascade' }).tenant(),
    title: text({ max: TITLE_MAX }),
    excerpt: text({ max: EXCERPT_MAX }),
    cover: url().nullable(),
    likeCount: integer().default(0),
    publishedAt: timestamp().nullable(),
  },
  invariants: (c) => [invariant('post_title_present', c.title.trimmed().minLength(1))],
});

export type Post = typeof posts.$row;
```

`entity(name, init)` is name-first, and `init` is `{ columns, tenant?, primaryKey?, invariants?,
indexes?, tags? }`. `tenant: 'orgId'` in `init` is the said-out-loud form of the `.tenant()` marker
above; `init` wins when both appear, and with neither, a column named `orgId` is still inferred —
silence never means unscoped.

```ts
// apps/web/app/posts/entity.ts                           ← hop 4
export const PostView = posts.$view(['id', 'title', 'excerpt', 'cover', 'publishedAt']);

export type PostView = typeof PostView.$row;
```

```ts
// apps/web/api/posts.ts                                  ← hops 5, 6, 7
export const publishPost = action({
  input:  t.object({ postId: t.uuid, orgId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: input.orgId });
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
| `apps/web/app/posts/entity.ts` | `tsc` | `posts.$view([...])` — `'excerpt'` is not assignable to `keyof Post` |
| `apps/web/api/posts.ts` | `tsc` | handler return type missing `summary`, only after `PostView` is fixed |
| `apps/web/app/posts/ui/post-card.tsx` | `tsc` | `Property 'excerpt' does not exist on type 'PostView'` |
| `apps/web/site/blog/[slug]/page.tsx` | `tsc` | `meta: ({ post }) => ({ description: post.excerpt })` — same error, in the SEO callback |
| `apps/web/app/posts/repo.ts` | `tsc` | any explicit column list referencing `excerpt` |
| `apps/web/api/posts.contract.test.ts` | `tsc` | the generated contract test asserts the view's keys |
| migrations | `X_DB_DRIFT` | `cause: table "posts" has column "summary" not present in any migration` / `fix: x db gen "rename excerpt to summary"` |
| `openapi.json`, `x.manifest.json` | `X_MANIFEST_STALE` | `fix: x manifest` |

Eight failures, each naming a file and a line. Zero silent behavior changes. The rename is **complete when the build is green** — there is no ninth place to remember.

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
| a JSON payload column | no `jsonb()` builder ships at 1.0.0 — `ColumnKind` reserves the kind, nothing derives a type for it | parse with a schema on read; never a cast |
| raw SQL (`sql\`...\``) | result shape is asserted, not inferred | wrap in a repo function whose return value is schema-parsed |
| external HTTP / webhooks | `any` | `t` parse at the boundary; failure is `X_INPUT_INVALID` |
| `process.env` | `string \| undefined` | the env schema below |
| MCP tool arguments | JSON from a model | parsed by the same `input` schema as HTTP ([`11-ai-surface.md`](./11-ai-surface.md)) |
| the client's local store (tier 3) | persisted by an older build | schema-versioned; a mismatch triggers a rebuild from a fresh snapshot ([`07-realtime-internals.md`](./07-realtime-internals.md)) |

`any` is banned by lint, and a cast that erases one of these seams is a rejected PR. `unknown` + a parse is the only accepted pattern.

## Typed env, validated at boot

`defineEnv` runs at **module scope inside `app.config.ts`** — the one config file, and the one
root marker the CLI walks up to find ([`app-root.ts`](../../packages/cli/src/app-root.ts)). There
is no `env.ts` convention and no separate discovery mechanism: importing the config is what parses
the environment, so a bad env fails before the first listener binds.

```ts
// app.config.ts
import { defineConfig, defineEnv } from '@ultimat3/core';

const env = defineEnv({
  DATABASE_URL: { type: 'url', secret: true },
  REDIS_URL: { type: 'url', required: false },
  NATS_URL: { type: 'url', role: 'sync' },        // required for ROLE=sync only
  DRAIN_TIMEOUT_MS: { type: 'integer', default: 30_000 },
  VAPID_PUBLIC: { type: 'string', required: false },
});

export const config = defineConfig({
  name: 'postly',
  // `DatabaseConfig` is `{ driver, ssl }`. The URL and the pool size are read from the
  // environment (`DATABASE_URL`, `DATABASE_POOL_MAX`), because a `urlEnv`/`poolSize` key here was
  // read by nothing and was deleted; an excess key is a `TS2353` at the `typecheck` step.
  database: { driver: 'postgres', ssl: true },
  realtime: { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' },
});
```

| Property | Behavior |
|---|---|
| When | at boot, before the first listener binds — a bad env fails in ~40ms, not on the first request |
| Failure | `X_ENV_MISSING`, listing **every** missing/invalid key at once, with the expected type per key |
| Access | `env.DATABASE_URL` is `string`, `env.DRAIN_TIMEOUT_MS` is `number` — the declaration is the only place a key's type is written |
| Defaults | in the schema, so there is one place to look — not scattered `?? 30000` |
| Roles | `role: 'sync'` makes a key required for that role only, so a `worker` does not fail on a key it never reads. `ROLE` itself is the framework's (`resolveRole()`), not a key you declare |
| Secrets | `secret: true` is never logged; the boot report prints key names and `set`/`unset`, never values |

`defineEnv` is a purpose-built declarative record, not the `@ultimat3/schema` `t` used by actions and
entities — env vars are always strings on the wire and need coercion (`number`/`port`/`boolean`/`enum`),
a `role` gate, and `secret` redaction a generic object schema has no vocabulary for. `X_ENV_MISSING` is
the one code for a key this gate finds absent or unparseable; `X_CONFIG_INVALID` is the separate
failure of a configuration that parses and still cannot boot — `app.config.ts` against its own schema
(bad `defaultLocale`, `db.pool < 1`, a non-IANA `timeZone`), or two env keys that each parse and
contradict each other (`SMTP_URL` with `RESEND_API_KEY`, `FASTLY_*` with `CLOUDFLARE_*`) — see
[Configuration](../../wiki/Configuration.md).
