// A LIVE read ordered by a declared text column is WARNED at subscribe time in development and test
// (`X_LIVE_ORDER_COLLATION` on a `log.record`), once per query, and never refused: the refusal is a
// break and waits for `next`. A `collate('C')` column, a non-text key and an undeclared relation
// (no kind to know) are left alone, and staging and production say nothing.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { InstrumentEventMap } from '@ultimat3/core';
import { ctxOf, resetInstrumentation, subscribe, userActor } from '@ultimat3/core';
import { clearRegistry, entity, enumerated, integer, text, url, uuid } from '@ultimat3/entity';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toLiveQuery } from './live';
import { LIVE_ORDER_COLLATION, reportLiveOrderCollation } from './live-collation';
import { query } from './query';
import { registerQuery, resetQueries } from './registry';
import type { QueryShape } from './shape';
import { from } from './source';

const TABLE = 'query_live_collation';
const DEV = { ULTIMATE_ENV: 'development' } as const;

interface Member {
  readonly id: string;
  readonly name: string;
  readonly handle: string;
  readonly rank: number;
}

const shapeOrderedBy = (relation: string, column: string): QueryShape => ({
  entity: relation,
  filters: [],
  orderBy: [{ column, direction: 'asc' }],
  limit: 20,
  unsupported: [],
});

type LogRecordEvent = InstrumentEventMap['log.record'];

const heard = (): LogRecordEvent[] => {
  const seen: LogRecordEvent[] = [];
  subscribe('log.record', ({ payload }) => {
    if (payload.message === LIVE_ORDER_COLLATION) seen.push(payload);
  });
  return seen;
};

beforeAll(() => {
  entity(TABLE, {
    columns: {
      id: uuid().primaryKey(),
      name: text({ max: 40 }),
      handle: text({ max: 40 }).collate('C'),
      rank: integer(),
      status: enumerated(['active', 'away']),
      site: url(),
    },
  });
});

afterEach(() => resetInstrumentation());

afterAll(() => {
  clearRegistry();
});

describe('reportLiveOrderCollation', () => {
  test('a declared text order key warns once, with the code, the column and both ways out', () => {
    const seen = heard();
    const target = {};
    reportLiveOrderCollation(target, 'members', shapeOrderedBy(TABLE, 'name'), DEV);
    reportLiveOrderCollation(target, 'members', shapeOrderedBy(TABLE, 'name'), DEV);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.level).toBe('warn');
    expect(seen[0]?.fields).toMatchObject({
      code: 'X_LIVE_ORDER_COLLATION',
      query: 'members',
      column: 'name',
    });
    expect(String(seen[0]?.fields['fix'])).toContain(".collate('C')");
    expect(String(seen[0]?.fields['fix'])).toContain('x db gen');
  });

  // `enumerated()`, `url()`, `tz()` and `locale()` are text in Postgres but have no `.collate()`:
  // the only way out the fix may print for them is a different order key.
  test.each([
    ['enumerated()', 'status'],
    ['url()', 'site'],
  ] as const)('a %s order key warns, and its fix offers only a non-text key', (_kind, column) => {
    const seen = heard();
    reportLiveOrderCollation({}, 'members', shapeOrderedBy(TABLE, column), DEV);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.fields).toMatchObject({ code: 'X_LIVE_ORDER_COLLATION', column });
    const fix = String(seen[0]?.fields['fix']);
    expect(fix).not.toContain('collate');
    expect(fix).not.toContain('x db gen');
    expect(fix).toContain(".orderBy('createdAt', 'desc').orderBy('id')");
  });

  test('test warns as development does, and each definition warns for itself', () => {
    const seen = heard();
    reportLiveOrderCollation({}, 'a', shapeOrderedBy(TABLE, 'name'), { ULTIMATE_ENV: 'test' });
    reportLiveOrderCollation({}, 'b', shapeOrderedBy(TABLE, 'name'), { ULTIMATE_ENV: 'test' });
    expect(seen).toHaveLength(2);
  });

  test.each([
    ['a collate("C") text key', TABLE, 'handle', 'development'],
    ['a non-text key', TABLE, 'rank', 'development'],
    ['a relation no entity declares', 'unknown_report', 'name', 'development'],
    ['a prototype key', TABLE, 'constructor', 'development'],
    ['staging', TABLE, 'name', 'staging'],
    ['production', TABLE, 'name', 'production'],
  ] as const)('silent: %s', (_why, relation, column, environment) => {
    const seen = heard();
    reportLiveOrderCollation({}, 'members', shapeOrderedBy(relation, column), {
      ULTIMATE_ENV: environment,
    });
    expect(seen).toHaveLength(0);
  });
});

describe('toLiveQuery warns at subscribe time and still subscribes', () => {
  beforeEach(() => {
    resetQueries();
  });

  const byName = () =>
    registerQuery(
      'liveMembersByName',
      query({
        input: t.object({}),
        policy: allow(),
        live: true,
        sql: () => from<Member>(TABLE, []).orderBy('name').limit(20),
      }),
    );

  test('a live read ordered by name subscribes, and warns once across two subscribes', async () => {
    const seen = heard();
    const ctx = ctxOf({ actor: userActor({ id: 'u1' }) });
    const target = byName();
    const live = await toLiveQuery(target, {}, { ctx, epoch: 'build-1' });
    await toLiveQuery(target, {}, { ctx, epoch: 'build-1' });
    expect(live.name).toBe('liveMembersByName');
    expect(seen).toHaveLength(1);
  });
});
