// Entity conformance · the WRITE TERMINALS of the read chain: `db.x.where(…).updateAll(patch)` and
// `.deleteAll()` write exactly the rows the same chain reads — tenant-scoped as the read, soft delete
// and append-only honoured, a JS-only rule judged before anything stays, sealed values sealed, the
// change reported, history recorded — and an empty predicate is refused, never every row.

import { expect } from 'bun:test';
import type { Database } from '@ultimat3/entity';
import { history } from '@ultimat3/entity';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import {
  ledger,
  logged,
  loggedHistory,
  notes,
  posts,
  swept,
  vault,
} from './entity-conformance-write-entities';
import { accountedFor, heard } from './entity-conformance-write-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const [ONE, TWO, THREE] = [idAt('c1'), idAt('c2'), idAt('c3')];
const ORG = idAt('ca');
const OTHER_ORG = idAt('cb');
const WHEN = new Date('2020-01-02T03:04:05.000Z');
const UNFILTERED = 'X_WRITE_UNFILTERED';

const seedNotes = async (db: Database<{ notes: typeof notes }>): Promise<void> => {
  await db.notes.insertAll([
    { id: ONE, kind: 'a', title: 'one', body: 'b1', updatedAt: WHEN },
    { id: TWO, kind: 'a', title: 'two', body: 'b2', updatedAt: WHEN },
    { id: THREE, kind: 'b', title: 'three', body: 'b3', updatedAt: WHEN },
  ]);
};

const titles = async (db: Database<{ notes: typeof notes }>) =>
  (await db.notes.orderBy('id').all()).map((row) => [row.id, row.title, row.body]);

const terminals: readonly EntityDriverCheck[] = [
  checkOver(
    { notes },
    'chain updateAll writes the rows the chain reads, answers their count, keeps the rest',
    async (db) => {
      await seedNotes(db);
      expect(await db.notes.where({ kind: 'a' }).updateAll({ title: 'swept' })).toBe(2);
      expect(await titles(db)).toEqual([
        [ONE, 'swept', 'b1'],
        [TWO, 'swept', 'b2'],
        [THREE, 'three', 'b3'],
      ]);
    },
  ),
  checkOver(
    { notes },
    'chain updateAll and deleteAll over an in-list reach those ids',
    async (db) => {
      await seedNotes(db);
      expect(await db.notes.andWhere('id', 'in', [ONE, THREE]).updateAll({ body: null })).toBe(2);
      expect(await titles(db)).toEqual([
        [ONE, 'one', null],
        [TWO, 'two', 'b2'],
        [THREE, 'three', null],
      ]);
      expect(await db.notes.andWhere('id', 'in', [ONE, THREE, idAt('cf')]).deleteAll()).toBe(2);
      expect(await titles(db)).toEqual([[TWO, 'two', 'b2']]);
    },
  ),
  checkOver(
    { notes },
    'chain updateAll keeps a column the patch names as undefined, and stamps onUpdateNow',
    async (db) => {
      await seedNotes(db);
      expect(await db.notes.where({ id: ONE }).updateAll({ title: 'moved', body: undefined })).toBe(
        1,
      );
      const row = await db.notes.where({ id: ONE }).one();
      expect([row?.title, row?.body, row?.updatedAt.getTime() === WHEN.getTime()]).toEqual([
        'moved',
        'b1',
        false,
      ]);
    },
  ),
  checkOver(
    { notes },
    'an empty chain is refused, never every row; an empty patch is refused',
    async (db) => {
      await seedNotes(db);
      const refusals = await Promise.all([
        codeOf(() => db.notes.where({}).updateAll({ title: 'all' })),
        codeOf(() => db.notes.where({}).deleteAll()),
        codeOf(() => db.notes.where({ id: undefined }).deleteAll()),
        codeOf(() => db.notes.where({ kind: 'a' }).updateAll({})),
      ]);
      expect(refusals).toEqual([UNFILTERED, UNFILTERED, UNFILTERED, 'X_PATCH_EMPTY']);
      expect(await db.notes.count()).toBe(3);
      expect((await titles(db)).map(([, title]) => title)).toEqual(['one', 'two', 'three']);
    },
  ),
  checkOver(
    { notes },
    'a write chain with a page — limit() or after() — is refused; an order is not a page',
    async (db) => {
      await seedNotes(db);
      const paged = await Promise.all([
        codeOf(() => db.notes.where({ kind: 'a' }).limit(1).updateAll({ title: 'x' })),
        codeOf(() => db.notes.where({ kind: 'a' }).limit(1).deleteAll()),
        codeOf(() => db.notes.where({ kind: 'a' }).after('cursor').deleteAll()),
      ]);
      expect(paged).toEqual([
        'X_INVARIANT_VIOLATED',
        'X_INVARIANT_VIOLATED',
        'X_INVARIANT_VIOLATED',
      ]);
      expect(await db.notes.count()).toBe(3);
      expect(await db.notes.where({ kind: 'a' }).orderBy('title', 'desc').deleteAll()).toBe(2);
      expect(await db.notes.count()).toBe(1);
    },
  ),
  checkOver({ notes }, 'a chain matching no row writes nothing and answers 0', async (db) => {
    await seedNotes(db);
    expect(await db.notes.where({ kind: 'none' }).updateAll({ title: 'x' })).toBe(0);
    expect(await db.notes.where({ kind: 'none' }).deleteAll()).toBe(0);
    expect(await db.notes.count()).toBe(3);
  }),
];

