// The admin search box against a real Postgres, over an entity that declares `.searchable()`: the
// statement it sends is the handle's own full-text read, the planner serves its `@@` from the
// declared GIN index past `FLOOR_ROWS` (never a Seq Scan) when the sort is no btree's, and the
// rows are the ones a tenant-scoped, row-scoped search may see. Skips without TEST_DATABASE_URL.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import {
  type DbClient,
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  type SqlFragment,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { clearRegistry, database, entity, postgresDriver, text, uuid } from '@ultimat3/entity';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import type { CrudCtx } from './crud';
import type { AdminSort } from './registry';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';
import { adminSearch } from './search';

afterAll(() => {
  clearRegistry();
});

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

/**
 * The table size above which a Seq Scan for a selective term is the defect this file catches.
 * Measured 2026-11-15 on Postgres 17: at 20,000 rows the planner still prefers a Seq Scan + Sort
 * (correctly — the table is small); from 30,000 it takes the GIN bitmap. 50,000 is the margin.
 */
const FLOOR_ROWS = 50_000;
const ORG_A = '0190b000-0000-7000-8000-00000000000a';
const ORG_B = '0190b000-0000-7000-8000-00000000000b';

const members = entity('admin_tsv_live_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    name: text({ max: 80 }).searchable('A'),
    bio: text({ max: 400 }).searchable(),
  },
});
const TABLE = members.$table;

const actorOf = (orgId: string): AdminActor => ({ id: 'op', orgId });
const ctx = (orgId: string): CrudCtx => ({
  actor: actorOf(orgId),
  authz: staticAuthz(['admin:read', 'admin_tsv_live_members:read']),
  audit: memoryAuditLog(),
  requestId: 'req_tsv_live',
});
const as = <T>(orgId: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'op', roles: ['admin'], orgId }) }), run);

describe.skipIf(!hasPostgres)('live · postgres · admin search over search_tsv', () => {
  let client: PostgresClient;
  const sent: SqlFragment[] = [];
  /** The pool, with every statement the admin sends kept — the plan explained is the real one. */
  const recording = (): DbClient => ({
    query: async (fragment) => {
      sent.push(fragment);
      return client.query(fragment);
    },
    one: async (fragment) => {
      sent.push(fragment);
      return client.one(fragment);
    },
    execute: async (fragment) => {
      sent.push(fragment);
      return client.execute(fragment);
    },
  });

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    const migration = generateMigration({
      entities: [members.$describe()],
      name: 'admin search tsv live',
      now: new Date('2026-11-15T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    // FLOOR_ROWS of filler across two orgs, then the rows the assertions name.
    await client.execute(
      raw(`insert into "${TABLE}" ("id", "org_id", "name", "bio")
        select gen_random_uuid(), case when n % 2 = 0 then '${ORG_A}'::uuid else '${ORG_B}'::uuid end,
          'filler ' || n, 'nothing to see in row ' || n
        from generate_series(1, ${FLOOR_ROWS}) as n`),
    );
    await client.execute(
      raw(`insert into "${TABLE}" ("id", "org_id", "name", "bio") values
        (gen_random_uuid(), '${ORG_A}', 'Alice Zymurgist', 'brews beer'),
        (gen_random_uuid(), '${ORG_A}', 'Bob', 'a zymurgist by trade'),
        (gen_random_uuid(), '${ORG_A}', 'acme zymurgist', 'lowercase company'),
        (gen_random_uuid(), '${ORG_B}', 'Carol Zymurgist', 'the other tenant')`),
    );
    await client.execute(raw(`analyze "${TABLE}"`));
    setDbClient(recording());
  });

  afterAll(async () => {
    setDbClient(undefined);
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    await client.close();
  });

  type Rows = () => readonly { field: string; op: 'contains'; value: string }[];
  const resource = (rows?: Rows, defaultSort?: AdminSort) =>
    adminResource(members, {
      repo: adminRepoFor(members, database({ members }, { driver: postgresDriver() }).members),
      ...(rows === undefined ? {} : { rows }),
      ...(defaultSort === undefined ? {} : { defaultSort }),
    });

  /** The admin's OWN full-text statement, explained with its own binds — never a lookalike. */
  const vectorPlan = async (defaultSort: AdminSort): Promise<string> => {
    sent.length = 0;
    await as(ORG_A, () =>
      adminSearch({
        term: 'zymurgist',
        resources: [resource(undefined, defaultSort)],
        ctx: ctx(ORG_A),
      }),
    );
    const statement = sent.find((fragment) => fragment.text.includes('@@'));
    expect(statement).toBeDefined();
    const rows = await client.query<Record<string, string>>({
      text: `explain (costs off) ${statement?.text ?? ''}`,
      values: statement?.values ?? [],
    });
    return rows.map((row) => row['QUERY PLAN'] ?? '').join('\n');
  };

  test('a whole word answers from the vector, inside the actor’s tenant only', async () => {
    sent.length = 0;
    const found = await as(ORG_A, () =>
      adminSearch({ term: 'zymurgist', resources: [resource()], ctx: ctx(ORG_A) }),
    );
    expect(found.skipped).toEqual([]);
    expect(found.hits.map((hit) => hit.label).sort()).toEqual([
      'Alice Zymurgist',
      'Bob',
      'acme zymurgist',
    ]);
    expect(found.hits.every((hit) => hit.matchedField === 'search_tsv')).toBe(true);
    expect(sent.some((fragment) => fragment.text.includes('@@'))).toBe(true);
  });

  test('a declared row scope stays case-sensitive around the vector read', async () => {
    const scoped = resource(() => [{ field: 'name', op: 'contains', value: 'Zymurgist' }]);
    const found = await as(ORG_A, () =>
      adminSearch({ term: 'zymurgist', resources: [scoped], ctx: ctx(ORG_A) }),
    );
    expect(found.hits.map((hit) => hit.label)).toEqual(['Alice Zymurgist']);
  });

  test('a prefix the vector cannot match is still found by the contains fill', async () => {
    const found = await as(ORG_A, () =>
      adminSearch({ term: 'zymur', resources: [resource()], ctx: ctx(ORG_A) }),
    );
    expect(found.hits.map((hit) => hit.matchedField).sort()).toEqual(['bio', 'name', 'name']);
  });

  test(`past ${FLOOR_ROWS} rows the vector read is served by the GIN index, never a Seq Scan`, async () => {
    const plan = await vectorPlan({ field: 'name', direction: 'asc' });
    const gin = members.$indexes.find((index) => index.using === 'gin');
    expect(gin?.name).toBeDefined();
    expect(plan).toContain(gin?.name ?? '');
    expect(plan).toContain('Bitmap Index Scan');
    expect(plan).not.toContain('Seq Scan');
  });
});
