<h1 align="center">
  <img src="assets/logo.svg" alt="" width="88" height="88" /><br />
  Ultimate
</h1>

<p align="center"><strong>The full-stack framework where the primary developer is an AI agent.</strong></p>

<div align="center">

[![CI](https://github.com/developerz-ai/ultimate/actions/workflows/ci.yml/badge.svg)](https://github.com/developerz-ai/ultimate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/npm/v/%40ultimat3%2Fcore?label=version&color=blue)](https://www.npmjs.com/package/@ultimat3/core)

[Live demo](https://social-media.ultimate.demo.developerz.ai) ·
[Wiki](https://github.com/developerz-ai/ultimate/wiki) ·
[Error codes](wiki/Error-Codes.md) ·
[CLI reference](wiki/CLI-Reference.md) ·
[llms.txt](llms.txt)

</div>

> **If you are a coding agent, start with [`llms.txt`](llms.txt)**: every doc, wiki page and package README as one link map.

## What it is

Rails' philosophy on Bun + Postgres + SolidJS. Everything is one of **eight primitives**, and one `action` declaration projects into an HTTP route, an OpenAPI operation, a typed client, a job handle, an MCP tool and a test, all behind one `policy`. `x verify` is the contract: green means shippable.

This is a real action from the reference app, quoted by [`scripts/readme-sample.ts`](scripts/readme-sample.ts), which fails the gate when the two differ:

<!-- readme-sample: examples/dummy/apps/web/app/runs/actions/cancel-run.ts -->
```ts
import { action, t } from '@ultimat3/action';
import { canRunAct } from '../policy';

export const cancelRun = action({
  input: t.object({ orgId: t.uuid, runId: t.uuid }),
  output: t.object({ runId: t.uuid }),
  policy: canRunAct,
  row: ({ input, ctx }) => ctx.runs.runOwner(input.runId),
  mcp: { expose: true, description: 'Cancel a run that is queued or in flight' },
  async handle({ input, ctx }) {
    await ctx.runs.cancel(input.runId);
    return { runId: input.runId };
  },
});
```

`POST /api/runs/cancel`, its OpenAPI operation, `api.cancelRun(...)` in the browser, the `cancelRun` MCP tool and a job-callable handle all come from those lines, and the same `canRunAct` decides every one. A typo in a caller is a compile error.

## Run it

```sh
bunx create-ultimate myapp && cd myapp && bun run setup && bun run dev
```

Or look first: **[the live demo](https://social-media.ultimate.demo.developerz.ai)**, a social network built on Ultimate, deployed from `main` on every green push. Fabricated data, every row decided by a policy. Source: [`dummy/social-media-clone/`](dummy/social-media-clone/).

No Docker, no env hunt: embedded Postgres, in-process NATS, storage in a local directory, a seeded database and a dev dashboard at `/_x`. `bun run setup` is required: `x new` installs nothing, and the app's own README names the six steps. → [Getting started](wiki/Getting-Started.md)

## Why pick it, and when not to

| Pick it when | Because |
|---|---|
| an agent writes most of your code | one way per task, `--json` everywhere, and every error carries a stable code, a cause and a `fix:` command |
| you want authz written once | the same `policy` guards HTTP, live queries, jobs, MCP tools and admin |
| you want the boring parts decided | jobs, realtime, auth, mail, storage, i18n, SEO, admin and MCP ship in the box, each gated |
| the app may grow | the same app code from one PaaS process to Kubernetes ([scale ladder](docs/idea/17-scale-ladder.md)) |

| Do not pick it when | Why |
|---|---|
| you need Node.js or Deno | Bun only, by design |
| your database is not Postgres | Postgres only |
| your UI is React, Vue or Svelte | SolidJS only |
| you deploy to Vercel functions, Lambda or Workers | containers only: zero platform primitives |
| you want plugins | there is no plugin API: an app wraps a primitive instead |
| you need multi-node realtime proven today | measured on one node only; see [Known gaps](wiki/Known-Gaps.md) |

The first five are the maintainer's committed `non_goals` ([`.dz/maintainer/maintainer.yml`](.dz/maintainer/maintainer.yml)); a request against one is declined with the axiom quoted.

## The proof, each with a command

A number written into a file goes stale on the next commit; the command does not. Run the right-hand column.

| Claim | Check it yourself |
|---|---|
| `x new` writes 218 files you never edit (185 with `--no-example`), asks 0 questions | `bun run scripts/generator-counts.ts --json` |
| the gate's steps, in order, each with a verdict | `bun run x -- verify --json` |
| a fresh scaffold is green on its first gate run, every push | the `scaffold-smoke` job in [`ci.yml`](.github/workflows/ci.yml) |
| a rolling restart on Kubernetes drops no request (0 of 9,028, `As of 2026-09-24`) | the `deploy-proof` job in [`ci.yml`](.github/workflows/ci.yml), `docker/deploy-proof/run.sh` |
| what npm serves; every package is there, attested | `npm view @ultimat3/core version` · `bun run scripts/registry-audit.ts --json` |
| realtime recovery on one node, from a forced restart | [`scripts/bench/results/README.md`](scripts/bench/results/README.md), held to the committed runs by [`scripts/bench-claims.ts`](scripts/bench-claims.ts) |
| every `X_*` code, its owner and its fix | `bun run x -- errors explain <CODE> --json` |

In use: [the live demo](https://social-media.ultimate.demo.developerz.ai), built from [`dummy/social-media-clone/`](dummy/social-media-clone/) and deployed on every push to `main` ([`deploy-social-demo.yml`](.github/workflows/deploy-social-demo.yml)). Two apps in this tree build on it and gate on every push: the demo and the reference app [`examples/dummy/`](examples/dummy/README.md) ([`scripts/lib/gated-apps.ts`](scripts/lib/gated-apps.ts)). No production use and no outside adopter is claimed.

**What those numbers do not say:**

| Not claimed | Why |
|---|---|
| that a green gate guarantees feature completeness | the gate asserts what its steps check, no more ([`scripts/lib/gated-apps.ts`](scripts/lib/gated-apps.ts)) |
| that few lines means many features | the demo's [`DOMAIN.md`](dummy/social-media-clone/DOMAIN.md) is partly a plan: `likes` and `comments` have no write path |
| that live messaging works in the demo | its live query and channel are declared and tested, and no island subscribes to either |

## Errors are instructions

Not a mock-up: built in [`packages/db/src/errors.ts`](packages/db/src/errors.ts), the same in the terminal, the browser overlay and `--json`.

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

A `fix:` naming no command, call or file fails the gate's `errors` step. A shipped code never changes meaning. → [Every code](wiki/Error-Codes.md)

## The eight primitives

`entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`. A feature that fits none of them does not ship, and a new capability is a factory over one (`llm()` returns an action, `backfill()` a job). → [The eight primitives](wiki/The-Eight-Primitives.md) · [the spec](docs/idea/02-primitives.md)

Packages are tiered and **imports only go down**, a build error otherwise: [`scripts/lib/tiers.ts`](scripts/lib/tiers.ts), `bun run boundaries`. Every package and its job: `bun run scripts/list-workspaces.ts --json`, or the [package map](docs/architecture/01-package-map.md).

## Navigate

| You want | Go |
|---|---|
| the reference manual | [wiki/](wiki/Home.md) · [browsable](https://github.com/developerz-ai/ultimate/wiki) |
| whether it fits a project this size | [docs/idea/21-the-range.md](docs/idea/21-the-range.md) |
| what is broken and known | [wiki/Known-Gaps.md](wiki/Known-Gaps.md) |
| idiomatic usage, every primitive once | [examples/dummy/](examples/dummy/README.md) |
| why a decision was made · how it is built · running it | [docs/idea/](docs/idea/README.md) · [docs/architecture/](docs/architecture/README.md) · [docs/ops/](docs/ops/README.md) |
| how much code you do not write, measured | [docs/idea/21-the-range.md](docs/idea/21-the-range.md) · [dummy/social-media-clone/](dummy/social-media-clone/) |
| what changed · what breaks · how it is released | [CHANGELOG.md](CHANGELOG.md) · [wiki/Upgrading.md](wiki/Upgrading.md) · [PUBLISHING.md](PUBLISHING.md) |

## Stability

Semver, with the window, the cadence and the date of the next major in [Stability](wiki/Stability.md). What each major breaks, and the edit it takes: [Upgrading](wiki/Upgrading.md).

## AI-maintained

Ultimate is maintained by AI, by [developerz.ai](https://developerz.ai): issues are triaged, pull requests reviewed and driven to green, releases cut by the bot under a committed policy ([`.dz/maintainer/maintainer.yml`](.dz/maintainer/maintainer.yml)). Who decides what, and how to reach a person: [GOVERNANCE.md](GOVERNANCE.md).

## Contributing

`bun install && bun run verify` (the gate; green = shippable), then [CONTRIBUTING.md](CONTRIBUTING.md) and [adding a feature](docs/architecture/15-adding-a-feature.md). Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT © [developerz.ai](https://developerz.ai)
