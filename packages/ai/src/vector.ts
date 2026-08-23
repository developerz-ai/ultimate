// Vector storage and retrieval: the `VectorStore` contract and the in-memory dev store.
// `PgVectorStore` — the production path — implements this same contract in `pg-vector.ts`.
//
// The store interface is shaped for pgvector (one table, one index, SQL you can read), with
// an in-memory cosine implementation as the dev default. Hybrid search is first-class rather
// than an add-on because pure vector search loses on the queries users actually type: exact
// identifiers, error codes, product SKUs, and rare terms are precisely what embeddings blur.
// Reciprocal-rank fusion combines the two rankings without needing the two score scales to
// be comparable — which they never are.

import { cosine, tokenize } from './embeddings';
import { VectorDimMismatchError } from './errors';
import { NO_TENANT, narrowScope, scopeAdmits, UNSCOPED, type VectorScope } from './vector-scope';

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
  /** The tenant + policy envelope every statement carries. `UNSCOPED` on a fresh store. */
  readonly scope: VectorScope;
  /** A view of the same rows through a NARROWER envelope. It can only ever tighten. */
  scoped(scope: VectorScope): VectorStore;
  upsert(records: readonly VectorRecord[]): Promise<void>;
  search(vector: Float32Array, k: number, filter?: MetadataFilter): Promise<readonly SearchHit[]>;
  searchText(query: string, k: number, filter?: MetadataFilter): Promise<readonly SearchHit[]>;
  hybrid(input: HybridSearchInput): Promise<readonly SearchHit[]>;
  delete(ids: readonly string[]): Promise<void>;
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

/** A record plus the tenant it was written under — the in-memory twin of the `tenant` column. */
export interface StoredRecord extends VectorRecord {
  readonly tenant: string;
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
    this.scope = input.scope ?? UNSCOPED;
    this.records = input.records ?? new Map<string, StoredRecord>();
    this.k1 = input.k1 ?? 1.2;
    this.b = input.b ?? 0.75;
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
      this.records.set(`${tenant}\u0000${record.id}`, { ...record, tenant });
    }
  }

  async search(
    vector: Float32Array,
    k: number,
    filter?: MetadataFilter,
  ): Promise<readonly SearchHit[]> {
    this.assertDimension(vector.length);
    return this.candidates(filter)
      .map((record) => this.hit(record, cosine(vector, record.vector)))
      .sort(byScoreDesc)
      .slice(0, k);
  }

  /** BM25 over the stored text. Real lexical scoring, so a rare exact term actually wins. */
  async searchText(
    query: string,
    k: number,
    filter?: MetadataFilter,
  ): Promise<readonly SearchHit[]> {
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
        return this.hit(record, score);
      })
      .filter((hit) => hit.score > 0)
      .sort(byScoreDesc)
      .slice(0, k);
  }

  /**
   * Reciprocal-rank fusion. Each ranking contributes `1 / (rrfK + rank)`, so only ORDER
   * matters — the two score scales never have to be reconciled, and a document ranked first
   * by exact term match beats one that merely leads a flat vector ranking.
   */
  async hybrid(input: HybridSearchInput): Promise<readonly SearchHit[]> {
    const width = input.candidates ?? Math.max(input.k * 4, 20);
    const rrfK = input.rrfK ?? 60;
    const [dense, lexical] = await Promise.all([
      this.search(input.vector, width, input.filter),
      this.searchText(input.query, width, input.filter),
    ]);
    return fuse([dense, lexical], rrfK).slice(0, input.k);
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

/** Fuse ranked lists by reciprocal rank. Exported so a reranker can reuse it. */
export function fuse(rankings: readonly (readonly SearchHit[])[], rrfK = 60): readonly SearchHit[] {
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
  b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
