// Entity conformance · `updateMany([{ id, patch }])`: each row its own patch in one write, the count
// of rows it reached, all or nothing — tenant-scoped, soft-deleted rows unreachable, a JS-only rule
// judged on every row, an uneven batch refused, sealed values sealed, the change reported and one
// history version per row. Past the bind ceiling it is still one write.

import { expect } from 'bun:test';
import type { Database } from '@ultimat3/entity';
import { entity, history, text } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
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

/**
 * Six hundred patched columns and a unique: 602 binds a row, so 200 rows are two statements. Wide
 * rather than long: a `defineDriver` store sends one `update` per row, and a long batch is n² there.
 */
const BROAD_COLUMNS = Array.from({ length: 600 }, (_, index) => `c${index}`);
const broad = remember(
  entity('ec_um_broad', {
    columns: {
      id: text({ max: 20 }).primaryKey(),
      u: text({ max: 20 }).unique(),
      ...Object.fromEntries(BROAD_COLUMNS.map((name) => [name, text({ max: 20 })])),
    },
  }),
);

const uniques = remember(
  entity('ec_um_uniques', {
    columns: { id: text({ max: 20 }).primaryKey(), slug: text({ max: 20 }).unique() },
  }),
);

const [ONE, TWO, THREE] = [idAt('d1'), idAt('d2'), idAt('d3')];
const ORG = idAt('da');
const OTHER_ORG = idAt('db');
const WHEN = new Date('2020-01-02T03:04:05.000Z');
/** Past 65,535 binds at 602 per row (key, `u`, six hundred columns): no one statement carries it. */
const PAST_CEILING = 200;

const broadRow = (id: string, value: string): Readonly<Record<string, string>> => ({
  id,
  u: id,
  ...Object.fromEntries(BROAD_COLUMNS.map((name) => [name, value])),
});
const broadPatch = (u: string, value: string): Readonly<Record<string, string>> => ({
  u,
  ...Object.fromEntries(BROAD_COLUMNS.map((name) => [name, value])),
});

const seedNotes = async (db: Database<{ notes: typeof notes }>): Promise<void> => {
  await db.notes.insertAll([
    { id: ONE, kind: 'a', title: 'one', body: 'b1', updatedAt: WHEN },
    { id: TWO, kind: 'a', title: 'two', body: 'b2', updatedAt: WHEN },
    { id: THREE, kind: 'b', title: 'three', body: 'b3', updatedAt: WHEN },
  ]);
};

const shape = async (db: Database<{ notes: typeof notes }>) =>
  (await db.notes.orderBy('id').all()).map((row) => [row.id, row.title, row.body]);

