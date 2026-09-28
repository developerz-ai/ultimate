// What a shared worker restores to: everything declared so far, newer winning a conflict.

import { describe, expect, test } from 'bun:test';
import { disposeLiveIslands } from './fixture-island';
import type { ProcessRegistrySnapshot } from './registry-snapshot';
import { mergeSnapshots } from './registry-snapshot';

const snap = (over: Partial<ProcessRegistrySnapshot>): ProcessRegistrySnapshot => ({
  locales: { supported: ['en'], fallback: 'en', order: [] } as never,
  catalogs: [],
  permissions: [],
  roles: {},
  roleSites: {},
  tasks: [],
  catalogDeclarations: 0,
  ...over,
});

describe('unit · merged registry snapshots', () => {
  test('no older snapshot is the newer one as it is', () => {
    const newer = snap({ permissions: ['a:read'] });
    expect(mergeSnapshots(undefined, newer)).toBe(newer);
  });

  test('permissions, roles, catalogs and tasks are unions; the newer wins a conflict', () => {
    const task = (name: string) => ({ name }) as never;
    const merged = mergeSnapshots(
      snap({
        permissions: ['a:read'],
        roles: { admin: { grants: ['a:read'] } } as never,
        catalogs: [['en', { hello: 'Hello' }]] as never,
        tasks: [task('nightly')],
        catalogDeclarations: 2,
      }),
      snap({
        permissions: ['b:write'],
        roles: { admin: { grants: ['b:write'] } } as never,
        catalogs: [['en', { bye: 'Bye' }]] as never,
        tasks: [task('hourly')],
        catalogDeclarations: 1,
      }),
    );
    expect([...merged.permissions].sort()).toEqual(['a:read', 'b:write']);
    expect(merged.roles).toEqual({ admin: { grants: ['b:write'] } } as never);
    expect(merged.catalogs).toEqual([['en', { hello: 'Hello', bye: 'Bye' }]] as never);
    expect(merged.tasks.map((t) => t.name).sort()).toEqual(['hourly', 'nightly']);
    expect(merged.catalogDeclarations).toBe(2);
  });

  test('with nothing mounted, disposing live islands is a no-op', () => {
    expect(disposeLiveIslands()).toBe(0);
  });
});
