// The no-flash theme script, inlined into every document a served or exported process writes,
// with `theme.defaultMode` from `app.config.ts` as its fallback. Before this the key had no reader
// at all (pinned as a dead key in `scripts/lib/config-reader-pins.ts`) and neither of the two
// scripts the framework exported was wired into a document: an app that wanted to open dark had to
// write its own boot script AND admit it to the CSP by hand — which every app forgot in one of the
// two places. Sibling of `app-auth.ts`'s `loadSignInPath` and imports the config for the same
// reason: a regex over the app's source is the pattern `app-load.ts` refuses.

// why: Bun exposes no path-join primitive, and the config path is app-root-relative — the same
// necessity `app-auth.ts` records.
import { join } from 'node:path';
import type { ThemeMode } from '@ultimat3/core';
import { cspHashSource } from '@ultimat3/http';
import { renderHead, themeScript, themeScriptBody } from '@ultimat3/render';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isThemeMode = (value: unknown): value is ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system';

/**
 * `theme.defaultMode`, or `'system'` — the value `defineConfig` fills in — when the app declares
 * none or the file is absent. Structural, never `instanceof`, for `loadSignInPath`'s reason.
 */
export async function loadThemeMode(root: string): Promise<ThemeMode> {
  const configPath = join(root, APP_CONFIG_FILE);
  if (!(await Bun.file(configPath).exists())) return 'system';
  const module = (await import(configPath)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  if (!isRecord(config)) return 'system';
  const theme = config['theme'];
  if (!isRecord(theme)) return 'system';
  const mode = theme['defaultMode'];
  return isThemeMode(mode) ? mode : 'system';
}

export interface ThemeBoot {
  /** The rendered `<script>` tag, for `DocumentOptions.themeHead`. */
  readonly head: string;
  /** The `script-src` source that admits exactly that tag's body. */
  readonly cspSource: string;
}

/**
 * Tag and hash from ONE body: `themeScriptBody` is what `themeScript` inlines, so a policy hashed
 * here admits the script the document carries and not a restatement of it. The storage key is
 * render's `THEME_STORAGE_KEY`, which `theme-boot.test.ts` pins equal to `@ultimat3/ui`'s — the
 * toggle writes the key the boot reads.
 */
export function themeBoot(mode: ThemeMode): ThemeBoot {
  const options = { fallback: mode };
  return {
    head: renderHead([themeScript(options)]),
    cspSource: cspHashSource(themeScriptBody(options)),
  };
}
