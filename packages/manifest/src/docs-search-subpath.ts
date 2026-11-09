// The `@ultimat3/manifest/docs-search` entry: the ranker and the entry shape, nothing else. A
// subpath, never the barrel: an island that searches docs must not pay for the scanner's `node:fs`
// walk or the manifest's generators (axiom 6). `docs-search-subpath.test.ts` pins the split.

export type { DocEntry, DocEntryKind } from './docs-scan';
export type { DocHit } from './docs-search';
export { nearestTopics, searchDocs } from './docs-search';
