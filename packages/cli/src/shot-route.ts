// `x shot`'s subject: the one route argument read and refused before anything boots, and the
// directory name a route photographs into. A path on the app, never a URL — the SSRF shape
// `allowHosts` exists to refuse is refused here, at the argument, where the reader can see why.

import { BadFlagError, MissingPositionalError } from './errors';

/** A directory name a route can never escape: everything that is not a letter or digit is a dash. */
export function shotSlug(route: string): string {
  const slug = route.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'root' : slug.toLowerCase();
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
};

/**
 * A reserved name (RFC 2606) that resolves nowhere, so the origin check below can never be
 * satisfied by an accident of what the app's own host happens to be.
 */
const ROUTE_BASE = 'http://route.invalid';

/**
 * Where a browser would actually go. The refusal above reads `scheme:` and nothing else, and this
 * is the question it was standing in for: a path is a path only if resolving it lands back on the
 * origin it was resolved against.
 */
const resolvedOrigin = (path: string): string => {
  try {
    return new URL(path, ROUTE_BASE).origin;
  } catch {
    // A path `new URL` will not parse is one no browser will fetch either, and reporting it as the
    // origin it is not is the honest answer here.
    return '';
  }
};

const refuseRoute = (reason: string): never => {
  throw new BadFlagError({
    flag: 'route',
    command: 'shot',
    reason,
    // A placeholder, because there is nothing safe to substitute: unlike an absolute URL, an
    // origin-escaping route carries no path the caller can be assumed to have meant.
    fix: 'x shot /<path> --json',
  });
};

/**
 * A path on the app, never a URL. `x shot https://example.com` would photograph somebody else's
 * site through a headless browser inside your network, which is the SSRF shape `allowHosts` exists
 * to refuse — so it is refused here, at the argument, where the reader can still see why.
 *
 * `scheme:` was the ONLY spelling refused until 2026-08-22, and it is one of four: `//evil/x` is a
 * protocol-relative URL, `\evil\x` is the same thing to every URL parser (a backslash IS a slash
 * for a special scheme), and a TAB inside the path is deleted by the parser before the host is
 * read, so `/⇥/evil/x` becomes `//evil/x`. Each one reached `new URL(route, server.url)` and came
 * back pointed at another host. `allowHostsFrom` one layer down could not catch any of them: it
 * allows a HOSTNAME, and the hostname it is given is the one the page has already left — which is
 * how `x shot //localhost:9200/_cat/indices` photographed whatever else was on the dev box.
 */
export function readRoute(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new MissingPositionalError({ command: 'shot', positional: 'route', example: 'x shot /' });
  }
  const route = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(route)) {
    throw new BadFlagError({
      flag: 'route',
      command: 'shot',
      reason: `"${route}" is an absolute URL; x shot photographs a route of the app under test`,
      // The path out of the URL when it parses — the refusal's own fix line has to be runnable,
      // and `new URL('http://')` throws, so the fallback is the route every app has.
      fix: `x shot ${pathOf(route)} --json`,
    });
  }
  const path = route.startsWith('/') ? route : `/${route}`;
  // Its own refusal rather than folded into the origin check: `/a\b` stays on this origin and is
  // still not the route that was typed — the verdict would record `/a\b` beside a picture of
  // `/a/b`, which is the artifact lying about its own subject.
  if (path.includes('\\')) {
    return refuseRoute(`"${route}" contains a backslash, which a URL parser reads as "/"`);
  }
  const origin = resolvedOrigin(path);
  if (origin !== ROUTE_BASE) {
    return refuseRoute(
      `"${route}" is not a path on the app: a browser resolves it to ${origin === '' ? 'no URL at all' : origin}`,
    );
  }
  return path;
}
