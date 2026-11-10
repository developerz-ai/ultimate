// The `<link rel="modulepreload">` tags for the islands ONE render recorded: every shared chunk an
// eagerly booted island imports, each once, so the browser fetches them beside the entry instead of
// discovering them only after the entry is parsed. A page that rendered no island gets none.

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
 * The tags, sorted, after the body beside the boot — `<link rel="modulepreload">` is body-ok, and
 * which islands rendered is known only once the walk ran. `booted`: the document carries the page
 * boot, which supplies the realtime runtime, so an island there never fetches the runtime chunk
 * (`awaitPageRuntime`) and a preload of it would download 64 kB for nothing — the same rule the
 * `budgets` step charges by (`MeasureOptions.boot`). `linked` is what an earlier flush of the same
 * document already emitted; it is extended with what this call emits.
 */
export function preloadTags(
  entry: RouteEntry,
  islands: IslandCollector,
  options: DocumentOptions,
  booted: boolean,
  linked: Set<string> = new Set(),
): string {
  const importsOf = options.resolveIsland?.(entry.file).importsOf;
  if (importsOf === undefined) return '';
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
  return urls.map((url) => `<link rel="modulepreload" href="${escapeHtml(url)}">`).join('');
}
