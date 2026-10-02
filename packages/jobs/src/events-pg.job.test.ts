// The stored event bus on a real Postgres: ONE clock. `published_at` and `expires_at` were bound
// from the PUBLISHER's process clock, and a consumer compared them with its own — so two pods a
// few seconds apart disagreed about whether an answer came before or after the question. Opt-in
// (`.job.`): booting Postgres costs seconds.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import type { EventBus } from './events';
import { createPgEventBus } from './events-pg';

let pg: EmbeddedPg;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

/**
 * A bus built by a pod whose process clock is `skewMs` off the database's. The option is refused
 * by the TYPE — there is no clock to hand this bus — and handed over anyway, which is how these
 * cases were written against the bus that did read one: every one of them failed on it.
 */
const busOnAPodSkewedBy = (at: number, skewMs: number): EventBus =>
  createPgEventBus({
    executor: pg.executor,
    // @ts-expect-error — `PgEventBusOptions` has no `clock`: every instant is the database's.
    clock: frozenClock(at + skewMs),
  });

const databaseNow = async (): Promise<number> => {
  const rows = await pg.executor.query<{ now: number | string }>(
    'select floor(extract(epoch from now()) * 1000)::bigint as now',
    [],
  );
  return Number(rows[0]?.now);
};

describe('the stored event bus keeps one clock', () => {
  test('a publisher whose clock is 30 s behind still answers a question asked "now"', async () => {
    const at = await databaseNow();
    // The web pod that publishes believes it is half a minute EARLIER than the database does.
    // Until 2026-10-01 its belief was what the row was stamped with.
    const publisher = busOnAPodSkewedBy(at, -30_000);
    // The worker that asks: its own clock is irrelevant, it reads the bus's.
    const consumer = busOnAPodSkewedBy(at, 45_000);

    const askedAt = await consumer.now();
    expect(askedAt).toBe(at);
    const event = await publisher.publish('otp', { code: 1 }, { ttl: 60_000 });

    // Stamped by the database, whatever the publisher's process believes the time is.
    expect(event.publishedAt).toBe(at);
    expect(event.expiresAt).toBe(at + 60_000);
    expect(await consumer.find('otp', undefined, askedAt)).toEqual({
      payload: { code: 1 },
      publishedAt: at,
    });
  });

  test('an event published before the question is not after it, on any pod', async () => {
    const at = await databaseNow();
    const publisher = busOnAPodSkewedBy(at, 30_000);
    await publisher.publish('otp', { code: 'stale' });
    await pg.age(1_000);

    const consumer = busOnAPodSkewedBy(at, -30_000);
    expect(await consumer.find('otp', undefined, await consumer.now())).toBeUndefined();
    // Still there for a wait that began before it.
    expect((await consumer.find('otp', undefined, at - 1_000))?.payload).toEqual({ code: 'stale' });
  });

  test('expiry is the database clock too: a ttl counts from the stamp, not from the publisher', async () => {
    const at = await databaseNow();
    const publisher = busOnAPodSkewedBy(at, -3_600_000);
    await publisher.publish('otp', { code: 2 }, { ttl: 5_000 });
    // An hour-slow publisher used to write a row that had expired before it was inserted.
    expect((await publisher.find('otp', undefined, 0))?.payload).toEqual({ code: 2 });
    await pg.age(5_000);
    expect(await publisher.find('otp', undefined, 0)).toBeUndefined();
  });
});
