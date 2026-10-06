/**
 * e2e — the deployed demo's one smoke, in a real browser against a freshly seeded app: a signed-out
 * visitor to an authed page is bounced to sign-in with their destination kept, the seeded demo
 * member (`user` / `user`, `packages/db/src/seed.ts`) signs in through the native form, and lands
 * on the page they asked for. Every hop is the server's — the sign-in page ships no script of
 * its own.
 *
 * Skipped only on a machine with no Chrome; `E2E_BROWSER_REQUIRED=1` refuses the skip.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import {
  allowHost,
  DEFAULT_CDP_TIMEOUT_MS,
  E2E_APP_START_MS,
  E2E_APP_STOP_MS,
  E2E_BROWSER_CLOSE_MS,
  E2E_BROWSER_OPEN_MS,
  E2E_GOTO_MS,
  E2E_TAB_OPEN_MS,
  findChrome,
  openE2eBrowser,
  startE2eApp,
} from '@ultimat3/testing';

/** The app root: `dummy/social-media-clone`, three directories above this file. */
const APP_ROOT = Bun.fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');

const noBrowser =
  (await findChrome(process.env)) === undefined && process.env['E2E_BROWSER_REQUIRED'] !== '1';

const pathOf = (tab: E2eTab): Promise<unknown> =>
  tab.evaluate('location.pathname + location.search');

describe.skipIf(noBrowser)('smoke: sign in and land where you were going', () => {
  let app: E2eApp;
  let browser: Awaited<ReturnType<typeof openE2eBrowser>>;
  let tab: E2eTab;

  beforeAll(
    async () => {
      app = await startE2eApp({ root: APP_ROOT });
      allowHost(new URL(app.base).host);
      browser = await openE2eBrowser();
      tab = await browser.session.newTab();
    },
    E2E_APP_START_MS + E2E_BROWSER_OPEN_MS + E2E_TAB_OPEN_MS + DEFAULT_CDP_TIMEOUT_MS,
  );

  afterAll(
    async () => {
      await tab?.close();
      await browser?.close();
      await app?.stop();
    },
    E2E_BROWSER_CLOSE_MS + E2E_APP_STOP_MS + DEFAULT_CDP_TIMEOUT_MS,
  );

  test('a signed-out visit to /dashboard signs in and comes back to /dashboard', async () => {
    await tab.goto(`${app.base}/dashboard`);
    await tab.waitFor(`location.pathname === '/signin'`, 'the bounce to sign-in');
    expect(await pathOf(tab)).toBe('/signin?next=%2Fdashboard');
    // `budget: { js: '0kb' }` on the sign-in route, observed: no script but the service worker's
    // registration, which the budget exempts by name (`FRAMEWORK_SCRIPTS`).
    expect(
      await tab.evaluate(
        `[...document.querySelectorAll('script[src]')].map((el) => new URL(el.src).pathname)`,
      ),
    ).toEqual(['/x-sw-register.js']);

    await tab.evaluate(`(() => {
      const form = document.querySelector('form[action="/api/sessions/create"]');
      form.querySelector('[name="handle"]').value = 'user';
      form.querySelector('[name="password"]').value = 'user';
      form.submit();
      return true;
    })()`);
    await tab.waitFor(
      `location.pathname === '/dashboard'`,
      'the landing after sign-in',
      E2E_GOTO_MS,
    );
    expect(await pathOf(tab)).toBe('/dashboard');
    expect(await tab.evaluate(`document.querySelector('h1') !== null`)).toBe(true);
  }, 60_000);
});
