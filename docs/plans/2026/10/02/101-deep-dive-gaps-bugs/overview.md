# Deep dive: gaps, problems, bugs

## Goal
Fix the defects a three-sweep, read-only audit found at `2ea5eb17` (23.0.0, As of 2026-10): 3 critical,
~35 high, ~90 medium across all 30 packages, `scripts/` and CI. Each lands behind a failing-first
test and `bun run verify` green. Deletions and owner decisions are sequenced last.

## Context
- Bun only, Postgres with no ORM (PGlite in dev / tests), SolidJS 1.9.x + own router, SCSS modules +
  tokens, `@ultimat3/*` tiers 0–5. No new dependency in any slice.
- **No new primitive.** Every fix lives inside an existing one. Two findings say the tree already
  drifted from the eight: `channel()` ([`findings/sweep-2-architecture.md`](findings/sweep-2-architecture.md) M2)
  and `api/**/route.ts` (H1) — both are owner decisions in slice 15, not work here.
- **The evidence is in [`findings/`](findings/), one file per auditor per sweep.** Slices cite rows
  (`s1-t01 #4` = [`findings/sweep-1-tiers-0-1.md`](findings/sweep-1-tiers-0-1.md) row 4) and do not
  restate them. Read the cited row before touching the code.

| Key | File | Sweep |
|---|---|---|
| `s1-t01` | [`sweep-1-tiers-0-1.md`](findings/sweep-1-tiers-0-1.md) | 1 — correctness, tiers 0–1 |
| `s1-t23` | [`sweep-1-tiers-2-3.md`](findings/sweep-1-tiers-2-3.md) | 1 — correctness, tiers 2–3 |
| `s1-t4` | [`sweep-1-tier-4.md`](findings/sweep-1-tier-4.md) | 1 — correctness, tier 4 |
| `s1-t5` | [`sweep-1-tier-5-scripts.md`](findings/sweep-1-tier-5-scripts.md) | 1 — correctness, tier 5 + `scripts/` |
| `s1-con` | [`sweep-1-concurrency.md`](findings/sweep-1-concurrency.md) | 1 — interruption, double-run |
| `s1-sec` | [`sweep-1-security.md`](findings/sweep-1-security.md) | 1 — security |
| `s1-arch` | [`sweep-1-architecture.md`](findings/sweep-1-architecture.md) | 1 — design coherence |
| `s2-cds` | [`sweep-2-core-db-schema.md`](findings/sweep-2-core-db-schema.md) | 2 — files sweep 1 left unread |
| `s2-ehaqp` | [`sweep-2-entity-http-action-query-policy.md`](findings/sweep-2-entity-http-action-query-policy.md) | 2 |
| `s2-ja` | [`sweep-2-jobs-auth.md`](findings/sweep-2-jobs-auth.md) | 2 |
| `s2-rt` | [`sweep-2-realtime.md`](findings/sweep-2-realtime.md) | 2 |
| `s2-ui` | [`sweep-2-ui-tier-4.md`](findings/sweep-2-ui-tier-4.md) | 2 |
| `s2-cli` | [`sweep-2-cli.md`](findings/sweep-2-cli.md) | 2 |
| `s2-atss` | [`sweep-2-admin-testing-scraping-scripts.md`](findings/sweep-2-admin-testing-scraping-scripts.md) | 2 |
| `s2-con` | [`sweep-2-concurrency.md`](findings/sweep-2-concurrency.md) | 2 |
| `s2-sec` | [`sweep-2-security.md`](findings/sweep-2-security.md) | 2 |
| `s2-arch` | [`sweep-2-architecture.md`](findings/sweep-2-architecture.md) | 2 |
| `s3-be` | [`sweep-3-verify-backend.md`](findings/sweep-3-verify-backend.md) | 3 — falsification; **wins over sweeps 1–2** |
| `s3-t45` | [`sweep-3-verify-tier-4-5.md`](findings/sweep-3-verify-tier-4-5.md) | 3 — falsification + corrected citations; **wins** |
| `s3-prior` | [`sweep-3-prior-audit-rows.md`](findings/sweep-3-prior-audit-rows.md) | 3 — which earlier-plan rows are still open |

