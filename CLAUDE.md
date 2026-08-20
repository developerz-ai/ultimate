# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Ultimate

A full-stack, **Bun-only**, opinionated web framework. Rails' philosophy on a Bun + Postgres + SolidJS stack, where **the primary developer is an AI agent** and the secondary developer is a tired senior engineer working through their own AI agent and AI reviewer.

Rails' actual promise, applied to agents: **reduce the number of problems the author has to worry about**, so the work goes into the app's features instead of the app's infrastructure. Every decision the framework makes is a decision an agent does not have to.

This repo is the framework itself: a monorepo of `@ultimat3/*` packages, the `x` CLI, the docs, the wiki, and two tracked apps — one reference app (`examples/dummy`) and one deployed demo (`dummy/social-media-clone`), each gated on its own `expectedRed` table.

CLI binary: `x`. npm scope: `@ultimat3`. Import paths: `@ultimat3/<pkg>`.

**Status:** 5.0.0, released, `As of 2026-08-20`. 29 `@ultimat3/*` packages plus the unscoped
`create-ultimate` — 30 in all — **versioned** in lockstep and **published** in lockstep: one version,
one commit, one tag, 30 tarballs.

**Repository, tag and registry agree.** Never read a number here as the installable one; run the
command beside it — that is the only thing here that cannot go stale. `bun run scripts/registry-audit.ts --json`
covers the **npm** rows in one call — it answers `30/30 publishable packages are on npm at 5.0.0,
every one attested` or names each gap with a runnable `fix:` — and it asks nothing about the tag or
the Release, which are the two rows below it.

| Fact | State, `As of 2026-08-20` | Read it yourself |
|---|---|---|
| Repository version | 5.0.0, every workspace stamped | `bun run scripts/release.ts --check 5.0.0` |
| Publishable workspaces | 30 | `bun run scripts/release-workflow.ts --json` |
| On the registry | **all 30 at 5.0.0**, no holes | `bun run scripts/registry-audit.ts --json` |
| npm `latest` | **5.0.0** — `bunx create-ultimate myapp` installs it | `npm view @ultimat3/core version` |
| Provenance | every 5.0.0 tarball attested, `_npmUser: GitHub Actions` | `npm view @ultimat3/core@5.0.0 dist.attestations _npmUser` |
| Tag and Release | `v5.0.0` pushed **annotated**, GitHub Release published — the Release is what triggers the workflow | `git ls-remote --tags origin 'refs/tags/v5.0.0*'` — both the ref **and** its peeled `^{}` line, which is what proves it is annotated and on the remote; then `gh release view v5.0.0 --json tagName,isDraft,publishedAt`. **Not** `git tag --list`, which reads the local repository and answered `v4.0.0` throughout the window in which the tag had never been pushed |
| OIDC trusted publisher | attached to all 30, with `Environment: npm-publish` | `NPM_CONFIG_OTP=<code> bun run scripts/trust-publishers.ts --check --json` — without a fresh OTP every package reads as missing |

**A lightweight tag is not a release trigger, and `--follow-tags` will not push one.** `v4.0.0` was
first created with a bare `git tag v4.0.0`; `git push --follow-tags` pushed the commit, said nothing,
and left the tag local — `--follow-tags` pushes **annotated** tags only. The GitHub Release could
then not be created against a ref the remote did not have. `git tag -a` is the only form
[`PUBLISHING.md`](PUBLISHING.md) writes, for this reason.

**There are no publication holes, and `scripts/registry-audit.ts` is what keeps it that way.**
`@ultimat3/scraping` was the last one, bootstrapped by hand at 2.0.0 on 2026-08-19 —
`npm publish --access public --provenance=false`, the one-time step every package needs before a
trusted publisher can attach — and npm now answers `E403 … cannot publish over the previously
published versions: 2.0.0` on a retry. `@ultimat3/flags` was the same shape and was closed the same
way. Publication is a step apart from versioning, so the two can disagree silently: the audit runs
in CI and files a `registry-drift` issue when they do, which is exactly what it did during 4.0.0's
release window while the publish sat behind the `npm-publish` environment gate (issue #221, closed
when the run finished). The publish list itself is **derived** from `scripts/list-workspaces.ts`,
which is what keeps a new package from being silently absent from it. Step 1 of `PUBLISHING.md`
comes due again for the next package added after a release run, and nothing else.

