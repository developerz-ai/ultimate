// A declaration site reduced to a file, on every shape of frame a runtime prints: a POSIX path, a
// Windows path with its drive letter and backslashes, and a root whose own name holds a `(` —
// each of which `frameFile` used to drop or cut short, losing the finding or its `at:`.

import { describe, expect, test } from 'bun:test';
import { frameFile, rootRelative, siteFile } from './app-permissions-site';

const WIN_ROOT = 'C:\\Users\\dev\\shop';
const WIN_FRAME = 'at defineRoles (C:\\Users\\dev\\shop\\apps\\web\\shared\\roles.ts:22:14)';

describe('unit · frameFile reads every frame shape', () => {
  test('a POSIX frame, named or anonymous', () => {
    expect(frameFile('at defineRoles (/app/apps/web/shared/roles.ts:22:14)')).toBe(
      '/app/apps/web/shared/roles.ts',
    );
    expect(frameFile('at /app/apps/web/shared/permissions.ts:4:1')).toBe(
      '/app/apps/web/shared/permissions.ts',
    );
  });

  test('a Windows frame keeps its drive letter, named or anonymous', () => {
    expect(frameFile(WIN_FRAME)).toBe('C:\\Users\\dev\\shop\\apps\\web\\shared\\roles.ts');
    expect(frameFile('at C:\\Users\\dev\\shop\\apps\\web\\permissions.tsx:4:1')).toBe(
      'C:\\Users\\dev\\shop\\apps\\web\\permissions.tsx',
    );
  });

  test('a `(` inside the path is part of the path, not the end of the frame', () => {
    expect(frameFile('at defineRoles (/home/dev/shop (copy)/apps/web/roles.ts:3:1)')).toBe(
      '/home/dev/shop (copy)/apps/web/roles.ts',
    );
  });

  test('a frame naming no source file answers undefined', () => {
    expect(frameFile('unknown site')).toBeUndefined();
    expect(frameFile('at native code')).toBeUndefined();
  });
});

describe('unit · siteFile and rootRelative compare across separators', () => {
  test('a Windows frame under a Windows root is located', () => {
    expect(siteFile(WIN_ROOT, WIN_FRAME)).toBe('apps/web/shared/roles.ts');
    // The drive letter's case is the shell's, not the file's.
    expect(siteFile('c:\\Users\\dev\\shop', WIN_FRAME)).toBe('apps/web/shared/roles.ts');
  });

  test('a root holding a `(` locates the file under it, not a suffix of it', () => {
    const frame = 'at defineRoles (/home/dev/shop (copy)/apps/web/roles.ts:3:1)';
    expect(siteFile('/home/dev/shop (copy)', frame)).toBe('apps/web/roles.ts');
  });

  test('outside the root is undefined for siteFile and a climbing path for rootRelative', () => {
    expect(siteFile(WIN_ROOT, 'at x (D:\\elsewhere\\roles.ts:1:1)')).toBeUndefined();
    expect(rootRelative(WIN_ROOT, 'C:\\Users\\dev\\pkgs\\admin\\policy.ts')).toBe(
      '../pkgs/admin/policy.ts',
    );
  });
});
