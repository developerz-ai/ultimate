// The audit in a REAL browser, through the same runner `installE2eDriver` registers every
// `e2eTest` with: an unnamed button fails its test with the code, naming it passes, an `allow`
// with no reason is refused before the body runs, and a dialog opened after `goto` is caught at
// the end of the body. The role spellings are the browser's, so this file is their pin.
//
//   bun test packages/testing/src/e2e-a11y.e2e.test.ts
//
// Skips with no browser on the machine, and refuses to where `E2E_BROWSER_REQUIRED=1` promised one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eBrowser } from './cdp-browser';
import { E2E_BROWSER_CLOSE_MS, E2E_BROWSER_OPEN_MS, openE2eBrowser } from './cdp-browser';
import { findChrome } from './cdp-launch';
import { e2eRunner } from './e2e-driver';
import type { E2eBody } from './test-types';

const doc = (body: string, head = '<title>A11y fixture</title>', lang = ' lang="en"'): string =>
  `<!doctype html><html${lang}><head>${head}</head><body><main>${body}</main></body></html>`;

const PAGES: Readonly<Record<string, string>> = {
  '/unnamed': doc('<h1>Feed</h1><button type="button" id="close"></button>'),
  '/named': doc(
    '<h1>Feed</h1><button type="button" aria-label="Close">×</button><img src="/x.png" alt="">',
  ),
  '/dialog': doc(
    `<h1>Feed</h1><button type="button" id="open" onclick="document.body.insertAdjacentHTML('beforeend', '<dialog open><button id=dismiss></button></dialog>')">Open</button>`,
  ),
  '/bare': doc('<h1>Bare</h1>', '', ''),
  '/hidden': doc('<h1>Feed</h1><div aria-hidden="true"><a href="/named">still tabbable</a></div>'),
};

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request: Request): Response {
    if (new URL(request.url).pathname === '/data.json') return Response.json({ rows: [] });
    const html = PAGES[new URL(request.url).pathname];
    return html === undefined
      ? new Response('', { status: 404 })
      : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});
const baseUrl = `http://127.0.0.1:${String(server.port)}`;

const noBrowser =
  (await findChrome(process.env)) === undefined && process.env['E2E_BROWSER_REQUIRED'] !== '1';

/** What the run threw, as text — or that it passed. */
const outcome = async (run: Promise<void>): Promise<string> => {
  try {
    await run;
    return 'passed';
  } catch (error) {
    return String(error);
  }
};

describe.skipIf(noBrowser)('every e2eTest audits the browser’s accessibility tree', () => {
  let browser: E2eBrowser;

  beforeAll(async () => {
    browser = await openE2eBrowser();
  }, E2E_BROWSER_OPEN_MS);

  afterAll(async () => {
    await browser?.close();
    server.stop(true);
  }, E2E_BROWSER_CLOSE_MS);

  const visit =
    (path: string): E2eBody =>
    async ({ page }) => {
      await page.goto(path);
    };
  const runner = () => e2eRunner({ page: browser.page, baseUrl });

  test('a page with one unnamed button fails its test with the code and the element', async () => {
    const told = await outcome(runner().run(visit('/unnamed')));
    expect(told).toContain('X_E2E_A11Y_VIOLATION');
    expect(told).toContain('name button');
    expect(told).toContain('id=\\"close\\"');
    expect(told).toContain(`${baseUrl}/unnamed`);
  });

  test('naming it passes — and a decorative alt="" image is no finding', async () => {
    expect(await outcome(runner().run(visit('/named')))).toBe('passed');
  });

  test('a reasoned allow for that element passes; one with no because is refused', async () => {
    const allow = { role: 'button', selector: '#close', because: 'fixture: the unnamed control' };
    expect(await outcome(runner().run(visit('/unnamed'), { allow: [allow] }))).toBe('passed');
    let ran = false;
    const refused = await outcome(
      runner().run(
        async () => {
          ran = true;
        },
        { allow: [{ ...allow, because: ' ' }] },
      ),
    );
    expect(refused).toContain('X_E2E_A11Y_VIOLATION');
    expect(refused).toContain('because');
    expect(ran).toBe(false);
  });

  test('a dialog the body opened after goto is caught at the end of the body', async () => {
    const told = await outcome(
      runner().run(async ({ page }) => {
        await page.goto('/dialog');
        await page.locator('#open').click();
      }),
    );
    expect(told).toContain('X_E2E_A11Y_VIOLATION');
    expect(told).toContain('dismiss');
  });

  test('the in-page probe: no <title>, no <html lang>, and a link tabbable under aria-hidden', async () => {
    const bare = await outcome(runner().run(visit('/bare')));
    expect(bare).toContain('title RootWebArea');
    expect(bare).toContain('lang RootWebArea "<html>"');
    const hidden = await outcome(runner().run(visit('/hidden')));
    expect(hidden).toContain('aria-hidden-focus focusable');
    expect(hidden).toContain('still tabbable');
  });

  test('a document that is not markup — JSON in the browser’s own viewer — is not judged', async () => {
    expect(await outcome(runner().run(visit('/data.json')))).toBe('passed');
  });
});
