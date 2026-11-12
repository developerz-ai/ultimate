// Entity conformance · the page BYTE bound: a page whose raw cells weigh past `MAX_PAGE_BYTES` is
// refused with `X_ENTITY_PAGE_TOO_LARGE` before it is decoded, naming the two ways out — and both
// ways out, a narrower `select()` and a smaller `limit()`, answer. Every driver, one bound.

import { expect } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { entity, MAX_PAGE_BYTES, text, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, idAt } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const heavy = remember(
  entity('ec_pb_heavy', {
    columns: { id: uuid().primaryKey(), label: text({ max: 20 }), body: text() },
  }),
);

/** Five bodies, each just over a fifth of the bound: the whole table is past it, four are not. */
const ROWS = 5;
const BODY = 'x'.repeat(Math.floor(MAX_PAGE_BYTES / ROWS) + 1024);

/** The refusal's code and fix, or what the read answered when nothing was refused. */
const refusal = async (work: () => Promise<unknown>) => {
  try {
    return { answered: await work() };
  } catch (error) {
    return isUltimateError(error)
      ? { code: error.code, fix: error.fix }
      : { uncoded: String(error) };
  }
};

export const PAGE_BYTE_CHECKS: readonly EntityDriverCheck[] = [
  checkOver(
    { heavy },
    'a page past the byte bound is refused, naming select() and a limit() — and both answer',
    async (db) => {
      // One row per statement: the bound is on what a READ answers, not on what a write binds.
      for (let index = 1; index <= ROWS; index += 1) {
        await db.heavy.insert({ id: idAt(index), label: `r${index}`, body: BODY });
      }
      const refused = await refusal(() => db.heavy.all());
      expect(refused).toMatchObject({ code: 'X_ENTITY_PAGE_TOO_LARGE' });
      const fix = 'fix' in refused ? String(refused.fix) : '';
      expect([fix.includes('.select('), fix.includes('.limit(')]).toEqual([true, true]);
      const narrow = await db.heavy.orderBy('id').select({ id: true, label: true }).all();
      expect(narrow.map((row) => row.label)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
      const fewer = await db.heavy
        .orderBy('id')
        .limit(ROWS - 1)
        .all();
      expect(fewer.map((row) => [row.label, row.body.length])).toEqual(
        [1, 2, 3, 4].map((index) => [`r${index}`, BODY.length]),
      );
    },
  ),
];
