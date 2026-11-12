// Entity conformance · the declared optimistic lock, `entity({ version: 'lockVersion' })`: an
// `update` naming the version it read writes only over that version and moves it, a stale one is
// `X_ENTITY_STALE` and writes nothing; a write that cannot condition on it is refused or moves it
// unconditioned, per the rule table — so no write path leaves a stale reader believing it is current.

import { expect } from 'bun:test';
import type { Database, Driver } from '@ultimat3/entity';
import { entity, integer, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const docs = remember(
  entity('ec_vl_docs', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      title: text({ max: 20 }),
      lockVersion: integer().default(0),
      deletedAt: timestamp().nullable(),
    },
    version: 'lockVersion',
  }),
);

const SET = { docs };
type Db = Database<typeof SET>;
const [ORG, OTHER_ORG] = [idAt('7a'), idAt('7b')];
const [D1, D2, D3] = [idAt('71'), idAt('72'), idAt('73')];
const STALE = 'X_ENTITY_STALE';
const INVALID = 'X_ENTITY_VERSION_INVALID';
const RACERS = 8;

const seed = (db: Db) =>
  db.docs.insertAll([
    { id: D1, orgId: ORG, title: 'one' },
    { id: D2, orgId: ORG, title: 'two' },
    { id: D3, orgId: OTHER_ORG, title: 'theirs' },
  ]);

/** Every row's `[title, version]` in id order, deleted rows included: each org read by the bare repo. */
const state = async (raw: { readonly driver: Driver }) => {
  const read = (orgId: string) =>
    raw.driver.repo(docs).findMany({
      orgId,
      includeDeleted: true,
      orderBy: [{ column: 'id', direction: 'asc' }],
    });
  const rows = [...(await read(ORG)).rows, ...(await read(OTHER_ORG)).rows];
  return rows.sort((a, b) => a.id.localeCompare(b.id)).map((row) => [row.title, row.lockVersion]);
};

const byId: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'insert takes the declared default; update naming the version read moves it by one',
    async (db, raw) => {
      await seed(db);
      await inOrg(ORG, () => db.docs.update(D1, { title: 'first', lockVersion: 0 }));
      await inOrg(ORG, () => db.docs.update(D1, { title: 'second', lockVersion: 1 }));
      expect(await state(raw)).toEqual([
        ['second', 2],
        ['two', 0],
        ['theirs', 0],
      ]);
    },
  ),
  checkOver(
    SET,
    'a stale version is X_ENTITY_STALE and writes nothing; an absent or foreign id is X_NOT_FOUND',
    async (db, raw) => {
      await seed(db);
      await inOrg(ORG, () => db.docs.update(D1, { title: 'won', lockVersion: 0 }));
      const answers = await inOrg(ORG, async () => [
        await codeOf(() => db.docs.update(D1, { title: 'lost', lockVersion: 0 })),
        await codeOf(() => db.docs.update(D1, { title: 'ahead', lockVersion: 5 })),
        await codeOf(() => db.docs.update(idAt('7ff'), { title: 'ghost', lockVersion: 0 })),
        await codeOf(() => db.docs.update(D3, { title: 'foreign', lockVersion: 0 })),
      ]);
      expect(answers).toEqual([STALE, STALE, 'X_NOT_FOUND', 'X_NOT_FOUND']);
      expect(await state(raw)).toEqual([
        ['won', 1],
        ['two', 0],
        ['theirs', 0],
      ]);
    },
  ),
  checkOver(
    SET,
    'an update by id that omits the version is refused: the lock is the point',
    async (db, raw) => {
      await seed(db);
      expect(await inOrg(ORG, () => codeOf(() => db.docs.update(D1, { title: 'blind' })))).toBe(
        INVALID,
      );
      expect((await state(raw))[0]).toEqual(['one', 0]);
    },
  ),
  checkOver(
    SET,
    `${RACERS} writers holding one version: exactly one wins, the rest are stale`,
    async (db, raw) => {
      await seed(db);
      const answers = await inOrg(ORG, () =>
        Promise.all(
          Array.from({ length: RACERS }, (_, index) =>
            codeOf(() => db.docs.update(D1, { title: `w${index}`, lockVersion: 0 })),
          ),
        ),
      );
      expect([...answers].sort()).toEqual([
        ...Array.from({ length: RACERS - 1 }, () => STALE),
        'resolved',
      ]);
      const [title, version] = (await state(raw))[0] ?? [];
      expect([answers[Number(String(title).slice(1))], version]).toEqual(['resolved', 1]);
    },
  ),
];

