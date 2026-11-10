// The `searchIndex` port's contract as shared examples: `behavesLike(searchIndexConformance, () =>
// ({ index, entity, store, drop }))`. `store`/`drop` write the SOURCE rows (the built-in Postgres
// index reads its table; an external one ignores them), then the suite calls `index`/`remove` as
// `reindex` and a write hook do. Words are chosen no English stemmer rewrites, so every index agrees.

import { expect, test } from 'bun:test';
import type { SearchScope } from '@ultimat3/entity/adapter';
import { SEARCH_INDEX_LIST_CHECKS } from './search-index-conformance-list';
import type { SearchIndexCheck, SearchIndexSubject } from './search-index-conformance-support';
import {
  searchDoc as doc,
  putSearchDocs,
  SEARCH_TENANT_A,
  SEARCH_TENANT_B,
  searchDocId,
  searchIds,
} from './search-index-conformance-support';
import { SEARCH_INDEX_VERSION_CHECKS } from './search-index-conformance-versions';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export const SEARCH_INDEX_CHECKS: readonly SearchIndexCheck[] = [
  {
    name: 'an indexed document is found by a word of any field, whatever its case',
    async run(subject) {
      expect(subject.index.name.length).toBeGreaterThan(0);
      await putSearchDocs(subject, [
        doc(subject.entity, 1, 'Zebra crossing', { body: 'a lantern harbour' }),
      ]);
      expect(await searchIds(subject, 'zebra')).toEqual([searchDocId(1)]);
      expect(await searchIds(subject, 'HARBOUR')).toEqual([searchDocId(1)]);
    },
  },
  {
    name: 'every word of the term must match',
    async run(subject) {
      await putSearchDocs(subject, [
        doc(subject.entity, 1, 'zebra quokka'),
        doc(subject.entity, 2, 'zebra lantern'),
      ]);
      expect(await searchIds(subject, 'zebra quokka')).toEqual([searchDocId(1)]);
      expect(await searchIds(subject, 'zebra')).toEqual([searchDocId(1), searchDocId(2)]);
    },
  },
  {
    name: 'no match, an empty term and bare punctuation answer no hits, never an error',
    async run(subject) {
      await putSearchDocs(subject, [doc(subject.entity, 1, 'zebra')]);
      for (const term of ['walrus', '', '   ', '|||', '(((']) {
        expect(await searchIds(subject, term), term).toEqual([]);
      }
    },
  },
  {
    name: "a tenant is never answered another tenant's document",
    async run(subject) {
      await putSearchDocs(subject, [
        doc(subject.entity, 1, 'zebra'),
        doc(subject.entity, 2, 'zebra', { tenant: SEARCH_TENANT_B }),
      ]);
      expect(await searchIds(subject, 'zebra')).toEqual([searchDocId(1)]);
      expect(await searchIds(subject, 'zebra', SEARCH_TENANT_B)).toEqual([searchDocId(2)]);
    },
  },
  {
    name: 'indexing a newer version of an id replaces its text, and it is one hit',
    async run(subject) {
      await putSearchDocs(subject, [doc(subject.entity, 1, 'zebra')]);
      await putSearchDocs(subject, [doc(subject.entity, 1, 'quokka zebra', { version: 2 })]);
      expect(await searchIds(subject, 'zebra')).toEqual([searchDocId(1)]);
      await putSearchDocs(subject, [doc(subject.entity, 1, 'lantern', { version: 3 })]);
      expect(await searchIds(subject, 'zebra')).toEqual([]);
      expect(await searchIds(subject, 'lantern')).toEqual([searchDocId(1)]);
    },
  },
  {
    name: "a removed id is gone, and a removal under another tenant leaves this one's",
    async run(subject) {
      await putSearchDocs(subject, [
        doc(subject.entity, 1, 'zebra'),
        doc(subject.entity, 2, 'zebra'),
      ]);
      const other: SearchScope = { entity: subject.entity, tenant: SEARCH_TENANT_B };
      await subject.drop(other, [searchDocId(1)]);
      await subject.index.remove(other, [searchDocId(1)], 2);
      expect(await searchIds(subject, 'zebra')).toEqual([searchDocId(1), searchDocId(2)]);
      const own: SearchScope = { entity: subject.entity, tenant: SEARCH_TENANT_A };
      await subject.drop(own, [searchDocId(1)]);
      await subject.index.remove(own, [searchDocId(1)], 2);
      expect(await searchIds(subject, 'zebra')).toEqual([searchDocId(2)]);
    },
  },
  {
    name: 'the limit bounds the hits, each id at most once',
    async run(subject) {
      await putSearchDocs(
        subject,
        [1, 2, 3].map((n) => doc(subject.entity, n, `zebra ${'quokka '.repeat(n)}`)),
      );
      const hits = await subject.index.query({
        entity: subject.entity,
        tenant: SEARCH_TENANT_A,
        term: 'zebra',
        limit: 2,
      });
      expect(hits.length).toBe(2);
      expect(new Set(hits.map((hit) => hit.id)).size).toBe(2);
    },
  },
];

export const SEARCH_INDEX_ALL_CHECKS: readonly SearchIndexCheck[] = [
  ...SEARCH_INDEX_CHECKS,
  ...SEARCH_INDEX_VERSION_CHECKS,
  ...SEARCH_INDEX_LIST_CHECKS,
];

export const searchIndexConformance: SharedExamples<
  SearchIndexSubject | Promise<SearchIndexSubject>
> = sharedExamples('a search index', (subject) => {
  for (const check of SEARCH_INDEX_ALL_CHECKS) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
});
