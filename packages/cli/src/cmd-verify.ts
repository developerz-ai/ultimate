// `x verify` — the contract. Every check is a named step with its own pass/fail and duration, the
// same list in the terminal and in --json, and a non-zero exit if any step fails. Green means
// shippable (axiom 5): one step list, no second checklist, no CI-only step.
//
// `--only <step>` is the ONE narrowing, decided as D6, and it does not weaken that: the GATE is
// the no-flag run, and a narrowed run says `NOT A GATE RUN` in the summary and in `--json` so no
// reader of either can take it for one. `--skip` stays refused — it would let a caller drop the
// step that was going to fail and still read the output as a whole-tree verdict.

import { nearestName } from '@ultimat3/core';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError } from './errors';
import { readIntFlag } from './flag-number';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';
import { WORKER_CEILING, WORKER_FLOOR, WORKER_OVERSUBSCRIBE } from './test-workers';
import { VERIFY_STEPS } from './verify-checks';
import { runVerify } from './verify-run';
import type { VerifyStepName } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';

// One import path for the gate, unchanged by the split: `index.ts`, `x build` and the MCP host all
// reach the list and the runner through this module, and a second path to either would be the
// ambiguity axiom 1 forbids.
export { VERIFY_STEPS } from './verify-checks';
export { runVerify } from './verify-run';

export const verifyCommand: CliCommand = {
  spec: {
    name: 'verify',
    summary: 'the gate: typecheck, lint, boundaries, all tests, drift, contract, budgets',
    usage: 'x verify [--only <step>] [--workers N] [--json]',
    requiresApp: true,
    // Two flags, and only one of them narrows. `--workers` changes how wide the test steps
    // spread, never which steps run. `--only` runs one step and says so in both renderers —
    // never silently, which is the whole of what makes it safe to have.
    flags: [
      {
        name: 'workers',
        type: 'string',
        summary: `test processes per parallel step (default: ${WORKER_OVERSUBSCRIBE}x CPUs, min ${WORKER_FLOOR}, max ${WORKER_CEILING})`,
      },
      {
        name: 'only',
        type: 'string',
        summary:
          'run ONE step by name — an iteration loop, NOT A GATE RUN; the gate is this command with no flag',
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('verify', ctx.cwd).dir;
    // Both readers before the run: an unrunnable flag must be refused in milliseconds, not after
    // `tsc -b` has spent fourteen seconds on a run the caller cannot use.
    const workers = readWorkers(ctx.args);
    const only = readOnlyStep(ctx.args);
    return runVerify(VERIFY_STEPS, {
      root,
      runner: ctx.runner,
      ...(workers === undefined ? {} : { workers }),
      ...(only === undefined ? {} : { only }),
    });
  },
};

/**
 * The step `--only` names, or nothing. Refused against `VERIFY_STEP_NAMES` — the same constant the
 * runner's list is built from — so a typo can never be read as "narrow to no steps at all", which
 * is a run that passes by checking nothing.
 *
 * A near miss leads with the step it is near; a word near NOTHING gets the gate itself rather than
 * an invented lead, which is the rule `parse.ts` already follows for a command that resembles
 * none. Both arms are commands that run.
 */
export const readOnlyStep = (args: ParsedArgs): VerifyStepName | undefined => {
  const raw = flagString(args, 'only');
  if (raw === undefined) return undefined;
  const found = VERIFY_STEP_NAMES.find((name) => name === raw);
  if (found !== undefined) return found;
  const suggestion = nearestName(raw, VERIFY_STEP_NAMES);
  throw new BadFlagError({
    flag: 'only',
    command: 'verify',
    reason: `"${raw}" is not a gate step (${VERIFY_STEP_NAMES.join(', ')})`,
    fix: suggestion === undefined ? 'x verify --json' : `x verify --only ${suggestion} --json`,
  });
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
