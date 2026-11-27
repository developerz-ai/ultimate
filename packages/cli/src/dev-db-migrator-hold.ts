// A migrate or rollback pass inside a live `x dev` whose embedded session serves as `x_app`
// (`database.rowSecurity`): the one PGlite session is taken exclusively, becomes `x_migrator` for
// the pass, and serves as `x_app` again before any other statement runs — or never serves again.

import { logger, renderThrowable } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import {
  assertRowSecurityBinds,
  baseClient,
  DbError,
  db,
  holdMigratorRole,
  isReservable,
  raw,
  serveAsAppRole,
} from '@ultimat3/db';
import { loadAppConfig } from './app-config-load';
import { stopDevServing } from './dev-child-watch';
import { rowSecurityDeclared } from './row-security-boot';
import { resolveServices } from './runtime-bindings';
import { stopRunStartFix } from './stop-run-start';

type Env = Readonly<Record<string, string | undefined>>;

/** What a pass runs on. Every statement of the pass goes to `client`, never to the ambient one. */
export interface MigratorPass {
  readonly client: DbClient;
  /**
   * `migrate()`/`rollback()`'s `lock`. `false` under the hold: the advisory lock would reserve the
   * session a second time and wait for the turn this pass is holding, and the hold already is the
   * exclusion — PGlite has one session and one opener.
   */
  readonly lock: boolean;
  /** `reset role`: the reads `x db migrate` alone makes after its migrate step, as the bootstrap user. */
  readonly bootstrap: () => Promise<void>;
}

export interface MigratorHoldSeams {
  /** The client whose session is held. Defaults to the ambient one. */
  readonly client?: DbClient | undefined;
  /** Run once when the session could not be made `x_app` again. Defaults to `stopDevServing`. */
  readonly stopServing?: (() => void) | undefined;
}

/** After the turn that will never be released: start again, and the boot arms the roles afresh. */
const RESTART_FIX = 'x stop --json && x dev';

const roleLost = (error: unknown): DbError =>
  new DbError({
    code: 'X_DB_ROW_SECURITY_BYPASSED',
    cause: `x dev ran a migrate pass as x_migrator and could not serve as x_app again (${renderThrowable(error)}), so it stopped serving: no statement reaches the embedded session, whose role is no longer one row security binds`,
    fix: RESTART_FIX,
    sourceError: error,
  });

/**
 * Back to what the boot armed (`armRowSecurity`), judged again. `rollback` first: a pass that died
 * inside a transaction would otherwise take the `set role` below with it at that transaction's end
 * — and outside a transaction it is a warning, not an error.
 */
async function serveAgain(session: DbClient): Promise<void> {
  await session.execute(raw('rollback'));
  await session.execute(raw('reset role'));
  await serveAsAppRole(session);
  await assertRowSecurityBinds(session);
}

/**
 * `run` as `x_migrator` on the reserved session. PGlite's `reserve()` holds its turn queue, so a
 * request's statement issued meanwhile waits and then runs as `x_app`: nothing but the pass ever
 * sees the migrator or the bootstrap superuser. The turn is given back only once the session is
 * `x_app` and bound by row security again; otherwise it is kept for the life of the process —
 * every later statement waits rather than reading every tenant's rows — and `stopServing` runs.
 */
export async function withMigratorHold<T>(
  run: (pass: MigratorPass) => Promise<T>,
  seams: MigratorHoldSeams = {},
): Promise<T> {
  const client = seams.client ?? baseClient();
  if (!isReservable(client)) {
    throw new DbError({
      code: 'X_DB_ROW_SECURITY_BYPASSED',
      cause:
        'x dev serves the embedded database as x_app and its client cannot reserve the session, so a pass as x_migrator would run beside the requests it serves',
      fix: stopRunStartFix(['db', 'migrate']),
    });
  }
  const session = await client.reserve();
  let outcome: { readonly value: T } | { readonly error: unknown };
  try {
    await session.execute(raw('reset role'));
    await holdMigratorRole(session);
    const value = await run({
      client: session,
      lock: false,
      bootstrap: async () => {
        await session.execute(raw('reset role'));
      },
    });
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  try {
    await serveAgain(session);
  } catch (error) {
    // No `session.release()`: the turn is the only thing between a request and a superuser.
    const lost = roleLost(error);
    logger.error(lost.code, { code: lost.code, cause: lost.cause, fix: lost.fix });
    (seams.stopServing ?? (() => stopDevServing('row-security-lost')))();
    throw lost;
  }
  session.release();
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

/**
 * A pass run by this `x dev`. Held only where the roles are ours and the session is one — the
 * embedded database with `database.rowSecurity`. Anywhere else it is the ambient client under the
 * migrate lock: an external database's migrator is whoever `DATABASE_URL` connects as.
 */
export async function devMigratorPass<T>(
  root: string,
  env: Env,
  run: (pass: MigratorPass) => Promise<T>,
): Promise<T> {
  const embedded = resolveServices(root, env).db.mode === 'embedded';
  if (embedded && rowSecurityDeclared(await loadAppConfig(root))) return withMigratorHold(run);
  return run({ client: db(), lock: true, bootstrap: async () => undefined });
}
