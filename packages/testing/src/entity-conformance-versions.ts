// Entity conformance · a searchable entity's VERSION: every write stores its `onUpdateNow()` column
// strictly past the stored one, inside one millisecond too — an update, a filtered update and an
// upsert's collision. An external search index keeps only newer, so an equal version is a lost
// write. A store's own `upsert` merges the collision itself: `advanceVersion` is its half.

import { expect } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { entity, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, idAt } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const docs = remember(
  entity('ec_v_docs', {
    columns: {
      id: uuid().primaryKey(),
      code: text({ max: 20 }).unique(),
      title: text({ max: 40 }).searchable(),
      updatedAt: timestamp().defaultNow().onUpdateNow(),
    },
  }),
);

const AT = new Date('2026-11-10T10:00:00.000Z');

/** A clock that never moves: every write of the check lands in one millisecond. */
const stopped: Clock = { now: () => new Date(AT), monotonic: () => AT.getTime() };
const inOneMs = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ clock: stopped }), work);

const ROW = { id: idAt(901), code: 'a', title: 'one' };

export const VERSION_CHECKS: readonly EntityDriverCheck[] = [
  checkOver({ docs }, "a searchable entity's update in the same ms is a newer version", (db) =>
    inOneMs(async () => {
      const first = await db.docs.insert(ROW);
      const second = await db.docs.update(ROW.id, { title: 'two' });
      const third = await db.docs.updateWhere({ code: 'a' }, { title: 'three' });
      const stored = await db.docs.where({ code: 'a' }).one();
      expect(third).toBe(1);
      expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
      expect(stored?.updatedAt.getTime()).toBeGreaterThan(second.updatedAt.getTime());
    }),
  ),
  checkOver(
    { docs },
    "a searchable entity's upsert collision in the same ms is a newer version",
    (db) =>
      inOneMs(async () => {
        const first = await db.docs.insert(ROW);
        const [second] = await db.docs.upsertAll([{ ...ROW, title: 'two' }], {
          onConflict: ['code'],
        });
        expect(second?.title).toBe('two');
        expect(second?.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
      }),
    ['upsert'],
  ),
];
