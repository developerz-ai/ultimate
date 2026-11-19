// `x upgrade --only`: which of the gate's steps the hop's `x verify` runs, read before anything
// spawns, and which it leaves out — counted against the installed CLI's gate, which may be older.
// The list is `x verify --only`'s, read by the same reader (`verify-only.ts`).

import { t } from '@ultimat3/schema';
import type { CommandContext } from './command';
import { BadFlagError } from './errors';
import type { ExecResult } from './exec';
import { documentIn } from './upgrade-document';
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

const PLAN = t.object({
  data: t.object({
    matrix: t.object({ include: t.array(t.object({ only: t.string })) }),
  }),
});

/**
 * The steps the INSTALLED CLI's gate has and this hop did not run: its `x verify plan --parts 1`,
 * the one form that reads no app. A CLI with no plan (or no answer) leaves this CLI's list
 * standing, the best evidence there is; a step it lacks then fails CI's run by name.
 */
export async function installedNotRun(
  cli: (args: readonly string[]) => Promise<ExecResult>,
  scope: GateScope,
): Promise<readonly string[]> {
  const parsed = PLAN.safeParse(
    documentIn((await cli(['verify', 'plan', '--parts', '1', '--json'])).stdout),
  );
  if (parsed.issues !== undefined) return scope.notRun;
  const rows = (parsed.value as { data: { matrix: { include: readonly { only: string }[] } } }).data
    .matrix.include;
  const gate = new Set(rows.flatMap((row) => row.only.split(',')));
  if (gate.size === 0) return scope.notRun;
  return [...gate].filter((name) => name !== '' && !scope.steps.includes(name));
}
