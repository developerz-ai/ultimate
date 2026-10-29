// What an opted-in document's head names: the router's surface, the build and the script — the
// build under the same key realtime's sync tags use, so the two never write it twice — and the
// modal routes a click may open at once, most specific first, with the pages that shadow them.
import { describe, expect, test } from 'bun:test';
import { clientSyncTags } from './client-sync-tags';
import { mergeHead, renderHead } from './head';
import { declaresModal, parseModalRoutes } from './navigation-modal-rules';
import { clientNavigationTags, modalRouteList } from './navigation-tags';

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

  test("a `navigation: 'modal'` route says so; every other names no presentation", () => {
    const modal = clientNavigationTags({
      surface: 'web:app',
      buildId: 'b1',
      scriptUrl: '/_x/navigation/h.js',
      modal: true,
    });
    expect(renderHead(modal)).toContain('<meta name="ultimate-presentation" content="modal">');
    expect(renderHead(tags)).not.toContain('ultimate-presentation');
  });

  test("the build shares realtime's key: merged with the sync tags, it is written once", () => {
    const merged = mergeHead(clientSyncTags({ syncUrl: '/_x/sync', buildId: 'b1' }), tags);
    expect(merged.filter((tag) => tag.key === 'meta:x-ultimate-build')).toHaveLength(1);
  });

  test('the modal routes, in their own meta, read back by the router as written', () => {
    const modals = { routes: ['/runs/:id/peek'], close: 'Close', loading: 'Loading…' };
    const head = clientNavigationTags({
      surface: 'web:app',
      buildId: 'b1',
      scriptUrl: '/_x/navigation/h.js',
      modals,
    });
    const meta = head.find((tag) => tag.key === 'meta:ultimate-modals');
    expect(parseModalRoutes(String(meta?.attrs?.['content']))).toEqual(modals);
    expect(renderHead(head)).toContain('name="ultimate-modals"');
  });

  test('no modal route: no meta, no bytes', () => {
    const none = clientNavigationTags({
      surface: 'web:app',
      buildId: 'b1',
      scriptUrl: '/_x/navigation/h.js',
      modals: { routes: [], close: 'Close', loading: 'Loading…' },
    });
    expect(renderHead(none)).not.toContain('ultimate-modals');
    expect(renderHead(tags)).not.toContain('ultimate-modals');
  });
});

describe('modalRouteList', () => {
  const pages = [
    { path: '/runs', modal: false },
    { path: '/runs/:id', modal: false },
    { path: '/runs/:id/peek', modal: true },
    { path: '/runs/new/peek', modal: false },
    { path: '/runs/:id/:tab', modal: false },
    { path: '/docs/*rest', modal: false },
    { path: '/settings/invite', modal: true },
    { path: '/about', modal: false },
  ];

  test('every modal, and only the pages that outrank one where both match, most specific first', () => {
    expect(modalRouteList(pages)).toEqual([
      '/settings/invite',
      '!/runs/new/peek',
      '/runs/:id/peek',
    ]);
  });

  test('the list decides as the request router would', () => {
    const list = modalRouteList(pages);
    expect(declaresModal('https://app.test/runs/7/peek', list)).toBe(true);
    expect(declaresModal('https://app.test/runs/new/peek', list)).toBe(false);
    expect(declaresModal('https://app.test/runs/7/log', list)).toBe(false);
    expect(declaresModal('https://app.test/settings/invite', list)).toBe(true);
  });

  test('a catch-all modal is outranked by every literal page below it', () => {
    expect(
      modalRouteList([
        { path: '/help/*rest', modal: true },
        { path: '/help/contact', modal: false },
        { path: '/other', modal: false },
      ]),
    ).toEqual(['!/help/contact', '/help/*rest']);
  });

  test('no modal: an empty list', () => {
    expect(modalRouteList([{ path: '/a', modal: false }])).toEqual([]);
  });
});
