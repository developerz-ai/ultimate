// The detected-zone script: one inline cookie write from `Intl`'s own zone, on `app/` documents
// only (never `site/`, axiom 6), so a document navigation — which sends no `x-timezone` — still
// tells the next request where the visitor is. The first paint stays the default; the second is right.

import { serializeSetCookie } from '@ultimat3/core';
import { DEFAULT_TZ_CONFIG } from '@ultimat3/http';
import type { HeadTag } from './head';

/** A script past this is no longer "one cookie write"; the test holds the body under it. */
export const ZONE_SCRIPT_MAX_BYTES = 200;

/** A year: the zone a device is in changes rarely, and every load rewrites it anyway. */
const MAX_AGE_SECONDS = 31_536_000;

/** The request pipeline's detected-zone cookie, exported for harnesses that must seed it. */
export const DETECTED_ZONE_COOKIE = DEFAULT_TZ_CONFIG.detectedCookie;

/**
 * The body alone, so the CSP hash and the tag come from one string (`themeScriptBody`'s rule).
 * The name is `@ultimat3/http`'s `detectedCookie` — the one `resolvePreferences` reads, ranked
 * below the chosen cookie — and never the chosen one: a guess written there would erase a pick.
 * The attributes are core's one serializer's, split around an empty value the browser fills with
 * the zone: `httpOnly: false` because a script writes it, and an IANA name is all cookie octets.
 */
export function zoneScriptBody(): string {
  const line = serializeSetCookie(DETECTED_ZONE_COOKIE, '', {
    maxAge: MAX_AGE_SECONDS,
    httpOnly: false,
  });
  const at = line.indexOf(';');
  return (
    `try{document.cookie=${JSON.stringify(line.slice(0, at))}+` +
    'Intl.DateTimeFormat().resolvedOptions().timeZone+' +
    `${JSON.stringify(line.slice(at))}}catch(e){}`
  );
}

/** As a `HeadTag`, deduped by its key like the theme flip. */
export function zoneScript(): HeadTag {
  return { kind: 'script', key: 'script:zone', content: zoneScriptBody() };
}
