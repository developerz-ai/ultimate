// A module two islands import is ONE file a browser fetches once, not a copy inside each island.
// Real builds of a fixture shaped like the one that found it (notificado.co, 2026-09-29): two
// islands on one page, both importing a ~20 kB upload helper, weighed 55.5 kB against ~34 kB.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { mountIsland } from '@ultimat3/testing';
import { buildIslands, writeIslands } from './island-bundle';
import { clearIslandChunkCache } from './island-identity';

const ROOT = join(import.meta.dir, '..', '.island-fixture', 'shared-chunks');
/** `islands: { sharedChunks: true }`, asked of the build directly rather than through a config file. */
const SHARED = { sharedChunks: true } as const;

/** ~20 kB that survives the minifier: a string literal is emitted as written. */
const PAYLOAD_BYTES = 20_000;
const UPLOAD = `
const PAYLOAD = '${'u'.repeat(PAYLOAD_BYTES)}';
export function uploadFile(name: string): string { return name + ':' + PAYLOAD; }
`;
const islandUsing = (label: string): string => `
import { uploadFile } from '../../shared/upload';
export function mount(el: { textContent: string }): void { el.textContent = uploadFile('${label}'); }
`;
const SOLO = `export function mount(el: { textContent: string }): void { el.textContent = 'solo'; }\n`;

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
  await write('package.json', JSON.stringify({ name: 'shared-chunks-fixture' }));
  await write('apps/web/shared/upload.ts', UPLOAD);
  await write('apps/web/app/afiliados/kyc-file.island.tsx', islandUsing('kyc'));
  await write('apps/web/app/afiliados/einvoice-upload.island.tsx', islandUsing('einvoice'));
});

afterEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
});

describe('two islands importing one module', () => {
  test('the module is one shared chunk, and neither island carries a copy', async () => {
    const bundle = await buildIslands(ROOT, SHARED);

    expect(bundle.chunks).toHaveLength(2);
    expect(bundle.shared).toHaveLength(1);
    const [shared] = bundle.shared;
    expect(shared?.url).toMatch(/^\/islands\/chunk-[0-9a-f]{8}\.js$/);
    expect(shared?.bytes).toBeGreaterThan(PAYLOAD_BYTES);
    expect(shared?.importers).toEqual([
      'apps/web/app/afiliados/einvoice-upload.island.tsx',
      'apps/web/app/afiliados/kyc-file.island.tsx',
    ]);
    for (const chunk of bundle.chunks) {
      expect(chunk.bytes).toBeLessThan(1_000);
      expect(chunk.imports).toEqual([shared?.url ?? '']);
      // Relative, so it resolves under whatever base path serves the entry — `/islands/` here, a
      // temp directory in `mountIsland`.
      expect(chunk.code).toContain(`"./${shared?.url.split('/').at(-1)}"`);
    }
    expect(bundle.assetAt(shared?.url ?? '')?.code).toBe(shared?.code);
    expect(bundle.chunkAt(shared?.url ?? '')).toBeUndefined();
  });

  test('the files a static export writes link: each entry runs against the one shared file', async () => {
    const bundle = await buildIslands(ROOT, SHARED);
    const out = join(ROOT, 'out');
    await writeIslands(bundle, out);

    for (const chunk of bundle.chunks) {
      const island = (await import(join(out, chunk.url.slice(1)))) as {
        mount: (el: { textContent: string }) => void;
      };
      const el = { textContent: '' };
      island.mount(el);
      expect(el.textContent).toMatch(new RegExp(`^(kyc|einvoice):u{${PAYLOAD_BYTES}}$`));
    }
  });

  test('mountIsland boots an entry that imports a shared chunk', async () => {
    // The whole bundle, not `only`: a lone island's build has nothing to share.
    using mounted = await mountIsland({
      build: (root) => buildIslands(root, SHARED),
      root: ROOT,
      file: 'apps/web/app/afiliados/kyc-file.island.tsx',
    });
    expect(mounted.el.textContent).toBe(`kyc:${'u'.repeat(PAYLOAD_BYTES)}`);
  });

  test('an unchanged graph keeps every URL; an edit to the shared module moves all three', async () => {
    const urls = async (): Promise<readonly string[]> => {
      clearIslandChunkCache();
      const bundle = await buildIslands(ROOT, SHARED);
      return [...bundle.chunks.map((one) => one.url), ...bundle.shared.map((one) => one.url)];
    };
    const first = await urls();
    expect(await urls()).toEqual(first);

    await write('apps/web/shared/upload.ts', `${UPLOAD}\nexport const extra = 1;\n`);
    const moved = await urls();
    // The entries name the shared chunk's URL inside their bytes, so its move is theirs too — an
    // entry kept at its old URL would be an `immutable` file importing a chunk that 404s.
    for (const url of moved) expect(first).not.toContain(url);
  });
});

describe('without islands.sharedChunks — the default', () => {
  test('each island is self-contained and carries its own copy, as it always has', async () => {
    const bundle = await buildIslands(ROOT);
    expect(bundle.shared).toEqual([]);
    for (const chunk of bundle.chunks) {
      expect(chunk.imports).toEqual([]);
      expect(chunk.bytes).toBeGreaterThan(PAYLOAD_BYTES);
    }
  });

  test('app.config.ts turns it on for every build that reads the app', async () => {
    await write(
      'app.config.ts',
      "export const config = { name: 'shared-chunks-fixture', islands: { sharedChunks: true } };\n",
    );
    expect((await buildIslands(ROOT)).shared).toHaveLength(1);
  });
});

describe('an island that shares nothing', () => {
  test('is one self-contained chunk, byte for byte what a lone build of it emits', async () => {
    await write('apps/web/site/solo.island.tsx', SOLO);
    const bundle = await buildIslands(ROOT, SHARED);
    const solo = bundle.chunks.find((one) => one.file === 'apps/web/site/solo.island.tsx');

    expect(solo?.imports).toEqual([]);
    const alone = await Bun.build({
      entrypoints: [join(ROOT, 'apps/web/site/solo.island.tsx')],
      target: 'browser',
      format: 'esm',
      minify: true,
    });
    expect(solo?.code.trim()).toBe((await alone.outputs[0]?.text())?.trim());
  });
});
