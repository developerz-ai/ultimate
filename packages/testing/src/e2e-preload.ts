// The e2e step's own preload: when the gate names an app root (`ULTIMATE_E2E_ROOT`, set by
// `verify-e2e.ts`), spawn that app on a throwaway database and start one run over it
// (`e2e-run.ts`) with Bun's own hooks and a real browser. With no root named it is INERT.

import { afterAll, beforeEach } from 'bun:test';
import { DETECTED_ZONE_COOKIE } from '@ultimat3/render';
import type { E2eBrowser } from './cdp-browser';
import { openE2eBrowser } from './cdp-browser';
import { startE2eApp } from './e2e-app';
import { E2E_ROOT_ENV } from './e2e-browser-handle';
import { installE2eDriver } from './e2e-driver';
import { e2eDefaultLocale } from './e2e-locale';
import { startE2eRun } from './e2e-run';

/** Seed the same device zone a rendered document would report before the browser can navigate. */
export async function seedDetectedZone(
  browser: E2eBrowser,
  origin: string,
  timeZone: string,
): Promise<E2eBrowser> {
  await browser.session.setCookie(origin, DETECTED_ZONE_COOKIE, timeZone);
  return browser;
}

const root = Bun.env[E2E_ROOT_ENV];
if (root !== undefined && root !== '') {
  // Read once, before the app boots: every browser this run opens — the first and every relaunch —
  // asks for the app's default locale, so a page's language never depends on the runner's Chrome.
  const acceptLanguage = await e2eDefaultLocale(root);
  const app = await startE2eApp({ root });
  const timeZone = Bun.env['TZ'] ?? 'UTC';
  const openBrowser = async (): Promise<E2eBrowser> => {
    const browser = await openE2eBrowser(acceptLanguage === undefined ? {} : { acceptLanguage });
    return seedDetectedZone(browser, app.base, timeZone);
  };
  await startE2eRun({
    app,
    // `openE2eBrowser`, never the `IfAvailable` door: the step only names a root after finding one.
    openBrowser,
    install: installE2eDriver,
    beforeEach,
    afterAll,
  });
}
