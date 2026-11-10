// Entity conformance · AGGREGATES: a grouped count in one meaning (scope, soft delete, a bound that
// refuses rather than truncates, a page that never narrows it), the refusals every driver shares,
// and min/max/sum answering exact values. Lifted from `entity/src/{count-by,aggregate-time,write}-parity`.

import { expect } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { decimal, entity, integer, json, money, t, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, idAt } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

/** `MAX_GROUPS` in `entity/src/count-by.ts`: a breakdown past it is refused, never cut. */
const MAX_GROUPS = 1000;

/** A `jsonb` column: refused as a group key. */
const jsonb = () => json(t.object({}));

const likes = remember(
  entity('ec_a_likes', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      postId: uuid().nullable(),
      reaction: text({ max: 20 }),
      count: integer(),
      payload: jsonb(),
      total: money(),
      createdAt: timestamp().defaultNow(),
      deletedAt: timestamp().nullable(),
    },
  }),
);
type Like = typeof likes.$row;

/** Every column a `Map` cannot be keyed by — the one shape whose refusal names no column. */
const ungroupable = remember(
  entity('ec_a_ungroupable', {
    columns: { at: timestamp().primaryKey(), payload: jsonb(), total: money() },
  }),
);

const events = remember(
  entity('ec_a_events', { columns: { id: uuid().primaryKey(), at: timestamp() } }),
);

const rates = remember(
  entity('ec_a_rates', {
    columns: { id: uuid().primaryKey(), rate: decimal({ precision: 8, scale: 2 }) },
  }),
);

const ORG = idAt('a1');
const OTHER_ORG = idAt('a2');
const [POST_A, POST_B, POST_C] = [idAt('aaa'), idAt('bbb'), idAt('ccc')];

const like = (index: number, over: Partial<Like> = {}): Like => ({
  id: idAt(String(index)),
  orgId: ORG,
  postId: POST_A,
  reaction: 'like',
  count: 1,
  payload: {},
  total: { minor: 0, currency: 'EUR' },
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  deletedAt: null,
  ...over,
});

/** Three on A, two each on B, C and none; then a stamped row and another tenant's, both on A. */
const SEED: readonly Like[] = [
  ...[POST_A, POST_A, POST_A, POST_B, POST_B, POST_C, POST_C, null, null].map((postId, index) =>
    like(index, { postId }),
  ),
  like(90, { deletedAt: new Date('2026-02-02T00:00:00.000Z') }),
  like(91, { orgId: OTHER_ORG }),
];

const NEEDS_COUNT_BY = ['aggregate:countBy'] as const;

/** What a refusal said, as `[code, cause, fix]` — or `['resolved']` when nothing was refused. */
type Said = readonly [code: string, cause?: string, fix?: string];

const refusal = async (work: () => Promise<unknown>): Promise<Said> => {
  try {
    await work();
    return ['resolved'];
  } catch (error) {
    return isUltimateError(error) ? [error.code, error.cause, error.fix] : [String(error)];
  }
};

