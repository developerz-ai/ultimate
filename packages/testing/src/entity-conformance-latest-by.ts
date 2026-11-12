// Entity conformance · newest row per group: `latestBy(group, { order })` answers one row per group
// the chain matches — ordered by the group with `null` last, ties to the primary key, under the
// read's tenancy and soft delete, refused past its bound and beside a page — and
// `preload(rel, { perParent })` attaches each parent its newest n children, `[]` for none.

import { expect } from 'bun:test';
import type { Database } from '@ultimat3/entity';
import { entity, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const threads = remember(
  entity('ec_lb_threads', {
    columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text({ max: 20 }) },
  }),
);

const messages = remember(
  entity('ec_lb_messages', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      threadId: uuid()
        .references(() => threads.id)
        .nullable(),
      body: text({ max: 20 }),
      sentAt: timestamp(),
      deletedAt: timestamp().nullable(),
    },
  }),
);

const SET = { threads, messages };
type Db = Database<typeof SET>;
type Message = typeof messages.$row;
const [ORG, OTHER_ORG] = [idAt('e1'), idAt('e2')];
const [T1, T2, T3] = [idAt('e11'), idAt('e12'), idAt('e13')];
/** The `hasMany` from a thread to its messages: named for the entity the rows come from. */
const MESSAGES = 'ec_lb_messages';
const at = (minute: number): Date => new Date(Date.UTC(2026, 0, 1, 0, minute));

/** A message in thread one of our org; its id from its body, so every row's id is its own. */
const message = (over: Partial<Message> & Pick<Message, 'body' | 'sentAt'>): Message => ({
  id: idAt(Bun.hash(over.body).toString(16).slice(0, 12)),
  orgId: ORG,
  threadId: T1,
  deletedAt: null,
  ...over,
});

const seedThreads = (db: Db) =>
  db.threads.insertAll([
    { id: T1, orgId: ORG, title: 'one' },
    { id: T2, orgId: ORG, title: 'two' },
    { id: T3, orgId: ORG, title: 'three' },
  ]);

const bodies = (rows: readonly { readonly body: string }[]) => rows.map((row) => row.body);
const latest = (db: Db, options: { direction?: 'asc' | 'desc' } = {}) =>
  inOrg(ORG, () =>
    db.messages.where({ orgId: ORG }).latestBy('threadId', { order: 'sentAt', ...options }),
  );

const reads: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'latestBy answers the newest row of every group, ordered by the group, null last',
    async (db) => {
      await seedThreads(db);
      await db.messages.insertAll([
        message({ threadId: T2, body: 't2 old', sentAt: at(1) }),
        message({ threadId: T1, body: 't1 mid', sentAt: at(3) }),
        message({ threadId: null, body: 'loose new', sentAt: at(9) }),
        message({ threadId: T1, body: 't1 new', sentAt: at(5) }),
        message({ threadId: T2, body: 't2 new', sentAt: at(2) }),
        message({ threadId: T1, body: 't1 old', sentAt: at(0) }),
        message({ threadId: null, body: 'loose old', sentAt: at(4) }),
      ]);
      expect(bodies(await latest(db))).toEqual(['t1 new', 't2 new', 'loose new']);
      expect(bodies(await latest(db, { direction: 'asc' }))).toEqual([
        't1 old',
        't2 old',
        'loose old',
      ]);
    },
  ),
  checkOver(
    SET,
    'a tie on the order goes to the primary key, in the same direction',
    async (db) => {
      await seedThreads(db);
      // Inserted high id first, so an answer in insertion order is not mistaken for the tiebreak.
      await db.messages.insertAll([
        message({ id: idAt('e9b'), body: 'high', sentAt: at(7) }),
        message({ id: idAt('e9a'), body: 'low', sentAt: at(7) }),
      ]);
      expect([bodies(await latest(db)), bodies(await latest(db, { direction: 'asc' }))]).toEqual([
        ['high'],
        ['low'],
      ]);
    },
  ),
  checkOver(
    SET,
    'latestBy reads what the chain reads: its filter, the actor’s tenant, never a deleted row',
    async (db) => {
      await seedThreads(db);
      await db.messages.insertAll([
        message({ threadId: T1, body: 'kept', sentAt: at(1) }),
        message({ threadId: T1, body: 'deleted', sentAt: at(8), deletedAt: at(9) }),
        // Another org's: a same-tenant key cannot point it at our thread, so it waits in the null group.
        message({ threadId: null, body: 'theirs', sentAt: at(9), orgId: OTHER_ORG }),
        message({ threadId: T2, body: 't2 filtered out', sentAt: at(9) }),
        message({ threadId: T2, body: 't2', sentAt: at(2) }),
      ]);
      const rows = await inOrg(ORG, () =>
        db.messages
          .andWhere('body', 'neq', 't2 filtered out')
          .latestBy('threadId', { order: 'sentAt' }),
      );
      expect(bodies(rows)).toEqual(['kept', 't2']);
      expect(await codeOf(() => db.messages.latestBy('threadId', { order: 'sentAt' }))).toBe(
        'X_TENANCY_UNSCOPED',
      );
    },
  ),
  checkOver(
    SET,
    'latestBy beside orderBy(), limit() or after() is refused; one row per group is the shape',
    async (db) => {
      await seedThreads(db);
      await db.messages.insert(message({ body: 'only', sentAt: at(1) }));
      const chain = () => db.messages.where({ orgId: ORG });
      const refusals = await inOrg(ORG, async () => [
        await codeOf(() => chain().orderBy('sentAt').latestBy('threadId', { order: 'sentAt' })),
        await codeOf(() => chain().limit(1).latestBy('threadId', { order: 'sentAt' })),
        await codeOf(() => chain().after('cursor').latestBy('threadId', { order: 'sentAt' })),
      ]);
      expect(refusals).toEqual([
        'X_INVARIANT_VIOLATED',
        'X_INVARIANT_VIOLATED',
        'X_INVARIANT_VIOLATED',
      ]);
    },
  ),
];

