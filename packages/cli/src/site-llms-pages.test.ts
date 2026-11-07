// `llms.txt`'s per-page reads happen inside the build's API scope: `collectLlmsPages` runs each
// `load` there, and `siteLlms` handed what it collected never runs a `load` again — the export
// writes `llms.txt` after that scope closed, when a `load` reading the app's query cannot answer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RouteConfig } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { siteLlms } from './site-llms';
import { collectLlmsPages } from './site-llms-pages';

const BASE = 'https://www.example.com';
let open = false;
let loads = 0;

/** A `load` that answers only while the build's scope is open, as the app's typed client does. */
const load = (): Promise<{ title: string }> => {
  loads += 1;
  return open ? Promise.resolve({ title: 'Latest' }) : Promise.reject(new Error('scope closed'));
};

const route = (file: string, patch: Partial<RouteConfig>): void => {
  registerRoute({
    file,
    config: defineRoute({
      render: 'isr',
      revalidate: { ttl: '5m' },
      hydrate: 'never',
      offline: 'network-only',
      meta: () => ({ title: 'About', description: 'about us' }),
      ...patch,
    } as Parameters<typeof defineRoute>[0]),
    component: () => 'page',
  });
};

const site = (): void => {
  route('apps/web/site/page.tsx', {
    load,
    meta: ({ data }: { data: { title: string } }) => ({ title: data.title, description: 'home' }),
  } as unknown as Partial<RouteConfig>);
  route('apps/web/site/about/page.tsx', {});
  route('apps/web/site/admin/page.tsx', {
    render: 'ssr',
    load,
    policy: { can: () => true },
  } as unknown as Partial<RouteConfig>);
};

const scope = async <T>(fn: () => Promise<T>): Promise<T> => {
  open = true;
  try {
    return await fn();
  } finally {
    open = false;
  }
};

beforeEach(() => {
  clearRoutes();
  open = false;
  loads = 0;
});
afterEach(() => clearRoutes());

describe('collectLlmsPages', () => {
  test('runs each public page load inside the scope, and siteLlms reuses it after', async () => {
    site();
    const pages = await collectLlmsPages({
      baseUrl: BASE,
      defaultLocale: 'en',
      environment: 'production',
      scope,
    });
    expect([...pages.keys()]).toEqual(['/']);
    expect(loads).toBe(1);
    const llms = await siteLlms({
      baseUrl: BASE,
      defaultLocale: 'en',
      environment: 'production',
      pages,
    });
    expect(loads).toBe(1);
    expect(llms).toContain(`- [Latest](${BASE}): home`);
    expect(llms).toContain(`- [About](${BASE}/about): about us`);
    expect(llms).not.toContain('/admin');
  });

  test('without the collected pages, the load after the scope is what fails', async () => {
    site();
    const answer = siteLlms({ baseUrl: BASE, defaultLocale: 'en', environment: 'production' });
    await expect(answer).rejects.toThrow('scope closed');
  });

  test('collects nothing, and loads nothing, outside production or under seo.llms: false', async () => {
    site();
    const options = { baseUrl: BASE, defaultLocale: 'en', scope };
    expect((await collectLlmsPages({ ...options, environment: 'staging' })).size).toBe(0);
    const off = await collectLlmsPages({ ...options, environment: 'production', enabled: false });
    expect(off.size).toBe(0);
    expect(loads).toBe(0);
  });

  test('the database is started only when a page needs a load', async () => {
    let started = 0;
    route('apps/web/site/about/page.tsx', {});
    const before = (): Promise<void> => {
      started += 1;
      return Promise.resolve();
    };
    const options = { baseUrl: BASE, defaultLocale: 'en', environment: 'production' as const };
    await collectLlmsPages({ ...options, scope, before });
    expect(started).toBe(0);
    clearRoutes();
    site();
    await collectLlmsPages({ ...options, scope, before });
    expect(started).toBe(1);
  });

  test('a route the build already enumerated is not asked prerender() again', async () => {
    let asked = 0;
    route('apps/web/site/posts/[slug]/page.tsx', {
      prerender: () => {
        asked += 1;
        return ['a', 'b'];
      },
      load,
      meta: ({ data }: { data: { title: string } }) => ({ title: data.title, description: 'p' }),
    } as unknown as Partial<RouteConfig>);
    const pages = await collectLlmsPages({
      baseUrl: BASE,
      defaultLocale: 'en',
      environment: 'production',
      scope,
      entries: new Map([['/posts/:slug', [{ params: { slug: 'a' } }]]]),
    });
    expect(asked).toBe(0);
    expect(pages.get('/posts/:slug')?.map((record) => record.path)).toEqual(['/posts/a']);
  });
});
