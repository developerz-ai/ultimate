// The search index's `list` contract — what `reindex`'s sweep reads to find documents whose row is
// gone: every live document of one tenant, paged without a repeat or a gap, never a removed id and
// never another tenant's; every tenant's when the query names none.

import { expect } from 'bun:test';
import type { SearchListEntry, SearchListQuery, SearchScope } from '@ultimat3/entity/adapter';
import type { SearchIndexCheck, SearchIndexSubject } from './search-index-conformance-support';
import {
  searchDoc as doc,
  putSearchDocs,
  SEARCH_TENANT_A,
  SEARCH_TENANT_B,
  searchDocId,
} from './search-index-conformance-support';

/** Every page of `query`, followed to its end; a page past the entries there are is a failure. */
export const listAll = async (
  subject: SearchIndexSubject,
  query: Omit<SearchListQuery, 'after' | 'entity'>,
): Promise<readonly SearchListEntry[]> => {
  const entries: SearchListEntry[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = await subject.index.list({ ...query, entity: subject.entity, after });
    expect(page.entries.length).toBeLessThanOrEqual(query.limit);
    entries.push(...page.entries);
    if (page.next === null) return entries;
    after = page.next;
  }
  return expect.unreachable(`list never ended: ${entries.length} entries in 20 pages`);
};

const ids = (entries: readonly SearchListEntry[]) => entries.map((entry) => entry.id).sort();

export const SEARCH_INDEX_LIST_CHECKS: readonly SearchIndexCheck[] = [
  {
    name: "list pages one tenant's live documents: each once, none removed, none of another tenant",
    async run(subject) {
      await putSearchDocs(subject, [
        doc(subject.entity, 1, 'zebra'),
        doc(subject.entity, 2, 'quokka'),
        doc(subject.entity, 3, 'lantern'),
        doc(subject.entity, 4, 'harbour', { tenant: SEARCH_TENANT_B }),
      ]);
      const own: SearchScope = { entity: subject.entity, tenant: SEARCH_TENANT_A };
      await subject.drop(own, [searchDocId(2)]);
      await subject.index.remove(own, [searchDocId(2)], 2);
      const listed = await listAll(subject, { tenant: SEARCH_TENANT_A, limit: 1 });
      expect(ids(listed)).toEqual([searchDocId(1), searchDocId(3)]);
      expect(listed.length).toBe(2);
      for (const entry of listed) {
        expect(entry.tenant).toBe(SEARCH_TENANT_A);
        expect(Number.isFinite(entry.version)).toBe(true);
      }
      const other = await listAll(subject, { tenant: SEARCH_TENANT_B, limit: 10 });
      expect(other.map((entry) => [entry.tenant, entry.id])).toEqual([
        [SEARCH_TENANT_B, searchDocId(4)],
      ]);
    },
  },
  {
    name: "list naming no tenant pages every tenant's documents, each with its own tenant",
    async run(subject) {
      await putSearchDocs(subject, [
        doc(subject.entity, 1, 'zebra'),
        doc(subject.entity, 2, 'zebra', { tenant: SEARCH_TENANT_B }),
      ]);
      const every = subject.everyTenant ?? ((read) => read());
      const listed = await every(() => listAll(subject, { limit: 1 }));
      expect(listed.map((entry) => [entry.tenant, entry.id]).sort()).toEqual([
        [SEARCH_TENANT_A, searchDocId(1)],
        [SEARCH_TENANT_B, searchDocId(2)],
      ]);
    },
  },
];
