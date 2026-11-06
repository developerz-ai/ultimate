// The plan oracle over the plans probed 2026-11-06 on PGlite (Postgres 18.6) and the test-services
// Postgres 17 — both engines answered every one identically, node for node. Trimmed to the keys
// the oracle reads; each is the JSON `explain (format json)` answered under the sweep's settings.

import { describe, expect, test } from 'bun:test';
import type { PlanTableColumns } from './plan-oracle';
import { judgePlan, planRoot } from './plan-oracle';

const TABLES: PlanTableColumns = new Map([
  ['posts', new Set(['id', 'org_id', 'author_id', 'title', 'created_at'])],
  ['comments', new Set(['id', 'post_id'])],
]);

const scan = (type: string, table: string, extra: Record<string, unknown> = {}) => ({
  'Node Type': type,
  'Relation Name': table,
  Alias: table,
  ...extra,
});
const limit = (...plans: unknown[]) => ({ 'Node Type': 'Limit', Plans: plans });
const sort = (key: string[], ...plans: unknown[]) => ({
  'Node Type': 'Sort',
  'Sort Key': key,
  Plans: plans,
});
const answer = (plan: unknown) => [{ Plan: plan }];
const codes = (plan: unknown) => judgePlan(answer(plan), TABLES).map((v) => v.code);

describe('unit · plan oracle, the probed plans', () => {
  test('a tenant list on its index is served', () => {
    const plan = limit(
      scan('Index Scan', 'posts', {
        'Index Name': 'posts_org_created',
        'Index Cond': '(org_id = $1)',
      }),
    );
    expect(codes(plan)).toEqual([]);
  });

  test('a filter on an unindexed column is a seq scan, and names the column', () => {
    const [verdict] = judgePlan(
      answer(scan('Seq Scan', 'posts', { Filter: '(author_id = $1)' })),
      TABLES,
    );
    expect(verdict).toEqual({
      code: 'X_QUERY_UNINDEXED',
      node: 'Seq Scan',
      table: 'posts',
      equality: ['author_id'],
      range: [],
      order: [],
    });
  });

  test('an unindexed foreign key is a seq scan of the child', () => {
    expect(
      judgePlan(answer(scan('Seq Scan', 'comments', { Filter: '(post_id = $1)' })), TABLES),
    ).toEqual([expect.objectContaining({ table: 'comments', equality: ['post_id'] })]);
  });

  test('a limited read ordered by an unindexed column sorts', () => {
    const plan = limit(
      sort(['title'], scan('Index Scan', 'posts', { 'Index Cond': '(org_id = $1)' })),
    );
    expect(judgePlan(answer(plan), TABLES)).toEqual([
      {
        code: 'X_QUERY_SORT_UNSERVED',
        node: 'Sort',
        table: 'posts',
        equality: ['org_id'],
        range: [],
        order: ['title'],
      },
    ]);
  });

  test('a range on a column that is not the index lead sorts, named by its qualified key', () => {
    const plan = limit(
      sort(
        ['posts.created_at DESC'],
        scan('Index Scan', 'posts', { 'Index Cond': '(created_at > $1)' }),
      ),
    );
    expect(judgePlan(answer(plan), TABLES)).toEqual([
      expect.objectContaining({ code: 'X_QUERY_SORT_UNSERVED', order: ['created_at'] }),
    ]);
  });

  test('a lookup by primary key is served', () => {
    expect(codes(scan('Index Scan', 'posts', { 'Index Cond': '(id = $1)' }))).toEqual([]);
  });

  test('an update by key is served; a delete by an unindexed reference scans', () => {
    const modify = (...plans: unknown[]) => ({ 'Node Type': 'ModifyTable', Plans: plans });
    expect(codes(modify(scan('Index Scan', 'posts', { 'Index Cond': '(id = $1)' })))).toEqual([]);
    expect(codes(modify(scan('Seq Scan', 'comments', { Filter: '(post_id = $1)' })))).toEqual([
      'X_QUERY_UNINDEXED',
    ]);
  });

  test("a join's inner seq scan takes its key from the join condition", () => {
    const plan = {
      'Node Type': 'Hash Join',
      'Hash Cond': '(c.post_id = p.id)',
      Plans: [
        { ...scan('Seq Scan', 'comments'), Alias: 'c' },
        {
          'Node Type': 'Hash',
          Plans: [
            { ...scan('Index Only Scan', 'posts', { 'Index Cond': '(org_id = $1)' }), Alias: 'p' },
          ],
        },
      ],
    };
    expect(judgePlan(answer(plan), TABLES)).toEqual([
      expect.objectContaining({ table: 'comments', equality: ['post_id'] }),
    ]);
  });
});

describe('unit · plan oracle, the rules at their edges', () => {
  test('an index scan with no condition is a full read', () => {
    expect(codes(scan('Index Scan', 'posts'))).toEqual(['X_QUERY_UNINDEXED']);
  });

  test('an index scan with no condition under a limit stops early, unless a filter walks it on', () => {
    expect(codes(limit(scan('Index Scan', 'posts')))).toEqual([]);
    expect(codes(limit(scan('Index Scan', 'posts', { Filter: '(title ~~ $1)' })))).toEqual([
      'X_QUERY_UNINDEXED',
    ]);
  });

  test('a sort with no limit above it is not judged: every row is read anyway', () => {
    expect(
      codes(sort(['title'], scan('Index Scan', 'posts', { 'Index Cond': '(org_id = $1)' }))),
    ).toEqual([]);
  });

  test('a table the oracle was not handed is never judged', () => {
    expect(codes(scan('Seq Scan', 'x_jobs'))).toEqual([]);
  });

  test('an equality and a range on one table are told apart; a literal is no column', () => {
    const [verdict] = judgePlan(
      answer(
        scan('Seq Scan', 'posts', {
          Filter: "((author_id = $1) AND (created_at > $2) AND (title <> 'org_id'::text))",
        }),
      ),
      TABLES,
    );
    expect(verdict?.equality).toEqual(['author_id']);
    expect(verdict?.range).toEqual(['created_at', 'title']);
  });

  test('the answer is read as a string or as parsed JSON', () => {
    const plan = answer(scan('Seq Scan', 'posts'));
    expect(planRoot(JSON.stringify(plan))).toEqual(planRoot(plan));
    expect(judgePlan(JSON.stringify(plan), TABLES)).toHaveLength(1);
  });

  test('an answer with no plan judges nothing', () => {
    expect(judgePlan([], TABLES)).toEqual([]);
    expect(judgePlan({ nope: 1 }, TABLES)).toEqual([]);
  });
});
