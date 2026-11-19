// The lsn a snapshot claims is the position its rows are AT LEAST as new as. Read after the rows, a
// commit landing between the two was claimed and missing: every change up to that lsn is then
// dropped as already folded, and the row never arrives.

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { from, type QueryPolicy, query, resetQueries, t } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { formatLsn } from './changefeed';
import type { JsonValue, LiveRow } from './json';
import { liveQueryDefinition } from './live-definition';

interface FeedRow extends LiveRow {
  readonly orgId: string;
}

const ROWS: FeedRow[] = [{ id: 'p1', orgId: 'o1' }];
const INPUT: JsonValue = { orgId: 'o1' };

const allowAll: QueryPolicy = {
  kind: 'allow',
  label: 'post:read',
  permissions: [],
  children: [],
  run: () => ({ allowed: true }),
};

describe('a snapshot claims the lsn from before its read', () => {
  beforeEach(() => resetQueries());

  test('a commit during the read is not claimed by the rows that missed it', async () => {
    let position = 1;
    const target = registerQuery(
      'lsnFeed',
      query({
        input: t.object({ orgId: t.string }),
        policy: allowAll,
        live: true,
        sql: ({ orgId }) =>
          from<FeedRow>('posts', async () => {
            // A commit lands while the rows are being read.
            position += 1;
            return ROWS;
          })
            .where({ orgId })
            .orderBy('id')
            .limit(50),
      }),
    );
    const definition = liveQueryDefinition(target, {
      ctx: ctxOf({ role: 'sync', buildId: 'build-1' }),
      lsn: () => formatLsn(position),
    });
    const result = await definition.snapshot({ input: INPUT, tenant: null });
    expect(result.lsn).toBe(formatLsn(1));
  });
});
