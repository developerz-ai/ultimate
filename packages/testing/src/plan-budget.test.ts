// The plan budget's reader and its error: JSON plans in, numbers and a refusal out. No database.

import { describe, expect, test } from 'bun:test';
import { PlanOverBudgetError } from './plan-budget-error';
import { overBudget, readPlanBudget } from './plan-budget-read';
import { testName } from './test-types';

const seqScan = { 'Node Type': 'Seq Scan', 'Relation Name': 'posts', 'Plan Rows': 5000 };
const sorted = {
  'Node Type': 'Limit',
  'Total Cost': 900.5,
  'Plan Rows': 10,
  Plans: [
    {
      'Node Type': 'Sort',
      'Plan Rows': 4000,
      'Sort Key': ['posts.created_at'],
      Plans: [seqScan],
    },
  ],
};

describe(testName('unit', 'readPlanBudget'), () => {
  test('reads the root cost and the largest sort, wherever it sits', () => {
    const plan = [{ Plan: sorted }];
    const read = readPlanBudget(plan);
    expect(read.totalCost).toBe(900.5);
    expect(read.sortRows).toBe(4000);
    expect(read.table).toBe('posts');
    expect(read.node).toBe('Sort');
  });

  test('takes the largest of several sorts and accepts the JSON text', () => {
    const plan = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Total Cost': 10,
          Plans: [
            { 'Node Type': 'Sort', 'Plan Rows': 7, Plans: [] },
            { 'Node Type': 'Sort', 'Plan Rows': 70, Plans: [] },
          ],
        },
      },
    ]);
    expect(readPlanBudget(plan).sortRows).toBe(70);
  });

  test('a plan with no sort reads zero sort rows, and names its root', () => {
    const read = readPlanBudget([{ Plan: { ...seqScan, 'Total Cost': 12 } }]);
    expect(read).toMatchObject({ totalCost: 12, sortRows: 0, node: 'Seq Scan', table: 'posts' });
  });

  test('an answer that is no plan is refused, never read as zero', () => {
    expect(() => readPlanBudget([{ nothing: true }])).toThrow(/Total Cost/);
  });
});

describe(testName('unit', 'overBudget'), () => {
  const read = readPlanBudget([{ Plan: sorted }]);
  test('red on either number, green on the boundary', () => {
    expect(overBudget(read, { maxCost: 900.5, maxSortRows: 4000 })).toBe(false);
    expect(overBudget(read, { maxCost: 900, maxSortRows: 4000 })).toBe(true);
    expect(overBudget(read, { maxCost: 900.5, maxSortRows: 3999 })).toBe(true);
  });
});

describe(testName('unit', 'PlanOverBudgetError'), () => {
  const read = readPlanBudget([{ Plan: sorted }]);
  test('carries the numbers, and names the index when one is known', () => {
    const error = new PlanOverBudgetError({
      read,
      budget: { maxCost: 100, maxSortRows: 10 },
      index: { entity: 'post', property: ['authorId', 'createdAt'] },
    });
    expect(error.code).toBe('X_QUERY_PLAN_OVER_BUDGET');
    expect(error.meta).toEqual({
      totalCost: 900.5,
      sortRows: 4000,
      node: 'Sort',
      table: 'posts',
    });
    expect(error.fix).toContain("indexes: [{ on: ['authorId', 'createdAt'] }]");
  });

  test('without an index the fix is analyze, never a guess', () => {
    const error = new PlanOverBudgetError({ read, budget: { maxCost: 100, maxSortRows: 10 } });
    expect(error.fix).toContain('analyze posts');
    expect(error.cause).toContain('900.5');
  });
});
