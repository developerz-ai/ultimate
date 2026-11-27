# Finish Ultimate: close every open issue, ship what downstream apps need, motion + effects + agent kit

## Goal
Close all 13 open issues except the major-window tracker #1162, close the remaining framework gaps a
production downstream app has hit, and answer #1374 (flat, under-animated agent UIs) with first-class
motion, an effects package, a design-research command and a managed agent kit. End state:
`scripts/finished.ts` green except the rows that wait on time or the platform.

Design bar for 06–09: **cool and efficient.** At least as striking as the references (React Bits,
21st.dev, shaders.com — see [`research.md`](research.md)), at a fraction of their bytes: CSS tier at
0 kB JS on `site/`, one shared WebGL2 mount and one WAAPI adapter, every effect paused offscreen and
on hidden tabs, per-entry byte ceilings pinned in tests. Everything reimplemented here; references
give ideas and techniques only.

## Context
- Bun-only, Postgres with no ORM, SolidJS 1.9 islands with `ui`'s seven-function runtime (`packages/ui/src/theme/solid-adapter.ts:41-55`), SCSS modules + tokens, `@ultimat3/*` tiers 0–5 (`scripts/lib/tiers.ts`).
- Primitives: nothing here is a ninth primitive. Gaps extend existing ones (`action` gains `decide(rows)`, `jobs` gains a fenced status read, `realtime` cursors gain a signature). Motion, effects and research are UI library code, a component package and a CLI command projected to the dev MCP (axiom 2).
- Main takes no break before the 2027-02-08 major window (`wiki/Stability.md:5,28,114`): every stricter rule ships as a warning on `main` with its break parked on `next` ([`10-next-breaks.md`](10-next-breaks.md)).
- State as of 2026-11-27 (`main` `5a998a869`, 31.51.0): `finished.ts` 6/10; `next` 0 ahead / 139 behind; open PRs #1369, #1299.
- Reference patterns: guard template `packages/cli/src/templates/guard-raw-motion.ts`; generated doc with `--check` `scripts/guards-doc.ts`; released-form hashes `packages/cli/src/guards-vendored.ts:23-38`; boot-time configure seam `configureCursorSigning`; log-only warning code `packages/entity/src/all-truncated.ts`.
- Prior art and reference measurements: [`research.md`](research.md).

## Issue → slice

| Issue | Slice | Outcome |
|---|---|---|
| #1372, #1285 flakes | 02 | test fixes (order dependence) |
| #1239 compat bun-latest | 02 + 01 | test race fix, compat re-run |
| #1164 compat bun-canary | 01 | already fixed (#1300, #1292); re-run |
| #1287 worktree test discovery | 02 | ignore `.claude/worktrees` |
| #1361 service identity | 02 | boot configures telemetry from app config/env |
| #1289 scroll chaining | 02 | containment only on modal surfaces |
| #1221 unfloorable advisory | 02 | acknowledged-advisory ledger with expiry |
| #1298 next-sync | 01 | fast-forward push + token |
| #1280 cursor trust | 04 → 10 | signed cursor on `main`, cold start on `next` |
| #1281 unknown keys | 03, 04 → 10 | walker + warning on `main`, refusal on `next` |
| #1374 motion/design | 06, 07, 08, 09, 12 | motion, effects, research, agent kit, acceptance run |
| #1162 parked breaks | 01, 10 | body regenerated; closes at the window |

## Tiers touched

