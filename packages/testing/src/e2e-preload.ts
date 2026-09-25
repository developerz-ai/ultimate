// The e2e step's own preload: when the gate names an app root (`ULTIMATE_E2E_ROOT`, set by
// `verify-e2e.ts`), spawn that app on a throwaway database and start one run over it
// (`e2e-run.ts`) with Bun's own hooks and a real browser. With no root named it is INERT.

import { afterAll, beforeEach } from 'bun:test';
import { openE2eBrowser } from './cdp-browser';
import { startE2eApp } from './e2e-app';
import { E2E_ROOT_ENV } from './e2e-browser-handle';
import { installE2eDriver } from './e2e-driver';
import { e2eDefaultLocale } from './e2e-locale';
import { startE2eRun } from './e2e-run';

const root = Bun.env[E2E_ROOT_ENV];
if (root !== undefined && root !== '') {
  // Read once, before the app boots: every browser this run opens — the first and every relaunch —
  // asks for the app's default locale, so a page's language never depends on the runner's Chrome.
  const acceptLanguage = await e2eDefaultLocale(root);
  await startE2eRun({
    app: await startE2eApp({ root }),
    // `openE2eBrowser`, never the `IfAvailable` door: the step only names a root after finding one.
    openBrowser: () => openE2eBrowser(acceptLanguage === undefined ? {} : { acceptLanguage }),
    install: installE2eDriver,
    beforeEach,
    afterAll,
  });
}
