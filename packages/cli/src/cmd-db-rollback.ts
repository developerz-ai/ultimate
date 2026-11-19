// `x db rollback [--steps n]`: reverse the most recently applied migration(s) by running the
// `-- down` half each file carries, through `@ultimat3/db`'s `rollback()` — the same lock, ledger
// and per-migration transaction `x db migrate` uses. The files stay: deleting one is an edit.

import { isNonTransactional, type Migration } from '@ultimat3/db';
import type { CommandContext } from './command';
import { ROLLBACK_STEPS } from './db-dev-wire';
import { stepFinding } from './db-finding';
import { rollbackPass } from './db-rollback-pass';
import { intFlagOr } from './flag-number';
import { msg } from './messages';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import type { CommandResult } from './output';

export async function runRollbackCommand(
  ctx: CommandContext,
  root: string,
): Promise<CommandResult> {
  // Read before anything is opened: `--steps 0` and `--steps all` never reach the ledger.
  const steps = intFlagOr(ctx.args, ROLLBACK_STEPS, 1);
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
  const base = reverted.length === 0 ? undefined : pairedBase(reverted, await readMigrations(root));
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
      ...(base === undefined
        ? []
        : [msg('cli.db.rollback.deferredHalf', { id: `${base}${FOLLOW_UP}`, base })]),
    ],
    data: { reverted: [...reverted], steps, files },
  };
}

/** The suffix `x db gen` gives the second step of a pair (`@ultimat3/db`'s `assembleSteps`). */
const FOLLOW_UP = '_concurrently';

/**
 * The still-applied first half, when the oldest reversed id is the `<id>_concurrently` step one
 * `x db gen` wrote beside `<id>`. Any other non-transactional migration — a diff that only builds
 * or drops indexes is ONE such file under the plain id — is whole: no second step back is owed.
 */
export function pairedBase(
  reverted: readonly string[],
  migrations: readonly Migration[],
): string | undefined {
  const oldest = reverted.at(-1);
  if (oldest === undefined || !oldest.endsWith(FOLLOW_UP)) return undefined;
  const base = oldest.slice(0, -FOLLOW_UP.length);
  if (reverted.includes(base)) return undefined;
  const half = migrations.find((migration) => migration.id === oldest);
  if (half === undefined || !isNonTransactional(half.up)) return undefined;
  return migrations.some((migration) => migration.id === base) ? base : undefined;
}
