import { describe, expect, test } from 'bun:test';
import type { ChangeEvent } from './matcher';
import { match } from './matcher';
import type { QueryShape } from './shape';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly createdAt: number;
}

const shape: QueryShape = {
  entity: 'posts',
  filters: [{ column: 'orgId', op: '=', value: 'org-1' }],
  orderBy: [{ column: 'createdAt', direction: 'asc' }],
  limit: 3,
  unsupported: [],
};

const rows: readonly Post[] = [
  { id: 'a', orgId: 'org-1', createdAt: 10 },
  { id: 'b', orgId: 'org-1', createdAt: 20 },
];

const insert = (row: Post): ChangeEvent<Post> => ({ entity: 'posts', op: 'insert', row });

describe('incremental matcher', () => {
  test('an insert that enters the set produces an add at the right position', () => {
    const patches = match('feed', shape, rows, insert({ id: 'c', orgId: 'org-1', createdAt: 15 }));
    expect(patches).toEqual([
      { kind: 'add', position: 1, row: { id: 'c', orgId: 'org-1', createdAt: 15 } },
    ]);
  });

  test('an insert that misses the filter produces nothing', () => {
    const patches = match('feed', shape, rows, insert({ id: 'c', orgId: 'org-2', createdAt: 15 }));
    expect(patches).toEqual([]);
  });

  test('an insert into a full window evicts the tail', () => {
    const full: readonly Post[] = [...rows, { id: 'c', orgId: 'org-1', createdAt: 30 }];
    const patches = match('feed', shape, full, insert({ id: 'd', orgId: 'org-1', createdAt: 5 }));
    expect(patches.map((patch) => patch.kind)).toEqual(['add', 'remove']);
    expect(patches[0]).toMatchObject({ position: 0 });
    expect(patches[1]).toMatchObject({ id: 'c' });
  });

  test('an update that leaves the filter removes and asks for a refill', () => {
    const patches = match('feed', shape, rows, {
      entity: 'posts',
      op: 'update',
      row: { id: 'b', orgId: 'org-2', createdAt: 20 },
    });
    expect(patches).toEqual([
      { kind: 'remove', position: 1, id: 'b' },
      { kind: 'refill', from: 2 },
    ]);
  });

  test('an update that only changes a non-ordering column patches in place', () => {
    const patches = match('feed', shape, rows, {
      entity: 'posts',
      op: 'update',
      row: { id: 'a', orgId: 'org-1', createdAt: 10 },
    });
    expect(patches).toEqual([
      { kind: 'update', position: 0, row: { id: 'a', orgId: 'org-1', createdAt: 10 } },
    ]);
  });

  test('another entity never touches this result set', () => {
    const patches = match('feed', shape, rows, {
      entity: 'comments',
      op: 'insert',
      row: { id: 'z', orgId: 'org-1', createdAt: 1 },
    });
    expect(patches).toEqual([]);
  });

  test('an unsupported shape throws X_MATCHER_UNSUPPORTED instead of guessing', () => {
    const aggregate: QueryShape = { ...shape, unsupported: ['group by'] };
    let code: unknown;
    try {
      match('feed', aggregate, rows, insert({ id: 'c', orgId: 'org-1', createdAt: 15 }));
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_MATCHER_UNSUPPORTED');
  });
});
