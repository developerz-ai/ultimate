// What an opted-in document's head names: the router's surface, the build and the script — the
// build under the same key realtime's sync tags use, so the two never write it twice.
import { describe, expect, test } from 'bun:test';
import { clientSyncTags } from './client-sync-tags';
import { mergeHead, renderHead } from './head';
import { clientNavigationTags } from './navigation-tags';

describe('clientNavigationTags', () => {
  const tags = clientNavigationTags({
    surface: 'web:app',
    buildId: 'b1',
    scriptUrl: '/_x/navigation/h.js',
  });

  test('the surface, the build, one deferred script', () => {
    expect(renderHead(tags)).toBe(
      '<meta name="ultimate-navigation" content="web:app">' +
        '<meta name="x-ultimate-build" content="b1">' +
        '<script src="/_x/navigation/h.js" defer></script>',
    );
  });

  test("the build shares realtime's key: merged with the sync tags, it is written once", () => {
    const merged = mergeHead(clientSyncTags({ syncUrl: '/_x/sync', buildId: 'b1' }), tags);
    expect(merged.filter((tag) => tag.key === 'meta:x-ultimate-build')).toHaveLength(1);
  });
});
