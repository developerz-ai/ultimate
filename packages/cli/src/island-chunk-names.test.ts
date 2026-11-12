// Issue #1075: every `immutable`-served build asset is named by its FINAL bytes. Two builds emitted
// `/islands/chunk-50bf7646.js` with the shared chunk's minified export names swapped
// (`var g=q(…),y=Fe(…)` against `var y=q(…),g=Fe(…)`): the chunk's sources had not moved, an
// ENTRY had, and the minifier names a shared chunk's exports by how often the whole build uses
// them. A CDN holding build A's copy handed build B's islands the action client as the query
// client.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { clearStylesheets, contentHash } from '@ultimat3/render/server';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { clearIslandChunkCache } from './island-identity';
import { processRoot } from './process-root-fixture';
import { buildNavigationScript, buildPageBoot, buildSyncWorker } from './worker-bundle';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'chunk-names'));
const SHARED = { sharedChunks: true, reuse: false } as const;
const CHECKOUT = join(import.meta.dir, '..', '..');

/** The issue's shared module, unchanged between the two builds: an rpc and a query client. */
const CLIENTS = `
function client(kind: string) {
  return { kind, call(path: string): string { return kind + ':' + path; } };
}
export const rpc = client('rpc');
export const queryClient = client('query');
`;

/** An island using each client N times — the one thing the two builds differ in. */
const islandUsing = (rpc: number, query: number): string => `
import { queryClient, rpc } from '../shared/clients';
export function mount(el: { dataset: Record<string, string> }): void {
  el.dataset['a'] = [${Array(rpc).fill("rpc.call('a')").join(', ')}].join();
  el.dataset['b'] = [${Array(query).fill("queryClient.call('b')").join(', ')}].join();
}
`;

const OTHER = `
import { queryClient } from '../shared/clients';
export function mount(el: { textContent: string }): void { el.textContent = queryClient.call('x'); }
`;

/** A realtime island, so the page runtime chunk is one of the assets under test. */
const LIVE = `
import { useConnection } from '@ultimat3/realtime';
export function mount(el: { textContent: string }): void { el.textContent = typeof useConnection; }
`;

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

/** Every asset a browser is told it may keep forever, by URL. */
const assets = (bundle: IslandBundle): ReadonlyMap<string, string> =>
  new Map([...bundle.chunks, ...bundle.shared].map((one) => [one.url, one.code]));

const buildWith = async (rpc: number, query: number): Promise<IslandBundle> => {
  clearIslandChunkCache();
  await write('apps/web/app/logs.island.tsx', islandUsing(rpc, query));
  return buildIslands(ROOT, SHARED);
};

/** The 8-hex hash ending every served name: `<id>-`, `chunk-`, `page-runtime.`, or bare. */
const nameHash = (url: string): string | undefined => /([0-9a-f]{8})\.js$/.exec(url)?.[1];

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await write('package.json', JSON.stringify({ name: 'chunk-names-fixture' }));
  await write('apps/web/shared/clients.ts', CLIENTS);
  await write('apps/web/app/other.island.tsx', OTHER);
  await write('apps/web/app/live.island.tsx', LIVE);
});

afterAll(async () => {
  clearIslandChunkCache();
  clearStylesheets();
  await rm(ROOT, { recursive: true, force: true });
});

describe('two builds whose shared chunk differs only in minified export names (#1075)', () => {
  test('the fixture reproduces the swap: one shared source, two byte strings', async () => {
    const a = await buildWith(1, 6);
    const b = await buildWith(6, 1);
    const clientsOf = (bundle: IslandBundle): string | undefined =>
      bundle.shared.find((one) => one.code.includes('"query"'))?.code;
    // Without this, the test below could pass on a fixture the minifier happens not to reorder.
    expect(clientsOf(a)).toBeDefined();
    expect(clientsOf(a)).not.toBe(clientsOf(b));
  }, 60_000);

  test('a file name both builds emit carries identical bytes in both', async () => {
    const a = assets(await buildWith(1, 6));
    const b = assets(await buildWith(6, 1));
    const both = [...a.keys()].filter((url) => b.has(url));
    for (const url of both) expect({ url, code: b.get(url) }).toEqual({ url, code: a.get(url) });
  }, 60_000);
});

describe('every immutable-served asset is named by its bytes', () => {
  test('islands, shared chunks, page runtime: the name is the hash of the code', async () => {
    const bundle = await buildWith(2, 3);
    expect(bundle.shared.some((one) => one.url.includes('/page-runtime.'))).toBe(true);
    expect(bundle.shared.some((one) => one.url.includes('/chunk-'))).toBe(true);
    for (const [url, code] of assets(bundle)) {
      expect({ url, hash: nameHash(url) }).toEqual({ url, hash: contentHash(code) });
    }
  }, 60_000);

  test('the /_x/assets framework scripts: sync worker, page boot, client router', async () => {
    const entry = join(ROOT, 'sync-worker.ts');
    await Bun.write(entry, "self.addEventListener('connect', () => undefined);\n");
    const scripts = [
      await buildSyncWorker(ROOT, { entry }),
      await buildPageBoot(join(CHECKOUT, 'realtime')),
      await buildNavigationScript(join(CHECKOUT, 'render')),
    ];
    for (const script of scripts) {
      if (script === undefined) expect.unreachable('a framework script did not build');
      expect({ url: script.url, hash: nameHash(script.url) }).toEqual({
        url: script.url,
        hash: contentHash(script.code),
      });
    }
  }, 60_000);
});
