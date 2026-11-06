// From red nodes to the line an author pastes, over a real `entity()` declaration: the tenant leads
// only a statement that compares it, a unique key argues a node away, a sort's index makes the
// scan's redundant, and an index walk takes its order from the statement's `order by`.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import type { PlanVerdict } from './plan-oracle';
import { planFindings } from './plan-sweep-fix';
import type { SeedEntity } from './seed-graph-shape';

afterAll(() => clearRegistry());

const psfOrgs = entity('psf_orgs', { columns: { id: uuid().primaryKey() } });
const psfPosts = entity('psf_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .tenant()
      .references(() => psfOrgs.id),
    slug: text({ max: 40 }),
    status: text({ max: 10 }),
    createdAt: timestamp(),
  },
  invariants: (c) => [invariant('psf_slug_unique', c.unique(['slug']))],
  indexes: [{ on: ['createdAt'], where: (c) => c.status.eq('pending') }],
});
const byTable = new Map<string, SeedEntity>([['psf_posts', psfPosts]]);

const verdict = (over: Partial<PlanVerdict>): PlanVerdict => ({
  code: 'X_QUERY_UNINDEXED',
  node: 'Seq Scan',
  table: 'psf_posts',
  equality: [],
  range: [],
  order: [],
  ...over,
});

describe('unit · planFindings', () => {
  test('a tenant read leads with the tenant column, by property', () => {
    const [finding] = planFindings(
      'select * from "psf_posts" where "status" = $1 and "org_id" = $2',
      [verdict({ equality: ['status', 'org_id'] })],
      byTable,
    );
    expect(finding).toMatchObject({ entity: 'psf_posts', index: ['orgId', 'status'] });
  });

  test('a read across tenants is served by no index that leads with the tenant', () => {
    const [finding] = planFindings(
      'select * from "psf_posts" where "status" = $1',
      [verdict({ equality: ['status'] })],
      byTable,
    );
    expect(finding?.index).toEqual(['status']);
  });

  test('equality pinning a unique key reads one row: no finding', () => {
    const statement = 'select * from "psf_posts" where "slug" = $1 and "status" = $2 order by "id"';
    const walk = verdict({ node: 'Index Scan', equality: ['slug', 'status'] });
    expect(planFindings(statement, [walk], byTable)).toEqual([]);
    expect(
      planFindings(
        'select * from "psf_posts" where "id" = $1',
        [verdict({ equality: ['id'] })],
        byTable,
      ),
    ).toEqual([]);
  });

  test("a sort's index makes the same table's scan verdict redundant", () => {
    const found = planFindings(
      'select * from "psf_posts" where "org_id" = $1 order by "created_at" desc limit $2',
      [
        verdict({
          code: 'X_QUERY_SORT_UNSERVED',
          node: 'Sort',
          equality: ['org_id'],
          order: ['created_at'],
        }),
        verdict({ node: 'Index Scan', equality: ['org_id'] }),
      ],
      byTable,
    );
    expect(found.map((one) => [one.code, one.index])).toEqual([
      ['X_QUERY_SORT_UNSERVED', ['orgId', 'createdAt']],
    ]);
  });

  test("an index walk takes its order from the statement's outermost order by", () => {
    const [finding] = planFindings(
      'select * from "psf_posts" where "status" = $1 order by "org_id" asc nulls last, "id" asc limit $2',
      [verdict({ node: 'Index Scan', equality: ['status'] })],
      byTable,
    );
    expect(finding?.index).toEqual(['status', 'orgId', 'id']);
  });

  test('a table the sweep was not handed makes no finding', () => {
    expect(planFindings('select 1', [verdict({ table: 'elsewhere' })], byTable)).toEqual([]);
  });

  test('a partial index whose predicate the statement compares is credited; elsewhere it is not', () => {
    const statement =
      'select * from "psf_posts" where "status" = $1 order by "created_at" asc limit $2';
    const sort = (equality: string[]) =>
      verdict({ code: 'X_QUERY_SORT_UNSERVED', node: 'Sort', equality, order: ['created_at'] });
    expect(planFindings(statement, [sort(['status'])], byTable)).toEqual([]);
    expect(planFindings(statement, [sort(['org_id'])], byTable)).toHaveLength(1);
  });
});
