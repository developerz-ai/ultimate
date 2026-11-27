# 12 — Acceptance and "finished"

> Part of [`overview.md`](overview.md). Depends on: 02–10 merged and released. Tier: n/a. Coordinator.

## #1374 acceptance re-run

1. `create-ultimate --shape dashboard` from the release.
2. Same prompt as the issue ("animated intro + fake `meep`/`1234` login with success animation + music-app preview playing a few tunes"), same agent setup (one coordinator, three workers).
3. Pass:
   - `bun run verify` green.
   - transcript shows the `design-research` skill / `x design research` ran before any UI file was written.
   - result uses `Presence`, a spring rung, `stagger`, `layout()`, ≥ 1 background effect, a live visualizer through `frameLoop`.
   - `x shot --matrix` and `--all-islands` cover reduced-motion and no-WebGL states.
   - side-by-side contact sheets **and short screen recordings of the same interactions** (intro, login success, music playback with the visualizer) vs the issue's Vite + React + Motion build — stills cannot show smoothness or a visualizer reacting — judged by a fresh `architecture-reviewer`-style agent given only the contact sheets, the recordings and the issue's acceptance list; its verdict and reasons go in the record.
4. Run on Windows 11 as well (the reporter's platform).
5. Record in `docs/history/motion-acceptance.md` (shots stay in `.x/`, not committed); close #1374 with each checkbox mapped: 1 → 06, 2 → `wiki/Motion.md` Solid mapping (React islands declined, `wiki/FAQ.md:60`), 3 → 08 + 09, 4 → 07 (in `@ultimat3/effects` by decision), 5 → this run.

## Finished tracker

- `bun run scripts/finished.ts --check --json` — target 10/10. Expected reds and owners:

| Row | Cleared by |
|---|---|
| no stub | 02 (`dev-db-migrate.ts:52`) |
| supported range is tested | 02 (#1239) + 01 (#1164) |
| tests are deterministic | 02 flakes, then 7 green `flake-hunt.yml` nights |
| loop is closed | maintainer app cuts a release and repairs a red main itself — platform side, out of this tree |

- Update the stale tracker `docs/plans/2026/11/14/101-finished-and-self-maintained/status.yml`: version, 6→N of 10, slices 08/09 complete or narrowed to the evidence still owed.
- When 10/10: state maintenance mode in `README.md` and `wiki/Stability.md` (that plan's slice 13).

## Open issues after this plan

| Issue | Expected state |
|---|---|
| #1162 | open by design until the 2027-02-08 major window; body regenerated |
| everything else listed in [`overview.md`](overview.md) | closed |

## Done when

- `gh issue list --state open` shows only #1162 (and anything filed after 2026-11-27).
- `finished.ts` rows green except those waiting on time (flake nights) or the platform.
- `bun run verify` green on `main`; release published with provenance (`bun run scripts/registry-audit.ts --json`).