const writes: readonly EntityDriverCheck[] = [
  checkOver(
    { notes },
    'updateMany writes each row its own patch, answers the count, keeps the rest',
    async (db) => {
      await seedNotes(db);
      const written = await db.notes.updateMany([
        { id: ONE, patch: { title: 'first', body: null } },
        { id: THREE, patch: { title: 'third', body: 'x' } },
      ]);
      expect(written).toBe(2);
      expect(await shape(db)).toEqual([
        [ONE, 'first', null],
        [TWO, 'two', 'b2'],
        [THREE, 'third', 'x'],
      ]);
    },
  ),
  checkOver(
    { notes },
    'updateMany counts only rows it reached; an empty batch writes nothing and answers 0',
    async (db) => {
      await seedNotes(db);
      expect(
        await db.notes.updateMany([
          { id: ONE, patch: { title: 'first' } },
          { id: idAt('dff'), patch: { title: 'ghost' } },
        ]),
      ).toBe(1);
      expect(await db.notes.updateMany([])).toBe(0);
      expect(await db.notes.count()).toBe(3);
      expect((await shape(db)).map(([, title]) => title)).toEqual(['first', 'two', 'three']);
    },
  ),
  checkOver(
    { notes },
    'updateMany keeps a column a patch names as undefined, and stamps onUpdateNow',
    async (db) => {
      await seedNotes(db);
      await db.notes.updateMany([
        { id: ONE, patch: { title: 'first', body: undefined } },
        { id: TWO, patch: { title: 'second' } },
      ]);
      const rows = await db.notes.orderBy('id').all();
      expect(
        rows.map((row) => [row.title, row.body, row.updatedAt.getTime() === WHEN.getTime()]),
      ).toEqual([
        ['first', 'b1', false],
        ['second', 'b2', false],
        ['three', 'b3', true],
      ]);
    },
  ),
  checkOver(
    { notes },
    'an uneven batch, a repeated id or an empty patch is refused and writes nothing',
    async (db) => {
      await seedNotes(db);
      const uneven = () =>
        db.notes.updateMany([
          { id: ONE, patch: { title: 'first' } },
          { id: TWO, patch: { body: 'other' } },
        ]);
      expect(await codeOf(uneven)).toBe('X_INVARIANT_VIOLATED');
      const twice = () =>
        db.notes.updateMany([
          { id: ONE, patch: { title: 'first' } },
          { id: ONE, patch: { title: 'again' } },
        ]);
      expect(await codeOf(twice)).toBe('X_INVARIANT_VIOLATED');
      expect(await codeOf(() => db.notes.updateMany([{ id: ONE, patch: {} }]))).toBe(
        'X_PATCH_EMPTY',
      );
      expect(await shape(db)).toEqual([
        [ONE, 'one', 'b1'],
        [TWO, 'two', 'b2'],
        [THREE, 'three', 'b3'],
      ]);
    },
  ),
  checkOver(
    { uniques },
    'two patches taking one unique value are refused; neither row moves',
    async (db) => {
      await db.uniques.insertAll([
        { id: 'a', slug: 'one' },
        { id: 'b', slug: 'two' },
      ]);
      const clash = () =>
        db.uniques.updateMany([
          { id: 'a', patch: { slug: 'same' } },
          { id: 'b', patch: { slug: 'same' } },
        ]);
      expect(await codeOf(clash)).toBe('X_DB_UNIQUE_VIOLATION');
      expect((await db.uniques.orderBy('id').all()).map((row) => row.slug)).toEqual(['one', 'two']);
    },
  ),
  checkOver(
    { uniques },
    "a later patch taking an untouched row's unique value refuses the batch; no earlier row moves",
    async (db) => {
      await db.uniques.insertAll([
        { id: 'a', slug: 'one' },
        { id: 'b', slug: 'two' },
        { id: 'c', slug: 'taken' },
      ]);
      const clash = () =>
        db.uniques.updateMany([
          { id: 'a', patch: { slug: 'moved' } },
          { id: 'b', patch: { slug: 'taken' } },
        ]);
      expect(await codeOf(clash)).toBe('X_DB_UNIQUE_VIOLATION');
      expect((await db.uniques.orderBy('id').all()).map((row) => row.slug)).toEqual([
        'one',
        'two',
        'taken',
      ]);
    },
  ),
  checkOver(
    { broad },
    'a 200-row, 600-column updateMany past the bind ceiling lands every patch, or none of them',
    async (db) => {
      const ids = Array.from({ length: PAST_CEILING }, (_, index) => `r${index}`);
      await db.broad.insertAll([...ids, 'z'].map((id) => broadRow(id, 'old')) as never[]);
      // The LAST patch takes the stored `z`'s unique value: the refusal lands in the last statement.
      const clash = ids.map((id, index) => ({
        id,
        patch: broadPatch(index === PAST_CEILING - 1 ? 'z' : `n${id}`, 'new'),
      }));
      expect(await codeOf(() => db.broad.updateMany(clash as never[]))).toBe(
        'X_DB_UNIQUE_VIOLATION',
      );
      expect(await db.broad.where({ c0: 'new' } as never).count()).toBe(0);
      const all = ids.map((id) => ({ id, patch: broadPatch(`n${id}`, 'new') }));
      expect(await db.broad.updateMany(all as never[])).toBe(PAST_CEILING);
      const fresh = await db.broad.where({ c599: 'new' } as never).count();
      const last = await db.broad.where({ id: `r${PAST_CEILING - 1}` }).one();
      expect([fresh, (last as Record<string, unknown> | null)?.['u']]).toEqual([
        PAST_CEILING,
        `nr${PAST_CEILING - 1}`,
      ]);
    },
  ),
];

const held = async (db: Database<{ posts: typeof posts }>) =>
  [
    ...(await db.posts.where({ orgId: ORG }).all()),
    ...(await db.posts.where({ orgId: OTHER_ORG }).all()),
  ]
    .map((row) => `${row.orgId === ORG ? 'ours' : 'theirs'}:${row.title}`)
    .sort();

