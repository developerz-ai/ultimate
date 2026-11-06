// The search index on the wire: one row per entry, `[topic, title, text, symbols]`, the fields
// `searchDocs` reads and nothing it does not. `prerender.ts` encodes it once; the island decodes
// what it fetched, refusing a shape it does not know rather than ranking garbage.

import type { DocEntry } from '@ultimat3/manifest/docs-search';

type Row = readonly [string, string, string, readonly string[]];

export const encodeIndex = (entries: readonly DocEntry[]): string =>
  JSON.stringify(
    entries.map((entry): Row => [entry.topic, entry.title, entry.text, entry.symbols]),
  );

const isRow = (value: unknown): value is Row =>
  Array.isArray(value) &&
  value.length === 4 &&
  typeof value[0] === 'string' &&
  typeof value[1] === 'string' &&
  typeof value[2] === 'string' &&
  Array.isArray(value[3]) &&
  value[3].every((symbol) => typeof symbol === 'string');

/** The entries a fetched index carries; `undefined` for anything that is not one. */
export function decodeIndex(value: unknown): readonly DocEntry[] | undefined {
  if (!Array.isArray(value) || !value.every(isRow)) return undefined;
  return value.map(([topic, title, text, symbols]) => ({
    topic,
    title,
    text,
    symbols,
    package: 'wiki',
    version: '',
    kind: 'guide',
    source: topic,
  }));
}
