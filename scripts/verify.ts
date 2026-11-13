#!/usr/bin/env bun
// The gate for the framework repo itself: `x verify`, run at the repo root. The step list, the
// runner, the report and the exit code all come from @ultimat3/cli — a contributor and a user see
// the same steps because there is only one list. This file adds the two rules a package monorepo
// enforces that the CLI cannot know on its own: the tier table, and its generated manifest — each
// step's list in `verify-host-checks.ts`.
//
//   bun run scripts/verify.ts [--json] [--verbose] [--workers N] [--only <step>[,<step>…]]
//   bun run scripts/verify.ts --only unit --shard i/n [--timings file]   # one CI runner's slice
//   bun run scripts/verify.ts merge <part.json…> [--json]                # the parts, as one verdict
//
// The last two are how CI runs this gate on several runners and still gets ONE verdict: each part
// is `--only` (and `--shard` for the parallel suites), and `merge` is red for a step no part ran.
// `x verify` has both, but refuses the repo root (`X_NOT_IN_APP`) and carries no host checks, so
// they are spelled here too — same readers, same merge, this file's `HOST_CHECKS` under them.
//
// `--workers` is the CLI's own flag, passed through: the test steps shard over `cpus` by default,
// and on a shared machine that width was measured to take the whole gate down (OOM-killed twice
// on 2026-09-07 beside two other suites). It narrows the WIDTH of the run, never the gate.

import { exec, exitCodeFor, render, runVerify, VERIFY_STEPS } from '@ultimat3/cli';
import { isUltimateError } from '@ultimat3/core';
import { requireBunVersion } from '../packages/cli/src/app-root';
import { BadFlagError, MissingPositionalError } from '../packages/cli/src/errors';
import { readVerifyFloor } from '../packages/cli/src/verify-floor';
import { mergeParts, parsePart, VerifyMergeInputError } from '../packages/cli/src/verify-merge';
import { measurePace } from '../packages/cli/src/verify-pace';
import { withVerifyProgress } from '../packages/cli/src/verify-progress';
import { readTimings } from '../packages/cli/src/verify-shard';
import { VERIFY_STEP_NAMES } from '../packages/cli/src/verify-step';
import { writeErrorLine } from '../packages/cli/src/write-line';
import { flagBool, parseScriptArgs } from './lib/args';
import { report, writeOut } from './lib/log';
import { repoRoot } from './lib/run';
import { REPO_GATE, readVerifyArgs, VERIFY_SUBCOMMANDS } from './lib/verify-args';
import { HOST_CHECKS } from './verify-host-checks';

// The host checks live in `verify-host-checks.ts`; every name this file exported still resolves here.
export {
  BOUNDARY_CHECKS,
  ERROR_CHECKS,
  ERROR_REFERENCE,
  errorCodeDocs,
  errorContract,
  frameworkFiles,
  frameworkManifest,
  HOST_CHECKS,
  MANIFEST_CHECKS,
  manifestFailureCause,
  tierBoundaries,
} from './verify-host-checks';

/**
 * `merge <part.json…>`: the parts CI ran on separate runners, folded by the CLI's own `mergeParts`
 * under this repo's `x.verify.json`. Green only when every step of the gate is in exactly one part
 * (or in every shard of one split) — a step no part ran is `X_VERIFY_MERGE_INCOMPLETE`.
 */
export async function mergeGateParts(root: string, files: readonly string[]) {
  if (files.length === 0) {
    throw new MissingPositionalError({
      command: 'verify merge',
      positional: 'part.json…',
      example: 'bun run verify merge parts/*.json --json',
    });
  }
  const parts = await Promise.all(
    files.map(async (file) => {
      const handle = Bun.file(file);
      // An unmatched `parts/*.json` arrives as that literal: refused by name, never an ENOENT.
      if (!(await handle.exists())) {
        throw new VerifyMergeInputError({ file, reason: 'does not exist', command: REPO_GATE });
      }
      return parsePart(file, await handle.text(), REPO_GATE);
    }),
  );
  // No coverage riders: this root is not an app. The framework's floor is judged per package and
  // for `scripts/`, one process each, by `scripts/coverage-gate.ts` — the `packages` CI job.
  return mergeParts(parts, await readVerifyFloor(root), VERIFY_STEP_NAMES, { command: REPO_GATE });
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const verbose = flagBool(args, 'verbose');
  try {
    // The runtime first, as `x` itself does (`dispatch`): this script calls `runVerify` directly
    // and so skipped that check. A gate on a Bun below the pin is not the gate CI runs — on Bun
    // 1.4.0 (oven-sh/bun#40578, fixed in 1.4.1) every browser barrel bundles to an empty
    // `export { … }` and `scripts/browser-barrel.test.ts` goes red over code nobody changed, after
    // the whole gate has run. One coded line, before any step, names the cause instead.
    requireBunVersion(Bun.version);
    const [word, ...rest] = args.positionals;
    if (word !== undefined && !(VERIFY_SUBCOMMANDS as readonly string[]).includes(word)) {
      // A stray word used to be dropped and the whole gate ran: `verify lint` is not `--only lint`.
      throw new BadFlagError({
        flag: 'only',
        command: 'verify',
        reason: `"${word}" is not a subcommand (${VERIFY_SUBCOMMANDS.join(', ')}); a step is named with --only`,
        fix: 'bun run verify --only lint',
      });
    }
    const gate = readVerifyArgs(args);
    const result =
      word === 'merge'
        ? await mergeGateParts(root, rest)
        : // Progress on stderr in either render — a line per finished step, a heartbeat while one
          // runs — so a cancelled CI part's log ends where it hung (#589) and a harness that
          // kills on silence never kills a healthy gate. stdout stays the one document.
          await withVerifyProgress(
            writeErrorLine,
            async (progress) =>
              runVerify(VERIFY_STEPS, {
                root,
                runner: exec,
                hostChecks: HOST_CHECKS,
                command: REPO_GATE,
                // The deadlines at this machine's pace: a 2-core fleet box is not a 4-core CI runner.
                pace: measurePace(),
                ...(gate.only === undefined ? {} : { only: gate.only }),
                ...(gate.workers === undefined ? {} : { workers: gate.workers }),
                ...progress,
                ...(gate.shard === undefined
                  ? {}
                  : {
                      shard: {
                        ...gate.shard,
                        ...(gate.timings === undefined
                          ? {}
                          : { timings: await readTimings(gate.timings, REPO_GATE) }),
                      },
                    }),
              }),
            { render: args.json ? 'json' : 'human' },
          );
    // Through `writeOut`, not `process.stdout.write`: see the note there. A failing gate's JSON
    // carries each failed step's own output, which is exactly when the payload clears 64KB and
    // exactly when a developer needs it — so the truncation only ever bit the runs that mattered.
    writeOut(`${render(result, args.json, verbose)}\n`);
    process.exit(exitCodeFor(result));
  } catch (error) {
    // A refused flag, a refused shard and an unreadable part are all coded: reported in the
    // script's own shape, never as a stack trace.
    if (!isUltimateError(error)) throw error;
    const finding = { code: error.code, cause: error.cause, fix: error.fix };
    report({ ok: false, script: 'verify', summary: 'refused', findings: [finding] }, args.json);
  }
}
