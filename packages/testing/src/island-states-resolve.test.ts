// A typo must never be a silent miss. These pin the loose half — four spellings of one island all
// resolve — and the strict half: nothing resolves to the wrong island, and an unresolved name
// reports every valid one, which is the difference between "you typed it wrong" and "nobody
// declared it" without opening a directory.

import { afterAll, describe, expect, test } from 'bun:test';
// why: no Bun native creates or removes a scratch directory; `Bun.file().exists()` needs one.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path'; // why: same as above — a path has to be joined before Bun reads it.
import { defineIslandStates } from './define-island-states';
import {
  assertIslandFiles,
  assertUniqueIslandStates,
  findIslandStates,
  islandStatesNames,
  missingIslandFiles,
  normalizeIslandName,
} from './island-states-resolve';
import { testName } from './test-types';

const SETTINGS = 'apps/web/app/settings/settings.island.tsx';
const CONTACT = 'apps/web/site/pricing/contact-sales.island.tsx';

const state = { id: 'read-only', title: 'read-only', props: {} };
const settings = defineIslandStates({ island: SETTINGS, states: [state] });
const contact = defineIslandStates({ island: CONTACT, states: [state] });
const all = [settings, contact];

const root = mkdtempSync(join(tmpdir(), 'ultimate-island-states-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = async (relative: string): Promise<void> => {
  mkdirSync(join(root, relative, '..'), { recursive: true });
  await Bun.write(join(root, relative), 'export function mount(){}\n');
};

describe(testName('unit', 'findIslandStates'), () => {
  test('resolves the same island from four spellings a reader might type', () => {
    for (const name of ['settings', 'Settings', 'settings.island.tsx', SETTINGS]) {
      expect(findIslandStates(all, name).island).toBe(SETTINGS);
    }
  });

  test('is separator-insensitive, so the JSX name and the filename are one name', () => {
    expect(findIslandStates(all, 'ContactSales').island).toBe(CONTACT);
    expect(findIslandStates(all, 'contact_sales').island).toBe(CONTACT);
    expect(normalizeIslandName('Contact-Sales.island.tsx')).toBe('contactsales');
  });

  test('an unresolved name lists EVERY valid one, so a typo is never a silent miss', () => {
    try {
      findIslandStates(all, 'setting');
      expect.unreachable('a name nothing answers to has no defensible fallback');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_ISLAND_STATES_UNKNOWN');
      const cause = (error as { cause: string }).cause;
      for (const name of islandStatesNames(all)) expect(cause).toContain(name);
    }
  });

  test('an empty set says so, rather than reporting a typo against nothing', () => {
    try {
      findIslandStates([], 'settings');
      expect.unreachable('an empty set is its own answer');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_ISLAND_STATES_UNKNOWN');
      expect((error as { fix: string }).fix).toContain('defineIslandStates');
    }
  });

  test('two islands sharing a basename are ambiguous, not first-wins', () => {
    const twin = defineIslandStates({
      island: 'apps/admin/app/settings/settings.island.tsx',
      states: [state],
    });
    expect(() => findIslandStates([settings, twin], 'settings')).toThrow(
      expect.objectContaining({ code: 'X_TEST_ISLAND_STATES_AMBIGUOUS' }),
    );
    expect(() => assertUniqueIslandStates([settings, twin])).toThrow(
      expect.objectContaining({ code: 'X_TEST_ISLAND_STATES_AMBIGUOUS' }),
    );
    expect(() => assertUniqueIslandStates(all)).not.toThrow();
  });
});

describe(testName('unit', 'missingIslandFiles'), () => {
  test('reports a declared island that is not on disk, and stays quiet when it is', async () => {
    await write(SETTINGS);
    expect(await missingIslandFiles([settings], root)).toEqual([]);
    expect(await missingIslandFiles(all, root)).toEqual([CONTACT]);
  });

  test('refuses the set, naming the island and the root it looked under', async () => {
    await write(SETTINGS);
    await expect(assertIslandFiles(all, root)).rejects.toBeUltimateError(
      'X_TEST_ISLAND_STATES_MISSING_FILE',
    );
    await expect(assertIslandFiles([settings], root)).resolves.toBeUndefined();
  });
});
