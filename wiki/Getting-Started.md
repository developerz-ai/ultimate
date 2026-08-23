# Getting started

```
bunx create-ultimate myapp && cd myapp && x dev
```

Nothing to install first. No Docker daemon, no `.env` scavenger hunt, no service to provision.

```
✓ postgres    embedded, migrated, seeded         420ms
✓ nats        in-process                           2ms
✓ storage     ./.x/storage (S3 API)                1ms
✓ roles       web sync worker scheduler replicator (one process, isolated)
✓ site/       12 routes   static   0kb js
✓ app/        3 routes    stream
✓ mcp         ws://localhost:9229
  http://localhost:3000        →  landing page (site/)
  http://localhost:3000/app    →  dashboard (app/)
  http://localhost:3000/_x     →  dev dashboard
  ready in 1.1s
```

## What you get before writing a line

| Thing | Where | Detail |
|---|---|---|
| Embedded Postgres | `.x/pg` | downloaded once, migrated, seeded; no local install |
| In-process NATS | same process | identical API to JetStream in prod |
| S3 | `./.x/storage` | real S3 API surface via `Bun.s3` |
| Mail | `/_x` inbox | captured, never sent |
| Redis (cache tier 3) | in-process map | same interface as `Bun.redis` |
| MCP dev server | `ws://localhost:9229` | routes, schema, policies, tests, logs, read-only SQL |
| `/_x` dev panel | `http://localhost:3000/_x` | routes, schema, queries, live, jobs, cache, mail, errors, traces, AI, env, boundaries |
| Landing page | `apps/web/site/` | `static`, **0kb JS**, real meta + JSON-LD |
| Dashboard | `apps/web/app/` | `stream`, auth'd |
| Admin app | `apps/admin/` | already exposes MCP over your actions |
| Green gate | `x verify` | 19 steps, in this order: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, seo, i18n, manifest, roadmap |

`x dev` runs **every role in one process** with isolation simulated, not skipped: separate ALS contexts, a real Postgres queue, real logical replication, a real SIGTERM drain on `x dev restart`. Nothing in the framework branches on `if (dev)` — only the drivers differ.

## 1. Write your first action

```
x g action publish-post
```

```ts
export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: post.orgId });
    return post;
  },
});
```

That one declaration emits six artifacts — HTTP route, OpenAPI operation, typed client function, job handle, MCP tool, test scaffold. See [Actions](Actions).

Register it, with every other primitive, in one call. Importing `api/index.ts` IS the boot.

```ts
// apps/web/api/index.ts
import { defineApi } from '@ultimat3/action';
import * as postActions from '../app/posts/actions';
import * as postJobs from '../app/posts/jobs';
import * as postQueries from '../app/posts/live';
import * as postMutators from '../app/posts/mutator';
import * as scheduledTasks from './tasks';

export const api = defineApi({
  actions: [postActions],
  mutators: [postMutators],
  queries: [postQueries],
  jobs: [postJobs],
  tasks: [scheduledTasks],
});

export type Api = typeof api;
```

## 2. Call it from `app/`

`app/` may import `api/` **types only**. The typed client is derived from those types; there is no codegen step to remember and no `fetch`.

```ts
// apps/web/shared/client.ts
import { rpc } from '@ultimat3/action';
import type { Api } from '../api';

export const api = rpc<Api['actions']>({ baseUrl: '/' });
```

```tsx
// apps/web/app/posts/ui/publish-button.tsx
import { api } from '../../../shared/client';
import { t as translate } from '@ultimat3/i18n';
import type { PostView } from '@myapp/domain';

export function PublishButton(props: { post: PostView }) {
  const publish = async (): Promise<void> => {
    await api.publishPost({ postId: props.post.id, notify: true });
  };
  return (
    <button type="button" onClick={publish}>
      {translate('post.publish')}
    </button>
  );
}
```

Rename `postId` in the action and this file fails typecheck. One rename, N errors, all real work.

## 3. Drive it from an agent over MCP

Point any MCP client at the dev socket printed by `x dev`.

```
claude mcp add ultimate --transport ws ws://localhost:9229
```

