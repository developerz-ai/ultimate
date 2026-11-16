// `x db status`: one read of the app's database — the framework stamp and the `x_migrations`
// ledger — judged by `db-status.ts` against the migrations this build ships. No DDL, no ledger
// write, no migrate lock: `startDb`, never `startQueue` (the queue's boot applies framework
// tables). An embedded database never created is reported as such, never initialised to say so.

// why: Bun has no directory probe — `Bun.file().exists()` answers about a file.
import { existsSync } from 'node:fs';
import {
  type DbClient,
  isLedgerMissing,
  pgliteDataDir,
  ROLLBACK_ALLOW_DESTRUCTIVE_ENV,
  readLedger,
} from '@ultimat3/db';
import type { CommandContext } from './command';
import { withOpenedDb } from './db-client-displace';
import {
  type DbStatusRead,
  dbStatus,
  dbStatusFindings,
  dbStatusJson,
  dbStatusLines,
} from './db-status';
import { DevAlreadyRunningError, liveDevLock } from './dev-lock';
import { readStamp, thisBuild } from './framework-schema-apply';
import { msg } from './messages';
import { readMigrations } from './migrations';
import type { CommandResult } from './output';
import { resolveServices } from './runtime-bindings';
import { startDb } from './runtime-queue';

/** The stamp, then the ledger; a missing ledger (`42P01`) is a fact, every other failure throws. */
export async function readDbStatus(client: DbClient): Promise<DbStatusRead> {
  const stamp = await readStamp(client);
  try {
    return { stamp, ledger: await readLedger(client) };
  } catch (error) {
    if (!isLedgerMissing(error)) throw error;
    return { stamp, ledger: undefined };
  }
}

/** Opens the database the way every role does, reads once, and puts the process's `db()` back. */
async function readFromApp(ctx: CommandContext, root: string): Promise<DbStatusRead> {
  const services = resolveServices(root, ctx.env);
  if (services.db.mode === 'embedded') {
    if (!existsSync(pgliteDataDir(services.db.url))) return { stamp: null, ledger: undefined };
    // PGlite's data directory has one writer: an `x dev` holding it is refused, as diagnostics is.
    const holder = liveDevLock(services.stateDir);
    if (holder !== undefined) {
      throw new DevAlreadyRunningError({
        lock: holder,
        stateDir: services.stateDir,
        embeddedDb: true,
      });
    }
  }
  return withOpenedDb(() => startDb(services, ctx.env), readDbStatus);
}

export async function runDbStatus(ctx: CommandContext, root: string): Promise<CommandResult> {
  const migrations = await readMigrations(root);
  const read = await readFromApp(ctx, root);
  const status = dbStatus(read, migrations, thisBuild());
  const findings = dbStatusFindings(status, migrations, read.ledger, {
    allow: ctx.env[ROLLBACK_ALLOW_DESTRUCTIVE_ENV],
    appVersion: ctx.env['APP_VERSION'],
  });
  return {
    ok: findings.length === 0,
    command: 'db',
    summary:
      findings.length === 0
        ? msg('cli.db.status.current')
        : msg('cli.db.status.behind', { count: findings.length }),
    findings,
    lines: dbStatusLines(status),
    data: dbStatusJson(status),
  };
}
