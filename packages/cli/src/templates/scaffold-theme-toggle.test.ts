// The scaffold's theme-toggle island, built from the EMITTED source with the real `buildIslands`
// and mounted. The emitted `theme-toggle.island.test.ts` runs only inside a generated app; this
// holds the same behaviour here, where a template change lands: the control starts from the theme
// the boot stamped, and follows the OS only while the app's `defaultMode` is `'system'`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MountedIsland } from '@ultimat3/testing';
import { mountIsland } from '@ultimat3/testing';
import { buildIslands } from '../island-bundle';
import type { FixtureApp } from './island-fixture';
import { fixtureAppRoot } from './island-fixture';
import { names } from './naming';
import { shellFiles } from './scaffold-shell';

const STORAGE_KEY = 'ultimate.theme';

const stored = new Map<string, string>();
const localStorage = {
  getItem: (key: string): string | null => stored.get(key) ?? null,
  setItem: (key: string, value: string): void => void stored.set(key, value),
  removeItem: (key: string): void => void stored.delete(key),
};
const os = { dark: false, listeners: new Set<() => void>() };
const matchMedia = (): Record<string, unknown> => ({
  get matches(): boolean {
    return os.dark;
  },
  addEventListener: (_type: string, listener: () => void) => void os.listeners.add(listener),
  removeEventListener: (_type: string, listener: () => void) => void os.listeners.delete(listener),
});
const flipOs = (dark: boolean): void => {
  os.dark = dark;
  for (const listener of os.listeners) listener();
};

const files = shellFiles(names('acme'), false);
const entry = files.find((file) => file.path.endsWith('theme-toggle.island.tsx'));

let app: FixtureApp | undefined;
let mounted: MountedIsland | undefined;

beforeAll(async () => {
  if (entry === undefined) expect.unreachable('the shell emits no theme-toggle island');
  app = await fixtureAppRoot('scaffold-theme-toggle', [entry]);
  mounted = await mountIsland({
    build: (root: string) => buildIslands(root, { only: entry.path }),
    root: app.path,
    file: entry.path,
    props: { locale: 'en' },
    shell: '<button type="button">theme</button>',
    globals: { localStorage, matchMedia },
  });
}, 60_000);

afterAll(() => {
  mounted?.[Symbol.dispose]();
  app?.[Symbol.dispose]();
});

const page = (): MountedIsland => mounted ?? expect.unreachable('the island never mounted');

describe("unit · the scaffold's theme toggle reads the boot, not a frozen copy of it", () => {
  test('with nothing stored, a click flips the theme the boot stamped — not the OS', () => {
    page().documentElement.setAttribute('data-theme-default', 'dark');
    page().documentElement.setAttribute('data-theme', 'dark');
    expect(page().fire('button', 'click')).toBe(true);
    expect(stored.get(STORAGE_KEY)).toBe('light');
    expect(page().documentElement.getAttribute('data-theme')).toBe('light');
  });

  test("an OS flip is followed while nothing is stored and the default is 'system'", () => {
    stored.clear();
    page().documentElement.setAttribute('data-theme-default', 'system');
    flipOs(true);
    expect(page().documentElement.getAttribute('data-theme')).toBe('dark');
    page().documentElement.setAttribute('data-theme-default', 'dark');
    flipOs(false);
    expect(page().documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
