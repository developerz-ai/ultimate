// Vector storage and retrieval: the `VectorStore` contract and the in-memory dev store.
// `PgVectorStore` — the production path — implements this same contract in `pg-vector.ts`.
//
// The store interface is shaped for pgvector (one table, one index, SQL you can read), with
// an in-memory cosine implementation as the dev default. Hybrid search is first-class rather
// than an add-on because pure vector search loses on the queries users actually type: exact
// identifiers, error codes, product SKUs, and rare terms are precisely what embeddings blur.
// Reciprocal-rank fusion combines the two rankings without needing the two score scales to
// be comparable — which they never are.

import { finiteCount, finiteOption } from '@ultimat3/core';
import { cosine, tokenize } from './embeddings';
import { VectorDimMismatchError } from './errors';
import {
  assertTenantRead,
  NO_TENANT,
  narrowScope,
  scopeAdmits,
  UNBOUND,
  type VectorScope,
} from './vector-scope';

export interface VectorRecord {
  readonly id: string;
  readonly vector: Float32Array;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SearchHit {
  readonly id: string;
  readonly score: number;
  readonly text: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Exact-match metadata filter. Deliberately narrow — a query DSL is a second query language. */
export type MetadataFilter = Readonly<Record<string, string>>;

export interface HybridSearchInput {
  readonly query: string;
  readonly vector: Float32Array;
  readonly k: number;
  readonly filter?: MetadataFilter;
  /** Candidates pulled from each ranking before fusion. Wider = better recall, slower. */
  readonly candidates?: number;
  /** RRF damping. 60 is the value the original paper settled on; lower favours rank 1 more. */
  readonly rrfK?: number;
}

export interface VectorStore {
  readonly name: string;
  readonly dimension: number;
  /** The tenant + policy envelope every statement carries. `UNBOUND` on a fresh store. */
  readonly scope: VectorScope;
  /** A view of the same rows through a NARROWER envelope. It can only ever tighten. */
  scoped(scope: VectorScope): VectorStore;
  upsert(records: readonly VectorRecord[]): Promise<void>;
  search(vector: Float32Array, k: number, filter?: MetadataFilter): Promise<readonly SearchHit[]>;
  searchText(query: string, k: number, filter?: MetadataFilter): Promise<readonly SearchHit[]>;
  hybrid(input: HybridSearchInput): Promise<readonly SearchHit[]>;
  delete(ids: readonly string[]): Promise<void>;
  /**
   * Delete every row `filter` matches EXCEPT the ids in `keep`, inside this store's scope. What a
   * re-index needs: `indexDocument` upserts a document's new chunks, then prunes the ones the
   * shorter text no longer produced. Required: an optional `prune` was a re-index that silently
   * left the old tail retrievable on any store that skipped it.
   */
  prune(filter: MetadataFilter, keep: readonly string[]): Promise<void>;
}

export interface MemoryVectorStoreInput {
  readonly name?: string;
  readonly dimension: number;
  /** BM25 term-frequency saturation. */
  readonly k1?: number;
  /** BM25 length normalisation. */
  readonly b?: number;
  readonly scope?: VectorScope;
  /**
   * Shared row storage — how `scoped()` returns a VIEW of the same rows rather than a copy.
   * Passing your own is a test seam, not an API: two stores sharing a map see each other.
   */
  readonly records?: Map<string, StoredRecord>;
}

/** Named in every bound refusal below, so a caller knows which call it is about to edit. */
const SUBJECT = 'MemoryVectorStore';

/** The same subject for the hybrid read, whose options are the caller's per-call arguments. */
const HYBRID = 'hybrid search';

/** A record plus the tenant it was written under — the in-memory twin of the `tenant` column. */
export interface StoredRecord extends VectorRecord {
  readonly tenant: string;
}

/** The row's primary key, `(tenant, id)` as the pg table declares it. NUL never occurs in a tenant. */
const storageKey = (tenant: string, id: string): string => `${tenant}\u0000${id}`;

/** A row and its score inside one ranking, before the tenant is dropped from the public hit. */
interface Scored {
  readonly record: StoredRecord;
  readonly score: number;
}

export class MemoryVectorStore implements VectorStore {
  readonly name: string;
  readonly dimension: number;
  readonly scope: VectorScope;
  private readonly input: MemoryVectorStoreInput;
  private readonly records: Map<string, StoredRecord>;
  private readonly k1: number;
  private readonly b: number;

  constructor(input: MemoryVectorStoreInput) {
    this.input = input;
    this.name = input.name ?? 'memory';
    this.dimension = input.dimension;
    this.scope = input.scope ?? UNBOUND;
    this.records = input.records ?? new Map<string, StoredRecord>();
    // Screened, not clamped: a `NaN` here makes every BM25 score `NaN`, `hit.score > 0` reads
    // false for every document, and `searchText` answers an empty list — zero work reported as a
    // successful search. `finiteOption` and not `finiteCount`, because both are tuning constants
    // and fractional by nature (1.2 and 0.75 are the values the BM25 paper settled on).
    this.k1 = finiteOption(SUBJECT, 'k1', input.k1 ?? 1.2);
    this.b = finiteOption(SUBJECT, 'b', input.b ?? 0.75);
  }

  /**
   * Same envelope, same rule as `PgVectorStore.scoped`. The dev store enforces it too, because
   * a tenant leak that only reproduces against production Postgres is a leak nobody finds.
   */
  scoped(scope: VectorScope): MemoryVectorStore {
    return new MemoryVectorStore({
      ...this.input,
      records: this.records,
      scope: narrowScope(this.name, this.scope, scope),
    });
  }

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    const tenant = this.scope.tenant ?? NO_TENANT;
    for (const record of records) {
      this.assertDimension(record.vector.length);
      this.records.set(storageKey(tenant, record.id), { ...record, tenant });
    }
  }

  async search(
    vector: Float32Array,
    k: number,
    filter?: MetadataFilter,
  ): Promise<readonly SearchHit[]> {
    assertTenantRead(this.name, this.scope);
    this.assertDimension(vector.length);
    // `k` carries no default, so `??` never sees it and nothing else does either: `slice(0, NaN)`
    // is `[]`, which is a search that answers "no matches" for every query and reports success.
    return this.dense(vector, finiteCount(SUBJECT, 'k', k), filter).map(({ record, score }) =>
      this.hit(record, score),
    );
  }

  /** BM25 over the stored text. Real lexical scoring, so a rare exact term actually wins. */
  async searchText(
    query: string,
    k: number,
    filter?: MetadataFilter,
  ): Promise<readonly SearchHit[]> {
    assertTenantRead(this.name, this.scope);
    return this.lexical(query, finiteCount(SUBJECT, 'k', k), filter).map(({ record, score }) =>
      this.hit(record, score),
    );
  }

  /**
   * Reciprocal-rank fusion. Each ranking contributes `1 / (rrfK + rank)`, so only ORDER
   * matters — the two score scales never have to be reconciled, and a document ranked first
   * by exact term match beats one that merely leads a flat vector ranking.
   *
   * Fused on the stored `(tenant, id)`, as `hybridSql` groups: an unscoped read sees every
   * tenant's rows, and two tenants may share an id. Fusing on the id alone summed both rows'
   * ranks into whichever came first and dropped the other. `fuse` keys on `SearchHit.id`, so the
   * rankings reach it under the row's storage key and leave under the caller's id again.
   */
  async hybrid(input: HybridSearchInput): Promise<readonly SearchHit[]> {
    assertTenantRead(this.name, this.scope);
    this.assertDimension(input.vector.length);
    // Three bounds, none of which `Math.max` screens — it PROPAGATES a `NaN`. A `NaN` `k` collapses
    // both candidate widths and the final slice to `[]`; a `NaN` `rrfK` makes every fused score
    // `NaN`, and the ranking this method exists to produce becomes whatever order the sort left.
    const k = finiteCount(HYBRID, 'k', input.k);
    const width = finiteCount(HYBRID, 'candidates', input.candidates ?? Math.max(k * 4, 20));
    const rrfK = finiteOption(HYBRID, 'rrfK', input.rrfK ?? 60);
    const rows = new Map<string, StoredRecord>();
    const keyed = (ranking: readonly Scored[]): readonly SearchHit[] =>
      ranking.map(({ record, score }) => {
        const key = storageKey(record.tenant, record.id);
        rows.set(key, record);
        return { ...this.hit(record, score), id: key };
      });
    const fused = fuse(
      [
        keyed(this.dense(input.vector, width, input.filter)),
        keyed(this.lexical(input.query, width, input.filter)),
      ],
      rrfK,
    );
    // Re-sorted once the ids are the caller's again: the tie-break is `d."id" asc`, never the key.
    return fused
      .map((hit) => ({ ...hit, id: rows.get(hit.id)?.id ?? hit.id }))
      .sort(byScoreDesc)
      .slice(0, k);
  }

  /** The cosine ranking `search` answers and `hybrid` fuses, rows still carrying their tenant. */
  private dense(vector: Float32Array, k: number, filter?: MetadataFilter): readonly Scored[] {
    return this.candidates(filter)
      .map((record) => ({ record, score: cosine(vector, record.vector) }))
      .sort(byRankDesc)
      .slice(0, k);
  }

  /** BM25 over the stored text, rows still carrying their tenant. Only a positive score matches. */
  private lexical(query: string, width: number, filter?: MetadataFilter): readonly Scored[] {
    const candidates = this.candidates(filter);
    if (candidates.length === 0) return [];
    const docs = candidates.map((record) => ({ record, tokens: tokenize(record.text) }));
    const avgLength = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length;
    const terms = [...new Set(tokenize(query))];

    return docs
      .map(({ record, tokens }) => {
        let score = 0;
        for (const term of terms) {
          const tf = tokens.filter((t) => t === term).length;
          if (tf === 0) continue;
          const df = docs.filter((d) => d.tokens.includes(term)).length;
          const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
          const norm = this.k1 * (1 - this.b + (this.b * tokens.length) / avgLength);
          score += idf * ((tf * (this.k1 + 1)) / (tf + norm));
        }
        return { record, score };
      })
      .filter((scored) => scored.score > 0)
      .sort(byRankDesc)
      .slice(0, width);
  }

  /** Scoped and filtered, exactly like `pruneSql`: everything `filter` matches but `keep`. */
  async prune(filter: MetadataFilter, keep: readonly string[]): Promise<void> {
    const kept = new Set(keep);
    for (const record of this.candidates(filter)) {
      if (kept.has(record.id)) continue;
      for (const [key, stored] of this.records) if (stored === record) this.records.delete(key);
    }
  }

  /** Scoped, exactly like the SQL `delete ... where id in (...) and <scope>`. */
  async delete(ids: readonly string[]): Promise<void> {
    const wanted = new Set(ids);
    for (const [key, record] of this.records) {
      if (!wanted.has(record.id)) continue;
      if (!scopeAdmits(this.scope, record.tenant, record.metadata ?? {})) continue;
      this.records.delete(key);
    }
  }

  private candidates(filter?: MetadataFilter): readonly StoredRecord[] {
    return [...this.records.values()].filter((record) => {
      const metadata = record.metadata ?? {};
      if (!scopeAdmits(this.scope, record.tenant, metadata)) return false;
      return Object.entries(filter ?? {}).every(([key, value]) => metadata[key] === value);
    });
  }

  private hit(record: VectorRecord, score: number): SearchHit {
    return { id: record.id, score, text: record.text, metadata: record.metadata ?? {} };
  }

  private assertDimension(received: number): void {
    if (received !== this.dimension) {
      throw new VectorDimMismatchError({
        store: this.name,
        expected: this.dimension,
        received,
      });
    }
  }
}

/**
 * The one way to build the in-process store — the twin of `postgresVectorStore()`. The class is a
 * type in the barrel only (`X_FACTORY_NAME_SPELLING`), so `new` is never a second spelling.
 */
export function memoryVectorStore(input: MemoryVectorStoreInput): MemoryVectorStore {
  return new MemoryVectorStore(input);
}

/**
 * Fuse ranked lists by reciprocal rank. Exported so a reranker can reuse it — which is why the
 * damping is screened HERE too and not only in `hybrid`: a default parameter is a bound like any
 * other, and `1 / (NaN + rank)` scores every document `NaN`, so the fused order is no longer a
 * ranking while every caller still reads a full result list.
 */
export function fuse(
  rankings: readonly (readonly SearchHit[])[],
  rrfK: number = 60,
): readonly SearchHit[] {
  finiteOption('fuse', 'rrfK', rrfK);
  const scores = new Map<string, number>();
  const hits = new Map<string, SearchHit>();
  for (const ranking of rankings) {
    ranking.forEach((hit, index) => {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (rrfK + index + 1));
      if (!hits.has(hit.id)) hits.set(hit.id, hit);
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ ...(hits.get(id) as SearchHit), score }))
    .sort(byScoreDesc);
}

/**
 * Score descending, then id ascending — the second key is `pg-vector-sql.ts`'s
 * `order by f.score desc, d."id" asc`, and the two have to agree or the developer machine and the
 * deployed app return different pages of the same search. Ties are the COMMON case in RRF: two
 * documents that swap rank between the dense and the lexical list score identically, and a stable
 * sort then resolves them by dense-list insertion order, which no SQL engine reproduces.
 */
const byScoreDesc = (a: SearchHit, b: SearchHit): number =>
  byScore(a.score, b.score) || byId(a.id, b.id);

/** The same order over a ranking's rows, which still carry their tenant. */
const byRankDesc = (a: Scored, b: Scored): number =>
  byScore(a.score, b.score) || byId(a.record.id, b.record.id);

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Descending, `NaN` last. A cosine against a zero-norm vector is `NaN`, and float8 orders `NaN`
 * above every number, so pg's `order by distance` puts that row at the end. `b - a` alone is `NaN`
 * for any pair holding one, which reads as a tie and leaves the sort inconsistent.
 */
function byScore(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1;
  return b - a;
}
