/**
 * Which clicks and submits the client router takes, and which it leaves to the browser — as pure
 * functions over plain facts, so every rule is testable without a DOM and the router
 * (`navigation.ts`) only gathers the facts. Also the one declaration of every attribute and event
 * name the router shares with the documents the server renders and the apps that listen; the
 * router's headers are core's (`CLIENT_NAVIGATION_*_HEADER`), imported where they are sent.
 */

/**
 * `<meta name="ultimate-navigation" content="<app>:<surface>">` — present only on an opted-in
 * surface. The app's name is part of it, so two apps on one origin (web and admin) are two routers.
 */
export const NAVIGATION_META = 'ultimate-navigation';
// The four router HEADERS are core's (`CLIENT_NAVIGATION_HEADER`, `…_SURFACE_HEADER`,
// `…_SCOPE_HEADER`, `…_LOCATION_HEADER`), imported by the fetcher and by `@ultimat3/http`'s gate —
// 25.0.0 deleted the `NAVIGATION_*_HEADER` aliases this file published for them (`X_HELPER_COPY`).
/** On a link or form: always a full document load. */
export const NAVIGATION_RELOAD_ATTRIBUTE = 'data-x-reload';
/** On a link: followed softly, never fetched before it is clicked. */
export const NAVIGATION_NO_PREFETCH_ATTRIBUTE = 'data-x-no-prefetch';
/** `data-x-persist="<id>"` on an element in both documents: the live element is kept across. */
export const NAVIGATION_PERSIST_ATTRIBUTE = 'data-x-persist';
/** Set on `<html>` while a navigation has run past `NAVIGATION_PROGRESS_DELAY_MS`. */
export const NAVIGATING_ATTRIBUTE = 'data-x-navigating';
/** Dispatched on `document`, cancelable, before the fetch: `detail: { url, method }`. */
export const NAVIGATE_EVENT = 'ultimate:navigate';
/** Dispatched on `document` after the new document is in place: `detail: { url }`. */
export const NAVIGATED_EVENT = 'ultimate:navigated';
/**
 * Dispatched on `document`, cancelable, when a navigation could not complete: `detail: { url,
 * method, reason }`. Default action: a GET load of the page the visitor is on — a POST is never
 * sent twice, and after a failed one only the server knows whether it landed.
 */
export const NAVIGATION_ERROR_EVENT = 'ultimate:navigation-error';

/** How long a prefetched or visited document answers a navigation to the same URL. */
export const NAVIGATION_CACHE_TTL_MS = 30_000;
/** Pointer rest before a prefetch — long enough that sweeping across a menu fetches nothing. */
export const NAVIGATION_PREFETCH_DELAY_MS = 65;
/** Below this, a navigation shows no progress at all: a flash of a bar reads as jank. */
export const NAVIGATION_PROGRESS_DELAY_MS = 150;
/** How long a prefetched answer marked `no-store` may still answer the click it anticipated. */
export const NAVIGATION_NO_STORE_REUSE_MS = 5_000;
/** Redirects the router follows itself before it hands the rest to the browser. */
export const NAVIGATION_MAX_HOPS = 5;

/** Why the browser keeps a navigation. Named, so a test states the rule it pins. */
export type NativeReason =
  | 'prevented'
  | 'modified'
  | 'target'
  | 'download'
  | 'external'
  | 'opt-out'
  | 'cross-origin'
  | 'hash'
  | 'method'
  | 'encoding'
  | 'file'
  | 'unparsable';

export type LinkVerdict =
  | { readonly kind: 'soft'; readonly url: string }
  | { readonly kind: 'native'; readonly reason: NativeReason };

/** What a click on an `<a href>` tells the router. `href` is the RESOLVED `a.href`. */
export interface LinkFacts {
  readonly href: string;
  /** `location.href` of the page the link sits on. */
  readonly current: string;
  readonly button: number;
  readonly modified: boolean;
  readonly defaultPrevented: boolean;
  /** `a.target`, `''` when unset. `_self` is the one value that stays in this tab. */
  readonly target: string;
  readonly download: boolean;
  /** `a.rel`, space-separated. */
  readonly rel: string;
  readonly reload: boolean;
}

