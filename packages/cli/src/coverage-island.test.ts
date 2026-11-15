import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { parseChunkMap, readChunkMaps, withIslandChunks } from './coverage-island';
import { parseLcov } from './coverage-lcov';

const MAP = JSON.stringify({
  version: 3,
  sources: ['apps/web/app/a.island.ts'],
  sourcesContent: ['export const a = 1;\n'],
  mappings: ';AAAO',
});
const SIDECAR = JSON.stringify({ module: 'h.mjs', cwd: '/app', map: MAP });

describe('parseChunkMap', () => {
  test('a recorded map resolves its sources against the cwd that built it', () => {
    expect(parseChunkMap(SIDECAR)).toEqual({
      module: 'h.mjs',
      sources: ['/app/apps/web/app/a.island.ts'],
      sourcesContent: ['export const a = 1;\n'],
      mappings: ';AAAO',
    });
  });

  test.each([
    ['not JSON', '{'],
    ['a map that is not JSON', JSON.stringify({ module: 'h.mjs', cwd: '/app', map: '{' })],
    ['no module', JSON.stringify({ cwd: '/app', map: MAP })],
    ['no mappings', JSON.stringify({ module: 'h.mjs', cwd: '/app', map: '{"sources":[]}' })],
  ])('%s is no map, so the chunk credits nothing', (_, text) => {
    expect(parseChunkMap(text)).toBeUndefined();
  });
});

describe('withIslandChunks', () => {
  test('a chunk record with a recorded map lands on the app source, read off disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-coverage-island-'));
    try {
      await Bun.write(join(root, 'apps/web/app/a.island.ts'), 'export const a = 1;\n');
      await Bun.write(
        join(root, 'part', 'islands', 'h.mjs.json'),
        JSON.stringify({ module: 'h.mjs', cwd: root, map: MAP }),
      );
      const maps = await readChunkMaps(join(root, 'part'));
      expect([...maps.keys()]).toEqual(['h.mjs']);
      const records = parseLcov('SF:../../tmp/s/h.mjs\nDA:2,1\nend_of_record\n');
      const part = await withIslandChunks(root, {}, [{ records, maps }]);
      expect(part['apps/web/app/a.island.ts']?.hit).toEqual([1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a slice that recorded no map reads as no maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-coverage-no-maps-'));
    try {
      expect((await readChunkMaps(join(root, 'part'))).size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
