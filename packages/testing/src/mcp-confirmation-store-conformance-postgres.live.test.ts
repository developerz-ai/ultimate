// The MCP confirmation-store suite over `postgresConfirmationStore` and a real Postgres
// (`TEST_DATABASE_URL`): the open index, the conditional `decide` and the vote race, on a pool. The
// table is emptied before each check, because `purge` counts every row it deleted.

import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import type { McpConfirmationStore } from '@ultimat3/mcp';
import { postgresConfirmationStore } from '@ultimat3/mcp';
import { SQL_MCP_CONFIRMATIONS_TABLE } from '@ultimat3/mcp/schema';
import { mcpConfirmationStoreConformance } from './mcp-confirmation-store-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the postgres MCP confirmation store'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;
  let store: McpConfirmationStore | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_mcp_conf_conformance' });
    const pool = postgresClient({ url: db.url, role: 'web', profile: { max: 4 } });
    client = pool;
    for (const statement of SQL_MCP_CONFIRMATIONS_TABLE.split(';')) {
      if (statement.trim().length > 0) await pool.execute(raw(statement));
    }
    store = postgresConfirmationStore({ executor: dbExecutor(() => pool) });
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  behavesLike(mcpConfirmationStoreConformance, async () => {
    await (client as PostgresClient).execute(raw('truncate x_mcp_confirmations'));
    return store as McpConfirmationStore;
  });
});
