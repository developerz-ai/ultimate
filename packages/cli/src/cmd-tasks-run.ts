// `x tasks run <name>`: fire a scheduled task now — the jobs its occurrence enqueues, onto the
// app's queue — so a cron job is exercised in dev without waiting for its cron or editing it.
// Through the task's own manual-run path (`TaskHandle.enqueue`), the one the admin's run-now uses.

import { isProduction, UltimateError } from '@ultimat3/core';
import type { TaskHandle } from '@ultimat3/jobs';
import type { CommandContext } from './command';
import { refuseEmbeddedWriteBesideDev } from './dev-lock-live';
import { withJobDriver } from './jobs-driver';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { flagBool } from './parse';
import { quoteArg } from './shell-quote';

/** The container's half of the consent: the task this deploy fires, named, as a fixed argv can. */
export const TASK_RUN_ENV = 'ULTIMATE_TASK_RUN';

/**
 * Does this environment fire only when asked by name? `x db seed`'s production gate, mirrored: the
 * same predicate (`ULTIMATE_ENV` resolved `production`; staging runs unasked, as a `dev` seed does;
 * an `ULTIMATE_ENV` that is no environment refuses with `X_ENVIRONMENT_INVALID`), and consent is
 * named — `--production` on the command line, or `ULTIMATE_TASK_RUN=<name>` for a container whose
 * command line is fixed, as `--tier` and `ULTIMATE_SEED_TIER` are. Pinned against `seedTiersFor`.
 */
export const tasksRunNeedsFlag = (env: Readonly<Record<string, string | undefined>>): boolean =>
  isProduction({ env });

/**
 * `X_SEED_ENVIRONMENT`'s form: its own code, not `X_CLI_BAD_FLAG` — the argv was well formed and
 * the answer is still no. The env var is in the cause, the one pasteable flag line is the fix.
 */
export class TaskRunProductionError extends UltimateError {
  constructor(name: string) {
    super({
      code: 'X_TASK_RUN_PRODUCTION',
      cause: `ULTIMATE_ENV resolved production, where firing ${name} enqueues real work beside its next scheduled occurrence — x tasks run fires there only when asked by name; ${TASK_RUN_ENV}=${name} says this deploy takes it`,
      fix: `x tasks run ${quoteArg(name)} --production --json`,
    });
  }
}

/**
 * Production fires only when asked. Not a scheduled occurrence: the scheduler's watermark is never
 * moved, so the next real tick still fires — a manual run in production is real work twice.
 */
function refuseUnaskedProduction(ctx: CommandContext, name: string): void {
  if (flagBool(ctx.args, 'production') || ctx.env[TASK_RUN_ENV] === name) return;
  if (!tasksRunNeedsFlag(ctx.env)) return;
  throw new TaskRunProductionError(name);
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
