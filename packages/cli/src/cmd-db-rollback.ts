// `x db rollback [--steps n]`: reverse the most recently applied migration(s) by running the
// `-- down` half each file carries, through `@ultimat3/db`'s `rollback()` — the same lock, ledger
// and per-migration transaction `x db migrate` uses. The files stay: deleting one is an edit.

import { isNonTransactional } from '@ultimat3/db';
import type { CommandContext } from './command';
import { stepFinding } from './db-finding';
import { rollbackPass } from './db-rollback-pass';
import { intFlagOr } from './flag-number';
import { msg } from './messages';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import type { CommandResult } from './output';

/** Read before anything is opened: `--steps 0` and `--steps all` never reach the ledger. */
const STEPS = {
  name: 'steps',
  command: 'db rollback',
  min: 1,
  example: 'x db rollback --steps 1',
} as const;

export async function runRollbackCommand(
  ctx: CommandContext,
  root: string,
): Promise<CommandResult> {
  const steps = intFlagOr(ctx.args, STEPS, 1);
  let reverted: readonly string[];
  try {
    reverted = await rollbackPass(root, ctx.env, steps);
  } catch (error) {
    return {
      ok: false,
      command: 'db',
      summary: msg('cli.db.rollback.failed'),
      // The engine's refusals carry their own code and fix; what is left is the step failing for a
      // reason no framework error claimed, which is `x db migrate`'s code for the same engine.
      findings: [stepFinding(error, 'X_DB_MIGRATE_FAILED')],
    };
  }
  const files = reverted.map((id) => `${MIGRATIONS_DIR}/${id}.sql`);
  // `x db gen` writes a change that needs a step outside the transaction as TWO migrations, and one
  // step back reverses only that second half: said, or the column is still there with no reason.
  const oldest = reverted.at(-1);
  const deferredHalf =
    oldest !== undefined &&
    (await readMigrations(root)).some(
      (migration) => migration.id === oldest && isNonTransactional(migration.up),
    );
  return {
    ok: true,
    command: 'db',
    summary:
      reverted.length === 0
        ? msg('cli.db.rollback.none')
        : msg('cli.db.rollback.done', { count: reverted.length, ids: reverted.join(', ') }),
    findings: [],
    // A reversed migration is PENDING again while its file is on disk: said, with both next moves.
    lines: [
      ...files.map((file) => `  ${file}`),
      ...(files.length === 0 ? [] : [msg('cli.db.rollback.kept')]),
      ...(deferredHalf ? [msg('cli.db.rollback.deferredHalf', { id: oldest })] : []),
    ],
    data: { reverted: [...reverted], steps, files },
  };
}
