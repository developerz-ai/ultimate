// Requests per route: how many fetches one document makes before it is whole — itself, every
// script file (`measureDocumentJs` counts those as it weighs them) and every stylesheet. Reported
// in the stats row beside the bytes, never budgeted: a ceiling is the app's declaration to make.

import { artifactPath, HREF_ATTR } from './budgets-scan';

/** A `<link>` whose `rel` list holds `stylesheet` — the one link a browser fetches to paint. */
const STYLESHEET_TAG = /<link\s[^>]*\brel="(?:[^"]*\s)?stylesheet(?:\s[^"]*)?"[^>]*>/g;

/** The requests one document makes, as the stats row records them. */
export interface RouteRequests {
  readonly documents: 1;
  /** Distinct same-origin script files fetched: entries, the chunks they import, framework files. */
  readonly scripts: number;
  /** Distinct same-origin stylesheets. */
  readonly styles: number;
  readonly total: number;
}

/**
 * Distinct same-origin stylesheets `html` links, by the path a browser fetches — the unit
 * `measureDocumentJs` dedupes scripts by. A cross-origin sheet is not this build's to count, and
 * a `rel="preload"` of a sheet is the same fetch the stylesheet link then reuses.
 */
export function stylesheetRequests(html: string): number {
  const paths = new Set<string>();
  for (const match of html.matchAll(STYLESHEET_TAG)) {
    const href = HREF_ATTR.exec(match[0])?.groups?.['href'];
    const path = href === undefined ? undefined : artifactPath(href);
    if (path !== undefined) paths.add(path);
  }
  return paths.size;
}

export function routeRequests(scripts: number, styles: number): RouteRequests {
  return { documents: 1, scripts, styles, total: 1 + scripts + styles };
}
