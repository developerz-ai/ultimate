// The browser and the app the e2e step opened, reachable from a test file: `e2eBrowser()` and
// `e2eApp()`. On `globalThis` under one `Symbol.for` key, because the preload and a test may each
// hold their own copy of this module — the page-client handle's reason, one runtime over.

import type { E2eBrowser } from './cdp-browser';
import { CdpBrowserMissingError } from './cdp-errors';
import { CHROME_CANDIDATES } from './cdp-launch';
import type { E2eApp } from './e2e-app';

/** Set by the e2e step to the app root; the preload spawns that app and opens a browser. */
export const E2E_ROOT_ENV = 'ULTIMATE_E2E_ROOT';

interface E2eRun {
  browser: E2eBrowser;
  readonly app: E2eApp;
}

const KEY = Symbol.for('ultimate.e2e.run');

export function publishE2eRun(run: E2eRun): void {
  Object.defineProperty(globalThis, KEY, { value: run, configurable: true });
}

const current = (): E2eRun | undefined => Reflect.get(globalThis, KEY) as E2eRun | undefined;

/** Swap in a relaunched browser — the app stays; only the dead browser is replaced. */
export function republishE2eBrowser(browser: E2eBrowser): void {
  const run = current();
  if (run !== undefined) run.browser = browser;
}

const missing = (): CdpBrowserMissingError =>
  new CdpBrowserMissingError({ tried: CHROME_CANDIDATES });

/**
 * The run's browser: `page`, and `session` for a second tab, an init script, the socket and request
 * log and the offline switch for every worker. Refuses by name outside an e2e run that found one.
 */
export function e2eBrowser(): E2eBrowser {
  const run = current();
  if (run === undefined) throw missing();
  return run.browser;
}

/** The app the run spawned: `base`, `stateDir`, and `restart({ BUILD_ID })` — a deploy. */
export function e2eApp(): E2eApp {
  const run = current();
  if (run === undefined) throw missing();
  return run.app;
}

/** The spawned app's origin, or `undefined` outside an e2e run. */
export function e2eBaseUrl(): string | undefined {
  return current()?.app.base;
}
