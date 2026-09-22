/**
 * e2e — plan 101, done-when #6 and decision 11: a like taken OFFLINE shows at once, survives a
 * reload (IndexedDB, not memory), and on reconnect is replayed over HTTP exactly once — the server
 * ends at one like, not two — with no flicker back to the old count on the way.
 *
 * Kenji on "Nadie formatea…" (Acme, 1 like in the seed — ada's). Not mara on the Tinta post, which
 * `postById`'s policy answers 403 for, measured 2026-09-22. Every count the page ever
 * rendered is recorded by an init script into `sessionStorage`, which survives the reload, so
 * "no flicker" is a statement about every paint and not about the last one. Fails until slice 12
 * and the island migration land — that is expected.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/cli';
import { everyCount, like, requestsSince, until } from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  acceptanceBrowser,
  noBrowser,
  POSTS,
  serverLikeCount,
  signInAs,
  startPostly,
} from './fixtures/postly';

const SEEN = 'e2e-like-counts';

/** Records every set of island like counts the document shows, across reloads, before any app script runs. */
const RECORDER = `(() => {
  const record = () => {
    const counts = [...document.querySelectorAll('[data-like-count][data-post="${POSTS.timezones.id}"]')]
      .map((el) => Number(el.dataset.likeCount));
    if (counts.length === 0) return;
    const seen = JSON.parse(sessionStorage.getItem('${SEEN}') || '[]');
    const now = counts.join(',');
    if (seen[seen.length - 1] !== now) seen.push(now);
    sessionStorage.setItem('${SEEN}', JSON.stringify(seen));
  };
  addEventListener('DOMContentLoaded', () => {
    record();
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
})();`;

describe.skipIf(noBrowser)('a like taken offline', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  beforeAll(async () => {
    app = await startPostly();
    // A browser of its own: the recorder is an init script, and one added to the run's shared
    // browser would run in every later suite's tabs.
    browser = await acceptanceBrowser(RECORDER);
    await signInAs(browser.session, app, 'kenji');
    tab = await browser.session.newTab();
    await tab.goto(`${app.base}/posts/${POSTS.timezones.id}`);
  }, 240_000);

  afterAll(async () => {
    browser?.close();
    await app?.stop();
  });

  test('shows at once, survives a reload, replays once, and never flickers back', async () => {
    const { session } = browser;
    await tab.waitFor(
      everyCount(POSTS.timezones.id, 1),
      'the post to render with its one seeded like',
    );
    // The document must come back offline, so the worker has to be in control first.
    await tab.waitFor(
      'navigator.serviceWorker && navigator.serviceWorker.controller',
      'the service worker to take control',
    );

    await session.offline(true);
    await like(tab, POSTS.timezones.id);
    await tab.waitFor(
      everyCount(POSTS.timezones.id, 2),
      'the optimistic like to show while offline',
    );

    await tab.reload();
    await tab.waitFor(
      everyCount(POSTS.timezones.id, 2),
      'the like to survive a reload from IndexedDB',
    );

    const mark = session.requests().length;
    await session.offline(false);
    await until(
      async () => (await serverLikeCount(app, 'kenji', 'timezones')) === 2,
      'the server to acknowledge the like',
    );

    // Replayed ONCE: one write reached the wire from any realm — page, worker or service worker.
    expect(requestsSince(session, app.base, mark, /^POST .*\/api\/posts\/like/)).toHaveLength(1);
    expect(await serverLikeCount(app, 'kenji', 'timezones')).toBe(2);
    // No flicker: once 2 was painted, nothing painted 1 again — before the reload, after it, or
    // when the server's answer replaced the optimistic row.
    const seen = await tab.evaluate(`JSON.parse(sessionStorage.getItem('${SEEN}') || '[]')`);
    if (!Array.isArray(seen)) return expect.unreachable('the recorder kept no history');
    const firstLiked = seen.findIndex((entry) =>
      String(entry)
        .split(',')
        .every((n) => n === '1'),
    );
    expect(firstLiked).toBeGreaterThan(-1);
    expect(
      seen.slice(firstLiked).filter((entry) => String(entry).split(',').includes('0')),
    ).toEqual([]);
  }, 90_000);
});
