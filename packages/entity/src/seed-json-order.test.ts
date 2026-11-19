// A seed replay settles on a `json()` cell whatever key order it was written in: jsonb hands an
// object back in ITS order (shorter keys first), so a cell compared as text was `updated` on every
// boot — rewriting the row, a history version and a search version — on Postgres alone.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { type JsonValue, t } from '@ultimat3/schema';
import { text } from './columns';
import { json } from './columns-data';
import { type Driver, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import { defineSeed } from './seed';

const PGLITE_BOOT_MS = 30_000;

const tiers = entity('sjo_tiers', {
  columns: {
    slug: text({ max: 20 }).primaryKey(),
    // A record, so no schema re-orders the keys on the way in: the order is the author's.
    limits: json(t.record(t.json())),
  },
});

const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [tiers.$describe()],
    name: 'seed json order',
    now: new Date('2026-11-19T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

const tier = (limits: Record<string, JsonValue>) =>
  defineSeed('sjo_tier', async ({ upsert }) => {
    await upsert(tiers, { by: ['slug'] }, { slug: 'pro', limits });
  });

const drivers: readonly (readonly [string, () => Driver])[] = [
  ['memory', () => memoryDriver()],
  ['postgres (embedded)', () => postgresDriver()],
];

describe.each(drivers)('a seeded json() cell on %s', (_name, open) => {
  test('a json column written in any key order is skipped on replay', async () => {
    const driver = open();
    await client.execute(raw('delete from sjo_tiers'));
    const metrics = [];
    // Written seats-first; jsonb stores it max-first. The third run swaps the nested keys too.
    metrics.push(
      (await tier({ seats: 10, max: 5, inner: { zz: 1, a: [2, 1] } }).run({ driver })).metrics,
    );
    metrics.push(
      (await tier({ seats: 10, max: 5, inner: { zz: 1, a: [2, 1] } }).run({ driver })).metrics,
    );
    metrics.push(
      (await tier({ max: 5, inner: { a: [2, 1], zz: 1 }, seats: 10 }).run({ driver })).metrics,
    );
    // An array's order IS its value: a reordered one is a change.
    metrics.push(
      (await tier({ max: 5, inner: { a: [1, 2], zz: 1 }, seats: 10 }).run({ driver })).metrics,
    );
    expect(metrics).toEqual([
      { inserted: 1, updated: 0, skipped: 0 },
      { inserted: 0, updated: 0, skipped: 1 },
      { inserted: 0, updated: 0, skipped: 1 },
      { inserted: 0, updated: 1, skipped: 0 },
    ]);
  });
});