const held = async (db: Database<{ posts: typeof posts }>) =>
  [
    ...(await db.posts.where({ orgId: ORG }).all()),
    ...(await db.posts.where({ orgId: OTHER_ORG }).all()),
  ]
    .map((row) => `${row.orgId === ORG ? 'ours' : 'theirs'}:${row.title}`)
    .sort();

const tenancy: readonly EntityDriverCheck[] = [
  checkOver(
    { posts },
    'chain updateAll and deleteAll reach only the actor’s tenant, as the chain’s read does',
    async (db) => {
      await db.posts.insertAll([
        { id: ONE, orgId: ORG, title: 'same' },
        { id: TWO, orgId: OTHER_ORG, title: 'same' },
      ]);
      expect(
        await inOrg(ORG, () => db.posts.where({ title: 'same' }).updateAll({ title: 'x' })),
      ).toBe(1);
      expect(await held(db)).toEqual(['ours:x', 'theirs:same']);
      expect(
        await inOrg(ORG, () => db.posts.andWhere('title', 'in', ['x', 'same']).deleteAll()),
      ).toBe(1);
      expect(await held(db)).toEqual(['theirs:same']);
    },
  ),
  checkOver(
    { posts },
    'a chain the read refuses — no request, another tenant named — refuses the write alike',
    async (db) => {
      await db.posts.insertAll([
        { id: ONE, orgId: ORG, title: 'same' },
        { id: TWO, orgId: OTHER_ORG, title: 'same' },
      ]);
      const unscoped = db.posts.where({ title: 'same' });
      const foreign = db.posts.where({ orgId: OTHER_ORG });
      const answers = [
        await codeOf(() => unscoped.all()),
        await codeOf(() => unscoped.updateAll({ title: 'x' })),
        await codeOf(() => unscoped.deleteAll()),
        await inOrg(ORG, () => codeOf(() => foreign.all())),
        await inOrg(ORG, () => codeOf(() => foreign.updateAll({ title: 'x' }))),
        await inOrg(ORG, () => codeOf(() => foreign.deleteAll())),
      ];
      expect(answers).toEqual([
        'X_TENANCY_UNSCOPED',
        'X_TENANCY_UNSCOPED',
        'X_TENANCY_UNSCOPED',
        'X_TENANCY_ACTOR_MISMATCH',
        'X_TENANCY_ACTOR_MISMATCH',
        'X_TENANCY_ACTOR_MISMATCH',
      ]);
      expect(await held(db)).toEqual(['ours:same', 'theirs:same']);
    },
  ),
  checkOver(
    { posts },
    'a chain updateAll handing rows to another tenant is refused, matched or not',
    async (db) => {
      await db.posts.insert({ id: ONE, orgId: ORG, title: 'same' });
      for (const title of ['same', 'none']) {
        const move = () => db.posts.where({ title }).updateAll({ orgId: OTHER_ORG });
        expect([title, await inOrg(ORG, () => codeOf(move))]).toEqual([
          title,
          'X_TENANCY_ACTOR_MISMATCH',
        ]);
      }
      expect(await held(db)).toEqual(['ours:same']);
    },
  ),
];

