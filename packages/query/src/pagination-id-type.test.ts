// Single responsibility: the keyset tiebreak keeps the id's TYPE. The cursor stringified it, and
// `isAfterKey` then compared a numeric id against a string — lexically, so `"10" < "7"` and a row
// tied on the sort key after id 7 was never served.

import { beforeEach, describe, expect, test } from 'bun:test';
import { configureCursorSigning, createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { paginate } from './pagination';
import { query } from './query';
import { registerQuery, resetRegistry } from './registry';
import { from } from './source';

interface Ranked {
  readonly id: number;
  readonly rank: number;
}

const ctx = createContext({ actor: { ...userActor({ id: 'u1' }), permissions: ['feed:read'] } });

const ranked = (rows: readonly Ranked[]) =>
  registerQuery(
    'rankedFeed',
    query({
      input: t.object({}),
      policy: can('feed:read'),
      sql: () => from<Ranked>('ranked', rows).orderBy('rank'),
    }),
  );

const walk = async (read: ReturnType<typeof ranked>): Promise<readonly number[]> => {
  const seen: number[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const answer = await paginate(
      read,
      {},
      { first: 1, ctx, ...(after === undefined ? {} : { after }) },
    );
    seen.push(...answer.rows.map((row) => row.id));
    if (!answer.hasNextPage || answer.endCursor === null) break;
    after = answer.endCursor;
  }
  return seen;
};

describe('integer ids tied on the sort key', () => {
  beforeEach(() => {
    resetRegistry();
    configureCursorSigning('test-secret');
  });

  test('three rows tied on rank are all served, one page at a time', async () => {
    const read = ranked([
      { id: 5, rank: 1 },
      { id: 10, rank: 1 },
      { id: 7, rank: 1 },
    ]);
    expect(await walk(read)).toEqual([5, 7, 10]);
  });

  test('a bigint id keeps its order too', async () => {
    interface Big {
      readonly id: bigint;
      readonly rank: number;
    }
    const rows: readonly Big[] = [
      { id: 5n, rank: 1 },
      { id: 10n, rank: 1 },
      { id: 7n, rank: 1 },
    ];
    const read = registerQuery(
      'bigFeed',
      query({
        input: t.object({}),
        policy: can('feed:read'),
        sql: () => from<Big>('big', rows).orderBy('rank'),
      }),
    );
    const seen: bigint[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const answer = await paginate(
        read,
        {},
        { first: 1, ctx, ...(after === undefined ? {} : { after }) },
      );
      seen.push(...answer.rows.map((row) => row.id));
      if (!answer.hasNextPage || answer.endCursor === null) break;
      after = answer.endCursor;
    }
    expect(seen).toEqual([5n, 7n, 10n]);
  });
});
