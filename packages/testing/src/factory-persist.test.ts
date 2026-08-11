// The seam is process-global, so what matters is that it is installable, replaceable and
// removable — and that removing it is what a failing `create()` reports.

import { afterEach, describe, expect, test } from 'bun:test';
import { clearPersister, persisterInstalled, persistRow, usePersister } from './factory-persist';
import { testName } from './test-types';

afterEach(() => {
  clearPersister();
});

describe(testName('unit', 'persister'), () => {
  test('starts uninstalled, so no suite inherits one it did not set', () => {
    expect(persisterInstalled()).toBe(false);
  });

  test('a later usePersister wins, the same way defineFixtures does', async () => {
    const seen: string[] = [];
    usePersister({ insert: async (table) => void seen.push(`first:${table}`) });
    usePersister({ insert: async (table) => void seen.push(`second:${table}`) });
    await persistRow('orgs', { id: 'a' });
    expect(seen).toEqual(['second:orgs']);
  });

  test('persistRow rejects with X_TEST_FACTORY_NOT_PERSISTED when none is installed', async () => {
    const thrown = await persistRow('posts', { id: 'a' }).then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(thrown?.code).toBe('X_TEST_FACTORY_NOT_PERSISTED');
  });

  test('an insert that throws surfaces unchanged — a write failure is not a missing seam', async () => {
    usePersister({
      insert: async () => {
        throw new Error('duplicate key value violates unique constraint');
      },
    });
    const thrown = await persistRow('orgs', { id: 'a' }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(thrown?.message).toContain('duplicate key');
  });
});
