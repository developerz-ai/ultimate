// The three principal-free tags a page's socket host reads its target off.

import { describe, expect, test } from 'bun:test';
import { clientSyncTags } from './client-sync-tags';
import { renderHead } from './head';

describe('clientSyncTags', () => {
  test('the sync url, the build and the worker, each as its own named meta', () => {
    expect(
      renderHead(
        clientSyncTags({
          syncUrl: '/_x/sync',
          buildId: 'b1',
          workerUrl: '/_x/sync-worker/0a1b2c3d.js',
        }),
      ),
    ).toBe(
      '<meta name="ultimate-sync" content="/_x/sync">' +
        '<meta name="x-ultimate-build" content="b1">' +
        '<meta name="ultimate-sync-worker" content="/_x/sync-worker/0a1b2c3d.js">',
    );
  });

  test('no worker built is no worker tag — the host falls back in-page, never to a dead URL', () => {
    expect(renderHead(clientSyncTags({ syncUrl: '/_x/sync', buildId: 'b1' }))).not.toContain(
      'ultimate-sync-worker',
    );
  });
});
