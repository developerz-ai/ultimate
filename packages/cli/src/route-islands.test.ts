// Which islands a render holds off screen (#506): a realtime island with page state to restore, on
// a document that carries the page boot — and nothing else, so a shareable page, a read-nothing
// island and an island that only follows a channel's events are never hidden.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove native; each case writes a throwaway tree.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { RouteEntry } from '@ultimat3/render';
import { emitIslandAttributes } from '@ultimat3/render';
import type { DocumentOptions } from './document-options';
import { realtimeKind } from './island-realtime';
import type { IslandRealtime } from './island-realtime-state';
import { collectorFor } from './route-islands';

const PAGE = 'apps/web/app/posts/page.tsx';
const LIVE = 'apps/web/app/posts/live.island.tsx';
const STILL = 'apps/web/app/posts/still.island.tsx';
const EVENTS = 'apps/web/app/posts/events.island.tsx';
/** What the served bundle hands the renderer (`IslandBundle.realtime`): this app's answers. */
const kinds = new Map<string, IslandRealtime>();
const SYNC: DocumentOptions = {
  sync: { syncUrl: 'ws://localhost/_x/sync', buildId: 'b1' },
  realtimeIslands: () => kinds,
};

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-route-islands-'));
  await mkdir(join(root, 'apps/web/app/posts'), { recursive: true });
  await writeFile(
    join(root, LIVE),
    "import { useRecord } from '@ultimat3/realtime';\nuseRecord;\n",
  );
  await writeFile(join(root, STILL), 'export const still = 1;\n');
  // The consumer's shape: the server's list adopted as it is, re-read when the channel says so.
  await writeFile(
    join(root, EVENTS),
    "import { useChannel } from '@ultimat3/realtime';\nuseChannel;\n",
  );
  // The build asks this of every island; the answer rides its chunk to the collector.
  for (const file of [LIVE, STILL, EVENTS]) {
    const kind = await realtimeKind(root, file);
    if (kind !== undefined) kinds.set(file, kind);
  }
  expect([...kinds]).toEqual([
    [LIVE, 'restores'],
    [EVENTS, 'follows'],
  ]);
});

afterAll(async () => {
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
  islands.record(spec('events'), {});
  return islands.directives.map((d) => d.hold === true);
};

describe('collectorFor holds', () => {
  test('a realtime island with state to restore, on a scoped document with a sync node', () => {
    expect(held(SYNC, 'principal-1')).toEqual([true, false, false]);
  });

  test('an island that only follows a channel is realtime and is never hidden', () => {
    const islands = collectorFor(entry, SYNC, 'principal-1');
    const directive = islands.record(spec('events'), {});
    expect(directive.hold).not.toBe(true);
    expect(emitIslandAttributes(directive)).not.toContain('visibility:hidden');
    expect(emitIslandAttributes(islands.record(spec('live'), {}))).toContain('visibility:hidden');
  });

  test('nothing on a shareable document — it carries no boot to wait for', () => {
    expect(held(SYNC, undefined)).toEqual([false, false, false]);
  });

  test('nothing in an app with no sync node', () => {
    expect(held({ realtimeIslands: () => kinds }, 'principal-1')).toEqual([false, false, false]);
  });

  test("nothing when the bundle names no realtime island — another app's answer is not this one's", () => {
    const none: DocumentOptions = { ...SYNC, realtimeIslands: () => new Map() };
    expect(held(none, 'principal-1')).toEqual([false, false, false]);
  });
});