const native = (reason: NativeReason): { readonly kind: 'native'; reason: NativeReason } => ({
  kind: 'native',
  reason,
});

/**
 * Same document, fragment only: the browser scrolls, no fetch. Asked of the HREF, not `to.hash`:
 * an empty fragment (`<a href="#">`) parses to `hash === ''`, and was soft-navigated and re-fetched.
 */
const hashOnly = (href: string, to: URL, from: URL): boolean =>
  href.includes('#') && to.pathname === from.pathname && to.search === from.search;

/**
 * The link rules, in the order a reader checks them. The SURFACE is not decided here: the URL
 * alone cannot say which surface answers it, so the router fetches and compares the answer's
 * `ultimate-navigation` meta with this document's (`responseVerdict`).
 */
export function linkVerdict(facts: LinkFacts): LinkVerdict {
  if (facts.defaultPrevented) return native('prevented');
  if (facts.button !== 0 || facts.modified) return native('modified');
  if (facts.target !== '' && facts.target !== '_self') return native('target');
  if (facts.download) return native('download');
  if (facts.rel.split(/\s+/).includes('external')) return native('external');
  if (facts.reload) return native('opt-out');
  // `a.href` is the raw attribute when it does not parse (`href="http://"`): the browser decides
  // what such a link does, where `new URL` threw a bare `TypeError` out of the click handler.
  if (!URL.canParse(facts.href)) return native('unparsable');
  const to = new URL(facts.href);
  const from = new URL(facts.current);
  if (to.origin !== from.origin || (to.protocol !== 'http:' && to.protocol !== 'https:')) {
    return native('cross-origin');
  }
  if (hashOnly(facts.href, to, from)) return native('hash');
  return { kind: 'soft', url: to.href };
}

/** What a hover or focus on a link tells the router, before anyone has clicked. */
export interface PrefetchFacts {
  /** The URL `linkVerdict` would follow softly. */
  readonly url: string;
  readonly noPrefetch: boolean;
  /** `navigator.connection` — absent in a browser that does not say. */
  readonly saveData?: boolean | undefined;
  readonly effectiveType?: string | undefined;
}

/** The connections a guess costs too much on: every byte of a wrong one is the visitor's. */
const SLOW_CONNECTIONS: ReadonlySet<string> = new Set(['slow-2g', '2g']);

/**
 * Whether the router may ASK for `url` before it is clicked. Only asking: the server answers a
 * prefetch of any route that did not declare `navigation: 'prefetch'` with an empty `204` before
 * it runs anything (`@ultimat3/http`'s navigation gate), so a GET that records something — a
 * download, a click, a token opened — is never executed by a hover, whatever its path is called.
 */
export function mayPrefetch(facts: PrefetchFacts): boolean {
  if (facts.noPrefetch || facts.saveData === true) return false;
  return facts.effectiveType === undefined || !SLOW_CONNECTIONS.has(facts.effectiveType);
}

export type FormVerdict =
  | { readonly kind: 'get'; readonly url: string }
  | { readonly kind: 'post'; readonly url: string; readonly encoding: 'urlencoded' | 'multipart' }
  | { readonly kind: 'native'; readonly reason: NativeReason };

/** What a `submit` tells the router — the submitter's `formmethod`/`formaction` already applied. */
export interface FormFacts {
  /** Resolved action URL — or the raw attribute when it does not resolve (`'unparsable'`). */
  readonly action: string;
  readonly current: string;
  /** Lower case: `get`, `post` or `dialog`. */
  readonly method: string;
  readonly enctype: string;
  readonly target: string;
  readonly defaultPrevented: boolean;
  readonly reload: boolean;
  /** A file input with a file chosen: an upload is the browser's, with its own progress. */
  readonly hasFile: boolean;
  /** The fields, for a GET — the query the browser would have built. */
  readonly fields: readonly (readonly [string, string])[];
}

