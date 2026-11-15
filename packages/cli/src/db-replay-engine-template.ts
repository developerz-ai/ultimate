// The Postgres half of a prepared scratch database: a template per key (`CREATE DATABASE …
// TEMPLATE`), built once under that key's advisory lock — polled to a deadline, never a statement
// the pool's timeout cancels — and a working clone per run, stamped so a killed run's is reaped.

import type { DbClient } from '@ultimat3/db';
import { DbError, postgresClient, raw, sql } from '@ultimat3/db';
import { reapScratch, stampScratch } from './db-replay-scratch-reap';

/** What a prepared scratch is: how to prepare one, and the hash of everything that decides it. */
export interface ScratchPreparation {
  /** Hex digest of every input the preparation reads (schema DDL, migrations, extensions). */
  readonly key: string;
  readonly prepare: (client: DbClient) => Promise<void>;
}

/** Prepared states kept besides the newest: a branch switch back is a hit, and the disk bounded. */
export const PREPARED_KEEP = 2;

/** How long a run waits for another's build of the same key: a migration, never a seed. */
export const TEMPLATE_LOCK_WAIT_MS = 5 * 60 * 1000;
const TEMPLATE_LOCK_POLL_MS = 250;

/** A Postgres template's name for `key`: a prefix this module alone creates and drops. */
const TEMPLATE_PREFIX = 'x_scratch_tpl_';
/** Hex characters of the key a template's name carries. */
const KEY_CHARS = 24;
/** Exactly a template name, as a regular expression: never LIKE, whose `_` is any character. */
const TEMPLATE_NAME = `^${TEMPLATE_PREFIX}[0-9a-f]{${String(KEY_CHARS)}}$`;
export const templateNameFor = (key: string): string =>
  `${TEMPLATE_PREFIX}${key.slice(0, KEY_CHARS)}`;
/** Where a template is built before it is renamed into place: a name eviction never matches. */
const buildPrefixFor = (key: string): string => `x_scratch_bld_${key.slice(0, KEY_CHARS)}_`;

const lockSql = (name: string) => sql`select pg_try_advisory_lock(hashtext(${name})) as held`;
const unlockSql = (name: string) => sql`select pg_advisory_unlock(hashtext(${name}))`;

type Admin = Pick<DbClient, 'one' | 'query' | 'execute'>;

/** The key's lock, polled: a builder may hold it for a whole migration, past any statement bound. */
async function acquire(session: Admin, template: string): Promise<void> {
  const started = performance.now();
  for (;;) {
    const row = await session.one<{ held: boolean }>(lockSql(template));
    if (row?.held === true) return;
    const waited = Math.round(performance.now() - started);
    if (waited >= TEMPLATE_LOCK_WAIT_MS) {
      throw new DbError({
        code: 'X_DB_LOCK_TIMEOUT',
        cause: `another process held the build lock of scratch template ${template} for ${String(waited)} ms, so this run could not clone it`,
        fix: `psql "$TEST_DATABASE_URL" -c "select pid, query from pg_stat_activity where datname like 'x_scratch_bld_%'"   # then stop that run, or wait for it`,
        meta: { template, waitedMs: waited },
      });
    }
    await Bun.sleep(Math.min(TEMPLATE_LOCK_POLL_MS, TEMPLATE_LOCK_WAIT_MS - waited));
  }
}

/** Every template of the exact name shape past the newest kept, each only while nobody holds it. */
async function evictTemplates(admin: Admin, current: string): Promise<void> {
  const stale = await admin.query<{ datname: string }>(
    sql`select datname from pg_database where datname ~ ${TEMPLATE_NAME} and datname <> ${current} order by oid desc`,
  );
  for (const { datname } of stale.slice(PREPARED_KEEP)) {
    // A process cloning it holds its lock: skipped, never dropped under the clone.
    if ((await admin.one<{ held: boolean }>(lockSql(datname)))?.held !== true) continue;
    try {
      await admin.execute(raw(`drop database if exists "${datname}" with (force)`));
    } finally {
      await admin.execute(unlockSql(datname));
    }
  }
}

/** A killed build's databases for `key`: only the key's lock holder builds it, so any is debris. */
async function sweepBuilds(admin: Admin, key: string): Promise<void> {
  if (!/^[0-9a-f]+$/.test(key.slice(0, KEY_CHARS))) return;
  const debris = await admin.query<{ datname: string }>(
    sql`select datname from pg_database where datname ~ ${`^${buildPrefixFor(key)}[0-9]+$`}`,
  );
  for (const { datname } of debris) {
    await admin.execute(raw(`drop database if exists "${datname}" with (force)`));
  }
}

/**
 * The template for `key`, built once: into a database of its own name, renamed into place only when
 * prepared, and dropped if the preparation fails — so no build, killed or refused, reads as ready.
 * Called under the key's lock.
 */
async function ensureTemplate(
  admin: Admin,
  adminUrl: string,
  preparation: ScratchPreparation,
): Promise<string> {
  const template = templateNameFor(preparation.key);
  const found = await admin.one(sql`select 1 as hit from pg_database where datname = ${template}`);
  if (found !== null) return template;
  await sweepBuilds(admin, preparation.key);
  const building = `${buildPrefixFor(preparation.key)}${String(process.pid)}`;
  await admin.execute(raw(`create database "${building}" template template0`));
  try {
    const target = new URL(adminUrl);
    target.pathname = `/${building}`;
    // `migrate`: no statement timeout — a migration is as long as it is.
    const client = postgresClient({ url: target.toString(), role: 'migrate' });
    try {
      await preparation.prepare(client);
    } finally {
      await client.close();
    }
    await admin.execute(raw(`alter database "${building}" rename to "${template}"`));
  } catch (error) {
    await admin.execute(raw(`drop database if exists "${building}" with (force)`));
    throw error;
  }
  await evictTemplates(admin, template);
  return template;
}

/** `work` on a fresh clone of `preparation`'s template, built first when the key is new. */
export async function withPreparedPostgres<T>(
  adminUrl: string,
  preparation: ScratchPreparation,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const database = `x_scratch_${String(process.pid)}_${crypto.randomUUID().slice(0, 8)}`;
  // `migrate`: no statement timeout on the clone of a large template, nor on the build.
  const admin = postgresClient({ url: adminUrl, role: 'migrate' });
  try {
    await reapScratch(admin);
    const template = templateNameFor(preparation.key);
    {
      // One session holds the lock: a pool's next statement may land on another.
      using session = await admin.reserve();
      await acquire(session, template);
      try {
        await ensureTemplate(session, adminUrl, preparation);
        await session.execute(raw(`create database "${database}" template "${template}"`));
        await stampScratch(session, database);
      } finally {
        await session.execute(unlockSql(template));
      }
    }
    const target = new URL(adminUrl);
    target.pathname = `/${database}`;
    const client = postgresClient({ url: target.toString() });
    try {
      return await work(client);
    } finally {
      await client.close();
      await admin.execute(raw(`drop database if exists "${database}" with (force)`));
    }
  } finally {
    await admin.close();
  }
}
