// The production vector store: pgvector in the same Postgres as everything else, no second
// datastore. It is the only store that runs in front of real traffic, so it is the one place
// the tenant and policy envelope has to be un-bypassable — every statement it emits is built on
// `conditionsSql`, and the fusion happens in SQL rather than after the rows are already loaded.

import { finiteCount, finiteOption } from '@ultimat3/core';
import { type DbClient, db, type SqlFragment } from '@ultimat3/db';
import { VectorDimMismatchError } from './errors';
import {
  ddlSql,
  deleteSql,
  hybridSql,
  type PgHybridArgs,
  type PgVectorTable,
  searchSql,
  textSql,
  upsertSql,
} from './pg-vector-sql';
import type {
  HybridSearchInput,
  MetadataFilter,
  SearchHit,
  VectorRecord,
  VectorStore,
} from './vector';
import { narrowScope, tenantOf, UNSCOPED, type VectorScope } from './vector-scope';

export interface PgVectorStoreInput {
  /** The table. Also the store's name in errors, and the stem of every index name. */
  readonly name: string;
  readonly dimension: number;
  /** Defaults to the ambient `db()`, so a store inside `withTransaction` joins it. */
  readonly client?: DbClient | undefined;
  /** FTS `regconfig`. Changing it after `ddl()` has run needs a migration, not a restart. */
  readonly language?: string | undefined;
  /** The envelope this instance is bound to. `scoped()` is how request paths narrow it. */
  readonly scope?: VectorScope | undefined;
}

/** Named in every bound refusal here, matching `vector.ts`: one store contract, one subject. */
const HYBRID = 'hybrid search';

/** The row every statement projects. `metadata` arrives as jsonb; drivers differ on parsing it. */
interface HitRow {
  readonly id: string;
  readonly content: string;
  readonly metadata: unknown;
  readonly score: unknown;
}

export class PgVectorStore implements VectorStore {
  readonly name: string;
  readonly dimension: number;
  readonly scope: VectorScope;
  private readonly input: PgVectorStoreInput;
  private readonly target: PgVectorTable;

  constructor(input: PgVectorStoreInput) {
    this.input = input;
    this.name = input.name;
    this.dimension = input.dimension;
    this.scope = input.scope ?? UNSCOPED;
    this.target = {
      table: input.name,
      dimension: input.dimension,
      language: input.language ?? 'english',
    };
  }

  /** An app pastes this into migrations — no command emits it. Beside the queries so the index
   * choice is reviewable against the reads that depend on it. */
  ddl(): string {
    return ddlSql(this.target);
  }

  /**
   * A view of the same table through a narrower envelope. The unscoped store is the backfill
   * path; a request handler derives from it and can never widen back out.
   */
  scoped(scope: VectorScope): PgVectorStore {
    return new PgVectorStore({
      ...this.input,
      scope: narrowScope(this.name, this.scope, scope),
    });
  }

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    for (const record of records) this.assertDimension(record.vector.length);
    await this.client().execute(
      upsertSql(
        this.target,
        tenantOf(this.scope),
        records.map((record) => ({
          id: record.id,
          vector: record.vector,
          text: record.text,
          metadata: record.metadata ?? {},
        })),
      ),
    );
  }

  async search(
    vector: Float32Array,
    k: number,
    filter?: MetadataFilter,
  ): Promise<readonly SearchHit[]> {
    this.assertDimension(vector.length);
    // `k` is the statement's `limit` and reaches Postgres as a bound parameter, so a `NaN` is the
    // database's error to report rather than this store's — and a fractional one is an error there
    // too. Refused here instead, before a connection is taken, naming the argument the caller wrote.
    return this.run(
      searchSql(this.target, vector, { scope: this.scope, filter, k: finiteCount(HYBRID, 'k', k) }),
    );
  }

  async searchText(
    query: string,
    k: number,
    filter?: MetadataFilter,
  ): Promise<readonly SearchHit[]> {
    return this.run(
      textSql(this.target, query, { scope: this.scope, filter, k: finiteCount(HYBRID, 'k', k) }),
    );
  }

  async hybrid(input: HybridSearchInput): Promise<readonly SearchHit[]> {
    this.assertDimension(input.vector.length);
    // The same three bounds `MemoryVectorStore.hybrid` screens, and they have to be screened in
    // BOTH stores: `rrfK` lands in `1.0 / (rrfK + rank)`, Postgres has a float8 `NaN`, and it
    // sorts as the LARGEST value — so every fused score ties, the order collapses to the `id`
    // tiebreak, and the fusion this method exists for is gone with nothing raised anywhere.
    const k = finiteCount(HYBRID, 'k', input.k);
    const args: PgHybridArgs = {
      scope: this.scope,
      filter: input.filter,
      k,
      candidates: finiteCount(HYBRID, 'candidates', input.candidates ?? Math.max(k * 4, 20)),
      rrfK: finiteOption(HYBRID, 'rrfK', input.rrfK ?? 60),
    };
    return this.run(hybridSql(this.target, input.query, input.vector, args));
  }

  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client().execute(deleteSql(this.target, this.scope, ids));
  }

  private client(): DbClient {
    return this.input.client ?? db();
  }

  private async run(statement: SqlFragment): Promise<readonly SearchHit[]> {
    const rows = await this.client().query<HitRow>(statement);
    return rows.map(toHit);
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

function toHit(row: HitRow): SearchHit {
  return {
    id: row.id,
    score: Number(row.score),
    text: row.content,
    metadata: toMetadata(row.metadata),
  };
}

/** jsonb comes back parsed on Bun.SQL and as text on some pools. Accept both, invent neither. */
function toMetadata(value: unknown): Readonly<Record<string, string>> {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (typeof parsed !== 'object' || parsed === null) return {};
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (entry !== null && entry !== undefined) metadata[key] = String(entry);
  }
  return metadata;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
