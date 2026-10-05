// Pins the `/` spelling against Windows-shaped inputs, which this host never produces itself.
import { describe, expect, test } from 'bun:test';
// why: `win32` proves the Windows answer of the relative half on this Linux runner.
import { win32 } from 'node:path';
import { insideRoot, posixRelative, toPosix } from './posix-path';

describe('toPosix', () => {
  test('a Windows path becomes the `/` spelling every key in this repo uses', () => {
    expect(toPosix('packages\\core\\package.json')).toBe('packages/core/package.json');
  });

  test('a POSIX path is unchanged', () => {
    expect(toPosix('packages/core/package.json')).toBe('packages/core/package.json');
  });
});

describe('posixRelative', () => {
  test('is relative() with `/` separators', () => {
    expect(posixRelative('/repo', '/repo/dummy/social-media-clone')).toBe(
      'dummy/social-media-clone',
    );
  });

  test('a Windows lockfile key comes out `/`-spelt', () => {
    expect(posixRelative('D:\\repo', 'D:\\repo\\dummy\\social-media-clone', win32)).toBe(
      'dummy/social-media-clone',
    );
  });
});

describe('insideRoot', () => {
  test('a Windows path under a Windows root is repo-relative, `/`-separated', () => {
    expect(insideRoot('D:\\a\\ultimate', 'D:\\a\\ultimate\\scripts\\gate-codes.ts')).toBe(
      'scripts/gate-codes.ts',
    );
  });

  test('mixed separators on the two sides still match', () => {
    expect(insideRoot('D:\\a\\ultimate\\', 'D:/a/ultimate/scripts/x.ts')).toBe('scripts/x.ts');
  });

  test('a sibling sharing the prefix is outside, not inside', () => {
    expect(insideRoot('/repo', '/repo-two/x.ts')).toBeUndefined();
  });
});
