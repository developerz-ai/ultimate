// The installed `SearchIndex`: `runtime.ts`'s `searchIndex`, else `postgresSearchIndex()` over the
// ambient pool. One slot (`adapterSlot`), read per call, so a test's `installSearchIndex(memory)`
// and the boot's install both release only their own frame.

import { adapterSlot } from '@ultimat3/core/adapter';
import type { SearchIndex } from './search-index';
import { postgresSearchIndex } from './search-index-postgres';
import { syncSearchIndex } from './search-index-sync';

let builtIn: SearchIndex | undefined;

const slot = /* @__PURE__ */ adapterSlot<SearchIndex>(() => {
  builtIn ??= postgresSearchIndex();
  return builtIn;
});

/**
 * On `./adapter` only. Answers the release: it drops this install and no other. An external index
 * is subscribed to the write path (`search-index-sync.ts`) for as long as it is installed.
 */
export const installSearchIndex = (index: SearchIndex): (() => void) => {
  const release = slot.install(index);
  const stop = syncSearchIndex(index, () => slot.current());
  return () => {
    stop();
    release();
  };
};

/** The index every search through the port asks — what `reindex` writes and a read queries. */
export const searchIndex = (): SearchIndex => slot.current();
