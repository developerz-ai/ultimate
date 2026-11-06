// `series` against a real Postgres: every zone case the PGlite parity file holds, under a session
// zone that is none of them — so a statement that dropped its zone argument answers in Auckland
// and fails here. Tenancy through the request's actor too. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import { BUCKET_CASES } from './time-bucket-fixture';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const hits = entity('series_live_hits', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), at: timestamp() },
});

const idAt = (suffix: number | string): string =>
  `00000000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;
const ORG_A = idAt('a');
const ORG_B = idAt('b');

afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · series', () => {
  let client: PostgresClient;
  const db = () => database({ hits }, { driver: postgresDriver() });

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl as string, profile: { max: 1 } });
    setDbClient(client);
    await client.execute(raw('drop table if exists series_live_hits cascade'));
    const { up } = generateMigration({ entities: [hits.$describe()], name: 'series live' });
    for (const statement of statementsOf(up)) await client.execute(raw(statement));
  });

  beforeEach(async () => {
    await client.execute(raw('delete from series_live_hits'));
    await client.execute(raw("set time zone 'Pacific/Auckland'"));
  });

  afterAll(async () => {
    await client.execute(raw('drop table if exists series_live_hits cascade'));
    setDbClient(undefined);
    await client.close();
  });

  for (const each of BUCKET_CASES) {
    test(each.name, async () => {
      await db().hits.insertAll(
        each.at.map((at, index) => ({ id: idAt(index + 1), orgId: ORG_A, at: new Date(at) })),
      );
      const points = await db()
        .hits.where({ orgId: ORG_A })
        .series({ on: 'at', unit: each.unit, timeZone: each.zone, value: 'count' });
      expect(points.map((point) => [point.bucket.toISOString(), point.value])).toEqual(
        each.want.map(([at, count]) => [at, count]),
      );
    });
  }

  test("a request's series counts its own tenant's rows only", async () => {
    await db().hits.insertAll([
      { id: idAt(1), orgId: ORG_A, at: new Date('2026-05-01T10:00:00.000Z') },
      { id: idAt(2), orgId: ORG_B, at: new Date('2026-05-01T10:00:00.000Z') },
      { id: idAt(3), orgId: ORG_B, at: new Date('2026-05-01T11:00:00.000Z') },
    ]);
    const points = await runWithContext(
      ctxOf({ actor: userActor({ id: 'u', orgId: ORG_B }) }),
      () => db().hits.series({ on: 'at', unit: 'day', timeZone: 'UTC', value: 'count' }),
    );
    expect(points.map((point) => point.value)).toEqual([2]);
  });
});
