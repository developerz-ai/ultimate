# 17 — docs: drift, runbooks, missing pages, and an agent-sized CLAUDE.md

> Part of [`overview.md`](overview.md). Depends on: every code slice it describes (land it last), plus 14 n/o/p for the rules that keep it true. Excludes plan 102 slice 13 and issues #441–#443.

Rule: a doc names what the tree does today. History lives in git and `docs/history/`, not in the
file an agent loads on every session.

## a. Drift, verified 2026-09-23

| # | Doc | Claim | Truth | Fix |
|---|---|---|---|---|
| 1 | `docs/architecture/21-client-data-layer.md:8` (33 hits), `wiki/Client-Data.md` (10), `wiki/Realtime.md:44,100,128,235,264,361,446,482`, `wiki/PWA-And-Offline.md:93,107`, `wiki/Queries-And-Live-Queries.md:64`, `wiki/Configuration.md:272`, `docs/idea/03-realtime.md:5,15,63,133`, `llms.txt:98`, `CLAUDE.md:130` | 21.0.0 is "unreleased" | released (`CHANGELOG.md:13`) | Sweep; 14 n keeps it true |
| 2 | `wiki/Getting-Started.md:212`, `wiki/FAQ.md:38,124`, `wiki/Queries-And-Live-Queries.md:5` | tier 3 (local-first) has not shipped | `entity({ persist })` (`entity.ts:93,404`), IDB store and outbox (`realtime/src/index.ts:99-127`) | Say it shipped in 21.0.0, opt-in |
| 3 | `docs/idea/14-roadmap.md:117` | OPFS store is `X_NOT_IMPLEMENTED`; cites `local-store.ts` | deleted; `local-store-idb.ts`, `record-persister.ts` | Rewrite the row |
| 4 | `docs/architecture/21-client-data-layer.md:26-30` | cites `identity-map.ts`, `hooks.ts`, `local-store.ts` | none of them exist | Mark the table "20.x, historical" |
| 5 | `docs/architecture/15-adding-a-feature.md:193` | tier 3 = pass a `LocalStore`; cites `client-mutations.ts:58` | the file is gone; it is `persist: true` | Rewrite |
| 6 | `wiki/Upgrading.md:98` | `MemoryLocalStore`/`LocalStore` deleted; offline "pending" | still exported (`realtime/src/index.ts:99-103`), `pageOutbox` ships | Correct row 14 |
| 7 | `README.md:100` | HTTP `ctx` lacks logger/now/signal/services | fixed in #348 (`http/src/context.ts:40-97`) | Delete the callout |
| 8 | `README.md:352` | `installRealtimeTopics`, `api/realtime.ts` | neither exists | Re-measure the demo's wiring |
| 9 | `README.md:22`, `llms.txt:55` | llms.txt is generated | hand-kept, missing `notify` | 14 o |
| 10 | `wiki/CLI-Reference.md:769`, `wiki/Getting-Started.md:58`, `wiki/Tutorial-02-First-Feature.md:308`, `packages/cli/README.md:17`, `packages/cli/CLAUDE.md:9` | `x mcp serve` has 13 tools | 18 (plus `ui.shot/island/inspect/interact/diff`) | Say 18 and add the rows |
| 11 | `wiki/Getting-Started.md` (~l.160-166) | `actions.list`, `manifest.get` | `actions.describe`, `manifest.read` | Rename |
| 12 | `wiki/CLI-Reference.md:19` | `x db --help` fails | prints help | Delete |
| 13 | `wiki/CLI-Reference.md:17` | no-app commands list | also `docs`, `affected`, `ci`, `pr` | Add |
| 14 | `packages/action/README.md:626` | `x verify --contract` | `x verify --only contract` | Fix |
| 15 | `wiki/Jobs-And-Workflows.md:240` | `X_JOB_STEP_FAILED` | reserved; real code `X_JOB_MAX_ATTEMPTS` | Fix |
| 16 | `docs/idea/12-build-deploy.md:53` | `ROLE=all` | no such role (`core/src/roles.ts:6`) | Use the `x dev` wording |
| 17 | `wiki/Migrations-And-Backfills.md:277` | `ROLE=backfill` | a deploy step (`cmd-deploy.ts:24-44`) | Retitle |
| 18 | `docs/architecture/05-type-chain.md:30,92`, `15-adding-a-feature.md:11,49`, `docs/idea/13-dx.md:149` | `packages/db/src/schema/posts.ts` | `apps/web/app/<feature>/entity.ts` | Real paths |
| 19 | `wiki/Tutorial-02…05`, `wiki/Home.md:55` | executed against 1.1.0, with a `scripts/db-gen.ts` workaround | 20 majors old | Delete the workaround; re-run tutorials 2–5 on `main` as Tutorial 1 was |
| 20 | `wiki/Caching-And-Invalidation.md:167` | `[ISR](Rendering)` | no such page | Link `Routes-And-Render-Modes` |
| 21 | `wiki/Configuration.md:227` | surrogate keys are the tags | nothing emitted them before 02 k | Update after 02 k |
| 22 | `CLAUDE.md` | catch-render is on the `unit` step; `cmd-i18n.ts:289`; secret-compare "53 on day one" | `errors` step (`scripts/error-render.ts:444`); `:311`; 63 now | Fix, or delete in f |
| 23 | Tutorial-01 | `live`, `job`, `e2e` shown skipped | they run on a fresh scaffold | Update |

