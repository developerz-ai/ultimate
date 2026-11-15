// `press()` in a REAL browser: a key that types runs its default action, the way a keyboard does.
// Enter on a focused submit button submits its form; Tab moves focus. A `rawKeyDown` with no text
// raises no character event, so Enter submitted nothing — this file is that pin.
//
//   bun test ./packages/testing/src/cdp-e2e-page.e2e.test.ts
//
// Skips with no browser on the machine, and refuses to where `E2E_BROWSER_REQUIRED=1` promised one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findChrome } from '@ultimat3/scraping/cdp';
import type { E2eBrowser } from './cdp-browser';
import { E2E_BROWSER_OPEN_MS, openE2eBrowser } from './cdp-browser';

const FORM = `<!doctype html><html lang="en"><head><title>press</title></head><body><main>
<form id="f"><input name="q" aria-label="Query"><button type="submit" id="go">Go</button></form>
<button type="button" id="next">Next</button>
<script>
window.__submits = 0;
document.getElementById('f').addEventListener('submit', (event) => {
  event.preventDefault();
  window.__submits += 1;
});
</script></main></body></html>`;

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () => new Response(FORM, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
});
const baseUrl = `http://127.0.0.1:${String(server.port)}/`;

const noBrowser =
  (await findChrome(process.env)) === undefined && process.env['E2E_BROWSER_REQUIRED'] !== '1';

describe.skipIf(noBrowser)('press() runs the default action of a real key', () => {
  let browser: E2eBrowser | undefined;

  beforeAll(async () => {
    browser = await openE2eBrowser();
  }, E2E_BROWSER_OPEN_MS);

  afterAll(async () => {
    await browser?.close();
    server.stop(true);
  }, E2E_BROWSER_OPEN_MS);

  const page = () => browser?.page ?? expect.unreachable('no browser');

  test(
    'Enter on a focused submit button submits its form',
    async () => {
      await page().goto(baseUrl);
      await page().evaluate(`document.getElementById('go').focus()`);
      await page().press('Enter');
      await page().waitFor('window.__submits === 1', 'the form to submit on Enter', 5_000);
      expect(await page().evaluate('window.__submits')).toBe(1);
    },
    E2E_BROWSER_OPEN_MS,
  );

  test(
    'Tab moves focus to the next stop, and typed letters land in a focused field',
    async () => {
      await page().goto(baseUrl);
      await page().evaluate(`document.getElementById('go').focus()`);
      await page().press('Tab');
      expect(await page().evaluate('document.activeElement.id')).toBe('next');
      await page().evaluate(`document.querySelector('input').focus()`);
      await page().press('a');
      await page().press('7');
      expect(await page().evaluate(`document.querySelector('input').value`)).toBe('a7');
    },
    E2E_BROWSER_OPEN_MS,
  );
});