**5.0.0 is a major, and its migration is one line.** Four breaking changes, each deleting or
correcting a DECLARATION that promised something the code did not do — the same sweep 4.0.0 ran,
applied to what was left after it. Only one needs an edit: delete `driver:` from `jobs` in
`app.config.ts`. `JobsConfig.driver` accepted `'postgres' | 'redis' | 'nats'`, had **no reader
anywhere**, and boot always built `createPgDriver` — so `jobs: { driver: 'redis' }` did not throw,
did not warn, and silently gave you Postgres. Worse than `realtime.heartbeatMs`, which 4.0.0 deleted
for the same reason, because it failed silently in the DANGEROUS direction. The other three are
`@ultimat3/testing`'s `subscribe` fixture types, which nothing could have implemented: the fixture
had no driver until 5.0.0 built one.

**4.0.0 was the sweep before it** — 25 entries marked `BREAKING —` and no codemod, so each one is a
manual edit its own entry names. [`wiki/Upgrading.md`](wiki/Upgrading.md) walks every major. The shape of the sweep: things **declared and never wired** were either wired or deleted
(`PrecacheAsset.critical`, `realtime.heartbeatMs`, `CaptureOptions.timeoutMs`, `PERIODIC_SYNC_TAG`,
`requiresApp`), and things that **answered the wrong thing** were corrected (`on delete` reaching
the generated SQL, `in` with a non-array operand, `t.date` accepting an offsetless date-time,
`isValidCron` accepting an unsatisfiable day/month pair, a local disk's signed URLs carrying the
driver kind rather than the registered disk name). 2.0.0 was the **first** major and carried 33;
3.0.0 carried 10.

**Every package has an OIDC trusted publisher.** `developerz-ai` / `ultimate` / `release.yml` /
environment `npm-publish`, publish permission, all 30, verified per package with
`npx -y npm@12 trust list <pkg> --json` — `npm trust` shipped in **npm 12** and Bun's bundled npm
answers it as an unknown command, which is why `scripts/trust-publishers.ts` pins the runner. That
attachment is what let [`.github/workflows/release.yml`](.github/workflows/release.yml) publish
3.0.0 and then 4.0.0: 30 tarballs per release, each attested, `_npmUser: GitHub Actions`.

**The `npm-publish` environment needs a human to approve the run.** The release workflow reaches
`waiting` and publishes nothing until a named reviewer approves the pending deployment — the last
point at which an irreversible publish can be stopped. `gh run view <id>` reports `waiting`, not a
failure.

**2.0.0 is the one release with no provenance**: no publisher was attached, so the OIDC exchange had
nothing to verify against, the workflow could not publish, and 2.0.0 went out by hand —
`_npmUser: sebyx07`, no `dist.attestations`, where 1.1.0, 1.2.0 and every release from 3.0.0 carry both. Not
"for the first time" — this file said that until 2026-08-19 and `CHANGELOG.md`'s 3.0.0 header still
does: 1.1.0 and 1.2.0 published under **earlier** publisher configurations, one per package, and
`npm view @ultimat3/core@1.2.0 _npmUser.trustedPublisher` answers an `oidcConfigId` that differs from
3.0.0's. 1.0.0 was the manual bootstrap.

Semver applies — a breaking change to a documented API needs a major, and the eight primitive shapes,
the `x` CLI surface and the tier table are as stable as the `X_*` codes already were.

Realtime capacity is **measured on one node, in two halves that answer different questions**.

**Reachability, 50,000 clients:** real WebSocket clients against a single `sync` node over
`InProcessTransport`, `SIGKILL`ed with no drain. All 50,000 reconnected; **49,981** received a
channel patch inside the window, p50 54.0s / p90 105.5s / max 145.7s; 156,851 connect attempts shed
by the `AcceptBudget` before any query or snapshot path. That figure times **first delivery on the
reconnected socket** — reconnect *and* resubscribe *and* one patch. It was labelled
"time-to-consistent" until 2026-08 and never measured consistency: the harness recorded
`lastSeenSeq` and read it nowhere, so a patch the node dropped was invisible to it by construction.
The timings are unchanged and still stand; only the name was wrong.