const filtered: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'updateWhere and chain updateAll move the version unconditioned; naming it is refused',
    async (db, raw) => {
      await seed(db);
      await inOrg(ORG, async () => {
        await db.docs.updateWhere({ id: D1 }, { title: 'a' });
        await db.docs.where({ title: 'a' }).updateAll({ title: 'b' });
      });
      const named = await inOrg(ORG, async () => [
        await codeOf(() => db.docs.updateWhere({ id: D1 }, { title: 'x', lockVersion: 9 })),
        await codeOf(() => db.docs.where({ id: D1 }).updateAll({ title: 'x', lockVersion: 9 })),
      ]);
      expect(named).toEqual([INVALID, INVALID]);
      expect(await state(raw)).toEqual([
        ['b', 2],
        ['two', 0],
        ['theirs', 0],
      ]);
    },
  ),
  checkOver(
    SET,
    'compare-and-set through the filter: a chain naming the version read writes once',
    async (db, raw) => {
      await seed(db);
      const cas = () =>
        inOrg(ORG, () => db.docs.where({ id: D1, lockVersion: 0 }).updateAll({ title: 'cas' }));
      expect([await cas(), await cas()]).toEqual([1, 0]);
      expect((await state(raw))[0]).toEqual(['cas', 1]);
    },
  ),
  checkOver(SET, 'a soft delete moves the version too', async (db, raw) => {
    await seed(db);
    await inOrg(ORG, () => db.docs.delete(D2));
    expect((await state(raw))[1]).toEqual(['two', 1]);
  }),
  checkOver(
    SET,
    'updateMany conditions every row on its version: one stale row refuses the batch whole',
    async (db, raw) => {
      await seed(db);
      await inOrg(ORG, () => db.docs.update(D2, { title: 'moved', lockVersion: 0 }));
      const batch = (v2: number) => [
        { id: D1, patch: { title: 'b1', lockVersion: 0 } },
        { id: D2, patch: { title: 'b2', lockVersion: v2 } },
      ];
      const refusals = await inOrg(ORG, async () => [
        await codeOf(() => db.docs.updateMany(batch(0))),
        await codeOf(() => db.docs.updateMany([{ id: D1, patch: { title: 'blind' } }])),
      ]);
      expect(refusals).toEqual([STALE, INVALID]);
      expect(await state(raw)).toEqual([
        ['one', 0],
        ['moved', 1],
        ['theirs', 0],
      ]);
      expect(await inOrg(ORG, () => db.docs.updateMany(batch(1)))).toBe(2);
      expect(await state(raw)).toEqual([
        ['b1', 1],
        ['b2', 2],
        ['theirs', 0],
      ]);
    },
  ),
  checkOver(
    SET,
    'upsertAll that would overwrite a match is refused; one that keeps it is not',
    async (db, raw) => {
      await seed(db);
      const row = { id: D1, orgId: ORG, title: 'over', lockVersion: 0 };
      const answers = await inOrg(ORG, async () => [
        await codeOf(() => db.docs.upsertAll([row], { onConflict: ['id'] })),
        await codeOf(() => db.docs.upsertAll([row], { onConflict: ['id'], onMatch: 'nothing' })),
      ]);
      expect(answers).toEqual([INVALID, 'resolved']);
      expect((await state(raw))[0]).toEqual(['one', 0]);
    },
    ['upsert'],
  ),
];

export const VERSION_LOCK_CHECKS: readonly EntityDriverCheck[] = [...byId, ...filtered];
