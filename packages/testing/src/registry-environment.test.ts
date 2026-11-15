// The narrowing arithmetic, without a child process: which names a file keeps, by site, by kept
// set, and what an unreadable site or an incomplete graph does. `registry-leak-guard.test.ts`
// pins that the guard applies it at the boundary.

import { describe, expect, test } from 'bun:test';
import { ownEnvironment, type PolicyEnvironment, siteFile } from './registry-environment';

const none = { permissions: new Set<string>(), roles: new Set<string>() };

const inherited: PolicyEnvironment = {
  permissions: ['a:read', 'b:read', 'odd:read'],
  permissionSites: {
    'a:read': ['at /repo/a.ts:3:1'],
    'b:read': ['at defineThing (/repo/b.ts:9:5)'],
    'odd:read': ['unknown site'],
  },
  roles: { alpha: { grants: ['a:read'] }, beta: { grants: ['b:read'] } },
  roleSites: { alpha: 'at /repo/a.ts:4:1', beta: 'at async /repo/b.ts:10:1' },
};

describe('siteFile', () => {
  test('reads the file out of every frame shape a declaration site takes', () => {
    expect(siteFile('at /repo/a.ts:3:1')).toBe('/repo/a.ts');
    expect(siteFile('at defineThing (/repo/b.ts:9:5)')).toBe('/repo/b.ts');
    expect(siteFile('at async /repo/b.ts:10:1')).toBe('/repo/b.ts');
    expect(siteFile('at C:\\repo\\c.ts:1:1')).toBe('C:/repo/c.ts');
    expect(siteFile('at /repo/d.ts?x-reload=3:1:1')).toBe('/repo/d.ts');
  });

  test('a frame that names no file answers nothing', () => {
    expect(siteFile('unknown site')).toBeUndefined();
    expect(siteFile('at <anonymous> (native:1:1)')).toBeUndefined();
  });
});

describe('ownEnvironment', () => {
  test('keeps what the graph reaches and an unreadable site, drops the rest', () => {
    const own = ownEnvironment(
      inherited,
      { modules: new Set(['/repo/a.ts', '/repo/x.test.ts']), complete: true },
      none,
    );
    expect(own.permissions).toEqual(['a:read', 'odd:read']);
    expect(Object.keys(own.permissionSites)).toEqual(['a:read', 'odd:read']);
    expect(own.roles).toEqual({ alpha: { grants: ['a:read'] } });
    expect(own.roleSites).toEqual({ alpha: 'at /repo/a.ts:4:1' });
  });

  test('a kept name stays whatever its site', () => {
    const own = ownEnvironment(
      inherited,
      { modules: new Set(), complete: true },
      { permissions: new Set(['b:read']), roles: new Set(['beta']) },
    );
    expect(own.permissions).toEqual(['b:read', 'odd:read']);
    expect(Object.keys(own.roles)).toEqual(['beta']);
  });

  test('an incomplete graph narrows nothing', () => {
    expect(ownEnvironment(inherited, { modules: new Set(), complete: false }, none)).toBe(
      inherited,
    );
  });
});