export function formVerdict(facts: FormFacts): FormVerdict {
  if (facts.defaultPrevented) return native('prevented');
  if (facts.target !== '' && facts.target !== '_self') return native('target');
  if (facts.reload) return native('opt-out');
  if (facts.method !== 'get' && facts.method !== 'post') return native('method');
  // `text/plain` is the browser's own encoding, with no `fetch` body that reproduces it byte for byte.
  if (facts.method === 'post' && facts.enctype === 'text/plain') return native('encoding');
  if (!URL.canParse(facts.action)) return native('unparsable');
  const to = new URL(facts.action);
  if (to.origin !== new URL(facts.current).origin) return native('cross-origin');
  if (facts.method === 'get') {
    // The browser REPLACES the action's query with the fields, and so does this.
    to.search = new URLSearchParams(facts.fields.map(([k, v]) => [k, v])).toString();
    return { kind: 'get', url: to.href };
  }
  if (facts.hasFile) return native('file');
  return {
    kind: 'post',
    url: to.href,
    encoding: facts.enctype === 'multipart/form-data' ? 'multipart' : 'urlencoded',
  };
}

export type ResponseVerdict =
  /** Put the answer in place of this document. */
  | { readonly kind: 'swap' }
  /** A redirect the server handed over, on this origin: the router's own next request. */
  | { readonly kind: 'follow'; readonly url: string }
  /** A real navigation to `url`: the browser asks for it, once. */
  | { readonly kind: 'load'; readonly url: string; readonly reason: string }
  /** Not a page: the bytes already received go to the browser — saved or shown, never re-fetched. */
  | { readonly kind: 'hand-over' }
  /** A `204` with nowhere to go: the browser stays where it is, and so does the router. */
  | { readonly kind: 'stay' }
  /** A POST whose outcome cannot be shown: `NAVIGATION_ERROR_EVENT`, then a GET of this page. */
  | { readonly kind: 'failed'; readonly reason: string };

/** What the router knows once an answer arrives, read off the response and both documents. */
export interface ResponseFacts {
  readonly method: 'GET' | 'POST';
  /** The URL this request asked for. */
  readonly requested: string;
  readonly status: number;
  /** `redirect: 'manual'` met a redirect the server did not hand over (not a framework server). */
  readonly opaqueRedirect: boolean;
  /** `x-ultimate-location` on a `204`, resolved. */
  readonly location: string | null;
  readonly contentType: string;
  /** Redirects the router already followed for this navigation. */
  readonly hops: number;
  /** This document's `<app>:<surface>`, and the answer's (`null` when it carries none). */
  readonly surface: string | null;
  readonly nextSurface: string | null;
  /** `x-ultimate-build`: this document's, and the answer's header or meta. */
  readonly build: string | null;
  readonly nextBuild: string | null;
  /** `ultimate-scope`: whose document this is. Absent means "rendered for nobody". */
  readonly scope: string | null;
  readonly nextScope: string | null;
}

const origin = (url: string): string => new URL(url).origin;
const withoutFragment = (url: string): string => url.split('#')[0] ?? url;

/**
 * What to do with an answer. Every branch keeps one rule: nothing the router sent is sent again.
 * A GET is loaded again only where no framework server answered it (an opaque redirect or skew on
 * a static host); a POST never — after one, only the server knows what landed.
 */
