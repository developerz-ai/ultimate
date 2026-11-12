// `updateMany`'s driver-neutral half: what a batch of `{ id, patch }` is allowed to be before any
// driver sees it, and the in-memory judgement of the whole batch before any row of it lands.

import { afterAll, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { integer, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { invariant, MAX_ASSERTED_ROWS } from './invariants';
import { clearRegistry } from './registry';
import type { UpdateManyRow } from './repo';
import { judgeUpdateMany, updateManyPlan } from './update-many';

const posts = entity('update_many_posts', {
  columns: {
    id: uuid().primaryKey(),
    slug: text({ max: 40 }).unique(),
    excerpt: text().nullable(),
    rank: integer().default(0),
    deletedAt: timestamp().nullable(),
  },
});

const scoped = entity('update_many_scoped', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text() },
});

const ruled = entity('update_many_ruled', {
  columns: { id: uuid().primaryKey(), rank: integer() },
  invariants: (c) => [
    invariant(
      'rank_small',
      c.satisfies((rank) => rank < 100, ['rank']),
    ),
  ],
});

const joined = entity('update_many_joined', {
  columns: { postId: uuid(), tag: text(), weight: integer() },
  primaryKey: ['postId', 'tag'],
});

type Post = typeof posts.$row;

afterAll(() => clearRegistry());

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const post = (index: number, over: Partial<Post> = {}): Post => ({
  id: idAt(index),
  slug: `post-${index}`,
  excerpt: null,
  rank: index,
  deletedAt: null,
  ...over,
});

/** The code a refusal carries, or what the call did instead. */
const codeOf = (call: () => unknown): string => {
  try {
    call();
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : String(error);
  }
};

const fixOf = (call: () => unknown): string => {
  try {
    call();
    return '';
  } catch (error) {
    return isUltimateError(error) ? error.fix : '';
  }
};

const rows = (...entries: [number, Partial<Post>][]): UpdateManyRow<Post>[] =>
  entries.map(([index, patch]) => ({ id: idAt(index), patch }));

describe('updateManyPlan', () => {
  test('every row names the same columns: the plan lists them in declaration order', () => {
    const plan = updateManyPlan(
      posts,
      rows([1, { rank: 7, excerpt: 'a' }], [2, { excerpt: 'b', rank: 8 }]),
      undefined,
    );
    expect(plan.key).toBe('id');
    expect(plan.properties).toEqual(['excerpt', 'rank']);
    expect(plan.patches.map((each) => each.id)).toEqual([idAt(1), idAt(2)]);
  });

  test('no rows is a plan with nothing to send, not a refusal', () => {
    expect(updateManyPlan(posts, [], undefined).patches).toEqual([]);
  });

  test('a row naming a column another row does not is refused, naming both', () => {
    const call = () =>
      updateManyPlan(posts, rows([1, { rank: 7, excerpt: 'a' }], [2, { rank: 8 }]), undefined);
    expect(codeOf(call)).toBe('X_INVARIANT_VIOLATED');
    expect(fixOf(call)).toContain('updateMany');
    expect(fixOf(call)).toContain('excerpt');
  });

  test('a present undefined is absent: it makes the batch uneven, never a NULL', () => {
    const call = () =>
      updateManyPlan(posts, rows([1, { excerpt: 'a' }], [2, { excerpt: undefined }]), undefined);
    expect(codeOf(call)).toBe('X_INVARIANT_VIOLATED');
  });

  test('null is a value: a batch clearing a column on one row and setting it on another is even', () => {
    const plan = updateManyPlan(posts, rows([1, { excerpt: null }], [2, { excerpt: 'b' }]), {});
    expect(plan.properties).toEqual(['excerpt']);
  });

  test('patches naming nothing are X_PATCH_EMPTY', () => {
    expect(codeOf(() => updateManyPlan(posts, rows([1, {}], [2, {}]), undefined))).toBe(
      'X_PATCH_EMPTY',
    );
  });

  test('one id twice is refused — one statement cannot update one row twice', () => {
    const upper = idAt(1).toUpperCase();
    const call = () =>
      updateManyPlan(
        posts,
        [
          { id: idAt(1), patch: { rank: 1 } },
          { id: upper, patch: { rank: 2 } },
        ],
        undefined,
      );
    expect(codeOf(call)).toBe('X_INVARIANT_VIOLATED');
    expect(fixOf(call)).toContain('dedupe');
  });

  test('a composite primary key has no id to address: refused, naming updateWhere', () => {
    const call = () => updateManyPlan(joined, [{ id: idAt(1), patch: { weight: 1 } }], undefined);
    expect(codeOf(call)).toBe('X_INVARIANT_VIOLATED');
  });

  test('a value the column refuses is refused through the patch door', () => {
    const call = () => updateManyPlan(posts, rows([1, { slug: 'x'.repeat(41) }]), undefined);
    expect(codeOf(call)).not.toBe('resolved');
  });

  test('the scope carries the tenant; the match adds the ids', () => {
    const plan = runWithContext(ctxOf({ actor: userActor({ id: 'u1', orgId: idAt(900) }) }), () =>
      updateManyPlan(scoped, [{ id: idAt(1), patch: { title: 't' } }], undefined),
    );
    expect(plan.scope.where).toEqual([{ column: 'orgId', op: 'eq', value: idAt(900) }]);
    expect(plan.match.where).toContainEqual({ column: 'id', op: 'in', value: [idAt(1)] });
    expect(plan.match.where).toContainEqual({ column: 'orgId', op: 'eq', value: idAt(900) });
  });

  test('a patch handing a row to another tenant is refused before any row is written', () => {
    const call = () =>
      runWithContext(ctxOf({ actor: userActor({ id: 'u1', orgId: idAt(900) }) }), () =>
        updateManyPlan(scoped, [{ id: idAt(1), patch: { orgId: idAt(901) } }], undefined),
      );
    expect(codeOf(call)).toStartWith('X_TENANCY');
  });

  test('an app-only rule bounds the batch: every row of it is read back to be judged', () => {
    const many = Array.from({ length: MAX_ASSERTED_ROWS + 1 }, (_, index) => ({
      id: idAt(index),
      patch: { rank: 1 },
    }));
    expect(codeOf(() => updateManyPlan(ruled, many, undefined))).toBe('X_INVARIANT_VIOLATED');
    expect(updateManyPlan(ruled, many.slice(1), undefined).patches).toHaveLength(MAX_ASSERTED_ROWS);
  });
});