/** `MAX_LATEST_GROUPS` (`countBy`'s `MAX_GROUPS`): past it refused, never cut. */
const MAX_GROUPS = 1000;

const bound: readonly EntityDriverCheck[] = [
  checkOver(
    { threads, messages },
    `latestBy over ${MAX_GROUPS} groups answers each; one more group is refused`,
    async (db) => {
      const many = Array.from({ length: MAX_GROUPS + 1 }, (_, index) => ({
        id: idAt(50_000 + index),
        orgId: ORG,
        title: `t${index}`,
      }));
      await db.threads.insertAll(many);
      await db.messages.insertAll(
        many
          .slice(0, MAX_GROUPS)
          .map((thread, index) =>
            message({ id: idAt(60_000 + index), threadId: thread.id, body: 'm', sentAt: at(1) }),
          ),
      );
      expect((await latest(db)).length).toBe(MAX_GROUPS);
      await db.messages.insert(
        message({
          id: idAt(70_000),
          threadId: many[MAX_GROUPS]?.id ?? null,
          body: 'm',
          sentAt: at(1),
        }),
      );
      expect(await codeOf(() => latest(db))).toBe('X_INVARIANT_VIOLATED');
    },
  ),
];

const perParent: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'preload perParent attaches each parent its newest n children in order, [] for none',
    async (db) => {
      await seedThreads(db);
      await db.messages.insertAll([
        message({ threadId: T1, body: 't1 a', sentAt: at(1) }),
        message({ threadId: T1, body: 't1 c', sentAt: at(3) }),
        message({ threadId: T1, body: 't1 b', sentAt: at(2) }),
        message({ threadId: T2, body: 't2 a', sentAt: at(4) }),
        message({ threadId: T1, body: 't1 deleted', sentAt: at(9), deletedAt: at(9) }),
      ]);
      const rows = await inOrg(ORG, () =>
        db.threads
          .where({ orgId: ORG })
          .orderBy('id')
          .preload(MESSAGES, { perParent: 2, order: 'sentAt' })
          .all(),
      );
      const attached = rows.map((row) =>
        bodies((row as unknown as Record<string, readonly Message[]>)[MESSAGES] ?? []),
      );
      expect(attached).toEqual([['t1 c', 't1 b'], ['t2 a'], []]);
      const oldest = await inOrg(ORG, () =>
        db.threads
          .where({ id: T1 })
          .preload(MESSAGES, { perParent: 1, order: 'sentAt', direction: 'asc' })
          .one(),
      );
      expect(
        bodies((oldest as unknown as Record<string, readonly Message[]>)[MESSAGES] ?? []),
      ).toEqual(['t1 a']);
    },
  ),
  checkOver(
    SET,
    'a perParent past a whole number from 1, on a belongsTo, or an order without it is refused',
    async (db) => {
      const threadChain = () => db.threads.where({ orgId: ORG });
      const asked = [
        ...[0, -1, 1.5, Number.NaN].map(
          (perParent) => () => threadChain().preload(MESSAGES, { perParent, order: 'sentAt' }),
        ),
        // A belongsTo attaches one row already; an order alone names no "first n".
        () => db.messages.where({ orgId: ORG }).preload('thread', { perParent: 1 }),
        () => threadChain().preload(MESSAGES, { order: 'sentAt' }),
      ];
      const answers = await Promise.all(asked.map((ask) => codeOf(ask)));
      expect(answers).toEqual(asked.map(() => 'X_INVARIANT_VIOLATED'));
      // The same chain with a whole perParent is accepted: the refusals are about the value.
      expect(await codeOf(() => threadChain().preload(MESSAGES, { perParent: 1 }))).toBe(
        'resolved',
      );
    },
  ),
];

export const LATEST_BY_CHECKS: readonly EntityDriverCheck[] = [...reads, ...bound, ...perParent];
