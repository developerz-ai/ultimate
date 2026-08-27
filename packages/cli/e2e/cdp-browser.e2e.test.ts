// A REAL browser against a real socket — the check issue #390's fourth requirement asks for, and
// the one thing no fake can stand in for. It launches Chrome over raw CDP, drives it through the
// same `e2ePage()` adapter an app's suite gets, and asserts each of the five port methods against
// a page whose behaviour the test controls.
//
//   bun test packages/cli/e2e
//
// **It SKIPS when this machine has no browser, and REFUSES to skip where one was promised.**
// `openE2eBrowserIfAvailable` answers `undefined` and the whole describe skips, so a laptop
// without Chrome never turns the `e2e` step red for a reason unrelated to the change.
//
// A silent skip is the false green this tree keeps re-shipping, and it shipped here too: the
// first CI run of this file spent **2,958ms** on an `e2e` step that takes 31s locally, and the
// step reported green having driven no browser at all. So `E2E_BROWSER_REQUIRED=1` — which
// `ci.yml` sets — turns the skip into a refusal, and the file always prints which browser it
// found or that it found none. `@ultimat3/ai`'s `pg-vector.live.test.ts` is the precedent: it
// refuses to skip when the extension is missing, for the same reason.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PageLike } from '@ultimat3/testing';
import type { E2eBrowser } from '../src/cdp-browser';
import { openE2eBrowser, openE2eBrowserIfAvailable } from '../src/cdp-browser';
import { findChrome } from '../src/cdp-launch';
import { e2ePage } from '../src/e2e-page';

// The page under test. Deliberately hand-written HTML rather than a rendered app: what is being
// proved here is the DRIVER, so anything the framework could get wrong on the way to the document
// would be a second variable in the same assertion.
const DOCUMENT = `<!doctype html>
<html lang="en"><head><title>Driver fixture</title></head>
<body>
  <h1>Feed</h1>
  <p id="status">idle</p>
  <button type="button" id="like" onclick="document.getElementById('status').textContent = 'liked'">Like</button>
  <a href="/second">second</a>
</body></html>`;

const SECOND = `<!doctype html>
<html lang="en"><head><title>Second</title></head><body><h1>Second</h1></body></html>`;

const server = Bun.serve({
  port: 0,
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    const html = path === '/second' ? SECOND : DOCUMENT;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});
const baseUrl = `http://localhost:${String(server.port)}`;

/** Set where a browser is guaranteed, so an absent one is a finding rather than a quiet skip. */
export const BROWSER_REQUIRED_ENV = 'E2E_BROWSER_REQUIRED';

// Asked at module scope, because `describe.skipIf` takes a value and not a promise. The launch
// itself is still in `beforeAll` — one browser for the file, closed in `afterAll`.
const chrome = await findChrome(process.env);
const required = process.env[BROWSER_REQUIRED_ENV] === '1';

// Printed on every run, both ways. A skip that says nothing reads exactly like a pass.
console.log(
  chrome === undefined
    ? `e2e browser: none found${required ? ' — and one was required' : ' — skipping'}`
    : `e2e browser: ${chrome}`,
);

// Bun's default is 5000ms for a test AND for a hook, and a cold Chrome launch alone can spend
// most of that. A budget that expires mid-launch reports "timed out" over whatever the browser was
// actually doing, which is the one failure mode a driver test must not have.
const HOOK_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;

/** The fixture's one piece of mutable state, read back out of the live document. */
const status = (): Promise<unknown> =>
  page.evaluate(() => document.getElementById('status')?.textContent);

let browser: E2eBrowser | undefined;
let page: PageLike;

describe.skipIf(chrome === undefined && !required)('the raw-CDP browser drives a real page', () => {
  beforeAll(async () => {
    // `openE2eBrowser`, not the `IfAvailable` door, when one was required: its refusal is
    // `X_CDP_BROWSER_MISSING`, which names every path it tried and how to point it at a binary.
    browser = required ? await openE2eBrowser() : await openE2eBrowserIfAvailable();
    if (browser === undefined) expect.unreachable('a browser was found and then would not open');
    page = e2ePage({ page: browser.page, baseUrl });
  }, HOOK_TIMEOUT_MS);

  afterAll(() => {
    browser?.close();
  }, TEST_TIMEOUT_MS);

  test(
    'goto navigates and url() answers where the page actually is',
    async () => {
      await page.goto('/');
      expect(page.url()).toBe(`${baseUrl}/`);

      await page.goto('/second');
      expect(page.url()).toBe(`${baseUrl}/second`);
      expect(await page.title()).toBe('Second');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'evaluate crosses a closure into the page and brings a value back',
    async () => {
      await page.goto('/');

      expect(await page.evaluate(() => document.title)).toBe('Driver fixture');
      // Proves the value came from the BROWSER and not from this process: `navigator` exists in one
      // realm only, and an adapter that quietly evaluated locally would throw rather than answer.
      expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a locator resolves against the live document',
    async () => {
      await page.goto('/');

      expect(await page.getByRole('heading', { level: 1 }).isVisible()).toBe(true);
      expect(await page.locator('button').count()).toBe(1);
      expect(await page.getByText('idle').isVisible()).toBe(true);
      expect(await page.locator('#missing').count()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'click reaches the page and the handler runs',
    async () => {
      await page.goto('/');
      expect(await status()).toBe('idle');

      await page.getByRole('button', { name: 'Like' }).click();

      // The handler paints synchronously, so the awaited click IS the wait — a retrying assertion
      // here would pass even if the click had done nothing until seconds later.
      expect(await status()).toBe('liked');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'offline() sets the browser condition the page can see, and online() takes it back',
    async () => {
      await page.goto('/');
      const setOffline = browser?.page.offline;
      if (setOffline === undefined) expect.unreachable('the CDP page declares offline()');

      await setOffline.call(browser?.page, true);
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);

      await setOffline.call(browser?.page, false);
      expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

afterAll(() => {
  server.stop(true);
});
