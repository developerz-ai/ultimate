// The tenant proof's read half on its own: which marks a tenant is tainted by, that a mark B was
// handed is never a find, and that a mark nested anywhere in an output — a key included — is
// found by path, with no value in the path.

import { describe, expect, test } from 'bun:test';
import type { SeedCanary, SeedGraph, SeedRow } from './seed-graph-plan';
import { findTaint, huntedMarks, MIN_TAINT_ID_LENGTH, tenantTaint } from './tenant-canary';
import { testName } from './test-types';

const A = '0000000a-0000-7000-8000-000000000000';
const B = '0000000b-0000-7000-8000-000000000000';
const PLAN = '000000ff-0000-7000-8000-000000000000';
const POST_A = 'aaaaaaaa-0000-7000-8000-000000000001';
const FILE_A = 'aaaaaaaa-0000-7000-8000-000000000002';
const POST_B = 'bbbbbbbb-0000-7000-8000-000000000001';

const row = (entity: string, tenant: string | null, values: Record<string, unknown>): SeedRow => ({
  entity,
  table: entity,
  tenant,
  row: values,
});
const canary = (
  entity: string,
  tenant: string | null,
  key: Record<string, unknown>,
  marker: string,
  columns: readonly string[],
): SeedCanary => ({ entity, tenant, key, marker, columns });

const graph: SeedGraph = {
  seed: 1,
  tenants: [A, B],
  order: [],
  inserts: [
    row('plans', null, { id: PLAN }),
    row('orgs', A, { id: A }),
    row('posts', A, { id: POST_A, orgId: A, title: 'title-c0ffee0001' }),
    // A child with no tenant column, attributed to A through its parent.
    row('files', A, { id: FILE_A, postId: POST_A, kind: 'png' }),
    row('subscriptions', A, { orgId: A, planId: PLAN }),
    row('counters', A, { id: 7 }),
    row('posts', B, { id: POST_B, orgId: B, title: 'title-beef000001' }),
  ],
  updates: [],
  canaries: [
    canary('plans', null, { id: PLAN }, 'f1a9000001', []),
    canary('orgs', A, { id: A }, 'a0a0000001', []),
    canary('posts', A, { id: POST_A }, 'c0ffee0001', ['title']),
    canary('files', A, { id: FILE_A }, 'c0ffee0002', []),
    canary('subscriptions', A, { orgId: A, planId: PLAN }, 'c0ffee0003', []),
    canary('counters', A, { id: 7 }, 'c0ffee0004', []),
    canary('posts', B, { id: POST_B }, 'beef000001', ['title']),
  ],
};

describe(testName('unit', 'tenant canary'), () => {
  test('a tenant is tainted by its canaries in text and its own ids, children included', () => {
    const taint = tenantTaint(graph, A);
    expect(taint.rows.map((r) => r.entity)).toEqual([
      'orgs',
      'posts',
      'files',
      'subscriptions',
      'counters',
    ]);
    expect(taint.ids).toEqual([A, POST_A, FILE_A, `${A},${PLAN}`, '7']);
    expect([...taint.marks].sort()).toEqual([A, POST_A, FILE_A, 'c0ffee0001'].sort());
    // A canary no column carries is no mark: a uuid or enum column is tainted by its id alone.
    expect(taint.marks).not.toContain('c0ffee0002');
    // A shared row's id, even inside A's composite key, is nobody's taint; a short id neither.
    expect(taint.marks).not.toContain(PLAN);
    expect(String(7).length).toBeLessThan(MIN_TAINT_ID_LENGTH);
    expect(taint.marks).not.toContain(POST_B);
  });

  test('a canary nested anywhere in an output is found by its path, a key too', () => {
    const marks = tenantTaint(graph, A).marks;
    const output = {
      ok: true,
      page: { items: [{ id: POST_B }, { id: 'x', cover: `https://cdn.test/${FILE_A}.png` }] },
      byPost: new Map([[POST_A.toUpperCase(), 1]]),
      when: new Date(0),
      'not an identifier': ['TITLE-C0FFEE0001'],
    };
    expect(findTaint(output, 'output', marks)).toEqual([
      'output.page.items[1].cover',
      'output.byPost[*]:key',
      'output[*][0]',
    ]);
    expect(
      findTaint({ items: [{ id: POST_B, title: 'title-beef000001' }] }, 'output', marks),
    ).toEqual([]);
  });

  test('a mark B was handed is never a find: an echo of the input proves nothing', () => {
    const taint = tenantTaint(graph, A);
    const input = { postId: POST_A, orgId: A, filter: { tags: ['x'] } };
    const hunted = huntedMarks(taint, input);
    expect([...hunted].sort()).toEqual([FILE_A, 'c0ffee0001'].sort());
    expect(findTaint({ id: POST_A, orgId: A, ok: false }, 'output', hunted)).toEqual([]);
    // What B was not handed still counts, next to the echo.
    expect(findTaint({ id: POST_A, title: 'title-c0ffee0001' }, 'output', hunted)).toEqual([
      'output.title',
    ]);
  });

  test('a value that refers to itself is walked once, and no mark means no walk', () => {
    const loop: Record<string, unknown> = { title: 'title-c0ffee0001' };
    loop['self'] = loop;
    expect(findTaint(loop, 'output', ['c0ffee0001'])).toEqual(['output.title']);
    expect(findTaint(loop, 'output', [])).toEqual([]);
  });
});
