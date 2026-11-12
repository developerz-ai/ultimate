// Entity conformance · FILTERED aggregates: `countBy(col, { where })` counts only the rows the filter
// passes yet keeps every group the chain matched (with 0 — what makes it no `andWhere`), and
// `aggregate({ name: measure })` answers several measures, each under its own filter, over exactly
// the rows `count()` counts: a count is 0 on nothing, a sum is null, money stays money.

import { expect } from 'bun:test';
import type { Database } from '@ultimat3/entity';
import { entity, integer, money, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const reactions = remember(
  entity('ec_m_reactions', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      postId: uuid().nullable(),
      kind: text({ max: 10 }),
      weight: integer(),
      tip: money(),
      deletedAt: timestamp().nullable(),
    },
  }),
);

const SET = { reactions };
type Db = Database<typeof SET>;
type Reaction = typeof reactions.$row;
const [ORG, OTHER_ORG] = [idAt('9a'), idAt('9b')];
const [POST_A, POST_B, POST_C] = [idAt('9aa'), idAt('9bb'), idAt('9cc')];
const eur = (minor: number) => ({ minor, currency: 'EUR' });

const reaction = (index: number, over: Partial<Reaction>): Reaction => ({
  id: idAt(9000 + index),
  orgId: ORG,
  postId: POST_A,
  kind: 'like',
  weight: 1,
  tip: eur(0),
  deletedAt: null,
  ...over,
});

/** A: like, like, love · B: like · C: love · none: love — then a deleted love and another org's. */
const SEED: readonly Reaction[] = [
  reaction(1, { weight: 2, tip: eur(100) }),
  reaction(2, { weight: 3, tip: eur(50) }),
  reaction(3, { kind: 'love', weight: 5, tip: eur(25) }),
  reaction(4, { postId: POST_B, weight: 7 }),
  reaction(5, { postId: POST_C, kind: 'love', weight: 11 }),
  reaction(6, { postId: null, kind: 'love', weight: 13 }),
  reaction(7, { kind: 'love', weight: 1000, deletedAt: new Date('2026-02-02T00:00:00.000Z') }),
  reaction(8, { kind: 'love', weight: 1000, orgId: OTHER_ORG }),
];

const seeded = async (db: Db): Promise<void> => {
  await db.reactions.insertAll(SEED);
};

const COUNT_BY = ['aggregate:countBy'] as const;

const countBy: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'countBy with a where counts the rows it passes, and keeps every matched group at 0',
    async (db) => {
      await seeded(db);
      const loves = await inOrg(ORG, () =>
        db.reactions.where({ orgId: ORG }).countBy('postId', { where: [['kind', 'eq', 'love']] }),
      );
      expect([...loves].sort(([a], [b]) => String(a).localeCompare(String(b)))).toEqual([
        [POST_A, 1],
        [POST_B, 0],
        [POST_C, 1],
        [null, 1],
      ]);
      // The chain still decides which groups exist: the filter narrows counts, never groups.
      const heavy = await inOrg(ORG, () =>
        db.reactions
          .andWhere('postId', 'in', [POST_A, POST_B])
          .countBy('postId', { where: [['weight', 'gte', 3]] }),
      );
      expect([heavy.get(POST_A), heavy.get(POST_B), heavy.has(POST_C)]).toEqual([2, 1, false]);
    },
    COUNT_BY,
  ),
  checkOver(
    SET,
    'a countBy filter naming no column of the entity is refused, never ignored',
    async (db) => {
      await seeded(db);
      const refused = await inOrg(ORG, () =>
        codeOf(() =>
          db.reactions.countBy('postId', { where: [['nope' as never, 'eq', 'x' as never]] }),
        ),
      );
      expect(refused).toBe('X_AGGREGATE_UNSUPPORTED');
    },
    COUNT_BY,
  ),
];

const measures: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'aggregate answers every measure under its own filter, over the rows count() counts',
    async (db) => {
      await seeded(db);
      const answer = await inOrg(ORG, () =>
        db.reactions.where({ orgId: ORG }).aggregate({
          all: { fn: 'count' },
          loves: { fn: 'count', where: [['kind', 'eq', 'love']] },
          weight: { fn: 'sum', column: 'weight' },
          loveWeight: { fn: 'sum', column: 'weight', where: [['kind', 'eq', 'love']] },
          heaviest: { fn: 'max', column: 'weight', where: [['kind', 'eq', 'like']] },
          tips: { fn: 'sum', column: 'tip', where: [['postId', 'eq', POST_A]] },
        }),
      );
      expect(answer).toEqual({
        all: 6,
        loves: 3,
        weight: '41',
        loveWeight: '29',
        heaviest: 7,
        tips: eur(175),
      });
      expect(await inOrg(ORG, () => db.reactions.count())).toBe(answer.all);
    },
    ['aggregate:sum', 'aggregate:max'],
  ),
  checkOver(
    SET,
    'a measure whose filter passes nothing is 0 for a count and null for the rest',
    async (db) => {
      await seeded(db);
      const none = [['kind', 'eq', 'nope']] as const;
      const answer = await inOrg(ORG, () =>
        db.reactions.aggregate({
          n: { fn: 'count', where: none },
          sum: { fn: 'sum', column: 'weight', where: none },
          avg: { fn: 'avg', column: 'weight', where: none },
          min: { fn: 'min', column: 'weight', where: none },
          tips: { fn: 'sum', column: 'tip', where: none },
        }),
      );
      expect(answer).toEqual({ n: 0, sum: null, avg: null, min: null, tips: null });
    },
    ['aggregate:sum', 'aggregate:avg', 'aggregate:min'],
  ),
  checkOver(
    SET,
    'counts alone need no aggregate capability; with no actor on a tenant table they are refused',
    async (db) => {
      await seeded(db);
      const counts = {
        n: { fn: 'count' },
        loves: { fn: 'count', where: [['kind', 'eq', 'love']] },
      } as const;
      expect(await inOrg(ORG, () => db.reactions.aggregate(counts))).toEqual({ n: 6, loves: 3 });
      expect(await codeOf(() => db.reactions.aggregate(counts))).toBe('X_TENANCY_UNSCOPED');
    },
  ),
];

export const MEASURE_CHECKS: readonly EntityDriverCheck[] = [...countBy, ...measures];
