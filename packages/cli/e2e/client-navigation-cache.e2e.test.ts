// Client navigation in a real Chrome: the per-tab prefetch cache — emptied by a client write, by
// another tab, by time for a `no-store` page, and never holding a failure as an answer.
//
//   bun test packages/cli/e2e/client-navigation-cache.e2e.test.ts

import { describe, expect, test } from 'bun:test';
import {
  base,
  click,
  currentTab,
  hover,
  noBrowser,
  ran,
  read,
  session,
  start,
  state,
  TIMEOUT_MS,
  useBrowser,
} from './client-navigation-fixture';

describe.skipIf(noBrowser)('client navigation · the prefetch cache never answers stale', () => {
  useBrowser();

  // ── P1: the cache never answers with what a write, a principal or time made stale ─────────
  test(
    'a client write (the typed client) empties the cache — the click asks again',
    async () => {
      await start('/a');
      await hover('to-eager');
      await Bun.sleep(400);
      await read(
        `globalThis[Symbol.for('ultimate.client-writes')].forEach((listener) => listener('/api/casos'))`,
      );
      await click('to-eager');
      await currentTab().waitFor('document.title === "Eager"', 'Eager');
      expect(ran).toEqual(['GET /eager prefetch', 'GET /eager soft']);
    },
    TIMEOUT_MS,
  );

  test(
    "another tab clearing (a sign-out, a write there) empties this tab's cache too",
    async () => {
      await start('/a');
      await hover('to-eager');
      await Bun.sleep(400);
      const second = await session()?.session.newTab();
      if (second === undefined) return expect.unreachable('no second tab');
      try {
        await second.goto(`${base}/a`);
        await second.evaluate(`new BroadcastChannel('ultimate:navigation').postMessage('clear')`);
      } finally {
        await second.close();
      }
      await Bun.sleep(200);
      ran.length = 0;
      await click('to-eager');
      await currentTab().waitFor('document.title === "Eager"', 'Eager');
      expect(ran).toEqual(['GET /eager soft']);
    },
    TIMEOUT_MS,
  );

  test(
    'a no-store prefetch answers a click only within 5 s',
    async () => {
      await start('/a');
      await hover('to-eager-ns');
      await Bun.sleep(5_500);
      await click('to-eager-ns');
      await currentTab().waitFor('document.title === "Eager NS"', 'Eager NS');
      expect(ran).toEqual(['GET /eager-ns prefetch', 'GET /eager-ns soft']);
      await start('/a');
      await hover('to-eager-ns');
      await Bun.sleep(400);
      await click('to-eager-ns');
      await currentTab().waitFor('document.title === "Eager NS"', 'Eager NS');
      expect(ran).toEqual(['GET /eager-ns prefetch']);
    },
    TIMEOUT_MS,
  );

  test(
    'a failed prefetch is never the answer: the click asks again and shows the page',
    async () => {
      state.flaky = 0;
      await start('/a');
      await hover('to-flaky');
      await Bun.sleep(400);
      await click('to-flaky');
      await currentTab().waitFor('document.title === "Flaky"', 'the page, not the 500');
      expect(ran).toEqual(['GET /flaky prefetch', 'GET /flaky soft']);
    },
    TIMEOUT_MS,
  );
});
