// The container's island chunks, written once by `x build --target docker` and verified at boot.
// A real build of a fixture app, then every way the store can be wrong and must be refused.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
import { join } from 'node:path'; // why: Bun exposes no path API — nothing native joins a path.
import { clearStylesheets, stylesFor } from '@ultimat3/render/server';
import { buildIslands } from './island-bundle';
import {
  ISLAND_STORE_DIR,
  loadOrBuildIslands,
  readIslandStore,
  writeIslandStore,
} from './island-store';

const ROOT = join(import.meta.dir, '..', '.island-fixture', 'store');
/** `islands: { sharedChunks: true }`, asked of the build directly rather than through a config file. */
const SHARED = { sharedChunks: true } as const;
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

describe('unit · the island store carries the shared chunks', () => {
  const USING =
    "import { help } from '../shared/helper';\n" +
    'export function mount(el: HTMLElement): void { el.textContent = help(); }\n';

  beforeEach(async () => {
    await write('apps/web/shared/helper.ts', "export const help = (): string => 'shared';\n");
    await write('apps/web/site/a.island.tsx', USING);
    await write('apps/web/site/b.island.tsx', USING);
  });

  test('a written store reads back with every shared chunk, at the same URL', async () => {
    const built = await buildIslands(ROOT, SHARED);
    expect(built.shared).toHaveLength(1);
    await writeIslandStore(ROOT, built);
    const read = await readIslandStore(ROOT);
    expect(read.stale).toBeUndefined();
    expect(read.bundle?.shared.map((chunk) => [chunk.url, chunk.code])).toEqual(
      built.shared.map((chunk) => [chunk.url, chunk.code]),
    );
    expect(read.bundle?.chunks.map((chunk) => chunk.imports)).toEqual(
      built.chunks.map((chunk) => chunk.imports),
    );
  });

  test('a shared chunk missing from the store is refused, never served as a 404 per pod', async () => {
    const built = await buildIslands(ROOT, SHARED);
    await writeIslandStore(ROOT, built);
    await rm(join(ROOT, ISLAND_STORE_DIR, built.shared[0]?.url.split('/').at(-1) ?? ''));
    expect((await readIslandStore(ROOT)).stale).toContain('does not match its recorded hash');
  });
});

/**
 * K8: a store verified only its own bytes, so an island edited after `x build --target prebuilt`
 * still verified and the boot served the chunk built from the OLD source. Each chunk now records
 * the files it was built from, and a boot rehashes exactly those.
 */
