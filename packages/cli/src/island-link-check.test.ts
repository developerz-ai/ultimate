// #1075's post-build smoke: a query island built against a shared chunk binds the QUERY client,
// and a bundle whose files do not link — one importing a name its sibling no longer exports, the
// shape a stale `immutable` copy hands a browser — is refused at build, never shipped blank.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { readdir, rm, utimes } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { contentHash } from '@ultimat3/render/server';
import { mountIsland } from '@ultimat3/testing';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { ISLAND_CACHE_DIR } from './island-group-cache';
import { clearIslandChunkCache } from './island-identity';
import { refuseUnboundImports, unboundImports } from './island-link-check';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'link-check'));

/** The issue's shared module: an rpc and a query client a minifier names by build-wide use. */
const CLIENTS = `
function client(kind: string) {
  return { kind, call(path: string): string { return kind + ':' + path; } };
}
export const rpc = client('rpc');
export const queryClient = client('query');
`;
const QUERY_ISLAND = `
import { queryClient } from '../shared/clients';
export function mount(el: { textContent: string }): void { el.textContent = queryClient.call('feed'); }
`;
const ACTION_ISLAND = `
import { rpc, queryClient } from '../shared/clients';
export function mount(el: { textContent: string }): void {
  el.textContent = [rpc.call('a'), rpc.call('b'), rpc.call('c'), queryClient.kind].join();
}
`;

let bundle: IslandBundle;

beforeAll(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'link-check-fixture' }));
  await Bun.write(join(ROOT, 'apps/web/shared/clients.ts'), CLIENTS);
  await Bun.write(join(ROOT, 'apps/web/app/feed.island.tsx'), QUERY_ISLAND);
  await Bun.write(join(ROOT, 'apps/web/app/compose.island.tsx'), ACTION_ISLAND);
  bundle = await buildIslands(ROOT, { sharedChunks: true, reuse: false });
});

afterAll(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
});

const assets = (one: IslandBundle) => [...one.chunks, ...one.shared];

describe('a built bundle', () => {
  test('the query island boots bound to the query client, through the shared chunk', async () => {
    expect(bundle.shared).toHaveLength(1);
    using mounted = await mountIsland({
      build: async () => bundle,
      root: ROOT,
      file: 'apps/web/app/feed.island.tsx',
    });
    expect(mounted.el.textContent).toBe('query:feed');
  });

  test('every name an entry imports from its shared chunk is exported by it', () => {
    expect(unboundImports(assets(bundle))).toEqual([]);
  });
});

describe('a bundle whose files do not link', () => {
  /** The shared chunk with its export names swapped for ones no entry imports: a stale copy. */
  const stale = (): readonly { url: string; code: string; file?: string }[] => {
    const [shared] = bundle.shared;
    const code = (shared?.code ?? '').replace(/export\s*\{[^}]*\}/, 'export{}');
    return [...bundle.chunks, { url: shared?.url ?? '', code }];
  };

  test('every unbound import is named, importer and target', () => {
    const found = unboundImports(stale());
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found.map((one) => one.target))).toEqual(new Set([bundle.shared[0]?.url ?? '']));
    expect(found.map((one) => one.file).sort()).toContain('apps/web/app/feed.island.tsx');
  });

  test('is X_BUILD_FAILED naming the island, never a blank island in the browser', () => {
    let code = 'resolved';
    let cause = '';
    try {
      refuseUnboundImports(stale());
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'uncoded';
      cause = isUltimateError(error) ? error.cause : '';
    }
    expect(code).toBe('X_BUILD_FAILED');
    expect(cause).toContain('.island.tsx');
    expect(cause).toContain(bundle.shared[0]?.url ?? '');
  });

  test('a specifier naming no output of the bundle is not the check’s', () => {
    const code = 'import{a as b}from"./elsewhere.js";export{b as c};';
    expect(unboundImports([{ url: '/islands/x-1.js', code }])).toEqual([]);
  });

  test('buildIslands runs the check over what a cache hands back', async () => {
    // A cached group is reused byte for byte, so a stale entry is the shape a real build can meet:
    // the check must run over the MERGED bundle, never only over a fresh build's output.
    // Stamped an hour back: the cache refuses an entry whose inputs changed near the build's start.
    const past = new Date(Date.now() - 3_600_000);
    for (const path of [
      'apps/web/shared/clients.ts',
      'apps/web/app/feed.island.tsx',
      'apps/web/app/compose.island.tsx',
      'apps/web/shared',
      'apps/web/app',
      'apps/web',
      'apps',
    ]) {
      await utimes(join(ROOT, path), past, past);
    }
    clearIslandChunkCache();
    await buildIslands(ROOT, { sharedChunks: true });
    const dir = join(ROOT, ISLAND_CACHE_DIR);
    for (const name of (await readdir(dir)).filter((one) => one.endsWith('.json'))) {
      const entry = (await Bun.file(join(dir, name)).json()) as {
        shared: { code: string; codeHash: string }[];
      };
      for (const one of entry.shared) {
        one.code = one.code.replace(/export\s*\{[^}]*\}/, 'export{}');
        one.codeHash = contentHash(one.code);
      }
      await Bun.write(join(dir, name), JSON.stringify(entry));
    }
    clearIslandChunkCache();
    const refused = await buildIslands(ROOT, { sharedChunks: true }).then(
      () => 'built',
      (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
    );
    await rm(dir, { recursive: true, force: true });
    expect(refused).toBe('X_BUILD_FAILED');
  }, 30_000);
});