- **Verdict vocabulary.** CONFIRMED / REPRODUCED = a probe ran. PLAUSIBLE / STANDS = read, unrefuted.
  A PLAUSIBLE row gets its failing test written **first**; if the test cannot be made to fail, the
  row is dropped and `status.yml` `notes` says so.
- **Start here — the twelve worst, all proven by probe unless marked:**

| # | Defect | Slice | Row |
|---|---|---|---|
| 1 | every `<QrCode>` is undecodable — four placement defects | 09 | `s2-ui #1` |
| 2 | a tag-invalidated ISR page never goes stale — no boot attaches the controller | 12 | `s2-con #1` |
| 3 | a dead replication stream is terminal and unobserved; one rejected publish kills it | 08 | `s2-con #2`, `s2-rt #3` |
| 4 | a root transaction Postgres rolled back is reported committed (**owned by the 09-28 plan**) | — | `s1-con #1`, `s3-prior` 02 |
| 5 | a changed primary key emits no migration and the drift gate cannot see it | 02 | `s2-cds #1, #2` |
| 6 | a disabled user's API keys keep working | 05 | `s1-sec H1` |
| 7 | timestamps cross the replicator bus as strings — rows mis-sort in every live window | 08 | `s2-rt #1` |
| 8 | `transitionRow` with an `undefined` id moves every row in the `from` state | 04 | `s2-ehaqp #1` |
| 9 | `x build --target static --out <dir>` removes any directory inside the app root | 12 | `s2-cli #2` |
| 10 | `ULTIMATE_STATE_DIR` makes the boot ignore `app.config.ts` for realtime, jobs, cache | 12 | `s2-cli #1` |
| 11 | a job that kills its worker is re-claimed forever | 07 | `s1-con #4` |
| 12 | queued offline writes are sent under the next signed-in principal | 08 | `s2-rt #4` |

- Reference patterns the fixes copy:
  - reservation before the first await — `packages/realtime/src/live-query.ts:167` (`SubscriptionBook.reserve`).
  - one-statement take — `packages/http/src/rate-limit-postgres.ts:72` (`SQL_RATE_LIMIT_TAKE`).
  - defer to the root commit — `packages/entity/src/row-observer.ts:210-212`.
  - owner-fenced settle — `packages/jobs/src/driver-pg-settle-sql.ts` (`SQL_ACK`).
  - single-flight with a deadline — `packages/core/src/single-flight.ts`, used by `packages/auth/src/jwks.ts`.
  - finite-bound screen — `packages/core/src/backoff.ts:51-54` (`finiteCount`).
  - a value in a cause — `renderCauseValue`, as `packages/render/src/route.ts:323`.
  - attach-unless-gone — `packages/realtime/src/live-query.ts:429`.
- New error codes only through `bun run new-error-code <CODE> --package <pkg> --title '…' --cause '…' --fix '…' (--status <n> | --off-socket)`
  — registration, `wiki/Error-Codes.md` row and status decision together. Before minting one, grep
  the owning package's registry: most slices need none.

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `core`, `schema` | 0 | unscreened retry bounds, date shape, coercion, config validation, abort signal, error reporter, OTLP, one public-cause predicate, redaction |
| `db` | 1 | primary-key diff and drift, dump fidelity, funnel error wrap, nested tx options |
| `time`, `cache`, `storage`, `seo`, `i18n`, `flags`, `money` | 1 | cron fall-back hour, CDN purge symmetry, ISO-BMFF sniff, feed and robots output, interpolation |
| `entity`, `policy`, `http` | 2 | transition id, numeric invariants, decimal fit, problem `fix` leak, open redirect, rate limit before auth |
| `auth` | 2 | API keys of a disabled user, session revocation, lockout reservation, MFA leg, adapter parity |
| `action`, `query` | 3 | mutator idempotency, tx-aware bust, client encoding, seek vs limit, search refusals |
| `jobs` | 3 | poison claim, worker loop spin, event clock, cancel fence, event purge, driver parity |
| `realtime` | 3 | replicator supervision, bus revival, TOAST, ring floor, channel re-auth, outbox principal |
| `render`, `pwa`, `ui` | 4 | ISR deadline and TTL, scroll restore, CSS scoping, SW rules, QR, RTL, DataTable, theme |
| `ai`, `mcp`, `mail`, `notify`, `manifest` | 4 | budget roots and reservation, cause leak, SQL guard, recipient schema, fan-out dedupe |
| `admin`, `scraping`, `testing` | 5 | keyset ties, audit scope and atomicity, proxy flag, redaction, island DOM, temp leaks |
| `cli` | 5 | ISR attach, state-dir root, prerender out, test discovery, vacuous `ok: true` |
| `scripts/`, `.github/` | — | `flagBool`, guards that pass vacuously, pin ratchets, image contract |

