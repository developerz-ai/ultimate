# FAQ

Honest answers. Where something is not built yet, it says so.

## Status

### Is it production ready?

**Yes, for a single-region app on one Postgres, `As of 2026-11`, on the evidence below.** What you can check: [the live demo](https://social-media.ultimate.demo.developerz.ai), built from `dummy/social-media-clone/` and deployed on every push to `main` (`deploy-social-demo.yml`). Two apps in the repository build on it and gate on every push, the demo and the reference app `examples/dummy/` (`scripts/lib/gated-apps.ts`); no production use and no outside adopter is claimed. The API is under semver, and the window and the next major's date are on [Stability](Stability).

| Proven | By |
|---|---|
| a rolling restart on Kubernetes drops no request | `ci.yml`'s `deploy-proof` job, `docker/deploy-proof/run.sh`: 0 of 9,028 requests failed, `As of 2026-09-24` |
| a fresh scaffold is green on its first gate run | `ci.yml`'s `scaffold-smoke` job, every push |
| every package is on npm at one version, published by the workflow over OIDC, attested | `bun run scripts/registry-audit.ts --json`, and `registry-audit.yml` daily |
| one `sync` node reconnects all 50,000 clients after a forced restart | [`scripts/bench/results/`](https://github.com/developerz-ai/ultimate/tree/main/scripts/bench/results) |

What you can install is `npm view @ultimat3/core version`; only the [footer](_Footer) stamps it. How each release was published, the hand-published 2.0.0 included: [`PUBLISHING.md`](https://github.com/developerz-ai/ultimate/blob/main/PUBLISHING.md#publication-history).

What it does **not** claim:

| Not claimed | Detail |
|---|---|
| A multi-node realtime result | the 50k forced-restart benchmark **is** measured and committed, but on **one** `sync` node over `InProcessTransport` — it never crossed NATS. Fanout across nodes, throughput, and per-node socket capacity are all still targets, not results ([Realtime](Realtime)) |
| A rolling restart on **Compose** | Compose is the single-node rung: one published port has one binder, so a restart there is a restart. The invisible-restart proof is Kubernetes only ([Deployment](Deployment)) |
| Not shipped, `As of 2026-09-23` | the plugin API, multi-region replication, and the Redis **job** driver — all behind the interfaces that ship today (there is no NATS job driver since 25.0.0). The Redis driver throws `X_NOT_IMPLEMENTED` with a runnable `fix:` line rather than pretending to work |

### What is actually finished?

All 30 packages, implemented and tested — not skeletons. The eight primitives, HTTP, rendering, caching, realtime tiers 1–3 (tier 3 opt-in, since 21.0.0), auth, mail, storage, jobs, the AI-first surface (MCP, `llm()`, evals), and admin + generators + `x new`. Milestones 0–11 are ✅ and enforced by `x verify`'s `roadmap` step; milestone 11's deploy proof closed `As of 2026-09-24`, when `ci.yml`'s `deploy-proof` job upgraded an app in kind with 0 of 9,028 requests failed (Compose is the single-node rung and makes no invisible-restart claim). Each milestone ends in a **working demo app plus green `x verify`**, and the same demo app grows through all twelve. [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md) is the source of truth for those markers.

### What is left?

**No milestone is open**: milestone 11's two-platform deploy proof closed `As of 2026-09-24` (`deploy-proof`, above). The other item that was open at 1.0.0, the **50k-socket forced-restart benchmark**, is measured and committed at 1.1.0: 50,000 sockets, forced `sync` restart, first patch on the reconnected socket at p50 54.0s / p90 105.5s, on one node ([Realtime](Realtime)). Everything in milestones 0–11 is shipped and gated. Scope cuts come off the back, never the middle (M4's budgets). The open defects the current release shipped with are listed on [Known gaps](Known-Gaps).

## The stack

### Why Bun only?

Portability costs a lowest-common-denominator API. Bun-only makes `Bun.sql`, `Bun.redis`, `Bun.s3`, `Bun.serve` WebSockets, `Bun.build`, and `bun test` **language features** instead of dependencies — roughly a thousand transitive packages that never enter the lockfile. Target: under 40 direct dependencies for the whole framework.

### Why no Node or Deno support?

Multi-runtime means every native gets an adapter, every adapter gets a second behavior, and the second behavior is where bugs live. It would also make the WebSocket cost model — the thing `sync`'s economics depend on — a per-runtime variable. Stated cost: no native-addon packages, and long-running Bun processes are less battle-proven than Node's.

### Why no GraphQL?

A second schema language, a second authz surface, and a resolver-shaped N+1 factory. Typed `action` + `query` cover the need, and `openapi.json` is generated from them. One authz system is the whole point ([Policies and authz](Policies-And-Authz)).

### Why no Tailwind?

Tailwind plus modules plus CSS-in-JS in one repo is three token systems and three ways to theme. SCSS modules + design tokens is build-time only, zero runtime, and dark theme is a token flip. See [Theming](Theming).

### Why no React, and no RSC?

Wrong runtime for RSC, and the mental model taxes exactly the audience being optimized for. Solid's fine-grained reactivity makes streaming shells cost ~0 hydration, and `stream` + `<Hole>` gets the same payoff with no new component dialect.

### Why SolidJS and your own router?

The router must own render mode, offline strategy, and metadata — those are framework concerns, so it cannot be a third-party dependency that disagrees with the build. `As of 2026-08` the pin is **`solid-js@1.9.14`, the stable line**: Solid 2 is still pre-release (`2.0.0-beta.N`, DOM renderer split out into `@solidjs/web`), and every app inherits whatever reactive core this repo pins, so a beta core is a risk handed downstream. The ecosystem around Solid is thin either way, which is why the UI kit is ours too.

### Which schema library?

None. `@ultimat3/schema` ships its own dependency-free validators (`vendor: 'ultimate'`), exposed as `t`. One schema drives runtime parse, TS type, OpenAPI, and the MCP tool's JSON Schema.

Everything sits behind the Standard Schema v1 interface, so the default is swappable at the framework level — not per app. No ArkType, Zod or Valibot adapter ships; swapping to one means writing the ~40-line `configureSchemaProvider()` adapter yourself ([`packages/schema/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/schema/README.md)). A dependency the framework does not need is a dependency every app pays for.

## Design decisions people push back on

### Why is `idempotencyKey` required on every job?

At-least-once is the only honest guarantee any queue provides, so every handler must be replay-safe. "Remember to add a key" is exactly the instruction that gets dropped under pressure — by a human at 2am and by an agent always. Making it a required field converts a duplicate-charge incident into a red squiggle. Keys derive from `input` only: no timestamps, no random, no `ctx`.

### Why is every action an MCP tool?

Because the alternative is two authorization systems. An MCP call and an HTTP call reach the same `policy` with the same actor resolution — no MCP permission table, no "trusted tool" mode, no broad-rights service account. Actions still opt in per-action with `mcp: { expose: true }`; what is not optional is that exposure reuses the existing authz.

### Why does `x verify` block on budgets and SEO?

A convention that isn't a build error doesn't exist. A missing `description`, a blown JS budget, or a drifted migration is discovered in production otherwise — usually by someone who did not write the change. `x verify --json` names the route, the metric, the actual value, and the import chain that caused it.

### Is `x verify` really the only gate?

Yes. CI runs exactly `x verify` — no bespoke pipeline steps, because a check that lives only in CI is a check you cannot run locally. All 21 steps, in this order: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, exercise, e2e, eval, drift, contract-diff, budgets, seo, i18n, policy, manifest, roadmap. No `--skip`; `--only <step>[,<step>…]` is an iteration loop that prints `NOT A GATE RUN`. See [Testing](Testing).

### Why are there only eight primitives?

`entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task`. If a feature doesn't fit one of them, it doesn't ship. A push notification is a `job`; a share target is a `route` with a policy; an admin screen is a `query` plus actions. No PWA-specific or realtime-specific concept escapes into your mental model.

## Running it

### Do I need Docker to develop?

No. `x dev` uses embedded PGlite, in-process events, and a local directory in place of S3. `bunx create-ultimate myapp && cd myapp && bun run setup && bun run dev` — no Docker install, no `.env` scavenger hunt. `bun run setup` is six steps — `bun install`, an `.env.development.local` touch, `x db gen "initial"`, `x db migrate`, `x db seed`, `x manifest` — and is not optional: `x new` installs nothing ([Getting started](Getting-Started), [Bare VM](Bare-VM)). The compose files exist for parity debugging and CI jobs that want real services ([Deployment](Deployment)).

### Do I need Redis or NATS?

No. Postgres covers the job queue (`SELECT ... FOR UPDATE SKIP LOCKED`) and pubsub, and a local volume covers files. Redis is a cache tier you opt into; NATS is fanout you need once `sync` runs on more than one node. Both are drivers behind one interface — job code and query code never change.

### Can I deploy serverless or to the edge?

No, by design. Containers only. Edge runtimes, function-per-route, and vendor KV/queue/cron primitives would each need a second implementation of a framework primitive, and the second implementation is where behavior diverges. Requirement: something that runs containers, plus Postgres.

### How much infrastructure does a small app need?

One container running `ROLE=web` and one Postgres — there is **no** `ROLE=all`, and `x dev` is what co-locates roles locally. Split roles when a signal tells you to: RPS for `web`, connection count for `sync`, queue demand (jobs held plus jobs due) for `worker`. `scheduler` and `replicator` are fixed at one replica — a second is a warm standby, not throughput.

### Can I use it without the realtime tiers?

Yes. `realtime: { enabled: false }` in `app.config.ts` is the opt-out (its default: [Configuration → `realtime`](Configuration#realtime)), and there is no tier key to set — a tier is what your app **declares** (a `channel()` topic, a `live: true` query), never a config value. An app that declares none needs no `sync` role, no `replicator`, and no NATS. That is a complete product without any realtime at all: entities, actions, a typed client, five render modes, a 0kb static path, and durable jobs.

## Risk

### What happens if the sync engine doesn't work out?

It is roughly **70% of total effort** and the single largest risk. Tiers 1–2 shipped in milestone 6 and are under semver; tier 3 local-first shipped in 21.0.0, opt-in per entity (`entity(name, { persist: true })`). The reconnect benchmark that gated topology — 50k sockets, a forced `sync` restart, recovery time and DB load — **is measured at 1.1.0**: all 50,000 reconnected, 49,981 received a channel patch inside the window, p50 54.0s / p90 105.5s, 156,851 connect attempts shed before any query path ([Realtime](Realtime)). That is **reachability** — first patch on the reconnected socket — not consistency; the delivery half is a separate 10,000-client run, **1,666,882 patches received, 0 observed sequence gaps** — a lower bound, since a hole is only visible between two frames one connection received ([Realtime](Realtime)) — and `As of 2026-08` the only run that counts lost patches at all. Both were run on **one** node, so multi-node fanout is still unproven. If the incremental matcher turns out to be the bottleneck, wrapping an existing protocol (Zero's) is an accepted fallback.

### Why ship realtime last if it's the differentiator?

A half-built sync engine is worth nothing: it cannot be shipped partially, demoed honestly, or tested against a real app, and it consumes the attention everything else needs. Starting there is how this project would die with 40 packages and no users.

### What if Bun has a problem under sustained load?

Stated risk, not a hidden one. `As of 2026-08` long-running Bun processes are less proven than Node's, so memory profiling under sustained socket load is explicit roadmap work. See [`docs/idea/15-risks.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/15-risks.md).

## Scope

### Where do plugins fit?

Nowhere — there is no plugin API and there has never been one, `As of 2026-08`. Semver covers the documented surface, not internals, and a plugin API freezes internals permanently. Fork the blessed path if you need something else; extension points earn their existence from real forks, not from speculation.

### Can I publish a package for other Ultimate apps?

Yes: a factory over the eight primitives, published as `ultimate-<name>` with the keyword `ultimate-package` and `@ultimat3/*` as `peerDependencies` at `^<major>`. There is no marketplace or registry; `npm search keywords:ultimate-package` is the directory. How, and what a consumer's gate sees: [Building your own base](Building-Your-Own-Base#publish-it).

### Does Ultimate collect anything?

Nothing in `x` is written to: no telemetry, analytics, crash report or update check. What the gate proves is narrower, and exactly this: every host a non-test file in `packages/cli/src` spells is either a reserved name (`.invalid`, `.test`, `example.com`, `localhost`) or a row with its reason in `CLI_OUTBOUND_ALLOWLIST` (`scripts/cli-outbound.ts`), and a new one fails the gate's `boundaries` step with `X_CLI_OUTBOUND_UNDECLARED`. It reads literals only, in the CLI's own source: a host assembled at run time, and the other packages, are not covered. The network `x` does touch is the network you asked for: `x upgrade` reads your configured npm registry through `bun pm view`, `x pr` and `x ci` go through your own `gh`, `x deploy verify` polls your own origin. If telemetry is ever added it is opt-in, off by default, and a major.

### Will you add an adapter for my host or my ORM?

No. Multi-ORM means two migration stories and two sets of generated SQL for an agent to learn. Vendor deploy adapters violate the containers-only axiom. Removing an alternative is treated as a feature.

### Is it overkill for a small project?

No, and it is measured rather than argued. `x new` asks **0** questions (all five flags carry a
default), writes **134** files you never edit, installs **104** packages, and reaches a running app
in **4** commands with **0** env values supplied and nothing to install first — no Docker, no
Postgres, no Redis, no NATS. There is no lite mode to pick, because there is no second path to pick
between ([axiom 1](Home#the-rules-everything-else-follows)). The whole range, both ends, with the
command behind every number: [`docs/idea/21-the-range.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/21-the-range.md).

### Is it enough for a very large project?

The capability answer is [`docs/idea/20-large-app-readiness.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/20-large-app-readiness.md) — graded against what a very large product needs, including what it must still build itself — and the deployment answer is [`docs/idea/17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md), rung by rung, naming where the "no app code change" invariant breaks today. What is **not** claimed: nobody has shipped a very large app on it yet, and this wiki will say so until somebody has.

### Who is it for?

Primary user: **an AI agent** — one correct way per task, machine-readable errors, generated facts to read. Secondary: **a tired senior engineer, working through their own AI agent and AI reviewer** — no glue code, no config archaeology, no 3am pager. Both want the same thing: fewer decisions with consequences.

### How is this different from Rails, Next.js, Meteor, or Phoenix?

Rails, Next.js, Meteor, Phoenix and Inngest / Zero each get a section on [Compared](Compared): when to pick that stack instead, first, then when to pick this one, and what you give up here.

Nothing here is novel in isolation. See [Home](Home) for the full "steal explicitly" table.

## Getting unstuck

### Where do I report a bug?

Run `x verify --json` and `x doctor --json`, attach both, and open an issue. The JSON is the report. Security issues go through [`SECURITY.md`](https://github.com/developerz-ai/ultimate/blob/main/SECURITY.md), never a public issue.

### An error code is unclear — where do I look?

`x errors explain <CODE> --json`, then [Error codes](Error-Codes). Every `X_*` code carries a cause, an exact fix command, and a docs URL, rendered identically in the terminal, the browser overlay, and `--json`. Symptom-first: [Troubleshooting](Troubleshooting).
