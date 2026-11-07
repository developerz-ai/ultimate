// Single responsibility: the convention `og.capture` rests on, as a gate finding — a declared card
// path is a `site/` route, or the build has no page to photograph. `x verify`'s `seo` step asks it
// of every route whose meta the scan resolved; the build asks it again of the filled paths.

import { routeEntries } from '@ultimat3/render';
import type { RouteRecord } from '@ultimat3/seo';
import type { Finding } from './output';
import { findingFrom } from './output';
import { CardRouteUnknownError } from './static-capture-errors';

/** True when some `site/` route's pattern answers `path` — a static or a prerendered dynamic one. */
const isSiteRoute = (path: string): boolean =>
  routeEntries().some((entry) => entry.surface === 'site' && entry.pattern.regex.test(path));

export function cardRouteFindings(records: readonly RouteRecord[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const record of records) {
    const capture = record.meta?.og?.capture;
    if (capture === undefined || isSiteRoute(capture)) continue;
    findings.push({
      ...findingFrom(new CardRouteUnknownError([capture], record.file)),
      at: record.file,
    });
  }
  return findings;
}
