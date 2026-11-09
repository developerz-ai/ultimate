// `FindManyArgs.select` projects in both drivers: Postgres returns the asked columns, the primary
// key and the sort keys (`pg-sql.ts` `projection`); memory returned the whole row, so a raw `Repo`
// caller passed a test reading a column production never sent.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import type { Repo } from './repo';

const PGLITE_BOOT_MS = 30_000;

const notes = entity('sp_notes', {
  columns: { id: uuid().primaryKey(), title: text(), body: text(), rank: integer() },
});
type Note = typeof notes.$row;
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [notes.$describe()],
    name: 'select parity',
    now: new Date('2026-11-09T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  await client.execute(raw('delete from "sp_notes"'));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

const idAt = (n: number): string => `00000000-0000-7000-8000-00000000000${n}`;

/** One body against both repositories, seeded alike; memory's answer first. */
const both = async <T>(body: (repo: Repo<Note>) => Promise<T>): Promise<readonly [T, T]> => {
  const run = async (repo: Repo<Note>): Promise<T> => {
    for (const n of [1, 2, 3]) {
      await repo.insert({ id: idAt(n), title: `t${n}`, body: `b${n}`, rank: 4 - n });
    }
    return body(repo);
  };
  return [await run(memoryDriver().repo(notes)), await run(postgresDriver().repo(notes))];
};

describe('select projects the row in both drivers', () => {
  test('the asked columns and the primary key, nothing else', async () => {
    const [memory, pg] = await both(
      async (repo) => (await repo.findMany({ select: ['title'] })).rows,
    );
    expect(pg.map((row) => Object.keys(row).sort())).toEqual([
      ['id', 'title'],
      ['id', 'title'],
      ['id', 'title'],
    ]);
    expect(memory).toEqual(pg);
  });

  test('a sort key rides along, so the page can mint its cursor', async () => {
    const [memory, pg] = await both(async (repo) => {
      const first = await repo.findMany({
        select: ['title'],
        orderBy: [{ column: 'rank', direction: 'asc' }],
        limit: 2,
      });
      const next = await repo.findMany({
        select: ['title'],
        orderBy: [{ column: 'rank', direction: 'asc' }],
        limit: 2,
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      });
      return [...first.rows, ...next.rows];
    });
    expect(pg.map((row) => row.title)).toEqual(['t3', 't2', 't1']);
    expect(Object.keys(pg[0] ?? {}).sort()).toEqual(['id', 'rank', 'title']);
    expect(memory).toEqual(pg);
  });
});
