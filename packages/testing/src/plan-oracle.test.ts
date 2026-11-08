// The plan oracle over the plans probed 2026-11-06 on PGlite (Postgres 18.6) and the test-services
// Postgres 17 — both engines answered every one identically, node for node. Trimmed to the keys
// the oracle reads; each is the JSON `explain (format json)` answered under the sweep's settings.

import { describe, expect, test } from 'bun:test';
import type { PlanTableColumns } from './plan-oracle';
import { judgePlan, planRoot } from './plan-oracle';

const TABLES: PlanTableColumns = new Map([
  ['posts', new Set(['id', 'org_id', 'author_id', 'title', 'project_id', 'created_at'])],
  ['comments', new Set(['id', 'post_id'])],
  ['events', new Set(['id', 'org_id', 'post_id', 'seq'])],
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

// Probed 2026-11-08 on PGlite: a limited read over a join, sorted by the OUTER-listed table's
// expression. The first scan under the Sort is the other side; the sort key is not its columns.
const joined = (keys: string[]) =>
  limit(
    sort(keys, {
      'Node Type': 'Nested Loop',
      'Join Filter': '(p.id = e.post_id)',
      Plans: [
        { ...scan('Index Scan', 'events', { 'Index Cond': '(org_id = $1)' }), Alias: 'e' },
        {
          'Node Type': 'Materialize',
          Plans: [
            { ...scan('Index Scan', 'posts', { 'Index Cond': '(org_id = $1)' }), Alias: 'p' },
          ],
        },
      ],
    }),
  );

describe('unit · plan oracle, the sort is the table its key names', () => {
  test('a sort by an expression is attributed to its table and no index can serve it', () => {
    const plan = joined([
      "(date_trunc('milliseconds'::text, p.created_at)) DESC",
      'p.id DESC',
      'e.seq',
    ]);
    expect(judgePlan(answer(plan), TABLES)).toEqual([
      {
        code: 'X_QUERY_SORT_UNSERVED',
        node: 'Sort',
        table: 'posts',
        equality: ['org_id'],
        range: [],
        order: [],
        unservable: 'expression',
      },
    ]);
  });

  test("a sort by one table's plain columns names that table, even when it is not scanned first", () => {
    expect(judgePlan(answer(joined(['p.created_at DESC', 'p.id DESC'])), TABLES)).toEqual([
      {
        code: 'X_QUERY_SORT_UNSERVED',
        node: 'Sort',
        table: 'posts',
        equality: ['org_id'],
        range: [],
        order: ['created_at', 'id'],
      },
    ]);
  });

  test('a sort across two tables is served by no one index', () => {
    const [verdict] = judgePlan(answer(joined(['p.created_at DESC', 'e.seq DESC'])), TABLES);
    expect(verdict).toMatchObject({ table: 'posts', order: [], unservable: 'tables' });
  });

  test('a sort mixing directions is served by no index an entity can declare', () => {
    const one = (keys: string[]) =>
      judgePlan(
        answer(limit(sort(keys, scan('Index Scan', 'posts', { 'Index Cond': '(org_id = $1)' })))),
        TABLES,
      )[0];
    expect(one(['created_at DESC', 'id'])).toMatchObject({ order: [], unservable: 'directions' });
    expect(one(['created_at NULLS FIRST'])).toMatchObject({ unservable: 'directions' });
    // All one way, either way: a btree walks backwards.
    expect(one(['created_at DESC', 'id DESC'])).toMatchObject({ order: ['created_at', 'id'] });
    expect(one(['created_at DESC', 'id DESC'])?.unservable).toBeUndefined();
  });
});

describe('unit · plan oracle, what no single index serves', () => {
  test('a sort after an aggregate is served by no index: it says so', () => {
    // Probed 2026-11-08, PGlite and Postgres 17: `group by name order by min(a), name limit 10`.
    const plan = limit(
      sort(['(min(a))', 'name'], {
        'Node Type': 'Aggregate',
        Strategy: 'Hashed',
        'Group Key': ['name'],
        Plans: [scan('Index Scan', 'posts', { 'Index Cond': '(org_id = $1)' })],
      }),
    );
    expect(judgePlan(answer(plan), TABLES)).toEqual([
      expect.objectContaining({ table: 'posts', order: [], unservable: 'aggregate' }),
    ]);
  });

  test("a sort by a column of a table the sweep does not judge is not this table's", () => {
    const plan = limit(
      sort(['k.name'], {
        'Node Type': 'Nested Loop',
        Plans: [
          { ...scan('Index Scan', 'posts', { 'Index Cond': '(org_id = $1)' }), Alias: 'p' },
          { ...scan('Index Scan', 'kinds', { 'Index Cond': '(id = p.kind_id)' }), Alias: 'k' },
        ],
      }),
    );
    expect(judgePlan(answer(plan), TABLES)).toEqual([]);
  });

  test('a sort by a value no table holds is derived: no index on a table serves it', () => {
    const plan = limit(
      sort(['r.k'], {
        'Node Type': 'Subquery Scan',
        Alias: 'r',
        Plans: [scan('Index Scan', 'posts', { 'Index Cond': '(org_id = $1)' })],
      }),
    );
    expect(judgePlan(answer(plan), TABLES)).toEqual([
      expect.objectContaining({ table: 'posts', unservable: 'derived' }),
    ]);
  });

  test('an OR is its arms, never one composite: each arm is what an index answers', () => {
    // Probed 2026-11-08, both engines: no index on either column is a Seq Scan with this filter.
    const [verdict] = judgePlan(
      answer(scan('Seq Scan', 'posts', { Filter: '((author_id = $1) OR (title = $2))' })),
      TABLES,
    );
    expect(verdict).toMatchObject({ equality: [], range: [], arms: [['author_id'], ['title']] });
  });

  test('an arm keeps its own conjuncts; the AND around an OR still bounds the read', () => {
    const [verdict] = judgePlan(
      answer(
        scan('Seq Scan', 'posts', {
          Filter:
            '((org_id = $1) AND ((project_id IS NULL) OR ((author_id = $2) AND (created_at > $3))))',
        }),
      ),
      TABLES,
    );
    expect(verdict).toMatchObject({
      equality: ['org_id'],
      range: [],
      arms: [['project_id'], ['author_id', 'created_at']],
    });
  });

  test('an OR with an arm on no column of the table has no arms an index answers', () => {
    const [verdict] = judgePlan(
      answer(
        scan('Seq Scan', 'posts', {
          Filter: '((created_at < $1) OR (alternatives: SubPlan 1 or hashed SubPlan 2))',
        }),
      ),
      TABLES,
    );
    expect(verdict).toMatchObject({ equality: [], range: [] });
    expect(verdict?.arms).toBeUndefined();
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

  test('`IS NULL` pins a column as equality does; `IS NOT NULL` is a range', () => {
    // Probed 2026-11-07, PGlite: a lookup by a partial unique's key, under `order by id limit`.
    const [verdict] = judgePlan(
      answer(
        limit(
          scan('Index Scan', 'posts', {
            'Index Name': 'posts_pkey',
            Filter: '((project_id IS NULL) AND (org_id = $1) AND (title = $2))',
          }),
        ),
      ),
      TABLES,
    );
    expect(verdict?.equality).toEqual(['project_id', 'org_id', 'title']);
    expect(verdict?.range).toEqual([]);
    const [open] = judgePlan(
      answer(scan('Seq Scan', 'posts', { Filter: '(project_id IS NOT NULL)' })),
      TABLES,
    );
    expect(open).toMatchObject({ equality: [], range: ['project_id'] });
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
