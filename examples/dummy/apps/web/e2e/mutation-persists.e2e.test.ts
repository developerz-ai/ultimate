/**
 * e2e — plan 101, done-when #7: `useMutation` PERSISTS, under `x dev` and under the production entry
 * `apps/web/server.ts`. Writes go over HTTP only (decision 2), so both hosts must carry them; the
 * old socket path answered `X_NOT_IMPLEMENTED` under `serve.ts`. The proof is the server's own
 * render after a reload, never the optimistic count.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import { everyCount, like, until } from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  acceptanceBrowser,
  noBrowser,
  POSTS,
  serverLikeCount,
  signInAs,
  startPostly,
} from './fixtures/postly';

const hosts = [
  { name: 'under x dev', mode: 'dev' },
  { name: 'under apps/web/server.ts', mode: 'serve' },
] as const;

describe.skipIf(noBrowser)('a like written through useMutation', () => {
  for (const host of hosts) {
    describe(host.name, () => {
      let app: E2eApp;
      let browser: AcceptanceBrowser;
      let tab: E2eTab;

      beforeAll(async () => {
        app = await startPostly(host.mode);
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

      test('is still there after a reload, because the server stored it', async () => {
        // Read from the ISLANDS: the page's byline count is server-rendered once and never moves.
        await tab.waitFor(everyCount(POSTS.tenancy.id, 2), 'the seeded count');
        await like(tab, POSTS.tenancy.id);
        await tab.waitFor(everyCount(POSTS.tenancy.id, 3), 'the like to show');
        await until(
          async () => (await serverLikeCount(app, 'ada', 'tenancy')) === 3,
          'the server to store the like',
        );
        await tab.reload();
        await tab.waitFor(everyCount(POSTS.tenancy.id, 3), 'the like to survive a reload');
        expect(await serverLikeCount(app, 'ada', 'tenancy')).toBe(3);
      }, 60_000);
    });
  }
});
