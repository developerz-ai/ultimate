// `RouteMeta.links`: the `<link>` tags a route adds to `<head>` beyond the two this package
// already derives (canonical, hreflang). A font preload, a preconnect, a feed. Typed so a rel the
// framework owns elsewhere — `canonical` (`meta.canonical`), `stylesheet` (the surface bundle) —
// is not spellable here, and checked so an href is always a URL a browser fetches: the value lands
// in an attribute of the document every visitor loads, and `javascript:` in a `<link href>` is
// script the page never meant to carry.

import { linkInvalid, type SeoError } from './errors';
import type { HeadTag } from './meta';

/**
 * Every rel a route may declare. `canonical` and `alternate`+`hreflang` have their own fields;
 * `stylesheet` is the surface bundle's, emitted once per document by the renderer.
 */
export type HeadLinkRel =
  | 'preload'
  | 'modulepreload'
  | 'prefetch'
  | 'preconnect'
  | 'dns-prefetch'
  | 'icon'
  | 'apple-touch-icon'
  | 'manifest'
  | 'alternate'
  | 'author'
  | 'license'
  | 'help'
  | 'privacy-policy'
  | 'terms-of-service'
  | 'search'
  | 'me';

/** The destinations a preload can name (HTML's `as` keywords). */
export type HeadLinkAs =
  | 'audio'
  | 'document'
  | 'embed'
  | 'fetch'
  | 'font'
  | 'image'
  | 'object'
  | 'script'
  | 'style'
  | 'track'
  | 'video'
  | 'worker';

export interface HeadLink {
  readonly rel: HeadLinkRel;
  /** A path (`/assets/…`, from `asset()`) or an `http(s)` URL. Nothing else is fetched. */
  readonly href: string;
  /** Required on `preload`: a preload without it fetches nothing. */
  readonly as?: HeadLinkAs;
  /** A MIME type: `font/woff2`, `application/rss+xml`. */
  readonly type?: string;
  /** Required on a font preload: fonts are CORS requests, and a mismatched preload is a 2nd fetch. */
  readonly crossorigin?: 'anonymous' | 'use-credentials';
  /** A media query: the link applies only where it matches. */
  readonly media?: string;
}

/**
 * The scheme of `href`, or `undefined` for a relative reference. Read the way a browser's URL
 * parser reads it: ASCII tab and newline are removed anywhere and leading C0/space trimmed first,
 * so `java\tscript:` and ` javascript:` are the scheme they execute as.
 */
function schemeOf(href: string): string | undefined {
  let start = 0;
  while (start < href.length && href.charCodeAt(start) <= 0x20) start += 1;
  const normalised = href.slice(start).replace(/[\t\n\r]/g, '');
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalised);
  return match?.[1]?.toLowerCase();
}

/** Why `link` cannot ship, or `undefined`. One predicate for the renderer and the build gate. */
export function linkProblem(link: HeadLink): string | undefined {
  if (typeof link.href !== 'string' || link.href.trim() === '') return 'has an empty href';
  const scheme = schemeOf(link.href);
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    return `has an href with the "${scheme}:" scheme — only a path or an http(s) URL is fetched`;
  }
  if (link.rel === 'preload' && link.as === undefined) {
    return 'is a preload with no `as` — the browser ignores it and fetches nothing early';
  }
  if (link.rel === 'preload' && link.as === 'font' && link.crossorigin === undefined) {
    return "is a font preload with no crossorigin — fonts are fetched in CORS mode, so the preload is not reused and the font downloads twice (crossorigin: 'anonymous')";
  }
  return undefined;
}

const describe = (link: HeadLink): string => `link { rel: '${link.rel}', href: '${link.href}' }`;

/** The error a bad link is, at `file` when the caller knows the route. */
export function linkError(link: HeadLink, problem: string, file?: string): SeoError {
  return linkInvalid(describe(link), problem, file);
}

/**
 * The tags, in declaration order, attributes in a fixed order and only those given. Throws
 * `X_SEO_LINK_INVALID` on the first bad link: this runs for every SSR request and every prerendered
 * page, and a document carrying an unsafe href is worse than no document.
 */
export function linkTags(links: readonly HeadLink[]): HeadTag[] {
  return links.map((link) => {
    const problem = linkProblem(link);
    if (problem !== undefined) throw linkError(link, problem);
    const attrs: Record<string, string> = { rel: link.rel, href: link.href };
    if (link.as !== undefined) attrs['as'] = link.as;
    if (link.type !== undefined) attrs['type'] = link.type;
    if (link.crossorigin !== undefined) attrs['crossorigin'] = link.crossorigin;
    if (link.media !== undefined) attrs['media'] = link.media;
    return { tag: 'link', attrs };
  });
}
