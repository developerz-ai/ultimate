// A scratch database that starts PREPARED (framework tables and migrations applied) without paying
// for the preparation twice: on the embedded engine a data-directory snapshot keyed by what
// produced it (`@ultimat3/db`'s `dataSnapshot`), on Postgres a template database of that key cloned
// with `CREATE DATABASE … TEMPLATE`. The key IS the invalidation: a new migration is a new key.

// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { DbClient } from '@ultimat3/db';
import { pgliteClient, postgresClient, raw, sql } from '@ultimat3/db';
import type { ReplayEngine } from './db-replay-engine';
import { withScratchDatabase } from './db-replay-engine';

/** What a prepared scratch is: how to prepare one, and the hash of everything that decides it. */
export interface ScratchPreparation {
  /** Hex digest of every input the preparation reads (schema DDL, migrations, extensions). */
  readonly key: string;
  readonly prepare: (client: DbClient) => Promise<void>;
}

/** Prepared states kept besides the newest: a branch switch back is a hit, and the disk bounded. */
export const PREPARED_KEEP = 2;

/** Where the embedded snapshots live: a directory of their own, under the app's state dir. */
export const preparedSnapshotDir = (stateDir: string): string => join(stateDir, 'cache', 'scratch');

/** A Postgres template's name for `key`: a prefix this module alone creates and drops. */
const TEMPLATE_PREFIX = 'x_scratch_tpl_';
export const templateNameFor = (key: string): string => `${TEMPLATE_PREFIX}${key.slice(0, 24)}`;

async function withPreparedPglite<T>(
  engine: Extract<ReplayEngine, { kind: 'embedded' }>,
  stateDir: string,
  preparation: ScratchPreparation,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = pgliteClient({
    extensions: engine.extensions,
    snapshotDir: join(stateDir, 'cache'),
    dataSnapshot: {
      dir: preparedSnapshotDir(stateDir),
      key: preparation.key,
      keep: PREPARED_KEEP,
    },
  });
  try {
    if (!(await client.restoredDataSnapshot())) {
      await preparation.prepare(client);
      // After the preparation and before any row of the caller's: what is kept is the schema.
      await client.saveDataSnapshot();
    }
    return await work(client);
  } finally {
    await client.close();
  }
}

/**
 * The template for `key` on the server, built once: into a database of its own name, renamed into
 * place only when prepared — so a run killed mid-migration leaves no template that reads as ready.
 * Older templates past `PREPARED_KEEP` are dropped. Under the template's advisory lock throughout.
 */
async function ensureTemplate(
  admin: Pick<DbClient, 'one' | 'query' | 'execute'>,
  adminUrl: string,
  preparation: ScratchPreparation,
): Promise<string> {
  const { dropSql, templateSql } = await import('@ultimat3/testing');
  const template = templateNameFor(preparation.key);
  const found = await admin.one(sql`select 1 as hit from pg_database where datname = ${template}`);
  if (found !== null) return template;
  const building = `${template}_b${String(process.pid)}`;
  await admin.execute(raw(dropSql(building)));
  await admin.execute(raw(templateSql(building)));
  const target = new URL(adminUrl);
  target.pathname = `/${building}`;
  const client = postgresClient({ url: target.toString() });
  try {
    await preparation.prepare(client);
  } finally {
    await client.close();
  }
  await admin.execute(raw(`alter database "${building}" rename to "${template}"`));
  const stale = await admin.query<{ datname: string }>(
    sql`select datname from pg_database where datname like ${`${TEMPLATE_PREFIX}%`} and datname <> ${template} order by oid desc`,
  );
  for (const { datname } of stale.slice(PREPARED_KEEP)) {
    await admin.execute(raw(dropSql(datname)));
  }
  return template;
}

async function withPreparedPostgres<T>(
  adminUrl: string,
  preparation: ScratchPreparation,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const { cloneSql, dropSql, lockSql } = await import('@ultimat3/testing');
  const database = `x_scratch_${String(process.pid)}_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgresClient({ url: adminUrl });
  try {
    const template = templateNameFor(preparation.key);
    {
      // One session for the advisory lock: it is held by a session, and a pool's next statement
      // may land on another — the unlock would miss, and the lock outlive the build.
      using session = await admin.reserve();
      await session.execute(raw(lockSql(template)));
      try {
        await ensureTemplate(session, adminUrl, preparation);
        await session.execute(raw(cloneSql(template, database)));
      } finally {
        // `lockSql`'s inverse, which the testing barrel does not export: the same `hashtext` key.
        await session.execute(raw(`select pg_advisory_unlock(hashtext('${template}'))`));
      }
    }
    const target = new URL(adminUrl);
    target.pathname = `/${database}`;
    const client = postgresClient({ url: target.toString() });
    try {
      return await work(client);
    } finally {
      await client.close();
      await admin.execute(raw(dropSql(database)));
    }
  } finally {
    await admin.close();
  }
}

/**
 * `work` on a scratch database `preparation` has been applied to — restored or cloned when its key
 * was prepared before, prepared (and kept) when not. No `stateDir`, embedded: prepared every time.
 */
export async function withPreparedScratch<T>(
  engine: ReplayEngine,
  stateDir: string | undefined,
  preparation: ScratchPreparation,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  if (engine.kind === 'postgres') return withPreparedPostgres(engine.adminUrl, preparation, work);
  if (stateDir === undefined) {
    return withScratchDatabase(engine, stateDir, async (client) => {
      await preparation.prepare(client);
      return work(client);
    });
  }
  return withPreparedPglite(engine, stateDir, preparation, work);
}
