// The tenant policy must not cost a tenant's keyset page its index. With the policy written as
// `col = tenant OR cross = 'on'`, the planner multiplied the OR's guessed selectivity (~5%) into
// every row estimate, took a 2,500-row org for ~140 rows, and answered `where org_id = $1 order by
// role, created_at, id limit 51` with a bitmap scan and a sort, where a table with no policy gets
// the ordered index scan. Measured on PGlite (Postgres' planner), and on Postgres 17.

import { afterAll, describe, expect, test } from 'bun:test';
import { pgliteClient } from './pglite';
import { enableRowSecuritySql } from './row-security';
import { APP_ROLE, assumeRole, ensureRowSecurityRoles, MIGRATOR_ROLE } from './row-security-roles';
import { raw } from './sql';

const ORG = '00000000-0000-4000-8000-000000000015';
const ORDER = 'order by role, created_at, id limit 51';
/** The first page, the tenant as a literal. */
const FIRST_PAGE = `select * from members where org_id = '${ORG}' ${ORDER}`;
/** A continuation page as the runtime sends it: every value bound, a `(role, created_at, id)` cursor. */
const NEXT_PAGE = `select * from members where org_id = $1 and (role, created_at, id) > ($2, $3, $4) ${ORDER}`;

type PlanNode = { 'Node Type'?: string; 'Index Name'?: string; Plans?: PlanNode[] };

describe('the tenant policy keeps a keyset page on its index', () => {
  const client = pgliteClient();
  afterAll(async () => {
    await client.close();
  });

  /** Every node type of the plan, depth first. */
  const nodesOf = (node: PlanNode): string[] => [
    ...(node['Node Type'] === undefined ? [] : [node['Node Type']]),
    ...(node.Plans ?? []).flatMap(nodesOf),
  ];

  /** The runtime role's plan for `explained`, the tenant set, after `setup` in the same transaction. */
  const planOf = async (explained: string, setup: readonly string[] = []): Promise<PlanNode> => {
    await assumeRole(client, APP_ROLE);
    await client.execute(raw('begin'));
    try {
      await client.execute(raw(`select set_config('x.tenant', '${ORG}', true)`));
      for (const statement of setup) await client.execute(raw(statement));
      const [row] = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        raw(`explain (format json) ${explained}`),
      );
      return row?.['QUERY PLAN'][0].Plan ?? {};
    } finally {
      await client.execute(raw('rollback'));
    }
  };

  /** `Limit` straight over an ordered scan of `members_keyset`: nothing between them sorts the page. */
  const expectOrderedIndexPage = (plan: PlanNode): void => {
    expect(plan['Node Type']).toBe('Limit');
    const [scan] = plan.Plans ?? [];
    expect(scan?.['Node Type']).toMatch(/^Index (Only )?Scan$/);
    expect(scan?.['Index Name']).toBe('members_keyset');
    expect(nodesOf(plan).filter((node) => node.includes('Sort'))).toEqual([]);
  };

  test('50,000 rows over 20 orgs: first and bound continuation pages are ordered index scans, no sort', async () => {
    await ensureRowSecurityRoles(client);
    await assumeRole(client, MIGRATOR_ROLE);
    await client.execute(
      raw(`create table members (id uuid primary key default gen_random_uuid(), org_id uuid not null,
          role text not null, created_at timestamptz not null default now())`),
    );
    await client.execute(
      raw(`insert into members (org_id, role, created_at)
          select ('00000000-0000-4000-8000-0000000000' || lpad(((g % 20) + 10)::text, 2, '0'))::uuid,
                 (array['owner', 'admin', 'member', 'viewer'])[1 + (g % 4)],
                 timestamptz '2026-11-24' - make_interval(secs => g)
            from generate_series(1, 50000) g`),
    );
    await client.execute(
      raw('create index members_keyset on members (org_id, role, created_at, id)'),
    );
    await client.execute(raw('analyze members'));
    for (const statement of enableRowSecuritySql('members', 'org_id', 'uuid')) {
      await client.execute(raw(statement));
    }
    await client.execute(raw(`grant select on members to ${APP_ROLE}`));
    expectOrderedIndexPage(await planOf(FIRST_PAGE));
    // The generic plan — what a reused prepared statement runs — knows none of the bound values.
    try {
      const next = await planOf(`execute next_page('${ORG}', 'member', '2026-11-23', '${ORG}')`, [
        'set local plan_cache_mode = force_generic_plan',
        `prepare next_page(uuid, text, timestamptz, uuid) as ${NEXT_PAGE}`,
      ]);
      expectOrderedIndexPage(next);
    } finally {
      await client.execute(raw('deallocate all'));
    }
  }, 60_000);
});
