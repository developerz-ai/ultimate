// The search-index suite over the built-in `postgresSearchIndex` and a real Postgres
// (`TEST_DATABASE_URL`): a table the framework's own migration created, its generated `tsvector`
// kept by the server on every `store`, every query the repository's own `matches` read.

import { afterAll, beforeAll, describe } from 'bun:test';
import { ctxOf, runWithContext, serviceActor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { generateMigration, postgresClient, raw, sql, statementsOf } from '@ultimat3/db';
import {
  CROSS_TENANT_SCOPE,
  clearRegistry,
  crossTenant,
  entity,
  postgresSearchIndex,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { searchIndexConformance } from './search-index-conformance';
import type { SearchIndexSubject } from './search-index-conformance-support';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

afterAll(() => {
  clearRegistry();
});

const posts = entity('search_conformance_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable('A'),
    body: text().nullable().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

describe.skipIf(adminUrl === '')(testName('live', 'the built-in postgres search index'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_search_conformance' });
    const pool = postgresClient({ url: db.url, profile: { max: 2 } });
    client = pool;
    const migration = generateMigration({
      entities: [posts.$describe()],
      name: 'search conformance',
      now: new Date('2026-11-09T00:00:00.000Z'),
    });
    await pool.execute(raw(`drop table if exists "${posts.$table}" cascade`));
    for (const statement of statementsOf(migration.up)) await pool.execute(raw(statement));
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  const subject = async (): Promise<SearchIndexSubject> => {
    const pool = client as PostgresClient;
    await pool.execute(raw(`truncate "${posts.$table}"`));
    return {
      index: postgresSearchIndex({ client: pool }),
      entity: posts.$name,
      store: async (documents) => {
        for (const each of documents) {
          await pool.execute(sql`
            insert into search_conformance_posts (id, org_id, title, body)
            values (${each.id}, ${each.tenant}, ${each.fields['title'] ?? ''}, ${each.fields['body'] ?? null})
            on conflict (id) do update set title = excluded.title, body = excluded.body`);
        }
      },
      // `list` naming no tenant is every tenant's rows: the capability `reindex`'s sweep holds.
      everyTenant: (read) =>
        runWithContext(
          ctxOf({ actor: serviceActor({ id: 'reindex', scopes: [CROSS_TENANT_SCOPE] }) }),
          () => crossTenant('the search conformance suite lists every tenant', read),
        ),
      drop: async (scope, ids) => {
        for (const id of ids) {
          await pool.execute(
            sql`delete from search_conformance_posts where id = ${id} and org_id = ${scope.tenant}`,
          );
        }
      },
    };
  };

  behavesLike(searchIndexConformance, subject);
});