| Package | Tier | Why it must change |
|---|---|---|
| `core` | 0 | telemetry resource default (#1361); app-wide egress proxy |
| `schema` | 0 | `unknownKeys` walker (#1281) |
| `auth` | 2 | mail recipient ≠ store key |
| `policy` | 2 | `evaluateEach` |
| `action`, `query` | 3 | unknown-key warning; `decide(rows)` |
| `realtime` | 3 | signed cursor (#1280); device wire version + fixtures |
| `jobs` | 3 | tenant-fenced status/cancel |
| `ui` | 4 | `./motion`, spring tokens, `MotionToggle`, scroll containment (#1289) |
| `mcp` | 4 | verbatim text result (conditional); `ui.research` type |
| `render` | 4 | advisory ledger row (#1221) — no code |
| `effects` (new) | 5 | effects catalogue over `ui`, own WebGL2 mount, zero external deps |
| `testing` | 5 | `expectPlanWithin`, `raceActions`, `expectPartial` |
| `cli` | 5 | flakes, boot wiring, `x dev` migrate stub, guards, `x design research`, `x shot --against`, `x kit`, scaffold |

Lowest tier first. No sideways or upward import is introduced; `effects` sits at its floor.

## Sweeps (one PR each, ≤ 4 agents, ≤ 100 files, merged before the next)

Owner rulings (2026-11-27): 8 exploring/design agents for planning; execution keeps the default caps; **the executor asks nothing** — every decision below is final, and each sweep merges once `bun run verify`, CI and agent reviews are green.

| Sweep | Slices | Agents → exclusive paths | Est. files | Tier band |
|---|---|---|---|---|
| 0 | 01 | coordinator only (push, compat, release, PRs) | 0 | — |
| 1 | 02 | A cli tests (`app-load-install-fix`, `cmd-db-migrate-dev`, `heavy-ledger`, `test-ignores*`) · B telemetry (`core/src/telemetry*`, `framework-env.ts`, `cli/src/serve-boot*`) · C ui scroll (`ui/src/tokens/_mixins.scss`, component `.module.scss` listed, `cli/e2e/ui-scroll-chain*`) · D advisory + stub (`scripts/lib/advisory-*`, `scripts/advisory-floors*`, `pin-tables.ts`, `cli/src/dev-db-*`, `row-security-boot*`, `db-rollback-pass.ts`) | ~35 | 0–5 |
| — | release | coordinator: release with #1367, #1375 + sweep 1 (01 action 5) | — | — |
| 2 | 03 | A1 `core/src/outbound*`, `config*` · A2 `schema/src/unknown-keys*` · A3 `auth/src/verify*`, `member-invite*` · A4 `policy/src/evaluate*` | ~30 | 0–2 |
| 3 | 04 | B1 `action/src/**`, `query/src/**` · B2 `realtime/src/device-*`, `realtime/wire/**` · B3 `realtime/src/{cursor*,live-*,sync-protocol,subscriber-gate,client-frames,server,index}.ts` · B4 `jobs/src/**`, `examples/dummy/**` | ~40 | 3 |
| 4 | 05 | C1 `mcp/src/**` (only with the measurement) · C2 `testing/src/{plan-budget*,race-actions*,index}.ts` | ~15 | 4–5 |
| — | release | coordinator | — | — |
| 5 | 06 | A `ui/src/motion/**`, `ui/src/tokens/*`, `ui-keys.ts`, `ui/package.json` · B `cli/src/templates/guard-*motion*`, `guard-raw-frame-loop*`, `guard-animated-layout-property*`, `motion-scale.ts`, `guards-shipped-names.ts`, `scaffold-guards.ts` · C `scripts/ui-barrel-bytes.test.ts`, `dependency-allowlist-data.ts`, `i18n/src/catalogs/*`, `wiki/Motion.md`, `ui/*.md`, `docs/**` · D `examples/dummy/**` | ~70 | 4–5 |
| 6 | 07 | A `effects/` scaffold + shared + backgrounds · B `effects/src/` interaction/text · C `tiers.ts`, `effects-bytes.test.ts`, `guard-effect-without-fallback*`, `shot-gpu.ts`, wiki · D `examples/dummy/**`, `dummy/social-media-clone/**` | ~95 | 4–5 |
| 7 | 08 | A `cli/src/{cmd-design*,design-*,messages-design}.ts`, `registry.ts` · B `cli/src/{cmd-shot*,shot-diff*,mcp-ui*}.ts`, `mcp/src/dev-agent-tools.ts` · C wiki | ~30 | 4–5 |
| 8 | 09 | A `cli/src/kit/**`, `templates/scaffold-{claude*,docs,design}.ts`, `templates/index.ts`, shapes · B `cli/src/{cmd-kit*,app-kit*,doctor-kit*,verify-checks.ts,cmd-doctor.ts}` · C `cli/src/{upgrade-*,cmd-upgrade.ts,messages-upgrade.ts}`, `codemods/**`, `scripts/lib/kit-refresh-forms.ts` · D wiki, `scripts/kit-doc*`, `dummy/*/.claude/**` | ~75 | 5 |
| — | release | coordinator | — | — |
| 9 | 10 | one worker per PR, **target `next`**: 9a this plan's breaks · 9b–9e groups g1–g4 | ~10–30 each | 0–5 |
| 10 | 11 | cross-repo, downstream app's own repo (worktree) | app | — |
| 11 | 12 | coordinator: acceptance run, finished tracker, closing comments | ~5 | — |

## Plan files (execute in order)
1. [`01-maintainer-actions.md`](01-maintainer-actions.md) — push `next`, compat re-run, release, refresh #1162, land open PRs.
2. [`02-bug-closures.md`](02-bug-closures.md) — #1372, #1285, #1239, #1287, #1361, #1289, #1221, `x dev` migrate stub.
3. [`03-gaps-tiers-0-2.md`](03-gaps-tiers-0-2.md) — egress proxy default, `unknownKeys`, mail recipient, `evaluateEach`.
4. [`04-gaps-tier-3.md`](04-gaps-tier-3.md) — signed cursor, unknown-key warning, `decide(rows)`, device wire version, job status.
5. [`05-gaps-tiers-4-5.md`](05-gaps-tiers-4-5.md) — plan budget, race helpers, verbatim MCP text (conditional).
6. [`06-motion.md`](06-motion.md) — `@ultimat3/ui/motion`, spring tokens, guards over TS.
7. [`07-effects.md`](07-effects.md) — `@ultimat3/effects`, 13-entry starter catalogue.
8. [`08-design-research.md`](08-design-research.md) — `x design research`, `x shot --against`, `ui.research`.
9. [`09-agent-kit.md`](09-agent-kit.md) — managed skills/agents, `x kit`, upgrade refresh, Visual quality rules.
10. [`10-next-breaks.md`](10-next-breaks.md) — the breaks, on `next`.
11. [`11-downstream-app.md`](11-downstream-app.md) — adopt releases, delete workarounds (other repo).
12. [`12-acceptance-and-finish.md`](12-acceptance-and-finish.md) — #1374 re-run, `finished.ts`, close-out.
- [`research.md`](research.md) — prior art, licences, measurements.

## Done when
- `gh issue list --state open` shows only #1162 (plus anything filed after 2026-11-27).
- `bun run scripts/finished.ts --check --json` green except "tests are deterministic" (waiting on 7 green nights) and "loop is closed" (platform).
- A fresh `create-ultimate --shape dashboard` app scaffolds five managed skills, uses `@ultimat3/ui/motion` + `@ultimat3/effects`, and passes `x verify`; the #1374 re-run is recorded.
- The downstream app is on the latest release with no stale "waits on the framework" note.
- `bun run verify` green (all 21 steps) and `bun run scripts/reference-app-gate.ts` green after every sweep.

## Risks / open questions
- **Claim in #1374 disproved:** "the scaffold ships Playwright MCP" — `packages/cli/src/templates/scaffold-mcp-json.ts:17-31` writes only the dev MCP. Research runs on the existing CDP driver; no Playwright is added (one browser path, Bun-only).
- **Decisions recorded:** keep Solid, no React islands (#1374 option declined, `wiki/FAQ.md:60`); reimplement everything ourselves — reference libraries give ideas and techniques only, never code or a dependency; effects in an extra package (`@ultimat3/effects`), so #1374 checkbox 4 ("in `@ultimat3/ui`") is met there — say so when closing.
- **Build, not wrap** (decided after reading the sources): Motion's hybrid engine (26.95 kB gzip) exceeds the 20,480 B island default and its mini entry is plain WAAPI; Paper Shaders and shaders.com are studied for techniques only (shaders.com also posts the site hostname by default). Our own WAAPI adapter, spring → `linear()` generator and WebGL2 mount; zero new runtime dependencies.
- **React Bits is MIT + Commons Clause** (no ported redistribution): clean-room only, stated in `packages/effects/CLAUDE.md`; no reviewer may paste its source.
- **Own WebGL2 mount** must match what the references already do (offscreen/hidden pause, pixel cap, context-loss recovery) — sweep 6 proves it with one shader and measured bytes before the rest.
- **Managed kit files become non-editable** (`X_KIT_DRIFT`), reversing the scaffold README's "owned by you" — warning-only until an app opts in with `.claude/kit.json`; strict on `next`.
- **#1289's e2e** only fails on Chrome ≥ 144 — assert the CI browser version in the test.
- **Verbatim MCP text** waits on a downstream measurement (> 15% escaping overhead); without it sweep 4 ships the testing half only.
- **#1221** fix is an expiring acknowledgement, not a floor: the real exit is sass raising its own floors upstream.
- **`ui/CLAUDE.md`** is at 24,317 B against its 24 KB pin — sweep 5 moves history to `docs/history/ui.md` first.
- **"Tests are deterministic"** needs 7 consecutive green `flake-hunt.yml` nights after sweep 1 — time, not code.
