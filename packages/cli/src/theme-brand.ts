// The app's brand, declared once as `export const brand = defineTheme(…)` in
// `apps/web/shared/theme.ts`, read here and nowhere else: its CSS is appended to every surface
// stylesheet (`style-bundle.ts`), so it rides the hashed, immutable file — no inline `<style>`, no
// `style-src` hash. No module, no brand: an unthemed app's sheets are unchanged.

// why: Bun exposes no path-join primitive, and the module path is app-root-relative.
import { join } from 'node:path';
import { ConfigInvalidError, describeValue } from '@ultimat3/core';
import { setBrandStyles } from './style-bundle';

/** The conventional module, beside `shared/global.ts` — one fixed path, as `API_INDEX` is. */
export const APP_THEME_MODULE = 'apps/web/shared/theme.ts';
/** The named export the module declares — `@ultimat3/ui`'s README spells it `brand`. */
export const APP_THEME_EXPORT = 'brand';

export interface ThemeBrand {
  /** The brand's CSS, exactly as `defineTheme()` rendered it — now the tail of every sheet. */
  readonly css: string;
}

/** Code to paste, as `loadAppConfig`'s is: the module path is already in the cause. */
const FIX = `export const ${APP_THEME_EXPORT} = defineTheme({ preset: 'scifi' });`;

/**
 * `undefined` when the app has no theme module or its brand renders no CSS. Either way the answer
 * is REGISTERED with the stylesheet table, so the next `styleBundle()` carries it (or drops a
 * previous app's). A module that will not import throws as it did, so a palette `defineTheme()`
 * refuses fails the boot with `X_UI_CONTRAST_INSUFFICIENT` (or its token code), not a rewording.
 */
export async function loadThemeBrand(root: string): Promise<ThemeBrand | undefined> {
  const path = join(root, APP_THEME_MODULE);
  const css = (await Bun.file(path).exists())
    ? brandCss(path, (await import(path)) as Record<string, unknown>)
    : '';
  setBrandStyles(css);
  return css.length === 0 ? undefined : { css };
}

/**
 * The brand's stylesheet, read structurally: `@ultimat3/ui` is a tier below and this package does
 * not import it, so a `Brand` is `{ css: string }`. `defineTheme()` never emits `<` — its values
 * are validated against grammars that exclude it — so one here came from a hand-built object, and
 * a sheet every document links is not where an unvalidated one goes. Kept from the inline era,
 * when `<` could also close the element and start markup.
 */
function brandCss(path: string, module: Record<string, unknown>): string {
  const brand = Object.hasOwn(module, APP_THEME_EXPORT) ? module[APP_THEME_EXPORT] : undefined;
  const css = typeof brand === 'object' && brand !== null && 'css' in brand ? brand.css : undefined;
  if (typeof css !== 'string') {
    throw new ConfigInvalidError({
      cause: `${path} exports no ${APP_THEME_EXPORT} built by defineTheme() (${describeValue(brand)}), so no document can carry the app's theme — declare it with defineTheme from @ultimat3/ui`,
      fix: FIX,
      meta: { key: APP_THEME_EXPORT },
    });
  }
  if (css.includes('<')) {
    throw new ConfigInvalidError({
      cause: `${path}'s ${APP_THEME_EXPORT}.css contains "<", which defineTheme() never emits, so the brand was hand-built and is not appended to every stylesheet the documents link`,
      fix: FIX,
      meta: { key: APP_THEME_EXPORT },
    });
  }
  return css;
}
