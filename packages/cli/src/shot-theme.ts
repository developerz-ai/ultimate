// The script a capture runs ahead of the document when a theme was ASKED for. Since 20.2.0 the
// boot inlines a theme script (`@ultimat3/render`'s `themeScriptBody`) whose fallback is the app's
// `theme.defaultMode`, and only a stored choice under `THEME_STORAGE_KEY` beats it — so emulating
// `prefers-color-scheme` alone photographs a `defaultMode: 'dark'` app dark whatever was requested
// (issue #489). A requested theme is therefore stored as the visitor's CHOICE, on the page's origin,
// before the boot reads it: the picture is then what a visitor who chose that theme sees.

import { THEME_STORAGE_KEY } from '@ultimat3/render';
import type { ShotColorScheme } from './browser-launcher-port';
import { BadFlagError } from './errors';

/** What `x shot --theme` accepts: the two the boot honours from storage, and nothing else. */
const SHOT_THEMES = ['light', 'dark'] as const;
export type ShotTheme = (typeof SHOT_THEMES)[number];

const isShotTheme = (value: string): value is ShotTheme =>
  (SHOT_THEMES as readonly string[]).includes(value);

/**
 * `--theme light|dark` on a ROUTE shot, or nothing — the box's own preference and the app's own
 * default, which is what `x shot` has always photographed. Refused by name for any other value:
 * `no-preference` is the browser port's clear, not a theme a reader can ask for.
 */
export function readThemeFlag(value: string | undefined): ShotTheme | undefined {
  if (value === undefined) return undefined;
  if (isShotTheme(value)) return value;
  throw new BadFlagError({
    flag: 'theme',
    command: 'shot',
    reason: `"${value}" is not a theme; it is light or dark`,
    fix: 'x shot / --theme light --json',
  });
}

/**
 * The seeding expression, DETERMINISTIC per scheme: the offline drivers key recordings on the exact
 * string, and a test asserts on it by value. `'no-preference'` answers `undefined` — the boot
 * honours only `"light"` and `"dark"` from storage, so there is no choice to store, and storing
 * anything else would be a value the tokens have no block for.
 *
 * `JSON.stringify` on both halves, never a value pasted between quotes: the key and the scheme land
 * inside a JS string, where one `"` ends it. The `try` is for the origin the page starts on:
 * `about:blank` is opaque and its `localStorage` throws, and a throw from a new-document script
 * would surface as a page error on a capture that has not navigated yet.
 */
export function themeChoiceExpression(scheme: ShotColorScheme): string | undefined {
  if (scheme === 'no-preference') return undefined;
  return (
    `try{localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)},${JSON.stringify(scheme)})}` +
    'catch(e){}'
  );
}
