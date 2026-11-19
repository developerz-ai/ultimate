// One `x db migrate` pass and who applies it: this process through `serve.ts`'s `runMigrations`,
// or — beside a live `x dev` holding the embedded database — that process, asked over `/_x`.
// PGlite takes no lock of its own: a second opener's tables are gone at the holder's next write.

import type { DriftDifference, DriftReport } from '@ultimat3/db';
import type { CatalogDescription } from '@ultimat3/db/schema-dump';
import { unexpectedObjects } from '@ultimat3/db/schema-dump';
import { migrateThroughDev } from './db-migrate-through-dev';
import { liveObjectDrift } from './db-object-drift';
import { liveDevLockChecked } from './dev-lock-live';
import { resolveServices } from './runtime-bindings';
import { runMigrations } from './serve';

type Env = Readonly<Record<string, string | undefined>>;

export interface MigratePass {
  readonly applied: readonly string[];
  readonly skipped: number;
  readonly appVersion: string;
  readonly durationMs: number;
  /** The live schema against the ledger, after the apply. */
  readonly drift: DriftReport;
  /** What the live database holds that `expected` (the replayed migrations) does not create. */
  objects(expected: CatalogDescription): Promise<readonly DriftDifference[]>;
}

export async function migratePass(root: string, env: Env): Promise<MigratePass> {
  const services = resolveServices(root, env);
  const holder =
    services.db.mode === 'embedded' ? await liveDevLockChecked(services.stateDir) : undefined;
  if (holder !== undefined) {
    const { drift, catalog, storage, ...report } = await migrateThroughDev(
      holder,
      services.stateDir,
    );
    return {
      ...report,
      drift: { ok: drift.length === 0, differences: drift },
      objects: async (expected) => [...unexpectedObjects(catalog, expected), ...storage],
    };
  }
  const { report, drift } = await runMigrations({ root, env });
  return {
    applied: report.applied.map((entry) => entry.id),
    skipped: report.skipped.length,
    appVersion: report.appVersion,
    durationMs: report.durationMs,
    drift,
    objects: (expected) => liveObjectDrift(root, env, expected),
  };
}
