# Deep-dive sweep two — eight audits, one plan

## Goal
Second whole-repo sweep after [`2026/08/16/101`](../../16/101-deep-dive-bug-audit/overview.md) closed (PRs #101–#119, 104 commits since). Eight read-only auditors — three scoped bug hunts (tiers 0–1, 2–3, 4–5), concurrency, security, architecture, gate/CI/docs, and a scaffold DX run against the **published** 7.0.0 — wrote the findings below. Every finding carries `file:line`; those marked **proven** were reproduced by execution during the audit.

## Context
- Bun-only monorepo, 29 `@ultimat3/*` packages + `create-ultimate`, tiers 0–5, imports only go down ([`scripts/lib/tiers.ts`](../../../../../scripts/lib/tiers.ts)).
- No new primitive anywhere in this plan. New mechanisms arrive as gate checks under `scripts/` or as fixes inside existing primitives. The one new *kind* of thing — `PRIMITIVE_FACTORIES` — is a registry of existing factories, not a ninth primitive.
- Prior sweep's `deferred:` blocks re-verified: still open and carried here — `x deploy --method compose` ignoring `--image`, `IdempotencyStore.settle` without a reservation id, `coerceInput` with no caller, realtime's single barrel (C8), the `includeDeleted` resurrection (untyped, not carried), `@ultimat3/seo`'s unwired half.
- **`x deps` does not exist and never did** — #284 shipped `x affected`. The ask named it; the tree disproves it. No slice plans an `x deps`.

## Headline findings (proven by execution)

| # | Where | What | Slice |
|---|---|---|---|
| 1 | `packages/scraping/src/page-over-target.ts:104` | `ScrapePage.url()` frozen at `about:blank` → **`x shot` fails on every route of every app** | 06 |
| 2 | `packages/core/src/lifecycle.ts:337` | `drain()` memo published after the accept phase starts → an accept hook calling `drain()`/`handle.stop()` recurses (9,400+ invocations measured) | 01 |
| 3 | `packages/core/src/lifecycle.ts:148` | `registerReadinessCheck` has **zero callers** → `/readyz` = "socket bound"; the chart and compose healthchecks route on it | 01, 07 |
| 4 | `packages/realtime/src/index.ts:200-237` | one barrel ships `useLive` beside `nats`/pg-stream → `bun build --target=browser` **fails**; an island calling `useLive` cannot build | 04 |
| 5 | `packages/entity/src/pg-row.ts:109` | `arrayOf(json(…))` / `arrayOf(bytes())` written to Postgres as `{"",""}`; memory driver keeps the value | 03 |
| 6 | `packages/entity/src/memory-match.ts:55` | memory driver matches NULL rows on `gt/gte/lt/lte/like`; Postgres never does → green tests over a production miss | 03 |
| 7 | `packages/cli/src/sync-authenticator.ts:57` | grant has no `expiresAt`/`refresh` → logout/revoke/disable **never reach an open WebSocket** | 07 |
| 8 | `packages/cli/src/output.ts:165` | `x pr` renders GitHub comment bodies raw → ANSI/OSC + prompt injection into the agent reading it | 07 |
| 9 | `packages/core/src/telemetry.ts:176` | synthetic parent `traceFlags: 1` → sampler never consulted; **every HTTP root span exported** at ratio 0 | 01 |
| 10 | `scripts/lockfile-pins.ts:31` | `[a-z-]+` misses `i18n`, `packages/` anchor skips apps → **72 stale ranges in `bun.lock`** under a green check | 09 |
| 11 | `packages/cli/src/drift.ts:21` | `SCHEMA_GLOB = packages/db/src/**` — no app entity lives there → `drift` green with 3 unmigrated tables | 07 |
| 12 | `packages/cli/src/templates/scaffold-repo.ts:170` | scaffold `biome.json` lints `.x/` → the gate's own fix chain is an **infinite loop** and `--unsafe` rewrites a hashed island chunk (+51%) | 08 |
| 13 | `packages/cli/src/framework-scope.ts:34` | `x errors explain` / `x docs` in an installed app see 1 of 18 packages (isolated layout) | 07 |

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `core`, `schema` | 0 | drain memo, readiness, sampler, otlp, `CtxPatch`, `SchemaError.message`, `describeValue` code points, dead config fields, `PRIMITIVE_FACTORIES` |
| `i18n`, `money`, `cache`, `seo` | 1 | bounded caches, runnable `fix:`, frozen currency table, `renderThrowable`, sitemap x-default |
| `entity`, `policy`, `http`, `auth` | 2 | array encoding, NULL matching, composite-label fixes, shared rate-limit store |
| `action`, `query`, `jobs`, `realtime` | 3 | status narrowing, `settle` id, `SQL_STEP_LIST`, offline-queue epoch, barrel split |
| `render`, `pwa`, `mail`, `manifest`, `ai` | 4 | attribute-name guard, `escapeAttribute` dedupe, clock seam, `canonicalJson` |
| `scraping`, `testing`, `cli` | 5 | `url()`, watchdog, shot verdict, output escaping, grant expiry, dev lock, drift glob, scaffold |
| `scripts/`, `docker/`, `.github/`, apps, docs | — | gate regexes, compose parity, Bun pin, stale claims |

Land lowest tier first. Slices 01–06 are per-tier; 07–08 are `cli`; 09–11 are repo-level; 12 is decisions.

## Plan files (execute in order)
1. [`01-tier0-core-schema.md`](01-tier0-core-schema.md) — lifecycle drain/readiness, sampler, otlp, context, SchemaError, describeValue, decimal-order, factory registry.
2. [`02-tier1.md`](02-tier1.md) — i18n cache bounds, money fix lines + frozen table, cache `renderThrowable` + single-flight tags, seo x-default.
3. [`03-tier2-entity-policy-http-auth.md`](03-tier2-entity-policy-http-auth.md) — `arrayOf` encoding, NULL matching, two `fix:` lines that fail, shared rate limit.
4. [`04-tier3-action-query-jobs-realtime.md`](04-tier3-action-query-jobs-realtime.md) — idempotency status + settle id, `SQL_STEP_LIST`, offline-queue ack epoch, realtime `exports` split, root-combinator auth.
5. [`05-tier4-render-pwa-mail-manifest-ai.md`](05-tier4-render-pwa-mail-manifest-ai.md) — `html.ts` attribute guard, one `escapeAttribute`, mail clock, `canonicalJson` adoption, `formatBytes`, dead exports.
6. [`06-tier5-scraping-testing.md`](06-tier5-scraping-testing.md) — `ScrapePage.url()`, watchdog shutdown-after-fire, fixture temp dir.
7. [`07-cli.md`](07-cli.md) — shot verdict/route, output escaping, grant expiry, dev lock, readiness wiring, drift glob, framework scope, i18n sync, boundary fix names, generator nearest, `--help`, `--dry-run`, migrate JSON, deploy image, `JOB_STATES`/`TEST_TYPES`.
8. [`08-scaffold-dx.md`](08-scaffold-dx.md) — `biome.json`, shipped guards, `git init`, `schema.ts` claim, `scaffold-smoke` follows fix lines.
9. [`09-gate-scripts.md`](09-gate-scripts.md) — lockfile regex, `gate-steps` reach, vocab gate widening, Bun-pin reach, browser-barrel test, factory pin, `declaredStepIssues`, config-key citations, floor declaration.
10. [`10-docker-ci-apps.md`](10-docker-ci-apps.md) — compose parity (framework + both apps), Bun 1.3→1.4, `ci.yml` duplicate lint, dev compose `app` service.
11. [`11-docs-drift.md`](11-docs-drift.md) — CLAUDE.md counts, `jobs.driver` citations, advisory-lock wording ×10, Error-Codes count, shot `ok` rule, roadmap.
12. [`12-decisions.md`](12-decisions.md) — the human calls: seo wire-or-delete, dead config fields (major), `settle` signature (major), realtime exports (major), `x verify --only`, rate-limit store, `updateSignal`, `matchRoute`.

## Done when
- Every **proven** finding above has a failing-first test that now passes (the test named in its slice).
- `bun run verify` green at the repo root; `bun run scripts/reference-app-gate.ts` green on its ratchet.
- `x new` → `bun install` → `x verify` → follow every printed `fix:` verbatim → green, on both the default and `--no-example` scaffold (slice 08's acceptance, and the new `scaffold-smoke` assertion).
- `bun.lock` regenerated with zero stale `@ultimat3/*` ranges, and `bun run scripts/lockfile-pins.ts` would have caught them (slice 09).
- Every new `X_*` code has a row in `wiki/Error-Codes.md` and `bun run manifest` is clean.
- Items in `12-decisions.md` either landed as a major (CHANGELOG `BREAKING —` rows + `wiki/Upgrading.md` count) or are filed as issues with the decision recorded.

## Risks / open questions
- **Majors.** Four items change published API: realtime `exports` split, `IdempotencyStore.settle(key, value, id)`, deleting `PwaConfig.installPrompt`/`AuthConfig.afterSignInPath`/`AiConfig.modelEnv`, removing `manifest`'s `canonical` export. Batch them into one major or they cost four.
- **The ask said `x deps`.** It is `x affected` (`packages/cli/src/affected.ts`). `wiki/CLI-Reference.md` is mechanically complete: 39 commands, zero flags missing — nothing to plan there.
- **Root `CLAUDE.md` says `ci.yml` runs three jobs**; it runs six (`verify`, `reference-app-verify`, `scaffold-smoke`, `container`, `package-list`, `package`). Slice 11.
- **`ChannelHub` bridge wording.** Root `CLAUDE.md`'s "the bridge is the one caller that still throws the answer away" is literally true but `SocketRegistry.deliver` (`packages/realtime/src/socket.ts:369-392`) counts and logs every drop. Not a defect; a sentence to soften in slice 11.
- **Unread.** No auditor read `packages/realtime`'s pg-replication/NATS half (~30 files), `packages/jobs/src/backfill-*` internals, `packages/db`'s migrate/drift/generate, `packages/ai` beyond `budget.ts`, `packages/manifest`, `packages/admin` (30 files), `packages/ui` components, `scripts/bench/*`, or either app's `apps/**` source. A third sweep starts there.
- **Two probes left by a sibling session** were observed during the audit (`__probe1.ts`, `__probe2.ts`, `packages/core/src/zz-probe.test.ts`) and were gone by the end; `git status` is clean. If they reappear, they are not from this plan.
