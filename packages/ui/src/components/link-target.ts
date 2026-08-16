// Pure href/target core behind <Link>, <Avatar> and <Breadcrumb>. Split out so the two rules —
// a scheme a browser will execute is never emitted, and "external" is decided on the value that
// SURVIVES that check — are testable without a renderer. `javascript:` used to pass through
// `href={props.href}` untouched AND read as internal (the test was `/^https?:\/\//`), so it also
// lost `rel="noopener"`.

import { safeUrl } from '@ultimat3/core';

export interface LinkTarget {
  /** `undefined` means emit no `href` at all: an inert anchor beats a live unchecked one. */
  readonly href: string | undefined;
  readonly external: boolean;
}

/**
 * `external` is `true` only for a URL that both survived the scheme check and names another
 * origin's protocol — so a refused value can never acquire `target="_blank"` on the way out.
 */
export function linkTarget(href: string, declaredExternal?: boolean | undefined): LinkTarget {
  const safe = safeUrl(href, 'href');
  if (safe === null) return { href: undefined, external: false };
  return { href: safe, external: declaredExternal === true || /^https?:\/\//.test(safe) };
}
