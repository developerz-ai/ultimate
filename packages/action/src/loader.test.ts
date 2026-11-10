// The `./loader` subpath is where the boot names an app's exports: the registration functions live
// there, for `x`'s module scan and framework fixtures. An app hands its modules to `defineApi`.

import { afterEach, expect, test } from 'bun:test';
import * as barrel from '@ultimat3/action';
import * as subpath from '@ultimat3/action/loader';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { ActionUnregisteredError } from './errors';
import { getAction, resetActions } from './registry';

afterEach(() => resetActions());

test('the package exports ./loader, and it carries the two registration functions only', async () => {
  const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(manifest).toMatchObject({ exports: { './loader': './src/loader.ts' } });
  expect(Object.keys(subpath).sort()).toEqual(['registerAction', 'registerActions']);
});

test('a registration through the loader is the one the registry serves', () => {
  const ping = action({
    input: t.object({}),
    output: t.object({}),
    policy: can('ping:run'),
    handle: () => ({}),
  });
  subpath.registerActions({ ping });
  expect(getAction('ping')).toBe(ping);
});

test('the `.` barrel exports no registration function: an app has `defineApi` and nothing else', () => {
  const names = Object.keys(barrel);
  for (const name of ['registerAction', 'registerActions']) expect(names).not.toContain(name);
});

test('the unregistered fix names `defineApi`, never a function the barrel does not export', () => {
  const { fix } = new ActionUnregisteredError();
  expect(fix).toContain('defineApi({ actions })');
  expect(fix).toContain('apps/<app>/api/index.ts');
  expect(fix).not.toContain('register');
});
