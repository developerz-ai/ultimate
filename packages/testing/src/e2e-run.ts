// One e2e run: the app spawned, ONE browser opened and installed as the `page` fixture, a deploy
// wired as a restart of the app, a hung or deployed-under browser relaunched before the next test,
// and everything released after the last. The preload (`e2e-preload.ts`) is this with Bun's own
// hooks and the real app and browser; a test is this with doubles, which is how it is measured.

import { finiteCount } from '@ultimat3/core';
import type { E2eBrowser } from './cdp-browser';
import type { E2eApp } from './e2e-app';
import { e2eBrowser, publishE2eRun, republishE2eBrowser } from './e2e-browser-handle';
import type { E2eDriverOptions } from './e2e-driver';
import type { E2eBrowserPage } from './e2e-page';
import { answersWithin } from './e2e-probe';

/** How long a live browser gets to answer `1` before it is declared hung and relaunched. */
export const PROBE_MS = 5_000;

/**
 * The browser, or the app stopped: a browser that would not open left the spawned `x dev` child
 * running after the suite gave up — `cdp-browser.ts`'s own open-or-release shape, one level up.
 */
export async function openOrStop<T>(
  app: { stop(): Promise<void> },
  open: () => Promise<T>,
): Promise<T> {
  try {
    return await open();
  } catch (error) {
    await app.stop().catch(() => undefined);
    throw error;
  }
}

export interface E2eRunDeps {
  readonly app: E2eApp;
  readonly openBrowser: () => Promise<E2eBrowser>;
  readonly install: (options: E2eDriverOptions) => () => void;
  readonly beforeEach: (hook: () => Promise<void>) => void;
  readonly afterAll: (hook: () => Promise<void>) => void;
  readonly probeMs?: number | undefined;
}

export async function startE2eRun(deps: E2eRunDeps): Promise<void> {
  const probeMs = finiteCount('startE2eRun', 'probeMs', deps.probeMs ?? PROBE_MS, 1);
  const { app } = deps;
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
  let browser = await openOrStop(app, deps.openBrowser);
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
  const uninstall = deps.install({ page: current, baseUrl: app.base, newBuild });

  // A browser that stopped answering takes every later suite down with it, one call deadline per
  // call (run 8). So each test starts with a short probe, and a browser that fails it — or one a
  // deploy ran under — is closed and relaunched: the app is untouched, and the test gets a fresh
  // profile, a fresh SharedWorker and a fresh tab on the same origin.
  deps.beforeEach(async () => {
    const alive = !deployed && (await answersWithin(e2eBrowser().page, probeMs));
    if (alive) return;
    deployed = false;
    browser.close();
    browser = await deps.openBrowser();
    republishE2eBrowser(browser);
  });

  deps.afterAll(async () => {
    uninstall();
    browser.close();
    await app.stop();
  });
}
