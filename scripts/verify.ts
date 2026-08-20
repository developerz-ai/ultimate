#!/usr/bin/env bun
// The gate for the framework repo itself: `x verify`, run at the repo root. The step list, the
// runner, the report and the exit code all come from @ultimat3/cli — a contributor and a user see
// the same steps because there is only one list. This file adds the two rules a package monorepo
// enforces that the CLI cannot know on its own: the tier table, and its generated manifest.
//
//   bun run scripts/verify.ts [--json] [--verbose]

import { join } from 'node:path';
import type { HostCheck, VerifyStepName } from '@ultimat3/cli';
import {
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  checkFlagReads,
  collectDeclaredCodes,
  exec,
  exitCodeFor,
  registeredErrorCodes,
  render,
  runVerify,
  SPECS,
  VERIFY_STEPS,
} from '@ultimat3/cli';
import { benchClaimFindings } from './bench-claims';
import {
  adminFlattenerFindingFor,
  checkAdminFlattener,
  checkBoundaries,
  checkSharedLeaf,
  collectAdminFiles,
  collectSharedFiles,
  collectSourceFiles,
  findingFor,
  sharedLeafFindingFor,
} from './boundaries';
import { chartVersionFindings } from './chart-version';
import { docCommandFindings } from './doc-commands';
import { docFixFindings } from './doc-fixes';
import { errorStatusCompleteness } from './error-map';
import { errorRendering } from './error-render';
import { generatorCountFindings } from './generator-counts';
import { frameworkCatalogFindings } from './i18n-catalog';
import { imageContractFindings } from './image-contract';
import { flagBool, parseScriptArgs } from './lib/args';
import { writeOut } from './lib/log';
import { repoRoot } from './lib/run';
import { DEFAULT_OUT, frameworkManifestDrift } from './manifest';
import { readmeFenceFindings } from './readme-fences';
import { releaseFactFindings } from './release-facts';
import { publishListFindings } from './release-workflow';
import { checkRoadmap } from './roadmap';
import { bareErrorFindings } from './test-bare-error';
import { testFixFindings } from './test-fix-citations';
import { testTypecheckFindings } from './test-typecheck-gate';
import { throwFindings } from './to-throw-returns';
import { versionStampFindings } from './version-stamps';
import { frameDocFindings } from './wiki-frames';
import { wikiTableFindings } from './wiki-tables';

/**
 * Five rules on one step. The tier table: a package may import only from a strictly lower tier.
 * The `shared/` leaf: an example app's `shared/` may hold types from `app/` but never a runtime
 * edge into it — `x verify` inside the app already checks that, and this repo's own gate must
 * too, because the reference-app job is advisory and this one blocks. `@ultimat3/admin`'s one
 * flattener: `packages/admin/CLAUDE.md` names `entity-columns.ts` as the only file that may read
 * `$meta` or call `$describe()` — stated there since it shipped, and unenforced until this line.
 * The framework catalog: `packages/i18n/src/catalogs/en.json` still answers every key framework
 * source renders, and still describes only screens that exist — 27 `t('admin.…')` keys had no
 * entry and an `admin.nav.*` block nothing reads did, so every admin screen rendered `⟦key⟧`.
 *
 * The image contract: `docker/Dockerfile` must build and ship one libc family, and must prove its
 * entrypoint in the stage that ships it. Neither was true — the build base was musl and the runtime
 * glibc, so every container of every build exited `exec /app/x: no such file or directory` while
 * the build reported green, because the `--version` guard ran on the build stage. `docker build`
 * runs on no PR, so this text rule is the only thing between that and the next release.
 *
 * The catalog and image rules ride here for the reason this step's own CLI comment gives:
 * `VerifyStepName` is a closed union owned by `@ultimat3/cli`, and a generated app would inherit an
 * eighteenth step only this repo can run. This is already the slot for "conventions this repo makes
 * about its own source that the framework cannot know" — the flattener rule is not a tier rule
 * either — and it runs third, before any suite, which is where a millisecond-cost text rule belongs.
 */
export const tierBoundaries: HostCheck = async (root) => [
  ...checkBoundaries(await collectSourceFiles(root)).map(findingFor),
  ...checkSharedLeaf(await collectSharedFiles(root)).map(sharedLeafFindingFor),
  ...checkAdminFlattener(await collectAdminFiles(root)).map(adminFlattenerFindingFor),
  ...(await frameworkCatalogFindings(root)),
  ...(await imageContractFindings(root)),
  // The CLI's own declarations, held to each other: a flag the parser accepts that no file reads is
  // a promise `x help` prints with nothing behind it. `x deploy --critical` said "forces clients to
  // reload" and reached no reader outside the plan JSON. Host-side, because a generated app ships no
  // `packages/cli/src` — and on `boundaries` rather than an eighteenth step, for the reason the
  // `errors` step's comment already gives: `VerifyStepName` is a closed union the CLI owns.
  ...(await checkFlagReads(SPECS, join(root, 'packages', 'cli', 'src'))),
];

