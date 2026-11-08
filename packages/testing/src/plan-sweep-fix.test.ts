// From red nodes to the line an author pastes, over a real `entity()` declaration: the tenant leads
// only a statement that compares it, a unique key argues a node away, a sort's index makes the
// scan's redundant, and an index walk takes its order from the statement's `order by`.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, integer, invariant, text, timestamp, uuid } from '@ultimat3/entity';
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
    score: integer(),
    rank: integer(),
    createdAt: timestamp(),
  },
  invariants: (c) => [invariant('psf_slug_unique', c.unique(['slug']))],
  indexes: [
    { on: ['createdAt'], where: (c) => c.status.eq('pending') },
    { on: ['rank'] },
    { on: ['status', 'rank'] },
  ],
});
// Soft delete makes every unique rule partial: `where deleted_at is null`.
const psfMembers = entity('psf_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .tenant()
      .references(() => psfOrgs.id),
    handle: text({ max: 40 }),
    deletedAt: timestamp().nullable(),
  },
  invariants: (c) => [invariant('psf_handle_unique', c.unique(['orgId', 'handle']))],
});
const byTable = new Map<string, SeedEntity>([
  ['psf_posts', psfPosts],
  ['psf_members', psfMembers],
]);

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
      'select * from "psf_posts" where "score" = $1',
      [verdict({ equality: ['score'] })],
      byTable,
    );
    expect(finding?.index).toEqual(['score']);
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

  test('a walk an index already orders, filtered by a range, names the range column, not the order', () => {
    const walk = (equality: string[], range: string[]) =>
      verdict({ node: 'Index Scan', equality, range });
    const [crossTenant] = planFindings(
      'select "id" from "psf_posts" where "score" < $1 order by "id" limit 20',
      [walk([], ['score'])],
      byTable,
    );
    expect(crossTenant?.index).toEqual(['score']);
    const [tenant] = planFindings(
      'select "id" from "psf_posts" where "org_id" = $1 and "score" < $2 order by "id" limit 20',
      [walk(['org_id'], ['score'])],
      byTable,
    );
    expect(tenant?.index).toEqual(['orgId', 'score']);
  });

  test('a declared index leading with the range column serves the walk: no finding', () => {
    const statement = 'select "id" from "psf_posts" where "rank" < $1 order by "id" limit 20';
    expect(
      planFindings(statement, [verdict({ node: 'Index Scan', range: ['rank'] })], byTable),
    ).toEqual([]);
    const walk = (equality: string[]) => verdict({ node: 'Index Scan', equality, range: ['rank'] });
    expect(planFindings(statement, [walk(['status'])], byTable)).toEqual([]);
    // Not when the index leads with an equality the statement does not compare.
    expect(planFindings(statement, [walk(['org_id'])], byTable)).toHaveLength(1);
  });

  test('a partial unique pins one row when the statement states its predicate, as one() does', () => {
    const one =
      'select "id", "org_id", "handle", "deleted_at" from "psf_members" where "org_id" = $1 and "handle" = $2 and "deleted_at" is null order by "id" asc nulls last limit $3';
    const walk = verdict({
      node: 'Index Scan',
      table: 'psf_members',
      equality: ['org_id', 'handle'],
      range: ['deleted_at'],
    });
    expect(planFindings(one, [walk], byTable)).toEqual([]);
    // Without the predicate the rule does not hold: deleted rows share the handle.
    const unstated = one.replace(' and "deleted_at" is null', '');
    expect(planFindings(unstated, [{ ...walk, range: [] }], byTable).map((f) => f.index)).toEqual([
      ['orgId', 'handle', 'id'],
    ]);
  });

  test('a sort no declarable index serves suggests no index, and says why', () => {
    const [finding] = planFindings(
      'select * from "psf_posts" where "org_id" = $1 order by date_trunc(\'day\', "created_at") limit $2',
      [
        verdict({
          code: 'X_QUERY_SORT_UNSERVED',
          node: 'Sort',
          equality: ['org_id'],
          unservable: 'expression',
        }),
      ],
      byTable,
    );
    expect(finding).toMatchObject({ entity: 'psf_posts', index: [], unserved: 'expression' });
  });

  test('an index the entity already declares is never the fix: following it changes no plan', () => {
    const sorted = (equality: string[], order: string[]) =>
      planFindings(
        'select * from "psf_posts" where "status" = $1 order by "rank" limit $2',
        [verdict({ code: 'X_QUERY_SORT_UNSERVED', node: 'Sort', equality, order })],
        byTable,
      );
    expect(sorted(['status'], ['rank'])).toEqual([
      expect.objectContaining({ index: [], unserved: 'declared' }),
    ]);
    // A declared index that the suggestion leads is declared too: `rank` alone is held by it.
    expect(sorted([], ['rank'])).toEqual([expect.objectContaining({ unserved: 'declared' })]);
    // One the entity does not hold is still the fix.
    expect(sorted(['org_id'], ['rank'])).toEqual([
      expect.objectContaining({ index: ['orgId', 'rank'] }),
    ]);
    expect(sorted(['org_id'], ['rank'])[0]?.unserved).toBeUndefined();
  });

  test('an OR is answered one index per arm; arms an index already leads are not asked for', () => {
    const statement = 'select "id" from "psf_posts" where "score" = $1 or "rank" = $2';
    const found = planFindings(
      statement,
      [verdict({ arms: [['score'], ['rank']] })],
      byTable,
    );
    // `rank` leads a declared index; `score` leads none.
    expect(found.map((one) => one.index)).toEqual([['score']]);
    // Every arm led by a declared index is a BitmapOr the planner takes once it may: credited.
    expect(
      planFindings(statement, [verdict({ arms: [['rank'], ['status', 'rank']] })], byTable),
    ).toEqual([]);
  });

  test('an OR beside an equality is bounded by the equality: the arms are not the index', () => {
    const [finding] = planFindings(
      'select "id" from "psf_posts" where "created_at" = $1 and ("score" = $2 or "rank" = $3)',
      [verdict({ equality: ['created_at'], arms: [['score'], ['rank']] })],
      byTable,
    );
    expect(finding?.index).toEqual(['createdAt']);
  });

  test("a walk over a join takes only its own table's leading order, one direction", () => {
    const walk = verdict({ node: 'Index Scan', alias: 'p', equality: ['org_id'] });
    const [joined] = planFindings(
      'select p.id from psf_posts p join psf_members m on m.org_id = p.org_id where p.org_id = $1 order by p.created_at, m.handle, p.id limit 10',
      [walk],
      byTable,
    );
    expect(joined?.index).toEqual(['orgId', 'createdAt']);
    const [mixed] = planFindings(
      'select * from psf_posts where org_id = $1 order by created_at desc, id asc limit 10',
      [verdict({ node: 'Index Scan', equality: ['org_id'] })],
      byTable,
    );
    expect(mixed?.index).toEqual(['orgId', 'createdAt']);
  });
});