export function responseVerdict(facts: ResponseFacts): ResponseVerdict {
  const get = facts.method === 'GET';
  const load = (url: string, reason: string): ResponseVerdict => ({ kind: 'load', url, reason });
  if (facts.opaqueRedirect) {
    return get
      ? load(facts.requested, 'a redirect no framework server handed over')
      : { kind: 'failed', reason: 'a redirect no framework server handed over' };
  }
  if (facts.status === 204) {
    if (facts.location === null) return { kind: 'stay' };
    // The caller ASSIGNS this to `window.location`, so only http(s) is a place to go: a scheme
    // that runs in the page would be script in the app's origin. `@ultimat3/http`'s `locationFor`
    // refuses it at the source; this is the same rule for an answer something else wrote. The
    // requested url is loaded as a document instead — a POST is never re-sent, so it fails.
    if (!/^https?:\/\/./i.test(facts.location) || !URL.canParse(facts.location)) {
      const reason = 'a location that is not http(s)';
      return get ? load(facts.requested, reason) : { kind: 'failed', reason };
    }
    if (origin(facts.location) !== origin(facts.requested))
      return load(facts.location, 'another origin');
    // The server asked for THIS url as a document: the route did not run, the browser runs it.
    if (get && withoutFragment(facts.location) === withoutFragment(facts.requested)) {
      return load(facts.location, 'the server asked for a document load');
    }
    if (facts.hops >= NAVIGATION_MAX_HOPS) return load(facts.location, 'too many redirects');
    return { kind: 'follow', url: facts.location };
  }
  const skewed =
    facts.build !== null && facts.nextBuild !== null && facts.build !== facts.nextBuild;
  // A GET refused for skew (409 before any route ran) or rendered by another build: load it.
  if (get && skewed) return load(facts.requested, 'another build');
  const html = /^\s*text\/html\b/i.test(facts.contentType);
  // An error that is not a page (an offline service worker's empty 503, a JSON 404) is nothing to
  // show — handed over, it became a `blob:` URL in the address bar. A GET is the browser's to
  // load (a worker answers a real navigation with its offline page); a POST is never re-sent.
  if (facts.status >= 400 && !html) {
    const reason = 'an error answer that is not a page';
    return get ? load(facts.requested, reason) : { kind: 'failed', reason };
  }
  if (!html) return { kind: 'hand-over' };
  // A POST answered in place IS the page the browser would have shown, whatever rendered it —
  // and when that is another principal's or build's, the caller stops trusting this tab
  // (`answerMovesTab`): every later navigation is a real load.
  if (!get) return { kind: 'swap' };
  // An error page is the answer, whatever shell rendered it (the framework's own carries no
  // surface meta): a load that wrote and then threw must not run a second time.
  if (facts.status >= 400) return { kind: 'swap' };
  if (facts.nextSurface === null || facts.nextSurface !== facts.surface) {
    return load(facts.requested, 'another surface');
  }
  if (facts.scope !== facts.nextScope) return load(facts.requested, 'another principal');
  return { kind: 'swap' };
}

/** A cached answer, as far as reuse is concerned. */
export interface CachedFacts {
  readonly status: number;
  readonly html: boolean;
  readonly location: string | null;
  readonly noStore: boolean;
  readonly ageMs: number;
}

/**
 * Whether a prefetched answer may stand in for the click: a 2xx page, nothing handed over, and —
 * when the server said `no-store` — only within `NAVIGATION_NO_STORE_REUSE_MS` of being fetched.
 * A failure, a redirect, an empty `204` is never an answer to reuse.
 */
export function reusable(facts: CachedFacts): boolean {
  if (facts.status < 200 || facts.status > 299 || facts.status === 204) return false;
  if (!facts.html || facts.location !== null) return false;
  return !facts.noStore || facts.ageMs < NAVIGATION_NO_STORE_REUSE_MS;
}

/**
 * An answer swapped in although it belongs to another principal or build (a POST answered in place,
 * which cannot be asked for again). The tab's fence, its cache and its islands were set up for the
 * old one, so after it every navigation is a real document load, and every tab's cache is emptied.
 */
export function answerMovesTab(facts: ResponseFacts): boolean {
  const skewed =
    facts.build !== null && facts.nextBuild !== null && facts.build !== facts.nextBuild;
  return skewed || facts.scope !== facts.nextScope;
}
