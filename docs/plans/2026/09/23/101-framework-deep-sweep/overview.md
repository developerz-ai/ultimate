# Framework deep sweep: bugs, gaps, refactors, speed

## Goal
Fix what a two-pass, whole-repo audit found at `5262dc32` (21.0.0). That means about 150 verified
defects, gaps and refactors across all 31 packages, the CLI, the gate, CI, deploy and docs. The
outcome is a framework whose generated code works on first run, whose two drivers agree, whose
production boot carries no dev or test code, and whose gate is faster and cannot pass on nothing.

## Context
- Tree at **21.0.0, released** (`CHANGELOG.md:13`, `npm view @ultimat3/core version` → `21.0.0`).
  `[Unreleased]` is empty (`CHANGELOG.md:9`).
- **Semver ledger.**
  - Every item carries its own semver.
  - Patch and minor items can ship as 21.x releases, slice by slice.
  - Every **major** item is collected in [`18-major-22.md`](18-major-22.md) and ships as **22.0.0**. That means one `BREAKING —` entry each under `[Unreleased]`, plus a `wiki/Upgrading.md` row in the same PR (`bun run changelog-check`).
- **Method.**
  - 13 first-pass agents: bug hunts per tier group, concurrency, security, architecture, performance, DX (scaffolded and used an app), docs, gate and CI, tracked apps and deploy.
  - Then 5 second-pass hunters over the files the first pass did not reach.
  - Every row below was either reproduced by a probe or confirmed by reading the code. Rows marked **(suspected)** were not reproduced, and their slice says to confirm them first.
  - Six top rows were re-read by hand before this plan was written: `channel-authz.ts:21`, `action-gate.ts:137`, `action/src/http.ts:106-113`, `dev-live-feed.ts:15`, `transition.ts:112`, `app-load.ts:115`.
- Bun only, Postgres with no ORM (PGlite embedded in dev), SolidJS islands, `@ultimat3/*` tiers from `scripts/lib/tiers.ts`.
- **Primitives.** No ninth primitive. Every fix lands on an existing one:

| Area | Primitive |
|---|---|
| channel policy, live windows, client store | `query` (live) |
| webhook SSRF screen, task cron, worker strand | `job` / `task` |
| generated create action, admin confirmation | `action` |
| transition key, decimal parity, migration defaults | `entity` |
| async-Page refusal, build-time `load` | `route` |
| permission grants | `policy` |

- **Reference patterns.**

| Pattern | Where |
|---|---|
| fail-closed host screen | `packages/scraping/src/hosts.ts:62` `hostDecision` |
| finite-number screen | `packages/storage/src/grant.ts:90` `finiteCount` |
| redacted provider error | `packages/auth/src/oauth-exchange.ts:208-221` |
| key by the entity's primary key | `packages/entity/src/plan.ts:196` `singleKeyOf` |
| fenced foreign text | `packages/cli/src/cmd-pr.ts:219-235` `commentBlock` |
| raise-needs-a-reason rule | `scripts/budget-raises.ts` |
| boot rollback | `packages/cli/src/serve.ts:279` `releaseBoot` |
| new error code | `bun run new-error-code <CODE> --package <pkg> …` |

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `core`, `schema` | 0 | ISO-only dates, canonical-json tags, secrets file mode, logger field order, dev-secret fallback, drain delay |
| `db`, `money`, `time`, `storage`, `cache`, `i18n`, `seo` | 1 | migration default/nullability arm, NaN screens, exact money format, attachment ownership, CDN tag headers, locale case, TZ-free feed dates |
| `entity`, `http`, `auth` | 2 | driver parity, transition key, cache privacy, XFCC parse, OAuth error leaks, CSP memo |
| `action`, `query`, `jobs`, `realtime` | 3 | error-map reach, replay shape, webhook SSRF, worker strand, channel policy, live-window first read, offline outbox, socket accounting |
| `mcp`, `ai`, `mail`, `notify`, `pwa`, `render`, `ui` | 4 | readonly-sql tag, STARTTLS, idempotency key, digest loss, redaction, budget, `ping`/`prompts/get` |
| `admin`, `testing`, `cli` | 5 | confirmation bypass, matchers under `.not`, generators, prod boot graph, gate |

Land the lowest tier first. Every new import goes down, except one: moving the live replicator from
`testing` (tier 5) into `realtime` (tier 3). That move **removes** the upward-looking dependency
`serve → testing`. Nothing is added to `SIDEWAYS_ALLOW`.

