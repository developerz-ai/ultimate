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

What no shape writes, by rule ([axiom 8](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/19-mechanism-not-convention.md)):
no plan, tier or quota; no payment, mail or model provider and no provider SDK; no model id in
code. `packages/cli/src/templates/shapes/shapes.test.ts` refuses a provider name or a model id in
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

## Refusals

| Code | When | Fix |
|---|---|---|
| `X_NEW_SHAPE_UNKNOWN` | `--shape` names no shape | `bunx @ultimat3/cli help new` lists them |
| `X_NEW_SHAPE_CONFLICT` | `--shape` with `--no-example` | drop `--no-example`: a shape is its own example |
| `X_NEW_SHAPE_GENERATE_FAILED` | a generator the shape runs in the new app (`dashboard`: `x g sign-in --password`) refused or failed | the `cd … && bunx x g … --json` it prints reproduces it; the framework's bug, so `bun test ./packages/cli/src/templates/shapes` |

The first two refuse before a file is written, `--dry-run` included. A shape whose capability a
generator owns runs that generator after its files land (`ShapeOverlay.generate`), never a copy of
its output: `--dry-run` lists those runs under `data.generate`.

## Where they are proved

| Proof | Where |
|---|---|
| file set, leave-outs, no provider, every path `CLAUDE.md` names is written | `bun test ./packages/cli/src/templates/shapes` |
| each shape typechecks, lints and meets the error contract as written | the `x new --shape <shape>` variants in `packages/cli/src/scaffold-fixture.ts`, read by `emitted-contract`, `emitted-routes`, `emitted-suites` and `scaffold-typecheck.contract` |
| `bun run setup && bun run verify` green on the first pass, then again over every generator | `scaffold-smoke` in `.github/workflows/ci.yml`, one row per shape — `scripts/ci-workflow-shape.test.ts` refuses a shape with no row |

`As of 2026-11-06`. Five shapes are planned (`saas` and `agent` beside these three); a shape is
listed here, and accepted by `--shape`, only once its row gates green. `saas` waits on a member
invite and a billing seam no slice has landed; `agent` on a model and provider an app names by
environment alone, which no shipped seam takes without a provider SDK or a model row the scaffold
would have to invent.
