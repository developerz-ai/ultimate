// Single responsibility: a duplicate key refused by the memory driver is the SAME error the
// Postgres driver raises — code, SQLSTATE, constraint — so an app race handler matching on
// `sqlState(error) === '23505'` works under `x dev` and in every app test, not only in production.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  generateMigration,
  type PgliteClient,
  pgliteClient,
  raw,
  SQLSTATE,
  sqlState,
  statementsOf,
} from '@ultimat3/db';
import { text } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Repo } from './repo';

afterAll(() => {
  clearRegistry();
});

const handles = entity('uvp_handles', {
  columns: { id: text().primaryKey(), handle: text() },
  indexes: [{ on: ['handle'], unique: true }],
});

type Handle = { id: string; handle: string };

/** What a race handler reads off the refusal: everything it can branch on, nothing it renders. */
const shapeOf = async (repo: Repo<Handle>, row: Handle) => {
  const error: unknown = await repo.insert(row).then(
    () => expect.unreachable('a duplicate key is refused'),
    (refused: unknown) => refused,
  );
  const fields = error as { code?: unknown; meta?: Readonly<Record<string, unknown>> };
  return {
    code: fields.code,
    sqlState: sqlState(error),
    metaSqlState: fields.meta?.['sqlState'],
    constraint: fields.meta?.['constraint'],
  };
};

describe('a duplicate key is one error on both drivers', () => {
  let pglite: PgliteClient;

  beforeAll(async () => {
    pglite = pgliteClient();
    const migration = generateMigration({
      entities: [handles.$describe()],
      name: 'unique violation parity',
      now: new Date('2026-11-10T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await pglite.execute(raw(statement));
  }, 30_000);

  afterAll(async () => {
    await pglite.close();
  });

  test.each([
    ['the primary key', { id: 'a', handle: 'other' }],
    ['a unique index', { id: 'b', handle: 'ada' }],
  ])('%s: memory answers what Postgres answers', async (_, duplicate) => {
    const pg = postgresRepo(handles, { client: pglite }) as unknown as Repo<Handle>;
    const memory = memoryRepo(handles) as unknown as Repo<Handle>;
    await pg.insert({ id: 'a', handle: 'ada' });
    await memory.insert({ id: 'a', handle: 'ada' });
    try {
      const fromPostgres = await shapeOf(pg, duplicate);
      expect(fromPostgres.sqlState).toBe(SQLSTATE.uniqueViolation);
      expect(fromPostgres.code).toBe('X_DB_UNIQUE_VIOLATION');
      expect(await shapeOf(memory, duplicate)).toEqual(fromPostgres);
    } finally {
      await pglite.execute(raw('delete from uvp_handles'));
    }
  });
});
