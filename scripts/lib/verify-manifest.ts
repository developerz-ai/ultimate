// The committed files of this repo, checked: does each one still describe this tree?
//
// It is the `manifest` step's host half, minus the generated manifest itself — that check stays
// beside the gate, in `scripts/verify.ts`, because it is the step's own question and it raises
// the step's own codes.
//
// It lives under `scripts/lib/` for the reason `scripts/lib/config-import.ts` and
// `scripts/lib/stability-findings.ts` are: `scripts/guards-doc.ts` reads a guard's row from its
// own text plus the `scripts/lib/*` modules it imports, one level down. A rule that moved to a
// `scripts/*.ts` sibling would silently drop out of the `bun run verify` row, and the page
// would under-report the guard.

import type { HostCheck } from '@ultimat3/cli';
import { benchClaimFindings } from '../bench-claims';
import { boundaryRuleDocFindings } from '../boundary-rule-docs';
import { chartVersionFindings } from '../chart-version';
import { docCommandFindings } from '../doc-commands';
import { docPathFindings } from '../doc-paths';
import { gateStepFindings } from '../gate-steps';
import { generatorCountFindings } from '../generator-counts';
import { knownGapLinkFindings } from '../known-gaps-links';
import { llmsTxtFindings } from '../llms-txt';
import { opsUidFindings } from '../ops-uid-docs';
import { packageFrontFindings } from '../package-front';
import { readmeFenceFindings } from '../readme-fences';
import { readmeSampleFindings } from '../readme-sample';
import { releaseFactFindings } from '../release-facts';
import { publishListFindings } from '../release-workflow';
import { setupCommandFindings } from '../setup-commands';
import { testDiscoveryFindings } from '../test-discovery';
import { testTypecheckFindings } from '../test-typecheck-gate';
import { versionStampFindings } from '../version-stamps';
import { wikiAnchorFindings } from '../wiki-anchors';
import { wikiFenceFindings } from '../wiki-fences';
import { frameDocFindings } from '../wiki-frames';
import { wikiTableFindings } from '../wiki-tables';

