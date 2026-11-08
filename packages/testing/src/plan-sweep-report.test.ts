// The sweeps as `x exercise` reports them: one finding per statement no index serves, naming every
// primitive that sent it and the `indexes:` line to paste; one per shape that grows with the rows;
// nothing for exempt, unplannable or unproven.

import { describe, expect, test } from 'bun:test';
import type { ExerciseRecord } from './exercise-report';
import type { PlanFinding } from './plan-sweep-fix';
import { planSweepFindings, planSweepLines } from './plan-sweep-report';

const STATEMENT = 'select "id" from "posts" where "author_id" = $1';
const unindexed: PlanFinding = {
  code: 'X_QUERY_UNINDEXED',
  statement: STATEMENT,
  node: 'Seq Scan',
  entity: 'posts',
  table: 'posts',
  index: ['authorId'],
};

const record = (name: string, over: Partial<ExerciseRecord> = {}): ExerciseRecord => ({
  kind: 'query',
  name,
  outcome: 'reached',
  statements: 1,
  effects: [],
  ms: 1,
  ...over,
});

const planned = (findings: readonly PlanFinding[]) => ({
  planned: 1,
  findings,
  exempt: [],
  unplannable: [],
});

describe('unit · planSweepFindings', () => {
  test('one finding per statement, every sender named, the index line in the fix', () => {
    const findings = planSweepFindings([
      record('authorPosts', { plans: planned([unindexed]) }),
      record('authorFeed', { plans: planned([unindexed]) }),
    ]);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding?.code).toBe('X_QUERY_UNINDEXED');
    expect(finding?.at).toBe('query authorPosts');
    expect(finding?.cause).toContain('query authorPosts, query authorFeed');
    expect(finding?.fix).toStartWith('x db gen posts-authorId-index');
    expect(finding?.fix).toContain('indexes: [{ on: [\'authorId\'] }] in entity("posts")');
    expect(finding?.fix).toContain("scan: '<why it stays small>'");
  });

  test('a sort finding names the order and offers no scan escape', () => {
    const [finding] = planSweepFindings([
      record('feed', {
        plans: planned([
          {
            ...unindexed,
            code: 'X_QUERY_SORT_UNSERVED',
            node: 'Sort',
            index: ['orgId', 'createdAt'],
          },
        ]),
      }),
    ]);
    expect(finding?.fix).toContain("on: ['orgId', 'createdAt']");
    expect(finding?.fix).not.toContain('scan:');
  });

  test('a read that compares no column offers no empty index: it is a scan to state', () => {
    const whole: PlanFinding = {
      ...unindexed,
      statement: 'select count(*) as count from "posts"',
      node: 'Index Only Scan',
      index: [],
    };
    const records = [record('postCount', { plans: planned([whole]) })];
    const [finding] = planSweepFindings(records);
    expect(finding?.code).toBe('X_QUERY_UNINDEXED');
    expect(finding?.fix).not.toContain('on: []');
    expect(finding?.fix).not.toContain('x db gen');
    expect(finding?.fix).toStartWith('x exercise postCount --json');
    expect(finding?.fix).toContain("expectedSeqScan('<why it reads every row>', fn)");
    expect(finding?.fix).toContain('scan: \'<why it stays small>\' in entity("posts")');
    expect(finding?.cause).toContain('compares no column');
    expect(planSweepLines(records)).toEqual([
      'query postCount · X_QUERY_UNINDEXED posts, every row (no column to index)',
    ]);
  });

  test('a shape that grows is X_QUERY_SCALES_WITH_ROWS, its counts in the cause', () => {
    const grows = record('listPosts', {
      scale: {
        verdict: 'grows',
        shapes: [{ fingerprint: 'users.findById', small: 2, large: 8 }],
        expected: [],
      },
    });
    const [finding] = planSweepFindings([grows]);
    expect(finding).toMatchObject({ code: 'X_QUERY_SCALES_WITH_ROWS', at: 'query listPosts' });
    expect(finding?.cause).toContain('2× at 2 rows a table and 8× at 8');
    expect(finding?.fix).toStartWith('x exercise listPosts --json');
    expect(planSweepLines([grows])).toEqual([
      'query listPosts · X_QUERY_SCALES_WITH_ROWS users.findById 2→8',
    ]);
  });

  test('flat, unproven, exempt and unplannable are never red', () => {
    expect(
      planSweepFindings([
        record('a', { scale: { verdict: 'flat', expected: [] } }),
        record('b', { scale: { verdict: 'unproven', reason: 'x' } }),
        record('c', {
          plans: {
            planned: 2,
            findings: [],
            exempt: [{ statement: STATEMENT, reason: 'a catalog' }],
            unplannable: [{ statement: 'select $1', reason: 'untyped' }],
          },
        }),
      ]),
    ).toEqual([]);
  });

  test('a name a shell would split is a placeholder in the rerun', () => {
    const [finding] = planSweepFindings([
      record('x; rm -rf /', {
        scale: {
          verdict: 'grows',
          shapes: [{ fingerprint: 'a', small: 1, large: 2 }],
          expected: [],
        },
      }),
    ]);
    expect(finding?.fix).toStartWith('x exercise <primitive> --json');
  });

  test('a sort no index serves offers no index: it says why, and the rewrite or the stated reason', () => {
    const unserved = (reason: PlanFinding['unserved']): PlanFinding => ({
      ...unindexed,
      code: 'X_QUERY_SORT_UNSERVED',
      node: 'Sort',
      index: [],
      ...(reason === undefined ? {} : { unserved: reason }),
    });
    const why = {
      expression: 'an expression',
      aggregate: 'an aggregate',
      derived: 'a subquery',
      tables: 'more than one table',
      directions: 'different directions',
    } as const;
    for (const [reason, phrase] of Object.entries(why)) {
      const records = [record('feed', { plans: planned([unserved(reason as keyof typeof why)]) })];
      const [finding] = planSweepFindings(records);
      expect(finding?.code).toBe('X_QUERY_SORT_UNSERVED');
      expect(finding?.cause).toContain(phrase);
      expect(finding?.cause).not.toContain('compares no column');
      expect(finding?.fix).not.toContain('x db gen');
      expect(finding?.fix).not.toContain('indexes:');
      expect(finding?.fix).toStartWith('x exercise feed --json');
      expect(finding?.fix).toContain('expectedSeqScan(');
      expect(planSweepLines(records)).toEqual([
        `query feed · X_QUERY_SORT_UNSERVED posts, no index serves it (${reason})`,
      ]);
    }
  });

  test('an index the entity already declares is never printed as the fix', () => {
    const [finding] = planSweepFindings([
      record('authorPosts', { plans: planned([{ ...unindexed, index: [], unserved: 'declared' }]) }),
    ]);
    expect(finding?.cause).toContain('already declares');
    expect(finding?.fix).not.toContain('x db gen');
    expect(finding?.fix).toContain('expectedSeqScan(');
  });

  test("an OR's arms are one finding each: one index per arm", () => {
    const arms = [
      { ...unindexed, index: ['authorId'] },
      { ...unindexed, index: ['title'] },
    ];
    const findings = planSweepFindings([record('search', { plans: planned(arms) })]);
    expect(findings.map((one) => one.fix.split('   #')[0])).toEqual([
      'x db gen posts-authorId-index',
      'x db gen posts-title-index',
    ]);
  });
});
