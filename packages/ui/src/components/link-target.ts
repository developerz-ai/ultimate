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
  return { href: safe, external: declaredExternal === true || namesAnotherOrigin(safe) };
}

/** An origin no real link can name: whatever resolves AWAY from it carried its own authority. */
const SENTINEL_ORIGIN = 'http://link-target.invalid';

/**
 * Decided the way a browser resolves the href, not by its spelling: `//cdn.test`, `HTTPS://…` and
 * a leading space all leave the page's origin, and a regex over the raw string read each of them
 * as internal — no `noopener`, no external hint. A value the parser refuses is treated as external,
 * because the hardening is the safe side of a wrong guess.
 */
function namesAnotherOrigin(href: string): boolean {
  try {
    const url = new URL(href, `${SENTINEL_ORIGIN}/`);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== SENTINEL_ORIGIN
    );
  } catch {
    return true;
  }
}

/**
 * The `rel` an anchor carries. A relation is ADDED to the external hardening, never traded for
 * it — which is why `<Link>` takes the relation as a closed pair and not a free `rel` string a
 * caller could use to write the hardening away.
 */
export function linkRel(
  external: boolean,
  relation?: 'next' | 'prev' | undefined,
): string | undefined {
  if (!external) return relation;
  return relation === undefined ? 'noopener noreferrer' : `${relation} noopener noreferrer`;
}
