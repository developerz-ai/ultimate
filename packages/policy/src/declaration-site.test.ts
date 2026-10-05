// Pins pickCallerSite against stacks shaped as Bun writes them on Linux and on Windows.
import { describe, expect, test } from 'bun:test';
import { callerSite, pickCallerSite, UNKNOWN_SITE } from './declaration-site';

const stackOf = (frames: readonly string[]): string =>
  ['Error', ...frames.map((frame) => `    at ${frame}`)].join('\n');

describe('pickCallerSite', () => {
  const windowsDir = 'D:\\a\\ultimate\\ultimate\\packages\\policy\\src';
  const windows = stackOf([
    `callerSite (${windowsDir}\\declaration-site.ts:33:21)`,
    `record (${windowsDir}\\permissions.ts:80:3)`,
    `definePermissions (${windowsDir}\\permissions.ts:60:5)`,
    `definePermissionsForPosts (D:\\a\\app\\src\\permissions.ts:4:3)`,
  ]);

  test('a Windows stack skips the package frames, `\\` and all', () => {
    expect(pickCallerSite(windows, windowsDir)).toBe(
      'at definePermissionsForPosts (D:\\a\\app\\src\\permissions.ts:4:3)',
    );
  });

  test('a trailing separator on the directory changes nothing', () => {
    expect(pickCallerSite(windows, `${windowsDir}\\`)).toContain('definePermissionsForPosts');
  });

  test('a POSIX stack still skips the package frames', () => {
    const dir = '/repo/packages/policy/src';
    const posix = stackOf([
      `callerSite (${dir}/declaration-site.ts:33:21)`,
      `defineRoles (${dir}/roles.ts:40:3)`,
      `<anonymous> (${dir}/roles.test.ts:12:5)`,
    ]);
    expect(pickCallerSite(posix, dir)).toBe(`at <anonymous> (${dir}/roles.test.ts:12:5)`);
  });

  test('an empty stack is the unknown site, never an empty string', () => {
    expect(pickCallerSite('Error', '/x')).toBe(UNKNOWN_SITE);
  });

  test('the real call names this test file', () => {
    expect(callerSite()).toContain('declaration-site.test.ts');
  });
});