Land lowest tier first. **No slice adds an import edge.** Two moves go *down* a tier and are legal:
the public-cause predicate `http → core` (slice 01), `isoInZone` `cli → time` (slice 14).

## Plan files (execute in order)
1. [`01-core-schema.md`](01-core-schema.md) — tier 0: bounds, dates, coercion, config, context, reporter, OTLP, shared predicates.
2. [`02-db.md`](02-db.md) — tier 1: primary-key generate + drift, dump fidelity, funnel, nested options.
3. [`03-tier1-services.md`](03-tier1-services.md) — tier 1: time, cache, storage, seo, i18n, flags.
4. [`04-entity-policy-http.md`](04-entity-policy-http.md) — tier 2.
5. [`05-auth.md`](05-auth.md) — tier 2: keys, sessions, lockout, MFA, OAuth.
6. [`06-action-query.md`](06-action-query.md) — tier 3.
7. [`07-jobs.md`](07-jobs.md) — tier 3.
8. [`08-realtime.md`](08-realtime.md) — tier 3.
9. [`09-render-pwa-ui.md`](09-render-pwa-ui.md) — tier 4.
10. [`10-ai-mcp-mail-notify-manifest.md`](10-ai-mcp-mail-notify-manifest.md) — tier 4.
11. [`11-admin-scraping-testing.md`](11-admin-scraping-testing.md) — tier 5.
12. [`12-cli.md`](12-cli.md) — tier 5.
13. [`13-scripts-ci.md`](13-scripts-ci.md) — guards, release tooling, workflows.
14. [`14-unify-and-delete.md`](14-unify-and-delete.md) — second paths with no owner call needed.
15. [`15-owner-decisions-docs.md`](15-owner-decisions-docs.md) — wire-or-delete calls, doc drift.

