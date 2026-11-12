// The `<link rel="modulepreload">` tags for the islands ONE render recorded: every shared chunk an
// eagerly booted island imports, each once, so the browser fetches them beside the entry instead of
// discovering them only after the entry is parsed. A page that rendered no island gets none. The
// same set, with the stylesheet, as a `Link` response header: what a CDN turns into a 103.

import { escapeHtml } from '@ultimat3/core';
import type { IslandCollector, IslandDirective, RouteEntry } from '@ultimat3/render';
import type { DocumentOptions } from './document-options';
import { isRuntimeChunk } from './island-runtime';

/**
 * Only an island booted as soon as the page is idle, or held until it mounts (`island-hold.ts`,
 * booted at once). `visible` and `interaction` defer the entry on purpose; fetching its chunks
 * early would spend the bytes that deferral exists to save, on a visit that may never need them.
 */
const eager = (directive: IslandDirective): boolean =>
  directive.strategy === 'idle' || directive.hold === true;

/**
 * The URLs, sorted, that one call's tags preload — `preloadTags`' set, and the `Link` header's.
 * `booted`: the document carries the page boot, which supplies the realtime runtime, so an island
 * there never fetches the runtime chunk (`awaitPageRuntime`) and a preload of it would download
 * 64 kB for nothing — the same rule the `budgets` step charges by (`MeasureOptions.boot`). `linked`
 * is what an earlier flush of the same document already emitted; it is extended with these.
 */
export function preloadUrls(
  entry: RouteEntry,
  islands: IslandCollector,
  options: DocumentOptions,
  booted: boolean,
  linked: Set<string> = new Set(),
): readonly string[] {
  const importsOf = options.resolveIsland?.(entry.file).importsOf;
  if (importsOf === undefined) return [];
  const fresh = new Set<string>();
  for (const directive of islands.directives) {
    if (!eager(directive)) continue;
    for (const url of importsOf(directive.entry)) {
      if (linked.has(url) || (booted && isRuntimeChunk(url))) continue;
      fresh.add(url);
    }
  }
  const urls = [...fresh].sort();
  for (const url of urls) linked.add(url);
  return urls;
}

/** The tags, after the body beside the boot: body-ok, and known only once the walk ran. */
export const preloadTagsOf = (urls: readonly string[]): string =>
  urls.map((url) => `<link rel="modulepreload" href="${escapeHtml(url)}">`).join('');

/** `preloadUrls`, as the tags a document carries. */
export function preloadTags(
  entry: RouteEntry,
  islands: IslandCollector,
  options: DocumentOptions,
  booted: boolean,
  linked: Set<string> = new Set(),
): string {
  return preloadTagsOf(preloadUrls(entry, islands, options, booted, linked));
}

/**
 * Only what RFC 8288's `<URI-Reference>` carries bare. Every URL here is one the framework minted
 * (`/styles/<hash>.css`, `/islands/chunk-<hash>.js`), so a URL outside this is not escaped into
 * the header: it is left to its tag, which `escapeHtml` already made safe.
 */
const HEADER_SAFE_URL = /^[A-Za-z0-9\-._~:/?#@!$&'()*+=%]+$/;

/**
 * The `Link` header for a document: its stylesheet as `rel=preload; as=style`, then each chunk its
 * tags preload as `rel=modulepreload` — the same URLs, so a CDN's 103 Early Hint starts exactly the
 * fetches the document would. `undefined` when there is nothing to hint.
 */
export function linkHeader(
  stylesheet: string | undefined,
  modules: readonly string[],
): string | undefined {
  // Each URL screened BEFORE it is wrapped: read back out of the link, a URL holding its own `>;`
  // passed on its first half and carried a second link to another origin in the rest.
  const sheet = stylesheet !== undefined && HEADER_SAFE_URL.test(stylesheet) ? [stylesheet] : [];
  const links = [
    ...sheet.map((url) => `<${url}>; rel=preload; as=style`),
    ...modules
      .filter((url) => HEADER_SAFE_URL.test(url))
      .map((url) => `<${url}>; rel=modulepreload`),
  ];
  return links.length === 0 ? undefined : links.join(', ');
}
