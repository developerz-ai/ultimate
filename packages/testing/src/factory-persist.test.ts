// The seam is process-global, so what matters is that it is installable, replaceable and
// removable — that the default is the entity's own repository on the process driver, answering
// the STORED row — and that a lookalike with no repository says so by code.

import { afterEach, describe, expect, test } from 'bun:test';
import { defaultDriver, entity, integer, memoryDriver, text, uuid } from '@ultimat3/entity';
import {
  clearPersister,
  entityPersister,
  persisterInstalled,
  persistRow,
  usePersister,
} from './factory-persist';
import type { EntityLike } from './factory-types';
import { testName } from './test-types';

const lookalike: EntityLike = { $table: 'orgs', $columns: { id: 0 } };
const notes = entity('fp_notes', {
  columns: { id: uuid().primaryKey(), body: text(), views: integer().default(0) },
});
const ID = '00000000-0000-4000-8000-0000000000f1';

afterEach(() => {
  clearPersister();
});

describe(testName('unit', 'persister'), () => {
  test('starts uninstalled, so no suite inherits one it did not set', () => {
    expect(persisterInstalled()).toBe(false);
  });

  test('a later usePersister wins, the same way defineFixtures does', async () => {
    const seen: string[] = [];
    usePersister({
      insert: async (target, row) => {
        seen.push(`first:${target.$table}`);
        return row;
      },
    });
    usePersister({
      insert: async (target, row) => {
        seen.push(`second:${target.$table}`);
        return row;
      },
    });
    await persistRow(lookalike, { id: 'a' });
    expect(seen).toEqual(['second:orgs']);
  });

  test('a lookalike with nothing installed is X_TEST_FACTORY_NOT_PERSISTED', async () => {
    const thrown = await persistRow(lookalike, { id: 'a' }).then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(thrown?.code).toBe('X_TEST_FACTORY_NOT_PERSISTED');
  });

  test('the default writes a real entity to the process driver and answers the stored row', async () => {
    const stored = await persistRow(notes, { id: ID, body: 'hello' });
    // `views` was never built: the declared default is what the table holds, and what comes back.
    expect(stored).toEqual({ id: ID, body: 'hello', views: 0 });
    expect(await defaultDriver().repo(notes).findById(ID)).toEqual({
      id: ID,
      body: 'hello',
      views: 0,
    });
  });

  test('entityPersister({ driver }) writes to that driver and no other', async () => {
    const driver = memoryDriver();
    const id = '00000000-0000-4000-8000-0000000000f2';
    usePersister(entityPersister({ driver }));
    await persistRow(notes, { id, body: 'mine' });
    expect(await driver.repo(notes).findById(id)).toEqual({ id, body: 'mine', views: 0 });
    expect(await defaultDriver().repo(notes).findById(id)).toBeNull();
  });

  test('a row the entity refuses is the entity error, unchanged — not a missing seam', async () => {
    const thrown = await persistRow(notes, { id: 'not-a-uuid', body: 'x' }).then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(thrown?.code).toMatch(/^X_/);
    expect(thrown?.code).not.toBe('X_TEST_FACTORY_NOT_PERSISTED');
  });
});
