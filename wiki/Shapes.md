# Shapes

`x new <name> --shape <shape>` starts an app from a shape instead of the default dashboard and
example slice. One flag, still zero questions. A shape is an **overlay** over the same scaffold
`x new` writes (`packages/cli/src/templates/shapes/`): it leaves files out, edits a few, adds its
own, and runs the generator that owns a capability it needs. Every guard, every gate step and the 95% coverage floor are the default scaffold's. No shape
waives one.

```sh
bunx create-ultimate myblog --shape blog
cd myblog && bun run setup && bun run dev
```

| Shape | Writes | Leaves out |
|---|---|---|
| none (default) | the dashboard, the `post` example slice (two actions, a live query, a job, a form island), `/admin` | — |
| `api` | the `post` slice as an API: `createPost`, `archivePost`, the live `postList`, the `reindexPost` job; an org API key (`apps/web/app/keys/`) on a `/v1` bearer mount cut by `API_KEY_SCOPES`; the complete `openapi.json` (`defineApi({ openapi })`); MCP mounted; `/admin` | every page but the error documents and the offline fallback, every island, the shell, the dashboard |
| `dashboard` | the default app — dashboard, the `post` table at `/posts` (live list, a job), `/admin` — plus a detail page per row (`apps/web/app/posts/[id]/`, `render: 'ssr'`, read through a `single` query, `postById`) and sign-in, written by `x g sign-in --password` itself once the files land | nothing of the default; `site/` stays a home page, the offline fallback and the error documents |
| `blog` | a `post` entity with no tenant (`apps/web/app/post/`), two public reads (`publishedPosts`, `publishedPost`), an `isr` index at `/` and one page per post at `/posts/<slug>`, both `budget: { js: '0kb' }`, a seed with one published post and one draft. Posts are written at `/admin` | `app/` pages, every island, the shell, the dashboard |
| `saas` | the default app (every table tenant-scoped by `orgId`, `member`/`admin`, `/admin`) plus billing as app code in `apps/web/app/billing/`: plans priced in `Money` (`plans.ts`), each plan feature a permanent flag keyed by plan, one `subscriptions` row per org (read-only at `/admin`), `entitled()` and a plan-sized `meter:` on `createPost`; a signed payment webhook (`jobs/billing-events.ts`, `x g webhook-receiver`'s own output edited at anchors) that runs as the org the signed event names and moves it between plans; sign-in and the member invite, written by `x g sign-in --password` and `x g invite` once the files land | nothing of the default |
| `agent` | the default app plus `apps/web/app/assistant/`: `suggestTitle`, an `agent()` whose one tool is the action `postTitles` (both MCP tools on `POST /mcp`); `draftPost`, whose code keeps the agent's title under the caller's id; `draftPostLater`, the same run as an `agentJob()` acting as the org's `assistant` role, queued by `queueDraft`; an agent eval with a committed baseline. The model is the environment's alone (`LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY`, its price row, `LLM_FALLBACK_URL` for a second endpoint serving it); unset, no gateway is installed and the app gates on the scripted model its tests swap in | nothing of the default |
| `realtime` | the default app plus the org's live room: a `post-activity` channel keyed by `orgId` (`apps/web/app/post/channels.ts`), joined under `canPostWatch` and caught up through `recentPosts`; a `postCreated` notifier that `createPost` enqueues in its transaction and that publishes to the room over the bus; `renamePost`, a mutator whose local twin shows the rename before the server answers. `channels.live.test.ts` puts two `sync` nodes on a real NATS and proves one post reaches a member on each | nothing of the default |
| `content` | a docs or marketing site built from files: markdown in `apps/web/content/<locale>/<slug>.md` (`en` and `es`), read at build time by `apps/web/shared/content.ts`; the front page and one page per file, all `render: 'static'` with `budget: { js: '0kb' }`; a sitemap carrying each page's `hreflang` cluster and a language switcher made of links. A page missing in one locale, or with no `#` title or lead paragraph, stops the build | the dashboard, the shell, every island, the `post` slice |
| `offline` | the default app, installable and working with no network: the post form writes through `useMutation`, so a write the network refuses waits in the page's IndexedDB outbox and is replayed on reconnect under its idempotency key (`createPost` is `idempotent: true`), landing once. Two e2e suites cut the network: the offline document answers a page no cache holds, and a post written offline is queued, replayed and listed once. Its README opens it from a phone on the LAN: `bunx x dev --host <LAN address> --tls` | nothing of the default |

What no shape writes, by rule ([axiom 8](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/19-mechanism-not-convention.md)):
no payment, mail or model provider and no provider SDK; no model id in code. The `saas` shape's
plans, prices and quotas are example app code in `apps/web/app/billing/`, the app's to change:
the framework ships the mechanism (flags, meters, a signed webhook receiver), never the plan. `packages/cli/src/templates/shapes/shapes.test.ts` refuses a provider name or a model id in
any shape's output, and `X_NOT_IMPLEMENTED` anywhere in it.

## What happens next

Each shape's `README.md` names the shape in one line above the three commands every app starts
with (`bun run setup`, `bun run dev`, `bun run verify`). Its `CLAUDE.md` (and `AGENTS.md`, the
same file) adds exactly one line naming the shape. From there, the generators are the default
scaffold's: `bunx x g --help`.

| Shape | Your first feature |
|---|---|
| `api` | `bunx x g resource invoice`: a slice with actions, a query and a job. Add its operations to `API_KEY_SCOPES` to reach them on `/v1` |
| `blog` | write a post at `/admin`. A new page: `bunx x g route about --surface site` |
| `dashboard` | `bunx x g resource invoice --admin`: a table, its form and its `/admin` screens. A detail page for it: copy `apps/web/app/posts/[id]/` |
| `saas` | `bunx x g resource invoice`, then gate an action on a plan: `if (!(await entitled(<flag>, ctx.actor))) throw …` |
| `agent` | give the agent a second tool: an action with `mcp: { expose: true }`, listed in its `tools:` |
| `realtime` | announce another change to the room: a notifier beside `jobs/post-created.ts`, enqueued from the action that commits the change |
| `content` | add `apps/web/content/en/<slug>.md` and its translation under `es/`, then `bun run verify` |
| `offline` | `bunx x g mutator <name> --feature post`, called from an island with `useMutation` |

## Refusals

| Code | When | Fix |
|---|---|---|
| `X_NEW_SHAPE_UNKNOWN` | `--shape` names no shape | `bunx @ultimat3/cli help new` lists them |
| `X_NEW_SHAPE_CONFLICT` | `--shape` with `--no-example` | drop `--no-example`: a shape is its own example |
| `X_NEW_SHAPE_GENERATE_FAILED` | a generator the shape runs in the new app (`dashboard`, `saas`: `x g sign-in --password`; `saas`: `x g invite`) refused or failed | the `cd … && bunx x g … --json` it prints reproduces it; the framework's bug, so `bun test ./packages/cli/src/templates/shapes` |

The first two refuse before a file is written, `--dry-run` included. A shape whose capability a
generator owns runs that generator after its files land (`ShapeOverlay.generate`), never a copy of
its output: `--dry-run` lists those runs under `data.generate`.

## Where they are proved

| Proof | Where |
|---|---|
| file set, leave-outs, no provider, every path `CLAUDE.md` names is written | `bun test ./packages/cli/src/templates/shapes` |
| each shape typechecks, lints and meets the error contract as written | the `x new --shape <shape>` variants in `packages/cli/src/scaffold-fixture.ts`, read by `emitted-contract`, `emitted-routes`, `emitted-suites` and `scaffold-typecheck.contract` |
| `bun run setup && bun run verify` green on the first pass, then again over every generator | `scaffold-smoke` in `.github/workflows/ci.yml`, one row per shape — `scripts/ci-workflow-shape.test.ts` refuses a shape with no row |

`As of 2026-11-16`, eight shapes: `api`, `dashboard`, `blog`, `saas`, `agent`, `realtime`,
`content` and `offline`, each a `scaffold-smoke` row that gates twice. A shape is listed here, and
accepted by `--shape`, only once its row gates green. The `saas` billing is a recipe too, with its
proof: [Building your own base](Building-Your-Own-Base).
