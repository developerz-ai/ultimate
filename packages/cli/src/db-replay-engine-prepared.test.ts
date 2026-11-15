// A prepared scratch database, on the embedded engine: the first run prepares and keeps it, the
// next run with the same key restores it without preparing, and a new migration — a new key —
// prepares again. The key is the invalidation; there is no TTL.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { DbClient, Migration } from '@ultimat3/db';
import { raw } from '@ultimat3/db';
import { preparedSnapshotDir, withPreparedScratch } from './db-replay-engine-prepared';
import { exerciseSchemaKey } from './exercise-database';

const stateDir = mkdtempSync(join(tmpdir(), 'x-prepared-scratch-'));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

/**
 * A nonce per load: the snapshot memo is process-wide and keyed by the schema key, so a rerun of
 * this file in one process must not find the previous load's state already kept.
 */
const nonce = crypto.randomUUID().slice(0, 8);
const migration = (id: string, up: string): Migration => ({
  id: `${id}_${nonce}`,
  name: id,
  up,
  down: '',
});
const FIRST = [migration('0001_notes', 'create table notes (id int primary key)')];
const SECOND = [...FIRST, migration('0002_tags', 'create table tags (id int primary key)')];

/** One run: how many times it prepared, and which of the two tables the work saw. */
async function run(migrations: readonly Migration[]) {
  let prepared = 0;
  const tables = await withPreparedScratch(
    { kind: 'embedded', extensions: [] },
    stateDir,
    {
      key: exerciseSchemaKey(migrations, []),
      prepare: async (client: DbClient) => {
        prepared += 1;
        for (const one of migrations) await client.execute(raw(one.up));
      },
    },
    async (client) =>
      (
        await client.query<{ name: string }>(
          raw("select tablename as name from pg_tables where schemaname = 'public' order by 1"),
        )
      ).map((row) => row.name),
  );
  return { prepared, tables };
}

describe('unit · a prepared scratch database', () => {
  test('a miss prepares and keeps the state; the same key restores it unprepared', async () => {
    expect(await run(FIRST)).toEqual({ prepared: 1, tables: ['notes'] });
    expect(await run(FIRST)).toEqual({ prepared: 0, tables: ['notes'] });
    expect(readdirSync(preparedSnapshotDir(stateDir)).length).toBe(1);
  }, 120_000);

  test('a new migration is a new key: prepared again, never the old state', async () => {
    expect(await run(SECOND)).toEqual({ prepared: 1, tables: ['notes', 'tags'] });
    expect(await run(SECOND)).toEqual({ prepared: 0, tables: ['notes', 'tags'] });
  }, 120_000);

  test('the key moves with a migration’s text, an added one and an extension', () => {
    const base = exerciseSchemaKey(FIRST, []);
    expect(exerciseSchemaKey(FIRST, [])).toBe(base);
    expect(exerciseSchemaKey(SECOND, [])).not.toBe(base);
    expect(
      exerciseSchemaKey([migration('0001_notes', 'create table notes (id bigint)')], []),
    ).not.toBe(base);
    expect(exerciseSchemaKey(FIRST, ['citext'])).not.toBe(base);
  });
});
