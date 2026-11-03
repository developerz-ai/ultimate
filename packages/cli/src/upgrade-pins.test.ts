// Which manifests a hop moves, and that the set read is the set written: `overrides` included, every
// other byte of the file left alone.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { readManifests, readPins, rewritePins } from './upgrade-pins';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tree = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'x-upgrade-pins-'));
  dirs.push(dir);
  await Promise.all(Object.entries(files).map(([path, text]) => Bun.write(join(dir, path), text)));
  return dir;
};

describe('unit · readManifests', () => {
  test('the root and every workspace, never node_modules, a negation honoured', async () => {
    const dir = await tree({
      'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*', '!packages/skip'] }),
      'apps/web/package.json': '{}',
      'packages/db/package.json': '{}',
      'packages/skip/package.json': '{}',
      'packages/db/node_modules/x/package.json': '{}',
      'other/package.json': '{}',
    });
    const manifests = await readManifests(dir);
    expect(manifests.map((manifest) => manifest.file)).toEqual([
      'package.json',
      'apps/web/package.json',
      'packages/db/package.json',
    ]);
  });

  test('a root that is not JSON refuses by code, naming the file', async () => {
    const dir = await tree({ 'package.json': '{ nope' });
    expect(readManifests(dir)).rejects.toThrow('X_UPGRADE_PIN_UNREADABLE');
  });
});

describe('unit · pins', () => {
  const source = `{
  "name": "@ultimat3/not-a-pin",
  "dependencies": { "@ultimat3/core": "^19.4.0", "sass": "^1.0.0" },
  "devDependencies": {
    "@ultimat3/cli":    "19.4.0"
  },
  "overrides": { "@ultimat3/schema": "~19.4.0" }
}
`;

  test('every dependency field and overrides are read; the name field is not', () => {
    expect(readPins([{ file: 'package.json', text: source }])).toEqual([
      { file: 'package.json', name: '@ultimat3/core', spec: '^19.4.0' },
      { file: 'package.json', name: '@ultimat3/cli', spec: '19.4.0' },
      { file: 'package.json', name: '@ultimat3/schema', spec: '~19.4.0' },
    ]);
  });

  test('all go exact, and every other byte stays', () => {
    expect(rewritePins(source, '20.1.0')).toBe(`{
  "name": "@ultimat3/not-a-pin",
  "dependencies": { "@ultimat3/core": "20.1.0", "sass": "^1.0.0" },
  "devDependencies": {
    "@ultimat3/cli":    "20.1.0"
  },
  "overrides": { "@ultimat3/schema": "20.1.0" }
}
`);
  });

  test('a second run changes nothing', () => {
    const once = rewritePins(source, '20.1.0');
    expect(rewritePins(once, '20.1.0')).toBe(once);
  });

  test('a spec naming no version is never overwritten', () => {
    const text = '{ "dependencies": { "@ultimat3/core": "workspace:*" } }';
    expect(rewritePins(text, '20.1.0')).toBe(text);
  });
});
