---
title: Quickstart
menu: true
nav: Quickstart
description: From zero to a running Ultimate app in 60 seconds — no Docker, no .env scavenger hunt, one action, one green verify.
lede: No Docker install. No `.env` scavenger hunt. Embedded Postgres, in-process NATS, S3 to a local directory — then one `action` that becomes six artifacts.
updated: 2026-07-26
---

## Requirements

| Component | Minimum | Notes |
|---|---|---|
| Bun | `>= 1.3` | target is 2.0. `As of 2026-07`, Bun 1.3 is the floor |
| Postgres | none for `x dev` | `x dev` embeds one; production expects a real Postgres |
| Docker | none for `x dev` | needed only for parity checks and `x build --target docker` |
| Node | never | Bun-only. No Node APIs unless via `node:` and unavoidable |

No native addons, no `sharp`, no CDN, no vendor SDKs.

## 60 seconds

```bash
$ bunx create-ultimate myapp && cd myapp && x dev
  ✓ database   embedded postgres, migrated, seeded
  ✓ site       static, 0kb js, sitemap + feeds
  ✓ app        stream, realtime wired
  ✓ admin      mcp exposed
  ✓ mcp        ws://localhost:9229
  ✓ ready      http://localhost:3000
```

## What just started

| Surface | URL | Render | JS baseline | Auth |
|---|---|---|---|---|
| `site/` | `/` | `static` / `isr` | **0kb** | none |
| `app/` | `/app` | `stream` | per-route budget | required |
| `api/` | `/_x/action/*` | none | n/a | policy per action |
| admin | `:3001` | `stream` | per-route budget | required, MCP exposed |
| dev panel | `/_x` | — | — | dev only |
| MCP dev server | `ws://localhost:9229` | — | — | dev only, never in `ROLE=web` |

A landing page in `site/` at 0kb JS, an authed dashboard in `app/` streaming, an admin app that
already speaks MCP, and `x verify` green — before the first line of your code.

## Generate a feature

```bash
$ x g resource post title:string body:text published:boolean
  ✓ entity     apps/web/app/posts/entity.ts
  ✓ repo       apps/web/app/posts/repo.ts
  ✓ policy     apps/web/app/posts/policy.ts
  ✓ actions    apps/web/app/posts/actions.ts
  ✓ live       apps/web/app/posts/live.ts
  ✓ ui         apps/web/app/posts/ui/
  ✓ migration  packages/db/migrations/0002_create_posts.sql
  ✓ tests      4 scaffolds (contract, live, job, route) — red until filled in
```

Generated scaffolds fail until you fill them in. An untested action is a red build, not a
backlog item.

## Write the action

```ts title="apps/web/app/posts/actions.ts"
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

That declaration is now callable three ways, all through the same `policy`:

```ts title="apps/web/app/posts/ui/publish-button.tsx"
const view = await publishPost({ postId });        // typed client, no fetch, no codegen step
```

```bash
$ curl -sX POST localhost:3000/_x/action/publish-post \
    -H 'content-type: application/json' -d '{"postId":"1b9d…"}'
```

```bash
$ x mcp call publish-post --json '{"postId":"1b9d…"}'
```

An unauthorised caller gets the same answer in all three, with the same code:

```text
X_POLICY_DENIED: policy denied this actor
  cause: post:publish denied — actor 8c2f… does not own post 1b9d…
  fix:   x policy explain post:publish --json
```

## Verify

```bash
$ x verify
  ✓ typecheck  ✓ lint  ✓ boundaries  ✓ unit  ✓ contract  ✓ live  ✓ job  ✓ e2e
  ✗ migration drift
      X_DB_DRIFT: schema differs from migrations
        cause: table "posts" has column "publish_at" not present in any migration
        fix:   x db gen "add publish_at"
```

One command means shippable. CI runs exactly `x verify` — a check that lives only in CI is a
check developers cannot run. `x verify --json` emits the same content machine-readably, so an
agent parses the failure and runs the `fix` line without a human.

## Point your agent at it

```bash
$ x dev            # serves MCP on ws://localhost:9229
$ x mcp tools --json
```

The dev MCP server introspects routes, schema, policies and actions, runs tests, tails logs,
runs read-only SQL, and applies migrations **in a branch database only**. See
[AI-first](/ai-first/).

## Where next

| You want | Read |
|---|---|
| the vocabulary | [The eight primitives](/primitives/) |
| lists that update themselves | [Realtime](/realtime/) |
| background work that survives a deploy | [Jobs](/jobs/) |
| render modes, SEO, budgets | [Rendering &amp; SEO](/rendering-seo/) |
| install, offline, version skew | [PWA &amp; offline](/pwa-offline/) |
| containers, roles, drain | [Deploy](/deploy/) |
| every command and flag | [CLI reference](https://github.com/developerz-ai/ultimate/wiki/CLI-Reference) |
| every error code and its fix | [Error codes](https://github.com/developerz-ai/ultimate/wiki/Error-Codes) |
