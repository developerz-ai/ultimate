// An applied migration edited since, asked before `x db gen` writes anything: the command is
// `X_SCHEMA_DUMP_DRIFT`'s fix, and run over an edited migration it rewrote the dump to match the
// edit — blessing SQL no database holds. The embedded ledger is read where it can be, never dialled.

// why: Bun has no directory probe — `Bun.file().exists()` answers about a file.
import { existsSync } from 'node:fs';
import { renderThrowable } from '@ultimat3/core';
import type { Migration } from '@ultimat3/db';
import { auditLedger, isLedgerMissing, pgliteDataDir, readLedger } from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { withOpenedDb } from './db-client-displace';
import { DEV_LEDGER_PATH } from './db-dev-wire';
import { askDev, type PostJson, unreadable } from './db-migrate-through-dev';
import { liveDevLockChecked } from './dev-lock-live';
import { readMigrations } from './migrations';
import { resolveServices } from './runtime-bindings';
import { startDb } from './runtime-queue';

type Env = Readonly<Record<string, string | undefined>>;

/** One applied migration as the ledger records it: all the checksum rule reads. */
export interface AppliedRow {
  readonly id: string;
  readonly checksum: string;
}

const LEDGER = t.object({
  ledger: t.array(t.object({ id: t.string, checksum: t.string })),
});

/**
 * `auditLedger`'s checksum half over the rows this checkout still ships — a row it does not ship
 * is another refusal (a rollback, a deleted file) and not this one's. Throws `X_MIGRATION_CONFLICT`
 * with the migrator's own cause and fix, so the three places that ask cannot word it three ways.
 */
export function refuseEdited(
  applied: readonly AppliedRow[],
  migrations: readonly Migration[],
): void {
  const shipped = new Set(migrations.map((migration) => migration.id));
  auditLedger(
    applied
      .filter((row) => shipped.has(row.id))
      // The fields the audit never reads on a known row, filled so the row types.
      .map((row) => ({ ...row, name: row.id, applied_at: '', app_version: 'dev', duration_ms: 0 })),
    migrations,
    'dev',
  );
}

/** What the check found out: the rows, or why this run could not read them. */
export type AppliedRead =
  | { readonly applied: readonly AppliedRow[] }
  | { readonly skipped: string | undefined };

/**
 * The embedded database's ledger, by whoever may read it: the live `x dev` that holds the
 * directory, else this process on a read-only open (`x db status`'s). Never an external
 * `DATABASE_URL` — `x db gen` is files in, files out, and must answer the same with no server up;
 * there the migrator's own audit is the refusal. A read that fails is reported, never fatal: this
 * command is the `fix:` of five errors and cannot start needing a healthy database to run.
 */
export async function readApplied(root: string, env: Env, post?: PostJson): Promise<AppliedRead> {
  const services = resolveServices(root, env);
  if (services.db.mode !== 'embedded') return { skipped: undefined };
  if (!existsSync(pgliteDataDir(services.db.url))) return { applied: [] };
  try {
    const holder = await liveDevLockChecked(services.stateDir);
    if (holder !== undefined) {
      const applied = await askDev(
        holder,
        services.stateDir,
        {
          path: DEV_LEDGER_PATH,
          resume: ['db', 'gen'],
          read: (data) => {
            const parsed = LEDGER.safeParse(data);
            return parsed.issues === undefined
              ? { value: parsed.value.ledger }
              : unreadable(parsed.issues);
          },
        },
        post,
      );
      return { applied };
    }
    return {
      applied: await withOpenedDb(
        () => startDb(services, env, false),
        async (client) => {
          try {
            return await readLedger(client);
          } catch (error) {
            if (!isLedgerMissing(error)) throw error;
            return [];
          }
        },
      ),
    };
  } catch (error) {
    return { skipped: renderThrowable(error) };
  }
}

/** Refuse (`X_MIGRATION_CONFLICT`) or answer why nothing was compared; `undefined` is "checked". */
export async function refuseAppliedEdits(
  root: string,
  env: Env,
  post?: PostJson,
): Promise<string | undefined> {
  const migrations = await readMigrations(root);
  if (migrations.length === 0) return undefined;
  const read = await readApplied(root, env, post);
  if ('skipped' in read) return read.skipped;
  refuseEdited(read.applied, migrations);
  return undefined;
}