## b. docs/ops
| Doc | Claim | Truth |
|---|---|---|
| `docs/ops/README.md:87` | `distroless/cc-debian12`, ~80 MB | `docker/Dockerfile:127` uses `cc-debian13`; image is 184 MB |
| `README.md:91` | `/healthz`, `/readyz` on every role | only web and sync (`01-kubernetes.md:52-58` says so) |
| `01-kubernetes.md:70-75,175` | entrypoint `/app/x`, CMD picks the role; "the binary writes nothing else" | an app image runs `bun apps/web/server.ts` |
| `01-kubernetes.md:47` | worker has no Service | headless Service (`service.yaml:1-9`) |
| `06-runbooks.md:131` | migrate waits forever on a lock | `lock_timeout` 3 s (`pool-profile.ts:85-91`), bounded advisory wait, `X_MIGRATE_CONCURRENT` |
| `03-observability.md:26-33` | six series | also `queue_oldest_ready_seconds`, `queue_dead_jobs`, `channel_frames_dropped_total`, `channel_replay_gaps_total`, `deprecated_calls_total` |
| `03-observability.md:256-263` | alerts on scheduler leadership, slot lag, build skew | no such series. Delete the alerts, or add the series (a separate issue) |

New runbook entries in `docs/ops/06-runbooks.md`: `X_MIGRATE_CONCURRENT` / 55P03 on deploy;
migrate refusing on drift (`assertNoDrift`); dead-lettered jobs (`x jobs show`, requeue);
replicator slot accumulating WAL; `X_SHUTDOWN_TIMEOUT`.

## c. Missing wiki pages
`Notify`, `Feature-Flags`, `Mail`, `Storage-And-Uploads`, `SEO`, `Auth` (sessions, OAuth, MFA, API
keys). Each page is built from the package README, and `_Sidebar.md` gets a "Capabilities" section.
Add `channelRef` to `packages/realtime/README.md`, and `signOutHeaders`/`SIGN_OUT_CLEAR_SITE_DATA`
to `packages/auth/README.md`.

## d. Error-class docs
One table per package README listing its exported error classes and codes. This is what makes the
wide barrels honest until slice 18 prunes them.

## e. Plan 102 correction
`docs/plans/2026/09/22/102-downstream-app-gaps/overview.md:6-9` says its breaking rows ride 21.0.0.
Change that to 22.0.0 and cross-link this plan's slice 18.

## f. CLAUDE.md diet
- Root `CLAUDE.md` is 64 KB (~16k tokens loaded every session), and ~70% of it is history. Target ≤ 16 KB, enforced by 14 p.
- **Keep:**
  - axioms, non-negotiables, conventions, the tier table, the eight primitives
  - the "run the right-hand column" fact table
  - ~15 command rows: install, setup, verify, typecheck, lint, test (with the `-t` path warning), coverage, app gate, unpin, new-error-code, new-package, manifest, lockfile, x in-repo
  - the subagent note
- **Move** to `docs/history/`:
  - the publishing and provenance narrative (PUBLISHING.md already owns the procedure)
  - the realtime bench block → `scripts/bench/results/README.md`
  - the milestone-11 gap table
  - the per-edge tier decision records (keep one line per edge plus a link)
  - the `llm()`/`backfill()` rationale
- **Generate** `docs/architecture/guards.md` from guard headers (command → refuses → code), and link it from `CLAUDE.md` instead of ~30 guard rows.
- **Cut** "this file said X until …" correction narratives. Git holds them.
- Apply the same treatment to the package `CLAUDE.md` files over 24 KB (`cli` 1,677 lines, `db` 1,494, `entity` 1,213, `realtime` 1,043, `jobs` 1,000), ratcheted by 14 p.

## Steps
1. e first (one line, and it unblocks plan 102).
2. a and b, as each code slice they describe lands.
3. c and d.
4. f last, in its own PR. The docs-author agent is the right executor.

## Tests
- `bun run changelog-check`, `bun run scripts/gate-steps.ts`, `bun run scripts/doc-config-keys.ts`, 14 n/o/p.

## Done when
- `grep -rn 'unreleased' wiki docs llms.txt CLAUDE.md` returns nothing next to 21.0.0.
- Root `CLAUDE.md` is ≤ 16 KB.
- Every publishable package has a wiki page or a sidebar link.
