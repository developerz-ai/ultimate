// The search-index suite over `@ultimat3/entity`'s memory index, and the proof it can fail: an
// index that drops the tenant from its key, and one that appends instead of replacing.

import { describe, expect, test } from 'bun:test';
import { memorySearchIndex } from '@ultimat3/entity';
import type { SearchIndex } from '@ultimat3/entity/adapter';
import { SEARCH_INDEX_ALL_CHECKS, searchIndexConformance } from './search-index-conformance';
import type { SearchIndexSubject } from './search-index-conformance-support';
import { searchDoc } from './search-index-conformance-support';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const subjectOver = (index: SearchIndex): SearchIndexSubject => ({
  index,
  entity: 'conformance_posts',
  store: async () => {},
  drop: async () => {},
});

describe(testName('unit', 'the memory search index'), () => {
  behavesLike(searchIndexConformance, () => subjectOver(memorySearchIndex()));
});

/** Indexes every document under tenant `null`: one scope for the whole app. */
const tenantBlind = (): SearchIndex => {
  const inner = memorySearchIndex();
  return {
    name: 'tenant-blind',
    index: (documents) => inner.index(documents.map((each) => ({ ...each, tenant: null }))),
    remove: (scope, ids, version) => inner.remove({ ...scope, tenant: null }, ids, version),
    query: (query) => inner.query({ ...query, tenant: null }),
  };
};

/** Keeps every text an id was ever indexed with: a re-index appends. */
const appending = (): SearchIndex => {
  const inner = memorySearchIndex();
  const seen = new Map<string, Record<string, string>>();
  return {
    name: 'appending',
    index: (documents) =>
      inner.index(
        documents.map((each) => {
          const before = seen.get(each.id) ?? {};
          const merged: Record<string, string> = { ...before };
          for (const [key, value] of Object.entries(each.fields)) {
            merged[key] = `${before[key] ?? ''} ${value}`;
          }
          seen.set(each.id, merged);
          return { ...each, fields: merged };
        }),
      ),
    remove: (scope, ids, version) => inner.remove(scope, ids, version),
    query: (query) => inner.query(query),
  };
};

/** Stamps every call with its own arrival order: the last call wins, whatever version it carried. */
const versionBlind = (): SearchIndex => {
  const inner = memorySearchIndex();
  let arrival = 0;
  return {
    name: 'version-blind',
    index: (documents) => {
      arrival += 1;
      const stamp = arrival;
      return inner.index(documents.map((each) => ({ ...each, version: stamp })));
    },
    remove: (scope, ids) => {
      arrival += 1;
      return inner.remove(scope, ids, arrival);
    },
    query: (query) => inner.query(query),
  };
};

const check = (prefix: string) => {
  const found = SEARCH_INDEX_ALL_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no search-index check named ${prefix}`);
  return found;
};

describe(testName('unit', 'an index that breaks the contract fails conformance'), () => {
  test('a tenant-blind index fails the tenant check, passes the word one', async () => {
    await check('an indexed document is found').run(subjectOver(tenantBlind()));
    await expect(
      check('a tenant is never answered').run(subjectOver(tenantBlind())),
    ).rejects.toThrow();
  });

  test('an appending index fails the replace check', async () => {
    await expect(check('indexing a newer version').run(subjectOver(appending()))).rejects.toThrow();
  });

  test('a version-blind index fails both stale-write checks', async () => {
    await expect(
      check('an older version indexed').run(subjectOver(versionBlind())),
    ).rejects.toThrow();
    await expect(
      check('a version indexed after the id was removed').run(subjectOver(versionBlind())),
    ).rejects.toThrow();
  });

  test('a non-finite version is refused where the suite builds its document', () => {
    expect(() => searchDoc('e', 1, 'zebra', { version: Number.NaN })).toThrow(/version is NaN/);
  });

  test('every check has a name of its own', () => {
    const names = SEARCH_INDEX_ALL_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
