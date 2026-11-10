// The one case `eventBusConformance` (`@ultimat3/testing`) cannot force on Postgres: two events in
// ONE millisecond, the cursor's purged. A publish is stamped by the database, so the pair is
// inserted with a shared stamp — setup only; every assertion is the bus's `find`. Opt-in (`.job.`).

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { uuidV7 } from '@ultimat3/core';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import { postgresEventBus } from './events-pg';

let pg: EmbeddedPg;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

const AT_MS = Date.UTC(2026, 10, 9, 9, 0, 0);

/** An event stamped at exactly `AT_MS`, expiring in an hour. */
const insertAt = async (id: string): Promise<void> => {
  await pg.executor.query(
    `insert into x_job_events (id, name, payload, published_at, expires_at)
     values ($1, 'paid', '{}'::jsonb, to_timestamp($2 / 1000.0), now() + interval '1 hour')`,
    [id, AT_MS],
  );
};

test('a purged cursor still excludes the event before it in its millisecond, on Postgres', async () => {
  const bus = postgresEventBus({ executor: pg.executor });
  const [before, cursor, after] = [uuidV7(), uuidV7(), uuidV7()].sort();
  for (const id of [before, cursor, after]) await insertAt(id ?? '');

  expect((await bus.find('paid', undefined, AT_MS, cursor))?.id).toBe(after);
  await pg.executor.query('delete from x_job_events where id = any($1::uuid[])', [[cursor, after]]);
  // Was `before`: with the cursor's row gone, a looked-up cursor excluded nothing.
  expect(await bus.find('paid', undefined, AT_MS, cursor)).toBeUndefined();
  expect((await bus.find('paid', undefined, AT_MS))?.id).toBe(before);
});
