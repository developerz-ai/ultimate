// Single responsibility: name the heaviest thing a document boots by the source file an author can
// open. Split from `prerender.ts`, which stands at its size ceiling.

import type { IslandBundle } from './island-bundle';

/**
 * The heaviest thing the document actually boots, named by the source file an author can open.
 * An island chunk is content-addressed, so its URL says nothing on its own — mapping it back
 * through the bundle is what turns `X_BUDGET_EXCEEDED` from a number into an instruction.
 */
export function heaviestSource(
  bundle: IslandBundle,
  entries: readonly { readonly url: string; readonly bytes: number }[],
): readonly string[] | undefined {
  const heaviest = entries.reduce<{ url: string; bytes: number } | undefined>(
    (max, entry) => (max === undefined || entry.bytes > max.bytes ? entry : max),
    undefined,
  );
  if (heaviest === undefined) return undefined;
  const chunk = bundle.chunkAt(heaviest.url);
  if (chunk !== undefined) return [chunk.file];
  // A shared chunk has no file of its own: the chain is an island on THIS page that imports it.
  const importer = bundle.chunks.find(
    (one) => one.imports.includes(heaviest.url) && entries.some((entry) => entry.url === one.url),
  );
  return importer === undefined ? [heaviest.url] : [importer.file, heaviest.url];
}
