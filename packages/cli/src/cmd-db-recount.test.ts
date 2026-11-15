// `x db recount`'s sweep on embedded Postgres: the parent is walked in key-range windows, one
// transaction each, the dry run reports every drifted row without writing, and `--write` repairs
// them all — whatever the batch size.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { CounterDescriptionLike } from '@ultimat3/db';
import { pgliteClient, raw } from '@ultimat3/db';
import { recountInBatches } from './cmd-db-recount';

const PGLITE_BOOT_MS = 30_000;
const client = pgliteClient();
const counter: CounterDescriptionLike = {
  column: 'n',
  key: 'id',
  table: 'rc_children',
  references: 'parent_id',
  softDelete: null,
  where: { sql: `c."kind" = 'up'`, columns: ['kind'] },
};

const stored = async (): Promise<number[]> =>
  (await client.query<{ n: number }>(raw('select n from rc_parents order by id'))).map(
    (row) => row.n,
  );

beforeAll(async () => {
  await client.execute(raw('create table rc_parents (id integer primary key, n integer not null)'));
  await client.execute(
    raw('create table rc_children (id serial primary key, parent_id integer, kind text)'),
  );
  // Five parents, every stored count wrong; parent 3 is already true at 0.
  await client.execute(raw('insert into rc_parents values (1, 9), (2, 9), (3, 0), (4, 9), (5, 9)'));
  await client.execute(
    raw(
      `insert into rc_children (parent_id, kind) values (1, 'up'), (1, 'up'), (2, 'down'), (4, 'up'), (5, null)`,
    ),
  );
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

describe('x db recount · key-range batches', () => {
  test('the dry run reports every drifted row, batch by batch, and writes nothing', async () => {
    const report = await recountInBatches(client, 'rc_parents', counter, {
      write: false,
      batch: 2,
    });
    expect(report.batches).toBe(3);
    expect(report.drifted).toBe(4);
    expect(report.rows).toEqual([
      { key: '1', stored: 9, actual: 2 },
      { key: '2', stored: 9, actual: 0 },
      { key: '4', stored: 9, actual: 1 },
      { key: '5', stored: 9, actual: 0 },
    ]);
    expect(await stored()).toEqual([9, 9, 0, 9, 9]);
  });

  test('--write repairs every window, one transaction per batch', async () => {
    const report = await recountInBatches(client, 'rc_parents', counter, { write: true, batch: 2 });
    expect(report.batches).toBe(3);
    expect(report.drifted).toBe(4);
    expect(await stored()).toEqual([2, 0, 0, 1, 0]);
    const again = await recountInBatches(client, 'rc_parents', counter, { write: false, batch: 2 });
    expect(again.drifted).toBe(0);
  });

  test('a batch that is no whole number of at least 1 is refused before any statement', async () => {
    for (const batch of [0, 2.5, Number.NaN]) {
      const refused = await recountInBatches(client, 'rc_parents', counter, {
        write: true,
        batch,
      }).then(
        () => 'accepted',
        (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
      );
      expect(refused).toBe('X_INVARIANT');
    }
  });
});
