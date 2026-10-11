// Single responsibility: what a route's `prerender()` answered, normalised — every page as its
// params, plus what the page said about itself for a sitemap (`lastmod`, `locales`).

import { renderCauseValue, renderThrowable } from '@ultimat3/core';
import { PrerenderFailedError } from './errors';
import type { RouteEntry } from './registry';
import type { PrerenderEntry, RouteParams } from './route';

const ENTRY_KEYS: readonly string[] = ['params', 'lastmod', 'locales'];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Is `item` the ENTRY form — `{ params: { … }, lastmod?, locales? }` — rather than a params object?
 * Decided by `params` holding an object: a param VALUE is always a string, so `{ params: 'a' }` on a
 * route whose own dynamic segment is `[params]` stays the plain params it has always been.
 */
const isEntry = (item: Readonly<Record<string, unknown>>): boolean => isRecord(item['params']);

function entryOf(entry: RouteEntry, item: Readonly<Record<string, unknown>>): PrerenderEntry {
  const refuse = (problem: string): never => {
    throw new PrerenderFailedError(
      `prerender() for ${entry.path} returned an entry ${problem}`,
      `x build --target static --json   # after prerender in ${entry.file} returns { params, lastmod?: Date | ISO 8601 string, locales?: string[] }`,
    );
  };
  const extra = Object.keys(item).find((key) => !ENTRY_KEYS.includes(key));
  if (extra !== undefined) {
    refuse(`with the key ${JSON.stringify(extra)}, which is not one of ${ENTRY_KEYS.join(', ')}`);
  }
  const { lastmod, locales } = item;
  if (lastmod !== undefined && typeof lastmod !== 'string' && !(lastmod instanceof Date)) {
    refuse(`whose lastmod is ${renderCauseValue(lastmod)}, neither a Date nor an ISO 8601 string`);
  }
  if (
    locales !== undefined &&
    !(Array.isArray(locales) && locales.every((locale) => typeof locale === 'string'))
  ) {
    refuse(`whose locales is ${renderCauseValue(locales)}, not a list of locale names`);
  }
  return {
    params: item['params'] as RouteParams,
    ...(lastmod === undefined ? {} : { lastmod: lastmod as string | Date }),
    ...(locales === undefined ? {} : { locales: locales as readonly string[] }),
  };
}

/**
 * Every page `prerender()` enumerates, as an entry. A bare string fills the route's one dynamic
 * param; a params object is an entry with nothing to add. `lastmod` is carried AS WRITTEN — whether
 * it names an instant is the sitemap's question (`@ultimat3/seo`, `X_SITEMAP_ENTRY_INVALID`).
 */
export async function enumeratePrerenderEntries(
  entry: RouteEntry,
): Promise<readonly PrerenderEntry[]> {
  const prerender = entry.config.prerender;
  if (prerender === undefined) {
    return entry.pattern.keys.length === 0 ? [{ params: {} }] : [];
  }

  let produced: unknown;
  try {
    produced = await prerender();
  } catch (error) {
    throw new PrerenderFailedError(
      // `renderThrowable`, never `.message`/`String()`: `prerender` is app code and may throw a
      // value whose read raises in turn — this frame is what makes the build failure a coded one.
      `prerender() for ${entry.path} threw: ${renderThrowable(error)}`,
      `fix prerender in ${entry.file} — it runs at build time with no request context`,
    );
  }

  if (!Array.isArray(produced)) {
    throw new PrerenderFailedError(
      `prerender() for ${entry.path} returned ${typeof produced}, expected an array`,
      `return an array of params from prerender in ${entry.file}`,
    );
  }

  const keys = entry.pattern.keys;
  return produced.map((item: unknown): PrerenderEntry => {
    if (typeof item === 'string') {
      const only = keys[0];
      if (keys.length !== 1 || only === undefined) {
        throw new PrerenderFailedError(
          `prerender() for ${entry.path} returned the bare string ${renderCauseValue(item)} ` +
            `but the route has ${keys.length} dynamic params (${keys.join(', ')})`,
          `return objects from prerender in ${entry.file}, e.g. { ${keys.join(': …, ')}: … }`,
        );
      }
      return { params: { [only]: item } };
    }
    // A `null` reached `Object.hasOwn` in `static-path.ts` and left the build as a bare `TypeError`.
    if (!isRecord(item)) {
      throw new PrerenderFailedError(
        `prerender() for ${entry.path} returned ${renderCauseValue(item)} as one of its items, which is neither a params object nor a string`,
        `return an array of params objects (or strings, for a one-param route) from prerender in ${entry.file}`,
      );
    }
    return isEntry(item) ? entryOf(entry, item) : { params: item as RouteParams };
  });
}

/** The params of every page `prerender()` enumerates — what a build renders, one document each. */
export async function enumeratePrerender(entry: RouteEntry): Promise<readonly RouteParams[]> {
  return (await enumeratePrerenderEntries(entry)).map((page) => page.params);
}
