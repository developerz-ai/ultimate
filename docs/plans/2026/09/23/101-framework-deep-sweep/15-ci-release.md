# 15 — CI workflows and the release path

> Part of [`overview.md`](overview.md). Depends on: none. Paths: `.github/workflows/*`, `scripts/release.ts`, `PUBLISHING.md`.

Rule: nobody approves a publish that a free check would have refused. A publish that fails halfway
can be resumed. Every printed command is the safe form.

## Files to change

| # | Defect | File:line | Change |
|---|---|---|---|
| a | the pre-publish gate has no Postgres, NATS or Redis and no `E2E_BROWSER_REQUIRED`: the 21.0.0 run ran **10 of 342** live tests, where CI ran 278 | `.github/workflows/release.yml:139` | Drop the re-run. Require `ci.yml`'s `verify` check-run to have succeeded on the tagged SHA (the polling shape of `deploy-social-demo.yml:90`) |
| b | the `npm-publish` approval is requested before `--check` runs. Runs 35827049144 and 35789073198 were approved and then failed `--check` (the bot tag-squatting in project memory) | `release.yml:54` | Split into a `check` job (no environment, runs `release.ts --check` and the ref check) and `publish` (`needs: check`, `environment: npm-publish`) |
| c | the refusal message says `git tag v1.3.0 && git push --follow-tags`, a lightweight tag that `--follow-tags` skips | `release.yml:70` | Print `git tag -a v<ver> -m v<ver> && git push origin v<ver>` |
| d | a failed publish cannot be resumed: the re-run hits E403 on the first package already published | `release.yml:175` | Skip a package where `npm view "$name@$version" version` already answers, and log it |
| e | actions in the `id-token: write` job are pinned by tag | `release.yml:75,86` | Pin `actions/checkout` and `actions/setup-node` to SHAs, as `oven-sh/setup-bun` already is |
| f | `registry-audit.yml` has no `timeout-minutes` (default 6 h), and the checkout keeps the `issues: write` token during `bun install` | `.github/workflows/registry-audit.yml:33-35` | `timeout-minutes: 10`, `persist-credentials: false` |
| g | `deploy-social-demo.yml` polls up to 10 min, which is shorter than `reference-app-verify`'s 15-min timeout | `.github/workflows/deploy-social-demo.yml:90` | Trigger on `workflow_run` of `ci.yml` (conclusion `success`, branch `main`) |
| h | `release.ts`'s "next" line prints `tag v${version}` with no `-a` | `scripts/release.ts:423` | Print the exact annotated-tag command from row c |
| i | `release.ts` rewrites 47 files without checking the tree is clean | `scripts/release.ts:64-89` | Refuse a dirty tree (`git status --porcelain`) with `X_RELEASE_TREE_DIRTY` |
| j | `--version` accepts a version at or below the current one, and `--bump` is silently ignored when both are given | `scripts/release.ts` `readReleaseVersion` | Refuse both cases with `X_RELEASE_VERSION_INVALID` |

## Steps
1. b and c first (cheap, and they prevent a wasted approval).
2. a, d, e, h, i, j.
3. f, g.

## Tests
- `bun test scripts/release*.test.ts scripts/release-workflow.test.ts`. Add cases for i and j.
- `actionlint` shape checks, if present in `scripts/`. Otherwise do a dry run on a fork tag.

## Done when
- A Release created before the bump fails in `check` with no approval requested.
- A re-run after a partial publish completes.
- Every printed tag command is annotated.
