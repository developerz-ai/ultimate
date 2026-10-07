// `waitForServiceWorker()` against a REAL worker that never claims the page it was registered
// from — the first page of a run, deterministically (#678). Before the handover the wait spent
// its whole budget and refused `X_E2E_SERVICE_WORKER_ABSENT` on a page with a perfectly good
// worker; now the page is reloaded once, the reload is answered by the worker, and it is control.
//
//   bun test packages/testing/e2e/service-worker-handover.e2e.test.ts
//
// Skips with no browser, refuses to skip under `E2E_BROWSER_REQUIRED=1` — `cdp-browser.e2e.test.ts`
// states why.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PageLike } from '@ultimat3/testing';
import type { E2eBrowser } from '../src/cdp-browser';
import { E2E_BROWSER_OPEN_MS, openE2eBrowser, openE2eBrowserIfAvailable } from '../src/cdp-browser';
import { findChrome } from '../src/cdp-launch';
import { e2ePage } from '../src/e2e-page';

// Registered on `load`, as the framework's own `x-sw-register.js` does — so the document is
// committed before the worker activates. The worker skips waiting and does NOT claim: the one
// shape in which the first page is guaranteed to stay uncontrolled.
const DOCUMENT = `<!doctype html>
<html lang="en"><head><title>Handover</title></head><body><h1>Handover</h1>
<script>addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));</script>
</body></html>`;

const WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));`;

const server = Bun.serve({
  port: 0,
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (path === '/sw.js') {
      return new Response(WORKER, {
        headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' },
      });
    }
    return new Response(DOCUMENT, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});
// `localhost`: a service worker needs a secure context, and it is the insecure origin that is one.
const baseUrl = `http://localhost:${String(server.port)}`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
console.log(
  chrome === undefined
    ? `sw handover e2e browser: none found${required ? ' — and one was required' : ' — skipping'}`
    : `sw handover e2e browser: ${chrome}`,
);

let browser: E2eBrowser | undefined;
let page: PageLike;

describe.skipIf(chrome === undefined && !required)('the first page of a run, handed over', () => {
  beforeAll(async () => {
    browser = required ? await openE2eBrowser() : await openE2eBrowserIfAvailable();
    if (browser === undefined) expect.unreachable('a browser was found and then would not open');
    page = e2ePage({ page: browser.page, baseUrl });
  }, E2E_BROWSER_OPEN_MS);

  afterAll(async () => {
    await browser?.close();
    server.stop(true);
  }, E2E_BROWSER_OPEN_MS);

  test('a worker that never claims the page still ends up controlling it', async () => {
    await page.goto('/runs');
    expect(await page.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true);
    await page.waitForServiceWorker();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    expect(page.url()).toBe(`${baseUrl}/runs`);
  }, 45_000);
});
