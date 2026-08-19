import { beforeEach, describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import {
  browserThemeEnv,
  clearTheme,
  initTheme,
  osTheme,
  resolveTheme,
  setTheme,
  storedTheme,
  THEME_ATTRIBUTE,
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
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

/**
 * The one implementation of `ThemeEnv` that is not injected — everything above runs against a fake,
 * so nothing there can see a wrong storage key, an attribute on the wrong element, or a listener
 * that is added and never removed. `window` and `document` are installed for the duration of one
 * test and always restored: a leaked `document` makes `solid()` read every later render in this
 * process as a client render with no runtime and throw.
 */
describe('browserThemeEnv', () => {
  interface FakeStorage {
    readonly items: Map<string, string>;
    throws: boolean;
  }

  interface Host {
    readonly storage: FakeStorage;
    readonly applied: string[];
    readonly listeners: (() => void)[];
    dark: boolean;
    restore(): void;
  }

  function installHost(): Host {
    const storage: FakeStorage = { items: new Map(), throws: false };
    const applied: string[] = [];
    const listeners: (() => void)[] = [];
    const host = { storage, applied, listeners, dark: false } as Host;

    const guard = <T>(fn: () => T): T => {
      if (storage.throws) throw new Error('SecurityError: storage is disabled');
      return fn();
    };
    const localStorage = {
      getItem: (key: string): string | null => guard(() => storage.items.get(key) ?? null),
      setItem: (key: string, value: string): void =>
        guard(() => {
          storage.items.set(key, value);
        }),
      removeItem: (key: string): void =>
        guard(() => {
          storage.items.delete(key);
        }),
    };
    const media = {
      get matches(): boolean {
        return host.dark;
      },
      addEventListener: (type: string, listener: () => void): void => {
        if (type !== 'change') throw new Error(`unexpected media listener "${type}"`);
        listeners.push(listener);
      },
      removeEventListener: (_type: string, listener: () => void): void => {
        listeners.splice(listeners.indexOf(listener), 1);
      },
    };
    const queried: string[] = [];
    const window = {
      localStorage,
      matchMedia: (query: string): typeof media => {
        queried.push(query);
        return media;
      },
    };
    const document = {
      documentElement: {
        setAttribute: (name: string, value: string): void => {
          applied.push(`${name}=${value}`);
        },
      },
    };

    Object.assign(globalThis, { window, document });
    host.restore = (): void => {
      Reflect.deleteProperty(globalThis, 'window');
      Reflect.deleteProperty(globalThis, 'document');
      // The media query is read once, at construction, and it is the one this module declares.
      expect(queried).toEqual([THEME_MEDIA_QUERY]);
    };
    return host;
  }

  test('off-DOM it refuses rather than degrading to a no-op theme control', () => {
    let thrown: unknown;
    try {
      browserThemeEnv();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: UI_ERROR_CODES.runtimeMissing });
    expect((thrown as { fix: string }).fix).toContain('initTheme(myServerThemeEnv)');
  });

  test('reads, writes and clears under this package own storage key', () => {
    const host = installHost();
    try {
      const env = browserThemeEnv();
      expect(env.read()).toBeNull();

      env.write('dark');
      expect([...host.storage.items]).toEqual([[THEME_STORAGE_KEY, 'dark']]);
      expect(env.read()).toBe('dark');

      env.remove();
      expect(env.read()).toBeNull();
    } finally {
      host.restore();
    }
  });

  test('applies the theme as an attribute on the document element', () => {
    const host = installHost();
    try {
      browserThemeEnv().apply('dark');
      expect(host.applied).toEqual([`${THEME_ATTRIBUTE}=dark`]);
    } finally {
      host.restore();
    }
  });

  test('prefersDark reads the media query live, not once at construction', () => {
    const host = installHost();
    try {
      const env = browserThemeEnv();
      expect(env.prefersDark()).toBe(false);
      host.dark = true;
      expect(env.prefersDark()).toBe(true);
    } finally {
      host.restore();
    }
  });

  test('the OS subscription hands back an unsubscribe that really detaches', () => {
    const host = installHost();
    try {
      const env = browserThemeEnv();
      const stop = env.observeOs(() => undefined);
      expect(host.listeners).toHaveLength(1);

      stop();
      expect(host.listeners).toEqual([]);
    } finally {
      host.restore();
    }
  });

  test('storage that throws degrades to "no stored choice" — a theme is not worth a crash', () => {
    const host = installHost();
    try {
      const env = browserThemeEnv();
      host.storage.throws = true;

      // Private-mode Safari throws on every one of these three.
      expect(env.read()).toBeNull();
      expect(() => env.write('dark')).not.toThrow();
      expect(() => env.remove()).not.toThrow();
      // And the resolution still answers, from the OS.
      host.dark = true;
      expect(resolveTheme(env)).toBe('dark');
    } finally {
      host.restore();
    }
  });
});
