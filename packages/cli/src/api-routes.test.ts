// One table, both halves. `x dev` and a container mount `apiRoutes()` and nothing else, so a
// surface that answers in one and 404s in the other has to break this test first.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, defineApi, registerAction, resetRegistry as resetActions } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { t } from '@ultimat3/schema';
import { apiMountRoutes, apiRoutes, pagePostRoutes } from './api-routes';

const Input = t.object({ orgId: t.uuid });

// Before as well as after: a test here declares `pathStyle: 'readable'`, which refuses any path an
// earlier file handed out by name and never reset — the registry is this file's premise, not theirs.
beforeEach(() => {
  resetActions();
  resetQueries();
});
afterEach(() => {
  resetActions();
  resetQueries();
});

function registerBoth(): void {
  registerAction(
    'publishPost',
    action({
      input: Input,
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      handle: () => ({ ok: true }),
    }),
  );
  registerQuery(
    'orgFeed',
    query({
      input: Input,
      policy: allow(),
      sql: ({ orgId }) => from('posts', []).where({ orgId }),
    }),
  );
}

test('an app with no primitives contributes no routes', () => {
  expect(apiRoutes()).toEqual([]);
});

test('the read half is mounted beside the write half', () => {
  registerBoth();
  const routes = apiRoutes();

  // The write half was never the gap; the read half is the one `query.client()` fetches and
  // nothing served, so a typed call site compiled everywhere and 404'd everywhere.
  expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
    'POST /api/posts/publish',
    'GET /_x/query/org-feed',
  ]);
});

test('reads it at call time, because importing the app IS the registration', () => {
  // This module is imported long before `loadApp` runs. A table captured at import would be the
  // empty one above, on every boot.
  expect(apiRoutes()).toEqual([]);
  registerBoth();
  expect(apiRoutes()).toHaveLength(2);
});

describe('apiMountRoutes — defineApi({ http: { mounts } })', () => {
  test('no mount declared, nothing mounted', () => {
    registerBoth();
    expect(apiMountRoutes()).toEqual([]);
  });

  test('the declared cut, under the prefix, over the same projected routes', () => {
    defineApi({
      actions: {
        publishPost: action({
          input: Input,
          output: t.object({ ok: t.boolean }),
          policy: allow(),
          handle: () => ({ ok: true }),
        }),
      },
      http: {
        pathStyle: 'readable',
        mounts: [
          { prefix: '/v1', scopes: { 'posts:write': ['publishPost'] }, resolveToken: () => null },
        ],
      },
    });
    const mounted = apiMountRoutes();
    expect(mounted.map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /v1/publish-post',
    ]);
    expect(mounted[0]?.meta.auth).toBe('required');
    expect(typeof mounted[0]?.meta.authenticate).toBe('function');
  });
});

describe('pagePostRoutes — defineRoute({ post })', () => {
  afterEach(() => clearRoutes());

  const page = (post: string) =>
    registerRoute({
      file: 'apps/web/app/correos/baja/page.tsx',
      config: defineRoute({
        render: 'ssr',
        offline: 'network-only',
        meta: () => ({ title: 'Baja' }),
        post,
      }),
      suspenseBoundaries: 0,
    });

  test("binds POST at the page's own path to the named action", () => {
    registerAction(
      'unsubscribeOnboarding',
      action({
        input: t.object({ t: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: allow(),
        handle: () => ({ ok: true }),
      }),
    );
    page('unsubscribeOnboarding');
    expect(pagePostRoutes().map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /correos/baja',
    ]);
  });

  test('a name no action is registered under is refused at boot', () => {
    page('unsubscribeOnbaording');
    expect(() => pagePostRoutes()).toThrow(
      expect.objectContaining({ code: 'X_ROUTE_POST_INVALID' }),
    );
  });
});
