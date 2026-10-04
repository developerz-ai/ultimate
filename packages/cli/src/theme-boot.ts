// The no-flash theme script, inlined into every document a served or exported process writes, with
// `theme.defaultMode` (off the one loader, `app-config-load.ts`) as its fallback — and the CSP source
// that admits it, so no app writes its own boot script and forgets to admit it.

import type { ThemeMode } from '@ultimat3/core';
import { cspHashSource } from '@ultimat3/http';
import { renderHead, themeScript, themeScriptBody } from '@ultimat3/render';
import { loadAppConfig } from './app-config-load';

/** `theme.defaultMode`, or `'system'` — core's own default — for a root with no config file. */
export async function loadThemeMode(root: string): Promise<ThemeMode> {
  return (await loadAppConfig(root))?.theme.defaultMode ?? 'system';
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