Path-disjoint, so parallel as a team in this checkout: {01}, then {02, 03}, then {04, 05}, then
{06, 07, 08}, then {09, 10}, then {11, 12, 13}. 14 after 01–13 merge (it touches files near most of
them). 15 last. Slice 12's ISR attach (#2 above) and slice 09's QR (#1) depend on nothing — pull
them forward if the plan is worked partially.

## Done when
- Every CONFIRMED / REPRODUCED row a slice lists has a test that fails at `2ea5eb17` and passes after.
- Every PLAUSIBLE / STANDS row is either fixed behind such a test or recorded as dropped in `status.yml`.
- No `expectedRed` pin added: `bun run scripts/reference-app-gate.ts` green, both tables still `{}`.
- `bun run boundaries` green with no new `SIDEWAYS_ALLOW` or `FLOOR_ABOVE` row.
- Each BREAKING change has its CHANGELOG entry and `wiki/Upgrading.md` row (`bun run changelog-check`).
- `bun run verify` green — all 20 steps.

## Risks / open questions
- **The ask's premise — "search for gaps problems bugs" — nothing falsified.** The audit also
  recorded ~150 falsified suspicions (each file's *Not a bug* / *Checked and sound* section) so the
  executor does not re-open them.
- **This plan does not own the 2026-09-28 audit's rows.** [`findings/sweep-3-prior-audit-rows.md`](findings/sweep-3-prior-audit-rows.md)
  re-read all of them: slice 04 fixed, everything else still open at 23.0.0 — including the
  transaction that commits a rollback (#4 above), the anonymous CSRF exemption and the alphabetical
  publish order. **Work that plan's slices 01, 02, 03 before or beside this plan's 01–04**: this
  plan's slice 06 (tx-aware bust) and slice 07 assume a transaction that reports an abort. Rows both
  audits hit are listed per slice under *Owned elsewhere* — fix them once, there.
- **Unverified for want of a live service.** No sweep started Postgres, Redis, NATS, S3 or a browser.
  Every "Postgres half", the boot-DDL lock stall (`s1-con #5`), the Redis fence (`s1-con #8`), NATS
  reconnect (`s2-con #6`), RTL centring (`s2-ui #3`), bfcache scroll (`s2-ui #2`) and the shipped
  Apple provider (`s2-ja #9`) rest on reading plus fakes. Their tests are `live` / `e2e` suites:
  bring up `docker/docker-compose.test.yml` and source `docker/test-services.env` before those slices.
- **Breaking changes — semver says major, or a documented behaviour fix. Owner picks per row:**

| Change | Slice | Who breaks |
|---|---|---|
| `mutator()` defaults `idempotent: true` (or refuses without it) | 06 | every mutator without a scope / store |
| seek window clamped to a declared `.limit()` | 06 | a caller paging past a "top N" |
| `auth` rate-limit bucket spent before `authenticate` | 04 | clients that retry 401s in a burst |
| WebSocket Origin compared exactly | 08 | apps served on a port other than their page's |
| `x-forwarded-client-cert` needs its own opt-in | 04 | apps relying on `trustProxy` alone |
| a password change revokes other sessions; disable revokes API keys | 05 | none legitimately |
| MCP / agent tool results hide a 5xx `cause` | 01, 10 | agents parsing the database message |
| `t.date` refuses impossible days; `t.url` refuses untrimmed input | 01 | callers storing rolled-over dates |
| CDN `cacheHeaders` emits the entity key with each row tag | 03 | header-size budgets at the edge |

- **Owner decisions block slice 15 and parts of 14** — listed in [`15-owner-decisions-docs.md`](15-owner-decisions-docs.md).
  Five were already asked on 2026-09-28 and are still unanswered (`s3-prior`, last table).
- **`release.yml`'s gate lives in the ref it publishes** (`s1-sec M10`, re-checked in `s3-be`): the
  repository has no rulesets and `npm-publish` has no reviewers. Closing it reverses the owner's
  2026-09-05 decision recorded in root `CLAUDE.md` — slice 13 only moves `version` into `env:`;
  the gate itself is a slice-15 decision.
- **This plan is committed to a public repository.** Security rows are stated at fix level with no
  reproduction strings, following the 09-28 plan's precedent and `SECURITY.md`'s public known-gaps
  list. If the owner would rather hold `s1-sec`, `s2-sec` and slice 05 back until fixed, move them
  to a private advisory and leave a pointer.
- **Line numbers drift.** Citations are exact at `2ea5eb17` (sweep 3 spot-checked ~60 and corrected
  15). After any slice lands, re-locate by symbol.
- **Still unaudited** (each findings file ends with its own list): most `cli` templates and
  `cdp-shot-*`, ~40 `scripts/` guards, `admin` form / widgets / registry, `scraping` page and target
  layer, `testing` e2e stack, provider wire parsers in `ai`, every `*.test.ts` for tests that cannot
  fail. A fourth sweep starts from those lists.
- **Process note.** Sweep agents shared one scratch directory and one wiped another's probes mid-run;
  one stray `bun test` ran at the repo root and was killed. The tree was verified clean after each
  sweep (`git status`: only this directory). A re-run should give each agent its own scratch path.
