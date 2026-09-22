// `pageSync` is the one composition both boots take their document head from. What is pinned here
// is the half that reads the ENTITY registry: the persisted record types, read per call, so an
// entity registered after boot still reaches the next document.

import { afterAll, expect, test } from 'bun:test';
import { clearRegistry, entity, uuid } from '@ultimat3/entity';
import { pageSync } from './page-sync';

afterAll(() => {
  clearRegistry();
});

test('persisted names every entity declared persist: true, and only those, read at call time', async () => {
  // OUTSIDE the checkout, so no realtime resolves and no worker is built — this is not about it.
  const sync = await pageSync(Bun.env['TMPDIR'] ?? '/tmp', {}, 'build-under-test');
  entity('page_sync_kept', { persist: true, columns: { id: uuid().primaryKey() } });
  entity('page_sync_dropped', { columns: { id: uuid().primaryKey() } });

  expect(sync.persisted()).toContain('page_sync_kept');
  expect(sync.persisted()).not.toContain('page_sync_dropped');
});

test('the scripts it serves are the scripts it hands the service worker to precache', async () => {
  // The checkout's own realtime resolves from here, so both scripts are built.
  const sync = await pageSync(`${import.meta.dir}/../../realtime`, {}, 'build-under-test');
  const urls = sync.scripts.map((script) => script.url);
  expect(urls.some((url) => url.startsWith('/_x/page-boot/'))).toBe(true);
  expect(urls.some((url) => url.startsWith('/_x/sync-worker/'))).toBe(true);
  expect(sync.head.bootUrl).toBe(urls.find((url) => url.startsWith('/_x/page-boot/')) ?? '');
});
