// `x db backfill`'s wiring alone: which of the four shapes an invocation asked for, and the one
// finding-and-table projection each answers with. Split from `cmd-db.ts` the way `cmd-db-branch.ts`
// was — that file had reached the 500-line ceiling, and "which subcommand ran" and "what a sweep
// pass reports" are two jobs. The facts live in `db-backfill.ts`; nothing here opens a database.

import { resolveEnvironment } from '@ultimat3/core';
import { BackfillPendingError } from '@ultimat3/jobs';
import { loadApp } from './app-load';
import type { CommandContext } from './command';
import type { BackfillAction, BackfillPlanRow } from './db-backfill';
import {
  listBackfills,
  pendingReport,
  pendingToJson,
  planToJson,
  readAppliedMigrations,
  renderBackfillTable,
  renderPendingTable,
  renderPlanTable,
  runBackfills,
} from './db-backfill';
import { BadFlagError } from './errors';
import { withJobDriver } from './jobs-driver';
import { backfillToJson } from './jobs-json';
import { msg } from './messages';
import type { CommandResult } from './output';
import { findingFrom } from './output';
import { flagBool, flagString } from './parse';

/**
 * Four shapes, one subcommand: `--list` reads the `x_backfills` ledger, `--pending` diffs it
 * against what the app DECLARED, and `<name>` / `--all` gate a pass and put it on the queue. A
 * bare `x db backfill` is still refused rather than defaulted — the four answer four different
 * questions, and picking one for the operator is the ambiguity axiom 1 exists to refuse.
 *
 * An empty ledger is `ok: true`. "Nothing has swept this database yet" is an answer to the
 * question asked, and a command that failed over it would be unrunnable on a fresh app.
 */
export async function runBackfillCommand(
  ctx: CommandContext,
  root: string,
): Promise<CommandResult> {
  if (flagBool(ctx.args, 'list')) return runBackfillList(ctx, root);
  const all = flagBool(ctx.args, 'all');
  const name = ctx.args.positionals[0] ?? flagString(ctx.args, 'name');
  if (flagBool(ctx.args, 'pending')) return runBackfillPending(ctx, root);
  if (all) return runBackfillPass(ctx, root, 'all');
  if (name !== undefined) return runBackfillPass(ctx, root, [name]);
  throw new BadFlagError({
    flag: 'list',
    command: 'db',
    reason:
      'x db backfill needs a shape: --list (the ledger), --pending (declared minus completed), <name> or --all (run one, or every pending one)',
    fix: 'x db backfill --pending --json',
  });
}

async function runBackfillList(ctx: CommandContext, root: string): Promise<CommandResult> {
  return withJobDriver(root, ctx, async (driver) => {
    const rows = await listBackfills(driver, {
      name: flagString(ctx.args, 'name'),
      status: flagString(ctx.args, 'status'),
      limit: flagString(ctx.args, 'limit'),
    });
    return {
      ok: true,
      command: 'db',
      summary:
        rows.length === 0
          ? msg('cli.db.backfill.empty')
          : msg('cli.db.backfill.listed', { count: rows.length }),
      lines: rows.length === 0 ? [] : renderBackfillTable(rows).map((line) => `  ${line}`),
      data: rows.map(backfillToJson),
    };
  });
}

/**
 * The alarm the framework did not have. Non-zero when anything is unswept, so a cron or a deploy
 * check can read the exit code — a `--json` nobody has to parse to know something is wrong.
 * `loadApp` first: importing the app's modules IS the declaration, and a diff run without it
 * would report a clean database against an empty declaration list.
 */
async function runBackfillPending(ctx: CommandContext, root: string): Promise<CommandResult> {
  await loadApp(root);
  const environment = resolveEnvironment({ env: ctx.env });
  return withJobDriver(root, ctx, async (driver) => {
    const report = await pendingReport(driver, environment);
    return {
      ok: report.pending.length === 0,
      command: 'db',
      summary:
        report.pending.length === 0
          ? msg('cli.db.backfill.swept', { declared: report.rows.length })
          : msg('cli.db.backfill.pending', {
              count: report.pending.length,
              declared: report.rows.length,
            }),
      findings: report.pending.map((row) =>
        findingFrom(new BackfillPendingError({ backfill: row.name, environment })),
      ),
      lines: report.rows.length === 0 ? [] : renderPendingTable(report).map((line) => `  ${line}`),
      data: pendingToJson(report),
    };
  });
}

/**
 * DRY RUN by default: `--write` is never implied, because the alternative is a command whose
 * inspection form writes to a production table. What `--write` does is ENQUEUE — the queue is a
 * job's execution surface, so the sweep runs on the workers already serving the new release
 * rather than inside this process.
 */
async function runBackfillPass(
  ctx: CommandContext,
  root: string,
  names: readonly string[] | 'all',
): Promise<CommandResult> {
  await loadApp(root);
  const environment = resolveEnvironment({ env: ctx.env });
  const write = flagBool(ctx.args, 'write');
  return withJobDriver(root, ctx, async (driver) => {
    const rows = await runBackfills({
      driver,
      names,
      write,
      force: flagBool(ctx.args, 'force'),
      environment,
      appliedMigrations: await readAppliedMigrations(),
    });
    return backfillPassResult(rows, write);
  });
}

/**
 * A blocked or deduped name is a finding and a non-zero exit, and every OTHER name still ran —
 * that isolation is what stops one wedged cleanup blocking every later one forever.
 */
function backfillPassResult(rows: readonly BackfillPlanRow[], write: boolean): CommandResult {
  const findings = rows.flatMap((row) => (row.finding === null ? [] : [row.finding]));
  // Counted per action, never derived from the total: a deduped pass is neither enqueued nor
  // blocked, and `rows.length - enqueued` reported it as blocked while `--json` reported it as
  // deduped. `planToJson` is the same list, so the two renders now add up to the same run.
  const tally = (action: BackfillAction): number =>
    rows.filter((row) => row.action === action).length;
  return {
    ok: findings.length === 0,
    command: 'db',
    summary: write
      ? msg('cli.db.backfill.planned', {
          count: rows.length,
          enqueued: tally('enqueued'),
          deduped: tally('deduped'),
          blocked: tally('blocked'),
        })
      : msg('cli.db.backfill.dryRun', { count: rows.length }),
    findings,
    lines: rows.length === 0 ? [] : renderPlanTable(rows).map((line) => `  ${line}`),
    data: planToJson(rows),
  };
}