describe('judgeUpdateMany', () => {
  const key = (row: unknown): string => String((row as Post).id);

  test('each matched row takes its own patch, in matched order', () => {
    const plan = updateManyPlan(
      posts,
      rows([2, { excerpt: 'two' }], [1, { excerpt: 'one' }], [3, { excerpt: 'gone' }]),
      undefined,
    );
    const judged = judgeUpdateMany(posts, plan, [post(1), post(2)], [post(4)], key);
    expect(judged.map((row) => [row.id, row.excerpt, row.rank])).toEqual([
      [idAt(1), 'one', 1],
      [idAt(2), 'two', 2],
    ]);
  });

  test('a row matched under another spelling of its uuid still takes its patch', () => {
    const plan = updateManyPlan(
      posts,
      [{ id: idAt(1).toUpperCase(), patch: { rank: 50 } }],
      undefined,
    );
    expect(judgeUpdateMany(posts, plan, [post(1)], [], key).map((row) => row.rank)).toEqual([50]);
  });

  test('two results of one batch taking one unique value refuse the whole batch', () => {
    const plan = updateManyPlan(
      posts,
      rows([1, { slug: 'same' }], [2, { slug: 'same' }]),
      undefined,
    );
    expect(codeOf(() => judgeUpdateMany(posts, plan, [post(1), post(2)], [], key))).toBe(
      'X_DB_UNIQUE_VIOLATION',
    );
  });

  test('a result taking a value a row outside the batch holds is refused', () => {
    const plan = updateManyPlan(posts, rows([1, { slug: 'post-9' }]), undefined);
    expect(codeOf(() => judgeUpdateMany(posts, plan, [post(1)], [post(9)], key))).toBe(
      'X_DB_UNIQUE_VIOLATION',
    );
  });

  test('swapping two unique values inside one batch is legal: each row replaces itself', () => {
    const plan = updateManyPlan(
      posts,
      rows([1, { slug: 'post-2' }], [2, { slug: 'post-1' }]),
      undefined,
    );
    expect(judgeUpdateMany(posts, plan, [post(1), post(2)], [], key)).toHaveLength(2);
  });

  test('an app-only rule broken by one result refuses the batch', () => {
    const plan = updateManyPlan(
      ruled,
      [
        { id: idAt(1), patch: { rank: 5 } },
        { id: idAt(2), patch: { rank: 500 } },
      ],
      undefined,
    );
    const stored = [
      { id: idAt(1), rank: 1 },
      { id: idAt(2), rank: 2 },
    ];
    expect(codeOf(() => judgeUpdateMany(ruled, plan, stored, [], key))).toBe(
      'X_INVARIANT_VIOLATED',
    );
  });
});
