// `time.detect` in a real Chrome, over the real pipeline under an ENFORCED policy: a new visitor's
// first `app/` page renders in the server's default zone; the zone script — admitted by its own
// hash and nothing looser — writes `x_timezone_detected`, and the reload renders in the browser's.
//
//   bun test packages/cli/e2e/zone-detect.e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { defineConfig, resetLifecycle, useContext } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, h, registerRoute } from '@ultimat3/render';
import { findChrome } from '@ultimat3/scraping/cdp';
import type { E2eBrowser, E2eBrowserLease, E2eTab } from '@ultimat3/testing';
import {
  E2E_BROWSER_OPEN_MS,
  E2E_TAB_OPEN_MS,
  leaseE2eBrowser,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
} from '@ultimat3/testing';
import { configureTime } from '@ultimat3/time';
import { clientScriptHeads } from '../src/client-vitals-route';
import { appRoutes } from '../src/runtime-render';
import { inlineScriptSources } from '../src/script-csp';
import { zoneBoot } from '../src/zone-boot';

const BUILD = 'zone-detect-build';
const TIMEOUT_MS = 45_000;
const WAIT_MS = 10_000;

// At file scope: a skipped suite's hooks do not run, and the registry and the default are global.
afterAll(() => {
  clearRoutes();
  resetLifecycle();
  configureTime({ defaultZone: 'UTC' });
});

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const noBrowser = chrome === undefined && !required;

describe.skipIf(noBrowser)('time.detect · the reload renders in the browser’s zone', () => {
  let lease: E2eBrowserLease | undefined;
  let browser: E2eBrowser | undefined;
  let tab: E2eTab;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base = '';

  beforeAll(async () => {
    registerRoute({
      file: 'apps/web/app/clock/page.tsx',
      config: defineRoute({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '1kb' },
        meta: () => ({ title: 'clock', description: 'the zone this request rendered in' }),
      }),
      component: (() => h('main', {}, h('p', { id: 'zone' }, useContext().tz))) as never,
    });
    const boot = zoneBoot(defineConfig({ name: 'clock', time: { detect: true } }).time);
    if (boot === undefined) expect.unreachable('time.detect: true boots the zone script');
    const pipeline = httpServer({
      routes: appRoutes({ buildId: BUILD, ...clientScriptHeads(undefined, undefined, boot) }),
      role: 'web',
      // `dev: false`: the policy is ENFORCED, so an unadmitted script would simply not run.
      config: defineHttpConfig({
        dev: false,
        buildId: BUILD,
        rateLimit: { enabled: false },
        security: { csp: { extend: { 'script-src': inlineScriptSources([boot.cspSource]) } } },
      }),
    });
    server = Bun.serve({ port: 0, fetch: (request) => pipeline.fetch(request) });
    base = `http://localhost:${String(server.port)}`;
    lease = leaseE2eBrowser('cli:zone-detect', () =>
      required ? openE2eBrowser() : openE2eBrowserIfAvailable(),
    );
    browser = await lease.opened;
    if (browser === undefined) expect.unreachable('a browser was found and then would not open');
    tab = await browser.session.newTab();
  }, E2E_BROWSER_OPEN_MS + E2E_TAB_OPEN_MS);

  afterAll(async () => {
    await tab?.close();
    await lease?.release();
    await server?.stop(true);
  }, E2E_BROWSER_OPEN_MS);

  test(
    'first paint is the default zone, the second is the browser’s own',
    async () => {
      await tab.goto('about:blank');
      const browserZone = await tab.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone');
      if (typeof browserZone !== 'string') expect.unreachable('the browser names its zone');
      // A default the browser is not in, so the two renders can only agree if detection failed.
      const fallback = browserZone === 'Pacific/Chatham' ? 'Atlantic/Azores' : 'Pacific/Chatham';
      configureTime({ defaultZone: fallback });

      await tab.goto(`${base}/clock`);
      expect(await tab.evaluate("document.getElementById('zone').textContent")).toBe(fallback);
      await tab.waitFor(
        "document.cookie.includes('x_timezone_detected=')",
        'the zone script to write its cookie',
        WAIT_MS,
      );
      await tab.reload();
      expect(await tab.evaluate("document.getElementById('zone').textContent")).toBe(browserZone);
    },
    TIMEOUT_MS,
  );
});
