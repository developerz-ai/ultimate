// `insert` judges a row against its invariants before the statement and answers
// `X_INVARIANT_VIOLATED`; `update` sends a patch, so the stored row is only known to Postgres and
// its CHECK answered `23514` — an unclassified `X_DB_STATEMENT_FAILED`, a 500. Both drivers, one
// answer: the rule's own code, its name and its message.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, statementsOf } from '@ultimat3/db';
import { integer, uuid } from './columns';
import { entity } from './entity';
import { invariant } from './invariants';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Repo } from './repo';

const ranges = entity('check_refusal_ranges', {
  columns: { id: uuid().primaryKey(), low: integer(), high: integer() },
  invariants: (c) => [invariant('low_non_negative', c.low.atLeast(0))],
});

type Range = { id: string; low: number; high: number };
const ID = '00000000-0000-7000-8000-000000000001';
const client = pgliteClient();

const refusal = async (work: () => Promise<unknown>): Promise<{ code: string; cause: string }> => {
  try {
    await work();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return { code: `not coded: ${String(error)}`, cause: '' };
  }
  return expect.unreachable('a row breaking the CHECK is refused');
};

beforeAll(async () => {
  const migration = generateMigration({
    entities: [ranges.$describe()],
    name: 'check refusal',
    now: new Date('2026-11-24T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, 30_000);

beforeEach(async () => {
  await client.execute(raw('delete from "check_refusal_ranges"'));
});

afterAll(async () => {
  await client.close();
  clearRegistry();
});

describe('a CHECK refusing an update answers as insert does', () => {
  const drivers: readonly (readonly [string, () => Repo<Range>])[] = [
    ['postgres', () => postgresRepo(ranges, { client }) as unknown as Repo<Range>],
    ['memory', () => memoryRepo(ranges) as unknown as Repo<Range>],
  ];

  test.each(drivers)('%s: update', async (_, open) => {
    const repo = open();
    await repo.insert({ id: ID, low: 1, high: 5 });
    const inserted = await refusal(() => repo.insert({ id: ID, low: -1, high: 5 }));
    const updated = await refusal(() => repo.update(ID, { low: -1 }));
    expect(updated.code).toBe('X_INVARIANT_VIOLATED');
    expect(updated).toEqual(inserted);
    expect(await repo.findById(ID)).toEqual({ id: ID, low: 1, high: 5 });
  });

  test.each(drivers)('%s: updateWhere', async (_, open) => {
    const repo = open();
    await repo.insert({ id: ID, low: 1, high: 5 });
    const refused = await refusal(() => repo.updateWhere({ id: ID }, { low: -1 }));
    expect(refused.code).toBe('X_INVARIANT_VIOLATED');
    expect(refused.cause).toContain('check_refusal_ranges.low_non_negative');
  });

  test('a CHECK no invariant declares stays the statement failure it was', async () => {
    await client.execute(
      raw(
        'alter table "check_refusal_ranges" add constraint "hand_written_check" check (high < 100)',
      ),
    );
    try {
      const repo = postgresRepo(ranges, { client }) as unknown as Repo<Range>;
      await repo.insert({ id: ID, low: 1, high: 5 });
      expect((await refusal(() => repo.update(ID, { high: 500 }))).code).toBe(
        'X_DB_STATEMENT_FAILED',
      );
    } finally {
      await client.execute(
        raw('alter table "check_refusal_ranges" drop constraint "hand_written_check"'),
      );
    }
  });
});
