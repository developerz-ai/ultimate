# Compared

Each stack this framework gets compared to, **"pick it instead when" first**. A row in this
framework's favour cites a command, a file or a page you can check; a claim about another stack
links that stack's own documentation. `As of 2026-11`. No head-to-head chart: a vendor's numbers
against its rivals convince nobody, so this page publishes its own figures and the harness, and you
point the harness at yours.

## What you give up here, whichever stack you come from

| You give up | Where it is stated |
|---|---|
| any runtime but Bun | `non_goals` in `.dz/maintainer/maintainer.yml`; [FAQ](FAQ) |
| any database but Postgres | the same list; [Home](Home) |
| any renderer but SolidJS | the same list; [Routes and render modes](Routes-And-Render-Modes) |
| a long track record: released in 2026; who builds on it is stated below | [FAQ](FAQ#is-it-production-ready) |
| a slow major cadence: from v31, at most one major per 90 days | [Stability](Stability) |
| a third-party security audit: there has been none | [`SECURITY.md`](https://github.com/developerz-ai/ultimate/blob/main/SECURITY.md) |
| a plugin API: an app wraps a primitive instead | [Home](Home) |
| a serverless or edge target: containers only | [Deployment](Deployment) |
| everything on the open list | [Known gaps](Known-Gaps) |

Who uses it:

<!-- generated: production-apps — bun run scripts/production-apps.ts --write -->
9 apps outside this repository build on Ultimate, small to medium in size; at least 1 of them serves production traffic. Owner-reported, `As of 2026-11`: adopters are never named (`scripts/private-names.ts` refuses a name in the tree), so no command here re-derives this line.
<!-- end generated -->

## Measured, and how to reproduce it

One local run on an 8-core laptop, `As of 2026-11-06`, not yet a CI figure; the method, the box and
the caveats are [`scripts/bench/results/README.md`](https://github.com/developerz-ai/ultimate/blob/main/scripts/bench/results/README.md),
and every number below is held to the committed JSON by `bun run scripts/bench-claims.ts`
(`X_BENCH_CLAIM_STALE`).

| Figure | Measured |
|---|---|
| scaffold, published `create-ultimate` (29.4.0) | 4.7 s |
| `bun run setup`, cold Bun cache | 43.3 s |
| `node_modules` after setup | 165 MB |
| first `bun run verify` | **red on 29.4.0**: `budgets` was `X_BUDGET_UNMEASURED` until something built; the step builds first on `main` |
| `/` under `x dev`, one client, concurrency 16 | median 267 req/s, p99 181.85 ms |
| a typed read, `/_x/query/post-list` | median 183 req/s, p99 258.26 ms |
| cold start to the first 2xx (`x dev`) | 4.8 s |

`x dev` is the development server — every role and an embedded Postgres in one process — so these
are a laptop's first-hour numbers, not a production capacity claim.

Reproduce on any machine with Bun and a clone of this repository:

```sh
bun run scripts/bench/first-hour.ts --runs 5 --json
bun run scripts/bench/http-hello.ts --url http://localhost:3000/ --seconds 30 --runs 5 --start 'bunx x dev' --cwd <the work directory first-hour printed>/firsthour
```

`http-hello.ts --url` loads any URL, so point it at your own app on any stack and compare like with
like. It refuses a run under 10 s (`X_BENCH_RUN_TOO_SHORT`), and a non-2xx answer or a server that
dies mid-run is `X_BENCH_RUN_FAILED`, never a figure. `.github/workflows/bench.yml` re-measures weekly
and on every release, on a free `ubuntu-latest` runner, and opens a pull request with the JSON.

## Rails

| | |
|---|---|
| **Pick Rails instead when** | your team writes Ruby; you need MySQL or SQLite as well as Postgres ([Active Record](https://guides.rubyonrails.org/active_record_basics.html)); you want two decades of gems, hosts and hiring; you want server-rendered HTML with Hotwire and no client build |
| **Pick this when** | the primary author is an agent: one declaration projects HTTP, OpenAPI, a typed client and an MCP tool ([Actions](Actions)), and `x verify` is one green-or-red answer over 21 steps (`VERIFY_STEP_NAMES`, `packages/cli/src/verify-step.ts`); you want types end to end with no codegen step ([Client data](Client-Data)) |
| **What you give up** | the table above, and Rails' ecosystem. The concept map: [Migrating from Rails](Migrating-From-Rails) |

## Next.js

| | |
|---|---|
| **Pick Next.js instead when** | your team and component library are React; you deploy to a serverless or edge platform ([Next.js deploying](https://nextjs.org/docs/app/getting-started/deploying)); you want the largest ecosystem of the five |
| **Pick this when** | you want jobs, realtime, authz, mail, storage and an admin in the box rather than chosen per project ([Jobs and workflows](Jobs-And-Workflows), [Realtime](Realtime), [Policies and authz](Policies-And-Authz), [Admin dashboard](Admin-Dashboard)); you want a page's JavaScript budget to fail the build (`budget: { js: '0kb' }`, [Routes and render modes](Routes-And-Render-Modes)) |
| **What you give up** | React, and the platform features this framework will not use. The concept map for a Node app: [Migrating from Node and Drizzle](Migrating-From-Node-Drizzle) |

## Meteor

| | |
|---|---|
| **Pick Meteor instead when** | your data is in MongoDB, Meteor's primary database ([Meteor docs](https://docs.meteor.com/)); you already run a Meteor app |
| **Pick this when** | you want realtime that reuses the one authz system per delivered row: a live query is a `query` with its `policy` ([Queries and live queries](Queries-And-Live-Queries)); you want Postgres and SQL you can read (`postgresDriver()`, `packages/entity/src/pg-driver.ts`) |
| **What you give up** | MongoDB, and Meteor's package ecosystem |

## Phoenix

| | |
|---|---|
| **Pick Phoenix instead when** | you want the BEAM: lightweight processes, supervision and clustering ([Phoenix docs](https://hexdocs.pm/phoenix/overview.html)); you want LiveView's server-held state over a socket |
| **Pick this when** | you want TypeScript on both sides with one schema per declaration ([Actions](Actions)); you want durable step workflows as a primitive rather than a library choice ([Jobs and workflows](Jobs-And-Workflows)) |
| **What you give up** | the BEAM's concurrency model and a long-proven runtime. Realtime capacity here is measured on one node: `scripts/bench/results/README.md` |

## Inngest and Zero

| | |
|---|---|
| **Pick them instead when** | you keep the framework you have and add durable functions ([Inngest docs](https://www.inngest.com/docs)) or a sync engine ([Zero docs](https://zero.rocicorp.dev/docs/introduction)) to it |
| **Pick this when** | you want their shapes — a `job` with steps, a `mutator` — inside one runtime under one authz system, with nothing to operate beside Postgres ([The eight primitives](The-Eight-Primitives)) |
| **What you give up** | keeping your current framework |
