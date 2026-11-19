// `x upgrade --only`: which of the gate's steps the hop's `x verify` runs, read before anything
// spawns. The list is `x verify --only`'s, read by the same reader (`verify-only.ts`).

import type { CommandContext } from './command';
import { BadFlagError } from './errors';
import { readStepList, stepsNotIn } from './verify-only';

/** A scoped gate's list and the steps it leaves out: what the hop's report owes to be honest. */
export interface GateScope {
  readonly steps: readonly string[];
  readonly notRun: readonly string[];
}

/**
 * `--only`, read before anything spawns. Every step named is the full gate, so it runs as one and
 * reports as one; a repository with no `app.config.ts` runs scripts, never `x verify`, so a list
 * there would narrow nothing and is refused rather than ignored.
 */
export const readScope = (ctx: CommandContext, app: boolean): GateScope | undefined => {
  const steps = readStepList(ctx.args, 'upgrade');
  if (steps === undefined) return undefined;
  if (!app) {
    throw new BadFlagError({
      flag: 'only',
      command: 'upgrade',
      reason: 'no app.config.ts here, so the hop runs the typecheck and test scripts, not x verify',
      fix: 'x upgrade --json',
    });
  }
  const notRun = stepsNotIn(steps);
  return notRun.length === 0 ? undefined : { steps, notRun };
};
