import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { IslandBuilder } from './fixture-island';
import { mountIsland } from './fixture-island';
import { ISLAND_COVERAGE_ENV, islandCoverageDir } from './fixture-island-coverage';

/** The coverage build keeps whitespace for its map; the shipped one is minified. */
const CODE = 'export function mount(el) {\n  el.textContent = "on";\n}\n';
const SHIPPED = 'export function mount(e){e.textContent="on"}';
const asked: unknown[] = [];
const build: IslandBuilder = async (_root, options) => {
  asked.push(options);
  const code = options?.coverage === true ? CODE : SHIPPED;
  return {
    chunks: [{ file: 'apps/web/x.island.tsx', code, map: '{"mappings":";AAAA"}' }],
    shared: [{ url: '/islands/chunk-1.js', code: 'export const s = 1;\n', map: '{"m":1}' }],
  };
};

afterEach(() => {
  asked.length = 0;
  delete process.env[ISLAND_COVERAGE_ENV];
});

describe('mountIsland under a coverage run', () => {
  test('each chunk map is recorded under the name it was imported by', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-island-maps-'));
    try {
      process.env[ISLAND_COVERAGE_ENV] = dir;
      const mounted = await mountIsland({ build, root: '/app', file: 'apps/web/x.island.tsx' });
      mounted[Symbol.dispose]();
      expect(asked).toEqual([
        { only: 'apps/web/x.island.tsx', coverage: true },
        { only: 'apps/web/x.island.tsx' },
      ]);
      const names = (await readdir(dir)).sort();
      const module = `${Bun.SHA256.hash(CODE, 'hex').slice(0, 16)}.mjs`;
      expect(names).toEqual([`${module}.json`, 'chunk-1.js.json'].sort());
      expect(await Bun.file(join(dir, `${module}.json`)).json()).toEqual({
        module,
        cwd: process.cwd(),
        map: '{"mappings":";AAAA"}',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // An app's size ceiling (`mounted.code.length`) weighs what ships: the unminified coverage
  // build answered it from 31.27 to 31.40, red under `x verify` and green under `bun test`.
  test('code is still the SHIPPED chunk — the covered build only runs and maps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-island-maps-'));
    try {
      process.env[ISLAND_COVERAGE_ENV] = dir;
      const mounted = await mountIsland({ build, root: '/app', file: 'apps/web/x.island.tsx' });
      mounted[Symbol.dispose]();
      expect(mounted.code).toBe(SHIPPED);
      expect(mounted.el.textContent).toBe('on');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('outside one, the builder is asked for the shipped build and nothing is recorded', async () => {
    const mounted = await mountIsland({ build, root: '/app', file: 'apps/web/x.island.tsx' });
    mounted[Symbol.dispose]();
    expect(asked).toEqual([{ only: 'apps/web/x.island.tsx' }]);
    expect(islandCoverageDir()).toBeUndefined();
    expect(islandCoverageDir({ [ISLAND_COVERAGE_ENV]: '' })).toBeUndefined();
  });
});
