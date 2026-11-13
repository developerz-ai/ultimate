// What a home tile costs: `count: true` is an exact `COUNT(*)` per visit; `count: 'estimate'` is the
// planner's figure where the row scope is the whole predicate and the table is big enough for an
// exact count to matter — and the exact count everywhere else, never a guess passed off as one.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { AdminRepo, AdminRow } from './registry';
import { adminResource } from './resource';
import { ESTIMATE_COUNT_FLOOR, resourceCounts } from './screen-home-counts';

const things = entity('home_count_things', {
  columns: { id: uuid().primaryKey(), owner: text({ max: 40 }) },
});

afterAll(clearRegistry);

interface Spy {
  readonly repo: AdminRepo<AdminRow>;
  readonly asked: string[];
}

/** A repo that answers `exact` to a `COUNT(*)` and `estimate` to the planner, and logs which. */
function spyRepo(exact: number, estimate: number | null | Error): Spy {
  const asked: string[] = [];
  const repo: AdminRepo<AdminRow> = {
    list: async () => [],
    find: async () => null,
    create: async () => expect.unreachable('no write'),
    update: async () => expect.unreachable('no write'),
    destroy: async () => expect.unreachable('no write'),
    count: async () => {
      asked.push('count');
      return exact;
    },
    approximateCount: async () => {
      asked.push('approximateCount');
      if (estimate instanceof Error) throw estimate;
      return estimate;
    },
  };
  return { repo, asked };
}

const actor = { id: 'u-1' };
const BIG = ESTIMATE_COUNT_FLOOR * 5;

describe('resourceCounts · count: estimate', () => {
  test('a big unscoped table is the planner’s figure, marked approximate, and issues no COUNT', async () => {
    const spy = spyRepo(1, BIG);
    const [tile] = await resourceCounts(
      [adminResource(things, { count: 'estimate', repo: spy.repo })],
      actor,
    );
    expect(tile?.count).toBe(BIG);
    expect(tile?.approximate).toBe(true);
    expect(spy.asked).toEqual(['approximateCount']);
  });

  test('below the floor the exact count is cheap, so it is the one shown', async () => {
    const spy = spyRepo(12, ESTIMATE_COUNT_FLOOR - 1);
    const [tile] = await resourceCounts(
      [adminResource(things, { count: 'estimate', repo: spy.repo })],
      actor,
    );
    expect(tile).toMatchObject({ count: 12, approximate: false });
    expect(spy.asked).toEqual(['approximateCount', 'count']);
  });

  test('a row scope is a predicate the planner knows nothing about: exact, never asked', async () => {
    const spy = spyRepo(7, BIG);
    const [tile] = await resourceCounts(
      [
        adminResource(things, {
          count: 'estimate',
          repo: spy.repo,
          rows: (who) => [{ field: 'owner', op: 'eq', value: who.id }],
        }),
      ],
      actor,
    );
    expect(tile).toMatchObject({ count: 7, approximate: false });
    expect(spy.asked).toEqual(['count']);
  });

  test('no estimate (never analysed) or a refused one (a tenant table) falls back to exact', async () => {
    for (const estimate of [null, new TypeError('approximateCount refused a scoped entity')]) {
      const spy = spyRepo(3, estimate);
      const [tile] = await resourceCounts(
        [adminResource(things, { count: 'estimate', repo: spy.repo })],
        actor,
      );
      expect(tile).toMatchObject({ count: 3, approximate: false });
    }
  });

  test('count: true stays the exact COUNT(*) it shipped as', async () => {
    const spy = spyRepo(4, BIG);
    const [tile] = await resourceCounts(
      [adminResource(things, { count: true, repo: spy.repo })],
      actor,
    );
    expect(tile).toMatchObject({ count: 4, approximate: false });
    expect(spy.asked).toEqual(['count']);
  });
});
