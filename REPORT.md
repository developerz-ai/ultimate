## Symptom

Scheduled security-release checkup for `developerz-ai/ultimate` at 2026-11-22T04:05Z: does a confirmed security fix merged since the last tag need an off-cycle release today?

## Evidence

`bun run scripts/release-due.ts --json` exited 0 with `ok:true` (captured in `tmp/dz/artifacts/release-due.json`):

- `data.lastTag` = `v31.49.0`, `data.headSha` = `fa0f2badf867da429bb72df0e0692a1304c74f7b`, `data.due` = `true` (2 shipping commits, oldest 37h old), `data.bump` = `patch`, `data.next` = `31.49.1`.
- `data.shipping`: `fa0f2badf` "Restore bounded isolated-run global retention (#1292)" (`@ultimat3/testing`); `01cea21a6` "fix(cli): five x upgrade defects the 31.49.0 app upgrades found (#1286)" (`@ultimat3/cli`, `@ultimat3/testing`).
- `git log v31.49.0..HEAD` (5 commits) shows three further commits, all docs about a live-check tunnel (#1291, #1290, #1288), counted as `data.inert: 3`.
- Full diff of the two shipping commits (`tmp/dz/artifacts/shipping.diff`, 1309 lines): a version-gated `Bun.plugin.clearAll()` hook in `packages/testing/src/isolated-plugins.ts`, related tests/comments, CLI codemod and upgrade fixes, and changelog/docs. A case-insensitive grep for `CVE|GHSA|advisory|vulnerab|security|exploit|CISA|NVD` over that diff returned zero hits; neither commit body names an advisory.
- GitHub Security Advisories for this repo (`/repos/developerz-ai/ultimate/security-advisories`): `[]`. GitHub Advisory queries `ecosystem=npm&affects=@ultimat3/cli` and `...&affects=@ultimat3/testing`: `0` each.
- Opened the one first-tier advisory this repo has historically acted on, GHSA-68fv-2mgg-jv7q / CVE-2026-93749 (`tmp/dz/artifacts/nvd-source-map-js.json` and NVD's `tmp/dz/artifacts/nvd-CVE-2026-93749.json`): it names `source-map-js` through 1.2.1, not any shipped `@ultimat3/*` package. It was fixed by commit `909dc65398b235c8480ea0c3c011ab5b4b08549e` and carried by release v31.13.1 (`chore: release 31.13.1 (#1100)`, commit `84fd9e2e2e729eff34077eae88dd469f28c1b51f`) on 2026-11-12, long before `v31.49.0`.
- No other advisory in the 1,200 most recently published npm advisories queried names a package in this repo's `bun.lock` (advisory package list versus the 262 lockfile package names: empty intersection), and none names the packages in `data.shipping`.
- `git status --short` is clean for tracked files; no repository file was changed. Captured evidence lives only under `tmp/dz/artifacts/`.

## Root cause

No off-cycle release is owed. `data.due:true` is only the script's 37-hour settling count for two ordinary fixes. The brief requires all three conditions: a first-tier advisory that names something these packages ship, and an unshipped commit in `data.shipping` fixing it. Neither shipping commit references an advisory, no advisory exists for `@ultimat3/cli` or `@ultimat3/testing`, and the repo's only prior relevant advisory was already fixed and released in v31.13.1. Both window commits are performance/DX fixes (test isolation on Bun 1.4.6+ and `x upgrade` codemods), not security fixes. The normal Tuesday `release-due` lane (`data.next` = 31.49.1, patch) is the correct path.

## Fix

None. Per `.dz/briefs/security-release.md`, nothing qualifies, so no file is changed, no release notes are written, and no bump is cut. No access was missing: `git` reads and unauthenticated public API reads sufficed.

## Verify

`bun run scripts/release-due.ts --json` reports `ok:true` and the two shipping commits above; the decisive check is that neither their diffs nor their bodies name an advisory, and the first-tier sources opened above either name an unrelated, already-released package or list no advisory for the shipped packages. Re-running that command plus the advisory lookups reproduces the same finding.

The repository's `bun run verify` was re-run after writing this report. It was red only at `unit`, with `X_VERIFY_STEP_TIMEOUT`: the step hit its 1,500,000 ms deadline with four unrelated files still running (`build-registry-background.test.ts`, `build-icons.test.ts`, `runtime-queue.test.ts`, `sealed-column.test.ts`, SIGKILL on their workers). Those four pass alone: 67 pass, 0 fail (`tmp/dz/artifacts/unit-timeout-files.log`) and the named `scripts/boundaries-reach.test.ts` passes both directly and via `x test unit --filter` (`tmp/dz/artifacts/boundaries-reach-test.log`, `tmp/dz/artifacts/gate-unit-repro.log`). No code changed in this run; the timeout is a machine-load limit in the shared gate, not a defect this report can fix. A later harness-run `bun run verify` was red at three steps, all timeouts under that load: `unit` at 1,501,968 ms, `live` at 1,017,235 ms (including `X_DB_STATEMENT_TIMEOUT`, `sqlState 57014`, on a pgvector test) and `e2e` at 700,391 ms. All are time-based limits on unrelated suites; none names a defect introduced by this report.

no release: no first-tier advisory names a shipped package and no commit in data.shipping fixes an advisory; the two shipping commits are ordinary fixes that roll into Tuesday's 31.49.1 patch
