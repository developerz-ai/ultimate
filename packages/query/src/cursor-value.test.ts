// A cursor is JSON, and a sort key is whatever the column holds. This file is the seam between
// those two facts: what survives the round trip, what is refused before it is signed, and page two
// of a read ordered by each of them — because a key that decodes as the wrong TYPE compares as a
// string against a number and blanks the page rather than failing.

import { beforeEach, describe, expect, test } from 'bun:test';
import { configureCursorSigning, createContext, isUltimateError, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { reviveSortKey, serializeSortValue } from './cursor-value';
import { paginate } from './pagination';
import { query } from './query';
import { registerQuery, resetRegistry } from './registry';
import { from } from './source';

const ORG = '00000000-0000-4000-8000-000000000001';
const ctx = createContext({ actor: { ...userActor({ id: 'u1' }), permissions: ['feed:read'] } });

const roundTrip = (value: unknown): unknown =>
  reviveSortKey(JSON.parse(JSON.stringify([serializeSortValue(value)])))[0];

describe('a sort value survives the cursor as the type it went in as', () => {
  test('a Date comes back a Date, at the same instant', () => {
    const at = new Date('2026-02-01T00:00:00.000Z');
    const revived = roundTrip(at);
    expect(revived).toBeInstanceOf(Date);
    expect((revived as Date).getTime()).toBe(at.getTime());
  });

  test('a bigint comes back a bigint, not a TypeError', () => {
    expect(roundTrip(9007199254740993n)).toBe(9007199254740993n);
  });

  test('the scalars JSON already carries are untouched', () => {
    for (const value of ['b', 42, 0, true, false, null]) {
      expect(roundTrip(value)).toEqual(value);
    }
  });

  test('an absent column is NULL on both sides — one absence, not two', () => {
    expect(roundTrip(undefined)).toBe(null);
  });

  test('a value no cursor can carry is refused where it is minted, with a code', () => {
    for (const value of [{ a: 1 }, [1, 2], Number.NaN, Number.POSITIVE_INFINITY, Symbol('x')]) {
      let code = 'resolved';
      try {
        serializeSortValue(value);
      } catch (error) {
        code = isUltimateError(error) ? error.code : String(error);
      }
      expect(code).toBe('X_CURSOR_VALUE_UNSUPPORTED');
    }
  });
});

describe('page two of a read ordered by a non-JSON type', () => {
  interface Post {
    readonly id: string;
    readonly orgId: string;
    readonly createdAt: Date;
    readonly rank: bigint;
  }

  const at = (day: number): Date => new Date(Date.UTC(2026, 1, day));

  const posts: readonly Post[] = [
    { id: 'a', orgId: ORG, createdAt: at(1), rank: 9n },
    { id: 'b', orgId: ORG, createdAt: at(2), rank: 10n },
    { id: 'c', orgId: ORG, createdAt: at(3), rank: 100n },
  ];

  const feedOn = (name: string, column: 'createdAt' | 'rank') =>
    registerQuery(
      name,
      query({
        input: t.object({ orgId: t.uuid }),
        policy: can('feed:read'),
        sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }).orderBy(column),
      }),
    );

  beforeEach(() => {
    resetRegistry();
    configureCursorSigning('test-secret');
  });

  for (const column of ['createdAt', 'rank'] as const) {
    test(`ordered by ${column}, the decoded cursor returns the third row`, async () => {
      const feed = feedOn(`feed_${column}`, column);
      const first = await paginate(feed, { orgId: ORG }, { first: 2, ctx });
      expect(first.rows.map((row) => row.id)).toEqual(['a', 'b']);
      expect(first.endCursor).not.toBeNull();

      const second = await paginate(
        feed,
        { orgId: ORG },
        { first: 2, ctx, after: first.endCursor ?? '' },
      );
      expect(second.rows.map((row) => row.id)).toEqual(['c']);
    });
  }
});
