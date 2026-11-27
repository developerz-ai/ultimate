# 01 — Maintainer actions (no code)

> Part of [`overview.md`](overview.md). Depends on: none. Tier: n/a. Coordinator only. Owner ruling (2026-11-27): the executor runs every step itself, asks nothing.

## Actions

| # | Action | Command | Closes |
|---|---|---|---|
| 1 | Fast-forward `next` to `main`. `next` is a strict ancestor (0 ahead, 139 behind as of 2026-11-27); the `protect-long-lived-lanes` ruleset only blocks deletion. The bot can't push the 9 workflow-file changes. | `git fetch origin && git push origin origin/main:next`, then `gh workflow run next-sync.yml` (a clean run closes the issue, `next-sync.yml:138`) | #1298 |
| 2 | Stop #1298 recurring: if `gh secret list` shows no `NEXT_SYNC_TOKEN`, the coordinator repeats action 1 after every sweep that touches `.github/workflows/` (a fine-grained token cannot be minted from the CLI) | `git push origin origin/main:next` | — |
| 3 | Re-run compat. bun-canary's last reds (`render/src/island-props.test.ts:97`, `testing/src/isolated-plugins.test.ts:102`) were fixed by d60c657ad (#1300) and fa0f2badf (#1292). | `gh workflow run compat.yml`; `scripts/compat-file.ts` closes on green | #1164 (bun-latest #1239 needs 02 first) |
| 4 | Refresh the parked-breaks tracker: its body lists 11 rows, `scripts/lib/next-breaks-list.ts` has 20 | `gh issue edit 1162 --body-file <(bun run scripts/next-breaks.ts)` — re-run after 03 and 04 add the #1280/#1281 rows | keeps #1162 truthful (closes only after the 2027-02-08 window, `wiki/Stability.md:5`) |
| 5 | Release the unreleased fixes a downstream app waits on: #1367 (`outbound({ refusal: { headers } })`), #1375 (split catalogs), plus sweep 1 | `bun run scripts/release.ts --check <version>`; release PR per [`PUBLISHING.md`](../../../../../../PUBLISHING.md) | unblocks 11 |
| 6 | Land or close open PRs before sweep 1: #1369 (`updateWhereReturning`), #1299 (bench figures) | review + merge | — |

## Done when

- `git log main..origin/next` and `git log origin/next..main` both empty; #1298 closed by the workflow.
- #1164 closed by `compat.yml`.
- #1162 body equals `bun run scripts/next-breaks.ts` output.
- A release containing #1367 and #1375 is on npm (`npm view @ultimat3/core version`).
