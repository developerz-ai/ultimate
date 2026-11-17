// A live read is a window every subscriber holds and the matcher patches: without `.limit()` that
// window is the whole table, per subscriber. The docs promised `x verify` refuses one; this pins
// the refusal where the source is built, so every surface — subscribe, route, exercise — meets it.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { exerciseQuery } from './exercise';
import { toLiveQuery } from './live';
import { query, runQuery } from './query';
import { registerQuery, resetQueries } from './registry';
import { from } from './source';

afterAll(() => resetQueries());

interface Invoice {
  readonly id: string;
  readonly createdAt: number;
}

const reader = ctxOf({ actor: { ...userActor({ id: 'u1' }), permissions: ['invoice:read'] } });
const invoices: readonly Invoice[] = [
  { id: 'a', createdAt: 1 },
  { id: 'b', createdAt: 2 },
];

const defineInvoices = (live: boolean, limit?: number) =>
  query({
    input: t.object({}),
    policy: can('invoice:read'),
    live,
    sql: () => {
      const ordered = from<Invoice>('invoices', invoices).orderBy('createdAt', 'desc');
      return limit === undefined ? ordered : ordered.limit(limit);
    },
  });

const refusal = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the unbounded live read was served');
};

describe('unit · a live read is bounded by a declared limit', () => {
  beforeEach(() => resetQueries());

  test('a live read with no limit is refused at subscribe, naming the read and the fix', async () => {
    const all = registerQuery('allInvoices', defineInvoices(true));

    const error = await refusal(() => toLiveQuery(all, {}, { ctx: reader, epoch: 'b1' }));

    expect(isUltimateError(error) && error.code).toBe('X_QUERY_LIVE_UNBOUNDED');
    expect(isUltimateError(error) && error.cause).toContain('allInvoices');
    expect(isUltimateError(error) && error.fix).toContain('.limit(');
  });

  // The same declaration is read over HTTP and by `x exercise`: one rule, met on every surface.
  test('the same refusal meets a plain read of it, so the exercise step reports it', async () => {
    const all = registerQuery('allInvoices', defineInvoices(true));

    const error = await refusal(() => runQuery(all, {}, { ctx: reader }));
    expect(isUltimateError(error) && error.code).toBe('X_QUERY_LIVE_UNBOUNDED');

    const failed = await refusal(() => exerciseQuery(all, { actor: reader.actor, runs: 1 }));
    expect(isUltimateError(failed) && failed.code).toBe('X_CONTRACT_DEFECT');
    expect(isUltimateError(failed) && failed.meta?.['failure']).toMatchObject({
      code: 'X_QUERY_LIVE_UNBOUNDED',
    });
  });

  test('the same live read with a limit subscribes', async () => {
    const top = registerQuery('topInvoices', defineInvoices(true, 1));

    const live = await toLiveQuery(top, {}, { ctx: reader, epoch: 'b1' });
    expect(live.limit).toBe(1);
    expect(await live.execute()).toEqual([{ id: 'b', createdAt: 2 }]);
  });

  test('a read that is not live needs no limit', async () => {
    const all = registerQuery('allInvoices', defineInvoices(false));

    expect(await runQuery(all, {}, { ctx: reader })).toHaveLength(2);
  });
});
