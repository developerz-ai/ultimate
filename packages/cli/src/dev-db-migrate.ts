// `POST /_x/db/migrate|rollback|ledger`: `x db migrate`, `rollback` and `gen`'s ledger read beside
// a live `x dev`, done BY the process that holds the embedded database. PGlite takes one writer,
// so the command asks the holder instead of opening `.x/pgdata` a second time. Loopback Host and
// peer, same-origin: the `/_x/db` doors.

import { renderThrowable, UltimateError } from '@ultimat3/core';
import type { DriftDifference } from '@ultimat3/db';
import { checkDrift, migrate } from '@ultimat3/db';
import type { CatalogDescription } from '@ultimat3/db/schema-dump';
import { introspectCatalog } from '@ultimat3/db/schema-dump';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { jsonResponse } from '@ultimat3/http';
import { acceptCreatedTables } from './db-accept-created';
import { DEV_LEDGER_PATH, DEV_MIGRATE_PATH, DEV_ROLLBACK_PATH } from './db-dev-wire';
import { frameworkStorageDrift } from './db-object-drift';
import { assertSameOrigin, hostRefusal } from './dev-dashboard-guard';
import { devMigratorPass } from './dev-db-migrator-hold';
import { ledgerInDev, rollbackInDev, stepsOf } from './dev-db-rollback';
import { ledgerMoved } from './dev-db-settled';
import { readMigrations } from './migrations';
import { stopRunStartFix } from './stop-run-start';

/** The command that works when this process cannot apply: the embedded database to itself. */
const MIGRATE_ALONE_FIX = stopRunStartFix(['db', 'migrate']);

/** One applied pass as it crosses the wire: `runMigrations`' report, and the live catalog. */
export interface DevMigrateData {
  readonly applied: readonly string[];
  readonly skipped: number;
  readonly appVersion: string;
  readonly durationMs: number;
  readonly drift: readonly DriftDifference[];
  /** What `x db migrate` compares its replayed dump against, read here: only this process may. */
  readonly catalog: CatalogDescription;
  readonly storage: readonly DriftDifference[];
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `serve.ts`'s `runMigrations` over the client this process already holds: the same file list,
 * the same ledger, the same post-condition. No boot and no `stop()` — the database is `x dev`'s.
 * Where it serves as `x_app`, the whole pass is one hold of the session (`devMigratorPass`).
 */
export async function migrateInDev(root: string, env: Env): Promise<DevMigrateData> {
  const migrations = await readMigrations(root);
  return devMigratorPass(root, env, async ({ client, lock, bootstrap }) => {
    const report = await migrate({
      migrations,
      client,
      lock,
      ...(env['APP_VERSION'] === undefined ? {} : { appVersion: env['APP_VERSION'] }),
    });
    // As `runMigrations` reads them: after the migrate step, as the bootstrap user. One at a
    // time — under the hold they share one session with no turn queue between them.
    await bootstrap();
    const drift = acceptCreatedTables(await checkDrift({ migrations, client }), migrations);
    const catalog = await introspectCatalog({ client });
    const storage = await frameworkStorageDrift(client);
    return {
      applied: report.applied.map((entry) => entry.id),
      skipped: report.skipped.length,
      appVersion: report.appVersion,
      durationMs: report.durationMs,
      drift: drift.differences,
      catalog,
      storage,
    };
  });
}

/** The refusal as the command re-throws it: the code, cause and fix of whatever stopped the pass. */
function refusalOf(error: unknown): { code: string; cause: string; fix: string } {
  if (error instanceof UltimateError) {
    return { code: error.code, cause: error.cause, fix: error.fix };
  }
  return {
    code: 'X_DB_MIGRATE_FAILED',
    cause: `x dev could not apply the migrations: ${renderThrowable(error)}`,
    fix: MIGRATE_ALONE_FIX,
  };
}

export interface DevMigrateRouteInput {
  readonly root: string;
  readonly env: Env;
  /** This dev server's URL, read per request — only what a refused Host's `fix:` line names. */
  readonly devUrl: () => string;
}

/**
 * One POST per path. A failed pass answers 200 with `ok: false` and the error's own three fields,
 * never the pipeline's rendered page: the caller is a CLI that re-throws them under the same code.
 */
function door(
  input: DevMigrateRouteInput,
  path: string,
  name: string,
  run: (request: UltimateRequest) => Promise<unknown>,
): Route {
  return {
    method: 'POST',
    path,
    meta: { name, auth: 'public', tags: ['_x'] },
    handler: async (request: UltimateRequest): Promise<Response> => {
      const refused = hostRefusal(request, input.devUrl());
      if (refused !== undefined) return refused;
      assertSameOrigin(request);
      try {
        return jsonResponse({ ok: true, data: await run(request) });
      } catch (error) {
        return jsonResponse({ ok: false, error: refusalOf(error) });
      }
    },
  };
}

/**
 * A pass that moved the ledger ends in a generation (`dev-db-settled.ts`), so this process's
 * findings stop saying what the ledger said before it — in the `finally`: a pass that failed
 * halfway moved it too.
 */
export function devMigrateRoutes(input: DevMigrateRouteInput): readonly Route[] {
  const { root, env } = input;
  return [
    door(input, DEV_MIGRATE_PATH, 'dev._x.db.migrate', () =>
      migrateInDev(root, env).finally(ledgerMoved),
    ),
    door(input, DEV_ROLLBACK_PATH, 'dev._x.db.rollback', async (request) => {
      const steps = stepsOf(request.url.searchParams.get('steps'));
      return rollbackInDev(root, env, steps).finally(ledgerMoved);
    }),
    // A read, behind the same doors and the same verb: nothing under `/_x/db` answers a GET.
    door(input, DEV_LEDGER_PATH, 'dev._x.db.ledger', () => ledgerInDev()),
  ];
}