/**
 * The framework's own manifest is generated from the packages: it must still generate, and the
 * committed copy must still match. Regenerating without comparing proves only that the generator
 * runs — a step that cannot fail, which is worse than no step at all.
 */
export const frameworkManifest: HostCheck = async (root) => {
  let drift: readonly string[];
  try {
    drift = await frameworkManifestDrift(root);
  } catch (error) {
    return [
      {
        // Not `X_MANIFEST_STALE`: nothing here is out of date. The generator refused to run, and
        // that is a failed gate step — `X_MANIFEST_STALE` belongs to a committed `openapi.json`
        // the code has moved past, `X_MANIFEST_DRIFT` to a committed manifest.
        code: 'X_VERIFY_FAILED',
        cause: `the framework manifest could not be generated: ${error instanceof Error ? error.message : String(error)}`,
        fix: 'bun run manifest',
        docs: 'https://ultimate.dev/errors/X_VERIFY_FAILED',
        at: DEFAULT_OUT,
      },
    ];
  }
  if (drift.length === 0) return [];
  return [
    {
      code: 'X_MANIFEST_DRIFT',
      cause: `${DEFAULT_OUT} no longer describes the code: ${drift.join(', ')}`,
      fix: 'bun run manifest',
      docs: 'https://ultimate.dev/errors/X_MANIFEST_DRIFT',
      at: DEFAULT_OUT,
    },
  ];
};

/**
 * The reference page every shipped `X_*` code must appear on. A framework monorepo publishes one
 * and a generated app does not, so naming it is the host's job — the CLI owns the rule, this repo
 * owns the file it is checked against.
 */
export const ERROR_REFERENCE = 'wiki/Error-Codes.md';

/**
 * The codes this repo's own gate emits. `scripts/` never ships, so no package may register
 * `X_ROADMAP_STATUS_MISSING` or `X_BOUNDARY_VIOLATION` — but the reference documents them, and a
 * rule that demanded a registration would push a contributor-only code into every generated app.
 * Scanned rather than listed, so a new script code needs no second edit here; a *documented* code
 * that neither a package nor a script declares is still the ghost row the registry check exists
 * to catch.
 *
 * The exemption follows the code's *declaration*, not every file that names it: a code a package
 * declares and a script merely throws — `X_BUN_VERSION` — is the package's to register, and
 * exempting it because `scripts/setup.ts` mentions it would waive the rule for a shipped code.
 */
const hostOwnedCodes = async (root: string): Promise<readonly string[]> =>
  (await collectDeclaredCodes(root))
    .filter((site) => site.at.startsWith('scripts/'))
    .map((site) => site.code);

/**
 * Both halves of the reference's contract, on one step. Every shipped code has a row here, and
 * every row this page presents as live resolves through `x errors explain` — the second half is
 * what stops the page documenting a code the registry never heard of.
 */
export const errorCodeDocs: HostCheck = async (root) => {
  const known = new Set([...(await registeredErrorCodes()), ...(await hostOwnedCodes(root))]);
  return [
    ...(await checkErrorCodeDocs(root, ERROR_REFERENCE)),
    ...(await checkErrorCodeRegistry(root, ERROR_REFERENCE, known)),
  ];
};

/**
 * The `errors` step's host half: the reference page's three rules, the rule that an error factory
 * may not die formatting its own message, and the rule that `@ultimat3/http`'s status table stays
 * closed. Five rules on one step, the same shape `boundaries` already carries — a rule about
 * errors belongs on the errors step, not on an eighteenth one an agent has to learn the name of.
 *
 * `docFixFindings` is the reference page's THIRD rule and the one nothing enforced: the CLI's
 * `checkErrorFixes` resolves cited commands for `fix:` literals in shipped SOURCE, and the page an
 * agent is sent to when it hits a code was held to coverage and registration only. So a `Fix` cell
 * could print `x db query "select id …"` — and `x db` has no `query`, which is a second failure
 * handed to a reader already holding one.
 *
 * `testFixFindings`, `bareErrorFindings` and `throwFindings` join it because all three are the same
 * contract one file set further on. `checkErrorFixes` holds every `fix:` in `src/` to being runnable and skips tests, so a
 * fixture error, a helper that builds one and an assertion pinning a fix string were unchecked —
 * and `x schema show` and `x logs tail` are what that costs. `throwFindings` is the other half of
 * an error assertion: bun's synchronous `toThrow` PASSES when the callback returns an Error rather
 * than throwing one, and this repo exports 196 functions that return one. `bareErrorFindings` is the rule itself in
 * that file set: `CLAUDE.md` says never throw a bare `Error` and the enforced check skips tests, so
 * 422 sites sat under a green gate — a convention that is not a build error does not exist.
 *
 * The completeness rule is deliberately NOT its own step: `VerifyStepName` is a closed union owned
 * by `@ultimat3/cli`, and a generated app would inherit a step name that only this repo can run.
 * It blocks `x verify` either way, which is what "enforced, not documented" asks for.
 */