const countBy: readonly EntityDriverCheck[] = [
  checkOver(
    { likes },
    'countBy groups the visible rows of one tenant, in value order, absent never zero',
    async (_db, { driver }) => {
      const repo = driver.repo(likes);
      await repo.insertAll(SEED);
      expect([...(await repo.countBy('postId', { orgId: ORG }))]).toEqual([
        [POST_A, 3],
        [POST_B, 2],
        [POST_C, 2],
        [null, 2],
      ]);
      expect((await repo.countBy('postId', { orgId: ORG, includeDeleted: true })).get(POST_A)).toBe(
        4,
      );
      expect([...(await repo.countBy('postId', { orgId: OTHER_ORG }))]).toEqual([[POST_A, 1]]);
      const where = [{ column: 'postId', op: 'in' as const, value: [POST_B, POST_C] }];
      expect([...(await repo.countBy('postId', { orgId: ORG, where }))]).toEqual([
        [POST_B, 2],
        [POST_C, 2],
      ]);
      const none = [{ column: 'reaction', op: 'eq' as const, value: 'nope' }];
      const empty = await repo.countBy('postId', { orgId: ORG, where: none });
      expect([[...empty], empty.get(POST_A)]).toEqual([[], undefined]);
    },
    NEEDS_COUNT_BY,
  ),
  checkOver(
    { likes },
    'a page bounds a page, never a count: limit and cursor reach no aggregate',
    async (_db, { driver }) => {
      const repo = driver.repo(likes);
      await repo.insertAll(SEED);
      const args = { orgId: ORG } as const;
      const { nextCursor } = await repo.findMany({ ...args, limit: 2 });
      expect(nextCursor).not.toBeNull();
      const paged = { ...args, limit: 2, cursor: nextCursor };
      expect([...(await repo.countBy('postId', paged))]).toEqual([
        ...(await repo.countBy('postId', args)),
      ]);
      expect(await repo.count(paged)).toBe(await repo.count(args));
    },
    NEEDS_COUNT_BY,
  ),
  checkOver(
    { likes },
    `one group past ${MAX_GROUPS} is refused, exactly ${MAX_GROUPS} resolves whole`,
    async (_db, { driver }) => {
      const repo = driver.repo(likes);
      const many = Array.from({ length: MAX_GROUPS + 1 }, (_, index) =>
        like(index, { postId: idAt(5000 + index) }),
      );
      await repo.insertAll(many.slice(0, MAX_GROUPS));
      expect((await repo.countBy('postId', { orgId: ORG })).size).toBe(MAX_GROUPS);
      await repo.insert(many[MAX_GROUPS] as Like);
      expect((await refusal(() => repo.countBy('postId', { orgId: ORG })))[0]).toBe(
        'X_INVARIANT_VIOLATED',
      );
    },
    NEEDS_COUNT_BY,
  ),
  checkOver(
    { likes, ungroupable },
    'an ungroupable column is refused before the scope, naming a column that would work',
    async (_db, { driver }) => {
      const repo = driver.repo(likes);
      const causes: readonly (readonly [string, string])[] = [
        ['secret', 'no column "secret" on ec_a_likes'],
        ['createdAt', 'a timestamptz column is not a key a map can be looked up by'],
        ['payload', 'a jsonb column is not a key a map can be looked up by'],
        ['total', 'a money column is not a key a map can be looked up by'],
      ];
      for (const [property, cause] of causes) {
        const refused = await refusal(() => repo.countBy(property, { orgId: ORG }));
        expect(refused[0]).toBe('X_INVARIANT_VIOLATED');
        expect(refused[1]).toContain(`ec_a_likes.countBy('${property}'): ${cause}`);
      }
      // No scope at all: the column is judged first, so the author is told about the column.
      const unscoped = await refusal(() => repo.countBy('createdAt'));
      expect(unscoped[2]).toBe(
        "ec_a_likes.countBy('id')   # group by one of: id, orgId, postId, reaction, count",
      );
      const nothing = await refusal(() => driver.repo(ungroupable).countBy('at'));
      expect(nothing[2]).toBe(
        'x entities show ec_a_ungroupable --json   # this entity declares no column a count can be keyed by',
      );
    },
    NEEDS_COUNT_BY,
  ),
];

const EARLIEST = new Date('0099-06-01T00:00:00.000Z');
const LATEST = new Date('2026-09-23T10:15:30.123Z');
const AT = [EARLIEST, new Date('1900-01-01T12:00:00.000Z'), LATEST];

const extremes: readonly EntityDriverCheck[] = [
  checkOver(
    { events },
    'min/max over a timestamptz answer the exact instants, year 0099 included',
    async (db) => {
      for (const [index, at] of AT.entries()) await db.events.insert({ id: idAt(index + 1), at });
      expect([await db.events.min('at'), await db.events.max('at')]).toEqual([EARLIEST, LATEST]);
    },
    ['aggregate:min', 'aggregate:max'],
  ),
  checkOver(
    { rates },
    'sum and max over a decimal answer canonical decimal text',
    async (db) => {
      await db.rates.insert({ id: idAt(1), rate: '007.5' });
      await db.rates.insert({ id: idAt(2), rate: '2.5' });
      expect([await db.rates.sum('rate'), await db.rates.max('rate')]).toEqual(['10.00', '7.50']);
    },
    ['aggregate:sum', 'aggregate:max'],
  ),
];

export const AGGREGATE_CHECKS: readonly EntityDriverCheck[] = [...countBy, ...extremes];
