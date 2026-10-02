// Client navigation in a real Chrome: the per-tab prefetch cache — emptied by a client write, by
// another tab, by time for a `no-store` page, and never holding a failure as an answer. Ordered
// by what the server recorded and what the page received (`recorded`, `landed`, `hold`), never by
// a sleep: a hover's prefetch leaves on a page timer, and a stalled renderer sends it late.
//
//   bun test packages/cli/e2e/client-navigation-cache.e2e.test.ts

import { describe, expect, test } from 'bun:test';
import {
  base,
  click,
  currentTab,
  hold,
  hover,
  landed,
  noBrowser,
  ran,
  read,
  recorded,
  session,
  start,
  state,
  TIMEOUT_MS,
  useBrowser,
} from './client-navigation-fixture';

/** What the typed client announces after every non-GET (`@ultimat3/core`'s `notifyClientWrite`). */
const WRITE = `globalThis[Symbol.for('ultimate.client-writes')].forEach((listener) => listener('/api/casos'))`;

/** A hover whose prefetch the server answered and the page holds. */
async function prefetched(id: string, path: string): Promise<void> {
  await hover(id);
  await recorded(`GET ${path} prefetch`);
  await landed(path);
}

describe.skipIf(noBrowser)('client navigation · the prefetch cache never answers stale', () => {
  useBrowser();

  // ── P1: the cache never answers with what a write, a principal or time made stale ─────────
  test(
    'a client write (the typed client) empties the cache — the click asks again',
    async () => {
      await start('/a');
      await prefetched('to-eager', '/eager');
      await read(WRITE);
      await click('to-eager');
      await currentTab().waitFor('document.title === "Eager"', 'Eager');
      expect(ran).toEqual(['GET /eager prefetch', 'GET /eager soft']);
    },
    TIMEOUT_MS,
  );

  test(
    'a prefetch still in flight when the write is announced never answers the click after it',
    async () => {
      await start('/a');
      const answer = hold('GET /eager prefetch');
      await hover('to-eager');
      await recorded('GET /eager prefetch');
      await read(WRITE);
      answer();
      await landed('/eager');
      await click('to-eager');
      await currentTab().waitFor('document.title === "Eager"', 'Eager');
      expect(ran).toEqual(['GET /eager prefetch', 'GET /eager soft']);
    },
    TIMEOUT_MS,
  );

  test(
    "a prefetch sent while the router's own POST was in flight never answers a click after it",
    async () => {
      await start('/a');
      const answer = hold('POST /submit soft');
      await read('document.getElementById("post").requestSubmit()');
      await recorded('POST /submit soft');
      await prefetched('to-eager', '/eager');
      answer();
      await currentTab().waitFor('document.title === "Done ada"', 'the POST to land');
      await click('to-eager');
      await currentTab().waitFor('document.title === "Eager"', 'Eager');
      expect(ran).toEqual([
        'POST /submit soft',
        'GET /eager prefetch',
        'GET /done soft',
        'GET /eager soft',
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    "another tab clearing (a sign-out, a write there) empties this tab's cache too",
    async () => {
      await start('/a');
      await prefetched('to-eager', '/eager');
      // Created after the router's own channel: a message reaches one document's channels oldest
      // first, so once this one has it the router's cache is already empty.
      await read(
        `new BroadcastChannel('ultimate:navigation').onmessage = () => { window.__cleared = true; }`,
      );
      const second = await session()?.session.newTab();
      if (second === undefined) return expect.unreachable('no second tab');
      try {
        await second.goto(`${base}/a`);
        await second.evaluate(`new BroadcastChannel('ultimate:navigation').postMessage('clear')`);
      } finally {
        await second.close();
      }
      await currentTab().waitFor('window.__cleared === true', "the other tab's message");
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
      await prefetched('to-eager-ns', '/eager-ns');
      // The rule under test IS elapsed time: the answer is older than 5 s at the click.
      await Bun.sleep(5_500);
      await click('to-eager-ns');
      await currentTab().waitFor('document.title === "Eager NS"', 'Eager NS');
      expect(ran).toEqual(['GET /eager-ns prefetch', 'GET /eager-ns soft']);
      await start('/a');
      await prefetched('to-eager-ns', '/eager-ns');
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
      await prefetched('to-flaky', '/flaky');
      await click('to-flaky');
      await currentTab().waitFor('document.title === "Flaky"', 'the page, not the 500');
      expect(ran).toEqual(['GET /flaky prefetch', 'GET /flaky soft']);
    },
    TIMEOUT_MS,
  );
});
