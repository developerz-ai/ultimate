// Theme resolution. One rule: an explicit choice in storage wins, then the theme the boot script
// already stamped on the document, then the app's `theme.defaultMode` (the OS for `'system'`). Every side effect
// goes through an injected `ThemeEnv`, so this is testable without a DOM and reusable on the server.

import { THEME_STORAGE_KEY } from '@ultimat3/core';
import { invalidThemeError, runtimeMissingError } from '../errors';
import type { Theme } from '../tokens/tokens';

export type { Theme };

export const THEME_ATTRIBUTE = 'data-theme';
/** Where the boot script records `theme.defaultMode` itself — `'light'`, `'dark'` or `'system'`.
 *  `@ultimat3/render`'s `themeScriptBody` writes `${attribute}-default`; this is that name. */
export const THEME_DEFAULT_ATTRIBUTE = `${THEME_ATTRIBUTE}-default`;
export const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** The host capabilities theme control needs. Injected so tests need no DOM. */
export interface ThemeEnv {
  read(): string | null;
  /** The theme the document carries right now — what the boot script stamped, or the last apply. */
  current(): string | null;
  /** The app's `theme.defaultMode` as the boot stamped it, or `null` when no boot ran. */
  appDefault(): string | null;
  write(value: string): void;
  remove(): void;
  prefersDark(): boolean;
  apply(theme: Theme): void;
  /** Subscribe to OS scheme changes. Returns an unsubscribe. */
  observeOs(listener: () => void): () => void;
}

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function assertTheme(value: unknown): asserts value is Theme {
  if (!isTheme(value)) throw invalidThemeError(value);
}

/** The user's explicit choice, or null when they have never chosen. */
export function storedTheme(env: ThemeEnv): Theme | null {
  const raw = env.read();
  return isTheme(raw) ? raw : null;
}

export function osTheme(env: ThemeEnv): Theme {
  return env.prefersDark() ? 'dark' : 'light';
}

/**
 * What "no explicit choice" means for this app: its fixed `theme.defaultMode` when it has one, the
 * OS when it is `'system'` or unknown. Clearing a choice and following the OS both answer this, so
 * an app that opens dark is never flipped light by an OS change or a "system" pick.
 */
export function defaultTheme(env: ThemeEnv): Theme {
  const fixed = env.appDefault();
  return isTheme(fixed) ? fixed : osTheme(env);
}

/**
 * Resolution order: explicit stored choice -> the theme on the document -> OS preference. The
 * middle step is the app's default: with `theme.defaultMode: 'dark'` the boot script stamps dark
 * on a light-OS machine, and answering the OS here made the first toggle write the theme already
 * on screen — a click that did nothing.
 */
export function resolveTheme(env: ThemeEnv): Theme {
  const current = env.current();
  return storedTheme(env) ?? (isTheme(current) ? current : defaultTheme(env));
}

/** Run once on load. Idempotent — safe after the inline head script. */
export function initTheme(env: ThemeEnv = browserThemeEnv()): Theme {
  const theme = resolveTheme(env);
  env.apply(theme);
  return theme;
}

/** The user picked a theme. Persist it so it outranks the OS from now on. */
export function setTheme(theme: Theme, env: ThemeEnv = browserThemeEnv()): Theme {
  assertTheme(theme);
  env.write(theme);
  env.apply(theme);
  return theme;
}

/** Forget the explicit choice and return to the app's default (the OS, for `'system'`). */
export function clearTheme(env: ThemeEnv = browserThemeEnv()): Theme {
  env.remove();
  const theme = defaultTheme(env);
  env.apply(theme);
  return theme;
}

/** Flip whatever is currently resolved, and record it as an explicit choice. */
export function toggleTheme(env: ThemeEnv = browserThemeEnv()): Theme {
  return setTheme(resolveTheme(env) === 'dark' ? 'light' : 'dark', env);
}

/**
 * Follow the OS live — but only while the user has made no explicit choice AND the app's default
 * is the OS. Returns an unsubscribe so a component can drop it on cleanup.
 */
export function watchOsTheme(env: ThemeEnv = browserThemeEnv()): () => void {
  return env.observeOs(() => {
    if (storedTheme(env) === null && !isTheme(env.appDefault())) env.apply(osTheme(env));
  });
}

/** The real browser implementation. Throws off-DOM instead of failing silently. */
export function browserThemeEnv(): ThemeEnv {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw runtimeMissingError(
      'document/window for theme control',
      'pass an explicit ThemeEnv: initTheme(myServerThemeEnv)',
    );
  }
  const media = window.matchMedia(THEME_MEDIA_QUERY);
  return {
    read: () => safeStorage(() => window.localStorage.getItem(THEME_STORAGE_KEY), null),
    current: () => document.documentElement.getAttribute(THEME_ATTRIBUTE),
    appDefault: () => document.documentElement.getAttribute(THEME_DEFAULT_ATTRIBUTE),
    write: (value) => safeStorage(() => window.localStorage.setItem(THEME_STORAGE_KEY, value)),
    remove: () => safeStorage(() => window.localStorage.removeItem(THEME_STORAGE_KEY)),
    prefersDark: () => media.matches,
    apply: (theme) => document.documentElement.setAttribute(THEME_ATTRIBUTE, theme),
    observeOs: (listener) => {
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
  };
}

// Private-mode Safari throws on localStorage access; a theme is never worth a
// crash, so storage failures degrade to "no stored choice".
function safeStorage<T>(fn: () => T, fallback?: T): T {
  try {
    return fn();
  } catch {
    return fallback as T;
  }
}
