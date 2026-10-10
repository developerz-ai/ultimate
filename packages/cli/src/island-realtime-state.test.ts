// Which realtime islands restore page state (held, #506) and which only follow the socket: read
// off the names each module of the island's graph takes from the barrel, and unknown means held.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove native; each case writes a throwaway tree.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { reachesRealtime } from './island-realtime';
import {
  FOLLOW_ONLY_EXPORTS,
  followOnlyIslandFiles,
  noteFollowOnly,
  realtimeBindings,
} from './island-realtime-state';

describe('realtimeBindings', () => {
  test('the value names of a named import, aliases and type names aside', () => {
    const source =
      "import type { ChannelState } from '@ultimat3/realtime';\n" +
      'import {\n  type ChannelRef,\n  useChannel as hold,\n  usePresence,\n} ' +
      "from '@ultimat3/realtime';\n" +
      'export const x = [hold, usePresence];\n';
    expect(realtimeBindings(source, 'a.ts')).toEqual(['useChannel', 'usePresence']);
  });

  test('a re-export names what it passes on', () => {
    const source = "export { useQuery as q } from '@ultimat3/realtime';\n";
    expect(realtimeBindings(source, 'a.ts')).toEqual(['useQuery']);
  });

  test('a module that takes nothing from the barrel by value answers the empty list', () => {
    expect(realtimeBindings("import type { Row } from '@ultimat3/realtime';\n", 'a.ts')).toEqual(
      [],
    );
    expect(realtimeBindings("import { render } from 'solid-js/web';\nrender;\n", 'a.tsx')).toEqual(
      [],
    );
    // A commented-out import and one inside a string are not imports.
    const quoted =
      "// import { useQuery } from '@ultimat3/realtime';\n" +
      'export const s = "import { useQuery } from \'@ultimat3/realtime\'";\n';
    expect(realtimeBindings(quoted, 'a.ts')).toEqual([]);
  });

  test.each([
    ["import * as rt from '@ultimat3/realtime';\nexport const x = rt;\n"],
    ["export * from '@ultimat3/realtime';\n"],
    ["import '@ultimat3/realtime';\n"],
    ["export const x = () => import('@ultimat3/realtime');\n"],
    [
      "import { useChannel } from '@ultimat3/realtime';\n" +
        "import * as rt from '@ultimat3/realtime';\nexport const x = [useChannel, rt];\n",
    ],
  ])('a form with no list of names is unknown: %s', (source) => {
    expect(realtimeBindings(source, 'a.tsx')).toBeUndefined();
  });
});

describe('noteFollowOnly', () => {
  let root = '';
  const at = (name: string): string => `apps/web/app/${name}`;
  const write = (name: string, source: string): Promise<void> =>
    writeFile(join(root, at(name)), source);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ultimate-island-state-'));
    await mkdir(join(root, 'apps/web/app'), { recursive: true });
    await write('follow.ts', "export { useChannel as hold } from '@ultimat3/realtime';\n");
    await write('feed.ts', "import { channelRef } from '@ultimat3/realtime';\nchannelRef;\n");
    await write(
      'events.island.tsx',
      "import { hold } from './follow';\nimport './feed';\nexport const mount = hold;\n",
    );
    await write(
      'rows.island.tsx',
      "import { hold } from './follow';\nimport { useQuery } from '@ultimat3/realtime';\n" +
        'export const mount = [hold, useQuery];\n',
    );
    await write('deep.ts', "import { useMutation } from '@ultimat3/realtime';\nuseMutation;\n");
    await write(
      'writer.island.tsx',
      "import { hold } from './follow';\nimport './deep';\nexport const mount = hold;\n",
    );
    await write(
      'star.island.tsx',
      "import * as rt from '@ultimat3/realtime';\nexport const mount = rt.useChannel;\n",
    );
    await write('plain.island.tsx', 'export const mount = 1;\n');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('an island whose graph only follows a channel restores nothing', async () => {
    expect(await noteFollowOnly(root, at('events.island.tsx'), true)).toBe(true);
    expect(followOnlyIslandFiles().has(at('events.island.tsx'))).toBe(true);
  });

  test('one store or outbox hook anywhere in the graph, and it restores', async () => {
    expect(await noteFollowOnly(root, at('rows.island.tsx'), true)).toBe(false);
    expect(await noteFollowOnly(root, at('writer.island.tsx'), true)).toBe(false);
    expect(followOnlyIslandFiles().has(at('rows.island.tsx'))).toBe(false);
  });

  test('a namespace import cannot be read, so the island is held as it always was', async () => {
    expect(await noteFollowOnly(root, at('star.island.tsx'), true)).toBe(false);
  });

  test('reachesRealtime asks it, and an edit that adds a read drops the island from the set', async () => {
    expect(await reachesRealtime(root, at('events.island.tsx'))).toBe(true);
    expect(await reachesRealtime(root, at('plain.island.tsx'))).toBe(false);
    expect(followOnlyIslandFiles().has(at('events.island.tsx'))).toBe(true);
    expect(followOnlyIslandFiles().has(at('plain.island.tsx'))).toBe(false);

    await write('feed.ts', "import { useRecord } from '@ultimat3/realtime';\nuseRecord;\n");
    expect(await reachesRealtime(root, at('events.island.tsx'))).toBe(true);
    expect(followOnlyIslandFiles().has(at('events.island.tsx'))).toBe(false);
  });

  test('every name on the list is one the client barrel exports', async () => {
    const barrel: Record<string, unknown> = await import('@ultimat3/realtime');
    for (const name of FOLLOW_ONLY_EXPORTS) expect(barrel[name]).toBeTypeOf('function');
  });
});
