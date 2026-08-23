// The guard: a real `*.island.states.ts` on disk, loaded the way the command that photographs the
// states will load it, and held to parity in BOTH directions — every declared state expands to
// pictures, every picture maps back to a declared state, and the island the manifest names exists.
// Plus the constraint the whole design rests on: that file's module graph reaches no browser.

import { afterAll, describe, expect, test } from 'bun:test';
// why: no Bun native creates or removes a directory tree; this test needs a real one on disk.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path'; // why: same — Bun.write and import() both take a joined path.
import { islandShotTargets } from './island-shot-targets';
import { islandStatesFile } from './island-state-errors';
import type { IslandStatesManifest } from './island-states';
import { isIslandStatesManifest } from './island-states';
import { assertIslandStatesPure, islandStatesImportFault } from './island-states-pure';
import { assertIslandFiles } from './island-states-resolve';
import { testName } from './test-types';

const ISLAND = 'apps/web/app/settings/settings.island.tsx';
const BARREL = join(import.meta.dir, 'index.ts');

/**
 * Written by hand rather than generated: this is the file an app author writes, and the test is
 * worth nothing if the thing under it is a shape only the test knows how to produce. It imports the
 * package barrel by path because the scratch tree has no `node_modules` — which also proves the
 * vocabulary is reachable from `src/index.ts`, where the public API is declared.
 */
const STATES_SOURCE = `
import { defineIslandStates } from ${JSON.stringify(BARREL)};

export const settingsStates = defineIslandStates({
  island: '${ISLAND}',
  target: '[data-settings]',
  states: [
    {
      id: 'read-only',
      title: 'the account is read-only',
      note: 'you cannot reach this by clicking: the flag is set by billing, not by the UI',
      props: { readOnly: true, plan: 'team' },
      routes: [{ match: 'GET /api/settings', respond: { kind: 'json', body: { readOnly: true } } }],
    },
    {
      id: 'over-quota',
      title: 'the workspace is over quota',
      props: { quota: { used: 120, limit: 100 } },
      themes: ['dark'],
    },
  ],
});
`;

const root = mkdtempSync(join(tmpdir(), 'ultimate-island-states-guard-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = async (relative: string, source: string): Promise<string> => {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, source);
  return path;
};

const load = async (path: string): Promise<readonly IslandStatesManifest[]> => {
  const module: unknown = await import(path);
  return Object.values(module as Record<string, unknown>).filter(isIslandStatesManifest);
};

describe(testName('unit', 'island states parity'), () => {
  test('a states file on disk loads to exactly the manifests it declares', async () => {
    await write(ISLAND, 'export function mount(): void {}\n');
    const manifests = await load(await write(islandStatesFile(ISLAND), STATES_SOURCE));
    expect(manifests.length).toBe(1);
    expect(manifests[0]?.island).toBe(ISLAND);
    expect(manifests[0]?.states.map((state) => state.id)).toEqual(['read-only', 'over-quota']);
  });

  test('every state it declares carries the fields it claims', async () => {
    const [manifest] = await load(await write(islandStatesFile(ISLAND), STATES_SOURCE));
    for (const state of manifest?.states ?? []) {
      expect(typeof state.title).toBe('string');
      expect(state.title.length).toBeGreaterThan(0);
      expect(Object.isFrozen(state.props)).toBe(true);
      expect(state.themes.length).toBeGreaterThan(0);
      expect(state.viewport.width).toBeGreaterThan(0);
    }
    expect(manifest?.timeZone).toBe('UTC');
  });

  test('declared → picture → declared: no state without a picture, no picture without a state', async () => {
    const [manifest] = await load(await write(islandStatesFile(ISLAND), STATES_SOURCE));
    if (manifest === undefined) expect.unreachable('the states file declared no manifest');
    const targets = islandShotTargets(manifest);
    // Forwards: every declared state appears, once per theme it asked for.
    for (const state of manifest.states) {
      expect(targets.filter((shot) => shot.state === state.id).map((shot) => shot.theme)).toEqual([
        ...state.themes,
      ]);
    }
    // Backwards: no picture belongs to a state nobody declared, and no two share a path.
    const declared = new Set(manifest.states.map((state) => state.id));
    for (const shot of targets) expect(declared.has(shot.state)).toBe(true);
    expect(new Set(targets.map((shot) => shot.file)).size).toBe(targets.length);
  });

  test('the island it names is on disk, and a manifest naming a moved file is refused', async () => {
    const [manifest] = await load(await write(islandStatesFile(ISLAND), STATES_SOURCE));
    const all = manifest === undefined ? [] : [manifest];
    await expect(assertIslandFiles(all, root)).resolves.toBeUndefined();
    await expect(assertIslandFiles(all, join(root, 'elsewhere'))).rejects.toBeUltimateError(
      'X_TEST_ISLAND_STATES_MISSING_FILE',
    );
  });
});

describe(testName('unit', 'island states purity'), () => {
  test('the states file this test wrote reaches no browser and no bundle', () => {
    expect(islandStatesImportFault(STATES_SOURCE)).toBeUndefined();
    expect(() => assertIslandStatesPure(islandStatesFile(ISLAND), STATES_SOURCE)).not.toThrow();
  });

  test('it evaluated with no DOM in the process — which is the whole claim', async () => {
    expect(typeof globalThis.document).toBe('undefined');
    const manifests = await load(await write(islandStatesFile(ISLAND), STATES_SOURCE));
    expect(manifests.length).toBe(1);
  });

  test('a states file importing its own component is refused, naming the import', () => {
    const impure = `import { Settings } from './settings.island.tsx';\n${STATES_SOURCE}`;
    try {
      assertIslandStatesPure(islandStatesFile(ISLAND), impure);
      expect.unreachable('a states file that imports JSX is readable only by a bundler');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_ISLAND_STATES_NOT_PURE');
      expect((error as { cause: string }).cause).toContain('./settings.island.tsx');
    }
  });

  test('every spelling of an import is read, and a mention in a comment is not', () => {
    expect(islandStatesImportFault("const m = await import('./x.island.tsx');")).toBe(
      './x.island.tsx',
    );
    expect(islandStatesImportFault("require('solid-js/web');")).toBe('solid-js/web');
    expect(islandStatesImportFault("export { Settings } from './settings.island.tsx';")).toBe(
      './settings.island.tsx',
    );
    expect(
      islandStatesImportFault("// never import './settings.island.tsx' here\n"),
    ).toBeUndefined();
    expect(islandStatesImportFault("import { t } from '@ultimat3/i18n';")).toBeUndefined();
  });
});
