// The realtime answer a build needs (`appPersistsRecords`) is asked once, of the loaded app, and
// only by a group one of whose islands reaches realtime — so `x dev` can bundle beside the app
// load without reading the empty registry, and the cache key and the build read one answer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity — Bun ships no recursive delete, and a fixture root may not exist.
import { rm, utimes } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { clearIslandChunkCache } from './island-identity';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'persists'));
const READER = 'apps/web/app/reader.island.tsx';
const PLAIN = 'apps/web/app/plain.island.tsx';

beforeEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'persists-fixture' }));
  await Bun.write(
    join(ROOT, READER),
    "import { useQuery } from '@ultimat3/realtime';\nexport function mount(): void { void useQuery; }\n",
  );
  await Bun.write(join(ROOT, PLAIN), 'export function mount(): void {}\n');
  // An hour old, so the cache records them (`writeGroup`'s mtime slack).
  const old = new Date(performance.timeOrigin + performance.now() - 3_600_000);
  for (const file of [READER, PLAIN]) await utimes(join(ROOT, file), old, old);
});

afterEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
});

const kindOf = (bundle: IslandBundle): string | undefined =>
  bundle.chunks.find((chunk) => chunk.file === READER)?.realtime;

describe('options.persists', () => {
  test('is the answer the realtime kind is read with', async () => {
    const follows = await buildIslands(ROOT, { reuse: false, persists: async () => false });
    expect(kindOf(follows)).toBe('follows');
    clearIslandChunkCache();
    const restores = await buildIslands(ROOT, { reuse: false, persists: async () => true });
    expect(kindOf(restores)).toBe('restores');
  });

  test('is the answer the cache key is read with: another answer is another entry', async () => {
    expect(kindOf(await buildIslands(ROOT, { persists: async () => false }))).toBe('follows');
    clearIslandChunkCache();
    expect(kindOf(await buildIslands(ROOT, { persists: async () => true }))).toBe('restores');
  });

  test('is asked once per build, however many groups reach realtime', async () => {
    let asked = 0;
    await Bun.write(
      join(ROOT, 'apps/web/app/twin.island.tsx'),
      await Bun.file(join(ROOT, READER)).text(),
    );
    await buildIslands(ROOT, {
      reuse: false,
      persists: async () => {
        asked += 1;
        return false;
      },
    });
    expect(asked).toBe(1);
  });

  test('is never awaited by a group with no realtime island: it builds while the app loads', async () => {
    const never = new Promise<boolean | undefined>(() => undefined);
    const built = await buildIslands(ROOT, { only: PLAIN, reuse: false, persists: () => never });
    expect(built.chunks.map((chunk) => chunk.file)).toEqual([PLAIN]);
  });
});