const semantics: readonly EntityDriverCheck[] = [
  checkOver(
    { swept },
    'chain deleteAll soft-deletes; chain updateAll cannot reach a soft-deleted row',
    async (db, { driver }) => {
      await db.swept.insertAll([
        { id: ONE, kind: 'k', reason: 'r', deletedAt: null },
        { id: TWO, kind: 'k', reason: 'r', deletedAt: null },
      ]);
      expect(await db.swept.where({ id: ONE }).deleteAll()).toBe(1);
      expect(await db.swept.where({ kind: 'k' }).updateAll({ reason: 'later' })).toBe(1);
      const { rows } = await driver.repo(swept).findMany({
        includeDeleted: true,
        orderBy: [{ column: 'id', direction: 'asc' }],
      });
      expect(rows.map((row) => [row.id, row.reason, row.deletedAt === null])).toEqual([
        [ONE, 'r', false],
        [TWO, 'later', true],
      ]);
    },
  ),
  checkOver(
    { swept },
    'a chain write breaking a JS-only rule on one row is refused as one; no row moves',
    async (db) => {
      await db.swept.insertAll([
        { id: ONE, kind: 'k', reason: 'fine', deletedAt: null },
        { id: TWO, kind: 'k', reason: null, deletedAt: null },
      ]);
      const stamp = () => db.swept.where({ kind: 'k' }).updateAll({ deletedAt: WHEN });
      expect(await codeOf(stamp)).toBe('X_INVARIANT_VIOLATED');
      expect(await codeOf(() => db.swept.where({ kind: 'k' }).deleteAll())).toBe(
        'X_INVARIANT_VIOLATED',
      );
      expect((await db.swept.orderBy('id').all()).map((row) => row.reason)).toEqual(['fine', null]);
    },
  ),
  checkOver(
    { ledger },
    'an append-only table refuses chain updateAll and deleteAll',
    async (db) => {
      await db.ledger.insert({ id: ONE, account: 'cash', note: 'n' });
      expect(
        await codeOf(() => db.ledger.where({ account: 'cash' }).updateAll({ note: 'x' })),
      ).toBe('X_ENTITY_APPEND_ONLY');
      expect(await codeOf(() => db.ledger.where({ account: 'cash' }).deleteAll())).toBe(
        'X_ENTITY_APPEND_ONLY',
      );
      expect((await db.ledger.all()).map((row) => row.note)).toEqual(['n']);
    },
  ),
  checkOver(
    { vault },
    'a chain updateAll seals what it writes, filters on a lookup column, refuses a sealed one',
    async (db) => {
      await db.vault.insertAll([
        { id: ONE, label: 'a', secret: null, email: 'a@example.com' },
        { id: TWO, label: 'b', secret: null, email: 'b@example.com' },
      ]);
      expect(
        await db.vault.where({ email: 'a@example.com' }).updateAll({ secret: 'hunter2' }),
      ).toBe(1);
      const [one, two] = await db.vault.orderBy('id').all();
      expect([one?.secret, two?.secret]).toEqual(['hunter2', null]);
      // `secret` is sealed and not a lookup: no predicate may name it, on a write as on a read.
      const named = db.vault.where({ secret: 'hunter2' } as never);
      expect(await codeOf(() => named.updateAll({ label: 'x' }))).toBe('X_ENTITY_SEALED_PREDICATE');
      expect(await codeOf(() => named.deleteAll())).toBe('X_ENTITY_SEALED_PREDICATE');
      expect(await db.vault.count()).toBe(2);
    },
  ),
];

const reported: readonly EntityDriverCheck[] = [
  checkOver(
    { notes },
    'a chain write is reported to the row observer as the count it wrote, never silence',
    async (db) => {
      await seedNotes(db);
      const update = await heard('ec_wr_notes', () =>
        db.notes.where({ kind: 'a' }).updateAll({ title: 'x' }),
      );
      const nothing = await heard('ec_wr_notes', () =>
        db.notes.where({ kind: 'none' }).updateAll({ title: 'x' }),
      );
      const remove = await heard('ec_wr_notes', () => db.notes.where({ kind: 'a' }).deleteAll());
      expect([update.answer, accountedFor(update.heard)]).toEqual([2, 2]);
      expect(update.heard.bulk).toEqual([{ entity: 'ec_wr_notes', op: 'update', rows: 2 }]);
      expect([nothing.answer, accountedFor(nothing.heard)]).toEqual([0, 0]);
      expect([remove.answer, accountedFor(remove.heard)]).toEqual([2, 2]);
      expect(remove.heard.bulk).toEqual([{ entity: 'ec_wr_notes', op: 'delete', rows: 2 }]);
    },
  ),
  checkOver(
    { logged, loggedHistory },
    'a chain updateAll and deleteAll each write one history version per row',
    async (db, raw) => {
      // A `defineDriver` store records no history (`EntityDriverSubject.history`): no claim to hold.
      if (!raw.history) return;
      const versions = await inOrg(ORG, async () => {
        await db.logged.insertAll([
          { id: ONE, orgId: ORG, title: 'a' },
          { id: TWO, orgId: ORG, title: 'a' },
        ]);
        await db.logged.where({ title: 'a' }).updateAll({ title: 'b' });
        await db.logged.where({ id: ONE }).deleteAll();
        return [await history(db.loggedHistory, ONE), await history(db.loggedHistory, TWO)];
      });
      const title = (image: unknown): string | null =>
        (image as { title?: string } | null)?.title ?? null;
      expect(
        versions.map((all) => all.map((v) => [v.op, title(v.before), title(v.after)])),
      ).toEqual([
        [
          ['insert', null, 'a'],
          ['update', 'a', 'b'],
          ['delete', 'b', null],
        ],
        [
          ['insert', null, 'a'],
          ['update', 'a', 'b'],
        ],
      ]);
    },
  ),
  checkOver(
    { notes },
    'a chain write inside a transaction that fails is undone with it',
    async (db, { driver }) => {
      await seedNotes(db);
      const failed = await codeOf(() =>
        driver.transactor().run(async () => {
          await db.notes.where({ kind: 'a' }).updateAll({ title: 'gone' });
          await db.notes.where({ kind: 'b' }).deleteAll();
          await db.notes.insert({ id: ONE, kind: 'dup', title: 'dup' });
        }),
      );
      expect(failed).toBe('X_DB_UNIQUE_VIOLATION');
      expect((await titles(db)).map(([, title]) => title)).toEqual(['one', 'two', 'three']);
    },
    ['transactions'],
  ),
];

export const CHAIN_WRITE_CHECKS: readonly EntityDriverCheck[] = [
  ...terminals,
  ...tenancy,
  ...semantics,
  ...reported,
];
