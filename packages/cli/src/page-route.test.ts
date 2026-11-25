// `pageRoute`: a registered page's GET through the real pipeline, the way a unit test reaches
// what a visitor receives. Each answer here is one only the pipeline (not `renderRoute`) gives.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dependentsOfKind, tag } from '@ultimat3/cache';
import { resetLifecycle } from '@ultimat3/core';
import { setCookie, setRedirect, useRequestCookie, useRequestHeader } from '@ultimat3/http';
import { clearRoutes, defineRoute, h, registerRoute } from '@ultimat3/render';
import { pageRoute } from './page-route';

type Data = { who: string; agent: string; query: string };

const register = (file: string, permission?: string): void => {
  registerRoute<Data>({
    file,
    component: (props) => {
      const data = props['data'] as Data;
      return h('p', {}, `${data.who}|${data.agent}|${data.query}`);
    },
    config: defineRoute<Data>({
      render: 'ssr',
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      ...(permission === undefined ? {} : { policy: { permission } }),
      load: async (ctx) => ({
        who: useRequestCookie('sid') ?? 'nobody',
        agent: useRequestHeader('x-agent') ?? 'none',
        query: new URL(ctx.url, 'http://localhost').searchParams.get('q') ?? 'none',
      }),
      meta: () => ({ title: 'page', description: 'd'.repeat(60) }),
    }),
  });
};

beforeEach(() => resetLifecycle());
afterEach(() => {
  clearRoutes();
  resetLifecycle();
});

describe('pageRoute', () => {
  test('GETs a registered page through the pipeline, headers and cookies read by its load', async () => {
    register('apps/web/site/who/page.tsx');
    const response = await pageRoute('/who?q=hello', {
      cookies: { sid: 's 1' },
      headers: { 'x-agent': 'a-1' },
      buildId: 'build-test-42',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBeString();
    expect(response.headers.get('x-ultimate-build')).toBe('build-test-42');
    expect(await response.text()).toContain('s 1|a-1|hello');
  });

  test('releases the ISR revalidator before returning', async () => {
    const probe = tag('page-route-probe');
    registerRoute({
      file: 'apps/web/site/cached/page.tsx',
      component: () => h('p', {}, 'cached'),
      config: defineRoute({
        render: 'isr',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        revalidate: { tags: [probe] },
        meta: () => ({ title: 'cached', description: 'd'.repeat(60) }),
      }),
    });
    expect((await pageRoute('/cached')).status).toBe(200);
    expect(dependentsOfKind([probe], 'isr-route')).toEqual([]);
  });

  test('returns cookies and redirects set by the page', async () => {
    registerRoute({
      file: 'apps/web/site/go/page.tsx',
      component: () => h('p', {}, 'go'),
      config: defineRoute({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        load: async () => {
          setCookie('visit', 'yes');
          setRedirect('/destination', 302);
          return {};
        },
        meta: () => ({ title: 'go', description: 'd'.repeat(60) }),
      }),
    });
    const response = await pageRoute('/go');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/destination');
    expect(response.headers.getSetCookie()).toEqual([
      'visit=yes; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  test('a page with no cookies or headers sees none', async () => {
    register('apps/web/site/who/page.tsx');
    expect(await (await pageRoute('/who')).text()).toContain('nobody|none');
  });

  test('the authz stage runs: a gated page refuses an anonymous visitor', async () => {
    register('apps/web/app/secret/page.tsx', 'secret.read');
    expect((await pageRoute('/secret')).status).toBe(401);
  });

  test('a path no page claims is the pipeline’s 404', async () => {
    expect((await pageRoute('/nowhere')).status).toBe(404);
  });

  test('a path without a leading slash, and cookies beside a cookie header, are refused with a fix', async () => {
    const bare = await pageRoute('https://example.test/reset?token=secret').catch(
      (error: unknown) => error,
    );
    expect(bare).toMatchObject({
      code: 'X_INVARIANT',
      cause: 'pageRoute requires a URL path starting with a slash',
      fix: "pageRoute('/dashboard?tab=2')",
    });
    expect(String(bare)).not.toContain('secret');
    const both = await pageRoute('/who', { cookies: { a: '1' }, headers: { cookie: 'b=2' } }).catch(
      (error: unknown) => error,
    );
    expect(both).toMatchObject({
      code: 'X_INVARIANT',
      fix: "pageRoute('/dashboard', { cookies: { sid: 's-1' } })",
    });
  });
});
