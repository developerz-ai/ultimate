#!/usr/bin/env bun
// The gate for the framework repo itself: `x verify`, run at the repo root. The step list, the
// runner, the report and the exit code all come from @ultimat3/cli — a contributor and a user see
// the same steps because there is only one list. This file adds the two rules a package monorepo
// enforces that the CLI cannot know on its own: the tier table, and its generated manifest.
//
//   bun run scripts/verify.ts [--json] [--verbose]

import type { HostCheck, VerifyStepName } from '@ultimat3/cli';
import {
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  collectDeclaredCodes,
  exec,
  exitCodeFor,
  registeredErrorCodes,
  render,
  runVerify,
  VERIFY_STEPS,
} from '@ultimat3/cli';
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
import { flagBool, parseScriptArgs } from './lib/args';
import { repoRoot } from './lib/run';
import { DEFAULT_OUT, frameworkManifestDrift } from './manifest';
import { checkRoadmap } from './roadmap';

/**
 * Three rules on one step. The tier table: a package may import only from a strictly lower tier.
 * The `shared/` leaf: an example app's `shared/` may hold types from `app/` but never a runtime
 * edge into it — `x verify` inside the app already checks that, and this repo's own gate must
 * too, because the reference-app job is advisory and this one blocks. `@ultimat3/admin`'s one
 * flattener: `packages/admin/CLAUDE.md` names `entity-columns.ts` as the only file that may read
 * `$meta` or call `$describe()` — stated there since it shipped, and unenforced until this line.
 */
export const tierBoundaries: HostCheck = async (root) => [
  ...checkBoundaries(await collectSourceFiles(root)).map(findingFor),
  ...checkSharedLeaf(await collectSharedFiles(root)).map(sharedLeafFindingFor),
  ...checkAdminFlattener(await collectAdminFiles(root)).map(adminFlattenerFindingFor),
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

export const HOST_CHECKS: Partial<Record<VerifyStepName, HostCheck>> = {
  boundaries: tierBoundaries,
  errors: errorCodeDocs,
  manifest: frameworkManifest,
  roadmap: checkRoadmap,
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const result = await runVerify(VERIFY_STEPS, { root, runner: exec, hostChecks: HOST_CHECKS });
  process.stdout.write(`${render(result, args.json, flagBool(args, 'verbose'))}\n`);
  process.exit(exitCodeFor(result));
}
