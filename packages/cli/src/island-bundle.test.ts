// The bundler half of an island, against real files and a real `Bun.build`: the property under
// test is what lands in the chunk table, and a fake builder would prove nothing about it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { buildIslands, discoverIslands, ISLAND_BASE_PATH, islandBundle } from './island-bundle';

const ROOT = join(import.meta.dir, '..', '.island-fixture');

const MODULE = (text: string): string =>
  `export function mount(el: HTMLElement): void { el.textContent = ${JSON.stringify(text)}; }\n`;

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'island-fixture' }));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const codeOf = (error: unknown): string =>
  error instanceof UltimateError ? error.code : `not an UltimateError: ${String(error)}`;

describe('discoverIslands', () => {
  test('finds a client entry on every surface that renders a document, and only those', async () => {
    await write('apps/web/site/counter.island.tsx', MODULE('site'));
    await write('apps/web/app/panel.island.tsx', MODULE('app'));
    await write('apps/web/shared/modal.island.tsx', MODULE('shared'));
    // Not islands: an API route emits no document, and a page is not a client entry.
    await write('apps/web/api/hook.island.tsx', MODULE('api'));
    await write('apps/web/site/page.tsx', 'export const Page = (): string => "";\n');

    expect(await discoverIslands(ROOT)).toEqual([
      'apps/web/app/panel.island.tsx',
      'apps/web/shared/modal.island.tsx',
      'apps/web/site/counter.island.tsx',
    ]);
  });

  test('an app with no island builds an empty table rather than failing', async () => {
    expect((await buildIslands(ROOT)).chunks).toEqual([]);
  });
});

describe('buildIslands', () => {
  test('one content-addressed chunk per island, keyed by the id the document names', async () => {
    await write('apps/web/site/counter.island.tsx', MODULE('one'));
    const bundle = await buildIslands(ROOT);
    const chunk = bundle.chunks[0];

    expect(bundle.chunks).toHaveLength(1);
    expect(chunk?.moduleId).toBe('counter');
    expect(chunk?.url).toMatch(new RegExp(`^${ISLAND_BASE_PATH}/counter-[0-9a-f]{8}\\.js$`));
    expect(chunk?.bytes).toBeGreaterThan(0);
    expect(bundle.chunkAt(chunk?.url ?? '')).toBe(chunk);
  });

  test('the same source hashes to the same URL, and an edited one does not', async () => {
    await write('apps/web/site/counter.island.tsx', MODULE('one'));
    const first = (await buildIslands(ROOT)).chunks[0]?.url;
    expect((await buildIslands(ROOT)).chunks[0]?.url).toBe(first);

    await write('apps/web/site/counter.island.tsx', MODULE('two'));
    expect((await buildIslands(ROOT)).chunks[0]?.url).not.toBe(first);
  });

  test('two islands sharing a filename are two chunks — the hash is what keeps them apart', async () => {
    await write('apps/web/site/a/modal.island.tsx', MODULE('a'));
    await write('apps/web/site/b/modal.island.tsx', MODULE('b'));
    const urls = (await buildIslands(ROOT)).chunks.map((chunk) => chunk.url);
    expect(new Set(urls).size).toBe(2);
  });

  test('a client entry that will not compile fails the build naming the file', async () => {
    await write(
      'apps/web/site/broken.island.tsx',
      "import { gone } from './nowhere';\nexport const mount = (): unknown => gone;\n",
    );
    expect(await buildIslands(ROOT).then(() => 'built', codeOf)).toBe('X_BUILD_FAILED');
  });
});

describe('resolverFor', () => {
  test('a page specifier becomes the chunk URL, resolved against the page file', async () => {
    await write('apps/web/site/pricing/calculator.island.tsx', MODULE('calc'));
    await write('apps/web/shared/modal.island.tsx', MODULE('modal'));
    const bundle = await buildIslands(ROOT);
    const resolve = bundle.resolverFor('apps/web/site/pricing/page.tsx');

    expect(resolve('./calculator.island.tsx')).toMatch(/^\/islands\/calculator-/);
    expect(resolve('../../shared/modal.island.tsx')).toMatch(/^\/islands\/modal-/);
  });

  test('a src naming a file the build never bundled is X_ISLAND_INVALID, with the resolved path', async () => {
    const resolve = islandBundle([]).resolverFor('apps/web/site/page.tsx');
    let thrown: unknown;
    try {
      resolve('./missing.island.tsx');
    } catch (error) {
      thrown = error;
    }
    // Loud and by name: the alternative is a `data-x-entry` pointing at nothing, which is a page
    // that renders, serves, passes every gate and does nothing when clicked.
    expect(codeOf(thrown)).toBe('X_ISLAND_INVALID');
    expect((thrown as UltimateError).message).toContain('apps/web/site/missing.island.tsx');
  });
});
