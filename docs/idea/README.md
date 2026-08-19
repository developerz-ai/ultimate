# 💡 Ultimate — the idea

Why Ultimate exists, what it locks down, and what it refuses to build. Read [`00-thesis.md`](./00-thesis.md) first; everything else expands one axiom.

| Doc | Hook |
|---|---|
| [`00-thesis.md`](./00-thesis.md) | Rails' philosophy, but the primary developer is an AI agent — plus the inspire-explicitly table and the 8 axioms. |
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
| [`17-scale-ladder.md`](./17-scale-ladder.md) | PaaS to distributed in five rungs, where climbing is config and drivers — never a rewrite. **Rungs 0–2 are real** and 24 of the 26 seam rows are shipped; the doc names every place the invariant breaks today. |
| [`18-build-vs-wrap.md`](./18-build-vs-wrap.md) | Own the integration layer, wrap the protocol layer. Verdicts: jobs BUILD, SMTP BUILD, NATS WRAP — adopted, `nats@2.29.3` at the transport seam. |
| [`19-mechanism-not-convention.md`](./19-mechanism-not-convention.md) | Axiom 8. Mechanisms and structural conventions ship; business conventions never do. Tenancy ships, an org model does not — the app wraps. |
| [`20-large-app-readiness.md`](./20-large-app-readiness.md) | The capability axis: what a very large app already gets, and whether a company can plug its own infrastructure in. The primitives are enterprise-grade; the dominant defect is a mechanism **built, exported, and never called by the boot** — the outbox, the scheduler watermark, the shared cache tier, WebSocket auth. |

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
| **Adopting it for a very large product** | `20` → `19` → `17`. `20` is the capability axis — what is built but uncalled, and which seams take your own drivers; `19` is the rule it scores against; `17` is the deployment one |

## The one-paragraph version

Bun-only, opinionated, full-stack. Postgres with no ORM, SolidJS pinned at `1.9.14` (the stable line — [`01-stack.md`](./01-stack.md)), SCSS modules + tokens, Standard Schema behind a dependency-free builtin provider, Better Auth. Eight primitives — `entity policy action mutator query job route task` — and nothing else ships. One `action` declaration projects to an HTTP route, an OpenAPI operation, a typed client function, a job handle, an MCP tool, and a test scaffold, all sharing **one** authz system. Realtime is a three-rung ladder with the same mutator shape at every rung. Jobs are durable steps enqueued through a transactional outbox. Caching is four tiers behind one tag graph. `site/` cannot import `app/` — build error. SEO, budgets, migration drift, and import boundaries are build failures, not guidelines. `x verify` green means shippable. Deploy target = anything that runs containers.

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
| 8 | Ultimate ships mechanism; your app ships convention. |

Consequences of each in [`00-thesis.md`](./00-thesis.md); axiom 8 in full in [`19-mechanism-not-convention.md`](./19-mechanism-not-convention.md).

## Status

`As of 2026-08-19`: **repository, tag and registry are all at 3.0.0.** The release ran. Resolve every row below rather than believing it — a version in a doc is a snapshot, a command is not.

| Fact | State, `As of 2026-08-19` | Read it yourself |
|---|---|---|
| Versioned | 29 `@ultimat3/*` packages plus the unscoped `create-ultimate` — 30 in all — at 3.0.0 in lockstep, one commit. A major: 10 changelog entries marked `BREAKING —` from a five-agent bug sweep, no codemod. 2.0.0 was the first major and carried 33 | `bun run scripts/release.ts --check 3.0.0` |
| Tagged | `v3.0.0` is on origin, and its GitHub Release is published — that Release is what triggers the workflow | `git tag --list 'v3.*'` |
| Published | **`latest` is 3.0.0** — that is what `bunx create-ultimate myapp` installs | `npm view @ultimat3/core version` |
| Publication holes | **none.** All 30 workspaces are on the registry at 3.0.0. `@ultimat3/scraping` was the last never-published package and was bootstrapped by hand at 2.0.0, exactly as `@ultimat3/flags` had been — the one-time step in [`PUBLISHING.md`](../../PUBLISHING.md) that every package needs before a trusted publisher can attach | `bun run scripts/release-workflow.ts --json` for the derived list, then `npm view` each name — one package proves one package |
| Provenance | every 3.0.0 tarball carries an attestation and `_npmUser: GitHub Actions`; **2.0.0 carries neither**, having gone out by hand | `npm view @ultimat3/core@3.0.0 dist.attestations`, `npm view @ultimat3/core@2.0.0 dist.attestations` |
| OIDC trusted publisher | attached to all 30 on 2026-08-19, with `Environment: npm-publish` — that attachment is what let the workflow publish 3.0.0 at all, and its absence is why 2.0.0 has no provenance. Not the first ever: 1.1.0 and 1.2.0 published under earlier publisher configurations (a different `oidcConfigId` per package) | `NPM_CONFIG_OTP=<code> bun run scripts/trust-publishers.ts --check --json` — every package, and without a fresh code they all read as missing. Per version: `npm view @ultimat3/core@1.2.0 _npmUser.trustedPublisher` |

Docs `00`–`15`, `18` and `19` describe what exists; `16` and `17` are design only and say so in every claim.

Milestone order and the "done when" bar for each live in [`14-roadmap.md`](./14-roadmap.md); the honest accounting of what could kill the project is in [`15-risks.md`](./15-risks.md) — read it before the roadmap, not after.

## Conventions in these docs

| Convention | Meaning |
|---|---|
| Code blocks | canonical API shapes; they match the framework's contract byte-for-byte |
| `X_*` | a stable error code with a cause, a fix command, and a docs page |
| `As of 2026-07` | a claim about the outside world that has a shelf life |
| "build error" | literal — `x verify` and the dev server both fail |
