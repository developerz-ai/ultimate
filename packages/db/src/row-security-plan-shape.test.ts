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
const PAGE = `select * from members where org_id = '${ORG}' order by role, created_at, id limit 51`;

describe('the tenant policy keeps a keyset page on its index', () => {
  const client = pgliteClient();
  afterAll(async () => {
    await client.close();
  });

  /** Every node type of the plan, depth first. */
  const nodesOf = (plan: unknown): string[] => {
    if (typeof plan !== 'object' || plan === null) return [];
    const node = plan as { 'Node Type'?: unknown; Plans?: unknown };
    const children = Array.isArray(node.Plans) ? node.Plans.flatMap(nodesOf) : [];
    return typeof node['Node Type'] === 'string' ? [node['Node Type'], ...children] : children;
  };

  const planAs = async (role: typeof APP_ROLE | typeof MIGRATOR_ROLE): Promise<string[]> => {
    await assumeRole(client, role);
    await client.execute(raw('begin'));
    try {
      await client.execute(raw(`select set_config('x.tenant', '${ORG}', true)`));
      const [row] = await client.query<{ 'QUERY PLAN': unknown }>(
        raw(`explain (format json) ${PAGE}`),
      );
      const document = row?.['QUERY PLAN'];
      const top = Array.isArray(document) ? (document[0] as { Plan?: unknown }).Plan : undefined;
      return nodesOf(top);
    } finally {
      await client.execute(raw('rollback'));
    }
  };

  test('50,000 rows over 20 orgs: the runtime role plans an ordered index scan, no sort', async () => {
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
    const runtime = await planAs(APP_ROLE);
    expect(runtime).not.toContain('Sort');
    expect(runtime.some((node) => node.startsWith('Index'))).toBe(true);
  }, 60_000);
});
