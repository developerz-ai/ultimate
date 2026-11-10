// What a diagnostic reads when `lock` runs on the Postgres driver: the lock statement names itself,
// and what the callback sends names its own call. What `lock` and `lockKey` MEAN in every driver is
// `@ultimat3/testing`'s `entityDriverConformance`; against real connections, `lock.live.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, subscribe, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;

const counters = entity('lp_counters', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    hits: integer(),
    deletedAt: timestamp().nullable(),
  },
});

const ORG_A = '00000000-0000-7000-8000-00000000000a';
const ID = '00000000-0000-7000-8000-000000000009';
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const { up } = generateMigration({ entities: [counters.$describe()], name: 'lock parity' });
  for (const statement of statementsOf(up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

const inOrg = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u', orgId }) }), work);

describe('unit · what a diagnostic reads', () => {
  test('the lock statement names itself; what the callback sends names its own call', async () => {
    const db = database({ counters }, { driver: postgresDriver() });
    await db.counters.insert({ id: ID, orgId: ORG_A, hits: 0, deletedAt: null });
    const seen: string[] = [];
    const offStatements = subscribe('db.statement', ({ payload: { attribution } }) => {
      if (attribution?.entity === 'lp_counters') seen.push(attribution.op);
    });
    try {
      await inOrg(ORG_A, () =>
        db.counters.lock(ID, (_row, tx) => db.counters.update(ID, { hits: 1 }, { tx })),
      );
      await inOrg(ORG_A, () => db.counters.lockKey('k', () => undefined));
    } finally {
      offStatements();
    }
    expect(seen).toEqual(['lock', 'update', 'lockKey']);
  });
});
