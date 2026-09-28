/**
 * The client router's per-tab memory of documents it fetched: a prefetch on intent, answered by
 * the click that follows. Memory only, never storage — a gated page rendered for this principal
 * must not outlive the tab — for `NAVIGATION_CACHE_TTL_MS`, and emptied by any POST, because a
 * write is the one thing this tab knows makes every page it holds suspect.
 */

import { NAVIGATION_CACHE_TTL_MS } from './navigation-rules';

/** One fetched document: the promise, so a click during the prefetch waits for the same fetch. */
export interface CachedDocument<T> {
  readonly at: number;
  readonly value: Promise<T>;
}

export interface NavigationCache<T> {
  /** A fresh entry for `url`, or `undefined` — an expired one is dropped on the way. */
  get(url: string): Promise<T> | undefined;
  /** A fresh entry's answer and how old it is, or `undefined`. */
  peek(url: string): { readonly value: Promise<T>; readonly ageMs: number } | undefined;
  set(url: string, value: Promise<T>): void;
  delete(url: string): void;
  clear(): void;
  readonly size: number;
}

export interface NavigationCacheOptions {
  /** The clock, for a test. The TTL and the cap are constants: nothing has a reason to vary them. */
  readonly now?: () => number;
}

/** Bounded: a visitor hovering a 200-row table must not hold 200 documents. */
export const NAVIGATION_CACHE_MAX_ENTRIES = 20;

/**
 * The fragment never reaches the server, so `/a#x` and `/a#y` are one document; and `?b=2&a=1` is
 * `?a=1&b=2` — one query, however a link happened to spell it.
 */
export const cacheKey = (url: string): string => {
  const parsed = new URL(url, 'http://x.invalid');
  parsed.hash = '';
  parsed.searchParams.sort();
  return url.startsWith('/') ? `${parsed.pathname}${parsed.search}` : parsed.href;
};

export function navigationCache<T>(options: NavigationCacheOptions = {}): NavigationCache<T> {
  const ttl = NAVIGATION_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const max = NAVIGATION_CACHE_MAX_ENTRIES;
  const entries = new Map<string, CachedDocument<T>>();
  return {
    get(url) {
      const key = cacheKey(url);
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (now() - entry.at >= ttl) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    peek(url) {
      const value = this.get(url);
      const entry = entries.get(cacheKey(url));
      return value === undefined || entry === undefined
        ? undefined
        : { value, ageMs: now() - entry.at };
    },
    set(url, value) {
      const key = cacheKey(url);
      entries.delete(key);
      entries.set(key, { at: now(), value });
      // Oldest first: a Map iterates in insertion order and `set` re-inserts.
      for (const oldest of entries.keys()) {
        if (entries.size <= max) break;
        entries.delete(oldest);
      }
      // A failed fetch is not a document: the next click must ask again, not replay the failure.
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
    },
    delete(url) {
      entries.delete(cacheKey(url));
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
