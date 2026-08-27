# Roadmap

Twelve milestones. Each one ends in a **working demo app plus green `x verify`** — never a package that only compiles.

Status markers are load-bearing, not decoration: `x verify`'s `roadmap` step (`scripts/roadmap.ts`)
reads this table and fails the build if a row loses its marker, or if a milestone marked ✅ is
missing the packages/files its own **Ships** column names. `As of 2026-08`.

| Status | Meaning |
|---|---|
| ✅ | shipped — packages exist, tests pass, enforced by `x verify`'s `roadmap` step |
| 🚧 | in progress — some artifacts exist, the milestone is not yet closed |

| # | Status | Milestone | Ships | Done when |
|---|---|---|---|---|
| 0 | ✅ | **Skeleton + error contract** | `packages/core` (`UltimateError`, ALS context, config loader), `schema` (Standard Schema over a dependency-free builtin provider, exposed as `t`), root tooling, `scripts/boundaries.ts`, `x verify` shell | `x verify` runs and passes on an empty repo; a thrown `X_*` error renders identically in terminal and `--json`; boundary violations fail the build |
| 1 | ✅ | **HTTP + entity + policy** | `http` over `Bun.serve`, `entity` over a hand-written `postgresDriver()`, `policy`, typed env validated at boot | demo: a hello app with one entity, one protected route, one denial; `X_ENV_MISSING` fires in <100ms on a missing key |
| 2 | ✅ | **`action` + `query` + typed client** | `action`, `query`, generated HTTP routes, OpenAPI, typed client, contract tests | demo: CRUD driven by the typed client, and `x verify` includes contract diff. **"No hand-written fetch" was never true in a BROWSER and this row claimed it until 2026-08-23** — `rpc()` pulled `@ultimat3/action` into the chunk, so `cli/src/templates/resource-form-island.ts` emits a plain `fetch` into every `x g resource` output and both tracked apps do the same. **The stated cost was wrong in both directions and is now measured**: 42,584 B, not 36 kB — and **65% of it was two string constants**, because `client.ts` imported `BUILD_ID_HEADER`/`IDEMPOTENCY_HEADER` from `./http`, dragging `@ultimat3/http`, `@ultimat3/cache`, `@ultimat3/policy` and the invoke runtime along for `'x-ultimate-build'`. Fixed 2026-08-23: `rpc` is **14,760 B** and `queryClient` **12,757 B**, with the flight pipeline tree-shaken out unless a caller opts in. An island still posts to the path the server minted — 14.8 kB is not free against a 20 kB budget — but the gap is now a budget decision, not a structural one (#333) |
| 3 | ✅ | **Rendering + router + `site`/`app` split** | SolidJS integration — pinned `1.9.14`, the stable line, **not Solid 2** ([`01-stack.md`](./01-stack.md)) — own router, five render modes, `stream` default, surfaces + hard `site/` → `app/` boundary | demo: landing page in `site/` at **0kb JS** and a streaming dashboard in `app/`; a deliberate cross-surface import fails the build |
| 4 | ✅ | **SEO + images + budgets** | typed `meta`, `ld.*` helpers, sitemap/robots/RSS from the route table, image pipeline, per-route budgets in `x verify` | demo landing page scores 100 SEO with **CLS 0**; deleting a description is a build error; a budget regression names the import chain |
| 5 | ✅ | **Jobs + tasks + mail + storage + scheduler** | outbox enqueue, `step.run` / `step.sleep` / `step.waitForEvent`, `pg` driver, `task` cron with leader election, mail, `Bun.s3` storage | demo: signup → onboarding job with a 3-day sleep, verified with the frozen clock; a failing step retries **only that step**; job tests in `x verify` |
| 6 | ✅ | **Realtime tier 1–2** | channels, live `query`, `replicator` role, incremental matcher, NATS fanout, `sync` role | demo: a collaborative list updating live across two clients — proven `As of 2026-08` by the **client harness**, not by two real browsers: the reference app's e2e suite is pinned red because the `page` fixture has no driver behind it (`scripts/lib/gated-apps.ts`), so no test in this repo reaches a built page. The **50k-socket forced-restart benchmark** moved out of this row — see *Open at 1.0.0* below ([`03-realtime.md`](./03-realtime.md)) |
| 7 | ✅ | **Caching, four tiers, one tag graph** | request memo, in-process LRU, Redis tier, CDN headers + purge, `invalidates` fanout, ISR regeneration | demo: publish an ISR-backed post and observe memo/LRU/Redis/page/CDN all invalidate from one `invalidates: [tag.post]`. An untagged cached query is **not** a gate failure: `X_CACHE_UNTAGGED_QUERY` is reserved `As of 2026-08` and no `.ts` file raises it, so review catches it, not `x verify` ([`05-caching.md`](./05-caching.md)) |
| 8 | 🚧 | **PWA + offline + version skew** | generated `sw.js`, precache derivation, manifest/icons/splash from one source icon, required offline fallback, immutable build ID, N-deploy retention, `AppUpdateAvailable` | **BUILT AND PROVEN IN A BROWSER, `As of 2026-08-27`; the six-deploy claim is still undemonstrated.** `x dev`, the container and the static export emit `manifest.webmanifest`, `sw.js` and `x-sw-register.js` ([#390](https://github.com/developerz-ai/ultimate/issues/390), [#362](https://github.com/developerz-ai/ultimate/issues/362) — `packages/cli/src/pwa-artifacts.ts`, `packages/cli/src/sw-artifacts.ts`). `packages/cli/e2e/service-worker.e2e.test.ts` drives a real Chrome: the worker installs, activates, takes control, serves a precached document offline and falls back to the offline document for a runtime route with nothing cached. What is NOT demonstrated is the deploy half — six deploys with a tab left open, never 404ing a chunk — which needs a second build served under a new build id and is why `E2eFixtures.update()` still refuses. This row read ✅ until 2026-08-27 on a library nothing called. Reading the client build-ID spread back is `x status`, still **planned** — it is in the registry and exits `X_NOT_IMPLEMENTED` ([`12-build-deploy.md`](./12-build-deploy.md)) |
| 9 | ✅ | **AI-first surface** | MCP dev server, `x.manifest.json`, every action as an MCP tool, `llm` gateway, versioned prompts + evals, pgvector hybrid search, branch environments | demo: an agent drives the demo app end-to-end through MCP only — migrate in a branch DB, run tests, publish a post — with **identical authz** to the UI; evals run in `x verify` |
| 10 | ✅ | **Admin + generators + `x new`** | generated admin dashboard (with its own MCP surface), all `x g` generators, `create-ultimate`, `/_x` dev dashboard complete | `bunx create-ultimate myapp && cd myapp && bin/setup && x dev` is <60s with **no Docker and no env editing** — measured `As of 2026-08-23`, 6.7s for `bin/setup` on a warm Bun cache. **Four commands, not three**: `x new` installs nothing, so `x dev` straight after `cd` stops on `X_BUILD_FAILED` naming `bun install`. `x new`'s output then clears every step of `x verify` but `budgets` — **after running the `fix:` lines the gate itself printed**, which is how CI asserts it: `scaffold-smoke` passes `--fix-follow`, bounded at three rounds ([`scripts/scaffold-fix-follow.ts`](../../scripts/scaffold-fix-follow.ts)). Straight out of `x new` the first run can be red on `lint` too, and **it depends on the app's name**: the templates emit `@<app>/…` before `@ultimat3/…`, so `x new zebra` starts with 4 `organizeImports` findings where `x new alpha` starts with 0 (measured `As of 2026-08-23`). One round of the loop clears it. **Not an unmodified green gate**, and the row says ✅ on the artifacts its Ships column names rather than on that: a scaffolded app has never run `x build`, so its declared budgets are unmeasured, and `budgets` is the one allowance left. It is a ratchet, not a waiver — `scripts/scaffold-gate.ts` fails the job the day the step starts passing and the allowance is still written. The wider claim — **every** `x g` generator's output gating the same way — is covered too `As of 2026-08-22`: the job runs `scripts/scaffold-first-run.ts`, which projects the run from the CLI's own `GENERATORS` registry rather than a sample, then the gate above over the result |
| 11 | 🚧 | **Deploy + docs + 1.0** | `x build --target docker\|binary\|static`, `packages/cli/src/serve.ts`, the scaffolded `apps/web/server.ts` + `prerender.ts` + Dockerfile + `docker-compose.prod.yml`, dev/prod compose, Helm with per-role HPAs, graceful drain everywhere | the demo app runs on Hetzner+Compose **and** a K8s cluster from one image; a rolling restart is invisible to connected clients |

Milestones 12–14 exist as a **design, not a plan in progress** — see [Designed, not started](#designed-not-started-milestones-12-to-14) below.

## Open at 1.0.0

1.0.0 shipped the 28 packages, the docs and the three build targets. What this table once claimed and cannot yet prove is named here rather than marked ✅ — a status marker nobody can check is the thing the `roadmap` step exists to prevent.

| Open | Why it is not closed |
|---|---|
| **Two-platform deploy proof** (milestone 11) | `x build --target docker\|binary\|static`, `docker/docker-compose.{dev,prod}.yml` and `docker/helm` all exist, and `As of 2026-08-20` **a scaffolded app gets its own chart** — `x new` writes `docker/helm`, 8 files — a `Deployment` for each of the four roles enabled by default (`web`, `sync`, `worker`, `scheduler`), `replicator` behind `enabled: false`, and `migrate` as a `Job`, so `x deploy --method helm` no longer exits `X_NOT_IMPLEMENTED` (4.0.0). Every artifact the milestone names now exists. What is missing is the proof itself: running the demo app on Hetzner+Compose **and** a K8s cluster from one image, with an invisible rolling restart, needs real infrastructure and has not been done |

**Closed since**: a scaffolded app now has a deployable artifact. [`packages/cli/src/serve.ts`](../../packages/cli/src/serve.ts) boots a role with no dev watcher and no `/_x`, `ROLE=migrate` applies migrations through the db ledger and exits — the release phase a PaaS asks for — and `x new` writes `apps/web/server.ts`, `apps/web/prerender.ts`, `docker/Dockerfile`, its `.dockerignore` and `docker/docker-compose.prod.yml` ([`templates/scaffold-app.ts`](../../packages/cli/src/templates/scaffold-app.ts), [`templates/scaffold-container.ts`](../../packages/cli/src/templates/scaffold-container.ts)). That was the missing half of "one command produces something you can run"; it is **not** the two-platform proof, which is a measurement on real infrastructure and remains open.

Four known gaps sat inside what did ship — the compose host port paired with `replicas` > 1, the shared cache tier's Lua `DEL` of keys it never declared in `KEYS`, `x build --target binary`, and `resolveEnvironment()` declared in two packages. **All four are closed** `As of 2026-08`. The row-by-row table, with what each fix actually proves, is in [`CLAUDE.md`](../../CLAUDE.md) and is not restated here ([`CHANGELOG.md`](../../CHANGELOG.md) carries the history).

The deploy proof is a measurement, not code. It does not block an app built on 1.0.0; it blocks the claim above being repeated as fact.

**Milestone 11 no longer names a docs site or per-code docs pages**, `As of 2026-08-23`. Both were
dropped when `wiki/` became the only public documentation surface — a decision, not a deferral
([`19-cutting-a-major.md`](../architecture/19-cutting-a-major.md)). The error-code documentation
surface is [`wiki/Error-Codes.md`](../../wiki/Error-Codes.md), which the gate's `errors` step already
requires a row in for every declared code, and `ERROR_DOCS_URL` is the one URL every framework error
points at. A per-code page would need a per-code anchor, and a table row has none. Do not add the row
back.

### Closed: the 50k-socket forced-restart benchmark

Measured `As of 2026-08` by [`scripts/bench/restart-bench.ts`](../../scripts/bench/restart-bench.ts); the run's own report and transcript are committed under [`scripts/bench/results/`](../../scripts/bench/results/), and every number below is read off [`50k-restart.json`](../../scripts/bench/results/50k-restart.json).

**What was measured: one `sync` node, over `InProcessTransport`, `SIGKILL`ed with no drain.** 50,000 real WebSocket clients, no `reconnect` frame ever sent, so recovery is each client's own `backoffDelay` alone. This is **per-node capacity**. It is not a NATS result and not a multi-node result — cross-node fanout was not in the path ([`17-scale-ladder.md`](./17-scale-ladder.md)).

| Measure | Count | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| Reconnect | 50,000 of 50,000 | 53.4s | 101.6s | 128.7s | 145.7s |
| First patch on the reconnected socket | **49,981 of 50,000** | 54.0s | 105.5s | 127.8s | 145.7s |

Every client reconnected. **19 never received a channel patch before the window closed**, so the first-patch percentiles are over 49,981 clients, not 50,000 — "all 50,000 recovered" overstates the file.

That second row was labelled "time-to-consistent" until 2026-08 and never measured consistency: the harness recorded `lastSeenSeq` and read it nowhere, so a patch the node dropped was invisible to it. It times reconnect *and* resubscribe *and* one delivery — reachability. The timings are unchanged and still stand; only the name was wrong. Delivery is measured separately, `As of 2026-08`: 10,000 clients, a probe every 200ms, **1,666,882 patches received, 0 observed sequence gaps** (a lower bound — a hole is only visible between two frames one connection received) — the only run with delivery accounting, and it is not evidence about 50,000.

**The recovery cost is admission control, not the matcher**: first delivery trails reconnect by ~0.6s at p50, and the shipped `AcceptBudget` default of 500/s bounds full recovery of 50k sockets at ~100s, which is what p90 reports. 156,851 connect attempts were shed before reaching any query or snapshot path — the DB-load half of the question, and the reason a forced restart is not a self-inflicted thundering herd.

Raising the ceiling would measure a different framework, so mitigation 6 in [`03-realtime.md`](./03-realtime.md) — adopting another protocol if our matcher were the bottleneck — is not triggered by this result.

## One demo app, twelve stages

The same application grows through every milestone. A regression in M3 surfaces while building M9, because it is the same app.

| After | The demo app is |
|---|---|
| 0–1 | one entity, one protected route, a typed error, a validated env |
| 2 | full CRUD over the typed client; OpenAPI published |
| 3–4 | a blog: 0kb-JS marketing pages + streaming authed dashboard, 100 SEO, CLS 0 |
| 5 | signup triggers a durable onboarding flow with a 3-day sleep and a nightly digest task |
| 6 | the post list updates live across two browsers; presence indicators on the editor |
| 7 | published posts invalidate memo/LRU/Redis/ISR/CDN from one declaration |
| 8 | installable (**done**); works offline (**done and browser-proven**, `As of 2026-08-27` — `packages/cli/e2e/service-worker.e2e.test.ts`); survives six deploys with a tab left open (**not demonstrated** — it needs a second build served under a new build id, which no test harness produces) |
| 9 | an agent publishes a post through MCP with the same authz as the UI |
| 10 | reproducible from `bunx create-ultimate` in under 60 seconds |
| 11 | running on Compose and on K8s from one image, rolling restarts invisible |

## Milestone anatomy

Every milestone, without exception:

| Element | Requirement |
|---|---|
| Packages | complete public types, implemented happy path, typed throws for named errors |
| Tests | >=2 regression-catching tests per package, plus the milestone's own test type |
| Demo | the shared demo app advanced visibly; a screenshot or a terminal transcript |
| `x verify` | green, with the milestone's new checks added to the gate |
| Errors | every new failure mode has an `X_*` code, a `fix:`, and a docs stub |
| Docs | the relevant `docs/idea/` doc updated where reality diverged from the plan |

A milestone is not done because the code exists. It is done when the gate covers it.

## Sequencing rule

**Ship 0–5 before touching realtime.**

A framework with excellent DX, durable jobs, and enforced SEO is already shippable and already better than the alternatives for most apps. Milestones 0–5 are a product: entities, actions, a typed client, five render modes, a 0kb static path, and a job system with durable steps. Someone can build and sell a real application on that.

A half-built sync engine is worth nothing. It cannot be shipped partially, it cannot be demoed honestly, and it consumes the attention that everything else needs — and it is ~70% of total effort ([`15-risks.md`](./15-risks.md)). Starting there is how this project would die with 40 packages and no users.

| Rule | Consequence |
|---|---|
| Milestones are strictly ordered; no parallel starts | one demo app grows through all twelve, so regressions surface immediately |
| Every milestone ends green | `x verify` never carries known failures forward |
| Realtime was gated on a measured benchmark (M6) — waived at 1.0.0, **met after** | M6 shipped on API surface and tests alone. The 50k-socket forced-restart number has since been measured and published (*Open at 1.0.0* above), so **per-node** realtime capacity is quoted as a result rather than a target. Multi-node capacity is still a target |
| Tier 3 local-first is **out of v1** | **Both halves of this row were wrong, corrected 2026-08-23.** `query()` has never accepted `persist` — `QueryDef` (`packages/query/src/query.ts:70-88`) has no such field, and a shipped `fix:` line telling a caller to write `persist: false` was itself a defect (`packages/realtime/src/local-store.ts:229-235`). Nor is it un-started: `IdentityMap`, `RowWindows`, `MemoryLocalStore`, the offline mutation queue and optimistic rebase are ~1,000 lines already on the **client** barrel (`packages/realtime/src/index.ts:109,123,139-143`). What is actually missing is the durable backing — `createOpfsLocalStore` exits `X_NOT_IMPLEMENTED` (`local-store.ts:236-241`) — and the flag that would name it |
| Scope cuts come off the back, never the middle | dropping M11's Helm chart is acceptable; dropping M4's budgets is not |
| A milestone that grows past its demo gets split | a milestone with no demo is a milestone with no definition of done |

## v1 boundary

| In v1 | Deferred |
|---|---|
| Milestones 0–11 | tier 3 local-first — the **durable** backing only; the in-memory half shipped, see the rule table above |
| Realtime tiers 1–2 | plugin API |
| `pg` job driver (redis/nats behind the interface) | multi-region replication |
| Postgres + pgvector | mobile/desktop app targets — **now designed**, see below |
| One admin dashboard | theming marketplace, template gallery |
| Docker / binary / static targets | vendor-specific deploy adapters (never, per [axiom 7](./00-thesis.md)) |

## Designed, not started: milestones 12 to 14

Mobile and desktop left the deferred column and entered the **design** column. Nothing below exists in code — no package, no `x build` target, no gate step. The full design, including what it deliberately refuses to build, is [`16-app-targets.md`](./16-app-targets.md).

These rows carry no ✅ / 🚧 marker and are not read by the `roadmap` step, because neither marker is true of them: nothing has shipped and nothing is in progress.

| # | Milestone | Design proposes | State |
|---|---|---|---|
| 12 | **Desktop** | `x build --target desktop` over Tauri: the same `app/` bundle in a window, keychain session, updater wiring | design only |
| 13 | **Shared core + mobile runtime** | `@ultimat3/tokens` at tier 1 and `@ultimat3/native` at tier 4, React Native as the second view layer, `route.targets`, `screen.tsx`, two new gate steps | design only |
| 14 | **OTA + native code** | the Expo Updates protocol served by the app's own `storage`, `x ota publish/rollback/status`, a runtime-version fingerprint that refuses a mismatched bundle | design only |

Three load-bearing decisions the design makes, so they are not re-litigated per milestone:

| Decision | Consequence |
|---|---|
| **A screen is a `route`**, not a ninth primitive | the eight-primitive rule survives a second view layer; a native capability the server must trust is an `action`, as it already was |
| **Tokens move down to tier 1**, `ui` re-exports them verbatim | a tier-4 native runtime cannot import upward into tier-5 `ui`; the move is additive, so no major |
| **No native component kit** | 52 components mirrored is 52 forever. Tokens and a runtime, not a kit — the scope cut that decides whether this ships at all |

Desktop is staged first because it is packaging rather than a second product, which is the claim the whole design rests on.
