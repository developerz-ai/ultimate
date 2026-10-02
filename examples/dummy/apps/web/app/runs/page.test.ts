// /runs, rendered as a member: the heading, the island the route hands a browser and every word
// that island is given. The events are not here — they arrive over a socket no server has.
import { useT } from '@postly/i18n';
import { createContext, runWithContext } from '@ultimat3/core';
import type { IslandDirective } from '@ultimat3/render';
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import { DEFAULT_DEMO_MEMBER, demoActorFor } from '../auth/demo-actor';
import * as page from './page';

const LEDGER = {
  id: '00000000-0000-4000-8000-0000000000d1',
  orgId: '00000000-0000-4000-8000-0000000000a1',
  label: 'Ledger',
  createdAt: new Date('2026-10-01T09:00:00.000Z'),
};

/**
 * The route with its read answered here. `load` reaches this app over HTTP as the member who
 * asked (`memberQueries`), and a unit test has no request to forward a cookie from.
 */
const routeWith = (rows: readonly (typeof LEDGER)[]) => ({
  ...page,
  config: { ...page.config, load: () => Promise.resolve([...rows]) },
});

/** The console among the route's islands — the layout's update banner is the other one. */
const consoleOf = (view: { readonly islands: readonly IslandDirective[] }) =>
  view.islands.find((one) => one.props !== undefined && 'connections' in one.props);

const request = { url: 'https://example.test/runs', actor: demoActorFor(DEFAULT_DEMO_MEMBER) };

unitTest('the page renders its heading and the console’s loading shell', async () => {
  const t = useT();
  const view = await renderRoute(routeWith([LEDGER]), request);
  expect(view.html.match(/<h1\b/g)).toHaveLength(1);
  expect(view.text).toContain(t('app.runs.heading'));
  expect(view.text).toContain(t('app.runs.intro'));
  // Reachable from every `app/` page, not only by typing the URL.
  expect(view.html).toContain('href="/runs"');
});

unitTest('it hands the island the org’s connections and no credential', async () => {
  const view = await renderRoute(routeWith([LEDGER]), request);
  const island = consoleOf(view);
  expect(island?.props?.['connections']).toEqual([{ id: LEDGER.id, label: 'Ledger' }]);
  expect(JSON.stringify(island?.props)).not.toContain('credential":"');
  expect(island?.props?.['zone']).toBeString();
});

unitTest('every label the island shows is a catalog string, in the request’s locale', async () => {
  const t = useT();
  const view = await renderRoute(routeWith([]), request);
  const island = consoleOf(view);
  const labels = JSON.stringify(island?.props?.['labels']);
  // A key the catalog lacks renders ⟦key⟧: one missing label would show here.
  expect(labels).not.toContain('⟦');
  expect(labels).toContain(t('app.runs.state.awaiting'));
  expect(labels).toContain(t('app.runs.kind.prompt'));
  expect(labels).toContain(t('app.runs.fault.start'));
  expect(labels).toContain(t('app.runs.accounts_other'));
  expect(labels).toContain(t('app.runs.busy'));
  expect(labels).toContain(t('app.runs.usage.navigations'));
});

unitTest('it declares its metadata, its policy and what it costs', async () => {
  const t = useT();
  const view = await renderRoute(routeWith([]), request);
  expect(view.meta.title).toBe(t('app.runs.metaTitle'));
  expect(view.meta.robots).toEqual({ index: false });
  expect(page.config.render).toBe('ssr');
  expect(page.config.policy).toEqual({ permission: 'run:read' });
  expect(page.config.offline).toBe('runtime');
  expect(page.config.hydrate).toBe('idle');
});

unitTest('load reads the org’s connections as the member who asked', async () => {
  const actor = demoActorFor(DEFAULT_DEMO_MEMBER);
  const cookie = 'postly_demo_member=ada';
  const seen: { readonly url: string; readonly cookie: string | null }[] = [];
  const realFetch = globalThis.fetch;
  const realUrl = process.env['APP_URL'];
  process.env['APP_URL'] = 'http://app.test';
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), cookie: new Headers(init?.headers).get('cookie') });
    return Promise.resolve(
      Response.json([{ ...LEDGER, createdAt: LEDGER.createdAt.toISOString() }]),
    );
  }) as typeof fetch;
  try {
    // A request, as the pipeline publishes it: the actor, and the inbound headers a member read
    // forwards. The route is the real one — its own `load`, not an answer handed to it.
    const view = await runWithContext(
      { ...createContext({ actor }), requestHeaders: new Headers({ cookie }) },
      () => renderRoute(page, { url: request.url }),
    );
    expect(view.data.map((row) => row.label)).toEqual(['Ledger']);
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env['APP_URL'];
    else process.env['APP_URL'] = realUrl;
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toContain('/_x/query/run-connections');
  expect(seen[0]?.url).toContain(`orgId=${actor.orgId}`);
  expect(seen[0]?.cookie).toBe(cookie);
});