**Delivery, 10,000 clients:** the same harness, now counting holes in the probe sequence each client
receives, per connection ([`scripts/bench/restart-bench-seq.ts`](scripts/bench/restart-bench-seq.ts)).
10,000 clients, a probe every 200ms, all 10,000 reconnected: **1,666,882 patches received, 0 observed
sequence gaps** — no gap, no duplicate, no rewind on any client. A **lower bound**, not a proof of
zero loss: a hole is only visible between two frames one connection received, so anything lost before
a connection's first message or after its last is invisible, as is a connection that received nothing. It needs its own counter because a channel topic has
no cursor and no re-snapshot: a frame `SyncSocket.send` drops under backpressure is unrecoverable,
and `ChannelHub`'s bridge discards the `false` that would have said so. **`SocketRegistry.deliver`
does not** — this file claimed it did until 2026-08, and
[`packages/realtime/src/socket.ts`](packages/realtime/src/socket.ts) counts the drop, increments
`channel_frames_dropped_total`, logs `channel.frames_dropped` and exposes `droppedChannelFrames`.
Counted in three places and repaired in none is the accurate statement, and
[`packages/realtime/CLAUDE.md`](packages/realtime/CLAUDE.md) always carried it; the bridge
(`channel.ts`) is the one caller that still throws the answer away.
`As of 2026-08` this is the only run with delivery accounting — the 50,000-client result predates
the counter and carries no delivery number at all.

Per-node recovery in both: neither run crossed NATS and neither subscribes to a live query, so no
cursor, snapshot or gap-repair path is under test. Not a multi-node result and not a throughput
figure. [`scripts/bench/restart-bench.ts`](scripts/bench/restart-bench.ts), results committed under
[`scripts/bench/results/`](scripts/bench/results/).

Open: roadmap milestone 11's two-platform deploy proof — 1.1.0 gave a scaffolded app a real
deployable artifact (`packages/cli/src/serve.ts`; `x new` writes `apps/web/server.ts`,
`prerender.ts`, a Dockerfile and `docker-compose.prod.yml`; `ROLE=migrate` runs release-phase
migrations), and **4.0.0 gave it a chart** — `x new` writes `docker/helm`, 8 files: a
`Deployment` for each of the four roles enabled by default (`web`, `sync`, `worker`, `scheduler`),
`replicator` behind `enabled: false`, and `migrate` as a `Job` rather than a Deployment. So
`x deploy --method helm` runs `helm upgrade --install` against it with nothing to copy in. What is still missing is the **proof**, which is the milestone: the demo app on
Compose **and** K8s from one image, with an invisible rolling restart, has not been demonstrated.
Two things had to be true before it could be, and each was false in turn — until 2.0.0 `sync`'s
readiness probe polled a port the process never opened, and until 4.0.0 a scaffolded app had no
chart at all and `--method helm` exited `X_NOT_IMPLEMENTED`. Of the four known gaps
named in [`CHANGELOG.md`](CHANGELOG.md), **all four are closed in 2.0.0**, `As of 2026-08`:

