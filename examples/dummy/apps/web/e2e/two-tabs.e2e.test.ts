/**
 * e2e — plan 101, done-when #2 and decision 7: two tabs of one origin share ONE `/_x/sync` socket
 * through a SharedWorker. A like in tab 1 shows in tab 2; closing tab 1 leaves tab 2 live with no
 * reconnect. With `SharedWorker` deleted before the page runs, the in-page fallback still works —
 * one socket per tab — which is the browser without the API.
 *
 * Kenji on "Nadie formatea…" (`/posts/{id}`, where the Like control is — the feed has none): he has
 * not liked it in the seed, and neither has bruno, whose like over HTTP is the second, server-side
 * change the surviving tab must see. Read from the page's ISLANDS: its byline count is rendered once.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import {
  everyCount,
  like,
  likeCounts,
  readNumbers,
  syncSockets,
  until,
} from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  acceptanceBrowser,
  likeOverHttp,
  noBrowser,
  POSTS,
  signInAs,
  startPostly,
} from './fixtures/postly';

const POST = POSTS.timezones.id;
const PAGE = `/posts/${POST}`;

const cases = [
  { name: 'with a SharedWorker — one socket for both tabs', initScript: undefined, sockets: 1 },
  {
    name: 'without one — the in-page fallback, one socket per tab',
    initScript: 'delete window.SharedWorker;',
    sockets: 2,
  },
] as const;

describe.skipIf(noBrowser)('two tabs, one origin', () => {
  for (const shape of cases) {
    // An app per case: each likes the same two posts, so the second needs the seed back.
    describe(shape.name, () => {
      let app: E2eApp;
      let browser: AcceptanceBrowser;
      let one: E2eTab;
      let two: E2eTab;

      beforeAll(async () => {
        app = await startPostly();
        browser = await acceptanceBrowser(shape.initScript);
        await signInAs(browser.session, app, 'kenji');
        one = await browser.session.newTab();
        two = await browser.session.newTab();
        await one.goto(`${app.base}${PAGE}`);
        await two.goto(`${app.base}${PAGE}`);
      }, 240_000);

      afterAll(async () => {
        await two?.close();
        browser?.close();
        await app?.stop();
      });

      test('the tabs share the expected number of sockets, and a like crosses between them', async () => {
        const { session } = browser;
        // Ada liked it in the seed: 1. The case below reads its own baseline rather than this 2.
        await one.waitFor(everyCount(POST, 1), 'tab one to render the post');
        await two.waitFor(everyCount(POST, 1), 'tab two to render the post');
        await until(
          () => syncSockets(session, app.base) >= shape.sockets,
          'the sync sockets to open',
        );
        expect(syncSockets(session, app.base)).toBe(shape.sockets);

        await like(one, POST);
        await two.waitFor(everyCount(POST, 2), "tab two to show tab one's like");
      }, 60_000);

      test('closing one tab leaves the other live, with zero reconnects', async () => {
        // Its own baseline, read off the surviving tab: whatever the case above did or did not
        // leave behind, bruno's like is one more than this.
        await two.waitFor(`${likeCounts(POST)}.length > 0`, 'tab two to render the post');
        const [before] = await readNumbers(two, likeCounts(POST));
        if (typeof before !== 'number') return expect.unreachable('tab two shows no like count');
        await until(() => syncSockets(browser.session, app.base) >= 1, 'a sync socket to open');
        const opened = syncSockets(browser.session, app.base);
        await one.close();
        await likeOverHttp(app, 'bruno', 'timezones');
        await two.waitFor(
          everyCount(POST, before + 1),
          'the surviving tab to see a change nobody in this browser made',
        );
        expect(syncSockets(browser.session, app.base)).toBe(opened);
      }, 60_000);
    });
  }
});
