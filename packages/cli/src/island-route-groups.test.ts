// The default build, against real files: islands one route renders together share their code as
// one chunk, and an island rendered anywhere on its own stays the self-contained file it always was.
// The shape that asked for it: examples/dummy's `/posts/:id`, three islands on one route.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity — Bun ships no recursive delete, and a fixture root may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { buildIslands } from './island-bundle';
import { clearIslandChunkCache } from './island-identity';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'route-groups'));

/** ~20 kB that survives the minifier: a string literal is emitted as written. */
const PAYLOAD_BYTES = 20_000;
const SHARED = `
const PAYLOAD = '${'u'.repeat(PAYLOAD_BYTES)}';
export function shared(name: string): string { return name + ':' + PAYLOAD; }
`;
/** `up` is the island's depth below `apps/web`, so every island imports the ONE module. */
const islandUsing = (label: string, up: string): string => `
import { shared } from '${up}shared/payload';
export function mount(el: { textContent: string }): void { el.textContent = shared('${label}'); }
`;

const LIKE = 'apps/web/app/posts/[id]/like.island.tsx';
const SUMMARY = 'apps/web/app/posts/[id]/summary.island.tsx';
const FEED = 'apps/web/app/feed/feed.island.tsx';
const POST_PAGE = `
const Like = island({ src: './like.island.tsx' });
const Summary = island({ src: './summary.island.tsx' });
`;

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
  await write('package.json', JSON.stringify({ name: 'route-groups-fixture' }));
  await write('apps/web/shared/payload.ts', SHARED);
  await write(LIKE, islandUsing('like', '../../../'));
  await write(SUMMARY, islandUsing('summary', '../../../'));
  await write(FEED, islandUsing('feed', '../../'));
  await write('apps/web/app/posts/[id]/page.tsx', POST_PAGE);
  await write('apps/web/app/feed/page.tsx', `const Feed = island({ src: './feed.island.tsx' });\n`);
});

afterEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
});

const chunkOf = (bundle: Awaited<ReturnType<typeof buildIslands>>, file: string) =>
  bundle.chunks.find((one) => one.file === file);

describe('islands one route renders together', () => {
  test('share one chunk; the route pays for the module once', async () => {
    const bundle = await buildIslands(ROOT);

    expect(bundle.shared).toHaveLength(1);
    const [shared] = bundle.shared;
    expect(shared?.importers).toEqual([LIKE, SUMMARY]);
    for (const file of [LIKE, SUMMARY]) {
      expect(chunkOf(bundle, file)?.imports).toEqual([shared?.url ?? '']);
      expect(chunkOf(bundle, file)?.bytes).toBeLessThan(1_000);
    }
  });

  test('an island rendered on a route of its own stays self-contained, byte for byte', async () => {
    const grouped = chunkOf(await buildIslands(ROOT), FEED);
    clearIslandChunkCache();
    const alone = chunkOf(await buildIslands(ROOT, { only: FEED }), FEED);

    expect(grouped?.imports).toEqual([]);
    expect(grouped?.bytes).toBeGreaterThan(PAYLOAD_BYTES);
    expect(grouped?.code).toBe(alone?.code ?? '');
  });

  test('a second route rendering one member alone ungroups both: no route pays more than alone', async () => {
    await write(
      'apps/web/app/likes/page.tsx',
      `island({ src: '../posts/[id]/like.island.tsx' });\n`,
    );
    const bundle = await buildIslands(ROOT);

    expect(bundle.shared).toEqual([]);
    for (const file of [LIKE, SUMMARY, FEED]) expect(chunkOf(bundle, file)?.imports).toEqual([]);
  });

  test('every URL is stable across builds of one tree', async () => {
    const urls = async (): Promise<readonly string[]> => {
      clearIslandChunkCache();
      const bundle = await buildIslands(ROOT);
      return [...bundle.chunks, ...bundle.shared].map((one) => one.url);
    };
    expect(await urls()).toEqual(await urls());
  });
});
