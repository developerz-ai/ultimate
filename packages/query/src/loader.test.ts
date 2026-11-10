// The `./loader` subpath is where the boot names an app's reads: the registration functions live
// there, for `x`'s module scan and framework fixtures. An app hands its modules to `defineApi`.

import { afterEach, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import * as barrel from '@ultimat3/query';
import * as subpath from '@ultimat3/query/loader';
import { t } from '@ultimat3/schema';
import { QueryUnregisteredError } from './errors';
import { query } from './query';
import { getQuery, resetQueries } from './registry';
import { from } from './source';

afterEach(() => resetQueries());

test('the package exports ./loader, and it carries the two registration functions only', async () => {
  const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(manifest).toMatchObject({ exports: { './loader': './src/loader.ts' } });
  expect(Object.keys(subpath).sort()).toEqual(['registerQueries', 'registerQuery']);
});

test('a registration through the loader is the one the registry serves', () => {
  const feed = query({
    input: t.object({ orgId: t.uuid }),
    policy: can('feed:read'),
    sql: ({ orgId }) =>
      from<{ id: string; orgId: string }>('posts', []).where({ orgId }).orderBy('id').limit(50),
  });
  subpath.registerQueries({ feed, notAQuery: 1 });
  expect(getQuery('feed')).toBe(feed);
  expect(getQuery('notAQuery')).toBeUndefined();
});

test('the `.` barrel exports no registration function: an app has `defineApi` and nothing else', () => {
  const names = Object.keys(barrel);
  for (const name of ['registerQueries', 'registerQuery']) expect(names).not.toContain(name);
});

test('the unregistered fix names `defineApi`, never a function the barrel does not export', () => {
  const { fix } = new QueryUnregisteredError();
  expect(fix).toContain('defineApi({ queries })');
  expect(fix).toContain('apps/<app>/api/index.ts');
  expect(fix).not.toContain('register');
});