| Gap | State |
|---|---|
| `x build --target binary` compiled and crashed at import | **fixed, and now proven** — the version read is lazy and `x build` passes `--define ULTIMATE_FRAMEWORK_VERSION`. `docker/Dockerfile` passes it too as of 2.0.0; it had not, so the target was fixed everywhere except in the artifact the framework ships. The image build now ends in `/out/app --version`, so a binary that cannot answer fails the build rather than the first command an operator runs |
| the shared cache tier's Lua invalidation `DEL`s keys it never declares in `KEYS` | **fixed** — the script returns the member list and the tier deletes value keys client-side, one key per `DEL`, so it is slot-local on Redis Cluster and Dragonfly |
| `docker-compose.prod.yml` pairs a published host port with `replicas` above 1 | **fixed** — a published host port has exactly one binder (reproduced: the second replica dies with `Bind for 0.0.0.0:3000 failed: port is already allocated`), so `web` and `sync` declare `replicas: 1` in all four files — framework, both tracked apps, and `x new`'s scaffold. Scaling either is the reverse proxy you add or the chart's per-role HPA, both named in the file header: Compose is the ladder's single-node rung and the box is the availability story |
| `resolveEnvironment` exists in both `core` and `seo` with different return types | **fixed** — seo's is deleted; core's is the one reader of `ULTIMATE_ENV`, and `'preview'` is now core's `'staging'`. The half that was not obvious: `ULTIMATE_ENV` is **not in the env schema**, so nothing validates it at boot and a `robots.txt` render can be its first reader — hence `tryResolveEnvironment()` in core, which answers `undefined` rather than throwing, instead of a second resolver in seo |

Milestone detail: [`docs/idea/14-roadmap.md`](docs/idea/14-roadmap.md).

## Design axioms (override any instinct that conflicts)

1. **One way to do each thing.** Ambiguity is the tax agents pay. Never add a second path.
2. **Define once, project everywhere.** One `action` → HTTP + OpenAPI + typed client + job handle + MCP tool + tests.
3. **Enforced, not documented.** A convention that isn't a build error doesn't exist.
4. **Errors are instructions.** Stable code + cause + exact fix command + `--json`.
5. **One command means shippable.** `x verify` is the contract.
6. **Static path never pays for the app path.** Separate bundle graphs, hard boundaries.
7. **Deploy anywhere = containers only.** Zero platform primitives in the framework.
8. **Ultimate ships mechanism; your app ships convention.** Mechanisms and *structural* conventions
   ship — the same for a bank and a blog. *Business* conventions never do. Primitives are functions
   returning values, so an app encodes its own by wrapping one: no fork, no patch, no plugin API.
   [`docs/idea/19-mechanism-not-convention.md`](docs/idea/19-mechanism-not-convention.md).

## Commands

| Task | Command |
|---|---|
| install | `bun install` |
| **the gate** | `bun run verify` — `x verify` at the repo root, 17 steps: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, manifest, roadmap. Green = shippable. |
| typecheck | `bun run typecheck` |
| lint | `bun run lint` · fix: `bun run lint:fix` |
| test (all) | `bun run test` — every framework suite, opt-in ones included. The reference app is gated separately: `cd examples/dummy && bun run ../../packages/cli/src/bin.ts verify` |
| **the app gate** | `bun run scripts/reference-app-gate.ts` — both tracked apps' own 17 steps (`examples/dummy`, `dummy/social-media-clone`), blocking on a ratchet: a step passing today must keep passing, a step pinned in that app's `expectedRed` (`scripts/lib/gated-apps.ts`) must still be failing, and a `typecheck` that goes green must join the root `tsconfig.json` references |
| shrink the ratchet | `bun run scripts/reference-app-gate.ts --unpin <app>:<step>[,<step>]` — the edit `X_REFERENCE_APP_PIN_STALE` names, performed |
| test (one file) | `bun test packages/core/src/errors.test.ts` |
| test (one name) | `bun test -t 'formats the fix line'` |
| import boundaries | `bun run boundaries` |
| bare Errors in tests | `bun run scripts/test-bare-error.ts` — a step of the gate's `errors` check, standalone. A test may not report its own verdict by throwing a bare `Error`; `expect.unreachable` is the idiom. A ratchet, because 422 sites were already there — `--unpin <pkg>` lowers a count and refuses to raise one. A `new Error` **not thrown** is the subject's input and is never reported |
| unsafe error rendering | `bun run error-render` — a step of the gate's `errors` check, standalone. Refuses an `unknown` reaching a `cause:`/`fix:` through `${x}`, `JSON.stringify(x)` or `String(x)`; all three throw on real app values, and the bug shipped three times before it was mechanised |
| regenerate manifest | `bun run manifest` |
| list workspaces | `bun run workspaces:list` |
| new framework package | `bun run scripts/new-package.ts <name> --tier <n>` |
| the CLI, in-repo | `bun run x -- <args>` (e.g. `bun run x -- doctor --json`) |

