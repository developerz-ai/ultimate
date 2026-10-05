// A tag-only ISR page goes stale when its tag is busted. `appRoutes` builds the page routes for
// both boots; a controller nobody attached never hears `invalidateTags`, so a `revalidate: { tags }`
// page (no TTL) served its first render for the life of the process (plan 101, `s2-con #1`).

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { invalidateTags, isolateGraph, tag } from '@ultimat3/cache';
import type { LogSink } from '@ultimat3/core';
import { setLogSink } from '@ultimat3/core';
import { createServer, defineHttpConfig, setRedirect } from '@ultimat3/http';
import { clearRoutes, defineRoute, h, registerRoute } from '@ultimat3/render';
import { createIsrController } from '@ultimat3/render/server';
import { attachedIsr } from './runtime-isr';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'isr-under-test';
const postTag = tag('post');
let version = 1;
let loads = 0;
let redirectTo: string | undefined;
/** When set, `load` waits on it before answering — how a test holds two misses in one flight. */
let gate: Promise<void> | undefined;
/** When set, each `load` run redirects to the target its run number picks. */
let redirectByRun: ((run: number) => string) | undefined;

function registerTagOnlyPage(): void {
  registerRoute({
    file: 'apps/web/site/blog/page.tsx',
    component: () => h('p', {}, `version ${version}`),
    config: defineRoute({
      render: 'isr',
      revalidate: { tags: [postTag] },
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: () => ({ title: 'Blog', description: 'a tag-only isr page' }),
    }),
  });
}

const restoreGraph = isolateGraph();

afterEach(() => {
  clearRoutes();
  version = 1;
  loads = 0;
  redirectTo = undefined;
  gate = undefined;
  redirectByRun = undefined;
});

afterAll(() => {
  // The revalidator slot is process-global: hand it back empty, through the same detach.
  createIsrController().attach()();
  restoreGraph();
});

