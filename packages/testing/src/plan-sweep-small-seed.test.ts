// On a seed of a few rows the planner cannot tell two indexes apart by size: a partial index over
// `revoked_at is null` holds as few pages as the selective `token_hash` one, so the generic plan
// WALKS the partial index and filters `token_hash = $1` — a red `Index Scan` with no `Index Cond`,
// though at any volume Postgres probes `token_hash`. The statement compares a column a declared
// index leads by equality: the read is served, as a probe a join side could take already is.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient, raw } from '@ultimat3/db';
import { clearRegistry, entity, text, timestamp, uuid } from '@ultimat3/entity';
import type { PlanProof } from './plan-sweep';
import { sweepPlans } from './plan-sweep';
import { testName } from './test-types';

const pssTokens = entity('pss_tokens', {
  columns: {
    id: uuid().primaryKey(),
    tokenHash: text({ max: 64 }),
    userId: uuid(),
    revokedAt: timestamp().nullable(),
  },
  indexes: [{ on: ['tokenHash'] }, { on: ['userId'], where: (c) => c.revokedAt.isNull() }],
});
/** The same table with no index on `token_hash`: the walk there is a real gap. */
const pssBare = entity('pss_bare', {
  columns: {
    id: uuid().primaryKey(),
    tokenHash: text({ max: 64 }),
    userId: uuid(),
    revokedAt: timestamp().nullable(),
  },
  indexes: [{ on: ['userId'], where: (c) => c.revokedAt.isNull() }],
});

const DDL = [
  'create table pss_tokens (id uuid primary key, token_hash text not null, user_id uuid not null, revoked_at timestamptz)',
  'create index pss_tokens_token_hash_idx on pss_tokens (token_hash)',
  'create index pss_tokens_user_id_idx on pss_tokens (user_id) where (revoked_at is null)',
  'insert into pss_tokens select gen_random_uuid(), md5(i::text), gen_random_uuid(), null from generate_series(1, 3) i',
  'create table pss_bare (id uuid primary key, token_hash text not null, user_id uuid not null, revoked_at timestamptz)',
  'create index pss_bare_user_id_idx on pss_bare (user_id) where (revoked_at is null)',
];

let client: PgliteClient;
const sweep = async (statement: string): Promise<PlanProof | undefined> =>
  (
    await sweepPlans(client, new Map([[statement, { primitives: new Set(['liveToken']) }]]), [
      pssTokens,
      pssBare,
    ])
  ).get('liveToken');

beforeAll(async () => {
  client = pgliteClient();
  for (const statement of DDL) await client.execute(raw(statement));
}, 60_000);
afterAll(async () => {
  await client.close();
  clearRegistry();
});

describe(testName('unit', 'plan sweep · a small seed walks the smaller index'), () => {
  test('a read keyed by a declared index is served, whichever index the tiny plan walked', async () => {
    const proof = await sweep(
      'select * from pss_tokens where token_hash = $1 and revoked_at is null',
    );
    expect(proof).toMatchObject({ planned: 1, findings: [], unplannable: [] });
  }, 60_000);

  test('with no index on the key, the same walk is still red and names it', async () => {
    const proof = await sweep(
      'select * from pss_bare where token_hash = $1 and revoked_at is null',
    );
    expect(proof?.findings.map((one) => [one.code, one.index])).toEqual([
      ['X_QUERY_UNINDEXED', ['tokenHash']],
    ]);
  }, 60_000);
});
