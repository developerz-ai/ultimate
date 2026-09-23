// The container's island chunks, written once by `x build --target docker` and verified at boot.
// A real build of a fixture app, then every way the store can be wrong and must be refused.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
import { join } from 'node:path'; // why: Bun exposes no path API — nothing native joins a path.
import { buildIslands } from './island-bundle';
import { ISLAND_STORE_DIR, readIslandStore, writeIslandStore } from './island-store';

const ROOT = join(import.meta.dir, '..', '.island-fixture', 'store');
const PLAIN = `export function mount(el: HTMLElement): void { el.textContent = 'plain'; }\n`;

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await write('package.json', JSON.stringify({ name: 'island-store-fixture' }));
  await write('apps/web/site/plain.island.tsx', PLAIN);
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const stored = async (): Promise<void> => {
  await writeIslandStore(ROOT, await buildIslands(ROOT));
};

describe('unit · the island store', () => {
  test('a written store reads back as the same chunks, at the same URLs', async () => {
    const built = await buildIslands(ROOT);
    await writeIslandStore(ROOT, built);
    const read = await readIslandStore(ROOT);
    expect(read.stale).toBeUndefined();
    expect(read.bundle?.chunks.map((chunk) => [chunk.url, chunk.code])).toEqual(
      built.chunks.map((chunk) => [chunk.url, chunk.code]),
    );
  });

  test('no store is stale, and says there is none', async () => {
    expect((await readIslandStore(ROOT)).stale).toBe(`no ${ISLAND_STORE_DIR}/index.json`);
  });

  test('a chunk whose bytes changed is refused', async () => {
    await stored();
    const [url] = (await readIslandStore(ROOT)).bundle?.chunks.map((chunk) => chunk.url) ?? [];
    await Bun.write(join(ROOT, ISLAND_STORE_DIR, (url ?? '').split('/').at(-1) ?? ''), 'tampered');
    expect((await readIslandStore(ROOT)).stale).toContain('does not match its recorded hash');
  });

  test('an island the store does not hold is refused', async () => {
    await stored();
    await write('apps/web/site/second.island.tsx', PLAIN);
    expect((await readIslandStore(ROOT)).stale).toBe(
      'the stored islands are not the islands this app has',
    );
  });

  test('a store another Bun built is refused', async () => {
    await stored();
    const path = join(ROOT, ISLAND_STORE_DIR, 'index.json');
    const index = (await Bun.file(path).json()) as Record<string, unknown>;
    await Bun.write(path, JSON.stringify({ ...index, bun: '0.0.1' }));
    expect((await readIslandStore(ROOT)).stale).toContain('on Bun 0.0.1');
  });
});
