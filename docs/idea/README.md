# 💡 Ultimate — the idea

Why Ultimate exists, what it locks down, and what it refuses to build. Read [`00-thesis.md`](./00-thesis.md) first; everything else expands one axiom.

| Doc | Hook |
|---|---|
| [`00-thesis.md`](./00-thesis.md) | Rails' philosophy, but the primary user is an AI agent — plus the steal-explicitly table and the 7 axioms. |
| [`01-stack.md`](./01-stack.md) | One locked choice per layer; Bun natives delete ~40 dependencies before you write a line. |
| [`02-primitives.md`](./02-primitives.md) | Eight primitives. `action` projects to six artifacts. Two authz systems is how every Meteor-like framework died. |
| [`03-realtime.md`](./03-realtime.md) | Channels → live queries → local-first: a ladder, not three products. Tier 2 → 3 is a config flag. |
| [`04-jobs.md`](./04-jobs.md) | Transactional outbox by default, durable steps, idempotency key required by the type. |
| [`05-caching.md`](./05-caching.md) | Four tiers, one invalidation graph. `invalidates: [tag.post]` reaches memo, LRU, Redis, ISR, and the CDN in one hop. |
| [`06-surfaces.md`](./06-surfaces.md) | `site/` cannot import `app/` — a build error, because that import is how marketing pages ship charting libraries. |
| [`07-rendering-seo.md`](./07-rendering-seo.md) | Five render modes; `stream` is the app default. SEO is enforced, not documented. |
| [`08-pwa-offline.md`](./08-pwa-offline.md) | `sw.js` is emitted, never hand-edited. Version skew is what actually breaks PWAs. |
| [`09-ai-first.md`](./09-ai-first.md) | The differentiator: MCP dev server, generated facts, and apps whose own dashboards expose MCP. |
| [`10-testing.md`](./10-testing.md) | One cloned Postgres database per worker, sealed network, frozen clock. Parallel is opt-in, and says so. |
| [`11-topology.md`](./11-topology.md) | One image, six roles, graceful drain that redistributes sockets instead of stampeding. |
| [`12-build-deploy.md`](./12-build-deploy.md) | `x build --target docker\|binary\|static`. Deploy target = "runs containers". Nothing else. |
| [`13-dx.md`](./13-dx.md) | First 60 seconds: no Docker, no env scavenger hunt, sub-second HMR that keeps state. |
| [`14-roadmap.md`](./14-roadmap.md) | 12 milestones, each ending in a working demo app + green `x verify`. Ship 0–5 before realtime. |
| [`15-risks.md`](./15-risks.md) | Six risks, honestly sized. The sync engine is ~70% of the effort. |
| [`16-app-targets.md`](./16-app-targets.md) | Web, mobile, desktop from one definition. A screen is a `route`, not a ninth primitive. **Design only.** |
| [`17-scale-ladder.md`](./17-scale-ladder.md) | PaaS to distributed in five rungs, where climbing is config and drivers — never a rewrite. **Design only.** |
| [`18-build-vs-wrap.md`](./18-build-vs-wrap.md) | Own the integration layer, wrap the protocol layer. Verdicts: jobs BUILD, SMTP BUILD, NATS WRAP (pending). |

## Reading paths

| You are | Read |
|---|---|
| Evaluating the idea | `00` → `01` → `02` → `15` |
| Implementing a package | `02` → the doc for your primitive → `10` |
| Judging shippability | `14` → `10` → `12` |
| Here for the AI story | `09` → `02` → `13` |
| Operating it | `11` → `12` → `08` |
| **Deploying and scaling** | `17` → `12` → `11`, then [`docs/ops/`](../ops/README.md) for the runbooks. Start at rung 0: a free PaaS plan, no card |
| **Building for mobile or desktop** | `16` → `02` → `06`. Design only — no package, no build target, no gate step exists yet |

## The one-paragraph version

Bun-only, opinionated, full-stack. Postgres with no ORM, SolidJS 2, SCSS modules + tokens, Standard Schema behind a dependency-free builtin provider, Better Auth. Eight primitives — `entity policy action mutator query job route task` — and nothing else ships. One `action` declaration projects to an HTTP route, an OpenAPI operation, a typed client function, a job handle, an MCP tool, and a test scaffold, all sharing **one** authz system. Realtime is a three-rung ladder with the same mutator shape at every rung. Jobs are durable steps enqueued through a transactional outbox. Caching is four tiers behind one tag graph. `site/` cannot import `app/` — build error. SEO, budgets, migration drift, and import boundaries are build failures, not guidelines. `x verify` green means shippable. Deploy target = anything that runs containers.

## The axioms, in one table

| # | Axiom |
|---|---|
| 1 | One way to do each thing. |
| 2 | Define once, project everywhere. |
| 3 | Enforced, not documented. |
| 4 | Errors are instructions. |
| 5 | One command means shippable. |
| 6 | Static path never pays for the app path. |
| 7 | Deploy anywhere = containers only. |

Consequences of each in [`00-thesis.md`](./00-thesis.md).

## Status

`As of 2026-08`: **1.0.0, shipped.** All 28 packages publish to npm in lockstep, each behind an OIDC trusted publisher. Docs `00`–`15` describe what exists; `16` and `17` are design only and say so in every claim.

Milestone order and the "done when" bar for each live in [`14-roadmap.md`](./14-roadmap.md); the honest accounting of what could kill the project is in [`15-risks.md`](./15-risks.md) — read it before the roadmap, not after.

## Conventions in these docs

| Convention | Meaning |
|---|---|
| Code blocks | canonical API shapes; they match the framework's contract byte-for-byte |
| `X_*` | a stable error code with a cause, a fix command, and a docs page |
| `As of 2026-07` | a claim about the outside world that has a shelf life |
| "build error" | literal — `x verify` and the dev server both fail |
