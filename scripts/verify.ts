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
  exec,
  exitCodeFor,
  render,
  runVerify,
  VERIFY_STEPS,
} from '@ultimat3/cli';
import {
  checkBoundaries,
  checkSharedLeaf,
  collectSharedFiles,
  collectSourceFiles,
  findingFor,
  sharedLeafFindingFor,
} from './boundaries';
import { flagBool, parseScriptArgs } from './lib/args';
import { repoRoot } from './lib/run';
import { buildManifest, DEFAULT_OUT } from './manifest';
import { checkRoadmap } from './roadmap';

/**
 * Two rules on one step. The tier table: a package may import only from a strictly lower tier.
 * The `shared/` leaf: an example app's `shared/` may hold types from `app/` but never a runtime
 * edge into it — `x verify` inside the app already checks that, and this repo's own gate must
 * too, because the reference-app job is advisory and this one blocks.
 */
export const tierBoundaries: HostCheck = async (root) => [
  ...checkBoundaries(await collectSourceFiles(root)).map(findingFor),
  ...checkSharedLeaf(await collectSharedFiles(root)).map(sharedLeafFindingFor),
];

/** The framework's own manifest is generated from the packages; it must still generate. */
export const frameworkManifest: HostCheck = async (root) => {
  try {
    await buildManifest(root);
    return [];
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
};

/**
 * The reference page every shipped `X_*` code must appear on. A framework monorepo publishes one
 * and a generated app does not, so naming it is the host's job — the CLI owns the rule, this repo
 * owns the file it is checked against.
 */
export const ERROR_REFERENCE = 'wiki/Error-Codes.md';

export const errorCodeDocs: HostCheck = (root) => checkErrorCodeDocs(root, ERROR_REFERENCE);

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