export const errorContract: HostCheck = async (root) => [
  ...(await errorCodeDocs(root)),
  ...(await errorRendering(root)),
  ...(await errorStatusCompleteness(root)),
  ...(await docFixFindings(root)),
  ...(await testFixFindings(root)),
  ...(await bareErrorFindings(root)),
  ...(await throwFindings(root)),
];

/**
 * The `manifest` step's host half: four rules, all asking that step's own question — does a
 * committed file still describe this tree? The generated manifest is the original. The other three
 * are hand-maintained files that claim something about the repo and were checked by nothing:
 *
 * | Rule | The claim, and what it cost | Source of truth |
 * |---|---|---|
 * | `publishListFindings` | `.github/workflows/release.yml` publishes every package — it does not, and `@ultimat3/flags` has never been on npm | `publishOrder(listWorkspaces())` |
 * | `benchClaimFindings` | `CLAUDE.md`'s realtime figures are what was measured | `scripts/bench/results/*.json` |
 * | `wikiTableFindings` | every `wiki/` table renders as a table | the GFM row rule |
 * | `frameDocFindings` | `wiki/Realtime.md` names the frames the wire actually sends | `FRAME_KINDS` |
 * | `chartVersionFindings` | `docker/helm/Chart.yaml` is on the lockstep version — it sat at 0.0.1, and `appVersion` IS the default image tag | the publishable workspaces' version |
 * | `docCommandFindings` | every `` `x …` `` in `wiki/` and `docs/` is an invocation this build can run | `loadCommandCatalog()` |
 * | `versionStampFindings` | one page stamps a version, it is the shipped one, and the workspaces agree | every workspace manifest |
 * | `readmeFenceFindings` | a fenced `ts`/`tsx` example in a package README typechecks | `tsc`, on a ratchet |
 * | `testTypecheckFindings` | this repo's TEST sources typecheck — every package config excludes them, so `tsc -b` reads none of the 966 | `tsc -p tsconfig.tests.json`, on a ratchet |
 * | `generatorCountFindings` | a documented `N files` for `x new` / `x g resource` is what the generator still emits — five had gone stale and were corrected by hand | `planNewApp()` / `generate()`, the planners `--dry-run` calls |
 * | `releaseFactFindings` | the package COUNT ten pages restate is the count on disk; `SECURITY.md` claimed 28 two majors late | `listWorkspaces()` |
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
export const frameworkFiles: HostCheck = async (root) => [
  ...(await frameworkManifest(root)),
  ...(await publishListFindings(root)),
  ...(await benchClaimFindings(root)),
  ...(await wikiTableFindings(root)),
  ...(await frameDocFindings(root)),
  ...(await chartVersionFindings(root)),
  ...(await docCommandFindings(root)),
  ...(await versionStampFindings(root)),
  ...(await readmeFenceFindings(root)),
  ...(await testTypecheckFindings(root)),
  ...(await generatorCountFindings(root)),
  ...(await releaseFactFindings(root)),
];

export const HOST_CHECKS: Partial<Record<VerifyStepName, HostCheck>> = {
  boundaries: tierBoundaries,
  errors: errorContract,
  manifest: frameworkFiles,
  roadmap: checkRoadmap,
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const result = await runVerify(VERIFY_STEPS, { root, runner: exec, hostChecks: HOST_CHECKS });
  // Through `writeOut`, not `process.stdout.write`: see the note there. A failing gate's JSON
  // carries each failed step's own output, which is exactly when the payload clears 64KB and
  // exactly when a developer needs it — so the truncation only ever bit the runs that mattered.
  writeOut(`${render(result, args.json, flagBool(args, 'verbose'))}\n`);
  process.exit(exitCodeFor(result));
}