The agent now sees `publishPost` as a tool with JSON Schema from `input`, the description from `mcp.description`, and **the action's own `policy` as its authorization** — unwrapped, identical to the HTTP path. A denial is the same code in all three encodings:

```json
{ "code": "X_FORBIDDEN", "cause": "actor user_2 lacks post:publish on post_9",
  "fix": "grant post:publish to the actor's role, or call as the post owner",
  "docs": "https://github.com/developerz-ai/ultimate/wiki/Error-Codes" }
```

Introspection an agent should use instead of grepping:

| Want | Command | MCP tool |
|---|---|---|
| every action + schemas | `x actions list --json` | `actions.list` |
| one action in detail | `x actions describe publishPost --json` | `actions.list` |
| is this protected | `x policy explain publishPost --json` | none — `policies.list` returns the catalog, not the per-declaration matrix |
| the whole app as data | `x manifest --json` | `manifest.get` |
| what an `X_*` code means | `x errors explain X_FORBIDDEN` | `errors.explain` |

## 4. `x verify`

One command. Green means shippable.

```text
$ x verify
  ✓ typecheck  ✓ lint  ✓ boundaries  ✓ filesize  ✓ package-shape  ✓ errors
  ✓ unit  ✓ contract  ✓ live  ✓ job  ✓ e2e  ✓ eval
  ✗ drift
      X_DB_DRIFT: schema differs from migrations
        cause: table "posts" has column "publish_at" not present in any migration
        fix:   x db gen "add publish_at"
```

`x verify --json` emits the same content machine-readably. CI runs exactly `x verify` — a check that lives only in CI is a check you cannot run.

## Where next

| Page | Read it for |
|---|---|
| [Installation](Installation) | prerequisites, `x new` flags, typed env, MCP client setup |
| [Project layout](Project-Layout) | the generated tree, surfaces, the `site/` → `app/` boundary |
| [The eight primitives](The-Eight-Primitives) | the whole conceptual surface, in eight lines |
| [Actions](Actions) | every field, all six projections, introspection |
| [Entities and migrations](Entities-And-Migrations) | schema, drift, branch DBs |
| [Policies and authz](Policies-And-Authz) | one authz system, tenancy, denials |
| [Queries and live queries](Queries-And-Live-Queries) | reads, `live: true` |
| [Jobs and workflows](Jobs-And-Workflows) | durable steps, idempotency |
| [Routes and render modes](Routes-And-Render-Modes) | `static` / `isr` / `ssr` / `stream` |
| [Testing](Testing) | six test types, DB-clone parallelism |
| [CLI reference](CLI-Reference) | every command, every `--json` |
| [Error codes](Error-Codes) | code → cause → fix |
| [Troubleshooting](Troubleshooting) | first-run failures |

## Status

`As of 2026-08-23`. Stable API — semver from here ([Upgrading](Upgrading)). The repository holds 29 `@ultimat3/*` packages plus the unscoped `create-ultimate` and versions all 30 in lockstep. Every major so far has been a correctness sweep with no codemod, so each `BREAKING —` entry names its own manual edit; [Upgrading](Upgrading) walks all of them, oldest first, and each section states its own count. Only the [footer](_Footer) stamps a version number, and this page states none. **What `bunx create-ultimate myapp` installs is npm's `latest`**, one version for all 30 workspaces, each published by the release workflow over OIDC with a provenance attestation. Resolve it, do not trust this line — `npm view @ultimat3/core version`, and `npm view @ultimat3/core dist.attestations` for the attestation. **No publication holes**: `@ultimat3/scraping` was the last never-published package, bootstrapped by hand at 2.0.0, so `bun add @ultimat3/scraping` resolves. Milestones 0–10 are ✅; milestone 11 is 🚧, open on its two-platform deploy proof. Realtime tiers 1–2 ship; tier 3 (local-first) has **not shipped**. The 50k-socket forced-restart benchmark **is measured and committed** — first patch on the reconnected socket at p50 54.0s / p90 105.5s, on one node; delivery is a second run, 10,000 clients, 1,666,882 patches, 0 observed sequence gaps ([Realtime](Realtime)). Status markers come from [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md). See [FAQ](FAQ).
