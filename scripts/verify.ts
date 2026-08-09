#!/usr/bin/env bun
// The gate for the framework repo itself: `x verify`, run at the repo root. The step list, the
// runner, the report and the exit code all come from @ultimat3/cli — a contributor and a user see
// the same steps because there is only one list. This file adds the two rules a package monorepo
// enforces that the CLI cannot know on its own: the tier table, and its generated manifest.
//
//   bun run scripts/verify.ts [--json] [--verbose]

import type { HostCheck, VerifyStepName } from '@ultimat3/cli';
import { exec, exitCodeFor, render, runVerify, VERIFY_STEPS } from '@ultimat3/cli';
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
        code: 'X_MANIFEST_STALE',
        cause: `the framework manifest could not be generated: ${error instanceof Error ? error.message : String(error)}`,
        fix: 'bun run manifest',
        docs: 'https://ultimate.dev/errors/X_MANIFEST_STALE',
        at: DEFAULT_OUT,
      },
    ];
  }
};

export const HOST_CHECKS: Partial<Record<VerifyStepName, HostCheck>> = {
  boundaries: tierBoundaries,
  manifest: frameworkManifest,
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const result = await runVerify(VERIFY_STEPS, { root, runner: exec, hostChecks: HOST_CHECKS });
  process.stdout.write(`${render(result, args.json, flagBool(args, 'verbose'))}\n`);
  process.exit(exitCodeFor(result));
}
