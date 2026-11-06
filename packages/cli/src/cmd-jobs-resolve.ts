// `x jobs resolve-step <id> <step> --ran [--output <json>] | --not-ran` — a person's answer to
// `X_STEP_OUTCOME_UNKNOWN`: a `once` step that started and never completed either happened (its
// output is recorded, a replay returns it) or did not (`cleared`, the next run calls it again).
// Then `x jobs retry <id>`. Split from `cmd-jobs.ts`, which is the dispatch.

import type { JobDriver, StepResolution } from '@ultimat3/jobs';
import { resolveJobStep } from '@ultimat3/jobs';
import type { CommandContext } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { jobTraceToJson } from './jobs-json';
import { showJob } from './jobs-report';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool, flagString } from './parse';

const EXAMPLE = "x jobs resolve-step <id> <step> --ran --output '{}' --json";

/** Exactly one of `--ran` and `--not-ran`; `--output` is JSON, and only with `--ran`. */
function resolutionOf(ctx: CommandContext): StepResolution {
  const ran = flagBool(ctx.args, 'ran');
  const notRan = flagBool(ctx.args, 'not-ran');
  const output = flagString(ctx.args, 'output');
  if (ran === notRan) {
    throw new BadFlagError({
      flag: ran ? 'not-ran' : 'ran',
      command: 'jobs resolve-step',
      reason: 'say whether the step ran: pass exactly one of --ran and --not-ran',
      fix: EXAMPLE,
    });
  }
  if (notRan) {
    if (output !== undefined) {
      throw new BadFlagError({
        flag: 'output',
        command: 'jobs resolve-step',
        reason: 'a step that did not run has no output to record',
        fix: 'x jobs resolve-step <id> <step> --not-ran --json',
      });
    }
    return { ran: false };
  }
  if (output === undefined) return { ran: true, output: null };
  try {
    return { ran: true, output: JSON.parse(output) as unknown };
  } catch {
    throw new BadFlagError({
      flag: 'output',
      command: 'jobs resolve-step',
      reason: 'the output is not JSON — it is what a replay of the step will return',
      fix: EXAMPLE,
    });
  }
}

export async function runResolveStep(
  driver: JobDriver,
  ctx: CommandContext,
  id: string,
): Promise<CommandResult> {
  const step = ctx.args.positionals[1];
  if (step === undefined) {
    throw new MissingPositionalError({
      command: 'jobs resolve-step',
      positional: 'step',
      example: `x jobs show ${id} --json`,
    });
  }
  const resolved = await resolveJobStep(driver, id, step, resolutionOf(ctx));
  const trace = await showJob(driver, id);
  return {
    ok: true,
    command: 'jobs',
    summary: msg('cli.jobs.stepResolved', { id, step, status: resolved.status }),
    data: jobTraceToJson(trace),
  };
}
