# Getting started

```
bunx create-ultimate myapp && cd myapp && bin/setup && x dev
```

**Four commands, and `bin/setup` is one of them.** It is the scaffold's own script — `bun install`,
`x db gen "initial"`, `x db migrate`, `x db seed` — idempotent, so re-running it after a pull is
safe. `bunx create-ultimate myapp && cd myapp && x dev` is what this page said until 2026-08-23 and
it does not work: `x new` writes files and installs nothing, so the app has no `node_modules`, no `x`
of its own, and `x dev` stops on `X_BUILD_FAILED` — *"Could not resolve `@ultimat3/ui`. Maybe you
need to `bun install`?"*

No Docker daemon, no `.env` scavenger hunt, no service to provision — `.env.development` ships
committed non-secret defaults and an empty `DATABASE_URL` means embedded PGlite.

`bin/setup`, then `x dev`, measured on a fresh scaffold `As of 2026-08-23` (6.7s for setup on a warm
Bun cache):

```
$ bin/setup
  packages/db/migrations/20260823155026_initial.sql
✓ migration 20260823155026_initial generated
✓ migrations applied
✓ 1 seed(s): 2 inserted, 0 updated, 0 already stored
setup complete — next: x dev

$ x dev
  roles web, sync, worker, scheduler
  panels routes, timeline, live, jobs, db, mail, cache, policy, manifest, services, boundaries
  manifest /path/to/myapp/x.manifest.json
  introspect http://localhost:3000/_x
✓ dev ready on http://localhost:3000 — /_x mounted (11 panels), db=embedded events=embedded storage=embedded mail=embedded cdn=none
```

`replicator` is the fifth role and is **opt-in** — it takes a replication slot, which is not
something every `x dev` should do by starting: `x dev --role web,sync,worker,scheduler,replicator`.

## What you get before writing a line

Measured on a fresh scaffold, `As of 2026-08-23`.

| Thing | Where | Detail |
|---|---|---|
| Embedded Postgres | `.x/pgdata` | PGlite in-process, no local install; `bin/setup` migrates and seeds it |
| In-process events | same process | `events=embedded`; the same seam NATS fills in prod |
| S3 | `./.x/storage` | real S3 API surface via `Bun.s3` |
| Mail | `/_x` inbox | captured, never sent |
| Redis (the shared cache tier) | not started | the scaffold's `cache.tiers` is `['request-memo', 'lru']`; adding `'redis'` is what builds the shared rung |
| `/_x` dev panel | `http://localhost:3000/_x` | 11 panels: routes, timeline, live, jobs, db, mail, cache, policy, manifest, services, boundaries |
| MCP server | `x mcp serve` | 13 dev tools over `stdio` or `http`. **Not started by `x dev`** — `/mcp` on the dev server is 404 |
| Landing page | `apps/web/site/page.tsx` | `render: 'static'`, `hydrate: 'never'`, `budget: { js: '0kb' }`, real meta + JSON-LD |
| Dashboard | `apps/web/app/dashboard/page.tsx` | `render: 'ssr'`, `hydrate: 'visible'`, `budget: { js: '60kb' }`, behind `policy: { permission: 'dashboard:read' }`. **Not `stream`** — `stream` needs a hole marker the renderer does not yet have, and the template says so in its own comment |
| Admin app | `apps/admin/` | one `ssr` page; your actions reach an agent through `mcp: { expose: true }` and `x mcp serve`, not through this app |
| Green gate | `x verify` | 20 steps, in this order: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, seo, i18n, policy, manifest, roadmap. On a fresh scaffold: red on `lint` and `budgets`, then **19 of 20** after running the `fix:` lines it printed |

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

**`x dev` does not serve MCP** — measured `As of 2026-08-23`, `GET /mcp` on the dev server answers
404 and nothing listens on 9229. The MCP server is its own command, and it prints the bearer token
your client must send:

```
x mcp serve --transport stdio                  # a client that spawns the server
x mcp serve --transport http --port 9229       # POST /mcp, bearer token printed at boot
```

`stdio` and `http` are the two transports (`x help mcp`); there is no `ws` transport, and a client
configured for one gets no connection. Register the printed URL and token with whatever MCP client
you use.

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

`As of 2026-08-23`. Stable API — semver from here ([Upgrading](Upgrading)). The repository holds 30 `@ultimat3/*` packages plus the unscoped `create-ultimate` and versions all 30 in lockstep. Every major so far has been a correctness sweep with no codemod, so each `BREAKING —` entry names its own manual edit; [Upgrading](Upgrading) walks all of them, oldest first, and each section states its own count. Only the [footer](_Footer) stamps a version number, and this page states none. **What `bunx create-ultimate myapp` installs is npm's `latest`**, one version for all 31 workspaces, each published by the release workflow over OIDC with a provenance attestation. Resolve it, do not trust this line — `npm view @ultimat3/core version`, and `npm view @ultimat3/core dist.attestations` for the attestation. **No publication holes**: `@ultimat3/scraping` was the last never-published package, bootstrapped by hand at 2.0.0, so `bun add @ultimat3/scraping` resolves. Milestones 0–10 are ✅; milestone 11 is 🚧, open on its two-platform deploy proof. Realtime tiers 1–2 ship; tier 3 (local-first) has **not shipped**. The 50k-socket forced-restart benchmark **is measured and committed** — first patch on the reconnected socket at p50 54.0s / p90 105.5s, on one node; delivery is a second run, 10,000 clients, 1,666,882 patches, 0 observed sequence gaps ([Realtime](Realtime)). Status markers come from [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md). See [FAQ](FAQ).
