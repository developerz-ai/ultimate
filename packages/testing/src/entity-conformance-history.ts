// Entity conformance · HISTORY: `entity({ history: true })` read back through `history(table, id)`.
// One transaction's versions tie on `now()` and still read back in write order, numbered from 1; a
// transaction that fails writes no version; another tenant reads none. Run only where the subject
// declares `history` — a `defineDriver` store has no lifecycle hook (`EntityDriverSubject.history`).

import { expect } from 'bun:test';
import { entity, history, text, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const notes = remember(
  entity('ec_h_notes', {
    columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text({ max: 40 }) },
    history: true,
  }),
);
const notesHistory = remember(
  notes.$history ?? expect.unreachable('history: true declares a history entity'),
);

const ORG = idAt('b1');
const OTHER_ORG = idAt('b2');
const NOTE = idAt('b11');
const FAILED = idAt('b12');
const TITLES = ['b', 'c', 'd'];

export const HISTORY_CHECKS: readonly EntityDriverCheck[] = [
  checkOver(
    { notes, notesHistory },
    'history: one transaction reads back in order, a failed one writes none, no other tenant reads it',
    async (db, raw) => {
      // A `defineDriver` store has no lifecycle hook: it records no history and refuses nothing, so
      // there is no answer to hold it to. Skipped, not asserted refused, as a capability would be.
      if (!raw.history) return;
      const tx = () => raw.driver.transactor();
      const own = await inOrg(ORG, async () => {
        await tx().run(async () => {
          await db.notes.insert({ id: NOTE, orgId: ORG, title: 'a' });
          for (const title of TITLES) await db.notes.update(NOTE, { title });
          await db.notes.delete(NOTE);
        });
        const failed = await codeOf(() =>
          tx().run(async () => {
            await db.notes.insert({ id: FAILED, orgId: ORG, title: 'a' });
            await db.notes.insert({ id: FAILED, orgId: ORG, title: 'again' });
          }),
        );
        return {
          versions: await history(db.notesHistory, NOTE),
          failed,
          failedVersions: await history(db.notesHistory, FAILED),
        };
      });
      const title = (image: unknown): string | null =>
        (image as { title?: string } | null)?.title ?? null;
      expect(own.versions.map((v) => [v.version, v.op, title(v.before), title(v.after)])).toEqual([
        [1, 'insert', null, 'a'],
        [2, 'update', 'a', 'b'],
        [3, 'update', 'b', 'c'],
        [4, 'update', 'c', 'd'],
        [5, 'delete', 'd', null],
      ]);
      expect(own.failed).toBe('X_DB_UNIQUE_VIOLATION');
      expect(own.failedVersions).toEqual([]);
      expect(await inOrg(OTHER_ORG, () => history(db.notesHistory, NOTE))).toEqual([]);
    },
    ['transactions'],
  ),
];
