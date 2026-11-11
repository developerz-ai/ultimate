// The environment every island group's cache key shares: whatever decides how an import resolves
// without being a file the bundler reads — the lockfile, tsconfig `paths`, and each package
// manifest's `exports`/`imports`, a workspace member's included.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity — Bun ships no recursive delete, and a fixture root may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { environmentDigest, resolutionDirs } from './island-cache-inputs';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'cache-inputs'));
const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  // Its own lockfile: the walk stops here, never at the repository's.
  await write('bun.lock', '{}\n');
  await write('package.json', JSON.stringify({ name: 'fx', workspaces: ['apps/*', 'packages/*'] }));
  await write('apps/web/package.json', JSON.stringify({ name: 'web' }));
  await write('packages/lib/package.json', JSON.stringify({ name: 'lib', exports: './a.ts' }));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('environmentDigest', () => {
  test("moves with a workspace member's manifest: its exports decide what an island imports", async () => {
    const before = await environmentDigest(ROOT);
    expect(await environmentDigest(ROOT)).toBe(before);
    await write('packages/lib/package.json', JSON.stringify({ name: 'lib', exports: './b.ts' }));
    expect(await environmentDigest(ROOT)).not.toBe(before);
  });

  test('moves with the lockfile, an app manifest and a tsconfig in the extends chain', async () => {
    await write('tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json' }));
    await write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    let last = await environmentDigest(ROOT);
    for (const [path, text] of [
      ['bun.lock', '{"x":1}\n'],
      ['apps/web/package.json', JSON.stringify({ name: 'web', imports: {} })],
      ['tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { a: ['b'] } } })],
    ] as const) {
      await write(path, text);
      const next = await environmentDigest(ROOT);
      expect(next).not.toBe(last);
      last = next;
    }
  });
});

describe('resolutionDirs', () => {
  test("each input's directory, and an index file's parent where a shadowing file lands", () => {
    expect(resolutionDirs(['/a/b/x.ts', '/a/b/util/index.ts'])).toEqual(['/a/b', '/a/b/util']);
  });
});
