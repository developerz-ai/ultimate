// `newestSourceMtime`: what moves `budgets`' freshness and what does not. Every path is pinned with
// `utimes`, so each case states the clock it reads.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory, recursive-remove or set-mtime native.
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { newestSourceMtime } from './source-mtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const at = (root: string, path: string, seconds: number): void =>
  utimesSync(join(root, path), seconds, seconds);

/** `apps/web/site/page.tsx` and its test, every file and directory at 1000 s. */
const tree = async (): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'source-mtime-'));
  roots.push(root);
  mkdirSync(join(root, 'apps', 'web', 'site'), { recursive: true });
  await Bun.write(join(root, 'apps/web/site/page.tsx'), 'export {};\n');
  await Bun.write(join(root, 'apps/web/site/page.test.tsx'), 'export {};\n');
  for (const path of ['apps/web/site/page.tsx', 'apps/web/site/page.test.tsx', 'apps/web/site']) {
    at(root, path, 1000);
  }
  at(root, 'apps/web', 1000);
  at(root, 'apps', 1000);
  return root;
};

describe('unit · newestSourceMtime', () => {
  test('a source file, in milliseconds', async () => {
    const root = await tree();
    at(root, 'apps/web/site/page.tsx', 2000);
    expect(await newestSourceMtime(root)).toBe(2_000_000);
  });

  test('a test file ships no bytes, so it moves nothing', async () => {
    const root = await tree();
    at(root, 'apps/web/site/page.test.tsx', 3000);
    expect(await newestSourceMtime(root)).toBe(1_000_000);
  });

  test('a source directory counts: it is what a deletion moves', async () => {
    const root = await tree();
    at(root, 'apps/web', 4000);
    expect(await newestSourceMtime(root)).toBe(4_000_000);
  });

  test('app.config.ts and bun.lock count, outside every source glob', async () => {
    const root = await tree();
    await Bun.write(join(root, 'bun.lock'), '{}\n');
    at(root, 'bun.lock', 5000);
    expect(await newestSourceMtime(root)).toBe(5_000_000);
  });

  test('an app with no source has none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-mtime-'));
    roots.push(root);
    expect(await newestSourceMtime(root)).toBeUndefined();
  });
});