describe('unit · the island store is stale once a source it was built from changes', () => {
  const USING =
    "import { help } from '../shared/helper';\n" +
    'export function mount(el: HTMLElement): void { el.textContent = help(); }\n';

  test('an edited island source is stale', async () => {
    await stored();
    expect((await readIslandStore(ROOT)).stale).toBeUndefined();
    await write('apps/web/site/plain.island.tsx', PLAIN.replace("'plain'", "'edited'"));
    expect((await readIslandStore(ROOT)).stale).toContain('apps/web/site/plain.island.tsx');
  });

  test('a module an island imports is a source too, and so is a deleted one', async () => {
    await write('apps/web/shared/helper.ts', "export const help = (): string => 'one';\n");
    await write('apps/web/site/a.island.tsx', USING);
    await stored();
    expect((await readIslandStore(ROOT)).stale).toBeUndefined();
    await write('apps/web/shared/helper.ts', "export const help = (): string => 'two';\n");
    expect((await readIslandStore(ROOT)).stale).toContain('apps/web/shared/helper.ts');
    await rm(join(ROOT, 'apps/web/shared/helper.ts'));
    expect((await readIslandStore(ROOT)).stale).toContain('apps/web/shared/helper.ts');
  });

  test("a shared chunk's module is rehashed the same way", async () => {
    await write('apps/web/shared/helper.ts', "export const help = (): string => 'one';\n");
    await write('apps/web/site/a.island.tsx', USING);
    await write('apps/web/site/b.island.tsx', USING);
    const built = await buildIslands(ROOT, SHARED);
    expect(built.shared).toHaveLength(1);
    await writeIslandStore(ROOT, built);
    expect((await readIslandStore(ROOT)).stale).toBeUndefined();
    await write('apps/web/shared/helper.ts', "export const help = (): string => 'two';\n");
    expect((await readIslandStore(ROOT)).stale).toContain('apps/web/shared/helper.ts');
  });

  test('a store that recorded no sources cannot be checked, so it is stale', async () => {
    await stored();
    const path = join(ROOT, ISLAND_STORE_DIR, 'index.json');
    const index = (await Bun.file(path).json()) as { chunks: Record<string, unknown>[] };
    const chunks = index.chunks.map(({ sources: _dropped, ...rest }) => rest);
    await Bun.write(path, JSON.stringify({ ...index, chunks }));
    expect((await readIslandStore(ROOT)).stale).toContain('records no checkable sources');
  });

  // L3: the index is a file on disk, and a recorded path is read at every boot. One the writer
  // could never have recorded — outside the root, absolute, under node_modules — is refused before
  // anything reads it: `../../etc/hostname` is a read outside the app, `/dev/zero` a boot that
  // never ends.
  test('a recorded source the writer could not have produced is stale, and never read', async () => {
    await stored();
    const path = join(ROOT, ISLAND_STORE_DIR, 'index.json');
    const index = (await Bun.file(path).json()) as { chunks: Record<string, unknown>[] };
    for (const hostile of [
      '../../etc/hostname',
      '/dev/zero',
      'apps/../../outside.ts',
      'node_modules/pkg/index.js',
      '',
    ]) {
      const chunks = index.chunks.map((chunk) => ({
        ...chunk,
        sources: [{ path: hostile, digest: 'x' }],
      }));
      await Bun.write(path, JSON.stringify({ ...index, chunks }));
      expect((await readIslandStore(ROOT)).stale).toContain('records no checkable sources');
    }
  });

  test('a stale store is rebuilt from the edited source, never served', async () => {
    await stored();
    await write('apps/web/site/plain.island.tsx', PLAIN.replace("'plain'", "'edited'"));
    const loaded = await loadOrBuildIslands(ROOT);
    expect(loaded.built?.reason).toContain('apps/web/site/plain.island.tsx');
    expect(loaded.bundle.chunks[0]?.code).toContain('edited');
  });
});

// LAST, deliberately: an island build's stylesheets are process-global (`island-styles.ts`), so
// once these run every later store in this file names a sheet the next fixture deletes.
/**
 * A container that served the stored chunks never ran the island build, so an island's own
 * `.module.scss` never registered: its rules were missing from every pod that read the store, and
 * present on any that rebuilt — two surface stylesheets for one image (notificado.co, 22.3.2).
 */
describe('unit · the island store carries the island stylesheets', () => {
  const STYLED =
    "import styles from './styled.module.scss';\n" +
    'export function mount(el: HTMLElement): void { el.className = styles.box ?? ""; }\n';

  test('the index names them, app-relative; a boot from the store registers them', async () => {
    await write('apps/web/site/styled.module.scss', '.box{color:teal}');
    await write('apps/web/site/styled.island.tsx', STYLED);
    await stored();
    const index = (await Bun.file(join(ROOT, ISLAND_STORE_DIR, 'index.json')).json()) as {
      stylesheets: string[];
    };
    expect(index.stylesheets).toEqual(['apps/web/site/styled.module.scss']);
    clearStylesheets();
    expect(stylesFor('site')).not.toContain('teal');
    expect((await readIslandStore(ROOT)).stale).toBeUndefined();
    expect(stylesFor('site')).toContain('teal');
  });

  test('a store naming a stylesheet the app no longer has is refused', async () => {
    await write('apps/web/site/styled.module.scss', '.box{color:teal}');
    await write('apps/web/site/styled.island.tsx', STYLED);
    await stored();
    await rm(join(ROOT, 'apps/web/site/styled.module.scss'));
    // The sheet is also one of the chunk's recorded sources, and those are checked first.
    expect((await readIslandStore(ROOT)).stale).toContain('apps/web/site/styled.module.scss');
  });
});
