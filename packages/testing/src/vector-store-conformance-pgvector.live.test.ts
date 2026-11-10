// The vector-store suite over `postgresVectorStore()` and a real pgvector (`TEST_DATABASE_URL`):
// the memory run proves the checks, this one proves the statements meet them — the FTS regconfig,
// the RRF fusion and the `(tenant, id)` key included. One worker database, one table, applied once.

import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresVectorStore } from '@ultimat3/ai';
import { postgresVectorStore } from '@ultimat3/ai';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw, statementsOf } from '@ultimat3/db';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';
import { vectorStoreConformance } from './vector-store-conformance';
import { VECTOR_CONFORMANCE_DIMENSION } from './vector-store-conformance-checks';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the pgvector vector store'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;
  let store: PostgresVectorStore | undefined;

  // No pgvector is a FAILURE here, never a skip: the extension's absence is the server's, and a
  // suite that stood down for it would report green for the store that serves real traffic.
  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_vector_conformance' });
    client = postgresClient({ url: db.url });
    await client.execute(raw('create extension if not exists vector'));
    store = postgresVectorStore({
      name: 'conformance_docs',
      dimension: VECTOR_CONFORMANCE_DIMENSION,
      client,
    });
    for (const statement of statementsOf(store.ddl())) await client.execute(raw(statement));
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  behavesLike(vectorStoreConformance, () => store as PostgresVectorStore);
});
