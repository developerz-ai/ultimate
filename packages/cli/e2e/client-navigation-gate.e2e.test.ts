// Client navigation in a real Chrome: the server's gate and hand-over, counted in route runs. A
// hover runs nothing a page did not opt into; an evidence GET, a download, a `'document'` page run
// once; a POST is never sent twice; an answer that cannot be asked for again is shown, not re-run.
//
//   bun test packages/cli/e2e/client-navigation-gate.e2e.test.ts

import { describe, expect, test } from 'bun:test';
import {
  click,
  count,
  currentTab,
  hover,
  noBrowser,
  ran,
  read,
  sameDocument,
  session,
  start,
  state,
  TIMEOUT_MS,
  useBrowser,
} from './client-navigation-fixture';

describe.skipIf(noBrowser)(
  'client navigation · what a hover, a click or a form may execute',
  () => {
    useBrowser();

    // ── P0: what a hover or a click may execute ─────────────────────────────────────────────────
    test(
      'a hover runs NOTHING that did not opt into prefetch — not an evidence GET, not a page',
      async () => {
        await start('/a');
        await hover('to-evidence');
        await hover('to-download');
        await hover('to-b');
        await hover('to-doc');
        await Bun.sleep(500);
        expect(ran).toEqual([]);
      },
      TIMEOUT_MS,
    );

    test(
      'an opted-in page is prefetched once and the click is answered by it',
      async () => {
        await start('/a');
        await hover('to-eager');
        await Bun.sleep(400);
        await click('to-eager');
        await currentTab().waitFor('document.title === "Eager"', 'Eager');
        expect(ran).toEqual(['GET /eager prefetch']);
        expect(await sameDocument()).toBe(true);
      },
      TIMEOUT_MS,
    );

    test.each([
      [
        'an evidence GET (not a page)',
        'to-evidence',
        'GET /evidence',
        'document.body.textContent.includes("recorded")',
      ],
      ["a navigation: 'document' page", 'to-doc', 'GET /doc', 'document.title === "Doc"'],
      ['JSON', 'to-json', 'GET /data.json', 'document.body.textContent.includes("ok")'],
    ])(
      '%s is loaded by the browser and runs exactly once',
      async (_name, link, line, landed) => {
        await start('/a');
        await click(link);
        await currentTab().waitFor(`window.__kept === undefined && ${landed}`, 'the real load');
        expect(count(`${line} full`)).toBe(1);
        expect(ran.filter((one) => one.startsWith(line))).toEqual([`${line} full`]);
      },
      TIMEOUT_MS,
    );

    test(
      'a download link runs once — the browser saves it, nobody asks twice',
      async () => {
        await start('/a');
        await click('to-download');
        await Bun.sleep(1_500);
        expect(ran.filter((one) => one.startsWith('GET /download'))).toEqual([
          'GET /download full',
        ]);
      },
      TIMEOUT_MS,
    );

    test(
      'a POST answered with a download is handed over from the bytes received — one execution',
      async () => {
        await start('/a');
        await read('document.getElementById("export").requestSubmit()');
        await Bun.sleep(1_500);
        expect(ran).toEqual(['POST /export soft']);
        expect(await sameDocument()).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      'a POST that redirects to another origin (payment) runs once; the browser goes there',
      async () => {
        await start('/a');
        state.paid = 0;
        await read('document.getElementById("pay").requestSubmit()');
        await currentTab().waitFor('document.title === "Paid"', 'the other origin');
        expect(ran).toEqual(['POST /pay soft']);
        expect(state.paid).toBe(1);
      },
      TIMEOUT_MS,
    );

    test(
      'a POST that fails on the network is NEVER re-sent: the error event, and the page stays',
      async () => {
        await start('/b');
        await read(`document.addEventListener('ultimate:navigation-error', (e) => {
        e.preventDefault();
        window.__failed = e.detail.method + ' ' + e.detail.reason;
      })`);
        await session()?.session.offline(true);
        try {
          await read('document.getElementById("post").requestSubmit()');
          await currentTab().waitFor('window.__failed !== undefined', 'the error event');
        } finally {
          await session()?.session.offline(false);
        }
        await Bun.sleep(1_000);
        expect(await read('window.__failed')).toBe('POST the request failed on the network');
        expect(ran).toEqual([]);
        expect(await sameDocument()).toBe(true);
      },
      TIMEOUT_MS,
    );

    // ── Second review: an answer that cannot be asked for again ─────────────────────────────────
    test(
      "N2: a GET whose load wrote and then threw runs ONCE — the framework's error page is swapped",
      async () => {
        await start('/a');
        await click('to-boom');
        await currentTab().waitFor('document.title !== "A"', 'the error page');
        await Bun.sleep(500);
        expect(ran).toEqual(['GET /boom soft']);
        expect(await sameDocument()).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      'N1: a POST answered in place for another principal empties the cache and ends swapping',
      async () => {
        await start('/a');
        await hover('to-eager');
        await Bun.sleep(400);
        await read('document.getElementById("switch").requestSubmit()');
        await currentTab().waitFor('document.title === "Switched"', 'the answer in place');
        expect(await sameDocument()).toBe(true);
        await click('to-eager');
        await currentTab().waitFor(
          'window.__kept === undefined && document.title === "Eager"',
          'a real load',
        );
        // The prefetched answer (the old principal's) was never shown: the real load asked again.
        expect(ran).toEqual(['GET /eager prefetch', 'POST /switch soft', 'GET /eager full']);
      },
      TIMEOUT_MS,
    );
  },
);
