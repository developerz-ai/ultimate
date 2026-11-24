## Symptom

Weekly release-due checkup for `developerz-ai/ultimate` at 2026-11-24T03 UTC. The question: does someone using the published packages get something real from a release now?

## Evidence

`bun run scripts/release-due.ts --json` exited 0 with `ok:true` (captured in `tmp/dz/artifacts/release-due.json`):

- `data.lastTag` = `v31.49.0`, `data.headSha` = `7307175143490ebc8c95f9664c8bc399952dccdc`, `data.due` = `true`, `data.bump` = `minor`, `data.next` = `31.50.0`. Ten shipping commits, oldest 86h old; six inert.
- Shipping commits include real user-facing work: `feat(auth)` per-grant revoke (#1313), `feat(notify)` native push sound/category/channel plus a per-send report (#1317), `feat(realtime)` socket hooks and cross-node disconnect (#1322), `feat(mcp)` tenant discover tool (#1312) and the stricter `delete_resource` door (#1323), `fix(core)` client scope id names the actor's org (#1311), and five `x upgrade` fixes (#1286). The runtime dependency group bump moves `@babel/core` in `@ultimat3/cli` and `sass` in `@ultimat3/render`; the `@biomejs/biome` bump is dev tooling only.
- `curl -fsS https://api.github.com/repos/developerz-ai/ultimate/pulls?state=open&per_page=100`: 12 open PRs, none titled `chore: release 31.50.0` or `release: 31.50.0`. No release is already in flight.
- Envelope `data.nextLane`: `propose:false`, `reason:"window_closed"`; the major window opens 2027-02-08. No major is proposed this week and the GitHub search for an open `Major release pending: 32.0.0` issue returned `total_count:0`.

I wrote `### Highlights` and a runtime-dependency entry under `## [Unreleased]` in `CHANGELOG.md` and ran `bun run scripts/release.ts --version 31.50.0 --dry-run --json` (`tmp/dz/artifacts/release-dry-run.json`). The release gate refused:

```
"code":"X_CHANGELOG_HIGHLIGHTS_MISSING"
"cause":"`## 31.50.0 - 2026-11-24` does not open with `### Highlights`, so its GitHub Release would be the raw section with no summary (wiki/Stability.md)"
"fix":"ls docs/changelog/ | sort -V | tail -5   # add ### Highlights as the first subsection of that release's file, at most 5 plain user-visible bullets, then rerun: bun run scripts/changelog-check.ts --json"
"at":"docs/changelog/31.50.0.md:1"
```

That finding is about the *promoted* release file, not the Unreleased section. `bun run scripts/changelog-check.ts --json` stayed `ok:true` throughout.

The next gate checked was the public API lock. `bun run scripts/public-api.ts --strict --json` (`tmp/dz/artifacts/public-api-strict.json`) exited 1 with five `X_PUBLIC_API_BREAK_UNDECLARED` findings against the 31.49.0 declaration:

- `@ultimat3/auth` `AuthorizationServer`: `revoke` changed its type
- `@ultimat3/notify` `Pusher.send`, `NativePusher.send`, `DataPusher.sendData`: changed types
- `@ultimat3/realtime/server` `DeviceSocket`: required member `disconnect` added

`bun run scripts/release.ts` calls the same lock at `scripts/release.ts:262` and refuses the bump outright when `pendingBreaks(api)` is non-empty (`scripts/release.ts:263`), before any stamped file is written. The fix each finding prints is "revert the change ... or declare it on next", with a `BREAKING —` line and `bun run scripts/public-api.ts --write --json`. The stability rule in `wiki/Stability.md` says breaks wait on `next` and the major window is closed until 2027-02-08; a `BREAKING —` line on `main` is refused by that same rule. I did not do either: both are maintainer decisions about merged features, outside this session's authority.

I reverted every tentative changelog edit. `git status --short` is now empty and `code_changes` shows no changed files; no PR will open from this run.

## Root cause

A release is genuinely owed: ten shipping commits with features and fixes adopters can use. The bump cannot be cut here because five changes to shipped public types are undeclared breaks against the 31.49.0 API lock. The merged work added a required `DeviceSocket.disconnect` member and changed the return types of grant revoke and push send methods; those are type-level breaks for code compiled against 31.49.0. The release gate refuses them by design, and resolving them means either reverting merged features or declaring them on `next` for the next major after 2027-02-08. Both are maintainer calls, not a weekly checkup's. The changelog highlights I added were a real prerequisite, but they do not reach the API gate: a further dry run after both edits still failed at `X_CHANGELOG_HIGHLIGHTS_MISSING` against the promoted file. I could not get past that finding to observe the API-lock refusal directly from `release.ts`; the refusal is established from `release.ts:262-267` and the strict `public-api` run.

## Fix

No release cut and no repository file changed. The five undeclared breaks are filed as raw tasks for a maintainer under `tmp/dz/devops/raw-tasks.json`; the decision is revert versus `next` declaration, and neither is safe for an unattended weekly bump. `bun run preflight` was green while the changelog edits were present; `bun run scripts/changelog-check.ts --json` was green both with and without them. No access was missing: shell reads, public GitHub API reads and the repo's own scripts sufficed.

The harness ran `bun run verify` twice after this report was first written. The first run reported `X_DOC_GATE_STEPS_STALE` at this report's old wording of the preflight count, now removed, plus `X_PUBLIC_API_BREAK_UNDECLARED` against the five shipped types above; `manifest` was red. The second run had `manifest` green, confirming the report fix, and only `unit` red: it hit its 1,501,858 ms deadline twice, naming a different file each time (`packages/http/src/error-status.test.ts` on the second run). Both named files pass in isolation: `bun test ./scripts/error-map.test.ts ./packages/http/src/error-status.test.ts` reported 24 pass, 0 fail in 5.37 s. A third harness run was identical apart from `unit`, which timed out again at 1501.8 s naming a third file (`packages/cli/src/app-manifest-jobs.test.ts`); that file also passes alone, 1 pass, 0 fail in 12.80 s. Repeated harness runs all failed `unit` at the same ~1,501.8 s deadline, each time naming a different file. Every named file passes in isolation: `scripts/error-map.test.ts` and `packages/http/src/error-status.test.ts` together (24 pass, 0 fail in 5.37 s), `packages/cli/src/app-manifest-jobs.test.ts` (1 pass), `scripts/release.test.ts` (40 pass), `packages/cli/src/workspace-dep-edit.test.ts` (4 pass), `packages/jobs/src/heartbeat-claim-window.test.ts` (4 pass), `packages/mcp/src/idempotency-arg.test.ts` (10 pass), `packages/cli/src/exercise-database.test.ts` (4 pass in 1.35 s), `packages/cli/src/fix-truth-barrel.test.ts` (1 pass in 29.87 s), and `packages/render/src/navigation-rules.test.ts` (72 pass, 0 fail in 886 ms). A rotating named file where each file is green alone is a deadline under machine load, not a failing test. Later runs also failed `live` with `X_DB_STATEMENT_TIMEOUT` (SQLSTATE 57014) in the same pgvector index test at its 10 s bound, while the other 1,561 live tests passed; `docker ps` shows many concurrent test Postgres containers on this shared box and the framework sets a statement timeout on the web role (`packages/db/src/connection-url.ts:82`), so that is the same machine-load class, not a defect in this report. The API breaks and the unit timeout are not fixable by this session without changing shipped types or unrelated tests, so no code was touched.

## Verify

```
bun run scripts/release-due.ts --json
bun run scripts/public-api.ts --strict --json
git status --short
```

The first prints `ok:true`, `data.due:true`, `data.next:"31.50.0"`. The second exits 1 with the five `X_PUBLIC_API_BREAK_UNDECLARED` findings above. `git status --short` prints nothing. A fixed system would have either reverted the merged type changes or declared them on `next`, after which a release bump could be cut with `data.command`.

no release: five undeclared public API breaks in @ultimat3/auth, @ultimat3/notify and @ultimat3/realtime/server block the 31.50.0 bump; they need a maintainer decision to revert or declare on next, and the major window stays closed until 2027-02-08
