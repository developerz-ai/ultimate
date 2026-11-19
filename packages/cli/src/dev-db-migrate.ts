// `POST /_x/db/migrate`: `x db migrate` beside a live `x dev`, applied BY the process that holds
// the embedded database. PGlite takes one writer, so the command asks the holder instead of
// opening `.x/pgdata` a second time. Loopback Host and peer, same-origin: the `/_x/db` doors.

import { NotImplementedError, renderThrowable, UltimateError } from '@ultimat3/core';
import type { DriftDifference } from '@ultimat3/db';
import { checkDrift, db, migrate } from '@ultimat3/db';
import type { CatalogDescription } from '@ultimat3/db/schema-dump';
import { introspectCatalog } from '@ultimat3/db/schema-dump';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { jsonResponse } from '@ultimat3/http';
import { loadAppConfig } from './app-config-load';
import { acceptCreatedTables } from './db-accept-created';
import { frameworkStorageDrift } from './db-object-drift';
import { assertSameOrigin, hostRefusal } from './dev-dashboard-guard';
import { readMigrations } from './migrations';
import { rowSecurityDeclared } from './row-security-boot';

/** The path `db-migrate-through-dev.ts` posts to, under the dashboard's own `/_x/db`. */
export const DEV_MIGRATE_PATH = '/_x/db/migrate';

/** The command that works when this process cannot apply: the embedded database to itself. */
export const MIGRATE_ALONE_FIX = 'x stop --json && x db migrate && x dev';

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
 * With `database.rowSecurity`, this process serves as `x_app` and a migration must run as
 * `x_migrator` from the bootstrap session — one embedded session cannot be both while it serves.
 */
export async function devCanMigrate(root: string): Promise<boolean> {
  return !rowSecurityDeclared(await loadAppConfig(root));
}

/**
 * `serve.ts`'s `runMigrations` over the client this process already holds: the same file list,
 * the same ledger, the same post-condition. No boot and no `stop()` — the database is `x dev`'s.
 */
export async function migrateInDev(root: string, env: Env): Promise<DevMigrateData> {
  if (!(await devCanMigrate(root))) {
    throw new NotImplementedError({
      cause:
        'this x dev serves the embedded database as x_app (database.rowSecurity), and migrations run as x_migrator — one embedded session cannot hold both',
      fix: MIGRATE_ALONE_FIX,
    });
  }
  const migrations = await readMigrations(root);
  const report = await migrate({
    migrations,
    ...(env['APP_VERSION'] === undefined ? {} : { appVersion: env['APP_VERSION'] }),
  });
  const drift = acceptCreatedTables(await checkDrift({ migrations }), migrations);
  const client = db();
  const [catalog, storage] = await Promise.all([
    introspectCatalog({ client }),
    frameworkStorageDrift(client),
  ]);
  return {
    applied: report.applied.map((entry) => entry.id),
    skipped: report.skipped.length,
    appVersion: report.appVersion,
    durationMs: report.durationMs,
    drift: drift.differences,
    catalog,
    storage,
  };
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
 * One POST. A failed pass answers 200 with `ok: false` and the error's own three fields, never the
 * pipeline's rendered page: the caller is a CLI that re-throws them under the same code.
 */
export function devMigrateRoutes(input: DevMigrateRouteInput): readonly Route[] {
  return [
    {
      method: 'POST',
      path: DEV_MIGRATE_PATH,
      meta: { name: 'dev._x.db.migrate', auth: 'public', tags: ['_x'] },
      handler: async (request: UltimateRequest): Promise<Response> => {
        const refused = hostRefusal(request, input.devUrl());
        if (refused !== undefined) return refused;
        assertSameOrigin(request);
        try {
          return jsonResponse({ ok: true, data: await migrateInDev(input.root, input.env) });
        } catch (error) {
          return jsonResponse({ ok: false, error: refusalOf(error) });
        }
      },
    },
  ];
}
