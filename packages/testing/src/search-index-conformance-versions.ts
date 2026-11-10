// The search index's ordering contract: keep only NEWER. A `reindex` batch that read a row at v1
// may call `index` after the write path indexed v2 or removed the row; the index must answer v2, or
// nothing. Each stale call is `index` ALONE, as when a batch's read raced a write, so the built-in
// Postgres index passes by construction.

// An EQUAL version is a replay: the writer, not the index, keeps versions strictly increasing per
// row (`@ultimat3/entity`'s `advanceVersion`). A `committed` document — the write path's — replaces
// a tombstone whatever its version: a key deleted and written again is live.

import { expect } from 'bun:test';
import type { SearchScope } from '@ultimat3/entity/adapter';
import type { SearchIndexCheck } from './search-index-conformance-support';
import {
  searchDoc as doc,
  putSearchDocs,
  SEARCH_TENANT_A,
  searchDocId,
  searchIds,
} from './search-index-conformance-support';

export const SEARCH_INDEX_VERSION_CHECKS: readonly SearchIndexCheck[] = [
  {
    name: 'a committed document replaces a newer tombstone: a key deleted and written again is found',
    async run(subject) {
      await putSearchDocs(subject, [doc(subject.entity, 1, 'zebra', { version: 10 })]);
      const own: SearchScope = { entity: subject.entity, tenant: SEARCH_TENANT_A };
      await subject.drop(own, [searchDocId(1)]);
      await subject.index.remove(own, [searchDocId(1)], 30);
      const again = doc(subject.entity, 1, 'quokka', { version: 20 });
      await subject.store([again]);
      await subject.index.index([again], { committed: true });
      expect(await searchIds(subject, 'quokka')).toEqual([searchDocId(1)]);
    },
  },
  {
    name: 'an older version indexed after a newer one leaves the newer one',
    async run(subject) {
      await putSearchDocs(subject, [doc(subject.entity, 1, 'lantern', { version: 20 })]);
      await subject.index.index([doc(subject.entity, 1, 'zebra', { version: 10 })]);
      expect(await searchIds(subject, 'zebra')).toEqual([]);
      expect(await searchIds(subject, 'lantern')).toEqual([searchDocId(1)]);
    },
  },
  {
    name: 'a version indexed after the id was removed at a later version stays removed',
    async run(subject) {
      await putSearchDocs(subject, [doc(subject.entity, 1, 'zebra', { version: 10 })]);
      const own: SearchScope = { entity: subject.entity, tenant: SEARCH_TENANT_A };
      await subject.drop(own, [searchDocId(1)]);
      await subject.index.remove(own, [searchDocId(1)], 30);
      await subject.index.index([doc(subject.entity, 1, 'zebra', { version: 20 })]);
      expect(await searchIds(subject, 'zebra')).toEqual([]);
    },
  },
  {
    name: 'an id written again after its removal, at a newer version, is found',
    async run(subject) {
      await putSearchDocs(subject, [doc(subject.entity, 1, 'zebra', { version: 10 })]);
      const own: SearchScope = { entity: subject.entity, tenant: SEARCH_TENANT_A };
      await subject.drop(own, [searchDocId(1)]);
      await subject.index.remove(own, [searchDocId(1)], 30);
      await putSearchDocs(subject, [doc(subject.entity, 1, 'quokka', { version: 40 })]);
      expect(await searchIds(subject, 'quokka')).toEqual([searchDocId(1)]);
    },
  },
];
