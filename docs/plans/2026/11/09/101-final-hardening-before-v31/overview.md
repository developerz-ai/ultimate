# Final hardening before v31: the last big change to Ultimate

## Outcome (2026-11-10)
v31 shipped. 31.0.0 (#1046), 31.1.0 (#1047, #1048) and 31.2.0 (#1049, #1050) are all on npm, with all 31 packages attested and annotated tags ([`39`](39-v31-release.md#outcome-2026-11-10)). Adopters A–I are on 31.2.0, each upgraded from its own repository. E, G and H were rolled and verified. A, C, D, F and I don't auto-roll production, or have no live deploy. B's rollout is not recorded here. The two point releases fixed 14 field reports from those upgrades. All 40 slices are complete, and the plan is closed. [`22`](22-scale.md#outcome-2026-11-10) closed with B4 island grouping, plus a 5,124-file app booting `x dev` in 5.7 s and a `web` pod in 2.4 s. [`23`](23-feature-gaps.md#outcome-2026-11-10) closed with all 10 rows used in `examples/dummy`. [`26`](26-infra.md#outcome-2026-11-10) closed with F1–F8 done. Every owner step is done ([`90`](90-owner-steps.md#outcome-2026-11-10)). Follow-ups are in [the list below](#follow-ups-not-in-this-plan).

## Goal
**The bar: the best full-stack framework in the world — that is what the name claims.** Every slice is judged against it: would a serious team anywhere, inspecting this with or without an AI, find a reason to pick something else? If yes, the slice is not done.

**Best for AI agents building web apps, too.** An agent never reinvents a wheel the framework ships: what most web apps need is built in ([`23`](23-feature-gaps.md)), and an adopter re-implementing framework code is a framework defect (the adopter slices 40–48 delete each one). When a use case needs something different, the agent extends or modifies it without forking: swap an adapter ([`21`](21-adapter-wiring.md), proven by a conformance suite, [`19`](19-conformance-suites.md)), wrap a primitive, or subscribe to an event ([`20`](20-observability.md)). Each path is one documented page an agent can follow, and each mistake is a coded error with the exact fix. The scaffolded monorepo (`apps/<app>`, shared `packages/<name>`) is the layout for building anything web: many apps, shared domain packages, per-workspace gates ([`22`](22-scale.md) M1–M4).

Make Ultimate production-ready for big apps, big data and horizontal scale: every known bug, security hole and race fixed, every backend swappable through an adapter with a conformance suite, one instrumentation bus feeding OpenTelemetry, trust signals a human or an AI can verify — then cut **v31, the final major**, and move every adopter onto it. After v31 the 90-day major window holds and no big change is planned.

## Context
- Bun only, Postgres with no ORM (`entity` + hand-written SQL), SolidJS 1.9.x + own router, `@ultimat3/*` tiers 0–5 (`scripts/lib/tiers.ts`). As of 2026-11-09: 30.9.0, 31 packages, 10,913 tracked files.
- Sources, all 2026-11-09: 13 read-only audits across every package (bug, security ×2, concurrency, architecture, scale with a synthetic 5k-file app, big data, CI/gate, trust as a skeptical evaluator); production pod logs and `pg_stat_statements` of a deployed adopter (SELECT only); the live demo (GETs); 9 adopter repositories; open PRs and CI history. Probes were throwaway; each slice's failing-first test is the durable copy.
- No ninth primitive. New capability = a `PRIMITIVE_FACTORIES` row (factory over a primitive) or an `ADAPTER_PORTS` row (port + conformance suite). There is no plugin API (axiom 8; `docs/idea/19-mechanism-not-convention.md:75`): extension = adapters + wrapping primitives + subscribing to instrumentation events.
- Reference patterns: conformance — `packages/testing/src/job-driver-conformance.ts`; factory — `packages/ai/src/llm.ts`; port wiring — `packages/cli/src/runtime-overrides.ts:27`; spans — `packages/action/src/invoke.ts:249`.
- Adopters are named A–I in every committed file; the mapping lives off-tree with the owner. Never write an adopter's name here.

## Decisions, made (owner, 2026-11-09)
| Decision | Call |
|---|---|
| Breaking changes now, one final major | Yes. [`01`](01-release-policy.md) moves the window's start to v31; every break lands on `main` and ships as v31 |
| Extension model | Adapters (ports + conformance + `runtime.ts`), wrapping primitives, instrumentation events. No plugin API, no registry |
| Rails-style events | One `subscribe()` bus in `core` ([`20`](20-observability.md)); `publishEvent` stays the durable domain-event path |
| OpenTelemetry | Stable semconv names in v31; production DB spans; OTLP logs |
| Framework transactional mails | Delete all six ([`29`](29-v31-deletions.md) D1): unused, and two contradict auth |
| `configureAuthenticator` vs `syncAuthenticate` override | Keep the authenticator, delete the override (verify adopters first) |
| IndexedDB `QueueState` migration | Keep (deleting loses offline writes) |
| Sweep size | ≤ 4 agents, ≤ 100 files per PR (house rule). The owner may widen to ~5 builders / 100–200 files as in the previous plan's later waves; say so in the run |
| Outward steps | [`90-owner-steps.md`](90-owner-steps.md) — batch and ask once |

## Tiers touched
All. Land each sweep's lowest tier first; an import that goes up or sideways is a design error. New edges, all downward: `render → storage` (shared ISR store, [`14`](14-render.md)); `entity` gains an `./adapter` subpath; every port-owning package gains `./adapter` ([`21`](21-adapter-wiring.md)); `core` gains `./client` ([`02`](02-core-schema.md)), `instrument.ts` ([`20`](20-observability.md)), `ADAPTER_PORTS` ([`21`](21-adapter-wiring.md)); `policy` gains `guardPrimitive` ([`10`](10-policy-guard.md)).

## Sweeps (one PR each, ≤ 4 agents, ≤ 100 files, merged before the next)
Lock rule: a slice's *Files to change* is its agent's exclusive set. Intersect the sets before dispatch; two slices sharing a file go to one agent. Workers never git; the coordinator runs `bun run verify` once per sweep.

| Sweep | Slices | Agents → exclusive paths | Est. files | Tier band |
|---|---|---|---|---|
| 0 | [`28`](28-open-prs.md), [`01`](01-release-policy.md), [`24`](24-ci-gate.md) | W1 #1033 code (`testing/src/cdp-*`, `scraping` e2e test, `mcp/src/tenant*`); W2 `scripts/lib/major-window*`, Stability docs; W3 `ci.yml`, `biome.json`, flaky tests | 25 | scripts, CI |
| 1 | [`02`](02-core-schema.md), [`03`](03-db.md), [`04`](04-storage.md), [`05`](05-cache.md) | W1 `core/` (not telemetry, not aws-sigv4), `schema/`; W2 `db/`; W3 `storage/`, `core/src/aws-sigv4.ts`, `cli/src/runtime-storage*`; W4 `cache/` | 57 | 0–1 |
| 2 | [`06`](06-money-time-seo.md), [`08`](08-http.md), [`09`](09-auth.md), [`10`](10-policy-guard.md) | W1 `money/`, `time/`, `seo/`; W2 `http/`; W3 `auth/`; W4 `policy/`, `core/src/gate-shapes.ts`, `mcp/src/projectable.ts` | 48 | 1–2 |
| 3 | [`07`](07-entity.md), [`11`](11-action-query.md) | W1 entity correctness (E1–E9); W2 entity driver kit (E10–E14, `cli` drift step); W3 `action/`; W4 `query/` | 60 | 2–3 |
| 4 | [`12`](12-jobs.md), [`13`](13-realtime.md) | W1 `jobs/`; W2 realtime fan-out (R1, R5–R7); W3 realtime replication + IDB (R2–R4, R8); W4 R9 (`channel-decl.ts`, demo notifications) | 48 | 3 |
| 5 | [`14`](14-render.md), [`15`](15-ai-mcp.md), [`16`](16-notify-pwa-scraping.md), [`25`](25-helm-docker.md) | W1 `render/`, `scripts/bench/render*`; W2 `ai/`, `mcp/`, demo MCP config; W3 `notify/`, `pwa/`, `scraping/`; W4 `docker/` | 51 | 4 |
| 6 | [`17`](17-cli-runtime.md), [`18`](18-admin-testing.md) | W1 `cli/` (C1–C4, C6–C8); W2 `cli/` admin mount + exercise/upgrade (C5, C9), `jobs/src/worker-registry.ts`; W3 `admin/`, `testing/` | 35 | 5 |
| 7 | [`20`](20-observability.md) | W1 `core/` bus, telemetry, logger, OTLP, metrics, guard; W2 `db`, `entity`, `policy`, `cache` emitters; W3 `http`, `jobs`, `ai`, `realtime` emitters; W4 `render`, `mail`, `storage`, outbound, `cli` subscribers, wiki | 45 | 0 → 5 |
| 8 | [`21`](21-adapter-wiring.md) part A | W1 `core/src/registrar.ts`, clocks, secrets, config, audit; W2 `cli` runtime wiring + scaffold; W3 setter deletions in `jobs`, `mail`, `action`, `notify`; W4 setter deletions in `http`, `auth`, `realtime`, `scraping`, `flags`, `admin` + `config-removed.ts` + error fixes | 70 | 0 → 5 |
| 9 | [`19`](19-conformance-suites.md) 9a | 4 agents by suite group (entity; storage + cache; rate-limit + auth; mail) | 35 | 5 |
| 10 | [`19`](19-conformance-suites.md) 9b, [`21`](21-adapter-wiring.md) part B | W1–W3 remaining suites by group; W4 `scripts/adapter-ports.ts`, `./adapter` subpaths, `wiki/Adapters.md` | 65 | 5 |
| 11 | [`22`](22-scale.md) | W1 `cli` boot/prebuilt registry; W2 verify `--changed`, islands shared chunk, `x g`; W3 invalidation over Redis + partitioned entities; W4 benches + scale-ladder doc | 35 | 2 → 5 |
| 12 | [`23`](23-feature-gaps.md) 12a | W1 GDPR; W2 lock + upload scanner; W3 search port; W4 `versioned()` | 40 | 1 → 3 |
| 13 | [`23`](23-feature-gaps.md) 12b | W1 SMS; W2 PDF; W3 image variants + payments; W4 SAML | 35 | 1 → 4 |
| 14 | [`29`](29-v31-deletions.md) D1, D5–D9, D11, N1 | 4 agents by package band | 55 | all |
| 15 | [`29`](29-v31-deletions.md) D10 | 4 agents by package band; coordinator regenerates the manifest | 80 | all |
| 16 | [`27`](27-trust-docs.md) | W1 README + screenshot + production-apps; W2 readme-facts + Scorecard; W3 stale claims + llms.txt + bench results | 25 | docs |
| 17 | [`39`](39-v31-release.md) | coordinator | 10 | release |
| 18 | [`40`](40-adopter-a.md)–[`48`](48-adopter-i.md), [`26`](26-infra.md) | one agent per repository, ≤ 4 at a time; each its own PR in its own repo | n/a | other repos |

About 820 files in this repo, 16 PRs, plus 10 PRs in other repositories.

## Plan files (execute in sweep order)
1. [`28-open-prs.md`](28-open-prs.md) — land #1028, #1029; fix and land #1033.
2. [`01-release-policy.md`](01-release-policy.md) — window starts at v31.
3. [`24-ci-gate.md`](24-ci-gate.md) — flakes, skip reasons, CI under 5 min.
4. [`02-core-schema.md`](02-core-schema.md) — bounded validation, exit codes, Sentry hooks, `core/client`.
5. [`03-db.md`](03-db.md) — keyset SQL splice, cancel on abort.
6. [`04-storage.md`](04-storage.md) — S3 signing, copy parity, streamed uploads.
7. [`05-cache.md`](05-cache.md) — bounded Redis tag sets.
8. [`06-money-time-seo.md`](06-money-time-seo.md) — coded refusals, linear calendars.
9. [`08-http.md`](08-http.md) — CORS, body ceiling, Redis rate limits, IPv6 /64.
10. [`09-auth.md`](09-auth.md) — API-key writes, code burning.
11. [`10-policy-guard.md`](10-policy-guard.md) — one guard for action and query.
12. [`07-entity.md`](07-entity.md) — tenant indexes, memory parity, driver kit.
13. [`11-action-query.md`](11-action-query.md) — bounded errors and pages, lean client.
14. [`12-jobs.md`](12-jobs.md) — events never missed, relay and limits.
15. [`13-realtime.md`](13-realtime.md) — fan-out index, replication liveness, inbox IDOR.
16. [`14-render.md`](14-render.md) — sync SSR, bounded shared ISR.
17. [`15-ai-mcp.md`](15-ai-mcp.md) — bounded tool fan-out, MCP fence, splits.
18. [`16-notify-pwa-scraping.md`](16-notify-pwa-scraping.md) — big audiences, browser SSRF.
19. [`25-helm-docker.md`](25-helm-docker.md) — default egress policy.
20. [`17-cli-runtime.md`](17-cli-runtime.md) — what prod logs and adopters exposed.
21. [`18-admin-testing.md`](18-admin-testing.md) — SQL role, stores, test tools.
22. [`20-observability.md`](20-observability.md) — the instrumentation bus, semconv.
23. [`21-adapter-wiring.md`](21-adapter-wiring.md) — ports, `runtime.ts`, the guard.
24. [`19-conformance-suites.md`](19-conformance-suites.md) — a suite per port.
25. [`22-scale.md`](22-scale.md) — boot, replicas, partitions, benches.
26. [`23-feature-gaps.md`](23-feature-gaps.md) — GDPR, lock, scan, search, history, SMS, PDF, variants, SAML, payments.
27. [`29-v31-deletions.md`](29-v31-deletions.md) — second paths and the barrel split.
28. [`27-trust-docs.md`](27-trust-docs.md) — README, facts as commands, Scorecard.
29. [`39-v31-release.md`](39-v31-release.md) — cut v31.
30. [`40-adopter-a.md`](40-adopter-a.md) … [`48-adopter-i.md`](48-adopter-i.md) — every adopter on v31.
31. [`26-infra.md`](26-infra.md) — drills, read paths, telemetry (from the infrastructure repo).
32. [`90-owner-steps.md`](90-owner-steps.md) — settings and facts only the owner holds.

## Done when
- Every finding in slices 02–29 has its failing-first test, now green.
- `bun run verify` green (all 21 steps); `bun run scripts/reference-app-gate.ts` green on the three tracked apps; scaffold-smoke green on every shape; CI < 5 min.
- `bun run scripts/adapter-ports.ts --json`: every port complete; a toy custom entity driver passes `repoConformance` in a test.
- A production-mode request yields an HTTP server span with a child DB span, stable semconv names, exported over OTLP.
- Large synthetic app (5k files): dev boot < 10 s; 10k live windows sustain ≥ 2,000 unrelated changes/s.
- v31.0.0 on npm, attested, annotated tag, GitHub Release; `wiki/Upgrading.md` 30 → 31 complete.
- Adopters A–I on 31.0.0 with green gates; no patch or obsolete workaround left.
- Infra: both backup drills green; agents can read DB stats and GlitchTip issues read-only.

## Risks / open questions
- **Ask vs tree.** "We don't need more features" is false today: [`23`](23-feature-gaps.md) lists ten mechanisms most apps need that do not exist (GDPR erase, SAML, SMS, PDF, history, …). They are in scope because v31 is the last major; a gap found after it waits for the next window.
- **Ask vs tree.** README claims no production use (`README.md:96`); the owner reports production apps. N must come from the owner ([`90`](90-owner-steps.md) O1); the plan never guesses it.
- **Not audited** (left for the executor's own bug-hunt pass inside each sweep): `ui` internals, `admin` dev panels, `http` `stages.ts`/`server.ts`/`finalize`, `auth` `oauth-route`/`workload`, storage `driver-s3-lock`/`settle`/`image-warm`, `driver-local-*` symlink escape, realtime `channel*`/`use-*`, `create-ultimate` templates, `tutorial-run`/`registry-audit` workflows. Each sweep starts with a `bug-hunter` over its own file set.
- **Unmeasured on real infrastructure:** large-data figures came from PGlite; multi-node claims have no benchmark yet ([`22`](22-scale.md) adds them). GlitchTip issues were unreadable (no token) — rerun the error triage after [`90`](90-owner-steps.md) O8. O8 was done on 2026-11-10 (`GLITCHTIP_READ_TOKEN`). The rerun is not recorded yet.
- **COPY:** `copyAll` depends on Bun's SQL client exposing `COPY FROM STDIN`; if not, ship `returning: false` only and record the upstream ask.
- **SAML** likely needs XML-DSig: a build-vs-wrap decision ([`docs/idea/18-build-vs-wrap.md`](../../../../../idea/18-build-vs-wrap.md)) before code.
- **D10 barrel split** is the widest change: run it last among code sweeps; adopters feel it through `wiki/Upgrading.md`.
- **v31-break list** (each needs an `Upgrading.md` row): tenant index (07 E1), IPv6 rate-limit keys (08 H5), remote MCP tools opt-in (15 I3), Sentry boot reporter (17 C4), semconv renames + removed observer slots (20), removed setters + transport config + `SecretSource` (21), partitioned entities (22, additive but schema-visible), deletions (29), `allowsMany` required (16 N1).

## Follow-ups (not in this plan)
| Issue | Follow-up |
|---|---|
| [#1051](https://github.com/developerz-ai/ultimate/issues/1051) | an `@ultimat3/auth/schema` subpath, so `packages/cli/src/framework-schema.ts` stops pulling the auth barrel into `ROLE=migrate`; 31.2.0 raised the serve-graph pins by 2 for it |
| [#1052](https://github.com/developerz-ai/ultimate/issues/1052) | e2e outside UTC: the time-zone island reloads on the first visit, so `goto()` returns on the pre-reload load |
| [#1053](https://github.com/developerz-ai/ultimate/issues/1053) | split `packages/cli/src/cmd-doctor.ts` (482 lines) before the next doctor check |
| [#1054](https://github.com/developerz-ai/ultimate/issues/1054) | a bump branch must not be named `release/*`: name it `chore/release-X.Y.Z`, or narrow `release-tag.yml:36` to `release/*.x` |