## Plan files (execute in order)
1. [`01-core-schema.md`](01-core-schema.md): tier 0. ISO dates, canonical-json, secrets mode, logger, dev-secret fallback, drain delay.
2. [`02-tier1-data-edge.md`](02-tier1-data-edge.md): tier 1. db generator arms and screens, money, time, storage, cache CDN headers, i18n, seo.
3. [`03-entity-query.md`](03-entity-query.md): tiers 2–3. Two-driver parity, transition key, seed, aggregate, cursor tiebreak.
4. [`04-http-auth.md`](04-http-auth.md): tier 2. Cache privacy, `?locale`, XFCC, error-page link, OAuth leaks, API key env, CSP memo, 4xx log level.
5. [`05-action-jobs.md`](05-action-jobs.md): tier 3. Action errors through error-map, replay shape, cron check, step parity, worker strand, webhook SSRF, `retry` guard.
6. [`06-realtime-server.md`](06-realtime-server.md): tier 3. Channel policy, patch index, first-read loss, `-1` accounting, TRUNCATE, encode-once, fan-out maps.
7. [`07-realtime-client.md`](07-realtime-client.md): tier 3. Outbox inflight and multi-tab, orphaned tab, gap repair, mutation order, IndexedDB abort.
8. [`08-tier4-services.md`](08-tier4-services.md): tier 4. mcp, ai, mail, notify, pwa, render, ui.
9. [`09-admin-testing.md`](09-admin-testing.md): tier 5. Admin confirmation and operations, test matchers, fake DOM.
10. [`10-cli-correctness.md`](10-cli-correctness.md): tier 5. Loader, `x new`, generators' fix lines, `.env` root, SSRF in `ui.*`, i18n index overwrite, CI-log fence, secrets rotate.
11. [`11-cli-generators-dx.md`](11-cli-generators-dx.md): tier 5. Generated features that work at runtime: grants, no invented tables, job registration, real create, config wiring.
12. [`12-prod-boot-perf.md`](12-prod-boot-perf.md): tiers 3–5. No test/dev code in production, `@ultimat3/cli/serve`, lazy commands, island cache.
13. [`13-deploy.md`](13-deploy.md): docker/helm/compose. Helm install hang, drain, HPA, probes, `x deploy` wait, milestone-11 proof job.
14. [`14-guards-gate.md`](14-guards-gate.md): scripts. Shared corpus and ratchet libs, `--only`, `pin-raises`, unscanned floor, lint cost.
15. [`15-ci-release.md`](15-ci-release.md): workflows and `scripts/release.ts`.
16. [`16-apps.md`](16-apps.md): both tracked apps. Pin texts, the gate builds first, the demo's workarounds.
17. [`17-docs.md`](17-docs.md): drift rows, ops runbooks, missing wiki pages, `CLAUDE.md` diet.
18. [`18-major-22.md`](18-major-22.md): every breaking item, collected for 22.0.0. API surface pruning.

**Parallel sets:**
- `{01}`, then `{02}`, then `{03, 04}`, then `{05, 06, 07}`, then `{08}`, then `{09, 10, 11}`.
- `12` needs `06`. `13` needs `01`.
- `{14, 15, 16, 17}` can start at any time, because they are path-disjoint from packages. Of these, `16` needs `11` and `12`. `17` row e (plan 102's semver note) runs **first**, before either plan starts; the rest of `17` goes last for accuracy.
- `18` is last.

**Path overlap with plan 102** (`docs/plans/2026/09/22/102-downstream-app-gaps/`, not started):
- 102 slice 12 edits `templates/scaffold-auth.ts` and `scaffold-roles.ts`, the same files as this plan's slice 11 rows c and a.
- 102 slice 13 edits the wiki.

Whichever plan runs second rebases onto the first. Never run both slices at the same time.

## Done when
- Every row in slices 01–17 has either landed with a test that failed before the fix, or been marked `wontfix` in `status.yml` `notes` with a reason.
- `bun run scripts/reference-app-gate.ts` is green, and the social clone's `boundaries` pin and both `budgets` pins are gone or rewritten with true causes (slice 16).
- A fresh `x new` plus `x g resource customer` produces a `POST /api/customers/create` that answers 2xx under `x dev` as the dev actor (slice 11).
- Importing `@ultimat3/cli/serve` pulls no module from `@ultimat3/testing` and no `templates/`, `e2e-*` or `cdp-*` module (`bun build --metafile` assertion, slice 12).
- `bun run verify` is at least 30% faster in wall time than the 3m19s measured on 2026-09-23 (12 cores), and `bun run verify --only <step>` runs one step (slice 14).
- `bun run manifest`, `bun run changelog-check`, and `bun run verify` green, all 20 steps.

## Risks / open questions
- **Plan 102 is stale on semver.** It says its breaking rows "ride the in-progress 21.0.0" (`102/overview.md:6-9`), but 21.0.0 shipped on 2026-09-23. Its majors (`ai.mcp.path`, admin tool names, `AuditRecord.action`, `locales`/`defaultLocale`) now belong to 22.0.0, next to slice 18 here. Fix 102's overview before either plan starts.
- **Human decisions** needed before code moves (slice 18 lists them):
  - Which browser driver survives: raw CDP or puppeteer.
  - Whether auth-table upgrades fold into boot.
  - When to re-stamp drift hashes.
  - How far to prune unreferenced exports.
- **One-time cache bust.** Switching `contentHash` to `Bun.hash` (slice 08, render) changes every content-addressed URL once. Ship it in a minor with a CHANGELOG note.
- **Channel policy required** (slice 06) breaks any app with a policy-less channel. Both tracked apps already set one (`examples/dummy/apps/web/app/posts/channels.ts:15`, `dummy/social-media-clone/apps/web/app/messages/topics.ts:21`).
- **Falsified during the audit, not planned:**
  - `ui` at 33k LOC: 23k of it is generated Lucide glyphs.
  - `cli` at 51k LOC: templates and commands justify it, once slices 12 and 18 move e2e out.
  - No N+1 in `entity`.
  - JWKS algorithm confusion: refused.
  - MCP multi-statement SQL: `DECLARE … CURSOR` blocks it.
  - Schema regex ReDoS: all linear.
- **Suspected rows** carry "(suspected)" and must be reproduced by a failing test before any fix. A row that cannot be reproduced is dropped with a note, never fixed on faith.
- **Unaudited after two passes**, a candidate for a third sweep:
  - `db`: `pglite*`, `pool-*`, `replica-*`
  - `realtime`: `pg-wire`/`pg-connection`
  - `cli`: `cmd-test`/`test-shards`, the island-shot family
  - `render`: registry/hydrate/css-modules
  - `seo`: `meta`/`ld`
  - `core`: `config`/`lifecycle`/otlp