/**
 * The `manifest` step's host half: the rules that ask that step's own question — does a
 * committed file still describe this tree? The generated manifest is the original and stays in
 * `scripts/verify.ts`; these are the hand-maintained files that claim something about the repo
 * and were checked by nothing:
 *
 * | Rule | The claim, and what it cost | Source of truth |
 * |---|---|---|
 * | `publishListFindings` | `.github/workflows/release.yml` publishes every package — it does not, and `@ultimat3/flags` has never been on npm | `publishOrder(listWorkspaces())` |
 * | `benchClaimFindings` | `CLAUDE.md`'s realtime figures are what was measured | `scripts/bench/results/*.json` |
 * | `wikiTableFindings` | every `wiki/` table renders as a table | the GFM row rule |
 * | `frameDocFindings` | `wiki/Realtime.md` names the frames the wire actually sends | `FRAME_KINDS` |
 * | `chartVersionFindings` | `docker/helm/Chart.yaml` is on the lockstep version — it sat at 0.0.1, and `appVersion` IS the default image tag | the publishable workspaces' version |
 * | `docCommandFindings` | every `` `x …` `` on a page an agent reads is an invocation this build can run | `loadCommandCatalog()` |
 * | `docPathFindings` | every backticked `packages/…`, `scripts/…` or `docs/…` path on a published page exists — eight package CLAUDE.md files named `dev-*` modules 22.0.0 had renamed | the tree, and the two tracked apps |
 * | `gateStepFindings` | a page stating how many steps `x verify` runs, or enumerating them, describes this build's gate — 17 documented against 18 shipped, in 20 files, through a whole major | `VERIFY_STEP_NAMES` |
 * | `versionStampFindings` | one page stamps a version, it is the shipped one, and the workspaces agree | every workspace manifest |
 * | `readmeFenceFindings` | a fenced `ts`/`tsx` example in a package README typechecks | `tsc`, on a ratchet |
 * | `testTypecheckFindings` | this repo's TEST sources typecheck — every package config excludes them, so `tsc -b` reads none of the 966 | `tsc -p tsconfig.tests.json`, on a ratchet |
 * | `testDiscoveryFindings` | a test file the gate's discovery never yields, or one outside the one convention — *.spec.*, *_spec.*, *_test.* and *.test.{js,jsx} are invisible to the glob, while a __tests__/ path whose basename the glob matches IS yielded by it and run by the gate, so it is refused for the convention it breaks; a colliding basename names no test file at all | `TEST_GLOB` in packages/cli/src/test-select.ts, and the ignore policy in packages/cli/src/test-ignores.ts |
 * | `generatorCountFindings` | a documented `N files` for `x new` / `x g resource` is what the generator still emits — five had gone stale and were corrected by hand | `planNewApp()` / `generate()`, the planners `--dry-run` calls |
 * | `releaseFactFindings` | the package COUNT ten pages restate is the count on disk; `SECURITY.md` claimed 28 two majors late | `listWorkspaces()` |
 * | `setupCommandFindings` | a page stating what a scaffolded app's `bun run setup` runs, or how many steps it is, describes the script `x new` writes — `x db seed` was in the script and in no CI path, and four pages hand-copy the list | `binSetup()` in `templates/scaffold-bin.ts` |
 * | `llmsTxtFindings` | `llms.txt`'s package and wiki lists are generated — they were not, and `@ultimat3/notify` was missing | `listWorkspaces()`, `wiki/_Sidebar.md`, `wiki/Home.md` |
 * | `wikiFenceFindings` | a fenced `ts`/`tsx` example on a wiki page typechecks — `readmeFenceFindings` read package READMEs only (sweep 11). Runs AFTER it: both compile in one fixture directory | `tsc`, on a ratchet |
 * | `wikiAnchorFindings` | every `Page#anchor` link lands on a heading of its page | the target page's heading slugs |
 * | `knownGapLinkFindings` | each Known-Gaps `[B<n>]` link resolves to its backlog row and names its issue | the plan files |
 * | `opsUidFindings` | a uid `docs/ops` states is the one its image runs | `RUNTIME_UID`, `docker/helm/values.yaml` |
 * | `boundaryRuleDocFindings` | `02-boundaries.md`'s rule count and code table match the boundary rules | `BOUNDARY_CODES` |
 * | `readmeSampleFindings` | the root README's code sample is the `examples/dummy` file it quotes | that file |
 * | `packageFrontFindings` | a publishable package's npm page opens on a sentence, install, example and wiki page, with `keywords` | each `package.json` |
 *
 * `testTypecheckFindings` rides HERE and not on `typecheck`, which is where it belongs by meaning:
 * that step takes no host findings at all (`packages/cli/src/cmd-verify.ts` calls `hostFindings`
 * on four steps, and `typecheck` is not one), and widening it is that package's edit rather than a
 * rider on this one. This is the step that already carries the other `tsc`-on-a-ratchet rule, and
 * it asks the same question both do: does a committed file still describe this tree?
 *
 * None of them is a step of its own, for the reason the `errors` step's comment already gives:
 * `VerifyStepName` is a closed union owned by `@ultimat3/cli`, and a generated app would inherit an
 * eighteenth step that only this repo can run. `package-shape` would have been the natural home for
 * the publish list, but the CLI's step takes no host findings — widening it is that package's edit.
 */
export const committedFiles: HostCheck = async (root) => [
  ...(await publishListFindings(root)),
  ...(await benchClaimFindings(root)),
  ...(await wikiTableFindings(root)),
  ...(await frameDocFindings(root)),
  ...(await chartVersionFindings(root)),
  ...(await docCommandFindings(root)),
  ...(await docPathFindings(root)),
  ...(await gateStepFindings(root)),
  ...(await versionStampFindings(root)),
  ...(await readmeFenceFindings(root)),
  ...(await testDiscoveryFindings(root)),
  ...(await testTypecheckFindings(root)),
  ...(await generatorCountFindings(root)),
  ...(await releaseFactFindings(root)),
  ...(await setupCommandFindings(root)),
  ...(await llmsTxtFindings(root)),
  ...(await wikiFenceFindings(root)),
  ...(await wikiAnchorFindings(root)),
  ...(await knownGapLinkFindings(root)),
  ...(await opsUidFindings(root)),
  ...(await boundaryRuleDocFindings(root)),
  ...(await readmeSampleFindings(root)),
  ...(await packageFrontFindings(root)),
];