Run everything from the repo root. Prefer `bun run verify` before claiming work is done.

## Layout

```
packages/       the framework — one package per responsibility, tiered (see below)
examples/dummy/ the reference app: every primitive, once, idiomatically
dummy/social-media-clone/  the deployed demo app: production image built on every push to main
docs/idea/      what and why — the design spec
docs/architecture/  how it's built — internals
docs/ops/       running an app for real — PaaS → Compose → K8s, secrets, observability, runbooks
wiki/           the reference manual, and the only public documentation surface (synced to the
                GitHub wiki). There is no separate marketing site — decided 2026-08
scripts/        setup, verify, boundaries, manifest, release, bench
docker/         Dockerfile + compose + helm
llms.txt        the machine-readable repo map
framework.manifest.json  GENERATED by `bun run manifest`: packages, tiers, every X_* code with
                its owner and the file that declares it — scripts/ gate codes included. Never
                hand-edited — drift fails `bun run verify` (X_MANIFEST_DRIFT)
```

## Package tiers — imports may only go DOWN

A package may import from strictly lower tiers. Never sideways within a tier, never upward. Enforced by `bun run boundaries`; a violation is a build error. The table below is prose — [`scripts/lib/tiers.ts`](scripts/lib/tiers.ts) is the executable copy, and they must agree.

| Tier | Packages |
|---|---|
| 0 | `core`, `schema` |
| 1 | `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage`, `flags` |
| 2 | `entity`, `policy`, `http`, `auth` |
| 3 | `action`, `query`, `jobs`, `realtime` |
| 4 | `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail`, `ui` |
| 5 | `admin`, `testing`, `cli`, `scraping` |

Declared sideways edges, each earning its line: `realtime → query`, `cli → admin`, `cli → testing`, `create-ultimate → cli`.

**`admin → ui` is gone, and `ui` moved 5 → 4, decided 2026-08-19.** The edge was justified on
composition grounds — "the admin dashboard *is* the ui kit" — which is true and was never the
reason it was needed: `ui` imports `core`, `i18n`, `money` and `time`, so tier **2** is the lowest
its real imports allow and tier 5 was two tiers too high. The exception existed only to undo that
placement. `ui` sits at 4 rather than at its floor so `render → ui` stays forbidden (both at 4),
which [`packages/render/CLAUDE.md`](packages/render/CLAUDE.md) requires — the static bundle graph
may not reach the design system, which is axiom 6. An exception line in an enforcement table is a
rule with a hole in it, and deleting the hole beats arguing for it.

`scripts/lib/tiers.ts` claims each package sits "at the lowest tier their real imports allow —
checked by this file's own rule, not by opinion", and **no such check exists**: `boundaries.ts`
enforces the ceiling only. `render`, `pwa` and `scraping` also sit above their floors `As of
2026-08-19`. Adding a floor rule is deliberately not done yet — it reds three more packages the
day it lands, and that is its own piece of work rather than a rider on this one.

**`cli → testing` was declared 2026-08**, when `bun run boundaries` learned to follow relative specifiers. `packages/cli/src/serve.live.test.ts` had been importing `../../testing/src/sealed-network` with a comment saying the package specifier "is a sideways import the boundary check refuses" — an evasion the check could not see. `@ultimat3/testing` was already a runtime `dependencies` entry of `@ultimat3/cli`, so the manifest had crossed the edge all along; declaring it makes the rule enforce what shipping already assumed. `create-ultimate` sits above the table at tier 6 and its declared edge is its *only* permitted import.

**`db` is tier 1, decided 2026-08.** It imports `core` and nothing else, so tier 1 is the lowest its real imports allow — and that is what lets `entity` (tier 2) hold its own Postgres driver (`postgresDriver()`) instead of exiling it to a tier-3 package. Two things would have been wrong: a second package owning `Driver`'s only production implementation (two places to look for "where rows live"), and `database()` callers importing the seam from one package and the driver from another. Same shape as `auth → db`.

