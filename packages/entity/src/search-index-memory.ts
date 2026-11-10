// `memorySearchIndex()`: the reference `SearchIndex` an adapter author copies, and the one a unit
// test installs. Words, case-folded, every query word required — NOT Postgres: no stemming, no
// stop words, no `websearch` operators — why `memoryDriver()` still refuses `.search()`. Newest
// version per id wins; tombstones live as long as the index (a reference and a test index only).

import type {
  SearchDocument,
  SearchHit,
  SearchIndex,
  SearchListEntry,
  SearchQuery,
  SearchScope,
} from './search-index';
import { searchLimitOf, searchListLimitOf } from './search-index';

/** Letters and digits in any script; everything else separates words. */
const WORD = /[\p{L}\p{N}]+/gu;

/** The distinct lower-cased words of `text`. */
export const searchWords = (text: string): readonly string[] => [
  ...new Set(text.toLocaleLowerCase('und').match(WORD) ?? []),
];

/** One id's newest state: its words, or `null` — the tombstone a `remove` leaves. */
interface Held {
  readonly id: string;
  readonly version: number;
  readonly words: ReadonlyMap<string, number> | null;
}

const countWords = (document: SearchDocument): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const text of Object.values(document.fields)) {
    for (const word of text.toLocaleLowerCase('und').match(WORD) ?? []) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
};

/** One key per `(entity, tenant)`: JSON, so no entity name can be spelled into another scope. */
const scopeKey = (scope: SearchScope): string => JSON.stringify([scope.entity, scope.tenant]);

export const memorySearchIndex = (): SearchIndex => {
  const scopes = new Map<string, Map<string, Held>>();
  /** Which tenant each scope key is, so `list` can walk one entity's scopes. */
  const scopeOwners = new Map<string, SearchScope>();
  const scopeOf = (scope: SearchScope): Map<string, Held> => {
    const key = scopeKey(scope);
    const found = scopes.get(key);
    if (found !== undefined) return found;
    const created = new Map<string, Held>();
    scopes.set(key, created);
    scopeOwners.set(key, { entity: scope.entity, tenant: scope.tenant });
    return created;
  };

  return {
    name: 'memory',
    index: async (documents, options) => {
      for (const document of documents) {
        const scope = scopeOf(document);
        const held = scope.get(document.id);
        // A committed write's row exists: it replaces the tombstone of an earlier delete.
        const replaces = options?.committed === true && held?.words === null;
        // Keep only newer: a reindex batch that read the row before a write — or before its
        // delete — arrives here after it, and must not put the old text back.
        if (!replaces && (held?.version ?? Number.NEGATIVE_INFINITY) >= document.version) {
          continue;
        }
        scope.set(document.id, {
          id: document.id,
          version: document.version,
          words: countWords(document),
        });
      }
    },
    remove: async (scope, ids, version) => {
      const held = scopeOf(scope);
      for (const id of ids) {
        // A remove older than what is held (a re-create after it) changes nothing.
        if ((held.get(id)?.version ?? Number.NEGATIVE_INFINITY) > version) continue;
        held.set(id, { id, version, words: null });
      }
    },
    // Ordered by `[tenant, id]` as JSON, which is also the cursor: a total order, stable across calls.
    list: async (query) => {
      const limit = searchListLimitOf(query);
      const entries: (SearchListEntry & { readonly at: string })[] = [];
      for (const [key, owner] of scopeOwners) {
        if (owner.entity !== query.entity) continue;
        if (query.tenant !== undefined && owner.tenant !== query.tenant) continue;
        for (const each of scopes.get(key)?.values() ?? []) {
          if (each.words === null) continue;
          const at = JSON.stringify([owner.tenant, each.id]);
          if (query.after !== null && at <= query.after) continue;
          entries.push({ tenant: owner.tenant, id: each.id, version: each.version, at });
        }
      }
      entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const page = entries.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.map(({ tenant, id, version }) => ({ tenant, id, version })),
        next: entries.length > limit && last !== undefined ? last.at : null,
      };
    },
    query: async (query: SearchQuery): Promise<readonly SearchHit[]> => {
      const limit = searchLimitOf(query);
      const words = searchWords(query.term);
      if (words.length === 0) return [];
      const held = scopes.get(scopeKey(query)) ?? new Map<string, Held>();
      const scored: { readonly id: string; readonly score: number }[] = [];
      for (const each of held.values()) {
        if (each.words === null) continue;
        let score = 0;
        for (const word of words) {
          const count = each.words.get(word) ?? 0;
          if (count === 0) {
            score = -1;
            break;
          }
          score += count;
        }
        if (score > 0) scored.push({ id: each.id, score });
      }
      // Best first; the id breaks a tie so the same index answers the same order every time.
      scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return scored.slice(0, limit).map(({ id }) => ({ id }));
    },
  };
};
