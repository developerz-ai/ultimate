// The server half of client navigation: which router requests a route may answer at all, and a
// redirect answered to a router request turned into something it can act on without a second
// execution. Read by two stages — `context` (the gate, before auth and before any app code) and
// `response` (the rewrite, after everything) — so every route is covered, pages or not.
//
// Why here and not in the router: a request the browser was never asked to make (a prefetch)
// must run NOTHING on a route that did not ask for it, and a GET some app records evidence on (a
// download, a click, a token open) must run exactly once. Only the server can promise either.

import {
  CLIENT_NAVIGATION_HEADER,
  CLIENT_NAVIGATION_LOCATION_HEADER,
  CLIENT_NAVIGATION_SURFACE_HEADER,
} from '@ultimat3/core';
import type { RouteNavigation } from './router';

export type NavigationPurpose = 'soft' | 'prefetch';

/** `soft`, `prefetch`, or `null` for every request the router did not make. */
export function navigationPurpose(request: Request): NavigationPurpose | null {
  const said = request.headers.get(CLIENT_NAVIGATION_HEADER);
  return said === 'soft' || said === 'prefetch' ? said : null;
}

const SAFE = new Set(['GET', 'HEAD']);

/** The schemes a navigation may be handed over to. Everything else is not a place to go. */
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * What `x-ultimate-location` says. A target on THIS origin is its path, query and fragment and
 * nothing else: behind a TLS-terminating proxy the request URL this process sees is
 * `http://internal…`, so an absolute URL built from it named the public site as `http://` (HSTS
 * hid it; it was still wrong). The router resolves a path against the page it runs in, whose origin
 * is the one the visitor typed. A target on ANOTHER origin is kept exactly as the app gave it.
 *
 * Only `http:` and `https:` are ever handed over. The router LOADS what this header says, so a
 * scheme that runs in the page (`javascript:`, `data:`) would be script in the app's own origin
 * whenever a redirect target is caller-influenced. Such a target — and one that will not parse —
 * answers the REQUESTED url instead, as a path: a document load of it re-runs the route, and the
 * browser's own redirect handling refuses what this refused. Total, never a throw: it runs in the
 * `response` stage, after the handler. A same-origin pathname is never emitted starting `//`
 * (`hostlessPath`).
 */
export function locationFor(target: string, base: URL): string {
  const requested = `${base.pathname}${base.search}${base.hash}`;
  if (!URL.canParse(target, base)) return requested;
  const resolved = new URL(target, base);
  if (!WEB_PROTOCOLS.has(resolved.protocol)) return requested;
  if (resolved.origin !== base.origin) return target;
  return `${hostlessPath(resolved.pathname)}${resolved.search}${resolved.hash}`;
}

/**
 * A pathname that starts `//` — `/.//evil.test`, `/..//evil.test`, a request for `//evil.test` —
 * is a path on THIS origin only while the URL keeps its host. Emitted alone it is a
 * scheme-relative reference, and the router resolves it to another host and assigns that to
 * `window.location`. `/.` in front is how WHATWG URL serialisation keeps a host-less `//` path a
 * path; it resolves back to the same pathname, so nothing legitimate changes.
 */
function hostlessPath(pathname: string): string {
  return pathname.startsWith('//') ? `/.${pathname}` : pathname;
}

/** "Load this with a real navigation" — never stored anywhere, it answers one request. */
export function relocate(location: string, headers?: Headers): Response {
  const out = new Headers(headers);
  out.delete('location');
  out.delete('content-type');
  out.delete('content-length');
  out.set(CLIENT_NAVIGATION_LOCATION_HEADER, location);
  out.set('cache-control', 'no-store');
  return new Response(null, { status: 204, headers: out });
}

/**
 * Before the route runs. A GET the router made to anything but a page of ITS surface is answered
 * here: a prefetch with an empty `204` (it may not run the route, and it has nothing to swap), a
 * soft visit with `204` + `x-ultimate-location` naming the same URL, which the router loads as a
 * document — so the route runs once, for the real navigation. A POST is never gated: it is the
 * form's submission, and the rewrite below keeps its redirect to one execution.
 */
export function navigationGate(
  request: Request,
  method: string,
  url: URL,
  navigation: RouteNavigation | undefined,
): Response | undefined {
  const purpose = navigationPurpose(request);
  if (purpose === null || !SAFE.has(method)) return undefined;
  const surface = request.headers.get(CLIENT_NAVIGATION_SURFACE_HEADER);
  const ours = navigation !== undefined && navigation.surface === surface;
  if (ours && (purpose === 'soft' || navigation.prefetch)) return undefined;
  if (purpose === 'prefetch') return new Response(null, { status: 204, headers: NO_STORE });
  return relocate(locationFor(url.href, url));
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * After everything. A redirect answered to a router request — a 303 after a form, a sign-in wall,
 * a load's `setRedirect`, an OAuth hop to another origin — becomes `204` + `x-ultimate-location`,
 * cookies kept. Followed by `fetch`, the target would run inside a request the router may then
 * throw away (another surface, another origin that CORS refuses) and be asked for again; handed
 * over, the router either follows it as its own next request or lets the browser load it, once.
 */
export function redirectForRouter(
  request: Request,
  response: Response,
  base: URL,
): Response | undefined {
  if (navigationPurpose(request) === null) return undefined;
  if (response.status < 300 || response.status > 399) return undefined;
  const location = response.headers.get('location');
  if (location === null) return undefined;
  return relocate(locationFor(location, base), response.headers);
}