const serverOver = (routes: ReturnType<typeof appRoutes>) =>
  createServer({
    routes,
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

/** Render v1, bump the source to v2, bust the tag; answer what the next two requests served. */
async function bustCycle(routes: ReturnType<typeof appRoutes>): Promise<readonly string[]> {
  const server = serverOver(routes);
  const get = () => server.fetch(new Request('http://dev.test/blog'));
  const first = await get();
  expect(await first.text()).toContain('version 1');
  version = 2;
  await invalidateTags([postTag]);
  const second = await get();
  const secondBody = await second.text();
  // The stale copy is answered while the regeneration runs behind it: polled until it lands, with
  // a deadline, never a fixed wait a loaded runner can outlast.
  let third = '';
  for (const started = Date.now(); Date.now() - started < 10_000; await Bun.sleep(5)) {
    third = await (await get()).text();
    if (third.includes('version 2')) break;
  }
  return [second.headers.get('x-ultimate-isr') ?? 'fresh', secondBody, third];
}

describe('unit · a tag bust reaches the ISR page', () => {
  test('appRoutes with no controller of its own attaches the one it builds', async () => {
    registerTagOnlyPage();
    const [state, stale, fresh] = await bustCycle(appRoutes({ buildId: BUILD_ID }));
    expect(state).toBe('stale');
    expect(stale).toContain('version 1');
    expect(fresh).toContain('version 2');
  });

  test('attachedIsr is the boots’ controller: attached, and released by its own detach', async () => {
    registerTagOnlyPage();
    const { isr, release } = attachedIsr({ buildId: BUILD_ID });
    const [state, , fresh] = await bustCycle(appRoutes({ buildId: BUILD_ID, isr }));
    expect(state).toBe('stale');
    expect(fresh).toContain('version 2');

    // A page is stored and fresh, or the check below would pass over an empty store.
    expect(isr.store().paths().length).toBeGreaterThan(0);
    release();
    version = 3;
    await invalidateTags([postTag]);
    // Released: the bust no longer reaches this controller's store.
    expect(
      isr
        .store()
        .paths()
        .every((path) => isr.store().get(path)?.stale === false),
    ).toBe(true);
  });
});

/** A route component's props are untyped: the version `load` returned, read without a cast. */
const versionOf = (data: unknown): string =>
  typeof data === 'object' && data !== null && 'version' in data ? String(data.version) : '?';

/** A `ttl` isr page whose `load` counts its runs and redirects while `redirectTo` is set. */
function registerLoadedPage(): void {
  registerRoute<{ version: number }>({
    file: 'apps/web/site/pricing/page.tsx',
    component: (props) => h('p', {}, `version ${versionOf(props['data'])}`),
    config: defineRoute<{ version: number }>({
      render: 'isr',
      revalidate: { ttl: '5m' },
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      load: async () => {
        loads += 1;
        const run = loads;
        if (gate !== undefined) await gate;
        if (redirectByRun !== undefined) setRedirect(redirectByRun(run), 302);
        if (redirectTo !== undefined) setRedirect(redirectTo, 302);
        return { version };
      },
      meta: () => ({ title: 'Pricing', description: 'an isr page with a load' }),
    }),
  });
}

describe('unit · an isr hit is a cache read, not a render (K3)', () => {
  test('an isr hit does not run load', async () => {
    registerLoadedPage();
    const { isr, release } = attachedIsr({ buildId: BUILD_ID });
    const server = serverOver(appRoutes({ buildId: BUILD_ID, isr }));
    for (let i = 0; i < 5; i += 1) {
      const response = await server.fetch(new Request('http://dev.test/pricing'));
      expect(await response.text()).toContain('version 1');
    }
    release();
    // One miss rendered the page; the four hits answered from the store without touching `load`.
    expect(loads).toBe(1);
    expect(isr.store().paths()).toHaveLength(1);
  });

  test("a load's redirect under isr is answered, never stored, and decided again next time", async () => {
    registerLoadedPage();
    const { isr, release } = attachedIsr({ buildId: BUILD_ID });
    const server = serverOver(appRoutes({ buildId: BUILD_ID, isr }));
    redirectTo = '/pricing-2026';
    for (let i = 0; i < 2; i += 1) {
      const response = await server.fetch(new Request('http://dev.test/pricing'));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/pricing-2026');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(loads).toBe(2);
    expect(isr.store().paths()).toHaveLength(0);
    // The loader stops redirecting: the next request renders and stores the page.
    redirectTo = undefined;
    const page = await server.fetch(new Request('http://dev.test/pricing'));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('version 1');
    expect(isr.store().paths()).toHaveLength(1);
    release();
  });

  test('a stale page whose regeneration redirects is dropped, so the next request redirects', async () => {
    registerLoadedPage();
    const { isr, release } = attachedIsr({ buildId: BUILD_ID });
    const server = serverOver(appRoutes({ buildId: BUILD_ID, isr }));
    expect((await server.fetch(new Request('http://dev.test/pricing'))).status).toBe(200);
    const [path] = isr.store().paths();
    isr.markStale(path ?? '');
    redirectTo = '/moved';
    const lines: string[] = [];
    const collect: LogSink = (line) => {
      lines.push(line);
    };
    const previous = setLogSink(collect);
    try {
      // The stale copy answers this one; the regeneration behind it finds the redirect.
      expect((await server.fetch(new Request('http://dev.test/pricing'))).status).toBe(200);
      let status = 0;
      for (const started = Date.now(); Date.now() - started < 10_000; await Bun.sleep(5)) {
        status = (await server.fetch(new Request('http://dev.test/pricing'))).status;
        if (status === 302) break;
      }
      expect(status).toBe(302);
    } finally {
      setLogSink(previous);
    }
    // A redirect is an outcome, not a failed regeneration: nothing is thrown into the controller.
    expect(lines.filter((line) => line.includes('isr.regenerate.failed'))).toEqual([]);
    expect(isr.store().paths()).toHaveLength(0);
    release();
  });

  test("two concurrent misses whose loads redirect differently each get their own load's Location", async () => {
    registerLoadedPage();
    const { isr, release } = attachedIsr({ buildId: BUILD_ID });
    let open = (): void => undefined;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    redirectByRun = (run) => `/moved-${String(run)}`;
    const [route] = appRoutes({ buildId: BUILD_ID, isr });
    if (route === undefined) return expect.unreachable('appRoutes projected no route');
    let arrived = 0;
    // The handler is entered synchronously up to the controller's single-flight join, so once
    // the second request's handler has returned its promise, it is a joiner of the first's flight.
    const held = {
      ...route,
      meta: route.meta,
      handler: (
        request: Parameters<typeof route.handler>[0],
        ctx: Parameters<typeof route.handler>[1],
      ) => {
        arrived += 1;
        const answered = route.handler(request, ctx);
        if (arrived === 2) open();
        return answered;
      },
    };
    const server = serverOver([held]);
    const responses = await Promise.all([
      server.fetch(new Request('http://dev.test/pricing')),
      server.fetch(new Request('http://dev.test/pricing')),
    ]);
    release();
    expect(responses.map((response) => response.status)).toEqual([302, 302]);
    // Each request answered the redirect ITS load decided — never the other request's Location.
    expect(responses.map((response) => response.headers.get('location')).sort()).toEqual([
      '/moved-1',
      '/moved-2',
    ]);
    expect(responses.map((response) => response.headers.get('cache-control'))).toEqual([
      'private, no-store',
      'private, no-store',
    ]);
    expect(isr.store().paths()).toHaveLength(0);
  });
});
