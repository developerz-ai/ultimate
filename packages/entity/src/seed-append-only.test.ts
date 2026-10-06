// `ctx.upsert()` over an `appendOnly` entity: the seed APPENDS — an empty table takes the row, a
// replay skips it, two boots racing settle on one row — and only a seed that would REWRITE a stored
// row is refused, with the append-only code. It used to be refused on every call, empty table too.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { APPEND_ONLY_CODE } from './append-only-errors';
import { integer, text, timestamp } from './columns';
import { type Driver, memoryDriver } from './database';
import { entity } from './entity';
import { clearRegistry } from './registry';
import { defineSeed } from './seed';

const rates = entity('seed_test_append_rates', {
  columns: {
    code: text({ max: 20 }),
    basisPoints: integer(),
    createdAt: timestamp().defaultNow(),
  },
  primaryKey: ['code'],
  appendOnly: true,
});

const rateSeed = (basisPoints: number) =>
  defineSeed(
    'seed_test_append_rates',
    async ({ upsert }) => {
      await upsert(rates, { by: ['code'] }, { code: 'vat', basisPoints });
    },
    { tier: 'reference' },
  );

let driver: Driver;

beforeEach(() => {
  driver = memoryDriver();
});

afterAll(() => {
  clearRegistry();
});

describe('defineSeed() · upsert on an appendOnly entity', () => {
  test('an empty table takes the row, and a replay skips it', async () => {
    expect((await rateSeed(2000).run({ driver })).metrics).toEqual({
      inserted: 1,
      updated: 0,
      skipped: 0,
    });
    expect((await rateSeed(2000).run({ driver })).metrics).toEqual({
      inserted: 0,
      updated: 0,
      skipped: 1,
    });
    expect((await driver.repo(rates).findMany({})).rows).toHaveLength(1);
  });

  test('two boots seeding at once settle on one row, neither refused', async () => {
    const [first, second] = await Promise.all([
      rateSeed(2000).run({ driver }),
      rateSeed(2000).run({ driver }),
    ]);
    const written = [first, second].map((run) => run.metrics.inserted + run.metrics.skipped);
    expect(written).toEqual([1, 1]);
    expect((await driver.repo(rates).findMany({})).rows).toHaveLength(1);
  });

  test('a seed that would rewrite a stored row is the append-only refusal, and the row stays', async () => {
    await rateSeed(2000).run({ driver });
    const refused = await rateSeed(2100)
      .run({ driver })
      .then(
        () => 'resolved',
        (caught: unknown) => (isUltimateError(caught) ? caught.code : String(caught)),
      );
    expect(refused).toBe(APPEND_ONLY_CODE);
    const [stored] = (await driver.repo(rates).findMany({})).rows;
    expect((stored as { basisPoints: number } | undefined)?.basisPoints).toBe(2000);
  });
});
