// A small tenant on a large shared table gets `k` hits through the hnsw index. pgvector filters
// AFTER the scan, so without an iterative scan it returns the `ef_search` (40) nearest rows of the
// whole table and the tenant's share of them — usually none. Forced onto the index (no primary
// key, `enable_seqscan = off`), or the planner's exact path hides it. Gated on TEST_DATABASE_URL.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type DbConnection,
  type PostgresClient,
  postgresClient,
  raw,
  sql,
  withTransaction,
} from '@ultimat3/db';
import { normalizeVector } from './embeddings';
import { type PostgresVectorStore, postgresVectorStore } from './pg-vector';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const TABLE = 'ai_live_recall';

describe.skipIf(!hasPostgres)('live · pgvector · a small tenant on a large table', () => {
  let client: PostgresClient;
  let pinned: DbConnection;
  let store: PostgresVectorStore;

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    await client.execute(raw('create extension if not exists vector'));
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    store = postgresVectorStore({ name: TABLE, dimension: 4, client });
    for (const statement of store.ddl().split(';\n')) await client.execute(raw(statement));
    // The key would hand the planner an exact path for `tenant = $1`: dropped, so hnsw is the
    // only index that can answer the search — the plan a large production table takes.
    await client.execute(raw(`alter table "${TABLE}" drop constraint "${TABLE}_pkey"`));
    // 10,000 rows: 9,950 of tenant `big`, 50 of tenant `small`, every vector a point on the sphere.
    await client.execute(
      raw(`insert into "${TABLE}" ("tenant", "id", "embedding", "content")
           select case when i % 200 = 0 then 'small' else 'big' end, 'row-' || i,
             ('[' || sin(i)::text || ',' || cos(i)::text || ',' ||
                     sin(i * 3)::text || ',' || cos(i * 7)::text || ']')::vector,
             'row ' || i
           from generate_series(1, 10000) i`),
    );
    await client.execute(raw(`analyze "${TABLE}"`));
    pinned = await client.reserve();
    await pinned.execute(raw('set enable_seqscan = off'));
  }, 60_000);

  afterAll(async () => {
    pinned?.release();
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    await client.close();
  });

  const query = normalizeVector(Float32Array.from([1, 0.2, -0.3, 0.5]));

  test('search(k = 10) returns 10 for the small tenant', async () => {
    const small = postgresVectorStore({ name: TABLE, dimension: 4, client: pinned }).scoped({
      tenant: 'small',
    });
    const hits = await small.search(query, 10);
    expect(hits).toHaveLength(10);
  });

  test('hybrid(k = 10) fills its dense candidates for the small tenant too', async () => {
    const small = postgresVectorStore({ name: TABLE, dimension: 4, client: pinned }).scoped({
      tenant: 'small',
    });
    const hits = await small.hybrid({ query: 'nothing-matches-this', vector: query, k: 10 });
    expect(hits).toHaveLength(10);
  });

  test('the search is answered by the hnsw index, not a scan', async () => {
    const [plan] = await pinned.query<Record<string, unknown>>(
      sql`explain (format json) select "id" from ${raw(`"${TABLE}"`)}
          where "tenant" = ${'small'}
          order by "embedding" <=> ${'[1,0.2,-0.3,0.5]'}::vector limit 10`,
    );
    expect(JSON.stringify(plan)).toContain(`${TABLE}_embedding_idx`);
  });

  test('the recall setting ends with the search: the pinned session reads its default after', async () => {
    const [row] = await pinned.query<{ value: string | null }>(
      sql`select current_setting('hnsw.iterative_scan', true) as value`,
    );
    expect(row?.value ?? 'off').toBe('off');
  });

  test('inside a caller transaction: k hits, and the transaction reads its own value after', async () => {
    const seen = await withTransaction(
      async (tx) => {
        const small = postgresVectorStore({ name: TABLE, dimension: 4, client: pinned }).scoped({
          tenant: 'small',
        });
        const hits = await small.search(query, 10);
        const [row] = await tx.query<{ value: string | null }>(
          sql`select current_setting('hnsw.iterative_scan', true) as value`,
        );
        return { hits: hits.length, after: row?.value };
      },
      { client: pinned },
    );
    expect(seen).toEqual({ hits: 10, after: 'off' });
  });
});
