// A Windows-shaped path comes out POSIX on every host: the Linux runner proves the Windows answer by
// handing `posixRelative` the `win32` path module.

import { describe, expect, test } from 'bun:test';
// why: `win32` is the only way to compute a Windows `relative()` answer on a Linux runner.
import { win32 } from 'node:path';
import { posixRelative, toPosix } from './posix-path';

describe('unit · posix paths', () => {
  test('a backslash path is written with slashes; a POSIX path is unchanged', () => {
    expect(toPosix('apps\\web\\app\\x.ts')).toBe('apps/web/app/x.ts');
    expect(toPosix('..\\shared\\ui')).toBe('../shared/ui');
    expect(toPosix('apps/web/app/x.ts')).toBe('apps/web/app/x.ts');
  });

  test('a Windows relative() answer is POSIX, from absolute and from relative inputs alike', () => {
    expect(posixRelative('D:\\a\\winapp', 'D:\\a\\winapp\\apps\\web\\x.ts', win32)).toBe(
      'apps/web/x.ts',
    );
    expect(posixRelative('apps/web/api', 'apps/web/app/billing/registry.ts', win32)).toBe(
      '../app/billing/registry.ts',
    );
  });

  test('on this host it is relative() itself', () => {
    expect(posixRelative('/r/apps/web', '/r/apps/web/site/page.tsx')).toBe('site/page.tsx');
  });
});
