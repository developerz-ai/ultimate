// `isCompiledBundle` is what tells an app entry it is running inside `bun build --compile`. The
// prefixes are Bun's own (`BASE_PATH` / `BASE_PUBLIC_PATH` in its standalone module graph): one
// spelling on POSIX, two on Windows, and a miss on Windows is an app whose registries load nothing.

import { describe, expect, test } from 'bun:test';
import { isCompiledBundle } from './bunfs';

describe('isCompiledBundle', () => {
  test('a POSIX binary reports /$bunfs/root', () => {
    expect(isCompiledBundle('/$bunfs/root')).toBe(true);
    expect(isCompiledBundle('/$bunfs/root/apps/web')).toBe(true);
  });

  test('a Windows binary reports B:\\~BUN\\root, and B:/~BUN/root on the public path', () => {
    expect(isCompiledBundle('B:\\~BUN\\root')).toBe(true);
    expect(isCompiledBundle('B:\\~BUN\\root\\apps\\web')).toBe(true);
    expect(isCompiledBundle('B:/~BUN/root')).toBe(true);
    expect(isCompiledBundle('b:\\~BUN\\root')).toBe(true);
  });

  test('a checkout on disk is not a bundle, wherever it lives', () => {
    expect(isCompiledBundle('/srv/app/apps/web')).toBe(false);
    expect(isCompiledBundle('C:\\Users\\dev\\app\\apps\\web')).toBe(false);
    // A real directory that merely starts with the same letters is not the virtual root.
    expect(isCompiledBundle('/$bunfsx/root')).toBe(false);
    expect(isCompiledBundle('B:\\~BUNDLE\\root')).toBe(false);
    expect(isCompiledBundle('B:\\work\\~BUN\\root')).toBe(false);
  });

  test('this test file is not running from a bundle', () => {
    expect(isCompiledBundle(import.meta.dir)).toBe(false);
  });
});
