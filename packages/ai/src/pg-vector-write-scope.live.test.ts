// `PostgresVectorStore` writes against a real pgvector, under an org request: an unbound store's
// `delete`/`prune`/`upsert` is refused before any statement reaches Postgres, and a tenant-bound
// one touches only its own rows. Without the refusal `deleteSql` compiled to `and true` and an
// org-A request deleted org-B's row sharing the id. Gated on `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { type PostgresClient, postgresClient, raw, statementsOf } from '@ultimat3/db';
import { hashEmbedder, normalizeVector } from './embeddings';
import { type PostgresVectorStore, postgresVectorStore } from './pg-vector';
import { indexDocument } from './rag';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'ai_live_write_scope';
const DROP = `drop table if exists "${TABLE}" cascade`;
const vec = (...values: number[]): Float32Array => normalizeVector(Float32Array.from(values));
const asOrgA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u-a', orgId: 'org-a' }) }), fn);

describe.skipIf(!hasPostgres)('live · pgvector · an unbound write in an org request', () => {
  let client: PostgresClient;
  let store: PostgresVectorStore;
  let available = false;

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    await client.execute(raw('create extension if not exists vector'));
    available = true;
    await client.execute(raw(DROP));
    store = postgresVectorStore({ name: TABLE, dimension: 4, client });
    for (const statement of statementsOf(store.ddl())) await client.execute(raw(statement));
  });

  afterAll(async () => {
    if (available) await client.execute(raw(DROP));
    await client.close();
  });

  const orgBRows = async (): Promise<readonly string[]> =>
    (await store.scoped({ tenant: 'org-b' }).search(vec(1, 0, 0, 0), 10)).map((hit) => hit.id);
  const tenants = async (): Promise<readonly string[]> =>
    (
      await client.query<{ tenant: string }>(
        raw(`select distinct "tenant" from "${TABLE}" order by 1`),
      )
    ).map((r) => r.tenant);

  test('delete, prune and upsert are refused and org-b keeps its rows', async () => {
    await store
      .scoped({ tenant: 'org-b' })
      .upsert([
        { id: 'doc-1', vector: vec(1, 0, 0, 0), text: 'B secret', metadata: { source: 'doc' } },
      ]);
    await asOrgA(async () => {
      for (const write of [
        () => store.delete(['doc-1']),
        () => store.prune({ source: 'doc' }, []),
        () => store.upsert([{ id: 'doc-9', vector: vec(0, 1, 0, 0), text: 'shared tenant' }]),
        () =>
          indexDocument({
            store,
            embedder: hashEmbedder({ dimension: 4 }),
            document: { id: 'doc', text: 'alpha beta' },
          }),
      ]) {
        await expect(write()).rejects.toMatchObject({ code: 'X_VECTOR_UNSCOPED' });
      }
    });
    expect(await orgBRows()).toEqual(['doc-1']);
    expect(await tenants()).toEqual(['org-b']);
  });

  test('a tenant-bound write touches only that tenant', async () => {
    await asOrgA(async () => {
      const orgA = store.scoped({ tenant: 'org-a' });
      await orgA.upsert([
        { id: 'doc-1', vector: vec(1, 0, 0, 0), text: 'A note', metadata: { source: 'doc' } },
      ]);
      await orgA.delete(['doc-1']);
      await orgA.upsert([
        { id: 'doc-1', vector: vec(1, 0, 0, 0), text: 'A note', metadata: { source: 'doc' } },
      ]);
      await orgA.prune({ source: 'doc' }, []);
      expect(await orgA.search(vec(1, 0, 0, 0), 10)).toEqual([]);
    });
    expect(await orgBRows()).toEqual(['doc-1']);
  });
});
