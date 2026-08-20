// `x verify` — the contract. Every check is a named step with its own pass/fail and duration, the
// same list in the terminal and in --json, and a non-zero exit if any step fails. Green means
// shippable (axiom 5): one step list, no second checklist, no CI-only step, and no way to narrow
// the run — `--only` and `--skip` would make "green" mean whatever the caller chose.

import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { readIntFlag } from './flag-number';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { WORKER_CEILING, WORKER_FLOOR, WORKER_OVERSUBSCRIBE } from './test-workers';
import { VERIFY_STEPS } from './verify-checks';
import { runVerify } from './verify-run';
import type { VerifyStepName } from './verify-step';

// One import path for the gate, unchanged by the split: `index.ts`, `x build` and the MCP host all
// reach the list and the runner through this module, and a second path to either would be the
// ambiguity axiom 1 forbids.
export { VERIFY_STEPS } from './verify-checks';
export { runVerify } from './verify-run';

export const verifyCommand: CliCommand = {
  spec: {
    name: 'verify',
    summary: 'the gate: typecheck, lint, boundaries, all tests, drift, contract, budgets',
    usage: 'x verify [--workers N] [--json]',
    requiresApp: true,
    // The only flag, and it is not `--only`/`--skip` in disguise: it changes how wide the test
    // steps spread, never which steps run. Every step still runs, so "green" still means the
    // same thing at `--workers 1` as at `--workers 8`.
    flags: [
      {
        name: 'workers',
        type: 'string',
        summary: `test processes per parallel step (default: ${WORKER_OVERSUBSCRIBE}x CPUs, min ${WORKER_FLOOR}, max ${WORKER_CEILING})`,
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('verify', ctx.cwd).dir;
    const workers = readWorkers(ctx.args);
    return runVerify(VERIFY_STEPS, {
      root,
      runner: ctx.runner,
      ...(workers === undefined ? {} : { workers }),
    });
  },
};

/**
 * Both bounds are the constants the flag summary already names, so `x help verify` and the reader
 * cannot disagree. Exported for the test that pins them: the command's `run` reaches this only
 * after the whole gate would have started.
 *
 * `max` is the ceiling. Without it `--workers 5000` parsed, `planShards` clamped only to the file
 * count, and `runParallel` `Promise.all`ed one Bun process per test file. `min` is `WORKER_FLOOR`,
 * the same number `defaultWorkers` will not go below — the gate spreads or it does not shard, and
 * `--workers 1` was a serial run the summary said was impossible. `x test --workers 1` stays legal
 * and is deliberately NOT this reader: `runShards` clamps the width to the file count, so a
 * one-file corpus makes `X_TEST_SHARD_FAILED`'s own `fix:` say `--workers 1`.
 */
export const readWorkers = (args: ParsedArgs): number | undefined =>
  readIntFlag(args, {
    name: 'workers',
    command: 'verify',
    min: WORKER_FLOOR,
    max: WORKER_CEILING,
    example: 'x verify --workers 4',
  });

export const verifyStepNames = (): readonly VerifyStepName[] =>
  VERIFY_STEPS.map((step) => step.name);
