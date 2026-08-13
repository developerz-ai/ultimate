// One table, both halves. `x dev` and a container mount `apiRoutes()` and nothing else, so a
// surface that answers in one and 404s in the other has to break this test first.

import { afterEach, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry as resetActions } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { apiRoutes } from './api-routes';

const Input = t.object({ orgId: t.uuid });

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
