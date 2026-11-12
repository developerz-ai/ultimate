// The browser cuts over an app on disk: what the installed browser entry exports, one finding per
// edit however many sites it clears, and the cut as `x fix boundary` reports it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  browserCutJson,
  involvesTarget,
  mergeBarrelFindings,
  publishedEntries,
  publishedNames,
} from './browser-barrel-cut';
import type { ServerBarrel } from './browser-transport';
import { barrelFinding } from './browser-transport';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.browser-barrel-cut-fixture'));
const PKG = 'node_modules/@ultimat3/entity';
const RECORD = '@ultimat3/entity/record';

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, PKG, 'package.json'),
    JSON.stringify({
      exports: { '.': './src/index.ts', './record': { import: './src/record.ts' } },
    }),
  );
  await Bun.write(join(ROOT, PKG, 'src/record.ts'), "export { recordKey } from './k';\n");
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const CONTEXT = { holder: () => undefined, rerun: 'x verify --only boundaries' };
const ISLAND = 'apps/web/app/p/f.island.tsx';

const site = (file: string, swaps: boolean): ServerBarrel => ({
  file,
  line: 4,
  barrel: '@ultimat3/entity',
  entry: RECORD,
  chain: [ISLAND, 'apps/web/app/p/repo.ts', file],
  hop: { spec: './repo', line: 7 },
  names: ['entity'],
  swaps,
});

describe('publishedNames', () => {
  test('reads the subpath the manifest maps, object rows included', async () => {
    expect(await publishedNames(ROOT, RECORD)).toEqual(new Set(['recordKey']));
    expect(await publishedEntries(ROOT, [RECORD, RECORD, '@ultimat3/none/record'])).toEqual(
      new Map([[RECORD, new Set(['recordKey'])]]),
    );
  });

  test('an unmapped subpath, a missing package or a bare name is unknown', async () => {
    expect(await publishedNames(ROOT, '@ultimat3/entity/client')).toBeUndefined();
    expect(await publishedNames(ROOT, '@ultimat3/none/record')).toBeUndefined();
    expect(await publishedNames(ROOT, 'entity')).toBeUndefined();
  });
});

describe('mergeBarrelFindings', () => {
  test('two server-only sites behind one hop are one cut at the island', () => {
    const found = mergeBarrelFindings([
      barrelFinding(site('apps/web/app/p/entity.ts', false), CONTEXT),
      barrelFinding(site('packages/db/src/client.ts', false), CONTEXT),
    ]);
    expect(found.map((one) => one.at)).toEqual([`${ISLAND}:7`]);
    expect(found[0]?.meta?.['sites']).toEqual([
      'apps/web/app/p/entity.ts:4',
      'packages/db/src/client.ts:4',
    ]);
    expect(found[0]?.cause).toContain('also reaches packages/db/src/client.ts:4');
    const [cut] = found;
    expect(involvesTarget(cut ?? expect.unreachable('none'), 'apps/web/app/p/repo.ts')).toBe(true);
    expect(browserCutJson(cut ?? expect.unreachable('none'))).toMatchObject({
      entry: ISLAND,
      edge: { from: ISLAND, to: 'apps/web/app/p/repo.ts' },
    });
  });

  test('a swap stays where it stands, and its edge is the barrel import', () => {
    const [found] = mergeBarrelFindings([
      barrelFinding(site('apps/web/app/p/fmt.ts', true), CONTEXT),
    ]);
    expect(found?.at).toBe('apps/web/app/p/fmt.ts:4');
    expect(browserCutJson(found ?? expect.unreachable('none'))).toMatchObject({
      edge: { from: 'apps/web/app/p/fmt.ts', to: '@ultimat3/entity' },
    });
  });

  test('any other finding passes through untouched', () => {
    const other = { code: 'X_BROWSER_TRANSPORT_BYPASS', cause: 'c', fix: 'f' };
    expect(mergeBarrelFindings([other])).toEqual([other]);
  });
});
