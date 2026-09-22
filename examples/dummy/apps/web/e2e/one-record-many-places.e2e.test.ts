/**
 * e2e — plan 101, done-when #1 and #3: one record shown by two islands on one page is ONE record.
 * A like in island A moves the count in island B with no refetch — the action's records envelope
 * (or one socket frame) reaches the page's one store, and every island reading that record
 * re-renders. The page opens exactly one `/_x/sync` socket, whatever its island count.
 *
 * CONTRACT this assumes of slice 16: `/posts/{id}` renders at least two islands that each show the
 * post's like count (`t('app.post.likes')`), and one of them carries the Like button. It fails
 * until the islands are migrated onto `useRecord` / `useMutation` — that is expected.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/cli';
import {
  everyCount,
  like,
  likeCounts,
  readNumbers,
  requestsSince,
  syncSockets,
  until,
} from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  acceptanceBrowser,
  noBrowser,
  POSTS,
  serverLikeCount,
  signInAs,
  startPostly,
} from './fixtures/postly';

describe.skipIf(noBrowser)('one record, many places', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  beforeAll(async () => {
    app = await startPostly();
    browser = await acceptanceBrowser();
    await signInAs(browser.session, app, 'ada');
    tab = await browser.session.newTab();
    await tab.goto(`${app.base}/posts/${POSTS.tenancy.id}`);
  }, 240_000);

  afterAll(async () => {
    await tab?.close();
    browser?.close();
    await app?.stop();
  });

  test('a like in one island moves the count in the other, from one write, with no refetch', async () => {
    const { session } = browser;
    await tab.waitFor(
      `${likeCounts(POSTS.tenancy.id)}.length >= 2`,
      'two places on /posts/{id} that each show the like count',
    );
    await until(() => syncSockets(session, app.base) >= 1, 'the page to open its /_x/sync socket');
    // Ada has not liked Tenancy in the seed: bruno and kenji have.
    expect(await readNumbers(tab, likeCounts(POSTS.tenancy.id))).toEqual(
      expect.arrayContaining([2, 2]),
    );

    // The like control's channel is live once its first catch-up read has landed. Marked before
    // that, the log would catch that read and call it a refetch the like caused.
    await tab.waitFor(
      `document.querySelector('[data-channel="live"]') !== null`,
      "the like control's channel to go live",
    );
    const mark = session.requests().length;
    await like(tab, POSTS.tenancy.id);
    await tab.waitFor(everyCount(POSTS.tenancy.id, 3), 'EVERY island to show 3 likes');

    // One write went out, and no island went back to the server to re-read what it now shows.
    expect(requestsSince(session, app.base, mark, /^POST .*\/api\/posts\/like/)).toHaveLength(1);
    expect(requestsSince(session, app.base, mark, /^GET .*\/_x\/query\//)).toEqual([]);
    // One socket for the page, however many islands it holds — and no reconnect along the way.
    expect(syncSockets(session, app.base)).toBe(1);
    // The islands move optimistically; the server's own render is the proof the write landed.
    await until(
      async () => (await serverLikeCount(app, 'ada', 'tenancy')) === 3,
      "the server's render to show 3 likes",
    );
  }, 60_000);
});
