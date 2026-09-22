// The e2e step's own preload: when the gate names an app root (`ULTIMATE_E2E_ROOT`, set by
// `verify-e2e.ts`), spawn that app on a throwaway database, open ONE browser, install it as the
// `page` fixture and the `e2eTest` driver, register `deploy.newBuild()` as a restart of the app on
// its own port, and hand both to any test that asks `e2eBrowser()` / `e2eApp()`.

import { afterAll, beforeEach } from 'bun:test';
import type { E2eBrowser } from './cdp-browser';
import { openE2eBrowser } from './cdp-browser';
import { startE2eApp } from './e2e-app';
import { E2E_ROOT_ENV, e2eBrowser, publishE2eRun, republishE2eBrowser } from './e2e-browser-handle';
import { installE2eDriver } from './e2e-driver';
import type { E2eBrowserPage } from './e2e-page';
import { answersWithin } from './e2e-probe';

/** How long a live browser gets to answer `1` before it is declared hung and relaunched. */
const PROBE_MS = 5_000;

const root = Bun.env[E2E_ROOT_ENV];
if (root !== undefined && root !== '') {
  const app = await startE2eApp({ root });
  let builds = 0;
  // A deploy leaves the browser holding the OLD build's state: a SharedWorker whose socket went
  // down with the restart and is now deep in its reconnect backoff, and tabs rendered by the old
  // build. The test that deployed asserts on exactly that; the NEXT test must not inherit it.
  let deployed = false;
  const newBuild = async (): Promise<void> => {
    deployed = true;
    builds += 1;
    await app.restart({ BUILD_ID: `e2e-build-${String(builds)}-${String(Date.now())}` });
  };
  // `openE2eBrowser`, never the `IfAvailable` door: the step only names a root after finding one.
  let browser: E2eBrowser = await openE2eBrowser();
  publishE2eRun({ browser, app });
  // Installed ONCE, over a page that delegates to whichever browser is current: an `e2eTest` body
  // is bound to its fixtures when the file DEFINES it, so reinstalling on a relaunch would leave
  // every test defined before it driving a closed browser.
  const current: E2eBrowserPage = {
    url: () => browser.page.url(),
    goto: (url, options) => browser.page.goto(url, options),
    evaluate: (expression) => browser.page.evaluate(expression),
    click: (selector) => browser.page.click(selector),
    offline: (enabled) => browser.page.offline(enabled),
  };
  const uninstall = installE2eDriver({ page: current, baseUrl: app.base, newBuild });

  // A browser that stopped answering takes every later suite down with it, one call deadline per
  // call (run 8). So each test starts with a short probe, and a browser that fails it — or one a
  // deploy ran under — is closed and relaunched: the app is untouched, and the test gets a fresh
  // profile, a fresh SharedWorker and a fresh tab on the same origin.
  beforeEach(async () => {
    const alive = !deployed && (await answersWithin(e2eBrowser().page, PROBE_MS));
    if (alive) return;
    deployed = false;
    browser.close();
    browser = await openE2eBrowser();
    republishE2eBrowser(browser);
  });

  afterAll(async () => {
    uninstall();
    browser.close();
    await app.stop();
  });
}
