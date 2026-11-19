// `x tasks run <name>`: fire a scheduled task now — the jobs its occurrence enqueues, onto the
// app's queue — so a cron job is exercised in dev without waiting for its cron or editing it.
// Through the task's own manual-run path (`TaskHandle.enqueue`), the one the admin's run-now uses.

import { isProduction } from '@ultimat3/core';
import type { TaskHandle } from '@ultimat3/jobs';
import type { CommandContext } from './command';
import { refuseEmbeddedWriteBesideDev } from './dev-lock-live';
import { BadFlagError } from './errors';
import { withJobDriver } from './jobs-driver';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { flagBool } from './parse';
import { quoteArg } from './shell-quote';

/**
 * Does this environment fire only when asked by name? `x db seed`'s production gate, mirrored: the
 * same predicate (`ULTIMATE_ENV` resolved `production`; staging runs unasked, as a `dev` seed does;
 * an `ULTIMATE_ENV` that is no environment refuses with `X_ENVIRONMENT_INVALID`), and consent is a
 * flag naming what is asked for. Pinned against `seedTiersFor` by `cmd-tasks-run.test.ts`.
 */
export const tasksRunNeedsFlag = (env: Readonly<Record<string, string | undefined>>): boolean =>
  isProduction({ env });

/**
 * Production fires only by flag. Not a scheduled occurrence: the scheduler's watermark is never
 * moved, so the next real tick still fires — a manual run in production is real work twice.
 */
function refuseUnaskedProduction(ctx: CommandContext, name: string): void {
  if (flagBool(ctx.args, 'production')) return;
  if (!tasksRunNeedsFlag(ctx.env)) return;
  throw new BadFlagError({
    flag: 'production',
    command: 'tasks run',
    reason: `ULTIMATE_ENV resolved production, where firing ${name} enqueues real work beside its next scheduled occurrence — x tasks run fires there only when --production asks by name`,
    fix: `x tasks run ${quoteArg(name)} --production --json`,
  });
}

/** One job a fire enqueued, as `TaskHandle.enqueue` answers it (`@ultimat3/jobs` exports no name). */
type Fired = Awaited<ReturnType<TaskHandle['enqueue']>>[number];

const asJson = (fired: Fired): JsonValue => ({
  job: fired.job,
  id: fired.result.id,
  runId: fired.result.runId,
  deduped: fired.result.deduped,
});

/**
 * `handle` is already resolved (a typo is refused before any queue opens). Beside an `x dev`
 * holding the embedded database this is a second writer, refused with the stop-run-restart fix.
 */
export async function runTask(
  root: string,
  ctx: CommandContext,
  handle: TaskHandle,
  findings: readonly Finding[],
): Promise<CommandResult> {
  refuseUnaskedProduction(ctx, handle.name);
  await refuseEmbeddedWriteBesideDev(root, ctx.env, ['tasks', 'run', handle.name]);
  return withJobDriver(root, ctx, async () => {
    const fired = await handle.enqueue();
    return {
      ok: findings.length === 0,
      command: 'tasks',
      summary: msg('cli.tasks.ran', { name: handle.name, count: fired.length }),
      lines: fired.map(
        (one) => `  ${one.job}  ${one.result.id}${one.result.deduped ? '  (deduped)' : ''}`,
      ),
      findings,
      data: { task: handle.name, jobs: fired.map(asJson) },
    };
  });
}
