// What every search-index check shares: the subject, the suite's ids and tenants, one document
// builder (version 1 unless a check says otherwise), stored-then-indexed, and the sorted hit ids.

import { finiteOption } from '@ultimat3/core';
import type { SearchDocument, SearchIndex, SearchScope } from '@ultimat3/entity/adapter';

export interface SearchIndexSubject {
  readonly index: SearchIndex;
  /** A searchable entity with `title` and `body` searchable columns and a tenant column. */
  readonly entity: string;
  /** Writes (upserts) each document's source row; a no-op for an index holding its own copy. */
  store(documents: readonly SearchDocument[]): Promise<void>;
  /** Deletes the source rows of `ids` under `scope`; a no-op for an index holding its own copy. */
  drop(scope: SearchScope, ids: readonly string[]): Promise<void>;
}

export interface SearchIndexCheck {
  readonly name: string;
  run(subject: SearchIndexSubject): Promise<void>;
}

export const SEARCH_TENANT_A = '00000000-0000-7000-8000-00000000a0a0';
export const SEARCH_TENANT_B = '00000000-0000-7000-8000-00000000b0b0';

/** A uuid-shaped id, so a uuid-keyed table holds the suite's rows. */
export const searchDocId = (n: number): string =>
  `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export interface SearchDocOptions {
  readonly body?: string;
  readonly tenant?: string;
  /** The row's version (its `onUpdateNow()` instant, epoch ms). Default 1. */
  readonly version?: number;
}

/** One suite document: tenant A, version 1, unless the check says otherwise. */
export const searchDoc = (
  entity: string,
  n: number,
  title: string,
  options: SearchDocOptions = {},
): SearchDocument => ({
  entity,
  tenant: options.tenant ?? SEARCH_TENANT_A,
  id: searchDocId(n),
  version: finiteOption('searchDoc', 'version', options.version ?? 1),
  fields: options.body === undefined ? { title } : { title, body: options.body },
});

/** Stored then indexed — the order a write hook and `reindex` both keep. */
export const putSearchDocs = async (
  subject: SearchIndexSubject,
  documents: readonly SearchDocument[],
) => {
  await subject.store(documents);
  await subject.index.index(documents);
};

export const searchIds = async (
  subject: SearchIndexSubject,
  term: string,
  tenant = SEARCH_TENANT_A,
) =>
  (await subject.index.query({ entity: subject.entity, tenant, term })).map((hit) => hit.id).sort();
