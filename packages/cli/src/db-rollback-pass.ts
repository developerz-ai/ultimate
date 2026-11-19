// One `x db rollback` pass and who runs it: this process, on the boot `x db migrate` uses, or —
// beside a live `x dev` holding the embedded database — that process, asked over `/_x`
// (`dev-db-rollback.ts`). The rule `db-migrate-pass.ts` states: PGlite takes one opener.

import { rollback } from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { DEV_ROLLBACK_PATH } from './db-dev-wire';
import { askDev, type PostJson, unreadable } from './db-migrate-through-dev';
import { rollbackConfirm, withoutDown } from './db-rollback-consent';
import { liveDevLockChecked } from './dev-lock-live';
import { readMigrations } from './migrations';
import { resolveServices } from './runtime-bindings';
import { startQueue } from './runtime-queue';

type Env = Readonly<Record<string, string | undefined>>;

const REVERTED = t.object({ reverted: t.array(t.string) });

/**
 * `rollback()` over the ambient client, with this command's two questions asked under the lock.
 * Shared by the command and the dev route, so the holder cannot reverse what the command refuses.
 */
export async function reverseApplied(
  root: string,
  env: Env,
  steps: number,
): Promise<readonly string[]> {
  const migrations = await readMigrations(root);
  // The binding, so a database on another machine needs the names whatever the environment says.
  const database = resolveServices(root, env).db;
  const confirm = rollbackConfirm(await withoutDown(root, migrations), env, steps, database);
  return rollback({ migrations, steps, confirm });
}

/** The ids reversed, most recently applied first. */
export async function rollbackPass(
  root: string,
  env: Env,
  steps: number,
  post?: PostJson,
): Promise<readonly string[]> {
  const services = resolveServices(root, env);
  const holder =
    services.db.mode === 'embedded' ? await liveDevLockChecked(services.stateDir) : undefined;
  if (holder !== undefined) {
    return askDev(
      holder,
      services.stateDir,
      {
        path: `${DEV_ROLLBACK_PATH}?steps=${String(steps)}`,
        resume: ['db', 'rollback', '--steps', String(steps)],
        // Not idempotent: a lost answer is read off the ledger, never asked again.
        settle: ['db', 'status'],
        read: (data) => {
          const parsed = REVERTED.safeParse(data);
          return parsed.issues === undefined
            ? { value: parsed.value.reverted }
            : unreadable(parsed.issues);
        },
      },
      post,
    );
  }
  // `runMigrations`' boot (`serve.ts`), for its reasons: the step that takes the migrate lock needs
  // a session, and on PGlite with `database.rowSecurity` the DDL runs as `x_migrator`.
  const queue = await startQueue(services, undefined, env, 'apply');
  try {
    const release =
      services.db.mode === 'embedded'
        ? await (await import('./row-security-boot')).migrateAsMigrator(root)
        : undefined;
    return await reverseApplied(root, env, steps).finally(() => release?.());
  } finally {
    await queue.stop();
  }
}
