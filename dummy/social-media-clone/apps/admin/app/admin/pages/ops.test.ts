// What `pages:` buys, asserted rather than described: the ops board is in the SAME route table
// and behind the SAME permission pair a generated screen gets, and it carries no route and no
// authz of its own for anyone to get wrong. The board's own gate is `uploads.test.ts`.

import { expect, test } from 'bun:test';
import { pageRoutes } from '@ultimat3/admin';
import { isUltimateError } from '@ultimat3/core';
import { admin } from '../admin';
import { opsPage } from './ops';

const OPS_PATH = '/admin/ops';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : String(error);
  }
  return 'no error';
};

// Failure first: the declaration this page could have shipped with is the one `defineAdmin`
// refuses where it is written. Before `pages:`, the same mistake was a page file that simply
// omitted its `policy:` line — and nothing anywhere said so.
test('unit · a pages entry with no permission never reaches the route table', () => {
  expect(codeOf(() => pageRoutes('/admin', [{ ...opsPage, permissions: [] }], []))).toBe(
    'X_ADMIN_PAGE_UNGUARDED',
  );
});

test('unit · a pages entry that would shadow a generated screen is refused too', () => {
  const shadow = { ...opsPage, path: '/users' };
  expect(codeOf(() => pageRoutes('/admin', [shadow], ['/admin/users']))).toBe(
    'X_ADMIN_PAGE_PATH_INVALID',
  );
});

test('unit · the ops board is a route of the admin, guarded by admin:read AND job:read', () => {
  const route = admin.routes.find((candidate) => candidate.path === OPS_PATH);
  expect(route?.view).toBe('page');
  // `admin:read` first: `pagePermissions()` composes the frame's gate in front of the page's own,
  // which is exactly the pair `permissionsForOperation('job', 'list')` builds for /admin/jobs.
  expect(route?.permissions).toEqual(['admin:read', 'job:read']);
});

test('unit · the ops board declares no route and no policy of its own', () => {
  // `pages:` is the only way in. A `config` export here would be a route the frame never guards.
  expect('config' in opsPage).toBe(false);
  expect(opsPage.path.startsWith('/')).toBe(true);
});

test('unit · the sidebar link is derived, and it carries the permissions that hide it', () => {
  const item = admin.nav.flatMap((group) => group.items).find((entry) => entry.href === '/ops');
  expect(item?.labelKey).toBe('admin.ops.title');
  expect(item?.permissions).toEqual(['admin:read', 'job:read']);
});