Adding a package means picking its tier first. If it doesn't fit a tier, the design is wrong — fix the design, don't widen the table.

## The eight primitives

`entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`

Everything in the framework is one of these. **If a feature doesn't fit one of them, it doesn't ship.** Don't invent a ninth. Canonical shapes: [`docs/idea/02-primitives.md`](docs/idea/02-primitives.md). The list is executable, not prose: `PRIMITIVE_KINDS` in [`packages/core/src/registrar.ts`](packages/core/src/registrar.ts) is the single source `PrimitiveKind` derives from, and `registrar.test.ts` pins it at these eight — a ninth entry is a failing test, per axiom 3.

**`llm()` is an action factory, not a ninth primitive — decided 2026-08.** A model call is a server-authoritative operation with an input schema, an output schema and a policy, which is the definition of an `action`; so `llm()` ([`packages/ai/src/llm.ts`](packages/ai/src/llm.ts)) *returns* one. That is what gives a model call `.tool()`, `.openapi()`, `.client()`, `.job()` and `.contract()` for free, one authz object across every surface, and a place in the manifest — none of which a ninth primitive would have inherited. The rule generalises: a new capability arrives as a **factory over an existing primitive**, never as a new kind of thing.

**`backfill()` is a job factory — the rule's second instance, decided 2026-08.** A one-pass sweep over a table is durable background work with an input schema, a retry policy, an idempotency key and a queue, which is the definition of a `job`; so `backfill()` ([`packages/jobs/src/backfill.ts`](packages/jobs/src/backfill.ts)) *returns* one, and inherits `.enqueue()`, the worker's cancellation, the dead-letter path, `x jobs show` and its manifest row. The pass is `inBatches()` — one statement per page — with every page in its own `step.run`, so a killed attempt resumes on the page it stopped at. What a step persists is a cursor, never the page. **`handle` is at least once**: it runs before its checkpoint lands, so an attempt cancelled between the two replays that page — the handler must be idempotent (`upsertAll`, `updateWhere`, a statement whose second run changes nothing), never `count + 1`.

## Non-negotiables

- **Bun only.** No Node-specific APIs unless via `node:` and unavoidable, and then with a comment saying why.
- **No new dependencies** without a strong reason stated in the PR. Bun's natives replace most of them. The strong-reason bar and where a dependency may live (driver/transport seam only, never the primitive vocabulary) is [`docs/idea/18-build-vs-wrap.md`](docs/idea/18-build-vs-wrap.md)'s build-vs-wrap criterion.
- **No `any`.** Biome fails the build. Use `unknown` + a schema parse.
- **Never throw a bare `Error`.** Subclass `UltimateError` with a code, a cause, and an executable `fix:`. Codes are `X_SCREAMING_SNAKE` and stable forever once shipped.
  **In tests too, `As of 2026-08`** — `checkErrorFixes` skips test files, so the rule was prose there and 422 sites accumulated under a green gate. `scripts/test-bare-error.ts` is the mechanical half, on a per-package ratchet. It reports a `throw new Error(…)`, which is the test stating its own **verdict**, and never a `new Error` that is merely handed to the code under test — a foreign error is legitimate **input**, which `packages/realtime/CLAUDE.md` has always said.
- **SRP.** One file, one job. Target < 200 LOC, hard ceiling ~500. Split before you exceed it.
- **Named exports only.** No default exports. `src/index.ts` re-exports the public API explicitly — no blind `export *`.
- **`import type` / `export type`** for type-only imports (`verbatimModuleSyntax` is on).
- **Tests next to source** as `<file>.test.ts`. A test that can't fail isn't a test.
- **`--json` on every CLI command and every error.**
- **No hardcoded user-facing strings.** Everything through `t()`.
- **No raw colours.** Semantic tokens only, in every component and stylesheet.
- **No date formatted without an explicit IANA `timeZone`.** No ambient default, anywhere.
- **No float money.** `Money = { readonly minor: number; readonly currency: string }`, always both — one
  declaration in `@ultimat3/schema`, aliased by `money` and `entity`, never restated and never a `bigint`.

## Conventions

