// Which islands a render holds off screen (#506): a realtime island, on a document that carries
// the page boot — and nothing else, so a shareable page or a read-nothing island pays nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove native; each case writes a throwaway tree.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { RouteEntry } from '@ultimat3/render';
import type { DocumentOptions } from './document-options';
import { reachesRealtime } from './island-realtime';
import { collectorFor } from './route-islands';

const PAGE = 'apps/web/app/posts/page.tsx';
const LIVE = 'apps/web/app/posts/live.island.tsx';
const STILL = 'apps/web/app/posts/still.island.tsx';
const SYNC: DocumentOptions = { sync: { syncUrl: 'ws://localhost/_x/sync', buildId: 'b1' } };

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-route-islands-'));
  await mkdir(join(root, 'apps/web/app/posts'), { recursive: true });
  await writeFile(
    join(root, LIVE),
    "import { useRecord } from '@ultimat3/realtime';\nuseRecord;\n",
  );
  await writeFile(join(root, STILL), 'export const still = 1;\n');
  // The build asks this of every island; the answer is what the collector reads.
  expect(await reachesRealtime(root, LIVE)).toBe(true);
  expect(await reachesRealtime(root, STILL)).toBe(false);
});

afterAll(async () => {
  // The answer is module state: a file gone from the graph is dropped from it on the next ask.
  await rm(join(root, LIVE));
  expect(await reachesRealtime(root, LIVE)).toBe(false);
  await rm(root, { recursive: true, force: true });
});

const entry = { file: PAGE, config: { hydrate: 'idle' } } as unknown as RouteEntry;
const spec = (name: string) => ({
  moduleId: name,
  src: `./${name}.island.tsx`,
  propKeys: [],
  tag: 'div' as const,
});

const held = (options: DocumentOptions, scope: string | undefined): readonly boolean[] => {
  const islands = collectorFor(entry, options, scope);
  islands.record(spec('live'), {});
  islands.record(spec('still'), {});
  return islands.directives.map((d) => d.hold === true);
};

describe('collectorFor holds', () => {
  test('a realtime island on a scoped document with a sync node, and only it', () => {
    expect(held(SYNC, 'principal-1')).toEqual([true, false]);
  });

  test('nothing on a shareable document — it carries no boot to wait for', () => {
    expect(held(SYNC, undefined)).toEqual([false, false]);
  });

  test('nothing in an app with no sync node', () => {
    expect(held({}, 'principal-1')).toEqual([false, false]);
  });
});
