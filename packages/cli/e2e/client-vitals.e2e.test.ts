// Real-user timings in a real Chrome, over the real pipeline: an `app/` page served with
// `clientErrors.vitals` on names `/x-client-vitals.js`, the browser observes its LCP, and leaving
// the page sends ONE beacon that lands as a `web_vital_seconds` sample under the route PATTERN.
// The server's own receipt is what the test waits on, never a clock.
//
//   bun test packages/cli/e2e/client-vitals.e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CLIENT_VITALS_DEFAULTS, collectMetrics, resetMetrics } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, h, registerRoute } from '@ultimat3/render';
import type { E2eBrowser, E2eBrowserLease, E2eTab } from '@ultimat3/testing';
import {
  E2E_BROWSER_OPEN_MS,
  E2E_TAB_OPEN_MS,
  findChrome,
  leaseE2eBrowser,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
} from '@ultimat3/testing';
import { clientScriptHeads, clientVitalsSurface } from '../src/client-vitals-route';
import { CLIENT_VITALS_PATH } from '../src/client-vitals-script';
import { appRoutes } from '../src/runtime-render';

const BUILD = 'client-vitals-build';
const TIMEOUT_MS = 45_000;
const WAIT_MS = 10_000;

// At file scope: a skipped suite's hooks do not run, and the registry is process-global.
afterAll(() => {
  clearRoutes();
  resetMetrics();
});

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const noBrowser = chrome === undefined && !required;

/** Every route as declared, the beacon's resolving the first time it has answered. */
function withReceipt(routes: readonly Route[]): { routes: Route[]; received: Promise<void> } {
  let resolve = (): void => undefined;
  const received = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    received,
    routes: routes.map((route) =>
      route.path !== CLIENT_VITALS_PATH
        ? route
        : {
            ...route,
            handler: async (request, ctx) => {
              const answer = await route.handler(request, ctx);
              resolve();
              return answer;
            },
          },
    ),
  };
}

describe.skipIf(noBrowser)('client vitals · a real page beacons its LCP on hide', () => {
  let lease: E2eBrowserLease | undefined;
  let browser: E2eBrowser | undefined;
  let tab: E2eTab;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let received: Promise<void>;
  let base = '';

  beforeAll(async () => {
    registerRoute({
      file: 'apps/web/app/posts/[id]/page.tsx',
      config: defineRoute({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '10kb' },
        meta: () => ({ title: 'a post', description: 'the page whose paint is measured' }),
      }),
      component: (() =>
        h('main', {}, h('h1', { id: 'headline' }, 'A headline large enough to paint'))) as never,
    });
    const vitals = clientVitalsSurface({ ...CLIENT_VITALS_DEFAULTS, enabled: true, sampleRate: 1 });
    if (vitals === undefined) expect.unreachable('vitals on mounts a surface');
    const receipt = withReceipt(vitals.routes);
    received = receipt.received;
    const pipeline = httpServer({
      routes: [
        ...receipt.routes,
        ...appRoutes({
          buildId: BUILD,
          ...clientScriptHeads(undefined, vitals),
          resolveIsland: () => () => expect.unreachable('this page ships no island'),
        }),
      ],
      role: 'web',
      config: defineHttpConfig({ dev: false, buildId: BUILD, rateLimit: { enabled: false } }),
    });
    server = Bun.serve({ port: 0, fetch: (request) => pipeline.fetch(request) });
    base = `http://localhost:${String(server.port)}`;
    lease = leaseE2eBrowser('cli:client-vitals', () =>
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
    'leaving the page lands one LCP sample under /posts/:id, never the concrete path',
    async () => {
      resetMetrics();
      await tab.goto(`${base}/posts/42`);
      // The page's own script observes the same entry; this one only says WHEN it exists.
      await tab.evaluate(
        "new PerformanceObserver(function(l){window.__lcp=l.getEntries().length}).observe({type:'largest-contentful-paint',buffered:true})",
      );
      await tab.waitFor('window.__lcp > 0', 'the browser to record a largest paint', WAIT_MS);
      // `pagehide` — the beacon's one moment — fires as the tab leaves the document.
      await tab.goto('about:blank');
      await received;

      const seconds = collectMetrics().metrics.find(
        (metric) => metric.descriptor.name === 'web_vital_seconds',
      );
      const lcp = (seconds?.points ?? []).filter((point) => point.attributes['metric'] === 'lcp');
      expect(lcp).toHaveLength(1);
      expect(lcp[0]?.attributes).toEqual({ route: '/posts/:id', metric: 'lcp' });
      expect(lcp[0] !== undefined && 'count' in lcp[0] ? lcp[0].count : 0).toBe(1);
    },
    TIMEOUT_MS,
  );
});
