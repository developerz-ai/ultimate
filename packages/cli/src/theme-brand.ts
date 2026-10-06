// The app's brand, declared once as `export const brand = defineTheme(…)` in
// `apps/web/shared/theme.ts`, read here and nowhere else: the `<style>` every document the boot
// renders carries after its stylesheet, and the body `style-src` admits. No module, no brand: an
// unthemed app emits no tag and extends no policy.

// why: Bun exposes no path-join primitive, and the module path is app-root-relative.
import { join } from 'node:path';
import { ConfigInvalidError, describeValue } from '@ultimat3/core';
import { renderHead } from '@ultimat3/render';

/** The conventional module, beside `shared/global.ts` — one fixed path, as `API_INDEX` is. */
export const APP_THEME_MODULE = 'apps/web/shared/theme.ts';
/** The named export the module declares — `@ultimat3/ui`'s README spells it `brand`. */
export const APP_THEME_EXPORT = 'brand';

export interface ThemeBrand {
  /** The rendered `<style>`, for `DocumentOptions.brandHead`. */
  readonly head: string;
  /** Exactly the text between the tags — the body a boot hands `inlineStyleSources`. */
  readonly style: string;
}

/** Code to paste, as `loadAppConfig`'s is: the module path is already in the cause. */
const FIX = `export const ${APP_THEME_EXPORT} = defineTheme({ preset: 'scifi' });`;

/**
 * `undefined` when the app has no theme module or its brand renders no CSS. A module that will not
 * import throws as it did, so a palette `defineTheme()` refuses fails the boot with
 * `X_UI_CONTRAST_INSUFFICIENT` (or its token code) and not a rewording of it.
 */
export async function loadThemeBrand(root: string): Promise<ThemeBrand | undefined> {
  const path = join(root, APP_THEME_MODULE);
  if (!(await Bun.file(path).exists())) return undefined;
  const module = (await import(path)) as Record<string, unknown>;
  const css = brandCss(path, module);
  if (css.length === 0) return undefined;
  // `renderHead` escapes `</` in a style body, which would make the tag's text differ from the
  // hashed one — so a body that needs escaping is refused above rather than escaped here.
  return { head: renderHead([{ kind: 'style', key: 'style:brand', content: css }]), style: css };
}

/**
 * The brand's stylesheet, read structurally: `@ultimat3/ui` is a tier below and this package does
 * not import it, so a `Brand` is `{ css: string }`. `defineTheme()` never emits `<` — its values
 * are validated against grammars that exclude it — so one here came from a hand-built object, and
 * it is the one character that could end the element and start markup.
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
      cause: `${path}'s ${APP_THEME_EXPORT}.css contains "<", which defineTheme() never emits and which could close the <style> element it is inlined in`,
      fix: FIX,
      meta: { key: APP_THEME_EXPORT },
    });
  }
  return css;
}
