// The toggle the browser actually runs: built with the same `buildIslands` as `x build`, mounted
// against a DOM small enough to read, and clicked. What it pins: the boot's verdict on `<html>` is
// what the control starts from, and a click writes the key the boot script reads back next load.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import { THEME_STORAGE_KEY } from '@ultimat3/core';
import { describeIslandState, expect, test } from '@ultimat3/testing';
import { THEME_ATTRIBUTE, THEME_DEFAULT_ATTRIBUTE } from '@ultimat3/ui';
import { themeToggleStates } from './theme-toggle.island.states';

/** What the island reads through `browserThemeEnv`: storage and the OS query, both fakes. */
const stored = new Map<string, string>();
const localStorage = {
  getItem: (key: string): string | null => stored.get(key) ?? null,
  setItem: (key: string, value: string): void => void stored.set(key, value),
  removeItem: (key: string): void => void stored.delete(key),
};
/** One OS query, shared by every `matchMedia` call: `flipOs` changes it and tells the listeners. */
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

// The state `x shot --island theme-toggle` photographs is the state this mounts: one manifest,
// so the picture and the assertion cannot be of two different components.
const island = {
  build: buildIslands,
  root: join(import.meta.dir, '..', '..', '..'),
  shell: '<button type="button">theme</button>',
  globals: { localStorage, matchMedia },
};

describeIslandState(themeToggleStates, 'default', island, (mounted) => {
  test('the default state renders the catalog control over the server shell', () => {
    // `aria-pressed` is the live control's: the shell's own button carries none, so a mount that
    // rendered nothing leaves this selector with no match.
    expect(mounted().find('button[aria-pressed]')).not.toBeNull();
    expect(mounted().code).not.toMatch(/\bReact\b/);
    // The state's own prop reached the island: the provider stamps the locale it was handed.
    expect(mounted().documentElement.getAttribute('lang')).toBe('en');
  });

  test('a click stores the opposite theme and applies it to <html>', () => {
    // No stamp on this document, so the island booted light; the click flips it. `false` means
    // no handler ran — an onClick that never reached the DOM looks identical to a selector typo.
    expect(mounted().fire('button', 'click')).toBe(true);
    expect(stored.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(mounted().documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
  });

  test('with nothing stored, a click flips the theme the boot stamped — not the OS', () => {
    // The OS fake says light. The boot stamped this app's `defaultMode`, dark, so the visible
    // theme is dark and the first click must go light; a toggle that asked the OS would write the
    // dark already on screen and look dead.
    stored.clear();
    mounted().documentElement.setAttribute(THEME_DEFAULT_ATTRIBUTE, 'dark');
    mounted().documentElement.setAttribute(THEME_ATTRIBUTE, 'dark');
    expect(mounted().fire('button', 'click')).toBe(true);
    expect(stored.get(THEME_STORAGE_KEY)).toBe('light');
    expect(mounted().documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('light');
  });

  test("an OS flip is followed while nothing is stored and the app's default is 'system'", () => {
    stored.clear();
    mounted().documentElement.setAttribute(THEME_DEFAULT_ATTRIBUTE, 'system');
    flipOs(true);
    expect(mounted().documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
    // A fixed default is the app's own opinion: the OS does not override it.
    mounted().documentElement.setAttribute(THEME_DEFAULT_ATTRIBUTE, 'dark');
    flipOs(false);
    expect(mounted().documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
  });
});