- File names `kebab-case.ts`. Single quotes, semicolons, 2-space indent, 100 cols, trailing commas — Biome owns this, don't argue with it.
- A 1–4 line header comment per file stating its single responsibility.
- Comments explain **why**, never what.
- Every package carries `README.md` (public API) + `CLAUDE.md` (boundary, deps, commands).
- Route files: `page.tsx` on `site/`/`app/`, `route.ts` on `api/` — the directory is the URL, never the filename. `index.tsx` is not a page and `<name>.tsx` is not a route; `registerRoute()` enforces it (`X_ROUTE_FILE_INVALID`).
- i18n catalogs: one flat file per locale, never a directory per locale or a file per feature. **Two
  paths, and they are different things** — an **app's** catalogs live at
  `packages/i18n/catalogs/<locale>.json` (`CATALOG_ROOT`, what `x g route` / `x g resource` merge
  keys into, and what both tracked apps have on disk); the **framework's own** catalog is
  `packages/i18n/src/catalogs/en.json`, imported by `framework.ts`. `x i18n check` audits the first;
  the `boundaries` step audits the second (`X_CATALOG_KEY_UNREACHABLE`), because pointing an app
  check at this repo silently answers `ok` — `CATALOG_ROOT` does not exist here, so it loads zero
  locales and passes.
- Docs style: lead with the rule, fragments over sentences, tables for any ≥3-row structure, no meta-framing, no trailing summary. Date load-bearing claims `As of 2026-07`.

## Where things live

| Need | Go to |
|---|---|
| the design rationale | [`docs/idea/`](docs/idea/README.md) |
| how a subsystem actually works | [`docs/architecture/`](docs/architecture/README.md) |
| the coding contract in full | [`docs/architecture/00-conventions.md`](docs/architecture/00-conventions.md) |
| **adding a feature, step by step** | [`docs/architecture/15-adding-a-feature.md`](docs/architecture/15-adding-a-feature.md) |
| running an app in production | [`docs/ops/`](docs/ops/README.md) |
| which rung of the scale ladder a claim belongs to | [`docs/idea/17-scale-ladder.md`](docs/idea/17-scale-ladder.md) |
| every error code | [`wiki/Error-Codes.md`](wiki/Error-Codes.md) |
| every CLI flag | [`wiki/CLI-Reference.md`](wiki/CLI-Reference.md) |
| what idiomatic usage looks like | [`examples/dummy/`](examples/dummy/README.md) |

## CI

Free GitHub Actions runners (`ubuntu-latest`) — never a paid runner. `ci.yml` runs three jobs, each answering a question no other job answers: `verify` (the gate, `x verify` verbatim — lint, typecheck, boundaries and every suite are its steps, never a second job), `reference-app-verify` (the app gate, on its ratchet) and `scaffold-smoke` (`x new` → `bun install` → `x verify` outside the checkout). Target under 5 minutes. Every job starts with `./.github/actions/setup` — bun, the install cache, a frozen install. Releases publish to npm via **OIDC trusted publishing**, with provenance — which 2.0.0 did not get, because no trusted publisher existed for the exchange to verify against. All 30 were attached on 2026-08-19, and 3.0.0, 4.0.0, 4.1.0 and 5.0.0 all went out through the workflow: `npm view @ultimat3/core@5.0.0 dist.attestations _npmUser`. A fourth workflow, `registry-audit.yml`, runs `scripts/registry-audit.ts` on a schedule and files a `registry-drift` issue when the tree's stamped version and the registry disagree — it is not a `ci.yml` job because it asks about the **registry**, which no commit changes. See [`PUBLISHING.md`](PUBLISHING.md).

## Note

Do not use git worktrees — work directly in this checkout. If a task is big enough to need subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two agents touch the same files.

**Only the top-level agent spawns subagents.** A subagent does the work it was given and reports
back — it never delegates further. Nested fan-out is why a 4-agent sweep becomes 17 running agents:
the count stops being knowable, the disjoint-files split stops holding, and two grandchildren edit
the same file. A subagent that finds its scope too large says so in its report and returns; widening
the split is the top-level agent's call.