const semantics: readonly EntityDriverCheck[] = [
  checkOver(
    { posts },
    'updateMany reaches only the actor’s tenant: another tenant’s id is not reached',
    async (db) => {
      await db.posts.insertAll([
        { id: ONE, orgId: ORG, title: 'same' },
        { id: TWO, orgId: OTHER_ORG, title: 'same' },
      ]);
      const batch = [
        { id: ONE, patch: { title: 'x' } },
        { id: TWO, patch: { title: 'x' } },
      ];
      expect(await inOrg(ORG, () => db.posts.updateMany(batch))).toBe(1);
      expect(await held(db)).toEqual(['ours:x', 'theirs:same']);
      expect(await codeOf(() => db.posts.updateMany(batch))).toBe('X_TENANCY_UNSCOPED');
      const handOver = () => db.posts.updateMany([{ id: ONE, patch: { orgId: OTHER_ORG } }]);
      expect(await inOrg(ORG, () => codeOf(handOver))).toBe('X_TENANCY_ACTOR_MISMATCH');
      expect(await held(db)).toEqual(['ours:x', 'theirs:same']);
    },
  ),
  checkOver(
    { swept },
    'updateMany cannot reach a soft-deleted row, and a JS-only rule refuses the batch whole',
    async (db, { driver }) => {
      await db.swept.insertAll([
        { id: ONE, kind: 'k', reason: 'r', deletedAt: null },
        { id: TWO, kind: 'k', reason: 'r', deletedAt: null },
        { id: THREE, kind: 'k', reason: 'r', deletedAt: null },
      ]);
      await db.swept.delete(THREE);
      // TWO's patch stamps it with no reason: the batch is judged whole, so ONE does not move.
      const judged = () =>
        db.swept.updateMany([
          { id: ONE, patch: { reason: 'fine', deletedAt: null } },
          { id: TWO, patch: { reason: null, deletedAt: WHEN } },
        ]);
      expect(await codeOf(judged)).toBe('X_INVARIANT_VIOLATED');
      expect((await db.swept.orderBy('id').all()).map((row) => row.reason)).toEqual(['r', 'r']);
      const revive = [
        { id: ONE, patch: { reason: 'fine', deletedAt: null } },
        { id: THREE, patch: { reason: 'back', deletedAt: null } },
      ];
      expect(await db.swept.updateMany(revive)).toBe(1);
      const { rows } = await driver.repo(swept).findMany({
        includeDeleted: true,
        orderBy: [{ column: 'id', direction: 'asc' }],
      });
      expect(rows.map((row) => [row.reason, row.deletedAt === null])).toEqual([
        ['fine', true],
        ['r', true],
        ['r', false],
      ]);
    },
  ),
  checkOver({ ledger }, 'an append-only table refuses updateMany', async (db) => {
    await db.ledger.insert({ id: ONE, account: 'cash', note: 'n' });
    expect(await codeOf(() => db.ledger.updateMany([{ id: ONE, patch: { note: 'x' } }]))).toBe(
      'X_ENTITY_APPEND_ONLY',
    );
    expect((await db.ledger.all()).map((row) => row.note)).toEqual(['n']);
  }),
  checkOver({ vault }, 'updateMany seals what it writes and reads back plaintext', async (db) => {
    await db.vault.insertAll([
      { id: ONE, label: 'a', secret: null, email: 'a@example.com' },
      { id: TWO, label: 'b', secret: null, email: 'b@example.com' },
    ]);
    await db.vault.updateMany([
      { id: ONE, patch: { secret: 's1', email: 'c@example.com' } },
      { id: TWO, patch: { secret: 's2', email: 'd@example.com' } },
    ]);
    const rows = await db.vault.orderBy('id').all();
    expect(rows.map((row) => [row.secret, row.email])).toEqual([
      ['s1', 'c@example.com'],
      ['s2', 'd@example.com'],
    ]);
    // A lookup column sealed deterministically still finds its row by the new value.
    expect((await db.vault.where({ email: 'd@example.com' }).one())?.id).toBe(TWO);
  }),
];

const reported: readonly EntityDriverCheck[] = [
  checkOver(
    { notes },
    'updateMany is reported to the row observer for every row it wrote, never silence',
    async (db) => {
      await seedNotes(db);
      const { answer, heard: told } = await heard('ec_wr_notes', () =>
        db.notes.updateMany([
          { id: ONE, patch: { title: 'x' } },
          { id: TWO, patch: { title: 'y' } },
          { id: idAt('dff'), patch: { title: 'ghost' } },
        ]),
      );
      expect([answer, accountedFor(told)]).toEqual([2, 2]);
    },
  ),
  checkOver(
    { logged, loggedHistory },
    'updateMany writes one history version per row it reached',
    async (db, raw) => {
      if (!raw.history) return;
      const versions = await inOrg(ORG, async () => {
        await db.logged.insertAll([
          { id: ONE, orgId: ORG, title: 'a' },
          { id: TWO, orgId: ORG, title: 'b' },
        ]);
        await db.logged.updateMany([
          { id: ONE, patch: { title: 'a2' } },
          { id: TWO, patch: { title: 'b2' } },
        ]);
        return [await history(db.loggedHistory, ONE), await history(db.loggedHistory, TWO)];
      });
      const title = (image: unknown): string | null =>
        (image as { title?: string } | null)?.title ?? null;
      expect(versions.map((all) => all.map((v) => [v.version, v.op, title(v.after)]))).toEqual([
        [
          [1, 'insert', 'a'],
          [2, 'update', 'a2'],
        ],
        [
          [1, 'insert', 'b'],
          [2, 'update', 'b2'],
        ],
      ]);
    },
  ),
];

export const UPDATE_MANY_CHECKS: readonly EntityDriverCheck[] = [
  ...writes,
  ...semantics,
  ...reported,
];
