// A coverage build of an island: lines a map can name, the map on the chunk, Babel's lines kept —
// and none of it reaching the shipped build or the group cache it is reused from.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-exists probe and no way to set an mtime.
import { existsSync, utimesSync } from 'node:fs';
// why: Bun ships no recursive delete.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API.
import { join } from 'node:path';
import { buildIslands } from './island-bundle';
import { ISLAND_CACHE_DIR } from './island-group-cache';
import { processRoot } from './process-root-fixture';
import { transformIslandTsx } from './solid-loader';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'coverage'));
const ISLAND = 'apps/web/app/badge.island.tsx';
const SOURCE = [
  "import { render } from 'solid-js/web';",
  '',
  'function Badge(props: { n: number }) {',
  "  const label = 'n=' + String(props.n);",
  '  return <b class="badge">{label}</b>;',
  '}',
  '',
  'export function mount(el: HTMLElement, props: { n: number }) {',
  '  return render(() => <Badge n={props.n} />, el);',
  '}',
  '',
].join('\n');

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'island-coverage' }));
  await Bun.write(join(ROOT, ISLAND), SOURCE);
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('buildIslands({ coverage: true })', () => {
  test('the chunk keeps its lines and carries the map that names the island', async () => {
    const shipped = (await buildIslands(ROOT, { only: ISLAND, reuse: false })).chunks[0];
    const covered = (await buildIslands(ROOT, { only: ISLAND, coverage: true })).chunks[0];
    if (shipped === undefined || covered === undefined) expect.unreachable('one chunk each');
    expect(shipped.map).toBeUndefined();
    const map: unknown = JSON.parse(covered.map ?? '{}');
    expect((map as { sources?: string[] }).sources?.some((one) => one.endsWith(ISLAND))).toBe(true);
    expect(covered.code.split('\n').length).toBeGreaterThan(shipped.code.split('\n').length + 5);
    // Identifiers are still mangled: only the whitespace is the coverage build's own.
    expect(covered.code).not.toContain('function Badge');
  });

  test('a coverage build is never written to the group cache, nor read from it', async () => {
    // Older than the build, or `writeGroup` reads the fixture as edited mid-build and stores nothing.
    const past = new Date(Date.UTC(2020, 0, 1));
    for (const path of [ISLAND, 'apps/web/app', 'apps/web', 'apps', '.']) {
      utimesSync(join(ROOT, path), past, past);
    }
    await buildIslands(ROOT, { only: ISLAND, coverage: true });
    expect(existsSync(join(ROOT, ISLAND_CACHE_DIR))).toBe(false);
    const shipped = (await buildIslands(ROOT, { only: ISLAND })).chunks[0];
    // The shipped build IS stored — the control that makes the first assertion mean something.
    expect(existsSync(join(ROOT, ISLAND_CACHE_DIR))).toBe(true);
    const covered = (await buildIslands(ROOT, { only: ISLAND, coverage: true })).chunks[0];
    expect(covered?.map).toBeDefined();
    expect(covered?.code).not.toBe(shipped?.code);
  });
});

describe('transformIslandTsx, retainLines', () => {
  test('a coverage transform keeps every source line where it was, the shipped one need not', async () => {
    const path = join(ROOT, ISLAND);
    const kept = (await transformIslandTsx(SOURCE, path, { retainLines: true })).split('\n');
    const at = (lines: readonly string[]): number =>
      lines.findIndex((line) => line.includes('const label'));
    expect(at(kept)).toBe(3);
    // Keyed by the flag too: the shipped transform after a coverage one is the shipped output.
    const shipped = await transformIslandTsx(SOURCE, path);
    expect(shipped).not.toBe(kept.join('\n'));
    expect(await transformIslandTsx(SOURCE, path, { retainLines: true })).toBe(kept.join('\n'));
  });
});
