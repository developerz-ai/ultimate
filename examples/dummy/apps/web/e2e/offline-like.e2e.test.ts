/**
 * e2e — plan 101, done-when #6 and decision 11: a like taken OFFLINE shows at once, survives a
 * reload (IndexedDB, not memory), and on reconnect is replayed over HTTP exactly once — the server
 * ends at one like, not two — with no flicker on the way: not back to the old count, and not up to
 * a double count when the replayed write's own `records` frame beats its HTTP answer.
 *
 * Kenji on "Nadie formatea…" (Acme, 1 like in the seed — ada's). Not mara on the Tinta post, which
 * `postById`'s policy answers 403 for, measured 2026-09-22. Every count the page ever
 * PAINTED is recorded by an init script into `sessionStorage`, which survives the reload, so
 * "no flicker" is a statement about every paint and not about the last one — the reload's first
 * included (#506): the cached document's server markup shows the count it was rendered with, and
 * a held island (`data-x-hold`) is what keeps that markup off screen until the mount rebuilt the
 * queued write's overlay.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import { E2E_GOTO_MS, E2E_TAB_OPEN_MS } from '@ultimat3/testing';
import { everyCount, like, requestsSince, until } from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  ACCEPTANCE_CLOSE_MS,
  ACCEPTANCE_OPEN_MS,
  acceptanceBrowser,
  noBrowser,
  POSTS,
  SIGN_IN_MS,
  serverLikeCount,
  signInAs,
  startPostly,
} from './fixtures/postly';

const SEEN = 'e2e-like-counts';

/**
 * Records every set of like counts the document PAINTS, across reloads, before any app script runs.
 * Per island root (the like control and the header's badge): a held root paints nothing; a mounted
 * one paints its `data-like-count`; a root still showing its server markup paints the number in
 * that markup's rendered text (`innerText`, so the props `<script>` inside the root is not read).
 */
const RECORDER = `(() => {
  const record = () => {
    const counts = [];
    for (const root of document.querySelectorAll('[data-x-island^="like-"], [data-x-island^="likes-badge-"]')) {
      if (root.hasAttribute('data-x-hold')) continue;
      const live = root.querySelector('[data-like-count][data-post="${POSTS.timezones.id}"]');
      const shown = live ? live.dataset.likeCount : (root.innerText.match(/\\d+/) || [])[0];
      if (shown !== undefined) counts.push(Number(shown));
    }
    if (counts.length === 0) return;
    const seen = JSON.parse(sessionStorage.getItem('${SEEN}') || '[]');
    const now = counts.join(',');
    if (seen[seen.length - 1] !== now) seen.push(now);
    sessionStorage.setItem('${SEEN}', JSON.stringify(seen));
  };
  addEventListener('DOMContentLoaded', () => {
    record();
    new MutationObserver(record).observe(document.body, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['data-x-hold', 'data-like-count'],
    });
  });
})();`;

describe.skipIf(noBrowser)('a like taken offline', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  beforeAll(
    async () => {
      app = await startPostly();
      // A browser of its own: the recorder is an init script, and one added to the run's shared
      // browser would run in every later suite's tabs.
      browser = await acceptanceBrowser(RECORDER);
      await signInAs(browser.session, app, 'kenji');
      tab = await browser.session.newTab();
      await tab.goto(`${app.base}/posts/${POSTS.timezones.id}`);
    },
    ACCEPTANCE_OPEN_MS + SIGN_IN_MS + E2E_TAB_OPEN_MS + E2E_GOTO_MS,
  );

  afterAll(async () => {
    await browser?.close();
    await app?.stop();
  }, ACCEPTANCE_CLOSE_MS);

  test('shows at once, survives a reload, replays once, and never flickers back', async () => {
    const { session } = browser;
    const history = async (): Promise<string[]> => {
      const seen = await tab.evaluate(`JSON.parse(sessionStorage.getItem('${SEEN}') || '[]')`);
      if (!Array.isArray(seen)) return expect.unreachable('the recorder kept no history');
      return seen.map(String);
    };
    const allTwo = (entry: string): boolean => entry.split(',').every((n) => n === '2');
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

    const reloadedAt = (await history()).length;
    await tab.reload();
    await tab.waitFor(
      everyCount(POSTS.timezones.id, 2),
      'the like to survive a reload from IndexedDB',
    );

    const reconnectedAt = (await history()).length;
    const mark = session.requests().length;
    await session.offline(false);
    await until(
      async () => (await serverLikeCount(app, 'kenji', 'timezones')) === 2,
      'the server to acknowledge the like',
    );

    // Replayed ONCE: one write reached the wire from any realm — page, worker or service worker.
    expect(requestsSince(session, app.base, mark, /^POST .*\/api\/posts\/like/)).toHaveLength(1);
    expect(await serverLikeCount(app, 'kenji', 'timezones')).toBe(2);
    const seen = await history();
    // No flicker while offline: from the like's first paint to the reload, every paint reads 2.
    const firstLiked = seen.findIndex(allTwo);
    expect(firstLiked).toBeGreaterThan(-1);
    expect(seen.slice(firstLiked, reloadedAt).filter((entry) => !allTwo(entry))).toEqual([]);
    // No flicker on the reload (#506): the service worker's cached document was rendered before
    // the like and says 1, and until the boot restored the queued write the store says 1 too —
    // from the reload's FIRST paint to the reconnect, every paint reads 2.
    expect(seen.slice(reloadedAt, reconnectedAt).filter((entry) => !allTwo(entry))).toEqual([]);
    // No flicker on reconnect: from the last all-2 paint before the socket came back, nothing but
    // 2 — not the seed's 1, and not 3, which is the replayed like's own frame painted under its
    // still-pending twin (the write counted twice) until the HTTP answer settled it.
    const settled = seen.slice(0, reconnectedAt).findLastIndex(allTwo);
    expect(settled).toBeGreaterThan(-1);
    expect(seen.slice(settled).filter((entry) => !allTwo(entry))).toEqual([]);
  }, 90_000);
});
