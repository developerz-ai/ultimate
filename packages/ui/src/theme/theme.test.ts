import { beforeEach, describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import {
  clearTheme,
  initTheme,
  osTheme,
  resolveTheme,
  setTheme,
  storedTheme,
  type Theme,
  type ThemeEnv,
  toggleTheme,
  watchOsTheme,
} from './theme';

interface FakeEnv extends ThemeEnv {
  stored: string | null;
  dark: boolean;
  applied: Theme[];
  fireOsChange(): void;
}

function fakeEnv(init: { stored?: string | null; dark?: boolean } = {}): FakeEnv {
  const listeners: Array<() => void> = [];
  const env: FakeEnv = {
    stored: init.stored ?? null,
    dark: init.dark ?? false,
    applied: [],
    read: () => env.stored,
    write: (value) => {
      env.stored = value;
    },
    remove: () => {
      env.stored = null;
    },
    prefersDark: () => env.dark,
    apply: (theme) => {
      env.applied.push(theme);
    },
    observeOs: (listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    fireOsChange: () => {
      for (const listener of [...listeners]) listener();
    },
  };
  return env;
}

describe('resolution order', () => {
  let env: FakeEnv;
  beforeEach(() => {
    env = fakeEnv();
  });

  test('with no stored choice, the OS decides', () => {
    env.dark = true;
    expect(resolveTheme(env)).toBe('dark');
    env.dark = false;
    expect(resolveTheme(env)).toBe('light');
  });

  test('a stored choice beats the OS', () => {
    env.dark = true;
    setTheme('light', env);
    expect(storedTheme(env)).toBe('light');
    expect(osTheme(env)).toBe('dark');
    expect(resolveTheme(env)).toBe('light');
  });

  test('clearing the choice returns control to the OS', () => {
    env.dark = true;
    setTheme('light', env);
    expect(clearTheme(env)).toBe('dark');
    expect(storedTheme(env)).toBeNull();
    expect(resolveTheme(env)).toBe('dark');
  });

  test('a corrupt stored value is ignored, not thrown on', () => {
    env.stored = 'sepia';
    env.dark = true;
    expect(storedTheme(env)).toBeNull();
    expect(resolveTheme(env)).toBe('dark');
  });

  test('initTheme applies the resolved theme exactly once', () => {
    env.dark = true;
    expect(initTheme(env)).toBe('dark');
    expect(env.applied).toEqual(['dark']);
  });

  test('toggleTheme flips the resolved theme and persists the choice', () => {
    env.dark = true;
    expect(toggleTheme(env)).toBe('light');
    expect(env.stored).toBe('light');
    expect(toggleTheme(env)).toBe('dark');
    expect(env.stored).toBe('dark');
  });

  test('an invalid theme throws X_THEME_INVALID with a fix', () => {
    try {
      setTheme('sepia' as Theme, env);
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; fix?: string };
      expect(err.code).toBe(UI_ERROR_CODES.themeInvalid);
      expect(err.fix).toContain('clearTheme()');
    }
  });
});

describe('OS change listener', () => {
  test('applies OS flips only while the user has not chosen', () => {
    const env = fakeEnv();
    const stop = watchOsTheme(env);

    env.dark = true;
    env.fireOsChange();
    expect(env.applied).toEqual(['dark']);

    setTheme('light', env);
    env.applied.length = 0;
    env.dark = false;
    env.fireOsChange();
    expect(env.applied).toEqual([]);

    clearTheme(env);
    env.applied.length = 0;
    env.dark = true;
    env.fireOsChange();
    expect(env.applied).toEqual(['dark']);

    stop();
    env.applied.length = 0;
    env.fireOsChange();
    expect(env.applied).toEqual([]);
  });
});
