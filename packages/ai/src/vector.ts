// Vector storage and retrieval.
//
// The store interface is shaped for pgvector (one table, one index, SQL you can read), with
// an in-memory cosine implementation as the dev default. Hybrid search is first-class rather
// than an add-on because pure vector search loses on the queries users actually type: exact
// identifiers, error codes, product SKUs, and rare terms are precisely what embeddings blur.
// Reciprocal-rank fusion combines the two rankings without needing the two score scales to
// be comparable — which they never are.

import { cosine, tokenize } from './embeddings.ts';
import { AiNotImplementedError, VectorDimMismatchError } from './errors.ts';

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
}

export class MemoryVectorStore implements VectorStore {
  readonly name: string;
  readonly dimension: number;
  private readonly records = new Map<string, VectorRecord>();
  private readonly k1: number;
  private readonly b: number;

  constructor(input: MemoryVectorStoreInput) {
    this.name = input.name ?? 'memory';
    this.dimension = input.dimension;
    this.k1 = input.k1 ?? 1.2;
    this.b = input.b ?? 0.75;
  }

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.assertDimension(record.vector.length);
      this.records.set(record.id, record);
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

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  private candidates(filter?: MetadataFilter): readonly VectorRecord[] {
    const all = [...this.records.values()];
    if (filter === undefined) return all;
    return all.filter((record) =>
      Object.entries(filter).every(([key, value]) => record.metadata?.[key] === value),
    );
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

const byScoreDesc = (a: SearchHit, b: SearchHit): number => b.score - a.score;

/**
 * The pgvector-backed store. The DDL and queries are exposed as constants rather than hidden
 * behind a client, because an agent reading the generated SQL can debug an index choice
 * without a docs lookup — the same reason the framework uses SQL-transparent Drizzle.
 */
export class PgVectorStore implements VectorStore {
  readonly name: string;
  readonly dimension: number;

  constructor(input: { name: string; dimension: number }) {
    this.name = input.name;
    this.dimension = input.dimension;
  }

  /** `x db gen` emits this; here so the shape is reviewable next to the queries. */
  ddl(): string {
    return [
      `create table if not exists ${this.name} (`,
      `  id text primary key,`,
      `  embedding vector(${this.dimension}) not null,`,
      `  content text not null,`,
      `  metadata jsonb not null default '{}',`,
      `  tsv tsvector generated always as (to_tsvector('english', content)) stored`,
      `);`,
      `create index if not exists ${this.name}_embedding_idx`,
      `  on ${this.name} using hnsw (embedding vector_cosine_ops);`,
      `create index if not exists ${this.name}_tsv_idx on ${this.name} using gin (tsv);`,
    ].join('\n');
  }

  async upsert(_records: readonly VectorRecord[]): Promise<void> {
    throw this.notImplemented('upsert');
  }

  async search(): Promise<readonly SearchHit[]> {
    throw this.notImplemented('search');
  }

  async searchText(): Promise<readonly SearchHit[]> {
    throw this.notImplemented('searchText');
  }

  async hybrid(): Promise<readonly SearchHit[]> {
    throw this.notImplemented('hybrid');
  }

  async delete(_ids: readonly string[]): Promise<void> {
    throw this.notImplemented('delete');
  }

  private notImplemented(operation: string): AiNotImplementedError {
    return new AiNotImplementedError({
      feature: `PgVectorStore.${operation}`,
      fix: `x db migrate to create the "${this.name}" table, then set ai.vector.driver = 'pgvector' in app.config.ts`,
    });
  }
}
