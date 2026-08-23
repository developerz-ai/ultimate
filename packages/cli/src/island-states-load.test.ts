// Loading an app's states files, over a real directory tree. The rule with teeth is the ORDER:
// the purity check reads the file's text and runs BEFORE the import, because a states file that
// imports Solid evaluates perfectly well under Bun — so by the time loading could notice, the
// module graph that needs a browser is already in this process.

import { afterEach, describe, expect, test } from 'bun:test';
// why: no Bun native creates or removes a directory tree; this test needs a real one on disk.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverIslandStates,
  ISLAND_STATES_GLOB,
  ISLAND_STATES_SUFFIX,
  loadIslandStates,
} from './island-states-load';

const BARREL = join(import.meta.dir, '../../testing/src/index.ts');
const AT = 'apps/web/app/settings';
const ISLAND = `${AT}/settings.island.tsx`;

const roots: string[] = [];

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-island-states-'));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const statesSource = (extra = ''): string => `
${extra}
import { defineIslandStates } from ${JSON.stringify(BARREL)};

export const settingsStates = defineIslandStates({
  island: '${ISLAND}',
  states: [{ id: 'empty', title: 'nothing came back', props: {} }],
});
`;

/** The island file itself, which `assertIslandFiles` requires to be on disk. */
const writeIsland = async (root: string): Promise<void> => {
  await Bun.write(join(root, ISLAND), 'export function mount(){}\n');
};

describe('unit · discovery finds a states file exactly where its island is', () => {
  test('the suffix and the glob are derived, never a third spelling', () => {
    expect(ISLAND_STATES_SUFFIX).toBe('.island.states.ts');
    expect(ISLAND_STATES_GLOB).toContain('.island.states.ts');
    // Derived from `ISLAND_GLOB`, so a states file is looked for on the same three surfaces an
    // island can live on and nowhere else.
    expect(ISLAND_STATES_GLOB).toContain('{site,app,shared}');
  });

  test('a states file beside an island is found; one in node_modules is not', async () => {
    const root = scratch();
    await writeIsland(root);
    await Bun.write(join(root, `${AT}/settings.island.states.ts`), statesSource());
    await Bun.write(join(root, 'node_modules/x/apps/web/app/a/a.island.states.ts'), statesSource());

    expect(await discoverIslandStates(root)).toEqual([`${AT}/settings.island.states.ts`]);
  });
});

describe('unit · a states file is proved pure before it is imported', () => {
  /**
   * The whole design rests on this file being readable with no browser and no bundle: the command
   * must know the complete expected picture list BEFORE a browser exists, or "produced nothing and
   * exited 0" is indistinguishable from success. One JSX import ends that.
   */
  test('an import of the component is refused, and the file is never loaded', async () => {
    const root = scratch();
    await writeIsland(root);
    await Bun.write(
      join(root, `${AT}/settings.island.states.ts`),
      statesSource("import './settings.island.tsx';"),
    );

    const thrown = await loadIslandStates(root).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: 'X_TEST_ISLAND_STATES_NOT_PURE' });
  });

  test('a solid-js import is the same mistake one import earlier', async () => {
    const root = scratch();
    await writeIsland(root);
    await Bun.write(
      join(root, `${AT}/settings.island.states.ts`),
      statesSource("import { createSignal } from 'solid-js';"),
    );

    const thrown = await loadIslandStates(root).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: 'X_TEST_ISLAND_STATES_NOT_PURE' });
  });
});

describe('unit · a file that declares no picture is refused', () => {
  // The same silence one level up from `X_TEST_ISLAND_STATES_EMPTY`: a file named for states that
  // exports none expands to nothing, so a run over it photographs nothing and reports success.
  test('a states file that exports no manifest names itself', async () => {
    const root = scratch();
    await writeIsland(root);
    await Bun.write(
      join(root, `${AT}/settings.island.states.ts`),
      `import { defineIslandStates } from ${JSON.stringify(BARREL)};\nconst unused = defineIslandStates({ island: '${ISLAND}', states: [{ id: 'a', title: 'a', props: {} }] });\nvoid unused;\n`,
    );

    const thrown = await loadIslandStates(root).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: 'X_SHOT_ISLAND_STATES_EMPTY' });
    expect((thrown as { fix: string }).fix).toContain('export const states = defineIslandStates');
  });
});

describe('unit · the set is checked as a set', () => {
  test('a manifest naming an island that is not on disk is refused', async () => {
    const root = scratch();
    await Bun.write(join(root, `${AT}/settings.island.states.ts`), statesSource());

    const thrown = await loadIslandStates(root).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: 'X_TEST_ISLAND_STATES_MISSING_FILE' });
  });

  test('a whole tree with one honest states file loads to one manifest', async () => {
    const root = scratch();
    await writeIsland(root);
    await Bun.write(join(root, `${AT}/settings.island.states.ts`), statesSource());

    const all = await loadIslandStates(root);
    expect(all.map((manifest) => manifest.name)).toEqual(['settings']);
    expect(all[0]?.states.map((one) => one.id)).toEqual(['empty']);
  });
});
