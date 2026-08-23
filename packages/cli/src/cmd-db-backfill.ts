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
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import { quoteArg } from './shell-quote';

/** Which of the four questions an invocation asked. `pass` is `<name>` and `--all` both. */
type BackfillShape = 'list' | 'pending' | 'pass';

/**
 * Every flag that belongs to exactly ONE shape — `x db backfill`'s own usage line, executable.
 *
 * `--name` is absent because it is two things: `--list`'s filter and the pass's target, decided by
 * `readShape` below. Everything else reads for one shape and is ignored by the other two, which is
 * the silence this table ends.
 */
const SHAPE_OF_FLAG = Object.freeze<Record<string, BackfillShape>>({
  status: 'list',
  limit: 'list',
  write: 'pass',
  force: 'pass',
});

/** One runnable line per shape, so a refusal hands back the invocation the caller meant. */
const FIX_OF_SHAPE = Object.freeze<Record<BackfillShape, string>>({
  list: 'x db backfill --list --json',
  pending: 'x db backfill --pending --json',
  pass: 'x db backfill --all --write --json',
});

const refuseShape = (flag: string, reason: string, fix: string): never => {
  throw new BadFlagError({ flag, command: 'db', reason, fix });
};

/**
 * Exactly one shape, and only the flags that shape reads — refused before anything opens a
 * database, never resolved by precedence.
 *
 * Precedence is what this replaces, and it was silent in the dangerous direction:
 * `x db backfill cleanup --all --write` took the `--all` branch and ENQUEUED every pending sweep
 * while the operator had named one, and `--list --pending` reported the ledger for a command that
 * asked what was unswept. Axiom 1 — one way to do each thing — makes a second reading of one argv
 * a refusal rather than a choice the command makes on the caller's behalf.
 */
function readShape(args: ParsedArgs): { readonly shape: BackfillShape; readonly name?: string } {
  const list = flagBool(args, 'list');
  const positional = args.positionals[0];
  const named = flagString(args, 'name');
  // `--name` is a FILTER under `--list` and a target everywhere else, so it selects a shape only
  // where `--list` is absent. Two spellings of one target are still two, and are refused.
  const target = list ? undefined : (positional ?? named);
  // Under `--list` the positional is DROPPED by the line above, and until 2026-08 nothing said so:
  // `x db backfill cleanup --list` printed the whole ledger and reported `ok: true` while the
  // operator had named one sweep. `--name` is the filter's one spelling here, so this is a refusal
  // and not a second reading of the argument — the same rule every other shape in this function
  // follows, and the same argv one flag over (`--pending cleanup`) has always been refused.
  if (list && positional !== undefined) {
    return refuseShape(
      'name',
      `x db backfill --list filters the ledger with --name, so the positional "${positional}" selects nothing — it is a pass target in every other shape`,
      `x db backfill --list --name ${quoteArg(positional)} --json`,
    );
  }
  if (!list && positional !== undefined && named !== undefined) {
    return refuseShape(
      'name',
      `x db backfill names two backfills ("${positional}" and "${named}") — a pass sweeps the positional or --name, never both`,
      `x db backfill ${quoteArg(positional)} --write --json`,
    );
  }
  const asked = [
    ...(list ? ['--list'] : []),
    ...(flagBool(args, 'pending') ? ['--pending'] : []),
    ...(flagBool(args, 'all') ? ['--all'] : []),
    ...(target === undefined ? [] : [target]),
  ];
  if (asked.length > 1) {
    // The SECOND shape is the one that would have been dropped, so it is the one the cause names:
    // `--all` won over a named sweep and the operator was never told which of the two ran.
    const second = asked[1] ?? '';
    return refuseShape(
      second.startsWith('--') ? second.slice(2) : 'name',
      `x db backfill was asked for ${asked.join(' and ')} — one shape per invocation: --list, --pending, <name> or --all`,
      `x db backfill ${asked[0]} --json`,
    );
  }
  if (asked.length === 0) {
    return refuseShape(
      'list',
      'x db backfill needs a shape: --list (the ledger), --pending (declared minus completed), <name> or --all (run one, or every pending one)',
      'x db backfill --pending --json',
    );
  }
  const shape: BackfillShape = list ? 'list' : flagBool(args, 'pending') ? 'pending' : 'pass';
  for (const [flag, owner] of Object.entries(SHAPE_OF_FLAG)) {
    if (owner === shape || !args.flags.has(flag)) continue;
    refuseShape(
      flag,
      `x db backfill --${flag} belongs to ${owner === 'pass' ? 'a <name>/--all pass' : `--${owner}`}, and this invocation asked for ${asked[0]}`,
      FIX_OF_SHAPE[owner],
    );
  }
  return target === undefined ? { shape } : { shape, name: target };
}

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
  const asked = readShape(ctx.args);
  if (asked.shape === 'list') return runBackfillList(ctx, root);
  if (asked.shape === 'pending') return runBackfillPending(ctx, root);
  return runBackfillPass(ctx, root, asked.name === undefined ? 'all' : [asked.name]);
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
