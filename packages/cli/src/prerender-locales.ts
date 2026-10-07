// One `site/` route's static artifacts in every routed locale. The default locale's pages keep the
// paths and files `renderStatic` computed; every other locale's are served at `/<locale>/<path>`
// and written to `<locale>/<file>` — the layout every static host resolves with no rewrite rule.

import { localeSegment, localizePath } from '@ultimat3/core';
import type { AppLocaleSet } from '@ultimat3/i18n/app-catalogs';
import type { StaticArtifact } from '@ultimat3/render/server';

/** A `StaticArtifact` placed for one locale: its served path and its file under `<locale>/`. */
export type LocalizedArtifact = StaticArtifact & { readonly locale: string };

/** The default's artifacts first, so a report lists the unprefixed page before its translations. */
export async function localizedArtifacts(
  { locales, defaultLocale }: AppLocaleSet,
  renderIn: (locale: string) => Promise<readonly StaticArtifact[]>,
): Promise<readonly LocalizedArtifact[]> {
  const out: LocalizedArtifact[] = [];
  for (const locale of locales) {
    const isDefault = locale === defaultLocale;
    for (const artifact of await renderIn(locale)) {
      out.push({
        ...artifact,
        locale,
        path: isDefault
          ? artifact.path
          : localizePath(artifact.path, locale, locales, defaultLocale),
        outputPath: isDefault
          ? artifact.outputPath
          : `${localeSegment(locale)}/${artifact.outputPath}`,
      });
    }
    // A route with no pages writes none in any locale; asking again per locale is the same answer.
    if (out.length === 0) break;
  }
  return out;
}
