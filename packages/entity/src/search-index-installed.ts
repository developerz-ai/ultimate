// The installed `SearchIndex`: `runtime.ts`'s `searchIndex`, else `postgresSearchIndex()` over the
// ambient pool. One slot (`adapterSlot`), read per call, so a test's `installSearchIndex(memory)`
// and the boot's install both release only their own frame.

import { adapterSlot } from '@ultimat3/core/adapter';
import type { SearchIndex } from './search-index';
import { postgresSearchIndex } from './search-index-postgres';

let builtIn: SearchIndex | undefined;

const slot = /* @__PURE__ */ adapterSlot<SearchIndex>(() => {
  builtIn ??= postgresSearchIndex();
  return builtIn;
});

/**
 * On `./adapter` only. Answers the release: it drops this install and no other. While an external
 * index is the current one, every committed write of a searchable entity is mirrored to it
 * (`search-index-sync.ts`, asked per write by `row-observer.ts`) — no subscription to hold.
 */
export const installSearchIndex = (index: SearchIndex): (() => void) => slot.install(index);

/** The index every search through the port asks — what `reindex` writes and a read queries. */
export const searchIndex = (): SearchIndex => slot.current();
